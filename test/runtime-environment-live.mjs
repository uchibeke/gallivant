// Opt-in native probe. Uses the configured Claude settings, including all guards.
import { readFileSync, mkdtempSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { buildRun } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { makeRunner } from "../lib/run.mjs";
import { gallivantHome } from "../lib/fs.mjs";

if (process.env.GALLIVANT_RUNTIME_LIVE !== "yes") throw new Error("Set GALLIVANT_RUNTIME_LIVE=yes to approve one bounded Claude probe.");
const config = JSON.parse(readFileSync(join(gallivantHome(), "config.json")));
const root = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-runtime-live-")));
const cwd = join(root, "checkout"); mkdirSync(cwd);
const spec = buildRun({ harness: "claude", config: { ...config, max_budget_usd: 2 }, mode: "start", session: randomUUID(), cwd,
  prompt: `Run exactly one Bash tool call: node -p 'JSON.stringify({execPath:process.execPath,arch:process.arch,cache:process.env.npm_config_cache,path:process.env.PATH})'. Do not read or change any files. Then repeat the JSON result without commentary. This is an operator-authorized runtime diagnostic, not a repository task.`,
});
// Exercise the production ownership/cleanup path as well as the native tool.
const runner = makeRunner(join(root, "runs"));
const job = await runner.start("runtime-probe", spec.cmd, ["--max-turns", "3", ...spec.args], {
  cwd, env: { ...runEnv(), ...spec.env }, runtimeSettings: spec.runtimeSettings,
});
const deadline = Date.now() + 120000;
while (runner.read(job.id)?.exit === null && Date.now() < deadline) await delay(100);
if (runner.read(job.id)?.exit === null) { runner.kill(job.id); await runner.waitForKill(job.id); }
runner.observe();
const result = runner.read(job.id);
const events = runner.lines(job.id).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const outputs = events.flatMap(event => event.message?.content || []).filter(item => item.type === "tool_result");
const observed = outputs.flatMap(item => { try { return [JSON.parse(item.content)]; } catch { return []; } }).find(item => item.execPath);
const expected = { execPath: process.execPath, arch: process.arch, cache: join(cwd, ".cache/gallivant/npm") };
process.stdout.write(JSON.stringify({ expected, observed, hooks: events.filter(e => e.type === "system" && e.subtype === "hook_response").map(e => ({output:e.output,stdout:e.stdout,stderr:e.stderr})), exit: result.exit, error: result.error, result: events.findLast(e => e.type === "result")?.subtype }, null, 2) + "\n");
if (result.exit !== 0 || !observed || observed.execPath !== expected.execPath || observed.arch !== expected.arch || observed.cache !== expected.cache) process.exitCode = 1;
