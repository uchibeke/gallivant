// Only terminal local harness errors qualify. Unknown remote acceptance is owned
// by the execution transport and must never be turned into a second submission.
export const NETWORK_RETRY_DELAYS = Object.freeze([60_000, 300_000, 900_000]);
export const NETWORK_RECOVERY_WINDOW = 60 * 60_000;
const NETWORK_PLAN = Object.freeze({ delays: NETWORK_RETRY_DELAYS, window: NETWORK_RECOVERY_WINDOW, kind: "connectivity" });
const CAPACITY_PLAN = Object.freeze({ delays: Object.freeze([60_000, 300_000, ...Array(10).fill(900_000)]), window: 2 * 60 * 60_000, kind: "provider availability" });
const CAPACITY_ERRORS = new Map([
  ["Selected model is at capacity. Please try a different model.", "MODEL_CAPACITY"],
  ["The model is currently overloaded. Please try again later.", "SERVICE_BUSY"],
  ["503 Service Unavailable", "SERVICE_BUSY"],
  ["Service unavailable", "SERVICE_BUSY"],
  ["Server is busy. Please try again later.", "SERVICE_BUSY"],
  ["429 Too Many Requests", "RATE_LIMITED"],
  ["Too many requests. Please try again later.", "RATE_LIMITED"],
]);
const CAPACITY_CODES = new Set(CAPACITY_ERRORS.values());
export const retryPlan = code => CAPACITY_CODES.has(code) ? CAPACITY_PLAN : NETWORK_PLAN;
const CODES = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/;

export function networkFailure(outcome) {
  if (outcome?.ok !== false || outcome.finished !== true || outcome.denials?.length) return null;
  const text = outcome.error;
  if (typeof text !== "string" || text.length > 512 || /auth|credential|permission|denied|policy|quota|budget|rate.limit|usage|exhaust|billing|credits?|login|token|\b(?:401|403|429)\b/i.test(text)) return null;
  // Do not classify arbitrary assistant prose, successful output, tool logs, or
  // a generic "no result" as a retry instruction.
  if (!/^(?:API Error:|Error:|(?:getaddrinfo|connect|read)\s|ENOTFOUND\b|EAI_AGAIN\b|ECONNRESET\b|ECONNREFUSED\b|ETIMEDOUT\b)/.test(text)) return null;
  return text.match(CODES)?.[1] ?? null;
}

// These are terminal harness error fields, never assistant text or tool output.
// An explicit allowlist avoids treating quota/auth failures or arbitrary retry
// instructions as permission to incur another paid invocation. No model switch
// suggested by an error is acted on.
export function capacityFailure(outcome) {
  if (outcome?.ok !== false || outcome.finished !== true || outcome.denials?.length || typeof outcome.error !== "string" || outcome.error.length > 512) return null;
  const text = outcome.error.replace(/^(?:API Error:|Error:)\s*/, "");
  return CAPACITY_ERRORS.get(text) ?? null;
}
export const transientProviderFailure = outcome => networkFailure(outcome) ?? capacityFailure(outcome);

export function needsAgentResume(entry) {
  return Boolean(entry.network_retry) || entry.reason === "harness-error" ||
    Boolean(entry.last?.exit && transientProviderFailure({ ok: false, finished: true, error: entry.last.error }));
}

// Embedders must keep waking a pending recovery even though the stored review
// state is needs-human. Actual blocked/exhausted stops still require an operator.
export const networkRecoveryPending = entry => Boolean(entry?.network_retry && entry.reason === "provider-network" &&
  !entry.dispatch_stopped && entry.state !== "done" && !["running", "blocked", "exhausted"].includes(entry.network_retry.phase));

export function validNetworkRetry(retry) {
  const plan = retryPlan(retry?.code);
  return retry && Number.isInteger(retry.attempts) && retry.attempts >= 0 && retry.attempts <= plan.delays.length &&
    Number.isFinite(Date.parse(retry.first_at)) && typeof retry.run === "string" && retry.run.length > 0 &&
    (/^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(retry.code) || CAPACITY_CODES.has(retry.code)) &&
    ["reconciling", "waiting", "launching", "running", "blocked", "exhausted"].includes(retry.phase) &&
    (retry.phase !== "waiting" || retry.attempts < plan.delays.length && Number.isFinite(Date.parse(retry.next_at)));
}

export function networkRecoveryDetail(retry) {
  const plan = retryPlan(retry.code);
  const count = `${retry.attempts}/${plan.delays.length}`;
  if (retry.phase === "reconciling") return `checking published progress after ${retry.code}; no retry authorized`;
  if (retry.phase === "waiting") return `waiting for ${plan.kind === "connectivity" ? "API connectivity" : plan.kind} (${retry.code}); ${count} retries used; next ${retry.next_at}`;
  if (retry.phase === "running") return `same-session provider recovery ${count} after ${retry.code}`;
  if (retry.phase === "launching") return `provider recovery launch unconfirmed (${retry.code}); inspect the existing run before resuming`;
  return `provider recovery stopped (${retry.code}); ${count} retries used; inspect gallivant why before resuming`;
}
