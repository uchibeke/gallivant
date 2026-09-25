// Fakes for the tick's dependencies. Each records what it was asked so a test can assert on calls, and each is
// controllable so a test can move the world (a review arrives, a run ends, time passes).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { silentLog } from "../lib/log.mjs";
import { DEFAULT_DELIVERABLE } from "../lib/config.mjs";

export const CONFIG = {
  home: "/tmp/gallivant-test-home",
  poll_seconds: 120, max_iterations: 3, checks_grace_minutes: 5, run_timeout_minutes: 30, max_budget_usd: 5, rereview_minutes: 6, stall_hours: 6,
  trusted_authors: ["me"],
  reviewer: { login: "chatgpt-codex-connector[bot]", rereview_comment: "@codex review", blocking_pattern: "\\bP[01]\\b" },
  notify: { ntfy: "https://ntfy.sh/test", email: null },
  deliverable: DEFAULT_DELIVERABLE,
  worktrees: "/tmp/gallivant-test-worktrees",
  github_token_file: null,
  harness: { claude: { bin: "/bin/claude", settings: "/tmp/gallivant-test-home/claude/settings.json" }, codex: { bin: "/bin/codex" } },
  repos: ["acme/widget"],
};

export const T0 = "2026-09-24T02:00:00.000Z";
export const at = (minutesAfter, base = T0) => new Date(Date.parse(base) + minutesAfter * 60_000).toISOString();

export function makeClock(startIso = T0) {
  let t = Date.parse(startIso);
  return { now: () => t, advance: min => { t += min * 60_000; }, set: iso => { t = Date.parse(iso); } };
}

export const tempHome = () => mkdtempSync(join(tmpdir(), "gallivant-test-"));

export const user = (login, bot = false) => ({ login, type: bot ? "Bot" : "User" });
export const author = (login, bot = false) => ({ login, is_bot: bot });

export const review = ({ id, by, bot = false, state = "COMMENTED", at: when, body = "" }) => ({ id, user: user(by, bot), state, submitted_at: when, body });
export const inline = ({ id, reviewId = null, by, bot = false, at: when, path = "src/a.ts", line = 1, body = "fix this", reply = null, edited = false }) =>
  ({ id, pull_request_review_id: reviewId, in_reply_to_id: reply, user: user(by, bot), path, line, body, created_at: when, updated_at: edited ? at(1, when) : when });
export const comment = ({ id, by, bot = false, at: when, body, edited = false }) => ({ id, user: user(by, bot), body, created_at: when, updated_at: edited ? at(1, when) : when });
export const checkRun = ({ name, conclusion, status = "COMPLETED", runId = "9981", at: when = T0 }) =>
  ({ __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/acme/widget/actions/runs/${runId}/job/1`, completedAt: when });

export const prFixture = (over = {}) => ({
  number: 142, url: "https://github.com/acme/widget/pull/142", title: "Widget export", state: "OPEN", isDraft: false, mergeable: "MERGEABLE",
  headRefOid: "a1b2c3", headRefName: "gallivant/widget-export", isCrossRepository: false, author: author("me"), createdAt: T0,
  statusCheckRollup: [], labels: [], body: "Adds export.\n", baseRefName: "main", ...over,
});

export function fakeGh({ pr = prFixture(), reviews = [], inline: inlineComments = [], comments = [], prsByHead = [], commitDates = {}, files = {} } = {}) {
  const calls = [];
  const since = (list, s) => list.filter(c => !s || Date.parse(c.created_at) > Date.parse(s));
  const g = {
    calls,
    data: { pr, reviews, inline: inlineComments, comments, prsByHead, commitDates, files },
    user: async () => "me",
    prView: async () => { calls.push(["prView"]); return g.data.pr; },
    reviews: async () => g.data.reviews,
    inlineComments: async (_r, _n, s) => since(g.data.inline, s),
    issueComments: async (_r, _n, s) => since(g.data.comments, s),
    prListByHead: async () => g.data.prsByHead,
    prListMine: async () => [],
    commitDate: async (_r, sha) => g.data.commitDates[sha] ?? null,
    prDiff: async () => "",
    fileAt: async (_r, path) => g.data.files[path] ?? null,
    ensureLabels: async repo => { calls.push(["ensureLabels", repo]); },
    /** Comments the daemon posts are visible to later reads, as on GitHub. */
    comment: async (repo, n, body) => { calls.push(["comment", n, body]); g.data.comments.push({ id: 9000 + calls.length, user: user("me"), body, created_at: g.now ? g.now() : new Date().toISOString() }); },
    addLabel: async (repo, n, label) => { calls.push(["addLabel", n, label]); },
    removeLabel: async (repo, n, label) => { calls.push(["removeLabel", n, label]); },
    setBody: async (repo, n, body) => { calls.push(["setBody", n, body]); g.data.pr.body = body; },
  };
  return g;
}

/** A runner whose runs never spawn: the test decides when a run ends and what it logged. */
export function fakeRunner(clock) {
  const runs = [];
  let cur = null;
  const r = {
    root: "/tmp/fake-runs",
    started: runs,
    start(name, cmd, args, opts) {
      if (cur && cur.running) throw Object.assign(new Error("busy"), { code: "BUSY" });
      cur = { id: `${runs.length + 1}-${name}`, name, cmd, args, opts, pid: 1, startedAt: clock.now(), exit: null, running: true, lines: [] };
      runs.push(cur);
      return { id: cur.id, pid: 1, startedAt: cur.startedAt };
    },
    current: () => (cur ? { ...cur } : null),
    read: id => (cur?.id === id ? { ...cur } : null),
    lines: id => (cur?.id === id ? cur.lines : []),
    settle: (id, infer) => { if (cur?.id === id && cur.exit === null) { cur.exit = infer(cur.lines); cur.endedAt = clock.now(); } return { ...cur }; },
    kill: id => { if (cur?.id === id) { cur.running = false; cur.exit = 137; cur.killed = true; } return true; },
    history: () => runs.map(x => x.id),
    /** Test control: the current run ends with these log lines. */
    finish(lines, { exit = null } = {}) { cur.running = false; cur.lines = lines; if (exit !== null) cur.exit = exit; },
  };
  return r;
}

export const fakeGit = () => ({ exists: () => true, fromBranch: async ({ path }) => path, create: async () => "/tmp/wt", headSha: async () => "a1b2c3", toplevel: async d => d });

export function fakeNotify() {
  const sent = [];
  return { sent, ready: async ctx => sent.push(["ready", ctx.entry.pr]), needs: async ctx => sent.push(["needs", ctx.entry.pr, ctx.entry.reason]), error: async (cls, fix) => sent.push(["error", cls, fix]) };
}

export const claudeResultLines = ({ ok = true, cost = 0.5, text = "Done." } = {}) => [
  JSON.stringify({ type: "system", subtype: "init", session_id: "6f1c2d3e-1111-4111-8111-111111111111" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  JSON.stringify({ type: "result", is_error: !ok, result: text, total_cost_usd: cost, permission_denials: [] }),
];

export const codexLines = ({ ok = true, text = "Done.", thread = "22222222-2222-4222-8222-222222222222" } = {}) => [
  JSON.stringify({ type: "thread.started", thread_id: thread }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }),
  JSON.stringify(ok ? { type: "turn.completed", usage: {} } : { type: "turn.failed", error: { message: "boom" } }),
];

/** A registry in a temp dir with one pr-open entry, ready for the tick. */
export function seededState(over = {}) {
  const home = tempHome();
  const state = makeState(home);
  const entry = {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, state: STATES.prOpen, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
    cursor: { since: T0, fixed_sha: "a1b2c3" },
    rereview: { at: T0, nudged: false },
    ...over,
  };
  state.put("widget/widget-export", entry);
  return { home, state, id: "widget/widget-export" };
}

export { silentLog, STATES };

/** A PRD that passes every rule of the contract. Tests that need a failing one edit a copy. */
export const GOOD_PRD = `---
status: ready
harness: codex
---

# Widget export to CSV

## Problem

Finance admins reconcile widget spend in a spreadsheet every month. Today they copy rows out of the widget table by hand, which takes an hour and produces transcription errors that show up weeks later in audits. When this ships, one click produces a CSV that matches the table exactly, and the monthly reconciliation drops to minutes.

## User stories

- As a finance admin, I want to export widgets to CSV, so that I can reconcile spend in a spreadsheet.

## Acceptance criteria

- Given a workspace with three widgets, when I click Export, then a CSV with three rows downloads.
- Given an empty workspace, when I click Export,
  then the button is disabled and a hint explains why.

## Verify

- \`npm test\`
\`\`\`sh
npm run lint
\`\`\`

## Where to look

- \`src/export/\`

## Out of scope

- PDF export.
`;
