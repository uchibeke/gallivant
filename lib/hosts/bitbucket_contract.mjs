import { reviewPolicyProblems } from "../review_policy_contract.mjs";
import { repositoryIdentity, parsePullRequestUrl } from "../repository.mjs";

export const BITBUCKET_GATE = "Bitbucket Cloud transport is available, but task dispatch is disabled until git-host-bitbucket qualifies review, CI and completion semantics. Use init or doctor to check repository access; do not start or register tasks yet.";
export function parseBitbucketPr(url) {
  try {
    const { host, pathname } = parsePullRequestUrl(url);
    const m = pathname.match(/^([^/]+\/[^/]+)\/pull-requests\/([1-9]\d*)\/?$/);
    if (host !== "bitbucket.org" || !m || !Number.isSafeInteger(Number(m[2]))) return null;
    return { repo: repositoryIdentity(m[1], host).key, number: Number(m[2]) };
  } catch { return null; }
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const BITBUCKET_REVIEW_POLICY = Object.freeze({ actorPattern: "^\\{[0-9a-f-]{36}\\}$", explicitVerdict: true });
export const bitbucketDefinition = Object.freeze({
  host: "bitbucket.org", id: "bitbucket-pull-request", dataContract: "host-records-v1",
  dispatch: false, dispatchReason: BITBUCKET_GATE,
  reviewPolicy: BITBUCKET_REVIEW_POLICY,
  capabilities: Object.freeze({ pullRequests: true, comments: true, diff: true, reviews: true, checks: true, mergeProof: true, recovery: true, labels: false }),
  features: Object.freeze({ learning: false, rulesets: false, repositoryScopes: false, transportSetup: true, strictIdentity: true }),
  validateConfig: settings => {
    const errors = [];
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return ["Bitbucket host settings must be an object"];
    if (Object.keys(settings).some(k => !["api", "git", "repositories", "reviewer", "trusted_authors", "required_checks"].includes(k))) errors.push("Unknown Bitbucket host setting; use api, git, repositories or explicit review policy");
    if (settings.api && (typeof settings.api !== "object" || Object.keys(settings.api).some(k => !["email", "token_file", "scopes"].includes(k)) || typeof settings.api.email !== "string" || typeof settings.api.token_file !== "string" || settings.api.scopes != null && (!Array.isArray(settings.api.scopes) || settings.api.scopes.some(s => typeof s !== "string")))) errors.push("Bitbucket api requires email and token_file; optional scopes is an array. Store secrets only in the private token file");
    if (settings.git && (typeof settings.git !== "object" || !["ssh", "https"].includes(settings.git.transport) || Object.keys(settings.git).some(k => !["transport", "ssh_key", "known_hosts", "token_file"].includes(k)) || ["ssh_key", "known_hosts", "token_file"].some(k => settings.git[k] != null && typeof settings.git[k] !== "string"))) errors.push("Bitbucket git requires transport ssh or https and explicit credential file paths");
    if (settings.repositories != null) {
      if (typeof settings.repositories !== "object" || Array.isArray(settings.repositories)) errors.push("Bitbucket repositories must map canonical paths to UUID bindings");
      else for (const [path, binding] of Object.entries(settings.repositories)) {
        try { if (repositoryIdentity(path, "bitbucket.org").path !== path || !binding || typeof binding !== "object" || Array.isArray(binding) || ((binding.uuid != null || binding.workspaceUuid != null) && (!/^\{[0-9a-f-]{36}\}$/.test(binding.uuid) || !/^\{[0-9a-f-]{36}\}$/.test(binding.workspaceUuid)))) throw new Error(); }
        catch { errors.push("Invalid Bitbucket repository/workspace UUID binding; inspect before rebinding"); }
      }
    }
    errors.push(...reviewPolicyProblems(settings, BITBUCKET_REVIEW_POLICY));
    if (settings.repositories && typeof settings.repositories === "object" && !Array.isArray(settings.repositories)) for (const binding of Object.values(settings.repositories)) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      errors.push(...reviewPolicyProblems(binding, BITBUCKET_REVIEW_POLICY));
      const allowed = ["uuid", "workspaceUuid", "api", "git", "reviewer", "trusted_authors", "required_checks"];
      if (Object.keys(binding).some(k => !allowed.includes(k))) errors.push("Unknown Bitbucket repository setting");
      if (binding.api || binding.git) errors.push(...bitbucketDefinition.validateConfig({ ...(binding.api ? { api: binding.api } : {}), ...(binding.git ? { git: binding.git } : {}) }));
    }
    return errors;
  },
  remote: (repository, config = {}) => {
    const protocol = (config.git_hosts?.["bitbucket.org"]?.repositories?.[repository.path]?.git ?? config.git_hosts?.["bitbucket.org"]?.git)?.transport || "https";
    return { protocol, host: "bitbucket.org", path: repository.path,
      url: protocol === "ssh" ? `git@ssh.bitbucket.org:${repository.path}.git` : `https://bitbucket.org/${repository.path}.git` };
  },
  parsePr: parseBitbucketPr,
  prUrl: (r, n) => `https://bitbucket.org/${r.path}/pull-requests/${n}`,
  prompts: {
    create: ({ base, branch }) => `task-pr create --base ${quote(base)} --head ${quote(branch)} --title-file <title-file> --body-file <body-file>`,
    inspect: ({ pr }) => `Run \`task-pr view ${pr}\` and \`task-pr diff ${pr}\` before editing. Use \`task-pr comment ${pr} --reply-to <comment-id> --body-file <reply-file>\` for inline replies.`,
    check: ({ check }) => `. Inspect the build log at ${check.url || "the PR checks page"}.`,
    editReceipt: "Use `task-pr edit <number> --body-file <receipt-file>` for the PR body and `task-pr comment <number> --reply-to <comment-id> --body-file <reply-file>` for thread replies. Do not push an empty commit.",
  },
});
