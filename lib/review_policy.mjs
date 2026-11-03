import { reviewPolicyProblems } from "./review_policy_contract.mjs";
export { reviewPolicyProblems } from "./review_policy_contract.mjs";
import { repositoryIdentity } from "./repository.mjs";
import { HOST_DEFINITIONS } from "./host_definitions.mjs";

// Legacy defaults belong only to the adapter that originally defined them.
// Other adapters require an explicit policy, including an explicit null reviewer.
export function repositoryReviewConfig(config, repo, definition = null) {
  const repository = repositoryIdentity(repo);
  const adapter = definition ?? HOST_DEFINITIONS.find(d => d.host === repository.host);
  const host = config.git_hosts?.[repository.host] ?? {};
  const entry = (Array.isArray(config.repos) ? config.repos : []).find(r => {
    try { return repositoryIdentity(typeof r === "string" ? r : r.repo).key === repository.key; } catch { return false; }
  });
  const policy = { ...(adapter?.features?.legacyReviewDefaults ? {
    reviewer: config.reviewer, trusted_authors: config.trusted_authors,
    required_checks: config.required_checks ?? [],
  } : {}), ...pick(host), ...pick(host.repositories?.[repository.path]), ...pick(entry) };
  if (!Object.hasOwn(policy, "reviewer")) throw new Error(`${repository.key}: configure an explicit repository/host reviewer with a stable actor_id, or reviewer: null for CI and trusted commands only; no cross-host reviewer default is used`);
  if (!Array.isArray(policy.trusted_authors) || !policy.trusted_authors.length || policy.trusted_authors.some(v => typeof v !== "string" || !v.trim())) throw new Error(`${repository.key}: trusted_authors must name stable host identities`);
  policy.required_checks ??= [];
  const problems = reviewPolicyProblems(policy, adapter?.reviewPolicy);
  if (problems.length) throw new Error(`${repository.key}: ${problems.join("; ")}`);
  return { ...config, ...policy };
}

const pick = value => Object.fromEntries(["reviewer", "trusted_authors", "required_checks"].filter(k => value && Object.hasOwn(value, k)).map(k => [k, value[k]]));
// Policy is operator-owned state, never PR text or a model's proposed settings.
import { createHash } from "node:crypto";

export const REVIEW_MODES = ["external-required", "first-party-required", "both-required"];
export const REVIEW_DEFAULTS = Object.freeze({ mode: null, route: null, specialist: null, legacy_no_review: false,
  timeout_ms: 900_000, max_jobs: 2048, retries: 2, budget_usd: 100, max_input_bytes: 100_000, zero_checks: false });
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
  for (const [k, min, max] of [["timeout_ms", 1000, 3_600_000], ["max_jobs", 1, 8192], ["retries", 0, 3], ["max_input_bytes", 1024, 100_000]]) {
    if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) throw reviewError("REVIEW_POLICY", `review.${k} must be an integer between ${min} and ${max}`);
  }
  if (!Number.isFinite(s.budget_usd) || s.budget_usd <= 0 || s.budget_usd > 10_000) throw reviewError("REVIEW_POLICY", "review.budget_usd must be positive and at most 10000");
  if (s.legacy_no_review && s.mode) throw reviewError("REVIEW_POLICY", "legacy_no_review cannot be combined with a required review policy");
  return s;
}
export function assertReviewPolicy(p) {
  if (!p || ![0, 1].includes(p.version)) throw reviewError("REVIEW_POLICY", "unsupported saved review policy; restore the original coordinator record");
  if (p.version === 0) {
    if (p.mode !== null || typeof p.disclosure !== "string" || p.external !== null && !(p.external?.login || p.external?.actor_id)) throw reviewError("REVIEW_POLICY", "invalid legacy review policy");
    return p;
  }
  if (!REVIEW_MODES.includes(p.mode) || needsExternal(p) && !(p.external?.login || p.external?.actor_id) || needsFirstParty(p) && (p.route?.name !== "codex" || !/^[a-f0-9]{64}$/.test(p.route?.fingerprint || "") || !p.route?.qualification)) throw reviewError("REVIEW_POLICY", "saved review requirement or qualified route is missing");
  validateReviewSettings({ ...REVIEW_DEFAULTS, mode: p.mode, route: p.route?.name || null, specialist: p.specialist, zero_checks: p.zeroChecks,
    timeout_ms: p.limits?.timeoutMs, max_jobs: p.limits?.maxJobs, retries: p.limits?.retries, budget_usd: p.limits?.budgetUsd, max_input_bytes: p.limits?.maxInputBytes });
  return p;
}
export function legacyReviewPolicy(config) {
  return { version: 0, mode: null, external: structuredClone(config.reviewer ?? null), route: null,
    disclosure: config.reviewer ? "legacy external review requirement" : "legacy no-review: no semantic review required or claimed" };
}
export function effectiveReviewMode(config, repo, settings = reviewSettings(config, repo)) {
  if (settings.legacy_no_review) return null;
  if (settings.mode) return settings.mode;
  if (repositoryReviewConfig(config, repo).reviewer) return "external-required";
  const adapter = HOST_DEFINITIONS.find(d => d.host === repositoryIdentity(repo).host);
  return adapter?.features?.legacyReviewDefaults ? "first-party-required" : null;
}
export function selectReviewPolicy(config, repo, qualification = null, overrides = {}) {
  const scoped = repositoryReviewConfig(config, repo);
  const s = validateReviewSettings({ ...reviewSettings(config, repo), ...overrides });
  if (s.legacy_no_review && scoped.reviewer) throw reviewError("REVIEW_POLICY", "legacy_no_review requires reviewer: null explicitly");
  const mode = effectiveReviewMode(config, repo, s);
  if (!mode) return legacyReviewPolicy(scoped);
  if (["external-required", "both-required"].includes(mode) && !(scoped.reviewer?.login || scoped.reviewer?.actor_id)) throw reviewError("REVIEW_POLICY", "required external actor is missing; configure reviewer or explicitly change policy");
  const internal = mode !== "external-required";
  if (internal && (!s.route || qualification?.route !== s.route || qualification?.qualified !== true || !qualification?.fingerprint || !qualification?.run)) {
    throw reviewError("REVIEW_UNQUALIFIED", "first-party review requires a qualified route; run review qualify --run, then retry start. Explicit legacy_no_review with reviewer: null is the legacy escape path");
  }
  return { version: 1, mode, external: structuredClone(scoped.reviewer ?? null),
    route: internal ? { name: s.route, fingerprint: qualification.fingerprint, qualification: qualification.run } : null,
    specialist: s.specialist, limits: { timeoutMs: s.timeout_ms, maxJobs: s.max_jobs, retries: s.retries, budgetUsd: s.budget_usd, maxInputBytes: s.max_input_bytes },
    zeroChecks: s.zero_checks };
}
export function policyConfig(config, entry) {
  const scoped = entry.repo ? repositoryReviewConfig(config, entry.repo) : config;
  return entry.reviewPolicy ? { ...scoped, reviewer: entry.reviewPolicy.external } : scoped;
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

export function reviewProgressText(entry) {
  const record = entry.firstPartyReview;
  if (!needsFirstParty(entry.reviewPolicy)) return "";
  if (!record) return "awaiting independent review";
  const pieces = record.pieces || [], done = pieces.filter(p => p.status === "completed").length;
  return `${record.phase === "whole-pr-review" ? "whole-PR review" : "source review"}: ${record.status}${pieces.length ? `; ${done}/${pieces.length} jobs complete` : ""}`;
}
