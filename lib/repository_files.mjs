// Files carried into a session must stay in the repository, including through symlinks.
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Refuse links at every component. The root itself may use the OS's /tmp or /var alias. */
export function repositoryPath(root, rel, { createParents = false, allowGit = false, allowMissingParents = false } = {}) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || /[\\\0]/.test(rel) || rel.split("/").includes("..")) {
    throw new Error(`unsafe repository path: ${rel}`);
  }
  const parts = rel.split("/").filter(p => p && p !== ".");
  if (!parts.length || (!allowGit && parts.some(p => p.toLowerCase() === ".git"))) throw new Error(`unsafe repository path: ${rel}`);
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
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`${rel} contains a symlink; use a regular file inside the repository`);
    if (parent ? !st.isDirectory() : !st.isFile()) throw new Error(`${rel} is not a regular repository file`);
  }
  return target;
}

export function readRepositoryText(root, rel) {
  return readFileSync(repositoryPath(root, rel), "utf8");
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
export function writeRepositoryText(root, rel, text, { mode = null, allowGit = false } = {}) {
  const path = repositoryPath(root, rel, { createParents: true, allowGit });
  if (mode === null) {
    try { mode = lstatSync(path).mode & 0o777; }
    catch (e) { if (e.code !== "ENOENT") throw e; mode = 0o644; }
  }
  const tmp = join(dirname(path), `.gallivant-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, text, { flag: "wx", mode, flush: true });
    repositoryPath(root, rel, { allowGit });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
