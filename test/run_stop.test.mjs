import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { makeRunner } from "../lib/run.mjs";
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
