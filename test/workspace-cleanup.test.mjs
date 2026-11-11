import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, lstatSync, symlinkSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupMergedWorkspace, removeOwnedDirectory } from "../lib/workspace_cleanup.mjs";
import { makeGit } from "../lib/git.mjs";
import { createReviewService } from "../lib/first_party_review.mjs";
import { reviewDigest } from "../lib/review_policy.mjs";
import { makeTick } from "../lib/tick.mjs";
import { runtimeEnvironment, prepareRuntimeCache } from "../lib/runtime-environment.mjs";
import { CONFIG, T0, at, fakeGh, fakeGit, fakeRunner, fakeNotify, makeClock, prFixture, seededState, silentLog, STATES } from "./helpers.mjs";

function fixture(t, repo = "acme/widget") {
  const home = mkdtempSync(join(tmpdir(), "workspace-cleanup-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const worktrees = join(home, "worktrees"), path = join(worktrees, repo, "task");
  mkdirSync(path, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd: path, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  git("init", "-b", "main");
  writeFileSync(join(path, ".gitignore"), "node_modules/\n");
  writeFileSync(join(path, "app.txt"), "base\n");
  git("add", "."); git("commit", "-m", "Base"); git("checkout", "-b", "work/task");
  writeFileSync(join(path, "app.txt"), "feature\n"); git("add", "."); git("commit", "-m", "Feature");
  const origin = repo.startsWith("bitbucket.org/") ? `https://${repo}.git` : `https://github.com/${repo}.git`;
  git("remote", "add", "origin", origin);
  const head = git("rev-parse", "HEAD"), id = `${repo}/task`;
  const entry = { repo, worktree: path, branch: "work/task", base: "main", pr: 1, state: STATES.ready };
  const pr = { state: "MERGED", headRefOid: head };
  const config = { ...CONFIG, home, worktrees };
  let reviewCalls = 0;
  const ctx = { config, state: { entries: () => [[id, entry]], chains: () => [], update: (_id, patch) => Object.assign(entry, patch) },
    git: makeGit({ config }), runnerFor: () => ({ current: () => null }),
    reviewService: { cleanup: async () => { reviewCalls++; return { status: "done" }; } } };
  return { ctx, entry, pr, id, path, home, git, reviewCalls: () => reviewCalls };
}

test("confirmed merged clones are removed for both hosts; durable evidence survives and cleanup is idempotent", async t => {
  for (const repo of ["acme/widget", "bitbucket.org/acme/widget"]) {
    const w = fixture(t, repo), evidence = join(w.home, "evidence.json");
    writeFileSync(evidence, "immutable receipt");
    mkdirSync(join(w.path, "node_modules", "large-package"), { recursive: true });
    writeFileSync(join(w.path, "node_modules", "large-package", "generated"), "cache");
    const env = runtimeEnvironment(process.env, process.execPath, w.path); prepareRuntimeCache(w.path, env);
    const scratch = execFileSync(process.execPath, ["-e", "const fs=require('fs'),os=require('os'),path=require('path');const p=fs.mkdtempSync(path.join(os.tmpdir(),'fixture-'));fs.writeFileSync(path.join(p,'output'),'scratch');process.stdout.write(p)"], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.ok(existsSync(scratch));
    assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "done");
    assert.equal(existsSync(w.path), false);
    assert.equal(existsSync(scratch), false);
    assert.throws(() => lstatSync(env.TMPDIR), { code: "ENOENT" });
    assert.equal(readFileSync(evidence, "utf8"), "immutable receipt");
    assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "done");
  }
});

test("local edits, untracked files, unpublished branches, stashes and Git locks preserve the whole clone", async t => {
  for (const change of [
    w => writeFileSync(join(w.path, "app.txt"), "unfinished fix"),
    w => writeFileSync(join(w.path, "notes.md"), "unpublished notes"),
    w => { w.git("update-index", "--assume-unchanged", "app.txt"); writeFileSync(join(w.path, "app.txt"), "hidden local work"); },
    w => { w.git("checkout", "-b", "unfinished"); writeFileSync(join(w.path, "extra"), "work"); w.git("add", "."); w.git("commit", "-m", "Unpublished"); w.git("checkout", "work/task"); },
    w => { writeFileSync(join(w.path, "app.txt"), "stashed"); w.git("stash", "push"); },
    w => writeFileSync(join(w.path, ".git", "index.lock"), "locked"),
    w => { w.git("commit", "--allow-empty", "-m", "Later head"); },
    w => w.git("remote", "set-url", "origin", "https://github.com/other/repository.git"),
  ]) {
    const w = fixture(t); change(w);
    assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "retained");
    assert.equal(existsSync(w.path), true); assert.equal(w.reviewCalls(), 0);
  }
});

test("cleanup Git probes never execute worker-defined fsmonitor hooks or clean/process filters", async t => {
  const w = fixture(t), marker = join(w.home, "callback-executed"), script = join(w.path, ".git", "worker-callback");
  writeFileSync(join(w.path, ".gitattributes"), "app.txt filter=probe\n");
  w.git("add", ".gitattributes"); w.git("commit", "-m", "Attributes");
  writeFileSync(script, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)},'executed');process.stdin.pipe(process.stdout);\n`, { mode: 0o755 });
  for (const key of ["core.fsmonitor", "filter.probe.clean", "filter.probe.process"]) w.git("config", key, script);
  const later = new Date(Date.now() + 2000); utimesSync(join(w.path, "app.txt"), later, later);
  const proof = await w.ctx.git.cleanupProof(w.path);
  assert.equal(proof.dirty, false); assert.equal(existsSync(marker), false);
});

test("operator paths, shared task inputs, chain inputs, linked worktrees and symlink ancestors are preserved", async t => {
  for (const change of [
    w => { w.entry.checkout = w.path; },
    w => { w.ctx.state.entries = () => [[w.id, w.entry], ["other/task", { checkout: w.path }]]; },
    w => { w.ctx.state.chains = () => [["chain", { steps: [{ path: join(w.path, "next.md") }] }]]; },
    w => { w.entry.worktree = w.home; },
    w => { rmSync(join(w.path, ".git"), { recursive: true }); writeFileSync(join(w.path, ".git"), "gitdir: elsewhere"); },
    w => { const outside = join(w.home, "outside"); mkdirSync(outside); rmSync(w.path, { recursive: true }); symlinkSync(outside, w.path, "dir"); },
  ]) {
    const w = fixture(t); change(w);
    const result = await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr);
    assert.notEqual(result.status, "done"); assert.equal(existsSync(w.path), true);
  }
  const w = fixture(t), outside = join(w.home, "outside"); mkdirSync(outside);
  symlinkSync(outside, join(w.home, "link"), "dir");
  await assert.rejects(removeOwnedDirectory(w.home, "link/anything"), /owned regular directory/);
  await assert.rejects(removeOwnedDirectory(w.home, "../outside"), /unsafe cleanup/);
});

test("live, uncollected and ambiguously ended author/reviewer work defers cleanup; failed I/O can retry", async t => {
  const w = fixture(t);
  for (const run of [{ running: true }, { running: false, exit: null }, { exit: 0, execution: { providerState: "succeeded", collected: false } }]) {
    w.ctx.runnerFor = () => ({ current: () => run });
    assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "pending");
  }
  w.ctx.runnerFor = () => ({ current: () => null });
  w.ctx.reviewService.cleanup = async () => ({ status: "pending", reason: "reviewer still running" });
  assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "pending");
  w.ctx.reviewService.cleanup = async () => { throw Object.assign(new Error("full"), { code: "ENOSPC" }); };
  assert.match((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).reason, /ENOSPC/);
  assert.equal(existsSync(w.path), true);
  w.ctx.reviewService.cleanup = async () => ({ status: "done" });
  assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "done");
});

test("open and closed-without-merge PRs never delete a checkout", async t => {
  const w = fixture(t);
  for (const state of ["OPEN", "CLOSED"]) {
    assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, { ...w.pr, state })).status, "retained");
    assert.equal(existsSync(w.path), true); assert.equal(w.reviewCalls(), 0);
  }
});

test("interrupted deletion retries only its approved directory inode", async t => {
  const w = fixture(t), path = realpathSync(w.path), stat = lstatSync(path);
  w.entry.workspace_cleanup = { head: w.pr.headRefOid, pr: w.entry.pr, removal: { path, dev: stat.dev, ino: stat.ino } };
  rmSync(join(path, ".git"), { recursive: true });
  assert.equal((await cleanupMergedWorkspace(w.ctx, w.id, w.entry, w.pr)).status, "done");
  const changed = fixture(t), actual = realpathSync(changed.path), original = lstatSync(actual);
  changed.entry.workspace_cleanup = { head: changed.pr.headRefOid, pr: changed.entry.pr, removal: { path: actual, dev: original.dev, ino: original.ino + 1 } };
  writeFileSync(join(actual, "app.txt"), "new local work");
  assert.equal((await cleanupMergedWorkspace(changed.ctx, changed.id, changed.entry, changed.pr)).status, "retained");
  assert.equal(existsSync(actual), true);
});

test("review cleanup removes only recorded settled preparation directories, retaining metadata and unknown work", async t => {
  const home = mkdtempSync(join(tmpdir(), "workspace-cleanup-review-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const id = "acme/widget/task", digest = reviewDigest(id), key = "a".repeat(64), root = join(home, "reviews");
  const path = join(root, digest, key), unknown = join(root, digest, "unknown"), file = join(root, `${digest}.json`);
  mkdirSync(path, { recursive: true }); mkdirSync(unknown); writeFileSync(join(path, "generated"), "large workspace");
  const job = { key, status: "completed", run: "run-1" };
  writeFileSync(file, JSON.stringify({ id, jobs: { [key]: job } }));
  let current = { id: "run-1", running: true, exit: null };
  const service = createReviewService({ home, config: CONFIG, executionFor: () => ({ current: () => current }) });
  assert.equal((await service.cleanup(id)).status, "pending"); assert.equal(existsSync(path), true);
  current = { id: "run-1", running: false, exit: 0 };
  assert.equal((await service.cleanup(id)).status, "done"); assert.equal(existsSync(path), false);
  assert.equal(existsSync(unknown), true); assert.equal(JSON.parse(readFileSync(file)).jobs[key].status, "completed");
  assert.equal((await service.cleanup(id)).status, "done");
  job.run = null; job.status = "failed"; writeFileSync(file, JSON.stringify({ id, jobs: { [key]: job } }));
  current = { id: "ambiguous-launch", running: true, exit: null };
  assert.equal((await service.cleanup(id)).status, "pending");
});

test("terminal cleanup collects exited running and launch-intent reviewers without dispatching replacements", async t => {
  for (const status of ["running", "launch-intent"]) {
    const home = mkdtempSync(join(tmpdir(), "workspace-cleanup-review-settle-")); t.after(() => rmSync(home, { recursive: true, force: true }));
    const id = "acme/widget/task", key = "a".repeat(64), root = join(home, "reviews"), file = join(root, `${reviewDigest(id)}.json`);
    const path = join(root, reviewDigest(id), key); mkdirSync(path, { recursive: true });
    const clock = makeClock(), now = clock.now();
    writeFileSync(file, JSON.stringify({ id, jobs: { [key]: { key, status, run: status === "running" ? "run-1" : null, startedAt: now, deadline: now + 60_000, evidence: {} } } }));
    const current = { id: "run-1", name: `review-${key}`, running: false, exit: 0, endedAt: now + 100 };
    const runner = { current: () => current, settle: () => current, lines: () => [], outcome: () => ({ ok: true, lastMessage: "invalid report remains a failed review" }),
      start: () => assert.fail("no replacement"), submit: () => assert.fail("no replacement"), cancel: () => assert.fail("exited process must not be cancelled") };
    const service = createReviewService({ home, config: CONFIG, executionFor: () => runner }, { clock });
    assert.equal((await service.cleanup(id)).status, "done"); assert.equal(existsSync(path), false);
    const saved = JSON.parse(readFileSync(file)).jobs[key]; assert.equal(saved.status, "incomplete"); assert.equal(saved.run, "run-1");
  }
});

test("the terminal tick waits for cleanup, retries without an agent, and only then records done", async () => {
  const { state, id } = seededState(); const gh = fakeGh({ pr: prFixture({ state: "MERGED" }) });
  const clock = makeClock(), runner = fakeRunner(clock); let calls = 0;
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
    ownLogin: "me", runnerFor: () => runner, readPrd: () => null,
    cleanupMergedWorkspace: async () => { assert.notEqual(state.get(id).state, STATES.done); calls++; return { status: calls === 1 ? "pending" : "done", reason: "transient I/O" }; } });
  await tick.tick(); assert.notEqual(state.get(id).state, STATES.done); assert.equal(state.get(id).workspace_cleanup.status, "pending");
  assert.equal(state.get(id).completionEvidence, undefined, "pending cleanup must not publish terminal completion evidence");
  await tick.tick(); assert.equal(state.get(id).state, STATES.done); assert.equal(state.get(id).workspace_cleanup.status, "done");
  await tick.tick(); assert.equal(calls, 2); assert.equal(runner.started.length, 0);
});

test("backfill observes at most four old tasks per tick, without provider reconciliation", async () => {
  const { state, id } = seededState({ state: STATES.done }); const initial = state.get(id);
  for (let i = 1; i < 7; i++) state.put(`${id}-${i}`, { ...initial, pr: 142 + i });
  const gh = fakeGh({ pr: prFixture({ state: "MERGED" }) }), clock = makeClock(); let cleaned = 0;
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
    runnerFor: () => { throw new Error("terminal cleanup must not reconcile providers"); }, readPrd: () => null,
    cleanupMergedWorkspace: async () => { cleaned++; return { status: "done" }; } });
  await tick.tick(); assert.equal(cleaned, 4);
  await tick.tick(); assert.equal(cleaned, 7);
  await tick.tick(); assert.equal(cleaned, 7);
});

test("cleanup backfill preserves the original integration decision and meaningful activity time", async () => {
  const proof = { integration: { qualified: true, head: "a1b2c3d", reason: null } };
  const { state, id } = seededState({ state: STATES.done, activity_at: T0, completionEvidence: proof });
  const clock = makeClock(at(20)), gh = fakeGh({ pr: prFixture({ state: "MERGED" }) });
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
    runnerFor: () => fakeRunner(clock), readPrd: () => null, cleanupMergedWorkspace: async () => ({ status: "done" }) });
  await tick.tick(); assert.deepEqual(state.get(id).completionEvidence, proof); assert.equal(state.get(id).activity_at, T0);
});

test("settled cleanup still drains the accepted-run learning outbox after a transient store failure", async () => {
  const delivery = { repo: "acme/widget", key: "advice", runId: "accepted-run" };
  const { state, id } = seededState({ state: STATES.done, workspace_cleanup: { status: "done" }, learning_deliveries: { audit: delivery } });
  const clock = makeClock(); let locked = true, calls = 0;
  const learning = { identityFor: () => null, delivered: async () => { calls++; if (locked) throw new Error("store locked"); return { delivered: true }; } };
  const tick = makeTick({ config: CONFIG, state, gh: fakeGh(), git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, learning,
    runnerFor: () => assert.fail("no provider work for a settled task"), readPrd: () => null, cleanupMergedWorkspace: async () => assert.fail("already cleaned") });
  await tick.tick(); assert.deepEqual(state.get(id).learning_deliveries.audit, delivery);
  locked = false; await tick.tick(); assert.deepEqual(state.get(id).learning_deliveries, {}); assert.equal(calls, 2);
});

test("delivery-ready tasks can observe a later merge for cleanup without restarting implementation", async () => {
  const { state, id } = seededState({ state: STATES.ready, task: { completion: { version: 1, target: "delivery_ready" } },
    completionEvidence: { delivery: { repository: "acme/widget", pr: 142, head: "a1b2c3d", base: "main", gate: { allow: true } } } });
  const gh = fakeGh(), clock = makeClock(), runner = fakeRunner(clock); let calls = 0;
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
    runnerFor: () => runner, readPrd: () => null, cleanupMergedWorkspace: async () => { calls++; return { status: "done" }; } });
  await tick.tick(); assert.equal(calls, 0); assert.equal(gh.calls.filter(c => c[0] === "prView").length, 1);
  await tick.tick(); assert.equal(gh.calls.filter(c => c[0] === "prView").length, 1);
  gh.data.pr.state = "MERGED"; clock.advance(CONFIG.poll_seconds / 60);
  await tick.tick(); assert.equal(calls, 1); assert.equal(state.get(id).state, STATES.done); assert.equal(runner.started.length, 0);
});

test("an unproved merge into the approved base cannot authorize cleanup", async () => {
  const head = "a".repeat(40);
  const { state, id } = seededState({ cursor: { fixed_sha: head, since: T0 } });
  const gh = fakeGh({ pr: prFixture({ state: "MERGED", strictIdentity: true, headRefOid: head, isCrossRepository: false, mergedAt: at(2), mergeCommit: { oid: "f".repeat(40) } }) });
  gh.containsCommit = async () => false;
  const clock = makeClock(); let calls = 0;
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
    runnerFor: () => fakeRunner(clock), readPrd: () => null, cleanupMergedWorkspace: async () => { calls++; return { status: "done" }; } });
  await tick.tick(); assert.equal(calls, 0); assert.equal(state.get(id).reason, "pr-identity");
});
