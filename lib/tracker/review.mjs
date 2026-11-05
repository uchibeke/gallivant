import { needsFirstParty, reviewProgressText } from "../review_policy.mjs";
import { redact } from "../execution_io.mjs";

// A read-only status projection. Review evidence and raw provider output can
// contain private source; neither belongs in a dashboard activity feed.
export function reviewActivity(entry) {
  if (!needsFirstParty(entry.reviewPolicy)) return { status: "unavailable", message: "No independent review is configured for this task." };
  const record = entry.firstPartyReview;
  if (!record) return { status: "waiting", message: "Waiting for independent review." };
  const pieces = Array.isArray(record.pieces) ? record.pieces : [];
  const current = pieces.findIndex(piece => piece.status === "running");
  const verdict = record.status === "completed" ? record.result?.verdict : null;
  const count = verdict === "findings" ? record.result?.findingsCount ?? (Array.isArray(record.result?.findings) ? record.result.findings.length : 0) : 0;
  const parts = [reviewProgressText(entry)];
  if (current >= 0) parts.push(`reviewing job ${current + 1} of ${pieces.length}`);
  if (verdict === "findings") parts.push(`${count} finding${count === 1 ? "" : "s"}`);
  if (verdict === "clear") parts.push("review clear; other completion checks still apply");
  if (record.disposition?.status === "dispatched") parts.push("findings sent to agent");
  if (["failed", "incomplete"].includes(record.status) && record.error) parts.push(redact(String(record.error)).slice(0, 500));
  return { status: record.status, message: parts.filter(Boolean).join("; ") };
}
