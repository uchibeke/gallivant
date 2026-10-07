// Health probes shared by `doctor`, `start` and the daemon: is each harness signed in, is gh authenticated,
// does ntfy answer. Each returns { ok, detail } and never throws.
import { execFile } from "node:child_process";
import { adapters, adapterFor, compareVersions, MIN_VERSIONS, capabilitiesFor } from "./harness.mjs";
import { checkAgentsAccess, validateAgentsConfig } from "./openai_agents.mjs";
import { checkCloudAccess } from "./codex_cloud.mjs";
import { validateCloudConfig } from "./codex_cloud_config.mjs";
import { redact } from "./execution_io.mjs";
import { checkVerificationSandbox } from "./execution_result.mjs";

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 65_536, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});

export async function checkSignIn(harness, config, { signal } = {}) {
  if (harness === "codex-cloud") return checkCloudAccess(config.harness[harness], { signal });
  if (harness === "openai-agents") return checkAgentsAccess(config.harness[harness], { signal });
  const a = adapterFor(harness);
  const bin = config.harness[harness]?.bin;
  if (!bin) return { ok: false, detail: `harness.${harness}.bin not configured` };
  const { code, out } = await run(bin, a.signIn.args, { signal, env: { ...process.env, ...a.env({ configDir: null }) } });
  return a.signIn.ok(code, out) ? { ok: true, detail: "signed in" } : { ok: false, detail: out.trim().split("\n").at(-1) || `exit ${code}` };
}

/**
 * The command that fixes a failed sign-in for one probe. The instruction lives on the adapter next to the check it
 * answers for, so there is one place per harness rather than a conditional in `doctor` and a map in `up` that both
 * had to be remembered. `gh` is not a harness and keeps its own line.
 */
export const signInFix = harness => harness === "openai-agents" ? "configure harness.openai-agents account, project, authorized model and application API key; run gallivant doctor" : harness === "codex-cloud" ? "configure harness.codex-cloud with the operator's published environment; use its configured Codex executable to login with ChatGPT; run gallivant doctor" : adapters[harness]?.signIn?.fix ?? "see gallivant doctor";

export const GH_FIX = "gh auth login, or refresh the token in github_token_file";

/** The failing check owns its remedy: an old binary needs an upgrade, not another login. */
export const probeFix = (key, result = null) => result?.fix ?? (key === "gh" ? GH_FIX : signInFix(key));

export async function checkVersion(harness, config, { signal } = {}) {
  if (harness === "codex-cloud") return checkCloudAccess(config.harness[harness], { signal });
  if (harness === "openai-agents") return checkAgentsAccess(config.harness[harness], { signal });
  const a = adapterFor(harness);
  const bin = config.harness[harness]?.bin;
  if (!bin) return { ok: false, detail: "not configured" };
  const { code, out } = await run(bin, a.version.args, { signal });
  const v = code === 0 ? a.version.parse(out) : null;
  if (!v) return { ok: false, detail: `could not read version from ${bin}` };
  const ok = compareVersions(v, MIN_VERSIONS[harness]) >= 0;
  return { ok, detail: ok ? v : `${v} is older than ${MIN_VERSIONS[harness]}` };
}

/** One readiness gate for start, resume and daemon dispatch. Check before any paid run or checkout mutation. */
export async function checkHarness(harness, config, options = {}) {
  const capabilities = capabilitiesFor(harness);
  if (!capabilities.available) return { ok: false, detail: capabilities.reason, fix: capabilities.fix || "install the implemented transport before selecting this provider" };
  if (harness === "codex-cloud") {
    try { validateCloudConfig(config.harness[harness]); } catch { return checkCloudAccess(config.harness[harness], options); }
    const verification = await checkVerificationSandbox(options);
    if (!verification.ok) return verification;
    const access = await checkCloudAccess(config.harness[harness], options);
    return access.ok ? { ...access, verificationSandbox: verification.evidence } : access;
  }
  if (harness === "openai-agents") {
    // Known configuration failures do not need a native or provider probe.
    try { validateAgentsConfig(config.harness[harness]); }
    catch { return checkAgentsAccess(config.harness[harness], options); }
    const verification = await checkVerificationSandbox(options);
    if (!verification.ok) return verification;
    const access = await checkAgentsAccess(config.harness[harness], options);
    return access.ok ? { ...access, verificationSandbox: verification.evidence, detail: `${access.detail}; ${verification.detail}` } : access;
  }
  const version = await checkVersion(harness, config, options);
  if (!version.ok) return { ...version, fix: `install ${harness} ${MIN_VERSIONS[harness]} or newer at the configured bin path; run gallivant doctor` };
  const signedIn = await checkSignIn(harness, config, options);
  return signedIn.ok ? { ok: true, detail: `${version.detail}, signed in` } : { ...signedIn, fix: signInFix(harness) };
}

export async function requireHarness(harness, config) {
  const result = await checkHarness(harness, config);
  if (!result.ok) throw new Error(`${harness} is not ready (${result.detail}); ${result.fix}`);
}

export async function checkGh(gh, options = {}) {
  try { const login = await gh.user(options); return { ok: true, detail: login }; }
  catch (e) { return { ok: false, detail: redact(e.message.split("\n")[0]) }; }
}

/** All probes the daemon needs before it dispatches anything. */
export async function probeAll(ctx) {
  const { config, gh } = ctx;
  const pairs = await Promise.all([["gh", () => checkGh(gh)], ...Object.keys(config.harness).map(h => [h, () => checkHarness(h, config)])].map(async ([key, fn]) => [key, await fn()]));
  const out = Object.fromEntries(pairs);
  return out;
}

export const allOk = probes => Object.values(probes).every(p => p.ok);
