// Portable policy shape validation; no registry or runtime imports.
export function reviewPolicyProblems(policy, requirements = {}) {
  const errors = [];
  if (policy.required_checks !== undefined && (!Array.isArray(policy.required_checks) || policy.required_checks.some(s => typeof s !== "string" || !s.trim()) || new Set(policy.required_checks).size !== policy.required_checks.length)) errors.push("required_checks must be unique non-empty check names");
  if (policy.trusted_authors !== undefined && (!Array.isArray(policy.trusted_authors) || policy.trusted_authors.some(s => typeof s !== "string" || !s.trim() || requirements.actorPattern && !new RegExp(requirements.actorPattern, "i").test(s)))) errors.push("trusted_authors must contain stable host actor identities");
  const reviewer = policy.reviewer;
  if (reviewer !== undefined && reviewer !== null) {
    if (typeof reviewer !== "object" || Array.isArray(reviewer)) return [...errors, "reviewer must be an object or null"];
    if (requirements.actorPattern && (typeof reviewer.actor_id !== "string" || !new RegExp(requirements.actorPattern, "i").test(reviewer.actor_id))) errors.push("reviewer.actor_id must be the stable host UUID, never a nickname or GitHub login");
    if (!requirements.actorPattern && !reviewer.login && !reviewer.actor_id) errors.push("reviewer needs login or actor_id");
    for (const key of ["rereview_comment", "blocking_pattern"]) if (typeof reviewer[key] !== "string" || !reviewer[key].trim()) errors.push(`reviewer.${key} must be explicit and non-empty`);
    if (requirements.explicitVerdict && /@codex\s+review/i.test(reviewer.rereview_comment ?? "")) errors.push("reviewer.rereview_comment must use the configured host review producer; the GitHub mention is unsupported");
    for (const key of ["blocking_pattern", "reviewed_commit_pattern"]) if (reviewer[key] !== undefined) {
      try { if (typeof reviewer[key] !== "string") throw new Error(); new RegExp(reviewer[key]); } catch { errors.push(`reviewer.${key} must be a valid regex`); }
    }
  }
  return errors;
}
