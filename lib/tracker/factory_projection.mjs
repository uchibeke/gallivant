import { legacyPlan, matchesLegacyNode, registeredPlan } from "../dependency_plan_anchors.mjs";
import { anchorIntegration, dependencyIndex, futureDisposition, nodeIntegration, ownsSubmittedStart, planNodeHolds, planNodeRuntime } from "../dependency_plan_runtime.mjs";
import { dispatchCapacity, liveAuthor } from "../dispatch_capacity.mjs";
import { preparationCost } from "../task_allowance.mjs";
import { providerScope } from "../recovery_cooldown.mjs";
import { qualifiedIdLength } from "../dependency_plan_limits.mjs";
import { executionCapabilities } from "../capabilities.mjs";
import { controlPending } from "../control_contract.mjs";
import { redact } from "../execution_io.mjs";
import { taskPresentation, OUTCOMES } from "./presentation.mjs";
import { instant } from "./presentation_time.mjs";
import { chainFileLabel } from "./chain_controls.mjs";
import { safeLink } from "./links.mjs";

export const FACTORY_VERSION = 1;
export const PLAN_PAGE_SIZE = 20, NODE_PAGE_SIZE = 25, PREREQUISITE_PAGE_SIZE = 20;
const caps = new Map(executionCapabilities().map(cap => [cap.name, cap]));
const latest = (...times) => times.map(instant).filter(Boolean).sort().at(-1) ?? null;
const amount = value => Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) ? amount(value) : null;
const tri = value => typeof value === "boolean" ? value : null;
const ref = value => typeof value === "string" && value.length <= qualifiedIdLength && /^[\w./:@~+-]+$/.test(value) &&
  !value.startsWith("/") && redact(value) === value ? value : null;
export const factoryNote = value => typeof value === "string" ? redact(value)
  .replace(/(^|[\s("'=])(?:\/[^\s"')]+|[A-Z]:[\\/][^\s"')]+)/gi, "$1[protected path]").slice(0, 256) : null;
const hash = value => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;
const title = id => id.split("/").at(-1);
const selectOffset = (value, size) => Math.floor((count(Number(value)) ?? 0) / size) * size;
const counts = rows => {
  const result = Object.fromEntries(OUTCOMES.map(([status]) => [status, 0]));
  for (const row of rows) result[row.status]++;
  return result;
};

export function compareRecent(a, b) {
  return (b.times.meaningful.at ?? "").localeCompare(a.times.meaningful.at ?? "") || a.id.localeCompare(b.id);
}

export function factoryTimes({ now, meaningful, observed, recovery, staleAfter = 360_000 }) {
  const age = value => {
    const at = instant(value);
    return { at, ageMs: at && Number.isFinite(now) ? Math.max(0, now - Date.parse(at)) : null };
  };
  const observation = age(observed);
  return { meaningful: age(meaningful), observed: observation, recovery: age(recovery),
    freshness: observation.ageMs == null ? "unknown" : observation.ageMs > staleAfter ? "stale" : "recorded" };
}

const projectedCapability = (name, route) => {
  const cap = caps.get(name);
  return { source: route ? "plan.approval.bindings.tasks.route" : cap ? "executionCapabilities" : null,
    harness: ref(name), provider: ref(route?.provider), model: ref(route?.model), transport: ref(route?.transport ?? cap?.transport),
    dispatch: (route?.routeAvailable ?? cap?.available) === false ? "unsupported" : "unknown",
    qualification: cap?.liveQualified === true ? "qualified" : cap ? "unvalidated" : "unknown",
    inference: "unknown", providerPerRunCap: tri(route?.providerPerRunCap ?? cap?.cost?.hardCap) };
};
const evidence = receipt => receipt ? { source: "integration-receipt", head: hash(receipt.head), merge: hash(receipt.sha),
  at: instant(receipt.at), cleanup: ref(receipt.cleanup), pr: count(receipt.number ?? receipt.pr), url: safeLink(receipt.url) } : null;
const statusOfPrerequisite = row => row?.status === "integrated" ? "unverified" : row?.phase.id === "held" ? "held" : row?.status ?? "missing";
const failedPrerequisite = new Set(["blocked", "cancelled", "closed-unmerged", "unavailable", "unverified", "review-required", "merge-unqualified"]);

function plannedPhase(id, label, nextAction, group = "waiting") {
  const actor = group === "attention" ? "operator" : group === "ended" ? "none" : "coordinator";
  return { phase: { id, label, source: "plan.saved-state" }, actor,
    attention: { group, actor, title: label, explanation: nextAction, nextAction, priority: 4, source: "plan.saved-state" } };
}
const merged = () => plannedPhase("integrated", "Integrated", "The saved integration receipt is recorded.", "ended");
const cancelled = () => plannedPhase("cancelled", "Future dispatch cancelled", "The saved plan fences future dispatch.", "ended");

const savedRun = entry => entry?.last?.run ? { id: entry.last.run, exit: entry.last.exit, execution: entry.execution } : null;

function projectTask({ id, node = null, plan = null, entry = null, intake = null, binding, limits, runtime, mode, p, now, staleAfter, cooldowns }) {
  const harness = binding?.route?.harness ?? entry?.harness ?? intake?.harness ?? null;
  const repository = node?.repository ?? entry?.repo ?? intake?.repo;
  const base = node?.base ?? entry?.base ?? intake?.base;
  const knownIntake = intake && { status: intake.status, repo: intake.repo, base: intake.base, taskId: intake.id, errorCode: intake.errorCode };
  p ??= taskPresentation({ id, entry, task: knownIntake, run: savedRun(entry), maxIterations: limits?.maxIterations, now, capabilities: caps.get(harness) });
  const receipt = evidence(runtime?.receipt);
  let status = p.outcome, presentation = p;
  if (mode) {
    if (mode === "integrated") { status = "integrated"; presentation = merged(); }
    else if (mode === "cancelled") { status = "cancelled"; presentation = cancelled(); }
    else if (mode === "held") {
      status = "blocked"; presentation = plannedPhase("held", "Future dispatch held", "Review the saved hold with the operator.", "attention");
    } else if (mode === "blocked") {
      status = "blocked"; presentation = plannedPhase("operator_attention", "Dispatch blocked", factoryNote(runtime.reason) || "Inspect the saved dispatch prerequisite.", "attention");
    } else if (mode === "starting") {
      status = "active"; presentation = plannedPhase("reconciling", "Start reserved", "Wait for the original start to settle.");
    } else if (mode === "unverified" && !["closed-unmerged", "cancelled"].includes(p.outcome)) {
      status = "unknown"; presentation = plannedPhase("unknown", "Integration unverified", "Inspect the saved closeout and delivery evidence.");
    } else if (mode === "planned") {
      status = "planned"; presentation = plannedPhase("planned", "Planned", "Wait for the coordinator to check dispatch prerequisites.");
    }
  }
  const meaningful = latest(receipt?.at, p.activity.at, intake?.createdAt);
  const first = p.recovery.incidents[0];
  const deferred = binding?.route && cooldowns?.get(providerScope(harness, binding.route.account));
  const cooldownAt = deferred?.nextAt > now ? instant(deferred.nextAt) : null;
  const nextAt = latest(p.recovery.nextAt, runtime?.nextAt, cooldownAt);
  const retryAt = latest(p.retryAt, runtime?.status === "queued" ? runtime.nextAt : null, cooldownAt);
  const cost = Array.isArray(intake?.attempts) ? preparationCost(intake.attempts) : null;
  const rounds = { ...p.rounds, limit: count(limits?.maxIterations) ?? p.rounds.limit };
  return { version: FACTORY_VERSION, id, title: title(node?.id ?? id), type: "task", status, phase: presentation.phase,
    attention: { ...presentation.attention, actor: presentation.attention.actor ?? presentation.actor },
    repository: ref(repository), base: ref(base), harness: ref(harness), registered: Boolean(entry), intake: intake ? ref(intake.status) : null,
    workerEnded: Number.isInteger(entry?.last?.exit),
    plan: plan ? { id: plan.id, name: plan.name, node: node.id, kind: plan.kind } : null,
    times: factoryTimes({ now, staleAfter, meaningful, observed: latest(p.freshness.observedAt, receipt?.at, runtime?.observedAt, intake?.updatedAt),
      recovery: latest(p.recovery.recoveryAt, runtime?.firstFailureAt) }),
    recovery: { classification: p.recovery.classification, step: p.recovery.step,
      original: runtime?.firstFailure ? { detail: factoryNote(runtime.firstFailure), at: instant(runtime.firstFailureAt), source: "plan.runtime.firstFailure" }
        : first ? { id: first.id, detail: first.cause, at: first.at, source: first.evidence } : null,
      nextAt, retryAt, cooldownAt, attempts: p.recovery.attempts, retryAttempts: p.recovery.retryAttempts,
      profile: p.recovery.profileDigest, resource: p.recovery.resource },
    budget: { rounds, cumulativeRecoveryAttempts: p.recovery.attempts, costUsd: entry ? null : amount(cost?.usd),
      costStatus: entry ? "unknown" : cost?.status ?? "unknown", preparationCost: cost ? { usd: amount(cost.usd), status: cost.status } : null,
      perRunAllowanceUsd: amount(limits?.maxBudgetUsd), preparationAllowanceUsd: amount(intake?.allowance?.budgetUsd),
      implementationAllowanceUsd: amount(entry?.task?.deliveryAllowance?.budgetUsd), runtimeAllowanceMs: amount(entry?.task?.deliveryAllowance?.runtimeMs) },
    capability: projectedCapability(harness, binding?.route),
    delivery: { status: p.readiness.status, target: plan ? "integrated" : p.delivery.target, acceptance: p.acceptance.status,
      pr: p.delivery.pr ?? receipt?.pr ?? null, url: safeLink(entry?.url) ?? receipt?.url ?? null,
      obligations: p.ownerDelivery.obligations.map(o => ({ kind: o.kind, status: o.status, head: o.head, observedAt: o.observedAt })) },
    evidence: { integration: receipt, checks: p.checks, review: p.review, acceptance: p.acceptance,
      run: ref(entry?.last?.run), operation: ref(entry?.execution?.operationId), approval: hash(runtime?.approval),
      inputRevision: count(intake?.revision), input: hash(intake?.draft?.hash ?? entry?.prd_fingerprint),
      sourceState: ref(binding?.readiness?.status ?? intake?.readiness?.status), reviewPolicy: ref(entry?.reviewPolicy?.mode) },
    request: entry?.control ? { id: ref(entry.control.id), status: ref(entry.control.status), action: ref(entry.control.action), pending: controlPending(entry.control) } : null,
    presentation: { ...p, ...presentation, rounds, outcome: status },
  };
}

function legacyEntry(plan, node, entry) {
  if (!entry || entry.plan) return null;
  if (matchesLegacyNode(plan.chain, node, entry)) return entry;
  // Historical linear records may predate start and chain bindings. Require the
  // old step's saved dispatch and matching registration rather than a loose ID.
  const { step } = node;
  return step.dispatch && !entry.chain && entry.repo === plan.chain.repo && entry.base === plan.chain.base &&
    (!step.entry?.token || step.entry.token === entry.start_token) && (!step.entry?.pr || entry.pr === step.entry.pr) ? entry : null;
}

function planRows(plan, access, options) {
  const legacy = plan.kind === "legacy", c = plan.chain, r = plan.record;
  const bindings = new Map(r?.approval.bindings.tasks);
  const limits = r?.approval.bindings.limits ?? options.limits;
  const index = r ? dependencyIndex(r) : dependencyIndex({ approval: { graph: plan.graph, bindings: { anchors: [] } }, runtime: { anchors: [] } });
  const rows = new Map();
  for (const node of plan.graph.nodes) {
    if (node.type === "anchor") continue;
    const old = legacy ? plan.nodes.get(node.id) : null;
    const runtime = legacy ? { receipt: old.step.merged, reason: old.index === c.index && (!c.after || access.localAnchor(c.after)) ? c.reason : null, nextAt: c.rateLimitUntil,
      observedAt: c.updated_at } : planNodeRuntime(r, node.id);
    const savedEntry = access.entries.get(node.taskId);
    const entry = legacy ? legacyEntry(plan, old, savedEntry) : savedEntry?.plan?.instanceId === plan.id &&
      savedEntry.plan.node === node.id && savedEntry.start_token === runtime.token ? savedEntry : null;
    const fence = legacy ? !entry && !old.step.dispatch && c.status === "cancelled" ? "cancelled" : null
      : ownsSubmittedStart(access.saved, r, node) ? null : futureDisposition(r, node.id) ??
        (!runtime.token && planNodeHolds(access.saved, r, node).some(hold => hold.active) ? "held" : null);
    const receipt = legacy ? old.step.merged : nodeIntegration(runtime);
    const mode = receipt ? "integrated" : fence ?? (entry ? runtime.status === "unverified" ? "unverified" : null
      : legacy && c.status === "stopped" && old.index === c.index || runtime.status === "blocked" ? "blocked"
      : runtime.token || old?.step.dispatch ? "starting" : runtime.status === "cancelled" ? "cancelled"
      : c?.status === "done" ? "unverified" : "planned");
    const row = projectTask({ ...options, id: node.taskId, node, plan, entry, p: entry ? options.savedPresentations.get(node.taskId) : null,
      binding: bindings.get(node.id), limits, mode,
      runtime: { ...runtime, receipt } });
    // An ended entry may have a qualified delivery before the graph owner has
    // observed and saved its own exact dependency receipt.
    if (!receipt && row.status === "integrated") {
      const pending = plannedPhase("reconciling", "Awaiting integration receipt", "Wait for the plan owner to record the exact integration receipt.");
      Object.assign(row, pending, { status: "unknown", presentation: { ...row.presentation, ...pending, outcome: "unknown" } });
    }
    if (old) Object.assign(row, { index: old.index, gateReason: factoryNote(runtime.reason), brief: chainFileLabel(old.step.relPath),
      files: Object.keys(old.step.baseFiles ?? {}).slice(0, 32).map(chainFileLabel), fingerprint: hash(old.step.digest) });
    rows.set(node.id, row);
  }

  const anchors = new Map();
  for (const node of plan.graph.nodes.filter(n => n.type === "anchor")) {
    if (legacy) {
      const anchor = c.after, allowed = access.localAnchor(anchor);
      anchors.set(node.id, { type: "anchor", id: node.id, status: allowed ? anchor.merged ? "integrated" : "waiting" : "unavailable",
        ...(allowed ? { taskId: ref(anchor.id), pr: count(anchor.pr), url: safeLink(anchor.url), receipt: evidence(anchor.merged) } : {}) });
      continue;
    }
    const pin = index.anchors.get(node.id);
    if (!access.canReadAnchor(r, pin)) {
      anchors.set(node.id, { type: "anchor", id: node.id, status: "unavailable" });
      continue;
    }
    const observed = index.observed.get(node.id), matching = observed?.length === pin.nodes.length;
    const targets = pin.nodes.map((target, i) => {
      const observation = matching && observed[i]?.id === target.id ? observed[i] : null;
      const receipt = anchorIntegration(pin, observed, i);
      return { id: target.id, contract: hash(target.contract),
        status: receipt ? "integrated" : observation?.status === "integrated" ? "unverified" : ref(observation?.status) ?? "missing",
        receipt: evidence(receipt) };
    });
    const pending = targets.filter(t => t.status !== "integrated");
    anchors.set(node.id, { type: "anchor", id: node.id, status: pending.length ? "waiting" : "integrated",
      producer: { id: ref(pin.producer.instanceId), revision: hash(pin.producer.structuralRevision), linkable: access.canOpenPlan(pin.producer.instanceId) },
      blocked: pending.some(t => failedPrerequisite.has(t.status) || t.status === "producer-unavailable"),
      targetCount: targets.length, blockerCount: pending.length, targets });
  }

  // The approval contracts are topologically ordered. Use the same receipt
  // predicates as dispatch, while leaving all current eligibility to its owner.
  const order = legacy ? [...rows.keys()] : [...plan.contracts.keys()];
  for (const id of order) {
    const row = rows.get(id);
    if (!row) continue;
    row.dependencies = (index.incoming.get(id) ?? []).map(from => {
      const prior = rows.get(from), anchor = anchors.get(from);
      if (anchor) return anchor;
      const receipt = legacy ? prior?.evidence.integration : evidence(nodeIntegration(planNodeRuntime(r, from)));
      return { id: from, status: receipt ? "integrated" : statusOfPrerequisite(prior), receipt };
    });
    const blockers = row.dependencies.filter(d => d.status !== "integrated");
    row.prerequisiteCount = row.dependencies.reduce((total, d) => total + (d.targetCount ?? 1), 0);
    row.blockerCount = blockers.reduce((total, d) => total + (d.blockerCount ?? 1), 0);
    if (blockers.some(d => d.status === "unavailable") && !row.registered) {
      if (row.recovery.original?.source === "plan.runtime.firstFailure") row.recovery.original = null;
      if (row.status === "blocked") {
        const p = plannedPhase("operator_attention", "Dispatch blocked", "A prerequisite is unavailable within this workspace scope.", "attention");
        Object.assign(row, p, { presentation: { ...row.presentation, ...p } });
      }
    }
    if (row.status === "planned" && blockers.length) {
      const stopped = blockers.some(d => d.blocked || failedPrerequisite.has(d.status));
      const p = plannedPhase("waiting_prerequisites", "Waiting on prerequisites",
        "Inspect the saved prerequisite receipts in the plan.", stopped ? "attention" : "waiting");
      if (stopped) row.status = "blocked";
      Object.assign(row, p, { presentation: { ...row.presentation, ...p, outcome: row.status } });
    }
    row.dispatch = row.registered || row.status !== "planned" && row.status !== "blocked" ? null :
      blockers.length ? "waiting-prerequisites" : row.status === "blocked" ? "held-or-blocked" :
        !legacy && r.control.status === "observation-only" ? "dispatch-disabled" :
          row.recovery.retryAt ? "cooldown" : "prerequisites-recorded";
  }
  return { rows: [...rows.values()], anchors: [...anchors.values()] };
}

export function factoryCatalog(access, { now = Date.now(), config = {}, intakes = [], intakeUnavailable = false,
  cooldowns = null, cooldownsUnavailable = false, taskRows = [] } = {}) {
  const staleAfter = Math.max(30_000, (config.poll_seconds ?? 120) * 3000);
  const options = { now, staleAfter, cooldowns, limits: { maxIterations: config.max_iterations, maxBudgetUsd: config.max_budget_usd },
    savedPresentations: new Map(taskRows.map(row => [row.id, row.presentation])) };
  const plans = [], owned = new Set();
  const inputs = access.plans.map(registeredPlan);
  let partial = intakeUnavailable || cooldownsUnavailable;
  for (const c of access.chains.values()) {
    try {
      const plan = legacyPlan(c, { readOnly: true });
      if (plan) inputs.push(plan); else partial = true;
    } catch { partial = true; }
  }
  for (const plan of inputs) {
    const { rows, anchors } = planRows(plan, access, options);
    const r = plan.record, c = plan.chain;
    const active = rows.filter(n => n.status === "active");
    for (const row of rows) if (row.registered) owned.add(row.id);
    const planCounts = counts(rows);
    const limits = r?.approval.bindings.limits;
    const byActivity = rows.slice().sort(compareRecent);
    plans.push({ version: FACTORY_VERSION, id: plan.id, name: plan.name, kind: plan.kind, lifecycle: r?.control.status ?? c.status,
      counts: planCounts, total: rows.length, activeCount: active.length,
      attention: rows.some(n => n.attention.group === "attention") ? "attention" : active.length ? "progressing" : planCounts.ready ? "ready" : "waiting",
      times: factoryTimes({ now, staleAfter, meaningful: latest(byActivity[0]?.times.meaningful.at, c?.created_at, r?.admittedAt),
        observed: latest(c?.updated_at, ...rows.map(row => row.times.observed.at)),
        recovery: latest(...rows.map(row => row.times.recovery.at)) }),
      repositories: [...new Set(rows.map(n => n.repository).filter(Boolean))].sort(),
      revision: count(r?.approval.revision), approval: hash(r?.approval.approvalDigest),
      structure: hash(plan.revision), generation: r?.runtime.generation ?? null,
      capacity: { approvedParallel: count(limits?.maxLiveGraphAuthors), approvedPerRepository: count(limits?.maxGraphAuthorsPerRepository) },
      rows, anchors, active, preferred: c ? rows[Math.min(c.index, rows.length - 1)]?.plan.node :
        rows.find(n => n.dispatch === "prerequisites-recorded" || n.status === "active")?.plan.node ?? rows[0]?.plan.node,
    });
  }
  const intakeById = new Map(intakes.filter(intake => access.localRepository(intake.repo)).map(intake => [intake.id, intake]));
  const tasks = [];
  for (const plan of plans) {
    // An unbound historical leaf stays in its plan. The task index prefers a
    // real registration whenever the same identity has been used again.
    for (const row of plan.rows) {
      if (row.registered || !access.entries.has(row.id) && (plan.lifecycle !== "done" || row.status === "integrated")) tasks.push(row);
    }
  }
  for (const [id, entry] of access.entries) {
    if (owned.has(id)) continue;
    const intake = intakeById.get(entry.task?.id);
    tasks.push(projectTask({ ...options, id, entry, intake: intake?.implementation?.id === id ? intake : null,
      p: options.savedPresentations.get(id) }));
  }
  for (const intake of intakeById.values()) {
    if (!intake.implementation) tasks.push(projectTask({ ...options, id: intake.id, intake }));
  }
  return { version: FACTORY_VERSION, snapshotAt: instant(now), plans, tasks, partial,
    permissions: access.protectedReads ? "scoped" : "local" };
}

export function factoryTaskSummary(row) {
  const { presentation, dependencies, ...value } = row;
  return value;
}

function prerequisitePage(dependencies, offset) {
  const page = [];
  for (const d of dependencies) {
    const length = d.targets?.length ?? 1;
    if (offset >= length) { offset -= length; continue; }
    const remaining = PREREQUISITE_PAGE_SIZE - page.length;
    if (d.targets) {
      page.push(...d.targets.slice(offset, offset + remaining).map(target =>
        ({ id: d.id, target: target.id, contract: target.contract, status: target.status, receipt: target.receipt })));
    } else {
      page.push({ id: d.id, status: d.status, receipt: d.receipt ?? null });
    }
    offset = 0;
    if (page.length === PREREQUISITE_PAGE_SIZE) break;
  }
  return page;
}

export function planWindow(catalog, { plan, node, milestone, pq, ps, sort, co, mo, po } = {}, { legacyOnly = false } = {}) {
  const all = legacyOnly ? catalog.plans.filter(p => p.kind === "legacy") : catalog.plans;
  const q = pq?.toLowerCase();
  const matches = all.filter(p => (!ps || (legacyOnly ? p.lifecycle === ps :
    ps.startsWith("lifecycle:") ? p.lifecycle === ps.slice("lifecycle:".length) : p.counts[ps] > 0)) &&
    (!q || [p.name, ...p.repositories].some(v => v.toLowerCase().includes(q)) ||
      p.rows.some(n => [n.id, n.plan.node, n.status, n.attention.nextAction].some(v => v?.toLowerCase().includes(q)))));
  matches.sort((a, b) => (sort === "attention" ? Number(b.attention === "attention") - Number(a.attention === "attention") : 0) || compareRecent(a, b));
  const start = selectOffset(co, PLAN_PAGE_SIZE), page = matches.slice(start, start + PLAN_PAGE_SIZE);
  const selected = plan ? all.find(p => plan === p.id || plan === p.name) : page[0];
  const summary = p => {
    const { rows, anchors, active, preferred, repositories, ...value } = p;
    return { ...value, repositories: repositories.slice(0, 20), repositoryCount: repositories.length };
  };
  let detail = null;
  if (selected) {
    const nodes = [...selected.rows, ...selected.anchors];
    const selectedNode = nodes.find(n => node ? n.plan?.node === node || n.type === "anchor" && n.id === node
      : milestone && selected.kind === "legacy" ? n.type === "task" && n.id === milestone : n.plan?.node === selected.preferred);
    const displayed = legacyOnly ? selected.rows : nodes;
    const index = displayed.indexOf(selectedNode);
    const offset = selectOffset(mo ?? Math.max(0, index), NODE_PAGE_SIZE);
    const dependencyOffset = selectOffset(po, PREREQUISITE_PAGE_SIZE);
    const publicNode = n => {
      if (n.type === "task") return factoryTaskSummary(n);
      const { targets, blocked, ...value } = n;
      return value;
    };
    detail = { ...summary(selected), outsideFilters: !matches.includes(selected), missingNode: Boolean((node || milestone) && !selectedNode),
      active: selected.active.slice(0, NODE_PAGE_SIZE).map(n => n.plan.node),
      nodes: displayed.slice(offset, offset + NODE_PAGE_SIZE).map(publicNode), nodeCount: displayed.length, offset,
      selected: selectedNode ? { ...publicNode(selectedNode), dependencies: selectedNode.type === "task"
        ? prerequisitePage(selectedNode.dependencies, dependencyOffset) : selectedNode.targets?.slice(dependencyOffset, dependencyOffset + PREREQUISITE_PAGE_SIZE) ?? [],
        dependencyOffset, dependencyCount: selectedNode.prerequisiteCount ?? selectedNode.targetCount ?? 0 } : null };
  }
  return { version: catalog.version, snapshotAt: catalog.snapshotAt, permissions: catalog.permissions, partial: catalog.partial,
    rows: page.map(summary), total: all.length, matched: matches.length, offset: start, next: start + PLAN_PAGE_SIZE < matches.length ? start + PLAN_PAGE_SIZE : null,
    missingPlan: Boolean(plan && !selected), detail };
}

export function capacityProjection(access, config) {
  const slots = access.saved.dispatch?.authors;
  const ours = Object.entries(slots ?? {}).filter(([id]) => access.entries.has(id)).map(([, slot]) => slot);
  return { authorLimit: access.protectedReads ? null : count(dispatchCapacity(config).authors),
    activeAuthors: access.entries.size ? [...access.entries].filter(([id, entry]) => Object.hasOwn(slots ?? {}, id) || liveAuthor(entry)).length : 0,
    preparations: slots ? ours.filter(s => s.preparing).length : null, scope: access.protectedReads ? "visible tasks" : "recorded tasks",
    source: "dispatch registry / task ownership" };
}
