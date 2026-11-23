import { isDeepStrictEqual } from "node:util";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { chainRecoveryFences } from "./recovery_authority.mjs";

export const dispatchablePlan = plan => plan?.control.status === "active" &&
  plan.approval.bindings.limits.maxLiveGraphAuthors > 0 && plan.approval.bindings.limits.maxGraphAuthorsPerRepository > 0;

export const planNodeRuntime = (plan, node) => Object.hasOwn(plan.runtime.nodes ?? {}, node) ? plan.runtime.nodes[node] : { generation: 0 };
export const groupFence = (plan, group) => Object.hasOwn(plan.control.groups ?? {}, group) ? plan.control.groups[group] : null;
export function planFences(plan, id) {
  const parts = id.split("/");
  const fences = [plan.control.future];
  for (let i = 1; i < parts.length; i++) fences.push(groupFence(plan, parts.slice(0, i).join("/")));
  return fences;
}

export function futureDisposition(plan, id) {
  const fences = planFences(plan, id);
  if (plan.control.status === "cancelled" || fences.some(fence => fence?.status === "cancelled")) return "cancelled";
  return fences.some(fence => fence?.status === "held") ? "held" : null;
}

export function planNodeHolds(state, plan, node) {
  const legacy = chainRecoveryFences(state.recovery, { name: plan.approval.graph.name, repo: node.repository }, node.taskId);
  return [
    ...(plan.scope.tenant === "local" ? legacy : legacy.slice(1))
      .map(hold => ({ generation: hold?.generation ?? 0, active: Boolean(hold && hold.active !== false) })),
    ...planFences(plan, node.id).map(fence => ({ generation: fence?.generation ?? 0, active: Boolean(fence && fence.status !== "open") })),
  ];
}

export function ownsSubmittedStart(state, plan, node) {
  const token = planNodeRuntime(plan, node.id).token;
  const entry = state.entries[node.taskId];
  return Boolean(token && entry?.start_token === token && entry.initial_dispatch?.status !== "unsubmitted");
}

// Check the original execution owner. A read failure or any launch intent
// leaves the reservation ambiguous, even if it has no session or run ID.
export function graphLaunchUnsent(execution, token) {
  const saved = execution.state?.();
  return Boolean(saved && token && !saved.stopped && !saved.current &&
    saved.operations && Object.keys(saved.operations).length === 0 && !execution.current());
}

export function dependencyIndex(plan) {
  const { graph, bindings } = plan.approval;
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  const anchors = new Map(bindings.anchors), observed = new Map(plan.runtime.anchors);
  for (const { from, to } of graph.edges) incoming.get(to).push(from);
  return { incoming, anchors, observed };
}

export function anchorIntegration(pin, observations, index) {
  if (observations?.length !== pin.nodes.length) return null;
  const observation = observations[index], target = pin.nodes[index];
  if (observation?.id !== target.id || observation.status !== "integrated" || !observation.receipt) return null;
  const { receipt } = observation;
  const owner = { instanceId: pin.producer.instanceId, node: target.id, contract: target.contract, token: observation.start?.token };
  if (!owner.token) return null;
  if (receipt.kind === "repository-integration") return isDeepStrictEqual(owner, receipt.owner) ? receipt : null;
  const repositoryId = pin.repositoryIds?.find(([repo]) => repo === receipt.repository)?.[1];
  if (!repositoryId || !observation.pr?.url || !observation.pr.branch) return null;
  let host;
  try { host = new URL(observation.pr.url).hostname; } catch { return null; }
  return { kind: "repository-integration", version: 1, owner, ...receipt,
    repositoryId, host, branch: observation.pr.branch, url: observation.pr.url, delivery: "verified" };
}

export const nodeIntegration = runtime => runtime.status === "integrated" ? runtime.receipt ?? null : null;

/** Return the exact ordered AND barrier or null when any producer is pending. */
export function planPrerequisites(plan, node, { incoming, anchors, observed } = dependencyIndex(plan)) {
  const receipts = new Map();
  for (const from of incoming.get(node) ?? []) {
    const pin = anchors.get(from);
    if (pin && !pin.nodes.length) return null;
    for (let index = 0; index < (pin?.nodes.length ?? 1); index++) {
      const receipt = pin ? anchorIntegration(pin, observed.get(from), index) : nodeIntegration(planNodeRuntime(plan, from));
      if (!receipt) return null;
      receipts.set(digest(receipt.owner), receipt);
    }
  }
  return [...receipts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, receipt]) => receipt);
}

export function changePlanNode(plan, node, patch) {
  const previous = planNodeRuntime(plan, node);
  const { generation, ...value } = previous;
  const next = { ...value, ...patch };
  if (patch.reason && !value.firstFailure && (patch.status === "blocked" || patch.status === "queued" && patch.nextAt)) {
    next.firstFailure = patch.reason;
    if (patch.observedAt) next.firstFailureAt = patch.observedAt;
  }
  if (isDeepStrictEqual(value, next)) return false;
  plan.runtime = { ...plan.runtime, generation: plan.runtime.generation + 1,
    nodes: { ...plan.runtime.nodes, [node]: { ...next, generation: generation + 1 } } };
  return true;
}
