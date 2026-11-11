// Shared, read-only attention projection. Never decides readiness or control authority.
export const ATTENTION_GROUPS = [
  ["attention", "Needs attention", "Decisions and repairs for you"],
  ["ready", "Ready for handoff", "Qualified delivery to review or integrate"],
  ["progressing", "Progressing", "Work is moving forward"],
  ["waiting", "Waiting", "Automatic retries and external dependencies"],
  ["ended", "Closed or integrated", "Inspect the recorded outcome"],
  ["unknown", "Status unknown", "More evidence is needed"],
];

const remedies = {
  "prd-changed": ["Approved brief changed", "The current brief differs from the approved snapshot.", "Review the brief difference. Restore the approved copy or explicitly approve a new snapshot before resuming."],
  "prd-gone": ["Brief is missing", "The approved brief cannot be found.", "Restore the brief or explicitly remove the task if the work is no longer wanted."],
  "prd-illegal": ["Brief needs repair", "The edited brief no longer passes validation.", "Repair the brief and run readiness validation before approving it again."],
  "checks-red": ["Checks need attention", "Recorded checks prevented this task from proceeding.", "Inspect the failing check on the PR and resolve its cause before requesting a recheck."],
  conflict: ["Resolve a branch conflict", "The delivery cannot proceed with its recorded branch conflict.", "Inspect the conflict and preserved work before resuming the agent."],
  "review-incomplete": ["Review evidence incomplete", "The independent review could not evaluate all required evidence.", "Inspect the missing review evidence and repair the recorded capture prerequisite before requesting a recheck."],
  "first-party-review-failed": ["Independent review failed", "The configured independent reviewer could not finish.", "Inspect the saved review failure and restore the selected reviewer route before requesting a recheck."],
  "repeated-review-findings": ["Review findings persist", "The same review findings remain after a previous correction attempt.", "Inspect the findings and preserved changes before deciding on further authorized work."],
  "review-disagreement": ["Reviewers disagree", "Independent and external review observations disagree.", "Compare the current-head review evidence and resolve the disagreement before handoff."],
  "provider-network-exhausted": ["Network retries exhausted", "The automatic connectivity retry allowance has ended.", "Restore provider connectivity, inspect the saved failure, then explicitly resume authorized work."],
  "provider-network": ["Connection needs repair", "Automatic network recovery has stopped.", "Restore provider connectivity, inspect the saved failure, then explicitly resume authorized work."],
  "dispatch-refused": ["Dispatch prerequisite missing", "The execution request was refused before submission.", "Inspect the saved prerequisite failure, repair it, then explicitly resume authorized work."],
  "run-stop-unverified": ["Execution stop unconfirmed", "The previous execution has not been confirmed stopped.", "Inspect the owned run and reconcile its status before starting another writer."],
  timeout: ["Runtime allowance reached", "The attempt ended at its recorded time limit; unfinished files may remain.", "Inspect preserved work and the authorized allowance before deciding whether to resume."],
};

export function attentionPresentation({ entry, phase, actor, nextAction, reason, divergence, ownership, review }) {
  const result = (group, title, explanation, next = nextAction, source = phase.source, priority = 5, who = group === "attention" ? "operator" : actor) =>
    ({ group, title, explanation, nextAction: next, actor: who, source, priority });
  const remedy = remedies[reason];
  // These signals remain visible even while an older execution is running/reconciling.
  if (divergence) return result("attention", remedy?.[0] || "Approved inputs changed", remedy?.[1] || "The brief or its sources differ from the approved snapshot.", remedy?.[2] || "Inspect the approved-input difference and explicitly resolve it before resuming.", "briefDivergence", 0);
  if (["integrated", "closed"].includes(phase.id)) return result("ended", phase.label, phase.id === "integrated" ? "Integration is confirmed by recorded evidence." : "Inspect the terminal outcome; closure alone does not mean integration.");
  if (entry.control?.status === "failed") return result("attention", "Control request failed", "The coordinator could not apply the latest operator request.", "Open task actions to inspect the saved request result and repair its cause before retrying.", "entry.control", 1);
  if (phase.id === "operator_attention") return result("attention", remedy?.[0] || "Prerequisite or decision needed", remedy?.[1] || "This task is held for an operator decision or a recorded prerequisite.", remedy?.[2] || nextAction, phase.source, 2);
  if (review.verdict === "findings" && ["pending", "dispatch-intent"].includes(review.disposition)) return result("waiting", "Review corrections queued", "The coordinator has recorded the next correction attempt.", "Wait for the queued correction or inspect its saved dispatch status; do not start another writer.", "entry.firstPartyReview.disposition", 5, "coordinator");
  if (review.verdict === "findings" && review.disposition !== "dispatched") return result("attention", "Review findings need resolution", "The current-head independent review recorded unresolved findings.", "Open the task to inspect review findings and their recorded disposition.", "entry.firstPartyReview", 3);
  if (ownership === "uncertain") return result("attention", "Execution ownership uncertain", "Saved execution status cannot establish whether the owned job has stopped.", nextAction, "controlOwnership", 1);
  if (phase.id === "delivery_ready") return result("ready", phase.label, "The canonical completion check qualifies this delivery for handoff.");
  if (["retry_wait", "ci_wait", "remote_review", "reconciling"].includes(phase.id)) return result("waiting", phase.label, `Waiting on ${actor === "coordinator" ? "automatic coordinator work" : actor === "ci" ? "current-head checks" : "the external reviewer"}.`);
  if (["implementing", "independent_review", "planning", "verifying"].includes(phase.id)) return result("progressing", phase.label, review.verdict === "findings" ? "Review findings have been sent to the agent." : "The recorded attempt or review is in progress.");
  return result("unknown", phase.label, "Saved observations do not establish a current phase or qualified completion.");
}
