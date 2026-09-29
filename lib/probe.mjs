// Health probes shared by `doctor`, `start` and the daemon: is each harness signed in, is gh authenticated,
// does ntfy answer. Each returns { ok, detail } and never throws.
import { execFile } from "node:child_process";
import { adapters, adapterFor, compareVersions, MIN_VERSIONS } from "./harness.mjs";

const run = (cmd, args, opts = {}) => new Promise(resolve => {
  execFile(cmd, args, { encoding: "utf8", timeout: 20_000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});

export async function checkSignIn(harness, config) {
  const a = adapterFor(harness);
  const bin = config.harness[harness]?.bin;
  if (!bin) return { ok: false, detail: `harness.${harness}.bin not configured` };
  const { code, out } = await run(bin, a.signIn.args, { env: { ...process.env, ...a.env({ configDir: null }) } });
  return a.signIn.ok(code, out) ? { ok: true, detail: "signed in" } : { ok: false, detail: out.trim().split("\n").at(-1) || `exit ${code}` };
}

/**
 * The command that fixes a failed sign-in for one probe. The instruction lives on the adapter next to the check it
 * answers for, so there is one place per harness rather than a conditional in `doctor` and a map in `up` that both
 * had to be remembered. `gh` is not a harness and keeps its own line.
 */
export const signInFix = harness => adapters[harness]?.signIn?.fix ?? "see gallivant doctor";

export const GH_FIX = "gh auth login, or refresh the token in github_token_file";

/** The fix for any probe key `probeAll` produces. */
export const probeFix = key => (key === "gh" ? GH_FIX : signInFix(key));

export async function checkVersion(harness, config) {
  const a = adapterFor(harness);
  const bin = config.harness[harness]?.bin;
  if (!bin) return { ok: false, detail: "not configured" };
  const { code, out } = await run(bin, a.version.args);
  const v = code === 0 ? a.version.parse(out) : null;
  if (!v) return { ok: false, detail: `could not read version from ${bin}` };
  const ok = compareVersions(v, MIN_VERSIONS[harness]) >= 0;
  return { ok, detail: ok ? v : `${v} is older than ${MIN_VERSIONS[harness]}` };
}

export async function checkGh(gh) {
  try { const login = await gh.user(); return { ok: true, detail: login }; }
  catch (e) { return { ok: false, detail: e.message.split("\n")[0] }; }
}

/** All probes the daemon needs before it dispatches anything. */
export async function probeAll(ctx) {
  const { config, gh } = ctx;
  const out = { gh: await checkGh(gh) };
  for (const h of Object.keys(config.harness)) out[h] = await checkSignIn(h, config);
  return out;
}

export const allOk = probes => Object.values(probes).every(p => p.ok);
