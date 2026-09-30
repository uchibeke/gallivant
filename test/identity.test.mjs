// Who a run commits as, and what it may not write in a commit message.
//
// Both halves come from one live pull request. Its four commits were authored `gallivant <the operator's real email>`
// and every one of them carried `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`. The author was
// half right by accident and the trailer was wrong on purpose, and the two are fixed by different mechanisms: the
// identity by resolving the operator's own and passing it through the run env, the trailer by a `commit-msg` hook that
// refuses the commit.
//
// No test here depends on the machine running the suite having a git identity. `resolveIdentity` takes its `exec`, and
// `requireIdentity` takes a resolver, exactly as `resolveCredential` already does, so both branches are driven.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveIdentity, requireIdentity, describeIdentity, NO_IDENTITY } from "../lib/identity.mjs";
import { runEnv, RUN_GIT_CONFIG, identityConfig, makeGit } from "../lib/git.mjs";
import { attributionIn, attributionError, COMMIT_MSG_HOOK } from "../lib/attribution.mjs";
import { startPrompt, fixPrompt, resumePrompt } from "../lib/prompt.mjs";

const OPERATOR = { name: "Ada Lovelace", email: "ada@example.com" };

/** A fake `git config --get <key>` that answers from a map, so neither branch needs a real gitconfig. */
const fakeGitConfig = answers => async (_cmd, args) => {
  const key = args[args.length - 1];
  return (answers[key] ?? "") + "\n";
};

// --- the identity a run commits as ---------------------------------------------------------------------------------

test("a run commits as the operator, whose name and email are resolved from their own git config", async () => {
  const id = await resolveIdentity({ exec: fakeGitConfig({ "user.name": OPERATOR.name, "user.email": OPERATOR.email }) });
  assert.deepEqual(id, OPERATOR);
  assert.equal(describeIdentity(id), "Ada Lovelace <ada@example.com>");
});

test("the run's git config carries the operator's identity, not a bot's, and still on the command line", () => {
  const env = runEnv({ worktrees: "/w" }, { token: "t-x" }, OPERATOR);
  const pairs = Object.keys(env).filter(k => k.startsWith("GIT_CONFIG_KEY_"))
    .map(k => [env[k], env[k.replace("KEY", "VALUE")]]);

  assert.deepEqual(pairs.find(([k]) => k === "user.name"), ["user.name", OPERATOR.name]);
  assert.deepEqual(pairs.find(([k]) => k === "user.email"), ["user.email", OPERATOR.email]);
  // The bot identity this replaces. A `gallivant` committer tells a reviewer a robot did the work, which is the signal
  // the change exists to remove, so its absence is asserted rather than left to be inferred from the pair above.
  assert.ok(!JSON.stringify(env).includes("gallivant@users.noreply.github.com"), "no bot email anywhere in a run's environment");
  assert.ok(!RUN_GIT_CONFIG.some(([k]) => k === "user.name" || k === "user.email"), "identity is no longer a literal in the fixed list");
  // Every pair is counted, or git reads only some of them.
  assert.equal(env.GIT_CONFIG_COUNT, String(RUN_GIT_CONFIG.length + identityConfig(OPERATOR).length));
});

test("runEnv still names no path outside the worktree once an identity travels in it", () => {
  // The property this must not lose. An email is not a path, but an implementation that passed the config FILE's path
  // instead of its values would satisfy every other assertion here and reintroduce the sandbox denial `5b69814` fixed.
  const env = runEnv({ worktrees: "/w", home: "/operator/home/.gallivant" }, { token: "t-x" }, OPERATOR);
  for (const [k, v] of Object.entries(env)) {
    if (k === "GIT_CONFIG_GLOBAL") continue;   // /dev/null, which every sandbox permits; documented in runEnv
    assert.ok(!/(^|[^\w])\/(?:Users|home|etc|var|private)\//.test(String(v)), `${k} names an absolute path: ${v}`);
  }
  assert.ok(!JSON.stringify(env).includes(".gitconfig"), "the operator's config file is never named; only its values travel");
  assert.ok(!JSON.stringify(env).includes(".gallivant"), "and no Gallivant directory either");
});

test("a machine with no git identity refuses before a run is spawned, and says the two commands that fix it", async () => {
  const none = await resolveIdentity({ exec: fakeGitConfig({}) });
  assert.deepEqual([none.name, none.email], [null, null]);
  assert.equal(none.why, NO_IDENTITY);

  // The refusal both `start` and `resume` reach. It throws, because neither caller can continue: a session that cannot
  // commit what it writes has its whole cost wasted, which is the same reasoning as the credential refusal beside it.
  await assert.rejects(() => requireIdentity({ identity: async () => none }), e => {
    assert.equal(e.code, "NO_IDENTITY");
    assert.match(e.message, /no git identity on this machine\. Gallivant commits as you/);
    assert.match(e.message, /git config --global user\.name/);
    assert.match(e.message, /git config --global user\.email/);
    // One identity path, so there is no flag to offer as a way round it.
    assert.ok(!/--as-bot/.test(e.message), "no escape hatch is mentioned, because none exists");
    return true;
  });

  // A half-configured machine is no identity at all: git would refuse the commit itself, and later.
  await assert.rejects(() => requireIdentity({ identity: async () => ({ name: "Ada", email: "" }) }), /no git identity/);
  assert.deepEqual(await requireIdentity({ identity: async () => OPERATOR }), OPERATOR);
});

// --- the commit-msg hook -------------------------------------------------------------------------------------------

/** Every harness's trailer, in the spellings they actually write. */
const TRAILERS = [
  ["claude", "Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"],
  ["codex", "Co-authored-by: Codex <noreply@openai.com>"],
  ["gemini", "Co-Authored-By: Gemini <gemini@google.com>"],
  ["opencode", "co-authored-by: opencode <dev@opencode.ai>"],
  ["goose", "Co-Authored-By: Goose <goose@block.xyz>"],
];

test("a commit message crediting any of the five harnesses is refused, and the offending line is named", () => {
  for (const [harness, trailer] of TRAILERS) {
    const found = attributionIn(`feat: add the thing\n\nA real summary of the change.\n\n${trailer}\n`);
    assert.equal(found, trailer, `${harness}'s trailer is matched whole, so the error can quote it`);
    // The error is the whole value of failing early: a session told only "rejected" retries the identical message.
    const err = attributionError(found);
    assert.match(err, /credits an AI harness, which is not permitted/);
    assert.match(err, /Remove that line from the message and commit again/);
    assert.ok(err.includes(trailer), "the error quotes the line the session has to remove");
  }
  // The footer Claude Code appends, in both the forms it writes.
  assert.ok(attributionIn("feat: x\n\n🤖 Generated with Claude Code\n"));
  assert.ok(attributionIn("feat: x\n\nGenerated with Claude Code (https://claude.com/claude-code)\n"));
});

test("a message that merely mentions a harness in prose is accepted, because this repository is about harnesses", () => {
  // The matcher has to be narrow or the way around it is to describe the change dishonestly. These are all real commits
  // this project needs to be able to make.
  for (const msg of [
    "fix: claude adapter drops the session id on resume",
    "feat: read codex's thread.started event for the session id",
    "docs: say why gemini, opencode and goose parse only the events harness.mjs proves exist",
    "refactor: one openai-shaped adapter per harness, keyed the way adapters is",
    "fix: google's CLI renamed the flag, so the version probe was reading nothing",
  ]) assert.equal(attributionIn(msg), null, `must be committable: ${msg}`);

  // A clean message with a body and a legitimate human co-author is fine; only harnesses are refused.
  assert.equal(attributionIn("feat: x\n\nA summary.\n\nCo-Authored-By: Ada Lovelace <ada@example.com>\n"), null);
  // git's own commentary is ignored, including the co-author list its merge template prints.
  assert.equal(attributionIn("feat: x\n\n# Co-Authored-By: Claude <noreply@anthropic.com>\n# Please enter a message\n"), null);
});

test("the hook inlined into the script agrees with the module's matcher on every case", () => {
  // The script is self-contained because it runs inside a sandboxed checkout that cannot read Gallivant's source, so
  // the matcher exists twice. This is what stops the copies drifting.
  const dir = mkdtempSync(join(tmpdir(), "gallivant-hook-"));
  const hook = join(dir, "commit-msg");
  writeFileSync(hook, COMMIT_MSG_HOOK, { mode: 0o755 });
  const run = message => {
    const file = join(dir, "MSG");
    writeFileSync(file, message);
    try { execFileSync(process.execPath, [hook, file], { stdio: ["ignore", "pipe", "pipe"] }); return { code: 0, err: "" }; }
    catch (e) { return { code: e.status, err: String(e.stderr || "") }; }
  };

  for (const [, trailer] of TRAILERS) {
    const r = run(`feat: x\n\n${trailer}\n`);
    assert.equal(r.code, 1, "a trailer exits non-zero, which is what makes git create no commit");
    assert.ok(r.err.includes(trailer), "and the script prints the same line the module would");
  }
  assert.equal(run("fix: claude adapter drops the session id").code, 0, "prose is accepted by the script too");
  assert.equal(run("feat: x\n\nA summary.\n").code, 0);
  // A message file that cannot be read exits 0. The hook is a guard against one specific line, not a second gate on
  // whether git may commit at all, so a hook that cannot do its job must not break committing.
  let missing = 0;
  try { execFileSync(process.execPath, [hook, join(dir, "no-such-message")], { stdio: "ignore" }); } catch (e) { missing = e.status; }
  assert.equal(missing, 0, "an unreadable message file does not block the commit");
});

for (const packageType of [null, "module", "commonjs"]) test(`the hook rejects attribution and commits cleanly in a ${packageType ?? "plain"} repository`, { skip: !hasGit() }, () => {
  // Driven through real git, because the claim is about git's behaviour: an exit of 1 from `commit-msg` must leave NO
  // commit object, not a commit with a warning. A string test cannot show that.
  const dir = mkdtempSync(join(tmpdir(), "gallivant-commit-"));
  const git = (args, env = {}) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  git(["init", "-q", "."]);
  if (packageType) writeFileSync(join(dir, "package.json"), JSON.stringify({ type: packageType }));
  writeFileSync(join(dir, "a.txt"), "x\n");
  git(["add", "a.txt"]);
  const hooks = join(dir, ".git", "hooks");
  writeFileSync(join(hooks, "commit-msg"), COMMIT_MSG_HOOK, { mode: 0o755 });
  chmodSync(join(hooks, "commit-msg"), 0o755);

  // The env a run actually gets, identity included, so what is asserted is what a session would do.
  const env = runEnv({ worktrees: dir }, null, OPERATOR);
  const commit = message => {
    writeFileSync(join(dir, "MSG"), message);
    try { git(["commit", "-q", "-F", "MSG"], env); return 0; } catch (e) { return e.status; }
  };

  assert.equal(commit("feat: x\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>\n"), 1, "the trailer is refused");
  assert.equal(git(["rev-list", "--count", "--all"]).trim(), "0", "and NO commit object was created");

  assert.equal(commit("feat: x\n\nA real summary of the change.\n"), 0, "a clean message commits");
  assert.equal(git(["log", "--format=%an <%ae>"]).trim(), "Ada Lovelace <ada@example.com>", "as the operator, not as a bot");
});

test("installHooks writes the commit-msg hook into a checkout, idempotently and without failing a run", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallivant-install-"));
  execFileSync("git", ["init", "-q", dir]);
  const git = makeGit({ config: { worktrees: dir } });

  assert.deepEqual(git.installHooks(dir), { installed: true });
  const path = join(dir, ".git", "hooks", "commit-msg");
  assert.ok(existsSync(path));
  assert.equal(readFileSync(path, "utf8"), COMMIT_MSG_HOOK);
  assert.deepEqual(git.installHooks(dir), { installed: true }, "called again on every use of a checkout, so it must be idempotent");

  // A checkout that is not there is a missing guard, not a reason to refuse a session the worktree it needs.
  const bad = git.installHooks("/nonexistent/definitely/not/here");
  assert.equal(bad.installed, false);
  assert.ok(bad.why, "the reason comes back so the caller can log it");
});

// --- uncommitted work a kill leaves behind ---------------------------------------------------------------------------

test("git.dirty counts modified and untracked separately, because a recreate takes the untracked half silently", () => {
  const dir = mkdtempSync(join(tmpdir(), "gallivant-dirty-"));
  const run = args => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  run(["init", "-q", "."]);
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  run(["add", "tracked.txt"]);
  run(["-c", "user.name=t", "-c", "user.email=t@t.t", "commit", "-q", "-m", "first"]);
  const git = makeGit({ config: { worktrees: dir } });

  return git.dirty(dir).then(async clean => {
    assert.deepEqual(clean, { modified: 0, untracked: 0 }, "a committed tree is clean");

    // The real state the kill left: files edited, and new files never added. `unpushed` counts zero for both.
    writeFileSync(join(dir, "tracked.txt"), "two\n");
    writeFileSync(join(dir, "new-one.ts"), "x\n");
    writeFileSync(join(dir, "new-two.ts"), "y\n");
    assert.deepEqual(await git.dirty(dir), { modified: 1, untracked: 2 });

    // An untracked DIRECTORY counts as its files, not as one line, which is what `-uall` is for: a whole new module
    // would otherwise read as a single untracked thing.
    execFileSync("mkdir", ["-p", join(dir, "pkg")]);
    writeFileSync(join(dir, "pkg", "a.ts"), "a\n");
    writeFileSync(join(dir, "pkg", "b.ts"), "b\n");
    assert.deepEqual(await git.dirty(dir), { modified: 1, untracked: 4 });

    // A checkout that is not a checkout reports nothing rather than throwing: this is reporting at a kill, and a missing
    // directory is not worth failing the kill over.
    assert.deepEqual(await git.dirty("/nonexistent/definitely/not/here"), { modified: 0, untracked: 0 });
  });
});

// --- the half a hook cannot reach ----------------------------------------------------------------------------------

test("every prompt forbids harness attribution, because a PR body never passes through a git hook", () => {
  // `gh pr create` is a network call with nothing local in the path, so the hook cannot see a PR body at all. That gap
  // is covered by text, in RULES rather than only the `gh pr create` line, because `fixPrompt` also edits bodies.
  const prd = { text: "# Brief\n\n## Acceptance criteria\n- [ ] it works\n", id: "widget-export" };
  for (const p of [
    startPrompt({ prd, repo: "acme/widget", branch: "gallivant/widget-export", base: "main", verify: ["npm test"] }),
    fixPrompt({ repo: "acme/widget", pr: 1, headSha: "a1b2c3d", events: [], verify: [] }),
    resumePrompt({ repo: "acme/widget", pr: 1, reason: "no-push" }),
  ]) {
    assert.match(p, /Do not credit an AI harness anywhere in what you write/);
    assert.match(p, /No `Co-Authored-By:` trailer naming a model or its vendor/);
    assert.match(p, /in a commit message or in a PR body/, "both surfaces are named, since only one of them is enforced");
    assert.match(p, /a commit carrying one is refused/, "the session is told the commit hook exists, so a refusal is not a mystery");
    assert.match(p, /Naming a harness in prose is fine/, "and the narrow exception, so the rule is not worked around");
  }
});

// --- the merge the DAEMON itself commits -----------------------------------------------------------------------------

/**
 * A repository on a branch that has something to merge from `main`, with NO identity git can find: no repo-local
 * `user.name`/`user.email` (a fresh `--filter=blob:none` clone has none) and `user.useConfigOnly=true`, which is what
 * makes this deterministic everywhere.
 *
 * That last setting is the whole reason this test is honest about its own limits. Told nothing, git GUESSES an identity
 * from the passwd database, so on macOS and on most Linux boxes the merge succeeds and commits as
 * `<login>@<hostname>.local`. `useConfigOnly` turns that guess off, which is exactly the state of a container or a CI
 * runner with no gecos field. Both outcomes are bugs and the fix is the same one: the guess attributes the daemon's own
 * commit to an address that is not the operator's, and the refusal is reported to the operator as a merge conflict that
 * does not exist.
 */
function repoWithSomethingToMerge() {
  const dir = mkdtempSync(join(tmpdir(), "gallivant-mergeid-"));
  const setup = { GIT_AUTHOR_NAME: "Setup", GIT_AUTHOR_EMAIL: "setup@example.com", GIT_COMMITTER_NAME: "Setup", GIT_COMMITTER_EMAIL: "setup@example.com" };
  const g = (args, env = {}) => execFileSync("git", args, { cwd: dir, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  g(["init", "-q", "-b", "main", "."]);
  // No identity anywhere git will look, and no guessing allowed. The setup commits carry theirs in the environment.
  g(["config", "user.useConfigOnly", "true"]);
  const commit = (file, message) => { writeFileSync(join(dir, file), `${file}\n`); g(["add", file]); g(["commit", "-q", "-m", message], setup); };
  commit("a.txt", "a");
  g(["checkout", "-q", "-b", "gallivant/widget-export"]);
  commit("b.txt", "b");           // the branch's own work
  g(["checkout", "-q", "main"]);
  commit("c.txt", "c");           // the base moved under it, in a file the branch does not touch
  g(["checkout", "-q", "gallivant/widget-export"]);
  // `mergeBase` merges `origin/<base>`, so the remote-tracking ref is what has to exist. There is no remote to fetch
  // from, so the exec below answers the fetch and this ref stands in for what it would have brought.
  g(["update-ref", "refs/remotes/origin/main", g(["rev-parse", "main"]).trim()]);
  return dir;
}

/** Real git for `makeGit`, with `fetch` answered locally: there is no remote, and the base ref is already in place. */
const realGitExec = async (cmd, args, opts) => {
  if (args[0] === "fetch") return { stdout: "" };
  try { return { stdout: execFileSync(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" }) }; }
  catch (e) { throw new Error(String(e.stderr || e.stdout || e.message)); }
};

test("the daemon's own base merge commits as the operator, in a checkout where git can find no identity at all", { skip: !hasGit() }, async () => {
  // Driven through a REAL `git merge` on purpose, and that choice is the finding. The env-pair assertions further up
  // this file are what let this through: they could see that `makeGit` passed no identity pairs and had no way to
  // notice that one of its commands COMMITS. `mergeBase` runs `git merge --no-ff`, and `runEnv`'s own
  // `GIT_CONFIG_GLOBAL=/dev/null` plus `GIT_CONFIG_NOSYSTEM=1` are what leave the clone with nowhere to read a
  // committer from.
  const dir = repoWithSomethingToMerge();

  // What `makeContext` builds: the identity resolver is a FUNCTION, like the credential resolver beside it, because the
  // daemon is long-lived and an operator may change their name or email under it.
  const git = makeGit({ config: { worktrees: dir }, exec: realGitExec, identity: async () => OPERATOR });
  const r = await git.mergeBase(dir, "main");

  assert.equal(r.conflict, undefined, "there is nothing to conflict over: the two branches touch different files");
  assert.equal(r.merged, true, "so the merge commit was made");

  const show = execFileSync("git", ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(show, "Ada Lovelace <ada@example.com>|Ada Lovelace <ada@example.com>", "author AND committer are the operator");
  // Not a machine-derived address, which is the quieter half of the bug: where git CAN guess, the merge succeeds and is
  // attributed to `<login>@<hostname>.local`, and nothing fails to tell anyone.
  assert.ok(!/\.local>/.test(show), "not an identity git guessed from the passwd database");
});

test("with no identity resolvable the base merge fails, and that failure must not be reported as a conflict", { skip: !hasGit() }, async () => {
  // The consequence that makes this a P1 rather than a cosmetic attribution bug. `mergeBase` cannot tell WHY `git merge`
  // exited non-zero, so it reports every failure as `conflict: true`, and a missing committer reaches the operator as
  // "your branch cannot be merged with its base": every divergent-base fix round and every `resume` blocked behind a
  // conflict that does not exist. This pins the mechanism that was doing it, so the reason for the fix cannot quietly go
  // away, and then shows the same call succeeding once an identity is resolved.
  const dir = repoWithSomethingToMerge();
  const git = makeGit({ config: { worktrees: dir }, exec: realGitExec });   // the old default: no identity at all

  const r = await git.mergeBase(dir, "main");
  // This is the misreport itself, and it is the bug's whole consequence. `mergeBase` cannot tell a content conflict
  // from any other reason `git merge` exited non-zero, so a missing committer comes back wearing `conflict: true`, and
  // `mergeBaseInto` hands that to the operator as "your branch cannot be merged with its base". The two branches touch
  // different files; there is no conflict to find.
  assert.equal(r.merged, false);
  assert.equal(r.conflict, true, "a missing committer is indistinguishable from a real conflict to every caller");
  assert.match(r.why, /identity unknown|Please tell me who you are|empty ident/i, "and the reason git gave was about the committer, not about a conflict");

  // Nothing was left half-merged either way: `mergeBase` runs `git merge --abort` before it reports, so the checkout a
  // session would be handed has no conflict markers in it.
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim();
  assert.equal(status, "", "the working tree is clean");

  // The same repository, the same call, with the identity `makeGit` now resolves: it merges. That is what makes the
  // paragraph above a bug report rather than a description of git.
  const fixed = makeGit({ config: { worktrees: dir }, exec: realGitExec, identity: async () => OPERATOR });
  assert.equal((await fixed.mergeBase(dir, "main")).merged, true, "nothing about the branches was ever the problem");
});

function hasGit() {
  try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
