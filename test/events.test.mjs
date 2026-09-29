import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEvents, makeTrust, isGreen, reviewerVerdict, reviewerClock, countRounds, failingChecks, addedLines, hasOwnComment } from "../lib/events.mjs";
import { ROUND_MARKER, NUDGE_MARKER, RESET_MARKER, actor, normalizeLogin } from "../lib/gh.mjs";
import { CONFIG, T0, at, prFixture, review, inline, comment, checkRun, user } from "./helpers.mjs";

const trust = makeTrust(CONFIG, "me");
const entry = { cursor: { since: T0, fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d" } };
const BOT = "chatgpt-codex-connector";
const derive = (over = {}) => deriveEvents({ pr: prFixture(), reviews: [], inline: [], entry, trust, ...over });

test("blocking findings in a reviewer message cannot clear the reviewed head", () => {
  const body = "**Reviewed commit:** `a1b2c3d`\n\n[P1] A required authorization check is missing.";
  for (const asComment of [true, false]) {
    const result = reviewerVerdict({ config: CONFIG, trust, sinceIso: T0, headSha: "a1b2c3d", inline: [],
      comments: asComment ? [comment({ by: BOT, bot: true, at: at(3), body })] : [],
      reviews: asComment ? [] : [review({ by: BOT, bot: true, at: at(3), state: "COMMENTED", body })],
    });
    assert.equal(result.verdict, "blocking");
  }
});

test("logins normalise across REST and GraphQL shapes", () => {
  assert.equal(normalizeLogin("chatgpt-codex-connector[bot]"), "chatgpt-codex-connector");
  assert.equal(normalizeLogin("app/chatgpt-codex-connector"), "chatgpt-codex-connector");
  assert.deepEqual(actor({ login: "x", is_bot: true }), { login: "x", bot: true });
  assert.deepEqual(actor({ user: user("y[bot]", true) }), { login: "y", bot: true });
  assert.ok(trust.isReviewer(actor(user(`${BOT}[bot]`, true))));
  assert.ok(!trust.isReviewer(actor(user(BOT, false))), "a human with the bot's name is not the reviewer");
  assert.ok(trust.isTrusted(actor({ login: "me" })));
  assert.ok(!trust.isTrusted(actor({ login: "me", is_bot: true })));
});

test("reviewer CHANGES_REQUESTED review dispatches with its inline comments", () => {
  const { events } = derive({
    reviews: [review({ id: 2201, by: `${BOT}[bot]`, bot: true, state: "CHANGES_REQUESTED", at: at(5) })],
    inline: [inline({ id: 1, reviewId: 2201, by: `${BOT}[bot]`, bot: true, at: at(5), body: "P1: nonce" })],
  });
  assert.deepEqual(events.map(e => e.kind), ["review", "inline"]);
  assert.equal(events[1].reviewId, 2201);
});

test("reviewer COMMENTED review dispatches only when it has inline comments", () => {
  const r = review({ id: 2202, by: `${BOT}[bot]`, bot: true, state: "COMMENTED", at: at(5) });
  assert.equal(derive({ reviews: [r] }).events.length, 0);
  assert.equal(derive({ reviews: [r], inline: [inline({ id: 2, reviewId: 2202, by: `${BOT}[bot]`, bot: true, at: at(5) })] }).events.length, 2);
});

test("approvals, untrusted authors and own replies never dispatch", () => {
  const { events } = derive({
    reviews: [
      review({ id: 1, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(5) }),
      review({ id: 2, by: "stranger", state: "CHANGES_REQUESTED", at: at(5) }),
    ],
    inline: [
      inline({ id: 10, by: "stranger", at: at(5) }),
      inline({ id: 12, by: "me", at: at(5), reply: 1 }),
    ],
  });
  assert.equal(events.length, 0);
});

test("an edited comment is new when it was created after the cursor, and not when it was only edited after it", () => {
  const fresh = derive({ inline: [inline({ id: 11, by: "me", at: at(5), edited: true })] }).events;
  assert.equal(fresh.length, 1, "editing a new comment before the tick sees it must not hide it");
  const old = derive({ inline: [inline({ id: 11, by: "me", at: at(-5), edited: true })] }).events;
  assert.equal(old.length, 0, "an old comment edited later is not dispatched again");
});

test("trusted human inline comment and CHANGES_REQUESTED dispatch; plain comments do not", () => {
  const { events } = derive({
    reviews: [review({ id: 3, by: "me", state: "CHANGES_REQUESTED", at: at(5) })],
    inline: [inline({ id: 13, by: "me", at: at(6), body: "rename this" })],
    comments: [comment({ id: 50, by: "me", at: at(7), body: "LGTM, merging after lunch" })],
  });
  assert.deepEqual(events.map(e => e.kind), ["review", "inline"]);
});

test("@gallivant fix from a trusted author is a command; own markers, bots and strangers are skipped", () => {
  const { events } = derive({ comments: [
    comment({ id: 60, by: "me", at: at(5), body: "@gallivant fix the flaky test too" }),
    comment({ id: 61, by: "me", at: at(6), body: `@codex review\n\n${ROUND_MARKER}` }),
    comment({ id: 62, by: "me", at: at(7), body: `@codex review\n\n${NUDGE_MARKER}` }),
    comment({ id: 63, by: "stranger", at: at(8), body: "@gallivant fix everything" }),
    comment({ id: 64, by: `${BOT}[bot]`, bot: true, at: at(9), body: "## Codex Review Summary" }),
    comment({ id: 65, by: "me", at: at(10), body: "@gallivant fix this too", edited: true }),
    comment({ id: 66, by: "me", at: at(-10), body: "@gallivant fix the old thing", edited: true }),
  ] });
  assert.deepEqual(events.map(e => [e.kind, e.body]), [["command", "the flaky test too"], ["command", "this too"]]);
});

test("events before the cursor are ignored", () => {
  const { events } = derive({ reviews: [review({ id: 4, by: `${BOT}[bot]`, bot: true, state: "CHANGES_REQUESTED", at: at(-5) })] });
  assert.equal(events.length, 0);
});

test("failed checks dispatch on a head whose failures were not dispatched yet, once per name", () => {
  const rollup = [checkRun({ name: "test", conclusion: "FAILURE" }), checkRun({ name: "test", conclusion: "FAILURE" }), checkRun({ name: "lint", conclusion: "SUCCESS" })];
  assert.equal(derive({ pr: prFixture({ headRefOid: "a1b2c3d", statusCheckRollup: rollup }) }).events.length, 0);
  const { events } = derive({ pr: prFixture({ headRefOid: "d4e5f6a", statusCheckRollup: rollup }) });
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, "9981");
  assert.deepEqual(failingChecks([{ __typename: "StatusContext", context: "ci/x", state: "FAILURE", targetUrl: "u" }]).map(c => c.name), ["ci/x"]);
});

test("green means every check concluded green; no checks is green; pending is not", () => {
  assert.ok(isGreen([]));
  assert.ok(isGreen([checkRun({ name: "a", conclusion: "SUCCESS" }), checkRun({ name: "b", conclusion: "SKIPPED" })]));
  assert.ok(!isGreen([checkRun({ name: "a", conclusion: null, status: "IN_PROGRESS" })]));
  assert.ok(!isGreen([checkRun({ name: "a", conclusion: "FAILURE" })]));
});

test("a verdict the reviewer posts as a comment clears the head, when it names the head", () => {
  // The bug this pins, from a live run. Codex posts FINDINGS as a review, which carries `commit_id`, and a CLEAN
  // verdict as a plain comment, which carries none: "Didn't find any major issues", with the head named in the body as
  // `Reviewed commit: <sha>`. Reading only the reviews API, a passed pull request looked identical to one the reviewer
  // had never answered: the newest review stayed the one from two pushes ago, the head guard said the reviewer had
  // looked at an older commit, and the entry waited out `stall_hours` before stopping as `reviewer-silent`. It reported
  // a silent reviewer that had approved the current head three minutes after being asked.
  const base = { reviews: [], inline: [], config: CONFIG, trust, sinceIso: T0, headSha: "3dc356877e1f" };
  const clean = comment({ id: 9, by: `${BOT}[bot]`, bot: true, at: at(3), body: "Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** `3dc356877e`\n" });
  assert.equal(reviewerVerdict({ ...base, comments: [clean] }).verdict, "clear");

  // The narrowness is the point: clean is never inferred from the absence of findings. A reviewer says other things in
  // comments, and a chatty bot must not be able to clear a pull request by mentioning it.
  const chatty = comment({ id: 10, by: `${BOT}[bot]`, bot: true, at: at(3), body: "Looks great, nice work!" });
  assert.equal(reviewerVerdict({ ...base, comments: [chatty] }).verdict, "waiting", "no commit named, no verdict");

  // And the head guard applies identically to a comment: naming an older commit says nothing about this head.
  const stale = comment({ id: 11, by: `${BOT}[bot]`, bot: true, at: at(3), body: "**Reviewed commit:** `d01e532c3a`" });
  assert.match(reviewerVerdict({ ...base, comments: [stale] }).note, /reviewer looked at d01e532/);

  // A comment from anyone but the configured reviewer is not a verdict at all.
  const impostor = comment({ id: 12, by: "someone", at: at(3), body: "**Reviewed commit:** `3dc356877e`" });
  assert.equal(reviewerVerdict({ ...base, comments: [impostor] }).verdict, "waiting");
});

test("a comment-borne verdict is not paired with another review's inline findings", () => {
  // Inline findings belong to a REVIEW and are matched on its id. A comment's id comes from a different id space, so
  // matching on it could pair a clean verdict with findings that belong to something else entirely.
  const clean = comment({ id: 2, by: `${BOT}[bot]`, bot: true, at: at(3), body: "**Reviewed commit:** `abc1234`" });
  const strayFinding = inline({ id: 1, reviewId: 2, by: BOT, bot: true, at: at(1), body: "P1: from a different review" });
  const v = reviewerVerdict({ reviews: [], inline: [strayFinding], comments: [clean], config: CONFIG, trust, sinceIso: T0, headSha: "abc1234def" });
  assert.equal(v.verdict, "clear", "the id collision does not turn a clean verdict into a blocking one");
});

test("the reviewed-commit pattern is configuration, so a reviewer that is not Codex works too", () => {
  // Same reasoning as `rereview_comment`: this ships configured for Codex and must not be built around it.
  const config = { ...CONFIG, reviewer: { ...CONFIG.reviewer, reviewed_commit_pattern: "reviewed at ([0-9a-f]{7,40})" } };
  const theirs = comment({ id: 13, by: `${BOT}[bot]`, bot: true, at: at(3), body: "All good, reviewed at abc1234def" });
  assert.equal(reviewerVerdict({ reviews: [], inline: [], comments: [theirs], config, trust, sinceIso: T0, headSha: "abc1234def" }).verdict, "clear");

  // Codex's own wording no longer matches once the pattern is theirs, which is the point of it being configurable.
  const codexStyle = comment({ id: 14, by: `${BOT}[bot]`, bot: true, at: at(3), body: "**Reviewed commit:** `abc1234def`" });
  assert.equal(reviewerVerdict({ reviews: [], inline: [], comments: [codexStyle], config, trust, sinceIso: T0, headSha: "abc1234def" }).verdict, "waiting");
});

test("a reviewer configured with no commit pattern cannot clear from a comment, and does not throw", () => {
  // A reviewer that never names a commit leaves this unset. The loop is narrower, not broken: reviews still clear
  // heads through `commit_id`, and a comment simply is not a verdict.
  const config = { ...CONFIG, reviewer: { ...CONFIG.reviewer, reviewed_commit_pattern: "" } };
  const clean = comment({ id: 15, by: `${BOT}[bot]`, bot: true, at: at(3), body: "**Reviewed commit:** `abc1234`" });
  assert.equal(reviewerVerdict({ reviews: [], inline: [], comments: [clean], config, trust, sinceIso: T0, headSha: "abc1234def" }).verdict, "waiting");

  // An unparseable pattern is an answer of null rather than a thrown error, so one bad config value cannot stall a tick.
  const bad = { ...CONFIG, reviewer: { ...CONFIG.reviewer, reviewed_commit_pattern: "([unclosed" } };
  assert.equal(reviewerVerdict({ reviews: [], inline: [], comments: [clean], config: bad, trust, sinceIso: T0, headSha: "abc1234def" }).verdict, "waiting");
});

test("reviewer verdict: waiting, blocking by state, blocking by pattern, clear, none", () => {
  const base = { inline: [], config: CONFIG, trust, sinceIso: T0 };
  assert.equal(reviewerVerdict({ ...base, reviews: [] }).verdict, "waiting");
  assert.equal(reviewerVerdict({ ...base, reviews: [review({ id: 1, by: `${BOT}[bot]`, bot: true, state: "CHANGES_REQUESTED", at: at(1) })] }).verdict, "blocking");
  const commented = review({ id: 2, by: `${BOT}[bot]`, bot: true, state: "COMMENTED", at: at(2) });
  assert.equal(reviewerVerdict({ ...base, reviews: [commented], inline: [inline({ id: 1, reviewId: 2, by: BOT, bot: true, at: at(2), body: "P1: bad" })] }).verdict, "blocking");
  assert.equal(reviewerVerdict({ ...base, reviews: [commented], inline: [inline({ id: 1, reviewId: 2, by: BOT, bot: true, at: at(2), body: "nit: style" })] }).verdict, "clear");
  assert.equal(reviewerVerdict({ ...base, reviews: [review({ id: 3, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(-1) })] }).verdict, "waiting", "reviews before the request do not count");
  assert.equal(reviewerVerdict({ ...base, config: { ...CONFIG, reviewer: null }, reviews: [] }).verdict, "none");
});

test("a Codex review of an older commit does not clear the current head; badge findings block", () => {
  const base = { inline: [], config: CONFIG, trust, sinceIso: T0 };
  const stale = review({ id: 5, by: `${BOT}[bot]`, bot: true, state: "COMMENTED", at: at(2), body: "### 💡 Codex Review\n\n**Reviewed commit:** `ae48478fe6`\n" });
  assert.equal(reviewerVerdict({ ...base, reviews: [stale], headSha: "d4e5f6a7b8c9" }).verdict, "waiting");
  assert.equal(reviewerVerdict({ ...base, reviews: [stale], headSha: "ae48478fe6000" }).verdict, "clear");
  const badge = inline({ id: 1, reviewId: 5, by: BOT, bot: true, at: at(2), body: "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-red?style=flat)</sub></sub>** nonce" });
  assert.equal(reviewerVerdict({ ...base, reviews: [stale], inline: [badge], headSha: "ae48478fe6000" }).verdict, "blocking");
  const p2 = inline({ id: 2, reviewId: 5, by: BOT, bot: true, at: at(2), body: "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>** style" });
  assert.equal(reviewerVerdict({ ...base, reviews: [stale], inline: [p2], headSha: "ae48478fe6000" }).verdict, "clear");
});

test("iteration is the count of our own round comments since the last reset", () => {
  const cs = [
    { user: user("me"), body: `@codex review\n\n${ROUND_MARKER}`, created_at: at(1) },
    { user: user("me"), body: `@codex review\n\n${NUDGE_MARKER}`, created_at: at(2) },
    { user: user("stranger"), body: ROUND_MARKER, created_at: at(3) },
    { user: user("me"), body: `@codex review\n\n${ROUND_MARKER}`, created_at: at(4) },
  ];
  assert.equal(countRounds(cs, "me"), 2);
  const reset = [...cs, { user: user("me"), body: `Watching again from here.\n\n${RESET_MARKER}`, created_at: at(5) }, { user: user("me"), body: `Completion receipt updated.\n\n${ROUND_MARKER}`, created_at: at(6) }];
  assert.equal(countRounds(reset, "me"), 1);
});

test("the output scan sees only added lines, never context or removed text", () => {
  const diff = "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n context TODO\n-removed FIXME\n+added line\n+another";
  assert.equal(addedLines(diff), "added line\nanother");
  assert.equal(addedLines(null), "");
});

test("hasOwnComment finds the daemon's own marked comment after a time and ignores others", () => {
  const list = [
    comment({ id: 1, by: "me", at: at(2), body: `@codex review\n\n${ROUND_MARKER}` }),
    comment({ id: 2, by: "stranger", at: at(3), body: `${NUDGE_MARKER}` }),
  ];
  assert.ok(hasOwnComment(list, "me", ROUND_MARKER, at(1)));
  assert.ok(!hasOwnComment(list, "me", ROUND_MARKER, at(2)), "the cursor is exclusive");
  assert.ok(!hasOwnComment(list, "me", NUDGE_MARKER, at(1)), "someone else's marker is not ours");
});

test("a clear review submitted in the boundary second counts; a stale one and one already dispatched do not", () => {
  // The boundary is `rereview.at`, the second the loop asked for the re-review. A blocking review comes back as an
  // event either way, but a clear one never is dispatched, so a strict comparison excluded it forever and the entry
  // waited until it stopped as `reviewer-silent`.
  const base = { inline: [], config: CONFIG, trust, sinceIso: at(5), headSha: "a1b2c3d" };
  const boundary = review({ id: 9, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(5), body: "**Reviewed commit:** `a1b2c3d`" });
  assert.equal(reviewerVerdict({ ...base, reviews: [boundary] }).verdict, "clear");

  // Inclusivity does not let a review of an older commit clear the head: the reviewed-commit check is the guard.
  const stale = review({ id: 10, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(5), body: "**Reviewed commit:** `9998887`" });
  assert.equal(reviewerVerdict({ ...base, reviews: [stale] }).verdict, "waiting");
  assert.match(reviewerVerdict({ ...base, reviews: [stale] }).note, /reviewer looked at 9998887, head is a1b2c3d/);

  // And a review the daemon already dispatched at exactly that second is not also read as the reviewer clearing it.
  assert.equal(reviewerVerdict({ ...base, reviews: [boundary], dispatched: ["review:9"] }).verdict, "waiting");
  assert.equal(reviewerVerdict({ ...base, reviews: [boundary], dispatched: ["inline:9", "command:9"] }).verdict, "clear",
    "the key is per id space, so an inline comment numbered 9 is not this review");

  // A review before the boundary is still excluded: inclusive means at or after, not "any review ever".
  assert.equal(reviewerVerdict({ ...base, reviews: [review({ id: 11, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(4) })] }).verdict, "waiting");
});


test("the harness's own notes on its own work are not feedback, while the operator's own comments still are", () => {
  // On a one-operator install the operator's login IS the daemon's: config.md says `trusted_authors` is where your own
  // login belongs. So the two capacities have to be told apart by what the comment is, not by who wrote it. The fix
  // prompt asks the harness to reply on each inline thread; a harness that does that with `gh pr review --comment`
  // plus top-level inline notes produced events the next tick dispatched a round to answer.
  const ownReview = review({ id: 900, by: "me", state: "COMMENTED", at: at(5) });
  const attached = derive({
    reviews: [ownReview],
    inline: [inline({ id: 11, reviewId: 900, by: "me", at: at(5), body: "Did this differently because X." }),
      inline({ id: 12, reviewId: 900, by: "me", at: at(5), body: "Left this alone, out of scope." })],
  }).events;
  assert.deepEqual(attached, [], "notes hanging off our own review are the daemon explaining itself");

  const reply = derive({ inline: [inline({ id: 13, by: "me", at: at(5), reply: 1, body: "done" })] }).events;
  assert.deepEqual(reply, [], "and so is a thread reply, which is what the old rule already caught");

  // The channel that must keep working: a person leaving a standalone inline comment on the PR.
  const standalone = derive({ inline: [inline({ id: 14, by: "me", at: at(5), body: "rename this" })] }).events;
  assert.deepEqual(standalone.map(e => [e.kind, e.id]), [["inline", 14]], "the operator's own review comment is the main feedback path");

  // And a note attached to somebody else's review by our login is still feedback: it is not our review.
  const onOthers = derive({
    reviews: [review({ id: 901, by: `${BOT}[bot]`, bot: true, state: "COMMENTED", at: at(4) })],
    inline: [inline({ id: 15, reviewId: 901, by: "me", at: at(5), body: "and this too" })],
  }).events;
  assert.deepEqual(onOthers.map(e => [e.kind, e.id]), [["review", 901], ["inline", 15]],
    "the reviewer's own COMMENTED review with an attached note dispatches as it always did, note included");
});

test("a review that names no commit at all cannot clear a head, rather than clearing whichever head it finds", () => {
  // `reviewed` falsy skipped the head-match guard entirely, so the verdict came out of `newest.state` alone. An absent
  // value read as "nothing to worry about", which is the class the diff fail-open was. `commit_id` is null once the
  // reviewed commit is gone from the repository, which is what a force-push plus garbage collection leaves.
  const base = { inline: [], config: CONFIG, trust, sinceIso: T0 };
  const nameless = review({ id: 20, by: `${BOT}[bot]`, bot: true, state: "APPROVED", at: at(1), body: "Looks good." });
  const v = reviewerVerdict({ ...base, reviews: [nameless], headSha: "a1b2c3d" });
  assert.equal(v.verdict, "waiting");
  assert.match(v.note, /named no commit/);

  // The two ways it can name one both still clear.
  assert.equal(reviewerVerdict({ ...base, reviews: [{ ...nameless, body: "**Reviewed commit:** `a1b2c3d`" }], headSha: "a1b2c3d" }).verdict, "clear");
  assert.equal(reviewerVerdict({ ...base, reviews: [{ ...nameless, commit_id: "a1b2c3d" }], headSha: "a1b2c3d" }).verdict, "clear");
  // A short sha is not a sha: the body pattern needs 7 to 40 hex, which is what GitHub's own short form is.
  assert.equal(reviewerVerdict({ ...base, reviews: [{ ...nameless, body: "**Reviewed commit:** `a1b2c3`" }], headSha: "a1b2c3d" }).verdict, "waiting",
    "a six-character sha does not parse, and an unparsed one is not an answer about this head");
  // A caller with no head to compare against is unchanged: it asked a different question.
  assert.equal(reviewerVerdict({ ...base, reviews: [nameless] }).verdict, "clear");
});

test("the reviewer clock never sets an ask further back than the nudge window, nor before the previous ask", () => {
  // The rule lives here rather than in the tick because the tick is not its only writer: `reconcile` sets the same
  // field on a recovered entry and used to set it raw, which stopped a stale PR as `reviewer-silent` on the first tick
  // after a crash recovery, for silence that accrued while no daemon was running to ask.
  const floorAt = at(600); // ten hours after T0
  const window = CONFIG.rereview_minutes;

  assert.equal(reviewerClock({ config: CONFIG, pushedAt: at(598), floorAt }), at(598), "a recent push is taken literally");
  assert.equal(reviewerClock({ config: CONFIG, pushedAt: T0, floorAt }), at(600 - window), "a commit made ten hours ago is floored to the nudge window, not believed");
  assert.equal(reviewerClock({ config: CONFIG, pushedAt: null, floorAt }), at(600 - window), "and so is no push date at all");
  assert.equal(reviewerClock({ config: CONFIG, pushedAt: T0, previousAsk: at(599), floorAt }), at(599), "never before the previous ask: the reviewer cannot have been asked earlier than it was");
  assert.equal(reviewerClock({ config: CONFIG, pushedAt: "2026-09-24T11:58:00.500Z", floorAt }), at(598), "floored to the second, so it never sorts after a GitHub timestamp in the same second");
});
