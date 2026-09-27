// `gallivant doctor`: the install checklist and the health probe. Every failing line prints the exact command or
// file to fix it. There is no wizard; this plus a hand-written config is the install.
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { configPath, validate, merge, isInside, DEFAULTS, load as loadConfig, whence, discoverHarnesses } from "../config.mjs";
import { readJson, readText, exists, fileMode, contract, expand, gallivantHome, templatePath } from "../fs.mjs";
import { aportDirFor, guardrailMode, auditEntries } from "../aport.mjs";
import { makeGh } from "../gh.mjs";
import { checkSignIn, checkVersion, checkGh, signInFix } from "../probe.mjs";
import { buildRun, contextSupport } from "../harness.mjs";
import { makeNotifier } from "../notify.mjs";
import { silentLog } from "../log.mjs";

const ok = (detail = "") => ({ ok: true, detail });
const fail = (detail, fix) => ({ ok: false, detail, fix });



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

export const SANDBOX_BLOCK = {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    network: { allowedDomains: ["github.com", "api.github.com", "*.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] },
  },
};

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

export async function doctor({ home = gallivantHome(), send = false, probe = false } = {}) {
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
  const gh = makeGh({ tokenFile: config.github_token_file, log: silentLog });

  await check("github token", async () => {
    const p = config.github_token_file;
    if (!p) {
      const scopes = await rawGh.tokenScopes().catch(() => null);
      return ok(`system gh auth${scopes ? ` (classic token: ${scopes})` : ""}. Optional: a fine-grained PAT in github_token_file narrows what a run can reach`);
    }
    if (!exists(p)) return fail(`${contract(p)} missing`, `paste a fine-grained PAT (Contents, Pull requests, Issues: write; Checks, Actions: read; no Workflows) into ${contract(p)} and chmod 600 it, or set github_token_file to null to use system gh auth`);
    if (fileMode(p) !== 0o600) return fail(`mode ${fileMode(p)?.toString(8)}`, `chmod 600 ${contract(p)}`);
    const r = await checkGh(gh);
    if (!r.ok) return fail(r.detail, "the token is rejected; create a new fine-grained PAT");
    const scopes = await gh.tokenScopes().catch(() => null);
    if (scopes) return fail(`classic token with scopes: ${scopes}`, "use a fine-grained PAT limited to the participating repos");
    return ok(`fine-grained, acts as ${r.detail}`);
  });
  await check("gitconfig", () => {
    const p = join(home, "gitconfig");
    const want = "[credential]\n\thelper = !gh auth git-credential\n";
    const text = readText(p, "");
    return /gh auth git-credential/.test(text) ? ok(contract(p)) : fail(`${contract(p)} missing the gh helper`, `write ${contract(p)}:\n${want}`);
  });
  for (const h of Object.keys(config.harness)) {
    await check(`${h} binary`, async () => {
      const bin = config.harness[h].bin;
      if (!exists(bin)) return fail(`${bin} not found`, `set harness.${h}.bin to ${whence(h) || `the output of: zsh -lc 'whence -p ${h}'`}`);
      const w = whence(h);
      const v = await checkVersion(h, config);
      if (!v.ok) return fail(v.detail, `upgrade ${h}`);
      return w && w !== bin ? fail(`${bin} is ${v.detail} but your shell resolves ${h} to ${w}`, `set harness.${h}.bin to ${w}`) : ok(v.detail);
    });
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
      const sb = s.sandbox || {};
      if (!sb.enabled || !sb.autoAllowBashIfSandboxed || !(sb.network?.allowedDomains?.length)) return fail("sandbox block missing", `merge this into ${contract(settingsPath)}:\n${JSON.stringify(SANDBOX_BLOCK, null, 2)}`);
      return ok(contract(settingsPath));
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
  for (const repo of config.repos || []) {
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
  name: "gallivant: protect default branch", target: "branch", enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false } }],
  bypass_actors: [],
});

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

