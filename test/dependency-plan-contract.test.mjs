import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs, { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileDependencyPlan, compileLinearChain, dependencyPlanApprovalDigest, PLAN_LIMITS } from "../lib/dependency_plan.mjs";
import { contentDigest } from "../lib/hash.mjs";
import { check, parsePrd } from "../lib/prd.mjs";
import { recoveryDigest } from "../lib/recovery_digest.mjs";

const examples = fileURLToPath(new URL("../templates/dependency-plan", import.meta.url));
const cli = fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url));
const brief = readFileSync(join(examples, "docs/prds/synthetic-plan-view.md"), "utf8");
const repo = "example-org/example-project";
const prd = id => `docs/prds/${id}.md`;
const task = (id, needs = []) => ({ id, type: "task", repository: "demo", prd: prd(id), needs });
const group = (id, mode, children, needs = []) => ({ id, type: "group", mode, children, needs });
const anchor = (id, target = { plan: "another-plan", boundary: "terminal" }) => ({ id, type: "anchor", target });
const plan = nodes => ({ version: 1, name: "contract-example", repositories: { demo: { repository: repo, checkout: ".", base: "release/v1" } }, nodes });
const pairs = graph => graph.edges.map(({ from, to }) => [from, to]);

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "dependency-plan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function put(path, text) {
    const target = join(directory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
    return target;
  }
  const json = (path, value) => put(path, JSON.stringify(value, null, 2));
  const run = (file = "plan.json", options = {}) => compileDependencyPlan(file, { directory, ...options });
  function compile(value) {
    json("plan.json", value);
    return run();
  }
  const briefs = (...ids) => ids.forEach(id => put(prd(id), brief));
  return { put, json, run, compile, briefs, directory };
}

test("shipped JSON and YAML compile the same diamond and reference real synthetic briefs", () => {
  const json = compileDependencyPlan("synthetic.json", { directory: examples });
  const yaml = compileDependencyPlan("synthetic.yaml", { directory: examples });
  assert.deepEqual(json.graph, yaml.graph);
  assert.equal(json.graphDigest, yaml.graphDigest);
  assert.notEqual(json.approvalDigest, yaml.approvalDigest);
  assert.deepEqual(pairs(json.graph), [
    ["console/plan-view", "qualification"], ["console/task-view", "qualification"],
    ["foundation-finished", "console/plan-view"], ["foundation-finished", "console/task-view"],
  ]);
  assert.equal(json.admission, "unbound");
  assert.deepEqual(json.graph.nodes[0], {
    id: "foundation-finished", type: "anchor", target: { plan: "synthetic-foundation", boundary: "terminal" }, resolution: "unresolved",
  });
  for (const { prd: path } of json.graph.nodes.filter(node => node.type === "task")) {
    const text = readFileSync(join(examples, path), "utf8");
    const request = parsePrd(text, path);
    assert.ok(check(request).ok, path);
    assert.equal(request.status, "ready", path);
    assert.deepEqual(json.sources.find(source => source.path === path), { path, digest: contentDigest(text) });
  }
});

test("nested sequence and parallel groups expand exact boundaries and AND edges", t => {
  const w = workspace(t);
  w.briefs("setup", "independent", "source", "bundle", "scan", "docs", "unit", "format", "linux", "mac", "handoff");
  const input = plan([
    task("setup"), task("independent"),
    group("build", "parallel", [
      group("packages", "sequence", [task("source", ["/setup"]), task("bundle")]),
      task("scan", ["build/packages/bundle"]),
      task("docs"),
    ], ["setup"]),
    group("checks", "sequence", [
      group("lanes", "parallel", [task("unit"), task("format")]),
      group("targets", "parallel", [task("linux"), task("mac")]),
    ], ["build"]),
    task("handoff", ["checks"]),
  ]);
  const result = w.compile(input);
  assert.deepEqual(w.run(), result);
  assert.deepEqual(result.graph.entries, ["independent", "setup"]);
  assert.deepEqual(result.graph.exits, ["handoff", "independent"]);
  assert.deepEqual(pairs(result.graph), [
    ["build/docs", "checks/lanes/format"], ["build/docs", "checks/lanes/unit"],
    ["build/packages/bundle", "build/scan"], ["build/packages/source", "build/packages/bundle"],
    ["build/scan", "checks/lanes/format"], ["build/scan", "checks/lanes/unit"],
    ["checks/lanes/format", "checks/targets/linux"], ["checks/lanes/format", "checks/targets/mac"],
    ["checks/lanes/unit", "checks/targets/linux"], ["checks/lanes/unit", "checks/targets/mac"],
    ["checks/targets/linux", "handoff"], ["checks/targets/mac", "handoff"],
    ["setup", "build/docs"], ["setup", "build/packages/source"],
  ]);
  const build = result.graph.hierarchy[2];
  assert.deepEqual(build.entries, ["build/docs", "build/packages/source"]);
  assert.deepEqual(build.exits, ["build/docs", "build/scan"]);
  assert.deepEqual(build.children[0].exits, ["build/packages/bundle"]);
});

test("nested fragments resolve relative to their files and retain qualified local IDs", t => {
  const w = workspace(t);
  w.briefs("verify");
  const producer = anchor("previous", { plan: "unstarted-plan", node: "release/last" });
  w.put("fragments/common.yaml", "version: 1\nchildren:\n  - id: gate\n    type: group\n    mode: parallel\n    file: nested/gates.json\n");
  w.json("fragments/nested/gates.json", { version: 1, children: [producer] });
  const included = id => ({ id, type: "group", mode: "parallel", file: "./fragments/common.yaml" });
  const fragment = w.compile(plan([included("first"), included("second"), task("verify", ["second", "first"])]));
  const inline = id => group(id, "parallel", [group("gate", "parallel", [producer])]);
  const expanded = w.compile(plan([inline("first"), inline("second"), task("verify", ["first", "second", "first"])]));
  assert.deepEqual(pairs(fragment.graph), [["first/gate/previous", "verify"], ["second/gate/previous", "verify"]]);
  assert.deepEqual(fragment.graph, expanded.graph);
  assert.equal(fragment.graphDigest, expanded.graphDigest);
  assert.notEqual(fragment.approvalDigest, expanded.approvalDigest);
  assert.deepEqual(fragment.graph.nodes.slice(0, 2).map(node => [node.target.node, node.resolution]), [
    ["release/last", "unresolved"], ["release/last", "unresolved"],
  ]);
  assert.deepEqual(fragment.sources.map(source => source.path), [
    prd("verify"), "fragments/common.yaml", "fragments/nested/gates.json", "plan.json",
  ]);
});

test("approval digest pins exact path and bytes of manifests, fragments, briefs and carried sources", t => {
  const w = workspace(t);
  const withSource = brief.replace("status: ready", "status: ready\nsources: [context/input.txt]");
  w.put(prd("verify"), withSource);
  const carriedFile = w.put("context/input.txt", "synthetic source\r\n");
  const fragment = w.json("fragment.json", { version: 1, children: [task("verify")] });
  const manifest = w.json("plan.json", plan([{ id: "verify", type: "group", mode: "parallel", file: "fragment.json" }]));
  const first = w.run();
  assert.equal(first.sources.find(source => source.path === "context/input.txt").digest, contentDigest("synthetic source\r\n"));
  assert.equal(dependencyPlanApprovalDigest(first), first.approvalDigest);
  const binding = recoveryDigest({ host: "example.test", baseSha: "a".repeat(40), terminal: ["release/last"] });
  assert.notEqual(dependencyPlanApprovalDigest(first, binding), first.approvalDigest);
  assert.equal(dependencyPlanApprovalDigest(w.run(), binding), dependencyPlanApprovalDigest(first, binding));
  assert.throws(() => dependencyPlanApprovalDigest(first, "arbitrary binding"), /SHA-256/);
  w.put("copy.json", readFileSync(manifest));
  assert.equal(w.run("copy.json").graphDigest, first.graphDigest);
  assert.notEqual(w.run("copy.json").approvalDigest, first.approvalDigest);
  let last = first;
  for (const path of [manifest, fragment, join(w.directory, prd("verify")), carriedFile]) {
    appendFileSync(path, "\n");
    const next = w.run();
    assert.equal(next.graphDigest, first.graphDigest);
    assert.notEqual(next.approvalDigest, last.approvalDigest);
    last = next;
  }
});

test("closed v1 fails locally on malformed nodes, unresolved needs, duplicate ownership and cycles", t => {
  const w = workspace(t);
  w.briefs("alpha", "beta");
  const duplicate = plan([task("alpha"), group("nested", "parallel", [
    { ...task("other-id"), repository: "alias", prd: prd("alpha") },
  ])]);
  duplicate.repositories.alias = { repository: "github.com/Example-Org/Example-Project", checkout: ".", base: "different-base" };
  for (const [input, message] of [
    [{ ...plan([task("alpha")]), version: 2 }, /unsupported plan version/],
    [{ ...plan([task("alpha")]), policies: {} }, /unknown field "policies"/],
    [plan([]), /plan must contain at least one node/],
    [plan([group("empty", "parallel", [])]), /group must contain at least one child/],
    [plan([anchor("external")]), /at least one executable task/],
    [plan([task("alpha"), task("alpha")]), /duplicate node ID alpha/],
    [duplicate, /duplicate canonical task identity example-org\/example-project\/alpha.*first declared at plan.json:/],
    [plan([{ ...task("alpha"), repository: "unknown" }]), /unknown repository alias/],
    [plan([{ ...task("alpha"), exec: "a command" }]), /unknown field "exec"/],
    [plan([{ id: "activity", type: "activity" }]), /node type must be task, group or anchor/],
    [plan([{ ...group("both", "parallel", [task("alpha")]), file: "f.json" }]), /exactly one of children or file/],
    [plan([anchor("external", { plan: "other", node: "tail", boundary: "terminal" }), task("alpha")]), /exactly one of boundary or node/],
    [plan([anchor("external", { plan: "other", boundary: "anything" }), task("alpha")]), /anchor boundary must be terminal/],
    [plan([anchor("external", { plan: "other", node: "../tail" }), task("alpha")]), /invalid node reference/],
    [plan([task("alpha", ["absent"])]), /unresolved local needs reference absent/],
    [plan([task("alpha"), group("g", "parallel", [task("beta", ["alpha"])])]), /unresolved local needs reference alpha/],
    [plan([task("alpha", ["alpha"])]), /dependency cycle/],
    [plan([group("g", "parallel", [task("alpha", ["/g"])])]), /dependency cycle/],
    [plan([task("alpha", ["beta"]), task("beta", ["alpha"])]), /dependency cycle/],
    [plan([group("g", "sequence", [task("alpha", ["beta"]), task("beta")])]), /dependency cycle/],
  ]) {
    assert.throws(() => w.compile(input), error => /^plan\.json:\d+:\d+:/.test(error.message) && message.test(error.message), String(message));
  }
  w.json("empty.json", { version: 1, children: [] });
  assert.throws(() => w.compile(plan([{ id: "g", type: "group", mode: "parallel", file: "empty.json" }])), /^Error: empty\.json:\d+:\d+: group must contain/);
  w.json("recursive.json", { version: 1, children: [{ id: "g", type: "group", mode: "parallel", file: "recursive.json" }] });
  assert.throws(() => w.compile(plan([{ id: "g", type: "group", mode: "parallel", file: "recursive.json" }])), /^Error: recursive\.json:\d+:\d+: recursive include/);
});

test("strict JSON and restricted YAML reject unsafe features with line and column", t => {
  const w = workspace(t);
  const cases = [
    ["bad.json", '{"version":1,"ver\\u0073ion":1}', /duplicate mapping key/],
    ["bad.json", '{"version":1,}', /invalid JSON syntax/],
    ["bad.json", '{"version":1,"__prot\\u006f__":{}}', /forbidden mapping key/],
    ["bad.json", '{"version":1,"prototype":{}}', /forbidden mapping key/],
    ["bad.json", '{"version":1,"constructor":{}}', /forbidden mapping key/],
    ["bad.json", '{"version":1,"name":"\\u0024(PWD)"}', /interpolation/],
    ["bad.json", '{"version":1,"name":"${HOME}"}', /interpolation/],
    ["bad.yaml", 'version: 1\n"version": 1\n', /duplicate mapping key/],
    ["bad.yaml", "version: 1\n__proto__: {}\n", /forbidden mapping key/],
    ["bad.yaml", 'version: 1\n"<<": {}\n', /forbidden mapping key/],
    ["bad.yaml", "version: 1\nmerge: *ref\n", /YAML alias/],
    ["bad.yaml", "version: 1\nrecord: &ref foo\n", /YAML anchor/],
    ["bad.yaml", "version: 1\nname: !!str example\n", /YAML tag/],
    ["bad.yaml", "version: 1\nname: !custom example\n", /YAML tag/],
    ["bad.yaml", "%YAML 1.1\n---\nversion: 1\n", /YAML directive/],
    ["bad.yaml", "version: 1\n---\nversion: 1\n", /single document/],
    ["bad.yaml", "version: 1\n? [key]\n: value\n", /explicit-key/],
    ["bad.yaml", "version: 1\nname: '$HOME'\n", /interpolation/],
    ["bad.yaml", 'version: 1\nname: "\\u0024HOME"\n', /interpolation/],
    ["bad.yaml", "version: 1\nname: '`whoami`'\n", /interpolation/],
    ["bad.yaml", "version: 1\nnode: [unclosed\n", /invalid plan syntax/],
  ];
  for (const [path, text, message] of cases) {
    w.put(path, text);
    assert.throws(() => w.run(path), error => error.message.startsWith(`${path}:`) && /:\d+:\d+: /.test(error.message) && message.test(error.message), text);
  }
  w.put("bad.yaml", Buffer.from([0xff]));
  assert.throws(() => w.run("bad.yaml"), /cannot read "bad.yaml"/);
});

test("file reads are restricted to approved local regular files and checkout-relative briefs", t => {
  const w = workspace(t), other = workspace(t);
  const outside = other.put("outside.yaml", "version: 1\nchildren: []\n");
  const included = file => plan([{ id: "g", type: "group", mode: "parallel", file }]);
  for (const path of ["https://example.test/a.yml", "//example.test/a.yml", "C:\\plans\\a.yml", "../outside.yaml", ".git/config"]) {
    assert.throws(() => w.compile(included(path)), /plan\.json:\d+:\d+: expected a contained local path/, path);
  }
  assert.throws(() => w.run(outside), /plan file: expected a contained local path/);
  mkdirSync(join(w.directory, "directory.yaml"));
  symlinkSync(outside, join(w.directory, "linked.yaml"));
  symlinkSync(other.directory, join(w.directory, "link-directory"));
  const original = w.put("original.yaml", "version: 1\nchildren: []\n");
  linkSync(original, join(w.directory, "hard.yaml"));
  execFileSync("mkfifo", [join(w.directory, "fifo.yaml")], { timeout: 5_000 });
  for (const [path, failure] of [
    ["directory.yaml", /not a regular/], ["linked.yaml", /contains a symlink/],
    ["link-directory/outside.yaml", /without symlinks/], ["hard.yaml", /hard links/],
    ["fifo.yaml", /not a regular/], ["absent.yaml", /ENOENT/],
  ]) {
    assert.throws(() => w.compile(included(path)), error => error.message.includes(path) && failure.test(error.message), path);
  }

  const input = plan([task("verify")]);
  input.repositories.demo.checkout = "./repos/demo";
  input.nodes[0].prd = "./docs/prds/verify.md";
  w.put("manifest/plan.json", JSON.stringify(input));
  w.put("repos/demo/docs/prds/verify.md", brief.replace("status: ready", "status: draft"));
  assert.throws(() => w.run("manifest/plan.json"), /checkout requires explicit operator approval/);
  const options = { checkouts: ["repos/demo"] };
  assert.throws(() => w.run("manifest/plan.json", options), /repos\/demo\/docs\/prds\/verify\.md: PRD must declare status: ready/);
  w.put("repos/demo/docs/prds/verify.md", brief);
  const result = w.run("manifest/plan.json", options);
  assert.equal(result.graph.nodes[0].prd, prd("verify"));
  assert.ok(result.sources.some(source => source.path === "repos/demo/docs/prds/verify.md"));
  w.put("repos/demo/docs/prds/verify.md", brief.replace("status: ready", "status: ready\nsources: [https://example.test/context]"));
  assert.throws(() => w.run("manifest/plan.json", options), /expected a contained local path/);
});

test("source closure cannot count alternate spellings of the same file as different files", t => {
  const w = workspace(t);
  w.put("context/Mixed.txt", "first source");
  w.put(prd("verify"), brief.replace("status: ready", "status: ready\nsources: [context/Mixed.txt, context/mixed.txt]"));
  w.json("plan.json", plan([task("verify")]));
  if (existsSync(join(w.directory, "context/mixed.txt"))) {
    assert.throws(() => w.run(), /context\/mixed.txt.*file aliases another source path/);
  } else {
    w.put("context/mixed.txt", "different source");
    assert.equal(w.run().sources.length, 4);
  }
});

test("a file swapped before open is rejected and no replacement bytes are read", t => {
  const w = workspace(t);
  const path = w.json("plan.json", plan([task("alpha")]));
  const replacement = w.json("replacement.json", plan([task("beta")]));
  const realOpen = fs.openSync, realRead = fs.readSync;
  let reads = 0, swapped = false;
  const opening = t.mock.method(fs, "openSync", (named, ...args) => {
    if (!swapped && named === fs.realpathSync.native(path)) {
      swapped = true;
      renameSync(path, `${path}.old`);
      renameSync(replacement, path);
    }
    return realOpen(named, ...args);
  });
  const reading = t.mock.method(fs, "readSync", (...args) => {
    reads++;
    return realRead(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => w.run(), /file changed before it could be read/);
    assert.equal(reads, 0);
    assert.equal(swapped, true);
  } finally {
    opening.mock.restore();
    reading.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a transient parent rename invalidates an otherwise unchanged file", t => {
  const w = workspace(t);
  w.briefs("verify");
  const file = w.json("nested/plan.json", plan([task("verify")]));
  const parent = dirname(file);
  const realOpen = fs.openSync;
  let renamed = false;
  const opening = t.mock.method(fs, "openSync", (named, ...args) => {
    if (!renamed && named === fs.realpathSync.native(file)) {
      renamed = true;
      renameSync(parent, `${parent}.old`);
      renameSync(`${parent}.old`, parent);
    }
    return realOpen(named, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => w.run("nested/plan.json"), /file identity or containment changed/);
    assert.equal(renamed, true);
  } finally {
    opening.mock.restore();
    syncBuiltinESMExports();
  }
});

test("source, total byte and file ceilings accept exact limits and reject excess", t => {
  const w = workspace(t);
  const input = plan([task("verify")]);
  const manifestText = JSON.stringify(input, null, 2);
  w.briefs("verify");
  w.put("plan.json", manifestText.padEnd(PLAN_LIMITS.sourceBytes, " "));
  assert.ok(w.run().graphDigest);
  appendFileSync(join(w.directory, "plan.json"), " ");
  assert.throws(() => w.run(), /1 MiB per-source/);

  w.put("plan.json", manifestText);
  const paths = Array.from({ length: 8 }, (_, i) => `payload-${i}.txt`);
  const withSources = paths => brief.replace("status: ready", `status: ready\nsources: [${paths.join(", ")}]`);
  const prdText = withSources(paths);
  w.put(prd("verify"), prdText);
  for (const path of paths.slice(0, -1)) w.put(path, Buffer.alloc(PLAN_LIMITS.sourceBytes, "x"));
  const last = w.put(paths.at(-1), Buffer.alloc(PLAN_LIMITS.sourceBytes - Buffer.byteLength(prdText + manifestText), "x"));
  assert.equal(w.run().sources.length, 10);
  appendFileSync(last, "x");
  assert.throws(() => w.run(), /8 MiB total input/);

  const small = Array.from({ length: PLAN_LIMITS.files - 1 }, (_, i) => `small-${i}.txt`);
  for (const path of small) w.put(path, "valid source");
  w.put(prd("verify"), withSources(small.slice(1)));
  assert.equal(w.run().sources.length, 32);
  w.put(prd("verify"), withSources(small));
  assert.throws(() => w.run(), /32-file source closure/);
});

test("include chains obey the source closure and include depth limits", t => {
  const w = workspace(t);
  w.briefs("verify");
  const include = i => ({ id: "level", type: "group", mode: "parallel", file: `fragment-${i}.json` });
  for (let i = 1; i < PLAN_LIMITS.depth - 2; i++) {
    w.json(`fragment-${i}.json`, { version: 1, children: [include(i + 1)] });
  }
  w.json("fragment-30.json", { version: 1, children: [task("verify")] });
  assert.equal(w.compile(plan([include(1)])).sources.length, 32);
  w.json("fragment-30.json", { version: 1, children: [include(31)] });
  w.json("fragment-31.json", { version: 1, children: [task("verify")] });
  assert.throws(() => w.run(), /32-file source closure/);
  w.json("fragment-31.json", { version: 1, children: [include(32)] });
  assert.throws(() => w.run(), /32-source include depth/);
});

test("node, nesting and syntax budgets fail closed", t => {
  const w = workspace(t);
  w.briefs("verify");
  const nested = (depth, node) => Array.from({ length: depth }, (_, i) => i)
    .reduce((child, i) => group(`level-${i}`, "parallel", [child]), node);
  assert.equal(w.compile(plan([nested(PLAN_LIMITS.depth - 1, task("verify"))])).graph.nodes.length, 1);
  assert.throws(() => w.compile(plan([nested(PLAN_LIMITS.depth, task("verify"))])), /depth limit/);

  const leaves = Array.from({ length: PLAN_LIMITS.nodes - 1 }, (_, i) => anchor(`anchor-${i}`));
  assert.equal(w.compile(plan([...leaves, task("verify")])).graph.nodes.length, 1_000);
  assert.throws(() => w.compile(plan([...leaves, anchor("overflow"), task("verify")])), /1,000-node limit/);

  w.put("deep.yaml", "[".repeat(2_000) + "1" + "]".repeat(2_000));
  assert.throws(() => w.run("deep.yaml"), /syntax nesting limit/);
  w.put("many.yaml", "\n".repeat(PLAN_LIMITS.syntaxTokens + 1));
  assert.throws(() => w.run("many.yaml"), /syntax token limit/);
});

test("edge ceilings, repeated boundary work and preview bytes are bounded", t => {
  const w = workspace(t);
  w.briefs("verify");
  const left = group("left", "parallel", Array.from({ length: 100 }, (_, i) => anchor(`left-${i}`)));
  const right = group("right", "parallel", [
    ...Array.from({ length: 99 }, (_, i) => anchor(`right-${i}`)), task("verify"),
  ], ["left"]);
  assert.equal(w.compile(plan([left, right])).graph.edges.length, 10_000);
  left.children.push(anchor("overflow"));
  assert.throws(() => w.compile(plan([left, right])), /10,000-edge limit/);
  left.children.pop();

  let wrapper = left;
  const needs = ["left"];
  for (let i = 0; i < 10; i++) {
    wrapper = group(`wrap-${i}`, "parallel", [wrapper]);
    needs.unshift(wrapper.id);
    for (let j = 1; j < needs.length; j++) needs[j] = `${wrapper.id}/${needs[j]}`;
  }
  assert.equal(w.compile(plan([wrapper, { ...right, needs: needs.slice(1) }])).graph.edges.length, 10_000);
  assert.throws(() => w.compile(plan([wrapper, { ...right, needs }])), /100,000 edge attempts limit/);
  assert.throws(() => w.compile(plan([left, { ...right, needs: Array(10_001).fill("left") }])), /10,000 needs references limit/);

  let big = group("pair", "parallel", [left, { ...right, needs: ["left"] }]);
  for (let i = 0; i < 12; i++) big = group("g".repeat(80), "parallel", [big]);
  assert.throws(() => w.compile(plan([big])), /4 MiB normalized preview limit/);
});

test("linear descriptions preserve chain task IDs, order, base and predecessor compatibility", t => {
  const w = workspace(t);
  w.briefs("second", "first", "predecessor");
  const steps = ["second", "first", "predecessor"].map(id => ({ id: `${repo}/${id}`, relPath: prd(id) }));
  const legacy = { name: "contract-example", repo, base: "release/v1", steps };
  const manifest = w.compile(plan([task("second"), task("first", ["second"]), task("predecessor", ["first"])]));
  assert.deepEqual(compileLinearChain(legacy), manifest.graph);
  const graph = compileLinearChain({ ...legacy, after: { id: `${repo}/existing`, pr: 42, merged: { sha: "saved-runtime-sha" } } });
  assert.deepEqual(graph.nodes[0], { id: "predecessor-1", type: "anchor", target: { taskId: `${repo}/existing`, pr: 42 }, resolution: "unresolved" });
  assert.deepEqual(graph.nodes.slice(1).map(node => [node.taskId, node.base]), steps.map(step => [step.id, legacy.base]));
  assert.deepEqual(pairs(graph), [["first", "predecessor"], ["predecessor-1", "second"], ["second", "first"]]);
  assert.doesNotMatch(JSON.stringify(graph), /saved-runtime-sha/);
});

test("plan validate works without config, host binaries or registered state", t => {
  const w = workspace(t);
  const home = join(w.directory, "state");
  const args = [cli, "plan", "validate", "synthetic.yaml", "--dir", examples, "--json"];
  const env = { PATH: w.directory, GALLIVANT_HOME: home };
  const good = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 15_000 });
  assert.equal(good.status, 0, good.stderr || good.error?.message);
  assert.deepEqual(JSON.parse(good.stdout), compileDependencyPlan("synthetic.yaml", { directory: examples }));
  assert.equal(existsSync(home), false);
  for (const flag of ["LOG_TOKENS", "LOG_STREAM"]) {
    const debug = spawnSync(process.execPath, args, { env: { ...env, [flag]: "1" }, encoding: "utf8", timeout: 15_000 });
    assert.equal(debug.status, 1, debug.stderr);
    assert.equal(debug.stdout, "");
    assert.match(debug.stderr, /unset LOG_TOKENS and LOG_STREAM/);
  }
  const unconfigured = spawnSync(process.execPath, [cli, "plan", "queue", "synthetic.yaml", "--dir", examples], {
    env, encoding: "utf8", timeout: 15_000,
  });
  assert.equal(unconfigured.status, 1, unconfigured.stderr);
  assert.match(unconfigured.stderr, /No config at/);
  assert.equal(existsSync(home), false);
});
