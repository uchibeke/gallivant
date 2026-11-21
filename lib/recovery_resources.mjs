import { accessSync, closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem, loadavg, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, syncDirectory, writeJsonAtomic } from "./fs.mjs";
import { runtimeTemporaryPath } from "./runtime-environment.mjs";

export const RESOURCE_DEFAULTS = Object.freeze({ minimum_free_bytes: 64 * 1024 * 1024, minimum_free_inodes: 128,
  minimum_memory_bytes: 32 * 1024 * 1024, maximum_load_per_cpu: 4, warm_cache_hours: 12, cleanup: "observe", journal_reserve: null });
export const resourceSettings = config => ({ ...RESOURCE_DEFAULTS, ...config?.resource_headroom });
export function resourceProblems(input) {
  if (input === undefined) return [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["resource_headroom must be an object"];
  const number = n => Number.isSafeInteger(n) && n >= 0;
  return Object.entries(input).flatMap(([key, value]) => {
    const valid = key === "cleanup" ? ["observe", "qualified"].includes(value) : key === "journal_reserve" ? value === null ||
      value && Object.keys(value).length === 2 && number(value.device) && number(value.fs_type) :
      Object.hasOwn(RESOURCE_DEFAULTS, key) && number(value);
    return valid ? [] : [`Invalid resource_headroom.${key}`];
  });
}

function volume(path, { statfs, stat, access }, allowMissing) {
  for (let candidate = path, depth = 0; candidate && depth < 64; candidate = dirname(candidate), depth++) {
    try {
      access(candidate, constants.W_OK | constants.X_OK);
      const inode = stat(candidate), capacity = statfs(candidate, { bigint: true });
      if (!inode.isDirectory() || capacity.bsize <= 0n || capacity.ffree < 0n || capacity.files <= 0n) break;
      return { device: inode.dev, type: Number(capacity.type), bytes: Number(capacity.bavail * capacity.bsize), inodes: Number(capacity.ffree) };
    } catch (error) {
      if (!allowMissing || error.code !== "ENOENT" || dirname(candidate) === candidate) break;
    }
  }
  return null;
}

const nativePressure = () => ({ memoryBytes: Math.min(freemem(), process.availableMemory?.() ?? Infinity), loadPerCpu: loadavg()[0] / availableParallelism() });
export function measureResources({ stateDir, worktree, gitDirs = [], scratch = worktree ? runtimeTemporaryPath(worktree) : tmpdir(), planned = false }, settings = RESOURCE_DEFAULTS,
  { statfs = statfsSync, stat = path => lstatSync(realpathSync(path)), access = accessSync, pressure = nativePressure } = {}) {
  const mounts = {};
  for (const [kind, root, missing] of [["state", stateDir, false], ["checkout", worktree, planned], ["scratch", scratch, true],
    ...gitDirs.map((path, i) => [`git-${i + 1}`, path, false])]) {
    if (root) mounts[kind] = volume(root, { statfs, stat, access }, missing);
  }
  const signal = pressure(), blocked = [];
  for (const [kind, mount] of Object.entries(mounts)) {
    if (!mount) blocked.push(`${kind}-unverified`);
    else {
      if (mount.bytes < settings.minimum_free_bytes) blocked.push(`${kind}-bytes`);
      if (mount.inodes < settings.minimum_free_inodes) blocked.push(`${kind}-inodes`);
    }
  }
  if (signal.memoryBytes < settings.minimum_memory_bytes) blocked.push("memory");
  if (settings.maximum_load_per_cpu && signal.loadPerCpu > settings.maximum_load_per_cpu) blocked.push("process-pressure");
  return { mounts, ...signal, blocked };
}

export function requireHeadroom(input, settings, adapters) {
  const result = measureResources(input, settings, adapters);
  if (result.blocked.length) throw Object.assign(new Error(`Dispatch deferred for resource headroom (${result.blocked.join(", ")}). Inspect state, checkout and temporary mounts and retry after capacity returns.`),
    { code: "AUTHOR_STORAGE", resources: result });
  return result;
}

const RESERVE_BYTES = 4 * 1024 * 1024;
const outOfSpace = error => ["ENOSPC", "EDQUOT"].includes(error?.code);

// This reserve belongs to the coordinator's journal volume. The durable
// receipt records its exact identity before pressure. A partial provision can
// leave a file for inspection, but it can never authorize an unlink.
export function makeJournalReserve(home, qualification, { fs = { lstatSync, statfsSync, realpathSync, openSync, closeSync, fsyncSync, unlinkSync, writeFileSync },
  read = readJson, write = writeJsonAtomic, sync = syncDirectory } = {}) {
  const path = join(home, "recovery-journal.reserve"), receipt = join(home, "recovery-journal-reserve.json");
  const durable = value => write(receipt, value, 0o600, { durable: true });
  const qualifiedMount = () => {
    if (!qualification) return null;
    const root = fs.realpathSync(home), stat = fs.lstatSync(root), capacity = fs.statfsSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.dev !== qualification.device || Number(capacity.type) !== qualification.fs_type) return null;
    return { root, dev: stat.dev, ino: stat.ino, fs_type: Number(capacity.type), capacity };
  };
  const exactFile = (mount, saved) => {
    const stat = fs.lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === RESERVE_BYTES && stat.blocks * 512 >= RESERVE_BYTES &&
      (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0 && stat.dev === mount.dev && stat.ino === saved.ino;
  };
  function provision(settings = RESOURCE_DEFAULTS) {
    const mount = qualifiedMount();
    if (!mount || mount.capacity.bavail * mount.capacity.bsize < BigInt(settings.minimum_free_bytes + RESERVE_BYTES) ||
        mount.capacity.ffree <= BigInt(settings.minimum_free_inodes + 2)) return false;
    const prior = read(receipt, null);
    try { fs.lstatSync(path); return false; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (prior && (prior.version !== 1 || prior.dev !== mount.dev || prior.fs_type !== mount.fs_type || prior.root !== mount.root || prior.rootIno !== mount.ino)) return false;
    const fd = fs.openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(fd, randomBytes(RESERVE_BYTES)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const saved = { version: 1, root: mount.root, rootIno: mount.ino, dev: mount.dev, fs_type: mount.fs_type, ino: fs.lstatSync(path).ino };
    if (!exactFile(mount, saved)) return false;
    sync(home);
    durable(saved);
    return true;
  }
  function release(journalPath) {
    const mount = qualifiedMount(), saved = read(receipt, null);
    if (!mount || saved?.version !== 1 || saved.dev !== mount.dev || saved.fs_type !== mount.fs_type || saved.root !== mount.root || saved.rootIno !== mount.ino) return false;
    if (fs.lstatSync(fs.realpathSync(dirname(journalPath))).dev !== mount.dev) return false;
    try {
      if (!exactFile(mount, saved)) return false;
      fs.unlinkSync(path);
    } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    sync(home);
    return true;
  }
  return { provision, record(journalPath, fn) {
    try { return fn(); }
    catch (error) {
      if (!outOfSpace(error) || !release(journalPath)) throw error;
      return fn();
    }
  } };
}
