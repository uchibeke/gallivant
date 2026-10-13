import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createTaskDelivery } from "../lib/task_delivery.mjs";
import { createDeliveryStore } from "../lib/task_delivery_store.mjs";
import { CORE_VERSION, taskRejectionForModel } from "../lib/task_delivery_contract.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { executionRegistry } from "../lib/harness.mjs";
import { makeState } from "../lib/state.mjs";
import { migrateRuntimeState } from "../lib/runtime_state.mjs";
import { tempHome, makeClock, silentLog } from "./helpers.mjs";

async function fixture({ lostSubmit = false, lostCancel = false } = {}) {
  const home = tempHome(), clock = makeClock(), state = makeState(home), calls = [], tasks = new Map();
  const scope = { tenant: "alice", account: "alice", region: "US", environment: "preview", scopes: ["task-delivery:read", "task-delivery:write"], repositories: ["widget"] };
  const manifest = { coreVersion: CORE_VERSION, coreSha256: "a".repeat(64), operationVersion: 1, taskVersion: 1, executionVersion: 1 };
  migrateRuntimeState({ home, manifest });
  const providers = new Map(), options = new Map();
  for (const n of [1, 2]) {
    const taskId = "task-" + String(n).repeat(24), id = "acme/widget/" + taskId;
    const owned = { providerJobId: "job-" + n, sessionId: "session-" + n, turnId: "root-" + n };
    providers.set(id, { ...owned, state: "running" });
    const record = name => args => { calls.push({ id, name, args }); };
    const transport = {
      submit: async args => { record("submit")(args); if (lostSubmit && n === 1) throw new Error("lost submit acknowledgement"); return owned; },
      lookup: async args => { record("lookup")(args); return { ...providers.get(id), observedAt: clock.now() }; },
      inspect: async args => { record("inspect")(args); return { ...providers.get(id), observedAt: clock.now(), events: [] }; },
      cancel: async args => { record("cancel")(args); if (lostCancel) { lostCancel = false; throw new Error("lost cancel acknowledgement"); } return { confirmed: false }; },
      collect: () => assert.fail("cancellation must never collect or publish a late result"),
      continue: () => assert.fail("cancellation must never start a new provider turn"),
    };
    options.set(id, { root: join(home, "runs", "run-" + n), taskId: id, provider: "openai-agents", account: "fixture", transport, clock, jitter: () => 0,
      capabilities: { ...executionRegistry["openai-agents"], available: true, controls: { cancel: true, interrupt: false } } });
    const execution = makeExecution(options.get(id));
    try { await execution.submit({ operationId: "original-" + n, inputHead: "b".repeat(40), allowance: { remainingUsd: 1, reservedUsd: 0.1 } }); }
    catch (error) { if (!lostSubmit || n !== 1) throw error; }
    state.put(id, { state: "running", harness: "openai-agents", repo: "acme/widget", last: { run: execution.current().id } });
    tasks.set(taskId, { id: taskId, revision: 1, status: "started", repo: "acme/widget", harness: "openai-agents", requirements: [], context: [], questions: [], attempts: [], implementation: { id } });
  }
  const ctx = { home, state, clock, log: silentLog, config: {}, coordinatorHealth: () => ({ usable: true }), executionFor: id => makeExecution(options.get(id)) };
  const store = createDeliveryStore(join(home, "delivery"));
  await store.transaction(scope, (data, save) => { for (const id of tasks.keys()) data.tasks[id] = { repositoryId: "widget" }; return save(data); });
  let authorized = true, schedules = 0;
  const delivery = () => createTaskDelivery({ manifest, store,
    authorize: async ({ identity, operation }) => {
      if (!authorized || identity !== "alice" || !["control", "inspect"].includes(operation)) throw Object.assign(new Error("controls disabled"), { code: "DELIVERY_AUTHORIZATION" });
      return scope;
    }, contextFor: async () => ({ ctx, repository: { dir: home, repo: "acme/widget" }, taskOptions: { store: { read: id => tasks.get(id) } } }),
    schedule: async () => { schedules++; },
  });
  const taskId = [...tasks.keys()][0], id = tasks.get(taskId).implementation.id;
  return { ctx, clock, calls, options, store, scope, providers, tasks, id, taskId, delivery, revoke: () => { authorized = false; }, schedules: () => schedules,
    input: { taskId, expectedRevision: 1, operationId: "same-cancel", action: "cancel" } };
}

test("stale cancellation settles without effects and permits a fresh owned stop while retaining old identities", async () => {
  const f = await fixture(), stale = { ...f.input, expectedRevision: 2 };
  for (let i = 0; i < 2; i++) await assert.rejects(f.delivery().dispatch("control", stale, "alice"), error => {
    assert.equal(error.code, "DELIVERY_CONFLICT"); assert.ok(taskRejectionForModel(error)); return true;
  });
  assert.equal(f.calls.filter(c => c.name === "cancel").length, 0);
  const receipt = f.store.read(f.scope).cancellations[stale.operationId];
  assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.wakePending, false);
  await assert.rejects(f.delivery().dispatch("control", f.input, "alice"), error => {
    assert.equal(error.code, "DELIVERY_CONFLICT"); assert.equal(taskRejectionForModel(error), null); return true;
  });
  await f.delivery().dispatch("control", { ...f.input, operationId: "fresh-stop" }, "alice");
  assert.equal(f.calls.filter(c => c.name === "cancel").length, 1);
  assert.deepEqual(f.store.read(f.scope).cancellations[stale.operationId], receipt);
  await assert.rejects(f.delivery().dispatch("control", { ...f.input, operationId: "third-stop" }, "alice"), { code: "DELIVERY_CAPACITY" });
});

test("exact cancellation replay with controls disabled reconciles only its durable owned execution after restart", async () => {
  const f = await fixture(), other = f.ctx.state.get([...f.tasks.values()][1].implementation.id);
  await assert.rejects(f.delivery().dispatch("start", { taskId: f.taskId, expectedRevision: 1, operationId: "forbidden", run: true }, "alice"), { code: "DELIVERY_AUTHORIZATION" });
  const first = await f.delivery().dispatch("control", f.input, "alice");
  assert.equal(first.cancellationPending, true);
  assert.equal(f.calls.filter(c => c.name === "cancel").length, 1);
  const request = f.calls.find(c => c.name === "cancel").args;
  assert.equal(request.providerJobId, "job-1"); assert.equal(request.turnId, "root-1");
  f.providers.get(f.id).state = "cancelled"; f.clock.advance(1);
  const recovered = await f.delivery().dispatch("control", f.input, "alice");
  assert.equal(recovered.cancellationPending, false);
  assert.equal(recovered.progress.providerState, "cancelled");
  assert.equal(f.ctx.state.get(f.id).reason, "cancelled");
  assert.deepEqual(f.ctx.state.get([...f.tasks.values()][1].implementation.id), other);
  assert.equal(f.calls.filter(c => c.name === "submit").length, 2);
  assert.ok(f.calls.filter(c => c.name !== "submit").every(c => c.id === f.id));
  assert.equal(f.ctx.executionFor(f.id).state().current.execution.quarantined, true);
  const count = f.calls.length; await f.delivery().dispatch("control", f.input, "alice"); assert.equal(f.calls.length, count);
  await assert.rejects(f.delivery().dispatch("control", { ...f.input, expectedRevision: 2 }, "alice"), { code: "DELIVERY_CONFLICT" });
  f.revoke(); await assert.rejects(f.delivery().dispatch("control", f.input, "alice"), { code: "DELIVERY_AUTHORIZATION" });
  assert.equal(f.calls.length, count);
});

for (const mode of ["lostSubmit", "lostCancel"]) test(`${mode} cancellation keeps original provider ownership and retries the same stop key`, async () => {
  const f = await fixture({ [mode]: true }); f.clock.advance(1);
  assert.equal((await f.delivery().dispatch("control", f.input, "alice")).cancellationPending, true);
  f.clock.advance(1); await f.delivery().dispatch("control", f.input, "alice");
  const cancels = f.calls.filter(c => c.name === "cancel");
  assert.equal(cancels.length, mode === "lostCancel" ? 2 : 1);
  assert.equal(new Set(cancels.map(c => c.args.idempotencyKey)).size, 1);
  assert.ok(cancels.every(c => c.args.providerJobId === "job-1" && c.args.turnId === "root-1"));
  assert.equal(f.calls.filter(c => c.name === "submit").length, 2);
  f.providers.get(f.id).state = "succeeded"; f.clock.advance(1);
  assert.equal((await f.delivery().dispatch("control", f.input, "alice")).cancellationPending, false);
  assert.equal(f.ctx.executionFor(f.id).state().current.execution.quarantined, true);
  assert.match(f.ctx.state.get(f.id).control.message, /already completed/);
});

test("failed durable stop cannot authorize ordinary provider reconciliation", async () => {
  const f = await fixture(), original = f.ctx.executionFor;
  f.ctx.executionFor = id => { const execution = original(id); return { ...execution, cancel: async () => { throw new Error("stop storage unavailable"); }, reconcile: () => assert.fail("unfenced execution must not reconcile") }; };
  await assert.rejects(f.delivery().dispatch("control", f.input, "alice"), /stop storage unavailable/);
  assert.equal(f.store.read(f.scope).cancellations[f.input.operationId].status, "intent");
  assert.equal(f.calls.length, 2);
});
