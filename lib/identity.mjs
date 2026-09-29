// The one place the git identity a run commits as is resolved.
//
// A run commits AS THE OPERATOR. That is the product decision and it is not configurable: the operator wrote the brief
// and is shipping the work, and the harness is a tool in the way an editor or a compiler is. Nobody adds
// `Co-Authored-By: vim`. A `gallivant <gallivant@users.noreply.github.com>` committer tells an employer and a reviewer
// "a robot did this", which is both wrong about who is responsible and the signal that gets a PR discounted in review.
// So there is one identity path and no flag to take another: no `--as-bot`, no config key.
//
// Why this needs a module at all, rather than being two more literals in `RUN_GIT_CONFIG`. The operator's identity lives
// in `~/.gitconfig`, and `runEnv` deliberately sets `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=/dev/null`, which
// drops exactly that file. That is not an oversight to undo: pointing a run back at `~/.gitconfig` is what commit
// `5b69814` fixed, because a sandboxed session cannot read outside its worktree and every git command failed, `git
// status` included, on a file it was denied. Verified under the run env: `git config --get user.email` returns nothing.
//
// So the daemon reads the identity where there is no sandbox, and passes the VALUES through the env pairs git already
// takes. The run names no file and the sandbox stays as strict as it is.
//
// Resolved per run and never cached at boot, for the reason `lib/credential.mjs` gives for the token: the daemon is
// long-lived and an operator may change their identity under it, and a value captured once would go stale with every
// later commit carrying the old one.
//
// A historical note, because this change looks like a revert and is not. The commits on the first live PR show
// `gallivant <the operator's real email>`. That was an accident: they predate `5b69814`, when the broken
// `GIT_CONFIG_GLOBAL` left `~/.gitconfig` in play and git picked the email out of it. The behaviour the user wants was
// happening by luck, the sandbox fix removed it, and this module makes it deliberate.
import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 20_000;

const execFileAsyncQuiet = (cmd, args, opts) =>
  new Promise(resolve => execFile(cmd, args, { timeout: GIT_TIMEOUT_MS, ...opts }, (err, stdout) => resolve(err ? "" : String(stdout))));

/**
 * The operator's git identity, as `{ name, email }`, or `{ name: null, email: null, why }` when the machine has none.
 *
 * Asked of git rather than parsed out of `~/.gitconfig`, so every place git itself would look is covered: the global
 * file, an `include` in it, a system file, `XDG_CONFIG_HOME`. Parsing the file here would reimplement git's own
 * resolution and drift from it, which is the same reasoning `credential.mjs` gives for asking `gh` rather than reading
 * `hosts.yml`.
 *
 * Run WITHOUT the run env on purpose. `runEnv`'s `GIT_CONFIG_NOSYSTEM` and `GIT_CONFIG_GLOBAL=/dev/null` are what hide
 * this identity from a session; a resolver that inherited them would ask git to read the files it has just been told to
 * ignore and would always answer "none". The daemon is not sandboxed, which is the whole reason the read happens here.
 *
 * `exec` is injected so a test drives both branches without depending on whether the machine running the suite has a
 * git identity configured, which a CI container usually does not.
 */
export async function resolveIdentity({ exec = execFileAsyncQuiet } = {}) {
  const get = async key => (await exec("git", ["config", "--get", key], { env: cleanEnv() })).trim();
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  if (!name || !email) return { name: null, email: null, why: NO_IDENTITY };
  return { name, email };
}

/**
 * The daemon's own environment with the run's git overrides stripped, so this read sees the operator's real config.
 *
 * The daemon can itself be started from a shell that exported these (a test harness, a CI job, an operator debugging a
 * run by hand), and any one of them would make the read answer "no identity configured" on a machine that has one.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_CONFIG(_|$)/.test(k) || k === "GIT_AUTHOR_NAME" || k === "GIT_AUTHOR_EMAIL" || k === "GIT_COMMITTER_NAME" || k === "GIT_COMMITTER_EMAIL") delete env[k];
  return env;
}

/**
 * What an operator with no identity is told. It refuses before a run is spawned rather than falling back to a bot, for
 * the reason the base-branch check refuses early: no money is spent on a session that cannot commit what it writes.
 *
 * Exactly two commands, because there is one identity path and no escape hatch to mention.
 */
export const NO_IDENTITY = [
  "no git identity on this machine. Gallivant commits as you, so it needs one.",
  '  git config --global user.name  "Your Name"',
  '  git config --global user.email "you@example.com"',
].join("\n");

/** One line for a log or a `doctor` row. The email is the operator's own and is already in every commit they make. */
export const describeIdentity = ({ name, email }) => (name && email ? `${name} <${email}>` : "none");

/**
 * The identity a run will commit as, or a throw. The one place `start`, `resume` and every fix round reach, so the
 * refusal is written once and cannot be enforced on one path and forgotten on another.
 *
 * It throws rather than returning a reason because both callers do the same thing with it and neither can continue: a
 * session that cannot commit what it writes is a session whose whole cost is wasted. Same shape and the same reasoning
 * as the credential refusal it sits beside in both callers.
 *
 * `ctx.identity` is what a test (and `makeContext`) can substitute, exactly as `ctx.credential` already is, so no test
 * depends on whether the machine running the suite has a git identity configured.
 */
export async function requireIdentity(ctx = {}) {
  const resolve = ctx.identity ?? (() => resolveIdentity());
  const id = await resolve();
  if (!id?.name || !id?.email) throw Object.assign(new Error(id?.why || NO_IDENTITY), { code: "NO_IDENTITY" });
  return id;
}
