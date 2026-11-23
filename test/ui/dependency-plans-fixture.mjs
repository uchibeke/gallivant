import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { queuePlan } from "../../lib/dependency_plan_admission.mjs";
import { tickDependencyPlans } from "../../lib/dependency_plan_dispatch.mjs";
import { makeExecution } from "../../lib/execution.mjs";
import { canonicalPath } from "../../lib/fs.mjs";
import { bindPlanOperator } from "../../lib/operator_intent.mjs";
import { makeRecoverySchedule } from "../../lib/recovery_schedule.mjs";
import { idSlug, STATES } from "../../lib/state.mjs";
import { makeTick } from "../../lib/tick.mjs";
import { CONFIG, GOOD_PRD, codexLines, fakeCredential, fakeGh, fakeIdentity, fakeNotify, fakeRunner, harnessBin, makeClock, prFixture } from "../helpers.mjs";
import { fixture, NOW } from "./fixture.mjs";

export const REPO = "acme/widget";
export const ACTOR = "fixture-operator";
export const SECRET = "PRIVATE_SOURCE_TEXT_FIXTURE";
const BASE = "a".repeat(40), HEAD = "b".repeat(40);
export const task = (id, needs) => ({ id, type: "task", repository: "repository-1", prd: `docs/prds/${id}.md`, ...(needs ? { needs } : {}) });
export const group = (id, children, needs, mode = "parallel") => ({ id, type: "group", mode, children, ...(needs ? { needs } : {}) });
export const anchor = (id, plan, node) => ({ id, type: "anchor", target: { plan, ...(node ? { node } : { boundary: "terminal" }) } });
export const manifest = (name, nodes) => ({ version: 1, name, repositories: { "repository-1": { repository: REPO, checkout: ".", base: "main" } }, nodes });
export const encode = (value, format = "json") => ({ format, text: format === "yaml" ? stringify(value) : JSON.stringify(value) });
const taskId = slug => `${REPO}/${slug}`;

export async function planFixture(t, { limit = 2 } = {}) {
  const ui = await fixture({ empty: true });
  t.after(() => ui.close());
  const { ctx, state } = ui, clock = makeClock(NOW), home = canonicalPath(ui.home);
  const inputs = join(home, "approved-inputs"), worktrees = join(home, "worktrees");
  mkdirSync(inputs); mkdirSync(worktrees);
  const resources = { minimum_free_bytes: 0, minimum_free_inodes: 0, minimum_memory_bytes: 0, maximum_load_per_cpu: 0 };
  const files = [], calls = [], diagnostics = [], prs = new Map(), merges = new Set(), runners = new Map();
  let visible = true;
  const denied = new Set();
  const authority = tenant => bindPlanOperator(state.file, () => ({ tenant, principal: tenant, grant: ({ action, scope }) =>
    scope.tenant === tenant && scope.repositories.every(repo => repo === REPO) && (tenant !== ACTOR || !denied.has(action)) ? "fixture-grant" : null,
  isolation: { registry: state.file, qualified: true, workerExcluded: true, launchDigest: "e".repeat(64), expiresAt: Date.now() + 60000 } }));
  ctx.planAuthority = authority(ACTOR);
  const other = authority("private-tenant");
  ctx.planOperatorForRequest = req => visible && req.headers.authorization === ACTOR ? ctx.planAuthority : null;
  ctx.planInputs = { directory: inputs, bindings: [{ repository: REPO, checkout: ".", base: "main", files }] };

  function put(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  function input(path, text, approved = true) {
    put(join(inputs, path), text);
    if (approved && !files.includes(path)) files.push(path);
  }
  function brief(slug, suffix = "", approved = true) { input(task(slug).prd, GOOD_PRD + suffix, approved); }
  function read(kind, value) { calls.push(kind); return value; }
  const runnerFor = id => {
    if (!runners.has(id)) runners.set(id, fakeRunner(clock));
    return runners.get(id);
  };
  Object.assign(ctx, {
    home, clock, config: { ...structuredClone(CONFIG), home, worktrees, repos: [REPO], poll_seconds: 1,
      harness: { codex: { bin: harnessBin(home), account: "PRIVATE_ACCOUNT_FIXTURE" } },
      resource_headroom: resources, deliverable: { ...CONFIG.deliverable, evaluator: "local" },
      dispatch_capacity: { authors: limit, per_repository: limit, per_plan: limit, preparations: limit,
        graph_authors: limit, graph_per_repository: limit } },
    log: { ...ctx.log, warn: line => diagnostics.push(line) }, ownLogin: "fixture", notify: fakeNotify(),
    credential: fakeCredential(), identity: fakeIdentity(), runnerFor,
    readPrd: id => {
      const path = join(home, "prds", `${idSlug(id)}.md`);
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    writePrd: (id, text) => put(join(home, "prds", `${idSlug(id)}.md`), text),
    gh: { ...fakeGh(), repoInfo: async () => read("repo", { nameWithOwner: REPO, repositoryId: "fixture-repository", defaultBranch: "main" }),
      repositoryIdentity: async () => read("repository-id", { key: REPO, id: "fixture-repository" }),
      branchExists: async () => read("branch", true), refSha: async () => read("base", BASE), fileAtStrict: async () => read("input", null),
      prView: async (_repo, pr) => read("pull-request", prs.get(pr)), containsCommit: async (_repo, _base, sha) => read("ancestry", merges.has(sha)) },
    git: { exists: existsSync, planCheckout: async () => read("checkout", { root: inputs, repository: REPO }),
      create: async ({ prdId }) => {
        const path = join(worktrees, REPO, prdId);
        mkdirSync(join(path, ".git"), { recursive: true });
        return read("clone", path);
      }, head: async () => HEAD, fileAt: async () => null, containsCommit: async (_path, sha) => merges.has(sha),
      originOf: async () => `https://github.com/${REPO}.git`, cleanupProof: async path => ({ head: HEAD,
        branch: `work/${path.split("/").at(-1)}`, dirty: false, unpublished: false, stash: false, busy: false }) },
  });
  ctx.executionFor = id => makeExecution({ root: join(home, "runs", idSlug(id)), taskId: id, provider: "codex", clock, runner: runnerFor(id) });
  const schedule = makeRecoverySchedule({ home, clock });
  async function tick() {
    clock.advance(2);
    const cycle = schedule.begin();
    try { return await tickDependencyPlans(ctx, cycle); }
    finally { cycle.finish(); }
  }
  let nextPR = 100;
  async function settle(slug, outcome = "MERGED") {
    const id = taskId(slug), entry = state.get(id), number = ++nextPR, url = `https://github.com/${REPO}/pull/${number}`;
    runnerFor(id).finish(codexLines({ thread: entry.session }), { exit: 0 });
    const runner = ctx.executionFor(id);
    await runner.reconcile(); await runner.collect();
    const sha = number.toString(16).padStart(40, "0"), at = new Date(clock.now()).toISOString();
    const terminal = { state: outcome, repository: REPO, pr: number, head: HEAD, base: "main", mergeCommit: sha, mergedAt: at };
    prs.set(number, prFixture({ state: outcome, number, url, headRefName: entry.branch, headRefOid: HEAD, mergeCommit: { oid: sha }, mergedAt: at }));
    if (outcome === "MERGED") merges.add(sha);
    state.update(id, { pr: number, url, state: STATES.done, execution: runner.current().execution, last: { ...entry.last, exit: 0 },
      workspace_cleanup: { status: "retained", head: HEAD, pr: number },
      completionEvidence: { terminal, integration: { ...terminal, qualified: outcome === "MERGED" } } });
    await makeTick(ctx).tickEntry(id, state.get(id));
    return sha;
  }
  async function queue(name, nodes, { privatePlan = false } = {}) {
    function ensure(items) {
      for (const node of items) {
        if (node.type === "group") ensure(node.children);
        if (node.type === "task" && !existsSync(join(inputs, node.prd))) brief(node.prd.split("/").at(-1).slice(0, -3), "", !privatePlan);
      }
    }
    ensure(nodes);
    const file = `${name}.json`;
    input(file, encode(manifest(name, nodes)).text, false);
    const scope = privatePlan ? { ...ctx, planAuthority: other } : ctx;
    const spec = { file, options: { directory: inputs } };
    const { approvalDigest } = await queuePlan(scope, spec);
    return queuePlan(scope, spec, { approve: approvalDigest, requestId: `seed-${name}` });
  }
  return { ...ui, home, inputs, clock, calls, diagnostics, denied, brief, input, queue, settle, tick,
    allowBrowser: value => { visible = value; }, spawned: () => [...runners.values()].reduce((count, runner) => count + runner.started.length, 0) };
}

export async function diamondPlans(world) {
  const producer = await world.queue("release-workflow", [
    task("foundation"), group("implementation", [
      task("api"), group("experience", [task("interface")], undefined, "sequence"), task("overflow-check"),
    ], ["foundation"]),
    task("release", ["implementation"]),
  ]);
  await world.tick();
  const merge = await world.settle("foundation");
  await world.tick(); await world.tick();
  const consumer = await world.queue("downstream-release", [anchor("producer-terminal", producer.name), task("consumer", ["producer-terminal"])]);
  const second = await world.queue("downstream-api", [anchor("producer-task", producer.name, "implementation/api"), task("consumer-api", ["producer-task"])]);
  return { producer, consumer, second, merge };
}
