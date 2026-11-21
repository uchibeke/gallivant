import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeRecoverySchedule } from "../lib/recovery_schedule.mjs";
import { makeRecoveryCooldowns, hostScope, providerScope, serviceScope } from "../lib/recovery_cooldown.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeState, newEntry } from "../lib/state.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { nextAttempt } from "../lib/execution_io.mjs";
import { makeGh } from "../lib/gh.mjs";
import { makePackageAuthPreflight } from "../lib/package_auth.mjs";
import { evaluateHosted } from "../lib/deliverable.mjs";
import { supervisorStatus } from "../lib/daemon.mjs";
import { CONFIG, T0, STATES, fakeGh, fakeGit, fakeNotify, fakeRunner, makeClock, silentLog, tempHome } from "./helpers.mjs";

test("structural scans skip large settled history and keep durable bounded lane cursors", t => {
  const now = Date.parse(T0);
  let time = now, reads = 0;
  const clock = { now: () => time };
  const records = Array.from({ length: 25_000 }, (_, i) => [`history-${i}`, { state: "done", workspace_cleanup: { status: "retained" } }]);
  const active = Array.from({ length: 13 }, (_, i) => [String(i).padStart(2, "0"), { state: "pr-open", pr: i + 1 }]);
  const terminal = [["cleanup", { state: "done", pr: 17, worktree: "/fixture", workspace_cleanup: { status: "pending" } }],
    ["settlement", { state: "done", last: { run: "owned", exit: null } }]];
  const state = { entries: pick => { reads++; return [...records, ...active, ...terminal].filter(pick); },
    chains: pick => [["settled", { status: "done" }], ["waiting", { status: "active" }]].filter(pick) };
  const home = tempHome(), options = { clock, home, limits: { host: 4 } };
  let service = makeRecoverySchedule(options);
  assert.deepEqual(service.scan(state, { cleanup: true }).ids, [...active, ...terminal].map(([id]) => id));
  assert.deepEqual(service.scan(state, {}).chains, ["waiting"]);
  time += 59_000; service.scan(state, {}); assert.equal(reads, 1);
  time += 1000; service.scan(state, {}); assert.equal(reads, 2);
  const due = active.map(([id]) => [id, time - 750]);
  const seen = [];
  for (const elapsed of [50, 100, 150, 200]) {
    const cycle = service.begin(), batch = cycle.batch("host", due);
    for (const id of batch.ids) { batch.start(id); seen.push(id); }
    time += elapsed;
    batch.progress();
    cycle.finish();
    service = makeRecoverySchedule(options);
  }
  assert.deepEqual(seen.slice(0, 13), active.map(([id]) => id));
  const saved = JSON.parse(readFileSync(join(home, "recovery-schedule.json")));
  assert.deepEqual(saved.metrics.percentiles.durationMs, { p50: 100, p95: 200, p99: 200 });
  assert.equal(saved.metrics.lanes.host.saturated, true);
  assert.equal(saved.metrics.lanes.host.progressed, 1);
  t.diagnostic(JSON.stringify({ active: active.length, retained: records.length, hostCapacity: 4, percentiles: saved.metrics.percentiles }));
});

function tickWorld() {
  const home = tempHome(), state = makeState(home), clock = makeClock(), runners = new Map();
  const config = { ...CONFIG, run_timeout_minutes: DEFAULTS.run_timeout_minutes, deliverable: null };
  const ctx = { home, state, clock, config, ownLogin: "me", gh: fakeGh(), git: fakeGit(), notify: fakeNotify(), readPrd: () => null, log: silentLog,
    runnerFor: id => runners.get(id) };
  function entry(key, overrides) {
    const [owner, repo, task] = key.split("/"), runner = fakeRunner(clock);
    runners.set(key, runner);
    const work = newEntry({ repo: `${owner}/${repo}`, harness: "codex", branch: `work/${task}`, base: "main", nowIso: T0, state: STATES.prOpen });
    state.put(key, { ...work, ...overrides });
    return runner;
  }
  return { ctx, state, clock, entry };
}

test("a slow host lane cannot delay local settlement, cancellation or an independent chain", { timeout: 10_000 }, async () => {
  const w = tickWorld(), host = "acme/slow/host", control = "acme/local/control", settlement = "acme/local/settle";
  w.entry(host, { pr: 1 });
  w.entry("acme/provider/wait", { state: STATES.needsHuman, reason: "provider-network", network_retry: {
    phase: "waiting", attempts: 0, run: "prior", code: "SERVICE_BUSY", first_at: T0, next_at: new Date(w.clock.now() + 60_000).toISOString(),
  } });
  w.ctx.cooldowns = { deferred: () => { throw Object.assign(new Error("unreadable fixture cooldown"), { code: "SERVICE_STATE_UNAVAILABLE" }); } };
  const cancelled = w.entry(control, { state: STATES.running });
  const done = w.entry(settlement, { state: STATES.done });
  const run = done.start("test", "unused", [], {}); done.finish([], { exit: 1 });
  w.state.update(settlement, { last: { run: run.id, exit: null } });
  w.state.update(control, { control: { id: "cancel", action: "cancel", status: "queued", at: T0 } });
  w.ctx.cleanupMergedWorkspace = async () => assert.fail("local settlement has no workspace to delete");
  const slow = Promise.withResolvers(), hostStarted = Promise.withResolvers(), otherChain = Promise.withResolvers(), progressed = Promise.withResolvers();
  w.ctx.gh.prView = async () => { hostStarted.resolve(); return slow.promise; };
  w.state.createChain({ name: "independent", status: "active", index: 0, repo: "acme/local", steps: [{ id: "acme/local/not-started", dispatch: "unknown" }] });
  w.ctx.notify.error = async () => otherChain.resolve();
  const update = w.state.update;
  w.state.update = (...args) => {
    const result = update(...args);
    if (w.state.get(settlement).last.exit != null && w.state.get(control).control.status === "applied") progressed.resolve();
    return result;
  };
  const ticker = makeTick(w.ctx), ticking = ticker.tick();
  try {
    await Promise.all([hostStarted.promise, otherChain.promise, progressed.promise]);
    assert.equal(w.state.get(settlement).last.exit, 1);
    assert.equal(w.state.get(control).control.status, "applied");
    assert.equal(w.state.getChain("independent").status, "stopped");
    assert.equal(cancelled.started.length, 0);
    w.clock.advance(1);
  } finally { slow.resolve({ state: "OPEN", headRefName: "work/host" }); await ticking; }
  assert.equal(ticker.metrics.durationMs, 60_000);
  assert.equal(ticker.metrics.lanes.control.progressed, 1);
  assert.equal(ticker.metrics.lanes.settlement.progressed, 1);
});

test("shared service cooldowns preserve long Retry-After across restart and serialize only the next outage probe", async () => {
  const home = tempHome(), now = Date.parse(T0);
  let time = now, calls = 0;
  const clock = { now: () => time }, scope = hostScope("github.com", "same-account-secret");
  let cooldowns = makeRecoveryCooldowns({ home, clock });
  const first = makeGh({ clock, cooldowns, credential: async () => ({ token: "same-account-secret" }), exec: async () => {
    calls++;
    throw Object.assign(new Error("gh rate limit"), { stderr: "HTTP 429", stdout: `HTTP/2.0 429 Too Many Requests\r\nRetry-After: 172800\r\nX-RateLimit-Reset: ${(now + 60000) / 1000}\r\n\r\n{}` });
  } });
  await assert.rejects(first.user(), { code: "GH_RATE_LIMIT" });
  cooldowns = makeRecoveryCooldowns({ home, clock });
  time += 2 * 3600_000; // The former chain cap must not cause an early probe.
  await assert.rejects(cooldowns.call(scope, () => assert.fail("must not call host")), { code: "SERVICE_COOLDOWN", retryAt: now + 172800_000 });
  assert.equal(await cooldowns.call(hostScope("github.com", "other-credential"), () => "available"), "available");
  time = now + 172800_000;
  const probe = Promise.withResolvers();
  const inFlight = cooldowns.call(scope, () => { calls++; return probe.promise; });
  await assert.rejects(cooldowns.call(scope, () => assert.fail("shared probe already in flight")), { code: "SERVICE_COOLDOWN" });
  probe.resolve("healthy"); assert.equal(await inFlight, "healthy");
  assert.equal(calls, 2);
  assert.equal(cooldowns.get(scope), null);
  assert.doesNotMatch(readFileSync(join(home, "recovery-cooldowns.json"), "utf8"), /same-account-secret/);
  const provider = providerScope("openai-agents", "account-one");
  cooldowns.record(provider, { httpStatus: 429, code: "AGENTS_QUOTA", retryAfterMs: 172800_000 });
  assert.equal(cooldowns.get(provider), null);
  cooldowns.record(provider, { httpStatus: 429, code: "AGENTS_THROTTLED", retryAfterMs: 16 * 24 * 3600_000 });
  assert.equal(cooldowns.get(provider).suspended, true);
  assert.equal(cooldowns.get(providerScope("openai-agents", "account-two")), null);
  assert.equal(nextAttempt(time, 10, 172800_000), time + 172800_000);
});

test("registry and evaluator preserve server deadlines on separate service identities", async () => {
  const clock = makeClock(), home = tempHome(), cooldowns = makeRecoveryCooldowns({ home, clock });
  const repo = "acme/widget", credential = { token: "registry-secret", host: "github.com", repository: repo };
  const config = { repos: [{ repo, package_auth: { provider: "github-packages", packages: ["@acme/widget"] } }] };
  let calls = 0;
  const fetch = async () => { calls++; return new Response(null, { status: 429, headers: { "Retry-After": "86400" } }); };
  const check = makePackageAuthPreflight({ fetch, clock, cooldowns });
  const input = { config, repo, credential, transport: "cli" };
  await assert.rejects(check(input), { code: "REGISTRY_CAPACITY", retryAt: clock.now() + 86400_000 });
  await assert.rejects(check(input), { code: "SERVICE_COOLDOWN" });
  const evaluator = serviceScope("completion", "https://api.aport.io", "fixture-key");
  await assert.rejects(cooldowns.call(evaluator, () => evaluateHosted({ passport: {}, context: {}, fetch, clock })), { status: 429 });
  assert.equal(cooldowns.get(evaluator).nextAt, clock.now() + 86400_000);
  assert.equal(calls, 2);
});

test("healthy multi-hour tools are investigated and missing final events do not become success", async () => {
  const w = tickWorld(), id = "acme/widget/tool";
  const runner = w.entry(id, { state: STATES.running });
  w.ctx.gh.prListByHead = async () => [];
  const run = runner.start("test", "unused", [], {});
  w.state.update(id, { last: { run: run.id, at: T0, exit: null } });
  runner.phase = () => "tool-observed";
  runner.kill = () => assert.fail("investigation must not signal a healthy tool");
  const tick = makeTick(w.ctx);
  w.clock.advance(15); await tick.tick();
  assert.equal(w.state.get(id).run_health.code, "observing-phase");
  w.clock.advance(7.05 * 60); await tick.tick();
  assert.equal(w.state.get(id).run_health.code, "investigate-no-progress");
  assert.equal(w.state.get(id).last.exit, null);
  runner.finish([], { exit: 0 }); await tick.tick();
  assert.equal(w.state.get(id).run_health.code, "missing-final-event");
  assert.equal(w.state.get(id).state, STATES.needsHuman);
});

test("supervision requires exact dead lease, pinned executable and host throttle", () => {
  const clock = makeClock(), lease = { pid: 4200, instance: "owned", identity: "v2:birth pinned coordinator" };
  const health = { ...lease, lastTick: new Date(clock.now() - 24 * 3600_000).toISOString() };
  const supervisor = { qualified: true, platform: "linux", executable: "/opt/release/bin/coordinator", nextRestartAt: clock.now() + 1000 };
  const probe = (present, identity, overrides = {}) => supervisorStatus({ lease, health, supervisor, clock, platform: "linux", exists: () => present, identity: () => identity, ...overrides });
  assert.equal(probe(true, lease.identity).owner, "live");
  assert.equal(probe(true, lease.identity).restartEligible, false);
  for (const identity of [null, "v2:reused unrelated process"]) assert.equal(probe(true, identity).owner, "unverified");
  assert.equal(probe(false, null).state, "throttled");
  clock.advance(1);
  assert.equal(probe(false, null).restartEligible, true);
  assert.equal(probe(false, null, { supervisor: null }).state, "unavailable");
  assert.equal(probe(false, null, { platform: "darwin" }).state, "observation-only");
  assert.equal(probe(false, null, { lease: null }).restartEligible, false);
  assert.equal(probe(false, null, { health: { ...health, stoppedAt: T0 } }).restartEligible, false);
});
