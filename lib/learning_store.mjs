import { join, dirname, resolve, isAbsolute } from "node:path";
import { existsSync, lstatSync, realpathSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, fsyncSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { acquireProcessLock } from "./daemon.mjs";
import { canonical, hash, parseJson, learningError, repository, closed } from "./learning_data.mjs";

export const inside = (path, root) => path === root || path.startsWith(root + "/");
export function safePath(path, { file = false, privateMode = false } = {}) {
  if (typeof path !== "string" || Buffer.byteLength(path) > 4096 || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw learningError("PATH", "learning path contains terminal controls or exceeds its bound");
  if (!isAbsolute(path) || resolve(path) !== path) throw learningError("PATH", "path must be explicit, absolute and normalized");
  // Resolve system /tmp aliases at the caller, never silently follow a user-controlled link.
  let current = path;
  while (current !== dirname(current)) {
    if (existsSync(current) || (() => { try { lstatSync(current); return true; } catch { return false; } })()) {
      const s = lstatSync(current);
      if (s.isSymbolicLink()) throw learningError("PATH", "symlink in learning path");
      if (current === path && (file ? !s.isFile() : !s.isDirectory())) throw learningError("PATH", "wrong learning path type");
      if (current === path && privateMode && ((s.mode & 0o077) || s.uid !== process.getuid?.())) throw learningError("PATH", "learning path must be operator-owned and private");
    }
    current = dirname(current);
  }
  return path;
}
export function durableWrite(file, value) {
  safePath(dirname(file)); safePath(file, { file: true });
  const bytes = canonical(value) + "\n";
  if (Buffer.byteLength(bytes) > 32 * 1024 * 1024) throw learningError("STORAGE", "learning state exceeds its 32 MiB cap; preserve current state and review retention before retrying");
  const tmp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(tmp, file); const dir = openSync(dirname(file), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  catch (e) { if (fd !== undefined) closeSync(fd); throw e; }
  finally { rmSync(tmp, { force: true }); }
}
export function learningStore(root) {
  safePath(root);
  const loadFile = file => { safePath(file, { file: true, privateMode: true }); return parseJson(readFileSync(file), 32 * 1024 * 1024); };
  const init = () => { safePath(root); mkdirSync(root, { recursive: true, mode: 0o700 }); safePath(root, { privateMode: true }); };
  const repoPath = repo => { repository(repo); return join(root, `repo-${hash(repo)}.json`); };
  const empty = repo => ({ version: 1, repo, mode: "off", observations: {}, candidates: {}, scans: [], backoffUntil: null, extraction: [], deliveries: {}, sequence: 0, parent: null, active: [], transitions: {}, prepared: {}, checkpoint: null });
  const load = repo => {
    const path = repoPath(repo);
    if (!existsSync(path)) return empty(repo);
    const state = loadFile(path);
    closed(state, Object.keys(empty(repo)), "repository state");
    if (state.version !== 1 || canonical(state.repo) !== canonical(repo)) throw learningError("STATE", "repository state identity/schema mismatch");
    if (!["off", "collect", "apply"].includes(state.mode)) throw learningError("STATE", "invalid protected learning mode");
    return state;
  };
  const lock = () => {
    init();
    const path = join(root, "operation.lock");
    safePath(path, { file: true, privateMode: true });
    return acquireProcessLock(path, "learning operation").release;
  };
  return {
    root, load, init, lock,
    identities() { const p = join(root, "repositories.json"); return existsSync(p) ? loadFile(p) : {}; },
    remember(name, repo, visibility) {
      repository(repo);
      if (visibility !== undefined && !["public", "private", "internal", "unknown"].includes(visibility)) throw learningError("INPUT", "invalid repository visibility");
      const release = lock();
      try { const known = this.identities(); known[name.toLowerCase()] = visibility === undefined ? repo : { repo, visibility }; durableWrite(join(root, "repositories.json"), known); }
      finally { release(); }
    },
    readAuthority() { const p = join(root, "authority.json"); return existsSync(p) ? loadFile(p) : null; },
    writeAuthority(value) { init(); durableWrite(join(root, "authority.json"), value); },
    async transaction(repo, fn) {
      const release = lock();
      try { const state = load(repo), result = await fn(state); durableWrite(repoPath(repo), state); return result; } finally { release(); }
    },
    saveLocked(repo, state) { durableWrite(repoPath(repo), state); },
    canonicalRoot() { return existsSync(root) ? realpathSync(root) : root; },
  };
}
