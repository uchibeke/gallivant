import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { indexFile, selection, testUnits, shardUnits, parallelShards, changedPaths, CPU_TEST } from "../scripts/ci-plan.mjs";

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), "ci-plan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, source) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), source); };
  put("test/a.test.mjs", 'import {test} from "node:test"; import "../lib/a.mjs"; test("a",()=>{});');
  put("test/b.test.mjs", 'import {test} from "node:test"; test("b",()=>{});');
  put("lib/a.mjs", 'import "./leaf.mjs";'); put("lib/leaf.mjs", "export const value=1;");
  return { root, put };
};

test("docs avoid runtime duplication; unknown paths, dependencies and releases never produce empty coverage", t => {
  const { root } = fixture(t);
  assert.equal(selection(root, ["docs/prds/example.md"], "pull_request").mode, "docs");
  assert.deepEqual(selection(root, ["docs/prds/example.md"], "pull_request").files, []);
  for (const path of ["package.json", "npm-shrinkwrap.json", ".github/workflows/runtime-portability.yml", "unrecognized.config", "lib/runtime_node.mjs"]) {
    const selected = selection(root, [path], "pull_request");
    assert.equal(selected.files.length, 2, path); assert.equal(selected.platforms.length, 4, path);
  }
  for (const event of ["release", "schedule"]) {
    const selected = selection(root, ["README.md"], event);
    assert.equal(selected.files.length, 2); assert.equal(selected.platforms.length, 4);
  }
});

test("affected tests follow transitive imports while new and deleted dependencies fail closed", t => {
  const { root } = fixture(t);
  assert.deepEqual(selection(root, ["lib/leaf.mjs"], "pull_request").files, ["test/a.test.mjs"]);
  for (const path of ["lib/new.mjs", "lib/deleted.mjs"]) assert.equal(selection(root, [path], "pull_request").files.length, 2);
});

test("computed repository consumers survive nonempty selection, including through shared helpers", t => {
  const { root, put } = fixture(t);
  put("test/computed.test.mjs", 'import "./helpers/computed.mjs";');
  put("test/helpers/computed.mjs", 'const name="leaf"; export const source=new URL(`../../lib/${name}.mjs`,import.meta.url);');
  put("test/dynamic.test.mjs", 'const target="../lib/leaf.mjs"; export const load=()=>import(target);');
  assert.deepEqual(selection(root, ["lib/leaf.mjs"], "pull_request").files,
    ["test/a.test.mjs", "test/computed.test.mjs", "test/dynamic.test.mjs"]);
  assert.equal(indexFile('new URL("../lib/leaf.mjs",import.meta.url)').computed, false);
  assert.deepEqual(indexFile('new URL(`../lib/leaf.mjs`,import.meta.url)').references, ["../lib/leaf.mjs"]);
});

test("real portable browser contracts remain selected for computed module inputs", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const path of ["lib/task_delivery_view.mjs", "lib/tracker/presentation.mjs"]) {
    const selected = selection(root, [path], "pull_request");
    assert.ok(selected.files.includes("test/portable-contracts.test.mjs"), path);
    assert.ok(selected.files.length > 1, "coverage does not depend on the empty-selection fallback");
  }
});

test("docs-only CI rejects missing anchors and links broken by changing another document", t => {
  const { root, put } = fixture(t);
  put("README.md", "See [guide](docs/guide.md#target).\n"); put("CONTRIBUTING.md", "# Contributing\n"); put("SECURITY.md", "# Security\n");
  put("docs/guide.md", "# Target\n");
  put("test/docs-links.test.mjs", readFileSync(new URL("./docs-links.test.mjs", import.meta.url), "utf8"));
  put("plan.json", JSON.stringify({ mode: "docs" }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = args => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  const commit = () => { git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]); };
  git(["init", "-q"]); commit();
  const base = git(["rev-parse", "HEAD"]).toString().trim();
  const runner = fileURLToPath(new URL("../scripts/ci.mjs", import.meta.url));
  const check = () => spawnSync(process.execPath, [runner, "docs", join(root, "plan.json")], { cwd: root,
    env: { ...env, CI_EVENT: "pull_request", CI_BASE_SHA: base }, encoding: "utf8" });
  let result = check(); assert.equal(result.status, 0, result.stdout + result.stderr);
  put("docs/guide.md", "# Renamed\n"); commit();
  result = check(); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /README.md.*guide.md#target/);
  rmSync(join(root, "docs/guide.md")); commit();
  result = check(); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /README.md.*guide.md#target/);
  put("docs/guide.md", "# Target\n"); put("README.md", "# Readme\n[missing](#missing)\n"); commit();
  result = check(); assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /anchor #missing/);
});

test("indexing parses JavaScript rather than treating string examples as registrations", () => {
  const source = `import { test as scenario } from 'node:test';
    const example = 'test("fake",()=>{})';
    scenario('literal',()=>{});
    for (const name of ['dynamic']) scenario(name,()=>{});
    const alias=scenario; alias('indirect',()=>{});`;
  assert.deepEqual(indexFile(source).names, ["literal"]);
});

test("every selected registration has a named shard or an exhaustive dynamic residual; CPU work stays alone", t => {
  const { root, put } = fixture(t);
  put("test/a.test.mjs", `import {test} from 'node:test'; test('alpha',()=>{}); test('alpha beta',()=>{}); test(${JSON.stringify(CPU_TEST)},()=>{}); for(const n of ['dynamic']) test(n,()=>{});`);
  const units = testUnits(root, ["test/a.test.mjs"]);
  assert.equal(units.filter(u => u.residual).length, 1);
  const names = units.flatMap(u => u.names || []);
  assert.deepEqual([...names].sort(), ["alpha", "alpha beta", CPU_TEST].sort());
  const shards = shardUnits(units);
  assert.equal(shards.flatMap(s => s.units).length, units.length);
  assert.equal(shards.find(s => s.isolated).units.length, 1);
  assert.ok(parallelShards(shards).some(s => s.lanes.length === 1 && s.lanes[0][0].isolated));
  assert.throws(() => shardUnits([{ file: "test/a.test.mjs", names: ["too slow"], seconds: 96 }]), /Split that test/);
});

test("a measured slow residual gets its own lane even when literal cases are cheap", t => {
  const { root } = fixture(t);
  const file = "test/a.test.mjs";
  const units = testUnits(root, [file], { [`${file}:residual`]: 48, [`${file}:case`]: 2 });
  const lanes = shardUnits(units);
  assert.equal(lanes.length, 2);
  assert.deepEqual(lanes[0].units, [{ file, residual: true, exclude: ["a"], seconds: 48 }]);
  assert.deepEqual(lanes[1].units[0].names, ["a"]);
});

test("real sharded Node execution retains nested, dynamic, aliased and prefix-overlapping tests exactly once", t => {
  const { root, put } = fixture(t);
  put("package.json", '{"type":"module"}');
  put("test/a.test.mjs", `import {test} from 'node:test'; import {appendFileSync} from 'node:fs';
    const mark=n=>appendFileSync('marks.txt',n+'\\n');
    test('alpha',async t=>{mark('alpha');await t.test('nested',()=>mark('nested'));});
    test('alpha beta',()=>mark('prefix'));
    test('other',()=>mark('other'));
    for(const n of ['dynamic']) test(n,()=>mark(n));
    const alias=test; alias('aliased',()=>mark('aliased'));`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = args => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git(["init", "-q"]); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const sha = git(["rev-parse", "HEAD"]).toString().trim();
  const plan = { version: 1, sha, shards: parallelShards(shardUnits(testUnits(root, ["test/a.test.mjs"], {other:30}), 2)) };
  put("plan.json", JSON.stringify(plan));
  const runner = fileURLToPath(new URL("../scripts/ci.mjs", import.meta.url));
  for (let i=0;i<plan.shards.length;i++) {
    const r = spawnSync(process.execPath, [runner, "run", join(root, "plan.json")], { cwd: root, env: { ...env, CI_SHARD: String(i) }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout+r.stderr);
  }
  assert.deepEqual(readFileSync(join(root,"marks.txt"),"utf8").trim().split("\n").sort(), ["alpha","nested","prefix","other","dynamic","aliased"].sort());
  plan.shards=[{lanes:[[{file:"test/a.test.mjs",names:["does not exist"]}]]}]; put("plan.json",JSON.stringify(plan));
  const missing=spawnSync(process.execPath,[runner,"run",join(root,"plan.json")],{cwd:root,env:{...env,CI_SHARD:"0"},encoding:"utf8"});
  assert.notEqual(missing.status,0,"zero matching tests cannot be green");
});

test("changed paths require a commit identity rather than shell input or a guessed base", () => {
  for (const base of [null, "main", "HEAD; echo unsafe", "f".repeat(39)]) assert.throws(() => changedPaths(process.cwd(),base), /exact base commit/);
});
