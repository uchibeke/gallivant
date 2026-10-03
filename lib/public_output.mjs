// Public prose is about the change, not the runner. This is a formatting policy, not a network boundary: sessions
// still have their own GitHub tools. The daemon validates what they actually published before signalling readiness.
import { shortHash } from "./hash.mjs";

const BRAND = /gallivant/i;

export function publicTextViolation(value, field = "text") {
  const text = String(value ?? "");
  return BRAND.test(text) ? `${field} mentions the runner name` : null;
}

/** Validate daemon-authored text before an outbound write. Never rewrite prose, evidence, URLs or quoted findings. */
export function assertPublicText(value, field = "text") {
  const violation = publicTextViolation(value, field);
  if (violation) throw new Error(`Public text rejected: ${violation}. Describe the change without runner branding.`);
  return value;
}

export const publicPrViolations = pr => [
  publicTextViolation(pr.title, "PR title"),
  publicTextViolation(pr.body, "PR body"),
].filter(Boolean);

export function publicCommentViolations(comments) {
  return comments.map(c => publicTextViolation(c.body, `${c.public_kind ?? (c.path ? "inline" : "PR")} comment ${c.id}`)).filter(Boolean);
}

/** Only comments selected by the caller's ownership and rollout-time checks belong in this fingerprint. */
export const publicReviewHash = (pr, comments = []) => shortHash(JSON.stringify({
  title: pr.title ?? "", body: pr.body ?? "",
  comments: comments.map(c => [c.public_kind ?? (c.path ? "inline" : "issue"), String(c.id), c.body ?? ""]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
}));

export function publicCorrection(violations) {
  return [
    "The published pull request does not meet the public text policy:",
    ...violations.map(v => `- ${v}`),
    "Edit the existing PR title/body or your identified comments to describe the actual change without mentioning Gallivant (case-insensitive). Preserve accurate evidence, criterion outcomes and limitations; use another concrete evidence pointer when a path contains the name. Do not invent passing evidence, rewrite commits, open another PR, or remove the completion receipt. Machine metadata is managed separately. A wording-only correction needs no new commit.",
  ].join("\n");
}
