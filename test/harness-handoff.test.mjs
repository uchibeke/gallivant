import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionEpoch, makeExecution, reserveExecutionEpoch } from "../lib/execution.mjs";
import { prepareRecoveryHandoff } from "../lib/recovery_handoff.mjs";
import { admitFixture } from "./recovery-recipe-fixture.mjs";
import { CONFIG, GOOD_PRD, T0, makeClock, fakeRunner, seededState, tempHome } from "./helpers.mjs";

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
  reserveExecutionEpoch({ root, taskId, provider: "codex", account: "operator", epoch, pr: 20 });
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

test("a missing recorded handoff ledger cannot be silently recreated", () => {
  const root = join(tempHome(), "runs", "recovery");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "execution.json"), JSON.stringify(oldExecution));
  assert.throws(() => executionEpoch({ root, taskId, entry: { ...switched(), execution_epoch: 1 },
    provider: "codex", account: "operator" }), { code: "EXECUTION_OWNERSHIP" });
  assert.equal(existsSync(join(root, "execution-1.json")), false);
});

test("registry loss recovers the latest reserved provider epoch, including A to B to A", () => {
  const root = join(tempHome(), "runs", "recovery");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "execution.json"), JSON.stringify(oldExecution));
  const original = readFileSync(join(root, "execution.json"), "utf8");
  const recovered = harness => ({ pr: 20, harness, session: null, last: { event: "recovered from GitHub" } });

  reserveExecutionEpoch({ root, taskId, provider: "codex", account: "operator", epoch: 1, pr: 20 });
  assert.equal(executionEpoch({ root, taskId, entry: recovered("codex"), provider: "codex", account: "operator" }), 1,
    "the new empty ledger survives loss of last-run and execution fields");
  const pending = { ...switched(), harness: "claude", session: "claude-session", dispatch_stopped: "harness-handoff-pending",
    handoff_pending: { from: "claude", to: "codex", epoch: 1, pr: 20 } };
  assert.equal(executionEpoch({ root, taskId, entry: pending, provider: "claude", account: "operator" }), 0,
    "an interrupted reset may inspect its fenced old ledger to retry");
  assert.throws(() => executionEpoch({ root, taskId, entry: recovered("claude"), provider: "claude", account: "operator" }),
    { code: "EXECUTION_OWNERSHIP" }, "a stale registry cannot reopen Claude epoch zero");

  reserveExecutionEpoch({ root, taskId, provider: "claude", account: "operator", epoch: 2, pr: 20 });
  assert.equal(executionEpoch({ root, taskId, entry: recovered("claude"), provider: "claude", account: "operator" }), 2,
    "returning to Claude still chooses a fresh ledger");
  assert.throws(() => executionEpoch({ root, taskId, entry: { ...recovered("claude"), execution_epoch: 1 }, provider: "claude", account: "operator" }),
    { code: "EXECUTION_OWNERSHIP" }, "an interrupted reset fails closed instead of selecting the stale epoch");
  assert.throws(() => executionEpoch({ root, taskId, entry: { ...recovered("claude"), pr: 21 }, provider: "claude", account: "operator" }),
    { code: "EXECUTION_OWNERSHIP" }, "another PR cannot inherit this ledger merely by reusing the task ID");
  assert.equal(readFileSync(join(root, "execution.json"), "utf8"), original);
});

for (const pr of [null, 142]) test(`automatic capacity handoff preserves the original ledger and reserves one new epoch for PR ${pr}`, async () => {
  const { home, state, id } = seededState({ harness: "codex", pr, url: pr ? "https://github.com/acme/widget/pull/142" : null, state: "needs-human", reason: "provider-network", iteration: 2 });
  const root = join(home, "author");
  mkdirSync(root);
  const target = { harness: "claude", provider: "fixture", model: "target", account: "operator", environment: "isolated",
    dataLocation: "local", credentialRef: "credential:target", capabilities: ["handoff-session"], maxSpendMicros: 50_000 };
  const clock = makeClock(T0), ctx = { home, state, clock, config: { ...CONFIG, harness: { codex: { model: "fixture" }, claude: { model: "target" } } },
    readPrd: () => GOOD_PRD, git: { authorStorage() {} }, checkHarness: async () => ({ ok: true }),
    authorCapabilityEvidence: ({ binding }) => ({ binding, ok: true, expiresAt: clock.now() + 60_000 }),
    gh: { repoPermissions: async () => ({ pullRequestCreate: "proved", apiRepositoryWrite: "proved" }), branchExists: async () => true,
      prListByHead: async () => pr ? [{ number: pr }] : [] } };
  const { profile, run } = admitFixture(ctx, id, "route-handoff", "codex", undefined, [target]);
  Object.assign(run.execution, { recoveryProfileDigest: profile.digest, providerState: "failed" });
  run.exit = 1;
  const before = state.update(id, { last: { run: run.id, exit: 1 }, execution: run.execution,
    network_retry: { phase: "waiting", code: "MODEL_CAPACITY", run: run.id, attempts: 0, first_at: T0, next_at: T0 } });
  const bytes = JSON.stringify({ version: 1, provider: "codex", account: "operator", taskId: id, current: run,
    operations: { [run.execution.operationId]: { acceptance: "accepted", runId: run.id } } });
  writeFileSync(join(root, "execution.json"), bytes);
  const independent = "acme/widget/other-task";
  state.put(independent, { ...before, pr: null, url: null });
  ctx.executionFor = () => ({ root, ledgerEpoch: state.get(id).execution_epoch ?? 0,
    current: () => state.get(id).harness === "codex" ? run : null,
    outcome: () => ({ ok: false, finished: true, error: "Selected model is at capacity. Please try a different model." }) });
  const first = await prepareRecoveryHandoff(ctx, id);
  state.update(independent, { iteration: 3 });
  const replay = await prepareRecoveryHandoff(ctx, id);
  assert.deepEqual(replay.marker, first.marker);
  assert.equal(state.get(id).iteration, 2);
  assert.deepEqual(state.get(id).cursor, before.cursor);
  assert.equal(state.get(independent).iteration, 3);
  assert.equal(state.get(id).session, null);
  assert.notEqual(first.marker.session, run.execution.sessionId);
  assert.equal(state.get(id).recovery_actions.total.paidTurns, 1);
  const epoch = JSON.parse(readFileSync(join(root, "execution-1.json")));
  assert.equal(epoch.handoff.recovery.previousOperation, run.execution.operationId);
  assert.equal(epoch.handoff.recovery.operation, first.marker.operation);
  assert.equal(epoch.handoff.pr, pr);
  const runner = fakeRunner(clock);
  const targetOwner = () => makeExecution({ root, taskId: id, provider: "claude", runner, ledgerEpoch: 1,
    ledgerFile: join(root, "execution-1.json") });
  const input = { operationId: first.marker.operation, previousOperationId: run.execution.operationId,
    recoveryIntent: replay.plan.key, recordedSessionId: replay.marker.session, name: "handoff",
    spec: { cmd: "fixture", args: [], options: {} } };
  await assert.rejects(targetOwner().submit({ ...input, recordedSessionId: "wrong" }), { code: "EXECUTION_OWNERSHIP" });
  replay.plan.executing();
  const accepted = await targetOwner().submit(input, replay.plan.guard);
  assert.equal(accepted.execution.sessionId, replay.marker.session);
  assert.equal((await targetOwner().submit(input)).id, accepted.id);
  assert.equal(runner.started.length, 1);
  await assert.rejects(targetOwner().submit({ ...input, name: "different" }), { code: "EXECUTION_CONFLICT" });
  assert.equal(readFileSync(join(root, "execution.json"), "utf8"), bytes);
});
