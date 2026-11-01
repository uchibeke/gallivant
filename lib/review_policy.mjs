// Policy is operator-owned state, never PR text or a model's proposed settings.
import { createHash } from "node:crypto";

export const REVIEW_MODES = ["external-required", "first-party-required", "both-required"];
export const REVIEW_DEFAULTS = Object.freeze({ mode: null, route: null, specialist: null, legacy_no_review: false,
  timeout_ms: 180_000, max_jobs: 4, retries: 1, budget_usd: 4, max_input_bytes: 100_000, zero_checks: false });
export const reviewError = (code, detail) => Object.assign(new Error(detail), { code });
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export const reviewDigest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
export const needsFirstParty = policy => policy?.version === 1 && ["first-party-required", "both-required"].includes(policy.mode);
export const needsExternal = policy => policy?.mode === "external-required" || policy?.mode === "both-required" || policy?.version === 0 && !!policy.external;
export function reviewSettings(config, repo) {
  const selected = config.repos?.find(r => typeof r === "object" && r.repo?.toLowerCase() === repo?.toLowerCase());
  return { ...REVIEW_DEFAULTS, ...config.review, ...selected?.review };
}
export function validateReviewSettings(s) {
  if (Object.keys(s).some(k => !Object.hasOwn(REVIEW_DEFAULTS, k))) throw reviewError("REVIEW_POLICY", "unknown review configuration key");
  if (s.mode !== null && !REVIEW_MODES.includes(s.mode)) throw reviewError("REVIEW_POLICY", "review.mode must select exactly one supported review policy");
  if (s.route !== null && !["codex"].includes(s.route)) throw reviewError("REVIEW_ROUTE", "only the restricted codex reviewer route is implemented; other routes are unqualified");
  if (s.specialist !== null && !["security", "regression"].includes(s.specialist)) throw reviewError("REVIEW_POLICY", "select at most one specialist: security or regression");
  for (const k of ["legacy_no_review", "zero_checks"]) if (typeof s[k] !== "boolean") throw reviewError("REVIEW_POLICY", `review.${k} must be boolean`);
  for (const [k, min, max] of [["timeout_ms", 1000, 900_000], ["max_jobs", 1, 20], ["retries", 0, 3], ["max_input_bytes", 1024, 100_000]]) {
    if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) throw reviewError("REVIEW_POLICY", `review.${k} must be an integer between ${min} and ${max}`);
  }
  if (!Number.isFinite(s.budget_usd) || s.budget_usd <= 0 || s.budget_usd > 100) throw reviewError("REVIEW_POLICY", "review.budget_usd must be positive and at most 100");
  if (s.legacy_no_review && s.mode) throw reviewError("REVIEW_POLICY", "legacy_no_review cannot be combined with a required review policy");
  return s;
}
export function assertReviewPolicy(p) {
  if (!p || ![0, 1].includes(p.version)) throw reviewError("REVIEW_POLICY", "unsupported saved review policy; restore the original coordinator record");
  if (p.version === 0) {
    if (p.mode !== null || typeof p.disclosure !== "string" || p.external !== null && !p.external?.login) throw reviewError("REVIEW_POLICY", "invalid legacy review policy");
    return p;
  }
  if (!REVIEW_MODES.includes(p.mode) || needsExternal(p) && !p.external?.login || needsFirstParty(p) && (p.route?.name !== "codex" || !/^[a-f0-9]{64}$/.test(p.route?.fingerprint || "") || !p.route?.qualification)) throw reviewError("REVIEW_POLICY", "saved review requirement or qualified route is missing");
  validateReviewSettings({ ...REVIEW_DEFAULTS, mode: p.mode, route: p.route?.name || null, specialist: p.specialist, zero_checks: p.zeroChecks,
    timeout_ms: p.limits?.timeoutMs, max_jobs: p.limits?.maxJobs, retries: p.limits?.retries, budget_usd: p.limits?.budgetUsd, max_input_bytes: p.limits?.maxInputBytes });
  return p;
}
export function legacyReviewPolicy(config) {
  return { version: 0, mode: null, external: structuredClone(config.reviewer ?? null), route: null,
    disclosure: config.reviewer ? "legacy external review requirement" : "legacy no-review: no semantic review required or claimed" };
}
export function selectReviewPolicy(config, repo, qualification = null) {
  const s = validateReviewSettings(reviewSettings(config, repo));
  if (s.legacy_no_review) {
    if (config.reviewer) throw reviewError("REVIEW_POLICY", "legacy_no_review requires reviewer: null explicitly");
    return legacyReviewPolicy(config);
  }
  const mode = s.mode || (config.reviewer ? "external-required" : "first-party-required");
  if (["external-required", "both-required"].includes(mode) && !config.reviewer?.login) throw reviewError("REVIEW_POLICY", "required external actor is missing; configure reviewer or explicitly change policy");
  const internal = mode !== "external-required";
  if (internal && (!s.route || qualification?.route !== s.route || qualification?.qualified !== true || !qualification?.fingerprint || !qualification?.run)) {
    throw reviewError("REVIEW_UNQUALIFIED", "first-party review requires a qualified route; run review qualify --run, then retry start. Explicit legacy_no_review with reviewer: null is the legacy escape path");
  }
  return { version: 1, mode, external: structuredClone(config.reviewer ?? null),
    route: internal ? { name: s.route, fingerprint: qualification.fingerprint, qualification: qualification.run } : null,
    specialist: s.specialist, limits: { timeoutMs: s.timeout_ms, maxJobs: s.max_jobs, retries: s.retries, budgetUsd: s.budget_usd, maxInputBytes: s.max_input_bytes },
    zeroChecks: s.zero_checks };
}
export function policyConfig(config, entry) {
  return entry.reviewPolicy ? { ...config, reviewer: entry.reviewPolicy.external } : config;
}
export function reviewBinding(pr, policy) {
  return reviewDigest({ head: pr.headRefOid, base: pr.baseRefOid ?? null, baseName: pr.baseRefName,
    body: pr.body, checks: [...(pr.statusCheckRollup || [])].map(canonical).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), policy });
}
export function reviewVerdict(policy, external, record, binding) {
  if (policy) assertReviewPolicy(policy);
  if (!policy || policy.version === 0) return external;
  if (external.verdict === "blocking") return external;
  if (needsFirstParty(policy)) {
    if (record?.status === "failed" || record?.status === "incomplete") return { verdict: "failed", note: record.error || "first-party review incomplete" };
    if (record?.binding !== binding || record?.status !== "completed") return { verdict: "waiting", note: "first-party review pending" };
    if (record.result.verdict === "findings") return { verdict: "blocking", note: "first-party review findings" };
  }
  if (needsExternal(policy) && external.verdict !== "clear") return external.verdict === "none" ? { verdict: "waiting", note: "required external reviewer absent" } : external;
  return { verdict: "clear", note: needsFirstParty(policy) ? (needsExternal(policy) ? "first-party review and configured external review" : "first-party review (coordinator record; no Git-host bot approval)") : external.note };
}
export function reviewDisclosure(entry) {
  const p = entry.reviewPolicy;
  if (p?.version === 0) return p.disclosure;
  if (!p) return "legacy review policy not yet snapshotted";
  return `${p.mode}${entry.firstPartyReview ? `; first-party review ${entry.firstPartyReview.status}` : ""}`;
}
