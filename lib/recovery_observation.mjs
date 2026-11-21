// Pure projection of coordinator records. The registry retains the small continuity
// record during existing writes. Readers have no service handles or dispatch API.
import { redact } from "./execution_io.mjs";
import { recoveryDigest as hash } from "./recovery_digest.mjs";
import { instant } from "./tracker/presentation_time.mjs";
import { controlOwnership, controlPending } from "./control_contract.mjs";
import { executionLive, PROVIDER_STATES } from "./execution_contract.mjs";
import { validNetworkRetry } from "./network_recovery.mjs";
import { matchingDeliveryEvidence } from "./owner_delivery.mjs";

const ref = value => typeof value === "string" && /^[\w./:@~-]{1,256}$/.test(value) && !value.includes("://") && !value.startsWith("/") && redact(value) === value ? value : null;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;
const latest = (...times) => times.map(instant).filter(Boolean).sort().at(-1) ?? null;
const STATES = ["running", "pr-open", "needs-human", "ready-for-human", "done"];
const progressKinds = ["verified-push", "published-result", "published-pr", "checks", "review", "delivery", "chain"];
const due = ["no-pr", "checks-red", "first-party-review-failed", "review-incomplete", "review-findings",
  "context-collision", "base-repair-unresolved", "stale-dispatch-policy", "result-verification", "conflict", "provider-network"];
const gates = ["physical-evidence", "passkey", "merge-decision", "release-decision", "iterations", "provider-network-exhausted",
  "no-credential", "dependency-auth", "permission-denied", "no-identity", "dispatch-refused", "prd-changed", "prd-illegal",
  "launch-preparation", "operator-interrupted", "cancelled", "cancellation-requested", "network-recovery-blocked", "verification-sandbox-unavailable"];
const recognized = new Set([...due, ...gates, "harness-error", "timeout", "stuck", "reviewer-blocking", "missing-ci",
  "reviewer-silent", "repeated-review-findings", "review-disagreement", "pr-identity", "run-stop-unverified"]);

export const currentReview = e => e.reviewBinding && e.firstPartyReview?.binding === e.reviewBinding &&
  e.reviewHead && e.reviewHead === e.cursor?.fixed_sha ? e.firstPartyReview : null;
export const currentHostReview = e => e.reviewBinding && e.reviewObservation?.binding === e.reviewBinding &&
  e.reviewObservation.head && e.reviewObservation.head === e.cursor?.fixed_sha ? e.reviewObservation : null;

function scope(id, e) {
  return hash([ref(id), ref(e.task?.id), Number.isSafeInteger(e.task?.revision) ? e.task.revision : null,
    ref(e.task?.digest), ref(e.prd_decision), ref(e.prd_fingerprint), ref(e.sources_digest)]);
}

// A finding ID and cited file are stable across wording/head changes. Different
// anchors stay separate; ambiguous or excess evidence never replenishes counters.
const LIMIT = 8;
function causes(e, host = currentHostReview(e)) {
  const review = currentReview(e);
  const found = [];
  if (review?.status === "completed" && review.result?.verdict === "findings") {
    const findings = review.result.findings;
    for (const [index, f] of (Array.isArray(findings) ? findings.slice(0, LIMIT + 1) : []).entries()) {
      const anchored = ref(f?.id) && ref(f.evidence?.path);
      found.push({ cause: "review-findings", anchor: anchored ? hash([f.id, f.evidence.path]) : hash(["unknown", ref(review.key), ref(review.binding), index]),
        uncertain: !anchored, evidence: "firstPartyReview" });
    }
  }
  if (count(host?.checks?.failed) > 0) found.push({ cause: "checks-red", anchor: ref(host.checks.failureDigest) || ref(host.head),
    evidence: "reviewObservation", uncertain: !host.checks.failureDigest });
  const reason = e.reason;
  if (e.base_merge?.conflict && e.base_merge.aborted !== true) {
    found.push({ cause: "base-repair-unresolved", evidence: "base_merge", uncertain: e.base_merge.aborted == null });
  }
  if (review?.status === "failed" || reason === "first-party-review-failed" && !clearReview(review)) {
    const code = ref(review?.errorCode);
    found.push({ cause: "first-party-review-failed", anchor: code || ref(review?.key) || ref(e.last?.run),
      evidence: "firstPartyReview", uncertain: !code });
  }
  if (validNetworkRetry(e.network_retry)) {
    found.push({ cause: "provider-network", anchor: e.network_retry.code, evidence: "network_retry" });
  } else if (recognized.has(reason) && !found.some(c => c.cause === reason) &&
      !(reason === "checks-red" && passing(host) || reason === "no-pr" && published(e) || reason === "first-party-review-failed" && clearReview(review)) &&
      !(reason === "repeated-review-findings" && found.some(c => c.cause === "review-findings"))) {
    const uncertain = ["stuck", "harness-error", "reviewer-blocking"].includes(reason);
    found.push({ cause: reason, anchor: uncertain ? ref(e.last?.run) : null, evidence: "last", uncertain });
  }
  return found;
}

function progress(e, before, checksHost) {
  const events = [];
  const add = (kind, value) => { const at = instant(value); if (at) events.push({ kind, at }); };
  const proof = e.verified_progress;
  if (verifiedProof(proof) && (!verifiedProof(before?.verified_progress) || proof.head !== before?.verified_progress?.head ||
      proof.kind !== before?.verified_progress?.kind)) add(proof.kind, proof.at);
  const review = currentReview(e), old = before && currentReview(before);
  if (review?.status === "completed" && ["findings", "clear"].includes(review.result?.verdict) &&
      (old?.status !== "completed" || review.binding !== old.binding || review.key !== old.key)) add("review", review.completedAt);
  const host = currentHostReview(e), prior = before && currentHostReview(before);
  if (host?.checks?.settled === true && count(host.checks.count) > 0 &&
      (prior?.head !== host.head || prior?.checks?.settled !== true)) add("checks", host.observedAt);
  const priorChecks = before?.reviewObservation;
  if (count(checksHost?.checks?.failed) > 0 && (priorChecks?.head !== checksHost.head ||
      priorChecks?.checks?.failed !== checksHost.checks.failed || priorChecks?.checks?.failureDigest !== checksHost.checks.failureDigest)) {
    add("checks", checksHost.observedAt);
  }
  if (["clear", "blocking"].includes(host?.external) && (prior?.head !== host.head || prior?.external !== host.external)) add("review", host.observedAt);
  if (matchingDeliveryEvidence(e) && (!before || !matchingDeliveryEvidence(before) ||
      before.completionEvidence.delivery.head !== e.completionEvidence.delivery.head)) add("delivery", e.completionEvidence.delivery.observedAt);
  const terminal = e.completionEvidence?.terminal;
  if (terminal && ["CLOSED", "MERGED"].includes(terminal.state) && terminal.pr === e.pr && terminal.repository === e.repo &&
      terminal.base === e.base && ref(terminal.head) && terminal.state !== before?.completionEvidence?.terminal?.state) {
    add("delivery", terminal.observedAt);
  }
  return events.sort((a, b) => b.at.localeCompare(a.at))[0] || null;
}

const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const digest = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const timeOrNull = v => v === null || typeof v === "string" && instant(v) === v;
const refOrNull = v => v === null || ref(v) !== null;
function supportedRecord(r) {
  return exact(r, ["version", "scope", "attempts", "recoveryAt", "progress", "incidents", "overflow"]) &&
    r.version === 1 && digest(r.scope) && count(r.attempts) === r.attempts && timeOrNull(r.recoveryAt) &&
    (r.progress === null || exact(r.progress, ["kind", "at"]) && progressKinds.includes(r.progress.kind) && typeof r.progress.at === "string" && instant(r.progress.at) === r.progress.at) &&
    typeof r.overflow === "boolean" && Array.isArray(r.incidents) && r.incidents.length <= LIMIT &&
    r.incidents.every(i => exact(i, ["id", "cause", "evidence", "run", "head", "reviewKey", "at", "attempts", "detail", "uncertain"]) &&
      digest(i.id) && recognized.has(i.cause) && ["reviewObservation", "firstPartyReview", "base_merge", "network_retry", "last"].includes(i.evidence) &&
      [i.run, i.head, i.reviewKey].every(refOrNull) && timeOrNull(i.at) && count(i.attempts) === i.attempts && refOrNull(i.detail) && typeof i.uncertain === "boolean");
}

function verifiedProof(proof) {
  return exact(proof, ["kind", "at", "head"]) && ["published-pr", "published-result", "verified-push"].includes(proof.kind) &&
    Boolean(instant(proof.at) && ref(proof.head));
}

function passing(host) {
  return host?.checks?.settled === true && count(host.checks.count) > 0 && !host.checks.failed;
}

function clearReview(review) {
  return review?.status === "completed" && review.result?.verdict === "clear" && Array.isArray(review.result.findings) &&
    !review.result.findings.length && Boolean(ref(review.key));
}

function published(e) {
  return Number.isSafeInteger(e.pr) && e.pr > 0 && verifiedProof(e.verified_progress) && e.verified_progress.kind !== "verified-push";
}

function provenClear(i, e, before) {
  if (i.cause === "checks-red") {
    const host = currentHostReview(e), old = before && currentHostReview(before);
    return passing(host) && (old?.head !== host.head || !passing(old));
  }
  if (i.cause === "no-pr") return published(e) && (!before || !published(before) || e.pr !== before.pr ||
    e.verified_progress.head !== before.verified_progress.head);
  if (["review-findings", "first-party-review-failed"].includes(i.cause)) {
    const review = currentReview(e), previous = before && currentReview(before);
    return clearReview(review) && (review.key !== previous?.key || !clearReview(previous));
  }
  return false;
}

function incidentTime(e, evidence) {
  switch (evidence) {
    case "reviewObservation": return instant(e.reviewObservation?.observedAt);
    case "firstPartyReview": return instant(e.firstPartyReview?.completedAt) || instant(e.last?.at);
    case "network_retry": return instant(e.network_retry?.first_at);
    case "base_merge": return instant(e.base_merge?.at);
    default: return instant(e.last?.at);
  }
}

function fold(id, e, before, saved, observedCheckHead) {
  const binding = scope(id, e), prior = saved?.scope === binding ? saved : null;
  const original = prior?.incidents ?? [];
  const run = ref(e.last?.run), newRun = Boolean(run && run !== before?.last?.run);
  const incidents = original.filter(i => !provenClear(i, e, before)).map(i => newRun ? { ...i, attempts: i.attempts + 1 } : i);
  let overflow = prior?.overflow ?? false;
  // Only the coordinator that just read this head can supply early failure
  // evidence. A saved stale observation cannot resolve a current incident.
  const checksHost = observedCheckHead && observedCheckHead === e.reviewObservation?.head && count(e.reviewObservation.checks?.failed) > 0
    ? e.reviewObservation : currentHostReview(e);
  for (const c of causes(e, checksHost)) {
    const key = hash([binding, c.cause, c.anchor ?? null]);
    if (incidents.some(i => i.id === key)) continue;
    if (incidents.length === LIMIT) { overflow = true; continue; }
    incidents.push({ id: key, cause: c.cause, evidence: c.evidence,
      run: ref(c.evidence === "network_retry" ? e.network_retry.run : c.evidence === "firstPartyReview" ? e.firstPartyReview?.run || e.last?.run : e.last?.run),
      head: ref(c.evidence === "reviewObservation" ? checksHost.head : e.cursor?.fixed_sha),
      reviewKey: ref(e.firstPartyReview?.key), at: incidentTime(e, c.evidence),
      attempts: 0, detail: c.evidence === "network_retry" ? e.network_retry.code : null,
      uncertain: Boolean(c.uncertain || c.cause === "review-findings" && original.some(i => i.cause === c.cause)) });
  }
  const event = progress(e, before, checksHost);
  const recoveryAt = latest(prior?.recoveryAt, e.control?.finished_at, e.control?.at, e.network_retry?.first_at,
    newRun ? e.last?.at : null, e.firstPartyReview?.startedAt,
    e.network_retry && before && (e.network_retry.phase !== before.network_retry?.phase || e.network_retry.attempts !== before.network_retry?.attempts) ? e.updated_at : null,
    e.execution?.acceptance && e.execution.acceptance !== before?.execution?.acceptance ? e.execution.observedAt : null,
    e.retry && (!before || e.retry.count !== before.retry?.count) ? e.updated_at : null);
  return { version: 1, scope: binding, attempts: (prior?.attempts ?? 0) + (newRun ? 1 : 0),
    recoveryAt, progress: event && (!prior?.progress || event.at > prior.progress.at) ? event : prior?.progress ?? null, incidents, overflow };
}

// Invoked under the existing registry lock. Fold the previous legacy value once
// before replacing it, including on a register/reset that replaces the entry.
export function recoveryRecord(id, entry, before = null, { observedCheckHead } = {}) {
  const saved = before?.recovery_record ?? entry.recovery_record;
  if (saved != null && (!supportedRecord(saved) || saved.scope !== scope(id, before || entry))) return saved;
  const prior = saved || (before ? fold(id, before, null, null) : null);
  return fold(id, entry, before, prior, observedCheckHead);
}

function classify(e, run, p, cause, nextAt, now, outstanding) {
  const ex = run?.execution || e.execution;
  if (!STATES.includes(e.state) || ex?.version != null && ex.version !== 1 ||
      ex?.providerState && !PROVIDER_STATES.includes(ex.providerState) ||
      ex?.acceptance && !["accepted", "unknown", "unsubmitted"].includes(ex.acceptance) ||
      e.network_retry && !validNetworkRetry(e.network_retry)) return "unsupported";
  if (e.verified_progress && !verifiedProof(e.verified_progress)) return "unsupported";
  const terminal = e.completionEvidence?.terminal;
  if (terminal && (!["MERGED", "CLOSED"].includes(terminal.state) || terminal.repository !== e.repo ||
      terminal.pr !== e.pr || !ref(terminal.head) || !e.base || terminal.base !== e.base)) return "unsupported";
  if (e.state === "needs-human" && e.reason && !recognized.has(e.reason) && !e.dispatch_stopped) return "unsupported";
  if (e.hold && (!exact(e.hold, ["active", "generation"]) || typeof e.hold.active !== "boolean" || count(e.hold.generation) !== e.hold.generation) ||
      e.recovery_profile && (!exact(e.recovery_profile, ["version", "digest"]) || e.recovery_profile.version !== 1 || !digest(e.recovery_profile.digest)) ||
      e.repository_disabled != null && typeof e.repository_disabled !== "boolean" ||
      e.control?.status && !["queued", "applying", "applied", "failed", "superseded"].includes(e.control.status)) return "unsupported";
  if (e.dispatch_stopped || e.hold?.active || e.repository_disabled || controlPending(e.control) ||
      gates.includes(e.reason) || ["exhausted", "blocked"].includes(e.network_retry?.phase) || p.divergence) return "authority-block";
  if (controlOwnership(e, run) !== "settled" || ex?.acceptance === "unknown") return "accepted-or-unknown";
  if (run?.running && run.id === e.last?.run || p.phase === "independent_review") return "active-healthy";
  if (ex && executionLive({ execution: ex })) return "accepted-or-unknown";
  if (e.state === "done") return outstanding ? "due-recovery" : "settled-history";
  if (p.terminal === "MERGED" || p.terminal === "CLOSED") return "due-recovery";
  if (e.state === "ready-for-human" || ["ci_wait", "remote_review"].includes(p.phase) ||
      nextAt && (!now || nextAt > now)) return "external-wait";
  if (p.phase === "delivery_ready") return "external-wait";
  if (e.network_retry?.phase === "launching") return "accepted-or-unknown";
  if (["credentials-unavailable", "quota-exhausted", "unsupported"].includes(p.providerStatus)) return "authority-block";
  if (["pending", "unavailable"].includes(p.providerStatus)) return "external-wait";
  if (due.includes(cause) || e.retry) return "due-recovery";
  if (e.state === "needs-human" && recognized.has(e.reason)) return "authority-block";
  if (e.state === "pr-open" && !e.reason && !cause) return "external-wait";
  return "unsupported";
}

export function recoveryObservation({ id, entry: e, run, phase, divergence, providerStatus, chains = [], obligations = [], now }) {
  // A historical attempt can be displayed alongside the task, but cannot
  // supply ownership or liveness for its current obligation.
  if (run?.id !== e.last?.run) run = null;
  const record = e.recovery_record ?? recoveryRecord(id, e);
  const valid = supportedRecord(record) && record.scope === scope(id, e);
  const incidents = valid ? record.incidents.map(i => ({ ...i })) : [];
  const ex = run?.execution || e.execution;
  const nextAt = instant(e.network_retry?.next_at) || (controlOwnership(e, run) !== "settled" ? instant(ex?.nextAttemptAt) : null);
  const terminal = e.completionEvidence?.terminal?.state;
  const chain = chains.find(c => c.current === id && !["cancelled", "done"].includes(c.status));
  const outstanding = Boolean(chain || e.workspace_cleanup?.status === "pending" || obligations.some(o => o.status === "pending"));
  const step = valid ? classify(e, run, { phase, divergence, terminal, providerStatus }, causes(e)[0]?.cause ?? incidents[0]?.cause,
    nextAt, instant(now), outstanding) : "unsupported";
  const chainAt = chains.reduce((at, c) => latest(at, c.mergedAt), null);
  const productiveAt = latest(valid ? record.progress?.at : null, chainAt);
  const repair = e.base_repair, network = e.network_retry;
  const recoveryStep = step === "unsupported" ? "inspect-record" : network && validNetworkRetry(network) ? network.phase
    : repair && ["prepared", "dispatching", "running", "blocked", "verified"].includes(repair.status) ? repair.status
    : controlPending(e.control) ? e.control.status : e.workspace_cleanup?.status === "pending" ? "awaiting-cleanup" : step;
  return { version: 1, mode: "observe", dispatchable: false, classification: step, step: recoveryStep, phase, task: ref(e.task?.id) || ref(id),
    revision: Number.isSafeInteger(e.task?.revision) ? e.task.revision : ref(e.prd_decision) || ref(e.prd_fingerprint), contractDigest: ref(e.prd_fingerprint), sourceDigest: ref(e.sources_digest),
    profileDigest: ref(e.recovery_profile?.digest), workspace: { worktree: e.worktree ? "entry.worktree" : null,
      branch: ref(e.branch), base: ref(e.base), head: ref(e.cursor?.fixed_sha) },
    execution: { epoch: Number.isSafeInteger(e.execution_epoch) ? e.execution_epoch : ex && e.execution_epoch == null ? 0 : null, run: ref(run?.id || e.last?.run), operation: ref(ex?.operationId),
      session: ref(ex?.sessionId || e.session), acceptance: ["unknown", "accepted", "unsubmitted"].includes(ex?.acceptance) ? ex.acceptance : null },
    control: { id: ref(e.control?.id), held: Boolean(e.hold?.active), generation: Number.isSafeInteger(e.hold?.generation) ? e.hold.generation : null,
      stopped: Boolean(e.dispatch_stopped), disabled: e.repository_disabled === true, cancellation: ref(ex?.cancellation?.status) },
    host: { pr: Number.isSafeInteger(e.pr) ? e.pr : null, cursor: instant(e.cursor?.since), terminal: ["MERGED", "CLOSED"].includes(terminal) ? terminal : null },
    review: { key: ref(e.firstPartyReview?.key), binding: ref(e.reviewBinding), checksHead: ref(e.cursor?.checks_sha) },
    resource: (e.workspace_cleanup?.resourceCode ?? e.base_merge?.resourceCode ?? e.resource?.code) === "ENOSPC" ? "ENOSPC" : null,
    obligations: { cleanup: ref(e.workspace_cleanup?.status), chain: ref(chain?.name || e.chain?.name), chainStatus: ref(chain?.status || chains[0]?.status),
      delivery: obligations.filter(o => o.status === "pending").slice(0, LIMIT).map(o => ref(o.id)) },
    observedAt: instant(now), recoveryAt: valid ? record.recoveryAt : null, productiveAt,
    progressSource: productiveAt && productiveAt === chainAt ? "chain" : valid ? record.progress?.kind ?? null : null,
    nextAt, provenance: network ? "automatic" : ["automatic", "operator"].includes(repair?.provenance) ? repair.provenance : e.control ? "operator" : null,
    attempts: valid ? record.attempts : null, retryAttempts: validNetworkRetry(network) ? network.attempts : null, incidents, uncertain: valid && (record.overflow || incidents.some(i => i.uncertain)) };
}
