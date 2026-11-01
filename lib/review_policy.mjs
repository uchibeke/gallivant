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
