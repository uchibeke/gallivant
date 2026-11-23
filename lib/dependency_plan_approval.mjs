import { recoveryDigest as digest } from "./recovery_digest.mjs";

export const PLAN_APPROVAL_VERSION = 1;
export const isPlanDigest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function dependencyPlanApprovalDigest({ graphDigest, sources }, admissionBindingsDigest = null) {
  if (admissionBindingsDigest !== null && !isPlanDigest(admissionBindingsDigest)) {
    throw new Error("expected a SHA-256 digest of admission bindings");
  }
  return digest([`dependency-plan-approval-v${PLAN_APPROVAL_VERSION}`, graphDigest, sources, admissionBindingsDigest]);
}

// A node contract includes the contracts of its prerequisites. Adding work
// downstream changes the whole revision without changing the frozen barrier.
export function nodeContracts(graph, bindings) {
  const incoming = new Map(graph.nodes.map(node => [node.id, []]));
  const outgoing = new Map(graph.nodes.map(node => [node.id, []]));
  for (const { from, to } of graph.edges) {
    incoming.get(to).push(from);
    outgoing.get(from).push(to);
  }
  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const remaining = new Map([...incoming].map(([id, needs]) => [id, needs.length]));
  const ready = [...nodes.keys()].filter(id => remaining.get(id) === 0);
  const contracts = new Map();
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i];
    contracts.set(id, digest([nodes.get(id), bindings.get(id) ?? null,
      [...incoming.get(id)].sort().map(need => [need, contracts.get(need)])]));
    for (const next of outgoing.get(id)) {
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) ready.push(next);
    }
  }
  if (contracts.size !== nodes.size) throw new Error("Plan dependency cycle");
  return contracts;
}

export const structuralRevision = (graph, contracts) => digest([graph, [...contracts].sort()]);
