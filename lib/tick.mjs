// The tick: the one actor that changes state. Every `poll_seconds` it walks the registry once, in the order PRD 6.8
// lays out: settle finished runs, fetch, terminal states, events, dispatch, ready, silence.
//
// All side effects go through injected dependencies (gh, git, runner, notify, clock), so the whole state machine
// runs under `node --test` with fakes and no network.
//
// Cursors, in one place: `since` is the time after which events are new; `fixed_sha` is the head when the last run
// started, so a run that pushed is recognised by the head moving; `checks_sha` is the head whose failing checks
// were already dispatched; `receipt_hash` is the completion receipt when the last run started.
import { STATES, handleFor, prdIdOf } from "./state.mjs";
import { deriveEvents, makeTrust, reviewerVerdict, isGreen, addedLines, hasOwnComment } from "./events.mjs";
import { fixPrompt, registerPrompt } from "./prompt.mjs";
import { parsePrd, verifyCommands } from "./prd.mjs";
import { criteriaFromPrd, gate, denialsPrompt, receiptInstructions, receiptHash } from "./deliverable.mjs";
import { upsertBlock, parseBlock } from "./block.mjs";
import { ROUND_MARKER, NUDGE_MARKER, READY_LABEL, NEEDS_LABEL } from "./gh.mjs";
import { adapterFor, buildRun } from "./harness.mjs";
import { runEnv, prdIdFromBranch } from "./git.mjs";
import { nowIso, minutes, hours, earlier, later } from "./time.mjs";

const CONCURRENCY = 4;

export function makeTick(deps) {
  const { config, state, gh, git, notify, log, clock = Date, ownLogin, runnerFor, readPrd, fetch = globalThis.fetch, aportApiKey = null } = deps;
  const trust = makeTrust(config, ownLogin);
  const now = () => nowIso(clock);

  const save = (id, patch) => state.update(id, { ...patch, updated_at: now() });

  async function needsHuman(id, reason, extra = {}) {
    const e = save(id, { state: STATES.needsHuman, reason, ...extra });
    log.warn(`${id}: needs-human (${reason})`);
    if (e.pr) await gh.addLabel(e.repo, e.pr, NEEDS_LABEL).catch(err => log.warn(`${id}: label failed: ${err.message}`));
    await notify.needs({ entry: e, max: config.max_iterations, handle: handleFor(id, e) });
    return e;
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

  /** Spawn a harness run. Resumes when a session exists, otherwise starts a fresh one and returns its id. */
  function startRun(id, entry, { name, prompt }) {
    const mode = entry.session ? "resume" : "start";
    const session = entry.session || adapterFor(entry.harness).newSession();
    const spec = buildRun({ harness: entry.harness, config, mode, session, prompt, cwd: entry.worktree });
    const job = runnerFor(id).start(name, spec.cmd, spec.args, { cwd: entry.worktree, env: { ...runEnv(config), ...spec.env } });
    return { job, session };
  }

  /** When a head was pushed, from GitHub, or `fallback` when GitHub cannot say. */
  const headPushedAt = (entry, sha, fallback) => gh.commitDate(entry.repo, sha).then(d => d || fallback).catch(() => fallback);

  /**
   * Step 1: a run that ended since the last tick, or one that has run too long. Only the run this entry dispatched
   * (`last.run`) is settled; a leftover run from before a reset or a recovery is ignored. Returns true when the
   * entry should wait.
   */
  async function settleRun(id, entry) {
    const runner = runnerFor(id);
    const cur = runner.current();
    if (!cur) return false;
    if (cur.running) {
      if (clock.now() - cur.startedAt > minutes(config.run_timeout_minutes)) {
        runner.kill(cur.id);
        await needsHuman(id, "timeout", { last: { ...(entry.last || {}), run: cur.id, exit: 137, at: now() } });
      }
      return true;
    }
    if (entry.last?.run !== cur.id || entry.last?.exit != null) return false;

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
      if (!parseBlock(pr.body).block) await gh.setBody(entry.repo, pr.number, upsertBlock(pr.body, { prd: entry.prd, harness: entry.harness, session, branch: entry.branch })).catch(err => log.warn(`${id}: block write failed: ${err.message}`));
      // Events are new from the PR's creation, so a review that landed while the start run was still going is seen.
      save(id, {
        state: STATES.prOpen, session, pr: pr.number, url: pr.url, last,
        cursor: { since: pr.createdAt, fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
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
      // The settle time is only the fallback: reviews can land between the push and the end of the run.
      const since = pushed ? await headPushedAt(entry, pr.headRefOid, now()) : now();
      await commentOnce(entry, pushed ? roundComment(config) : receiptRoundComment(), ROUND_MARKER, entry.cursor.since);
      save(id, {
        session, last, iteration: entry.iteration + 1,
        cursor: { ...entry.cursor, since, fixed_sha: pr.headRefOid, receipt_hash: hash },
        ...(pushed ? { rereview: { at: since, nudged: false } } : {}),
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
   */
  async function dispatch(id, entry, pr, { name, events, denials = null, summary, since }) {
    const fix = { repo: entry.repo, pr: entry.pr, headSha: pr.headRefOid, events, receipt: receiptFor(id), denials };
    const prompt = entry.session
      ? fixPrompt({ ...fix, verify: verifyFor(id) })
      : `${registerPrompt({ repo: entry.repo, pr: entry.pr })}\n\n${fixPrompt({ ...fix, verify: [] })}`;
    await ensureWorktree(id, entry);
    const { job, session } = startRun(id, entry, { name, prompt });
    if (entry.state === STATES.ready) await gh.removeLabel(entry.repo, entry.pr, READY_LABEL);
    const dispatchedChecks = events.some(e => e.kind === "check");
    save(id, {
      state: STATES.prOpen, session,
      cursor: { ...entry.cursor, since, fixed_sha: pr.headRefOid, receipt_hash: receiptHash(pr.body), ...(dispatchedChecks ? { checks_sha: pr.headRefOid } : {}) },
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
    if (entry.state === STATES.needsHuman) return;
    if (pr.mergeable === "CONFLICTING") { await needsHuman(id, "conflict"); return; }

    // Inline comments are fetched from the earlier of the two windows: events use `since`, the reviewer's verdict
    // uses `rereview.at`, and a review that landed before `since` still counts for the verdict.
    const inlineSince = earlier(entry.cursor.since, entry.rereview.at);
    // Captured before the reads below, so a cursor set from it can never skip anything that arrived during them.
    const readAt = now();
    const [reviews, inline, comments] = await Promise.all([
      gh.reviews(entry.repo, entry.pr),
      gh.inlineComments(entry.repo, entry.pr, inlineSince),
      gh.issueComments(entry.repo, entry.pr, entry.cursor.since),
    ]);
    const { events, newest } = deriveEvents({ pr, reviews, inline, comments, entry, trust });

    if (events.length) {
      const summary = events.map(e => e.kind === "check" ? `check ${e.name}` : `${e.kind} ${e.id ?? ""} by ${e.author}`).join(", ");
      // The newest event dispatched is the boundary: everything up to it is handled, everything after it is still new.
      await fixOrStop(id, entry, pr, { name: "fix", events, summary, since: later(newest, entry.cursor.since) });
      return;
    }

    if (entry.state !== STATES.prOpen) return;
    const verdict = reviewerVerdict({ reviews, inline, config, trust, sinceIso: entry.rereview.at, headSha: pr.headRefOid });
    const green = await checksSettled(entry, pr);
    if (!pr.isDraft && green && (verdict.verdict === "clear" || verdict.verdict === "none")) {
      // The completion gate: the last step before a human is asked to look. Only for entries with a PRD.
      const prd = config.deliverable ? prdFor(id) : null;
      if (config.deliverable && !prd) log.warn(`${id}: no PRD snapshot, completion gate skipped`);
      if (prd) {
        const criteria = criteriaFromPrd(prd);
        const diff = config.deliverable.scan_output ? addedLines(await gh.prDiff(entry.repo, entry.pr)) : null;
        const g = await gate({ taskId: id, prBody: pr.body, criteria, checksGreen: true, diff, limits: config.deliverable, apiKey: aportApiKey, fetch, log });
        if (g.pending) { log.info(`${id}: completion gate has no decision yet (${g.source}); trying again next tick`); return; }
        if (!g.allow) {
          const codes = g.denials.map(d => d.code).join(", ");
          log.info(`${id}: completion gate (${g.source}) denied: ${codes}`);
          await fixOrStop(id, entry, pr, { name: "receipt", events: [], denials: `${denialsPrompt(g.denials)}\n\n${receiptInstructions(criteria, id)}`, summary: `receipt denied: ${codes}`, since: readAt });
          return;
        }
        log.info(`${id}: completion gate passed (${g.source})`);
      }
      const e = save(id, { state: STATES.ready });
      await gh.addLabel(entry.repo, entry.pr, READY_LABEL).catch(err => log.warn(`${id}: label failed: ${err.message}`));
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
