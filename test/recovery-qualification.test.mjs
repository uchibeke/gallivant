import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { qualificationCommand, runContracts } from "../scripts/qualify-autonomous-recovery.mjs";
import { checkQualificationEvidence, loadQualification, protectedQualification,
  qualificationBinding, qualificationInventory, qualifiedCombinations } from "../lib/recovery_qualification.mjs";
import { qualifyAdmitted } from "../lib/recovery_qualification_run.mjs";
import { qualificationActions, profileDigest } from "../lib/recovery_authority.mjs";
import { recoveryDigest as digest } from "../lib/recovery_digest.mjs";
import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { prepareRecoveryCanary, recoveryDrainStatus } from "../lib/recovery_rollout.mjs";
import { recoveryHeld } from "../lib/recovery_recipes.mjs";
import { rolloutAllows } from "../lib/recovery_eligibility.mjs";
import { PLAN_REGISTRY_VERSION } from "../lib/registry_versions.mjs";
import { recoveryCommand } from "../lib/commands/recovery.mjs";
import { checkRuntimeState } from "../lib/runtime_state.mjs";
import { acquireRuntimeOwner } from "../lib/daemon.mjs";
import { idSlug, makeState } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { reviewLedgerPath } from "../lib/first_party_review.mjs";
import { parsePrd, prdFingerprint } from "../lib/prd.mjs";
import { CONFIG, GOOD_PRD, fakeGh, fakeGit, fakeNotify, fakeRunner, makeClock, prFixture, seededState, silentLog, tempHome } from "./helpers.mjs";

const key = s => digest(s);
const head = "a".repeat(40), base = "b".repeat(40), merge = "c".repeat(40);
const allowance = { mutations: 20, paidTurns: 20, spendMicros: 1000 };
const route = { harness: "claude", provider: "fixture", model: "fixture", account: "operator",
  environment: "fixture", dataLocation: "fixture", credentialRef: "credential:fixture",
  capabilities: ["verify-disposable-isolation", "continue-session", "repair-owned-merge"], maxSpendMicros: 100 };

function profileFor(state, fields = {}) {
  const profile = { version: 1, id: "recovery", storeId: "coordinator", revision: 1, mode: "recover",
    routes: [route], recipes: ["qualification", "provider-continuation", "git-repair"].map(id => ({ id, version: 1, limits: allowance })),
    taskLimits: allowance, cleanup: [], holdGeneration: 0, revocationGeneration: 0, qualification: null, ...fields };
  profile.digest = profileDigest(profile);
  state.putRecoveryProfile(profile, null, recoveryAdminIntent(state.file, "profile", profile.digest, null));
  return profile;
}

function manifestFixture() {
  const { state, id, home } = seededState();
  const clock = makeClock(), artifact = { source: key("source"), package: key("package"), registry: 3 };
  const environment = { platform: process.platform, arch: process.arch, node: process.version, digest: key("environment") };
  const roles = ["native", "supervisor", "verification", "preparation", "host", "reviewer", "execution", "maintainer",
    "delivery", "chain", "aggregate", "fixtures"];
  const keys = Object.fromEntries(roles.map(role => [role, generateKeyPairSync("ed25519")]));
  const signers = Object.fromEntries(roles.map(role => [role, keys[role].publicKey.export({ format: "der", type: "spki" }).toString("base64url")]));
  const overnight = 6 * 60 * 60_000;
  const shared = (id, mode) => ({ id, mode, task: key(["task", id]), operation: key(["operation", id]), route: key(route),
    startsAt: clock.now() - (mode === "overnight" ? overnight : 1000),
    deadlineMs: 60_000 + (mode === "overnight" ? overnight : 0), environment, maxSpendMicros: 0, maxTurns: 0 });
  const makeCase = (surface, mode, i, outcome = "recovered") => {
    const id = `${surface}-${mode}-${i}`;
    return { ...shared(id, mode), surface, outcome, maxTurns: outcome === "authority-gate" ? 0 : 2,
      ...(mode === "overnight" ? { unattendedMs: overnight } : {}),
      fault: outcome === "authority-gate" ? "authority" : i % 2 ? "host-cooldown" : "git-interruption",
      repository: { identity: `${surface === "github" ? "github.com" : "bitbucket.org"}/fixture/${surface}`, id: key(surface), credentialRef: route.credentialRef },
      review: { policy: key("policy"), externalActor: key("actor"), localRoute: key(route), capture: false },
      refs: { base: "test-base", head: `test-fixtures/${id}`, prefix: "test-fixtures", headSha: head, baseSha: base, patchDigest: key("static patch") },
      recipes: outcome === "authority-gate" ? [] : ["provider-continuation", "git-repair"] };
  };
  const cases = ["linux", "darwin"].map(platform => ({ ...shared(platform, "native"), environment: platform === environment.platform
    ? environment : { ...environment, platform, digest: key(platform) } }));
  for (const phase of ["live", "overnight"]) for (const [i, surface] of ["github", "bitbucket-private", "bitbucket-public"].entries()) cases.push(makeCase(surface, phase, i));
  cases.push(makeCase("github", "overnight", 4, "authority-gate"));
  const manifest = { version: 1, purpose: "disposable-synthetic-recovery", artifact, signers, cases,
    limits: { startsAt: clock.now() - overnight, expiresAt: clock.now() + 100_000, evidenceExpiresAt: clock.now() + 200_000,
      maxSpendMicros: 1000, maxTurns: 20 } };
  const root = realpathSync(tempHome()), dir = join(root, "manifests"), manifestPath = join(dir, "test.json");
  mkdirSync(dir); mkdirSync(join(root, "cases"));
  const write = (file, value) => writeFileSync(join(root, file), JSON.stringify(value));
  write("manifests/test.json", manifest);
  const profile = profileFor(state, { id: "qualification", qualification: { reference: "manifest:test",
    digest: digest(manifest), evidenceRoot: root, actions: ["verify-disposable-isolation", ...Object.values(qualificationActions)] } });
  state.update(id, { recovery_profile: { version: 1, digest: profile.digest } });
  const ctx = { state, clock, home, config: CONFIG, qualificationArtifact: artifact };
  const scope = () => loadQualification(ctx, id, "check-evidence", artifact);
  const proof = (role, record) => ({ record, signature: sign(null, Buffer.from(digest(record), "hex"), keys[role].privateKey).toString("base64url") });
  const bundle = test => {
    const steps = test.mode === "native" ? {
      process: ["native", { exactIdentity: true, liveLockPreserved: true, deadOwnerRecovered: true }],
      cancellation: ["native", { exactRun: true, ceased: true, foreignUntouched: true }],
      journal: ["native", { durable: true, preservedPrefix: true, replays: 1 }], cleanup: ["native", { ownedOnly: true, preservedUniqueWork: true }],
      supervisor: ["supervisor", { independentlyConfigured: true, pinned: true, deadOnly: true, throttled: true }],
      isolation: ["verification", { protectedState: true, credentialBoundary: true }],
    } : test.outcome === "authority-gate" ? {
      gate: ["host", { stopped: true, reason: "authority", hostWrites: 0, startedAt: test.startsAt, unattendedMs: overnight }],
      noDispatch: ["execution", { chargeMicros: 0, submissions: 0, successors: 0 }],
    } : {
      preparation: ["preparation", { approvedOnly: true, isolated: true, credentialBoundary: true }],
      publication: ["host", { pr: 1, count: 1, repository: test.repository.id, head: test.refs.head, base: test.refs.base, headSha: head }],
      externalReview: ["host", { headSha: head, actor: test.review.externalActor, policy: test.review.policy, clear: true }],
      localReview: ["reviewer", { headSha: head, route: test.review.localRoute, policy: test.review.policy, clear: true }],
      ciRepair: ["verification", { headSha: head, relevantFailure: true, relevantCheckGreen: true }],
      faultRecovery: ["execution", { fault: test.fault, recovered: true, duplicateSubmissions: 0, spendMicros: 0,
        turns: 2, manualResumes: 0, unsafeTakeovers: 0, lostWork: 0, falseTerminations: 0,
        startedAt: test.startsAt, unattendedMs: test.unattendedMs ?? 0 }],
      maintainer: ["maintainer", { pr: 1, repository: test.repository.id, head: test.refs.head, base: test.refs.base,
        headSha: head, baseSha: base, patchDigest: test.refs.patchDigest, authority: "external-maintainer" }],
      merge: ["host", { pr: 1, headSha: head, baseSha: base, patchDigest: test.refs.patchDigest, mergeSha: merge, baseContainsMerge: true }],
      cessation: ["execution", { exactRun: true, ceased: true }],
      closeout: ["delivery", { delivered: true, ownedCleanupSettled: true, preservedUniqueWork: true }],
      successor: ["chain", { claims: 1, starts: 1 }],
      "recipe:provider-continuation": ["execution", { recipe: "provider-continuation", version: 1,
        route: test.route, operation: test.operation, postcondition: "execution-settled" }],
      "recipe:git-repair": ["execution", { recipe: "git-repair", version: 1,
        route: test.route, operation: key([test.id, "repair"]), postcondition: "verified-merge-published" }],
    };
    const binding = qualificationBinding(scope(), test);
    return Object.fromEntries(Object.entries(steps).map(([step, [role, facts]]) =>
      [step, proof(role, { version: 1, binding, step, observedAt: clock.now(), result: "passed", observation: key([test.id, step]), facts })]));
  };
  const receipts = () => {
    const binding = digest([profile.qualification.digest, profile.digest, digest(id), artifact]);
    const fixture = { version: 1, binding, aggregate: key("isolated fixtures"), result: "passed" };
    write("fixtures.json", proof("fixtures", fixture));
    const cases = Object.fromEntries(manifest.cases.map(test => {
      const receipt = bundle(test);
      write(`cases/${test.id}.json`, receipt);
      return [test.id, digest(receipt)];
    }));
    const p = { p50: 1, p95: 2, p99: 3 };
    const aggregate = { version: 1, binding, fixture: digest(fixture), cases, result: "passed",
      capacity: { workload: 12, capacity: 12, cycles: 20, healthyRuns: 10, duplicateSubmissions: 0, unsafeTakeovers: 0,
        lostWork: 0, falseTerminations: 0, falseRecoveries: 0, scanSeconds: 60, boundedIoMs: 500, maxDiagnosisMs: 500, queueMs: p, cycleMs: p } };
    write("aggregate.json", proof("aggregate", aggregate));
    return aggregate;
  };
  return { id, ctx, root, manifest, manifestPath, artifact, environment, scope, write, proof, bundle, receipts };
}

test("fixture contracts aggregate named test successes on the configured runtime", () => {
  const name = "qualification resolves only the exact protected manifest and rejects CLI authority";
  const report = runContracts(["recovery-qualification.test.mjs"], [name], Date.now() + 15_000);
  assert.equal(report.result, "passed");
  assert.equal(report.passed, 1);
  assert.deepEqual(report.missing, []);
});

test("qualification resolves only the exact protected manifest and rejects CLI authority", async () => {
  const f = manifestFixture(), { ctx, id, artifact } = f;
  for (const args of [[], ["--fixtures", "--native"], ["--live=fixture"], ["--skip"]])
    await assert.rejects(qualificationCommand(args, { ctx, task: id }), /Choose exactly one/);
  assert.throws(() => protectedQualification(ctx, "a different task", "live"), /operator must pin/);
  assert.equal(loadQualification(ctx, id, "native", artifact).manifest.cases.length, 9);
  assert.throws(() => loadQualification(ctx, id, "live", { ...artifact, registry: 2 }), /exact source/);
  assert.equal(new Set(qualificationInventory().map(row => row.surface + row.harness + row.owner)).size, qualificationInventory().length);
  assert.ok(qualificationInventory().every(row => row.recovery === "observe-only"));
  f.write("manifests/test.json", { ...f.manifest, extra: "unapproved" });
  assert.throws(f.scope, /protected digest/);
});

test("protected evidence rejects missing, copied, tampered and partial aggregate receipts read-only", async () => {
  const f = manifestFixture();
  const aggregate = f.receipts();
  const alternate = f.manifest.cases[0], selected = f.manifest.cases[1];
  f.ctx.disposableQualificationOwner = { baselineFor: () => assert.fail("no effects while checking evidence") };
  assert.equal((await qualifyAdmitted(f.ctx, f.id, "check-evidence", f.artifact, f.environment)).digest, digest(aggregate));
  const file = `cases/${alternate.id}.json`;
  f.write(file, f.bundle(selected));
  assert.throws(() => checkQualificationEvidence(f.scope()), /cross-case/);
  const altered = f.bundle(alternate);
  altered.process.record.observation = key("changed");
  f.write(file, altered);
  assert.throws(() => checkQualificationEvidence(f.scope()), /invalid independent native signature/);
  unlinkSync(join(f.root, file));
  assert.throws(() => checkQualificationEvidence(f.scope()), /Missing protected evidence/);
  linkSync(join(f.root, `cases/${selected.id}.json`), join(f.root, file));
  assert.throws(() => checkQualificationEvidence(f.scope()), /Unsafe evidence path/);
  unlinkSync(join(f.root, file));
  f.write(file, f.bundle(alternate));
  delete aggregate.cases[alternate.id];
  f.write("aggregate.json", f.proof("aggregate", aggregate));
  assert.throws(() => checkQualificationEvidence(f.scope()), /every bound case/);
});

test("only independent maintainer and host receipts can clear the scoped static fixture merge", () => {
  const f = manifestFixture(); f.receipts();
  const scenario = f.manifest.cases.find(item => item.mode === "live");
  const receipt = f.bundle(scenario);
  receipt.maintainer = f.proof("maintainer", { ...receipt.maintainer.record, facts: { ...receipt.maintainer.record.facts, authority: "fixture-driver" } });
  f.write(`cases/${scenario.id}.json`, receipt);
  assert.throws(() => checkQualificationEvidence(f.scope()), /Automatic fixture merge is unavailable/);
  receipt.maintainer = f.proof("execution", receipt.maintainer.record);
  f.write(`cases/${scenario.id}.json`, receipt);
  assert.throws(() => checkQualificationEvidence(f.scope()), /maintainer signature/);
  receipt.maintainer = f.proof("maintainer", { ...receipt.maintainer.record, facts: { ...receipt.maintainer.record.facts, authority: "external-maintainer", baseSha: head } });
  f.write(`cases/${scenario.id}.json`, receipt);
  assert.throws(() => checkQualificationEvidence(f.scope()), /exact static patch/);
});

test("the disposable launcher rechecks the original scope after independent owner preparation", async () => {
  const f = manifestFixture(), { ctx, id, artifact, environment } = f;
  f.receipts();
  const native = f.manifest.cases.find(test => test.mode === "native" && test.environment.platform === process.platform);
  unlinkSync(join(f.root, "cases", `${native.id}.json`));
  ctx.readPrd = () => GOOD_PRD;
  const run = { id: "driver-original", running: false, execution: { version: 1, provider: "claude", taskId: id,
    runId: "driver-original", operationId: "original", acceptance: "accepted", collected: true, providerState: "succeeded",
    recoveryRouteDigest: key(route) } };
  ctx.state.update(id, { last: { run: run.id, exit: 0 } });
  ctx.executionFor = () => ({ current: () => run });
  const admitted = request => ({ binding: request.binding, environment: environment.digest,
    disposableOnly: true, owned: true, isolated: true, launchDigest: key("protected launch"), expiresAt: ctx.clock.now() + 1000 });
  const scope = "profile/qualification";
  ctx.disposableQualificationOwner = {
    baselineFor: async request => {
      for (const [generation, action] of ["disable", "enable"].entries())
        ctx.state.setRecoveryHold(scope, action, generation, recoveryAdminIntent(ctx.state.file, action, scope, generation));
      return admitted(request);
    },
    reconcileCase: async () => assert.fail("disabled approval authorizes no effects"),
  };
  await assert.rejects(qualifyAdmitted(ctx, id, "native", artifact, environment), /binding changed/);
  ctx.disposableQualificationOwner = {
    baselineFor: async request => admitted(request),
    reconcileCase: async (request, { beforeEffect }) => {
      beforeEffect();
      assert.equal(request.operationKey, native.operation);
      return f.bundle(native);
    },
  };
  assert.equal((await qualifyAdmitted(ctx, id, "native", artifact, environment)).cases.length, 2);
});

test("canaries require complete evidence, advance explicitly, and fence a stale reviewed task binding", () => {
  const f = manifestFixture(), proof = f.receipts(), { ctx, id, artifact, environment } = f;
  const profile = profileFor(ctx.state, { id: "canary" }), task = "acme/canary/selected";
  ctx.state.put(task, { repo: "acme/canary", branch: "work/selected", base: "main", recovery_profile: { version: 1, digest: profile.digest } });
  const selected = { version: 1, generation: 0, stage: "observe", profile: profile.digest,
    tasks: [task], combinations: [], evidence: null, qualificationTask: null };
  const admit = approval => {
    const record = prepareRecoveryCanary(ctx, approval);
    return ctx.state.commitRecoveryCanary(record, approval.generation, recoveryAdminIntent(ctx.state.file, "canary", digest(record), approval.generation));
  };
  const operational = { ...selected, generation: 1, stage: "operational", evidence: digest(proof),
    combinations: qualifiedCombinations(f.scope()), qualificationTask: id };
  const check = (recipe, registry = ctx.state.load()) => rolloutAllows(registry, task, profile, route, recipe, { artifact: digest(artifact),
    surface: "github", environment }, ctx.clock.now());
  assert.throws(() => admit({ ...operational, generation: 0 }), /stage/);
  admit(selected);
  assert.equal(check("provider-continuation"), false);
  assert.throws(() => admit({ ...operational, combinations: [key("foreign route")] }), /unqualified/);
  admit(operational);
  assert.equal(check("provider-continuation"), true);
  assert.equal(check("provider-continuation", { ...ctx.state.load(), version: PLAN_REGISTRY_VERSION }), true);
  assert.equal(check("git-repair"), false);
  const semantic = { ...operational, stage: "semantic", generation: 2 }, reviewed = prepareRecoveryCanary(ctx, semantic);
  ctx.state.update(task, { snapshot_digest: key("replacement") });
  assert.throws(() => ctx.state.commitRecoveryCanary(reviewed, 2, recoveryAdminIntent(ctx.state.file, "canary", digest(reviewed), 2)), /bindings/);
  assert.equal(check("provider-continuation"), false);
});

function adoptionFixture() {
  const { state, home, id } = seededState();
  const profile = profileFor(state), checkout = join(home, "checkout"), slug = idSlug(id);
  const prd = "docs/prds/widget-export.md";
  mkdirSync(join(checkout, "docs/prds"), { recursive: true });
  mkdirSync(join(home, "prds")); mkdirSync(join(home, "runs", slug), { recursive: true });
  writeFileSync(join(checkout, prd), GOOD_PRD); writeFileSync(join(home, "prds", `${slug}.md`), GOOD_PRD);
  const journal = { version: 1, total: { mutations: 1, paidTurns: 1, spendMicros: 4 }, intents: {} };
  const run = { id: "owner", running: false, execution: { version: 1, taskId: id, provider: "claude", runId: "owner",
    operationId: "original-op", acceptance: "accepted", collected: true, providerState: "succeeded" } };
  state.update(id, { state: "needs-human", reason: "no-pr", pr: null, prd, checkout, recovery_actions: journal,
    last: { run: "owner", exit: 0 }, prd_fingerprint: prdFingerprint(parsePrd(GOOD_PRD, id)),
    reviewHistory: [{ key: "reviewed", disposition: { status: "resolved" }, evidence: { digest: key("history") } }] });
  writeFileSync(reviewLedgerPath(join(home, "reviews"), id), JSON.stringify({ version: 1, id, jobs: {} }));
  const root = join(home, "runs", slug), ledger = join(root, "execution.json");
  const original = { version: 1, taskId: id, provider: "claude", current: run, operations: { "original-op": { runId: run.id, acceptance: "accepted" } } };
  writeFileSync(ledger, JSON.stringify(original));
  const read = file => JSON.parse(readFileSync(file));
  const ctx = { state, home, config: CONFIG, readPrd: () => GOOD_PRD, executionFor: () => ({ root, current: () => read(ledger).current, state: () => read(ledger) }) };
  const dir = realpathSync(tempHome()), approvalPath = join(dir, "approved.json"), out = join(dir, "backup");
  const approve = async () => {
    const plan = await recoveryCommand(ctx, ["inventory", profile.id]);
    assert.deepEqual(plan.candidates.map(c => c.id), [id]);
    writeFileSync(approvalPath, JSON.stringify({ version: 1, candidateIds: [id], proposalDigest: plan.digest }));
  };
  return { ctx, id, home, ledger, original, journal, slug, out, approve,
    adopt: () => recoveryCommand(ctx, ["adopt", profile.id, approvalPath, out]) };
}

test("reviewed adoption backs up the exact ledgers and atomically preserves ownership and budgets", async () => {
  const f = adoptionFixture(); await f.approve();
  const stateBefore = readFileSync(f.ctx.state.file);
  const owner = acquireRuntimeOwner(f.home);
  try { await assert.rejects(f.adopt(), /already running|still occupied/); } finally { owner.release(); }
  assert.deepEqual(readFileSync(f.ctx.state.file), stateBefore);
  writeFileSync(f.ledger, JSON.stringify({ ...f.original, extra: true }));
  await assert.rejects(f.adopt(), /no longer matches/);
  writeFileSync(f.ledger, JSON.stringify(f.original));
  const change = await f.adopt(), state = makeState(f.home);
  assert.deepEqual(change.adopted, [f.id]);
  assert.deepEqual(readFileSync(join(f.out, "state.json")), stateBefore);
  assert.deepEqual(readFileSync(join(f.out, "runs", f.slug, "execution.json")), readFileSync(f.ledger));
  assert.deepEqual(state.reviewHistory(f.id), [{ key: "reviewed", disposition: { status: "resolved" }, evidence: { digest: key("history") } }]);
  const history = state.get(f.id).reviewHistory[0]._gallivantReviewArchive.digest;
  assert.deepEqual(readFileSync(join(f.out, "reviews", "history", `${history}.json`)), readFileSync(join(f.home, "reviews", "history", `${history}.json`)));
  assert.equal(state.load().version, 3);
  assert.deepEqual(state.get(f.id).recovery_actions, f.journal);
  assert.equal(state.get(f.id).last.run, "owner");
  const oldRuntime = { coreVersion: "0.3.0", operationVersion: 1, taskVersion: 1, executionVersion: 1 };
  assert.throws(() => checkRuntimeState({ home: f.home, manifest: oldRuntime }), /Unsupported registry/);
  state.update(f.id, { recovery_actions: { ...f.journal, intents: { outstanding: { phase: "executing" } } } });
  assert.deepEqual(recoveryDrainStatus(state).pending[0].retained, ["recovery reservation"]);
});

test("profile disable preserves merged closeout without reopening paid work", async () => {
  const { state, id } = seededState({ state: "needs-human", reason: "reviewer-silent" });
  const profile = profileFor(state), scope = `profile/${profile.id}`;
  state.update(id, { recovery_profile: { version: 1, digest: profile.digest } });
  state.setRecoveryHold(scope, "disable", 0, recoveryAdminIntent(state.file, "disable", scope, 0));
  assert.equal(recoveryHeld(state.load(), id, state.get(id)), true);
  const clock = makeClock(), runner = fakeRunner(clock);
  const gh = fakeGh({ pr: prFixture({ headRefOid: head, baseRefOid: base, state: "MERGED",
    headRepository: { nameWithOwner: "acme/widget" }, baseRepository: { nameWithOwner: "acme/widget" },
    mergeCommit: { oid: merge }, mergedAt: new Date(clock.now()).toISOString() }) });
  gh.containsCommit = async () => true;
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), clock, notify: fakeNotify(), log: silentLog,
    ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD,
    cleanupMergedWorkspace: async () => ({ status: "retained", pr: 142, head }) });
  await tick.tickEntry(id, state.get(id));
  assert.equal(state.get(id).state, "done");
  assert.equal(state.get(id).completionEvidence.terminal.mergeCommit, merge);
  assert.equal(runner.started.length, 0);
});

test("a pre-disable successor claim cannot survive repository re-enable", () => {
  const { state } = seededState();
  profileFor(state);
  const id = "acme/widget/successor", name = "next", dispatch = "approved";
  state.createChain({ name, repo: "acme/widget", status: "active", index: 0, steps: [{ id, dispatch }] });
  const chain = { name, index: 0, dispatch, holdGenerations: [0, 0, 0] };
  const claim = state.claimStart(id, chain);
  for (const [generation, action] of ["disable", "enable"].entries()) {
    const scope = "repo/acme/widget";
    state.setRecoveryHold(scope, action, generation, recoveryAdminIntent(state.file, action, scope, generation));
  }
  assert.throws(() => state.validateStart(id, claim.token, chain), /no longer authorizes/);
  state.releaseStart(id, claim.token);
  assert.equal(state.getChain(name).steps[0].dispatch, dispatch);
  assert.throws(() => state.claimStart(id, chain), /no longer authorizes/);
  const current = { ...chain, holdGenerations: [0, 2, 0] };
  assert.ok(state.validateStart(id, state.claimStart(id, current).token, current) === undefined);
});
