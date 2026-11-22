import { join } from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { parsePrd } from "./prd.mjs";
import { inspectRecoveryAdmission, recoveryBinding, recoveryFences } from "./recovery_authority.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { turnBinding } from "./recovery_preflight.mjs";
import { checkFixtureEvidence, checkQualificationEvidence, loadQualification, protectedQualification,
  qualificationBinding, qualificationGate, readCaseEvidence, verifyCaseReceipt } from "./recovery_qualification.mjs";
import { directoryProof } from "./workspace_recovery.mjs";
import { nativeQualificationProbe } from "./recovery_qualification_native.mjs";

function admissionGuard(ctx, scope, test) {
  const clock = ctx.clock ?? Date;
  const result = () => {
    const { entry, registry, profile, admission } = protectedQualification(ctx, scope.id, test.mode);
    if (profile.digest !== scope.profile.digest || admission.digest !== scope.admission.digest)
      throw qualificationGate("The protected qualification admission changed. Preserve the original case receipts.");
    const run = ctx.executionFor(scope.id, entry.harness).current();
    const prd = parsePrd(ctx.readPrd(scope.id), scope.id);
    const snapshot = turnBinding(ctx, scope.id, entry, prd);
    const route = profile.routes.find(candidate => digest(candidate) === run?.execution?.recoveryRouteDigest);
    if (!route) throw qualificationGate("Restore the exact admitted isolation route and original settled operation.");
    const holds = recoveryFences(registry, scope.id, entry, profile);
    const binding = recoveryBinding(scope.id, entry, run, snapshot, profile, route, holds);
    return { registry, run, snapshot, route, binding };
  };
  const expected = result().binding;
  // The manifest's suite budget is separate from this unpaid isolation check.
  const deadline = test.startsAt + test.deadlineMs;
  if (clock.now() < test.startsAt || clock.now() >= deadline)
    throw qualificationGate("The approved case window is inactive. Preserve the operation and obtain a fresh protected admission.");
  const decision = { version: 1, recipe: "qualification", recipeVersion: 1, action: "verify-disposable-isolation",
    authority: "admitted-recovery-intent", purpose: "disposable-qualification",
    manifest: { reference: scope.admission.reference, digest: scope.admission.digest }, expected,
    preconditions: { accepted: true, settled: true }, operationKey: test.operation, deadline,
    reservation: { mutations: 0, paidTurns: 0, spendMicros: 0 }, postcondition: "isolation-proved" };
  const guard = () => inspectRecoveryAdmission({ ...result(), id: scope.id, decision, now: clock.now() });
  guard();
  return { guard, expected, deadline };
}

function sameEnvironment(environment, runtime) {
  return environment.platform === runtime.platform && environment.arch === runtime.arch && environment.node === runtime.node;
}

async function runMissingCase(ctx, scope, test, runtime) {
  const { reconcile } = await prepareQualificationCase(ctx, scope, test, runtime);
  return reconcile();
}

export async function prepareQualificationCase(ctx, scope, test, runtime, {
  remote = false, validateBaseline, readCase = readCaseEvidence, verifyCase = verifyCaseReceipt,
} = {}) {
  const owner = ctx.disposableQualificationOwner;
  if (!owner?.baselineFor || !owner?.reconcileCase)
    throw qualificationGate("Install the independent disposable qualification owner in the protected coordinator with native isolation, model, capture and host proofs for this case.");
  const local = sameEnvironment(test.environment, runtime) && (!remote || test.environment.digest === runtime.digest);
  if (!local && !remote) throw qualificationGate(`Run case ${test.id} in its admitted ${test.environment.platform}/${test.environment.arch} Node environment.`);
  const { guard, expected, deadline } = admissionGuard(ctx, scope, test);
  const id = directoryProof(scope.root);
  const binding = qualificationBinding(scope, test), action = "verify-disposable-isolation";
  const request = { task: scope.id, expected, operationKey: test.operation, manifest: { reference: scope.admission.reference,
    digest: scope.admission.digest }, evidenceRoot: scope.root, action, binding, case: test, deadline };
  const baseline = await owner.baselineFor(request);
  guard();
  const now = () => (ctx.clock ?? Date).now();
  if (baseline?.binding !== binding || baseline.environment !== test.environment.digest || baseline.disposableOnly !== true ||
      baseline.owned !== true || baseline.isolated !== true || !/^[a-f0-9]{64}$/.test(baseline.launchDigest ?? "") ||
      !Number.isSafeInteger(baseline.expiresAt) || baseline.expiresAt <= now() ||
      test.mode !== "native" && (baseline.host !== true || baseline.model !== true || baseline.review !== true ||
        (test.review.capture || scope.routes.get(test.route).capabilities.includes("browser-capture")) && baseline.browser !== true ||
        baseline.allowance !== true))
    throw qualificationGate("Restore independent baseline proof for the exact launch, environment, host, journal ownership, model, review and capture surface.");
  validateBaseline?.(baseline, request);
  const { expiresAt, launchDigest } = baseline;
  const fence = () => {
    guard();
    if (expiresAt <= now() || digest(directoryProof(scope.root)) !== digest(id))
      throw qualificationGate("The qualified launch or evidence root changed before the effect.");
  };
  fence();
  async function reconcile() {
    fence();
    const cases = join(scope.root, "cases");
    try { mkdirSync(cases, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    const parent = digest(directoryProof(cases)), file = join(cases, `${test.id}.json`);
    const beforeEffect = () => {
      fence();
      if (digest(directoryProof(cases)) !== parent) throw qualificationGate("The protected case directory moved.");
    };
    beforeEffect();
    const ownerLock = acquireProcessLock(`${file}.lock`, "qualification evidence");
    try {
      // A concurrent coordinator may already have settled this operation.
      try { lstatSync(file); return readCase(scope, test); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      beforeEffect();
      // Reconcile the original operation, including unknown acceptance. The
      // owner invokes the fence inside its existing effect boundaries.
      const receipt = await owner.reconcileCase({ ...request, launchDigest }, {
        beforeEffect, ...(test.mode === "native" && local ? { nativeProbe: () => nativeQualificationProbe(scope.root, beforeEffect) } : {}),
      });
      beforeEffect();
      const result = verifyCase(scope, test, receipt);
      // An independent owner could have published evidence while reconciling.
      try {
        lstatSync(file);
        const saved = readCase(scope, test);
        if (saved.digest !== result.digest) throw qualificationGate("The case already owns a different receipt.");
        return saved;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      beforeEffect();
      writeJsonAtomic(file, receipt, 0o600, { durable: true });
      return result;
    } finally { ownerLock.release(); }
  }
  return { fence, reconcile };
}

export async function qualifyAdmitted(ctx, id, mode, artifact, runtime) {
  const scope = loadQualification(ctx, id, mode, artifact);
  if (mode === "check-evidence") return checkQualificationEvidence(scope);
  checkFixtureEvidence(scope);
  const preceding = mode === "native" ? [] : mode === "live" ? ["native"] : ["native", "live"];
  for (const test of scope.manifest.cases) if (preceding.includes(test.mode)) readCaseEvidence(scope, test);
  const cases = [];
  for (const test of scope.manifest.cases.filter(test => test.mode === mode)) {
    try { cases.push(readCaseEvidence(scope, test)); }
    catch (error) {
      if (!error.missingEvidence) throw error;
      if (sameEnvironment(test.environment, runtime)) cases.push(await runMissingCase(ctx, scope, test, runtime));
    }
  }
  // A platform job can still persist its own results before a sibling platform
  // is available. Phase clearance requires every case in the protected phase.
  const missing = scope.manifest.cases.filter(test => test.mode === mode && !cases.some(item => item.id === test.id));
  if (missing.length) throw qualificationGate(`Incomplete ${mode} phase. Run admitted environments for ${missing.map(test => test.id).join(", ")}.`);
  return { manifest: scope.admission.digest, profile: scope.profile.digest, cases };
}
