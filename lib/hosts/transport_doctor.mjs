import { repositoryReviewConfig } from "../review_policy.mjs";
import { configPath, merge, validate, repoEntries } from "../config.mjs";
import { readJson, gallivantHome } from "../fs.mjs";
import { makeHostRegistry } from "../hosts.mjs";
import { repositoryPreflight } from "../repository_preflight.mjs";
import { checkHarness } from "../probe.mjs";

export async function transportDoctor({ home = gallivantHome(), repos, registry, transportPreflight = repositoryPreflight, harnessCheck = checkHarness } = {}) {
  const raw = readJson(configPath(home), null), config = merge(raw || {}, home);
  registry ??= makeHostRegistry({ config });
  const results = [];
  const problems = validate(config, home);
  results.push({ name: "config", ok: !!raw && !problems.length, detail: raw ? problems.join("; ") : "No config file", fix: `Configure repository credentials and a supported harness in ${configPath(home)}; see docs/git-hosts.md` });
  for (const repo of repos ?? repoEntries(config).map(r => r.repo)) {
    const selected = registry.inspect(repo);
    try {
      const policy = repositoryReviewConfig(config, repo, selected.adapter);
      results.push({ name: `${repo} reviewer`, ok: true, detail: policy.reviewer ? `Explicit actor ${policy.reviewer.actor_id}; current-head verdict required. Producer live qualification is separate.` : "No automated reviewer: CI and trusted commands only; never reported as Codex-reviewed." });
    } catch (error) { results.push({ name: `${repo} reviewer`, ok: false, detail: error.message, fix: "Configure a stable actor and review producer, or explicitly choose reviewer: null; see docs/bitbucket-review.md" }); }
    try {
      const report = await transportPreflight(config, repo, { registry });
      results.push({ name: `${selected.repository.host} access`, ok: true, detail: `${repo}: repository/API read, account push role and Git base ${report.base} (${report.baseSha}) verified. PR read: ${report.pullRequestRead}; comment read: ${report.commentRead}. Unknown until write: ${report.unknownAtWrite.join(", ")}. Branch restrictions: ${Array.isArray(report.branchRestrictions) ? JSON.stringify(report.branchRestrictions) : "unknown (API access unavailable)"}` });
    } catch (error) {
      results.push({ name: `${selected.repository.host} access`, ok: false, detail: error.message, fix: "Restore the explicitly selected Git key/token and account API token with repository and pull-request read/write scopes; run doctor again. No credential fallback or model probe was attempted." });
    }
    results.push(selected.adapter.dispatch === false
      ? { name: "task dispatch", ok: false, detail: selected.adapter.dispatchReason, fix: "Restore a qualified host release before starting tasks." }
      : { name: "task dispatch", ok: true, detail: "Enabled; task start still checks repository access and the selected review policy." });
  }
  for (const harness of Object.keys(config.harness || {})) {
    try { results.push({ name: `${harness} readiness`, ...await harnessCheck(harness, config) }); }
    catch (error) { results.push({ name: `${harness} readiness`, ok: false, detail: error.message, fix: "Restore the configured harness installation; no model call was made" }); }
  }
  return results;
}
