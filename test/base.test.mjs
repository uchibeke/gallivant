// The base branch and the merge that keeps a branch on it.
//
// Two defects are covered here, both found on a live repository. Every branch was cut from the repository's DEFAULT
// branch and every session was told to open its pull request against the default branch, which is wrong for a project
// whose pull requests all target `staging`: `gh repo view` reported `main` while the merged PR #385 had `baseRefName:
// staging`. And nothing ever brought the base into a branch, so a branch cut on Monday and fixed on Thursday drifted
// until the loop reported `conflict` and stopped.
//
// What is asserted about the merge, and why a merge rather than a rebase, is spelled out at `git.mergeBase` in
// lib/git.mjs and at `mergeBaseInto` in lib/tick.mjs. The short version: a rebase of a pushed branch needs a
// force-push, which the RULES every session is given forbid, and it would strand the reviewer's clearance, which
// `reviewerVerdict` grants to one named sha. The tests below pin the consequences of that choice rather than the
// choice itself: nothing here ever force-pushes, and an outstanding review does not hold the merge up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { start } from "../lib/commands/start.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeState } from "../lib/state.mjs";
import { makeGit } from "../lib/git.mjs";
import { startPrompt, fixPrompt, resumePrompt } from "../lib/prompt.mjs";
import { validate, rememberRepo, configuredBase, resolveBase, configuredTimeout, resolveTimeout, repoNames, repoEntries, DEFAULTS } from "../lib/config.mjs";
import { why } from "../lib/commands/why.mjs";
import { model as statusModel, render as statusRender } from "../lib/commands/status.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { configPath } from "../lib/config.mjs";
import { CONFIG, T0, at, tempHome, makeClock, fakeGh, fakeGit, fakeRunner, fakeNotify, seededState, prFixture, review, silentLog, STATES, GOOD_PRD, claudeResultLines, fakeIdentity, harnessBin } from "./helpers.mjs";

const BOT = "chatgpt-codex-connector[bot]";

// --- the setting -------------------------------------------------------------------------------------------------

test("a repos entry is a bare name or a { repo, base } object, and both are read the same way", () => {
  // The string form has to keep meaning what it has always meant, because `rememberRepo` writes it on a first use and
  // an operator who never configured a base must not find their config rewritten into a shape they did not choose.
  const cfg = { repos: ["Acme/Widget", { repo: "acme/other", base: "staging" }] };
  assert.deepEqual(repoNames(cfg), ["acme/widget", "acme/other"], "both forms yield a name, lowercased");
  assert.deepEqual(repoEntries(cfg), [
    { repo: "acme/widget", base: null, run_timeout_minutes: null },
    { repo: "acme/other", base: "staging", run_timeout_minutes: null },
  ], "an unset optional key is null on both forms, which is what every reader treats as \"not configured\"");
  assert.equal(configuredBase(cfg, "acme/widget"), null, "a bare name configures no base");
  assert.equal(configuredBase(cfg, "ACME/OTHER"), "staging", "and the object form does, case-insensitively");
  assert.equal(configuredBase(cfg, "acme/unknown"), null, "an unlisted repository configures nothing");
});

test("config validation refuses a repos entry that is neither form, and names a misspelled base key", () => {
  // The misspelling is the failure worth catching. `{ repo, branch }` is a plausible thing to write and would read as
  // "no base configured" forever, so the PR would silently target the default branch and nothing would say why.
  const bad = validate({ ...DEFAULTS, ...CONFIG, repos: [{ repo: "acme/widget", branch: "staging" }] });
  assert.ok(bad.some(p => /unknown key/.test(p) && /branch/.test(p)), `expected the unknown key named, got ${JSON.stringify(bad)}`);
  assert.ok(validate({ ...DEFAULTS, ...CONFIG, repos: ["not-owner-slash-name"] }).some(p => /not owner\/name/.test(p)));
  assert.ok(validate({ ...DEFAULTS, ...CONFIG, repos: [{ repo: "acme/widget", base: "" }] }).some(p => /base must be a branch name/.test(p)));
  assert.ok(validate({ ...DEFAULTS, ...CONFIG, repos: ["acme/widget", { repo: "Acme/Widget" }] }).some(p => /listed twice/.test(p)));
  assert.deepEqual(validate({ ...DEFAULTS, ...CONFIG, repos: ["acme/widget", { repo: "acme/other", base: "staging" }] }), [], "both forms in one list are legal");
});

/**
 * The per-repository timeout. A run was SIGKILLed at 31.2 minutes against a 30 minute global having done a complete
 * review round: four findings verified against the code, a shared route inventory created with a test pinning it, a
 * referrer bug fixed, an emitter extracted and mutation-tested, six contradictions fixed with a test pinning them, and
 * the full baseline run green (846 tests, 611 tsc errors matching). Its Verify commands take about 2m30s each and the
 * log shows twelve invocations of them. A budget that cannot fit one careful round on a repository of that size is the
 * wrong number for that repository, and there is no global number that is right for it and for a small one at once.
 */
test("resolveTimeout prefers the repository's own run_timeout_minutes, then the global, and says which answered", () => {
  const cfg = { run_timeout_minutes: 45, repos: [{ repo: "acme/big", run_timeout_minutes: 120 }, "acme/small"] };
  assert.deepEqual(resolveTimeout({ config: cfg, repo: "acme/big" }), { minutes: 120, source: "repo" });
  assert.deepEqual(resolveTimeout({ config: cfg, repo: "ACME/BIG" }), { minutes: 120, source: "repo" }, "case-insensitively, like the base");
  assert.deepEqual(resolveTimeout({ config: cfg, repo: "acme/small" }), { minutes: 45, source: "config" }, "a bare name keeps the global");
  assert.deepEqual(resolveTimeout({ config: cfg, repo: "acme/unlisted" }), { minutes: 45, source: "config" });

  // `source` exists so a kill can say which number to raise. Without it "exceeded its 45m timeout" leaves an operator
  // guessing between the global and the repository's own, and raising the wrong one changes nothing.
  assert.equal(configuredTimeout(cfg, "acme/small"), null, "an unconfigured repository reports null, not the global");
  assert.equal(configuredTimeout(cfg, "acme/big"), 120);
});

/**
 * The default is 12 hours because the timeout catches a WEDGED session and nothing else: one spinning on a command that
 * never returns, waiting on a prompt that will never come, or looping. Spend is bounded by `max_iterations` and
 * `max_budget_usd`, which can tell an expensive round from a stuck one; a clock cannot.
 *
 * The two measured runs are the argument. One review round that had not yet reached its `git commit` cost 31.2 minutes
 * and was killed at the 30-minute limit, destroying a finished round (846 tests green, tsc matching its 611 baseline)
 * and recording it as `reason: timeout`. The healthy run before it took 7.3 hours and exited 0. So 30, 45 and 180 are
 * the same error at different scales: any limit near the cost of real work can cut a run like the second one.
 */
test("the default run timeout is long enough that it can only catch a wedged session, never a working one", () => {
  assert.equal(DEFAULTS.run_timeout_minutes, 720);
  // The healthy 7.3-hour run must survive the default, or the default is still a spend limit wearing a clock.
  assert.ok(DEFAULTS.run_timeout_minutes > 7.3 * 60, "a 7.3 hour run that exited 0 must not be killed by the default");
  // With nothing configured at all the resolver still answers, rather than returning undefined into `minutes()`.
  assert.deepEqual(resolveTimeout({ config: {}, repo: "acme/widget" }), { minutes: 720, source: "config" });
  // And the floor stays at 1, so an operator who deliberately wants a short timeout can still set one.
  assert.deepEqual(validate({ ...DEFAULTS, ...CONFIG, run_timeout_minutes: 1 }), []);
  assert.ok(validate({ ...DEFAULTS, ...CONFIG, run_timeout_minutes: 0 }).some(p => /run_timeout_minutes must be a number >= 1/.test(p)));
});

test("a repository timeout is validated, so a typo does not silently keep the global forever", () => {
  const base = { ...DEFAULTS, ...CONFIG };
  assert.deepEqual(validate({ ...base, repos: [{ repo: "acme/widget", run_timeout_minutes: 90 }] }), [], "a number >= 1 is legal beside or without a base");
  assert.deepEqual(validate({ ...base, repos: [{ repo: "acme/widget", base: "staging", run_timeout_minutes: 90 }] }), []);
  // The two failures that would otherwise read as "not configured" and never be noticed.
  assert.ok(validate({ ...base, repos: [{ repo: "acme/widget", run_timeout_minutes: "90" }] }).some(p => /run_timeout_minutes must be a number >= 1/.test(p)), "a string is refused, not ignored");
  assert.ok(validate({ ...base, repos: [{ repo: "acme/widget", run_timeout_minutes: 0 }] }).some(p => /run_timeout_minutes must be a number >= 1/.test(p)), "and so is zero, which would mean kill immediately");
  // And the key is now known, so it must not be reported as a misspelling.
  assert.ok(!validate({ ...base, repos: [{ repo: "acme/widget", run_timeout_minutes: 90 }] }).some(p => /unknown key/.test(p)));
});

test("resolveBase prefers the flag, then the repository's config entry, then the default branch", () => {
  const cfg = { repos: [{ repo: "acme/widget", base: "staging" }] };
  assert.deepEqual(resolveBase({ config: cfg, repo: "acme/widget", defaultBranch: "main", asked: "release" }), { base: "release", source: "flag" });
  assert.deepEqual(resolveBase({ config: cfg, repo: "acme/widget", defaultBranch: "main" }), { base: "staging", source: "config" });
  // The rung that must not move: an operator who configures nothing gets exactly what they get today.
  assert.deepEqual(resolveBase({ config: cfg, repo: "acme/other", defaultBranch: "main" }), { base: "main", source: "default" });
  assert.deepEqual(resolveBase({ config: { repos: [] }, repo: "acme/other", defaultBranch: null }), { base: null, source: "default" });
});

test("rememberRepo writes a bare name with no base, adds one when asked, and never duplicates a repository", () => {
  const home = tempHome();
  writeJsonAtomic(configPath(home), { ...CONFIG, repos: [] }, 0o600);
  const repos = () => readJson(configPath(home)).repos;

  assert.equal(rememberRepo("Acme/Widget", home), true);
  assert.deepEqual(repos(), ["acme/widget"], "no base means the string form, unchanged from before this key existed");
  assert.equal(rememberRepo("acme/widget", home), false, "a second start writes nothing");
  assert.deepEqual(repos(), ["acme/widget"]);

  // `--base` on a repository already known as a bare string upgrades that one entry in place rather than appending.
  assert.equal(rememberRepo("acme/widget", home, "staging"), true);
  assert.deepEqual(repos(), [{ repo: "acme/widget", base: "staging" }]);
  assert.equal(rememberRepo("acme/widget", home, "staging"), false, "the same base again writes nothing");
  assert.equal(rememberRepo("acme/widget", home, "release"), true, "a different base retargets the repository");
  assert.deepEqual(repos(), [{ repo: "acme/widget", base: "release" }]);

  // And an operator's other keys survive every one of those writes.
  assert.equal(readJson(configPath(home)).worktrees, CONFIG.worktrees);
});

// --- start: the cut, the prompt, the refusal ---------------------------------------------------------------------

const signedInBin = dir => harnessBin(dir);

/**
 * A `start` world whose config, default branch and `--base` a test chooses. `git.create` and `gh.branchExists` record
 * what they were asked, because those two are the whole contract: where the branch is cut from, and whether the base
 * was confirmed before anything was cloned.
 */
function startWorld({ repos = [], defaultBranch = "main", branches = ["main", "staging"] } = {}) {
  const home = tempHome();
  const repoDir = join(home, "operator-repo");
  const worktree = join(home, "worktrees", "acme", "widget", "widget-export");
  mkdirSync(worktree, { recursive: true });
  mkdirSync(join(repoDir, "docs", "prds"), { recursive: true });
  writeFileSync(join(repoDir, "docs/prds/widget-export.md"), GOOD_PRD);
  const config = { ...CONFIG, home, repos, worktrees: join(home, "worktrees"), harness: { ...CONFIG.harness, codex: { bin: signedInBin(home) } } };
  writeJsonAtomic(configPath(home), config, 0o600);
  const clock = makeClock();
  const created = [];
  const asked = [];
  const prompts = [];
  const ctx = {
    home, config, state: makeState(home), log: silentLog,
    gh: {
      repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch }),
      ensureLabels: async () => {},
      branchExists: async (repo, branch) => { asked.push(branch); return branches.includes(branch); },
    },
    git: { toplevel: async () => repoDir, create: async spec => { created.push(spec); return worktree; } },
    runnerFor: () => { const r = fakeRunner(clock); const orig = r.start; r.start = (n, c, a, o) => { prompts.push(a.at(-1)); return orig(n, c, a, o); }; return r; },
    writePrd: () => {},
    readPrd: () => GOOD_PRD,
    credential: async ({ host = "github.com" } = {}) => ({ token: "t", source: "github_token_file", host }),
    identity: fakeIdentity(),
  };
  return { home, ctx, created, asked, prompts, prdPath: join(repoDir, "docs/prds/widget-export.md"), worktree, repos: () => readJson(configPath(home)).repos };
}

test("a configured base is the branch the clone is cut from and the branch the prompt tells the session to target", async () => {
  // The live defect: `gh repo view` says `main`, the project's pull requests all go to `staging`. Configure it once and
  // all three users of the base follow, from one definition.
  const w = startWorld({ repos: [{ repo: "acme/widget", base: "staging" }], defaultBranch: "main" });
  const r = await start(w.ctx, { path: w.prdPath });

  assert.equal(r.base, "staging");
  assert.equal(r.baseSource, "config");
  assert.deepEqual(w.created, [{ nameWithOwner: "acme/widget", prdId: "widget-export", base: "staging" }], "the branch is cut from the configured base, not from main");
  assert.match(w.prompts[0], /gh pr create --base staging --head work\/widget-export/, "and the session is told to open against it");
  assert.doesNotMatch(w.prompts[0], /--base main/);
  assert.equal(w.ctx.state.get(r.id).base, "staging", "recorded on the entry, which is what the merge before each round reads");
});

test("an unconfigured repository still uses its default branch, exactly as before", async () => {
  const w = startWorld({ repos: [], defaultBranch: "trunk", branches: ["trunk"] });
  const r = await start(w.ctx, { path: w.prdPath });
  assert.deepEqual([r.base, r.baseSource], ["trunk", "default"]);
  assert.deepEqual(w.created, [{ nameWithOwner: "acme/widget", prdId: "widget-export", base: "trunk" }]);
  assert.match(w.prompts[0], /gh pr create --base trunk/);
  // And nothing about the operator's config changes shape: the repository is remembered as a bare string.
  assert.deepEqual(w.repos(), ["acme/widget"], "no base was chosen, so no object entry is written");
});

test("--base is used for the cut and the prompt, and remembered for the repository", async () => {
  const w = startWorld({ repos: [], defaultBranch: "main", branches: ["main", "staging"] });
  const r = await start(w.ctx, { path: w.prdPath, base: "staging" });
  assert.deepEqual([r.base, r.baseSource], ["staging", "flag"]);
  assert.deepEqual(w.created, [{ nameWithOwner: "acme/widget", prdId: "widget-export", base: "staging" }]);
  assert.match(w.prompts[0], /gh pr create --base staging/);
  // The "when initiating" half of configuring this: the next start in this repository needs no flag.
  assert.deepEqual(w.repos(), [{ repo: "acme/widget", base: "staging" }]);
  assert.equal(configuredBase(readJson(configPath(w.home)), "acme/widget"), "staging");
});

test("--base overrides a configured base for that one start, and is persisted over it", async () => {
  const w = startWorld({ repos: [{ repo: "acme/widget", base: "staging" }], defaultBranch: "main", branches: ["main", "staging", "release"] });
  const r = await start(w.ctx, { path: w.prdPath, base: "release" });
  assert.equal(r.base, "release");
  assert.deepEqual(w.created, [{ nameWithOwner: "acme/widget", prdId: "widget-export", base: "release" }]);
  assert.deepEqual(w.repos(), [{ repo: "acme/widget", base: "release" }]);
});

test("--base on a repository already known does not re-create its labels", async () => {
  // `rememberRepo` returns true whenever it WROTE the file, which now includes retargeting the base of a repository
  // already listed. `start` used that boolean to mean "this repository is new, create its labels", so every `--base`
  // change on a known repository spent an `ensureLabels` call it did not need. The two questions are now asked
  // separately.
  const w = startWorld({ repos: ["acme/widget"], defaultBranch: "main", branches: ["main", "staging"] });
  const labelled = [];
  w.ctx.gh.ensureLabels = async repo => { labelled.push(repo); };
  await start(w.ctx, { path: w.prdPath, base: "staging" });
  assert.deepEqual(labelled, [], "the repository was already known, so nothing is created again");
  assert.deepEqual(w.repos(), [{ repo: "acme/widget", base: "staging" }], "and the base is still recorded");

  // A repository seen for the first time does get them, which is the behaviour this must not break.
  const fresh = startWorld({ repos: [], defaultBranch: "main", branches: ["main", "staging"] });
  const freshLabels = [];
  fresh.ctx.gh.ensureLabels = async repo => { freshLabels.push(repo); };
  await start(fresh.ctx, { path: fresh.prdPath, base: "staging" });
  assert.deepEqual(freshLabels, ["acme/widget"]);
});

test("a base that is not on the remote fails at start, before anything is cloned or spawned", async () => {
  // The whole point of the check. Left to `gh pr create --base`, this fails after a session has implemented the brief,
  // run the tests and spent the budget, with the work stranded on a branch nobody asked for.
  const w = startWorld({ repos: [{ repo: "acme/widget", base: "stagng" }], defaultBranch: "main", branches: ["main", "staging"] });
  await assert.rejects(() => start(w.ctx, { path: w.prdPath }), e => {
    assert.match(e.message, /base branch "stagng" is not on acme\/widget/);
    assert.match(e.message, /repos in config\.json names it/, "and it says where the wrong name came from");
    assert.match(e.message, /Nothing was cloned and nothing was started/);
    return true;
  });
  assert.deepEqual(w.created, [], "no clone");
  assert.deepEqual(w.prompts, [], "no session");
  assert.equal(w.ctx.state.entries().length, 0, "and nothing in the registry");
  assert.deepEqual(w.asked, ["stagng"], "the base was confirmed with GitHub, once");
});

test("a misspelled --base fails at start and is never persisted", async () => {
  const w = startWorld({ repos: [], defaultBranch: "main", branches: ["main"] });
  await assert.rejects(() => start(w.ctx, { path: w.prdPath, base: "staging" }), /--base names it/);
  assert.deepEqual(w.repos(), [], "a base that does not exist is not remembered for next time");
});

// --- the merge, against real git --------------------------------------------------------------------------------

/**
 * Two real repositories on disk: an `origin` with a base branch, and a clone on a feature branch cut from an older
 * commit of it. Real git, because what is being asserted is what git does to a worktree, and a fake would only assert
 * what this test believes git does.
 */
function gitWorld({ conflict = false } = {}) {
  const home = tempHome();
  const origin = join(home, "origin");
  const clone = join(home, "clone");
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } }).trim();
  mkdirSync(origin, { recursive: true });
  git(["init", "-q", "-b", "main", "."], origin);
  writeFileSync(join(origin, "shared.txt"), "one\n");
  git(["add", "."], origin); git(["commit", "-qm", "base one"], origin);
  git(["clone", "-q", origin, clone], home);
  git(["checkout", "-q", "-b", "gallivant/widget-export"], clone);
  // The feature branch's own commit, so the merge is a real merge rather than a fast-forward.
  writeFileSync(join(clone, conflict ? "shared.txt" : "feature.txt"), conflict ? "feature version\n" : "mine\n");
  git(["add", "."], clone); git(["commit", "-qm", "feature work"], clone);
  // The base moves on, touching the same file when a conflict is wanted.
  writeFileSync(join(origin, "shared.txt"), conflict ? "base version\n" : "one\ntwo\n");
  git(["add", "."], origin); git(["commit", "-qm", "base two"], origin);
  const g = makeGit({ config: { home, worktrees: join(home, "wt") }, identity: async () => ({ name: "t", email: "t@e" }) });
  return { home, origin, clone, git, g, head: () => git(["rev-parse", "HEAD"], clone), status: () => git(["status", "--porcelain"], clone) };
}

test("mergeBase brings the base in as a merge commit, and adds to history rather than rewriting it", async () => {
  const w = gitWorld();
  const before = w.head();
  const r = await w.g.mergeBase(w.clone, "main");

  assert.equal(r.merged, true);
  assert.equal(r.base, "main");
  assert.notEqual(r.sha, before, "the head moved");
  // The property that makes this a merge and not a rebase, and the reason no force-push is needed: the commit the
  // reviewer may already have cleared is still an ancestor, so their verdict still describes something that exists.
  assert.equal(w.git(["merge-base", "--is-ancestor", before, "HEAD"], w.clone), "", "the pre-merge head is still an ancestor");
  assert.equal(w.git(["rev-list", "--count", "--merges", `${before}..HEAD`], w.clone), "1", "exactly one merge commit was added");
  assert.equal(w.git(["cat-file", "-p", "HEAD"], w.clone).match(/^parent /gm).length, 2, "with two parents, which is what a merge is");
  assert.equal(w.git(["show", "HEAD:shared.txt"], w.clone), "one\ntwo", "and the base's change is in the tree");
  assert.equal(w.status(), "", "the worktree is clean");
});

test("mergeBase on a branch already on its base is a no-op that commits nothing", async () => {
  const w = gitWorld();
  await w.g.mergeBase(w.clone, "main");
  const after = w.head();
  const again = await w.g.mergeBase(w.clone, "main");
  assert.equal(again.merged, false, "nothing to bring in");
  assert.equal(again.conflict, undefined, "and that is not a failure");
  assert.equal(w.head(), after, "the head did not move");
});

test("a conflicting merge aborts, leaving no conflict markers for a session to be handed", async () => {
  // The failure this ordering exists to prevent: a half-merged checkout handed to a session as if it were clean.
  const w = gitWorld({ conflict: true });
  const before = w.head();
  const r = await w.g.mergeBase(w.clone, "main");

  assert.equal(r.merged, false);
  assert.equal(r.conflict, true);
  assert.equal(r.base, "main");
  assert.ok(r.why, "the reason git gave is carried, so the operator can be told");
  assert.equal(w.head(), before, "the head did not move");
  assert.equal(w.status(), "", "and nothing is left staged, unmerged or half-written");
  assert.doesNotMatch(w.git(["show", "HEAD:shared.txt"], w.clone), /<<<<<<</, "no conflict markers in the tree");
});

// --- the merge in the tick ---------------------------------------------------------------------------------------

/** The tick's world, with a git whose `mergeBase` a test chooses. */
function tickWorld(stateOver = {}, ghOver = {}, { git = fakeGit(), config = CONFIG } = {}) {
  const clock = makeClock();
  const { state, id } = seededState(stateOver);
  const gh = fakeGh(ghOver);
  const runner = fakeRunner(clock);
  const notify = fakeNotify();
  const logged = [];
  const log = { info: m => logged.push(m), warn: m => logged.push(m), error: m => logged.push(m), latest: () => null };
  const tick = makeTick({ config, state, gh, git, notify, log, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, credential: async ({ host = "github.com" } = {}) => ({ token: "t", source: "gh", host }),
    identity: fakeIdentity(), identity: fakeIdentity() });
  return { clock, state, id, gh, runner, notify, tick, logged, entry: () => state.get(id) };
}

test("a fix round merges the base into the branch before the session is spawned", async () => {
  const merges = [];
  const git = { ...fakeGit(), mergeBase: async (dir, base) => { merges.push([dir, base, "merge"]); return { merged: true, base, sha: "m1e2r3g4e", head: "a1b2c3d" }; } };
  const w = tickWorld({ base: "staging" }, { pr: prFixture({ baseRefName: "staging" }), reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.deepEqual(merges, [["/tmp/wt", "staging", "merge"]], "the entry's base, in the entry's worktree");
  assert.equal(w.runner.started.length, 1, "and the round did start");
  // The order matters: the merge is what the session finds when it opens the tree, so it must precede the spawn.
  assert.ok(w.logged.some(l => /merged origin\/staging into gallivant\/widget-export before the run/.test(l)), `expected the merge logged, got ${JSON.stringify(w.logged)}`);
  // Recorded, because an operator debugging a branch needs to know its history was added to and when.
  assert.equal(w.entry().base_merge.base, "staging");
  assert.equal(w.entry().base_merge.sha, "m1e2r3g4e");
  assert.ok(w.entry().base_merge.at);
  // And the session is told, so it does not try to undo a commit that is not its own.
  assert.match(w.runner.started[0].args.at(-1), /origin\/staging` was merged into this branch/);
  assert.match(w.runner.started[0].args.at(-1), /do not rebase or rewrite history/);
});

test("a branch already on its base is not merged, and the prompt says nothing about a merge", async () => {
  const merges = [];
  const git = { ...fakeGit(), mergeBase: async (dir, base) => { merges.push(base); return { merged: false, base }; } };
  const w = tickWorld({ base: "main" }, { reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.deepEqual(merges, ["main"], "it is asked");
  assert.equal(w.runner.started.length, 1, "and the round runs");
  assert.ok(!w.entry().base_merge, "but nothing is recorded, because nothing happened");
  assert.doesNotMatch(w.runner.started[0].args.at(-1), /was merged into this branch/, "and a prompt that claimed a merge would be a lie");
  assert.ok(!w.logged.some(l => /merged origin/.test(l)));
});

test("an entry with no base recorded merges nothing, which is how every pre-existing entry keeps working", async () => {
  const merges = [];
  const git = { ...fakeGit(), mergeBase: async (_d, base) => { merges.push(base); return { merged: true, base, sha: "x" }; } };
  // `base: null` is every entry written before the field existed, and every one `register` builds for a PR whose
  // `baseRefName` could not be read. Nothing to merge is a round that behaves exactly as it did before.
  const w = tickWorld({ base: null }, { pr: prFixture({ baseRefName: null }), reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();
  assert.deepEqual(merges, [], "no base, no merge");
  assert.equal(w.runner.started.length, 1, "and the round still runs");
});

test("a conflicting merge stops the entry, names the base, and spawns nothing", async () => {
  const git = { ...fakeGit(), mergeBase: async (_d, base) => ({ merged: false, conflict: true, base, why: "CONFLICT (content): Merge conflict in src/a.ts" }) };
  const w = tickWorld({ base: "staging" }, { pr: prFixture({ baseRefName: "staging" }), reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.runner.started.length, 0, "no session is handed a tree that could not be merged");
  assert.equal(w.entry().state, STATES.needsHuman);
  assert.equal(w.entry().reason, "base-conflict", "a reason of its own, not the PR-level `conflict`");
  assert.equal(w.entry().base_merge.conflict, true);
  assert.equal(w.entry().base_merge.base, "staging");
  assert.match(w.entry().last.event, /cannot merge origin\/staging into gallivant\/widget-export/);
  assert.match(w.entry().base_merge.why, /Merge conflict in src\/a\.ts/);
  assert.deepEqual(w.notify.sent, [["needs", 142, "base-conflict"]], "and the operator is rung once");
  // The cursor is untouched: the feedback that would have started this round is still new, so it is acted on once the
  // conflict is resolved rather than lost to a cursor that moved for a round that never ran.
  assert.equal(w.entry().cursor.since, T0);
  assert.equal(w.entry().iteration, 0, "and no round is charged for a run that never started");
});

test("a merge that happened is recorded even when a later step of the dispatch declines", async () => {
  // The bug: the merge is a durable change to a checkout on disk, and four things after it can return early (the
  // ready-label write, a busy runner, a missing credential, a refused context_paths). A merge recorded only by the save
  // at the end of `dispatch` would have happened with nothing on the entry to say so, which is precisely what an
  // operator debugging the branch needs. So the record is written the moment the merge succeeds.
  const git = { ...fakeGit(), mergeBase: async (_d, base) => ({ merged: true, base, sha: "m1e2r3g4e5", head: "a1b2c3d" }) };
  const w = tickWorld({ base: "staging", state: STATES.ready }, {
    pr: prFixture({ baseRefName: "staging" }),
    reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })],
  }, { git });
  // The ready-label removal is the step that declines a dispatch, and it is reached after the merge.
  w.gh.removeLabel = async () => { throw new Error("Resource not accessible by personal access token"); };
  w.clock.advance(6);
  await w.tick.tick();

  assert.equal(w.runner.started.length, 0, "the dispatch declined, as it should when the label will not come off");
  assert.equal(w.entry().base_merge.base, "staging", "and the merge that DID happen is on the entry anyway");
  assert.equal(w.entry().base_merge.sha, "m1e2r3g4e5");
  assert.ok(w.entry().retry, "the declining write is still counted, so the wait is still bounded");
});

test("a merge failure that is not a conflict is treated the same way: stop, name the base, spawn nothing", async () => {
  // A fetch that cannot reach the remote, a rev-parse against a base that is gone. Nothing was merged and the tree is
  // untouched, so the outcome for this round is the same as a conflict's, and retrying every tick would never resolve.
  const git = { ...fakeGit(), mergeBase: async () => { throw new Error("fatal: couldn't find remote ref staging"); } };
  const w = tickWorld({ base: "staging" }, { pr: prFixture({ baseRefName: "staging" }), reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.runner.started.length, 0);
  assert.equal(w.entry().reason, "base-conflict");
  assert.match(w.entry().base_merge.why, /couldn't find remote ref staging/);
});

test("an outstanding review does not hold the merge up, and the merge does not force-push", async () => {
  // This is the conclusion about an outstanding review, asserted rather than asserted in a comment. A rebase would have
  // had to wait for the reviewer, because it would strand the sha their clearance names, and waiting is a deadlock: the
  // reviewer is waiting for a fix and the fix is waiting for the reviewer. A merge keeps every reviewed commit an
  // ancestor, so there is nothing to wait for.
  const merges = [];
  const git = { ...fakeGit(), mergeBase: async (_d, base) => { merges.push(base); return { merged: true, base, sha: "m1e2r3g", head: "a1b2c3d" }; } };
  const w = tickWorld({ base: "staging", rereview: { at: at(1), nudged: false } }, {
    pr: prFixture({ baseRefName: "staging" }),
    // The reviewer has looked at the current head and asked for changes: a review is outstanding on this very commit.
    reviews: [review({ id: 7, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5), body: "**Reviewed commit:** `a1b2c3d`\n\nP1: fix the nonce" })],
  }, { git });
  w.clock.advance(6);
  await w.tick.tick();

  assert.deepEqual(merges, ["staging"], "the merge happens with a review outstanding");
  assert.equal(w.runner.started.length, 1);
  // Nothing anywhere in the run's argv or environment asks git to force anything. The merge is the daemon's own act on
  // a local commit; the push is still the session's, and the RULES it is given forbid a force-push.
  const run = w.runner.started[0];
  const argv = run.args.join(" ");
  assert.doesNotMatch(argv, /--force|push -f|force-with-lease/, "no force-push is arranged anywhere in the run");
  assert.match(argv, /Do not force-push, and do not rebase/, "and the session is still told not to");
  // The head on GitHub did not move, so the loop does not read its own merge as a stranger's push: `fixed_sha` follows
  // the head the round was dispatched against, and the reviewer clock is not reset by the merge.
  assert.equal(w.entry().cursor.fixed_sha, "a1b2c3d", "the merge is local until the session pushes");
});

test("the tick learns the base from the PR, so a retargeted PR is merged against the branch it now targets", async () => {
  const merges = [];
  const git = { ...fakeGit(), mergeBase: async (_d, base) => { merges.push(base); return { merged: false, base }; } };
  // A reviewer moved the PR from main to staging. GitHub is the only authority on where a PR is aimed.
  const w = tickWorld({ base: "main" }, { pr: prFixture({ baseRefName: "staging" }), reviews: [review({ id: 1, by: BOT, bot: true, state: "CHANGES_REQUESTED", at: at(5) })] }, { git });
  w.clock.advance(6);
  await w.tick.tick();
  assert.equal(w.entry().base, "staging");
  assert.deepEqual(merges, ["staging"], "and the merge follows the PR, not the entry's memory");
  assert.ok(w.logged.some(l => /base branch is staging, was main/.test(l)));
});

// --- resume ------------------------------------------------------------------------------------------------------

function resumeWorld(entryOver = {}, { git = {} } = {}) {
  const home = tempHome();
  const state = makeState(home);
  const clock = makeClock();
  const id = "acme/widget/widget-export";
  state.put(id, {
    prd: "docs/prds/widget-export.md", harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111",
    repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, base: "staging",
    url: "https://github.com/acme/widget/pull/142", state: STATES.needsHuman, reason: "no-push", iteration: 1,
    cursor: { since: T0, dispatched: [], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: null },
    rereview: { at: T0, nudged: false }, retry: null, last: null, checkout: null, prd_fingerprint: null, prd_decision: null,
    created_at: T0, updated_at: T0, ...entryOver,
  });
  const runner = fakeRunner(clock);
  const logged = [];
  const ctx = {
    home, config: { ...CONFIG, home, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") } } }, state,
    log: { info: m => logged.push(m), warn: m => logged.push(m), error: m => logged.push(m), latest: () => null },
    git: { exists: () => true, fromBranch: async ({ path }) => path, unpushed: async () => [], mergeBase: async (_d, base) => ({ merged: false, base }), ...git },
    gh: fakeGh(), notify: fakeNotify(), runnerFor: () => runner, readPrd: () => GOOD_PRD, writePrd: () => {},
    credential: async ({ host = "github.com" } = {}) => ({ token: "t", source: "gh", host }),
    identity: fakeIdentity(),
  };
  return { home, id, ctx, state, runner, logged, entry: () => state.get(id) };
}

test("resume merges the base in before carrying on, and tells the session about the commit it will find", async () => {
  // `resume` is where a branch is most likely to have drifted: the entry stopped hours or days ago.
  const merges = [];
  const w = resumeWorld({}, { git: {
    mergeBase: async (dir, base) => { merges.push([dir, base]); return { merged: true, base, sha: "m1e2r3g4", head: "a1b2c3d" }; },
    // The merge commit is one of the unpushed commits, which is why the merge has to happen before this is read.
    unpushed: async () => [{ sha: "m1e2r3g4", subject: "Merge origin/staging into gallivant/widget-export" }],
  } });
  const r = await resume(w.ctx, { handle: "widget#142" });

  assert.deepEqual(merges, [["/tmp/wt", "staging"]]);
  assert.equal(w.entry().base_merge.base, "staging");
  assert.equal(w.entry().base_merge.sha, "m1e2r3g4");
  const prompt = w.runner.started[0].args.at(-1);
  assert.match(prompt, /origin\/staging` was merged into this branch/);
  assert.match(prompt, /That merge commit is the daemon's, not yours/);
  // The merge note precedes the unpushed list, because that list names the merge commit and a session told afterwards
  // would already have read "do not rewrite these" without knowing which of them is not its own.
  assert.ok(prompt.indexOf("was merged into this branch") < prompt.indexOf("already made and NOT yet pushed"), "the merge is explained before the commit list that contains it");
  assert.ok(r.run);
});

test("resume refuses on a conflicting merge, resumes nothing, and says how to resolve it", async () => {
  const w = resumeWorld({}, { git: { mergeBase: async (_d, base) => ({ merged: false, conflict: true, base, why: "CONFLICT (content): Merge conflict in src/a.ts" }) } });
  await assert.rejects(() => resume(w.ctx, { handle: "widget#142" }), e => {
    assert.match(e.message, /cannot be merged with origin\/staging/);
    assert.match(e.message, /Nothing was resumed, and the checkout was left clean/);
    assert.match(e.message, /git merge origin\/staging/, "and the operator is given the command");
    return true;
  });
  assert.equal(w.runner.started.length, 0, "nothing was spawned");
  assert.equal(w.entry().state, STATES.needsHuman, "and the entry was left as it was");
  assert.equal(w.entry().reason, "no-push");
});

// --- what the operator sees ---------------------------------------------------------------------------------------

test("status and why show the base a PR will target, and a merge that changed the branch's history", () => {
  const { state, id } = seededState({
    base: "staging",
    base_merge: { at: at(3), base: "staging", sha: "m1e2r3g4e5f6", onto: "a1b2c3d" },
  });
  const ctx = { home: tempHome(), config: CONFIG, state, runnerFor: () => fakeRunner(makeClock()), log: silentLog, readPrd: () => null };

  const m = statusModel(ctx);
  const row = [...m.needs_you, ...m.running, ...m.done].find(r => r.id === id);
  assert.equal(row.base, "staging", "the model carries it, so --json and the tracker get it too");
  assert.equal(row.base_merge.base, "staging");
  assert.match(statusRender(m, { clock: { now: () => Date.parse(at(10)) } }), /-> staging/, "and the text view prints it");

  const text = why(ctx, { handle: "widget#142" });
  assert.match(text, /base: staging/);
  assert.match(text, /the branch this PR targets, and the one merged in before each round/);
  assert.match(text, /base merge: origin\/staging was merged into gallivant\/widget-export/);
  assert.match(text, /as m1e2r3g/);
  assert.match(text, /History was added to, never rewritten: no rebase, no force-push/);
});

test("why reports a merge that failed, and says the checkout was left clean", () => {
  const { state, id } = seededState({
    base: "staging", state: STATES.needsHuman, reason: "base-conflict",
    base_merge: { at: at(3), base: "staging", conflict: true, why: "CONFLICT (content): Merge conflict in src/a.ts" },
  });
  const ctx = { home: tempHome(), config: CONFIG, state, runnerFor: () => fakeRunner(makeClock()), log: silentLog, readPrd: () => null };
  const text = why(ctx, { handle: "widget#142" });
  assert.match(text, /base merge FAILED/);
  assert.match(text, /origin\/staging could not be merged into gallivant\/widget-export/);
  assert.match(text, /Merge conflict in src\/a\.ts/);
  assert.match(text, /The merge was aborted, so the checkout is clean/);
});

test("an entry with no base prints no base line, so a recovered PR is not told a branch it does not have", () => {
  const { state } = seededState({ base: null });
  const ctx = { home: tempHome(), config: CONFIG, state, runnerFor: () => fakeRunner(makeClock()), log: silentLog, readPrd: () => null };
  const text = why(ctx, { handle: "widget#142" });
  assert.doesNotMatch(text, /^base:/m);
  assert.doesNotMatch(text, /base merge/);
});

// --- the prompts, on their own ------------------------------------------------------------------------------------

test("every prompt forbids a rebase as well as a force-push, because the daemon owns the merge now", () => {
  const prd = { text: GOOD_PRD, id: "widget-export" };
  for (const p of [
    startPrompt({ prd, repo: "acme/widget", branch: "gallivant/widget-export", base: "staging", verify: ["npm test"] }),
    fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [] }),
    resumePrompt({ repo: "acme/widget", pr: 1, reason: "no-push" }),
  ]) {
    assert.match(p, /Do not force-push, and do not rebase/);
    assert.match(p, /keeping this branch on its base is done for you/);
  }
});

/**
 * The stash rule, in all three prompts. A live run used `git stash push -u` and `git stash pop` to check whether a test
 * failure was pre-existing. Nothing forbade it, and the stash stack is shared by every worktree of the repository: the
 * operator works in those repositories by hand and other sessions run in their own worktrees, so a pop here can land a
 * stranger's entry in this tree and a `push -u` sweeps up untracked files. A session killed between the two leaves the
 * operator's tree changed with nothing in the run's state recording it.
 *
 * The alternatives are asserted with the prohibition because the question the session was asking was a good one. A rule
 * that only says no gets worked around, which is exactly what happened when a blocked command became a wrapper script.
 */
test("every prompt forbids git stash and names what to do instead", () => {
  const prd = { text: GOOD_PRD, id: "widget-export" };
  for (const p of [
    startPrompt({ prd, repo: "acme/widget", branch: "gallivant/widget-export", base: "staging", verify: ["npm test"] }),
    fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [] }),
    resumePrompt({ repo: "acme/widget", pr: 1, reason: "no-push" }),
  ]) {
    assert.match(p, /Do not run `git stash` in any form/);
    assert.match(p, /shared by every worktree of this repository/, "and the reason, so it does not read as an arbitrary ban");
    assert.match(p, /git worktree add <temp path> <base>/, "with the alternative that answers the question it was used for");
    assert.match(p, /git show <base>:<path>/);
  }
});

/**
 * The rule that a denial is a boundary. A live run hit a blocked-pattern rule on the literal names of two env vars set
 * inline, so it wrote a shell script that set the same vars and ran it five times. Nothing it did was forbidden in
 * isolation; the block was treated as a puzzle, which is what an agent measured on finishing will do to any obstacle
 * unless told otherwise. The rule has to say what a denial IS, and it has to ask for a report, because a block that
 * fires on a legitimate call is a bug the operator can only fix if they hear about it.
 */
test("every prompt says a guardrail denial is a boundary and asks for a report instead of a way around it", () => {
  const prd = { text: GOOD_PRD, id: "widget-export" };
  for (const p of [
    startPrompt({ prd, repo: "acme/widget", branch: "gallivant/widget-export", base: "staging", verify: ["npm test"] }),
    fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [] }),
    resumePrompt({ repo: "acme/widget", pr: 1, reason: "no-push" }),
  ]) {
    assert.match(p, /A denied tool call is a boundary, not an obstacle/);
    assert.match(p, /do not write a wrapper script, re-spell the command, move it into a file/, "the routes around it are named, because the run that did this took one of them");
    assert.match(p, /say in your final message what was blocked and what you were trying to do/, "and the honest response is spelled out");
    assert.match(p, /The block may well be wrong/, "worded so a correct instinct to verify is not read as forbidden");
    assert.match(p, /supported approval\/escalation request/);
    assert.match(p, /If the reviewer or a guardrail denies it, stop and report the denial/);
    assert.match(p, /Do not change permissions, move Git metadata, or bypass the sandbox/);
    assert.match(p, /push can exit zero even when writing local tracking metadata failed/);
  }
});

test("the merge note is only in a prompt for a run that actually got one", () => {
  const withMerge = fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [], merged: { base: "staging", sha: "m1e2r3g4" } });
  assert.match(withMerge, /`origin\/staging` was merged into this branch \(commit m1e2r3g\)/);
  assert.doesNotMatch(fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [] }), /was merged into this branch/);
});
