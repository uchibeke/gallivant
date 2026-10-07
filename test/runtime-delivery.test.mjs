import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { checkRuntimeState, migrateRuntimeState, backupRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
import { createNodeCoordinator, createNodeOwnerStore } from "../lib/runtime_node.mjs";
import { CORE_VERSION } from "../lib/task_delivery_contract.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { makeState } from "../lib/state.mjs";
import { writeJsonAtomic, readJson } from "../lib/fs.mjs";
import { CONFIG, tempHome, makeClock, silentLog, fakeGh, fakeGit, fakeNotify } from "./helpers.mjs";

const manifest = { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1, coreSha256: "a".repeat(64) };
const update = { ...manifest, coreSha256: "b".repeat(64) };
const taskId = "task-" + "1".repeat(24);
const remote = { transport: "remote", provider: "openai-agents", acceptance: "accepted", providerJobId: "owned", turnId: "root", providerState: "succeeded", collected: true };

test("pre-registration intake and execution records retain their exact active artifact pin", async t => {
  const cases = [
    ["preparing before launch", "tasks/intake.json", { status: "preparing", attempts: [] }],
    ["validating", "tasks/intake.json", { status: "validating", attempts: [] }],
    ["pending readiness on a ready task", "tasks/intake.json", { status: "ready", readiness: { pending: true }, attempts: [] }],
    ["blocked local launch acknowledgement", "tasks/intake.json", { status: "blocked", attempts: [{ settled: false, run: null }] }],
    ["blocked remote cancellation", "tasks/intake.json", { status: "blocked", attempts: [{ settled: true, cancellation: { status: "pending" } }] }],
    ["settled attempt with unresolved provider", "tasks/intake.json", { status: "blocked", attempts: [{ settled: true, execution: { ...remote, acceptance: "unknown" } }] }],
    ["orphaned execution", "runs/intake/execution.json", { current: { execution: { ...remote, providerState: "running", collected: false } }, operations: {} }],
    ["unknown dispatch without current job", "runs/intake/execution.json", { current: null, operations: { prepare: { acceptance: "unknown" } } }],
    ["completed root awaiting results", "runs/intake/execution.json", { current: { execution: { ...remote, collected: false } }, operations: {} }],
  ];
  for (const [name, path, record] of cases) await t.test(name, () => {
    const home = tempHome(); migrateRuntimeState({ home, manifest });
    writeJsonAtomic(join(home, path), { version: 1, id: taskId, ...record });
    const pin = readFileSync(join(home, "runtime-pin.json"));
    assert.equal(checkRuntimeState({ home, manifest }).entries, 0);
    assert.equal(checkRuntimeState({ home, manifest }).active, true);
    assert.throws(() => migrateRuntimeState({ home, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
    assert.deepEqual(readFileSync(join(home, "runtime-pin.json")), pin);
    const rejected = join(tempHome(), "backup");
    assert.throws(() => backupRuntimeState({ home, out: rejected, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
    assert.equal(existsSync(rejected), false);
    const backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
    backupRuntimeState({ home, out: backup, manifest });
    assert.equal(restoreRuntimeState({ backup, out: restored, manifest }).active, true);
    assert.throws(() => migrateRuntimeState({ home: restored, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
    assert.equal(existsSync(join(home, "daemon.lock")), false, "refusals must release the runtime owner");
  });
});
test("settled preparation, completed cancellation and collected execution allow a compatible idle update", () => {
  const home = tempHome(); migrateRuntimeState({ home, manifest });
  writeJsonAtomic(join(home, "tasks", taskId, "intake.json"), { version: 1, id: taskId, status: "needs-input", readiness: { pending: false },
    attempts: [{ settled: true, execution: remote }, { settled: true, cancellation: { status: "confirmed" } }] });
  writeJsonAtomic(join(home, "runs/intake/execution.json"), { version: 1, current: { execution: remote }, operations: { prepare: { acceptance: "accepted" } } });
  assert.equal(checkRuntimeState({ home, manifest }).active, false);
  migrateRuntimeState({ home, manifest: update });
  assert.equal(readJson(join(home, "runtime-pin.json")).coreSha256, update.coreSha256);
});

for (const provider of ["openai-agents", "codex-cloud"]) test(`${provider} startup reconciliation spans every bounded batch and restarts a partial sweep`, async () => {
  const home = tempHome(), clock = makeClock(), state = makeState(home), executions = new Map(), lookups = [];
  migrateRuntimeState({ home, manifest });
  let submits = 0, identity = "fixture-first-process", wakes = 0;
  for (let i = 0; i < 5; i++) {
    const id = `acme/widget/job-${i}`, root = join(home, "runs", `job-${i}`);
    const execution = makeExecution({ root, taskId: id, provider, clock, capabilities: { available: true, transport: "remote" }, transport: {
      submit: async () => { submits++; throw new Error("fixture acknowledgement lost"); },
      lookup: async () => { lookups.push(id); return null; },
    } });
    await assert.rejects(execution.submit({ operationId: "initial", allowance: { remainingUsd: 1, reservedUsd: 0.1 } }));
    const saved = execution.state(); saved.current.execution.nextAttemptAt = clock.now() + 300000;
    writeJsonAtomic(join(root, "execution.json"), saved);
    executions.set(id, execution); state.put(id, { state: "done", harness: provider, last: { run: saved.current.id } });
  }
  for (let i = 0; i < 25; i++) state.createChain({ name: `history-${i}`, status: i % 2 ? "done" : "cancelled", steps: [], index: 0 });
  const native = createNodeOwnerStore({ home, durable: true });
  // Deterministic process identities over the real fenced durable store. These
  // unpaid transports do not qualify installed-host or live provider behavior.
  const store = { withOwner: fn => native.withOwner(owner => fn({ ...owner, processIdentity: identity })) };
  await native.withOwner(owner => owner.saveCheckpoint({ processIdentity: "previous-process", cursor: 2, chainCursor: "history-12" }));
  const ctx = { home, state, clock, ownLogin: "me", config: CONFIG, log: silentLog, gh: fakeGh(), git: fakeGit(), notify: fakeNotify(), executionFor: id => executions.get(id) };
  const schedule = async () => { wakes++; };
  const failing = createNodeCoordinator({ ctx: { ...ctx, state: { ...state, chains: () => { throw Object.assign(new Error("fixture state read failed"), { code: "FIXTURE_STATE" }); } } }, store, schedule, manifest, maxEntries: 2, maxChains: 0 });
  await assert.rejects(failing.wake(), { code: "FIXTURE_STATE" });
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, "previous-process");
  assert.equal(readJson(join(home, "coordinator.json")).cursor, 2, "failed advance must not commit its cursor or restart completion");
  assert.equal(existsSync(join(home, "daemon.lock")), false);
  assert.equal(readJson(join(home, "coordinator.json")).chainCursor, "history-12");
  lookups.length = 0;
  const coordinator = () => createNodeCoordinator({ ctx, store, schedule, manifest, maxEntries: 2 });
  await coordinator().wake();
  assert.deepEqual(lookups, [...executions.keys()].slice(0, 2));
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, "previous-process");
  assert.equal(readJson(join(home, "coordinator.json")).cursor, 2);
  await coordinator().wake();
  assert.deepEqual(lookups, [...executions.keys()].slice(0, 4));
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, "previous-process");
  identity = "fixture-restarted-process"; lookups.length = 0;
  for (let i = 0; i < 3; i++) await coordinator().wake();
  assert.deepEqual(lookups, [...executions.keys()], "a new process must also reconcile entries before the interrupted cursor");
  assert.equal(readJson(join(home, "coordinator.json")).cursor, 0);
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, identity);
  assert.equal(readJson(join(home, "coordinator.json")).startupProcessIdentity, null);
  for (let i = 0; i < 3; i++) await coordinator().wake();
  assert.equal(lookups.length, 5, "a completed startup sweep returns to saved provider backoff");
  assert.equal(submits, 5, "unknown acceptance must never purchase another dispatch");
  assert.equal(wakes, 9);
});

test("bounded chain batches ignore history and rotate durably while active chains leave the set", async () => {
  const home = tempHome(), state = makeState(home), clock = makeClock();
  migrateRuntimeState({ home, manifest });
  for (let i = 0; i < 36; i++) state.createChain({ name: `history-${i}`, status: ["done", "cancelled", "stopped"][i % 3], steps: [], index: 0 });
  const names = Array.from({ length: 25 }, (_, i) => `work-${String(i).padStart(2, "0")}`);
  for (const name of names) state.createChain({ name, status: "active", index: 0, steps: [{ id: `acme/widget/${name}`, dispatch: "unknown-start" }] });
  const ctx = { home, state, clock, ownLogin: "me", config: CONFIG, log: silentLog, gh: fakeGh(), git: fakeGit(), notify: fakeNotify(),
    runnerFor: () => assert.fail("unknown chain dispatch cannot launch a runner") };
  const store = createNodeOwnerStore({ home, durable: true });
  const coordinator = (maxChains = 10) => createNodeCoordinator({ ctx, store, schedule: async () => {}, manifest, maxChains });
  const disabled = await coordinator(0).wake(); assert.equal(disabled.length, 0);
  assert.equal(state.getChain(names[0]).status, "active");
  const first = await coordinator().wake();
  assert.deepEqual(first.map(r => r.chain), names.slice(0, 10));
  assert.equal(readJson(join(home, "coordinator.json")).chainCursor, names[9]);
  assert.ok(names.slice(0, 10).every(name => state.getChain(name).status === "stopped"));
  state.updateChain(names[10], { status: "cancelled" });
  const second = await coordinator().wake();
  assert.deepEqual(second.map(r => r.chain), names.slice(11, 21));
  assert.equal(readJson(join(home, "coordinator.json")).chainCursor, names[20]);
  // A newly active prefix is picked up on the next rotation, not lost when
  // earlier completed chains disappear from the active window.
  state.updateChain(names[0], { status: "active" });
  const third = await coordinator().wake();
  assert.deepEqual(third.map(r => r.chain), names.slice(21));
  assert.equal(readJson(join(home, "coordinator.json")).chainCursor, null);
  const fourth = await coordinator().wake(); assert.deepEqual(fourth.map(r => r.chain), [names[0]]);
  assert.deepEqual(await coordinator().wake(), []);
  assert.equal(state.chains().length, 61, "history remains intact");
  assert.equal(existsSync(join(home, "daemon.lock")), false);
});
