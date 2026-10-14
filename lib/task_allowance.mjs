import { executionError } from "./execution_io.mjs";
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
