// Identity and read-only proofs for the coordinator's base repair operation.
// Host PR observations remain in adapters; no provider or host dispatch lives here.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { hosts } from "./hosts.mjs";
import { capabilitiesFor, isSessionFor } from "./harness.mjs";
import { assertRepositoryAccess } from "./host_contract.mjs";
import { assertBranchName, remoteMatches } from "./repository.mjs";
import { briefDivergence, divergenceReason } from "./prd.mjs";

export const repairError = (message, code = "base-repair-prerequisite") => Object.assign(new Error(message), { code });
export const repairKey = (head, baseSha) => `${head}:${baseSha}`;
export const repairOperation = (id, head, baseSha) => `base-repair:${createHash("sha256").update(JSON.stringify([id, head, baseSha])).digest("hex")}`;
const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "");

export function assertRepairIdentity(id, entry, op) {
  if (op?.version !== 1 || !sha(op.head) || !sha(op.baseSha) || op.key !== repairKey(op.head, op.baseSha) ||
      op.operationId !== repairOperation(id, op.head, op.baseSha) ||
      ["repo", "branch", "base", "worktree", "session", "harness"].some(key => !op[key] || op[key] !== entry[key]) ||
      op.taskId !== id || !Number.isSafeInteger(op.round) || op.round < 1) {
    throw repairError("Base repair ownership differs from the saved repository, branch, base, session or operation. Restore the matching state and execution ledger; the worktree was preserved.", "base-repair-ownership");
  }
}

export function repairRunMatches(id, entry, run) {
  const op = entry.base_repair;
  assertRepairIdentity(id, entry, op);
  const ex = run?.execution;
  return !!run && (!op.run || op.run === run.id) && ex?.operationId === op.operationId &&
    ex.taskId === id && ex.provider === op.harness && ex.sessionId === op.session &&
    ex.inputHead === (op.mergeSha || op.head) && ex.acceptance === "accepted" && !ex.quarantined;
}

export function repairOverlays(ctx, id, entry, { required = true } = {}) {
  return [...new Set([entry.prd, ...(entry.sources || [])].filter(Boolean))].map(path => {
    const text = path === entry.prd ? ctx.readPrd(id) : ctx.readSource?.(id, path);
    if (typeof text !== "string") {
      if (!required) return null;
      throw repairError(`Approved input snapshot missing: ${path}. Restore it before repairing the base.`, "base-repair-inputs");
    }
    return { path, text };
  }).filter(Boolean);
}

export function assertRepairInputs(ctx, id, entry) {
  if (!entry.prd || !ctx.readPrd(id) || entry.brief_changes?.length) throw repairError("Base repair requires the saved approved brief and settled source copies. Reconcile the existing snapshot approval before retrying.", "base-repair-inputs");
  const divergence = briefDivergence({ id, entry, readPrd: ctx.readPrd, readSource: ctx.readSource });
  if (divergenceReason(divergence) || divergence.verdict === "unknown") throw repairError(`${divergence.why}. Restore approved inputs or explicitly approve them through resume --resnapshot; automatic repair cannot resnapshot.`, "base-repair-inputs");
}

export async function assertRepairCheckout(ctx, id, entry, { clean = true } = {}) {
  const { git, config } = ctx;
  if (!["exists", "toplevel", "currentBranch", "originOf", "head", "mergeState", "assertClean", "containsCommit", "fetchBranchHead"].every(key => typeof git[key] === "function")) throw repairError("Git repair proof is unavailable; use an execution runtime with checkout identity, clean-input and remote ancestry checks.");
  if (!entry.worktree || !git.exists(entry.worktree)) throw repairError("Owned task checkout is missing. Restore its original checkout and execution ledger before repair; no checkout was recreated.");
  const root = realpathSync(config.worktrees), path = realpathSync(entry.worktree);
  const within = relative(root, path);
  if (!within || within.startsWith("..") || isAbsolute(within) || realpathSync(await git.toplevel(entry.worktree)) !== path ||
      entry.checkout && realpathSync(entry.checkout) === path) throw repairError("Conflict is outside the authorized isolated task checkout. Restore its saved worktree; no files were changed.", "base-repair-ownership");
  if (await git.currentBranch(entry.worktree) !== entry.branch || !remoteMatches(await git.originOf(entry.worktree), entry.repo)) throw repairError("Task checkout repository or branch changed. Restore the recorded identity; the index and files were preserved.", "base-repair-ownership");
  const pending = await git.mergeState(entry.worktree);
  if (clean) {
    if (pending.head || pending.unmerged || pending.other.length) throw repairError(`Unresolved Git operation in ${entry.worktree}. Finish the owned merge, verify, commit and push only ${entry.branch}, then resume. The index and files were preserved.`, "base-repair-unresolved");
    try { await git.assertClean(entry.worktree, repairOverlays(ctx, id, entry)); }
    catch (error) {
      if (typeof error.code === "number" || error.killed || ["ETIMEDOUT", "EIO", "EAGAIN"].includes(error.code)) throw error;
      throw repairError(`Uncommitted or changed input files in ${entry.worktree}: ${error.message}. Preserve unrelated edits and reconcile them explicitly before resume; nothing was aborted, reset or staged.`, "base-repair-dirty");
    }
  }
  return { head: await git.head(entry.worktree), pending };
}

export async function assertRepairPrerequisites(ctx, id, entry, pr) {
  const selected = (ctx.hosts ?? hosts).select(entry), capabilities = capabilitiesFor(entry.harness);
  assertRepositoryAccess(capabilities, selected.repository);
  if (!entry.base || !entry.branch || entry.branch === entry.base) throw repairError("Saved task branch and base identity are required; confirm the PR target and restore the recorded base before repair.");
  assertBranchName(entry.base); assertBranchName(entry.branch);
  if (pr && (pr.state !== "OPEN" || pr.isCrossRepository !== false || pr.headRefName !== entry.branch || pr.baseRefName !== entry.base)) throw repairError("Observed PR branch/base differs from the approved task; reconcile its identity before repair.", "base-repair-ownership");
  if (!isSessionFor(entry.harness, entry.session)) throw repairError("No recoverable task session. Restore the recorded provider session before repair; a fresh session is not authorized.");
  if (capabilities.repositoryAccess?.mode !== "local-worktree" || capabilities.continuation !== "native-session") throw repairError("This provider cannot merge inside the owned local checkout in the same session; automatic repair requires qualified local-worktree continuation.");
  assertRepairInputs(ctx, id, entry);
  return assertRepairCheckout(ctx, id, entry);
}

export async function proveRepairPush(ctx, id, entry, pr) {
  const op = entry.base_repair;
  assertRepairIdentity(id, entry, op);
  const { head } = await assertRepairPrerequisites(ctx, id, entry, pr);
  if (head === op.head || !await ctx.git.containsCommit(entry.worktree, op.head, head) || !await ctx.git.containsCommit(entry.worktree, op.baseSha, head)) throw repairError("Repair did not produce a descendant of both the task head and pinned base. Preserve the checkout, finish the intended merge and verification, then push the task branch.", "base-repair-no-merge");
  const remote = await ctx.git.fetchBranchHead(entry.worktree, entry.branch);
  if (remote !== pr.headRefOid || !await ctx.git.containsCommit(entry.worktree, head, remote) || !await ctx.git.containsCommit(entry.worktree, op.baseSha, remote)) throw repairError(`Repair push is unproved: local ${head}, remote ${remote}, observed PR ${pr.headRefOid}. Push only ${entry.branch} and resume after host evidence catches up; local work was preserved.`, "base-repair-push");
  return { repairSha: head, remoteSha: remote };
}
