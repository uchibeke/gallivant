import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeGit } from "../lib/git.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { makeState, newEntry } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { cleanupMergedWorkspace } from "../lib/workspace_cleanup.mjs";
import { requestControl } from "../lib/control.mjs";
import { why } from "../lib/commands/why.mjs";
import { makeHostRegistry } from "../lib/hosts.mjs";
import { contentDigest } from "../lib/hash.mjs";
import { actionsRepairEvidence } from "../lib/hosts/github_actions_status.mjs";
import { planOverlayMoves, relocateOverlays, restoredOverlay } from "../lib/workspace_recovery.mjs";
import { recoveryDigest } from "../lib/recovery_digest.mjs";
import { acceptedRecovery, planRecovery } from "../lib/recovery_recipes.mjs";
import { admitFixture } from "./recovery-recipe-fixture.mjs";
import { CONFIG, GOOD_PRD, T0, at, tempHome, makeClock, fakeRunner, fakeGh, fakeNotify, fakeCredential, fakeIdentity,
  silentLog, prFixture, claudeResultLines, STATES } from "./helpers.mjs";

const fail = () => Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
const mkdir = dir => fs.mkdirSync(dir, { recursive: true });
const write = (file, content) => { mkdir(dirname(file)); fs.writeFileSync(file, content); };
const approvedOverlay = "Planning context with no identity wiring.\n";
const wired = "export const role = request => request.identity.role;\n";
const session = "6f1c2d3e-1111-4111-8111-111111111111";
const file = "app.mjs", source = "identity.mjs", prd = "docs/prds/widget-export.md", branch = "work/repair";
const initial = "export const score = n => n;\n";
const task = "export const score = n => n + 1;\n";
const baseChange = "export const score = n => Math.max(0, n);\n";
const combined = "export const score = n => Math.max(0, n) + 1;\n";

function scratch(t) {
  const dir = fs.realpathSync(tempHome());
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function world(t, { ci = false, overlay = true } = {}) {
  const home = scratch(t), origin = join(home, "remote"), tree = join(home, "trees", "task"), local = join(home, "registry"), operator = join(home, "operator");
  mkdir(origin); mkdir(dirname(tree)); mkdir(local); mkdir(operator);
  const g = (args, cwd = tree) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  const commit = (content, dir = tree, path = file) => {
    write(join(dir, path), content); g(["add", "--", path], dir); g(["commit", "-qm", "Write fixture change"], dir);
    return g(["rev-parse", "HEAD"], dir);
  };
  g(["init", "-q", "-b", "main"], origin);
  const start = commit(initial, origin);
  g(["clone", "-q", origin, tree], home);
  g(["checkout", "-qb", branch]);
  const head = commit(task);
  g(["push", "-q", "origin", branch]);
  if (!ci) {
    commit(baseChange, origin);
    if (overlay) commit(wired, origin, source);
  }
  const base = g(["rev-parse", "HEAD"], origin);
  const clock = makeClock(at(6)), raw = fakeRunner(clock);
  const startRun = raw.start;
  raw.start = (name, cmd, args, options) => {
    const job = startRun(name, cmd, args, options);
    raw.started.at(-1).id = options.runId;
    return { ...job, id: options.runId };
  };
  const text = GOOD_PRD.replace("status: ready", `status: ready\nimplementation_targets: [${file}]`).replace(/## Verify[\s\S]*$/, "## Verify\n\n- node --check app.mjs\n");
  for (const dir of [tree, operator]) {
    write(join(dir, prd), text);
    if (overlay && !ci) write(join(dir, source), approvedOverlay);
  }
  const state = makeState(local), id = "acme/widget/widget-export";
  state.put(id, { ...newEntry({ repo: "acme/widget", prd, harness: "claude", session, branch, worktree: tree,
    pr: 142, state: STATES.prOpen, nowIso: T0 }), host: "github.com", url: "https://github.com/acme/widget/pull/142",
    base: "main", checkout: operator, sources: overlay && !ci ? [source] : [], cursor: { since: T0, dispatched: [], fixed_sha: head, checks_sha: head },
    review_readiness: { head }, completionEvidence: { delivery: { head, gate: { allow: true } } } });
  const gh = fakeGh({ pr: prFixture({ headRefName: branch, headRefOid: head, baseRefOid: base, mergeable: ci ? "MERGEABLE" : "CONFLICTING" }) });
  gh.repoPermissions = async () => ({ pullRequestCreate: "proved", apiRepositoryWrite: "proved" });
  gh.now = () => new Date(clock.now()).toISOString();
  const config = { ...CONFIG, home, worktrees: dirname(tree), harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, model: "fixture" } } };
  const git = makeGit({ config, identity: fakeIdentity() });
  git.originOf = async () => "https://github.com/acme/widget.git";
  git.ensureHttpsRemote = async () => {};
  git.installHooks(tree);
  const push = git.pushRepair;
  git.pushRepair = async (path, branch, sha, _repo, guard) => {
    await push(path, branch, sha, null, guard);
    gh.data.pr.headRefOid = sha;
    gh.data.pr.mergeable = "MERGEABLE";
  };
  const runner = makeExecution({ root: join(home, "runs"), taskId: id, provider: "claude", runner: raw, legacySessionId: session, clock });
  const verified = [];
  const ctx = { config, home, state, clock, ownLogin: "me", gh, host: gh, hosts: makeHostRegistry({ credential: fakeCredential() }), git,
    log: silentLog, notify: fakeNotify(), credential: fakeCredential(), identity: fakeIdentity(), runnerFor: () => runner,
    coordinatorHealth: () => ({ alive: true, stale: false }),
    checkHarness: async () => ({ ok: true }), authorCapabilityEvidence: ({ binding }) => ({ binding, ok: true, expiresAt: clock.now() + 60_000 }),
    repairVerification: {
      sandbox: async () => ({ cmd: "/bin/sh", args: ["-c", 'exec "$@"', "fixture"], evidence: {
        version: 1, driver: "sandbox-exec", filesystem: "checkout-and-runtime", network: "disabled", probe: "passed",
      } }),
      execute: async (cmd, args, options) => {
        verified.push(args.at(-1));
        return execFileSync(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
      },
    },
    readPrd: () => text, readSource: (_id, path) => path === source ? approvedOverlay : null };
  const { route, profile } = admitFixture(ctx, id, ci ? "ci-repair" : "git-repair");
  const seeded = await runner.start("seed", "fixture", [], { execution: { operationId: "prior-author", recordedSessionId: session, inputHead: head,
    recoveryRouteDigest: recoveryDigest(route), recoveryProfileDigest: profile.digest } });
  raw.finish(claudeResultLines(), { exit: 0 });
  runner.settle(seeded.id, () => 0);
  state.update(id, { execution: runner.current().execution, last: { run: seeded.id, exit: 0, at: T0 } });
  const entry = () => ctx.state.get(id);
  const tick = async () => {
    const results = await makeTick(ctx).tick();
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    clock.advance(3);
  };
  const resolve = () => {
    write(join(tree, file), combined);
    g(["add", "--", file]); g(["commit", "-qm", "Resolve the approved base"]);
    raw.finish(claudeResultLines(), { exit: 0 });
    return g(["rev-parse", "HEAD"]);
  };
  return { home, origin, tree, local, state, id, head, base, start, clock, raw, ctx, git, gh, g, commit, entry, tick, resolve, verified };
}

test("journaled merge preserves both parents and the tracked identity while restoring private context", async t => {
  const w = await world(t);
  await w.tick();
  const op = w.entry().base_repair;
  assert.equal(op?.status, "running", w.entry().last.event);
  assert.equal(op.baseSha, w.base);
  assert.equal(w.g(["rev-parse", "MERGE_HEAD"]), w.base);
  assert.match(w.raw.started[1].args.join(" "), /Planning context with no identity wiring/);
  assert.equal(fs.readFileSync(join(w.tree, source), "utf8"), wired);
  assert.match(w.raw.started[1].args.join(" "), /Preserve both applicable behaviors/);
  assert.equal(w.raw.started[1].opts.env.GH_TOKEN, "");
  assert.equal(w.raw.started[1].opts.env.HOST_API_TOKEN, "");
  const repaired = w.resolve();
  await w.tick();
  assert.equal(w.entry().base_repair.status, "verified", w.entry().base_repair.failure);
  assert.equal(w.g(["show", "-s", "--format=%P", repaired]), `${w.head} ${w.base}`);
  assert.equal(w.g(["rev-parse", branch], w.origin), repaired);
  assert.equal(w.g(["show", `${repaired}:${source}`]), wired.trim());
  assert.equal(w.verified.length, 1);
  assert.equal(w.entry().cursor.checks_sha, null);
  assert.ok(w.entry().completionEvidence.delivery.invalidatedAt);
  assert.equal(w.entry().review_readiness, null);
  assert.equal(w.entry().recovery_actions.total.paidTurns, 1);
  const report = why(w.ctx, { handle: w.id });
  assert.ok(report.includes(`pinned base ${w.base}`));
  assert.ok(report.includes(`Verify on ${repaired}: 1 passed`));
  assert.ok(!report.includes(w.home));
  assert.ok(!report.includes(approvedOverlay.trim()));
});

test("checkpoint loss replays the exact open merge without restaging and keeps a moved base pinned", async t => {
  const w = await world(t);
  const merge = w.git.beginRepairMerge;
  let lost = false;
  w.git.beginRepairMerge = async (...args) => {
    await merge.apply(w.git, args);
    if (!lost) { lost = true; throw fail(); }
  };
  await w.tick();
  assert.equal(w.entry().base_repair.journal.phase, "merging");
  const index = fs.readFileSync(join(w.tree, ".git", "index"));
  const bytes = fs.readFileSync(join(w.tree, file));
  const newer = w.commit("a later base change\n", w.origin, "later.txt");
  w.gh.data.pr.baseRefOid = newer;
  w.ctx.state = makeState(w.local);
  await w.tick();
  assert.equal(w.entry().base_repair.status, "running", w.entry().base_repair.failure);
  assert.equal(w.entry().base_repair.baseSha, w.base);
  assert.deepEqual(fs.readFileSync(join(w.tree, ".git", "index")), index);
  assert.deepEqual(fs.readFileSync(join(w.tree, file)), bytes);
  assert.equal(w.raw.started.length, 2);
});

test("foreign partial index changes, unresolved acceptance and cancellation protect the checkout", async t => {
  const w = await world(t);
  const merge = w.git.beginRepairMerge;
  w.git.beginRepairMerge = async (...args) => { await merge.apply(w.git, args); throw fail(); };
  await w.tick();
  write(join(w.tree, file), combined);
  w.g(["add", "--", file]);
  const index = fs.readFileSync(join(w.tree, ".git", "index"));
  await w.tick();
  assert.match(w.entry().base_repair.failure, /partial resolutions/);
  assert.deepEqual(fs.readFileSync(join(w.tree, ".git", "index")), index);
  assert.equal(w.raw.started.length, 1);
  const cleanup = await cleanupMergedWorkspace(w.ctx, w.id, w.entry(), { state: "MERGED", headRefOid: w.head });
  assert.equal(cleanup.status, "retained");
  assert.throws(() => w.state.remove(w.id), /repair journal/);
  requestControl(w.ctx, { handle: w.id, action: "cancel", requestId: "cancel-journal" });
  await w.tick();
  assert.equal(w.raw.started.length, 1);
  assert.equal(fs.readFileSync(join(w.tree, file), "utf8"), combined);
});

test("lost push acknowledgement observes the exact remote without another push or paid launch", async t => {
  const w = await world(t);
  const push = w.git.pushRepair;
  let calls = 0;
  w.git.pushRepair = async (...args) => { calls++; await push(...args); throw new Error("connection lost after push"); };
  await w.tick();
  assert.equal(w.entry().base_repair.status, "running", w.entry().base_repair.failure);
  const repaired = w.resolve();
  await w.tick();
  assert.equal(w.entry().base_repair.journal.phase, "pushing");
  assert.equal(w.entry().base_repair.status, "blocked");
  await w.tick();
  assert.equal(w.entry().base_repair.remoteSha, repaired);
  assert.equal(calls, 1);
  assert.equal(w.raw.started.length, 2);
  assert.equal(w.verified.length, 1);
});

test("a terminal author's staged resolutions survive an interrupted commit acknowledgement", async t => {
  const w = await world(t);
  await w.tick();
  assert.equal(w.entry().base_repair?.status, "running", w.entry().last.event);
  write(join(w.tree, file), combined);
  w.g(["add", "--", file]);
  const original = w.git.commitRepair;
  let calls = 0;
  w.git.commitRepair = async (...args) => { calls++; await original(...args); throw fail(); };
  w.raw.finish(claudeResultLines(), { exit: 0 });
  await w.tick();
  assert.equal(w.entry().base_repair.journal.phase, "committing", w.entry().recovery_wait?.reason);
  const candidate = w.g(["rev-parse", "HEAD"]);
  const staged = fs.readFileSync(join(w.tree, ".git/index"));
  await w.tick();
  assert.equal(w.entry().base_repair.remoteSha, candidate, w.entry().recovery_wait?.reason);
  assert.deepEqual(fs.readFileSync(join(w.tree, ".git/index")), staged);
  assert.equal(w.g(["show", "-s", "--format=%P", candidate]), `${w.head} ${w.base}`);
  assert.equal(calls, 1);
  assert.equal(w.raw.started.length, 2);
});

test("failed paid repair and unknown submission remain observation-only", async t => {
  await t.test("failed author", async t => {
    const w = await world(t);
    await w.tick();
    write(join(w.tree, file), combined);
    w.g(["add", "--", file]);
    const before = fs.readFileSync(join(w.tree, ".git/index"));
    w.raw.finish(claudeResultLines({ ok: false }), { exit: 1 });
    await w.tick(); await w.tick();
    assert.equal(w.entry().base_repair.status, "blocked");
    assert.deepEqual(fs.readFileSync(join(w.tree, ".git/index")), before);
    assert.equal(w.g(["rev-parse", branch], w.origin), w.head);
    assert.equal(w.raw.started.length, 2);
  });
  await t.test("unknown author acceptance", async t => {
    const w = await world(t);
    const start = w.raw.start;
    w.raw.start = (...args) => { start(...args); throw new Error("lost author acknowledgement"); };
    await w.tick();
    assert.equal(w.entry().base_repair.journal.phase, "author");
    assert.equal(w.entry().recovery_actions.total.paidTurns, 1);
    const index = fs.readFileSync(join(w.tree, ".git/index"));
    await w.tick();
    assert.deepEqual(fs.readFileSync(join(w.tree, ".git/index")), index);
    assert.equal(w.raw.started.length, 2);
    assert.equal(w.entry().base_repair.status, "running");
    const repaired = w.resolve();
    await w.tick();
    assert.equal(w.entry().base_repair.remoteSha, repaired);
  });
});

test("journal ENOSPC stops before an overlay or index mutation", async t => {
  const w = await world(t);
  const update = w.state.update;
  w.state.update = (id, patch, options) => update(id, entry => {
    const changes = typeof patch === "function" ? patch(entry) : patch;
    if (options?.durable && changes.base_repair?.journal) throw fail();
    return changes;
  }, options);
  const before = fs.readFileSync(join(w.tree, ".git/index"));
  await w.tick();
  assert.equal(w.entry().resource.code, "ENOSPC");
  assert.deepEqual(fs.readFileSync(join(w.tree, ".git/index")), before);
  assert.equal(fs.readFileSync(join(w.tree, source), "utf8"), approvedOverlay);
  assert.equal(w.raw.started.length, 1);
});

test("concurrent branch change and a failed push preserve the repair without replay", async t => {
  await t.test("changed local head", async t => {
    const w = await world(t);
    const merge = w.git.beginRepairMerge;
    w.git.beginRepairMerge = async (...args) => { await merge.apply(w.git, args); throw fail(); };
    await w.tick();
    w.g(["update-ref", `refs/heads/${branch}`, w.base, w.head]);
    const before = fs.readFileSync(join(w.tree, ".git/index"));
    await w.tick();
    assert.match(w.entry().base_repair.failure, /HEAD|branch/);
    assert.deepEqual(fs.readFileSync(join(w.tree, ".git/index")), before);
    assert.equal(w.raw.started.length, 1);
  });
  await t.test("unchanged remote after a rejected push", async t => {
    const w = await world(t);
    let pushes = 0;
    w.git.pushRepair = async () => { pushes++; throw new Error("push rejected"); };
    await w.tick();
    assert.equal(w.entry().base_repair?.status, "running", w.entry().last.event);
    const candidate = w.resolve();
    await w.tick(); await w.tick();
    assert.equal(w.entry().base_repair.journal.phase, "pushing");
    assert.equal(w.g(["rev-parse", "HEAD"]), candidate);
    assert.equal(w.g(["rev-parse", branch], w.origin), w.head);
    assert.equal(pushes, 1);
    assert.equal(w.raw.started.length, 2);
  });
});

test("known stale hook derivation can refresh, while foreign policy and override paths stay blocked", async t => {
  const w = await world(t);
  const hook = join(w.tree, ".git/hooks/commit-msg");
  const accepted = { base: "main", inputFiles: [source] };
  const stale = { ...accepted, pinnedBase: w.start };
  w.git.installHooks(w.tree, stale);
  const before = fs.readFileSync(hook);
  const digest = await w.git.repairHook(w.tree, accepted, contentDigest(before), () => {});
  assert.equal(contentDigest(fs.readFileSync(hook)), digest);
  write(hook, "#!/bin/sh\nexit 1\n");
  await assert.rejects(w.git.repairHook(w.tree, accepted, digest, () => {}), /differs from the recorded installation/);
  assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\nexit 1\n");
  w.g(["config", "core.hooksPath", "different-hooks"]);
  await assert.rejects(w.git.repairHook(w.tree, accepted, digest, () => {}), /explicit Git hooks path/);
});

function installCI(w, { baseConclusion = "success", conclusion = "failure" } = {}) {
  const repo = "acme/widget", workflow = 72, jobName = "Regression", stepName = "Check identity";
  const url = (run, job) => `https://github.com/${repo}/actions/runs/${run}/job/${job}`;
  const run = (id, head, result) => ({ id, head_sha: head, status: "completed", conclusion: result, run_attempt: 1, workflow_id: workflow,
    html_url: `https://github.com/${repo}/actions/runs/${id}`, repository: { id: 1, full_name: repo }, head_repository: { id: 1 },
    created_at: T0, run_started_at: T0, updated_at: at(1) });
  const job = (id, runId, head, result) => ({ id, run_id: runId, run_attempt: 1, head_sha: head, status: "completed", conclusion: result,
    name: jobName, completed_at: at(1), check_run_url: `https://api.github.com/repos/${repo}/check-runs/${id}`,
    steps: [{ name: stepName, number: 2, conclusion: result, status: "completed" }] });
  const head = () => w.gh.data.pr.headRefOid;
  const read = path => {
    if (path.includes("/actions/workflows/")) return { workflow_runs: [run(1, w.base, baseConclusion)], total_count: 1 };
    if (path.includes("/annotations")) return [{ annotation_level: "failure", path: file, message: "private fixture diagnostic" }];
    const id = Number(path.match(/\/actions\/runs\/(\d+)/)[1]);
    const [sha, result] = id === 1 ? [w.base, baseConclusion] : id === 2 ? [w.head, conclusion] : [head(), "success"];
    if (!path.includes("/jobs?")) return run(id, sha, result);
    return { jobs: [job(id * 10, id, sha, result)], total_count: 1 };
  };
  w.gh.repairCIEvidence = actionsRepairEvidence(read, w.clock);
  const check = (headSha, outcome, runId) => ({ headSha, outcome, name: jobName, source: { host: "github.com" }, url: url(runId, runId * 10), updatedAt: at(1) });
  w.gh.data.pr.statusCheckRollup = [check(w.head, "failed", 2)];
  return check;
}

test("scoped CI repair preserves the original job and requires the same step on the repaired head", async t => {
  const w = await world(t, { ci: true });
  const check = installCI(w);
  await w.tick();
  const op = w.entry().base_repair;
  assert.equal(op?.status, "running", w.entry().recovery_wait?.reason ?? w.entry().last.event);
  assert.equal(op.journal.ci.job, 20);
  assert.deepEqual(op.journal.ci.targets, [file]);
  assert.match(w.raw.started[1].args.join(" "), /job 20, step 2/);
  assert.doesNotMatch(w.raw.started[1].args.join(" "), /private fixture diagnostic/);
  write(join(w.tree, "other.mjs"), "export const other = 1;\n");
  w.g(["add", "--", "other.mjs"]);
  assert.throws(() => w.g(["commit", "-qm", "Try unrelated changes"]), /approved CI repair targets/);
  w.g(["restore", "--staged", "--", "other.mjs"]);
  fs.unlinkSync(join(w.tree, "other.mjs"));
  const head = w.commit(combined);
  w.raw.finish(claudeResultLines(), { exit: 0 });
  await w.tick();
  assert.equal(w.entry().base_repair.remoteSha, head, w.entry().recovery_wait?.reason);
  w.gh.data.pr.statusCheckRollup = [check(w.head, "passed", 3)];
  await w.tick();
  assert.equal(w.entry().base_repair.journal.ciClear, undefined);
  w.gh.data.pr.statusCheckRollup = [check(head, "passed", 3)];
  await w.tick();
  assert.equal(w.entry().base_repair.journal.ciClear.job, 30);
  assert.equal(w.entry().base_repair.journal.ci.job, 20);
});

test("CI infrastructure or the same failing base job stays observation-only", async t => {
  for (const [options, message] of [[{ baseConclusion: "failure" }, /upstream regression/],
    [{ conclusion: "timed_out" }, /infrastructure failure/]]) await t.test(message.source, async t => {
    const w = await world(t, { ci: true });
    installCI(w, options);
    await w.tick();
    assert.match(w.entry().recovery_wait.reason, message);
    assert.equal(w.raw.started.length, 1);
    assert.equal(w.entry().base_repair, undefined);
  });
});

test("semantic recovery budget survives new input and run identifiers for the same incident", async t => {
  const w = await world(t, { ci: true });
  const cause = ["failed-job", 72, "Regression", 2, "Check identity"];
  const make = input => planRecovery(w.ctx, w.id, "ci-repair", { cause, input, spendMicros: 1_000_000 });
  const first = make([w.head, 2, 20]);
  first.reserve("original-fix");
  first.executing();
  acceptedRecovery(w.state, w.id, first.key, "original-fix", "resumed");
  assert.throws(() => make(["a-new-head", 3, 30]), /Unchanged incident/);
  assert.equal(w.entry().recovery_actions.total.paidTurns, 1);
  assert.equal(Object.values(w.entry().recovery_actions.incidents)[0].semanticRepairs, 1);
});

test("backup ENOSPC and path swaps leave foreign bytes and links in place", t => {
  const home = scratch(t), worktree = join(home, "checkout"), stateDir = join(home, "state"), directory = contentDigest("repair");
  mkdir(worktree); mkdir(stateDir);
  const name = "docs/source.md";
  const file = join(worktree, name);
  write(file, approvedOverlay);
  const moves = planOverlayMoves(worktree, [{ path: name, text: approvedOverlay, blob: "blob", baseBytes: wired }], [name]);
  const args = { stateDir, worktree, directory, moves, source: () => approvedOverlay, guard: () => {} };
  assert.throws(() => relocateOverlays({ ...args, io: { ...fs, writeFileSync() { throw fail(); } } }), { code: "ENOSPC" });
  assert.equal(fs.readFileSync(file, "utf8"), approvedOverlay);
  const outside = join(home, "outside");
  write(outside, "operator edit");
  fs.unlinkSync(file); fs.linkSync(outside, file);
  assert.throws(() => relocateOverlays(args), /one link/);
  fs.unlinkSync(file); fs.symlinkSync(outside, file);
  assert.throws(() => relocateOverlays(args), /symlink/);
  fs.unlinkSync(file); write(file, "operator edit");
  assert.throws(() => relocateOverlays(args), /changed after journaling/);
  assert.equal(fs.readFileSync(file, "utf8"), "operator edit");
  assert.equal(fs.readFileSync(outside, "utf8"), "operator edit");
});

test("a durable backup replays after a lost displacement acknowledgement", t => {
  const home = scratch(t), worktree = join(home, "checkout"), stateDir = join(home, "state"), directory = contentDigest("repair");
  mkdir(worktree); mkdir(stateDir);
  write(join(worktree, source), approvedOverlay);
  const moves = planOverlayMoves(worktree, [{ path: source, text: approvedOverlay, blob: "blob", baseBytes: wired }], [source]);
  const args = { stateDir, worktree, directory, moves, source: () => approvedOverlay, guard: () => {} };
  assert.throws(() => relocateOverlays({ ...args, io: { ...fs, unlinkSync(path) {
    fs.unlinkSync(path);
    if (path === join(worktree, source)) throw fail();
  } } }), { code: "ENOSPC" });
  assert.equal(fs.existsSync(join(worktree, source)), false);
  relocateOverlays(args);
  assert.equal(restoredOverlay({ stateDir, directory, move: moves[0], source: approvedOverlay }), approvedOverlay);
});

test("backup publication is exclusive and a lost link acknowledgement reuses the same bytes", async t => {
  for (const foreign of [false, true]) await t.test(foreign ? "foreign destination" : "owned existing link", t => {
    const home = scratch(t), worktree = join(home, "checkout"), stateDir = join(home, "state"), directory = contentDigest("repair");
    mkdir(worktree); mkdir(stateDir); write(join(worktree, source), approvedOverlay);
    const moves = planOverlayMoves(worktree, [{ path: source, text: approvedOverlay, blob: "blob", baseBytes: wired }], [source]);
    const args = { stateDir, worktree, directory, moves, source: () => approvedOverlay, guard: () => {} };
    const io = { ...fs, linkSync(from, to) {
      if (foreign) write(to, "foreign bytes");
      fs.linkSync(from, to);
      throw fail();
    } };
    assert.throws(() => relocateOverlays({ ...args, io }), { code: foreign ? "EEXIST" : "ENOSPC" });
    assert.equal(fs.readFileSync(join(worktree, source), "utf8"), approvedOverlay);
    if (foreign) {
      assert.throws(() => relocateOverlays(args), /differs from the journal/);
      assert.equal(fs.readFileSync(join(stateDir, "git-recovery", directory, moves[0].slot), "utf8"), "foreign bytes");
    } else {
      relocateOverlays(args);
      assert.equal(restoredOverlay({ stateDir, directory, move: moves[0], source: approvedOverlay }), approvedOverlay);
    }
  });
});

test("base-identical untracked bytes are backed up separately from the immutable approved copy", t => {
  const home = scratch(t), worktree = join(home, "checkout"), stateDir = join(home, "state"), directory = contentDigest("repair");
  mkdir(worktree); mkdir(stateDir);
  write(join(worktree, source), wired);
  const moves = planOverlayMoves(worktree, [{ path: source, text: approvedOverlay, blob: "blob", baseBytes: wired }], [source]);
  const args = { stateDir, worktree, directory, moves, source: () => approvedOverlay, guard: () => {} };
  relocateOverlays(args);
  relocateOverlays(args);
  assert.equal(fs.existsSync(join(worktree, source)), false);
  assert.equal(restoredOverlay({ stateDir, directory, move: moves[0], source: approvedOverlay }), approvedOverlay);
  write(join(worktree, source), "new implementation edit");
  assert.throws(() => relocateOverlays(args), /changed after journaling/);
  assert.equal(fs.readFileSync(join(worktree, source), "utf8"), "new implementation edit");
});

test("lossy decoded text cannot stand in for literal bytes at the pinned base", t => {
  const home = scratch(t);
  write(join(home, source), "\ufffd");
  const item = { path: source, text: approvedOverlay, blob: "blob", baseBytes: Buffer.from([0xff]) };
  assert.throws(() => planOverlayMoves(home, [item], [source]), /unknown bytes/);
  write(join(home, source), item.baseBytes);
  assert.equal(planOverlayMoves(home, [item], [source])[0].hash, contentDigest(item.baseBytes));
});
