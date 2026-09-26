import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTick, roundComment } from "../lib/tick.mjs";
import { READY_LABEL, NEEDS_LABEL, ROUND_MARKER, NUDGE_MARKER } from "../lib/gh.mjs";
import { CONFIG, T0, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, prFixture, review, inline, comment, checkRun, claudeResultLines, codexLines, silentLog, STATES, GOOD_PRD, tempHome } from "./helpers.mjs";

const BOT = "chatgpt-codex-connector[bot]";
const clearReviewer = () => [review({ id: 2, by: BOT, bot: true, state: "COMMENTED", at: at(3), body: "**Reviewed commit:** `a1b2c3`" })];

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
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
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
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.iteration, 1);
  assert.equal(e.cursor.fixed_sha, "d4e5f6");
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
    reviews: [review({ id: 1, by: BOT, bot: true, state: "COMMENTED", at: at(-1) }), review({ id: 2, by: BOT, bot: true, state: "APPROVED", at: at(3) })],
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
  const gh = fakeGh({ commitDates: { a1b2c3: T0 } });
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
  const w = world({ iteration: 0, last: { at: T0, run: "1-fix", exit: null, event: "review" } }, { commitDates: { d4e5f6: at(2) } });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
  w.gh.data.reviews = [review({ id: 7, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3), body: "**Reviewed commit:** `d4e5f6`" })];
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
  const w = world({ cursor: { since: at(5), fixed_sha: "a1b2c3", checks_sha: null, receipt_hash: null }, rereview: { at: at(0), nudged: false } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 3, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3), body: "**Reviewed commit:** `a1b2c3`" })] });
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
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
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
    { prsByHead: [{ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa", isCrossRepository: false, createdAt: at(20) }] });
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(25);
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.state, STATES.prOpen);
  assert.equal(e.pr, 143);
  assert.equal(e.cursor.fixed_sha, "aaaa");
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
    { prsByHead: [{ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa", isCrossRepository: false, createdAt: at(2) }],
      reviews: [review({ id: 7, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })] });
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(6);
  w.gh.data.pr = prFixture({ number: 143, headRefOid: "aaaa" });
  await w.tick.tick(); // settles: PR open with the cursor at the PR's creation, so the review is new and dispatched at once
  assert.equal(w.runner.started.length, 2);
  assert.match(w.runner.started[1].args.at(-1), /review 7/);
  assert.equal(w.entry().cursor.since, at(3), "the cursor then moves to the review that was dispatched");
});

test("a failing check on a head the loop itself pushed is dispatched once, then stops with checks-red", async () => {
  const w = world({ iteration: 1, cursor: { since: T0, fixed_sha: "a1b2c3", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(1) })] }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1, "red CI on the current head dispatches a fix");
  assert.equal(w.entry().cursor.checks_sha, "a1b2c3");
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6", statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(9) })] });
  w.clock.advance(4);
  await w.tick.tick(); // settles the push (round 2)
  w.clock.advance(1);
  await w.tick.tick(); // new head, red again: dispatched again
  assert.equal(w.runner.started.length, 2);
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6", statusCheckRollup: [checkRun({ name: "test", conclusion: "FAILURE", at: at(9) })] });
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
  gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
  gh.data.commitDates = { d4e5f6: at(8) };
  await tick.tick(); // settles the push; the cursor moves to the push at +8, which is still before the comment at +9
  assert.equal(state.get(id).iteration, 1);

  await tick.tick();
  assert.equal(runner.started.length, 2, "the comment that arrived during the clone is dispatched on a later tick");
  assert.match(runner.started[1].args.at(-1), /the typo too/, "the command body, with the @gallivant fix prefix stripped");
});

test("with no events to bound it, the cursor moves to the time captured before the reads, not after the spawn", async () => {
  const clock = makeClock();
  const { state, id } = seededState({ cursor: { since: T0, fixed_sha: "a1b2c3", checks_sha: "a1b2c3", receipt_hash: null } });
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
  gh.data.pr = prFixture({ headRefOid: "d4e5f6" });
  gh.data.commitDates = { d4e5f6: at(5) }; // the push lands in that second too, so the cursor does not move past it
  await tick.tick();
  assert.equal(state.get(id).iteration, 1);

  await tick.tick();
  assert.equal(runner.started.length, 2, "the comment sharing the review's second is dispatched on a later tick");
  assert.match(runner.started[1].args.at(-1), /the typo too/);

  // And it is not dispatched a second time: the run ends having pushed, and the next tick has nothing new.
  runner.finish(claudeResultLines());
  gh.data.pr = prFixture({ headRefOid: "778899" });
  gh.data.commitDates = { "778899": at(5) };
  await tick.tick();
  await tick.tick();
  assert.equal(runner.started.length, 2, "the command it already handled is not sent again");
});

test("an event already dispatched at the cursor's own second is never dispatched twice", async () => {
  // The inclusive comparison is what makes the case above work; `cursor.dispatched` is what keeps it from replaying.
  const w = world(
    { cursor: { since: at(5), dispatched: ["command:77"], fixed_sha: "a1b2c3", checks_sha: "a1b2c3", receipt_hash: null }, rereview: { at: at(5), nudged: false } },
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
    { cursor: { since: at(5), dispatched: ["review:2201"], fixed_sha: "a1b2c3", checks_sha: "a1b2c3", receipt_hash: null } },
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
  const { state, id } = seededState({ cursor: { since: at(5), dispatched: ["command:77"], fixed_sha: "a1b2c3", checks_sha: "a1b2c3", receipt_hash: null }, rereview: { at: at(5), nudged: false } });
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
  const gh = fakeGh({ pr: prFixture({ headRefOid: "d4e5f6" }) }); // pushed, and commitDate answers null
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
