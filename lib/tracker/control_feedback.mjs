// Pure request feedback, shared by the initial HTML and the browser controller.
// Applied is a coordinator fact, never a model acknowledgement or completion.
export function controlFeedback(control, reason = null, { acknowledged = false, submitting = false } = {}) {
  if (!control) return { state: "idle", phase: "idle", tone: "", text: "No control request yet.", times: "" };
  const labels = { message: "Send message", resume: "Resume agent", recheck: "Recheck PR", cancel: "Cancel task" };
  if (submitting) return { state: "submitting", phase: "submitting", tone: "pending",
    text: `${labels[control.action] || "Request"} — submitting. Waiting for the saved receipt.`, times: "" };
  const state = ["queued", "applying", "applied", "failed", "uncertain"].includes(control.status) ? control.status : "uncertain";
  const phases = { queued: acknowledged ? "accepted" : "queued", applying: "working", applied: "final", failed: "final", uncertain: "uncertain" };
  const statusLabel = { queued: acknowledged ? "request accepted and queued" : "queued", applying: "working", applied: "request applied", failed: "request failed", uncertain: "response uncertain" };
  const next = {
    queued: "Waiting for the coordinator and any active run. Keep the coordinator running; do not send another request.",
    applying: "The coordinator is applying this request. Wait for its saved result before retrying.",
    applied: "The coordinator applied this request. This does not confirm model acknowledgement or task completion. Inspect the updated attempt or delivery evidence.",
    failed: "Inspect the saved reason and repair the prerequisite before submitting a new request. Your message remains available for editing.",
    uncertain: "The response is unconfirmed. Check request status before retrying; retry keeps the same request identity.",
  };
  const cancellation = control.action === "cancel" && state === "applied" && reason === "cancellation-requested"
    ? " Cancellation unconfirmed: remote execution may continue. Wait for provider confirmation; further dispatch is stopped." : "";
  const time = value => (typeof value === "string" || typeof value === "number") && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : "unknown";
  return { state, phase: phases[state], tone: state === "failed" ? "error" : state === "applied" && !cancellation ? "success" : "pending",
    text: `${labels[control.action] || "Request"} — ${statusLabel[state]}. ${control.message || ""} ${next[state]}${cancellation}`.replace(/ +/g, " "),
    times: [...(control.at ? [`Requested: ${time(control.at)}`] : []), ...(control.started_at ? [`Applying: ${time(control.started_at)}`] : []),
      ...(state === "queued" && control.next_at ? [`Next retry: ${time(control.next_at)}`] : []),
      ...(["applied", "failed"].includes(state) && control.finished_at ? [`Finished: ${time(control.finished_at)}`] : [])].join(" · ") };
}
