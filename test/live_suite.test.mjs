// Offline integration regressions for the opt-in suite. No installed harness is invoked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertUnspentVersionBlock, liveRunEnv, SUITE_MS, TURN_MS } from "./live-support.mjs";

const tokenNames = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
const gitAuthNames = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "SSH_ASKPASS_REQUIRE",
  "GIT_ASKPASS", "GIT_SSH", "GIT_SSH_VARIANT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_KEY_99", "GIT_CONFIG_VALUE_99", "GIT_SSL_CERT", "GIT_SSL_KEY", "GCM_CREDENTIAL_STORE",
  "VSCODE_GIT_ASKPASS_NODE", "VSCODE_GIT_ASKPASS_MAIN", "VSCODE_GIT_ASKPASS_EXTRA_ARGS", "VSCODE_GIT_IPC_HANDLE", "VSCODE_SSH_ASKPASS_HANDLE"];
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
import { execFileSync, spawn } from 'node:child_process';
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
  gitAuth: ${JSON.stringify(gitAuthNames)}.filter(key => key in process.env),
  providerPreserved: process.env.GEMINI_API_KEY === 'offline-provider-sentinel',
  ghConfig: process.env.GH_CONFIG_DIR,
  gitTransport: process.env.GIT_ALLOW_PROTOCOL,
  gitSshCommand: process.env.GIT_SSH_COMMAND,
  gitConfigKeys: execFileSync('git', ['config', '--name-only', '--list'], { encoding: 'utf8' }).trim().split('\\n'),
}));
process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_offline123' }) + '\\n');
if (mode === 'exit') process.exit(1);
if (mode === 'command-permission-error' || mode === 'approval-refusal') {
  const error = mode === 'command-permission-error' ? 'bash: ./live.test.mjs: Permission denied' : 'The user rejected permission to use this specific tool call.';
  process.stdout.write(JSON.stringify({ type: 'tool_use', part: { state: { status: 'error', error } } }) + '\\n');
  if (mode === 'command-permission-error') {
    // Leave time for the real suite monitor to consume the failed command before recovery.
    await new Promise(resolve => setTimeout(resolve, 1000));
    writeFileSync(root + '/recovered.txt', 'offline command recovery reached');
    process.exit(1); // No simulated coding success is treated as live evidence.
  }
  await new Promise(() => { setInterval(() => {}, 1000); }); // An explicit refusal must be killed.
}
if (mode === 'write-fail') {
  const git = (...argv) => execFileSync('git', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  appendFileSync(root + '/fixtures.jsonl', JSON.stringify({ cwd: process.cwd(), head: git('rev-parse', 'HEAD'), files: git('ls-files'), remoteRefs: git('ls-remote', '--refs', 'origin') }) + '\\n');
  writeFileSync('authored.txt', 'offline authored artifact');
  git('add', 'authored.txt'); git('commit', '-m', 'Offline adapter failure fixture'); git('push', '-u', 'origin', 'HEAD');
  process.exit(1); // An adapter-stage failure after edits, commit and push; not live evidence.
}
process.on('SIGTERM', () => { if (mode === 'leader-exits') process.exit(0); });
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.once('data', () => writeFileSync(root + '/ready.json', JSON.stringify({ leader: process.pid, child: child.pid })));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  writeFileSync(join(root, ".gallivant", "config.json"), JSON.stringify({ harness: { opencode: { bin } } }));
  return root;
}

function invoke(root, { watchdog = false, env = {}, retry = false } = {}) {
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
process.argv = [process.execPath, 'live-harnesses.mjs', '--live', ...${JSON.stringify(retry
    ? ["--retry", root, "opencode-console-meta:start", "docs/audit/harness-live-validation.md"]
    : ["--append", root, "opencode-console-meta"])}];
await import(${JSON.stringify(new URL("./live-harnesses.mjs", import.meta.url).href)});
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: { ...process.env, ...Object.fromEntries(tokenNames.map(key => [key, "offline-github-sentinel"])), GEMINI_API_KEY: "offline-provider-sentinel", ...env },
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

test("live monitor allows command permission recovery and still stops explicit approval refusals", async () => {
  for (const mode of ["command-permission-error", "approval-refusal"]) {
    const root = fixture(mode);
    let run;
    try {
      run = invoke(root);
      const result = await run.done;
      assert.equal(result.code, 1, result.stderr);
      const turn = read(join(root, "report.json")).cases[0].turns[0];
      const refused = mode === "approval-refusal";
      assert.equal(existsSync(join(root, "recovered.txt")), !refused);
      assert.equal(turn.exit, refused ? 137 : 1);
      assert.equal(turn.status, refused ? "blocked" : "failed");
      assert.equal(turn.failure.category, refused ? "permissions" : "unclassified");
      if (refused) assert.match(turn.failure.remedy, /scoped approval/);
      else assert.doesNotMatch(turn.failure.remedy, /scoped approval/);
    } finally { cleanup(root, run?.child); }
  }
});

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

test("live child environment strips Git and SSH credential channels and restores only trusted Git config", async () => {
  const root = fixture();
  let run;
  try {
    const inherited = { ...Object.fromEntries(gitAuthNames.map(key => [key, "offline-auth-sentinel"])),
      GIT_SSH_COMMAND: "offline-auth-sentinel", GIT_ALLOW_PROTOCOL: "ssh:https",
      GIT_CONFIG_PARAMETERS: "'credential.helper=!false'",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: offline-header",
    };
    const identity = { name: "Offline probe", email: "probe@example.invalid" };
    const env = liveRunEnv({}, identity, root, { ...inherited,
      GIT_CONFIG_GLOBAL: "/untrusted/config", GIT_CONFIG_NOSYSTEM: "0", GH_CONFIG_DIR: "/untrusted/gh",
      GIT_TERMINAL_PROMPT: "1", GEMINI_API_KEY: "offline-provider-sentinel",
    });
    for (const key of gitAuthNames) assert.equal(env[key], undefined, key);
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(env.GH_CONFIG_DIR, join(root, ".git", "gallivant-gh"));
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_ALLOW_PROTOCOL, "file");
    assert.equal(env.GIT_SSH_COMMAND, "false");
    assert.equal(env.GEMINI_API_KEY, "offline-provider-sentinel");
    const pairs = Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    assert.deepEqual(pairs.filter(([key]) => key.startsWith("user.")), [["user.name", identity.name], ["user.email", identity.email]]);
    assert.equal(pairs.some(([key]) => key === "http.extraHeader"), false);

    // The actual suite uses this environment for fixture Git operations, the shared
    // runner and metadata exports. No SSH agent, helper or network endpoint is contacted.
    run = invoke(root, { env: inherited });
    const result = await run.done;
    assert.equal(result.code, 1, result.stderr); // The offline harness intentionally fails.
    const actual = read(join(root, "environment.json"));
    assert.deepEqual(actual.gitAuth, []);
    assert.deepEqual(actual.tokens, []);
    assert.equal(actual.providerPreserved, true);
    assert.equal(actual.gitTransport, "file");
    assert.equal(actual.gitSshCommand, "false");
    assert.equal(actual.gitConfigKeys.includes("http.extraheader"), false);
    assert.equal(actual.gitConfigKeys.filter(key => key === "credential.helper").length, 1);
    assert.ok(actual.gitConfigKeys.includes("user.name") && actual.gitConfigKeys.includes("user.email"));
    assert.equal(read(join(root, "report.json")).cases[0].turns.length, 1);
  } finally { cleanup(root, run?.child); }
});

test("live Git transport permits local remotes and refuses SSH default identities and network URLs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-live-transport-")));
  try {
    const env = liveRunEnv({}, { name: "Transport probe", email: "probe@example.invalid" }, root);
    assert.equal(env.HOME, process.env.HOME, "provider HOME must stay intact");
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git("init", "-b", "probe");
    git("init", "--bare", "--initial-branch=probe", join(root, "remote.git"));
    git("commit", "--allow-empty", "-m", "Local transport probe");
    git("push", join(root, "remote.git"), "HEAD");
    assert.equal(git("ls-remote", join(root, "remote.git"), "HEAD").split(/\s/)[0], git("rev-parse", "HEAD"));
    for (const [protocol, url] of [["ssh", "git@127.0.0.1:blocked.git"], ["ssh", "ssh://git@127.0.0.1:1/blocked.git"],
      ["https", "https://127.0.0.1:1/blocked.git"], ["http", "http://127.0.0.1:1/blocked.git"], ["git", "git://127.0.0.1:1/blocked.git"]]) {
      const result = spawnSync("git", ["push", url, "HEAD"], { cwd: root, env, encoding: "utf8", timeout: 1_000 });
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.ok(result.stderr.includes(`transport '${protocol}' not allowed`), result.stderr);
    }
    // The Git SSH command itself refuses execution, without loading SSH config,
    // default identity files or an agent. No SSH connection is attempted.
    assert.equal(spawnSync("/bin/sh", ["-c", env.GIT_SSH_COMMAND], { env }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live start retry preserves authored evidence and uses a fresh checkout and bare remote", async () => {
  const root = fixture("write-fail");
  let run;
  try {
    run = invoke(root);
    assert.equal((await run.done).code, 1);
    const before = read(join(root, "report.json"));
    const first = before.cases[0];
    assert.equal(first.turns[0].failure.stage, "adapter");
    assert.equal(first.turns[0].failure.category, "unclassified");
    const env = liveRunEnv({}, null, first.cwd);
    const git = (...args) => execFileSync("git", args, { cwd: first.cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const originalHead = git("rev-parse", "HEAD");
    assert.notEqual(originalHead, first.initial);
    assert.equal(git("--git-dir", first.remote, "rev-parse", "HEAD"), originalHead);
    const originalLog = readFileSync(join(root, first.turns[0].run, "job.log"), "utf8");
    // Represent a pre-fix adapter revision only in this synthetic offline ledger.
    // No production report is relabeled and no model/provider is invoked.
    first.turns[0].source.sha256["lib/harness.mjs"] = "offline-pre-fix-revision";
    writeFileSync(join(root, "report.json"), JSON.stringify(before));
    run = invoke(root, { retry: true });
    const result = await run.done;
    assert.equal(result.code, 1, result.stderr);
    const after = read(join(root, "report.json"));
    const entry = after.cases[0];
    assert.equal(after.startedAt, before.startedAt);
    assert.deepEqual(entry.turns[0], first.turns[0]);
    assert.deepEqual(entry.configured, first.configured);
    assert.deepEqual(entry.previousStartFixture, { cwd: first.cwd, remote: first.remote, initial: first.initial, requestedSession: first.requestedSession });
    assert.notEqual(entry.cwd, first.cwd);
    assert.notEqual(entry.remote, first.remote);
    assert.equal(entry.turns.length, 2);
    assert.equal(entry.turns[1].attempt, 2);
    assert.equal(entry.retry.phase, "start");
    assert.equal(entry.turns[1].fixture.cwd, entry.cwd);
    assert.equal(entry.turns[1].fixture.remote, entry.remote);
    const starts = readFileSync(join(root, "fixtures.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(starts.length, 2);
    assert.equal(starts[1].cwd, entry.cwd);
    assert.equal(starts[1].head, entry.initial);
    assert.equal(starts[1].files, "");
    assert.equal(starts[1].remoteRefs, "");
    assert.equal(git("rev-parse", "HEAD"), originalHead);
    assert.equal(git("--git-dir", first.remote, "rev-parse", "HEAD"), originalHead);
    assert.equal(readFileSync(join(first.cwd, "authored.txt"), "utf8"), "offline authored artifact");
    assert.equal(readFileSync(join(root, first.turns[0].run, "job.log"), "utf8"), originalLog);
    run = invoke(root, { retry: true });
    assert.match((await run.done).stderr, /Only one targeted retry/);
    assert.equal(readFileSync(join(root, "fixtures.jsonl"), "utf8").trim().split("\n").length, 2);
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
