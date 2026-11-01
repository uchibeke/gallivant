// Portable declaration. Runtime transport and credential implementation are bound by the registry.
import { repositoryIdentity, parsePullRequestUrl } from "../repository.mjs";

export function parseGitHubPr(url) {
  try {
    const { host, pathname } = parsePullRequestUrl(url);
    const m = pathname.match(/^([^/]+\/[^/]+)\/pull\/([1-9]\d*)\/?$/);
    if (host !== "github.com" || !m || !Number.isSafeInteger(Number(m[2]))) return null;
    return { repo: repositoryIdentity(m[1], host).key, number: Number(m[2]) };
  } catch { return null; }
}

export const githubDefinition = Object.freeze({
  host: "github.com", id: "github-pull-request",
  capabilities: Object.freeze({ pullRequests: true, reviews: true, comments: true, checks: true, diff: true, mergeProof: true, recovery: true, labels: true }),
  dataContract: "host-records-v1",
  features: Object.freeze({ legacyReviewDefaults: true, learning: true, rulesets: true, repositoryScopes: true }),
  remote: repository => ({ url: `https://github.com/${repository.path}.git`, protocol: "https", host: "github.com", path: repository.path }),
  parsePr: url => parseGitHubPr(url),
  prUrl: (repository, number) => `https://github.com/${repository.path}/pull/${number}`,
  prompts: {
    create: ({ base, branch }) => `gh pr create --base ${base} --head ${branch}`,
    inspect: ({ repo, pr }) => `Run \`gh pr view ${pr} --repo ${repo}\` and \`gh pr diff ${pr} --repo ${repo}\` to understand it before changing anything.`,
    check: ({ repo, check }) => check.runId ? `, run ${check.runId}. Run \`gh run view ${check.runId} --repo ${repo} --log-failed\` for the log.` : `. See ${check.url || "the checks tab"}.`,
    editReceipt: "If only the completion receipt in the PR body needed fixing, edit the PR body with `gh pr edit` and do not push an empty commit.",
  },
});
