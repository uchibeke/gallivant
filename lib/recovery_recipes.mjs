// Called by the task owner. Only closed recipe handlers know how to perform
// an effect. This module binds their reservations to the protected registry.
import { recoveryDigest as hash } from "./recovery_digest.mjs";
import { recoveryRecipes, recoveryBinding, recoveryScopes, inspectRecoveryAdmission, validateRecoveryProfile } from "./recovery_authority.mjs";
import { turnBinding } from "./recovery_preflight.mjs";
import { executionRunner } from "./execution.mjs";
import { parsePrd } from "./prd.mjs";
import { controlPending } from "./control_contract.mjs";

const stop = message => { throw Object.assign(new Error(message), { code: "RECOVERY_AUTHORITY" }); };
export function recoveryHeld(registry, id, entry) {
  const profile = registry.recovery?.profiles?.find(p => p.digest === entry.recovery_profile?.digest);
  const scopes = [`task/${id}`, `repo/${entry.repo}`, ...(profile ? [`profile/${profile.id}`] : [])];
  return entry.dispatch_stopped || entry.repository_disabled || entry.hold?.active || controlPending(entry.control) ||
    scopes.some(scope => registry.recovery?.holds?.[scope]?.active);
}

const zero = () => ({ mutations: 0, paidTurns: 0, spendMicros: 0 });
const add = (total, cost) => Object.fromEntries(Object.keys(cost).map(k => [k, total[k] + cost[k]]));
const within = (cost, limit) => Object.keys(cost).every(k => Number.isSafeInteger(cost[k]) && cost[k] >= 0 && cost[k] <= limit[k]);

// Semantic repair is reserved for a separately admitted owner. Checking this
// ceiling grants no authority to run one.
export function incidentMutationAllowed(finding, kind) {
  if (kind === "provider-window") return true;
  if (kind === "semantic") return (finding.semanticRepairs ?? 0) < 1;
  return kind === "deterministic" && (finding.mutations ?? 0) < 2;
}

// The finding anchor excludes head, provider run, recipe and wall clock. The
// separate intent includes the exact input and prior owner. A replay of the
// intent cannot allocate a replacement operation or replenish its allowance.
export function planRecovery(ctx, id, recipe, { cause, input, routeDigest, spendMicros = 0, paid = true }) {
  const clock = ctx.clock ?? Date;
  const read = () => {
    const registry = ctx.state.load(), entry = registry.entries[id];
    const profile = validateRecoveryProfile(registry.recovery?.profiles?.find(p => p.digest === entry?.recovery_profile?.digest));
    const matches = profile.routes.filter(r => routeDigest ? hash(r) === routeDigest :
      r.capabilities.includes(recoveryRecipes[recipe][0]) && r.harness ===
        (recipe === "review-output-retry" ? entry.reviewPolicy?.route?.name : entry.harness));
    const route = matches.length === 1 && matches[0];
    if (!route || !profile.recipes.some(r => r.id === recipe)) stop("Select an approved recovery recipe and exact route.");
    const observed = executionRunner(ctx, id).current();
    const run = reservedOperation && observed?.execution?.operationId === reservedOperation &&
      observed.execution.previousOperationId === priorRun?.execution.operationId &&
      observed.execution.recoveryIntent === key && observed.execution.acceptance === "unknown" ? priorRun : observed;
    const snapshot = turnBinding(ctx, id, entry, parsePrd(ctx.readPrd(id), id));
    const holds = recoveryScopes(id, entry, profile).map(scope => registry.recovery.holds[scope] ?? null);
    const expected = recoveryBinding(id, entry, run, snapshot, profile, route, holds);
    return { registry, entry, profile, route, run, snapshot, expected };
  };
  let reservedOperation = null, priorRun = null;
  const initial = read(), { entry, expected } = initial;
  const incident = hash([id, entry.task?.revision, entry.prd_fingerprint, entry.sources_digest, cause]);
  const key = hash([recipe, incident, expected, input, entry.execution_epoch ?? 0, entry.pr, entry.worktree]);
  priorRun = initial.run;
  const cost = { mutations: Number(paid), paidTurns: Number(paid), spendMicros };
  const [action, postcondition] = recoveryRecipes[recipe];
  const decision = { version: 1, recipe, recipeVersion: 1, action, postcondition, expected, operationKey: key,
    purpose: "recovery", manifest: null, authority: "admitted-recovery-intent", deadline: clock.now() + 300_000,
    preconditions: { accepted: true, settled: true }, reservation: cost };
  let qualifiedLaunch;
  const inputBinding = e => hash([e.pr, e.worktree, e.execution_epoch, e.reviewBinding, e.reviewPolicy, e.control,
    e.cursor, e.rereview, e.network_retry, e.iteration, e.reason, e.state]);
  const guard = () => {
    const current = read();
    if (inputBinding(current.entry) !== inputBinding(entry)) stop("Recovery input or control changed.");
    const result = inspectRecoveryAdmission({ ...current, id, decision, now: clock.now(), qualificationFor: ctx.recoveryQualificationFor });
    if (result.mode !== "recover") stop(result.reason);
    if (qualifiedLaunch && qualifiedLaunch !== result.launchDigest) stop("Qualified launch binding changed.");
    qualifiedLaunch = result.launchDigest;
  };
  guard();
  const update = fn => ctx.state.update(id, current => {
    const journal = structuredClone(current.recovery_actions ?? { version: 1, intents: {}, incidents: {}, recipes: {}, total: zero() });
    if (journal.version !== 1) stop("Inspect the saved recovery journal version.");
    const change = fn(journal, journal.intents[key]);
    return change === false ? {} : { recovery_actions: journal };
  });
  function phase(next) {
    update((_journal, intent) => {
      if (intent.phase === next || intent.phase === "resolved") return false;
      intent.phase = next;
    });
  }
  update((journal, intent) => {
    if (intent) {
      if (intent.launch !== qualifiedLaunch) stop("Restore the launch bound to this recovery intent.");
      return false;
    }
    if (Object.keys(journal.intents).length >= 256) stop("Recovery intent ledger is full. Inspect the task.");
    journal.intents[key] = { recipe, incident, input: hash(input), phase: "diagnosed", launch: qualifiedLaunch, priorOperation: initial.run.execution.operationId,
      epoch: entry.execution_epoch ?? 0, expected, operation: null };
  });
  if (ctx.state.get(id).recovery_actions.intents[key].phase === "diagnosed") phase("planned");
  return { key, guard, phase, decision, route: initial.route, priorOperation: initial.run.execution.operationId,
    reserve(operation) {
      guard();
      if (!paid || typeof operation !== "string" || !operation || operation.length > 256) stop("Reservation requires a bounded execution operation.");
      reservedOperation = operation;
      update((journal, intent) => {
        if (intent.operation) {
          if (intent.operation !== operation) stop("Recovery intent already owns a different operation.");
          return false;
        }
        if (Object.values(journal.intents).some(i => i.operation === operation)) stop("Recovery operation belongs to another intent.");
        if (Object.values(journal.intents).some(i => ["reserved", "executing"].includes(i.phase) && i.priorOperation === intent.priorOperation))
          stop("Observe the original uncertain submission.");
        const finding = journal.incidents[incident] ?? { mutations: 0 };
        const kind = recipe === "provider-continuation" ? "provider-window" : "deterministic";
        if (!incidentMutationAllowed(finding, kind) || (journal.reviewCycles?.consecutive ?? 0) >= 3) stop("Unchanged incident reached its recovery limit.");
        const taskTotal = add(journal.total, cost), recipeTotal = add(journal.recipes[recipe] ?? zero(), cost);
        if (!within(taskTotal, initial.profile.taskLimits) || !within(recipeTotal, initial.profile.recipes.find(r => r.id === recipe).limits))
          stop("Task or recipe recovery allowance exhausted.");
        journal.total = taskTotal; journal.recipes[recipe] = recipeTotal;
        journal.incidents[incident] = { ...finding, mutations: finding.mutations + 1 };
        Object.assign(intent, { operation, cost, phase: "reserved" });
      });
    },
    executing() {
      guard();
      update((_journal, intent) => {
        if (intent.phase !== "reserved") stop("Observe the original recovery operation before any further submission.");
        intent.phase = "executing";
      });
    },
    verified(proof) {
      guard();
      update((journal, intent) => {
        intent.phase = "resolved"; intent.proof = hash(proof);
        journal.incidents[incident] = { ...journal.incidents[incident], mutations: journal.incidents[incident]?.mutations ?? 0, clearance: intent.proof };
      });
    },
  };
}

// Accepted provider receipts may arrive after the worker that submitted them
// exited. Book actual submissions separately from reserved (possibly unknown)
// spend, once per operation. This never authorizes another launch.
export function acceptedRecovery(state, id, key, operation, phase) {
  if (!key) return;
  state.update(id, entry => {
    const journal = structuredClone(entry.recovery_actions);
    const intent = journal?.intents[key];
    if (!intent || intent.operation !== operation || intent.submitted || !["executing", "verifying"].includes(intent.phase)) return {};
    intent.submitted = true;
    intent.phase = phase;
    journal.submitted = add(journal.submitted ?? zero(), intent.cost);
    journal.submittedRecipes ??= {};
    journal.submittedRecipes[intent.recipe] = add(journal.submittedRecipes[intent.recipe] ?? zero(), intent.cost);
    return { recovery_actions: journal };
  });
}

// One failed author/reviewer cycle per owned author turn. Head refreshes,
// multiple findings and repeated reviewer polls cannot multiply that charge.
export function recordReviewCycle(state, id, entry, binding, clear) {
  const operation = entry.execution?.operationId;
  if (!entry.recovery_profile || !operation || !binding || entry.execution.acceptance !== "accepted" ||
      entry.last?.run !== entry.execution.runId || entry.last.exit == null) return 0;
  const updated = state.update(id, current => {
    const journal = structuredClone(current.recovery_actions ?? { version: 1, intents: {}, incidents: {}, recipes: {}, total: zero() });
    const prior = journal.reviewCycles;
    if (prior?.operation === operation && (!clear || prior.consecutive === 0)) return {};
    journal.reviewCycles = { operation, binding, consecutive: clear ? 0 : (prior?.consecutive ?? 0) + 1 };
    return { recovery_actions: journal };
  });
  return updated.recovery_actions?.reviewCycles?.consecutive ?? 0;
}

export function verifyRecoveryOutcome(state, id, ex, recipe, proof) {
  if (!ex?.recoveryIntent || ex.acceptance !== "accepted" || ex.quarantined || ex.cancellation) return;
  state.update(id, entry => {
    const journal = structuredClone(entry.recovery_actions);
    const intent = journal?.intents[ex.recoveryIntent];
    if (!intent || intent.recipe !== recipe || intent.operation !== ex.operationId ||
        !intent.submitted || intent.phase === "resolved") return {};
    intent.proof = hash(proof);
    intent.phase = "resolved";
    journal.incidents[intent.incident].clearance = intent.proof;
    return { recovery_actions: journal };
  });
}
