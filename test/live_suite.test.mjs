// Offline integration regressions for the opt-in suite. No installed harness is invoked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertUnspentVersionBlock, liveRunEnv, SUITE_MS, TURN_MS } from "./live-support.mjs";

const tokenNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const read = path => JSON.parse(readFileSync(path, "utf8"));
const waitUntil = async predicate => {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(50); }
  assert.fail("offline child did not reach the expected state");
};
const running = pid => {
  try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().startsWith("Z"); }
  catch { return false; }
};

function fixture(mode = "exit") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-suite-offline-")));
  mkdirSync(join(root, ".gallivant"));
  writeFileSync(join(root, "report.json"), JSON.stringify({ privateEvidence: root, startedAt: new Date().toISOString(), turnLimitMs: TURN_MS, suiteLimitMs: SUITE_MS, cases: [] }));
  writeFileSync(join(root, "version"), "2.0.0");
  const bin = join(root, "probe.mjs");
  const descendant = `process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);`;
  writeFileSync(bin, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const root = ${JSON.stringify(root)}, mode = ${JSON.stringify(mode)};
const args = process.argv.slice(2);
appendFileSync(root + '/calls.jsonl', JSON.stringify(args.slice(0, 2)) + '\\n');
if (args[0] === '--version') { process.stdout.write(readFileSync(root + '/version', 'utf8')); process.exit(0); }
if (args[0] === 'export') {
  writeFileSync(root + '/exported.json', JSON.stringify({ at: Date.now() }));
  process.stdout.write(JSON.stringify({ info: { directory: process.cwd() }, messages: [] })); process.exit(0);
}
writeFileSync(root + '/environment.json', JSON.stringify({
  tokens: ${JSON.stringify(tokenNames)}.filter(key => key in process.env),
  providerPreserved: process.env.GEMINI_API_KEY === 'offline-provider-sentinel',
  ghConfig: process.env.GH_CONFIG_DIR,
}));
process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_offline123' }) + '\\n');
if (mode === 'exit') process.exit(1);
process.on('SIGTERM', () => { if (mode === 'leader-exits') process.exit(0); });
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => writeFileSync(root + '/ready.json', JSON.stringify({ leader: process.pid, child: child.pid })));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  writeFileSync(join(root, ".gallivant", "config.json"), JSON.stringify({ harness: { opencode: { bin } } }));
  return root;
}

function invoke(root, { watchdog = false } = {}) {
  const source = `
import os from 'node:os';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(root)};
syncBuiltinESMExports();
// Trigger the actual watchdog callback once the offline process tree is ready,
// without changing the deadline, fallback timer, or any provider settings.
if (${watchdog}) {
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => ms > ${SUITE_MS / 2}
    ? setInterval(() => { if (existsSync(${JSON.stringify(join(root, "ready.json"))})) fn(...args); }, 50)
    : timeout(fn, ms, ...args);
}
process.argv = [process.execPath, 'live-harnesses.mjs', '--live', '--append', ${JSON.stringify(root)}, 'opencode-console-meta'];
await import(${JSON.stringify(new URL("./live-harnesses.mjs", import.meta.url).href)});
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ...Object.fromEntries(tokenNames.map(key => [key, "offline-github-sentinel"])), GEMINI_API_KEY: "offline-provider-sentinel" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stderr, at: Date.now() }));
  });
  return { child, done };
}

function cleanup(root, child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (existsSync(join(root, "ready.json"))) {
    const pids = read(join(root, "ready.json"));
    try { process.kill(-pids.leader, "SIGKILL"); } catch { /* already reaped */ }
  }
  rmSync(root, { recursive: true, force: true });
}

test("live child environment excludes inherited GitHub tokens through the shared runner", async () => {
  const root = fixture();
  let run;
  try {
    const extra = Object.fromEntries(tokenNames.map(key => [key, "offline-override"]));
    const env = liveRunEnv({}, null, root, extra);
    for (const key of tokenNames) assert.equal(env[key], undefined);
    run = invoke(root);
    const result = await run.done;
    assert.equal(result.code, 1, result.stderr);
    const actual = read(join(root, "environment.json"));
    assert.deepEqual(actual.tokens, []);
    assert.equal(actual.providerPreserved, true);
    assert.equal(actual.ghConfig, join(root, "opencode-console-meta", "checkout", ".git", "gallivant-gh"));
  } finally { cleanup(root, run?.child); }
});

test("live append reuses an unspent version block after upgrade without resetting its budget or selection", async () => {
  const root = fixture();
  let run;
  try {
    writeFileSync(join(root, "version"), "0.0.0");
    run = invoke(root);
    assert.equal((await run.done).code, 1);
    const before = read(join(root, "report.json"));
    assert.equal(before.cases[0].blockedInvocation, 0);
    assert.deepEqual(before.cases[0].turns, []);
    assert.equal(existsSync(join(root, "environment.json")), false);
    assertUnspentVersionBlock(before.cases[0], before);
    writeFileSync(join(root, "version"), "2.0.0");
    run = invoke(root);
    const result = await run.done;
    assert.equal(result.code, 1, result.stderr); // The offline probe deliberately fails its turn.
    const after = read(join(root, "report.json"));
    assert.equal(after.startedAt, before.startedAt);
    assert.deepEqual(after.invocations[0], before.invocations[0]);
    assert.equal(after.cases.length, 1);
    assert.deepEqual(after.cases[0].configured, before.cases[0].configured);
    assert.equal(after.cases[0].requestedSession, before.cases[0].requestedSession);
    assert.equal(after.cases[0].blockedInvocation, undefined);
    assert.equal(after.cases[0].turns.length, 1);
    assert.equal(after.cases[0].turns[0].attempt, 1);
    assert.equal(after.cases[0].retry, undefined);
    run = invoke(root);
    assert.match((await run.done).stderr, /only an unspent version-blocked case/);
    assert.equal(read(join(root, "report.json")).cases[0].turns.length, 1);
  } finally { cleanup(root, run?.child); }
});

test("live append rejects attempted, reserved, fixture-bearing and non-version blocks", () => {
  const report = { invocations: [{ versions: { opencode: { ok: false } } }] };
  const entry = { harness: "opencode", blockedInvocation: 0, turns: [] };
  assertUnspentVersionBlock(entry, report);
  for (const change of [{ turns: [{ status: "failed" }] }, { retry: {} }, { cwd: "/fixture" }, { remote: "/remote" }, { initial: "commit" }, { blockedInvocation: undefined }, { blockedInvocation: 1 }, { blockedInvocation: -1 }]) {
    assert.throws(() => assertUnspentVersionBlock({ ...entry, ...change }, report), /only an unspent version-blocked case/);
  }
  assert.throws(() => assertUnspentVersionBlock(entry, { invocations: [{ versions: { opencode: { ok: true } } }] }), /only an unspent version-blocked case/);
});

test("live signal and watchdog stops await the process-group fallback before metadata and exit", async t => {
  for (const [reason, mode] of [["SIGINT", "ignore"], ["SIGTERM", "leader-exits"], ["watchdog", "ignore"]]) {
    await t.test(reason, async () => {
      const root = fixture(mode);
      let run;
      try {
        run = invoke(root, { watchdog: reason === "watchdog" });
        await waitUntil(() => existsSync(join(root, "ready.json")));
        const pids = read(join(root, "ready.json"));
        const stoppedAt = Date.now();
        if (reason !== "watchdog") run.child.kill(reason);
        const result = await run.done;
        assert.equal(result.code, 1, result.stderr);
        assert.ok(result.at - stoppedAt >= 4_800, "suite must wait for the five-second kill fallback");
        assert.ok(read(join(root, "exported.json")).at - stoppedAt >= 4_800, "metadata must follow the fallback");
        await waitUntil(() => !running(pids.leader) && !running(pids.child));
        const report = read(join(root, "report.json"));
        if (reason === "watchdog") assert.equal(report.suiteTimedOut, true);
        else assert.equal(report.interrupted, reason);
        assert.equal(report.cases[0].turns[0].failure.category, "timeout");
      } finally { cleanup(root, run?.child); }
    });
  }
});
