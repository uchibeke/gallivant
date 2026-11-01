export { ROUND_MARKER, NUDGE_MARKER, RESET_MARKER, READY_LABEL, NEEDS_LABEL } from "./public-format.mjs";
export const MAX_DIFF_BYTES = 16 * 1024 * 1024;
export const normalizeLogin = login => String(login || "").replace(/^app\//, "").replace(/\[bot\]$/, "").toLowerCase();
export const actor = a => {
  if (!a) return { login: "", bot: false };
  const raw = a.login ?? a.user?.login ?? "";
  return { login: normalizeLogin(raw), bot: a.bot === true || a.is_bot === true || a.type === "Bot" || a.user?.type === "Bot" || /\[bot\]$/.test(raw) || /^app\//.test(raw) };
};

export const REQUIRED_HOST_CAPABILITIES = Object.freeze(["pullRequests", "reviews", "comments", "checks", "diff", "mergeProof", "recovery"]);
export function requireHostCapabilities(adapter) {
  for (const name of REQUIRED_HOST_CAPABILITIES) if (adapter.capabilities?.[name] !== true) throw new Error(`Host ${adapter.host} lacks required ${name} evidence; preserve state and configure a qualified host adapter before retrying`);
}
export function completeItems(value, operation) {
  if (Array.isArray(value)) return value;
  if (value?.complete === true && Array.isArray(value.items) && !value.rateLimited) return value.items;
  throw new Error(`Incomplete ${operation} evidence; preserve state and retry after host access recovers`);
}

/** Required observations are checked before the shared engine can consume them. */
export function validateHostRecord(record, host, { pr = false, full = false, event = false } = {}) {
  if (!record || record.complete === false || record.rateLimited || record.source?.host !== host ||
      typeof record.source?.adapter !== "string" || typeof record.eventId !== "string" || !record.eventId ||
      typeof record.actor?.login !== "string" || typeof record.actor?.bot !== "boolean" ||
      (record.headSha !== null && typeof record.headSha !== "string") ||
      [record.createdAt, record.updatedAt].some(value => value !== null && (typeof value !== "string" || !Number.isFinite(Date.parse(value))))) {
    throw new Error("Incomplete normalized host evidence; preserve state and recover a complete observation");
  }
  if (event && record.state !== "PENDING" && !Number.isFinite(Date.parse(record.at))) throw new Error("Incomplete event timestamp; preserve the review cursor");
  if (pr && (!Number.isSafeInteger(record.number) || record.number < 1 || !record.headRefOid || record.headSha !== record.headRefOid ||
      !["OPEN", "CLOSED", "MERGED"].includes(record.state))) throw new Error("Incomplete pull request evidence");
  if (full) {
    if (record.feedback !== undefined) {
      const f = record.feedback;
      if (f?.complete !== true || f.headSha !== record.headSha || ![f.reviews, f.inline, f.comments].every(Array.isArray)) throw new Error("Incomplete normalized feedback snapshot");
      for (const item of [...f.reviews, ...f.inline, ...f.comments]) validateHostRecord(item, host, { event: true });
    }
    if (!Array.isArray(record.statusCheckRollup)) throw new Error("Incomplete CI evidence");
    for (const check of record.statusCheckRollup) {
      validateHostRecord(check, host);
      if (check.headSha !== record.headSha || !["passed", "failed", "pending"].includes(check.outcome)) throw new Error("Incomplete or mismatched CI evidence");
    }
  }
  return record;
}

/** Providers declare access requirements; no host-by-harness switch table. */
export function assertRepositoryAccess(capabilities, repository) {
  const access = capabilities?.repositoryAccess;
  if (access?.mode === "local-worktree" || access?.mode === "snapshot") return;
  if (access?.mode === "bound-host" && access.hosts?.includes(repository.host)) return;
  throw new Error(`Execution provider cannot access repository host ${repository.host}; select a compatible provider before dispatch`);
}

/** Adapters opt into immutable task identity; legacy observations retain their semantics. */
export function observedIdentityProblem(entry, pr) {
  if (!pr.strictIdentity) return null;
  if (entry.pr != null && pr.number !== entry.pr || pr.isCrossRepository !== false || entry.url && pr.url !== entry.url || pr.headRefName !== entry.branch || entry.base && pr.baseRefName !== entry.base) return "PR repository, branch or approved base changed; restore the recorded identity before resuming";
  return null;
}

export async function terminalIdentityProblem(host, entry, pr) {
  if (!pr.strictIdentity) return null;
  const mismatch = observedIdentityProblem(entry, pr);
  if (mismatch) return mismatch;
  if (pr.state !== "MERGED") return `PR is ${pr.hostState || pr.state}; it was not merged. Reopen and register it or cancel the task`;
  if (!entry.cursor?.fixed_sha || entry.cursor.fixed_sha !== pr.headRefOid) return "Merged head differs from the recorded head; inspect the PR and saved readiness before continuing";
  const merge = pr.mergeCommit?.oid;
  if (!/^[a-f0-9]{40,64}$/i.test(merge || "") || !pr.mergedAt || !await host.containsCommit(entry.repo, entry.base, merge)) return "Cannot prove the merge commit is in the approved base; restore repository access and inspect merge ancestry";
  return null;
}
