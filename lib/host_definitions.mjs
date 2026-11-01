// The one shipped host catalogue. Portable consumers read policy only; Node's
// hosts.mjs binds these declarations to transport implementations by adapter ID.
import { githubDefinition } from "./hosts/github_contract.mjs";
import { repositoryIdentity } from "./repository.mjs";
export const HOST_DEFINITIONS = Object.freeze([githubDefinition]);
export function hostDefinition(repo = "owner/name") {
  const repository = repositoryIdentity(repo), adapter = HOST_DEFINITIONS.find(d => d.host === repository.host);
  if (!adapter) throw new Error(`Unsupported repository host ${repository.host}; configure a qualified host before dispatch`);
  return { repository, adapter };
}
export const completionAdapter = repo => hostDefinition(repo || "owner/name").adapter.id;
export const hostPrompts = repo => hostDefinition(repo || "owner/name").adapter.prompts;
export function pullRequestUrl(repo, number) {
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) return null;
  try { const { adapter, repository } = hostDefinition(repo); return adapter.prUrl(repository, Number(number)); } catch { return null; }
}
