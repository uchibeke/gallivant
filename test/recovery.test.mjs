// `reconcile` in lib/commands/up.mjs: the boot path that rebuilds the registry from GitHub after state.json is
// lost. Every assertion here is about what the operator gets back, and about what is deliberately not replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../lib/commands/up.mjs";
import { makeState } from "../lib/state.mjs";
import { renderBlock } from "../lib/block.mjs";
import { ROUND_MARKER, RESET_MARKER, NUDGE_MARKER } from "../lib/gh.mjs";
import { CONFIG, T0, at, tempHome, prFixture, comment, silentLog, STATES } from "./helpers.mjs";

const SESSION = "6f1c2d3e-1111-4111-8111-111111111111";

const blockBody = (over = {}) =>
  `Adds export.\n\n${renderBlock({ prd: "docs/prds/widget-export.md", harness: "claude", session: SESSION, branch: "gallivant/widget-export", ...over })}\n`;

const openPr = (over = {}) => prFixture({ number: 142, headRefName: "gallivant/widget-export", body: blockBody(), createdAt: T0, headRefOid: "a1b2c3", ...over });

/** A world for reconcile: one repo in config, whatever PRs and comments the test names, PRD snapshots in memory. */
function world({ prs = [openPr()], comments = [], commitDates = {}, files = {}, snapshots = new Map() } = {}) {
  const home = tempHome();
  const logged = [];
  const log = { info: m => logged.push(["info", m]), warn: m => logged.push(["warn", m]), error: m => logged.push(["error", m]), latest: () => null };
  const ctx = {
    home,
    config: { ...CONFIG, home },
    state: makeState(home),
    log,
    gh: {
      prListMine: async () => prs,
      issueComments: async () => comments,
      commitDate: async (_r, sha) => commitDates[sha] ?? null,
      fileAt: async (_r, path) => files[path] ?? null,
    },
    readPrd: id => snapshots.get(id) ?? null,
    writePrd: (id, text) => snapshots.set(id, text),
  };
  return { ctx, logged, snapshots, id: "acme/widget/widget-export" };
}

test("an open PR of ours with a valid block is adopted with its identity taken from the block and the PR", async () => {
  const w = world();
  const added = await reconcile(w.ctx, "me");

  assert.deepEqual(added, [w.id], "the id is the repo plus the PRD id from the branch");
  const e = w.ctx.state.get(w.id);
  assert.equal(e.state, STATES.prOpen, "a recovered PR is watched, not restarted");
  assert.equal(e.pr, 142);
  assert.equal(e.url, "https://github.com/acme/widget/pull/142");
  assert.equal(e.repo, "acme/widget");
  assert.equal(e.branch, "gallivant/widget-export");
  assert.equal(e.harness, "claude", "the harness comes from the block, so the right CLI resumes");
  assert.equal(e.session, SESSION, "and the session id, so the run resumes rather than starting over");
  assert.equal(e.prd, "docs/prds/widget-export.md");
  assert.equal(e.worktree, `${CONFIG.worktrees}/acme/widget/widget-export`, "the checkout path is derived, and recreated lazily by the tick");
});

test("the recovered iteration is the count of our own round comments since the last reset comment", async () => {
  const w = world({
    comments: [
      comment({ id: 1, by: "me", at: at(1), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 2, by: "me", at: at(2), body: `Watching again from here.\n\n${RESET_MARKER}` }),
      comment({ id: 3, by: "me", at: at(3), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 4, by: "me", at: at(4), body: `@codex review\n\n${NUDGE_MARKER}` }),
      comment({ id: 5, by: "me", at: at(5), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 6, by: "someone-else", at: at(6), body: `@codex review\n\n${ROUND_MARKER}` }),
    ],
  });
  await reconcile(w.ctx, "me");

  assert.equal(w.ctx.state.get(w.id).iteration, 2, "two rounds after the reset: the nudge and another login's comment do not count");
});

test("the recovered cursors sit at the head and the last own comment, so no history is replayed", async () => {
  const w = world({
    comments: [comment({ id: 1, by: "me", at: at(10), body: `@codex review\n\n${ROUND_MARKER}` })],
    commitDates: { a1b2c3: at(4) },
  });
  await reconcile(w.ctx, "me");
  const e = w.ctx.state.get(w.id);

  assert.equal(e.cursor.since, at(10), "the later of the head's commit date and our last comment, so neither is re-read as new");
  assert.deepEqual(e.cursor.dispatched, [], "a fresh boundary has nothing already handled at it");
  assert.equal(e.cursor.checks_sha, "a1b2c3", "the current head's failing checks count as already dispatched, so old red CI is not re-sent");
  assert.equal(e.cursor.fixed_sha, "a1b2c3", "and the head is the push baseline, so nothing reads as a fresh push");
  assert.equal(e.rereview.at, at(10), "the reviewer clock starts from our last comment, not from the PR's creation");
  assert.equal(e.rereview.nudged, false);
});

test("with no comments of ours the cursor falls back to the head's commit date", async () => {
  const w = world({ commitDates: { a1b2c3: at(7) } });
  await reconcile(w.ctx, "me");
  assert.equal(w.ctx.state.get(w.id).cursor.since, at(7));
});

test("when GitHub cannot date the head the cursor falls back to the PR's creation time", async () => {
  const w = world({ prs: [openPr({ createdAt: at(3) })] });
  await reconcile(w.ctx, "me");
  assert.equal(w.ctx.state.get(w.id).cursor.since, at(3));
});

test("a PR whose head is on a fork is ignored: the daemon never pushes to someone else's branch", async () => {
  const w = world({ prs: [openPr({ isCrossRepository: true })] });
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 0);
});

test("a PR on a branch that is not ours is skipped before its body is even parsed", async () => {
  // The branch check comes first, and it has to: the block's own rules only describe `gallivant/*` branches, so a
  // hand-made branch could never carry a block reconcile would accept. `register` is how such a PR joins the loop.
  // Skipping it silently is the point; a warning per foreign PR would bury the ones that are actually broken.
  const w = world({ prs: [openPr({ headRefName: "feature/hand-made", body: blockBody() })] });
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 0);
  assert.deepEqual(w.logged, [], "no warning, because there is nothing wrong with a PR that is simply not ours");
});

test("a PR with a missing or malformed block is ignored and the reason is logged", async () => {
  const cases = [
    ["Adds export.\n", /no block/],
    [`Adds export.\n\n<!-- gallivant\nprd: docs/prds/widget-export.md\nharness: claude\nsession: ${SESSION}\n`, /unterminated block/],
    ["Adds export.\n\n<!-- gallivant\nharness: claude\nsession: none\nbranch: gallivant/widget-export\n-->\n", /missing prd/],
    [blockBody({ harness: "gemini" }), /invalid harness: gemini/],
    [blockBody({ session: "not-a-uuid" }), /invalid session: not-a-uuid/],
    [blockBody({ prd: "../../etc/passwd.md" }), /invalid prd/],
    [blockBody({ branch: "gallivant/other" }), /block branch differs from head/],
  ];
  for (const [body, expected] of cases) {
    const w = world({ prs: [openPr({ body })] });
    assert.deepEqual(await reconcile(w.ctx, "me"), [], `adopted a PR whose block says: ${body.slice(0, 60)}`);
    assert.equal(w.ctx.state.entries().length, 0);
    assert.ok(w.logged.some(([level, m]) => level === "warn" && expected.test(m)), `nothing logged matching ${expected} (got ${JSON.stringify(w.logged)})`);
  }
});

test("a PR already in the registry is left exactly as it is, never adopted a second time", async () => {
  const w = world();
  await reconcile(w.ctx, "me");
  const first = w.ctx.state.get(w.id);

  const added = await reconcile(w.ctx, "me");
  assert.deepEqual(added, [], "the second boot recovers nothing");
  assert.deepEqual(w.ctx.state.get(w.id), first, "and the entry the daemon has been updating is untouched");
  assert.equal(w.ctx.state.entries().length, 1);
});

test("a PR already watched under a different id is recognised by its number, not by the id recovery would pick", async () => {
  // `register` keys an entry off the branch it was given, which need not be the id the branch convention yields.
  // A PR is one entry; finding it by number is what keeps a recovery from opening a second one beside it.
  const w = world();
  w.ctx.state.put("acme/widget/export-by-hand", { repo: "acme/widget", pr: 142, branch: "gallivant/widget-export", state: STATES.prOpen, iteration: 4 });

  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 1, "no second entry for a PR that is already watched");
  assert.equal(w.ctx.state.get("acme/widget/export-by-hand").iteration, 4, "and the round count the daemon has been keeping survives");
});

test("an id already taken by another entry is refused rather than overwriting it", async () => {
  const w = world();
  const other = { ...prFixture(), repo: "acme/widget", pr: 999, state: STATES.prOpen, branch: "gallivant/widget-export" };
  w.ctx.state.put(w.id, other);

  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.get(w.id).pr, 999, "the entry that holds the id keeps it");
  assert.ok(w.logged.some(([level, m]) => level === "warn" && /already in use/.test(m)));
});

test("the PRD snapshot is fetched from the PR branch when the daemon has none", async () => {
  const w = world({ files: { "docs/prds/widget-export.md": "# Widget export\n" } });
  const asked = [];
  w.ctx.gh.fileAt = async (repo, path, ref) => { asked.push([repo, path, ref]); return "# Widget export\n"; };

  await reconcile(w.ctx, "me");
  assert.deepEqual(asked, [["acme/widget", "docs/prds/widget-export.md", "gallivant/widget-export"]], "read at the PR's branch, where the session left it");
  assert.equal(w.snapshots.get(w.id), "# Widget export\n", "the snapshot the completion gate reads is restored");
  assert.ok(w.logged.some(([, m]) => /PRD snapshot taken from the PR branch/.test(m)), "and the log says the session could have edited that copy");
});

test("a snapshot the daemon still has is kept, and the branch is not read", async () => {
  const snapshots = new Map([["acme/widget/widget-export", "# The daemon's own copy\n"]]);
  const w = world({ snapshots, files: { "docs/prds/widget-export.md": "# The branch copy\n" } });
  let asked = 0;
  w.ctx.gh.fileAt = async () => { asked++; return "# The branch copy\n"; };

  await reconcile(w.ctx, "me");
  assert.equal(asked, 0, "the authoritative snapshot is never replaced by the agent-writable copy");
  assert.equal(snapshots.get(w.id), "# The daemon's own copy\n");
});

test("a PRD the PR branch does not have is logged as a skipped completion gate, not silently ignored", async () => {
  const w = world({ files: {} });
  await reconcile(w.ctx, "me");

  assert.equal(w.snapshots.size, 0);
  assert.ok(
    w.logged.some(([level, m]) => level === "warn" && /not found on gallivant\/widget-export; the completion gate is skipped/.test(m)),
    `no warning about the missing snapshot (got ${JSON.stringify(w.logged)})`,
  );
  assert.equal(w.ctx.state.get(w.id).state, STATES.prOpen, "the PR is still watched; only the gate is affected");
});

test("a repo whose PR listing fails is logged and the next repo is still reconciled", async () => {
  const w = world();
  w.ctx.config = { ...w.ctx.config, repos: ["acme/broken", "acme/widget"] };
  w.ctx.gh.prListMine = async repo => { if (repo === "acme/broken") throw new Error("gh: 403"); return [openPr()]; };

  assert.deepEqual(await reconcile(w.ctx, "me"), [w.id]);
  assert.ok(w.logged.some(([level, m]) => level === "warn" && /reconcile acme\/broken: gh: 403/.test(m)));
});
