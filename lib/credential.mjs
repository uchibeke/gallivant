// The one place a GitHub credential for a run is resolved.
//
// The defect this exists for. A run is sandboxed: it cannot reach the operator's macOS keyring, their Linux secret
// service, or `~/.git-credentials`. The credential helper used to be `!gh auth git-credential`, which asks `gh` to
// look in exactly those places, so inside a run the helper returned nothing and `git push` failed after the work was
// done and paid for. `runEnv` set `GH_TOKEN` only when `github_token_file` was configured, and the default is null,
// so the common install got no credential at all.
//
// The fix is to resolve the credential in the DAEMON, which is not sandboxed and can reach whatever store the
// operator actually used, and to pass it to the run in its environment. The helper then reads `$GH_TOKEN` from that
// environment instead of shelling out to `gh`. The helper itself travels in the environment too, as one of
// `RUN_GIT_CONFIG`'s pairs in lib/git.mjs, so a run names no file outside its worktree.
//
// Resolution order, first answer wins. The order is the contract; it is documented in docs/config.md and asserted
// in the tests, because changing it silently changes which identity a run acts as.
//
//   1. `github_token_file` from the config. Explicit and deliberately narrow, so it keeps winning over everything
//      below. An operator who set it has decided what a run may reach, and nothing here may widen that.
//   2. `GH_TOKEN` or `GITHUB_TOKEN` already in the daemon's own environment. This is CI, and anyone who exports a
//      token in a shell profile.
//   3. Whatever `gh auth token` hands over. Asking `gh` is the honest way to cover every store `gh` supports: the
//      macOS keyring, the Linux secret service, the plain `~/.config/gh/hosts.yml` when no keyring is available,
//      and an enterprise host. Parsing `hosts.yml` here would reimplement `gh`'s own resolution and drift from it.
//   4. Nothing. `resolve` returns a reason, and the caller refuses to start the run.
//
// Two rules hold for every path through this file, and both are about where the token must never land:
//
//   - Never in argv. `gh auth token --hostname <host>` puts the HOST in argv, never the token, which arrives on
//     stdout. `ps` shows argv to every process on the machine.
//   - This resolver writes no token to disk. The runner records argv without env in `cmd.json`. A child can
//     still print its credential into raw `provider.log`; tracker logs redact recognized secrets but are not a
//     complete data-loss boundary. `describe` below reports only the source and length.
import { execFile } from "node:child_process";
import { readText } from "./fs.mjs";

const GH_TOKEN_TIMEOUT_MS = 20_000;

/** Where a resolved credential came from, as a stable key. Printed and asserted on; never the token itself. */
export const SOURCES = Object.freeze({
  file: "github_token_file",
  env: "daemon environment",
  gh: "gh auth token",
});

/**
 * The host a remote URL's credential belongs to. `gh` can be logged in to an enterprise host as well as
 * github.com, and the token for github.com is the wrong one for `github.acme.com`.
 *
 * Only the host is taken, and only from a URL shape we recognise. An SSH remote has no useful host for a token
 * (a token cannot authenticate SSH), so it reads as github.com and the caller's own remote check is what fails.
 */
export function hostFromRemote(url) {
  const s = String(url || "").trim();
  const m = s.match(/^https?:\/\/(?:[^@/]*@)?([a-z0-9.-]+)/i);
  if (m) return m[1].toLowerCase();
  const ssh = s.match(/^(?:ssh:\/\/)?(?:[^@/]+@)([a-z0-9.-]+)[:/]/i);
  return ssh ? ssh[1].toLowerCase() : "github.com";
}

/** True when a host is github.com itself rather than an enterprise install. */
export const isDotCom = host => String(host || "").toLowerCase() === "github.com";

/** The token in a `github_token_file`, or empty when none is configured. */
export const readTokenFile = file => (file ? readText(file, "").trim() : "");

/** A token in the daemon's own environment, `GH_TOKEN` first. Empty when neither is set to anything. */
export const tokenFromEnv = (env = process.env) => String(env.GH_TOKEN || env.GITHUB_TOKEN || "").trim();

/**
 * `gh auth token` for one host, or empty when `gh` has nothing for it. Never throws: a machine with no `gh`, or a
 * `gh` that is signed out, is a reason to fall through to the next source, not a crash in the daemon.
 *
 * The host goes in argv. The token comes back on stdout, so it is never visible to `ps`.
 */
export function tokenFromGh(host = "github.com", { exec = execFileAsyncQuiet } = {}) {
  const args = ["auth", "token"];
  // `--hostname` is only passed for an enterprise host: an older `gh` without the flag would fail the whole lookup
  // for the overwhelmingly common github.com case, and for github.com the flag changes nothing.
  if (!isDotCom(host)) args.push("--hostname", host);
  return exec("gh", args).then(out => String(out || "").trim()).catch(() => "");
}

/** execFile for a token read: stdout only, failures become empty rather than throwing, stderr is never kept. */
function execFileAsyncQuiet(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { encoding: "utf8", timeout: GH_TOKEN_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

/**
 * The message a refusal carries. It names all three sources in the order they are tried, because an operator who
 * sees this has to pick one, and the cheapest fix is nearly always the first line.
 */
export function noCredentialMessage(host = "github.com") {
  const lines = [
    "No GitHub credential could be resolved, so a run would do the work and then fail to push.",
    "Nothing was started. Fix one of these, in the order Gallivant tries them:",
    `  1. gh auth login${isDotCom(host) ? "" : ` --hostname ${host}`}                      (uses whatever store gh has: keyring, secret service, or hosts.yml)`,
    "  2. export GH_TOKEN=<token>                    (in the shell that starts the daemon, or in CI)",
    "  3. a fine-grained PAT in a file, then set github_token_file to its path in ~/.gallivant/config.json",
  ];
  if (!isDotCom(host)) lines.push(`The remote is on ${host}, not github.com. If gh is not logged in to ${host}, use github_token_file: a github.com token will not authenticate ${host}.`);
  return lines.join("\n");
}

/**
 * Resolve a credential for one host. Returns `{ token, source, host }` or `{ token: null, source: null, host, why }`.
 * An unusable explicitly configured token file throws `NO_CREDENTIAL`; it never tries a broader source.
 *
 * `env` and `exec` are injected so a test can drive every branch without a `gh` on the machine and without ever
 * putting a real token anywhere near a fixture.
 */
export async function resolveCredential(config, { host = "github.com", env = process.env, exec = execFileAsyncQuiet } = {}) {
  // A configured file is an authority boundary, not merely the first candidate.
  // Missing, unreadable or blank must not silently widen to an ambient login.
  if (config?.github_token_file) {
    const fromFile = readTokenFile(config.github_token_file);
    if (fromFile) return { token: fromFile, source: SOURCES.file, host };
    throw Object.assign(new Error("The configured github_token_file is missing, unreadable or empty. No fallback credential was used. Restore that private token file, or explicitly set github_token_file to null and restart the daemon to use environment/gh authentication."), { code: "NO_CREDENTIAL", reason: "configured-token-file-unavailable" });
  }
  const fromEnv = tokenFromEnv(env);
  if (fromEnv) return { token: fromEnv, source: SOURCES.env, host };
  const fromGh = await tokenFromGh(host, { exec });
  if (fromGh) return { token: fromGh, source: SOURCES.gh, host };
  return { token: null, source: null, host, why: noCredentialMessage(host) };
}

/**
 * One line about a resolved credential, safe to log and to print. It names the source and the host and the token's
 * length, never the token: a length is enough to tell "the file has a token in it" from "the file has a newline in
 * it" while being useless to anyone who reads a log.
 */
export const describe = ({ token, source, host }) =>
  token ? `${source}${isDotCom(host) ? "" : ` for ${host}`} (${token.length} characters)` : "none";

/**
 * The host a checkout's credential belongs to, from its `origin` remote. Failure reads as github.com, because a
 * checkout whose remote cannot be read has a bigger problem than which host its token is for and the caller's own
 * git operations will say so.
 */
export async function hostForWorktree(git, dir) {
  try { return hostFromRemote(await git.originOf(dir)); } catch { return "github.com"; }
}

/**
 * The credential for one entry or one request, resolved through the context's own resolver.
 *
 * The host is taken from the checkout's `origin` when there is a checkout, because that is the only thing that knows
 * whether this repository lives on github.com or on an enterprise install. A repository named `owner/name` with no
 * checkout yet (a `start` before its clone) has no host to read, so it reads as github.com, which is right for every
 * install `gh repo clone owner/name` would resolve.
 *
 * `ctx.credential` is what `makeContext` builds. A context without one (every test's hand-built context) resolves
 * from the config alone, so a test that wants a credential sets `github_token_file` and one that wants none sets
 * nothing, and no test needs a `gh` on the machine.
 */
export async function resolveCredentialFor(ctx, { worktree = null } = {}) {
  const host = worktree && ctx.git ? await hostForWorktree(ctx.git, worktree) : "github.com";
  const resolve = ctx.credential ?? (opts => resolveCredential(ctx.config, opts));
  return resolve({ host });
}
