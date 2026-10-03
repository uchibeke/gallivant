// `gallivant doctor`: the install checklist and the health probe. Every failing line prints the exact command or
// file to fix it. There is no wizard; this plus a hand-written config is the install.
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { configPath, validate, merge, isInside, DEFAULTS, load as loadConfig, whence, discoverHarnesses, repoEntries, repoNames, resolveBase } from "../config.mjs";
import { readJson, exists, fileMode, contract, expand, gallivantHome, templatePath } from "../fs.mjs";
import { aportDirFor, guardrailMode, auditEntries, decisionCounts } from "../aport.mjs";
import { makeGh } from "../gh.mjs";
import { runEnv } from "../git.mjs";
import { resolveCredential, noCredentialMessage, describe as describeCredential, SOURCES } from "../credential.mjs";
import { checkSignIn, checkVersion, checkGh, signInFix } from "../probe.mjs";
import { buildRun, contextSupport } from "../harness.mjs";
import { makeNotifier } from "../notify.mjs";
import { silentLog } from "../log.mjs";

const ok = (detail = "") => ({ ok: true, detail });
const fail = (detail, fix) => ({ ok: false, detail, fix });

/** Different spelling can be the same installation; different installations need a decision, not a downgrade. */
export async function harnessBinaryCheck(harness, config, shellBin = whence(harness)) {
  const bin = config.harness[harness].bin;
  if (!exists(bin)) return fail(`${bin} not found`, `set harness.${harness}.bin to a working installation and run gallivant doctor`);
  const version = await checkVersion(harness, config);
  if (!version.ok) return fail(`${bin}: ${version.detail}`, `upgrade the configured ${harness} executable at ${bin}`);
  if (!shellBin || realpathSync(shellBin) === realpathSync(bin)) return ok(`${bin}: ${version.detail}`);
  const shellConfig = { ...config, harness: { ...config.harness, [harness]: { ...config.harness[harness], bin: shellBin } } };
  const shellVersion = await checkVersion(harness, shellConfig);
  return fail(`configured ${bin}: ${version.detail}; shell ${shellBin}: ${shellVersion.detail}. Nested ${harness} commands can use a different installation`,
    `use the configured executable explicitly for authorized tests, or align the shell command with that verified installation. Do not switch harness.${harness}.bin to the shell version without verifying it. Version and sign-in checks do not prove model access or host/plugin capabilities`);
}



export const CONTROL_PLANE = ["~/.claude", "~/.codex", "~/.config/opencode", "~/.gallivant", "~/.aport"];

/**
 * What a local passport is missing, as a list of sentences, empty when it is sound. Exported because it is the only
 * thing in `doctor` that speaks for the guardrail the docs promise, so it is worth testing on its own.
 *
 * Both directions are checked. Write blocks stop a run editing the rules it is held to; read blocks stop it reading
 * them, which matters just as much: an injected run that can Read or Grep `~/.claude/settings.json`, the passport in
 * `~/.aport`, or `~/.codex` learns exactly where the boundary is and what credentials sit behind it. A template that
 * blocked only writes left that open, so the read list is held to the same five directories as the write list.
 *
 * `blocked_paths` entries are globs; only the directory prefix is compared, so `~/.codex/**` counts for `~/.codex`
 * and a single file inside it, `~/.codex/auth.json`, does not.
 */
export function passportGaps(passport, worktreesRoot) {
  const problems = [];
  const write = passport?.limits?.["data.file.write"] || {};
  const dirs = list => (list || []).map(x => expand(String(x).replace(/\/\*\*$/, "")));
  if (!dirs(write.allowed_paths).includes(worktreesRoot)) problems.push("data.file.write allowed_paths does not contain the worktrees root");
  for (const [capability, limits] of [["data.file.write", write], ["data.file.read", passport?.limits?.["data.file.read"] || {}]]) {
    const blocked = dirs(limits.blocked_paths);
    const missing = CONTROL_PLANE.filter(c => !blocked.includes(expand(c)));
    if (missing.length) problems.push(`${capability} blocked_paths missing ${missing.join(", ")}`);
  }
  return problems;
}

// The install instructions and doctor's repair must describe the same sandbox.
export const SANDBOX_BLOCK = { sandbox: readJson(templatePath("claude-settings.json")).sandbox };

/** Check the native Claude sandbox, including macOS's certificate-verification dependency. */
export function claudeSandboxCheck(settings, settingsPath, platform = process.platform) {
  const sb = settings?.sandbox || {};
  if (sb.enabled !== true || sb.autoAllowBashIfSandboxed !== true || !Array.isArray(sb.network?.allowedDomains) || !sb.network.allowedDomains.length) {
    return fail("sandbox block missing or invalid", `merge this into ${contract(settingsPath)}:\n${JSON.stringify(SANDBOX_BLOCK, null, 2)}`);
  }
  if (platform === "darwin" && sb.enableWeakerNetworkIsolation !== true) {
    return fail("macOS certificate service blocked; sandboxed gh can fail with x509: OSStatus -26276",
      `set sandbox.enableWeakerNetworkIsolation to true in ${contract(settingsPath)} for Apple's trustd.agent. This opens a potential exfiltration route through that service; review ${templatePath("../docs/guardrails.md")} before enabling it. Keep the sandbox and domain allowlist enabled`);
  }
  return ok(contract(settingsPath));
}

/** A config the operator can paste, with every value taken from this machine, not the author's. */
export function suggestedConfig(home, login) {
  // The one place git is run without going through `makeGit`, on purpose: this builds the config that `makeGit`
  // needs, so there is nothing to ask yet. Synchronous and failure-tolerant for the same reason, since a machine
  // with no repository here still deserves a config to paste.
  const cwdRoot = (() => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim(); } catch { return process.cwd(); } })();
  const harness = discoverHarnesses(home);
  return {
    ...DEFAULTS,
    trusted_authors: login ? [login] : ["<your github login>"],
    notify: { ntfy: "https://ntfy.sh/<32 random characters>", email: null },
    worktrees: join(dirname(cwdRoot), ".gallivant-worktrees"),
    github_token_file: null,
    harness,
    repos: [],
  };
}

/**
 * `env`, `resolve` and `probePush` are injected for one reason: the credential checks have to be testable. Their whole
 * purpose is to answer "could a run push", and a check that can only be exercised against whatever `gh` the machine
 * running the test happens to have logged in is a check whose failure path is never tested. All three default to the
 * real thing.
 */
export async function doctor({ home = gallivantHome(), send = false, probe = false, env = process.env, resolve = resolveCredential, probePush = gitPushProbe } = {}) {
  const results = [];
  const check = async (name, fn) => { let r; try { r = await fn(); } catch (e) { r = fail(e.message.split("\n")[0], "see the error above"); } results.push({ name, ...r }); return r; };

  // Config first; most checks need it.
  const raw = readJson(configPath(home), null);
  const rawGh = makeGh({ log: silentLog });
  const login = await rawGh.user().catch(() => null);
  const cfgCheck = await check("config", () => {
    if (!raw) return fail(`no ${contract(configPath(home))}`, `write this file (values from this machine):\n${JSON.stringify(suggestedConfig(home, login), null, 2)}`);
    // `merge` defaults to the real home, so a doctor run against another home (a test, a second instance) validated a
    // config whose discovered harness settings pointed into the default directory while every check below read this
    // one. `load` in config.mjs always passed `home`; doctor was the second caller and did not.
    const problems = validate(merge(raw, home), home);
    if (problems.length) return fail(problems.join("; "), `fix those keys in ${contract(configPath(home))}`);
    const mode = fileMode(configPath(home));
    if (mode !== 0o600) return fail(`mode ${mode?.toString(8)}`, `chmod 600 ${contract(configPath(home))}`);
    return ok(contract(configPath(home)));
  });
  await check("gh auth", async () => (await rawGh.authStatus()) ? ok(login || "authenticated") : fail("not authenticated", "gh auth login"));
  if (!cfgCheck.ok) return results;

  const config = loadConfig(home);

  // The credential a RUN would get, resolved exactly as `start` and the tick resolve it, so every check below answers
  // for the sandboxed child rather than for the operator's own shell. The old check asked `gh` about the operator's
  // keyring and reported "system gh auth: ok" while every run was unable to push, which is worse than no check.
  const runCredential = await resolve(config, { env }).catch(() => ({ token: null, source: null, host: "github.com", why: noCredentialMessage() }));
  // So `gh` acts with that credential. `rawGh` above is deliberately the other thing: the operator's own gh, used only
  // to name the login for the suggested config and to answer "is gh itself signed in".
  const gh = makeGh({ credential: async () => runCredential, log: silentLog });

  await check("run credential", async () => {
    const p = config.github_token_file;
    if (p) {
      if (!exists(p)) return fail(`${contract(p)} missing`, `paste a fine-grained PAT (Contents, Pull requests, Issues: write; Checks, Actions: read; no Workflows) into ${contract(p)} and chmod 600 it, or set github_token_file to null to resolve from gh`);
      if (fileMode(p) !== 0o600) return fail(`mode ${fileMode(p)?.toString(8)}`, `chmod 600 ${contract(p)}`);
    }
    if (!runCredential.token) return fail("a run would get no credential and could not push", runCredential.why);
    // A token that resolves is only half the answer. It has to be accepted, and it has to be able to write; a
    // resolvable token that cannot push is the same defect one step later.
    const r = await checkGh(gh);
    if (!r.ok) return fail(`${describeCredential(runCredential)} is rejected by GitHub: ${r.detail}`, runCredential.source === SOURCES.file ? `the token in ${contract(p)} is expired or revoked; paste a new one` : "gh auth login, or export a valid GH_TOKEN");
    const scopes = await gh.tokenScopes().catch(() => null);
    const kind = scopes === null ? "fine-grained" : `classic (${scopes})`;
    // `repo` is the scope that decides whether a classic token can push. A fine-grained PAT carries no scopes at all,
    // so the absence of the header is not a finding; per-repo permissions are what the next check asks GitHub about.
    if (scopes !== null && !/\brepo\b/.test(scopes)) return fail(`${describeCredential(runCredential)} is a classic token without the \`repo\` scope (${scopes}), so a run cannot push`, `gh auth refresh -s repo, or put a fine-grained PAT with Contents: write in github_token_file`);
    return ok(`${describeCredential(runCredential)}, ${kind}, acts as ${r.detail}`);
  });
  // Push rights per repo, asked of GitHub. Scopes say what a token is allowed to attempt; `permissions.push` says
  // whether this identity may write to this repository, which is the thing a run actually needs and the thing an
  // unapproved fine-grained PAT or a lost collaborator invite silently takes away.
  if (runCredential.token) {
    for (const { repo } of repoEntries(config)) {
      await check(`push rights ${repo}`, async () => {
        const perm = await gh.repoPermissions(repo).catch(e => ({ error: e.message.split("\n")[0] }));
        if (perm?.error) return fail(`cannot read ${repo}: ${perm.error}`, `check the repository name, and that ${describeCredential(runCredential)} can see it`);
        if (perm?.archived) return fail(`${repo} is archived, so nothing can be pushed to it`, `unarchive ${repo}, or take it out of repos in ${contract(configPath(home))}`);
        if (!perm?.push) return fail(`the run credential has no push permission on ${repo}`, config.github_token_file ? `give the PAT in ${contract(config.github_token_file)} Contents: write on ${repo} (and have an org owner approve it if ${repo.split("/")[0]} requires approval)` : `ask for write access on ${repo}, or point github_token_file at a PAT that has it`);
        return ok("push allowed");
      });
    }
  }
  // What a RUN can actually do with git, asked by doing it. This replaced a check that read `~/.gallivant/gitconfig`
  // and grepped its helper lines, which was the wrong question twice over: nothing reads that file any more, and even
  // when something did, a file whose CONTENT is correct still fails if the process cannot READ it. That is exactly
  // what happened. See `gitPushProbe` for what this runs and why HOME is pointed at nothing.
  if (runCredential.token) {
    await check("run git push", async () => probePush({ config, credential: runCredential, repoEntries: repoEntries(config) }));
  }
  for (const h of Object.keys(config.harness)) {
    await check(`${h} binary`, () => harnessBinaryCheck(h, config));
    await check(`${h} sign-in`, async () => { const r = await checkSignIn(h, config); return r.ok ? ok() : fail(r.detail, signInFix(h)); });
  }
  // Extra read-only directories reach the harnesses unevenly, so say per harness what the operator's own list will
  // actually do rather than letting them assume it works everywhere. Only checked when they have asked for one.
  if (config.context_paths?.length) {
    for (const h of Object.keys(config.harness)) {
      await check(`${h} context_paths`, () => {
        const s = contextSupport(h);
        if (s.kind === "grant") return ok(`${config.context_paths.length} extra read-only director${config.context_paths.length === 1 ? "y" : "ies"}`);
        if (s.kind === "refuse") return fail(s.detail, `remove context_paths, or stop sending briefs to ${h}`);
        return ok(`no effect: ${s.detail}`);
      });
    }
  }
  await check("jq", () => whence("jq") ? ok(whence("jq")) : fail("missing; the APort hook denies every call without it", "brew install jq"));

  if (config.harness.claude) {
    const settingsPath = config.harness.claude.settings;
    await check("claude settings file", () => {
      const s = readJson(settingsPath, null);
      const install = `APORT_CLAUDE_CODE_CONFIG_DIR=${contract(dirname(settingsPath))} npx @aporthq/aport-agent-guardrails claude-code   # choose "Create local passport file"`;
      if (!s) return fail(`${contract(settingsPath)} missing`, install);
      const hooks = s.hooks?.PreToolUse || [];
      const hasHook = hooks.some(h => (h.matcher === "*" || !h.matcher) && JSON.stringify(h).includes("aport"));
      if (!hasHook) return fail("no APort PreToolUse hook with matcher *", install);
      return claudeSandboxCheck(s, settingsPath);
    });
    // Denials the guardrail did not actually decide. A warn rather than a fail: nothing is misconfigured here, and the
    // operator may have nothing to fix, but they need the number before they conclude their policy is too tight. A run
    // sees `oap.evaluation_error` as "APort denied this tool call" exactly as it sees `oap.blocked_pattern`, so a spell
    // of rate limits from aport.io is indistinguishable, from inside the session, from a rule that is too strict.
    await check("guardrail decisions", () => {
      const counts = decisionCounts(aportDirFor(settingsPath));
      if (!counts.total) return ok("no decisions recorded yet");
      const rate = counts.denied ? Math.round((counts.evaluationErrors / counts.denied) * 100) : 0;
      const summary = `${counts.total} decisions, ${counts.denied} denied`;
      if (!counts.evaluationErrors) return ok(`${summary}, all of them policy decisions`);
      // `ok` rather than a failure, deliberately. Nothing here is misconfigured and there may be nothing to fix, so
      // this must not add to the failed count and change what a non-zero exit means. It is a number the operator needs
      // in front of them, not a verdict on their setup.
      return ok(`${summary}, of which ${counts.evaluationErrors} (${rate}% of denials) were oap.evaluation_error rather than a policy decision: the guardrail could not reach a decision and denied because it fails closed. Those are its own transport or schema failures (an HTTP 429 from aport.io, or its request failing validation), so check aport.io before loosening a rule`);
    });
    await check("passport", () => {
      const aportDir = aportDirFor(settingsPath);
      const { mode, agentId, enforcement } = guardrailMode(aportDir);
      // A hosted passport's limits live at aport.io, edited in the dashboard, so nothing here can read or fix them.
      // Say what they should be and whose job it is, rather than reporting a check that was never made.
      if (mode === "api" && agentId) return ok(`hosted passport ${agentId} (${enforcement}); its limits are not readable from here. In the dashboard set data.file.write allowed_paths to ${config.worktrees}/** and both data.file.write and data.file.read blocked_paths to ${CONTROL_PLANE.join(", ")} (see ${templatePath("passport.gallivant.json")})`);
      const p = join(aportDir, "passport.json");
      const pass = readJson(p, null);
      const fix = [
        "one of:",
        `  hosted:   APORT_CLAUDE_CODE_CONFIG_DIR=${contract(dirname(settingsPath))} npx @aporthq/aport-agent-guardrails claude-code --quick-hosted --email <you>`,
        `  existing: APORT_CLAUDE_CODE_CONFIG_DIR=${contract(dirname(settingsPath))} npx @aporthq/aport-agent-guardrails claude-code <agent_id>`,
        `  local:    cp ${templatePath("passport.gallivant.json")} ${contract(p)} and replace {{worktrees}} with ${config.worktrees} and {{home}} with your home directory`,
      ].join("\n");
      if (!pass) return fail(`${contract(p)} missing and no hosted passport configured`, fix);
      const problems = passportGaps(pass, config.worktrees);
      if (problems.length) return fail(problems.join("; "), fix);
      return ok(`local passport ${contract(p)} (${enforcement})`);
    });
    await check("global claude settings", () => {
      const g = readJson(expand("~/.claude/settings.json"), {}) || {};
      return ok(g.permissions?.blockReadsOutsideWorkingDirectories ? "blockReadsOutsideWorkingDirectories on; runs deny out-of-tree reads instead of prompting" : "no read block set");
    });
  }
  if (config.harness.codex) {
    await check("codex hook", () => {
      const install = "npx @aporthq/aport-agent-guardrails codex --global --enforcement=warn   # then open codex, run /hooks, trust it";
      const hooks = readJson(expand("~/.codex/hooks.json"), null);
      const groups = hooks?.hooks?.PreToolUse;
      const wired = Array.isArray(groups) && groups.some(g => (g.hooks || []).some(h => /aport-codex-hook\.sh/.test(String(h.command || ""))));
      if (!wired) return fail(hooks ? "~/.codex/hooks.json has no APort PreToolUse hook entry (only a description)" : "~/.codex/hooks.json missing", install);
      const { mode: m0, enforcement } = guardrailMode(expand("~/.aport/codex/aport"));
      const mode = m0 || "local";
      return enforcement === "warn" ? ok(`global, ${mode}, warn`) : ok(`global, ${mode}, ${enforcement} (warn is recommended until APort handles multi-file apply_patch)`);
    });
  }
  await check("worktrees root", () => {
    if (isInside(config.worktrees, home)) return fail("under the Gallivant home", "move worktrees outside ~/.gallivant");
    if (!exists(config.worktrees)) return fail(`${config.worktrees} missing`, `mkdir -p ${config.worktrees}`);
    return ok(contract(config.worktrees));
  });
  // The base branch each configured repository targets, and where that answer came from. It is a check rather than a
  // log line because the failure it catches is silent: a repository whose pull requests all go to `staging` while
  // nothing is configured reads as perfectly healthy, and the first sign is a PR opened against `main`. So the source
  // is named on every line. Nothing here is derived from the repository's history or its CONTRIBUTING file, and that is
  // the reason this check exists in this shape: a derived base could be wrong, and a wrong base nobody typed is the
  // hardest kind to find. An explicit one has to be typed once and then it is visible here forever.
  for (const { repo } of repoEntries(config)) {
    await check(`base branch ${repo}`, async () => {
      const def = await gh.repoDefaultBranch(repo).catch(() => null);
      const { base, source } = resolveBase({ config, repo, defaultBranch: def });
      if (!base) return fail(`no base branch for ${repo}`, `GitHub reported no default branch and none is configured. Add { "repo": "${repo}", "base": "<branch>" } to repos in ${contract(configPath(home))}`);
      if (source === "default") return ok(`${base} (${repo}'s default branch; nothing configured). Pull requests will target it. To target another branch, set { "repo": "${repo}", "base": "<branch>" } in repos, or run start with --base <branch> once`);
      // A configured base that is not on the remote is the whole reason to check rather than only print. `start` refuses
      // it, but an operator who set it last month wants to hear about it now, not the next time they start something.
      if (!await gh.branchExists(repo, base)) return fail(`repos configures base ${base} for ${repo}, and GitHub does not have that branch`, `fix the base for ${repo} in repos in ${contract(configPath(home))}, or create ${base} on ${repo}`);
      return ok(`${base} (configured in repos${def && def !== base ? `; ${repo}'s default branch is ${def}` : ""})`);
    });
  }
  // `repoNames` and not `config.repos`, because an entry may be `{ repo, base }` rather than a bare string. Reading the
  // raw list named the check "ruleset [object Object]" and handed that object to `gh.rulesets`, which then answered
  // for no repository at all and reported "no active ruleset" for a repo whose ruleset was never asked about. Every
  // other loop over repositories here already goes through `repoEntries`; this one was the exception.
  for (const repo of repoNames(config)) {
    await check(`ruleset ${repo}`, async () => {
      const rs = await gh.rulesets(repo).catch(() => []);
      const create = `gh api -X POST repos/${repo}/rulesets --input - <<'EOF'\n${JSON.stringify(rulesetBody(), null, 2)}\nEOF`;
      // An active ruleset somewhere in the repo says nothing about the default branch: one on a release branch
      // would pass while main sat open. The guarantee in section 6.11 is specifically that the default branch
      // refuses a direct push and a force push, so the check has to name the branch and the rules.
      const verdict = await protectsDefaultBranch(gh, repo, rs);
      return verdict.ok ? ok(verdict.detail) : fail(verdict.detail, verdict.fix ?? create);
    });
  }
  await check("ntfy", async () => {
    if (!config.notify) return ok("notify is null; transitions are logged only");
    if (/[<>\s]/.test(config.notify.ntfy)) return fail("notify.ntfy still has the placeholder", "set notify.ntfy to https://ntfy.sh/<topic> with a topic of 32 random characters, e.g. from: openssl rand -hex 16");
    try { new URL(config.notify.ntfy); } catch { return fail("notify.ntfy is not a URL", "set notify.ntfy to https://ntfy.sh/<topic>"); }
    if (!send) return ok(`${config.notify.ntfy} (pass --send to test)`);
    const sent = await makeNotifier({ config, log: silentLog }).test();
    return sent ? ok("test message sent") : fail("send failed", `curl -d test -H 'Title: gallivant' ${config.notify.ntfy}`);
  });
  if (probe && config.harness.claude) await check("probe run", () => probeRun(config));
  return results;
}

/**
 * Whether some active ruleset actually protects the default branch. Returns { ok, detail, fix }.
 *
 * A ruleset counts only when it targets branches, is active, matches the default branch (by `~DEFAULT_BRANCH`
 * or by its name), blocks force pushes (`non_fast_forward`) and requires a pull request for updates, and has no
 * bypass actors. Anything less is reported as what it is rather than as a pass; `rulesets` needs admin rights, so
 * a repo the token cannot read rulesets for is reported as unknown instead of as protected.
 */
export async function protectsDefaultBranch(gh, repo, rulesets) {
  const active = (rulesets || []).filter(r => r.enforcement === "active" && (r.target ?? "branch") === "branch");
  if (!active.length) return { ok: false, detail: (rulesets || []).length ? "rulesets exist but none is active" : "no active ruleset" };
  let branch = null;
  try { branch = (await gh.repoDefaultBranch(repo)) ?? null; } catch { /* reported below */ }
  const matches = r => {
    const inc = r.conditions?.ref_name?.include ?? [];
    const exc = r.conditions?.ref_name?.exclude ?? [];
    if (branch && (exc.includes("~DEFAULT_BRANCH") || exc.includes(`refs/heads/${branch}`))) return false;
    return inc.includes("~DEFAULT_BRANCH") || inc.includes("~ALL") || (!!branch && inc.includes(`refs/heads/${branch}`));
  };
  const onDefault = active.filter(matches);
  const named = branch ? `the default branch (${branch})` : "the default branch";
  if (!onDefault.length) return { ok: false, detail: `${active.length} active ruleset(s), none targeting ${named}` };
  // The rules may be spread across several rulesets; GitHub applies them all, so check the union.
  const types = new Set(onDefault.flatMap(r => (r.rules || []).map(x => x.type)));
  const bypass = onDefault.flatMap(r => r.bypass_actors || []);
  const missing = ["non_fast_forward", "pull_request"].filter(t => !types.has(t));
  if (missing.length) return { ok: false, detail: `ruleset on ${named} is missing: ${missing.join(", ")}` };
  if (bypass.length) return { ok: false, detail: `ruleset on ${named} has ${bypass.length} bypass actor(s); a run using that identity is not held by it`, fix: `gh api repos/${repo}/rulesets and remove bypass_actors` };
  return { ok: true, detail: `${named}: force pushes blocked, updates need a pull request, no bypass actors` };
}

/** A ruleset that blocks direct updates and force pushes on the default branch, with no bypass actors. */
export const rulesetBody = () => ({
  name: "Protect default branch", target: "branch", enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } }],
  bypass_actors: [],
});

/**
 * Whether a run could actually talk to GitHub over git, asked by running git rather than by reading a config file.
 *
 * This exists because two sessions in a row diagnosed the wrong file. The real failure was
 *
 *     fatal: unable to access '/Users/<you>/.gallivant/gitconfig': Operation not permitted
 *
 * and git's fallback message for a missing credential names `~/.git-credentials`, so the reported symptom and the
 * actual cause named different files. A check that reads a config file and pronounces on its content cannot see that
 * class of failure at all: the content was correct and unreadable. So this one reproduces the run's condition and
 * prints whatever git says, verbatim.
 *
 * Two things make it the run's condition rather than the operator's shell:
 *
 *  - The environment is `runEnv`'s, and only `runEnv`'s, with nothing inherited but `PATH`. A check that spread
 *    `process.env` would pass on the strength of variables a detached child never gets.
 *  - `HOME` is pointed at a path that does not exist. A sandboxed run cannot read outside its worktree, so anything
 *    git would look for under `$HOME` is denied to it; an unreadable HOME is the cheapest faithful stand-in, and it is
 *    what makes this check fail when a path outside the worktree creeps back into `runEnv`.
 *
 * `GIT_TERMINAL_PROMPT=0` so a missing credential is an error rather than a hang. `ls-remote` and not `push
 * --dry-run`: it is read-only, needs no local checkout of the repo, and authenticates the same way, so it answers
 * "would the credential be accepted for this remote" without writing anything anywhere.
 *
 * Returns doctor's `{ ok, detail, fix }`. Exported so a test can call it against a remote that cannot work.
 */
export async function gitPushProbe({ config, credential, repoEntries: entries = [], exec = execFileSync } = {}) {
  const repo = entries[0]?.repo;
  if (!repo) return ok("no repos configured, so there is no remote to try");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "gallivant-git-probe-"));
  const env = { PATH: process.env.PATH, HOME: join(dir, "no-such-home"), GIT_TERMINAL_PROMPT: "0", ...runEnv(config, credential) };
  try {
    exec("git", ["init", "--quiet", dir], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
    exec("git", ["ls-remote", "--heads", `https://github.com/${repo}.git`], { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
  } catch (e) {
    // git's own words, not a paraphrase. The whole reason this check exists is that the paraphrase named the wrong
    // file. Every line is kept: the first names what failed and a later one often names the path it failed on.
    const said = scrubbed(String(e.stderr || e.stdout || e.message), credential?.token).trim() || "git failed and said nothing";
    // `unable to access '<path>'` is the shape the real defect took, and the path it names is the finding. Taken from
    // the message rather than guessed at from a list of known filenames: any path outside the worktree is the same
    // defect, and a list would only ever name the ones already found.
    const outside = said.match(/unable to (?:access|read config file) '([^']+)'/)?.[1];
    return fail(
      `a run could not reach ${repo} over git. git said:\n       ${said.split("\n").join("\n       ")}`,
      outside
        ? `git is being told to read ${outside}, which is outside the worktree and which a sandboxed run cannot read. Nothing should name a file outside the worktree; check runEnv in lib/git.mjs`
        : "the run credential is not accepted for this remote over git. Check the `run credential` line above, and that the token has Contents access on this repository",
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return ok(`${repo} reachable with the run's own environment and no readable HOME`);
}

/** Whatever git said, with the credential taken out of it. Nothing that reports on a run may print the token. */
const scrubbed = (text, token) => (token ? text.split(token).join("<token>") : text);

/** A real Claude run in a temp dir: a write inside must succeed, a write outside must be denied. */
async function probeRun(config) {
  const { mkdtempSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "gallivant-probe-"));
  const outside = join(tmpdir(), `gallivant-probe-outside-${process.pid}`);
  try { rmSync(outside, { force: true }); } catch { /* fresh */ }
  const prompt = `Use the Write tool to create ./ok.txt containing "ok". Then use the Write tool to create ${outside} containing "no". Report what happened in one line.`;
  const spec = buildRun({ harness: "claude", config, mode: "start", session: crypto.randomUUID(), prompt, cwd: dir });
  const startedAt = Date.now();
  const r = spawnSync(spec.cmd, spec.args, { cwd: dir, env: { ...process.env, ...spec.env }, encoding: "utf8", timeout: 180_000 });
  const inside = existsSync(join(dir, "ok.txt")), escaped = existsSync(outside);
  const denials = (r.stdout.match(/"permission_denials":\s*\[[^\]]*\]/) || [])[0] || "";
  try { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { force: true }); } catch { /* best effort */ }
  if (r.status !== 0) return fail(`exit ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").at(-1)}`, "run the command from cmd.json of a run folder by hand");
  if (!inside) return fail("./ok.txt was not written", "the sandbox or the passport blocks writes inside the worktree; check allowed_paths");
  if (escaped) {
    // Tell apart "the hook never ran" from "the hook ran and the passport allowed it": the audit log knows.
    const aportDir = aportDirFor(config.harness.claude.settings);
    const hookRan = auditEntries(aportDir, { fromMs: startedAt, filter: /tool=write/ }).length > 0;
    const { agentId } = guardrailMode(aportDir);
    if (!hookRan) return fail(`${outside} was written and the APort audit log has no write decision for this run`, "the hook did not run: check hooks.PreToolUse in the settings file names the runtime hook script and that jq is installed");
    if (agentId) return fail(`${outside} was written; the hook ran and hosted passport ${agentId} allowed it`, `in the aport.io dashboard set data.file.write allowed_paths on ${agentId} to ${config.worktrees}/** and both write and read blocked_paths to the control-plane directories (see ${templatePath("passport.gallivant.json")}), or switch this install to a local passport`);
    return fail(`${outside} was written; the hook ran and the local passport allowed it`, `set data.file.write allowed_paths in the passport to ${config.worktrees}/**`);
  }
  return ok(`inside ok, outside denied${denials ? ` (${denials.slice(0, 120)})` : ""}`);
}

export function renderDoctor(results) {
  const lines = results.map(r => `${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(24)} ${r.detail || ""}${r.ok ? "" : `\n       fix: ${String(r.fix).replace(/\n/g, "\n            ")}`}`);
  const failed = results.filter(r => !r.ok).length;
  lines.push("", failed ? `${failed} check(s) failed.` : "All checks passed.");
  return { text: lines.join("\n"), exitCode: failed ? 1 : 0 };
}
