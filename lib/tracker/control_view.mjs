import { controlAvailability, controlOwnership } from "../control_contract.mjs";
import { needsAgentResume } from "../network_recovery.mjs";

// Explanations describe cached service facts; only requestControl authorizes work.
export function controlView(entry, run, capabilities = {}, { initialLaunch = false, controls } = {}) {
  const available = controls || controlAvailability(entry, run, capabilities, { resumable: Boolean(entry.session || initialLaunch) });
  const ownership = controlOwnership(entry, run);
  const gate = entry.state === "done" ? "This PR is closed or merged. Start a follow-up PRD for further changes."
    : entry.dispatch_stopped ? `Further dispatch stopped: ${entry.dispatch_stopped}. Reconcile cancellation before authorizing another task.`
    : capabilities.available === false ? `Provider unavailable: ${capabilities.reason || "Inspect provider readiness and repair access."}`
    : ownership !== "settled" ? `Execution ownership ${ownership}. Wait for reconciliation before continuing work.`
    : entry.reason ? `Recorded gate: ${entry.reason}. Repair the prerequisite before continuing.` : "";
  return { controls: available, gate, active: Boolean(run?.running && run.id === entry.last?.run),
    resume: initialLaunch ? "Start the first run from the approved brief after repairing launch prerequisites."
      : entry.session ? "Continue the same session on its current instructions after repairing the shown prerequisite."
      : "Available once this task has an agent session or a proven unsubmitted launch.",
    recheck: needsAgentResume(entry) ? "An agent failure needs Resume agent, not PR recheck. Any scheduled recovery is shown above."
      : entry.pr ? "Read the latest PR checks and review. Does not resume an agent or rerun CI."
      : "Available once this task has a PR.",
    cancellation: available.cancellation === "stop-future-dispatch; remote-compute-may-continue"
      ? "This provider cannot confirm cancellation here. Stops further dispatch; remote execution may continue."
      : "Stops further dispatch and requests cancellation. Remote execution may continue until the provider confirms.",
  };
}
