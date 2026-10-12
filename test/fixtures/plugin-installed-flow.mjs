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
import { CORE_VERSION, TASK_OPERATIONS, assertCompatible, uiResourceConfiguration, taskRejectionForModel } from "gallivant/task-delivery/contracts";
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
      migrateRuntimeState({ home, manifest });
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
  const opts = { manifest, store, contextFor, schedule, secretsFor: () => ["private-provider-value"], authorize: async ({ identity, requiredScope }) => {
    if (!["alice", "bob"].includes(identity)) throw Object.assign(new Error("unauthorized"), { code: "DELIVERY_AUTHORIZATION" });
    assert.ok(["task-delivery:read", "task-delivery:write"].includes(requiredScope)); return scope(identity);
  } };
  return { root, worlds, opts, delivery: createTaskDelivery(opts), contextFor };
}

test("installed delivery forwards explicit verification selections through preparation and answers", async () => {
  const w = world();
  const input = { ...prepare(), verifyCommands: ["node --test"] };
  const pending = await w.delivery.dispatch("prepare", input, "alice");
  const bound = w.worlds.get("alice"), file = join(bound.ctx.home, "tasks", pending.taskId, "intake.json");
  assert.deepEqual(JSON.parse(readFileSync(file)).explicitVerifyCommands, ["node --test"]);
  const answer = { taskId: pending.taskId, expectedRevision: pending.revision, operationId: "verify-answer", answers: { "q-r-1": "Use CSV." }, verifyCommands: ["npm run lint"] };
  const ready = await w.delivery.dispatch("answer", answer, "alice");
  assert.equal(ready.status, "ready");
  assert.deepEqual(JSON.parse(readFileSync(file)).explicitVerifyCommands, ["node --test", "npm run lint"]);
  assert.equal((await w.delivery.dispatch("answer", answer, "alice")).revision, ready.revision);
  await assert.rejects(w.delivery.dispatch("answer", { ...answer, verifyCommands: ["npm test"] }, "alice"), { code: "DELIVERY_CONFLICT" });
  for (const commands of [Array(33).fill("node --test"), ["x".repeat(501)], [""], ["node --test", "node --test"]]) {
    await assert.rejects(w.delivery.dispatch("prepare", { ...prepare(), operationId: "invalid-verify", verifyCommands: commands }, "alice"), { code: "DELIVERY_INPUT" });
  }
});
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
  let ownedWakes = 0;
  const w = world({ schedule: async () => {
    const home = w.worlds.get("alice").ctx.home;
    assert.ok(existsSync(join(home, "daemon.lock")), "every mutation retains runtime ownership through receipt and wake");
    ownedWakes++;
  } }); let task = await w.delivery.dispatch("prepare", prepare(), "alice");
  assert.equal(task.status, "needs-input"); assert.equal(task.allowance.budgetUsd, 1);
  assert.equal(task.revision, (await w.delivery.dispatch("prepare", prepare(), "alice")).revision);
  const first = task;
  task = await w.delivery.dispatch("answer", { ...mutate(task, "answer"), answers: { "q-r-1": "Use CSV." } }, "alice");
  assert.equal(task.status, "ready"); assert.match(task.brief.text, /Do not add dependencies/);
  await assert.rejects(w.delivery.dispatch("validate", { ...mutate(first, "stale") }, "alice"), { code: "DELIVERY_CONFLICT" });
  task = await w.delivery.dispatch("validate", mutate(task, "validate"), "alice");
  task = await w.delivery.dispatch("start", { ...mutate(task, "start"), run: true }, "alice");
  assert.equal(task.status, "started", task.failures?.join(";"));
  assert.equal(ownedWakes, 4);
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
  assert.equal(existsSync(join(w.worlds.get("alice").ctx.home, "daemon.lock")), false, "failed wake releases runtime ownership");
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

for (const provider of ["codex-cloud"]) test(`${provider} inherited missing bounded preparation remains a visible production gate`, async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  const bound = w.worlds.get("alice"); bound.ctx.config.harness[provider] = { account: "operator" }; bound.taskOptions = {};
  const task = await w.delivery.dispatch("prepare", { ...prepare(provider), harness: provider }, "alice");
  assert.equal(task.status, "blocked"); assert.equal(task.implementation, null); assert.equal(task.brief, null);
  assert.match(task.failures.join("\n"), /preparation.*unavailable|boundary/);
  const capability = (await w.delivery.dispatch("capabilities", {}, "alice")).repositories[0].providers.find(p => p.name === provider);
  assert.equal(capability.canPrepare, false); assert.match(capability.preparationSetup, /unavailable/);
});

test("installed Agents preparation advertises its tool-free boundary separately from unverified account access", async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  w.worlds.get("alice").ctx.config.harness["openai-agents"] = { account: "operator" };
  const capability = (await w.delivery.dispatch("capabilities", {}, "alice")).repositories[0].providers.find(p => p.name === "openai-agents");
  assert.equal(capability.canPrepare, true);
  assert.equal(capability.preparation.environment, "none");
  assert.equal(capability.accountAccess, "unverified-until-setup-check");
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
    writeJsonAtomic(join(ctx.home, "tasks", id, "intake.json"), { ...intake, id, questions: Array.from({ length: 128 }, (_, n) => ({ id: `q-${n}`, text: "x".repeat(300) })) }); authorized[id] = saved;
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
      assert.deepEqual(result._meta.taskDelivery, result.structuredContent);
      assert.ok(Buffer.byteLength(JSON.stringify(result)) < 262144);
      const expected = Object.keys(owned).sort().slice(0, 100);
      assert.deepEqual(result.structuredContent.tasks.map(view => view.taskId), expected);
      assert.ok(result.structuredContent.tasks.every(view => view.repo === intake.repo && view.pr === null));
      if (expected.length) {
        const inspected = await client.callTool({ name: "task_inspect", arguments: { taskId: expected[0] } });
        assert.equal(inspected.structuredContent.repo, intake.repo);
        assert.equal(JSON.parse(inspected.content[0].text).repo, intake.repo);
      }
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
    const listed = await client.callTool({ name: "task_list", arguments: {} });
    assert.equal(listed.structuredContent.tasks[0].questions, undefined);
    assert.equal(listed.structuredContent.tasks[0].questionCount, model.questions.length);
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

test("coordinator renews a consumed one-shot wake after a slow advance", async () => {
  const store = createNodeOwnerStore({ home: tempHome(), durable: true });
  let now = 0, nextWake = null, advances = 0, finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const coordinator = createCoordinator({ store, intervalMs: 10, clock: { now: () => now },
    schedule: async at => { nextWake = at; },
    advance: async () => {
      advances++;
      if (advances === 1) { entered(); await new Promise(resolve => { finish = resolve; }); }
      return advances;
    } });
  const first = coordinator.wake();
  await started;
  assert.equal(nextWake, 10);
  now = nextWake; nextWake = null; // One-shot scheduler consumes even a rejected callback.
  await assert.rejects(coordinator.wake(), /already running/);
  assert.equal(nextWake, null);
  now = 25; finish();
  assert.equal(await first, 1);
  assert.equal(nextWake, 35, "completion renews the wake from the current time");
  now = nextWake; nextWake = null;
  assert.equal(await coordinator.wake(), 2);
  assert.equal(nextWake, 45);
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
  for (const phase of ["preparation", "answer", "readiness"]) {
    const w = world({ question: phase !== "readiness" }); await w.contextFor(scope("alice"), "widget");
    const bound = w.worlds.get("alice"), ctx = bound.ctx;
    migrateRuntimeState({ home: ctx.home, manifest });
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; }), finished = new Promise(resolve => { release = resolve; });
    let pending;
    if (phase === "preparation") {
      bound.taskOptions.prepare = async (_ctx, task) => { entered(); await finished; return JSON.stringify(draftFor(task, { question: true })); };
      pending = w.delivery.dispatch("prepare", prepare(), "alice");
    } else if (phase === "answer") {
      const task = await w.delivery.dispatch("prepare", prepare(), "alice");
      bound.taskOptions.prepare = async (_ctx, task) => { entered(); await finished; return JSON.stringify(draftFor(task)); };
      pending = w.delivery.dispatch("answer", { ...mutate(task, "answer-pending"), answers: { "q-r-1": "Use CSV." } }, "alice");
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
      assert.throws(() => migrateRuntimeState({ home: ctx.home, manifest: { ...manifest, coreSha256: "b".repeat(64) } }), /already running/);
      const out = join(w.root, "busy-backup");
      assert.throws(() => backupRuntimeState({ home: ctx.home, out, manifest }), /already running/);
      assert.equal(existsSync(out), false);
      await w.delivery.dispatch("list", {}, "alice"); // reads stay available without ownership or provider polling
      assert.deepEqual(readFileSync(join(ctx.home, "runtime-pin.json")), pin);
    } finally { release(); await pending; }
    assert.equal(checkRuntimeState({ home: ctx.home, manifest }).active, false);
    migrateRuntimeState({ home: ctx.home, manifest: { ...manifest, coreSha256: "b".repeat(64) } });
  }
});

test("installed delivery refuses maintenance ownership before saving intent and releases failed requests", async () => {
  const w = world(), { ctx } = await w.contextFor(scope("alice"), "widget");
  const owner = createNodeOwnerStore({ home: ctx.home, durable: true });
  await owner.withOwner(async () => {
    await assert.rejects(w.delivery.dispatch("prepare", prepare(), "alice"), /already running/);
    assert.deepEqual(w.opts.store.read(scope("alice")).operations, {});
  });
  assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
  await assert.rejects(w.delivery.dispatch("prepare", { ...prepare(), contextIds: ["missing"] }, "alice"), { code: "DELIVERY_INPUT" });
  assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
  const task = await w.delivery.dispatch("prepare", prepare(), "alice");
  assert.equal(task.status, "needs-input");
  const backup = join(w.root, "settled-backup");
  backupRuntimeState({ home: ctx.home, out: backup, manifest });
  assert.ok(existsSync(join(backup, "backup.json")));
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


test("installed discovered repository IDs work for preparation and capability cursors", async () => {
  const w = world(), ids = Array.from({ length: 101 }, (_, i) => `acme/widget-${String(i).padStart(3, "0")}`);
  let repositories = ids;
  const delivery = createTaskDelivery({ ...w.opts,
    authorize: async () => ({ ...scope("alice"), repositories }),
    contextFor: async (s, id) => { assert.ok(ids.includes(id)); return w.contextFor(s, "widget"); },
  });
  const first = await delivery.dispatch("capabilities", {}, "alice");
  const next = await delivery.dispatch("capabilities", { cursor: first.nextCursor }, "alice");
  assert.deepEqual(next.repositories.map(r => r.id), ids.slice(100));
  const task = await delivery.dispatch("prepare", { ...prepare(), repositoryId: next.repositories[0].id }, "alice");
  assert.equal(task.status, "needs-input");
  for (const invalid of ["../other", "x".repeat(129), "", "repo\nsecret"]) {
    repositories = [invalid];
    await assert.rejects(delivery.dispatch("capabilities", {}, "alice"), { code: "DELIVERY_CONFIG" });
  }
});


test("installed control projection agrees with sessionless resume writer and adapter capabilities", async () => {
  let wakes = 0;
  const w = world({ question: false, schedule: async () => { wakes++; } });
  let task = await w.delivery.dispatch("prepare", prepare(), "alice");
  task = await w.delivery.dispatch("start", { ...mutate(task, "start"), run: true }, "alice");
  const ctx = w.worlds.get("alice").ctx, id = task.implementation.id;
  let saved = { operations: {} };
  ctx.executionFor = () => ({ current: () => null, state: () => saved, capabilities: { transport: "remote", controls: { interrupt: false, cancel: false } } });
  ctx.coordinatorHealth = () => ({ usable: true });
  ctx.state.update(id, { state: "needs-human", reason: "dispatch-refused", session: null, pr: null, last: null, start_token: "initial", execution: { version: 1, operationId: "initial" }, initial_dispatch: { version: 1, operationId: "initial", status: "unsubmitted" } });
  const before = wakes;
  const inspect = () => w.delivery.dispatch("inspect", { taskId: task.taskId }, "alice");
  let viewed = await inspect();
  assert.equal(viewed.controls.resume, true); assert.equal(viewed.controls.message, true);
  assert.equal(viewed.controls.interrupt, false);
  assert.equal(viewed.controls.cancellation, "stop-future-dispatch; remote-compute-may-continue");
  saved = { stopped: true, operations: {} }; assert.equal((await inspect()).controls.resume, false);
  saved = { operations: { initial: {} } }; assert.equal((await inspect()).controls.resume, false);
  saved = { operations: {} }; viewed = await inspect();
  assert.equal(wakes, before);
  await w.delivery.dispatch("control", { ...mutate(viewed, "resume"), action: "resume" }, "alice");
  assert.equal(ctx.state.get(id).control.action, "resume");
  assert.equal((await inspect()).controls.resume, false);
});


test("installed operation receipts replay reordered objects through interrupted answers and preserve legacy retries", async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  let calls = 0;
  w.worlds.get("alice").taskOptions.prepare = async (_ctx, task) => {
    calls++;
    const output = draftFor(task), questions = [
      { id: "q-r-1", text: "Which format?", requirements: ["r-1"] },
      { id: "q-r-2", text: "Which helper?", requirements: ["r-2"] },
    ];
    output.questions = questions.filter(q => !task.answers[q.id]);
    output.mapping = output.mapping.map(m => {
      const q = questions.find(q => q.requirements.includes(m.requirementId));
      return !q ? m : task.answers[q.id] ? { ...m, resolvedBy: q.id } : { requirementId: m.requirementId, questionId: q.id };
    });
    output.criteria = output.criteria.filter(c => output.mapping.some(m => m.criteria?.includes(c.id)));
    return JSON.stringify(output);
  };
  const input = prepare(), first = await w.delivery.dispatch("prepare", input, "alice");
  const reorder = obj => Object.fromEntries(Object.entries(obj).reverse());
  assert.deepEqual(await w.delivery.dispatch("prepare", { ...reorder(input), allowance: reorder(input.allowance) }, "alice"), first);
  assert.equal(calls, 1);
  await assert.rejects(w.delivery.dispatch("prepare", { ...input, text: request + " Changed." }, "alice"), { code: "DELIVERY_CONFLICT" });
  const answer = { ...mutate(first, "answer"), answers: { "q-r-1": "Use CSV.", "q-r-2": "Reuse existing helper; no dependencies." } };
  const accepted = await w.delivery.dispatch("answer", answer, "alice"), before = calls;
  const retry = { ...reorder(answer), answers: reorder(answer.answers) };
  assert.deepEqual(await createTaskDelivery(w.opts).dispatch("answer", retry, "alice"), accepted);
  // Simulate loss of the adapter acknowledgement after the service saved its answer receipt.
  await w.opts.store.transaction(scope("alice"), async (data, save) => { data.operations.answer.status = "intent"; await save(data); });
  assert.deepEqual(await createTaskDelivery(w.opts).dispatch("answer", retry, "alice"), accepted);
  assert.equal(calls, before);
  await assert.rejects(w.delivery.dispatch("answer", { ...retry, answers: { ...retry.answers, "q-r-1": "Use JSON." } }, "alice"), { code: "DELIVERY_CONFLICT" });
  const intakePath = join(w.worlds.get("alice").ctx.home, "tasks", first.taskId, "intake.json");
  const intake = JSON.parse(readFileSync(intakePath, "utf8"));
  intake.operations.answer = createHash("sha256").update(JSON.stringify({ answers: answer.answers, verifyCommands: [] })).digest("hex");
  writeJsonAtomic(intakePath, intake);
  await w.opts.store.transaction(scope("alice"), async (data, save) => { data.operations.answer.status = "intent"; await save(data); });
  assert.deepEqual(await w.delivery.dispatch("answer", answer, "alice"), accepted);
  assert.equal(calls, before);
  assert.deepEqual(await w.delivery.dispatch("prepare", input, "alice"), accepted, "compact receipts return the current task view");
  await w.opts.store.transaction(scope("alice"), async (data, save) => { data.operations.prepare.signature = createHash("sha256").update(JSON.stringify(["prepare", input])).digest("hex"); data.operations.prepare.result = first; await save(data); });
  assert.deepEqual(await w.delivery.dispatch("prepare", input, "alice"), first);
});


test("installed delayed delivery mutations reject migrated or missing pins before intent and effects", async () => {
  let wakes = 0;
  const w = world({ question: false, schedule: async () => { wakes++; } });
  const supplied = { ...manifest }, old = createTaskDelivery({ ...w.opts, manifest: supplied });
  const task = await old.dispatch("prepare", prepare(), "alice");
  const { ctx } = w.worlds.get("alice"), home = ctx.home;
  const before = JSON.stringify(w.opts.store.read(scope("alice"))), beforeWakes = wakes;
  const intakePath = join(home, "tasks", task.taskId, "intake.json"), intake = readFileSync(intakePath);
  const next = { ...manifest, coreSha256: "b".repeat(64) };
  migrateRuntimeState({ home, manifest: next });
  supplied.coreSha256 = next.coreSha256; // A caller cannot change the captured artifact.
  for (const [name, input] of [
    ["prepare", prepare("delayed")], ["prepare", prepare()],
    ["answer", { ...mutate(task, "answer"), answers: { "q-r-1": "Use CSV." } }],
    ["resume", mutate(task, "resume")], ["validate", mutate(task, "validate")],
    ["start", { ...mutate(task, "start"), run: true }],
    ["control", { ...mutate(task, "control"), action: "cancel" }],
  ]) {
    await assert.rejects(old.dispatch(name, input, "alice"), { code: "COORDINATOR_PIN" });
    assert.equal(existsSync(join(home, "daemon.lock")), false);
    assert.equal(JSON.stringify(w.opts.store.read(scope("alice"))), before);
    assert.deepEqual(readFileSync(intakePath), intake);
    assert.equal(ctx.state.entries().length, 0); assert.equal(wakes, beforeWakes);
  }
  assert.equal((await old.dispatch("inspect", { taskId: task.taskId }, "alice")).taskId, task.taskId);
  rmSync(join(home, "runtime-pin.json"));
  await assert.rejects(old.dispatch("prepare", prepare("missing-pin"), "alice"), { code: "COORDINATOR_PIN" });
  assert.equal(JSON.stringify(w.opts.store.read(scope("alice"))), before);
  migrateRuntimeState({ home, manifest });
  const started = await old.dispatch("start", { ...mutate(task, "start"), run: true }, "alice");
  assert.equal(started.status, "started");
  assert.throws(() => createTaskDelivery({ ...w.opts, manifest: undefined }), { code: "DELIVERY_VERSION" });
  assert.throws(() => createTaskDelivery({ ...w.opts, manifest: { ...manifest, coreSha256: "invalid" } }), { code: "COORDINATOR_PIN" });
});


test("installed receipt capacity preserves old retries and refuses new effects", async () => {
  let wakes = 0;
  const w = world({ schedule: async () => { wakes++; } });
  const first = await w.delivery.dispatch("prepare", prepare("retained"), "alice");
  await w.opts.store.transaction(scope("alice"), async (data, save) => {
    for (let i = 0; i < 255; i++) data.operations[`retained-${i}`] = data.operations.retained;
    await save(data);
  });
  const restarted = createTaskDelivery(w.opts);
  assert.deepEqual(await restarted.dispatch("prepare", prepare("retained"), "alice"), first);
  const before = JSON.stringify(w.opts.store.read(scope("alice")));
  await assert.rejects(restarted.dispatch("prepare", prepare("new-operation"), "alice"), { code: "DELIVERY_CAPACITY" });
  assert.equal(JSON.stringify(w.opts.store.read(scope("alice"))), before);
  assert.equal(wakes, 1);
});


test("installed cancellation reserve survives full ordinary receipts and lost wake acknowledgements", async () => {
  let failWake = false;
  const w = world({ question: false, schedule: async () => { if (failWake) throw new Error("lost wake"); } });
  let task = await w.delivery.dispatch("prepare", prepare(), "alice");
  task = await w.delivery.dispatch("validate", mutate(task, "validate"), "alice");
  task = await w.delivery.dispatch("start", { ...mutate(task, "start"), run: true }, "alice");
  const input = { ...mutate(task, "safety-cancel"), action: "cancel" };
  await w.opts.store.transaction(scope("alice"), (data, save) => {
    for (let i = 3; i < 256; i++) data.operations[`padding-${i}`] = data.operations.prepare;
    data.padding = "";
    data.padding = "x".repeat(32 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(data, null, 2) + "\n"));
    return save(data);
  });
  await assert.rejects(w.delivery.dispatch("validate", mutate(task, "full"), "alice"), { code: "DELIVERY_CAPACITY" });
  await assert.rejects(w.delivery.dispatch("control", { ...input, expectedRevision: -1 }, "alice"));
  failWake = true;
  await assert.rejects(w.delivery.dispatch("control", input, "alice"), /lost wake/);
  const ctx = w.worlds.get("alice").ctx, id = task.implementation.id;
  assert.equal(ctx.state.get(id).dispatch_stopped, "cancellation-requested");
  const controlId = ctx.state.get(id).control.id;
  failWake = false;
  const replay = await createTaskDelivery(w.opts).dispatch("control", input, "alice");
  assert.equal(replay.taskId, task.taskId);
  assert.equal(ctx.state.get(id).control.id, controlId);
  const data = w.opts.store.read(scope("alice"));
  assert.equal(Object.keys(data.operations).length, 256);
  assert.equal(Object.keys(data.cancellations).length, 1);
  assert.equal(data.cancellations[input.operationId].result, undefined);
  assert.equal(data.cancellations[input.operationId].wakePending, false);
  await assert.rejects(w.delivery.dispatch("control", { ...input, note: "different" }, "alice"), { code: "DELIVERY_CONFLICT" });
  await assert.rejects(w.delivery.dispatch("control", { ...input, operationId: "second-cancel" }, "alice"), { code: "DELIVERY_CAPACITY" });
  await assert.rejects(w.delivery.dispatch("control", input, "bob"), { code: "DELIVERY_NOT_FOUND" });
});


test("installed MCP blocked mutations and inspection expose redacted recovery", async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  w.worlds.get("alice").taskOptions.prepare = async () => { throw Object.assign(new Error("Repair configuration private-provider-value"), { code: "TASK_INPUT" }); };
  const server = new Server({ name: "blocked-flow", version: "1" }, { capabilities: { tools: {} } });
  await registerTaskDelivery(server, { delivery: w.delivery, identityFor: async () => "alice" });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const prepared = await client.callTool({ name: "task_prepare", arguments: prepare() });
    const model = prepared.structuredContent;
    assert.equal(model.status, "blocked"); assert.equal(model.recovery.code, "TASK_INPUT");
    assert.match(model.recovery.reasons[0], /Repair configuration/);
    assert.match(model.recovery.nextAction, /resolve the reported failure/);
    assert.doesNotMatch(JSON.stringify(model), /private-provider-value/);
    const inspected = await client.callTool({ name: "task_inspect", arguments: { taskId: model.taskId } });
    assert.deepEqual(inspected.structuredContent.recovery, model.recovery);
    assert.deepEqual(JSON.parse(prepared.content[0].text), model);
  } finally { await client.close(); await server.close(); }
});


test("installed acknowledgement admission precedes effects and preserves task discovery near byte capacity", async () => {
  const w = world(); await w.contextFor(scope("alice"), "widget");
  const bound = w.worlds.get("alice"), original = bound.taskOptions.prepare;
  let calls = 0; bound.taskOptions.prepare = async (...args) => { calls++; return original(...args); };
  const fill = headroom => w.opts.store.transaction(scope("alice"), (data, save) => {
    data.padding = "";
    data.padding = "x".repeat(32 * 1024 * 1024 - headroom - Buffer.byteLength(JSON.stringify(data, null, 2) + "\n"));
    return save(data);
  });
  const input = prepare("near-limit", request + "\n" + "x".repeat(8000));
  await fill(1000);
  await assert.rejects(w.delivery.dispatch("prepare", input, "alice"), { code: "DELIVERY_CAPACITY" });
  assert.equal(calls, 0); assert.equal(Object.keys(w.opts.store.read(scope("alice")).operations).length, 0);
  await fill(6000);
  const task = await w.delivery.dispatch("prepare", input, "alice");
  assert.ok(Buffer.byteLength(JSON.stringify(task)) > 6000);
  const restarted = createTaskDelivery(w.opts);
  assert.equal((await restarted.dispatch("inspect", { taskId: task.taskId }, "alice")).taskId, task.taskId);
  assert.equal((await restarted.dispatch("list", {}, "alice")).tasks[0].taskId, task.taskId);
  assert.equal((await restarted.dispatch("prepare", input, "alice")).taskId, task.taskId);
  assert.equal(calls, 1);
  const receipt = w.opts.store.read(scope("alice")).operations[input.operationId];
  assert.equal(receipt.result, undefined); assert.equal(receipt.acknowledgementReserve, undefined);
  assert.equal(receipt.status, "acknowledged");
});


test("installed cancellation retries recover crashes before registry writes and receipt acknowledgement", async () => {
  for (const phase of ["intent", "acknowledgement", "history"]) {
    const w = world({ question: false });
    let task = await w.delivery.dispatch("prepare", prepare(), "alice");
    task = await w.delivery.dispatch("start", { ...mutate(task, "start-cancel-crash"), run: true }, "alice");
    const input = { ...mutate(task, "cancel-crash"), action: "cancel" };
    const ctx = w.worlds.get("alice").ctx, id = task.implementation.id;
    const transaction = w.opts.store.transaction;
    let crashed = false;
    w.opts.store.transaction = (scope, fn) => transaction(scope, (data, save) => fn(data, async next => {
      const receipt = next.cancellations?.[input.operationId];
      if (!crashed && receipt?.status === (phase === "intent" ? "intent" : "acknowledged")) {
        crashed = true;
        if (phase === "intent") await save(next);
        throw new Error("simulated receipt crash");
      }
      return save(next);
    }));
    await assert.rejects(w.delivery.dispatch("control", input, "alice"), /simulated receipt crash/);
    assert.equal(w.opts.store.read(scope("alice")).cancellations[input.operationId].status, "intent");
    if (phase === "intent") assert.equal(ctx.state.get(id).control, undefined);
    const original = ctx.state.get(id).control;
    if (phase === "history") ctx.state.update(id, { control: { ...original, id: "later", action: "recheck", status: "applied" }, control_history: [{ ...original, status: "applied" }] });
    const restarted = createTaskDelivery(w.opts);
    await assert.rejects(restarted.dispatch("control", { ...input, operationId: "replacement" }, "alice"), { code: "DELIVERY_CAPACITY" });
    await assert.rejects(restarted.dispatch("control", { ...input, note: "changed" }, "alice"), { code: "DELIVERY_CONFLICT" });
    await restarted.dispatch("control", input, "alice");
    const entry = ctx.state.get(id), controlId = original?.id || entry.control.id;
    assert.equal(entry.dispatch_stopped, "cancellation-requested");
    assert.equal(phase === "history" ? entry.control_history[0].id : entry.control.id, controlId);
    if (phase === "history") assert.equal(entry.control.id, "later");
    await restarted.dispatch("control", input, "alice");
    assert.equal(ctx.runnerFor(id).started.length, 1);
    assert.equal(w.opts.store.read(scope("alice")).cancellations[input.operationId].status, "acknowledged");
    assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
  }
});

test("installed interrupted resume and negative outcomes settle without repeating effects", async () => {
  for (const name of ["resume", "validate", "start"]) {
    const w = world({ question: false });
    const task = await w.delivery.dispatch("prepare", prepare(), "alice");
    const bound = w.worlds.get("alice"), { ctx } = bound;
    const path = join(ctx.home, "tasks", task.taskId, "intake.json");
    const intake = JSON.parse(readFileSync(path));
    let effects = 0;
    if (name === "resume") {
      intake.status = "preparing";
      bound.taskOptions.prepare = async (_ctx, saved) => { effects++; return JSON.stringify(draftFor(saved, { question: true })); };
    } else if (name === "validate") {
      intake.readiness = null;
      bound.taskOptions.decideReady = async () => { effects++; return { ok: false, report: "fixture readiness denial" }; };
    } else {
      bound.taskOptions.dispatch = async () => { effects++; throw Object.assign(new Error("fixture dispatch refused"), { startUncertain: false }); };
    }
    writeJsonAtomic(path, intake);
    const input = { ...mutate(task, `lost-${name}`), ...(name === "start" ? { run: true } : {}) };
    const transaction = w.opts.store.transaction;
    let crashed = false;
    w.opts.store.transaction = (scope, fn) => transaction(scope, (data, save) => fn(data, async next => {
      if (!crashed && next.operations[input.operationId]?.status === "acknowledged") {
        crashed = true; throw new Error("outcome acknowledgement lost");
      }
      return save(next);
    }));
    await assert.rejects(w.delivery.dispatch(name, input, "alice"), /outcome acknowledgement lost/);
    const saved = JSON.parse(readFileSync(path));
    assert.ok(saved.revision > task.revision);
    assert.equal(saved.status, name === "resume" ? "needs-input" : "blocked");
    assert.equal(w.opts.store.read(scope("alice")).operations[input.operationId].status, "intent");
    const before = readFileSync(path);
    const recovered = await createTaskDelivery(w.opts).dispatch(name, input, "alice");
    assert.equal(recovered.status, saved.status);
    assert.equal(recovered.revision, saved.revision);
    assert.equal(effects, 1);
    assert.deepEqual(readFileSync(path), before);
    const receipt = w.opts.store.read(scope("alice")).operations[input.operationId];
    assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.wakePending, false);
    await createTaskDelivery(w.opts).dispatch(name, input, "alice");
    assert.equal(effects, 1);
    assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
  }
});

test("installed intent fence prevents unrelated revisions from consuming a start request", async () => {
  const w = world({ question: false });
  const task = await w.delivery.dispatch("prepare", prepare(), "alice");
  const input = { ...mutate(task, "original-start"), run: true };
  const transaction = w.opts.store.transaction;
  let crashed = false;
  w.opts.store.transaction = (scope, fn) => transaction(scope, (data, save) => fn(data, async next => {
    await save(next);
    if (!crashed && next.operations[input.operationId]?.status === "intent") {
      crashed = true; throw new Error("intent-only crash");
    }
  }));
  await assert.rejects(w.delivery.dispatch("start", input, "alice"), /intent-only crash/);
  const restarted = createTaskDelivery(w.opts);
  for (const name of ["resume", "validate", "start"]) await assert.rejects(restarted.dispatch(name, { ...mutate(task, `intervening-${name}`), ...(name === "start" ? { run: true } : {}) }, "alice"), { code: "DELIVERY_PENDING" });
  const independent = await restarted.dispatch("prepare", prepare("intervening-prepare"), "alice");
  assert.notEqual(independent.taskId, task.taskId);
  const started = await restarted.dispatch("start", input, "alice");
  assert.equal(started.status, "started");
  assert.equal(w.worlds.get("alice").ctx.runnerFor(started.implementation.id).started.length, 1);
  assert.equal(w.opts.store.read(scope("alice")).operations[input.operationId].status, "acknowledged");
});

test("installed pre-effect rejections settle intents and permit corrected requests", async () => {
  for (const name of ["answer", "validate", "start"]) {
    const w = world();
    const task = await w.delivery.dispatch("prepare", prepare(), "alice");
    const { ctx } = w.worlds.get("alice");
    const path = join(ctx.home, "tasks", task.taskId, "intake.json");
    if (name === "validate") {
      const intake = JSON.parse(readFileSync(path)); intake.status = "preparing"; writeJsonAtomic(path, intake);
    }
    const input = { ...mutate(task, `invalid-${name}`), ...(name === "answer" ? { answers: { unknown: "value" } } : name === "start" ? { run: true } : {}) };
    const expected = name === "answer" ? "TASK_INPUT" : "TASK_NOT_READY";
    const before = readFileSync(path);
    if (name === "answer") {
      const transaction = w.opts.store.transaction;
      let failed = false;
      w.opts.store.transaction = (scope, fn) => transaction(scope, (data, save) => fn(data, async next => {
        if (!failed && next.operations[input.operationId]?.rejection) { failed = true; throw new Error("rejection acknowledgement lost"); }
        return save(next);
      }));
      await assert.rejects(w.delivery.dispatch(name, input, "alice"), /rejection acknowledgement lost/);
      assert.equal(w.opts.store.read(scope("alice")).operations[input.operationId].status, "intent");
    }
    await assert.rejects(w.delivery.dispatch(name, input, "alice"), { code: expected });
    assert.deepEqual(readFileSync(path), before);
    const receipt = w.opts.store.read(scope("alice")).operations[input.operationId];
    assert.equal(receipt.status, "acknowledged"); assert.equal(receipt.rejection.code, expected); assert.equal(receipt.wakePending, false);
    assert.equal(checkRuntimeState({ home: w.root, manifest }).active, false, "settled receipts must not pin the namespace");
    await assert.rejects(createTaskDelivery(w.opts).dispatch(name, input, "alice"), { code: expected });
    assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
    // Corrected input uses a fresh identity; resume restores incomplete preparation.
    const next = name === "validate"
      ? await w.delivery.dispatch("resume", mutate(task, "corrected"), "alice")
      : await w.delivery.dispatch("answer", { ...mutate(task, "corrected"), answers: { "q-r-1": "Use CSV." } }, "alice");
    assert.ok(next.revision > task.revision);
  }
});

test("installed unknown readiness failures retain their intent instead of claiming rejection", async () => {
  const w = world({ question: false });
  const task = await w.delivery.dispatch("prepare", prepare(), "alice");
  const bound = w.worlds.get("alice"), path = join(bound.ctx.home, "tasks", task.taskId, "intake.json");
  const intake = JSON.parse(readFileSync(path)); intake.readiness = null; writeJsonAtomic(path, intake);
  bound.taskOptions.decideReady = async () => { throw new Error("unknown provider failure"); };
  const input = mutate(task, "unknown-validation");
  await assert.rejects(w.delivery.dispatch("validate", input, "alice"), /unknown provider failure/);
  assert.equal(w.opts.store.read(scope("alice")).operations[input.operationId].status, "intent");
  await assert.rejects(w.delivery.dispatch("validate", mutate(task, "replacement"), "alice"), { code: "DELIVERY_PENDING" });
});


test("installed deterministic preparation refusals settle without intake or paid effects", async () => {
  for (const fault of ["unconfigured", "unknown", "missing-context", "secret-context", "repository"]) {
    const w = world();
    const bound = await w.contextFor(scope("alice"), "widget");
    let calls = 0; bound.taskOptions.prepare = async () => { calls++; throw new Error("unexpected preparation"); };
    const input = prepare(`rejected-${fault}`);
    if (fault === "unconfigured") input.harness = "codex";
    if (fault === "unknown") input.harness = "not-a-harness";
    if (fault.endsWith("context")) {
      bound.repository.context.invalid = "invalid.md"; input.contextIds = ["invalid"];
      if (fault === "secret-context") writeFileSync(join(bound.repository.dir, "invalid.md"), "private-provider-value");
    }
    if (fault === "repository") bound.repository.repo = "other/repository";
    await assert.rejects(w.delivery.dispatch("prepare", input, "alice"));
    const receipt = w.opts.store.read(scope("alice")).operations[input.operationId];
    assert.equal(receipt.status, "acknowledged"); assert.ok(receipt.rejection); assert.equal(receipt.wakePending, false);
    await assert.rejects(createTaskDelivery(w.opts).dispatch("prepare", input, "alice"), { code: receipt.rejection.code });
    assert.equal(calls, 0); assert.deepEqual(createTaskService(bound.ctx).list().tasks, []);
    assert.equal(checkRuntimeState({ home: w.root, manifest }).active, false);
    assert.equal(existsSync(join(bound.ctx.home, "daemon.lock")), false);
    bound.repository.repo = "acme/widget";
    bound.taskOptions.prepare = async (_ctx, task) => JSON.stringify(draftFor(task, { question: true }));
    const corrected = await w.delivery.dispatch("prepare", prepare("corrected"), "alice");
    assert.equal(corrected.status, "needs-input");
  }
});

test("installed MCP preserves settled task refusals but hides arbitrary task-coded errors", async () => {
  const w = world(), task = await w.delivery.dispatch("prepare", prepare(), "alice");
  const server = new Server({ name: "safe-rejections", version: "1" }, { capabilities: { tools: {} } });
  let raw = false;
  await registerTaskDelivery(server, { delivery: { dispatch: (...args) => {
    if (raw) throw Object.assign(new Error("private-provider-value /private/provider/path"), { code: "TASK_INPUT" });
    return w.delivery.dispatch(...args);
  } }, identityFor: async () => "alice" });
  const client = new Client({ name: "consumer", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const input = { ...mutate(task, "bad-answer"), answers: { unknown: "value" } };
    const refused = await client.callTool({ name: "task_answer", arguments: input });
    assert.equal(refused.isError, true); assert.match(refused.content[0].text, /^TASK_INPUT: unknown answer identifier unknown/);
    assert.deepEqual(await client.callTool({ name: "task_answer", arguments: input }), refused);
    const { ctx } = w.worlds.get("alice"), path = join(ctx.home, "tasks", task.taskId, "intake.json");
    const intake = JSON.parse(readFileSync(path)); intake.status = "preparing"; writeJsonAtomic(path, intake);
    const validation = await client.callTool({ name: "task_validate", arguments: mutate(task, "not-ready") });
    assert.equal(validation.isError, true); assert.match(validation.content[0].text, /^TASK_NOT_READY: resume preparation with the current revision/);
    assert.ok(validation.content[0].text.length < 550);
    raw = true;
    const hidden = await client.callTool({ name: "task_validate", arguments: mutate(task, "raw") });
    assert.equal(hidden.isError, true); assert.match(hidden.content[0].text, /^DELIVERY_FAILED:/);
    assert.doesNotMatch(JSON.stringify(hidden), /private-provider-value|private\/provider\/path|TASK_INPUT/);
  } finally { await client.close(); await server.close(); }
});

test("installed preparation boundary refusals settle validate and start intents without effects", async () => {
  for (const name of ["validate", "start"]) {
    const w = world({ question: false });
    const task = await w.delivery.dispatch("prepare", prepare(), "alice");
    const { ctx, taskOptions } = w.worlds.get("alice");
    const path = join(ctx.home, "tasks", task.taskId, "intake.json");
    const intake = JSON.parse(readFileSync(path));
    intake.attempts.push({ ok: true, settled: true, consumed: true, cost: 0, elapsedMs: 0 });
    writeJsonAtomic(path, intake);
    const before = readFileSync(path);
    taskOptions.decideReady = async () => { throw new Error("readiness must not run"); };
    taskOptions.dispatch = async () => { throw new Error("dispatch must not run"); };
    const input = { ...mutate(task, `boundary-${name}`), ...(name === "start" ? { run: true } : {}) };
    for (const delivery of [w.delivery, createTaskDelivery(w.opts)]) {
      await assert.rejects(delivery.dispatch(name, input, "alice"), error => {
        assert.equal(error.code, "TASK_PREPARATION_BOUNDARY");
        assert.equal(taskRejectionForModel(error)?.code, error.code);
        assert.match(taskRejectionForModel(error).message, /cannot authorize readiness or dispatch/);
        return true;
      });
      assert.deepEqual(readFileSync(path), before);
    }
    const receipt = w.opts.store.read(scope("alice")).operations[input.operationId];
    assert.equal(receipt.status, "acknowledged");
    assert.equal(receipt.rejection.code, "TASK_PREPARATION_BOUNDARY");
    assert.equal(receipt.wakePending, false);
    assert.equal(ctx.state.entries().length, 0);
    assert.equal(existsSync(join(ctx.home, "daemon.lock")), false);
    const recovered = await w.delivery.dispatch("resume", mutate(task, "inspect-boundary-recovery"), "alice");
    assert.equal(recovered.status, "blocked", "new operations can record the unsafe legacy preparation without dispatch");
    assert.equal(checkRuntimeState({ home: w.root, manifest }).active, false);
    assert.equal(checkRuntimeState({ home: ctx.home, manifest }).active, false);
  }
});
