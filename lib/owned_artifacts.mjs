import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { performance } from "node:perf_hooks";

export const cleanupBoundary = reason => Object.assign(new Error(reason), { code: "CLEANUP_BOUNDARY" });
const limits = { bytes: 64 * 1024 ** 3, entries: 150_000, milliseconds: 1000 };

export function directoryIdentity(root, rel) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || /[\\\0]/.test(rel) || rel.split("/").some(p => !p || p === "." || p === "..")) throw cleanupBoundary("unsafe cleanup path");
  try {
    const base = realpathSync(root), rootStat = lstatSync(base);
    if (!rootStat.isDirectory()) throw cleanupBoundary("cleanup root is not a directory");
    let path = base, stat = rootStat;
    for (const part of rel.split("/")) {
      path = join(path, part);
      stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== rootStat.dev) throw cleanupBoundary("cleanup path is not an owned regular directory on the approved volume");
    }
    return { root: base, rootIno: rootStat.ino, path, dev: stat.dev, ino: stat.ino };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

export const ownedDirectory = (root, rel) => directoryIdentity(root, rel)?.path ?? null;
export const sameDirectory = (left, right) => Boolean(left && right && ["root", "rootIno", "path", "dev", "ino"].every(key => left[key] === right[key]));

// Bound inventory before admission. Links are not followed, special files and
// nested filesystems retain the whole candidate. No names leave this proof.
export function inventoryOwnedDirectory(proof, bounds = {}) {
  const budget = { ...limits, ...bounds }, started = performance.now();
  let entries = 0, bytes = 0;
  function scan(path, depth) {
    if (depth > 64) throw cleanupBoundary("owned artifact depth exceeds cleanup limit");
    const dir = opendirSync(path);
    try {
      for (let item; (item = dir.readSync());) {
        if (++entries > budget.entries || performance.now() - started > budget.milliseconds) throw cleanupBoundary("owned artifact inventory exceeds cleanup limit");
        const child = join(path, item.name), stat = lstatSync(child);
        if (stat.dev !== proof.dev || !stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) throw cleanupBoundary("artifact contains a mount or special file");
        if (stat.isFile() && stat.nlink !== 1 && !bounds.allowHardlinks) throw cleanupBoundary("artifact has a shared file link");
        bytes += Math.max(stat.size, stat.blocks * 512);
        if (bytes > budget.bytes) throw cleanupBoundary("owned artifact exceeds cleanup byte limit");
        if (stat.isDirectory()) scan(child, depth + 1);
      }
    } finally { dir.closeSync(); }
  }
  scan(proof.path, 0);
  return { entries, bytes };
}

export async function removeOwnedDirectory(root, rel, { proof, guard, bounds, remove = rm } = {}) {
  const current = directoryIdentity(root, rel);
  if (!current) return;
  if (!sameDirectory(current, proof)) throw cleanupBoundary("cleanup directory identity changed or has no recorded owner");
  inventoryOwnedDirectory(current, bounds);
  guard?.();
  if (!sameDirectory(directoryIdentity(root, rel), proof)) throw cleanupBoundary("cleanup directory changed immediately before removal");
  await remove(current.path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}
