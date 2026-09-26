import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTick, roundComment } from "../lib/tick.mjs";
import { READY_LABEL, NEEDS_LABEL, ROUND_MARKER, NUDGE_MARKER, makeGh } from "../lib/gh.mjs";
import { RECEIPT_TAG } from "../lib/deliverable.mjs";
import { CONFIG, T0, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, prFixture, review, inline, comment, checkRun, claudeResultLines, codexLines, silentLog, STATES, GOOD_PRD, tempHome } from "./helpers.mjs";

const BOT = "chatgpt-codex-connector[bot]";
// The scan cap, spelled out rather than imported, so this file still loads against a `gh.mjs` that does not export it.
const MAX_DIFF_BYTES = 1_000_000;
const clearReviewer = () => [review({ id: 2, by: BOT, bot: true, state: "COMMENTED", at: at(3), body: "**Reviewed commit:** `a1b2c3d`" })];

/** A receipt the completion gate accepts for GOOD_PRD's two criteria, so a test can reach the output scan. */
const receiptBlock = () => "\n```" + RECEIPT_TAG + "\n" + JSON.stringify({
  task_id: "widget/widget-export", output_type: "code",
  summary: "Added a CSV export endpoint and button, with unit tests for three rows and the empty state, verified by npm test and npm run lint locally.",
  criteria_attestations: [
    { criterion_id: "ac-1", met: true, evidence: "src/export/csv.test.ts: exports three rows" },
    { criterion_id: "ac-2", met: true, evidence: "src/export/Button.tsx:41 disabled when empty" },
  ],
}, null, 2) + "\n```\n";

function world(stateOver = {}, ghOver = {}, { config = CONFIG, readPrd = () => null } = {}) {
  const clock = makeClock();
  const { state, id } = seededState(stateOver);
  const gh = fakeGh(ghOver);
  const runner = fakeRunner(clock);
  const notify = fakeNotify();
  // Every line the tick logged, so a test can assert that a decision it did not take was at least explained.
  const logged = [];
  const log = { info: m => logged.push(m), warn: m => logged.push(m), error: m => logged.push(m), latest: () => null };
  const tick = makeTick({ config, state, gh, git: fakeGit(), notify, log, clock, ownLogin: "me", runnerFor: () => runner, readPrd });
  return { clock, state, id, gh, runner, notify, tick, logged, entry: () => state.get(id) };
}

test("reviewer findings resume the original session and move the cursor", async () => {
  const w = world({}, { reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })], inline: [inline({ id: 1, reviewId: 2201, by: BOT, bot: true, at: at(5), body: "P1: nonce" })] });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1);
  const run = w.runner.started[0];
  assert.equal(run.cmd, "/bin/claude");
  assert.ok(run.args.includes("--resume") && run.args.includes("6f1c2d3e-1111-4111-8111-111111111111"));
  assert.match(run.args.at(-1), /P1: nonce/);
  assert.equal(run.opts.cwd, "/tmp/wt");
  assert.equal(w.entry().cursor.since, at(5), "the cursor moves to the newest event read, not to dispatch time");
  assert.equal(w.entry().last.event, "review 2201 by chatgpt-codex-connector, inline 1 by chatgpt-codex-connector");
});

test("the same review on the next tick does not start a second run", async () => {
  const w = world({}, { reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  await w.tick.tick(); // settles the run, posts the round comment
  await w.tick.tick(); // nothing new
  assert.equal(w.runner.started.length, 1);
});

test("a fix run that pushed posts the round comment, bumps iteration, resets the reviewer wait", async () => {
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  w.clock.advance(10);
  w.runner.finish(claudeResultLines({ cost: 1.25 }));
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.iteration, 1);
  assert.equal(e.cursor.fixed_sha, "d4e5f6a");
  assert.equal(e.rereview.at, at(16));
  assert.equal(e.last.cost, 1.25);
  assert.deepEqual(w.gh.calls.find(c => c[0] === "comment"), ["comment", 142, roundComment(CONFIG)]);
  assert.ok(roundComment(CONFIG).startsWith("@codex review"));
  assert.ok(roundComment(CONFIG).includes(ROUND_MARKER));
});

test("a fix run that did not push stops with no-push; a failed run stops with harness-error", async () => {
  for (const [lines, reason] of [[claudeResultLines({ ok: true }), "no-push"], [claudeResultLines({ ok: false }), "harness-error"]]) {
    const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
    w.clock.advance(6);
    await w.tick.tick();
    w.runner.finish(lines);
    await w.tick.tick();
    assert.equal(w.entry().state, STATES.needsHuman);
    assert.equal(w.entry().reason, reason);
    assert.deepEqual(w.notify.sent, [["needs", 142, reason]]);
    assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === NEEDS_LABEL));
  }
});

test("the iteration cap stops the loop before a run starts", async () => {
  const w = world({ iteration: 3 }, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 0);
  assert.equal(w.entry().reason, "iterations");
  assert.equal(w.notify.sent.length, 1);
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === NEEDS_LABEL), "the PR itself says a person is needed, not only the phone");
});

test("conflict, merged and closed are terminal", async () => {
  const c = world({}, { pr: prFixture({ mergeable: "CONFLICTING" }) });
  await c.tick.tick();
  assert.equal(c.entry().reason, "conflict");
  assert.equal(c.notify.sent.length, 1);
  await c.tick.tick();
  assert.equal(c.notify.sent.length, 1, "needs-human is notified once");
  for (const s of ["MERGED", "CLOSED"]) {
    const w = world({}, { pr: prFixture({ state: s }) });
    await w.tick.tick();
    assert.equal(w.entry().state, STATES.done);
    assert.equal(w.notify.sent.length, 0, "no notification on done");
  }
});

test("a run past the timeout is killed and the entry stops", async () => {
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  w.clock.advance(31);
  await w.tick.tick();
  assert.equal(w.runner.current().killed, true);
  assert.equal(w.entry().reason, "timeout");
});

test("green checks and a clear reviewer make it ready, once, with a label", async () => {
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    // The newest review names the head it looked at, which is what a real reviewer bot does and what the verdict
    // needs: a review that names no commit at all cannot say anything about this head, and answers `waiting`.
    reviews: [review({ id: 1, by: BOT, bot: true, state: "COMMENTED", at: at(-1) }), review({ id: 2, by: BOT, bot: true, state: "APPROVED", at: at(3), body: "**Reviewed commit:** `a1b2c3d`" })],
  });
  w.clock.set(at(-2)); // reviews are behind the cursor as events; the verdict still reads them
  w.clock.set(at(4));
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.ready);
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === READY_LABEL));
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1);
});

test("no checks at all is green only after the grace window; a reviewer set to null needs no review", async () => {
  const cfg = { ...CONFIG, reviewer: null };
  const clock = makeClock();
  const { state, id } = seededState();
  const gh = fakeGh({ commitDates: { a1b2c3d: T0 } });
  const notify = fakeNotify();
  const tick = makeTick({ config: cfg, state, gh, git: fakeGit(), notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => fakeRunner(clock), readPrd: () => null });
  clock.advance(1);
  await tick.tick();
  assert.equal(state.get(id).state, STATES.prOpen, "a head pushed a minute ago has not had time to report checks");
  clock.advance(5);
  await tick.tick();
  assert.equal(state.get(id).state, STATES.ready);
});

test("when GitHub cannot date the head, the grace window counts from the recorded push time, so a PR without CI still becomes ready", async () => {
  const cfg = { ...CONFIG, reviewer: null };
  const clock = makeClock();
  const { state, id } = seededState();
  const tick = makeTick({ config: cfg, state, gh: fakeGh(), git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => fakeRunner(clock), readPrd: () => null });
  clock.advance(6);
  await tick.tick();
  assert.equal(state.get(id).state, STATES.ready);
});

test("after a push the cursor is the push time from GitHub, so a review between the push and the end of the run is seen", async () => {
  const w = world({ iteration: 0, last: { at: T0, run: "1-fix", exit: null, event: "review" } }, { commitDates: { d4e5f6a: at(2) } });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  w.gh.data.reviews = [review({ id: 7, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3), body: "**Reviewed commit:** `d4e5f6a`" })];
  w.clock.advance(5);
  await w.tick.tick(); // settles the push at +2; the review at +3 is after it, so the same tick dispatches it
  assert.equal(w.runner.started.length, 2, "the review that landed while the run was finishing is dispatched");
  assert.match(w.runner.started[1].args.at(-1), /review 7/);
  assert.equal(w.entry().iteration, 1);
});

test("a run the entry did not dispatch is never settled: a reset or a recovery ignores leftovers", async () => {
  const w = world({ last: { at: T0, event: "reset by register", run: "1-fix", exit: 0 } });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines());
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.prOpen);
  assert.equal(w.entry().reason, null, "a finished run recorded with its exit is not re-settled as no-push");
  const stale = world({ last: { at: T0, event: "recovered from GitHub" } });
  stale.runner.start("fix", "/bin/claude", [], {});
  stale.runner.finish(claudeResultLines());
  await stale.tick.tick();
  assert.equal(stale.entry().reason, null, "a run from before the recovery is not this entry's run");
});

test("a reviewer that blocked the head before the cursor stops the entry once, instead of waiting forever", async () => {
  const w = world({ cursor: { since: at(5), fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null }, rereview: { at: at(0), nudged: false } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 3, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3), body: "**Reviewed commit:** `a1b2c3d`" })] });
  w.clock.advance(6);
  await w.tick.tick();
  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "reviewer-blocking"]);
  assert.equal(w.notify.sent.length, 1);
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1);
});

test("a round comment already on the PR is not posted twice when a tick is interrupted after posting", async () => {
  const w = world({ iteration: 0, last: { at: T0, run: "1-fix", exit: null, event: "review" } });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  w.gh.data.comments.push({ id: 1, user: { login: "me", type: "User" }, body: roundComment(CONFIG), created_at: at(1) });
  w.clock.advance(2);
  await w.tick.tick();
  assert.equal(w.gh.calls.filter(c => c[0] === "comment").length, 0);
  assert.equal(w.entry().iteration, 1);
});


test("a silent reviewer is nudged once after rereview_minutes and stops after stall_hours", async () => {
  const w = world();
  w.clock.advance(7);
  await w.tick.tick();
  const nudges = () => w.gh.calls.filter(c => c[0] === "comment" && c[2].includes(NUDGE_MARKER));
  assert.equal(nudges().length, 1);
  assert.ok(nudges()[0][2].startsWith("@codex review"));
  w.clock.advance(7);
  await w.tick.tick();
  assert.equal(nudges().length, 1, "never a third request");
  w.clock.advance(6 * 60);
  await w.tick.tick();
  assert.equal(w.entry().reason, "reviewer-silent");
});

test("a ready PR reopens on a trusted inline comment and drops the label", async () => {
  const w = world({ state: STATES.ready }, { inline: [inline({ id: 9, by: "me", at: at(5), body: "rename this" })] });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.prOpen);
  assert.equal(w.runner.started.length, 1);
  assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === READY_LABEL));
});

test("a start run that opened a PR enters pr-open with the block written and the PR's creation time as the reviewer clock", async () => {
  const w = world({ state: STATES.running, pr: null, url: undefined, cursor: { since: T0, fixed_sha: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { prsByHead: [{ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa111", isCrossRepository: false, createdAt: at(20) }] });
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(25);
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.state, STATES.prOpen);
  assert.equal(e.pr, 143);
  assert.equal(e.cursor.fixed_sha, "aaaa111");
  assert.equal(e.rereview.at, at(20));
  const body = w.gh.calls.find(c => c[0] === "setBody")[2];
  assert.match(body, /<!-- gallivant\nprd: docs\/prds\/widget-export.md\nharness: claude\nsession: 6f1c2d3e-1111-4111-8111-111111111111\nbranch: gallivant\/widget-export\n-->/);
});

test("a start run with no PR stops with no-pr; a codex start records the thread id", async () => {
  const w = world({ state: STATES.running, pr: null, harness: "codex", session: null, last: { at: T0, run: "1-start", exit: null, event: "start" } }, { prsByHead: [] });
  w.runner.start("start", "/bin/codex", [], { cwd: "/tmp/wt" });
  w.runner.finish(codexLines());
  await w.tick.tick();
  assert.equal(w.entry().reason, "no-pr");
  assert.equal(w.entry().session, "22222222-2222-4222-8222-222222222222");
  assert.deepEqual(w.notify.sent, [["needs", null, "no-pr"]], "exactly one message, and it carries no PR number because there is none");
});

test("a needs-human entry without a PR is left alone: no PR lookup, no error", async () => {
  const w = world({ state: STATES.needsHuman, reason: "not-signed-in", pr: null, url: null });
  let looked = false;
  w.gh.prView = async () => { looked = true; return prFixture(); };
  const results = await w.tick.tick();
  assert.deepEqual(results.map(r => r.ok), [true]);
  assert.equal(looked, false);
});

test("a review that landed while the start run was still going is seen once the PR opens", async () => {
  const w = world({ state: STATES.running, pr: null, url: null, cursor: { since: T0, fixed_sha: null, checks_sha: null, receipt_hash: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { prsByHead: [{ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa111", isCrossRepository: false, createdAt: at(2) }],
      reviews: [review({ id: 7, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })] });
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(6);
  w.gh.data.pr = prFixture({ number: 143, headRefOid: "aaaa111" });
  await w.tick.tick(); // settles: PR open with the cursor at the PR's creation, so the review is new and dispatched at once
  assert.equal(w.runner.started.length, 2);
  assert.match(w.runner.started[1].args.at(-1), /review 7/);
  assert.equal(w.entry().cursor.since, at(3), "the cursor then moves to the review that was dispatched");
});

test("a failing check on a head the loop itself pushed is dispatched once, then stops with checks-red", async () => {
  const w = world({ iteration: 1, cursor: { since: T0, fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(1) })] }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1, "red CI on the current head dispatches a fix");
  assert.equal(w.entry().cursor.checks_sha, "a1b2c3d");
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(9) })] });
  w.clock.advance(4);
  await w.tick.tick(); // settles the push (round 2)
  w.clock.advance(1);
  await w.tick.tick(); // new head, red again: dispatched again
  assert.equal(w.runner.started.length, 2);
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(9) })] });
  await w.tick.tick(); // no push this time
  assert.equal(w.entry().reason, "no-push");
});

test("a codex fix resumes with exec resume and the config overrides", async () => {
  const w = world({ harness: "codex", session: "22222222-2222-4222-8222-222222222222" }, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  const args = w.runner.started[0].args;
  assert.deepEqual(args.slice(0, 3), ["exec", "resume", "22222222-2222-4222-8222-222222222222"]);
  assert.ok(args.includes('approval_policy="never"'));
  assert.ok(!args.some(a => a.startsWith("--dangerously")));
});

test("a registered PR without a session starts a fresh session that reads the PR first", async () => {
  const w = world({ session: null }, { inline: [inline({ id: 9, by: "me", at: at(5), body: "typo" })] });
  w.clock.advance(6);
  await w.tick.tick();
  const args = w.runner.started[0].args;
  assert.ok(args.includes("--session-id"));
  assert.match(args.at(-1), /taking over pull request #142/);
});

test("one failing entry does not stop the others", async () => {
  const w = world();
  w.state.put("widget/other", { ...w.entry(), pr: 999 });
  let n = 0;
  w.gh.prView = async () => { if (n++ === 0) throw new Error("boom"); return prFixture({ state: "MERGED" }); };
  const results = await w.tick.tick();
  assert.deepEqual(results.map(r => r.ok), [false, true]);
});

test("an event that lands while a run is being dispatched is not skipped: the cursor is the boundary that was read", async () => {
  // The window is real: `ensureWorktree` clones when the checkout is gone, which takes minutes on a large repo.
  const clock = makeClock();
  const { state, id } = seededState();
  const gh = fakeGh({ reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  const runner = fakeRunner(clock);
  // A checkout that has to be cloned, and the clone takes ten minutes. A trusted comment arrives in the middle.
  const git = {
    ...fakeGit(),
    exists: () => false,
    fromBranch: async ({ path }) => {
      clock.advance(10);
      gh.data.comments.push({ id: 77, user: { login: "me", type: "User" }, body: "@gallivant fix the typo too", created_at: at(9) });
      return path;
    },
  };
  const tick = makeTick({ config: CONFIG, state, gh, git, notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });

  clock.advance(6);
  await tick.tick();
  assert.equal(runner.started.length, 1, "the review is dispatched");
  assert.equal(state.get(id).cursor.since, at(5), "the cursor is the newest event read, not the +16 wall clock after the clone");

  // The run ends having pushed, so the entry is free to dispatch again.
  runner.finish(claudeResultLines());
  gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  gh.data.commitDates = { d4e5f6a: at(8) };
  await tick.tick(); // settles the push; the cursor moves to the push at +8, which is still before the comment at +9
  assert.equal(state.get(id).iteration, 1);

  await tick.tick();
  assert.equal(runner.started.length, 2, "the comment that arrived during the clone is dispatched on a later tick");
  assert.match(runner.started[1].args.at(-1), /the typo too/, "the command body, with the @gallivant fix prefix stripped");
});

test("with no events to bound it, the cursor moves to the time captured before the reads, not after the spawn", async () => {
  const clock = makeClock();
  const { state, id } = seededState({ cursor: { since: T0, fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } });
  const gh = fakeGh({ pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: clearReviewer() });
  const runner = fakeRunner(clock);
  const git = { ...fakeGit(), exists: () => false, fromBranch: async ({ path }) => { clock.advance(10); return path; } };
  // A PRD whose receipt is missing, so the completion gate denies and dispatches a receipt round with no events.
  const tick = makeTick({ config: CONFIG, state, gh, git, notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD });

  clock.advance(4);
  await tick.tick();
  assert.equal(runner.started.length, 1, "the gate denied and dispatched a receipt round");
  assert.equal(state.get(id).cursor.since, at(4), "the pre-read instant, so the ten minutes of cloning are not skipped over");
});

test("a second event stamped the same second as the one that moved the cursor is still dispatched, once", async () => {
  // GitHub stamps to the second. The first fix dispatches a review at +5; while the clone runs, a trusted comment
  // is written in that same second. A cursor compared strictly against +5 would bury it for good.
  const clock = makeClock();
  const { state, id } = seededState();
  const gh = fakeGh({ reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  const runner = fakeRunner(clock);
  const git = {
    ...fakeGit(),
    exists: () => false,
    fromBranch: async ({ path }) => {
      clock.advance(10);
      gh.data.comments.push({ id: 77, user: { login: "me", type: "User" }, body: "@gallivant fix the typo too", created_at: at(5) });
      return path;
    },
  };
  const tick = makeTick({ config: CONFIG, state, gh, git, notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });

  clock.advance(6);
  await tick.tick();
  assert.equal(runner.started.length, 1, "the review is dispatched");
  const cursor = state.get(id).cursor;
  assert.equal(cursor.since, at(5));
  assert.deepEqual(cursor.dispatched, ["review:2201"], "the cursor remembers what it handled at its own second");

  runner.finish(claudeResultLines());
  gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  gh.data.commitDates = { d4e5f6a: at(5) }; // the push lands in that second too, so the cursor does not move past it
  await tick.tick();
  assert.equal(state.get(id).iteration, 1);

  await tick.tick();
  assert.equal(runner.started.length, 2, "the comment sharing the review's second is dispatched on a later tick");
  assert.match(runner.started[1].args.at(-1), /the typo too/);

  // And it is not dispatched a second time: the run ends having pushed, and the next tick has nothing new.
  runner.finish(claudeResultLines());
  gh.data.pr = prFixture({ headRefOid: "7788990" });
  gh.data.commitDates = { "7788990": at(5) };
  await tick.tick();
  await tick.tick();
  assert.equal(runner.started.length, 2, "the command it already handled is not sent again");
});

test("an event already dispatched at the cursor's own second is never dispatched twice", async () => {
  // The inclusive comparison is what makes the case above work; `cursor.dispatched` is what keeps it from replaying.
  const w = world(
    { cursor: { since: at(5), dispatched: ["command:77"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null }, rereview: { at: at(5), nudged: false } },
    { reviews: clearReviewer(), comments: [comment({ id: 77, by: "me", at: at(5), body: "@gallivant fix the typo" })] },
  );
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 0, "the command at exactly the cursor was already handled");

  // A second command in the very same second is not on the list, so it is new.
  w.gh.data.comments.push(comment({ id: 78, by: "me", at: at(5), body: "@gallivant fix the other typo" }));
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1);
  assert.match(w.runner.started[0].args.at(-1), /the other typo/);
  assert.equal(w.entry().last.event, "command 78 by me", "only the new one is in the round, not the one already handled");
  assert.deepEqual(w.entry().cursor.dispatched.sort(), ["command:77", "command:78"], "both are remembered while the cursor sits on their second");
});

test("the dispatched list is dropped as soon as the cursor moves to another second", async () => {
  const w = world(
    { cursor: { since: at(5), dispatched: ["review:2201"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } },
    { reviews: [review({ id: 2202, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(9) })] },
  );
  w.clock.advance(10);
  await w.tick.tick();
  assert.equal(w.entry().cursor.since, at(9));
  assert.deepEqual(w.entry().cursor.dispatched, ["review:2202"], "only the new second's keys, so the list cannot grow without bound");
});

test("the server-side since filter is asked for an overlap, so the boundary second comes back even from an exclusive filter", async () => {
  // GitHub filters on `updated_at` and the stamps are per second. Whether its filter is `>` or `>=` is not
  // something the daemon gets to know, so it asks from a second earlier and deduplicates what comes back.
  const clock = makeClock();
  const { state, id } = seededState({ cursor: { since: at(5), dispatched: ["command:77"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null }, rereview: { at: at(5), nudged: false } });
  const asked = [];
  const gh = fakeGh({ reviews: clearReviewer(), comments: [comment({ id: 77, by: "me", at: at(5), body: "@gallivant fix the typo" }), comment({ id: 78, by: "me", at: at(5), body: "@gallivant fix the other typo" })] });
  // A pessimistic server: strictly after, the way the old client-side filter behaved.
  gh.issueComments = async (_r, _n, s) => { asked.push(s); return gh.data.comments.filter(c => !s || Date.parse(c.created_at) > Date.parse(s)); };
  const runner = fakeRunner(clock);
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });

  clock.advance(6);
  await tick.tick();
  assert.ok(asked.every(s => Date.parse(s) < Date.parse(at(5))), `the fetch starts before the cursor, not at it (asked ${asked})`);
  assert.equal(runner.started.length, 1, "the comment sharing the cursor's second still reaches the daemon");
  assert.equal(state.get(id).last.event, "command 78 by me", "and the one already dispatched is dropped by id, not by the fetch");
});

test("a fix round carries the configured read-only directories, from the snapshot and not from the checkout", async () => {
  const fromConfig = tempHome();
  const fromSnapshot = tempHome();
  // The daemon's snapshot names one extra directory; the copy in the checkout is not consulted at all.
  const snapshot = GOOD_PRD.replace("harness: codex", `harness: claude\ncontext_paths: ${fromSnapshot}`);
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] },
    { config: { ...CONFIG, context_paths: [fromConfig] }, readPrd: () => snapshot });
  w.clock.advance(6);
  await w.tick.tick();
  const args = w.runner.started[0].args;
  assert.deepEqual(args.filter((a, i) => args[i - 1] === "--add-dir"), [fromConfig, fromSnapshot]);
});

test("a harness that refuses context_paths stops the entry instead of retrying the same refusal every tick", async () => {
  // codex cannot grant read on one directory, so the refusal is the same on every poll. Retrying is a loop.
  const w = world({ harness: "codex", session: "thread_1" },
    { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] },
    { config: { ...CONFIG, context_paths: [tempHome()] } });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 0, "no run is spawned with an argv the adapter refused");
  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "context-paths"]);
  assert.match(w.entry().last.event, /refusing to run codex with context_paths/);
  assert.equal(w.notify.sent.length, 1, "the operator is told once, not on every tick");
  // And the next tick leaves it alone rather than refusing again.
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1);
});

test("a diff the gate cannot read is no decision, not a clean scan: the PR stays in pr-open and nothing is dispatched", async () => {
  // `gh pr diff` fails transiently. The old code turned that into null, `addedLines(null)` into "", and an empty
  // string passes the blocked-pattern scan trivially, so a PR carrying a blocked pattern could be marked ready.
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  }, { readPrd: () => GOOD_PRD });
  w.gh.prDiff = async () => { throw new Error("HTTP 502: Bad gateway"); };
  w.clock.advance(4);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.prOpen, "the entry is left where it was, to be asked again next tick");
  assert.equal(w.runner.started.length, 0, "no receipt round, so the round budget is untouched");
  assert.equal(w.entry().iteration, 0);
  assert.deepEqual(w.gh.calls.filter(c => c[0] === "addLabel"), []);
  assert.deepEqual(w.notify.sent, []);
  assert.ok(w.logged.some(l => /no decision yet \(diff unreadable: .*Bad gateway/.test(l)), `the reason is logged (got ${w.logged})`);
});

test("with the output scan off, a failing prDiff cannot affect the gate, because no diff is fetched at all", async () => {
  const config = { ...CONFIG, deliverable: { ...CONFIG.deliverable, evaluator: "local", scan_output: false } };
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  }, { config, readPrd: () => GOOD_PRD });
  let asked = 0;
  w.gh.prDiff = async () => { asked += 1; throw new Error("HTTP 502: Bad gateway"); };
  w.clock.advance(4);
  await w.tick.tick();

  assert.equal(asked, 0, "scan_output off means the diff is never requested");
  assert.equal(w.runner.started.length, 1, "the gate ran and denied the missing receipt, as it would with any diff");
  assert.match(w.runner.started[0].args.at(-1), /oap\.receipt_missing/);
});

test("a PR that was ready and then stops loses the ready label as it gains needs-human", async () => {
  // Both labels at once is a contradiction for a person reading the PR and for anything automating on labels.
  const w = world({ state: STATES.ready }, { pr: prFixture({ mergeable: "CONFLICTING" }) });
  await w.tick.tick();
  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "conflict"]);
  const labels = w.gh.calls.filter(c => c[0] === "addLabel" || c[0] === "removeLabel");
  assert.deepEqual(labels, [["removeLabel", 142, READY_LABEL], ["addLabel", 142, NEEDS_LABEL]]);
});

test("every path into needs-human clears the ready label, not only the conflict one", async () => {
  // Three more stops a ready entry can reach: a run of its own that hangs, one that ends without pushing, and a new
  // review with the round budget already spent. The label pair has to come out the same way from all of them.
  const cases = [
    ["timeout", {}, async w => { w.runner.start("fix", "/bin/claude", [], {}); w.clock.advance(31); }],
    ["no-push", {}, async w => { w.runner.start("fix", "/bin/claude", [], {}); w.runner.finish(claudeResultLines()); }],
    ["iterations", { iteration: CONFIG.max_iterations }, async w => { w.clock.advance(6); }],
  ];
  for (const [reason, over, arrange] of cases) {
    const w = world({ state: STATES.ready, last: { at: T0, run: "1-fix", exit: null, event: "review" }, ...over },
      { reviews: [review({ id: 2301, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
    await arrange(w);
    await w.tick.tick();
    assert.equal(w.entry().reason, reason);
    assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === READY_LABEL), `${reason} drops the ready label`);
    assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === NEEDS_LABEL), `${reason} adds the needs-human label`);
  }
});

test("the cursor a settled round writes is floored too, so GitHub cannot date it out of reach", async () => {
  // The receipt-rewrite branch, and the fallback when GitHub cannot date the head, both used `nowIso()`, which
  // carries milliseconds. A cursor of 02:05:00.400Z sits after every comment stamped 02:05:00Z.
  const clock = makeClock();
  clock.set(new Date(Date.parse(at(5)) + 400).toISOString());
  const { state, id } = seededState({ last: { at: T0, run: "1-fix", exit: null, event: "review" } });
  const gh = fakeGh({ pr: prFixture({ headRefOid: "d4e5f6a" }) }); // pushed, and commitDate answers null
  const runner = fakeRunner(clock);
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });
  runner.start("fix", "/bin/claude", [], {});
  runner.finish(claudeResultLines());
  await tick.tick();

  const e = state.get(id);
  assert.equal(e.iteration, 1);
  assert.equal(e.cursor.since, at(5), "the fallback push time drops its milliseconds");
  assert.equal(e.rereview.at, at(5));
});

test("a ready entry whose head moved is no longer ready: back to pr-open, label off, judged again", async () => {
  // A push after the entry became ready, with no failing check and no qualifying feedback. The verdict, the green
  // checks and the accepted receipt all describe the commit that was judged, so a commit nobody reviewed and nothing
  // scanned would otherwise read as ready for a human to merge.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } }, {
    pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(8) })] }),
    reviews: clearReviewer(), // the reviewer cleared a1b2c3d, which is not the head any more
    commitDates: { d4e5f6a: at(8) },
  });
  w.clock.advance(9);
  await w.tick.tick();

  const e = w.entry();
  assert.equal(e.state, STATES.prOpen, "the entry is watched again");
  assert.equal(e.cursor.fixed_sha, "d4e5f6a", "and the head it will judge is the new one");
  assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === READY_LABEL), "the label a person merges on is gone");
  assert.deepEqual(w.gh.calls.filter(c => c[0] === "addLabel"), [], "and it is not put straight back on");
  assert.equal(w.runner.started.length, 0, "no fix round: nothing asked for one");
  assert.equal(e.rereview.at, at(8), "the wait for a review of this commit starts at the push, not at the old round");
  assert.ok(w.logged.some(l => /head moved to d4e5f6a after ready/.test(l)), `the reopen is explained (got ${w.logged})`);

  // The next tick judges the new head. The reviewer has not looked at it, so the entry waits rather than going ready.
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.prOpen, "a commit the reviewer has not seen does not go ready again on its own");
  assert.deepEqual(w.notify.sent, [], "and nobody was told this PR was ready");

  // Once the reviewer clears the new head, ready comes back through the ordinary path.
  w.gh.data.reviews = [review({ id: 3, by: BOT, bot: true, state: "COMMENTED", at: at(10), body: "**Reviewed commit:** `d4e5f6a`" })];
  w.clock.advance(2);
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.ready);
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
});

test("a ready entry whose head has not moved stays ready and is not re-judged", async () => {
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: clearReviewer() });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.ready);
  assert.deepEqual(w.gh.calls.filter(c => c[0] === "removeLabel"), [], "the label stays on a PR that is still the one that was judged");
  assert.deepEqual(w.notify.sent, [], "and nobody is told a second time");
});

test("a diff at the scan cap leaves the entry pending with truncation named, and one under the cap is scanned", async () => {
  // `MAX_DIFF_BYTES` used to slice and hand the prefix to the blocked-pattern scan as though it were the whole diff,
  // so a blocked pattern after the cutoff was never looked at and the gate could allow.
  const big = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "Adds export." + receiptBlock() }),
    reviews: clearReviewer(),
  }, { readPrd: () => GOOD_PRD });
  // What `gh pr diff` really returns for an oversized diff, through the real `prDiff`, with only `exec` faked.
  const stdout = "+" + "a".repeat(MAX_DIFF_BYTES) + "\n+TODO after the cutoff\n";
  big.gh.prDiff = makeGh({ exec: async () => ({ stdout, stderr: "" }) }).prDiff;
  big.clock.advance(4);
  await big.tick.tick();

  assert.equal(big.entry().state, STATES.prOpen, "no decision, so the entry is asked again next tick");
  assert.deepEqual(big.gh.calls.filter(c => c[0] === "addLabel"), [], "a partial scan never becomes an allow");
  assert.deepEqual(big.notify.sent, []);
  assert.equal(big.runner.started.length, 0, "and no receipt round, so the round budget is untouched");
  assert.ok(big.logged.some(l => /no decision yet \(diff unreadable: .*truncated/.test(l)), `truncation is named (got ${big.logged})`);

  // The same diff a byte under the cap is read whole, and the pattern in it is found rather than missed.
  const small = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "Adds export." + receiptBlock() }),
    reviews: clearReviewer(),
  }, { readPrd: () => GOOD_PRD });
  const under = "+" + "a".repeat(MAX_DIFF_BYTES - 30) + "\n+TODO under the cutoff\n";
  small.gh.prDiff = makeGh({ exec: async () => ({ stdout: under, stderr: "" }) }).prDiff;
  small.clock.advance(4);
  await small.tick.tick();

  assert.equal(small.runner.started.length, 1, "a diff that fits is scanned, and this one denies");
  assert.match(small.runner.started[0].args.at(-1), /oap\.blocked_pattern_detected/);
});

test("a ready label that will not write keeps the entry in pr-open and is retried, rather than a ready PR with no label", async () => {
  // The registry moving to ready is what makes the ready branch stop running: a later tick returns early on the
  // state. A label write swallowed after that move leaves the PR with no label and nobody left to add one, while the
  // operator has already been told to go and merge it.
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  });
  let attempts = 0;
  w.gh.addLabel = async (repo, n, label) => { w.gh.calls.push(["addLabel", n, label]); if (++attempts === 1) throw new Error("HTTP 502: Bad gateway"); };
  w.clock.advance(4);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.prOpen, "pr-open is the retryable state");
  assert.deepEqual(w.notify.sent, [], "and nobody is told a PR is ready while the PR itself says nothing");
  assert.ok(w.logged.some(l => /ready label failed \(HTTP 502.*trying again next tick/.test(l)), `the failure is explained (got ${w.logged})`);

  // The next tick judges the same head again and the label takes. One notification, not one per attempt.
  await w.tick.tick();
  assert.equal(attempts, 2, "the same work is retried, not a second round of anything");
  assert.equal(w.entry().state, STATES.ready);
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
  assert.equal(w.entry().iteration, 0, "a label retry is not a fix round");
});

test("a clear review in the very second the re-review was asked for clears the entry, rather than waiting until reviewer-silent", async () => {
  // The boundary is `rereview.at`. A blocking review is dispatched as an event and comes back either way, but a clear
  // one is only ever read by the verdict, so a strict comparison lost it for good: the entry waited out `stall_hours`
  // and stopped as `reviewer-silent` with the reviewer's approval sitting on the PR the whole time.
  const w = world({ rereview: { at: at(5), nudged: false }, cursor: { since: at(5), dispatched: [], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: [review({ id: 12, by: BOT, bot: true, state: "APPROVED", at: at(5), body: "**Reviewed commit:** `a1b2c3d`" })],
  });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.ready);
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === READY_LABEL));
});

test("a review the daemon already dispatched at the cursor's second does not also read as the reviewer clearing that head", async () => {
  // Inclusivity and deduplication travel together, as they do for events: the entry is mid-fix on review 13, so the
  // same review must not be read as the reviewer having cleared the commit it asked for changes on.
  const w = world({ rereview: { at: at(5), nudged: false }, cursor: { since: at(5), dispatched: ["review:13"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: [review({ id: 13, by: BOT, bot: true, state: "APPROVED", at: at(5), body: "**Reviewed commit:** `a1b2c3d`" })],
  });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.prOpen, "still waiting on a review of this head");
  assert.deepEqual(w.notify.sent, []);
  assert.deepEqual(w.gh.calls.filter(c => c[0] === "addLabel"), []);
});

test("a stop on an entry whose repo is not owner/name still notifies, with a handle a person can type", async () => {
  // `shortRepo` was `repo.split("/")[1]`, so a repo with no owner produced the title `undefined#142` and a body
  // telling the operator to run `gallivant why undefined#142`. With no repo at all it threw, inside `needsHuman`,
  // after the state and labels were written and before `notify.needs`, where the tick's per-entry catch buried it and
  // the stopped PR notified nobody.
  for (const repo of ["widget", ""]) {
    const w = world({ repo }, { pr: prFixture({ mergeable: "CONFLICTING" }) });
    const results = await w.tick.tick();
    assert.deepEqual(results.map(r => r.ok), [true], `repo ${JSON.stringify(repo)}: the tick did not throw`);
    assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "conflict"]);
    assert.deepEqual(w.notify.sent, [["needs", 142, "conflict"]], `repo ${JSON.stringify(repo)}: the operator is told`);
  }
});


test("a round whose new head is an older commit does not drag the cursor back, dispatch twice or reset the reviewer clock", async () => {
  // A force-push to an earlier commit. `gh.commitDate` reports that commit's committer date, which is what it is for,
  // and the push branch wrote it as the cursor with no guard, so `advanceCursor` saw a different instant, cleared
  // `dispatched`, and the review that started the round became new again and was dispatched a second time in the same
  // pass, with a round burned for it and the reviewer clock left eighteen minutes in the past.
  const w = world({
    iteration: 1,
    cursor: { since: at(20), dispatched: ["review:2201"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null },
    rereview: { at: at(20), nudged: false },
    last: { at: T0, run: "1-fix", exit: null, event: "review 2201 by chatgpt-codex-connector" },
  }, {
    pr: prFixture({ headRefOid: "0ldhead" }),
    reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(20) })],
    commitDates: { "0ldhead": at(2) },
  });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines());
  w.clock.set(at(25));
  await w.tick.tick();

  const e = w.entry();
  assert.equal(w.runner.started.length, 1, "the review the finished run just handled is not dispatched again");
  assert.equal(e.cursor.since, at(20), "the cursor holds where it was; a candidate before it is not a boundary");
  assert.deepEqual(e.cursor.dispatched, ["review:2201"], "so the keys handled at that second survive");
  assert.ok(Date.parse(e.rereview.at) >= Date.parse(at(19)), `the reviewer clock is not dragged into the past (got ${e.rereview.at})`);
  assert.equal(e.iteration, 2, "the round itself still counts: a push happened");
});

test("a clock a second behind GitHub cannot move the cursor back on a receipt round either", async () => {
  // The receipt path passes `readAt`, a local clock reading, as its boundary. Any skew behind GitHub regressed the
  // cursor and cleared `dispatched` the same way the push path did.
  const w = world({
    cursor: { since: at(10), dispatched: ["command:77"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null },
    rereview: { at: at(1), nudged: false },
  }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(), // cleared at +3, after the re-review was asked for at +1
  }, { readPrd: () => GOOD_PRD });
  // The clock reads +5 while the cursor is already at +10: five minutes of skew behind GitHub, which is the same
  // shape as one second of it. The gate denies the missing receipt and dispatches a round bounded by `readAt`.
  w.clock.set(at(5));
  await w.tick.tick();

  assert.equal(w.runner.started.length, 1, "the gate denied and dispatched a receipt round");
  const e = w.entry();
  assert.equal(e.cursor.since, at(10), "the cursor stays where it was rather than following the slow clock back");
  assert.deepEqual(e.cursor.dispatched, ["command:77"], "and the command already handled is still remembered");
});

test("a head whose commit is days old does not stop the entry as reviewer-silent on the tick that reopened it", async () => {
  // `git commit` on Monday and `git push` on Thursday. The committer date is the commit's, not the push's, and GitHub
  // does not report the second. A clock older than `stall_hours` stopped the PR for a silence that never happened,
  // with the reviewer never asked once; one older than `rereview_minutes` posted the nudge before the first ask.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d", receipt_hash: null }, rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ headRefOid: "newsha0", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(1) })] }),
    commitDates: { newsha0: at(-10 * 60) }, // committed ten hours ago; stall_hours is 6
  });
  w.clock.advance(1);
  await w.tick.tick();

  const e = w.entry();
  assert.equal(e.state, STATES.prOpen, "reopened and watching, not stopped");
  assert.equal(e.reason, null);
  assert.deepEqual(w.notify.sent, [], "no phone call about a silence the reviewer was never given a chance to break");
  assert.equal(e.rereview.nudged, false, "and no nudge before the reviewer has been asked once");
  assert.ok(Date.parse(e.rereview.at) >= w.clock.now() - 6 * 60_000, `the clock starts at the ask, not at the commit (got ${e.rereview.at})`);
});

test("a live run this entry did not dispatch is ignored, not waited on for thirty minutes and then blamed", async () => {
  // What `register`'s reset leaves behind: `last.run` is the old run with its exit recorded, on purpose, while the
  // session that was going when the operator reset is still alive in the runner. The ownership test sat after the
  // liveness branch, so the entry froze for the full timeout with its feedback never read and nothing logged, and then
  // the leftover was killed and the entry stopped with `reason: "timeout"` and `last.run` rewritten to it.
  const w = world({ last: { at: T0, run: "old-run-that-already-ended", exit: 0, event: "reset by register" } },
    { reviews: [review({ id: 2301, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.runner.start("leftover", "/bin/claude", [], {});
  w.clock.advance(6);
  const results = await w.tick.tick();

  assert.equal(w.entry().state, STATES.prOpen, "the entry is not stopped by somebody else's run");
  assert.equal(w.entry().reason, null);
  // The leftover process still holds the runner, so the dispatch itself cannot land, and that part is correct: one run
  // per entry is the lock. It is a wait and it says so, rather than a per-poll line in errors.log, which is what
  // ignoring the leftover instead of waiting on it newly made possible.
  assert.deepEqual(results.map(r => r.ok), [true], "the busy runner is a wait the tick handled, not an error out of it");
  assert.ok(w.logged.some(l => /run in progress|dispatching review 2301/.test(l)), `the wait is explained (got ${w.logged})`);
  assert.equal(w.entry().cursor.since, T0, "and the cursor did not move, so the review is still there to dispatch");

  // What has changed is that the entry is no longer waited on for the full timeout and then blamed for it.
  w.clock.advance(31);
  await w.tick.tick();
  assert.notEqual(w.entry().reason, "timeout", "a leftover is never blamed on the entry that did not start it");
  assert.equal(w.entry().last.run, "old-run-that-already-ended", "and `last.run` is not rewritten to a run this entry never dispatched");
  assert.deepEqual(w.notify.sent, [], "nor is the operator told this entry timed out");

  // Once the leftover is out of the way the review is read and dispatched, which is the work the freeze was delaying.
  w.runner.finish(claudeResultLines());
  await w.tick.tick();
  assert.equal(w.runner.started.length, 2);
  assert.match(w.runner.started[1].args.at(-1), /review 2301/);
});

test("a draft PR that meets every other ready condition asks a person instead of sitting forever", async () => {
  // The ready branch declines a draft, and then every stop below declines it too: the reviewer is clear so neither the
  // blocking nor the waiting branch fires, and the checks are green so the red one does not. The entry sat in pr-open
  // with nothing left that could happen to it, while `status` said "waiting on reviewer".
  const w = world({ rereview: { at: T0, nudged: true } }, {
    pr: prFixture({ isDraft: true, statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  });
  w.clock.advance(4);
  await w.tick.tick();

  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "draft"]);
  assert.match(w.entry().last.event, /^draft, otherwise ready, on a1b2c3d/);
  assert.deepEqual(w.notify.sent, [["needs", 142, "draft"]]);

  // Once per head, not once per poll.
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1);
});

test("a checkout that cannot be recreated stops the entry and rings once, instead of logging the same line forever", async () => {
  // A revoked token, a full disk, a branch deleted on the remote, an unmounted worktrees volume. The per-entry catch
  // logged one line every poll with the state, the cursor and the iteration untouched and nothing notified, because
  // `notify.error` is only ever reached from the daemon's probe loop.
  const clock = makeClock();
  const { state, id } = seededState();
  const gh = fakeGh({ reviews: [review({ id: 2401, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  const runner = fakeRunner(clock);
  const notify = fakeNotify();
  const git = { ...fakeGit(), exists: () => false, fromBranch: async () => { throw new Error("fatal: could not read Username"); } };
  const tick = makeTick({ config: CONFIG, state, gh, git, notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });
  clock.advance(6);
  const results = await tick.tick();

  assert.deepEqual(results.map(r => r.ok), [true], "the tick handled it rather than throwing out to the per-entry catch");
  assert.deepEqual([state.get(id).state, state.get(id).reason], [STATES.needsHuman, "no-worktree"]);
  assert.match(state.get(id).last.event, /cannot recreate \/tmp\/wt: fatal: could not read Username/);
  assert.deepEqual(notify.sent, [["needs", 142, "no-worktree"]]);
  assert.equal(runner.started.length, 0, "and no run was spawned in a checkout that is not there");

  await tick.tick();
  assert.equal(notify.sent.length, 1, "told once, not on every poll");
});

test("needs-human labels that fail to write are retried on a later tick, rather than leaving the PR saying the opposite", async () => {
  // `removeLabel` swallowed everything and `addLabel`'s failure was logged and dropped, with the registry already at
  // needs-human and every later tick returning early on that state. A rate-limited GitHub left the PR carrying
  // `ready-for-human` and no `needs-human` while the registry said stopped, and nothing ever reconciled it.
  const w = world({ state: STATES.ready }, { pr: prFixture({ mergeable: "CONFLICTING" }) });
  let fail = true;
  w.gh.removeLabel = async (repo, n, label) => { w.gh.calls.push(["removeLabel", n, label]); if (fail) throw new Error("HTTP 429: rate limited"); };
  await w.tick.tick();

  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "conflict"], "the entry is stopped regardless: the labels are not what stops it");
  assert.equal(w.entry().labels_pending, true, "but the unfinished write is recorded");
  assert.deepEqual(w.notify.sent, [["needs", 142, "conflict"]], "and the operator is told once, now, not after the labels land");

  // The next tick finishes the write and nothing else.
  fail = false;
  await w.tick.tick();
  assert.equal(w.entry().labels_pending, false);
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === NEEDS_LABEL), "the needs-human label reaches the PR");
  assert.equal(w.notify.sent.length, 1, "without a second notification");

  // And once it has landed, a stopped entry is left alone again: only the PR read that every tick does.
  const before = w.gh.calls.filter(c => c[0] !== "prView").length;
  await w.tick.tick();
  assert.equal(w.gh.calls.filter(c => c[0] !== "prView").length, before, "no further label writes for an entry whose labels are settled");
});


test("the skipped-gate flag describes the ready state it was recorded with, and goes when that state goes", async () => {
  // An entry with no PRD snapshot reaches ready on the checks and the reviewer alone. That is worth saying on the row
  // a person merges from, and worth un-saying the moment the entry is no longer ready, or `status` and `why` would keep
  // warning about a gate that did not run for a head nobody is being asked to merge.
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  }, { readPrd: () => null }); // no snapshot at all
  w.clock.advance(4);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.ready);
  assert.equal(w.entry().gate_skipped, "no PRD snapshot", "recorded where status and why can read it");
  assert.ok(w.logged.some(l => /no PRD snapshot, completion gate skipped/.test(l)));

  // A new head reopens it, and the flag goes with the ready state.
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(5) })] });
  w.gh.data.commitDates = { d4e5f6a: at(5) };
  w.clock.advance(2);
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.prOpen);
  assert.equal(w.entry().gate_skipped, null, "no stale warning about a head nobody is asked to merge");

  // And a stop clears it too, by the same rule.
  const stopped = world({ state: STATES.ready, gate_skipped: "no PRD snapshot" }, { pr: prFixture({ mergeable: "CONFLICTING" }) });
  await stopped.tick.tick();
  assert.deepEqual([stopped.entry().state, stopped.entry().gate_skipped], [STATES.needsHuman, null]);
});
