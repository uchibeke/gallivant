// CI selection is conservative: unknown inputs run every regression. No test is deleted.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "acorn";

export const CPU_TEST = "the screen and mapping stay fast at the request and mapping limits";
export const SHARD_SECONDS = 60;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const patternFor = names => `^(?:${names.map(escape).join("|")})(?:$| )`;
const walk = (node, visit) => {
  if (!node || typeof node !== "object") return;
  if (typeof node.type === "string") visit(node);
  for (const [key, value] of Object.entries(node)) if (key !== "loc") {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
};

export function indexFile(source) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const bindings = new Set();
  for (const node of ast.body) if (node.type === "ImportDeclaration" && node.source.value === "node:test") {
    for (const spec of node.specifiers) if (spec.type === "ImportDefaultSpecifier" || spec.imported?.name === "test" || spec.imported?.name === "it") bindings.add(spec.local.name);
  }
  const names = [];
  for (const statement of ast.body) {
    const call = statement.type === "ExpressionStatement" ? statement.expression : null;
    if (call?.type === "CallExpression" && call.callee.type === "Identifier" && bindings.has(call.callee.name) && typeof call.arguments[0]?.value === "string") names.push(call.arguments[0].value);
  }
  const references = new Set();
  walk(ast, node => {
    if (typeof node.value === "string" && /^(?:\.\.?\/|lib\/|bin\/|templates\/|scripts\/|test\/)/.test(node.value)) references.add(node.value);
  });
  return { names: [...new Set(names)], references: [...references] };
}

const docsOnly = paths => paths.length > 0 && paths.every(path => /^(?:(?:README|CONTRIBUTING|SECURITY|LICENSE)(?:\.md)?|docs\/.*\.(?:md|png|svg|jpg|webp))$/.test(path));
const risky = path => /^(?:package\.json|npm-shrinkwrap\.json|\.github\/|bin\/|scripts\/|lib\/(?:verification|runtime|execution|harness|git|credential|identity|daemon|run[_.]|task_environment|task_prepare|provider_health))/.test(path);

export function selection(root, changed, event) {
  const files = readdirSync(resolve(root, "test")).filter(name => name.endsWith(".test.mjs")).sort().map(name => `test/${name}`);
  if (!files.length) throw new Error("No regression test inventory; refusing to construct an empty CI plan");
  const full = event === "schedule" || event === "release";
  if (!full && docsOnly(changed)) return { mode: "docs", files: [], platforms: [], smoke: [{ os: "ubuntu-24.04", node: 22 }], browser: false };
  const graph = new Map();
  const dependencies = file => {
    if (graph.has(file)) return graph.get(file);
    graph.set(file, new Set());
    if (!/\.(?:mjs|js)$/.test(file) || !existsSync(resolve(root, file))) return graph.get(file);
    const indexed = indexFile(readFileSync(resolve(root, file), "utf8"));
    for (const ref of indexed.references) {
      const dep = relative(root, resolve(ref.startsWith(".") ? dirname(resolve(root, file)) : root, ref)).replaceAll("\\", "/");
      if (!dep.startsWith("../") && existsSync(resolve(root, dep)) && /\.(?:mjs|js|json|css|html|md)$/.test(dep)) graph.get(file).add(dep);
    }
    return graph.get(file);
  };
  const reaches = (file, target, visited = new Set()) => {
    if (file === target) return true;
    if (visited.has(file)) return false;
    visited.add(file);
    return [...dependencies(file)].some(dep => reaches(dep, target, visited));
  };
  let selected;
  const unknown = changed.some(path => !docsOnly([path]) && (!existsSync(resolve(root, path)) || !/^(?:lib\/.*\.(?:mjs|js)$|test\/.*\.test\.mjs$|test\/ui\/|templates\/tracker\/)/.test(path)));
  const sensitive = changed.some(risky);
  const presentation = changed.length && changed.filter(path => !docsOnly([path])).every(path => /^(?:templates\/tracker\/|test\/ui\/|test\/tracker[^/]*\.test\.mjs$)/.test(path));
  if (full || event === "push" || sensitive || unknown || !changed.length) selected = files;
  else if (presentation) selected = files.filter(file => /^test\/(?:tracker[^/]*|control|start-services|status)\.test\.mjs$/.test(file));
  else {
    const targets = new Set(changed);
    if (changed.some(path => path.startsWith("templates/tracker/") || path.startsWith("test/ui/"))) targets.add("lib/tracker/assets.mjs");
    selected = files.filter(file => [...targets].some(path => reaches(file, path)));
  }
  if (!selected.length) selected = files; // Missing or computed dependencies cannot create an empty green gate.
  const qualify = full || event === "pull_request" && (sensitive || unknown);
  const platforms = qualify ? [
    { os: "ubuntu-24.04", node: 22 }, { os: "ubuntu-24.04", node: 24 },
    { os: "macos-latest", node: 22 }, { os: "macos-latest", node: 24 },
  ] : [{ os: "ubuntu-24.04", node: 22 }];
  return { mode: full ? "full" : selected.length === files.length ? "regression" : "affected", files: selected, platforms,
    smoke: qualify ? platforms : [{ os: "ubuntu-24.04", node: 22 }, { os: "macos-latest", node: 24 }],
    browser: true };
}

// Literal top-level names are sharded. The residual executes every other test:
// dynamic names, suites, aliases and future registration forms cannot disappear.
export function testUnits(root, files, weights = {}) {
  const units = [];
  for (const file of files) {
    const { names } = indexFile(readFileSync(resolve(root, file), "utf8"));
    const seconds = names.reduce((n, name) => n + (weights[name] || 0.03), 2);
    // Keep ordinary files intact: only measured slow suites need name sharding.
    // Whole-file execution naturally includes dynamic and future registrations.
    if (seconds <= 25 && !names.includes(CPU_TEST)) { units.push({ file, whole: true, seconds }); continue; }
    const clusters = [];
    for (const name of names.sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      const existing = clusters.find(cluster => name.startsWith(cluster.names[0] + " "));
      if (existing) existing.names.push(name);
      else clusters.push({ names: [name] });
    }
    for (const { names: group } of clusters) units.push({ file, names: group, seconds: group.reduce((n, name) => n + (weights[name] || 0.03), 0), isolated: group.includes(CPU_TEST) });
    units.push({ file, residual: true, exclude: names, seconds: 2 });
  }
  return units;
}

export function shardUnits(units, budget = SHARD_SECONDS) {
  const shards = [];
  for (const unit of [...units].sort((a, b) => b.seconds - a.seconds)) {
    if (unit.seconds > 95) throw new Error(`A single test exceeds the CI execution budget: ${unit.file}: ${unit.names?.join(", ")}. Split that test; do not remove coverage or increase the gate silently.`);
    const cost = shard => unit.seconds + (shard.units.some(other => other.file === unit.file && Boolean(other.residual) === Boolean(unit.residual)) ? 0 : 1.5);
    let shard = unit.isolated ? null : shards.find(s => !s.isolated && s.seconds + cost(s) <= budget);
    if (!shard) { shard = { units: [], seconds: 0, isolated: Boolean(unit.isolated) }; shards.push(shard); }
    shard.seconds += cost(shard); shard.units.push(unit);
  }
  return shards;
}

// Pair independent lanes on the two-core CI runners. Setup happens once per
// job, while the CPU measurement remains completely alone.
export function parallelShards(shards) {
  const jobs = [], ordinary = shards.filter(s => !s.isolated);
  for (let index = 0; index < ordinary.length; index += 2) {
    const pair = ordinary.slice(index, index + 2);
    jobs.push({ lanes: pair.map(s => s.units), seconds: Math.max(...pair.map(s => s.seconds)) });
  }
  for (const shard of shards.filter(s => s.isolated)) jobs.push({ lanes: [shard.units], seconds: shard.seconds });
  return jobs;
}

export function changedPaths(root, base) {
  if (!/^[a-f0-9]{40,64}$/.test(base || "")) throw new Error("CI needs an exact base commit; refusing to guess changed paths");
  return execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
}
