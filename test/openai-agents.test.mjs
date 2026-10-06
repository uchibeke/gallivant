import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, symlinkSync, unlinkSync } from "node:fs";
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
import { makeState, newEntry } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeGit } from "../lib/git.mjs";
import { CONFIG, GOOD_PRD, fakeCredential, fakeIdentity, fakeNotify, silentLog } from "./helpers.mjs";
import { reconcileExecutionResult } from "../lib/execution_result.mjs";
import { readJson } from "../lib/fs.mjs";
const config = { account: "fixture", organization: "org-fixture", project: "proj-fixture", model: "fixture-model", environment: "openai_hosted", container_size: "small", network: { access: "disabled" }, allowance: { remainingUsd: 2, reservedUsd: 0.1 } };
const head = "a".repeat(40), initial = "original\n", changed = "corrected\n";
const sources = { data: Buffer.from("snapshot").toString("base64"), hash: contentHash("snapshot"), hashes: { "answer.txt": contentHash(initial) }, modes: { "answer.txt": 0o644 }, inputHead: head, repo: "acme/widget", branch: "work/widget" };
const input = { operationId: "implementation", prompt: "Implement the approved brief", inputHead: head, repo: sources.repo, branch: sources.branch, base: "main", model: config.model, environment: config.environment, allowance: config.allowance, sources };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agents-offline-")), calls = [], sessions = new Map(), turns = new Map();
  const clock = { now: () => 1_800_000_000_000 };
  let serial = 0, lost = null, events = [], items = [], artifactPages = [], result = null, failure = null;
  const page = data => ({ data, has_more: false, last_id: data.at(-1)?.id ?? null });
  const fetcher = async (url, options) => {
    const route = new URL(url).pathname.replace("/v1", ""), search = new URL(url).searchParams;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ route, method: options.method, body, key: options.headers["Idempotency-Key"] });
    assert.equal(options.headers["OpenAI-Beta"], "agents=v1"); assert.equal(options.headers["OpenAI-Project"], config.project);
    if (failure) { const status = failure; failure = null; return new Response("private provider error secret", { status, headers: { "retry-after": "2" } }); }
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
        else if (event.type.endsWith(".tool_result")) session.required_actions = [];
        value = null;
      } else if (route.endsWith("/turns")) value = page([...turns.values()].filter(t => t.session_id === sessionId));
      else if (route.includes("/turns/")) value = turns.get(route.split("/").at(-1));
      else if (route.endsWith("/items")) value = items.length ? { data: [items[search.get("after") ? 1 : 0]], has_more: !search.get("after") && items.length > 1, last_id: search.get("after") ? items[1].id : items[0].id } : page([]);
      else if (route.endsWith("/artifacts")) value = artifactPages[search.get("after") ? 1 : 0] || page([]);
      else if (route.endsWith("/content")) return new Response(JSON.stringify(result));
      else if (options.method === "DELETE") { sessions.delete(sessionId); value = null; }
      else value = session;
    }
    if (lost === route) { lost = null; throw new Error("lost reply"); }
    return new Response(value === null ? null : JSON.stringify(value), { status: value === null ? 202 : 200 });
  };
  let fixtureEnvironment = "connected";
  const http = agentsHttp({ credential: () => "offline-test-key", organization: config.organization, project: config.project, fetcher });
  const transport = () => makeAgentsTransport({ root, taskId: "acme/widget/task", account: config.account, config, http, clock });
  const service = () => makeExecution({ root, taskId: "acme/widget/task", account: config.account, provider: "openai-agents", transport: transport(), capabilities: { ...capabilitiesFor("openai-agents"), models: [config.model] }, clock, jitter: () => 0 });
  const finish = (status = "completed") => { const turn = [...turns.values()].at(-1); turn.status = status; turn.completed_at = clock.now() / 1000; sessions.get(turn.session_id).status = "idle"; return turn; };
  const artifact = job => {
    result = { version: 1, inputHead: head, repo: input.repo, branch: input.branch, files: [{ path: "answer.txt", beforeHash: contentHash(initial), afterHash: contentHash(changed), text: changed }], pr: { title: "Implement answer", body: "Actual result" }, tests: [{ command: "node --test", exit: 0, inputHead: head, output: "passed" }] };
    artifactPages = [{ data: [{ id: "unrelated", turn_id: "other", path: "/workspace/outputs/old.json" }], has_more: true, last_id: "unrelated" }, { data: [{ id: "artifact-1", session_id: job.execution.sessionId, environment_id: job.execution.environment, turn_id: job.execution.turnId, path: "/workspace/outputs/result.json", size_bytes: Buffer.byteLength(JSON.stringify(result)) }], has_more: false }];
  };
  return { root, clock, calls, sessions, turns, http, fetcher, transport, service, finish, artifact, syncArtifactSize: () => { artifactPages[1].data[0].size_bytes = Buffer.byteLength(JSON.stringify(result)); }, setEvents: v => { events = v; }, setItems: v => { items = v; }, setEnvironment: v => { fixtureEnvironment = v; }, fail: v => { failure = v; }, lose: v => { lost = v; }, getResult: () => result };
}
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
for (const mutation of [r => { r.inputHead = "b".repeat(40); }, r => { r.files[0].path = "../escape"; }, r => { r.files[0].path = ".env"; }, r => { r.files[0].beforeHash = "foreign"; }, r => { r.files[0].afterHash = "truncated"; }]) test("artifact rejects unsafe paths, private paths, wrong source and hashes", async () => {
  const f = fixture(), job = await f.service().submit(input); f.finish(); f.artifact(job); mutation(f.getResult()); f.syncArtifactSize(); await f.service().reconcile({ force: true }); await assert.rejects(f.service().collect()); assert.equal(f.service().current().running, true);
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
