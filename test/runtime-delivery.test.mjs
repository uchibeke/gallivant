import { learningStore } from "../lib/learning_store.mjs";
import { taskCommand } from "../lib/commands/task.mjs";
import { acquireDaemon } from "../lib/daemon.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync, symlinkSync, lstatSync } from "node:fs";
import { checkRuntimeState, migrateRuntimeState, backupRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
import { createNodeCoordinator, createNodeOwnerStore } from "../lib/runtime_node.mjs";
import { CORE_VERSION } from "../lib/task_delivery_contract.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { cancelControl } from "../lib/control.mjs";
import { makeState } from "../lib/state.mjs";
import { writeJsonAtomic, readJson, canonicalPath } from "../lib/fs.mjs";
import { CONFIG, tempHome, makeClock, silentLog, fakeGh, fakeGit, fakeNotify } from "./helpers.mjs";

const manifest = { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1, coreSha256: "a".repeat(64) };
const update = { ...manifest, coreSha256: "b".repeat(64) };
const taskId = "task-" + "1".repeat(24);
const remote = { transport: "remote", provider: "openai-agents", acceptance: "accepted", providerJobId: "owned", turnId: "root", providerState: "succeeded", collected: true };

test("qualified handoffs release artifact pins while unresolved work still retains them", () => {
  const id = "acme/widget/review", repo = "acme/widget", head = "approved-head";
  const ready = { id, repo, pr: 17, base: "main", state: "ready-for-human", cursor: { fixed_sha: head },
    task: { completion: { version: 1, target: "delivery_ready" } },
    completionEvidence: { delivery: { repository: repo, pr: 17, base: "main", head, gate: { allow: true } } } };
  const home = tempHome(); migrateRuntimeState({ home, manifest });
  writeJsonAtomic(join(home, "state.json"), { version: 1, entries: { [id]: ready } });
  assert.equal(checkRuntimeState({ home, manifest }).active, false);
  const backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
  backupRuntimeState({ home, out: backup, manifest });
  assert.equal(restoreRuntimeState({ backup, out: restored, manifest }).active, false);
  for (const root of [home, restored]) {
    migrateRuntimeState({ home: root, manifest: update });
    assert.equal(readJson(join(root, "runtime-pin.json")).coreSha256, update.coreSha256);
    assert.deepEqual(readJson(join(root, "state.json")).entries[id], ready, "migration preserves completion evidence");
  }
  const unresolved = [
    ["integrated target", entry => { entry.task.completion.target = "integrated"; }],
    ["legacy task", entry => { delete entry.task; }],
    ["missing evidence", entry => { delete entry.completionEvidence; }],
    ["stale evidence", entry => { entry.completionEvidence.delivery.head = "old-head"; }],
    ["malformed ownership", entry => { entry.task.ownerDelivery = { version: 99 }; }],
    ["queued recheck", entry => { entry.control = { action: "recheck", status: "queued" }; }],
    ["applying message", entry => { entry.control = { action: "message", status: "applying" }; }],
    ["live provider", entry => { entry.execution = { ...remote, providerState: "running" }; }],
    ["uncollected result", entry => { entry.execution = { ...remote, collected: false }; }],
    ["unknown acceptance", entry => { entry.execution = { ...remote, acceptance: "unknown" }; }],
    ["blocked task", entry => { entry.state = "needs-human"; entry.reason = "review-required"; }],
    ["done with pending control", entry => { entry.state = "done"; entry.control = { action: "resume", status: "queued" }; }],
    ["done with live provider", entry => { entry.state = "done"; entry.execution = { ...remote, providerState: "running" }; }],
  ];
  for (const [name, change] of unresolved) {
    const root = tempHome(), entry = structuredClone(ready); change(entry);
    migrateRuntimeState({ home: root, manifest });
    writeJsonAtomic(join(root, "state.json"), { version: 1, entries: { [id]: entry } });
    assert.equal(checkRuntimeState({ home: root, manifest }).active, true, name);
    assert.throws(() => migrateRuntimeState({ home: root, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" }, name);
    assert.equal(readJson(join(root, "runtime-pin.json")).coreSha256, manifest.coreSha256, name);
    assert.deepEqual(readJson(join(root, "state.json")).entries[id], entry, name);
  }
});

test("embedded coordinator resolves authenticated identity when plain context has no daemon ownLogin", async () => {
  const home=tempHome(),state=makeState(home),clock=makeClock(),calls=[];
  migrateRuntimeState({home,manifest});
  const ctx={home,state,clock,config:CONFIG,log:silentLog,gh:{...fakeGh(),user:async()=>{calls.push("identity");return "me";}},git:fakeGit(),notify:fakeNotify()};
  const coordinator=createNodeCoordinator({ctx,store:createNodeOwnerStore({home,durable:true}),manifest,schedule:async()=>calls.push("schedule")});
  await coordinator.wake();
  assert.deepEqual(calls,["schedule","identity","schedule"],"the real tick succeeds without a test-only injected login");
  ctx.gh.user=async()=>{throw Object.assign(new Error("identity unavailable"),{code:"GH_UNAVAILABLE"});};
  await assert.rejects(coordinator.wake(),{code:"GH_UNAVAILABLE"});
});

test("pre-registration intake and execution records retain their exact active artifact pin", async t => {
  const cases = [
    ["preparing before launch", `tasks/${taskId}/intake.json`, { status: "preparing", attempts: [] }],
    ["ready dispatch intent before registry claim", `tasks/${taskId}/intake.json`, { status: "ready", dispatchIntent: { id: "acme/widget/task", digest: "approved" }, attempts: [] }],
    ["blocked unknown dispatch", `tasks/${taskId}/intake.json`, { status: "blocked", dispatchIntent: { id: "acme/widget/task" }, attempts: [] }],
    ["mismatched implementation acknowledgement", `tasks/${taskId}/intake.json`, { status: "started", dispatchIntent: { id: "acme/widget/task" }, implementation: { id: "other" }, attempts: [] }],
    ["validating", `tasks/${taskId}/intake.json`, { status: "validating", attempts: [] }],
    ["pending readiness on a ready task", `tasks/${taskId}/intake.json`, { status: "ready", readiness: { pending: true }, attempts: [] }],
    ["blocked local launch acknowledgement", `tasks/${taskId}/intake.json`, { status: "blocked", attempts: [{ settled: false, run: null }] }],
    ["blocked remote cancellation", `tasks/${taskId}/intake.json`, { status: "blocked", attempts: [{ settled: true, cancellation: { status: "pending" } }] }],
    ["settled attempt with unresolved provider", `tasks/${taskId}/intake.json`, { status: "blocked", attempts: [{ settled: true, execution: { ...remote, acceptance: "unknown" } }] }],
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

test("confirmed registry cancellations release the pin only after execution and controls settle", async () => {
  const home = tempHome(), state = makeState(home), id = "acme/widget/cancelled";
  migrateRuntimeState({ home, manifest });
  writeJsonAtomic(join(home, "state.json"), { version: 1, entries: { [id]: {
    id, state: "running", dispatch_stopped: "cancellation-requested",
    control: { action: "cancel", status: "queued" }, last: { run: "owned" },
  } } });
  const ledger = join(home, "runs/cancelled/execution.json");
  const job = { id: "owned", execution: { ...remote, providerState: "cancelled" } };
  writeJsonAtomic(ledger, { version: 1, current: job, operations: {} });
  let confirmed = false;
  const ctx = { state, clock: makeClock(), log: silentLog, runnerFor: () => ({ current: () => job, cancel: async () => ({ confirmed }) }) };
  await cancelControl(ctx, id);
  assert.equal(state.get(id).reason, "cancellation-requested");
  assert.throws(() => migrateRuntimeState({ home, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
  state.update(id, { control: { action: "cancel", status: "queued" } }); confirmed = true;
  await cancelControl(ctx, id);
  assert.equal(state.get(id).state, "needs-human");
  assert.equal(state.get(id).reason, "cancelled");
  for (const execution of [{ ...remote, providerState: "running" }, { ...remote, collected: false }, { ...remote, acceptance: "unknown" }]) {
    writeJsonAtomic(ledger, { version: 1, current: { ...job, execution }, operations: {} });
    assert.throws(() => migrateRuntimeState({ home, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
  }
  writeJsonAtomic(ledger, { version: 1, current: job, operations: {} });
  state.update(id, { control: { action: "recheck", status: "queued" } });
  assert.throws(() => migrateRuntimeState({ home, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
  state.update(id, { control: { action: "cancel", status: "applied" } });
  assert.equal(checkRuntimeState({ home, manifest }).active, false);
  migrateRuntimeState({ home, manifest: update });
  assert.equal(readJson(join(home, "runtime-pin.json")).coreSha256, update.coreSha256);
  assert.equal(state.get(id).reason, "cancelled", "migration preserves retained cancellation history");
  assert.equal(existsSync(join(home, "daemon.lock")), false);
});

for (const provider of ["openai-agents", "codex-cloud"]) test(`${provider} startup keyset reconciliation survives removed entries and restarts a partial sweep`, async () => {
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
  assert.equal(readJson(join(home, "coordinator.json")).entryCursor, "acme/widget/job-1");
  state.remove("acme/widget/job-1"); // Removing the saved key must not shift past job-2.
  await coordinator().wake();
  assert.deepEqual(lookups, [...executions.keys()].slice(0, 4));
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, "previous-process");
  identity = "fixture-restarted-process"; lookups.length = 0;
  for (let i = 0; i < 3; i++) await coordinator().wake();
  assert.deepEqual(lookups, [...executions.keys()].filter(id => id !== "acme/widget/job-1"), "a new process must also reconcile entries before the interrupted cursor");
  assert.equal(readJson(join(home, "coordinator.json")).cursor, 0);
  assert.equal(readJson(join(home, "coordinator.json")).processIdentity, identity);
  assert.equal(readJson(join(home, "coordinator.json")).startupProcessIdentity, null);
  for (let i = 0; i < 3; i++) await coordinator().wake();
  assert.equal(lookups.length, 4, "a completed startup sweep returns to saved provider backoff");
  assert.equal(submits, 5, "unknown acceptance must never purchase another dispatch");
  assert.equal(wakes, 17);
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
  clock.advance(CONFIG.poll_seconds / 60);
  const fourth = await coordinator().wake(); assert.deepEqual(fourth.map(r => r.chain), [names[0]]);
  assert.deepEqual(await coordinator().wake(), []);
  // If the remaining suffix disappears, close the sweep instead of polling an
  // already visited prefix before its review deadline.
  state.updateChain(names[0], { status: "active" });
  await store.withOwner(owner => owner.saveCheckpoint({ chainCursor: names[20] }));
  assert.deepEqual(await coordinator().wake(), []);
  assert.equal(state.getChain(names[0]).status, "active");
  assert.equal(readJson(join(home, "coordinator.json")).chainCursor, null);
  clock.advance(CONFIG.poll_seconds / 60);
  assert.deepEqual((await coordinator().wake()).map(r => r.chain), [names[0]]);
  assert.equal(state.chains().length, 61, "history remains intact");
  assert.equal(existsSync(join(home, "daemon.lock")), false);
});

test("chain review cadence survives fast wakes, process restart and failed advances while entry work continues", async () => {
  const home = tempHome(), state = makeState(home), clock = makeClock(), reads = [], ancestry = [];
  migrateRuntimeState({ home, manifest });
  const entries = {}, chains = {};
  for (let i = 1; i <= 3; i++) {
    const name = `chain-${i}`, id = `acme/widget/job-${i}`, dispatch = `dispatch-${i}`;
    entries[id] = { state: "done", harness: "claude", repo: "acme/widget", base: "main", branch: `work/job-${i}`, checkout: "/fixture", prd: `job-${i}.md`, start_token: `token-${i}`, pr: i, chain: { name, index: 0, dispatch } };
    chains[name] = { name, repo: "acme/widget", base: "main", status: "active", index: 0, steps: [{ id, checkout: "/fixture", relPath: `job-${i}.md`, dispatch }] };
  }
  writeJsonAtomic(join(home, "state.json"), { version: 1, entries, chains });
  let progress = 0, identity = "fixture-original", failReads = false, merged = false;
  const runner = { current: () => null, reconcile: async () => { progress++; } };
  const ctx = { home, state, clock, ownLogin: "me", config: { ...CONFIG, poll_seconds: 120 }, log: silentLog, git: fakeGit(), notify: fakeNotify(),
    executionFor: () => runner, runnerFor: () => runner,
    gh: { ...fakeGh(), prView: async (_repo, number) => {
      reads.push(number); if (failReads) throw new Error("fixture GitHub unavailable");
      return { number, url: `https://github.com/acme/widget/pull/${number}`, headRefName: `work/job-${number}`, baseRefName: "main", isCrossRepository: false,
        state: merged ? "MERGED" : "OPEN", mergeCommit: { oid: "a".repeat(40) }, mergedAt: "2026-09-24T02:00:00Z" };
    }, containsCommit: async (_repo, _base, sha) => { ancestry.push(sha); return true; } },
  };
  const native = createNodeOwnerStore({ home, durable: true });
  const store = { withOwner: fn => native.withOwner(owner => fn({ ...owner, processIdentity: identity })) };
  const coordinator = (context = ctx, maxChains = 2) => createNodeCoordinator({ ctx: context, store, schedule: async () => {}, manifest, maxEntries: 1, maxChains });
  await coordinator(ctx, 0).wake();
  assert.equal(readJson(join(home, "coordinator.json")).nextChainAt, undefined, "disabled chains cannot postpone the first enabled sweep");
  await coordinator().wake(); assert.deepEqual(reads, [1, 2]);
  clock.advance(10 / 60); await coordinator().wake(); assert.deepEqual(reads, [1, 2, 3]);
  const deadline = clock.now() + 120000;
  assert.equal(readJson(join(home, "coordinator.json")).nextChainAt, deadline);
  for (let i = 0; i < 11; i++) {
    clock.advance(10 / 60); identity = "fixture-restarted";
    await coordinator().wake();
    assert.deepEqual(reads, [1, 2, 3], "fast wakes and restart cannot repeat chain GitHub reads");
    assert.equal(readJson(join(home, "coordinator.json")).chainCursor, null);
    assert.equal(readJson(join(home, "coordinator.json")).nextChainAt, deadline);
  }
  assert.equal(progress, 14, "one bounded entry still reconciles on every wake");
  clock.advance(10 / 60);
  const broken = { ...ctx, state: { ...state, chains: () => { throw new Error("fixture state read failure"); } } };
  await assert.rejects(coordinator(broken).wake(), /fixture state read failure/);
  assert.equal(readJson(join(home, "coordinator.json")).nextChainAt, deadline);
  assert.equal(existsSync(join(home, "daemon.lock")), false);
  failReads = true;
  await coordinator().wake(); assert.deepEqual(reads, [1, 2, 3, 1, 2]);
  clock.advance(10 / 60); await coordinator().wake(); assert.deepEqual(reads, [1, 2, 3, 1, 2, 3]);
  failReads = false; merged = true;
  clock.advance(10 / 60); await coordinator().wake(); assert.equal(reads.length, 6, "GitHub failures retain the normal review cadence");
  clock.advance(110 / 60); await coordinator().wake();
  clock.advance(10 / 60); await coordinator().wake();
  assert.deepEqual(reads, [1, 2, 3, 1, 2, 3, 1, 2, 3]); assert.equal(ancestry.length, 3);
  assert.ok(state.chains().every(([, c]) => c.status === "done"));
});

test("idle upgrade backups require the old artifact and reject inconsistent rollback pins before output", async () => {
  const home = tempHome(), backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored"), wrong = join(tempHome(), "wrong");
  migrateRuntimeState({ home, manifest });
  writeJsonAtomic(join(home, "runs", "retained", "agents.json"), { version: 1, sessionId: "retained-session", turnId: "retained-turn" });
  const pin = readFileSync(join(home, "runtime-pin.json")), provider = readFileSync(join(home, "runs", "retained", "agents.json"));
  assert.throws(() => backupRuntimeState({ home, out: wrong, manifest: update }), { code: "RUNTIME_STATE", message: /pre-upgrade manifest/ });
  assert.equal(existsSync(wrong), false); assert.deepEqual(readFileSync(join(home, "runtime-pin.json")), pin);
  assert.equal(existsSync(join(home, "daemon.lock")), false);
  backupRuntimeState({ home, out: backup, manifest });
  assert.equal(readJson(join(backup, "backup.json")).coreSha256, manifest.coreSha256);
  migrateRuntimeState({ home, manifest: update });
  restoreRuntimeState({ backup, out: restored, manifest });
  assert.deepEqual(readFileSync(join(restored, "runtime-pin.json")), pin);
  assert.deepEqual(readFileSync(join(restored, "runs", "retained", "agents.json")), provider);
  const ctx = { home: restored, state: makeState(restored), config: CONFIG, ownLogin: "me", clock: makeClock(), log: silentLog, gh: fakeGh(), git: fakeGit(), notify: fakeNotify() };
  await createNodeCoordinator({ ctx, store: createNodeOwnerStore({ home: restored, durable: true }), manifest, schedule: async () => {} }).wake();
  const envelope = readJson(join(backup, "backup.json"));
  writeJsonAtomic(join(backup, "backup.json"), { ...envelope, coreSha256: update.coreSha256 });
  assert.throws(() => restoreRuntimeState({ backup, out: wrong, manifest: update }), { code: "RUNTIME_STATE", message: /pre-upgrade manifest/ });
  assert.equal(existsSync(wrong), false, "an inconsistent idle pin must fail before creating a namespace");
});

test("backup distinguishes unpinned legacy state from an invalid existing pin", () => {
  const home = tempHome(), backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
  backupRuntimeState({ home, out: backup, manifest });
  assert.equal(restoreRuntimeState({ backup, out: restored, manifest }).pinned, null);
  for (const invalid of [null, false, 0, { version: 2, coreSha256: manifest.coreSha256, coreVersion: manifest.coreVersion }]) {
    writeJsonAtomic(join(home, "runtime-pin.json"), invalid);
    const out = join(tempHome(), "rejected");
    assert.throws(() => backupRuntimeState({ home, out, manifest }), { code: "RUNTIME_STATE" });
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(home, "daemon.lock")), false);
  }
});


test("delayed and repeated coordinator wakes revalidate the pin under ownership before effects", async () => {
  const home = tempHome(), state = makeState(home), store = createNodeOwnerStore({ home, durable: true });
  migrateRuntimeState({ home, manifest });
  let reads = 0, schedules = 0;
  const ctx = { home, state: { ...state, entries: () => { reads++; return state.entries(); } }, clock: makeClock(), config: CONFIG, ownLogin: "me", log: silentLog, gh: fakeGh(), git: fakeGit(), notify: fakeNotify() };
  const coordinator = createNodeCoordinator({ ctx, store, manifest, schedule: async () => { schedules++; } });
  // Migration after construction but before the very first callback.
  migrateRuntimeState({ home, manifest: update });
  const pin = readFileSync(join(home, "runtime-pin.json"));
  for (let i = 0; i < 2; i++) await assert.rejects(coordinator.wake(), { code: "COORDINATOR_PIN" });
  assert.equal(reads, 0); assert.equal(schedules, 0);
  assert.deepEqual(readFileSync(join(home, "runtime-pin.json")), pin);
  assert.equal(existsSync(join(home, "daemon.lock")), false);
  assert.equal(readJson(join(home, "coordinator.json")).cursor, undefined);
  // A previously successful coordinator must also reject later migrations.
  migrateRuntimeState({ home, manifest }); await coordinator.wake();
  const before = { reads, schedules, checkpoint: readJson(join(home, "coordinator.json")) };
  migrateRuntimeState({ home, manifest: update });
  await assert.rejects(coordinator.wake(), { code: "COORDINATOR_PIN" });
  assert.equal(reads, before.reads); assert.equal(schedules, before.schedules);
  assert.equal(readJson(join(home, "coordinator.json")).cursor, before.checkpoint.cursor);
  assert.equal(existsSync(join(home, "daemon.lock")), false);
  const current = createNodeCoordinator({ ctx, store, manifest: update, schedule: async () => { schedules++; } });
  await current.wake(); assert.equal(schedules, before.schedules + 2);
});


test("only canonical ledgers affect runtime checks and backups preserve repository lock snapshots", async () => {
  const home = tempHome(), draft = `tasks/${taskId}/drafts/revision-1`;
  const snapshots = ["execution.json", "agents.json", "cloud.json", "codex-cloud.json", "intake.json", "yarn.lock", "bun.lock", "poetry.lock", "intake.lock", "execution.lock.recovery", "nested/publication.lock"];
  for (const name of snapshots) {
    const path = join(home, draft, name); mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, name.endsWith(".json") ? '{"version":42,"status":"preparing"}' : `source ${name}`);
  }
  writeJsonAtomic(join(home, draft, "nested/intake.json"), { version: 1, status: "preparing", attempts: [] });
  const locks = [`tasks/${taskId}/intake.lock`, "runs/intake__fixture/execution.lock", "runs/intake__fixture/publication.lock", `delivery/${"a".repeat(64)}/delivery.lock`];
  for (const path of locks) {
    mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), "stale process owner");
    mkdirSync(join(home, path + ".recovery")); writeFileSync(join(home, path + ".recovery", "marker"), "stale recovery");
  }
  assert.equal(checkRuntimeState({ home, manifest }).active, false);
  migrateRuntimeState({ home, manifest });
  const ctx = { home, state: makeState(home), config: CONFIG, clock: makeClock(), ownLogin: "me", log: silentLog, gh: fakeGh(), git: fakeGit(), notify: fakeNotify() };
  await createNodeCoordinator({ ctx, store: createNodeOwnerStore({ home, durable: true }), manifest, schedule: async () => {} }).wake();
  const backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
  backupRuntimeState({ home, out: backup, manifest }); restoreRuntimeState({ backup, out: restored, manifest });
  const hashes = readJson(join(backup, "backup.json")).hashes;
  for (const name of snapshots) {
    assert.ok(hashes[`${draft}/${name}`]);
    assert.deepEqual(readFileSync(join(restored, draft, name)), readFileSync(join(home, draft, name)));
  }
  for (const path of locks) { assert.equal(existsSync(join(restored, path)), false); assert.equal(existsSync(join(restored, path + ".recovery")), false); }
  for (const name of ["execution", "agents", "cloud"]) {
    writeJsonAtomic(join(restored, "runs", "owned", `${name}.json`), { version: 42 });
    assert.throws(() => checkRuntimeState({ home: restored, manifest }), { code: "RUNTIME_STATE" });
    writeJsonAtomic(join(restored, "runs", "owned", `${name}.json`), { version: 1 });
  }
});


test("restore and backup refuse existing outputs without modifying their contents", () => {
  const home = tempHome(), backup = join(tempHome(), "backup");
  backupRuntimeState({ home, out: backup, manifest });
  for (const kind of ["directory", "file", "symlink", "dangling-symlink"]) {
    const parent = tempHome(), out = join(parent, "out"), target = join(parent, "target");
    if (kind === "directory") { mkdirSync(out); writeFileSync(join(out, "unrelated"), "keep"); }
    if (kind === "file") writeFileSync(out, "keep");
    if (kind === "symlink") { mkdirSync(target); writeFileSync(join(target, "unrelated"), "keep"); }
    if (kind.includes("symlink")) symlinkSync(target, out);
    assert.throws(() => restoreRuntimeState({ backup, out, manifest }), { code: "EEXIST" });
    assert.throws(() => backupRuntimeState({ home, out, manifest }), { code: kind === "dangling-symlink" ? "ENOENT" : "EEXIST" });
    if (kind.includes("symlink")) assert.equal(lstatSync(out).isSymbolicLink(), true);
    if (kind !== "dangling-symlink") assert.equal(readFileSync(kind === "file" ? out : join(out, "unrelated"), "utf8"), "keep");
  }
});


test("backup canonicalizes symlink ancestors before checking namespace separation", () => {
  const root = tempHome(), home = join(root, "home"), alias = join(root, "alias");
  mkdirSync(home); mkdirSync(join(home, "tasks")); symlinkSync(home, alias);
  for (const inputHome of [home, alias]) {
    for (const out of [join(alias, "tasks", "backup"), join(home, "tasks", "backup"), join(alias, "tasks", "missing", "backup"), alias, root]) {
      assert.throws(() => backupRuntimeState({ home: inputHome, out, manifest }), { code: "RUNTIME_STATE", message: /outside/ });
      assert.equal(existsSync(join(home, "tasks", "backup")), false);
      assert.equal(existsSync(join(home, "daemon.lock")), false);
    }
  }
  const external = join(root, "external"), externalAlias = join(root, "external-alias");
  mkdirSync(external); symlinkSync(external, externalAlias);
  const backup = join(externalAlias, "backup");
  backupRuntimeState({ home: alias, out: backup, manifest });
  assert.equal(existsSync(join(external, "backup", "backup.json")), true);
  const dangling = join(root, "dangling"); symlinkSync(join(home, "absent"), dangling);
  assert.throws(() => backupRuntimeState({ home, out: join(dangling, "backup"), manifest }), { code: "ENOENT" });
  assert.equal(lstatSync(dangling).isSymbolicLink(), true);
});


test("CLI mutations exclude maintenance through async work and release ownership on failure", async () => {
  for (const operation of ["prepare", "answer", "resume", "validate", "start"]) {
    const home = tempHome(), out = join(tempHome(), "backup");
    let release, entered;
    const waiting = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const service = { [operation]: async () => { entered(); await waiting; throw new Error("task failed"); }, list: () => ({ tasks: [] }), inspect: () => ({ taskId }) };
    const pending = taskCommand({ home }, { args: [operation, taskId], values: {}, service });
    await started;
    assert.throws(() => migrateRuntimeState({ home, manifest }), /task mutation.*already|already.*task mutation/);
    assert.equal(existsSync(join(home, "runtime-pin.json")), false);
    assert.throws(() => backupRuntimeState({ home, out, manifest }), /task mutation.*already|already.*task mutation/);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(home, "daemon.lock")), false, "failed maintenance releases daemon ownership");
    assert.deepEqual(await taskCommand({ home }, { args: ["list"], values: {}, service }), { tasks: [] });
    // Ordinary daemon ownership may coexist with the CLI writer.
    const daemon = acquireDaemon(home); daemon.release();
    release(); await assert.rejects(pending, /task failed/);
    assert.equal(existsSync(join(home, "task-mutation.lock")), false);
    const liveDaemon = acquireDaemon(home);
    try {
      assert.equal(await taskCommand({ home }, { args: [operation, taskId], values: {}, service: { [operation]: async () => {
        assert.equal(existsSync(join(home, "task-mutation.lock")), true); return "saved";
      } } }), "saved");
    } finally { liveDaemon.release(); }
    backupRuntimeState({ home, out, manifest });
    migrateRuntimeState({ home, manifest });
    assert.deepEqual(await taskCommand({ home }, { args: ["inspect", taskId], values: {}, service }), { taskId });
    let called = false;
    await assert.rejects(taskCommand({ home }, { args: [operation, taskId], values: {}, service: { [operation]: () => { called = true; } } }), { code: "TASK_RUNTIME_PIN" });
    assert.equal(called, false);
    assert.equal(existsSync(join(home, "task-mutation.lock")), false);
  }
});


test("active legacy namespaces cannot receive a first artifact pin", () => {
  for (const pin of [undefined, null, false, 0]) for (const [path, data] of [
    ["state.json", { version: 1, entries: { active: { state: "running" } } }],
    [`tasks/${taskId}/intake.json`, { version: 1, status: "preparing", attempts: [] }],
    [`tasks/${taskId}/intake.json`, { version: 1, status: "ready", dispatchIntent: { id: "acme/widget/task" }, attempts: [] }],
    ["runs/active/execution.json", { version: 1, current: null, operations: { work: { acceptance: "unknown" } } }],
  ]) {
    const home = tempHome(); writeJsonAtomic(join(home, path), data);
    if (pin !== undefined) writeJsonAtomic(join(home, "runtime-pin.json"), pin);
    assert.throws(() => migrateRuntimeState({ home, manifest }), { code: "RUNTIME_ACTIVE_PIN" });
    assert.equal(readJson(join(home, "runtime-pin.json")), pin === undefined ? null : pin);
    if (pin === undefined) assert.equal(existsSync(join(home, "runtime-pin.json")), false);
    assert.equal(existsSync(join(home, "daemon.lock")), false);
  }
  const idle = tempHome(); migrateRuntimeState({ home: idle, manifest });
  assert.equal(readJson(join(idle, "runtime-pin.json")).coreSha256, manifest.coreSha256);
});

test("top-level CLI mutations respect maintenance ownership and pinned namespaces", async () => {
  const { spawnSync } = await import("node:child_process");
  const { acquireTaskMutation } = await import("../lib/daemon.mjs");
  const home = tempHome(); writeJsonAtomic(join(home, "config.json"), { ...CONFIG, worktrees: tempHome(), notify: null });
  const commands = [["start", "brief.md"], ["resume", "missing"], ["register", "https://github.com/acme/widget/pull/1"], ["remove", "missing"], ["recheck", "missing"], ["say", "missing", "--note", "hello"], ["cancel", "missing"], ["chain", "plan", "brief.md"], ["chain", "plan", "--retry"], ["chain", "plan", "--cancel"]];
  const cli = new URL("../bin/gallivant.mjs", import.meta.url).pathname;
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8", timeout: 10000 });
  const owner = acquireTaskMutation(home);
  try {
    for (const args of commands) { const r = invoke(args); assert.equal(r.status, 1); assert.match(r.stderr, /task mutation already running/); }
    assert.doesNotMatch(invoke(["chain"]).stderr, /task mutation already running/);
    assert.equal(existsSync(join(home, "state.json")), false);
  } finally { owner.release(); }
  migrateRuntimeState({ home, manifest });
  for (const args of commands) { const r = invoke(args); assert.equal(r.status, 1); assert.match(r.stderr, /manifest-aware task delivery adapter/); }
  assert.equal(existsSync(join(home, "task-mutation.lock")), false);
});


test("pending delivery receipts pin migration before intake and through wake acknowledgement", () => {
  for (const field of ["operations", "cancellations"]) for (const receipt of [{ status: "intent" }, { status: "acknowledged", wakePending: true }, { status: "unknown" }]) {
    const home = tempHome(), path = join(home, "delivery", "d".repeat(64), "delivery.json");
    migrateRuntimeState({ home, manifest });
    const record = { version: 1, tasks: {}, operations: {}, [field]: { pending: receipt } };
    writeJsonAtomic(path, record);
    assert.equal(checkRuntimeState({ home, manifest }).active, true);
    assert.throws(() => migrateRuntimeState({ home, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
    assert.equal(readJson(join(home, "runtime-pin.json")).coreSha256, manifest.coreSha256);
    assert.deepEqual(readJson(path), record);
    assert.equal(existsSync(join(home, "daemon.lock")), false);
    assert.equal(existsSync(join(home, "task-mutation.lock")), false);
    const backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
    backupRuntimeState({ home, out: backup, manifest });
    restoreRuntimeState({ backup, out: restored, manifest });
    assert.throws(() => migrateRuntimeState({ home: restored, manifest: update }), { code: "RUNTIME_ACTIVE_PIN" });
    record[field].pending = { status: "acknowledged", wakePending: false };
    writeJsonAtomic(path, record);
    assert.equal(checkRuntimeState({ home, manifest }).active, false);
    migrateRuntimeState({ home, manifest: update });
  }
  const legacy = tempHome();
  writeJsonAtomic(join(legacy, "delivery", "e".repeat(64), "delivery.json"), { version: 1, operations: { pending: { status: "intent" } } });
  assert.throws(() => migrateRuntimeState({ home: legacy, manifest }), { code: "RUNTIME_ACTIVE_PIN" });
  const snapshot = tempHome();
  writeJsonAtomic(join(snapshot, "prds", "delivery", "e".repeat(64), "delivery.json"), { version: 99 });
  assert.equal(migrateRuntimeState({ home: snapshot, manifest }).active, false);
});

test("acknowledged historical dispatch intent does not permanently pin settled work", () => {
  const home = tempHome(); migrateRuntimeState({ home, manifest });
  writeJsonAtomic(join(home, "tasks", taskId, "intake.json"), { version: 1, status: "started", dispatchIntent: { id: "acme/widget/task" }, implementation: { id: "acme/widget/task" }, attempts: [] });
  assert.equal(checkRuntimeState({ home, manifest }).active, false);
  migrateRuntimeState({ home, manifest: update });
  assert.equal(readJson(join(home, "runtime-pin.json")).coreSha256, update.coreSha256);
});

test("runtime backup preserves learning identities, trust and delivery state while excluding operation locks", async () => {
  const home = canonicalPath(tempHome()), store = learningStore(join(home, "learning"));
  const repo = { host: "github.com", id: "123" };
  store.remember("acme/widget", repo, "private");
  await store.transaction(repo, state => {
    state.mode = "apply";
    state.active = ["approved-profile"];
    state.deliveries = { implementation: { profile: "approved-profile", status: "delivered" } };
    state.checkpoint = { sequence: 1, activeDigest: "a".repeat(64) };
  });
  const release = store.lock();
  const backup = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
  try {
    assert.throws(() => backupRuntimeState({ home, out: backup, manifest }), /learning operation.*already|already.*learning operation/);
    assert.equal(existsSync(backup), false);
    assert.equal(existsSync(join(home, "daemon.lock")), false);
    assert.equal(existsSync(join(home, "task-mutation.lock")), false);
  } finally { release(); }
  backupRuntimeState({ home, out: backup, manifest });
  const hashes = readJson(join(backup, "backup.json")).hashes;
  assert.ok(hashes["learning/repositories.json"]);
  assert.equal(Object.keys(hashes).some(path => path.includes("operation.lock")), false);
  restoreRuntimeState({ backup, out: restored, manifest });
  const restoredStore = learningStore(join(canonicalPath(restored), "learning"));
  assert.deepEqual(restoredStore.identities(), store.identities());
  assert.deepEqual(restoredStore.load(repo), store.load(repo));
  const unlock = restoredStore.lock(); unlock();
  const envelope = readJson(join(backup, "backup.json"));
  writeJsonAtomic(join(backup, "backup.json"), { ...envelope, hashes: { ...envelope.hashes, "learning/operation.lock": "a".repeat(64) } });
  const rejected = join(tempHome(), "rejected");
  assert.throws(() => restoreRuntimeState({ backup, out: rejected, manifest }), { code: "RUNTIME_STATE" });
  assert.equal(existsSync(rejected), false);
  assert.equal(existsSync(join(home, "learning/operation.lock")), false);
});
