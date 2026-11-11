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

// This module accepts observations, not services. It cannot probe, dispatch,
// certify a review, read a transcript or write state. Provenance points back to
// canonical fields; the existing API fields remain available to inspect them.
export function taskPresentation({ entry: input = null, task = null, run = null, completion = null,
  capabilities = {}, controls = null, provider = null, divergence = null, maxIterations = null,
  now = null, chain = null } = {}) {
  const entry = record(input), diagnostics = [];
  const reasonCode = code(typeof entry.reason === "string" ? entry.reason.split(":")[0] : null);
  let ready = completion;
  try { ready = input ? completionView(null, input, null, run) : ready || completionView(null, null); }
  catch { ready = null; diagnostics.push("Completion observation unavailable; inspect saved evidence."); }
  ready = record(ready);
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
  const currentReview = entry.reviewBinding && entry.reviewObservation?.head && entry.reviewObservation.head === entry.cursor?.fixed_sha && entry.reviewObservation.binding === entry.reviewBinding ? entry.reviewObservation : null;
  const checks = Number.isSafeInteger(currentReview?.checks?.count) && currentReview.checks.count >= 0 && typeof currentReview.checks.settled === "boolean" ? currentReview.checks : null;
  const reviewCurrent = Boolean(entry.firstPartyReview?.binding && entry.firstPartyReview.binding === entry.reviewBinding && entry.reviewHead === entry.cursor?.fixed_sha);
  let review = { status: "unknown", source: null };
  try {
    const activity = reviewActivity(entry);
    review = { status: reviewCurrent ? known(activity.status, ["running", "waiting", "completed", "failed", "incomplete"]) : activity.status === "unavailable" ? "unavailable" : "unknown", source: "reviewActivity", external: currentReview ? known(currentReview.external, ["waiting", "clear", "blocking", "none"]) : "unknown",
      verdict: reviewCurrent && entry.firstPartyReview?.status === "completed" ? known(entry.firstPartyReview?.result?.verdict, ["findings", "clear"]) : "unknown",
      disposition: reviewCurrent ? known(entry.firstPartyReview?.disposition?.status, ["dispatched", "dispatch-intent", "rounds-exhausted", "pending"]) : "unknown" };
  } catch { diagnostics.push("Review observation unavailable; inspect saved evidence."); }
  if (ownership !== "settled") set("reconciling", ownership === "uncertain" ? "Execution ownership uncertain" : "Awaiting reconciliation", "coordinator", ownership,
    "Inspect the owned run; wait for reconciliation before another writer.", "controlOwnership");
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
  else if (checks?.settled === false) set("ci_wait", "Waiting for checks", "ci", "checks-unsettled", "Inspect current-head checks or wait for their result.", "entry.reviewObservation.checks");
  else if (currentReview?.external === "waiting") set("remote_review", "Waiting for external review", "external-reviewer", "review-pending", "Wait for the configured external reviewer.", "entry.reviewObservation.external");
  else if (!input && ["preparing", "validating"].includes(task?.status)) set(task.status === "validating" ? "verifying" : "planning", task.status === "validating" ? "Validating brief" : "Planning", "planner", null, "Wait for preparation to finish.", "task.status");
  else if (["ready-for-human", "done"].includes(entry.state)) set("unknown", "Completion unverified", "operator", "completion-evidence-missing", "Inspect current completion evidence before handoff.", "completionView");
  if (phase === "unknown") diagnostics.push("Saved observations cannot establish a finer phase.");
  const activity = meaningfulActivity(entry, run);
  const execution = record(run?.execution || entry.execution);
  const observedAt = [execution.observedAt, currentReview?.observedAt, entry.updated_at].map(instant).filter(Boolean).sort().at(-1) || null;
  const snapshotAt = instant(now);
  const checkStatus = !checks ? "unknown" : checks.count === 0 ? entry.reviewPolicy?.zeroChecks === true ? "not-configured" : "not-observed" : checks.settled === true ? "passed" : "pending";
  const rounds = { used: Number.isSafeInteger(entry.iteration) && entry.iteration >= 0 ? entry.iteration : null,
    limit: Number.isSafeInteger(maxIterations) && maxIterations > 0 ? maxIterations : null, source: "entry.iteration/config.max_iterations" };
  const attention = attentionPresentation({ entry, phase: { id: phase, label, source }, actor, nextAction,
    reason: code(divergence?.reason) || reasonCode || blocker, divergence, ownership, review, operatorAttention });
  nextAction = attention.nextAction;
  return { version: 1, attention, phase: { id: phase, label, source }, actor, blocker, reason: reasonCode || blocker, nextAction,
    readiness, execution: { provider: text(execution.provider), model: text(execution.model), providerState: known(execution.providerState, PROVIDER_STATES) }, acceptance: { status: entry.gate_skipped ? "skipped" : ["fulfilled", "awaiting_integration"].includes(readiness.status) ? "accepted" : "unknown", source: "completionView/entry.gate_skipped" },
    delivery: { repository: text(entry.repo || task?.repo), base: text(entry.base || task?.base), target: readiness.target,
      pr: Number.isSafeInteger(entry.pr) ? entry.pr : null },
    activity, since: activity.at, freshness: { observedAt, snapshotAt, status: observedAt ? "observed" : "unknown" },
    attempt: attemptPresentation(run, { entry, maxIterations, now }), rounds,
    retryAt: instant(entry.network_retry?.next_at), review, checks: { status: checkStatus, source: checks ? "entry.reviewObservation.checks" : null }, provider: providerPresentation(provider, capabilities),
    ownership, controls: projectedControls, chain: chain ? { name: text(chain.name), status: code(chain.status),
      total: Number.isSafeInteger(chain.total) ? chain.total : null,
      position: Number.isSafeInteger(chain.position) ? chain.position : Number.isSafeInteger(chain.completed) ? chain.completed + 1 : null } : null,
    diagnostics: diagnostics.slice(0, 3) };
}

export function presentationDetail(p) {
  return [p.reason, `Actor: ${p.actor}`, p.blocker && `Blocker: ${p.blocker}`, `Readiness: ${p.readiness.status}`, `Receipt: ${p.acceptance.status}`,
    `Target: ${p.delivery.target}`, `Next: ${p.nextAction}`, p.provider.label].filter(Boolean).join("; ");
}
