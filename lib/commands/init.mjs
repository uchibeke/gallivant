// `gallivant init`: set up the repository you are standing in, then hand over to `doctor`.
//
// Explicit setup only. It never signs in for you, never reads a password or token, never touches global harness
// settings, credentials or repository permissions, and never rewrites a key the operator wrote. Repeating it is safe:
// an existing config keeps every value as written and gains at most one `repos` entry, the one for this checkout.
//
// Every prerequisite is checked before anything is written, so a signed-out `gh`, a signed-out harness or a checkout
// that is not a GitHub repository stops the command with the exact action and leaves no partial state behind.
import { mkdirSync, openSync, closeSync, writeFileSync, lstatSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { gallivantHome, expand, templatePath, readJson, writeJsonAtomic, contract, VERSION, PACKAGE_NAME } from "../fs.mjs";
import { discoverHarnesses, validate, merge, configPath, repoEntry } from "../config.mjs";
import { makeGh, repoFromRemote } from "../gh.mjs";
import { silentLog } from "../log.mjs";
import { checkHarness } from "../probe.mjs";
import { resolveCredential, describe as describeCredential } from "../credential.mjs";
import { doctor as runDoctor } from "./doctor.mjs";
import { acquireCliMutation } from "../daemon.mjs";

export const INIT_HARNESSES = ["codex", "claude"];

/** Every message that stops setup ends with this, so nobody reads a stopped run as a half-finished one. */
const NOTHING_WRITTEN = "Setup did not complete and nothing was written.";

const firstLine = e => String(e?.message || e).split("\n")[0];
const isSymlink = p => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

/**
 * A remote URL with its userinfo removed. `https://x-access-token:SECRET@github.com/...` is a remote git and
 * `repoFromRemote` both accept, and every message here that names the origin would otherwise print the secret into
 * a terminal or a CI log. Only scheme URLs carry userinfo; `git@github.com:owner/name` names a login, not a secret.
 */
export const safeOrigin = url => String(url || "").replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1");

/**
 * The repository a checkout belongs to, read from its `origin` remote. Local only: no network, no `gh`. Throws a
 * message naming the unmet prerequisite, so a directory that is not a GitHub checkout is refused before anything else
 * runs. `owner/name` is lowercased as `repoFromRemote` does, which is also how `rememberRepo` and `doctor` spell it.
 */
export function targetRepository(dir = process.cwd(), exec = execFileSync) {
  const git = args => {
    try { return exec("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim(); }
    catch (e) {
      if (e?.code === "ENOENT") throw new Error(`git is not on PATH. Install Git, then rerun gallivant init. ${NOTHING_WRITTEN}`);
      return null;
    }
  };
  const checkout = git(["rev-parse", "--show-toplevel"]);
  if (!checkout) throw new Error(`${dir} is not inside a Git checkout. Run gallivant init from the repository you want to set up (cd into it first). ${NOTHING_WRITTEN}`);
  const origin = git(["remote", "get-url", "origin"]);
  if (!origin) throw new Error(`${checkout} has no origin remote. Create the repository on GitHub and add it (git remote add origin https://github.com/<owner>/<name>.git), then rerun gallivant init. ${NOTHING_WRITTEN}`);
  const repo = repoFromRemote(origin);
  if (!repo) throw new Error(`origin remote ${safeOrigin(origin)} is not a github.com repository URL. Gallivant opens pull requests on github.com; point origin at the GitHub repository, then rerun gallivant init. ${NOTHING_WRITTEN}`);
  // The redacted form is the only one returned: nothing downstream needs the credential, and nothing may print it.
  return { checkout, origin: safeOrigin(origin), repo };
}

/** Infer a harness only when there is one local choice; otherwise setup requires an explicit selection. */
const onlyLocalHarness = raw => {
  const names = Object.keys(raw?.harness || {}).filter(n => INIT_HARNESSES.includes(n));
  return names.length === 1 ? names[0] : null;
};

/** `checkHarness` reads expanded paths, as `load` would hand them over; a raw config may still spell them with `~`. */
const expandedFor = (config, name) => {
  const h = config.harness[name];
  return { ...config, harness: { ...config.harness, [name]: { ...h, bin: expand(h.bin), ...(h.settings ? { settings: expand(h.settings) } : {}) } } };
};

/**
 * Options:
 *   home       the Gallivant home; `config.json` lives here
 *   harness    `codex` or `claude`; null keeps an existing config's harnesses and defaults a new one to codex
 *   worktrees  where task checkouts go; refused when an existing config already chose a different directory
 *   dir        the target checkout; the repository it belongs to is what gets recorded
 * The rest are injected for tests: harness discovery, the operator's own `gh` (used only to name the login), the
 * credential resolver and the `gh` built from what it resolves, repository resolution, the readiness check and `doctor`.
 */
export async function init(options = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await initAttempt(options); }
    catch (error) {
      if (error.code !== "INIT_CONFIG_CHANGED" || attempt >= 2) throw error;
    }
  }
}

async function initAttempt({ home = gallivantHome(), harness = null, worktrees = null, dir = process.cwd(),
  discover = discoverHarnesses, gh = makeGh({ log: silentLog }), repository = targetRepository, harnessCheck = checkHarness, doctor = runDoctor,
  resolve = resolveCredential, ghFor = credential => makeGh({ credential: async () => credential, log: silentLog }) } = {}) {
  if (harness != null && !INIT_HARNESSES.includes(harness)) throw new Error("init supports --harness codex or claude; configure other adapters explicitly after checking docs/install.md");
  home = expand(home);
  const file = configPath(home);
  // `lstat` rather than `exists`: a dangling symlink does not exist and is still a symlink.
  for (let d = home; ; d = dirname(d)) {
    if (isSymlink(d)) throw new Error(`Setup directory must not be a symlink: ${d}. ${NOTHING_WRITTEN}`);
    if (dirname(d) === d) break;
  }
  const missing = Symbol("missing config");
  const raw = readJson(file, missing);
  const existing = raw !== missing;
  if (existing && (raw === null || typeof raw !== "object" || Array.isArray(raw))) throw new Error(`${file} is not a JSON object. Fix or move it, then rerun gallivant init. ${NOTHING_WRITTEN}`);

  // 1. The repository, before any network call: a directory that is not a GitHub checkout has nothing to set up.
  const target = repository(dir);

  // 2. GitHub sign-in, by asking `gh` who it is. The fix is `gh`'s own login flow; nothing here reads a credential.
  let login = null, ghError = null;
  try { login = await gh.user(); } catch (e) { ghError = firstLine(e); }
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(login || "")) throw new Error(`GitHub CLI is not signed in${ghError ? ` (${ghError})` : ""}.\nRun: gh auth login\nThen rerun gallivant init. ${NOTHING_WRITTEN}`);

  // 3. The config this run would leave behind, built but not yet written.
  const selected = harness ?? (existing ? onlyLocalHarness(raw) : "codex");
  const candidate = existing ? structuredClone(raw) : {
    trusted_authors: [login], worktrees: expand(worktrees || join(dirname(home), ".gallivant-worktrees")),
    harness: {}, notify: null, github_token_file: null, repos: [],
  };
  if (existing && worktrees && expand(worktrees) !== expand(raw.worktrees)) throw new Error(`config already sets worktrees to ${raw.worktrees}; edit ${contract(file)} to move it rather than passing --worktrees. ${NOTHING_WRITTEN}`);
  if (selected && !candidate.harness?.[selected]) {
    const found = discover(home)[selected];
    if (!found) throw new Error(`${selected} is not on PATH. Install it and sign in, then retry gallivant init --harness ${selected}. ${NOTHING_WRITTEN}`);
    candidate.harness = { ...(candidate.harness || {}), [selected]: found };
  }
  const merged = merge(candidate, home);
  const problems = validate(merged, home);
  if (problems.length) throw new Error(`${existing ? `Config problems in ${contract(file)}: ` : ""}${problems.join("; ")}. ${NOTHING_WRITTEN}`);
  if (!selected) throw new Error(`Choose a harness: rerun gallivant init --harness codex or gallivant init --harness claude. ${NOTHING_WRITTEN}`);

  // 4. The selected harness has to be installed at a supported version and signed in. The adapter owns the fix line
  //    (`codex login`, `claude auth login`); init only repeats it. Version and sign-in say nothing about model access.
  if (selected) {
    const ready = await harnessCheck(selected, expandedFor(merged, selected));
    if (!ready.ok) throw new Error(`${selected} is not ready (${ready.detail}).\nRun: ${ready.fix}\nThen rerun gallivant init --harness ${selected}. ${NOTHING_WRITTEN}`);
  }

  // 5. The repository has to be one a RUN can push to, asked of GitHub with the credential this config resolves
  //    (`github_token_file` first, then the environment, then `gh`), exactly as `start` and `doctor` resolve it. The
  //    operator's ambient login is the wrong identity to ask: an explicit PAT that cannot reach the repository is the
  //    failure this check exists to catch, and an ambient login that can would hide it.
  const runConfig = { ...merged, github_token_file: merged.github_token_file ? expand(merged.github_token_file) : null };
  let credential;
  try { credential = await resolve(runConfig); } catch (e) { throw new Error(`${firstLine(e)}\n${NOTHING_WRITTEN}`); }
  if (!credential?.token) throw new Error(`${credential?.why || "No GitHub credential could be resolved for a run."}\n${NOTHING_WRITTEN}`);
  const identity = describeCredential(credential);
  const perm = await ghFor(credential).repoPermissions(target.repo).catch(e => ({ error: firstLine(e) }));
  if (!perm || perm.error) throw new Error(`GitHub cannot resolve ${target.repo} with the run credential (${identity})${perm?.error ? `: ${perm.error}` : ""}. Check that origin (${safeOrigin(target.origin)}) names a repository that credential can see, then rerun gallivant init. ${NOTHING_WRITTEN}`);
  if (perm.archived) throw new Error(`${target.repo} is archived, so nothing can be pushed to it. Unarchive it or run gallivant init in another repository. ${NOTHING_WRITTEN}`);
  if (!perm.push) throw new Error(`the run credential (${identity}) has no push permission on ${target.repo}. ${runConfig.github_token_file ? `Give the token in ${contract(runConfig.github_token_file)} Contents: write on ${target.repo}` : "Ask for write access, or fork it and point origin at the fork"}, then rerun gallivant init. ${NOTHING_WRITTEN}`);

  // 6. Write. The repository is deduplicated by lowercased name whichever form each entry takes, so a second run,
  //    or a run from a clone whose remote spells the owner differently, never appends a duplicate. The string form is
  //    what a first use writes; a base branch is chosen with `start --base` or by hand, not here.
  const repos = Array.isArray(candidate.repos) ? candidate.repos : [];
  const known = repos.some(r => repoEntry(r)?.repo === target.repo);
  if (!known) candidate.repos = [...repos, target.repo];
  const changed = !existing || JSON.stringify(candidate) !== JSON.stringify(raw);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const owner = acquireCliMutation(home);
  try {
    // Probes await external tools. Another CLI writer may have changed the config meanwhile. Compare under the
    // shared mutation lock, then retry all probes against the new settings rather than overwriting or trusting them.
    const current = readJson(file, missing);
    if (JSON.stringify(current) !== JSON.stringify(raw)) throw Object.assign(new Error(`Config changed during setup; rerun gallivant init. ${NOTHING_WRITTEN}`), { code: "INIT_CONFIG_CHANGED" });
    mkdirSync(expand(merged.worktrees), { recursive: true, mode: 0o700 });
    if (!existing) {
      // wx also refuses a dangling symlink.
      const fd = openSync(file, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(candidate, null, 2) + "\n"); } finally { closeSync(fd); }
    } else if (changed) {
      writeJsonAtomic(file, candidate, 0o600);
    }
  } finally { owner.release(); }

  // 7. The same report `doctor` prints, so the operator reads one checklist rather than two.
  const results = await doctor({ home });
  return {
    file, created: !existing, changed, login,
    repo: target.repo, checkout: target.checkout, recorded: !known,
    harness: selected, harnesses: Object.keys(merged.harness),
    worktrees: expand(merged.worktrees),
    preserved: existing ? Object.keys(raw).filter(k => k !== "repos") : [],
    config: merged, doctor: results,
    templates: { passport: templatePath("passport.gallivant.json"), sandbox: templatePath("claude-settings.json") },
  };
}

/**
 * Whether this process was started by `npx` / `npm exec` rather than from an installed `gallivant` command. npm
 * marks the child's environment; the `_npx` cache directory in the script path is the fallback for a shell that
 * stripped the environment.
 */
export const viaNpx = (env = process.env, script = process.argv[1] || "") =>
  env.npm_command === "exec" || env.npm_lifecycle_event === "npx" || /[\\/]_npx[\\/]/.test(script);

/** The command that runs this package again, spelled for how it was started this time. */
export const commandPrefix = npx => (npx ? `npx --yes ${PACKAGE_NAME}` : "gallivant");

export const FIRST_TASK = "Document how to run the existing tests in CONTRIBUTING.md. Use the commands already defined in the repository. Change documentation only.";

/**
 * What `gallivant init` prints: what it did, doctor's report, and what to run next. `report` is `renderDoctor`'s
 * result. The `npx` paragraph says what `npx` did and did not do, because a one-command setup that silently looked
 * like a global installation would send the operator looking for a `gallivant` command that is not there.
 */
export function renderInit(r, report, { npx = viaNpx(), script = process.argv[1] } = {}) {
  const cmd = commandPrefix(npx);
  const failed = r.doctor.filter(x => !x.ok).length;
  const lines = [
    `Package:    ${PACKAGE_NAME} ${VERSION}${npx ? " (run by npx)" : ""}`,
    `Running:    ${script ? safeRealpath(script) : "(unknown)"}`,
    `Config:     ${contract(r.file)} (${r.created ? "created, mode 600" : r.changed ? `kept; ${r.preserved.length} existing key(s) preserved` : "unchanged"})`,
    `Harness:    ${r.harness ? `${r.harness} (${r.config.harness[r.harness]?.bin || "configured"})` : r.harnesses.join(", ") || "none"}`,
    `Repository: ${r.repo} (${r.recorded ? "recorded in repos" : "already in repos; not duplicated"})`,
    `Worktrees:  ${r.worktrees}`,
    "",
    "Doctor:",
    report.text,
    "",
    "Next:",
  ];
  if (failed) lines.push(`  Fix the ${failed} failing check(s) above, then run:   ${cmd} doctor`);
  else lines.push(`  All checks passed. Confirm the reviewer setting in ${contract(r.file)} (default: the Codex GitHub review integration), then start a small task.`);
  lines.push(
    `  First task (uses your ${r.harness} account for inference; --run authorizes implementation once the brief is ready):`,
    `    ${cmd} task ${JSON.stringify(FIRST_TASK)} --harness ${r.harness} --verify 'git diff --check' --run`,
    `    ${cmd} start`,
    "  Setup did not create a GitHub ruleset, install harness hooks, start a task or merge anything; doctor names each remaining step.",
    `  Guide: https://github.com/uchibeke/gallivant/blob/main/docs/install.md`,
  );
  if (npx) {
    lines.push("",
      `npx ran ${PACKAGE_NAME} on demand from npm's cache. Nothing was installed globally and no gallivant command was added to your PATH.`,
      `  Run it again any time:        ${cmd} doctor`,
      `  Optional persistent install:  npm install -g ${PACKAGE_NAME}   # then use plain: gallivant doctor`);
  }
  lines.push("", "Packaged templates:", `  ${r.templates.passport}`, `  ${r.templates.sandbox}`);
  return lines.join("\n");
}

const safeRealpath = p => { try { return realpathSync(p); } catch { return p; } };
