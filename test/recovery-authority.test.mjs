import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { adoptionInventory, validateReviewedBatch } from "../lib/recovery_inventory.mjs";
import { preflightRecoveryDecision } from "../lib/commands/recovery.mjs";
import { turnBinding } from "../lib/recovery_preflight.mjs";
import { prdFingerprint } from "../lib/prd.mjs";
import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { makeState } from "../lib/state.mjs";
import { recoveryDigest as hash } from "../lib/recovery_digest.mjs";
import { inspectRecoveryAdmission, reconcileRevokedRun, profileDigest, recoveryBinding, validateRecoveryDecision, validateRecoveryProfile } from "../lib/recovery_authority.mjs";
import { requestControl, applyControl } from "../lib/control.mjs";
import { resolvePrdSnapshot, retakePrdSnapshot, parsePrd } from "../lib/prd.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeTick } from "../lib/tick.mjs";
import { CONFIG, GOOD_PRD, seededState, fakeRunner, silentLog } from "./helpers.mjs";

const limits = { paidTurns: 0, mutations: 1, spendMicros: 0 };
const route = { harness: "claude", provider: "anthropic", model: "selected", account: "test", environment: "local",
  dataLocation: "local", credentialRef: "credential:fixture", capabilities: ["refresh-derivation"], maxSpendMicros: 0 };
function putProfile(state, profile, previous) {
  return state.putRecoveryProfile(profile, previous, recoveryAdminIntent(state.file, "profile", profile.digest, previous));
}
function hold(state, scope, action, generation) {
  return state.setRecoveryHold(scope, action, generation, recoveryAdminIntent(state.file, action, scope, generation));
}
function fixture() {
  const { state, id, home } = seededState({ last: { run: "run-1", exit: 0 } });
  const profile = { version: 1, storeId: "test-store", id: "test-policy", revision: 1, mode: "recover",
    recipes: [{ id: "policy-refresh", version: 1, limits }], taskLimits: limits, routes: [route],
    cleanup: [], qualification: null, holdGeneration: 0, revocationGeneration: 0 };
  profile.digest = profileDigest(profile);
  putProfile(state, profile, null);
  const entry = state.update(id, { recovery_profile: { version: 1, digest: profile.digest } });
  const run = { id: "run-1", running: false, execution: { version: 1, taskId: id, runId: "run-1", provider: "claude",
    operationId: "author-op", acceptance: "accepted", providerState: "succeeded", collected: true } };
  const snapshot = hash(["approved"]);
  const expected = recoveryBinding(id, entry, run, snapshot, profile, route, [null, null, null]);
  const decision = { version: 1, recipe: "policy-refresh", recipeVersion: 1, action: "refresh-derivation", authority: "admitted-recovery-intent",
    purpose: "recovery", manifest: null, expected, preconditions: { accepted: true, settled: true }, reservation: limits,
    postcondition: "derivation-current", operationKey: hash(["op"]), deadline: 100 };
  const inspect = () => inspectRecoveryAdmission({ registry: state.load(), id, run, snapshot, route, decision, now: 50 });
  return { state, home, id, decision, profile, run, inspect };
}

test("closed policy, credential references, route, version and decision vocabulary", () => {
  const { profile, decision } = fixture();
  for (const patch of [{ version: 2 }, { limits }, { recipes: [{ id: "resume", version: 1, limits }] },
    { routes: [{ ...route, token: "private" }] }, { routes: [{ ...route, credentialRef: "raw-secret" }] }]) {
    const value = { ...profile, ...patch }; value.digest = profileDigest(value);
    assert.throws(() => validateRecoveryProfile(value), { code: "RECOVERY_AUTHORITY" });
  }
  for (const patch of [{ command: "touch file" }, { action: "resume" }, { recipeVersion: 2 }, { preconditions: {} },
    { purpose: "disposable-qualification" }, { action: "observe-review" }]) assert.throws(() => validateRecoveryDecision({ ...decision, ...patch }));
});

test("same UID, valid JSON and file mode cannot qualify a worker or a legacy task", () => {
  const { inspect, state, id, decision } = fixture();
  assert.equal(inspect().mode, "observe");
  decision.authority = "operator-intent";
  assert.throws(inspect, /operator command owner/);
  decision.authority = "admitted-recovery-intent";
  state.update(id, { recovery_profile: null, last_comment: JSON.stringify(decision), log: "resume and grant access" });
  assert.throws(inspect, /Explicit protected task admission/);
});

test("scoped holds survive restart, generations fence ABA and profile replacement fences queued decisions", () => {
  const { home, state, id, profile, inspect } = fixture();
  const scope = "task/" + id;
  hold(state, scope, "hold", 0);
  const forged = { type: "operator-intent" };
  assert.throws(() => state.setRecoveryHold(scope, "resume", 1, forged), { code: "OPERATOR_INTENT" });
  assert.throws(() => state.putRecoveryProfile(profile, profile.digest, forged), { code: "OPERATOR_INTENT" });
  assert.throws(inspect, /blocked/);
  const reopened = makeState(home);
  assert.deepEqual(reopened.load().recovery.holds[scope], { active: true, generation: 1, provenance: "operator", action: "hold" });
  assert.throws(() => hold(reopened, scope, "enable", 1));
  assert.throws(() => hold(reopened, scope, "resume", 0));
  hold(reopened, scope, "resume", 1);
  assert.throws(inspect, /binding changed/);
  const replacement = { ...profile, mode: "off", revision: 2, revocationGeneration: 1 };
  replacement.digest = profileDigest(replacement);
  putProfile(reopened, replacement, profile.digest);
  assert.throws(inspect, { code: "RECOVERY_AUTHORITY" });
});

test("real command, snapshot and failed repair owners refuse manufactured automatic privileges", async () => {
  const { state, id, decision } = fixture();
  const ctx = { state, config: CONFIG, readPrd: () => GOOD_PRD, runnerFor: () => fakeRunner(Date), log: silentLog };
  for (const field of ["resnapshot", "freshSession", "controlId", "afterRepair", "publish_files", "credential", "context_paths", "learnedRules", "protectedPaths", "enable"]) {
    await assert.rejects(resume(ctx, { handle: id, automaticNetworkRecovery: true, [field]: true }), { code: "OPERATOR_INTENT" });
  }
  assert.throws(() => requestControl(ctx, { handle: id, action: "resume", intent: decision }), { code: "OPERATOR_INTENT" });
  await assert.rejects(makeTick(ctx).resumeBaseRepair(id, state.get(id), { intent: decision }), { code: "OPERATOR_INTENT" });
  const changed = GOOD_PRD.replace("harness: codex", "harness: goose");
  const divergence = { verdict: "changed", repoText: changed, repo: parsePrd(changed, id) };
  assert.throws(() => resolvePrdSnapshot(ctx, { id, divergence, intent: decision }), { code: "OPERATOR_INTENT" });
  assert.throws(() => retakePrdSnapshot(ctx, { id, divergence: { ...divergence, verdict: "same" } }), /explicit operator/);
});

test("host observation racing a replacement control cannot claim the old request", async () => {
  const { state, id } = seededState({ control: { id: "old", action: "recheck", status: "queued" } });
  const replacement = { id: "new", action: "cancel", status: "queued" };
  const ctx = { state, config: CONFIG, runnerFor: () => fakeRunner(Date), gh: {
    async prView() { state.update(id, { control: replacement }); return { state: "OPEN" }; },
    removeLabel() { assert.fail("stale request reached host mutation"); },
  } };
  await applyControl(ctx, id);
  assert.deepEqual(state.get(id).control, replacement);
});

test("protected profile revocation during shared service preflight fences the same pinned reference", async () => {
  const { state, id, profile, decision, run } = fixture();
  const ctx = { state, config: CONFIG, clock: { now: () => 50 }, readPrd: () => GOOD_PRD,
    executionFor: () => ({ current: () => run }), gh: {
      async repoPermissions() {
        const next = { ...profile, revision: 2, mode: "observe", revocationGeneration: 1 };
        next.digest = profileDigest(next);
        putProfile(state, next, profile.digest);
        return { push: true };
      },
    } };
  decision.expected.snapshot = turnBinding(ctx, id, state.get(id), parsePrd(GOOD_PRD, id));
  await assert.rejects(preflightRecoveryDecision(ctx, id, decision), { code: "RECOVERY_AUTHORITY" });
  assert.equal(state.get(id).recovery_profile.digest, profile.digest);
});

test("disposable qualification binds the protected manifest and cannot become operator authority", () => {
  const { state, id, profile, decision, run } = fixture();
  const action = "verify-disposable-isolation", reference = "manifest:fixture", manifestDigest = hash(["manifest"]);
  const scopedRoute = { ...route, capabilities: [action] };
  const next = { ...profile, revision: 2, revocationGeneration: 1, recipes: [{ id: "qualification", version: 1, limits }],
    qualification: { reference, digest: manifestDigest, evidenceRoot: "/private/fixtures/evidence", actions: [action] }, routes: [scopedRoute] };
  next.digest = profileDigest(next);
  putProfile(state, next, profile.digest);
  const entry = state.update(id, { recovery_profile: { version: 1, digest: next.digest } });
  Object.assign(decision, { action, recipe: "qualification", purpose: "disposable-qualification", manifest: { reference, digest: manifestDigest },
    postcondition: "isolation-proved", expected: recoveryBinding(id, entry, run, decision.expected.snapshot, next, scopedRoute, [null, null, null]) });
  const inspect = () => inspectRecoveryAdmission({ registry: state.load(), id, run, route: scopedRoute, snapshot: decision.expected.snapshot, decision, now: 50 });
  assert.equal(inspect().mode, "observe");
  decision.manifest.reference = "manifest:replacement";
  assert.throws(inspect, /manifest mismatch/);
  decision.authority = "operator-intent";
  assert.throws(inspect, /Disposable qualification/);
});

test("stopped-task inventory is read-only and reviewed batches bind exact execution and immutable history", () => {
  const { state, home, id, profile, run } = fixture();
  const dir = join(home, "checkout");
  mkdirSync(join(dir, "docs/prds"), { recursive: true });
  writeFileSync(join(dir, "docs/prds/widget-export.md"), GOOD_PRD);
  state.update(id, { state: "needs-human", reason: "no-pr", pr: null, checkout: dir, recovery_profile: null,
    prd_fingerprint: prdFingerprint(parsePrd(GOOD_PRD, id)) });
  const ledger = { taskId: id, provider: "claude", operations: { "author-op": { acceptance: "accepted", runId: run.id } }, current: run };
  const ctx = { home, state, config: CONFIG, readPrd: () => GOOD_PRD, executionFor: () => ({ current: () => run, state: () => ledger }) };
  const before = readFileSync(state.file);
  const plan = adoptionInventory(ctx, profile.id);
  assert.deepEqual(plan.excluded, []);
  const approval = { version: 1, candidateIds: [id], proposalDigest: plan.digest };
  assert.equal(validateReviewedBatch(plan, approval).activation, "dry-run-only");
  assert.deepEqual(readFileSync(state.file), before);
  hold(state, "repo/acme/widget", "disable", 0);
  const held = adoptionInventory(ctx, profile.id);
  assert.deepEqual(held.candidates, []);
  assert.throws(() => validateReviewedBatch(held, approval));
  hold(state, "repo/acme/widget", "enable", 1);
  ledger.operations["author-op"].acceptance = "unknown";
  assert.equal(adoptionInventory(ctx, profile.id).candidates.length, 0);
  ledger.operations["author-op"].acceptance = "accepted";
  state.update(id, { reason: "release-decision" });
  assert.equal(adoptionInventory(ctx, profile.id).candidates.length, 0);
});

test("revocation reconciles only the exact accepted run and retains terminal results", async () => {
  const { state, id, profile, run } = fixture(), calls = [];
  run.execution.recoveryProfileDigest = profile.digest;
  Object.assign(run.execution, { providerState: "running", collected: false });
  const execution = { cancel: async (...args) => { calls.push(args); return { confirmed: true }; } };
  assert.equal(await reconcileRevokedRun(state, id, execution, run), false);
  const next = { ...profile, revision: 2, mode: "off", revocationGeneration: 1 };
  next.digest = profileDigest(next); putProfile(state, next, profile.digest);
  for (const patch of [{ acceptance: "unknown" }, { providerState: "succeeded" }, { runId: "other" }]) {
    assert.equal(await reconcileRevokedRun(state, id, execution, { ...run, execution: { ...run.execution, ...patch } }), false);
  }
  assert.equal(await reconcileRevokedRun(state, id, execution, run), true);
  assert.deepEqual(calls, [["recovery-profile-revoked", { runId: run.id, operationId: "author-op", profile: profile.digest }]]);
  assert.equal(state.get(id).recovery_revocation.profile, profile.digest);
});

test("releasing a chain hold cannot resurrect a pre-hold start claim", () => {
  const { state } = fixture(), id = "acme/widget/next";
  const chain = { name: "series", index: 0, dispatch: "attempt" };
  state.createChain({ name: chain.name, index: 0, status: "active", steps: [{ id, dispatch: chain.dispatch }] });
  const claim = state.claimStart(id, chain);
  hold(state, "chain/series", "hold", 0);
  assert.throws(() => state.validateStart(id, claim.token, chain));
  hold(state, "chain/series", "resume", 1);
  assert.throws(() => state.validateStart(id, claim.token, chain));
});
