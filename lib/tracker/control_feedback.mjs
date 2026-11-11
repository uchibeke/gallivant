// Pure request feedback, shared by the initial HTML and the browser controller.
// Applied is a coordinator fact, never a model acknowledgement or completion.
export function controlFeedback(control, reason = null) {
  if (!control) return { state: "idle", tone: "", text: "No control request yet.", times: "" };
  const labels = { message: "Send message", resume: "Resume agent", recheck: "Recheck PR", cancel: "Cancel task" };
  const state = ["queued", "applying", "applied", "failed", "uncertain"].includes(control.status) ? control.status : "uncertain";
  const next = {
    queued: "Waiting for the coordinator and any active run. Keep the coordinator running; do not send another request.",
    applying: "The coordinator is applying this request. Wait for its saved result before retrying.",
    applied: "The coordinator applied this request. This does not confirm model acknowledgement or task completion. Inspect the updated attempt or delivery evidence.",
    failed: "Inspect the saved reason and repair the prerequisite before submitting a new request. Your message remains available for editing.",
    uncertain: "The response is unconfirmed. Check request status before retrying; retry keeps the same request identity.",
  };
  const cancellation = control.action === "cancel" && state === "applied" && reason === "cancellation-requested"
    ? " Cancellation unconfirmed: remote execution may continue. Wait for provider confirmation; further dispatch is stopped." : "";
  const time = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : "unknown";
  return { state, tone: state === "failed" ? "error" : state === "applied" && !cancellation ? "success" : "pending",
    text: `${labels[control.action] || "Request"} — ${state}. ${control.message || ""} ${next[state]}${cancellation}`.replace(/ +/g, " "),
    times: [`Requested: ${time(control.at)}`, ...(control.started_at ? [`Applying: ${time(control.started_at)}`] : []),
      ...(["applied", "failed"].includes(state) ? [`Finished: ${time(control.finished_at)}`] : [])].join(" · ") };
}
