import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { mount, serve } from "../lib/commands/serve.mjs";
import { queueChain } from "../lib/chains.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { grantPlanCheckout, localWorkerCommand, planSocketPath } from "../lib/local_plan_boundary.mjs";
import { callLocalPlans, makeLocalPlans, setupLocalPlans } from "../lib/local_plan_service.mjs";
import { planOperator } from "../lib/operator_intent.mjs";
import { makeGit } from "../lib/git.mjs";
import { buildRun } from "../lib/harness.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { writeRepositoryText } from "../lib/repository_files.mjs";
import { makeRunner } from "../lib/run.mjs";
import { makeState } from "../lib/state.mjs";
import { CONFIG, GOOD_PRD, fakeGh, harnessBin, silentLog } from "./helpers.mjs";

const REPO = "acme/widget", OTHER = "acme/other";
const cli = fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url));
const exec = promisify(execFile);
const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };

test("checkout overlays prepare named access for new files and parent directories on retry", t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lp-overlay-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prepared = [];
  let fail = false;
  const git = makeGit({ worktreeBoundary: { overlayAccess: checkout => {
    assert.equal(checkout, root);
    return (fd, file) => {
      const item = fstatSync(fd);
      assert.equal(item.uid, process.getuid());
      if (item.isDirectory()) prepared.push(file);
      else {
        assert.ok(item.isFile());
        assert.equal(item.nlink, 1);
        if (fail) throw new Error("fixture ACL write failed");
        prepared.push(readFileSync(file, "utf8"));
      }
    };
  } } });
  const rel = "new/nested/source.md", options = git.overlayOptions?.(root);
  const parent = join(root, "new", "nested");
  // An older coordinator may already have created the first parent with a
  // restrictive mask. Both it and the missing nested directory need access.
  mkdirSync(join(root, "new"), { mode: 0o755 });
  writeRepositoryText(root, rel, "approved", options);
  assert.deepEqual(prepared, [join(root, "new"), parent, "approved"]);
  fail = true;
  assert.throws(() => writeRepositoryText(root, rel, "replacement", options), /ACL write failed/);
  assert.deepEqual(readdirSync(parent), ["source.md"]);
  assert.equal(readFileSync(join(root, rel), "utf8"), "approved");
  fail = false;
  writeRepositoryText(root, rel, "replacement", options);
  assert.equal(readFileSync(join(root, rel), "utf8"), "replacement");
  assert.equal(prepared.at(-1), "replacement");
});

function fixture(t) {
  // Keep the Unix pathname short on both production platforms.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home"), checkout = join(root, "repo"), worktrees = join(root, "work");
  for (const path of [home, checkout, worktrees]) mkdirSync(path, { mode: 0o700 });
  const git = (...args) => execFileSync("git", args, { cwd: checkout, timeout: 5000, encoding: "utf8" }).trim();
  git("init", "-q", "--initial-branch=main");
  git("remote", "add", "origin", `https://github.com/${REPO}.git`);
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Base", "--allow-empty");
  const base = git("rev-parse", "HEAD");
  const configFile = join(home, "config.json");
  const raw = { ...structuredClone(CONFIG), home, worktrees, harness: { codex: { bin: harnessBin(home) } },
    repos: [REPO, OTHER], github_token_file: join(home, "git-token"), dispatch_capacity: { authors: 1, per_repository: 3, preparations: 2 } };
  writeJsonAtomic(configFile, raw);
  write(raw.github_token_file, "fixture-secret");
  const calls = [];
  const gh = { ...fakeGh(), user: async () => { calls.push("host-user"); return "operator"; },
    repoInfo: async () => { calls.push("host-repo"); return { nameWithOwner: REPO, defaultBranch: "main", repositoryId: "fixture-stable-id" }; },
    branchExists: async () => true, refSha: async () => base, fileAtStrict: async () => null };
  let fingerprint = "fixture-artifact-v1", failure = null, time = Date.now();
  const account = { uid: process.getuid() + 1000, home: join(root, "worker-home"), groups: [1234] };
  // This seam supplies synthetic observations. Native qualification uses the
  // fixed executable, real account and kernel-denial probe in the package.
  const boundary = {
    specFor: (_ctx, worker) => {
      if (worker !== "plan-worker") throw Object.assign(new Error("Provision a dedicated worker account first."), { code: "PLAN_QUALIFICATION" });
      return { root: home, worktrees, worker, routes: _ctx.config.harness, path: "/usr/bin:/bin", fingerprint };
    },
    probe: async (_spec, { socket }) => {
      calls.push(socket ? "worker-socket-probe" : "worker-preflight");
      if (failure) throw Object.assign(new Error(failure), { code: "PLAN_QUALIFICATION" });
      if (socket) assert.equal(socket, planSocketPath(home));
      return structuredClone(account);
    },
    harnessCheck: async provider => { calls.push(`${provider}-version-sign-in`); return { ok: true }; },
    clock: { now: () => time },
  };
  const context = () => ({ home, config: readJson(configFile), state: makeState(home), log: silentLog, gh, host: gh, git: makeGit({ config: raw }), planInputs: { directory: checkout } });
  const setup = options => setupLocalPlans(context(), options, boundary);
  const service = async () => {
    const ctx = context();
    ctx.localPlans = makeLocalPlans(ctx, boundary);
    ctx.planOperatorForRequest = ctx.localPlans.operatorForRequest;
    ctx.planAuthority = ctx.localPlans.dispatchAuthority;
    const close = await ctx.localPlans.listen();
    return { ctx, close };
  };
  const installedCli = (...args) => exec(process.execPath, [cli, "plan", ...args], { cwd: checkout, env: { ...process.env, GALLIVANT_HOME: home }, timeout: 12_000 });
  const manifest = (name, tasks = ["initial", "left", "right", "final"]) => {
    for (const id of tasks) write(join(checkout, `docs/prds/${id}.md`), GOOD_PRD);
    const leaf = (id, indent) => `${indent}- id: ${id}\n${indent}  type: task\n${indent}  repository: repo\n${indent}  prd: docs/prds/${id}.md\n`;
    const file = `${name}.yaml`;
    write(join(checkout, file), `version: 1\nname: ${name}\nrepositories:\n  repo: { repository: ${REPO}, checkout: ., base: main }\nnodes:\n  - id: delivery\n    type: group\n    mode: sequence\n    children:\n${leaf(tasks[0], "      ")}      - id: fan\n        type: group\n        mode: parallel\n        file: ${name}-parallel.yaml\n${leaf(tasks[3], "      ")}`);
    write(join(checkout, `${name}-parallel.yaml`), `version: 1\nchildren:\n${leaf(tasks[1], "  ")}${leaf(tasks[2], "  ")}`);
    return file;
  };
  return { home, checkout, configFile, raw, calls, boundary, context, setup, service, installedCli, manifest, account,
    changeArtifact: value => { fingerprint = value; }, refuseProbe: value => { failure = value; }, expire: ms => { time += ms; } };
}

test("Linux checkout overlays restore the worker's effective POSIX ACL", {
  skip: process.platform !== "linux" || !existsSync("/usr/bin/setfacl") || !existsSync("/usr/bin/getfacl"),
}, async t => {
  const f = fixture(t);
  await f.setup({ worker: "plan-worker" });
  const { worktrees } = f.raw, checkout = join(worktrees, "acme", "widget", "overlay");
  mkdirSync(dirname(checkout), { recursive: true, mode: 0o755 });
  await grantPlanCheckout({ worktrees }, f.account, checkout);
  const git = makeGit({ worktreeBoundary: makeLocalPlans(f.context(), f.boundary).gitBoundary });
  const effective = rel => {
    const acl = execFileSync("/usr/bin/getfacl", ["-acn", "--", join(checkout, rel)], { encoding: "utf8", timeout: 4000 });
    const entry = acl.split("\n").find(line => line.startsWith(`user:${f.account.uid}:`));
    assert.ok(entry, `no worker ACL on ${rel}`);
    return entry.split("#effective:")[1]?.trim() ?? entry.split(":")[2].trim();
  };
  writeRepositoryText(checkout, "old/source.md", "before enrollment fix");
  assert.equal(effective("old"), "r-x");
  assert.equal(effective("old/source.md"), "r--");
  const options = git.overlayOptions(checkout);
  writeRepositoryText(checkout, "old/source.md", "restored", options);
  writeRepositoryText(checkout, "old/new/tool.sh", "#!/bin/sh\n", { ...options, mode: 0o755 });
  assert.equal(effective("old"), "rwx");
  assert.equal(effective("old/source.md"), "rw-");
  assert.equal(effective("old/new"), "rwx");
  assert.equal(effective("old/new/tool.sh"), "rwx");
  assert.equal(git.overlayOptions(f.home).grantAccess, undefined);
});

test("setup check does no writes and enrollment preserves the home, linear queue, credential and author ceilings", async t => {
  const f = fixture(t), ctx = f.context();
  const paths = ["legacy-first", "legacy-second"].map(name => join(f.checkout, `docs/prds/${name}.md`));
  for (const path of paths) write(path, GOOD_PRD);
  await queueChain(ctx, { name: "already-queued", paths });
  const registry = readFileSync(ctx.state.file), previous = readFileSync(f.configFile), files = readdirSync(f.home);
  const check = await f.setup({ check: true, worker: "plan-worker" });
  assert.deepEqual(check.host, ["github.com"]);
  assert.equal(check.worker.modelAccess, "unverified");
  assert.equal(check.approvalAccess, "unavailable");
  assert.equal(check.capacity.graph_authors, 0);
  assert.match(check.prerequisite, /enroll/);
  assert.deepEqual(readFileSync(f.configFile), previous);
  assert.deepEqual(readFileSync(ctx.state.file), registry);
  assert.deepEqual(readdirSync(f.home), files);
  const result = await f.setup({ worker: "plan-worker" });
  assert.equal(result.changed, true);
  assert.equal(result.reload, true);
  assert.equal(result.capacity.graph_authors, 1);
  assert.equal(result.capacity.graph_per_repository, 1);
  assert.deepEqual(readJson(f.configFile).dispatch_capacity, { authors: 1, per_repository: 3, preparations: 2, graph_authors: 1, graph_per_repository: 1 });
  assert.equal(readFileSync(f.raw.github_token_file, "utf8"), "fixture-secret");
  assert.deepEqual(readFileSync(ctx.state.file), registry);
  const enrolled = readFileSync(f.configFile);
  const repeat = await f.setup({});
  assert.equal(repeat.owner, result.owner);
  assert.equal(repeat.changed, false);
  assert.deepEqual(readFileSync(f.configFile), enrolled);
  assert.equal(existsSync(planSocketPath(f.home)), false);
});

test("CLI queue binds the nested YAML, expiry and durable receipt while the dashboard is closed", async t => {
  const f = fixture(t);
  assert.equal((await f.setup({ worker: "plan-worker" })).changed, true);
  const file = f.manifest("diamond");
  let server = await f.service();
  t.after(() => server.close());
  const preview = async () => JSON.parse((await f.installedCli("preview", file)).stdout);
  const view = await preview();
  assert.equal(view.graph.edges.length, 4);
  assert.equal(view.observation.canQueue, true);
  assert.equal(existsSync(server.ctx.state.file), false);
  await assert.rejects(f.installedCli("queue", file), /supply its exact approval digest/);
  f.expire(15 * 60_000);
  await assert.rejects(f.installedCli("queue", file, "--approve", view.approvalDigest), /changed/);
  const current = await preview();
  const prd = join(f.checkout, "docs/prds/left.md");
  writeFileSync(prd, `${GOOD_PRD}\nEdited after approval.\n`);
  await assert.rejects(f.installedCli("queue", file, "--approve", current.approvalDigest), /changed/);
  writeFileSync(prd, GOOD_PRD);
  const receipt = JSON.parse((await f.installedCli("queue", file, "--approve", current.approvalDigest)).stdout);
  assert.equal(receipt.planLink, `/plans?plan=${receipt.instanceId}`);
  assert.equal(receipt.status, "active");
  assert.equal(server.ctx.state.graphPlans().length, 1);
  const bytes = readFileSync(server.ctx.state.file);
  assert.throws(() => planOperator(server.ctx.state.file, server.ctx.planAuthority), { code: "PLAN_AUTHORITY" });
  const launch = readJson(f.configFile).local_plan.launch;
  assert.equal(planOperator(server.ctx.state.file, server.ctx.planAuthority, { dispatch: true }).isolation.launchDigest, launch);
  await server.close();
  server = await f.service();
  f.expire(15 * 60_000);
  const before = f.calls.filter(call => call === "host-repo").length;
  assert.deepEqual(JSON.parse((await f.installedCli("queue", "lost-source.yaml", "--approve", current.approvalDigest)).stdout), receipt);
  assert.deepEqual(readFileSync(server.ctx.state.file), bytes);
  assert.equal(f.calls.filter(call => call === "host-repo").length, before);
});

test("launch, grant and boundary drift stop admission while retaining the original approval", async t => {
  const f = fixture(t);
  await f.setup({ worker: "plan-worker" });
  const file = f.manifest("retained"), input = { file, options: { directory: f.checkout } };
  const { ctx, close } = await f.service(); t.after(close);
  const preview = await callLocalPlans(f.home, { op: "preview", ...input });
  const approve = preview.approvalDigest;
  const command = { op: "control", action: "queue", stage: "confirm", requestId: approve, approve, input };
  f.refuseProbe("Worker can reach protected coordinator state.");
  await assert.rejects(callLocalPlans(f.home, command), { code: "PLAN_QUALIFICATION" });
  assert.equal(existsSync(ctx.state.file), false);
  f.refuseProbe(null);
  const saved = await callLocalPlans(f.home, command);
  const old = readJson(f.configFile), before = readFileSync(ctx.state.file);
  f.changeArtifact("fixture-artifact-v2");
  await assert.rejects(ctx.localPlans.refresh(), /runtime changed/);
  await assert.rejects(callLocalPlans(f.home, command), { code: "PLAN_QUALIFICATION" });
  f.changeArtifact("fixture-artifact-v1");
  writeJsonAtomic(f.configFile, { ...old, repos: [OTHER] });
  await assert.rejects(ctx.localPlans.refresh(), { code: "PLAN_QUALIFICATION" });
  assert.deepEqual(readFileSync(ctx.state.file), before);
  const { local_plan: _enrollment, ...unmanaged } = old;
  writeJsonAtomic(f.configFile, unmanaged);
  const restarted = makeLocalPlans(f.context(), f.boundary);
  assert.throws(() => restarted.authorLaunch("codex", { plan: { instanceId: saved.instanceId } }, f.raw.harness.codex.bin, [], {}), { code: "PLAN_QUALIFICATION", dispatchNotSent: true });
  writeJsonAtomic(f.configFile, old);
  assert.deepEqual(await callLocalPlans(f.home, command), saved);
});

test("qualification changes during worker launch preparation refuse dispatch before spawn", async t => {
  const root = mkdtempSync(join(tmpdir(), "lp-launch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let qualified = true;
  const runner = makeRunner(root, { launch: async (cmd, args, { cwd, executionKind }) => {
    assert.equal(executionKind, "implementation");
    qualified = false;
    return { cmd, args, options: { cwd } };
  } });
  const service = makeExecution({ root, taskId: REPO + "/launch-guard", provider: "codex", runner });
  const operationId = "approved-start";
  const start = service.submit({ operationId, kind: "implementation", name: "fixture",
    spec: { cmd: process.execPath, args: ["-e", "process.exit(0)"], options: { cwd: root } },
    allowance: { remainingUsd: 1, reservedUsd: 0.1 } }, () => {
    if (!qualified) throw Object.assign(new Error("Qualification changed."), { code: "PLAN_QUALIFICATION" });
  });
  await assert.rejects(start, { code: "PLAN_QUALIFICATION", dispatchNotSent: true });
  const ledger = service.state();
  assert.equal(ledger.current, null);
  assert.deepEqual(ledger.operations, {});
  assert.equal(ledger.allowance, undefined);
  assert.equal(ledger.dispatchRefusals.length, 1);
  const [refusal] = ledger.dispatchRefusals;
  assert.equal(refusal.operationId, operationId);
  assert.equal(existsSync(runner.dirOf(refusal.runId)), false);
  assert.equal(existsSync(join(root, "latest-run")), false);
});

test("standalone and mounted trackers require a scoped session issued by the local service", async t => {
  const f = fixture(t);
  await f.setup({ worker: "plan-worker" });
  const service = await f.service(); t.after(service.close);
  const file = f.manifest("shared"), input = { file, options: { directory: f.checkout } };
  const { approvalDigest: approve } = await callLocalPlans(f.home, { op: "preview", ...input });
  const admission = await callLocalPlans(f.home, { op: "control", action: "queue", stage: "confirm", requestId: approve, approve, input });
  const pendingFile = f.manifest("pending-shared", ["prepare", "check", "build", "release"]);
  const preview = JSON.parse((await f.installedCli("preview", pendingFile)).stdout);
  const pending = JSON.parse((await f.installedCli("request", pendingFile, "--approve", preview.approvalDigest,
    "--request-id", preview.requestId)).stdout);
  assert.equal(pending.status, "pending");
  assert.equal(service.ctx.state.graphPlans().length, 1);
  const approvalCommand = { action: "queue", stage: "approve", requestId: pending.requestId, approve: pending.revision };
  await assert.rejects(callLocalPlans(f.home, { op: "control", ...approvalCommand }), { code: "PLAN_CONSENT" });
  await assert.rejects(f.installedCli("approve", pending.requestId, "--approve", pending.revision), error =>
    error.code === 1 && JSON.parse(error.stdout).approvalLink === pending.approvalLink);
  const ctx = f.context();
  ctx.localPlans = makeLocalPlans(ctx, f.boundary);
  ctx.planOperatorForRequest = ctx.localPlans.operatorForRequest;
  const mounted = mount(ctx, { base: "/work" });
  const server = createServer((req, res) => mounted.handle(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const standalone = await serve(ctx, { port: 0 });
  t.after(async () => {
    for (const s of [standalone, server]) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
  });
  const session = async repo => {
    const { stdout } = await f.installedCli("session", "--repo", repo);
    const report = JSON.parse(stdout);
    assert.deepEqual(report.repositories, [repo]);
    assert.equal(stdout, `${JSON.stringify(report)}\n`);
    return report.session;
  };
  const valid = await session(REPO), outside = await session(OTHER);
  let receipt;
  for (const [instance, prefix] of [[server, "/work"], [standalone, ""]]) {
    const origin = `http://127.0.0.1:${instance.address().port}`, url = origin + prefix;
    const auth = session => ({ authorization: `Bearer ${session}` });
    const post = (command, headers) => fetch(`${url}/api/plan/control`, { method: "POST", headers: { origin, "content-type": "application/json", ...headers }, body: JSON.stringify(command) });
    const command = { plan: admission.instanceId, action: prefix ? "hold" : "unhold", stage: "review", requestId: prefix ? "from-mount" : "from-standalone" };
    assert.equal((await post(command, { "x-gallivant-token": "copied", "x-plan-qualified": "true" })).status, 403);
    assert.equal((await fetch(`${url}/api/plan?plan=${admission.instanceId}`, { headers: auth(outside) })).status, 403);
    const challenge = await fetch(`${url}/plan-session`);
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("www-authenticate"), /^Basic realm=/);
    const headers = { authorization: `Basic ${Buffer.from(`operator:${valid}`).toString("base64")}` };
    const signIn = await fetch(`${url}/plan-session?approval=${pending.requestId}`, { redirect: "manual", headers });
    assert.equal(signIn.status, 303);
    assert.equal(signIn.headers.get("set-cookie"), null);
    assert.equal(signIn.headers.get("location"), prefix + pending.approvalLink);
    const page = await (await fetch(`${url}/plans?plan=${admission.instanceId}`, { headers })).text();
    headers["x-gallivant-token"] = page.match(/data-token="([a-f0-9]+)"/)?.[1];
    assert.ok(headers["x-gallivant-token"], prefix);
    const review = await post(command, headers);
    assert.equal(review.status, 200, await review.clone().text());
    const confirm = await post({ ...command, stage: "confirm", approve: (await review.json()).revision }, headers);
    assert.equal(confirm.status, 200, await confirm.clone().text());
    assert.equal((await confirm.json()).status, "applied");
    const accepted = await post(approvalCommand, headers);
    assert.equal(accepted.status, 200, await accepted.clone().text());
    const result = await accepted.json();
    receipt ??= result.receipt;
    assert.deepEqual(result.receipt, receipt);
    assert.equal(result.planLink, `${prefix}/plans?plan=${receipt.instanceId}`);
  }
  assert.deepEqual(JSON.parse((await f.installedCli("approve", pending.requestId, "--approve", pending.revision)).stdout).receipt, receipt);
  f.expire(31 * 60_000);
  const expired = await fetch(`http://127.0.0.1:${standalone.address().port}/api/plan?plan=${admission.instanceId}`, { headers: { authorization: `Bearer ${valid}` } });
  assert.equal(expired.status, 403);
});

test("the launcher uses the configured route and retains only delegated Git and package credentials", () => {
  const launch = localWorkerCommand({ path: "/cli/bin:/usr/bin:/bin" }, { uid: 833 }, "/cli/bin/exact codex", ["exec", "resume", "saved-thread", "--json"], {
    cwd: "/work/acme/widget/approved", env: { GALLIVANT_HOME: "/private", CODEX_HOME: "/operator/.codex", SSH_AUTH_SOCK: "/operator/agent.sock",
      OPENAI_API_KEY: "operator-only", GH_TOKEN: "bound-repository", NODE_AUTH_TOKEN: "bound-package", GIT_CONFIG_COUNT: "0" },
  });
  assert.equal(launch.cmd, "/usr/bin/sudo");
  assert.deepEqual(launch.args.slice(0, 4), ["-n", "-H", "-u", "#833"]);
  assert.deepEqual(launch.args.slice(5), ["--", "/cli/bin/exact codex", "exec", "resume", "saved-thread", "--json"]);
  assert.deepEqual(launch.options.env, { GH_TOKEN: "bound-repository", NODE_AUTH_TOKEN: "bound-package", GIT_CONFIG_COUNT: "0", PATH: "/cli/bin:/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
});

test("enrolling Claude keeps the operator and existing state and uses the pinned worker route", async t => {
  const f = fixture(t);
  const paths = ["pending-first", "pending-second"].map(name => join(f.checkout, `docs/prds/${name}.md`));
  for (const path of paths) write(path, GOOD_PRD);
  await queueChain(f.context(), { name: "keep-progress", paths });
  await f.setup({ worker: "plan-worker" });
  const previous = readJson(f.configFile), registry = readFileSync(f.context().state.file);
  const claude = { bin: "/installed/claude", settings: "/installed/claude-policy.json", model: "claude-fable-5-1[1m]" };
  writeJsonAtomic(f.configFile, { ...previous, harness: { ...previous.harness, claude } });
  f.changeArtifact("fixture-artifact-with-claude");
  const setup = await f.setup({});
  assert.equal(setup.changed, true);
  assert.equal(setup.worker.executables.claude, claude.bin);
  assert.ok(f.calls.includes("claude-version-sign-in"));
  const config = readJson(f.configFile);
  assert.equal(config.local_plan.owner, previous.local_plan.owner);
  assert.equal(config.local_plan.key, previous.local_plan.key);
  assert.deepEqual(config.local_plan.account, previous.local_plan.account);
  assert.deepEqual(readFileSync(f.context().state.file), registry);

  const checkout = join(f.raw.worktrees, "acme", "widget", "approved");
  mkdirSync(checkout, { recursive: true });
  const local = makeLocalPlans(f.context(), f.boundary);
  const input = { cwd: checkout, env: { GH_TOKEN: "repo-credential", ANTHROPIC_API_KEY: "operator-only",
    CLAUDE_CODE_OAUTH_TOKEN: "operator-only", APORT_CLAUDE_CODE_CONFIG_DIR: "/operator/private", CP_RUN_DIR: "/operator/run" } };
  for (const mode of ["start", "resume"]) {
    const session = "50c861da-6bcb-4570-bb2a-09d6ba019a2f";
    const run = buildRun({ harness: "claude", config, mode, session, prompt: "Perform the approved work.", cwd: checkout });
    const launch = await local.authorLaunch("claude", null, run.cmd, run.args, input);
    assert.equal(launch.cmd, "/usr/bin/sudo");
    assert.deepEqual(launch.args.slice(6, 9), [claude.bin, mode === "start" ? "--session-id" : "--resume", session]);
    assert.equal(run.args[run.args.indexOf("--settings") + 1], claude.settings);
    assert.equal(run.args[run.args.indexOf("--model") + 1], claude.model);
    assert.equal(run.runtimeSettings, undefined);
    assert.deepEqual(launch.args.slice(-6, -1), ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
    assert.equal(launch.options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(launch.options.env.GH_TOKEN, "repo-credential");
    for (const name of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "APORT_CLAUDE_CODE_CONFIG_DIR", "CP_RUN_DIR"]) {
      assert.equal(launch.options.env[name], undefined, name);
    }
  }
  assert.throws(() => local.checkHarnessOptions("claude").launcher("/different/claude", ["auth", "status"]), /unavailable/);
  assert.equal(local.checkHarnessOptions("claude").minimumVersion, "2.1.285");
  await assert.rejects(local.authorLaunch("claude", null, claude.bin, ["--settings", "/different/policy", "Example"], input),
    { code: "PLAN_QUALIFICATION", dispatchNotSent: true });
});
