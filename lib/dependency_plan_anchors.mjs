import { compileLinearChain, linearNodeId } from "./dependency_plan_linear.mjs";
import { nodeContracts, structuralRevision } from "./dependency_plan_approval.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { executionLive } from "./execution_contract.mjs";
import { prdIdFromBranch } from "./git.mjs";
import { hosts } from "./hosts.mjs";
import { integrationSettlement } from "./task_completion.mjs";
import { futureDisposition, ownsSubmittedStart, planNodeRuntime } from "./dependency_plan_runtime.mjs";

export const planFailure = (code, message) => Object.assign(new Error(message), { code });
const unavailable = () => planFailure("PLAN_ANCHOR", "A producer is unavailable or the link is not authorized.");
const grantRef = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export function planScope(tenant, repositories) {
  return { tenant, repositories: [...new Set(repositories)].sort() };
}

export function scopeGrants(operator, scope, actions) {
  const grants = actions.map(action => operator?.grant({ action, scope }));
  return grants.every(grant => typeof grant === "string" && grantRef.test(grant)) ? digest(grants) : null;
}

export function anchorGrants(operator, consumer, producer) {
  const actions = ["read", "observe", "link"];
  const from = scopeGrants(operator, consumer, actions), to = scopeGrants(operator, producer, actions);
  if (!from || !to) return null;
  const cross = consumer.tenant === producer.tenant ? null : operator.grant({ action: "cross-company-link", scope: consumer, producer });
  if (consumer.tenant !== producer.tenant && (typeof cross !== "string" || !grantRef.test(cross))) return null;
  return digest([from, to, cross]);
}

export function anchorIdentity({ id, repo, base, branch, pr, url, token, createdAt }) {
  return { id, repo, base, branch, pr, url, ...(token ? { token } : {}), ...(createdAt ? { createdAt } : {}) };
}

export const matchesRegisteredPr = (anchor, entry) => !!entry &&
  ["repo", "base", "branch", "pr", "url"].every(key => entry[key] === anchor[key]) &&
  (!anchor.token || anchor.token === entry.start_token) && (!anchor.createdAt || anchor.createdAt === entry.created_at);

export function matchesLegacyNode(chain, node, entry, { matchPr = true } = {}) {
  const { step, index } = node;
  return Boolean(entry?.start_token && step.dispatch && entry.chain?.name === chain.name && entry.chain.index === index &&
    entry.chain.dispatch === step.dispatch && entry.repo === chain.repo && entry.base === chain.base &&
    prdIdFromBranch(entry.branch) === linearNodeId(step.id) && entry.checkout === step.checkout && entry.prd === step.relPath &&
    (!step.entry || step.entry.token === entry.start_token && (!matchPr || !step.entry.pr || step.entry.pr === entry.pr)));
}

export const legacyInstance = chain => chain.plan_instance ?? (chain.created_at ? `legacy-${digest([chain.name, chain.created_at])}` : null);

// Project a legacy approval without re-reading or editing its inputs. Only
// fields the legacy owner pins enter the contract. Its mutable CAS stays separate.
export function legacyPlan(chain) {
  const id = legacyInstance(chain);
  if (!id || !chain.repo || !chain.base || !Array.isArray(chain.steps) || !chain.steps.length) return null;
  const graph = compileLinearChain(chain);
  const nodes = new Map(chain.steps.map((step, index) => [linearNodeId(step.id), { step, index }]));
  const inputs = new Map([...nodes].map(([node, { step }]) => [node, {
    checkout: step.checkout, path: step.path, relPath: step.relPath, harness: step.harness,
    digest: step.digest, inputFiles: step.inputFiles, baseFiles: step.baseFiles,
  }]));
  if (chain.after) inputs.set(graph.nodes[0].id, anchorIdentity(chain.after));
  const contracts = nodeContracts(graph, inputs);
  return { id, kind: "legacy", name: chain.name, scope: planScope("local", [chain.repo]), chain, nodes,
    graph, contracts, revision: structuralRevision(graph, contracts), cancelled: chain.status === "cancelled" };
}

export function registeredPlan(record) {
  const { id, scope, approval } = record;
  return { id, kind: "graph", name: approval.graph.name, scope, graph: approval.graph, revision: approval.structuralRevision, record,
    contracts: new Map(approval.nodeContracts), cancelled: record.control.status === "cancelled" };
}

export function planCatalog(state, { tolerateUnavailable = false, maxNodes = 20_000 } = {}) {
  const current = (state.plans?.instances ?? []).map(registeredPlan);
  let nodes = current.reduce((total, plan) => total + plan.graph.nodes.length, 0);
  for (const chain of Object.values(state.chains ?? {})) {
    if (!legacyInstance(chain) || !chain.repo || !chain.base) continue;
    nodes += (chain.steps?.length ?? 0) + Number(Boolean(chain.after));
    if (nodes > maxNodes) throw planFailure("PLAN_LIMIT", "The dependency closure exceeds its admission limit.");
    let projected;
    try { projected = legacyPlan(chain); }
    catch {
      if (!tolerateUnavailable) throw planFailure("PLAN_STATE", "A saved producer cannot be projected. Reconcile the original registry before admission.");
    }
    if (projected) current.push(projected);
  }
  if (nodes > maxNodes) throw planFailure("PLAN_LIMIT", "The dependency closure exceeds its admission limit.");
  return current;
}

export function resolvePlanAnchor(catalog, operator, consumerScope, target) {
  const matches = catalog.filter(plan => plan.name === target.plan && !plan.cancelled && anchorGrants(operator, consumerScope, plan.scope));
  if (matches.length !== 1) throw unavailable();
  const producer = matches[0];
  const tasks = new Set(producer.graph.nodes.filter(node => node.type === "task").map(node => node.id));
  const boundary = target.node ? [target.node] : producer.graph.exits;
  if (!boundary.length || boundary.some(node => !tasks.has(node))) throw unavailable();
  return {
    producer: { instanceId: producer.id, structuralRevision: producer.revision, scope: producer.scope },
    nodes: boundary.map(id => ({ id, contract: producer.contracts.get(id) })),
    authorization: anchorGrants(operator, consumerScope, producer.scope),
  };
}

export function assertAnchorCurrent(producer, operator, scope, pin) {
  if (!producer || producer.cancelled || digest(producer.scope) !== digest(pin.producer.scope)) throw unavailable();
  if (anchorGrants(operator, scope, producer.scope) !== pin.authorization) throw unavailable();
  if (pin.nodes.some(node => producer.contracts.get(node.id) !== node.contract)) {
    throw planFailure("PLAN_STALE", "A pinned producer contract changed. Review the plan again.");
  }
}

function qualifiedMerge(chain, step, entry, pr) {
  const terminal = entry.completionEvidence?.terminal, merge = step.merged;
  const sha = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
  if (entry.state !== "done" || !merge || !sha(merge.sha) || merge.pr !== pr.number || terminal?.state !== "MERGED" || terminal.repository !== chain.repo ||
      terminal.pr !== pr.number || terminal.base !== chain.base || terminal.mergeCommit !== merge.sha || terminal.mergedAt !== merge.at ||
      !sha(terminal.head) || !Number.isFinite(Date.parse(terminal.mergedAt)) || integrationSettlement(entry, terminal)?.delivery !== "verified" ||
      executionLive(entry) || entry.last?.run && entry.last.exit == null) return null;
  return { repository: chain.repo, base: chain.base, number: pr.number, head: terminal.head, sha: merge.sha, at: merge.at, cleanup: entry.workspace_cleanup.status };
}

function registeredPr(entry) {
  if (!Number.isSafeInteger(entry.pr) || entry.pr < 1 || !entry.url) return null;
  try {
    const parsed = hosts.fromUrl(entry.url);
    if (parsed.repository.key === entry.repo && parsed.number === entry.pr) {
      return { number: entry.pr, url: entry.url, branch: entry.branch, repository: entry.repo, base: entry.base };
    }
  } catch { /* A saved URL without canonical PR identity is not a binding. */ }
  return null;
}

function observeLegacyNode(state, producer, id, prior = {}) {
  const { chain } = producer, node = producer.nodes.get(id);
  const { step } = node, entry = state.entries[step.id];
  const token = prior.start?.token;
  // A different start can reuse the task ID after closeout. The retained
  // observation still belongs to the original producer's recorded milestone.
  if (prior.status === "integrated" && token && entry?.start_token !== token) {
    const { receipt } = prior, { merged, entry: registration } = step;
    if (receipt && merged && step.dispatch && receipt.repository === chain.repo && receipt.base === chain.base &&
        merged.pr === receipt.number && merged.sha === receipt.sha && merged.at === receipt.at &&
        (!registration || registration.token === token && registration.pr === receipt.number)) return prior;
  }
  if (!entry) {
    if (prior.start) return { ...prior, status: "producer-unavailable" };
    return { id, status: state.starts?.[step.id]?.chain === chain.name ? "starting" : "waiting" };
  }
  if (!matchesLegacyNode(chain, node, entry) || prior.start && entry.start_token !== prior.start.token ||
      prior.pr && (entry.pr !== prior.pr.number || entry.url !== prior.pr.url || entry.branch !== prior.pr.branch)) {
    return { ...prior, id, status: "producer-unavailable" };
  }
  const execution = entry.execution?.acceptance === "accepted" ? entry.execution.operationId : entry.last?.run;
  const start = { token: entry.start_token, execution: prior.start?.execution ?? execution ?? null };
  const pr = registeredPr(entry);
  const stopped = entry.dispatch_stopped || ["cancelled", "cancellation-requested"].includes(entry.reason) ||
    entry.completionEvidence?.terminal?.state === "CLOSED";
  const receipt = !stopped && pr ? qualifiedMerge(chain, step, entry, pr) : null;
  if (receipt && prior.receipt && digest({ ...receipt, cleanup: prior.receipt.cleanup }) !== digest(prior.receipt)) {
    return { ...prior, id, status: "producer-unavailable" };
  }
  const retainedReceipt = prior.receipt ?? receipt;
  return { id, start, ...(pr ? { pr } : {}), ...(retainedReceipt ? { receipt: retainedReceipt } : {}),
    status: stopped ? "producer-unavailable" : receipt ? "integrated" : step.merged ? "merge-unqualified" : pr ? "pr-registered" :
      entry.initial_dispatch?.status === "unsubmitted" ? "starting" : "started" };
}

export function observePlanAnchor(state, producer, pin, prior = []) {
  const previous = new Map(prior.map(node => [node.id, node]));
  return pin.nodes.map(({ id, contract }) => {
    const durable = previous.get(id) ?? {};
    if (!producer || producer.kind === "legacy" && producer.cancelled || durable.status === "producer-unavailable") {
      return { ...durable, id, status: "producer-unavailable" };
    }
    if (digest(producer.scope) !== digest(pin.producer.scope) || producer.contracts.get(id) !== contract || durable.status === "review-required") {
      return { ...durable, id, status: "review-required" };
    }
    if (producer.kind === "legacy") return observeLegacyNode(state, producer, id, durable);
    const node = planNodeRuntime(producer.record, id);
    if (node.receipt && node.status === "integrated") {
      const { receipt } = node;
      return { id, status: "integrated", start: { token: node.token }, receipt,
        pr: { number: receipt.number, url: receipt.url, branch: receipt.branch, repository: receipt.repository, base: receipt.base } };
    }
    const leaf = producer.graph.nodes.find(node => node.id === id);
    const future = leaf && !ownsSubmittedStart(state, producer.record, leaf) && futureDisposition(producer.record, id);
    return { id, status: future || node.status || "waiting" };
  });
}
