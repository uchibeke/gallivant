import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, realpathSync, readdirSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimeEnvironment, sessionExports, claudeRuntimeSettings, shellQuote, runtimeReadPaths, RUNTIME_SETTINGS_FILE } from "../lib/runtime-environment.mjs";
import { findExecutable } from "../lib/executable.mjs";
import { buildRun, buildPreparationRun, assertSafeArgv, assertSafeEnv } from "../lib/harness.mjs";
import { makeRunner } from "../lib/run.mjs";
import { setTimeout as delay } from "node:timers/promises";

test("runtime PATH restores the selected Node after a conflicting shell snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-test-"));
  const wrong = join(dir, "wrong"); mkdirSync(wrong);
  writeFileSync(join(wrong, "node"), "#!/bin/sh\necho WRONG\n", { mode: 0o755 });
  const before = `${wrong}:/usr/bin:/bin`;
  assert.equal(execFileSync("/bin/sh", ["-c", "node -p process.execPath"], { env: { PATH: before }, encoding: "utf8" }).trim(), "WRONG");
  const output = execFileSync("/bin/sh", ["-c", `${sessionExports()}node -p process.execPath`], { env: { PATH: before }, encoding: "utf8" }).trim();
  assert.equal(output, process.execPath);
  assert.equal(runtimeEnvironment({ PATH: before }).PATH.split(":")[0], dirname(process.execPath));
});

test("shell exports quote spaces and apostrophes and preserve the rest of PATH", () => {
  const node = "/tmp/node's runtime/bin/node";
  const output = execFileSync("/bin/sh", ["-c", `${sessionExports(node)}printf '%s' "$PATH"`], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(output, "/tmp/node's runtime/bin:/usr/bin:/bin");
});

test("Claude runtime hook preserves security settings and appends session exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-settings-"));
  const path = join(dir, "settings.json"), envFile = join(dir, "session.env");
  const settings = { sandbox: { enabled: true }, permissions: { deny: ["Read(.env)"] }, hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "guard" }] }], SessionStart: [{ hooks: [{ type: "command", command: "existing" }] }] } };
  writeFileSync(path, JSON.stringify(settings)); writeFileSync(envFile, "export EXISTING=kept\n");
  const merged = JSON.parse(readFileSync(claudeRuntimeSettings(path, join(dir, RUNTIME_SETTINGS_FILE)), "utf8"));
  assert.equal(merged.sandbox.enabled, true);
  assert.deepEqual(merged.sandbox.filesystem.allowRead, runtimeReadPaths());
  assert.equal(merged.sandbox.filesystem.allowWrite, undefined);
  assert.deepEqual(merged.permissions, settings.permissions);
  assert.deepEqual(merged.hooks.PreToolUse, settings.hooks.PreToolUse);
  assert.deepEqual(merged.hooks.SessionStart[0], settings.hooks.SessionStart[0]);
  assert.deepEqual(JSON.parse(readFileSync(path)), settings);
  const command = merged.hooks.SessionStart[1].hooks[0].command;
  const result = JSON.parse(execFileSync("/bin/sh", ["-c", command], { env: { ...process.env, CLAUDE_ENV_FILE: envFile }, encoding: "utf8" }));
  assert.equal(result.hookSpecificOutput.hookEventName, "SessionStart");
  const actual = execFileSync("/bin/sh", ["-c", `. ${shellQuote(envFile)}; node -p 'process.arch'`], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" }).trim();
  assert.equal(actual, process.arch);
  assert.match(readFileSync(envFile, "utf8"), /EXISTING=kept/);
});

test("portable executable discovery uses PATH without requiring zsh", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-path-"));
  symlinkSync(process.execPath, join(dir, "fixture-cli"));
  assert.equal(findExecutable("fixture-cli", { PATH: dir, SHELL: "/does-not-exist" }), join(dir, "fixture-cli"));
  assert.equal(findExecutable("bad;touch injected", { PATH: dir }), null);
  assert.equal(realpathSync(findExecutable("sh", { PATH: "", SHELL: "/does-not-exist" })), realpathSync("/bin/sh"));
  for (const env of [{}, { PATH: ".:" }, { PATH: "relative" }]) {
    assert.equal(realpathSync(findExecutable("sh", { ...env, SHELL: "/does-not-exist" })), realpathSync("/bin/sh"));
  }
});

test("every local adapter receives identical runtime environment on start and resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-adapters-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true } }));
  for (const harness of ["claude", "codex", "gemini", "opencode", "goose"]) {
    for (const mode of ["start", "resume"]) {
      const spec = buildRun({ harness, mode, config: { max_budget_usd: 2, harness: { [harness]: { bin: `/bin/${harness}`, settings } } }, session: "11111111-1111-4111-8111-111111111111", cwd: dir, prompt: "test" });
      assert.equal(spec.env.PATH.split(":")[0], dirname(process.execPath), `${harness} ${mode}`);
      assert.equal(spec.env.NPM_CONFIG_CACHE, join(dir, "node_modules/.cache/gallivant/npm"));
      assert.equal(spec.env.npm_config_cache, spec.env.NPM_CONFIG_CACHE);
      assertSafeArgv(spec.args); assertSafeEnv(spec.env);
      assert.equal(spec.cmd, `/bin/${harness}`);
      assert.deepEqual(spec.runtimeSettings, harness === "claude" ? { settings, node: process.execPath } : undefined);
    }
  }
  assert.deepEqual(readdirSync(dir), ["settings.json"], "speculative/rebuilt launch descriptions create no snapshots");
});

test("runtime access is read-only and existing sandbox restrictions survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-boundary-"));
  const settings = join(dir, "settings.json");
  const filesystem = { denyRead: ["~/.ssh", "~/.aws"], denyWrite: ["/"], allowRead: ["/existing"] };
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org"] }, filesystem } }));
  const result = JSON.parse(readFileSync(claudeRuntimeSettings(settings, join(dir, RUNTIME_SETTINGS_FILE))));
  assert.deepEqual(result.sandbox.filesystem.denyRead, filesystem.denyRead);
  assert.deepEqual(result.sandbox.filesystem.denyWrite, filesystem.denyWrite);
  assert.deepEqual(result.sandbox.network, { allowedDomains: ["registry.npmjs.org"] });
  assert.deepEqual(result.sandbox.filesystem.allowRead, ["/existing", ...runtimeReadPaths()]);
  assert.ok(runtimeReadPaths().every(p => !["/", process.env.HOME, dirname(process.execPath)].includes(p)));
});

test("tool-free preparation does not receive runtime hooks or new read grants", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-preparation-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true } }));
  const spec = buildPreparationRun({ harness: "claude", mode: "start", config: { max_budget_usd: 2, harness: { claude: { bin: "/bin/claude", settings } } }, session: "11111111-1111-4111-8111-111111111111", cwd: dir, prompt: "test" });
  assert.equal(spec.args[spec.args.indexOf("--settings") + 1], settings);
  assert.ok(spec.args.includes("--restricted"));
  assert.equal(spec.runtimeSettings, undefined);
  assert.deepEqual(readdirSync(dir), ["settings.json"]);
});

async function until(check) {
  const deadline = Date.now() + 10_000;
  while (!check()) { assert.ok(Date.now() < deadline, "run did not reach expected state"); await delay(20); }
}

function ownedFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-owned-")), settings = join(dir, "settings.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true }, hooks: { PreToolUse: [] } }));
  const cwd = join(dir, "checkout"); mkdirSync(cwd);
  return { dir, cwd, settings, runtimeSettings: { settings, node: process.execPath } };
}

for (const mode of ["start", "resume"]) test(`actual ${mode} owns a private snapshot until native process exit`, async t => {
  const { dir, cwd, settings } = ownedFixture(t), bin = join(dir, "claude.mjs"), release = join(dir, "release");
  writeFileSync(bin, `#!${process.execPath}\nimport fs from 'node:fs'; const path=process.argv[process.argv.indexOf('--settings')+1]; console.log(JSON.stringify({path,settings:JSON.parse(fs.readFileSync(path))})); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(timer)},20);`, { mode: 0o755 });
  const spec = buildRun({ harness: "claude", mode, config: { max_budget_usd: 2, harness: { claude: { bin, settings } } }, session: "11111111-1111-4111-8111-111111111111", cwd, prompt: "fixture" });
  const runner = makeRunner(join(dir, "runs"));
  const job = await runner.start(mode, spec.cmd, spec.args, { cwd, env: spec.env, runtimeSettings: spec.runtimeSettings });
  t.after(() => { try { process.kill(job.pid, "SIGKILL"); } catch {} });
  await until(() => runner.lines(job.id).length);
  const observed = JSON.parse(runner.lines(job.id)[0]), snapshot = join(runner.dirOf(job.id), RUNTIME_SETTINGS_FILE);
  assert.equal(observed.path, snapshot);
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  assert.equal(statSync(runner.dirOf(job.id)).mode & 0o777, 0o700);
  assert.ok(observed.settings.hooks.SessionStart.length);
  assert.equal(runner.read(job.id).runtimeSettings, true);
  assert.equal(spec.args[spec.args.indexOf("--settings") + 1], settings, "launch does not mutate the reusable description");
  writeFileSync(release, "done");
  await until(() => runner.read(job.id).exit !== null);
  runner.observe();
  assert.equal(existsSync(snapshot), false);
  assert.deepEqual(JSON.parse(readFileSync(settings)), { sandbox: { enabled: true }, hooks: { PreToolUse: [] } });
});

test("failed spawn and pre-spawn write failure clean only their owned snapshots", async t => {
  const { dir, cwd, settings, runtimeSettings } = ownedFixture(t), root = join(dir, "runs");
  const runner = makeRunner(root);
  const job = await runner.start("missing", join(dir, "missing-bin"), ["--settings", settings], { cwd, runtimeSettings });
  await until(() => runner.read(job.id).exit !== null);
  assert.equal(runner.read(job.id).exit, 127);
  assert.equal(existsSync(join(runner.dirOf(job.id), RUNTIME_SETTINGS_FILE)), false);
  mkdirSync(join(root, "write-failure", "cmd.json"), { recursive: true });
  await assert.rejects(runner.start("failure", process.execPath, ["--settings", settings], { cwd, runtimeSettings, runId: "write-failure" }));
  assert.equal(existsSync(join(root, "write-failure", RUNTIME_SETTINGS_FILE)), false);
  const occupied = join(root, "occupied"); mkdirSync(occupied);
  symlinkSync(settings, join(occupied, RUNTIME_SETTINGS_FILE));
  await assert.rejects(runner.start("occupied", process.execPath, ["--settings", settings], { cwd, runtimeSettings, runId: "occupied" }), { code: "EEXIST" });
  assert.equal(existsSync(join(occupied, RUNTIME_SETTINGS_FILE)), true, "never remove a file we did not create");
  assert.deepEqual(JSON.parse(readFileSync(settings)), { sandbox: { enabled: true }, hooks: { PreToolUse: [] } });
});

test("runtime launch refuses snapshots inside the checkout including symlink aliases", async t => {
  const { dir, cwd, settings, runtimeSettings } = ownedFixture(t), alias = join(dir, "checkout-alias");
  symlinkSync(cwd, alias);
  for (const base of [cwd, alias]) {
    const runner = makeRunner(join(base, "runs"));
    await assert.rejects(runner.start("unsafe", process.execPath, ["--settings", settings], { cwd, runtimeSettings, runId: "unsafe" }), /outside the agent checkout/);
    assert.equal(existsSync(join(runner.dirOf("unsafe"), RUNTIME_SETTINGS_FILE)), false);
  }
});

test("restart retains snapshots for unknown or surviving tools then cleans the settled run", t => {
  const { dir } = ownedFixture(t), root = join(dir, "runs"), id = "interrupted";
  mkdirSync(join(root, id), { recursive: true });
  const snapshot = join(root, id, RUNTIME_SETTINGS_FILE);
  writeFileSync(snapshot, "{}"); writeFileSync(join(root, "latest-run"), id);
  writeFileSync(join(root, id, "job.json"), JSON.stringify({ id, pid: 123456, bin: "claude", exit: null, runtimeSettings: true }));
  let members = null;
  const runner = makeRunner(root, { probe: () => false, processes: () => members });
  runner.settle(id);
  assert.equal(existsSync(snapshot), true);
  members = [{ pid: 123457, group: 123456, started: "fixture" }];
  runner.observe(); assert.equal(existsSync(snapshot), true);
  members = [];
  runner.prepareStart(); assert.equal(existsSync(snapshot), false);
});
