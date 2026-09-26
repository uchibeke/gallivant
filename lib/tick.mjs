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
import { deriveEvents, makeTrust, reviewerVerdict, isGreen, addedLines, hasOwnComment, eventKey } from "./events.mjs";
import { fixPrompt, registerPrompt } from "./prompt.mjs";
import { parsePrd, verifyCommands } from "./prd.mjs";
import { criteriaFromPrd, gate, denialsPrompt, receiptInstructions, receiptHash } from "./deliverable.mjs";
import { upsertBlock, parseBlock } from "./block.mjs";
import { ROUND_MARKER, NUDGE_MARKER, READY_LABEL, NEEDS_LABEL } from "./gh.mjs";
import { adapterFor, buildRun } from "./harness.mjs";
import { runEnv, prdIdFromBranch } from "./git.mjs";
import { resolveContextPaths } from "./config.mjs";
import { nowIso, minutes, hours, earlier, later, floorSecond } from "./time.mjs";

const CONCURRENCY = 4;

/** Two GitHub timestamps for the same instant, however each is spelled. */
const sameInstant = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);

/** One second before a cursor: the overlap a server-side `since` filter is asked for. See `tickEntry`. */
const fetchFrom = iso => (iso ? new Date(Date.parse(floorSecond(iso)) - 1000).toISOString() : iso);

export function makeTick(deps) {
  const { config, state, gh, git, notify, log, clock = Date, ownLogin, runnerFor, readPrd, fetch = globalThis.fetch, aportApiKey = null } = deps;
  const trust = makeTrust(config, ownLogin);
  const now = () => nowIso(clock);

  const save = (id, patch) => state.update(id, { ...patch, updated_at: now() });

  /**
   * The one way into needs-human, so every path through it leaves the same two labels. The ready label comes off as
   * the needs-human label goes on: an entry that was ready and then hit a conflict, a red head or a blocking
   * reviewer would otherwise carry both, which tells a person, and any automation reading labels, two opposite
   * things. Removal is unconditional rather than guarded on the entry's own state, because a label left by an
   * earlier daemon outlives the registry; `removeLabel` already ignores a label that is not there.
   */
  async function needsHuman(id, reason, extra = {}) {
    const e = save(id, { state: STATES.needsHuman, reason, gate_skipped: null, ...extra });
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
    // The removal is asked for strictly, so a GitHub that is not answering is not mistaken for a label that was
    // already off, but it does not decide the retry on its own: whether GitHub is reachable at all is the same
    // question for both writes, and `addLabel` is the one that must land, so that is what the retry tracks. A
    // removal that fails for any other reason is retried with it on the next tick.
    let removed = true;
    try { await gh.removeLabel(e.repo, e.pr, READY_LABEL, { strict: true }); }
    catch (err) { removed = false; log.warn(`${id}: ready label not removed (${err.message})`); }
    try { await gh.addLabel(e.repo, e.pr, NEEDS_LABEL); }
    catch (err) { log.warn(`${id}: needs-human label not written (${err.message}); retrying next tick`); return false; }
    if (!removed) log.warn(`${id}: retrying the ready-label removal next tick`);
    return removed;
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

  /** The checkout, recreated from the PR branch when it is gone (a lost disk, a cleaned worktrees folder). */
  const ensureWorktree = async (id, entry) => {
    if (!git.exists(entry.worktree)) await git.fromBranch({ nameWithOwner: entry.repo, prdId: prdIdFromBranch(entry.branch) ?? prdIdOf(id), branch: entry.branch, path: entry.worktree });
  };

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
   * The write is allowed to throw. Both callers have work after it that must not happen while the PR still says a
   * human may merge, so a failure here is the whole step declining and the next tick asking again from an untouched
   * cursor. A transient GitHub is a tick of nothing, not a run nobody recorded.
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
   * Returns the saved entry when the head changed, else null. Throws if the label write fails, which leaves the
   * whole judgement for the next tick rather than judging a new head with a stale ready label still on the PR.
   */
  async function headChanged(id, entry, pr) {
    if (entry.state !== STATES.ready && entry.state !== STATES.prOpen) return null;
    if (!entry.cursor.fixed_sha || pr.headRefOid === entry.cursor.fixed_sha) return null;
    const wasReady = entry.state === STATES.ready;
    if (wasReady) await reopen(id, entry);
    const pushedAt = await headPushedAt(entry, pr.headRefOid, now());
    const saved = save(id, {
      state: STATES.prOpen, gate_skipped: null,
      cursor: { ...entry.cursor, fixed_sha: pr.headRefOid },
      rereview: { at: reviewerClock(entry, pushedAt), nudged: false },
    });
    log.info(`${id}: head moved to ${pr.headRefOid.slice(0, 7)}${wasReady ? " after ready" : ""}; watching again`);
    return saved;
  }

  /** Spawn a harness run. Resumes when a session exists, otherwise starts a fresh one and returns its id. */
  function startRun(id, entry, { name, prompt }) {
    const mode = entry.session ? "resume" : "start";
    const session = entry.session || adapterFor(entry.harness).newSession();
    // Extra read-only directories, resolved in one place (lib/config.mjs) from the operator's config list plus the
    // frontmatter of the daemon's OWN snapshot of the brief. The snapshot is what stops a session widening its
    // reads by editing the PRD it was handed.
    const contextPaths = resolveContextPaths(config, prdFor(id));
    const spec = buildRun({ harness: entry.harness, config, mode, session, prompt, cwd: entry.worktree, contextPaths });
    const job = runnerFor(id).start(name, spec.cmd, spec.args, { cwd: entry.worktree, env: { ...runEnv(config), ...spec.env } });
    return { job, session };
  }

  /** When a head was pushed, from GitHub, or `fallback` when GitHub cannot say. */
  const headPushedAt = (entry, sha, fallback) => gh.commitDate(entry.repo, sha).then(d => d || fallback).catch(() => fallback);

  /**
   * When the reviewer was last asked to look at the current head. Three timers measure from it: the verdict's
   * boundary, the nudge after `rereview_minutes` and the `reviewer-silent` stop after `stall_hours`. So it must be
   * the moment the ask happened, and the ask is happening now.
   *
   * The best available answer is the head's committer date, which is when the commit was made and not when it
   * arrived on the branch. GitHub does not report the second, and the two differ by however long the commit sat
   * locally: `git commit` on Monday and `git push` on Thursday, or a merge whose tip carries the merged commit's
   * date. A clock older than `stall_hours` stopped the entry as `reviewer-silent` on the very tick that set it, with
   * the reviewer never asked once, and one older than `rereview_minutes` posted the nudge before the first ask.
   *
   * So the committer date is used only as far back as the nudge window: no clock older than that, and never one
   * before the previous ask, since the reviewer cannot have been asked earlier than it already was.
   */
  const reviewerClock = (entry, pushedAt) => {
    const floor = new Date(clock.now() - minutes(config.rereview_minutes)).toISOString();
    return floorSecond(later(later(pushedAt, floor), entry.rereview?.at ?? null));
  };

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
    if (cur.running) {
      if (clock.now() - cur.startedAt > minutes(config.run_timeout_minutes)) {
        runner.kill(cur.id);
        await needsHuman(id, "timeout", { last: { ...(entry.last || {}), run: cur.id, exit: 137, at: now() } });
      }
      return true;
    }
    if (entry.last?.exit != null) return false;

    const adapter = adapterFor(entry.harness);
    const lines = runner.lines(cur.id);
    const outcome = adapter.outcome(lines);
    const job = runner.settle(cur.id, () => (outcome.ok ? 0 : 1));
    const session = entry.session || adapter.sessionFrom(lines);
    const last = { at: now(), run: cur.id, exit: job.exit, event: entry.last?.event || "start", cost: outcome.cost, denials: outcome.denials };

    if (entry.state === STATES.running) {
      const prs = await gh.prListByHead(entry.repo, entry.branch);
      const pr = (prs || []).find(p => !p.isCrossRepository);
      if (!pr) { await needsHuman(id, "no-pr", { session, last }); return false; }
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
      if (!parseBlock(pr.body).block) {
        try { await gh.setBody(entry.repo, pr.number, upsertBlock(pr.body, { prd: entry.prd, harness: entry.harness, session, branch: entry.branch })); }
        catch (err) {
          save(id, { session });
          log.warn(`${id}: PR #${pr.number} block write failed (${err.message}); staying in running and retrying next tick`);
          return false;
        }
      }
      // Events are new from the PR's creation, so a review that landed while the start run was still going is seen.
      save(id, {
        state: STATES.prOpen, session, pr: pr.number, url: pr.url, last,
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
    const rewrote = !pushed && hash !== null && hash !== entry.cursor.receipt_hash;
    if (pushed || rewrote) {
      // The cursor moves to the push itself, so a review that landed between the push and the end of the run is new.
      // The settle time is only the fallback: reviews can land between the push and the end of the run. Floored to
      // the second, since a cursor carrying milliseconds sorts after every GitHub timestamp in the same second and
      // the inclusive comparison in `deriveEvents` would then never see them.
      const pushedAt = pushed ? await headPushedAt(entry, pr.headRefOid, now()) : now();
      const since = floorSecond(pushedAt);
      await commentOnce(entry, pushed ? roundComment(config) : receiptRoundComment(), ROUND_MARKER, entry.cursor.since);
      save(id, {
        session, last, iteration: entry.iteration + 1,
        // `advanceCursor` refuses a candidate before the cursor, so a force-push to an older commit cannot drag the
        // boundary back and make the event that started this round new again.
        cursor: { ...advanceCursor(entry.cursor, since), fixed_sha: pr.headRefOid, receipt_hash: hash },
        // The round comment asking for the re-review was posted a line above, so the ask is now: the committer date
        // only moves the clock back as far as the nudge window, never past it. See `reviewerClock`.
        ...(pushed ? { rereview: { at: reviewerClock(entry, pushedAt), nudged: false } } : {}),
      });
      log.info(`${id}: round ${entry.iteration + 1} ${pushed ? "pushed, re-review requested" : "updated the completion receipt"}`);
      return false;
    }
    await needsHuman(id, outcome.ok ? "no-push" : "harness-error", { session, last: { ...last, error: outcome.error } });
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
  async function dispatch(id, entry, pr, { name, events, denials = null, summary, since }) {
    const fix = { repo: entry.repo, pr: entry.pr, headSha: pr.headRefOid, events, receipt: receiptFor(id), denials };
    const prompt = entry.session
      ? fixPrompt({ ...fix, verify: verifyFor(id) })
      : `${registerPrompt({ repo: entry.repo, pr: entry.pr })}\n\n${fixPrompt({ ...fix, verify: [] })}`;
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
    try { await reopen(id, entry); }
    catch (e) {
      log.warn(`${id}: ready label not removed (${e.message}); not dispatching ${summary} until it is off`);
      return;
    }
    // A harness that refuses the configured context_paths will refuse identically on every tick, so retrying is a
    // loop, not a recovery. Stop the entry and name the reason instead: the fix is an operator edit to the config or
    // to the brief's harness, and nothing the daemon can do on its own.
    let started;
    try { started = startRun(id, entry, { name, prompt }); }
    catch (e) {
      // One run per entry is the lock, and the runner enforces it. A leftover run this entry never dispatched can be
      // holding it: `settleRun` now ignores such a run rather than waiting on it, which is right, but it means the
      // dispatch can arrive while the runner is still busy. That is a wait, not an error, and it resolves when the
      // leftover ends. The cursor is not moved, so the same feedback is dispatched on the tick that finds it free.
      if (e.code === "BUSY") { log.info(`${id}: ${e.message}; dispatching ${summary} once it is free`); return; }
      if (!/context_paths/.test(e.message)) throw e;
      await needsHuman(id, "context-paths", { last: { at: now(), event: e.message } });
      return;
    }
    // No await between the spawn above and this save: the run is recorded, then anything else may fail.
    const { job, session } = started;
    const dispatchedChecks = events.some(e => e.kind === "check");
    save(id, {
      state: STATES.prOpen, session,
      // The cursor and the keys handled at it move together: everything dispatched in the boundary second is
      // remembered, so an event sharing that second is still read next tick but never sent a second time.
      cursor: { ...advanceCursor(entry.cursor, since, events.filter(e => e.id != null && sameInstant(e.at, since)).map(eventKey)), fixed_sha: pr.headRefOid, receipt_hash: receiptHash(pr.body), ...(dispatchedChecks ? { checks_sha: pr.headRefOid } : {}) },
      last: { at: now(), run: job.id, exit: null, event: summary },
    });
    log.info(`${id}: dispatched (${summary})`);
  }

  /** A fix round, or a stop when the round budget is spent. */
  async function fixOrStop(id, entry, pr, spec) {
    if (entry.iteration >= config.max_iterations) { await needsHuman(id, "iterations", { last: { at: now(), event: spec.summary } }); return; }
    await dispatch(id, entry, pr, spec);
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

  async function tickEntry(id, entry) {
    if (entry.state === STATES.done) return;
    if (await settleRun(id, entry)) return;
    entry = state.get(id);
    if (!entry || entry.state === STATES.running || entry.state === STATES.done || !entry.pr) return;

    const pr = await gh.prView(entry.repo, entry.pr);
    if (pr.state === "MERGED" || pr.state === "CLOSED") { save(id, { state: STATES.done }); log.info(`${id}: ${pr.state.toLowerCase()}`); return; }
    if (entry.state === STATES.needsHuman) {
      // The one thing a stopped entry is still asked to do: finish the label write that failed when it stopped, so the
      // PR stops saying the opposite of the registry. Nothing else about the entry changes, and once it lands the
      // entry is left alone again.
      if (entry.labels_pending && await writeStopLabels(id, entry)) save(id, { labels_pending: false });
      return;
    }
    if (pr.mergeable === "CONFLICTING") { await needsHuman(id, "conflict"); return; }

    // Inline comments are fetched from the earlier of the two windows: events use `since`, the reviewer's verdict
    // uses `rereview.at`, and a review that landed before `since` still counts for the verdict.
    const inlineSince = earlier(entry.cursor.since, entry.rereview.at);

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
      gh.issueComments(entry.repo, entry.pr, fetchFrom(entry.cursor.since)),
    ]);
    const { events, newest } = deriveEvents({ pr, reviews, inline, comments, entry, trust });

    if (events.length) {
      const summary = events.map(e => e.kind === "check" ? `check ${e.name}` : `${e.kind} ${e.id ?? ""} by ${e.author}`).join(", ");
      // The newest event dispatched is the boundary: everything up to it is handled, everything after it is still new.
      await fixOrStop(id, entry, pr, { name: "fix", events, summary, since: later(newest, entry.cursor.since) });
      return;
    }

    // A head nobody told the loop about, in one place for both watching states. After the events step, because a batch
    // of events dispatches against the head it just read and sets `fixed_sha` itself; before every judgement below,
    // because each of them measures the reviewer, the checks and the receipt against a head, and it has to be this one.
    const changed = await headChanged(id, entry, pr);
    if (changed) entry = changed;
    if (entry.state !== STATES.prOpen) return;
    const verdict = reviewerVerdict({ reviews, inline, config, trust, sinceIso: entry.rereview.at, headSha: pr.headRefOid, dispatched: entry.cursor.dispatched });
    const green = await checksSettled(entry, pr);
    if (!pr.isDraft && green && (verdict.verdict === "clear" || verdict.verdict === "none")) {
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
        // decision either way: the entry stays in pr-open and the next tick asks again.
        let diff = null;
        if (config.deliverable.scan_output) {
          let raw;
          try { raw = await gh.prDiff(entry.repo, entry.pr); }
          catch (e) { raw = e; }
          // Anything that is not diff text is unreadable, a thrown error and an absent diff alike, so no future
          // caller can reintroduce the fail-open by handing the scan a value that merely looks empty.
          if (typeof raw !== "string") { log.info(`${id}: completion gate has no decision yet (diff unreadable: ${raw instanceof Error ? raw.message : `gh pr diff returned ${raw}`}); trying again next tick`); return; }
          diff = addedLines(raw);
        }
        // `framework` is the harness that did the work, carried as self-reported provenance in the decision's
        // context so a machine running two harnesses can tell their decisions apart afterwards.
        const g = await gate({ taskId: id, prBody: pr.body, criteria, checksGreen: true, diff, framework: entry.harness, limits: config.deliverable, apiKey: aportApiKey, fetch, log });
        if (g.pending) { log.info(`${id}: completion gate has no decision yet (${g.source}); trying again next tick`); return; }
        if (!g.allow) {
          const codes = g.denials.map(d => d.code).join(", ");
          log.info(`${id}: completion gate (${g.source}) denied: ${codes}`);
          await fixOrStop(id, entry, pr, { name: "receipt", events: [], denials: `${denialsPrompt(g.denials)}\n\n${receiptInstructions(criteria, id)}`, summary: `receipt denied: ${codes}`, since: readAt });
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
      try { await gh.addLabel(entry.repo, entry.pr, READY_LABEL); }
      catch (err) { log.warn(`${id}: ready label failed (${err.message}); staying in pr-open and trying again next tick`); return; }
      const e = save(id, { state: STATES.ready, gate_skipped: gateSkipped });
      await notify.ready({ entry: e, max: config.max_iterations, checks: (pr.statusCheckRollup || []).length, reviewerNote: verdict.note });
      log.info(`${id}: ready for a human`);
      return;
    }
    if (pr.isDraft && green && (verdict.verdict === "clear" || verdict.verdict === "none")) {
      // Everything a person waits for has happened and the PR is still a draft, so the ready branch above declined it
      // and every stop below declines it too: the reviewer is clear so neither the blocking nor the waiting branch
      // fires, and the checks are green so the red branch does not. The entry sat in pr-open with nothing left that
      // could happen to it, while `status` said "waiting on reviewer", which the reviewer had already answered. Only
      // a person can take a PR out of draft, so ask one, once per head.
      const event = `draft, otherwise ready, on ${pr.headRefOid.slice(0, 7)}`;
      if (entry.last?.event !== event) await needsHuman(id, "draft", { last: { at: now(), event } });
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
    if (verdict.verdict === "waiting" && entry.rereview.at) {
      const waited = clock.now() - Date.parse(entry.rereview.at);
      if (waited > hours(config.stall_hours)) { await needsHuman(id, "reviewer-silent"); return; }
      if (waited > minutes(config.rereview_minutes) && !entry.rereview.nudged) {
        const posted = await commentOnce(entry, `${config.reviewer.rereview_comment}\n\n${NUDGE_MARKER}`, NUDGE_MARKER, entry.rereview.at);
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
    const queue = state.entries();
    const results = [];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const [id, entry] = next;
        try { await tickEntry(id, entry); results.push({ id, ok: true }); }
        catch (e) { log.error(`${id}: ${e.message}`); results.push({ id, ok: false, error: e.message }); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
    return results;
  }

  return { tick, tickEntry, startRun, needsHuman };
}

export const roundComment = config => `${config.reviewer?.rereview_comment ?? "Pushed a fix."}\n\n${ROUND_MARKER}`;
export const receiptRoundComment = () => `Completion receipt updated.\n\n${ROUND_MARKER}`;
