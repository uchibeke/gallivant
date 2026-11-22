import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { compileDependencyPlan, PLAN_LIMITS } from "../lib/dependency_plan.mjs";
import { completeDependencyFixtureResults, dependencyFixtureGroups, dependencyQualificationArtifact, dependencyQualificationMatrix,
  loadDependencyQualification, qualifyDependencyPlans, verifyDependencyCase } from "../lib/dependency_plan_qualification.mjs";
import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { profileDigest } from "../lib/recovery_authority.mjs";
import { recoveryDigest as digest } from "../lib/recovery_digest.mjs";
import { qualificationBinding, qualificationFixtureBinding } from "../lib/recovery_qualification.mjs";
import { PLAN_RUNTIME_FORMAT } from "../lib/runtime_state.mjs";
import { factoryAccess } from "../lib/tracker/factory_access.mjs";
import { factoryCatalog, planWindow, NODE_PAGE_SIZE, PREREQUISITE_PAGE_SIZE } from "../lib/tracker/factory_projection.mjs";
import { DIAGRAM_PAGE_SIZE } from "../lib/tracker/plan_neighborhood.mjs";
import { dependencyQualificationCommand } from "../scripts/qualify-dependency-plans.mjs";
import { CONFIG, GOOD_PRD, makeClock, seededState, tempHome } from "./helpers.mjs";
import { diamond, NOW, PLAN, READER, REPO } from "./fixtures/factory-projection.mjs";

const leaves = ["producer", "root", "left", "right", "join"];
const allowance = { mutations: 0, paidTurns: 500, spendMicros: 500 };

function protectedFixture(change = () => {}) {
  const { state, id, home } = seededState({ state: "needs-human", reason: "no-pr" });
  const clock = makeClock(), at = clock.now(), artifact = { source: digest("source"), runtime: PLAN_RUNTIME_FORMAT };
  const root = realpathSync(tempHome());
  const roles = ["native", "supervisor", "verification", "coordinator", "execution", "host", "maintainer", "reviewer", "delivery", "fixtures", "aggregate"];
  const keys = Object.fromEntries(roles.map(role => [role, generateKeyPairSync("ed25519")]));
  const signers = Object.fromEntries(roles.map(role => [role, keys[role].publicKey.export({ format: "der", type: "spki" }).toString("base64url")]));
  const matrix = dependencyQualificationMatrix(), route = harness => ({ harness, provider: "fixture", model: "fixture", account: "fixture",
    environment: "fixture", dataLocation: "fixture", credentialRef: "credential:fixture",
    capabilities: ["verify-disposable-isolation", "browser-capture"], maxSpendMicros: 50 });
  const routes = [...new Set(matrix.live.filter(row => row.required).map(row => row.harness))].map(route);
  const selected = harness => digest(routes.find(item => item.harness === harness));
  const environment = platform => ({ platform, arch: process.arch, node: process.version, digest: digest([platform, "exact installed runtime"]) });
  const base = (id, mode, platform, harness) => ({ id, mode, operation: digest(id), route: selected(harness), environment: environment(platform),
    launch: digest([id, "launch"]), startsAt: at - 10_000, deadlineMs: 20_000, maxSpendMicros: 0, maxTurns: 0 });
  const manifest = { version: 1, purpose: "disposable-synthetic-dependency-plans", artifact, signers,
    limits: { startsAt: at - 10_000, expiresAt: at + 10_000, evidenceExpiresAt: at + 60_000, maxSpendMicros: 500, maxTurns: 500 },
    cases: [...matrix.native.map(row => base(row.id, "native", row.platform, "codex")),
      ...matrix.live.filter(row => row.required).map(row => ({ ...base(row.id, "live", row.platform, row.harness),
        surface: row.surface, maxSpendMicros: 5, maxTurns: 10,
        repository: { identity: `${row.host}/fixture/${row.surface}`, id: digest(row.surface), credentialRef: "credential:fixture" },
        graph: { digest: digest([row.id, "graph"]), approval: digest([row.id, "approval"]),
          producer: { chain: "future-chain", node: "tail", contract: digest("frozen tail") },
          nodes: { root: "root", left: "work/left", right: "work/right", join: "join" } },
        refs: { base: `fixture-bases/${row.id}`, prefix: "qualification", leaves: Object.fromEntries(leaves.map(leaf => [leaf, {
          task: digest([row.id, leaf, "task"]), operation: digest([row.id, leaf, "operation"]), head: `qualification/${row.id}/${leaf}`,
          headSha: digest([row.id, leaf, "head"]).slice(0, 40), baseSha: digest([row.id, leaf, "base"]).slice(0, 40), patch: digest([row.id, leaf, "patch"]),
        }])) },
        review: { policy: digest("both required"), externalActor: digest("external reviewer"), localRoute: selected("codex"), capture: true },
        maintainer: digest("maintainer"),
      }))] };
  change(manifest);
  const write = (file, value) => writeFileSync(join(root, file), JSON.stringify(value));
  mkdirSync(join(root, "manifests"));
  write("manifests/plans.json", manifest);
  const qualification = { reference: "manifest:plans", digest: digest(manifest), evidenceRoot: root,
    actions: ["verify-disposable-isolation", "qualify-native", "qualify-live", "check-evidence"] };
  const profile = { version: 1, id: "dependency-fixture", storeId: "coordinator", revision: 1, mode: "recover",
    routes, recipes: [{ id: "qualification", version: 1, limits: allowance }], taskLimits: allowance,
    cleanup: [], revocationGeneration: 0, holdGeneration: 0, qualification };
  profile.digest = profileDigest(profile);
  state.putRecoveryProfile(profile, null, recoveryAdminIntent(state.file, "profile", profile.digest, null));
  const run = { id: "isolation-owner", running: false, execution: { version: 1, taskId: id, runId: "isolation-owner",
    provider: "codex", operationId: "original-settled", acceptance: "accepted", collected: true, providerState: "succeeded",
    recoveryRouteDigest: selected("codex") } };
  state.update(id, { harness: "codex", recovery_profile: { version: 1, digest: profile.digest }, last: { run: run.id, exit: 0 } });
  const ctx = { state, home, clock, config: CONFIG, readPrd: () => GOOD_PRD, executionFor: () => ({ current: () => run }) };
  const runtime = { node: process.version, arch: process.arch, platform: process.platform };
  const scope = () => loadDependencyQualification(ctx, id, "check-evidence", artifact);
  const proof = (owner, record) => ({ record, signature: sign(null, Buffer.from(digest(record), "hex"), keys[owner].privateKey).toString("base64url") });
  const checked = mode => qualifyDependencyPlans(ctx, id, mode, artifact, runtime);
  const certificate = () => {
    const result = { version: 1, binding: qualificationFixtureBinding(scope()), aggregate: digest("fixture output"), result: "passed",
      results: dependencyFixtureGroups.map(({ id, suites, selected }) => ({ id, suites, selected, exit: 0, timeout: false, result: "passed", passed: suites.length, missing: [] })) };
    write("fixtures.json", proof("fixtures", result));
    return digest(result);
  };
  return { ctx, id, artifact, at, root, manifest, scope, write, proof, checked, certificate };
}

function receipts(f, test) {
  const observedAt = f.at, binding = qualificationBinding(f.scope(), test), launchAt = test.startsAt;
  const signed = (step, owner, facts, at = observedAt) => f.proof(owner,
    { version: 1, binding, step, observedAt: at, result: "passed", observation: digest([test.id, step, "independent owner"]), facts });
  const live = test.mode === "live", proofs = ["runtime", "isolation"];
  if (live) proofs.push("host", "plugin", "authorModel", "reviewModel", "reviewHost", "allowance", "capture");
  const launch = signed("launch", "supervisor", { launch: test.launch, environment: test.environment.digest, route: test.route,
    reviewRoute: test.review?.localRoute ?? null, operation: test.operation, proofs: Object.fromEntries(proofs.map(key => [key, digest(key)])) }, launchAt);
  const bundle = live ? {} : {
    process: ["native", { exactIdentity: true, liveLockPreserved: true, deadOwnerRecovered: true }],
    cancellation: ["native", { exactRun: true, ceased: true, foreignUntouched: true }],
    journal: ["native", { durable: true, preservedPrefix: true, replays: 1 }], cleanup: ["native", { ownedOnly: true, preservedUniqueWork: true }],
    supervisor: ["supervisor", { independentlyConfigured: true, pinned: true, deadOnly: true, throttled: true }],
    isolation: ["verification", { protectedState: true, credentialBoundary: true }],
  };
  if (live) {
    const starts = [10, 20, 30, 30, 40], each = callback => Object.fromEntries(leaves.map((leaf, index) => [leaf, callback(test.refs.leaves[leaf], index, launchAt + starts[index])]));
    const executed = each((ref, i, startedAt) => ({ task: ref.task, operation: ref.operation, run: digest([test.id, i, "run"]), starts: 1, startedAt, ceasedAt: startedAt + 2 }));
    const published = each((ref, i, at) => ({ pr: i + 1, count: 1, head: ref.head, headSha: ref.headSha, base: test.refs.base, baseSha: ref.baseSha,
      patch: ref.patch, merge: digest([test.id, i, "merge"]).slice(0, 40), baseContainsMerge: true,
      publishedAt: at + 1, mergedAt: at + 5, mergeActor: test.maintainer, externalActor: test.review.externalActor, externalReviewAt: at + 2 }));
    const { root, left, right, join } = test.graph.nodes;
    Object.assign(bundle, {
      execution: ["execution", { route: test.route, leaves: executed, spendMicros: 2, turns: 5 }],
      host: ["host", { surface: test.surface, repository: test.repository.id, leaves: published }],
      maintainer: ["maintainer", { actor: test.maintainer, leaves: each((ref, i, at) => ({ repository: test.repository.id,
        pr: i + 1, head: ref.head, headSha: ref.headSha, base: test.refs.base, baseSha: ref.baseSha,
        patch: ref.patch, authority: "external-maintainer", authorizedAt: at + 3 })) }],
      review: ["reviewer", { route: test.review.localRoute, policy: test.review.policy, capture: true, turns: 5, spendMicros: 2,
        heads: each((ref, _i, at) => ({ head: ref.headSha, clearedAt: at + 2 })) }],
      closeout: ["delivery", Object.fromEntries(leaves.map(leaf => [leaf, { pr: published[leaf].pr, merge: published[leaf].merge, run: executed[leaf].run,
        delivered: true, cleanup: "retained", settledAt: executed[leaf].startedAt + 6 }]))],
      graph: ["coordinator", { instance: digest([test.id, "instance"]), graph: test.graph.digest, approval: test.graph.approval,
        attachment: { frozen: [test.graph.producer], observedAt: launchAt + 2, pr: null },
        fanOut: { from: root, children: [left, right], eligibleAt: launchAt + 26 },
        join: { node: join, needs: [left, right], merges: [published.left.merge, published.right.merge], claims: 1, startedAt: launchAt + 40 } }],
    });
  }
  return { launch, ...Object.fromEntries(Object.entries(bundle).map(([step, [owner, facts]]) => [step, signed(step, owner, facts)])) };
}

test("classification is derived from shipped code and all execution modes require protected scope", async () => {
  const artifact = dependencyQualificationArtifact(), matrix = dependencyQualificationMatrix();
  assert.match(artifact.source, /^[0-9a-f]{40,64}$/);
  assert.deepEqual(artifact.planRuntime, PLAN_RUNTIME_FORMAT);
  assert.equal(artifact.planContract.graph, 1);
  assert.equal(artifact.planContract.approval, 1);
  assert.deepEqual(matrix.native.map(row => row.platform), ["linux", "darwin"]);
  assert.ok(matrix.live.some(row => row.harness === "openai-agents" && row.required && row.authorCapabilities.transport === "remote"));
  assert.ok(matrix.live.filter(row => row.harness === "codex-cloud").every(row => row.status === "gated" && !row.required));
  assert.ok(matrix.live.filter(row => row.required).every(row => row.status === "unvalidated"));
  assert.equal(matrix.defaultCapacity.graph_authors, 0);
  for (const args of [[], ["--native", "--live"], ["--live=fixture"], ["--overnight"], ["--check-evidence", "manifest:plans"]])
    await assert.rejects(dependencyQualificationCommand(args), /Choose exactly one/);
  for (const flag of ["--native", "--live", "--check-evidence"]) {
    await assert.rejects(dependencyQualificationCommand([flag], { task: "" }), /GALLIVANT_QUALIFICATION_TASK/);
    await assert.rejects(dependencyQualificationCommand([flag], { task: "forged", ctx: { state: { load: () => ({ entries: {} }) } } }), /operator must pin/);
  }
});

test("the pinned manifest requires all cases, the exact native runtime and unchanged disposable identities", () => {
  const f = protectedFixture();
  assert.equal(f.scope().manifest.cases.length, 2 + dependencyQualificationMatrix().live.filter(row => row.required).length);
  assert.throws(() => loadDependencyQualification(f.ctx, f.id, "overnight", f.artifact), /admitted dependency qualification mode/);
  assert.throws(() => loadDependencyQualification(f.ctx, f.id, "live", { ...f.artifact, source: digest("different source") }), /exact source/);
  assert.throws(protectedFixture(manifest => { manifest.cases.pop(); }).scope, /complete dependency case matrix/);
  assert.throws(protectedFixture(manifest => { manifest.cases.at(-1).environment.digest = digest("other installation"); }).scope, /exact live runtime/);
  assert.throws(protectedFixture(manifest => { manifest.cases[2].refs.leaves.left.operation = manifest.cases[2].refs.leaves.right.operation; }).scope, /own disposable ref and operation/);
  assert.throws(protectedFixture(manifest => { manifest.cases[2].refs.leaves.left.head = "production/branch"; }).scope, /exact disposable heads/);
  f.write("manifests/plans.json", { ...f.manifest, purpose: "disposable-synthetic-recovery" });
  assert.throws(f.scope, /protected digest/);
});

test("checking signed cases is read-only and requires the fixture and every native and live observation", async () => {
  const f = protectedFixture(), scope = f.scope(), fixture = f.certificate();
  const before = readFileSync(f.ctx.state.file);
  f.ctx.disposableQualificationOwner = { baselineFor: () => assert.fail("read-only check invoked a run owner") };
  await assert.rejects(f.checked("check-evidence"), /Missing protected evidence/);
  assert.equal(existsSync(join(f.root, "cases")), false);
  mkdirSync(join(f.root, "cases"));
  const cases = {};
  for (const scenario of f.manifest.cases) {
    const receipt = receipts(f, scenario);
    f.write(`cases/${scenario.id}.json`, receipt);
    cases[scenario.id] = digest(receipt);
  }
  const aggregate = { version: 1, binding: qualificationFixtureBinding(scope), fixture, cases, result: "passed" };
  f.write("aggregate.json", aggregate);
  await assert.rejects(f.checked("check-evidence"), /invalid independent aggregate signature/);
  f.write("aggregate.json", f.proof("aggregate", aggregate));
  const report = await f.checked("check-evidence");
  assert.equal(report.evidence, digest(aggregate));
  assert.ok(report.matrix.native.every(row => row.status === "native"));
  assert.ok(report.matrix.live.filter(row => row.required).every(row => row.status === "live" && row.route && row.operation && row.receipt));
  const missing = f.manifest.cases.at(-1), file = join(f.root, `cases/${missing.id}.json`);
  unlinkSync(file);
  await assert.rejects(f.checked("check-evidence"), /Missing protected evidence/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(readFileSync(f.ctx.state.file), before);
});

test("live receipt verification binds future attachment, both joins, actual host authority, route and settlement", () => {
  const f = protectedFixture(), scope = f.scope(), scenario = f.manifest.cases[2];
  const valid = receipts(f, scenario);
  assert.equal(verifyDependencyCase(scope, scenario, valid).digest, digest(valid));
  for (const [step, owner, edit, message] of [
    ["graph", "coordinator", facts => { facts.attachment.pr = 1; }, /before its final PR/],
    ["graph", "coordinator", facts => { facts.join.merges.pop(); }, /one join/],
    ["execution", "execution", facts => { facts.leaves.left.starts = 2; }, /execution owner/i],
    ["closeout", "delivery", facts => { facts.right.cleanup = "unknown"; }, /did not settle/],
    ["host", "host", facts => { facts.leaves.left.mergeActor = digest("foreign actor"); }, /Host PR/],
    ["review", "reviewer", facts => { facts.heads.left.head = "a".repeat(40); }, /current-head review/],
    ["review", "reviewer", facts => { facts.spendMicros = 4; }, /shared case allowance/],
    ["maintainer", "execution", () => {}, /independent maintainer signature/],
    ["launch", "supervisor", facts => { delete facts.proofs.plugin; }, /installed launch/],
    ["launch", "supervisor", facts => { facts.route = digest("foreign route"); }, /installed launch/],
  ]) {
    const copy = structuredClone(valid), { record } = copy[step];
    edit(record.facts);
    copy[step] = f.proof(owner, record);
    assert.throws(() => verifyDependencyCase(scope, scenario, copy), message);
  }
  const stale = structuredClone(valid);
  stale.graph = f.proof("coordinator", { ...stale.graph.record, observedAt: scenario.startsAt - 1 });
  assert.throws(() => verifyDependencyCase(scope, scenario, stale), /stale/);
  assert.throws(() => verifyDependencyCase(scope, f.manifest.cases[3], valid), /cross-case/);
  f.ctx.clock.advance(2);
  assert.throws(f.scope, /window is inactive/);
});

test("phase preflight checks every missing platform before any operation or evidence write", async () => {
  const f = protectedFixture(); f.certificate();
  const checks = [];
  f.ctx.disposableQualificationOwner = {
    baselineFor: async request => {
      checks.push(request.case.id);
      if (request.case.environment.platform === "darwin") return null;
      return { binding: request.binding, environment: request.case.environment.digest, disposableOnly: true, owned: true, isolated: true,
        launchDigest: request.case.launch, launchReceipt: receipts(f, request.case).launch, expiresAt: f.at + 5000 };
    },
    reconcileCase: async () => assert.fail("an incomplete phase crossed an effect boundary"),
  };
  await assert.rejects(f.checked("live"), /Missing protected evidence/);
  assert.deepEqual(checks, []);
  await assert.rejects(f.checked("native"), /independent baseline proof/);
  assert.deepEqual(checks, ["native-linux", "native-darwin"]);
  assert.equal(existsSync(join(f.root, "cases")), false);
});

test("fixture aggregate cannot omit either browser suite, skip tests or substitute failed checks", () => {
  const f = protectedFixture(); f.certificate();
  const { record } = JSON.parse(readFileSync(join(f.root, "fixtures.json"), "utf8"));
  assert.equal(completeDependencyFixtureResults(record.results), true);
  record.results.find(group => group.id === "served-browser").suites.pop();
  assert.equal(completeDependencyFixtureResults(record.results), false);
  record.results[1].exit = 1;
  assert.equal(completeDependencyFixtureResults(record.results), false);
});

test("a thousand-node compile and read projection bound response size and diagram work", t => {
  const directory = realpathSync(tempHome()), brief = "docs/prds/release.md";
  mkdirSync(join(directory, "docs/prds"), { recursive: true });
  writeFileSync(join(directory, brief), GOOD_PRD);
  const nodes = Array.from({ length: PLAN_LIMITS.nodes - 1 }, (_, i) => ({ id: `anchor-${i}`, type: "anchor", target: { plan: "upstream", boundary: "terminal" } }));
  nodes.push({ id: "release", type: "task", repository: "project", prd: brief, needs: nodes.map(node => node.id) });
  const file = "thousand.json";
  writeFileSync(join(directory, file), JSON.stringify({ version: 1, name: "thousand", repositories: { project: { repository: REPO, checkout: ".", base: "main" } }, nodes }));
  const start = performance.now(), compiled = compileDependencyPlan(file, { directory }), compileMs = Math.round(performance.now() - start);
  assert.equal(compiled.graph.nodes.length, 1000);
  assert.equal(compiled.graph.edges.length, 999);
  const compileBytes = Buffer.byteLength(JSON.stringify(compiled));
  assert.ok(compileBytes < PLAN_LIMITS.previewBytes);
  const { saved, plan } = diamond();
  plan.approval.graph = compiled.graph;
  plan.approval.nodeContracts = compiled.graph.nodes.map(node => [node.id, digest(node.id)]);
  const snapshot = structuredClone(saved), project = performance.now();
  const window = planWindow(factoryCatalog(factoryAccess(saved, { operator: READER, protectedReads: true }), { now: NOW }),
    { plan: PLAN, node: "release", diagram: "1" });
  const projectionMs = Math.round(performance.now() - project), projectionBytes = Buffer.byteLength(JSON.stringify(window));
  assert.equal(window.detail.nodes.length, NODE_PAGE_SIZE);
  assert.equal(window.detail.selected.dependencies.length, PREREQUISITE_PAGE_SIZE);
  assert.equal(window.detail.diagram.nodes.length, DIAGRAM_PAGE_SIZE + 1);
  assert.ok(projectionBytes < 64 * 1024);
  assert.deepEqual(saved, snapshot);
  t.diagnostic(`dependency-qualification-load ${JSON.stringify({ nodes: nodes.length, edges: compiled.graph.edges.length,
    compileBytes, compileMs, projectionBytes, projectionMs, stateWrites: 0 })}`);
});
