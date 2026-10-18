import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTick } from "../lib/tick.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { applyControl } from "../lib/control.mjs";
import { model, render } from "../lib/commands/status.mjs";
import { why } from "../lib/commands/why.mjs";
import { runPage } from "../lib/tracker/pages.mjs";
import { completionView, coordinatorEntryActive } from "../lib/task_completion.mjs";
import { networkFailure, needsAgentResume } from "../lib/network_recovery.mjs";
import { CONFIG, T0, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, claudeResultLines, silentLog, STATES, tempHome, fakeCredential, fakeIdentity, harnessBin, checkRun } from "./helpers.mjs";

const ERROR = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
function world(over = {}) {
  const home = tempHome(), worktree = join(home, "wt");
  mkdirSync(worktree);
  const clock = makeClock(), runner = fakeRunner(clock), git = fakeGit();
  const { state, id } = seededState({ worktree, ...over });
  const ctx = { home, clock, state, git, runnerFor: () => runner, gh: fakeGh(), notify: fakeNotify(),
    config: { ...CONFIG, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") } } },
    log: silentLog, ownLogin: "me", readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity() };
  let tick = makeTick(ctx);
  return { ctx, clock, state, id, runner, git, entry: () => state.get(id),
    restart: () => { tick = makeTick(ctx); }, tick: () => tick.tick(),
    async fail(text = ERROR) {
      if (!runner.current()) {
        const result = await tick.startRun(id, state.get(id), { name: "test", prompt: "Implement the saved task" });
        state.update(id, { last: { at: T0, run: result.job.id, exit: null, event: "test" } });
      }
      runner.finish(claudeResultLines({ ok: false, text }));
      await tick.tick();
    } };
}

test("only recognized terminal connectivity errors qualify, never prose, permissions or authentication", () => {
  const failed = { ok: false, finished: true, error: ERROR, denials: [] };
  assert.equal(networkFailure(failed), "ENOTFOUND");
  for (const code of ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) assert.equal(networkFailure({ ...failed, error: `Error: connect ${code}` }), code);
  for (const patch of [{ ok: true }, { finished: false }, { denials: ["blocked"] }, { error: "We should simulate ENOTFOUND" }, { error: "no result event" }, { error: "API Error: 401 ENOTFOUND" }, { error: "API Error: policy denied ENOTFOUND" }, { error: "API Error: 429 ETIMEDOUT" }]) assert.equal(networkFailure({ ...failed, ...patch }), null);
});

test("backoff survives daemon restart, resumes the same session once and preserves dirty work and cursors", async () => {
  const w = world();
  w.git.dirty = async () => ({ modified: 2, untracked: 1 });
  w.git.mergeBase = async () => assert.fail("must not merge over unfinished work");
  const before = w.entry();
  await w.fail();
  assert.equal(w.entry().network_retry.phase, "waiting");
  assert.equal(w.entry().network_retry.next_at, at(1));
  assert.equal(w.ctx.notify.sent.length, 0);
  assert.equal(model(w.ctx).running[0].label, "retrying");
  assert.match(why(w.ctx, { handle: w.id }).text ?? why(w.ctx, { handle: w.id }), /ENOTFOUND/);
  w.restart();
  await w.tick();
  assert.equal(w.runner.started.length, 1);
  w.clock.advance(1);
  await w.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, 1);
  assert.equal(w.entry().network_retry.phase, "running");
  assert.equal(w.entry().session, before.session);
  assert.equal(w.entry().iteration, before.iteration);
  assert.deepEqual(w.entry().cursor, before.cursor);
  assert.match(w.runner.started[1].args.at(-1), /2 modified and 1 untracked/);
  assert.match(w.runner.started[1].args.at(-1), /do not repeat completed external actions/);
  await w.tick();
  assert.equal(w.runner.started.length, 2);
});

test("three automatic resumes exhaust the budget without counting fake review rounds", async () => {
  const w = world();
  await w.fail();
  for (const delay of [1, 5, 15]) {
    w.clock.advance(delay);
    await w.tick();
    await w.fail();
  }
  assert.equal(w.runner.started.length, 4);
  assert.equal(w.entry().reason, "provider-network-exhausted");
  assert.equal(w.entry().network_retry.attempts, 3);
  assert.equal(w.entry().iteration, 0);
  w.restart(); w.clock.advance(120); await w.tick();
  assert.equal(w.runner.started.length, 4);
  assert.equal(w.ctx.notify.sent.filter(x => x[0] === "needs").length, 1);
});

test("the one-hour deadline applies even when provider preflight remains unavailable", async () => {
  const w = world(); await w.fail();
  w.ctx.providerHealth = { get: () => ({ ok: false }) }; w.restart();
  w.clock.advance(5); await w.tick();
  assert.equal(w.runner.started.length, 1);
  w.clock.advance(56); await w.tick();
  assert.equal(w.entry().reason, "provider-network-exhausted");
});

test("an ambiguous launch is never replayed after a crash", async () => {
  const w = world(); await w.fail();
  w.state.update(w.id, { network_retry: { ...w.entry().network_retry, phase: "launching" } });
  w.restart(); await w.tick();
  assert.equal(w.entry().reason, "network-recovery-unverified");
  assert.equal(w.runner.started.length, 1);
});

test("missing process ownership, closed PRs, cancellation and iteration caps prevent resubmission", async () => {
  for (const mode of ["missing", "closed", "cancelled", "iterations"]) {
    const w = world(); await w.fail(); w.clock.advance(1);
    if (mode === "missing") w.runner.current = () => null;
    if (mode === "closed") w.ctx.gh.data.pr.state = "CLOSED";
    if (mode === "cancelled") w.state.update(w.id, { dispatch_stopped: "cancelled" });
    if (mode === "iterations") w.state.update(w.id, { iteration: CONFIG.max_iterations });
    await w.tick();
    assert.equal(w.runner.started.length, 1, mode);
    if (mode === "closed") assert.equal(w.entry().state, STATES.done);
  }
});

test("initial runs without a PR can resume, and successful completion clears the network streak", async () => {
  const w = world({ pr: null, state: STATES.running }); await w.fail();
  assert.equal(w.entry().reason, "provider-network");
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 2);
  w.runner.finish(claudeResultLines()); await w.tick();
  assert.equal(w.entry().network_retry, null);
});

test("queued recheck cannot erase a failed agent or its pending recovery", async () => {
  const w = world(); await w.fail();
  const before = w.entry().network_retry;
  w.state.update(w.id, { control: { id: "recheck", action: "recheck", status: "queued", at: T0 } });
  await applyControl(w.ctx, w.id);
  assert.equal(w.entry().control.status, "failed");
  assert.match(w.entry().control.message, /Resume agent/);
  assert.equal(w.entry().reason, "provider-network");
  assert.deepEqual(w.entry().network_retry, before);
  assert.equal(needsAgentResume({ reason: "reviewer-silent", last: { exit: 1, error: ERROR } }), true);
});

test("manual resume resets the exhausted retry budget through the normal preflight", async () => {
  const w = world(); await w.fail();
  await resume(w.ctx, { handle: w.id });
  assert.equal(w.entry().network_retry, null);
  assert.equal(w.runner.started.length, 2);
});

test("preflight refusal stops automatic recovery without resetting the bound", async () => {
  const w = world(); await w.fail();
  w.ctx.config.harness.claude.bin = harnessBin(w.ctx.home, "claude", { signedIn: false });
  w.clock.advance(1); await w.tick();
  assert.equal(w.entry().reason, "network-recovery-blocked");
  assert.equal(w.entry().network_retry.attempts, 1);
  assert.equal(w.runner.started.length, 1);
});

test("local sign-in health never claims API connectivity", () => {
  const text = render({ daemon: { alive: true, startedAt: T0, probes: { claude: { ok: true, scope: "local-sign-in" } } }, running: [], needs_you: [], done: [], chains: [] });
  assert.match(text, /signed-in \(API unchecked\)/);
});

test("the run page explains pending recovery and disables PR recheck", async () => {
  const w = world(); await w.fail();
  const html = runPage({ id: w.id, entry: w.entry(), handle: "widget#142", run: w.runner.current(), maxIterations: 3, model: model(w.ctx), controlToken: "test-token" });
  assert.match(html, /waiting for API connectivity/);
  assert.match(html, /data-action="recheck" data-available="false"[^>]*disabled/);
  assert.match(html, /An agent failure needs Resume agent/);
});

test("unknown remote acceptance and non-network errors never enter local recovery", async () => {
  for (const mode of ["remote", "auth", "incomplete", "denied"]) {
    const w = world();
    const run = w.runner.start("test", "unused", [], {});
    w.state.update(w.id, { last: { at: T0, run: run.id, exit: null } });
    let lines = claudeResultLines({ ok: false, text: mode === "auth" ? "API Error: 401 authentication failed" : ERROR });
    if (mode === "incomplete") lines = lines.slice(0, -1);
    if (mode === "denied") { const result = JSON.parse(lines.at(-1)); result.permission_denials = [{ tool_name: "Bash", tool_input: {} }]; lines[lines.length - 1] = JSON.stringify(result); }
    if (mode === "remote") w.runner.capabilities = { transport: "remote" };
    w.runner.finish(lines); await w.tick();
    assert.equal(w.entry().network_retry ?? null, null, mode);
    assert.equal(w.entry().state, STATES.needsHuman, mode);
  }
});

test("malformed persisted retry schedules stop rather than becoming an unbounded loop", async () => {
  const w = world(); await w.fail();
  w.state.update(w.id, { network_retry: { ...w.entry().network_retry, next_at: "invalid" } });
  w.restart(); await w.tick();
  assert.equal(w.entry().reason, "network-recovery-unverified");
  assert.equal(w.runner.started.length, 1);
});

test("a push followed by a network error counts its round before any recovery and respects the cap", async () => {
  const w = world({ iteration: CONFIG.max_iterations - 1 });
  w.ctx.gh.data.pr.headRefOid = "b2c3d4e";
  w.ctx.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", conclusion: "FAILURE" })];
  await w.fail();
  assert.equal(w.entry().iteration, CONFIG.max_iterations);
  assert.equal(w.entry().cursor.fixed_sha, "b2c3d4e");
  assert.equal(w.entry().reason, "iterations");
  assert.equal(w.entry().network_retry, null);
  assert.ok(w.ctx.gh.calls.some(c => c[0] === "comment"));
  w.clock.advance(60); w.restart(); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().iteration, CONFIG.max_iterations);
});

test("a recovery that publishes progress clears its streak and accounts for the pushed head once", async () => {
  const w = world(); await w.fail();
  w.clock.advance(1); await w.tick();
  w.ctx.gh.data.pr.headRefOid = "b2c3d4e";
  await w.fail();
  assert.equal(w.entry().iteration, 1);
  assert.equal(w.entry().network_retry, null);
  assert.equal(w.entry().cursor.fixed_sha, "b2c3d4e");
  await w.tick();
  assert.equal(w.entry().iteration, 1);
  assert.equal(w.runner.started.length, 2);
});

test("embedded hosts continue waking pending network recovery and stop at exhaustion or cancellation", async () => {
  const w = world(); await w.fail();
  assert.equal(completionView(null, w.entry()).status, "pending");
  assert.equal(completionView(null, w.entry()).monitoring, true);
  assert.equal(coordinatorEntryActive(w.entry()), true);
  const stopped = { ...w.entry(), reason: "provider-network-exhausted", network_retry: { ...w.entry().network_retry, phase: "exhausted" } };
  assert.equal(completionView(null, stopped).status, "blocked");
  assert.equal(coordinatorEntryActive(stopped), false);
  assert.equal(coordinatorEntryActive({ ...w.entry(), dispatch_stopped: "cancelled" }), false);
});

test("recovery state retains the error code without copying credential-bearing failure text", async () => {
  const w = world();
  await w.fail("API Error: getaddrinfo ENOTFOUND https://user:secret-value@proxy.invalid");
  assert.equal(w.entry().network_retry.code, "ENOTFOUND");
  assert.doesNotMatch(JSON.stringify(w.entry()), /secret-value|proxy\.invalid/);
});

test("cancellation arriving during retry preparation prevents the replacement launch", async () => {
  const w = world(); await w.fail();
  w.ctx.credential = async options => {
    w.state.update(w.id, { dispatch_stopped: "cancellation-requested" });
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().dispatch_stopped, "cancellation-requested");
});
