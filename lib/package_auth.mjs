// Operator-owned package access, shared by initial and continuing coding runs.
// Never infer credential grants from a task, package manifest or registry URL.
import { createHash } from "node:crypto";
import { repositoryIdentity } from "./repository.mjs";
import { boundedCall, executionError } from "./execution_io.mjs";
import { coolingDown, httpRetryAt, serviceScope, transientServiceFailure } from "./recovery_cooldown.mjs";

const VARIABLES = ["NODE_AUTH_TOKEN", "GITHUB_PACKAGES_TOKEN", "NPM_TOKEN"];
const scopedPackage = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const failure = message => executionError("PACKAGE_AUTH", message);

export function packageAuthProblems(value, repo) {
  if (value == null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value) || value.provider !== "github-packages" ||
      Object.keys(value).some(key => !["provider", "packages"].includes(key)) ||
      !Array.isArray(value.packages) || !value.packages.length || value.packages.length > 32 ||
      value.packages.some(name => typeof name !== "string" || !scopedPackage.test(name)) ||
      new Set(value.packages).size !== value.packages.length) {
    return ["package_auth requires { provider: github-packages, packages: [exact scoped package names] }; no tokens, URLs or environment overrides"];
  }
  return repositoryIdentity(repo).host === "github.com" ? [] : ["package_auth github-packages requires a github.com repository"];
}

export function selectedPackageAuth(config, repo) {
  const key = repositoryIdentity(repo).key.toLowerCase();
  const entry = (config?.repos || []).find(item => typeof item === "object" && item && repositoryIdentity(item.repo).key.toLowerCase() === key);
  const value = entry?.package_auth;
  const problems = packageAuthProblems(value, repo);
  if (problems.length) throw failure(problems.join("; "));
  return value || null;
}

function binding(config, repo, credential) {
  const policy = selectedPackageAuth(config, repo);
  if (!policy) return null;
  if (!credential?.token || credential.host !== "github.com" || !credential.repository ||
      repositoryIdentity(credential.repository, credential.host).key.toLowerCase() !== repositoryIdentity(repo).key.toLowerCase()) {
    throw failure("Private-package access requires the selected repository's bound GitHub credential; no ambient token fallback is used.");
  }
  return policy;
}

// Called only by the coding-session environment builder, never by preparation,
// independent review or the credential-free verification runner.
export function packageAuthEnvironment(config, credential) {
  const env = Object.fromEntries(VARIABLES.map(key => [key, ""]));
  if (!credential?.repository || !credential.host) return env;
  const repo = repositoryIdentity(credential.repository, credential.host).key;
  if (binding(config, repo, credential)) {
    env.NODE_AUTH_TOKEN = credential.token;
    env.GITHUB_PACKAGES_TOKEN = credential.token;
  }
  return env;
}

export function makePackageAuthPreflight({ fetch = (...args) => globalThis.fetch(...args), clock = Date, ttlMs = 300000, cooldowns } = {}) {
  const successes = new Map(), pending = new Map();
  return async ({ config, repo, credential, transport, limits }) => {
    const policy = binding(config, repo, credential);
    if (!policy) return;
    if (transport !== "cli") throw failure("Repository package_auth currently requires a local CLI coding harness; package credentials are not sent to hosted providers.");
    const key = createHash("sha256").update(JSON.stringify([repositoryIdentity(repo).key, credential.token, policy.packages])).digest("hex");
    if ((successes.get(key) || 0) > clock.now()) return;
    if (pending.has(key)) return pending.get(key);
    const probe = () => boundedCall(async signal => {
      for (const name of policy.packages) {
        const response = await fetch(`https://npm.pkg.github.com/${encodeURIComponent(name)}`, {
          headers: { Authorization: `Bearer ${credential.token}`, "User-Agent": "repository-package-preflight" },
          redirect: "error", signal,
        });
        try {
          if (response.status === 429 || response.status >= 500) throw Object.assign(executionError("REGISTRY_CAPACITY", `Package registry temporarily unavailable (HTTP ${response.status}).`),
            { status: response.status, retryAt: httpRetryAt(response.headers, clock.now()) });
          if (response.status !== 200) throw failure(`Private-package access failed for ${name} (HTTP ${response.status}). Restore package read access for the selected GitHub credential, then resume. No coding turn was started.`);
        } finally { await response.body?.cancel(); }
      }
    }, limits);
    const scope = serviceScope("registry", "https://npm.pkg.github.com", credential.token);
    const check = (cooldowns ? cooldowns.call(scope, probe) : probe()).catch(error => {
      if (error.code === "PACKAGE_AUTH" || coolingDown(error) || transientServiceFailure(error) && error.status) throw error;
      // Response bodies and transport exception text may contain credentials.
      throw failure("Private-package preflight could not reach the registry within its deadline. Check registry connectivity and selected package access, then resume. No coding turn was started.");
    });
    pending.set(key, check);
    try {
      await check;
      if (successes.size >= 128) successes.clear();
      successes.set(key, clock.now() + ttlMs);
    } finally { pending.delete(key); }
  };
}

export const preflightPackageAuth = makePackageAuthPreflight();
