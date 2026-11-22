import { currentHostReview, currentReview, recoveryObservation } from "../recovery_observation.mjs";
import { attentionPresentation } from "./attention.mjs";
import { redact } from "../execution_io.mjs";
import { completionView } from "../task_completion.mjs";
import { controlAvailability, controlOwnership } from "../control_contract.mjs";
import { reviewActivity } from "./review.mjs";
import { providerPresentation } from "./provider_presentation.mjs";
import { validNetworkRetry, networkRecoveryDetail } from "../network_recovery.mjs";
import { PROVIDER_STATES } from "../execution_contract.mjs";
import { meaningfulActivity, instant, attemptPresentation } from "./presentation_time.mjs";

const record = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const code = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(value) ? redact(value) : null;
const text = value => typeof value === "string" ? redact(value).slice(0, 256) : null;
const known = (value, values) => values.includes(value) ? value : "unknown";

export const OUTCOMES = [
  ["integrated", "Integrated"], ["ready", "Ready for handoff"], ["closed-unmerged", "Closed without integration"],
  ["cancelled", "Cancelled"], ["planned", "Planned"], ["active", "Active"], ["blocked", "Blocked"], ["unknown", "Unknown"],
];

function taskOutcome(phase, readiness, attention) {
  if (phase === "integrated") return "integrated";
  if (readiness === "cancelled") return "cancelled";
  if (phase === "intake_ready") return "planned";
  if (phase === "delivery_ready") return "ready";
  if (attention === "attention") return "blocked";
  return ["progressing", "waiting"].includes(attention) ? "active" : "unknown";
}

// This module accepts observations, not services. It cannot probe, dispatch,
// certify a review, read a transcript or write state. Provenance points back to
// canonical fields; the existing API fields remain available to inspect them.
export function taskPresentation({ id = null, entry: input = null, task = null, run = null, completion = null,
  capabilities = {}, controls = null, provider = null, divergence = null, maxIterations = null,
  now = null, chain = null, chains = null } = {}) {
  const entry = record(input), diagnostics = [];
  const reasonCode = code(typeof entry.reason === "string" ? entry.reason.split(":")[0] : null);
  let ready = completion;
  try { ready = input ? completionView(null, input, null, run) : ready || completionView(null, null); }
  catch { ready = null; diagnostics.push("Completion observation unavailable; inspect saved evidence."); }
  ready = record(ready);
  // Task outcome describes recorded delivery, independently of live process
  // ownership and the currently selected attempt.
  const terminal = ready.evidence?.terminal?.state;
  const readiness = { status: known(ready.status, ["pending", "cancelled", "blocked", "fulfilled", "awaiting_integration", "unverified"]),
    target: known(ready.target, ["delivery_ready", "integrated"]), source: "completionView", mergeAuthorized: false };
  const ownership = controlOwnership(entry, run);
  const available = controls || controlAvailability(input, run, capabilities);
  const projectedControls = Object.fromEntries(["recheck", "resume", "message", "cancel", "interrupt"].map(key => [key, available[key] === true && (!["resume", "message", "interrupt"].includes(key) || ownership === "settled")]));
  projectedControls.cancellation = available.cancellation;
  // A recorded stop and unresolved execution ownership are independent facts.
  // Reuse the phase predicates so automatic retries do not become operator stops.
  const retryWaiting = !entry.dispatch_stopped && !divergence && Boolean(entry.network_retry?.phase === "waiting" || entry.retry);
  const operatorAttention = !retryWaiting && Boolean(divergence || entry.state === "needs-human" || task?.status === "blocked" || task?.status === "needs-input");
  let phase = "unknown", label = "Phase unknown", actor = "unknown", blocker = null, nextAction = "Inspect the saved task evidence.", source = null;
  const set = (id, name, who, why, next, evidence) => { phase = id; label = name; actor = who; blocker = why; nextAction = next; source = evidence; };
  const hostReview = currentHostReview(entry);
  const checks = Number.isSafeInteger(hostReview?.checks?.count) && hostReview.checks.count >= 0 && typeof hostReview.checks.settled === "boolean" ? hostReview.checks : null;
  const reviewCurrent = Boolean(currentReview(entry));
  let review = { status: "unknown", verdict: "unknown", source: null };
  try {
    const activity = reviewActivity(entry);
    review = { status: reviewCurrent ? known(activity.status, ["running", "waiting", "completed", "failed", "incomplete"]) : activity.status === "unavailable" ? "unavailable" : entry.firstPartyReview ? "stale-head" : "unknown", source: "reviewActivity", external: hostReview ? known(hostReview.external, ["waiting", "clear", "blocking", "none"]) : entry.reviewObservation ? "stale-head" : "unknown",
      observedAt: instant(entry.firstPartyReview?.completedAt || entry.firstPartyReview?.startedAt), head: text(entry.reviewHead),
      verdict: reviewCurrent && activity.status !== "unavailable" && entry.firstPartyReview?.status === "completed" ? known(entry.firstPartyReview?.result?.verdict, ["findings", "clear"]) : "unknown",
      disposition: reviewCurrent ? known(entry.firstPartyReview?.disposition?.status, ["dispatched", "dispatch-intent", "rounds-exhausted", "pending"]) : "unknown" };
  } catch { diagnostics.push("Review observation unavailable; inspect saved evidence."); }
  if (ownership !== "settled") set("reconciling", ownership === "uncertain" ? "Execution ownership uncertain" : "Awaiting reconciliation", "coordinator", ownership,
    "Inspect the owned run; wait for reconciliation before another writer.", "controlOwnership");
  else if (entry.state === "done" && run?.running && run.id === entry.last?.run) set("implementing", "Agent working", "agent", null, "Inspect the active attempt before treating this task as finished.", "run.running/entry.last.run");
  else if (entry.state === "done") {
    if (ready.evidence?.terminal?.state === "CLOSED") set("closed", "Closed without integration", "operator", "closed-unmerged", "Open the delivery to inspect its recorded outcome.", "completionView.evidence.terminal");
    else if (ready.evidence?.integration?.qualified === true) set("integrated", "Integrated", "none", null, "No further action is recorded.", "completionView.evidence.integration");
    else set("completed", "Completed", "none", readiness.status === "unverified" ? "completion-evidence-missing" : null,
      "Open the delivery to inspect its recorded outcome. Verification evidence is shown separately.", "entry.state");
  }
  else if (retryWaiting) set("retry_wait", "Waiting to retry", "coordinator", "retry-pending",
    entry.network_retry?.phase === "waiting" && validNetworkRetry(entry.network_retry)
      ? networkRecoveryDetail({ ...entry.network_retry, next_at: instant(entry.network_retry.next_at) })
      : "Wait for the scheduled retry; inspect its saved failure if it persists.", entry.network_retry?.phase === "waiting" ? "entry.network_retry" : "entry.retry");
  else if (operatorAttention) set("operator_attention", "Needs attention", "operator", code(divergence?.reason) || reasonCode || code(task?.errorCode) || "operator-decision",
    "Inspect the task and repair the recorded prerequisite.", divergence ? "briefDivergence" : "entry.reason/task.status");
  else if (ready.evidence?.terminal?.state === "CLOSED") set("closed", "Closed without integration", "operator", "closed-unmerged", "Inspect the closed delivery before planning follow-up work.", "completionView.evidence.terminal");
  else if (readiness.status === "fulfilled" && ready.evidence?.integration?.qualified === true) set("integrated", "Integrated", "none", null, "No further action is recorded.", "completionView.evidence.integration");
  else if (["fulfilled", "awaiting_integration"].includes(readiness.status)) set("delivery_ready", "Ready for handoff", "operator", readiness.status === "awaiting_integration" ? "integration-pending" : null,
    "Inspect the qualified delivery for handoff.", "completionView");
  else if (readiness.status === "cancelled") set("closed", "Dispatch stopped", "operator", "dispatch-stopped", "Inspect cancellation confirmation and preserved work.", "completionView");
  else if (run?.running && run.id === entry.last?.run) set("implementing", "Agent working", "agent", null, "Wait or inspect the active attempt; its finer phase is unknown.", "run.running/entry.last.run");
  else if (review.status === "running") set("independent_review", "Independent review", "independent-reviewer", null, "Wait for the independent review result.", "reviewActivity");
  else if (checks?.failed > 0) set("ci_failed", "Checks failed", "ci", "checks-red", "Inspect failed checks on the current head.", "entry.reviewObservation.checks");
  else if (checks?.settled === false) set("ci_wait", "Waiting for checks", "ci", "checks-unsettled", "Inspect current-head checks or wait for their result.", "entry.reviewObservation.checks");
  else if (hostReview?.external === "waiting") set("remote_review", "Waiting for external review", "external-reviewer", "review-pending", "Wait for the configured external reviewer.", "entry.reviewObservation.external");
  else if (!input && ["preparing", "validating"].includes(task?.status)) set(task.status === "validating" ? "verifying" : "planning", task.status === "validating" ? "Validating brief" : "Planning", "planner", null, "Wait for preparation to finish.", "task.status");
  else if (!input && task?.status === "ready") set("intake_ready", "Brief ready", "operator", null, "Review the saved brief and approve the exact revision before starting.", "task.status");
  else if (entry.state === "ready-for-human") set("unknown", "Completion unverified", "operator", "completion-evidence-missing", "Inspect current completion evidence before handoff.", "completionView");
  if (phase === "unknown") diagnostics.push("Saved observations cannot establish a finer phase.");
  const providerState = providerPresentation(provider, capabilities);
  const recovery = recoveryObservation({ id: id ?? task?.implementation?.id ?? entry.task?.id ?? task?.taskId,
    entry, run, phase, divergence, providerStatus: providerState.status, chains: chains || (chain ? [chain] : []), obligations: Array.isArray(ready.obligations) ? ready.obligations : [], now });
  const activity = meaningfulActivity(entry, recovery);
  const execution = record(run?.execution || entry.execution);
  const observedAt = [execution.observedAt, hostReview?.observedAt, entry.updated_at].map(instant).filter(Boolean).sort().at(-1) || null;
  const snapshotAt = instant(now);
  const checkStatus = !checks ? entry.reviewObservation && !hostReview ? "stale-head" : "unknown" : checks.failed > 0 ? "failed" : checks.count === 0 ? entry.reviewPolicy?.zeroChecks === true ? "not-configured" : "not-observed" : checks.settled === true ? "passed" : "pending";
  const rounds = { used: Number.isSafeInteger(entry.iteration) && entry.iteration >= 0 ? entry.iteration : null,
    limit: Number.isSafeInteger(maxIterations) && maxIterations > 0 ? maxIterations : null, source: "entry.iteration/config.max_iterations" };
  const attention = attentionPresentation({ entry, phase: { id: phase, label, source }, actor, nextAction,
    reason: code(divergence?.reason) || reasonCode || blocker, divergence, ownership, review, operatorAttention });
  nextAction = attention.nextAction;
  const chainPresentations = (Array.isArray(chains) ? chains : chain ? [chain] : []).filter(c => !c.released).map(chain => ({
    name: text(chain.name), status: code(chain.status), total: Number.isSafeInteger(chain.total) ? chain.total : null,
    position: chain.predecessor === true ? null : Number.isSafeInteger(chain.position) ? chain.position : Number.isSafeInteger(chain.completed) ? chain.completed + 1 : null,
    predecessor: chain.predecessor === true,
  }));
  const outcome = terminal === "CLOSED" ? "closed-unmerged" : taskOutcome(phase, readiness.status, attention.group);
  return { version: 1, outcome, recovery, attention, phase: { id: phase, label, source }, actor, blocker, reason: reasonCode || blocker, nextAction,
    readiness, ownerDelivery: { source: "completionView.obligations", obligations: (Array.isArray(ready.obligations) ? ready.obligations : []).slice(0, 8).map(o => ({ id: text(o.id), kind: code(o.kind), status: known(o.status, ["fulfilled", "pending"]), head: text(o.evidence?.head), observedAt: instant(o.evidence?.observedAt) })) }, execution: { provider: text(execution.provider), model: text(execution.model), providerState: known(execution.providerState, PROVIDER_STATES) }, acceptance: { status: entry.gate_skipped ? "skipped" : ["fulfilled", "awaiting_integration"].includes(readiness.status) ? "accepted" : "unknown", source: "completionView/entry.gate_skipped", head: text(ready.evidence?.delivery?.head), observedAt: instant(ready.evidence?.delivery?.observedAt) },
    delivery: { repository: text(entry.repo || task?.repo), base: text(entry.base || task?.base), target: readiness.target,
      pr: Number.isSafeInteger(entry.pr) ? entry.pr : null },
    activity, since: activity.at, freshness: { observedAt, snapshotAt, status: observedAt ? "observed" : "unknown" },
    attempt: attemptPresentation(run, { entry, maxIterations, now }), rounds,
    retryAt: instant(entry.network_retry?.next_at), review, checks: { status: checkStatus, source: entry.reviewObservation ? "entry.reviewObservation.checks" : null, head: text(entry.reviewObservation?.head), observedAt: instant(entry.reviewObservation?.observedAt) }, provider: providerState,
    ownership, controls: projectedControls, chain: chainPresentations[0] || null, chains: chainPresentations,
    diagnostics: diagnostics.slice(0, 3) };
}

export function recoveryDetail(p) {
  const r = p.recovery;
  if (!r) return "";
  const original = r.incidents[0];
  return [r.classification, r.step !== r.classification && r.step, original && `original ${original.cause}${original.detail ? " " + original.detail : ""} (${original.evidence}${original.run ? " / " + original.run : ""})`,
    original?.at && `first seen ${original.at}`, r.incidents.length > 1 && `${r.incidents.length} open causes`, r.uncertain && "incident match uncertain", !r.productiveAt && "verified progress unknown", `observed attempts ${r.attempts ?? "unknown"}`, r.provenance, r.retryAttempts != null && `provider retries ${r.retryAttempts}`,
    r.nextAt && `next retry ${r.nextAt}`, r.control.stopped && "dispatch stopped", r.control.held && `hold generation ${r.control.generation ?? "unknown"}`,
    r.control.disabled && "repository disabled", r.control.cancellation,
    `PR ${r.host.pr ?? "none"} · CI ${p.checks.status} · review ${p.review.verdict === "unknown" ? p.review.status : p.review.verdict}`,
    r.obligations.chain && `chain ${r.obligations.chain} ${r.obligations.chainStatus || "unknown"}`].filter(Boolean).join(" · ");
}

export function presentationDetail(p) {
  return [p.reason, `Actor: ${p.actor}`, p.blocker && `Blocker: ${p.blocker}`, `Readiness: ${p.readiness.status}`, `Receipt: ${p.acceptance.status}`,
    `Target: ${p.delivery.target}`, `Next: ${p.nextAction}`, p.provider.label, recoveryDetail(p)].filter(Boolean).join("; ");
}
