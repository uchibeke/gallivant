import { readFileSync, writeFileSync, appendFileSync, existsSync, lstatSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { selection, testUnits, shardUnits, parallelShards, changedPaths, patternFor } from "./ci-plan.mjs";

const root = process.cwd(), command = process.argv[2];
const sha = () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const output = (key, value) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${typeof value === "string" ? value : JSON.stringify(value)}\n`); };
const event = process.env.CI_EVENT || "pull_request", base = process.env.CI_BASE_SHA;
const paths = () => event === "pull_request" || event === "push" && base && !/^0+$/.test(base) ? changedPaths(root, base) : [];
const execute = promisify(execFile);

async function runLane(units, deadline) {
  const files = new Map();
  for (const unit of units) {
    if (!/^test\/[a-zA-Z0-9_-]+\.test\.mjs$/.test(unit.file)) throw new Error("Invalid CI test path");
    const key = `${unit.file}:${Boolean(unit.residual)}`;
    const group = files.get(key) || { file: unit.file, residual: Boolean(unit.residual), names: [], exclude: unit.exclude || [] };
    group.names.push(...unit.names || []); files.set(key, group);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Explicit child runners cannot inherit a parent's internal test protocol.
  env.FORCE_COLOR = "0";
  for (const group of files.values()) {
    const names = group.residual ? group.exclude : group.names;
    // Node 22 and 24 do not use the same default reporter. Verify one stable
    // output contract on both release lines.
    const args = ["--test", "--test-concurrency=1", "--test-reporter=tap"];
    if (names.length) args.push(`${group.residual ? "--test-skip-pattern" : "--test-name-pattern"}=${patternFor(names)}`);
    args.push(group.file);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("CI shard exceeded its execution budget");
    console.log(`Running ${group.file}: ${group.residual ? "all residual registrations" : names.length ? `${names.length} named tests` : "whole file"}`);
    let result;
    try { result = await execute(process.execPath, args, { env, encoding: "utf8", timeout: remaining, maxBuffer: 16 * 1024 * 1024 }); }
    catch (error) {
      process.stdout.write(error.stdout || ""); process.stderr.write(error.stderr || "");
      throw new Error(`CI test process failed for ${group.file} (${error.killed ? "deadline exceeded" : error.code ?? error.signal ?? "execution error"})`);
    }
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    const observed = new Set([...result.stdout.matchAll(/^# Subtest: ([^\r\n]*)$/gm)].map(match => match[1]));
    const missing = group.residual ? [] : names.filter(name => !observed.has(name));
    if (missing.length) throw new Error(`Selected tests were not observed in ${group.file}: ${JSON.stringify(missing.slice(0, 5))}. Refusing an incomplete green gate.`);
  }
}

if (command === "plan") {
  const changed = paths();
  const selected = selection(root, changed, event);
  const weights = JSON.parse(readFileSync(new URL("./ci-weights.json", import.meta.url)));
  const shards = parallelShards(shardUnits(testUnits(root, selected.files, weights)));
  const plan = { version: 1, sha: sha(), ...selected, shards };
  writeFileSync(process.argv[3], JSON.stringify(plan));
  const matrix = selected.platforms.flatMap(platform => shards.map((_, index) => ({ ...platform, index })));
  if (matrix.length > 240) throw new Error("CI plan exceeds the bounded matrix; split or rebalance the inventory");
  output("units", { include: matrix.length ? matrix : [{ os: "ubuntu-24.04", node: 22, index: -1 }] });
  output("smoke", { include: selected.smoke });
  output("has_units", Boolean(matrix.length)); output("browser", selected.browser);
  output("mode", selected.mode);
  const summary = `## CI plan\n\nMode: **${selected.mode}**. Selected ${selected.files.length} test files in ${shards.length} bounded shards. ${matrix.length} OS/Node shard jobs.\n\nOrdinary files run intact. Partitioned files retain named tests and an exhaustive residual for dynamic registrations. Each job has a two-minute hard limit; timeout fails the gate. Full four-platform qualification is retained for sensitive PRs, nightly runs and release calls.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
} else if (command === "run") {
  const plan = JSON.parse(readFileSync(process.argv[3])), index = Number(process.env.CI_SHARD);
  if (plan.version !== 1 || plan.sha !== sha() || !Number.isInteger(index) || !plan.shards[index]) throw new Error("CI plan identity or shard mismatch");
  const lanes = plan.shards[index].lanes;
  if (!Array.isArray(lanes) || !lanes.length || lanes.length > 2 || lanes.some(lane => !Array.isArray(lane) || !lane.length)) throw new Error("Invalid CI shard lanes");
  const deadline = Date.now() + 100_000;
  const results = await Promise.allSettled(lanes.map(lane => runLane(lane, deadline)));
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
} else if (command === "docs") {
  const plan = JSON.parse(readFileSync(process.argv[3]));
  const changed = paths();
  for (const file of changed.filter(path => path.endsWith(".md") && existsSync(resolve(root, path)))) {
    if (!lstatSync(resolve(root, file)).isFile()) throw new Error(`Documentation must be a regular file: ${file}`);
    const text = readFileSync(resolve(root, file), "utf8");
    if (/^docs\/prds\/[a-z0-9-]+\.md$/.test(file)) execFileSync(process.execPath, ["bin/gallivant.mjs", "ready", file, "--check"], { stdio: "inherit" });
    for (const [, raw] of text.replace(/```[\s\S]*?```/g, "").matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = raw.replace(/^<|>$/g, "").split("#")[0];
      if (!link || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(link)) continue;
      const target = resolve(dirname(resolve(root, file)), decodeURIComponent(link));
      if (relative(root, target).startsWith("..") || !existsSync(target)) throw new Error(`Broken local documentation link in ${file}: ${link}`);
    }
  }
  console.log(`Documentation and PRD checks passed (${plan.mode}).`);
} else throw new Error("Use ci.mjs plan|run|docs");
