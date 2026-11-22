import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contentDigest } from "./hash.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { PLAN_LIMITS } from "./dependency_plan_limits.mjs";
import { dependencyPlanApprovalDigest, isPlanDigest, nodeContracts, structuralRevision } from "./dependency_plan_approval.mjs";
import { anchorGrants, anchorIdentity, assertAnchorCurrent, legacyInstance, legacyPlan, matchesLegacyNode, matchesRegisteredPr, observePlanAnchor,
  planCatalog, planFailure, planScope, scopeGrants } from "./dependency_plan_anchors.mjs";

export const PLAN_REGISTRY_VERSION = 3;
export const PLAN_STORE_VERSION = 1;
const MAX_PLANS = 128;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CLOSURE_NODES = 20_000, MAX_CLOSURE_EDGES = 100_000;
const badState = () => planFailure("PLAN_STATE", "Incompatible or incomplete dependency plan store. Restore the matching private backup and package.");
const conflict = () => planFailure("PLAN_CONFLICT", "A plan name, request or task is already reserved. Inspect the approved work before trying again.");
const stale = () => planFailure("PLAN_STALE", "The approved plan or its authority changed. Review the current proposal again.");
const limit = () => planFailure("PLAN_LIMIT", "The plan registry or dependency closure exceeds its admission limit.");
const records = state => state.plans?.instances ?? [];
const newStore = () => ({ version: PLAN_STORE_VERSION, instances: [], blobs: {} });
const legacyActive = chain => !["done", "cancelled"].includes(chain.status);

export function planTaskOwner(state, id) {
  for (const plan of records(state)) {
    if (plan.control.status !== "cancelled" && plan.approval.graph.nodes.some(node => node.type === "task" && node.taskId === id)) {
      return { kind: "graph" };
    }
  }
  for (const chain of Object.values(state.chains ?? {})) {
    if (legacyActive(chain) && chain.steps.some(step => step.id === id)) return { kind: "legacy", name: chain.name };
  }
  return null;
}

function assertFreeTasks(state, ids) {
  if (new Set(ids).size !== ids.length) throw conflict();
  for (const id of ids) if (state.entries[id] || state.starts?.[id] || planTaskOwner(state, id)) throw conflict();
}

// One graph of exact leaf identities. Historical owners with the same task
// name have different vertices. PR compatibility adds an edge only to the
// chain that actually owns the registered predecessor.
function assertClosure(state, catalog) {
  const outgoing = new Map(), remaining = new Map(), prOwners = new Map();
  const key = (plan, node) => `${plan.id}\0${node}`;
  function vertex(id) {
    if (outgoing.has(id)) return;
    if (outgoing.size >= MAX_CLOSURE_NODES) throw limit();
    outgoing.set(id, new Set());
    remaining.set(id, 0);
  }
  let edges = 0;
  function edge(from, to) {
    vertex(from); vertex(to);
    const adjacent = outgoing.get(from);
    if (adjacent.has(to)) return;
    if (++edges > MAX_CLOSURE_EDGES) throw limit();
    adjacent.add(to);
    remaining.set(to, remaining.get(to) + 1);
  }
  for (const plan of catalog) {
    for (const node of plan.graph.nodes) vertex(key(plan, node.id));
    for (const { from, to } of plan.graph.edges) edge(key(plan, from), key(plan, to));
    for (const [id, node] of plan.nodes ?? []) {
      if (matchesLegacyNode(plan.chain, node, state.entries[node.step.id])) prOwners.set(node.step.id, key(plan, id));
    }
  }
  const saved = new Map(records(state).map(plan => [plan.id, plan]));
  for (const plan of catalog) {
    if (plan.cancelled) continue;
    if (plan.kind === "legacy" && plan.chain.after) {
      const after = plan.chain.after, predecessor = prOwners.get(after.id);
      if (predecessor && matchesRegisteredPr(after, state.entries[after.id])) edge(predecessor, key(plan, plan.graph.nodes[0].id));
    }
    for (const [id, pin] of saved.get(plan.id)?.approval.bindings.anchors ?? []) {
      for (const node of pin.nodes) edge(key({ id: pin.producer.instanceId }, node.id), key(plan, id));
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id);
  for (let i = 0; i < ready.length; i++) {
    for (const next of outgoing.get(ready[i])) {
      remaining.set(next, remaining.get(next) - 1);
      if (remaining.get(next) === 0) ready.push(next);
    }
  }
  if (ready.length !== remaining.size) throw planFailure("PLAN_CYCLE", "The admitted dependency closure contains a cycle.");
}

export function admitLegacyChain(state, chain) {
  if (Object.hasOwn(state.chains ?? {}, chain.name) || records(state).some(plan => plan.scope.tenant === "local" && plan.approval.graph.name === chain.name)) {
    throw new Error(`chain ${chain.name} already exists`);
  }
  try { assertFreeTasks(state, chain.steps.map(step => step.id)); }
  catch (error) {
    if (error.code !== "PLAN_CONFLICT") throw error;
    const claimed = chain.steps.find(step => state.entries[step.id] || state.starts?.[step.id] || planTaskOwner(state, step.id));
    throw new Error(claimed ? `${claimed.id} already exists, is starting, or belongs to another chain or plan` : "a chain cannot contain duplicate PRDs");
  }
  state.chains = { ...state.chains, [chain.name]: chain };
  if (chain.repo && chain.base) assertClosure(state, planCatalog(state));
}

export function checkLegacyOwnership(state, before, after) {
  if (!legacyActive(after)) return;
  const prior = new Set(before.steps.map(step => step.id));
  const ids = after.steps.map(step => step.id);
  if (new Set(ids).size !== ids.length) throw conflict();
  for (const id of ids) {
    if (legacyActive(before) && prior.has(id)) continue;
    if (planTaskOwner(state, id)) throw conflict();
    if (!prior.has(id) && (state.entries[id] || state.starts?.[id])) throw conflict();
  }
  if (after.repo && after.base && (!legacyActive(before) || ids.some((id, index) => before.steps[index]?.id !== id) ||
      !isDeepStrictEqual(before.after && anchorIdentity(before.after), after.after && anchorIdentity(after.after)))) {
    const next = { ...state, chains: { ...state.chains, [after.name]: after } };
    assertClosure(next, planCatalog(next));
  }
}

export function planControlPins(state, name, repositories, taskIds) {
  const scopes = [`chain/${name}`, ...repositories.map(repo => `repo/${repo}`), ...taskIds.map(task => `task/${task}`)];
  return scopes.sort().map(scope => {
    const hold = state.recovery?.holds?.[scope];
    return [scope, { generation: hold?.generation ?? 0, active: hold ? hold.active !== false : false }];
  });
}

export function operatorBinding(operator, scope) {
  const grants = scopeGrants(operator, scope, ["read", "queue"]);
  return grants && operator.tenant === scope.tenant ? { principal: operator.principal, launch: operator.isolation.launchDigest, grants } : null;
}

export function planApproval(compiled, bindings) {
  return { ...compiled, bindings, approvalDigest: dependencyPlanApprovalDigest(compiled, digest(bindings)), admission: "resolved" };
}

function approvalContracts(proposal) {
  const { graph, bindings } = proposal;
  const repositories = new Map(bindings.repositories);
  return nodeContracts(graph, new Map([
    ...bindings.tasks.map(([id, task]) => [id, [task, repositories.get(task.repositoryBinding), bindings.limits]]),
    ...bindings.anchors,
  ]));
}

const requestPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
export function validatePlanRequest(requestId, approvalDigest) {
  if (typeof requestId !== "string" || !requestPattern.test(requestId) || !isPlanDigest(approvalDigest)) {
    throw planFailure("PLAN_REQUEST", "Supply the reviewed SHA-256 digest and a valid request ID.");
  }
}

export function findPlanReceipt(state, operator, requestId, approvalDigest) {
  validatePlanRequest(requestId, approvalDigest);
  const saved = records(state).find(plan => plan.scope.tenant === operator.tenant && plan.request.id === requestId);
  if (!saved) return null;
  if (saved.request.principal !== operator.principal || saved.approval.approvalDigest !== approvalDigest ||
      !operatorBinding(operator, saved.scope)) throw conflict();
  return { requestId, instanceId: saved.id, name: saved.approval.graph.name, approvalDigest, status: saved.control.status };
}

export function admitGraphPlan(state, operator, proposal, snapshots, requestId) {
  const { approvalDigest, bindings, graph } = proposal;
  const existing = findPlanReceipt(state, operator, requestId, approvalDigest);
  if (existing) return existing;
  if (!bindings.operator || !isDeepStrictEqual(bindings.operator, operatorBinding(operator, bindings.scope)) ||
      digest(graph) !== proposal.graphDigest || dependencyPlanApprovalDigest(proposal, digest(bindings)) !== approvalDigest) throw stale();
  const catalog = planCatalog(state);
  if (catalog.some(plan => plan.name === graph.name && plan.scope.tenant === bindings.scope.tenant)) throw conflict();
  const tasks = graph.nodes.filter(node => node.type === "task").map(node => node.taskId);
  if (!isDeepStrictEqual(bindings.controls, planControlPins(state, graph.name, bindings.scope.repositories, tasks))) throw stale();
  assertFreeTasks(state, tasks);
  const producers = new Map(catalog.map(plan => [plan.id, plan]));
  for (const [, pin] of bindings.anchors) assertAnchorCurrent(producers.get(pin.producer.instanceId), operator, bindings.scope, pin);
  if (records(state).length >= MAX_PLANS) throw limit();

  const plans = state.plans ??= newStore();
  for (const { path, digest: hash } of proposal.sources) {
    const bytes = snapshots.get(path);
    if (!Buffer.isBuffer(bytes) || contentDigest(bytes) !== hash) throw stale();
    plans.blobs[hash] ??= bytes.toString("base64");
  }
  const contracts = approvalContracts(proposal);
  const record = { id: randomUUID(), scope: bindings.scope, request: { id: requestId, principal: operator.principal },
    approval: { ...proposal, revision: 1, structuralRevision: structuralRevision(graph, contracts), nodeContracts: [...contracts] },
    runtime: { generation: 0, anchors: bindings.anchors.map(([id, pin]) => [id, observePlanAnchor(state, producers.get(pin.producer.instanceId), pin)]) },
    control: { generation: 0, status: "observation-only" } };
  plans.instances.push(record);
  state.version = PLAN_REGISTRY_VERSION;
  assertClosure(state, planCatalog(state));
  if (Buffer.byteLength(JSON.stringify(plans)) > MAX_STORE_BYTES) throw limit();
  checkPlanRegistry(state);
  return findPlanReceipt(state, operator, requestId, approvalDigest);
}

export function reconcilePlanAnchors(state) {
  const plans = records(state);
  const pinned = new Set(plans.flatMap(plan => plan.approval.bindings.anchors.map(([, pin]) => pin.producer.instanceId)));
  if (!pinned.size) return state;
  const producerState = { plans: { instances: plans.filter(plan => pinned.has(plan.id)) },
    chains: Object.fromEntries(Object.entries(state.chains ?? {}).filter(([, chain]) => pinned.has(legacyInstance(chain)))) };
  const producers = new Map(planCatalog(producerState, { tolerateUnavailable: true }).map(plan => [plan.id, plan]));
  const instances = plans.map(plan => {
    const prior = new Map(plan.runtime.anchors);
    const anchors = plan.approval.bindings.anchors.map(([id, pin]) => [id, observePlanAnchor(state, producers.get(pin.producer.instanceId), pin, prior.get(id))]);
    return isDeepStrictEqual(anchors, plan.runtime.anchors) ? plan : { ...plan, runtime: { generation: plan.runtime.generation + 1, anchors } };
  });
  return { ...state, plans: { ...state.plans, instances } };
}

export function planInspection(state, operator, selector = null) {
  const visible = records(state).filter(plan => plan.scope.tenant === operator.tenant &&
    scopeGrants(operator, plan.scope, ["read"]) && (!selector || selector === plan.approval.graph.name || selector === plan.id));
  if (!selector) return visible.map(plan => ({ name: plan.approval.graph.name, instanceId: plan.id, status: plan.control.status }));
  if (visible.length !== 1) throw planFailure("PLAN_MISSING", "The plan is unavailable or access is not authorized.");
  const plan = visible[0], { graph, sources, graphDigest, approvalDigest, revision, structuralRevision } = plan.approval;
  const inspected = reconcilePlanAnchors(state).plans.instances.find(record => record.id === plan.id);
  const observations = new Map(inspected.runtime.anchors), anchors = new Map(plan.approval.bindings.anchors);
  const nodes = graph.nodes.map(node => {
    if (node.type === "task") return { ...node, status: "dispatch-disabled" };
    const pin = anchors.get(node.id);
    const grant = anchorGrants(operator, plan.scope, pin.producer.scope);
    if (!grant || grant !== pin.authorization) return { id: node.id, type: node.type, status: "producer-unavailable" };
    return { ...node, resolution: "pinned", producer: pin.producer, frozen: pin.nodes,
      observed: observations.get(node.id).map(({ id, status, pr, receipt }) => ({ id, status,
        ...(!["producer-unavailable", "review-required"].includes(status) && pr ? { pr } : {}),
        ...(status === "integrated" ? { receipt } : {}) })) };
  });
  return { instanceId: plan.id, status: plan.control.status, graph: { ...graph, nodes }, sources, graphDigest, approvalDigest,
    revision, structuralRevision, runtimeGeneration: plan.runtime.generation, controlGeneration: plan.control.generation };
}

export function planMigrationPreview(state, operator) {
  const chains = Object.values(state.chains ?? {});
  const projections = chains.map(chain => {
    const plan = legacyPlan(chain);
    if (!plan || !scopeGrants(operator, plan.scope, ["read", "migrate"])) throw badState();
    return { name: chain.name, instanceId: plan.id, structuralRevision: plan.revision,
      steps: chain.steps.length, checkpoint: digest(chain) };
  });
  if (!scopeGrants(operator, planScope(operator.tenant, []), ["migrate"])) throw badState();
  // Seal the registry observation, preserving every original field and all
  // external ledgers in place. No execution owner is transferred in 02.
  const binding = [state.version, state.chains ?? {}, state.entries, state.starts ?? {}, state.recovery ?? null];
  const approvalDigest = digest(["legacy-plan-migration-v1", operator.principal, operator.tenant, operator.isolation.launchDigest, binding]);
  const preview = { mode: "legacy-dispatch", cutover: "disabled", fromVersion: state.version,
    registryVersion: PLAN_REGISTRY_VERSION, graphVersion: PLAN_STORE_VERSION, approvalDigest, chains: projections,
    entries: Object.keys(state.entries).length, claims: Object.keys(state.starts ?? {}).length };
  if (Buffer.byteLength(JSON.stringify(preview)) > PLAN_LIMITS.previewBytes) throw limit();
  return preview;
}

export function applyPlanMigration(state, operator, expected) {
  const saved = state.plans?.migration;
  if (saved?.approvalDigest === expected && saved.principal === operator.principal && saved.tenant === operator.tenant) {
    planMigrationPreview(state, operator); // Check current scope before returning a lost response.
    return saved;
  }
  if (saved) throw conflict();
  const preview = planMigrationPreview(state, operator);
  if (preview.approvalDigest !== expected) throw stale();
  assertClosure(state, planCatalog(state));
  const plans = state.plans ??= newStore();
  plans.migration = { ...preview, principal: operator.principal, tenant: operator.tenant };
  state.version = PLAN_REGISTRY_VERSION;
  checkPlanRegistry(state);
  return plans.migration;
}

export function checkPlanRegistry(state) {
  if (state.version !== PLAN_REGISTRY_VERSION && state.plans === undefined) return;
  const plans = state.plans;
  if (state.version !== PLAN_REGISTRY_VERSION || plans?.version !== PLAN_STORE_VERSION || !Array.isArray(plans.instances) ||
      plans.instances.length > MAX_PLANS || !plans.blobs || typeof plans.blobs !== "object" || Array.isArray(plans.blobs)) throw badState();
  const checked = new Set(), ids = new Set(), owners = new Set(), names = new Set(), requests = new Set();
  for (const record of plans.instances) {
    const { id, approval, runtime, control } = record;
    if (typeof id !== "string" || ids.has(id) || approval?.revision !== 1 || approval.graph?.version !== 1 ||
        digest(approval.graph) !== approval.graphDigest || dependencyPlanApprovalDigest(approval, digest(approval.bindings)) !== approval.approvalDigest ||
        !isDeepStrictEqual(approval.bindings?.scope, record.scope) || !Array.isArray(approval.nodeContracts) ||
        !Number.isSafeInteger(runtime?.generation) || runtime.generation < 0 || !Array.isArray(runtime.anchors) ||
        !Number.isSafeInteger(control?.generation) || control.generation < 0 || !["observation-only", "cancelled"].includes(control.status) ||
        !requestPattern.test(record.request?.id ?? "") || !Array.isArray(approval.sources) || approval.sources.length > PLAN_LIMITS.files ||
        !Array.isArray(approval.bindings?.anchors)) throw badState();
    ids.add(id);
    const name = `${record.scope.tenant}\0${approval.graph.name}`, request = `${record.scope.tenant}\0${record.request.id}`;
    if (names.has(name) || requests.has(request)) throw badState();
    names.add(name); requests.add(request);
    const anchorIds = new Set(approval.graph.nodes.filter(node => node.type === "anchor").map(node => node.id));
    if (anchorIds.size !== approval.bindings.anchors.length || anchorIds.size !== runtime.anchors.length) throw badState();
    const observations = new Map(runtime.anchors);
    for (const [anchor, pin] of approval.bindings.anchors) {
      if (!anchorIds.delete(anchor) || typeof pin.producer?.instanceId !== "string" || !isPlanDigest(pin.producer.structuralRevision) ||
          !isPlanDigest(pin.authorization) || !Array.isArray(pin.nodes) || !pin.nodes.length ||
          pin.nodes.some(node => typeof node.id !== "string" || !isPlanDigest(node.contract)) ||
          !Array.isArray(observations.get(anchor))) throw badState();
    }
    if (control.status !== "cancelled") for (const node of approval.graph.nodes) {
      if (node.type !== "task") continue;
      if (owners.has(node.taskId) || state.starts?.[node.taskId] || state.entries[node.taskId]) throw badState();
      owners.add(node.taskId);
    }
    const contracts = approvalContracts(approval);
    if (structuralRevision(approval.graph, contracts) !== approval.structuralRevision || !isDeepStrictEqual([...contracts], approval.nodeContracts)) throw badState();
    for (const { digest: hash } of approval.sources) {
      if (checked.has(hash)) continue;
      const data = plans.blobs[hash];
      if (!isPlanDigest(hash) || typeof data !== "string" || data.length > 4 * Math.ceil(PLAN_LIMITS.sourceBytes / 3) ||
          contentDigest(Buffer.from(data, "base64")) !== hash) throw badState();
      checked.add(hash);
    }
  }
  if (checked.size !== Object.keys(plans.blobs).length) throw badState();
  if (Object.values(state.chains ?? {}).some(chain => legacyActive(chain) && chain.steps.some(step => owners.has(step.id)))) throw badState();
}
