// `gallivant resume`, which exists because of a real run. A start run spent its budget and stopped before opening a
// pull request, so the entry went to needs-human with reason no-pr. The session id, the worktree and the brief were
// all recorded, but `register` needs a PR to attach to, so the one case where a run dies BEFORE its PR exists had no
// way back and the operator had to assemble a raw `claude --resume` by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resume } from "../lib/commands/resume.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, T0, tempHome, fakeRunner, makeClock, silentLog, GOOD_PRD, fakeCredential, fakeIdentity } from "./helpers.mjs";

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
    ctx: { credential: fakeCredential(), identity: fakeIdentity(), home, config: CONFIG, state, log: silentLog, clock,
      git: { exists: () => true, fromBranch: async a => { cloned.push(a.path); mkdirSync(a.path, { recursive: true }); return a.path; } },
      runnerFor: () => runner, readPrd: () => GOOD_PRD, writePrd: () => {}, notify: {}, gh: { removeLabel: async () => {} } },
  };
}

test("resume refuses a checkout whose last run left work uncommitted, and names the commands", async () => {
  // The bug this pins, from a live run. A start run produced a 33-file research package, passed both of its Verify
  // commands and never committed. The next resume merged the base first, git refused because the dirty files would be
  // overwritten, and `mergeBase` reported every merge error as `conflict: true`. So the operator was told the branch
  // could not be merged with its base, which reads as two versions of a file disagreeing, and went looking for conflict
  // markers in a tree that had none.
  //
  // The check lives here rather than in the tick because only a resume can tell the two dirty trees apart: a fix round
  // dispatches against a worktree whose session may be mid-edit, and stopping for that would stop every healthy entry.
  const w = world();
  let merged = 0;
  w.ctx.git.dirty = async () => ({ modified: 6, untracked: 41 });
  w.ctx.git.mergeBase = async () => { merged++; return { merged: true }; };
  await assert.rejects(() => resume(w.ctx, { handle: "widget-export" }), e => {
    assert.match(e.message, /6 modified and 41 untracked files/, "the counts, which are the difference between nearly done and did nothing");
    assert.match(e.message, /are not committed/, "named for what it is, not as a conflict");
    assert.match(e.message, /git add -A && git commit/, "and the command that resolves it");
    assert.doesNotMatch(e.message, /conflict/i, "the word that sent an operator looking for markers that were not there");
    return true;
  });
  assert.equal(merged, 0, "read before the merge is attempted, so nothing is fetched, merged or aborted");
  assert.equal(w.runner.started.length, 0, "and no session is spawned");
  assert.equal(w.state.get(w.id).reason, "no-pr", "the entry is untouched: a refusal is not a state change");
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

test("the prompt says why the last run stopped, and carries the brief's Verify commands", async () => {
  const w = world();
  await resume(w.ctx, { handle: "widget-export", note: "budget raised to 200" });
  const prompt = w.runner.started[0].args.at(-1);
  // The agent's memory ends mid-task; the reason is the one thing it cannot know, and a budget cut reads as
  // unexplained unless it is told.
  assert.match(prompt, /ended before opening the pull request/);
  assert.match(prompt, /budget raised to 200/, "the operator's note reaches it");
  assert.match(prompt, /npm run lint/, "the Verify commands come from the daemon's snapshot");
  assert.match(prompt, /gallivant-attestations/, "and the completion receipt it still owes");
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
