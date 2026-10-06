import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync, unlinkSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { gzipSync, gunzipSync } from "node:zlib";
import { makeExecution } from "../lib/execution.mjs";
import { capabilitiesFor } from "../lib/harness.mjs";
import { makeAgentsTransport, checkAgentsAccess } from "../lib/openai_agents.mjs";
import { validateAgentsConfig } from "../lib/openai_agents_config.mjs";
import { agentsHttp } from "../lib/openai_agents_http.mjs";
import { contentHash, prepareAgentsSources, AGENTS_WORKSPACE_HELPER } from "../lib/openai_agents_sources.mjs";
import { start } from "../lib/commands/start.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeGit } from "../lib/git.mjs";
import { CONFIG, GOOD_PRD, fakeCredential, fakeIdentity, fakeNotify, fakeGit, fakeGh, silentLog } from "./helpers.mjs";
import { requestControl } from "../lib/control.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { doctor } from "../lib/commands/doctor.mjs";
import { checkHarness } from "../lib/probe.mjs";
import { reconcileExecutionResult } from "../lib/execution_result.mjs";
import { readJson } from "../lib/fs.mjs";
const config = { account: "fixture", organization: "org-fixture", project: "proj-fixture", model: "fixture-model", environment: "openai_hosted", container_size: "small", network: { access: "disabled" }, allowance: { remainingUsd: 2, reservedUsd: 0.1 } };
const head = "a".repeat(40), initial = "original\n", changed = "corrected\n";
const sources = { data: Buffer.from("snapshot").toString("base64"), hash: contentHash("snapshot"), hashes: { "answer.txt": contentHash(initial) }, modes: { "answer.txt": 0o644 }, inputHead: head, repo: "acme/widget", branch: "work/widget" };
const input = { operationId: "implementation", prompt: "Implement the approved brief", inputHead: head, repo: sources.repo, branch: sources.branch, base: "main", model: config.model, environment: config.environment, allowance: config.allowance, sources };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agents-offline-")), calls = [], sessions = new Map(), turns = new Map();
  const clock = { now: () => 1_800_000_000_000 };
  let serial = 0, lost = null, events = [], items = [], artifactPages = [], result = null, artifactBytes = null, failure = null, answerFault = null;
  const content = () => artifactBytes ?? JSON.stringify(result);
  const page = data => ({ data, has_more: false, last_id: data.at(-1)?.id ?? null });
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname.replace("/v1", ""), search = new URL(url).searchParams;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method: options.method, body, key: options.headers["Idempotency-Key"] });
    assert.equal(options.headers["OpenAI-Beta"], "agents=v1"); assert.equal(options.headers["OpenAI-Project"], config.project);
    const fault = body?.events?.[0]?.type.endsWith(".tool_result") ? answerFault : null;
    if (fault) answerFault = null;
    if (fault?.phase === "before") {
      if (fault.timeout) await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("answer aborted before acceptance")), { once: true }));
      throw new Error("answer delivery lost before acceptance");
    }
    if (failure && (typeof failure === "number" || failure.route === route)) { const status = typeof failure === "number" ? failure : failure.status; failure = null; return new Response("private provider error secret", { status, headers: { "retry-after": "2" } }); }
    let value;
    if (route === `/models/${config.model}`) value = { id: config.model };
    else if (route === "/agents/sessions" && options.method === "GET") value = page([...sessions.values()]);
    else if (route === "/agents/sessions" && options.method === "POST") {
      const session = { id: `sess-${++serial}`, metadata: body.metadata, agent: body.agent, environment: { id: `env-${serial}`, type: "openai_hosted", container_size: "small", network: config.network, packages: {} }, status: "idle", required_actions: [] };
      sessions.set(session.id, session); value = session;
    } else {
      const sessionId = route.split("/")[3], session = sessions.get(sessionId);
      if (route.includes("/environments/")) value = route.endsWith("/files") ? {} : { id: route.split("/")[3], status: fixtureEnvironment };
      else if (route.endsWith("/events") && options.method === "GET") {
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
      } else if (route.endsWith("/events")) {
        const event = body.events[0];
        if (event.type.endsWith(".message")) {
          const turn = { id: `turn-${turns.size + 1}`, session_id: sessionId, subagent_id: null, status: "in_progress", completed_at: null, usage: null }; turns.set(turn.id, turn); session.status = "running";
        } else if (event.type.endsWith(".cancel")) { const turn = [...turns.values()].findLast(t => t.session_id === sessionId); turn.status = "cancelled"; }
        else if (event.type.endsWith(".tool_result")) {
          const action = session.required_actions.find(a => a.call_id === event.call_id && a.turn_id === event.turn_id);
          items = [{ id: "question-item", type: "function_call", turn_id: event.turn_id, call_id: event.call_id, name: action.name, arguments: action.arguments, status: "completed" },
            { id: "answer-item", type: "function_call_output", turn_id: event.turn_id, call_id: event.call_id, status: "completed", error: null, output: event.output }];
          session.required_actions = [];
        }
        value = null;
      } else if (route.endsWith("/turns")) value = page([...turns.values()].filter(t => t.session_id === sessionId));
      else if (route.includes("/turns/") && !route.endsWith("/items")) value = turns.get(route.split("/").at(-1));
      else if (route.endsWith("/items")) value = items.length ? { data: [items[search.get("after") ? 1 : 0]], has_more: !search.get("after") && items.length > 1, last_id: search.get("after") ? items[1].id : items[0].id } : page([]);
      else if (route.endsWith("/artifacts")) value = artifactPages[search.get("after") ? 1 : 0] || page([]);
      else if (route.endsWith("/content")) {
        if (lost === route) { lost = null; throw new Error("lost reply"); }
        return new Response(content());
      }
      else if (options.method === "DELETE") { sessions.delete(sessionId); value = null; }
      else value = session;
    }
    if (fault?.phase === "after") throw new Error("answer reply lost after acceptance");
    if (lost === route) { lost = null; throw new Error("lost reply"); }
    return new Response(value === null ? null : JSON.stringify(value), { status: value === null ? 202 : 200 });
  };
  let fixtureEnvironment = "connected";
  const http = agentsHttp({ credential: () => "offline-test-key", organization: config.organization, project: config.project, fetcher });
  const transport = () => makeAgentsTransport({ root, taskId: "acme/widget/task", account: config.account, config, http, clock });
  const service = (limits = {}) => makeExecution({ root, taskId: "acme/widget/task", account: config.account, provider: "openai-agents", transport: transport(), capabilities: { ...capabilitiesFor("openai-agents"), models: [config.model] }, clock, limits, jitter: () => 0 });
  const finish = (status = "completed") => { const turn = [...turns.values()].at(-1); turn.status = status; turn.completed_at = clock.now() / 1000; sessions.get(turn.session_id).status = "idle"; return turn; };
  const artifact = job => {
    artifactBytes = null;
    result = { version: 1, inputHead: head, repo: input.repo, branch: input.branch, files: [{ path: "answer.txt", beforeHash: contentHash(initial), afterHash: contentHash(changed), text: changed }], pr: { title: "Implement answer", body: "Actual result" }, tests: [{ command: "node --test", exit: 0, inputHead: head, output: "passed" }] };
    artifactPages = [{ data: [{ id: "unrelated", turn_id: "other", path: "/workspace/outputs/old.json" }], has_more: true, last_id: "unrelated" }, { data: [{ id: "artifact-1", session_id: job.execution.sessionId, environment_id: job.execution.environment, turn_id: job.execution.turnId, path: "/workspace/outputs/result.json", size_bytes: Buffer.byteLength(JSON.stringify(result)) }], has_more: false }];
  };
  return { root, clock, calls, sessions, turns, http, fetcher, transport, service, finish, artifact, syncArtifactSize: () => { artifactPages[1].data[0].size_bytes = Buffer.byteLength(content()); }, setArtifactBytes: v => { artifactBytes = v; }, setEvents: v => { events = v; }, setItems: v => { items = v; }, setEnvironment: v => { fixtureEnvironment = v; }, fail: v => { failure = v; }, failAt: (route, status) => { failure = { route, status }; }, lose: v => { lost = v; }, loseAnswer: v => { answerFault = v; }, getResult: () => result };
}
async function unsupportedHost(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: "unsupported-fixture" });
  try { return await fn(); } finally { Object.defineProperty(process, "platform", descriptor); }
}
test("managed readiness proves native isolation before API reads and doctor reports unsupported hosts", async t => {
  const f = fixture(), selected = { harness: { "openai-agents": config } }, before = structuredClone(selected);
  const ready = await checkHarness("openai-agents", selected, { http: f.http });
  assert.equal(ready.ok, true); assert.equal(ready.verificationSandbox.probe, "passed");
  assert.equal(ready.verificationSandbox.network, "disabled"); assert.match(ready.detail, /inference.*unverified/);
  const calls = f.calls.length;
  const home = join(f.root, "doctor"); mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({ ...CONFIG, home, notify: null, repos: [],
    worktrees: join(f.root, "planned-worktrees"), harness: selected.harness }), { mode: 0o600 });
  const denied = await unsupportedHost(async () => {
    const result = await checkHarness("openai-agents", selected, { http: f.http });
    assert.equal(result.ok, false); assert.equal(result.detail, "EXECUTION_VERIFICATION_SANDBOX");
    assert.match(result.fix, /sandbox-exec.*bwrap.*namespaces/);
    const report = await doctor({ home, env: {}, resolve: async () => ({ token: null, why: "offline credential fixture" }),
      harnessCheck: (provider, value) => checkHarness(provider, value, { http: f.http }) });
    const row = report.find(check => check.name === "openai-agents readiness");
    assert.equal(row.ok, false); assert.equal(row.detail, result.detail); assert.equal(row.fix, result.fix);
    return row;
  });
  assert.equal(f.calls.length, calls); assert.deepEqual(selected, before);
  assert.equal(existsSync(join(f.root, "planned-worktrees")), false);
  const report = join(f.root, "native-readiness-evidence.json");
  writeFileSync(report, JSON.stringify({ kind: "Native host enforcement plus provider-shaped offline API reads", native: ready.verificationSandbox,
    unsupported_platform_fixture: denied, provider_reads_before_refusal: calls, provider_reads_after_refusal: f.calls.length, paid_calls: 0 }, null, 2));
  t.diagnostic(`native readiness evidence: ${report}`);
});
test("unsupported host blocks managed start before cloning, snapshots or provider access", async () => {
  const f = fixture(), operator = join(f.root, "operator"); mkdirSync(join(operator, "docs/prds"), { recursive: true });
  const path = join(operator, "docs/prds/task.md"); writeFileSync(path, GOOD_PRD.replace("harness: codex", "harness: openai-agents"));
  const state = makeState(f.root), mutations = [];
  const ctx = { home: f.root, state, config: { ...CONFIG, home: f.root, worktrees: join(f.root, "worktrees"), harness: { "openai-agents": config } },
    log: silentLog, notify: fakeNotify(), credential: fakeCredential(), identity: fakeIdentity(), clock: f.clock, executionFor: f.service,
    git: { toplevel: async () => operator, create: async () => { mutations.push("clone"); assert.fail("host refusal must precede clone"); } },
    gh: { repoInfo: async () => ({ nameWithOwner: input.repo, defaultBranch: "main" }), branchExists: async () => true },
    writePrd: () => mutations.push("snapshot"), readPrd: () => null };
  await unsupportedHost(async () => await assert.rejects(start(ctx, { path }), /EXECUTION_VERIFICATION_SANDBOX/));
  assert.deepEqual(mutations, []); assert.deepEqual(state.entries(), []); assert.equal(f.calls.length, 0);
  assert.equal(existsSync(join(f.root, "worktrees")), false); assert.equal(f.service().current(), null);
});
test("unsupported host refuses preparation, direct dispatch and manual continuation while artifact recovery remains available", async () => {
  const f = fixture();
  await unsupportedHost(async () => {
    await assert.rejects(f.service().prepare(input), { code: "EXECUTION_VERIFICATION_SANDBOX" });
    await assert.rejects(f.transport().submit({ ...input, runId: "refused", idempotencyKey: "refused" }), { code: "EXECUTION_VERIFICATION_SANDBOX" });
  });
  assert.equal(f.calls.length, 0); assert.equal(existsSync(join(f.root, "agents.json")), false);
  const job = await f.service().submit(input); f.finish(); f.artifact(job);
  await unsupportedHost(async () => { await f.service().reconcile({ force: true }); assert.equal((await f.service().collect()).files[0].text, changed); });
  const state = makeState(f.root), taskId = "acme/widget/task", worktree = join(f.root, "checkout");
  state.put(taskId, { ...newEntry({ repo: input.repo, branch: input.branch, worktree, harness: "openai-agents", session: job.execution.sessionId,
    pr: 42, state: STATES.needsHuman, nowIso: new Date(f.clock.now()).toISOString() }), execution: f.service().current().execution,
    last: { run: job.id, exit: 0, cost: null } });
  const registry = readFileSync(join(f.root, "state.json"), "utf8"), agents = readFileSync(join(f.root, "agents.json"), "utf8"), calls = f.calls.length;
  const ctx = { home: f.root, state, config: { ...CONFIG, harness: { "openai-agents": config } }, ownLogin: "me", clock: f.clock,
    git: { exists: () => false, fromBranch: async () => assert.fail("host refusal must precede checkout recreation") },
    gh: fakeGh(), log: silentLog, notify: fakeNotify(), executionFor: f.service, readPrd: () => null };
  await unsupportedHost(async () => {
    await assert.rejects(resume(ctx, { handle: taskId }), /EXECUTION_VERIFICATION_SANDBOX/);
    await assert.rejects(f.transport().continue({ ...input, runId: "refused-correction", idempotencyKey: "refused-correction",
      sessionId: job.execution.sessionId }), { code: "EXECUTION_VERIFICATION_SANDBOX" });
  });
  assert.equal(f.calls.length, calls); assert.equal(readFileSync(join(f.root, "agents.json"), "utf8"), agents);
  assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), registry); assert.equal(f.service().current().id, job.id);
  assert.equal(f.service().current().execution.sessionId, job.execution.sessionId); assert.equal(f.service().outcome(job.id).cost, null);
  assert.equal(existsSync(worktree), false); assert.equal(f.sessions.size, 1);
});
test("configuration refuses unavailable policy, missing billing selectors and private context", () => {
  assert.equal(validateAgentsConfig(config), config);
  for (const patch of [{ model: null }, { organization: null }, { environment: "none" }, { container_size: "auto" }, { allowance: null }, { mandatory_policy: ["auto-review"] }, { context_paths: ["/private"] }]) assert.throws(() => validateAgentsConfig({ ...config, ...patch }));
});
test("read-only account probe records exact selectors without claiming inference or hard caps", async () => {
  const f = fixture(), access = await checkAgentsAccess(config, { http: f.http }); assert.equal(access.ok, true); assert.equal(access.effective.model, config.model); assert.equal(access.effective.cost.hardCap, false); assert.match(access.detail, /unverified/); assert.equal(f.calls.some(c => c.method === "POST"), false);
});
test("real REST adapter: implementation, artifact pagination, restart and same-session correction", async () => {
  const f = fixture(); await f.service().prepare(input); const job = await f.service().submit(input);
  assert.equal(job.pid, undefined); assert.equal(job.execution.environment, "env-1"); assert.equal(job.execution.effective.environment.network.access, "disabled");
  const send = f.calls.findIndex(c => c.method === "POST" && c.route.endsWith("/events")); assert.ok(f.calls.slice(0, send).some(c => c.method === "GET" && c.route.endsWith("/events")));
  f.finish(); f.artifact(job); await f.service().reconcile({ force: true }); const result = await f.service().collect();
  assert.equal(result.files[0].text, changed); assert.equal(result.artifact.hash, contentHash(JSON.stringify(f.getResult()))); assert.equal(f.service().current().running, false);
  const correction = await f.service().continue({ ...input, operationId: "review-correction", sessionId: job.execution.sessionId });
  assert.equal(correction.execution.sessionId, job.execution.sessionId); assert.notEqual(correction.execution.turnId, job.execution.turnId); assert.equal(f.sessions.size, 1);
  assert.ok(f.calls.some(c => c.route.endsWith("/files") && c.method === "POST"));
});
for (const lost of ["/agents/sessions", "/agents/sessions/sess-1/events"]) test(`lost ${lost} reply stays fenced and never duplicates dispatch`, async () => {
  const f = fixture(); f.lose(lost); await assert.rejects(f.service().submit(input), /lost reply/);
  await assert.rejects(f.service().submit(input), { code: "EXECUTION_UNKNOWN" }); await f.service().reconcile({ force: true });
  if (lost.endsWith("events")) assert.equal(f.service().current().execution.acceptance, "accepted");
  else assert.equal(f.service().current().execution.acceptance, "unknown");
  assert.equal(f.calls.filter(c => c.method === "POST" && c.route === "/agents/sessions").length, 1);
});
test("failed or unsent launch recovery stops provider I/O and preserves ambiguity", async () => {
  for (const status of ["idle", "failed"]) {
    const f = fixture(); f.lose("/agents/sessions"); await assert.rejects(f.service().submit(input)); f.sessions.get("sess-1").status = status;
    await f.service().reconcile({ force: true }); const calls = f.calls.length;
    await f.service().reconcile({ force: true }); assert.equal(f.calls.length, calls); assert.equal(f.service().current().execution.acceptance, "unknown");
    assert.match(Object.values(readJson(join(f.root, "agents.json")).operations)[0].recoveryBlocked, status === "failed" ? /session failed/ : /before any input send/);
  }
});
test("unresolved root identity has a three-attempt recovery circuit without resending", async () => {
  const f = fixture(); f.lose("/agents/sessions/sess-1/events"); await assert.rejects(f.service().submit(input)); f.turns.clear();
  for (let n = 0; n < 3; n++) await f.service().reconcile({ force: true });
  const calls = f.calls.length; await f.service().reconcile({ force: true }); assert.equal(f.calls.length, calls);
  assert.equal(f.calls.filter(c => c.method === "POST" && c.route.endsWith("/events")).length, 1);
  assert.match(Object.values(readJson(join(f.root, "agents.json")).operations)[0].recoveryBlocked, /three launch reconciliation failures/);
});
for (const status of ["failed", "cancelled"]) test(`idle session and ${status} root cannot succeed`, async () => {
  const f = fixture(); await f.service().submit(input); f.finish(status); await f.service().reconcile({ force: true });
  if (status === "failed") assert.equal((await f.service().collect()).outcome.ok, false);
  assert.equal(f.service().current().execution.providerState, status === "failed" ? "failed" : "cancelled");
});
test("subagent completion, closed stream and idle session never settle a running root", async () => {
  const f = fixture(), job = await f.service().submit(input); f.sessions.get(job.execution.sessionId).status = "idle";
  f.setEvents([{ event_id: "subagent-done", type: "agent.session.turn.completed", session_id: job.execution.sessionId, turn_id: "foreign", subagent_id: "child" }]);
  await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.providerState, "running"); await assert.rejects(f.service().collect(), { code: "EXECUTION_RESULT" });
});
test("reconnect restores paginated items, discards reordered deltas after done and labels gaps", async () => {
  const f = fixture(), job = await f.service().submit(input), ex = job.execution;
  f.setItems([{ id: "message-1", turn_id: ex.turnId, status: "completed", content: [{ text: "final text" }] }, { id: "message-2", turn_id: ex.turnId, status: "completed", content: [{ text: "second" }] }]);
  f.setEvents([{ event_id: "late-delta", type: "agent.session.turn.output_text.delta", session_id: ex.sessionId, turn_id: ex.turnId, item_id: "message-1", delta: "duplicate" }]);
  f.finish(); await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.providerState, "running"); await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.providerState, "retrieving-results");
  const journal = readFileSync(join(f.service().dirOf(job.id), "events.jsonl"), "utf8"); assert.match(journal, /final text/); assert.match(journal, /second/); assert.match(journal, /intermediate deltas/); assert.doesNotMatch(journal, /duplicate/);
});
test("authorized required action answer targets exact existing turn and rejects arbitrary tools", async () => {
  const f = fixture(), job = await f.service().submit(input), ex = job.execution, session = f.sessions.get(ex.sessionId);
  session.required_actions = [{ type: "function_call", name: "ask_operator", arguments: '{"question":"Which value?"}', turn_id: ex.turnId, call_id: "call-1" }];
  f.turns.get(ex.turnId).status = "waiting"; await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.providerState, "waiting-for-input");
  const answer = { operationId: "answer-1", sessionId: ex.sessionId, turnId: ex.turnId, callId: "call-1", answer: "Use 42", authorized: true };
  await assert.rejects(f.service().respond({ ...answer, turnId: "foreign" }), { code: "EXECUTION_ACTION" });
  assert.deepEqual(await f.service().respond(answer), { accepted: true }); assert.equal(f.turns.size, 1);
  assert.deepEqual(await f.service().respond(answer), { accepted: true }); assert.equal(f.calls.filter(c => c.body?.events?.[0]?.type.endsWith(".tool_result")).length, 1);
  session.required_actions = [{ type: "function_call", name: "run_shell", turn_id: ex.turnId, call_id: "evil" }]; await assert.rejects(f.service().respond({ ...answer, operationId: "evil", callId: "evil" }), { code: "EXECUTION_ACTION" });
});
for (const mode of ["lost-before", "timeout-before", "lost-after", "cleanup"]) test(`operator answer ${mode} recovers the same call and key across restart`, async t => {
  const f = fixture(), job = await f.service().submit(input), ex = job.execution, session = f.sessions.get(ex.sessionId);
  session.required_actions = [{ type: "function_call", name: "ask_operator", arguments: { question: "Which value?" }, turn_id: ex.turnId, call_id: "call-1" }];
  f.turns.get(ex.turnId).status = "waiting"; await f.service().reconcile({ force: true });
  const answer = { operationId: "saved-answer", sessionId: ex.sessionId, turnId: ex.turnId, callId: "call-1", answer: "Use 42", authorized: true };
  if (mode === "cleanup") {
    const subscribe = f.http.subscribe;
    let failed = false;
    f.http.subscribe = async (...args) => { const stream = await subscribe(...args), close = stream.close;
      stream.close = async () => { await close(); if (!failed) { failed = true; throw new Error("stream cleanup reply lost"); } }; return stream; };
  } else f.loseAnswer({ phase: mode.endsWith("before") ? "before" : "after", timeout: mode === "timeout-before" });
  await assert.rejects(f.service(mode === "timeout-before" ? { deadlineMs: 30 } : {}).respond(answer), mode === "timeout-before" ? { code: "EXECUTION_DEADLINE" } : undefined);
  assert.equal(Object.values(f.service().state().answers)[0].accepted, false);
  const before = f.calls.length;
  await assert.rejects(f.service().respond({ ...answer, answer: "Use another value" }), { code: "EXECUTION_CONFLICT" });
  await assert.rejects(f.service().respond({ ...answer, authorized: false }), { code: "EXECUTION_ACTION" });
  assert.equal(f.calls.length, before);
  assert.deepEqual(await f.service().respond(answer), { accepted: true });
  const posts = f.calls.filter(c => c.body?.events?.[0]?.type.endsWith(".tool_result"));
  assert.equal(posts.length, mode.endsWith("before") ? 2 : 1); assert.equal(new Set(posts.map(c => c.key)).size, 1);
  assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1); assert.equal(f.service().current().id, job.id);
  assert.equal(f.service().current().execution.sessionId, ex.sessionId); assert.equal(f.service().current().execution.turnId, ex.turnId);
  const recoveredCalls = f.calls.length; assert.deepEqual(await f.service().respond(answer), { accepted: true }); assert.equal(f.calls.length, recoveredCalls);
  if (mode === "lost-after") assert.equal(f.calls.filter(c => c.route.endsWith(`/turns/${ex.turnId}/items`)).length, 2, "recover both authoritative item pages");
  f.finish(); f.artifact(job); await f.service().reconcile({ force: true }); await f.service().reconcile({ force: true });
  assert.equal((await f.service().collect()).files[0].text, changed); assert.equal(f.service().outcome(job.id).ok, true);
  const evidence = join(f.root, "answer-recovery-evidence.json");
  writeFileSync(evidence, JSON.stringify({ kind: "provider-shaped offline answer recovery", mode, runId: job.id, sessionId: ex.sessionId,
    turnId: ex.turnId, callId: answer.callId, posts: posts.length, idempotencyKeys: [...new Set(posts.map(c => c.key))], sessions: f.sessions.size,
    rootTurns: f.turns.size, accepted: Object.values(f.service().state().answers)[0].accepted, result: f.service().outcome(job.id), paid_calls: 0 }, null, 2));
  t.diagnostic(`answer recovery evidence: ${evidence}`);
});
test("ambiguous answer recovery refuses changed actions, missing proof, foreign roots and stopped sessions without resending", async () => {
  for (const mode of ["tool", "terminal", "missing", "foreign", "wrong-output", "stop"]) {
    const f = fixture(), job = await f.service().submit(input), ex = job.execution, session = f.sessions.get(ex.sessionId);
    const action = { type: "function_call", name: "ask_operator", arguments: {}, turn_id: ex.turnId, call_id: "call-1" };
    session.required_actions = [action]; f.turns.get(ex.turnId).status = "waiting";
    const answer = { operationId: "answer", sessionId: ex.sessionId, turnId: ex.turnId, callId: action.call_id, answer: "Use 42", authorized: true };
    f.loseAnswer({ phase: "before" }); await assert.rejects(f.service().respond(answer));
    if (mode === "tool") action.name = "run_shell";
    if (mode === "terminal") f.turns.get(ex.turnId).status = "completed";
    if (["missing", "foreign", "wrong-output"].includes(mode)) session.required_actions = [];
    if (["foreign", "wrong-output"].includes(mode)) f.setItems([
      { id: "call", type: "function_call", turn_id: mode === "foreign" ? "foreign" : ex.turnId, call_id: action.call_id, name: "ask_operator", status: "completed" },
      { id: "output", type: "function_call_output", turn_id: ex.turnId, call_id: action.call_id, output: "different", status: "completed", error: null }]);
    if (mode === "stop") await f.service().cancel();
    const posts = f.calls.filter(c => c.body?.events?.[0]?.type.endsWith(".tool_result")).length;
    await assert.rejects(f.service().respond(answer), { code: ({ tool: "EXECUTION_ACTION", terminal: "EXECUTION_ACTION", missing: "EXECUTION_UNKNOWN", foreign: "AGENTS_PROTOCOL", "wrong-output": "EXECUTION_CONFLICT", stop: "EXECUTION_STOPPED" })[mode] });
    assert.equal(f.calls.filter(c => c.body?.events?.[0]?.type.endsWith(".tool_result")).length, posts);
    assert.equal(Object.values(f.service().state().answers)[0].accepted, false); assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1);
  }
});
test("managed resume API refusal preserves checkout, accepted brief and sources, registry and session before mutation", async t => {
  const observed = [];
  for (const mode of ["key-expired", "project-revoked", "model-revoked"]) {
    const f = fixture(), job = await f.service().submit(input), operator = join(f.root, "operator"), worktree = join(f.root, "missing-checkout");
    f.finish(); f.artifact(job); await f.service().reconcile({ force: true }); await f.service().collect();
    mkdirSync(join(operator, "docs/prds"), { recursive: true });
    const brief = GOOD_PRD.replace("harness: codex", "harness: openai-agents").replace("status: draft", "status: ready").replace("harness: openai-agents", "harness: openai-agents\nsources:\n  - context.md");
    const revised = brief.replace("then a CSV with three rows downloads.", "then a CSV with three rows and headers downloads.");
    assert.notEqual(revised, brief); writeFileSync(join(operator, "docs/prds/task.md"), revised); writeFileSync(join(operator, "context.md"), "revised context\n");
    const state = makeState(f.root), id = "acme/widget/task", mutations = [];
    state.put(id, { ...newEntry({ repo: input.repo, branch: input.branch, harness: "openai-agents", session: job.execution.sessionId,
      worktree, pr: 42, base: "main", state: STATES.needsHuman, nowIso: new Date(f.clock.now()).toISOString() }),
      checkout: operator, prd: "docs/prds/task.md", sources: ["context.md"], execution: f.service().current().execution, last: { run: job.id, exit: 0, cost: null } });
    const keyFile = join(f.root, "fixture-api-key"); writeFileSync(keyFile, "offline-test-key", { mode: 0o600 });
    const ctx = { home: f.root, state, config: { ...CONFIG, harness: { "openai-agents": { ...config, api_key_file: keyFile } } }, ownLogin: "me", clock: f.clock,
      git: { ...fakeGit(), exists: () => { mutations.push("checkout"); return false; }, fromBranch: async () => mutations.push("clone"), mergeBase: async () => mutations.push("merge") },
      gh: fakeGh(), log: silentLog, notify: fakeNotify(), executionFor: f.service, readPrd: () => brief, readSource: () => "previous context\n",
      writePrd: () => mutations.push("brief"), writeSource: () => mutations.push("source") };
    const registry = readFileSync(join(f.root, "state.json"), "utf8"), execution = readFileSync(join(f.root, "execution.json"), "utf8"), agents = readFileSync(join(f.root, "agents.json"), "utf8");
    f.failAt(mode === "project-revoked" ? "/agents/sessions" : `/models/${config.model}`, mode === "key-expired" ? 401 : mode === "project-revoked" ? 403 : 404);
    const calls = f.calls.length, mock = t.mock.method(globalThis, "fetch", f.fetcher);
    try { await assert.rejects(resume(ctx, { handle: id, resnapshot: true }), /AGENTS_(?:AUTH|HTTP)/); } finally { mock.mock.restore(); }
    assert.deepEqual(mutations, []); assert.equal(readFileSync(join(f.root, "state.json"), "utf8"), registry);
    assert.equal(readFileSync(join(f.root, "execution.json"), "utf8"), execution); assert.equal(readFileSync(join(f.root, "agents.json"), "utf8"), agents);
    assert.equal(existsSync(worktree), false); assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1); assert.equal(f.service().current().execution.sessionId, job.execution.sessionId);
    const reads = f.calls.slice(calls); assert.deepEqual(reads.map(c => c.route), mode === "project-revoked" ? [`/models/${config.model}`, "/agents/sessions"] : [`/models/${config.model}`]);
    assert.ok(reads.every(c => c.method === "GET"));
    observed.push({ mode, sessionId: job.execution.sessionId, reads: reads.map(c => ({route:c.route,method:c.method})), mutations, registry_preserved: true, snapshots_preserved: true, paid_calls: 0 });
  }
  const evidence = join(mkdtempSync(join(tmpdir(), "agents-resume-refusal-")), "resume-readiness-evidence.json");
  writeFileSync(evidence, JSON.stringify({ kind: "provider-shaped offline readiness refusal", cases: observed }, null, 2)); t.diagnostic(`resume readiness evidence: ${evidence}`);
});
test("cancellation uses active turn cancellation, fences dispatch and quarantines late artifacts", async () => {
  const f = fixture(), job = await f.service().submit(input); assert.deepEqual(await f.service().cancel(), { confirmed: true }); assert.equal(f.sessions.size, 1); assert.equal(f.calls.some(c => c.method === "DELETE"), false);
  await assert.rejects(f.service().continue({ ...input, operationId: "paid-fix", sessionId: job.execution.sessionId }), { code: "EXECUTION_STOPPED" }); await assert.rejects(f.service().collect(), { code: "EXECUTION_QUARANTINED" }); assert.equal(f.service().current().execution.costUsd, null);
});
test("expired filesystem still permits immutable artifact recovery but refuses continuation", async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); f.setEnvironment("expired"); await f.service().reconcile({ force: true }); assert.equal((await f.service().collect()).files[0].text, changed);
  await assert.rejects(f.service().continue({ ...input, operationId: "expired-fix", sessionId: job.execution.sessionId }), { code: "AGENTS_ENVIRONMENT" });
});
test("failed session opens no endless reconnect loop across restart", async () => {
  const f = fixture(), job = await f.service().submit(input); f.sessions.get(job.execution.sessionId).status = "failed";
  await f.service().reconcile({ force: true }); const before = f.calls.length; await f.service().reconcile({ force: true }); assert.equal(f.calls.length, before); assert.equal(f.service().current().execution.providerState, "status-unknown");
});
for (const status of [401, 429]) test(`HTTP ${status} preserves work and bounded retries with actionable private-safe errors`, async () => {
  const f = fixture(); await f.service().submit(input);
  for (let n = 0; n < 3; n++) { f.fail(status); await f.service().reconcile({ force: true }); }
  const before = f.calls.length; await f.service().reconcile({ force: true }); assert.equal(f.calls.length, before); assert.equal(f.service().current().execution.recoveryAction, "AGENTS_RECOVERY_REQUIRED"); assert.doesNotMatch(readFileSync(join(f.root, "execution.json"), "utf8"), /private provider error/);
});
test("deterministic artifact rejection survives coordinator restart and permits same-session correction", async t => {
  const mutations = {
    json: f => f.setArtifactBytes("{ malformed JSON"), nullManifest: f => f.setArtifactBytes("null"),
    wrongHead: f => { f.getResult().inputHead = "b".repeat(40); },
    unsafePath: f => { f.getResult().files[0].path = "../private-rejection-payload"; },
    privatePath: f => { f.getResult().files[0].path = ".env"; },
    beforeHash: f => { f.getResult().files[0].beforeHash = "foreign"; },
    afterHash: f => { f.getResult().files[0].afterHash = "truncated"; },
    nullFile: f => { f.getResult().files[0] = null; }, nullTest: f => { f.getResult().tests[0] = null; },
    alias: f => { f.getResult().files.push({ ...f.getResult().files[0] }); },
  }, observations = [];
  for (const [kind, mutate] of Object.entries(mutations)) {
    const f = fixture(), taskId = "acme/widget/task", job = await f.service().submit(input);
    const keyFile = join(f.root, "fixture-api-key"); writeFileSync(keyFile, "offline-test-key", { mode: 0o600 });
    f.finish(); f.artifact(job); mutate(f); f.syncArtifactSize();
    const state = makeState(f.root), notify = fakeNotify(), gh = fakeGh({ pr: { state: "OPEN" } });
    const worktree = join(f.root, "checkout"); mkdirSync(worktree); writeFileSync(join(worktree, "answer.txt"), initial);
    state.put(taskId, { ...newEntry({ harness: "openai-agents", repo: input.repo, branch: input.branch, worktree,
      state: STATES.prOpen, nowIso: new Date(f.clock.now()).toISOString() }), base: "main", pr: 42,
      session: job.execution.sessionId, execution: job.execution, last: { run: job.id, exit: null } });
    const ctx = { home: f.root, state, config: { ...CONFIG, harness: { ...CONFIG.harness, "openai-agents": { ...config, api_key_file: keyFile } } },
      clock: f.clock, git: { ...fakeGit(), head: async () => head }, gh, ownLogin: "me", log: silentLog, notify,
      credential: fakeCredential(), identity: fakeIdentity(), executionFor: f.service, readPrd: () => null,
      executionInputFor: async (_id, _entry, round) => ({ ...input, ...round }) };
    await makeTick(ctx).tickEntry(taskId, state.get(taskId));
    const stopped = state.get(taskId), dir = f.service().dirOf(job.id), checkpoint = readJson(join(dir, "result-application.json"));
    assert.equal(stopped.state, STATES.needsHuman, kind); assert.equal(stopped.reason, "result-verification");
    assert.equal(stopped.pr, 42); assert.equal(stopped.last.exit, 0); assert.equal(stopped.last.cost, null);
    assert.equal(stopped.execution.providerState, "succeeded"); assert.equal(f.service().current().running, false);
    assert.equal(stopped.session, job.execution.sessionId); assert.equal(f.service().outcome(job.id).ok, false);
    assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "result-collection-validation");
    assert.equal(existsSync(join(dir, "result.json")), false); assert.equal(existsSync(join(dir, "verification.json")), false);
    const rejection = Object.values(readJson(join(f.root, "agents.json")).operations)[0].collectionRejection;
    const cache = join(f.root, rejection.cache), cached = readJson(cache), bytes = Buffer.from(cached.contentBase64, "base64");
    assert.equal(cached.artifact.hash, contentHash(bytes)); assert.equal(cached.turnId, job.execution.turnId);
    assert.equal(statSync(cache).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify({ checkpoint, stopped }), /private-rejection-payload|malformed JSON/);
    f.setEnvironment("expired");
    await assert.rejects(f.transport().deleteSession({ providerJobId: job.execution.providerJobId,
      sessionId: job.execution.sessionId, turnId: job.execution.turnId }), { code: "EXECUTION_CONTROL" });
    const before = f.calls.length, restarted = { ...ctx, state: makeState(f.root) };
    for (let poll = 0; poll < 3; poll++) await makeTick(restarted).tickEntry(taskId, restarted.state.get(taskId));
    await f.service().reconcile({ force: true }); await assert.rejects(f.service().collect(), { code: "EXECUTION_RESULT_BLOCKED" });
    assert.equal(f.calls.length, before); assert.deepEqual(readJson(join(dir, "result-application.json")), checkpoint);
    assert.equal(contentHash(Buffer.from(readJson(cache).contentBase64, "base64")), cached.artifact.hash);
    assert.equal(readFileSync(join(worktree, "answer.txt"), "utf8"), initial); assert.equal(notify.sent.filter(x => x[0] === "needs").length, 1);
    assert.throws(() => requestControl(restarted, { handle: taskId, action: "recheck" }), { code: "EXECUTION_RESULT_BLOCKED" });
    f.setEnvironment("connected");
    const probe = t.mock.method(globalThis, "fetch", f.fetcher);
    try { requestControl(restarted, { handle: taskId, action: "resume" }); await makeTick(restarted).tickEntry(taskId, restarted.state.get(taskId)); }
    finally { probe.mock.restore(); }
    const correction = f.service().current();
    assert.equal(restarted.state.get(taskId).control.status, "applied"); assert.equal(restarted.state.get(taskId).pr, 42);
    assert.equal(correction.execution.sessionId, job.execution.sessionId); assert.notEqual(correction.execution.turnId, job.execution.turnId);
    assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 2); assert.deepEqual(readJson(join(dir, "result-application.json")), checkpoint);
    f.finish(); f.artifact(correction); await f.service().reconcile({ force: true }); assert.equal((await f.service().collect()).files[0].text, changed);
    observations.push({ kind, checkpoint: join(dir, "result-application.json"), cache, registry: join(f.root, "state.json"),
      initialRun: job.id, correctiveRun: correction.id, session: job.execution.sessionId, pr: 42, collections: 2,
      rejectedDownloads: 1, notifications: 1, state: stopped.state, reason: stopped.reason, exit: stopped.last.exit, cost: stopped.last.cost });
  }
  const report = join(mkdtempSync(join(tmpdir(), "agents-rejection-evidence-")), "collection-rejection.json");
  writeFileSync(report, JSON.stringify({ kind: "Provider-shaped offline lifecycle fixtures", observations }, null, 2));
  t.diagnostic(`collection rejection evidence: ${report}`);
});
test("completed root with missing artifact delivery remains pending until the immutable result arrives", async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); await f.service().reconcile({ force: true });
  await assert.rejects(f.service().collect(), { code: "EXECUTION_RESULT" });
  assert.equal(f.service().current().running, true);
  assert.equal(existsSync(join(f.service().dirOf(job.id), "result-application.json")), false);
  f.artifact(job); assert.equal((await f.service().collect()).files[0].text, changed);
  assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1);
});
test("artifact rejection fences downloads before a coordinator checkpoint can be saved", async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); f.setArtifactBytes("{ broken"); f.syncArtifactSize();
  await f.service().reconcile({ force: true });
  const req = { providerJobId: job.execution.providerJobId, sessionId: job.execution.sessionId, turnId: job.execution.turnId };
  await assert.rejects(f.transport().collect(req), { code: "EXECUTION_RESULT", collectionValidation: true });
  const before = f.calls.length;
  await assert.rejects(f.service().collect(), { code: "EXECUTION_RESULT", collectionValidation: true });
  assert.equal(f.calls.length, before); assert.equal(f.service().current().running, false);
});
for (const failure of [401, 429, "lost"]) test(`artifact download ${failure} stays retryable without a rejection checkpoint`, async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); await f.service().reconcile({ force: true });
  const route = `/agents/sessions/${job.execution.sessionId}/artifacts/artifact-1/content`;
  if (failure === "lost") f.lose(route); else f.failAt(route, failure);
  await assert.rejects(f.service().collect());
  assert.equal(f.service().current().running, true); assert.equal(f.service().current().execution.providerState, "retrieving-results");
  assert.equal(existsSync(join(f.service().dirOf(job.id), "result-application.json")), false);
  assert.equal(Object.values(readJson(join(f.root, "agents.json")).operations)[0].collectionRejection, undefined);
  assert.equal((await f.service().collect()).files[0].text, changed);
  assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1);
});
test("account/project isolation refuses foreign session metadata and persisted state", async () => {
  const f = fixture(), job = await f.service().submit(input); f.sessions.get(job.execution.sessionId).metadata.account = "foreign"; await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.recoveryAction, "EXECUTION_OWNERSHIP");
  const state = readJson(join(f.root, "agents.json")); state.project = "another"; writeFileSync(join(f.root, "agents.json"), JSON.stringify(state)); await f.service().reconcile({ force: true }); assert.equal(f.service().current().execution.recoveryAction, "EXECUTION_OWNERSHIP");
});
test("source snapshot preserves binary blobs, exact revision and verified carried files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-source-"));
  const git = args => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git(["init", "-q", "-b", "work/source"]); writeFileSync(join(dir, "answer.txt"), initial); writeFileSync(join(dir, "binary.dat"), Buffer.from([0, 128, 255])); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Input"]);
  writeFileSync(join(dir, "brief.md"), "Approved carried requirements\n"); const revision = git(["rev-parse", "HEAD"]).trim();
  const source = await prepareAgentsSources({ worktree: dir, inputHead: revision, repo: "acme/widget", branch: "work/source", base: "main", overlays: [{ path: "brief.md", text: "Approved carried requirements\n" }] });
  const decoded = JSON.parse(gunzipSync(source.bytes)); assert.equal(decoded.inputHead, revision); assert.deepEqual(decoded.deliveryPaths, ["brief.md"]); assert.deepEqual(Buffer.from(decoded.files.find(f => f.path === "binary.dat").data, "base64"), Buffer.from([0, 128, 255])); assert.equal(source.hashes["brief.md"], contentHash("Approved carried requirements\n"));
  await assert.rejects(prepareAgentsSources({ worktree: dir, inputHead: revision, repo: "acme/widget", branch: "work/source", base: "main", overlays: [{ path: "brief.md", text: "tampered" }] }), { code: "AGENTS_SOURCE" });
  rmSync(dir, { recursive: true, force: true });
});
test("hosted snapshots refuse unfinished tracked, staged, deleted, renamed and untracked files without uploading them", async t => {
  const observations = [];
  for (const mode of ["modified", "staged", "deleted", "renamed", "untracked", "symlink", "mode"]) {
    const dir = mkdtempSync(join(tmpdir(), "agents-dirty-"));
    const git = args => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git(["init", "-q", "-b", input.branch]); writeFileSync(join(dir, "answer.txt"), initial);
    git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Input"]);
    const revision = git(["rev-parse", "HEAD"]).trim();
    if (["modified", "staged"].includes(mode)) writeFileSync(join(dir, "answer.txt"), "unfinished-private-value\n");
    if (mode === "staged") git(["add", "answer.txt"]);
    if (mode === "deleted") unlinkSync(join(dir, "answer.txt"));
    if (mode === "renamed") git(["mv", "answer.txt", "renamed.txt"]);
    if (mode === "untracked") writeFileSync(join(dir, "pending.txt"), "unfinished-private-value\n");
    if (mode === "symlink") symlinkSync("answer.txt", join(dir, "pending-link"));
    if (mode === "mode") chmodSync(join(dir, "answer.txt"), 0o755);
    const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), index = readFileSync(join(dir, ".git/index"));
    await assert.rejects(prepareAgentsSources({ worktree: dir, inputHead: revision, repo: input.repo, branch: input.branch, base: "main" }), error => {
      assert.equal(error.code, "AGENTS_DIRTY_SOURCE"); assert.doesNotMatch(error.message, /unfinished-private-value|pending\.txt/); return true;
    });
    assert.equal(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), status); assert.deepEqual(readFileSync(join(dir, ".git/index")), index);
    assert.equal(git(["rev-parse", "HEAD"]).trim(), revision);
    observations.push({ mode, head: revision, checkoutPreserved: true, snapshotProduced: false, provider_calls: 0 });
    rmSync(dir, { recursive: true, force: true });
  }
  const path = join(mkdtempSync(join(tmpdir(), "agents-dirty-evidence-")), "dirty-source-evidence.json");
  writeFileSync(path, JSON.stringify({ kind: "native Git source refusal with no provider calls", observations }, null, 2)); t.diagnostic(`dirty source evidence: ${path}`);
});
test("managed dirty resume refuses before merge, reopen, registry mutation or corrective dispatch", async t => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); await f.service().reconcile({ force: true }); await f.service().collect();
  const worktree = join(f.root, "checkout"), state = makeState(f.root), taskId = "acme/widget/task"; mkdirSync(worktree);
  const git = args => execFileSync("git", args, { cwd: worktree, encoding: "utf8" });
  git(["init", "-q", "-b", input.branch]); writeFileSync(join(worktree, "answer.txt"), initial); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "Input"]);
  writeFileSync(join(worktree, "pending.txt"), "unfinished\n");
  state.put(taskId, { ...newEntry({ harness: "openai-agents", repo: input.repo, branch: input.branch, worktree, pr: 42,
    session: job.execution.sessionId, state: STATES.needsHuman, nowIso: new Date(f.clock.now()).toISOString() }),
    base: "main", execution: f.service().current().execution, last: { run: job.id, exit: 0 } });
  const keyFile = join(f.root, "fixture-api-key"); writeFileSync(keyFile, "offline-test-key", { mode: 0o600 });
  const mutations = [], realGit = makeGit({ config: CONFIG });
  const ctx = { home: f.root, state, config: { ...CONFIG, harness: { "openai-agents": { ...config, api_key_file: keyFile } } },
    clock: f.clock, ownLogin: "me", git: { ...fakeGit(), exists: () => true, dirty: realGit.dirty, mergeBase: async () => mutations.push("merge") },
    gh: { ...fakeGh(), reopenPr: async () => mutations.push("reopen") }, log: silentLog, notify: fakeNotify(), executionFor: f.service, readPrd: () => null };
  const registry = readFileSync(join(f.root, "state.json")), execution = readFileSync(join(f.root, "execution.json")), adapter = readFileSync(join(f.root, "agents.json"));
  const before = f.calls.length, mock = t.mock.method(globalThis, "fetch", f.fetcher);
  try { await assert.rejects(resume(ctx, { handle: taskId }), { code: "AGENTS_DIRTY_SOURCE" }); } finally { mock.mock.restore(); }
  assert.deepEqual(mutations, []); assert.deepEqual(readFileSync(join(f.root, "state.json")), registry);
  assert.deepEqual(readFileSync(join(f.root, "execution.json")), execution); assert.deepEqual(readFileSync(join(f.root, "agents.json")), adapter);
  assert.equal(readFileSync(join(worktree, "pending.txt"), "utf8"), "unfinished\n");
  assert.ok(f.calls.slice(before).every(c => c.method === "GET")); assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1);
});
test("sandbox publisher delivers unchanged carried files, receipt repairs and rejects symlinks and mode changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agents-output-")); mkdirSync(join(dir, "workspace"));
  const helper = AGENTS_WORKSPACE_HELPER.replaceAll("/workspace", join(dir, "workspace")); writeFileSync(join(dir, "helper.py"), helper);
  const source = { version: 1, inputHead: head, repo: input.repo, branch: input.branch, base: "main", deliveryPaths: ["brief.md"], files: ["answer.txt", "brief.md", ".gitignore"].map(path => { const text = path === ".gitignore" ? "node_modules/\n" : initial; return { path, data: Buffer.from(text).toString("base64"), hash: contentHash(text), mode: 0o644 }; }) };
  const bytes = gzipSync(Buffer.from(JSON.stringify(source))); const path = join(dir, "source.gz"); writeFileSync(path, bytes);
  execFileSync("python3", [join(dir, "helper.py"), "restore", path, contentHash(bytes)], { stdio: "pipe" });
  mkdirSync(join(dir, "workspace/repo/node_modules")); writeFileSync(join(dir, "workspace/repo/node_modules/cache"), Buffer.alloc(1_000_001, 65));
  writeFileSync(join(dir, "workspace/repo/answer.txt"), changed); writeFileSync(join(dir, "pr.json"), JSON.stringify({ title: "Answer", body: "Evidence" })); writeFileSync(join(dir, "tests.json"), JSON.stringify([{ command: "test", exit: 0, inputHead: head }]));
  execFileSync("python3", [join(dir, "helper.py"), "publish", join(dir, "pr.json"), join(dir, "tests.json")]);
  const output = readJson(join(dir, "workspace/outputs/result.json")); assert.equal(output.files[0].text, changed); assert.equal(output.files[0].afterHash, contentHash(changed)); assert.equal(output.files[0].beforeHash, contentHash(initial));
  assert.equal(output.files[1].path, "brief.md"); assert.equal(output.files[1].beforeHash, output.files[1].afterHash);
  const coordinator = join(dir, "coordinator"); mkdirSync(coordinator);
  const git = args => execFileSync("git", args, { cwd: coordinator, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", input.branch]); writeFileSync(join(coordinator, "answer.txt"), initial); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Input"]);
  for (const f of output.files) writeFileSync(join(coordinator, f.path), f.text);
  const publicationGit = makeGit({ config: CONFIG, credential: fakeCredential(), identity: fakeIdentity() });
  await publicationGit.commitResult(coordinator, output.files.map(f => f.path)); assert.equal(git(["status", "--porcelain"]), ""); assert.equal(git(["show", "HEAD:brief.md"]), initial.trim());
  const committedHead = git(["rev-parse", "HEAD"]);
  const publish = () => execFileSync("python3", [join(dir, "helper.py"), "publish", join(dir, "pr.json"), join(dir, "tests.json")], { stdio: "pipe" });
  writeFileSync(join(dir, "workspace/repo/answer.txt"), initial); chmodSync(join(dir, "workspace/repo/answer.txt"), 0o755); assert.throws(publish, /unsupported output mode/); chmodSync(join(dir, "workspace/repo/answer.txt"), 0o644);
  symlinkSync("answer.txt", join(dir, "workspace/repo/link.txt")); assert.throws(publish, /output symlink/); unlinkSync(join(dir, "workspace/repo/link.txt"));
  writeFileSync(join(dir, "workspace/repo/large.txt"), Buffer.alloc(1_000_001, 65)); assert.throws(publish, /unsupported output mode\/size/);
  unlinkSync(join(dir, "workspace/repo/large.txt")); publish(); const receiptOnly = readJson(join(dir, "workspace/outputs/result.json")); assert.deepEqual(receiptOnly.files.map(f => f.path), ["brief.md"]);
  await publicationGit.commitResult(coordinator, receiptOnly.files.map(f => f.path)); assert.equal(git(["rev-parse", "HEAD"]), committedHead);
  rmSync(dir, { recursive: true, force: true });
});

test("managed artifacts reach the single PR writer with actual file and current-head verification", async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); await f.service().reconcile({ force: true }); const result = await f.service().collect();
  const worktree = mkdtempSync(join(tmpdir(), "agents-publish-")); writeFileSync(join(worktree, "answer.txt"), initial);
  const calls = [], entry = { repo: input.repo, branch: input.branch, base: "main", harness: "openai-agents", session: job.execution.sessionId, worktree, prd: "docs/prds/task.md", execution: f.service().current().execution };
  const ctx = { git: { head: async () => head, trackedPaths: async () => ["answer.txt"], resultModesMatch: async () => true, dirty: async () => ({ modified: 0, untracked: 0 }), currentBranch: async () => input.branch, originOf: async () => "https://github.com/acme/widget.git", commitResult: async () => calls.push("commit"), pushResult: async () => calls.push("push") }, gh: { publishResultPr: async () => { calls.push("PR"); return { number: 42, url: "https://example.test/pr/42" }; } }, executionFor: f.service, readPrd: () => "# Approved brief\n\n## Verify\n\n- `printf verified`\n" };
  const published = await reconcileExecutionResult(ctx, { id: "acme/widget/task", entry, result, dir: f.service().dirOf(job.id), verify: async () => { assert.equal(readFileSync(join(worktree, "answer.txt"), "utf8"), changed); calls.push("verify"); return { stdout: "verified", stderr: "" }; } });
  assert.deepEqual(calls, ["commit", "verify", "push", "PR"]); assert.equal(published.pr.number, 42); assert.equal(published.evidence[0].source, "coordinator-executed"); assert.equal(published.evidence[0].head, head);
  await reconcileExecutionResult(ctx, { id: "acme/widget/task", entry, result, dir: f.service().dirOf(job.id) }); assert.equal(calls.length, 4);
});

test("initial launch reply loss remains registered for coordinator restart without a second implementation", async () => {
  const f = fixture(), originalFetch = globalThis.fetch, originalKey = process.env.OPENAI_API_KEY;
  const operator = join(f.root, "operator"), worktree = join(f.root, "worktrees/acme/widget/task");
  mkdirSync(join(operator, "docs/prds"), { recursive: true }); mkdirSync(worktree, { recursive: true });
  const brief = GOOD_PRD.replace("harness: codex", "harness: openai-agents"), prdPath = join(operator, "docs/prds/task.md"); writeFileSync(prdPath, brief);
  const git = args => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }); git(["init", "-q", "-b", "work/task"]); writeFileSync(join(worktree, "answer.txt"), initial); git(["add", "."]); git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Input"]);
  const snapshots = new Map(), state = makeState(f.root);
  const ctx = { home: f.root, ownLogin: "me", config: { ...CONFIG, home: f.root, worktrees: join(f.root, "worktrees"), harness: { "openai-agents": config } }, state, log: silentLog, notify: fakeNotify(), identity: fakeIdentity(), credential: fakeCredential(), clock: f.clock,
    git: { toplevel: async () => operator, create: async () => worktree, head: async () => git(["rev-parse", "HEAD"]).trim(), exists: () => true },
    gh: { repoInfo: async () => ({ nameWithOwner: "acme/widget", defaultBranch: "main" }), branchExists: async () => true, ensureLabels: async () => {}, ownPrByHead: async () => null },
    executionFor: f.service, writePrd: (key, value) => snapshots.set(key, value), readPrd: key => snapshots.get(key) };
  globalThis.fetch = f.fetcher; process.env.OPENAI_API_KEY = "offline-test-key";
  try {
    f.lose("/agents/sessions/sess-1/events"); await assert.rejects(start(ctx, { path: prdPath }), /lost reply/);
    const pending = makeState(f.root).get("acme/widget/task"); assert.ok(pending); assert.equal(pending.reason, "dispatch-intent"); assert.equal(pending.execution.acceptance, "unknown"); assert.ok(pending.last.run);
    // A process crash can occur before the launcher copies the job into registry
    // state. The pre-I/O operation marker must still prove exact ownership.
    state.update("acme/widget/task", { execution: { version: 1, operationId: pending.execution.operationId }, last: { ...pending.last, run: null } });
    await makeTick({ ...ctx, state: makeState(f.root) }).tickEntry("acme/widget/task", state.get("acme/widget/task"));
    assert.equal(f.service().current().execution.acceptance, "accepted"); assert.equal(makeState(f.root).get("acme/widget/task").session, "sess-1");
    assert.equal(makeState(f.root).get("acme/widget/task").state, "running"); assert.equal(makeState(f.root).get("acme/widget/task").last.run, f.service().current().id);
    await assert.rejects(start(ctx, { path: prdPath }), /already exists/); assert.equal(f.sessions.size, 1); assert.equal(f.turns.size, 1);
  } finally { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; }
});
test("phase-bounded coordinator settlement cannot enter review dispatch or queued resume", async () => {
  const f = fixture(), state = makeState(f.root), taskId = "acme/widget/task";
  state.put(taskId, { ...newEntry({ prd: "brief.md", harness: "openai-agents", session: "sess-1", repo: input.repo, branch: input.branch, worktree: f.root, state: "pr-open", nowIso: new Date(f.clock.now()).toISOString() }), pr: 42 });
  await makeTick({ config: CONFIG, state, executionFor: f.service, ownLogin: "me", log: silentLog, notify: fakeNotify(), clock: f.clock,
    gh: { prView: async () => { assert.fail("a new review phase was entered"); } }, git: {}, readPrd: () => null }).tickEntry(taskId, state.get(taskId), { settleOnly: true });
  assert.equal(f.calls.length, 0); assert.equal(f.service().current(), null);
});
