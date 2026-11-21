// Identity and read-only proofs for the coordinator's base repair operation.
// Host PR observations remain in adapters; no provider or host dispatch lives here.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { dirname, relative, isAbsolute, sep } from "node:path";
import { hosts } from "./hosts.mjs";
import { capabilitiesFor, isSessionFor } from "./harness.mjs";
import { assertRepositoryAccess } from "./host_contract.mjs";
import { assertBranchName, remoteMatches, savedRepository } from "./repository.mjs";
import { briefDivergence, divergenceReason, parsePrd, verifyCommands } from "./prd.mjs";
import { assertPublicationPaths, publicationPolicyOf } from "./work_artifacts.mjs";
import { recoveryDigest as hash } from "./recovery_digest.mjs";
import { turnBinding } from "./recovery_preflight.mjs";
import { ownedRecoveryRun } from "./recovery_authority.mjs";
import { recoveryHeld } from "./recovery_recipes.mjs";
import { directoryProof, planOverlayMoves, privateOverlayPaths, relocateOverlays, readRecoveryOverlays } from "./workspace_recovery.mjs";
import { executionRunner } from "./execution.mjs";
import { syncDirectory } from "./fs.mjs";
import { contentDigest } from "./hash.mjs";

export const repairError = (message, code = "base-repair-prerequisite") => Object.assign(new Error(message), { code });
export const repairKey = (head, baseSha) => `${head}:${baseSha}`;
export const repairOperation = (id, head, baseSha) => `base-repair:${createHash("sha256").update(JSON.stringify([id, head, baseSha])).digest("hex")}`;
const sha = value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "");

export function assertRepairIdentity(id, entry, op) {
  if (!entry || op?.version !== 1 || !sha(op.head) || !sha(op.baseSha) || op.key !== repairKey(op.head, op.baseSha) ||
      op.operationId !== repairOperation(id, op.head, op.baseSha) && (!op.journal || op.operationId !== `${op.journal.kind}:${op.journal.intent}`) ||
      ["repo", "branch", "base", "worktree", "session", "harness"].some(key => !op[key] || op[key] !== entry[key]) ||
      op.taskId !== id || !Number.isSafeInteger(op.round) || op.round < 1) {
    throw repairError("Base repair ownership differs from the saved repository, branch, base, session or operation. Restore the matching state and execution ledger; the worktree was preserved.", "base-repair-ownership");
  }
  if (op.journal && (op.journal.version !== 1 || !["git-repair", "ci-repair"].includes(op.journal.kind) ||
      op.journal.id !== hash([op.operationId, op.journal.intent]) || op.journal.epoch !== (entry.execution_epoch ?? 0) ||
      op.journal.repository !== savedRepository(entry).remoteIdentity || op.journal.pr !== entry.pr))
    throw repairError("Repair journal identity changed. Restore the saved host, task PR and execution epoch.", "base-repair-ownership");
}

export function repairRunMatches(id, entry, run) {
  const op = entry.base_repair;
  assertRepairIdentity(id, entry, op);
  const ex = run?.execution;
  return !!run && (!op.run || op.run === run.id) && ex?.operationId === op.operationId &&
    ex.taskId === id && ex.provider === op.harness && ex.sessionId === op.session &&
    ex.inputHead === (op.mergeSha || op.head) && ex.acceptance === "accepted" && !ex.quarantined &&
    (!op.journal || ex.recoveryIntent === op.journal.intent && ex.previousOperationId === op.journal.owner);
}

export function repairOverlays(ctx, id, entry, { required = true, includeDisplaced = false } = {}) {
  const approved = ctx.readPrd(id);
  const published = new Set(publicationPolicyOf(typeof approved === "string" ? parsePrd(approved, `${id}.md`) : null).publishFiles);
  const displaced = includeDisplaced ? new Set() : privateOverlayPaths(entry);
  return [...new Set([entry.prd, ...(entry.sources || [])].filter(path => path && !displaced.has(path)))].map(path => {
    const text = path === entry.prd ? approved : ctx.readSource?.(id, path);
    if (typeof text !== "string") {
      if (!required) return null;
      throw repairError(`Approved input snapshot missing: ${path}. Restore it before repairing the base.`, "base-repair-inputs");
    }
    // A carried document may also be an explicitly approved deliverable. Its
    // committed result can evolve; the authoritative snapshot never does.
    // The PRD itself remains immutable even when it is approved for publication.
    return { path, text, ...(path !== entry.prd ? published.has(path) ? { publishedOutput: true } : { privateSource: true } : {}) };
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
  return { head: await git.head(entry.worktree), pending, path };
}

export async function assertRepairPrerequisites(ctx, id, entry, pr, options) {
  const selected = (ctx.hosts ?? hosts).select(entry), capabilities = capabilitiesFor(entry.harness);
  assertRepositoryAccess(capabilities, selected.repository);
  if (!entry.base || !entry.branch || entry.branch === entry.base) throw repairError("Saved task branch and base identity are required; confirm the PR target and restore the recorded base before repair.");
  assertBranchName(entry.base); assertBranchName(entry.branch);
  if (pr && (pr.state !== "OPEN" || pr.isCrossRepository !== false || pr.headRefName !== entry.branch || pr.baseRefName !== entry.base)) throw repairError("Observed PR branch/base differs from the approved task; reconcile its identity before repair.", "base-repair-ownership");
  if (!isSessionFor(entry.harness, entry.session)) throw repairError("No recoverable task session. Restore the recorded provider session before repair; a fresh session is not authorized.");
  if (capabilities.repositoryAccess?.mode !== "local-worktree" || capabilities.continuation !== "native-session") throw repairError("This provider cannot merge inside the owned local checkout in the same session; automatic repair requires qualified local-worktree continuation.");
  assertRepairInputs(ctx, id, entry);
  return assertRepairCheckout(ctx, id, entry, options);
}

const ownership = message => repairError(message, "base-repair-ownership");
const journalError = message => repairError(message, "base-repair-manifest");
const same = (a, b) => hash(a) === hash(b);
const sourceOf = (ctx, id, entry, path) => path === entry.prd ? ctx.readPrd(id) : ctx.readSource(id, path);
const durable = { durable: true };

export function recordRepair(ctx, id, previous, patch) {
  const saved = ctx.state.update(id, current => {
    if (!same(current.base_repair ?? null, previous ?? null)) throw ownership("Repair journal was changed by another owner. Observe the saved operation.");
    return { base_repair: { ...previous, ...patch } };
  }, durable);
  return saved.base_repair;
}

export function ownedRepairPolicy(ctx, id, entry, op) {
  const prd = parsePrd(ctx.readPrd(id), id);
  const policy = publicationPolicyOf(prd, { sources: entry.sources, base: entry.base });
  return { ...policy, inputFiles: [...new Set([...policy.inputFiles, entry.prd].filter(Boolean))],
    ...(op.journal.kind === "git-repair" ? { pinnedBase: op.baseSha } : { repairTargets: op.journal.ci.targets }) };
}

export function guardJournalRepair(ctx, id, op, { author = false } = {}) {
  const registry = ctx.state.load(), entry = registry.entries[id], journal = op.journal;
  assertRepairIdentity(id, entry, op);
  const run = executionRunner(ctx, id).current();
  if (!same(entry.base_repair, op) || recoveryHeld(registry, id, entry) || entry.state === "done" ||
      entry.prd_divergence || entry.brief_changes?.length ||
      journal.approval !== turnBinding(ctx, id, entry, parsePrd(ctx.readPrd(id), id)) || journal.review !== hash(entry.reviewPolicy ?? null) ||
      !same(journal.workspace, directoryProof(realpathSync(entry.worktree))) ||
      (author ? !repairRunMatches(id, entry, run) || run.running !== false || entry.last?.run !== run.id ||
        (entry.execution && entry.execution.operationId !== run.execution.operationId) :
        !ownedRecoveryRun(id, entry, run) || run.execution.operationId !== journal.owner || run.id !== op.previousRun))
    throw ownership("Repair lost its original workspace, approved snapshot, settled execution or control. Preserve the journal and reconcile its owner.");
  return entry;
}

/** Pin the parents and the prior settled writer before moving any workspace
 * bytes. Keep the old fast path for merges without a conflict or collision. */
export async function prepareJournalRepair(ctx, id, entry, pr, { planFor, baseSha, ci = null, at }) {
  const { git } = ctx;
  const { head, pending, path } = await assertRepairPrerequisites(ctx, id, entry, pr, { clean: false });
  if (pending.head || pending.unmerged || pending.other.length || head !== pr.headRefOid)
    throw ownership("The task branch or its pending operation differs from the saved PR head. Preserve the index and reconcile it.");
  const run = executionRunner(ctx, id).current();
  if (!ownedRecoveryRun(id, entry, run)) throw ownership("Restore the exact accepted, terminal author before starting recovery.");
  const storage = relative(path, realpathSync(dirname(ctx.state.file)));
  if (storage !== ".." && !storage.startsWith(".." + sep) && !isAbsolute(storage))
    throw ownership("The protected recovery store must be outside the author checkout.");
  const kind = ci ? "ci-repair" : "git-repair";
  if (baseSha === head || !sha(baseSha)) throw journalError("Recovery has no distinct, pinned base commit.");
  if (await git.fetchBranchHead(entry.worktree, entry.branch) !== head) throw ownership("Remote task head changed before recovery.");
  const preview = ci ? null : await git.mergePreview(path, baseSha);
  const policy = publicationPolicyOf(parsePrd(ctx.readPrd(id), id), { sources: entry.sources, base: entry.base });
  const carried = repairOverlays(ctx, id, entry);
  const collisions = [];
  if (!ci) for (const item of carried) {
    if (policy.publishFiles.includes(item.path) || await git.treeEntry(path, head, item.path)) continue;
    const blob = await git.treeEntry(path, baseSha, item.path);
    if (blob) collisions.push({ ...item, blob, baseBytes: await git.fileAt(path, baseSha, item.path, { bytes: true }) });
  }
  const tracked = collisions.length ? (await Promise.all([git.treePaths(path, baseSha), git.treePaths(path, head), git.indexPaths(path)])).flat() : [];
  const overlays = planOverlayMoves(path, collisions, tracked);
  const overlaysByPath = new Map(overlays.map(move => [move.path, move]));
  const inputCopies = carried.filter(item => !overlaysByPath.has(item.path) || overlaysByPath.get(item.path).file)
    .map(item => {
      const move = overlaysByPath.get(item.path);
      return move?.hash === move?.base && move?.hash !== move?.approved ? { ...item, text: collisions.find(x => x.path === item.path).baseBytes.toString("utf8") } : item;
    });
  await git.assertClean(path, inputCopies);
  const clean = await git.repairManifest(path);
  if (head !== clean.head || clean.branch !== entry.branch || clean.mergeHead) throw ownership("Branch or index changed during repair planning.");
  if (overlays.some(move => clean.changes.some(change => change.path === move.path && change.state !== "??"))) throw journalError("A collision is staged or tracked by the task. Reconcile the path explicitly.");
  if (ci && !await git.containsCommit(path, baseSha, head)) throw journalError("Integrate the approved base before diagnosing task-owned CI.");
  const paths = [...(preview?.conflicts ?? [])].sort();
  const cause = ci ? ci.cause : ["base-conflict", entry.base, paths];
  const input = { head, baseSha, pr: entry.pr, branch: entry.branch, path, index: clean.fingerprint,
    preview, overlays: overlays.map(move => [move.path, move.approved, move.base, move.file]), ci };
  const plan = planFor(kind, cause, input);
  plan.guard();
  const operationId = `${kind}:${plan.key}`;
  const journal = { version: 1, kind, id: hash([operationId, plan.key]), intent: plan.key,
    input, cause, phase: "planned", owner: plan.priorOperation, epoch: entry.execution_epoch ?? 0,
    repository: savedRepository(entry).remoteIdentity, pr: entry.pr, workspace: clean.workspace,
    clean, preview, overlays, ci, approval: plan.decision.expected.snapshot, review: hash(entry.reviewPolicy ?? null) };
  const op = { version: 1, head, baseSha, taskId: id, repo: entry.repo, branch: entry.branch, base: entry.base, worktree: entry.worktree,
    session: entry.session, harness: entry.harness, key: repairKey(head, baseSha), operationId, round: entry.iteration + 1,
    provenance: "automatic", status: "prepared", at, previousRun: run.id, charged: false, journal };
  assertRepairIdentity(id, entry, op);
  const saved = ctx.state.update(id, current => {
    if (!same(current.base_repair ?? null, entry.base_repair ?? null)) throw ownership("Another operation owns the workspace.");
    const previous = current.base_repair;
    if (!previous?.journal) return { base_repair: op };
    const { head, baseSha, remoteSha, operationId, journal: { id, ci, ciClear, verification } } = previous;
    const history = [...(current.repair_history ?? []), { head, baseSha, remoteSha, operationId, id, ci, ciClear, verification }];
    return { base_repair: op, repair_history: history };
  }, durable);
  return { op: saved.base_repair, plan };
}

function repairGuard(ctx, id, op, plan) {
  return () => { plan.guard(); guardJournalRepair(ctx, id, op); };
}

export async function resumeJournalPreparation(ctx, id, op, plan) {
  const { git } = ctx, journal = op.journal, path = realpathSync(op.worktree);
  const guard = repairGuard(ctx, id, op, plan);
  const entry = guardJournalRepair(ctx, id, op);
  if (plan.key !== journal.intent) throw ownership("The original repair intent no longer matches.");
  const current = await git.repairManifest(path);
  const identityMatches = current.head === op.head && current.branch === op.branch &&
    same(current.workspace, journal.clean.workspace) && same(current.directory, journal.clean.directory);
  if (!identityMatches) throw ownership("The original task HEAD, branch or Git directory changed. Preserve the journal.");
  if (journal.phase === "pending") {
    if (current.fingerprint !== journal.manifest.fingerprint) throw journalError("Saved merge/index or partial resolutions changed. Restore exact ownership before continuing.");
    return op;
  }
  if (!["planned", "merging"].includes(journal.phase)) throw ownership("Observe the original recovery execution before continuing.");
  syncDirectory(dirname(ctx.state.file));
  const policy = ownedRepairPolicy(ctx, id, entry, op);
  const previousPolicy = publicationPolicyOf(parsePrd(ctx.readPrd(id), id), { sources: entry.sources, base: entry.base });
  const hook = await git.repairHook(path, policy, entry.hook_policy?.approval === journal.approval ? entry.hook_policy.digest : null, guard, { previousPolicy });
  const copies = repairOverlays(ctx, id, entry);
  let checkpoint = current;
  if (current.mergeHead) {
    if (journal.phase !== "merging" || current.mergeHead !== op.baseSha || current.originalHead !== op.head ||
        !await git.expectedMerge(path, current, journal.preview, copies))
      throw journalError("Interrupted merge does not match its recorded parents, index and projected worktree. Preserve all partial resolutions for inspection.");
  } else {
    const displaced = new Set(journal.overlays.map(move => move.path));
    if (current.index !== journal.clean.index || current.originalHead !== journal.clean.originalHead ||
        !same(current.changes.filter(change => !displaced.has(change.path)), journal.clean.changes.filter(change => !displaced.has(change.path))))
      throw journalError("Unrelated changes or a changed index block repair. Preserve the worktree.");
    if (journal.phase === "planned") {
      guard();
      relocateOverlays({ stateDir: dirname(ctx.state.file), worktree: path, directory: journal.id, moves: journal.overlays,
        source: name => sourceOf(ctx, id, entry, name), guard: () => { guard(); git.guardRepairMetadata(path, current); } });
    }
    readRecoveryOverlays(ctx, id, entry);
    if (journal.kind === "git-repair") {
      if (journal.phase === "planned") {
        guard();
        op = recordRepair(ctx, id, op, { journal: { ...journal, hook, phase: "merging" } });
      }
      const before = await git.repairManifest(path);
      if (before.index !== current.index || before.head !== current.head || before.mergeHead ||
          !same(before.changes, current.changes.filter(change => !displaced.has(change.path))))
        throw journalError("Index or working files changed after overlay backup.");
      const bound = repairGuard(ctx, id, op, plan);
      await git.beginRepairMerge(path, op.baseSha, async () => {
        if ((await git.repairManifest(path)).fingerprint !== before.fingerprint) throw journalError("Merge inputs changed immediately before Git started.");
        bound();
      });
      checkpoint = await git.repairManifest(path);
      if (checkpoint.head !== op.head || checkpoint.mergeHead !== op.baseSha || checkpoint.originalHead !== op.head ||
          !await git.expectedMerge(path, checkpoint, journal.preview, copies))
        throw journalError("Git left an index or partial resolutions outside the recorded merge projection. Preserve them and inspect the original operation.");
    }
  }
  repairGuard(ctx, id, op, plan)();
  return recordRepair(ctx, id, op, { journal: { ...journal, hook, phase: "pending", manifest: checkpoint } });
}

export async function proveRepairCandidate(ctx, id, entry, op) {
  const { git } = ctx, path = realpathSync(entry.worktree), j = op.journal;
  const manifest = await git.repairManifest(path);
  if (manifest.branch !== op.branch || manifest.head === op.head || manifest.mergeHead ||
      !same(manifest.workspace, j.clean.workspace) || !same(manifest.directory, j.clean.directory))
    throw journalError("No clean owned repair commit was recorded. Preserve the index and inspect the original author result.");
  if (!same(await git.commitParents(path, manifest.head), j.kind === "git-repair" ? [op.head, op.baseSha] : [op.head]) ||
      !await git.containsCommit(path, op.baseSha, manifest.head))
    throw journalError("Repair must publish the original task parent and pinned base ancestry.");
  if (j.staged && !await git.commitMatchesRepairIndex(path, manifest.head, j.staged))
    throw journalError("The observed merge commit differs from the saved staged tree.");
  await git.assertClean(path, repairOverlays(ctx, id, entry));
  readRecoveryOverlays(ctx, id, entry);
  const policy = ownedRepairPolicy(ctx, id, entry, op);
  const changes = await git.pathsBetween(path, j.kind === "git-repair" ? op.baseSha : op.head, manifest.head);
  assertPublicationPaths(changes, policy);
  if (j.preview && (await git.pathsBetween(path, j.preview.tree, manifest.head)).some(path => !j.preview.conflicts.includes(path)))
    throw journalError("The candidate changes paths outside the recorded merge conflicts. Preserve the edits and reconcile their authority.");
  if (j.ci && (!changes.some(path => j.ci.paths.includes(path)) || changes.some(path => !j.ci.targets.includes(path))))
    throw journalError("CI repair does not match the exact approved targets and the recorded failing job.");
  for (const move of j.overlays) if (await git.treeEntry(path, manifest.head, move.path) !== move.blob)
    throw journalError("Tracked content at a displaced context path differs from the pinned base. Preserve the implementation edit and reconcile the source explicitly.");
  return manifest;
}

export async function finishStagedRepair(ctx, id, op) {
  if (op.journal.kind !== "git-repair" || !["author", "committing"].includes(op.journal.phase)) return op;
  const { git } = ctx, path = realpathSync(op.worktree);
  const guard = () => guardJournalRepair(ctx, id, op, { author: true });
  const entry = guard(), checked = await git.repairManifest(path), journal = op.journal;
  if (checked.head !== op.head) return op; // A lost acknowledgement may have left the exact merge commit.
  const copies = repairOverlays(ctx, id, entry);
  if (checked.branch !== op.branch || checked.originalHead !== op.head || checked.mergeHead !== op.baseSha ||
      checked.unmerged !== hash([]) || !same(checked.workspace, journal.clean.workspace) || !same(checked.directory, journal.clean.directory) ||
      checked.changes.some(change => change.state[1] !== " " &&
        !copies.some(copy => copy.path === change.path && ["??", " M"].includes(change.state) && contentDigest(copy.text) === change.hash)))
    throw journalError("The author left unstaged or unresolved changes. Preserve the exact partial resolutions and inspect the original run.");
  if ((await git.stagedPaths(path, journal.preview.tree)).some(name => !journal.preview.conflicts.includes(name)))
    throw journalError("The index contains staged changes outside the recorded conflict paths.");
  assertPublicationPaths(await git.stagedPaths(path, op.baseSha), ownedRepairPolicy(ctx, id, entry, op));
  if (journal.staged && checked.fingerprint !== journal.staged.fingerprint)
    throw journalError("The staged tree changed since the commit intent. Preserve the index and inspect its writer.");
  const policy = ownedRepairPolicy(ctx, id, entry, op);
  await git.repairHook(path, policy, null, guard, { refresh: false });
  if (journal.phase === "author") {
    guard();
    op = recordRepair(ctx, id, op, { journal: { ...journal, phase: "committing", staged: checked } });
  }
  try {
    await git.commitRepair(path, async () => {
      if ((await git.repairManifest(path)).fingerprint !== checked.fingerprint)
        throw journalError("The staged tree changed immediately before the owned commit.");
      guard();
    });
  } catch (error) {
    if (await git.head(path) === op.head && typeof error.code === "number")
      recordRepair(ctx, id, op, { journal: { ...op.journal, phase: "commit-refused" } });
    throw error;
  }
  return op;
}

export function repairVerifyCommands(ctx, id) {
  return verifyCommands(parsePrd(ctx.readPrd(id), id));
}

export async function proveRepairPush(ctx, id, entry, pr, { assertOwner = () => {}, restorePrivate = true, authorizeRestore } = {}) {
  const op = entry.base_repair;
  assertRepairIdentity(id, entry, op);
  const { head, pending } = await assertRepairPrerequisites(ctx, id, entry, pr, { clean: false });
  if (pending.head || pending.unmerged || pending.other.length) throw repairError(`Unresolved Git operation in ${entry.worktree}; preserve it and finish the owned merge.`, "base-repair-unresolved");
  if (head === op.head || !await ctx.git.containsCommit(entry.worktree, op.head, head) || !await ctx.git.containsCommit(entry.worktree, op.baseSha, head)) throw repairError("Repair did not produce a descendant of both the task head and pinned base. Preserve the checkout, finish the intended merge and verification, then push the task branch.", "base-repair-no-merge");
  const remote = await ctx.git.fetchBranchHead(entry.worktree, entry.branch);
  if (remote !== pr.headRefOid || !await ctx.git.containsCommit(entry.worktree, head, remote) || !await ctx.git.containsCommit(entry.worktree, op.baseSha, remote)) throw repairError(`Repair push is unproved: local ${head}, remote ${remote}, observed PR ${pr.headRefOid}. Push only ${entry.branch} and resume after host evidence catches up; local work was preserved.`, "base-repair-push");
  const owner = () => {
    const current = ctx.state.get(id);
    assertRepairIdentity(id, current, op);
    if (current.base_repair?.operationId !== op.operationId) throw repairError("Another repair owns this task; preserve its current inputs.", "base-repair-ownership");
    assertOwner();
  };
  owner();
  try {
    const overlays = repairOverlays(ctx, id, entry);
    if (restorePrivate && ctx.git.restorePrivateOverlays) await ctx.git.restorePrivateOverlays(entry.worktree, overlays, { head, baseSha: op.baseSha, assertOwner: owner, authorizeRestore });
    else await ctx.git.assertClean(entry.worktree, overlays);
  } catch (error) {
    if (error.code === "OPERATOR_INTENT" || error.code?.startsWith?.("base-repair-")) throw error;
    if (typeof error.code === "number" || error.killed || ["ETIMEDOUT", "EIO", "EAGAIN"].includes(error.code)) throw error;
    throw repairError(`Repair inputs could not be reconciled: ${error.message}. Preserve local edits and restore approved private inputs before resume.`, "base-repair-dirty");
  }
  owner();
  return { repairSha: head, remoteSha: remote };
}
