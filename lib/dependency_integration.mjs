import { authorSettled } from "./execution_contract.mjs";
import { executionRunner } from "./execution.mjs";
import { hosts, hostApi } from "./hosts.mjs";
import { observedIdentityProblem, terminalIdentityProblem } from "./host_contract.mjs";
import { integrationSettlement } from "./task_completion.mjs";
import { boundedCall } from "./recovery_io.mjs";
import { recoveryHeld } from "./recovery_recipes.mjs";
import { isDeepStrictEqual } from "node:util";

export const commitId = value => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
export const dependencyError = message => Object.assign(new Error(message), { code: "PLAN_PREREQUISITE" });

export function dependencyPrProblem(ctx, entry, pr) {
  try {
    const { repository, number } = (ctx.hosts ?? hosts).fromUrl(pr.url);
    if (repository.key !== entry.repo || number !== entry.pr) return "PR identity or intended base changed";
  } catch { return "PR identity or intended base changed"; }
  return observedIdentityProblem(entry, { ...pr, strictIdentity: true });
}

const terminal = (entry, pr) => ({ state: pr.state, repository: entry.repo, pr: entry.pr, base: entry.base,
  head: pr.headRefOid, mergeCommit: pr.mergeCommit?.oid, mergedAt: pr.mergedAt });

// Linear registrations predate delivery evidence. Where that lifecycle owns
// closeout, share its settlement gate; old integrations retain their original
// host-only meaning. Graph dependencies use the qualified receipt below.
export async function observeLinearIntegration(ctx, id, entry) {
  const held = current => recoveryHeld({ recovery: ctx.state.recoverySettings?.() }, id, current);
  const runner = executionRunner(ctx, id);
  if (!entry.pr || held(entry) || !authorSettled(entry, runner.current(), runner)) return {};
  const host = hostApi(ctx), pr = await host.prView(entry.repo, entry.pr);
  const identity = dependencyPrProblem(ctx, entry, pr);
  if (identity) return { problem: identity };
  if (pr.state === "CLOSED") return { problem: `PR #${entry.pr} was closed without merging; reopen and register the PR before retrying, or cancel this chain` };
  if (pr.state !== "MERGED") return {};
  const problem = await terminalIdentityProblem(host, entry, { ...pr, strictIdentity: true });
  if (problem) return { problem };
  const current = ctx.state.get(id);
  if (!current || held(current) || current.start_token !== entry.start_token || current.last?.run !== entry.last?.run || dependencyPrProblem(ctx, current, pr) ||
      !authorSettled(current, runner.current(), runner) ||
      ctx.cleanupMergedWorkspace && !integrationSettlement(current, terminal(current, pr))) return {};
  return { merged: { pr: entry.pr, sha: pr.mergeCommit.oid, at: pr.mergedAt } };
}

export function qualifiedIntegration(entry, binding, owner) {
  const closeout = entry?.completionEvidence?.terminal;
  if (!closeout || !entry.url || !entry.base || !entry.branch || !entry.pr || !commitId(closeout.head) || !commitId(closeout.mergeCommit) ||
      !Number.isFinite(Date.parse(closeout.mergedAt)) || entry.repo !== binding.key || entry.base !== binding.base ||
      closeout.pr !== entry.pr || closeout.repository !== entry.repo || closeout.base !== entry.base ||
      entry.repository_id && entry.repository_id !== binding.repositoryId) return null;
  const settled = integrationSettlement(entry, closeout);
  if (settled?.delivery !== "verified") return null;
  if (dependencyPrProblem({}, entry, { url: entry.url, number: entry.pr, headRefName: entry.branch, baseRefName: entry.base, isCrossRepository: false })) return null;
  return { version: 1, kind: "repository-integration", owner, repository: entry.repo, repositoryId: binding.repositoryId,
    host: binding.host, base: entry.base, branch: entry.branch, number: entry.pr, url: entry.url, head: closeout.head,
    sha: closeout.mergeCommit, at: closeout.mergedAt, ...settled };
}

export function matchesIntegration(entry, binding, receipt) {
  const current = qualifiedIntegration(entry, binding, receipt.owner);
  // Both retained and removed satisfy the same settlement predicate. Keep the
  // original receipt when later maintenance reclaims the retained checkout.
  return current && isDeepStrictEqual({ ...current, cleanup: receipt.cleanup }, receipt);
}

export async function verifyRepositoryIdentity(ctx, repo, expected = null) {
  const host = hostApi(ctx);
  if (typeof host.repositoryIdentity !== "function") throw dependencyError("The host adapter cannot prove immutable repository identity.");
  const identity = await boundedCall(() => host.repositoryIdentity(repo), ctx.config.execution);
  if (identity?.key !== repo || typeof identity.id !== "string" || !identity.id || expected && identity.id !== expected)
    throw dependencyError("The approved repository identity changed or is unavailable.");
  return identity.id;
}

export async function verifyIntegration(ctx, receipt) {
  const host = hostApi(ctx), { repository: repo, repositoryId, base, branch, number, url, head, sha, at } = receipt;
  const { adapter, repository } = (ctx.hosts ?? hosts).select(repo);
  if (!adapter.capabilities?.mergeProof || repository.host !== receipt.host || receipt.version !== 1 ||
      receipt.kind !== "repository-integration" || receipt.delivery !== "verified") throw dependencyError("This producer adapter has no qualified integration receipt.");
  await verifyRepositoryIdentity(ctx, repo, repositoryId);
  const pr = await boundedCall(() => host.prView(repo, number), ctx.config.execution);
  const entry = { repo, pr: number, url, branch, base };
  if (dependencyPrProblem(ctx, entry, pr) || pr.headRefOid !== head || pr.mergeCommit?.oid !== sha || pr.mergedAt !== at ||
      [pr.repositoryId, pr.baseRepositoryId, pr.sourceRepositoryId].some(id => id != null && id !== repositoryId)) {
    throw dependencyError("The producer PR no longer matches its recorded integration.");
  }
  const readBase = () => boundedCall(() => host.refSha(repo, base), ctx.config.execution);
  const baseCommit = await readBase();
  if (!commitId(baseCommit)) throw dependencyError("The approved producer base is unavailable.");
  const problem = await boundedCall(() => terminalIdentityProblem(host, entry, { ...pr, strictIdentity: true }, { baseCommit }), ctx.config.execution);
  if (problem) throw dependencyError(problem);
  if (await readBase() !== baseCommit) throw dependencyError("The producer base moved during the ancestry check; recheck before starting.");
  return baseCommit;
}
