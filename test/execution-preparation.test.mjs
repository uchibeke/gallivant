import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { capabilitiesFor, executionCapabilities, preparationReceipt, isPreparationReceipt, buildPreparationRun, buildRun } from "../lib/harness.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { assertPreparationBoundary } from "../lib/task_prepare.mjs";
import { createTaskService } from "../lib/tasks.mjs";
import { taskStore } from "../lib/task_store.mjs";
import { makeState } from "../lib/state.mjs";
import { draftFor } from "./fixtures/task-intake.mjs";
import { CONFIG, tempHome, fakeRunner, harnessBin, silentLog, claudeResultLines } from "./helpers.mjs";

test("preparation capabilities expose policy data and validate the selected provider/account/version", () => {
  const capability = capabilitiesFor("claude"), receipt = preparationReceipt("claude");
  assert.equal(isPreparationReceipt("claude", receipt), true);
  assert.equal(isPreparationReceipt("claude", receipt.boundary), true, "compatible legacy Claude receipt");
  for (const patch of [{ provider: "codex" }, { account: "foreign" }, { version: 2 }, { authority: "unrestricted" }, { boundary: "unknown" }]) assert.equal(isPreparationReceipt("claude", { ...receipt, ...patch }), false);
  assert.equal(isPreparationReceipt("codex", receipt), false);
  assert.equal(isPreparationReceipt("codex", receipt.boundary), false, "another adapter's legacy receipt cannot qualify Codex");
  const publicCapability = executionCapabilities().find(c => c.name === "claude");
  assert.equal(publicCapability.preparation.boundary, capability.preparation.boundary);
  assert.equal(publicCapability.preparation.render, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(publicCapability)), publicCapability);
  for (const provider of ["codex", "gemini", "opencode", "goose", "openai-agents", "codex-cloud"]) assert.equal(capabilitiesFor(provider).preparation ?? null, null);
});

test("shared local preparation preserves selected defaults, tools-off authority and private environment", async () => {
  const root = tempHome(), cwd = join(root, "turn"), runner = fakeRunner(Date);
  const config = { ...CONFIG, harness: { claude: { ...CONFIG.harness.claude, bin: harnessBin(root, "claude") } } };
  const service = makeExecution({ root, taskId: "intake/local", provider: "claude", runner });
  const prepared = await service.prepare({ kind: "intake", environment: "isolated-checkout", config, cwd, callerCwd: root, sourceEnv: { PATH: process.env.PATH, HOME: root, ANTHROPIC_MODEL: "selected-model", UNRELATED_SECRET: "private" }, prompt: "draft" });
  assert.equal(isPreparationReceipt("claude", prepared.receipt), true);
  assert.equal(prepared.receipt.taskId, "intake/local");
  assert.match(prepared.receipt.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(prepared.spec.cmd, config.harness.claude.bin);
  assert.equal(prepared.spec.options.inheritEnv, false);
  assert.equal(prepared.spec.options.env.ANTHROPIC_MODEL, "selected-model");
  assert.equal(prepared.spec.options.env.UNRELATED_SECRET, undefined);
  const ordinary = buildRun({ harness: "claude", config, mode: "start", session: "unused", prompt: "draft", cwd });
  assert.ok(!ordinary.args.includes("--tools"));
  assert.ok(prepared.spec.args.includes("--restricted"));
  assert.equal(prepared.spec.args[prepared.spec.args.indexOf("--tools") + 1], "");
  assert.equal(prepared.spec.args[prepared.spec.args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(service.current(), null, "prepare is not a paid submit");
  await assert.rejects(service.submit({ kind: "intake", operationId: "unqualified", spec: prepared.spec }), { code: "TASK_PREPARATION_BOUNDARY" });
  await assert.rejects(service.submit({ kind: "intake", operationId: "changed-authority", environment: prepared.environment, preparation: prepared.receipt, spec: { ...prepared.spec, args: ordinary.args } }), { code: "TASK_PREPARATION_BOUNDARY" });
  await assert.rejects(service.prepare({ kind: "intake", environment: "isolated-checkout", config, cwd, prompt: "draft" }, { build: opts => ({ ...buildPreparationRun(opts), boundary: "different" }) }), { code: "TASK_PREPARATION_BOUNDARY" });
  assert.equal(runner.started.length, 0);
});

test("local preparation configuration deadlines abort and never issue late authority or launch", async () => {
  const root = tempHome(), config = { ...CONFIG, harness: { claude: { ...CONFIG.harness.claude, bin: harnessBin(root, "claude") } } };
  const runner = fakeRunner(Date), service = makeExecution({ root, taskId: "intake/bounded", provider: "claude", runner, limits: { deadlineMs: 5 } });
  let signal, finish;
  await assert.rejects(service.prepare({ kind: "intake", environment: "isolated-checkout", config, cwd: join(root, "turn"), callerCwd: root, sourceEnv: { HOME: root, PATH: process.env.PATH }, prompt: "draft" }, { build: opts => {
    const spec = buildPreparationRun(opts);
    return { ...spec, configure: (_spec, options) => { signal = options.signal; return new Promise(resolve => { finish = () => resolve(spec); }); } };
  } }), { code: "EXECUTION_DEADLINE" });
  assert.equal(signal.aborted, true); finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.state().preparations, undefined); assert.equal(service.current(), null); assert.equal(runner.started.length, 0);
});

test("remote preparation rejects foreign authority, changed input and cancellation during preparation", async () => {
  const root = tempHome(), calls = [], capabilities = { ...capabilitiesFor("codex"), transport: "remote", environments: ["sandbox"], preparation: { version: 1, boundary: "fixture-v1", authority: "text-only", environment: "sandbox" } };
  let answer = { boundary: "foreign", environment: "sandbox" }, finish;
  const transport = { prepare: async req => { calls.push(req); return answer; }, submit: async () => { throw Error("must not submit"); } };
  const service = makeExecution({ root, taskId: "intake/remote", provider: "codex", transport, capabilities });
  const input = { kind: "intake", environment: "sandbox", prompt: "draft", sourceEnv: { PRIVATE: "secret" }, config: CONFIG };
  await assert.rejects(service.prepare(input), { code: "TASK_PREPARATION_BOUNDARY" });
  assert.equal(calls[0].sourceEnv, undefined); assert.equal(calls[0].config, undefined); assert.equal(service.state().preparations, undefined);
  answer = { boundary: "fixture-v1", environment: "sandbox" };
  const prepared = await service.prepare(input);
  await assert.rejects(service.submit({ kind: "intake", environment: "sandbox", operationId: "changed", prompt: "changed", prepared, preparation: prepared.receipt }), { code: "TASK_PREPARATION_BOUNDARY" });
  transport.prepare = () => new Promise(resolve => { finish = () => resolve(answer); });
  const pending = service.prepare(input); await new Promise(resolve => setImmediate(resolve));
  await service.cancel(); finish(); await assert.rejects(pending, { code: "EXECUTION_STOPPED" });
  assert.equal(service.current(), null);
});

function fixture(provider, { question = false, repair = false, pending = false, lostReply = false, missing = false, lookupAvailable = true, unconfirmedCancel = false, failed = false } = {}) {
  const home = tempHome(), checkout = join(home, "checkout"); mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test", lint: "node --check index.mjs" } }));
  const preparation = { version: 1, boundary: `${provider}-fixture-text-v1`, authority: "text-only", environment: "sandbox" };
  const capabilities = { ...capabilitiesFor(provider), transport: "remote", available: true, environments: ["sandbox"], preparation, controls: { cancel: true, interrupt: false } };
  const account = "fixture-account", calls = [], jobs = new Map(); let current = null;
  const transport = {
    prepare: async req => { calls.push("prepare"); assert.equal(req.provider, provider); assert.equal(req.account, account); assert.equal(req.config, undefined); assert.equal(req.sourceEnv, undefined); return { boundary: preparation.boundary, environment: "sandbox" }; },
    submit: async req => {
      calls.push("submit"); assert.equal(req.spec, undefined); assert.equal(req.preparation.provider, provider);
      assert.ok(req.allowance.reservedUsd > 0); assert.equal(req.kind, "intake");
      const task = taskStore(home).read(req.taskId.split("/").at(-1));
      const job = { providerJobId: `job-${jobs.size + 1}`, turnId: `turn-${jobs.size + 1}`, sessionId: `session-${jobs.size + 1}`, message: repair && jobs.size === 0 ? "invalid JSON" : JSON.stringify(draftFor(task, { question })) };
      jobs.set(req.idempotencyKey, job); current = job;
      if (lostReply) { lostReply = false; throw Error("reply lost"); }
      return job;
    },
    lookup: async req => { calls.push("lookup"); return lookupAvailable ? observe(jobs.get(req.intent.idempotencyKey)) : null; },
    inspect: async () => { calls.push("inspect"); return observe(current); },
    collect: async req => { calls.push("collect"); return { ...req, signal: undefined, outcome: { finished: !missing, ok: !failed, denials: failed ? ["restricted tool refused"] : [], cost: failed ? 0.2 : null,
      lastMessage: current.message, ...(failed ? { error: "provider preparation failed" } : {}) }, ...(failed ? { usage: { inputTokens: 17, api_key: "private" } } : {}) }; },
    cancel: async () => { calls.push("cancel"); return { confirmed: !unconfirmedCancel }; },
  };
  const observe = job => job && ({ providerJobId: job.providerJobId, turnId: job.turnId, sessionId: job.sessionId, state: pending ? "running" : failed ? "failed" : "succeeded", observedAt: Date.now(), events: [] });
  const options = id => ({ root: join(home, "runs", id.split("/").at(-1)), taskId: id, provider, account, transport, capabilities, limits: { progressMs: 0 } });
  const ctx = {
    home, log: silentLog, config: { ...CONFIG, harness: { [provider]: { account } }, deliverable: { ...CONFIG.deliverable, evaluator: "local" } }, state: makeState(home),
    capabilitiesFor: name => name === provider ? capabilities : capabilitiesFor(name),
    executionFor: (id, name) => { assert.equal(name, provider); return makeExecution(options(id)); },
    runnerFor: () => { throw Error("remote preparation must not require a local runner"); },
    git: { toplevel: async () => checkout }, gh: { repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }) },
  };
  let dispatches = 0;
  const reopen = () => createTaskService(ctx, { dispatch: async () => { dispatches++; throw Error("fixture must not dispatch implementation"); } });
  return { ctx, calls, jobs, home, service: reopen(), reopen, dispatches: () => dispatches, complete: () => { pending = false; lookupAvailable = true; }, results: () => { missing = false; } };
}

// Use existing accepted PRD selections with test-only remote capabilities. The
// reserved production providers remain unavailable until their milestones add
// qualified entries; readiness continues to use the unchanged canonical gate.
for (const provider of ["codex", "gemini"]) {
  test(`${provider} fixture preparation shares drafting, clarification, repair and deterministic readiness without CLI/PID`, async t => {
    for (const options of [{}, { question: true }, { repair: true }]) {
      const f = fixture(provider, options);
      let r = await f.service.prepare({ text: "Add CSV export.\nDo not add dependencies.", harness: provider });
      if (options.question) {
        assert.equal(r.status, "needs-input");
        r = await f.reopen().answer({ taskId: r.taskId, expectedRevision: r.revision, operationId: "owner-answer", answers: { "q-r-1": "Use CSV." } });
      }
      assert.equal(r.status, "ready", JSON.stringify(r.failures)); assert.equal(r.readiness.allow, true);
      assert.equal(r.preparation.attempts.length, options.question || options.repair ? 2 : 1);
      assert.equal(r.preparation.repairs, options.repair ? 1 : 0);
      assert.equal(f.calls.filter(c => c === "submit").length, r.preparation.attempts.length);
      assert.ok(r.preparation.attempts.every(a => a.receipt.provider === provider && a.receipt.account === "fixture-account" && a.cost === null && a.reservedUsd > 0));
      assert.match(r.draft.text, /Do not add dependencies/); assert.equal(f.dispatches(), 0); assert.deepEqual(f.ctx.state.entries(), []);
      const before = [...f.calls]; assert.deepEqual(f.reopen().inspect({ taskId: r.taskId }), r); assert.equal(f.reopen().list().tasks.length, 1); assert.deepEqual(f.calls, before);
      t.diagnostic(`Representative preparation fixture (not live qualification): ${r.draft.path}`);
    }
  });
  test(`${provider} fixture lost reply, launcher exit and missing result remain pending without duplicate dispatch`, async () => {
    const f = fixture(provider, { lostReply: true, pending: true, missing: true, lookupAvailable: false });
    let r = await f.service.prepare({ text: "Add CSV export.", harness: provider, requestId: "owned" });
    assert.equal(r.status, "preparing"); assert.equal(r.draft, null); assert.equal(r.readiness, null);
    assert.equal(r.preparation.attempts[0].execution.acceptance, "unknown");
    f.complete();
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, "preparing"); assert.equal(r.readiness, null);
    assert.equal(r.preparation.attempts[0].execution.providerState, "retrieving-results");
    f.results(); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, "ready", JSON.stringify(r.failures)); assert.equal(f.calls.filter(c => c === "submit").length, 1);
    const before = [...f.calls];
    assert.deepEqual(await f.reopen().prepare({ text: "Add CSV export.", harness: provider, requestId: "owned" }), r);
    assert.deepEqual(f.calls, before);
  });
}

test("saved readiness, answer, start and recovery reject receipts borrowed from another selected provider", async () => {
  const f = fixture("codex", { question: true });
  let r = await f.service.prepare({ text: "Add CSV export.", harness: "codex" });
  const store = taskStore(f.home), saved = store.read(r.taskId);
  saved.attempts[0].receipt.provider = "gemini"; store.save(saved);
  const before = [...f.calls];
  assert.throws(() => assertPreparationBoundary(saved, f.ctx), { code: "TASK_PREPARATION_BOUNDARY" });
  await assert.rejects(f.reopen().answer({ taskId: r.taskId, expectedRevision: r.revision, operationId: "borrowed", answers: { "q-r-1": "CSV" } }), { code: "TASK_PREPARATION_BOUNDARY" });
  await assert.rejects(f.reopen().validate({ taskId: r.taskId, expectedRevision: r.revision }), { code: "TASK_PREPARATION_BOUNDARY" });
  await assert.rejects(f.reopen().start({ taskId: r.taskId, expectedRevision: r.revision, run: true }), { code: "TASK_PREPARATION_BOUNDARY" });
  r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "blocked"); assert.equal(r.readiness, null); assert.equal(f.dispatches(), 0); assert.deepEqual(f.calls, before);
});

test("remote preparation timeout requests cancellation, fences dispatch and quarantines late results", async () => {
  const f = fixture("gemini", { pending: true, unconfirmedCancel: true });
  let r = await f.service.prepare({ text: "Add CSV export.", harness: "gemini" });
  const store = taskStore(f.home), saved = store.read(r.taskId); saved.attempts[0].deadline = Date.now() - 1; store.save(saved);
  r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "blocked"); assert.match(r.failures[0], /runtime allowance exhausted/);
  assert.equal(r.preparation.attempts[0].execution.providerState, "cancellation-requested");
  f.complete(); const execution = f.ctx.executionFor(`intake/${r.taskId}`, "gemini"); await execution.reconcile({ force: true });
  await assert.rejects(execution.collect(), { code: "EXECUTION_QUARANTINED" });
  await assert.rejects(execution.submit({ operationId: "replacement" }), { code: "EXECUTION_STOPPED" });
  const calls = [...f.calls];
  await assert.rejects(execution.prepare({ kind: "intake", environment: "sandbox", prompt: "replacement" }), { code: "EXECUTION_STOPPED" });
  assert.deepEqual(f.calls, calls);
  assert.equal(f.calls.filter(c => c === "submit").length, 1); assert.equal(f.dispatches(), 0);
});

test("missing preparation text exhausts canonical repairs instead of masquerading as provider liveness", async () => {
  const f = fixture("codex"); let turns = 0;
  const service = createTaskService(f.ctx, { prepare: async () => { turns++; return null; } });
  const r = await service.prepare({ text: "Add CSV export.", harness: "codex" });
  assert.equal(r.status, "blocked"); assert.match(r.failures[0], /after 3 repair attempts/);
  assert.equal(turns, 4); assert.equal(r.readiness, null); assert.equal(f.calls.length, 0);
});

test("preparation usage projections redact resolved secrets as well as credential-shaped keys", async () => {
  const f = fixture("claude"), runner = fakeRunner(Date), launch = runner.start;
  f.ctx.config.harness.claude = { ...CONFIG.harness.claude, bin: harnessBin(f.home, "claude") };
  f.ctx.env = { HOME: f.home, PATH: process.env.PATH }; f.ctx.capabilitiesFor = capabilitiesFor;
  f.ctx.executionFor = (id, provider) => makeExecution({ root: join(f.home, "local-runs"), taskId: id, provider, runner, secrets: ["opaque-fixture-credential"] });
  runner.start = (...args) => {
    const job = launch(...args), data = JSON.parse(args[2].at(-1).split("INTAKE DATA (JSON):\n").at(-1));
    const lines = claudeResultLines({ text: JSON.stringify(draftFor(data)) });
    lines.push(JSON.stringify({ usage: { input_tokens: 7, detail: "opaque-fixture-credential", token: "private-value" } }));
    runner.finish(lines, { exit: 0 }); return job;
  };
  const r = await f.service.prepare({ text: "Add CSV export.", harness: "claude" });
  assert.equal(r.status, "ready", JSON.stringify(r.failures));
  assert.deepEqual(r.preparation.attempts[0].usage, [{ input_tokens: 7, detail: "[redacted]", token: "[redacted]" }]);
  assert.ok(!JSON.stringify(r).includes("opaque-fixture-credential")); assert.ok(!JSON.stringify(r).includes("private-value"));
});

test("failed preparation retrieves diagnostics and usage before blocking readiness, including restart with missing results", async () => {
  const f = fixture("codex", { failed: true, missing: true });
  let r = await f.service.prepare({ text: "Add CSV export.", harness: "codex", requestId: "failed-preparation" });
  assert.equal(r.status, "preparing"); assert.equal(r.readiness, null); assert.equal(r.draft, null);
  assert.equal(r.preparation.attempts[0].execution.providerState, "retrieving-results");
  assert.equal(r.preparation.attempts[0].execution.terminalState, "failed");
  f.results(); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "blocked"); assert.equal(r.readiness, null); assert.equal(r.draft, null);
  const attempt = r.preparation.attempts[0];
  assert.equal(attempt.settled, true); assert.equal(attempt.ok, false); assert.equal(attempt.cost, 0.2);
  assert.equal(attempt.error, "provider preparation failed; restricted tool refused");
  assert.deepEqual(attempt.usage, { inputTokens: 17, api_key: "[redacted]" });
  assert.equal(attempt.execution.providerState, "failed"); assert.equal(attempt.execution.collected, true);
  const before = [...f.calls];
  r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "blocked"); assert.deepEqual(f.calls, before);
  assert.equal(f.calls.filter(c => c === "submit").length, 1); assert.equal(f.dispatches(), 0);
});
