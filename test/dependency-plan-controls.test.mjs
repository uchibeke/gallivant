import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { mount, serve } from "../lib/commands/serve.mjs";
import { resumeNetworkRecovery } from "../lib/commands/resume.mjs";
import { planControl } from "../lib/dependency_plan_admission.mjs";
import { tickDependencyPlans } from "../lib/dependency_plan_dispatch.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { canonicalPath, readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { bindPlanOperator, recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { makeRecoverySchedule } from "../lib/recovery_schedule.mjs";
import { recoveryDrainStatus } from "../lib/recovery_rollout.mjs";
import { PLAN_RUNTIME_FORMAT, backupRuntimeState, checkRuntimeState, migrateRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
import { idSlug, makeState, STATES } from "../lib/state.mjs";
import { CORE_VERSION } from "../lib/task_delivery_contract.mjs";
import { makeTick } from "../lib/tick.mjs";
import { cleanupMergedWorkspace } from "../lib/workspace_cleanup.mjs";
import { CONFIG, GOOD_PRD, codexLines, fakeCredential, fakeGh, fakeIdentity, fakeNotify, fakeRunner, harnessBin, makeClock, prFixture, silentLog, tempHome } from "./helpers.mjs";

const REPO = "acme/widget", HEAD = "b".repeat(40), BASE = "a".repeat(40);
const task = (id, needs = []) => ({ id, type: "task", repository: "demo", prd: `docs/prds/${id}.md`, needs });
const group = (id, children) => ({ id, type: "group", mode: "parallel", children });
const anchor = (plan, node) => ({ id: "external", type: "anchor", target: { plan, node } });
const taskId = id => `${REPO}/${id}`;

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

async function fixture(t, { mounted = false, sourceIsWorktree = false } = {}) {
  const home = canonicalPath(tempHome()), worktrees = canonicalPath(tempHome()), clock = makeClock();
  const root = sourceIsWorktree ? join(worktrees, REPO, "old-workspace") : canonicalPath(tempHome());
  mkdirSync(root, { recursive: true });
  const config = { ...structuredClone(CONFIG), home, worktrees, poll_seconds: 1, harness: { codex: { bin: harnessBin(home) } },
    deliverable: { ...CONFIG.deliverable, evaluator: "local" },
    dispatch_capacity: { authors: 8, per_repository: 8, per_plan: 8, preparations: 8, graph_authors: 8, graph_per_repository: 8 } };
  const prs = new Map(), merged = new Set(), calls = [], runners = new Map(), diagnostics = [];
  const repository = { id: "immutable-repository", base: BASE };
  const runnerFor = id => {
    if (!runners.has(id)) runners.set(id, fakeRunner(clock));
    return runners.get(id);
  };
  const read = (kind, value) => {
    assert.equal(existsSync(join(home, "state.json.lock")), false, "host and Git reads run outside the registry lock");
    calls.push(kind);
    return value;
  };
  const ctx = { home, config, clock, log: { ...silentLog, warn: line => diagnostics.push(line) }, ownLogin: "me", notify: fakeNotify(),
    state: makeState(home), credential: fakeCredential(), identity: fakeIdentity(), runnerFor,
    planInputs: { directory: root },
    readPrd: id => {
      const path = join(home, "prds", `${idSlug(id)}.md`);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    writePrd: (id, text) => put(join(home, "prds", `${idSlug(id)}.md`), text),
    gh: { ...fakeGh(), repoInfo: async () => read("repo", { nameWithOwner: REPO, repositoryId: repository.id, defaultBranch: "main" }),
      repositoryIdentity: async () => read("repository-id", { key: REPO, id: repository.id }), branchExists: async () => read("branch", true),
      refSha: async () => read("base", repository.base), fileAtStrict: async () => read("base-file", null),
      prView: async (_repo, pr) => read("pull-request", prs.get(pr)), containsCommit: async (_repo, _base, sha) => read("ancestry", merged.has(sha)) },
    git: { exists: existsSync, planCheckout: async () => read("checkout", { root, repository: REPO }),
      create: async ({ prdId }) => {
        const dir = join(worktrees, REPO, prdId);
        assert.equal(existsSync(dir), false, "the original checkout must not be cloned twice");
        mkdirSync(join(dir, ".git"), { recursive: true });
        return read(`clone-${prdId}`, dir);
      }, head: async () => read("head", BASE), fileAt: async () => null, containsCommit: async (_path, sha) => merged.has(sha),
      originOf: async () => `https://github.com/${REPO}.git`, cleanupProof: async path => ({ head: path === root ? HEAD : BASE,
        branch: `work/${path.split("/").at(-1)}`, dirty: false, unpublished: false, stash: false, busy: false }) },
  };
  ctx.executionFor = id => makeExecution({ root: join(home, "runs", idSlug(id)), taskId: id, provider: "codex", clock, runner: runnerFor(id) });
  const actors = new Map();
  function identity(tenant) {
    const settings = { tenant, link: false, denied: new Set(), allowedGroup: null, grants: [], epoch: 1 };
    actors.set(tenant, { settings, handle: bindPlanOperator(ctx.state.file, () => ({ tenant, principal: tenant,
      isolation: { registry: ctx.state.file, qualified: true, workerExcluded: true, launchDigest: "a".repeat(64), expiresAt: Date.now() + 30000 },
      grant: ({ action, scope }) => {
        settings.grants.push({ action, scope });
        if (settings.denied.has(action) || settings.allowedGroup && action === "hold" && scope.group !== settings.allowedGroup) return null;
        if (scope.tenant !== tenant && (!settings.link || !["link", "observe", "read"].includes(action))) return null;
        if (action === "cross-company-link" && !settings.link) return null;
        return `${action.replaceAll("/", "-")}-${settings.epoch}`;
      } })) });
    return actors.get(tenant);
  }
  const owner = identity("operator"), outside = identity("other-tenant");
  ctx.planAuthority = owner.handle;
  ctx.planOperatorForRequest = req => actors.get(req.headers.authorization)?.handle;
  const prefix = mounted ? "/delivery" : "";
  let server;
  if (mounted) {
    const tracker = mount(ctx, { base: prefix });
    server = createServer(tracker.handle);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } else server = await serve(ctx, { port: 0 });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (path, actor = "operator") => fetch(`${url}${prefix}${path}`, { headers: { authorization: actor }, signal: AbortSignal.timeout(5000) });
  const token = (await (await get("/chains")).text()).match(/data-token="([a-f0-9]{64})"/)[1];
  const post = async (payload, { actor = "operator", headers = {}, route = "/api/plan/control" } = {}) => {
    const response = await fetch(`${url}${prefix}${route}`, { method: "POST", headers: { authorization: actor,
      origin: url, "content-type": "application/json", "x-gallivant-token": token, ...headers },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const badHost = () => new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${prefix}/api/plan/control`, { method: "POST", headers: { host: "external.invalid",
      origin: "http://external.invalid", "x-gallivant-token": token, "content-type": "application/json" }, timeout: 5000 }, response => {
      response.resume(); resolve(response.statusCode);
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Host fixture timed out")));
    req.end("{}");
  });
  let sequence = 0;
  const review = async (input, options) => {
    const command = { requestId: `request-${++sequence}`, ...input };
    const response = await post({ ...command, stage: "review" }, options);
    assert.equal(response.status, 200, JSON.stringify([response.body, diagnostics]));
    return { review: response.body, command: { ...command, stage: "confirm", approve: response.body.revision } };
  };
  const confirm = async (command, options) => {
    const response = await post(command, options);
    assert.equal(response.status, 200, JSON.stringify([response.body, diagnostics]));
    return response.body;
  };
  const apply = async (command, options) => confirm((await review(command, options)).command, options);
  const brief = (id, extra = "") => put(join(root, task(id).prd), GOOD_PRD + extra);
  const manifest = (name, nodes, file = `${name}.json`) => {
    const write = list => list.forEach(node => {
      if (node.type === "group") write(node.children);
      if (node.type === "task" && !existsSync(join(root, node.prd))) brief(node.id);
    });
    write(nodes);
    put(join(root, file), JSON.stringify({ version: 1, name, repositories: { demo: { repository: REPO, checkout: ".", base: "main" } }, nodes }));
    return file;
  };
  const queue = (name, nodes, options) => apply({ action: "queue", file: manifest(name, nodes) }, options);
  const inspect = async (plan, actor) => {
    const response = await get(`/api/plan?plan=${encodeURIComponent(plan)}`, actor);
    assert.equal(response.status, 200);
    return response.json();
  };
  let schedule = makeRecoverySchedule({ home, clock });
  const restart = () => { ctx.state = makeState(home); schedule = makeRecoverySchedule({ home, clock }); };
  const tick = async () => {
    const cycle = schedule.begin();
    try { return await tickDependencyPlans(ctx, cycle); }
    finally { cycle.finish(); }
  };
  const advance = async () => { clock.advance(1); return tick(); };
  const entry = id => ctx.state.get(taskId(id));
  let nextPull = 0;
  const integrate = async (id, state = "MERGED") => {
    const previous = entry(id), number = ++nextPull, url = `https://github.com/${REPO}/pull/${number}`;
    const runner = ctx.executionFor(taskId(id));
    runnerFor(taskId(id)).finish(codexLines({ thread: previous.session }), { exit: 0 });
    await runner.reconcile();
    await runner.collect();
    const execution = runner.current().execution;
    const sha = number.toString(16).padStart(40, "0"), at = new Date(clock.now()).toISOString();
    const terminal = { state, repository: REPO, pr: number, head: HEAD, base: "main", mergeCommit: sha, mergedAt: at };
    prs.set(number, prFixture({ state, number, url, headRefName: previous.branch, headRefOid: HEAD, mergeCommit: { oid: sha }, mergedAt: at }));
    if (state === "MERGED") merged.add(sha);
    ctx.state.update(taskId(id), { pr: number, url, state: STATES.done, execution, last: { ...previous.last, exit: 0 },
      workspace_cleanup: { status: "retained", head: HEAD, pr: number },
      completionEvidence: { terminal, integration: { ...terminal, qualified: state === "MERGED" } } });
    await makeTick(ctx).tickEntry(taskId(id), entry(id));
    return sha;
  };
  const node = async (name, id) => (await inspect(name)).graph.nodes.find(node => node.id === id);
  const started = id => runnerFor(taskId(id)).started.length;
  return { home, root, config, ctx, calls, clock, owner, outside, repository, get, post, badHost, review, confirm, apply, brief, manifest,
    queue, inspect, restart, tick, advance, entry, node, integrate, started };
}

test("mounted HTTP controls enforce transport, qualified request authority, exact review and durable replay", async t => {
  const w = await fixture(t, { mounted: true });
  const file = w.manifest("transport", [group("branch", [task("one")]), task("two")]);
  const request = { action: "queue", stage: "review", file, requestId: "queue-once" };
  assert.equal(await w.badHost(), 403);
  assert.equal((await w.post(request, { headers: { origin: "https://external.invalid" } })).status, 403);
  assert.equal((await w.post(request, { headers: { "x-gallivant-token": "forged" } })).status, 403);
  assert.equal((await w.post(request, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await w.post({ ...request, file: "a".repeat(33000) })).status, 413);
  assert.equal((await w.post(request, { actor: "unauthenticated" })).status, 403);
  assert.equal((await w.post({ ...request, input: { file } })).status, 400);
  assert.equal(w.calls.length, 0);
  const queued = await w.review({ action: "queue", file, requestId: "queue-once" });
  const replies = await Promise.all([w.confirm(queued.command), w.confirm(queued.command)]);
  assert.deepEqual(replies[0], replies[1]);
  assert.equal(w.ctx.state.load().plans.instances.length, 1);
  const beforeReads = w.calls.length, before = readFileSync(w.ctx.state.file);
  assert.equal((await w.get("/chains")).status, 200);
  assert.equal((await w.inspect("transport")).instanceId, replies[0].instanceId);
  assert.equal((await w.get("/api/plan?plan=transport", "unauthenticated")).status, 403);
  assert.equal(w.calls.length, beforeReads);
  assert.deepEqual(readFileSync(w.ctx.state.file), before);

  w.owner.settings.allowedGroup = "branch";
  assert.equal((await w.post({ action: "hold", plan: "transport", stage: "review", requestId: "outside-scope" })).status, 403);
  const { command } = await w.review({ action: "hold", plan: "transport", group: "branch" });
  const duplicate = await Promise.all([w.confirm(command), w.confirm(command)]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  await w.apply({ action: "unhold", plan: "transport", group: "branch" });
  w.restart();
  assert.deepEqual(await w.confirm(command), duplicate[0]);
  assert.equal((await w.post({ ...command, action: "unhold" })).body.code, "PLAN_CONFLICT");
  assert.equal((await w.inspect("transport")).controlGeneration, 2);
  w.owner.settings.denied.add("hold");
  assert.equal((await w.post(command)).status, 403);
  assert.equal((await w.post(command, { actor: "other-tenant" })).status, 403);
  assert.deepEqual(await w.confirm(queued.command), replies[0]);
  assert.throws(() => w.ctx.state.controlPlan(command, null, recoveryAdminIntent(w.ctx.state.file, "plan/hold", command.requestId, command.approve)), { code: "PLAN_AUTHORITY" });
  await assert.rejects(planControl({ ...w.ctx, planAuthority: {} }, command), { code: "PLAN_AUTHORITY" });
});

test("group generation fences a clone while a sibling starts; reviewed retry keeps the original launch", async t => {
  const w = await fixture(t);
  const pending = Promise.withResolvers(), clone = w.ctx.git.create;
  const reached = new Map(["slow", "sibling"].map(id => [id, Promise.withResolvers()]));
  w.ctx.git.create = async spec => {
    if (reached.has(spec.prdId)) { reached.get(spec.prdId).resolve(); await pending.promise; }
    return clone(spec);
  };
  const queue = await w.queue("scoped", [group("branch", [task("slow")]), task("sibling"), task("join", ["branch", "sibling"])]);
  const starting = w.tick();
  let original;
  try {
    await Promise.race([Promise.all([...reached.values()].map(item => item.promise)),
      starting.then(() => assert.fail("both starts must enter preparation"))]);
    original = w.ctx.state.startClaim(taskId("slow"));
    const { review, command } = await w.review({ action: "hold", plan: "scoped", group: "branch" });
    assert.deepEqual(review.scope.future, ["branch/slow"]);
    await w.confirm(command);
    assert.equal((await w.node("scoped", "branch/slow")).status, "held");
    await w.apply({ action: "unhold", plan: "scoped", group: "branch" });
  } finally { pending.resolve(); }
  await starting;
  const fenced = w.ctx.state.startClaim(taskId("slow"));
  assert.equal(fenced.token, original.token);
  assert.equal(fenced.unsent, true);
  assert.equal(w.started("slow"), 0);
  assert.equal(w.started("sibling"), 1);
  assert.equal(w.started("join"), 0);
  const failure = (await w.node("scoped", "branch/slow")).firstFailure;
  assert.ok(failure);
  await w.advance();
  assert.equal(w.started("slow"), 0, "automatic recovery cannot create a retry request");
  const { review, command } = await w.review({ action: "retry", plan: "scoped", node: "branch/slow" });
  assert.equal(review.scope.originalStart, true);
  const applied = await w.confirm(command);
  w.restart(); await w.advance();
  assert.equal(w.entry("slow").start_token, original.token);
  assert.equal(w.entry("slow").session, fenced.clone.proof.session);
  assert.equal(w.entry("slow").plan.instanceId, queue.instanceId);
  assert.equal(w.entry("slow").iteration, 0);
  assert.equal(w.started("slow"), 1);
  assert.deepEqual(Object.keys(w.ctx.executionFor(taskId("slow")).state().operations), [original.token]);
  assert.deepEqual(await w.confirm(command), applied);
  assert.equal((await w.node("scoped", "branch/slow")).firstFailure, failure);
  await Promise.all([w.integrate("slow"), w.integrate("sibling")]);
  await Promise.all([w.advance(), w.tick()]);
  await Promise.all([w.advance(), w.tick()]);
  assert.equal(w.started("join"), 1, "both sibling receipts survive concurrent transitions");
});

test("future cancellation leaves admitted task controls and integration intact and blocks the dependent closure", async t => {
  const w = await fixture(t);
  await w.queue("cancel-scope", [group("branch", [task("accepted"), task("future", ["accepted"])]),
    task("join", ["branch"]), task("tail", ["join"]), task("outside")]);
  await w.queue("watch-accepted", [anchor("cancel-scope", "branch/accepted"), task("watch-merge", ["external"])]);
  await w.queue("watch-future", [anchor("cancel-scope", "branch/future"), task("watch-cancel", ["external"])]);
  await w.tick();
  const original = w.entry("accepted");
  const { review, command } = await w.review({ action: "cancel", plan: "cancel-scope", group: "branch" });
  assert.deepEqual(review.scope.admitted, ["branch/accepted"]);
  assert.deepEqual(review.scope.future, ["branch/future"]);
  await w.confirm(command);
  assert.deepEqual(w.entry("accepted"), original);
  await w.integrate("accepted");
  await w.advance(); await w.advance();
  assert.equal(w.started("outside"), 1);
  assert.equal(w.started("watch-merge"), 1);
  for (const id of ["future", "join", "tail", "watch-cancel"]) assert.equal(w.started(id), 0);
  assert.equal((await w.node("cancel-scope", "branch/accepted")).status, "integrated");
  assert.equal((await w.node("watch-future", "external")).observed[0].status, "cancelled");
  assert.deepEqual((await w.node("cancel-scope", "tail")).prerequisites, [{ id: "join", status: "blocked" }]);
  assert.equal((await w.post({ action: "unhold", plan: "cancel-scope", group: "branch", stage: "review", requestId: "un-cancel" })).status, 409);
  const outside = w.entry("outside");
  assert.equal((await w.post({ action: "cancel", requestId: "cancel-task" }, {
    route: `/api/run/control?id=${encodeURIComponent(taskId("outside"))}`,
  })).status, 202);
  assert.equal(w.entry("outside").control.id, "cancel-task");
  assert.equal(w.entry("outside").session, outside.session);
});

test("protected attach requires both tenant scopes and current linking rights without producer controls", async t => {
  const w = await fixture(t);
  await w.queue("private-producer", [task("private-tail")], { actor: "other-tenant" });
  await w.queue("own-consumer", [task("consumer")]);
  const file = w.manifest("own-consumer", [anchor("private-producer", "private-tail"), task("consumer", ["external"])], "attach.json");
  const input = { action: "attach", plan: "own-consumer", file, requestId: "tenant-link" };
  const denied = await w.post({ ...input, stage: "review" });
  assert.equal(denied.status, 403);
  assert.doesNotMatch(JSON.stringify(denied.body), /private-producer|private-tail/);
  w.owner.settings.link = true;
  const { command } = await w.review(input);
  w.owner.settings.link = false;
  assert.equal((await w.post(command)).status, 403);
  assert.equal((await w.inspect("own-consumer")).revision, 1);
  w.owner.settings.link = true;
  await w.confirm(command);
  const consumer = await w.inspect("own-consumer");
  assert.equal(consumer.revision, 2);
  assert.equal(consumer.graph.nodes[0].frozen[0].id, "private-tail");
  assert.equal((await w.post({ action: "cancel", plan: consumer.graph.nodes[0].producer.instanceId,
    stage: "review", requestId: "wrong-tenant" })).status, 403);
  w.ctx.planAuthority = w.outside.handle;
  await w.tick();
  assert.equal(w.started("private-tail"), 1);
  assert.equal((await w.post({ action: "cancel", requestId: "wrong-task" }, {
    route: `/api/run/control?id=${encodeURIComponent(taskId("private-tail"))}`,
  })).status, 403);
  assert.equal(w.entry("private-tail").control, undefined);
  w.owner.settings.link = false;
  assert.deepEqual((await w.inspect("own-consumer")).graph.nodes[0], { id: "external", type: "anchor", status: "producer-unavailable" });
});

test("reviewed edits report the exact closure and preserve active and frozen approval contracts", async t => {
  const w = await fixture(t);
  const nodes = [task("active"), task("future", ["active"]), task("join", ["future"])];
  const queue = await w.queue("editable", nodes);
  await w.tick();
  const original = w.entry("active"), allowance = w.ctx.state.graphAuthorAllowance(taskId("active"));
  const file = w.manifest("editable", nodes, "candidate.json");
  w.brief("future", "\nKeep the second milestone focused.\n");
  const change = { action: "edit", plan: "editable", file };
  let { review, command } = await w.review(change);
  assert.deepEqual(review.scope.changes.map(item => item.id), ["future", "join"]);
  assert.ok(review.scope.changes.every(item => item.before !== item.after));
  assert.equal(review.scope.approval.before, queue.approvalDigest);
  assert.equal(review.scope.graph.before, review.scope.graph.after);
  w.brief("future", "\nThe approved input will instead use this sentence.\n");
  assert.equal((await w.post(command)).body.code, "PLAN_STALE");
  ({ command } = await w.review(change));
  w.repository.id = "replaced-host-repository";
  assert.equal((await w.post(command)).body.code, "PLAN_STALE");
  w.repository.id = "immutable-repository";
  const budget = w.ctx.config.max_budget_usd;
  w.ctx.config.max_budget_usd = budget + 1;
  assert.equal((await w.post(command)).body.code, "PLAN_STALE");
  w.ctx.config.max_budget_usd = budget;
  const accepted = await w.confirm(command);
  assert.equal(accepted.instanceId, queue.instanceId);
  assert.equal(accepted.approvalRevision, 2);
  assert.deepEqual(w.entry("active"), original);
  assert.deepEqual(w.ctx.state.graphAuthorAllowance(taskId("active")), allowance);
  assert.deepEqual(await w.confirm(command), accepted);

  w.brief("active", "\nAttempt to edit active work.\n");
  assert.equal((await w.post({ ...change, stage: "review", requestId: "change-active" })).body.code, "PLAN_CONTROL");
  w.brief("active");
  await w.queue("frozen-consumer", [anchor("editable", "future"), task("frozen-child", ["external"])]);
  w.brief("future", "\nAttempt to change the frozen producer.\n");
  const frozen = await w.post({ ...change, stage: "review", requestId: "change-frozen" });
  assert.equal(frozen.body.code, "PLAN_CONTROL");
  assert.match(frozen.body.error, /frozen node/);
  assert.equal((await w.inspect("editable")).revision, 2);
});

test("cause-cleared task recovery preserves the approved snapshot, session and turn budget", async t => {
  const w = await fixture(t), id = taskId("resume"), node = task("resume");
  const plan = await w.queue("same-task", [node]);
  await w.tick();
  const original = w.entry("resume"), runner = w.ctx.executionFor(id);
  const session = original.session ?? "22222222-2222-4222-8222-222222222222";
  w.ctx.runnerFor(id).finish(codexLines({ thread: session }), { exit: 0 });
  await runner.collect();
  w.ctx.state.update(id, { state: STATES.needsHuman, reason: "provider-network", session, execution: runner.current().execution,
    last: { ...original.last, exit: 0 }, network_retry: { code: "ECONNRESET", phase: "launching",
      run: original.last.run, attempts: 1, first_at: new Date(w.clock.now()).toISOString() } });
  await w.advance();
  const failure = (await w.node("same-task", "resume")).firstFailure;
  const saved = w.ctx.readPrd(id);
  w.brief("resume", "\n");
  w.ctx.git.dirty = async () => ({ modified: 1, untracked: 0 });
  const work = await resumeNetworkRecovery(w.ctx, { handle: id });
  assert.ok(work.run);
  assert.equal(w.ctx.readPrd(id), saved);
  assert.equal(w.entry("resume").start_token, original.start_token);
  assert.equal(w.entry("resume").session, session);
  assert.equal(w.entry("resume").iteration, original.iteration);
  assert.equal(w.entry("resume").network_retry.attempts, 1);
  await w.advance();
  const observed = await w.node("same-task", "resume");
  assert.equal(observed.status, "started");
  assert.equal(observed.firstFailure, failure);
  assert.equal(observed.taskId, id);
  assert.equal((await w.inspect("same-task")).instanceId, plan.instanceId);
  assert.equal(Object.keys(w.ctx.state.load().plans.controls ?? {}).length, 0);
});

test("opposing reviewed attachments cannot add a cycle or overwrite an intervening anchor", async t => {
  const w = await fixture(t);
  await w.queue("first", [task("one")]);
  await w.queue("second", [task("two")]);
  const edit = (plan, producer, node, other) => ({ action: "attach", plan,
    file: w.manifest(plan, [anchor(producer, other), task(node, ["external"])], `${plan}-attach.json`) });
  const first = await w.review(edit("first", "second", "one", "two"));
  const second = await w.review(edit("second", "first", "two", "one"));
  const results = await Promise.all([w.post(first.command), w.post(second.command)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(results.find(result => result.status === 409).body.code, "PLAN_STALE");
  const saved = w.ctx.state.load().plans;
  assert.equal(saved.controls.length, 1);
  assert.equal(saved.instances.flatMap(plan => plan.approval.bindings.anchors).length, 1);
});

test("disable and cancel keep an unknown launch owned until accepted collection and closeout", async t => {
  const w = await fixture(t), id = taskId("lost"), raw = w.ctx.runnerFor(id), spawn = raw.start, current = raw.current;
  let hidden = true;
  raw.current = () => hidden ? null : current();
  raw.start = (...args) => {
    spawn(...args);
    raw.started.at(-1).id = args[3].runId;
    throw new Error("fixture lost the exact saved launch acknowledgement");
  };
  const queued = await w.queue("unknown", [task("lost"), task("later", ["lost"])]);
  await w.tick();
  const original = w.entry("lost"), token = original.start_token;
  const { command } = await w.review({ action: "hold", plan: "unknown" });
  w.owner.settings.epoch++;
  assert.equal((await w.post(command)).body.code, "PLAN_STALE");
  w.owner.settings.epoch--;
  w.config.dispatch_capacity.graph_authors = 0;
  const retry = await w.post({ action: "retry", plan: "unknown", node: "lost", stage: "review", requestId: "unsafe-retry" });
  assert.equal(retry.status, 409);
  const cancel = await w.apply({ action: "cancel", plan: "unknown" });
  w.restart(); await w.advance();
  assert.equal(w.ctx.state.load().dispatch.authors[id].operation, token);
  assert.deepEqual(Object.keys(w.ctx.executionFor(id).state().operations), [token]);
  assert.equal(w.ctx.executionFor(id).state().operations[token].acceptance, "unknown");
  assert.equal(recoveryDrainStatus(w.ctx.state).drained, false);
  hidden = false;
  await makeTick(w.ctx).tickEntry(id, w.entry("lost"));
  assert.equal(w.entry("lost").initial_dispatch, null);
  assert.equal(w.entry("lost").start_token, token);
  const sha = await w.integrate("lost");
  await w.advance();
  assert.equal(w.ctx.state.graphPlan(queued.instanceId).runtime.nodes.lost.receipt.sha, sha);
  assert.equal(w.started("lost"), 1);
  assert.equal(w.started("later"), 0);
  assert.equal(recoveryDrainStatus(w.ctx.state).drained, true);
  assert.equal(cancel.status, "applied");
  const legacy = { name: "legacy", repo: REPO, base: "main", status: "done", index: 1,
    created_at: new Date(w.clock.now()).toISOString(),
    steps: [{ id: taskId("legacy-child"), relPath: task("legacy-child").prd }] };
  w.ctx.state.createChain(legacy);
  const response = await w.get(`/chains?chain=legacy&milestone=${encodeURIComponent(taskId("legacy-child"))}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Selected milestone 1 \/ 1<\/p><h3 id="milestone-title">legacy-child/);
});

test("cancellation settles a registered placeholder only after its owner proves no submission", async t => {
  const w = await fixture(t), id = taskId("placeholder");
  const reached = Promise.withResolvers(), release = Promise.withResolvers(), head = w.ctx.git.head;
  w.ctx.git.head = async path => {
    if (w.entry("placeholder")?.initial_dispatch?.status === "unsubmitted") {
      reached.resolve();
      await release.promise;
    }
    return head(path);
  };
  const queued = await w.queue("cancel-before-submit", [task("placeholder")]);
  const launching = w.tick();
  let token;
  try {
    await Promise.race([reached.promise, launching.then(() => assert.fail("the start never registered"))]);
    token = w.entry("placeholder").start_token;
    const { review, command } = await w.review({ action: "cancel", plan: "cancel-before-submit" });
    assert.deepEqual(review.scope.future, ["placeholder"]);
    await w.confirm(command);
    assert.equal(recoveryDrainStatus(w.ctx.state).drained, false);
  } finally { release.resolve(); }
  await launching;
  assert.equal(w.entry("placeholder").start_token, token);
  assert.equal(w.entry("placeholder").reason, "cancelled");
  assert.deepEqual(w.ctx.state.graphPlan(queued.instanceId).runtime.nodes.placeholder.tombstone, { operationId: token, acceptance: "unsubmitted" });
  assert.equal(w.started("placeholder"), 0);
  assert.deepEqual(w.ctx.executionFor(id).state().operations, {});
  assert.equal(recoveryDrainStatus(w.ctx.state).drained, true);
});

test("reference owners release settled workspaces and retain receipt tombstones in compatible backups", async t => {
  const w = await fixture(t, { sourceIsWorktree: true });
  mkdirSync(join(w.root, ".git"));
  const queued = await w.queue("references", [task("producer"), task("pending", ["producer"])]);
  await w.queue("consumer", [anchor("references", "producer"), task("bound", ["external"])]);
  await w.tick();
  const producerId = taskId("producer");
  w.ctx.state.update(producerId, { reviewHistory: [{ key: "previous", result: { verdict: "clear" } }] });
  const audit = w.ctx.state.get(producerId).reviewHistory[0]._gallivantReviewArchive.digest;
  const archive = join(w.home, "reviews/history", `${audit}.json`), oldEvidence = readFileSync(archive);
  unlinkSync(archive);
  const merge = await w.integrate("producer");
  await w.advance();
  assert.equal(w.ctx.state.graphPlan(queued.instanceId).runtime.nodes.producer.receipt.sha, merge);
  assert.throws(() => w.ctx.state.reviewHistory(producerId), { code: "REVIEW_HISTORY" });
  put(archive, oldEvidence);
  assert.deepEqual(w.ctx.state.planCheckoutReferences(), [w.root]);

  const id = taskId("old-workspace"), prior = { repo: REPO, worktree: w.root, branch: "work/old-workspace", base: "main", pr: 9,
    state: STATES.done, last: { exit: 0 }, workspace_cleanup: { status: "retained", pr: 9, head: HEAD } };
  w.ctx.state.put(id, prior);
  const pr = { state: "MERGED", headRefOid: HEAD };
  assert.equal((await cleanupMergedWorkspace(w.ctx, id, prior, pr)).code, "shared-input");
  await w.apply({ action: "cancel", plan: "references" });
  await w.apply({ action: "cancel", plan: "consumer" });
  assert.deepEqual(w.ctx.state.planCheckoutReferences(), []);
  const cleanup = await cleanupMergedWorkspace(w.ctx, id, prior, pr);
  assert.equal(cleanup.status, "done");
  w.ctx.state.update(id, { workspace_cleanup: cleanup });
  assert.equal(existsSync(w.root), false);
  assert.deepEqual(w.ctx.state.load().plans.blobs, {});
  const consumer = await w.inspect("consumer");
  assert.equal(consumer.graph.nodes[0].observed[0].receipt.sha, merge);
  const runtime = { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1,
    coreSha256: "a".repeat(64), ...PLAN_RUNTIME_FORMAT };
  const older = { ...runtime, registryVersion: 5, dependencyPlanVersion: 1 };
  assert.throws(() => checkRuntimeState({ home: w.home, manifest: older }), { code: "RUNTIME_STATE" });
  migrateRuntimeState({ home: w.home, manifest: runtime });
  const out = join(tempHome(), "backup"), restored = join(tempHome(), "restored");
  backupRuntimeState({ home: w.home, out, manifest: runtime });
  restoreRuntimeState({ backup: out, out: restored, manifest: runtime });
  const store = makeState(restored);
  assert.deepEqual(store.load().plans, w.ctx.state.load().plans);
  assert.ok(readJson(join(restored, "runs", idSlug(producerId), "execution.json")).operations[w.entry("producer").start_token]);
});
