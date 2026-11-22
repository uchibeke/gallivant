import { executionError } from "./execution_io.mjs";

export function preparationCost(attempts) {
  const calls = attempts.filter(attempt => attempt.startedAt);
  if (!calls.length) return { status: "none", usd: 0, detail: "no planning call has been made" };
  const unknown = calls.filter(attempt => attempt.cost == null);
  if (!unknown.length) return { status: "reported", usd: calls.reduce((sum, attempt) => sum + attempt.cost, 0), detail: "sum of provider-reported or usage-derived costs" };
  if (unknown.every(attempt => Number.isFinite(attempt.reservedUsd))) return { status: "bounded",
    usd: calls.reduce((sum, attempt) => sum + Math.max(attempt.cost ?? 0, attempt.reservedUsd ?? 0), 0),
    detail: `${unknown.length} call(s) reported no cost; their reservations bound the total` };
  return { status: "unknown", usd: null, detail: `${unknown.length} call(s) reported no cost and carry no reservation` };
}

export function planExecutionAllowance(limits, task) {
  const { maxIterations, maxBudgetUsd } = limits;
  const { timeoutMinutes, route } = task;
  if (!Number.isFinite(maxIterations) || maxIterations < 1 || !Number.isFinite(maxBudgetUsd) || maxBudgetUsd < 0 ||
      !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || !route?.configurationDigest) {
    throw executionError("PLAN_START_FENCE", "The approved plan task has no valid execution allowance. Inspect the saved approval before dispatch.");
  }
  return { maxIterations, maxBudgetUsd, timeoutMinutes, routeDigest: route.configurationDigest };
}

export function planRunConfig(config, allowance) {
  return allowance ? { ...config, max_budget_usd: allowance.maxBudgetUsd, run_timeout_minutes: allowance.timeoutMinutes } : config;
}

export function assertPlanRounds(entry, allowance) {
  if (allowance && entry.iteration >= allowance.maxIterations) {
    throw executionError("PLAN_ITERATIONS", "The task has reached its approved plan round limit.");
  }
}

// Scoped consumers pin their authorized implementation allowance in task metadata.
// Legacy/operator entries keep their existing configured behavior.
export function taskExecutionConfig(config, task, execution = null, { excludeRunId = null } = {}) {
  const allowance = task?.deliveryAllowance;
  if (!allowance) return config;
  if (!Number.isFinite(allowance.budgetUsd) || allowance.budgetUsd <= 0 || !Number.isFinite(allowance.runtimeMs) || allowance.runtimeMs <= 0) throw executionError("EXECUTION_ALLOWANCE", "Saved task allowance is exhausted or invalid; inspect its original authorization");
  let spent = 0, elapsedMs = 0;
  if (execution) {
    const ledger = execution.state?.();
    if (!ledger && execution.current()) throw executionError("EXECUTION_ALLOWANCE", "Scoped continuation requires the durable execution ledger; inspect the original runtime binding");
    for (const op of Object.values(ledger?.operations || {})) {
      if (op.runId === excludeRunId) continue;
      if (execution.capabilities?.transport !== "remote") {
        if (!Number.isFinite(op.costUsd)) throw executionError("EXECUTION_ALLOWANCE", "Previous local cost is unknown; reconcile it before authorizing another run");
        spent += op.costUsd;
      }
      const job = execution.read(op.runId);
      if (!job || !Number.isFinite(job.endedAt) || !Number.isFinite(job.startedAt) || job.endedAt < job.startedAt) throw executionError("EXECUTION_ALLOWANCE", "Previous execution duration is unknown; reconcile it before authorizing another run");
      elapsedMs += job.endedAt - job.startedAt;
    }
  }
  if (spent >= allowance.budgetUsd || elapsedMs >= allowance.runtimeMs) throw executionError("EXECUTION_ALLOWANCE", "Saved task allowance is exhausted; no further run was dispatched");
  return { ...config, max_budget_usd: Math.min(config.max_budget_usd, allowance.budgetUsd - spent), run_timeout_minutes: Math.min(config.run_timeout_minutes, (allowance.runtimeMs - elapsedMs) / 60000) };
}
export function taskProviderAllowance(allowance, task) {
  if (!task?.deliveryAllowance) return allowance;
  const cap = task.deliveryAllowance.budgetUsd;
  if (!Number.isFinite(cap) || cap <= 0 || !allowance || allowance.reservedUsd > cap) throw executionError("EXECUTION_ALLOWANCE", "Provider reservation exceeds the saved task allowance; configure a smaller bounded reservation");
  return { ...allowance, remainingUsd: Math.min(allowance.remainingUsd, cap) };
}
