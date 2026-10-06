// Fakes for the tick's dependencies. Each records what it was asked so a test can assert on calls, and each is
// controllable so a test can move the world (a review arrives, a run ends, time passes).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { silentLog } from "../lib/log.mjs";
import { DEFAULT_DELIVERABLE, DEFAULTS } from "../lib/config.mjs";
import { NO_IDENTITY } from "../lib/identity.mjs";
import { MIN_VERSIONS } from "../lib/harness.mjs";

/** Real executable probes, no installed harness or model calls. Also records which preflight ran first. */
export function harnessBin(dir, harness = "codex", { version = MIN_VERSIONS[harness], signedIn = true, versionExit = 0, signInOutput = null } = {}) {
  const bin = join(dir, `${harness}-stub`);
  const calls = join(dir, `${harness}-calls.jsonl`);
  const source = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log(${JSON.stringify(version)});
  process.exit(${versionExit});
}
if (args[0] === 'mcp' && args[1] === 'list') { console.log('[]'); process.exit(0); }
if (args[0] === 'app-server') {
  const { serveCodexConfig } = await import(${JSON.stringify(new URL("./codex-config-fixture.mjs", import.meta.url).href)});
  serveCodexConfig();
} else {
console.log(${JSON.stringify(signInOutput ?? (harness === "claude" ? JSON.stringify({ loggedIn: signedIn }) : "login status"))});
process.exit(${signedIn ? 0 : 1});
}
`;
  // .mjs makes this independent of the temporary directory's package scope.
  writeFileSync(`${bin}.mjs`, source, { mode: 0o755 });
  return `${bin}.mjs`;
}

export const CONFIG = {
  home: "/tmp/gallivant-test-home",
  poll_seconds: 120, max_iterations: 3, checks_grace_minutes: 5, run_timeout_minutes: 30, max_budget_usd: 5, rereview_minutes: 6, stall_hours: 6,
  trusted_authors: ["me"],
  // Derived from DEFAULTS rather than copied, so a new reviewer key cannot be absent here and quietly change what every
  // test exercises. The hand-written copy lacked `reviewed_commit_pattern` the moment it was added, and three existing
  // tests started failing for a reason that had nothing to do with their subject.
  reviewer: { ...DEFAULTS.reviewer },
  notify: { ntfy: "https://ntfy.sh/test", email: null },
  deliverable: DEFAULT_DELIVERABLE,
  worktrees: "/tmp/gallivant-test-worktrees",
  github_token_file: null,
  harness: {
    claude: { bin: "/bin/claude", settings: "/tmp/gallivant-test-home/claude/settings.json" }, codex: { bin: "/bin/codex" },
    gemini: { bin: "/bin/gemini" }, opencode: { bin: "/bin/opencode" }, goose: { bin: "/bin/goose" },
  },
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
  headRefOid: "a1b2c3d", headRefName: "gallivant/widget-export", isCrossRepository: false, author: author("me"), createdAt: T0,
  statusCheckRollup: [], labels: [], body: "Adds export.\n", baseRefName: "main", ...over,
});

export function fakeGh({ pr = prFixture(), reviews = [], inline: inlineComments = [], comments = [], prsByHead = [], commitDates = {}, files = {} } = {}) {
  const calls = [];
  // GitHub's `since` filter is inclusive of the boundary second, so the fake is too; anything else would hide the
  // equal-timestamp case the cursor's dedup exists for.
  const since = (list, s) => list.filter(c => !s || Date.parse(c.created_at) >= Date.parse(s));
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
    /** Every branch exists unless a test says otherwise, so the base check at `start` is not a thing every test has to arm. */
    branchExists: async (repo, branch) => { calls.push(["branchExists", repo, branch]); return g.branches ? g.branches.includes(branch) : true; },
    repoDefaultBranch: async () => "main",
    /** Comments the daemon posts are visible to later reads, as on GitHub. */
    comment: async (repo, n, body) => { calls.push(["comment", n, body]); g.data.comments.push({ id: 9000 + calls.length, user: user("me"), body, created_at: g.now ? g.now() : new Date().toISOString() }); },
    addLabel: async (repo, n, label) => { calls.push(["addLabel", n, label]); },
    removeLabel: async (repo, n, label) => { calls.push(["removeLabel", n, label]); },
    setBody: async (repo, n, body) => { calls.push(["setBody", n, body]); g.data.pr.body = body; },
    markReady: async (_repo, n) => { calls.push(["markReady", n]); g.data.pr.isDraft = false; },
    setRecoveryMetadata: async (repo, n, identity, { taskId } = {}) => {
      const { normalizePublicBody } = await import("../lib/block.mjs");
      const source = (await g.prListByHead(repo, identity.branch)).find(p => p.number === n) ?? g.data.pr;
      const body = normalizePublicBody(source.body, { identity, taskId });
      if (body !== source.body) await g.setBody(repo, n, body);
      source.body = body;
      return { ...source, body };
    },
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
    // `why` reads it to print the run directory, so the fake answers it rather than throwing: a test that drives the
    // tick and then asks `why` what the operator would see should not have to swap in a real runner to get that far.
    dirOf: id => `/tmp/fake-runs/${id}`,
    /** Test control: the current run ends with these log lines. */
    finish(lines, { exit = null } = {}) { cur.running = false; cur.lines = lines; if (exit !== null) cur.exit = exit; },
  };
  return r;
}

/**
 * `mergeBase` answers "nothing to bring in", which is what an up-to-date branch looks like. A test that wants the merge
 * to happen, or to conflict, overrides it; everything else gets the no-op and behaves exactly as it did before the base
 * merge existed.
 *
 * `dirty` answers "clean", the same way `unpushed` answers "nothing stranded": the default world is one where a kill
 * loses nothing, so a test that wants the uncommitted case says so by overriding it.
 */
export const fakeGit = () => ({ exists: () => true, fromBranch: async ({ path }) => path, create: async () => "/tmp/wt", headSha: async () => "a1b2c3d", toplevel: async d => d, unpushed: async () => [], dirty: async () => ({ modified: 0, untracked: 0 }), originOf: async () => "https://github.com/acme/widget.git", mergeBase: async (_dir, base) => ({ merged: false, base }) });

/**
 * The credential a test world resolves. A run now refuses to spawn without one, which is the defect being fixed, so
 * every world states which it has rather than falling through to the machine's own `gh`: a suite that resolved a real
 * credential would pass on a logged-in laptop and fail on a clean checkout or in CI with an empty HOME.
 *
 * Never anything token-shaped. `fakeCredential(null)` is the refusal, for the tests that assert on it.
 */
export const fakeCredential = (token = "t-for-test") => async ({ host = "github.com" } = {}) =>
  (token ? { token, source: "github_token_file", host }
    : { token: null, source: null, host, why: "No GitHub credential could be resolved, so a run would do the work and then fail to push.\nNothing was started." });

/**
 * The git identity a test world's runs commit as. Always provided, for the same reason `fakeCredential` always is: a run
 * refuses to spawn without one, so a suite that fell through to the machine's own `git config` would pass on a developer
 * laptop and fail in a container or under an empty HOME, and the failure would look like the feature under test.
 */
export const fakeIdentity = ({ name = "Test Operator", email = "operator@example.test" } = {}) =>
  async () => (name && email ? { name, email } : { name: null, email: null, why: NO_IDENTITY });

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

// The three fixtures below are trimmed from real runs captured on 2026-09-25, so the field names are the CLIs'
// own and not a guess. `stats`/`tokens` blocks are dropped where the adapter does not read them.

export const geminiLines = ({ ok = true, text = "Done.", session = "f2abfca4-05e6-46a0-ab2c-e411ceb3ca07" } = {}) => [
  JSON.stringify({ type: "init", timestamp: T0, session_id: session, model: "auto" }),
  JSON.stringify({ type: "message", timestamp: T0, role: "user", content: "go" }),
  JSON.stringify({ type: "message", timestamp: T0, role: "assistant", content: text, delta: true }),
  JSON.stringify(ok ? { type: "result", timestamp: T0, status: "success", stats: { total_tokens: 11297 } }
    : { type: "result", timestamp: T0, status: "error", error: { message: "quota exhausted" } }),
];

export const opencodeLines = ({ ok = true, text = "Done.", session = "ses_f25fcd907ffesl1i92jsR2lh9I", cost = 0.0016 } = {}) => [
  JSON.stringify({ type: "step_start", sessionID: session, part: { type: "step-start", sessionID: session } }),
  JSON.stringify({ type: "text", sessionID: session, part: { type: "text", text, sessionID: session } }),
  JSON.stringify({ type: "step_finish", sessionID: session, part: { type: "step-finish", reason: ok ? "stop" : "aborted", cost, sessionID: session } }),
];

/** goose splits one assistant reply across several `message` events, so the fixture does too. */
export const gooseLines = ({ ok = true, chunks = ["Do", "ne."], cost = 0.0036 } = {}) => [
  ...chunks.map(c => JSON.stringify({ type: "message", message: { id: "3a596abb", role: "assistant", content: [{ type: "text", text: c }] } })),
  ...(ok ? [] : [JSON.stringify({ type: "error", error: { message: "provider refused" } })]),
  JSON.stringify({ type: "complete", total_tokens: 8368, cost_usd: cost }),
];

/** A registry in a temp dir with one pr-open entry, ready for the tick. */
export function seededState(over = {}) {
  const home = tempHome();
  const state = makeState(home);
  const entry = {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, state: STATES.prOpen, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
    base: "main",
    cursor: { since: T0, fixed_sha: "a1b2c3d" },
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
