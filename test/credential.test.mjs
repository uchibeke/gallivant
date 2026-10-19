// The credential a run gets, which is the difference between a session that can push and one that spends money and
// then cannot. Diagnosed from a real run: a session implemented nine acceptance criteria, made four commits, and
// stopped because `~/.gallivant/gitconfig` used `!gh auth git-credential`, which reads the operator's macOS keyring,
// and a sandboxed run cannot reach a keyring. `runEnv` set GH_TOKEN only when `github_token_file` was configured, and
// the default is null, so the common install handed a run no credential at all.
//
// No test here contains a token. Every fake token is a literal that is obviously not one ("t-from-file"), and the
// assertions are about which source won and where the value landed, never about a value that could be real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveCredential, resolveCredentialFor, SOURCES, describe as describeCredential,
  hostFromRemote, isDotCom, tokenFromEnv, tokenFromGh, noCredentialMessage,
} from "../lib/credential.mjs";
import { makeGh } from "../lib/gh.mjs";
import { makeGit, runEnv, RUN_GIT_CONFIG } from "../lib/git.mjs";
import { resumePrompt } from "../lib/prompt.mjs";
import { CONFIG, tempHome } from "./helpers.mjs";

/** A config with a token file written for it. The value is a marker, never anything token-shaped. */
function withTokenFile(value = "t-from-file") {
  const home = tempHome();
  const p = join(home, "gh-token");
  writeFileSync(p, `${value}\n`, { mode: 0o600 });
  return { ...CONFIG, home, github_token_file: p };
}

/** A `gh auth token` that answers, recording the argv it was called with so the host can be asserted on. */
const ghExec = (answer = "t-from-gh") => {
  const calls = [];
  return { calls, exec: async (cmd, args) => { calls.push([cmd, ...args]); return `${answer}\n`; } };
};
const ghSilent = () => ({ exec: async () => "" });

test("a run's environment carries a credential when one can be resolved, and it is never in argv", async () => {
  // The whole defect in one assertion: before this change a config with github_token_file null produced an
  // environment with no GH_TOKEN, and the run's `git push` had nothing to authenticate with.
  const { exec } = ghExec();
  const c = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: {}, exec });
  assert.equal(c.token, "t-from-gh");
  const env = runEnv({ ...CONFIG, home: "/h" }, c);
  assert.equal(env.GH_TOKEN, "t-from-gh");
  // GIT_CONFIG_GLOBAL replaces only git's GLOBAL file. On a Mac with the Xcode command line tools the SYSTEM file
  // sets credential.helper = osxkeychain, so without this a run still reached the operator's keychain, which is the
  // opposite of what the guardrail page promises.
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  // Nothing in the environment is an argument, and nothing here builds one. `ps` shows argv to every process on the
  // machine, so a token in argv is readable by anything running as any user.
  assert.ok(!Object.keys(env).some(k => /^--/.test(k)));
});

test("runEnv with no credential sets git's config and no token, so a read-only git call carries nothing", () => {
  const env = runEnv({ ...CONFIG, home: "/h" });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_CONFIG_COUNT, String(RUN_GIT_CONFIG.length));
});

test("gh in a run ignores inaccessible or invalid personal config, including after changing directory", t => {
  try { execFileSync("gh", ["--version"], { stdio: "ignore" }); }
  catch { t.skip("GitHub CLI is not installed"); return; }
  const home = tempHome(), worktree = join(home, "clone"), personal = join(home, "personal-gh");
  mkdirSync(worktree);
  mkdirSync(personal);
  writeFileSync(join(personal, "config.yml"), "invalid: [unterminated YAML\n");
  const env = { ...process.env, GH_CONFIG_DIR: personal };
  assert.throws(() => execFileSync("gh", ["config", "get", "git_protocol"], { env, stdio: "pipe" }));
  const run = { ...env, ...runEnv(CONFIG, { token: "t-marker" }, null, worktree) };
  for (const cwd of [worktree, home]) {
    assert.equal(execFileSync("gh", ["config", "get", "git_protocol"], { cwd, env: run, encoding: "utf8" }).trim(), "https");
  }
  assert.equal(run.GH_TOKEN, "t-marker");
  assert.ok(!existsSync(run.GH_CONFIG_DIR), "read-only gh commands need no personal config or generated files");
});

// The regression guard, and the one that matters more than the fix. The defect was not a wrong VALUE in the run
// environment; it was a run naming a FILE it could not read. `GIT_CONFIG_GLOBAL` pointed at ~/.gallivant/gitconfig,
// a sandboxed session cannot read outside its worktree, and every git command failed with "unable to access
// '/Users/<you>/.gallivant/gitconfig': Operation not permitted", `git status` included. So the assertion is about
// the SHAPE of the environment rather than about any particular key: nothing in it may be a path outside the
// worktree. Adding a config file back fails here before it can fail a live run.
test("runEnv names no path outside the worktree, so a sandboxed run has no file it needs permission to read", () => {
  const env = runEnv({ ...CONFIG, home: "/operator/home/.gallivant" }, { token: "t-in-env" });
  for (const [key, value] of Object.entries(env)) {
    if (key === "GH_TOKEN") continue;
    // /dev/null is the one path allowed, and it is deliberate: it is how GIT_CONFIG_GLOBAL is neutralised, and it is
    // a device every sandbox permits. Leaving GIT_CONFIG_GLOBAL unset instead makes git read $HOME/.gitconfig, which
    // is outside the worktree and is the very class of failure this asserts against.
    if (value === "/dev/null") continue;
    assert.ok(!/(^|[\s'"=:])[~/]/.test(value), `${key}=${value} names a path; a run cannot be given a file outside its worktree to read`);
  }
  // And specifically: the home it was handed is nowhere in the result. The old shape derived a path from it.
  assert.ok(!JSON.stringify(env).includes("/operator/home"), "the operator's home must not appear anywhere in a run's environment");
  assert.ok(!JSON.stringify(env).includes(".gallivant"), "no Gallivant directory may be named in a run's environment");
});

test("the token is only ever in GH_TOKEN, never in a git config value and never in a key", () => {
  // A credential in GIT_CONFIG_VALUE_n would be a second copy, and one that `git config --list` prints. The helper
  // references $GH_TOKEN by name and is expanded by the shell git runs it in, so the value never holds the secret.
  const env = runEnv(CONFIG, { token: "t-secret-marker" });
  const holders = Object.entries(env).filter(([, v]) => String(v).includes("t-secret-marker")).map(([k]) => k);
  assert.deepEqual(holders, ["GH_TOKEN"], "exactly one variable may carry the credential");
  // The helper names the variable rather than embedding a value, which is what makes the line above true. Found by KEY
  // and not by index: the identity pairs are appended per run now (a run commits as the operator, not as a bot), so the
  // helper's position in the numbering moves with them and an index here would pin an implementation detail.
  const at = Object.keys(env).filter(k => k.startsWith("GIT_CONFIG_KEY_")).find(k => env[k] === "credential.helper");
  assert.ok(at, "the credential helper is somewhere in the numbered pairs");
  assert.match(env[at.replace("KEY", "VALUE")], /\$GH_TOKEN/);
});

test("nothing operator-supplied is interpolated into the credential helper, so a config value cannot become a shell", () => {
  // The helper is a shell snippet that git runs with `sh -c`, so anything interpolated into it would be an injection
  // with a config file as its input. It is a literal, and `runEnv` reads nothing off `config` at all: the same
  // environment comes back for a config built entirely out of shell metacharacters.
  const hostile = { home: "/x; touch /tmp/pwned", worktrees: "$(id)", github_token_file: "`whoami`" };
  const a = runEnv(hostile, { token: "t-x" });
  const b = runEnv({ ...CONFIG, home: "/h" }, { token: "t-x" });
  assert.deepEqual(a, b, "runEnv must not derive anything from the config, so nothing operator-supplied can reach a shell");
  for (const s of Object.values(a)) {
    assert.ok(!/pwned|\$\(id\)|`whoami`/.test(s), `a config value reached the environment: ${s}`);
  }
});

// Driven through real git, because the claim is about git's behaviour and not about a string. The pair below is what
// isolates a run, and a previous round found GIT_CONFIG_GLOBAL alone did NOT: the SYSTEM file still applies, and on a
// Mac with the Xcode command line tools it sets credential.helper = osxkeychain, so a run had a path to the
// operator's keychain whatever else was set.
test("a run's git environment sees no credential helper but its own, so the operator's keychain is unreachable", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallivant-isolate-"));
  const base = { PATH: process.env.PATH, HOME: join(dir, "no-such-home"), GIT_TERMINAL_PROMPT: "0" };
  const env = { ...base, ...runEnv(CONFIG) };
  // Exactly one helper, and it is ours. Not "no keychain helper by inspection": git is asked what it resolved.
  const helpers = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: dir, env, encoding: "utf8" }).trim().split("\n");
  assert.equal(helpers.length, 1, `git resolved ${helpers.length} credential helpers: ${helpers.join(" | ")}`);
  assert.match(helpers[0], /GH_TOKEN/);
  assert.ok(!/osxkeychain|manager|libsecret|wincred|store|cache/.test(helpers[0]), `a platform credential store is reachable: ${helpers[0]}`);
  // Dropping GIT_CONFIG_NOSYSTEM is what the previous round got wrong, so assert it is load-bearing on THIS machine
  // rather than asserting it in a comment. Where a system file sets a helper, removing the variable adds it back.
  const { GIT_CONFIG_NOSYSTEM, ...noNoSystem } = env;
  const sysHelpers = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: dir, env: noNoSystem, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const systemSets = execFileSync("git", ["config", "--list", "--show-origin"], { cwd: dir, env: noNoSystem, encoding: "utf8" });
  if (/^file:.*(git-core|\/etc)\/gitconfig\s+credential\.helper=/m.test(systemSets)) {
    assert.ok(sysHelpers.length > helpers.length, "without GIT_CONFIG_NOSYSTEM the system file's helper must appear, which is why the variable is set");
  }
  rmSync(dir, { recursive: true, force: true });
});

test("git in a run's environment authenticates from GH_TOKEN alone, with no readable HOME at all", () => {
  // The end-to-end mechanism, which is what a sandboxed push depends on: no keyring, no ~/.git-credentials, no
  // ~/.config/gh, no ~/.gitconfig, and no file the process needs permission to read. Before this change the same
  // call with HOME unreadable failed on the gitconfig path rather than answering.
  const dir = mkdtempSync(join(tmpdir(), "gallivant-fill-"));
  const base = { PATH: process.env.PATH, HOME: join(dir, "no-such-home"), GIT_TERMINAL_PROMPT: "0" };
  const ask = "protocol=https\nhost=github.com\n\n";
  const out = execFileSync("git", ["credential", "fill"], { cwd: dir, input: ask, encoding: "utf8", env: { ...base, ...runEnv(CONFIG, { token: "t-in-env" }) } });
  assert.match(out, /^username=x$/m);
  assert.match(out, /^password=t-in-env$/m);
  // With no GH_TOKEN the helper declines rather than inventing a credential, so git fails loudly instead of pushing
  // as somebody else. This is also the assertion that would catch a helper that fell back to a platform store.
  let failed = false;
  try { execFileSync("git", ["credential", "fill"], { cwd: dir, input: ask, encoding: "utf8", env: { ...base, ...runEnv(CONFIG) }, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { failed = true; }
  assert.equal(failed, true, "no GH_TOKEN must not yield a credential");
  rmSync(dir, { recursive: true, force: true });
});

test("no run environment variable is rendered anywhere an operator or the tracker can read", () => {
  // A token in the tracker would be a leak, so this asserts the absence of a path rather than trusting a review.
  // `cmd.json` is the only thing the runner writes about a spawn, and `job.log` is the child's own stdout; the
  // tracker reads job.json and job.log and never cmd.json. Asserted of the source, because the leak would be a new
  // line of code, not a new value.
  const root = new URL("..", import.meta.url).pathname;
  const runner = readFileSync(join(root, "lib/run.mjs"), "utf8");
  const written = runner.match(/writeFileSync\(join\(dirOf\(id\), "cmd\.json"\), JSON\.stringify\(([^)]*)\)/)?.[1];
  assert.ok(written, "cmd.json is no longer written the way this test reads it; re-check what it records");
  assert.ok(!/\benv\b/.test(written), `cmd.json records ${written}; an environment there would put the token on disk`);
  for (const f of ["lib/tracker/runs.mjs", "lib/tracker/stream.mjs", "lib/tracker/pages.mjs", "lib/tracker/assets.mjs"]) {
    const text = readFileSync(join(root, f), "utf8");
    assert.ok(!/cmd\.json/.test(text), `${f} reads cmd.json; nothing rendered to a browser may`);
    assert.ok(!/GH_TOKEN|GIT_CONFIG|process\.env\b/.test(text), `${f} touches the environment; nothing rendered to a browser may`);
  }
});

test("the configured token file wins over the daemon environment and over gh, so a scoped token is never widened", async () => {
  // Constraint 3 of the brief. An operator who set github_token_file has deliberately narrowed what a run may reach;
  // anything resolved later must not override that, or the narrowing is decorative.
  const { calls, exec } = ghExec();
  const c = await resolveCredential(withTokenFile(), { env: { GH_TOKEN: "t-from-env", GITHUB_TOKEN: "t-from-github-env" }, exec });
  assert.equal(c.token, "t-from-file");
  assert.equal(c.source, SOURCES.file);
  // And `gh` was never even asked: the file answered, so no subprocess ran.
  assert.deepEqual(calls, []);
});

test("the daemon environment wins over gh, and GH_TOKEN wins over GITHUB_TOKEN", async () => {
  const { calls, exec } = ghExec();
  const c = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: { GH_TOKEN: "t-from-env", GITHUB_TOKEN: "t-other" }, exec });
  assert.deepEqual([c.token, c.source], ["t-from-env", SOURCES.env]);
  assert.deepEqual(calls, []);
  const only = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: { GITHUB_TOKEN: "t-other" }, exec });
  assert.deepEqual([only.token, only.source], ["t-other", SOURCES.env]);
});

test("gh answers last, which is what makes any login work regardless of how the operator authenticated", async () => {
  // The requirement this exists for: whatever store gh uses (macOS keyring, Linux secret service, or a plain
  // hosts.yml when there is no keyring), `gh auth token` answers for it. Gallivant asks gh rather than parsing
  // hosts.yml, so it never drifts from gh's own resolution.
  const { calls, exec } = ghExec();
  const c = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: {}, exec });
  assert.deepEqual([c.token, c.source], ["t-from-gh", SOURCES.gh]);
  assert.deepEqual(calls, [["gh", "auth", "token"]]);
});

test("a missing, unreadable or blank configured token file never widens to ambient credentials", async () => {
  const root = tempHome();
  const configurations = [withTokenFile(""), withTokenFile("   \n  "),
    { ...CONFIG, github_token_file: join(root, "missing-token") },
    // A directory produces a portable filesystem read error, including in root-run CI.
    { ...CONFIG, github_token_file: root }];
  for (const config of configurations) {
    const { calls, exec } = ghExec("t-broader-login");
    const credential = () => resolveCredential(config, { env: { GH_TOKEN: "t-broader-env", GITHUB_TOKEN: "t-other-env" }, exec });
    const refusal = error => {
      assert.equal(error.code, "NO_CREDENTIAL");
      assert.equal(error.reason, "configured-token-file-unavailable");
      assert.match(error.message, /configured github_token_file/);
      assert.match(error.message, /No fallback credential was used/);
      assert.doesNotMatch(error.message, /t-broader|t-other/);
      return true;
    };
    await assert.rejects(credential(), refusal);
    const forbiddenExec = async () => assert.fail("GitHub/Git must not execute with ambient credentials");
    await assert.rejects(makeGh({ credential, exec: forbiddenExec }).user(), refusal);
    await assert.rejects(makeGit({ config, credential, exec: forbiddenExec }).head(root), refusal);
    assert.deepEqual(calls, [], "gh auth token must not be queried after an explicit credential source fails");
  }
});

test("a run refuses to start when neither the file, the environment nor gh can answer", async () => {
  // Constraint 5. Starting a session that will spend money and then fail to push is the defect being fixed, so the
  // absence of a credential has to be a refusal with instructions, not a warning.
  const c = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: {}, exec: ghSilent().exec });
  assert.equal(c.token, null);
  assert.equal(c.source, null);
  // All three sources are named, in the order they are tried, because the operator has to pick one.
  assert.match(c.why, /gh auth login/);
  assert.match(c.why, /GH_TOKEN/);
  assert.match(c.why, /github_token_file/);
  assert.match(c.why, /Nothing was started/);
  // And runEnv given that refusal sets no token, so nothing downstream can mistake it for a credential.
  assert.equal(runEnv(CONFIG, c).GH_TOKEN, undefined);
});

test("a gh that fails or is not installed falls through instead of crashing the daemon", async () => {
  const boom = { exec: async () => { throw new Error("gh: command not found"); } };
  const c = await resolveCredential({ ...CONFIG, github_token_file: null }, { env: {}, exec: boom.exec });
  assert.equal(c.token, null);
  assert.match(c.why, /No GitHub credential/);
});

test("an enterprise host asks gh for that host, rather than sending it a github.com token", async () => {
  // `gh` can be logged in to more than one host. A github.com token does not authenticate github.acme.com, so the
  // host goes to gh. It goes in argv, which is correct: the HOST is not a secret, and the token comes back on stdout.
  const { calls, exec } = ghExec();
  await resolveCredential({ ...CONFIG, github_token_file: null }, { host: "github.acme.com", env: {}, exec });
  assert.deepEqual(calls, [["gh", "auth", "token", "--hostname", "github.acme.com"]]);
  // github.com does NOT get the flag, so an older gh without it still works for the overwhelmingly common case.
  const dotcom = ghExec();
  await resolveCredential({ ...CONFIG, github_token_file: null }, { host: "github.com", env: {}, exec: dotcom.exec });
  assert.deepEqual(dotcom.calls, [["gh", "auth", "token"]]);
});

test("the refusal for an enterprise host says plainly that it needs github_token_file", async () => {
  const msg = noCredentialMessage("github.acme.com");
  assert.match(msg, /github\.acme\.com, not github\.com/);
  assert.match(msg, /github_token_file/);
  assert.match(msg, /gh auth login --hostname github\.acme\.com/);
});

test("the host is taken from the remote, for every remote shape git writes", () => {
  assert.equal(hostFromRemote("https://github.com/acme/widget.git"), "github.com");
  assert.equal(hostFromRemote("https://github.acme.com/acme/widget.git"), "github.acme.com");
  assert.equal(hostFromRemote("https://x-access-token:tok@github.com/acme/widget"), "github.com");
  assert.equal(hostFromRemote("git@github.acme.com:acme/widget.git"), "github.acme.com");
  assert.equal(hostFromRemote("ssh://git@github.com/acme/widget.git"), "github.com");
  assert.equal(hostFromRemote(""), "github.com");
  assert.equal(isDotCom("GitHub.com"), true);
  assert.equal(isDotCom("github.acme.com"), false);
});

test("resolveCredentialFor reads the host from the entry's own checkout", async () => {
  const { calls, exec } = ghExec();
  const ctx = {
    config: { ...CONFIG, github_token_file: null },
    git: { originOf: async () => "https://github.acme.com/acme/widget.git" },
    credential: opts => resolveCredential({ ...CONFIG, github_token_file: null }, { ...opts, env: {}, exec }),
  };
  await resolveCredentialFor(ctx, { worktree: "/tmp/wt" });
  assert.deepEqual(calls, [["gh", "auth", "token", "--hostname", "github.acme.com"]]);
  // A checkout whose remote cannot be read is not worth failing over: it reads as github.com and git's own error
  // is what the operator sees.
  const broken = ghExec();
  await resolveCredentialFor({
    config: CONFIG,
    git: { originOf: async () => { throw new Error("not a git repository"); } },
    credential: opts => resolveCredential({ ...CONFIG, github_token_file: null }, { ...opts, env: {}, exec: broken.exec }),
  }, { worktree: "/tmp/wt" });
  assert.deepEqual(broken.calls, [["gh", "auth", "token"]]);
});

test("describe names the source and a length, never the credential, because it is printed and logged", () => {
  // `job.log` is rendered in the tracker and read by the operator. A token in a log is a leak, so the only thing
  // anything human-readable ever gets is this.
  const line = describeCredential({ token: "t-from-file", source: SOURCES.file, host: "github.com" });
  assert.match(line, /github_token_file/);
  assert.match(line, /11 characters/);
  assert.ok(!line.includes("t-from-file"), "the credential itself is never in the description");
  assert.equal(describeCredential({ token: null, source: null, host: "github.com" }), "none");
  assert.match(describeCredential({ token: "abc", source: SOURCES.gh, host: "github.acme.com" }), /for github\.acme\.com/);
});

test("tokenFromEnv and tokenFromGh trim, so a trailing newline is not part of the credential", async () => {
  assert.equal(tokenFromEnv({ GH_TOKEN: "  t-x  " }), "t-x");
  assert.equal(tokenFromEnv({}), "");
  assert.equal(await tokenFromGh("github.com", { exec: async () => "t-y\n" }), "t-y");
});

// The mechanism this used to test through templates/gitconfig now travels in the environment, so it is asserted
// against `runEnv` above ("git in a run's environment authenticates from GH_TOKEN alone"). The template is gone: a
// file the docs told an operator to create and no code read was a trap for the next person debugging this.

test("a resumed session is told which commits are already made, so it pushes rather than redoing the work", () => {
  // The stranded-work case. Four commits existed and could not be pushed; a resumed session whose memory ends
  // mid-task cannot tell finished work from work it was about to do, and re-deriving it costs a round.
  const unpushed = [
    { sha: "1111111", subject: "Add canonical repair" },
    { sha: "2222222", subject: "Cover the redirect case" },
  ];
  const p = resumePrompt({ repo: "acme/widget", pr: null, reason: "no-push", unpushed });
  assert.match(p, /2 commits on this branch are already made and NOT yet pushed/);
  assert.match(p, /Preserve this work; make any corrections in new commits/);
  assert.match(p, /1111111 Add canonical repair/);
  assert.match(p, /2222222 Cover the redirect case/);
  assert.match(p, /operator's correction and the approved brief before pushing/);
  // And with nothing unpushed the paragraph is absent rather than asserting something untrue.
  assert.ok(!/already made and NOT yet pushed/.test(resumePrompt({ repo: "acme/widget", pr: 7, reason: "iterations" })));
});

test("the no-credential stop reads as its own reason in a resume prompt, not as an unexplained cut", () => {
  const p = resumePrompt({ repo: "acme/widget", pr: null, reason: "no-credential" });
  assert.match(p, /no GitHub credential could be resolved/);
  assert.match(p, /one is available now/);
});

test("no fixture, config or template in the tree carries anything token-shaped", () => {
  // The rule that matters most in this file. A token in a fixture is a token in git history, and this asserts it of
  // the tree rather than trusting each author to remember.
  const root = new URL("..", import.meta.url).pathname;
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  // GitHub's own token prefixes, which is what a real leak looks like: ghp_ (classic PAT), gho_ (OAuth), ghu_/ghs_
  // (app tokens), ghr_ (refresh), github_pat_ (fine-grained).
  const shape = /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})/;
  const hits = [];
  for (const f of files) {
    const abs = join(root, f);
    if (!existsSync(abs)) continue;
    let text;
    try { text = readFileSync(abs, "utf8"); } catch { continue; }
    if (shape.test(text)) hits.push(f);
  }
  assert.deepEqual(hits, [], "a GitHub token is committed in these files");
});

test("unpushed finds the commits of a branch that was NEVER pushed, which is the stranded case", async () => {
  // The bug this caught. `origin/<branch>..HEAD` is empty for a branch with no remote ref, so the first version of
  // this reported nothing for exactly the run it was written for: four commits made, push refused, branch never
  // pushed. Driven through real git in a real repository rather than asserted about a string.
  const { makeGit } = await import("../lib/git.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gallivant-unpushed-"));
  const remote = mkdtempSync(join(tmpdir(), "gallivant-remote-"));
  const run = (args, cwd = dir) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" } });
  run(["init", "--bare", "--initial-branch=main", "."], remote);
  run(["init", "--initial-branch=main", "."]);
  run(["remote", "add", "origin", remote]);
  writeFileSync(join(dir, "a.txt"), "base\n");
  run(["add", "."]); run(["commit", "-m", "base commit"]);
  run(["push", "-u", "origin", "main"]);
  // A branch with two commits that is never pushed: the stranded shape.
  run(["checkout", "-b", "gallivant/stuck"]);
  writeFileSync(join(dir, "b.txt"), "one\n");
  run(["add", "."]); run(["commit", "-m", "first change"]);
  writeFileSync(join(dir, "c.txt"), "two\n");
  run(["add", "."]); run(["commit", "-m", "second change"]);

  const g = makeGit({ config: { home: dir, worktrees: dir } });
  const found = await g.unpushed(dir, "gallivant/stuck", "main");
  assert.equal(found.length, 2, "both commits of a never-pushed branch are reported");
  assert.deepEqual(found.map(c => c.subject), ["second change", "first change"]);
  assert.ok(/^[0-9a-f]{7,}$/.test(found[0].sha));

  // And once pushed there is nothing outstanding, so the prompt says nothing rather than telling a session to push
  // what is already on the remote.
  run(["push", "-u", "origin", "gallivant/stuck"]);
  assert.deepEqual(await g.unpushed(dir, "gallivant/stuck", "main"), []);
  // One more commit after that push is outstanding again, by the first range this time.
  writeFileSync(join(dir, "d.txt"), "three\n");
  run(["add", "."]); run(["commit", "-m", "third change"]);
  const after = await g.unpushed(dir, "gallivant/stuck", "main");
  assert.deepEqual(after.map(c => c.subject), ["third change"]);
});
