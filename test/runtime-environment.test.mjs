import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { runtimeEnvironment, sessionExports, claudeRuntimeSettings, shellQuote, runtimeReadPaths } from "../lib/runtime-environment.mjs";
import { findExecutable } from "../lib/executable.mjs";
import { buildRun, buildPreparationRun, assertSafeArgv, assertSafeEnv } from "../lib/harness.mjs";

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
  const merged = JSON.parse(readFileSync(claudeRuntimeSettings(path), "utf8"));
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
    }
  }
});

test("runtime access is read-only and existing sandbox restrictions survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtime-boundary-"));
  const settings = join(dir, "settings.json");
  const filesystem = { denyRead: ["~/.ssh", "~/.aws"], denyWrite: ["/"], allowRead: ["/existing"] };
  writeFileSync(settings, JSON.stringify({ sandbox: { enabled: true, network: { allowedDomains: ["registry.npmjs.org"] }, filesystem } }));
  const result = JSON.parse(readFileSync(claudeRuntimeSettings(settings)));
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
});
