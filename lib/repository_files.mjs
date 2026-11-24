// Files carried into a session must stay in the repository, including through symlinks.
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

function repositoryPathParts(rel, allowGit = false) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || /[\\\0]/.test(rel) || rel.split("/").includes("..")) {
    throw new Error(`unsafe repository path: ${rel}`);
  }
  const parts = rel.split("/").filter(p => p && p !== ".");
  if (!parts.length || (!allowGit && parts.some(p => p.toLowerCase() === ".git"))) throw new Error(`unsafe repository path: ${rel}`);
  return parts;
}

/** Refuse links at every component. The root itself may use the OS's /tmp or /var alias. */
export function repositoryPath(root, rel, { createParents = false, allowGit = false, allowMissingParents = false, grantAccess } = {}) {
  const parts = repositoryPathParts(rel, allowGit);
  const base = realpathSync(root);
  const target = resolve(base, ...parts);
  const within = relative(base, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error(`${rel} leaves the repository`);
  let path = base;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const parent = i < parts.length - 1;
    let st;
    try { st = lstatSync(path); }
    catch (e) {
      if (e.code !== "ENOENT") throw e;
      if (parent && createParents) mkdirSync(path, { mode: 0o755 });
      else if (parent && !allowMissingParents) throw e;
    }
    if (st?.isSymbolicLink()) throw new Error(`${rel} contains a symlink; use a regular file inside the repository`);
    if (st && (parent ? !st.isDirectory() : !st.isFile())) throw new Error(`${rel} is not a regular repository file`);
    if (parent && createParents && grantAccess) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { grantAccess(fd, path); }
      finally { closeSync(fd); }
    }
  }
  return target;
}

export function readRepositoryText(root, rel) {
  return readFileSync(repositoryPath(root, rel), "utf8");
}

const stats = path => lstatSync(path, { bigint: true });
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameRevision = (a, b) => sameFile(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

export function pinRepositoryRoot(directory, { invalidDirectory = () => new Error("expected an approved directory") } = {}) {
  const root = realpathSync.native(directory);
  const rootStat = stats(root);
  if (!rootStat.isDirectory()) throw invalidDirectory();
  return { root, rootStat };
}

export function readPinnedRepositoryFile({ root, rootStat }, rel, maximum, remaining = maximum) {
  // A transient parent rename or link swap can leave the final filename and
  // inode back where they started. Pin the directory chain around the read.
  const parts = repositoryPathParts(rel);
  const parents = [[root, stats(root)]];
  if (!sameFile(rootStat, parents[0][1])) throw new Error("approved root changed before reading");
  for (const part of parts.slice(0, -1)) {
    const path = join(parents.at(-1)[0], part);
    const parent = stats(path);
    if (!parent.isDirectory()) throw new Error("expected a regular parent directory without symlinks");
    parents.push([path, parent]);
  }
  const path = repositoryPath(root, rel);
  const before = stats(path);
  if (!before.isFile() || before.nlink !== 1n) throw new Error("expected a regular file without hard links");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = fstatSync(fd, { bigint: true });
    const confirmPath = () => {
      const named = repositoryPath(root, rel);
      const canonical = realpathSync.native(named);
      const within = relative(root, canonical);
      if (!within || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)
          || !sameRevision(opened, stats(canonical)) || !sameRevision(opened, stats(named))
          || parents.some(([path, before]) => !sameRevision(before, stats(path)))) {
        throw new Error("file identity or containment changed while reading");
      }
    };
    if (!opened.isFile() || !sameRevision(before, opened)) throw new Error("file changed before it could be read");
    confirmPath();
    if (opened.size > maximum) throw Object.assign(new Error("exceeds the per-source byte limit"), { code: "FILE_TOO_LARGE" });
    if (opened.size > remaining) throw new Error("exceeds the 8 MiB total input limit");
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    if (count !== bytes.length - 1 || !sameRevision(opened, fstatSync(fd, { bigint: true }))) {
      throw new Error("file changed while reading");
    }
    confirmPath();
    return { bytes: bytes.subarray(0, count), identity: `${opened.dev}:${opened.ino}` };
  } finally {
    closeSync(fd);
  }
}

/** Canonical Git-relative spelling using the same containment and link checks. */
export function repositoryRelativePath(root, rel, options) {
  return relative(realpathSync(root), repositoryPath(root, rel, options)).split(sep).join("/");
}

/** Reject portable file/directory aliases without reading repository contents. */
export function assertRepositoryTargets(paths, trackedPaths) {
  const folded = path => path.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
  const known = new Map(), targets = new Set();
  const components = path => {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("invalid tracked repository paths; retrieve complete Git path metadata");
    return path.split("/");
  };
  const add = (path, check) => {
    const parts = components(path);
    let level = known;
    for (const [i, part] of parts.entries()) {
      const key = folded(part), kind = i === parts.length - 1 ? "file" : "directory";
      let node = level.get(key);
      if (check && node && (node.spellings.size !== 1 || !node.spellings.has(part) || node.kinds.size !== 1 || !node.kinds.has(kind))) throw new Error("result file aliases an existing repository path");
      if (!node) { node = { spellings: new Set(), kinds: new Set(), children: new Map() }; level.set(key, node); }
      node.spellings.add(part); node.kinds.add(kind); level = node.children;
    }
  };
  if (!Array.isArray(paths) || !Array.isArray(trackedPaths)) throw new Error("tracked repository paths unavailable; retrieve complete Git path metadata");
  for (const path of trackedPaths) add(path, false);
  for (const path of paths) {
    const target = folded(path);
    if (targets.has(target)) throw new Error("duplicate canonical result file");
    targets.add(target);
    add(path, true);
  }
}

/** Replace the directory entry, never truncate an existing link or hard link's target. */
export function writeRepositoryText(root, rel, text, { mode = null, allowGit = false, grantAccess } = {}) {
  const path = repositoryPath(root, rel, { createParents: true, allowGit, grantAccess });
  if (mode === null) {
    try { mode = lstatSync(path).mode & 0o777; }
    catch (e) { if (e.code !== "ENOENT") throw e; mode = 0o644; }
  }
  const tmp = join(dirname(path), `.gallivant-${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      writeFileSync(fd, text);
      grantAccess?.(fd, tmp);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    repositoryPath(root, rel, { allowGit });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
