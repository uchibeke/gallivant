import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const lifecycle = ["events", "tick", "chains", "git", "context", "control", "daemon", "prd", "prompt", "tasks", "task_completion", "task_delivery_view", "execution_result", "runtime_node",
  "task_profile", "task_prepare", "task_repository_context", "task_contract", "probe", "codex_cloud_input", "codex_cloud_result",
  "commands/start", "commands/register", "commands/resume", "commands/up", "commands/init", "sources/prd"];
// Comments document historical behavior; executable imports, literals and prompt text are guarded.
const executable = source => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
export function hostBoundaryViolations(source) {
  const code = executable(source), errors = [];
  if (/from\s+["'][^"']*(?:\/gh|\/hosts\/github)[^"']*\.mjs["']/.test(code) || /import\s*\(["'][^"']*(?:\/gh|\/hosts\/github)[^"']*\.mjs["']\)/.test(code)) errors.push("adapter import");
  if (/\bgh\s+(?:pr|api|repo|run)\b|api\.github\.com/.test(code) || /(?:exec|spawn|execFile)\w*\s*\(\s*["']gh["']/.test(code)) errors.push("direct host transport or prompt");
  if (/\.gh\b/.test(code)) errors.push("bypassed registry");
  if (/\bif\s*\([^)]*(?:\.host|\bhost)\s*[!=]==?\s*["']|\bswitch\s*\([^)]*\bhost\b|__typename|StatusContext|github-pull-request/.test(code)) errors.push("host-specific lifecycle decision");
  return errors;
}

test("shared lifecycle and prompts depend on the registry and one normalized review/CI engine", () => {
  for (const name of lifecycle) assert.deepEqual(hostBoundaryViolations(readFileSync(new URL(`../lib/${name}.mjs`, import.meta.url), "utf8")), [], name);
});

test("architectural guard rejects injected CLI/API dependencies and a second host review decision", () => {
  for (const source of [
    'import { makeGh } from "./gh.mjs";',
    'await import("./hosts/github.mjs");',
    'await execFile("gh", ["api", path]);',
    'const prompt = "Run gh pr view 12";',
    'await fetch("https://api.github.com/repos/a/b");',
    'await ctx.gh.prView(repo, number);',
    'if (entry.host === "forge.example") return "clear";',
    'switch (host.host) { case "another.example": return "clear"; }',
    'if (check.__typename === "StatusContext") return true;',
  ]) assert.ok(hostBoundaryViolations(source).length, source);
});

test("GitHub CLI, learning, and ruleset implementation stays in adapter-owned modules", () => {
  const transport = readFileSync(new URL("../lib/gh.mjs", import.meta.url), "utf8");
  assert.match(transport, /exec\("gh"/); assert.match(transport, /learningPage/); assert.match(transport, /rulesets:/);
  assert.match(readFileSync(new URL("../lib/hosts/github_doctor.mjs", import.meta.url), "utf8"), /protectsDefaultBranch/);
});

test("portable host declarations load independently without a registry initialization cycle", () => {
  for (const file of ["hosts/bitbucket_contract", "hosts/github_contract", "host_definitions", "review_policy_contract"]) {
    const url = new URL(`../lib/${file}.mjs`, import.meta.url).href;
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { stdio: "pipe" }), file);
  }
});
