import { isDeepStrictEqual } from "node:util";
import { anchorGrants, canReadPlan, planScope, legacyInstance, scopeGrants } from "../dependency_plan_anchors.mjs";
import { planOperator } from "../operator_intent.mjs";
import { repoNames } from "../config.mjs";
import { selectPlanControl } from "../dependency_plan_registry.mjs";
import { makeRecoveryCooldowns, providerScope } from "../recovery_cooldown.mjs";

export function factoryRecords(state) {
  return state.workspaceRecords?.() ?? state.load?.() ?? {
    entries: Object.fromEntries(state.entries()), chains: Object.fromEntries(state.chains?.() ?? []),
  };
}

/** Select records before projecting or resolving any caller-supplied identifiers. */
export function factoryAccess(saved, { operator = null, protectedReads = false } = {}) {
  const graphPlans = new Map((saved.plans?.instances ?? []).map(plan => [plan.id, plan]));
  const plans = [...graphPlans.values()].filter(plan => canReadPlan(operator, plan.scope));
  const visible = new Set(plans.map(plan => plan.id));
  const repositoryAccess = new Map();
  const localRepository = repo => {
    if (!protectedReads) return true;
    if (!repositoryAccess.has(repo)) {
      repositoryAccess.set(repo, Boolean(repo && canReadPlan(operator, planScope("local", [repo]))));
    }
    return repositoryAccess.get(repo);
  };
  const savedEntries = saved.entries ?? {}, starts = saved.starts ?? {};
  const entries = new Map(Object.entries(savedEntries).filter(([, entry]) =>
    entry.plan ? visible.has(entry.plan.instanceId) : localRepository(entry.repo)));
  const chains = new Map(Object.entries(saved.chains ?? {}).filter(([, chain]) => localRepository(chain.repo)));
  const legacyIds = new Set([...chains.values()].map(legacyInstance));
  const legacyScopes = new Map(Object.values(saved.chains ?? {}).filter(chain => chain.repo)
    .map(chain => [legacyInstance(chain), planScope("local", [chain.repo])]));
  const localAnchor = anchor => localRepository(anchor.repo) &&
    (!Object.hasOwn(savedEntries, anchor.id) || entries.has(anchor.id));
  const canReadAuthor = slot => {
    if (!protectedReads) return true;
    if (Object.hasOwn(savedEntries, slot.id)) return entries.has(slot.id);
    const claim = Object.hasOwn(starts, slot.id) && starts[slot.id];
    if (!claim || (claim.repo != null && claim.repo !== slot.repo) || (slot.token !== undefined && slot.token !== claim.token)) return false;
    if (slot.graph || claim.plan) {
      const instanceId = claim.plan?.instanceId;
      return visible.has(instanceId) && (slot.token === undefined || instanceId === slot.plan);
    }
    return localRepository(slot.repo);
  };
  const canReadAnchor = (plan, pin) => {
    if (!pin?.authorization || !pin.nodes?.length) return false;
    const id = pin.producer.instanceId;
    const scope = graphPlans.get(id)?.scope ?? legacyScopes.get(id);
    return isDeepStrictEqual(scope, pin.producer.scope) && anchorGrants(operator, plan.scope, scope) === pin.authorization;
  };
  const allowsLocal = (repo, action, target) => localRepository(repo) &&
    (!protectedReads || Boolean(scopeGrants(operator, { ...planScope("local", [repo]), ...target }, ["read", action])));
  return {
    saved, plans, chains, entries, localRepository, localAnchor, canReadAnchor, canReadAuthor, operator,
    canOpenPlan: id => visible.has(id) || legacyIds.has(id),
    chainControl: (chain, action) => allowsLocal(chain.repo, `chain/${action}`, { chain: chain.name }),
    planControl: (plan, action, target) => {
      if (!visible.has(plan)) return false;
      try { selectPlanControl(saved, operator, { plan, action, ...target }); return true; }
      catch { return false; }
    },
    taskControl: (id, entry, action) => {
      if (!entry.plan) return allowsLocal(entry.repo, `task/${action}`, { task: id });
      if (!visible.has(entry.plan.instanceId)) return false;
      try {
        selectPlanControl(saved, operator, { plan: entry.plan.instanceId, node: entry.plan.node, action: `task/${action}` });
        return true;
      } catch { return false; }
    },
    protectedReads,
  };
}

export function requestFactoryAccess(ctx, req) {
  const protectedReads = typeof ctx.planOperatorForRequest === "function";
  let operator = null;
  if (protectedReads) {
    try { operator = planOperator(ctx.state.file, ctx.planOperatorForRequest(req)); }
    catch { /* Missing or expired authority grants no access to protected records. */ }
  }
  return factoryAccess(factoryRecords(ctx.state), { operator, protectedReads });
}

export function factoryObservations(ctx, access, { planId } = {}) {
  const clock = ctx.clock || Date;
  const scopes = new Set(access.plans.filter(plan => planId === undefined || planId === plan.id).flatMap(plan => plan.approval.bindings.tasks.map(([, task]) =>
    providerScope(task.route.harness, task.route.account))));
  let cooldowns, cooldownsUnavailable = false;
  try { if (scopes.size) cooldowns = makeRecoveryCooldowns({ home: ctx.home, clock }).observations(scopes); }
  catch { cooldownsUnavailable = true; }
  return { config: ctx.config, now: clock.now(), cooldowns, cooldownsUnavailable };
}

/** Keep legacy detail, history and diagnostics behind the same read boundary. */
export function scopedTracker(ctx, access) {
  const chains = new Map([...access.chains].map(([id, chain]) => [
    id, chain.after && !access.localAnchor(chain.after) ? { ...chain, after: null, reason: null } : chain,
  ]));
  const entry = id => access.entries.get(id) ?? null;
  return {
    ...ctx,
    config: access.protectedReads ? { ...ctx.config, harness: {}, repos: repoNames(ctx.config).filter(access.localRepository) } : ctx.config,
    log: { ...ctx.log, latest: () => null },
    ...(access.protectedReads ? { runSources: [], collaboration: null } : {}),
    state: {
      ...ctx.state, get: entry, entries: () => [...access.entries],
      getChain: id => chains.get(id) ?? null, chains: () => [...chains],
      reviewActivityEntry: id => entry(id) && (ctx.state.reviewActivityEntry?.(id) ?? entry(id)),
    },
  };
}
