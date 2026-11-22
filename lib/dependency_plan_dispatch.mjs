import { start } from "./commands/start.mjs";
import { executionRunner } from "./execution.mjs";
import { authorSettled } from "./execution_contract.mjs";
import { qualifiedIntegration, verifyIntegration } from "./dependency_integration.mjs";
import { dependencyIndex, planNodeRuntime, planPrerequisites } from "./dependency_plan_runtime.mjs";
import { coolingDown, providerScope, serverRetryAt, transientServiceFailure } from "./recovery_cooldown.mjs";
import { runRecoveryWork } from "./recovery_io.mjs";
import { dispatchCapacity } from "./dispatch_capacity.mjs";
import { planOperator } from "./operator_intent.mjs";
import { pidExists } from "./daemon.mjs";

// A dead admission owner and an absent execution intent prove that the launch
// never crossed the paid boundary. Retain a partial clone and any unknown
// provider intent with their original IDs. A live or reused PID fails closed.
export function reconcileUnsentStarts(ctx) {
  const { state } = ctx;
  for (const [id, slot] of state.savedAuthorReservations?.() ?? []) {
    if (!slot.pid || slot.pid === process.pid || pidExists(slot.pid)) continue;
    const claim = state.startClaim(id), entry = state.get(id);
    if (!slot.preparing) {
      if (!entry || !ctx.executionFor || !entry.initial_dispatch && (entry.last?.run ?? null) !== slot.previousRun) continue;
      try {
        const ledger = executionRunner(ctx, id, entry.harness).state();
        if (Object.hasOwn(ledger.operations, slot.operation)) continue;
      } catch { continue; }
    }
    if (claim?.token === slot.token && !claim.clone) state.releaseStart(id, slot.token);
    else if (claim?.token === slot.token || entry?.initial_dispatch?.operationId === slot.operation) state.finishUnsentStart(id, slot.token);
    else if (entry && !entry.initial_dispatch) state.releaseAuthorTurn(id, slot.token);
  }
}

export async function tickDependencyPlans(ctx, cycle, waitForEntry = () => null) {
  const { state, config } = ctx;
  const plans = state.graphPlans?.() ?? [];
  if (!plans.length) return [];
  const time = cycle.started, cadence = (config.poll_seconds ?? 120) * 1000;
  const limits = dispatchCapacity(config);
  let mayStart = Boolean(limits.graph_authors && limits.graph_per_repository && ctx.planAuthority);
  if (mayStart) {
    try { planOperator(state.file, ctx.planAuthority); }
    catch (error) { ctx.log.warn(`Graph dispatch gated (${error.code || "operator authority unavailable"})`); mayStart = false; }
  }
  const tasks = new Map(), starts = [], observations = [], providerDeadlines = new Map();
  for (const plan of plans) {
    const index = dependencyIndex(plan), bindings = new Map(plan.approval.bindings.tasks);
    for (const node of plan.approval.graph.nodes) {
      if (node.type !== "task") continue;
      const runtime = planNodeRuntime(plan, node.id);
      if (["integrated", "blocked"].includes(runtime.status)) continue;
      const key = `${plan.id}/${node.id}`, binding = bindings.get(node.id);
      tasks.set(key, { plan, node, runtime, binding });
      if (runtime.token) {
        observations.push([key, runtime.nextAt ?? 0, plan.id]);
      } else if (mayStart && planPrerequisites(plan, node.id, index) && !state.graphHolds(plan, node).some(hold => hold.active)) {
        const route = binding.route;
        const scope = providerScope(route.harness, route.account);
        if (!providerDeadlines.has(scope)) {
          try { providerDeadlines.set(scope, ctx.cooldowns?.deferred(scope)?.retryAt ?? 0); }
          catch { providerDeadlines.set(scope, Infinity); }
        }
        starts.push([key, Math.max(runtime.nextAt ?? 0, providerDeadlines.get(scope)), plan.id]);
      }
    }
  }
  const observing = cycle.batch("graphObserve", observations, { byPlan: true });
  const starting = cycle.batch("graphStart", starts, { byPlan: true });
  const work = (batch, fn) => batch.ids.map(async key => {
    const item = tasks.get(key), { plan, node, runtime } = item;
    const save = (patch, proof) => {
      if (state.updateGraphNode(plan.id, node.id, runtime.generation, patch, proof)) batch.progress();
    };
    batch.start(key);
    try {
      await runRecoveryWork(() => fn(item, save));
      return { plan: plan.approval.graph.name, node: node.id, ok: true };
    } catch (error) {
      const current = state.graphPlan(plan.id);
      if (!current) return null;
      const latest = planNodeRuntime(current, node.id);
      if (batch === starting && !latest.token && !["AUTHOR_CAPACITY", "PLAN_START_FENCE"].includes(error.code)) {
        const retryAt = serverRetryAt(error, time);
        const retry = coolingDown(error) || transientServiceFailure(error) ||
          ["AUTHOR_STORAGE", "RECOVERY_IO_BUDGET", "PLAN_PREREQUISITE", "PLAN_AUTHORITY"].includes(error.code);
        const reason = error.code === "PLAN_PREREQUISITE" || error.code === "CHAIN_INPUT_CHANGED" || coolingDown(error)
          ? error.message : "See coordinator diagnostics for the dispatch prerequisite.";
        state.updateGraphNode(plan.id, node.id, latest.generation, { status: retry ? "queued" : "blocked",
          reason, nextAt: retry ? Math.max(time + cadence, retryAt) : null });
      } else if (batch === observing) {
        save({ reason: error.message, nextAt: Math.max(time + cadence, serverRetryAt(error, time)) });
      }
      if (error.code !== "AUTHOR_CAPACITY") ctx.log.warn(`${plan.approval.graph.name}/${node.id}: ${error.message}`);
      return { plan: plan.approval.graph.name, node: node.id, ok: false, error: error.code || "dispatch-deferred" };
    }
  });
  const observe = async ({ plan, node, runtime, binding }, save) => {
    const id = node.taskId;
    await waitForEntry(id);
    const entry = state.get(id);
    const nextAt = time + cadence;
    if (!entry) { save({ status: "observing", nextAt, reason: "Waiting for the reserved start owner." }); return; }
    if (entry.start_token !== runtime.token || entry.plan?.instanceId !== plan.id || entry.plan.node !== node.id) {
      save({ status: "blocked", reason: "The registered task identity changed." }); return;
    }
    if (entry.dispatch_stopped || ["cancelled", "cancellation-requested"].includes(entry.reason) || entry.completionEvidence?.terminal?.state === "CLOSED") {
      save({ status: "blocked", reason: "The prerequisite task stopped without qualified integration." }); return;
    }
    if (entry.initial_dispatch) { save({ status: "observing", nextAt, reason: "Waiting for the original launch to settle." }); return; }
    if (entry.state !== "done") { save({ status: "started", reason: null, nextAt }); return; }
    const owner = { instanceId: plan.id, node: node.id, token: runtime.token, contract: new Map(plan.approval.nodeContracts).get(node.id) };
    const repo = new Map(plan.approval.bindings.repositories).get(binding.repositoryBinding);
    const receipt = qualifiedIntegration(entry, repo, owner);
    if (!receipt) { save({ status: "unverified", reason: "Waiting for qualified delivery and settled merge closeout.", nextAt }); return; }
    const runner = executionRunner(ctx, id);
    if (!authorSettled(entry, runner.current(), runner)) { save({ nextAt }); return; }
    await verifyIntegration(ctx, receipt);
    save({ status: "integrated", receipt, reason: null, nextAt: null }, { id, binding: repo, receipt });
  };
  const launch = ({ plan, node, runtime }) => start(ctx, { graph: { instanceId: plan.id, node: node.id,
    control: plan.control.generation, generation: runtime.generation } });
  return (await Promise.all([...work(observing, observe), ...work(starting, launch)])).filter(Boolean);
}
