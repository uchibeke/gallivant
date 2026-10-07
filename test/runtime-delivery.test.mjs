import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
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
    ["preparing before launch", `tasks/${taskId}/intake.json`, { status: "preparing", attempts: [] }],
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
  await current.wake(); assert.equal(schedules, before.schedules + 1);
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
