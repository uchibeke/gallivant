// Opt-in native probe. Uses the configured Claude settings, including all guards.
import { readFileSync, mkdtempSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { buildRun } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";

if (process.env.GALLIVANT_RUNTIME_LIVE !== "yes") throw new Error("Set GALLIVANT_RUNTIME_LIVE=yes to approve one bounded Claude probe.");
const config = JSON.parse(readFileSync(join(homedir(), ".gallivant/config.json")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-runtime-live-")));
const spec = buildRun({ harness: "claude", config: { ...config, max_budget_usd: 2 }, mode: "start", session: randomUUID(), cwd,
  prompt: `Run exactly one Bash tool call: node -p 'JSON.stringify({execPath:process.execPath,arch:process.arch,cache:process.env.npm_config_cache,path:process.env.PATH})'. Do not read or change any files. Then repeat the JSON result without commentary. This is an operator-authorized runtime diagnostic, not a repository task.`,
});
const result = spawnSync(spec.cmd, ["--max-turns", "3", ...spec.args], {
  cwd, env: { ...process.env, ...runEnv(), ...spec.env }, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024,
});
const events = (result.stdout || "").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const outputs = events.flatMap(event => event.message?.content || []).filter(item => item.type === "tool_result");
const observed = outputs.flatMap(item => { try { return [JSON.parse(item.content)]; } catch { return []; } }).find(item => item.execPath);
const expected = { execPath: process.execPath, arch: process.arch, cache: join(cwd, "node_modules/.cache/gallivant/npm") };
process.stdout.write(JSON.stringify({ expected, observed, hooks: events.filter(e => e.type === "system" && e.subtype === "hook_response").map(e => ({output:e.output,stdout:e.stdout,stderr:e.stderr})), exit: result.status, error: result.error?.message, result: events.findLast(e => e.type === "result")?.subtype }, null, 2) + "\n");
if (result.status !== 0 || !observed || observed.execPath !== expected.execPath || observed.arch !== expected.arch || observed.cache !== expected.cache) process.exitCode = 1;
