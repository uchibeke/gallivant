import { matchingDeliveryEvidence, ownerDeliveryFromPrd, validateOwnerDelivery } from "./owner_delivery.mjs";
import { profileView } from "./task_profile.mjs";
import { preflightPackageAuth } from "./package_auth.mjs";
import { createHash } from "node:crypto";
import { contentDigest } from "./hash.mjs";
import { requireAuthorRoute } from "./commands/recovery.mjs";
import { prepareRecoveryHandoff } from "./recovery_handoff.mjs";
import { acceptedRecovery, planRecovery, recordReviewCycle, recoveryHeld, verifyRecoveryOutcome } from "./recovery_recipes.mjs";
import { remoteMatches } from "./repository.mjs";
import { resumePrompt } from "./prompt.mjs";
import { requireOperatorIntent } from "./operator_intent.mjs";
import { recoveryFences, reconcileRevokedRun } from "./recovery_authority.mjs";
import { authorConfigurationDigest, turnBinding, verifyAuthorCopies } from "./recovery_preflight.mjs";
import { PUBLICATION_POLICY_VERSION, publicationPolicyOf, workArtifactViolations, workArtifactError } from "./work_artifacts.mjs";
import { gitDiffChangedPaths } from "./git_diff.mjs";
import { hosts, completionAdapter } from "./hosts.mjs";
import { assertRepositoryAccess, observedIdentityProblem, terminalIdentityProblem } from "./host_contract.mjs";
import { hostApi } from "./hosts.mjs";
// One coordinator cycle advances due control, settlement, host, reviewer and
// maintenance obligations through the same task decision owners.
//
// All side effects go through injected dependencies (gh, git, runner, notify, clock), so the whole state machine
// runs under `node --test` with fakes and no network.
//
// Cursors, in one place: `since` is the boundary at or after which events are new, paired with `dispatched`, the
// event keys already handled at exactly that instant (GitHub stamps to the second, so a strict comparison would
// bury a second event written in the same second); `fixed_sha` is the head the loop last acted on, both the head when
// the last run started, so a run that pushed is recognised by the head moving, and the head a ready entry was judged
// on, so a push after that reopens it; `checks_sha` is the head whose failing checks were already dispatched;
// `receipt_hash` is the completion receipt when the last run started.
import { STATES, handleFor, prdIdOf, advanceCursor } from "./state.mjs";
import { repositoryReviewConfig } from "./review_policy.mjs";
import { readFeedback, requiredFeedback, deriveEvents, makeTrust, reviewerVerdict, exactReviewerVerdict, reviewerClock, failingChecks, checkSummary, isGreen, addedLines, hasOwnComment, eventKey, isFixCommand } from "./events.mjs";
import { legacyReviewPolicy, policyConfig, reviewBinding, reviewVerdict, needsFirstParty, needsExternal, reviewDigest } from "./review_policy.mjs";
import { findingsPrompt } from "./review_evidence.mjs";
import { fixPrompt, registerPrompt, baseRepairPrompt } from "./prompt.mjs";
import { assertRepairIdentity, assertRepairCheckout, assertRepairPrerequisites, repairOverlays, repairKey, repairOperation, repairRunMatches, proveRepairPush, repairError,
  prepareJournalRepair, resumeJournalPreparation, proveRepairCandidate, finishStagedRepair, recordRepair, guardJournalRepair, ownedRepairPolicy, repairVerifyCommands } from "./base_repair.mjs";
import { verifyRepair } from "./repair_verification.mjs";
import { scopeCIFailure } from "./ci_repair.mjs";
import { privateOverlayPaths, readRecoveryOverlays } from "./workspace_recovery.mjs";
import { parsePrd, verifyCommands, criteriaFromPrd, briefDivergence, divergenceReason, renderDivergence, retakePrdSnapshot } from "./prd.mjs";
import { gate, denialsPrompt, receiptInstructions, receiptHash, receiptHashes } from "./deliverable.mjs";
import { normalizePublicBody } from "./block.mjs";
import { ROUND_MARKER, NUDGE_MARKER, READY_LABEL, NEEDS_LABEL, actor, normalizeLogin } from "./host_contract.mjs";
import { publicPrViolations, publicCommentViolations, publicCorrection, publicReviewHash } from "./public_output.mjs";
import { hasLegacyStatusLabels } from "./public-format.mjs";
import { adapterFor, buildRun, capabilitiesFor } from "./harness.mjs";
import { dispatchProvenUnsent, executionRunner, reserveExecutionEpoch, unsubmittedInitialDispatch } from "./execution.mjs";
import { requireHarness } from "./probe.mjs";
import { acquirePublicationLock, reconcileExecutionResult, executionResultCheckpoint, executionPublicationHeld, requireVerificationSandbox } from "./execution_result.mjs";
import { readJson } from "./fs.mjs";
import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { runSessionEnv, prdIdFromBranch } from "./git.mjs";
import { resolveCredentialFor } from "./credential.mjs";
import { requireIdentity } from "./identity.mjs";
import { resolveContextPaths, resolveTimeout } from "./config.mjs";
import { nowIso, minutes, hours, earlier, later, floorSecond } from "./time.mjs";
import { writeRepositoryText } from "./repository_files.mjs";
import { applyControl, interruptControl, cancelControl, recoverControl, controlPending, cancellationStatus } from "./control.mjs";
import { controlAllowsRepair, controlWaitsForRun } from "./control_contract.mjs";
import { tickChains } from "./chains.mjs";
import { assertPlanRounds, planRunConfig, taskExecutionConfig, taskProviderAllowance } from "./task_allowance.mjs";
import { learningInput, learningDispatch, learningDelivered, learningDeliveryPatch, learningDeliveryPending } from "./learning_input.mjs";
import { hash as learningHash } from "./learning_data.mjs";
import { boundedCall, recoveryDispatchDeferred, runRecoveryWork } from "./recovery_io.mjs";
import { networkRecoveryDeadline, transientProviderFailure, validNetworkRetry, retryPlan } from "./network_recovery.mjs";
import { completionStopsAutomation, mergeCleanupSettled } from "./task_completion.mjs";
import { withReviewState } from "./review_state.mjs";
import { ciErrorText, ciSourceBinding, deferredReviewerVerdict } from "./deferred_ci.mjs";
import { deferredMaintenanceOwed } from "./ci_timing.mjs";
import { deferredChecks, maintainDeferredCI, makeImmediateCIObserver, recheckDeferredReadiness, terminalDeferredChecks,
  ungatedRequirements, ungatedRollup } from "./deferred_ci_run.mjs";
import { authorSettled, EXECUTION_TRANSPORTS, executionLive, ownedRemoteExecution } from "./execution_contract.mjs";
import { cleanupOwed, executionOwed, makeRecoverySchedule, makeWorkSlots, STRUCTURAL_SCAN_SECONDS, unprojectedExecution } from "./recovery_schedule.mjs";
import { coolingDown, providerScope, serverRetryAt, transientServiceFailure } from "./recovery_cooldown.mjs";
import { dispatchCapacity } from "./dispatch_capacity.mjs";
import { reconcileUnsentStarts, tickDependencyPlans } from "./dependency_plan_dispatch.mjs";

const CONCURRENCY = 4;
// Child-process failures use numeric exit codes; only our named repair codes carry this prefix.
const isBaseRepairError = error => typeof error?.code === "string" && error.code.startsWith("base-repair-");

/**
 * How many ticks in a row one GitHub write may fail before the entry stops with `stuck` and says which write it was.
 *
 * Four steps in the tick decline rather than proceed when a single GitHub write fails, because proceeding would leave a
 * worse state than waiting: the ready-label removal before a dispatch, the same removal before a moved head is judged,
 * the identity block write a start run has to land before it can leave `running`, and the ready-label write that makes
 * a judged PR say a human may merge it. All four are right to wait, and all four used to wait forever, with one log line
 * per tick as the only trace. An entry stuck silently is worse than one that stops with a reason, because the whole
 * point of this daemon is that the operator can go to bed.
 *
 * The fifth caller, the round comment, is on this counter for the same "a permanent refusal must not be silent" reason
 * and for a different second one. It does not decline a step: the round it announces is already counted and the cursor
 * has already moved, because the push it announces already happened and no comment failure can un-spend it. What it
 * declines is the REST of the tick, because the comment is also the re-review request, so an entry that owes one has
 * not asked the reviewer anything and must not be judged on the reviewer's silence or charged a second round.
 *
 * Completion verification uses the same bound: an unavailable evaluator or unreadable diff must surface its cause
 * and stop, without spending a fixer round or waiting on a reviewer who already answered.
 *
 * A fixed number rather than a config key, deliberately. `max_iterations` is the nearest existing knob and it is the
 * wrong one: it counts fix rounds, which cost a harness run and money each, while these cost one API call, so tying
 * the two would either stop a transient failure after three ticks or let a permanent one run for as long as the
 * operator was willing to pay for rounds. A new key would be one more thing in `config.json` with no right answer to
 * tune it to: the only question it answers is "transient or permanent", and five consecutive failures answers it at
 * any `poll_seconds`. At the default 120s that is ten minutes, which outlasts a GitHub rate-limit window and an abuse
 * pause, and is far short of a revoked token or a body-write permission the operator has to fix by hand.
 */
const MAX_STEP_FAILURES = 5;

/**
 * The names `retryFailed` records in `entry.retry.op`, exported because `status` has to tell one of them apart from the
 * others: three of these are steps on the way to a fix round, and `READY_LABEL_WRITE` is reached only after every
 * readiness condition has already passed, so the row it produces says something different. Exported from here rather
 * than duplicated there because this is the file that writes them, and `lib/` does not import from `lib/commands/`.
 * The block write's name carries the PR number, so it is built at the site rather than listed here.
 *
 * `ROUND_COMMENT` is the one whose `retry` sits on an entry whose work is DONE rather than pending, so `status` reads
 * `fixing` for it correctly (a fix round really did happen) and `why` adds the half the row cannot fit: the round is
 * counted, and the PR does not yet say so.
 */
export const READY_LABEL_REMOVAL = "ready label removal";
export const READY_LABEL_WRITE = "ready label write";
export const ROUND_COMMENT = "round comment";
export const COMPLETION_GATE = "completion gate";
export const REVIEW_CAPTURE = "review evidence capture";
export const PUBLIC_METADATA = "public metadata write";
export const REGULAR_PR = "regular PR conversion";

/** Two GitHub timestamps for the same instant, however each is spelled. */
const sameInstant = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);

/** One second before a cursor: the overlap a server-side `since` filter is asked for. See `tickEntry`. */
const fetchFrom = iso => (iso ? new Date(Date.parse(floorSecond(iso)) - 1000).toISOString() : iso);
const recordedRun = runner => typeof runner?.state === "function" ? runner.state()?.current : runner?.current?.();

export function makeTick(deps) {
  const authorSlots = deps.authorSlots || makeWorkSlots(deps.config.execution?.concurrency || CONCURRENCY);
  const authorContext = () => deps.authorSlots ? deps : { ...deps, authorSlots };
  // `writePrd` is here for one caller: the re-snapshot of a brief edited outside its contract. It is the only write to
  // the snapshot the tick makes, and it is not the tick overruling the operator, it is the tick following them.
  const { config, state, git, notify, log, clock = Date, ownLogin, readPrd, writePrd = () => {}, fetch = globalThis.fetch, aportApiKey = null, credential: ctxCredential = null, identity: ctxIdentity = null } = deps;
  const host = hostApi(deps);
  const runnerFor = id => executionRunner(deps, id);
  const deferred = entry => entry.ciTiming?.timing === "after-review";
  const pilotFor = entry => {
    const pilot = deferred(entry) && state.ciPilot?.();
    return pilot?.digest === entry.ciTiming?.revision && pilot ? pilot : null;
  };
  const observeImmediateCI = makeImmediateCIObserver(deps);
  const planAllowanceFor = (id, entry) => entry.plan ? state.graphAuthorAllowance(id) : null;
  const iterationLimit = (id, entry) => planAllowanceFor(id, entry)?.maxIterations ?? config.max_iterations;
  const dependencyProducer = (id, entry) => Boolean(entry.plan || entry.chain || state.isChainPredecessor?.(id));
  const completed = (id, entry) => {
    if (!completionStopsAutomation(entry)) return false;
    // Acceptance may be durable in the execution ledger before the registry
    // catches up. This is a local saved-state read, never a provider poll.
    try { return completionStopsAutomation(entry, runnerFor(id).current()); }
    catch { return false; } // keep reconciliation available on unreadable state
  };
  const startupReconciliation = new Set(deps.startupEntries || (deps.startupReconciliation === false ? [] : state.entries(([, e]) => executionOwed(e))
    .filter(([, e]) => executionOwed(e)).map(([id]) => id)));
  const schedule = deps.recoverySchedule || makeRecoverySchedule({ home: deps.home || (state.file && dirname(state.file)), clock,
    scanSeconds: config.recovery_scan_seconds ?? STRUCTURAL_SCAN_SECONDS });
  // Embedders may restore the canonical cadence after a bounded wake.
  let nextChainAt = deps.nextChainAt ?? 0;
  const backgroundDependencies = deps.backgroundDependencies && !deps.assertCoordinatorOwner;
  const dependencyWork = new Map(), completedDependencyWork = [];
  const advanceDependencies = (lane, advance) => {
    if (!backgroundDependencies) return advance();
    if (!dependencyWork.has(lane)) {
      const work = advance();
      dependencyWork.set(lane, work);
      void work.then(results => completedDependencyWork.push(...results), error => log.warn(`${lane} sweep failed: ${error.message}`))
        .finally(() => dependencyWork.delete(lane));
    }
    return [];
  };
  let nextReserveCheck = 0;
  let cleanupObservers = new Set();
  const ownLogins = new Map();
  const loginFor = entry => ownLogins.get(entry.repo) || ownLogin;
  const reviewConfigFor = entry => policyConfig(config, entry);
  const trustFor = entry => makeTrust(reviewConfigFor(entry), loginFor(entry));
  const learning = deps.learning || deps.learningFor?.(ownLogin);
  const observationQueue = [];
  let observationSelection = null;
  const now = () => nowIso(clock);

  // Progress polling is not itself a task change. Preserve the UI timestamp
  // and let state.update skip the write when every proposed field is unchanged.
  const save = (id, patch, observation, guard = () => true) => {
    const before = deps.collaboration ? state.get(id) : null;
    const saved = state.update(id, current =>
      guard(current) && Object.entries(patch).some(([key, value]) => !isDeepStrictEqual(current[key], value))
        ? { ...patch, updated_at: now(), ...(deps.maintainWorkspace && patch.last?.run && patch.last.exit != null && current.last?.exit == null && current.last?.run === patch.last.run ?
          { runtime_cleanup: { run: patch.last.run, stage: "scratch", next_at: clock.now() } } : {}) } : {}, observation);
    if (deps.collaboration && !isDeepStrictEqual(before, saved)) {
      try { deps.collaboration.observeEntry(id, before, saved); }
      catch (error) { log.warn(`${id}: collaboration event capture unavailable (${error.code || "storage error"}); task state preserved`); }
    }
    return saved;
  };
  const reviewDispositionPatch = (id, entry, key, patch) => {
    if (!key) return {};
    const current = entry.firstPartyReview?.key === key;
    const record = current ? entry.firstPartyReview : state.reviewHistoryRecord ? state.reviewHistoryRecord(id, key) : (entry.reviewHistory || []).findLast(r => r.key === key);
    if (record?._gallivantReviewArchive) throw new Error("historical review must be integrity-checked before updating its disposition");
    if (!record) return {};
    const updated = { ...record, disposition: { ...record.disposition, ...patch } };
    return { ...(current ? { firstPartyReview: updated } : {}), reviewHistory: [...(entry.reviewHistory || []), updated] };
  };
  const externalVerdict = (entry, input) => deferred(entry) ? deferredReviewerVerdict(entry, input) : entry.reviewPolicy?.version === 1
    ? exactReviewerVerdict(input, host.refSha ? sha => host.refSha(entry.repo, sha) : null)
    : reviewerVerdict(input);

  const recoveryIdentity = (entry, session = entry.session) => ({ prd: entry.prd, harness: entry.harness, session, branch: entry.branch });

  // Keep this boundary separate from the event cursor: an uncorrected own reply must not disappear after a dispatch.
  const ownPublicComments = (entry, comments) => comments.filter(c => {
    const author = actor(c.actor ?? c.user ?? c.author);
    return !author.bot && author.login === normalizeLogin(loginFor(entry))
      && !isFixCommand(c.body)
      && Date.parse(c.updatedAt ?? c.updated_at ?? c.at ?? c.submitted_at ?? c.createdAt ?? c.created_at) >= Date.parse(entry.public_since);
  });

  async function currentPublicComments(entry) {
    const [comments, inline, reviews] = await Promise.all([
      host.issueComments(entry.repo, entry.pr, fetchFrom(entry.public_since)),
      host.inlineComments(entry.repo, entry.pr, fetchFrom(entry.public_since)),
      host.reviews(entry.repo, entry.pr),
    ]);
    return ownPublicComments(entry, [...comments, ...inline, ...reviews.map(r => ({ ...r, public_kind: "review" }))]);
  }

  /**
   * The one way into needs-human, so every path through it leaves the same two labels. The ready label comes off as
   * the needs-human label goes on: an entry that was ready and then hit a conflict, a red head or a blocking
   * reviewer would otherwise carry both, which tells a person, and any automation reading labels, two opposite
   * things. Removal is unconditional rather than guarded on the entry's own state, because a label left by an
   * earlier daemon outlives the registry; `removeLabel` already ignores a label that is not there.
   */
  async function needsHuman(id, reason, extra = {}) {
    // `timeout` is cleared alongside `gate_skipped` for the same reason: both describe ONE stop, and an entry that
    // stopped for a timeout and later stops for `checks-red` must not still print a kill line from a run ago. The
    // caller that means it passes its own `timeout` in `extra`, which lands after this and wins.
    // Stop diagnostics describe the current execution; a shorter event message
    // must not erase its run ID, exit status, cost or provider evidence.
    const last = extra.last && typeof extra.last === "object" && !Array.isArray(extra.last)
      ? { last: { ...state.get(id).last, ...extra.last } } : {};
    const e = save(id, { state: STATES.needsHuman, reason, gate_skipped: null, timeout: null, ...extra, ...last });
    log.warn(`${id}: needs-human (${reason})`);
    const written = e.pr ? await writeStopLabels(id, e) : true;
    // Unlike the ready label, this one cannot hold the state back: the entry IS stopped, and the registry, `status`,
    // `why` and the message are all signals in their own right. What it must not do is give up: a rate-limited or
    // briefly unreachable GitHub used to leave the PR carrying `ready-for-human` and no `needs-human` while the
    // registry said stopped, with nothing that would ever reconcile it, because every later tick returns early on
    // this state. So the failure is recorded and `tickEntry` retries it before that early return.
    const patch = written ? (e.labels_pending ? { labels_pending: false } : null) : { labels_pending: true };
    const saved = patch ? save(id, patch) : e;
    await notify.needs({ entry: saved, max: iterationLimit(id, saved), handle: handleFor(id, saved) });
    return saved;
  }

  /**
   * The two labels a stopped PR carries, as one write. The ready label comes off as the needs-human label goes on: an
   * entry that was ready and then hit a conflict, a red head or a blocking reviewer would otherwise carry both, which
   * tells a person, and any automation reading labels, two opposite things. Returns whether both landed.
   */
  async function writeStopLabels(id, e) {
    // `removeLabel` throws for everything but a label that was already absent, so a GitHub that is not answering is
    // not mistaken for a label that was already off. It does not decide the retry on its own: whether GitHub is
    // reachable at all is the same question for both writes, and `addLabel` is the one that must land, so that is
    // what the retry tracks. A removal that fails for any other reason is retried with it on the next tick.
    let removed = true;
    try { await host.removeLabel(e.repo, e.pr, READY_LABEL); }
    catch (err) { removed = false; log.warn(`${id}: ready label not removed (${err.message})`); }
    try { await host.addLabel(e.repo, e.pr, NEEDS_LABEL); }
    catch (err) { log.warn(`${id}: needs-human label not written (${err.message}); retrying next tick`); return false; }
    if (!removed) log.warn(`${id}: retrying the ready-label removal next tick`);
    return removed;
  }

  /**
   * The bound on every step that declines a tick because a GitHub write or completion check failed. One mechanism
   * for all of them: this codebase's recurring defect is the same invariant enforced on one path and not its sibling.
   * What makes a caller belong here is the shape: the step declines, the entry stays in a state the next tick
   * re-enters, and nothing else about the entry has changed.
   *
   * `entry.retry` is `{ op, count, error? }`: which operation has been failing and how many ticks in a row. It is a counter of
   * CONSECUTIVE failures, so `retryOk` clears it when the step succeeds and an entry that recovers is never stopped
   * for the ticks it spent failing. A different `op` failing resets the count rather than adding to it, because the
   * count exists to answer "is this one step permanently broken" and two different broken steps are two answers.
   *
   * `retryFailed` returns true when it stopped the entry; the caller returns without doing the work it declined either
   * way. `needsHuman` is the stop, so the labels, the notification and the once-only guarantee are the same as every
   * other stop's; the reason is `stuck` and `last.event` names the write and the last error, which is what the operator
   * reads in `gallivant why`. `onStop` is what a caller wants recorded only once the waiting is over, never while it is
   * still waiting: the start-run case had read the PR number before the block write refused it, and a stopped entry that
   * names its PR is one the operator can click through to, while a retrying one must not claim to watch a PR whose
   * identity block is still missing.
   */
  const retryOk = (id, entry) => (entry.retry ? save(id, { retry: null }) : entry);

  async function retryFailed(id, entry, op, err, { action, onStop = {}, detail = err.message }) {
    if (err?.code === "RECOVERY_IO_BUDGET" || coolingDown(err) || transientServiceFailure(err) && serverRetryAt(err, clock.now()) > clock.now()) {
      const retryAt = serverRetryAt(err, clock.now());
      save(id, { review_next_at: Math.max(entry.review_next_at || 0, retryAt, clock.now() + config.poll_seconds * 1000) });
      return false;
    }
    const count = (entry.retry?.op === op ? entry.retry.count : 0) + 1;
    if (count < MAX_STEP_FAILURES) {
      log.warn(`${id}: ${op} failed (${detail}); ${action} (attempt ${count} of ${MAX_STEP_FAILURES})`);
      save(id, { retry: { op, count, ...(op === COMPLETION_GATE ? { error: detail } : {}) } });
      return false;
    }
    log.error(`${id}: ${op} failed ${count} ticks in a row (${detail}); stopping`);
    // `onStop.last` is merged into the `last` this builds rather than overwritten by it, and `event` and `at` stay this
    // function's to write either way, because naming the write and the streak is what `gallivant why` reads. The merge
    // was added for the round-comment caller, which had to record the run's exit on the stop and only on the stop
    // because the exit was the registry state the settle re-entered on. It no longer needs it: that caller now records
    // the exit before the comment is attempted at all, so the settle is finished either way. The merge is kept because
    // the ordering it fixes is a real trap for the next caller, and a `last` silently discarded is the harder bug of
    // the two to find; today no caller passes one.
    const { last: stopLast = null, ...rest } = onStop;
    await needsHuman(id, "stuck", {
      ...rest, retry: null,
      last: { ...(entry.last || {}), ...(stopLast || {}), at: now(), event: `${op} failed ${count} ticks in a row: ${detail}` },
    });
    return true;
  }

  // The PRD is read from the daemon's own snapshot taken at start, never from the agent-writable checkout, so a
  // session cannot rewrite its own Verify commands or acceptance criteria. Parsed once per tick per entry.
  const prds = new Map();
  const prdFor = id => {
    if (!prds.has(id)) { const text = readPrd(id); prds.set(id, text ? parsePrd(text, `${id}.md`) : null); }
    return prds.get(id);
  };
  const verifyFor = id => { const p = prdFor(id); return p ? verifyCommands(p) : []; };
  const receiptFor = id => { const p = prdFor(id); return p ? receiptInstructions(criteriaFromPrd(p), id) : null; };

  /**
   * Has the operator edited the brief since this run started, and does it matter?
   *
   * This is the one place the daemon reads the operator's own working tree, and it is worth saying why it reads it at
   * all and why only here.
   *
   * Why the daemon and not only the commands. The tick is the only actor that changes state, and the thing that has to
   * change is an entry stopping before it certifies a stale brief. A comparison that lived only in `status` and `why`
   * would have the daemon finishing the work and opening the PR while the operator's own commands complained about it,
   * which is a warning, not a guard. `status` and `why` compare too, because an operator asking what is going on is
   * exactly when they want to be told, and those run in the operator's own session where reading their tree is
   * unremarkable. Same function, one implementation, three callers.
   *
   * Why only at the gate. `entry.checkout` is a path on the operator's machine, so reading it every `poll_seconds` for
   * every entry is a stat and a parse per entry per two minutes for something that changes a handful of times in a run,
   * and a removable disk or a moved checkout would read as `gone` and stop entries that are perfectly healthy. The
   * moment that matters is the one where the contract is about to be USED to certify something, and that is the
   * readiness judgement: everything before it (a fix round dispatched for a review, a round counted for a push) happens
   * against the brief the session already holds and is not a claim about the brief being satisfied. So the check sits
   * immediately before `gate`, which is also the last point where stopping costs nothing that was not going to be spent
   * anyway.
   *
   * Never throws. A brief the daemon cannot compare is a brief it carries on with, exactly as an entry with no snapshot
   * reaches ready on the checks and the reviewer alone: a failure to read the operator's tree must not be the thing
   * that stops a PR.
   */
  const divergenceFor = (id, entry) => {
    try { return briefDivergence({ id, entry, readPrd, readSource: deps.readSource }); }
    catch (e) { log.warn(`${id}: the brief could not be compared with ${entry.checkout ?? "the operator's checkout"} (${e.message}); carrying on`); return { verdict: "unknown", why: e.message, diff: [] }; }
  };

  const restoreSources = (id, entry) => {
    const displaced = privateOverlayPaths(entry);
    for (const rel of entry.sources ?? []) {
      if (displaced.has(rel)) continue;
      const text = deps.readSource?.(id, rel);
      if (text == null) throw new Error(`${rel}: carried-file snapshot is missing`);
      writeRepositoryText(entry.worktree, rel, text);
    }
  };

  /** The checkout, recreated from the PR branch when it is gone (a lost disk, a cleaned worktrees folder). */
  const ensureWorktree = async (id, entry) => {
    assertRepositoryAccess(capabilitiesFor(entry.harness), (deps.hosts ?? hosts).select(entry).repository);
    if (!git.exists(entry.worktree)) {
      await git.fromBranch({ nameWithOwner: entry.repo, prdId: prdIdFromBranch(entry.branch) ?? prdIdOf(id), branch: entry.branch, path: entry.worktree });
      restoreSources(id, entry);
    }
  };

  /**
   * Bring the base branch into this branch before a session is handed the worktree, so a round of work starts from the
   * current base rather than from wherever the base was when the branch was cut. A branch cut on Monday and fixed on
   * Thursday drifts; a conflict can then enter the bounded repair path.
   *
   * It is a MERGE, not a rebase, and `git.mergeBase` carries the reasoning at the implementation. The short of it: a
   * rebase of a pushed branch needs a force-push, which the RULES every session is given forbid; it would strand the
   * reviewer's clearance, which `reviewerVerdict` grants to a named sha; and the tick itself would read the rewritten
   * head as a stranger's push. A merge moves the head forward instead, so none of the three happens.
   *
   * An outstanding review is NOT a reason to skip it, and that is a consequence of choosing merge over rebase rather
   * than an accident. Every commit the reviewer looked at stays an ancestor of the new head, so their inline comments
   * stay anchored to commits that still exist and their clearance still describes something real. A rebase would have
   * had to wait for the review, which is exactly the deadlock the merge avoids: the reviewer is waiting for a fix and
   * the fix is waiting for the reviewer.
   *
   * The merge commit stays LOCAL until the session pushes, which is what keeps the rest of the loop honest. Nothing on
   * GitHub moves here, so `headChanged` does not see a head the loop did not put there, the reviewer clock is not
   * reset, and the round is still counted from the session's own push in `settleRun`. That push carries the merge with
   * it, as one head move rather than two.
   *
   * The result is SAVED here, the moment it happens, rather than carried to the dispatch's own save. A merge is a
   * durable change to a checkout on disk, and four things after this point can return early (the ready-label write, a
   * busy runner, a missing credential, a refused context_paths): a merge recorded only by that later save would have
   * happened with nothing on the entry to say so, which is exactly what an operator debugging the branch needs.
   *
   * A conflict is recorded before its initial abort. The caller can dispatch
   * repair only after proving that abort succeeded and the checkout is clean.
   */
  async function mergeBaseInto(id, entry, expected = null) {
    // A base is needed to merge one, and an entry can lack one: everything `register` and `reconcile` built before this
    // field existed, and anything they build for a PR whose `baseRefName` could not be read. Nothing to merge is not a
    // failure, it is a round that behaves exactly as every round did before this existed.
    if (!entry.base || !git.mergeBase) return null;
    if (runnerFor(id).current()?.running) return { busy: true };
    if (entry.base_repair && entry.base_repair.status !== "verified") throw repairError("An existing base repair owns this checkout; reconcile its recorded operation before another merge.", "base-repair-ownership");
    const publication = publicationPolicyOf(prdFor(id), { sources: entry.sources || [], base: entry.base });
    let pinned, originalHead;
    if (entry.recovery_profile && git.mergePreview) {
      const checked = await assertRepairCheckout(deps, id, entry, { clean: false });
      originalHead = checked.head;
      if (checked.pending.head || checked.pending.unmerged || checked.pending.other.length)
        throw repairError("An unowned Git operation is in progress. Preserve its index and identify the original writer.", "base-repair-unresolved");
      pinned = await git.fetchBranchHead(entry.worktree, entry.base);
      if (!await git.containsCommit(entry.worktree, pinned, checked.head)) {
        const preview = await git.mergePreview(checked.path, pinned);
        const privatePaths = repairOverlays(deps, id, entry, { required: false }).filter(item => !publication.publishFiles.includes(item.path));
        let collision = false;
        for (const { path } of privatePaths) if (!await git.treeEntry(checked.path, checked.head, path) && await git.treeEntry(checked.path, pinned, path)) collision = true;
        if (preview.conflicts.length || collision)
          return { conflict: true, journalRequired: true, head: checked.head, base: entry.base, baseSha: pinned, why: "Pinned Git conflict or approved context collision" };
      }
    }
    if (git.assertClean) {
      await assertRepairCheckout(deps, id, entry, { clean: false });
      // Resume restores private snapshots after this merge succeeds. A clean
      // recreated branch may lack them; existing copies must still match.
      await git.assertClean(entry.worktree, repairOverlays(deps, id, entry, { required: false }), { allowMissingOverlays: true });
    }
    else if (git.dirty) {
      const tree = await git.dirty(entry.worktree, { strict: true });
      if (tree.modified || tree.untracked) throw repairError("Uncommitted files prevent automatic base merge; preserve and reconcile the checkout before resume.", "base-repair-dirty");
    }
    if (expected) {
      const checked = await assertRepairCheckout(deps, id, entry);
      pinned = await git.fetchBranchHead(checked.path, entry.base);
      originalHead = checked.head;
      if (originalHead !== expected.head || pinned !== expected.base)
        throw repairError("The local task head or GitHub base moved before refresh.", "base-repair-evidence");
    }
    let hook;
    if (entry.recovery_profile && git.repairHook) await refreshRepairHook(id, entry, publication);
    else hook = git.installHooks?.(entry.worktree, publication);
    if (hook && !hook.installed) log.warn(`${id}: the commit-msg hook could not be written into ${entry.worktree} (${hook.why}); local commit checks are unavailable; coordinator publication checks remain mandatory`);
    await git.ensureHttpsRemote?.(entry.worktree, entry.repo);
    const recordConflict = result => save(id, { base_merge: { ...result, at: now() } });
    const r = await git.mergeBase(entry.worktree, entry.base, { onConflict: recordConflict, pinnedBase: pinned, preserveConflict: Boolean(pinned && !expected),
      beforeMerge: pinned ? async () => {
        const current = state.get(id);
        const checked = await assertRepairCheckout(deps, id, current, { clean: false });
        if (checked.head !== originalHead || checked.pending.head || checked.pending.unmerged || checked.pending.other.length ||
            current.last?.run !== entry.last?.run || recoveryHeld(state.load(), id, current) || runnerFor(id).current()?.running)
          throw repairError("Base refresh lost its original branch, head or owner.", "base-repair-ownership");
        await git.assertClean(entry.worktree, repairOverlays(deps, id, current, { required: false }), { allowMissingOverlays: true });
      } : null,
      privateSources: (entry.sources || []).filter(path => !publication.publishFiles.includes(path)),
      overlays: entry.recovery_profile ? [] : repairOverlays(deps, id, entry, { required: false }) });
    if (r?.conflict) { recordConflict(r); return r; }
    if (r?.merged) {
      log.info(`${id}: merged origin/${entry.base} into ${entry.branch} before the run (${r.sha ? r.sha.slice(0, 7) : "merge commit"})`);
      save(id, { base_merge: { at: now(), base: r.base, sha: r.sha ?? null, onto: r.head ?? null, ...(expected ? { baseSha: pinned } : {}) } },
        expected ? { durable: true } : undefined);
    }
    return r;
  }

  async function refreshDeferredBase(id, entry, pr, ci) {
    try {
      const pilot = pilotFor(entry);
      const expected = { head: pr.headRefOid, base: ci.base };
      await deps.deferredCI.live(deps, pilot);
      const checked = await assertRepairCheckout(deps, id, entry);
      let head = checked.head;
      if (head === expected.head) {
        const result = await mergeBaseInto(id, entry, expected);
        if (result?.conflict) { await repairBaseConflict(id, entry, pr, result); return; }
        if (!result?.merged) return;
        head = result.sha;
      } else {
        const saved = state.get(id).base_merge;
        if (saved?.sha !== head || saved.onto !== expected.head || saved.baseSha !== expected.base)
          throw repairError("Preserve the local work and reconcile it with the observed PR before refreshing the base.", "base-repair-ownership");
      }
      await git.pushRepair(entry.worktree, entry.branch, head, entry.repo, async () => {
        const current = state.get(id), fresh = await host.prView(entry.repo, entry.pr);
        deps.deferredCI.owned(deps, pilot, { active: true });
        if (recoveryHeld(state.load(), id, current) || current.dispatch_stopped || controlPending(current.control) ||
          fresh.state !== "OPEN" || fresh.isDraft !== false || fresh.headRefOid !== expected.head || fresh.baseRefOid !== expected.base ||
          observedIdentityProblem(current, { ...fresh, strictIdentity: true })) throw repairError("The live candidate moved before pushing the base refresh.", "base-repair-evidence");
      });
      // Observe the new head and ordinary re-review window on the next pass.
      save(id, { state: STATES.prOpen, review_next_at: 0 });
    } catch (error) {
      save(id, { ciProgress: { ...ci, phase: "blocked", next: ciErrorText(error,
        isBaseRepairError(error) ? error.message : "Inspect the preserved workspace and reconcile the exact base refresh.") } });
    }
  }

  const repairInvalidation = entry => ({ state: STATES.prOpen, reason: null, gate_skipped: null, review_readiness: null,
    reviewBinding: null, reviewHead: null, firstPartyReview: null, reviewObservation: null, ci_grace: null, publicationProof: null,
    reviewHistory: [...(entry.reviewHistory || []), ...(entry.firstPartyReview ? [entry.firstPartyReview] : [])],
    ...(entry.completionEvidence?.delivery ? { completionEvidence: { ...entry.completionEvidence, delivery: { ...entry.completionEvidence.delivery, invalidatedAt: now(), invalidationReason: "base repair requires new-head verification" } } } : {}) });

  async function stopRepair(id, error, patch = {}) {
    const entry = state.get(id), op = entry.base_repair;
    if (recoveryDispatchDeferred(error) && op?.journal && op.charged === false && !op.run &&
        ["planned", "merging", "pending"].includes(op.journal.phase)) {
      await retryFailed(id, entry, "repair preflight", error, { action: "retrying the original journal on the next poll" });
      return;
    }
    const journaled = Boolean(op?.journal || entry.recovery_profile);
    let detail = journaled && !isBaseRepairError(error) && !["RECOVERY_AUTHORITY", "AUTHOR_PREFLIGHT", "EXECUTION_VERIFICATION_SANDBOX"].includes(error.code)
      ? `Repair stopped (${error.code || "proof unavailable"}). Preserve the journal and inspect the original Git or verification operation.` : error.message;
    if (journaled && error.code === "ENOSPC") detail = "Restore free bytes and inodes on the state and checkout mounts, then Recheck the original operation.";
    const reason = error.code === "PACKAGE_AUTH" ? "dependency-auth" : isBaseRepairError(error) ? error.code : "base-repair-prerequisite";
    if (journaled && entry.state === STATES.needsHuman && entry.reason === reason && entry.recovery_wait?.reason === detail &&
        !entry.labels_pending && Object.entries(patch).every(([key, value]) => isDeepStrictEqual(entry[key], value))) return;
    await needsHuman(id, reason, {
      ...(op && op.status !== "verified" ? { base_repair: { ...op, status: "blocked", failure: detail } } : {}),
      ...(journaled ? { recovery_wait: { phase: "blocked-authority", reason: detail }, ...(error.code === "ENOSPC" ? { resource: { code: "ENOSPC" } } : {}) } : {}),
      last: { ...entry.last, event: detail }, ...patch,
    });
  }

  async function refreshRepairHook(id, entry, policy, guard = () => {}) {
    const prd = prdFor(id), approval = turnBinding(deps, id, entry, prd);
    const recheck = () => {
      const current = state.get(id);
      if (turnBinding(deps, id, current, prd) !== approval || current.last?.run !== entry.last?.run ||
          current.dispatch_stopped || current.repository_disabled || current.hold?.active)
        throw repairError("Accepted hook revision or workspace ownership changed during installation.", "base-repair-ownership");
      guard();
    };
    const prior = entry.hook_policy?.approval === approval ? entry.hook_policy.digest : null;
    const digest = await git.repairHook(realpathSync(entry.worktree), policy, prior, recheck);
    recheck();
    save(id, { hook_policy: { digest, approval } });
    return digest;
  }

  async function launchJournalRepair(id, entry, pr, op, plan) {
    await requireVerificationSandbox({ sandbox: deps.repairVerification?.sandbox });
    await git.authorStorage?.(entry.worktree, deps.home || config.home);
    await requireAuthorRoute(deps, id, entry, plan.guard, { run: runnerFor(id).current() });
    op = await resumeJournalPreparation(deps, id, op, plan);
    const policy = ownedRepairPolicy(deps, id, entry, op);
    const prompt = baseRepairPrompt({ repo: entry.repo, pr: entry.pr, branch: entry.branch, prd: entry.prd,
      carried: entry.sources, operation: op, verify: repairVerifyCommands(deps, id), host: (deps.hosts ?? hosts).select(entry).adapter.prompts });
    const started = await startRun(id, state.get(id), { name: op.journal.kind, prompt, recovery: plan, repairPolicy: policy,
      operationId: op.operationId, ownership: { state: STATES.prOpen, reason: null, lastEvent: "continued the journaled repair" },
      dispatchGuard: () => {
        if (op.journal.phase !== "author") return;
        if (!isDeepStrictEqual(op, state.get(id).base_repair)) throw repairError("The journal changed at the execution boundary.", "base-repair-ownership");
        git.guardRepairMetadata(realpathSync(entry.worktree), op.journal.manifest);
      },
      beforeDispatch: async () => {
        const observed = await host.prView(entry.repo, entry.pr);
        if (observedIdentityProblem(entry, { ...observed, strictIdentity: true }) || observed.state !== "OPEN" || observed.headRefOid !== op.head ||
            observed.baseRefName !== op.base || observed.headRefName !== op.branch)
          throw repairError("The PR head or target changed before repair dispatch.", "base-repair-ownership");
        op = await resumeJournalPreparation(deps, id, op, plan);
        op = recordRepair(deps, id, op, { status: "dispatching", journal: { ...op.journal, phase: "author" } });
      } });
    const { job, session, managed } = started;
    op = recordRepair(deps, id, op, { status: "running", charged: true, run: job.id });
    save(id, { ...repairInvalidation(state.get(id)), retry: null, recovery_wait: null, iteration: op.round, session,
      ...(job.execution ? { execution: job.execution } : {}), ...learningDeliveryPatch(entry, managed, job),
      last: { at: now(), run: job.id, exit: null, event: "continued the journaled repair" } });
    await learningDelivered({ ...deps, learning }, id);
    return { id, run: job.id, session, worktree: entry.worktree };
  }

  async function beginJournalRepair(id, entry, pr, baseSha, ci = null) {
    try {
      if (recoveryHeld(state.load(), id, entry)) return;
      if (pr.baseRefOid && pr.baseRefOid !== baseSha)
        throw repairError("Host and Git disagree on the current base SHA. Recheck before pinning a repair.", "base-repair-evidence");
      if (entry.iteration >= iterationLimit(id, entry)) throw repairError("The task iteration allowance is exhausted. Inspect the original failure.", "base-repair-iterations");
      const wasReady = entry.state === STATES.ready;
      await reopen(id, entry);
      entry = state.get(id);
      if (wasReady) entry = save(id, repairInvalidation(entry));
      const { op, plan } = await prepareJournalRepair(deps, id, entry, pr, { baseSha, ci, at: now(),
        planFor: (recipe, cause, input) => authorPlan(id, entry, recipe, cause, input) });
      await deps.reviewService?.cancel?.(id, "new repair requires current-head verification");
      return await launchJournalRepair(id, entry, pr, op, plan);
    } catch (error) {
      await stopRepair(id, error);
    }
  }

  async function launchBaseRepair(id, entry, pr, op, { controlId = null } = {}) {
    const runner = runnerFor(id);
    await reopen(id, entry);
    await deps.reviewService?.cancel?.(id, "base repair invalidates previous review input");
    entry = save(id, { ...repairInvalidation(entry), retry: null });
    const prompt = baseRepairPrompt({ repo: entry.repo, pr: entry.pr, branch: entry.branch, prd: entry.prd,
      carried: entry.sources || [],
      privateOverlays: repairOverlays(deps, id, entry)
        .filter(input => !input.publishedOutput)
        .map(({ path, text }) => ({ path, sha256: contentDigest(text) })),
      operation: op, verify: verifyFor(id), receipt: receiptFor(id), host: (deps.hosts ?? hosts).select(entry).adapter.prompts });
    const started = await startRun(id, entry, { name: "base-repair", prompt, baseRepair: op, controlId,
      ownership: { state: STATES.prOpen, reason: null, lastEvent: "repair pinned base conflict" },
      beforeDispatch: async () => {
        const current = state.get(id);
        assertRepairIdentity(id, current, current.base_repair);
        const checked = await assertRepairPrerequisites(deps, id, current, pr);
        const latest = state.get(id);
        assertRepairIdentity(id, latest, latest.base_repair);
        if (latest.base_repair.operationId !== op.operationId || latest.state !== STATES.prOpen ||
            checked.head !== (op.mergeSha || op.head) || runner.current()?.running || !controlAllowsRepair(latest.control, controlId)) throw repairError("Checkout or run ownership changed before repair dispatch; reconcile the saved operation.", "base-repair-ownership");
      } });
    const { job, session, managed } = started;
    // No await after acceptance until the operation owns its run in state.
    entry = save(id, { base_repair: { ...op, status: "running", charged: true, run: job.id }, iteration: op.round,
      session, ...(job.execution ? { execution: job.execution } : {}), ...learningDeliveryPatch(entry, managed, job),
      last: { at: now(), run: job.id, exit: null, event: "repair pinned base conflict" } });
    await learningDelivered({ ...deps, learning }, id).catch(error => log.warn(`${id}: accepted repair delivery audit pending (${error.message})`));
    return { id, run: entry.last.run, session: entry.session, worktree: entry.worktree };
  }

  // One operation per exact input pair. Persist intent and the conservative
  // iteration reservation before I/O; a refused/ambiguous launch never retries
  // as another paid operation or erases the original failed merge.
  async function repairBaseConflict(id, entry, pr, failed = null, { intent = null, controlId = null, note = null } = {}) {
    const explicit = intent !== null;
    if (explicit) requireOperatorIntent(intent, state, id, "resume");
    if (entry.recovery_profile) {
      if (entry.base_repair && entry.base_repair.status !== "verified") return;
      if (explicit) throw repairError("Use Recheck to let the coordinator reconcile the qualified recovery operation.", "base-repair-ownership");
      try {
        const baseSha = failed?.baseSha || await git.fetchBranchHead(entry.worktree, entry.base);
        return await beginJournalRepair(id, entry, pr, baseSha);
      } catch (error) { await stopRepair(id, error); return; }
    }
    const runner = runnerFor(id);
    if (entry.dispatch_stopped || !controlAllowsRepair(entry.control, controlId) || runner.current()?.running || entry.last?.run && entry.last.exit == null) return;
    if (![STATES.prOpen, STATES.ready].includes(entry.state) && !(explicit && entry.state === STATES.needsHuman)) return;
    try {
      await assertRepairPrerequisites(deps, id, entry, pr);
      if (!runner.state?.()?.operations) throw repairError("Repair requires the durable task execution ledger. Restore its recorded runner before retrying.", "base-repair-ownership");
      if (!entry.last?.run || runner.current()?.id !== entry.last.run) throw repairError("Repair requires the recorded settled task run. Reconcile the current execution owner before retrying; no second worker was started.", "base-repair-ownership");
      if (entry.base_repair && entry.base_repair.status !== "verified") throw repairError("The recorded base repair must be reconciled before another operation; inspect its failure and owned run.", "base-repair-duplicate");
      if (entry.iteration >= iterationLimit(id, entry)) throw repairError("Base repair stopped: the existing iteration limit is exhausted. Review the saved failure and allowance before explicitly resuming.", "base-repair-iterations");
      if (!failed) {
        failed = await mergeBaseInto(id, entry);
        if (failed?.busy) return;
        if (!failed?.conflict && !failed?.merged) throw repairError("The host reports a conflict but Git already contains the fetched base. Recover a consistent PR/base observation before repair.", "base-repair-evidence");
      }
      if (failed.overlayConflict) throw repairError(`The approved private inputs ${failed.overlayPaths.join(", ")} were restored after aborting a conflicting base merge. Automatic worker repair cannot repeat this merge without overwriting those inputs. Preserve the checkout and use an operator-owned merge that keeps approved working copies out of its commit; then resume the same task. No repair worker was dispatched.`, "base-repair-overlay");
      entry = state.get(id);
      const op = { version: 1, taskId: id, repo: entry.repo, branch: entry.branch, base: entry.base, worktree: entry.worktree,
        session: entry.session, harness: entry.harness, head: failed.head, baseSha: failed.baseSha,
        key: repairKey(failed.head, failed.baseSha), operationId: repairOperation(id, failed.head, failed.baseSha),
        round: entry.iteration + 1, provenance: explicit ? "operator" : "automatic", status: "prepared", at: now(), run: null, charged: false, previousRun: entry.last?.run ?? null,
        why: failed.why || "host reported a conflicting PR", ...(failed.merged ? { mergeSha: failed.sha } : {}),
        ...(note ? { operatorNote: note } : {}) };
      assertRepairIdentity(id, entry, op);
      if ((entry.base_repair_attempts || []).includes(op.key)) throw repairError(`Base repair input ${op.key} was already attempted. Preserve the checkout and inspect the original operation; automatic redispatch is refused.`, "base-repair-duplicate");
      if (failed.aborted === false) throw repairError(`Initial merge abort failed: ${failed.abortError}. Preserve the index and resolve the owned checkout explicitly before resume.`, "base-repair-unresolved");
      const checkout = await assertRepairCheckout(deps, id, entry);
      if (checkout.head !== (op.mergeSha || op.head) || op.head !== pr.headRefOid) throw repairError("Local task head differs from the observed PR or recorded conflict. Reconcile unpushed work before repair.", "base-repair-ownership");
      entry = save(id, { base_repair: op, base_repair_attempts: [...(entry.base_repair_attempts || []), op.key] });
      return await launchBaseRepair(id, entry, pr, op, { controlId });
    } catch (error) {
      if ((!state.get(id).base_repair || state.get(id).base_repair.status === "verified") && !isBaseRepairError(error) && !/unsupported|qualified|permission|credential/i.test(error.message)) {
        await retryFailed(id, state.get(id), "base merge", error, { action: "retrying Git/host observation without a repair dispatch" });
      } else await stopRepair(id, error);
    }
  }

  async function reconcileBaseRepair(id, entry) {
    const op = entry.base_repair;
    if (!op || op.status === "verified") return false;
    if (op.status === "blocked" && op.journal?.phase !== "author") return false;
    if (op.journal && !["author", "committing", "candidate", "verifying", "verified", "pushing"].includes(op.journal.phase)) return false;
    try {
      assertRepairIdentity(id, entry, op);
      const run = runnerFor(id).current();
      if (op.status === "blocked" && (!repairRunMatches(id, entry, run) || entry.last?.run === run.id && entry.last.exit != null)) return false;
      await assertRepairCheckout(deps, id, entry, { clean: false });
      if (!repairRunMatches(id, entry, run)) {
        if (op.journal && !entry.recovery_actions?.intents?.[op.journal.intent]?.operation && run?.id === op.previousRun) return false;
        throw repairError("Repair launch ownership is unproved. Inspect the recorded execution operation and restore its exact session; no replacement was started and the worktree is intact.", "base-repair-ownership");
      }
      if (op.journal) acceptedRecovery(state, id, run.execution.recoveryIntent, run.execution.operationId, "resumed");
      if (entry.last?.run !== run.id || op.run !== run.id || op.status === "blocked") save(id, {
        ...(op.journal ? { ...repairInvalidation(entry), recovery_wait: null } : {}),
        base_repair: { ...op, run: run.id, status: "running", charged: true },
        iteration: Math.max(entry.iteration, op.round), last: { at: now(), run: run.id, exit: null, event: "recovered pinned base repair" },
      }, op.journal ? { durable: true } : undefined);
      return false;
    } catch (error) {
      if (isBaseRepairError(error)) await stopRepair(id, error);
      else await retryFailed(id, entry, "base repair ownership proof", error, { action: "retrying read-only ownership checks without redispatch",
        onStop: { base_repair: { ...op, status: "blocked", failure: error.message } } });
      return true;
    }
  }

  async function finalizeRepairPush(id, entry, pr, last, proof, { operatorReconciled = false, assertOwner, intent = null }) {
    const pushedAt = await headPushedAt(entry, proof.remoteSha, now());
    assertOwner();
    const progress = { kind: "verified-push", at: now(), head: proof.remoteSha };
    if (intent) {
      try { requireOperatorIntent(intent, state, id, "resume"); }
      catch (error) {
        // A verified remote push remains evidence after operator authority changes.
        state.update(id, current => current.base_repair?.operationId === entry.base_repair.operationId &&
          current.last?.run === last.run ? { verified_progress: progress } : {});
        throw error;
      }
    }
    save(id, { ...repairInvalidation(entry), retry: null, last, network_retry: null, verified_progress: progress,
      base_repair: { ...entry.base_repair, ...proof, status: "verified", verifiedAt: now(), failure: null,
        ...(operatorReconciled ? { operatorReconciledAt: now() } : {}) },
      cursor: { ...entry.cursor, fixed_sha: proof.remoteSha, checks_sha: null, receipt_hash: receiptHash(pr.body) },
      rereview: { at: askedAt(entry, pushedAt), nudged: false },
      round_comment: { kind: "round", since: fetchFrom(entry.base_repair.at), pushed_at: pushedAt } });
  }

  async function settleBaseRepair(id, entry, pr, last, outcome, { intent = null } = {}) {
    if (entry.base_repair.journal) return settleJournalRepair(id, entry, pr, last, outcome);
    const operationId = entry.base_repair.operationId;
    const succeeded = outcome.ok && last.exit === 0;
    const override = succeeded ? null : intent;
    try {
      const expectedRun = runnerFor(id).current()?.id;
      const assertOwner = () => {
        const current = state.get(id), run = runnerFor(id).current();
        assertRepairIdentity(id, current, entry.base_repair);
        if (current.base_repair?.operationId !== operationId || current.last?.run !== entry.last?.run || current.pr !== entry.pr || run?.id !== expectedRun ||
            current.state === STATES.done || current.dispatch_stopped || run?.running || !repairRunMatches(id, current, run)) throw repairError("Repair result does not belong to a settled recorded operation/session. Preserve the checkout and restore matching execution evidence.", "base-repair-ownership");
      };
      assertOwner();
      const proof = await proveRepairPush(deps, id, entry, pr, {
        assertOwner, restorePrivate: succeeded || !!override,
        authorizeRestore: override ? () => requireOperatorIntent(override, state, id, "resume") : undefined,
      });
      if (!succeeded && !override) throw repairError("Repair worker failed even though commits may have been pushed. Inspect its owned run log and verification results before explicitly resuming; no automatic retry is authorized.", "base-repair-failed");
      await finalizeRepairPush(id, entry, pr, last, proof, { assertOwner, intent: override });
      return true;
    } catch (error) {
      if (error.code === "OPERATOR_INTENT") throw error;
      const current = state.get(id);
      if (current?.state === STATES.done || current?.dispatch_stopped || current?.base_repair?.operationId !== operationId ||
          current?.last?.run !== entry.last?.run || ["repo", "branch", "base", "worktree", "session", "harness", "pr"].some(key => current?.[key] !== entry[key])) return false;
      if (!isBaseRepairError(error)) {
        await retryFailed(id, entry, "base repair proof", error, { action: "retrying remote ancestry proof without redispatch",
          onStop: { last, base_repair: { ...entry.base_repair, status: "blocked", failure: error.message } } });
      } else await stopRepair(id, error, { last: { ...last, event: error.message } });
      return false;
    }
  }

  async function settleJournalRepair(id, entry, pr, last, outcome) {
    const runner = runnerFor(id), run = runner.current();
    let op = entry.base_repair;
    const guard = () => guardJournalRepair(deps, id, op, { author: true });
    const reject = (message, code = "base-repair-verify") => repairError(message, code);
    try {
      const path = realpathSync(entry.worktree);
      guard();
      const ex = run?.execution;
      if (!outcome.ok || last.exit !== 0 || run.exit !== 0 || ex?.cancellation || ex?.providerState !== "succeeded" || !ex?.collected)
        throw reject("The original author did not finish successfully. Inspect its run and preserve any partial resolutions and staged files.", "base-repair-failed");
      if (pr.state !== "OPEN" || observedIdentityProblem(entry, { ...pr, strictIdentity: true }))
        throw reject("The PR identity or target changed. Preserve the pinned operation and reconcile the PR.", "base-repair-ownership");
      const policy = ownedRepairPolicy(deps, id, entry, op);
      op = await finishStagedRepair(deps, id, op);
      const current = await proveRepairCandidate(deps, id, entry, op);
      const head = current.head;
      if (!["author", "committing", "candidate", "verified", "pushing"].includes(op.journal.phase) ||
          op.journal.candidate && op.journal.candidate.fingerprint !== current.fingerprint)
        throw reject("Candidate verification was interrupted or its index changed. Inspect the recorded verification before publication.");
      if (["author", "committing"].includes(op.journal.phase)) {
        guard();
        op = recordRepair(deps, id, op, { journal: { ...op.journal, phase: "candidate", candidate: current, verification: [] } });
      }
      const candidateGuard = async () => {
        await git.repairHook(path, policy, null, guard, { refresh: false });
        const manifest = await git.repairManifest(path);
        if (manifest.fingerprint !== op.journal.candidate.fingerprint)
          throw reject("Verified worktree, index or branch changed. Reconcile the exact candidate before pushing.");
        guard();
      };
      const commands = repairVerifyCommands(deps, id);
      if (op.journal.phase === "candidate") {
        const remote = await git.fetchBranchHead(path, op.branch);
        if (remote !== op.head || pr.headRefOid !== op.head) throw reject("Remote task head moved before coordinator verification.", "base-repair-push");
        await candidateGuard();
        op = recordRepair(deps, id, op, { journal: { ...op.journal, phase: "verifying" } });
        await verifyRepair({ root: dirname(state.file), worktree: path, head, commands, guard: candidateGuard,
          record: item => { op = recordRepair(deps, id, op, { journal: { ...op.journal, verification: [...op.journal.verification, item] } }); },
          ...deps.repairVerification });
        op = recordRepair(deps, id, op, { journal: { ...op.journal, phase: "verified" } });
      }
      if (!commands.length || commands.length !== op.journal.verification.length || op.journal.verification.some((item, index) =>
        item.head !== head || item.index !== index || item.exit !== 0 || item.command !== reviewDigest(commands[index])))
        throw reject("The candidate lacks a complete successful receipt for the exact approved Verify contract.");
      const exclusion = acquirePublicationLock(deps, id, { execution: runner, ownsExecution: true });
      try {
        await candidateGuard();
        if (op.journal.phase === "verified") {
          if (await git.fetchBranchHead(path, op.branch) !== op.head) throw reject("Remote task head changed. Inspect the existing push and preserve local work.", "base-repair-push");
          const latest = await host.prView(entry.repo, entry.pr);
          if (latest.state !== "OPEN" || observedIdentityProblem(entry, { ...latest, strictIdentity: true }) || latest.headRefOid !== op.head)
            throw reject("The PR head or target changed before publishing.", "base-repair-push");
          await candidateGuard();
          op = recordRepair(deps, id, op, { journal: { ...op.journal, phase: "pushing" } });
          await git.pushRepair(path, op.branch, head, entry.repo, candidateGuard);
        }
        const remote = await git.fetchBranchHead(path, op.branch);
        const observed = await host.prView(entry.repo, entry.pr);
        if (remote !== head || observed.headRefOid !== head || observed.state !== "OPEN" || observedIdentityProblem(entry, { ...observed, strictIdentity: true }))
          throw reject("Push acknowledgement is unresolved. Inspect the exact task ref and PR; no push will be replayed.", "base-repair-push");
        await candidateGuard();
        const pushedAt = await headPushedAt(entry, remote, now());
        guard();
        const latest = state.get(id);
        const overlays = new Map((latest.recovery_overlays ?? []).map(item => [item.move.path, item]));
        for (const move of op.journal.overlays) overlays.set(move.path, { directory: op.journal.id, move });
        state.update(id, { ...repairInvalidation(latest), last, retry: null, recovery_wait: null, network_retry: null,
          base_repair: { ...op, status: "verified", failure: null, repairSha: head, remoteSha: remote, verifiedAt: now(),
            journal: { ...op.journal, phase: "published" } },
          recovery_overlays: [...overlays.values()],
          hook_policy: { digest: op.journal.hook, approval: op.journal.approval },
          verified_progress: { kind: "verified-push", at: now(), head: remote },
          cursor: { ...latest.cursor, fixed_sha: remote, checks_sha: null, receipt_hash: receiptHash(observed.body) },
          rereview: { at: askedAt(latest, pushedAt), nudged: false }, round_comment: { kind: "round", since: fetchFrom(op.at), pushed_at: pushedAt },
        }, { durable: true });
        if (!op.journal.ci) verifyRecoveryOutcome(state, id, ex, "git-repair", [op.head, op.baseSha, remote, op.journal.verification]);
      } finally { exclusion.release(); }
      return true;
    } catch (error) {
      await stopRepair(id, error, { last });
      return false;
    }
  }

  async function observeJournalRepair(id, entry, pr) {
    let op = entry.base_repair;
    if (!op?.journal || op.status === "verified") return false;
    const run = runnerFor(id).current(), journal = op.journal;
    if (["committing", "candidate", "verified", "pushing"].includes(journal.phase) && entry.last?.exit === 0 && repairRunMatches(id, entry, run)) {
      await settleJournalRepair(id, entry, pr, entry.last, { ok: true });
      return true;
    }
    if (journal.phase === "author" && entry.recovery_actions?.intents?.[journal.intent]?.operation ||
        !["planned", "merging", "pending", "author"].includes(journal.phase)) return true;
    try {
      if (pr.headRefOid !== op.head || observedIdentityProblem(entry, { ...pr, strictIdentity: true }))
        throw repairError("The PR no longer matches the journaled branch and head.", "base-repair-ownership");
      const plan = authorPlan(id, entry, journal.kind, journal.cause, journal.input);
      if (journal.phase === "author") {
        guardJournalRepair(deps, id, op);
        if (runnerFor(id).state?.()?.operations?.[op.operationId]) throw repairError("Observe the recorded original submission.", "base-repair-ownership");
        op = recordRepair(deps, id, op, { status: "prepared", journal: { ...journal, phase: "pending" } });
      }
      await launchJournalRepair(id, entry, pr, op, plan);
    } catch (error) { await stopRepair(id, error); }
    return true;
  }

  async function resumeBaseRepair(id, entry, { intent, controlId = null, note = null } = {}) {
    requireOperatorIntent(intent, state, id, "resume");
    if (!controlAllowsRepair(entry.control, controlId)) throw repairError("Another operator request owns this repair; wait for its result before resuming.", "base-repair-ownership");
    const runner = runnerFor(id), run = runner.current();
    if (run?.running) throw repairError("Repair run still needs settling; wait for its recorded worker before resume.");
    assertRepairIdentity(id, entry, entry.base_repair);
    const op = entry.base_repair, ledger = runner.state?.();
    if (op.journal) throw repairError("Recheck the existing journal to continue its original operation. Inspect its stop and author result before any new request.", "base-repair-ownership");
    const pr = await host.prView(entry.repo, entry.pr);
    // Only an explicit resume may retry a proven pre-dispatch refusal. The same
    // operation ID is retained; an ambiguous/paid launch cannot use this path.
    if (op.charged === false && !op.run && ledger && !ledger.operations[op.operationId] &&
        op.previousRun === entry.last?.run && run?.id === op.previousRun) {
      const head = await git.head(entry.worktree);
      // A clean merge recorded before dispatch refusal may now be pushed exactly
      // as recorded. Reconcile that proof; an unpushed merge still needs its run.
      if (head !== (op.mergeSha || op.head) || (op.mergeSha === head && pr.headRefOid === head)) {
        const assertOwner = () => {
          const current = state.get(id), currentRun = runner.current(), currentLedger = runner.state?.(), ex = currentRun?.execution;
          assertRepairIdentity(id, current, op);
          if (current.state === STATES.done || current.dispatch_stopped || !controlAllowsRepair(current.control, controlId) || current.base_repair?.operationId !== op.operationId || current.base_repair?.charged !== false || current.base_repair.run ||
              current.last?.run !== op.previousRun || current.last.exit == null || currentRun?.id !== op.previousRun || currentRun.running ||
              !currentLedger || currentLedger.operations[op.operationId] || ex?.taskId !== id || ex.provider !== entry.harness ||
              ex.sessionId !== entry.session || ex.acceptance !== "accepted" || ex.quarantined || !ex.collected ||
              !["succeeded", "failed", "cancelled"].includes(ex.providerState)) throw repairError("Prepared repair has no settled matching previous execution owner; preserve its ledger before reconciliation.", "base-repair-ownership");
          requireOperatorIntent(intent, state, id, "resume");
        };
        assertOwner();
        const proof = await proveRepairPush(deps, id, entry, pr, { assertOwner });
        assertOwner();
        await finalizeRepairPush(id, entry, pr, { ...entry.last, event: "Operator reconciled the pushed base repair without another run" }, proof, { operatorReconciled: true, assertOwner });
        return { id, reconciled: true, run: null, session: entry.session, worktree: entry.worktree };
      }
      const checkout = await assertRepairPrerequisites(deps, id, entry, pr);
      if (checkout.head !== (op.mergeSha || op.head) || pr.headRefOid !== op.head || entry.iteration !== op.round - 1 || entry.iteration >= iterationLimit(id, entry)) throw repairError("Prepared repair input or iteration allowance changed; preserve the recorded operation and reconcile it explicitly.");
      await requireHarness(entry.harness, config);
      requireOperatorIntent(intent, state, id, "resume");
      if (!isDeepStrictEqual(state.get(id).base_repair, op)) throw repairError("Prepared repair ownership changed before dispatch.", "base-repair-ownership");
      const resumed = note ? { ...op, operatorNote: note } : op;
      if (resumed !== op) entry = save(id, { base_repair: resumed });
      try { return await launchBaseRepair(id, entry, pr, resumed, { controlId }); }
      catch (error) { await stopRepair(id, error); throw error; }
    }
    if (!repairRunMatches(id, entry, run)) throw repairError("Repair execution ownership is unknown; restore its original ledger/session before resume. No second operation is authorized.");
    // An identity stop may precede settlement. After the operator restores the
    // exact owner, retain the terminal outcome before reconciling its push.
    let last = entry.last;
    if (last?.exit == null) {
      const outcome = runner.outcome(run.id), job = runner.settle(run.id, () => outcome.ok ? 0 : 1);
      last = { ...last, run: run.id, exit: job.exit, cost: outcome.cost, denials: outcome.denials };
    }
    // Explicit resume after operator reconciliation can accept a previously
    // failed worker's repaired/pushed result; the normal review gate still runs.
    if (!await settleBaseRepair(id, entry, pr, last, { ok: last.exit === 0 }, { intent })) throw repairError(state.get(id).last.event);
    return { id, reconciled: true, run: run.id, session: entry.session, worktree: entry.worktree };
  }

  /**
   * Post one of the daemon's marked comments unless it is already there. The comment goes to GitHub before the
   * registry is saved, so a crash in between leaves a comment, not a lost one; the check makes the retry harmless.
   */
  async function commentOnce(entry, body, marker, sinceIso) {
    const own = await host.issueComments(entry.repo, entry.pr, sinceIso);
    if (hasOwnComment(own, loginFor(entry), marker, sinceIso)) return false;
    await host.comment(entry.repo, entry.pr, body);
    return true;
  }

  /**
   * The one way out of ready and back to watching. An entry is ready because a particular head was judged: checks
   * green on it, the reviewer clear on it, its receipt accepted. Anything that makes that judgement no longer about
   * the current state of the PR puts the entry back in pr-open with the label off, so the next tick judges again.
   *
   * Two things do that, and they go through here for the same reason rather than each dropping the label its own
   * way: a new qualifying event (`dispatch` reopens before it spawns anything) and a new head (`headChanged` reopens
   * before the entry is judged). Removal is unconditional, as in `needsHuman`: a label from an earlier daemon
   * outlives the registry, and `removeLabel` already ignores a label that is not there.
   *
   * The write is allowed to throw, and `removeLabel` throws by default, which is the whole reason this works. Both
   * callers have work after it that must not happen while the PR still says a human may merge, so a failure here is
   * the whole step declining and the next tick asking again from an untouched cursor. A transient GitHub is a tick of
   * nothing, not a run nobody recorded. This call used to omit the then-optional `strict` flag that its sibling in
   * `writeStopLabels` passed, so a GitHub that refused the write resolved as if the label had been absent: the
   * dispatch went ahead with `ready-for-human` still on the PR and `retryFailed` never saw the failure at all.
   */
  async function reopen(id, entry) {
    if (entry.state !== STATES.ready) return;
    if (entry.reviewPolicy?.version === 1) {
      save(id, { state: STATES.prOpen, review_readiness: null, review_label_pending: true,
        ...(entry.completionEvidence?.delivery ? { completionEvidence: { ...entry.completionEvidence, delivery: { ...entry.completionEvidence.delivery, invalidatedAt: now(), invalidationReason: "review readiness reopened" } } } : {}) });
    }
    await host.removeLabel(entry.repo, entry.pr, READY_LABEL);
    if (entry.reviewPolicy?.version === 1) save(id, { review_label_pending: false });
    // `gate_skipped` describes the ready state it was recorded with, so it goes as the ready state goes. Left behind,
    // `status` and `why` would keep warning about a gate that did not run for a head nobody is being asked to merge.
    if (entry.gate_skipped) save(id, { gate_skipped: null });
  }

  /**
   * A head the loop did not put there: a human or a bot pushed while the entry was being watched. One place for it,
   * reached by both watching states, because the bookkeeping it has to reset is the same in both and the previous
   * version of this guard existed only for `ready`. That asymmetry is the shape the audits keep naming, and it cost
   * `pr-open` two things. `fixed_sha` kept describing the commit the loop last acted on, so the NEW head was judged
   * with the OLD head's age: the same tick that noticed the push could stop the entry as `reviewer-silent` on a wait
   * that expired before the commit existed. And `rereview.nudged` stayed true, so the nudge that was spent on the
   * old head was never reissued for this one, and nobody ever asked the reviewer to look at it.
   *
   * What resets, and why each: `fixed_sha` follows the head, as it does on a dispatch, so a later fix run is judged
   * against this commit and not the one before it. The reviewer clock follows the push, because the reviewer has not
   * seen this commit; `reviewerClock` is what keeps that from becoming the opposite bug, since a committer date older
   * than the nudge window is floored to the window rather than taken literally (a commit made on Monday and pushed on
   * Thursday would otherwise stop the entry on arrival). `nudged` goes false so the silence step asks again. Nothing
   * is posted and the iteration is untouched: this was not a round of the loop's own, so the re-review is asked for
   * through the nudge the silence step already owns.
   *
   * A `ready` entry also leaves ready, through `reopen`: its verdict, its green checks and its accepted
   * receipt all describe a commit that is no longer the head, so the label saying a human may merge comes off first.
   * Returns the saved entry when the head changed, `"declined"` when the label write failed, else null. A failed write
   * leaves the whole judgement for the next tick rather than judging a new head with a stale ready label still on the
   * PR, and it goes through `retryFailed` for the same reason the dispatch does: the third caller of the same declining
   * write is the third place that would otherwise wait forever, so it counts on the same counter and stops with the
   * same reason.
   */
  async function headChanged(id, entry, pr) {
    if (entry.state !== STATES.ready && entry.state !== STATES.prOpen) return null;
    if (!entry.cursor.fixed_sha || pr.headRefOid === entry.cursor.fixed_sha) return null;
    const wasReady = entry.state === STATES.ready;
    if (wasReady) {
      try { await reopen(id, entry); }
      catch (e) {
        await retryFailed(id, entry, READY_LABEL_REMOVAL, e, { action: `not judging ${pr.headRefOid.slice(0, 7)} until it is off` });
        return "declined";
      }
      entry = retryOk(id, entry);
    }
    const pushedAt = await headPushedAt(entry, pr.headRefOid, now());
    const saved = save(id, {
      state: STATES.prOpen, gate_skipped: null, retry: null,
      verified_progress: { kind: "verified-push", at: now(), head: pr.headRefOid },
      cursor: { ...entry.cursor, fixed_sha: pr.headRefOid },
      rereview: { at: askedAt(entry, pushedAt), nudged: false },
    });
    log.info(`${id}: head moved to ${pr.headRefOid.slice(0, 7)}${wasReady ? " after ready" : ""}; watching again`);
    return saved;
  }

  function assertProviderHealth(entry) {
    const deferred = deps.cooldowns?.deferred(providerScope(entry.harness, config.harness[entry.harness]?.account || "operator"));
    if (deferred) throw Object.assign(deferred, { code: "PROVIDER_UNAVAILABLE", retryableProviderPending: true });
    const health = deps.providerHealth?.get(entry.harness, config.harness[entry.harness]?.account || "operator");
    if (health && !health.ok) throw Object.assign(new Error(`provider health unavailable: ${health.detail}; ${health.fix || "restore this provider account"}`), { code: "PROVIDER_UNAVAILABLE", retryableProviderPending: health.pending === true });
  }

  /**
   * Spawn a harness run. Resumes when a session exists, otherwise starts a fresh one and returns its id.
   *
   * Async because of the credential. It is resolved here, for this run, rather than once when the daemon booted: an
   * operator who re-authenticates under a long-lived daemon gets the new token on the next run without restarting
   * anything, and a token that expired under a daemon that has been up for a week does not silently poison every run
   * after it. The cost is one `gh auth token` subprocess, and only when neither `github_token_file` nor the daemon's
   * own environment answered first.
   *
   * A run with no credential is refused rather than spawned. It would implement the brief, commit it, and then fail
   * to push, which is money spent for work nobody can reach. The throw is caught by the caller, which stops the entry
   * with `no-credential` and the fix, so the operator is told rather than left reading a dead run's log.
   */
  const startRun = (id, entry, options) => authorSlots(() => startRunOwned(id, entry, options));
  async function startRunOwned(id, entry, { name, prompt, ownership = null, paths = [], dispatchDeadline = null, beforeDispatch = null, operationId = null, controlId = null, recovery = null, repairPolicy = null, dispatchGuard = null, baseRepair = null }) {
    const approved = planAllowanceFor(id, entry), planOwner = entry.plan, startToken = entry.start_token;
    const preparedPrd = prdFor(id);
    const preparedBinding = turnBinding(deps, id, entry, preparedPrd);
    const ownerRun = entry.last?.run;
    const transfer = entry.route_recovery;
    if (transfer && (recovery?.key !== transfer.intent || operationId !== transfer.operation || entry.harness !== transfer.to))
      throw Object.assign(new Error("An existing handoff owns this execution epoch."), { code: "RECOVERY_AUTHORITY" });
    if (recovery && !transfer && (!entry.session || !runnerFor(id).continue || runnerFor(id).capabilities?.continuation !== "native-session"))
      throw Object.assign(new Error("Restore the original native session before recovery."), { code: "RECOVERY_AUTHORITY" });
    let job, slot, chargedRepair, dispatchInvoked = false;
    const assertRepairTurn = (current, reservation) => {
      assertRepairIdentity(id, current, baseRepair);
      const expectedIteration = chargedRepair ? baseRepair.round : entry.iteration;
      if (!slot || reservation?.token !== slot || reservation.operation !== baseRepair.operationId ||
          reservation.previousRun !== baseRepair.previousRun || current.last?.run !== baseRepair.previousRun ||
          baseRepair.round !== entry.iteration + 1 || current.iteration !== expectedIteration ||
          !isDeepStrictEqual(current.base_repair, chargedRepair ?? baseRepair))
        throw repairError("The saved repair round or author reservation changed before dispatch.", "base-repair-ownership");
    };
    const assertDispatchOpen = () => {
      recovery?.guard();
      dispatchGuard?.();
      if (dispatchDeadline != null && clock.now() >= dispatchDeadline) throw Object.assign(new Error("network recovery window expired before dispatch"), { code: "NETWORK_RECOVERY_EXPIRED" });
      const registry = state.load(), current = registry.entries[id];
      if (deferred(entry)) {
        if (!deps.deferredCI) throw Object.assign(new Error("Restore the protected CI coordinator before resuming the enrolled task."), { code: "CI_SETUP_PENDING" });
        deps.deferredCI.assertLaunch(deps, id, current);
      }
      if (dispatchDeadline != null && controlPending(current?.control)) throw Object.assign(new Error("operator control superseded automatic recovery"), { code: "NETWORK_RECOVERY_SUPERSEDED" });
      const stopped = current?.dispatch_stopped || entry.dispatch_stopped;
      if (stopped) throw Object.assign(new Error(`dispatch stopped: ${stopped}`), { code: "EXECUTION_STOPPED" });
      if (!current || !isDeepStrictEqual(current.plan, planOwner) || turnBinding(deps, id, current, preparedPrd) !== preparedBinding ||
          current.last?.run !== ownerRun || !controlAllowsRepair(current.control, controlId) ||
          current.control?.id !== entry.control?.id || current.control?.status !== entry.control?.status ||
          recoveryHeld(registry, id, controlId ? { ...current, control: null } : current)) {
        throw Object.assign(new Error("Turn preparation lost its approved revision, control or execution owner."), { code: "EXECUTION_OWNERSHIP" });
      }
      if (approved && (current.start_token !== startToken || authorConfigurationDigest(config, current.harness, preparedPrd) !== approved.routeDigest))
        throw Object.assign(new Error("The turn no longer matches its approved plan owner or author route."), { code: "PLAN_START_FENCE" });
      if (baseRepair && slot) assertRepairTurn(current, registry.dispatch?.authors[id]);
      // The exact repair has already charged this turn. Check the allowance it reserved.
      assertPlanRounds(chargedRepair ? entry : current, approved);
    };
    assertDispatchOpen();
    const selected = (deps.hosts ?? hosts).select(entry);
    assertRepositoryAccess(capabilitiesFor(entry.harness), selected.repository);
    repositoryReviewConfig(config, entry.repo, selected.adapter);
    if (selected.adapter.features?.strictIdentity && entry.pr) {
      const current = await host.prView(entry.repo, entry.pr);
      const problem = observedIdentityProblem(entry, current) || (current.state !== "OPEN" ? "PR is no longer open; reconcile its terminal identity before resuming" : null);
      if (problem) {
        await needsHuman(id, "pr-identity", { last: { ...entry.last, at: now(), event: problem } });
        throw Object.assign(new Error(problem), { code: "PR_IDENTITY" });
      }
    }
    assertProviderHealth(entry);
    deps.resourcePreflight?.(entry.worktree);
    if (capabilitiesFor(entry.harness).transport === "remote") await requireVerificationSandbox();
    await git.authorStorage?.(entry.worktree, deps.home || config.home);
    await git.ensureHttpsRemote?.(entry.worktree, entry.repo);
    if (entry.brief_changes?.length && name !== "resume") {
      // A prior manual resnapshot may have failed after updating daemon state but before copying into the checkout.
      const brief = readPrd(id);
      if (entry.prd && brief != null) writeRepositoryText(entry.worktree, entry.prd, brief);
      restoreSources(id, entry);
      prompt = `THE BRIEF HAS CHANGED. Reread the brief and its carried files in the worktree.\n${entry.brief_changes.join("\n")}\n\n${prompt}`;
    }
    const execution = runnerFor(id), remote = execution.capabilities?.transport === "remote";
    if (execution.ledgerEpoch > 0) reserveExecutionEpoch({ root: execution.root, taskId: id,
      provider: entry.harness, account: execution.account, epoch: execution.ledgerEpoch, pr: entry.pr });
    // A registration made by older code can be recognized from its exact settled
    // old ledger without modifying that ledger. Persist the chosen new epoch
    // before the first launch changes `last` and `execution`, which are the
    // evidence the read-only recovery rule needs on later process starts.
    if (execution.ledgerEpoch > 0 && entry.execution_epoch == null) {
      entry = state.update(id, { execution_epoch: execution.ledgerEpoch,
        execution_handoff: { from: entry.execution?.provider, to: entry.harness, previousRun: entry.last?.run ?? null, at: now() } });
    }
    const mode = entry.session ? "resume" : "start";
    const session = entry.session || transfer?.session || entry.learning_continuity?.newSession || (remote ? null : adapterFor(entry.harness).newSession());
    const relocated = readRecoveryOverlays(deps, id, entry);
    if (relocated.length) {
      if (remote) throw repairError("The selected adapter must deliver the restored overlays privately before another turn.", "base-repair-inputs");
      const context = JSON.stringify(relocated);
      if (Buffer.byteLength(prompt) + Buffer.byteLength(context) > 180_000) throw repairError("The approved private overlays exceed the local continuation input limit.", "base-repair-inputs");
      prompt += "\n\nApproved private documentation snapshots follow as JSON. Read these snapshots for task intent. Leave the newly tracked working files available for implementation and tests. Keep the snapshots out of public output.\n" + context;
    }
    // Extra read-only directories, resolved in one place (lib/config.mjs) from the operator's config list plus the
    // frontmatter of the daemon's OWN snapshot of the brief. The snapshot is what stops a session widening its
    // reads by editing the PRD it was handed.
    const allowedConfig = taskExecutionConfig(planRunConfig(config, approved), entry.task, execution);
    const runConfig = recovery ? { ...allowedConfig, max_budget_usd: Math.min(allowedConfig.max_budget_usd, recovery.route.maxSpendMicros / 1e6) } : allowedConfig;
    const contextPaths = resolveContextPaths(runConfig, prdFor(id));
    let spec = remote ? null : buildRun({ harness: entry.harness, config: runConfig, mode, session, prompt, cwd: entry.worktree, contextPaths });
    // The host comes from this entry's own checkout, so an enterprise remote asks `gh` for that host's token rather
    // than sending it a github.com one.
    const credential = deferred(entry) ? await deps.deferredCI.author(deps, id, entry, preparedPrd,
      Math.min(resolveTimeout({ config: runConfig, repo: entry.repo }).minutes * 60_000, entry.task?.deliveryAllowance?.runtimeMs ?? Infinity))
      : await resolveCredentialFor({ config, git, hosts: deps.hosts, credential: ctxCredential }, { worktree: entry.worktree, repo: entry.repo });
    if (!credential.token) throw Object.assign(new Error(credential.why), { code: "NO_CREDENTIAL" });
    await (deps.packageAuthPreflight || preflightPackageAuth)({ config, repo: entry.repo, credential, transport: execution.capabilities?.transport || capabilitiesFor(entry.harness).transport, limits: config.execution });
    // The identity the session commits as, resolved per run for the reason lib/identity.mjs gives: the daemon is
    // long-lived and an operator may change theirs under it. This is the path `resume` and every fix round take.
    const routeDigest = await requireAuthorRoute(deps, id, entry, assertDispatchOpen, { resolvedCredential: credential, run: execution.current() });
    const identity = await requireIdentity({ identity: ctxIdentity });
    // The `commit-msg` hook, on every run rather than only on a clone, and here rather than in `ensureWorktree`
    // because this is the one function both paths into a session pass through: `dispatch` calls it for a fix round and
    // `gallivant resume` calls it directly, skipping `ensureWorktree` altogether. `git.fromBranch` installs the hook
    // itself, so a FRESH checkout was always guarded; one already on disk went through no clone path at all, which is
    // every checkout made before the hook existed. Found on a live resume: the session dropped the attribution trailer
    // because the prompt told it to, and `.git/hooks/commit-msg` had never been written, so the half meant to enforce
    // it was absent. Idempotent and never fatal, so this costs a stat and cannot fail a run.
    const policy = repairPolicy ?? publicationPolicyOf(prdFor(id), { sources: entry.sources || [], base: entry.base });
    let hook;
    if (repairPolicy) {
      await git.repairHook(realpathSync(entry.worktree), policy, null, assertDispatchOpen, { refresh: false });
    } else if (entry.recovery_profile && git.repairHook) {
      await refreshRepairHook(id, entry, policy, assertDispatchOpen);
    } else hook = git.installHooks?.(entry.worktree, policy);
    if (hook && !hook.installed) log.warn(`${id}: the commit-msg hook could not be written into ${entry.worktree} (${hook.why}); local commit checks are unavailable; coordinator publication checks remain mandatory`);
    const initialDispatch = remote && !session || deferred(entry) && !entry.session ? unsubmittedInitialDispatch(entry, execution) : null;
    if (recovery && routeDigest !== recovery.decision.expected.route)
      throw Object.assign(new Error("Configured author route differs from the admitted recovery route."), { code: "RECOVERY_AUTHORITY" });
    const dispatchInput = { ...(recovery ? { recoveryIntent: recovery.key, previousOperationId: recovery.priorOperation } : {}), ...(routeDigest ? { recoveryRouteDigest: routeDigest, recoveryProfileDigest: entry.recovery_profile.digest } : {}), approvalDigest: preparedBinding, operationId: baseRepair?.operationId ?? operationId ?? initialDispatch?.operationId ?? `${entry.last?.run || "initial"}:${entry.iteration}:${name}${entry.learning_continuity?.status === "prepared" ? ":fresh" : ""}`, sessionId: entry.session, inputHead: git.head ? await git.head(entry.worktree) : null, workflow: ownership || { state: entry.pr ? STATES.prOpen : STATES.running, reason: null, lastEvent: `recovered ${name} dispatch` } };
    if (entry.learning_continuity?.status === "prepared") dispatchInput.workflow = { ...dispatchInput.workflow,
      learning_revocation: null, learning_continuity: { ...entry.learning_continuity, status: "accepted" } };
    const managed = await learningInput({ ...deps, learning }, id, entry, { ...dispatchInput, name, prompt, ...(paths.length ? { paths } : {}) });
    if (!remote && managed.prompt !== prompt) spec = buildRun({ harness: entry.harness, config: runConfig, mode, session, prompt: managed.prompt, cwd: entry.worktree, contextPaths });
    // Checkout/credential/head preparation may outlive the health observation.
    // Recheck the shared scope immediately before provider I/O or local launch.
    assertProviderHealth(entry);
    const reserve = () => {
      const prior = execution.current();
      const settled = prior && prior.id === ownerRun &&
        authorSettled({ execution: prior.execution, last: { run: prior.id, exit: prior.exit } }, prior, execution)
        ? { run: prior.id, operation: prior.execution?.operationId } : null;
      return state.reserveAuthorTurn?.(id, ownerRun ?? null, dispatchInput.operationId, dispatchCapacity(config),
        { requiresCessation: !remote && typeof execution.cleanupSettled === "function", settled });
    };
    const prepareDispatch = async () => {
      assertDispatchOpen();
      slot = reserve();
      await beforeDispatch?.();
      if (baseRepair) {
        assertDispatchOpen();
        const charge = { ...baseRepair, status: "dispatching", charged: true };
        save(id, { base_repair: charge, iteration: baseRepair.round }, { durable: true }, current => {
          assertRepairTurn(current, state.load().dispatch?.authors[id]);
          return true;
        });
        chargedRepair = charge;
      }
    };
    try {
      if (remote) {
        const input = deps.executionInputFor
          ? await deps.executionInputFor(id, entry, managed, contextPaths)
          : { ...managed, repo: entry.repo, branch: entry.branch, base: entry.base, allowance: entry.execution?.allowance, mandatoryPolicy: entry.execution?.mandatoryPolicy || [], environment: entry.execution?.environment, model: entry.execution?.model };
        input.allowance = taskProviderAllowance(input.allowance, entry.task);
        if (recovery && !(input.allowance?.reservedUsd * 1e6 <= recovery.route.maxSpendMicros))
          throw Object.assign(new Error("Remote reservation exceeds the approved recovery route."), { code: "RECOVERY_AUTHORITY" });
        await execution.prepare(input);
        assertProviderHealth(entry);
        job = await learningDispatch({ ...deps, learning }, id, managed, async () => {
          await prepareDispatch();
          assertDispatchOpen();
          deps.resourcePreflight?.(entry.worktree);
          if (initialDispatch) save(id, { initial_dispatch: { ...initialDispatch, status: "dispatching" }, reason: "dispatch-intent" });
          if (recovery) { recovery.reserve(dispatchInput.operationId); recovery.executing(); }
          dispatchInvoked = true;
          return session && ["native-session", "successor-task"].includes(execution.capabilities.continuation) ? execution.continue(input, assertDispatchOpen) : execution.submit({ ...input, sessionId: null }, assertDispatchOpen);
        });
      } else job = await learningDispatch({ ...deps, learning }, id, managed, async () => {
        await prepareDispatch();
        assertDispatchOpen();
        deps.resourcePreflight?.(entry.worktree);
        verifyAuthorCopies(deps, id, entry, preparedPrd);
        if (initialDispatch) {
          await deps.deferredCI.author(deps, id, entry, preparedPrd);
          assertDispatchOpen();
          save(id, { initial_dispatch: { ...initialDispatch, status: "dispatching" }, reason: "dispatch-intent" }, { durable: true });
        }
        if (recovery) { recovery.reserve(dispatchInput.operationId); recovery.executing(); }
        const env = runSessionEnv(spec.env, config, credential, identity, entry.worktree);
        if (repairPolicy) Object.assign(env, { GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "",
          GIT_HOST_TOKEN: "", HOST_API_TOKEN: "", GIT_SSH_COMMAND: "false", SSH_AUTH_SOCK: "" });
        dispatchInvoked = true;
        return execution.start(name, spec.cmd, spec.args, { cwd: entry.worktree, runtimeSettings: spec.runtimeSettings, env, execution: { ...dispatchInput, ...(transfer || entry.learning_continuity?.status === "prepared" ? { recordedSessionId: session } : {}), ...(managed.learning ? { learning: managed.learning, managedInputDigest: managed.managedInputDigest } : {}) } }, assertDispatchOpen);
      });
    } catch (error) {
      if (slot && (!dispatchInvoked || dispatchProvenUnsent(error, execution, dispatchInput.operationId))) {
        const finished = initialDispatch && state.finishUnsentStart(id, slot);
        if (!finished) state.releaseAuthorTurn(id, slot);
      }
      throw error;
    }
    if (recovery && job.execution?.acceptance === "accepted" && job.execution.operationId === dispatchInput.operationId) {
      acceptedRecovery(state, id, recovery.key, job.execution.operationId, "verifying");
      recovery.phase("resumed");
    }
    return { job, session: job.execution?.sessionId || session, managed };
  }

  /** When a head was pushed, from GitHub, or `fallback` when GitHub cannot say. */
  const headPushedAt = (entry, sha, fallback) => host.commitDate(entry.repo, sha).then(d => d || fallback).catch(() => fallback);

  /** The reviewer clock for this entry and this head. The rule itself is `events.mjs`; `reconcile` uses the same one. */
  const askedAt = (entry, pushedAt) => reviewerClock({ config: policyConfig(config, entry), pushedAt, previousAsk: entry.rereview?.at ?? null, floorAt: now() });

  /**
   * The round comment: the announcement of a round that has already been counted. Called on the settle tick that
   * counted it, and again by `tickEntry` on every later tick while `entry.round_comment` is still set, which is the
   * `labels_pending` shape: the state has moved and one GitHub write is still owed, so the entry names the debt and a
   * later tick pays it.
   *
   * What separating it from the count buys, precisely. `countRounds` rebuilds `iteration` from these markers after
   * `state.json` is lost, so the comment is still the thing a recovery counts and it must still be posted. What it is
   * no longer allowed to do is decide whether the round happened. A refused comment used to leave the push on GitHub
   * and the counter unmoved; now it leaves the counter moved and the comment owed, and the debt is on the entry where
   * `status`, `why` and a recovery can all see it.
   *
   * Idempotent through `commentOnce`, against the `since` the round was counted at rather than the current cursor: the
   * cursor has already advanced past the push, so asking "is the marker there since the cursor" would answer no for a
   * comment this very function had posted, and the entry would post one per tick. The boundary is therefore stored
   * with the debt, in `round_comment.since`.
   *
   * Still the fifth caller of the bound, and still for the same reason: a token that can push but cannot comment never
   * recovers, and an entry whose rounds are invisible to a recovery must not be left running in silence. What changed
   * is what the stop means. It is no longer "a round happened and was not counted"; it is "the rounds are counted here
   * and the PR cannot be told", which is a state a person has to resolve either way.
   */
  async function postRoundComment(id, entry) {
    const owed = entry.round_comment;
    if (!owed) return false;
    const body = owed.kind === "round" ? roundComment(reviewConfigFor(entry)) : owed.kind === "public-text" ? `Review text updated.\n\n${ROUND_MARKER}` : receiptRoundComment();
    try { await commentOnce(entry, body, ROUND_MARKER, owed.since); }
    catch (err) {
      // The session is not re-saved here: the count above already persisted it, so there is nothing a retry could
      // mint a second time. `action` names the round that IS counted, which is the honest thing to log now: the work
      // is on the branch and in the counter, and only the announcement is outstanding.
      await retryFailed(id, entry, ROUND_COMMENT, err, {
        action: `round ${entry.iteration} is counted; retrying the comment next tick`,
      });
      return false;
    }
    // The ask is now, and only now. `rereview.at` claims the reviewer was asked to look again, and the comment
    // carrying that request is what makes the claim true, so the clock starts when it lands. Through `askedAt`, so a
    // committer date older than the nudge window is floored to the window rather than taken literally.
    const askPatch = owed.kind === "round" ? { rereview: { at: askedAt(entry, owed.pushed_at), nudged: false } } : {};
    save(id, { round_comment: null, retry: null, ...askPatch });
    log.info(`${id}: round ${entry.iteration} ${owed.kind === "round" ? "re-review requested" : "receipt update posted"}`);
    return true;
  }

  async function stopRun(id, entry, runner, cur) {
    try {
      if (runner.capabilities?.transport === "remote") {
        const answer = await runner.cancel("timeout");
        const status = cancellationStatus(answer);
        await needsHuman(id, status.reason, { last: { ...entry.last, event: `timeout: ${status.message}` } });
        return false;
      }
      if (runner.cancel) await runner.cancel("timeout");
      else runner.kill(cur.id);
      return true;
    }
    catch (error) {
      log.warn(`${id}: cannot verify stopping run ${cur.id}: ${error.message}`);
      if (entry.state !== STATES.needsHuman || entry.reason !== "run-stop-unverified") {
        await needsHuman(id, "run-stop-unverified", {
          last: { ...entry.last, event: `Cannot verify shutdown of run ${cur.id}; it may still be running. Inspect its process tree and restore process inspection before retrying. No replacement was started.` },
        });
      }
      return false;
    }
  }

  /**
   * Step 1: a run that ended since the last tick, or one that has run too long. Only the run this entry dispatched
   * (`last.run`) is settled; a leftover run from before a reset or a recovery is ignored. Returns true when the
   * entry should wait.
   */
  async function settleRun(id, entry, refreshIdentity) {
    const runner = runnerFor(id);
    const cur = runner.current();
    if (!cur) return false;
    // Ownership first, before anything is decided about the run. A live run this entry did not dispatch used to
    // short-circuit the whole tick: the entry waited on it for the full `run_timeout_minutes` with its feedback never
    // read and nothing logged, and then the leftover was killed and the entry stopped with `reason: "timeout"` and
    // `last.run` rewritten to a run it never started, so `gallivant why` printed someone else's log and cost. The
    // leftover process outliving a reset is a separate problem from this entry's state, and it does not get to borrow
    // this entry's reason.
    if (entry.last?.run !== cur.id) return false;
    const stoppedByMessage = !entry.dispatch_stopped && entry.control?.action === "message" &&
      entry.control.interrupt === true && entry.control.stop_run === cur.id;
    const interrupted = stoppedByMessage && entry.control.status === "queued";
    if (cur.execution?.quarantined && !interrupted) {
      if (cur.running) return true;
      save(id, { last: { ...entry.last, exit: cur.exit ?? 1, event: "late provider result quarantined after stop" },
        ...(stoppedByMessage ? { state: STATES.needsHuman, reason: "operator-interrupted", network_retry: null } : {}),
      });
      return false;
    }
    if (cur.running) {
      if (entry.state === STATES.needsHuman && entry.reason === "run-stop-unverified"
          && entry.labels_pending && entry.pr && await writeStopLabels(id, entry)) {
        entry = save(id, { labels_pending: false });
      }
      if (cur.killed) {
        await stopRun(id, entry, runner, cur);
        return true;
      }
      if (entry.control?.stop_run === cur.id && entry.control.status === "queued") return true;
      const evidenceAfter = Math.max(cur.startedAt, Date.parse(cur.execution?.lastProgressAt) || 0,
        Date.parse(entry.recovery_record?.progress?.at) || 0);
      if (clock.now() - evidenceAfter >= minutes(15) && !(entry.run_health?.run === cur.id && entry.run_health.checked_at + minutes(5) > clock.now())) {
        const phase = runner.phase?.(cur.id, entry.harness) || cur.execution?.providerState || "output-unresolved";
        const threshold = phase === "tool-observed" ? 60 : ["queued", "status-unknown", "retrieving-results"].includes(phase) ? 15 : 30;
        save(id, { run_health: { run: cur.id, phase, checked_at: clock.now(),
          code: clock.now() - evidenceAfter >= minutes(threshold) ? "investigate-no-progress" : "observing-phase" } });
      }
      // The limit is the repository's when it set one, and the global otherwise (`resolveTimeout`), because how long
      // verification takes is a property of the codebase. A run was killed at 31.2 minutes against a 30 minute global
      // with its work finished and four commits on disk, in a repository whose two Verify commands take 2m30s each.
      const approved = planAllowanceFor(id, entry);
      const limit = approved ? { minutes: approved.timeoutMinutes, source: "plan" } : resolveTimeout({ config, repo: entry.repo });
      if (entry.task?.deliveryAllowance) {
        const taskLimit = taskExecutionConfig({ ...config, run_timeout_minutes: limit.minutes }, entry.task, runner, { excludeRunId: cur.id }).run_timeout_minutes;
        if (taskLimit < limit.minutes) { limit.minutes = taskLimit; limit.source = "task"; }
      }
      if (clock.now() - cur.startedAt > minutes(limit.minutes)) {
        const ranMin = Math.round((clock.now() - cur.startedAt) / 60_000);
        if (!await stopRun(id, entry, runner, cur)) return true;
        // What the kill interrupted, read here because SIGKILL is the one stop that records nothing of its own and
        // because both readings stop being true the moment anyone touches the checkout. `needsHuman(id, "timeout")` left
        // `reason: "timeout"` and an exit of 137 and nothing else, so every signal said "it timed out" and none said what
        // it was killed in the middle of.
        //
        // BOTH are read, and the dirty tree is the half that matters. A run was killed having done a whole review round
        // and written its commit message to a temp file, one tool call before `git commit`: nothing was committed, so a
        // commit count alone said zero and the entry read as an ordinary timeout, while the worktree held six modified
        // and four untracked files that no commit, branch or PR contained. Uncommitted work is more fragile than
        // unpushed, not less, because `resume` recreates a missing checkout without asking and a `git clean` takes it.
        // An entry killed with an empty tree and nothing committed is the case the timeout exists for; these two counts
        // are what tell the two apart.
        const stranded = entry.worktree && git.unpushed ? await git.unpushed(entry.worktree, entry.branch, entry.base ?? null).catch(() => []) : [];
        const dirty = entry.worktree && git.dirty ? await git.dirty(entry.worktree).catch(() => ({ modified: 0, untracked: 0 })) : { modified: 0, untracked: 0 };
        // Logged at warn, not info: this is the one line in the daemon's log that says work may be about to be lost.
        if (dirty.modified || dirty.untracked) log.warn(`${id}: killed at ${ranMin}m with UNCOMMITTED work in ${entry.worktree} (${dirty.modified} modified, ${dirty.untracked} untracked). No commit holds it. Do not recreate that checkout.`);
        if (stranded.length) log.info(`${id}: killed at ${ranMin}m with ${stranded.length} unpushed commit${stranded.length === 1 ? "" : "s"} on ${entry.branch}; the work exists and is not on the remote`);
        await needsHuman(id, "timeout", {
          last: { ...(entry.last || {}), run: cur.id, exit: 137, at: now() },
          timeout: { limit: limit.minutes, source: limit.source, ran_minutes: ranMin, unpushed: stranded.length, modified: dirty.modified, untracked: dirty.untracked },
        });
      }
      return true;
    }
    if (entry.last?.exit != null || entry.base_repair?.status === "blocked") return false;
    if (cur.pid && runner.cleanupSettled?.(cur.id) === false && cur.exit != null) {
      save(id, { run_health: { run: cur.id, phase: "local-cessation", code: "owner-unverified", checked_at: clock.now() } });
      return true;
    }

    const lines = runner.outcome && runner.sessionFrom ? [] : runner.lines(cur.id);
    // Intentional local stops quarantine late results too. Settle the owned
    // interruption through the normal PR-discovery path without collecting or
    // trusting that result, so a pre-PR task becomes resumable as well.
    const outcome = cur.execution?.quarantined
      ? { ok: false, finished: true, cost: cur.execution.costUsd ?? null, denials: [] }
      : runner.outcome ? runner.outcome(cur.id) : adapterFor(entry.harness).outcome(lines);
    if (!outcome.finished) save(id, { run_health: { run: cur.id, phase: "result-collection", code: "missing-final-event", checked_at: clock.now() } });
    const job = runner.settle(cur.id, () => (outcome.ok ? 0 : 1));
    recordAuthorSettlement(id, runner, job);
    const session = entry.session || (runner.sessionFrom ? runner.sessionFrom(cur.id) : adapterFor(entry.harness).sessionFrom(lines));
    if (runner.collect && outcome.finished && !cur.execution?.collected && !cur.execution?.quarantined) await runner.collect();
    const settled = runner.current();
    if (settled?.id === cur.id && settled.execution) entry = save(id, { execution: settled.execution });
    if (runner.outputNextAt) entry = save(id, { output_next_at: runner.outputNextAt() });
    const last = { at: now(), run: cur.id, exit: job.exit, event: entry.last?.event || "start", cost: outcome.cost, denials: outcome.denials };

    if (entry.base_repair && entry.base_repair.status !== "verified") {
      try {
        await refreshIdentity();
        await settleBaseRepair(id, entry, await host.prView(entry.repo, entry.pr), last, outcome);
      } catch (error) { await retryFailed(id, entry, "base repair proof", error, { action: "retrying host observation without redispatch",
        onStop: { last, base_repair: { ...entry.base_repair, status: "blocked", failure: error.message } } }); }
      return true;
    }

    if (interrupted && entry.state !== STATES.running) {
      // An intentional interruption is not a failed review round or a completion.
      // Account for it once, then let the normal control path resume the saved session.
      save(id, { session, state: STATES.needsHuman, reason: "operator-interrupted", last });
      return false;
    }

    if (job.exit === 0 && outcome.finished && outcome.ok && !outcome.denials?.length) {
      for (const recipe of ["provider-continuation", "route-handoff"])
        verifyRecoveryOutcome(state, id, cur.execution, recipe, [cur.id, session, job.exit, cur.execution?.operationId]);
    }
    const networkCode = transientProviderFailure(outcome);
    const recoverableNetwork = !interrupted && networkCode && session && job.exit !== 0 && !job.killed &&
      runner.capabilities?.transport !== "remote" && !entry.dispatch_stopped && !controlPending(entry.control);
    // Persist the observation before GitHub I/O. An outage during reconciliation
    // must not postpone the recovery deadline or authorize an unreconciled retry.
    if (recoverableNetwork) {
      const previous = entry.network_retry;
      if (previous && !validNetworkRetry(previous)) {
        await needsHuman(id, "network-recovery-unverified", { network_retry: null, session, last: { ...last, error: "Invalid saved network retry; inspect state before explicitly resuming" } });
        return true;
      }
      entry = save(id, { session, network_retry: { attempts: previous?.attempts ?? 0,
        first_at: previous?.first_at ?? now(), code: networkCode, run: cur.id,
        phase: "reconciling", next_at: null } });
      if (previous?.phase !== "reconciling" || previous.run !== cur.id)
        deps.cooldowns?.record(providerScope(entry.harness, cur.execution?.account || config.harness[entry.harness]?.account || "operator"), { code: networkCode, retryAt: outcome.retryAt });
    }
    // Reconcile published progress before retrying. A terminal network error
    // does not undo a push or let its paid review round escape accounting.
    const scheduleNetworkRecovery = async () => {
      if (!recoverableNetwork) return false;
      const previous = entry.network_retry;
      const attempts = previous?.attempts ?? 0;
      const firstAt = previous?.first_at ?? now();
      const plan = retryPlan(networkCode);
      const exhausted = attempts >= plan.delays.length || clock.now() - Date.parse(firstAt) >= plan.window;
      const network_retry = { attempts, first_at: firstAt, code: networkCode, run: cur.id,
        phase: exhausted ? "exhausted" : "waiting",
        next_at: exhausted ? null : new Date(Math.max(clock.now() + plan.delays[attempts], serverRetryAt(outcome, clock.now()))).toISOString() };
      // Failure text may contain a proxy URL or credentials. Keep only the
      // recognized code in operator-facing state; the owned log retains detail.
      const patch = { session, network_retry, last: { ...last, error: `${networkCode}: temporary provider failure` } };
      if (exhausted) await needsHuman(id, "provider-network-exhausted", patch);
      else {
        save(id, { ...patch, state: STATES.needsHuman, reason: "provider-network", retry: null });
        log.warn(`${id}: ${networkCode}; same-session recovery scheduled at ${network_retry.next_at}`);
      }
      return true;
    };
    // A completed success or a different failure ends this consecutive network
    // streak. Never let old deadlines silently restart a later stopped task.
    if (entry.network_retry && !recoverableNetwork) entry = save(id, { network_retry: null });

    // Process exit and stop accounting above are local. Host-dependent settlement
    // below needs a verified actor, but an identity outage must not delay a stop.
    await refreshIdentity();
    if (entry.state === STATES.running) {
      const prs = await host.prListByHead(entry.repo, entry.branch);
      let pr = (prs || []).find(p => !p.isCrossRepository);
      if (!pr) {
        if (await scheduleNetworkRecovery()) return false;
        if (interrupted) {
          save(id, { session, state: STATES.needsHuman, reason: "operator-interrupted", last });
          return false;
        }
        // What the run left behind, on the stop that most often has something to leave. A start run that ends with no
        // pull request has usually done work: this stop was reached by a run that produced a 33-file research package,
        // passed both of its Verify commands, and never committed, and the entry recorded only `no-pr`. An operator
        // reading that has no reason to look in the checkout, and the next `resume` cannot merge the base past the
        // files nobody knows are there.
        //
        // The same reading the timeout kill already does (`git.dirty` plus `git.unpushed`), for the same reason: the
        // counts are the difference between "it did nothing" and "it did everything but the last step".
        const tree = entry.worktree && git.dirty ? await git.dirty(entry.worktree).catch(() => null) : null;
        const left = tree && (tree.modified || tree.untracked)
          ? `; ${[tree.modified && `${tree.modified} modified`, tree.untracked && `${tree.untracked} untracked`].filter(Boolean).join(" and ")} file${tree.modified + tree.untracked === 1 ? "" : "s"} are uncommitted in ${entry.worktree}`
          : "";
        const failed = !outcome.finished || !outcome.ok || job.exit !== 0;
        await needsHuman(id, failed ? "harness-error" : "no-pr", {
          session, last: { ...last, event: `${last.event}${left}`,
            ...(failed ? { error: outcome.finished ? "Worker failed before opening a PR; inspect the owned run log for the provider or tool failure" : "Worker ended without a terminal task result; inspect the owned run log" } : {}) },
          ...(tree ? { tree } : {}),
        });
        return false;
      }
      const identityProblem = observedIdentityProblem(entry, deferred(entry) || entry.plan || cur.execution?.recoveryIntent ? { ...pr, strictIdentity: true } : pr);
      if (identityProblem) {
        await needsHuman(id, "pr-identity", { session, last: { ...last, event: identityProblem } });
        return false;
      }
      if (deferred(entry)) {
        try {
          if (!deps.deferredCI) throw new Error("protected coordinator unavailable");
          const observation = await host.prView(entry.repo, pr.number);
          await deps.deferredCI.currentCandidate(deps, id, { ...entry, pr: pr.number, url: pr.url }, observation);
        } catch (error) {
          await retryFailed(id, save(id, { session }), "enrolled PR identity", error,
            { action: "waiting to authenticate the enrolled pull request" });
          return false;
        }
      }
      if (pr.state === "OPEN" && !pr.isDraft)
        verifyRecoveryOutcome(state, id, cur.execution, "publication-continuation", [entry.repo, pr.number, pr.baseRefName, pr.headRefOid]);
      // The identity block is a precondition of leaving `running`, not a best-effort extra. It is what reconciliation
      // rebuilds an entry from once `state.json` is gone (`up.mjs` reads the harness, the session and the PRD path out
      // of it), so an entry that reaches `pr-open` with no block is a PR the advertised recovery will skip: the
      // session it names cannot be resumed and the operator's own `register` is the only way back.
      //
      // `register`'s equivalent throws, because `register` is one interactive command whose operator can fix the cause
      // and rerun it. The tick has no operator and must not abandon an entry, so the failure has to leave a state the
      // NEXT TICK retries from, and `running` with `last.exit` still null is exactly that state: `settleRun` re-enters
      // this branch on the next pass (its early return is `entry.last?.exit != null`, which is registry state and not
      // the job's), re-reads the PR and writes the block again. The session is persisted on the way out so a retry
      // never mints a second one, and `runner.settle` has already recorded the process exit and is idempotent, so
      // nothing spawns and nothing is re-settled. It retries rather than spins because the only work it repeats is
      // two GitHub reads and one write; when the write lands the entry moves on in that same pass, and while it does
      // not, `status` shows the entry still starting and `errors.log` names the cause on every attempt.
      //
      // Retrying is not the same as retrying forever. `retryFailed` counts the consecutive failures of this one write
      // on the entry and stops it with `stuck` once they cross `MAX_STEP_FAILURES`, so a permissions problem that will
      // never resolve (a token that can read a PR but not write its body) rings the operator's phone instead of holding
      // the PR unwatched in silence. The session is saved either way, so neither the retry nor the stop loses it.
      try {
        const identity = recoveryIdentity(entry, session);
        if (normalizePublicBody(pr.body, { identity, taskId: id }) !== pr.body) {
          pr = await host.setRecoveryMetadata(entry.repo, pr.number, identity, { taskId: id });
        }
      }
        catch (err) {
          await retryFailed(id, save(id, { session }), `PR #${pr.number} block write`, err, {
            action: "staying in running and retrying next tick",
            // Only on the stop, never on a retry: a retrying entry must not claim to watch a PR whose block is still
            // missing (the existing invariant), but a stopped one names the PR so the notification and `why` can link it.
            onStop: { pr: pr.number, url: pr.url },
          });
          return false;
        }
      // Events are new from the PR's creation, so a review that landed while the start run was still going is seen.
      // `retry` is cleared here rather than through `retryOk`: leaving `running` IS this write succeeding, and one save
      // for the transition beats two.
      save(id, {
        state: STATES.prOpen, session, pr: pr.number, url: pr.url, last, retry: null, network_retry: null,
        verified_progress: { kind: "published-pr", at: now(), head: pr.headRefOid },
        cursor: { since: pr.createdAt, dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
        rereview: { at: pr.createdAt, nudged: false },
      });
      log.info(`${id}: PR #${pr.number} open`);
      return false;
    }

    // A fix run ended. Progress is the head moving or the receipt changing; anything else is a stop.
    const pr = await host.prView(entry.repo, entry.pr);
    const identityProblem = observedIdentityProblem(entry, deferred(entry) ? { ...pr, strictIdentity: true } : pr);
    if (identityProblem) { await needsHuman(id, "pr-identity", { session, last: { ...last, event: identityProblem } }); return false; }
    const pushed = pr.headRefOid !== entry.cursor.fixed_sha;
    const hash = receiptHash(pr.body);
    const rewrote = !pushed && hash !== null && !receiptHashes(pr.body).includes(entry.cursor.receipt_hash);
    const publicComments = entry.public_fix ? await currentPublicComments(entry) : [];
    const reworded = entry.public_fix && publicReviewHash(pr, publicComments) !== entry.public_fix;
    if (entry.public_fix && !pushed && !rewrote && !reworded) {
      if (await scheduleNetworkRecovery()) return false;
      await needsHuman(id, "public-format", { session, public_fix: null, last: { ...last, event: "public text correction made no change; inspect the PR wording before resuming" } });
      return false;
    }
    if (pushed || rewrote || reworded) {
      // A receipt/wording edit does not acknowledge feedback received while the run was active. Keep its event
      // boundary and dispatched keys so those findings reach the next run. Public-wording runs preserve pending
      // feedback even if they pushed, because they were not assigned that feedback in the first place.
      const preserveFeedback = !pushed || !!entry.public_fix;
      // Normal pushed rounds still move to the push, floored to GitHub's timestamp precision; feedback between
      // the push and settlement stays new. Only a missing push timestamp uses settlement as its fallback.
      const pushedAt = pushed ? await headPushedAt(entry, pr.headRefOid, now()) : null;
      const since = floorSecond(pushedAt);
      // The round is counted HERE, before the comment is attempted, and this ordering is the whole point. What
      // happened is a push: a harness run spent the operator's money and moved the branch on GitHub, and no later
      // failure can un-spend it. The comment is an announcement of that fact, and an announcement that will not send
      // does not make the fact untrue. The comment used to be the precondition of counting, which meant a refused
      // comment left the push on GitHub, the fix in the branch and `iteration` unchanged: the counter and the work
      // disagreed, and since `max_iterations` is the only bound on what one PR may spend, an undercount is a bound
      // that can be exceeded. Driven against the previous tree: an entry one round below the cap pushed its third
      // round, the comment was refused five times, and the entry stopped saying it had done two.
      //
      // So the local write goes first and the GitHub write goes last, which is the rule round seven derived: order a
      // pair so the irreversible half is last. Here the irreversible half already happened before this function was
      // called, so both remaining writes are recoverable and the one that can be replayed exactly (the comment, which
      // `commentOnce` makes idempotent against the marker) is the one left to a later tick.
      // `kind` decides which comment is owed and whether landing it starts the reviewer clock. `pushed_at` goes with a
      // pushed round only, because it is the committer date the clock is dated from and a receipt round has no push to
      // date it from; storing it on both would make the field mean two things.
      // GitHub truncates comment timestamps to whole seconds and marker lookup is strictly after its boundary.
      // Include the run-start second in both the REST fetch and local match, while excluding the prior second.
      const announcementSince = preserveFeedback ? fetchFrom(entry.last.at) : entry.cursor.since;
      const owed = pushed ? { kind: "round", since: announcementSince, pushed_at: pushedAt } : { kind: reworded ? "public-text" : "receipt", since: announcementSince };
      entry = save(id, {
        session, last, public_fix: null, network_retry: null, iteration: entry.iteration + 1,
        // Recorded as unsent, cleared the moment it lands. Same shape as `labels_pending`, which a stopped entry
        // carries for the same reason: the state has moved and one GitHub write is still owed, so the entry names the
        // debt and a later tick pays it. `retry` is NOT cleared here, because nothing has been written to GitHub yet;
        // it is cleared by the write landing, in `postRoundComment`.
        round_comment: owed,
        ...(pushed ? { verified_progress: { kind: "verified-push", at: now(), head: pr.headRefOid } } : {}),
        // `advanceCursor` refuses a candidate before the cursor, so a force-push to an older commit cannot drag the
        // boundary back and make the event that started this round new again.
        // The announcement boundary above is separate from preserved feedback: a marker from before this run
        // cannot pay its new round debt merely because the feedback cursor intentionally stayed behind it.
        cursor: { ...(preserveFeedback ? entry.cursor : advanceCursor(entry.cursor, since)), fixed_sha: pr.headRefOid, receipt_hash: hash },
        // The re-review is asked by the comment, not by this save, so the clock starts only once the comment lands
        // (`postRoundComment` writes it). Until then the entry keeps the ask it already had, which is older, so the
        // silence timer cannot be reset by a request that was never made.
      });
      log.info(`${id}: round ${entry.iteration} ${pushed ? "pushed" : reworded ? "updated the public review text" : "updated the completion receipt"}`);
      // The comment is NOT attempted here. It is attempted by the one step in `tickEntry` that owns it, which runs a
      // few lines later on this same pass, so the usual case is still one tick and there is still exactly one place
      // that posts this comment. Attempting it here as well cost the bound half its budget: two attempts on the tick
      // that counted the round, so five consecutive refusals arrived after three ticks rather than five.
      return false;
    }
    // A run that pushed nothing has not necessarily failed. Resuming an entry whose work was ALREADY pushed gives a
    // session nothing to do, and a session that correctly reports "everything is up to date" is the expected outcome of
    // that resume rather than a stop.
    //
    // Seen on a live run. The reviewer's clean verdict arrived as a comment the old code could not read, so the entry
    // looked stale and was resumed. The session found its work already on the branch at the head the cursor names,
    // changed nothing, and exited 0. `settleRun` then judged it by the only question it asked, "did the head move or the
    // receipt change", and stopped the entry `no-push` on a pull request that was ready to merge. `needs-human` is
    // terminal, so nothing ever asked the readiness question afterwards.
    //
    // The entry goes back to the watched state rather than being declared ready here. Readiness is one specific step's
    // decision, with its own checks, reviewer verdict and completion gate, and duplicating any part of that judgement
    // in the settle path is how two places come to disagree about when a PR is done. This says only what it knows: the
    // run is settled, nothing regressed, and the entry is still worth watching. The next tick judges it.
    if (await scheduleNetworkRecovery()) return false;
    if (outcome.ok) {
      save(id, { state: STATES.prOpen, session, last, retry: null });
      log.info(`${id}: the run pushed nothing and nothing regressed; back to watching so readiness is judged next tick`);
      return false;
    }
    await needsHuman(id, "harness-error", { session, last: { ...last, error: outcome.error } });
    return false;
  }

  /**
   * Spawn a fix run and move the cursor. `since` is the event boundary that was actually read, never the time the
   * spawn finished: `ensureWorktree` can spend minutes cloning, and anything created in that window would otherwise
   * fall behind the cursor and never be seen again. The caller passes the newest dispatched event's timestamp, or
   * the instant captured before the GitHub reads when there are no events.
   *
   * Because that boundary is inclusive (GitHub timestamps are only accurate to the second), the keys of the events
   * dispatched at exactly that second are recorded alongside it. A second event stamped the same second is read
   * again next tick and dispatched then; the ones already handled are recognised by key and skipped.
   */
  async function dispatch(id, entry, pr, spec, deferredDispatches = null) {
    try { deps.resourcePreflight?.(entry.worktree, true); }
    catch (error) {
      if (error.code !== "AUTHOR_STORAGE") throw error;
      save(id, { resource_wait: { code: "AUTHOR_STORAGE", reasons: error.resources?.blocked || [] } });
      return;
    }
    if (entry.resource_wait) entry = save(id, { resource_wait: null });
    const { name, events, denials = null, summary, since, publicFix = null, reviewKey = null } = spec;
    if (entry.dispatch_stopped) return;
    if (runnerFor(id).current()?.running || entry.last?.run && entry.last.exit == null) {
      log.info(`${id}: dispatch waiting for run in progress or unsettled result`); return;
    }
    const health = deps.providerHealth?.get(entry.harness, config.harness[entry.harness]?.account || "operator");
    if (health && !health.ok) {
      const refreshed = deps.providerHealth?.whenRefreshed?.(entry.harness, config.harness[entry.harness]?.account || "operator");
      if (deferredDispatches && refreshed) deferredDispatches.push({ id, entry, pr, spec, refreshed });
      log.info(`${id}: dispatch waiting for its provider/account health`); return;
    }
    if (capabilitiesFor(entry.harness).transport === "remote") {
      try { await requireVerificationSandbox(); }
      catch (error) {
        await needsHuman(id, "verification-sandbox-unavailable", { last: { ...entry.last, event: error.message } });
        return;
      }
    }
    // A checkout that cannot be recreated is not something the next poll will fix: a revoked token, a full disk, a
    // branch deleted on the remote, an unmounted worktrees volume. Left to the per-entry catch in `tick` it logged one
    // line to errors.log every `poll_seconds` forever, with the state, the cursor and the iteration untouched and
    // nothing notified, because `notify.error` is only ever reached from the daemon's probe loop. Same treatment as
    // the context_paths refusal below: stop, name the cause, ring once.
    try { await ensureWorktree(id, entry); }
    catch (e) {
      await needsHuman(id, "no-worktree", { last: { at: now(), event: `cannot recreate ${entry.worktree}: ${e.message}` } });
      return;
    }
    // The base branch, brought in before this round starts. It is here rather than further down for two reasons: the
    // worktree has to exist first, and the prompt below has to be able to tell the session what the merge brought in.
    // Nothing on GitHub moves, so this is safe to do before the label write and before the spawn, and the record of it
    // is written by `mergeBaseInto` itself rather than by the save at the end of this function, which four early
    // returns below can skip.
    //
    // Record and abort the initial conflict, then use the same bounded repair
    // coordinator as host-reported conflicts. Transport failures stay retries.
    let merged;
    try { merged = await mergeBaseInto(id, entry); }
    catch (error) {
      if (isBaseRepairError(error) || error.code === "AGENTS_DIRTY_SOURCE") await stopRepair(id, error);
      else await retryFailed(id, entry, "base merge", error, { action: "retrying Git base observation without dispatch" });
      return;
    }
    if (merged?.busy) return;
    if (merged?.conflict) {
      await repairBaseConflict(id, state.get(id), pr, merged);
      return;
    }
    // `mergeBaseInto` saved the merge, so the entry in hand is one read behind whenever it merged. Re-read rather than
    // patch it here: every later step in this function reads `entry`, and one of them writing a stale `base_merge` back
    // would undo the record that was just made.
    if (merged?.merged) entry = state.get(id) ?? entry;
    const fix = { repo: entry.repo, pr: entry.pr, headSha: pr.headRefOid, events, receipt: receiptFor(id), denials, merged: merged?.merged ? merged : null };
    const previousHarness = entry.execution_handoff?.from ?? (entry.execution?.provider !== entry.harness ? entry.execution?.provider : null);
    // Recovery from a lost registry rebuilds the entry from the PR block, so
    // neither of those fields survives. The durable ledger epoch still proves
    // this is a cross-harness takeover and calls for the same context prompt.
    const handoff = !entry.session && (previousHarness || runnerFor(id).ledgerEpoch > 0)
      ? `The operator switched this PR from ${previousHarness || "a previous harness"} to ${entry.harness}. This is a new provider session; the previous conversation is unavailable. Before editing, read the approved brief${entry.prd ? ` at ${entry.prd}` : " if one is recorded"}, its carried files, the PR and review threads, and the local checkout's status and unpushed commits. Preserve existing work and review unresolved feedback. The brief's original harness field records its starting route; this explicit PR reset selected ${entry.harness} for subsequent work.`
      : null;
    const prompt = entry.session
      ? fixPrompt({ host: (deps.hosts ?? hosts).select(entry).adapter.prompts, ...fix, verify: verifyFor(id) })
      : `${registerPrompt({ host: (deps.hosts ?? hosts).select(entry).adapter.prompts, repo: entry.repo, pr: entry.pr })}${handoff ? `\n\n${handoff}` : ""}\n\n${fixPrompt({ host: (deps.hosts ?? hosts).select(entry).adapter.prompts, ...fix, verify: [] })}`;
    // The invariant: a spawned run must be recorded before anything else can fail. Everything that can throw goes
    // above the spawn, and the state that owns the run is saved immediately below it with no await in between. A
    // process running that the registry does not know about is the worst state this function can leave: `settleRun`
    // reads it as an unrelated leftover and ignores it, the cursor never records the feedback that caused it, and
    // when it exits the same feedback spawns a second fixer against a tree the first one is still editing.
    //
    // The ready label is what used to sit in that gap. `reopen` is a GitHub write, so a rate-limited or briefly
    // unreachable GitHub threw after the process was already going and the save below never ran. It now happens
    // before the spawn: a failure here is the same tick doing nothing, which the next tick repeats from an untouched
    // cursor, and the label the removal was for is only wrong for as long as the entry is not yet dispatching.
    //
    // And the wait is bounded. Declining the dispatch is right, but declining it forever is not: a token that cannot
    // write labels at all never recovers, and the entry would sit in `ready` with feedback waiting and a `log.warn` per
    // tick as its only trace. `retryFailed` counts the consecutive failures of this write on the entry and stops it with
    // `stuck` at `MAX_STEP_FAILURES`, through the same mechanism the block write uses.
    try { await reopen(id, entry); }
    catch (e) {
      await retryFailed(id, entry, READY_LABEL_REMOVAL, e, { action: `not dispatching ${summary} until it is off` });
      return;
    }
    // Reaching here means the write is not what is holding this entry back, whether `reopen` wrote anything or was a
    // no-op for a `pr-open` entry, so the count goes. `retryOk` writes nothing when there is nothing to clear.
    entry = retryOk(id, entry);
    // A harness that refuses the configured context_paths will refuse identically on every tick, so retrying is a
    // loop, not a recovery. Stop the entry and name the reason instead: the fix is an operator edit to the config or
    // to the brief's harness, and nothing the daemon can do on its own.
    let started;
    const ownership = { state: STATES.prOpen, reason: null, public_fix: publicFix, lastEvent: summary,
      cursor: { ...advanceCursor(entry.cursor, since, events.filter(e => e.id != null && sameInstant(e.at, since)).map(eventKey)), fixed_sha: pr.headRefOid, receipt_hash: receiptHash(pr.body), ...(events.some(e => e.kind === "check") ? { checks_sha: pr.headRefOid } : {}) } };
    try { started = await startRun(id, entry, { name, prompt, ownership, paths: events.map(e => e.path).filter(Boolean),
      beforeDispatch: reviewKey ? () => {
        const current = state.get(id);
        if (current.firstPartyReview?.key !== reviewKey) throw new Error("review findings changed before dispatch; re-evaluate the current input");
        save(id, reviewDispositionPatch(id, current, reviewKey, { status: "dispatch-intent", at: now(), round: entry.iteration + 1 }));
      } : null }); }
    catch (e) {
      if (e.code === "PR_IDENTITY") return;
      if (e.code === "PLAN_ITERATIONS") {
        if (reviewKey) save(id, reviewDispositionPatch(id, state.get(id), reviewKey, { status: "rounds-exhausted", round: null }));
        await needsHuman(id, "iterations", { last: { at: now(), event: summary } });
        return;
      }
      if (recoveryDispatchDeferred(e)) {
        await retryFailed(id, entry, "dispatch preflight", e, { action: "retrying dispatch checks on the next poll" });
        return;
      }
      if (["AUTHOR_STORAGE", "AUTHOR_CAPACITY"].includes(e.code) || coolingDown(e) || transientServiceFailure(e) && e.status) {
        if (reviewKey) save(id, reviewDispositionPatch(id, state.get(id), reviewKey, { status: "pending", round: null }));
        if (e.code === "AUTHOR_STORAGE") save(id, { resource_wait: { code: e.code, reasons: e.resources?.blocked || [] } });
        return;
      }
      // One run per entry is the lock, and the runner enforces it. A leftover run this entry never dispatched can be
      // holding it: `settleRun` now ignores such a run rather than waiting on it, which is right, but it means the
      // dispatch can arrive while the runner is still busy. That is a wait, not an error, and it resolves when the
      // leftover ends. The cursor is not moved, so the same feedback is dispatched on the tick that finds it free.
      if (e.code === "BUSY") {
        if (reviewKey) save(id, reviewDispositionPatch(id, state.get(id), reviewKey, { status: "pending", round: null }));
        log.info(`${id}: ${e.message}; dispatching ${summary} once it is free`); return;
      }
      if (e.dispatchNotSent === true) {
        if (reviewKey) save(id, reviewDispositionPatch(id, state.get(id), reviewKey, { status: "pending", round: null }));
        await needsHuman(id, "dispatch-refused", { last: { ...entry.last, at: now(), event: "managed dispatch refused before any provider request; repair prerequisites and explicitly resume" } });
        return;
      }
      if (e.code === "PROVIDER_UNAVAILABLE") { log.info(`${id}: dispatch waiting for its provider/account health`); return; }
      // No credential is an operator problem, not a transient one: retrying every tick would spend nothing but would
      // also never resolve, and the entry would sit `pr-open` with feedback nobody is acting on. Stop it and say so.
      if (e.code === "PACKAGE_AUTH") { await needsHuman(id, "dependency-auth", { last: { ...entry.last, at: now(), event: e.message } }); return; }
      if (e.code === "NO_CREDENTIAL") { await needsHuman(id, "no-credential", { last: { at: now(), event: e.message.split("\n")[0] } }); return; }
      // No git identity is the same shape as no credential and needed saying separately, because it reached here and
      // fell through. `startRun` calls `requireIdentity`, which throws `NO_IDENTITY`; unhandled, it landed in the
      // per-entry catch in `tick`, which only logs. State and cursor untouched means the same feedback is redispatched
      // every `poll_seconds` forever with nothing notified, which is precisely the failure the `no-worktree` stop above
      // was added to end. Stop it, ring once, and name the two commands that fix it: the operator runs them and
      // `gallivant resume` picks the entry back up. `NO_IDENTITY`'s own message is those commands, so the whole of it
      // goes on `last.event` rather than the first line, which on its own would say a thing is wrong and not what to do.
      if (e.code === "NO_IDENTITY") { await needsHuman(id, "no-identity", { last: { at: now(), event: e.message } }); return; }
      if (!/context_paths/.test(e.message)) throw e;
      await needsHuman(id, "context-paths", { last: { at: now(), event: e.message } });
      return;
    }
    // No await between the spawn above and this save: the run is recorded, then anything else may fail.
    const { job, session, managed } = started;
    const dispatchedChecks = events.some(e => e.kind === "check");
    state.update(id, current => ({
      ...learningDeliveryPatch(current, managed, job), updated_at: now(),
      ...reviewDispositionPatch(id, current, reviewKey, { status: "dispatched", at: now(), run: job.id }),
      state: STATES.prOpen, session, brief_changes: null, public_fix: publicFix,
      // The cursor and the keys handled at it move together: everything dispatched in the boundary second is
      // remembered, so an event sharing that second is still read next tick but never sent a second time.
      cursor: { ...advanceCursor(entry.cursor, since, events.filter(e => e.id != null && sameInstant(e.at, since)).map(eventKey)), fixed_sha: pr.headRefOid, receipt_hash: receiptHash(pr.body), ...(dispatchedChecks ? { checks_sha: pr.headRefOid } : {}) },
      last: { at: now(), run: job.id, exit: null, event: summary },
    }));
    await learningDelivered({ ...deps, learning }, id);
    log.info(`${id}: dispatched (${summary})`);
  }

  /** A fix round, or a stop when the round budget is spent. */
  async function fixOrStop(id, entry, pr, spec, deferredDispatches = null) {
    if (entry.reviewPolicy?.version === 1 && entry.state === STATES.ready) {
      try { await reopen(id, entry); entry = state.get(id); }
      catch (error) { await retryFailed(id, state.get(id), READY_LABEL_REMOVAL, error, { action: "readiness invalidated; retrying label removal" }); return; }
    }
    if (needsFirstParty(entry.reviewPolicy) && deps.reviewService?.cancel) await deps.reviewService.cancel(id, "author feedback dispatched; prior review input invalidated");
    if (entry.iteration >= iterationLimit(id, entry)) { await needsHuman(id, "iterations", { last: { at: now(), event: spec.summary } }); return; }
    await dispatch(id, entry, pr, spec, deferredDispatches);
  }

  /**
   * "Green" for a head that has no checks yet: GitHub reports an empty rollup for the first seconds after a push,
   * before any workflow is queued. A young head with nothing reported is not green, it is not reported yet.
   */
  async function checksSettled(entry, pr, ci = null) {
    const pilot = pilotFor(entry);
    const required = ungatedRequirements(reviewConfigFor(entry).required_checks, pilot);
    const rollup = ungatedRollup(pr, pilot);
    const repaired = entry.base_repair;
    if (repaired?.journal && (pr.statusCheckRollup ?? []).some(check => check.headSha !== pr.headRefOid)) return false;
    if (repaired?.journal?.ci && (!repaired.journal.ciClear ||
        !(pr.statusCheckRollup ?? []).some(check => check.outcome === "passed" && check.name === repaired.journal.ci.checkName))) return false;
    if (deferred(entry)) return Boolean(pilot && ci?.proof && isGreen(rollup, required));
    if (required.length || (pr.statusCheckRollup || []).length) return isGreen(pr.statusCheckRollup, required);
    if (entry.reviewPolicy?.version === 1) return entry.reviewPolicy.zeroChecks === true;
    const pushedAt = await headPushedAt(entry, pr.headRefOid, entry.cursor.since);
    return clock.now() - Date.parse(pushedAt) > minutes(config.checks_grace_minutes);
  }

  async function observeRepairCI(id, entry, pr) {
    const op = entry.base_repair, original = op?.journal?.ci;
    if (!original || op.status !== "verified" || pr.isDraft || pr.headRefOid !== op.remoteSha ||
        op.journal.ciClear?.head === pr.headRefOid || observedIdentityProblem(entry, { ...pr, strictIdentity: true })) return entry;
    for (const check of (pr.statusCheckRollup ?? [])) {
      if (check.outcome !== "passed" || check.name !== original.checkName || check.headSha !== pr.headRefOid) continue;
      const proof = await host.repairCIEvidence?.(entry.repo, { pr, check, baseSha: op.baseSha, original });
      if (!proof || proof.kind !== "cleared" || proof.head !== op.remoteSha) continue;
      recordRepair(deps, id, op, { journal: { ...op.journal, ciClear: proof } });
      verifyRecoveryOutcome(state, id, entry.execution, "ci-repair", [op.journal.ci, proof]);
      return state.get(id);
    }
    return entry;
  }

  async function recoverFailedCI(id, entry, pr) {
    const wait = reason => save(id, { recovery_wait: { phase: "waiting-external", reason } });
    if (entry.base_repair?.journal?.ci && !entry.base_repair.journal.ciClear) {
      wait("The original failed job has not cleared on the repaired head. Inspect the preserved job and verification.");
      return;
    }
    try {
      if (recoveryHeld(state.load(), id, entry) || pr.isDraft) return;
      if (entry.state === STATES.ready) {
        await reopen(id, entry);
        entry = save(id, repairInvalidation(state.get(id)));
      }
      if (observedIdentityProblem(entry, { ...pr, strictIdentity: true })) {
        wait("Restore the approved PR branch and target before diagnosing CI."); return;
      }
      const baseSha = await git.fetchBranchHead(entry.worktree, entry.base);
      if (pr.baseRefOid && pr.baseRefOid !== baseSha) { wait("Host and Git base evidence differ. Wait for a consistent observation."); return; }
      const failures = ungatedRollup(pr, pilotFor(entry)).filter(check => check.outcome === "failed");
      const check = failures.length === 1 && failures[0];
      const evidence = check && await host.repairCIEvidence?.(entry.repo, { pr, check, baseSha });
      if (!evidence || evidence.head !== pr.headRefOid) { wait("Obtain canonical job, attempt and pinned-base evidence before author repair."); return; }
      if (evidence.kind === "infrastructure" || evidence.kind === "base-regression") {
        wait(evidence.kind === "infrastructure" ? "Resolve the CI infrastructure failure at its source." : "The same job fails on the pinned base. Resolve the upstream regression.");
        return;
      }
      const scoped = await scopeCIFailure(deps, id, entry, baseSha, evidence);
      if (!scoped) { wait("The failing job does not identify an approved changed implementation target and unchanged verification scope."); return; }
      await beginJournalRepair(id, entry, pr, baseSha, { ...scoped, checkName: check.name });
    } catch (error) {
      wait(error.code === "NO_CREDENTIAL" ? "Restore read access to the original CI job and its pinned-base comparison."
        : "The host or Git could not supply exact CI evidence. Retain the original failure and inspect its job.");
    }
  }

  // Integration is an external observation, never merge authority. Reuse the
  // readiness proof and existing reviewer/check predicates; an early merge or
  // changed head/receipt/review cannot convert an unqualified delivery to done.
  async function terminalCompletion(id, entry, pr, dependencyBound = false) {
    const terminal = { adapter: completionAdapter(entry.repo, deps.hosts ?? hosts), state: pr.state, repository: entry.repo, pr: entry.pr,
      head: pr.headRefOid, base: pr.baseRefName || null, observedAt: now(), mergedAt: pr.mergedAt || null, mergeCommit: pr.mergeCommit?.oid || null };
    const evidence = { ...entry.completionEvidence, terminal };
    if (pr.state === "MERGED") {
      const delivery = evidence.delivery;
      const readyAt = Date.parse(delivery?.observedAt), mergedAt = Date.parse(terminal.mergedAt);
      let qualified = false, reason = "Integration was observed without a matching canonical ready decision.";
      const requiredGate = config.deliverable?.evaluator === "aport" ? delivery?.gate?.source === "aport" && Boolean(delivery.gate.decisionId) : true;
      if (entry.state === STATES.ready && !entry.dispatch_stopped && delivery?.gate?.allow === true && !delivery.invalidatedAt &&
          (!dependencyBound || requiredGate && matchingDeliveryEvidence(entry) && delivery.checks?.settled === true &&
            ["clear", "none"].includes(delivery.reviewer?.verdict)) &&
          delivery.head === pr.headRefOid && delivery.base === pr.baseRefName && delivery.receiptHash === receiptHash(pr.body) &&
          Number.isFinite(readyAt) && Number.isFinite(mergedAt) && mergedAt >= readyAt && terminal.mergeCommit) {
        const [reviews, inline, comments] = await readFeedback(host, entry.repo, pr, fetchFrom(earlier(entry.rereview.at, entry.public_since)), fetchFrom(earlier(entry.rereview.at, entry.public_since)));
        const external = await externalVerdict(entry, { reviews, inline, comments, config: reviewConfigFor(entry), trust: trustFor(entry), sinceIso: entry.rereview.at, headSha: pr.headRefOid, dispatched: entry.cursor.dispatched });
        const verdict = reviewVerdict(entry.reviewPolicy, external, entry.firstPartyReview, reviewBinding(pr, entry.reviewPolicy));
        const pending = deriveEvents({ pr: { ...pr, statusCheckRollup: ungatedRollup(pr, pilotFor(entry)) }, reviews, inline, comments, entry, trust: trustFor(entry) }).events;
        const publicIssues = [...publicPrViolations(pr), ...publicCommentViolations(ownPublicComments(entry, [...comments, ...inline, ...reviews.map(r => ({ ...r, public_kind: "review" }))]))];
        const ci = deferred(entry) ? { proof: await terminalDeferredChecks(deps, id, entry, pr) } : null;
        qualified = await checksSettled(entry, pr, ci) && ["clear", "none"].includes(verdict.verdict) && !pending.length && !publicIssues.length &&
          !requiredFeedback({ reviews, inline, trust: trustFor(entry), headSha: pr.headRefOid }).length &&
          (!entry.reviewPolicy || entry.reviewPolicy.version === 0 || entry.reviewBinding === reviewBinding(pr, entry.reviewPolicy));
        reason = qualified ? null : "Integration was observed after checks, reviewer feedback or public delivery evidence changed.";
      }
      evidence.integration = { ...terminal, qualified, reason };
    }
    return { completionEvidence: evidence };
  }

  // One terminal transition for the ordinary poll and network recovery. Cleanup
  // cannot grant readiness, a merge, or acceptance; those observations stay intact.
  async function finishTerminal(id, entry, pr, patch = {}) {
    if (entry.state === STATES.needsHuman) {
      const run = runnerFor(id).current();
      if (run?.running || executionLive(run) || (!run?.execution && executionLive(entry)) ||
          entry.last?.run && (!run || run.id !== entry.last.run || entry.last.exit == null)) return;
    }
    const chainBound = dependencyProducer(id, entry);
    const needsTerminal = entry.task?.completion || entry.base_repair || chainBound || entry.recovery_profile || deferred(entry) || entry.state === STATES.needsHuman;
    let evidence = {};
    if (needsTerminal) {
      if (entry.state !== STATES.done || !entry.completionEvidence?.integration) evidence = await terminalCompletion(id, entry, pr, chainBound);
      else if (chainBound && !entry.completionEvidence.terminal) {
        const { completionEvidence } = await terminalCompletion(id, entry, pr, chainBound);
        evidence = { completionEvidence: { ...entry.completionEvidence, terminal: completionEvidence.terminal } };
      }
    }
    const ownsCloseout = current => current && current.pr === entry.pr && current.branch === entry.branch &&
      current.base === entry.base && current.repo === entry.repo && current.last?.run === entry.last?.run &&
      current.start_token === entry.start_token && current.dispatch_stopped === entry.dispatch_stopped &&
      current.control?.id === entry.control?.id && !controlPending(current.control) &&
      current.execution?.operationId === entry.execution?.operationId &&
      isDeepStrictEqual(current.completionEvidence?.delivery, entry.completionEvidence?.delivery);
    const current = state.get(id);
    if (!ownsCloseout(current)) return;
    // A host-confirmed merge is the maintainer's integration decision, including
    // after a repair. Missing readiness stays unqualified in the evidence; it
    // cannot keep a terminal PR open in the registry or require another fix run.
    const settled = mergeCleanupSettled(current, { pr: entry.pr, head: pr.headRefOid });
    if (deps.cleanupMergedWorkspace && !settled) {
      const cleanup = pr.state === "MERGED"
        ? await deps.cleanupMergedWorkspace(id, entry, pr, { assertCoordinatorOwner: deps.assertCoordinatorOwner })
        : { status: "retained", state: pr.state, reason: "PR closed without merging" };
      if (!ownsCloseout(state.get(id))) return;
      const record = { ...cleanup, at: now() };
      if (cleanup.status === "pending") {
        save(id, { ...patch, workspace_cleanup: record, cleanup_check_at: clock.now() + config.poll_seconds * 1000 }, undefined, ownsCloseout);
        log.warn(`${id}: merged; cleanup pending (${cleanup.reason})`);
        return;
      }
      patch = { ...patch, workspace_cleanup: record, ...(cleanup.status === "done" ? { runtime_cleanup: null } : {}) };
      if (cleanup.status === "retained") log.warn(`${id}: retained workspace (${cleanup.reason})`);
    }
    const closed = save(id, { state: STATES.done, reason: null, retry: null, network_retry: null,
      last: { ...entry.last, event: `PR ${pr.state.toLowerCase()}` },
      activity_at: entry.state === STATES.done ? entry.activity_at : now(), ...patch, ...evidence },
    patch.workspace_cleanup ? { durable: true } : undefined, ownsCloseout);
    if (closed.state === STATES.done) log.info(`${id}: ${pr.state.toLowerCase()}`);
  }

  // A maintainer can integrate while an author is still retrying a provider or
  // waiting on CI. Observe that irreversible host decision at the usual cadence
  // and retire only the exact accepted run. Its ledger owns cancellation retries
  // and quarantine; a merge neither grants readiness nor discards local work.
  async function retireMergedRun(id, entry, execution, { publicationHeld = false } = {}) {
    let run = execution.current();
    const ex = run?.execution;
    if (!entry.pr || !entry.base || !run || entry.last?.run !== run.id ||
        ex?.taskId !== id || ex.runId !== run.id || ex.provider !== entry.harness || ex.acceptance !== "accepted" ||
        ex.account !== execution.account || ex.transport !== execution.capabilities?.transport ||
        ex.transport === "remote" && !ownedRemoteExecution(ex) || typeof execution.cancel !== "function") return false;
    const stopped = execution.state?.().stopped;
    if (stopped && stopped !== "pr-merged") return false;
    const retiring = stopped === "pr-merged";
    if (retiring && (run.running || executionLive(run))) { save(id, { execution: ex }); return true; }
    // Exited local authors settle normally. Hosted results awaiting collection
    // or held before publication still need quarantine after a proved merge.
    const live = ex.transport === "remote" ? executionLive(run) : run.running;
    const settledPublication = publicationHeld && ex.transport === "remote" && !live && run.exit != null;
    if (!retiring && (!(live || settledPublication) || ex.quarantined)) return false;
    const retirementAuthority = current => {
      // Queued corrections wait for the writer. Quarantining a collected result
      // records terminal closeout and must never start a provider stop.
      const waiting = controlWaitsForRun(current.control);
      if (controlPending(current.control) && !waiting ||
          current.dispatch_stopped && current.dispatch_stopped !== "recovery-profile-revoked") return null;
      const recovery = state.recoverySettings ? state.recoverySettings() : state.load().recovery;
      const registry = { recovery };
      if (!settledPublication && recoveryHeld(registry, id, waiting ? { ...current, control: null } : current)) return null;
      const profile = recovery?.profiles?.find(row => row.digest === current.recovery_profile?.digest);
      return [current.recovery_profile, profile?.digest, current.hold, current.repository_disabled,
        current.dispatch_stopped, recoveryFences(registry, id, current, profile)];
    };
    const authority = retiring ? null : retirementAuthority(entry);
    if (!retiring && !authority) return false;
    // Confirmation gets one immediate final observation. Subsequent I/O failures
    // or pending cleanup keep the existing bounded host cadence, including after
    // a daemon restart. Never send another cancellation for an accepted intent.
    const justSettled = retiring && entry.last.exit == null;
    if (justSettled) entry = save(id, { execution: ex, last: { ...entry.last, exit: run.exit ?? 1 } });
    if (!justSettled && entry.review_next_at > clock.now()) return retiring;
    entry = save(id, { review_next_at: clock.now() + config.poll_seconds * 1000 });
    try {
      const pr = await host.prView(entry.repo, entry.pr);
      if (pr.state !== "MERGED") return retiring;
      // Cancellation requires the full immutable host identity and ancestry even
      // when an older observation adapter did not opt into strict polling.
      const problem = await terminalIdentityProblem(host, entry, { ...pr, strictIdentity: true });
      if (problem) { log.warn(`${id}: merged author retained (${problem})`); return retiring; }
      if (!retiring) {
        const latest = state.get(id);
        if (latest?.last?.run !== run.id || latest.pr !== entry.pr || latest.repo !== entry.repo ||
            latest.base !== entry.base || latest.branch !== entry.branch || latest.url !== entry.url || latest.harness !== entry.harness ||
            !isDeepStrictEqual(authority, retirementAuthority(latest))) return false;
        await execution.cancel("pr-merged", { runId: run.id, operationId: ex.operationId,
          profile: ex.recoveryProfileDigest, settledRemote: settledPublication });
      }
      run = execution.current();
      if (run?.id !== entry.last.run) return true;
      if (run.running || executionLive(run)) { save(id, { execution: run.execution }); return true; }
      entry = save(id, { execution: run.execution, last: { ...entry.last, exit: run.exit ?? 1 } });
      // Superseded messages/resumes must reach their normal terminal-PR result
      // before cleanup, which deliberately retains a checkout with pending input.
      // A queued task cancellation keeps its separate cancellation consumer.
      if (controlPending(entry.control)) {
        if (entry.control.action === "cancel") return true;
        await applyControl(authorContext(), id);
        entry = state.get(id);
      }
      await finishTerminal(id, entry, pr);
      return true;
    } catch (error) {
      // A host outage cannot terminate valid work, and an ambiguous cancellation
      // remains owned by its ledger rather than authorizing another API action.
      log.warn(`${id}: merged-author observation deferred (${error.code || "host/execution unavailable"})`);
      return execution.state?.().stopped === "pr-merged";
    }
  }

  async function observeCleanup(id, entry) {
    if (!cleanupObservers.has(id) || controlPending(entry.control)) return;
    save(id, { cleanup_check_at: clock.now() + config.poll_seconds * 1000 });
    const pr = await host.prView(entry.repo, entry.pr);
    if (!["MERGED", "CLOSED"].includes(pr.state)) return;
    const canonical = entry.state === STATES.done && (entry.chain || state.chains().some(([, c]) => c.after?.id === id)) ? { ...pr, strictIdentity: true } : pr;
    const problem = pr.state === "MERGED" ? await terminalIdentityProblem(host, entry, canonical) : observedIdentityProblem(entry, canonical);
    if (problem) { log.warn(`${id}: workspace retained (${problem})`); return; }
    await finishTerminal(id, entry, pr);
  }

  async function reconcileResults(id, entry, execution, { readOnly = false } = {}) {
    const run = execution.current();
    const stopPublication = async () => {
      const checkpoint = executionResultCheckpoint(execution, run);
      if (checkpoint?.phase !== "blocked") return false;
      // Collection may have settled (or another writer advanced) the run after
      // this tick's snapshot. Persist only the same run's current provider state.
      const settled = execution.current();
      if (settled?.id !== run.id) return true;
      entry = state.get(id) || entry;
      if (entry.last?.run !== run.id || entry.dispatch_stopped) return true;
      if (entry.state !== STATES.needsHuman || entry.reason !== "result-verification" || entry.last?.exit == null) {
        const outcome = execution.outcome(run.id);
        await needsHuman(id, "result-verification", {
          execution: settled.execution, session: entry.session || execution.sessionFrom(run.id),
          last: { ...entry.last, at: now(), exit: settled.exit ?? (outcome.ok ? 0 : 1), cost: outcome.cost, denials: outcome.denials,
            event: `result publication blocked (${checkpoint.reason}); inspect result-application.json, result.json and any verification.json, then explicitly resume for correction` },
        });
      }
      return true;
    };
    if (!run?.execution?.quarantined && await stopPublication()) return true;
    const savedResult = run && execution.result?.(run.id);
    const publicationPending = savedResult?.outcome?.ok === true && (savedResult.files || savedResult.pushedHead) &&
      (!entry.pr || executionResultCheckpoint(execution, run)?.phase !== "published");
    if (!run?.execution?.quarantined && (run?.execution?.providerState === "retrieving-results" || publicationPending) && execution.capabilities?.transport === "remote") {
      if (readOnly) return false;
      try {
        const deferHeldPublication = async () => {
          entry = state.get(id) || entry;
          if (!executionPublicationHeld(deps, id, entry)) return false;
          // Keep this run unsettled until authority returns or a merge settles it.
          await retireMergedRun(id, entry, execution, { publicationHeld: true });
          return true;
        };
        if (publicationPending && run.execution.collected && await deferHeldPublication()) return false;
        const result = await execution.collect();
        recordAuthorSettlement(id, execution, execution.current());
        // Transports return artifacts or an exact pushed head. Only this shared
        // boundary may materialize and publish them into the normal review loop.
        if (result?.outcome?.ok === true && (result.files || result.pushedHead)) {
          if (await deferHeldPublication()) return false;
          const published = await reconcileExecutionResult(deps, { id, entry: { ...entry, execution: run.execution }, result, dir: execution.dirOf(run.id) });
          save(id, { pr: published.pr.number, url: published.pr.url,
            verified_progress: { kind: "published-result", at: now(), head: published.head } });
        }
      }
      catch (error) {
        log.warn(`${id}: results unresolved (${error.code || "collection failed"})`);
        if (["EXECUTION_RESULT", "EXECUTION_RESULT_BLOCKED"].includes(error.code) && await stopPublication()) return true;
        return false;
      }
    }
    return true;
  }

  async function recoverNetwork(id, entry) {
    const retry = entry.network_retry;
    if (retry && !validNetworkRetry(retry)) {
      await needsHuman(id, "network-recovery-unverified", { network_retry: null });
      return true;
    }
    if (retry?.phase === "reconciling") return true; // Settlement must reconcile published work first.
    if (!retry || retry.phase === "running" || retry.phase === "exhausted" || retry.phase === "blocked") return false;
    if (entry.state === STATES.done || controlPending(entry.control)) return true;
    if (recoveryHeld(state.load(), id, entry)) return false; // Let the ordinary poll observe a terminal PR.
    const runner = runnerFor(id), run = runner.current();
    const deadline = networkRecoveryDeadline(retry);
    const scoped = deps.cooldowns?.deferred(providerScope(entry.harness, run?.execution?.account || config.harness[entry.harness]?.account || "operator"));
    const due = !scoped && clock.now() >= Date.parse(retry.next_at);
    const expired = () => clock.now() >= deadline;
    const retryAfterBudget = () => ({ ...retry, phase: "waiting",
      next_at: new Date(Math.min(deadline, clock.now() + config.poll_seconds * 1000)).toISOString() });
    const ownsRetry = current => current?.state === entry.state && current.reason === entry.reason && current.last?.run === retry.run &&
      isDeepStrictEqual(current.network_retry, retry) && !recoveryHeld(state.load(), id, current);
    const exhaust = async current => {
      if (!ownsRetry(current)) return;
      // Preserve any staged epoch and operation for the execution owner to inspect.
      await needsHuman(id, "provider-network-exhausted", {
        network_retry: { ...retry, phase: "exhausted", next_at: null },
        recovery_wait: current.route_recovery ? { phase: "blocked-authority", reason: "Retry window expired. Inspect the saved handoff and execution ledger." } : null,
      });
    };
    const handoffEnabled = entry.recovery_profile && state.load().recovery?.profiles.find(p => p.digest === entry.recovery_profile.digest)
      ?.recipes.some(r => r.id === "route-handoff");
    const handoffDue = retry.phase === "waiting" && due && (entry.route_recovery || handoffEnabled && retryPlan(retry.code).kind === "provider availability");
    if (handoffDue && !expired()) {
      if (entry.review_next_at > clock.now()) return true;
      save(id, { review_next_at: clock.now() + config.poll_seconds * 1000 });
      try {
        if (entry.iteration >= iterationLimit(id, entry) || entry.reason !== "provider-network" ||
            recoveryHeld(state.load(), id, entry)) throw new Error("Task disposition prevents handoff.");
        const checkPr = async () => {
          const health = deps.providerHealth?.get(entry.route_recovery?.from ?? entry.harness, run?.execution?.account || "operator");
          if (health && !health.ok && !["MODEL_CAPACITY", "SERVICE_BUSY", "RATE_LIMITED"].includes(health.code))
            throw new Error("Restore the approved source account before handoff.");
          if (!entry.pr) {
            if (entry.url || entry.completionEvidence?.terminal || await git.currentBranch(entry.worktree) !== entry.branch ||
                !remoteMatches(await git.originOf(entry.worktree), entry.repo) ||
                (await host.prListByHead(entry.repo, entry.branch, { allStates: true })).length)
              throw new Error("Resolve the original branch publication before handoff.");
            return;
          }
          const pr = await host.prView(entry.repo, entry.pr), canonical = { ...pr, strictIdentity: true };
          if (observedIdentityProblem(entry, canonical)) throw new Error("Handoff PR identity differs.");
          if (pr.state !== "OPEN") {
            if (pr.state === "CLOSED" || !await terminalIdentityProblem(host, entry, canonical)) await finishTerminal(id, state.get(id), pr);
            throw new Error("Handoff PR is terminal.");
          }
        };
        await checkPr();
        const { plan, marker, handoff } = await prepareRecoveryHandoff(deps, id);
        const current = state.get(id), operation = runnerFor(id).current();
        if (operation) return true; // The progress owner reconciles its original reservation.
        const workflow = { state: current.pr ? STATES.prOpen : STATES.running, reason: null, route_recovery: null, recovery_wait: null,
          network_retry: { ...retry, phase: "running", attempts: retry.attempts + 1, next_at: null }, lastEvent: "continued in approved new provider session" };
        const prompt = ["Continue this approved task in a new provider session. Read the approved brief and its private carried inputs in the checkout.",
          "Preserve the existing commits, dirty work, PR, evidence and review obligations. Recheck the branch and PR before any external action.",
          "The previous provider's native memory is unavailable. Use only the approved contract and checked-out evidence.",
          JSON.stringify(handoff), `Approved brief: ${current.prd}`].join("\n");
        const { job, session, managed } = await startRun(id, current, { name: "handoff", operationId: marker.operation, recovery: plan,
          ownership: workflow, prompt, beforeDispatch: checkPr, dispatchDeadline: deadline });
        const { lastEvent, ...fields } = workflow;
        save(id, { ...fields, ...learningDeliveryPatch(current, managed || {}, job), session, execution: job.execution,
          last: { run: job.id, at: now(), exit: null, event: lastEvent } });
      } catch (error) {
        const current = state.get(id);
        if (expired()) await exhaust(current);
        else if (ownsRetry(current)) {
          if (recoveryDispatchDeferred(error)) save(id, { network_retry: retryAfterBudget() });
          else save(id, { recovery_wait: { phase: "blocked-authority",
            reason: error.code === "RECOVERY_AUTHORITY" ? error.message : "Inspect the original handoff and provider ownership." } });
        }
      }
      return true;
    }
    if (retry.phase === "launching" || !entry.route_recovery &&
        (!run || run.id !== retry.run || run.running || entry.last?.run !== retry.run || entry.last.exit == null)) {
      await needsHuman(id, "network-recovery-unverified", { network_retry: { ...retry, phase: "blocked" } });
      return true;
    }
    const health = deps.providerHealth?.get(entry.harness, config.harness[entry.harness]?.account || "operator");
    // Keep observing maintainer merges at the shared host cadence, including
    // while provider health is pending. Pull the last pre-deadline observation
    // forward to the retry deadline so backoff never adds an extra poll period.
    let observed = false;
    if (entry.pr && (due && (!health || health.ok) || !(entry.review_next_at > clock.now()))) {
      const nextPoll = clock.now() + config.poll_seconds * 1000;
      entry = save(id, { review_next_at: due ? nextPoll : Math.min(nextPoll, Date.parse(retry.next_at)) });
      try {
        const pr = await host.prView(entry.repo, entry.pr);
        observed = true;
        if (pr.state !== "OPEN") {
          const exact = entry.recovery_profile ? { ...pr, strictIdentity: true } : pr;
          const problem = pr.state === "CLOSED" && entry.recovery_profile ? observedIdentityProblem(entry, exact) : await terminalIdentityProblem(host, entry, exact);
          if (problem) await needsHuman(id, "pr-identity", { network_retry: null, last: { at: now(), event: problem } });
          else await finishTerminal(id, entry, pr, { network_retry: null });
          if (!expired()) return true;
        }
      } catch {
        // Failed reads authorize no paid input and cannot extend the hard
        // recovery window. Keep diagnostic text free of provider URLs/secrets.
        log.warn(`${id}: provider recovery waiting for an authoritative PR observation`);
        if (!expired()) {
          // The failed host observation owns this delay, not a paid attempt.
          // Keep the original recovery window while avoiding fast-tick reads.
          save(id, { network_retry: { ...retry, next_at: new Date(Math.max(Date.parse(retry.next_at), nextPoll)).toISOString() } });
          return true;
        }
      }
    }
    if (expired()) {
      await exhaust(state.get(id));
      return true;
    }
    if (!due || entry.pr && !observed) return true;
    if (entry.iteration >= iterationLimit(id, entry)) {
      await needsHuman(id, "iterations", { network_retry: { ...retry, phase: "blocked" } });
      return true;
    }
    if (health && !health.ok) {
      if (["AUTH_REQUIRED", "CREDENTIAL_UNAVAILABLE", "AGENTS_AUTH", "AGENTS_QUOTA"].includes(health.code)) {
        await needsHuman(id, "network-recovery-blocked", { network_retry: { ...retry, phase: "blocked", next_at: null },
          last: { ...entry.last, event: "Provider authentication is unavailable; repair the selected account with gallivant doctor, then explicitly resume." } });
      }
      return true; // The recovery deadline still bounds an unavailable probe.
    }
    try { deps.resourcePreflight?.(entry.worktree); }
    catch (error) {
      if (error.code !== "AUTHOR_STORAGE") throw error;
      save(id, { resource_wait: { code: error.code, reasons: error.resources?.blocked || [] },
        network_retry: { ...retry, next_at: new Date(Math.min(deadline, clock.now() + config.poll_seconds * 1000)).toISOString() } });
      return true;
    }
    if (entry.recovery_profile) {
      try {
        if (transientProviderFailure(runner.outcome?.(run.id)) !== retry.code)
          throw Object.assign(new Error("Original terminal provider failure is unverified."), { code: "RECOVERY_AUTHORITY" });
        const plan = authorPlan(id, entry, "provider-continuation", retry.code, [retry.first_at, retry.run, retry.attempts]);
        const assertEligible = async () => {
          if (entry.pr) {
            const observed = await host.prView(entry.repo, entry.pr);
            if (observed.state !== "OPEN" || observedIdentityProblem(entry, { ...observed, strictIdentity: true }))
              throw new Error("Previous PR is no longer the approved open delivery.");
          }
          if (expired() || !isDeepStrictEqual(state.get(id).network_retry, retry))
            throw new Error("Retry window or original ownership changed.");
        };
        const prompt = resumePrompt({ repo: entry.repo, pr: entry.pr, branch: entry.branch, base: entry.base,
          reason: "provider-network", verify: verifyCommands(prdFor(id)), receipt: receiptFor(id), carried: entry.sources || [] });
        await continueStopped(id, entry, plan, prompt, {
          network_retry: { ...retry, attempts: retry.attempts + 1, phase: "running", next_at: null },
        }, assertEligible, deadline);
      } catch (error) {
        const current = state.get(id);
        if (expired()) await exhaust(current);
        else if (ownsRetry(current)) {
          if (recoveryDispatchDeferred(error)) save(id, { network_retry: retryAfterBudget() });
          else save(id, { recovery_wait: { phase: "blocked-authority", reason: error.code === "RECOVERY_AUTHORITY" ? error.message : "Inspect the existing execution and retry window." },
            network_retry: { ...retry, phase: "blocked", next_at: null } });
        }
      }
      return true;
    }
    // Fence before any await that might submit input. A crash in this interval
    // requires inspection; guessing whether a paid run started is unsafe.
    const launching = { ...retry, phase: "launching", attempts: retry.attempts + 1 };
    save(id, { network_retry: launching });
    try {
      const { resumeNetworkRecovery } = await import("./commands/resume.mjs");
      await resumeNetworkRecovery(authorContext(), { handle: id,
        note: `The previous invocation ended with ${retry.code}. Continue the same task from the saved session. Inspect existing files, commits and PR state before acting; do not repeat completed external actions. All original permissions, budgets and verification requirements still apply.` });
    } catch (error) {
      // A post-launch bookkeeping failure must not authorize a duplicate run.
      const current = state.get(id);
      if (current.dispatch_stopped) return true; // Keep cancellation authoritative.
      if (current.last?.run !== retry.run || !isDeepStrictEqual(current.network_retry, launching)) return true;
      const budgetDeferred = recoveryDispatchDeferred(error);
      if ((error.code === "PROVIDER_UNAVAILABLE" && error.retryableProviderPending === true || ["AUTHOR_STORAGE", "AUTHOR_CAPACITY"].includes(error.code) ||
           error.code === "REGISTRY_CAPACITY" || coolingDown(error) || budgetDeferred) &&
          runner.current()?.id === retry.run && !runner.current()?.running) {
        // A typed readiness fence refused before provider submission. Restore
        // only this proven unlaunched reservation; never replay an ambiguous
        // launch or spend an attempt merely waiting on a read-only probe.
        const next = serverRetryAt(error, clock.now());
        save(id, { network_retry: budgetDeferred ? retryAfterBudget() :
          { ...retry, phase: "waiting", ...(next > clock.now() ? { next_at: new Date(next).toISOString() } : {}) } });
        return true;
      }
      if (error.code === "NETWORK_RECOVERY_IDENTITY") {
        await needsHuman(id, "pr-identity", { network_retry: null, last: { ...current.last, event: error.message } });
        return true;
      }
      if (error.code === "NETWORK_RECOVERY_TERMINAL") {
        const pr = await host.prView(entry.repo, entry.pr);
        const problem = pr.state === "OPEN" ? "PR terminal observation changed during recovery; inspect before resuming" : await terminalIdentityProblem(host, entry, pr);
        if (problem) await needsHuman(id, "pr-identity", { network_retry: null, last: { ...current.last, event: problem } });
        else await finishTerminal(id, current, pr, { network_retry: null });
        return true;
      }
      if (error.code === "NETWORK_RECOVERY_SUPERSEDED") {
        save(id, { network_retry: null }); // Leave the queued operator input for its normal consumer.
        return true;
      }
      if (error.code === "NETWORK_RECOVERY_EXPIRED") {
        await needsHuman(id, "provider-network-exhausted", { network_retry: { ...current.network_retry, phase: "exhausted", next_at: null } });
        return true;
      }
      log.warn(`${id}: automatic network resume refused; inspect the saved run and resume prerequisites`);
      await needsHuman(id, "network-recovery-blocked", { network_retry: { ...current.network_retry, phase: "blocked" },
        last: { ...current.last, event: "network recovery could not pass the normal resume checks; run gallivant doctor and inspect the brief/worktree before explicitly resuming" } });
    }
    return true;
  }

  async function reconcileStopped(id, entry, pr) {
    const wait = (phase, reason) => { save(id, { recovery_wait: { phase, reason } }); return true; };
    try {
      if (entry.base_repair && entry.base_repair.status !== "verified" || entry.prd_divergence ||
          entry.iteration >= iterationLimit(id, entry) || divergenceReason(divergenceFor(id, entry))) return wait("blocked-authority", "Inspect the task contract, repair and remaining iterations.");
      if (pr && observedIdentityProblem(entry, { ...pr, strictIdentity: true })) return wait("blocked-authority", "Restore the approved PR identity.");
      const binding = pr && reviewBinding(pr, entry.reviewPolicy);
      if (binding && entry.reviewBinding && binding !== entry.reviewBinding) {
        const evidence = entry.completionEvidence;
        entry = save(id, { firstPartyReview: null, reviewBinding: null, review_readiness: null,
          reviewHistory: [...(entry.reviewHistory || []), ...(entry.firstPartyReview ? [entry.firstPartyReview] : [])],
          ...(evidence?.delivery ? { completionEvidence: { ...evidence, delivery: { ...evidence.delivery, invalidatedAt: now() } } } : {}) });
      }
      if (["review-incomplete", "first-party-review-failed"].includes(entry.reason) && pr) {
        if (pr.isDraft || !needsFirstParty(entry.reviewPolicy) || !await checksSettled(entry, pr) ||
            !deps.reviewService?.recover || entry.reviewBinding !== reviewBinding(pr, entry.reviewPolicy))
          return wait("waiting-external", "Review requires the original current-head evidence and qualified reviewer.");
        const record = await deps.reviewService.recover(id, entry, pr);
        if (!record) return wait("waiting-external", "Restore the original review source, binding and piece ledger.");
        const clear = record.status === "completed" && record.result?.verdict === "clear" &&
          record.binding === entry.reviewBinding && record.result.reviewedHead === pr.headRefOid;
        save(id, { firstPartyReview: record, ...(clear ? { state: STATES.prOpen, reason: null, recovery_wait: null } :
          { recovery_wait: { phase: "waiting-external", reason: record.errorCode || "Observe the original reviewer." } }) });
        return true;
      }
      if (!pr && entry.reason === "no-pr") return await recoverPublication(id, entry, wait);
      if (!pr || !["reviewer-silent", "reviewer-blocking", "missing-ci", "checks-red", "no-push"].includes(entry.reason)) return false;
      const [reviews, inline, comments] = await readFeedback(host, entry.repo, pr, fetchFrom(earlier(entry.cursor.since, entry.rereview.at)), fetchFrom(earlier(entry.cursor.since, entry.rereview.at)));
      const trust = trustFor(entry), headSha = pr.headRefOid;
      const external = await externalVerdict(entry, { reviews, inline, comments, config: reviewConfigFor(entry), trust,
        sinceIso: entry.rereview.at, headSha, dispatched: entry.cursor.dispatched });
      const rollup = ungatedRollup(pr, pilotFor(entry));
      const { events, newest } = deriveEvents({ pr: { ...pr, statusCheckRollup: rollup }, reviews, inline, comments, entry, trust });
      const failures = failingChecks(rollup);
      if (failures.length) { await recoverFailedCI(id, entry, pr); return true; }
      const green = await checksSettled(entry, pr);
      const fresh = await host.prView(entry.repo, entry.pr);
      if (fresh.state !== "OPEN" || reviewBinding(fresh, entry.reviewPolicy) !== binding ||
          observedIdentityProblem(entry, { ...fresh, strictIdentity: true }) || recoveryHeld(state.load(), id, state.get(id))) return true;
      save(id, { reviewObservation: { head: headSha, binding, observedAt: now(), external: external.verdict,
        checks: { ...checkSummary(rollup, failures), settled: green } } });
      if (failures.length || (!events.length && requiredFeedback({ reviews, inline, trust, headSha }).length) || pr.isDraft || fresh.isDraft)
        return wait("waiting-external", "Inspect current-head checks and required feedback.");
      const current = state.get(id);
      const cleared = external.verdict === "clear";
      const deferredReviewRecovered = deferred(entry) && entry.reason === "reviewer-silent" && cleared;
      if (events.length) {
        if (recordReviewCycle(state, id, current, binding, false) >= 3)
          return wait("blocked-authority", "Three unsuccessful author and reviewer cycles require inspection.");
        const cause = [...new Set(events.map(e => reviewDigest([e.kind, e.path || e.name || e.author])))].sort();
        const plan = authorPlan(id, current, "feedback-continuation", cause, [binding, events.map(eventKey)]);
        // No base merge or semantic CI repair in a stopped feedback recipe.
        if (pr.mergeable === "CONFLICTING") return wait("blocked-authority", "Inspect the base conflict.");
        const since = later(newest, entry.cursor.since), cursor = { ...advanceCursor(entry.cursor, since,
          events.filter(e => e.id != null && sameInstant(e.at, since)).map(eventKey)), fixed_sha: headSha, receipt_hash: receiptHash(pr.body) };
        const prompt = fixPrompt({ repo: entry.repo, pr: entry.pr, headSha, events, verify: verifyCommands(prdFor(id)), receipt: receiptFor(id) });
        await continueStopped(id, current, plan, prompt, { cursor }, async () => {
          const observed = await host.prView(entry.repo, entry.pr);
          if (observed.state !== "OPEN" || reviewBinding(observed, entry.reviewPolicy) !== binding ||
              observedIdentityProblem(entry, { ...observed, strictIdentity: true })) throw new Error("Feedback PR binding changed.");
        });
      } else if (deferredReviewRecovered || green && (cleared || entry.reason === "missing-ci" && !needsExternal(entry.reviewPolicy))) {
        // Resume watching after review clears. The watching path authorizes CI and verifies its proof.
        if (deferredReviewRecovered && !deps.deferredCI?.enrollment(deps, id, current))
          return wait("waiting-external", "Restore the protected CI coordinator for this enrolled task.");
        const plan = planRecovery(deps, id, "feedback-continuation", { cause: "review-wait", input: binding, paid: false });
        plan.verified([headSha, binding, external.verdict]);
        save(id, { state: STATES.prOpen, reason: null, recovery_wait: null });
      } else return wait("waiting-external", "Awaiting current-head reviewer or CI evidence.");
      return true;
    } catch (error) {
      return wait(error.code === "RECOVERY_AUTHORITY" ? "blocked-authority" : "waiting-external",
        error.code === "RECOVERY_AUTHORITY" ? error.message : `Inspect the existing owner before retrying (${error.code || "observation unavailable"}).`);
    }
  }

  function authorPlan(id, entry, recipe, cause, input) {
    const run = runnerFor(id).current();
    if (!entry.session || run?.execution?.sessionId !== entry.session || !run.execution.recoveryRouteDigest)
      throw Object.assign(new Error("Restore the original native session and approved execution route."), { code: "RECOVERY_AUTHORITY" });
    const route = state.load().recovery?.profiles.find(p => p.digest === entry.recovery_profile.digest)
      ?.routes.find(r => reviewDigest(r) === run.execution.recoveryRouteDigest);
    if (!route) throw Object.assign(new Error("Restore the approved execution route."), { code: "RECOVERY_AUTHORITY" });
    return planRecovery(deps, id, recipe, { cause, input, routeDigest: run.execution.recoveryRouteDigest, spendMicros: route.maxSpendMicros });
  }

  async function continueStopped(id, entry, recovery, prompt, patch, beforeDispatch, dispatchDeadline = null) {
    const workflow = { ...patch, state: entry.pr ? STATES.prOpen : STATES.running, reason: null, recovery_wait: null, lastEvent: "continued approved task" };
    const name = "recovery", operationId = `${entry.last.run}:${entry.iteration}:${name}:${recovery.key}`;
    const { job, session, managed } = await startRun(id, entry, { name, operationId, recovery, prompt, ownership: workflow, beforeDispatch, dispatchDeadline });
    const { lastEvent, ...fields } = workflow;
    save(id, { ...fields, ...learningDeliveryPatch(entry, managed || {}, job), session, execution: job.execution,
      last: { run: job.id, at: now(), exit: null, event: lastEvent } });
  }

  async function recoverPublication(id, entry, wait) {
    const task = entry.task;
    const owner = task?.ownerDelivery || ownerDeliveryFromPrd(prdFor(id));
    const publicationContract = task?.deliveryProfile
      ? profileView({ ...task, repo: entry.repo, base: entry.base }).action === "pull_request"
      : owner && validateOwnerDelivery(owner).spans.some(s => s.owner === "coordinator" && s.kind === "pull_request");
    if (!publicationContract ||
        entry.url || entry.completionEvidence?.terminal || entry.completionEvidence?.delivery ||
        entry.verified_progress?.kind === "published-pr" || entry.verified_progress?.kind === "published-result")
      return wait("blocked-authority", "Inspect the approved publication obligation and prior PR identity.");
    const discover = async () => {
      if (await git.currentBranch(entry.worktree) !== entry.branch || !remoteMatches(await git.originOf(entry.worktree), entry.repo))
        throw new Error("Publication checkout changed.");
      return host.prListByHead(entry.repo, entry.branch, { allStates: true });
    };
    const rows = await discover();
    if (rows.length > 1) return wait("blocked-authority", "Resolve ambiguous branch PR history.");
    if (rows.length) {
      const plan = planRecovery(deps, id, "publication-continuation", { cause: "no-pr", input: [entry.branch, rows[0].number], paid: false });
      const pr = await host.prView(entry.repo, rows[0].number);
      plan.guard();
      if (observedIdentityProblem({ ...entry, pr: rows[0].number }, { ...pr, strictIdentity: true })) return wait("blocked-authority", "PR identity differs.");
      if (pr.state === "OPEN" && !pr.isDraft) plan.verified([entry.repo, pr.number, pr.baseRefName, pr.headRefOid]);
      const bound = save(id, { pr: pr.number, url: pr.url });
      if (pr.state === "OPEN") save(id, { state: STATES.prOpen, reason: null, recovery_wait: null });
      else if (pr.state === "CLOSED" || !await terminalIdentityProblem(host, bound, { ...pr, strictIdentity: true })) await finishTerminal(id, bound, pr);
      return true;
    }
    const plan = authorPlan(id, entry, "publication-continuation", "no-pr", [entry.branch, entry.last.run]);
    const prompt = resumePrompt({ repo: entry.repo, branch: entry.branch, base: entry.base, reason: entry.reason,
      verify: verifyCommands(prdFor(id)), receipt: receiptFor(id), carried: entry.sources || [],
      uncommitted: await git.dirty(entry.worktree, { strict: true }), unpushed: await git.unpushed(entry.worktree, entry.branch, entry.base) });
    await continueStopped(id, entry, plan, prompt, {}, async () => {
      if ((await discover()).length) throw new Error("A PR appeared during publication preparation.");
    });
    return true;
  }

  function recordAuthorSettlement(id, runner, run) {
    if (!run || !state.hasAuthorReservation?.(id)) return;
    if (authorSettled({ execution: run.execution, last: { run: run.id, exit: run.exit } }, run, runner)) {
      state.settleAuthorReservation(id, run.id, run.execution?.operationId);
    }
  }
  function verifyAuthorCessation(id) {
    if (!state.hasAuthorReservation?.(id)) return;
    const runner = runnerFor(id);
    recordAuthorSettlement(id, runner, runner.current());
  }

  async function tickEntry(id, entry, options = {}) {
    return withReviewState(deps, id, async () => {
      try { return await tickEntryOwned(id, state.get(id) || entry, options); }
      finally { verifyAuthorCessation(id); }
    });
  }

  async function tickEntryOwned(id, entry, { skipReconciliation = false, deferredDispatches = null, settleOnly = false, controlOnly = false, drainSettled = false, reviewServiced = null, unprojectedRuns = null } = {}) {
    if (controlOnly) {
      if (await recoverControl(deps, id)) {
        const current = state.get(id);
        if (current.control?.status === "applied") await reconcileResults(id, current, runnerFor(id));
        return;
      }
      if (await cancelControl(deps, id)) { await deps.reviewService?.cancel?.(id, "task cancelled"); return; }
      if (interruptControl(deps, id)) { await needsHuman(id, "run-stop-unverified"); return; }
      if (executionOwed(entry)) await tickEntryOwned(id, entry, { settleOnly: true });
      const current = state.get(id);
      // An interrupted request can be recorded as failed while its run remains unsettled.
      if ((current.control?.status === "applying" || !executionOwed(current)) && !await applyControl(authorContext(), id))
        await tickEntryOwned(id, current, { skipReconciliation: Boolean(deps.executionFor), deferredDispatches });
      return;
    }
    if (entry.state === STATES.done && deps.cleanupMergedWorkspace) {
      if (settleOnly && executionOwed(entry)) {
        const runner = runnerFor(id), run = runner.current();
        if (!run || run.id !== entry.last?.run || run.running || executionLive(run) || run.exit == null) return;
        save(id, { last: { ...entry.last, exit: run.exit }, ...(run.execution ? { execution: run.execution } : {}) });
      }
      await learningDelivered({ ...deps, learning }, id);
      if (!settleOnly) { await observeCleanup(id, entry); await applyControl(authorContext(), id); }
      return;
    }
    // Retain the head belonging to the saved binding even if settleRun moves
    // the author cursor before this tick reaches review invalidation.
    const reviewedHead = entry.reviewHead ?? entry.cursor?.fixed_sha;
    await deps.reviewService?.expire?.(id);
    if (entry.review_label_pending && entry.pr) {
      try { await host.removeLabel(entry.repo, entry.pr, READY_LABEL); entry = save(id, { review_label_pending: false }); }
      catch (error) { await retryFailed(id, entry, READY_LABEL_REMOVAL, error, { action: "readiness invalidated; retrying label removal" }); return; }
    }
    try { (deps.hosts ?? hosts).select(entry); }
    catch (error) { await stopRepair(id, error); return; }
    let identityRefreshed = false;
    const refreshIdentity = async () => {
      if (identityRefreshed) return;
      if (host.userFor) ownLogins.set(entry.repo, await host.userFor(entry.repo));
      identityRefreshed = true;
    };
    if (completed(id, entry)) {
      if (!settleOnly) await observeCleanup(id, entry);
      await learningDelivered({ ...deps, learning }, id); return;
    }
    if (!skipReconciliation) await learningDelivered({ ...deps, learning }, id);
    if (await cancelControl(deps, id)) { await deps.reviewService?.cancel?.(id, "task cancelled"); return; }
    if (!settleOnly && await recoverControl(deps, id)) return;
    const execution = runnerFor(id);
    if (execution.ledgerEpoch > 0) reserveExecutionEpoch({ root: execution.root, taskId: id,
      provider: entry.harness, account: execution.account, epoch: execution.ledgerEpoch, pr: entry.pr });
    if (execution.reconcile) {
      if (!skipReconciliation) await execution.reconcile({ force: startupReconciliation.delete(id) });
      if (await retireMergedRun(id, entry, execution)) return;
      const pending = execution.current();
      if (unprojectedRuns && unprojectedExecution(id, entry, pending)) {
        // A write may have failed since the last structural scan. Leave the
        // old feedback cursor alone until the author lane binds the new run.
        unprojectedRuns.set(id, pending);
        return;
      }
      if (!skipReconciliation && await reconcileRevokedRun(state, id, execution, pending)) return;
      if (entry.initial_dispatch?.status === "dispatching" && pending?.execution?.acceptance === "accepted" &&
          pending.execution.operationId === entry.initial_dispatch.operationId && !pending.execution.quarantined) {
        entry = save(id, { ...(entry.dispatch_stopped ? {} : { state: STATES.running, reason: null }),
          initial_dispatch: null, session: pending.execution.sessionId, execution: pending.execution,
          ...learningDeliveryPatch(entry, pending.execution, pending),
          last: { at: now(), run: pending.id, exit: null, event: "start recovered" } });
      }
      if (!await reconcileResults(id, entry, execution, { readOnly: skipReconciliation })) return;
      const run = execution.current();
      if (run?.execution) {
        entry = save(id, { execution: run.execution, ...(!entry.session && run.execution.acceptance === "accepted" && run.execution.sessionId ? { session: run.execution.sessionId } : {}) });
        const terminal = !run.running && run.execution.collected && run.execution.cancellation?.status === "terminal" &&
          ["succeeded", "failed"].includes(run.execution.providerState);
        if (entry.reason === "cancellation-requested" && (run.execution.providerState === "cancelled" || terminal) &&
          run.id === (entry.control?.action === "cancel" ? (entry.control.stop_run ?? entry.last?.run) : entry.last?.run)) {
          entry = save(id, { reason: "cancelled", ...(entry.control?.action === "cancel" && entry.control.status === "applied" ? {
            control: { ...entry.control, message: cancellationStatus({ confirmed: !terminal, terminal }).message, finished_at: nowIso(clock) },
          } : {}) });
        }
      }
    }
    if (entry.state === STATES.done) { if (!settleOnly) await applyControl(authorContext(), id); return; }
    // Do not migrate a record whose provider result is still contradictory or
    // unowned. That recovery boundary must remain a strictly read-only failure.
    if (!entry.reviewPolicy) entry = save(id, { reviewPolicy: legacyReviewPolicy(reviewConfigFor(entry)) });
    if (!entry.public_since) entry = save(id, { public_since: floorSecond(now()) });
    if (interruptControl(deps, id)) {
      await needsHuman(id, "run-stop-unverified");
      return;
    }
    entry = state.get(id);
    if (await reconcileBaseRepair(id, entry)) return;
    entry = state.get(id);
    if (await settleRun(id, entry, refreshIdentity)) return;
    if (completed(id, state.get(id))) return;
    // Phase-bounded live campaigns reuse settlement/publication, but must not
    // authorize another paid review or queued resume in the same observation.
    if (settleOnly && !(drainSettled && (!executionOwed(state.get(id)) || entry.pr && !execution.current()))) return;
    if (await applyControl(authorContext(), id)) return;
    entry = state.get(id);
    if (entry?.state === STATES.needsHuman && !entry.pr && entry.recovery_profile && entry.reason === "no-pr" &&
        !recoveryHeld(state.load(), id, entry) &&
        !(entry.review_next_at > clock.now())) {
      save(id, { review_next_at: clock.now() + config.poll_seconds * 1000 });
      await reconcileStopped(id, entry, null);
      return;
    }
    if (entry && await recoverNetwork(id, entry)) return;
    if (!entry || entry.state === STATES.running || entry.state === STATES.done || !entry.pr) return;
    if ((deps.executionFor || entry.recovery_profile) && entry.review_next_at && clock.now() < entry.review_next_at && !controlPending(entry.control)) return;
    if (deps.executionFor || entry.recovery_profile) entry = save(id, { review_next_at: clock.now() + config.poll_seconds * 1000 });

    let pr = await host.prView(entry.repo, entry.pr);
    const identityProblem = observedIdentityProblem(entry, entry.plan || deferred(entry) ? { ...pr, strictIdentity: true } : pr);
    if (identityProblem) { await needsHuman(id, "pr-identity", { last: { at: now(), event: identityProblem } }); return; }
    if (pr.state === "MERGED" || pr.state === "CLOSED") {
      const stopped = entry.state === STATES.needsHuman;
      const canonical = stopped || entry.plan || deferred(entry) ? { ...pr, strictIdentity: true } : pr;
      const problem = pr.state === "CLOSED" && (stopped || entry.recovery_profile || entry.plan || deferred(entry)) ? observedIdentityProblem(entry, canonical) : await terminalIdentityProblem(host, entry, canonical);
      if (problem) { await needsHuman(id, "pr-identity", { last: { at: now(), event: problem } }); return; }
      await finishTerminal(id, entry, pr); return;
    }
    if (recoveryHeld(state.load(), id, state.get(id))) return;
    await refreshIdentity();
    if (entry.recovery_profile && await observeJournalRepair(id, entry, pr)) return;
    if (entry.recovery_profile && pr.baseRefName !== entry.base) {
      await needsHuman(id, "base-repair-ownership", { recovery_wait: { phase: "blocked-authority", reason: "Restore the approved PR target before recovery." } });
      return;
    }
    // A repaired job can clear independently of other checks. Record its
    // proof before either the watched or stopped lane diagnoses another job.
    if (entry.recovery_profile) entry = await observeRepairCI(id, entry, pr);
    // Regular means reviewable, not complete. Registration adopts the same policy as start. Recover only legacy
    // draft-specific stops; no other needs-human reason is cleared by changing this GitHub presentation state.
    if (entry.state === STATES.needsHuman && entry.reason === "draft") {
      entry = save(id, { state: STATES.prOpen, reason: null, retry: null });
    }
    if (entry.state === STATES.needsHuman) {
      if (entry.recovery_profile && entry.reason?.startsWith("base-repair-") && pr.mergeable === "CONFLICTING") {
        await repairBaseConflict(id, entry, pr); return;
      }
      if (entry.recovery_profile && await reconcileStopped(id, entry, pr)) return;
      // The one thing a stopped entry is still asked to do: finish the label write that failed when it stopped, so the
      // PR stops saying the opposite of the registry. Nothing else about the entry changes, and once it lands the
      // entry is left alone again.
      if (entry.labels_pending || hasLegacyStatusLabels(pr.labels)) {
        const written = await writeStopLabels(id, entry);
        save(id, { labels_pending: !written });
      }
      return;
    }
    try {
      const identity = recoveryIdentity(entry);
      if (entry.prd && normalizePublicBody(pr.body, { identity, taskId: id }) !== pr.body) {
        const beforeReceipt = receiptHash(pr.body);
        const sameReceipt = receiptHashes(pr.body).includes(entry.cursor.receipt_hash);
        pr = await host.setRecoveryMetadata(entry.repo, entry.pr, identity, { taskId: id });
        if (sameReceipt && receiptHash(pr.body) === beforeReceipt) entry = save(id, { cursor: { ...entry.cursor, receipt_hash: beforeReceipt } });
      }
      if (entry.retry?.op === PUBLIC_METADATA) entry = retryOk(id, entry);
    } catch (err) {
      await retryFailed(id, entry, PUBLIC_METADATA, err, { action: "retrying the structured metadata migration next tick" });
      return;
    }
    if (pr.isDraft) {
      try { await host.markReady(entry.repo, entry.pr); }
      catch (err) {
        await retryFailed(id, entry, REGULAR_PR, err, { action: "retrying regular PR conversion next tick" });
        return;
      }
      entry = retryOk(id, entry);
      // Observe the write next pass. Give automatic review its normal window after ready_for_review, instead of
      // judging silence that accrued while the PR was still a draft. No acceptance criterion has been waived.
      save(id, { rereview: { at: floorSecond(now()), nudged: false } });
      log.info(`${id}: marked PR #${entry.pr} ready for review; completion checks remain required`);
      return;
    }
    // The author cursor and review binding can still describe the preceding head.
    // Capture a failure from this identity-checked host read before any correction
    // can consume the event, replace last.run, defer dispatch or stop at a gate.
    const binding = reviewBinding(pr, entry.reviewPolicy);
    const sourceBinding = deferred(entry) ? ciSourceBinding(pr, entry.reviewPolicy) : binding;
    const rollup = ungatedRollup(pr, pilotFor(entry));
    const failures = failingChecks(rollup);
    const checks = checkSummary(rollup, failures);
    if (pr.headRefOid && failures.length) {
      checks.failureDigest = reviewDigest(failures.map(check => check.name).sort());
      const previous = entry.reviewObservation;
      if (previous?.head !== pr.headRefOid || previous.binding !== binding || previous.checks?.failureDigest !== checks.failureDigest) {
        entry = save(id, { reviewObservation: { head: pr.headRefOid, binding, observedAt: now(),
          checks: { ...checks, settled: false }, external: null } }, { observedCheckHead: pr.headRefOid });
      }
    }
    const previousRepair = entry.base_repair;
    const movedBase = previousRepair?.journal && previousRepair.status === "verified" && pr.baseRefOid && previousRepair.baseSha !== pr.baseRefOid;
    if (pr.mergeable === "CONFLICTING" || (movedBase && pr.headRefOid === previousRepair.remoteSha && !previousRepair.journal.ci)) {
      await repairBaseConflict(id, entry, pr); return;
    }
    if (entry.recovery_profile && failures.length) { await recoverFailedCI(id, entry, pr); return; }

    // The base this pull request actually targets, from the PR rather than from anything remembered. Two cases need it.
    // An entry written before `base` existed has none, and would never merge anything; and a PR someone retargeted (a
    // reviewer moving it from `main` to `staging`) would otherwise have the daemon merging the branch it was opened
    // against forever. GitHub is the only authority on where a PR is aimed, and `prView` already reads `baseRefName`,
    // so this costs nothing beyond the write.
    if (typeof pr.baseRefName === "string" && pr.baseRefName && pr.baseRefName !== entry.base) {
      log.info(`${id}: base branch is ${pr.baseRefName}${entry.base ? `, was ${entry.base}` : " (not recorded before)"}`);
      entry = save(id, { base: pr.baseRefName });
    }

    // The round comment owed by a round that was already counted. Before every judgement below, and the whole tick
    // declines while it is owed, for two reasons that are both about the comment being the re-review request. The
    // reviewer has not been asked yet, so `rereview.at` still points at the previous ask: judging this head on the
    // reviewer's silence would measure a wait for a question nobody put. And a new fix round dispatched from here
    // would be a second round charged before the first was announced, which is the undercount in the other
    // direction. So the entry waits, bounded: five refusals and it stops with `stuck`, naming the write.
    //
    // `asked` is whether the re-review went out on THIS pass, and it is the fix for a duplicate seen on a live PR: two
    // comments five seconds apart, the same text, one tagged `round` and one tagged `nudge`. Both are asks, so the
    // reviewer was asked twice for one push. See the silence step at the bottom of this function for what it gates and
    // why the nudge could not gate itself on the clock alone.
    let asked = false;
    if (entry.round_comment) {
      if (!await postRoundComment(id, entry)) return;
      asked = true;
      entry = state.get(id);
      if (!entry || entry.state !== STATES.prOpen) return;
    }

    // Inline comments are fetched from the earlier of the two windows: events use `since`, the reviewer's verdict
    // uses `rereview.at`, and a review that landed before `since` still counts for the verdict.
    const inlineSince = earlier(earlier(entry.cursor.since, entry.rereview.at), entry.public_since);

    // The fallback boundary for a dispatch with no events to bound it. Captured before the reads, so a cursor set
    // from it cannot skip what arrived during them, and floored to the second, so an item stamped in this very
    // second is still at or after it. `dispatched` is empty at a boundary no event was dispatched at.
    const readAt = floorSecond(now());

    // Both server-side `since` filters are asked for from a second earlier than the cursor. GitHub filters on
    // `updated_at` and stamps to the second, so a fetch starting exactly at the cursor can leave out the items
    // `cursor.dispatched` exists to re-examine. Overlap here, deduplicate in `deriveEvents`: reading an item a
    // second time costs nothing, never reading it again is the bug.
    const [reviews, inline, comments] = await readFeedback(host, entry.repo, pr, fetchFrom(inlineSince), fetchFrom(earlier(entry.cursor.since, entry.public_since)));
    if (learning && (!observationSelection || observationSelection.has(id)) && observationQueue.length < 100) {
      try {
        const repo = learning.identityFor(entry.repo);
        if (repo && learning.mode(repo) !== "off") observationQueue.push({ repo, snapshot: { pr: { ...pr, repo: entry.repo }, reviews, inline, comments } });
      } catch (error) { log.warn(`learning observation configuration unavailable (${error.code || "storage error"}); coding feedback remains independent`); }
    }
    const ownComments = ownPublicComments(entry, [...comments, ...inline, ...reviews.map(r => ({ ...r, public_kind: "review" }))]);
    const publicViolations = [...publicPrViolations(pr), ...publicCommentViolations(ownComments)];
    if (publicViolations.length) {
      await fixOrStop(id, entry, pr, { name: "public-text", events: [], denials: publicCorrection(publicViolations), summary: `public text correction: ${publicViolations.join("; ")}`, since: entry.cursor.since, publicFix: publicReviewHash(pr, ownComments) }, deferredDispatches);
      return;
    }
    const { events, newest } = deriveEvents({ pr: { ...pr, statusCheckRollup: rollup }, reviews, inline, comments, entry, trust: trustFor(entry) });

    if (events.length) {
      if (events.some(event => event.kind !== "check") && recordReviewCycle(state, id, entry, binding, false) >= 3) {
        await needsHuman(id, "repeated-review-findings"); return;
      }
      const summary = events.map(e => e.kind === "check" ? `check ${e.name}` : `${e.kind} ${e.id ?? ""} by ${e.author}`).join(", ");
      // The newest event dispatched is the boundary: everything up to it is handled, everything after it is still new.
      await fixOrStop(id, entry, pr, { name: "fix", events, summary, since: later(newest, entry.cursor.since) }, deferredDispatches);
      return;
    }

    // A head nobody told the loop about, in one place for both watching states. After the events step, because a batch
    // of events dispatches against the head it just read and sets `fixed_sha` itself; before every judgement below,
    // because each of them measures the reviewer, the checks and the receipt against a head, and it has to be this one.
    const changed = await headChanged(id, entry, pr);
    if (changed === "declined") return;
    if (changed) entry = changed;
    const judge = entry.state === STATES.prOpen || entry.state === STATES.ready || Boolean(entry.task?.completion && entry.completionEvidence?.delivery);
    if (entry.reviewPolicy.version === 1 && entry.reviewBinding && entry.reviewBinding !== binding) {
      const headMoved = reviewedHead && reviewedHead !== pr.headRefOid;
      const needsNewAsk = !headMoved && (!deferred(entry) || entry.ciReviewBinding !== sourceBinding);
      entry = save(id, { reviewBinding: binding, reviewHead: pr.headRefOid, firstPartyReview: null, review_readiness: null,
        ...(deferred(entry) ? { ciReviewBinding: sourceBinding } : {}),
        ...(entry.completionEvidence?.delivery ? { completionEvidence: { ...entry.completionEvidence, delivery: { ...entry.completionEvidence.delivery, invalidatedAt: now(), invalidationReason: "review input changed" } } } : {}),
        reviewHistory: [...(entry.reviewHistory || []), ...(entry.firstPartyReview ? [entry.firstPartyReview] : [])],
        rereview: needsNewAsk ? { at: now(), nudged: false } : entry.rereview });
      if (entry.state === STATES.ready) {
        await reopen(id, entry);
        entry = save(id, { state: STATES.prOpen, gate_skipped: null });
      }
      // A new head already has a push-based window from headChanged or round
      // settlement. Same-head evidence edits need a new answer after this observation.
      if (needsNewAsk && needsExternal(entry.reviewPolicy)) {
        await commentOnce(entry, roundComment(reviewConfigFor(entry)), ROUND_MARKER, entry.rereview.at);
      }
      if (needsNewAsk) return;
    }
    if (!entry.reviewBinding || entry.reviewPolicy.version === 1 && !entry.reviewHead) entry = save(id, {
      reviewBinding: binding, ...(entry.reviewPolicy.version === 1 ? { reviewHead: pr.headRefOid } : {}),
      ...(deferred(entry) ? { ciReviewBinding: sourceBinding } : {}),
    });
    const external = judge ? await externalVerdict(entry, { reviews, inline, comments, config: reviewConfigFor(entry), trust: trustFor(entry), sinceIso: entry.rereview.at, headSha: pr.headRefOid, dispatched: entry.cursor.dispatched }) : null;
    if (external?.verdict === "blocking" && recordReviewCycle(state, id, entry, binding, false) >= 3) {
      await needsHuman(id, "repeated-review-findings"); return;
    }
    const blockers = requiredFeedback({ reviews, inline, trust: trustFor(entry), headSha: pr.headRefOid });
    if (blockers.length) {
      await needsHuman(id, "reviewer-blocking", { last: { at: now(), event: `Resolve required/unbound feedback on ${pr.url}: ${blockers.map(b => b.url || b.eventId).join(", ")}` } });
      return;
    }
    const ci = judge && deferred(entry) ? await deferredChecks(deps, id, entry, pr, external) : null;
    if (ci) entry = save(id, { ciProgress: ci });
    if (ci?.refreshBase) {
      if (entry.state === STATES.ready) await reopen(id, entry);
      await refreshDeferredBase(id, state.get(id), pr, ci);
      return;
    }
    if (ci?.failure) {
      checks.deferredFailure = { run: ci.run, attempt: ci.attempt, job: ci.failure.id };
      checks.jobs = [{ name: ci.failure.name, status: "failed", runId: ci.run }, ...checks.jobs].slice(0, 8);
      checks.count++;
      checks.failed++;
    }
    const green = judge && await checksSettled(entry, pr, ci);
    // Bounded read-only presentation facts from the canonical checks/reviewer
    // decisions. Poll time is deliberately separate from meaningful activity.
    if (judge) entry = save(id, {
      // Legacy external-only policies have no first-party invalidation step.
      ...(entry.reviewPolicy.version === 0 ? { reviewBinding: binding } : {}),
      reviewObservation: { head: pr.headRefOid, binding, observedAt: now(),
        checks: { ...checks, settled: green }, external: external?.verdict ?? null } });
    if (judge && entry.reviewPolicy.version === 1 && !rollup.length && !entry.reviewPolicy.zeroChecks &&
        (!deferred(entry) || ungatedRequirements(reviewConfigFor(entry).required_checks, pilotFor(entry)).length)) {
      await needsHuman(id, "missing-ci", { last: { at: now(), event: "No checks reported; explicit review.zero_checks policy is required for a repository with zero required checks" } }); return;
    }
    let publicationDiff = null;
    const checkPublication = async ({ force = false } = {}) => {
      let violations, policy, publicationBinding;
      try {
        policy = publicationPolicyOf(prdFor(id), { sources: entry.sources || [], base: entry.base });
        publicationBinding = createHash("sha256").update(JSON.stringify([PUBLICATION_POLICY_VERSION, entry.repo, entry.pr, pr.headRefOid, pr.baseRefOid, pr.baseRefName, policy])).digest("hex");
        if (!force && entry.publication_check?.binding === publicationBinding) return true;
        publicationDiff = await host.prDiff(entry.repo, entry.pr);
        violations = workArtifactViolations(gitDiffChangedPaths(publicationDiff), policy);
        // prDiff is a live PR endpoint. Do not cache a diff fetched while either
        // branch moved against the review identity observed at the start of the tick.
        const current = await host.prView(entry.repo, entry.pr);
        if (!current || current.state !== "OPEN" || current.headRefOid !== pr.headRefOid || current.baseRefOid !== pr.baseRefOid || current.baseRefName !== pr.baseRefName) throw new Error("PR head/base changed while reading publication paths");
      } catch (error) {
        await retryFailed(id, entry, COMPLETION_GATE, error, {
          action: "retrying the publication check next tick", detail: `publication diff unreadable: ${error.message}`,
        });
        return false;
      }
      if (violations.length) {
        await fixOrStop(id, entry, pr, { name: "publication-cleanup", events: [], denials: workArtifactError(violations), summary: `remove ${violations.length} task work artifact(s) from the PR`, since: readAt }, deferredDispatches);
        return false;
      }
      entry = save(id, { publication_check: { binding: publicationBinding, checkedAt: now() } });
      return true;
    };
    // Reject scratch before expensive evidence capture/review. Persist only a
    // clean head/base/policy binding, never diff bytes; review polls reuse it.
    if (judge && green && !pr.isDraft && !await checkPublication()) return;
    if (judge && green && !pr.isDraft && needsFirstParty(entry.reviewPolicy) && external.verdict !== "blocking") {
      try {
        const divergence = divergenceFor(id, entry), reason = divergenceReason(divergence);
        if (reason) { await needsHuman(id, reason, { prd_divergence: { at: now(), why: divergence.why, diff: divergence.diff } }); return; }
        if (!entry.plan && divergence.verdict === "same" && divergence.repoText !== readPrd(id)) {
          retakePrdSnapshot({ log, readPrd, writePrd, state }, { id, divergence });
          prds.set(id, divergence.repo); entry = state.get(id);
        }
        if (!deps.reviewService) throw new Error("qualified first-party reviewer service is unavailable; restore the selected route");
        reviewServiced?.add(id);
        const record = await deps.reviewService.reconcile(id, entry, pr);
        entry = save(id, { firstPartyReview: record });
        if (entry.retry?.op === REVIEW_CAPTURE) entry = retryOk(id, entry);
        if (record.status === "failed" || record.status === "incomplete") { await needsHuman(id, record.status === "incomplete" ? "review-incomplete" : "first-party-review-failed", { last: { at: now(), event: record.error } }); return; }
        if (record.status === "completed" && record.result.verdict === "findings") {
          if (recordReviewCycle(state, id, entry, binding, false) >= 3) {
            await needsHuman(id, "repeated-review-findings"); return;
          }
          const previous = (entry.reviewHistory || []).findLast(r => r.key === record.key);
          const previouslyDispatched = ["dispatched", "dispatch-intent"].includes(previous?.disposition?.status);
          if (previouslyDispatched || ["dispatched", "dispatch-intent"].includes(record.disposition?.status) || needsExternal(entry.reviewPolicy) && external.verdict === "clear") {
            await needsHuman(id, previouslyDispatched || record.disposition ? "repeated-review-findings" : "review-disagreement"); return;
          }
          const exhausted = entry.iteration >= iterationLimit(id, entry);
          const disposition = { status: exhausted ? "rounds-exhausted" : "pending", at: now(), round: null, findingsDigest: reviewDigest(record.result.findings) };
          // Pre-dispatch waits remain retryable. The shared launch boundary
          // records durable intent immediately before provider I/O or local start.
          entry = save(id, reviewDispositionPatch(id, entry, record.key, disposition));
          await fixOrStop(id, entry, pr, { name: "fix", events: [], denials: findingsPrompt(record), summary: "first-party review findings", since: readAt, reviewKey: record.key }, deferredDispatches);
          return;
        }
      } catch (error) {
        if (error.retryableReviewCapture === true) {
          await retryFailed(id, state.get(id), REVIEW_CAPTURE, error, { action: "retrying the current PR evidence read next tick" }); return;
        }
        await needsHuman(id, ["REVIEW_INCOMPLETE", "BB_INCOMPLETE", "BB_OVERSIZED"].includes(error.code) ? "review-incomplete" : "first-party-review-failed", { firstPartyReview: { status: "incomplete", binding, error: error.message, errorCode: error.code }, last: { at: now(), event: error.message } }); return;
      }
    }
    const verdict = judge ? reviewVerdict(entry.reviewPolicy, external, entry.firstPartyReview, binding) : null;
    if (entry.state === STATES.ready && entry.reviewPolicy.version === 1 && (!green || verdict.verdict !== "clear")) {
      try { await reopen(id, entry); }
      catch (error) { await retryFailed(id, state.get(id), READY_LABEL_REMOVAL, error, { action: "readiness invalidated; retrying label removal" }); }
      return;
    }
    if (entry.state === STATES.ready && entry.task?.completion && entry.completionEvidence?.delivery) {
      const delivery = entry.completionEvidence?.delivery;
      const bindingChanged = !delivery || delivery.invalidatedAt || delivery.head !== pr.headRefOid || delivery.base !== pr.baseRefName || delivery.receiptHash !== receiptHash(pr.body);
      if (bindingChanged || !green || !["clear", "none"].includes(verdict.verdict)) {
        // Revoke the claim before a possibly failing label write. Saved evidence
        // remains auditable; neither pending checks nor lost clearance launches
        // a provider. The ordinary review/gate path decides on later ticks.
        entry = save(id, { completionEvidence: { ...entry.completionEvidence, delivery: { ...delivery, invalidatedAt: now(), invalidationReason: "Delivery binding, checks or reviewer clearance changed." } } });
        try { await reopen(id, entry); }
        catch (error) { await retryFailed(id, entry, READY_LABEL_REMOVAL, error, { action: "retrying removal of stale ready label" }); return; }
        save(id, { state: STATES.prOpen, gate_skipped: null, retry: null,
          ...(delivery?.base !== pr.baseRefName ? { rereview: { at: now(), nudged: false } } : {}),
        });
        return;
      }
    }
    if (entry.state === STATES.ready && hasLegacyStatusLabels(pr.labels)) {
      if (ci && !await recheckDeferredReadiness(deps, id, entry, pr, external, ci)) return;
      try { await host.addLabel(entry.repo, entry.pr, READY_LABEL); }
      catch (err) {
        await retryFailed(id, entry, READY_LABEL_WRITE, err, { action: "retrying the neutral ready label next tick" });
        return;
      }
      entry = retryOk(id, entry);
    }
    if (entry.state !== STATES.prOpen) return;
    if (!pr.isDraft && green && (verdict.verdict === "clear" || verdict.verdict === "none")) {
      if (verdict.verdict === "clear") {
        recordReviewCycle(state, id, entry, binding, true);
        verifyRecoveryOutcome(state, id, entry.execution, "feedback-continuation", [pr.headRefOid, binding, verdict.verdict]);
      }
      // Before the gate, and before anything is certified: is the brief the gate is about to judge still the brief the
      // operator is asking for?
      //
      // What the gate does while a divergence is unresolved: nothing. It is not run on the old criteria and it is not
      // run on the new ones, because either would be a false certification. Judging the snapshot certifies a brief the
      // operator has abandoned, which is the silent divergence this exists to end. Judging the operator's new copy
      // certifies criteria the session was never given and never attested, so the receipt on the PR would be answering
      // a different question from the one asked. There is no third brief to judge, so the honest answer is that no
      // decision is made until a person resolves which brief is the brief.
      //
      // `gate_skipped` is deliberately NOT set. That field describes a PR that reached READY with the gate unrun, so a
      // person deciding whether to merge is told the receipt was never checked. This entry is not reaching ready at
      // all: it is stopping, with a reason and a notification, and `needsHuman` clears the field for exactly that
      // reason.
      const div = divergenceFor(id, entry);
      const divReason = divergenceReason(div);
      if (divReason) {
        const detail = renderDivergence(div);
        log.warn(`${id}: ${div.why}; not judging either brief:\n${detail}`);
        await needsHuman(id, divReason, { prd_divergence: { at: now(), why: div.why, diff: div.diff }, last: { at: now(), event: div.why } });
        return;
      }
      // A brief edited outside the contract: the criteria, the Verify commands, the harness and `context_paths` all
      // still match, so the work in flight is still the work that was asked for and stopping would throw it away for a
      // reworded Problem section. The snapshot follows the edit anyway, so a later fix round's prompt carries the
      // operator's current prose rather than a version they have moved on from, and the fingerprint follows with it so
      // the next tick does not re-derive the same answer. Nobody is notified.
      if (!entry.plan && div.verdict === "same" && div.repoText !== readPrd(id)) {
        // `retakePrdSnapshot` writes the file and the fingerprint through `state.update`, so the local `entry` is now one
        // version behind and everything below judges this head with it. `state.get` rather than an empty `save`, which
        // would read as a no-op to the next person and only happens to re-read as a side effect of touching
        // `updated_at`. The cached parse is replaced too, so `verifyFor` and `receiptFor` on this same pass carry the
        // brief that is now on disk rather than the one that was.
        retakePrdSnapshot({ log, readPrd, writePrd, state }, { id, divergence: div });
        prds.set(id, div.repo);
        entry = state.get(id);
        log.info(`${id}: the brief was edited outside its contract; snapshot re-taken from ${div.path} and nothing restarted`);
      } else if (entry.prd_divergence) {
        entry = save(id, { prd_divergence: null });
      }
      // The immutable path proof is reusable; the optional content scan still
      // needs diff text if this tick did not fetch it before review.
      if (!await checkPublication({ force: Boolean(config.deliverable?.scan_output && publicationDiff === null) })) return;
      // The completion gate: the last step before a human is asked to look. Only for entries with a PRD.
      const prd = config.deliverable ? prdFor(id) : null;
      // An entry with no snapshot reaches ready on the checks and the reviewer alone, with nothing about what the PR
      // was supposed to deliver ever read. That used to be one line in `errors.log` and nothing anywhere else:
      // `status`, `why`, the ntfy message and the PR all said what they say for a PR that passed the gate. So it is
      // carried on the entry, where the three of them can say it.
      const gateSkipped = !config.deliverable ? "completion gate disabled" : !prd ? "no PRD snapshot" : null;
      if ((entry.reviewPolicy.version === 1 || entry.base_repair) && (!config.deliverable || !prd)) {
        await needsHuman(id, "completion-gate-skipped", { gate_skipped: !config.deliverable ? "completion gate disabled" : "no PRD snapshot" }); return;
      }
      let completionGate = null;
      const acceptanceObservation = (allow, source) => ({ allow, source, head: pr.headRefOid, binding,
        repository: entry.repo, pr: entry.pr, base: pr.baseRefName || entry.base || null,
        brief: entry.prd_fingerprint ?? null, observedAt: now() });
      if (gateSkipped) log.warn(`${id}: ${gateSkipped}, completion gate skipped`);
      if (prd) {
        const criteria = criteriaFromPrd(prd);
        // The output scan needs the whole diff. A diff that cannot be read is not an empty diff: `addedLines(null)`
        // is the empty string, which passes the blocked-pattern scan trivially, so a transient `gh pr diff` failure
        // would let a PR through the very check it is meant to face. A diff too large to hold is the same fail-open
        // one step further on, and `host.prDiff` throws for it rather than returning a prefix that looks whole. No
        // decision either way: retry with the shared bound, then stop with the cause if it still cannot be read.
        let diff = null;
        if (config.deliverable.scan_output) diff = addedLines(publicationDiff);
        // `framework` is the harness that did the work, carried as self-reported provenance in the decision's
        // context so a machine running two harnesses can tell their decisions apart afterwards.
        const g = await gate({ taskId: id, prBody: pr.body, criteria, checksGreen: true, diff, framework: entry.harness, limits: config.deliverable, apiKey: aportApiKey, fetch, log, cooldowns: deps.cooldowns, clock });
        if (g.pending) {
          if (g.retryAt) return;
          const error = Object.assign(new Error(g.denials?.map(d => d.message).join("; ") || g.source), { code: g.denials?.[0]?.code });
          await retryFailed(id, entry, COMPLETION_GATE, error, { action: "reviewer clear; retrying the evaluator next tick" });
          return;
        }
        if (!g.allow) {
          const codes = g.denials.map(d => d.code).join(", ");
          log.info(`${id}: completion gate (${g.source}) denied: ${codes}`);
          entry = save(id, { completionEvidence: { ...entry.completionEvidence, acceptance: acceptanceObservation(false, g.source) } });
          await fixOrStop(id, entry, pr, { name: "receipt", events: [], denials: `${denialsPrompt(g.denials)}\n\n${receiptInstructions(criteria, id)}`, summary: `receipt denied: ${codes}`, since: readAt }, deferredDispatches);
          return;
        }
        log.info(`${id}: completion gate passed (${g.source})`);
        completionGate = { allow: true, source: g.source, decisionId: g.decisionId || null };
      }
      // The label goes on before the registry says ready, because the registry moving is what makes this branch stop
      // running: a later tick returns early on the state, so a label write swallowed here would leave the PR with no
      // label and nobody to add one. A failure therefore leaves the entry in pr-open, which is the retryable state:
      // the next tick judges the same head again and asks again. Nothing else has happened yet, so the retry is the
      // same work, not a second round. The operator is not notified either, since being told a PR is ready while the
      // PR itself says nothing is the contradiction this ordering exists to avoid.
      //
      // The fourth caller of the bound. Declining is right and declining forever is not: a token that cannot write
      // labels at all never recovers, and this path had no counter, so the entry sat in `pr-open` repeating the gate
      // and the label attempt on every tick, for as long as the daemon ran, with one `log.warn` each time. Worse than
      // the other three, because every readiness condition had already passed: `status` said the entry was waiting on
      // the reviewer, which the reviewer had already answered, and the completion gate was re-evaluated (and, with a
      // hosted evaluator, re-paid for) on every poll for a decision that was already made.
      if (ci && !await recheckDeferredReadiness(deps, id, entry, pr, external, ci)) return;
      try { await host.addLabel(entry.repo, entry.pr, READY_LABEL); }
      catch (err) {
        await retryFailed(id, entry, READY_LABEL_WRITE, err, { action: "staying in pr-open and trying again next tick" });
        return;
      }
      // Cleared before the state moves, not after, so `retry` is never set on a `ready` entry: nothing retries a ready
      // entry's label, and a stale count there would outrank the ready row in `status` and hide the one thing the
      // operator is being asked to act on.
      entry = retryOk(id, entry);
      const e = save(id, { state: STATES.ready, activity_at: now(), gate_skipped: gateSkipped, retry: null,
        review_readiness: { binding, note: verdict.note, verdict: verdict.verdict, checks: ci?.proof ? "verified selected CI" :
          (pr.statusCheckRollup || []).length ? "settled" : entry.reviewPolicy.version === 1 ? "explicit zero-check policy" : "no checks reported (legacy grace policy)", completion: completionGate ? "accepted" : "skipped" },
        ...(completionGate ? { completionEvidence: {
          ...entry.completionEvidence, acceptance: acceptanceObservation(true, completionGate.source),
          ...((entry.task?.completion || entry.base_repair || deferred(entry) || dependencyProducer(id, entry)) ? { delivery: {
          adapter: completionAdapter(entry.repo, deps.hosts ?? hosts), repository: entry.repo, pr: entry.pr, head: pr.headRefOid,
          base: pr.baseRefName || entry.base || null, receiptHash: receiptHash(pr.body), observedAt: now(),
          gate: completionGate, checks: { settled: true, count: (pr.statusCheckRollup || []).length, ...(ci?.proof ? { ci: ci.proof } : {}) },
          reviewer: { verdict: verdict.verdict, ...(ci?.proof?.review ? { review: ci.proof.review } : {}) },
          } } : {}),
        } } : {}),
      });
      await notify.ready({ entry: e, max: iterationLimit(id, e), checks: (pr.statusCheckRollup || []).length, reviewerNote: verdict.note });
      log.info(`${id}: ready for a human`);
      return;
    }
    if (verdict.verdict === "blocking") {
      // The reviewer blocked this head and nothing new arrived to dispatch: its review predates the event cursor
      // (a recovery, a reset). A person decides, once per head.
      const event = `reviewer blocking on ${pr.headRefOid.slice(0, 7)}`;
      if (entry.last?.event !== event) await needsHuman(id, "reviewer-blocking", { last: { at: now(), event } });
      return;
    }
    if (!green && verdict.verdict !== "waiting") {
      // Red checks on a head whose failures were already dispatched: nothing more for the loop to do until the
      // next event, but not silently. Once per head.
      const event = `red checks on ${pr.headRefOid.slice(0, 7)}`;
      if (entry.cursor.checks_sha === pr.headRefOid && (!deferred(entry) || failures.length) && entry.last?.event !== event)
        await needsHuman(id, "checks-red", { last: { at: now(), event } });
      return;
    }
    // The silence step: has the reviewer answered the ask, and if not, for how long. Both branches measure the same
    // clock, `rereview.at`, and both are skipped on a pass that made the ask, which is the duplicate-comment fix.
    //
    // What the duplicate was, and why the clock could not catch it on its own. The round comment and the nudge post
    // the SAME text, `reviewer.rereview_comment`, and are told apart only by their marker; a live PR carried both
    // five seconds apart for one push. `postRoundComment` dates the ask through `reviewerClock`, which will not
    // believe a committer date older than the nudge window and floors it at exactly `now - rereview_minutes`. A
    // committer date older than the window is the ordinary case, not the odd one: the commit was made before the run
    // that pushed it, or the head is a merge tip carrying the merged commit's date. `floorSecond` then drops the
    // milliseconds off that floor, so the ask lands a few hundred milliseconds the wrong side of the boundary
    // `waited > minutes(rereview_minutes)` tests, and the nudge fired on the round's own tick. Worse, with
    // `stall_hours` low enough the branch above it fires first and the entry stops `reviewer-silent` on the very
    // tick it asked, for a question that was microseconds old.
    //
    // Widening the floor would only move the boundary, and the next tick to straddle it would ask twice again. The
    // durable statement is about the asks, not the arithmetic: the round comment IS the re-review request, the nudge
    // is a second copy of that same request, and one push earns one asking of it. So neither branch runs on a pass
    // that has just asked. The two markers stay separate because they answer different questions on different
    // passes: a round announces a push, a nudge chases a reviewer that has said nothing since one. `nudged` stays
    // false here, so a reviewer that really does go quiet is still chased on the next tick.
    if (verdict.verdict === "waiting" && needsExternal(entry.reviewPolicy) && entry.rereview.at && !asked) {
      const waited = clock.now() - Date.parse(entry.rereview.at);
      if (waited > hours(config.stall_hours)) { await needsHuman(id, "reviewer-silent"); return; }
      if (waited > minutes(config.rereview_minutes) && !entry.rereview.nudged) {
        const posted = await commentOnce(entry, nudgeComment(reviewConfigFor(entry)), NUDGE_MARKER, entry.rereview.at);
        save(id, { rereview: { ...entry.rereview, nudged: true } });
        log.info(`${id}: ${posted ? "nudged reviewer" : "nudge already posted"}`);
      }
    }
  }

  async function tick({ startedAt = clock.now(), tail = null } = {}) {
    prds.clear();
    reconcileUnsentStarts(deps);
    const cycle = schedule.begin(startedAt);
    const { ids, chains, anchors, outputDue, unprojected, authorReservations = new Set() } = schedule.scan(state, {
      cleanup: Boolean(deps.cleanupMergedWorkspace), maintenance: Boolean(deps.maintainWorkspace),
      outputNextAtFor: deps.outputNextAtFor && ((id, entry) => EXECUTION_TRANSPORTS[entry.harness] === "cli" ? deps.outputNextAtFor(id) : null),
      readExecution: deps.executionFor && ((id, entry) => recordedRun(executionRunner(deps, id, entry.harness))),
    });
    const entries = ids.flatMap(id => {
      const entry = state.get(id);
      return entry ? [[id, entry]] : [];
    });
    const time = clock.now(), selected = new Set(), results = new Map(), deferredDispatches = [];
    const concurrency = config.execution?.concurrency || CONCURRENCY;
    const providerDeadlines = new Map();
    const retryScopeDeadline = entry => {
      if (!deps.cooldowns) return 0;
      const scope = providerScope(entry.harness, entry.execution?.account || config.harness[entry.harness]?.account || "operator");
      if (!providerDeadlines.has(scope)) {
        try { providerDeadlines.set(scope, deps.cooldowns.deferred(scope)?.retryAt || 0); }
        catch (error) {
          providerDeadlines.set(scope, Infinity);
          log.warn(`provider cooldown unavailable (${error.code || "state read failed"}); other recovery lanes remain scheduled`);
        }
      }
      return providerDeadlines.get(scope);
    };
    const remoteAuthor = entry => (entry.execution?.transport ?? EXECUTION_TRANSPORTS[entry.harness]) === "remote";
    const awaitingProjection = (entry, id) => unprojectedExecution(id, entry, unprojected.get(id));
    const owesExecution = (entry, id) => executionOwed(entry) || awaitingProjection(entry, id);
    const pick = (lane, dueAt, { exclusive = true, priority } = {}) => {
      const batch = cycle.batch(lane, entries.filter(([id]) => !exclusive || !selected.has(id))
        .map(([id, entry]) => [id, dueAt(entry, id)]), { priority });
      if (exclusive) for (const id of batch.ids) selected.add(id);
      return batch;
    };
    const control = pick("control", entry => controlPending(entry.control) ? entry.control.next_at ?? (Date.parse(entry.control.at || entry.control.requested_at) || 0) : Infinity);
    const author = pick("author", (entry, id) => {
      if (!deps.executionFor || !remoteAuthor(entry) || !owesExecution(entry, id) || controlPending(entry.control)) return Infinity;
      return startupReconciliation.has(id) || awaitingProjection(entry, id) ? 0 : entry.execution?.nextAttemptAt || 0;
    }, { priority: startupReconciliation });
    const settlement = pick("settlement", (entry, id) => (owesExecution(entry, id) || authorReservations.has(id)) && !controlPending(entry.control) && (!deps.executionFor || !remoteAuthor(entry)) ?
      Math.min(cycle.started, Date.parse(entry.last?.at) || 0) : Infinity, { priority: startupReconciliation });
    const recoveryState = { recovery: state.recoverySettings ? state.recoverySettings() : state.load().recovery };
    const hostBatch = pick("host", (entry, id) => {
      if (entry.state === STATES.done || controlPending(entry.control) || owesExecution(entry, id) || completed(id, entry)) return Infinity;
      const review = entry.review_next_at || 0;
      if (recoveryHeld(recoveryState, id, entry)) return entry.pr ? review : Infinity;
      if (["launching", "waiting", "reconciling"].includes(entry.network_retry?.phase)) {
        const retry = entry.network_retry;
        if (retry.phase !== "waiting") return 0;
        return Math.min(Math.max(Date.parse(retry.next_at) || 0, retryScopeDeadline(entry)), networkRecoveryDeadline(retry) || 0, entry.pr ? review : Infinity);
      }
      if (entry.pr || entry.reason === "no-pr" && entry.recovery_profile) return review;
      return entry.state === STATES.running || entry.base_repair && entry.base_repair.status !== "verified" ? 0 : Infinity;
    });
    const reviewer = pick("reviewer", (entry, id) => deps.reviewService?.progress && !controlPending(entry.control) &&
      !owesExecution(entry, id) && entry.firstPartyReview?.status === "running" ? entry.firstPartyReview.retryAt ?? 0 : Infinity, { exclusive: false });
    const maintenance = pick("maintenance", (entry, id) => {
      if (controlPending(entry.control)) return Infinity;
      return Math.min(learningDeliveryPending(entry) ? 0 : Infinity,
        deps.deferredCI && deferredMaintenanceOwed(entry) ? entry.ci_maintenance_at || 0 : Infinity,
        deps.cleanupMergedWorkspace && cleanupOwed(entry, anchors.has(id)) ? entry.cleanup_check_at || 0 : Infinity,
        (entry.output_next_at === undefined ? outputDue.get(id) : entry.output_next_at) ?? Infinity,
        deps.maintainWorkspace ? entry.workspace_cleanup?.retry_at || Infinity : Infinity,
        deps.maintainWorkspace ? entry.runtime_cleanup?.next_at || Infinity : Infinity);
    }, { exclusive: false });
    cleanupObservers = new Set(maintenance.ids);
    observationSelection = new Set(hostBatch.ids);
    const entryWork = new Map(), reviewServiced = new Set();
    // A task's decisions stay serialized. Wait for its earlier lane before
    // acquiring a worker, so an overlapping host read cannot block other tasks.
    const workers = (batch, process) => {
      const slots = makeWorkSlots(concurrency);
      for (const id of batch.ids) {
        const work = () => slots(async () => {
          batch.start(id);
          try {
            const before = state.get(id);
            if (!before) return;
            await runRecoveryWork(() => process(id, before));
            const after = state.get(id);
            if (after && (after.recovery_record?.progress?.at !== before.recovery_record?.progress?.at ||
              after.control?.status !== before.control?.status && !controlPending(after.control) ||
              after.last?.exit != null && before.last?.exit == null ||
              after.workspace_cleanup?.status !== before.workspace_cleanup?.status && ["done", "retained"].includes(after.workspace_cleanup?.status) ||
              after.runtime_cleanup?.code === "removed" && !isDeepStrictEqual(after.runtime_cleanup, before.runtime_cleanup) ||
              before.firstPartyReview?.status === "running" && ["completed", "failed", "incomplete"].includes(after.firstPartyReview?.status))) batch.progress();
            if (!results.has(id)) results.set(id, { id, ok: true });
          } catch (error) {
            log.warn(`${id}: recovery work deferred (${error.code || error.message})`);
            results.set(id, { id, ok: false, error: error.message });
          }
        });
        const previous = entryWork.get(id);
        entryWork.set(id, previous ? previous.then(work) : work());
      }
    };
    const reconcileAuthor = async (id) => {
      const entry = state.get(id);
      if (!entry || controlPending(entry.control)) return;
      const runner = runnerFor(id), ledgerOnly = !executionOwed(entry);
      if (ledgerOnly && !unprojectedExecution(id, entry, recordedRun(runner))) { unprojected.delete(id); return; }
      await runner.reconcile?.({ force: startupReconciliation.delete(id) });
      const current = runner.current();
      if (ledgerOnly && !unprojectedExecution(id, state.get(id), current)) { unprojected.delete(id); return; }
      if (current?.execution?.acceptance === "accepted") acceptedRecovery(state, id, current.execution.recoveryIntent, current.execution.operationId, "resumed");
      if (current?.execution) state.update(id, currentEntry => {
        const ex = current.execution;
        const matches = unprojectedExecution(id, currentEntry, current);
        if (ledgerOnly && !matches) return {};
        const owned = ex.acceptance === "accepted" && matches === "continuation";
        const { lastEvent, ...workflow } = ex.workflow || {};
        return { execution: ex, ...((owned || currentEntry.last?.run === current.id) && currentEntry.learning?.runId !== current.id ? learningDeliveryPatch(currentEntry, ex, current) : {}),
          ...(owned ? { ...workflow, session: ex.sessionId || currentEntry.session, last: { at: now(), run: current.id, exit: null, event: lastEvent || "recovered accepted execution" } } : {}) };
      });
      unprojected.delete(id);
      await learningDelivered({ ...deps, learning }, id);
      if (runner.reconcile) await reconcileResults(id, state.get(id), runner);
      await tickEntryOwned(id, state.get(id) || entry, { skipReconciliation: true, settleOnly: true, drainSettled: true, deferredDispatches });
    };
    const advanceReviewer = (id) => {
      if (reviewServiced.has(id)) return;
      return withReviewState(deps, id, async () => {
        const entry = state.get(id);
        if (![STATES.prOpen, STATES.ready].includes(entry?.state) || controlPending(entry.control) || owesExecution(entry, id) ||
          entry.firstPartyReview?.status !== "running" || entry.firstPartyReview.retryAt > clock.now() || completed(id, entry) || runnerFor(id).current()?.running) return;
        try {
          const record = await deps.reviewService.progress(id, entry);
          if (record) save(id, { firstPartyReview: record, ...(record.status !== "running" ? { review_next_at: 0 } : {}) });
        } catch (error) {
          if (state.get(id)?.firstPartyReview?.status === "running") save(id, { review_next_at: 0 });
          throw error;
        }
      });
    };
    const advanceMaintenance = (id) => withReviewState(deps, id, async () => {
      const entry = state.get(id);
      if (!entry || controlPending(entry.control)) return;
      await learningDelivered({ ...deps, learning }, id);
      if (deps.deferredCI && deferredMaintenanceOwed(entry) && !(entry.ci_maintenance_at > time)) {
        save(id, { ci_maintenance_at: time + config.poll_seconds * 1000 });
        await maintainDeferredCI(deps, id, entry);
      }
      const due = entry.output_next_at === undefined ? outputDue.get(id) : entry.output_next_at;
      if (Number.isFinite(due) && due <= time) {
        const runner = runnerFor(id);
        if (runner.reconcile) await runner.reconcile();
        else runner.observe?.();
        save(id, { output_next_at: runner.outputNextAt?.() ?? null });
      }
      const current = state.get(id);
      if (!current || controlPending(current.control)) return;
      if (deps.cleanupMergedWorkspace && cleanupOwed(current, anchors.has(id)) && !(current.cleanup_check_at > time))
        await observeCleanup(id, current);
      const settled = state.get(id);
      if (settled && !controlPending(settled.control))
        await deps.maintainWorkspace?.(id, settled, { assertCoordinatorOwner: deps.assertCoordinatorOwner });
    });
    // An unfinished bounded sweep drains before the next host cadence. The
    // portable owner supplies its durable chain subwindow across wake-ups.
    const advanceChains = () => advanceDependencies("chain", async () => {
      const candidates = time >= nextChainAt || !deps.chainsForTick && cycle.cursor("chain") ? (
        deps.chainsForTick ? deps.chainsForTick() : chains.map(name => [name, state.getChain(name)]).filter(([, chain]) => chain?.status === "active")
      ) : [];
      const batch = cycle.batch("chain", candidates.map(([name, chain]) => [name, Date.parse(chain.rateLimitUntil) || 0]), { wrap: Boolean(deps.chainsForTick) });
      if (time >= nextChainAt) nextChainAt = time + config.poll_seconds * 1000;
      const due = new Set(batch.ids);
      if (!due.size) return [];
      // The standalone daemon keeps its owner for the lifetime of this work.
      // Author preparation has its own durable capacity reservation, so it
      // can wait on Git without occupying the task continuation work slots.
      return tickChains(backgroundDependencies ? deps : authorContext(), () => candidates.filter(([name]) => due.has(name)), {
        start: (name) => batch.start(name), progress: () => batch.progress(), waitForEntry: id => entryWork.get(id),
      });
    });
    workers(control, (id, e) => tickEntry(id, e, { controlOnly: true, deferredDispatches }));
    workers(author, id => withReviewState(deps, id, () => reconcileAuthor(id)));
    workers(settlement, (id, e) => deps.executionFor ? withReviewState(deps, id, async () => {
      try { await reconcileAuthor(id); }
      finally { verifyAuthorCessation(id); }
    }) :
      tickEntry(id, e, { settleOnly: true, drainSettled: true, deferredDispatches }));
    workers(hostBatch, (id, e) => tickEntry(id, e, { skipReconciliation: Boolean(deps.executionFor), deferredDispatches, reviewServiced,
      unprojectedRuns: deps.executionFor ? unprojected : null }));
    workers(reviewer, advanceReviewer);
    workers(maintenance, advanceMaintenance);
    const [chainOutcome, graphOutcome, ...outcomes] = await Promise.allSettled([
      advanceChains(), advanceDependencies("graph", () => tickDependencyPlans(deps, cycle, id => entryWork.get(id))),
      ...entryWork.values(), runRecoveryWork(observeImmediateCI), tail?.(),
    ]);
    // Join only the bounded probes already in flight. Dispatch must still
    // revalidate the same task and review binding after the await.
    await Promise.all(Array.from({ length: Math.min(concurrency, deferredDispatches.length) }, async () => {
      for (let next = deferredDispatches.shift(); next; next = deferredDispatches.shift()) {
        const { id, entry, pr, spec, refreshed } = next;
        try {
          await refreshed;
          await withReviewState(deps, id, async () => {
            const current = state.get(id);
            if (!current || completed(id, current) || ![STATES.prOpen, STATES.ready].includes(current.state) || current.pr !== entry.pr ||
              current.harness !== entry.harness || current.last?.run !== entry.last?.run || JSON.stringify(current.cursor) !== JSON.stringify(entry.cursor) ||
              spec.reviewKey && current.firstPartyReview?.key !== spec.reviewKey) return;
            await runRecoveryWork(() => fixOrStop(id, current, pr, spec));
          });
        } catch (error) {
          log.warn(`${id}: deferred dispatch failed (${error.code || error.message})`);
          results.set(id, { id, ok: false, error: error.message });
        }
      }
    }));
    if (deps.provisionResourceReserve && time >= nextReserveCheck) {
      nextReserveCheck = time + (config.recovery_scan_seconds ?? STRUCTURAL_SCAN_SECONDS) * 1000;
      try { deps.provisionResourceReserve(); }
      catch (error) { log.warn(`recovery journal reserve unavailable (${error.code || "io-error"})`); }
    }
    // Observation is a bounded, unpaid tail lane after fixes and chain dispatch.
    // Failure cannot acknowledge events, spend rounds, or fail a coding result.
    const identityDeadline = Date.now() + 5000, identities = new Map();
    for (const item of observationQueue.splice(0, 100)) {
      try {
        if (learning.mode(item.repo) === "off") continue;
        const name = item.snapshot.pr.repo.toLowerCase();
        if (!identities.has(name)) {
          const remaining = identityDeadline - Date.now();
          if (remaining <= 0) { log.warn("learning identity budget exhausted; remaining observations skipped"); break; }
          identities.set(name, boundedCall(signal => learning.resolveRepo(name, { signal }), { deadlineMs: remaining }));
        }
        // The queued snapshot is only a proposal until its mutable name has
        // been checked against the immutable learning scope. Never re-enroll it.
        if (learningHash(await identities.get(name)) !== learningHash(item.repo)) { log.warn("learning repository identity changed; observation skipped"); continue; }
        await learning.observe(item.repo, item.snapshot);
      }
      catch (error) { log.warn(`learning collection unavailable (${error.code || "storage error"}); coding/review state preserved`); }
    }
    if (deps.collaboration) {
      try { await deps.collaboration.flush({ limit: 2 }); }
      catch (error) { log.warn(`collaboration delivery unavailable (${error.code || "adapter error"}); task execution and review continue`); }
      try { await deps.collaboration.synchronizeInbound(); }
      catch (error) { log.warn(`collaboration inbound collection unavailable (${error.code || "adapter error"}); no control state changed`); }
    }
    try { cycle.finish(); }
    catch (error) { log.warn(`recovery metrics checkpoint unavailable (${error.code || "state write failed"})`); }
    schedule.settled(state);
    const failed = [...outcomes, chainOutcome, graphOutcome].find(outcome => outcome.status === "rejected");
    if (failed) throw failed.reason;
    return [...results.values(), ...chainOutcome.value, ...graphOutcome.value, ...completedDependencyWork.splice(0)];
  }

  return { tick, get metrics() { return schedule.metrics; }, tickEntry, startRun, needsHuman, mergeBaseInto, reopen, repairBaseConflict, resumeBaseRepair, get nextChainAt() { return nextChainAt; } };
}

/**
 * The words the configured reviewer is asked with, from `reviewer.rereview_comment` and from nowhere else. The
 * default is `@codex review` because that is the reviewer Gallivant was first driven against, but nothing in the
 * loop knows what the string says: whatever mention, slash command or plain English sentence a review tool answers
 * to goes in that one field, and a human reviewer's "please take another look" works the same way.
 *
 * `reviewer: null` is "no automated reviewer": nothing is asked for a re-review and readiness rests on the checks
 * alone. A round still happened and the PR still says so, so the fallback announces the push without asking anyone
 * for anything. An unguarded read here used to be the difference between the two comment builders, which is the
 * asymmetry this codebase keeps producing: the round comment had the fallback and the nudge did not.
 */
const reviewerAsk = config => config.reviewer?.rereview_comment ?? "Pushed a fix.";

export const roundComment = config => `${reviewerAsk(config)}\n\n${ROUND_MARKER}`;
export const receiptRoundComment = () => `Completion receipt updated.\n\n${ROUND_MARKER}`;
export const nudgeComment = config => `${reviewerAsk(config)}\n\n${NUDGE_MARKER}`;
