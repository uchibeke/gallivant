import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { executionRegistry } from "../lib/harness.mjs";
import { executionLive as nodeExecutionLive } from "../lib/execution.mjs";
import { EXECUTION_TRANSPORTS, executionLive, PROVIDER_STATES } from "../lib/execution_contract.mjs";

test("public contract, view and coordinator entries bundle for browsers without Node shims", async () => {
  for (const name of ["task_delivery_contract", "task_delivery_view", "coordinator"]) {
    const result = await build({ entryPoints: [fileURLToPath(new URL(`../lib/${name}.mjs`, import.meta.url))], platform: "browser", format: "esm", bundle: true, write: false, logLevel: "silent" });
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    if (name === "task_delivery_contract") {
      assert.equal(bundled.coordinatorEntryActive({ state: "done" }), false);
      assert.equal(bundled.coordinatorEntryActive({ state: "done", learning_deliveries: { pending: {} } }), true);
      assert.equal(bundled.COMPLETION_CAPABILITIES.defaultTarget, "delivery_ready");
    }
  }
});

test("portable liveness shares the canonical transports and never settles unowned remote work", () => {
  assert.equal(nodeExecutionLive, executionLive, "the Node export uses the same predicate");
  assert.deepEqual(Object.keys(EXECUTION_TRANSPORTS).sort(), Object.keys(executionRegistry).sort());
  for (const [provider, transport] of Object.entries(EXECUTION_TRANSPORTS)) {
    assert.equal(executionRegistry[provider].transport, transport);
    for (const providerState of PROVIDER_STATES) for (const collected of [false, true]) for (const explicitTransport of [false, true]) {
      const execution = { provider, providerState, collected, acceptance: "accepted", providerJobId: "job-1", turnId: "turn-1", ...(explicitTransport ? { transport } : {}) };
      assert.equal(executionLive({ execution }), !collected || !["succeeded", "failed", "cancelled"].includes(providerState));
      if (transport === "remote") for (const missing of [{ acceptance: "unknown" }, { providerJobId: null }, { turnId: " " }])
        assert.equal(executionLive({ execution: { ...execution, ...missing } }), true);
    }
  }
});
