import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, statSync, linkSync } from "node:fs";
import { EventEmitter } from "node:events";
import { makeGit } from "../lib/git.mjs";
import { readRepositoryText, writeRepositoryText } from "../lib/repository_files.mjs";
import { parsePrd, check, contractDiff, sourceDivergence } from "../lib/prd.mjs";
import { acquireDaemon, processIdentity } from "../lib/daemon.mjs";
import { down, readDaemon, up, upInBackground } from "../lib/commands/up.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { startPrompt, resumePrompt, fixPrompt } from "../lib/prompt.mjs";
import { model } from "../lib/commands/status.mjs";
import { READY_LABEL } from "../lib/gh.mjs";
import { CONFIG, GOOD_PRD, T0, tempHome, fakeGh, fakeGit, fakeRunner, fakeNotify, fakeCredential, fakeIdentity, makeClock, silentLog, harnessBin } from "./helpers.mjs";

const REL = "docs/prds/widget-export.md";
const SOURCE = "docs/support.md";
const BRIEF = GOOD_PRD.replace("harness: codex", `harness: codex\nsources: [${SOURCE}]`);
function world() {
  const home = tempHome();
  const checkout = join(home, "checkout"), worktree = join(home, "wt");
  for (const root of [checkout, worktree]) {
    mkdirSync(join(root, "docs/prds"), { recursive: true });
    writeFileSync(join(root, REL), BRIEF);
    writeFileSync(join(root, SOURCE), "original support");
  }
  const id = "acme/widget/widget-export";
  const state = makeState(home);
  state.put(id, newEntry({ prd: REL, harness: "codex", session: "session", repo: "acme/widget", branch: "gallivant/widget-export", worktree, checkout, sources: [SOURCE], pr: 142, state: STATES.needsHuman, nowIso: T0 }));
  const clock = makeClock(), runner = fakeRunner(clock), gh = fakeGh(), sources = new Map([[SOURCE, "original support"]]);
  let brief = BRIEF;
  const ctx = {
    home, state, clock, gh, git: fakeGit(), log: silentLog, notify: fakeNotify(), ownLogin: "me",
    config: { ...CONFIG, harness: { codex: { bin: harnessBin(home) } }, reviewer: null, deliverable: null }, credential: fakeCredential(), identity: fakeIdentity(),
    runnerFor: () => runner, readPrd: () => brief, writePrd: (_id, text) => { brief = text; },
    readSource: (_id, rel) => sources.get(rel) ?? null, writeSource: (_id, rel, text) => sources.set(rel, text),
  };
  return { home, checkout, worktree, id, state, runner, sources, ctx, run: opts => resume(ctx, { handle: id, ...opts }) };
}

test("carried-file symlinks, including directory links, cannot read or overwrite outside the checkout", () => {
  for (const directory of [false, true]) {
    const root = tempHome(), outside = tempHome();
    writeFileSync(join(outside, "secret.md"), "private bytes");
    symlinkSync(directory ? outside : join(outside, "secret.md"), join(root, "link"));
    const rel = directory ? "link/secret.md" : "link";
    assert.throws(() => readRepositoryText(root, rel), /symlink/);
    assert.throws(() => writeRepositoryText(root, rel, "replacement"), /symlink/);
    const brief = GOOD_PRD.replace("harness: codex", `harness: codex\nsources: [${rel}]`);
    const verdict = check({ ...parsePrd(brief, join(root, REL)), checkout: root });
    assert.equal(verdict.ok, false);
    assert.match(verdict.results.find(r => r.id === "sources").detail, /symlink/);
    assert.equal(readFileSync(join(outside, "secret.md"), "utf8"), "private bytes");
  }
});

test("hook installation refuses links at the hook, hooks directory, or .git directory", () => {
  for (const rel of [".git/hooks/commit-msg", ".git/hooks", ".git"]) {
    const root = tempHome(), outside = tempHome();
    const target = join(outside, "target");
    if (rel.endsWith("commit-msg")) writeFileSync(target, "do not overwrite");
    else mkdirSync(target);
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    symlinkSync(target, join(root, rel));
    const result = makeGit().installHooks(root);
    assert.equal(result.installed, false);
    assert.match(result.why, /symlink/);
    if (rel.endsWith("commit-msg")) assert.equal(readFileSync(target, "utf8"), "do not overwrite");
  }
});

test("atomic repository writes preserve hard-link targets and restore the hook's executable mode", () => {
  const root = tempHome(), outside = join(tempHome(), "original");
  writeFileSync(outside, "original");
  linkSync(outside, join(root, "file"));
  writeRepositoryText(root, "file", "new");
  assert.equal(readFileSync(outside, "utf8"), "original");
  writeFileSync(join(root, "script.sh"), "old", { mode: 0o755 });
  writeRepositoryText(root, "script.sh", "new");
  assert.equal(statSync(join(root, "script.sh")).mode & 0o777, 0o755);
  mkdirSync(join(root, ".git/hooks"), { recursive: true });
  writeFileSync(join(root, ".git/hooks/commit-msg"), "old", { mode: 0o600 });
  assert.equal(makeGit().installHooks(root).installed, true);
  assert.ok(statSync(join(root, ".git/hooks/commit-msg")).mode & 0o111);
});

test("fresh and adopted clones explicitly select HTTPS regardless of gh's configured protocol", async () => {
  const calls = [];
  const git = makeGit({ config: { worktrees: tempHome() }, exec: async (cmd, args) => { calls.push([cmd, args]); return { stdout: "" }; } });
  await git.create({ nameWithOwner: "acme/widget", prdId: "one", base: "main" });
  await git.fromBranch({ nameWithOwner: "acme/widget", prdId: "two", branch: "feature" });
  assert.deepEqual(calls.filter(([cmd]) => cmd === "gh").map(([, args]) => args[2]), ["https://github.com/acme/widget.git", "https://github.com/acme/widget.git"]);
});

test("existing SSH origins are normalized before a token-authenticated run", async () => {
  const calls = [];
  const git = makeGit({ exec: async (_cmd, args) => { calls.push(args); return { stdout: args[1] === "get-url" ? "git@github.com:acme/widget.git" : "" }; } });
  await git.ensureHttpsRemote("/a/checkout");
  assert.deepEqual(calls.at(-1), ["remote", "set-url", "origin", "https://github.com/acme/widget.git"]);
});

test("only sessions without a PR are told to open one, using the recorded base", () => {
  const start = startPrompt({ prd: { text: GOOD_PRD }, repo: "acme/widget", branch: "feature", base: "staging", verify: [] });
  const resumed = resumePrompt({ repo: "acme/widget", pr: null, branch: "feature", base: "staging" });
  for (const prompt of [start, resumed]) {
    assert.match(prompt, /gh pr create --base staging --head feature/);
    assert.doesNotMatch(prompt, /Do not open new PRs/);
  }
  assert.match(fixPrompt({ repo: "acme/widget", pr: 142, events: [] }), /Do not open new PRs/);
  assert.match(resumePrompt({ repo: "acme/widget", pr: 142 }), /Do not open new PRs/);
});

test("resume refuses changed supporting bytes until accepted, then updates both copies and the prompt", async () => {
  const w = world();
  writeFileSync(join(w.checkout, SOURCE), "updated support");
  await assert.rejects(() => w.run(), /carried files differ/);
  assert.equal(w.runner.started.length, 0);
  assert.equal(w.sources.get(SOURCE), "original support");
  assert.equal(model(w.ctx).needs_you[0].divergence.verdict, "changed");
  await w.run({ resnapshot: true });
  assert.equal(w.sources.get(SOURCE), "updated support");
  assert.equal(readFileSync(join(w.worktree, SOURCE), "utf8"), "updated support");
  assert.match(w.runner.started[0].args.at(-1), /source changed: docs\/support.md/);
});

test("explicit resnapshot preserves unfinished work and unchanged carried instructions", async () => {
  const w = world();
  w.ctx.git.dirty = async () => ({ modified: 2, untracked: 0 });
  w.ctx.git.mergeBase = async () => assert.fail("must defer base merge");
  const next = BRIEF.replace("CSV with three rows downloads.", "CSV with three rows downloads and preserves every field.");
  writeFileSync(join(w.checkout, REL), next);
  writeFileSync(join(w.worktree, "article.md"), "partial article edit");
  await w.run({ resnapshot: true });
  assert.equal(w.ctx.readPrd(), next);
  assert.equal(readFileSync(join(w.worktree, REL), "utf8"), next);
  assert.equal(readFileSync(join(w.worktree, SOURCE), "utf8"), "original support");
  assert.equal(readFileSync(join(w.worktree, "article.md"), "utf8"), "partial article edit");
  assert.equal(w.runner.started.length, 1);
});

test("resnapshot refuses conflicting session edits before changing any snapshot or file", async () => {
  for (const rel of [REL, SOURCE]) {
    const w = world();
    w.ctx.git.dirty = async () => ({ modified: 1, untracked: 0 });
    writeFileSync(join(w.checkout, SOURCE), "accepted update");
    writeFileSync(join(w.checkout, REL), BRIEF.replace("CSV with three rows downloads.", "CSV with three rows downloads and preserves every field."));
    writeFileSync(join(w.worktree, rel), "session's unfinished edit");
    await assert.rejects(() => w.run({ resnapshot: true }), /local edits differ/);
    assert.equal(w.ctx.readPrd(), BRIEF);
    assert.equal(w.sources.get(SOURCE), "original support");
    assert.equal(readFileSync(join(w.worktree, rel), "utf8"), "session's unfinished edit");
    assert.equal(w.runner.started.length, 0);
  }
});

test("resnapshot of an unchanged contract cannot overwrite edited carried files", async () => {
  const w = world();
  w.ctx.git.dirty = async () => ({ modified: 1, untracked: 0 });
  writeFileSync(join(w.worktree, SOURCE), "unfinished session edits");
  await assert.rejects(() => w.run({ resnapshot: true }), /local edits differ/);
  assert.equal(readFileSync(join(w.worktree, SOURCE), "utf8"), "unfinished session edits");
  assert.equal(w.runner.started.length, 0);
});

test("a deleted source must be removed from the manifest before resnapshot can accept it", async () => {
  const w = world();
  rmSync(join(w.checkout, SOURCE));
  await assert.rejects(() => w.run(), /missing or unreadable/);
  await assert.rejects(() => w.run({ resnapshot: true }), /ENOENT/);
  assert.equal(w.ctx.readPrd(), BRIEF);
  writeFileSync(join(w.checkout, REL), GOOD_PRD);
  await w.run({ resnapshot: true });
  assert.deepEqual(w.state.get(w.id).sources, []);
  assert.match(w.runner.started[0].args.at(-1), /source removed: docs\/support.md/);
});

test("new source paths are snapshotted and copied when the manifest is accepted", async () => {
  const w = world();
  const next = BRIEF.replace(SOURCE, `${SOURCE}, docs/new.md`);
  writeFileSync(join(w.checkout, "docs/new.md"), "new source");
  writeFileSync(join(w.checkout, REL), next);
  await w.run({ resnapshot: true });
  assert.deepEqual(w.state.get(w.id).sources, [SOURCE, "docs/new.md"]);
  assert.equal(w.sources.get("docs/new.md"), "new source");
  assert.equal(readFileSync(join(w.worktree, "docs/new.md"), "utf8"), "new source");
  assert.match(contractDiff(parsePrd(BRIEF, REL), parsePrd(next, REL)).join("\n"), /source added/);
});

test("resnapshot refuses a harness change without replacing the brief or spawning", async () => {
  const w = world();
  writeFileSync(join(w.checkout, REL), BRIEF.replace("harness: codex", "harness: claude"));
  await assert.rejects(() => w.run({ resnapshot: true }), /cannot change harness from codex to claude/);
  assert.equal(w.ctx.readPrd(), BRIEF);
  assert.equal(w.runner.started.length, 0);
});

test("a failed spawn retains the accepted brief changes for the next resume", async () => {
  const w = world();
  writeFileSync(join(w.checkout, SOURCE), "new bytes");
  w.ctx.identity = fakeIdentity({ name: null, email: null });
  await assert.rejects(() => w.run({ resnapshot: true }), /identity/i);
  writeFileSync(join(w.worktree, SOURCE), "stale copy after failed write");
  w.ctx.identity = fakeIdentity();
  await w.run();
  assert.match(w.runner.started[0].args.at(-1), /THE BRIEF HAS CHANGED/);
  assert.equal(readFileSync(join(w.worktree, SOURCE), "utf8"), "new bytes");
  assert.equal(w.state.get(w.id).brief_changes, null);
});

test("a source snapshot write failure cannot accept a new manifest", async () => {
  const w = world();
  writeFileSync(join(w.checkout, REL), BRIEF.replace(SOURCE, `${SOURCE}, docs/new.md`));
  writeFileSync(join(w.checkout, "docs/new.md"), "new source");
  w.ctx.writeSource = () => { throw new Error("disk full"); };
  await assert.rejects(() => w.run({ resnapshot: true }), /disk full/);
  assert.equal(w.ctx.readPrd(), BRIEF);
  assert.deepEqual(w.state.get(w.id).sources, [SOURCE]);
  assert.equal(w.runner.started.length, 0);
});

test("a ready entry cannot resume until GitHub removes the ready label", async () => {
  const w = world();
  w.state.update(w.id, { state: STATES.ready });
  w.ctx.gh.removeLabel = async (_repo, _pr, label) => { assert.equal(label, READY_LABEL); throw new Error("label refused"); };
  await assert.rejects(() => w.run(), /label refused/);
  assert.equal(w.runner.started.length, 0);
  assert.equal(w.state.get(w.id).state, STATES.ready);
});

test("a completed run still awaiting settlement cannot be overwritten by resume", async () => {
  const w = world();
  const job = w.runner.start("fix", "codex", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  w.runner.finish([], { exit: 0 });
  await assert.rejects(() => w.run(), /still needs settling/);
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.state.get(w.id).last.run, job.id);
});

test("changed sources stop readiness even when the PRD text and all checks are unchanged", async () => {
  const w = world();
  w.state.update(w.id, { state: STATES.prOpen });
  w.ctx.gh.data.pr.statusCheckRollup = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }];
  writeFileSync(join(w.checkout, SOURCE), "changed");
  await makeTick(w.ctx).tickEntry(w.id, w.state.get(w.id));
  assert.equal(w.state.get(w.id).state, STATES.needsHuman);
  assert.equal(w.state.get(w.id).reason, "prd-changed");
  assert.equal(w.ctx.notify.sent[0][0], "needs");
});

test("source divergence treats a symlink replacement as unreadable without reading its target", () => {
  const w = world();
  rmSync(join(w.checkout, SOURCE));
  symlinkSync(join(w.worktree, SOURCE), join(w.checkout, SOURCE));
  assert.deepEqual(sourceDivergence({ id: w.id, entry: w.state.get(w.id), readSource: w.ctx.readSource }).missing, [SOURCE]);
});

test("daemon exclusion survives missing health, rejects a second owner, and releases cleanly", () => {
  const home = tempHome();
  const lock = acquireDaemon(home);
  try {
    assert.equal(readDaemon(home).alive, true);
    assert.throws(() => acquireDaemon(home), /already running/);
  } finally { lock.release(); }
  const next = acquireDaemon(home);
  next.release();
});

test("a stale daemon lock can be recovered without trusting its reusable PID", () => {
  const home = tempHome();
  writeJsonAtomic(join(home, "daemon.lock"), { pid: process.pid, identity: "v2:old process", instance: "old" });
  const lock = acquireDaemon(home);
  try { assert.equal(readDaemon(home).instance, lock.owner.instance); }
  finally { lock.release(); }
});

test("daemon identity and exclusion survive a caller's locale and timezone change", () => {
  const home = tempHome();
  const saved = Object.fromEntries(["LC_ALL", "LANG", "TZ"].map(k => [k, process.env[k]]));
  let lock;
  try {
    Object.assign(process.env, { LC_ALL: "C", LANG: "C", TZ: "UTC" });
    lock = acquireDaemon(home);
    Object.assign(process.env, { LC_ALL: "en_CA.UTF-8", LANG: "en_CA.UTF-8", TZ: "America/Toronto" });
    assert.equal(processIdentity(process.pid), lock.owner.identity);
    assert.equal(readDaemon(home).alive, true);
    assert.throws(() => acquireDaemon(home), /already running/);
  } finally {
    lock?.release();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test("a live legacy daemon with an unverifiable identity cannot be replaced", () => {
  const home = tempHome();
  const original = { pid: process.pid, identity: "Wed 30 Sep 09:57:37 2026 node gallivant up", instance: "legacy" };
  writeJsonAtomic(join(home, "daemon.lock"), original);
  assert.equal(readDaemon(home).unverified, true);
  assert.throws(() => acquireDaemon(home), /already running/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "daemon.lock"), "utf8")), original);
});

test("a failure to publish daemon ownership prevents the GitHub probe", async () => {
  const w = world();
  mkdirSync(join(w.home, "daemon.lock"));
  let probed = false;
  w.ctx.gh.user = async () => { probed = true; return "me"; };
  await assert.rejects(() => up(w.ctx, { once: true }), /startup already in progress/);
  assert.equal(probed, false);
});

test("health write failure still publishes exclusive ownership during startup", async () => {
  const w = world();
  mkdirSync(join(w.home, "daemon.json"));
  let rejectProbe;
  w.ctx.gh.user = () => new Promise((_resolve, reject) => { rejectProbe = reject; });
  const boot = up(w.ctx, { once: true });
  assert.equal(readDaemon(w.home).alive, true);
  await assert.rejects(() => up(w.ctx, { once: true }), /already running/);
  rejectProbe(new Error("offline"));
  await assert.rejects(() => boot, /offline/);
  assert.equal(readDaemon(w.home), null);
});

test("down cannot signal an unrelated reused PID or a stopped daemon", () => {
  const home = tempHome();
  for (const data of [{ identity: "a different process" }, { identity: processIdentity(process.pid), stoppedAt: T0 }, {}]) {
    writeJsonAtomic(join(home, "daemon.json"), { pid: process.pid, ...data });
    assert.equal(down({ home, log: silentLog }).stopped, false);
    assert.equal(readDaemon(home).alive, false);
  }
});

test("up publishes ownership before a slow GitHub probe and releases it on boot failure", async () => {
  const w = world();
  let rejectProbe;
  w.ctx.gh.user = () => new Promise((_resolve, reject) => { rejectProbe = reject; });
  const boot = up(w.ctx, { once: true });
  assert.equal(readDaemon(w.home).alive, true);
  assert.equal(readDaemon(w.home).starting, true);
  await assert.rejects(() => up(w.ctx, { once: true }), /already running/);
  rejectProbe(new Error("GitHub unavailable"));
  await assert.rejects(() => boot, /GitHub unavailable/);
  assert.equal(readDaemon(w.home).alive, false);
});

test("background startup catches spawn errors and cancels an unreported child at timeout", async () => {
  const home = tempHome();
  const child = new EventEmitter();
  child.exitCode = null; child.unref = () => {};
  let killed = false;
  child.kill = () => { killed = true; };
  await assert.rejects(() => upInBackground({ home }, { waitMs: 5, sleep: async () => new Promise(r => setTimeout(r, 10)), spawnFn: (_bin, _args, opts) => {
    assert.equal(opts.env.GALLIVANT_HOME, home);
    return child;
  } }), /startup was cancelled/);
  assert.equal(killed, true);
  await assert.rejects(() => upInBackground({ home }, { waitMs: 100, sleep: async () => { child.emit("error", new Error("ENOENT")); }, spawnFn: () => child }), /could not start/);
});
