import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { boundedCall as callWithDeadline, EXECUTION_LIMITS, executionError } from "./execution_io.mjs";

// Node recovery lanes carry one service deadline across awaits. The shared
// execution helpers remain importable by browser views.
const serviceBudget = new AsyncLocalStorage();
export const runRecoveryWork = (fn, durationMs = 30_000) => serviceBudget.run(performance.now() + durationMs, fn);

export function recoveryDeadline(deadlineMs) {
  const end = serviceBudget.getStore();
  if (end === undefined) return deadlineMs;
  const remaining = Math.floor(end - performance.now());
  if (remaining <= 0) throw executionError("RECOVERY_IO_BUDGET", "Recovery service budget elapsed before the next request");
  return Math.min(deadlineMs ?? remaining, remaining);
}

export async function boundedCall(fn, { deadlineMs = EXECUTION_LIMITS.deadlineMs } = {}) {
  return callWithDeadline(fn, { deadlineMs: recoveryDeadline(deadlineMs) });
}
