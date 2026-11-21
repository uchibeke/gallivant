// Approved private input copies may differ from tracked Git blobs. Keep those
// bytes out of a coordinator merge without staging or publishing the copies.
import { join } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { repositoryPath, writeRepositoryText } from "./repository_files.mjs";

const error = message => Object.assign(new Error(message), { code: "base-repair-overlay" });
const bytesAt = (dir, path) => {
  try { return readFileSync(repositoryPath(dir, path, { allowMissingParents: true })); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
};
const equal = (a, b) => a === null || b === null ? a === b : a.equals(b);
export const overlayBackupPath = gitDir => join(gitDir, "gallivant-merge-overlays");

export function assertNoOverlayRecovery(gitDir) {
  if (existsSync(overlayBackupPath(gitDir))) throw error(`An interrupted approved-input merge needs recovery. Preserve the checkout and private backup at ${overlayBackupPath(gitDir)}; no new merge was started.`);
}

export async function withMergeOverlays({ dir, gitDir, overlays, head, branch, readHead, readBranch, readIndex, readCommitted, assertClean, mergeState }, merge) {
  assertNoOverlayRecovery(gitDir);
  if (!overlays.length) return merge();
  await assertClean(overlays);
  const index = await readIndex();
  const candidates = [];
  for (const item of overlays) {
    if (item.publishedOutput === true) continue;
    const committed = await readCommitted(head, item.path);
    if (committed === null) continue; // Untracked private inputs are never removed.
    const original = bytesAt(dir, item.path), approved = Buffer.from(item.text);
    if (!equal(original, approved)) throw error(`Approved input changed before merging: ${item.path}. Preserve the checkout.`);
    const clean = Buffer.from(committed);
    if (!original.equals(clean)) candidates.push({ path: item.path, original, clean, mode: lstatSync(repositoryPath(dir, item.path)).mode & 0o777 });
  }
  if (!candidates.length) return merge();
  const unchanged = async () => {
    if (await readHead() !== head || await readBranch() !== branch || await readIndex() !== index) throw error("Checkout head, branch or index changed before approved-input merge; preserve the checkout.");
  };
  await unchanged();
  const backup = overlayBackupPath(gitDir);
  mkdirSync(backup, { mode: 0o700 }); // Exclusive transaction marker also fences crash recovery.
  try {
    for (const [i, item] of candidates.entries()) writeFileSync(join(backup, `${i}.bin`), item.original, { flag: "wx", mode: 0o600, flush: true });
    writeFileSync(join(backup, "manifest.json"), JSON.stringify({ version: 1, head, branch,
      files: candidates.map(({ path, mode }, i) => ({ path, mode, backup: `${i}.bin` })) }, null, 2), { flag: "wx", mode: 0o600, flush: true });
  } catch (e) { throw error(`Approved-input backup failed: ${e.message}. Preserve ${backup}; no merge was started.`); }
  let result, failure;
  const hydrated = [];
  try {
    for (const item of candidates) {
      await unchanged();
      if (!equal(bytesAt(dir, item.path), item.original)) throw error(`Approved input changed during merge preparation: ${item.path}`);
      writeRepositoryText(dir, item.path, item.clean, { mode: item.mode });
      hydrated.push(item);
    }
    await assertClean(overlays.map(item => {
      const prepared = candidates.find(candidate => candidate.path === item.path);
      return prepared ? { ...item, text: prepared.clean.toString("utf8") } : item;
    }));
    await unchanged();
    result = await merge();
  } catch (e) { failure = e; }
  try {
    const pending = await mergeState();
    if (pending.head || pending.unmerged || pending.other.length) throw error("An unresolved Git operation prevents restoring approved inputs automatically");
    const expectedHead = result?.merged ? result.sha : head;
    if (await readHead() !== expectedHead || await readBranch() !== branch) throw error("Checkout ownership changed while merging approved inputs");
    // The successful commit or completed abort must leave the index at HEAD.
    // Other private untracked inputs still retain their approved contents.
    const cleanOverlays = [];
    for (const item of overlays) {
      const committed = hydrated.some(candidate => candidate.path === item.path) ? await readCommitted(expectedHead, item.path) : null;
      cleanOverlays.push(committed === null ? item : { ...item, text: committed });
    }
    await assertClean(cleanOverlays);
    for (const item of hydrated) {
      const committed = await readCommitted(expectedHead, item.path);
      if (!equal(bytesAt(dir, item.path), committed === null ? null : Buffer.from(committed))) throw error(`Unowned changes prevent restoring approved input: ${item.path}`);
      writeRepositoryText(dir, item.path, item.original, { mode: item.mode });
    }
    await assertClean(overlays);
    rmSync(backup, { recursive: true });
  } catch (restore) {
    throw error(`${failure ? `${failure.message}; ` : ""}${restore.message}. Approved bytes remain in private backup ${backup}; preserve the checkout and restore only after its owner is reconciled.`);
  }
  if (failure) throw failure;
  return result?.conflict ? { ...result, overlayConflict: true, overlayPaths: candidates.map(item => item.path) } : result;
}
