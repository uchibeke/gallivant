import { needsFirstParty, reviewProgressText } from "../review_policy_contract.mjs";

// A read-only status projection. Review evidence and raw provider output can
// contain private source; neither belongs in a dashboard activity feed.
export function reviewActivity(entry) {
  if (!needsFirstParty(entry.reviewPolicy)) return { status: "unavailable", message: "No independent review is configured for this task." };
  const record = entry.firstPartyReview;
  if (!record) return { status: "waiting", message: "Waiting for independent review." };
  if (record.binding && entry.reviewBinding && record.binding !== entry.reviewBinding ||
    entry.reviewHead && entry.cursor?.fixed_sha && entry.reviewHead !== entry.cursor.fixed_sha) {
    return { status: "stale", message: "Historical review observation; current-head review is unknown." };
  }
  const pieces = Array.isArray(record.pieces) ? record.pieces : [];
  const current = pieces.findIndex(piece => piece?.status === "running");
  const verdict = record.status === "completed" ? record.result?.verdict : null;
  const reportedCount = record.result?.findingsCount;
  const count = verdict === "findings" ? Number.isSafeInteger(reportedCount) && reportedCount >= 0 ? reportedCount : Array.isArray(record.result?.findings) ? record.result.findings.length : "unknown" : 0;
  const status = ["waiting", "running", "completed", "failed", "incomplete"].includes(record.status) ? record.status : "unknown";
  const parts = [reviewProgressText({ ...entry, firstPartyReview: { ...record, status } })];
  if (current >= 0) parts.push(`reviewing job ${current + 1} of ${pieces.length}`);
  if (verdict === "findings") parts.push(`${count} finding${count === 1 ? "" : "s"}`);
  if (verdict === "clear") parts.push("review clear; other completion checks still apply");
  if (record.disposition?.status === "dispatched") parts.push("findings sent to agent");
  if (["failed", "incomplete"].includes(record.status) && record.error) parts.push("Review could not finish; inspect the saved review evidence.");
  return { status, message: parts.filter(Boolean).join("; ") };
}
