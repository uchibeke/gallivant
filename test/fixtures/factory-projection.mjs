import { dependencyGraph } from "../../lib/dependency_plan_graph.mjs";
import { anchorGrants } from "../../lib/dependency_plan_anchors.mjs";

export const NOW = Date.parse("2026-11-22T12:00:00Z");
export const REPO = "acme/project";
export const PLAN = "delivery-plan";
export const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const at = m => new Date(NOW - m * 60_000).toISOString();
const taskId = slug => `${REPO}/${slug}`;
export const READER = { tenant: "local", grant: ({ action, scope }) => action === "read" && scope.tenant === "local" ? "local-read" : null };

function record(graph, { id = PLAN, scope = { tenant: "local", repositories: [REPO] }, anchors = [], runtimeAnchors = [] } = {}) {
  return { id, scope, admittedAt: at(90), checkoutRoot: "/private/checkout", approval: {
    graph, graphDigest: DIGEST, approvalDigest: DIGEST, structuralRevision: DIGEST, revision: 1,
    bindings: { tasks: [], anchors, limits: { maxIterations: 6, maxLiveGraphAuthors: 3, maxGraphAuthorsPerRepository: 2 } },
    nodeContracts: graph.nodes.map(node => [node.id, DIGEST]),
  }, runtime: { generation: 1, anchors: runtimeAnchors, nodes: {} }, control: { generation: 0, status: "active" } };
}

const task = (id, repo = REPO) => ({ id, taskId: `${repo}/${id}`, type: "task", repository: repo, base: "main", prd: `docs/prds/${id}.md` });
export const integration = (id, token, instanceId = PLAN) => ({ version: 1, kind: "repository-integration",
  owner: { instanceId, node: id, contract: DIGEST, token }, sha: SHA, head: SHA, at: at(45), number: 9,
  repository: REPO, base: "main", url: "https://github.com/acme/project/pull/9", cleanup: "retained" });

export function diamond() {
  const graph = dependencyGraph("release", "fixture");
  graph.add(graph.root, task("setup"), "fixture");
  const branches = graph.add(graph.root, { id: "branches", type: "group", mode: "parallel" }, "fixture", [{ ref: "setup", at: "fixture" }]);
  for (const id of ["api", "ui"]) graph.add(branches, task(id), "fixture");
  graph.add(graph.root, task("release"), "fixture", [{ ref: "branches", at: "fixture" }]);
  for (const id of ["ready", "closed", "cancelled", "unknown"]) graph.add(graph.root, task(id), "fixture");
  const plan = record(graph.finish());
  plan.runtime.nodes = { setup: { status: "integrated", receipt: integration("setup", "start-setup") },
    "branches/api": { status: "starting", token: "start-api" }, "branches/ui": { status: "starting", token: "start-ui" },
    cancelled: { status: "cancelled" } };
  const entries = Object.fromEntries(["ready", "closed", "unknown"].map((id, i) => {
    const token = `start-${id}`, pr = 42 + i;
    plan.runtime.nodes[id] = { status: "started", token };
    return [taskId(id), { plan: { instanceId: plan.id, node: id }, start_token: token, state: id === "ready" ? "ready-for-human" : "done",
      repo: REPO, base: "main", harness: "codex", iteration: 2, created_at: at(60), updated_at: at(20), pr,
      cursor: { fixed_sha: SHA }, last: { run: `run-${id}`, exit: 0 }, url: `https://github.com/acme/project/pull/${pr}`,
      completionEvidence: id === "ready" ? { delivery: { repository: REPO, pr, head: SHA, base: "main", gate: { allow: true }, observedAt: at(50) } }
        : id === "closed" ? { terminal: { state: "CLOSED", repository: REPO, base: "main", pr, head: SHA, observedAt: at(50) } } : {},
    }];
  }));
  return { plan, saved: { entries, plans: { instances: [plan] } } };
}

export function crossCompany(saved, plan) {
  const producer = dependencyGraph("confidential-producer", "fixture");
  const repo = "private-company/unreleased-repo";
  for (const id of ["secret-future-a", "secret-future-b"]) producer.add(producer.root, task(id, repo), "fixture");
  const other = record(producer.finish(), { id: "private-producer-id", scope: { tenant: "other-company", repositories: [repo] } });
  const allowed = { tenant: "local", grant: ({ action }) => `grant-${action}` };
  const pin = { producer: { instanceId: other.id, scope: other.scope, structuralRevision: DIGEST },
    nodes: other.approval.graph.nodes.map(n => ({ id: n.id, contract: DIGEST })),
    authorization: anchorGrants(allowed, plan.scope, other.scope) };
  plan.approval.graph.nodes.push({ type: "anchor", id: "upstream", target: { plan: other.approval.graph.name } });
  plan.approval.graph.edges.push({ from: "upstream", to: "release" });
  plan.approval.bindings.anchors.push(["upstream", pin]);
  plan.runtime.anchors.push(["upstream", pin.nodes.map(n => ({ id: n.id, status: "waiting" }))]);
  saved.plans.instances.push(other);
  saved.entries[`${repo}/secret-future-a`] = { repo, plan: { instanceId: other.id, node: "secret-future-a" }, state: "running" };
  return { other, pin, allowed };
}
