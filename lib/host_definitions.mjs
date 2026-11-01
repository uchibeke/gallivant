// The one shipped host catalogue. Portable consumers read policy only; Node's
// hosts.mjs binds these declarations to transport implementations by adapter ID.
import { githubDefinition } from "./hosts/github_contract.mjs";
import { bitbucketDefinition } from "./hosts/bitbucket_contract.mjs";
import { repositoryIdentity } from "./repository.mjs";
export const HOST_DEFINITIONS = Object.freeze([githubDefinition, bitbucketDefinition]);
export function hostDefinition(repo = "owner/name", { transport = false } = {}) {
  const repository = repositoryIdentity(repo), adapter = HOST_DEFINITIONS.find(d => d.host === repository.host);
  if (!adapter) throw new Error(`Unsupported repository host ${repository.host}; configure a qualified host before dispatch`);
  if (!transport && adapter.dispatch === false) throw new Error(adapter.dispatchReason);
  return { repository, adapter };
}
export const completionAdapter = repo => hostDefinition(repo || "owner/name").adapter.id;
export const hostPrompts = repo => hostDefinition(repo || "owner/name").adapter.prompts;
export function hostGuidance(repo) {
  try { return hostDefinition(repo, { transport: true }).adapter.dispatchReason ?? null; }
  catch (error) { return error.message; }
}
export function pullRequestUrl(repo, number) {
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) return null;
  try { const { adapter, repository } = hostDefinition(repo, { transport: true }); return adapter.prUrl(repository, Number(number)); } catch { return null; }
}
