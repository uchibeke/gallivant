// The tick: the one actor that changes state. Every `poll_seconds` it walks the registry once, in the order PRD 6.8
// lays out: settle finished runs, fetch, terminal states, events, dispatch, ready, silence.
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
import { deriveEvents, makeTrust, reviewerVerdict, reviewerClock, isGreen, addedLines, hasOwnComment, eventKey, isFixCommand } from "./events.mjs";
import { fixPrompt, registerPrompt } from "./prompt.mjs";
import { parsePrd, verifyCommands, criteriaFromPrd, briefDivergence, divergenceReason, renderDivergence, retakePrdSnapshot } from "./prd.mjs";
import { gate, denialsPrompt, receiptInstructions, receiptHash, receiptHashes } from "./deliverable.mjs";
import { normalizePublicBody } from "./block.mjs";
import { ROUND_MARKER, NUDGE_MARKER, READY_LABEL, NEEDS_LABEL, actor, normalizeLogin } from "./gh.mjs";
import { publicPrViolations, publicCommentViolations, publicCorrection, publicReviewHash } from "./public_output.mjs";
import { hasLegacyStatusLabels } from "./public-format.mjs";
import { adapterFor, buildRun, capabilitiesFor } from "./harness.mjs";
import { executionRunner, unsubmittedInitialDispatch } from "./execution.mjs";
import { reconcileExecutionResult, executionResultCheckpoint, requireVerificationSandbox } from "./execution_result.mjs";
import { readJson } from "./fs.mjs";
import { join } from "node:path";
import { runEnv, prdIdFromBranch } from "./git.mjs";
import { resolveCredentialFor } from "./credential.mjs";
import { requireIdentity } from "./identity.mjs";
import { resolveContextPaths, resolveTimeout } from "./config.mjs";
import { nowIso, minutes, hours, earlier, later, floorSecond } from "./time.mjs";
import { writeRepositoryText } from "./repository_files.mjs";
import { applyControl, interruptControl, cancelControl, controlPending, cancellationStatus } from "./control.mjs";
import { tickChains } from "./chains.mjs";
import { taskExecutionConfig, taskProviderAllowance } from "./task_allowance.mjs";

const CONCURRENCY = 4;

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
export const PUBLIC_METADATA = "public metadata write";
export const REGULAR_PR = "regular PR conversion";

/** Two GitHub timestamps for the same instant, however each is spelled. */
const sameInstant = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);

/** One second before a cursor: the overlap a server-side `since` filter is asked for. See `tickEntry`. */
const fetchFrom = iso => (iso ? new Date(Date.parse(floorSecond(iso)) - 1000).toISOString() : iso);

export function makeTick(deps) {
  // `writePrd` is here for one caller: the re-snapshot of a brief edited outside its contract. It is the only write to
  // the snapshot the tick makes, and it is not the tick overruling the operator, it is the tick following them.
  const { config, state, gh, git, notify, log, clock = Date, ownLogin, readPrd, writePrd = () => {}, fetch = globalThis.fetch, aportApiKey = null, credential: ctxCredential = null, identity: ctxIdentity = null } = deps;
  const runnerFor = id => executionRunner(deps, id);
  const startupReconciliation = new Set(deps.startupReconciliation === false ? [] : state.entries().map(([id]) => id));
  let nextChainAt = 0;
  const trust = makeTrust(config, ownLogin);
  const now = () => nowIso(clock);

  const save = (id, patch) => state.update(id, { ...patch, updated_at: now() });

  const recoveryIdentity = (entry, session = entry.session) => ({ prd: entry.prd, harness: entry.harness, session, branch: entry.branch });

  // Keep this boundary separate from the event cursor: an uncorrected own reply must not disappear after a dispatch.
  const ownPublicComments = (entry, comments) => comments.filter(c => {
    const author = actor(c.user ?? c.author);
    return !author.bot && author.login === normalizeLogin(ownLogin)
      && !isFixCommand(c.body)
      && Date.parse(c.updated_at ?? c.updatedAt ?? c.submitted_at ?? c.created_at ?? c.createdAt) >= Date.parse(entry.public_since);
  });

  async function currentPublicComments(entry) {
    const [comments, inline, reviews] = await Promise.all([
      gh.issueComments(entry.repo, entry.pr, fetchFrom(entry.public_since)),
      gh.inlineComments(entry.repo, entry.pr, fetchFrom(entry.public_since)),
      gh.reviews(entry.repo, entry.pr),
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
    const e = save(id, { state: STATES.needsHuman, reason, gate_skipped: null, timeout: null, ...extra });
    log.warn(`${id}: needs-human (${reason})`);
    const written = e.pr ? await writeStopLabels(id, e) : true;
    // Unlike the ready label, this one cannot hold the state back: the entry IS stopped, and the registry, `status`,
    // `why` and the message are all signals in their own right. What it must not do is give up: a rate-limited or
    // briefly unreachable GitHub used to leave the PR carrying `ready-for-human` and no `needs-human` while the
    // registry said stopped, with nothing that would ever reconcile it, because every later tick returns early on
    // this state. So the failure is recorded and `tickEntry` retries it before that early return.
    const patch = written ? (e.labels_pending ? { labels_pending: false } : null) : { labels_pending: true };
    const saved = patch ? save(id, patch) : e;
    await notify.needs({ entry: saved, max: config.max_iterations, handle: handleFor(id, saved) });
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
    try { await gh.removeLabel(e.repo, e.pr, READY_LABEL); }
    catch (err) { removed = false; log.warn(`${id}: ready label not removed (${err.message})`); }
    try { await gh.addLabel(e.repo, e.pr, NEEDS_LABEL); }
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

  async function retryFailed(id, entry, op, err, { action, onStop = {} }) {
    const count = (entry.retry?.op === op ? entry.retry.count : 0) + 1;
    if (count < MAX_STEP_FAILURES) {
      log.warn(`${id}: ${op} failed (${err.message}); ${action} (attempt ${count} of ${MAX_STEP_FAILURES})`);
      save(id, { retry: { op, count, ...(op === COMPLETION_GATE ? { error: err.message } : {}) } });
      return false;
    }
    log.error(`${id}: ${op} failed ${count} ticks in a row (${err.message}); stopping`);
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
      last: { ...(entry.last || {}), ...(stopLast || {}), at: now(), event: `${op} failed ${count} ticks in a row: ${err.message}` },
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
    for (const rel of entry.sources ?? []) {
      const text = deps.readSource?.(id, rel);
      if (text == null) throw new Error(`${rel}: carried-file snapshot is missing`);
      writeRepositoryText(entry.worktree, rel, text);
    }
  };

  /** The checkout, recreated from the PR branch when it is gone (a lost disk, a cleaned worktrees folder). */
  const ensureWorktree = async (id, entry) => {
    if (!git.exists(entry.worktree)) {
      await git.fromBranch({ nameWithOwner: entry.repo, prdId: prdIdFromBranch(entry.branch) ?? prdIdOf(id), branch: entry.branch, path: entry.worktree });
      restoreSources(id, entry);
    }
  };

  /**
   * Bring the base branch into this branch before a session is handed the worktree, so a round of work starts from the
   * current base rather than from wherever the base was when the branch was cut. A branch cut on Monday and fixed on
   * Thursday drifts, and the first sign of the drift today is `mergeable: CONFLICTING`, which stops the entry.
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
   * A conflict is the caller's to handle: nothing is left half-merged (`git.mergeBase` aborts), and this returns the
   * failure rather than throwing so the caller can stop the entry and name the base it could not merge.
   */
  async function mergeBaseInto(id, entry) {
    // A base is needed to merge one, and an entry can lack one: everything `register` and `reconcile` built before this
    // field existed, and anything they build for a PR whose `baseRefName` could not be read. Nothing to merge is not a
    // failure, it is a round that behaves exactly as every round did before this existed.
    if (!entry.base || !git.mergeBase) return null;

    let r;
    try { await git.ensureHttpsRemote?.(entry.worktree); r = await git.mergeBase(entry.worktree, entry.base); }
    catch (e) {
      // The fetch or a rev-parse failed, so no merge was attempted and the tree is untouched. Same shape as a conflict
      // to the caller, because the outcome for this round is the same: it does not start, and the operator is told which
      // base could not be brought in.
      return { merged: false, conflict: true, base: entry.base, why: e.message.split("\n").find(l => l.trim()) || e.message };
    }
    if (r?.conflict) return r;
    if (r?.merged) {
      log.info(`${id}: merged origin/${entry.base} into ${entry.branch} before the run (${r.sha ? r.sha.slice(0, 7) : "merge commit"})`);
      save(id, { base_merge: { at: now(), base: r.base, sha: r.sha ?? null, onto: r.head ?? null } });
    }
    return r;
  }

  /**
   * Post one of the daemon's marked comments unless it is already there. The comment goes to GitHub before the
   * registry is saved, so a crash in between leaves a comment, not a lost one; the check makes the retry harmless.
   */
  async function commentOnce(entry, body, marker, sinceIso) {
    const own = await gh.issueComments(entry.repo, entry.pr, sinceIso);
    if (hasOwnComment(own, ownLogin, marker, sinceIso)) return false;
    await gh.comment(entry.repo, entry.pr, body);
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
    await gh.removeLabel(entry.repo, entry.pr, READY_LABEL);
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
      cursor: { ...entry.cursor, fixed_sha: pr.headRefOid },
      rereview: { at: askedAt(entry, pushedAt), nudged: false },
    });
    log.info(`${id}: head moved to ${pr.headRefOid.slice(0, 7)}${wasReady ? " after ready" : ""}; watching again`);
    return saved;
  }

  function assertProviderHealth(entry) {
    const health = deps.providerHealth?.get(entry.harness, config.harness[entry.harness]?.account || "operator");
    if (health && !health.ok) throw Object.assign(new Error(`provider health unavailable: ${health.detail}; ${health.fix || "restore this provider account"}`), { code: "PROVIDER_UNAVAILABLE" });
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
  async function startRun(id, entry, { name, prompt, ownership = null }) {
    if (entry.dispatch_stopped) throw Object.assign(new Error(`dispatch stopped: ${entry.dispatch_stopped}`), { code: "EXECUTION_STOPPED" });
    assertProviderHealth(entry);
    if (capabilitiesFor(entry.harness).transport === "remote") await requireVerificationSandbox();
    await git.ensureHttpsRemote?.(entry.worktree);
    if (entry.brief_changes?.length && name !== "resume") {
      // A prior manual resnapshot may have failed after updating daemon state but before copying into the checkout.
      const brief = readPrd(id);
      if (entry.prd && brief != null) writeRepositoryText(entry.worktree, entry.prd, brief);
      restoreSources(id, entry);
      prompt = `THE BRIEF HAS CHANGED. Reread the brief and its carried files in the worktree.\n${entry.brief_changes.join("\n")}\n\n${prompt}`;
    }
    const execution = runnerFor(id), remote = execution.capabilities?.transport === "remote";
    const mode = entry.session ? "resume" : "start";
    const session = entry.session || (remote ? null : adapterFor(entry.harness).newSession());
    // Extra read-only directories, resolved in one place (lib/config.mjs) from the operator's config list plus the
    // frontmatter of the daemon's OWN snapshot of the brief. The snapshot is what stops a session widening its
    // reads by editing the PRD it was handed.
    const runConfig = taskExecutionConfig(config, entry.task, execution);
    const contextPaths = resolveContextPaths(runConfig, prdFor(id));
    const spec = remote ? null : buildRun({ harness: entry.harness, config: runConfig, mode, session, prompt, cwd: entry.worktree, contextPaths });
    // The host comes from this entry's own checkout, so an enterprise remote asks `gh` for that host's token rather
    // than sending it a github.com one.
    const credential = await resolveCredentialFor({ config, git, credential: ctxCredential }, { worktree: entry.worktree });
    if (!credential.token) throw Object.assign(new Error(credential.why), { code: "NO_CREDENTIAL" });
    // The identity the session commits as, resolved per run for the reason lib/identity.mjs gives: the daemon is
    // long-lived and an operator may change theirs under it. This is the path `resume` and every fix round take.
    const identity = await requireIdentity({ identity: ctxIdentity });
    // The `commit-msg` hook, on every run rather than only on a clone, and here rather than in `ensureWorktree`
    // because this is the one function both paths into a session pass through: `dispatch` calls it for a fix round and
    // `gallivant resume` calls it directly, skipping `ensureWorktree` altogether. `git.fromBranch` installs the hook
    // itself, so a FRESH checkout was always guarded; one already on disk went through no clone path at all, which is
    // every checkout made before the hook existed. Found on a live resume: the session dropped the attribution trailer
    // because the prompt told it to, and `.git/hooks/commit-msg` had never been written, so the half meant to enforce
    // it was absent. Idempotent and never fatal, so this costs a stat and cannot fail a run.
    const hook = git.installHooks?.(entry.worktree);
    if (hook && !hook.installed) log.warn(`${id}: the commit-msg hook could not be written into ${entry.worktree} (${hook.why}); the prompt still forbids attribution but nothing enforces it this run`);
    const initialDispatch = remote && !session ? unsubmittedInitialDispatch(entry, execution) : null;
    const dispatchInput = { operationId: initialDispatch?.operationId ?? `${entry.last?.run || "initial"}:${entry.iteration}:${name}`, sessionId: entry.session, inputHead: git.head ? await git.head(entry.worktree) : null, workflow: ownership || { state: entry.pr ? STATES.prOpen : STATES.running, reason: null, lastEvent: `recovered ${name} dispatch` } };
    // Checkout/credential/head preparation may outlive the health observation.
    // Recheck the shared scope immediately before provider I/O or local launch.
    assertProviderHealth(entry);
    let job;
    if (remote) {
      const input = deps.executionInputFor
        ? await deps.executionInputFor(id, entry, { ...dispatchInput, name, prompt }, contextPaths)
        : { ...dispatchInput, name, prompt, repo: entry.repo, branch: entry.branch, base: entry.base, allowance: entry.execution?.allowance, mandatoryPolicy: entry.execution?.mandatoryPolicy || [], environment: entry.execution?.environment, model: entry.execution?.model };
      input.allowance = taskProviderAllowance(input.allowance, entry.task);
      await execution.prepare(input);
      assertProviderHealth(entry);
      if (initialDispatch) save(id, { initial_dispatch: { ...initialDispatch, status: "dispatching" }, reason: "dispatch-intent" });
      try { job = await (session && ["native-session", "successor-task"].includes(execution.capabilities.continuation) ? execution.continue(input) : execution.submit({ ...input, sessionId: null })); }
      catch (error) {
        if (initialDispatch && error.dispatchNotSent === true) save(id, { initial_dispatch: initialDispatch, reason: "dispatch-refused", last: { at: now(), run: null, exit: null, event: "managed dispatch refused before any provider request; repair prerequisites and explicitly resume" } });
        throw error;
      }
    } else job = await execution.start(name, spec.cmd, spec.args, { cwd: entry.worktree, env: { ...runEnv(config, credential, identity, entry.worktree), ...spec.env }, execution: dispatchInput });
    return { job, session: job.execution?.sessionId || session };
  }

  /** When a head was pushed, from GitHub, or `fallback` when GitHub cannot say. */
  const headPushedAt = (entry, sha, fallback) => gh.commitDate(entry.repo, sha).then(d => d || fallback).catch(() => fallback);

  /** The reviewer clock for this entry and this head. The rule itself is `events.mjs`; `reconcile` uses the same one. */
  const askedAt = (entry, pushedAt) => reviewerClock({ config, pushedAt, previousAsk: entry.rereview?.at ?? null, floorAt: now() });

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
    const body = owed.kind === "round" ? roundComment(config) : owed.kind === "public-text" ? `Review text updated.\n\n${ROUND_MARKER}` : receiptRoundComment();
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
  async function settleRun(id, entry) {
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
    if (cur.execution?.quarantined) {
      save(id, { last: { ...entry.last, exit: cur.exit ?? 1, event: "late provider result quarantined after stop" } });
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
      // The limit is the repository's when it set one, and the global otherwise (`resolveTimeout`), because how long
      // verification takes is a property of the codebase. A run was killed at 31.2 minutes against a 30 minute global
      // with its work finished and four commits on disk, in a repository whose two Verify commands take 2m30s each.
      const limit = resolveTimeout({ config, repo: entry.repo });
      if (entry.task?.deliveryAllowance) limit.minutes = Math.min(limit.minutes, taskExecutionConfig(config, entry.task, runner, { excludeRunId: cur.id }).run_timeout_minutes);
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
    if (entry.last?.exit != null) return false;

    const lines = runner.outcome && runner.sessionFrom ? [] : runner.lines(cur.id);
    const outcome = runner.outcome ? runner.outcome(cur.id) : adapterFor(entry.harness).outcome(lines);
    const job = runner.settle(cur.id, () => (outcome.ok ? 0 : 1));
    const session = entry.session || (runner.sessionFrom ? runner.sessionFrom(cur.id) : adapterFor(entry.harness).sessionFrom(lines));
    if (runner.collect && outcome.finished && !cur.execution?.collected) await runner.collect();
    const last = { at: now(), run: cur.id, exit: job.exit, event: entry.last?.event || "start", cost: outcome.cost, denials: outcome.denials };

    const interrupted = entry.control?.status === "queued" && entry.control.stop_run === cur.id;
    if (interrupted && entry.state !== STATES.running) {
      // An intentional interruption is not a failed review round or a completion.
      // Account for it once, then let the normal control path resume the saved session.
      save(id, { session, state: STATES.needsHuman, reason: "operator-interrupted", last });
      return false;
    }

    if (entry.state === STATES.running) {
      const prs = await gh.prListByHead(entry.repo, entry.branch);
      let pr = (prs || []).find(p => !p.isCrossRepository);
      if (!pr) {
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
        await needsHuman(id, "no-pr", { session, last: { ...last, event: `${last.event}${left}` }, ...(tree ? { tree } : {}) });
        return false;
      }
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
          pr = await gh.setRecoveryMetadata(entry.repo, pr.number, identity, { taskId: id });
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
        state: STATES.prOpen, session, pr: pr.number, url: pr.url, last, retry: null,
        cursor: { since: pr.createdAt, dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
        rereview: { at: pr.createdAt, nudged: false },
      });
      log.info(`${id}: PR #${pr.number} open`);
      return false;
    }

    // A fix run ended. Progress is the head moving or the receipt changing; anything else is a stop.
    const pr = await gh.prView(entry.repo, entry.pr);
    const pushed = pr.headRefOid !== entry.cursor.fixed_sha;
    const hash = receiptHash(pr.body);
    const rewrote = !pushed && hash !== null && !receiptHashes(pr.body).includes(entry.cursor.receipt_hash);
    const publicComments = entry.public_fix ? await currentPublicComments(entry) : [];
    const reworded = entry.public_fix && publicReviewHash(pr, publicComments) !== entry.public_fix;
    if (entry.public_fix && !pushed && !rewrote && !reworded) {
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
        session, last, public_fix: null, iteration: entry.iteration + 1,
        // Recorded as unsent, cleared the moment it lands. Same shape as `labels_pending`, which a stopped entry
        // carries for the same reason: the state has moved and one GitHub write is still owed, so the entry names the
        // debt and a later tick pays it. `retry` is NOT cleared here, because nothing has been written to GitHub yet;
        // it is cleared by the write landing, in `postRoundComment`.
        round_comment: owed,
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
    const { name, events, denials = null, summary, since, publicFix = null } = spec;
    if (entry.dispatch_stopped) return;
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
    // A conflict stops the entry, naming the base. This is a stop rather than a retry because a conflict does not
    // resolve on its own: the next tick would try the same merge against the same two commits and abort again, forever.
    // `git.mergeBase` has already run `git merge --abort`, so the worktree is clean and the session that is not spawned
    // was never handed a tree with conflict markers in it, which is the failure this ordering exists to prevent.
    const merged = await mergeBaseInto(id, entry);
    if (merged?.conflict) {
      log.warn(`${id}: ${entry.branch} could not be merged with origin/${merged.base}: ${merged.why}`);
      await needsHuman(id, "base-conflict", {
        base_merge: { at: now(), base: merged.base, conflict: true, why: merged.why },
        last: { at: now(), event: `cannot merge origin/${merged.base} into ${entry.branch}: ${merged.why}` },
      });
      return;
    }
    // `mergeBaseInto` saved the merge, so the entry in hand is one read behind whenever it merged. Re-read rather than
    // patch it here: every later step in this function reads `entry`, and one of them writing a stale `base_merge` back
    // would undo the record that was just made.
    if (merged?.merged) entry = state.get(id) ?? entry;
    const fix = { repo: entry.repo, pr: entry.pr, headSha: pr.headRefOid, events, receipt: receiptFor(id), denials, merged: merged?.merged ? merged : null };
    const prompt = entry.session
      ? fixPrompt({ ...fix, verify: verifyFor(id) })
      : `${registerPrompt({ repo: entry.repo, pr: entry.pr })}\n\n${fixPrompt({ ...fix, verify: [] })}`;
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
    try { started = await startRun(id, entry, { name, prompt, ownership }); }
    catch (e) {
      if (e.dispatchNotSent === true) {
        await needsHuman(id, "dispatch-refused", { last: { ...entry.last, at: now(), event: "managed dispatch refused before any provider request; repair prerequisites and explicitly resume" } });
        return;
      }
      // One run per entry is the lock, and the runner enforces it. A leftover run this entry never dispatched can be
      // holding it: `settleRun` now ignores such a run rather than waiting on it, which is right, but it means the
      // dispatch can arrive while the runner is still busy. That is a wait, not an error, and it resolves when the
      // leftover ends. The cursor is not moved, so the same feedback is dispatched on the tick that finds it free.
      if (e.code === "BUSY") { log.info(`${id}: ${e.message}; dispatching ${summary} once it is free`); return; }
      if (e.code === "PROVIDER_UNAVAILABLE") { log.info(`${id}: dispatch waiting for its provider/account health`); return; }
      // No credential is an operator problem, not a transient one: retrying every tick would spend nothing but would
      // also never resolve, and the entry would sit `pr-open` with feedback nobody is acting on. Stop it and say so.
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
    const { job, session } = started;
    const dispatchedChecks = events.some(e => e.kind === "check");
    save(id, {
      state: STATES.prOpen, session, brief_changes: null, public_fix: publicFix,
      // The cursor and the keys handled at it move together: everything dispatched in the boundary second is
      // remembered, so an event sharing that second is still read next tick but never sent a second time.
      cursor: { ...advanceCursor(entry.cursor, since, events.filter(e => e.id != null && sameInstant(e.at, since)).map(eventKey)), fixed_sha: pr.headRefOid, receipt_hash: receiptHash(pr.body), ...(dispatchedChecks ? { checks_sha: pr.headRefOid } : {}) },
      last: { at: now(), run: job.id, exit: null, event: summary },
    });
    log.info(`${id}: dispatched (${summary})`);
  }

  /** A fix round, or a stop when the round budget is spent. */
  async function fixOrStop(id, entry, pr, spec, deferredDispatches = null) {
    if (entry.iteration >= config.max_iterations) { await needsHuman(id, "iterations", { last: { at: now(), event: spec.summary } }); return; }
    await dispatch(id, entry, pr, spec, deferredDispatches);
  }

  /**
   * "Green" for a head that has no checks yet: GitHub reports an empty rollup for the first seconds after a push,
   * before any workflow is queued. A young head with nothing reported is not green, it is not reported yet.
   */
  async function checksSettled(entry, pr) {
    if ((pr.statusCheckRollup || []).length) return isGreen(pr.statusCheckRollup);
    const pushedAt = await headPushedAt(entry, pr.headRefOid, entry.cursor.since);
    return clock.now() - Date.parse(pushedAt) > minutes(config.checks_grace_minutes);
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
    const publicationPending = savedResult?.outcome?.ok === true && (savedResult.files || savedResult.pushedHead) && readJson(join(execution.dirOf(run.id), "result-application.json"))?.phase !== "published";
    if (!run?.execution?.quarantined && (run?.execution?.providerState === "retrieving-results" || publicationPending) && execution.capabilities?.transport === "remote") {
      if (readOnly) return false;
      try {
        const result = await execution.collect();
        // Transports return artifacts or an exact pushed head. Only this shared
        // boundary may materialize and publish them into the normal review loop.
        if (result?.outcome?.ok === true && (result.files || result.pushedHead)) {
          entry = state.get(id) || entry;
          const published = await reconcileExecutionResult(deps, { id, entry: { ...entry, execution: run.execution }, result, dir: execution.dirOf(run.id) });
          save(id, { pr: published.pr.number, url: published.pr.url });
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

  async function tickEntry(id, entry, { skipReconciliation = false, deferredDispatches = null, settleOnly = false } = {}) {
    if (await cancelControl(deps, id)) return;
    const execution = runnerFor(id);
    if (execution.reconcile) {
      if (!skipReconciliation) await execution.reconcile({ force: startupReconciliation.delete(id) });
      const pending = execution.current();
      if (entry.reason === "dispatch-intent" && pending?.execution?.acceptance === "accepted" &&
          pending.execution.operationId === entry.execution?.operationId && !pending.execution.quarantined) {
        entry = save(id, { state: STATES.running, reason: null, initial_dispatch: null, session: pending.execution.sessionId, execution: pending.execution,
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
    if (entry.state === STATES.done) { if (!settleOnly) await applyControl(deps, id); return; }
    if (!entry.public_since) entry = save(id, { public_since: floorSecond(now()) });
    if (interruptControl(deps, id)) {
      await needsHuman(id, "run-stop-unverified");
      return;
    }
    entry = state.get(id);
    if (await settleRun(id, entry)) return;
    // Phase-bounded live campaigns reuse settlement/publication, but must not
    // authorize another paid review or queued resume in the same observation.
    if (settleOnly) return;
    if (await applyControl(deps, id)) return;
    entry = state.get(id);
    if (!entry || entry.state === STATES.running || entry.state === STATES.done || !entry.pr) return;
    if (deps.executionFor && entry.review_next_at && clock.now() < entry.review_next_at && !controlPending(entry.control)) return;
    if (deps.executionFor) entry = save(id, { review_next_at: clock.now() + config.poll_seconds * 1000 });

    let pr = await gh.prView(entry.repo, entry.pr);
    if (pr.state === "MERGED" || pr.state === "CLOSED") { save(id, { state: STATES.done }); log.info(`${id}: ${pr.state.toLowerCase()}`); return; }
    // Regular means reviewable, not complete. Registration adopts the same policy as start. Recover only legacy
    // draft-specific stops; no other needs-human reason is cleared by changing this GitHub presentation state.
    if (entry.state === STATES.needsHuman && entry.reason === "draft") {
      entry = save(id, { state: STATES.prOpen, reason: null, retry: null });
    }
    if (entry.state === STATES.needsHuman) {
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
        pr = await gh.setRecoveryMetadata(entry.repo, entry.pr, identity, { taskId: id });
        if (sameReceipt && receiptHash(pr.body) === beforeReceipt) entry = save(id, { cursor: { ...entry.cursor, receipt_hash: beforeReceipt } });
      }
      if (entry.retry?.op === PUBLIC_METADATA) entry = retryOk(id, entry);
    } catch (err) {
      await retryFailed(id, entry, PUBLIC_METADATA, err, { action: "retrying the structured metadata migration next tick" });
      return;
    }
    if (pr.isDraft) {
      try { await gh.markReady(entry.repo, entry.pr); }
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
    if (pr.mergeable === "CONFLICTING") { await needsHuman(id, "conflict"); return; }

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
    const [reviews, inline, comments] = await Promise.all([
      gh.reviews(entry.repo, entry.pr),
      gh.inlineComments(entry.repo, entry.pr, fetchFrom(inlineSince)),
      gh.issueComments(entry.repo, entry.pr, fetchFrom(earlier(entry.cursor.since, entry.public_since))),
    ]);
    const ownComments = ownPublicComments(entry, [...comments, ...inline, ...reviews.map(r => ({ ...r, public_kind: "review" }))]);
    const publicViolations = [...publicPrViolations(pr), ...publicCommentViolations(ownComments)];
    if (publicViolations.length) {
      await fixOrStop(id, entry, pr, { name: "public-text", events: [], denials: publicCorrection(publicViolations), summary: `public text correction: ${publicViolations.join("; ")}`, since: entry.cursor.since, publicFix: publicReviewHash(pr, ownComments) }, deferredDispatches);
      return;
    }
    const { events, newest } = deriveEvents({ pr, reviews, inline, comments, entry, trust });

    if (events.length) {
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
    if (entry.state === STATES.ready && hasLegacyStatusLabels(pr.labels)) {
      try { await gh.addLabel(entry.repo, entry.pr, READY_LABEL); }
      catch (err) {
        await retryFailed(id, entry, READY_LABEL_WRITE, err, { action: "retrying the neutral ready label next tick" });
        return;
      }
      entry = retryOk(id, entry);
    }
    if (entry.state !== STATES.prOpen) return;
    const verdict = reviewerVerdict({ reviews, inline, comments, config, trust, sinceIso: entry.rereview.at, headSha: pr.headRefOid, dispatched: entry.cursor.dispatched });
    const green = await checksSettled(entry, pr);
    if (!pr.isDraft && green && (verdict.verdict === "clear" || verdict.verdict === "none")) {
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
      if (div.verdict === "same" && div.repoText !== readPrd(id)) {
        // `retakePrdSnapshot` writes the file and the fingerprint through `state.update`, so the local `entry` is now one
        // version behind and everything below judges this head with it. `state.get` rather than an empty `save`, which
        // would read as a no-op to the next person and only happens to re-read as a side effect of touching
        // `updated_at`. The cached parse is replaced too, so `verifyFor` and `receiptFor` on this same pass carry the
        // brief that is now on disk rather than the one that was.
        retakePrdSnapshot({ log, writePrd, state }, { id, divergence: div });
        prds.set(id, div.repo);
        entry = state.get(id);
        log.info(`${id}: the brief was edited outside its contract; snapshot re-taken from ${div.path} and nothing restarted`);
      } else if (entry.prd_divergence) {
        entry = save(id, { prd_divergence: null });
      }
      // The completion gate: the last step before a human is asked to look. Only for entries with a PRD.
      const prd = config.deliverable ? prdFor(id) : null;
      // An entry with no snapshot reaches ready on the checks and the reviewer alone, with nothing about what the PR
      // was supposed to deliver ever read. That used to be one line in `errors.log` and nothing anywhere else:
      // `status`, `why`, the ntfy message and the PR all said what they say for a PR that passed the gate. So it is
      // carried on the entry, where the three of them can say it.
      const gateSkipped = config.deliverable && !prd ? "no PRD snapshot" : null;
      if (gateSkipped) log.warn(`${id}: ${gateSkipped}, completion gate skipped`);
      if (prd) {
        const criteria = criteriaFromPrd(prd);
        // The output scan needs the whole diff. A diff that cannot be read is not an empty diff: `addedLines(null)`
        // is the empty string, which passes the blocked-pattern scan trivially, so a transient `gh pr diff` failure
        // would let a PR through the very check it is meant to face. A diff too large to hold is the same fail-open
        // one step further on, and `gh.prDiff` throws for it rather than returning a prefix that looks whole. No
        // decision either way: retry with the shared bound, then stop with the cause if it still cannot be read.
        let diff = null;
        if (config.deliverable.scan_output) {
          let raw;
          try { raw = await gh.prDiff(entry.repo, entry.pr); }
          catch (e) { raw = e; }
          // Anything that is not diff text is unreadable, a thrown error and an absent diff alike, so no future
          // caller can reintroduce the fail-open by handing the scan a value that merely looks empty.
          if (typeof raw !== "string") {
            await retryFailed(id, entry, COMPLETION_GATE, new Error(`diff unreadable: ${raw instanceof Error ? raw.message : `gh pr diff returned ${raw}`}`), { action: "reviewer clear; retrying the output scan next tick" });
            return;
          }
          diff = addedLines(raw);
        }
        // `framework` is the harness that did the work, carried as self-reported provenance in the decision's
        // context so a machine running two harnesses can tell their decisions apart afterwards.
        const g = await gate({ taskId: id, prBody: pr.body, criteria, checksGreen: true, diff, framework: entry.harness, limits: config.deliverable, apiKey: aportApiKey, fetch, log });
        if (g.pending) {
          await retryFailed(id, entry, COMPLETION_GATE, new Error(g.denials?.map(d => d.message).join("; ") || g.source), { action: "reviewer clear; retrying the evaluator next tick" });
          return;
        }
        if (!g.allow) {
          const codes = g.denials.map(d => d.code).join(", ");
          log.info(`${id}: completion gate (${g.source}) denied: ${codes}`);
          await fixOrStop(id, entry, pr, { name: "receipt", events: [], denials: `${denialsPrompt(g.denials)}\n\n${receiptInstructions(criteria, id)}`, summary: `receipt denied: ${codes}`, since: readAt }, deferredDispatches);
          return;
        }
        log.info(`${id}: completion gate passed (${g.source})`);
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
      try { await gh.addLabel(entry.repo, entry.pr, READY_LABEL); }
      catch (err) {
        await retryFailed(id, entry, READY_LABEL_WRITE, err, { action: "staying in pr-open and trying again next tick" });
        return;
      }
      // Cleared before the state moves, not after, so `retry` is never set on a `ready` entry: nothing retries a ready
      // entry's label, and a stale count there would outrank the ready row in `status` and hide the one thing the
      // operator is being asked to act on.
      entry = retryOk(id, entry);
      const e = save(id, { state: STATES.ready, gate_skipped: gateSkipped, retry: null });
      await notify.ready({ entry: e, max: config.max_iterations, checks: (pr.statusCheckRollup || []).length, reviewerNote: verdict.note });
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
      if (entry.cursor.checks_sha === pr.headRefOid && entry.last?.event !== event) await needsHuman(id, "checks-red", { last: { at: now(), event } });
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
    if (verdict.verdict === "waiting" && entry.rereview.at && !asked) {
      const waited = clock.now() - Date.parse(entry.rereview.at);
      if (waited > hours(config.stall_hours)) { await needsHuman(id, "reviewer-silent"); return; }
      if (waited > minutes(config.rereview_minutes) && !entry.rereview.nudged) {
        const posted = await commentOnce(entry, nudgeComment(config), NUDGE_MARKER, entry.rereview.at);
        save(id, { rereview: { ...entry.rereview, nudged: true } });
        log.info(`${id}: ${posted ? "nudged reviewer" : "nudge already posted"}`);
      }
    }
  }

  /**
   * One pass over every entry, a few at a time. Errors are per entry, so one bad PR never stalls the rest. Entries
   * are independent: each has its own runner root, and the registry serialises writes with a lock.
   */
  async function tick() {
    prds.clear();
    const entries = state.entries(), queue = [...entries], progressQueue = [...entries], deferredDispatches = [];
    const results = [];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [id, entry] = next;
        try { await tickEntry(id, state.get(id) || entry, { skipReconciliation: Boolean(deps.executionFor), deferredDispatches }); results.push({ id, ok: true }); }
        catch (e) { log.error(`${id}: ${e.message}`); results.push({ id, ok: false, error: e.message }); }
      }
    };
    const progressWorker = async () => {
      for (let next = progressQueue.shift(); next; next = progressQueue.shift()) {
        const [id] = next;
        try {
          const runner = runnerFor(id);
          await runner.reconcile?.({ force: startupReconciliation.delete(id) });
          const current = runner.current();
          if (current?.execution) state.update(id, entry => {
            const ex = current.execution;
            const owned = ex.acceptance === "accepted" && ex.operationId?.startsWith(`${entry.last?.run || "initial"}:${entry.iteration}:`) && current.id !== entry.last?.run;
            const { lastEvent, ...workflow } = ex.workflow || {};
            return { execution: ex, ...(owned ? { ...workflow, session: ex.sessionId || entry.session, last: { at: now(), run: current.id, exit: null, event: lastEvent || "recovered accepted execution" } } : {}) };
          });
          if (runner.reconcile) await reconcileResults(id, state.get(id), runner);
        }
        catch (error) { log.warn(`${id}: progress reconciliation failed (${error.code || "transport error"})`); }
      }
    };
    const concurrency = Math.min(config.execution?.concurrency || CONCURRENCY, entries.length);
    // Independent bounded lanes: provider I/O cannot occupy every GitHub worker.
    await Promise.all([
      ...Array.from({ length: concurrency }, worker),
      ...(deps.executionFor ? Array.from({ length: concurrency }, progressWorker) : []),
    ]);
    // Pending health cannot occupy review workers. Retry these dispatches once
    // in this tick after their existing scoped probe has saved its observation.
    const dispatchWorker = async () => {
      for (let next = deferredDispatches.shift(); next; next = deferredDispatches.shift()) {
        const { id, entry, pr, spec, refreshed } = next;
        try {
          await refreshed;
          const current = state.get(id);
          if (!current || ![STATES.prOpen, STATES.ready].includes(current.state) || current.pr !== entry.pr ||
            current.harness !== entry.harness || current.last?.run !== entry.last?.run || JSON.stringify(current.cursor) !== JSON.stringify(entry.cursor)) continue;
          await fixOrStop(id, current, pr, spec);
        } catch (e) {
          log.error(`${id}: ${e.message}`);
          Object.assign(results.find(result => result.id === id), { ok: false, error: e.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, deferredDispatches.length) }, dispatchWorker));
    // Chain merge/ancestry reads retain the review cadence, even when remote
    // progress makes the coordinator wake more often. Boot reconciles once.
    if (clock.now() >= nextChainAt) {
      nextChainAt = clock.now() + config.poll_seconds * 1000;
      results.push(...await tickChains(deps));
    }
    return results;
  }

  return { tick, tickEntry, startRun, needsHuman, mergeBaseInto, reopen };
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
