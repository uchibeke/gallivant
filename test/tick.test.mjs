import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTick, roundComment, receiptRoundComment } from "../lib/tick.mjs";
import { READY_LABEL, NEEDS_LABEL, ROUND_MARKER, NUDGE_MARKER, makeGh } from "../lib/gh.mjs";
import { RECEIPT_TAG } from "../lib/deliverable.mjs";
// The recovery side of the count and the operator's view of it, both driven here rather than mocked: the property the
// round-comment tests below assert is that `iteration`, `countRounds` and what `why` prints all say the same thing.
import { countRounds } from "../lib/events.mjs";
import { why } from "../lib/commands/why.mjs";
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

// The round comment no longer decides whether the round happened. Five tests, one per property the brief named, plus
// the two that were here before, rewritten for the new ordering. The property under all five: a PUSH is what a round
// is, and `max_iterations` counts pushes. The comment is the announcement, and an announcement that will not send does
// not make the push untrue.

test("property 1: a round that pushed is counted exactly once, whether the comment posts now, later, or never", async () => {
  // Three worlds, one push each, three fates for the comment. Pre-change the first counted 1 and the other two
  // counted 0, so the counter agreed with the work in one case out of three.
  const push = async w => {
    w.clock.advance(6);
    await w.tick.tick();                     // dispatch
    w.clock.advance(10);
    w.runner.finish(claudeResultLines({ cost: 1.25 }));
    w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  };
  const reviews = () => [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })];

  const now = world({}, { reviews: reviews() });
  await push(now);
  await now.tick.tick();
  assert.equal(now.entry().iteration, 1, "posted on the first attempt");
  assert.equal(countRounds(now.gh.data.comments, "me"), 1, "and the marker is on the PR, so a recovery counts it too");
  assert.ok(!now.entry().round_comment, "nothing is owed");

  const later = world({}, { reviews: reviews() });
  await push(later);
  let refuse = true;
  const real = later.gh.comment;
  later.gh.comment = async (...a) => { if (refuse) throw new Error("HTTP 502: bad gateway"); return real(...a); };
  await later.tick.tick();
  assert.equal(later.entry().iteration, 1, "counted on the push, not on the comment");
  // `since` is the cursor the round was counted AT, stored with the debt because the cursor has since moved past the
  // push: asking `commentOnce` "is the marker there since the current cursor" would answer no for a comment this very
  // step had posted, and the entry would post one per tick.
  assert.deepEqual(later.entry().round_comment, { kind: "round", since: at(5), pushed_at: at(16) }, "the comment is owed, against the boundary the round was counted at");
  refuse = false;
  await later.tick.tick();
  assert.equal(later.entry().iteration, 1, "posting it later does not count a second round");
  assert.equal(later.entry().round_comment, null, "and clears the debt");

  const never = world({}, { reviews: reviews() });
  await push(never);
  never.gh.comment = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  for (let i = 0; i < 6; i++) await never.tick.tick();
  const e = never.entry();
  assert.equal(e.iteration, 1, "the round it could never announce is still counted: the push is the fact");
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "stuck"], "and five refusals still stop the entry");
});

test("property 2: no round is counted twice, across a decline, a later success, and a recovery in between", async () => {
  // Two ways to double count, both checked. The retry path: the settle tick counts, the comment declines, and the next
  // tick must post without counting again. The recovery path: the registry is rebuilt from the PR while the comment is
  // still owed, and the count must not be the recovered count PLUS the round the next settle would add.
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  w.clock.advance(10);
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  let refuse = true;
  const real = w.gh.comment;
  const posted = [];
  w.gh.comment = async (r, n, b) => { if (refuse) throw new Error("HTTP 502"); posted.push(b); return real(r, n, b); };

  await w.tick.tick();
  for (let i = 0; i < 3; i++) await w.tick.tick();               // three more declines
  assert.equal(w.entry().iteration, 1, "four declines, one round");
  refuse = false;
  await w.tick.tick();
  await w.tick.tick();                                          // and a tick with nothing owed
  assert.equal(w.entry().iteration, 1, "still one round");
  assert.equal(posted.length, 1, "one comment, not one per attempt");
  assert.equal(countRounds(w.gh.data.comments, "me"), 1, "and one marker on the PR, so a recovery counts one too");
});

test("property 3: the cap counts pushes, so a round whose comment was refused still spends the budget", async () => {
  // The spend argument, driven. An entry one round below the cap pushes its last allowed round and the comment is
  // refused. Pre-change the registry said `max_iterations - 1`, so the PR had received three rounds and was charged
  // two, and every later recovery or reset rebuilt from a count that was short.
  const w = world({ iteration: CONFIG.max_iterations - 1 }, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.gh.comment = async () => { throw new Error("HTTP 403"); };
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1, "the last allowed round is dispatched");
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  for (let i = 0; i < 5; i++) await w.tick.tick();
  assert.equal(w.entry().iteration, CONFIG.max_iterations, "the push is charged to the budget it spent");

  // And the cap itself still fires with `iterations`, counting that push.
  const spent = world({ iteration: CONFIG.max_iterations }, { reviews: [review({ id: 2, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  spent.clock.advance(6);
  await spent.tick.tick();
  assert.equal(spent.runner.started.length, 0, "no run starts");
  assert.deepEqual([spent.entry().state, spent.entry().reason], [STATES.needsHuman, "iterations"]);

  // The sharpest form, in one daemon lifetime with nothing reset by hand: an entry one round below the cap spends its
  // last round, the comment is refused once and then posts, and the next event stops it with `iterations` rather than
  // buying a round the budget did not have. Pre-change this entry was charged `max_iterations - 1` and went on to
  // dispatch a round past the cap, which is the spend the cap exists to prevent.
  const edge = world({ iteration: CONFIG.max_iterations - 1 },
    { reviews: [review({ id: 3, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })], commitDates: { d4e5f6a: at(10) } });
  let refuse = true;
  const realComment = edge.gh.comment;
  edge.gh.comment = async (...a) => { if (refuse) throw new Error("HTTP 403"); return realComment(...a); };
  edge.clock.advance(6);
  await edge.tick.tick();
  edge.runner.finish(claudeResultLines());
  edge.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  edge.clock.advance(10);
  await edge.tick.tick();                                   // the settle counts the round; the comment is refused
  assert.equal(edge.entry().iteration, CONFIG.max_iterations, "the last allowed round is spent and charged");
  edge.gh.data.reviews.push(review({ id: 4, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(30) }));
  edge.clock.advance(20);
  refuse = false;
  await edge.tick.tick();                                   // the comment posts, then the waiting review meets the cap
  assert.deepEqual([edge.entry().state, edge.entry().reason], [STATES.needsHuman, "iterations"], "the cap stops it on the real count");
  assert.equal(edge.runner.started.length, 1, "and no round past the cap is ever dispatched");
  assert.deepEqual(edge.notify.sent, [["needs", 142, "iterations"]]);
});

test("property 4: the registry and countRounds agree whenever the marker is on the PR, and say so when it is not", async () => {
  // The count on GitHub is what `reconcile` rebuilds `iteration` from, so the two must agree. They do for every round
  // whose comment landed, on the first attempt or the fifth. The one case where they cannot is a round whose comment
  // never posted at all, which now means the entry has STOPPED with `stuck`: the gap is exactly one round, it is on a
  // stopped entry, and `why` says so, because a recovery from GitHub alone would charge one round fewer.
  const w = world({ iteration: 1 }, {
    reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })],
    comments: [comment({ id: 1, by: "me", at: at(1), body: `@codex review\n\n${ROUND_MARKER}` })],
  });
  w.clock.advance(6);
  await w.tick.tick();
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  let refuse = true;
  const real = w.gh.comment;
  w.gh.comment = async (...a) => { if (refuse) throw new Error("HTTP 403"); return real(...a); };

  await w.tick.tick();
  assert.equal(w.entry().iteration, 2, "counted");
  assert.equal(countRounds(w.gh.data.comments, "me"), 1, "not yet on the PR: the registry is one ahead while the comment is owed");
  const text = why({ config: CONFIG, state: w.state, runnerFor: () => w.runner }, { handle: "widget#142" });
  assert.match(text, /round 2 is counted and its push is on the branch/, "and `why` says which round the PR has not been told about");
  assert.match(text, /a recovery from GitHub would count 1 round until it posts/, "with the number a recovery would rebuild");

  refuse = false;
  await w.tick.tick();
  assert.equal(w.entry().iteration, countRounds(w.gh.data.comments, "me"), "once it posts, the two agree exactly");
  assert.equal(w.entry().round_comment, null);
  assert.doesNotMatch(why({ config: CONFIG, state: w.state, runnerFor: () => w.runner }, { handle: "widget#142" }), /is counted and its push is on the branch/);

  // The absent case, stated rather than implied: five refusals, the entry stops, and the gap is one and stays one.
  const stuck = world({ iteration: 1 }, {
    reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })],
    comments: [comment({ id: 1, by: "me", at: at(1), body: `@codex review\n\n${ROUND_MARKER}` })],
  });
  stuck.gh.comment = async () => { throw new Error("HTTP 403") };
  stuck.clock.advance(6);
  await stuck.tick.tick();
  stuck.runner.finish(claudeResultLines());
  stuck.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  for (let i = 0; i < 7; i++) await stuck.tick.tick();
  const s = stuck.entry();
  assert.deepEqual([s.state, s.reason], [STATES.needsHuman, "stuck"]);
  assert.equal(s.iteration - countRounds(stuck.gh.data.comments, "me"), 1, "the gap is one round, and one is the most it can ever be");
  assert.ok(s.round_comment, "the debt stays on the entry, so `why` keeps saying which round the PR was never told about");
});

test("a stop that matters more than the comment wins, and the counted round survives it", async () => {
  // The round comment step runs after the terminal checks, so a stop with a reason of its own preempts it: a PR that
  // conflicts while its round comment is owed stops with `conflict`, not with `stuck` about a comment. That is the right
  // order, because `conflict` is the thing a person can act on and the comment is not. What must survive is the count,
  // and the debt, so `why` can still say which round the PR was never told about.
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.gh.comment = async () => { throw new Error("HTTP 403") };
  w.clock.advance(6);
  await w.tick.tick();
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  await w.tick.tick();
  assert.equal(w.entry().iteration, 1);
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", mergeable: "CONFLICTING" });
  await w.tick.tick();
  const e = w.entry();
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "conflict"], "the reason a person can act on wins");
  assert.equal(e.iteration, 1, "and the round the push earned is still counted");
  assert.ok(e.round_comment, "with the comment still recorded as owed");
  assert.deepEqual(w.notify.sent, [["needs", 142, "conflict"]], "told once, about the conflict");
});

test("a receipt-only round is counted on the receipt and its comment owed the same way, without touching the reviewer clock", async () => {
  // The other kind of round. There is no push, so there is no re-review to ask for and no committer date to date it
  // from: the receipt in the PR body changed, which is progress, and it counts. The comment saying so is owed exactly
  // as the pushed round's is, and landing it must not start the reviewer clock, because nothing asked the reviewer
  // anything. Pre-change the receipt round was not counted either while its comment was refused.
  const w = world({ cursor: { since: at(0), dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  let refuse = true;
  const real = w.gh.comment;
  w.gh.comment = async (...a) => { if (refuse) throw new Error("HTTP 403"); return real(...a); };
  w.clock.advance(6);
  await w.tick.tick();
  w.runner.finish(claudeResultLines());
  // Same head, a receipt in the body that was not there when the run started.
  w.gh.data.pr = prFixture({ headRefOid: "a1b2c3d", body: `Adds export.${receiptBlock()}` });
  await w.tick.tick();
  let e = w.entry();
  assert.equal(e.iteration, 1, "the receipt change is a round and is counted by it");
  assert.deepEqual(e.round_comment, { kind: "receipt", since: at(5) }, "with no `pushed_at`: there is no push to date a clock from");
  assert.equal(e.rereview.at, T0, "and no ask is claimed");
  refuse = false;
  await w.tick.tick();
  e = w.entry();
  assert.equal(e.iteration, 1, "posting it counts nothing further");
  assert.equal(e.round_comment, null);
  assert.equal(e.rereview.at, T0, "and landing a receipt comment still asks the reviewer nothing");
  assert.ok(w.gh.data.comments.some(c => c.body === receiptRoundComment()), "the receipt-round comment is what was posted");
});

test("a round comment that will not post is bounded, does not repeat the ask, and does not judge the reviewer's silence", async () => {
  // Rewritten for the new ordering. The bound is unchanged: five consecutive refusals and the entry stops with
  // `stuck`, naming the write. What changed is what it is bounding. The round is already counted and the cursor has
  // already moved, so the decline is not "this round did not happen"; it is "the rest of this tick must not run",
  // because the comment is also the re-review request and an entry that owes one has asked the reviewer nothing.
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();                       // dispatch the fix
  w.clock.advance(10);
  w.runner.finish(claudeResultLines({ cost: 1.25 }));
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  w.gh.comment = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token") };

  for (let i = 1; i <= 4; i++) {
    const results = await w.tick.tick();
    const e = w.entry();
    assert.deepEqual(e.retry, { op: "round comment", count: i }, `tick ${i} counts the failure, once per tick and not twice`);
    assert.equal(e.iteration, 1, `tick ${i} keeps the one round the one push earned`);
    assert.equal(e.last.exit, 0, "the settle is finished: the exit is recorded before the comment is ever attempted");
    assert.equal(e.cursor.fixed_sha, "d4e5f6a", "and the cursor is on the head the round pushed");
    assert.deepEqual(results.map(r => r.ok), [true], "handled inside the tick, not thrown at the per-entry catch");
    assert.deepEqual(w.notify.sent, [], `tick ${i} rings nobody`);
    // The ask is the comment, so the clock must not move while the comment is owed. Moving it would give the reviewer a
    // fresh silence window for a question nobody put, and the entry would wait `stall_hours` on nothing.
    assert.equal(e.rereview.at, T0, `tick ${i} does not claim a re-review was asked`);
    assert.equal(e.rereview.nudged, false);
    assert.notEqual(e.reason, "reviewer-silent", `tick ${i} does not judge the reviewer on a question it never asked`);
    assert.equal(w.runner.started.length, 1, `tick ${i} does not charge a second round while the first is unannounced`);
  }

  await w.tick.tick();
  const e = w.entry();
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "stuck"], "the fifth failure stops it");
  assert.match(e.last.event, /round comment failed 5 ticks in a row: HTTP 403/);
  assert.equal(e.last.cost, 1.25, "with what the round cost, which the operator is paying for either way");
  assert.equal(e.iteration, 1, "and the round is counted: the push happened and the budget was spent on it");
  assert.deepEqual(w.notify.sent, [["needs", 142, "stuck"]]);

  await w.tick.tick();
  assert.equal(w.entry().retry, null, "no fresh streak against a stopped entry");
  assert.equal(w.notify.sent.length, 1, "and it is not re-notified");
});

test("a round comment that fails once and then posts asks for the re-review on the tick that posts it", async () => {
  const w = world({}, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.clock.advance(6);
  await w.tick.tick();
  w.clock.advance(10);
  w.runner.finish(claudeResultLines({ cost: 1.25 }));
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a" });
  let fail = true;
  const posted = [];
  const realComment = w.gh.comment;
  w.gh.comment = async (repo, n, body) => { if (fail) throw new Error("HTTP 502: bad gateway"); posted.push(body); return realComment(repo, n, body); };

  await w.tick.tick();
  assert.equal(w.entry().iteration, 1, "the round is counted by the push");
  assert.equal(w.entry().cursor.fixed_sha, "d4e5f6a", "and the cursor with it");
  assert.equal(w.entry().rereview.at, T0, "but the ask has not been made");
  fail = false;
  w.clock.advance(3);
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.iteration, 1, "posting it does not count a second round");
  assert.equal(e.retry, null, "and the count is cleared by that write landing");
  // Through `reviewerClock`, from the committer date of the head the round pushed, floored at the nudge window.
  assert.equal(e.rereview.at, at(16), "the ask is dated from the push the comment is about, not from the retry");
  assert.equal(e.rereview.nudged, false);
  assert.equal(posted.length, 1, "one comment, not one per attempt");
  assert.deepEqual(w.notify.sent, [], "nobody was ever told: nothing stopped");
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
  // `prView` answers for the PR the entry ends up watching, with the same head `prListByHead` reported. The fake used
  // to answer the default fixture's #142 on `a1b2c3d` here, which was invisible while nothing compared the head and
  // is now read, correctly, as a push nobody told the loop about.
  const opened = { number: 143, url: "https://github.com/acme/widget/pull/143", title: "Widget export", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", body: "Implements export.", headRefOid: "aaaa111", headRefName: "gallivant/widget-export", isCrossRepository: false, createdAt: at(20), statusCheckRollup: [], labels: [], baseRefName: "main" };
  const w = world({ state: STATES.running, pr: null, url: undefined, cursor: { since: T0, fixed_sha: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { pr: opened, prsByHead: [opened] });
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
  assert.ok(w.logged.some(l => /ready label write failed \(HTTP 502.*attempt 1 of 5/.test(l)), `the failure is explained (got ${w.logged})`);
  assert.deepEqual(w.entry().retry, { op: "ready label write", count: 1 }, "and it is counted, so the wait is bounded");

  // The next tick judges the same head again and the label takes. One notification, not one per attempt.
  await w.tick.tick();
  assert.equal(attempts, 2, "the same work is retried, not a second round of anything");
  assert.equal(w.entry().state, STATES.ready);
  assert.equal(w.entry().retry, null, "the count is cleared by the write landing, and never sits on a ready entry");
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
  assert.equal(w.entry().iteration, 0, "a label retry is not a fix round");
});

test("a ready label that will NEVER write stops the entry with stuck, rather than re-running the gate every tick forever", async () => {
  // The fourth caller of the bound, and the one the round that added the other three predicted. A token that cannot
  // write labels at all never recovers, and this path had no counter: the entry stayed in `pr-open`, repeating the
  // readiness judgement and the label attempt on every poll for as long as the daemon ran, with one `log.warn` each
  // time and nothing that would ever stop or notify. Every readiness condition had already passed, so `status` said
  // the entry was waiting on the reviewer, which the reviewer had already answered.
  const w = world({ rereview: { at: T0, nudged: false } }, {
    pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: clearReviewer(),
  });
  // Counted per label, because the stop itself writes the OTHER one: `needsHuman` tries `gallivant:needs-human` on the
  // tick that stops the entry, and that attempt is not a sixth try at the ready label.
  const attempts = { [READY_LABEL]: 0, [NEEDS_LABEL]: 0 };
  w.gh.addLabel = async (repo, n, label) => { attempts[label]++; throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  w.clock.advance(4);

  for (let i = 1; i <= 4; i++) {
    await w.tick.tick();
    assert.deepEqual(w.entry().retry, { op: "ready label write", count: i }, `tick ${i} counts the failure`);
    assert.equal(w.entry().state, STATES.prOpen, `tick ${i} leaves the retryable state`);
    assert.deepEqual(w.notify.sent, [], `tick ${i} rings nobody: a 403 may be a token being rotated`);
  }

  await w.tick.tick();
  const e = w.entry();
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "stuck"], "the fifth failure stops it rather than polling forever");
  assert.equal(e.retry, null, "and the counter goes with the stop");
  assert.match(e.last.event, /ready label write failed 5 ticks in a row: HTTP 403/, "naming the write and what GitHub said");
  assert.deepEqual(w.notify.sent, [["needs", 142, "stuck"]], "rung once, like every other stop");
  assert.equal(attempts[READY_LABEL], 5, "and the ready label was attempted five times, not indefinitely");
  assert.equal(attempts[NEEDS_LABEL], 1, "while the stop tried to say so on the PR, which is a different write");

  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1, "told once, not on every poll after that");
  assert.equal(attempts[READY_LABEL], 5, "and the ready label is never attempted again once the entry has stopped");
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

test("nothing spawns until the state that owns the run is durable: a ready-label removal that fails dispatches nothing", async () => {
  // The spawn used to come first. `startRun` launched the process, then `reopen` threw on the label removal, so the
  // save below it never ran: `last.run` still named an earlier run, the cursor never recorded the feedback, and
  // `settleRun` read the live process as an unrelated leftover and ignored it. When it exited, the same review was
  // still new and a SECOND fixer was spawned for it, against a tree the first one had been editing.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  let fail = true;
  w.gh.removeLabel = async (repo, n, label) => { w.gh.calls.push(["removeLabel", n, label]); if (fail) throw new Error("HTTP 502: bad gateway"); };
  w.clock.advance(6);
  const results = await w.tick.tick();

  assert.deepEqual(results.map(r => r.ok), [true], "the tick handled it rather than throwing out to the per-entry catch");
  assert.equal(w.runner.started.length, 0, "no process is running that the registry does not know about");
  assert.equal(w.entry().state, STATES.ready, "and nothing about the entry moved, so the next tick repeats the same work");
  assert.equal(w.entry().cursor.since, T0, "the cursor did not advance past feedback that was never dispatched");
  assert.ok(w.logged.some(l => /ready label removal failed .*not dispatching/.test(l)), `the tick of nothing is explained (got ${w.logged})`);
  assert.deepEqual(w.entry().retry, { op: "ready label removal", count: 1 }, "and the wait is counted, so it cannot go on forever");

  // GitHub answers, and the same review is dispatched exactly once.
  fail = false;
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1, "one fixer for one review");
  assert.equal(w.entry().last.run, w.runner.started[0].id, "and the registry owns the run it spawned");
  assert.equal(w.entry().state, STATES.prOpen);
  assert.equal(w.entry().cursor.since, at(5));

  // The run ends having pushed. Nothing is left over to dispatch a second time.
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] });
  w.gh.data.commitDates = { d4e5f6a: at(11) };
  w.clock.advance(5);
  await w.tick.tick();
  await w.tick.tick();
  assert.equal(w.runner.started.length, 1, "the review that was handled is never dispatched again");
});

test("an untracked head change resets the reviewer clock in pr-open too, not only after ready", async () => {
  // The head-change guard ran only for `ready`. A human or a bot pushing onto a watched PR left `fixed_sha`,
  // `rereview.at` and `rereview.nudged` all describing the head before it, so the same tick that noticed the push
  // could stop the entry as `reviewer-silent` on a wait that expired before the new commit existed, and the nudge
  // already spent on the old head was never reissued for this one.
  const w = world({ state: STATES.prOpen, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null }, rereview: { at: T0, nudged: true } },
    { pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(415) })] }), commitDates: { d4e5f6a: at(415) } });
  w.clock.advance(420); // seven hours: `stall_hours` is 6, so the old clock is long expired
  await w.tick.tick();

  const e = w.entry();
  assert.equal(e.state, STATES.prOpen, "a commit pushed five minutes ago is not a reviewer who went silent for seven hours");
  assert.equal(e.reason, null);
  assert.deepEqual(w.notify.sent, [], "and nobody's phone rang for a silence that never happened");
  assert.equal(e.cursor.fixed_sha, "d4e5f6a", "the head the loop will act on is the one that is there");
  assert.equal(e.rereview.at, at(415), "the wait for a review of this commit starts at the push");
  assert.equal(e.rereview.nudged, false, "and the nudge is available again for the head nobody has been asked about");
  assert.ok(w.logged.some(l => /head moved to d4e5f6a; watching again/.test(l)), `the reset is explained (got ${w.logged})`);
  assert.ok(!w.logged.some(l => /after ready/.test(l)), "and it does not claim the entry was ready");

  // Past the nudge window on the NEW clock, the reviewer is asked for this head.
  w.clock.advance(7);
  await w.tick.tick();
  assert.equal(w.entry().rereview.nudged, true);
  assert.ok(w.gh.calls.some(c => c[0] === "comment" && c[2].includes(NUDGE_MARKER)), "the re-review is asked for through the nudge the silence step owns");
});

test("a head whose committer date is older than the nudge window does not stop the entry on the tick that noticed it", async () => {
  // The other half of the same reset: `reviewerClock` floors the committer date at the nudge window, so a commit made
  // on Monday and pushed on Thursday does not arrive with a clock that is already expired. Both watching states go
  // through the one function, so neither can regress on its own.
  for (const state of [STATES.prOpen, STATES.ready]) {
    const w = world({ state, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null }, rereview: { at: T0, nudged: false } },
      { pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(600) })] }), commitDates: { d4e5f6a: T0 } });
    w.clock.advance(600); // ten hours after a commit dated ten hours ago
    await w.tick.tick();

    const e = w.entry();
    assert.equal(e.state, STATES.prOpen, `${state}: a commit's age is not the reviewer's silence`);
    assert.equal(e.reason, null, `${state}: nothing stopped it`);
    assert.equal(e.rereview.at, at(594), `${state}: the clock is floored at the nudge window, not taken from the commit`);
    assert.equal(e.rereview.nudged, false, `${state}: and the nudge has not been spent`);
    assert.deepEqual(w.notify.sent, [], `${state}: nobody was told`);
  }
});

test("a start run whose identity block will not write stays in running and retries, rather than reaching pr-open with no block", async () => {
  // The block is what reconciliation rebuilds an entry from once `state.json` is gone. A swallowed failure moved the
  // entry to `pr-open` anyway, so the advertised recovery skipped the PR and the session it names could not be
  // resumed. `register`'s equivalent throws; the tick has no operator, so it needs a state the next tick retries from.
  const opened = { ...prFixture({ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa111", createdAt: at(20) }) };
  const w = world({ state: STATES.running, pr: null, url: undefined, cursor: { since: T0, fixed_sha: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { pr: opened, prsByHead: [opened] });
  let fail = true;
  w.gh.setBody = async (repo, n, body) => { w.gh.calls.push(["setBody", n, body]); if (fail) throw new Error("HTTP 403: rate limited"); w.gh.data.pr.body = body; };
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(25);
  const results = await w.tick.tick();

  assert.deepEqual(results.map(r => r.ok), [true], "the tick handled it rather than throwing out to the per-entry catch");
  let e = w.entry();
  assert.equal(e.state, STATES.running, "the entry has not left the state whose next tick retries this");
  assert.equal(e.pr, null, "and it does not claim to watch a PR it cannot identify");
  assert.equal(e.last.exit, null, "`last.exit` is what settleRun re-enters on, so it stays unrecorded");
  assert.equal(e.session, "6f1c2d3e-1111-4111-8111-111111111111", "the session is kept, so a retry never mints a second one");
  assert.ok(w.logged.some(l => /block write failed .*staying in running/.test(l)), `the retryable state is named (got ${w.logged})`);

  // It genuinely retries: the next tick writes the block and moves on, in that same pass.
  fail = false;
  await w.tick.tick();
  e = w.entry();
  assert.equal(e.state, STATES.prOpen);
  assert.equal(e.pr, 143);
  assert.equal(e.cursor.fixed_sha, "aaaa111");
  assert.match(w.gh.data.pr.body, /<!-- gallivant\nprd: docs\/prds\/widget-export.md\nharness: claude\nsession: 6f1c2d3e-1111-4111-8111-111111111111\nbranch: gallivant\/widget-export\n-->/);
  assert.equal(w.runner.started.length, 1, "and nothing was spawned a second time while it waited");
});

test("reopen's label removal reaches the retry counter through the real gh, not just through a fake that throws", async () => {
  // Every other test of this path replaces `gh.removeLabel` with a function that throws, which proves the tick handles
  // a throw and proves nothing about whether the real one throws. It did not: `strict` was opt-in, `writeStopLabels`
  // passed it and `reopen` did not, so a 403 on the ready-label removal resolved as a success. The dispatch then went
  // ahead with `gallivant:ready-for-human` still on the PR and the counter never saw a failure to count. So this test
  // wires the REAL `removeLabel` to a `gh` CLI that refuses the write, with no options at the call site.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 2301, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  const edits = [];
  const real = makeGh({ exec: async (cmd, args) => { edits.push(args); throw new Error("gh pr edit: HTTP 403: Resource not accessible by personal access token"); } });
  w.gh.removeLabel = real.removeLabel;
  w.clock.advance(6);

  await w.tick.tick();
  assert.deepEqual(edits.at(-1), ["pr", "edit", "142", "--repo", "acme/widget", "--remove-label", READY_LABEL],
    "the removal was attempted");
  const e = w.entry();
  assert.deepEqual(e.retry, { op: "ready label removal", count: 1 }, "and the refusal was counted, not swallowed");
  assert.equal(e.state, STATES.ready, "the entry stays in the retryable state");
  assert.equal(w.runner.started.length, 0, "nothing was spawned behind a label that is still on the PR");

  // Driven to the stop, so the bound holds through the real client too.
  for (let i = 0; i < 4; i++) await w.tick.tick();
  const stopped = w.entry();
  assert.deepEqual([stopped.state, stopped.reason], [STATES.needsHuman, "stuck"]);
  assert.match(stopped.last.event, /ready label removal failed 5 ticks in a row: .*HTTP 403/);
  assert.equal(w.runner.started.length, 0, "and no fixer ever ran for feedback the loop could not relabel for");
});

test("a ready-label removal that keeps failing stops the entry with stuck, and one that recovers does not", async () => {
  // Last round's fix traded a bad state for an indefinite wait: `reopen` before the spawn is right, but a `removeLabel`
  // that keeps failing blocked the dispatch forever, with a `log.warn` per tick as the only trace. A daemon whose whole
  // purpose is that the operator can go to bed must not leave an entry stuck silently.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  w.gh.removeLabel = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  w.clock.advance(6);

  // Four ticks of declining, each one counted, and nothing stopped.
  for (let i = 1; i <= 4; i++) {
    await w.tick.tick();
    assert.deepEqual(w.entry().retry, { op: "ready label removal", count: i }, `tick ${i} counts the failure`);
    assert.equal(w.entry().state, STATES.ready, `tick ${i} leaves the retryable state`);
    assert.deepEqual(w.notify.sent, [], `tick ${i} rings nobody: it may still be transient`);
  }
  assert.equal(w.runner.started.length, 0, "and nothing was ever spawned behind the label that would not come off");

  // The fifth crosses the threshold and the entry stops, with the write named.
  await w.tick.tick();
  const e = w.entry();
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "stuck"], "the fifth failure stops it rather than waiting a sixth time");
  assert.equal(e.retry, null, "and the counter goes with the stop, so a reset does not inherit it");
  assert.match(e.last.event, /ready label removal failed 5 ticks in a row: HTTP 403/, "the operator is told which write, and what GitHub said");
  assert.deepEqual(w.notify.sent, [["needs", 142, "stuck"]], "rung exactly once, like every other stop");
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === NEEDS_LABEL), "and the PR itself says a person is needed");

  await w.tick.tick();
  assert.equal(w.notify.sent.length, 1, "told once, not on every poll after that");
});

test("a failure followed by a success resets the count, so an entry that recovers is never stopped for the ticks it lost", async () => {
  // The whole point of a CONSECUTIVE counter. A counter that only went up would stop an entry whose GitHub came back.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }), reviews: [review({ id: 2201, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] });
  let fail = true;
  w.gh.removeLabel = async (repo, n, label) => { w.gh.calls.push(["removeLabel", n, label]); if (fail) throw new Error("HTTP 502: bad gateway"); };
  w.clock.advance(6);

  // Four failures: one short of the threshold.
  for (let i = 0; i < 4; i++) await w.tick.tick();
  assert.equal(w.entry().retry.count, 4);

  // GitHub answers. The label comes off, the review is dispatched, and the count is gone.
  fail = false;
  await w.tick.tick();
  const e = w.entry();
  assert.equal(e.retry, null, "the count is cleared by the write landing, not carried");
  assert.deepEqual([e.state, e.reason], [STATES.prOpen, null], "and the entry proceeds normally");
  assert.equal(w.runner.started.length, 1, "the feedback that was waiting is dispatched");
  assert.deepEqual(w.notify.sent, [], "nobody was ever told: nothing stopped");

  // It genuinely starts from zero: the next failure of the same write is attempt one.
  w.runner.finish(claudeResultLines());
  w.gh.data.pr = prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] });
  w.gh.data.commitDates = { d4e5f6a: at(11) };
  w.clock.advance(5);
  await w.tick.tick();
  assert.equal(w.entry().retry, null, "a settled round leaves no counter behind either");
});

test("a single failure of a declining write stops nothing and notifies nobody", async () => {
  const w = world({ state: STATES.running, pr: null, url: undefined, cursor: { since: T0, fixed_sha: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { pr: prFixture({ number: 143, body: "Implements export.", headRefOid: "aaaa111", createdAt: at(20) }), prsByHead: [prFixture({ number: 143, body: "Implements export.", headRefOid: "aaaa111", createdAt: at(20) })] });
  w.gh.setBody = async () => { throw new Error("HTTP 403: rate limited"); };
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(25);
  await w.tick.tick();

  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.running, null], "one failure is a tick of waiting, nothing more");
  assert.equal(w.entry().retry.count, 1);
  assert.deepEqual(w.notify.sent, [], "and a phone that rings on the first rate limit is a phone the operator silences");
});

test("the block write shares the one counter, so the second unbounded wait closes with the first", async () => {
  // The two cases are the same defect on sibling paths, which is this codebase's recurring shape, so they share one
  // mechanism: a second counter for the second case would be the next finding.
  const opened = prFixture({ number: 143, url: "https://github.com/acme/widget/pull/143", body: "Implements export.", headRefOid: "aaaa111", createdAt: at(20) });
  const w = world({ state: STATES.running, pr: null, url: undefined, cursor: { since: T0, fixed_sha: null }, rereview: { at: null, nudged: false }, last: { at: T0, run: "1-start", exit: null, event: "start" } },
    { pr: opened, prsByHead: [opened] });
  w.gh.setBody = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  w.runner.start("start", "/bin/claude", [], { cwd: "/tmp/wt" });
  w.runner.finish(claudeResultLines());
  w.clock.advance(25);

  for (let i = 1; i <= 4; i++) {
    await w.tick.tick();
    assert.deepEqual(w.entry().retry, { op: "PR #143 block write", count: i }, `tick ${i} counts this write, by name`);
    assert.equal(w.entry().state, STATES.running);
    assert.equal(w.entry().pr, null, `tick ${i} still does not claim to watch a PR whose block is missing`);
    assert.deepEqual(w.notify.sent, []);
  }
  await w.tick.tick();
  const e = w.entry();
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "stuck"], "the PR is no longer held open and unwatched in silence");
  assert.match(e.last.event, /PR #143 block write failed 5 ticks in a row/, "and the reason names the write, so the operator knows it is a token permission");
  assert.deepEqual(w.notify.sent, [["needs", 143, "stuck"]], "and the message names the PR the daemon had found, not `?`");
  assert.equal(e.url, "https://github.com/acme/widget/pull/143", "which the operator can click through to");
  assert.equal(e.session, "6f1c2d3e-1111-4111-8111-111111111111", "the session survives the stop, so a register can resume it");
  assert.equal(w.runner.started.length, 1, "nothing was spawned a second time across five ticks of waiting");
});

test("a head change whose ready label will not come off is bounded too, by the same counter", async () => {
  // The third caller of the same declining write. It used to throw out to the per-entry catch, which logs one line to
  // errors.log per tick and notifies nobody, so it was the same unbounded wait wearing a different coat.
  const w = world({ state: STATES.ready, cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null } },
    { pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(5) })] }), commitDates: { d4e5f6a: at(5) } });
  w.gh.removeLabel = async () => { throw new Error("HTTP 502: bad gateway"); };
  w.clock.advance(6);

  const results = await w.tick.tick();
  assert.deepEqual(results.map(r => r.ok), [true], "handled in the tick, not thrown at the per-entry catch");
  assert.deepEqual(w.entry().retry, { op: "ready label removal", count: 1 });
  assert.equal(w.entry().cursor.fixed_sha, "a1b2c3d", "and the new head is not judged while the PR still says a human may merge the old one");

  for (let i = 0; i < 4; i++) await w.tick.tick();
  assert.deepEqual([w.entry().state, w.entry().reason], [STATES.needsHuman, "stuck"]);
  assert.match(w.entry().last.event, /ready label removal failed 5 ticks in a row/);
  assert.deepEqual(w.notify.sent, [["needs", 142, "stuck"]]);
});

test("a review at exactly the cursor second on a head that just moved: headChanged before the verdict is the safe order", async () => {
  // The one question the last audit left open. `headChanged` now runs BEFORE `reviewerVerdict`, and the verdict is
  // handed `entry.cursor.dispatched`, so the worry was an interaction between the two at the one instant where the
  // cursor's inclusive boundary and its dedup list both matter.
  //
  // The answer, driven both ways below: there is no interaction, and the order that exists is the safer of the two.
  // `headChanged` writes `fixed_sha` and `rereview`; it never touches `cursor.since` or `cursor.dispatched`, so the
  // dedup the verdict relies on is exactly what it would have been. And `rereview.at` only ever moves FORWARD through
  // `reviewerClock` (`later(later(pushedAt, floor), previousAsk)`), so running it first can only narrow the verdict's
  // window. Narrowing turns a "clear" into a "waiting", never the reverse, and "waiting" is the answer that waits
  // rather than the answer that marks a PR ready.
  const clear = body => review({ id: 3001, by: BOT, bot: true, state: "COMMENTED", at: at(5), body });

  // 1. The review the loop already dispatched sits at the cursor second and names the new head. It must not also read
  // as the reviewer clearing that head: `dispatched` is what stops it, and the head change does not disturb it.
  const dispatched = world(
    { cursor: { since: at(5), dispatched: ["review:3001"], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null }, rereview: { at: at(5), nudged: false } },
    { pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(6) })] }), reviews: [clear("**Reviewed commit:** `d4e5f6a`")], commitDates: { d4e5f6a: at(6) } });
  dispatched.clock.advance(7);
  await dispatched.tick.tick();
  let e = dispatched.entry();
  assert.equal(e.cursor.fixed_sha, "d4e5f6a", "the head change landed");
  assert.deepEqual(e.cursor.dispatched, ["review:3001"], "and it left the dedup list alone, which is why the verdict is unchanged by it");
  assert.equal(e.cursor.since, at(5), "the event cursor too: only the events step moves that");
  assert.equal(e.state, STATES.prOpen, "a review the loop is already fixing does not clear the head it moved to");
  assert.deepEqual(dispatched.notify.sent, [], "so nobody was told a PR was ready on the strength of feedback still being worked");

  // 2. The same second, but a review that was NOT dispatched and does clear the new head. Under the old order the
  // verdict ran against the OLD reviewer clock, which is earlier, so this review was inside the window and the entry
  // went ready on a head `fixed_sha` had not caught up to. The reset moves the ask to the push, which is after it.
  const fresh = world(
    { cursor: { since: at(5), dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null }, rereview: { at: at(5), nudged: false } },
    { pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS", at: at(6) })] }), reviews: [clear("**Reviewed commit:** `d4e5f6a`")], commitDates: { d4e5f6a: at(6) } });
  fresh.clock.advance(7);
  await fresh.tick.tick();
  e = fresh.entry();
  assert.equal(e.state, STATES.prOpen, "a review stamped before the push it appears to clear is not an answer about this head");
  assert.equal(e.rereview.at, at(6), "because the ask moved to the push, which is one minute after the review");
  assert.equal(e.rereview.nudged, false);
  assert.deepEqual(fresh.notify.sent, []);

  // 3. And the reviewer answering the head it was actually asked about still clears it, on the next tick, so the
  // narrowing is a boundary and not a door that stays shut.
  fresh.gh.data.reviews = [review({ id: 3002, by: BOT, bot: true, state: "COMMENTED", at: at(8), body: "**Reviewed commit:** `d4e5f6a`" })];
  fresh.clock.advance(2);
  await fresh.tick.tick();
  assert.equal(fresh.entry().state, STATES.ready);
  assert.deepEqual(fresh.notify.sent, [["ready", 142]]);
});
