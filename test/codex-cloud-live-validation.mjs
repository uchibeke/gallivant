// Read-only campaign guards shared by the opt-in runner and offline regressions.
// Importing this module never checks credentials or launches a provider task.
import { repositoryMatches } from "../lib/gh.mjs";

export function cloudLedgerBlockers(config, ledger, repository, now = Date.now()) {
  const blockers = [];
  const apiReserved = Array.isArray(ledger?.attempts) ? ledger.attempts.reduce((sum, item) => sum + Math.max(item.reservedUsd, item.observedCostUsd ?? 0), 0) : NaN;
  if (ledger?.version !== 1 || ledger.limitUsd !== 10 || !Number.isFinite(apiReserved) || apiReserved > ledger.limitUsd || ledger.attempts.some(item => !Number.isFinite(item.reservedUsd) || item.reservedUsd <= 0 || !Number.isFinite(item.observedCostUsd) || item.observedCostUsd < 0)) blockers.push("shared API campaign ledger requires reconciled prior charges within aggregate USD 10 allowance");
  if (ledger?.cloud?.account !== "operator" || ledger.cloud.environment !== config?.environment || !repositoryMatches(ledger.cloud.repo, repository) || ledger.cloud.billingSource !== "chatgpt-account" || !Number.isSafeInteger(ledger.cloud.remainingTasks) || ledger.cloud.remainingTasks < 1 || !ledger.cloud.accountUsageEvidence || !Number.isFinite(Date.parse(ledger.cloud.checkedAt)) || Math.abs(now - Date.parse(ledger.cloud.checkedAt)) > 86_400_000 || !Number.isFinite(ledger.cloud.taskSeconds) || ledger.cloud.taskSeconds <= 0 || ledger.cloud.taskSeconds > 120) blockers.push("Cloud needs separate authorized account allowance, selected environment/repo, current account usage evidence and <=120-second observation deadline");
  return blockers;
}
export function cloudRequestBlockers(config, request, repository) {
  return !repositoryMatches(request.repo, repository) || request.harness !== "codex-cloud" || !repositoryMatches(request.repo, config?.repository) ? ["live brief must select the authorized disposable repository and codex-cloud"] : [];
}
export function cloudCorrectionMatches(entry, request, campaign) {
  return Boolean(entry && repositoryMatches(entry.repo, request.repo) && entry.harness === "codex-cloud" && entry.session === campaign.sessionId && entry.pr === campaign.pr);
}
