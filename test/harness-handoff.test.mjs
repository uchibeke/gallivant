import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionEpoch, makeExecution } from "../lib/execution.mjs";
import { tempHome } from "./helpers.mjs";

const taskId = "acme/widget/recovery";
const runId = "run-previous-claude";
const oldExecution = {
  version: 1, taskId, provider: "claude", account: "operator", operations: {}, stopped: null,
  current: { id: runId, exit: 1, endedAt: 123, execution: {
    version: 1, taskId, provider: "claude", account: "operator", transport: "cli",
    providerState: "failed", collected: true, sessionId: "claude-session",
  } },
};
const switched = () => ({ pr: 20, state: "pr-open", harness: "codex", session: null,
  last: { run: runId, exit: 1, event: "reset by register" },
  execution: oldExecution.current.execution });

test("settled legacy PR reset selects a new ledger without adopting Claude's current run", async () => {
  const root = join(tempHome(), "runs", "recovery");
  mkdirSync(root, { recursive: true });
  const oldFile = join(root, "execution.json");
  writeFileSync(oldFile, JSON.stringify(oldExecution));
  const original = readFileSync(oldFile, "utf8");
  let parsedOldLines = false;
  const runner = { current: () => ({ id: runId, running: false, exit: 1 }),
    lines: () => { parsedOldLines = true; throw new Error("old provider lines must not be parsed by Codex"); } };
  const epoch = executionEpoch({ root, taskId, entry: switched(), provider: "codex", account: "operator", runner });
  assert.equal(epoch, 1);
  const next = makeExecution({ root, taskId, provider: "codex", runner, ledgerEpoch: epoch, ledgerFile: join(root, `execution-${epoch}.json`) });
  assert.equal(next.state().provider, "codex");
  assert.equal(next.state().current, null);
  assert.equal(next.current(), null, "the new provider has no current run before its first dispatch");
  await assert.rejects(next.continue({ operationId: "attempt-old-session", sessionId: "claude-session" }),
    { code: "EXECUTION_CONTINUATION" });
  assert.equal(parsedOldLines, false, "Codex cannot derive a session from Claude output");
  assert.equal(readFileSync(oldFile, "utf8"), original, "migration only selects a new ledger; it does not rewrite prior ownership");
  assert.equal(executionEpoch({ root, taskId, entry: { ...switched(), execution_epoch: epoch,
    last: { run: "run-new-codex", exit: 0 }, execution: { provider: "codex" } }, provider: "codex", account: "operator", runner }), 1,
  "the durable epoch still selects Codex after a new run replaces the old inference evidence");
});

test("a provider mismatch without exact settled ownership cannot create a new ledger", () => {
  const root = join(tempHome(), "runs", "recovery");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "execution.json"), JSON.stringify(oldExecution));
  const runner = { current: () => ({ id: runId, running: false, exit: 1 }) };
  const allowed = changed => executionEpoch({ root, taskId, entry: { ...switched(), ...changed }, provider: "codex", account: "operator", runner });
  assert.equal(allowed({ session: "claude-session" }), 0);
  assert.equal(allowed({ last: { run: "another-run", exit: 1 } }), 0);
  assert.equal(allowed({ execution: { ...oldExecution.current.execution, account: "another-account" } }), 0);
  assert.equal(executionEpoch({ root, taskId, entry: switched(), provider: "codex", account: "operator",
    runner: { current: () => ({ id: runId, running: true }) } }), 0);
  assert.equal(executionEpoch({ root, taskId, entry: switched(), provider: "codex", account: "other-account", runner }), 0);
});
