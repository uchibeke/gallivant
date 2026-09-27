// `start` and `register` against fakes: the filesystem is real (a temp dir), git and gh are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, existsSync } from "node:fs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { parseBlock } from "../lib/block.mjs";
import { isAtOrAfter, floorSecond } from "../lib/time.mjs";
import { templatePath } from "../lib/fs.mjs";
import { CONFIG, T0, tempHome, prFixture, fakeRunner, makeClock, silentLog, GOOD_PRD } from "./helpers.mjs";
import { newPrd } from "../lib/commands/new.mjs";
import { check } from "../lib/prd.mjs";
import { request as prdRequest } from "../lib/sources/prd.mjs";

/** A `bin` that exits 0, so `checkSignIn` for codex passes without a real harness installed. */
function signedInBin(dir) {
  const bin = join(dir, "codex-stub");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
  chmodSync(bin, 0o755);
  return bin;
}

/** The same for claude, whose sign-in check reads `loggedIn` out of `claude auth status` rather than the exit code. */
function signedInClaudeBin(dir) {
  const bin = join(dir, "claude-stub");
  writeFileSync(bin, '#!/bin/sh\necho \'{"loggedIn": true}\'\nexit 0\n');
  chmodSync(bin, 0o755);
  return bin;
}

/** The operator's own checkout, with the PRD written where `gallivant start` is run against it. */
function operatorRepo(root, rel = "docs/prds/widget-export.md") {
  mkdirSync(join(root, "docs", "prds"), { recursive: true });
  writeFileSync(join(root, rel), GOOD_PRD);
  return join(root, rel);
}

function startWorld() {
  const home = tempHome();
  const repoDir = join(home, "operator-repo");
  const worktree = join(home, "worktrees", "acme", "widget", "widget-export");
  mkdirSync(worktree, { recursive: true });
  const prdPath = operatorRepo(repoDir);
  const clock = makeClock();
  const snapshots = new Map();
  const ctx = {
    home,
    config: { ...CONFIG, home, worktrees: join(home, "worktrees"), harness: { ...CONFIG.harness, codex: { bin: signedInBin(home) } } },
    state: makeState(home),
    log: silentLog,
    gh: { repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }), ensureLabels: async () => {} },
    git: { toplevel: async () => repoDir, create: async () => worktree },
    runnerFor: () => fakeRunner(clock),
    writePrd: (id, text) => snapshots.set(id, text),
  };
  return { ctx, prdPath, worktree, snapshots, home };
}

test("start writes the PRD into the fresh checkout, so the branch carries the brief the PR block points at", async () => {
  const w = startWorld();
  const r = await start(w.ctx, { path: w.prdPath });

  const copied = join(w.worktree, "docs/prds/widget-export.md");
  assert.equal(readFileSync(copied, "utf8"), GOOD_PRD, "the checkout copy is the PRD text, at the path the block records");
  assert.equal(w.ctx.state.get(r.id).prd, "docs/prds/widget-export.md");
  assert.equal(w.snapshots.get(r.id), GOOD_PRD, "the daemon keeps its own snapshot as the authoritative copy");
  assert.equal(statSync(join(w.worktree, "docs", "prds")).mode & 0o777, 0o755, "the directory git will commit is not private to the daemon");
});

test("start renders the resolved read-only directories into the run, and refuses a harness that cannot grant them", async () => {
  const extra = tempHome();
  // codex, which cannot grant read on one directory, is refused before anything is recorded.
  const cx = startWorld();
  cx.ctx.config = { ...cx.ctx.config, context_paths: [extra] };
  await assert.rejects(() => start(cx.ctx, { path: cx.prdPath }), /refusing to run codex with context_paths/);

  // claude, which can, gets one --add-dir per resolved path, config list first then the brief's own.
  const w = startWorld();
  const fromPrd = tempHome();
  writeFileSync(w.prdPath, GOOD_PRD.replace("harness: codex", `harness: claude\ncontext_paths: ${fromPrd}`));
  w.ctx.config = { ...w.ctx.config, context_paths: [extra], harness: { claude: { bin: signedInClaudeBin(w.home), settings: join(w.home, "claude", "settings.json") } } };
  const runner = fakeRunner(makeClock());
  w.ctx.runnerFor = () => runner;
  await start(w.ctx, { path: w.prdPath });
  const args = runner.started[0].args;
  assert.deepEqual(args.filter((a, i) => args[i - 1] === "--add-dir"), [extra, fromPrd], "the config list first, then the brief's own addition");

  // A brief asking for the home directory is refused by name, and nothing is recorded.
  const bad = startWorld();
  writeFileSync(bad.prdPath, GOOD_PRD.replace("harness: codex", "harness: claude\ncontext_paths: ~"));
  bad.ctx.config = { ...bad.ctx.config, harness: { claude: { bin: signedInClaudeBin(bad.home), settings: "/s.json" } } };
  await assert.rejects(() => start(bad.ctx, { path: bad.prdPath }), /frontmatter context_paths: "~" is your home directory/);
  assert.deepEqual(Object.keys(bad.ctx.state.entries()), [], "a refused brief leaves no entry behind");
});

test("start follows the repo, base branch and relative path the request names", async () => {
  // Step B moved the repo off `start` and onto the Request. This does not catch a regression the pre-change code
  // would have failed: the old `start` called git.toplevel then gh.repoInfo itself and got the same answers, so
  // from outside the two are indistinguishable. What it does pin down is that start now consumes those three
  // fields rather than recomputing them, so a source that fills them in differently is honoured. The failing-
  // pre-change proof for the source's half of the contract is in sources.test.mjs.
  const w = startWorld();
  const elsewhere = join(w.home, "unrelated-checkout");
  mkdirSync(elsewhere, { recursive: true });
  w.ctx.git.toplevel = async () => elsewhere;
  w.ctx.gh.repoInfo = async () => ({ nameWithOwner: "acme/other", defaultBranch: "trunk" });
  const created = [];
  w.ctx.git.create = async spec => { created.push(spec); return w.worktree; };

  const r = await start(w.ctx, { path: w.prdPath });
  assert.equal(r.id, "acme/other/widget-export", "the id is keyed by the repo the request named");
  assert.equal(w.ctx.state.get(r.id).repo, "acme/other");
  assert.deepEqual(created, [{ nameWithOwner: "acme/other", prdId: "widget-export", defaultBranch: "trunk" }], "the clone and the base branch follow the request");
  assert.equal(w.ctx.state.get(r.id).prd, relative(elsewhere, w.prdPath), "and the brief's path is relative to that checkout");
});

test("a PRD outside a git checkout stops at the source, with git's own message and nothing recorded", async () => {
  const w = startWorld();
  await assert.rejects(() => start({ ...w.ctx, git: { ...w.ctx.git, toplevel: async () => { throw new Error("not a git repository"); } } }, { path: w.prdPath }), /not a git repository/);
  assert.equal(w.ctx.state.entries().length, 0, "nothing is recorded when the repository cannot be named");
});

test("start puts the PRD wherever the operator keeps it, including a path the fresh clone has no directory for", async () => {
  const w = startWorld();
  // A second PRD in a nested folder that the default branch does not have at all.
  const nested = join(w.home, "operator-repo", "docs", "prds", "widget-export.md");
  const deep = join(w.home, "operator-repo", "team", "docs", "prds", "widget-export.md");
  mkdirSync(join(w.home, "operator-repo", "team", "docs", "prds"), { recursive: true });
  writeFileSync(deep, readFileSync(nested, "utf8"));

  await start(w.ctx, { path: deep });
  assert.equal(readFileSync(join(w.worktree, "team/docs/prds/widget-export.md"), "utf8"), GOOD_PRD);
});

/** A git fake that answers for one directory and reports whatever the test sets. */
const registerGit = ({ origin = "https://github.com/acme/widget.git", branch = "gallivant/widget-export", exists = true } = {}) => ({
  exists: () => exists,
  originOf: async () => { if (origin instanceof Error) throw origin; return origin; },
  currentBranch: async () => { if (branch instanceof Error) throw branch; return branch; },
  fromBranch: async ({ path }) => path,
});

function registerWorld(git, { files = {}, snapshots = new Map() } = {}) {
  const home = tempHome();
  const pr = prFixture({ headRefName: "gallivant/widget-export", body: "Adds export.\n", createdAt: T0 });
  const calls = [];
  const logged = [];
  const ctx = {
    home,
    config: { ...CONFIG, home, worktrees: join(home, "worktrees") },
    state: makeState(home),
    log: { info: m => logged.push(m), warn: m => logged.push(m), error: m => logged.push(m), latest: () => null },
    git,
    gh: {
      prView: async () => pr,
      setBody: async (_r, _n, body) => { calls.push(["setBody", body]); },
      comment: async () => { calls.push(["comment"]); },
      ensureLabels: async () => {},
      fileAt: async (_r, path, ref) => { calls.push(["fileAt", path, ref]); return files[path] ?? null; },
    },
    readPrd: id => snapshots.get(id) ?? null,
    writePrd: (id, text) => snapshots.set(id, text),
  };
  return { ctx, calls, logged, snapshots, url: pr.url };
}

test("an explicitly supplied --worktree is accepted only when it is the same repo on the PR's branch", async () => {
  const w = registerWorld(registerGit());
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  assert.equal(r.worktree, "/checkouts/widget", "a verified path is stored as given, never relocated or re-cloned");
  assert.equal(w.ctx.state.get(r.id).worktree, "/checkouts/widget");
});

test("a --worktree pointing at another repository, another branch, or nothing at all is refused", async () => {
  const cases = [
    [registerGit({ origin: "https://github.com/acme/other.git" }), /is a clone of https:\/\/github\.com\/acme\/other\.git, not acme\/widget/],
    // The fork-suffix case: a substring check would have accepted this one.
    [registerGit({ origin: "https://github.com/acme/widget-fork.git" }), /is a clone of .*widget-fork.*, not acme\/widget/],
    [registerGit({ branch: "main" }), /is on main, not the PR's branch gallivant\/widget-export/],
    [registerGit({ exists: false }), /is not a git checkout/],
    [registerGit({ origin: new Error("no such remote") }), /has no origin remote/],
    [registerGit({ branch: new Error("not a repository") }), /cannot read the checked-out branch/],
  ];
  for (const [git, expected] of cases) {
    const w = registerWorld(git);
    await assert.rejects(() => register(w.ctx, { url: w.url, worktree: "/checkouts/wrong" }), expected);
    assert.equal(w.ctx.state.entries().length, 0, "nothing is recorded for a worktree that failed the check");
  }
});

test("register without --worktree clones from the branch as before, with no checkout to verify", async () => {
  let verified = false;
  const git = { ...registerGit(), originOf: async () => { verified = true; return ""; } };
  const w = registerWorld(git);
  const r = await register(w.ctx, { url: w.url });
  assert.equal(verified, false, "the path register chose itself needs no verification");
  assert.match(r.worktree, /worktrees\/acme\/widget\/widget-export$/);
});

test("a relative --worktree is resolved against the calling directory before it is checked or stored", async () => {
  // `register` runs wherever the operator happens to be; the daemon that reads the entry back runs somewhere else.
  const seen = [];
  const git = { ...registerGit(), originOf: async dir => { seen.push(dir); return "https://github.com/acme/widget.git"; }, currentBranch: async dir => { seen.push(dir); return "gallivant/widget-export"; } };
  const w = registerWorld(git);
  const cwd = process.cwd();
  const r = await register(w.ctx, { url: w.url, worktree: "." });

  assert.equal(r.worktree, cwd, "the path returned is absolute");
  assert.equal(w.ctx.state.get(r.id).worktree, cwd, "and the registry holds the absolute path, not the `.` that was typed");
  assert.deepEqual(new Set(seen), new Set([cwd]), "validation ran against the resolved path, never the relative one");
});

const BLOCK = ({ harness = "claude", session = "6f1c2d3e-1111-4111-8111-111111111111" } = {}) =>
  `Adds export.\n\n<!-- gallivant\nprd: docs/prds/widget-export.md\nharness: ${harness}\nsession: ${session}\nbranch: gallivant/widget-export\n-->\n`;

test("registering with a new --harness or --session rewrites the block, so recovery from GitHub restores the new identity", async () => {
  for (const [over, expected] of [
    [{ harness: "codex" }, /harness: codex[\s\S]*session: 6f1c2d3e-1111-4111-8111-111111111111/],
    [{ session: "aaaaaaaa-2222-4222-8222-222222222222" }, /harness: claude[\s\S]*session: aaaaaaaa-2222-4222-8222-222222222222/],
  ]) {
    const w = registerWorld(registerGit());
    w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
    await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", ...over });

    const written = w.calls.filter(c => c[0] === "setBody");
    assert.equal(written.length, 1, "the stale block is rewritten once");
    assert.match(written[0][1], expected);
    assert.match(written[0][1], /prd: docs\/prds\/widget-export\.md/, "the PRD path the block already recorded is kept");
  }
});

test("a --harness change drops an inherited session the new harness cannot mean, and says so", async () => {
  // `--session` is validated against the chosen harness. An INHERITED one was not: `--harness opencode` with no
  // `--session` carried claude's UUID straight through, and opencode needs `ses_...`. The next fix round then resumed an
  // id its harness cannot mean, and `parseBlock` refused the block written with it on the way back, which kills the
  // recovery the block exists for. A session from another harness is meaningless rather than wrong, so it is dropped.
  const id = "acme/widget/widget-export";
  const cases = [
    // Inherited from the registry entry.
    { seedSession: "6f1c2d3e-1111-4111-8111-111111111111", body: "Adds export.\n", from: "claude" },
    // Inherited from the PR block, with no registry entry of its own to read it from.
    { seedSession: null, body: BLOCK({ harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111" }), from: "claude" },
  ];
  for (const c of cases) {
    const w = registerWorld(registerGit());
    w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: c.body });
    if (c.seedSession) w.ctx.state.put(id, {
      ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: c.seedSession, repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.prOpen, nowIso: T0 }),
      url: "https://github.com/acme/widget/pull/142",
    });

    const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", harness: "opencode" });

    assert.equal(r.session, null, "the command reports no session, so it never claims a resume it did not keep");
    assert.equal(w.ctx.state.get(r.id).session, null, "and the registry holds none");
    assert.equal(w.ctx.state.get(r.id).harness, "opencode");
    // The block must say the same thing, or recovery restores the id that was just dropped.
    const body = w.calls.filter(x => x[0] === "setBody").at(-1)[1];
    assert.match(body, /harness: opencode/);
    assert.doesNotMatch(body, /6f1c2d3e/, "the incompatible id is not written back to the PR either");
    // And `parseBlock` reads it back, which is the whole point: an id opencode cannot mean was refused here.
    assert.equal(parseBlock(body).block.harness, "opencode");
    assert.equal(parseBlock(body).block.session, null);
    // The operator is told, because they may have wanted that conversation.
    assert.ok(w.logged.some(l => /is not a opencode session id.*dropped.*fresh opencode session/.test(l)),
      `the drop is logged with both harnesses (got ${w.logged})`);
  }
});

test("a --harness change KEEPS an inherited session the new harness can mean, and an explicit bad one still refuses", async () => {
  // The clearing is about compatibility, not about the flag: claude and codex both key sessions by UUID, so a claude
  // session id is a valid codex one and dropping it would cost a conversation for nothing.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK({ harness: "claude" }) });
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", harness: "codex" });
  assert.equal(r.session, "6f1c2d3e-1111-4111-8111-111111111111", "a UUID means the same thing to codex, so it is kept");
  assert.ok(!w.logged.some(l => /dropped/.test(l)), "and nothing is dropped, so nothing is logged about it");

  // An operator who TYPED an id meant that id, so that case still refuses rather than quietly clearing.
  const typed = registerWorld(registerGit());
  typed.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  await assert.rejects(() => register(typed.ctx, { url: typed.url, worktree: "/checkouts/widget", harness: "opencode", session: "6f1c2d3e-1111-4111-8111-111111111111" }),
    /is not a opencode session id; nothing was registered/);
  assert.deepEqual(typed.calls.filter(x => x[0] === "setBody"), [], "and nothing was written for a session that was refused");
});

test("registering with no override, or one that agrees with the block, leaves the body alone", async () => {
  for (const over of [{}, { harness: "claude" }, { session: "6f1c2d3e-1111-4111-8111-111111111111" }]) {
    const w = registerWorld(registerGit());
    w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
    await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", ...over });
    assert.deepEqual(w.calls.filter(c => c[0] === "setBody"), [], "a block that already says the right thing is not rewritten");
  }
});

test("a reset clears the round comment a counted round still owed, because the reset zeroes the round", async () => {
  // `round_comment` is the comment a counted round owes the PR, and the entry it sits on is usually one that stopped
  // with `stuck` because that comment would not post, which is exactly the entry an operator resets after fixing the
  // token. Carried across the reset it would announce a round the registry no longer claims: the next tick would post
  // "round 0" and `why` would report a recovery counting minus one. The reset comment this command posts is the new
  // boundary anyway, so every marker before it is already outside the count.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.state.put("acme/widget/widget-export", {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
    reason: "stuck", iteration: 2, labels_pending: true,
    retry: { op: "round comment", count: 5 },
    round_comment: { kind: "round", since: T0, pushed_at: T0 },
  });

  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  const e = w.ctx.state.get(r.id);
  assert.equal(e.iteration, 0, "the count is zeroed, as it always was");
  assert.equal(e.round_comment, null, "and the comment that count owed goes with it");
  assert.equal(e.retry, null, "as does the streak that stopped the entry");
  assert.equal(e.labels_pending, false, "and the needs-human label a stop owed, since nothing is stopped now");
  assert.equal(e.reason, null);
});

test("a reset cursor is floored to the second, so feedback posted in that same second is still dispatched", async () => {
  // `nowIso()` carries milliseconds; GitHub stamps comments and reviews to the second. The event comparison is
  // inclusive of its own boundary, so a cursor of 02:00:00.500Z sat after every comment created at 02:00:00Z and
  // buried it for good.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.state.put("acme/widget/widget-export", {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
  });

  const before = floorSecond(new Date().toISOString());
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  const e = w.ctx.state.get(r.id);

  assert.equal(e.cursor.since, floorSecond(e.cursor.since), "the event cursor carries no milliseconds");
  assert.equal(e.rereview.at, floorSecond(e.rereview.at), "and neither does the reviewer clock");
  assert.equal(e.rereview.at, e.cursor.since);
  assert.ok(isAtOrAfter(e.cursor.since, before), `the cursor is the reset time, not something older (${e.cursor.since} vs ${before})`);

  // The point of the flooring, spelled as `deriveEvents` reads it: a comment GitHub stamped in the reset's own
  // second, with no milliseconds of its own, is at or after the cursor and therefore new.
  const comment = e.cursor.since.replace(".000Z", "Z");
  assert.equal(isAtOrAfter(comment, e.cursor.since), true, "a comment written in the cursor's own second is dispatched");
  // The same comment against the cursor as it used to be written, somewhere inside that second: lost.
  const unfloored = new Date(Date.parse(e.cursor.since) + 500).toISOString();
  assert.equal(isAtOrAfter(comment, unfloored), false, "which the old millisecond cursor denied");
});

test("a block that cannot be written fails the registration instead of reporting success without it", async () => {
  // The block is the identity of record: reconciliation rebuilds an entry from it after state.json is lost. A
  // registration that said "watching" with no block written, or with a block still naming the old session, would
  // have recovery skip the PR or resume the wrong session.
  for (const [what, body, over] of [
    ["a fresh registration", "Adds export.\n", {}],
    ["an override of a block that names another harness", BLOCK({ harness: "codex" }), { harness: "claude" }],
  ]) {
    const w = registerWorld(registerGit());
    w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body });
    w.ctx.gh.setBody = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token"); };

    await assert.rejects(() => register(w.ctx, { url: w.url, worktree: "/checkouts/widget", ...over }),
      /cannot write the gallivant block to .*pull\/142: HTTP 403.*Nothing was registered/s, what);
    assert.deepEqual(w.ctx.state.entries(), [], `${what}: nothing half-written in the registry`);
    assert.deepEqual(w.calls.filter(c => c[0] === "comment"), [], `${what}: no reset comment claiming the loop is watching again`);
  }
});

test("a fresh registration takes the PRD snapshot the completion gate reads, from the PR's own branch", async () => {
  // Without it `prdFor` has nothing, the gate logs "no PRD snapshot, completion gate skipped", and the PR can reach
  // ready with not one acceptance criterion evaluated. `reconcile` already took it; `register` took only the path.
  const w = registerWorld(registerGit(), { files: { "docs/prds/widget-export.md": GOOD_PRD } });
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });

  assert.equal(w.snapshots.get(r.id), GOOD_PRD, "the daemon's own copy of the brief exists after registering");
  assert.deepEqual(w.calls.filter(c => c[0] === "fileAt"), [["fileAt", "docs/prds/widget-export.md", "gallivant/widget-export"]],
    "read from the PR's head branch, which is where that PRD lives");
  assert.ok(w.logged.some(l => /PRD snapshot taken from the PR branch/.test(l)), `the log says the session could have edited that copy (got ${w.logged})`);
});

test("a block naming a PRD that is not on the branch logs and registers anyway", async () => {
  const w = registerWorld(registerGit(), { files: {} });
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });

  assert.equal(w.snapshots.size, 0, "nothing invented for a file the branch does not carry");
  assert.equal(w.ctx.state.get(r.id).state, STATES.prOpen, "the PR is still watched; the gate is what is skipped");
  assert.ok(w.logged.some(l => /docs\/prds\/widget-export\.md not found on gallivant\/widget-export/.test(l)), `the missing file is named (got ${w.logged})`);
});

test("a reset does not replace a snapshot the daemon already has with the copy the session could have edited", async () => {
  // The pair with the two above: registering now reads the branch when there is no snapshot, so this pins down that
  // it looks at the snapshot first and stops there. Both halves are one `ensurePrdSnapshot`, shared with `reconcile`.
  const snapshots = new Map([["acme/widget/widget-export", "# The daemon's own copy\n"]]);
  const asked = [];
  const w = registerWorld(registerGit(), { files: { "docs/prds/widget-export.md": "# The branch copy\n" }, snapshots });
  const readPrd = w.ctx.readPrd;
  w.ctx.readPrd = id => { asked.push(id); return readPrd(id); };
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.state.put("acme/widget/widget-export", {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
  });

  await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  assert.equal(snapshots.get("acme/widget/widget-export"), "# The daemon's own copy\n");
  assert.deepEqual(asked, ["acme/widget/widget-export"], "the snapshot on disk is what was consulted");
  assert.deepEqual(w.calls.filter(c => c[0] === "fileAt"), [], "the authoritative snapshot is not even compared against the branch");
});

test("a GitHub read that fails while taking the snapshot leaves the PR registered rather than the command half done", async () => {
  // The entry is what the daemon needs to watch the PR at all; the snapshot only decides whether the gate runs, and
  // the next `reconcile` takes it. Failing the whole registration over it would be the worse trade.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.gh.fileAt = async () => { throw new Error("HTTP 502: Bad gateway"); };
  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });

  assert.equal(w.ctx.state.get(r.id).state, STATES.prOpen);
  assert.ok(w.logged.some(l => /PRD snapshot not taken: HTTP 502/.test(l)), `the failure is logged (got ${w.logged})`);
});


test("a --session that is not a session id for the chosen harness is refused, and nothing is registered", async () => {
  // The block validates a session per harness; `--session` did not, and its value reaches argv position 2 on the next
  // fix round, right after `--resume` or `--name`. `assertSafeArgv` matches flag spellings, not values in unexpected
  // positions, so `--session '--approval-mode=yolo'` was accepted, and goose derives its session FILE from the name.
  const cases = [
    ["--approval-mode=yolo", "claude"],
    ["../../../etc/passwd", "goose"],
    ["--settings", "claude"],
    ["ses_f25fcd907ffesl1i92jsR2lh9I", "claude"],
    ["6f1c2d3e-1111-4111-8111-111111111111", "goose"],
  ];
  for (const [session, harness] of cases) {
    const w = registerWorld(registerGit());
    await assert.rejects(() => register(w.ctx, { url: w.url, worktree: "/checkouts/widget", harness, session }),
      new RegExp(`is not a ${harness} session id`), `${harness} must refuse ${JSON.stringify(session)}`);
    assert.deepEqual(w.ctx.state.entries(), [], `${JSON.stringify(session)}: nothing half-written in the registry`);
    assert.deepEqual(w.calls.filter(c => c[0] === "setBody"), [], "and no block written for a session that was refused");
  }
  // Each harness's own id is accepted, which is the same rule the block applies.
  for (const [harness, session] of [["claude", "6f1c2d3e-1111-4111-8111-111111111111"], ["goose", "gallivant-068021d7-3490-4f2e-a6f1-30e1c00498c9"], ["opencode", "ses_f25fcd907ffesl1i92jsR2lh9I"]]) {
    const w = registerWorld(registerGit());
    const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", harness, session });
    assert.equal(w.ctx.state.get(r.id).session, session, `${harness} accepts its own id`);
  }
});

test("start validates the run specification before it clones, so a refused harness leaves no worktree to clean up", async () => {
  // `buildRun` refuses a harness that cannot grant `context_paths` as read-only, and it used to be called four lines
  // after `git.create`. The refusal arrived with the repository already cloned and nothing in the registry, so the
  // next `gallivant start` failed on `git.create` ("worktree already exists") and the operator had to find and delete
  // the directory by hand. Nothing in the spec needs the checkout: `worktreePath` is a pure function of the config,
  // the repo and the PRD id, and `git.create` clones to that same path.
  const w = startWorld();
  const extra = tempHome();
  const created = [];
  w.ctx.config = { ...w.ctx.config, context_paths: [extra] };
  w.ctx.git.create = async spec => { created.push(spec); return w.worktree; };
  w.ctx.writePrd = () => { throw new Error("the snapshot should not be written for a run that cannot be built"); };

  await assert.rejects(() => start(w.ctx, { path: w.prdPath }), /refusing to run codex with context_paths/);
  assert.deepEqual(created, [], "nothing was cloned for a run that was never going to start");
  assert.deepEqual(w.ctx.state.entries(), [], "and nothing is in the registry either");

  // The sign-in probe still runs first, so its refusal also precedes the clone. Both are knowable before it.
  const signedOut = startWorld();
  const clones = [];
  signedOut.ctx.config = { ...signedOut.ctx.config, harness: { ...signedOut.ctx.config.harness, codex: { bin: join(signedOut.home, "nope") } } };
  signedOut.ctx.git.create = async () => { clones.push(1); return signedOut.worktree; };
  await assert.rejects(() => start(signedOut.ctx, { path: signedOut.prdPath }), /is not signed in/);
  assert.deepEqual(clones, [], "a signed-out harness is refused before the clone as well");
});

test("a reset that fails halfway leaves GitHub and the registry agreeing on ONE identity, never on two", async () => {
  // Both writes are preconditions and both throw, so what the ORDER decides is what GitHub is left saying when the
  // second one fails. The body write went first, so a comment that then failed left `register` reporting that nothing
  // was reset, the registry still on the OLD harness and session, and the PR already recording the NEW ones. A running
  // daemon reads the registry and a later recovery reads the block, so the two resumed different harnesses for the same
  // PR, and nothing anywhere compared them. The body write is the point of no return, so it goes last.
  const id = "acme/widget/widget-export";
  const seed = () => ({
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    reason: "iterations", iteration: 3,
  });

  // The comment fails. Nothing durable has been written yet, so the PR still records claude and the registry still
  // records claude: one identity, on both sides.
  const a = registerWorld(registerGit());
  a.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  a.ctx.gh.comment = async () => { a.calls.push(["comment"]); throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  a.ctx.state.put(id, seed());
  await assert.rejects(() => register(a.ctx, { url: a.url, worktree: "/checkouts/widget", harness: "codex" }),
    /cannot post the reset comment.*recorded harness and session are unchanged/s);
  assert.deepEqual(a.calls.filter(c => c[0] === "setBody"), [], "the identity write never ran, so the PR still names the old harness");
  assert.equal(a.ctx.state.get(id).harness, "claude", "and so does the registry: they agree");

  // The comment lands and the BODY fails. The reset comment is on the PR and nothing else changed, so both sides still
  // say claude. A duplicate reset comment is harmless: `countRounds` takes the last marker, so two count as one.
  const b = registerWorld(registerGit());
  b.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  b.ctx.gh.setBody = async () => { b.calls.push(["setBody"]); throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  b.ctx.state.put(id, seed());
  await assert.rejects(() => register(b.ctx, { url: b.url, worktree: "/checkouts/widget", harness: "codex" }),
    /cannot write the gallivant block.*keeps harness claude and session 6f1c2d3e.*still what the PR records/s);
  const stillOld = b.ctx.state.get(id);
  assert.deepEqual([stillOld.harness, stillOld.session], ["claude", "6f1c2d3e-1111-4111-8111-111111111111"],
    "the registry keeps the old identity");
  assert.equal(stillOld.iteration, 3, "and the reset did not land locally either");
  assert.equal(b.calls.filter(c => c[0] === "comment").length, 1, "the comment is on the PR, which is safe: countRounds takes the LAST marker");

  // An existing entry on a PR with no block at all is the one case where "the PR still records that" would be false:
  // the registry has an identity and GitHub has none, which is what the write was about to fix. The message says so.
  const c = registerWorld(registerGit());
  c.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: "Adds export.\n" });
  c.ctx.gh.setBody = async () => { throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  c.ctx.state.put(id, seed());
  await assert.rejects(() => register(c.ctx, { url: c.url, worktree: "/checkouts/widget" }),
    /the PR still records no identity at all/s);
  assert.equal(c.ctx.state.get(id).harness, "claude", "and the registry is untouched either way");

  // The operator fixes the cause and runs the same command. The whole reset lands, and the second comment changes no
  // count, so the retry is complete rather than partial.
  b.ctx.gh.setBody = async (_r, _n, body) => { b.calls.push(["setBody", body]); };
  const r = await register(b.ctx, { url: b.url, worktree: "/checkouts/widget", harness: "codex" });
  const done = b.ctx.state.get(r.id);
  assert.equal(done.harness, "codex", "the registry now records the new harness");
  assert.match(b.calls.filter(c => c[0] === "setBody").at(-1)[1], /harness: codex/, "and so does the PR: still one identity");
  assert.equal(done.iteration, 0, "and the reset itself landed");
});

test("a reset comment that cannot be posted fails the reset instead of zeroing the iteration without its marker", async () => {
  // The reset comment IS the reset boundary: `countRounds` finds its marker and counts the round comments after it.
  // With the comment missing and `state.json` later lost, a recovery rebuilds the iteration this command had just
  // zeroed, and an entry restored at `max_iterations` stops with `reason: "iterations"` on its next event, having
  // done no work in the round at all.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.gh.comment = async () => { w.calls.push(["comment"]); throw new Error("HTTP 403: Resource not accessible by personal access token"); };
  const id = "acme/widget/widget-export";
  const existing = {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    reason: "iterations", iteration: 3,
  };
  w.ctx.state.put(id, existing);

  await assert.rejects(() => register(w.ctx, { url: w.url, worktree: "/checkouts/widget" }),
    /cannot post the reset comment on .*pull\/142: HTTP 403.*Nothing was reset.*keeps its 3 rounds/s);

  const e = w.ctx.state.get(id);
  assert.equal(e.iteration, 3, "the local count still matches what GitHub can be counted back to");
  assert.deepEqual([e.state, e.reason], [STATES.needsHuman, "iterations"], "and the entry is exactly as it was, nothing half-reset");
  assert.equal(e.cursor.since, existing.cursor.since, "the cursor did not move either");

  // GitHub answers and the same command does the whole reset in one go.
  w.ctx.gh.comment = async () => { w.calls.push(["comment"]); };
  await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  const after = w.ctx.state.get(id);
  assert.equal(after.iteration, 0);
  assert.deepEqual([after.state, after.reason], [STATES.prOpen, null]);
});

test("a reset clears the retry counter, so a stuck entry does not stop again on the first write that fails", async () => {
  // `retry` counts consecutive failures of one GitHub write the tick declines a step for, and `stuck` is what it stops
  // with. Left behind, an entry reset after a `stuck` stop would carry four failures into its next tick and stop on the
  // very first failure of that write, which is the opposite of what a reset means.
  const w = registerWorld(registerGit());
  w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
  w.ctx.state.put("acme/widget/widget-export", {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/checkouts/widget", pr: 142, state: STATES.needsHuman, nowIso: T0 }),
    url: "https://github.com/acme/widget/pull/142",
    reason: "stuck",
    retry: { op: "ready label removal", count: 4 },
  });

  const r = await register(w.ctx, { url: w.url, worktree: "/checkouts/widget" });
  const e = w.ctx.state.get(r.id);
  assert.equal(e.retry, null, "the counter goes with the reason it produced");
  assert.equal(e.reason, null);
  assert.equal(e.state, STATES.prOpen);
});

// `gallivant new`, which exists because every quickstart told the operator to `cp templates/prd.md`, a path that
// resolves only inside a Gallivant clone. The tool knows where its own template is; the reader should not have to.
test("new writes a PRD into the repo root from anywhere inside it, and the contract then refuses the unedited template", async () => {
  const root = tempHome();
  const deep = join(root, "src", "nested");
  mkdirSync(deep, { recursive: true });
  // Real git answers with the repo root for any directory inside it, which is the whole point of asking it rather
  // than using the cwd. `tempHome()` can sit behind a symlink, so the fake does not compare paths.
  const ctx = { git: { toplevel: async () => root }, config: { harness: { codex: { bin: "/b/codex" } } }, log: silentLog };
  const r = await newPrd(ctx, { name: "Widget Export!" });
  // The name is slugified to what the contract's `path` rule accepts, and it lands at the root rather than the cwd.
  assert.equal(r.id, "widget-export");
  assert.equal(r.path, join(root, "docs", "prds", "widget-export.md"));
  assert.ok(existsSync(r.path));
  // The harness comes from the config, so the brief names one the operator can actually run.
  assert.equal(r.harness, "codex");
  assert.match(readFileSync(r.path, "utf8"), /^harness: codex$/m);
  // A template that passed the contract would be a template nobody edits. It must fail loudly instead.
  const verdict = check(prdRequest(readFileSync(r.path, "utf8"), r.path));
  assert.equal(verdict.ok, false, "the starting template is not a valid PRD; editing it is the work");
});

test("new refuses a name with nothing usable in it, an existing file, an unconfigured harness, and a directory outside a repo", async () => {
  const root = tempHome();
  const ctx = { git: { toplevel: async () => root }, config: { harness: { claude: { bin: "/b/claude" } } }, log: silentLog };
  await assert.rejects(() => newPrd(ctx, { name: "!!!" }), /no letters or digits/);
  await assert.rejects(() => newPrd(ctx, { name: "x", harness: "goose" }), /not configured/);
  await newPrd(ctx, { name: "dup" });
  await assert.rejects(() => newPrd(ctx, { name: "dup" }), /already exists/);
  const outside = { ...ctx, git: { toplevel: async () => { throw new Error("not a git repository"); } } };
  await assert.rejects(() => newPrd(outside, { name: "x" }), /not inside a git repository/);
});

test("the packaged template is found by the installed package, not by a relative path", () => {
  // The bug this guards: `cp templates/prd.md ...` in the docs, which an operator standing in their own repo cannot run.
  for (const name of ["prd.md", "passport.gallivant.json"]) assert.ok(existsSync(templatePath(name)), `${name} ships with the package`);
  assert.ok(templatePath("prd.md").startsWith("/"), "resolved absolutely, so it works from any cwd");
});
