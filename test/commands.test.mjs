// `start` and `register` against fakes: the filesystem is real (a temp dir), git and gh are not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { makeState } from "../lib/state.mjs";
import { CONFIG, T0, tempHome, prFixture, fakeRunner, makeClock, silentLog, GOOD_PRD } from "./helpers.mjs";

/** A `bin` that exits 0, so `checkSignIn` for codex passes without a real harness installed. */
function signedInBin(dir) {
  const bin = join(dir, "codex-stub");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n");
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

function registerWorld(git) {
  const home = tempHome();
  const pr = prFixture({ headRefName: "gallivant/widget-export", body: "Adds export.\n", createdAt: T0 });
  const calls = [];
  const ctx = {
    home,
    config: { ...CONFIG, home, worktrees: join(home, "worktrees") },
    state: makeState(home),
    log: silentLog,
    git,
    gh: {
      prView: async () => pr,
      setBody: async (_r, _n, body) => { calls.push(["setBody", body]); },
      comment: async () => { calls.push(["comment"]); },
      ensureLabels: async () => {},
    },
  };
  return { ctx, calls, url: pr.url };
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

test("registering with no override, or one that agrees with the block, leaves the body alone", async () => {
  for (const over of [{}, { harness: "claude" }, { session: "6f1c2d3e-1111-4111-8111-111111111111" }]) {
    const w = registerWorld(registerGit());
    w.ctx.gh.prView = async () => ({ ...prFixture({ headRefName: "gallivant/widget-export", createdAt: T0 }), body: BLOCK() });
    await register(w.ctx, { url: w.url, worktree: "/checkouts/widget", ...over });
    assert.deepEqual(w.calls.filter(c => c[0] === "setBody"), [], "a block that already says the right thing is not rewritten");
  }
});
