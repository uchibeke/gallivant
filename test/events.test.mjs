import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveEvents, makeTrust, isGreen, reviewerVerdict, countRounds, failingChecks, addedLines, hasOwnComment } from "../lib/events.mjs";
import { ROUND_MARKER, NUDGE_MARKER, RESET_MARKER, actor, normalizeLogin } from "../lib/gh.mjs";
import { CONFIG, T0, at, prFixture, review, inline, comment, checkRun, user } from "./helpers.mjs";

const trust = makeTrust(CONFIG, "me");
const entry = { cursor: { since: T0, fixed_sha: "a1b2c3", checks_sha: "a1b2c3" } };
const BOT = "chatgpt-codex-connector";
const derive = (over = {}) => deriveEvents({ pr: prFixture(), reviews: [], inline: [], entry, trust, ...over });

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
  assert.equal(derive({ pr: prFixture({ headRefOid: "a1b2c3", statusCheckRollup: rollup }) }).events.length, 0);
  const { events } = derive({ pr: prFixture({ headRefOid: "d4e5f6", statusCheckRollup: rollup }) });
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
