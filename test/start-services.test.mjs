import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { realpathSync, readFileSync, statSync, symlinkSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { init } from "../lib/commands/init.mjs";
import { startServices } from "../lib/commands/start_services.mjs";
import { trackerInBackground, trackerForeground, stopTracker, readTracker, trackerPort, openTracker } from "../lib/tracker_process.mjs";
import { codeStamp, writeJsonAtomic } from "../lib/fs.mjs";
import { processIdentity } from "../lib/daemon.mjs";
import { makeContext } from "../lib/context.mjs";
import { tempHome, CONFIG } from "./helpers.mjs";

test("start and serve service startup reuses the same daemon/tracker path with explicit opt-outs", async () => {
  const calls = [];
  const deps = { daemon: async () => { calls.push("daemon"); return null; }, tracker: async () => { calls.push("tracker"); }, open: async () => { calls.push("open"); return true; }, foreground: async () => { calls.push("foreground"); } };
  assert.deepEqual((await startServices({}, {}, deps)).errors, []);
  assert.deepEqual(calls.splice(0), ["daemon", "tracker", "open"]);
  await startServices({}, { noServer: true }, deps);
  assert.deepEqual(calls.splice(0), ["daemon"]);
  await startServices({}, { noDaemon: true, noOpen: true, foreground: true }, deps);
  assert.deepEqual(calls.splice(0), ["foreground"]);
  await assert.rejects(startServices({}, { port: "bad" }, deps), /port/);
  assert.deepEqual(calls, []);
});

test("startup reports partial failures without resubmitting work and browser failure is nonfatal", async () => {
  const result = await startServices({}, {}, { daemon: async () => { throw new Error("access unavailable"); }, tracker: async () => {}, open: async () => false });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /do not resubmit/);
  assert.match(result.messages.join("\n"), /Browser could not be opened/);
  const failed = await startServices({}, { noDaemon: true }, { tracker: async () => { throw new Error("port occupied"); }, open: () => assert.fail("must not open an unrelated port") });
  assert.match(failed.errors[0], /port occupied/);
});

test("browser opener uses bounded argv, supports macOS/Linux and skips headless Linux", async () => {
  const calls = [], exec = (bin, args, options, done) => { calls.push({ bin, args, options }); done(null); };
  assert.equal(await openTracker(8791, { platform: "linux", env: {}, exec }), false);
  assert.equal(await openTracker(8791, { platform: "linux", env: { DISPLAY: ":0" }, exec }), true);
  assert.equal(await openTracker(8791, { platform: "darwin", exec }), true);
  assert.deepEqual(calls.map(c => c.bin), ["xdg-open", "open"]);
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:8791"]);
  assert.equal(calls[0].options.timeout, 5000);
  for (const port of [0, -1, 65536, "x", 1.5]) assert.throws(() => trackerPort(port));
});

const freePort = async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
function fixture() {
  const home = realpathSync(tempHome());
  writeJsonAtomic(join(home, "config.json"), { ...CONFIG, worktrees: tempHome(), harness: { codex: { bin: process.execPath } }, notify: null });
  return makeContext({ home });
}

test("standalone tracker starts once, verifies its home/port and stops without affecting agent runs", async () => {
  const ctx = fixture(), port = await freePort();
  try {
    const first = await trackerInBackground(ctx, { port });
    const next = await trackerInBackground(ctx, { port });
    assert.equal(next.pid, first.pid);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    await assert.rejects(trackerInBackground(ctx, { port: await freePort() }), /already uses port/);
    const other = fixture();
    // The failed child can exit between ps and signal-0, or a reader can see
    // its new lock before JSON is written. Each diagnostic refuses ownership.
    await assert.rejects(trackerInBackground(other, { port, waitMs: 2000 }), /failed to start|process identity cannot be verified|tracker\.lock is not valid JSON/);
    assert.equal(readTracker(ctx.home).pid, first.pid);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  } finally {
    assert.equal(stopTracker(ctx).stopped, true);
    for (let i = 0; i < 50 && readTracker(ctx.home)?.alive; i++) await new Promise(r => setTimeout(r, 50));
    assert.equal(readTracker(ctx.home), null);
  }
});

test("tracker startup waits only for its spawned child's incomplete lock", async () => {
  for (const publishes of [true, false]) {
    const ctx = fixture(), instance = "starting-tracker", owner = { pid: process.pid, identity: processIdentity(process.pid), instance };
    const server = createServer((_request, response) => response.end(JSON.stringify({ instance })));
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    let timer, spawns = 0, stops = 0;
    const spawnFn = () => {
      spawns++;
      writeFileSync(join(ctx.home, "tracker.lock"), "{");
      if (publishes) timer = setTimeout(() => {
        writeJsonAtomic(join(ctx.home, "tracker.lock"), owner);
        writeJsonAtomic(join(ctx.home, "tracker.json"), { ...owner, port, code: codeStamp() });
      }, 10);
      return Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, unref() {}, kill() { stops++; } });
    };
    try {
      if (publishes) {
        const record = await trackerInBackground(ctx, { port, spawnFn, waitMs: 1000 });
        assert.equal(record.instance, instance);
        assert.equal(stops, 0);
      } else {
        await assert.rejects(trackerInBackground(ctx, { port, spawnFn, waitMs: 20 }), /did not become ready/);
        assert.equal(stops, 1);
      }
      assert.equal(spawns, 1);
    } finally {
      clearTimeout(timer);
      rmSync(join(ctx.home, "tracker.lock"), { force: true });
      await new Promise(resolve => server.close(resolve));
    }
  }
  const ctx = fixture();
  writeFileSync(join(ctx.home, "tracker.lock"), "{");
  await assert.rejects(trackerInBackground(ctx, { spawnFn: () => assert.fail("must not replace an unknown lock") }), /tracker\.lock is not valid JSON/);
});

test("an unverifiable live tracker owner is neither replaced nor stopped", async () => {
  const ctx = fixture();
  writeJsonAtomic(join(ctx.home, "tracker.lock"), { pid: process.pid, identity: "unknown-fixture", instance: "unverified" });
  await assert.rejects(trackerInBackground(ctx, { spawnFn: () => assert.fail("must not replace an unverified process") }), /process identity cannot be verified/);
  assert.equal(stopTracker(ctx).unverified, true);
  assert.equal(readTracker(ctx.home).pid, process.pid);
});

test("foreground ownership releases on close; pinned runtime homes cannot start standalone trackers", async () => {
  const ctx = fixture(), port = await freePort();
  const server = await trackerForeground(ctx, { port });
  await new Promise(resolve => server.close(resolve));
  assert.equal(readTracker(ctx.home), null);
  writeJsonAtomic(join(ctx.home, "runtime-pin.json"), {});
  await assert.rejects(trackerInBackground(ctx, { port }), { code: "TASK_RUNTIME_PIN" });
  await assert.rejects(trackerForeground(ctx, { port }), { code: "TASK_RUNTIME_PIN" });
});

test("CLI start without a PRD supports no services, and validates ports before dispatch", () => {
  const ctx = fixture(), cli = new URL("../bin/gallivant.mjs", import.meta.url).pathname;
  const options = { env: { ...process.env, GALLIVANT_HOME: ctx.home }, encoding: "utf8", timeout: 5000 };
  assert.match(execFileSync(process.execPath, [cli, "start", "--no-daemon", "--no-server"], options), /startup skipped/);
  assert.throws(() => execFileSync(process.execPath, [cli, "start", "missing.md", "--port", "bad"], { ...options, stdio: "pipe" }), error => /--port/.test(error.stderr));
});
