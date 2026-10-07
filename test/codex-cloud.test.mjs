import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { execFileAsync } from "../lib/gh.mjs";
import { makeCloudTransport, checkCloudAccess, cloudCli } from "../lib/codex_cloud.mjs";
import { validateCloudConfig } from "../lib/codex_cloud_config.mjs";
import { CLOUD_RESULT_PATH, cloudDiffResult } from "../lib/codex_cloud_result.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { capabilitiesFor } from "../lib/harness.mjs";
import { cloudInput } from "../lib/codex_cloud_input.mjs";
import { makeGit, runEnv } from "../lib/git.mjs";
import { reconcileExecutionResult } from "../lib/execution_result.mjs";
import { makeTick } from "../lib/tick.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { receiptHash } from "../lib/deliverable.mjs";
import { publicReviewHash } from "../lib/public_output.mjs";
import { CONFIG, T0, fakeGh, fakeNotify, silentLog, prFixture, tempHome } from "./helpers.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { contentHash } from "../lib/openai_agents_sources.mjs";
import { cloudLedgerBlockers, cloudRequestBlockers, cloudCorrectionMatches } from "./codex-cloud-live-validation.mjs";
import { checkHarness } from "../lib/probe.mjs";
import { HARNESSES, validate } from "../lib/config.mjs";
import { renderBlock, parseBlock } from "../lib/block.mjs";
const config = { bin: "/fixture/codex", account: "operator", authentication: "operator-chatgpt", mode: "trusted-worker", environment: "env-fixture", repository: "acme/widget", continuation: "successor-task", billing_source: "chatgpt-account", allowance: { remainingUsd: 1, reservedUsd: .1 } };
const head = "a".repeat(40), repo = config.repository, branch = "work/widget";
const bytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, inputHead: head, repo, branch, files: [{ path: "answer.txt", data: Buffer.from("old\n").toString("base64"), hash: contentHash("old\n"), mode: 0o644 }] })));
// Dependency injection is confined to offline fixtures. The production context
// never overrides the native access check or the unavailable capability.
async function offlineCloudAccess(selected, options) {
  const access = await checkCloudAccess(selected, options);
  return access.detail === "CLOUD_ENVIRONMENT_REPOSITORY"
    ? { ...access, ok: true, detail: "offline environment mapping fixture; no live qualification", effective: { ...access.effective, repository: selected.repository } }
    : access;
}
const input = { operationId: "implementation", inputHead: head, repo, branch, base: "main", environment: config.environment, allowance: config.allowance, prompt: "Implement the approved requirements", sources: { data: bytes.toString("base64"), hash: contentHash(bytes), inputHead: head, inputBranch: `${branch}-cloud-${head}`, repo, branch, hashes: {} } };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cloud-offline-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [], tasks = new Map(); let now = Date.now(), lost = false, paging = false, pages = 0, auth = "Logged in using ChatGPT", version = "codex-cli 0.160.0", diff = "";
  const cli = async args => {
    calls.push(args);
    if (args[0] === "--version") return version;
    if (args[0] === "login") return auth;
    if (args.includes("--help")) return "--env --branch --attempts --json --cursor --limit --attempt";
    if (args[1] === "exec") {
      const id = `task_fixture${tasks.size + 1}`;
      // The pinned CLI's list-item mapper emits null, even for --env listings.
      tasks.set(id, { id, url: `https://chatgpt.com/codex/tasks/${id}`, status: "pending", environment_id: null, attempt_total: null, summary: { files_changed: 1, lines_added: 1, lines_removed: 1 }, updated_at: new Date(now).toISOString() });
      if (lost) throw new Error("lost submission reply"); return tasks.get(id).url;
    }
    if (args[1] === "list") {
      assert.equal(args[args.indexOf("--env") + 1], config.environment);
      pages++;
      if (paging && !args.includes("--cursor")) return JSON.stringify({ tasks: [{ id: "task_unrelated" }], cursor: "second" });
      return JSON.stringify({ tasks: [...tasks.values()], cursor: null });
    }
    if (args[1] === "diff") return diff;
    throw new Error("unsupported fixture command");
  };
  const clock = { now: () => now }, capabilities = { ...capabilitiesFor("codex-cloud"), available: true, environments: [config.environment] };
  const transport = () => makeCloudTransport({ root, taskId: "acme/widget/task", account: "operator", config, cli, clock, checkAccess: offlineCloudAccess, verification: async () => {}, verifyRemote: async () => {} });
  const service = () => makeExecution({ root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", capabilities, transport: transport(), clock });
  return { root, tasks, calls, cli, clock, transport, service, advance: () => { now += 1000; }, finish: () => { [...tasks.values()].at(-1).status = "ready"; }, lost: () => { lost = true; }, paging: () => { paging = true; }, pages: () => pages, auth: value => { auth = value; }, version: value => { version = value; }, diff: value => { diff = value; } };
}
function patch(op, overrides = {}, envelopeOnly = false) {
  const receipt = { version: 1, inputHead: op.inputHead, repo, branch, runId: op.runId, sourceHashes: {}, pr: { title: "Implement answer", body: "Observed file and test result" }, tests: [], ...overrides };
  const diff = `diff --git a/answer.txt b/answer.txt\nindex 3367afd..3e75765 100644\n--- a/answer.txt\n+++ b/answer.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/${CLOUD_RESULT_PATH} b/${CLOUD_RESULT_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${CLOUD_RESULT_PATH}\n@@ -0,0 +1 @@\n+${JSON.stringify(receipt)}\n`;
  return envelopeOnly ? diff.slice(diff.indexOf(`diff --git a/${CLOUD_RESULT_PATH}`)) : diff;
}
function delayedSubmission(t, delayMs) {
  const f = fixture(t), subprocesses = []; let entered;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const cli = cloudCli(config, async (bin, args, options) => {
    assert.equal(bin, config.bin);
    subprocesses.push({ command: args.slice(0, 2), timeout: options.timeout, signal: options.signal });
    const stdout = await f.cli(args);
    if (args[1] !== "exec" || args.includes("--help")) return { stdout };
    // Offline execFile fixture: remote acceptance precedes the URL, and either
    // subprocess timeout or the shared abort signal ends only the local client.
    return new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(reply); clearTimeout(timeout); options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve({ stdout });
      };
      const abort = () => done(Object.assign(new Error("submission client aborted"), { code: "ABORT_ERR" }));
      const reply = setTimeout(() => done(), delayMs);
      const timeout = options.timeout > 0 ? setTimeout(() => done(Object.assign(new Error("submission client timed out"), { code: "CHILD_TIMEOUT" })), options.timeout) : null;
      options.signal?.addEventListener("abort", abort, { once: true }); entered();
    });
  });
  const transport = () => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli, clock: f.clock, checkAccess: offlineCloudAccess, verification: async () => {}, verifyRemote: async () => {} });
  const service = () => makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", capabilities: { ...capabilitiesFor("codex-cloud"), available: true, environments: [config.environment] }, transport: transport(), clock: f.clock, limits: { deadlineMs: 20_000 } });
  const start = operation => {
    const started = new Promise(resolve => { entered = resolve; });
    const pending = operation(); pending.catch(() => {});
    return { entered: started, pending };
  };
  return { ...f, service, subprocesses, start };
}
test("Cloud capabilities preserve defaults and refuse unsupported delegation, policy, models and attempts", () => {
  assert.equal(capabilitiesFor("codex-cloud").continuation, "successor-task");
  assert.equal(capabilitiesFor("codex").transport, "cli"); assert.equal(capabilitiesFor("openai-agents").continuation, "native-session");
  for (const change of [{ account: "someone-else" }, { mode: "public" }, { authentication: "cookies" }, { model: "override" }, { attempts: 2 }, { mandatory_policy: ["workspace-write"] }, { context_paths: ["/private"] }, { allowance: { remainingUsd: 0, reservedUsd: 0 } }]) assert.throws(() => validateCloudConfig({ ...config, ...change }));
});
test("Cloud access diagnostics refuse dispatch without an environment repository mapping", async t => {
  const f = fixture(t);
  const access = await checkCloudAccess(config, { cli: f.cli });
  assert.equal(access.ok, false); assert.equal(access.detail, "CLOUD_ENVIRONMENT_REPOSITORY");
  assert.equal(access.effective.repository, null); assert.equal(access.effective.environment, config.environment);
  assert.match(access.fix, /supported.*environment.*repository/);
  // Task listing fields and operator configuration are not environment metadata.
  for (const repository of [config.repository, "other/widget"]) {
    const cli = args => args[1] === "list" && !args.includes("--help") ? JSON.stringify({ tasks: [], cursor: null, repository }) : f.cli(args);
    assert.equal((await checkCloudAccess(config, { cli })).detail, "CLOUD_ENVIRONMENT_REPOSITORY");
  }
  assert.equal(f.calls.some(args => args[1] === "exec" && !args.includes("--help")), false);
  const noFilter = args => args[1] === "list" && args.includes("--help") ? "--json --cursor --limit" : f.cli(args);
  assert.equal((await checkCloudAccess(config, { cli: noFilter })).detail, "CLOUD_VERSION");
  f.auth("Logged in using an API key"); assert.equal((await checkCloudAccess(config, { cli: f.cli })).detail, "CLOUD_AUTH");
  f.version("codex-cli 0.161.0"); assert.equal((await checkCloudAccess(config, { cli: f.cli })).detail, "CLOUD_VERSION");
});
test("Cloud unqualified capability and transport refuse initial and successor dispatch before paid intent", async t => {
  const f = fixture(t), selected = capabilitiesFor("codex-cloud"), configured = { harness: { "codex-cloud": config } };
  const readiness = await checkHarness("codex-cloud", configured, { cli: f.cli });
  assert.equal(readiness.ok, false); assert.match(readiness.fix, /supported.*environment.*repository/);
  assert.equal(selected.available, false); assert.equal(f.calls.length, 0);
  let taskRefVerifierCalls = 0;
  const raw = (overrides = {}) => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli: f.cli, clock: f.clock,
    verification: async () => {}, verifyRemote: async () => { taskRefVerifierCalls++; }, ...overrides });
  const normal = () => makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", transport: raw(), clock: f.clock });
  for (const method of ["prepare", "submit", "continue"]) await assert.rejects(normal()[method](input), { code: "EXECUTION_UNAVAILABLE" });
  for (const method of ["submit", "continue"]) await assert.rejects(raw()[method]({ ...input, runId: "run-refused", idempotencyKey: "refused", sessionId: "task_saved" }), error => error.code === "CLOUD_ENVIRONMENT_REPOSITORY" && error.dispatchNotSent === true);
  for (const effective of [null, {}, { repository: "other/widget", environment: config.environment }, { repository: repo, environment: "env-foreign" }]) {
    // A future injected qualifier must bind both identities; success alone is
    // insufficient, and never reaches the coordinator's GitHub ref verifier.
    await assert.rejects(raw({ checkAccess: async () => ({ ok: true, effective }) }).submit({ ...input, runId: "run-refused", idempotencyKey: "refused" }), error => error.code === "CLOUD_ENVIRONMENT_REPOSITORY" && error.dispatchNotSent === true);
  }
  assert.equal(existsSync(join(f.root, "cloud.json")), false); assert.equal(normal().current(), null);
  assert.deepEqual(normal().state().operations, {}); assert.equal(normal().state().allowance, undefined); assert.equal(taskRefVerifierCalls, 0);
  assert.equal(f.tasks.size, 0); assert.equal(f.calls.some(args => args[1] === "exec" && !args.includes("--help")), false);
  t.diagnostic(JSON.stringify({ kind: "offline refusal fixture; no live qualification", readiness, capabilities: { available: selected.available, reason: selected.reason, fix: selected.fix }, cloudIntentSaved: false, paidCommands: 0, taskRefVerifierCalls }));
});
test("Cloud recovery remains read-only when new dispatch is unavailable", async t => {
  const f = fixture(t), job = await f.service().submit(input), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  f.finish(); f.diff(patch(op)); f.advance();
  const raw = makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli: f.cli, clock: f.clock });
  const recovering = makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", transport: raw, clock: f.clock });
  assert.equal(recovering.capabilities.available, false);
  await recovering.reconcile({ force: true });
  assert.equal(recovering.current().execution.providerJobId, job.execution.providerJobId);
  assert.equal((await recovering.collect()).files[0].text, "new\n");
  await assert.rejects(recovering.continue({ ...input, operationId: "review", sessionId: job.execution.sessionId }), { code: "EXECUTION_UNAVAILABLE" });
  assert.equal(f.tasks.size, 1);
  t.diagnostic(JSON.stringify({ kind: "offline owned-task recovery; no live qualification", available: false, taskId: job.execution.providerJobId, state: recovering.current().execution.providerState, collected: recovering.current().execution.collected, providerTasks: f.tasks.size }));
});
test("Cloud recovery checks the pinned CLI before inspection and acknowledgement lookup", async t => {
  const f = fixture(t), job = await f.service().submit(input), saved = readFileSync(join(f.root, "cloud.json"), "utf8");
  const signal = new AbortController().signal, observations = [];
  const cli = (args, receivedSignal) => { assert.equal(receivedSignal, signal); return f.cli(args); };
  const raw = () => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli, clock: f.clock });
  const request = { ...job.execution, signal }, intent = f.service().state().operations[input.operationId];
  for (const version of ["codex-cli 0.161.0", "codex-cli 0.159.0", "codex-cli 0.160.0-extra", "", "unrecognized executable"]) {
    f.version(version);
    for (const [method, req] of [["inspect", request], ["lookup", { intent, signal }]]) {
      const start = f.calls.length;
      await assert.rejects(raw()[method](req), error => error.code === "CLOUD_VERSION" && error.providerObservationError === true);
      assert.deepEqual(f.calls.slice(start), [["--version"]]);
      assert.equal(readFileSync(join(f.root, "cloud.json"), "utf8"), saved);
      observations.push({ method, version, error: "CLOUD_VERSION", listingCalls: 0, ownershipChanged: false });
    }
  }
  // Ownership failures precede all subprocesses, including diagnostics.
  const start = f.calls.length;
  await assert.rejects(raw().inspect({ ...request, providerJobId: "task_foreign" }), { code: "EXECUTION_OWNERSHIP" });
  assert.equal(f.calls.length, start);
  f.version("codex-cli 0.160.0\n"); f.paging();
  assert.equal((await raw().lookup({ intent, signal })).providerJobId, job.execution.providerJobId);
  assert.deepEqual(f.calls.slice(start).map(args => args.slice(0, 2)), [["--version"], ["cloud", "list"], ["cloud", "list"]]);
  assert.equal(f.tasks.size, 1);
  t.diagnostic(JSON.stringify({ kind: "offline CLI replacement fixture; no live qualification", observations, restoredTask: job.execution.providerJobId, providerTasks: f.tasks.size }));
});
test("Cloud recovery version failures preserve owned work across restart and refuse unqualified diffs", async t => {
  const f = fixture(t), job = await f.service().submit(input), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  f.finish(); f.diff(patch(op)); f.advance();
  const raw = () => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli: f.cli, clock: f.clock });
  const recovering = () => makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", transport: raw(), clock: f.clock });
  assert.equal(recovering().capabilities.available, false);
  f.version("codex-cli 0.161.0");
  const start = f.calls.length;
  await recovering().reconcile({ force: true });
  const failed = recovering().current().execution;
  assert.equal(failed.providerState, "status-unknown"); assert.equal(failed.recoveryAction, "CLOUD_VERSION");
  assert.equal(failed.providerJobId, job.execution.providerJobId); assert.equal(failed.acceptance, "accepted");
  assert.ok(failed.nextAttemptAt > f.clock.now()); assert.deepEqual(f.calls.slice(start), [["--version"]]);
  const dir = recovering().dirOf(job.id), events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(events.some(event => event.type === "error" && event.data.code === "CLOUD_VERSION" && event.timestamp === f.clock.now()));
  f.version("codex-cli 0.160.0"); f.advance(); await recovering().reconcile({ force: true });
  assert.equal(recovering().current().execution.providerState, "retrieving-results");
  const providerState = readFileSync(join(f.root, "cloud.json"), "utf8"), terminal = recovering().current().execution;
  const collectionFailures = [];
  for (const version of ["codex-cli 0.161.0", "codex-cli 0.159.0", ""]) {
    f.version(version); const before = f.calls.length;
    await assert.rejects(recovering().collect(), error => error.code === "CLOUD_VERSION" && !error.collectionValidation);
    assert.deepEqual(f.calls.slice(before), [["--version"]]);
    assert.equal(readFileSync(join(f.root, "cloud.json"), "utf8"), providerState);
    assert.deepEqual(recovering().current().execution, terminal);
    for (const file of ["result.json", "verification.json", "result-application.json"]) assert.equal(existsSync(join(dir, file)), false);
    collectionFailures.push({ version, diffCalls: 0, savedResult: false, validationBlocked: false });
  }
  f.version("codex-cli 0.160.0"); const before = f.calls.length;
  const result = await recovering().collect();
  assert.equal(result.providerJobId, job.execution.providerJobId); assert.equal(result.files[0].text, "new\n");
  assert.deepEqual(f.calls.slice(before).map(args => args.slice(0, 2)), [["--version"], ["cloud", "diff"]]);
  const collectedCalls = f.calls.length;
  assert.deepEqual(await recovering().collect(), result); assert.equal(f.calls.length, collectedCalls);
  await assert.rejects(recovering().continue({ ...input, operationId: "review", sessionId: job.execution.sessionId }), { code: "EXECUTION_UNAVAILABLE" });
  assert.equal(f.tasks.size, 1); assert.equal(existsSync(join(f.root, "answer.txt")), false);
  t.diagnostic(JSON.stringify({ kind: "offline coordinator restart; no live qualification", failed, collectionFailures, restoredTask: result.providerJobId, available: false, providerTasks: f.tasks.size, collectionReused: true }));
});
test("Cloud provider recognition preserves configuration and recovery identity while dispatch is unavailable", () => {
  assert.equal(capabilitiesFor("codex-cloud").available, false);
  assert.ok(HARNESSES.includes("codex-cloud"));
  assert.deepEqual(validate({ ...CONFIG, harness: { "codex-cloud": config } }), []);
  const block = { prd: "docs/prds/cloud-task.md", harness: "codex-cloud", session: "task_owned", branch: "work/widget" };
  assert.deepEqual(parseBlock(renderBlock(block)).block, block);
  for (const session of ["../task_owned", "task_/foreign", "task_"]) assert.equal(parseBlock(renderBlock({ ...block, session })).block, null);
  assert.equal(parseBlock(renderBlock({ ...block, harness: "unknown-provider" })).block, null);
});
test("Cloud live preflight accepts repository letter case without relaxing campaign allowance gates", t => {
  const now = Date.parse("2026-10-07T00:00:00Z"), spellings = [repo, "Acme/Widget"], observations = [];
  const ledger = { version: 1, limitUsd: 10, attempts: [{ reservedUsd: 1, observedCostUsd: 1 }], cloud: { account: "operator", environment: config.environment, repo, billingSource: "chatgpt-account", remainingTasks: 2, accountUsageEvidence: "private-account-usage-record", checkedAt: new Date(now).toISOString(), taskSeconds: 120 } };
  const request = { repo, harness: "codex-cloud" };
  for (const configuredRepo of spellings) for (const authorizedRepo of spellings) for (const ledgerRepo of spellings) for (const canonicalRepo of spellings) {
    const selected = { ...config, repository: configuredRepo }, allowance = { ...ledger, cloud: { ...ledger.cloud, repo: ledgerRepo } }, brief = { ...request, repo: canonicalRepo }, before = JSON.stringify({ selected, allowance, brief });
    assert.deepEqual([...cloudLedgerBlockers(selected, allowance, authorizedRepo, now), ...cloudRequestBlockers(selected, brief, authorizedRepo)], []);
    assert.equal(JSON.stringify({ selected, allowance, brief }), before);
    observations.push({ configuredRepo, authorizedRepo, ledgerRepo, canonicalRepo, blockers: [] });
  }
  for (const foreign of ["acme/widget-fork", "other/widget", "widget/acme", null]) {
    assert.ok(cloudLedgerBlockers(config, { ...ledger, cloud: { ...ledger.cloud, repo: foreign } }, repo, now).length);
    assert.ok(cloudRequestBlockers({ ...config, repository: foreign }, request, repo).length);
    assert.ok(cloudRequestBlockers(config, { ...request, repo: foreign }, repo).length);
    assert.ok(cloudRequestBlockers(config, request, foreign).length);
  }
  for (const cloud of [{ account: "someone-else" }, { environment: config.environment.toUpperCase() }, { billingSource: "api" }, { remainingTasks: 0 }, { remainingTasks: 1.5 }, { accountUsageEvidence: null }, { checkedAt: "invalid" }, { checkedAt: new Date(now - 86_400_001).toISOString() }, { taskSeconds: 0 }, { taskSeconds: 121 }]) {
    assert.ok(cloudLedgerBlockers(config, { ...ledger, cloud: { ...ledger.cloud, ...cloud } }, repo, now).length);
  }
  for (const invalid of [{ limitUsd: 11 }, { attempts: [{ reservedUsd: 1, observedCostUsd: null }] }, { attempts: [{ reservedUsd: 11, observedCostUsd: 11 }] }]) assert.ok(cloudLedgerBlockers(config, { ...ledger, ...invalid }, repo, now).length);
  assert.ok(cloudRequestBlockers(config, { ...request, harness: "codex" }, repo).length);
  t.diagnostic(JSON.stringify({ liveRepositoryPreflight: { kind: "offline read-only validation; no live qualification", cases: observations, providerCalls: 0, inputRecordsUnchanged: true } }));
});
test("Cloud live correction accepts repository letter case and preserves session and PR ownership", t => {
  const request = { repo: "Acme/Widget", harness: "codex-cloud" }, campaign = { taskId: "acme/widget/task", sessionId: "task_fixture1", pr: 11 }, entry = { repo, harness: "codex-cloud", session: campaign.sessionId, pr: campaign.pr };
  const before = JSON.stringify({ request, campaign, entry });
  assert.equal(cloudCorrectionMatches(entry, request, campaign), true);
  assert.equal(cloudCorrectionMatches({ ...entry, repo: request.repo }, { ...request, repo }, campaign), true);
  for (const change of [{ repo: "acme/widget-fork" }, { repo: "other/widget" }, { repo: null }, { harness: "codex" }, { session: "task_fixture2" }, { pr: 12 }]) assert.equal(cloudCorrectionMatches({ ...entry, ...change }, request, campaign), false);
  assert.equal(cloudCorrectionMatches(null, request, campaign), false);
  assert.equal(JSON.stringify({ request, campaign, entry }), before);
  t.diagnostic(JSON.stringify({ liveRepositoryCorrection: { kind: "offline read-only validation; no live qualification", canonicalRepo: request.repo, storedRepo: entry.repo, taskId: campaign.taskId, session: campaign.sessionId, pr: campaign.pr, providerCalls: 0, inputRecordsUnchanged: true } }));
});
test("Cloud native login uses stderr and drops application credentials", async () => {
  const cli = cloudCli(config, async (bin, args, opts) => {
    assert.equal(bin, config.bin); assert.equal(opts.env.OPENAI_API_KEY, undefined); assert.equal(opts.env.GH_TOKEN, undefined);
    assert.equal(opts.timeout, 10_000); // Standalone calls still have a fallback bound.
    return { stdout: "", stderr: "Logged in using ChatGPT\n" };
  });
  assert.match(await cli(["login", "status"]), /ChatGPT/);
});
test("Cloud configured deadlines retain delayed submission acknowledgements and successor ownership", async t => {
  const f = delayedSubmission(t, 11_000), observations = []; let sessionId;
  for (const operation of ["implementation", "review"]) {
    const started = f.start(() => operation === "implementation" ? f.service().submit(input) : f.service().continue({ ...input, operationId: operation, sessionId }));
    // Wait only for the subprocess to start, then model its delayed URL.
    await started.entered;
    t.mock.timers.tick(11_000);
    const job = await started.pending; sessionId ||= job.execution.sessionId;
    assert.equal(job.execution.acceptance, "accepted"); assert.equal(job.execution.providerState, "queued"); assert.equal(job.execution.sessionId, sessionId);
    const op = Object.values(readJson(join(f.root, "cloud.json")).operations).at(-1);
    assert.equal(op.taskId, job.execution.providerJobId); assert.equal(op.acceptance, "accepted");
    f.finish(); f.diff(patch(op)); f.advance(); await f.service().reconcile({ force: true });
    assert.equal((await f.service().collect()).providerJobId, op.taskId);
    observations.push({ operation, acceptance: job.execution.acceptance, taskId: op.taskId, sessionId, parentTaskId: op.parentTaskId });
  }
  assert.equal(f.tasks.size, 2);
  assert.equal(observations[1].parentTaskId, observations[0].taskId);
  for (const subprocess of f.subprocesses) { assert.equal(subprocess.timeout, 0); assert.ok(subprocess.signal instanceof AbortSignal); }
  const evidencePath = join(tempHome(), "cloud-submission-deadline-evidence.json");
  writeJsonAtomic(evidencePath, { kind: "offline timed execFile fixture; no paid Cloud dispatch", deadlineMs: 20_000, acknowledgementDelayMs: 11_000, observations }); t.diagnostic(evidencePath);
});
test("Cloud configured deadline aborts the client and retains unknown acceptance without overlapping restart work", async t => {
  const f = delayedSubmission(t, 25_000), started = f.start(() => f.service().submit(input));
  await started.entered;
  t.mock.timers.tick(10_000); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.subprocesses.at(-1).signal.aborted, false);
  t.mock.timers.tick(10_000); await assert.rejects(started.pending, { code: "EXECUTION_DEADLINE" });
  assert.equal(f.subprocesses.at(-1).signal.aborted, true);
  const op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  assert.equal(op.taskId, null); assert.equal(op.acceptance, "unknown"); assert.equal(f.tasks.size, 1);
  f.advance(); await f.service().reconcile({ force: true });
  assert.equal(f.service().current().execution.acceptance, "unknown");
  await assert.rejects(f.service().submit(input), /unknown/);
  await assert.rejects(f.service().submit({ ...input, operationId: "overlap" }), /previous|unresolved|BUSY/);
  assert.deepEqual(await f.service().cancel("timeout"), { confirmed: false, unsupported: true });
  assert.match(f.service().current().execution.recoveryAction, /execution may continue/);
  f.finish(); t.mock.timers.tick(5_000); f.advance(); await f.service().reconcile({ force: true });
  assert.equal(f.service().current().execution.acceptance, "unknown"); await assert.rejects(f.service().collect(), /quarantined/);
  await assert.rejects(f.service().submit({ ...input, operationId: "after-stop" }), /stopped/);
  assert.equal(f.tasks.size, 1); assert.equal(Object.values(readJson(join(f.root, "cloud.json")).operations)[0].taskId, null);
  const evidencePath = join(tempHome(), "cloud-submission-abort-evidence.json");
  writeJsonAtomic(evidencePath, { kind: "offline timed execFile fixture; no paid Cloud dispatch", deadlineMs: 20_000, acknowledgementDelayMs: 25_000,
    clientAborted: f.subprocesses.at(-1).signal.aborted, providerTasks: f.tasks.size, ownedTaskId: op.taskId, acceptance: f.service().current().execution.acceptance,
    stopped: f.service().state().stopped, savedResult: existsSync(join(f.service().dirOf(f.service().current().id), "result.json")), recoveryAction: f.service().current().execution.recoveryAction }); t.diagnostic(evidencePath);
});
test("Cloud launcher exit is queued, pagination reconciles exact task, restart and duplicate observations are durable", async t => {
  const f = fixture(t), first = f.service(), job = await first.submit(input);
  assert.equal(job.execution.providerState, "queued"); assert.equal(first.current().running, true); assert.equal(job.execution.turnId, job.execution.providerJobId);
  assert.equal(job.execution.effective.providerAttemptId, null);
  f.paging(); f.advance(); await f.service().reconcile({ force: true });
  assert.ok(f.pages() >= 2); assert.equal(f.service().current().execution.providerJobId, job.execution.providerJobId);
  const events = readFileSync(join(first.dirOf(job.id), "events.jsonl"), "utf8");
  f.advance(); await f.service().reconcile({ force: true }); assert.equal(readFileSync(join(first.dirOf(job.id), "events.jsonl"), "utf8"), events);
  assert.match(events, /tokenToolLogs.*unavailable/);
});
test("Cloud filtered listings reconcile null or omitted environment fields through restart and collection", async t => {
  const observations = [];
  for (const environment of [null, undefined, config.environment]) {
    const f = fixture(t), job = await f.service().submit(input), task = f.tasks.get(job.execution.providerJobId);
    if (environment === undefined) delete task.environment_id; else task.environment_id = environment;
    f.paging(); f.advance(); await f.service().reconcile({ force: true });
    assert.equal(f.service().current().execution.providerState, "queued");
    const saved = f.service().state(), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
    saved.current.execution.acceptance = "unknown"; saved.current.execution.providerJobId = null; saved.current.execution.turnId = null; saved.current.execution.sessionId = null;
    saved.operations[input.operationId].acceptance = "unknown"; writeJsonAtomic(join(f.root, "execution.json"), saved);
    f.finish(); f.diff(patch(op)); f.advance(); await f.service().reconcile({ force: true });
    assert.equal(f.service().current().execution.providerState, "retrieving-results");
    const result = await f.service().collect();
    assert.equal(f.service().current().execution.providerState, "succeeded");
    assert.equal(result.files[0].text, "new\n"); assert.equal(result.providerJobId, job.execution.providerJobId);
    assert.equal(f.tasks.size, 1); assert.ok(f.calls.some(args => args.includes("--cursor")));
    assert.deepEqual(f.calls.findLast(args => args[1] === "diff"), ["cloud", "diff", job.execution.providerJobId, "--attempt", "1"]);
    const events = readFileSync(join(f.service().dirOf(job.id), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const observation = events.findLast(event => event.type === "status");
    assert.equal(observation.data.environment, config.environment); assert.equal(observation.data.environmentSource, "filtered-listing");
    assert.equal(observation.data.providerStatus, "ready"); assert.equal(observation.data.diffAvailable, true); assert.equal(observation.timestamp, f.clock.now());
    observations.push({ rowEnvironment: environment === undefined ? "omitted" : environment, observation, result: { providerJobId: result.providerJobId, outcome: result.outcome, fileHash: contentHash(result.files[0].text) }, listingRequests: f.calls.filter(args => args[1] === "list" && !args.includes("--help")), dispatchedTasks: f.tasks.size });
  }
  const evidencePath = join(tempHome(), "cloud-filtered-listing-evidence.json");
  writeJsonAtomic(evidencePath, { kind: "offline pinned CLI list fixtures; no live inference qualification", observations }); t.diagnostic(evidencePath);
});
test("Cloud filtered listing failures retain unknown ownership without unfiltered fallback or resubmission", async t => {
  for (const failedCursor of [null, "second"]) {
    const f = fixture(t), calls = []; let fail = false;
    const cli = async args => {
      calls.push(args);
      if (fail && args[1] === "list" && (args.includes("--cursor") ? args[args.indexOf("--cursor") + 1] : null) === failedCursor) throw new Error("environment resolution/listing refused");
      return f.cli(args);
    };
    const transport = () => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli, clock: f.clock, checkAccess: offlineCloudAccess, verification: async () => {}, verifyRemote: async () => {} });
    const service = () => makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", capabilities: { ...capabilitiesFor("codex-cloud"), available: true, environments: [config.environment] }, transport: transport(), clock: f.clock });
    const job = await service().submit(input), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
    if (failedCursor) f.paging();
    f.finish(); f.diff(patch(op)); fail = true; f.advance(); await service().reconcile({ force: true });
    assert.equal(service().current().execution.providerState, "status-unknown");
    assert.equal(service().current().execution.providerJobId, job.execution.providerJobId);
    assert.equal(Object.values(readJson(join(f.root, "cloud.json")).operations)[0].state, "queued");
    assert.match(readFileSync(join(service().dirOf(job.id), "events.jsonl"), "utf8"), /CLOUD_LIST/);
    await assert.rejects(service().collect()); await assert.rejects(service().submit({ ...input, operationId: "duplicate" }));
    assert.equal(calls.some(args => args[1] === "diff" && !args.includes("--help")), false);
    fail = false; f.advance(); await service().reconcile({ force: true });
    assert.equal((await service().collect()).files[0].text, "new\n"); assert.equal(f.tasks.size, 1);
    for (const args of calls.filter(args => args[1] === "list" && !args.includes("--help"))) assert.equal(args[args.indexOf("--env") + 1], config.environment);
    const changed = makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config: { ...config, environment: "env-foreign" }, cli });
    const before = calls.length;
    await assert.rejects(changed.inspect({ providerJobId: job.execution.providerJobId, turnId: job.execution.turnId, sessionId: job.execution.sessionId }), error => error.code === "EXECUTION_OWNERSHIP");
    assert.equal(calls.length, before);
  }
});
test("Cloud nullable attempt counts preserve owned single-attempt pagination, restart and successors", async t => {
  const observations = [];
  for (const count of [null, undefined, 1]) {
    const f = fixture(t), job = await f.service().submit(input), task = f.tasks.get(job.execution.providerJobId);
    if (count === undefined) delete task.attempt_total; else task.attempt_total = count;
    f.paging(); f.advance(); await f.service().reconcile({ force: true });
    assert.equal(f.service().current().execution.providerState, "queued");
    const saved = f.service().state(), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
    saved.current.execution.acceptance = "unknown"; saved.current.execution.providerJobId = null; saved.current.execution.turnId = null; saved.current.execution.sessionId = null;
    saved.operations[input.operationId].acceptance = "unknown"; writeJsonAtomic(join(f.root, "execution.json"), saved);
    f.finish(); f.diff(patch(op)); f.advance(); await f.service().reconcile({ force: true });
    assert.equal((await f.service().collect()).files[0].text, "new\n");
    const events = readFileSync(join(f.service().dirOf(job.id), "events.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    const observation = events.findLast(event => event.type === "status");
    assert.equal(observation.data.providerAttemptTotal, count ?? null); assert.equal(observation.data.attemptSelector, 1); assert.equal(observation.data.providerAttemptId, null);
    const child = await f.service().continue({ ...input, operationId: "review", sessionId: job.execution.sessionId, prompt: "Approved current-head review feedback" });
    const childTask = f.tasks.get(child.execution.providerJobId);
    if (count === undefined) delete childTask.attempt_total; else childTask.attempt_total = count;
    f.finish(); f.diff(patch(Object.values(readJson(join(f.root, "cloud.json")).operations).at(-1))); f.advance(); await f.service().reconcile({ force: true });
    assert.equal((await f.service().collect()).files[0].text, "new\n");
    assert.equal(child.execution.sessionId, job.execution.sessionId); assert.equal(child.execution.effective.parentTaskId, job.execution.providerJobId);
    const dispatches = f.calls.filter(args => args[1] === "exec" && !args.includes("--help"));
    assert.equal(dispatches.length, 2);
    for (const args of dispatches) {
      assert.equal(args[args.indexOf("--attempts") + 1], "1");
      assert.ok(args.at(-1).includes(`inputHead (exactly ${head}), exit (integer)`));
    }
    assert.equal(f.tasks.size, 2);
    observations.push({ count: count === undefined ? "omitted" : count, observation, parent: job.execution.providerJobId, child: child.execution.providerJobId, dispatches: dispatches.map(args => args.slice(0, -1)) });
  }
  const report = join(tempHome(), "cloud-nullable-attempt-evidence.json");
  writeJsonAtomic(report, { kind: "offline pinned CLI fixtures; no live inference or native attempt-ID qualification", observations }); t.diagnostic(report);
});
test("Cloud result test records require commands, owned revisions and integer exits with isolated cleanup", async () => {
  const op = { ...input, runId: "owned-run" }, valid = { command: "node --test", inputHead: head, exit: 0, output: "provider-reported output" };
  const invalid = [{}, null, { ...valid, command: 5 }, { ...valid, inputHead: undefined }, { ...valid, inputHead: "b".repeat(40) }, { ...valid, exit: undefined }, { ...valid, exit: "0" }, { ...valid, exit: .5 }];
  for (const successor of [false, true]) {
    const owned = { ...op, continuity: successor ? "successor-task" : "initial-task" }; let checkout;
    const exec = (bin, args, options) => { checkout = options.cwd; return execFileAsync(bin, args, options); };
    for (const record of invalid) {
      await assert.rejects(cloudDiffResult(patch(op, { tests: [record] }, successor), owned, { exec }), error => error.collectionValidation === true);
      assert.equal(existsSync(checkout), false);
    }
    for (const tests of [[], [valid], [{ ...valid, exit: 1 }]]) {
      assert.deepEqual((await cloudDiffResult(patch(op, { tests }, successor), owned, { exec })).tests, tests);
      assert.equal(existsSync(checkout), false);
    }
  }
});
test("Cloud malformed test evidence blocks collection across restart without saving or publishing it", async t => {
  const f = fixture(t), job = await f.service().submit(input), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  f.finish(); f.diff(patch(op, { tests: [{}] })); f.advance(); await f.service().reconcile({ force: true });
  await assert.rejects(f.service().collect(), error => error.collectionValidation === true);
  const dir = f.service().dirOf(job.id), checkpoint = readJson(join(dir, "result-application.json"));
  assert.equal(checkpoint.phase, "blocked"); assert.equal(checkpoint.reason, "result-collection-validation");
  assert.equal(existsSync(join(dir, "result.json")), false); assert.equal(existsSync(join(dir, "verification.json")), false); assert.equal(existsSync(join(f.root, "answer.txt")), false);
  const calls = f.calls.length;
  f.advance(); await f.service().reconcile({ force: true }); await assert.rejects(f.service().collect(), { code: "EXECUTION_RESULT_BLOCKED" });
  assert.equal(f.calls.length, calls); assert.deepEqual(readJson(join(dir, "result-application.json")), checkpoint);
  const report = join(tempHome(), "cloud-rejected-test-evidence.json");
  writeJsonAtomic(report, { kind: "offline malformed provider test fixture; no live inference", checkpoint, savedResult: existsSync(join(dir, "result.json")), savedVerification: existsSync(join(dir, "verification.json")), sourceFileApplied: existsSync(join(f.root, "answer.txt")), callsBeforeRestart: calls, callsAfterRestart: f.calls.length }); t.diagnostic(report);
});
test("Cloud lost acknowledgement never chooses newest task or creates duplicate paid work", async t => {
  const f = fixture(t); f.lost();
  await assert.rejects(f.service().submit(input), /lost/);
  await f.service().reconcile({ force: true }); await assert.rejects(f.service().submit(input), /unknown/);
  assert.equal(f.tasks.size, 1); assert.equal(f.service().current().execution.acceptance, "unknown");
  assert.equal(f.service().current().execution.providerJobId, null);
});
test("Cloud persisted native acknowledgement recovers a coordinator crash without resubmission", async t => {
  const f = fixture(t), execution = f.service(), job = await execution.submit(input), saved = execution.state();
  saved.current.execution.acceptance = "unknown"; saved.current.execution.providerJobId = null; saved.current.execution.turnId = null; saved.current.execution.sessionId = null;
  saved.operations[input.operationId].acceptance = "unknown"; writeJsonAtomic(join(f.root, "execution.json"), saved);
  f.advance(); await f.service().reconcile({ force: true });
  assert.equal(f.service().current().execution.providerJobId, job.execution.providerJobId);
  assert.equal(f.service().current().execution.sessionId, job.execution.sessionId);
  assert.equal(f.tasks.size, 1);
});
test("Cloud dispatch rejects moved remote heads, auth refusal and local absolute references before a paid command", async t => {
  const f = fixture(t);
  const transport = makeCloudTransport({ root: f.root, taskId: "task", account: "operator", config, cli: f.cli, checkAccess: offlineCloudAccess, verification: async () => {}, verifyRemote: async () => { throw new Error("remote head moved"); } });
  await assert.rejects(transport.submit({ ...input, runId: "run-test", idempotencyKey: "dispatch-key" }), error => error.dispatchNotSent === true);
  await assert.rejects(f.service().submit({ ...input, prompt: "Read /Users/operator/private.txt" }), error => error.dispatchNotSent === true);
  f.auth("not signed in"); await assert.rejects(f.service().submit(input), error => error.dispatchNotSent === true);
  assert.equal(f.tasks.size, 0); assert.equal(f.service().current(), null);
});
test("Cloud transport accepts repository letter case across dispatch, restart and successors", async t => {
  const observations = [];
  for (const [configuredRepo, canonicalRepo] of [["Acme/Widget", repo], [repo, "Acme/Widget"]]) {
    const f = fixture(t), source = JSON.parse(gunzipSync(bytes)); source.repo = canonicalRepo;
    const snapshot = gzipSync(Buffer.from(JSON.stringify(source)));
    const request = { ...input, repo: canonicalRepo, sources: { ...input.sources, repo: canonicalRepo, data: snapshot.toString("base64"), hash: contentHash(snapshot) } };
    const transport = repository => makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config: { ...config, repository }, cli: f.cli, clock: f.clock, checkAccess: offlineCloudAccess, verification: async () => {}, verifyRemote: async req => { assert.equal(req.repo, canonicalRepo); } });
    const service = repository => makeExecution({ root: f.root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", capabilities: { ...capabilitiesFor("codex-cloud"), available: true, environments: [config.environment] }, transport: transport(repository), clock: f.clock });
    const first = await service(configuredRepo).submit(request), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
    assert.equal(op.repo, canonicalRepo);
    for (const other of ["acme/widget-fork", "other/widget", "widget/acme", null]) {
      await assert.rejects(transport(configuredRepo).prepare({ ...request, repo: other, sources: { ...request.sources, repo: other } }), error => error.code === "CLOUD_SOURCE");
    }
    // A configuration spelling may change; immutable request/source/result
    // envelopes still have to repeat the exact identity recorded at dispatch.
    await assert.rejects(transport(configuredRepo).prepare({ ...request, sources: { ...request.sources, repo: canonicalRepo.toUpperCase() } }), error => error.code === "CLOUD_SOURCE");
    await assert.rejects(cloudDiffResult(patch(op, { repo: canonicalRepo.toUpperCase() }), op), error => error.collectionValidation === true);
    await assert.rejects(transport("acme/widget-fork").inspect({ providerJobId: first.execution.providerJobId, sessionId: first.execution.sessionId, turnId: first.execution.turnId }), error => error.code === "EXECUTION_OWNERSHIP");
    assert.equal(f.tasks.size, 1);
    f.finish(); f.diff(patch(op, { repo: canonicalRepo })); f.advance();
    const restarted = service(configuredRepo.toUpperCase()); await restarted.reconcile({ force: true });
    const result = await restarted.collect(); assert.equal(result.repo, canonicalRepo); assert.equal(result.files[0].text, "new\n");
    const child = await service(configuredRepo.toUpperCase()).continue({ ...request, operationId: "review", sessionId: first.execution.sessionId });
    assert.equal(child.execution.sessionId, first.execution.sessionId); assert.equal(child.execution.effective.parentTaskId, first.execution.providerJobId);
    assert.equal(f.tasks.size, 2); assert.equal(readJson(join(f.root, "cloud.json")).repository, configuredRepo);
    assert.ok(Object.values(readJson(join(f.root, "cloud.json")).operations).every(saved => saved.repo === canonicalRepo));
    observations.push({ configuredRepo, canonicalRepo, storedRepository: readJson(join(f.root, "cloud.json")).repository, initialTask: first.execution.providerJobId, successorTask: child.execution.providerJobId, continuity: child.execution.effective.continuity, resultRepo: result.repo, sourceHash: request.sources.hash, dispatchedTasks: f.tasks.size });
  }
  t.diagnostic(JSON.stringify({ repositoryCaseTransport: observations }));
});
test("Cloud repeated pagination cursor fails bounded recovery and never adopts an unrelated task", async t => {
  const f = fixture(t), job = await f.service().submit(input);
  const cli = async args => args[1] === "list" ? JSON.stringify({ tasks: [], cursor: "same" }) : f.cli(args);
  const transport = makeCloudTransport({ root: f.root, taskId: "acme/widget/task", account: "operator", config, cli });
  await assert.rejects(transport.inspect({ providerJobId: job.execution.providerJobId, turnId: job.execution.turnId, sessionId: job.execution.sessionId }), /repeated/);
});
test("Cloud collection converts diff in isolation, verifies run/base and resumes as a successor in one logical session", async t => {
  const f = fixture(t), execution = f.service(), job = await execution.submit(input);
  const saved = readJson(join(f.root, "cloud.json")), op = Object.values(saved.operations)[0];
  f.finish(); f.diff(patch(op)); f.advance(); await f.service().reconcile({ force: true });
  const result = await f.service().collect(); assert.equal(result.files[0].text, "new\n"); assert.equal(result.files.length, 1);
  assert.equal(existsSync(join(f.root, "answer.txt")), false); assert.deepEqual(result.tests, []);
  const child = await f.service().continue({ ...input, operationId: "review", sessionId: job.execution.sessionId, prompt: "Approved requirements; current pushed code; trusted current-head feedback and recorded decisions" });
  assert.equal(child.execution.sessionId, job.execution.sessionId); assert.notEqual(child.execution.providerJobId, job.execution.providerJobId);
  assert.equal(child.execution.effective.parentTaskId, job.execution.providerJobId); assert.equal(child.execution.effective.continuity, "successor-task");
  assert.match(f.calls.findLast(args => args[1] === "exec" && !args.includes("--help")).at(-1), /recorded decisions/);
});
test("Cloud envelope-only results require an owned successor and exact envelope identity", async () => {
  const op = { ...input, runId: "owned-run", continuity: "successor-task", name: "receipt" };
  for (const name of [undefined, "receipt", "public-text", "resume", "review"]) {
    assert.equal((await cloudDiffResult(patch(op, {}, true), { ...op, name })).pushedHead, head);
    await assert.rejects(cloudDiffResult(patch(op, {}, true), { ...op, name, continuity: "initial-task" }), /no deliverable file changes/);
    for (const wrong of [{ runId: "foreign-run" }, { inputHead: "b".repeat(40) }, { sourceHashes: { "foreign.md": "wrong" } }]) {
      await assert.rejects(cloudDiffResult(patch(op, wrong, true), { ...op, name }), error => error.collectionValidation === true);
    }
  }
});
test("Cloud envelope-only corrections share one PR, restart recovery and bounded round decisions", async t => {
  const f = fixture(t), id = "acme/widget/task", first = await f.service().submit(input);
  const initial = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  f.finish(); f.diff(patch(initial)); f.advance(); await f.service().reconcile({ force: true }); await f.service().collect();
  const worktree = join(f.root, "checkout"); mkdirSync(worktree);
  const native = args => execFileSync("git", args, { cwd: worktree, env: { PATH: process.env.PATH, ...runEnv() }, encoding: "utf8" }).trim();
  native(["init", "-b", branch]); native(["remote", "add", "origin", "https://github.com/acme/widget.git"]);
  writeFileSync(join(worktree, "answer.txt"), "old\n");
  const git = makeGit({ config: {}, identity: async () => ({ name: "Fixture", email: "fixture@example.test" }) });
  await git.commitResult(worktree, ["answer.txt"]);
  const inputHead = await git.head(worktree), source = JSON.parse(gunzipSync(bytes).toString());
  source.inputHead = inputHead;
  const snapshot = gzipSync(Buffer.from(JSON.stringify(source)));
  const currentInput = { ...input, inputHead, sources: { ...input.sources, inputHead, inputBranch: `${branch}-cloud-${inputHead}`, data: snapshot.toString("base64"), hash: contentHash(snapshot) } };
  const receiptBody = met => '```work-attestations\n' + JSON.stringify({ task_id: id, output_type: "code", summary: "The approved answer source remains unchanged while the requested completion receipt is corrected and the coordinator verifies the current revision before updating the existing pull request.", criteria_attestations: [{ criterion_id: "ac-1", met, evidence: "answer.txt and coordinator-executed printf verified" }] }) + '\n```';
  const observations = [];
  for (const name of ["receipt", "public-text", "resume", "review"]) {
    const child = await f.service().continue({ ...currentInput, name, operationId: name, sessionId: first.execution.sessionId, prompt: "Correct only the approved completion receipt or public PR wording; preserve the current code." });
    const op = Object.values(readJson(join(f.root, "cloud.json")).operations).at(-1);
    assert.equal(op.name, name); assert.equal(op.continuity, "successor-task");
    assert.match(f.calls.findLast(args => args[1] === "exec" && !args.includes("--help")).at(-1), /do not invent unrelated edits/);
    const beforeBody = receiptBody(["public-text", "review"].includes(name)), gh = fakeGh({ pr: prFixture({ number: 7, url: "https://github.com/acme/widget/pull/7", headRefName: branch, headRefOid: inputHead, title: "Prior wording", body: beforeBody }) });
    f.finish(); f.diff(patch(op, { pr: { title: name === "review" ? "Prior wording" : "Correct public wording", body: receiptBody(true) } }, true)); f.advance(); await f.service().reconcile({ force: true });
    const result = await f.service().collect();
    assert.deepEqual(result.files, []); assert.equal(result.pushedHead, inputHead); assert.equal(result.sessionId, first.execution.sessionId);
    const state = makeState(f.root), calls = [];
    const entry = { ...newEntry({ prd: "brief.md", harness: "codex-cloud", repo, branch, base: "main", worktree, pr: 7, session: first.execution.sessionId, state: STATES.prOpen, nowIso: T0 }),
      execution: f.service().current().execution, last: { run: child.id, exit: null, at: T0 },
      cursor: { since: T0, dispatched: ["inline:pending"], fixed_sha: inputHead, receipt_hash: receiptHash(beforeBody) },
      public_fix: name === "public-text" ? publicReviewHash(gh.data.pr, []) : null };
    state.put(id, entry);
    let lostReply = true;
    Object.assign(gh, { refSha: async () => inputHead, containsCommit: async (seenRepo, seenBranch, seenHead) => {
      assert.equal(seenRepo, repo); assert.equal(seenBranch, branch); assert.equal(seenHead, inputHead);
      return native(["merge-base", "--is-ancestor", seenHead, "HEAD"]) === "";
    }, publishResultPr: async data => {
      calls.push("PR"); assert.equal(data.branch, branch); assert.equal(data.base, "main");
      gh.data.pr.title = data.title; gh.data.pr.body = data.body;
      if (lostReply) { lostReply = false; throw new Error("PR update reply lost"); }
      return { number: gh.data.pr.number, url: gh.data.pr.url };
    } });
    const ctx = { home: f.root, state, clock: f.clock, config: CONFIG, ownLogin: "me", notify: fakeNotify(), log: silentLog, executionFor: () => f.service(), gh,
      git: { ...git, commitResult: async () => { throw new Error("text-only correction must not commit source files"); }, pushResult: async () => calls.push("push") },
      readPrd: () => "# Brief\n\n## Verify\n\n- `printf verified`\n" };
    const rejectedDir = join(f.root, `${name}-stale-head`); mkdirSync(rejectedDir);
    await assert.rejects(reconcileExecutionResult({ ...ctx, gh: { ...gh, refSha: async () => "b".repeat(40) } }, { id, entry, result, dir: rejectedDir }), /pushed result revision/);
    assert.deepEqual(calls, []); assert.equal(readJson(join(rejectedDir, "result-application.json")).phase, "blocked");
    await makeTick(ctx).tickEntry(id, state.get(id), { settleOnly: true });
    const dir = f.service().dirOf(child.id), verified = readJson(join(dir, "verification.json"));
    assert.equal(readJson(join(dir, "result-application.json")).phase, "verified"); assert.equal(state.get(id).last.exit, null);
    assert.equal(verified.head, inputHead); assert.equal(verified.evidence.length, 1); assert.equal(verified.evidence[0].exit, 0); assert.equal(verified.evidence[0].source, "coordinator-executed");
    const restarted = { ...ctx, state: makeState(f.root) };
    await makeTick(restarted).tickEntry(id, restarted.state.get(id), { settleOnly: true });
    await makeTick(restarted).tickEntry(id, restarted.state.get(id), { settleOnly: true });
    const settled = restarted.state.get(id), checkpoint = readJson(join(dir, "result-application.json"));
    assert.equal(settled.last.exit, 0);
    if (name === "review") {
      assert.equal(settled.reason, null); assert.equal(settled.state, STATES.prOpen); assert.equal(settled.iteration, 0); assert.equal(settled.round_comment ?? null, null);
    } else {
      assert.equal(settled.reason, null); assert.equal(settled.iteration, 1); assert.equal(settled.round_comment.kind, name === "public-text" ? name : "receipt");
    }
    assert.equal(settled.pr, 7); assert.equal(settled.session, first.execution.sessionId); assert.deepEqual(settled.cursor.dispatched, entry.cursor.dispatched);
    assert.deepEqual(calls, ["push", "PR", "push", "PR"]); assert.equal(checkpoint.phase, "published"); assert.equal(checkpoint.pr, 7);
    assert.deepEqual(readJson(join(dir, "verification.json")), verified); assert.equal(await git.head(worktree), inputHead); assert.equal(readFileSync(join(worktree, "answer.txt"), "utf8"), "old\n");
    assert.equal(existsSync(join(worktree, CLOUD_RESULT_PATH)), false); assert.deepEqual(await git.dirty(worktree, { strict: true }), { modified: 0, untracked: 0 });
    observations.push({ name, result, checkpoint, verification: verified, pr: { number: settled.pr, head: gh.data.pr.headRefOid, title: gh.data.pr.title, body: gh.data.pr.body }, iteration: settled.iteration, reason: settled.reason, roundKind: settled.round_comment?.kind ?? null, calls, sourceHead: inputHead, sourceHash: contentHash(readFileSync(join(worktree, "answer.txt"))) });
  }
  assert.equal(f.tasks.size, 5);
  const path = join(tempHome(), "cloud-envelope-only-evidence.json"); writeJsonAtomic(path, { kind: "Offline native Git/verification and Cloud CLI-output fixture; no live Cloud inference", observations }); t.diagnostic(`Cloud envelope-only publication evidence: ${path}`);
});
test("Cloud native continuation is refused without demonstrated capability", async t => {
  const f = fixture(t); await assert.rejects(f.service().continue({ ...input, sessionId: "task_foreign" }), /continuation/);
  assert.equal(f.tasks.size, 0);
});
test("Cloud multiple attempts, foreign environments and missing exact identity stay unknown with timestamped errors", async t => {
  for (const change of [...[0, 2, -1, 1.5, "1", false].map(attempt_total => ({ attempt_total })), { environment_id: "env-foreign" }, { id: "task_foreign" }]) {
    const f = fixture(t), job = await f.service().submit(input); Object.assign([...f.tasks.values()][0], change);
    f.advance(); await f.service().reconcile({ force: true });
    assert.equal(f.service().current().execution.providerState, "status-unknown");
    assert.match(readFileSync(join(f.service().dirOf(job.id), "events.jsonl"), "utf8"), /"type":"error".*"timestamp"|"timestamp".*"type":"error"/);
  }
});
test("Cloud stop retains native task link, fences successors and quarantines late success", async t => {
  const f = fixture(t), job = await f.service().submit(input);
  assert.deepEqual(await f.service().cancel("operator"), { confirmed: false, unsupported: true });
  assert.match(f.service().current().execution.recoveryAction, /execution may continue/); assert.match(f.service().current().execution.effective.taskUrl, /task_fixture1/);
  f.finish(); f.advance(); await f.service().reconcile({ force: true });
  assert.equal(f.service().current().execution.quarantined, true); await assert.rejects(f.service().collect(), /quarantined/);
  await assert.rejects(f.service().continue({ ...input, operationId: "correction", sessionId: job.execution.sessionId }), /stopped/);
  assert.equal(f.calls.some(args => args[1] === "cancel"), false);
});
test("Cloud diffs reject wrong bases, path escapes, symlinks, mode changes and stale result identity before application", async t => {
  const f = fixture(t), job = await f.service().submit(input), op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  for (const diff of [patch(op, { inputHead: "b".repeat(40) }), patch(op, { runId: "foreign" }), patch(op).replaceAll("answer.txt", "../escape"), patch(op).replace("100644", "120000"), patch(op).replace("100644", "100755"), patch(op).replace("-old\n", "-wrong\n"), patch(op).replace("index 3367afd..3e75765 100644", "old mode 100644\nnew mode 100755")]) await assert.rejects(cloudDiffResult(diff, op), error => error.collectionValidation === true);
  assert.equal(f.service().current().id, job.id);
});
test("Cloud collection keeps unavailable Git and local I/O retryable and cleans its temporary directory", async t => {
  const f = fixture(t); await f.service().submit(input); const op = Object.values(readJson(join(f.root, "cloud.json")).operations)[0];
  let directory;
  for (const code of ["ENOENT", "ENOSPC", "EIO"]) {
    await assert.rejects(cloudDiffResult(patch(op), op, { exec: async (_, __, options) => { directory = options.cwd; throw Object.assign(new Error("local delivery unavailable"), { code }); } }), error => error.code === code && error.collectionValidation !== true);
    assert.equal(existsSync(directory), false);
  }
});
function sourceFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cloud-source-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", branch); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@localhost");
  writeFileSync(join(root, "answer.txt"), "old\n"); git("add", "answer.txt"); git("commit", "-qm", "Input source"); git("remote", "add", "origin", "https://github.com/acme/widget.git");
  const gitService = makeGit({ identity: async () => ({ name: "Fixture", email: "fixture@localhost" }) }), refs = new Map(), calls = [];
  const ctx = { config: { harness: { "codex-cloud": config } }, readPrd: () => "approved brief\n", readSource: () => "approved source\n", git: { ...gitService,
    pushResult: async (dir, ref) => { calls.push(["task", ref]); refs.set(ref, git("rev-parse", "HEAD")); },
    pushSnapshotRef: async (dir, ref) => { calls.push(["snapshot", ref]); refs.set(ref, git("rev-parse", "HEAD")); } },
    gh: { refSha: async (_, ref) => refs.get(ref), fileAtStrict: async (_, path, revision) => execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "utf8" }) } };
  const entry = { harness: "codex-cloud", repo, branch, base: "main", worktree: root, checkout: "/operator", prd: "brief.md", sources: ["source.md"] };
  writeFileSync(join(root, "brief.md"), ctx.readPrd()); writeFileSync(join(root, "source.md"), ctx.readSource());
  return { root, git, refs, calls, ctx, entry };
}
test("Cloud input accepts repository letter case and preserves exact snapshot ownership", async t => {
  const observations = [];
  for (const [configuredRepo, canonicalRepo] of [[repo, "Acme/Widget"], ["Acme/Widget", repo]]) {
    const { git, refs, calls, ctx, entry } = sourceFixture(t);
    ctx.config.harness["codex-cloud"] = { ...config, repository: configuredRepo }; entry.repo = canonicalRepo;
    const delivered = await cloudInput(ctx, "task", entry, { ...input, inputHead: git("rev-parse", "HEAD") });
    const snapshot = JSON.parse(gunzipSync(Buffer.from(delivered.sources.data, "base64")));
    assert.equal(delivered.repo, canonicalRepo); assert.equal(delivered.sources.repo, canonicalRepo); assert.equal(snapshot.repo, canonicalRepo);
    assert.equal(refs.get(delivered.sources.inputBranch), delivered.inputHead); assert.equal(git("status", "--porcelain"), "");
    assert.deepEqual(Object.keys(delivered.sources.hashes), ["brief.md", "source.md"]);
    for (const other of ["acme/widget-fork", "other/widget", "widget/acme", null]) {
      await assert.rejects(cloudInput(ctx, "task", { ...entry, repo: other }, delivered), error => error.code === "CLOUD_SOURCE");
    }
    await assert.rejects(cloudInput(ctx, "task", { ...entry, branch: branch.toUpperCase() }, delivered), error => error.code === "CLOUD_SOURCE");
    assert.equal(git("rev-parse", "HEAD"), delivered.inputHead); assert.equal(calls.length, 2);
    observations.push({ configuredRepo, canonicalRepo, snapshotRepo: snapshot.repo, inputHead: delivered.inputHead, remoteRefHead: refs.get(delivered.sources.inputBranch), sourceHash: delivered.sources.hash, approvedHashes: delivered.sources.hashes, pushedRefs: calls });
  }
  t.diagnostic(JSON.stringify({ repositoryCaseInput: observations }));
});
test("Cloud input publishes only approved snapshots, verifies remote bytes and preserves task upstream", async t => {
  const { root, git, refs, calls, ctx, entry } = sourceFixture(t);
  const delivered = await cloudInput(ctx, "task", entry, { ...input, inputHead: git("rev-parse", "HEAD") });
  assert.equal(refs.get(delivered.sources.inputBranch), delivered.inputHead); assert.deepEqual(Object.keys(delivered.sources.hashes), ["brief.md", "source.md"]);
  assert.deepEqual(calls.map(call => call[0]), ["task", "snapshot"]); assert.equal(git("status", "--porcelain"), "");
  chmodSync(join(root, "brief.md"), 0o755); await assert.rejects(cloudInput(ctx, "task", entry, { ...input, inputHead: delivered.inputHead }), /snapshot mode changed/); chmodSync(join(root, "brief.md"), 0o644);
  writeFileSync(join(root, "private.txt"), "unrelated"); await assert.rejects(cloudInput(ctx, "task", entry, { ...input, inputHead: delivered.inputHead }), /unfinished repository/);
  assert.equal(calls.length, 2);
});
test("Cloud adapter and operator instructions ship in a clean installed package without provider calls", async t => {
  const root = mkdtempSync(join(tmpdir(), "cloud-package-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const [artifact] = JSON.parse(output);
  assert.ok(artifact.files.some(file => file.path === "lib/codex_cloud.mjs")); assert.ok(artifact.files.some(file => file.path === "docs/codex-cloud.md"));
  execFileSync("tar", ["-xzf", join(root, artifact.filename), "-C", root]);
  const installed = await import(pathToFileURL(join(root, "package/lib/harness.mjs")));
  assert.equal(installed.capabilitiesFor("codex-cloud").available, false); assert.equal(installed.capabilitiesFor("codex-cloud").liveQualified, false);
  assert.match(installed.capabilitiesFor("codex-cloud").fix, /supported.*environment.*repository/);
  const cliHelp = execFileSync(process.execPath, [join(root, "package/bin/gallivant.mjs"), "--help"], { encoding: "utf8" });
  assert.match(cliHelp, /start/);
});
