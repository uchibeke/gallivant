import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, cpSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeExecution, executionLive, assertExecutionDependency } from "../lib/execution.mjs";
import { executionRegistry, adapters, buildRun } from "../lib/harness.mjs";
import { makeProviderHealth } from "../lib/provider_health.mjs";
import { makeRunner } from "../lib/run.mjs";
import { journalFor } from "../lib/execution_journal.mjs";
import { logWindow, LOG_LIMITS, appendProjection } from "../lib/run_log.mjs";
import { streamRun, sliceRun } from "../lib/tracker/stream.mjs";
import { writeJsonAtomic, readJson } from "../lib/fs.mjs";
import { makeState, newEntry, STATES, idSlug } from "../lib/state.mjs";
import { routes } from "../lib/commands/serve.mjs";
import { makeTick } from "../lib/tick.mjs";
import { reconcileExecutionResult } from "../lib/execution_result.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { acquireProcessLock } from "../lib/daemon.mjs";
import { makeGit } from "../lib/git.mjs";
import { execFileAsync } from "../lib/gh.mjs";
import { requestControl, applyControl } from "../lib/control.mjs";
import { tempHome, makeClock, CONFIG, T0, fakeGh, fakeNotify, silentLog, fakeGit, fakeCredential, fakeIdentity } from "./helpers.mjs";
const allowance = { remainingUsd: 1, reservedUsd: 0.1 };
const input = { operationId: "first", inputHead: "a".repeat(40), allowance };
const sha = text => createHash("sha256").update(text).digest("hex");
function remote(provider = "openai-agents", overrides = {}) {
  const root = tempHome(), clock = makeClock(), calls = [], jobs = new Map();
  let observation = null, seq = 0;
  const transport = {
    prepare: async () => ({ environment: "sandbox" }),
    submit: async req => {
      calls.push(["submit", req]);
      const accepted = jobs.get(req.idempotencyKey) || { providerJobId: `job-${++seq}`, sessionId: `session-${seq}`, turnId: `turn-${seq}` };
      jobs.set(req.idempotencyKey, accepted);
      observation = { ...accepted, state: "running", observedAt: clock.now(), events: [] };
      return accepted;
    },
    continue: async req => { calls.push(["continue", req]); return { providerJobId: `job-${++seq}`, sessionId: req.sessionId, turnId: `turn-${seq}` }; },
    lookup: async req => { calls.push(["lookup", req]); const job = jobs.get(req.intent.idempotencyKey); return job ? { ...job, state: "running", observedAt: clock.now() } : null; },
    inspect: async req => { calls.push(["inspect", req]); return observation; },
    collect: async req => { calls.push(["collect", req]); return { ...req, signal: undefined, outcome: { finished: true, ok: true, denials: [], cost: null, lastMessage: "saved result" } }; },
    cancel: async req => { calls.push(["cancel", req]); return { confirmed: true }; },
    ...overrides,
  };
  const capabilities = { ...executionRegistry[provider], available: true, environments: ["sandbox"], policy: ["workspace-write"], continuation: "native-session", preparation: "tool-free-fixture", controls: { cancel: true, interrupt: false } };
  const options = { root, taskId: "acme/widget/remote", provider, account: "test", transport, capabilities, clock, jitter: () => 0 };
  return { root, clock, calls, transport, capabilities, service: makeExecution(options), reopen: () => makeExecution(options), observe: patch => { observation = { ...observation, ...patch }; }, jobs };
}

test("predecessor service is required and remote selections remain unavailable", () => {
  assert.throws(() => assertExecutionDependency(null), { code: "EXECUTION_DEPENDENCY" });
  assertExecutionDependency(() => {});
  assert.equal(executionRegistry["openai-agents"].available, false);
  assert.equal(executionRegistry["codex-cloud"].available, false);
  for (const name of Object.keys(adapters)) assert.equal(executionRegistry[name].adapter, adapters[name]);
  const spec = buildRun({ harness: "codex", config: CONFIG, mode: "start", prompt: "offline", cwd: tempHome() });
  assert.equal(spec.cmd, CONFIG.harness.codex.bin);
  assert.ok(spec.args.includes('sandbox_mode="workspace-write"'));
});

test("missing predecessor module stops context startup with a dependency remedy", async () => {
  const dir = tempHome(); cpSync(new URL("../lib", import.meta.url), join(dir, "lib"), { recursive: true });
  rmSync(join(dir, "lib", "tasks.mjs"));
  await assert.rejects(import(pathToFileURL(join(dir, "lib", "context.mjs"))), error => error.code === "EXECUTION_DEPENDENCY" && /merge.*predecessor/.test(error.message));
});

for (const provider of ["openai-agents", "codex-cloud"]) {
  test(`${provider} fixture: no executable/PID, exact owned continuation and restart result retrieval`, async () => {
    const f = remote(provider), prepared = await f.service.prepare({ environment: "sandbox" });
    assert.deepEqual(prepared, { environment: "sandbox" });
    const job = await f.service.submit(input);
    assert.equal(job.pid, undefined); assert.equal(job.bin, undefined);
    assert.equal(job.execution.acceptance, "accepted");
    assert.equal(f.reopen().inspect().id, job.id);
    f.observe({ state: "succeeded", events: [{ eventId: "delta-2", sequence: 2, type: "output", data: "second", timestamp: 2 }, { eventId: "delta-1", sequence: 1, type: "output", data: "first", timestamp: 1 }], cursor: "page-2" });
    await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.providerState, "retrieving-results");
    await f.service.collect();
    assert.equal(f.reopen().current().running, false);
    rmSync(join(f.service.dirOf(job.id), "job.log"));
    assert.equal((await f.reopen().collect()).outcome.lastMessage, "saved result");
    await assert.rejects(f.service.continue({ ...input, operationId: "wrong", sessionId: "another-provider-session" }), { code: "EXECUTION_CONTINUATION" });
    const next = await f.service.continue({ ...input, operationId: "correction", sessionId: job.execution.sessionId });
    assert.equal(next.execution.sessionId, job.execution.sessionId);
    assert.equal(f.calls.filter(x => x[0] === "continue").length, 1);
  });
  test(`${provider} fixture: lost reply persists intent and reconciles without duplicate paid dispatch`, async () => {
    const f = remote(provider), submit = f.transport.submit;
    f.transport.submit = async req => { await submit(req); throw new Error("reply lost"); };
    await assert.rejects(f.service.submit(input), /reply lost/);
    assert.equal(f.reopen().current().execution.acceptance, "unknown");
    await assert.rejects(f.reopen().submit(input), { code: "EXECUTION_UNKNOWN" });
    await f.reopen().reconcile({ force: true });
    assert.equal(f.reopen().current().execution.acceptance, "accepted");
    const recovered = await f.reopen().submit(input);
    assert.equal(recovered.execution.providerJobId, "job-1");
    assert.equal(f.calls.filter(x => x[0] === "submit").length, 1);
    await assert.rejects(f.service.submit({ ...input, inputHead: "b".repeat(40) }), { code: "EXECUTION_CONFLICT" });
  });
}

test("unknown acceptance without lookup stays visible through startup and periodic reconciliation", async () => {
  const f = remote("codex-cloud", { submit: async () => { throw new Error("connection lost"); }, lookup: undefined });
  await assert.rejects(f.service.submit(input));
  await f.reopen().reconcile({ force: true });
  const state = f.reopen().inspect().execution;
  assert.equal(state.providerState, "status-unknown"); assert.match(state.recoveryAction, /manually/);
  assert.equal(state.costUsd, null);
  await assert.rejects(f.service.submit({ ...input, operationId: "new" }), { code: "BUSY" });
});

test("concurrent dispatch and cancellation share durable task ownership", async () => {
  const f = remote(); let accept;
  const original = f.transport.submit;
  f.transport.submit = req => new Promise(resolve => { accept = () => original(req).then(resolve); });
  const pending = f.service.submit(input);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.reopen().submit(input), /already running/);
  await assert.rejects(f.reopen().cancel(), /already running/);
  accept(); await pending;
  await f.service.cancel();
  await assert.rejects(f.service.submit({ ...input, operationId: "after-stop" }), { code: "EXECUTION_STOPPED" });
});

test("deadline fences late submission acknowledgement without retries", async () => {
  let reply;
  const f = remote("openai-agents", { submit: () => new Promise(resolve => { reply = resolve; }) });
  const short = makeExecution({ root: f.root, taskId: "acme/widget/remote", provider: "openai-agents", account: "test", transport: f.transport, capabilities: f.capabilities, clock: f.clock, limits: { deadlineMs: 10 } });
  await assert.rejects(short.submit(input), { code: "EXECUTION_DEADLINE" });
  reply({ providerJobId: "late-job" }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(short.inspect().execution.acceptance, "unknown");
  await assert.rejects(short.submit(input), { code: "EXECUTION_UNKNOWN" });
});

test("stale observations, wrong root turns and silence cannot settle remote work", async () => {
  const f = remote(); await f.service.submit(input); await f.service.reconcile({ force: true });
  const observed = f.service.current().execution.observedAt;
  f.observe({ observedAt: observed - 1, state: "succeeded" });
  await f.service.reconcile({ force: true });
  assert.equal(f.service.current().execution.providerState, "status-unknown");
  assert.equal(f.service.current().running, true);
  f.observe({ observedAt: observed + 1, turnId: "subagent-turn", state: "succeeded" });
  await f.service.reconcile({ force: true });
  assert.equal(f.service.current().execution.recoveryAction, "EXECUTION_OWNERSHIP");
  const calls = f.calls.length;
  for (let i = 0; i < 20; i++) f.reopen().inspect();
  assert.equal(f.calls.length, calls);
  assert.ok(executionLive(f.service.current()));
});

test("missing results remain retrieving, event gaps are explicit and recovered events deduplicate", async () => {
  const f = remote("openai-agents", { collect: async () => null });
  const job = await f.service.submit(input);
  f.observe({ state: "succeeded", events: [{ eventId: "ev-1", type: "output", data: "hello" }], cursor: "c1", gap: "missed intermediate deltas" });
  await f.service.reconcile({ force: true }); await f.reopen().reconcile({ force: true });
  await assert.rejects(f.service.collect(), { code: "EXECUTION_RESULT" });
  assert.equal(f.service.current().running, true);
  const events = readFileSync(join(f.service.dirOf(job.id), "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(events.length, 2); assert.equal(events[1].type, "gap");
});

test("unsupported cancel stops dispatch, leaves confirmation unknown and quarantines late results", async () => {
  const f = remote("codex-cloud"); f.capabilities.controls.cancel = false;
  await f.service.submit(input);
  assert.deepEqual(await f.service.cancel("timeout"), { confirmed: false, unsupported: true });
  assert.equal(f.service.current().execution.providerState, "cancellation-requested");
  assert.equal(f.calls.some(x => x[0] === "cancel"), false);
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true });
  assert.equal(f.service.current().execution.quarantined, true);
  await assert.rejects(f.service.collect(), { code: "EXECUTION_QUARANTINED" });
  await assert.rejects(f.service.submit({ ...input, operationId: "late" }), { code: "EXECUTION_STOPPED" });
});

test("mandatory policy, unsupported model and unknown allowance fail before dispatch", async () => {
  for (const [patch, code] of [[{ mandatoryPolicy: ["unavailable-hook"] }, "EXECUTION_POLICY"], [{ model: "unconfigured-model" }, "EXECUTION_INPUT"], [{ allowance: { reservedUsd: null, remainingUsd: 1 } }, "EXECUTION_ALLOWANCE"], [{ allowance: { reservedUsd: 0, remainingUsd: 0 } }, "EXECUTION_ALLOWANCE"], [{ allowance: undefined }, "EXECUTION_ALLOWANCE"]]) {
    const f = remote(); await assert.rejects(f.service.submit({ ...input, ...patch }), { code });
    assert.equal(f.calls.length, 0);
  }
  const f = remote(); await f.service.submit({ ...input, allowance: { remainingUsd: 0.1, reservedUsd: 0.1 } });
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect();
  await assert.rejects(f.service.continue({ ...input, operationId: "extra", sessionId: "session-1" }), { code: "EXECUTION_ALLOWANCE" });
});

test("scoped health deadlines/backoff permit another account and review to advance", async () => {
  const home = tempHome(), clock = makeClock(), reached = [], counts = {};
  const health = makeProviderHealth({ home, clock, limits: { deadlineMs: 10 }, jitter: () => 0, probe: async (provider, account) => {
    counts[account] = (counts[account] || 0) + 1;
    if (account === "slow") return new Promise(() => {});
    reached.push(account); return { ok: true, detail: "account ready" };
  } });
  const progress = health.refresh([["codex", "slow"], ["codex", "healthy"]]);
  reached.push("GitHub review"); await progress;
  assert.deepEqual([...reached].sort(), ["GitHub review", "healthy"]);
  assert.equal(health.get("codex", "slow").ok, false); assert.equal(health.get("codex", "healthy").ok, true);
  await health.refresh([["codex", "slow"]]); assert.equal(counts.slow, 1);
  assert.ok(health.get("codex", "slow").nextAttemptAt > clock.now());
});

test("normalized journal preserves provenance, provider ordering, redaction and replay IDs", () => {
  const dir = tempHome(), options = { taskId: "task", runId: "run", provider: "fixture", secrets: ["custom-private-value"] };
  const append = ev => journalFor(dir, options).append(ev);
  const a = append({ eventId: "event-2", sequence: 2, type: "tool-summary", providerJobId: "p1", turnId: "t1", data: "custom-private-value Bearer private-access-token" });
  const b = append({ eventId: "event-1", sequence: 1, type: "usage", data: { costUsd: null, api_key: "secret-value" } });
  assert.equal(a.sequence, 1); assert.equal(b.sequence, 2);
  assert.deepEqual(append({ eventId: "event-2", providerJobId: "p1", turnId: "t1", data: "replayed" }), a);
  const text = readFileSync(join(dir, "events.jsonl"), "utf8") + readFileSync(join(dir, "job.log"), "utf8");
  assert.doesNotMatch(text, /custom-private-value|private-access-token|secret-value/);
  assert.match(text, /"version":1/); assert.match(text, /"provenance":"provider"/);
});

function largeLog() {
  const dir = tempHome(), lines = 50_000, chunks = [], index = Buffer.alloc(lines * 8); let offset = 0;
  for (let i = 0; i < lines; i++) { const text = `event ${i} ${"x".repeat(240)}\n`; index.writeBigUInt64LE(BigInt(offset), i * 8); offset += Buffer.byteLength(text); chunks.push(text); }
  writeFileSync(join(dir, "job.log"), chunks.join("")); writeFileSync(join(dir, "job.idx"), index);
  writeJsonAtomic(join(dir, "job.json"), { id: "large", exit: 0 });
  return { dir, lines, offset };
}

test("large indexed tails/history/reconnect use bounded bytes and stable IDs", () => {
  const f = largeLog(), meter = { bytesRead: 0 };
  const tail = logWindow(f.dir, { meter });
  assert.equal(tail.lines.length, 400); assert.equal(tail.ids[0], f.lines - 399);
  assert.ok(meter.bytesRead <= LOG_LIMITS.windowBytes + 3208);
  const historyMeter = { bytesRead: 0 }, older = sliceRun(f.dir, { end: tail.from, meter: historyMeter });
  assert.equal(older.to, tail.from - 1); assert.ok(historyMeter.bytesRead <= LOG_LIMITS.windowBytes + 3208);
  const replay = logWindow(f.dir, { after: tail.ids.at(-2) });
  assert.deepEqual(replay.ids, [f.lines]);
  rmSync(join(f.dir, "job.idx"));
  const legacyMeter = { bytesRead: 0 }, legacy = logWindow(f.dir, { meter: legacyMeter });
  assert.ok(legacyMeter.bytesRead <= LOG_LIMITS.windowBytes); assert.match(legacy.gap, /byte positions/);
  assert.deepEqual(logWindow(f.dir, { after: legacy.ids.at(-2) }).ids, [legacy.ids.at(-1)]);
});

class Subscriber extends EventEmitter {
  constructor(slow = false) { super(); this.slow = slow; this.frames = []; this.req = { headers: {} }; }
  writeHead() {} setTimeout() {} end() { this.ended = true; this.emit("close"); }
  write(frame) { this.frames.push(frame); return !this.slow; }
}

test("slow/disconnected SSE readers bound buffers, stop reads and permit unrelated controls", async () => {
  const f = largeLog(), meter = { bytesRead: 0 }, res = new Subscriber(true);
  const subscriber = streamRun(res, f.dir, { isRunning: () => true, meter, pollMs: 100_000, beatMs: 100_000 });
  assert.equal(subscriber.blocked(), true); assert.ok(subscriber.bufferedBytes() <= LOG_LIMITS.bufferedBytes);
  const before = meter.bytesRead;
  const other = remote(); await other.service.submit(input); await other.service.cancel();
  assert.equal(meter.bytesRead, before);
  res.emit("close"); assert.equal(subscriber.bufferedBytes(), 0); assert.equal(res.listenerCount("drain"), 0);
});

test("rotation yields an explicit gap without renumbering replay IDs", () => {
  const dir = tempHome(); appendProjection(dir, "one"); appendProjection(dir, "two");
  writeJsonAtomic(join(dir, "job.json"), { id: "rotated", exit: null });
  const res = new Subscriber(true); res.req.headers["last-event-id"] = "2";
  const stream = streamRun(res, dir, { isRunning: () => true, pollMs: 100_000, beatMs: 100_000 });
  renameSync(join(dir, "job.log"), join(dir, "job.log.1")); writeFileSync(join(dir, "job.log"), "new\n");
  res.slow = false; res.emit("drain");
  assert.ok(res.frames.some(frame => frame.includes("event: gap"))); stream.close();
});

test("legacy registry identities/chains/active local jobs survive and unknown versions refuse", () => {
  const home = tempHome(), entry = newEntry({ repo: "acme/widget", harness: "codex", session: "22222222-2222-4222-8222-222222222222", branch: "work/legacy", pr: 9, worktree: tempHome(), nowIso: T0, state: STATES.prOpen });
  const legacy = { version: 1, entries: { "acme/widget/legacy": entry }, chains: { queue: { snapshots: ["unchanged"] } } };
  writeJsonAtomic(join(home, "state.json"), legacy);
  assert.deepEqual(makeState(home).load(), JSON.parse(JSON.stringify(legacy)));
  const root = tempHome(), dir = join(root, "legacy-run"); mkdirSync(dir);
  writeJsonAtomic(join(dir, "job.json"), { id: "legacy-run", pid: 11, bin: "codex", exit: null }); writeFileSync(join(root, "latest-run"), "legacy-run");
  const runner = makeRunner(root, { probe: () => true });
  const boundary = makeExecution({ root, taskId: "acme/widget/legacy", provider: "codex", runner });
  assert.equal(boundary.current().id, "legacy-run"); assert.equal(boundary.current().running, true);
  writeJsonAtomic(join(home, "state.json"), { ...legacy, version: 99 });
  assert.throws(() => makeState(home).load(), { code: "STATE_VERSION" });
  const f = remote(); writeJsonAtomic(join(f.root, "execution.json"), { version: 99 });
  assert.throws(() => f.service.inspect(), { code: "EXECUTION_VERSION" });
});

function legacyCancellationFixture() {
  const root = tempHome(), clock = makeClock(), id = "legacy-active", signals = [];
  const session = "22222222-2222-4222-8222-222222222222";
  mkdirSync(join(root, id));
  writeJsonAtomic(join(root, id, "job.json"), { id, pid: 123456789, bin: "codex", name: "legacy", startedAt: clock.now(), exit: null });
  writeFileSync(join(root, "latest-run"), id);
  let members = [{ pid: 123456789, group: 123456789, started: "leader" }, { pid: 123456790, group: 123456790, started: "tool" }];
  const open = (controls = {}) => {
    const runner = makeRunner(root, { clock, probe: () => true, processes: () => members, signal: (pid, sig) => signals.push([pid, sig]) });
    return makeExecution({ root, taskId: "legacy-task", provider: "codex", runner, clock, legacySessionId: session,
      capabilities: { ...executionRegistry.codex, controls: { cancel: true, ...controls } } });
  };
  return { root, id, clock, session, signals, open, setMembers: value => { members = value; } };
}

test("legacy cancellation stops the owned process tree, survives restart and quarantines late output", async () => {
  const f = legacyCancellationFixture(), service = f.open();
  assert.equal(service.state().current, null);
  assert.deepEqual(await service.cancel(), { confirmed: false });
  assert.deepEqual(f.signals, [[-123456790, "SIGTERM"], [-123456789, "SIGTERM"]]);
  const saved = service.state();
  assert.equal(saved.current.id, f.id);
  assert.equal(saved.current.execution.runId, f.id);
  assert.equal(saved.current.execution.providerJobId, f.id);
  assert.equal(saved.current.execution.sessionId, f.session);
  assert.equal(saved.current.execution.costUsd, null);
  assert.equal(saved.current.execution.operationId, null);
  assert.equal(Object.hasOwn(saved.current, "running"), false);
  assert.deepEqual(saved.operations, {});
  assert.equal(saved.current.execution.providerState, "cancellation-requested");
  const restarted = f.open();
  await restarted.reconcile();
  assert.equal(restarted.current().running, true);
  assert.equal(restarted.current().execution.providerState, "cancellation-requested");
  await assert.rejects(restarted.submit({ ...input, spec: {} }), { code: "EXECUTION_STOPPED" });
  f.clock.advance(1); // Recovery uses the existing owned process-tree fallback.
  assert.deepEqual(await restarted.cancel(), { confirmed: false });
  assert.deepEqual(f.signals.slice(-2), [[-123456790, "SIGKILL"], [-123456789, "SIGKILL"]]);
  f.setMembers([]);
  await restarted.reconcile();
  assert.equal(restarted.current().execution.providerState, "cancelled");
  assert.equal(restarted.current().execution.quarantined, true);
  assert.equal(restarted.current().running, false);
  assert.equal(restarted.state().current.exit, 137);
  assert.equal(restarted.state().current.killed, true);
  assert.equal(Object.hasOwn(restarted.state().current, "running"), false);
  writeFileSync(join(f.root, f.id, "job.log"), '{"type":"turn.completed"}\n');
  await assert.rejects(restarted.collect(), { code: "EXECUTION_QUARANTINED" });
  assert.equal(readJson(join(f.root, f.id, "result.json")), null);
  assert.equal(readJson(join(f.root, f.id, "job.json")).execution.providerState, "cancelled");
});

test("legacy cancellation keeps inspection failures and unsupported stops unconfirmed", async () => {
  const f = legacyCancellationFixture(), service = f.open();
  f.setMembers(null);
  await assert.rejects(service.cancel("timeout"), { code: "RUN_STOP_UNVERIFIED" });
  assert.equal(service.state().stopped, "timeout");
  assert.equal(service.current().execution.providerState, "cancellation-requested");
  await service.reconcile();
  assert.equal(service.current().execution.providerState, "cancellation-requested");
  assert.deepEqual(f.signals, []);
  await assert.rejects(f.open().submit({ ...input, spec: {} }), { code: "EXECUTION_STOPPED" });
  const unsupported = legacyCancellationFixture(), boundary = unsupported.open({ cancel: false });
  assert.deepEqual(await boundary.cancel(), { confirmed: false, unsupported: true });
  assert.equal(boundary.current().running, true);
  await boundary.reconcile();
  assert.equal(boundary.current().execution.providerState, "cancellation-requested");
  assert.deepEqual(unsupported.signals, []);
});

test("local cancellation and reconciliation cannot confirm a missing or different run", async () => {
  for (const pointer of ["missing-run", "other-run"]) {
    const f = legacyCancellationFixture(), service = f.open();
    await service.cancel();
    mkdirSync(join(f.root, "other-run"));
    writeJsonAtomic(join(f.root, "other-run", "job.json"), { id: "other-run", exit: 0 });
    writeFileSync(join(f.root, "latest-run"), pointer);
    await service.reconcile();
    assert.equal(service.current().execution.providerState, "cancellation-requested");
    assert.equal(service.current().execution.reconciledAt, null);
    assert.deepEqual(await service.cancel(), { confirmed: false });
    assert.equal(service.current().execution.quarantined, undefined);
  }
});

test("local Codex fixture uses existing adapter, journals output and survives launcher exit", async () => {
  const root = tempHome(), cwd = tempHome();
  const runner = makeRunner(root, { probe: () => false });
  const service = makeExecution({ root, taskId: "acme/widget/local", provider: "codex", runner });
  const lines = [{ type: "thread.started", thread_id: "22222222-2222-4222-8222-222222222222" }, { type: "item.completed", item: { type: "agent_message", text: "result local-private-secret" } }, { type: "turn.completed" }];
  const code = `process.stdout.write(${JSON.stringify(lines.map(JSON.stringify).join("\n") + "\n")})`;
  const job = await service.start("fixture", process.execPath, ["-e", code], { cwd, env: { TEST_API_KEY: "local-private-secret" }, execution: { operationId: "fixture" } });
  while (runner.read(job.id).exit === null) await new Promise(resolve => setImmediate(resolve));
  await service.reconcile(); service.settle(job.id, () => 0);
  assert.equal(service.outcome(job.id).ok, true);
  assert.doesNotMatch(readFileSync(join(service.dirOf(job.id), "job.log"), "utf8"), /local-private-secret/);
  assert.equal(service.sessionFrom(job.id), "22222222-2222-4222-8222-222222222222");
  rmSync(join(service.dirOf(job.id), "provider.log"));
  assert.equal(service.outcome(job.id).ok, true);
});

function resultFixture() {
  const dir = tempHome(), worktree = tempHome(), id = "acme/widget/result", revision = "a".repeat(40), runId = "result-run";
  writeFileSync(join(worktree, "a.txt"), "before");
  const entry = { ...newEntry({ repo: "acme/widget", harness: "codex", session: "22222222-2222-4222-8222-222222222222", branch: "work/result", base: "main", worktree, nowIso: T0, state: STATES.running }), execution: { runId, providerJobId: "j1", turnId: "t1", inputHead: revision } };
  const result = { taskId: id, runId, providerJobId: "j1", turnId: "t1", inputHead: revision, repo: entry.repo, branch: entry.branch, files: [{ path: "a.txt", beforeHash: sha("before"), afterHash: sha("after"), text: "after" }], pr: { title: "Apply result", body: "Verified execution artifacts." } };
  const calls = [], git = { head: async () => revision, dirty: async () => ({ modified: 0, untracked: 0 }), currentBranch: async () => entry.branch, originOf: async () => "https://github.com/acme/widget.git", commitResult: async () => calls.push("commit"), pushResult: async () => calls.push("push") };
  const gh = { publishResultPr: async () => { calls.push("PR"); return { number: 1, url: "https://example.test/pr/1" }; } };
  const ctx = { git, gh, readPrd: () => "# Brief\n\n## Verify\n\n- `printf verified`\n" };
  const verify = async () => { calls.push("verify"); return { stdout: "verified", stderr: "" }; };
  return { id, entry, result, dir, ctx, verify, calls };
}

async function collectedArtifactFixture(secrets = []) {
  const f = resultFixture(), provider = remote(), home = tempHome(), root = join(home, "runs", idSlug(f.id));
  const options = { root, taskId: f.id, provider: "openai-agents", account: "test", transport: provider.transport, capabilities: provider.capabilities, clock: provider.clock, secrets };
  const reopen = () => makeExecution(options), service = reopen(), job = await service.submit(input);
  f.entry.harness = "openai-agents"; f.entry.session = job.execution.sessionId; f.entry.execution = job.execution;
  Object.assign(f.result, { runId: job.id, providerJobId: job.execution.providerJobId, sessionId: job.execution.sessionId, turnId: job.execution.turnId,
    outcome: { finished: true, ok: true, cost: null, denials: [] } });
  provider.transport.collect = async () => { provider.calls.push(["collect"]); return f.result; };
  Object.assign(f.ctx, { home, executionFor: reopen });
  f.dir = service.dirOf(job.id);
  return { ...f, service, reopen, provider, job, collect: async () => {
    provider.observe({ state: "succeeded" }); await service.reconcile({ force: true }); return service.collect();
  } };
}

test("collected authentication source preserves exact artifact bytes through restart and publication", async () => {
  const f = await collectedArtifactFixture();
  const text = 'const token = process.env.API_TOKEN;\r\nconst password = process.env.PASSWORD;\r\nexport const auth = { token, password, label: "café 🔑", example: "Bearer placeholder" };\r\n';
  f.result.files = [{ path: "auth.mjs", beforeHash: null, afterHash: sha(text), text }];
  const original = structuredClone(f.result.files), collected = await f.collect();
  assert.deepEqual(collected.files, original);
  assert.equal(collected.files[0].afterHash, sha(collected.files[0].text));
  assert.equal(statSync(join(f.dir, "result.json")).mode & 0o777, 0o600);
  f.result.files[0].text = "mutated provider reply";
  const replay = await f.reopen().collect();
  assert.deepEqual(replay.files, original);
  assert.equal(f.provider.calls.filter(c => c[0] === "collect").length, 1);
  f.ctx.readPrd = () => "# Brief\n\n## Verify\n\n- `node --check auth.mjs`\n";
  const invalid = structuredClone(replay); invalid.files[0].text += "changed";
  await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result: invalid }), /artifact content hash differs/);
  assert.deepEqual(f.calls, []);
  const done = await reconcileExecutionResult(f.ctx, { ...f, result: replay, verify: undefined });
  assert.deepEqual(readFileSync(join(f.entry.worktree, "auth.mjs")), Buffer.from(text));
  assert.deepEqual(f.calls, ["commit", "push", "PR"]);
  assert.equal(done.evidence[0].exit, 0); assert.equal(done.evidence[0].source, "coordinator-executed");
});

test("private artifact payloads and paths stay out of result projections and verification diagnostics", async () => {
  for (const failing of [false, true]) {
    const secret = "resolved-artifact-private-value", f = await collectedArtifactFixture([secret]);
    const text = `export const sample = "${secret}";\n`, path = `${secret}/obsolete.txt`;
    mkdirSync(join(f.entry.worktree, secret)); writeFileSync(join(f.entry.worktree, path), "obsolete");
    f.result.files = [{ path: "auth.mjs", beforeHash: null, afterHash: sha(text), text }, { path, beforeHash: sha("obsolete"), afterHash: null, text: null }];
    f.result.artifacts = [{ path: "forged provider summary", text: secret }];
    f.result.outcome.lastMessage = secret; f.result.lines = [secret]; f.result.usage = { token: secret };
    const original = structuredClone(f.result.files), result = await f.collect();
    assert.deepEqual(result.files, original);
    assert.equal(result.outcome.lastMessage, "[redacted]");
    assert.deepEqual(result.lines, ["[redacted]"]); assert.equal(result.usage.token, "[redacted]");
    assert.deepEqual(result.artifacts, [{ path: "auth.mjs", hash: sha(text) }, { path: "[redacted]/obsolete.txt", hash: null }]);
    f.ctx.readPrd = () => failing ? '# Brief\n\n## Verify\n\n- `node -e "process.stdout.write(require(\'node:fs\').readFileSync(\'auth.mjs\')); process.exit(2)"`\n'
      : "# Brief\n\n## Verify\n\n- `cat auth.mjs`\n";
    if (failing) await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result, verify: undefined }), /verification failed/);
    else await reconcileExecutionResult(f.ctx, { ...f, result, verify: undefined });
    assert.deepEqual(readFileSync(join(f.entry.worktree, "auth.mjs")), Buffer.from(text));
    assert.throws(() => readFileSync(join(f.entry.worktree, path)), { code: "ENOENT" });
    const verification = readJson(join(f.dir, "verification.json"));
    assert.equal(verification.evidence[0].exit, failing ? 2 : 0);
    assert.doesNotMatch(JSON.stringify(verification), new RegExp(secret));
    assert.equal(f.calls.includes("PR"), !failing);
    // A crash during application leaves exact private paths in this checkpoint.
    writeJsonAtomic(join(f.dir, "result-application.json"), { phase: "applying", paths: original.map(file => file.path) });
    const state = makeState(f.ctx.home); state.put(f.id, f.entry);
    const before = f.provider.calls.length, response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
    routes["GET /api/run/result"]({ ...f.ctx, state }, {}, response, new URL(`http://localhost/api/run/result?id=${f.id}&run=${f.job.id}`));
    assert.equal(response.code, 200); assert.doesNotMatch(response.body, new RegExp(secret));
    const view = JSON.parse(response.body);
    assert.deepEqual(view.artifacts, result.artifacts);
    assert.deepEqual(view.publication.paths, ["auth.mjs", "[redacted]/obsolete.txt"]);
    assert.equal(Object.hasOwn(view, "files"), false);
    assert.equal(f.provider.calls.length, before);
    writeJsonAtomic(join(f.dir, "result-public-fixture.json"), view);
  }
});

test("result publication validates ownership/paths/input head and records real verification", async () => {
  const f = resultFixture();
  const done = await reconcileExecutionResult(f.ctx, f);
  assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "after");
  assert.deepEqual(f.calls, ["commit", "verify", "push", "PR"]);
  assert.equal(done.evidence[0].source, "coordinator-executed"); assert.equal(done.evidence[0].head, f.result.inputHead);
  await reconcileExecutionResult(f.ctx, f);
  assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "after");
  for (const mutate of [r => { r.branch = "main"; }, r => { r.inputHead = "b".repeat(40); }, r => { r.files[0].path = "../outside"; }, r => { r.files[0].afterHash = "truncated"; }]) {
    const bad = resultFixture(); mutate(bad.result);
    await assert.rejects(reconcileExecutionResult(bad.ctx, bad));
    assert.equal(readFileSync(join(bad.entry.worktree, "a.txt"), "utf8"), "before"); assert.deepEqual(bad.calls, []);
  }
  const linked = resultFixture(); symlinkSync(tempHome(), join(linked.entry.worktree, "link")); linked.result.files[0].path = "link/file";
  await assert.rejects(reconcileExecutionResult(linked.ctx, linked), /symlink/);
});

test("artifact aliases reject duplicate canonical targets before content validation or mutation", async () => {
  for (const [first, alias] of [["a.txt", "./a.txt"], ["a.txt", ".//a.txt"], ["nested/a.txt", "nested//./a.txt"]]) {
    for (const deletion of [false, true]) {
      const f = resultFixture();
      if (first.startsWith("nested/")) { mkdirSync(join(f.entry.worktree, "nested")); writeFileSync(join(f.entry.worktree, first), "before"); }
      f.result.files = [
        { path: first, beforeHash: sha("before"), afterHash: "invalid-content-hash", text: "first payload" },
        { path: alias, beforeHash: sha("before"), afterHash: deletion ? null : sha("last payload"), text: deletion ? null : "last payload" },
      ];
      const original = structuredClone(f.result.files);
      await assert.rejects(reconcileExecutionResult(f.ctx, f), /duplicate canonical result file/);
      assert.equal(readFileSync(join(f.entry.worktree, first), "utf8"), "before");
      assert.deepEqual(f.result.files, original); assert.deepEqual(f.calls, []);
      assert.throws(() => readFileSync(join(f.dir, "result-application.json")), { code: "ENOENT" });
    }
  }
  // Validate every target before reading even the first artifact's content hash.
  const unsafe = resultFixture(); unsafe.result.files[0].afterHash = "invalid-content-hash";
  unsafe.result.files.push({ ...unsafe.result.files[0], path: ".//.git/config" });
  await assert.rejects(reconcileExecutionResult(unsafe.ctx, unsafe), /unsafe repository path/);
  assert.equal(readFileSync(join(unsafe.entry.worktree, "a.txt"), "utf8"), "before");
  assert.deepEqual(unsafe.calls, []);
});

test("canonical artifact targets survive native commit acknowledgement loss without changing the private manifest", async () => {
  const f = await nativeResultFixture(), originalPath = ".//a.txt", commitPaths = [], recoveryPaths = [];
  f.result.files[0].path = originalPath;
  const commit = f.ctx.git.commitResult, matches = f.ctx.git.resultHeadMatches; let lost = true;
  f.ctx.git.commitResult = async (dir, paths) => {
    commitPaths.push(paths); await commit(dir, paths);
    if (lost) { lost = false; throw new Error("commit acknowledgement lost"); }
  };
  f.ctx.git.resultHeadMatches = async (dir, head, paths) => { recoveryPaths.push(paths); return matches(dir, head, paths); };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /acknowledgement lost/);
  assert.deepEqual(readJson(join(f.dir, "result-application.json")).paths, ["a.txt"]);
  await reconcileExecutionResult(f.ctx, f);
  assert.deepEqual(commitPaths, [["a.txt"], ["a.txt"]]); assert.deepEqual(recoveryPaths, [["a.txt"]]);
  assert.equal(f.result.files[0].path, originalPath);
  assert.equal(sha(readFileSync(join(f.entry.worktree, "a.txt"))), f.result.files[0].afterHash);
  assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), { modified: 0, untracked: 0 });
  assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published");
  assert.deepEqual(f.calls, ["commit", "commit", "verify", "push", "PR"]);
});

test("failed verification prevents GitHub publication and leaves exact evidence", async () => {
  const f = resultFixture(); let attempts = 0;
  f.verify = async () => { attempts++; throw Object.assign(new Error("failed"), { code: 2, stderr: "test failure" }); };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /verification failed/);
  assert.deepEqual(f.calls, ["commit"]);
  const observed = readJson(join(f.dir, "verification.json"));
  assert.equal(observed.evidence[0].exit, 2); assert.equal(observed.head, f.result.inputHead);
  const checkpoint = readJson(join(f.dir, "result-application.json"));
  assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "verification-failed");
  for (let poll = 0; poll < 3; poll++) await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.equal(attempts, 1); assert.deepEqual(f.calls, ["commit"]);
  assert.deepEqual(readJson(join(f.dir, "verification.json")), observed);
  assert.deepEqual(readJson(join(f.dir, "result-application.json")), checkpoint);
});

test("interrupted verification blocks replay while lost publication replies reuse verified evidence", async () => {
  const interrupted = resultFixture();
  writeJsonAtomic(join(interrupted.dir, "result-application.json"), { fingerprint: sha(JSON.stringify(interrupted.result)), phase: "verifying", appliedHead: interrupted.result.inputHead });
  writeJsonAtomic(join(interrupted.dir, "verification.json"), { version: 1, head: interrupted.result.inputHead, evidence: [] });
  await assert.rejects(reconcileExecutionResult(interrupted.ctx, interrupted), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.equal(readJson(join(interrupted.dir, "result-application.json")).reason, "verification-interrupted");
  assert.deepEqual(interrupted.calls, []);

  const f = resultFixture(); let pushes = 0;
  f.ctx.git.pushResult = async () => { f.calls.push("push"); if (++pushes === 1) throw new Error("reply lost"); };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /reply lost/);
  assert.equal(readJson(join(f.dir, "result-application.json")).phase, "verified");
  const evidence = readJson(join(f.dir, "verification.json"));
  await reconcileExecutionResult(f.ctx, f); await reconcileExecutionResult(f.ctx, f);
  assert.deepEqual(f.calls, ["commit", "verify", "push", "push", "PR"]);
  assert.deepEqual(readJson(join(f.dir, "verification.json")), evidence);
});

test("failed remote verification survives polls and restart, settles workflow and permits explicit correction", async () => {
  const f = await collectedArtifactFixture(), state = makeState(f.ctx.home), attempts = join(f.dir, "verify-attempts.txt");
  f.ctx.readPrd = () => `# Brief\n\n## Verify\n\n- \`node -e 'require("fs").appendFileSync(${JSON.stringify(attempts)}, "x"); process.exit(2)'\`\n`;
  state.put(f.id, { ...f.entry, last: { run: f.job.id, exit: null }, execution: f.service.current().execution });
  const reviewId = "acme/widget/review";
  state.put(reviewId, newEntry({ repo: "acme/widget", harness: "codex", branch: "work/review", pr: 2, state: STATES.prOpen, nowIso: T0 }));
  const gh = fakeGh({ pr: { state: "MERGED" } }), notify = fakeNotify();
  const ctx = { ...f.ctx, state, config: CONFIG, clock: f.provider.clock, git: { ...fakeGit(), ...f.ctx.git }, gh,
    ownLogin: "me", log: silentLog, notify, credential: fakeCredential(), identity: fakeIdentity(),
    executionFor: id => id === f.id ? f.reopen() : { current: () => null } };
  f.provider.observe({ state: "succeeded" });
  const tick = makeTick(ctx);
  await tick.tick(); await tick.tick();
  const restarted = { ...ctx, state: makeState(ctx.home) };
  await makeTick(restarted).tick(); await makeTick(restarted).tickEntry(f.id, restarted.state.get(f.id));
  const stopped = restarted.state.get(f.id);
  assert.equal(readFileSync(attempts, "utf8"), "x");
  assert.equal(stopped.state, STATES.needsHuman); assert.equal(stopped.reason, "result-verification");
  assert.equal(stopped.last.exit, 0); // Provider succeeded; publication verification did not.
  assert.equal(stopped.execution.providerState, "succeeded"); assert.equal(stopped.last.cost, null);
  assert.equal(stopped.session, f.job.execution.sessionId); assert.equal(restarted.state.get(reviewId).state, STATES.done);
  assert.equal(notify.sent.filter(x => x[0] === "needs").length, 1);
  assert.equal(f.provider.calls.filter(c => c[0] === "submit").length, 1);
  assert.equal(f.provider.calls.filter(c => c[0] === "continue").length, 0);
  assert.equal(f.provider.calls.filter(c => c[0] === "collect").length, 1);
  assert.deepEqual(f.calls, ["commit"]);

  // An already-queued PR recheck cannot clear the publication stop either.
  restarted.state.update(f.id, { pr: 1, control: { id: "recheck-before-failure", action: "recheck", status: "queued" } });
  gh.data.pr.state = "OPEN";
  assert.throws(() => requestControl(restarted, { handle: f.id, action: "recheck" }), /already queued/);
  await applyControl(restarted, f.id);
  assert.equal(restarted.state.get(f.id).control.status, "failed");
  assert.match(restarted.state.get(f.id).control.message, /cannot retry verification/);
  assert.throws(() => requestControl(restarted, { handle: f.id, action: "recheck" }), { code: "EXECUTION_RESULT_BLOCKED" });
  requestControl(restarted, { handle: f.id, action: "resume" });
  await makeTick(restarted).tickEntry(f.id, restarted.state.get(f.id));
  assert.equal(restarted.state.get(f.id).control.status, "applied");
  assert.equal(f.provider.calls.filter(c => c[0] === "continue").length, 1);
  assert.equal(f.reopen().current().execution.sessionId, stopped.session);
  assert.notEqual(restarted.state.get(f.id).last.run, f.job.id);
  assert.equal(readFileSync(attempts, "utf8"), "x");
  assert.equal(readJson(join(f.dir, "result-application.json")).phase, "blocked");
});

async function nativeResultFixture() {
  const f = resultFixture(), worktree = f.entry.worktree;
  const nativeExec = (cmd, args, options) => execFileAsync(cmd, args, { ...options, env: { ...options.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
  const git = makeGit({ config: CONFIG, exec: nativeExec, identity: fakeIdentity() });
  await nativeExec("git", ["init", "-b", f.entry.branch], { cwd: worktree, env: process.env });
  await nativeExec("git", ["remote", "add", "origin", "https://github.com/acme/widget.git"], { cwd: worktree, env: process.env });
  writeFileSync(join(worktree, "b.txt"), "unchanged");
  await git.commitResult(worktree, ["a.txt", "b.txt"]);
  const head = await git.head(worktree); f.result.inputHead = head; f.entry.execution.inputHead = head;
  f.ctx.git = { ...git, commitResult: async (...args) => { f.calls.push("commit"); return git.commitResult(...args); }, pushResult: async () => f.calls.push("push") };
  return { ...f, verify: async (...args) => { f.calls.push("verify"); return execFileAsync(...args); } };
}

for (const mutation of ["tracked", "staged", "untracked"]) test(`verification ${mutation} writes block publication at the unchanged native Git head`, async () => {
  const f = await nativeResultFixture();
  const command = mutation === "untracked" ? "printf created > generated.txt" : `printf dirty > b.txt${mutation === "staged" ? " && git add -- b.txt" : ""}`;
  f.ctx.readPrd = () => `# Brief\n\n## Verify\n\n- \`${command}\`\n- \`printf must-not-run\`\n`;
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  const checkpoint = readJson(join(f.dir, "result-application.json")), evidence = readJson(join(f.dir, "verification.json"));
  assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "verification-dirty");
  assert.equal(await f.ctx.git.head(f.entry.worktree), checkpoint.appliedHead);
  assert.equal(evidence.evidence.length, 1); assert.equal(evidence.evidence[0].exit, 0);
  assert.deepEqual(f.calls, ["commit", "verify"]);
  assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), mutation === "untracked" ? { modified: 0, untracked: 1 } : { modified: 1, untracked: 0 });
  assert.equal(readFileSync(join(f.entry.worktree, mutation === "untracked" ? "generated.txt" : "b.txt"), "utf8"), mutation === "untracked" ? "created" : "dirty");
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.deepEqual(f.calls, ["commit", "verify"]);
});

test("pre-existing dirty files and unavailable status fail closed even with an empty Verify list", async () => {
  const f = await nativeResultFixture(); writeFileSync(join(f.entry.worktree, "b.txt"), "operator edits");
  f.ctx.readPrd = () => "# Brief\n";
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.equal(readFileSync(join(f.entry.worktree, "b.txt"), "utf8"), "operator edits");
  assert.deepEqual(f.calls, ["commit"]); assert.equal(readJson(join(f.dir, "result-application.json")).reason, "verification-dirty");
  for (const status of [undefined, null, new Error("status failed")]) {
    const bad = resultFixture(); bad.ctx.readPrd = () => "# Brief\n";
    bad.ctx.git.dirty = async (_dir, options) => { assert.equal(options.strict, true); if (status instanceof Error) throw status; return status; };
    await assert.rejects(reconcileExecutionResult(bad.ctx, bad), { code: "EXECUTION_RESULT_BLOCKED" });
    assert.deepEqual(bad.calls, ["commit"]);
    assert.equal(readJson(join(bad.dir, "result-application.json")).reason, "verification-state-unavailable");
  }
});

test("verification-created commits are retained and blocked instead of publishing stale evidence", async () => {
  const f = await nativeResultFixture();
  f.ctx.readPrd = () => '# Brief\n\n## Verify\n\n- `printf changed > b.txt && git add -- b.txt && git -c user.name=Verifier -c user.email=verifier@example.test commit -m "Verification change"`\n';
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  const checkpoint = readJson(join(f.dir, "result-application.json"));
  assert.equal(checkpoint.reason, "verification-head-changed");
  assert.notEqual(await f.ctx.git.head(f.entry.worktree), checkpoint.appliedHead);
  assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), { modified: 0, untracked: 0 });
  assert.equal(readJson(join(f.dir, "verification.json")).evidence[0].exit, 0);
  assert.deepEqual(f.calls, ["commit", "verify"]);
});

test("pushed results and post-push publication use the same clean-checkout boundary", async () => {
  const pushed = resultFixture(); delete pushed.result.files; pushed.result.pushedHead = pushed.result.inputHead;
  pushed.ctx.gh.refSha = async () => pushed.result.pushedHead; pushed.ctx.gh.containsCommit = async () => true;
  pushed.ctx.git.dirty = async () => ({ modified: 0, untracked: 1 });
  await assert.rejects(reconcileExecutionResult(pushed.ctx, pushed), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.deepEqual(pushed.calls, []);
  const f = resultFixture(); let dirty = false;
  f.ctx.git.pushResult = async () => { f.calls.push("push"); dirty = true; };
  f.ctx.git.dirty = async () => ({ modified: dirty ? 1 : 0, untracked: 0 });
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.deepEqual(f.calls, ["commit", "verify", "push"]);
  assert.equal(readJson(join(f.dir, "result-application.json")).reason, "verification-dirty");
});

test("verified publication recovery rejects changed heads, dirty trees and missing evidence without command replay", async () => {
  for (const change of ["head", "dirty", "evidence"]) {
    const f = resultFixture(); f.ctx.git.pushResult = async () => { throw new Error("push unavailable"); };
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /push unavailable/);
    if (change === "head") f.ctx.git.head = async () => "b".repeat(40);
    if (change === "dirty") f.ctx.git.dirty = async () => ({ modified: 1, untracked: 0 });
    if (change === "evidence") rmSync(join(f.dir, "verification.json"));
    await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
    assert.deepEqual(f.calls, ["commit", "verify"]);
    assert.equal(readJson(join(f.dir, "result-application.json")).phase, "blocked");
  }
});

test("journal restart repairs a crash between checkpoint and append with an explicit stable gap", () => {
  const dir = tempHome(), eventId = "lost-event", provider = "fixture";
  const key = sha(JSON.stringify([provider, null, null, eventId]));
  writeJsonAtomic(join(dir, "journal.json"), { version: 1, sequence: 1, pending: { hash: key, eventId, timestamp: 1, offset: 0 } });
  const journal = journalFor(dir, { taskId: "task", runId: "run", provider });
  assert.deepEqual(journal.append({ eventId, type: "output", data: "replay" }), { sequence: 1, eventId });
  const records = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").slice(0, -1).map(JSON.parse);
  assert.equal(records.length, 1); assert.equal(records[0].type, "gap");
  assert.equal(logWindow(dir).ids[0], 1);
  const next = journal.append({ eventId: "after", type: "output", data: "continued" });
  assert.equal(next.sequence, 2);
});

test("journal recovery truncates partial tails, preserves a large prefix and replays one stable gap", () => {
  for (const tail of ['{"version":1', 'invalid JSON\npartial', '{"sequence":999}\n', '{"data":"' + "x".repeat(LOG_LIMITS.lineBytes * 2)]) {
    const dir = tempHome(), options = { taskId: "task", runId: "run", provider: "fixture", secrets: ["private-fixture-value"] };
    const journal = journalFor(dir, options);
    for (let i = 1; i <= 9; i++) journal.append({ eventId: `prefix-${i}`, type: "output", data: "x".repeat(32_768) });
    const events = join(dir, "events.jsonl"), prefix = readFileSync(events);
    assert.ok(prefix.length > LOG_LIMITS.windowBytes);
    const eventId = "lost-event", providerJobId = "p1", turnId = "t1", sequence = 10;
    const key = sha(JSON.stringify([options.provider, providerJobId, turnId, eventId]));
    const pending = { hash: key, eventId, timestamp: 1, offset: prefix.length };
    writeFileSync(events, Buffer.concat([prefix, Buffer.from(tail)]));
    writeJsonAtomic(join(dir, "journal.json"), { version: 1, sequence, pending });
    const recovered = journalFor(dir, options), text = readFileSync(events, "utf8");
    const records = text.split("\n").slice(0, -1).map(JSON.parse);
    assert.deepEqual(Buffer.from(text).subarray(0, prefix.length), prefix);
    assert.deepEqual(records.map(r => r.sequence), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.equal(records.at(-1).type, "gap"); assert.equal(records.at(-1).eventId, eventId);
    assert.equal(records.at(-1).taskId, options.taskId); assert.equal(records.at(-1).runId, options.runId);
    assert.equal(records.at(-1).provenance, "coordinator"); assert.equal(records.at(-1).timestamp, 1);
    assert.deepEqual(recovered.append({ eventId, providerJobId, turnId, data: "private-fixture-value" }), { sequence, eventId });
    assert.equal(readFileSync(events, "utf8"), text);
    assert.equal(logWindow(dir).ids.at(-1), sequence);
    // Crash after replacing the tail but before clearing its checkpoint.
    writeJsonAtomic(join(dir, "journal.json"), { version: 1, sequence, pending });
    const restart = journalFor(dir, options);
    assert.equal(readFileSync(events, "utf8"), text); assert.equal(logWindow(dir).ids.at(-1), sequence);
    assert.equal(restart.append({ eventId: "next", type: "output", data: "private-fixture-value continued" }).sequence, sequence + 1);
    const final = readFileSync(events, "utf8");
    assert.equal(final.split("\n").slice(0, -1).map(JSON.parse).length, 11);
    assert.doesNotMatch(final + readFileSync(join(dir, "job.log"), "utf8"), /private-fixture-value/);
  }
});

test("journal recovery retains complete pending records and repairs their missing newline", () => {
  for (const delimiter of ["", "\n"]) {
    const dir = tempHome(), options = { taskId: "task", runId: "run", provider: "fixture" };
    const journal = journalFor(dir, options); journal.append({ eventId: "first", type: "output", data: "first" });
    const events = join(dir, "events.jsonl"), prefix = readFileSync(events);
    const record = { version: 1, ...options, sequence: 2, eventId: "pending", timestamp: 1, provenance: "provider", type: "output", data: "fully written" };
    const key = sha(JSON.stringify([options.provider, null, null, record.eventId]));
    writeFileSync(events, Buffer.concat([prefix, Buffer.from(JSON.stringify(record) + delimiter)]));
    writeJsonAtomic(join(dir, "journal.json"), { version: 1, sequence: 2, pending: { hash: key, eventId: record.eventId, timestamp: 1, offset: prefix.length } });
    const recovered = journalFor(dir, options);
    assert.deepEqual(recovered.append({ eventId: "pending", data: "replay" }), { sequence: 2, eventId: "pending" });
    assert.equal(recovered.append({ eventId: "after", type: "output", data: "after" }).sequence, 3);
    const text = readFileSync(events, "utf8"), records = text.split("\n").slice(0, -1).map(JSON.parse);
    assert.equal(records.length, 3); assert.deepEqual(records[1], record);
    assert.deepEqual(Buffer.from(text).subarray(0, prefix.length), prefix);
    journalFor(dir, options); assert.equal(readFileSync(events, "utf8"), text);
    assert.deepEqual(logWindow(dir).ids, [1, 2, 3]);
  }
});

test("journal recovery preserves a truncated acknowledged prefix and requires its matching backup", () => {
  const dir = tempHome(), options = { taskId: "task", runId: "run", provider: "fixture" };
  const journal = journalFor(dir, options); journal.append({ eventId: "first", type: "output", data: "first" });
  const events = join(dir, "events.jsonl"), offset = statSync(events).size;
  const key = sha(JSON.stringify([options.provider, null, null, "pending"]));
  const checkpoint = { version: 1, sequence: 2, pending: { hash: key, eventId: "pending", timestamp: 1, offset } };
  const partial = '{"version":1'; writeFileSync(events, partial);
  writeJsonAtomic(join(dir, "journal.json"), checkpoint);
  assert.throws(() => journalFor(dir, options), /acknowledged journal prefix is truncated.*restore a matching journal backup/);
  assert.equal(readFileSync(events, "utf8"), partial);
  assert.deepEqual(readJson(join(dir, "journal.json")), checkpoint);
  assert.throws(() => readFileSync(join(dir, "event-keys", key)), { code: "ENOENT" });
});

test("projection retention preserves replay numbers and reports removed history", () => {
  const dir = tempHome(), journal = journalFor(dir, { taskId: "t", runId: "r", provider: "p" });
  journal.append({ eventId: "one", data: "one" }); journal.append({ eventId: "two", data: "two" });
  rmSync(join(dir, "job.log")); rmSync(join(dir, "job.idx"));
  journal.append({ eventId: "three", data: "three" });
  const window = logWindow(dir);
  assert.deepEqual(window.ids, [3]); assert.match(window.gap, /window|interrupted|rotation|retention/);
  assert.equal(journal.append({ eventId: "one", data: "replay" }).sequence, 1);
});

test("coordinator startup and scoped slow progress leave an unrelated GitHub task advancing", async () => {
  const f = remote(), home = tempHome(), state = makeState(home);
  const service = makeExecution({ root: f.root, taskId: "acme/widget/remote", provider: "openai-agents", account: "test", transport: f.transport, capabilities: f.capabilities, clock: f.clock, limits: { deadlineMs: 10 } });
  const run = await service.submit(input);
  f.transport.inspect = () => new Promise(() => {});
  state.put("acme/widget/remote", { ...newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", state: STATES.running, nowIso: T0 }), last: { run: run.id, exit: null } });
  state.put("acme/widget/review", newEntry({ repo: "acme/widget", harness: "codex", branch: "work/review", pr: 2, state: STATES.prOpen, nowIso: T0 }));
  let reviewReached;
  const reviewing = new Promise(resolve => { reviewReached = resolve; });
  const gh = fakeGh({ pr: { state: "MERGED" } });
  gh.prView = async () => { reviewReached(); return { state: "MERGED" }; };
  const ctx = { home, config: CONFIG, clock: f.clock, state, gh, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null, runnerFor: () => ({ current: () => null }), executionFor: id => id.endsWith("/remote") ? service : { current: () => null } };
  const tick = makeTick(ctx).tick(); await reviewing; await tick;
  assert.equal(state.get("acme/widget/review").state, STATES.done);
  assert.equal(state.get("acme/widget/remote").execution.providerState, "status-unknown");
});

test("owned already-applied results reconcile after a lost commit acknowledgement", async () => {
  const f = resultFixture(); writeFileSync(join(f.entry.worktree, "a.txt"), "after");
  f.ctx.git.head = async () => "b".repeat(40); f.ctx.git.resultHeadMatches = async () => true;
  await reconcileExecutionResult(f.ctx, f);
  assert.equal(readJson(join(f.dir, "verification.json")).head, "b".repeat(40));
  const bad = resultFixture(); writeFileSync(join(bad.entry.worktree, "a.txt"), "after");
  bad.ctx.git.head = async () => "b".repeat(40); bad.ctx.git.resultHeadMatches = async () => false;
  await assert.rejects(reconcileExecutionResult(bad.ctx, bad), /input head changed/);
});

test("verification evidence records an actual approved command, independent of provider claims", async () => {
  const f = resultFixture(); delete f.verify;
  const result = await reconcileExecutionResult(f.ctx, f);
  assert.equal(result.evidence[0].output, "verified"); assert.equal(result.evidence[0].exit, 0);
});

test("cancellation during verification fences publication and retains verification evidence", async () => {
  const f = resultFixture(); let stopped = false;
  f.ctx.state = { get: () => ({ ...f.entry, dispatch_stopped: stopped ? "cancellation-requested" : null }) };
  f.verify = async () => { f.calls.push("verify"); stopped = true; return { stdout: "verified" }; };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /concurrent stop/);
  assert.deepEqual(f.calls, ["commit", "verify"]); assert.equal(readJson(join(f.dir, "verification.json")).evidence[0].exit, 0);
});

test("slow remote result collection cannot occupy the GitHub review lane", async () => {
  const f = remote(), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
  const service = makeExecution({ root: f.root, taskId: id, provider: "openai-agents", account: "test", transport: f.transport, capabilities: f.capabilities, clock: f.clock, limits: { deadlineMs: 20 } });
  const run = await service.submit(input); f.observe({ state: "succeeded" }); await service.reconcile({ force: true });
  f.transport.collect = () => new Promise(() => {});
  state.put(id, { ...newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", state: STATES.running, nowIso: T0 }), last: { run: run.id, exit: null } });
  state.put("acme/widget/review", newEntry({ repo: "acme/widget", harness: "codex", branch: "work/review", pr: 2, state: STATES.prOpen, nowIso: T0 }));
  let reviewReached; const reviewing = new Promise(resolve => { reviewReached = resolve; });
  const gh = fakeGh(); gh.prView = async () => { reviewReached(); return { state: "MERGED" }; };
  const ctx = { home, config: { ...CONFIG, execution: { concurrency: 1 } }, clock: f.clock, state, gh, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null, executionFor: key => key === id ? service : { current: () => null } };
  const tick = makeTick(ctx).tick(); await reviewing; await tick;
  assert.equal(state.get("acme/widget/review").state, STATES.done); assert.equal(service.current().execution.collected, false);
});

test("prototype-sensitive operation IDs and provider result fields cannot replace owned identities", async () => {
  const f = remote();
  const job = await f.service.submit({ ...input, operationId: "__proto__" });
  assert.equal((await f.reopen().submit({ ...input, operationId: "__proto__" })).id, job.id);
  assert.equal(f.calls.filter(x => x[0] === "submit").length, 1);
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true });
  const collect = f.transport.collect;
  f.transport.collect = async req => ({ ...await collect(req), version: 99, taskId: "forged", runId: "forged" });
  const result = await f.service.collect();
  assert.equal(result.version, 1); assert.equal(result.taskId, "acme/widget/remote"); assert.equal(result.runId, job.id);
});

test("accepted correction recovers workflow ownership after a lost registry acknowledgement", async () => {
  const f = remote(), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
  const cursor = { since: T0, dispatched: ["feedback-1"], fixed_sha: input.inputHead };
  const run = await f.service.submit({ ...input, operationId: "old-run:0:fix", workflow: { state: STATES.running, cursor, lastEvent: "fixed feedback-1" } });
  state.put(id, { ...newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", state: STATES.running, nowIso: T0 }), last: { run: "old-run", exit: 0 } });
  const ctx = { home, config: CONFIG, clock: f.clock, state, gh: fakeGh(), ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null, executionFor: () => f.service };
  await makeTick(ctx).tick();
  assert.equal(state.get(id).last.run, run.id); assert.deepEqual(state.get(id).cursor, cursor);
  await makeTick(ctx).tick();
  assert.equal(f.calls.filter(x => x[0] === "submit").length, 1);
});

test("saved result route survives log retention, rejects traversal and never polls a provider", async () => {
  const home = tempHome(), id = "acme/widget/remote", root = join(home, "runs", idSlug(id)), f = remote();
  const service = makeExecution({ root, taskId: id, provider: "openai-agents", account: "test", transport: f.transport, capabilities: f.capabilities, clock: f.clock });
  const job = await service.submit(input); f.observe({ state: "succeeded" }); await service.reconcile({ force: true }); await service.collect();
  rmSync(join(service.dirOf(job.id), "job.log"), { force: true });
  const state = makeState(home); state.put(id, newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", state: STATES.running, nowIso: T0 }));
  const ctx = { home, state, executionFor: () => service }, before = f.calls.length;
  const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
  routes["GET /api/run/result"](ctx, {}, response, new URL(`http://localhost/api/run/result?id=${id}&run=${job.id}`));
  assert.equal(response.code, 200); assert.equal(JSON.parse(response.body).outcome.ok, true);
  // Version 1 caches from before the separate summary remain readable.
  const legacy = service.result(job.id); delete legacy.artifacts;
  legacy.files = Array.from({ length: 110 }, (_, i) => ({ path: `legacy-${i}.txt`, afterHash: sha(String(i)), text: "private payload" }));
  writeJsonAtomic(join(service.dirOf(job.id), "result.json"), legacy);
  routes["GET /api/run/result"](ctx, {}, response, new URL(`http://localhost/api/run/result?id=${id}&run=${job.id}`));
  assert.equal(JSON.parse(response.body).artifacts.length, 100);
  assert.deepEqual(JSON.parse(response.body).artifacts[0], { path: "legacy-0.txt", hash: sha("0") });
  assert.doesNotMatch(response.body, /private payload/);
  routes["GET /api/run/result"](ctx, {}, response, new URL(`http://localhost/api/run/result?id=${id}&run=..%2foutside`));
  assert.equal(response.code, 404); assert.equal(f.calls.length, before);
});

test("encoded control characters cannot amplify a log window beyond its byte budget", () => {
  const dir = tempHome();
  for (let i = 0; i < 100; i++) appendProjection(dir, "\u0001".repeat(1500));
  const window = logWindow(dir);
  assert.ok(Buffer.byteLength(JSON.stringify(window.lines)) <= LOG_LIMITS.windowBytes);
  assert.ok(window.lines.length < 100); assert.match(window.gap, /window/);
});

test("confirmed local cancellation quarantines late output and expired diagnostics are removed", async () => {
  const root = tempHome(), clock = makeClock(), runner = makeRunner(root, { clock, probe: () => false, processes: () => [] });
  const service = makeExecution({ root, taskId: "local-cancel", provider: "codex", runner, clock });
  const job = await service.start("fixture", process.execPath, ["-e", 'process.stdout.write("{\\"type\\":\\"turn.completed\\"}\\n")'], { cwd: tempHome(), execution: { operationId: "cancel" } });
  while (runner.read(job.id).exit === null) await new Promise(resolve => setImmediate(resolve));
  await service.cancel(); await service.reconcile();
  assert.equal(service.current().execution.quarantined, true);
  await assert.rejects(service.collect(), { code: "EXECUTION_QUARANTINED" });
  const dir = service.dirOf(job.id); writeJsonAtomic(join(dir, "result.json"), { outcome: { ok: false } });
  clock.advance(24 * 60 + 1); runner.observe();
  assert.throws(() => readFileSync(join(dir, "provider.log")), { code: "ENOENT" });
});

test("every local adapter retains recorded sessions across legacy upgrade and missing echoed IDs", async () => {
  for (const provider of Object.keys(adapters)) {
    const root = tempHome(), session = provider === "goose" ? "work-owned-session" : "22222222-2222-4222-8222-222222222222";
    let current = { id: "legacy-run", exit: 0, running: false, name: "legacy", bin: provider };
    const runner = { current: () => current, lines: () => [], annotate() {},
      start: async (name, cmd, args, options) => current = { id: options.runId, name, exit: 0, running: false, bin: cmd },
      settle: () => current };
    const service = makeExecution({ root, taskId: `local/${provider}`, provider, runner, legacySessionId: session });
    await assert.rejects(service.continue({ operationId: "foreign", sessionId: "another-session" }), { code: "EXECUTION_CONTINUATION" });
    const input = { operationId: "upgrade", sessionId: session, spec: { cmd: provider, args: [], options: {} } };
    const upgraded = await service.continue(input); service.settle(upgraded.id, () => 1);
    assert.equal(service.sessionFrom(upgraded.id), session);
    const next = await service.continue({ ...input, operationId: "next" });
    assert.equal(next.execution.sessionId, session);
    const initial = makeExecution({ root: tempHome(), taskId: `new/${provider}`, provider, runner: { ...runner, current: () => null } });
    const first = await initial.submit({ operationId: "first", recordedSessionId: session, spec: input.spec });
    assert.equal(first.execution.sessionId, session);
  }
});

test("shared resume uses remote capabilities and owned sessions without a fake CLI", async () => {
  const f = remote(), home = tempHome(), state = makeState(home), id = "acme/widget/remote", worktree = tempHome();
  const run = await f.service.submit(input); f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect();
  state.put(id, { ...newEntry({ repo: "acme/widget", harness: "openai-agents", session: run.execution.sessionId, branch: "work/remote", worktree, state: STATES.needsHuman, nowIso: T0 }), execution: f.service.current().execution, last: { run: run.id, exit: 0 } });
  const ctx = { home, config: CONFIG, state, clock: f.clock, gh: fakeGh(), git: fakeGit(), credential: fakeCredential(), identity: fakeIdentity(), log: silentLog, notify: fakeNotify(), executionFor: () => f.service, readPrd: () => null };
  const resumed = await resume(ctx, { handle: id });
  assert.equal(resumed.attach, null); assert.equal(resumed.session, run.execution.sessionId);
  assert.equal(f.calls.filter(x => x[0] === "continue").length, 1); assert.equal(f.service.current().bin, undefined);
});

test("local settlement shares the cancellation/reconciliation lock before mutating output", () => {
  const root = tempHome(); let mutated = false;
  const service = makeExecution({ root, taskId: "local/lock", provider: "codex", runner: { settle: () => { mutated = true; } } });
  const lock = acquireProcessLock(join(root, "execution.lock"), "execution");
  try { assert.throws(() => service.settle("owned-run", () => 0), /already running/); assert.equal(mutated, false); }
  finally { lock.release(); }
});

test("reported usage above a reservation exhausts allowance without double charging replay", async () => {
  const f = remote(); await f.service.submit(input);
  f.observe({ state: "succeeded", costUsd: 1.1 });
  await f.service.reconcile({ force: true });
  assert.equal(f.service.state().allowance.chargedUsd, 1.1);
  await f.service.reconcile({ force: true }); await f.service.collect();
  assert.equal(f.reopen().state().allowance.chargedUsd, 1.1);
  await assert.rejects(f.reopen().continue({ ...input, operationId: "over-budget", sessionId: "session-1" }), { code: "EXECUTION_ALLOWANCE" });
  assert.equal(f.calls.filter(x => x[0] === "continue").length, 0);
});

for (const provider of ["openai-agents", "codex-cloud"]) {
  test(`${provider} fixture: applied cancellation survives unknown submission and cancels recovered ownership once`, async () => {
    const f = remote(provider), submit = f.transport.submit;
    f.transport.submit = async req => { await submit(req); throw new Error("reply lost"); };
    await assert.rejects(f.service.submit(input), /reply lost/);
    const run = f.service.current(), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
    state.put(id, { ...newEntry({ repo: "acme/widget", harness: provider, branch: "work/remote", state: STATES.running, nowIso: T0 }),
      last: { run: run.id, exit: null }, control: { id: "cancel-unknown", action: "cancel", status: "queued" }, dispatch_stopped: "cancellation-requested" });
    const ctx = { home, config: CONFIG, clock: f.clock, state, gh: fakeGh(), ownLogin: "me", git: fakeGit(), log: silentLog,
      notify: fakeNotify(), readPrd: () => null, executionFor: () => f.reopen() };
    await makeTick(ctx).tickEntry(id, state.get(id));
    assert.equal(state.get(id).control.status, "applied");
    assert.equal(state.get(id).reason, "cancellation-requested");
    const persisted = f.service.state().current.execution.cancellation;
    assert.equal(persisted.status, "pending"); assert.equal(persisted.attempts, 0);
    assert.equal(f.calls.some(c => c[0] === "cancel"), false);
    const restarted = { ...ctx, state: makeState(home) };
    await makeTick(restarted).tickEntry(id, restarted.state.get(id));
    await makeTick(restarted).tickEntry(id, restarted.state.get(id));
    const cancelled = f.reopen().current();
    assert.equal(cancelled.execution.acceptance, "accepted");
    assert.equal(cancelled.execution.providerState, "cancelled"); assert.equal(cancelled.execution.quarantined, true);
    assert.equal(cancelled.execution.cancellation.status, "confirmed");
    assert.equal(cancelled.execution.costUsd, null);
    assert.equal(restarted.state.get(id).reason, "cancelled");
    assert.equal(restarted.state.get(id).control.id, "cancel-unknown");
    assert.equal(restarted.state.get(id).control.message, "Cancellation confirmed.");
    const stops = f.calls.filter(c => c[0] === "cancel");
    assert.equal(stops.length, 1); assert.equal(stops[0][1].providerJobId, "job-1"); assert.equal(stops[0][1].turnId, "turn-1");
    assert.equal(stops[0][1].account, "test"); assert.equal(stops[0][1].idempotencyKey, persisted.idempotencyKey);
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    await assert.rejects(f.reopen().continue({ ...input, operationId: "after-cancel", sessionId: "session-1" }), { code: "EXECUTION_STOPPED" });
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_QUARANTINED" });
    assert.equal(f.calls.filter(c => c[0] === "collect").length, 0);
  });
}

test("cancellation retries lost replies with one durable key and bounded restart backoff", async () => {
  const f = remote(); await f.service.submit(input);
  f.transport.cancel = async req => { f.calls.push(["cancel", req]); throw new Error("lost cancellation reply"); };
  await assert.rejects(f.service.cancel("timeout"), /lost cancellation reply/);
  const intent = f.service.current().execution.cancellation;
  assert.equal(intent.status, "pending"); assert.equal(intent.attempts, 1);
  for (let i = 0; i < 5; i++) await f.reopen().reconcile({ force: true });
  assert.equal(f.calls.filter(c => c[0] === "cancel").length, 1);
  f.clock.advance(intent.nextAttemptAt - f.clock.now());
  await f.reopen().reconcile();
  const second = f.service.current().execution.cancellation;
  assert.equal(second.attempts, 2); assert.ok(second.nextAttemptAt > intent.nextAttemptAt);
  f.transport.cancel = async req => { f.calls.push(["cancel", req]); return { confirmed: false }; };
  f.clock.advance(second.nextAttemptAt - f.clock.now()); await f.reopen().reconcile();
  assert.equal(f.service.current().execution.cancellation.status, "acknowledged");
  for (let i = 0; i < 5; i++) await f.reopen().reconcile({ force: true });
  assert.equal(f.calls.filter(c => c[0] === "cancel").length, 3);
  assert.equal(new Set(f.calls.filter(c => c[0] === "cancel").map(c => c[1].idempotencyKey)).size, 1);
  f.observe({ state: "cancelled" }); await f.reopen().reconcile({ force: true });
  assert.equal(f.service.current().execution.cancellation.status, "confirmed");
  assert.equal(f.service.current().execution.providerState, "cancelled");
});

test("pending cancellation refuses incomplete lookup ownership and never calls an unsupported stop", async () => {
  for (const supported of [true, false]) {
    const f = remote(), submit = f.transport.submit;
    f.capabilities.controls.cancel = supported;
    f.transport.submit = async req => { await submit(req); throw new Error("reply lost"); };
    await assert.rejects(f.service.submit(input)); await f.service.cancel();
    const lookup = f.transport.lookup;
    f.transport.lookup = async req => ({ ...await lookup(req), turnId: null });
    await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.acceptance, "unknown");
    assert.equal(f.service.current().execution.recoveryAction, "EXECUTION_OWNERSHIP");
    assert.equal(f.calls.some(c => c[0] === "cancel"), false);
    f.transport.lookup = lookup; await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.cancellation.status, supported ? "confirmed" : "unsupported");
    assert.equal(f.calls.filter(c => c[0] === "cancel").length, supported ? 1 : 0);
  }
});

test("natural completion after a pending stop quarantines results without claiming cancellation", async () => {
  const f = remote(), submit = f.transport.submit;
  f.transport.submit = async req => { await submit(req); throw new Error("reply lost"); };
  await assert.rejects(f.service.submit(input)); await f.service.cancel();
  const lookup = f.transport.lookup;
  f.transport.lookup = async req => ({ ...await lookup(req), state: "succeeded" });
  await f.reopen().reconcile({ force: true });
  assert.equal(f.service.current().execution.providerState, "succeeded");
  assert.equal(f.service.current().execution.cancellation.status, "terminal");
  assert.equal(f.service.current().execution.quarantined, true);
  assert.deepEqual(await f.service.cancel(), { confirmed: false });
  assert.equal(f.calls.some(c => c[0] === "cancel"), false);
  await assert.rejects(f.service.collect(), { code: "EXECUTION_QUARANTINED" });
});

test("remote dispatch and continuation require exact job and root-turn acknowledgements", async () => {
  for (const acknowledgement of [{ providerJobId: "job-1" }, { providerJobId: "job-1", turnId: " " }, { providerJobId: 1, turnId: "root" }]) {
    const f = remote(), submit = f.transport.submit;
    f.transport.submit = async req => { await submit(req); return acknowledgement; };
    await assert.rejects(f.service.submit(input), { code: "EXECUTION_UNKNOWN" });
    assert.equal(f.reopen().current().execution.acceptance, "unknown");
    assert.equal(f.service.current().running, true); assert.equal(f.service.state().allowance.reservedUsd, 0.1);
    await assert.rejects(f.service.submit(input), { code: "EXECUTION_UNKNOWN" });
    await assert.rejects(f.service.submit({ ...input, operationId: "replacement" }), { code: "BUSY" });
    await assert.rejects(f.service.collect(), { code: "EXECUTION_RESULT" });
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.turnId, "turn-1");
    assert.equal(f.service.current().execution.acceptance, "accepted");
  }
  const f = remote(); const job = await f.service.submit(input);
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect();
  f.transport.continue = async req => { f.calls.push(["continue", req]); return { providerJobId: "job-2", sessionId: req.sessionId }; };
  const followup = { ...input, operationId: "followup", sessionId: job.execution.sessionId };
  await assert.rejects(f.service.continue(followup), { code: "EXECUTION_UNKNOWN" });
  await assert.rejects(f.reopen().continue(followup), { code: "EXECUTION_UNKNOWN" });
  assert.equal(f.calls.filter(c => c[0] === "continue").length, 1);
});

test("incomplete legacy remote ownership cannot settle, reuse an acknowledgement or collect cached results", async () => {
  const f = remote(), job = await f.service.submit(input);
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect();
  const raw = f.service.state();
  Object.assign(raw.current.execution, { turnId: null, providerState: "succeeded", collected: true });
  raw.operations.first.job.execution.turnId = null;
  assert.equal(executionLive(raw.current), true, "raw job projections cannot settle unqualified remote ownership");
  delete raw.current.execution.transport;
  assert.equal(executionLive(raw.current), true, "older remote metadata uses the canonical capability registry");
  writeJsonAtomic(join(f.root, "execution.json"), raw);
  const cached = readJson(join(f.service.dirOf(job.id), "result.json"));
  cached.turnId = null; writeJsonAtomic(join(f.service.dirOf(job.id), "result.json"), cached);
  assert.equal(f.reopen().current().running, true); assert.equal(f.reopen().current().execution.acceptance, "unknown");
  await assert.rejects(f.reopen().submit(input), { code: "EXECUTION_UNKNOWN" });
  await assert.rejects(f.reopen().collect(), { code: "EXECUTION_RESULT" });
  const lookup = f.transport.lookup;
  f.transport.lookup = async req => ({ ...await lookup(req), turnId: null, state: "succeeded" });
  await f.reopen().reconcile({ force: true });
  assert.equal(f.service.current().execution.acceptance, "unknown");
  assert.equal(f.calls.filter(c => c[0] === "inspect").length, 1); // Only the original qualified run.
  f.transport.lookup = lookup; await f.reopen().reconcile({ force: true });
  assert.equal(f.service.current().execution.turnId, "turn-1");
  await assert.rejects(f.service.collect(), { code: "EXECUTION_RESULT" }); // Cached null/wrong turn is rejected too.
  assert.equal(f.calls.filter(c => c[0] === "collect").length, 1);
});

test("unacknowledged cancellation remains pending and older stopped records recover the same stop intent", async () => {
  const f = remote(); await f.service.submit(input);
  f.transport.cancel = async req => { f.calls.push(["cancel", req]); return null; };
  await assert.rejects(f.service.cancel(), { code: "EXECUTION_PROTOCOL" });
  const record = f.service.state(), key = record.current.execution.cancellation.idempotencyKey;
  assert.equal(record.current.execution.cancellation.status, "pending");
  delete record.current.execution.cancellation;
  writeJsonAtomic(join(f.root, "execution.json"), record);
  f.transport.cancel = async req => { f.calls.push(["cancel", req]); return { confirmed: true }; };
  await f.reopen().reconcile({ force: true });
  assert.equal(f.service.current().execution.cancellation.status, "confirmed");
  assert.equal(f.service.current().execution.cancellation.idempotencyKey, key);
  assert.equal(f.calls.filter(c => c[0] === "cancel").length, 2);
});
