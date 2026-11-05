import { actor } from "../host_contract.mjs";

// Codex updates one GitHub issue comment in place. Only the code-review row's
// completion time establishes a new verdict; a later security-status edit must
// not make an old code review satisfy a newer request on the same commit.
export function githubReviewSummary(record) {
  const author = actor(record.user ?? record.author);
  if (!author.bot || author.login !== "chatgpt-codex-connector") return null;
  const body = String(record.body ?? "");
  if (!body.trimStart().startsWith("<!-- codex-pull-request-review-summary -->")) return null;
  const markers = [...body.matchAll(/<!-- codex-review-state:v1 ([\s\S]*?) -->/g)];
  if (markers.length !== 1 || markers[0][1].length > 32_768) return null;
  let state;
  try { state = JSON.parse(markers[0][1]); } catch { return null; }
  // Reject duplicate/contradictory keys instead of JSON.parse's last-key-wins
  // behavior. Whitespace outside strings is immaterial; ambiguous encodings
  // outside this compact machine format are not clearance evidence.
  const compact = markers[0][1].replace(/"(?:\\.|[^"\\])*"|\s+/g, token => token.startsWith('"') ? token : "");
  if (JSON.stringify(state) !== compact) return null;
  const review = state?.code_review;
  if (!review || review.status !== "completed" || review.has_any_findings !== false ||
      review.has_unresolved_findings !== false || !/^[a-f0-9]{40}$/.test(review.commit_sha ?? "")) return null;
  const rows = body.split("\n").filter(line => /^\|[^|]*\*\*Code Review\*\*[^|]*\|/.test(line));
  if (rows.length !== 1) return null;
  const columns = rows[0].split("|");
  if (!/✅\s*\*\*Completed\*\*/.test(columns[2] ?? "")) return null;
  const times = [...columns[2].matchAll(/<relative-time datetime="([^"]+)">/g)];
  const commit = columns[3]?.trim().match(/^`([a-f0-9]{7,40})`$/)?.[1];
  if (times.length !== 1 || !commit || !review.commit_sha.startsWith(commit)) return null;
  const at = times[0][1], parsed = Date.parse(at);
  const created = Date.parse(record.created_at ?? record.createdAt);
  const updated = Date.parse(record.updated_at ?? record.updatedAt ?? record.created_at ?? record.createdAt);
  // GitHub REST timestamps have second precision; the review row has fractions.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(at) ||
      !Number.isFinite(parsed) || !Number.isFinite(created) || !Number.isFinite(updated) ||
      Math.floor(parsed / 1000) < Math.floor(created / 1000) || Math.floor(parsed / 1000) > Math.floor(updated / 1000)) return null;
  return { at, headBinding: "exact", headSha: review.commit_sha, verdict: "clear" };
}
