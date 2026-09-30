import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { requestControl, applyControl } from "../lib/control.mjs";
import { makeState } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { CONFIG, seededState, makeClock, fakeGh, fakeGit, fakeNotify, fakeRunner, fakeCredential, fakeIdentity, harnessBin, GOOD_PRD, silentLog, STATES, review, at, checkRun, prFixture } from "./helpers.mjs";

function world(over = {}) {
  const { home, state, id } = seededState({ state: STATES.needsHuman, reason: "checks-red", iteration: 2, ...over });
  const worktree = join(home, "worktree"); mkdirSync(worktree);
  state.update(id, { worktree });
  const clock = makeClock();
  const runner = fakeRunner(clock);
  const gh = fakeGh();
  const ctx = { home, state, clock, runnerFor: () => runner, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog,
    config: { ...CONFIG, home, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") } } },
    credential: fakeCredential(), identity: fakeIdentity(), readPrd: () => GOOD_PRD, ownLogin: "me" };
  return { ctx, state, id, home, runner, gh, tick: makeTick(ctx) };
}

test("requests survive a new context, refuse duplicates, and never silently truncate", () => {
  const w = world();
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "resume", note: "Keep the approved scope." });
  assert.equal(makeState(w.home).get(w.id).control.note, "Keep the approved scope.");
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "recheck" }), /already queued/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "resume", note: "x".repeat(4001) }), /4000/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "shell" }), /Unknown/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "recheck", note: "Do not lose me" }), /Send a message/);
  assert.equal(w.state.get(w.id).iteration, before.iteration);
  assert.equal(w.runner.started.length, 0);
});

test("a stopped PR rechecks without spending a run, resetting budgets or changing its contract", async () => {
  const w = world();
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await applyControl(w.ctx, w.id);
  const after = w.state.get(w.id);
  assert.equal(after.control.status, "applied");
  assert.equal(after.state, STATES.prOpen);
  assert.equal(after.reason, null);
  assert.equal(after.iteration, before.iteration);
  assert.deepEqual(after.cursor, before.cursor);
  assert.equal(after.prd_fingerprint, before.prd_fingerprint);
  assert.equal(w.runner.started.length, 0);
  assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === "gallivant:needs-human"));
});

test("rechecking unchanged red checks stops again; it does not bypass CI or spend another fixer", async () => {
  const w = world();
  w.ctx.readPrd = () => null;
  w.state.update(w.id, { cursor: { ...w.state.get(w.id).cursor, checks_sha: "a1b2c3d" } });
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "guard", conclusion: "FAILURE" })];
  w.gh.data.reviews = [review({ id: 1, by: "chatgpt-codex-connector[bot]", bot: true, at: at(1), body: "**Reviewed commit:** `a1b2c3d`" })];
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await w.tick.tick(); await w.tick.tick();
  assert.equal(w.state.get(w.id).reason, "checks-red");
  assert.equal(w.runner.started.length, 0);
});

test("the same recheck can reach ready after the external check passes", async () => {
  const w = world();
  w.ctx.readPrd = () => null;
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "guard", conclusion: "SUCCESS" })];
  w.gh.data.reviews = [review({ id: 1, by: "chatgpt-codex-connector[bot]", bot: true, at: at(1), body: "**Reviewed commit:** `a1b2c3d`" })];
  const tick = makeTick(w.ctx);
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await tick.tick(); await tick.tick();
  assert.equal(w.state.get(w.id).state, STATES.ready);
  assert.equal(w.runner.started.length, 0);
});

test("an update waits for a live run, then uses the existing resume with the same session and worktree", async () => {
  const w = world();
  w.runner.start("old", "claude", [], {});
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "resume", note: "Use the revised fixture. ``` keep literal" });
  assert.equal(await applyControl(w.ctx, w.id), false);
  assert.equal(w.state.get(w.id).control.status, "queued");
  assert.equal(w.runner.started.length, 1);
  w.runner.finish([], { exit: 0 });
  await applyControl(w.ctx, w.id);
  const run = w.runner.started[1];
  assert.ok(run.args.includes(before.session));
  assert.equal(run.opts.cwd, before.worktree);
  assert.match(run.args.at(-1), /Use the revised fixture/);
  assert.match(run.args.at(-1), /does not change the approved brief/);
  assert.equal(w.state.get(w.id).control.status, "applied");
  assert.equal(w.state.get(w.id).iteration, before.iteration);
});

test("failed resume preserves the message and dirty work; a later request can retry", async () => {
  const w = world();
  w.ctx.git.dirty = async () => ({ modified: 2, untracked: 0 });
  requestControl(w.ctx, { handle: w.id, action: "resume", note: "Finish the docs." });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.equal(w.state.get(w.id).control.note, "Finish the docs.");
  assert.equal(w.runner.started.length, 0);
  assert.equal(w.state.get(w.id).reason, "checks-red");
  assert.doesNotThrow(() => requestControl(w.ctx, { handle: w.id, action: "recheck" }));
});

test("interrupted delivery is not replayed, and closed PRs cannot be resumed", async () => {
  const w = world();
  const request = requestControl(w.ctx, { handle: w.id, action: "resume", note: "one update" });
  w.state.update(w.id, { control: { ...request, status: "applying" } });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.match(w.state.get(w.id).control.message, /interrupted/);
  requestControl(w.ctx, { handle: w.id, action: "resume" });
  w.gh.data.pr = prFixture({ state: "MERGED" });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.equal(w.runner.started.length, 0);
});
