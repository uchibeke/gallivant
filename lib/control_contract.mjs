import { executionLive, providerTerminal, ownedRemoteExecution, EXECUTION_TRANSPORTS } from "./execution_contract.mjs";
import { needsAgentResume } from "./network_recovery.mjs";
// Shared cached control visibility; requestControl remains the validation/writer.
export const controlPending = control => ["queued", "applying"].includes(control?.status);
export function controlOwnership(entry, run) {
  const ex = run?.execution || entry?.execution;
  if (ex && (ex.transport ?? EXECUTION_TRANSPORTS[ex.provider]) === "remote" &&
    (ex.acceptance !== "accepted" || !ownedRemoteExecution(ex))) return "uncertain";
  if (ex && (ex.providerState === "status-unknown" || ex.providerState === "cancellation-requested" ||
    ex.cancellation && ex.cancellation.status !== "confirmed" && ex.providerState !== "cancelled" && executionLive({ execution: ex }))) return "uncertain";
  if ((ex && providerTerminal(ex.providerState) && executionLive({ execution: ex })) ||
    (entry?.last?.run && entry.last.exit == null && (!run || run.id !== entry.last.run || !run.running))) return "reconciling";
  return "settled";
}
export function controlAvailability(entry, run, capabilities, { resumable = Boolean(entry?.session) } = {}) {
  const pending = controlPending(entry?.control);
  const stopped = !entry || entry.state === "done" || pending;
  const active = run?.running && run.id === entry?.last?.run;
  const canContinue = !stopped && !entry.dispatch_stopped && capabilities?.available !== false && controlOwnership(entry, run) === "settled" && Boolean(resumable || active);
  return {
    recheck: !stopped && Boolean(entry.pr) && !needsAgentResume(entry),
    resume: canContinue,
    message: canContinue,
    cancel: !stopped,
    interrupt: canContinue && capabilities?.controls?.interrupt !== false,
    cancellation: capabilities?.controls?.cancel === false ? "stop-future-dispatch; remote-compute-may-continue" : "requires-provider-confirmation",
  };
}
