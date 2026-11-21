import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTick } from "../lib/tick.mjs";
import { makePackageAuthPreflight } from "../lib/package_auth.mjs";
import { runRecoveryWork } from "../lib/recovery_io.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { applyControl } from "../lib/control.mjs";
import { model, render } from "../lib/commands/status.mjs";
import { why } from "../lib/commands/why.mjs";
import { runPage } from "../lib/tracker/pages.mjs";
import { completionView, coordinatorEntryActive } from "../lib/task_completion.mjs";
import { networkFailure, transientProviderFailure, retryPlan, validNetworkRetry, networkRecoveryDetail, needsAgentResume, networkRecoveryDeadline } from "../lib/network_recovery.mjs";
import { CONFIG, T0, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, claudeResultLines, silentLog, STATES, tempHome, fakeCredential, fakeIdentity, harnessBin, checkRun } from "./helpers.mjs";

const CAPACITY = "Selected model is at capacity. Please try a different model.";
const ERROR = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
function world(over = {}) {
  const home = tempHome(), worktree = join(home, "wt");
  mkdirSync(worktree);
  const clock = makeClock(), runner = fakeRunner(clock), git = fakeGit();
  const { state, id } = seededState({ worktree, ...over });
  const ctx = { home, clock, state, git, runnerFor: () => runner, gh: fakeGh(), notify: fakeNotify(),
    config: { ...CONFIG, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") }, codex: { ...CONFIG.harness.codex, bin: harnessBin(home, "codex") } } },
    log: silentLog, ownLogin: "me", readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity() };
  let tick = makeTick(ctx);
  return { ctx, clock, state, id, runner, git, entry: () => state.get(id),
    restart: () => { tick = makeTick(ctx); }, tick: () => tick.tick(),
    async fail(text = ERROR) {
      if (!runner.current()) {
        const result = await tick.startRun(id, state.get(id), { name: "test", prompt: "Implement the saved task" });
        state.update(id, { last: { at: T0, run: result.job.id, exit: null, event: "test" } });
      }
      runner.finish(state.get(id).harness === "codex" ? [
        JSON.stringify({ type: "thread.started", thread_id: state.get(id).session }),
        JSON.stringify({ type: "turn.failed", error: { message: text } }),
      ] : claudeResultLines({ ok: false, text }));
      await tick.tick();
    } };
}

test("only recognized terminal connectivity errors qualify, never prose, permissions or authentication", () => {
  const failed = { ok: false, finished: true, error: ERROR, denials: [] };
  assert.equal(networkFailure(failed), "ENOTFOUND");
  for (const code of ["EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"]) assert.equal(networkFailure({ ...failed, error: `Error: connect ${code}` }), code);
  for (const patch of [{ ok: true }, { finished: false }, { denials: ["blocked"] }, { error: "We should simulate ENOTFOUND" }, { error: "no result event" }, { error: "API Error: 401 ENOTFOUND" }, { error: "API Error: policy denied ENOTFOUND" }, { error: "API Error: 429 ETIMEDOUT" }, { error: "API Error: token expired ETIMEDOUT" }, { error: "API Error: weekly usage exhausted ENOTFOUND" }]) assert.equal(networkFailure({ ...failed, ...patch }), null);
});

test("an auxiliary Claude success cannot hide a terminal network failure from recovery", async () => {
  const w = world({ state: STATES.running, pr: null, url: null });
  w.ctx.gh.prListByHead = async () => [];
  const run = w.runner.start("start", "unused", [], {});
  w.state.update(w.id, { last: { at: T0, run: run.id, exit: null } });
  w.runner.finish([...claudeResultLines({ ok: false, text: ERROR }), JSON.stringify({
    type: "result", is_error: false, result: "", origin: { kind: "task-notification" },
  })]);
  await w.tick();
  assert.equal(w.entry().reason, "provider-network");
  assert.equal(w.entry().network_retry.code, "ENOTFOUND");
  assert.equal(w.entry().network_retry.phase, "waiting");
  assert.equal(w.runner.started.length, 1, "backoff still applies; no immediate duplicate launch");
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

test("a registry budget deferral preserves the original unspent network retry", async () => {
  const w = world();
  await w.fail();
  w.ctx.config.repos = [{ repo: w.entry().repo, package_auth: { provider: "github-packages", packages: ["@acme/editor"] } }];
  let expire = true, probes = 0;
  const preflight = makePackageAuthPreflight({ fetch: async () => {
    probes++;
    return { status: 200, body: { cancel: async () => {} } };
  } });
  w.ctx.packageAuthPreflight = input => expire ? runRecoveryWork(() => preflight(input), 0) : preflight(input);
  const original = w.entry().network_retry;
  w.clock.set(original.next_at);
  await w.tick();
  const waiting = w.entry().network_retry;
  assert.deepEqual(waiting, { ...original, next_at: at(1 + CONFIG.poll_seconds / 60) });
  assert.equal(networkRecoveryDeadline(waiting), networkRecoveryDeadline(original));
  assert.equal(w.entry().reason, "provider-network");
  assert.equal(w.runner.started.length, 1);
  assert.equal(probes, 0);

  expire = false;
  w.restart();
  await w.tick();
  assert.equal(probes, 0);
  w.clock.set(waiting.next_at);
  await w.tick();
  assert.equal(probes, 1);
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, original.attempts + 1);
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

for (const initial of [false, true]) test(`GitHub outage cannot reset the recovery deadline (${initial ? "initial" : "fix"} run)`, async () => {
  const w = world(initial ? { pr: null, state: STATES.running } : {});
  const method = initial ? "prListByHead" : "prView";
  const read = w.ctx.gh[method];
  w.ctx.gh[method] = async () => { throw new Error("GitHub unavailable"); };
  await w.fail();
  assert.equal(w.entry().network_retry.first_at, T0);
  assert.equal(w.entry().network_retry.phase, "reconciling");
  assert.equal(w.entry().last.exit, null);
  w.restart(); w.clock.advance(120); await w.tick();
  assert.equal(w.entry().network_retry.first_at, T0);
  assert.equal(w.runner.started.length, 1);
  w.ctx.gh[method] = read;
  await w.tick();
  assert.equal(w.entry().reason, "provider-network-exhausted");
  assert.equal(w.runner.started.length, 1);
});

test("recovery deadline is enforced after asynchronous dispatch preparation", async () => {
  const w = world(); await w.fail();
  w.ctx.credential = async options => {
    w.clock.advance(60);
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().reason, "provider-network-exhausted");
});

for (const action of ["resume", "message"]) test(`operator ${action} queued during automatic preparation wins without a duplicate launch`, async () => {
  const w = world(); await w.fail();
  const session = w.entry().session;
  w.ctx.credential = async options => {
    w.state.update(w.id, { control: { id: "operator-request", action, status: "queued", at: T0,
      note: action === "message" ? "Preserve the existing publication dates" : "", interrupt: false } });
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().control.status, "queued");
  assert.equal(w.entry().network_retry, null);
  w.ctx.credential = fakeCredential();
  await w.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().control.status, "applied");
  assert.equal(w.entry().session, session);
  if (action === "message") assert.match(w.runner.started[1].args.at(-1), /Preserve the existing publication dates/);
  await w.tick();
  assert.equal(w.runner.started.length, 2);
});

test("terminal provider availability has a strict shared classification and bounded category-specific policy", () => {
  const failure = error => ({ ok: false, finished: true, error, denials: [] });
  for (const [error, code] of [[CAPACITY, "MODEL_CAPACITY"],
    ["API Error: 503 Service Unavailable", "SERVICE_BUSY"], ["API Error: 429 Too Many Requests", "RATE_LIMITED"]]) {
    assert.equal(transientProviderFailure(failure(error)), code);
    assert.equal(transientProviderFailure({ ...failure(error), ok: true }), null);
    assert.equal(transientProviderFailure({ ...failure(error), finished: false }), null);
    assert.equal(transientProviderFailure({ ...failure(error), denials: ["policy"] }), null);
  }
  for (const error of ["workspace routing discovery failed", " ".repeat(600) + CAPACITY, "Retry the model in 5 minutes", `Example: ${CAPACITY}`, `${CAPACITY} Unexpected detail`, "API Error: 429",
    "Rate limit 429", "API Error: 429 usage exhausted", "API Error: 503 authentication failed", "API Error: token expired",
    "API Error: quota exceeded", "API Error: weekly usage limit reached; reset at 2099-01-01T00:00:00Z"]) {
    assert.equal(transientProviderFailure(failure(error)), null, error);
  }
  const plan = retryPlan("MODEL_CAPACITY");
  assert.equal(plan.window, 120 * 60_000);
  assert.deepEqual(plan.delays, [60_000, 300_000, ...Array(10).fill(900_000)]);
  assert.equal(retryPlan("ENOTFOUND").window, 60 * 60_000);
  assert.equal(retryPlan("ENOTFOUND").delays.length, 3);
  const saved = { code: "MODEL_CAPACITY", attempts: 4, first_at: T0, run: "run-4", phase: "waiting", next_at: at(36) };
  assert.equal(validNetworkRetry(saved), true);
  assert.match(networkRecoveryDetail(saved), /provider availability.*4\/12/);
  assert.equal(validNetworkRetry({ ...saved, attempts: 12 }), false);
  assert.equal(validNetworkRetry({ ...saved, code: "arbitrary-retry" }), false);
});

test("Codex capacity retries the original session with dirty files and unpublished commits after restart", async () => {
  const w = world({ harness: "codex" });
  const session = w.entry().session;
  w.git.dirty = async () => ({ modified: 5, untracked: 0 });
  w.git.unpushed = async () => ["first", "second", "third"].map(sha => ({ sha, subject: "preserved task change" }));
  const dirtyFile = join(w.entry().worktree, "partial-work.txt");
  writeFileSync(dirtyFile, "Uncommitted session work\n");
  w.git.mergeBase = async () => assert.fail("must not overwrite unfinished session work");
  await w.fail(CAPACITY);
  assert.equal(w.entry().network_retry.code, "MODEL_CAPACITY");
  assert.equal(w.entry().network_retry.next_at, at(1));
  w.restart(); await w.tick();
  assert.equal(w.runner.started.length, 1);
  w.clock.advance(1); await w.tick();
  const run = w.runner.started[1];
  assert.equal(w.entry().session, session);
  assert.deepEqual(run.args.slice(0, 3), ["exec", "resume", session]);
  assert.match(run.args.at(-1), /5 modified/);
  assert.match(run.args.at(-1), /3 commits on this branch are already made and NOT yet pushed/);
  assert.match(run.args.at(-1), /first preserved task change/);
  assert.equal(readFileSync(dirtyFile, "utf8"), "Uncommitted session work\n");
  assert.equal(w.entry().iteration, 0);
  w.restart(); await w.tick();
  assert.equal(w.runner.started.length, 2, "live retry cannot be duplicated by a restart");
});

test("capacity keeps waiting past the former three-retry limit, then stops after two hours", async () => {
  const w = world(); await w.fail(CAPACITY);
  for (const delay of [1, 5, 15, 15]) {
    w.restart(); w.clock.advance(delay); await w.tick(); await w.fail(CAPACITY);
  }
  assert.equal(w.entry().network_retry.attempts, 4);
  assert.equal(w.entry().network_retry.phase, "waiting");
  assert.equal(w.entry().network_retry.next_at, at(51));
  w.clock.advance(84); await w.tick();
  assert.equal(w.entry().reason, "provider-network-exhausted");
  assert.equal(w.runner.started.length, 5);
  w.restart(); w.clock.advance(15); await w.tick();
  assert.equal(w.runner.started.length, 5);
  assert.equal(w.ctx.notify.sent.filter(x => x[0] === "needs").length, 1);
});

test("an authentication health failure stops capacity recovery without another provider call", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.ctx.providerHealth = { get: () => ({ ok: false, code: "AUTH_REQUIRED" }) }; w.restart();
  w.clock.advance(1); await w.tick();
  assert.equal(w.entry().reason, "network-recovery-blocked");
  assert.equal(w.entry().network_retry.phase, "blocked");
  assert.match(w.entry().last.event, /authentication.*doctor/);
  assert.equal(w.runner.started.length, 1);
});

test("a terminal PR closes capacity recovery even while provider health is pending", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.ctx.providerHealth = { get: () => ({ ok: false, pending: true }) }; w.restart();
  w.ctx.gh.data.pr.state = "CLOSED";
  w.clock.advance(2); await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.runner.started.length, 1);
});

test("a PR becoming terminal during retry credential preparation prevents any replacement launch", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.ctx.credential = async options => {
    w.ctx.gh.data.pr.state = "CLOSED";
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().network_retry, null);
});

test("capacity failure after a partial push accounts for progress before returning to review", async () => {
  const w = world();
  w.ctx.gh.data.pr.headRefOid = "b2c3d4e";
  await w.fail(CAPACITY);
  assert.equal(w.entry().iteration, 1);
  assert.equal(w.entry().cursor.fixed_sha, "b2c3d4e");
  assert.equal(w.entry().network_retry ?? null, null);
  w.restart(); await w.tick();
  assert.equal(w.entry().iteration, 1);
  assert.equal(w.runner.started.length, 1);
});

test("usage exhaustion after a capacity retry becomes an actionable stop without another paid loop", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.clock.advance(1); await w.tick();
  await w.fail("API Error: weekly usage limit reached");
  assert.equal(w.entry().reason, "harness-error");
  assert.equal(w.entry().network_retry, null);
  w.restart(); w.clock.advance(15); await w.tick();
  assert.equal(w.runner.started.length, 2);
});

test("a verified merge during capacity retry preparation closes without dispatch or discarding dirty work", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.git.dirty = async () => ({ modified: 2, untracked: 1 });
  const merge = "a".repeat(40);
  w.ctx.gh.containsCommit = async (_repo, base, sha) => base === "main" && sha === merge;
  w.ctx.credential = async options => {
    Object.assign(w.ctx.gh.data.pr, { state: "MERGED", strictIdentity: true, mergedAt: at(1), mergeCommit: { oid: merge } });
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().network_retry, null);
});

test("a replacement capacity worker cannot be duplicated by ticks or a coordinator restart", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.current().running, true);
  for (let tick = 0; tick < 3; tick++) { w.restart(); w.clock.advance(15); await w.tick(); }
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, 1);
});

test("an open PR retargeted during capacity retry preparation cannot dispatch under a new identity", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.ctx.credential = async options => {
    Object.assign(w.ctx.gh.data.pr, { strictIdentity: true, baseRefName: "different-base" });
    return fakeCredential()(options);
  };
  w.clock.advance(1); await w.tick();
  assert.equal(w.entry().reason, "pr-identity");
  assert.equal(w.entry().network_retry, null);
  assert.equal(w.runner.started.length, 1);
});

test("backoff observes a maintainer merge at the host cadence before the paid retry is due", async () => {
  const w = world(); await w.fail(CAPACITY);
  const merge = "a".repeat(40);
  w.ctx.gh.containsCommit = async () => true;
  Object.assign(w.ctx.gh.data.pr, { state: "MERGED", strictIdentity: true, mergedAt: T0, mergeCommit: { oid: merge } });
  w.state.update(w.id, { review_next_at: w.clock.now() });
  await w.tick();
  assert.equal(w.entry().state, STATES.done);
  assert.equal(w.runner.started.length, 1);
});

test("an open PR stays in backoff and pending provider health does not flood host reads", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.state.update(w.id, { review_next_at: w.clock.now() });
  let reads = 0;
  const view = w.ctx.gh.prView;
  w.ctx.gh.prView = async (...args) => { reads++; return view(...args); };
  w.ctx.providerHealth = { get: () => ({ ok: false, pending: true }) }; w.restart();
  await w.tick();
  for (let tick = 0; tick < 3; tick++) await w.tick();
  assert.equal(reads, 1);
  w.clock.advance(1); await w.tick();
  assert.equal(reads, 2, "the cadence is brought forward once to the retry deadline");
  assert.equal(w.runner.started.length, 1);
  w.clock.advance(1); await w.tick();
  assert.equal(reads, 2, "pending health does not cause another read before the next host deadline");
  assert.equal(w.runner.started.length, 1);
});

test("host read failures respect polling cadence and cannot extend an expired capacity window", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.state.update(w.id, { review_next_at: w.clock.now() });
  let reads = 0;
  w.ctx.gh.prView = async () => { reads++; throw new Error("host down with private diagnostics"); };
  await w.tick(); await w.tick();
  assert.equal(reads, 1);
  w.clock.advance(2); await w.tick(); await w.tick();
  assert.equal(reads, 2, "a due retry with failed host evidence does not poll on each fast tick");
  assert.equal(w.runner.started.length, 1);
  w.clock.advance(118); await w.tick();
  assert.equal(w.entry().reason, "provider-network-exhausted");
  assert.equal(w.entry().network_retry.phase, "exhausted");
  assert.equal(w.runner.started.length, 1);
  assert.doesNotMatch(JSON.stringify(w.entry()), /private diagnostics/);
});

test("a health refresh becoming pending during retry preparation restores the unspent attempt", async () => {
  const w = world(); await w.fail(CAPACITY);
  let pending = false;
  w.ctx.providerHealth = { get: () => pending ? { ok: false, pending: true } : { ok: true } }; w.restart();
  w.ctx.credential = async options => { pending = true; return fakeCredential()(options); };
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().network_retry.phase, "waiting");
  assert.equal(w.entry().network_retry.attempts, 0);
  assert.equal(w.entry().network_retry.first_at, T0);
  await w.tick();
  assert.equal(w.runner.started.length, 1);
  pending = false; w.ctx.credential = fakeCredential();
  w.clock.advance(2); await w.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, 1);
  await w.tick();
  assert.equal(w.runner.started.length, 2);
});

test("a pre-dispatch pending-health race cannot erase a cancellation or extend the recovery window", async () => {
  for (const mode of ["cancel", "expired"]) {
    const w = world(); await w.fail(CAPACITY);
    let pending = false;
    w.ctx.providerHealth = { get: () => pending ? { ok: false, pending: true } : { ok: true } }; w.restart();
    w.ctx.credential = async options => {
      pending = true;
      if (mode === "cancel") w.state.update(w.id, { dispatch_stopped: "cancellation-requested" });
      else w.clock.advance(120);
      return fakeCredential()(options);
    };
    w.clock.advance(1); await w.tick();
    assert.equal(w.runner.started.length, 1, mode);
    if (mode === "cancel") assert.equal(w.entry().dispatch_stopped, "cancellation-requested");
    else { await w.tick(); assert.equal(w.entry().reason, "provider-network-exhausted"); }
  }
});

test("a future review poll cannot delay a due healthy capacity retry", async () => {
  const w = world(); await w.fail(CAPACITY);
  w.state.update(w.id, { review_next_at: w.clock.now() + 10 * 60_000 });
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, 1);
});

test("a pending-health refusal resumes once immediately after recovery despite a future review poll", async () => {
  const w = world(); await w.fail(CAPACITY);
  let pending = false;
  w.ctx.config.poll_seconds = 600;
  w.ctx.providerHealth = { get: () => pending ? { ok: false, pending: true } : { ok: true } }; w.restart();
  w.ctx.credential = async options => { pending = true; return fakeCredential()(options); };
  w.clock.advance(1); await w.tick();
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().network_retry.attempts, 0);
  pending = false; w.ctx.credential = fakeCredential();
  await w.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.entry().network_retry.attempts, 1);
  await w.tick();
  assert.equal(w.runner.started.length, 2);
});
