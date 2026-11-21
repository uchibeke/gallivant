import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { executionRegistry } from "../lib/harness.mjs";
import { executionLive as nodeExecutionLive } from "../lib/execution.mjs";
import { EXECUTION_TRANSPORTS, executionLive, PROVIDER_STATES } from "../lib/execution_contract.mjs";
import { TASK_OPERATIONS } from "../lib/task_delivery_contract.mjs";
import { MAX_ANSWER_BYTES, MAX_ANSWER_CHARACTERS, MAX_ANSWER_COUNT, MAX_LEGACY_ANSWER_COUNT } from "../lib/task_limits.mjs";
import { recoveryRecord } from "../lib/recovery_observation.mjs";

test("answer tool description exposes the canonical answer batch limits", () => {
  const answer = TASK_OPERATIONS.find(operation => operation.name === "answer");
  assert.match(answer.description, new RegExp(`${MAX_ANSWER_COUNT} answers`));
  assert.match(answer.description, new RegExp(`${MAX_ANSWER_BYTES} combined UTF-8 bytes`));
  assert.match(answer.description, /verification commands/);
  assert.equal(answer.inputSchema.properties.verifyCommands.maxItems, 32);
  assert.match(answer.description, new RegExp(`${MAX_LEGACY_ANSWER_COUNT} saved answers`));
  assert.equal(answer.inputSchema.properties.answers.maxProperties, MAX_LEGACY_ANSWER_COUNT);
  assert.equal(answer.inputSchema.properties.answers.additionalProperties.maxLength, MAX_ANSWER_CHARACTERS);
});

test("public contract, view and coordinator entries bundle for browsers without Node shims", async () => {
  const id = "acme/widget/export";
  const entry = { repo: "acme/widget", state: "needs-human", reason: "no-pr", task: { id: "export", revision: 2 },
    last: { at: "2026-11-10T12:00:00.000Z", run: "first", exit: 1 } };
  const saved = recoveryRecord(id, entry);
  const retry = { ...entry, last: { ...entry.last, run: "second" } };
  retry.recovery_record = recoveryRecord(id, retry, { ...entry, recovery_record: saved });
  for (const name of ["task_delivery_contract", "task_delivery_view", "coordinator", "task_profile", "tracker/presentation"]) {
    const result = await build({ entryPoints: [fileURLToPath(new URL(`../lib/${name}.mjs`, import.meta.url))], platform: "browser", format: "esm", bundle: true, write: false, logLevel: "silent" });
    const bundled = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
    if (name === "task_delivery_contract") {
      assert.equal(bundled.coordinatorEntryActive({ state: "done" }), false);
      assert.equal(bundled.coordinatorEntryActive({ state: "done", learning_deliveries: { pending: {} } }), true);
      assert.equal(bundled.COMPLETION_CAPABILITIES.defaultTarget, "delivery_ready");
      assert.equal(bundled.DELIVERY_CAPABILITIES.defaultAction, "pull_request");
    }
    if (name === "task_profile") {
      // The vendored validator must stay free of Node dependencies.
      assert.equal(bundled.deliveryScreen("Merge it after CI passes.").tier, "question");
      assert.throws(() => bundled.validateDeliveryProfile({ version: 99 }), { code: "TASK_PROFILE_UNSUPPORTED" });
    }
    if (name === "tracker/presentation") {
      const p = bundled.taskPresentation({ entry: { state: "pr-open", reviewPolicy: { version: 1, mode: "first-party-required" },
        reviewBinding: "current", reviewHead: "head", cursor: { fixed_sha: "head" }, firstPartyReview: { status: "running", binding: "current" } } });
      assert.equal(p.phase.id, "independent_review");
      assert.equal(p.review.status, "running");
    }
    if (name === "tracker/presentation" || name === "task_delivery_view") {
      const observe = e => name === "tracker/presentation" ? bundled.taskPresentation({ id, entry: e }).recovery
        : bundled.taskView({ taskId: "export", implementation: { id }, repo: e.repo }, { entry: e }).presentation.recovery;
      assert.equal(observe(entry).incidents[0].id, saved.incidents[0].id, "legacy entries derive the same incident ID in the browser");
      const [incident] = observe(retry).incidents;
      assert.deepEqual(incident, { ...saved.incidents[0], attempts: 1 }, "the browser recognizes the saved scope and original run");
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
