// The ruleset check, which is the only doctor check that speaks for a security control rather than for a config
// value. Section 6.11 of the spec credits "no push to the default branch, no force push" to a GitHub ruleset, so a
// check that passes on an unprotected default branch is worse than no check: it reports a control that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { protectsDefaultBranch, claudeSandboxCheck, hasRepositoryWriteScope } from "../lib/commands/doctor.mjs";

test("doctor accepts public-only repository scope without requiring private repository access", () => {
  for (const scopes of [null, "repo", "read:org, public_repo, user:email"]) assert.equal(hasRepositoryWriteScope(scopes), true);
  for (const scopes of ["", "read:user, user:email", "repo:status", "repo:invite", "not_repo"]) assert.equal(hasRepositoryWriteScope(scopes), false);
});

test("doctor reports macOS gh certificate failures without weakening Linux settings or modifying the input", () => {
  const settings = { sandbox: { enabled: true, autoAllowBashIfSandboxed: true, network: { allowedDomains: ["api.github.com"] } } };
  const before = structuredClone(settings);
  const path = "/operator/gallivant/claude/settings.json";
  const mac = claudeSandboxCheck(settings, path, "darwin");
  assert.equal(mac.ok, false);
  assert.match(mac.detail, /OSStatus -26276/);
  assert.match(mac.fix, /sandbox.enableWeakerNetworkIsolation/);
  assert.ok(mac.fix.includes(path));
  assert.match(mac.fix, /exfiltration/);
  assert.equal(claudeSandboxCheck(settings, path, "linux").ok, true);
  assert.deepEqual(settings, before);
  settings.sandbox.enableWeakerNetworkIsolation = true;
  assert.equal(claudeSandboxCheck(settings, path, "darwin").ok, true);
  settings.sandbox.enableWeakerNetworkIsolation = false;
  assert.equal(claudeSandboxCheck(settings, path, "darwin").ok, false);
});

test("allowing the macOS certificate service cannot hide a missing sandbox or domain allowlist", () => {
  for (const sandbox of [
    { enableWeakerNetworkIsolation: true },
    { enabled: false, autoAllowBashIfSandboxed: true, enableWeakerNetworkIsolation: true, network: { allowedDomains: ["api.github.com"] } },
    { enabled: true, autoAllowBashIfSandboxed: true, enableWeakerNetworkIsolation: true, network: { allowedDomains: [] } },
    { enabled: true, autoAllowBashIfSandboxed: true, enableWeakerNetworkIsolation: true, network: { allowedDomains: "api.github.com" } },
  ]) {
    const result = claudeSandboxCheck({ sandbox }, "/operator/settings.json", "darwin");
    assert.equal(result.ok, false);
    assert.match(result.detail, /sandbox block missing or invalid/);
  }
});

const gh = (branch = "main") => ({ repoDefaultBranch: async () => branch });

/** The shape `gh api repos/<r>/rulesets` returns, narrowed to the fields the check reads. */
const ruleset = (over = {}) => ({
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
  bypass_actors: [],
  ...over,
});

test("a ruleset protecting the default branch passes and names the branch it verified", async () => {
  const v = await protectsDefaultBranch(gh(), "acme/widget", [ruleset()]);
  assert.equal(v.ok, true);
  assert.match(v.detail, /default branch \(main\)/);
  assert.match(v.detail, /force pushes blocked/);
});

test("an active ruleset on some other branch does not count as protecting the default branch", async () => {
  // The bug this check exists for: `rs.some(r => r.enforcement === "active")` passed here while main sat open.
  const release = ruleset({ conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } } });
  const v = await protectsDefaultBranch(gh(), "acme/widget", [release]);
  assert.equal(v.ok, false);
  assert.match(v.detail, /none targeting the default branch \(main\)/);
});

test("the default branch named explicitly counts, and one excluded by name does not", async () => {
  const byName = ruleset({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } } });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [byName])).ok, true);
  const excluded = ruleset({ conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH"] } } });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [excluded])).ok, false);
});

test("a ruleset that does not block force pushes or require a pull request is reported as incomplete, not as passing", async () => {
  const noForce = ruleset({ rules: [{ type: "deletion" }, { type: "pull_request" }] });
  const v = await protectsDefaultBranch(gh(), "acme/widget", [noForce]);
  assert.deepEqual([v.ok, /non_fast_forward/.test(v.detail)], [false, true]);
  const noPr = ruleset({ rules: [{ type: "non_fast_forward" }] });
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [noPr])).detail, /pull_request/);
});

test("rules spread across two rulesets on the default branch count together, as GitHub applies them", async () => {
  const force = ruleset({ rules: [{ type: "non_fast_forward" }] });
  const pr = ruleset({ rules: [{ type: "pull_request" }] });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [force, pr])).ok, true);
});

test("a bypass actor fails the check, because a run using that identity is not held by the ruleset", async () => {
  const v = await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin" }] })]);
  assert.deepEqual([v.ok, /bypass actor/.test(v.detail)], [false, true]);
  assert.match(v.fix, /bypass_actors/);
});

test("an inactive or tag-targeted ruleset is not an active branch ruleset", async () => {
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ enforcement: "evaluate" })])).detail, /none is active/);
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ target: "tag" })])).detail, /none is active/);
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [])).detail, /no active ruleset/);
});

test("when the default branch cannot be read, a ~DEFAULT_BRANCH ruleset still counts and the wording does not invent a name", async () => {
  // `gh repo view` can fail on a token without the scope; the check must not claim a branch name it does not have.
  const blind = { repoDefaultBranch: async () => { throw new Error("HTTP 403"); } };
  const v = await protectsDefaultBranch(blind, "acme/widget", [ruleset()]);
  assert.equal(v.ok, true);
  assert.ok(!v.detail.includes("("), "no parenthesised branch name when the name is unknown");
  const byName = ruleset({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } } });
  assert.equal((await protectsDefaultBranch(blind, "acme/widget", [byName])).ok, false, "a name-matched ruleset cannot be confirmed without the name");
});

// The passport check. It is the only other doctor check that speaks for a security control, and until now it read
// only `data.file.write`, so a passport that let a run Read or Grep the settings file bounding it, the APort passport
// itself and the harness config directories passed clean while the docs promised those reads were blocked.
import { passportGaps, CONTROL_PLANE } from "../lib/commands/doctor.mjs";
import { expand } from "../lib/fs.mjs";
import { readFileSync } from "node:fs";

const WORKTREES = "/Users/x/.gallivant-worktrees";
const pathsFor = extra => [...CONTROL_PLANE.map(c => `${c}/**`), ...extra];
const passport = (over = {}) => ({
  limits: {
    "data.file.write": { allowed_paths: [`${WORKTREES}/**`], blocked_paths: pathsFor(["**/.env"]) },
    "data.file.read": { blocked_patterns: pathsFor(["**/.env", "**/auth.json"]) },
    ...over,
  },
});

test("a passport that blocks the control plane for writes and reads alike passes", () => {
  assert.deepEqual(passportGaps(passport(), WORKTREES), []);
});

test("a passport that blocks the control plane for writes only is reported, because reads of it are an injection's first move", () => {
  // The shipped template's old read list: `.env`, opencode, gallivant, ssh, aws, and one file inside ~/.codex.
  const readOnlyEnv = passport({ "data.file.read": { blocked_patterns: ["**/.env", "**/.env.*", expand("~/.codex/auth.json"), expand("~/.config/opencode") + "/**", expand("~/.gallivant") + "/**", expand("~/.ssh/**"), "**/auth.json"] } });
  const gaps = passportGaps(readOnlyEnv, WORKTREES);
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /^data\.file\.read blocked_patterns missing /);
  assert.match(gaps[0], /~\/\.claude/);
  assert.match(gaps[0], /~\/\.aport/);
  assert.match(gaps[0], /~\/\.codex/, "one file inside ~/.codex is not the directory");
});

test("a missing write block, a missing worktrees root and a missing read block are each named", () => {
  assert.deepEqual(passportGaps({ limits: {} }, WORKTREES), [
    "data.file.write allowed_paths does not contain the worktrees root",
    `data.file.write blocked_paths missing ${CONTROL_PLANE.join(", ")}`,
    `data.file.read blocked_patterns missing ${CONTROL_PLANE.join(", ")}`,
  ]);
  assert.deepEqual(passportGaps(null, WORKTREES).length, 3, "no passport at all is every gap, not a crash");
});

test("the shipped template passes its own check once its placeholders are filled", () => {
  const url = new URL("../templates/passport.gallivant.json", import.meta.url);
  const filled = readFileSync(url, "utf8").replaceAll("{{home}}", expand("~")).replaceAll("{{worktrees}}", WORKTREES);
  assert.deepEqual(passportGaps(JSON.parse(filled), WORKTREES), [], "doctor's fix instructions tell the operator to copy this file, so it has to pass");
});

test("legacy read blocked_paths cannot falsely pass a policy that evaluates blocked_patterns", () => {
  const old = passport({ "data.file.read": { blocked_paths: pathsFor([]) } });
  assert.deepEqual(passportGaps(old, WORKTREES), [`data.file.read blocked_patterns missing ${CONTROL_PLANE.join(", ")}`]);
});

// The credential checks. The old `github token` check asked the OPERATOR's `gh` whether it was authenticated and
// reported "system gh auth: ok" while every run was unable to push, because a run is sandboxed and cannot reach the
// keyring that `gh` was answering from. A check that passes while the thing it checks is broken is worse than no
// check, so these assert that doctor now reports on what a RUN can do.
import { doctor, gitPushProbe } from "../lib/commands/doctor.mjs";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { DEFAULTS } from "../lib/config.mjs";
import { resolveCredential } from "../lib/credential.mjs";

/** A Gallivant home complete enough for doctor to get past `config` and reach the credential checks. */
function doctorHome({ tokenFile = null, repos = [] } = {}) {
  const home = mkdtempSync(pjoin(tmpdir(), "gallivant-doctor-"));
  const worktrees = mkdtempSync(pjoin(tmpdir(), "gallivant-doctor-wt-"));
  const bin = pjoin(home, "codex-stub");
  writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const cfg = {
    ...DEFAULTS, trusted_authors: ["me"], worktrees, notify: null,
    harness: { codex: { bin } }, repos, github_token_file: tokenFile,
  };
  writeFileSync(pjoin(home, "config.json"), JSON.stringify(cfg), { mode: 0o600 });
  return home;
}

/** A `probePush` that reports what git said, so the failure path is exercised without a network or a real remote. */
const probeSaying = said => async () => ({ ok: false, detail: `a run could not reach acme/widget over git. git said:\n       ${said}`, fix: "x" });
const probeOk = async () => ({ ok: true, detail: "acme/widget reachable with the run's own environment and no readable HOME" });

const named = (results, name) => results.find(r => r.name === name);
/** A resolver that cannot reach `gh`, so only the config file and the injected environment can answer. */
const noGh = (cfg, opts) => resolveCredential(cfg, { ...opts, exec: async () => "" });

test("doctor fails, with the fix, when a run could not push: the case the old check reported as ok", async () => {
  // No token file, nothing in the environment, and a `gh` that answers nothing. Before this change doctor printed
  // "ok github token  system gh auth" for exactly this machine state.
  const home = doctorHome();
  // `resolve` is injected rather than the machine's own `gh` being relied on. The state being asserted is "nothing
  // anywhere can answer", and on a developer machine `gh` is logged in, so the failure path would otherwise never run.
  const results = await doctor({ home, env: {}, resolve: noGh });
  const c = named(results, "run credential");
  assert.equal(c.ok, false, "a run that could not push must not be reported as ok");
  assert.match(c.detail, /no credential/);
  // Every one of the three ways out is named, in the order Gallivant tries them.
  assert.match(c.fix, /gh auth login/);
  assert.match(c.fix, /GH_TOKEN/);
  assert.match(c.fix, /github_token_file/);
});

// What `doctor` says when a run could not push. This replaced three tests that read `~/.gallivant/gitconfig` and
// asserted on its helper lines. That check could not see the defect it was written for: the file's CONTENT was
// correct and the process could not READ it, so the check passed while every git command in a run failed. These
// assert instead that doctor runs git and reports git's own words.
test("doctor prints the real git error when a run could not push, rather than a paraphrase of it", async () => {
  // The exact message from the live run. Two sessions in a row read git's fallback message, which names
  // ~/.git-credentials, and went after the wrong file; the path git actually failed on was the gitconfig. So the
  // requirement is that doctor prints what git said, verbatim, with nothing summarised away.
  const said = "fatal: unable to access '/Users/you/.gallivant/gitconfig': Operation not permitted";
  const home = doctorHome();
  const results = await doctor({ home, env: { GH_TOKEN: "t-for-test" }, resolve: noGh, probePush: probeSaying(said) });
  const g = named(results, "run git push");
  assert.equal(g.ok, false, "a run that could not reach the remote must not be reported as ok");
  assert.match(g.detail, /unable to access/);
  assert.match(g.detail, /\.gallivant\/gitconfig/);
  assert.match(g.detail, /Operation not permitted/);
});

test("doctor's git check runs git with the run's own environment and no readable HOME, and names an outside path as the cause", async () => {
  // The real probe, not an injected one, driven at a remote that cannot resolve so it fails locally without a
  // network. What is asserted is the shape of the environment it builds: the run's own, plus a HOME that does not
  // exist, which is what reproduces a sandboxed run rather than the operator's shell.
  const seen = [];
  const fakeExec = (cmd, args, opts) => {
    seen.push({ cmd, args, env: opts.env });
    if (args[0] === "init") return "";
    throw Object.assign(new Error("boom"), { stderr: "fatal: unable to access '/Users/you/.gallivant/gitconfig': Operation not permitted\n" });
  };
  const r = await gitPushProbe({ config: { home: "/Users/you/.gallivant" }, credential: { token: "t-for-test" }, repoEntries: [{ repo: "acme/widget" }], exec: fakeExec });
  assert.equal(r.ok, false);
  // git's words, kept whole.
  assert.match(r.detail, /Operation not permitted/);
  // And the fix names the path git failed on, which is the thing two sessions could not find.
  assert.match(r.fix, /\/Users\/you\/\.gallivant\/gitconfig/);
  assert.match(r.fix, /outside the worktree/);
  assert.match(r.fix, /runEnv in lib\/git\.mjs/);
  // The environment it ran git in: the run's, an unreadable HOME, and nothing else inherited but PATH.
  const { env } = seen.at(-1);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1", "the system file's osxkeychain helper must not be reachable");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0", "a missing credential must be an error, not a hang");
  assert.ok(!existsSync(env.HOME), `HOME must not be readable, so a run's condition is reproduced: ${env.HOME}`);
  assert.ok(env.GH_TOKEN, "the run's credential has to be in the environment or the check answers a different question");
  assert.ok(!("GIT_CONFIG_GLOBAL" in env) || env.GIT_CONFIG_GLOBAL === "/dev/null");
});

test("doctor's git check never prints the credential, even inside git's own error text", async () => {
  // git puts the URL in its errors and a helper can echo, so the scrub is not theoretical.
  const fakeExec = (cmd, args) => {
    if (args[0] === "init") return "";
    throw Object.assign(new Error("boom"), { stderr: "fatal: could not read Username for 'https://x:t-secret-marker@github.com'\n" });
  };
  const r = await gitPushProbe({ config: {}, credential: { token: "t-secret-marker" }, repoEntries: [{ repo: "acme/widget" }], exec: fakeExec });
  assert.equal(r.ok, false);
  assert.ok(!`${r.detail} ${r.fix}`.includes("t-secret-marker"), "the credential must never be printed, whoever put it in the text");
  assert.match(r.detail, /<token>/);
});

test("doctor's git check says so rather than failing when no repository is configured", async () => {
  const r = await gitPushProbe({ config: {}, credential: { token: "t-for-test" }, repoEntries: [] });
  assert.equal(r.ok, true);
  assert.match(r.detail, /no repos configured/);
});

test("doctor names the repository in the ruleset check, even when repos entries are objects", async () => {
  // `repos` entries may be `{ repo, base }` rather than a bare string. This loop read the raw list, so the check was
  // named "ruleset [object Object]" and `gh.rulesets` was handed that object: it answered for no repository at all and
  // the result was reported as "no active ruleset" for a repo whose rulesets were never asked about. A false failure
  // that names nothing recognisable is the kind an operator cannot act on.
  const home = doctorHome({ repos: [{ repo: "acme/widget", base: "staging" }] });
  const results = await doctor({ home, env: { GH_TOKEN: "t-for-test" }, resolve: noGh, probePush: probeOk });
  assert.ok(results.some(r => r.name === "ruleset acme/widget"), `no check named the repository: ${results.map(r => r.name).join(", ")}`);
  assert.ok(!results.some(r => /\[object Object\]/.test(r.name)), "a check name must never render an object");
});

test("doctor does not run the git check when no credential resolved, because the credential line already said so", async () => {
  // Otherwise one broken credential prints two failures that name the same cause, and the second is noise.
  let called = false;
  const home = doctorHome();
  const results = await doctor({ home, env: {}, resolve: noGh, probePush: async () => { called = true; return probeOk(); } });
  assert.equal(called, false);
  assert.equal(named(results, "run git push"), undefined);
  assert.equal(named(results, "run credential").ok, false);
});

test("doctor reports which source a run's credential would come from, and never the credential", async () => {
  const home = doctorHome();
  const results = await doctor({ home, env: { GH_TOKEN: "t-secret-marker" }, resolve: noGh });
  const c = named(results, "run credential");
  const printed = `${c.detail} ${c.fix ?? ""}`;
  assert.ok(!printed.includes("t-secret-marker"), "doctor must never print the credential it resolved");
});


test("doctor preserves an explicit token-file refusal without falling back for repository diagnostics", async t => {
  const home = doctorHome({ repos: ["acme/widget"] });
  const file = pjoin(home, "token"), configFile = pjoin(home, "config.json"), calls = pjoin(home, "gh-calls");
  writeFileSync(file, "  ", { mode: 0o600 });
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  writeFileSync(configFile, JSON.stringify({ ...config, github_token_file: file }));
  // Only the separate operator-login check may execute gh. All repository
  // checks must retain the failed selected credential, even with ambient access.
  writeFileSync(pjoin(home, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nprintf '{"login":"fixture-user"}\\n'\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${home}:${before}`;
  t.after(() => { process.env.PATH = before; });
  let pushProbe = false;
  const results = await doctor({ home, env: { GH_TOKEN: "t-broader-env" }, resolve: noGh,
    probePush: async () => { pushProbe = true; return probeOk(); } });
  const credential = named(results, "run credential");
  assert.equal(credential.ok, false);
  assert.match(credential.fix, /No fallback credential was used/);
  assert.equal(pushProbe, false);
  for (const check of [named(results, "base branch acme/widget"), named(results, "ruleset acme/widget")]) {
    assert.equal(check.ok, false);
    assert.match(check.detail, /unavailable: selected GitHub credential could not be resolved/);
    assert.equal(check.fix, credential.fix, "repair the selected credential before diagnosing repository settings");
    assert.doesNotMatch(`${check.detail} ${check.fix}`, /no base branch|no active ruleset|gh api -X POST|Add \{ "repo"/);
    assert.doesNotMatch(`${check.detail} ${check.fix}`, /t-broader-env/);
  }
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["api user --jq {login: .login}"]);
});
