// Files carried into a session must stay in the repository, including through symlinks.
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Refuse links at every component. The root itself may use the OS's /tmp or /var alias. */
export function repositoryPath(root, rel, { createParents = false, allowGit = false } = {}) {
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
      else if (parent) throw e;
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
