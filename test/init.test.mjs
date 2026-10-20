// `gallivant init`: one command from a target checkout to a recorded repository and doctor's report. Every
// prerequisite is refused before anything is written, and an existing config is never rewritten except for the one
// `repos` entry this run owns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync, readFileSync, statSync, symlinkSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { init, targetRepository, renderInit, viaNpx, commandPrefix, safeOrigin } from "../lib/commands/init.mjs";
import { renderDoctor } from "../lib/commands/doctor.mjs";
import { writeJsonAtomic, PACKAGE_NAME, VERSION } from "../lib/fs.mjs";
import { resolveCredential, SOURCES } from "../lib/credential.mjs";
import { tempHome } from "./helpers.mjs";

const CRED = { token: "fixture-token", source: SOURCES.gh, host: "github.com" };

const repository = (repo = "acme/widget") => () => ({ checkout: "/work/widget", origin: `https://github.com/${repo}.git`, repo: repo.toLowerCase() });
const gh = ({ login = "fixture", permissions = { push: true, admin: true, archived: false }, userError = null, permissionsError = null } = {}) => {
  const calls = [];
  return {
    calls,
    user: async () => { calls.push("user"); if (userError) throw new Error(userError); return login; },
    repoPermissions: async repo => { calls.push(`permissions ${repo}`); if (permissionsError) throw new Error(permissionsError); return permissions; },
  };
};
const discover = () => ({ codex: { bin: process.execPath }, claude: { bin: process.execPath, settings: "/tmp/claude/settings.json" } });
const ready = async () => ({ ok: true, detail: "0.160.0, signed-in (API unchecked)" });
const DOCTOR = [{ name: "config", ok: true, detail: "~/.gallivant/config.json" }, { name: "codex hook", ok: false, detail: "~/.codex/hooks.json missing", fix: "npx @aporthq/aport-agent-guardrails codex --global --enforcement=warn" }];
const fresh = () => {
  const root = realpathSync(tempHome());
  return { root, home: join(root, "home"), worktrees: join(root, "worktrees") };
};
// One fake `gh` answers both as the operator's login and as the run credential unless a test separates them.
const base = over => { const g = over.gh ?? gh(); return { discover, gh: g, ghFor: () => g, resolve: async () => CRED, repository: repository(), harnessCheck: ready, doctor: async () => DOCTOR, ...over }; };

test("init records the target repository once, writes a private config and ends with doctor's report", async () => {
  const { home, worktrees } = fresh();
  const seen = [];
  const r = await init(base({ home, worktrees, harness: "codex", doctor: async opts => { seen.push(opts.home); return DOCTOR; } }));
  assert.equal(r.created, true);
  assert.equal(r.repo, "acme/widget");
  assert.equal(r.recorded, true);
  assert.deepEqual(r.doctor, DOCTOR);
  assert.deepEqual(seen, [home]);
  const written = JSON.parse(readFileSync(r.file, "utf8"));
  assert.deepEqual(written.repos, ["acme/widget"]);
  assert.deepEqual(written.trusted_authors, ["fixture"]);
  assert.deepEqual(Object.keys(written.harness), ["codex"]);
  assert.equal(written.notify, null);
  assert.equal(written.github_token_file, null);
  assert.equal(statSync(r.file).mode & 0o777, 0o600);
  assert.equal(statSync(home).mode & 0o777, 0o700);
  assert.equal(statSync(worktrees).mode & 0o777, 0o700);
  // Repeating it in the same checkout changes nothing: same bytes, one repos entry, the report runs again.
  const before = readFileSync(r.file, "utf8");
  const again = await init(base({ home, harness: "codex" }));
  assert.equal(again.created, false);
  assert.equal(again.changed, false);
  assert.equal(again.recorded, false);
  assert.equal(readFileSync(r.file, "utf8"), before);
});

test("init preserves every key of an existing config and deduplicates only its own repository entry", async () => {
  const { home, root } = fresh();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const custom = {
    trusted_authors: ["me", "colleague"],
    worktrees: join(root, "custom-worktrees"),
    harness: { claude: { bin: "/opt/claude/bin/claude", settings: join(home, "claude", "settings.json") } },
    notify: { ntfy: "https://ntfy.sh/abcdefabcdefabcdefabcdefabcdefab", email: "me@example.com" },
    github_token_file: join(home, "gh-token"),
    repos: [{ repo: "acme/widget", base: "staging", run_timeout_minutes: 45 }, "acme/other"],
    max_iterations: 7,
    reviewer: null,
  };
  writeJsonAtomic(join(home, "config.json"), custom, 0o600);
  // A second repository from another checkout: appended as the bare string, everything else byte-for-byte as written.
  const second = await init(base({ home, repository: repository("Acme/Api"), harnessCheck: async name => { assert.equal(name, "claude"); return ready(); } }));
  assert.equal(second.created, false);
  assert.equal(second.changed, true);
  assert.equal(second.recorded, true);
  assert.equal(second.harness, "claude");
  const after = JSON.parse(readFileSync(second.file, "utf8"));
  assert.deepEqual(after, { ...custom, repos: [...custom.repos, "acme/api"] });
  assert.equal(statSync(second.file).mode & 0o777, 0o600);
  assert.ok(existsSync(custom.worktrees));
  // Back in the first repository, whose entry carries a base: not duplicated, not rewritten, file untouched.
  const bytes = readFileSync(second.file, "utf8");
  const first = await init(base({ home, repository: repository("ACME/WIDGET") }));
  assert.equal(first.recorded, false);
  assert.equal(first.changed, false);
  assert.equal(readFileSync(second.file, "utf8"), bytes);
  // Adding the other supported harness keeps the custom one and its binary.
  const added = await init(base({ home, harness: "codex", repository: repository("acme/api") }));
  assert.deepEqual(JSON.parse(readFileSync(added.file, "utf8")).harness, { ...custom.harness, codex: { bin: process.execPath } });
  // The worktrees root is a setting, not something a later run may move.
  await assert.rejects(init(base({ home, worktrees: join(root, "elsewhere") })), /already sets worktrees.*nothing was written/s);
  assert.equal(JSON.parse(readFileSync(added.file, "utf8")).worktrees, custom.worktrees);
  assert.equal(existsSync(join(root, "elsewhere")), false);
});

test("init stops with the exact login action when gh or the harness is signed out, and writes nothing", async () => {
  const { home, worktrees } = fresh();
  const notSignedIn = gh({ userError: "gh: To get started with GitHub CLI, please run: gh auth login" });
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: notSignedIn })), /Run: gh auth login[\s\S]*nothing was written/);
  assert.deepEqual(notSignedIn.calls, ["user"]);
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: gh({ login: "" }) })), /gh auth login/);
  const codexOut = async () => ({ ok: false, detail: "exit 1", fix: "codex login" });
  await assert.rejects(init(base({ home, worktrees, harness: "codex", harnessCheck: codexOut })), /codex is not ready \(exit 1\)\.\nRun: codex login\n.*nothing was written/);
  const claudeOut = async () => ({ ok: false, detail: '{"loggedIn":false}', fix: "claude auth login" });
  await assert.rejects(init(base({ home, worktrees, harness: "claude", harnessCheck: claudeOut })), /Run: claude auth login/);
  const old = async () => ({ ok: false, detail: "0.150.0 is older than 0.158.0", fix: "install codex 0.158.0 or newer at the configured bin path; run gallivant doctor" });
  await assert.rejects(init(base({ home, worktrees, harness: "codex", harnessCheck: old })), /older than 0.158.0[\s\S]*install codex/);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(worktrees), false);
});

test("init names an unmet repository prerequisite before changing any repo-specific state", async () => {
  const { home, worktrees, root } = fresh();
  // Not a checkout, no origin, a non-GitHub origin: resolved locally, so `gh` is never asked and nothing is written.
  const plain = join(root, "plain");
  mkdirSync(plain);
  assert.throws(() => targetRepository(plain), /not inside a Git checkout[\s\S]*nothing was written/);
  const noRemote = join(root, "no-remote");
  mkdirSync(noRemote);
  execFileSync("git", ["init", "-q", noRemote]);
  assert.throws(() => targetRepository(noRemote), /has no origin remote[\s\S]*git remote add origin/);
  const gitlab = join(root, "gitlab");
  mkdirSync(gitlab);
  execFileSync("git", ["init", "-q", gitlab]);
  execFileSync("git", ["-C", gitlab, "remote", "add", "origin", "https://gitlab.com/acme/widget.git"]);
  assert.throws(() => targetRepository(gitlab), /not a github\.com repository URL/);
  const ok = join(root, "ok");
  mkdirSync(ok);
  execFileSync("git", ["init", "-q", ok]);
  execFileSync("git", ["-C", ok, "remote", "add", "origin", "git@github.com:Acme/Widget.git"]);
  assert.deepEqual(targetRepository(ok), { checkout: realpathSync(ok), origin: "git@github.com:Acme/Widget.git", repo: "acme/widget" });
  assert.throws(() => targetRepository(ok, () => { const e = new Error("spawn git ENOENT"); e.code = "ENOENT"; throw e; }), /git is not on PATH/);
  const untouched = gh();
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: untouched, repository: () => targetRepository(plain) })), /not inside a Git checkout/);
  assert.deepEqual(untouched.calls, []);
  // A GitHub URL whose repository this login cannot see, cannot push to, or that is archived: refused after asking GitHub.
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: gh({ permissionsError: "HTTP 404: Not Found" }) })), /cannot resolve acme\/widget with the run credential \(gh auth token \(13 characters\)\): HTTP 404[\s\S]*nothing was written/);
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: gh({ permissions: { push: false, admin: false, archived: false } }) })), /run credential \(gh auth token \(13 characters\)\) has no push permission on acme\/widget\. Ask for write access/);
  await assert.rejects(init(base({ home, worktrees, harness: "codex", gh: gh({ permissions: { push: true, admin: true, archived: true } }) })), /archived/);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(worktrees), false);
  // With an existing config, the refusal leaves the file byte-for-byte alone.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const existing = { trusted_authors: ["me"], worktrees, harness: { codex: { bin: process.execPath } }, repos: ["acme/other"] };
  writeJsonAtomic(join(home, "config.json"), existing, 0o600);
  const before = readFileSync(join(home, "config.json"), "utf8");
  await assert.rejects(init(base({ home, gh: gh({ permissions: { push: false } }) })), /no push permission/);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  assert.deepEqual(readdirSync(home), ["config.json"]);
});

test("origin URLs are printed without their userinfo, so a token embedded in a remote never reaches a terminal", async () => {
  assert.equal(safeOrigin("https://x-access-token:SECRET@github.com/acme/widget.git"), "https://github.com/acme/widget.git");
  assert.equal(safeOrigin("ssh://git@github.com/acme/widget.git"), "ssh://github.com/acme/widget.git");
  assert.equal(safeOrigin("git@github.com:acme/widget.git"), "git@github.com:acme/widget.git");
  const { home, worktrees, root } = fresh();
  const withToken = join(root, "with-token");
  mkdirSync(withToken);
  execFileSync("git", ["init", "-q", withToken]);
  execFileSync("git", ["-C", withToken, "remote", "add", "origin", "https://x-access-token:SECRET@github.com/Acme/Widget.git"]);
  assert.deepEqual(targetRepository(withToken), { checkout: realpathSync(withToken), origin: "https://github.com/Acme/Widget.git", repo: "acme/widget" });
  const foreign = join(root, "foreign");
  mkdirSync(foreign);
  execFileSync("git", ["init", "-q", foreign]);
  execFileSync("git", ["-C", foreign, "remote", "add", "origin", "https://user:SECRET@gitlab.com/acme/widget.git"]);
  assert.throws(() => targetRepository(foreign), e => /not a github\.com repository URL/.test(e.message) && !e.message.includes("SECRET"));
  // The permission refusal names the origin too, and must not leak even when handed an unredacted one.
  const leaky = () => ({ checkout: "/work/widget", origin: "https://x-access-token:SECRET@github.com/acme/widget.git", repo: "acme/widget" });
  await assert.rejects(init(base({ home, worktrees, harness: "codex", repository: leaky, gh: gh({ permissionsError: "HTTP 404: Not Found" }) })),
    e => /origin \(https:\/\/github\.com\/acme\/widget\.git\)/.test(e.message) && !e.message.includes("SECRET"));
});

test("init checks push access with the credential a run would resolve, not the operator's ambient login", async () => {
  const { home, root } = fresh();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tokenFile = join(home, "gh-token");
  const existing = { trusted_authors: ["me"], worktrees: join(root, "worktrees"), harness: { codex: { bin: process.execPath } }, github_token_file: tokenFile, repos: [] };
  writeJsonAtomic(join(home, "config.json"), existing, 0o600);
  const before = readFileSync(join(home, "config.json"), "utf8");
  const ambient = gh();          // can push, as the operator's own login often can
  const run = gh({ permissions: { push: false, admin: false, archived: false } });
  const seen = [];
  const ghFor = credential => { seen.push(credential); return run; };
  // The configured token file is missing: the real resolver refuses rather than widening to the ambient login.
  await assert.rejects(init(base({ home, gh: ambient, ghFor, resolve: resolveCredential })), /github_token_file is missing, unreadable or empty[\s\S]*nothing was written/);
  assert.deepEqual(seen, []);
  assert.deepEqual(run.calls, []);
  // With the file in place, the run credential is the one asked, and its answer is the one that counts.
  writeFileSync(tokenFile, "ghp_fixturetoken\n", { mode: 0o600 });
  await assert.rejects(init(base({ home, gh: ambient, ghFor, resolve: resolveCredential })), /run credential \(github_token_file \(16 characters\)\) has no push permission on acme\/widget\. Give the token in .*gh-token Contents: write on acme\/widget/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, "ghp_fixturetoken");
  assert.equal(seen[0].source, SOURCES.file);
  assert.deepEqual(run.calls, ["permissions acme/widget"]);
  assert.deepEqual(ambient.calls, ["user", "user"]);
  assert.equal(readFileSync(join(home, "config.json"), "utf8"), before);
  // A run credential that can push records the repository even though the ambient login was never asked.
  const pushable = gh();
  const r = await init(base({ home, gh: gh({ permissions: { push: false } }), ghFor: () => pushable, resolve: resolveCredential }));
  assert.equal(r.recorded, true);
  assert.deepEqual(JSON.parse(readFileSync(r.file, "utf8")).repos, ["acme/widget"]);
  assert.deepEqual(pushable.calls, ["permissions acme/widget"]);
});

test("init refuses unsupported, missing and unsafe setup, and an invalid existing config, before writing", async () => {
  const { home, worktrees, root } = fresh();
  await assert.rejects(init(base({ home, worktrees, harness: "goose" })), /codex or claude/);
  await assert.rejects(init(base({ home, worktrees, harness: "codex", discover: () => ({}) })), /codex is not on PATH[\s\S]*nothing was written/);
  assert.equal(existsSync(home), false);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "config.json"), JSON.stringify({ trusted_authors: [], worktrees, harness: { codex: { bin: process.execPath } } }), { mode: 0o600 });
  await assert.rejects(init(base({ home })), /Config problems in .*trusted_authors[\s\S]*nothing was written/);
  writeFileSync(join(home, "config.json"), "[]", { mode: 0o600 });
  await assert.rejects(init(base({ home })), /not a JSON object/);
  const linked = join(root, "linked-home");
  symlinkSync(join(root, "missing"), linked);
  await assert.rejects(init(base({ home: linked, worktrees, harness: "codex" })), /symlink/);
  assert.equal(existsSync(join(root, "missing")), false);
});

test("init output explains what npx did, gives both next commands and never claims a global installation", async () => {
  const { home, worktrees } = fresh();
  const r = await init(base({ home, worktrees, harness: "codex" }));
  const report = renderDoctor(r.doctor);
  const npx = renderInit(r, report, { npx: true, script: "/Users/me/.npm/_npx/abc123/node_modules/@uchibeke/gallivant/bin/gallivant.mjs" });
  assert.match(npx, new RegExp(`Package:\\s+${PACKAGE_NAME.replace("/", "\\/")} ${VERSION.replace(/\./g, "\\.")} \\(run by npx\\)`));
  assert.match(npx, /Running:\s+\/Users\/me\/\.npm\/_npx\/abc123/);
  assert.match(npx, /Repository: acme\/widget \(recorded in repos\)/);
  assert.match(npx, /FAIL codex hook/);
  assert.match(npx, /fix: npx @aporthq\/aport-agent-guardrails codex/);
  assert.match(npx, /Fix the 1 failing check\(s\) above, then run:\s+npx --yes @uchibeke\/gallivant doctor/);
  assert.match(npx, /npx ran @uchibeke\/gallivant on demand from npm's cache\. Nothing was installed globally/);
  assert.match(npx, /Run it again any time:\s+npx --yes @uchibeke\/gallivant doctor/);
  assert.match(npx, /Optional persistent install:\s+npm install -g @uchibeke\/gallivant/);
  assert.match(npx, /npx --yes @uchibeke\/gallivant task "Document how to run the existing tests[^\n]*--harness codex --verify 'git diff --check' --run/);
  assert.match(npx, /did not create a GitHub ruleset, install harness hooks, start a task or merge anything/);
  assert.doesNotMatch(npx, /installed globally\./i);
  assert.doesNotMatch(npx, /\binstalled gallivant\b/i);
  const plain = renderInit(r, report, { npx: false, script: "/usr/local/bin/gallivant" });
  assert.match(plain, /then run:\s+gallivant doctor/);
  assert.match(plain, /^\s+gallivant task "Document/m);
  assert.doesNotMatch(plain, /npx --yes|npx ran|installed globally/);
  // Repeat run, all checks passing: says so and does not claim a task started or anything merged.
  const again = await init(base({ home, harness: "codex", doctor: async () => [{ name: "config", ok: true, detail: "ok" }] }));
  const passed = renderInit(again, renderDoctor(again.doctor), { npx: false, script: "/usr/local/bin/gallivant" });
  assert.match(passed, /Config:\s+.*\(unchanged\)/);
  assert.match(passed, /Repository: acme\/widget \(already in repos; not duplicated\)/);
  assert.match(passed, /All checks passed\. Confirm the reviewer setting/);
});

test("npx detection reads npm's exec markers or the _npx cache path, and the command prefix follows it", () => {
  assert.equal(viaNpx({ npm_command: "exec" }, "/x/bin/gallivant.mjs"), true);
  assert.equal(viaNpx({ npm_lifecycle_event: "npx" }, "/x/bin/gallivant.mjs"), true);
  assert.equal(viaNpx({}, "/home/me/.npm/_npx/1234/node_modules/@uchibeke/gallivant/bin/gallivant.mjs"), true);
  assert.equal(viaNpx({ npm_command: "run-script" }, "/usr/local/lib/node_modules/@uchibeke/gallivant/bin/gallivant.mjs"), false);
  assert.equal(viaNpx({}, "/usr/local/bin/gallivant"), false);
  assert.equal(commandPrefix(true), `npx --yes ${PACKAGE_NAME}`);
  assert.equal(commandPrefix(false), "gallivant");
});
