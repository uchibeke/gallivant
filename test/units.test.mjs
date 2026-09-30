import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, basename } from "node:path";
import { readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { makeState, resolveHandle, newEntry, entryId, idSlug, prdIdOf, advanceCursor, shortRepo, handleFor, STATES } from "../lib/state.mjs";
import { isAtOrAfter, floorSecond } from "../lib/time.mjs";
import { renderBlock, parseBlock, upsertBlock } from "../lib/block.mjs";
import { quote, fixPrompt, startPrompt } from "../lib/prompt.mjs";
import { buildRun, assertSafeArgv, assertSafeEnv, adapters, compareVersions, contextSupport, MIN_VERSIONS } from "../lib/harness.mjs";
import { parsePrd, verifyCommands, withFrontmatterKey, fencedBlocks, findPlaceholder } from "../lib/prd.mjs";
import { makeRunner, isOurProcess } from "../lib/run.mjs";
import { branchFor, prdIdFromBranch, isOurBranch, makeGit } from "../lib/git.mjs";
import { writeFileSync, existsSync, utimesSync, mkdirSync, symlinkSync } from "node:fs";
import { validate, DEFAULTS, merge, discoverHarnesses, whence, validateContextPaths, resolveContextPaths, parseContextPathsMeta, HARNESSES } from "../lib/config.mjs";
import { signInFix, probeFix } from "../lib/probe.mjs";
import { HOME } from "../lib/fs.mjs";
import { messages } from "../lib/notify.mjs";
import { repoFromRemote, remoteMatches, makeGh, MAX_DIFF_BYTES, READY_LABEL } from "../lib/gh.mjs";
import { CONFIG, T0, at, tempHome, claudeResultLines, codexLines, geminiLines, opencodeLines, gooseLines, GOOD_PRD } from "./helpers.mjs";

test("state writes atomically and resolves handles", () => {
  const home = tempHome();
  const s = makeState(home);
  s.put("widget/export", { ...newEntry({ prd: "docs/prds/export.md", harness: "claude", repo: "acme/widget", branch: "gallivant/export", worktree: "/w", pr: 7, state: STATES.prOpen, nowIso: T0 }) });
  s.put("api/export", { ...newEntry({ prd: "docs/prds/export.md", harness: "codex", repo: "acme/api", branch: "gallivant/export", worktree: "/w2", pr: 7, state: STATES.prOpen, nowIso: T0 }) });
  assert.equal(JSON.parse(readFileSync(join(home, "state.json"), "utf8")).entries["widget/export"].pr, 7);
  const entries = s.entries();
  assert.equal(resolveHandle(entries, "widget#7"), "widget/export");
  assert.equal(resolveHandle(entries, "acme/api#7"), "api/export");
  assert.equal(resolveHandle(entries, "api/export"), "api/export");
  assert.throws(() => resolveHandle(entries, "docs/prds/export.md"), /matches/);
  assert.throws(() => resolveHandle(entries, "7"), /ambiguous/);
  s.update("widget/export", { iteration: 2 });
  assert.equal(s.get("widget/export").iteration, 2);
});

test("the PR block round-trips and rejects anything malformed", () => {
  const block = { prd: "docs/prds/x.md", harness: "codex", session: "22222222-2222-4222-8222-222222222222", branch: "gallivant/x" };
  const body = upsertBlock("Adds x.", block);
  assert.deepEqual(parseBlock(body).block, block);
  assert.equal(parseBlock("nothing").reason, "no block");
  assert.match(parseBlock(renderBlock({ ...block, session: "../etc" })).reason, /invalid session/);
  assert.match(parseBlock(renderBlock({ ...block, branch: "main" })).reason, /invalid branch/);
  assert.match(parseBlock(renderBlock({ ...block, harness: "bash" })).reason, /invalid harness/);
  assert.equal(parseBlock(renderBlock({ ...block, session: null })).block.session, null);
  assert.match(parseBlock(renderBlock({ ...block, prd: "docs/../../etc/x.md" })).reason, /invalid prd/);
  const replaced = upsertBlock(body.replace("harness: codex", "harness: bash"), block);
  assert.equal((replaced.match(/<!-- gallivant/g) || []).length, 1, "an invalid block is replaced, not duplicated");
  assert.deepEqual(parseBlock(replaced).block, block);
});

test("quoted feedback cannot close its fence and is capped", () => {
  const q = quote("try this:\n````\nrm -rf /\n````\nthanks");
  const lines = q.split("\n");
  assert.equal(lines[0], "````");
  assert.equal(lines.at(-1), "````");
  assert.ok(!lines.slice(1, -1).some(l => /^`{4,}/.test(l)));
  assert.ok(quote("x".repeat(10_000)).length < 4100);
});

test("the fix prompt groups inline comments under their review and names checks without pasting logs", () => {
  const p = fixPrompt({ repo: "acme/widget", pr: 142, headSha: "a1b2c3d4", verify: ["npm test"], events: [
    { kind: "review", id: 2201, reviewId: 2201, author: "chatgpt-codex-connector", state: "CHANGES_REQUESTED", body: "two issues", at: T0 },
    { kind: "inline", id: 1, reviewId: 2201, author: "chatgpt-codex-connector", path: "src/a.ts", line: 8, body: "P1: nonce", at: T0 },
    { kind: "check", name: "test (node 22)", runId: "9981", at: T0 },
    { kind: "command", author: "me", body: "also bump the version", at: T0 },
  ] });
  assert.match(p, /review 2201\n {2}````\n {2}two issues/);
  assert.match(p, /- src\/a.ts:8\n {4}````\n {4}P1: nonce/);
  assert.match(p, /gh run view 9981 --repo acme\/widget --log-failed/);
  assert.match(p, /npm test/);
  assert.match(p, /Do not merge/);
  assert.doesNotMatch(p, /log-failed`.*\n.*Error:/);
});

test("harness argv: claude resumes with --settings and no dangerous flags; codex resumes with -c overrides", () => {
  const c = buildRun({ harness: "claude", config: CONFIG, mode: "resume", session: "s", prompt: "p", cwd: "/w" });
  assert.equal(c.cmd, "/bin/claude");
  assert.deepEqual(c.args.slice(0, 3), ["--resume", "s", "-p"]);
  assert.ok(c.args.includes("--permission-prompts") && c.args.includes("none"));
  assert.ok(c.args.includes("--settings") && c.args.includes(CONFIG.harness.claude.settings));
  assert.equal(c.env.APORT_CLAUDE_CODE_CONFIG_DIR, "/tmp/gallivant-test-home/claude");
  const x = buildRun({ harness: "codex", config: CONFIG, mode: "start", session: null, prompt: "p", cwd: "/w" });
  assert.deepEqual(x.args.slice(0, 2), ["exec", "--json"]);
  assert.ok(x.args.includes('sandbox_mode="workspace-write"'));
  for (const mode of ["start", "resume"]) {
    const run = buildRun({ harness: "codex", config: CONFIG, mode, session: "s", prompt: "p", cwd: "/w" });
    assert.ok(run.args.includes('approval_policy="on-request"'), `${mode}: Git metadata writes can request approval`);
    assert.ok(run.args.includes('approvals_reviewer="auto_review"'), `${mode}: no human approval prompt in a headless run`);
    assert.ok(run.args.includes('sandbox_mode="workspace-write"'), `${mode}: the sandbox remains enabled`);
    assert.ok(!run.args.includes('approval_policy="never"'));
  }
  assert.throws(() => assertSafeArgv(["--dangerously-skip-permissions"]), /refusing/);
  assert.throws(() => buildRun({ harness: "bash", config: CONFIG, mode: "start", prompt: "p" }), /unknown harness/);
});

test("harness argv: gemini, opencode and goose each carry the session id on resume", () => {
  const g = buildRun({ harness: "gemini", config: CONFIG, mode: "start", session: "u1", prompt: "p", cwd: "/w" });
  assert.deepEqual(g.args, ["--skip-trust", "--session-id", "u1", "--output-format", "stream-json", "-p", "p"]);
  assert.equal(g.env.GEMINI_CLI_TRUST_WORKSPACE, "true", "a daemon run must not be refused for an untrusted directory");
  // --resume takes the uuid, not an index; the help text's "latest or an index" is incomplete.
  assert.deepEqual(buildRun({ harness: "gemini", config: CONFIG, mode: "resume", session: "u1", prompt: "p" }).args.slice(0, 3), ["--skip-trust", "--resume", "u1"]);

  const o = buildRun({ harness: "opencode", config: CONFIG, mode: "start", session: null, prompt: "p", cwd: "/w" });
  assert.deepEqual(o.args, ["run", "--format", "json", "p"]);
  assert.deepEqual(buildRun({ harness: "opencode", config: CONFIG, mode: "resume", session: "ses_x", prompt: "p" }).args, ["run", "--session", "ses_x", "--format", "json", "p"]);

  // goose names a session with -n and resumes THAT one with -r plus the same -n. --session-id cannot create one.
  const s = buildRun({ harness: "goose", config: CONFIG, mode: "start", session: "gallivant-x", prompt: "p", cwd: "/w" });
  assert.deepEqual(s.args, ["run", "--name", "gallivant-x", "--output-format", "stream-json", "-t", "p"]);
  assert.deepEqual(buildRun({ harness: "goose", config: CONFIG, mode: "resume", session: "gallivant-x", prompt: "p" }).args.slice(0, 4), ["run", "--resume", "--name", "gallivant-x"]);
  assert.ok(!s.args.includes("--session-id"), "--session-id is resume-only and cannot name a new session");
  assert.equal(s.env.GOOSE_MODE, "smart_approve");
});

test("argv safety: every harness's own way of disabling permissions is refused", () => {
  // One case per harness, each the real flag that CLI accepts.
  assert.throws(() => assertSafeArgv(["-p", "--dangerously-skip-permissions"]), /refusing to run with --dangerously-skip-permissions/);
  assert.throws(() => assertSafeArgv(["exec", "--dangerously-bypass-approvals-and-sandbox"]), /refusing/);
  assert.throws(() => assertSafeArgv(["exec", "-c", 'sandbox_mode="danger-full-access"']), /refusing/);
  assert.throws(() => assertSafeArgv(["--yolo"]), /refusing to run with --yolo/);
  assert.throws(() => assertSafeArgv(["-y"]), /refusing to run with -y/);
  assert.throws(() => assertSafeArgv(["--approval-mode", "yolo"]), /refusing to run with --approval-mode yolo/);
  assert.throws(() => assertSafeArgv(["run", "--auto"]), /refusing to run with --auto/);
  // goose has no such flag at all; its permission mode is an env var, so the refusal has to live there too.
  assert.throws(() => assertSafeEnv({ GOOSE_MODE: "auto" }), /refusing to run with GOOSE_MODE=auto/);
  assert.deepEqual(assertSafeEnv({ GOOSE_MODE: "smart_approve" }), { GOOSE_MODE: "smart_approve" });
  // The approval mode gemini does want is not refused, and neither is codex's own override.
  assert.doesNotThrow(() => assertSafeArgv(["--approval-mode", "default", "-c", 'approval_policy="never"']));
  // Nothing the adapters actually build may trip the check.
  for (const h of ["claude", "codex", "gemini", "opencode", "goose"]) {
    assert.doesNotThrow(() => buildRun({ harness: h, config: CONFIG, mode: "resume", session: "s", prompt: "p", cwd: "/w" }), h);
  }
});

test("outcomes: gemini result status, opencode step_finish, goose chunked message events", () => {
  const g = adapters.gemini.outcome(geminiLines({ text: "Pushed." }));
  assert.deepEqual([g.ok, g.finished, g.lastMessage], [true, true, "Pushed."]);
  assert.equal(adapters.gemini.sessionFrom(geminiLines()), "f2abfca4-05e6-46a0-ab2c-e411ceb3ca07");
  assert.deepEqual([adapters.gemini.outcome(geminiLines({ ok: false })).ok, adapters.gemini.outcome(geminiLines({ ok: false })).error], [false, "quota exhausted"]);
  // A run killed before it printed a result is unfinished, not a silent success.
  assert.equal(adapters.gemini.outcome(['{"type":"init","session_id":"x"}']).finished, false);

  const o = adapters.opencode.outcome(opencodeLines({ cost: 0.0016, text: "Pushed." }));
  assert.deepEqual([o.ok, o.finished, o.cost, o.lastMessage], [true, true, 0.0016, "Pushed."]);
  assert.equal(adapters.opencode.sessionFrom(opencodeLines()), "ses_f25fcd907ffesl1i92jsR2lh9I");
  assert.equal(adapters.opencode.newSession(), null, "opencode ids are server-minted; the run reports one back");
  assert.match(adapters.opencode.outcome(opencodeLines({ ok: false })).error, /aborted/);

  // goose splits a reply across events, so the adapter joins them; taking the last one would read "ne.".
  const s = adapters.goose.outcome(gooseLines({ chunks: ["858", "5"] }));
  assert.deepEqual([s.ok, s.finished, s.lastMessage], [true, true, "8585"]);
  assert.equal(s.cost, 0.0036);
  assert.deepEqual([adapters.goose.outcome(gooseLines({ ok: false })).ok, adapters.goose.outcome(gooseLines({ ok: false })).error], [false, "provider refused"]);
  assert.equal(adapters.goose.outcome([]).finished, false);
  assert.match(adapters.goose.newSession(), /^gallivant-[0-9a-f-]{36}$/);
});

test("a harness whose id cannot be read back off the run must generate it up front", () => {
  // Two ways to learn a session id, and every adapter has to have exactly one of them. goose is the case that
  // makes this worth asserting: it never prints its session name into the JSONL, so newSession() generating the
  // name is the only reason a later resume can find the session. An adapter with neither would start a run the
  // daemon could never resume, and nothing else in the code would notice.
  for (const [name, a] of Object.entries(adapters)) {
    const generates = a.newSession() !== null;
    const reports = a.sessionFrom !== undefined && a.sessionFrom(codexLines()) !== undefined;
    assert.ok(generates || reports, `${name} can neither generate nor report a session id`);
  }
  assert.equal(adapters.goose.sessionFrom(gooseLines()), null, "goose does not report its name back");
  assert.match(adapters.goose.newSession(), /^gallivant-/, "so it has to generate one it can resume by");
  assert.equal(adapters.opencode.newSession(), null, "opencode cannot pre-assign, so it must report one back");
  assert.ok(adapters.opencode.sessionFrom(opencodeLines()));
});

/**
 * The version of an installed harness, read the same way `probe.mjs` reads it, or null when the binary will not say.
 * Used to skip the flag checks below rather than fail them: the adapter's flags are promised from `MIN_VERSIONS`
 * onward, so an older build on the PATH is out of contract and proves nothing about the adapter.
 */
function installedVersion(harness, bin) {
  const spec = adapters[harness].version;
  const r = spawnSync(bin, spec.args, { encoding: "utf8", timeout: 60_000 });
  if (r.error || r.status !== 0) return null;
  return spec.parse(`${r.stdout || ""}${r.stderr || ""}`) ?? null;
}

// Checks the argv against the real CLIs rather than against our own assumption, so a flag renamed upstream fails
// here instead of in production. `--help` is free and makes no model call. opencode prints its help to stderr, so both
// streams are read; reading only stdout silently passes on empty text.
//
// Skipped, with the reason named, on any machine that cannot answer the question: no binary installed, or one older
// than `MIN_VERSIONS` says the adapter supports. That second skip is the one that matters. The test used to run
// against whatever `gemini` happened to be first on the PATH, and a Homebrew gemini 0.28.2 sitting in
// /usr/local/bin ahead of an nvm-installed 0.59 failed on `--skip-trust`, a flag that version does not have and is
// not expected to. `probe.mjs` refuses to run a harness below `MIN_VERSIONS`, so a build the daemon would refuse must
// not be what decides whether this suite passes. It is a skip and never a silent pass: the reason says which version
// was found and what was wanted, so nobody reads the skip as a green light.
for (const [harness, argv, flags] of [
  ["gemini", ["--help"], ["--skip-trust", "--session-id", "--resume", "--output-format"]],
  ["opencode", ["run", "--help"], ["--session", "--format"]],
  ["goose", ["run", "--help"], ["--name", "--resume", "--output-format"]],
]) {
  const bin = whence(harness);
  const version = bin ? installedVersion(harness, bin) : null;
  const tooOld = version !== null && compareVersions(version, MIN_VERSIONS[harness]) < 0;
  const skip = !bin ? `${harness} is not installed`
    : version === null ? `${bin} would not report a version`
    : tooOld ? `${bin} is ${version}, older than the ${MIN_VERSIONS[harness]} this adapter supports`
    : false;
  test(`${harness} still accepts the flags the adapter passes`, { skip }, () => {
    const r = spawnSync(bin, argv, { encoding: "utf8", timeout: 60_000 });
    const help = `${r.stdout || ""}${r.stderr || ""}`;
    assert.ok(help.length > 200, `${harness} --help printed nothing to read`);
    for (const f of flags) assert.ok(help.includes(f), `${harness} ${version}: --help no longer mentions ${f}`);
  });
}

test("outcomes: claude result event and codex turn events", () => {
  const ok = adapters.claude.outcome(claudeResultLines({ cost: 0.7, text: "Pushed." }));
  assert.deepEqual([ok.ok, ok.finished, ok.cost, ok.lastMessage], [true, true, 0.7, "Pushed."]);
  assert.equal(adapters.claude.sessionFrom(claudeResultLines()), "6f1c2d3e-1111-4111-8111-111111111111");
  assert.equal(adapters.claude.outcome(["{}"]).finished, false);
  const bad = adapters.codex.outcome(codexLines({ ok: false }));
  assert.deepEqual([bad.ok, bad.error], [false, "boom"]);
  assert.equal(adapters.codex.sessionFrom(codexLines()), "22222222-2222-4222-8222-222222222222");
  assert.ok(compareVersions("2.1.263", "2.1.257") > 0 && compareVersions("0.155.1", "0.155.1") === 0);
});

test("the start prompt carries the branch, base and Verify commands", () => {
  const prd = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
  assert.deepEqual([prd.id, prd.status, prd.harness, prd.title], ["widget-export", "ready", "codex", "Widget export to CSV"]);
  assert.deepEqual(verifyCommands(prd), ["npm run lint", "npm test"]);
  const sp = startPrompt({ prd, repo: "acme/widget", branch: "gallivant/widget-export", base: "main", verify: verifyCommands(prd) });
  assert.match(sp, /gh pr create --base main --head gallivant\/widget-export/);
  assert.match(sp, /npm run lint/);
});

test("config validation names every problem and accepts the fixture", () => {
  assert.deepEqual(validate(CONFIG), []);
  const bad = validate({ ...DEFAULTS, trusted_authors: [], worktrees: "~/.gallivant/wt", harness: { bash: { bin: "/x" } }, reviewer: { login: "x" } });
  assert.ok(bad.some(p => /trusted_authors/.test(p)));
  assert.ok(bad.some(p => /Gallivant home/.test(p)));
  assert.ok(bad.some(p => /not a known harness/.test(p)));
  assert.ok(bad.some(p => /reviewer.rereview_comment/.test(p)));
});

test("notification text carries repo#pr, the round and nothing from the diff", () => {
  const entry = { repo: "acme/widget", pr: 142, iteration: 2, url: "https://github.com/acme/widget/pull/142", reason: "conflict" };
  const r = messages.ready({ entry, max: 3, checks: 3, reviewerNote: "no blocking findings" });
  assert.deepEqual([r.title, r.body, r.click], ["widget#142 ready for a human", "Round 2/3. Reviewer: no blocking findings. Checks green (3).", entry.url]);
  const n = messages.needs({ entry, max: 3, handle: "widget#142" });
  assert.deepEqual([n.title, n.body, n.priority], ["widget#142 needs you: conflict", "Stopped in round 2/3. gallivant why widget#142", "high"]);
});

test("registry ids are pure functions of repo and PRD, and every path keyed by them agrees", () => {
  assert.equal(entryId("Acme/Widget", "export"), "acme/widget/export");
  assert.equal(idSlug("acme/widget/export"), "acme__widget__export");
  assert.equal(prdIdOf("acme/widget/export"), "export");
  assert.equal(branchFor("export"), "gallivant/export");
  assert.equal(prdIdFromBranch("gallivant/export"), "export");
  assert.equal(prdIdFromBranch("feature/x"), null);
  assert.ok(isOurBranch("gallivant/x") && !isOurBranch("main"));
});

test("registry writes hold a lock; a stale lock is broken, a fresh one blocks", () => {
  const home = tempHome();
  const s = makeState(home);
  const lock = join(home, "state.json.lock");
  writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  s.put("a/b/c", { pr: 1 });
  assert.ok(!existsSync(lock), "a lock older than thirty seconds is stale and removed");
  assert.equal(s.get("a/b/c").pr, 1);
});

test("a run whose binary does not exist is recorded as exit 127, not thrown into the daemon", async () => {
  const root = join(tempHome(), "runs");
  const r = makeRunner(root, { probe: () => false });
  const job = r.start("x", "/nonexistent/gallivant-bin", [], { cwd: tempHome() });
  for (let i = 0; i < 50 && r.read(job.id)?.exit === null; i++) await new Promise(res => setTimeout(res, 20));
  const done = r.read(job.id);
  assert.equal(done.exit, 127);
  assert.match(done.error, /ENOENT/);
  assert.equal(r.current().running, false);
});

test("liveness asks whether the pid still runs the harness, so a reused pid is not mistaken for our run", () => {
  assert.equal(isOurProcess(process.pid, process.execPath), true);
  // The negative case needs a basename that cannot appear in THIS process's `ps` line for any reason. `/bin/claude`
  // was the old spelling and it is not safe: `isOurProcess` matches on `basename(cmd)` as a substring of the whole
  // command, and the command includes every argv element, so a checkout, a HOME, a node --import or a runner root
  // whose path contains "claude" made this assertion fail. It is the shape the whole suite was audited for: a test
  // that passes on the machine it was written on. A random name cannot collide with anything.
  const impossible = `/opt/harness-${Math.random().toString(36).slice(2)}-${process.pid}`;
  assert.ok(!execFileSync("ps", ["-o", "command=", "-p", String(process.pid)], { encoding: "utf8" }).includes(basename(impossible)),
    "the control name really is absent from this process's own command line");
  assert.equal(isOurProcess(process.pid, impossible), false);
  assert.equal(isOurProcess(2 ** 22 - 1, process.execPath), false);
});

test("PRD helpers: fences of either kind, frontmatter rewritten from the parsed block, HTML is not a placeholder", () => {
  assert.deepEqual(fencedBlocks("~~~sh\nnpm test\n~~~\n```\nx\n```"), ["npm test", "x"]);
  const withFence = "---\nstatus: draft\n---\n# T\n\n```sh\nnpm test\n```";
  const flipped = withFrontmatterKey(withFence, "status", "ready");
  assert.ok(flipped.startsWith("---\nstatus: ready\n---\n# T"));
  assert.ok(flipped.endsWith("```sh\nnpm test\n```"), "a closing fence at the end of the file is not mistaken for the frontmatter end");
  assert.equal(withFrontmatterKey("---\nstatus: ready\n---\nbody", "aport_decision", "d1"), "---\nstatus: ready\naport_decision: d1\n---\nbody");
  assert.equal(findPlaceholder("Line one<br>\n<details><summary>x</summary>ok</details>"), null);
  assert.equal(findPlaceholder("As a <who>, I want"), "<who>");
  assert.equal(findPlaceholder("see <your repo>"), "<your repo>");
});

test("a remote URL is parsed into owner/repo and compared exactly, so a fork suffix is not the same repo", () => {
  // The bug this replaced: `origin.includes(nameWithOwner)` accepted any repo whose name merely contained ours.
  assert.equal(repoFromRemote("https://github.com/acme/widget-fork.git"), "acme/widget-fork");
  assert.equal(remoteMatches("https://github.com/acme/widget-fork.git", "acme/widget"), false);
  assert.equal(remoteMatches("https://github.com/widget/acme.git", "acme/widget"), false);
  assert.equal(remoteMatches("https://github.com/other/acme-widget.git", "acme/widget"), false);

  for (const url of [
    "https://github.com/acme/widget",
    "https://github.com/acme/widget.git",
    "https://github.com/acme/widget/",
    "https://x-access-token:tok@github.com/acme/widget.git",
    "git@github.com:acme/widget",
    "git@github.com:acme/widget.git",
    "ssh://git@github.com/acme/widget",
    "ssh://git@github.com/acme/widget.git",
  ]) assert.equal(repoFromRemote(url), "acme/widget", url);

  // GitHub treats owner and name case-insensitively, so the comparison does too.
  assert.equal(remoteMatches("https://github.com/Acme/Widget.git", "acme/widget"), true);
  // A repository whose name ends in .git is not confused with the suffix, and a dot is not a name.
  assert.equal(repoFromRemote("https://github.com/acme/widget.js.git"), "acme/widget.js");
  assert.equal(repoFromRemote("git@github.com:acme/.git"), null);
  // Anything that is not a GitHub remote we understand.
  for (const url of ["https://gitlab.com/acme/widget.git", "/srv/checkouts/widget", "", null]) assert.equal(repoFromRemote(url), null);
});

test("fromBranch reuses an existing checkout only when origin is exactly the repo, never a repo whose name contains it", async () => {
  const home = tempHome();
  const path = join(home, "wt");
  mkdirSync(join(path, ".git"), { recursive: true });
  const config = { ...CONFIG, home, worktrees: home };
  // A fake `git` whose `remote get-url origin` answers whatever the case under test sets.
  const gitWith = origin => {
    const ran = [];
    const exec = async (cmd, args) => {
      ran.push([cmd, ...args]);
      return { stdout: cmd === "git" && args[0] === "remote" ? `${origin}\n` : "", stderr: "" };
    };
    return { git: makeGit({ config, exec }), ran };
  };

  const fork = gitWith("https://github.com/acme/widget-fork.git");
  await assert.rejects(
    () => fork.git.fromBranch({ nameWithOwner: "acme/widget", prdId: "export", branch: "gallivant/export", path }),
    /is a clone of https:\/\/github\.com\/acme\/widget-fork\.git, not acme\/widget/,
  );
  assert.ok(!fork.ran.some(c => c[1] === "checkout"), "a checkout that failed the check is never touched");

  const same = gitWith("git@github.com:Acme/Widget.git");
  assert.equal(await same.git.fromBranch({ nameWithOwner: "acme/widget", prdId: "export", branch: "gallivant/export", path }), path);
  assert.deepEqual(same.ran.at(-1), ["git", "checkout", "gallivant/export"]);
});

test("the cursor carries the keys handled at its own second, and drops them the moment it moves", () => {
  const base = { since: "2026-09-24T02:00:05.000Z", dispatched: ["review:1"], fixed_sha: "a1b2c3d", checks_sha: "a1b2c3d" };
  // Same second, spelled differently: the list is kept and added to, never duplicated.
  const same = advanceCursor(base, "2026-09-24T02:00:05Z", ["review:2", "review:1"]);
  assert.deepEqual(same.dispatched.sort(), ["review:1", "review:2"]);
  assert.equal(same.fixed_sha, "a1b2c3d", "the rest of the cursor is carried through");
  // A different second: only the new keys, so one busy PR cannot grow the registry without bound.
  assert.deepEqual(advanceCursor(base, "2026-09-24T02:00:06.000Z", ["review:3"]).dispatched, ["review:3"]);
  assert.deepEqual(advanceCursor(base, "2026-09-24T02:00:06.000Z").dispatched, []);
  // A cursor written before this field existed reads as an empty list, not a crash.
  assert.deepEqual(advanceCursor({ since: "2026-09-24T02:00:05.000Z" }, "2026-09-24T02:00:05.000Z", ["review:9"]).dispatched, ["review:9"]);
});

test("the boundary comparison includes the boundary, and an instant floors to its second", () => {
  assert.ok(isAtOrAfter("2026-09-24T02:00:05.000Z", "2026-09-24T02:00:05.000Z"));
  assert.ok(!isAtOrAfter("2026-09-24T02:00:04.999Z", "2026-09-24T02:00:05.000Z"));
  assert.ok(isAtOrAfter("2026-09-24T02:00:05.000Z", null), "no cursor means everything is new");
  assert.ok(!isAtOrAfter(null, "2026-09-24T02:00:05.000Z"));
  assert.equal(floorSecond("2026-09-24T02:00:05.937Z"), "2026-09-24T02:00:05.000Z");
  assert.equal(floorSecond(null), null);
});

test("a harness is discovered when none is configured, and naming one turns discovery off", () => {
  // Whichever of the two the operator happens to have installed should be enough; nobody should have to write a
  // path by hand for a binary already on their PATH.
  const home = "/tmp/gallivant-discovery-home";
  const discovered = discoverHarnesses(home);
  for (const name of Object.keys(discovered)) {
    assert.ok(discovered[name].bin.startsWith("/"), `${name} resolves to an absolute path`);
    if (name === "claude") assert.equal(discovered[name].settings, join(home, "claude", "settings.json"));
  }
  // A nested block keeps the defaults for keys the operator's file does not name. The bug this pins cost an operator
  // every command: `merge` spread `raw` over `DEFAULTS`, which replaces a nested object wholesale, so a key the config
  // file did not name was gone rather than defaulted. Latent until a key was ADDED, because configs written before
  // `reviewed_commit_pattern` existed had no value for it, `validate` then refused the file, and every command died at
  // config load. What the operator saw was `gallivant resume` printing nothing at all.
  const partial = merge({ trusted_authors: ["me"], worktrees: "/tmp/wt", reviewer: { login: "my-bot[bot]" } }, home);
  assert.equal(partial.reviewer.login, "my-bot[bot]", "what they named wins");
  assert.equal(partial.reviewer.rereview_comment, DEFAULTS.reviewer.rereview_comment, "what they did not name defaults");
  assert.equal(partial.reviewer.reviewed_commit_pattern, DEFAULTS.reviewer.reviewed_commit_pattern);
  assert.deepEqual(validate(partial, home).filter(p => /reviewer\./.test(p)), [], "and the merged block is valid");
  // `null` is the documented way to say there is no reviewer; a deep merge must not hand back one that was switched off.
  assert.equal(merge({ trusted_authors: ["me"], worktrees: "/tmp/wt", reviewer: null }, home).reviewer, null);

  // An empty harness object means "discover"; a named one is taken as written, even when the other is installed.
  const auto = merge({ trusted_authors: ["me"], worktrees: "/tmp/wt" }, home);
  assert.deepEqual(Object.keys(auto.harness), Object.keys(discovered));
  const explicit = merge({ trusted_authors: ["me"], worktrees: "/tmp/wt", harness: { codex: { bin: "/opt/codex" } } }, home);
  assert.deepEqual(Object.keys(explicit.harness), ["codex"], "an explicit harness is not merged with discovery");
  assert.equal(explicit.harness.codex.bin, "/opt/codex");
});

test("one harness is a complete install; none at all names the fix", () => {
  const base = { poll_seconds: 120, max_iterations: 3, checks_grace_minutes: 5, run_timeout_minutes: 30, max_budget_usd: 5,
    rereview_minutes: 6, stall_hours: 6, trusted_authors: ["me"], reviewer: null, notify: null,
    deliverable: DEFAULTS.deliverable, worktrees: "/tmp/wt", github_token_file: null, repos: [] };
  assert.deepEqual(validate({ ...base, harness: { claude: { bin: "/bin/claude", settings: "/s.json" } } }, "/tmp/h"), []);
  assert.deepEqual(validate({ ...base, harness: { codex: { bin: "/bin/codex" } } }, "/tmp/h"), []);
  const none = validate({ ...base, harness: {} }, "/tmp/h");
  assert.match(none[0], /no harness configured and none found/);
  assert.match(none[0], /set harness.<name>.bin explicitly/, "the message says what to do, not just what is wrong");
  assert.match(none[0], /claude, codex, gemini, opencode, goose/, "and which binaries it looked for");
});

test("context_paths: a real directory is accepted, a missing or relative one is named", () => {
  const home = tempHome();
  const good = tempHome();
  assert.deepEqual(validateContextPaths([good], home), []);
  assert.deepEqual(validateContextPaths([], home), [], "an empty list is not a problem");
  assert.deepEqual(validateContextPaths(undefined, home), [], "an absent list is not a problem either");
  const missing = validateContextPaths([join(good, "no-such-dir")], home);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /does not exist/);
  assert.match(missing[0], /no-such-dir/, "the message names the path the operator wrote");
  // A file is not a directory, and neither is a blank entry.
  writeFileSync(join(good, "a-file"), "x");
  assert.match(validateContextPaths([join(good, "a-file")], home)[0], /does not exist/);
  assert.match(validateContextPaths([""], home)[0], /non-empty strings/);
  assert.match(validateContextPaths("not-an-array", home)[0], /must be an array/);
  // `./docs` expands to an absolute path under the process cwd, so the check has to run on the raw entry.
  assert.match(validateContextPaths(["../siblings"], home)[0], /not an absolute path/);
});

test("context_paths: every directory that would defeat the guardrails is refused by name", () => {
  const home = tempHome();
  // The Gallivant home itself, and any parent of it: reading either reaches the settings file and the registry.
  assert.match(validateContextPaths([home], home)[0], /contains the Gallivant home/);
  assert.match(validateContextPaths([dirname(home)], home)[0], /contains the Gallivant home/);
  for (const [dir, label] of [["~/.claude", /~\/\.claude/], ["~/.codex", /~\/\.codex/], ["~/.aport", /~\/\.aport/], ["~/.config/opencode", /opencode/]]) {
    const problems = validateContextPaths([dir], home);
    assert.equal(problems.length, 1, dir);
    assert.match(problems[0], label, dir);
    assert.match(problems[0], /settings and passport that bound the run/, dir);
  }
  // The home directory itself is refused on its own terms: it is every credential on the machine, not one project.
  const atHome = validateContextPaths(["~"], home);
  assert.equal(atHome.length, 1);
  assert.match(atHome[0], /your home directory/);
  // And `~` is refused even when the Gallivant home lives elsewhere, so the check is not a side effect of the first.
  assert.match(validateContextPaths(["~"], "/tmp/elsewhere-gallivant")[0], /your home directory/);
  // A real project directory under the home is fine; only the home itself is too much.
  assert.deepEqual(validateContextPaths([tempHome()], home), []);
});

test("context_paths: validate() reports a bad list alongside every other config problem", () => {
  const bad = validate({ ...CONFIG, context_paths: ["/definitely/not/here"] }, CONFIG.home);
  assert.equal(bad.length, 1);
  assert.match(bad[0], /context_paths: "\/definitely\/not\/here" does not exist/);
});

test("context_paths render as the flag each harness actually has, and an empty list renders nothing", () => {
  const dirs = ["/srv/design-docs", "/srv/sibling-repo"];
  // Claude: --add-dir per directory, ahead of everything, with writes still bounded by the sandbox in --settings.
  // Not immediately before the prompt: --add-dir is variadic, so it would read the prompt as another directory and
  // the run would die with "Input must be provided either through stdin or as a prompt argument".
  const c = buildRun({ harness: "claude", config: CONFIG, mode: "start", session: "s", prompt: "p", cwd: "/w", contextPaths: dirs });
  assert.deepEqual(c.args.slice(0, 4), ["--add-dir", "/srv/design-docs", "--add-dir", "/srv/sibling-repo"]);
  assert.equal(c.args.at(-1), "p", "the prompt stays last");
  assert.ok(c.args.includes("--settings"), "the sandbox that bounds writes is still passed");
  // The empty case is byte-identical to a run built before this setting existed.
  assert.deepEqual(buildRun({ harness: "claude", config: CONFIG, mode: "start", session: "s", prompt: "p", cwd: "/w", contextPaths: [] }).args,
    buildRun({ harness: "claude", config: CONFIG, mode: "start", session: "s", prompt: "p", cwd: "/w" }).args);
  for (const h of ["claude", "codex", "gemini", "opencode", "goose"]) {
    const plain = buildRun({ harness: h, config: CONFIG, mode: "resume", session: "s", prompt: "p", cwd: "/w" });
    assert.deepEqual(buildRun({ harness: h, config: CONFIG, mode: "resume", session: "s", prompt: "p", cwd: "/w", contextPaths: [] }).args, plain.args, h);
  }
});

test("a harness that cannot grant read on one directory refuses; one with no flag ignores the list", () => {
  const dirs = ["/srv/design-docs"];
  // Codex: --add-dir is WRITABLE and disk-full-read-access is the whole disk, so neither is a read grant on a path.
  assert.throws(() => buildRun({ harness: "codex", config: CONFIG, mode: "start", session: null, prompt: "p", cwd: "/w", contextPaths: dirs }),
    /refusing to run codex with context_paths/);
  assert.throws(() => buildRun({ harness: "codex", config: CONFIG, mode: "start", session: null, prompt: "p", cwd: "/w", contextPaths: dirs }),
    /disk-full-read-access/, "the refusal says what codex would have had to grant instead");
  // Gemini: --include-directories adds to the workspace, which is its write boundary too.
  assert.throws(() => buildRun({ harness: "gemini", config: CONFIG, mode: "start", session: "u1", prompt: "p", cwd: "/w", contextPaths: dirs }),
    /refusing to run gemini with context_paths/);
  // Neither escalates instead of refusing.
  for (const h of ["codex", "gemini"]) {
    assert.equal(contextSupport(h).kind, "refuse", h);
    try { buildRun({ harness: h, config: CONFIG, mode: "start", session: "s", prompt: "p", cwd: "/w", contextPaths: dirs }); assert.fail(`${h} should refuse`); }
    catch (e) { assert.doesNotMatch(e.message, /disk-full-read-access"\]/, "the refusal is not the escalated argv"); }
  }
  // opencode and goose have no directory flag: the run proceeds unchanged rather than failing over a setting they
  // cannot honour. `doctor` is where the operator is told it had no effect.
  for (const h of ["opencode", "goose"]) {
    const with_ = buildRun({ harness: h, config: CONFIG, mode: "start", session: "gallivant-x", prompt: "p", cwd: "/w", contextPaths: dirs });
    const without = buildRun({ harness: h, config: CONFIG, mode: "start", session: "gallivant-x", prompt: "p", cwd: "/w" });
    assert.deepEqual(with_.args, without.args, h);
    assert.ok(!with_.args.some(a => String(a).includes("/srv/design-docs")), `${h} argv must not carry a path it cannot honour`);
    assert.equal(contextSupport(h).kind, "none", h);
  }
  assert.equal(contextSupport("claude").kind, "grant");
});

test("a PRD's own context_paths add to the config list and are held to the same rules", () => {
  const home = tempHome();
  const fromConfig = tempHome();
  const fromPrd = tempHome();
  const cfg = { ...CONFIG, home, context_paths: [fromConfig] };
  // Merged, not replaced: the brief's directory is added to the operator's list.
  const prd = parsePrd(`---\nstatus: ready\nharness: claude\ncontext_paths: ${fromPrd}\n---\n\n# A brief\n`, "docs/prds/a-brief.md");
  assert.deepEqual(resolveContextPaths(cfg, prd), [fromConfig, fromPrd]);
  // A list form and a comma-separated form both parse; a duplicate is not passed twice.
  assert.deepEqual(parseContextPathsMeta(`[${fromPrd}, ${fromConfig}]`), [fromPrd, fromConfig]);
  assert.deepEqual(resolveContextPaths(cfg, parsePrd(`---\ncontext_paths: ${fromConfig}\n---\n# x\n`, "docs/prds/x.md")), [fromConfig]);
  // No frontmatter key, or no PRD at all, leaves the config list exactly as it was.
  assert.deepEqual(resolveContextPaths(cfg, parsePrd("---\nstatus: ready\n---\n# x\n", "docs/prds/x.md")), [fromConfig]);
  assert.deepEqual(resolveContextPaths(cfg, null), [fromConfig]);
  assert.deepEqual(resolveContextPaths({ ...CONFIG, context_paths: undefined }, null), []);
  // A PRD cannot widen past what the config file itself is refused for: same validator, same refusals.
  for (const attempt of ["~", "~/.claude", home]) {
    const problems = validateContextPaths(parseContextPathsMeta(attempt), home, "a-brief frontmatter context_paths");
    assert.equal(problems.length, 1, attempt);
    assert.match(problems[0], /a-brief frontmatter context_paths/, "the message names the PRD, not the config file");
  }
  // And a refused entry never reaches an adapter. An entry recovered from GitHub by `up` did not pass through
  // `start`, and a directory that existed at start may be gone by the third fix round, so the merge drops it.
  for (const attempt of ["~", "~/.claude", home, "/definitely/not/here", "../relative"]) {
    const widened = parsePrd(`---\nharness: claude\ncontext_paths: ${attempt}\n---\n# x\n`, "docs/prds/x.md");
    assert.deepEqual(resolveContextPaths(cfg, widened), [fromConfig], attempt);
  }
});

test("prDiff reports a failure instead of returning nothing, so the output scan cannot mistake it for a clean diff", async () => {
  // `addedLines(null)` is "", and an empty string contains no blocked pattern, so a swallowed failure read as a pass.
  const failing = makeGh({ exec: async () => { throw new Error("gh pr diff: HTTP 502"); } });
  await assert.rejects(() => failing.prDiff("acme/widget", 142), /HTTP 502/);

  const working = makeGh({ exec: async () => ({ stdout: "+const x = 1;\n" }) });
  assert.equal(await working.prDiff("acme/widget", 142), "+const x = 1;\n");

  // The same fail-open one step further on: a diff over the cap used to be sliced, and the first megabyte handed to
  // the scan as though it were the whole thing, so a blocked pattern past the cutoff was never looked at. The cap
  // stays, because a diff of any size in memory is its own problem; what it produces is a refusal to decide.
  const capped = makeGh({ exec: async () => ({ stdout: "a".repeat(MAX_DIFF_BYTES) + "\n+TODO after the cutoff\n" }) });
  await assert.rejects(() => capped.prDiff("acme/widget", 142), /at or over the \d+-byte scan cap/);
  // Exactly at the cap counts as truncated: a diff of that length is indistinguishable from one the cap cut short.
  const exact = makeGh({ exec: async () => ({ stdout: "a".repeat(MAX_DIFF_BYTES) }) });
  await assert.rejects(() => exact.prDiff("acme/widget", 142), /incomplete output scan/);
  const under = makeGh({ exec: async () => ({ stdout: "a".repeat(MAX_DIFF_BYTES - 1) }) });
  assert.equal((await under.prDiff("acme/widget", 142)).length, MAX_DIFF_BYTES - 1, "a diff that fits is returned whole");
  const large = "+" + "x".repeat(5_030_593) + "\n+TODO at the end\n";
  assert.equal(await makeGh({ exec: async () => ({ stdout: large }) }).prDiff("acme/widget", 142), large, "the full real-world size is read, including its tail");
  const unicode = makeGh({ exec: async () => ({ stdout: "é".repeat(MAX_DIFF_BYTES / 2) }) });
  await assert.rejects(() => unicode.prDiff("acme/widget", 142), /scan cap/, "the cap measures bytes, not characters");
});

test("removeLabel is strict by omission: only gh's own absent-label message is swallowed", async () => {
  // `strict` used to be opt-in, so the DANGEROUS behaviour was what a caller got by forgetting the option, and two
  // callers of this one write disagreed: `writeStopLabels` passed `{ strict: true }` and `reopen` passed nothing. So
  // a 403 or a 502 on the ready-label removal resolved as if the label had merely been absent, the dispatch went
  // ahead with `gallivant:ready-for-human` still on the PR, and `retryFailed` never saw a failure to count.
  const forbidden = makeGh({ exec: async () => { throw new Error("gh pr edit: HTTP 403: Resource not accessible by personal access token"); } });
  await assert.rejects(() => forbidden.removeLabel("acme/widget", 142, READY_LABEL), /HTTP 403/,
    "a write GitHub refused throws with no option passed at all");
  await assert.rejects(() => forbidden.removeLabel("acme/widget", 142, READY_LABEL, {}), /HTTP 403/,
    "and an empty options object is the same as none");

  // The one case that is not a failure: the label was not on the PR, which is the ordinary result of removing a
  // label from a PR that never had it, and every caller does that unconditionally on purpose.
  for (const msg of ["gh pr edit: failed to remove label: 'gallivant:ready-for-human' not found", "does not have this label", "no label named that"]) {
    const absent = makeGh({ exec: async () => { throw new Error(msg) } });
    assert.equal(await absent.removeLabel("acme/widget", 142, READY_LABEL), undefined, `absent label is not a failure: ${msg}`);
  }

  // The lenient half still exists, but it has to be asked for by name, so no future caller gets it by omission.
  const lenient = makeGh({ exec: async () => { throw new Error("HTTP 502: bad gateway"); } });
  assert.equal(await lenient.removeLabel("acme/widget", 142, READY_LABEL, { lenient: true }), undefined);
  // And a removal that lands is still a removal.
  const ok = makeGh({ exec: async () => ({ stdout: "" }) });
  assert.equal(await ok.removeLabel("acme/widget", 142, READY_LABEL), "");
});

test("every harness's own session id round-trips through the block, and a malformed one is still refused", () => {
  // The block is the identity of record: `reconcile` rebuilds an entry from it after state.json is lost, and a block
  // it will not read back means the PR is ignored with nothing to show for it. A single UUID regex in block.mjs was
  // refusing goose's `gallivant-<uuid>` and opencode's `ses_...`, both of which block.mjs had itself just written.
  const real = {
    claude: "6f1c2d3e-1111-4111-8111-111111111111",
    codex: "22222222-2222-4222-8222-222222222222",
    gemini: "f2abfca4-05e6-46a0-ab2c-e411ceb3ca07",
    opencode: "ses_f25fcd907ffesl1i92jsR2lh9I",
    goose: "gallivant-068021d7-3490-4f2e-a6f1-30e1c00498c9",
  };
  assert.deepEqual(Object.keys(real), HARNESSES, "every adapter has a real id here, and the list comes from the adapters");
  for (const [harness, session] of Object.entries(real)) {
    const block = { prd: "docs/prds/widget-export.md", harness, session, branch: "gallivant/widget-export" };
    const parsed = parseBlock(upsertBlock("Adds export.", block));
    assert.deepEqual(parsed.block, block, `${harness}: the id the adapter mints is the id the block reads back`);
    // A generated id, not just the captured one, so a change to `newSession` cannot drift from `isSession`.
    const minted = adapters[harness].newSession();
    if (minted) assert.deepEqual(parseBlock(upsertBlock("x", { ...block, session: minted })).block?.session, minted, `${harness}: a freshly minted id parses`);
  }
  // The shapes are per harness, not one union: opencode's id is not a goose id and neither is a claude UUID.
  assert.match(parseBlock(renderBlock({ prd: "docs/prds/x.md", harness: "claude", session: real.opencode, branch: "gallivant/x" })).reason, /invalid session/);
  assert.match(parseBlock(renderBlock({ prd: "docs/prds/x.md", harness: "goose", session: real.claude, branch: "gallivant/x" })).reason, /invalid session/);
  // And path traversal is still refused for every harness, which is what the rule was guarding in the first place.
  for (const harness of HARNESSES) {
    for (const bad of ["../etc", "gallivant-../x", "ses_../x", "gallivant-a/b", "", "x".repeat(200)]) {
      assert.equal(parseBlock(renderBlock({ prd: "docs/prds/x.md", harness, session: bad, branch: "gallivant/x" })).block, null, `${harness} must refuse ${JSON.stringify(bad)}`);
    }
  }
});

test("a handle degrades rather than saying undefined or throwing when the repo is not owner/name", () => {
  // `shortRepo` was `repo.split("/")[1]`. The ntfy title read `undefined#3` and told the operator to run
  // `gallivant why undefined#3`; with no repo at all it threw inside `needsHuman`, after the labels were written and
  // before the notification, where the tick's per-entry catch swallowed it and a stopped PR notified nobody.
  assert.equal(shortRepo("acme/widget"), "widget");
  assert.equal(shortRepo("widget"), "widget", "a bare name is its own short name, not undefined");
  assert.equal(shortRepo(undefined), "");
  assert.equal(shortRepo(null), "");
  assert.equal(handleFor("acme/widget/x", { repo: "acme/widget", pr: 3 }), "widget#3");
  assert.equal(handleFor("acme/widget/x", { repo: "widget", pr: 3 }), "widget#3");
  assert.equal(handleFor("acme/widget/x", { repo: undefined, pr: 3 }), "#3", "no owner, no name, still no throw");
  assert.equal(handleFor("acme/widget/x", { repo: "acme/widget", pr: null }), "acme/widget/x", "no PR means the registry id");
  // The messages that carry it, which is where the operator actually saw the bug.
  assert.match(messages.needs({ entry: { repo: "widget", pr: 3, reason: "conflict", iteration: 1 }, max: 3, handle: "widget#3" }).title, /^widget#3 needs you/);
  assert.match(messages.ready({ entry: { repo: "widget", pr: 3, iteration: 1 }, max: 3, checks: 1, reviewerNote: "clear" }).title, /^widget#3 ready/);
});

test("each harness's sign-in fix is its own command, not another harness's", () => {
  // doctor was `h === "claude" ? "claude auth login" : "codex login"` in a loop over every configured harness, so
  // gemini, opencode and goose operators were told to run codex login.
  const fixes = HARNESSES.map(h => signInFix(h));
  assert.equal(new Set(fixes).size, HARNESSES.length, `each harness gets its own instruction (got ${fixes})`);
  assert.equal(signInFix("claude"), "claude auth login");
  assert.equal(signInFix("codex"), "codex login");
  for (const h of HARNESSES) assert.match(signInFix(h), new RegExp(h.replace("opencode", "opencode|OPENCODE"), "i"), `${h}'s fix names ${h}`);
  assert.match(probeFix("gh"), /gh auth login/, "gh is not a harness and keeps its own line");
  assert.match(signInFix("nonesuch"), /gallivant doctor/, "an unknown probe key never produces undefined");
});

test("merge builds discovered harness paths under the home it was given, which doctor now passes", () => {
  // `doctor` called `merge(raw)`, which defaults to `gallivantHome()`, so with no explicit `harness` key discovery
  // put claude's settings under the real home while every check below read the home doctor was given. Today
  // `validate` only type-checks that path, so the verdict came out the same and nothing observable was wrong. It is
  // still the wrong object: any rule that reads the value, and `doctor --probe` which runs against it, would report
  // on a directory the operator is not looking at. `load` in config.mjs always passed `home`; doctor did not.
  const home = tempHome();
  const discovered = discoverHarnesses(home);
  const merged = merge({ trusted_authors: ["me"] }, home);
  assert.deepEqual(merged.harness, discovered, "the harness block is discovery against the home that was passed");
  if (discovered.claude) {
    assert.ok(merged.harness.claude.settings.startsWith(home), `${merged.harness.claude.settings} must sit under ${home}`);
    assert.notEqual(merged.harness.claude.settings, merge({ trusted_authors: ["me"] }).harness.claude?.settings,
      "which is a different path from the one the default home produces, so the argument is not cosmetic");
  }
  // An explicit harness block turns discovery off, so the home cannot change it at all.
  assert.deepEqual(merge({ trusted_authors: ["me"], harness: { codex: { bin: "/bin/codex" } } }, home).harness, { codex: { bin: "/bin/codex" } });
});


test("the cursor cannot be moved backwards by any caller, because advanceCursor refuses a candidate before it", () => {
  // Three callers pass a boundary from a different source: the newest event dispatched, the head commit's committer
  // date, and a local clock reading. Only the first was guarded, so a force-push to an older commit or a clock a
  // second behind GitHub's moved `since` back, and `advanceCursor` then cleared `dispatched` because the instant
  // changed, so the event that started the round became new again.
  const cursor = { since: at(10), dispatched: ["review:1"], fixed_sha: "a1b2c3d", checks_sha: null, receipt_hash: "abc" };
  const back = advanceCursor(cursor, at(2), ["review:9"]);
  assert.equal(back.since, at(10), "a candidate before the cursor is not a boundary");
  assert.deepEqual(back.dispatched, ["review:1"], "so nothing is newly handled and nothing is forgotten");
  assert.equal(back.receipt_hash, "abc", "and the rest of the cursor is carried through as always");

  // Forward still moves, and clears, exactly as before.
  const fwd = advanceCursor(cursor, at(20), ["review:9"]);
  assert.deepEqual([fwd.since, fwd.dispatched], [at(20), ["review:9"]]);
  // The same second still unions, which is what makes the inclusive comparison safe.
  const same = advanceCursor(cursor, at(10), ["review:9"]);
  assert.deepEqual([same.since, same.dispatched.sort()], [at(10), ["review:1", "review:9"]]);
  // A first cursor has nothing to regress from.
  assert.equal(advanceCursor({}, at(5)).since, at(5));
});

test("assertSafeArgv refuses the = spelling of every switch it refuses as two elements", () => {
  // Its own doc comment names `--approval-mode yolo` and `-y/--yolo` as "the same switch by two spellings". A list of
  // literal spellings caught one form and let the other through, and `register --session` was a fourth way in.
  for (const bad of ["--approval-mode=yolo", "--approval-mode=YOLO", "--yolo=true", "--sandbox=danger-full-access", "-s=danger-full-access"]) {
    assert.throws(() => assertSafeArgv(["run", bad, "prompt"]), /refusing to run with/, `${bad} must be refused`);
  }
  for (const [flag, value] of [["--approval-mode", "yolo"], ["--sandbox", "danger-full-access"], ["-s", "danger-full-access"]]) {
    assert.throws(() => assertSafeArgv(["run", flag, value]), /refusing to run with/, `${flag} ${value} must be refused`);
  }
  // And the ordinary spellings of those flags are untouched: only the dangerous value is refused.
  assert.doesNotThrow(() => assertSafeArgv(["run", "--approval-mode", "auto"]));
  assert.doesNotThrow(() => assertSafeArgv(["run", "--sandbox=workspace-write"]));
  assert.doesNotThrow(() => assertSafeArgv(["exec", "resume", "22222222-2222-4222-8222-222222222222", "--json"]));
});

test("a context_paths entry that is a symlink to a forbidden directory is refused by what it points at", () => {
  // Every refusal compared lexical paths, and `expand` resolves `~` without following symlinks, so a link to $HOME or
  // to a harness config directory passed all of them and handed the run exactly what they exist to refuse. SPEC.md
  // claims those directories "and any parent of those are refused"; neither held through a link.
  //
  // Every target this test links to is one the test creates, inside directories it owns. It used to link to
  // `~/.claude`, which made the whole assertion a fact about the machine: on an account with no `~/.claude` the link
  // dangles, `realpathSync` throws, `realOf` falls back to the lexical path, validation correctly reports that the
  // path does not exist, and the assertion expecting the forbidden-directory message fails. It passed on the laptop it
  // was written on and failed on every clean account and every CI runner.
  const dir = tempHome();
  const gvHome = tempHome();
  // The Gallivant home itself: one entry on the forbidden list, and the one the caller can point anywhere.
  symlinkSync(gvHome, join(dir, "togallivant"));
  // A PARENT of the Gallivant home, which is the shape a link to `$HOME` has when a harness config directory lives
  // under it: the refusal is `isInside(forbidden, candidate)`, so containing a forbidden directory is what it catches.
  symlinkSync(dirname(gvHome), join(dir, "toparent"));
  // A link to the real home directory, refused on its own terms rather than by containment. `homedir()` is a real
  // directory on any account this test can run on at all, and nothing is read from it or written into it.
  symlinkSync(HOME, join(dir, "tohome"));

  assert.match(validateContextPaths([join(dir, "togallivant")], gvHome)[0] ?? "", /which holds the settings and passport/);
  assert.match(validateContextPaths([join(dir, "toparent")], gvHome)[0] ?? "", /contains the Gallivant home/);
  assert.match(validateContextPaths([join(dir, "tohome")], gvHome)[0] ?? "", /is your home directory/);
  assert.deepEqual(validateContextPaths([dir], gvHome), [], "a plain directory is still accepted");

  // The harness config directories are refused through a link by the same comparison, and this asserts it against one
  // the test creates rather than against `~/.claude`. `validateContextPaths` hardcodes those five paths, so the test
  // builds the same shape with the one forbidden entry it can place: a directory whose PARENT is what the link points
  // at, which is exactly how `~` reaches `~/.claude`.
  const nested = join(gvHome, "claude", "settings");
  mkdirSync(nested, { recursive: true });
  symlinkSync(gvHome, join(dir, "toconfig"));
  assert.match(validateContextPaths([join(dir, "toconfig")], nested)[0] ?? "", /contains the Gallivant home/,
    "a link to a directory that contains the one holding the settings is refused by what it points at");

  // And a dangling link is reported as absent, which is what made the old version of this test pass by accident: the
  // message names a missing path, not a forbidden one, so nothing here can be satisfied by a link to nowhere.
  symlinkSync(join(dir, "no-such-target"), join(dir, "dangling"));
  assert.match(validateContextPaths([join(dir, "dangling")], gvHome)[0] ?? "", /does not exist/);
});

test("a context path never lands where it can swallow the prompt", () => {
  // A live run died here. `--add-dir` takes a variadic list, so `--add-dir <dir> <prompt>` reads the prompt as a
  // second directory and Claude Code refuses with "Input must be provided either through stdin or as a prompt
  // argument when using --print". Every adapter's prompt is the final argv element, so nothing that accepts more
  // than one value may sit immediately before it.
  const cfg = { max_budget_usd: 5, harness: Object.fromEntries(Object.keys(adapters).map(h => [h, { bin: `/b/${h}`, settings: "/s.json" }])) };
  for (const harness of Object.keys(adapters)) {
    for (const mode of ["start", "resume"]) {
      let spec;
      try { spec = buildRun({ harness, config: cfg, mode, session: "11111111-1111-4111-8111-111111111111", prompt: "THE PROMPT", cwd: "/w", contextPaths: ["/tmp/ctx"] }); }
      catch { continue; }   // a harness that refuses context paths has nothing to order
      assert.equal(spec.args.at(-1), "THE PROMPT", `${harness} ${mode}: the prompt is the last element`);
      // Only a flag that accepts a value can steal the prompt. A boolean one (`--verbose`) is harmless, so the
      // assertion is about the context flags specifically: every one must be followed by its own directory.
      for (const [i, arg] of spec.args.entries()) {
        if (!String(arg).startsWith("--add-dir")) continue;
        assert.equal(spec.args[i + 1], "/tmp/ctx", `${harness} ${mode}: --add-dir must be followed by its directory, not the prompt`);
        assert.ok(i + 1 < spec.args.length - 1, `${harness} ${mode}: --add-dir's value must not be the final element`);
      }
    }
  }
});
