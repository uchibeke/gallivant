import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { makeRunner, runProcesses } from "../lib/run.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { processBirth } from "../lib/daemon.mjs";
import { signalPlanWorker } from "../lib/local_plan_boundary.mjs";
import { tempHome } from "./helpers.mjs";
import { execFileAsync } from "../lib/gh.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";

async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, "process did not reach the expected state");
    await delay(40);
  }
}

for (const detached of [false, true]) test(`legacy boundary cancellation waits for tool subprocesses (detached=${detached})`, async t => {
  const home = tempHome(), marker = join(home, "child-ready");
  const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'ignore', detached: ${detached}}); setInterval(() => {}, 1000);`;
  const runner = makeRunner(join(home, "runs"));
  const job = await runner.start("stop-test", process.execPath, ["-e", parent], { cwd: home });
  t.after(() => {
    for (const pid of [job.pid, existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0].filter(Boolean)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
    }
  });
  await until(() => existsSync(marker));
  const boundary = makeExecution({ root: runner.root, taskId: "legacy-stop", provider: "codex", runner });
  assert.equal(boundary.state().current, null);
  assert.deepEqual(await boundary.cancel(), { confirmed: false });
  await delay(100); // The leader exits; its child deliberately ignores TERM.
  assert.equal(runner.current().running, true);
  assert.equal(boundary.current().execution.providerState, "cancellation-requested");
  await assert.rejects(() => runner.start("overlap", process.execPath, ["-e", ""], { cwd: home }), /run in progress/);
  await runner.waitForKill(job.id);
  await until(() => !runner.current().running);
  const restarted = makeExecution({ root: runner.root, taskId: "legacy-stop", provider: "codex", runner: makeRunner(runner.root) });
  await restarted.reconcile();
  assert.equal(restarted.current().id, job.id);
  assert.equal(restarted.current().execution.providerState, "cancelled");
  assert.equal(restarted.current().execution.quarantined, true);
  assert.equal(runner.read(job.id).exit, 137);
});

for (const detached of [false, true]) test(`restarted coordinator recovers a lost kill timer for native tools (detached=${detached})`, async t => {
  const home = tempHome(), root = join(home, "runs"), marker = join(home, "child-ready");
  const child = `process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio:'ignore', detached:${detached}}); setInterval(() => {}, 1000);`;
  const runner = makeRunner(root), job = await runner.start("stop-restart", process.execPath, ["-e", parent], { cwd: home });
  const clock = { now: () => Date.now() + 6000 }, reopenedRunner = makeRunner(root, { clock });
  t.after(() => { try { reopenedRunner.kill(job.id); } catch { /* unverified identities are never signalled */ } });
  await until(() => existsSync(marker));
  const script = `import {makeRunner} from ${JSON.stringify(new URL('../lib/run.mjs', import.meta.url).href)}; import {makeExecution} from ${JSON.stringify(new URL('../lib/execution.mjs', import.meta.url).href)}; const runner=makeRunner(${JSON.stringify(root)}); await makeExecution({root:runner.root,taskId:"native-restart-stop",provider:"codex",runner}).cancel(); process.exit(0);`;
  await execFileAsync(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000, maxBuffer: 65_536 });
  const stopped = readJson(join(root, job.id, "job.json"));
  assert.equal(stopped.killed, true); assert.ok(Number.isFinite(stopped.killAfter));
  assert.equal(reopenedRunner.current().running, true);
  const service = makeExecution({ root, taskId: "native-restart-stop", provider: "codex", runner: reopenedRunner, clock });
  await service.reconcile(); await until(() => !reopenedRunner.current().running); await service.reconcile();
  assert.equal(service.current().execution.providerState, "cancelled"); assert.equal(service.current().execution.quarantined, true);
  assert.equal(service.current().exit, 137); assert.equal(readJson(join(root, job.id, "job.json")).killAfter, stopped.killAfter);
  await assert.rejects(service.submit({ operationId: "overlap", spec: {} }), { code: "EXECUTION_STOPPED" });
  const path = join(home, "native-kill-restart-evidence.json");
  writeJsonAtomic(path, { detached, timerOwnerExited: true, persistedKillAfter: stopped.killAfter, providerState: service.current().execution.providerState, job: join(root, job.id, "job.json"), execution: join(root, "execution.json") });
  t.diagnostic(`native kill restart evidence: ${path}`);
});

test("group liveness excludes zombie-only groups and retains live tool children", () => {
  const rows = " 101 1 100 Z Wed Sep 30 20:00:00 2026\n 102 1 100 S Wed Sep 30 20:00:01 2026\n 103 1 200 R Wed Sep 30 20:00:01 2026\n";
  assert.deepEqual(runProcesses(100, [], () => rows), [{ pid: 102, group: 100, started: "Wed Sep 30 20:00:01 2026" }]);
  assert.deepEqual(runProcesses(100, [], () => rows.replace("102 1 100 S", "102 1 100 Z+")), []);
  assert.equal(runProcesses(100, [], () => { throw new Error("ps unavailable"); }), null);
});

function stoppedRunner(members, stopMembers) {
  const root = tempHome(), id = "cancelled";
  mkdirSync(join(root, id));
  writeFileSync(join(root, "latest-run"), id);
  writeFileSync(join(root, id, "job.json"), JSON.stringify({ id, pid: 100, bin: "agent", exit: 137, killed: true, killAfter: 1, stopMembers }));
  const signals = [];
  const runner = makeRunner(root, { clock: { now: () => 24 * 60 * 60_000 }, processes: () => members,
    exists: pid => Boolean(members?.some(member => member.pid === pid)), birth: pid => members?.find(member => member.pid === pid)?.started,
    signal: (...args) => signals.push(args) });
  return { runner, signals, id };
}

test("a restarted daemon can finish a verified cancellation hours later", () => {
  const child = { pid: 102, group: 100, started: "Wed Sep 30 20:00:01 2026" };
  const { runner, signals, id } = stoppedRunner([child], [{ pid: 100, group: 100, started: "Wed Sep 30 20:00:00 2026" }, child]);
  assert.equal(runner.current().running, true);
  assert.deepEqual(signals, [], "reads never signal");
  runner.kill(id);
  assert.deepEqual(signals, [[102, "SIGKILL"]]);
});

test("an isolated worker and detached tool receive the saved kill fallback after restart", () => {
  const root = tempHome(), id = "isolated", workerUid = process.getuid() + 1;
  const leader = { pid: 100, group: 100, started: "Wed Sep 30 20:00:00 2026" };
  const worker = { pid: 102, group: 101, started: "Wed Sep 30 20:00:01 2026" };
  const tool = { pid: 103, group: 103, started: "Wed Sep 30 20:00:02 2026" };
  const command = { cmd: "/usr/bin/sudo", args: ["-n", "-H", "-u", `#${workerUid}`, "--preserve-env=PATH,LC_ALL,LANG", "--", "/fixture/worker"] };
  mkdirSync(join(root, id));
  writeFileSync(join(root, "latest-run"), id);
  writeJsonAtomic(join(root, id, "job.json"), { id, pid: leader.pid, bin: command.cmd, leaderOnly: true,
    birth: leader.started, exit: 137, killed: true, killAfter: 1, stopMembers: [leader, worker, tool] });
  writeJsonAtomic(join(root, id, "cmd.json"), command);
  let members = [worker, tool], refused = true;
  const delegated = [];
  const runner = makeRunner(root, { clock: { now: () => 6000 }, processes: () => members,
    exists: pid => members.some(member => member.pid === pid), birth: pid => members.find(member => member.pid === pid)?.started,
    signal: () => assert.fail("the operator must not signal another account's processes"),
    signalWorker: (recorded, targets, signal) => signalPlanWorker(recorded, targets, signal, (bin, args, options) => {
      assert.deepEqual(recorded, command);
      assert.equal(bin, "/usr/bin/sudo");
      assert.deepEqual(args.slice(0, 4), ["-n", "-H", "-u", `#${workerUid}`]);
      assert.deepEqual(args.slice(5), ["--", process.execPath, fileURLToPath(new URL("../bin/local-plan-worker-signal.mjs", import.meta.url)), String(workerUid), signal]);
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
      assert.deepEqual(JSON.parse(options.input), [worker, tool].map(({ pid, started }) => ({ pid, started })));
      if (refused) throw new Error("fixture worker signal refused");
      const pids = targets.map(member => member.pid);
      delegated.push([pids, signal]);
      members = [];
      return JSON.stringify(pids);
    }) });
  assert.equal(runner.current().running, true);
  assert.deepEqual(delegated, [], "observing a run does not send signals");
  assert.throws(() => runner.kill(id), { code: "RUN_STOP_UNVERIFIED" });
  assert.equal(runner.current().running, true, "a failed signal request cannot settle the run");
  refused = false;
  runner.kill(id);
  assert.deepEqual(delegated, [[[worker.pid, tool.pid], "SIGKILL"]]);
  assert.equal(runner.current().running, false);
  assert.equal(runner.cleanupSettled(id), true);
});

test("the worker helper rechecks birth and delivers SIGKILL to a TERM-resistant process", { skip: process.getuid() === 0 }, async t => {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
    { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exited = once(child, "exit");
  t.after(async () => { child.kill("SIGKILL"); await exited; });
  await once(child, "message", { signal: AbortSignal.timeout(5000) });
  const started = processBirth(child.pid);
  assert.ok(started);
  // This node process already runs as the fixture's UID. The separate sudo
  // transport fixture above checks how the coordinator selects the worker.
  const helper = fileURLToPath(new URL("../bin/local-plan-worker-signal.mjs", import.meta.url));
  const send = (signal, identity = started) => JSON.parse(execFileSync(process.execPath, [helper, String(process.getuid()), signal],
    { input: JSON.stringify([{ pid: child.pid, started: identity }]), timeout: 5000, encoding: "utf8" }));
  assert.deepEqual(send("SIGKILL", "mismatched birth"), []);
  assert.deepEqual(send("SIGTERM"), [child.pid]);
  assert.deepEqual(send("SIGKILL"), [child.pid]);
  assert.deepEqual(await exited, [null, "SIGKILL"]);
});

test("PID reuse cannot authorize signalling a cancelled group", () => {
  const { runner, signals, id } = stoppedRunner([{ pid: 102, group: 100, started: "Thu Oct 1 20:00:01 2026" }], [{ pid: 102, group: 100, started: "Wed Sep 30 20:00:01 2026" }]);
  assert.throws(() => runner.kill(id), { code: "RUN_STOP_UNVERIFIED" });
  assert.deepEqual(signals, []);
  assert.equal(runner.current().running, true, "unknown live writers still block another writer");
});

test("a descendant in a shared outside group never authorizes stopping unrelated processes", () => {
  const rows = "100 1 100 S Wed Sep 30 20:00:00 2026\n102 100 999 S Wed Sep 30 20:00:01 2026\n999 1 999 S Wed Sep 30 19:00:00 2026\n";
  const owned = runProcesses(100, [], () => rows);
  assert.deepEqual(owned.map(m => m.pid), [100, 102]);
  const { runner, signals, id } = stoppedRunner(owned, owned);
  runner.kill(id);
  assert.deepEqual(signals, [[102, "SIGKILL"], [100, "SIGKILL"]]);
});

test("unreadable process state fails closed instead of starting over orphaned tools", () => {
  const { runner, signals, id } = stoppedRunner(null, []);
  assert.equal(runner.current().running, true);
  assert.throws(() => runner.kill(id), { code: "RUN_STOP_UNVERIFIED" });
  assert.deepEqual(signals, []);
  assert.equal(runProcesses(100, [], () => "unreadable row"), null);
});
