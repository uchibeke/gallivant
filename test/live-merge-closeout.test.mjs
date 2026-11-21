import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeExecution } from "../lib/execution.mjs";
import { makeTick } from "../lib/tick.mjs";
import { executionLive } from "../lib/execution_contract.mjs";
import { makeGit, worktreePath } from "../lib/git.mjs";
import { cleanupMergedWorkspace } from "../lib/workspace_cleanup.mjs";
import { controlPending } from "../lib/control_contract.mjs";
import { CONFIG, T0, at, makeClock, seededState, fakeRunner, fakeGh, fakeGit, fakeNotify, silentLog, prFixture, STATES } from "./helpers.mjs";

const HEAD = "a".repeat(40), MERGE = "b".repeat(40);
async function world(t, { remote = false, delayed = false } = {}) {
  const { state, id, home } = seededState({ state: STATES.prOpen,
    task: { completion: { version: 1, target: "integrated" } } });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = makeClock(at(6)), raw = fakeRunner(clock), calls = [];
  raw.root = join(home, "runs"); raw.dirOf = run => join(raw.root, run);
  let observation, killConfirmed = !delayed;
  const kill = raw.kill;
  raw.kill = run => { calls.push("kill"); return killConfirmed ? kill(run) : false; };
  const provider = remote ? "openai-agents" : "claude";
  const transport = remote ? {
    submit: async () => {
      observation = { providerJobId: "remote-job", sessionId: "remote-session", turnId: "remote-turn", state: "running", observedAt: clock.now(), events: [] };
      return observation;
    },
    inspect: async () => { calls.push("inspect"); return { ...observation, observedAt: clock.now() }; },
    cancel: async () => { calls.push("cancel"); return { confirmed: !delayed }; },
    collect: async () => assert.fail("retired remote results must not be collected or published"),
  } : null;
  const execution = makeExecution({ root: raw.root, taskId: id, provider, account: "operator", clock,
    ...(remote ? { transport } : { runner: raw }) });
  const job = remote
    ? await execution.submit({ operationId: "fix", inputHead: HEAD, allowance: { remainingUsd: 1, reservedUsd: 0.1 } })
    : await execution.start("fix", "fixture", [], { cwd: "/tmp/wt", execution: { operationId: "fix", inputHead: HEAD } });
  state.update(id, { harness: provider, session: job.execution.sessionId,
    execution: job.execution, last: { run: job.id, at: T0, exit: null }, cursor: { since: T0, fixed_sha: HEAD } });
  const gh = fakeGh({ pr: prFixture({ state: "MERGED", strictIdentity: true, headRefOid: HEAD,
    mergedAt: at(6), mergeCommit: { oid: MERGE } }) });
  gh.containsCommit = async () => true;
  let cleanupCalls = 0;
  const ctx = { config: { ...CONFIG, home }, state, clock, gh, git: fakeGit(), log: silentLog,
    notify: fakeNotify(), ownLogin: "me", runnerFor: () => raw, executionFor: () => execution, readPrd: () => null,
    cleanupMergedWorkspace: async () => { cleanupCalls++; return execution.current()?.running || executionLive(execution.current()) || controlPending(state.get(id).control)
      ? { status: "pending", reason: "author execution has not settled" } : { status: "retained", reason: "local work preserved" }; } };
  return { id, state, clock, raw, execution, gh, calls, ctx, tick: () => makeTick(ctx).tickEntry(id, state.get(id)),
    entry: () => state.get(id), cleanups: () => cleanupCalls,
    confirm: () => { killConfirmed = true; if (remote) observation.state = "cancelled"; } };
}

test("a maintainer merge retires only its owned local author and closes without readiness", async t => {
  const w = await world(t);
  w.state.update(w.id, { firstPartyReview: { status: "completed", verdict: "findings", head: HEAD },
    completionEvidence: { delivery: { head: HEAD, gate: { allow: false } } } });
  const before = w.entry();
  await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().reason, null);
  assert.equal(w.execution.current().running, false); assert.equal(w.execution.current().execution.collected, true);
  assert.equal(w.execution.state().stopped, "pr-merged"); assert.equal(w.entry().dispatch_stopped, undefined);
  assert.equal(w.entry().completionEvidence.integration.qualified, false);
  assert.equal(w.entry().workspace_cleanup.status, "retained"); assert.equal(w.cleanups(), 1);
  assert.equal(w.entry().iteration, before.iteration); assert.equal(w.raw.started.length, 1);
  assert.deepEqual(w.entry().firstPartyReview, before.firstPartyReview);
  assert.deepEqual(w.entry().completionEvidence.delivery, before.completionEvidence.delivery);
  assert.deepEqual(w.calls, ["kill"]);
  await w.tick(); assert.deepEqual(w.calls, ["kill"]); assert.equal(w.raw.started.length, 1);
});

test("accepted remote cancellation is observed without duplicate cancellation or late publication", async t => {
  const w = await world(t, { remote: true, delayed: true });
  await w.tick();
  assert.notEqual(w.entry().state, STATES.done); assert.equal(w.cleanups(), 0);
  assert.equal(w.entry().execution.providerState, "cancellation-requested");
  assert.equal(w.calls.filter(c => c === "cancel").length, 1);
  for (let i = 0; i < 3; i++) { w.clock.advance(3); await w.tick(); }
  assert.equal(w.calls.filter(c => c === "cancel").length, 1);
  assert.equal(w.gh.calls.filter(c => c[0] === "prView").length, 1, "cancellation owns pending observations");
  w.confirm(); w.clock.advance(3); await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.cleanups(), 1);
  assert.equal(w.execution.current().execution.quarantined, true);
  assert.equal(w.calls.filter(c => c === "cancel").length, 1);
});

test("delayed local cessation preserves the checkout until its exact writer is gone", async t => {
  const w = await world(t, { delayed: true });
  await w.tick(); await w.tick();
  assert.notEqual(w.entry().state, STATES.done); assert.equal(w.cleanups(), 0);
  w.confirm(); await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.cleanups(), 1);
});

test("active host observations use the saved cadence across coordinator recreation", async t => {
  const w = await world(t); w.gh.data.pr.state = "OPEN";
  await w.tick(); await w.tick();
  assert.equal(w.gh.calls.filter(c => c[0] === "prView").length, 1); assert.equal(w.calls.length, 0);
  w.clock.advance(CONFIG.poll_seconds / 60); await w.tick();
  assert.equal(w.gh.calls.filter(c => c[0] === "prView").length, 2);
  assert.equal(w.execution.current().running, true);
});

test("host outages, wrong identity and missing ancestry never cancel valid work", async t => {
  for (const fault of ["outage", "base", "branch", "url", "number", "cross-repository", "ancestry", "merge-proof"]) await t.test(fault, async t => {
    const w = await world(t);
    if (fault === "outage") w.gh.prView = async () => { throw new Error("host temporarily unavailable"); };
    if (fault === "base") w.gh.data.pr.baseRefName = "other";
    if (fault === "branch") w.gh.data.pr.headRefName = "other";
    if (fault === "url") w.gh.data.pr.url = "https://github.com/other/repo/pull/142";
    if (fault === "number") w.gh.data.pr.number = 143;
    if (fault === "cross-repository") w.gh.data.pr.isCrossRepository = true;
    if (fault === "ancestry") w.gh.containsCommit = async () => false;
    if (fault === "merge-proof") w.gh.data.pr.mergeCommit = null;
    await w.tick(); await w.tick();
    assert.equal(w.execution.current().running, true); assert.equal(w.execution.state().stopped, null);
    assert.equal(w.cleanups(), 0); assert.equal(w.calls.length, 0);
  });
});

test("foreign or unverified execution cannot be retired by a merged PR", async t => {
  for (const fault of ["run", "task", "provider", "account", "transport", "acceptance", "remote-turn"]) await t.test(fault, async t => {
    const w = await world(t, { remote: fault === "remote-turn" });
    if (fault === "run") w.state.update(w.id, { last: { ...w.entry().last, run: "someone-elses-run" } });
    else {
      const current = w.execution.current.bind(w.execution);
      w.execution.current = () => {
        const run = current(), execution = { ...run.execution };
        if (fault === "task") execution.taskId = "another-task";
        if (fault === "provider") execution.provider = "another-provider";
        if (fault === "account") execution.account = "another-account";
        if (fault === "transport") execution.transport = null;
        if (fault === "acceptance") execution.acceptance = "unknown";
        if (fault === "remote-turn") execution.turnId = null;
        return { ...run, execution };
      };
    }
    await w.tick();
    assert.equal(w.execution.state().stopped, null); assert.equal(w.calls.filter(c => c === "kill" || c === "cancel").length, 0);
    assert.notEqual(w.entry().state, STATES.done);
  });
});

test("a merged head newer than the saved cursor closes without certifying stale readiness", async t => {
  const w = await world(t); w.gh.data.pr.headRefOid = "c".repeat(40);
  await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.entry().cursor.fixed_sha, HEAD);
  assert.equal(w.entry().completionEvidence.terminal.head, "c".repeat(40));
  assert.equal(w.entry().completionEvidence.integration.qualified, false);
});

test("merged-author retirement retains real uncommitted and unpublished task work", async t => {
  const w = await world(t);
  w.ctx.config.worktrees = join(w.ctx.config.home, "worktrees");
  const path = worktreePath(w.ctx.config, "acme/widget", "widget-export");
  mkdirSync(path, { recursive: true });
  const git = args => execFileSync("git", args, { cwd: path, encoding: "utf8", stdio: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  git(["init", "-b", w.entry().branch]); writeFileSync(join(path, "app.txt"), "merged work\n");
  git(["add", "app.txt"]); git(["commit", "-m", "Fixture"]);
  git(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  w.gh.data.pr.headRefOid = git(["rev-parse", "HEAD"]);
  writeFileSync(join(path, "app.txt"), "uncommitted correction\n");
  writeFileSync(join(path, "unpublished.txt"), "retain me\n");
  w.state.update(w.id, { worktree: path });
  w.ctx.git = makeGit({ config: w.ctx.config });
  w.ctx.cleanupMergedWorkspace = (id, entry, pr) => cleanupMergedWorkspace(w.ctx, id, entry, pr);
  await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().workspace_cleanup.status, "retained");
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(join(path, "app.txt"), "utf8"), "uncommitted correction\n");
  assert.equal(readFileSync(join(path, "unpublished.txt"), "utf8"), "retain me\n");
});

test("merged authors settle queued corrections before cleanup despite pending provider health", async t => {
  for (const action of ["message", "resume", "recheck"]) await t.test(action, async t => {
    const w = await world(t), note = action === "message" ? "Preserve the full existing post." : "";
    const control = { id: "7e85d332-0a21-49b4-87e7-a0fa851212e1", action, note, status: "queued", interrupt: false, at: T0 };
    const history = [{ id: "older-control", action: "message", status: "failed", note: "Earlier operator context" }];
    w.state.update(w.id, { control, control_history: history });
    w.ctx.providerHealth = { get: () => ({ ok: false, pending: true }) };
    await w.tick();
    assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().control.status, "failed");
    assert.equal(w.entry().control.id, control.id); assert.equal(w.entry().control.note, note);
    assert.match(w.entry().control.message, /follow-up PRD/);
    assert.deepEqual(w.entry().control_history, history);
    assert.equal(w.cleanups(), 1); assert.equal(w.raw.started.length, 1);
  });
});

test("a hold arriving during merge proof fences retirement despite a queued correction", async t => {
  const w = await world(t);
  const control = { id: "correction", action: "message", note: "Keep the approved behavior", status: "queued", at: T0 };
  w.state.update(w.id, { control });
  w.gh.containsCommit = async () => {
    w.state.update(w.id, { hold: { active: true } });
    return true;
  };
  await w.tick();
  assert.equal(w.execution.state().stopped, null);
  assert.equal(w.execution.current().running, true);
  assert.deepEqual(w.entry().control, control);
  assert.equal(w.cleanups(), 0);

  w.gh.containsCommit = async () => true;
  w.state.update(w.id, { hold: { active: false } });
  w.clock.advance(CONFIG.poll_seconds / 60);
  await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.entry().control.status, "failed");
  assert.deepEqual(w.calls, ["kill"]);
  assert.equal(w.cleanups(), 1);
});

test("unconfirmed remote cancellation retains queued input until the owned run settles", async t => {
  const w = await world(t, { remote: true, delayed: true });
  w.state.update(w.id, { control: { id: "83c60b58-5e0f-4b6d-b68d-42b1f03a87b6", action: "message", note: "Keep existing behavior", status: "queued", interrupt: false, at: T0 } });
  w.ctx.providerHealth = { get: () => ({ ok: false, pending: true }) };
  await w.tick();
  assert.equal(w.entry().control.status, "queued"); assert.equal(w.cleanups(), 0);
  w.confirm(); w.clock.advance(3); await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().control.status, "failed");
  assert.equal(w.entry().control.note, "Keep existing behavior");
  assert.equal(w.calls.filter(c => c === "cancel").length, 1);
});
