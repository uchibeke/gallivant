import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { makeCloudTransport, checkCloudAccess, cloudCli } from "../lib/codex_cloud.mjs";
import { validateCloudConfig } from "../lib/codex_cloud_config.mjs";
import { CLOUD_RESULT_PATH, cloudDiffResult } from "../lib/codex_cloud_result.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { capabilitiesFor } from "../lib/harness.mjs";
import { cloudInput } from "../lib/codex_cloud_input.mjs";
import { makeGit } from "../lib/git.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { contentHash } from "../lib/openai_agents_sources.mjs";
const config = { bin: "/fixture/codex", account: "operator", authentication: "operator-chatgpt", mode: "trusted-worker", environment: "env-fixture", repository: "acme/widget", continuation: "successor-task", billing_source: "chatgpt-account", allowance: { remainingUsd: 1, reservedUsd: .1 } };
const head = "a".repeat(40), repo = config.repository, branch = "work/widget";
const bytes = gzipSync(Buffer.from(JSON.stringify({ version: 1, inputHead: head, repo, branch, files: [{ path: "answer.txt", data: Buffer.from("old\n").toString("base64"), hash: contentHash("old\n"), mode: 0o644 }] })));
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
      tasks.set(id, { id, url: `https://chatgpt.com/codex/tasks/${id}`, status: "pending", environment_id: config.environment, attempt_total: 1, summary: { files_changed: 1, lines_added: 1, lines_removed: 1 }, updated_at: new Date(now).toISOString() });
      if (lost) throw new Error("lost submission reply"); return tasks.get(id).url;
    }
    if (args[1] === "list") {
      pages++;
      if (paging && !args.includes("--cursor")) return JSON.stringify({ tasks: [{ id: "task_unrelated" }], cursor: "second" });
      return JSON.stringify({ tasks: [...tasks.values()], cursor: null });
    }
    if (args[1] === "diff") return diff;
    throw new Error("unsupported fixture command");
  };
  const clock = { now: () => now }, capabilities = { ...capabilitiesFor("codex-cloud"), environments: [config.environment] };
  const transport = () => makeCloudTransport({ root, taskId: "acme/widget/task", account: "operator", config, cli, clock, verification: async () => {}, verifyRemote: async () => {} });
  const service = () => makeExecution({ root, taskId: "acme/widget/task", account: "operator", provider: "codex-cloud", capabilities, transport: transport(), clock });
  return { root, tasks, calls, cli, transport, service, advance: () => { now += 1000; }, finish: () => { [...tasks.values()].at(-1).status = "ready"; }, lost: () => { lost = true; }, paging: () => { paging = true; }, pages: () => pages, auth: value => { auth = value; }, version: value => { version = value; }, diff: value => { diff = value; } };
}
function patch(op, overrides = {}) {
  const receipt = { version: 1, inputHead: op.inputHead, repo, branch, runId: op.runId, sourceHashes: {}, pr: { title: "Implement answer", body: "Observed file and test result" }, tests: [], ...overrides };
  return `diff --git a/answer.txt b/answer.txt\nindex 3367afd..3e75765 100644\n--- a/answer.txt\n+++ b/answer.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/${CLOUD_RESULT_PATH} b/${CLOUD_RESULT_PATH}\nnew file mode 100644\n--- /dev/null\n+++ b/${CLOUD_RESULT_PATH}\n@@ -0,0 +1 @@\n+${JSON.stringify(receipt)}\n`;
}
test("Cloud capabilities preserve defaults and refuse unsupported delegation, policy, models and attempts", () => {
  assert.equal(capabilitiesFor("codex-cloud").continuation, "successor-task");
  assert.equal(capabilitiesFor("codex").transport, "cli"); assert.equal(capabilitiesFor("openai-agents").continuation, "native-session");
  for (const change of [{ account: "someone-else" }, { mode: "public" }, { authentication: "cookies" }, { model: "override" }, { attempts: 2 }, { mandatory_policy: ["workspace-write"] }, { context_paths: ["/private"] }, { allowance: { remainingUsd: 0, reservedUsd: 0 } }]) assert.throws(() => validateCloudConfig({ ...config, ...change }));
});
test("Cloud access checks pinned CLI, ChatGPT sign-in, command surface and chosen environment without inference", async t => {
  const f = fixture(t);
  assert.equal((await checkCloudAccess(config, { cli: f.cli })).ok, true);
  assert.equal(f.calls.some(args => args[1] === "exec" && !args.includes("--help")), false);
  f.auth("Logged in using an API key"); assert.equal((await checkCloudAccess(config, { cli: f.cli })).detail, "CLOUD_AUTH");
  f.version("codex-cli 0.161.0"); assert.equal((await checkCloudAccess(config, { cli: f.cli })).detail, "CLOUD_VERSION");
});
test("Cloud native login uses stderr and drops application credentials", async () => {
  const cli = cloudCli(config, async (bin, args, opts) => {
    assert.equal(bin, config.bin); assert.equal(opts.env.OPENAI_API_KEY, undefined); assert.equal(opts.env.GH_TOKEN, undefined);
    return { stdout: "", stderr: "Logged in using ChatGPT\n" };
  });
  assert.match(await cli(["login", "status"]), /ChatGPT/);
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
  const transport = makeCloudTransport({ root: f.root, taskId: "task", account: "operator", config, cli: f.cli, verification: async () => {}, verifyRemote: async () => { throw new Error("remote head moved"); } });
  await assert.rejects(transport.submit({ ...input, runId: "run-test", idempotencyKey: "dispatch-key" }), error => error.dispatchNotSent === true);
  await assert.rejects(f.service().submit({ ...input, prompt: "Read /Users/operator/private.txt" }), error => error.dispatchNotSent === true);
  f.auth("not signed in"); await assert.rejects(f.service().submit(input), error => error.dispatchNotSent === true);
  assert.equal(f.tasks.size, 0); assert.equal(f.service().current(), null);
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
test("Cloud native continuation is refused without demonstrated capability", async t => {
  const f = fixture(t); await assert.rejects(f.service().continue({ ...input, sessionId: "task_foreign" }), /continuation/);
  assert.equal(f.tasks.size, 0);
});
test("Cloud multiple attempts, foreign environments and missing exact identity stay unknown with timestamped errors", async t => {
  for (const change of [{ attempt_total: 2 }, { environment_id: "env-foreign" }, { id: "task_foreign" }]) {
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
test("Cloud input publishes only approved snapshots, verifies remote bytes and preserves task upstream", async t => {
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
  assert.equal(installed.capabilitiesFor("codex-cloud").available, true); assert.equal(installed.capabilitiesFor("codex-cloud").liveQualified, false);
  const cliHelp = execFileSync(process.execPath, [join(root, "package/bin/gallivant.mjs"), "--help"], { encoding: "utf8" });
  assert.match(cliHelp, /start/);
});
