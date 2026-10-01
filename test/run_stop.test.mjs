import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeRunner, processGroup } from "../lib/run.mjs";
import { tempHome } from "./helpers.mjs";

async function until(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, "process did not reach the expected state");
    await delay(40);
  }
}

test("cancelled runs remain busy until their tool subprocesses exit", async t => {
  const home = tempHome(), marker = join(home, "child-ready");
  const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'ignore'}); setInterval(() => {}, 1000);`;
  const runner = makeRunner(join(home, "runs"));
  const job = runner.start("stop-test", process.execPath, ["-e", parent], { cwd: home });
  t.after(() => { try { process.kill(-job.pid, "SIGKILL"); } catch { /* gone */ } });
  await until(() => existsSync(marker));
  assert.equal(runner.kill(job.id), true);
  await delay(100); // The leader exits; its child deliberately ignores TERM.
  assert.equal(runner.current().running, true);
  assert.throws(() => runner.start("overlap", process.execPath, ["-e", ""], { cwd: home }), /run in progress/);
  await until(() => !runner.current().running);
  assert.equal(runner.read(job.id).exit, 137);
});

test("group liveness excludes zombie-only groups and retains live tool children", () => {
  const rows = " 101 100 Z Wed Sep 30 20:00:00 2026\n 102 100 S Wed Sep 30 20:00:01 2026\n 103 200 R Wed Sep 30 20:00:01 2026\n";
  assert.deepEqual(processGroup(100, () => rows), [{ pid: 102, started: "Wed Sep 30 20:00:01 2026" }]);
  assert.deepEqual(processGroup(100, () => rows.replace("102 100 S", "102 100 Z+")), []);
  assert.equal(processGroup(100, () => { throw new Error("ps unavailable"); }), null);
});

function stoppedRunner(members, stopMembers) {
  const root = tempHome(), id = "cancelled";
  mkdirSync(join(root, id));
  writeFileSync(join(root, "latest-run"), id);
  writeFileSync(join(root, id, "job.json"), JSON.stringify({ id, pid: 100, bin: "agent", exit: 137, killed: true, killAfter: 1, stopMembers }));
  const signals = [];
  const runner = makeRunner(root, { clock: { now: () => 24 * 60 * 60_000 }, groupMembers: () => members, signal: (...args) => signals.push(args) });
  return { runner, signals, id };
}

test("a restarted daemon can finish a verified cancellation hours later", () => {
  const child = { pid: 102, started: "Wed Sep 30 20:00:01 2026" };
  const { runner, signals, id } = stoppedRunner([child], [{ pid: 100, started: "Wed Sep 30 20:00:00 2026" }, child]);
  assert.equal(runner.current().running, true);
  assert.deepEqual(signals, [], "reads never signal");
  runner.kill(id);
  assert.deepEqual(signals, [[-100, "SIGKILL"]]);
});

test("PID reuse cannot authorize signalling a cancelled group", () => {
  const { runner, signals, id } = stoppedRunner([{ pid: 102, started: "Thu Oct 1 20:00:01 2026" }], [{ pid: 102, started: "Wed Sep 30 20:00:01 2026" }]);
  assert.throws(() => runner.kill(id), { code: "RUN_STOP_UNVERIFIED" });
  assert.deepEqual(signals, []);
  assert.equal(runner.current().running, true, "unknown live writers still block another writer");
});
