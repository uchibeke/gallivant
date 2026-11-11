// Only disposable, coordinator-owned directories are eligible. Durable task,
// review and execution evidence stays in the registry and private run archives.
import { lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, basename, join, relative, resolve, sep, isAbsolute } from "node:path";
import { worktreePath } from "./git.mjs";
import { prdIdOf } from "./state.mjs";
import { remoteMatches } from "./repository.mjs";
import { controlPending } from "./control_contract.mjs";
import { executionLive } from "./execution_contract.mjs";
import { removeRuntimeTemporaryAlias } from "./runtime-environment.mjs";

const within = (parent, child) => { const rel = relative(parent, child); return !rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function canonicalInput(input) {
  try { return realpathSync(input); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(input);
    return parent === input ? resolve(input) : join(canonicalInput(parent), basename(input));
  }
}

/** /tmp and /var OS aliases are allowed at the root; no child link is followed. */
export function ownedDirectory(root, rel) {
  if (typeof rel !== "string" || !rel || isAbsolute(rel) || /[\\\0]/.test(rel) || rel.split("/").some(p => !p || p === "." || p === "..")) throw new Error("unsafe cleanup path");
  let base;
  try { base = realpathSync(root); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  let path = base;
  for (const part of rel.split("/")) {
    path = join(path, part);
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("cleanup path is not an owned regular directory"), { code: "CLEANUP_BOUNDARY" });
  }
  return path;
}

export async function removeOwnedDirectory(root, rel) {
  const path = ownedDirectory(root, rel);
  if (path) await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
}

function protectedInput(ctx, id, path) {
  const paths = [];
  const collect = value => {
    if (typeof value === "string" && isAbsolute(value)) paths.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  for (const [otherId, entry] of ctx.state.entries()) {
    collect(entry.checkout);
    if (otherId !== id) collect(entry.worktree);
  }
  for (const [, chain] of ctx.state.chains?.() || []) collect(chain);
  return paths.some(input => {
    return within(path, canonicalInput(input));
  });
}

/** Called under the existing per-task decision lock, after host identity checks. */
export async function cleanupMergedWorkspace(ctx, id, entry, pr) {
  if (pr.state !== "MERGED") return { status: "retained", reason: "PR closed without merging" };
  if (!pr.headRefOid || controlPending(entry.control)) return { status: "pending", reason: "task control or merge identity is unresolved" };
  const record = { version: 1, state: "MERGED", head: pr.headRefOid, pr: entry.pr };
  let removal = entry.workspace_cleanup?.removal;
  let removalAuthorized = false;
  try {
    const run = (ctx.executionFor ? ctx.executionFor(id, entry.harness) : ctx.runnerFor(id)).current();
    if (run?.running || executionLive(run) || run && run.exit == null || !run && (executionLive(entry) || entry.last?.run)) {
      return { ...record, status: "pending", reason: "author execution has not settled" };
    }
    const expected = worktreePath(ctx.config, entry.repo, prdIdOf(id));
    if (!entry.worktree || resolve(entry.worktree) !== resolve(expected)) return { ...record, status: "retained", reason: "checkout is not the canonical task clone" };
    const rel = relative(resolve(ctx.config.worktrees), resolve(expected)).split(sep).join("/");
    const path = ownedDirectory(ctx.config.worktrees, rel);
    if (path) {
      if (protectedInput(ctx, id, path)) return { ...record, status: "retained", reason: "checkout is still a task or chain input" };
      const stat = lstatSync(path);
      const authorized = entry.workspace_cleanup?.head === pr.headRefOid && entry.workspace_cleanup?.pr === entry.pr &&
        removal?.path === path && removal.dev === stat.dev && removal.ino === stat.ino;
      removalAuthorized = Boolean(authorized);
      if (!authorized) {
        removal = null;
        const metadata = lstatSync(join(path, ".git"));
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { ...record, status: "retained", reason: "checkout is not an isolated clone" };
        if (!remoteMatches(await ctx.git.originOf(path), entry.repo)) return { ...record, status: "retained", reason: "checkout origin changed" };
        const proof = await ctx.git.cleanupProof(path);
        if (proof.head !== pr.headRefOid || proof.branch !== entry.branch || proof.dirty || proof.unpublished || proof.stash || proof.busy) {
          return { ...record, status: "retained", reason: "checkout contains local work or no longer matches the merged head" };
        }
        removal = { path, dev: stat.dev, ino: stat.ino };
      }
    }
    // Reviewer cleanup refuses live or ambiguously cancelled jobs. Keep its
    // evidence/ledger files, deleting only the isolated preparation directories.
    const review = await ctx.reviewService?.cleanup?.(id);
    if (review?.status === "pending") return { ...record, ...(removalAuthorized ? { removal } : {}), status: "pending", reason: review.reason };
    // Persist exact directory ownership before recursive deletion. A crash can
    // remove .git first; retry that same inode without guessing it was clean.
    if (path) {
      ctx.state.update(id, { workspace_cleanup: { ...record, status: "pending", removal } });
      removalAuthorized = true;
    }
    removeRuntimeTemporaryAlias(path || removal?.path || expected);
    await removeOwnedDirectory(ctx.config.worktrees, rel);
    return { ...record, status: "done" };
  } catch (error) {
    return { ...record, ...(removalAuthorized ? { removal } : {}), status: error.code === "CLEANUP_BOUNDARY" ? "retained" : "pending", reason: `workspace cleanup failed (${error.code || error.message})` };
  }
}
