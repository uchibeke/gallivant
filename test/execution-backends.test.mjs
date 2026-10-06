import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, symlinkSync, cpSync, statSync, lstatSync, existsSync, chmodSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { makeExecution, executionLive, assertExecutionDependency } from "../lib/execution.mjs";
import { redact, redactResultMetadata, EXECUTION_CURSOR_BYTES } from "../lib/execution_io.mjs";
import { executionRegistry, adapters, buildRun } from "../lib/harness.mjs";
import { makeProviderHealth } from "../lib/provider_health.mjs";
import { makeRunner, LOCAL_OUTPUT_LIMITS } from "../lib/run.mjs";
import { journalFor } from "../lib/execution_journal.mjs";
import { logWindow, LOG_LIMITS, appendProjection } from "../lib/run_log.mjs";
import { streamRun, sliceRun } from "../lib/tracker/stream.mjs";
import { writeJsonAtomic, readJson } from "../lib/fs.mjs";
import { makeState, newEntry, STATES, idSlug } from "../lib/state.mjs";
import { routes } from "../lib/commands/serve.mjs";
import { makeTick } from "../lib/tick.mjs";
import { reconcileExecutionResult, verificationEnvironment } from "../lib/execution_result.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { acquireProcessLock } from "../lib/daemon.mjs";
import { makeGit, GIT_PATH_LIMITS } from "../lib/git.mjs";
import { execFileAsync } from "../lib/gh.mjs";
import { requestControl, applyControl, cancelControl, controlFailure } from "../lib/control.mjs";
import { tempHome, makeClock, CONFIG, T0, fakeGh, fakeNotify, silentLog, fakeGit, fakeCredential, fakeIdentity, fakeRunner, prFixture, comment, harnessBin, GOOD_PRD, codexLines, claudeResultLines, geminiLines, opencodeLines, gooseLines } from "./helpers.mjs";
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

test("predecessor service is required and managed API is available while Cloud remains reserved", () => {
  assert.throws(() => assertExecutionDependency(null), { code: "EXECUTION_DEPENDENCY" });
  assertExecutionDependency(() => {});
  assert.equal(executionRegistry["openai-agents"].available, true);
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

for (const provider of ["openai-agents", "codex-cloud"]) test(`${provider} fixture: foreign sessions cannot enter observation, collection, cache or continuation ownership`, async t => {
  const f = remote(provider), job = await f.service.submit(input), owned = job.execution.sessionId;
  for (const sessionId of ["foreign-session", "", 42]) {
    f.observe({ sessionId, state: "succeeded", costUsd: 0.8, events: [{ eventId: "foreign", type: "output", data: "foreign event" }] });
    await f.reopen().reconcile({ force: true });
    const ex = f.reopen().current().execution;
    assert.equal(ex.sessionId, owned); assert.equal(ex.acceptance, "accepted"); assert.equal(ex.collected, false);
    assert.equal(ex.providerState, "status-unknown"); assert.equal(ex.recoveryAction, "EXECUTION_OWNERSHIP"); assert.equal(ex.costUsd, null);
    assert.equal(ex.cursor, undefined); assert.equal(ex.terminalState, undefined);
    assert.equal(existsSync(join(f.service.dirOf(job.id), "events.jsonl")), false);
  }
  for (const sessionId of [undefined, null, owned]) {
    f.observe({ sessionId, state: "running", costUsd: null, events: [] }); await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.sessionId, owned); assert.equal(f.service.current().execution.providerState, "running");
  }
  f.observe({ sessionId: owned, state: "succeeded" }); await f.service.reconcile({ force: true });
  const collect = f.transport.collect, path = join(f.service.dirOf(job.id), "result.json");
  for (const sessionId of ["foreign-session", "", 42]) {
    f.transport.collect = async req => ({ ...await collect(req), sessionId });
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_RESULT" }); assert.equal(existsSync(path), false);
    writeJsonAtomic(path, { taskId: "acme/widget/remote", runId: job.id, providerJobId: job.execution.providerJobId, turnId: job.execution.turnId, inputHead: input.inputHead,
      sessionId, outcome: { finished: true, ok: true, cost: null } });
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_RESULT" });
    assert.equal(f.service.current().execution.sessionId, owned); assert.equal(f.service.current().execution.collected, false); rmSync(path);
  }
  f.transport.collect = collect; await f.service.collect();
  const next = f.transport.continue; let reply;
  f.transport.continue = async req => { reply = await next(req); return { ...reply, sessionId: "foreign-session" }; };
  const continuation = { ...input, operationId: "owned-correction", sessionId: owned };
  await assert.rejects(f.reopen().continue(continuation), { code: "EXECUTION_UNKNOWN" });
  assert.equal(f.service.current().execution.sessionId, owned);
  f.transport.lookup = async () => ({ ...reply, sessionId: "foreign-session", state: "running", observedAt: f.clock.now() });
  await f.reopen().reconcile({ force: true }); assert.equal(f.service.current().execution.recoveryAction, "EXECUTION_OWNERSHIP");
  await assert.rejects(f.reopen().continue(continuation), { code: "EXECUTION_UNKNOWN" });
  f.transport.lookup = async () => ({ ...reply, sessionId: owned, state: "running", observedAt: f.clock.now() });
  await f.reopen().reconcile({ force: true }); await f.reopen().continue(continuation);
  assert.equal(f.calls.filter(call => call[0] === "continue").length, 1); assert.equal(f.service.current().execution.sessionId, owned);
  const evidence = join(tempHome(), "session-ownership-evidence.json");
  writeJsonAtomic(evidence, { provider, ownedSession: owned, execution: join(f.root, "execution.json"), rejectedObservationSessions: ["foreign-session", "", 42], continuationCalls: 1 });
  t.diagnostic(`session ownership evidence: ${evidence}`);
});

test("shared publication rejects foreign or malformed sessions before any artifact mutation", async () => {
  for (const sessionId of ["foreign-session", "", 42]) {
    const f = resultFixture(); f.entry.execution.sessionId = "owned-session"; f.result.sessionId = sessionId;
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /does not belong/);
    assert.deepEqual(f.calls, []); assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "before");
  }
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

test("future observations cannot poison inspection or lost-acknowledgement recovery", async t => {
  const evidence = [];
  for (const provider of ["openai-agents", "codex-cloud"]) for (const method of ["inspect", "lookup"]) {
    const f = remote(provider), submit = f.transport.submit, lookup = f.transport.lookup;
    let patch = {};
    if (method === "lookup") {
      f.transport.submit = async req => { await submit(req); throw new Error("lost launch reply"); };
      f.transport.lookup = async req => ({ ...await lookup(req), ...patch });
      await assert.rejects(f.service.submit(input), /lost launch reply/);
    } else { await f.service.submit(input); await f.service.reconcile({ force: true }); }
    const initial = f.service.state(), job = initial.current, before = job.execution;
    const rejected = [];
    for (const observedAt of [f.clock.now() + 1, f.clock.now() * 1000, Number.MAX_SAFE_INTEGER]) for (const state of ["running", "waiting-for-input", "succeeded"]) {
      patch = { observedAt, state, costUsd: 99, cursor: "future-page", events: [{ eventId: "future-event", type: "output", data: "must not enter history" }] };
      if (method === "inspect") f.observe(patch);
      await f.reopen().reconcile({ force: true });
      const saved = f.service.state(), ex = saved.current.execution;
      assert.equal(ex.recoveryAction, "EXECUTION_PROTOCOL"); assert.equal(ex.providerState, "status-unknown");
      for (const key of ["observedAt", "reconciledAt", "terminalState", "terminalObservedAt", "completedAt", "cursor", "costUsd", "acceptance", "providerJobId", "sessionId", "turnId"])
        assert.deepEqual(ex[key], before[key], `${method}: future ${key} is not adopted`);
      assert.equal(ex.collected, false); assert.deepEqual(saved.allowance, initial.allowance);
      assert.equal(ex.nextAttemptAt > f.clock.now(), true);
      const calls = f.calls.length; f.reopen().inspect(); await f.reopen().reconcile(); assert.equal(f.calls.length, calls);
      assert.equal(readJson(join(f.service.dirOf(job.id), "result.json")), null);
      assert.equal(existsSync(join(f.service.dirOf(job.id), "events.jsonl")), false);
      assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
      rejected.push({ observedAt, state, observedBefore: before.observedAt, observedAfter: ex.observedAt, nextAttemptAt: ex.nextAttemptAt });
    }
    const unrelated = remote(provider); await unrelated.service.submit(input); await unrelated.service.reconcile({ force: true });
    assert.equal(unrelated.service.current().execution.providerState, "running");
    patch = { state: "succeeded", observedAt: f.clock.now(), costUsd: null, cursor: "current-page", events: [] };
    if (method === "inspect") f.observe(patch);
    const recovered = f.reopen(); await recovered.reconcile({ force: true }); await recovered.collect();
    assert.equal(recovered.current().running, false); assert.equal(recovered.current().execution.observedAt, f.clock.now());
    assert.equal(recovered.current().execution.providerState, "succeeded"); assert.equal(recovered.current().execution.costUsd, null);
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    evidence.push({ provider, method, runId: job.id, coordinatorAt: f.clock.now(), rejected, fixtureSubmits: 1,
      files: { execution: join(f.root, "execution.json"), job: join(f.service.dirOf(job.id), "job.json"), result: join(f.service.dirOf(job.id), "result.json") } });
  }
  const report = join(tempHome(), "observation-clock-evidence.json"); writeJsonAtomic(report, { cases: evidence });
  t.diagnostic(`observation clock evidence: ${report}`);
});

const CURSOR_BYTES = EXECUTION_CURSOR_BYTES;
test("inspection and acceptance lookup reject invalid cursors before journaling or adopting progress", async t => {
  const circular = {}; circular.self = circular;
  let serializedObjects = 0;
  const invalid = { object: {}, array: [], circular, bigint: 1n, function: () => {}, symbol: Symbol("cursor"),
    nan: NaN, infinity: Infinity, oversized: "x".repeat(CURSOR_BYTES), unicode: "é".repeat(CURSOR_BYTES / 2),
    escaped: "\\".repeat(CURSOR_BYTES / 2), customJSON: { toJSON() { serializedObjects++; return "hidden-object"; } } };
  const evidence = [];
  for (const provider of ["openai-agents", "codex-cloud"]) for (const mode of ["inspect", "lookup"]) {
    const f = remote(provider), submit = f.transport.submit;
    if (mode === "lookup") f.transport.submit = async req => { await submit(req); throw new Error("reply lost"); };
    if (mode === "lookup") await assert.rejects(f.service.submit(input)); else await f.service.submit(input);
    if (mode === "inspect") { f.observe({ cursor: "previous-page" }); await f.service.reconcile({ force: true }); }
    const before = f.service.current(), dir = f.service.dirOf(before.id), stateFile = join(f.root, "execution.json");
    const journalFile = join(dir, "events.jsonl"), journalBefore = existsSync(journalFile) ? readFileSync(journalFile, "utf8") : null;
    const baseBytes = statSync(stateFile).size;
    for (const [kind, cursor] of Object.entries(invalid)) {
      const observation = { providerJobId: "job-1", sessionId: "session-1", turnId: "turn-1", state: "succeeded", observedAt: f.clock.now(),
        cursor, costUsd: 99, events: [{ eventId: `rejected-${kind}`, type: "output", data: "must not be published" }], gap: "must not be journaled" };
      if (mode === "lookup") f.transport.lookup = async req => { f.calls.push(["lookup", req]); return observation; };
      else f.observe(observation);
      await f.reopen().reconcile({ force: true });
      const ex = f.reopen().current().execution;
      assert.equal(ex.recoveryAction, "EXECUTION_PROTOCOL"); assert.equal(ex.providerState, "status-unknown");
      for (const key of ["acceptance", "providerJobId", "sessionId", "turnId", "cursor", "observedAt", "costUsd"]) assert.equal(ex[key], before.execution[key], key);
      assert.equal(ex.collected, false); assert.equal(ex.terminalState, before.execution.terminalState); assert.ok(ex.nextAttemptAt > f.clock.now());
      assert.equal(existsSync(journalFile) ? readFileSync(journalFile, "utf8") : null, journalBefore);
      assert.ok(statSync(stateFile).size < baseBytes + 1024); assert.ok(statSync(join(dir, "job.json")).size < baseBytes + 1024);
      const calls = f.calls.length; f.reopen().inspect(); assert.equal(f.calls.length, calls);
      await assert.rejects(f.reopen().submit({ ...input, operationId: "replacement" }), { code: "BUSY" });
      if (mode === "lookup") await assert.rejects(f.reopen().submit(input), { code: "EXECUTION_UNKNOWN" });
    }
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    if (mode === "inspect") assert.ok(f.calls.filter(c => c[0] === "inspect").every(c => c[1].cursor === null || c[1].cursor === "previous-page"));
    const restored = { providerJobId: "job-1", sessionId: "session-1", turnId: "turn-1", state: "running", observedAt: f.clock.now(), cursor: "recovered-page", costUsd: null, events: [], gap: null };
    if (mode === "lookup") f.transport.lookup = async req => { f.calls.push(["lookup", req]); return restored; }; else f.observe(restored);
    await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.acceptance, "accepted"); assert.equal(f.service.current().execution.cursor, "recovered-page");
    assert.equal(f.service.current().execution.recoveryAction, null);
    evidence.push({ provider, mode, rejected: Object.keys(invalid), runId: before.id, baseBytes, finalBytes: statSync(stateFile).size,
      paidDispatches: f.calls.filter(c => c[0] === "submit").length, files: { execution: stateFile, job: join(dir, "job.json") } });
  }
  assert.equal(serializedObjects, 0);
  const report = join(tempHome(), "cursor-rejection-evidence.json"); writeJsonAtomic(report, { cases: evidence }); t.diagnostic(`cursor rejection evidence: ${report}`);
});

test("bounded JSON scalar cursors survive restart and long-cursor gap replay without growing identities", async t => {
  const values = { short: "page-2", empty: "", number: 3, false: false, true: true, maximumNumber: Number.MAX_VALUE,
    asciiBoundary: "x".repeat(CURSOR_BYTES - 2), unicodeBoundary: "é".repeat((CURSOR_BYTES - 2) / 2),
    hashLookalike: sha(JSON.stringify(["x".repeat(CURSOR_BYTES - 2)])),
    escapedBoundary: "\\".repeat((CURSOR_BYTES - 2) / 2), omitted: undefined, nullable: null };
  const evidence = [];
  for (const provider of ["openai-agents", "codex-cloud"]) {
    const f = remote(provider), job = await f.service.submit(input), dir = f.service.dirOf(job.id);
    let retained = null;
    for (const [kind, cursor] of Object.entries(values)) {
      const previousCount = existsSync(join(dir, "events.jsonl")) ? readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").length : 0;
      f.observe({ cursor, state: "running", events: [{ eventId: `accepted-${kind}`, type: "output", data: kind }], gap: "explicit provider history gap" });
      await f.reopen().reconcile({ force: true }); retained = cursor ?? retained;
      assert.equal(f.reopen().current().execution.cursor, retained);
      const records = readFileSync(join(dir, "events.jsonl"), "utf8"), count = records.trim().split("\n").length;
      assert.equal(count, previousCount + 2); // A token cannot mimic a hashed gap and suppress its own gap.
      await f.reopen().reconcile({ force: true });
      assert.equal(f.calls.at(-1)[1].cursor, retained);
      assert.equal(readFileSync(join(dir, "events.jsonl"), "utf8"), records);
      assert.equal(f.service.current().execution.recoveryAction, null);
      assert.ok(records.trim().split("\n").map(JSON.parse).every(e => e.eventId.length <= 512));
      assert.ok(records.includes('"eventId":"gap-page-2"'));
      assert.ok(statSync(join(f.root, "execution.json")).size < 16_384);
      evidence.push({ provider, kind, serializedBytes: cursor == null ? null : Buffer.byteLength(JSON.stringify(cursor)), events: count, runId: job.id,
        files: { execution: join(f.root, "execution.json"), job: join(dir, "job.json"), events: join(dir, "events.jsonl"), log: join(dir, "job.log") } });
    }
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
  }
  const report = join(tempHome(), "cursor-replay-evidence.json"); writeJsonAtomic(report, { cases: evidence }); t.diagnostic(`cursor replay evidence: ${report}`);
});

test("invalid persisted cursors refuse inspection and redispatch with a checkpoint recovery remedy", async () => {
  for (const location of ["current", "acknowledgement"]) for (const cursor of [{ page: 1 }, "x".repeat(CURSOR_BYTES), "\\".repeat(CURSOR_BYTES / 2)]) {
    const f = remote(), job = await f.service.submit(input); f.observe({ cursor: "known-page" }); await f.service.reconcile({ force: true });
    const stateFile = join(f.root, "execution.json"), original = readFileSync(stateFile, "utf8"), raw = JSON.parse(original);
    (location === "current" ? raw.current : raw.operations.first.job).execution.cursor = cursor; writeJsonAtomic(stateFile, raw);
    const corrupted = readFileSync(stateFile, "utf8"), projected = readFileSync(join(f.service.dirOf(job.id), "job.json"), "utf8"), calls = f.calls.length;
    const check = error => error.code === "EXECUTION_PROTOCOL" && /persisted.*cursor.*preserve.*restore.*do not redispatch/.test(error.message);
    assert.throws(() => f.reopen().inspect(), check); await assert.rejects(f.reopen().reconcile({ force: true }), check);
    await assert.rejects(f.reopen().continue({ ...input, operationId: "new", sessionId: job.execution.sessionId }), check);
    assert.equal(f.calls.length, calls); assert.equal(readFileSync(stateFile, "utf8"), corrupted);
    assert.equal(readFileSync(join(f.service.dirOf(job.id), "job.json"), "utf8"), projected);
    writeFileSync(stateFile, original); await f.reopen().reconcile({ force: true });
    assert.equal(f.service.current().execution.cursor, "known-page"); assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
  }
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

test("due and queued provider health fences survive read-only access and restart without blocking fresh accounts", async () => {
  const home = tempHome(), clock = makeClock(), calls = [], replies = new Map();
  let delayed = false;
  const options = { home, clock, limits: { progressMs: 10_000, deadlineMs: 1000, concurrency: 1 }, jitter: () => 0,
    probe: async (provider, account) => {
      calls.push([provider, account]);
      return delayed ? new Promise(resolve => replies.set(account, resolve)) : { ok: true, detail: "fixture account ready" };
    } };
  const health = makeProviderHealth(options);
  await health.refresh([["codex", "expired"], ["codex", "queued"]]);
  clock.advance(5000 / 60_000);
  await health.refresh([["codex", "fresh"], ["codex-cloud", "fresh"]]);
  clock.advance(4999 / 60_000); assert.equal(health.get("codex", "expired").ok, true);
  clock.advance(1 / 60_000);
  const original = readFileSync(join(home, "provider-health.json"), "utf8"), before = calls.length;
  for (let i = 0; i < 20; i++) {
    assert.equal(health.get("codex", "expired").ok, false);
    assert.equal(makeProviderHealth(options).get("codex", "queued").ok, false);
  }
  assert.equal(calls.length, before, "read-only access never starts provider work");
  assert.equal(readFileSync(join(home, "provider-health.json"), "utf8"), original, "the last observation is preserved");
  delayed = true;
  const refreshing = health.refresh([["codex", "expired"], ["codex", "queued"]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.has("expired"), true); assert.equal(replies.has("queued"), false);
  assert.equal(health.get("codex", "expired").ok, false); assert.equal(health.get("codex", "queued").ok, false);
  assert.equal(health.get("codex", "fresh").ok, true); assert.equal(health.get("codex-cloud", "fresh").ok, true);
  await health.refresh([["codex", "expired"], ["codex", "queued"]]); assert.equal(calls.length, before + 1, "in-flight and queued refreshes are not duplicated");
  replies.get("expired")({ ok: false, detail: "fixture login expired", fix: "restore fixture account" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(replies.has("queued"), true); assert.equal(health.get("codex", "queued").ok, false);
  replies.get("queued")({ ok: true, detail: "fixture account ready" }); await refreshing;
  const failure = makeProviderHealth(options).get("codex", "expired");
  assert.equal(failure.ok, false); assert.equal(failure.failures, 1); assert.equal(failure.fix, "restore fixture account");
  assert.equal(failure.nextAttemptAt, clock.now() + 20_000);
  assert.equal(makeProviderHealth(options).get("codex", "queued").ok, true);
  delayed = false;
  await health.refresh([["codex", "expired"]]); assert.equal(calls.length, before + 2, "failure backoff fences retry");
  clock.advance(20_000 / 60_000); await health.refresh([["codex", "expired"]]);
  assert.equal(makeProviderHealth(options).get("codex", "expired").ok, true);
});

test("provider health persistence failures release scoped waiters and preserve incompatible state", async () => {
  for (const failure of ["write", "version"]) {
    const home = tempHome(), file = join(home, "provider-health.json"), clock = makeClock();
    let finish, delayed = false, calls = 0;
    const health = makeProviderHealth({ home, clock, limits: { concurrency: 1 }, probe: async () => {
      calls++; return delayed ? new Promise(resolve => { finish = resolve; }) : { ok: true };
    } });
    await health.refresh([["codex", "first"], ["codex", "queued"]]);
    clock.advance(10_000 / 60_000); delayed = true;
    const refreshing = health.refresh([["codex", "first"], ["codex", "queued"]]);
    const rejected = assert.rejects(refreshing, failure === "version" ? /unsupported provider health version.*restore/ : { code: "EISDIR" });
    const waiters = [health.whenRefreshed("codex", "first"), health.whenRefreshed("codex", "queued")];
    await new Promise(resolve => setImmediate(resolve));
    if (failure === "version") writeJsonAtomic(file, { version: 2, scopes: {}, evidence: "preserve this incompatible fixture" });
    else { rmSync(file); mkdirSync(file); }
    finish({ ok: true }); await new Promise(resolve => setImmediate(resolve));
    finish({ ok: true }); await rejected; await Promise.all(waiters);
    assert.equal(calls, 4, "a failed write does not leave another queued scope hanging");
    assert.equal(health.whenRefreshed("codex", "first"), null); assert.equal(health.whenRefreshed("codex", "queued"), null);
    if (failure === "version") {
      assert.deepEqual(readJson(file), { version: 2, scopes: {}, evidence: "preserve this incompatible fixture" });
      assert.throws(() => health.get("codex", "first"), /unsupported provider health version.*restore/);
    } else assert.equal(health.get("codex", "first").ok, false);
  }
});

for (const reply of ["failure", "success", "cancel", "ownership-change", "timeout"]) test(`a due provider refresh fences dispatch while unrelated execution and GitHub review advance: ${reply}`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = remote(), home = tempHome(), state = makeState(home), local = fakeRunner(f.clock), gh = fakeGh();
  let delay = false, finish, progress = 0, signal;
  const health = makeProviderHealth({ home, clock: f.clock, limits: { progressMs: 10_000, deadlineMs: 1000 }, jitter: () => 0,
    probe: async (_provider, _account, abort) => { signal = abort; return delay ? new Promise(resolve => { finish = resolve; }) : { ok: true, detail: "fixture account ready" }; } });
  await health.refresh([["openai-agents", "test"]]);
  f.clock.advance(5000 / 60_000); await health.refresh([["codex", "operator"]]);
  for (const [name, harness, pr] of [["remote", "openai-agents", 1], ["local", "codex", 2], ["review", "codex", 3]]) {
    state.put(`acme/widget/${name}`, { ...newEntry({ repo: "acme/widget", harness, pr, branch: `work/${pr}`, base: "main", worktree: tempHome(), state: STATES.ready, nowIso: T0 }), cursor: { since: T0, fixed_sha: "a1b2c3d" }, ...(name === "remote" ? { execution: { version: 1, allowance } } : {}) });
  }
  gh.prView = async (_repo, pr) => prFixture({ number: pr, headRefName: `work/${pr}`, ...(pr === 3 ? { state: "MERGED" } : {}) });
  gh.data.comments = [comment({ id: 99, by: "me", at: new Date(f.clock.now()).toISOString(), body: "@gallivant fix the header" })];
  local.reconcile = async () => { progress++; };
  const config = { ...CONFIG, harness: { ...CONFIG.harness, "openai-agents": { account: "test" } } };
  const ctx = { home, config, clock: f.clock, state, gh, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null,
    credential: fakeCredential(), identity: fakeIdentity(), providerHealth: health, executionFor: id => id.endsWith("/remote") ? f.service : local };
  f.clock.advance(5000 / 60_000); delay = true;
  const tick = makeTick(ctx);
  // Even the former daemon ordering must reject due cached health immediately.
  const ticking = tick.tick(), refreshing = health.refresh([["openai-agents", "test"]]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, "function"); assert.equal(health.get("openai-agents", "test").ok, false);
  assert.equal(f.calls.length, 0, "expired cache cannot prepare or dispatch a paid remote turn");
  assert.equal(Object.keys(f.service.state().operations).length, 0);
  assert.equal(local.started.length, 1, "fresh provider dispatch continues before the slow probe replies");
  assert.equal(state.get("acme/widget/review").state, STATES.done); assert.ok(progress >= 2);
  const beforeReply = { remoteCalls: f.calls.length, localRuns: local.started.length, progress, reviewed: state.get("acme/widget/review").state,
    fencedHealth: health.get("openai-agents", "test"), freshHealth: health.get("codex", "operator") };
  if (reply === "cancel") state.update("acme/widget/remote", { dispatch_stopped: "cancellation-requested" });
  if (reply === "ownership-change") state.update("acme/widget/remote", { last: { run: "another-owned-run" } });
  if (reply === "timeout") t.mock.timers.tick(1000);
  else finish(reply === "failure" ? { ok: false, detail: "fixture login expired", fix: "restore fixture account" } : { ok: true, detail: "fixture account ready" });
  await refreshing; const results = await ticking;
  assert.ok(results.every(result => result.ok));
  if (reply === "success") {
    assert.equal(f.calls.filter(c => c[0] === "submit").length, 1, "fresh health releases one dispatch in the same tick");
    assert.equal(state.get("acme/widget/remote").last.run, f.service.current().id);
  } else {
    assert.equal(f.calls.length, 0); assert.equal(Object.keys(f.service.state().operations).length, 0);
    assert.equal(state.get("acme/widget/remote").last?.run, reply === "ownership-change" ? "another-owned-run" : undefined);
    assert.equal(state.get("acme/widget/remote").cursor.since, T0);
  }
  assert.equal(health.get("openai-agents", "test").ok, !["failure", "timeout"].includes(reply));
  assert.equal(health.whenRefreshed("openai-agents", "test"), null, "scope waiters are cleaned up");
  if (reply === "timeout") {
    assert.equal(signal.aborted, true);
    finish({ ok: true, detail: "late fixture reply" }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(health.get("openai-agents", "test").detail, "EXECUTION_DEADLINE");
  }
  // Read-only access and another progress tick do not repeat dispatch or review.
  const calls = f.calls.filter(c => c[0] === "submit").length;
  health.get("openai-agents", "test"); await tick.tick();
  assert.equal(f.calls.filter(c => c[0] === "submit").length, calls); assert.equal(local.started.length, 1);
  const evidence = join(home, "dispatch-health-evidence.json");
  writeJsonAtomic(evidence, { kind: "Offline provider health fixture; no live qualification", reply, beforeReply, afterReply: health.get("openai-agents", "test"),
    paidDispatches: calls, operations: Object.keys(f.service.state().operations), waiterCleared: health.whenRefreshed("openai-agents", "test") === null,
    files: { health: join(home, "provider-health.json"), state: join(home, "state.json") } });
  t.diagnostic(`dispatch health evidence: ${evidence}`);
});

test("pending provider health leaves every GitHub review worker available to unrelated entries", async () => {
  const home = tempHome(), clock = makeClock(), state = makeState(home), gh = fakeGh();
  let delayed = false, finish, progress = 0, reads = 0;
  const health = makeProviderHealth({ home, clock, probe: async () => delayed ? new Promise(resolve => { finish = resolve; }) : { ok: true } });
  await health.refresh([["codex", "operator"]]); clock.advance(10_000 / 60_000); delayed = true;
  for (let pr = 1; pr <= 9; pr++) state.put(`acme/widget/task-${pr}`, { ...newEntry({ repo: "acme/widget", harness: "codex", pr, branch: `work/${pr}`, worktree: tempHome(), state: STATES.ready, nowIso: T0 }), cursor: { since: T0, fixed_sha: "a1b2c3d" } });
  gh.prView = async (_repo, pr) => { reads++; return prFixture({ number: pr, headRefName: `work/${pr}`, ...(pr === 9 ? { state: "MERGED" } : {}) }); };
  gh.data.comments = [comment({ id: 99, by: "me", at: new Date(clock.now()).toISOString(), body: "@gallivant fix the header" })];
  const execution = { current: () => null, reconcile: async () => { progress++; }, start: () => { throw new Error("unhealthy provider must never dispatch"); } };
  const ctx = { home, clock, state, gh, config: CONFIG, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null,
    credential: fakeCredential(), identity: fakeIdentity(), providerHealth: health, executionFor: () => execution };
  const refreshing = health.refresh([["codex", "operator"]]), ticking = makeTick(ctx).tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.get("acme/widget/task-9").state, STATES.done, "eight pending dispatches cannot consume four review workers");
  assert.equal(reads, 9); assert.equal(progress, 9);
  finish({ ok: false, detail: "fixture login expired" }); await refreshing;
  assert.ok((await ticking).every(result => result.ok));
  for (let pr = 1; pr < 9; pr++) assert.equal(state.get(`acme/widget/task-${pr}`).cursor.since, T0);
});

test("shared start and resume recheck provider health after asynchronous preparation before paid dispatch", async () => {
  for (const provider of ["codex", "openai-agents"]) for (const mode of ["start", "resume"]) for (const phase of provider === "codex" ? ["checkout", "credential", "identity", "head"] : ["checkout", "credential", "identity", "head", "prepare"]) {
    const f = remote(), home = tempHome(), state = makeState(home), local = fakeRunner(f.clock), account = "test", id = "acme/widget/remote";
    const health = makeProviderHealth({ home, clock: f.clock, jitter: () => 0, probe: async () => ({ ok: true, detail: "fixture account ready" }) });
    await health.refresh([[provider, account]]);
    let session = mode === "resume" ? "22222222-2222-4222-8222-222222222222" : null;
    if (provider !== "codex" && mode === "resume") {
      await f.service.submit(input); f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect();
      session = f.service.current().execution.sessionId; f.calls.length = 0;
    }
    const entry = newEntry({ repo: "acme/widget", harness: provider, session, base: "main", branch: "work/health", worktree: tempHome(), state: STATES.running, nowIso: T0 });
    entry.execution = { version: 1, allowance }; state.put(id, entry);
    let expire = true, prepared = 0;
    const lapse = point => { if (expire && point === phase) { f.clock.advance(10_000 / 60_000); expire = false; } };
    const credential = async () => { lapse("credential"); return fakeCredential()(); };
    const git = { ...fakeGit(), ensureHttpsRemote: async () => { lapse("checkout"); }, head: async () => { lapse("head"); return input.inputHead; } };
    const identity = async () => { lapse("identity"); return fakeIdentity()(); };
    f.transport.prepare = async () => { prepared++; lapse("prepare"); return { environment: "sandbox" }; };
    const ctx = { home, state, clock: f.clock, config: { ...CONFIG, harness: { ...CONFIG.harness, [provider]: { ...CONFIG.harness[provider], account } } },
      gh: fakeGh(), ownLogin: "me", git, log: silentLog, notify: fakeNotify(), readPrd: () => null, credential, identity, providerHealth: health,
      executionFor: () => provider === "codex" ? local : f.service };
    const tick = makeTick(ctx), attempts = Object.keys(f.service.state().operations).length;
    await assert.rejects(tick.startRun(id, entry, { name: mode, prompt: "fixture" }), { code: "PROVIDER_UNAVAILABLE" });
    assert.equal(local.started.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(Object.keys(f.service.state().operations).length, attempts, `${provider}/${mode}/${phase} creates no intent or reservation`);
    assert.equal(prepared, phase === "prepare" ? 1 : 0);
    await health.refresh([[provider, account]]);
    await tick.startRun(id, entry, { name: mode, prompt: "fixture" });
    assert.equal(provider === "codex" ? local.started.length : f.calls.filter(c => ["submit", "continue"].includes(c[0])).length, 1);
    if (provider !== "codex") assert.equal(f.calls[0][0], mode === "resume" ? "continue" : "submit");
  }
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

test("overlapping resolved secrets redact complete values in either order without changing input", () => {
  for (const [short, long] of [["prefix", "prefix-suffix"], ["suffix", "prefix-suffix"], ["middle", "start-middle-end"], ["a.b$[]", "a.b$[]-tail"], ["clé", "clé🔑-tail"]]) {
    for (const values of [[short, long], [long, short]]) {
      const secrets = Object.freeze([...values, short, "", null, 7]);
      const value = { messages: [`value <${long}>`, { detail: `${short} / ${long}`, token: "credential-shaped" }], count: 2, missing: null };
      const original = structuredClone(value);
      assert.deepEqual(redact(value, secrets), { messages: ["value <[redacted]>", { detail: "[redacted] / [redacted]", token: "[redacted]" }], count: 2, missing: null });
      assert.deepEqual(value, original); assert.deepEqual(secrets, [...values, short, "", null, 7]);
    }
  }
  const recognized = `ghp_${"a".repeat(16)}`;
  assert.equal(redact(`Bearer opaque-access ${recognized} token=opaque-key`), "Bearer [redacted] [redacted] token=[redacted]");
});

test("overlapping secrets stay redacted in journal replay and local tracker history after restart", async t => {
  const short = "opaque-overlap", long = `${short}-hidden-suffix`, output = `message <${long}> / ${short}`, expected = "message <[redacted]> / [redacted]", observations = [];
  for (const secrets of [[short, long], [long, short]]) {
    const dir = tempHome(), options = { taskId: "task", runId: "run", provider: "fixture", secrets };
    const event = { eventId: "overlap-event", sequence: 1, type: "output", data: output };
    journalFor(dir, options).append(event); journalFor(dir, options).append(event);
    assert.equal(outputEvents(dir).length, 1); assert.equal(outputEvents(dir)[0].data, expected);
    assert.deepEqual(logWindow(dir).lines, [expected]);
    const local = localOutputFixture({ text: `${output}\n` });
    writeJsonAtomic(join(local.dir, "sensitive-redactions.json"), { expiresAt: local.clock.now() + 86_400_000, secrets });
    local.openRunner().observe(); local.openRunner().observe();
    assert.equal(outputEvents(local.dir).length, 1); assert.equal(outputEvents(local.dir)[0].data, expected);
    assert.deepEqual(sliceRun(local.dir, { end: 2 }).lines, [expected]);
    assert.deepEqual(logWindow(local.dir, { after: 1 }).lines, []);
    const res = new Subscriber(); streamRun(res, local.dir, { isRunning: () => false });
    assert.ok(res.frames.some(frame => frame.includes(expected))); assert.equal(res.ended, true);
    assert.equal(res.listenerCount("drain"), 0);
    assert.doesNotMatch(res.frames.join(""), /opaque-overlap|hidden-suffix/);
    assert.equal(readFileSync(join(local.dir, "provider.log"), "utf8"), `${output}\n`, "private diagnostics keep original bytes");
    observations.push({ journal: dir, local: local.dir, expected, journalRecords: outputEvents(dir).length, localRecords: outputEvents(local.dir).length, replayIds: logWindow(local.dir).ids, sseClosed: res.ended });
  }
  const path = join(tempHome(), "overlap-journal-evidence.json"); writeJsonAtomic(path, { observations });
  t.diagnostic(`overlap journal evidence: ${path}`);
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

test("lost local launch acknowledgement recovers an existing stop before shutdown and cannot redispatch", async t => {
  const observations = [];
  for (const reason of ["operator-cancelled", "timeout"]) {
    const root = tempHome(), clock = makeClock(), marker = join(root, "ready");
    const runner = makeRunner(root, { clock }), start = runner.start;
    let starts = 0;
    runner.start = async (...args) => { starts++; await start(...args); throw new Error("local launch reply lost"); };
    const open = () => makeExecution({ root, taskId: "lost-local-stop", provider: "codex", runner: makeRunner(root, { clock }), clock });
    const service = makeExecution({ root, taskId: "lost-local-stop", provider: "codex", runner, clock });
    const request = { ...input, kind: "implementation", spec: { cmd: process.execPath, args: ["-e", `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); setInterval(()=>{},1000);`], options: { cwd: root } } };
    let job;
    t.after(async () => { if (job) { const cleanup = makeRunner(root, { clock: { now: () => clock.now() + 6000 } }); cleanup.kill(job.id); await cleanup.waitForKill(job.id); } });
    await assert.rejects(service.submit(request), /local launch reply lost/); job = runner.current();
    for (let i = 0; i < 250 && !existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(marker)); assert.equal(service.current().execution.acceptance, "unknown");
    assert.equal((await open().cancel(reason)).confirmed, false); assert.equal(runner.current().killed, undefined);
    mkdirSync(join(root, "other-run")); writeJsonAtomic(join(root, "other-run", "job.json"), { ...job, id: "other-run" });
    writeFileSync(join(root, "latest-run"), "other-run"); await open().reconcile();
    assert.equal(open().state().current.execution.acceptance, "unknown"); assert.equal(runner.read(job.id).killed, undefined);
    writeFileSync(join(root, "latest-run"), job.id);
    const unsupported = makeExecution({ root, taskId: "lost-local-stop", provider: "codex", runner: makeRunner(root, { clock }), clock,
      capabilities: { ...executionRegistry.codex, controls: { cancel: false } } });
    await unsupported.reconcile(); assert.equal(unsupported.current().execution.acceptance, "accepted"); assert.equal(runner.current().killed, undefined);
    const unavailable = makeExecution({ root, taskId: "lost-local-stop", provider: "codex", runner: makeRunner(root, { clock, processes: () => null }), clock });
    await unavailable.reconcile(); assert.equal(unavailable.current().execution.recoveryAction, "RUN_STOP_UNVERIFIED"); assert.equal(runner.current().killed, undefined);
    await open().reconcile();
    assert.equal(open().current().execution.acceptance, "accepted"); assert.equal(runner.current().killed, true);
    const persisted = open().state(), stop = runner.current();
    assert.equal(persisted.stopped, reason); assert.equal(persisted.current.execution.providerState, "cancellation-requested");
    assert.equal(persisted.operations.first.acceptance, "accepted"); assert.equal(persisted.current.id, job.id);
    assert.equal(starts, 1); assert.equal(Object.keys(persisted.operations).length, 1);
    clock.advance(1); await open().reconcile();
    for (let i = 0; i < 250 && runner.current().running; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(runner.current().running, false); await open().reconcile();
    assert.equal(open().current().execution.providerState, "cancelled"); assert.equal(open().current().exit, 137);
    assert.equal(runner.current().killAfter, stop.killAfter); assert.equal(open().state().stopped, reason === "timeout" ? null : reason);
    await assert.rejects(open().collect(), { code: "EXECUTION_QUARANTINED" });
    observations.push({ reason, launches: starts, runId: job.id, execution: join(root, "execution.json"), job: join(root, job.id, "job.json"), killAfter: stop.killAfter });
  }
  const path = join(tempHome(), "recovered-local-stop-evidence.json"); writeJsonAtomic(path, { observations }); t.diagnostic(`recovered local stop evidence: ${path}`);
});

test("coordinator reconciliation resumes an owned local kill fallback after restart without another control", async t => {
  const f = legacyCancellationFixture(); await f.open().cancel(); const stopped = readJson(join(f.root, f.id, "job.json"));
  const restarted = f.open(); await restarted.reconcile();
  assert.equal(f.signals.length, 2, "the persisted deadline has not elapsed");
  f.clock.advance(1); assert.equal(restarted.current().running, true); assert.equal(f.signals.length, 2, "read-only access never signals");
  await restarted.reconcile(); assert.deepEqual(f.signals.slice(-2), [[-123456790, "SIGKILL"], [-123456789, "SIGKILL"]]);
  assert.equal(readJson(join(f.root, f.id, "job.json")).killAfter, stopped.killAfter);
  assert.equal(restarted.current().execution.providerState, "cancellation-requested");
  f.setMembers([{ pid: 123456790, group: 123456790, started: "reused-tool" }]);
  const signals = f.signals.length; await restarted.reconcile();
  assert.equal(f.signals.length, signals); assert.equal(restarted.current().execution.recoveryAction, "RUN_STOP_UNVERIFIED");
  f.setMembers(null); await restarted.reconcile(); assert.equal(f.signals.length, signals);
  await assert.rejects(restarted.submit({ ...input, spec: {} }), { code: "EXECUTION_STOPPED" });
  f.setMembers([]); await restarted.reconcile();
  assert.equal(restarted.current().execution.providerState, "cancelled"); assert.equal(restarted.state().current.exit, 137);
  const evidence = join(tempHome(), "local-fallback-evidence.json");
  writeJsonAtomic(evidence, { execution: join(f.root, "execution.json"), job: join(f.root, f.id, "job.json"), persistedKillAfter: stopped.killAfter, signals: f.signals });
  t.diagnostic(`local fallback evidence: ${evidence}`);
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

function localTimeoutFixture({ immediate = false, provider = "codex" } = {}) {
  const home = tempHome(), root = join(home, "runs"), clock = makeClock(), id = "acme/widget/local-timeout";
  const session = "22222222-2222-4222-8222-222222222222", runner = fakeRunner(clock), stops = [];
  let descendants = true, inspectable = true;
  const current = runner.current, start = runner.start, kill = runner.kill;
  const persist = () => {
    const job = current();
    if (!job) return;
    const { running: _running, lines: _lines, ...record } = job;
    mkdirSync(join(root, job.id), { recursive: true });
    writeJsonAtomic(join(root, job.id, "job.json"), record);
    writeFileSync(join(root, "latest-run"), job.id);
  };
  runner.current = () => {
    const job = current();
    return job?.killed ? { ...job, running: !inspectable || descendants } : job;
  };
  runner.start = (name, cmd, args, options) => {
    assert.equal(runner.current()?.running || false, false, "no local writer overlap");
    start(name, cmd, args, options);
    runner.started.at(-1).id = options.runId || current().id;
    persist(); return current();
  };
  runner.kill = runId => {
    if (!inspectable) throw Object.assign(new Error("process inspection unavailable"), { code: "RUN_STOP_UNVERIFIED" });
    stops.push(runId); kill(runId);
    if (immediate) descendants = false;
    persist();
  };
  runner.annotate = (runId, patch) => { const job = runner.started.find(r => r.id === runId); if (job) Object.assign(job, patch); persist(); };
  const open = (options = {}) => makeExecution({ root, taskId: id, provider, runner, clock, legacySessionId: session, ...options });
  return { home, root, clock, id, session, runner, stops, open, setDescendants: value => { descendants = value; }, setInspectable: value => { inspectable = value; } };
}

const localSessionLines = (provider, session) => provider === "claude"
  ? claudeResultLines().map(line => { const event = JSON.parse(line); if (event.type === "system") event.session_id = session; return JSON.stringify(event); })
  : provider === "gemini" ? geminiLines({ session }) : provider === "opencode" ? opencodeLines({ session })
    : provider === "goose" ? gooseLines() : codexLines({ thread: session });

test("local settlement, collection and cached replay reject foreign sessions before adopting results", async t => {
  const evidence = [];
  for (const provider of ["claude", "gemini", "codex", "opencode"]) for (const path of ["settle", "collect", "cancel", "cache"]) {
    const f = localTimeoutFixture({ provider }), owned = provider === "opencode" ? "ses_ownedsession" : f.session;
    const service = f.open(), job = await service.submit({ operationId: "owned", recordedSessionId: owned, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    f.runner.finish(localSessionLines(provider, path === "cache" ? owned : "foreign-session"), { exit: 0 });
    await service.reconcile();
    const resultFile = join(f.root, job.id, "result.json");
    if (path === "cache") writeJsonAtomic(resultFile, { taskId: f.id, runId: job.id, sessionId: "foreign-session", outcome: { finished: true, ok: true, cost: null, lastMessage: "foreign cached result" } });
    const cached = path === "cache" ? readFileSync(resultFile, "utf8") : null;
    assert.throws(() => service.sessionFrom(job.id), { code: "EXECUTION_RESULT" });
    if (path === "settle") assert.throws(() => service.settle(job.id), { code: "EXECUTION_RESULT" });
    else await assert.rejects(service[path === "cache" ? "collect" : path](), { code: "EXECUTION_RESULT" });
    assert.equal(service.state().current.execution.sessionId, owned);
    assert.equal(service.state().current.execution.collected, false);
    assert.equal(path === "cache" ? readFileSync(resultFile, "utf8") : existsSync(resultFile), path === "cache" ? cached : false);
    assert.deepEqual(f.stops, []);
    await assert.rejects(service.continue({ operationId: "foreign-next", sessionId: "foreign-session", spec: {} }), { code: path === "cancel" ? "EXECUTION_STOPPED" : "BUSY" });
    assert.equal(f.runner.started.length, 1);
    const restarted = f.open();
    f.runner.started[0].lines = localSessionLines(provider, owned);
    if (path === "cache") writeJsonAtomic(resultFile, { ...readJson(resultFile), sessionId: owned });
    if (path === "cancel") await restarted.reconcile();
    else if (path === "settle") restarted.settle(job.id);
    else await restarted.collect();
    assert.equal(restarted.sessionFrom(job.id), owned);
    assert.equal(restarted.state().current.execution.collected, true);
    assert.equal(readJson(resultFile).sessionId, owned);
    evidence.push({ provider, path, runId: job.id, owned, stopped: restarted.state().stopped, resultSession: readJson(resultFile).sessionId, starts: f.runner.started.length, files: { execution: join(f.root, "execution.json"), result: resultFile } });
  }
  const report = join(tempHome(), "local-owned-session-evidence.json"); writeJsonAtomic(report, { kind: "Deterministic local adapter stream and cache ownership fixtures", cases: evidence });
  t.diagnostic(`local owned session evidence: ${report}`);
});

test("local session ownership rejects malformed IDs and retains omitted IDs or first discovered sessions", async () => {
  for (const provider of Object.keys(adapters)) for (const reported of [null, "", 42]) {
    const f = localTimeoutFixture({ provider }), owned = provider === "goose" ? "work-owned-session" : provider === "opencode" ? "ses_ownedsession" : f.session;
    const service = f.open(), job = await service.submit({ operationId: "owned", recordedSessionId: owned, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    f.runner.finish(localSessionLines(provider, reported), { exit: 0 }); await service.reconcile();
    if (adapters[provider].sessionFrom(localSessionLines(provider, reported)) != null) {
      assert.throws(() => service.settle(job.id), { code: "EXECUTION_RESULT" });
      assert.equal(existsSync(join(f.root, job.id, "result.json")), false);
    } else {
      service.settle(job.id); assert.equal(service.sessionFrom(job.id), owned);
      assert.equal(readJson(join(f.root, job.id, "result.json")).sessionId, owned);
    }
    assert.equal(service.state().current.execution.sessionId, owned);
  }
  for (const provider of ["codex", "opencode"]) {
    const f = localTimeoutFixture({ provider }), service = f.open(), session = provider === "opencode" ? "ses_discovered" : f.session;
    const job = await service.submit({ operationId: "first", spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    f.runner.finish(localSessionLines(provider, session), { exit: 0 }); await service.reconcile(); service.settle(job.id);
    assert.equal(service.sessionFrom(job.id), session);
    const next = await service.continue({ operationId: "next", sessionId: session, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    assert.equal(next.execution.sessionId, session); assert.equal(f.runner.started.length, 2);
  }
});

test("legacy local session readers cannot redirect continuation away from the recorded registry session", async () => {
  const f = localTimeoutFixture({ provider: "claude" });
  f.runner.start("legacy", "offline-cli-fixture", [], {}); f.runner.finish(localSessionLines("claude", "foreign-session"), { exit: 0 });
  assert.throws(() => f.open().sessionFrom(f.runner.current().id), { code: "EXECUTION_RESULT" });
  await assert.rejects(f.open().continue({ operationId: "foreign", sessionId: "foreign-session", spec: {} }), { code: "EXECUTION_RESULT" });
  assert.deepEqual(f.open().state().operations, {}); assert.equal(f.runner.started.length, 1);
  // Pre-fix settlement may already have replaced current/cache identity.
  // The persisted acknowledgement still owns the original session.
  const upgraded = localTimeoutFixture({ provider: "claude" }), service = upgraded.open();
  const job = await service.submit({ operationId: "owned", recordedSessionId: upgraded.session, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
  upgraded.runner.finish(localSessionLines("claude", upgraded.session), { exit: 0 }); await service.reconcile(); service.settle(job.id);
  const stateFile = join(upgraded.root, "execution.json"), cachedFile = join(upgraded.root, job.id, "result.json"), state = readJson(stateFile);
  state.current.execution.sessionId = "foreign-session"; writeJsonAtomic(stateFile, state);
  writeJsonAtomic(cachedFile, { ...readJson(cachedFile), sessionId: "foreign-session" });
  assert.throws(() => upgraded.open().sessionFrom(job.id), { code: "EXECUTION_RESULT" });
  await assert.rejects(upgraded.open().collect(), { code: "EXECUTION_RESULT" });
  await assert.rejects(upgraded.open().continue({ operationId: "foreign", sessionId: "foreign-session", spec: {} }), { code: "EXECUTION_RESULT" });
  assert.equal(upgraded.runner.started.length, 1);
});

test("cancelling settled local outcomes preserves success, failure, cost and session across restart", async () => {
  for (const provider of ["codex", "claude"]) for (const ok of [true, false]) for (const cancelSupported of [true, false]) {
    const f = localTimeoutFixture({ provider }), options = { capabilities: { ...executionRegistry[provider], controls: { cancel: cancelSupported } } }, service = f.open(options);
    const job = await service.submit({ operationId: "settled", name: "settled", allowance, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    const lines = provider === "codex" ? codexLines({ ok }) : claudeResultLines({ ok, cost: 0.4 });
    f.runner.finish(lines, { exit: ok ? 0 : 23 }); f.runner.annotate(job.id, { endedAt: f.clock.now() });
    await service.reconcile(); service.settle(job.id);
    const before = service.state(), result = readFileSync(join(f.root, job.id, "result.json"), "utf8"), rawJob = readFileSync(join(f.root, job.id, "job.json"), "utf8");
    assert.equal(before.current.execution.providerState, ok ? "succeeded" : "failed");
    assert.equal(before.current.execution.collected, true); assert.equal(before.current.exit, ok ? 0 : 23);
    assert.deepEqual(await service.cancel(), { confirmed: true });
    assert.deepEqual(service.state(), { ...before, stopped: "operator-cancelled" });
    assert.equal(readFileSync(join(f.root, job.id, "job.json"), "utf8"), rawJob); assert.deepEqual(f.stops, []);
    const restarted = f.open(options); f.clock.advance(1000);
    for (let i = 0; i < 2; i++) { await restarted.reconcile(); assert.deepEqual(await restarted.cancel("timeout"), { confirmed: true }); }
    const after = restarted.state();
    assert.equal(after.stopped, "operator-cancelled"); assert.equal(after.current.execution.providerState, before.current.execution.providerState);
    assert.equal(after.current.execution.collected, true); assert.equal(after.current.execution.quarantined, undefined);
    assert.equal(after.current.exit, before.current.exit); assert.equal(after.current.endedAt, before.current.endedAt);
    assert.equal(after.current.execution.sessionId, before.current.execution.sessionId); assert.equal(after.current.execution.costUsd, before.current.execution.costUsd);
    assert.equal(restarted.outcome(job.id).ok, ok); assert.equal(restarted.outcome(job.id).cost, provider === "claude" ? 0.4 : null);
    assert.equal(readFileSync(join(f.root, job.id, "result.json"), "utf8"), result); assert.deepEqual(after.operations, before.operations);
    assert.deepEqual(after.allowance, before.allowance); assert.deepEqual(f.stops, []);
    await assert.rejects(restarted.collect(), { code: "EXECUTION_QUARANTINED" });
    await assert.rejects(restarted.submit({ operationId: "next-run", spec: {} }), { code: "EXECUTION_STOPPED" });
    await assert.rejects(restarted.continue({ operationId: "next-turn", sessionId: before.current.execution.sessionId, spec: {} }), { code: "EXECUTION_STOPPED" });
    assert.equal(f.runner.started.length, 1);
  }
});

test("cancellation collects owned completed local jobs before the first reconciliation or settlement", async () => {
  for (const provider of ["codex", "claude"]) for (const ok of [true, false]) for (const reconciled of [true, false]) for (const cancelSupported of [true, false]) {
    const f = localTimeoutFixture({ provider }), options = { capabilities: { ...executionRegistry[provider], controls: { cancel: cancelSupported } } }, service = f.open(options);
    const job = await service.submit({ operationId: "finished", name: "finished", allowance, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    const lines = provider === "codex" ? codexLines({ ok }) : claudeResultLines({ ok, cost: 0.4 });
    f.runner.finish(lines, { exit: ok ? 0 : 23 }); f.runner.annotate(job.id, { endedAt: f.clock.now() });
    if (reconciled) await service.reconcile();
    assert.equal(service.state().current.execution.collected, false); assert.equal(existsSync(join(f.root, job.id, "result.json")), false);
    assert.deepEqual(await service.cancel(), { confirmed: true });
    const after = service.state(), resultPath = join(f.root, job.id, "result.json"), result = readFileSync(resultPath, "utf8");
    assert.equal(after.current.exit, ok ? 0 : 23); assert.equal(after.current.endedAt, f.clock.now());
    assert.equal(after.current.execution.providerState, ok ? "succeeded" : "failed"); assert.equal(after.current.execution.collected, true);
    assert.equal(after.current.execution.quarantined, undefined); assert.equal(after.current.execution.sessionId, adapters[provider].sessionFrom(lines));
    assert.equal(after.current.execution.costUsd, provider === "claude" ? 0.4 : null); assert.equal(after.stopped, "operator-cancelled");
    assert.equal(Object.keys(after.operations).length, 1); assert.equal(after.operations.finished.costUsd, provider === "claude" ? 0.4 : null);
    assert.equal(service.outcome(job.id).ok, ok); assert.deepEqual(f.stops, []);
    const restarted = f.open(options); f.clock.advance(1000); await restarted.reconcile(); await restarted.cancel();
    assert.equal(restarted.state().current.exit, ok ? 0 : 23); assert.equal(readFileSync(resultPath, "utf8"), result);
    assert.equal(restarted.state().current.execution.providerState, after.current.execution.providerState); assert.deepEqual(f.stops, []);
    await assert.rejects(restarted.continue({ operationId: "next", sessionId: f.session, spec: {} }), { code: "EXECUTION_STOPPED" });
    assert.equal(f.runner.started.length, 1);
  }
});

test("completed local cancellation collection failures retain a recoverable snapshot and dispatch fence", async () => {
  for (const recovery of ["reconcile", "cancel"]) {
    const f = localTimeoutFixture({ provider: "claude" }), service = f.open();
    const job = await service.submit({ operationId: "finished", name: "finished", spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    f.runner.finish(claudeResultLines({ ok: false, cost: 0.4 }), { exit: 23 }); f.runner.annotate(job.id, { endedAt: f.clock.now() });
    const path = join(f.root, job.id, "result.json"); mkdirSync(path);
    await assert.rejects(service.cancel());
    const before = service.state(); assert.equal(before.stopped, "operator-cancelled"); assert.equal(before.current.exit, 23);
    assert.equal(before.current.execution.providerState, "retrieving-results"); assert.equal(before.current.execution.collected, false);
    assert.deepEqual(f.stops, []); await assert.rejects(service.submit({ operationId: "overlap", spec: {} }), { code: "EXECUTION_STOPPED" });
    rmSync(path, { recursive: true }); const reopened = f.open(); await reopened[recovery]();
    assert.equal(reopened.state().current.execution.providerState, "failed"); assert.equal(reopened.state().current.execution.collected, true);
    assert.equal(reopened.state().current.execution.quarantined, undefined); assert.equal(reopened.state().current.exit, 23);
    assert.equal(reopened.state().current.endedAt, before.current.endedAt); assert.equal(reopened.outcome(job.id).cost, 0.4);
    assert.equal(reopened.sessionFrom(job.id), adapters.claude.sessionFrom(claudeResultLines({ ok: false, cost: 0.4 }))); assert.deepEqual(f.stops, []); assert.equal(f.runner.started.length, 1);
  }
});

test("completed local evidence needs an exact job and exit while active stop output remains quarantined", async () => {
  for (const mode of ["missing", "foreign", "unknown-exit", "active-stop"]) {
    const f = localTimeoutFixture(), service = f.open();
    const job = await service.submit({ operationId: "owned", name: "owned", spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    if (mode === "active-stop") { await service.cancel(); f.setDescendants(false); f.runner.started[0].lines = codexLines(); await service.reconcile(); }
    else {
      f.runner.finish(codexLines(), { exit: mode === "unknown-exit" ? null : 0 });
      const current = f.runner.current;
      if (mode === "missing") f.runner.current = () => null;
      if (mode === "foreign") f.runner.current = () => ({ ...current(), id: "different-job" });
      await service.cancel();
    }
    assert.equal(existsSync(join(f.root, job.id, "result.json")), false);
    assert.notEqual(service.state().current.execution.providerState, "succeeded");
    assert.equal(service.state().stopped, "operator-cancelled");
    if (mode === "active-stop") { assert.equal(service.current().exit, 137); assert.equal(service.current().execution.quarantined, true); }
    await assert.rejects(service.continue({ operationId: "next", spec: {} }), { code: "EXECUTION_STOPPED" });
  }
});

test("completed legacy local jobs keep their files and identity when future dispatch is cancelled", async () => {
  for (const exit of [0, 23]) {
    const f = legacyCancellationFixture(); f.setMembers([]);
    const path = join(f.root, f.id, "job.json"), job = readJson(path);
    writeJsonAtomic(path, { ...job, exit, endedAt: f.clock.now() });
    writeFileSync(join(f.root, f.id, "job.log"), codexLines({ ok: exit === 0 }).join("\n")+"\n");
    const original = readFileSync(path, "utf8"), service = f.open({ cancel: false });
    assert.deepEqual(await service.cancel(), { confirmed: true });
    f.clock.advance(1000); await f.open().reconcile();
    assert.equal(service.state().current, null); assert.deepEqual(service.state().operations, {});
    assert.equal(service.state().stopped, "operator-cancelled"); assert.equal(service.current().id, f.id);
    assert.equal(service.current().exit, exit); assert.equal(service.sessionFrom(f.id), f.session);
    assert.equal(readFileSync(path, "utf8"), original); assert.deepEqual(f.signals, []);
    await assert.rejects(f.open().submit({ ...input, spec: {} }), { code: "EXECUTION_STOPPED" });
  }
});

test("operator cancellation leaves settled local registry evidence unchanged through coordinator ticks", async t => {
  const observations = [];
  for (const ok of [true, false]) {
    const f = localTimeoutFixture(), service = f.open(), state = makeState(f.home);
    const job = await service.submit({ operationId: "settled", name: "settled", spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    f.runner.finish(codexLines({ ok }), { exit: ok ? 0 : 23 }); f.runner.annotate(job.id, { endedAt: f.clock.now() });
    await service.reconcile(); service.settle(job.id);
    const outcome = service.outcome(job.id), last = { run: job.id, exit: ok ? 0 : 23, at: T0, event: "settled implementation", cost: outcome.cost, denials: outcome.denials };
    state.put(f.id, { ...newEntry({ repo: "acme/widget", harness: "codex", session: service.sessionFrom(job.id), branch: "work/settled", state: STATES.needsHuman, nowIso: T0 }), last });
    const ctx = { home: f.home, state, clock: f.clock, config: CONFIG, executionFor: () => f.open(), gh: fakeGh(), git: fakeGit(),
      notify: fakeNotify(), log: silentLog, ownLogin: "me", readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity() };
    requestControl(ctx, { handle: f.id, action: "cancel" }); await cancelControl(ctx, f.id);
    const tick = makeTick(ctx); await tick.tick(); f.clock.advance(1000); await tick.tick();
    const entry = state.get(f.id);
    assert.deepEqual(entry.last, last); assert.equal(entry.execution.providerState, ok ? "succeeded" : "failed");
    assert.equal(entry.dispatch_stopped, "cancellation-requested"); assert.equal(entry.reason, "cancelled");
    assert.equal(entry.control.status, "applied"); assert.deepEqual(f.stops, []); assert.equal(f.runner.started.length, 1);
    await assert.rejects(resume(ctx, { handle: f.id }), /dispatch stopped/);
    observations.push({ taskId: f.id, runId: job.id, exit: last.exit, providerState: entry.execution.providerState, last: entry.last,
      stopped: service.state().stopped, session: entry.session, files: { registry: state.file, execution: join(f.root, "execution.json"), job: join(f.root, job.id, "job.json"), result: join(f.root, job.id, "result.json") } });
  }
  const path = join(tempHome(), "settled-control-evidence.json"); writeJsonAtomic(path, { observations });
  t.diagnostic(`settled control evidence: ${path}`);
});

test("native completed local roots retain exact exits and results after cancel and log retention", async t => {
  const observations = [];
  for (const exit of [0, 23]) for (const collectedBeforeCancel of [true, false]) {
    const root = tempHome(), cwd = tempHome(), taskId = "acme/widget/native-settled", runner = makeRunner(root);
    const service = makeExecution({ root, taskId, provider: "codex", runner });
    const output = codexLines({ ok: exit === 0 }).join("\n")+"\n";
    const job = await service.start("native-settled", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)});process.exit(${exit})`], { cwd, execution: { operationId: "settled" } });
    while (runner.read(job.id).exit === null) await new Promise(resolve => setImmediate(resolve));
    if (collectedBeforeCancel) { await service.reconcile(); service.settle(job.id); }
    const original = runner.current(), before = service.state(), resultPath = join(root, job.id, "result.json"), rawJob = readFileSync(join(root, job.id, "job.json"), "utf8");
    assert.equal(before.current.execution.collected, collectedBeforeCancel);
    runner.kill = () => assert.fail("completed local run must not be signalled");
    assert.deepEqual(await service.cancel(), { confirmed: true });
    const resultBytes = readFileSync(resultPath, "utf8");
    const cancelledSnapshot = service.state();
    if (collectedBeforeCancel) assert.equal(readFileSync(join(root, job.id, "job.json"), "utf8"), rawJob);
    const reopenedRunner = makeRunner(root), reopened = makeExecution({ root, taskId, provider: "codex", runner: reopenedRunner });
    reopenedRunner.kill = () => assert.fail("restart must not signal a completed local run");
    await reopened.reconcile(); assert.deepEqual(await reopened.cancel(), { confirmed: true });
    rmSync(join(root, job.id, "provider.log")); rmSync(join(root, job.id, "job.log"));
    await reopened.reconcile(); const after = reopened.state();
    assert.equal(after.current.exit, exit); assert.equal(after.current.endedAt, original.endedAt);
    assert.equal(after.current.execution.providerState, exit === 0 ? "succeeded" : "failed");
    assert.equal(after.current.execution.sessionId, "22222222-2222-4222-8222-222222222222"); assert.equal(after.current.execution.quarantined, undefined);
    assert.deepEqual(after.operations, cancelledSnapshot.operations); assert.equal(after.operations.settled.idempotencyKey, before.operations.settled.idempotencyKey);
    assert.equal(readFileSync(resultPath, "utf8"), resultBytes);
    assert.equal(reopened.outcome(job.id).ok, exit === 0); assert.equal(reopened.outcome(job.id).cost, null);
    await assert.rejects(reopened.continue({ operationId: "next-turn", sessionId: after.current.execution.sessionId, spec: {} }), { code: "EXECUTION_STOPPED" });
    observations.push({ taskId, runId: job.id, exit, collectedBeforeCancel, endedAt: after.current.endedAt, providerState: after.current.execution.providerState,
      session: after.current.execution.sessionId, stopped: after.stopped, outcome: reopened.outcome(job.id),
      files: { execution: join(root, "execution.json"), job: join(root, job.id, "job.json"), result: resultPath } });
  }
  const path = join(tempHome(), "settled-native-evidence.json"); writeJsonAtomic(path, { observations });
  t.diagnostic(`settled native evidence: ${path}`);
});

test("local timeout recovery preserves stranded work and explicitly resumes one owned session after shutdown", async t => {
  const evidence = [];
  for (const mode of ["owned", "legacy", "immediate", "restart"]) {
    const f = localTimeoutFixture({ immediate: mode === "immediate" }), execution = f.open(), state = makeState(f.home), wt = join(f.home, "wt");
    mkdirSync(wt); writeFileSync(join(wt, "partial.txt"), "unfinished implementation\n");
    writeFileSync(join(wt, "carried.txt"), "owner instructions\n");
    const spec = { cmd: "offline-cli-fixture", args: [], options: { cwd: wt } };
    const run = mode === "legacy" ? f.runner.start("implementation", spec.cmd, spec.args, spec.options)
      : await execution.submit({ operationId: "implementation", name: "implementation", sessionId: f.session, spec });
    state.put(f.id, { ...newEntry({ repo: "acme/widget", harness: "codex", session: f.session, branch: "work/local-timeout", worktree: wt, state: STATES.running, nowIso: T0 }), last: { run: run.id, exit: null } });
    const git = fakeGit(); let merges = 0;
    git.dirty = async () => ({ modified: 1, untracked: 1 }); git.unpushed = async () => [{ sha: "unpublished-commit", subject: "Preserved implementation" }];
    git.mergeBase = async () => { merges++; assert.fail("stranded changes cannot be merged over"); };
    const ctx = { home: f.home, config: { ...CONFIG, run_timeout_minutes: 1, harness: { ...CONFIG.harness, codex: { bin: harnessBin(f.home, "codex") } } },
      state, clock: f.clock, gh: fakeGh(), notify: fakeNotify(), git, credential: fakeCredential(), identity: fakeIdentity(), log: silentLog, ownLogin: "me",
      readPrd: () => GOOD_PRD, executionFor: () => f.open() };
    f.clock.advance(2);
    // Reproduce the already-persisted timeout fence left by the earlier package.
    if (mode === "restart") {
      await execution.cancel("timeout");
      state.update(f.id, { state: STATES.needsHuman, reason: "timeout", last: { run: run.id, exit: 137 }, timeout: { limit: 1, source: "config", ran_minutes: 2, unpushed: 1, modified: 1, untracked: 1 } });
    } else await makeTick(ctx).tickEntry(f.id, state.get(f.id));
    const stopped = f.open(), entry = state.get(f.id);
    assert.equal(entry.state, STATES.needsHuman); assert.equal(entry.reason, "timeout");
    assert.deepEqual([entry.timeout.unpushed, entry.timeout.modified, entry.timeout.untracked], [1, 1, 1]);
    assert.equal(f.runner.started.length, 1);
    if (mode !== "immediate") {
      assert.equal(stopped.state().stopped, "timeout");
      await assert.rejects(resume(ctx, { handle: f.id }), /already has a run in flight/);
      await assert.rejects(stopped.continue({ operationId: "overlap", sessionId: f.session, spec }), { code: "EXECUTION_STOPPED" });
      f.setDescendants(false); await makeTick(ctx).tickEntry(f.id, state.get(f.id));
    }
    const ready = f.open();
    assert.equal(ready.state().stopped, null); assert.equal(ready.current().running, false);
    assert.equal(ready.current().execution.providerState, "cancelled"); assert.equal(ready.current().execution.quarantined, true);
    assert.equal(state.get(f.id).reason, "timeout"); assert.equal(state.get(f.id).last.exit, 137);
    const before = ready.state(), oldDir = ready.dirOf(run.id);
    // A late success and an older result cache cannot erase the timed-out outcome.
    f.runner.started[0].lines.push(...codexLines());
    writeJsonAtomic(join(oldDir, "result.json"), { outcome: { finished: true, ok: true, cost: null }, sessionId: f.session });
    const saved = readFileSync(join(oldDir, "result.json"), "utf8");
    await assert.rejects(ready.collect(), { code: "EXECUTION_QUARANTINED" });
    ready.settle(run.id, () => 0); await ready.reconcile();
    assert.equal(ready.current().execution.providerState, "cancelled"); assert.equal(ready.current().exit, 137);
    assert.equal(readFileSync(join(oldDir, "result.json"), "utf8"), saved);
    const resumed = await resume(ctx, { handle: f.id, note: "Preserve the partial changes and unpushed commit." });
    assert.equal(resumed.session, f.session); assert.notEqual(resumed.run, run.id); assert.equal(f.runner.started.length, 2);
    const next = f.runner.started[1];
    assert.equal(next.opts.cwd, wt); assert.ok(next.args.includes(f.session));
    assert.ok(next.args.includes('sandbox_mode="workspace-write"'));
    assert.match(next.args.at(-1), /1 modified and 1 untracked/); assert.match(next.args.at(-1), /1 commit on this branch is already made and NOT yet pushed/);
    assert.match(next.args.at(-1), /unpublished-commit Preserved implementation/);
    assert.equal(merges, 0); assert.equal(state.get(f.id).branch, "work/local-timeout");
    assert.equal(readFileSync(join(wt, "partial.txt"), "utf8"), "unfinished implementation\n");
    assert.equal(readFileSync(join(wt, "carried.txt"), "utf8"), "owner instructions\n");
    assert.equal(state.get(f.id).timeout, null); assert.equal(state.get(f.id).last.run, resumed.run);
    const after = f.open().state(); assert.equal(after.stopped, null); assert.equal(after.current.execution.sessionId, f.session);
    if (mode !== "legacy") assert.equal(Object.keys(before.operations).length, 1);
    else assert.deepEqual(before.operations, {});
    assert.equal(Object.keys(after.operations).length, mode === "legacy" ? 1 : 2);
    evidence.push({ mode, taskId: f.id, oldRun: run.id, resumedRun: resumed.run, session: resumed.session, timeout: entry.timeout,
      stopped: before.stopped, quarantine: before.current.execution.quarantined, oldCost: before.current.execution.costUsd, resumedState: state.get(f.id).state,
      starts: f.runner.started.length, stops: f.stops, files: { execution: join(f.root, "execution.json"), registry: state.file, oldJob: join(oldDir, "job.json"), oldResult: join(oldDir, "result.json"), partial: join(wt, "partial.txt"), carried: join(wt, "carried.txt") } });
  }
  const file = join(tempHome(), "local-timeout-evidence.json"); writeJsonAtomic(file, { kind: "Offline local lifecycle and same-session resume fixtures", cases: evidence });
  t.diagnostic(`local timeout evidence: ${file}`);
});

test("local timeout fences survive failed inspection, changed ownership and concurrent operator cancellation", async () => {
  for (const mode of ["unreadable", "missing", "different", "operator"]) {
    const f = legacyCancellationFixture(), service = f.open();
    if (mode === "unreadable") f.setMembers(null);
    if (mode === "unreadable") await assert.rejects(service.cancel("timeout"), { code: "RUN_STOP_UNVERIFIED" });
    else await service.cancel("timeout");
    if (mode === "operator") { await service.cancel(); await service.cancel("timeout"); }
    if (mode === "missing" || mode === "different") {
      if (mode === "different") { mkdirSync(join(f.root, "other")); writeJsonAtomic(join(f.root, "other", "job.json"), { id: "other", exit: 0 }); }
      writeFileSync(join(f.root, "latest-run"), mode === "different" ? "other" : "missing");
    }
    if (mode === "operator") f.setMembers([]);
    const before = service.state(), restarted = f.open();
    for (let i = 0; i < 3; i++) restarted.inspect();
    assert.deepEqual(restarted.state(), before, "read-only clients cannot clear a timeout fence");
    await restarted.reconcile();
    assert.equal(restarted.state().stopped, mode === "operator" ? "operator-cancelled" : "timeout");
    await assert.rejects(restarted.continue({ ...input, operationId: "after-timeout", sessionId: f.session, spec: {} }), { code: "EXECUTION_STOPPED" });
    if (mode === "operator") {
      assert.equal(restarted.current().execution.quarantined, true);
      await restarted.cancel("timeout"); assert.equal(restarted.state().stopped, "operator-cancelled");
    }
    else assert.equal(restarted.current().execution.providerState, "cancellation-requested");
  }
});

test("remote and preparation timeout fences remain permanent after authoritative shutdown", async () => {
  const remoteFixture = remote(); await remoteFixture.service.submit(input); await remoteFixture.service.cancel("timeout");
  await remoteFixture.reopen().reconcile({ force: true });
  assert.equal(remoteFixture.service.state().stopped, "timeout");
  await assert.rejects(remoteFixture.service.continue({ ...input, operationId: "resume", sessionId: "session-1" }), { code: "EXECUTION_STOPPED" });
  for (const reason of ["preparation-timeout", "unsafe-preparation", "timeout"]) {
    const f = legacyCancellationFixture(), service = f.open();
    await service.cancel(reason);
    const state = service.state(); state.current.execution.kind = "intake";
    writeJsonAtomic(join(f.root, "execution.json"), state);
    await service.cancel("timeout");
    f.setMembers([]); await f.open().reconcile();
    assert.equal(service.state().stopped, reason); assert.equal(service.current().execution.quarantined, true);
    await assert.rejects(service.collect(), { code: "EXECUTION_QUARANTINED" });
    await assert.rejects(service.submit({ ...input, operationId: "new-preparation", spec: {} }), { code: "EXECUTION_STOPPED" });
  }
});

test("released local timeout quarantine preserves cancelled settlement when raw exit evidence is missing", async () => {
  const f = legacyCancellationFixture(), service = f.open();
  await service.cancel("timeout"); f.setMembers([]); await service.reconcile();
  assert.equal(service.state().stopped, null); assert.equal(service.current().exit, 137);
  const file = join(f.root, f.id, "job.json"), before = service.state().current;
  writeJsonAtomic(file, { ...readJson(file), exit: null });
  writeFileSync(join(f.root, f.id, "job.log"), codexLines().join("\n"));
  const raw = readFileSync(file, "utf8"); let inferred = 0;
  assert.equal(f.open().settle(f.id, () => { inferred++; return 0; }).exit, 137);
  assert.equal(inferred, 0); assert.equal(readFileSync(file, "utf8"), raw);
  await f.open().reconcile();
  const after = f.open();
  assert.equal(after.current().exit, 137); assert.equal(after.current().endedAt, before.endedAt);
  assert.equal(after.current().execution.providerState, "cancelled"); assert.equal(after.current().execution.quarantined, true);
  assert.equal(after.state().stopped, null); assert.equal(after.state().current.exit, 137);
  assert.equal(readJson(join(f.root, f.id, "result.json")), null);
  await assert.rejects(after.collect(), { code: "EXECUTION_QUARANTINED" });
});

test("native local timeout waits for detached tools before releasing the same-session continuation fence", async t => {
  const root = tempHome(), cwd = tempHome(), marker = join(cwd, "tool-ready"), session = "22222222-2222-4222-8222-222222222222";
  const child = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'ignore', detached: true}); process.stdout.write(${JSON.stringify(codexLines({ thread: session }).slice(0, 1).join("\n") + "\n")}); setInterval(() => {}, 1000);`;
  const runner = makeRunner(root), taskId = "acme/widget/native-timeout";
  const open = () => makeExecution({ root, taskId, provider: "codex", runner: makeRunner(root) });
  const execution = makeExecution({ root, taskId, provider: "codex", runner });
  const old = await execution.submit({ operationId: "implementation", name: "implementation", sessionId: session, spec: { cmd: process.execPath, args: ["-e", parent], options: { cwd } } });
  t.after(() => {
    for (const pid of [old.pid, existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0].filter(Boolean)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* owned fixture already gone */ }
    }
  });
  const until = async check => {
    const end = Date.now() + 10_000;
    while (!check()) { assert.ok(Date.now() < end, "owned native fixture did not reach the expected state"); await new Promise(resolve => setTimeout(resolve, 40)); }
  };
  await until(() => existsSync(marker));
  assert.deepEqual(await execution.cancel("timeout"), { confirmed: false });
  await new Promise(resolve => setTimeout(resolve, 100));
  const restarted = open(); await restarted.reconcile();
  assert.equal(restarted.state().stopped, "timeout"); assert.equal(restarted.current().running, true);
  assert.equal(restarted.current().execution.providerState, "cancellation-requested");
  const spec = { cmd: process.execPath, args: ["-e", `process.stdout.write(${JSON.stringify(codexLines({ thread: session }).join("\n") + "\n")})`], options: { cwd } };
  await assert.rejects(restarted.continue({ operationId: "overlap", sessionId: session, spec }), { code: "EXECUTION_STOPPED" });
  await runner.waitForKill(old.id); await until(() => !runner.current().running);
  await restarted.reconcile();
  const stopped = restarted.state();
  assert.equal(stopped.stopped, null); assert.equal(stopped.current.execution.quarantined, true);
  assert.equal(stopped.current.exit, 137); assert.equal(stopped.current.execution.costUsd, null);
  await assert.rejects(restarted.collect(), { code: "EXECUTION_QUARANTINED" });
  const next = await restarted.continue({ operationId: "resume", name: "resume", sessionId: session, spec });
  assert.notEqual(next.id, old.id); assert.equal(next.execution.sessionId, session);
  await until(() => restarted.read(next.id).exit !== null); await restarted.reconcile(); restarted.settle(next.id, () => 0);
  assert.equal(restarted.outcome(next.id).ok, true); assert.equal(restarted.sessionFrom(next.id), session);
  const file = join(cwd, "local-timeout-native-evidence.json");
  writeJsonAtomic(file, { kind: "Native offline Node CLI/process-tree fixture with Codex-shaped events", taskId, oldRun: old.id, resumedRun: next.id,
    session, stopped: stopped.stopped, quarantine: stopped.current.execution.quarantined, oldExit: stopped.current.exit, oldCost: stopped.current.execution.costUsd,
    resumedOutcome: restarted.outcome(next.id), files: { execution: join(root, "execution.json"), oldJob: join(root, old.id, "job.json"), nextJob: join(root, next.id, "job.json"), result: join(root, next.id, "result.json") } });
  t.diagnostic(`local timeout native evidence: ${file}`);
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

function localOutputFixture({ root = tempHome(), clock = makeClock(), id = "old-run", text = "", secret = "queued-private-value" } = {}) {
  const dir = join(root, id), taskId = "acme/widget/output";
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, "job.json"), { id, pid: null, exit: 0, startedAt: clock.now(), endedAt: clock.now(), privateOutput: { taskId, runId: id, provider: "codex" } });
  writeJsonAtomic(join(dir, "sensitive-redactions.json"), { expiresAt: clock.now() + 86_400_000, secrets: [secret] });
  writeFileSync(join(dir, "job.log"), "");
  writeFileSync(join(dir, "provider.log"), text);
  writeFileSync(join(root, "latest-run"), id);
  const openRunner = () => makeRunner(root, { clock, probe: () => false });
  const open = () => makeExecution({ root, taskId, provider: "codex", clock, runner: openRunner() });
  return { root, dir, taskId, id, clock, secret, openRunner, open };
}
const outputEvents = dir => readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

test("drained and empty local runs remain queued for private retention cleanup across successors and restart", async t => {
  const evidence = [];
  for (const mode of ["drained", "empty", "result-delayed"]) {
    const f = localOutputFixture({ text: mode === "empty" ? "" : "completed queued-private-value\n" }), runner = f.openRunner();
    runner.observe();
    const cursor = readJson(join(f.dir, "local-output.json"));
    assert.equal(cursor.pending, false);
    const resultFile = join(f.dir, "result.json"), result = { sessionId: "retained-session", outcome: { finished: true, ok: true, lastMessage: "retained outcome", cost: null } };
    if (mode !== "result-delayed") writeJsonAtomic(resultFile, result);
    const jobBytes = readFileSync(join(f.dir, "job.json"), "utf8"), logBytes = readFileSync(join(f.dir, "job.log"), "utf8");
    const next = await runner.start("successor", process.execPath, ["-e", 'process.stdout.write("successor progress\\n")'], { cwd: tempHome(), runId: "next-run", privateOutput: { taskId: f.taskId, runId: "next-run", provider: "codex" } });
    while (runner.read(next.id).exit === null) await new Promise(resolve => setImmediate(resolve));
    const queueFile = join(f.root, "local-output-queue.json");
    assert.deepEqual(readJson(queueFile), { version: 1, runs: [f.id] });
    const readonly = f.open(); readonly.current(); readonly.inspect(); logWindow(f.dir);
    assert.deepEqual(readJson(join(f.dir, "local-output.json")), cursor);
    const meters = [f.openRunner().observe()];
    assert.deepEqual(readJson(queueFile).runs, [f.id]);
    assert.equal(outputEvents(join(f.root, next.id))[0].data, "successor progress");
    for (const name of ["provider.log", "sensitive-redactions.json"]) assert.equal(existsSync(join(f.dir, name)), true);
    f.clock.advance(24 * 60 + 1);
    if (mode === "result-delayed") {
      meters.push(f.openRunner().observe());
      assert.deepEqual(readJson(queueFile).runs, [f.id]);
      for (const name of ["provider.log", "sensitive-redactions.json"]) assert.equal(existsSync(join(f.dir, name)), true);
      writeJsonAtomic(resultFile, result);
    }
    meters.push(f.openRunner().observe());
    assert.deepEqual(readJson(queueFile).runs, []);
    for (const name of ["provider.log", "sensitive-redactions.json"]) assert.equal(existsSync(join(f.dir, name)), false);
    assert.equal(readFileSync(join(f.dir, "job.json"), "utf8"), jobBytes);
    assert.equal(readFileSync(join(f.dir, "job.log"), "utf8"), logBytes);
    assert.deepEqual(readJson(resultFile), result);
    assert.deepEqual(f.open().outcome(f.id), result.outcome);
    assert.equal(readFileSync(join(f.root, "latest-run"), "utf8"), next.id);
    for (const meter of meters) {
      assert.ok((meter.pages || 0) <= LOCAL_OUTPUT_LIMITS.pages);
      assert.ok((meter.bytesRead || 0) <= LOCAL_OUTPUT_LIMITS.bytes * LOCAL_OUTPUT_LIMITS.pages);
      assert.ok((meter.maxBufferBytes || 0) <= LOCAL_OUTPUT_LIMITS.bytes);
    }
    assert.doesNotMatch(logBytes, /queued-private-value/);
    f.openRunner().observe(); assert.equal(readFileSync(join(f.dir, "job.log"), "utf8"), logBytes);
    evidence.push({ mode, runId: f.id, successor: next.id, cursor, meters, queue: readJson(queueFile), result: readJson(resultFile), files: { root: f.root, result: resultFile, job: join(f.dir, "job.json"), log: join(f.dir, "job.log"), queue: queueFile }, privateFilesRemoved: true });
  }
  const report = join(tempHome(), "local-retention-evidence.json");
  writeJsonAtomic(report, { kind: "Offline native Node successors and controlled-clock retention fixtures", cases: evidence });
  t.diagnostic(`local retention evidence: ${report}`);
});

test("private local cleanup retries removal failures without dropping its durable queue entry", () => {
  const f = localOutputFixture({ text: "completed output\n" }), runner = f.openRunner(), file = join(f.dir, "provider.log");
  runner.observe(); runner.prepareStart();
  localOutputFixture({ root: f.root, clock: f.clock, id: "next-run", text: "unrelated progress\n" });
  writeJsonAtomic(join(f.dir, "result.json"), { outcome: { finished: true, ok: true, lastMessage: "retained outcome", cost: null } });
  rmSync(file); mkdirSync(file); // A replaced diagnostic path cannot be removed as a file.
  f.clock.advance(24 * 60 + 1);
  assert.throws(() => f.openRunner().observe(), { code: "ERR_FS_EISDIR" });
  assert.deepEqual(readJson(join(f.root, "local-output-queue.json")).runs, [f.id]);
  assert.equal(existsSync(join(f.dir, "sensitive-redactions.json")), true);
  rmSync(file, { recursive: true });
  f.openRunner().observe();
  assert.deepEqual(readJson(join(f.root, "local-output-queue.json")).runs, []);
  assert.equal(existsSync(join(f.dir, "sensitive-redactions.json")), false);
  assert.equal(f.open().outcome(f.id).lastMessage, "retained outcome");
  assert.equal(outputEvents(join(f.root, "next-run"))[0].data, "unrelated progress");
});

test("completed local output survives a successor, restart and cursor replay with exact paginated history", async t => {
  const root = tempHome(), cwd = tempHome(), clock = makeClock(), taskId = "acme/widget/output", secret = "queued-private-value";
  const openRunner = () => makeRunner(root, { clock, probe: () => false });
  const open = runner => makeExecution({ root, taskId, provider: "codex", clock, runner });
  const runner = openRunner(), service = open(runner), session = "22222222-2222-4222-8222-222222222222";
  const lines = Array.from({ length: 240 }, (_, i) => `old output ${i} ${secret}`);
  lines.push(JSON.stringify({ type: "thread.started", thread_id: session }), JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "saved old result" } }), JSON.stringify({ type: "turn.completed" }));
  const text = lines.join("\n") + `\nfinal old tail ${secret}`;
  const old = await service.start("old", process.execPath, ["-e", `process.stdout.write(${JSON.stringify(text)})`], { cwd, env: { TEST_API_KEY: secret }, execution: { operationId: "old" } });
  while (runner.read(old.id).exit === null) await new Promise(resolve => setImmediate(resolve));
  await service.reconcile(); service.settle(old.id);
  const oldDir = service.dirOf(old.id), checkpoint = readJson(join(oldDir, "local-output.json"));
  assert.equal(outputEvents(oldDir).length, 100); assert.equal(checkpoint.pending, true);
  assert.equal(service.outcome(old.id).lastMessage, "saved old result");
  const next = await service.start("next", process.execPath, ["-e", 'process.stdout.write("next output\\n")'], { cwd, execution: { operationId: "next" } });
  while (runner.read(next.id).exit === null) await new Promise(resolve => setImmediate(resolve));
  const queueFile = join(root, "local-output-queue.json");
  assert.deepEqual(readJson(queueFile), { version: 1, runs: [old.id] });
  // Read-only status and tail reads cannot drain the queue or ingest diagnostics.
  const readonly = open(openRunner()); readonly.current(); readonly.inspect(); logWindow(oldDir);
  assert.deepEqual(readJson(join(oldDir, "local-output.json")), checkpoint);
  const reopenedRunner = openRunner(), reopened = open(reopenedRunner);
  await reopened.reconcile();
  assert.equal(outputEvents(oldDir).length, 200);
  assert.equal(outputEvents(reopened.dirOf(next.id))[0].data, "next output");
  // Simulate losing only the ingestion acknowledgement after durable journaling.
  writeJsonAtomic(join(oldDir, "local-output.json"), checkpoint);
  await open(openRunner()).reconcile(); assert.equal(outputEvents(oldDir).length, 200);
  await open(openRunner()).reconcile();
  assert.deepEqual(readJson(queueFile), { version: 1, runs: [old.id] });
  const events = outputEvents(oldDir), expected = [...lines, `final old tail ${secret}`];
  assert.equal(events.length, expected.length);
  let offset = 0;
  for (let i = 0; i < events.length; i++) {
    assert.equal(events[i].eventId, `byte-${offset}`); assert.equal(events[i].sequence, i + 1);
    assert.equal(events[i].runId, old.id); assert.equal(events[i].taskId, taskId); assert.equal(events[i].provenance, "local-cli");
    assert.equal(events[i].data, expected[i].replaceAll(secret, "[redacted]"));
    offset += Buffer.byteLength(expected[i]) + 1;
  }
  const ids = [], meter = { bytesRead: 0 };
  for (let after = 0; after < events.length;) {
    const page = logWindow(oldDir, { after, count: 40, meter });
    assert.ok(page.ids.length > 0); ids.push(...page.ids); after = page.ids.at(-1);
  }
  assert.deepEqual(ids, events.map(event => event.sequence));
  assert.doesNotMatch(readFileSync(join(oldDir, "job.log"), "utf8") + JSON.stringify(events), new RegExp(secret));
  const outcome = reopened.outcome(old.id);
  clock.advance(24 * 60 + 1); reopenedRunner.observe();
  assert.deepEqual(readJson(queueFile), { version: 1, runs: [] });
  assert.equal(readFileSync(join(root, "latest-run"), "utf8"), next.id);
  assert.equal(existsSync(join(oldDir, "provider.log")), false); assert.equal(existsSync(join(oldDir, "sensitive-redactions.json")), false);
  assert.deepEqual(reopened.outcome(old.id), outcome); assert.deepEqual(outputEvents(oldDir), events);
  writeJsonAtomic(join(root, "local-output-evidence.json"), { kind: "Offline local CLI output fixture", oldRun: old.id, nextRun: next.id, events: events.length, ids, queue: readJson(queueFile), result: outcome, files: { journal: join(oldDir, "events.jsonl"), log: join(oldDir, "job.log"), result: join(oldDir, "result.json") } });
  t.diagnostic(`local output evidence: ${join(root, "local-output-evidence.json")}`);
});

test("large queued local output uses bounded round-robin pages while unrelated jobs and review advance", async t => {
  const text = Array.from({ length: 2000 }, (_, i) => `large ${i} ${"x".repeat(4000)} queued-private-value\n`).join("");
  const f = localOutputFixture({ text }), runner = f.openRunner(), queueFile = join(f.root, "local-output-queue.json");
  runner.prepareStart();
  localOutputFixture({ root: f.root, clock: f.clock, id: "second-old", text: "second old\n".repeat(150) }); runner.prepareStart();
  const next = localOutputFixture({ root: f.root, clock: f.clock, id: "current-run", text: "current progress\n" });
  assert.deepEqual(readJson(queueFile).runs, [f.id, "second-old"]);
  const meter = f.openRunner().observe();
  assert.ok(meter.pages <= LOCAL_OUTPUT_LIMITS.pages); assert.ok(meter.bytesRead <= LOCAL_OUTPUT_LIMITS.pages * LOCAL_OUTPUT_LIMITS.bytes);
  assert.ok(meter.maxBufferBytes <= LOCAL_OUTPUT_LIMITS.bytes); assert.ok(meter.records <= LOCAL_OUTPUT_LIMITS.pages * LOCAL_OUTPUT_LIMITS.records);
  assert.ok(readJson(join(f.dir, "local-output.json")).offset < Buffer.byteLength(text));
  assert.equal(outputEvents(next.dir)[0].data, "current progress");
  assert.deepEqual(readJson(queueFile).runs, ["second-old", f.id]);
  // A missing execution.current still projects queued pre-upgrade local output.
  const home = tempHome(), state = makeState(home), gh = fakeGh(), local = fakeRunner(f.clock);
  for (const name of ["backlog", "unrelated", "review"]) state.put(`acme/widget/${name}`, newEntry({ repo: "acme/widget", harness: "codex", pr: 3, branch: "work/3", base: "main", worktree: tempHome(), state: name === "review" ? STATES.ready : STATES.done, nowIso: T0 }));
  gh.prView = async () => prFixture({ number: 3, headRefName: "work/3", state: "MERGED" });
  let progress = 0; local.reconcile = async () => { progress++; };
  const ctx = { home, config: CONFIG, clock: f.clock, state, gh, git: fakeGit(), log: silentLog, notify: fakeNotify(), ownLogin: "me", readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity(), executionFor: id => id.endsWith("/backlog") ? f.open() : local };
  assert.ok((await makeTick(ctx).tick()).every(result => result.ok));
  assert.ok(progress > 0); assert.equal(state.get("acme/widget/review").state, STATES.done);
  assert.equal(outputEvents(join(f.root, "second-old")).length, 100);
  assert.deepEqual(readJson(queueFile).runs, [f.id, "second-old"]);
  writeJsonAtomic(join(f.root, "local-output-bounds-evidence.json"), { kind: "Offline bounded local projection fixture", rawBytes: Buffer.byteLength(text), limits: LOCAL_OUTPUT_LIMITS, meter, unrelatedProgress: progress, reviewState: state.get("acme/widget/review").state, queue: readJson(queueFile), files: { checkpoint: join(f.dir, "local-output.json"), journal: join(f.dir, "events.jsonl"), queue: queueFile } });
  t.diagnostic(`local output bounds evidence: ${join(f.root, "local-output-bounds-evidence.json")}`);
});

test("queued local output has explicit stable gaps for expiry, missing diagnostics and missing redaction metadata", async () => {
  for (const reason of ["diagnostic retention expired", "diagnostic file missing", "diagnostic file truncated", "redaction metadata missing"]) {
    const f = localOutputFixture({ text: "queued-private-value\n".repeat(250) }), runner = f.openRunner();
    runner.observe(); runner.prepareStart();
    localOutputFixture({ root: f.root, clock: f.clock, id: "next-run", text: "next progress\n" });
    writeJsonAtomic(join(f.dir, "result.json"), { outcome: { finished: true, ok: true, lastMessage: "durable result", cost: null } });
    if (reason === "diagnostic retention expired") f.clock.advance(24 * 60 + 1);
    if (reason === "diagnostic file missing") rmSync(join(f.dir, "provider.log"));
    if (reason === "diagnostic file truncated") writeFileSync(join(f.dir, "provider.log"), "short");
    if (reason === "redaction metadata missing") rmSync(join(f.dir, "sensitive-redactions.json"));
    await f.open().reconcile();
    const events = outputEvents(f.dir), gap = events.at(-1);
    assert.equal(events.length, 101); assert.equal(gap.type, "gap"); assert.match(gap.data, new RegExp(reason));
    assert.deepEqual(readJson(join(f.root, "local-output-queue.json")).runs, reason === "diagnostic retention expired" ? [] : [f.id]);
    assert.doesNotMatch(JSON.stringify(events) + readFileSync(join(f.dir, "job.log"), "utf8"), /queued-private-value/);
    await f.open().reconcile(); assert.deepEqual(outputEvents(f.dir), events);
    assert.equal(f.open().outcome(f.id).lastMessage, "durable result");
    f.clock.advance(24 * 60 + 1); await f.open().reconcile();
    assert.deepEqual(readJson(join(f.root, "local-output-queue.json")).runs, []);
    assert.equal(existsSync(join(f.dir, "provider.log")), false); assert.equal(existsSync(join(f.dir, "sensitive-redactions.json")), false);
    assert.deepEqual(outputEvents(f.dir), events);
  }
});

test("incompatible local projection state prevents paid intent and preserves ownership and allowance", async () => {
  for (const corruption of ["version", "cursor", "discard-state", "queue-write"]) {
    const f = localOutputFixture({ text: "old output\n" }), queue = join(f.root, "local-output-queue.json");
    if (corruption === "version") writeJsonAtomic(queue, { version: 2, runs: [f.id] });
    if (corruption === "cursor") writeJsonAtomic(join(f.dir, "local-output.json"), { offset: -1 });
    if (corruption === "discard-state") writeJsonAtomic(join(f.dir, "local-output.json"), { offset: 0, discarding: "false" });
    if (corruption === "queue-write") mkdirSync(`${queue}.${process.pid}.tmp`);
    await assert.rejects(f.open().submit({ ...input, spec: { cmd: process.execPath, args: ["-e", "process.exit(0)"], options: { cwd: tempHome() } } }), corruption === "version" ? /unsupported local output queue.*preserve.*restore/ : ["cursor", "discard-state"].includes(corruption) ? /invalid local output cursor.*restore/ : { code: "EISDIR" });
    assert.deepEqual(f.open().state().operations, {}); assert.equal(f.open().state().allowance, undefined);
    assert.equal(readFileSync(join(f.root, "latest-run"), "utf8"), f.id);
    if (corruption === "version") assert.deepEqual(readJson(queue), { version: 2, runs: [f.id] });
    if (corruption === "cursor") assert.deepEqual(readJson(join(f.dir, "local-output.json")), { offset: -1 });
  }
});

test("oversized local records discard every suffix across queued restart, replay and legacy cursors with bounded reads", async t => {
  const evidence = [];
  for (const mode of ["newline", "unterminated", "legacy"]) {
    const prefix = "before oversized\n", rejected = "x".repeat(LOCAL_OUTPUT_LIMITS.bytes * 2 + 19) + "rejected suffix queued-private-value";
    const text = prefix + rejected + (mode === "unterminated" ? "" : "\nafter oversized café\n");
    const f = localOutputFixture({ text }), runner = f.openRunner(), cursor = join(f.dir, "local-output.json");
    runner.observe(); runner.observe();
    const first = readJson(cursor); assert.equal(first.discarding, true); assert.equal(outputEvents(f.dir).length, 2);
    if (mode === "legacy") { const { discarding: _discarding, ...old } = first; writeJsonAtomic(cursor, old); }
    runner.prepareStart(); localOutputFixture({ root: f.root, clock: f.clock, id: "next-run", text: "unrelated current progress\n" });
    const meters = [];
    for (let page = 0; page < 5 && readJson(cursor).pending; page++) {
      meters.push(f.openRunner().observe());
      if (page === 0) writeJsonAtomic(cursor, mode === "legacy" ? { offset: first.offset, pending: true } : first);
    }
    assert.deepEqual(readJson(join(f.root, "local-output-queue.json")).runs, [f.id]);
    assert.equal(readJson(cursor).discarding, false); assert.equal(readJson(cursor).offset, Buffer.byteLength(text));
    for (const meter of meters) { assert.ok(meter.bytesRead <= LOCAL_OUTPUT_LIMITS.bytes * 2); assert.ok(meter.maxBufferBytes <= LOCAL_OUTPUT_LIMITS.bytes); assert.ok(meter.pages <= 2); }
    const events = outputEvents(f.dir);
    assert.deepEqual(events.map(e => e.type), mode === "unterminated" ? ["output", "gap"] : ["output", "gap", "output"]);
    assert.equal(events[1].eventId, `byte-${Buffer.byteLength(prefix)}`); assert.equal(events[1].data, "oversized local record omitted");
    if (mode !== "unterminated") { assert.equal(events[2].data, "after oversized café"); assert.equal(events[2].eventId, `byte-${Buffer.byteLength(prefix + rejected + "\n")}`); }
    const projection = logWindow(f.dir); assert.deepEqual(projection.ids, events.map(e => e.sequence));
    assert.doesNotMatch(JSON.stringify(events) + projection.lines.join("\n"), /rejected suffix|queued-private-value|xxx/);
    assert.equal(outputEvents(join(f.root, "next-run"))[0].data, "unrelated current progress");
    evidence.push({ mode, bytes: Buffer.byteLength(text), first, final: readJson(cursor), meters, events, files: { checkpoint: cursor, journal: join(f.dir, "events.jsonl"), log: join(f.dir, "job.log") } });
  }
  const file = join(tempHome(), "local-discard-evidence.json"); writeJsonAtomic(file, { kind: "Offline bounded oversized-record fixtures", cases: evidence });
  t.diagnostic(`local discard evidence: ${file}`);
});

test("an active oversized local record stays discarded at EOF until its newline arrives", () => {
  const f = localOutputFixture({ text: "x".repeat(LOCAL_OUTPUT_LIMITS.bytes) }), file = join(f.dir, "provider.log"), cursor = join(f.dir, "local-output.json");
  const job = readJson(join(f.dir, "job.json")); writeJsonAtomic(join(f.dir, "job.json"), { ...job, exit: null, pid: 1234, bin: "offline-fixture" });
  const open = () => makeRunner(f.root, { clock: f.clock, probe: () => true });
  open().observe(); assert.equal(readJson(cursor).discarding, true);
  open().observe(); assert.equal(readJson(cursor).pending, true); assert.equal(outputEvents(f.dir).length, 1);
  writeFileSync(file, "still rejected private-tail", { flag: "a" }); open().observe();
  assert.equal(readJson(cursor).discarding, true); assert.equal(outputEvents(f.dir).length, 1);
  writeFileSync(file, "\nvalid current progress\n", { flag: "a" }); open().observe();
  assert.equal(readJson(cursor).discarding, false); assert.equal(outputEvents(f.dir)[1].data, "valid current progress");
  assert.doesNotMatch(readFileSync(join(f.dir, "job.log"), "utf8"), /rejected|private-tail|xxx/);
});

test("oversized discard retention emits a stable history gap while keeping the completed result", () => {
  const f = localOutputFixture({ text: "x".repeat(LOCAL_OUTPUT_LIMITS.bytes * 2) + "rejected suffix\n" }), runner = f.openRunner();
  runner.observe(); assert.equal(readJson(join(f.dir, "local-output.json")).discarding, true);
  runner.prepareStart(); localOutputFixture({ root: f.root, clock: f.clock, id: "next-run", text: "next progress\n" });
  writeJsonAtomic(join(f.dir, "result.json"), { outcome: { finished: true, ok: true, lastMessage: "retained result", cost: null } });
  f.clock.advance(24 * 60 + 1); f.openRunner().observe();
  const events = outputEvents(f.dir); assert.equal(events.length, 2); assert.ok(events.every(e => e.type === "gap")); assert.match(events[1].data, /retention expired/);
  assert.equal(existsSync(join(f.dir, "provider.log")), false); assert.equal(f.open().outcome(f.id).lastMessage, "retained result");
  f.openRunner().observe(); assert.deepEqual(outputEvents(f.dir), events);
});

function resultFixture() {
  const dir = tempHome(), worktree = tempHome(), id = "acme/widget/result", revision = "a".repeat(40), runId = "result-run";
  writeFileSync(join(worktree, "a.txt"), "before");
  const entry = { ...newEntry({ repo: "acme/widget", harness: "codex", session: "22222222-2222-4222-8222-222222222222", branch: "work/result", base: "main", worktree, nowIso: T0, state: STATES.running }), execution: { runId, providerJobId: "j1", turnId: "t1", inputHead: revision } };
  const result = { taskId: id, runId, providerJobId: "j1", turnId: "t1", inputHead: revision, repo: entry.repo, branch: entry.branch, files: [{ path: "a.txt", beforeHash: sha("before"), afterHash: sha("after"), text: "after" }], pr: { title: "Apply result", body: "Verified execution artifacts." } };
  const calls = [], git = { head: async () => revision, trackedPaths: async () => ["a.txt"], resultModesMatch: async () => true, dirty: async () => ({ modified: 0, untracked: 0 }), currentBranch: async () => entry.branch, originOf: async () => "https://github.com/acme/widget.git", commitResult: async () => calls.push("commit"), pushResult: async () => calls.push("push") };
  const gh = { publishResultPr: async () => { calls.push("PR"); return { number: 1, url: "https://example.test/pr/1" }; } };
  const ctx = { git, gh, readPrd: () => "# Brief\n\n## Verify\n\n- `printf verified`\n" };
  const verify = async () => { calls.push("verify"); return { stdout: "verified", stderr: "" }; };
  return { id, entry, result, dir, ctx, verify, calls };
}

async function collectedArtifactFixture(secrets = [], { providerName = "openai-agents", accepted } = {}) {
  const f = resultFixture(), provider = remote(providerName), home = tempHome(), root = join(home, "runs", idSlug(f.id));
  const submit = provider.transport.submit;
  if (accepted) provider.transport.submit = async req => { await submit(req); provider.observe(accepted); return accepted; };
  const options = { root, taskId: f.id, provider: providerName, account: "test", transport: provider.transport, capabilities: provider.capabilities, clock: provider.clock, secrets };
  const reopen = () => makeExecution(options), service = reopen(), job = await service.submit(input);
  f.entry.harness = providerName; f.entry.session = job.execution.sessionId; f.entry.execution = job.execution;
  Object.assign(f.result, { runId: job.id, providerJobId: job.execution.providerJobId, sessionId: job.execution.sessionId, turnId: job.execution.turnId,
    outcome: { finished: true, ok: true, cost: null, denials: [] } });
  provider.transport.collect = async () => { provider.calls.push(["collect"]); return f.result; };
  Object.assign(f.ctx, { home, executionFor: reopen });
  f.dir = service.dirOf(job.id);
  return { ...f, service, reopen, provider, job, collect: async () => {
    provider.observe({ state: "succeeded" }); await service.reconcile({ force: true }); return service.collect();
  } };
}

test("result metadata redaction preserves exact private ownership while cleaning diagnostics", () => {
  for (const supplied of [false, true]) {
    const keys = ["taskId", "runId", "providerJobId", "sessionId", "turnId", "inputHead", "repo", "branch", "pushedHead"];
    const identities = Object.fromEntries(keys.map(key => [key, supplied ? `opaque-owned-${key}` : `sk-ownedcredentialshape-${key}`]));
    const secrets = supplied ? Object.values(identities) : [], message = Object.values(identities).join(" ");
    const original = { ...identities, version: 1, outcome: { finished: true, ok: true, lastMessage: message },
      lines: [message], usage: { detail: message }, pr: { title: message, body: message },
      files: [{ path: identities.branch, afterHash: identities.inputHead, text: message }] };
    const snapshot = structuredClone(original), clean = redactResultMetadata(original, secrets);
    for (const key of keys) assert.equal(clean[key], identities[key], `${key} remains exact private publication input`);
    assert.deepEqual(clean.files, original.files); assert.deepEqual(original, snapshot);
    assert.deepEqual(clean.artifacts, [{ path: "[redacted]", hash: "[redacted]" }]);
    for (const value of Object.values(identities)) {
      assert.equal(JSON.stringify({ outcome: clean.outcome, lines: clean.lines, usage: clean.usage, pr: clean.pr }).includes(value), false);
      assert.equal(JSON.stringify(redact(clean, secrets)).includes(value), false);
    }
    const omitted = redactResultMetadata({ outcome: { finished: true, ok: true }, sessionId: null });
    assert.equal(omitted.sessionId, null); assert.equal(Object.hasOwn(omitted, "providerJobId"), false);
  }
});

test("opaque remote identities survive collection, publication and continuation while public results stay redacted", async t => {
  const evidence = [];
  for (const providerName of ["openai-agents", "codex-cloud"]) for (const supplied of [false, true]) {
    const accepted = Object.fromEntries(["providerJobId", "sessionId", "turnId"].map(key => [key,
      supplied ? `opaque-owned-${key}` : `sk-ownedcredentialshape-${key}`]));
    const secrets = supplied ? Object.values(accepted) : [], f = await collectedArtifactFixture(secrets, { providerName, accepted });
    if (supplied) secrets.push(f.id, f.job.id, input.inputHead, f.entry.repo, f.entry.branch);
    const identities = { ...accepted, taskId: f.id, runId: f.job.id, inputHead: input.inputHead, repo: f.entry.repo, branch: f.entry.branch };
    const privateMessage = Object.values(accepted).join(" ");
    f.result.lines = [privateMessage]; f.result.outcome.lastMessage = privateMessage; f.result.usage = { detail: privateMessage };
    f.provider.observe({ events: [{ eventId: "owned-output", type: "output", data: privateMessage }] });
    const source = structuredClone(f.result), collected = await f.collect();
    for (const [key, value] of Object.entries(identities)) assert.equal(collected[key], value);
    assert.deepEqual(f.result, source); assert.equal(statSync(join(f.dir, "result.json")).mode & 0o777, 0o600);
    assert.equal(f.reopen().current().execution.sessionId, accepted.sessionId);
    assert.equal(f.reopen().sessionFrom(f.job.id), accepted.sessionId);
    const bytes = readFileSync(join(f.dir, "result.json"), "utf8"), replay = await f.reopen().collect();
    assert.deepEqual(replay, collected); assert.equal(readFileSync(join(f.dir, "result.json"), "utf8"), bytes);
    assert.equal(f.provider.calls.filter(c => c[0] === "collect").length, 1);
    f.verify = async () => { f.calls.push("verify"); return { stdout: privateMessage, stderr: "" }; };
    const done = await reconcileExecutionResult(f.ctx, { ...f, result: replay });
    assert.deepEqual(f.calls, ["commit", "verify", "push", "PR"]); assert.equal(done.evidence[0].exit, 0);
    assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "after");
    const state = makeState(f.ctx.home); state.put(f.id, f.entry);
    const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } }, before = f.provider.calls.length;
    routes["GET /api/run/result"]({ ...f.ctx, state }, {}, response, new URL(`http://localhost/api/run/result?id=${f.id}&run=${f.job.id}`));
    assert.equal(response.code, 200); assert.equal(f.provider.calls.length, before);
    const view = JSON.parse(response.body);
    for (const value of [...Object.values(accepted), ...secrets]) assert.equal(response.body.includes(value), false);
    for (const key of ["providerJobId", "sessionId", "turnId"]) assert.equal(view[key], "[redacted]");
    assert.equal(Object.hasOwn(view, "files"), false);
    for (const file of ["events.jsonl", "job.log", "verification.json"]) {
      const output = readFileSync(join(f.dir, file), "utf8");
      for (const value of Object.values(accepted)) assert.equal(output.includes(value), false);
    }
    const publicPath = join(f.dir, "identity-public-result.json"); writeJsonAtomic(publicPath, view);
    const next = await f.reopen().continue({ ...input, operationId: "owned-next", sessionId: accepted.sessionId });
    assert.equal(next.execution.sessionId, accepted.sessionId);
    assert.equal(f.provider.calls.filter(c => c[0] === "continue").length, 1);
    assert.equal(f.provider.calls.find(c => c[0] === "continue")[1].sessionId, accepted.sessionId);
    assert.equal(f.provider.calls.filter(c => c[0] === "submit").length, 1);
    evidence.push({ provider: providerName, supplied, identities, continuationSession: next.execution.sessionId, paidFixtureSubmits: 1, collectCalls: 1,
      files: { execution: join(f.service.root, "execution.json"), result: join(f.dir, "result.json"), publicResult: publicPath,
        application: join(f.dir, "result-application.json"), verification: join(f.dir, "verification.json"), events: join(f.dir, "events.jsonl"), log: join(f.dir, "job.log") } });
  }
  const report = join(tempHome(), "remote-result-identities.json"); writeJsonAtomic(report, { cases: evidence });
  t.diagnostic(`remote result identity evidence: ${report}`);
});

test("opaque local identities survive settlement, collection and cached continuation without diagnostic exposure", async t => {
  const evidence = [];
  for (const provider of ["claude", "gemini", "codex", "opencode", "goose"]) for (const path of ["collect", "settle"]) for (const supplied of [false, true]) {
    const f = localTimeoutFixture({ provider }), sessionId = supplied ? f.session : "sk-ownedcredentialshape-localsession";
    const secrets = supplied ? [sessionId] : [], service = f.open({ secrets });
    const job = await service.submit({ ...input, recordedSessionId: sessionId, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    if (supplied) secrets.push(f.id, job.id, input.inputHead);
    f.runner.finish(localSessionLines(provider, sessionId), { exit: 0 });
    await service.reconcile();
    if (path === "collect") await service.collect(); else service.settle(job.id);
    const cachedPath = join(f.root, job.id, "result.json"), bytes = readFileSync(cachedPath, "utf8"), saved = readJson(cachedPath);
    assert.equal(saved.sessionId, sessionId); assert.equal(saved.taskId, f.id); assert.equal(saved.runId, job.id);
    if (path === "settle") { assert.equal(saved.providerJobId, job.id); assert.equal(saved.inputHead, input.inputHead); }
    const reopened = f.open({ secrets }), replay = await reopened.collect();
    assert.deepEqual(replay, saved); assert.equal(readFileSync(cachedPath, "utf8"), bytes);
    assert.equal(reopened.sessionFrom(job.id), sessionId); assert.equal(reopened.current().execution.sessionId, sessionId);
    assert.equal(JSON.stringify(reopened.sanitize(saved, job.id)).includes(sessionId), false);
    const next = await reopened.continue({ operationId: "owned-next", sessionId, spec: { cmd: "offline-cli-fixture", args: [], options: {} } });
    assert.equal(next.execution.sessionId, sessionId); assert.equal(f.runner.started.length, 2);
    evidence.push({ provider, path, supplied, sessionId, continuationSession: next.execution.sessionId, launches: 2,
      files: { result: cachedPath, execution: join(f.root, "execution.json") } });
  }
  const report = join(tempHome(), "local-result-identities.json"); writeJsonAtomic(report, { cases: evidence });
  t.diagnostic(`local result identity evidence: ${report}`);
});

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
  const invalid = resultFixture(); invalid.result.files = structuredClone(replay.files); invalid.result.files[0].text += "changed";
  await assert.rejects(reconcileExecutionResult(invalid.ctx, invalid), /artifact content hash differs/);
  assert.equal(readJson(join(invalid.dir, "result-application.json")).reason, "result-validation");
  invalid.result.files[0].text = text;
  await assert.rejects(reconcileExecutionResult(invalid.ctx, invalid), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.deepEqual(invalid.calls, []);
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

test("overlapping collection and environment secrets remain private through verification, tracker and restart", async t => {
  const short = "opaque-collect-overlap", long = `${short}-hidden-suffix`, envKey = "EXECUTION_OVERLAP_TEST_TOKEN", savedEnv = process.env[envKey], observations = [];
  try {
    for (const failing of [false, true]) for (const envSecret of [short, long]) {
      process.env[envKey] = envSecret;
      const f = await collectedArtifactFixture([short, long]), output = `<${long}> / ${short}`, expected = "<[redacted]> / [redacted]";
      const text = `export const sample = "${long}";\n`, path = `${long}.mjs`;
      f.result.files = [{ path, beforeHash: null, afterHash: sha(text), text }];
      f.result.outcome.lastMessage = output; f.result.lines = [output]; f.result.usage = { detail: output };
      const original = structuredClone(f.result.files), result = await f.collect();
      assert.deepEqual(result.files, original); assert.equal(result.files[0].afterHash, sha(text));
      assert.equal(result.outcome.lastMessage, expected); assert.deepEqual(result.lines, [expected]);
      assert.deepEqual(result.usage, { detail: expected }); assert.equal(result.artifacts[0].path, "[redacted].mjs");
      assert.deepEqual(await f.reopen().collect(), result); assert.equal(f.provider.calls.filter(c => c[0] === "collect").length, 1);
      const verify = async () => { f.calls.push("verify"); if (failing) throw Object.assign(new Error("synthetic Verify failure"), { code: 2, stdout: output }); return { stdout: output, stderr: "" }; };
      if (failing) await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result, verify }), /verification failed/);
      else await reconcileExecutionResult(f.ctx, { ...f, result, verify });
      const verification = readJson(join(f.dir, "verification.json"));
      assert.equal(verification.evidence[0].output, expected); assert.equal(verification.evidence[0].exit, failing ? 2 : 0);
      assert.equal(readFileSync(join(f.entry.worktree, path), "utf8"), text);
      assert.deepEqual(f.reopen().outcome(f.job.id).lastMessage, expected);
      const state = makeState(f.ctx.home); state.put(f.id, f.entry);
      const before = f.provider.calls.length, response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } };
      routes["GET /api/run/result"]({ ...f.ctx, state }, {}, response, new URL(`http://localhost/api/run/result?id=${f.id}&run=${f.job.id}`));
      assert.equal(response.code, 200); assert.doesNotMatch(response.body, /opaque-collect-overlap|hidden-suffix/);
      const view = JSON.parse(response.body); assert.equal(view.verification.evidence[0].output, expected);
      assert.deepEqual(view.artifacts, result.artifacts); assert.equal(Object.hasOwn(view, "files"), false);
      assert.equal(f.provider.calls.length, before); assert.equal(f.calls.includes("PR"), !failing);
      const viewPath = join(f.dir, "overlap-public-result.json"); writeJsonAtomic(viewPath, view);
      observations.push({ dir: f.dir, artifact: join(f.entry.worktree, path), publicResult: viewPath, expected, exit: verification.evidence[0].exit, published: !failing, collectCalls: 1 });
    }
    // The fallback with no execution boundary must also sort environment values.
    const f = resultFixture(), secondKey = "EXECUTION_OVERLAP_TEST_API_TOKEN", savedSecond = process.env[secondKey];
    try {
      process.env[envKey] = short; process.env[secondKey] = long;
      await reconcileExecutionResult(f.ctx, { ...f, verify: async () => ({ stdout: `<${long}> / ${short}` }) });
      assert.equal(readJson(join(f.dir, "verification.json")).evidence[0].output, "<[redacted]> / [redacted]");
    } finally { if (savedSecond === undefined) delete process.env[secondKey]; else process.env[secondKey] = savedSecond; }
  } finally { if (savedEnv === undefined) delete process.env[envKey]; else process.env[envKey] = savedEnv; }
  const path = join(tempHome(), "overlap-result-evidence.json"); writeJsonAtomic(path, { observations });
  t.diagnostic(`overlap result evidence: ${path}`);
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
      assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
    }
  }
  // Validate every target before reading even the first artifact's content hash.
  const unsafe = resultFixture(); unsafe.result.files[0].afterHash = "invalid-content-hash";
  unsafe.result.files.push({ ...unsafe.result.files[0], path: ".//.git/config" });
  await assert.rejects(reconcileExecutionResult(unsafe.ctx, unsafe), /unsafe repository path/);
  assert.equal(readFileSync(join(unsafe.entry.worktree, "a.txt"), "utf8"), "before");
  assert.deepEqual(unsafe.calls, []);
});

test("case and Unicode artifact aliases reject one portable target before reading or applying payloads", async t => {
  const observations = [];
  for (const [first, alias] of [["src/File.js", "src/file.js"], ["Src/a.txt", "src/a.txt"], ["café.txt", "cafe\u0301.txt"], ["Σ.txt", "ς.txt"], ["Straße.txt", "STRASSE.txt"]]) {
    for (const operation of ["create", "modify", "delete"]) {
      const f = resultFixture();
      if (operation !== "create") {
        if (first.includes("/")) mkdirSync(join(f.entry.worktree, first.split("/")[0]));
        writeFileSync(join(f.entry.worktree, first), "before");
      }
      const beforeHash = operation === "create" ? null : sha("before");
      f.result.files = [{ path: first, beforeHash, afterHash: "invalid-content-hash", text: "first payload" },
        { path: alias, beforeHash, afterHash: operation === "delete" ? null : sha("last payload"), text: operation === "delete" ? null : "last payload" }];
      const original = structuredClone(f.result.files), filesystemAlias = operation !== "create" && existsSync(join(f.entry.worktree, alias)) && lstatSync(join(f.entry.worktree, first)).ino === lstatSync(join(f.entry.worktree, alias)).ino;
      await assert.rejects(reconcileExecutionResult(f.ctx, f), /duplicate canonical result file/);
      if (operation === "create") assert.equal(existsSync(join(f.entry.worktree, first)), false);
      else assert.equal(readFileSync(join(f.entry.worktree, first), "utf8"), "before");
      assert.deepEqual(f.result.files, original); assert.deepEqual(f.calls, []);
      assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
      observations.push({ paths: [first, alias], operation, filesystemAlias, mutation: false });
    }
  }
  const dir = tempHome(); writeJsonAtomic(join(dir, "artifact-alias-evidence.json"), { kind: "Native filesystem observation and offline artifact manifest fixture", observations });
  t.diagnostic(`artifact alias evidence: ${join(dir, "artifact-alias-evidence.json")}`);
});

test("one mixed-case artifact preserves its path and bytes through native Git publication and replay", async () => {
  const f = await nativeResultFixture(), path = "Src/Auth.js", text = "export const token = process.env.API_TOKEN;\n";
  f.result.files = [{ path, beforeHash: null, afterHash: sha(text), text }];
  const original = structuredClone(f.result.files);
  await reconcileExecutionResult(f.ctx, f); await reconcileExecutionResult(f.ctx, f);
  assert.deepEqual(f.result.files, original); assert.equal(readFileSync(join(f.entry.worktree, path), "utf8"), text);
  const files = await execFileAsync("git", ["ls-tree", "--name-only", "-r", "HEAD"], { cwd: f.entry.worktree });
  assert.match(files.stdout, /Src\/Auth\.js/); assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published");
  assert.deepEqual(f.calls, ["commit", "verify", "push", "PR"]);
});

test("single artifacts reject aliases of native tracked files and parent directories before content validation or mutation", async t => {
  const observations = [];
  for (const [tracked, target] of [["src/File.js", "src/file.js"], ["Src/old.js", "src/new.js"], ["café/old.js", "cafe\u0301/new.js"], ["Σ/old.js", "ς/new.js"], ["Straße/old.js", "STRASSE/new.js"], [" File.js", " file.js"]]) {
    const f = await nativeResultFixture();
    if (tracked.includes("/")) mkdirSync(join(f.entry.worktree, tracked.split("/")[0]));
    writeFileSync(join(f.entry.worktree, tracked), "existing tracked bytes");
    await f.ctx.git.commitResult(f.entry.worktree, [tracked]); f.calls.length = 0;
    const head = await f.ctx.git.head(f.entry.worktree); f.result.inputHead = head; f.entry.execution.inputHead = head;
    f.result.files = [{ path: target, beforeHash: null, afterHash: "must-not-read-content", text: "new artifact" }];
    const manifest = structuredClone(f.result), files = await f.ctx.git.trackedPaths(f.entry.worktree);
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /aliases an existing repository path/);
    assert.equal(await f.ctx.git.head(f.entry.worktree), head);
    assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), { modified: 0, untracked: 0 });
    assert.equal(readFileSync(join(f.entry.worktree, tracked), "utf8"), "existing tracked bytes");
    assert.deepEqual(f.result, manifest); assert.deepEqual(f.calls, []);
    assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
    observations.push({ tracked, target, head, worktree: f.entry.worktree, resultDir: f.dir, trackedPaths: files,
      filesystemAlias: existsSync(join(f.entry.worktree, target)), mutation: false, publicationCalls: [...f.calls], manifestPreserved: true });
  }
  const dir = tempHome(), path = join(dir, "tracked-alias-evidence.json");
  writeJsonAtomic(path, { kind: "Offline manifests with native Git index/HEAD and filesystem observations", observations });
  t.diagnostic(`tracked alias evidence: ${path}`);
});

test("tracked alias checks include staged additions and HEAD paths removed from the index", async () => {
  for (const source of ["index", "HEAD"]) {
    const f = await nativeResultFixture(), tracked = "Src/owned.js", target = "src/new.js";
    mkdirSync(join(f.entry.worktree, "Src")); writeFileSync(join(f.entry.worktree, tracked), "owned bytes");
    if (source === "HEAD") {
      await f.ctx.git.commitResult(f.entry.worktree, [tracked]);
      const head = await f.ctx.git.head(f.entry.worktree); f.result.inputHead = head; f.entry.execution.inputHead = head;
      await execFileAsync("git", ["rm", "--cached", "--", tracked], { cwd: f.entry.worktree });
    } else await execFileAsync("git", ["add", "--", tracked], { cwd: f.entry.worktree });
    f.calls.length = 0;
    const dirty = await f.ctx.git.dirty(f.entry.worktree, { strict: true });
    const index = (await execFileAsync("git", ["ls-files", "-z"], { cwd: f.entry.worktree })).stdout;
    assert.ok((await f.ctx.git.trackedPaths(f.entry.worktree)).includes(tracked));
    f.result.files = [{ path: target, beforeHash: null, afterHash: sha("new"), text: "new" }];
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /aliases an existing repository path/);
    assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), dirty);
    assert.equal((await execFileAsync("git", ["ls-files", "-z"], { cwd: f.entry.worktree })).stdout, index);
    assert.equal(readFileSync(join(f.entry.worktree, tracked), "utf8"), "owned bytes");
    assert.equal(existsSync(join(f.entry.worktree, target)), false); assert.deepEqual(f.calls, []);
  }
});

test("portable targets reject parent and file-directory aliases while accepting exact tracked spelling", async () => {
  for (const [tracked, target] of [["Src", "src/new.js"], ["Src/old.js", "src"]]) {
    const f = resultFixture(); f.ctx.git.trackedPaths = async () => [tracked];
    f.result.files = [{ path: target, beforeHash: null, afterHash: "invalid", text: "new" }];
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /aliases an existing repository path/);
    assert.deepEqual(f.calls, []); assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
  }
  const parents = resultFixture();
  parents.result.files = ["Src/a.js", "src/b.js"].map(path => ({ path, beforeHash: null, afterHash: "invalid", text: "new" }));
  await assert.rejects(reconcileExecutionResult(parents.ctx, parents), /aliases an existing repository path/);
  assert.deepEqual(parents.calls, []); assert.equal(existsSync(join(parents.entry.worktree, "Src")), false);
  for (const deletion of [false, true]) {
    const f = await nativeResultFixture(), path = "Src/Auth.js";
    mkdirSync(join(f.entry.worktree, "Src")); writeFileSync(join(f.entry.worktree, path), "before");
    await f.ctx.git.commitResult(f.entry.worktree, [path]); f.calls.length = 0;
    const head = await f.ctx.git.head(f.entry.worktree); f.result.inputHead = head; f.entry.execution.inputHead = head;
    const text = deletion ? null : "after";
    f.result.files = [{ path: ".//Src/Auth.js", beforeHash: sha("before"), afterHash: deletion ? null : sha(text), text }];
    await reconcileExecutionResult(f.ctx, f); await reconcileExecutionResult(f.ctx, f);
    assert.deepEqual(f.calls, ["commit", "verify", "push", "PR"]);
    assert.equal(existsSync(join(f.entry.worktree, path)), !deletion);
    if (!deletion) assert.equal(readFileSync(join(f.entry.worktree, path), "utf8"), text);
    assert.equal(f.result.files[0].path, ".//Src/Auth.js");
  }
});

test("pushed and verified recovery reject tracked aliases without verification or publication replay", async () => {
  const pushed = resultFixture(); pushed.result.files = []; pushed.result.pushedHead = pushed.result.inputHead;
  pushed.ctx.gh.refSha = async () => pushed.result.pushedHead; pushed.ctx.gh.containsCommit = async () => true;
  pushed.ctx.git.trackedPaths = async () => ["Src/a.js", "src/b.js"];
  await assert.rejects(reconcileExecutionResult(pushed.ctx, pushed), /aliases an existing repository path/);
  assert.deepEqual(pushed.calls, []); assert.equal(readJson(join(pushed.dir, "result-application.json")).reason, "result-validation");
  const f = resultFixture(); f.ctx.git.pushResult = async () => { f.calls.push("push"); throw new Error("push reply lost"); };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /push reply lost/);
  const evidence = readFileSync(join(f.dir, "verification.json"), "utf8"), checkpoint = readFileSync(join(f.dir, "result-application.json"), "utf8");
  f.calls.length = 0; f.ctx.git.trackedPaths = async () => ["a.txt", "A.TXT"];
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /aliases an existing repository path/);
  assert.deepEqual(f.calls, []); assert.equal(readFileSync(join(f.dir, "verification.json"), "utf8"), evidence);
  const blocked = readJson(join(f.dir, "result-application.json"));
  assert.equal(blocked.reason, "result-validation"); assert.equal(blocked.phase, "blocked");
  for (const [key, value] of Object.entries(JSON.parse(checkpoint))) if (key !== "phase") assert.deepEqual(blocked[key], value);
});

test("Git path readers preserve whitespace and NUL ordering with bounded complete metadata", async () => {
  const f = await nativeResultFixture(), path = " file\nname.txt", head = await f.ctx.git.head(f.entry.worktree);
  writeFileSync(join(f.entry.worktree, path), "owned whitespace path");
  await f.ctx.git.commitResult(f.entry.worktree, [path]);
  assert.ok((await f.ctx.git.trackedPaths(f.entry.worktree)).includes(path));
  assert.equal(await f.ctx.git.resultHeadMatches(f.entry.worktree, head, [path]), true);
  assert.equal(await f.ctx.git.resultHeadMatches(f.entry.worktree, head, [path.trim()]), false);
  for (const stdout of ["missing delimiter", "x".repeat(GIT_PATH_LIMITS.bytes + 1), null]) {
    const calls = [], git = makeGit({ config: CONFIG, exec: async (_cmd, args, options) => { calls.push({ args, timeout: options.timeout, maxBuffer: options.maxBuffer }); return { stdout: args[0] === "merge-base" ? "" : stdout }; } });
    await assert.rejects(git.trackedPaths(f.entry.worktree), /incomplete or oversized Git path metadata/);
    assert.equal(calls.length, 2); assert.ok(calls.every(call => call.timeout === 2000 && call.maxBuffer === 1_048_576));
    await assert.rejects(git.commitResult(f.entry.worktree, [path]), /incomplete or oversized Git path metadata/);
    await assert.rejects(git.resultHeadMatches(f.entry.worktree, head, [path]), /incomplete or oversized Git path metadata/);
  }
});

test("missing or failing tracked path metadata stops result application before files, checkpoints or publication", async () => {
  for (const trackedPaths of [undefined, async () => { throw new Error("Git path probe failed"); }, async () => null, async () => ["../outside"]]) {
    const f = resultFixture(); f.ctx.git.trackedPaths = trackedPaths;
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /repository paths|Git path metadata/);
    assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "before");
    assert.deepEqual(f.calls, []); assert.equal(existsSync(join(f.dir, "result-application.json")), false);
  }
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
  assert.match(restarted.state.get(f.id).control.message, /cannot retry publication/);
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

test("deterministic publication rejection settles once and permits an explicit corrective continuation", async t => {
  const cases = {
    repository: f => { f.result.repo = "foreign/repository"; }, branch: f => { f.result.branch = "main"; },
    path: f => { f.result.files[0].path = "../outside"; }, hash: f => { f.result.files[0].afterHash = "invalid"; },
    alias: f => { f.result.files.push({ ...f.result.files[0], path: "./a.txt" }); },
    mode: f => { f.ctx.git.resultModesMatch = async () => false; },
    publicText: f => { f.result.pr.title = "Gallivant result"; },
    nulTitle: f => { f.result.pr.title += "\0private"; },
    nulBody: f => { f.result.pr.body += "\0private"; },
    nulRecoveryBody: f => { f.result.pr.body += "\n<!-- work-session\nignored\0payload\n-->\n"; },
  }, observations = [];
  for (const [kind, mutate] of Object.entries(cases)) {
    const f = await collectedArtifactFixture(); mutate(f);
    const state = makeState(f.ctx.home), notify = fakeNotify(), gh = fakeGh({ pr: { state: "MERGED" } }), reviewId = "acme/widget/review";
    state.put(f.id, { ...f.entry, last: { run: f.job.id, exit: null } });
    state.put(reviewId, newEntry({ repo: "acme/widget", harness: "codex", branch: "work/review", pr: 2, state: STATES.prOpen, nowIso: T0 }));
    const ctx = { ...f.ctx, state, clock: f.provider.clock, config: CONFIG, git: { ...fakeGit(), ...f.ctx.git }, gh, ownLogin: "me", log: silentLog, notify,
      credential: fakeCredential(), identity: fakeIdentity(), executionFor: id => id === f.id ? f.reopen() : { current: () => null } };
    f.provider.observe({ state: "succeeded" }); await makeTick(ctx).tick();
    const checkpoint = readJson(join(f.dir, "result-application.json")), result = readFileSync(join(f.dir, "result.json"), "utf8"), settled = state.get(f.id);
    assert.equal(checkpoint?.phase, "blocked", kind); assert.equal(checkpoint.reason, "result-validation");
    assert.equal(state.get(f.id).state, STATES.needsHuman); assert.equal(state.get(f.id).reason, "result-verification");
    assert.equal(state.get(f.id).last.exit, 0); assert.equal(state.get(f.id).session, f.job.execution.sessionId);
    assert.equal(state.get(reviewId).state, STATES.done); assert.deepEqual(f.calls, []); assert.equal(existsSync(join(f.dir, "verification.json")), false);
    const restarted = { ...ctx, state: makeState(ctx.home) };
    for (let poll = 0; poll < 3; poll++) { await makeTick(restarted).tick(); await makeTick(restarted).tickEntry(f.id, restarted.state.get(f.id)); }
    assert.deepEqual(readJson(join(f.dir, "result-application.json")), checkpoint); assert.equal(readFileSync(join(f.dir, "result.json"), "utf8"), result);
    assert.deepEqual(f.calls, []); assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "before");
    assert.equal(f.provider.calls.filter(call => call[0] === "collect").length, 1); assert.equal(f.provider.calls.filter(call => call[0] === "submit").length, 1);
    assert.equal(notify.sent.filter(call => call[0] === "needs").length, 1);
    restarted.state.update(f.id, { pr: 1 });
    assert.throws(() => requestControl(restarted, { handle: f.id, action: "recheck" }), error => {
      assert.equal(error.code, "EXECUTION_RESULT_BLOCKED");
      assert.match(controlFailure(error), /Inspect result-application\.json, result\.json and any verification\.json/);
      assert.match(controlFailure(error), /explicitly resume.*cannot retry publication/); return true;
    });
    gh.data.pr.state = "OPEN";
    requestControl(restarted, { handle: f.id, action: "resume" }); await makeTick(restarted).tickEntry(f.id, restarted.state.get(f.id));
    assert.equal(restarted.state.get(f.id).control.status, "applied"); assert.equal(f.provider.calls.filter(call => call[0] === "continue").length, 1);
    assert.equal(f.reopen().current().execution.sessionId, f.job.execution.sessionId); assert.notEqual(restarted.state.get(f.id).last.run, f.job.id);
    assert.deepEqual(readJson(join(f.dir, "result-application.json")), checkpoint); assert.equal(readFileSync(join(f.dir, "result.json"), "utf8"), result);
    observations.push({ kind, checkpoint: join(f.dir, "result-application.json"), result: join(f.dir, "result.json"), registry: join(ctx.home, "state.json"), initialRun: f.job.id,
      settled: { state: settled.state, reason: settled.reason, exit: settled.last.exit, cost: settled.last.cost, session: settled.session }, unrelatedState: state.get(reviewId).state,
      correctiveRun: restarted.state.get(f.id).last.run, notifications: 1, collections: 1, continuations: 1, publicationCalls: f.calls });
  }
  const path = join(tempHome(), "publication-rejection-evidence.json"); writeJsonAtomic(path, { observations }); t.diagnostic(`publication rejection evidence: ${path}`);
});

test("NUL PR metadata blocks before artifact application and preserves verified recovery evidence", async t => {
  await assert.rejects(execFileAsync(process.execPath, ["-e", "process.exit(0)", "metadata\0private"]), { code: "ERR_INVALID_ARG_VALUE" });
  const observations = [];
  for (const phase of ["artifacts", "pushed", "verified"]) for (const field of ["title", "body"]) {
    const f = resultFixture(), checkpoint = join(f.dir, "result-application.json"), evidenceFile = join(f.dir, "verification.json");
    f.result.pr[field] += "\0private";
    if (phase === "pushed") { delete f.result.files; f.result.pushedHead = f.result.inputHead; }
    if (phase === "verified") {
      writeFileSync(join(f.entry.worktree, "a.txt"), "after");
      writeJsonAtomic(checkpoint, { phase: "verified", fingerprint: sha(JSON.stringify(f.result)), appliedHead: f.result.inputHead, paths: ["a.txt"] });
      writeJsonAtomic(evidenceFile, { head: f.result.inputHead, evidence: [{ command: "printf verified", source: "coordinator-executed", head: f.result.inputHead, exit: 0, output: "prior fixture evidence" }] });
    }
    let metadataReads = 0;
    f.ctx.git.head = f.ctx.git.trackedPaths = f.ctx.git.resultModesMatch = async () => { metadataReads++; throw new Error("must validate metadata first"); };
    const before = existsSync(evidenceFile) ? readFileSync(evidenceFile, "utf8") : null;
    await assert.rejects(reconcileExecutionResult(f.ctx, f), error => {
      assert.equal(error.code, "EXECUTION_RESULT"); assert.equal(error.publicationValidation, true);
      assert.match(error.message, new RegExp("PR " + field + " contains NUL bytes")); assert.doesNotMatch(error.message, /private/); return true;
    });
    const blocked = readJson(checkpoint);
    assert.equal(blocked.phase, "blocked"); assert.equal(blocked.reason, "result-validation");
    assert.equal(blocked.fingerprint, sha(JSON.stringify(f.result))); assert.equal(metadataReads, 0); assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), phase === "verified" ? "after" : "before");
    if (before !== null) { assert.equal(readFileSync(evidenceFile, "utf8"), before); assert.equal(blocked.appliedHead, f.result.inputHead); assert.deepEqual(blocked.paths, ["a.txt"]); }
    else assert.equal(existsSync(evidenceFile), false);
    await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
    assert.deepEqual(readJson(checkpoint), blocked); assert.deepEqual(f.calls, []);
    observations.push({ phase, field, checkpoint, evidence: before === null ? null : evidenceFile, appliedHead: blocked.appliedHead ?? null, metadataReads, publicationCalls: f.calls });
  }
  const path = join(tempHome(), "nul-publication-evidence.json"); writeJsonAtomic(path, { nativeArgumentError: "ERR_INVALID_ARG_VALUE", observations }); t.diagnostic(`NUL publication evidence: ${path}`);
});

test("collection and unavailable publication I/O remain pending and recover without another dispatch", async () => {
  for (const operation of ["collect", "paths", "modes", "head"]) {
    const f = await collectedArtifactFixture(), state = makeState(f.ctx.home), gh = { ...fakeGh(), ...f.ctx.gh }, notify = fakeNotify();
    state.put(f.id, { ...f.entry, last: { run: f.job.id, exit: null } });
    const ctx = { ...f.ctx, state, clock: f.provider.clock, config: CONFIG, git: { ...fakeGit(), ...f.ctx.git }, gh, ownLogin: "me", log: silentLog, notify, executionFor: () => f.reopen() };
    const owner = operation === "collect" ? f.provider.transport : ctx.git;
    const key = { collect: "collect", paths: "trackedPaths", modes: "resultModesMatch", head: "head" }[operation], original = owner[key];
    owner[key] = async () => { throw Object.assign(new Error("temporary I/O failure"), { code: operation === "collect" ? "EXECUTION_RESULT" : "EIO" }); };
    f.provider.observe({ state: "succeeded" }); await makeTick(ctx).tickEntry(f.id, state.get(f.id));
    assert.equal(readJson(join(f.dir, "result-application.json")), null); assert.equal(state.get(f.id).last.exit, null);
    assert.equal(state.get(f.id).state, STATES.running); assert.deepEqual(f.calls, []); assert.equal(notify.sent.length, 0);
    owner[key] = original; await makeTick(ctx).tickEntry(f.id, state.get(f.id));
    assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published"); assert.equal(state.get(f.id).last.exit, 0);
    assert.equal(f.provider.calls.filter(call => call[0] === "submit").length, 1); assert.equal(f.provider.calls.filter(call => call[0] === "continue").length, 0);
    assert.deepEqual(f.calls, ["commit", "push", "PR"]);
  }
});

test("a rejected result cannot settle until its blocked checkpoint is durable", async () => {
  const f = await collectedArtifactFixture(), state = makeState(f.ctx.home), gh = fakeGh(), notify = fakeNotify();
  f.result.files[0].afterHash = "invalid";
  state.put(f.id, { ...f.entry, last: { run: f.job.id, exit: null } });
  const ctx = { ...f.ctx, state, clock: f.provider.clock, config: CONFIG, git: { ...fakeGit(), ...f.ctx.git }, gh, ownLogin: "me", log: silentLog, notify, executionFor: () => f.reopen() };
  f.provider.observe({ state: "succeeded" }); await f.collect();
  const checkpoint = join(f.dir, "result-application.json"); mkdirSync(checkpoint);
  await makeTick(ctx).tickEntry(f.id, state.get(f.id));
  assert.equal(state.get(f.id).state, STATES.running); assert.equal(state.get(f.id).last.exit, null); assert.equal(notify.sent.length, 0);
  assert.deepEqual(f.calls, []); assert.ok(lstatSync(checkpoint).isDirectory());
  rmSync(checkpoint, { recursive: true }); await makeTick(ctx).tickEntry(f.id, state.get(f.id));
  assert.equal(readJson(checkpoint).reason, "result-validation"); assert.equal(state.get(f.id).state, STATES.needsHuman);
  assert.equal(state.get(f.id).last.exit, 0); assert.equal(f.provider.calls.filter(call => call[0] === "collect").length, 1);
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

test("verification uses a credential-free environment and removes private profiles on success and failure", async t => {
  const keys = ["GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DATABASE_URL", "CUSTOM_CREDENTIAL", "SSH_AUTH_SOCK", "NPM_CONFIG_TOKEN", "HTTP_PROXY", "NODE_OPTIONS", "ENV", "BASH_ENV"];
  const inherited = Object.fromEntries(keys.map(key => [key, process.env[key]])), observations = [];
  try {
    for (const failing of [false, true]) {
      const f = await nativeResultFixture(), invocations = [];
      for (const key of keys) process.env[key] = key === "NODE_OPTIONS" ? "--trace-warnings" : "verification-private-sentinel";
      const code = `const fs=require("node:fs"); const keys=${JSON.stringify(keys)}; if(keys.some(key=>Object.hasOwn(process.env,key))) process.exit(31); if(fs.existsSync(process.env.HOME+"/.npmrc")) process.exit(32); fs.writeFileSync(process.env.HOME+"/cache-proof","private"); console.log("credential-free"); process.exit(${failing ? 23 : 0});`;
      f.ctx.readPrd = () => `# Brief\n\n## Verify\n\n- \`node -e '${code}'\`\n`;
      f.verify = async (shell, args, options) => {
        assert.ok(options.env); for(const key of keys) assert.equal(options.env[key], undefined);
        assert.equal(options.env.PATH, process.env.PATH); assert.equal(options.env.NPM_CONFIG_USERCONFIG, "/dev/null");
        assert.equal(options.env.NPM_CONFIG_GLOBALCONFIG, "/dev/null"); assert.equal(options.env.GIT_CONFIG_NOSYSTEM, "1");
        const last = Number(options.env.GIT_CONFIG_COUNT) - 1;
        assert.equal(options.env[`GIT_CONFIG_KEY_${last}`], "credential.helper"); assert.equal(options.env[`GIT_CONFIG_VALUE_${last}`], "");
        assert.notEqual(options.env.HOME, process.env.HOME); assert.equal(statSync(options.env.HOME).mode & 0o777, 0o700);
        invocations.push({ shell, args, envKeys: Object.keys(options.env).sort(), privateHome: options.env.HOME });
        return execFileAsync(shell, args, options);
      };
      if (failing) await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
      else await reconcileExecutionResult(f.ctx, f);
      assert.equal(invocations.length, 1); assert.equal(existsSync(invocations[0].privateHome), false);
      const evidence = readJson(join(f.dir, "verification.json")), checkpoint = readJson(join(f.dir, "result-application.json"));
      assert.equal(evidence.evidence[0].exit, failing ? 23 : 0); assert.equal(evidence.evidence[0].output, "credential-free\n");
      assert.doesNotMatch(JSON.stringify(evidence), /verification-private-sentinel/);
      if (failing) await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
      else await reconcileExecutionResult(f.ctx, f);
      assert.equal(invocations.length, 1); assert.deepEqual(readJson(join(f.dir, "verification.json")), evidence);
      assert.equal(checkpoint.phase, failing ? "blocked" : "published");
      observations.push({ failing, removedPrivateHome: true, invocations, verification: join(f.dir, "verification.json"), checkpoint: join(f.dir, "result-application.json") });
      for (const key of keys) if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key];
    }
  } finally {
    for (const key of keys) if (inherited[key] === undefined) delete process.env[key]; else process.env[key] = inherited[key];
  }
  const root = tempHome(), source = { PATH: process.env.PATH, HOME: "foreign-home", XDG_CONFIG_HOME: "foreign-config", CUSTOM_CREDENTIAL: "opaque", BASH_ENV: "startup", HTTP_PROXY: "http://user:password@example.test" };
  const env = verificationEnvironment(root, source);
  assert.equal(env.HOME, root); assert.notEqual(env.XDG_CONFIG_HOME, source.XDG_CONFIG_HOME);
  assert.equal(env.CUSTOM_CREDENTIAL, undefined); assert.equal(env.BASH_ENV, undefined); assert.equal(env.HTTP_PROXY, undefined);
  const path = join(tempHome(), "verification-environment-evidence.json"); writeJsonAtomic(path, { observations }); t.diagnostic(`verification environment evidence: ${path}`);
});

function posixVerification(f, commands, startup, marker) {
  const invocations = [];
  f.ctx.readPrd = () => `# Brief\n\n## Verify\n\n${commands.map(command => `- \`${command}\``).join("\n")}\n`;
  f.verify = async (shell, args, options) => {
    assert.equal(shell, "/bin/sh");
    assert.deepEqual(args, ["-c", commands[invocations.length]]);
    const { env, ...bounds } = options;
    assert.deepEqual(bounds, { cwd: f.entry.worktree, timeout: 120_000, maxBuffer: 262_144 });
    assert.ok(env); assert.equal(env.SHELL, undefined); assert.equal(env.ENV, undefined); assert.equal(env.BASH_ENV, undefined);
    invocations.push({ shell, args, ...options }); f.calls.push("verify");
    return execFileAsync(shell, args, { ...options, env: { ...env, ENV: startup, BASH_ENV: startup, POSIX_STARTUP_MARKER: marker } });
  };
  return invocations;
}

test("approved verification uses a fixed non-login POSIX shell with missing or invalid SHELL", async t => {
  const inheritedShell = process.env.SHELL, observations = [];
  try {
    for (const shellSetting of [null, "/unavailable/operator-shell"]) {
      if (shellSetting === null) delete process.env.SHELL; else process.env.SHELL = shellSetting;
      const f = await nativeResultFixture(), startup = join(f.dir, "operator-startup.sh"), marker = join(f.dir, "startup-ran");
      writeFileSync(startup, 'printf startup > "$POSIX_STARTUP_MARKER"; exit 91\n');
      const commands = ["printf verified", `value='quoted value ; literal $'; printf '%s\\n' "$value" | tr '[:lower:]' '[:upper:]'; printf '%s' "$PWD"`];
      const invocations = posixVerification(f, commands, startup, marker);
      const done = await reconcileExecutionResult(f.ctx, f);
      assert.deepEqual(done.evidence.map(item => item.output), ["verified", `QUOTED VALUE ; LITERAL $\n${realpathSync(f.entry.worktree)}`]);
      assert.deepEqual(done.evidence.map(item => item.command), commands);
      assert.ok(done.evidence.every(item => item.exit === 0 && item.source === "coordinator-executed" && item.head === done.head));
      assert.equal(existsSync(marker), false); assert.equal(invocations.length, 2);
      assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), { modified: 0, untracked: 0 });
      assert.deepEqual(f.calls, ["commit", "verify", "verify", "push", "PR"]);
      const evidence = readJson(join(f.dir, "verification.json"));
      await reconcileExecutionResult(f.ctx, f);
      assert.equal(invocations.length, 2); assert.deepEqual(readJson(join(f.dir, "verification.json")), evidence);
      assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published");
      observations.push({ shellSetting, invocations, startupExecuted: false, verification: join(f.dir, "verification.json"), checkpoint: join(f.dir, "result-application.json") });
    }
  } finally {
    if (inheritedShell === undefined) delete process.env.SHELL; else process.env.SHELL = inheritedShell;
  }
  const path = join(tempHome(), "posix-verification-success.json"); writeJsonAtomic(path, { observations }); t.diagnostic(`POSIX verification success evidence: ${path}`);
});

test("non-login POSIX verification failures keep bounded evidence and do not replay", async t => {
  const inheritedShell = process.env.SHELL, f = await nativeResultFixture();
  const startup = join(f.dir, "operator-startup.sh"), marker = join(f.dir, "startup-ran");
  writeFileSync(startup, 'printf startup > "$POSIX_STARTUP_MARKER"; exit 91\n');
  const commands = ["printf failed-command >&2; exit 23", "printf must-not-run"], invocations = posixVerification(f, commands, startup, marker);
  try {
    delete process.env.SHELL;
    await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
    const evidence = readJson(join(f.dir, "verification.json")), checkpoint = readJson(join(f.dir, "result-application.json"));
    assert.equal(evidence.evidence.length, 1); assert.equal(evidence.evidence[0].exit, 23);
    assert.equal(evidence.evidence[0].output, "failed-command"); assert.equal(evidence.evidence[0].command, commands[0]);
    assert.equal(evidence.evidence[0].head, checkpoint.appliedHead); assert.equal(evidence.evidence[0].source, "coordinator-executed");
    assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "verification-failed");
    for (let poll = 0; poll < 3; poll++) await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
    assert.equal(invocations.length, 1); assert.equal(existsSync(marker), false); assert.deepEqual(f.calls, ["commit", "verify"]);
    assert.deepEqual(readJson(join(f.dir, "verification.json")), evidence); assert.deepEqual(readJson(join(f.dir, "result-application.json")), checkpoint);
  } finally {
    if (inheritedShell === undefined) delete process.env.SHELL; else process.env.SHELL = inheritedShell;
  }
  const path = join(tempHome(), "posix-verification-failure.json");
  writeJsonAtomic(path, { invocations, startupExecuted: false, verification: join(f.dir, "verification.json"), checkpoint: join(f.dir, "result-application.json") });
  t.diagnostic(`POSIX verification failure evidence: ${path}`);
});

test("text artifacts reject filesystem, staged and committed mode changes before content mutation", async t => {
  const observations = [];
  for (const executable of [false, true]) for (const source of ["filesystem", "index", "HEAD"]) for (const operation of ["edit", "already-present", "delete"]) {
    const f = await nativeResultFixture(), path = join(f.entry.worktree, "a.txt"), originalMode = executable ? 0o755 : 0o644;
    chmodSync(path, originalMode); await f.ctx.git.commitResult(f.entry.worktree, ["a.txt"]);
    const inputHead = await f.ctx.git.head(f.entry.worktree); f.result.inputHead = inputHead; f.entry.execution.inputHead = inputHead;
    const text = operation === "delete" ? null : operation === "already-present" ? "before" : "after";
    f.result.files[0] = { ...f.result.files[0], text, afterHash: text === null ? null : sha(text) };
    const changedMode = executable ? 0o644 : 0o755;
    if (source === "index") await execFileAsync("git", ["update-index", executable ? "--chmod=-x" : "--chmod=+x", "--", "a.txt"], { cwd: f.entry.worktree });
    else {
      chmodSync(path, changedMode);
      if (source === "HEAD") await f.ctx.git.commitResult(f.entry.worktree, ["a.txt"]);
    }
    f.calls.length = 0;
    const head = await f.ctx.git.head(f.entry.worktree), index = (await execFileAsync("git", ["ls-files", "--stage", "-z"], { cwd: f.entry.worktree })).stdout;
    const fileMode = statSync(path).mode, manifest = structuredClone(f.result);
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /artifact target mode differs/);
    assert.equal(readFileSync(path, "utf8"), "before"); assert.equal(statSync(path).mode, fileMode);
    assert.equal(await f.ctx.git.head(f.entry.worktree), head);
    assert.equal((await execFileAsync("git", ["ls-files", "--stage", "-z"], { cwd: f.entry.worktree })).stdout, index);
    assert.deepEqual(f.result, manifest); assert.deepEqual(f.calls, []);
    assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
    observations.push({ source, operation, inputMode: executable ? "100755" : "100644", inputHead, head, unchanged: true,
      filesystemMode: fileMode & 0o777, index, worktree: f.entry.worktree, resultDir: f.dir });
  }
  const path = join(tempHome(), "artifact-mode-evidence.json"); writeJsonAtomic(path, { observations }); t.diagnostic(`artifact mode evidence: ${path}`);
});

test("text artifacts preserve executable inputs, regular creations and deletion modes through native recovery", async () => {
  for (const operation of ["edit", "delete", "create"]) {
    const f = await nativeResultFixture(), path = operation === "create" ? " name\twith\nnewline.mjs" : "a.txt";
    if (operation !== "create") { chmodSync(join(f.entry.worktree, path), 0o755); await f.ctx.git.commitResult(f.entry.worktree, [path]); }
    const head = await f.ctx.git.head(f.entry.worktree); f.result.inputHead = head; f.entry.execution.inputHead = head; f.calls.length = 0;
    f.result.files = [{ path, beforeHash: operation === "create" ? null : sha("before"), afterHash: operation === "delete" ? null : sha("after"), text: operation === "delete" ? null : "after" }];
    const commit = f.ctx.git.commitResult; let lost = true;
    f.ctx.git.commitResult = async (...args) => { await commit(...args); if (lost) { lost = false; throw new Error("lost artifact commit reply"); } };
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /lost artifact commit reply/);
    const appliedHead = await f.ctx.git.head(f.entry.worktree);
    await reconcileExecutionResult(f.ctx, f); await reconcileExecutionResult(f.ctx, f);
    assert.equal(await f.ctx.git.head(f.entry.worktree), appliedHead);
    if (operation === "delete") assert.equal(existsSync(join(f.entry.worktree, path)), false);
    else {
      assert.equal(readFileSync(join(f.entry.worktree, path), "utf8"), "after");
      assert.equal(statSync(join(f.entry.worktree, path)).mode & 0o100, operation === "edit" ? 0o100 : 0);
    }
    assert.deepEqual(await f.ctx.git.dirty(f.entry.worktree, { strict: true }), { modified: 0, untracked: 0 });
    assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published");
    assert.deepEqual(f.calls, ["commit", "commit", "verify", "push", "PR"]);
  }
});

test("new and verified text artifacts reject unrepresented modes without verification or publication replay", async () => {
  const created = await nativeResultFixture(), path = "new.txt";
  writeFileSync(join(created.entry.worktree, path), "after"); chmodSync(join(created.entry.worktree, path), 0o755);
  created.result.files = [{ path, beforeHash: null, afterHash: sha("after"), text: "after" }];
  await assert.rejects(reconcileExecutionResult(created.ctx, created), /artifact target mode differs/);
  assert.deepEqual(created.calls, []); assert.equal(statSync(join(created.entry.worktree, path)).mode & 0o100, 0o100);
  const f = await nativeResultFixture(); let offline = true;
  f.ctx.git.pushResult = async () => { f.calls.push("push"); if (offline) throw new Error("publication unavailable"); };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /publication unavailable/);
  assert.equal(readJson(join(f.dir, "result-application.json")).phase, "verified");
  chmodSync(join(f.entry.worktree, "a.txt"), 0o755); f.calls.length = 0; offline = false;
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /artifact target mode differs/);
  assert.deepEqual(f.calls, []); assert.equal(readJson(join(f.dir, "verification.json")).evidence.length, 1);
});

test("artifact mode metadata fails closed on unavailable, malformed, truncated and oversized Git reads", async () => {
  for (const resultModesMatch of [undefined, async () => null, async () => { throw new Error("Git mode metadata unavailable"); }]) {
    const f = resultFixture(); f.ctx.git.resultModesMatch = resultModesMatch;
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /artifact (mode metadata unavailable|target mode differs)/);
    assert.deepEqual(f.calls, []); assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "before");
  }
  for (const stdout of ["100644 partial", "invalid\0", "x".repeat(GIT_PATH_LIMITS.bytes + 1), null]) {
    const f = resultFixture(), calls = [];
    const git = makeGit({ config: CONFIG, exec: async (cmd, args, options) => {
      assert.equal(cmd, "git"); assert.equal(options.timeout, GIT_PATH_LIMITS.timeoutMs); assert.equal(options.maxBuffer, GIT_PATH_LIMITS.bytes);
      calls.push(args); return { stdout };
    } });
    await assert.rejects(git.resultModesMatch(f.entry.worktree, f.result.inputHead, ["a.txt"]), /Git (path|mode) metadata/);
    assert.equal(calls.length, 3);
  }
});

for (const mutation of ["tracked", "staged", "untracked"]) test(`verification ${mutation} writes block publication at the unchanged native Git head`, async () => {
  const f = await nativeResultFixture();
  const verify = f.verify; let privateHome;
  f.verify = (cmd, args, options) => { privateHome = options.env.HOME; return verify(cmd, args, options); };
  const command = mutation === "untracked" ? "printf created > generated.txt" : `printf dirty > b.txt${mutation === "staged" ? " && git add -- b.txt" : ""}`;
  f.ctx.readPrd = () => `# Brief\n\n## Verify\n\n- \`${command}\`\n- \`printf must-not-run\`\n`;
  await assert.rejects(reconcileExecutionResult(f.ctx, f), { code: "EXECUTION_RESULT_BLOCKED" });
  const checkpoint = readJson(join(f.dir, "result-application.json")), evidence = readJson(join(f.dir, "verification.json"));
  assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "verification-dirty");
  assert.ok(privateHome); assert.equal(existsSync(privateHome), false);
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
  const f = resultFixture(); let stopped = false, privateHome;
  f.ctx.state = { get: () => ({ ...f.entry, dispatch_stopped: stopped ? "cancellation-requested" : null }) };
  f.verify = async (cmd, args, options) => { f.calls.push("verify"); privateHome = options.env.HOME; stopped = true; return { stdout: "verified" }; };
  await assert.rejects(reconcileExecutionResult(f.ctx, f), /concurrent stop/);
  assert.deepEqual(f.calls, ["commit", "verify"]); assert.equal(readJson(join(f.dir, "verification.json")).evidence[0].exit, 0);
  assert.ok(privateHome); assert.equal(existsSync(privateHome), false);
});

function publicationControlContext(f) {
  const state = makeState(f.ctx.home); state.put(f.id, { ...f.entry, last: { run: f.job.id, exit: 0 } });
  Object.assign(f.ctx, { state, clock: f.provider.clock, log: silentLog });
  return state;
}

test("publication and cancellation have one ordering across push, PR writes and another process", async t => {
  const evidence = [];
  for (const stage of ["before", "push", "PR", "process"]) {
    const f = await collectedArtifactFixture(), result = await f.collect(), state = publicationControlContext(f);
    const request = () => requestControl(f.ctx, { handle: f.id, action: "cancel" });
    let attempts = 0;
    const duringPublication = async () => {
      attempts++; const registry = readFileSync(state.file, "utf8"), execution = readFileSync(join(f.service.root, "execution.json"), "utf8");
      if (stage === "process") {
        const code = `import {makeState} from ${JSON.stringify(new URL("../lib/state.mjs", import.meta.url).href)};
import {makeExecution} from ${JSON.stringify(new URL("../lib/execution.mjs", import.meta.url).href)};
import {requestControl} from ${JSON.stringify(new URL("../lib/control.mjs", import.meta.url).href)};
const ctx={home:${JSON.stringify(f.ctx.home)},state:makeState(${JSON.stringify(f.ctx.home)}),clock:Date,log:{info(){}},
executionFor:()=>makeExecution({root:${JSON.stringify(f.service.root)},taskId:${JSON.stringify(f.id)},provider:"openai-agents",account:"test",transport:{}})};
try{requestControl(ctx,{handle:${JSON.stringify(f.id)},action:"cancel"});process.stdout.write(JSON.stringify({queued:true}));}
catch(error){process.stdout.write(JSON.stringify({code:error.code,message:error.message}));}`;
        const child = JSON.parse((await execFileAsync(process.execPath, ["--input-type=module", "-e", code], { timeout: 5000, maxBuffer: 4096 })).stdout);
        assert.equal(child.code, "EXECUTION_PUBLICATION_BUSY"); assert.match(child.message, /retry.*cancel/i);
      } else assert.throws(request, error => error.code === "EXECUTION_PUBLICATION_BUSY" && /retry.*cancel/i.test(error.message));
      assert.equal(readFileSync(state.file, "utf8"), registry); assert.equal(readFileSync(join(f.service.root, "execution.json"), "utf8"), execution);
      await assert.rejects(f.reopen().cancel(), /already running|lock recovery/);
      await assert.rejects(f.reopen().continue({ ...input, operationId: "overlap", sessionId: f.job.execution.sessionId }), /already running|lock recovery/);
      await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result }), { code: "EXECUTION_PUBLICATION_BUSY" });
      // Entry-scoped exclusion leaves another task's operator control available.
      const otherId = "acme/widget/unrelated-publication", otherRoot = join(f.ctx.home, "runs", idSlug(otherId));
      state.put(otherId, { ...newEntry({ repo: "acme/widget", harness: "openai-agents", nowIso: T0, state: STATES.running }) });
      const ctx = { ...f.ctx, executionFor: id => id === f.id ? f.reopen() : makeExecution({ root: otherRoot, taskId: otherId, provider: "openai-agents", account: "test", transport: f.provider.transport, capabilities: f.provider.capabilities }) };
      requestControl(ctx, { handle: otherId, action: "cancel" });
      assert.equal(state.get(otherId).dispatch_stopped, "cancellation-requested");
      assert.equal(state.get(f.id).dispatch_stopped, undefined); assert.equal(f.provider.calls.filter(c => c[0] === "continue").length, 0);
    };
    f.verify = async () => { f.calls.push("verify"); if (stage === "before") request(); return { stdout: "verified" }; };
    f.ctx.git.pushResult = async () => { f.calls.push("push"); if (["push", "process"].includes(stage)) await duringPublication(); };
    f.ctx.gh.publishResultPr = async () => { f.calls.push("PR"); if (stage === "PR") await duringPublication(); return { number: 1, url: "https://example.test/pr/1" }; };
    if (stage === "before") {
      await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result }), /concurrent stop/);
      assert.deepEqual(f.calls, ["commit", "verify"]); assert.equal(state.get(f.id).dispatch_stopped, "cancellation-requested");
    } else {
      const published = await reconcileExecutionResult(f.ctx, { ...f, result });
      assert.deepEqual(f.calls, ["commit", "verify", "push", "PR"]); assert.equal(attempts, 1);
      assert.equal(readJson(join(f.dir, "result-application.json")).phase, "published");
      state.update(f.id, { pr: published.pr.number, url: published.pr.url });
      request(); await cancelControl(f.ctx, f.id);
      assert.equal(state.get(f.id).reason, "cancelled"); assert.equal(f.reopen().current().execution.providerState, "succeeded");
      assert.equal(f.provider.calls.filter(c => c[0] === "cancel").length, 0);
    }
    for (const file of ["publication.lock", "execution.lock"]) assert.equal(existsSync(join(f.service.root, file)), false);
    evidence.push({ stage, attempts, publicationCalls: f.calls, reason: state.get(f.id).reason, stopped: state.get(f.id).dispatch_stopped,
      files: { registry: state.file, execution: join(f.service.root, "execution.json"), application: join(f.dir, "result-application.json"), verification: join(f.dir, "verification.json") } });
  }
  const report = join(tempHome(), "publication-order-evidence.json"); writeJsonAtomic(report, { cases: evidence });
  t.diagnostic(`publication order evidence: ${report}`);
});

test("publication exclusions release after I/O failures and still allow cancellation during inspection", async t => {
  const evidence = [];
  for (const failure of ["push", "PR", "checkpoint", "execution-lock"]) {
    const f = await collectedArtifactFixture(), result = await f.collect(), state = publicationControlContext(f);
    const checkpoint = join(f.dir, "result-application.json"); let previous;
    f.ctx.git.pushResult = async () => { f.calls.push("push"); if (failure === "push") throw new Error("push acknowledgement lost"); };
    f.ctx.gh.publishResultPr = async () => {
      f.calls.push("PR");
      if (failure === "PR") throw new Error("PR acknowledgement lost");
      if (failure === "checkpoint") { previous = readFileSync(checkpoint, "utf8"); rmSync(checkpoint); mkdirSync(checkpoint); }
      return { number: 1, url: "https://example.test/pr/1" };
    };
    const held = failure === "execution-lock" ? acquireProcessLock(join(f.service.root, "execution.lock"), "execution") : null;
    try { await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result })); }
    finally { held?.release(); }
    if (failure === "checkpoint") { rmSync(checkpoint, { recursive: true }); writeFileSync(checkpoint, previous); }
    for (const file of ["publication.lock", "execution.lock"]) assert.equal(existsSync(join(f.service.root, file)), false);
    const calls = [...f.calls]; requestControl(f.ctx, { handle: f.id, action: "cancel" });
    const registry = readFileSync(state.file, "utf8");
    assert.throws(() => requestControl(f.ctx, { handle: f.id, action: "cancel" }), /already queued/);
    assert.equal(readFileSync(state.file, "utf8"), registry); assert.equal(existsSync(join(f.service.root, "publication.lock")), false);
    await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result }), /concurrent stop/);
    assert.deepEqual(f.calls, calls); assert.equal(state.get(f.id).dispatch_stopped, "cancellation-requested");
    evidence.push({ failure, publicationCalls: calls, checkpoint: readJson(checkpoint).phase, locksReleased: true,
      files: { registry: state.file, application: checkpoint, execution: join(f.service.root, "execution.json") } });
  }
  // Progress owns execution.lock, but a stop request must still persist promptly.
  const f = await collectedArtifactFixture(), state = publicationControlContext(f), inspect = f.provider.transport.inspect;
  f.provider.transport.inspect = async req => { requestControl(f.ctx, { handle: f.id, action: "cancel" }); return inspect(req); };
  await f.service.reconcile({ force: true });
  assert.equal(state.get(f.id).dispatch_stopped, "cancellation-requested");
  assert.equal(state.get(f.id).control.status, "queued"); assert.equal(f.provider.calls.filter(c => c[0] === "submit").length, 1);
  assert.equal(existsSync(join(f.service.root, "publication.lock")), false);
  const report = join(tempHome(), "publication-cleanup-evidence.json"); writeJsonAtomic(report, { cases: evidence, inspectionCancellationQueued: true });
  t.diagnostic(`publication cleanup evidence: ${report}`);
});

test("publication refuses private cancellation and superseding roots without relying on registry fences", async t => {
  const evidence = [];
  for (const change of ["cancel", "continue"]) {
    const f = await collectedArtifactFixture(), result = await f.collect(), state = publicationControlContext(f);
    const bytes = readFileSync(join(f.dir, "result.json"), "utf8");
    f.verify = async () => {
      f.calls.push("verify");
      if (change === "cancel") await f.reopen().cancel();
      else await f.reopen().continue({ ...input, operationId: "replacement", sessionId: f.job.execution.sessionId });
      return { stdout: "verified" };
    };
    await assert.rejects(reconcileExecutionResult(f.ctx, { ...f, result }), change === "cancel" ? /concurrent stop/ : /publication root changed/);
    assert.deepEqual(f.calls, ["commit", "verify"]); assert.equal(state.get(f.id).dispatch_stopped, undefined);
    assert.equal(readFileSync(join(f.dir, "result.json"), "utf8"), bytes);
    for (const file of ["publication.lock", "execution.lock"]) assert.equal(existsSync(join(f.service.root, file)), false);
    evidence.push({ change, publicationCalls: f.calls, runBefore: f.job.id, runAfter: f.reopen().current().id, privateStop: f.reopen().state().stopped,
      files: { registry: state.file, execution: join(f.service.root, "execution.json"), result: join(f.dir, "result.json"), verification: join(f.dir, "verification.json") } });
  }
  const report = join(tempHome(), "publication-root-evidence.json"); writeJsonAtomic(report, { cases: evidence });
  t.diagnostic(`publication root evidence: ${report}`);
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
  const root = tempHome(), clock = makeClock(), runner = makeRunner(root, { clock });
  const service = makeExecution({ root, taskId: "local-cancel", provider: "codex", runner, clock });
  const job = await service.start("fixture", process.execPath, ["-e", 'process.stdout.write("{\\"type\\":\\"turn.completed\\"}\\n");setInterval(()=>{},1000)'], { cwd: tempHome(), execution: { operationId: "cancel" } });
  assert.equal(runner.read(job.id).exit, null);
  await service.cancel(); await runner.waitForKill(job.id); await service.reconcile();
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

test("remote terminal cancellation controls finish without claiming a provider stop and preserve collected outcomes", async t => {
  const evidence = [];
  for (const provider of ["openai-agents", "codex-cloud"]) for (const ok of [true, false]) for (const timing of ["collected", "pending"]) {
    const f = remote(provider), job = await f.service.submit(input), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
    f.transport.collect = async req => ({ ...req, signal: undefined, outcome: { finished: true, ok, cost: 0.4, lastMessage: "owned terminal result" } });
    if (timing === "collected") { f.observe({ state: ok ? "succeeded" : "failed", costUsd: 0.4 }); await f.service.reconcile({ force: true }); await f.service.collect(); }
    const before = f.service.state().current, resultFile = join(f.root, job.id, "result.json"), cached = timing === "collected" ? readFileSync(resultFile, "utf8") : null;
    state.put(id, { ...newEntry({ repo: "acme/widget", harness: provider, session: job.execution.sessionId, branch: "work/remote", state: STATES.needsHuman, nowIso: T0 }), last: { run: job.id, exit: before.exit, cost: before.execution.costUsd } });
    const ctx = { home, state, config: CONFIG, clock: f.clock, gh: fakeGh(), git: fakeGit(), log: silentLog, notify: fakeNotify(), ownLogin: "me", readPrd: () => null, executionFor: () => f.reopen() };
    if (timing === "pending") f.transport.cancel = async req => { f.calls.push(["cancel", req]); return { confirmed: false }; };
    requestControl(ctx, { handle: id, action: "cancel" }); await cancelControl(ctx, id);
    if (timing === "pending") {
      assert.equal(state.get(id).reason, "cancellation-requested");
      f.observe({ state: ok ? "succeeded" : "failed", costUsd: 0.4 });
    } else {
      assert.equal(state.get(id).reason, "cancelled");
      assert.match(state.get(id).control.message, /already completed/);
    }
    const reopened = { ...ctx, state: makeState(home) };
    await makeTick(reopened).tickEntry(id, reopened.state.get(id));
    let entry = reopened.state.get(id), current = f.reopen().current();
    assert.equal(entry.reason, "cancelled"); assert.match(entry.control.message, /already completed/);
    assert.doesNotMatch(entry.control.message, /unconfirmed|may continue|confirmed/i);
    assert.equal(entry.control.status, "applied"); assert.equal(entry.dispatch_stopped, "cancellation-requested");
    assert.equal(current.execution.providerState, ok ? "succeeded" : "failed");
    assert.equal(current.execution.cancellation.status, "terminal"); assert.equal(current.execution.quarantined, true);
    assert.equal(current.execution.sessionId, job.execution.sessionId); assert.equal(current.execution.costUsd, 0.4);
    if (timing === "collected") {
      assert.equal(current.exit, before.exit); assert.equal(current.endedAt, before.endedAt);
      assert.equal(entry.last.exit, before.exit); assert.equal(readFileSync(resultFile, "utf8"), cached);
    }
    assert.deepEqual(await f.reopen().cancel(), { confirmed: false, terminal: true });
    const calls = f.calls.length;
    // Repair an applied pre-fix control after a restart, using exact stopped-root ownership.
    reopened.state.update(id, { reason: "cancellation-requested", control: { ...entry.control, message: "Remote execution may continue." } });
    await makeTick(reopened).tickEntry(id, reopened.state.get(id));
    entry = reopened.state.get(id); current = f.reopen().current();
    assert.equal(entry.reason, "cancelled"); assert.match(entry.control.message, /already completed/); assert.equal(f.calls.length, calls);
    assert.equal(f.calls.filter(c => c[0] === "cancel").length, timing === "pending" ? 1 : 0);
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_QUARANTINED" });
    await assert.rejects(f.reopen().continue({ ...input, operationId: "after-stop", sessionId: job.execution.sessionId }), { code: "EXECUTION_STOPPED" });
    evidence.push({ provider, ok, timing, runId: job.id, reason: entry.reason, message: entry.control.message, exit: current.exit, state: current.execution.providerState, cancellation: current.execution.cancellation.status, session: current.execution.sessionId, cost: current.execution.costUsd, stops: f.calls.filter(c => c[0] === "cancel").length, files: { execution: join(f.root, "execution.json"), registry: state.file, ...(cached ? { result: resultFile } : {}) } });
  }
  const report = join(tempHome(), "terminal-control-evidence.json"); writeJsonAtomic(report, { kind: "Deterministic remote terminal controls and restart fixtures", cases: evidence });
  t.diagnostic(`terminal control evidence: ${report}`);
});

test("terminal control reconciliation ignores an unrelated completed root", async () => {
  const f = remote(), job = await f.service.submit(input), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
  f.observe({ state: "succeeded" }); await f.service.reconcile({ force: true }); await f.service.collect(); await f.service.cancel();
  state.put(id, { ...newEntry({ repo: "acme/widget", harness: "openai-agents", state: STATES.needsHuman, nowIso: T0 }), reason: "cancellation-requested", dispatch_stopped: "cancellation-requested", last: { run: job.id, exit: 0 }, control: { id: "foreign-stop", action: "cancel", status: "applied", stop_run: "another-root", message: "Awaiting its exact root." } });
  const ctx = { home, state, config: CONFIG, clock: f.clock, gh: fakeGh(), git: fakeGit(), log: silentLog, notify: fakeNotify(), ownLogin: "me", readPrd: () => null, executionFor: () => f.reopen() };
  await makeTick(ctx).tickEntry(id, state.get(id));
  assert.equal(state.get(id).reason, "cancellation-requested"); assert.equal(state.get(id).control.message, "Awaiting its exact root.");
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
  assert.deepEqual(await f.service.cancel(), { confirmed: false, terminal: true });
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
  assert.equal(f.reopen().current().execution.terminalState, null);
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
  cached.turnId = "turn-1"; writeJsonAtomic(join(f.service.dirOf(job.id), "result.json"), cached);
  await assert.rejects(f.reopen().collect(), /root turn has not authoritatively completed/);
  assert.equal(f.service.current().running, true);
  f.observe({ state: "succeeded" }); await f.reopen().reconcile({ force: true });
  await f.reopen().collect(); assert.equal(f.service.current().running, false);
  assert.equal(f.calls.filter(c => c[0] === "collect").length, 1); // Recovery replays the qualified cache.
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

for (const provider of ["openai-agents", "codex-cloud"]) {
  test(`${provider} fixture: failed roots retrieve redacted diagnostics and replay durable result bookkeeping`, async () => {
    const f = remote(provider), submit = f.transport.submit;
    f.transport.submit = async req => { const accepted = await submit(req); f.observe({ sessionId: null }); return { ...accepted, sessionId: null }; };
    const job = await f.service.submit(input);
    f.observe({ state: "failed" }); await f.service.reconcile({ force: true });
    const before = f.service.state(), ex = f.service.current().execution;
    assert.equal(ex.providerState, "retrieving-results"); assert.equal(ex.terminalState, "failed"); assert.equal(ex.collected, false);
    assert.equal(f.service.current().running, true); assert.equal(f.service.current().exit, null);
    await assert.rejects(f.reopen().continue({ ...input, operationId: "premature", sessionId: "session-1" }), { code: "BUSY" });
    f.transport.collect = async req => { f.calls.push(["collect", req]); return { ...req, signal: undefined, sessionId: "recovered-session",
      usage: { inputTokens: 17, api_key: "secret-usage" }, outcome: { finished: true, ok: false, cost: 0.25,
        error: "provider failed: Bearer secret-error", denials: ["tool refused token=secret-denial"], lastMessage: "authentication failed" } }; };
    const result = await f.reopen().collect();
    assert.equal(result.outcome.error, "provider failed: Bearer [redacted]");
    assert.deepEqual(result.outcome.denials, ["tool refused token=[redacted]"]);
    assert.deepEqual(result.usage, { inputTokens: 17, api_key: "[redacted]" });
    assert.equal(f.service.current().execution.providerState, "failed"); assert.equal(f.service.current().running, false);
    assert.equal(f.service.outcome(job.id).cost, 0.25); assert.equal(f.service.sessionFrom(job.id), "recovered-session");
    assert.equal(f.service.current().execution.costUsd, 0.25); assert.equal(f.service.current().exit, 1);
    // Crash after the private result write but before boundary acknowledgement.
    writeJsonAtomic(join(f.root, "execution.json"), before); f.clock.advance(17);
    const replay = await f.reopen().collect(); assert.deepEqual(replay, JSON.parse(JSON.stringify(result)));
    assert.equal(f.service.current().execution.sessionId, "recovered-session"); assert.equal(f.service.current().execution.costUsd, 0.25);
    assert.equal(f.service.current().endedAt, result.collectedAt); assert.equal(f.service.state().allowance.chargedUsd, 0.25);
    rmSync(join(f.service.dirOf(job.id), "job.log"), { force: true });
    assert.equal((await f.reopen().collect()).outcome.lastMessage, "authentication failed");
    await f.reopen().reconcile({ force: true });
    assert.equal(f.calls.filter(c => c[0] === "collect").length, 1); assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    assert.equal(f.calls.filter(c => c[0] === "continue").length, 0);
  });
  test(`${provider} fixture: failed roots with missing or foreign results stay live across restart`, async () => {
    const f = remote(provider), job = await f.service.submit(input);
    f.observe({ state: "failed" }); await f.service.reconcile({ force: true });
    const collect = f.transport.collect;
    f.transport.collect = async () => null;
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_RESULT" });
    assert.equal(f.reopen().current().running, true); assert.equal(f.service.current().execution.collected, false);
    f.transport.collect = async req => ({ ...await collect(req), turnId: "subagent-turn", outcome: { finished: true, ok: false, cost: null } });
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_RESULT" });
    assert.equal(f.service.result(job.id), null);
    f.transport.collect = async req => ({ ...await collect(req), outcome: { finished: true, ok: false, cost: null, error: "saved failure", denials: [] } });
    await f.reopen().collect();
    assert.equal(f.service.current().running, false); assert.equal(f.service.current().execution.providerState, "failed");
    assert.equal(f.service.current().execution.costUsd, null); assert.equal(f.service.outcome(job.id).cost, null);
    assert.equal(f.service.state().allowance.chargedUsd, 0.1);
  });
}

for (const provider of ["openai-agents", "codex-cloud"]) {
  test(`${provider} fixture: contradictory terminal results stay unresolved through cache replay, polling and restart`, async t => {
    for (const terminalState of ["succeeded", "failed"]) for (const cached of [false, true]) {
      const f = remote(provider), job = await f.service.submit(input);
      f.observe({ state: terminalState, costUsd: 0.25 }); await f.service.reconcile({ force: true });
      const path = join(f.service.dirOf(job.id), "result.json"), pending = f.service.state();
      const result = { version: 1, taskId: "acme/widget/remote", runId: job.id, providerJobId: job.execution.providerJobId,
        turnId: job.execution.turnId, sessionId: job.execution.sessionId, inputHead: input.inputHead, collectedAt: f.clock.now(),
        outcome: { finished: true, ok: terminalState !== "succeeded", cost: 0.9, denials: [] },
        files: [{ path: "a.txt", beforeHash: sha("before"), afterHash: sha("after"), text: "after" }] };
      f.transport.collect = async () => { f.calls.push(["collect"]); return result; };
      if (cached) writeJsonAtomic(path, result);
      const cacheBytes = cached ? readFileSync(path, "utf8") : null;
      await assert.rejects(f.reopen().collect(), error => error.code === "EXECUTION_RESULT" && /contradicts the authoritative terminal root/.test(error.message));
      assert.deepEqual(f.service.state(), pending);
      assert.equal(f.reopen().current().execution.providerState, "retrieving-results");
      assert.equal(f.reopen().current().execution.terminalState, terminalState);
      assert.equal(f.reopen().current().execution.collected, false);
      assert.equal(f.reopen().current().running, true); assert.equal(f.reopen().current().exit, null);
      assert.equal(f.service.state().allowance.chargedUsd, 0.25);
      assert.equal(cached ? readFileSync(path, "utf8") : f.service.result(job.id), cacheBytes);
      await assert.rejects(f.reopen().continue({ ...input, operationId: "premature-correction", sessionId: job.execution.sessionId }), { code: "BUSY" });

      const home = tempHome(), state = makeState(home), id = "acme/widget/remote", gh = fakeGh(), gitCalls = [];
      const git = Object.fromEntries(Object.entries(fakeGit()).map(([name, method]) => [name, (...args) => { gitCalls.push(name); return method(...args); }]));
      const entry = newEntry({ repo: "acme/widget", harness: provider, branch: "work/remote", pr: 1, state: STATES.fixing, nowIso: T0 });
      state.put(id, { ...entry, last: { run: job.id, exit: null } });
      const ctx = { home, state, gh, git, config: CONFIG, clock: f.clock, ownLogin: "me", log: silentLog, notify: fakeNotify(), executionFor: () => f.reopen(), readPrd: () => null };
      const before = state.get(id);
      await makeTick(ctx).tickEntry(id, before);
      await makeTick(ctx).tickEntry(id, state.get(id));
      assert.deepEqual(state.get(id), before); assert.deepEqual(gh.calls, []); assert.deepEqual(gitCalls, []);
      assert.equal(readJson(join(f.service.dirOf(job.id), "result-application.json")), null);
      assert.equal(cached ? readFileSync(path, "utf8") : f.service.result(job.id), cacheBytes);
      assert.equal(f.calls.filter(c => c[0] === "submit").length, 1); assert.equal(f.calls.filter(c => c[0] === "continue").length, 0);

      // A fresh inspection cannot make a contradictory cached outcome agree by
      // replacing the retained authoritative root state or journaling its page.
      f.clock.advance(1); f.observe({ state: terminalState === "failed" ? "succeeded" : "failed", observedAt: f.clock.now(), events: [{ eventId: "contradiction", data: "must not enter history" }] });
      await f.reopen().reconcile({ force: true });
      assert.equal(f.service.current().execution.providerState, "status-unknown");
      assert.equal(f.service.current().execution.terminalState, terminalState);
      assert.equal(f.service.current().execution.recoveryAction, "EXECUTION_PROTOCOL");
      assert.equal(existsSync(join(f.service.dirOf(job.id), "events.jsonl")), false);
      t.diagnostic(`Terminal outcome fixture evidence: ${JSON.stringify({ provider, terminalState, cached, statePath: join(f.root, "execution.json"), jobPath: join(f.service.dirOf(job.id), "job.json"), resultPath: path, registryPath: join(home, "state.json"), rejectedOutcome: result.outcome.ok, pending, publicationCalls: [...gh.calls, ...gitCalls], cachePreserved: true })}`);

      f.clock.advance(1); f.observe({ state: terminalState, observedAt: f.clock.now(), events: [] });
      await f.reopen().reconcile({ force: true });
      result.outcome = { finished: true, ok: terminalState === "succeeded", cost: null, denials: [], ...(terminalState === "failed" ? { error: "owned failure" } : {}) };
      if (cached) writeJsonAtomic(path, result); // Explicit correction of the rejected private cache.
      await f.reopen().collect();
      assert.equal(f.reopen().current().execution.providerState, terminalState);
      assert.equal(f.reopen().current().exit, terminalState === "succeeded" ? 0 : 1);
      assert.equal(f.service.current().execution.costUsd, 0.25);
      const calls = f.calls.length; await f.reopen().collect(); assert.equal(f.calls.length, calls);
    }
  });
}

test("pre-fix contradictory collected outcomes re-enter retrieval without trusting the cache or redispatching", async () => {
  for (const terminalState of ["succeeded", "failed"]) for (const cached of [true, false]) {
    const f = remote(), job = await f.service.submit(input);
    f.observe({ state: terminalState }); await f.service.reconcile({ force: true });
    const raw = f.service.state(), providerState = terminalState === "succeeded" ? "failed" : "succeeded";
    Object.assign(raw.current.execution, { providerState, collected: true }); raw.current.exit = providerState === "succeeded" ? 0 : 1; raw.current.endedAt = f.clock.now();
    writeJsonAtomic(join(f.root, "execution.json"), raw);
    const path = join(f.service.dirOf(job.id), "result.json"), result = { taskId: raw.taskId, runId: job.id,
      providerJobId: job.execution.providerJobId, turnId: job.execution.turnId, inputHead: input.inputHead,
      outcome: { finished: true, ok: providerState === "succeeded", cost: null } };
    f.transport.collect = async () => { f.calls.push(["collect"]); return result; };
    if (cached) writeJsonAtomic(path, result);
    const cache = cached ? readFileSync(path, "utf8") : null;
    assert.equal(f.reopen().current().execution.providerState, "retrieving-results");
    assert.equal(f.reopen().current().execution.collected, false); assert.equal(f.reopen().current().running, true);
    assert.equal(f.reopen().current().execution.terminalState, terminalState);
    assert.equal(f.reopen().current().exit, null); assert.equal(f.reopen().current().endedAt, null);
    await assert.rejects(f.reopen().collect(), /contradicts the authoritative terminal root/);
    await assert.rejects(f.reopen().submit({ ...input, operationId: "replacement" }), { code: "BUSY" });
    assert.equal(cached ? readFileSync(path, "utf8") : f.service.result(job.id), cache); assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
    assert.equal(f.calls.filter(c => c[0] === "collect").length, cached ? 0 : 1);
  }
});

test("shared publication rejects terminal outcome contradictions before verification or file and GitHub mutation", async () => {
  for (const terminalState of ["failed", "succeeded"]) for (const legacy of [false, true]) {
    const f = resultFixture();
    Object.assign(f.entry.execution, legacy ? { providerState: terminalState } : { terminalState, providerState: "retrieving-results" });
    f.result.outcome = { finished: true, ok: terminalState !== "succeeded" };
    await assert.rejects(reconcileExecutionResult(f.ctx, f), /contradicts the authoritative terminal root/);
    assert.deepEqual(f.calls, []); assert.equal(readFileSync(join(f.entry.worktree, "a.txt"), "utf8"), "before");
    assert.equal(readJson(join(f.dir, "result-application.json")).reason, "result-validation");
  }
});

test("cancellation after a contradictory terminal inspection quarantines the known completed root without a stop call", async () => {
  for (const terminalState of ["succeeded", "failed"]) {
    const f = remote(); await f.service.submit(input);
    f.observe({ state: terminalState }); await f.service.reconcile({ force: true });
    f.observe({ state: terminalState === "succeeded" ? "failed" : "succeeded" }); await f.service.reconcile({ force: true });
    assert.equal(f.service.current().execution.providerState, "status-unknown");
    assert.deepEqual(await f.reopen().cancel(), { confirmed: false, terminal: true });
    assert.equal(f.service.current().execution.providerState, terminalState);
    assert.equal(f.service.current().execution.quarantined, true);
    assert.equal(f.service.current().execution.cancellation.status, "terminal");
    assert.equal(f.calls.some(c => c[0] === "cancel"), false);
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_QUARANTINED" });
  }
});

test("older prematurely collected failures re-enter result retrieval without another dispatch", async () => {
  const f = remote(), job = await f.service.submit(input), raw = f.service.state();
  Object.assign(raw.current.execution, { providerState: "failed", collected: true }); raw.current.exit = 1; raw.current.endedAt = f.clock.now();
  writeJsonAtomic(join(f.root, "execution.json"), raw);
  assert.equal(f.reopen().current().execution.providerState, "retrieving-results");
  assert.equal(f.reopen().current().execution.terminalState, "failed"); assert.equal(f.reopen().current().exit, null);
  assert.equal(f.reopen().current().endedAt, null);
  await assert.rejects(f.reopen().submit({ ...input, operationId: "replacement" }), { code: "BUSY" });
  const collect = f.transport.collect;
  f.transport.collect = async req => ({ ...await collect(req), outcome: { finished: true, ok: false, cost: null, error: "recovered failure" } });
  await f.reopen().collect(); assert.equal(f.service.outcome(job.id).error, "recovered failure");
  assert.equal(f.calls.filter(c => c[0] === "submit").length, 1);
});

test("a stop during failed result retrieval quarantines the completed root without a cancellation call", async () => {
  const f = remote(); await f.service.submit(input); f.observe({ state: "failed" }); await f.service.reconcile({ force: true });
  assert.deepEqual(await f.service.cancel(), { confirmed: false, terminal: true });
  assert.equal(f.service.current().execution.providerState, "failed"); assert.equal(f.service.current().execution.quarantined, true);
  assert.equal(f.service.current().execution.cancellation.status, "terminal");
  assert.equal(f.calls.some(c => c[0] === "cancel"), false);
  await assert.rejects(f.reopen().collect(), { code: "EXECUTION_QUARANTINED" });
});

test("failed collected artifacts settle through the canonical error lane without publication or replay", async () => {
  const f = remote(), job = await f.service.submit(input), home = tempHome(), state = makeState(home), id = "acme/widget/remote";
  const gh = fakeGh(), entry = newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", pr: 1, state: STATES.fixing, nowIso: T0 });
  state.put(id, { ...entry, cursor: { ...entry.cursor, fixed_sha: gh.data.pr.headRefOid }, last: { run: job.id, exit: null } });
  f.transport.collect = async req => { f.calls.push(["collect", req]); return { ...req, signal: undefined,
    files: [{ path: "../never-apply", text: "private failed artifact" }], outcome: { finished: true, ok: false, cost: 0.2, error: "provider failed", denials: ["restricted tool refused"] } }; };
  f.observe({ state: "failed" });
  const ctx = { home, config: CONFIG, clock: f.clock, state, gh, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), readPrd: () => null, executionFor: () => f.reopen() };
  await makeTick(ctx).tickEntry(id, state.get(id));
  const failed = state.get(id); assert.equal(failed.state, STATES.needsHuman); assert.equal(failed.reason, "harness-error");
  assert.equal(failed.last.exit, 1); assert.equal(failed.last.cost, 0.2); assert.equal(failed.last.error, "provider failed");
  assert.deepEqual(failed.last.denials, ["restricted tool refused"]); assert.equal(failed.session, "session-1");
  assert.equal(failed.execution.providerState, "failed");
  await makeTick(ctx).tickEntry(id, state.get(id));
  assert.equal(f.calls.filter(c => c[0] === "collect").length, 1); assert.equal(f.calls.filter(c => c[0] === "continue").length, 0);
  assert.equal(readJson(join(f.service.dirOf(job.id), "result-application.json")), null);
  const direct = resultFixture(); direct.result.outcome = { finished: true, ok: false };
  await assert.rejects(reconcileExecutionResult(direct.ctx, direct), /failed root-turn results cannot authorize publication/);
  assert.deepEqual(direct.calls, []); assert.equal(readFileSync(join(direct.entry.worktree, "a.txt"), "utf8"), "before");
});

test("a stop after collected terminal results quarantines both success and failure caches", async () => {
  for (const state of ["succeeded", "failed"]) {
    const f = remote(), collect = f.transport.collect;
    await f.service.submit(input); f.observe({ state }); await f.service.reconcile({ force: true });
    f.transport.collect = async req => ({ ...await collect(req), outcome: { finished: true, ok: state === "succeeded", cost: null } });
    await f.service.collect(); assert.deepEqual(await f.service.cancel(), { confirmed: false, terminal: true });
    assert.equal(f.service.current().execution.quarantined, true); assert.equal(f.service.current().execution.providerState, state);
    assert.equal(f.calls.some(c => c[0] === "cancel"), false);
    await assert.rejects(f.reopen().collect(), { code: "EXECUTION_QUARANTINED" });
  }
});

for (const provider of ["openai-agents", "codex-cloud"]) {
  test(`${provider} fixture: cumulative cost survives omitted and lower observations, cached results and continuation`, async () => {
    for (const ok of [true, false]) for (const cost of [null, 0.2, 0.8]) {
      const f = remote(provider), job = await f.service.submit(input);
      f.observe({ costUsd: 0.6 }); await f.service.reconcile({ force: true });
      for (const costUsd of [undefined, null, 0.2, -1, "0.9", Infinity]) {
        f.clock.advance(1); f.observe({ costUsd }); await f.reopen().reconcile({ force: true });
        assert.equal(f.service.current().execution.costUsd, 0.6);
        assert.equal(f.service.outcome(job.id).cost, 0.6);
        assert.equal(f.service.state().allowance.chargedUsd, 0.6);
        assert.equal(readJson(join(f.service.dirOf(job.id), "job.json")).execution.costUsd, 0.6);
      }
      f.observe({ state: ok ? "succeeded" : "failed", costUsd: null }); await f.service.reconcile({ force: true });
      const before = f.service.state(), collect = f.transport.collect;
      f.transport.collect = async req => ({ ...await collect(req), outcome: { finished: true, ok, cost, denials: [] } });
      const result = await f.service.collect(), known = Math.max(0.6, cost ?? 0);
      assert.equal(result.outcome.cost, cost); // Preserve provider-reported metadata in the private result.
      assert.equal(f.service.current().execution.costUsd, known); assert.equal(f.service.outcome(job.id).cost, known);
      const bytes = readFileSync(join(f.service.dirOf(job.id), "result.json"), "utf8");
      // Recover an older regressed projection and a lost collection acknowledgement.
      before.current.execution.costUsd = null;
      writeJsonAtomic(join(f.root, "execution.json"), before);
      assert.equal(f.reopen().inspect().execution.costUsd, 0.6);
      await f.reopen().collect(); await f.reopen().collect();
      assert.equal(f.service.outcome(job.id).cost, known); assert.equal(f.service.current().execution.costUsd, known);
      assert.equal(f.service.state().operations.first.costUsd, known); assert.equal(f.service.state().allowance.chargedUsd, known);
      assert.equal(readFileSync(join(f.service.dirOf(job.id), "result.json"), "utf8"), bytes);
      const next = await f.service.continue({ ...input, operationId: "next", sessionId: "session-1" });
      assert.equal(next.execution.costUsd, null); assert.equal(f.service.outcome(next.id).cost, null);
      assert.equal(f.service.outcome(job.id).cost, known); assert.equal(f.service.outcome("unowned-run").cost, null);
      assert.equal(f.calls.filter(c => c[0] === "collect").length, 1); assert.equal(f.calls.filter(c => c[0] === "continue").length, 1);
    }
  });
}

test("unknown cost stays null until a valid zero and cancellation retains known spend", async () => {
  const unknown = remote(), job = await unknown.service.submit(input);
  for (const costUsd of [undefined, null, -1, "0.5", NaN, Infinity]) {
    unknown.observe({ costUsd }); await unknown.service.reconcile({ force: true });
    assert.equal(unknown.service.current().execution.costUsd, null); assert.equal(unknown.service.outcome(job.id).cost, null);
  }
  unknown.observe({ costUsd: 0 }); await unknown.service.reconcile({ force: true });
  assert.equal(unknown.service.outcome(job.id).cost, 0); assert.equal(unknown.service.state().operations.first.costUsd, 0);
  for (const confirmedByInspect of [true, false]) {
    const f = remote(), run = await f.service.submit(input);
    f.observe({ costUsd: 0.4 }); await f.service.reconcile({ force: true });
    if (confirmedByInspect) { f.observe({ state: "cancelled", costUsd: null }); await f.service.reconcile({ force: true }); }
    else await f.service.cancel();
    assert.equal(f.reopen().current().execution.costUsd, 0.4); assert.equal(f.reopen().outcome(run.id).cost, 0.4);
    assert.equal(f.service.state().allowance.chargedUsd, 0.4);
  }
});

test("canonical settlement preserves inspection cost when success or failure results omit usage", async () => {
  for (const ok of [true, false]) {
    const f = remote(), job = await f.service.submit(input), home = tempHome(), state = makeState(home), id = "acme/widget/remote", gh = fakeGh();
    f.observe({ costUsd: 0.55 }); await f.service.reconcile({ force: true });
    const entry = newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", pr: 1, state: STATES.fixing, nowIso: T0 });
    state.put(id, { ...entry, cursor: { ...entry.cursor, fixed_sha: gh.data.pr.headRefOid }, last: { run: job.id, exit: null } });
    f.observe({ state: ok ? "succeeded" : "failed", costUsd: null });
    const collect = f.transport.collect;
    f.transport.collect = async req => ({ ...await collect(req), outcome: { finished: true, ok, cost: null, denials: [], ...(ok ? {} : { error: "provider failed" }) } });
    const ctx = { home, config: CONFIG, clock: f.clock, state, gh, ownLogin: "me", git: fakeGit(), log: silentLog, notify: fakeNotify(), executionFor: () => f.reopen(), readPrd: () => null };
    await makeTick(ctx).tickEntry(id, state.get(id));
    assert.equal(state.get(id).execution.costUsd, 0.55); assert.equal(state.get(id).last.cost, 0.55);
    assert.equal(state.get(id).last.exit, ok ? 0 : 1);
    await makeTick(ctx).tickEntry(id, state.get(id));
    assert.equal(state.get(id).last.cost, 0.55); assert.equal(f.calls.filter(c => c[0] === "collect").length, 1);
  }
});

test("local settlement and replay retain the owned operation cost without inventing unknown spend", async () => {
  const root = tempHome(); let job = null;
  const runner = { current: () => job, lines: () => ['{"type":"turn.completed"}'], annotate() {},
    start: async (name, _cmd, _args, options) => job = { id: options.runId, name, exit: 0, running: false }, settle: () => job };
  const service = makeExecution({ root, taskId: "local/cost", provider: "codex", runner });
  const run = await service.submit({ ...input, spec: { cmd: "fixture", args: [], options: {} } });
  assert.equal(service.outcome(run.id).cost, null);
  const before = service.state(); before.operations.first.costUsd = 0.45; before.current.execution.costUsd = null;
  writeJsonAtomic(join(root, "execution.json"), before);
  service.settle(run.id, () => 0); service.settle(run.id, () => 0);
  assert.equal(service.current().execution.costUsd, 0.45); assert.equal(service.outcome(run.id).cost, 0.45);
  assert.equal(service.state().allowance.chargedUsd, 0.45);
  await service.collect(); assert.equal(service.outcome(run.id).cost, 0.45);
});

test("result route reports the owned cumulative cost without polling or rewriting private estimates", async () => {
  const f = remote(), home = tempHome(), id = "acme/widget/remote", root = join(home, "runs", idSlug(id));
  const service = makeExecution({ root, taskId: id, provider: "openai-agents", account: "test", transport: f.transport, capabilities: f.capabilities, clock: f.clock });
  const job = await service.submit(input); f.observe({ costUsd: 0.6 }); await service.reconcile({ force: true });
  f.observe({ state: "succeeded", costUsd: null }); await service.reconcile({ force: true }); await service.collect();
  await service.continue({ ...input, operationId: "next", sessionId: "session-1" });
  const state = makeState(home); state.put(id, newEntry({ repo: "acme/widget", harness: "openai-agents", branch: "work/remote", state: STATES.running, nowIso: T0 }));
  const response = { writeHead(code) { this.code = code; }, end(body) { this.body = body; } }, before = f.calls.length;
  const bytes = readFileSync(join(service.dirOf(job.id), "result.json"), "utf8");
  for (let i = 0; i < 3; i++) {
    routes["GET /api/run/result"]({ home, state, executionFor: () => service }, {}, response, new URL(`http://localhost/api/run/result?id=${id}&run=${job.id}`));
    assert.equal(response.code, 200); assert.equal(JSON.parse(response.body).outcome.cost, 0.6);
  }
  assert.equal(service.result(job.id).outcome.cost, null); assert.equal(service.current().execution.costUsd, null);
  assert.equal(readFileSync(join(service.dirOf(job.id), "result.json"), "utf8"), bytes); assert.equal(f.calls.length, before);
});
