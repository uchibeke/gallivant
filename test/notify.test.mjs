// Notifications: the error throttle in lib/notify.mjs against a real throttle file, and the budget the loop spends
// over a night of activity. The claim being pinned is that a phone buzzes about once per transition per entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeNotifier, messages } from "../lib/notify.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { readJson } from "../lib/fs.mjs";
import { NEEDS_LABEL } from "../lib/gh.mjs";
import { CONFIG, T0, at, tempHome, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, prFixture, review, checkRun, claudeResultLines, silentLog } from "./helpers.mjs";

const BOT = "chatgpt-codex-connector[bot]";

/** A notifier whose POSTs are recorded rather than sent, over a real home so the throttle file is real. */
function notifier({ home = tempHome(), clock = makeClock(), ok = true } = {}) {
  const posts = [];
  const logged = [];
  const fetch = async (url, opts) => { posts.push({ url, headers: opts.headers, body: opts.body }); return { ok, status: ok ? 200 : 503 }; };
  const log = { info: m => logged.push(["info", m]), warn: m => logged.push(["warn", m]), error: m => logged.push(["error", m]), latest: () => null };
  return { n: makeNotifier({ config: { ...CONFIG, home }, fetch, clock, log }), posts, logged, home, clock };
}

test("one error class sends once and is then silent for six hours", async () => {
  const w = notifier();
  assert.equal(await w.n.error("gh not ready", "gh auth login"), true);
  assert.equal(await w.n.error("gh not ready", "gh auth login"), false, "the second call inside the window sends nothing");
  w.clock.advance(5 * 60 + 59);
  assert.equal(await w.n.error("gh not ready", "gh auth login"), false, "one minute short of six hours is still inside the window");
  w.clock.advance(2);
  assert.equal(await w.n.error("gh not ready", "gh auth login"), true, "past six hours it sends again");

  assert.equal(w.posts.length, 2);
});

test("the throttle is per class, so a second kind of failure is never hidden behind the first", async () => {
  const w = notifier();
  await w.n.error("gh not ready", "gh auth login");
  await w.n.error("claude not ready", "claude auth login");
  await w.n.error("gh not ready", "gh auth login");

  assert.deepEqual(w.posts.map(p => p.headers.Title), ["gallivant: gh not ready", "gallivant: claude not ready"]);
});

test("a throttled error is still logged every time, so the record is complete even when the phone is quiet", async () => {
  const w = notifier();
  await w.n.error("gh not ready", "gh auth login");
  await w.n.error("gh not ready", "gh auth login");

  assert.deepEqual(w.logged.filter(([level]) => level === "error").map(([, m]) => m), ["gh not ready: gh auth login", "gh not ready: gh auth login"]);
});

test("the throttle lives in a file, so a restarted daemon does not resend what the last one already sent", async () => {
  const home = tempHome();
  const clock = makeClock();
  const first = notifier({ home, clock });
  await first.n.error("gh not ready", "gh auth login");
  assert.deepEqual(Object.keys(readJson(join(home, "notify-throttle.json"), {})), ["gh not ready"]);

  const second = notifier({ home, clock });
  assert.equal(await second.n.error("gh not ready", "gh auth login"), false, "a fresh notifier reads the window the old one recorded");
  assert.equal(second.posts.length, 0);
});

test("a send that ntfy refuses is reported false and logged, and the throttle still holds", async () => {
  const w = notifier({ ok: false });
  assert.equal(await w.n.error("gh not ready", "gh auth login"), false);
  assert.ok(w.logged.some(([level, m]) => level === "error" && /notify failed: ntfy 503/.test(m)));
});

test("a transition message carries the PR link and no diff or comment text", () => {
  const entry = { repo: "acme/widget", pr: 142, iteration: 2, url: "https://github.com/acme/widget/pull/142", reason: "no-push" };
  const ready = messages.ready({ entry, max: 3, checks: 4, reviewerNote: "no blocking findings" });
  assert.equal(ready.title, "widget#142 ready for a human");
  assert.equal(ready.body, "Round 2/3. Reviewer: no blocking findings. Checks green (4).");
  assert.equal(ready.click, entry.url);

  const needs = messages.needs({ entry, max: 3, handle: "widget#142" });
  assert.equal(needs.title, "widget#142 needs you: no-push");
  assert.equal(needs.body, "Stopped in round 2/3. gallivant why widget#142");
  assert.equal(needs.priority, "high");
});

// The budget. Four entries transition in one tick; the spec's claim is one notification per transition per entry.

const seed = (id, over = {}) => [id, {
  ...newEntry({ prd: `docs/prds/${id.split("/").pop()}.md`, harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: `gallivant/${id.split("/").pop()}`, worktree: "/tmp/wt", pr: over.pr, url: `https://github.com/acme/widget/pull/${over.pr}`, state: STATES.prOpen, nowIso: T0 }),
  cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3", checks_sha: "a1b2c3", receipt_hash: null },
  rereview: { at: T0, nudged: false },
  ...over,
}];

/** Four entries, each with its own gh view and its own runner, ticked together. */
function night() {
  const home = tempHome();
  const state = makeState(home);
  const clock = makeClock();
  const notify = fakeNotify();
  const runners = new Map();
  const views = new Map();
  const ghFor = id => views.get(id);
  const gh = {
    user: async () => "me",
    prView: async (_r, pr) => ghFor(byPr(pr)).pr,
    reviews: async (_r, pr) => ghFor(byPr(pr)).reviews,
    inlineComments: async (_r, pr) => ghFor(byPr(pr)).inline,
    issueComments: async (_r, pr) => ghFor(byPr(pr)).comments,
    prListByHead: async () => [],
    commitDate: async () => null,
    prDiff: async () => "",
    fileAt: async () => null,
    comment: async () => {},
    addLabel: async (_r, pr, label) => { labels.push([pr, label]); },
    removeLabel: async () => {},
    setBody: async () => {},
  };
  const labels = [];
  const prToId = new Map();
  const byPr = pr => prToId.get(pr);
  const add = (id, over, view) => {
    const [key, entry] = seed(id, over);
    state.put(key, entry);
    prToId.set(over.pr, key);
    views.set(key, { pr: prFixture({ number: over.pr, ...view.pr }), reviews: view.reviews ?? [], inline: view.inline ?? [], comments: view.comments ?? [] });
    runners.set(key, fakeRunner(clock));
    return key;
  };
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify, log: silentLog, clock, ownLogin: "me", runnerFor: id => runners.get(id), readPrd: () => null });
  return { state, clock, notify, tick, add, labels, runners, views };
}

test("four entries each transitioning once in a single tick produce exactly four notifications", async () => {
  const w = night();
  // Ready: green checks and a reviewer that cleared the head.
  w.add("acme/widget/a", { pr: 201 }, {
    pr: { headRefOid: "a1b2c3", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] },
    reviews: [review({ id: 1, by: BOT, bot: true, state: "COMMENTED", at: at(3), body: "**Reviewed commit:** `a1b2c3`" })],
  });
  // Conflict.
  w.add("acme/widget/b", { pr: 202 }, { pr: { headRefOid: "a1b2c3", mergeable: "CONFLICTING" } });
  // The round budget is spent, and a review arrives.
  w.add("acme/widget/c", { pr: 203, iteration: 3 }, {
    pr: { headRefOid: "a1b2c3" },
    reviews: [review({ id: 2, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })],
  });
  // The reviewer has said nothing for longer than stall_hours.
  w.add("acme/widget/d", { pr: 204, rereview: { at: at(-7 * 60), nudged: true } }, { pr: { headRefOid: "a1b2c3" } });

  w.clock.advance(4);
  const results = await w.tick.tick();
  assert.deepEqual(results.map(r => r.ok), [true, true, true, true]);

  assert.equal(w.notify.sent.length, 4, `one per transition, got ${JSON.stringify(w.notify.sent)}`);
  assert.deepEqual(w.notify.sent.map(s => [s[0], s[1], s[2]].filter(x => x !== undefined)).sort(), [
    ["needs", 202, "conflict"], ["needs", 203, "iterations"], ["needs", 204, "reviewer-silent"], ["ready", 201],
  ].sort());
  assert.deepEqual(new Set(w.notify.sent.map(s => s[1])).size, 4, "no entry notified for another entry's transition");
});

test("a second tick over the same four entries adds no notifications: a transition buzzes once, not every poll", async () => {
  const w = night();
  w.add("acme/widget/a", { pr: 201 }, {
    pr: { headRefOid: "a1b2c3", statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] },
    reviews: [review({ id: 1, by: BOT, bot: true, state: "COMMENTED", at: at(3), body: "**Reviewed commit:** `a1b2c3`" })],
  });
  w.add("acme/widget/b", { pr: 202 }, { pr: { headRefOid: "a1b2c3", mergeable: "CONFLICTING" } });
  w.add("acme/widget/c", { pr: 203, iteration: 3 }, { pr: { headRefOid: "a1b2c3" }, reviews: [review({ id: 2, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })] });
  w.add("acme/widget/d", { pr: 204, rereview: { at: at(-7 * 60), nudged: true } }, { pr: { headRefOid: "a1b2c3" } });

  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 4);

  w.clock.advance(4);
  await w.tick.tick();
  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 4, "three ticks, four transitions, four messages");
});

test("an entry that runs a fix round to completion and then stops notifies once, at the stop", async () => {
  const w = night();
  const id = w.add("acme/widget/a", { pr: 201 }, { pr: { headRefOid: "a1b2c3" }, reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })] });

  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.notify.sent.length, 0, "dispatching a fix is not something a person needs to be told");

  w.runners.get(id).finish(claudeResultLines({ ok: true }));
  await w.tick.tick();
  assert.deepEqual(w.notify.sent, [["needs", 201, "no-push"]], "one message, when the loop gave up");
});

test("the entry that hit the round cap is labelled needs-human on GitHub as well as notified", async () => {
  const w = night();
  w.add("acme/widget/c", { pr: 203, iteration: 3 }, { pr: { headRefOid: "a1b2c3" }, reviews: [review({ id: 2, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(3) })] });

  w.clock.advance(4);
  await w.tick.tick();
  assert.deepEqual(w.labels, [[203, NEEDS_LABEL]], "the label is how the PR itself says a person is needed");
  assert.equal(w.notify.sent.length, 1);
});
