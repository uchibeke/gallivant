import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, symlinkSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createTaskService } from "gallivant/tasks";
import { createTaskDelivery } from "gallivant/task-delivery";
import { createDeliveryStore } from "gallivant/task-delivery/store";
import { CORE_VERSION, TASK_OPERATIONS, assertCompatible, uiResourceConfiguration } from "gallivant/task-delivery/contracts";
import { registerTaskDelivery } from "gallivant/task-delivery/mcp";
import { createCoordinator } from "gallivant/runtime/coordinator";
import { createNodeCoordinator, createNodeOwnerStore, NODE_RUNTIME_REQUIREMENTS } from "gallivant/runtime/node";
import { checkRuntimeState, migrateRuntimeState, backupRuntimeState, restoreRuntimeState } from "gallivant/runtime/state";
import { makeState, MIN_VERSIONS, appendProjection, writeJsonAtomic, criteriaFromPrd, parsePrd, requestControl } from "gallivant/runtime/node/dependencies";
import { makeExecution } from "gallivant/execution";
import { executionCapabilities, capabilitiesFor } from "gallivant/capabilities";
import { makeAgentsTransport } from "gallivant/providers/openai-agents";
import { makeCloudTransport } from "gallivant/providers/codex-cloud";
import { buildPluginPackage } from "gallivant/plugin-package";
import { CONFIG, tempHome, harnessBin, fakeRunner, makeClock, fakeCredential, fakeIdentity, silentLog, fakeGh, fakeGit, fakeNotify, claudeResultLines, prFixture, checkRun } from "./helpers.mjs";
import { draftFor } from "./draft.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const candidate = JSON.parse(readFileSync(new URL("candidate.json", import.meta.url))), manifest = JSON.parse(readFileSync(join(candidate.out, "runtime.json")));
const resource = manifest.resource;
const request = "Add CSV export for the widget table.\nDo not add dependencies.";
const scope = account => ({ tenant: "tenant", account, region: "ca", environment: "preview", scopes: ["task-delivery:read", "task-delivery:write"], repositories: ["widget"] });

function world({ question = true, schedule = async () => {} } = {}) {
  const root = tempHome(), worlds = new Map();
  const contextFor = async (s, repositoryId) => {
    if (!worlds.has(s.account)) {
      const home = join(root, s.account), checkout = join(home, "checkout"); mkdirSync(checkout, { recursive: true });
      writeFileSync(join(checkout, "package.json"), JSON.stringify({ packageManager: "npm@10.0.0", scripts: { test: "node --test", lint: "node --check index.mjs" } }));
      writeFileSync(join(checkout, "AGENTS.md"), "Verify with `npm test` and `npm run lint`.\n");
      const runners = new Map(), snapshots = new Map(), sources = new Map();
      const ctx = { home, config: { ...CONFIG, home, worktrees: join(home, "worktrees"), harness: { claude: { bin: harnessBin(home, "claude"), settings: null } }, deliverable: { ...CONFIG.deliverable, evaluator: "local", enabled: false }, reviewer: null },
        state: makeState(home), log: silentLog, clock: makeClock(), ownLogin: "me", credential: fakeCredential(), identity: fakeIdentity(), notify: fakeNotify(),
        gh: { ...fakeGh({ pr: prFixture({ number: 7, headRefName: "work/widget", statusCheckRollup: [checkRun({ name: "unit", conclusion: "SUCCESS" })] }) }), repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }), branchExists: async () => true, ensureLabels: async () => {} },
        git: { ...fakeGit(), toplevel: async () => checkout, create: async ({ prdId }) => { const p = join(home, "worktrees/acme/widget", prdId); mkdirSync(p, { recursive: true }); return p; } },
        runnerFor: id => { if (!runners.has(id)) runners.set(id, fakeRunner(makeClock())); return runners.get(id); },
        writePrd: (id, text) => snapshots.set(id, text), readPrd: id => snapshots.get(id), writeSource: (id, path, text) => sources.set(id + path, text), readSource: (id, path) => sources.get(id + path),
      };
      worlds.set(s.account, { ctx, runners, taskOptions: { prepare: async (_ctx, task) => JSON.stringify(draftFor(task, { question })) }, repository: { dir: checkout, repo: "acme/widget", context: { instructions: "AGENTS.md" } } });
    }
    assert.equal(repositoryId, "widget"); return { ...worlds.get(s.account) };
  };
  const store = createDeliveryStore(join(root, "delivery"));
  const opts = { store, contextFor, schedule, secretsFor: () => ["private-provider-value"], authorize: async ({ identity, requiredScope }) => {
    if (!["alice", "bob"].includes(identity)) throw Object.assign(new Error("unauthorized"), { code: "DELIVERY_AUTHORIZATION" });
    assert.ok(["task-delivery:read", "task-delivery:write"].includes(requiredScope)); return scope(identity);
  } };
  return { root, worlds, opts, delivery: createTaskDelivery(opts), contextFor };
}
const prepare = (operationId = "prepare", text = request) => ({ repositoryId: "widget", text, harness: "claude", allowance: { budgetUsd: 1, runtimeMs: 60000 }, operationId, expectedRevision: 0 });
const mutate = (task, operationId) => ({ taskId: task.taskId, expectedRevision: task.revision, operationId });

test("installed documented imports have no user-config/daemon effects and preserve both providers", () => {
  assert.equal(CORE_VERSION, "0.2.0"); assert.equal(typeof createTaskService, "function");
  assert.equal(typeof makeAgentsTransport, "function"); assert.equal(typeof makeCloudTransport, "function");
  assert.ok(executionCapabilities().some(p => p.name === "openai-agents") && executionCapabilities().some(p => p.name === "codex-cloud"));
  assert.equal(capabilitiesFor("codex-cloud").available, false, "inherited safety block is preserved");
  assert.equal(existsSync(process.env.GALLIVANT_HOME), false);
  assert.equal(MIN_VERSIONS.codex, "0.158.0");
});

test("the actual installed packager retains its dependency lock and can rebuild a labeled internal package", () => {
  const root = tempHome(), ui = join(root, "ui.html"); writeFileSync(ui, "<!doctype html><p>Internal resource fixture only.</p>");
  const built = buildPluginPackage({ out: join(root, "out"), coreVersion: CORE_VERSION, sourceCommit: manifest.sourceCommit, internal: true,
    config: { publisher: "APort", fixture: true, endpoint: "https://example.com/mcp", resource: { uri: "ui://task-delivery/app", domain: "https://example.com" }, assets: { ui } } });
  assert.equal(built.submissionReady, false); assert.equal(built.sourceVerified, false);
  assert.equal(built.dependencyLockSha256, manifest.dependencyLockSha256);
  assert.ok(built.payloadHashes["npm-shrinkwrap.json"]);
});

test("installed scoped API prepares, answers, validates, starts once and follows canonical review/control decisions", async () => {
  const w = world(); let task = await w.delivery.dispatch("prepare", prepare(), "alice");
  assert.equal(task.status, "needs-input"); assert.equal(task.allowance.budgetUsd, 1);
  assert.equal(task.revision, (await w.delivery.dispatch("prepare", prepare(), "alice")).revision);
  const first = task;
  task = await w.delivery.dispatch("answer", { ...mutate(task, "answer"), answers: { "q-r-1": "Use CSV." } }, "alice");
  assert.equal(task.status, "ready"); assert.match(task.brief.text, /Do not add dependencies/);
  await assert.rejects(w.delivery.dispatch("validate", { ...mutate(first, "stale") }, "alice"), { code: "DELIVERY_CONFLICT" });
  task = await w.delivery.dispatch("validate", mutate(task, "validate"), "alice");
  task = await w.delivery.dispatch("start", { ...mutate(task, "start"), run: true }, "alice");
  assert.equal(task.status, "started", task.failures?.join(";"));
  const again = await w.delivery.dispatch("start", { ...mutate({ ...task, revision: first.revision }, "start") , run: true }, "alice").catch(e => e);
  assert.equal(again.code, "DELIVERY_CONFLICT");
  const ctx = w.worlds.get("alice").ctx, id = task.implementation.id, runner = ctx.runnerFor(id);
  assert.equal(runner.started.length, 1); assert.equal(ctx.state.get(id).task.id, task.taskId);
  assert.equal(ctx.state.get(id).task.deliveryAllowance.budgetUsd, 1);
  assert.equal(ctx.state.get(id).task.deliveryAllowance.runtimeMs, 60000);
  const evidence = await w.delivery.dispatch("evidence", { taskId: task.taskId }, "alice");
  assert.ok(evidence.artifacts.some(a => a.id === "brief")); assert.equal(evidence.brief.hash, task.brief.hash);
  assert.ok(!JSON.stringify(task).includes(ctx.home));
  const logDir = join(ctx.home, "runs", id.replaceAll("/", "__"), task.implementation.run); mkdirSync(logDir, { recursive: true });
  appendProjection(logDir, "private-provider-value sk-aaaaaaaaaaaaaaaaaaaa");
  const logs = await w.delivery.dispatch("logs", { taskId: task.taskId, count: 10 }, "alice"); assert.doesNotMatch(JSON.stringify(logs), /private-provider-value|sk-aaaa/);
  // The same coordinator evaluates GitHub checks; no UI poller advances work.
  runner.finish(claudeResultLines({ session: "6f1c2d3e-1111-4111-8111-111111111111" }), { exit: 0 });
  ctx.state.update(id, { state: "pr-open", pr: 7, session: "6f1c2d3e-1111-4111-8111-111111111111", last: { at: "2026-01-01T00:00:00Z", run: task.implementation.run, exit: 0 } });
  const criteria = criteriaFromPrd(parsePrd(task.brief.text, "brief.md"));
  ctx.gh.data.pr.body = "Adds CSV export.\n\n```work-attestations\n" + JSON.stringify({ task_id: id, output_type: "code", summary: "Added the scoped widget CSV export and preserved the dependency contract, with deterministic current revision checks and saved artifact identities for reviewer inspection.", criteria_attestations: criteria.map(c => ({ criterion_id: c.id, met: true, evidence: "fixture current-head check: unit" })) }) + "\n```";
  migrateRuntimeState({ home: ctx.home, manifest });
  const coordinator = createNodeCoordinator({ ctx, store: createNodeOwnerStore({ home: ctx.home, durable: true }), schedule: async () => {}, manifest });
  const results = await coordinator.wake();
  const viewed = await w.delivery.dispatch("inspect", { taskId: task.taskId }, "alice");
  assert.equal(viewed.implementation.url, "https://github.com/acme/widget/pull/7");
  assert.equal(viewed.progress.workflowState, "ready-for-human", JSON.stringify({ results, entry: ctx.state.get(id) }));
  const input = { ...mutate(viewed, "cancel"), action: "cancel" };
  await w.delivery.dispatch("control", input, "alice"); await createTaskDelivery(w.opts).dispatch("control", input, "alice");
  const controlId = ctx.state.get(id).control.id; await coordinator.wake();
  assert.equal(ctx.state.get(id).control.id, controlId); assert.equal(runner.started.length, 1);
  // A lost adapter acknowledgement can arrive after a later request moved the
  // original to history. Its stable identity must still never enqueue again.
  const old = ctx.state.get(id).control;
  ctx.state.update(id, { control: { ...old, id: "later", action: "recheck", status: "applied" }, control_history: [old] });
  assert.equal(requestControl(ctx, { handle: id, action: "cancel", requestId: controlId }).id, controlId);
  assert.equal(ctx.state.get(id).control.id, "later");
  assert.throws(() => requestControl(ctx, { handle: id, action: "resume", requestId: "new-resume" }), /Further dispatch is stopped/);
  assert.equal(ctx.state.get(id).control.id, "later");
});

test("mutation acknowledgement schedules recovery once; lost wake reply never repeats inference", async () => {
  let wakes = 0;
  const w = world({ question: false, schedule: async () => { if (++wakes === 1) throw new Error("wake acknowledgement lost"); } });
  await assert.rejects(w.delivery.dispatch("prepare", prepare(), "alice"));
  const task = await createTaskDelivery(w.opts).dispatch("prepare", prepare(), "alice");
  assert.equal(task.status, "ready"); assert.equal(wakes, 2); assert.equal(Object.keys(w.opts.store.read(scope("alice")).tasks).length, 1);
});

test("scoped selected context and preparation output cannot carry resolved credentials into a brief", async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  const bound = w.worlds.get("alice");
  writeFileSync(join(bound.repository.dir, "AGENTS.md"), "Use private-provider-value");
  await assert.rejects(w.delivery.dispatch("prepare", prepare(), "alice"), { code: "TASK_SECRET" });
  writeFileSync(join(bound.repository.dir, "AGENTS.md"), "Verify with `npm test` and `npm run lint`.");
  bound.taskOptions = { prepare: async () => "private-provider-value" };
  const task = await w.delivery.dispatch("prepare", prepare("output"), "alice");
  assert.equal(task.status, "blocked"); assert.equal(task.brief, null);
  assert.doesNotMatch(JSON.stringify(task), /private-provider-value/);
});

for (const provider of ["openai-agents", "codex-cloud"]) test(`${provider} inherited missing bounded preparation remains a visible production gate`, async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  const bound = w.worlds.get("alice"); bound.ctx.config.harness[provider] = { account: "operator" }; bound.taskOptions = {};
  const task = await w.delivery.dispatch("prepare", { ...prepare(provider), harness: provider }, "alice");
  assert.equal(task.status, "blocked"); assert.equal(task.implementation, null); assert.equal(task.brief, null);
  assert.match(task.failures.join("\n"), /preparation.*unavailable|boundary/);
  const capability = (await w.delivery.dispatch("capabilities", {}, "alice")).repositories[0].providers.find(p => p.name === provider);
  assert.equal(capability.canPrepare, false); assert.match(capability.preparationSetup, /unavailable/);
});

test("two-account boundary rejects hostile inputs and scoped IDs on every operation", async () => {
  const w = world(), task = await w.delivery.dispatch("prepare", prepare(), "alice");
  for (const op of ["inspect", "evidence", "logs"]) await assert.rejects(w.delivery.dispatch(op, { taskId: task.taskId }, "bob"), { code: "DELIVERY_NOT_FOUND" });
  for (const op of ["answer", "resume", "validate", "start", "control"]) {
    const input = { ...mutate(task, op), ...(op === "answer" ? { answers: { "q-r-1": "CSV" } } : op === "start" ? { run: true } : op === "control" ? { action: "cancel" } : {}) };
    await assert.rejects(w.delivery.dispatch(op, input, "bob"), { code: "DELIVERY_NOT_FOUND" });
  }
  for (const extra of [{ dir: "/etc" }, { endpoint: "https://attacker.invalid" }, { token: "private-provider-value" }, { contextIds: ["../../.ssh"] }]) await assert.rejects(w.delivery.dispatch("prepare", { ...prepare("hostile"), ...extra }, "alice"), { code: "DELIVERY_INPUT" });
  await assert.rejects(w.delivery.dispatch("inspect", { taskId: "../../.env" }, "alice"), { code: "DELIVERY_INPUT" });
  await assert.rejects(w.delivery.dispatch("prepare", prepare("secret", "Use private-provider-value."), "mallory"), { code: "DELIVERY_AUTHORIZATION" });
  await assert.rejects(w.delivery.dispatch("prepare", prepare("secret", "Use private-provider-value."), "alice"), { code: "DELIVERY_SECRET" });
  await assert.rejects(w.delivery.dispatch("answer", { ...mutate(task, "secret-answer"), answers: { "q-r-1": "private-provider-value" } }, "alice"), { code: "DELIVERY_SECRET" });
  await assert.rejects(w.delivery.dispatch("answer", { ...mutate(task, "secret-answer-key"), answers: { "private-provider-value": "CSV" } }, "alice"), { code: "DELIVERY_SECRET" });
  await assert.rejects(w.delivery.dispatch("control", { ...mutate(task, "secret-note"), action: "message", note: "private-provider-value" }, "alice"), { code: "DELIVERY_SECRET" });
  const prototypeKey = await w.delivery.dispatch("prepare", prepare("__proto__"), "alice");
  assert.notEqual(prototypeKey.taskId, task.taskId);
  const bob = await w.delivery.dispatch("prepare", prepare(), "bob"); assert.notEqual(bob.taskId, task.taskId);
  assert.equal((await w.delivery.dispatch("list", {}, "bob")).tasks.length, 1);
  await assert.rejects(w.delivery.dispatch("prepare", { ...prepare("excessive"), allowance: { budgetUsd: 100, runtimeMs: 60000 } }, "alice"), { code: "DELIVERY_ALLOWANCE" });
});

test("installed scoped list and MCP results discover later authorized tasks and report authorized truncation", async () => {
  let wakes = 0;
  const w = world({ schedule: async () => { wakes++; } }), task = await w.delivery.dispatch("prepare", prepare(), "alice");
  const ctx = w.worlds.get("alice").ctx;
  const intake = JSON.parse(readFileSync(join(ctx.home, "tasks", task.taskId, "intake.json")));
  const saved = w.opts.store.read(scope("alice")).tasks[task.taskId], revoked = {};
  for (let i = 0; i < 101; i++) revoked["task-" + i.toString(16).padStart(24, "0")] = { repositoryId: "revoked" };
  await w.opts.store.transaction(scope("alice"), async (data, save) => { data.tasks = { ...revoked, [task.taskId]: saved }; await save(data); });
  const later = await w.delivery.dispatch("list", {}, "alice");
  assert.deepEqual(later.tasks.map(view => view.taskId), [task.taskId]); assert.equal(later.truncated, false);
  const authorized = { [task.taskId]: saved };
  // Saved intake fixtures exercise installed service inspection without another
  // inference or dispatch; every clone has its own supported task identity.
  for (let i = 101; i < 201; i++) {
    const id = "task-" + i.toString(16).padStart(24, "0");
    writeJsonAtomic(join(ctx.home, "tasks", id, "intake.json"), { ...intake, id }); authorized[id] = saved;
  }
  const server = new Server({ name: "scoped-list-test", version: "1" }, { capabilities: { tools: {} } });
  await registerTaskDelivery(server, { delivery: w.delivery, identityFor: async () => "alice" });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    for (const count of [0, 100, 101]) {
      const owned = Object.fromEntries(Object.entries(authorized).slice(0, count));
      await w.opts.store.transaction(scope("alice"), async (data, save) => { data.tasks = { ...revoked, ...owned }; await save(data); });
      const result = await client.callTool({ name: "task_list", arguments: {} });
      assert.notEqual(result.isError, true);
      const expected = Object.keys(owned).sort().slice(0, 100);
      assert.deepEqual(result.structuredContent.tasks.map(view => view.taskId), expected);
      assert.deepEqual(result._meta.taskDelivery.tasks.map(view => view.taskId), expected);
      assert.equal(result.structuredContent.truncated, count > 100); assert.equal(result._meta.taskDelivery.truncated, count > 100);
      if (count > 100) {
        const next = await client.callTool({ name: "task_list", arguments: { cursor: result.structuredContent.nextCursor } });
        assert.deepEqual(next.structuredContent.tasks.map(t => t.taskId), Object.keys(owned).sort().slice(100));
        assert.equal(next.structuredContent.nextCursor, null); assert.equal(next.structuredContent.truncated, false);
      }
    }
    assert.deepEqual((await w.delivery.dispatch("list", { cursor: Object.keys(authorized).sort()[99] }, "bob")).tasks, []);
    assert.equal(wakes, 1, "list reads cannot schedule work");
    assert.equal(ctx.state.entries().length, 0, "list reads cannot start implementation");
  } finally { await client.close(); await server.close(); }
});

test("installed MCP capability pages supply model-visible repository and harness inputs for preparation", async () => {
  let wakes = 0, identity = "alice";
  const w = world({ schedule: async () => { wakes++; } });
  const ids = Array.from({ length: 205 }, (_, i) => `repo-${String(i).padStart(3, "0")}`);
  const delivery = createTaskDelivery({ ...w.opts,
    authorize: async ({ identity }) => ({ ...scope(identity), repositories: identity === "alice" ? [...ids].reverse() : ["bob-only"] }),
    contextFor: async (scope, id) => {
      const bound = await w.contextFor(scope, "widget");
      return { ...bound, ctx: { ...bound.ctx, config: { ...bound.ctx.config, harness: id === ids.at(-1) ? bound.ctx.config.harness : {} } } };
    },
  });
  const server = new Server({ name: "capability-discovery", version: "1" }, { capabilities: { tools: {} } });
  await registerTaskDelivery(server, { delivery, identityFor: async () => identity });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const discovered = []; let cursor, chosen;
    do {
      const result = await client.callTool({ name: "task_capabilities", arguments: cursor ? { cursor } : {} });
      assert.notEqual(result.isError, true);
      const summary = result.structuredContent;
      assert.deepEqual(JSON.parse(result.content[0].text), summary);
      assert.ok(summary.repositories.length <= 100);
      assert.deepEqual(summary.repositories.map(r => r.id), result._meta.taskDelivery.repositories.map(r => r.id));
      assert.equal(summary.truncated, Boolean(summary.nextCursor));
      assert.doesNotMatch(JSON.stringify(summary), /private-provider-value|harnessBin|checkout|settings|bin"/);
      for (const repo of summary.repositories) {
        discovered.push(repo.id);
        for (const provider of repo.providers) {
          assert.equal(typeof provider.setup, "string"); assert.equal(typeof provider.preparationSetup, "string");
          const declared = executionCapabilities().find(p => p.name === provider.name);
          assert.deepEqual(provider.controls, declared.controls); assert.deepEqual(provider.cost, declared.cost);
          assert.equal(provider.transport, declared.transport); assert.equal(provider.continuation, declared.continuation);
          if (provider.configured && provider.available && provider.canPrepare) chosen = { repositoryId: repo.id, harness: provider.name };
        }
      }
      cursor = summary.nextCursor;
    } while (cursor);
    assert.deepEqual(discovered, ids); assert.equal(wakes, 0, "discovery cannot schedule work");
    assert.equal(chosen.repositoryId, ids.at(-1));
    const prepared = await client.callTool({ name: "task_prepare", arguments: { ...prepare(), ...chosen } });
    assert.equal(prepared.structuredContent.status, "needs-input"); assert.equal(wakes, 1);
    identity = "bob";
    const bob = await client.callTool({ name: "task_capabilities", arguments: {} });
    assert.deepEqual(bob.structuredContent.repositories.map(r => r.id), ["bob-only"]);
    assert.equal(bob.structuredContent.nextCursor, null);
    const invalid = await client.callTool({ name: "task_capabilities", arguments: { cursor: "../private" } });
    assert.equal(invalid.isError, true);
  } finally { await client.close(); await server.close(); }
});

test("installed MCP without UI exposes saved questions and answers using model-visible fields", async () => {
  const w = world(), server = new Server({ name: "question-flow", version: "1" }, { capabilities: { tools: {} } });
  await registerTaskDelivery(server, { delivery: w.delivery, identityFor: async () => "alice" });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const prepared = await client.callTool({ name: "task_prepare", arguments: prepare() });
    const model = prepared.structuredContent;
    assert.equal(model.status, "needs-input");
    assert.equal(model.questions[0].text, "Which file format should export use?");
    assert.deepEqual(JSON.parse(prepared.content[0].text), model);
    const inspected = await client.callTool({ name: "task_inspect", arguments: { taskId: model.taskId } });
    assert.deepEqual(inspected.structuredContent.questions, model.questions);
    const answer = await client.callTool({ name: "task_answer", arguments: { ...mutate(inspected.structuredContent, "model-answer"), answers: { [model.questions[0].id]: "Use CSV." } } });
    assert.equal(answer.structuredContent.status, "ready");
    assert.deepEqual(answer.structuredContent.questions, []);
    assert.equal(answer.structuredContent.brief, undefined);
  } finally { await client.close(); await server.close(); }
});

test("installed MCP evidence and logs expose bounded model observations without raw payloads", async () => {
  let wakes = 0; const w = world({ question: false, schedule: async () => { wakes++; } });
  let task = await w.delivery.dispatch("prepare", prepare(), "alice");
  task = await w.delivery.dispatch("start", { ...mutate(task, "start-evidence"), run: true }, "alice");
  const ctx = w.worlds.get("alice").ctx, runId = task.implementation.run;
  const dir = join(ctx.home, "runs", task.implementation.id.replaceAll("/", "__"), runId); mkdirSync(dir, { recursive: true });
  writeJsonAtomic(join(dir, "verification.json"), { version: 1, head: "observed-head", evidence: [{ command: "npm test", exit: 0, head: "observed-head", output: "private-provider-value private diagnostic" }] });
  appendProjection(dir, "private-provider-value raw log text");
  const server = new Server({ name: "evidence-flow", version: "1" }, { capabilities: { tools: {} } });
  await registerTaskDelivery(server, { delivery: w.delivery, identityFor: async () => "alice" });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); const before = wakes;
  try {
    const evidence = await client.callTool({ name: "task_evidence", arguments: { taskId: task.taskId } });
    assert.ok(evidence.structuredContent.artifacts.some(a => a.id === "brief"));
    assert.equal(evidence.structuredContent.verification.observations[0].exit, 0);
    assert.deepEqual(JSON.parse(evidence.content[0].text), evidence.structuredContent);
    const logs = await client.callTool({ name: "task_logs", arguments: { taskId: task.taskId, count: 10 } });
    assert.equal(logs.structuredContent.returnedLines, 1); assert.equal(logs.structuredContent.nextAfter, 1);
    assert.deepEqual(JSON.parse(logs.content[0].text), logs.structuredContent);
    assert.doesNotMatch(JSON.stringify([evidence.structuredContent, logs.structuredContent]), /private-provider-value|private diagnostic|raw log text/);
    assert.equal(evidence.structuredContent.brief, undefined); assert.equal(logs.structuredContent.lines, undefined);
    assert.equal(wakes, before);
  } finally { await client.close(); await server.close(); }
});

test("real MCP SDK shares schemas, annotations and built resource; reads never dispatch", async () => {
  const w = world(); let identity = "alice";
  const server = new Server({ name: "task-delivery-test", version: "1" }, { capabilities: { tools: {}, resources: {} } });
  await registerTaskDelivery(server, { delivery: w.delivery, identityFor: async () => identity, resource,
    readResource: async actor => { if (actor !== "alice") throw new Error("private-provider-value"); return readFileSync(join(candidate.out, "plugin/assets/task-ui.html"), "utf8"); } });
  const client = new Client({ name: "consumer", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try {
    const listed = await client.listTools();
    assert.equal(listed.tools.length, TASK_OPERATIONS.length);
    assert.equal(listed.tools.find(t => t.name === "task_prepare").annotations.readOnlyHint, false);
    assert.equal(listed.tools.find(t => t.name === "task_inspect").annotations.readOnlyHint, true);
    assert.equal(listed.tools.find(t => t.name === "task_inspect")._meta["openai/ui"].entrypoints.length, 2);
    const result = await client.callTool({ name: "task_prepare", arguments: prepare() });
    assert.equal(result.structuredContent.status, "needs-input"); assert.ok(result._meta.taskDelivery.brief);
    assert.equal(result.structuredContent.brief, undefined); assert.equal(result.structuredContent.logs, undefined);
    const ui = await client.readResource({ uri: resource.uri }); assert.match(ui.contents[0].text, /No live host evidence/);
    identity = "bob"; const denied = await client.callTool({ name: "task_inspect", arguments: { taskId: result.structuredContent.taskId } }); assert.equal(denied.isError, true);
    assert.doesNotMatch(JSON.stringify(denied), /private-provider-value/);
    await assert.rejects(client.readResource({ uri: resource.uri }), error => !error.message.includes("private-provider-value") && error.message.includes("Task resource unavailable"));
  } finally { await client.close(); await server.close(); }
});

for (const provider of ["openai-agents", "codex-cloud"]) test(`${provider} installed transport boundary retains intent/identity through unknown acceptance, restart and controls`, async () => {
  const root = tempHome(), clock = makeClock(); let paid = 0, observation, ambiguous = true;
  const transport = {
    prepare: async () => ({ environment: "fixture" }), submit: async () => { paid++; throw new Error("ack lost"); },
    lookup: async () => ambiguous ? null : observation,
    inspect: async () => observation,
    collect: async req => ({ taskId: req.taskId, providerJobId: req.providerJobId, sessionId: req.sessionId, turnId: req.turnId, inputHead: req.inputHead, outcome: { finished: true, ok: true, cost: null, lastMessage: "fixture" } }),
    cancel: async () => ({ confirmed: true }),
  };
  const options = { root, taskId: "acme/widget/fixture", account: "alice", provider, clock, transport, capabilities: { ...capabilitiesFor(provider), available: true, controls: { cancel: true, interrupt: false }, environments: ["fixture"] } };
  const input = { operationId: "first", inputHead: "a".repeat(40), allowance: { remainingUsd: 1, reservedUsd: 0.1 } };
  await assert.rejects(makeExecution(options).submit(input));
  await assert.rejects(makeExecution(options).submit(input), { code: "EXECUTION_UNKNOWN" }); assert.equal(paid, 1);
  await makeExecution(options).reconcile({ force: true }); assert.equal(makeExecution(options).current().execution.providerState, "status-unknown");
  ambiguous = false; observation = { providerJobId: "job-1", sessionId: "session-1", turnId: "root-1", state: "running", observedAt: clock.now(), events: [] };
  await makeExecution(options).reconcile({ force: true }); assert.equal(makeExecution(options).current().execution.sessionId, "session-1");
  observation = { ...observation, state: "succeeded" }; await makeExecution(options).reconcile({ force: true }); await makeExecution(options).collect();
  assert.equal(makeExecution(options).current().execution.collected, true);
  await makeExecution(options).cancel(); await assert.rejects(makeExecution(options).continue({ ...input, operationId: "later" }), { code: "EXECUTION_STOPPED" }); assert.equal(paid, 1);
});

test("coordinator persists wake before advance, excludes duplicates and rejects stale fencing", async () => {
  const home = tempHome(), store = createNodeOwnerStore({ home, durable: true });
  let finish, advances = 0, scheduled = false;
  const coordinator = createCoordinator({ store, schedule: async () => { scheduled = true; }, advance: async owner => { assert.ok(scheduled); advances++; await new Promise(r => { finish = r; }); owner.assertCurrent(); } });
  const running = coordinator.wake(); await new Promise(r => setImmediate(r));
  await assert.rejects(coordinator.wake(), /already running/); finish(); await running; assert.equal(advances, 1);
  let stale;
  await store.withOwner(async owner => { stale = owner; }); await store.withOwner(async () => {}); assert.throws(() => stale.assertCurrent(), { code: "COORDINATOR_FENCE" });
  assert.throws(() => createNodeOwnerStore({ home, durable: false }), { code: "COORDINATOR_STORE" }); assert.throws(() => createNodeOwnerStore({ home, durable: true, replicas: 2 }), { code: "COORDINATOR_STORE" });
});

test("process eviction recovers the durable owner but never purchases unresolved provider intent twice", async () => {
  const home = tempHome(), script = join(home, "eviction.mjs");
  writeFileSync(script, `import {createNodeOwnerStore} from ${JSON.stringify(import.meta.resolve("gallivant/runtime/node"))};
import {makeExecution} from ${JSON.stringify(import.meta.resolve("gallivant/execution"))};
import {appendFileSync} from 'node:fs';
const home=${JSON.stringify(home)};
await createNodeOwnerStore({home,durable:true}).withOwner(async () => {
await makeExecution({root:home+'/runs',taskId:'eviction',account:'alice',provider:'openai-agents',capabilities:{available:true,transport:'remote'},transport:{submit:async()=>{appendFileSync(home+'/paid','x');process.send('intent');await new Promise(()=>{});}}}).submit({operationId:'one',allowance:{remainingUsd:1,reservedUsd:0.1}});
});`);
  const child = fork(script, { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  try {
    const notice = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error("eviction child exited before intent"); })]);
    assert.equal(notice[0], "intent"); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    let advanced = 0;
    await createCoordinator({ store: createNodeOwnerStore({ home, durable: true }), schedule: async () => {}, advance: async () => { advanced++; } }).wake();
    assert.equal(advanced, 1);
    const execution = makeExecution({ root: join(home, "runs"), taskId: "eviction", account: "alice", provider: "openai-agents", capabilities: { available: true, transport: "remote" }, transport: { submit: async () => { throw new Error("duplicate paid dispatch"); } } });
    await assert.rejects(execution.submit({ operationId: "one", allowance: { remainingUsd: 1, reservedUsd: 0.1 } }), { code: "EXECUTION_UNKNOWN" });
    assert.equal(readFileSync(join(home, "paid"), "utf8"), "x");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});

test("installed preparation and readiness callbacks pin their runtime before implementation registration", async () => {
  for (const phase of ["preparation", "readiness"]) {
    const w = world({ question: phase === "preparation" }); await w.contextFor(scope("alice"), "widget");
    const bound = w.worlds.get("alice"), ctx = bound.ctx;
    migrateRuntimeState({ home: ctx.home, manifest });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), finished = new Promise(resolve => { release = resolve; });
    let pending;
    if (phase === "preparation") {
      bound.taskOptions.prepare = async (_ctx, task) => { entered(); await finished; return JSON.stringify(draftFor(task, { question: true })); };
      pending = w.delivery.dispatch("prepare", prepare(), "alice");
    } else {
      const task = await w.delivery.dispatch("prepare", prepare(), "alice");
      const path = join(ctx.home, "tasks", task.taskId, "intake.json"), intake = JSON.parse(readFileSync(path));
      intake.readiness = null; writeJsonAtomic(path, intake);
      bound.taskOptions.decideReady = async () => { entered(); await finished; return { ok: true, decisionId: "fixture-readiness", report: "" }; };
      pending = w.delivery.dispatch("validate", mutate(task, "validate-pending"), "alice");
    }
    try {
      await Promise.race([started, pending.then(() => { throw new Error("operation completed before the pending callback"); })]);
      assert.equal(ctx.state.entries().length, 0);
      assert.equal(checkRuntimeState({ home: ctx.home, manifest }).active, true);
      const pin = readFileSync(join(ctx.home, "runtime-pin.json"));
      assert.throws(() => migrateRuntimeState({ home: ctx.home, manifest: { ...manifest, coreSha256: "b".repeat(64) } }), { code: "RUNTIME_ACTIVE_PIN" });
      assert.deepEqual(readFileSync(join(ctx.home, "runtime-pin.json")), pin);
    } finally { release(); await pending; }
    assert.equal(checkRuntimeState({ home: ctx.home, manifest }).active, false);
    migrateRuntimeState({ home: ctx.home, manifest: { ...manifest, coreSha256: "b".repeat(64) } });
  }
});

test("installed backup restores selected ledger-named and lock sources for answer recovery", async () => {
  const w = world(), bound = await w.contextFor(scope("alice"), "widget");
  const names = ["yarn.lock", "bun.lock", "poetry.lock", "execution.json", "agents.json", "codex-cloud.json", "intake.json"];
  for (const [i, name] of names.entries()) { writeFileSync(join(bound.repository.dir, name), `selected repository context ${name}`); bound.repository.context[`source${i}`] = name; }
  let task = await w.delivery.dispatch("prepare", { ...prepare(), contextIds: names.map((_, i) => `source${i}`) }, "alice");
  assert.equal(task.status, "needs-input");
  const ctx = bound.ctx; migrateRuntimeState({ home: ctx.home, manifest });
  const intake = JSON.parse(readFileSync(join(ctx.home, "tasks", task.taskId, "intake.json")));
  const relativeDraft = intake.draft.root.slice(ctx.home.length + 1), backup = join(w.root, "context-backup"), restored = join(w.root, "context-restored");
  backupRuntimeState({ home: ctx.home, out: backup, manifest }); restoreRuntimeState({ backup, out: restored, manifest });
  for (const name of names) assert.deepEqual(readFileSync(join(restored, relativeDraft, name)), readFileSync(join(ctx.home, relativeDraft, name)));
  // Durable namespaces retain their mounted absolute path during rollback.
  rmSync(join(ctx.home, "tasks"), { recursive: true }); cpSync(join(restored, "tasks"), join(ctx.home, "tasks"), { recursive: true });
  task = await w.delivery.dispatch("answer", { ...mutate(task, "restored-answer"), answers: { "q-r-1": "Use CSV." } }, "alice");
  assert.equal(task.status, "ready", JSON.stringify(task.failures));
});

test("compatible package/state backup and rollback preserve task/provider/brief identities; active pins reject replacement", async () => {
  const w = world({ question: false }), task = await w.delivery.dispatch("prepare", prepare(), "alice"), ctx = w.worlds.get("alice").ctx;
  migrateRuntimeState({ home: ctx.home, manifest });
  const before = readFileSync(join(ctx.home, "tasks", task.taskId, "intake.json"));
  assertCompatible({ ...manifest, coreVersion: "0.2.1" });
  const backup = join(w.root, "backup"), restored = join(w.root, "restored");
  backupRuntimeState({ home: ctx.home, out: backup, manifest }); restoreRuntimeState({ backup, out: restored, manifest });
  assert.deepEqual(readFileSync(join(restored, "tasks", task.taskId, "intake.json")), before);
  assert.equal(statSync(join(backup, "tasks", task.taskId, "intake.json")).mode & 0o777, 0o600);
  await ctx.state.put("acme/widget/active", { state: "running", execution: { version: 1, provider: "openai-agents", sessionId: "session-1" } });
  assert.throws(() => checkRuntimeState({ home: ctx.home, manifest: { ...manifest, coreSha256: "b".repeat(64) } }), { code: "RUNTIME_ACTIVE_PIN" });
  assert.throws(() => assertCompatible({ ...manifest, coreVersion: "1.0.0" }), /migrate|matching package/);
  assert.throws(() => restoreRuntimeState({ backup, out: join(w.root, "wrong"), manifest: { ...manifest, coreSha256: "c".repeat(64) } }), { code: "RUNTIME_STATE" });
});

test("rollback validates ancestor symlinks and all hashes before creating any output", () => {
  const home = tempHome(), outside = join(home, "outside"), backup = join(home, "bad"), out = join(home, "restored");
  mkdirSync(outside); mkdirSync(backup); writeFileSync(join(outside, "intake.json"), '{"version":1}');
  symlinkSync(outside, join(backup, "tasks"));
  const digest = createHash("sha256").update(readFileSync(join(outside, "intake.json"))).digest("hex");
  writeJsonAtomic(join(backup, "backup.json"), { version: 1, coreSha256: manifest.coreSha256, hashes: { "tasks/intake.json": digest } });
  assert.throws(() => restoreRuntimeState({ backup, out, manifest }), { code: "RUNTIME_STATE" }); assert.equal(existsSync(out), false);
  symlinkSync(outside, join(home, "tasks"));
  assert.throws(() => backupRuntimeState({ home, out: join(dirname(home), "symlink-backup"), manifest }), { code: "RUNTIME_STATE" });
});

test("actual compatible patch install and rollback preserve saved identities; major migration is refused", async () => {
  // Synthetic package variants qualify upgrade mechanics only, never a release.
  const w = world({ question: false }), task = await w.delivery.dispatch("prepare", prepare(), "alice"), ctx = w.worlds.get("alice").ctx;
  migrateRuntimeState({ home: ctx.home, manifest });
  const intake = join(ctx.home, "tasks", task.taskId, "intake.json"), before = readFileSync(intake);
  const provider = join(ctx.home, "runs", "fixture", "agents.json"); mkdirSync(dirname(provider), { recursive: true });
  writeJsonAtomic(provider, { version: 1, taskId: task.taskId, sessionId: "session-preserved", turnId: "root-preserved" });
  const providerBytes = readFileSync(provider), backup = join(w.root, "previous-state");
  const patch = join(w.root, "patch"), install = join(w.root, "upgrade-consumer");
  cpSync(new URL("node_modules/gallivant", import.meta.url), patch, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(patch, "package.json"))); pkg.version = "0.2.1";
  writeFileSync(join(patch, "package.json"), JSON.stringify(pkg));
  const contract = join(patch, "lib/task_delivery_contract.mjs"); writeFileSync(contract, readFileSync(contract, "utf8").replace('CORE_VERSION = "0.2.0"', 'CORE_VERSION = "0.2.1"'));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: patch, encoding: "utf8" }))[0];
  const tarball = join(patch, packed.filename), patchManifest = { ...manifest, coreVersion: "0.2.1", coreSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex") };
  const rejectedBackup = join(w.root, "candidate-backup"), oldPin = readFileSync(join(ctx.home, "runtime-pin.json"));
  assert.throws(() => backupRuntimeState({ home: ctx.home, out: rejectedBackup, manifest: patchManifest }), { code: "RUNTIME_STATE" });
  assert.equal(existsSync(rejectedBackup), false); assert.deepEqual(readFileSync(join(ctx.home, "runtime-pin.json")), oldPin);
  backupRuntimeState({ home: ctx.home, out: backup, manifest });
  mkdirSync(install); writeFileSync(join(install, "package.json"), '{"private":true,"type":"module"}');
  execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", tarball], { cwd: install, stdio: "pipe" });
  const script = join(install, "check.mjs");
  writeFileSync(script, `import {CORE_VERSION,assertCompatible} from 'gallivant/task-delivery/contracts';import {migrateRuntimeState} from 'gallivant/runtime/state';if(CORE_VERSION!=='0.2.1')throw Error('source import bypass');const manifest=${JSON.stringify(patchManifest)};migrateRuntimeState({home:${JSON.stringify(ctx.home)},manifest});assertCompatible(manifest);`);
  execFileSync(process.execPath, [script], { cwd: install, stdio: "pipe" });
  assert.deepEqual(readFileSync(intake), before); assert.deepEqual(readFileSync(provider), providerBytes);
  assert.throws(() => migrateRuntimeState({ home: ctx.home, manifest: { ...patchManifest, coreVersion: "1.0.0" } }), { code: "DELIVERY_VERSION" });
  execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(candidate.out, candidate.manifest.coreArtifact)], { cwd: install, stdio: "pipe" });
  const restored = join(w.root, "rollback");
  writeFileSync(script, `import {CORE_VERSION} from 'gallivant/task-delivery/contracts';import {restoreRuntimeState} from 'gallivant/runtime/state';if(CORE_VERSION!=='0.2.0')throw Error('rollback package mismatch');restoreRuntimeState({backup:${JSON.stringify(backup)},out:${JSON.stringify(restored)},manifest:${JSON.stringify(manifest)}});`);
  execFileSync(process.execPath, [script], { cwd: install, stdio: "pipe" });
  assert.deepEqual(readFileSync(join(restored, "tasks", task.taskId, "intake.json")), before);
  assert.deepEqual(readFileSync(join(restored, "runs/fixture/agents.json")), providerBytes);
  assert.deepEqual(readFileSync(join(restored, "runtime-pin.json")), oldPin);
  const restoredCtx = { ...ctx, home: restored, state: makeState(restored) };
  await createNodeCoordinator({ ctx: restoredCtx, store: createNodeOwnerStore({ home: restored, durable: true }), manifest, schedule: async () => {} }).wake();
});

test("actual installed Node runtime imports; Pages full-runtime dependencies require the measured Node remedy", async t => {
  const modules = ["gallivant/tasks", "gallivant/runtime/node", "gallivant/task-delivery", "gallivant/providers/openai-agents", "gallivant/providers/codex-cloud"];
  for (const path of modules) assert.ok(import.meta.resolve(path).includes("node_modules/gallivant/"));
  assert.equal(NODE_RUNTIME_REQUIREMENTS.replicas, 1); assert.match(NODE_RUNTIME_REQUIREMENTS.pagesRemedy, /Node 22.*durable volume/);
  t.diagnostic("Node imports and bounded coordinator exercised above; no Workers-native workflow runtime is claimed.");
});


test("installed delivery never narrows cached account bindings", async () => {
  const w = world(), bound = await w.contextFor(scope("alice"), "widget");
  bound.ctx.config.max_budget_usd = 10;
  const originalCtx = bound.ctx, originalConfig = bound.ctx.config;
  Object.freeze(bound);
  const delivery = createTaskDelivery({ ...w.opts, contextFor: async () => bound });
  for (const budgetUsd of [1, 5]) {
    const task = await delivery.dispatch("prepare", { ...prepare(`budget-${budgetUsd}`), allowance: { budgetUsd, runtimeMs: 60000 } }, "alice");
    assert.equal(task.allowance.budgetUsd, budgetUsd);
    assert.equal(bound.ctx, originalCtx); assert.equal(bound.ctx.config, originalConfig);
    assert.equal(bound.ctx.config.max_budget_usd, 10);
    assert.equal(bound.ctx.taskSecrets, undefined);
  }
  await assert.rejects(delivery.dispatch("prepare", { ...prepare("over-limit"), allowance: { budgetUsd: 11, runtimeMs: 60000 } }, "alice"), { code: "DELIVERY_ALLOWANCE" });
  await delivery.dispatch("capabilities", {}, "alice");
  assert.equal(bound.ctx, originalCtx);
});
