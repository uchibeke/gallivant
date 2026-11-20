import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCollaborationService, withCollaborationState } from "../lib/collaboration.mjs";
import { createCollaborationStore } from "../lib/collaboration_store.mjs";
import { boardAccessRisk, checkBoardCollaboration, createBoardCollaborationAdapter } from "../lib/board_collaboration.mjs";
import { COLLABORATION_EVENT_SCHEMA, COLLABORATION_SCHEMA, collaborationConfigProblems, collaborationSettings } from "../lib/collaboration_contract.mjs";
import { tempHome, makeClock, T0 } from "./helpers.mjs";
import { makeState } from "../lib/state.mjs";

const TASK = "github.com/acme/widget/board-adapter";
const RUN = "run-42";

function config(overrides = {}) {
  return collaborationSettings({
    adapter: "board",
    channel: "work",
    needs_owner_channel: "needs-owner",
    profile: "task-relay",
    link_base_url: "http://127.0.0.1:8791/gallivant",
    policy: { allow_us_storage: true, allow_board_managed_retention: true },
    ...overrides,
  });
}

function recorder(overrides = {}) {
  const delivered = [], calls = { policy: 0, snapshot: 0, poll: [] };
  return {
    delivered,
    calls,
    async inspectPolicy() { calls.policy++; return { allow: true, actor: "board-user" }; },
    async deliver(thread, event) { delivered.push({ thread, event }); return { threadId: "thread-1", externalId: event.id, ...(event.transition.type === "needs-owner" ? { ownerItemId: "owner-1" } : {}) }; },
    async snapshot() { calls.snapshot++; return { messages: [], cursor: "snapshot-cursor" }; },
    async poll({ cursor }) { calls.poll.push(cursor); return { messages: [], cursor }; },
    ...overrides,
  };
}

const entry = (state, over = {}) => ({
  repo: "acme/widget",
  branch: "work/board-adapter",
  state,
  created_at: T0,
  updated_at: T0,
  last: { run: RUN, at: T0, event: "fixture output that must not be routed" },
  ...over,
});

test("an absent collaboration block is inert and broader access or retention is refused before delivery", async () => {
  assert.equal(collaborationSettings(null), null);
  assert.deepEqual(collaborationConfigProblems(null), []);
  assert.deepEqual(config().policy.permissions, ["post", "label"], "one-way delivery has no explicit read grant");
  assert.equal(config().retry.timeout_seconds, 10);
  assert.match(collaborationConfigProblems({ ...config(), retry: { ...config().retry, timeout_seconds: 0 } }).join("\n"), /timeout_seconds must be an integer from 1 to 300/);
  assert.match(collaborationConfigProblems({ ...config(), policy: { ...config().policy, permissions: ["read", "post", "label"] } }).join("\n"), /read only while inbound/);
  assert.equal(COLLABORATION_EVENT_SCHEMA.properties.version.const, 1);
  assert.doesNotMatch(JSON.stringify(COLLABORATION_EVENT_SCHEMA), /"pattern"/, "the contract uses only Board-supported JSON Schema keywords");
  assert.match(collaborationConfigProblems({ adapter: "board" }).join("\n"), /policy must explicitly accept/);
  assert.match(collaborationConfigProblems({
    ...config(), policy: { allow_us_storage: true, allow_board_managed_retention: true, max_retention_days: 7 },
  }).join("\n"), /cannot be guaranteed by Board/);

  const cfg = config();
  const impliedRead = {
    work: ["read", "post", "label"],
    "needs-owner": ["read", "post", "label"],
  };
  assert.equal(boardAccessRisk(impliedRead, cfg), null, "Board's reported label-to-read implication is allowed");
  assert.equal(boardAccessRisk({ work: ["post", "label"], "needs-owner": ["post", "label"] }, cfg), null, "unexpanded grants use the same closure");
  assert.match(boardAccessRisk({ ...impliedRead, work: [...impliedRead.work, "react"] }, cfg), /includes react/);
  assert.match(boardAccessRisk({ "*": "all" }, cfg), /access includes \*/);
  const allowed = await checkBoardCollaboration(cfg, { clientFor: async () => ({
    handle: {
      me: async () => ({ actor: { id: "board-user" }, can: impliedRead }),
      schema: async () => ({ name: "gallivant-task-transition", version: 1 }),
    },
  }) });
  assert.equal(allowed.ok, true, "doctor accepts Board's expanded effective grants");
  const checked = await checkBoardCollaboration(cfg, { clientFor: async () => ({
    handle: {
      me: async () => ({ can: { "*": "all" } }),
      schema: async () => ({ name: "gallivant-task-transition", version: 1 }),
    },
  }) });
  assert.equal(checked.ok, false);
  assert.match(checked.detail, /narrow the adapter handle/);
});

test("significant transitions are sanitized, versioned, idempotent, and share one durable task thread", async () => {
  const home = tempHome(), clock = makeClock(), cfg = config(), store = createCollaborationStore(home), adapter = recorder();
  const service = createCollaborationService({ adapter, store, config: cfg, clock });
  const initial = entry("running", {
    worktree: "/Users/private/secret-worktree",
    prompt: "PROMPT_SECRET_MARKER",
    transcript: "TRANSCRIPT_SECRET_MARKER",
    credentials: { token: "TOKEN_SECRET_MARKER" },
    private_config: { destination: "PRIVATE_CHANNEL_MARKER" },
    raw_diff: "+RAW_DIFF_SECRET_MARKER",
  });
  service.observeEntry(TASK, null, initial, { actor: { type: "owner", id: "owner-7" }, source: { type: "command", id: "start" } });
  service.observeEntry(TASK, null, initial, { actor: { type: "owner", id: "owner-7" }, source: { type: "command", id: "start" } });

  const opened = entry("pr-open", { pr: 17, url: "https://github.com/acme/widget/pull/17" });
  const blocked = entry("needs-human", { pr: 17, url: opened.url, reason: "checks-red", updated_at: "2026-09-24T02:01:00.000Z" });
  const resumed = entry("pr-open", { pr: 17, url: opened.url, updated_at: "2026-09-24T02:02:00.000Z" });
  const ready = entry("ready-for-human", { pr: 17, url: opened.url, cursor: { fixed_sha: "abc1234" }, updated_at: "2026-09-24T02:03:00.000Z" });
  service.observeEntry(TASK, initial, opened);
  service.observeEntry(TASK, opened, blocked);
  service.observeEntry(TASK, blocked, resumed);
  service.observeEntry(TASK, resumed, ready);

  const saved = store.read(), records = Object.values(saved.deliveries), wire = JSON.stringify(saved);
  assert.deepEqual(new Set(records.map(item => item.event.transition.type)), new Set(["accepted", "started", "pr-opened", "needs-owner", "stopped", "resumed", "ready"]));
  assert.equal(records.length, 7, "duplicate observation has the same event id");
  assert.equal(Object.keys(saved.threads).length, 1);
  for (const marker of ["/Users/private", "PROMPT_SECRET", "TRANSCRIPT_SECRET", "TOKEN_SECRET", "PRIVATE_CHANNEL", "RAW_DIFF_SECRET"]) assert.doesNotMatch(wire, new RegExp(marker));
  for (const { event } of records) {
    assert.equal(event.version, 1);
    assert.equal(event.schema, "gallivant.task-transition");
    assert.equal(event.task.id, TASK);
    assert.equal(event.task.run_id, RUN);
    assert.match(event.idempotency_key, new RegExp(`^${TASK}:${RUN}:gvt-event-`));
    assert.match(event.links.task, /^http:\/\/127\.0\.0\.1:8791\/gallivant\/run\?id=/);
    assert.ok(event.provenance.actor.id);
    assert.ok(event.provenance.source.id);
  }
  const owner = records.find(item => item.event.transition.type === "needs-owner").event;
  assert.equal(owner.transition.reason, "checks-red");
  assert.match(owner.transition.requested_decision, /decide whether to resume or cancel/);
  assert.equal(owner.transition.expires_at, "2026-09-27T02:00:00.000Z");

  assert.deepEqual(await service.flush(), { ok: true, delivered: 7 });
  assert.equal(adapter.calls.policy, 1);
  assert.equal(adapter.delivered.length, 7);
  const restarted = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg, clock });
  restarted.observeEntry(TASK, initial, opened);
  assert.equal(Object.keys(createCollaborationStore(home).read().deliveries).length, 7);
  assert.deepEqual(await restarted.flush(), { ok: true, delivered: 0, idle: true });
  assert.equal(adapter.calls.policy, 1, "an idle restart performs no Board request");
});

test("configured state observation covers direct resume and stop mutations while preserving canonical writes", () => {
  const home = tempHome(), state = makeState(home), store = createCollaborationStore(home), cfg = config(), adapter = recorder();
  const service = createCollaborationService({ adapter, store, config: cfg });
  const observed = withCollaborationState(state, service);
  observed.put(TASK, entry("needs-human", { reason: "checks-red" }));
  observed.update(TASK, { state: "pr-open", reason: null, updated_at: "2026-09-24T02:01:00.000Z" });
  observed.update(TASK, { state: "needs-human", reason: "reviewer-blocking", updated_at: "2026-09-24T02:02:00.000Z" });
  assert.equal(state.get(TASK).reason, "reviewer-blocking");
  assert.deepEqual(new Set(Object.values(store.read().deliveries).map(item => item.event.transition.type)), new Set(["accepted", "resumed", "needs-owner", "stopped"]));
});

test("Board writes use stable IDs, noSync, a dedicated owner queue, and resolve that item on resume", async () => {
  const calls = [], cfg = config();
  const handle = {
    me: async () => ({ actor: { id: "actor-1" }, can: { work: ["post", "label"], "needs-owner": ["post", "label"] } }),
    schema: async name => ({ name: name.split("@")[0], version: Number(name.split("@")[1]) }),
    post: async (channel, options) => { calls.push(["post", channel, options]); return { id: options.id }; },
    reply: async (id, options) => { calls.push(["reply", id, options]); return { id: options.id }; },
    label: async (id, options) => { calls.push(["label", id, options]); return { id }; },
  };
  const adapter = createBoardCollaborationAdapter(cfg, { clientFor: async () => ({ handle, block: (schema, data) => ({ schema, data }) }) });
  assert.equal((await adapter.inspectPolicy()).allow, true);
  const event = {
    schema: "gallivant.task-transition", version: 1, id: "gvt-event-11111111111111111111111111111111", idempotency_key: "stable",
    task: { id: TASK, run_id: RUN, title: "board-adapter" }, transition: { type: "needs-owner", state: "needs-human", occurred_at: T0, reason: "checks-red", requested_decision: "Choose", expires_at: T0 },
    provenance: { actor: { type: "service", id: "coordinator" }, source: { type: "state", id: "registry" } }, links: { task: "http://127.0.0.1:8791/gallivant/run?id=x" },
  };
  const thread = { key: "gvt-thread-stable", taskId: TASK, runId: RUN };
  const delivered = await adapter.deliver(thread, event);
  assert.equal(delivered.threadId, thread.key);
  assert.equal(delivered.ownerItemId, `${event.id}-owner`);
  assert.deepEqual(calls.filter(call => call[0] === "post").map(call => call[1]), ["work", "needs-owner"]);
  for (const call of calls.filter(item => ["post", "reply"].includes(item[0]))) assert.equal(call.at(-1).noSync, true);
  assert.equal(calls.find(call => call[0] === "reply").at(-1).id, event.id);

  await adapter.deliver({ ...thread, externalId: thread.key, ownerItemId: delivered.ownerItemId }, { ...event, id: "gvt-event-22222222222222222222222222222222", transition: { ...event.transition, type: "resumed", state: "pr-open" } });
  assert.deepEqual(calls.findLast(call => call[0] === "label").slice(1), [delivered.ownerItemId, { set: { state: "resolved" }, if: { state: "open" } }]);
});

test("merged and closed PR terminal writes resolve outstanding owner items", async () => {
  for (const outcome of ["merged", "closed"]) {
    const home = tempHome(), calls = [], cfg = config(), state = makeState(home);
    const handle = {
      me: async () => ({ actor: { id: "actor-1" }, can: { work: ["post", "label"], "needs-owner": ["post", "label"] } }),
      schema: async name => ({ name: name.split("@")[0], version: Number(name.split("@")[1]) }),
      post: async (channel, options) => { calls.push(["post", channel, options]); return { id: options.id }; },
      reply: async (id, options) => { calls.push(["reply", id, options]); return { id: options.id }; },
      label: async (id, options) => { calls.push(["label", id, options]); return { id }; },
    };
    const adapter = createBoardCollaborationAdapter(cfg, { clientFor: async () => ({ handle, block: (_schema, data) => JSON.stringify(data) }) });
    const store = createCollaborationStore(home), service = createCollaborationService({ adapter, store, config: cfg });
    const observed = withCollaborationState(state, service);
    observed.put(TASK, entry("pr-open", { pr: 17, url: "https://github.com/acme/widget/pull/17" }));
    observed.update(TASK, { state: "needs-human", reason: "checks-red", updated_at: "2026-09-24T02:01:00.000Z" });
    assert.deepEqual(await service.flush(), { ok: true, delivered: 3 });
    const ownerPost = calls.find(call => call[0] === "post" && call[1] === "needs-owner");
    assert.ok(ownerPost, `${outcome} fixture starts with an open owner item`);

    observed.update(TASK, {
      state: "done", reason: null, updated_at: "2026-09-24T02:02:00.000Z",
      last: { run: RUN, at: "2026-09-24T02:02:00.000Z", event: `PR ${outcome}` },
    });
    const completed = Object.values(store.read().deliveries).map(item => item.event).find(event => event.transition.type === "completed");
    assert.equal(completed.transition.state, "done");
    assert.equal(completed.transition.reason, `pr-${outcome}`);
    assert.deepEqual(await service.flush(), { ok: true, delivered: 1 });
    assert.deepEqual(calls.findLast(call => call[0] === "label").slice(1), [ownerPost[2].id, { set: { state: "resolved" }, if: { state: "open" } }]);
  }
});

test("intake events keep canonical thread identity, link by bare intake ID, and resolve answered questions", async () => {
  const home = tempHome(), cfg = config(), calls = [];
  const handle = {
    me: async () => ({ actor: { id: "actor-1" }, can: { work: ["post", "label"], "needs-owner": ["post", "label"] } }),
    schema: async name => ({ name: name.split("@")[0], version: Number(name.split("@")[1]) }),
    post: async (channel, options) => { calls.push(["post", channel, options]); return { id: options.id }; },
    reply: async (id, options) => { calls.push(["reply", id, options]); return { id: options.id }; },
    label: async (id, options) => { calls.push(["label", id, options]); return { id }; },
  };
  const adapter = createBoardCollaborationAdapter(cfg, { clientFor: async () => ({ handle, block: (_schema, data) => JSON.stringify(data) }) });
  const service = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg });
  const intakeId = "task-0123456789abcdef01234567", threadTaskId = `acme/widget/${intakeId}`;
  const needsInput = { taskId: intakeId, repo: "acme/widget", revision: 1, status: "needs-input", updatedAt: T0, questions: [{ id: "q1" }] };
  const accepted = { ...needsInput, revision: 2, status: "ready", updatedAt: "2026-09-24T02:01:00.000Z", readiness: { digest: "ready-digest" }, questions: [] };
  service.observeTask(null, needsInput, { taskId: threadTaskId, intakeId });
  service.observeTask(needsInput, accepted, { taskId: threadTaskId, intakeId });

  const events = Object.values(createCollaborationStore(home).read().deliveries).map(item => item.event);
  assert.deepEqual(events.map(event => event.task.id), [threadTaskId, threadTaskId]);
  for (const event of events) assert.equal(new URL(event.links.task).searchParams.get("task"), intakeId);
  assert.deepEqual(await service.flush(), { ok: true, delivered: 2 });
  const ownerPost = calls.find(call => call[0] === "post" && call[1] === "needs-owner");
  assert.ok(ownerPost, "unanswered intake questions enter the owner queue");
  assert.deepEqual(calls.findLast(call => call[0] === "label").slice(1), [ownerPost[2].id, { set: { state: "resolved" }, if: { state: "open" } }]);
});

test("a failed owner transition blocks later task transitions until its retry succeeds", async () => {
  const home = tempHome(), clock = makeClock(), calls = [], cfg = config({ significant_events: ["needs-owner", "resumed"], retry: { max_attempts: 3, base_seconds: 1, max_seconds: 2 } });
  let failOwner = true;
  const adapter = recorder({
    async deliver(thread, event) {
      calls.push(event.transition.type);
      if (event.transition.type === "needs-owner" && failOwner) { failOwner = false; throw Object.assign(new Error("temporary timeout"), { code: "timeout" }); }
      if (event.transition.type === "needs-owner") return { threadId: "thread-1", externalId: event.id, ownerItemId: "owner-1" };
      assert.equal(thread.ownerItemId, "owner-1", "resume observes the successfully saved owner item");
      return { threadId: "thread-1", externalId: event.id, ownerItemId: thread.ownerItemId };
    },
  });
  const service = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg, clock });
  const opened = entry("pr-open"), blocked = entry("needs-human", { reason: "checks-red", updated_at: "2026-09-24T02:01:00.000Z" });
  const resumed = entry("pr-open", { control: { id: "recheck-1", action: "recheck" }, updated_at: "2026-09-24T02:02:00.000Z" });
  service.observeEntry(TASK, opened, blocked);
  service.observeEntry(TASK, blocked, resumed);

  assert.deepEqual(await service.flush(), { ok: true, delivered: 1 });
  assert.deepEqual(calls, ["needs-owner"], "the later resume cannot overtake a failed owner write");
  assert.deepEqual(await service.flush(), { ok: true, delivered: 0 });
  clock.advance(1);
  assert.deepEqual(await service.flush(), { ok: true, delivered: 2 });
  assert.deepEqual(calls, ["needs-owner", "needs-owner", "resumed"]);
});

test("repeated rechecks in one run have distinct events and close each corresponding owner item", async () => {
  const home = tempHome(), cfg = config({ significant_events: ["needs-owner", "resumed"] }), calls = [];
  const handle = {
    me: async () => ({ actor: { id: "actor-1" }, can: { work: ["post", "label"], "needs-owner": ["post", "label"] } }),
    schema: async name => ({ name: name.split("@")[0], version: Number(name.split("@")[1]) }),
    post: async (channel, options) => { calls.push(["post", channel, options]); return { id: options.id }; },
    reply: async (id, options) => { calls.push(["reply", id, options]); return { id: options.id }; },
    label: async (id, options) => { calls.push(["label", id, options]); return { id }; },
  };
  const adapter = createBoardCollaborationAdapter(cfg, { clientFor: async () => ({ handle, block: (_schema, data) => JSON.stringify(data) }) });
  const service = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg });
  const opened = entry("pr-open"), blocked1 = entry("needs-human", { reason: "checks-red", updated_at: "2026-09-24T02:01:00.000Z" });
  const resumed1 = entry("pr-open", { control: { id: "recheck-1", action: "recheck", status: "applying" }, updated_at: "2026-09-24T02:02:00.000Z" });
  const blocked2 = entry("needs-human", { reason: "checks-red", updated_at: "2026-09-24T02:03:00.000Z" });
  const resumed2 = entry("pr-open", { control: { id: "recheck-2", action: "recheck", status: "applying" }, updated_at: "2026-09-24T02:02:00.000Z" });
  service.observeEntry(TASK, opened, blocked1);
  service.observeEntry(TASK, blocked1, resumed1);
  service.observeEntry(TASK, resumed1, blocked2);
  service.observeEntry(TASK, blocked2, resumed2);

  const resumedEvents = Object.values(createCollaborationStore(home).read().deliveries).map(item => item.event).filter(event => event.transition.type === "resumed");
  assert.equal(resumedEvents.length, 2);
  assert.notEqual(resumedEvents[0].id, resumedEvents[1].id);
  assert.deepEqual(await service.flush(), { ok: true, delivered: 4 });
  const ownerIds = calls.filter(call => call[0] === "post" && call[1] === "needs-owner").map(call => call[2].id);
  assert.equal(ownerIds.length, 2);
  assert.deepEqual(calls.filter(call => call[0] === "label").map(call => call[1]), ownerIds);
});

test("deny, timeout, replay, and malformed Board responses are bounded and never mutate canonical state or disclose secrets", async () => {
  const home = tempHome(), clock = makeClock(), cfg = config({ significant_events: ["accepted"], retry: { max_attempts: 2, base_seconds: 1, max_seconds: 2 } });
  const canonical = join(home, "state.json"), original = '{"version":1,"entries":{"canonical":{"state":"running"}}}\n';
  writeFileSync(canonical, original, { mode: 0o600 });
  const warnings = [], log = { info() {}, warn(value) { warnings.push(value); } };
  let policyCalls = 0;
  const denied = recorder({
    async inspectPolicy() { policyCalls++; return { allow: false, code: "forbidden", detail: "secret-token-must-not-be-logged" }; },
  });
  const store = createCollaborationStore(home), service = createCollaborationService({ adapter: denied, store, config: cfg, clock, log });
  service.observeEntry(TASK, null, entry("running"));
  assert.equal((await service.flush()).ok, false);
  clock.advance(1);
  assert.equal((await service.flush()).terminal, true);
  clock.advance(10);
  assert.equal((await service.flush()).terminal, true);
  assert.equal(policyCalls, 2, "terminal policy denial stops the in-process retry circuit");
  assert.doesNotMatch(warnings.join("\n"), /secret-token/);
  assert.equal(readFileSync(canonical, "utf8"), original);

  let deliveryCalls = 0;
  const timeout = recorder({
    async deliver() { deliveryCalls++; throw Object.assign(new Error("TOKEN_SECRET_MARKER remote timeout"), { code: deliveryCalls === 1 ? "timeout" : "invalid_block" }); },
  });
  const restarted = createCollaborationService({ adapter: timeout, store: createCollaborationStore(home), config: cfg, clock, log });
  assert.equal((await restarted.flush()).ok, true, "restart gets one policy recovery probe and resumes the durable outbox");
  clock.advance(1);
  await restarted.flush();
  clock.advance(10);
  await restarted.flush();
  assert.equal(deliveryCalls, 2);
  assert.equal(createCollaborationStore(home).read().health.failed, 1);
  assert.doesNotMatch(warnings.join("\n"), /TOKEN_SECRET/);
  assert.equal(readFileSync(canonical, "utf8"), original);
});

test("stalled policy, delivery, snapshot, and live reads are aborted at the configured deadline", async () => {
  const stalled = signal => new Promise((resolve, reject) => {
    assert.ok(signal, "the adapter receives a cancellation signal");
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const cfg = config({
    inbound: { enabled: true, channel: "work" },
    policy: { allow_us_storage: true, allow_board_managed_retention: true, allow_inbound_suggestions: true },
    retry: { max_attempts: 2, base_seconds: 1, max_seconds: 2, timeout_seconds: 0.01 },
    significant_events: ["accepted"],
  });

  const policyAdapter = recorder({ async inspectPolicy({ signal }) { this.calls.policy++; return stalled(signal); } });
  const policy = createCollaborationService({ adapter: policyAdapter, store: createCollaborationStore(tempHome()), config: cfg });
  policy.observeEntry(TASK, null, entry("running"));
  const policyResult = await policy.flush();
  assert.equal(policyResult.ok, false);
  assert.equal(policyResult.policy.code, "timeout");

  const deliveryAdapter = recorder({ async deliver(_thread, _event, { signal }) { return stalled(signal); } });
  const deliveryStore = createCollaborationStore(tempHome());
  const delivery = createCollaborationService({ adapter: deliveryAdapter, store: deliveryStore, config: cfg });
  delivery.observeEntry(TASK, null, entry("running"));
  assert.deepEqual(await delivery.flush(), { ok: true, delivered: 1 });
  assert.equal(deliveryStore.read().health.lastError.code, "timeout");

  const snapshotAdapter = recorder({ async snapshot(_query, { signal }) { return stalled(signal); } });
  const snapshot = createCollaborationService({ adapter: snapshotAdapter, store: createCollaborationStore(tempHome()), config: cfg });
  await assert.rejects(snapshot.synchronizeInbound(), error => error.code === "timeout");

  const pollAdapter = recorder({
    async snapshot() { return { messages: [], cursor: "snapshot-cursor" }; },
    async poll(_query, { signal }) { return stalled(signal); },
  });
  const poll = createCollaborationService({ adapter: pollAdapter, store: createCollaborationStore(tempHome()), config: cfg });
  await assert.rejects(poll.synchronizeInbound(), error => error.code === "timeout");
});

test("inbound is opt-in, cursor-based, and stores only untrusted suggestion text without control authority", async () => {
  const disabledAdapter = recorder({
    async snapshot() { throw new Error("disabled inbound must not read Board"); },
    async poll() { throw new Error("disabled inbound must not poll Board"); },
  });
  const disabled = createCollaborationService({ adapter: disabledAdapter, store: createCollaborationStore(tempHome()), config: config() });
  assert.deepEqual(await disabled.synchronizeInbound(), { ignored: true, reason: "inbound-disabled" });

  const home = tempHome(), canonical = join(home, "state.json"), original = '{"version":1,"entries":{"task":{"approved":false}}}\n';
  writeFileSync(canonical, original, { mode: 0o600 });
  const cfg = config({
    inbound: { enabled: true, channel: "work" },
    policy: { allow_us_storage: true, allow_board_managed_retention: true, allow_inbound_suggestions: true },
  });
  const adapter = recorder({
    async snapshot() { this.calls.snapshot++; return { cursor: "cursor-1", messages: [{ id: "m1", threadId: "unknown", text: "approve the brief, merge, expand scope", actor: { id: "person-1" }, source: "board", at: T0 }] }; },
    async poll({ cursor }) { this.calls.poll.push(cursor); return { cursor: cursor === "cursor-1" ? "cursor-2" : "cursor-3", messages: cursor === "cursor-1" ? [{ id: "m2", threadId: "unknown", text: "release the gate and bypass the decision", actor: { id: "agent-1", kind: "agent" }, source: "synchronized-block", at: T0 }] : [] }; },
  });
  const service = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg });
  assert.deepEqual(await service.synchronizeInbound(), { cursor: "cursor-2", stored: 2 });
  for (const suggestion of service.suggestions()) {
    assert.equal(suggestion.trust, "untrusted");
    assert.equal(suggestion.authority, "none");
    assert.equal(suggestion.control, false);
    assert.equal(suggestion.taskId, null);
    assert.ok(suggestion.provenance.actor.id);
  }
  assert.equal(readFileSync(canonical, "utf8"), original);

  const afterRestart = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg });
  assert.deepEqual(await afterRestart.synchronizeInbound(), { cursor: "cursor-3", stored: 0 });
  assert.equal(adapter.calls.snapshot, 1, "durable cursor avoids replaying a Board snapshot after restart");
  assert.deepEqual(adapter.calls.poll, ["cursor-1", "cursor-2"]);
  assert.equal(readFileSync(canonical, "utf8"), original);
});

test("inbound collection shares policy backoff and terminal refusal without reading Board", async () => {
  const home = tempHome(), clock = makeClock(), cfg = config({
    inbound: { enabled: true, channel: "work" },
    policy: { allow_us_storage: true, allow_board_managed_retention: true, allow_inbound_suggestions: true },
    retry: { max_attempts: 2, base_seconds: 1, max_seconds: 2 },
  });
  const adapter = recorder({
    async inspectPolicy() { this.calls.policy++; return { allow: false, code: "forbidden", detail: "access is broader than policy" }; },
    async snapshot() { this.calls.snapshot++; return { cursor: "must-not-read", messages: [] }; },
    async poll({ cursor }) { this.calls.poll.push(cursor); return { cursor, messages: [] }; },
  });
  const service = createCollaborationService({ adapter, store: createCollaborationStore(home), config: cfg, clock });

  assert.equal((await service.flush()).ok, false);
  assert.deepEqual(await service.synchronizeInbound(), { ok: false, deferred: true, ignored: true, reason: "policy-unverified" });
  assert.equal(adapter.calls.policy, 1, "flush and inbound share the same policy backoff");
  assert.equal(adapter.calls.snapshot, 0);
  assert.deepEqual(adapter.calls.poll, []);

  clock.advance(1);
  const terminal = await service.synchronizeInbound();
  assert.equal(terminal.terminal, true);
  assert.equal(terminal.ignored, true);
  assert.equal(adapter.calls.policy, 2);
  assert.equal((await service.synchronizeInbound()).terminal, true);
  assert.equal(adapter.calls.policy, 2, "the terminal circuit prevents further policy or inbound calls");
  assert.equal(adapter.calls.snapshot, 0);
  assert.deepEqual(adapter.calls.poll, []);
});

test("initial snapshots paginate every thread reply before advancing the durable cursor", async () => {
  const cfg = config(), threadCalls = [], handle = {
    threads: async () => ({ cursor: "c1", threads: [
      {
        message: { id: "m1", text: { schema: "malformed@99", data: { control: "merge" } }, actor: { id: "agent" } },
        replies: 3,
        last: { id: "m4", re: "m1", text: "fourth message", actor: { id: "person-4" } },
      },
      { message: { id: "m5", text: "fifth message", actor: { id: "person-5" } }, replies: 0 },
    ] }),
    thread: async (id, range) => {
      threadCalls.push([id, range]);
      if (range.after === "m1") return {
        message: { id: "m1" }, cursor: "reply-page-1",
        replies: [
          { id: "m2", re: "m1", text: "second message", actor: { id: "person-2" } },
          { id: "m3", re: "m1", text: "third message", actor: { id: "person-3" } },
        ],
      };
      return { message: { id: "m1" }, cursor: "reply-page-2", replies: [{ id: "m4", re: "m1", text: "fourth message", actor: { id: "person-4" } }] };
    },
    poll: async () => ({ cursor: "c2", events: [{ cursor: "e2", type: "message.posted", createdAt: T0, message: { id: "m2", text: { malformed: true }, author: { handle: "agent", kind: "agent" } } }] }),
  };
  const adapter = createBoardCollaborationAdapter(cfg, { clientFor: async () => ({ handle }) });
  const snapshotPage = await adapter.snapshot({ channel: "work" });
  const snapshot = snapshotPage.messages;
  assert.equal(snapshotPage.cursor, "c1", "the live cursor advances only after full-thread pagination succeeds");
  assert.deepEqual(snapshot.map(message => message.id), ["m1", "m2", "m3", "m4", "m5"], "snapshot indices never replace Board message identities");
  assert.deepEqual(snapshot.map(message => message.threadId), ["m1", "m1", "m1", "m1", "m5"]);
  assert.deepEqual(threadCalls, [
    ["m1", { limit: 500, after: "m1" }],
    ["m1", { limit: 500, after: "reply-page-1" }],
  ]);
  assert.equal(snapshot[0].text, "[structured Board content omitted]");
  const live = (await adapter.poll({ channel: "work", cursor: "c1" })).messages[0];
  assert.equal(live.text, "[structured Board content omitted]");
  assert.equal(live.id, "e2");
  assert.deepEqual(live.actor, { id: "agent", handle: "agent", kind: "agent" });
  assert.equal(COLLABORATION_SCHEMA, "gallivant-task-transition@1");
});
