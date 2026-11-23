// Only disposable, coordinator-owned directories are eligible. Durable task,
// review and execution evidence stays in the registry and private run archives.
import { lstatSync, realpathSync } from "node:fs";
import { dirname, basename, join, relative, resolve, sep, isAbsolute } from "node:path";
import { worktreePath } from "./git.mjs";
import { prdIdOf } from "./state.mjs";
import { remoteMatches } from "./repository.mjs";
import { controlPending } from "./control_contract.mjs";
import { authorSettled, executionLive } from "./execution_contract.mjs";
import { recoveryHeld } from "./recovery_recipes.mjs";
import { retireRuntimeTemporary, runtimeTemporaryPath, runtimeTemporaryProof } from "./runtime-environment.mjs";
import { cleanupBoundary, directoryIdentity, inventoryOwnedDirectory, removeOwnedDirectory, sameDirectory } from "./owned_artifacts.mjs";
import { planRecovery } from "./recovery_recipes.mjs";
import { executionRunner } from "./execution.mjs";
import { resourceSettings } from "./recovery_resources.mjs";
import { hostApi } from "./hosts.mjs";
import { terminalIdentityProblem } from "./host_contract.mjs";
import { validateRecoveryProfile } from "./recovery_authority.mjs";
export { ownedDirectory, removeOwnedDirectory } from "./owned_artifacts.mjs";
import { unresolvedWorkspaceRepair } from "./workspace_recovery.mjs";
import { settledCancellation } from "./task_completion.mjs";

const within = (parent, child) => { const rel = relative(parent, child); return !rel || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
function canonicalInput(input) {
  try { return realpathSync(input); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const parent = dirname(input);
    return parent === input ? resolve(input) : join(canonicalInput(parent), basename(input));
  }
}

export function protectedInput(ctx, id, path, { protectState = true } = {}) {
  const paths = [...(protectState ? [ctx.home, ctx.state.file] : [ctx.state.file]), ...(ctx.state.planCheckoutReferences?.() ?? [])];
  for (const [otherId, entry] of ctx.state.entries()) {
    if (unresolvedWorkspaceRepair(entry)) paths.push(entry.base_repair.worktree);
    if (entry.state === "done" && !executionLive(entry) && !controlPending(entry.control) || settledCancellation(entry)) continue;
    paths.push(entry.checkout);
    if (otherId !== id) paths.push(entry.worktree);
  }
  for (const [, chain] of ctx.state.chains?.() ?? []) {
    if (["done", "cancelled"].includes(chain.status)) continue;
    for (const step of chain.steps.slice(chain.index)) paths.push(step.checkout, step.path);
  }
  return paths.filter(input => typeof input === "string" && isAbsolute(input)).some(input => {
    const target = canonicalInput(input);
    return within(path, target) || within(target, path);
  });
}

/** Called under the existing per-task decision lock, after host identity checks. */
export async function cleanupMergedWorkspace(ctx, id, entry, pr) {
  if (pr.state !== "MERGED") return { status: "retained", reason: "PR closed without merging" };
  if (!pr.headRefOid || controlPending(entry.control)) return { status: "pending", reason: "task control or merge identity is unresolved" };
  const record = { version: 1, state: "MERGED", head: pr.headRefOid, pr: entry.pr };
  if (unresolvedWorkspaceRepair(entry)) return { ...record, status: "retained", code: "git-journal", reason: "unresolved Git recovery journal protects this workspace and its private backups",
    retry_at: (ctx.clock || Date).now() + 6 * 3_600_000 };
  const fenced = () => {
    const current = ctx.state.get ? ctx.state.get(id) : ctx.state.entries().find(([key]) => key === id)?.[1];
    return !current || unresolvedWorkspaceRepair(current) || current.last?.run !== entry.last?.run || current.branch !== entry.branch ||
      current.pr !== entry.pr || current.worktree !== entry.worktree ||
      recoveryHeld(ctx.state.load?.() ?? {}, id, current.dispatch_stopped === "pr-merged" ? { ...current, dispatch_stopped: null } : current);
  };
  let removal = entry.workspace_cleanup?.removal;
  let removalDurable = false;
  const retain = (code, reason, retryable = false) => ({ ...record, status: "retained", code, reason,
    ...(retryable ? { retry_at: (ctx.clock || Date).now() + 6 * 3_600_000 } : {}) });
  const runner = (ctx.executionFor ? ctx.executionFor(id, entry.harness) : ctx.runnerFor(id));
  const settled = () => {
    const run = runner.current();
    return authorSettled(entry, run, runner);
  };
  try {
    if (!settled()) return { ...record, status: "pending", reason: "author execution has not settled" };
    if (fenced()) {
      const review = await ctx.reviewService?.cleanup?.(id, { settleOnly: true });
      if (removal || review?.status === "pending") return { ...record, ...(removal ? { removal } : {}), status: "pending",
        reason: review?.reason ?? "recovery control retains the recorded cleanup intent" };
      return retain("recovery-held", "recovery control retains the settled workspace");
    }
    const root = ctx.config.worktrees, expected = worktreePath(ctx.config, entry.repo, prdIdOf(id));
    if (!entry.worktree || resolve(entry.worktree) !== resolve(expected)) return retain("noncanonical-worktree", "checkout is not the canonical task clone");
    const rel = relative(resolve(root), resolve(expected)).split(sep).join("/");
    const current = directoryIdentity(root, rel);
    const path = current?.path ?? removal?.path ?? expected;
    const guard = () => {
      ctx.assertCoordinatorOwner?.();
      ctx.guardWorkspaceMutation?.();
      if (fenced() || !settled() || protectedInput(ctx, id, path)) throw cleanupBoundary("task owner, references or control changed");
      if (removalDurable && ctx.state.get && !sameRemoval(ctx.state.get(id)?.workspace_cleanup?.removal, removal)) throw cleanupBoundary("saved deletion intent changed");
    };
    const checkGit = async () => {
      const metadata = lstatSync(join(path, ".git"));
      if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== current.dev) return retain("noncanonical-worktree", "checkout is not an isolated clone");
      if (!remoteMatches(await ctx.git.originOf(path), entry.repo)) return retain("origin-changed", "checkout origin changed", true);
      const proof = await ctx.git.cleanupProof(path);
      if (proof.head !== pr.headRefOid || proof.branch !== entry.branch || proof.dirty || proof.unpublished || proof.stash || proof.busy) {
        const code = proof.dirty ? "local-work" : proof.unpublished ? "unpublished-commits" : proof.stash ? "stash-present" : proof.busy ? "git-operation-active"
          : proof.branch !== entry.branch ? "branch-mismatch" : "head-mismatch";
        return retain(code, "checkout contains local work or no longer matches the merged head", true);
      }
      return null;
    };
    if (protectedInput(ctx, id, path)) return retain("shared-input", "checkout is still a task or chain input", true);
    if (removal && (entry.workspace_cleanup.head !== pr.headRefOid || entry.workspace_cleanup.pr !== entry.pr ||
        current && !(removal.root ? sameDirectory(removal, current) : ["path", "dev", "ino"].every(k => removal[k] === current[k]))))
      return retain("ownership-changed", "saved cleanup identity changed");
    if (current && !removal) {
      const problem = await checkGit();
      if (problem) return problem;
    }
    if (fenced()) return { ...record, status: "pending", reason: "task ownership or control changed" };
    const review = await ctx.reviewService?.cleanup?.(id, { guardMutation: guard });
    if (review?.status === "pending") return { ...record, ...(removal ? { removal } : {}), status: "pending", reason: review.reason };
    guard();
    if (!removal || !removal.root) {
      if (current && !removal) {
        const problem = await checkGit();
        if (problem) return problem;
      }
      const temporary = runtimeTemporaryProof(path);
      if (ctx.requireSeparateScratchProof && (temporary.scratch || temporary.alias)) return retain("settled-scratch", "separate scratch cleanup proof is required", true);
      if (temporary.scratch) {
        if (protectedInput(ctx, id, temporary.scratch.path)) return retain("shared-input", "temporary directory is still an input", true);
        inventoryOwnedDirectory(temporary.scratch);
      }
      if (current) inventoryOwnedDirectory(current, ctx.cleanupBounds);
      removal = { ...(current ?? { path }), temporary };
    }
    // Re-fsync even after rename succeeded but the preceding directory sync
    // failed. Permission to remove an inode comes only from a durable record.
    guard();
    if (current && !sameDirectory(directoryIdentity(root, rel), current)) return retain("ownership-changed", "saved cleanup identity changed");
    const persist = () => {
      if (removal.root && ctx.state.resyncCleanup?.(id, removal)) return;
      ctx.state.update(id, { workspace_cleanup: { ...record, status: "pending", removal } }, { durable: true, resync: true });
    };
    if (ctx.journalReserve) ctx.journalReserve.record(ctx.state.file, persist);
    else persist();
    removalDurable = true;
    await retireRuntimeTemporary(path, removal.temporary, guard);
    if (current) await removeOwnedDirectory(root, rel, { proof: current, guard, bounds: ctx.cleanupBounds, remove: ctx.removeWorkspaceDirectory });
    return { ...record, status: "done" };
  } catch (error) {
    if (error.code === "CLEANUP_BOUNDARY") return retain("path-boundary", "workspace cleanup proof unavailable (CLEANUP_BOUNDARY)");
    return { ...record, ...(removalDurable || entry.workspace_cleanup?.removal ? { removal } : {}),
      ...(["ENOSPC", "EDQUOT"].includes(error.code) ? { resourceCode: error.code } : {}), status: "pending", reason: `workspace cleanup failed (${error.code || "io-error"})` };
  }
}

const RETRY_MS = 6 * 3_600_000;
const CACHE_PATH = ".cache/gallivant/npm";
const sameRemoval = (left, right) => Boolean(left && right && left.path === right.path && left.dev === right.dev && left.ino === right.ino &&
  (sameDirectory(left, right) || !left.root && !right.root));

/** Pressure adds no cleanup authority. The coordinator must supply the
 * qualified profile/route, exact last writer, and a durable deletion intent. */
export async function maintainWorkspace(ctx, id, entry) {
  const clock = ctx.clock || Date, time = clock.now(), settings = resourceSettings(ctx.config);
  const runtime = entry.runtime_cleanup, cleanup = entry.workspace_cleanup;
  const runtimeDue = runtime?.next_at > 0 && runtime.next_at <= time;
  const retainedDue = cleanup?.status === "retained" && cleanup.retry_at > 0 && cleanup.retry_at <= time;
  if (!runtimeDue && !retainedDue) return;
  const update = (field, value) => ctx.state.update(id, { [field]: value }, { durable: true, resync: true });
  const retry = (code, delay = RETRY_MS) => {
    if (runtimeDue) update("runtime_cleanup", { ...runtime, code, next_at: time + delay });
    else update("workspace_cleanup", { ...cleanup, maintenance_code: code, retry_at: time + delay });
  };
  if (settings.cleanup !== "qualified" || !entry.recovery_profile || !ctx.recoveryQualificationFor) {
    retry("observation-only"); return;
  }
  const record = (fn) => ctx.journalReserve ? ctx.journalReserve.record(ctx.state.file, fn) : fn();
  try {
    const runner = executionRunner(ctx, id), run = runner.current(), runId = run?.id;
    const registry = ctx.state.load(), profile = validateRecoveryProfile(registry.recovery?.profiles?.find(p => p.digest === entry.recovery_profile.digest));
    const checkOwner = () => {
      ctx.assertCoordinatorOwner?.();
      const current = ctx.state.get(id), observed = runner.current();
      if (current?.worktree !== entry.worktree || current.last?.run !== runId || current.last.exit == null ||
          observed?.id !== runId || observed.running || executionLive(observed) || observed.exit == null || unresolvedWorkspaceRepair(current) ||
          recoveryHeld(ctx.state.load(), id, current) || observed.execution?.transport !== "remote" && !runner.cleanupSettled?.(runId))
        throw cleanupBoundary("settled artifact owner is unverified");
    };
    checkOwner();
    const artifacts = runtimeDue ? runner.resources?.(runId) : null;
    if (runtimeDue && (artifacts?.version !== 1 || artifacts.run !== runId || runtime.run !== runId)) {
      update("runtime_cleanup", { run: runId, code: "ownership-unverified", next_at: null }); return;
    }
    const stage = runtimeDue ? runtime.stage || "scratch" : "checkout";
    const artifact = stage === "scratch" ? runtimeTemporaryPath(entry.worktree) : null;
    const root = stage === "scratch" ? dirname(artifact) : stage === "cache" ? entry.worktree : ctx.config.worktrees;
    const rel = stage === "scratch" ? basename(artifact) : stage === "cache" ? CACHE_PATH : relative(root, worktreePath(ctx.config, entry.repo, prdIdOf(id))).split(sep).join("/");
    const current = directoryIdentity(root, rel);
    const proof = stage === "checkout" ? cleanup.removal ?? current : artifacts[stage];
    const complete = (code, bytes = 0) => {
      if (runtimeDue) record(() => update("runtime_cleanup", stage === "scratch" && artifacts.cache ?
        { run: runId, stage: "cache", next_at: time + settings.warm_cache_hours * 3_600_000, code, bytes } :
        { run: runId, stage, next_at: null, code, bytes }));
    };
    if (!current && !(runtimeDue ? runtime.intent : cleanup.removal?.root)) { complete("absent"); if (!runtimeDue) retry("checkout-unavailable"); return; }
    const policy = profile.cleanup.find(scope => scope.root === proof?.root && scope.classes.includes(stage === "checkout" ? "settled-checkout" : "settled-scratch"));
    if (!proof || current && !sameDirectory(current, proof) || !policy || !Number.isFinite(run.endedAt)) throw cleanupBoundary("artifact exceeds its admitted ownership scope");
    if (protectedInput(ctx, id, proof.path)) throw cleanupBoundary("artifact is still a task or chain input");
    const earliest = run.endedAt + policy.retentionSeconds * 1000;
    if (earliest > time) { retry("retention", earliest - time); return; }
    const bounds = { bytes: policy.maxBytes };
    const bytes = current ? inventoryOwnedDirectory(current, bounds).bytes : runtime?.intent?.bytes || 0;
    if (stage === "cache" && current) {
      const inputs = [entry.prd, ...(entry.sources || [])].filter(Boolean);
      if (inputs.some(path => within(proof.path, canonicalInput(join(entry.worktree, path)))) ||
          (await ctx.git.cleanupProof(entry.worktree, { artifact: CACHE_PATH }))?.tracked !== false)
        throw cleanupBoundary("cache contains tracked or approved inputs");
    }
    const plan = record(() => planRecovery(ctx, id, "workspace-cleanup", { cause: ["owned-artifact", stage],
      input: [runId, proof.root, proof.rootIno, proof.path, proof.dev, proof.ino], paid: false }));
    record(() => plan.reserve(plan.key));
    const phase = ctx.state.get(id).recovery_actions?.intents[plan.key]?.phase;
    if (phase === "reserved") record(() => plan.executing());
    else if (!["executing", "resolved"].includes(phase)) throw cleanupBoundary("unresolved cleanup reservation");
    const guard = () => {
      checkOwner(); plan.guard();
      if (protectedInput(ctx, id, proof.path)) throw cleanupBoundary("artifact references changed");
    };
    if (stage === "checkout") {
      const host = hostApi(ctx), pr = await host.prView(entry.repo, entry.pr);
      if (pr.state !== "MERGED" || await terminalIdentityProblem(host, entry, { ...pr, strictIdentity: true })) { retry("merge-proof-unavailable"); return; }
      const result = await cleanupMergedWorkspace({ ...ctx, guardWorkspaceMutation: guard, cleanupBounds: bounds, requireSeparateScratchProof: true,
        reviewService: ctx.reviewService && { cleanup: () => ctx.reviewService.cleanup(id, { observeOnly: true }) } }, id, entry, pr);
      if (result.status !== "done") { update("workspace_cleanup", { ...result, status: "retained", retry_at: time + RETRY_MS }); return; }
      record(() => plan.verified([stage, proof.dev, proof.ino]));
      record(() => update("workspace_cleanup", { ...result, at: new Date(time).toISOString() }));
    } else {
      if (runtime.intent && (runtime.intent.key !== plan.key || !sameDirectory(runtime.intent.proof, proof))) throw cleanupBoundary("saved artifact intent changed");
      record(() => update("runtime_cleanup", { ...runtime, intent: { key: plan.key, proof, bytes } }));
      await removeOwnedDirectory(root, rel, { proof, guard, bounds });
      record(() => plan.verified([stage, proof.dev, proof.ino]));
      complete("removed", bytes);
    }
  } catch (error) { retry(error.code === "RECOVERY_AUTHORITY" ? "observation-only" : ["ENOSPC", "EDQUOT", "CLEANUP_BOUNDARY"].includes(error.code) ? error.code : "io-error"); }
}
