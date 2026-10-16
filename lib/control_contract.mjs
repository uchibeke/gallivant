// Shared cached control visibility; requestControl remains the validation/writer.
export const controlPending = control => ["queued", "applying"].includes(control?.status);
export function controlAvailability(entry, run, capabilities, { resumable = Boolean(entry?.session) } = {}) {
  const pending = controlPending(entry?.control);
  const stopped = !entry || entry.state === "done" || pending;
  const active = run?.running && run.id === entry?.last?.run;
  const canContinue = !stopped && !entry.dispatch_stopped && Boolean(resumable || active);
  return {
    recheck: !stopped && Boolean(entry.pr),
    resume: canContinue,
    message: canContinue,
    cancel: !stopped,
    interrupt: canContinue && capabilities?.controls?.interrupt !== false,
    cancellation: capabilities?.controls?.cancel === false ? "stop-future-dispatch; remote-compute-may-continue" : "requires-provider-confirmation",
  };
}
