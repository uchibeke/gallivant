import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { makeJournalReserve, measureResources, requireHeadroom, RESOURCE_DEFAULTS } from "../lib/recovery_resources.mjs";
import { readJson, syncDirectory, writeJsonAtomic } from "../lib/fs.mjs";
import { cleanupMergedWorkspace, maintainWorkspace } from "../lib/workspace_cleanup.mjs";
import { directoryIdentity } from "../lib/owned_artifacts.mjs";
import { prepareRuntimeCache, runtimeEnvironment } from "../lib/runtime-environment.mjs";
import { makeState } from "../lib/state.mjs";
import { makeRunner } from "../lib/run.mjs";
import { admitFixture } from "./recovery-recipe-fixture.mjs";
import { ownRuntimeFixture } from "./owned-fixtures.mjs";
import { CONFIG, makeClock, tempHome, GOOD_PRD, silentLog } from "./helpers.mjs";

test("admission measures distinct state, checkout and scratch mounts and bounded process pressure", () => {
  const probes = [], mounts = { "/state": [1, 16384n, 0n], "/live": [2, 0n, 3000n], "/temp": [3, 16384n, 3000n] };
  const inputs = { stateDir: "/state", worktree: "/live", scratch: "/temp" };
  const adapter = { access: () => {}, stat: path => ({ dev: mounts[path][0], isDirectory: () => true }), statfs: path => {
    probes.push(path); return { type: 42n, files: 4000n, bsize: 4096n, bavail: mounts[path][1], ffree: mounts[path][2] };
  }, pressure: () => ({ memoryBytes: 1, loadPerCpu: 6 }) };
  const snapshot = measureResources(inputs, RESOURCE_DEFAULTS, adapter);
  assert.deepEqual(probes, ["/state", "/live", "/temp"]);
  assert.deepEqual(Object.values(snapshot.mounts).map(mount => mount.device), [1, 2, 3]);
  assert.deepEqual(snapshot.blocked, ["state-inodes", "checkout-bytes", "memory", "process-pressure"]);
  assert.throws(() => requireHeadroom(inputs, RESOURCE_DEFAULTS, adapter), { code: "AUTHOR_STORAGE" });
});

const fault = resource => Object.assign(new Error("fixture exhausted " + resource), { code: "ENOSPC" });
function reserveFor(home) {
  const settings = { ...RESOURCE_DEFAULTS, minimum_free_bytes: 0, minimum_free_inodes: 0 };
  const binding = { device: fs.statSync(home).dev, fs_type: fs.statfsSync(home).type };
  const reserve = makeJournalReserve(home, binding);
  assert.equal(reserve.provision(settings), true);
  return { reserve, binding, path: join(home, "recovery-journal.reserve") };
}

test("qualified reserve releases one exact inode before retrying both exhaustion modes at every journal boundary", async t => {
  for (const resource of ["bytes", "inodes"]) for (const phase of ["openSync", "writeFileSync", "fsyncSync", "renameSync", "syncDirectory"]) {
    await t.test(resource + " at " + phase, () => {
      const home = tempHome(), { reserve, path } = reserveFor(home), journal = join(home, "intent.json");
      const artifact = join(home, "owned"); fs.mkdirSync(artifact);
      const proof = directoryIdentity(home, "owned"), events = [];
      const io = { ...fs, syncDirectory };
      const original = io[phase];
      io[phase] = (...args) => {
        if (fs.existsSync(path)) { events.push("full"); assert.equal(fs.existsSync(artifact), true); throw fault(resource); }
        return original(...args);
      };
      reserve.record(journal, () => writeJsonAtomic(journal, { proof }, 0o600, { durable: true, fs: io }));
      assert.deepEqual(events, ["full"]);
      assert.equal(fs.existsSync(path), false);
      assert.deepEqual(readJson(journal), { proof });
      assert.equal(fs.existsSync(artifact), true);
      assert.equal(fs.readdirSync(home).some(name => name.endsWith(".tmp")), false);

      io[phase] = () => { throw fault(resource); };
      assert.throws(() => reserve.record(journal, () => writeJsonAtomic(journal, { proof }, 0o600, { durable: true, fs: io })), { code: "ENOSPC" });
      assert.equal(fs.existsSync(artifact), true);
    });
  }
});

test("reserve refuses a replacement and the wrong filesystem qualification", () => {
  const home = tempHome(), { reserve, binding, path } = reserveFor(home), journal = join(home, "intent.json");
  const unqualified = makeJournalReserve(home, { ...binding, device: binding.device + 1 });
  assert.throws(() => unqualified.record(journal, () => { throw fault("bytes"); }), { code: "ENOSPC" });
  fs.renameSync(path, join(home, "original"));
  fs.writeFileSync(path, "operator data");
  assert.throws(() => reserve.record(journal, () => { throw fault("inodes"); }), { code: "ENOSPC" });
  assert.equal(fs.readFileSync(path, "utf8"), "operator data");
});

function workspace() {
  const home = tempHome(), worktrees = tempHome(), repo = "acme/widget", id = repo + "/task", worktree = join(worktrees, repo, "task");
  fs.mkdirSync(join(worktree, ".git"), { recursive: true });
  const state = makeState(home), clock = makeClock(), head = "a".repeat(40);
  const branch = "work/task", pr = { state: "MERGED", headRefOid: head }, author = { current: () => null };
  state.put(id, { repo, pr: 1, branch, base: "main", state: "done", harness: "codex", session: "fixture", worktree });
  const ctx = { home, state, clock, log: silentLog, config: { ...CONFIG, worktrees }, runnerFor: () => author,
    git: { originOf: async () => "https://github.com/" + repo + ".git", cleanupProof: async () => ({ branch, head }) } };
  return { home, id, state, clock, worktree, worktrees, ctx, pr, author };
}

test("exhausted journal blocks unrecorded cleanup and a durable exact interrupted deletion is replayable", async () => {
  const w = workspace(), { reserve, path } = reserveFor(w.home), update = w.state.update;
  w.ctx.journalReserve = reserve;
  let writes = 0, mutations = 0;
  w.state.update = (...args) => { writes++; if (writes <= 2) throw fault("bytes"); return update(...args); };
  w.ctx.removeWorkspaceDirectory = async dir => { mutations++; fs.rmSync(join(dir, ".git"), { recursive: true }); throw fault("inodes"); };
  let result = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(result.status, "pending"); assert.equal(writes, 2); assert.equal(mutations, 0); assert.equal(fs.existsSync(path), false);
  result = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(result.status, "pending"); assert.equal(mutations, 1);
  assert.ok(w.state.get(w.id).workspace_cleanup.removal.rootIno);
  assert.equal(fs.existsSync(join(w.worktree, ".git")), false);
  delete w.ctx.removeWorkspaceDirectory;
  result = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(result.status, "done"); assert.equal(fs.existsSync(w.worktree), false);
});

test("qualified scratch and warm cache compaction uses separate unpaid reservations and protects dirty source and evidence", async t => {
  const w = workspace(), env = runtimeEnvironment({}, process.execPath, w.worktree);
  const artifacts = prepareRuntimeCache(w.worktree, env);
  ownRuntimeFixture(t, w.worktree);
  const source = join(w.worktree, "dirty-source.js"), evidence = join(w.home, "visible.log");
  fs.writeFileSync(source, "unpublished"); fs.writeFileSync(evidence, "preserve UI evidence");
  w.ctx.readPrd = () => GOOD_PRD;
  w.ctx.config.resource_headroom = { cleanup: "qualified", warm_cache_hours: 12 };
  w.ctx.git.cleanupProof = async () => ({ tracked: false });
  const caps = { mutations: 2, paidTurns: 0, spendMicros: 0 };
  const { run } = admitFixture(w.ctx, w.id, "workspace-cleanup", "codex", caps, [], [
    { root: artifacts.scratch.root, classes: ["settled-scratch"], retentionSeconds: 60, maxBytes: 1_048_576 },
    { root: artifacts.cache.root, classes: ["settled-scratch"], retentionSeconds: 60, maxBytes: 1_048_576 },
  ]);
  run.endedAt = w.clock.now();
  w.author.current = () => run;
  w.author.cleanupSettled = () => true;
  w.author.resources = () => ({ ...artifacts, run: run.id });
  w.state.update(w.id, { runtime_cleanup: { run: run.id, stage: "scratch", next_at: w.clock.now() } });
  const maintain = () => maintainWorkspace(w.ctx, w.id, w.state.get(w.id));
  await maintain(); assert.equal(w.state.get(w.id).runtime_cleanup.code, "retention");
  w.clock.advance(1); await maintain();
  assert.equal(fs.existsSync(artifacts.scratch.path), false);
  assert.equal(fs.existsSync(artifacts.cache.path), true);
  w.clock.advance(12 * 60); await maintain();
  assert.equal(fs.existsSync(artifacts.cache.path), false);
  assert.equal(fs.readFileSync(source, "utf8"), "unpublished");
  assert.equal(fs.readFileSync(evidence, "utf8"), "preserve UI evidence");
  assert.deepEqual(w.state.get(w.id).recovery_actions.total, caps);
  assert.equal(w.state.get(w.id).state, "done");
});

test("changed input and unresolved owned Git journals keep retained work and backups", async () => {
  const w = workspace(), backup = join(w.home, "operator-backup"); fs.writeFileSync(backup, "preserved");
  w.state.createChain({ name: "linked", index: 0, repo: "acme/widget", status: "active", steps: [{ path: join(w.worktree, "input.md") }] });
  let result = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(result.status, "retained"); assert.equal(result.code, "shared-input");
  w.state.update(w.id, { base_repair: { status: "resolving", journal: { version: 1 } } });
  result = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(result.code, "git-journal"); assert.equal(fs.existsSync(w.worktree), true);
  assert.equal(fs.readFileSync(backup, "utf8"), "preserved");
});

test("retained checkout proof can change after closeout without reopening the task", async () => {
  const w = workspace(), { repo, branch } = w.state.get(w.id);
  let dirty = true;
  w.ctx.git.cleanupProof = async () => ({ dirty, head: w.pr.headRefOid, branch });
  w.ctx.readPrd = () => GOOD_PRD;
  w.ctx.config.resource_headroom = { cleanup: "qualified" };
  const caps = { mutations: 1, paidTurns: 0, spendMicros: 0 };
  const { run } = admitFixture(w.ctx, w.id, "workspace-cleanup", "codex", caps, [], [
    { root: fs.realpathSync(w.worktrees), classes: ["settled-checkout"], retentionSeconds: 60, maxBytes: 1_048_576 },
  ]);
  run.endedAt = w.clock.now(); w.author.current = () => run; w.author.cleanupSettled = () => true;
  const url = "https://github.com/" + repo + "/pull/1";
  w.state.update(w.id, { url });
  const held = await cleanupMergedWorkspace(w.ctx, w.id, w.state.get(w.id), w.pr);
  assert.equal(held.status, "retained");
  w.state.update(w.id, { workspace_cleanup: held });
  w.ctx.gh = { prView: async () => ({ ...w.pr, number: 1, url, baseRefName: "main", headRefName: branch,
    isCrossRepository: false, mergeCommit: { oid: "b".repeat(40) }, mergedAt: new Date(w.clock.now()).toISOString() }), containsCommit: async () => true };
  dirty = false;
  w.clock.advance(6 * 60);
  await maintainWorkspace(w.ctx, w.id, w.state.get(w.id));
  assert.equal(w.state.get(w.id).state, "done");
  assert.equal(w.state.get(w.id).workspace_cleanup.status, "done");
  assert.equal(fs.existsSync(w.worktree), false);
  assert.deepEqual(w.state.get(w.id).recovery_actions.total, caps);
});

test("owned fixture trees are removed on process exit and leave unrelated siblings alone", () => {
  const outside = tempHome(), fixtureModule = new URL("./owned-fixtures.mjs", import.meta.url).href;
  for (const code of [0, 23]) {
    const program = "import { fixtureHome } from " + JSON.stringify(fixtureModule) + "; console.log(fixtureHome()); process.exit(" + code + ");";
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", program], { encoding: "utf8", env: { ...process.env, TMPDIR: outside }, timeout: 5000 });
    assert.equal(out.status, code, out.stderr);
    assert.equal(fs.existsSync(dirname(out.stdout.trim())), false, out.stderr);
    assert.equal(fs.existsSync(outside), true);
  }
});

test("an occupied reused author PID and unavailable process inspection authorize no signal", () => {
  const home = tempHome(); fs.mkdirSync(join(home, "run"));
  fs.writeFileSync(join(home, "latest-run"), "run");
  const job = { id: "run", pid: 8213, birth: "recorded", bin: "agent", exit: null };
  writeJsonAtomic(join(home, "run/job.json"), job);
  for (const current of ["unrelated", null]) {
    const runner = makeRunner(home, { exists: () => true, birth: () => current, processes: () => current ? [{ pid: job.pid, group: job.pid, started: current }] : null,
      signal: () => assert.fail("unexpected process signal") });
    assert.equal(runner.current().running, true);
    assert.throws(() => runner.kill(job.id), { code: "RUN_STOP_UNVERIFIED" });
  }
});
