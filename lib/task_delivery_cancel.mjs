import { cancelControl, cancellationStatus } from "./control.mjs";
import { executionRunner, executionLive } from "./execution.mjs";
import { deliveryError } from "./task_delivery_contract.mjs";
import { nowIso } from "./time.mjs";

// A cancellation-scoped host may replay only this exact retained control. It
// never runs a coordinator tick, advances another task, or collects/publishes a
// late result. Provider ownership, backoff and idempotency remain in execution.
export async function reconcileDeliveryCancellation(ctx, id, requestId) {
  let entry = ctx.state.get(id);
  const request = [entry?.control, ...(entry?.control_history || [])].find(control => control?.id === requestId);
  if (request?.action !== "cancel" || !entry.dispatch_stopped) {
    throw deliveryError("DELIVERY_CONTROL", "The retained cancellation no longer owns this task control; inspect before recovery");
  }
  if (entry.control?.id === requestId) await cancelControl(ctx, id);
  entry = ctx.state.get(id);
  if (entry.control?.id === requestId && entry.control.status === "queued") return true; // another execution owner
  if (entry.reason === "cancelled") return false;
  const runner = executionRunner(ctx, id);
  // Legacy local runners retain their existing verified-stop behavior. Remote
  // execution must have its durable stop before reconcile is allowed to run.
  if (!runner.state || !runner.reconcile) return true;
  if (!runner.state().stopped) await runner.cancel();
  if (!runner.state().stopped) throw deliveryError("DELIVERY_CONTROL", "Cancellation has not durably fenced provider dispatch");
  await runner.reconcile();
  const run = runner.current();
  const pending = Boolean(run && executionLive(run));
  if (!pending) {
    const status = cancellationStatus({ confirmed: !run || run.execution?.providerState === "cancelled", terminal: Boolean(run) });
    ctx.state.update(id, { state: "needs-human", reason: status.reason,
      ...(entry.control?.id === requestId ? { control: { ...entry.control, status: "applied", message: status.message, finished_at: nowIso(ctx.clock) } } : {}) });
  }
  return pending;
}
