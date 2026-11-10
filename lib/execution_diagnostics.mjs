// Additive local evidence only. These fields never authorize a transition.
import { redact } from "./execution_io.mjs";

export const RECOVERY_REASONS = Object.freeze({
  launchCircuit: "three launch reconciliation failures; inspect the recorded dispatch key and repair access before explicitly resetting recovery; input was not resent",
  observationCircuit: "three reconciliation failures; repair access/configuration, then explicitly reset recovery without resending input",
  preInput: "session creation recovered before any input send; preserve the saved session and dispatch evidence for operator review; input acceptance and charge remain unverified; reset cannot authorize sending input",
  legacyPreInput: "session creation recovered before any input send; inspect the saved session and explicitly authorize recovery; no implementation was launched",
  failedSession: "session failed before launch acknowledgement; recover saved outputs and repair setup; no automatic reconnect or replacement",
  environment: "session/environment unavailable; saved files remain recoverable, filesystem continuity is unverified; no automatic replacement session",
});
const retryBlocks = [RECOVERY_REASONS.launchCircuit, RECOVERY_REASONS.observationCircuit];
const terminalErrors = ["AGENTS_PROTOCOL", "AGENTS_ID", "EXECUTION_OWNERSHIP", "EXECUTION_POLICY", "TASK_PREPARATION_BOUNDARY"];
export const observationRetryAllowed = op => Boolean(op && !op.sessionFailed &&
  !["failed", "expired", "deleted"].includes(op.environmentState) &&
  (!op.recoveryBlocked || retryBlocks.includes(op.recoveryBlocked)) &&
  !terminalErrors.includes(op.recoveryErrorCode) && (op.recoveryResets?.length || 0) < 32);

const safeCodes = new Set([
  "AGENTS_AUTH", "AGENTS_THROTTLED", "AGENTS_HTTP", "AGENTS_TRANSPORT", "AGENTS_PROTOCOL", "AGENTS_ID", "AGENTS_SIZE",
  "AGENTS_ENVIRONMENT", "AGENTS_RECOVERY_REQUIRED", "AGENTS_MODEL", "AGENTS_PATH", "AGENTS_SOURCE",
  "EXECUTION_OWNERSHIP", "EXECUTION_POLICY", "EXECUTION_UNKNOWN", "EXECUTION_PROTOCOL", "EXECUTION_STALE",
  "EXECUTION_DEADLINE", "EXECUTION_ABORTED", "EXECUTION_RESULT", "EXECUTION_CONTROL", "EXECUTION_ACTION",
  "EXECUTION_CONFLICT", "TASK_PREPARATION_BOUNDARY",
  "CLOUD_AUTH", "CLOUD_ACCESS", "CLOUD_VERSION", "CLOUD_LIST", "CLOUD_PROTOCOL", "CLOUD_NOT_FOUND", "CLOUD_SIZE",
  "CLOUD_SOURCE", "CLOUD_DISPATCH_UNAVAILABLE", "EXECUTION_VERIFICATION_SANDBOX",
]);
const providerCodes = new Set(["rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "model_not_found", "server_error", "invalid_request_error"]);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) ? value : null;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const presence = value => typeof value === "boolean" ? value : null;
// Never copy arbitrary error messages, response bodies or nested provider data.
export function safeProviderError(error) {
  if (!error || typeof error !== "object") return null;
  const httpStatus = Number.isInteger(error.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599 ? error.httpStatus : null;
  return redact({ code: safeCodes.has(error.code) ? error.code : null,
    providerCode: providerCodes.has(error.providerCode) ? error.providerCode : providerCodes.has(error.code) ? error.code : null,
    httpStatus, httpClass: httpStatus ? `${Math.floor(httpStatus / 100)}xx` : ["4xx", "5xx"].includes(error.httpClass) ? error.httpClass : null,
    requestId: identifier(error.requestId),
  });
}

export function recoveryDiagnostics(op, { unavailable = false, stopped = false, recoveryAvailable = true } = {}) {
  const preInput = [RECOVERY_REASONS.preInput, RECOVERY_REASONS.legacyPreInput].includes(op?.recoveryBlocked) ||
    Boolean(op?.sessionId && op.sendIntent === false && op.sendAcknowledged === false && !op.turnId);
  const circuit = retryBlocks.includes(op?.recoveryBlocked);
  const ownedRoot = Boolean(op?.acceptance === "accepted" && identifier(op.runId) && identifier(op.sessionId) && identifier(op.turnId));
  const stage = unavailable ? "unavailable" : !op ? "dispatch-missing" : preInput ? "session-before-input" :
    circuit ? "recovery-circuit-blocked" : ownedRoot ? "root-owned" : op.sendAcknowledged === true ? "input-acknowledged-root-unowned" :
    op.sendIntent === true ? "send-intent-unacknowledged" : "unknown";
  const reason = preInput ? "pre-input-review-required" : circuit ? "observation-retry-exhausted" :
    op?.sessionFailed || ["failed", "expired", "deleted"].includes(op?.environmentState) ? "session-unavailable" :
    op?.recoveryBlocked ? "saved-refusal" : null;
  const retry = !unavailable && !stopped && !preInput && recoveryAvailable && observationRetryAllowed(op);
  return redact({ version: 1, source: "saved-local", stage,
    sendIntent: presence(op?.sendIntent), sendAcknowledged: presence(op?.sendAcknowledged),
    recoveryReason: reason,
    identifiers: { runId: identifier(op?.runId), sessionId: identifier(op?.sessionId), rootTurnId: ownedRoot ? identifier(op.turnId) : null },
    timestamps: { createdAt: timestamp(op?.createdAt), sessionSavedAt: timestamp(op?.sessionSavedAt),
      sendIntentAt: timestamp(op?.sendIntentAt), sendAcknowledgedAt: timestamp(op?.sendAcknowledgedAt), rootOwnedAt: timestamp(op?.rootOwnedAt) },
    error: safeProviderError(op?.recoveryError || (op?.recoveryErrorCode ? { code: op.recoveryErrorCode } : op?.error)),
    actions: [{ code: "inspect-local", effect: "local-read" }, ...(retry ? [{ code: "retry-observation", effect: "remote-reconciliation", requiresExplicitAuthorization: true }] : [])],
    nextAction: preInput ? "Preserve the session and dispatch records for operator review. Input acceptance and billing evidence are missing; reset cannot send input. Keep needs-human." :
      retry ? "Repair access if needed, then explicitly request observation recovery of this exact operation. This does not authorize input resubmission." :
      ownedRoot && !op?.recoveryBlocked && !stopped ? "Inspect saved progress for the owned root. Local inspection does not refresh provider status or authorize new input." :
      "Preserve the saved operation and repair missing ownership, access or terminal evidence with the operator. Keep needs-human while recovery is unproved.",
    acceptanceAndCharge: "not-established-by-local-inspection",
  });
}
