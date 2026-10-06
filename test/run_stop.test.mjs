import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeRunner, runProcesses } from "../lib/run.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { tempHome } from "./helpers.mjs";

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
  const runner = makeRunner(root, { clock: { now: () => 24 * 60 * 60_000 }, processes: () => members, signal: (...args) => signals.push(args) });
  return { runner, signals, id };
}

test("a restarted daemon can finish a verified cancellation hours later", () => {
  const child = { pid: 102, group: 100, started: "Wed Sep 30 20:00:01 2026" };
  const { runner, signals, id } = stoppedRunner([child], [{ pid: 100, group: 100, started: "Wed Sep 30 20:00:00 2026" }, child]);
  assert.equal(runner.current().running, true);
  assert.deepEqual(signals, [], "reads never signal");
  runner.kill(id);
  assert.deepEqual(signals, [[-100, "SIGKILL"]]);
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
  assert.deepEqual(signals, [[102, "SIGKILL"], [-100, "SIGKILL"]]);
});

test("unreadable process state fails closed instead of starting over orphaned tools", () => {
  const { runner, signals, id } = stoppedRunner(null, []);
  assert.equal(runner.current().running, true);
  assert.throws(() => runner.kill(id), { code: "RUN_STOP_UNVERIFIED" });
  assert.deepEqual(signals, []);
  assert.equal(runProcesses(100, [], () => "unreadable row"), null);
});
