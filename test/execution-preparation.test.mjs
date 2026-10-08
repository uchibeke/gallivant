import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
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
  assert.equal(preparationReceipt("codex").authority, "sandboxed-draft");
  assert.equal(isPreparationReceipt("codex", preparationReceipt("codex")), true);
  for (const provider of ["gemini", "opencode", "goose", "codex-cloud"]) assert.equal(capabilitiesFor(provider).preparation ?? null, null);
  assert.equal(preparationReceipt("openai-agents").authority, "text-only");
  assert.equal(capabilitiesFor("openai-agents").preparation.environment, "none");
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

function fixture(provider, { question = false, repair = false, pending = false, lostReply = false, missing = false, lookupAvailable = true, unconfirmedCancel = false, cancelErrors = 0, cancelSupported = true, failed = false, observationCost, progressMs = 0 } = {}) {
  const home = tempHome(), checkout = join(home, "checkout"); mkdirSync(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { test: "node --test", lint: "node --check index.mjs" } }));
  const preparation = { version: 1, boundary: `${provider}-fixture-text-v1`, authority: "text-only", environment: "sandbox" };
  const capabilities = { ...capabilitiesFor(provider), transport: "remote", available: true, environments: ["sandbox"], preparation, controls: { cancel: cancelSupported, interrupt: false } };
  const account = "fixture-account", calls = [], jobs = new Map(), cancellations = []; let current = null, stopped = false, observationCompletion, resultCompletion;
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
    collect: async req => { calls.push("collect"); return { ...req, signal: undefined, completedAt: resultCompletion, outcome: { finished: !missing, ok: !failed, denials: failed ? ["restricted tool refused"] : [], cost: failed ? 0.2 : null,
      lastMessage: current.message, ...(failed ? { error: "provider preparation failed" } : {}) }, ...(failed ? { usage: { inputTokens: 17, api_key: "private" } } : {}) }; },
    cancel: async req => { calls.push("cancel"); cancellations.push({ key: req.idempotencyKey, job: req.providerJobId, turn: req.turnId }); if (cancelErrors-- > 0) throw Error("stop reply lost: Bearer private-fixture-value"); return { confirmed: !unconfirmedCancel }; },
  };
  const observe = job => job && ({ providerJobId: job.providerJobId, turnId: job.turnId, sessionId: job.sessionId, state: stopped ? "cancelled" : pending ? "running" : failed ? "failed" : "succeeded", completedAt: observationCompletion, costUsd: observationCost, observedAt: Date.now(), events: [] });
  const options = id => ({ root: join(home, "runs", id.split("/").at(-1)), taskId: id, provider, account, transport, capabilities, limits: { progressMs }, jitter: () => 0 });
  const ctx = {
    home, log: silentLog, config: { ...CONFIG, harness: { [provider]: { account } }, deliverable: { ...CONFIG.deliverable, evaluator: "local" } }, state: makeState(home),
    capabilitiesFor: name => name === provider ? capabilities : capabilitiesFor(name),
    executionFor: (id, name) => { assert.equal(name, provider); return makeExecution(options(id)); },
    runnerFor: () => { throw Error("remote preparation must not require a local runner"); },
    git: { toplevel: async () => checkout }, gh: { repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }) },
  };
  let dispatches = 0;
  const reopen = () => createTaskService(ctx, { dispatch: async () => { dispatches++; throw Error("fixture must not dispatch implementation"); } });
  return { ctx, calls, jobs, home, transport, cancellations, service: reopen(), reopen, dispatches: () => dispatches, complete: () => { pending = false; lookupAvailable = true; }, results: () => { missing = false; }, reportCost: cost => { observationCost = cost; },
    reportCompletion: (observation, result = observation) => { observationCompletion = observation; resultCompletion = result; }, stop: () => { stopped = true; lookupAvailable = true; }, resolveLookup: () => { lookupAvailable = true; } };
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
  assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].settled, false); assert.match(r.nextAction, /resume the owned cancellation/);
  assert.equal(r.preparation.attempts[0].execution.providerState, "cancellation-requested");
  f.complete(); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "blocked"); assert.match(r.failures[0], /runtime allowance exhausted/);
  assert.equal(r.preparation.attempts[0].cancellation.status, "terminal");
  const execution = f.ctx.executionFor(`intake/${r.taskId}`, "gemini");
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

test("preparation usage hides overlapping resolved credentials in either supplied order", async () => {
  const short = "opaque-preparation", long = `${short}-hidden-suffix`;
  for (const secrets of [[short, long], [long, short]]) {
    const f = fixture("claude"), runner = fakeRunner(Date), launch = runner.start;
    f.ctx.config.harness.claude = { ...CONFIG.harness.claude, bin: harnessBin(f.home, "claude") };
    f.ctx.env = { HOME: f.home, PATH: process.env.PATH }; f.ctx.capabilitiesFor = capabilitiesFor;
    f.ctx.executionFor = (id, provider) => makeExecution({ root: join(f.home, "local-runs"), taskId: id, provider, runner, secrets });
    runner.start = (...args) => {
      const job = launch(...args), data = JSON.parse(args[2].at(-1).split("INTAKE DATA (JSON):\n").at(-1));
      const lines = claudeResultLines({ text: JSON.stringify(draftFor(data)) });
      lines.push(JSON.stringify({ usage: { detail: `${long} / ${short}`, input_tokens: 7 } }));
      runner.finish(lines, { exit: 0 }); return job;
    };
    const result = await f.service.prepare({ text: "Add CSV export.", harness: "claude" });
    assert.equal(result.status, "ready", JSON.stringify(result.failures));
    assert.deepEqual(result.preparation.attempts[0].usage, [{ detail: "[redacted] / [redacted]", input_tokens: 7 }]);
    assert.doesNotMatch(JSON.stringify(result), /opaque-preparation|hidden-suffix/);
  }
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

test("contradictory preparation results retain the authoritative outcome without readiness, repair or implementation dispatch", async () => {
  for (const failed of [true, false]) {
    const f = fixture("codex", { failed }), collect = f.transport.collect;
    f.transport.collect = async req => {
      const result = await collect(req);
      return { ...result, outcome: { ...result.outcome, ok: failed } };
    };
    let r = await f.service.prepare({ text: "Add CSV export.", harness: "codex" });
    for (let i = 0; i < 2; i++) {
      assert.equal(r.status, "preparing"); assert.equal(r.readiness, null); assert.equal(r.draft, null);
      assert.equal(r.preparation.attempts.length, 1); assert.equal(r.preparation.repairs, 0);
      assert.equal(r.preparation.attempts[0].settled, false);
      assert.equal(r.preparation.attempts[0].execution.terminalState, failed ? "failed" : "succeeded");
      assert.equal(r.preparation.attempts[0].execution.collected, false);
      assert.match(r.preparation.attempts[0].recoveryAction, /contradicts the authoritative terminal root/);
      r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    }
    f.transport.collect = collect;
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, failed ? "blocked" : "ready");
    assert.equal(r.preparation.attempts[0].ok, !failed);
    assert.equal(f.calls.filter(c => c === "submit").length, 1); assert.equal(f.dispatches(), 0);
  }
});

test("preparation settlement retains known cost across lower observations and null result usage", async () => {
  const f = fixture("codex", { missing: true, observationCost: 0.6 });
  let r = await f.service.prepare({ text: "Add CSV export.", harness: "codex", requestId: "preparation-cost" });
  assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].execution.costUsd, 0.6);
  f.reportCost(0.2); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].execution.costUsd, 0.6);
  f.reportCost(null); f.results(); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "ready"); assert.equal(r.preparation.attempts[0].cost, 0.6);
  assert.equal(r.preparation.attempts[0].execution.costUsd, 0.6);
  const calls = [...f.calls]; assert.equal(f.reopen().inspect({ taskId: r.taskId }).preparation.attempts[0].cost, 0.6);
  assert.deepEqual(f.calls, calls); assert.equal(f.calls.filter(c => c === "submit").length, 1); assert.equal(f.dispatches(), 0);
});

test("remote preparation uses owned completion time before a late resume, including missing results and inferred bounds", async t => {
  let wall = 10_000; t.mock.method(Date, "now", () => wall);
  const evidence = [];
  for (const mode of ["inspection", "result", "observed-bound", "late", "unknown", "deadline", "failed", "cached"]) {
    wall = 10_000;
    const f = fixture("codex", { pending: true, missing: true, failed: mode === "failed" });
    let r = await f.service.prepare({ text: "Add CSV export.", harness: "codex" });
    const store = taskStore(f.home), saved = store.read(r.taskId); saved.attempts[0].deadline = 10_500; store.save(saved);
    const time = mode === "late" ? 10_800 : mode === "deadline" ? 10_500 : 10_300;
    f.reportCompletion(["result", "observed-bound", "unknown"].includes(mode) ? undefined : time, ["observed-bound", "unknown"].includes(mode) ? null : time);
    f.complete(); wall = ["inspection", "observed-bound", "failed", "cached"].includes(mode) ? 10_400 : 20_000;
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].execution.providerState, "retrieving-results");
    f.results();
    if (mode === "cached") {
      const execution = f.ctx.executionFor(`intake/${r.taskId}`, "codex"); await execution.collect();
      const legacy = execution.state(); legacy.current.endedAt = 20_000; delete legacy.current.execution.completedAt; delete legacy.current.execution.terminalObservedAt; delete legacy.current.completionInferred;
      writeJsonAtomic(join(execution.root, "execution.json"), legacy);
    }
    wall = 20_000; r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    const attempt = r.preparation.attempts[0], late = mode === "late" || mode === "unknown";
    assert.equal(r.status, late || mode === "failed" ? "blocked" : "ready", mode);
    assert.equal(attempt.endedAt, mode === "observed-bound" ? 10_400 : mode === "unknown" ? 20_000 : time);
    assert.equal(attempt.elapsedMs, attempt.endedAt - 10_000);
    assert.equal(attempt.completionInferred, mode === "observed-bound" || mode === "unknown");
    assert.equal(attempt.settled, true); assert.equal(attempt.cost, mode === "failed" ? 0.2 : null);
    assert.equal(f.calls.filter(c => c === "cancel").length, 0); assert.equal(f.calls.filter(c => c === "submit").length, 1);
    assert.equal(f.dispatches(), 0); assert.deepEqual(f.ctx.state.entries(), []);
    if (late) { assert.match(r.failures[0], /runtime allowance exhausted/); assert.equal(r.readiness, null); assert.equal(r.draft, null); }
    if (mode === "failed") { assert.match(r.failures[0], /restricted tool refused/); assert.deepEqual(attempt.usage, { inputTokens: 17, api_key: "[redacted]" }); }
    const before = [...f.calls]; await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision }); assert.deepEqual(f.calls, before);
    const execution = f.ctx.executionFor(`intake/${r.taskId}`, "codex");
    evidence.push({ mode, taskId: r.taskId, status: r.status, endedAt: attempt.endedAt, elapsedMs: attempt.elapsedMs, inferred: attempt.completionInferred, state: attempt.execution, calls: f.calls, files: { intake: join(f.home, "tasks", r.taskId, "intake.json"), result: join(execution.dirOf(attempt.run), "result.json") } });
  }
  const file = join(tempHome(), "preparation-completion-evidence.json"); writeJsonAtomic(file, { kind: "Offline owned preparation completion fixtures", cases: evidence });
  t.diagnostic(`preparation completion evidence: ${file}`);
});

test("invalid or conflicting remote completion timestamps cannot authorize preparation readiness or rewrite cached results", async t => {
  let wall = 10_000; t.mock.method(Date, "now", () => wall);
  for (const invalid of [9999, 20_001, "2026-10-06", -1, "nonterminal"]) {
    wall = 10_000; const f = fixture("gemini", { pending: true });
    let r = await f.service.prepare({ text: "Add CSV export.", harness: "gemini" });
    wall = 20_000; if (invalid !== "nonterminal") f.complete(); f.reportCompletion(invalid === "nonterminal" ? 10_100 : invalid);
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].execution.providerState, "status-unknown");
    assert.equal(r.preparation.attempts[0].execution.recoveryAction, "EXECUTION_PROTOCOL"); assert.equal(r.readiness, null);
    assert.equal(f.calls.filter(c => c === "collect").length, 0);
  }
  wall = 10_000; const unknown = fixture("gemini", { pending: true, lostReply: true, lookupAvailable: false });
  let pending = await unknown.service.prepare({ text: "Add CSV export.", harness: "gemini" });
  unknown.transport.lookup = async () => ({ ...unknown.jobs.values().next().value, state: "succeeded", observedAt: 9999, completedAt: null, events: [] });
  wall = 20_000; pending = await unknown.reopen().resume({ taskId: pending.taskId, expectedRevision: pending.revision });
  assert.equal(pending.status, "preparing"); assert.equal(pending.preparation.attempts[0].execution.recoveryAction, "EXECUTION_STALE");
  assert.equal(pending.preparation.attempts[0].execution.acceptance, "unknown"); assert.equal(unknown.calls.includes("collect"), false);
  wall = 10_000; const f = fixture("gemini", { pending: true });
  let r = await f.service.prepare({ text: "Add CSV export.", harness: "gemini" });
  const store = taskStore(f.home), task = store.read(r.taskId); task.attempts[0].deadline = 10_500; store.save(task);
  wall = 20_000; f.complete(); f.reportCompletion(10_300, 10_301);
  r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "preparing"); assert.equal(r.readiness, null); assert.match(r.preparation.attempts[0].recoveryAction, /completion time differs/);
  assert.equal(f.calls.includes("cancel"), false);
  f.reportCompletion(10_300); r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "ready"); assert.equal(r.preparation.attempts[0].endedAt, 10_300);
  const execution = f.ctx.executionFor(`intake/${r.taskId}`, "gemini"), file = join(execution.dirOf(r.preparation.attempts[0].run), "result.json"), result = readJson(file);
  writeJsonAtomic(file, { ...result, completedAt: 10_301 });
  await assert.rejects(execution.collect(), /result completion time differs/);
  assert.equal(execution.current().endedAt, 10_300); assert.equal(f.calls.filter(c => c === "submit").length, 1);
  const cachedTask = store.read(r.taskId); cachedTask.status = "preparing"; cachedTask.readiness = null;
  cachedTask.attempts[0].settled = false; cachedTask.attempts[0].consumed = false; store.save(cachedTask);
  r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
  assert.equal(r.status, "preparing"); assert.equal(r.readiness, null); assert.match(r.preparation.attempts[0].recoveryAction, /completion time differs/);
  assert.equal(f.calls.includes("cancel"), false); assert.equal(f.dispatches(), 0);
});

test("timed-out intake stop remains resumable across acknowledgement loss, unknown ownership, unsupported cancel and legacy blocking", async t => {
  let wall = 10_000; t.mock.method(Date, "now", () => wall);
  const evidence = [];
  for (const mode of ["acknowledged", "lost-reply", "unknown-owner", "unsupported", "legacy-blocked", "unsafe"]) {
    wall = 10_000;
    const f = fixture("gemini", { pending: true, unconfirmedCancel: mode !== "lost-reply", cancelErrors: mode === "lost-reply" ? 1 : 0,
      cancelSupported: mode !== "unsupported", lostReply: mode === "unknown-owner", lookupAvailable: mode !== "unknown-owner", progressMs: 500 });
    let r = await f.service.prepare({ text: "Add CSV export.", harness: "gemini" });
    const store = taskStore(f.home), saved = store.read(r.taskId); saved.attempts[0].deadline = 10_500;
    if (mode === "unsafe") saved.attempts[0].receipt.boundary = "foreign";
    store.save(saved); wall = 11_000;
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    assert.equal(r.status, "preparing"); assert.equal(r.preparation.attempts[0].settled, false); assert.equal(r.readiness, null);
    assert.equal(r.preparation.attempts[0].cancellation.status, "pending"); assert.match(r.nextAction, /resume the owned cancellation/);
    const boundary = f.ctx.executionFor(`intake/${r.taskId}`, "gemini");
    await assert.rejects(boundary.submit({ operationId: "new-paid-turn" }), { code: "EXECUTION_STOPPED" });
    const beforeReads = [...f.calls]; f.reopen().inspect({ taskId: r.taskId }); f.reopen().list(); assert.deepEqual(f.calls, beforeReads);
    assert.ok(!JSON.stringify(r).includes("private-fixture-value"));
    if (mode === "legacy-blocked") {
      const old = store.read(r.taskId); old.status = "blocked"; old.errorCode = "TASK_ALLOWANCE"; old.attempts[0].settled = true; delete old.attempts[0].cancellation; store.save(old);
    }
    if (mode === "unknown-owner") f.resolveLookup();
    if (mode === "lost-reply") {
      const attempts = f.cancellations.length;
      await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision }); assert.equal(f.cancellations.length, attempts, "saved backoff prevents immediate cancellation replay");
      wall = boundary.current().execution.cancellation.nextAttemptAt;
    } else { wall = 20_000; if (mode === "unsupported") f.complete(); else if (mode !== "unknown-owner") f.stop(); }
    r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision });
    if (mode === "unknown-owner") { assert.equal(r.status, "preparing"); assert.equal(f.cancellations.length, 1); f.stop(); wall += 500; r = await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision }); }
    assert.equal(r.status, "blocked"); assert.equal(r.readiness, null); assert.equal(r.draft, null); assert.equal(r.preparation.attempts[0].settled, true);
    assert.match(r.failures[0], mode === "unsafe" ? /unverified tool boundary/ : /runtime allowance exhausted/);
    assert.equal(r.preparation.attempts[0].cancellation.status, mode === "unsupported" ? "terminal" : "confirmed");
    assert.equal(boundary.current().execution.quarantined, true);
    await assert.rejects(boundary.collect(), { code: "EXECUTION_QUARANTINED" });
    assert.equal(f.calls.filter(c => c === "submit").length, 1); assert.equal(f.dispatches(), 0);
    if (mode === "lost-reply") { assert.equal(f.cancellations.length, 2); assert.deepEqual(f.cancellations[0], f.cancellations[1]); }
    const before = [...f.calls]; await f.reopen().resume({ taskId: r.taskId, expectedRevision: r.revision }); assert.deepEqual(f.calls, before);
    evidence.push({ mode, status: r.status, cancellation: r.preparation.attempts[0].cancellation, execution: boundary.current().execution, calls: f.calls, requests: f.cancellations, files: { intake: join(f.home, "tasks", r.taskId, "intake.json"), execution: join(boundary.root, "execution.json") } });
  }
  const file = join(tempHome(), "preparation-stop-evidence.json"); writeJsonAtomic(file, { kind: "Offline resumable owned preparation stop fixtures", cases: evidence });
  t.diagnostic(`preparation stop evidence: ${file}`);
});
