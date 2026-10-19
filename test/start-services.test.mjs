import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync, readFileSync, statSync, symlinkSync, existsSync } from "node:fs";
import { init } from "../lib/commands/init.mjs";
import { startServices } from "../lib/commands/start_services.mjs";
import { trackerInBackground, trackerForeground, stopTracker, readTracker, trackerPort, openTracker } from "../lib/tracker_process.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { makeContext } from "../lib/context.mjs";
import { tempHome, CONFIG } from "./helpers.mjs";

test("init writes only a private selected-harness config and refuses overwrite", async () => {
  const home = join(realpathSync(tempHome()), "new-home"), worktrees = realpathSync(tempHome());
  const options = { home, worktrees, login: "fixture", harness: "codex", discover: () => ({ codex: { bin: process.execPath }, claude: { bin: process.execPath } }) };
  const result = await init(options);
  assert.deepEqual(Object.keys(result.config.harness), ["codex"]);
  assert.equal(result.config.notify, null);
  assert.equal(statSync(result.file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const before = readFileSync(result.file, "utf8");
  await assert.rejects(init(options), /already exists/);
  assert.equal(readFileSync(result.file, "utf8"), before);
});

test("init refuses unsupported, missing and unsafe setup before writing", async () => {
  const root = realpathSync(tempHome()), home = join(root, "home");
  await assert.rejects(init({ home, harness: "goose" }), /codex or claude/);
  await assert.rejects(init({ home, discover: () => ({}) }), /not on PATH/);
  assert.equal(existsSync(home), false);
  symlinkSync(join(root, "missing"), home);
  await assert.rejects(init({ home, login: "fixture", discover: () => ({ codex: { bin: process.execPath } }) }));
  assert.equal(existsSync(join(root, "missing")), false);
});

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
