import { test } from "node:test";
import assert from "node:assert/strict";
import { taskExecutionConfig, taskProviderAllowance } from "../lib/task_allowance.mjs";
import { CORE_VERSION, assertCompatible } from "../lib/task_delivery_contract.mjs";
import { controlAvailability } from "../lib/control_contract.mjs";
import { createTaskDelivery } from "../lib/task_delivery.mjs";

const config = { max_budget_usd: 10, run_timeout_minutes: 30 };
const task = { deliveryAllowance: { budgetUsd: 1, runtimeMs: 60000 } };
const ledger = (costUsd, endedAt = 20000, transport = "cli") => ({
  capabilities: { transport }, state: () => ({ operations: { first: { runId: "one", costUsd } } }),
  current: () => ({ id: "one" }), read: () => ({ startedAt: 10000, endedAt }),
});
test("scoped continuation subtracts paid local work and elapsed runtime; legacy configuration stays compatible", () => {
  assert.equal(taskExecutionConfig(config, null), config);
  assert.deepEqual(taskExecutionConfig(config, task, ledger(0.4)), { max_budget_usd: 0.6, run_timeout_minutes: 50 / 60 });
  assert.deepEqual(taskExecutionConfig(config, task, ledger(null, 20000, "remote")), { max_budget_usd: 1, run_timeout_minutes: 50 / 60 });
  assert.deepEqual(taskExecutionConfig(config, task, ledger(null, null), { excludeRunId: "one" }), { max_budget_usd: 1, run_timeout_minutes: 1 });
});
test("unknown cost/duration, exhausted allowance and absent durable ledger refuse scoped continuation", () => {
  for (const execution of [ledger(null), ledger(1), ledger(0, 70000), ledger(0, null), { current: () => ({ id: "one" }) }]) {
    assert.throws(() => taskExecutionConfig(config, task, execution), { code: "EXECUTION_ALLOWANCE" });
  }
  assert.throws(() => taskProviderAllowance({ remainingUsd: 10, reservedUsd: 2 }, task), { code: "EXECUTION_ALLOWANCE" });
  assert.deepEqual(taskProviderAllowance({ remainingUsd: 10, reservedUsd: 0.1 }, task), { remainingUsd: 1, reservedUsd: 0.1 });
});
test("compatibility handshake binds the pre-1.0 package window and every wire schema", () => {
  const manifest = { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1 };
  assertCompatible(manifest);
  for (const changed of [{ coreVersion: "1.0.0" }, { coreVersion: "0.3.0" }, { operationVersion: 2 }, { taskVersion: 2 }, { executionVersion: 2 }]) {
    assert.throws(() => assertCompatible({ ...manifest, ...changed }), { code: "DELIVERY_VERSION" });
  }
});
test("shared controls never advertise continuation after a retained dispatch stop", () => {
  const controls = controlAvailability({ state: "needs-human", session: "owned", dispatch_stopped: "cancellation-requested", pr: 1 }, null, { controls: { cancel: false } });
  assert.equal(controls.resume, false); assert.equal(controls.message, false); assert.equal(controls.interrupt, false);
  assert.equal(controls.recheck, true); assert.match(controls.cancellation, /may-continue/);
});

test("scoped list limits and truncation depend only on currently authorized tasks", async t => {
  for (const count of [0, 1, 100, 101]) await t.test(`${count} authorized tasks after 101 revoked records`, async () => {
    const tasks = {}, authorizedIds = [], inspected = [], contexts = [];
    for (let i = 0; i < 101 + count; i++) {
      const id = "task-" + i.toString(16).padStart(24, "0");
      tasks[id] = { repositoryId: i < 101 ? "revoked" : "widget" };
      if (i >= 101) authorizedIds.push(id);
    }
    const delivery = createTaskDelivery({
      authorize: async () => ({ tenant: "tenant", account: "alice", region: "ca", environment: "preview", scopes: ["task-delivery:read"], repositories: ["widget"] }),
      store: { read: async () => ({ version: 1, tasks }), transaction: () => assert.fail("list cannot mutate state") },
      schedule: () => assert.fail("list cannot schedule provider reconciliation"),
      contextFor: async (_scope, repoId) => {
        contexts.push(repoId); assert.equal(repoId, "widget");
        return { ctx: { home: "/scoped-home", state: { startClaim: () => null } }, repository: { dir: "/checkout", repo: "acme/widget" },
          taskOptions: { store: { read: id => {
            inspected.push(id); assert.ok(authorizedIds.includes(id));
            return { id, revision: 1, status: "needs-input", repo: "acme/widget", harness: "claude", requirements: [], context: [], questions: [], attempts: [] };
          } } } };
      },
    });
    const listed = await delivery.dispatch("list", {}, "alice");
    assert.deepEqual(listed.tasks.map(task => task.taskId), authorizedIds.slice(0, 100));
    assert.equal(listed.truncated, count > 100);
    assert.deepEqual(inspected, authorizedIds.slice(0, 100));
    assert.equal(contexts.length, Math.min(count, 100));
  });
});

test("capability discovery paginates only authorized repositories and reauthorizes every cursor", async () => {
  let repositories = Array.from({ length: 205 }, (_, i) => `repo-${String(i).padStart(3, "0")}`).reverse();
  const contexts = [], delivery = createTaskDelivery({
    authorize: async ({ identity }) => ({ tenant: "tenant", account: identity, region: "ca", environment: "preview", scopes: ["task-delivery:read"], repositories: identity === "alice" ? repositories : ["bob-only"] }),
    store: { read: () => assert.fail("capabilities cannot read tasks"), transaction: () => assert.fail("capabilities cannot mutate tasks") },
    schedule: () => assert.fail("capabilities cannot schedule providers"),
    contextFor: async (scope, id) => {
      assert.ok(scope.repositories.includes(id)); contexts.push(id);
      return { ctx: { config: { harness: {} } }, repository: { dir: "/checkout", repo: "acme/widget" } };
    },
  });
  const first = await delivery.dispatch("capabilities", {}, "alice");
  assert.equal(first.repositories.length, 100); assert.equal(first.truncated, true); assert.equal(first.nextCursor, "repo-099");
  // Revoking the cursor itself must neither expose that repository nor lose the
  // remaining authorized suffix. New pages never trust the old authorization.
  repositories = repositories.filter(id => id !== "repo-099" && id !== "repo-101");
  const second = await delivery.dispatch("capabilities", { cursor: first.nextCursor }, "alice");
  const third = await delivery.dispatch("capabilities", { cursor: second.nextCursor }, "alice");
  assert.equal(second.repositories.length, 100); assert.equal(second.nextCursor, "repo-200");
  assert.deepEqual(third.repositories.map(r => r.id), ["repo-201", "repo-202", "repo-203", "repo-204"]);
  assert.equal(third.truncated, false); assert.equal(third.nextCursor, null);
  const bob = await delivery.dispatch("capabilities", { cursor: first.nextCursor }, "bob");
  assert.deepEqual(bob.repositories, []); assert.equal(bob.nextCursor, null);
  for (const cursor of ["../outside", 1, "x".repeat(129)]) await assert.rejects(delivery.dispatch("capabilities", { cursor }, "alice"), { code: "DELIVERY_INPUT" });
  repositories = Array.from({ length: 100 }, (_, i) => `repo-${String(i).padStart(3, "0")}`);
  const exact = await delivery.dispatch("capabilities", {}, "alice");
  assert.equal(exact.repositories.length, 100); assert.equal(exact.truncated, false); assert.equal(exact.nextCursor, null);
  const before = contexts.length;
  repositories = [];
  assert.equal((await delivery.dispatch("capabilities", {}, "alice")).truncated, false);
  assert.equal(contexts.length, before);
});
