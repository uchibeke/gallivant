import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { queuePlan, previewPlan, inspectPlan } from "../lib/dependency_plan_admission.mjs";
import { tickDependencyPlans } from "../lib/dependency_plan_dispatch.mjs";
import { queueChain, tickChains } from "../lib/chains.mjs";
import { start } from "../lib/commands/start.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { why } from "../lib/commands/why.mjs";
import { dispatchCapacity } from "../lib/dispatch_capacity.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { canonicalPath, readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { bindPlanOperator, recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { hosts } from "../lib/hosts.mjs";
import { makeRecoverySchedule } from "../lib/recovery_schedule.mjs";
import { makeRecoveryCooldowns, providerScope } from "../lib/recovery_cooldown.mjs";
import { makeState, STATES } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { receiptHash } from "../lib/deliverable.mjs";
import { normalizePublicBody } from "../lib/block.mjs";
import { CONFIG, GOOD_PRD, T0, at, review, codexLines, fakeCredential, fakeGh, fakeIdentity, fakeRunner, fakeNotify,
  harnessBin, makeClock, prFixture, silentLog, tempHome } from "./helpers.mjs";

const PRODUCER = "acme/widget", CONSUMER = "acme/consumer", BASE = "a".repeat(40), HEAD = "b".repeat(40);
const task = (id, needs = [], repository = "one") => ({ id, type: "task", repository, prd: `docs/prds/${id}.md`, needs });
const anchor = (plan, node) => ({ id: "prerequisite", type: "anchor", target: node ? { plan, node } : { plan, boundary: "terminal" } });
const wait = () => Promise.withResolvers();

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

function fixture(t, { capacity = 4, perRepo = capacity, graph = capacity, preparation = capacity, consumer = CONSUMER, harness = "codex" } = {}) {
  const home = canonicalPath(tempHome()), root = canonicalPath(tempHome()), clock = makeClock();
  const repositories = [PRODUCER, consumer], dirs = new Map(repositories.map(repo => [repo, join(root, basename(repo))]));
  const ids = new Map(repositories.map(repo => [repo, `host-id-${basename(repo)}`]));
  const bases = new Map(repositories.map(repo => [repo, BASE])), integrated = new Map(), prs = new Map();
  const runners = new Map(), prds = new Map(), calls = [], clones = new Map();
  const config = { ...structuredClone(CONFIG), poll_seconds: 1, home, worktrees: join(home, "worktrees"),
    harness: { [harness]: { bin: harnessBin(home, harness) } }, deliverable: { ...CONFIG.deliverable, evaluator: "local" },
    dispatch_capacity: { authors: capacity, per_repository: perRepo, per_plan: capacity, preparations: preparation, graph_authors: graph, graph_per_repository: graph } };
  const unlocked = () => assert.equal(existsSync(join(home, "state.json.lock")), false);
  const runnerFor = id => {
    if (!runners.has(id)) runners.set(id, fakeRunner(clock));
    return runners.get(id);
  };
  const ctx = { home, config, clock, log: silentLog, ownLogin: "me", notify: fakeNotify(),
    state: makeState(home), credential: fakeCredential(), identity: fakeIdentity(), runnerFor,
    readPrd: id => prds.get(id) ?? null, writePrd: (id, text) => prds.set(id, text),
    gh: { ...fakeGh(),
      repoInfo: async checkout => {
        unlocked();
        const repo = repositories.find(repo => dirs.get(repo) === checkout);
        return { nameWithOwner: repo, defaultBranch: "main", repositoryId: ids.get(repo) };
      },
      repositoryIdentity: async repo => { unlocked(); return { key: repo, id: ids.get(repo) }; },
      branchExists: async repo => { unlocked(); return ids.has(repo); },
      refSha: async repo => { unlocked(); return bases.get(repo); },
      fileAtStrict: async () => { unlocked(); return null; },
      prView: async (repo, number) => { unlocked(); return prs.get(`${repo}/${number}`); },
      containsCommit: async (repo, ref, sha) => {
        unlocked(); calls.push(["host-ancestry", repo, ref, sha]);
        return (ref === bases.get(repo) || ref === "main") && integrated.get(repo)?.has(sha) === true;
      },
    },
    git: {
      exists: existsSync,
      toplevel: async path => [...dirs.values()].find(dir => path.startsWith(dir + "/")),
      planCheckout: async path => {
        const repo = repositories.find(repo => path.startsWith(dirs.get(repo) + "/"));
        return { root: dirs.get(repo), repository: repo };
      },
      create: async ({ nameWithOwner: repo, prdId: id }) => {
        unlocked(); calls.push(["clone", repo, id]);
        const path = join(config.worktrees, repo, id);
        mkdirSync(path, { recursive: true });
        clones.set(path, { repo, commits: new Set(integrated.get(repo)) });
        return path;
      },
      containsCommit: async (path, sha) => {
        unlocked(); calls.push(["checkout-ancestry", clones.get(path).repo, sha]);
        return clones.get(path).commits.has(sha);
      },
      fileAt: async () => null,
    },
  };
  let permitted = true;
  ctx.planAuthority = bindPlanOperator(ctx.state.file, () => ({ principal: "operator-fixture", tenant: "local",
    grant: ({ action }) => permitted ? `${action}-proof` : null,
    isolation: { registry: ctx.state.file, qualified: true, workerExcluded: true, launchDigest: "a".repeat(64), expiresAt: Date.now() + 30_000 } }));
  const brief = (name, repo = PRODUCER) => put(join(dirs.get(repo), "docs/prds", `${name}.md`), GOOD_PRD.replace("harness: codex", `harness: ${harness}`));
  const queue = async (name, nodes) => {
    for (const node of nodes) if (node.type === "task") brief(node.id, node.repository === "two" ? consumer : PRODUCER);
    const file = put(join(root, `${name}.json`), JSON.stringify({ version: 1, name, repositories: {
      one: { repository: PRODUCER, checkout: basename(PRODUCER), base: "main" },
      two: { repository: consumer, checkout: basename(consumer), base: "main" },
    }, nodes }));
    const input = { file, options: { directory: root, checkouts: repositories.map(repo => basename(repo)) } };
    return queuePlan(ctx, input, { approve: (await previewPlan(ctx, input)).approvalDigest });
  };
  let schedule = makeRecoverySchedule({ home, clock });
  const restart = () => { ctx.state = makeState(home); schedule = makeRecoverySchedule({ home, clock }); };
  const tick = async () => {
    const cycle = schedule.begin();
    const result = await tickDependencyPlans(ctx, cycle);
    cycle.finish();
    return result;
  };
  const advance = async () => { clock.advance(1); return tick(); };
  const started = (id, repo = PRODUCER) => runners.get(`${repo}/${id}`)?.started.length ?? 0;
  const entryFor = (id, repo = PRODUCER) => ctx.state.get(`${repo}/${id}`);
  const finish = (id, { repo = PRODUCER, review = false } = {}) => {
    const key = `${repo}/${id}`, entry = entryFor(id, repo);
    runnerFor(key).finish(codexLines(), { exit: 0 });
    const number = prs.size + 1, url = `https://github.com/${repo}/pull/${number}`;
    const pr = prFixture({ number, url, headRefName: entry.branch, headRefOid: HEAD });
    prs.set(`${repo}/${number}`, pr);
    ctx.state.update(key, { pr: number, url, state: review ? STATES.ready : STATES.prOpen, last: { ...entry.last, exit: 0 } });
    return pr;
  };
  const merge = (id, { repo = PRODUCER, delivery = true, status = "retained", state = "MERGED" } = {}) => {
    const entry = entryFor(id, repo), pr = prs.get(`${repo}/${entry.pr}`), number = entry.pr;
    const sha = number.toString(16).padStart(40, "0"), at = new Date(clock.now()).toISOString();
    Object.assign(pr, { state, mergeCommit: { oid: sha }, mergedAt: at });
    if (!integrated.has(repo)) integrated.set(repo, new Set());
    if (state === "MERGED") integrated.get(repo).add(sha);
    const terminal = { state, repository: repo, pr: number, head: HEAD, base: "main", mergeCommit: sha, mergedAt: at };
    ctx.state.update(`${repo}/${id}`, { state: STATES.done, completionEvidence: { terminal, integration: { ...terminal, qualified: delivery } },
      workspace_cleanup: { status, pr: number, head: HEAD } });
    return sha;
  };
  const node = (plan, id) => inspectPlan(ctx, plan).graph.nodes.find(node => node.id === id);
  return { home, ctx, clock, queue, brief, tick, advance, restart, finish, merge, node, entryFor, started, calls, runners, integrated, bases, ids,
    revoke: () => { permitted = false; } };
}

test("capacity-one diamond releases author slots before integration and joins only after both exact receipts", async t => {
  const w = fixture(t, { capacity: 1 });
  await w.queue("diamond", [task("root"), task("left", ["root"]), task("right", ["root"]), task("join", ["left", "right"])]);
  await w.tick();
  assert.equal(w.started("root"), 1);
  await assert.rejects(start(w.ctx, { path: w.brief("manual") }), { code: "AUTHOR_CAPACITY" });
  w.finish("root");
  await w.advance();
  assert.equal(w.started("left") + w.started("right"), 0, "an author exit and open PR do not supply a receipt");
  const manual = await start(w.ctx, { path: w.brief("manual") });
  const chain = await queueChain(w.ctx, { name: "linear", paths: [w.brief("legacy-one"), w.brief("legacy-two")] });
  await tickChains(w.ctx);
  assert.equal(w.started("legacy-one"), 0, "legacy starts share the manual reservation");
  w.finish("manual");
  assert.ok(manual.id);
  await tickChains(w.ctx);
  assert.equal(w.started("legacy-one"), 1);
  w.finish("legacy-one");
  w.merge("root");
  await w.advance();
  w.restart();
  await w.advance();
  assert.equal(w.started("left") + w.started("right"), 1);
  const [first, other] = w.started("left") ? ["left", "right"] : ["right", "left"];
  w.finish(first);
  await w.advance();
  assert.equal(w.started(other), 1, "the sibling runs while the first PR awaits review and merge");
  assert.equal(w.started("join"), 0);
  w.finish(other); w.merge(first);
  await w.advance(); await w.advance();
  assert.equal(w.started("join"), 0);
  w.merge(other);
  await Promise.all([w.advance(), w.tick()]);
  await Promise.all([w.advance(), w.tick()]);
  assert.equal(w.started("join"), 1);
  assert.equal(w.ctx.state.getChain(chain.name).index, 0);
  assert.deepEqual(Object.keys(w.ctx.state.load().dispatch.authors), [`${PRODUCER}/join`]);
});

test("independent starts overlap and a hold generation changed during clone fences only its node", async t => {
  const w = fixture(t), { state, git } = w.ctx;
  writeJsonAtomic(state.file, { version: 1, entries: {}, recovery: { version: 1, storeId: "fixture", profiles: [], holds: {} } });
  await w.queue("overlap", [task("slow"), task("fast")]);
  const entered = wait(), release = wait(), launched = wait(), clone = git.create;
  const raw = w.ctx.runnerFor(`${PRODUCER}/fast`), spawn = raw.start;
  raw.start = (...args) => { const job = spawn(...args); launched.resolve(); return job; };
  git.create = async spec => {
    if (spec.prdId === "slow") { entered.resolve(); await release.promise; }
    return clone(spec);
  };
  const pending = w.tick();
  try {
    await Promise.race([entered.promise, pending.then(() => assert.fail("slow clone was never entered"))]);
    await Promise.race([launched.promise, pending.then(() => assert.fail("the independent author did not run during clone"))]);
    const scope = `task/${PRODUCER}/slow`;
    state.setRecoveryHold(scope, "hold", 0, recoveryAdminIntent(state.file, "hold", scope, 0));
    state.setRecoveryHold(scope, "resume", 1, recoveryAdminIntent(state.file, "resume", scope, 1));
  } finally { release.resolve(); }
  await pending;
  w.restart(); await w.advance();
  assert.equal(w.started("slow"), 0);
  assert.equal(w.started("fast"), 1);
  assert.equal(w.ctx.state.startClaim(`${PRODUCER}/slow`).unsent, true);
  assert.equal(w.ctx.state.load().dispatch.authors[`${PRODUCER}/slow`], undefined);
});

test("cross-plan consumers share an immutable producer and never use another repository's SHA in a clone", async t => {
  const w = fixture(t);
  await w.queue("producer", [task("ship")]);
  await w.queue("same-repo", [anchor("producer", "ship"), task("downstream", ["prerequisite"])]);
  await w.queue("other-repo", [anchor("producer"), task("other", ["prerequisite"], "two")]);
  await w.tick(); w.finish("ship"); const sha = w.merge("ship");
  await w.advance();
  assert.equal(w.node("other-repo", "prerequisite").observed[0].receipt.repositoryId, "host-id-widget");
  w.bases.set(PRODUCER, "c".repeat(40)); // Healthy advance keeps ancestry.
  await w.advance();
  assert.equal(w.started("downstream"), 1);
  assert.equal(w.started("other", CONSUMER), 1);
  assert.equal(w.started("ship"), 1);
  assert.ok(w.calls.some(call => call[0] === "host-ancestry" && call[1] === PRODUCER && call[2] === "c".repeat(40)));
  assert.ok(w.calls.some(call => call[0] === "checkout-ancestry" && call[1] === PRODUCER && call[2] === sha));
  assert.equal(w.calls.some(call => call[0] === "checkout-ancestry" && call[1] === CONSUMER), false);
});

test("a cross-host receipt uses only producer ancestry and the consumer adapter's own credential", async t => {
  const consumer = "bitbucket.org/acme/consumer";
  const w = fixture(t, { consumer });
  const credentials = [];
  w.ctx.config.repos.push({ repo: consumer, reviewer: null, trusted_authors: ["{12345678-1234-4123-8123-123456789000}"] });
  w.ctx.host = w.ctx.gh;
  w.ctx.hosts = {
    ...hosts, credential: async repository => {
      credentials.push(repository.key);
      return { token: "fixture-token", host: repository.host, repository: repository.path };
    },
    inspect(repo) {
      const selected = hosts.inspect(repo);
      return { ...selected, api: { preflight: async () => ({ base: "main", baseSha: BASE }) } };
    },
  };
  w.ctx.git.probeAccess = async repo => { assert.equal(repo, consumer); return { ok: true }; };
  await w.queue("across-hosts", [task("producer"), task("consumer", ["producer"], "two")]);
  await w.tick(); w.finish("producer"); w.merge("producer"); await w.advance(); await w.advance();
  assert.equal(w.started("consumer", consumer), 1);
  assert.deepEqual(credentials, [PRODUCER, consumer]);
  assert.ok(w.calls.filter(([kind]) => kind === "host-ancestry").every(([, repo]) => repo === PRODUCER));
  assert.equal(w.calls.some(([kind]) => kind === "checkout-ancestry"), false);
  const job = w.ctx.runnerFor(`${consumer}/consumer`).started[0];
  assert.equal(job.opts.env.GH_TOKEN, "");
});

test("a force-pushed base or recreated producer fences undispatched consumers while a sibling root continues", async t => {
  for (const change of ["base", "repository", "checkout"]) await t.test(change, async t => {
    const w = fixture(t);
    await w.queue("producer", [task("upstream")]);
    await w.tick(); w.finish("upstream"); w.merge("upstream"); await w.advance();
    await w.queue("follow-on", [anchor("producer"), task("blocked", ["prerequisite"]), task("independent", [], "two")]);
    if (change === "base") { w.integrated.set(PRODUCER, new Set()); w.bases.set(PRODUCER, "d".repeat(40)); }
    if (change === "repository") w.ids.set(PRODUCER, "replacement-immutable-id");
    if (change === "checkout") {
      const clone = w.ctx.git.create;
      w.ctx.git.create = async spec => {
        const path = await clone(spec);
        if (spec.prdId === "blocked") w.ctx.git.containsCommit = async () => false;
        return path;
      };
    }
    await w.advance();
    assert.equal(w.started("blocked"), 0);
    assert.equal(w.started("independent", CONSUMER), 1);
    assert.notEqual(w.node("follow-on", "blocked").status, "integrated");
  });
});

test("an unqualified merge, closed PR, or unsettled cleanup cannot produce an integration receipt", async t => {
  const w = fixture(t);
  await w.queue("settlement", [task("missing-evidence"), task("closed"), task("pending-cleanup"),
    task("join", ["closed", "missing-evidence", "pending-cleanup"])]);
  await w.tick();
  w.finish("missing-evidence"); w.merge("missing-evidence", { delivery: false });
  w.finish("closed"); w.merge("closed", { state: "CLOSED" });
  w.finish("pending-cleanup"); w.merge("pending-cleanup", { status: "pending" });
  await w.advance();
  assert.equal(w.node("settlement", "missing-evidence").status, "unverified");
  assert.equal(w.node("settlement", "closed").status, "blocked");
  assert.equal(w.node("settlement", "pending-cleanup").status, "unverified");
  w.merge("pending-cleanup");
  await w.advance(); await w.advance();
  assert.equal(w.node("settlement", "pending-cleanup").status, "integrated");
  assert.equal(w.started("join"), 0);
});

test("the normal ready and merge owners supply new-head review, CI, completion and retained cleanup evidence", async t => {
  const w = fixture(t);
  await w.queue("closeout", [task("producer"), task("next", ["producer"])]);
  await w.tick();
  const pr = w.finish("producer"), id = `${PRODUCER}/producer`;
  const answer = { task_id: id, output_type: "code",
    summary: "Verified the ready task against its review contract with a settled check and evidence from the required current-head reviewer before the maintainer integrated it.",
    criteria_attestations: [1, 2].map(i => ({ criterion_id: `ac-${i}`, met: true, evidence: "test/dependency-plan-dispatch.test.mjs" })) };
  pr.body += "\n```work-attestations\n" + JSON.stringify(answer) + "\n```\n";
  pr.statusCheckRollup = prFixture({ headRefOid: HEAD, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }).statusCheckRollup;
  w.ctx.gh.setRecoveryMetadata = async (_repo, _number, identity, { taskId }) => {
    pr.body = normalizePublicBody(pr.body, { identity, taskId });
    return pr;
  };
  w.ctx.gh.reviews = async () => [review({ id: 31, at: at(1), by: "chatgpt-codex-connector[bot]", bot: true, body: `Reviewed commit: \`${HEAD}\`` })];
  w.ctx.state.update(id, e => ({ rereview: { at: T0, nudged: false }, cursor: { ...e.cursor, fixed_sha: HEAD, receipt_hash: receiptHash(pr.body) } }));
  const tick = makeTick(w.ctx);
  w.clock.advance(2);
  await tick.tickEntry(id, w.entryFor("producer"));
  assert.equal(w.entryFor("producer").state, STATES.ready, JSON.stringify(w.entryFor("producer").last));
  assert.equal(w.entryFor("producer").completionEvidence.delivery.gate.source, "local");
  const sha = "d".repeat(40);
  w.integrated.set(PRODUCER, new Set([sha]));
  Object.assign(pr, { state: "MERGED", mergeCommit: { oid: sha }, mergedAt: at(3) });
  let cleanup = "pending";
  w.ctx.cleanupMergedWorkspace = async () => ({ status: cleanup, pr: pr.number, head: HEAD });
  w.clock.advance(2);
  await makeTick(w.ctx).tickEntry(id, w.entryFor("producer"));
  await w.advance();
  assert.equal(w.started("next"), 0);
  cleanup = "retained";
  await makeTick(w.ctx).tickEntry(id, w.entryFor("producer"));
  assert.equal(w.entryFor("producer").completionEvidence.integration.qualified, true);
  await w.advance(); await w.advance();
  assert.equal(w.started("next"), 1);
});

test("narrowing capacity fences admissions across repositories and preserves admitted runs and rounds", async t => {
  const w = fixture(t, { capacity: 3, perRepo: 1 });
  await w.queue("pressure", [task("first"), task("third"), task("second", [], "two")]);
  await w.tick();
  assert.equal(w.started("first"), 1);
  assert.equal(w.started("second", CONSUMER), 1);
  assert.equal(w.started("third"), 0);
  w.ctx.config.dispatch_capacity.authors = 1;
  w.restart(); w.finish("first"); await w.advance();
  assert.equal(w.started("third"), 0);
  assert.equal(w.ctx.runnerFor(`${CONSUMER}/second`).current().running, true);
  assert.equal(w.entryFor("second", CONSUMER).iteration, 0);
  assert.equal(w.ctx.config.max_iterations, CONFIG.max_iterations);
  w.finish("second", { repo: CONSUMER }); await w.advance();
  assert.equal(w.started("third"), 1);
});

test("graph fix rounds occupy the graph lane across restart until the author settles", async t => {
  const w = fixture(t, { capacity: 3, graph: 1 });
  await w.queue("fix-first", [task("first")]);
  await w.tick();
  w.finish("first");

  const id = `${PRODUCER}/first`, entry = w.entryFor("first");
  const { job } = await makeTick(w.ctx).startRun(id, entry, { name: "fix", prompt: "Address the review finding." });
  w.ctx.state.update(id, { last: { ...entry.last, run: job.id, exit: null } });
  await w.queue("fix-next", [task("next", [], "two")]);
  w.restart();
  await w.advance();
  assert.equal(w.started("next", CONSUMER), 0);
  assert.equal(w.ctx.state.load().dispatch.authors[id].graph, true);

  // A reservation from the preceding runtime may still own a live fix round.
  const saved = w.ctx.state.load();
  saved.dispatch.authors[id].graph = false;
  writeJsonAtomic(w.ctx.state.file, saved);
  w.restart();
  await w.advance();
  assert.equal(w.started("next", CONSUMER), 0);
  assert.equal(w.ctx.runnerFor(id).current().id, job.id);

  w.ctx.runnerFor(id).finish(codexLines(), { exit: 0 });
  w.ctx.state.update(id, current => ({ last: { ...current.last, exit: 0 } }));
  await w.advance();
  assert.equal(w.started("next", CONSUMER), 1);
  assert.equal(w.entryFor("first").state, STATES.prOpen);
});

test("graph continuations respect the approved author ceiling even after live limits increase", async t => {
  const w = fixture(t, { capacity: 1, graph: 3 });
  await w.queue("pinned-capacity", [task("first")]);
  await w.tick();
  w.finish("first");
  Object.assign(w.ctx.config.dispatch_capacity, { authors: 3, per_repository: 3, per_plan: 3 });
  await start(w.ctx, { path: w.brief("competing", CONSUMER) });

  const id = `${PRODUCER}/first`, entry = w.entryFor("first");
  let submitted = 0;
  const fix = () => makeTick(w.ctx).startRun(id, entry, { name: "fix", prompt: "Address the review finding.", beforeDispatch: () => { submitted++; } });
  await assert.rejects(fix(), { code: "AUTHOR_CAPACITY" });
  assert.equal(w.started("first"), 1);
  assert.equal(submitted, 0);
  assert.equal(w.entryFor("first").iteration, entry.iteration);
  assert.deepEqual(Object.keys(w.ctx.state.load().dispatch.authors), [`${CONSUMER}/competing`]);

  w.finish("competing", { repo: CONSUMER });
  await fix();
  assert.equal(w.started("first"), 2);
  assert.equal(submitted, 1);
});

test("a graph fix uses the approved per-run budget after the configured budget rises", async t => {
  const w = fixture(t, { harness: "claude" });
  w.ctx.config.max_budget_usd = 2;
  await w.queue("approved-budget", [task("bounded")]);
  await w.tick();
  assert.equal(w.started("bounded"), 1);
  w.finish("bounded");

  w.ctx.config.max_budget_usd = 40;
  w.restart();
  const id = `${PRODUCER}/bounded`;
  await makeTick(w.ctx).startRun(id, w.entryFor("bounded"), { name: "fix", prompt: "Address the review finding." });
  const args = w.ctx.runnerFor(id).started.at(-1).args;
  assert.equal(args[args.indexOf("--max-budget-usd") + 1], "2");
  assert.equal(w.ctx.config.max_budget_usd, 40);
});

test("a graph continuation rechecks the approved round cap before spawn after restart", async t => {
  const w = fixture(t);
  w.ctx.config.max_iterations = 2;
  await w.queue("approved-rounds", [task("bounded")]);
  await w.tick();
  w.finish("bounded");

  w.ctx.config.max_iterations = 30;
  w.restart();
  const id = `${PRODUCER}/bounded`, tick = makeTick(w.ctx);
  w.ctx.state.update(id, { iteration: 1 });
  await assert.rejects(tick.startRun(id, w.entryFor("bounded"), {
    name: "fix", prompt: "Address the review finding.",
    beforeDispatch: async () => { w.ctx.state.update(id, { iteration: 2 }); },
  }), { code: "PLAN_ITERATIONS" });
  w.ctx.git.exists = () => assert.fail("an exhausted graph resume cannot prepare a checkout");
  await assert.rejects(resume(w.ctx, { handle: id }), { code: "PLAN_ITERATIONS" });
  const entry = w.entryFor("bounded");
  assert.throws(() => w.ctx.state.reserveAuthorTurn(id, entry.last.run, "exhausted", dispatchCapacity(w.ctx.config)), { code: "PLAN_ITERATIONS" });
  assert.equal(w.ctx.state.hasAuthorReservation(id), false);
  assert.equal(w.started("bounded"), 1);
  assert.equal(w.entryFor("bounded").iteration, 2);
});

test("a graph author keeps its approved repository timeout across configuration changes", async t => {
  const w = fixture(t);
  w.ctx.config.repos = [{ repo: PRODUCER, run_timeout_minutes: 4 }];
  await w.queue("approved-runtime", [task("bounded")]);
  await w.tick();
  w.finish("bounded");

  w.ctx.config.repos[0].run_timeout_minutes = 40;
  w.restart();
  const id = `${PRODUCER}/bounded`, entry = w.entryFor("bounded");
  const { job } = await makeTick(w.ctx).startRun(id, entry, { name: "fix", prompt: "Address the review finding." });
  w.ctx.state.update(id, { last: { ...entry.last, run: job.id, exit: null } });

  w.ctx.config.repos[0].run_timeout_minutes = 1;
  w.restart();
  w.clock.advance(2);
  await makeTick(w.ctx).tickEntry(id, w.entryFor("bounded"));
  assert.equal(w.ctx.runnerFor(id).current().running, true);

  w.ctx.config.repos[0].run_timeout_minutes = 40;
  w.restart();
  w.clock.advance(3);
  await makeTick(w.ctx).tickEntry(id, w.entryFor("bounded"));
  assert.equal(w.ctx.runnerFor(id).current().running, false);
  assert.equal(w.entryFor("bounded").timeout?.limit, 4);
  assert.equal(w.entryFor("bounded").timeout?.source, "plan");
  assert.match(why(w.ctx, { handle: id }), /approved plan's repository timeout/);
});

test("a collected author releases capacity while PR discovery still owns its delayed host read", async t => {
  const w = fixture(t, { capacity: 1 });
  await w.queue("publication", [task("collected"), task("descendant", ["collected"])]);
  await w.tick();
  const id = `${PRODUCER}/collected`, runner = w.ctx.runnerFor(id);
  runner.finish(codexLines(), { exit: 0 });
  const entered = wait(), release = wait();
  w.ctx.gh.prListByHead = async () => { entered.resolve(); await release.promise; return []; };
  const settling = makeTick(w.ctx).tickEntry(id, w.entryFor("collected"));
  try {
    await Promise.race([entered.promise, settling.then(() => assert.fail("PR discovery did not run"))]);
    assert.equal(w.entryFor("collected").last.exit, null);
    assert.ok(w.entryFor("collected").author_settlement);
    await start(w.ctx, { path: w.brief("independent") });
    assert.equal(w.started("independent"), 1);
    assert.equal(w.started("descendant"), 0);
  } finally { release.resolve(); }
  await settling;
});

test("lost launch acknowledgement remains observation-only through restart and binds the late exact paid operation", async t => {
  const w = fixture(t, { capacity: 1 }), key = `${PRODUCER}/lost-reply`;
  const raw = w.ctx.runnerFor(key), spawn = raw.start;
  let hidden = true;
  const current = raw.current;
  raw.current = () => hidden ? null : current();
  raw.start = (...args) => {
    const job = spawn(...args);
    raw.started.at(-1).id = args[3].runId;
    throw new Error(`Lost launch response for ${job.id}`);
  };
  const executionRoot = join(w.home, "native");
  w.ctx.executionFor = id => makeExecution({ root: executionRoot, taskId: id, provider: "codex", clock: w.clock, runner: w.ctx.runnerFor(id) });
  await w.queue("recover", [task("lost-reply"), task("after", ["lost-reply"])]);
  await w.tick();
  w.restart(); await w.advance();
  const entry = w.ctx.state.get(key), token = entry.start_token;
  assert.equal(w.started("lost-reply"), 1);
  assert.equal(entry.initial_dispatch.status, "dispatching");
  assert.deepEqual(Object.keys(w.ctx.executionFor(key).state().operations), [token]);
  assert.equal(w.ctx.executionFor(key).state().operations[token].acceptance, "unknown");
  assert.equal(w.ctx.state.load().dispatch.authors[key].operation, token);
  assert.equal(w.started("after"), 0);
  hidden = false;
  await makeTick(w.ctx).tickEntry(key, w.ctx.state.get(key));
  assert.equal(w.ctx.state.get(key).initial_dispatch, null);
  assert.equal(w.ctx.executionFor(key).state().operations[token].acceptance, "accepted");
  assert.equal(w.started("lost-reply"), 1);
});

test("plan and node cursors persist, long provider cooldowns avoid clones, and retained history stays out of work lanes", async t => {
  const w = fixture(t, { capacity: 8 });
  for (const name of ["alpha", "beta"]) await w.queue(name, Array.from({ length: 6 }, (_, i) => task(`${name}-${i}`)));
  const state = w.ctx.state.load();
  for (let index = 0; index < 15_000; index++) state.entries[`${PRODUCER}/historical-${index}`] = { repo: PRODUCER, state: STATES.done, workspace_cleanup: { status: "retained" } };
  writeJsonAtomic(w.ctx.state.file, state);
  const cooldowns = makeRecoveryCooldowns({ home: w.home, clock: w.clock });
  w.ctx.cooldowns = cooldowns;
  const scope = providerScope("codex", "operator");
  const delay = 48 * 3_600_000;
  cooldowns.record(scope, { status: 429, retryAfterMs: delay });
  await w.tick(); w.restart(); await w.advance();
  assert.equal(w.calls.some(call => call[0] === "clone"), false);
  w.clock.advance(delay / 60_000);
  await w.tick();
  const first = readJson(join(w.home, "recovery-schedule.json"));
  assert.equal(Object.keys(first.cursors.graphStartNodes).length, 2);
  assert.equal(w.calls.filter(call => call[0] === "clone").length, 4);
  w.restart(); await w.advance();
  assert.equal(w.calls.filter(call => call[0] === "clone").length, 8);
  assert.equal(w.runners.size, 8);
  assert.equal(w.ctx.state.load().entries[`${PRODUCER}/historical-14999`].state, STATES.done);
});
