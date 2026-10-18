// Only terminal local harness errors qualify. Unknown remote acceptance is owned
// by the execution transport and must never be turned into a second submission.
export const NETWORK_RETRY_DELAYS = Object.freeze([60_000, 300_000, 900_000]);
export const NETWORK_RECOVERY_WINDOW = 60 * 60_000;
const CODES = /\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)\b/;

export function networkFailure(outcome) {
  if (outcome?.ok !== false || outcome.finished !== true || outcome.denials?.length) return null;
  const text = outcome.error;
  if (typeof text !== "string" || text.length > 512 || /auth|credential|permission|denied|policy|quota|budget|rate.limit|\b(?:401|403|429)\b/i.test(text)) return null;
  // Do not classify arbitrary assistant prose, successful output, tool logs, or
  // a generic "no result" as a retry instruction.
  if (!/^(?:API Error:|Error:|(?:getaddrinfo|connect|read)\s|ENOTFOUND\b|EAI_AGAIN\b|ECONNRESET\b|ECONNREFUSED\b|ETIMEDOUT\b)/.test(text)) return null;
  return text.match(CODES)?.[1] ?? null;
}

export function needsAgentResume(entry) {
  return Boolean(entry.network_retry) || entry.reason === "harness-error" ||
    Boolean(entry.last?.exit && networkFailure({ ok: false, finished: true, error: entry.last.error }));
}

export function validNetworkRetry(retry) {
  return retry && Number.isInteger(retry.attempts) && retry.attempts >= 0 && retry.attempts <= NETWORK_RETRY_DELAYS.length &&
    Number.isFinite(Date.parse(retry.first_at)) && typeof retry.run === "string" && retry.run.length > 0 &&
    /^(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(retry.code) &&
    ["waiting", "launching", "running", "blocked", "exhausted"].includes(retry.phase) &&
    (retry.phase !== "waiting" || retry.attempts < NETWORK_RETRY_DELAYS.length && Number.isFinite(Date.parse(retry.next_at)));
}

export function networkRecoveryDetail(retry) {
  const count = `${retry.attempts}/${NETWORK_RETRY_DELAYS.length}`;
  if (retry.phase === "waiting") return `waiting for API connectivity (${retry.code}); ${count} retries used; next ${retry.next_at}`;
  if (retry.phase === "running") return `same-session network recovery ${count} after ${retry.code}`;
  if (retry.phase === "launching") return `network recovery launch unconfirmed (${retry.code}); inspect the existing run before resuming`;
  return `network recovery stopped (${retry.code}); ${count} retries used; inspect gallivant why before resuming`;
}
