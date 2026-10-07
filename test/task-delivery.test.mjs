import { test } from "node:test";
import assert from "node:assert/strict";
import { taskExecutionConfig, taskProviderAllowance } from "../lib/task_allowance.mjs";
import { CORE_VERSION, assertCompatible } from "../lib/task_delivery_contract.mjs";
import { controlAvailability } from "../lib/control_contract.mjs";

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
