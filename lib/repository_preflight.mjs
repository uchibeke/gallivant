import { makeGit } from "./git.mjs";
import { makeHostRegistry } from "./hosts.mjs";
import { configuredBase } from "./config.mjs";

/** Transport readiness is independent of dispatch qualification. It makes no remote writes. */
export async function repositoryPreflight(config, repo, { registry = makeHostRegistry({ config }), git = makeGit({ config, hosts: registry }), base = configuredBase(config, repo) } = {}) {
  const selected = registry.inspect(repo);
  if (!selected.api.preflight) throw new Error("This host uses its existing setup diagnostics");
  const report = await selected.api.preflight(selected.repository.path, { base });
  return { ...report, ...await git.probeAccess(repo, report.base, report.baseSha), dispatch: selected.adapter.dispatch !== false, guidance: selected.adapter.dispatchReason ?? null };
}
