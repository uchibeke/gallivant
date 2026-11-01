// Compatibility exports for the existing install diagnostics. Host-specific ruleset
// and CLI policy lives with the qualified adapter, never in the lifecycle.
export * from "../hosts/github_doctor.mjs";
import { doctor as githubDoctor } from "../hosts/github_doctor.mjs";
import { transportDoctor } from "../hosts/transport_doctor.mjs";
import { makeHostRegistry } from "../hosts.mjs";
import { configPath, repoNames } from "../config.mjs";
import { readJson, gallivantHome } from "../fs.mjs";
import { execFileSync } from "node:child_process";

export async function doctor(options = {}) {
  const home = options.home ?? gallivantHome(), raw = readJson(configPath(home), {}), registry = options.registry ?? makeHostRegistry({ config: raw });
  const repos = repoNames(raw);
  if (!repos.length) {
    try {
      const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: options.dir ?? process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      const target = registry.inspectRemote(origin);
      if (target.adapter.features?.transportSetup) repos.push(target.repository.key);
    } catch { /* No checkout; existing install diagnostics supply the config remedy. */ }
  }
  const transport = repos.filter(repo => { try { return registry.inspect(repo).adapter.features?.transportSetup; } catch { return false; } });
  if (!transport.length) return githubDoctor(options);
  const results = await transportDoctor({ ...options, home, repos: transport, registry });
  if (repos.some(repo => !transport.includes(repo))) results.push(...await githubDoctor({ ...options, repoFilter: repo => !transport.includes(repo) }));
  return results;
}
