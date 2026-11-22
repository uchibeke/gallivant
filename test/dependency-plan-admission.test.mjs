import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { queueChain, tickChains, cancelChain } from "../lib/chains.mjs";
import { futurePlanTarget, inspectPlan, migratePlans, previewPlan, queuePlan } from "../lib/dependency_plan_admission.mjs";
import { canonicalPath, readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { acquireRuntimeOwner } from "../lib/daemon.mjs";
import { branchFor } from "../lib/git.mjs";
import { contentDigest } from "../lib/hash.mjs";
import { bindPlanOperator, recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { PLAN_RUNTIME_FORMAT, backupRuntimeState, checkRuntimeState, migrateRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
import { idSlug, makeState } from "../lib/state.mjs";
import { PLAN_REGISTRY_VERSION, RECOVERY_REGISTRY_VERSION } from "../lib/registry_versions.mjs";
import { CORE_VERSION } from "../lib/task_delivery_contract.mjs";
import { probeLearningIsolation } from "../lib/learning_qualification.mjs";
import { CONFIG, GOOD_PRD, T0, codexLines, fakeCredential, fakeIdentity, fakeRunner, harnessBin, makeClock, prFixture, silentLog, tempHome } from "./helpers.mjs";

const REPO = "acme/widget";
const BASE = "a".repeat(40), MERGE = "b".repeat(40), HEAD = "c".repeat(40);
const cli = fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url));
const manifest = { coreVersion: CORE_VERSION, operationVersion: 1, taskVersion: 1, executionVersion: 1, coreSha256: "a".repeat(64), ...PLAN_RUNTIME_FORMAT };
const planModule = new URL("../lib/dependency_plan_admission.mjs", import.meta.url).href;
const stateModule = new URL("../lib/state.mjs", import.meta.url).href;
const intentModule = new URL("../lib/operator_intent.mjs", import.meta.url).href;

const prd = id => `docs/prds/${id}.md`;
const task = (id, needs) => ({ id, type: "task", repository: "demo", prd: prd(id), ...(needs ? { needs } : {}) });
const anchor = (plan, target = { boundary: "terminal" }) => ({ id: "predecessor", type: "anchor", target: { plan, ...target } });
function put(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function world() {
  const home = canonicalPath(tempHome()), checkout = canonicalPath(tempHome()), clock = makeClock();
  const calls = [], runners = new Map(), prs = new Map(), remoteFiles = new Map();
  const config = { ...structuredClone(CONFIG), home, worktrees: join(checkout, "worktrees"), harness: { codex: { bin: harnessBin(home) } } };
  const runnerFor = id => {
    if (!runners.has(id)) runners.set(id, fakeRunner(clock));
    return runners.get(id);
  };
  const ctx = { home, config, clock, log: silentLog, state: makeState(home), credential: fakeCredential(), identity: fakeIdentity(), runnerFor,
    readPrd: id => existsSync(join(home, "prds", `${idSlug(id)}.md`)) ? readFileSync(join(home, "prds", `${idSlug(id)}.md`), "utf8") : null,
    writePrd: (id, text) => put(join(home, "prds", `${idSlug(id)}.md`), text),
    gh: {
      repoInfo: async root => { calls.push(["repo", root]); return { nameWithOwner: REPO, defaultBranch: "main", repositoryId: "repo-stable-id" }; },
      branchExists: async (repo, branch) => { calls.push(["branch", repo, branch]); return true; },
      refSha: async () => BASE,
      fileAtStrict: async (repo, path, sha, { bytes = false } = {}) => {
        calls.push(["file", repo, path, sha]);
        const value = remoteFiles.get(path) ?? null;
        return bytes || value === null ? value : value.toString("utf8");
      },
      containsCommit: async () => true,
      prView: async (_repo, number) => { calls.push(["pr", number]); return prs.get(number); },
    },
    git: {
      toplevel: async () => checkout,
      planCheckout: async () => ({ root: checkout, repository: REPO }),
      create: async ({ nameWithOwner, prdId }) => {
        const path = join(config.worktrees, nameWithOwner, prdId);
        calls.push(["clone", path]); mkdirSync(path, { recursive: true }); return path;
      },
      containsCommit: async () => true,
      fileAt: async () => null,
    },
  };
  const operator = ({ tenant = "local", principal = "operator-fixture", grant = ({ action }) => `${action}-v1`, qualified = true } = {}) =>
    bindPlanOperator(ctx.state.file, () => ({ principal, tenant, grant,
      isolation: { registry: ctx.state.file, qualified, workerExcluded: qualified, launchDigest: "1".repeat(64), expiresAt: Date.now() + 30_000 } }));
  ctx.planAuthority = operator();
  const brief = (id, text = GOOD_PRD) => put(join(checkout, prd(id)), text);
  const plan = (name, nodes, spec = {}) => {
    const file = put(join(checkout, `${name}.json`), JSON.stringify({ version: 1, name,
      repositories: { demo: { repository: REPO, checkout: ".", base: "main", ...spec } }, nodes }));
    return { file, options: { directory: checkout } };
  };
  const admit = async (input, options = {}) => {
    const { approvalDigest } = await previewPlan(ctx, input);
    return queuePlan(ctx, input, { approve: approvalDigest, ...options });
  };
  return { home, checkout, ctx, calls, runners, prs, remoteFiles, operator, brief, plan, admit };
}

const anchorView = (ctx, name) => inspectPlan(ctx, name).graph.nodes.find(node => node.type === "anchor");
const readState = ctx => readFileSync(ctx.state.file);

test("explicit preview binds exact checkout, host base-file bytes, route, controls and private sources without effects", async () => {
  const { ctx, home, checkout, calls, remoteFiles, brief, plan } = world();
  const carried = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("private source\r\n")]);
  brief("reviewed", GOOD_PRD.replace("harness: codex", "harness: codex\nsources:\n  - docs/private-context.md\naport_decision: reviewed-brief"));
  put(join(checkout, "docs/private-context.md"), carried);
  remoteFiles.set("docs/private-context.md", Buffer.from([0xf5]));
  const input = plan("preview", [task("reviewed")]);
  const preview = await previewPlan(ctx, input);
  const [[, repo]] = preview.bindings.repositories, [[, pinned]] = preview.bindings.tasks;
  assert.equal(repo.repositoryId, "repo-stable-id");
  assert.equal(repo.host, "github.com");
  assert.equal(repo.checkout, ".");
  assert.deepEqual(preview.observation.bases.map(([, head]) => head), [BASE]);
  assert.equal(pinned.readiness.decision, "reviewed-brief");
  assert.equal(pinned.route.harness, "codex");
  assert.equal(pinned.route.modelAccess, "unverified");
  assert.deepEqual(pinned.files[1], { path: "docs/private-context.md", source: "docs/private-context.md", digest: contentDigest(carried), baseDigest: contentDigest(Buffer.from([0xf5])) });
  assert.equal(pinned.files[0].baseDigest, null);
  assert.equal(preview.bindings.limits.maxLiveGraphAuthors, 0);
  assert.deepEqual(preview.bindings.controls[0], ["chain/preview", { generation: 0, active: false }]);
  assert.equal(existsSync(ctx.state.file), false);
  assert.equal(existsSync(join(home, "codex-calls.jsonl")), false);
  assert.equal(existsSync(join(home, "task-mutation.lock")), false);
  assert.equal(calls.some(([kind]) => ["clone", "pr"].includes(kind)), false);
  assert.doesNotMatch(JSON.stringify(preview), /private source|\/private\/|codex-stub/);
  assert.deepEqual(await queuePlan(ctx, input), preview);
  const read = ctx.gh.fileAtStrict;
  ctx.gh.fileAtStrict = async (...args) => { assert.equal(existsSync(join(home, "state.json.lock")), false); assert.equal(existsSync(join(home, "task-mutation.lock")), false); return read(...args); };
  remoteFiles.set("docs/private-context.md", Buffer.from([0xf6]));
  await assert.rejects(queuePlan(ctx, input, { approve: preview.approvalDigest }), { code: "PLAN_STALE" });
  assert.equal(existsSync(ctx.state.file), false);
  remoteFiles.set("docs/private-context.md", Buffer.from([0xf5]));
  const receipt = await queuePlan(ctx, input, { approve: preview.approvalDigest });
  const saved = ctx.state.load().plans;
  assert.equal(saved.blobs[contentDigest(carried)], carried.toString("base64"));
  assert.equal(saved.instances[0].id, receipt.instanceId);
  assert.doesNotMatch(JSON.stringify(inspectPlan(ctx, receipt.instanceId)), /private source|codex-stub/);
});

test("a copied digest, CSRF token, role label, direct CLI and a recovery token confer no plan authority", async () => {
  const { ctx, home, operator, brief, plan } = world();
  brief("secured");
  const input = plan("secured", [task("secured")]);
  const preview = await previewPlan(ctx, input), { approvalDigest } = preview;
  const forged = { type: "operator-intent", principal: "operator-fixture", role: "operator", csrf: "copied", qualified: true };
  for (const planAuthority of [undefined, forged, operator({ qualified: false }), structuredClone(ctx.planAuthority)]) {
    await assert.rejects(queuePlan({ ...ctx, planAuthority }, input, { approve: approvalDigest }), { code: "PLAN_AUTHORITY" });
  }
  const recoveryToken = recoveryAdminIntent(ctx.state.file, "plan/queue", approvalDigest, approvalDigest);
  assert.throws(() => ctx.state.admitPlan(preview, new Map(), approvalDigest, recoveryToken), { code: "PLAN_AUTHORITY" });
  writeJsonAtomic(join(home, "config.json"), ctx.config);
  const direct = spawnSync(process.execPath, [cli, "plan", "queue", input.file, "--dir", input.options.directory, "--approve", approvalDigest],
    { env: { ...process.env, GALLIVANT_HOME: home, PLAN_ROLE: "operator", CSRF_TOKEN: "copied" }, encoding: "utf8", timeout: 10_000 });
  assert.equal(direct.status, 1, direct.stderr);
  assert.match(direct.stderr, /qualified outer boundary/);
  assert.equal(existsSync(ctx.state.file), false);
});

test("simultaneous owners race atomically and response-loss reconciliation never repeats host reads", async () => {
  const { ctx, calls, brief, plan } = world();
  brief("shared");
  const first = plan("first-owner", [task("shared")]), second = plan("second-owner", [task("shared")]);
  const previews = await Promise.all([previewPlan(ctx, first), previewPlan(ctx, second)]);
  const results = await Promise.allSettled([first, second].map((input, i) => queuePlan(ctx, input,
    { approve: previews[i].approvalDigest, requestId: `race-${i}` })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const winner = results.findIndex(result => result.status === "fulfilled"), loser = results[1 - winner];
  assert.equal(loser.reason.code, "PLAN_CONFLICT");
  const saved = ctx.state.load().plans.instances;
  assert.equal(saved.length, 1);
  assert.equal(saved[0].runtime.generation, 0);
  assert.equal(saved[0].control.generation, 0);
  const beforeCalls = calls.length, before = readState(ctx);
  ctx.state = makeState(ctx.home);
  const replay = await queuePlan(ctx, { file: "response-was-lost.json" }, { approve: previews[winner].approvalDigest, requestId: `race-${winner}` });
  assert.deepEqual(replay, results[winner].value);
  assert.equal(calls.length, beforeCalls);
  assert.deepEqual(readState(ctx), before);
  await assert.rejects(queuePlan(ctx, second, { approve: previews[1 - winner].approvalDigest, requestId: `race-${winner}` }), { code: "PLAN_CONFLICT" });
  assert.throws(() => ctx.state.claimStart(`${REPO}/shared`), /graph dispatch is disabled/);
  assert.throws(() => ctx.state.assertCanRegister(`${REPO}/shared`), /reserved/);
  assert.throws(() => ctx.state.put(`${REPO}/shared`, { repo: REPO }), /reserved/);
  assert.throws(() => ctx.state.createChain({ name: "overlap", status: "active", steps: [{ id: `${REPO}/shared` }] }), /already exists/);
});

test("a protected hold changing during host reads invalidates the approval under the registry lock", async () => {
  const { ctx, brief, plan } = world();
  writeJsonAtomic(ctx.state.file, { version: 1, entries: {}, recovery: { version: 1, holds: {}, profiles: [] } });
  brief("controlled");
  const input = plan("controlled", [task("controlled")]);
  const { approvalDigest } = await previewPlan(ctx, input), read = ctx.gh.fileAtStrict;
  const scope = `repo/${REPO}`;
  ctx.gh.fileAtStrict = async (...args) => {
    ctx.gh.fileAtStrict = read;
    ctx.state.setRecoveryHold(scope, "disable", 0, recoveryAdminIntent(ctx.state.file, "disable", scope, 0));
    return read(...args);
  };
  await assert.rejects(queuePlan(ctx, input, { approve: approvalDigest }), { code: "PLAN_STALE" });
  assert.equal(ctx.state.load().plans, undefined);
  assert.equal(ctx.state.load().recovery.holds[scope].generation, 1);
});

test("an admitted graph can be observed at a nonempty frozen join before any task has started", async () => {
  const { ctx, brief, plan, admit } = world();
  for (const id of ["foundation", "unit", "docs", "follow"]) brief(id);
  const producer = await admit(plan("graph", [task("foundation"), {
    id: "checks", type: "group", mode: "parallel", needs: ["foundation"], children: [task("unit"), task("docs")],
  }]));
  await admit(plan("follow", [anchor("graph"), task("follow", ["predecessor"])]));
  const observed = anchorView(ctx, "follow");
  assert.equal(observed.producer.instanceId, producer.instanceId);
  assert.deepEqual(observed.frozen.map(node => node.id), ["checks/docs", "checks/unit"]);
  assert.deepEqual(observed.observed.map(node => node.status), ["waiting", "waiting"]);
  assert.deepEqual(ctx.state.entries(), []);
  assert.throws(() => ctx.state.claimStart(`${REPO}/unit`), /graph dispatch is disabled/);
});

function installLegacyEntry(state, chainName, index, { number, merged = false } = {}) {
  const chain = state.getChain(chainName);
  const steps = structuredClone(chain.steps), step = steps[index];
  step.dispatch = randomUUID();
  state.updateChain(chainName, { index, steps });
  const claim = state.claimStart(step.id, { name: chainName, index, dispatch: step.dispatch });
  const entry = { repo: chain.repo, base: chain.base, branch: branchFor(step.id.split("/").at(-1)), checkout: step.checkout,
    prd: step.relPath, chain: { name: chainName, index, dispatch: step.dispatch }, state: merged ? "done" : "running", harness: step.harness,
    last: { run: `run-${index}`, exit: merged ? 0 : null }, iteration: 5, cursor: { since: T0, fixed_sha: HEAD }, created_at: T0 };
  if (number) Object.assign(entry, { pr: number, url: `https://github.com/${chain.repo}/pull/${number}` });
  state.putStarted(step.id, entry, claim.token);
  return { step, entry: state.get(step.id), claim };
}

test("future boundaries freeze exact legacy nodes, bind PRs later, retain receipts and never adopt producer work", async () => {
  const { ctx, brief, plan, admit } = world();
  await queueChain(ctx, { name: "producer", paths: [brief("first"), brief("tail")] });
  brief("consumer");
  const input = plan("consumer", [anchor("producer"), task("consumer", ["predecessor"])]);
  const initial = await previewPlan(ctx, input);
  const [[, pin]] = initial.bindings.anchors;
  assert.deepEqual(pin.nodes.map(node => node.id), ["tail"]);
  assert.equal(pin.producer.instanceId, ctx.state.getChain("producer").plan_instance);
  assert.match(pin.producer.structuralRevision, /^[a-f0-9]{64}$/);
  assert.equal(ctx.state.get(`${REPO}/tail`), null);
  assert.equal(ctx.state.startClaim(`${REPO}/tail`), null);
  ctx.state.updateChain("producer", { failures: 2, reason: "transient host progress" });
  assert.equal((await previewPlan(ctx, input)).approvalDigest, initial.approvalDigest);
  await queuePlan(ctx, input, { approve: initial.approvalDigest });
  assert.equal(anchorView(ctx, "consumer").observed[0].status, "waiting");
  const exact = { linear: { name: "other-consumer", paths: [brief("other-consumer")], target: futurePlanTarget("other-consumer", undefined, "producer:tail") } };
  await admit(exact);
  const terminal = ctx.state.getChain("producer"), last = terminal.steps[1];
  const extraPath = brief("extra");
  ctx.state.updateChain("producer", { steps: [...terminal.steps, { ...last, id: `${REPO}/extra`, path: extraPath, relPath: prd("extra") }] });
  assert.deepEqual(anchorView(ctx, "consumer").frozen, pin.nodes);
  const { step, entry, claim } = installLegacyEntry(ctx.state, "producer", 1);
  const afterStart = inspectPlan(ctx, "consumer");
  assert.equal(afterStart.approvalDigest, initial.approvalDigest);
  assert.equal(afterStart.controlGeneration, 0);
  assert.ok(afterStart.runtimeGeneration > 0);
  assert.equal(anchorView(ctx, "consumer").observed[0].status, "started");
  assert.equal(ctx.state.get(step.id).start_token, claim.token);
  const pr = { pr: 91, url: `https://github.com/${REPO}/pull/91` };
  ctx.state.update(step.id, pr);
  assert.equal(anchorView(ctx, "other-consumer").observed[0].pr.number, 91);
  const merge = { pr: 91, sha: MERGE, at: T0 }, evidence = { state: "MERGED", repository: REPO, pr: 91, base: "main", head: HEAD, mergeCommit: MERGE, mergedAt: T0 };
  ctx.state.updateChain("producer", chain => ({ steps: chain.steps.map((item, index) => index === 1 ?
    { ...item, entry: { token: claim.token, pr: 91 }, merged: merge } : item) }));
  assert.equal(anchorView(ctx, "consumer").observed[0].status, "merge-unqualified");
  ctx.state.update(step.id, { state: "done", last: { ...entry.last, exit: 0 }, completionEvidence: { terminal: evidence, integration: { ...evidence, qualified: true } },
    workspace_cleanup: { status: "retained", pr: 91, head: HEAD } });
  assert.equal(anchorView(ctx, "consumer").observed[0].receipt.sha, MERGE);
  ctx.state.updateChain("producer", { status: "done", index: 3 });
  ctx.state.remove(step.id);
  const integrated = anchorView(ctx, "consumer").observed[0];
  assert.equal(integrated.status, "integrated");
  assert.equal(integrated.receipt.number, 91);
  const generation = inspectPlan(ctx, "consumer").runtimeGeneration;
  await queueChain(ctx, { name: "later-work", paths: [step.path, brief("later-step")] });
  const replacement = installLegacyEntry(ctx.state, "later-work", 0, { number: 92 });
  assert.notEqual(replacement.claim.token, claim.token);
  assert.deepEqual(anchorView(ctx, "consumer").observed[0], integrated);
  assert.deepEqual(anchorView(ctx, "other-consumer").observed[0], integrated);
  assert.equal(inspectPlan(ctx, "consumer").runtimeGeneration, generation);
  assert.deepEqual(ctx.state.get(step.id), replacement.entry);
  cancelChain(ctx, "later-work");
  ctx.state.remove(step.id);
  ctx.state = makeState(ctx.home);
  assert.deepEqual(anchorView(ctx, "consumer").observed[0], integrated);
  ctx.state.updateChain("producer", chain => ({ steps: chain.steps.map((item, index) => index === 1 ?
    { ...item, merged: { ...merge, sha: "d".repeat(40) } } : item) }));
  assert.deepEqual(anchorView(ctx, "consumer").observed[0], { id: "tail", status: "producer-unavailable" });
  assert.equal(ctx.state.get(`${REPO}/consumer`), null);
});

test("changed, replaced, cancelled and unauthorized producers never satisfy a frozen edge", async () => {
  const { ctx, operator, brief, plan, admit } = world();
  await queueChain(ctx, { name: "producer", paths: [brief("initial"), brief("future")] });
  brief("change"); brief("cancel"); brief("replace"); brief("outbound");
  const consumer = (name, target = "producer") => plan(name, [anchor(target), task(name, ["predecessor"])]);
  await admit(consumer("change"));
  const c = ctx.state.getChain("producer");
  ctx.state.updateChain("producer", { steps: c.steps.map((step, index) => index === 0 ? { ...step, digest: "2".repeat(64) } : step) });
  assert.equal(anchorView(ctx, "change").observed[0].status, "review-required", "a transitive task contract was replaced");
  await admit(consumer("cancel"));
  cancelChain(ctx, "producer");
  assert.equal(anchorView(ctx, "cancel").observed[0].status, "producer-unavailable");
  const current = ctx.state.load();
  current.chains.producer = { ...c, plan_instance: randomUUID() };
  writeJsonAtomic(ctx.state.file, current);
  assert.equal(anchorView(ctx, "cancel").observed[0].status, "producer-unavailable");
  await admit(consumer("replace"));
  const next = ctx.state.load();
  next.chains.producer.plan_instance = randomUUID();
  writeJsonAtomic(ctx.state.file, next);
  assert.equal(anchorView(ctx, "replace").observed[0].status, "producer-unavailable");

  const local = ctx.planAuthority;
  ctx.planAuthority = operator({ tenant: "company-a", grant: ({ action }) => action === "cross-company-link" ? null : `${action}-v1` });
  await assert.rejects(previewPlan(ctx, consumer("outbound")), { code: "PLAN_ANCHOR", message: "A producer is unavailable or the link is not authorized." });
  await assert.rejects(previewPlan(ctx, consumer("outbound", "nobody")), { code: "PLAN_ANCHOR", message: "A producer is unavailable or the link is not authorized." });
  let cross = true;
  ctx.planAuthority = operator({ tenant: "company-a", grant: ({ action }) => action === "cross-company-link" && !cross ? null : `${action}-v1` });
  await admit(consumer("outbound"));
  assert.ok(anchorView(ctx, "outbound").producer.instanceId);
  cross = false;
  const redacted = anchorView(ctx, "outbound");
  assert.deepEqual(redacted, { id: "predecessor", type: "anchor", status: "producer-unavailable" });
  ctx.planAuthority = local;
  assert.throws(() => inspectPlan(ctx, "outbound"), { code: "PLAN_MISSING" });
});

test("cross-plan validation rejects a closed cycle through exact registered PRs without leaving reservations", async () => {
  const { ctx, brief, plan } = world();
  await queueChain(ctx, { name: "a", paths: [brief("a-head"), brief("a-tail")] });
  await queueChain(ctx, { name: "b", paths: [brief("b-head"), brief("b-tail")] });
  const a = installLegacyEntry(ctx.state, "a", 1, { number: 1 }), b = installLegacyEntry(ctx.state, "b", 1, { number: 2 });
  const after = ({ step, entry }) => ({ id: step.id, repo: entry.repo, base: entry.base, branch: entry.branch, pr: entry.pr, url: entry.url });
  // The compatibility edge can reach a planned ancestor through the other chain.
  ctx.state.updateChain("a", { after: after(b) });
  assert.throws(() => ctx.state.updateChain("b", { after: after(a) }), { code: "PLAN_CYCLE" });
  const legacy = ctx.state.load();
  legacy.chains.b.after = after(a); // Pre-upgrade registry with the incompatible closure.
  writeJsonAtomic(ctx.state.file, legacy);
  brief("observer");
  const input = plan("observer", [anchor("a"), task("observer", ["predecessor"])]);
  const proposal = await previewPlan(ctx, input), previous = readState(ctx);
  await assert.rejects(queuePlan(ctx, input, { approve: proposal.approvalDigest }), { code: "PLAN_CYCLE" });
  assert.deepEqual(readState(ctx), previous);
  assert.equal(ctx.state.load().plans, undefined);
});

test("reviewed migration preserves active chain, pending claim and inputs while the legacy successor still starts", async () => {
  const { ctx, brief, prs, runners, calls, plan, admit } = world();
  await queueChain(ctx, { name: "linear", paths: [brief("predecessor"), brief("successor")] });
  await tickChains(ctx);
  const started = ctx.state.get(`${REPO}/predecessor`);
  assert.ok(started?.start_token, ctx.state.getChain("linear").reason);
  await queueChain(ctx, { name: "pending", paths: [brief("pending-first"), brief("pending-tail")] });
  ctx.state.updateChain("pending", chain => ({ steps: chain.steps.map((step, i) => i ? step : { ...step, dispatch: "pending-dispatch" }) }));
  const pending = ctx.state.claimStart(`${REPO}/pending-first`, { name: "pending", index: 0, dispatch: "pending-dispatch" });
  const old = ctx.state.load();
  old.version = RECOVERY_REGISTRY_VERSION;
  delete old.dispatch; // The migration input predates durable dispatch reservations.
  old.recovery = { version: 1, storeId: "existing-recovery-store", profiles: [], holds: {} };
  for (const chain of Object.values(old.chains)) delete chain.plan_instance;
  old.entries[`${REPO}/predecessor`].reviewHistory = [{ key: "pre-existing", evidence: { diff: "private old review" } }];
  writeJsonAtomic(ctx.state.file, old);
  brief("future");
  const baseline = readState(ctx), preview = migratePlans(ctx);
  assert.deepEqual(readState(ctx), baseline, "preview leaves the schema and approvals untouched");
  ctx.state.updateChain("pending", { failures: 1 });
  assert.throws(() => migratePlans(ctx, preview.approvalDigest), { code: "PLAN_STALE" });
  const current = migratePlans(ctx), legacy = ctx.state.load();
  assert.match(current.chains[0].instanceId, /^legacy-/);
  const migrated = migratePlans(ctx, current.approvalDigest);
  assert.equal(migrated.cutover, "disabled");
  assert.equal(ctx.state.load().version, PLAN_REGISTRY_VERSION);
  assert.deepEqual(ctx.state.load().recovery, legacy.recovery);
  assert.deepEqual(ctx.state.load().chains, legacy.chains);
  assert.deepEqual(ctx.state.load().entries, legacy.entries);
  assert.deepEqual(ctx.state.load().starts, legacy.starts);
  assert.deepEqual(migratePlans(ctx, current.approvalDigest), migrated);
  const holdScope = "chain/pending";
  const hold = recoveryAdminIntent(ctx.state.file, "hold", holdScope, 0);
  ctx.state.setRecoveryHold(holdScope, "hold", 0, hold);
  assert.equal(ctx.state.load().version, PLAN_REGISTRY_VERSION);
  assert.equal(ctx.state.load().recovery.holds[holdScope].active, true);
  await admit(plan("future", [anchor("linear"), task("future", ["predecessor"])]));
  const entry = ctx.state.get(`${REPO}/predecessor`);
  runners.get(`${REPO}/predecessor`).finish(codexLines(), { exit: 0 });
  const url = `https://github.com/${REPO}/pull/17`;
  ctx.state.update(`${REPO}/predecessor`, { pr: 17, url, last: { ...entry.last, exit: 0 } });
  prs.set(17, prFixture({ number: 17, url, headRefName: entry.branch, state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: T0 }));
  const onlyLinear = () => ctx.state.chains(([name]) => name === "linear");
  ctx.state = makeState(ctx.home);
  await tickChains(ctx, onlyLinear);
  await tickChains(ctx, onlyLinear);
  assert.equal(calls.filter(([kind]) => kind === "clone").length, 2);
  assert.equal(ctx.state.get(`${REPO}/predecessor`).start_token, entry.start_token);
  assert.ok(ctx.state.get(`${REPO}/successor`).start_token);
  assert.deepEqual(ctx.state.startClaim(`${REPO}/pending-first`), pending);
  assert.equal(ctx.state.get(`${REPO}/future`), null);
  assert.equal(anchorView(ctx, "future").observed[0].status, "started");
});

test("plans, snapshots, owner ledgers and artifact pins survive coherent export and reject partial restore or downgrade", async () => {
  const { ctx, home, brief, plan, admit } = world();
  // The protected embedded runtime already owns a pinned namespace before work starts.
  const digest = manifest.coreSha256;
  migrateRuntimeState({ home, manifest });
  const owner = acquireRuntimeOwner(home);
  try {
    ctx.taskMutationOwner = owner;
    await queueChain(ctx, { name: "prior", paths: [brief("before"), brief("tail")] });
    brief("post");
    await admit(plan("post", [anchor("prior"), task("post", ["predecessor"])]));
    const { step } = installLegacyEntry(ctx.state, "prior", 0, { number: 9 });
    ctx.writePrd(step.id, GOOD_PRD);
    ctx.state.update(step.id, { snapshot_digest: contentDigest(GOOD_PRD), execution: { version: 1, runId: "run-0", acceptance: "accepted", transport: "remote", providerState: "running" } });
    writeJsonAtomic(join(home, "runs", idSlug(step.id), "execution.json"), { version: 1, current: ctx.state.get(step.id) });
    put(join(home, "runs", idSlug(step.id), "run-0", "job.json"), JSON.stringify({ session: "native-session" }));
  } finally { owner.release(); }
  const prior = ctx.state.load();
  const backup = join(tempHome(), "export"), restored = join(tempHome(), "imported");
  assert.equal(checkRuntimeState({ home, manifest }).active, true);
  assert.throws(() => checkRuntimeState({ home, manifest: { ...manifest, registryVersion: RECOVERY_REGISTRY_VERSION } }), { code: "RUNTIME_STATE" });
  assert.throws(() => migrateRuntimeState({ home, manifest: { ...manifest, coreSha256: "f".repeat(64) } }), { code: "RUNTIME_ACTIVE_PIN" });
  backupRuntimeState({ home, out: backup, manifest });
  restoreRuntimeState({ backup, out: restored, manifest });
  assert.deepEqual(makeState(restored).load(), prior);
  assert.deepEqual(readJson(join(restored, "runtime-pin.json")), { version: 1, coreVersion: CORE_VERSION, coreSha256: digest, ...PLAN_RUNTIME_FORMAT });
  const saved = readJson(join(backup, "backup.json"));
  assert.equal(saved.version, 2);
  const removed = `prds/${idSlug(`${REPO}/before`)}.md`;
  delete saved.hashes[removed];
  // Even a rehashed envelope cannot substitute a registry-only distribution.
  saved.namespaceDigest = createHash("sha256").update(JSON.stringify(Object.entries(saved.hashes).sort())).digest("hex");
  writeJsonAtomic(join(backup, "backup.json"), saved);
  const incomplete = join(tempHome(), "incomplete");
  assert.throws(() => restoreRuntimeState({ backup, out: incomplete, manifest }), { code: "RUNTIME_STATE" });
  assert.equal(existsSync(incomplete), false);
  const downgraded = { ...prior, version: 2 };
  writeJsonAtomic(ctx.state.file, downgraded);
  assert.throws(() => makeState(home).load(), { code: "PLAN_STATE" });
});

test("a child that commits then loses its reply remains exactly one durable admission", async () => {
  const { ctx, home, checkout, brief, plan } = world();
  brief("durable");
  const input = plan("durable", [task("durable")]);
  const { approvalDigest } = await previewPlan(ctx, input);
  const script = `
    import { queuePlan } from ${JSON.stringify(planModule)};
    import { makeState } from ${JSON.stringify(stateModule)};
    import { bindPlanOperator } from ${JSON.stringify(intentModule)};
    const [home, checkout, input, config, approve] = JSON.parse(process.argv[1]);
    const state = makeState(home);
    const admit = state.admitPlan;
    state.admitPlan = (...args) => { admit(...args); process.exit(33); };
    const planAuthority = bindPlanOperator(state.file, () => ({ principal: "operator-fixture", tenant: "local", grant: ({ action }) => action + "-v1",
      isolation: { registry: state.file, qualified: true, workerExcluded: true, launchDigest: "1".repeat(64), expiresAt: Date.now() + 10000 } }));
    await queuePlan({ home, state, config, planAuthority, git: { planCheckout: async () => ({ root: checkout, repository: ${JSON.stringify(REPO)} }) }, gh: {
      repoInfo: async () => ({ nameWithOwner: ${JSON.stringify(REPO)}, repositoryId: "repo-stable-id" }), branchExists: async () => true,
      refSha: async () => "a".repeat(40), fileAtStrict: async () => null,
    } }, input, { approve, requestId: "lost-response" });`;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", script,
    JSON.stringify([home, checkout, input, ctx.config, approvalDigest])], { timeout: 10_000 }), { code: 33 });
  const recorded = ctx.state.load().plans.instances[0];
  const receipt = await queuePlan(ctx, input, { approve: approvalDigest, requestId: "lost-response" });
  assert.equal(receipt.instanceId, recorded.id);
  assert.equal(ctx.state.load().plans.instances.length, 1);
});

test("standalone native process denial cannot qualify the installed operator ingress", async () => {
  const report = await probeLearningIsolation();
  assert.equal(report.qualified, false);
  assert.ok(["passed", "failed"].includes(report.standaloneProbe));
});
