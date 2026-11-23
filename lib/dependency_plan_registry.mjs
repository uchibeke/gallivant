import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { contentDigest } from "./hash.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { PLAN_LIMITS } from "./dependency_plan_limits.mjs";
import { dependencyPlanApprovalDigest, isPlanDigest, nodeContracts, structuralRevision } from "./dependency_plan_approval.mjs";
import { anchorGrants, anchorIdentity, assertAnchorCurrent, canReadPlan, legacyInstance, legacyPlan, matchesLegacyNode, matchesRegisteredPr, observePlanAnchor,
  planCatalog, planFailure, planScope, scopeGrants } from "./dependency_plan_anchors.mjs";

import { DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION, PLAN_REGISTRY_VERSION, PLAN_STORE_VERSION } from "./registry_versions.mjs";
import { dispatchState } from "./dispatch_capacity.mjs";
import { changePlanNode, dependencyIndex, futureDisposition, groupFence, ownsSubmittedStart, planNodeHolds, planNodeRuntime } from "./dependency_plan_runtime.mjs";
import { settledCancellation } from "./task_completion.mjs";
import { controlPending } from "./control_contract.mjs";
import { isAbsolute, join } from "node:path";

export { PLAN_REGISTRY_VERSION };
export { PLAN_STORE_VERSION };
const MAX_PLANS = 128;
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const MAX_CLOSURE_NODES = 20_000, MAX_CLOSURE_EDGES = 100_000;
const badState = () => planFailure("PLAN_STATE", "Incompatible or incomplete dependency plan store. Restore the matching private backup and package.");
const conflict = () => planFailure("PLAN_CONFLICT", "A plan name, request or task is already reserved. Inspect the approved work before trying again.");
const stale = () => planFailure("PLAN_STALE", "The approved plan or its authority changed. Review the current proposal again.");
const limit = () => planFailure("PLAN_LIMIT", "The plan registry or dependency closure exceeds its admission limit.");
const records = state => state.plans?.instances ?? [];
const newStore = () => ({ version: 1, instances: [], blobs: {} });
const legacyActive = chain => !["done", "cancelled"].includes(chain.status);

export function planTaskOwner(state, id) {
  for (const plan of records(state)) {
    if (plan.approval.graph.nodes.some(node => node.type === "task" && node.taskId === id &&
        (futureDisposition(plan, node.id) !== "cancelled" || planNodeRuntime(plan, node.id).token))) {
      return { kind: "graph", instanceId: plan.id };
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
    if (plan.kind === "legacy" && plan.cancelled) continue;
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

export function planControlPins(state, name, scope, taskIds) {
  const scopes = [...(scope.tenant === "local" ? [`chain/${name}`] : []),
    ...scope.repositories.map(repo => `repo/${repo}`), ...taskIds.map(task => `task/${task}`)];
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
  if (controlReceipts(state, operator).some(row => row.requestId === requestId)) throw conflict();
  const saved = records(state).find(plan => plan.scope.tenant === operator.tenant && plan.request.id === requestId);
  if (!saved) return null;
  if (saved.request.principal !== operator.principal || (saved.request.approvalDigest ?? saved.approval.approvalDigest) !== approvalDigest ||
      !operatorBinding(operator, saved.scope)) throw conflict();
  return { requestId, instanceId: saved.id, name: saved.approval.graph.name, approvalDigest, status: saved.request.status ?? saved.control.status };
}

export function admitGraphPlan(state, operator, proposal, snapshots, requestId, root, assertLocal) {
  const { approvalDigest, bindings, graph } = proposal;
  const existing = findPlanReceipt(state, operator, requestId, approvalDigest);
  if (existing) return existing;
  assertLocal?.();
  if (!bindings.operator || !isDeepStrictEqual(bindings.operator, operatorBinding(operator, bindings.scope)) ||
      digest(graph) !== proposal.graphDigest || dependencyPlanApprovalDigest(proposal, digest(bindings)) !== approvalDigest) throw stale();
  const catalog = planCatalog(state);
  if (catalog.some(plan => plan.name === graph.name && plan.scope.tenant === bindings.scope.tenant)) throw conflict();
  const tasks = graph.nodes.filter(node => node.type === "task").map(node => node.taskId);
  if (!isDeepStrictEqual(bindings.controls, planControlPins(state, graph.name, bindings.scope, tasks))) throw stale();
  assertFreeTasks(state, tasks);
  const producers = new Map(catalog.map(plan => [plan.id, plan]));
  for (const [, pin] of bindings.anchors) assertAnchorCurrent(producers.get(pin.producer.instanceId), operator, bindings.scope, pin);
  if (records(state).length >= MAX_PLANS) throw limit();

  const plans = state.plans ??= newStore();
  storeSnapshots(plans, proposal, snapshots);
  const contracts = approvalContracts(proposal);
  const active = Boolean(bindings.limits.maxLiveGraphAuthors && bindings.limits.maxGraphAuthorsPerRepository);
  if (active && (typeof root !== "string" || !isAbsolute(root))) throw stale();
  const record = { id: randomUUID(), admittedAt: new Date().toISOString(), scope: bindings.scope, request: { id: requestId, principal: operator.principal,
    approvalDigest, status: active ? "active" : "observation-only" },
    approval: { ...proposal, revision: 1, structuralRevision: structuralRevision(graph, contracts), nodeContracts: [...contracts] },
    ...(active ? { checkoutRoot: root } : {}),
    runtime: { generation: 0, anchors: bindings.anchors.map(([id, pin]) => [id, observePlanAnchor(state, producers.get(pin.producer.instanceId), pin)]) },
    control: { generation: 0, status: active ? "active" : "observation-only" } };
  plans.instances.push(record);
  if (active) dispatchState(state);
  state.version = PLAN_CONTROL_REGISTRY_VERSION;
  plans.version = PLAN_STORE_VERSION;
  assertClosure(state, planCatalog(state));
  state.plans = compactPlanSources(state).plans;
  checkPlanWrite(state);
  return findPlanReceipt(state, operator, requestId, approvalDigest);
}

function storeSnapshots(plans, proposal, snapshots) {
  for (const { path, digest: hash } of proposal.sources) {
    const bytes = snapshots.get(path);
    if (!Buffer.isBuffer(bytes) || contentDigest(bytes) !== hash) throw stale();
    plans.blobs[hash] ??= bytes.toString("base64");
  }
}

const controlReceipts = (state, operator) => (state.plans?.controls ?? []).filter(row => row.tenant === operator.tenant);
const denied = () => planFailure("PLAN_AUTHORITY", "The plan control is unavailable or access is not authorized.");
const gated = message => planFailure("PLAN_CONTROL", message);
const groupsOf = graph => graph.hierarchy.flatMap(function groups(node) {
  return node.type === "group" ? [node.id, ...node.children.flatMap(groups)] : [];
});

function controlGrant(operator, plan, { action, group, node }) {
  if (!plan || plan.scope.tenant !== operator.tenant || !scopeGrants(operator, plan.scope, ["read"])) throw denied();
  const scope = { ...plan.scope, plan: plan.id, ...(group ? { group } : {}), ...(node ? { node } : {}) };
  const grant = scopeGrants(operator, scope, [action]);
  if (!grant) throw denied();
  return digest([operator.principal, operator.isolation.launchDigest, scope, grant]);
}

export function selectPlanControl(state, operator, command) {
  const plan = records(state).find(plan => plan.scope.tenant === operator.tenant &&
    (plan.id === command.plan || plan.approval.graph.name === command.plan));
  return { plan, grant: controlGrant(operator, plan, command) };
}

export function findPlanControlReceipt(state, operator, command) {
  const { requestId, approve } = command;
  const saved = controlReceipts(state, operator).find(row => row.requestId === requestId);
  if (!saved) {
    if (records(state).some(plan => plan.scope.tenant === operator.tenant && plan.request.id === requestId)) throw conflict();
    return null;
  }
  const { plan } = selectPlanControl(state, operator, command);
  if (saved.principal !== operator.principal || saved.command !== commandIdentity(plan, command) || saved.revision !== approve) throw conflict();
  return saved.result;
}

const commandIdentity = (plan, { action, group, node, input }) => digest([plan.id, action, group ?? null, node ?? null,
  input?.options?.inline ? input.options.inline : input ?? null]);
const fingerprintChanges = (before, after) => [...new Set([...before.keys(), ...after.keys()])].sort()
  .filter(id => before.get(id) !== after.get(id)).map(id => ({ id, before: before.get(id) ?? null, after: after.get(id) ?? null }));

function reviewEdit(state, plan, operator, action, prepared) {
  const before = plan.approval, after = prepared.result;
  if (plan.control.status === "cancelled") throw gated("The plan's future dispatch has been cancelled.");
  if (after.graph.name !== before.graph.name || prepared.root !== (plan.checkoutRoot ?? prepared.root) ||
      !isDeepStrictEqual(plan.scope, after.bindings.scope) || !isDeepStrictEqual(before.bindings.limits, after.bindings.limits) ||
      !isDeepStrictEqual(before.bindings.operator, after.bindings.operator) ||
      after.bindings.repositories.some(([key, repo]) => !isDeepStrictEqual(new Map(before.bindings.repositories).get(key), repo))) {
    throw gated("The proposal must retain the approved checkout, repository, base, authority and plan policy.");
  }
  if (after.approvalDigest === before.approvalDigest) throw gated("The proposal contains no changes.");
  const anchors = new Map(after.bindings.anchors), existing = new Map(before.bindings.anchors);
  if ([...existing].some(([id, pin]) => !isDeepStrictEqual(pin, anchors.get(id))) ||
      (action === "attach") !== [...anchors.keys()].some(id => !existing.has(id))) {
    throw gated("Frozen anchors must remain unchanged. Use attach to add a new producer link.");
  }
  const contracts = [...approvalContracts(after)];
  const changes = fingerprintChanges(new Map(before.nodeContracts), new Map(contracts));
  const frozen = new Set(records(state).flatMap(record => record.approval.bindings.anchors
    .filter(([, pin]) => pin.producer.instanceId === plan.id).flatMap(([, pin]) => pin.nodes.map(node => node.id))));
  const past = new Map(before.graph.nodes.map(node => [node.id, node]));
  for (const { id, before: prior, after: next } of changes) {
    const node = past.get(id);
    if (frozen.has(id) || planNodeRuntime(plan, id).token || futureDisposition(plan, id) === "cancelled" ||
        node?.type === "task" && (state.entries[node.taskId] || state.starts?.[node.taskId])) {
      throw gated("The affected closure includes a reserved, dispatched, cancelled or frozen node.");
    }
    // Keep failure lineage even if the node is removed. A later addition may
    // not recycle a retired ID with a different approved contract.
    if (!prior && next && Object.hasOwn(plan.runtime.nodes ?? {}, id)) throw gated("A retired node identity cannot be reused.");
  }
  const priorTasks = new Set(before.graph.nodes.filter(node => node.type === "task").map(node => node.taskId));
  assertFreeTasks(state, after.graph.nodes.filter(node => node.type === "task" && !priorTasks.has(node.taskId)).map(node => node.taskId));
  const groups = new Set(groupsOf(after.graph));
  if (Object.keys(plan.control.groups ?? {}).some(id => !groups.has(id))) {
    throw gated("The proposal removes a group with saved controls.");
  }
  const scope = after.bindings.scope;
  if (!isDeepStrictEqual(after.bindings.controls, planControlPins(state, after.graph.name, scope,
    after.graph.nodes.filter(node => node.type === "task").map(node => node.taskId)))) throw stale();
  const catalog = planCatalog(state), producers = new Map(catalog.map(plan => [plan.id, plan]));
  for (const [id, pin] of anchors) {
    const producer = producers.get(pin.producer.instanceId);
    assertAnchorCurrent(existing.has(id) && producer?.kind === "graph" ? { ...producer, cancelled: false } : producer, operator, scope, pin);
  }
  const approval = { ...after, revision: before.revision + 1, nodeContracts: contracts,
    structuralRevision: structuralRevision(after.graph, new Map(contracts)) };
  const candidate = { ...state, plans: { ...state.plans, instances: records(state).map(record => record.id === plan.id ? { ...plan, approval } : record) } };
  assertClosure(candidate, planCatalog(candidate));
  const sources = list => new Map(list.map(source => [source.path, source.digest]));
  return { approval, changes, sources: fingerprintChanges(sources(before.sources), sources(after.sources)) };
}

export function describePlanControl(state, operator, command, prepared) {
  const { action, group, node, requestId } = command;
  const { plan, grant } = selectPlanControl(state, operator, command);
  const leaves = plan.approval.graph.nodes.filter(leaf => leaf.type === "task");
  let effect, scope;
  if (action === "edit" || action === "attach") {
    const { approval, changes, sources } = reviewEdit(state, plan, operator, action, prepared);
    effect = { approval, changes };
    scope = { approval: { before: plan.approval.approvalDigest, after: approval.approvalDigest },
      graph: { before: plan.approval.graphDigest, after: approval.graphDigest }, changes, sources };
  } else if (action === "retry") {
    const leaf = leaves.find(leaf => leaf.id === node);
    const runtime = leaf && planNodeRuntime(plan, node);
    if (!leaf || runtime.status !== "blocked") throw gated("Retry requires a blocked node. Inspect the existing task for its own controls.");
    if (futureDisposition(plan, node) || planNodeHolds(state, plan, leaf).some(hold => hold.active)) throw gated("The node is held or cancelled.");
    const started = state.entries[leaf.taskId], claim = state.starts?.[leaf.taskId];
    const clone = started?.initial_dispatch?.clone ?? claim?.clone?.proof;
    if (runtime.token || started || claim) {
      const unsent = runtime.token && (claim?.token === runtime.token && claim.unsent ||
        started?.start_token === runtime.token && started.initial_dispatch?.status === "unsubmitted" &&
        started.dispatch_stopped === "plan-start-unsubmitted" && !started.last?.run && !started.session && !started.pr && !controlPending(started.control));
      if (!unsent || !clone || state.dispatch?.authors?.[leaf.taskId] || !prepared?.provenUnsent(leaf.taskId, runtime.token, leaf, plan)) {
        throw gated("Use the existing task controls for admitted work. An unresolved launch or unverified checkout requires inspection of its original ownership.");
      }
    }
    effect = { node, generation: runtime.generation, holds: planNodeHolds(state, plan, leaf),
      ...(runtime.token ? { token: runtime.token, clone } : {}) };
    scope = { node, firstFailure: runtime.firstFailure ?? runtime.reason, originalStart: Boolean(effect.token) };
  } else {
    if (group && !groupsOf(plan.approval.graph).includes(group)) throw denied();
    const fence = group ? groupFence(plan, group) : plan.control.future;
    if (plan.control.status === "cancelled" || fence?.status === "cancelled") throw gated("This dispatch scope has been cancelled.");
    if (action === "hold" && fence?.status === "held" || action === "unhold" && fence?.status !== "held") {
      throw gated("The reviewed hold is already in that disposition.");
    }
    const members = leaves.filter(leaf => !group || leaf.id.startsWith(`${group}/`));
    const admitted = new Set(members.filter(leaf => ownsSubmittedStart(state, plan, leaf)).map(leaf => leaf.id));
    scope = { group: group ?? null, future: members.filter(leaf => !admitted.has(leaf.id) &&
      futureDisposition(plan, leaf.id) !== "cancelled").map(leaf => leaf.id), admitted: [...admitted] };
    effect = { scope, generation: fence?.generation ?? 0 };
  }
  // Progress alone can stale a review; a group mutation only fences its own
  // descendants when the dispatch owner checks its saved generations.
  const revision = digest([commandIdentity(plan, command), requestId, grant, plan.approval.approvalDigest,
    plan.approval.revision, plan.control.generation, plan.runtime.generation, effect]);
  const review = { status: "review", action, requestId, instanceId: plan.id, revision,
    approvalRevision: plan.approval.revision, controlGeneration: plan.control.generation, runtimeGeneration: plan.runtime.generation, scope };
  if (Buffer.byteLength(JSON.stringify(review)) > PLAN_LIMITS.previewBytes) throw limit();
  return { plan, effect, review };
}

export function applyPlanControl(state, operator, command, prepared) {
  const previous = findPlanControlReceipt(state, operator, command);
  if (previous) return { result: previous, replay: true };
  const { plan, effect, review } = describePlanControl(state, operator, command, prepared);
  if (review.revision !== command.approve) throw stale();
  prepared?.assertLocal?.();
  const { action, group, requestId } = command;
  // Upgrade under the same lock as the first control. An old binary cannot
  // ignore scoped fences or mistake compacted approval inputs for corruption.
  state.version = PLAN_CONTROL_REGISTRY_VERSION;
  state.plans.version = PLAN_STORE_VERSION;
  plan.request = { approvalDigest: plan.approval.approvalDigest, status: plan.control.status, ...plan.request };
  const control = plan.control = { ...plan.control, generation: plan.control.generation + 1 };
  if (effect.approval) {
    storeSnapshots(state.plans, effect.approval, prepared.snapshots);
    plan.approval = effect.approval;
    const observed = new Map(plan.runtime.anchors);
    plan.runtime.anchors = plan.approval.bindings.anchors.map(([id]) => [id, observed.get(id) ?? []]);
    for (const { id, after } of effect.changes) if (after && Object.hasOwn(plan.runtime.nodes ?? {}, id)) {
      changePlanNode(plan, id, { status: "queued", reason: null, nextAt: null, wait: null });
    }
  } else if (action === "retry") {
    changePlanNode(plan, effect.node, { status: "queued", reason: null, nextAt: null, wait: null,
      ...(effect.token ? { retry: { token: effect.token, requestId } } : {}) });
  } else {
    const status = { hold: "held", unhold: "open", cancel: "cancelled" }[action];
    const fence = { status, generation: effect.generation + 1 };
    if (group) control.groups = { ...control.groups, [group]: fence };
    else {
      control.future = fence;
      if (action === "cancel") control.status = "cancelled";
    }
  }
  const result = { status: "applied", action, requestId, instanceId: plan.id,
    approvalDigest: plan.approval.approvalDigest, approvalRevision: plan.approval.revision, controlGeneration: control.generation };
  (state.plans.controls ??= []).push({ tenant: operator.tenant, principal: operator.principal, requestId,
    command: commandIdentity(plan, command), revision: review.revision, result });
  state.plans = compactPlanSources(state).plans;
  checkPlanWrite(state);
  return { result };
}

function checkPlanWrite(state) {
  if (Buffer.byteLength(JSON.stringify(state.plans)) > MAX_STORE_BYTES) throw limit();
  checkPlanRegistry(state);
}

export function planNodeNeedsInputs(state, plan, node) {
  const runtime = planNodeRuntime(plan, node.id);
  const { taskId } = node;
  if (runtime.status === "integrated") return false;
  if (state.starts?.[taskId]?.token && state.starts[taskId].token === runtime.token) return true;
  const entry = state.entries[taskId];
  if (runtime.token && entry?.start_token === runtime.token) {
    return Boolean(state.dispatch?.authors?.[taskId]) || entry.state !== "done" && !settledCancellation(entry) &&
      (ownsSubmittedStart(state, plan, node) || futureDisposition(plan, node.id) !== "cancelled");
  }
  return plan.control.status === "active" && futureDisposition(plan, node.id) !== "cancelled";
}

export function planInputPaths(state) {
  const paths = new Set();
  for (const plan of records(state)) {
    for (const node of plan.approval.graph.nodes) {
      if (node.type !== "task" || !planNodeNeedsInputs(state, plan, node)) continue;
      if (plan.checkoutRoot) paths.add(join(plan.checkoutRoot, node.checkout));
      const claim = state.starts?.[node.taskId];
      if (claim?.plan?.instanceId === plan.id && claim.clone?.worktree) paths.add(claim.clone.worktree);
    }
  }
  return paths;
}

function referencedPlanBlobs(state) {
  const hashes = new Set();
  for (const plan of records(state)) {
    if (state.plans.version === 1 || plan.control.status === "observation-only" ||
        plan.approval.graph.nodes.some(node => node.type === "task" && planNodeNeedsInputs(state, plan, node))) {
      for (const source of plan.approval.sources) hashes.add(source.digest);
    }
  }
  return hashes;
}

export function compactPlanSources(state) {
  if (state.plans?.version !== PLAN_STORE_VERSION) return state;
  const hashes = referencedPlanBlobs(state);
  const blobs = state.plans.blobs;
  if (Object.keys(blobs).every(hash => hashes.has(hash))) return state;
  return { ...state, plans: { ...state.plans, blobs: Object.fromEntries(Object.entries(blobs).filter(([hash]) => hashes.has(hash))) } };
}

export function openGraphPlans(state) {
  return records(state).filter(plan => plan.approval.graph.nodes.some(node => node.type === "task" && planNodeNeedsInputs(state, plan, node)));
}

export function settleCancelledPlanStarts(state) {
  if (state.plans?.version !== PLAN_STORE_VERSION) return state;
  let next = state;
  for (const saved of records(state)) {
    let plan = saved;
    for (const node of saved.approval.graph.nodes) {
      if (node.type !== "task") continue;
      const { taskId } = node, runtime = planNodeRuntime(plan, node.id);
      if (!runtime.token || futureDisposition(plan, node.id) !== "cancelled" || state.dispatch?.authors?.[taskId]) continue;
      const claim = state.starts?.[taskId], entry = state.entries[taskId];
      const unsentClaim = claim?.token === runtime.token && claim.unsent;
      const unsentEntry = entry?.start_token === runtime.token && entry.initial_dispatch?.status === "unsubmitted" &&
        entry.dispatch_stopped === "plan-start-unsubmitted" && !entry.pr && !entry.last?.run && !entry.session && !controlPending(entry.control);
      if (!unsentClaim && !unsentEntry) continue;
      if (next === state) next = { ...state, starts: { ...state.starts }, entries: { ...state.entries },
        plans: { ...state.plans, instances: [...state.plans.instances] } };
      if (plan === saved) {
        plan = { ...saved };
        next.plans.instances[next.plans.instances.indexOf(saved)] = plan;
      }
      if (unsentClaim) delete next.starts[taskId];
      if (unsentEntry) next.entries[taskId] = { ...entry, reason: "cancelled", dispatch_stopped: "plan-future-cancelled", execution: null };
      changePlanNode(plan, node.id, { status: "cancelled", retry: null, nextAt: null,
        tombstone: { operationId: runtime.token, acceptance: "unsubmitted", ...(claim?.clone ? { clone: claim.clone } : {}) } });
    }
  }
  return next;
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
    return isDeepStrictEqual(anchors, plan.runtime.anchors) ? plan : { ...plan, runtime: { ...plan.runtime, generation: plan.runtime.generation + 1, anchors } };
  });
  return { ...state, plans: { ...state.plans, instances } };
}

export function planInspection(state, operator, selector = null) {
  const visible = records(state).filter(plan => canReadPlan(operator, plan.scope) && (!selector || selector === plan.approval.graph.name || selector === plan.id));
  if (!selector) return visible.map(plan => ({ name: plan.approval.graph.name, instanceId: plan.id, status: plan.control.status }));
  if (visible.length !== 1) throw planFailure("PLAN_MISSING", "The plan is unavailable or access is not authorized.");
  const plan = visible[0], { graph, sources, graphDigest, approvalDigest, revision, structuralRevision } = plan.approval;
  const inspected = reconcilePlanAnchors(state).plans.instances.find(record => record.id === plan.id);
  const observations = new Map(inspected.runtime.anchors), anchors = new Map(plan.approval.bindings.anchors);
  const nodes = graph.nodes.map(node => {
    if (node.type === "task") {
      const runtime = planNodeRuntime(plan, node.id);
      const future = ownsSubmittedStart(state, plan, node) ? null : futureDisposition(plan, node.id);
      return { ...node, status: future ?? runtime.status ?? (plan.control.status === "active" ? "queued" : "dispatch-disabled"),
        ...(runtime.firstFailure ? { firstFailure: runtime.firstFailure } : {}),
        ...(runtime.reason ? { reason: runtime.reason } : {}) };
    }
    const pin = anchors.get(node.id);
    const grant = anchorGrants(operator, plan.scope, pin.producer.scope);
    if (!grant || grant !== pin.authorization) return { id: node.id, type: node.type, status: "producer-unavailable" };
    return { ...node, resolution: "pinned", producer: pin.producer, frozen: pin.nodes,
      observed: observations.get(node.id).map(({ id, status, pr, receipt }) => ({ id, status,
        ...(!["producer-unavailable", "review-required"].includes(status) && pr ? { pr } : {}),
        ...(status === "integrated" ? { receipt } : {}) })) };
  });
  const { incoming } = dependencyIndex(plan), projected = new Map(nodes.map(node => [node.id, node]));
  const failed = new Set(["blocked", "cancelled", "unverified", "producer-unavailable", "review-required", "merge-unqualified"]);
  // Contracts are stored in topological order. Project only immediate missing
  // receipts, propagating failure through the consumer closure without
  // changing any runtime eligibility or treating a held leaf as a success.
  for (const [id] of plan.approval.nodeContracts) {
    const node = projected.get(id);
    if (node.type !== "task" || planNodeRuntime(plan, id).token) continue;
    const missing = incoming.get(id).flatMap(from => {
      const prior = projected.get(from);
      if (prior.type === "anchor" && prior.observed) {
        if (prior.observed.every(item => item.status === "integrated")) return [];
        const status = prior.observed.find(item => failed.has(item.status))?.status ?? "waiting";
        return [{ id: from, status }];
      }
      return prior.status === "integrated" ? [] : [{ id: from, status: prior.status }];
    });
    if (missing.length) {
      node.prerequisites = missing;
      if (node.status === "queued") node.status = missing.some(item => failed.has(item.status)) ? "blocked" : "waiting-prerequisites";
    }
  }
  const retired = Object.entries(plan.runtime.nodes ?? {}).flatMap(([id, node]) =>
    !projected.has(id) && node.firstFailure ? [{ id, firstFailure: node.firstFailure }] : []);
  return { instanceId: plan.id, status: plan.control.status, graph: { ...graph, nodes }, sources, graphDigest, approvalDigest, retired,
    revision, structuralRevision, runtimeGeneration: plan.runtime.generation, controlGeneration: plan.control.generation,
    future: plan.control.future?.status ?? "open", groups: plan.control.groups ?? {} };
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
    registryVersion: Math.max(state.version, PLAN_REGISTRY_VERSION), graphVersion: state.plans?.version ?? 1, approvalDigest, chains: projections,
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
  state.version = Math.max(state.version, PLAN_REGISTRY_VERSION);
  checkPlanRegistry(state);
  return plans.migration;
}

export function checkPlanRegistry(state) {
  if (![PLAN_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION].includes(state.version) && state.plans === undefined) return;
  const plans = state.plans;
  const controlled = state.version === PLAN_CONTROL_REGISTRY_VERSION;
  if (![PLAN_REGISTRY_VERSION, DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION].includes(state.version) ||
      plans?.version !== (controlled ? PLAN_STORE_VERSION : 1) || !Array.isArray(plans.instances) ||
      plans.instances.length > MAX_PLANS || !plans.blobs || typeof plans.blobs !== "object" || Array.isArray(plans.blobs)) throw badState();
  const ids = new Set(), owners = new Set(), registered = new Set(), names = new Set(), requests = new Set();
  const validFence = fence => fence && Number.isSafeInteger(fence.generation) && fence.generation > 0 &&
    ["open", "held", "cancelled"].includes(fence.status);
  for (const record of plans.instances) {
    const { id, approval, runtime, control } = record;
    if (typeof id !== "string" || ids.has(id) || (controlled ? !Number.isSafeInteger(approval?.revision) || approval.revision < 1 : approval?.revision !== 1) ||
        approval.graph?.version !== 1 ||
        digest(approval.graph) !== approval.graphDigest || dependencyPlanApprovalDigest(approval, digest(approval.bindings)) !== approval.approvalDigest ||
        !isDeepStrictEqual(approval.bindings?.scope, record.scope) || !Array.isArray(approval.nodeContracts) ||
        !Number.isSafeInteger(runtime?.generation) || runtime.generation < 0 || !Array.isArray(runtime.anchors) ||
        !Number.isSafeInteger(control?.generation) || control.generation < 0 || !["observation-only", "active", "cancelled"].includes(control.status) ||
        (control.status === "active" || runtime.nodes) && (state.version < DISPATCH_REGISTRY_VERSION || typeof record.checkoutRoot !== "string" || !isAbsolute(record.checkoutRoot)) ||
        !requestPattern.test(record.request?.id ?? "") || !Array.isArray(approval.sources) || approval.sources.length > PLAN_LIMITS.files ||
        !Array.isArray(approval.bindings?.anchors)) throw badState();
    const groups = new Set(groupsOf(approval.graph));
    if (!controlled && (control.future || control.groups) || control.future && !validFence(control.future) ||
        Object.entries(control.groups ?? {}).some(([id, fence]) => !groups.has(id) || !validFence(fence))) throw badState();
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
    for (const node of approval.graph.nodes) {
      if (node.type !== "task") continue;
      const runtimeNode = planNodeRuntime(record, node.id), entry = state.entries[node.taskId], claim = state.starts?.[node.taskId];
      if (futureDisposition(record, node.id) === "cancelled" && !runtimeNode.token) continue;
      const binding = entry?.plan ?? claim?.plan;
      if (owners.has(node.taskId) || ((entry || claim) && (!runtimeNode.token || binding?.instanceId !== id ||
        binding.node !== node.id || runtimeNode.token !== (entry?.start_token ?? claim?.token) ||
        binding.approval !== runtimeNode.approval || binding.contract !== runtimeNode.contract))) throw badState();
      if (entry || claim) registered.add(node.taskId);
      if (runtimeNode.token && !entry && !claim && runtimeNode.tombstone?.operationId !== runtimeNode.token) throw badState();
      owners.add(node.taskId);
    }
    const contracts = approvalContracts(approval);
    if (structuralRevision(approval.graph, contracts) !== approval.structuralRevision || !isDeepStrictEqual([...contracts], approval.nodeContracts)) throw badState();
    if (approval.sources.some(({ digest: hash }) => !isPlanDigest(hash))) throw badState();
  }
  for (const owner of [state.entries, state.starts ?? {}]) {
    if (Object.entries(owner).some(([task, item]) => item.plan && !registered.has(task))) throw badState();
  }
  const referenced = referencedPlanBlobs(state);
  for (const hash of referenced) {
    const data = plans.blobs[hash];
    if (typeof data !== "string" || data.length > 4 * Math.ceil(PLAN_LIMITS.sourceBytes / 3) ||
        contentDigest(Buffer.from(data, "base64")) !== hash) throw badState();
  }
  if (referenced.size !== Object.keys(plans.blobs).length) throw badState();
  if (!controlled && plans.controls || plans.controls && !Array.isArray(plans.controls)) throw badState();
  for (const row of plans.controls ?? []) {
    const key = `${row.tenant}\0${row.requestId}`;
    if (requests.has(key) || !requestPattern.test(row.requestId) || !isPlanDigest(row.revision) || !isPlanDigest(row.command) ||
        !ids.has(row.result?.instanceId) || row.result.status !== "applied" || row.result.requestId !== row.requestId) throw badState();
    requests.add(key);
  }
  if (Object.values(state.chains ?? {}).some(chain => legacyActive(chain) && chain.steps.some(step => owners.has(step.id)))) throw badState();
}
