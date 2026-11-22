import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { executionCapabilities } from "../lib/capabilities.mjs";
import { providerScope } from "../lib/recovery_cooldown.mjs";
import { factoryAccess } from "../lib/tracker/factory_access.mjs";
import { factoryCatalog, planWindow, NODE_PAGE_SIZE, PLAN_PAGE_SIZE, PREREQUISITE_PAGE_SIZE } from "../lib/tracker/factory_projection.mjs";
import { planPrerequisites } from "../lib/dependency_plan_runtime.mjs";
import { overviewWindow } from "../lib/tracker/overview.mjs";
import { diamond, crossCompany, integration, PLAN, READER, REPO, NOW } from "./fixtures/factory-projection.mjs";

const catalog = (saved, operator = READER) => factoryCatalog(factoryAccess(saved, { operator, protectedReads: true }), { now: NOW });
const view = (saved, options = {}, operator) => planWindow(catalog(saved, operator), { plan: PLAN, ...options });

test("factory DTO counts leaves only and preserves the exact parallel join", () => {
  const { saved, plan } = diamond();
  const before = structuredClone(saved);
  const { detail, version } = view(saved, { node: "release" });
  assert.equal(version, 1);
  assert.deepEqual(detail.counts, { integrated: 1, ready: 1, "closed-unmerged": 1, cancelled: 1, planned: 1, active: 2, blocked: 0, unknown: 1 });
  assert.equal(detail.total, 8);
  assert.deepEqual(detail.active, ["branches/api", "branches/ui"]);
  assert.equal(detail.selected.registered, false);
  assert.deepEqual(detail.selected.dependencies.map(d => [d.id, d.status]), [["branches/api", "active"], ["branches/ui", "active"]]);
  assert.equal(planPrerequisites(plan, "release"), null);
  assert.equal(detail.selected.budget.costUsd, null);
  assert.equal(detail.selected.capability.dispatch, "unknown");
  assert.deepEqual(saved, before, "projection does not produce a receipt or start a task");

  plan.runtime.nodes["branches/api"].status = "blocked";
  plan.runtime.nodes["branches/api"].firstFailure = "Storage unavailable at /private/worktree";
  plan.runtime.nodes["branches/api"].firstFailureAt = NOW - 180_000;
  plan.runtime.nodes["branches/api"].reason = "Waiting for storage";
  plan.runtime.nodes["branches/api"].nextAt = NOW + 3_600_000;
  const blocked = view(saved, { node: "release" }).detail.selected;
  assert.deepEqual(blocked.dependencies.map(d => d.status), ["blocked", "active"]);
  const api = view(saved, { node: "branches/api" }).detail.selected;
  assert.deepEqual(api.recovery.original, { detail: "Storage unavailable at [protected path]",
    at: "2026-11-22T11:57:00.000Z", source: "plan.runtime.firstFailure" });
  assert.equal(api.recovery.nextAt, "2026-11-22T13:00:00.000Z");
  assert.equal(api.times.recovery.ageMs, 180_000);
  assert.equal(api.budget.rounds.limit, 6);

  for (const id of ["branches/api", "branches/ui"]) {
    const runtime = plan.runtime.nodes[id];
    Object.assign(runtime, { status: "integrated", receipt: integration(id, runtime.token) });
  }
  assert.equal(planPrerequisites(plan, "release").length, 2);
  const released = view(saved, { node: "release" }).detail.selected;
  assert.equal(released.dispatch, "prerequisites-recorded");
  assert.equal(released.registered, false);
  assert.equal(released.status, "planned");
  assert.ok(released.dependencies.every(d => d.status === "integrated" && d.receipt.cleanup === "retained"));
});

test("frozen anchor scope and receipt ownership are enforced without exposing other-company metadata", () => {
  const { saved, plan } = diamond();
  const { other, pin, allowed } = crossCompany(saved, plan);
  const graph = view(saved, { node: "release" });
  assert.equal(graph.detail.selected.dependencies.find(d => d.id === "upstream").status, "unavailable");
  assert.deepEqual(view(saved, { node: "upstream" }).detail.selected,
    { type: "anchor", id: "upstream", status: "unavailable", dependencies: [], dependencyOffset: 0, dependencyCount: 0 });
  const unavailable = view(saved, { plan: other.id });
  assert.deepEqual(unavailable, view(saved, { plan: "nothing-here" }));
  assert.equal(unavailable.total, 1);
  assert.doesNotMatch(JSON.stringify(graph), /secret-future|private-producer|unreleased-repo|confidential-producer/);
  const linked = view(saved, { node: "upstream" }, allowed).detail.selected;
  assert.equal(linked.producer.linkable, false);
  assert.equal(linked.dependencyCount, 2);
  assert.deepEqual(linked.dependencies.map(d => d.status), ["waiting", "waiting"]);
  const received = plan.runtime.anchors[0][1][0];
  received.status = "integrated";
  received.start = { token: "anchor-start" };
  received.receipt = integration(pin.nodes[0].id, "different-owner", other.id);
  assert.equal(view(saved, { node: "upstream" }, allowed).detail.selected.dependencies[0].status, "unverified");

  // The registry rejects an empty frozen set. The shared predicate must also
  // fail closed when presented with an incomplete record.
  for (const id of ["branches/api", "branches/ui"]) {
    const runtime = plan.runtime.nodes[id];
    Object.assign(runtime, { status: "integrated", receipt: integration(id, runtime.token) });
  }
  pin.nodes = [];
  plan.runtime.anchors[0][1] = [];
  assert.equal(planPrerequisites(plan, "release"), null);
  assert.equal(view(saved, { node: "release" }, allowed).detail.selected.status, "blocked");
});

test("saved productive activity is sorted independently of retry time and outcome filters", () => {
  const { saved, plan } = diamond();
  const project = query => overviewWindow({ factory: catalog(saved) }, query);
  const before = project({ sort: "recent" }).rows.map(row => row.id);
  saved.entries[`${REPO}/unknown`].updated_at = new Date(NOW).toISOString();
  plan.runtime.nodes["branches/api"].nextAt = NOW + 3_600_000;
  assert.deepEqual(project({ sort: "recent" }).rows.map(row => row.id), before);
  assert.equal(project({ status: "unknown" }).rows[0].id, `${REPO}/unknown`);
  assert.equal(project({ status: "closed-unmerged" }).rows[0].id, `${REPO}/closed`);
  assert.deepEqual(project({ status: "planned" }).rows.map(row => row.id), [`${REPO}/release`]);
  assert.equal(view(saved, { node: "ready" }).detail.selected.times.freshness, "stale");
  assert.equal(view(saved, { node: "absent" }).detail.selected, null);
  assert.equal(view(saved, { node: "absent" }).detail.missingNode, true);
  assert.equal(view(saved, { ps: "ready", pq: "no match" }).detail.outsideFilters, true);
});

test("saved cooldown and intake budgets keep evidence, bounds and unknown cost distinct", () => {
  const { saved, plan } = diamond();
  plan.approval.bindings.tasks.push(["release", { route: { harness: "codex-cloud", routeAvailable: false, account: "private-account" } }]);
  const cooldowns = new Map([[providerScope("codex-cloud", "private-account"), { nextAt: NOW + 3600_000 }]]);
  const intakes = [{ id: "task-saved-intake", repo: REPO, status: "ready", revision: 3, attempts: [{ startedAt: NOW - 600, cost: null }],
    allowance: { budgetUsd: 4 } }];
  const data = factoryCatalog(factoryAccess(saved, { operator: READER, protectedReads: true }), { now: NOW, cooldowns, intakes });
  const { detail } = planWindow(data, { plan: PLAN, node: "release" });
  assert.equal(detail.selected.capability.dispatch, "unsupported");
  assert.equal(detail.selected.recovery.cooldownAt, "2026-11-22T13:00:00.000Z");
  assert.equal(detail.selected.recovery.retryAt, detail.selected.recovery.cooldownAt);
  assert.doesNotMatch(JSON.stringify(detail), /private-account/);
  const intake = data.tasks.find(row => row.id === "task-saved-intake");
  assert.equal(intake.phase.id, "intake_ready");
  assert.equal(intake.evidence.inputRevision, 3);
  assert.equal(intake.budget.preparationAllowanceUsd, 4);
  assert.equal(intake.budget.costUsd, null);
});

test("plan, node and prerequisite windows preserve the selected scope across pages", () => {
  const { saved, plan } = diamond();
  const root = plan.approval.graph.nodes.find(n => n.id === "setup");
  for (let i = 0; i < 60; i++) {
    const id = `step-${i}`;
    plan.approval.graph.nodes.push({ ...root, id, taskId: `${REPO}/${id}` });
    plan.approval.nodeContracts.unshift([id, "a".repeat(64)]);
    plan.approval.graph.edges.push({ from: id, to: "release" });
  }
  for (let i = 0; i < 22; i++) {
    const synthetic = structuredClone(plan);
    synthetic.id = `other-${i}`;
    synthetic.approval.graph.name = `other-${i}`;
    saved.plans.instances.push(synthetic);
  }
  const list = view(saved, { co: "20", mo: "25", po: "20", node: "release" });
  assert.equal(list.total, 23);
  assert.equal(list.offset, PLAN_PAGE_SIZE);
  assert.equal(list.rows.length, 3);
  assert.equal(list.detail.nodes.length, NODE_PAGE_SIZE);
  assert.equal(list.detail.selected.plan.node, "release");
  assert.equal(list.detail.selected.dependencyCount, 62);
  assert.equal(list.detail.selected.dependencies.length, PREREQUISITE_PAGE_SIZE);
  assert.equal(list.detail.selected.dependencies[0].id, "step-18");
  assert.doesNotMatch(JSON.stringify(list), /\/private\/checkout|start-api/);
});

test("legacy linear records expose the same statuses and prerequisite evidence", () => {
  const before = `${REPO}/prepare`, after = `${REPO}/finish`;
  const legacy = { name: "older-plan", repo: REPO, base: "main", status: "active", index: 1,
    created_at: "2026-11-21T12:00:00Z", updated_at: "2026-11-22T10:00:00Z",
    steps: [{ id: before, merged: { pr: 9, sha: "a".repeat(40), at: "2026-11-22T08:00:00Z" } }, { id: after }] };
  const data = catalog({ chains: { [legacy.name]: legacy } });
  const shared = planWindow(data, { plan: legacy.name, node: "finish" });
  const compatibility = planWindow(data, { plan: legacy.name, milestone: after }, { legacyOnly: true });
  assert.deepEqual(shared.detail.selected, compatibility.detail.selected);
  assert.deepEqual(shared.detail.selected.dependencies.map(d => d.status), ["integrated"]);
  assert.equal(shared.detail.counts.integrated, 1);
  assert.equal(shared.detail.selected.registered, false);
  assert.equal(planWindow(data, { plan: legacy.name, milestone: "other/repo/finish" }, { legacyOnly: true }).detail.missingNode, true);
});

test("the console feature matrix covers public CLI commands, providers and qualification limits", () => {
  const matrix = readFileSync(new URL("../docs/ui-feature-matrix.md", import.meta.url), "utf8");
  const help = execFileSync(process.execPath, ["bin/gallivant.mjs", "--help"], { encoding: "utf8", timeout: 5_000 });
  const commands = new Set([...help.matchAll(/^  gallivant (\S+)/gm)].map(match => match[1]));
  const names = [...commands, ...executionCapabilities().map(cap => cap.name)];
  for (const name of names) assert.ok(matrix.includes(`\`${name}`) || matrix.includes(`/${name}\``), name);
  assert.match(matrix, /Codex Cloud.*New dispatch is gated/);
  assert.match(matrix, /Learning.*Production injection remains unvalidated/);
  assert.match(matrix, /Company roles.*Planned/);
});
