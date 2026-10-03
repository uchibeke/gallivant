// Gaps in the loop's coverage that are not about one command: what `start` records on success and when the harness
// is signed out, a ready entry reopened by a command comment, a recreated checkout, and register-then-tick end to
// end. Kept out of tick.test.mjs and commands.test.mjs so those files stay one topic each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { start } from "../lib/commands/start.mjs";
import { register } from "../lib/commands/register.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeState } from "../lib/state.mjs";
import { READY_LABEL } from "../lib/gh.mjs";
import { CONFIG, T0, at, tempHome, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, prFixture, comment, silentLog, STATES, GOOD_PRD, fakeCredential, fakeIdentity, harnessBin } from "./helpers.mjs";

function startWorld({ signIn = {} } = {}) {
  const home = tempHome();
  const repoDir = join(home, "operator-repo");
  const worktree = join(home, "worktrees", "acme", "widget", "widget-export");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(repoDir, "docs", "prds"), { recursive: true });
  const prdPath = join(repoDir, "docs", "prds", "widget-export.md");
  writeFileSync(prdPath, GOOD_PRD);
  const clock = makeClock();
  const runner = fakeRunner(clock);
  const snapshots = new Map();
  const ctx = {
    home,
    config: { ...CONFIG, home, worktrees: join(home, "worktrees"), harness: { ...CONFIG.harness, codex: { bin: harnessBin(home, "codex", signIn) } } },
    state: makeState(home),
    log: silentLog,
    gh: {
      repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }),
      ensureLabels: async () => {},
      // Every branch exists unless a test narrows it: `start` asks before it clones, and a base that is not on the
      // remote is its own test rather than something every other one has to arm.
      branchExists: async () => true,
      repoDefaultBranch: async () => "main",
    },
    git: { toplevel: async () => repoDir, create: async () => worktree },
    runnerFor: () => runner,
    writePrd: (id, text) => snapshots.set(id, text),
    credential: fakeCredential(), identity: fakeIdentity(),
  };
  return { ctx, prdPath, worktree, runner, snapshots, home };
}

test("a successful start records a running entry with its session, our branch name and the checkout it runs in", async () => {
  const w = startWorld();
  const r = await start(w.ctx, { path: w.prdPath });
  const e = w.ctx.state.get(r.id);

  assert.equal(e.state, STATES.running, "no PR yet, so the entry is running rather than watched");
  // GOOD_PRD names codex, whose sessions are keyed by the directory and only get an id once the first turn starts.
  assert.equal(e.harness, "codex");
  assert.equal(e.session, null, "codex has no id to record until its first turn reports a thread");
  assert.equal(e.branch, "work/widget-export", "new branches use the neutral convention recovery reads back");
  assert.equal(e.worktree, w.worktree, "and the entry points at the checkout the run was spawned in");
  assert.equal(e.pr, null);
  assert.equal(e.iteration, 0);
  assert.equal(e.last.run, w.runner.started[0].id, "the entry names the run the tick will settle");
  assert.equal(e.last.exit, null);
  assert.equal(w.runner.started[0].opts.cwd, w.worktree);
});

test("a start on claude records the session id the resume will use", async () => {
  const w = startWorld();
  writeFileSync(w.prdPath, GOOD_PRD.replace("harness: codex", "harness: claude"));
  // Claude's own sign-in check reads its JSON, so the stub answers the way a signed-in CLI does.
  w.ctx.config.harness.claude = { ...CONFIG.harness.claude, bin: harnessBin(w.home, "claude"), settings: join(w.home, "settings.json") };

  const r = await start(w.ctx, { path: w.prdPath });
  const e = w.ctx.state.get(r.id);
  assert.match(e.session, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(e.session, r.session);
  assert.ok(w.runner.started[0].args.includes(e.session), "and the run was started with exactly that id");
});

test("a signed-out harness stops start with the harness and the detail named, and records nothing", async () => {
  const w = startWorld({ signIn: { signedIn: false, signInOutput: "Not logged in. Run codex login." } });
  await assert.rejects(() => start(w.ctx, { path: w.prdPath }), err => {
    assert.match(err.message, /^codex is not ready \(/, "the message names which harness");
    assert.match(err.message, /Not logged in\. Run codex login\./, "and passes the harness's own words through");
    assert.match(err.message, /codex login/);
    return true;
  });

  assert.equal(w.ctx.state.entries().length, 0, "nothing is recorded: the fix is a login, after which start is simply rerun");
  assert.equal(w.snapshots.size, 0, "and no PRD snapshot is taken for a session that never started");
  assert.equal(w.runner.started.length, 0, "no run was spawned");
});

test("a harness whose sign-in check cannot run at all is refused the same way", async () => {
  const w = startWorld();
  w.ctx.config.harness.codex = { bin: join(w.home, "no-such-binary") };
  await assert.rejects(() => start(w.ctx, { path: w.prdPath }), /codex is not ready/);
  assert.equal(w.ctx.state.entries().length, 0);
});

// A tick world with one seeded entry, as tick.test.mjs builds it, so the cases below read the same way.
function world(stateOver = {}, ghOver = {}, deps = {}) {
  const clock = makeClock();
  const { state, id } = seededState(stateOver);
  const gh = fakeGh(ghOver);
  const runner = fakeRunner(clock);
  const notify = fakeNotify();
  const git = deps.git ?? fakeGit();
  const tick = makeTick({ credential: fakeCredential(), identity: fakeIdentity(),  config: CONFIG, state, gh, git, notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });
  return { clock, state, id, gh, git, runner, notify, tick, entry: () => state.get(id) };
}

test("a @gallivant fix comment on a ready entry reopens it, drops the ready label and dispatches the comment", async () => {
  const w = world({ state: STATES.ready }, { comments: [comment({ id: 88, by: "me", at: at(5), body: "@gallivant fix the header casing" })] });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.prOpen, "a person asked for another round, so it is watched again, not waiting to be merged");
  assert.equal(w.runner.started.length, 1);
  assert.match(w.runner.started[0].args.at(-1), /the header casing/, "with the @gallivant fix prefix stripped");
  assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === READY_LABEL), "and the label that said a human could merge it is gone");
  assert.equal(w.notify.sent.length, 0, "reopening is the operator's own doing; they do not need telling");
});

test("a @gallivant fix comment from an untrusted author on a ready entry changes nothing", async () => {
  const w = world({ state: STATES.ready }, { comments: [comment({ id: 88, by: "drive-by", at: at(5), body: "@gallivant fix everything" })] });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.entry().state, STATES.ready);
  assert.equal(w.runner.started.length, 0);
});

test("a missing checkout is cloned from the PR branch and the run is spawned in the recreated path", async () => {
  const cloned = [];
  const git = {
    ...fakeGit(),
    exists: () => false,
    fromBranch: async spec => { cloned.push(spec); return spec.path; },
  };
  const w = world({}, { comments: [comment({ id: 88, by: "me", at: at(5), body: "@gallivant fix the typo" })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.deepEqual(cloned, [{ nameWithOwner: "acme/widget", prdId: "widget-export", branch: "gallivant/widget-export", path: "/tmp/wt" }],
    "cloned from the entry's own branch, at the path the entry records");
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.runner.started[0].opts.cwd, "/tmp/wt", "and the harness runs in the recreated checkout, not wherever the daemon happens to be");
});

test("a checkout that is already there is not re-cloned", async () => {
  let cloned = 0;
  const git = { ...fakeGit(), exists: () => true, fromBranch: async ({ path }) => { cloned++; return path; } };
  const w = world({}, { comments: [comment({ id: 88, by: "me", at: at(5), body: "@gallivant fix the typo" })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(cloned, 0, "a session keyed to a directory is never re-cloned over");
  assert.equal(w.runner.started.length, 1);
});

test("register then a tick resumes the registered session in the registered worktree", async () => {
  const home = tempHome();
  const clock = makeClock();
  const state = makeState(home);
  const session = "aaaaaaaa-2222-4222-8222-222222222222";
  const pr = prFixture({ number: 142, headRefName: "gallivant/widget-export", createdAt: T0, headRefOid: "a1b2c3d", body: "Adds export.\n" });
  const gh = fakeGh({ pr, comments: [comment({ id: 88, by: "me", at: at(5), body: "@gallivant fix the typo" })] });
  gh.user = async () => "me";
  const runner = fakeRunner(clock);
  const config = { ...CONFIG, home, worktrees: join(home, "worktrees") };
  const ctx = {
    home, config, state, gh, log: silentLog,
    git: { exists: () => true, originOf: async () => "https://github.com/acme/widget.git", currentBranch: async () => "gallivant/widget-export", fromBranch: async ({ path }) => path },
  };

  const r = await register(ctx, { url: pr.url, harness: "claude", session, worktree: join(home, "checkouts", "widget") });
  assert.equal(r.session, session);
  const registered = state.get(r.id);
  assert.equal(registered.state, STATES.prOpen);
  assert.equal(registered.cursor.since, T0, "a fresh registration sees the PR's whole history, so feedback already on it is addressed");

  const tick = makeTick({ credential: fakeCredential(), identity: fakeIdentity(),  config, state, gh, git: { ...fakeGit(), exists: () => true }, notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null });
  clock.advance(6);
  await tick.tick();

  assert.equal(runner.started.length, 1, "the comment already on the PR when it was registered is dispatched");
  const run = runner.started[0];
  assert.ok(run.args.includes("--resume") && run.args.includes(session), `the registered session is resumed, not a new one (${run.args.join(" ")})`);
  assert.equal(run.opts.cwd, join(home, "checkouts", "widget"), "in the checkout register verified and stored");
  assert.match(run.args.at(-1), /the typo/);
  assert.equal(state.get(r.id).session, session, "and the entry still names that session after the dispatch");
});
