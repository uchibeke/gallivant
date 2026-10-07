// `gallivant resume`, which exists because of a real run. A start run spent its budget and stopped before opening a
// pull request, so the entry went to needs-human with reason no-pr. The session id, the worktree and the brief were
// all recorded, but `register` needs a PR to attach to, so the one case where a run dies BEFORE its PR exists had no
// way back and the operator had to assemble a raw `claude --resume` by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resume } from "../lib/commands/resume.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeGit } from "../lib/git.mjs";
import { join } from "node:path";
import { CONFIG, T0, tempHome, fakeRunner, makeClock, silentLog, GOOD_PRD, fakeCredential, fakeIdentity, harnessBin } from "./helpers.mjs";

const SESSION = "fb6b8691-7805-45ac-b4c3-06c2f4f24184";

function world(over = {}) {
  const home = tempHome();
  const worktree = join(home, "wt");
  mkdirSync(worktree);
  const state = makeState(home);
  const id = "acme/widget/widget-export";
  state.put(id, {
    ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: SESSION, repo: "acme/widget", branch: "gallivant/widget-export", worktree, state: STATES.needsHuman, nowIso: T0 }),
    reason: "no-pr",
    ...over,
  });
  const clock = makeClock();
  const runner = fakeRunner(clock);
  const cloned = [];
  return {
    id, state, runner, cloned,
    ctx: { credential: fakeCredential(), identity: fakeIdentity(), home, config: { ...CONFIG, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") } } }, state, log: silentLog, clock,
      git: { exists: () => true, fromBranch: async a => { cloned.push(a.path); mkdirSync(a.path, { recursive: true }); return a.path; } },
      runnerFor: () => runner, readPrd: () => GOOD_PRD, writePrd: () => {}, notify: {}, gh: { removeLabel: async () => {} } },
  };
}

test("manual resume refuses an old Codex before restoring or merging the checkout or changing state", async () => {
  const w = world({ harness: "codex", base: "main" });
  w.ctx.config.harness.codex = { bin: harnessBin(w.ctx.home, "codex", { version: "0.155.1" }) };
  const before = structuredClone(w.state.get(w.id));
  let touched = false;
  w.ctx.git.exists = () => { touched = true; return false; };
  w.ctx.git.mergeBase = async () => { touched = true; };
  await assert.rejects(() => resume(w.ctx, { handle: "widget-export" }), /0\.155\.1 is older than 0\.158\.0/);
  assert.equal(touched, false);
  assert.deepEqual(w.cloned, []);
  assert.equal(w.runner.started.length, 0);
  assert.deepEqual(w.state.get(w.id), before);
});

test("resume preserves unfinished and carried work and defers only the base merge", async () => {
  const w = world({ base: "main", sources: ["AGENTS.md"] });
  let merged = 0;
  w.ctx.git.dirty = async () => ({ modified: 6, untracked: 41 });
  w.ctx.git.mergeBase = async () => { merged++; return { merged: true }; };
  await resume(w.ctx, { handle: "widget-export", note: "Restore the detailed article." });
  assert.equal(merged, 0);
  assert.equal(w.runner.started.length, 1);
  const prompt = w.runner.started[0].args.at(-1);
  assert.match(prompt, /6 modified and 41 untracked/);
  assert.match(prompt, /base merge was deferred/);
  assert.match(prompt, /AGENTS.md/);
  assert.match(prompt, /Do not stash, reset, discard, or blanket-stage/);
  assert.match(prompt, /Restore the detailed article/);
  assert.match(prompt, /After committing only the task's changes, fetch origin and merge `origin\/main` into this task branch before verification and push/);
  assert.match(prompt, /Do not merge a pull request or write to the default\/base branch/);
  assert.match(prompt, /rerun the Verify commands on the combined result before pushing/);
  assert.doesNotMatch(prompt, /keeping this branch on its base is done for you/);
});

test("resume carries on when the checkout is clean, so the check costs a reading and nothing else", async () => {
  // A base is needed for there to be a merge at all; `mergeBaseInto` returns early without one.
  const w = world({ base: "main" });
  let merged = 0;
  w.ctx.git.dirty = async () => ({ modified: 0, untracked: 0 });
  w.ctx.git.mergeBase = async (_d, base) => { merged++; return { merged: true, base, sha: "abc1234" }; };
  await resume(w.ctx, { handle: "widget-export" });
  assert.equal(merged, 1, "the base is still brought in");
  assert.equal(w.runner.started.length, 1, "and the session is resumed");
  assert.match(w.runner.started[0].args.at(-1), /keeping this branch on its base is done for you/);
});

test("correction leaves the real index, carried instructions and partial files byte-for-byte intact", async () => {
  const w = world({ base: "main", sources: ["AGENTS.md"] });
  const dir = w.state.get(w.id).worktree;
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  writeFileSync(join(dir, "article.md"), "original\n");
  git("add", "article.md");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial article");
  writeFileSync(join(dir, "article.md"), "staged changes\n");
  git("add", "article.md");
  writeFileSync(join(dir, "article.md"), "unfinished correction\n");
  writeFileSync(join(dir, "AGENTS.md"), "operator instructions\n");
  const index = readFileSync(join(dir, ".git/index"));
  w.ctx.git.dirty = makeGit({ config: w.ctx.config }).dirty;
  w.ctx.git.mergeBase = async () => assert.fail("a dirty checkout must not merge");
  await resume(w.ctx, { handle: w.id, note: "Preserve the detailed article." });
  assert.deepEqual(readFileSync(join(dir, ".git/index")), index);
  assert.equal(readFileSync(join(dir, "article.md"), "utf8"), "unfinished correction\n");
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "operator instructions\n");
  assert.equal(w.runner.started.length, 1);
});

test("unreadable worktree status cannot authorize a merge or resume", async () => {
  const w = world({ base: "main" });
  w.ctx.git.dirty = makeGit({ config: w.ctx.config, exec: async () => { throw new Error("status unreadable"); } }).dirty;
  w.ctx.git.mergeBase = async () => assert.fail("must not merge");
  await assert.rejects(() => resume(w.ctx, { handle: w.id }), /status unreadable/);
  assert.equal(w.runner.started.length, 0);
});

test("a git with no dirty reader resumes as before, because a missing check is not a clean tree", async () => {
  // Every entry `register` and `reconcile` build predates this reader. A missing one is a check not made, and must
  // neither be read as permission to skip nor block the resume.
  const w = world();
  await resume(w.ctx, { handle: "widget-export" });
  assert.equal(w.runner.started.length, 1);
});

test("resume spawns the recorded session in the recorded worktree and clears the stop", async () => {
  const w = world();
  const r = await resume(w.ctx, { handle: "widget-export" });
  const args = w.runner.started[0].args;
  // The point of the command: the SAME session, not a fresh one, or the work already paid for is paid for twice.
  assert.ok(args.includes("--resume"), "resumed rather than started");
  assert.ok(args.includes(SESSION));
  assert.equal(w.runner.started[0].opts.cwd, w.state.get(w.id).worktree);
  // The entry goes back to a watched state with its reason cleared, so the daemon settles this run like any other.
  const e = w.state.get(w.id);
  assert.equal(e.reason, null);
  assert.equal(e.state, STATES.running, "no PR yet, so it is implementing again");
  assert.equal(e.last.exit, null, "exit stays unrecorded, which is what tells settleRun the run is ours and owed");
  assert.match(e.last.event, /resumed after no-pr/);
  assert.match(r.attach, /claude --resume/);
});

test("direct resume records its public-output boundary before launch and preserves an existing boundary", async t => {
  const wall = Date.parse("2026-10-03T12:00:00.750Z");
  t.mock.method(Date, "now", () => wall);
  for (const prior of [undefined, "2026-10-02T08:00:00.000Z"]) {
    const w = world(prior ? { public_since: prior } : {});
    const launch = w.runner.start;
    w.runner.start = (...args) => {
      const boundary = w.state.get(w.id).public_since;
      assert.equal(boundary, prior ?? "2026-10-03T12:00:00.000Z");
      assert.ok(Date.parse(boundary) <= wall, "already persisted before the child can publish");
      return launch(...args);
    };
    await resume(w.ctx, { handle: "widget-export" });
    assert.equal(w.state.get(w.id).public_since, prior ?? "2026-10-03T12:00:00.000Z");
  }
});

test("the prompt says why the last run stopped, and carries the brief's Verify commands", async () => {
  const w = world();
  await resume(w.ctx, { handle: "widget-export", note: "budget raised to 200" });
  const prompt = w.runner.started[0].args.at(-1);
  // The agent's memory ends mid-task; the reason is the one thing it cannot know, and a budget cut reads as
  // unexplained unless it is told.
  assert.match(prompt, /ended before opening the pull request/);
  assert.match(prompt, /budget raised to 200/, "the operator's note reaches it");
  assert.match(prompt, /npm run lint/, "the Verify commands come from the daemon's snapshot");
  assert.match(prompt, /work-attestations/, "and the completion receipt it still owes");
});

test("an entry already watching a PR resumes into pr-open rather than running", async () => {
  const w = world({ state: STATES.ready, reason: null, pr: 142, url: "https://github.com/acme/widget/pull/142" });
  await resume(w.ctx, { handle: "widget#142" });
  assert.equal(w.state.get(w.id).state, STATES.prOpen);
  assert.match(w.runner.started[0].args.at(-1), /pull request #142/);
});

test("resume refuses what it cannot resume, and says what to do instead", async () => {
  // No session: there is nothing to resume, and `start` is the honest answer rather than a silent fresh run.
  const none = world({ session: null });
  await assert.rejects(() => resume(none.ctx, { handle: "widget-export" }), /no session to resume/);
  // Already finished.
  const done = world({ state: STATES.done, reason: null });
  await assert.rejects(() => resume(done.ctx, { handle: "widget-export" }), /is done/);
  // A live run must not get a second one: two harnesses in one worktree would fight over the branch.
  const busy = world();
  busy.runner.start("fix", "/bin/claude", [], {});
  await assert.rejects(() => resume(busy.ctx, { handle: "widget-export" }), /already has a run in flight/);
  // An unknown handle names the forms that work rather than failing blankly.
  await assert.rejects(() => resume(world().ctx, { handle: "nope" }), /no entry for nope/);
});

test("a missing checkout is recreated from the branch, because the session's memory is not in the directory", async () => {
  const w = world();
  w.ctx.git.exists = () => false;
  await resume(w.ctx, { handle: "widget-export" });
  assert.deepEqual(w.cloned, [w.state.get(w.id).worktree]);
  assert.equal(w.runner.started.length, 1, "and the run still starts");
});


test("resume retains accepted ownership when the learning delivery audit is locked", async () => {
  const w = world(), repo = { host: "github.com", id: "1234" };
  let observed;
  w.ctx.learning = { identityFor: () => repo, resolveRepo: async () => repo, mode: () => "apply",
    context: async () => ({ key: "d".repeat(64), section: "Advisory", rules: [] }),
    delivered: async (_repo, _key, runId) => {
      observed = { runId, entry: w.ctx.state.entries()[0][1] };
      throw new Error("operation.lock busy");
    } };
  const result = await resume(w.ctx, { handle: w.id });
  assert.equal(observed.runId, result.run);
  assert.equal(observed.entry.last.run, result.run);
  assert.equal(Object.keys(observed.entry.learning_deliveries).length, 1);
  assert.equal(w.ctx.state.get(result.id).last.run, result.run);
});


test("fresh learning resume preserves task and review state while replacing native memory", async () => {
  const w = world({ pr: 142, iteration: 2, learning: { repo: { host: "github.com", id: "1234" }, rules: [{ id: "old", digest: "b".repeat(64) }] }, learning_revocation: { freshSessionRequired: true } });
  const before = w.state.get(w.id), repo = before.learning.repo;
  w.ctx.learning = { identityFor: () => repo, resolveRepo: async () => { throw new Error("GitHub unavailable"); }, mode: () => "off", context: async () => { throw new Error("disabled continuation must be local"); } };
  const result = await resume(w.ctx, { handle: w.id, freshSession: true });
  const after = w.state.get(w.id);
  assert.notEqual(result.session, before.session);
  for (const key of ["repo", "pr", "branch", "worktree", "iteration", "cursor"]) assert.deepEqual(after[key], before[key]);
  assert.equal(after.learning_continuity.previousSession, before.session);
  assert.equal(after.learning_continuity.status, "accepted"); assert.equal(after.learning_revocation, null);
  assert(w.runner.started[0].args.some(v => v.includes("Approved brief snapshot:")));
  assert(!w.runner.started[0].args.includes("--resume"));
});

test("fresh learning resume refuses unresolved work and unrelated sessions", async () => {
  const w = world(); await assert.rejects(resume(w.ctx, { handle: w.id, freshSession: true }), /requires recorded learned context/);
  w.state.update(w.id, { learning_revocation: { freshSessionRequired: true }, last: { run: "unsettled", exit: null } });
  await assert.rejects(resume(w.ctx, { handle: w.id, freshSession: true }), /still needs settling/);
  assert.equal(w.runner.started.length, 0);
});


test("fresh learning resume retries the prepared session after a pre-launch failure", async () => {
  const w = world({ learning_revocation: { freshSessionRequired: true } });
  const launch = w.runner.start; let fail = true;
  w.runner.start = async (...args) => { if (fail) { fail = false; throw new Error("pre-launch fixture failure"); } return launch(...args); };
  await assert.rejects(resume(w.ctx, { handle: w.id, freshSession: true }), /pre-launch/);
  const pending = w.state.get(w.id);
  assert.equal(pending.session, SESSION); assert.equal(pending.learning_continuity.status, "prepared");
  const result = await resume(w.ctx, { handle: w.id, freshSession: true });
  assert.equal(result.session, pending.learning_continuity.newSession);
  assert.equal(w.runner.started.length, 1);
});
