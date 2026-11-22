import { createPublicKey, verify } from "node:crypto";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { capabilitiesFor, executionCapabilities } from "./harness.mjs";
import { HOST_DEFINITIONS } from "./host_definitions.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { qualificationActions, recoveryRecipes, validateRecoveryProfile } from "./recovery_authority.mjs";
import { assertBranchName, repositoryIdentity } from "./repository.mjs";
import { directoryProof, recoveryFile } from "./workspace_recovery.mjs";
import { STRUCTURAL_SCAN_SECONDS } from "./recovery_schedule.mjs";
import { qualificationOwnerFor, recoveryCombination } from "./recovery_eligibility.mjs";

export const qualificationGate = message => Object.assign(new Error(message), { code: "RECOVERY_QUALIFICATION" });
const need = (condition, message) => { if (!condition) throw qualificationGate(message); };
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(value);
const name = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const positive = value => count(value) && value > 0;
const exact = (obj, keys) => obj && typeof obj === "object" && !Array.isArray(obj) &&
  Object.keys(obj).length === keys.length && keys.every(key => Object.hasOwn(obj, key));
const unique = list => new Set(list).size === list.length;
const sealed = value => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) sealed(child);
    Object.freeze(value);
  }
  return value;
};

const owners = Object.freeze({
  author: "execution and host publication",
  reviewer: "first-party review",
  verification: "verification sandbox",
  preparation: "task preparation and intake",
  delivery: "delivery and owned cleanup",
  chain: "coordinator chain claim",
});
const surfaces = HOST_DEFINITIONS.flatMap(({ host }) => host === "bitbucket.org"
  ? ["bitbucket-private", "bitbucket-public"] : [host.split(".")[0]]);
const fixedHosts = { github: "github.com", "bitbucket-private": "bitbucket.org", "bitbucket-public": "bitbucket.org" };

export function qualificationInventory(proofs = []) {
  return surfaces.flatMap(surface => executionCapabilities().flatMap(adapter => Object.entries(owners).map(([owner, service]) => ({
    surface, harness: adapter.name, owner, service, transport: adapter.transport,
    status: proofs.find(proof => proof.surface === surface && proof.harness === adapter.name && proof.owner === owner)?.status ?? "unvalidated",
    available: adapter.available && (adapter.repositoryAccess.hosts?.includes(fixedHosts[surface]) ?? true),
    continuation: owner === "author" ? adapter.continuation : owner === "reviewer" ? "exact-head pieces" : "existing owner only",
    cancellation: owner === "author" ? adapter.controls : owner === "reviewer" ? "requires owned cessation" : "owner-specific",
    isolation: owner === "verification" ? "native verification boundary" : owner === "author" ? "outer launch proof required" : "independent owner proof required",
    resources: owner === "author" ? adapter.cost : "admitted limits and shared capacity",
    recovery: "observe-only",
  }))));
}

const nativeSteps = {
  process: "native", cancellation: "native", journal: "native",
  cleanup: "native", supervisor: "supervisor", isolation: "verification",
};
const liveSteps = {
  preparation: "preparation", publication: "host", externalReview: "host", localReview: "reviewer",
  ciRepair: "verification", faultRecovery: "execution", maintainer: "maintainer", merge: "host",
  cessation: "execution", closeout: "delivery", successor: "chain",
};
const gateSteps = { gate: "host", noDispatch: "execution" };
const signerRoles = [...new Set([...Object.values(nativeSteps), ...Object.values(liveSteps), "aggregate", "fixtures"])];
const recipeSigner = { author: "execution", reviewer: "reviewer", verification: "verification", delivery: "delivery" };
const requiredSteps = test => test.mode === "native" ? nativeSteps : test.outcome === "authority-gate" ? gateSteps : {
  ...liveSteps, ...Object.fromEntries(test.recipes.map(recipe => [`recipe:${recipe}`, recipeSigner[qualificationOwnerFor(recipe)]])),
};
const faults = ["submission-ack", "host-cooldown", "review-output", "git-interruption", "resource-pressure"];
const modes = ["native", "live", "overnight"];

function publicKey(encoded) {
  need(typeof encoded === "string" && /^[A-Za-z0-9_-]{59}$/.test(encoded), "Supply a canonical Ed25519 verification key for each independent evidence owner.");
  try {
    const key = createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
    need(key.asymmetricKeyType === "ed25519" && key.export({ format: "der", type: "spki" }).toString("base64url") === encoded, "Invalid Ed25519 owner key.");
    return key;
  } catch { throw qualificationGate("Invalid Ed25519 owner key."); }
}

function inspectCase(test, routes, limits) {
  const remote = test?.mode !== "native";
  const fields = ["id", "mode", "task", "operation", "route", "environment", "startsAt", "deadlineMs", "maxSpendMicros", "maxTurns"];
  if (remote) fields.push("surface", "repository", "refs", "review", "fault", "outcome", "recipes");
  if (test?.mode === "overnight") fields.push("unattendedMs");
  need(exact(test, fields) && name(test.id) && modes.includes(test.mode) && hash(test.task) && hash(test.operation) &&
    routes.has(test.route) && positive(test.startsAt) && test.startsAt >= limits.startsAt &&
    positive(test.deadlineMs) && test.deadlineMs <= limits.expiresAt - test.startsAt &&
    count(test.maxSpendMicros) && count(test.maxTurns), "Invalid disposable case identity or allowance.");
  const environment = test.environment, route = routes.get(test.route);
  need(exact(environment, ["platform", "arch", "node", "digest"]) && ["linux", "darwin"].includes(environment.platform) &&
    ["x64", "arm64"].includes(environment.arch) && /^v\d+\.\d+\.\d+$/.test(environment.node) &&
    hash(environment.digest), "Bind each case to an exact native environment.");
  need(test.maxSpendMicros <= route.maxSpendMicros, "Case spend exceeds its approved route.");
  if (!remote) {
    need(test.maxSpendMicros === 0 && test.maxTurns === 0, "Native primitives do not receive model or host allowances.");
    return;
  }
  const repo = test.repository, refs = test.refs;
  need(surfaces.includes(test.surface) && exact(repo, ["identity", "id", "credentialRef"]) && hash(repo.id) &&
    typeof repo.identity === "string" && repo.credentialRef === route.credentialRef, "Bind the disposable host identity and credential reference.");
  let identity, branches;
  try {
    identity = repositoryIdentity(repo.identity);
    branches = [refs.base, refs.head, refs.prefix].map(assertBranchName);
  } catch { throw qualificationGate("Supply canonical disposable repository and exact Git refs."); }
  const adapter = capabilitiesFor(route.harness);
  need(identity.remoteIdentity === repo.identity && identity.host === fixedHosts[test.surface] &&
    adapter.available && (adapter.repositoryAccess.hosts?.includes(identity.host) ?? true),
  "The host, visibility or harness is outside the shipped disposable matrix.");
  need(exact(refs, ["base", "head", "prefix", "baseSha", "headSha", "patchDigest"]) &&
    branches[0] !== branches[1] && refs.head.startsWith(refs.prefix + "/") &&
    sha(refs.baseSha) && sha(refs.headSha) && refs.headSha !== refs.baseSha && hash(refs.patchDigest),
  "Pin the exact disposable branch, base and reviewed static patch.");
  need(exact(test.review, ["policy", "externalActor", "localRoute", "capture"]) && hash(test.review.policy) &&
    hash(test.review.externalActor) && routes.has(test.review.localRoute) && typeof test.review.capture === "boolean",
  "Bind both the configured external reviewer and the local review route.");
  if (test.mode === "overnight") need(count(test.unattendedMs) && test.unattendedMs >= 6 * 60 * 60_000 &&
    test.unattendedMs <= test.deadlineMs, "Bind at least six hours of unattended observation in the approved overnight window.");
  need(["recovered", "authority-gate"].includes(test.outcome) && Array.isArray(test.recipes) && unique(test.recipes) &&
    test.recipes.every(recipe => qualificationOwnerFor(recipe) &&
      (qualificationOwnerFor(recipe) === "reviewer" ? routes.get(test.review.localRoute) : route).capabilities.includes(recoveryRecipes[recipe][0])),
  "Cases may claim only approved recipe/owner routes.");
  need(test.outcome === "authority-gate"
    ? test.mode === "overnight" && test.fault === "authority" && test.maxTurns === 0 && test.maxSpendMicros === 0 && !test.recipes.length
    : faults.includes(test.fault) && test.recipes.length > 0 && positive(test.maxTurns),
  "Include an injected recoverable fault and a separate overnight authority gate.");
}

function readEvidence(root, path) {
  let data;
  try { data = recoveryFile(root, path, undefined, { allowMissingParents: true }); }
  catch { throw qualificationGate(`Unsafe evidence path (${path}). Restore the protected file without links or path substitution.`); }
  if (!data.file) throw qualificationGate(`Missing protected evidence (${path}). Run its independently configured owner in the admitted environment.`);
  try { return JSON.parse(data.bytes); }
  catch { throw qualificationGate(`Invalid protected evidence (${path}). Restore the original receipt.`); }
}

export function protectedQualification({ state }, id, mode) {
  const registry = state.load(), entry = registry.entries[id], admin = registry.recovery;
  let profile;
  try { profile = validateRecoveryProfile(admin?.profiles.find(row => row.digest === entry?.recovery_profile?.digest)); } catch { /* fixed gate below */ }
  const admission = profile?.qualification;
  need(entry?.recovery_profile?.version === 1 && admin?.version === 1 && profile?.storeId === admin?.storeId && admission,
    "An operator must pin a disposable qualification manifest and evidence root in the exact task's protected recovery profile.");
  need(Object.hasOwn(qualificationActions, mode) && admission.actions.includes(qualificationActions[mode]),
    "The protected task admission does not allow this qualification mode. Obtain explicit operator admission.");
  if (mode !== "check-evidence") need(profile.mode === "recover" && admission.actions.includes("verify-disposable-isolation"),
    "Enable the protected disposable qualification purpose and isolation action before running cases.");
  const root = admission.evidenceRoot;
  try { directoryProof(root); }
  catch { throw qualificationGate("Mount the admitted evidence root at its exact canonical path in the protected environment."); }
  need(lstatSync(root).isDirectory(), "Mount the admitted private evidence directory.");
  return { root, admission, profile, entry, registry };
}

export function loadQualification(ctx, id, mode, artifact) {
  const resolved = protectedQualification(ctx, id, mode), { admission, profile, root } = resolved;
  const manifest = readEvidence(root, `manifests/${admission.reference.slice("manifest:".length)}.json`);
  need(digest(manifest) === admission.digest, "The disposable qualification manifest differs from the protected digest.");
  need(exact(manifest, ["version", "purpose", "artifact", "limits", "signers", "cases"]) && manifest.version === 1 &&
    manifest.purpose === "disposable-synthetic-recovery" && digest(manifest.artifact) === digest(artifact),
  "Admit the exact source, package, schemas and recipe versions for this qualification build.");
  const limits = manifest.limits;
  need(exact(limits, ["startsAt", "expiresAt", "evidenceExpiresAt", "maxSpendMicros", "maxTurns"]) &&
    positive(limits.startsAt) && positive(limits.expiresAt) && limits.expiresAt > limits.startsAt &&
    positive(limits.evidenceExpiresAt) && limits.evidenceExpiresAt >= limits.expiresAt &&
    count(limits.maxSpendMicros) && count(limits.maxTurns), "Bind an exact qualification window, spend and turn allowance.");
  const now = (ctx.clock ?? Date).now();
  need(now >= limits.startsAt && now < (mode === "check-evidence" ? limits.evidenceExpiresAt : limits.expiresAt),
    "The approved qualification window is inactive. Request a fresh protected admission.");
  need(exact(manifest.signers, signerRoles) && unique(Object.values(manifest.signers)), "Use independent evidence owners, including a separate maintainer and supervisor.");
  for (const key of Object.values(manifest.signers)) publicKey(key);
  need(Array.isArray(manifest.cases) && manifest.cases.length <= 128, "Supply a bounded qualification matrix.");
  const routes = new Map(profile.routes.map(route => [digest(route), route]));
  for (const test of manifest.cases) inspectCase(test, routes, limits);
  need(unique(manifest.cases.map(test => test.id)) && unique(manifest.cases.map(test => test.operation)) &&
    unique(manifest.cases.filter(test => test.repository).map(test => `${test.repository.id}:${test.refs.head}`)),
  "Each case must own a distinct operation and disposable branch.");
  for (const [key, bound] of [["maxSpendMicros", "spendMicros"], ["maxTurns", "paidTurns"]]) {
    const sum = manifest.cases.reduce((total, test) => total + test[key], 0);
    need(count(sum) && sum <= limits[key] && sum <= profile.taskLimits[bound], "Qualification matrix exceeds its protected allowance.");
  }
  const native = manifest.cases.filter(test => test.mode === "native"), overnight = manifest.cases.filter(test => test.mode === "overnight");
  need(["linux", "darwin"].every(platform => native.some(test => test.environment.platform === platform)) &&
    surfaces.every(surface => ["live", "overnight"].every(phase => manifest.cases.some(test =>
      test.surface === surface && test.mode === phase && test.outcome === "recovered"))) &&
    overnight.some(test => test.outcome === "authority-gate") &&
    new Set(overnight.filter(test => test.outcome === "recovered").map(test => test.fault)).size >= 2 &&
    manifest.cases.filter(test => test.repository).every(test => native.some(probe => digest(probe.environment) === digest(test.environment))),
  "Require Linux and macOS, GitHub and both Bitbucket visibilities, overnight recovery across faults and a separate authority gate.");
  return { ...resolved, manifest: sealed(manifest), routes, artifact, root, id, clock: ctx.clock };
}

export const qualificationBinding = (scope, test) => digest({
  version: 1, manifest: scope.admission.digest, profile: scope.profile.digest,
  admissionTask: digest(scope.id), artifact: scope.artifact, case: test,
});

function signed(envelope, key, message) {
  let ok = false;
  if (exact(envelope, ["record", "signature"]) && typeof envelope.signature === "string" && /^[A-Za-z0-9_-]{86}$/.test(envelope.signature)) {
    const signature = Buffer.from(envelope.signature, "base64url");
    ok = signature.toString("base64url") === envelope.signature && verify(null, Buffer.from(digest(envelope.record), "hex"), publicKey(key), signature);
  }
  need(ok, message);
  return envelope.record;
}

export function verifyQualificationSignature(scope, envelope, owner) {
  return signed(envelope, scope.manifest.signers[owner], `Missing or invalid independent ${owner} signature.`);
}

function expectedFacts(step) {
  const fixed = {
    process: { exactIdentity: true, liveLockPreserved: true, deadOwnerRecovered: true },
    cancellation: { exactRun: true, ceased: true, foreignUntouched: true },
    journal: { durable: true, preservedPrefix: true, replays: 1 },
    cleanup: { ownedOnly: true, preservedUniqueWork: true },
    supervisor: { independentlyConfigured: true, pinned: true, deadOnly: true, throttled: true },
    isolation: { protectedState: true, credentialBoundary: true },
    closeout: { delivered: true, ownedCleanupSettled: true, preservedUniqueWork: true },
    successor: { claims: 1, starts: 1 },
    cessation: { exactRun: true, ceased: true },
    preparation: { approvedOnly: true, isolated: true, credentialBoundary: true },
  };
  return fixed[step];
}

function validateFacts(test, records) {
  const facts = step => records[step]?.facts;
  for (const step of Object.keys(records)) {
    const expected = expectedFacts(step);
    if (expected) need(digest(expected) === digest(facts(step)), `Failed ${step} proof for case ${test.id}.`);
  }
  if (test.mode === "native") return;
  const elapsed = (step, required) => {
    const result = facts(step), { observedAt } = records[step];
    return count(result.startedAt) && result.startedAt >= test.startsAt && count(result.unattendedMs) &&
      result.unattendedMs >= required && observedAt - result.startedAt >= result.unattendedMs;
  };
  if (test.outcome === "authority-gate") {
    const stopped = facts("gate");
    need(exact(stopped, ["stopped", "reason", "hostWrites", "startedAt", "unattendedMs"]) &&
      stopped.stopped === true && stopped.reason === "authority" && stopped.hostWrites === 0 &&
      elapsed("gate", test.unattendedMs) &&
      digest(facts("noDispatch")) === digest({ chargeMicros: 0, submissions: 0, successors: 0 }),
    "The unattended authority gate must remain stopped without host writes, charges or successors.");
    return;
  }
  const { headSha, baseSha, head, base, patchDigest } = test.refs;
  const publication = facts("publication"), merged = facts("merge");
  need(exact(publication, ["pr", "count", "repository", "head", "base", "headSha"]) &&
    positive(publication.pr) && publication.count === 1 && publication.repository === test.repository.id &&
    publication.head === head && publication.base === base && publication.headSha === headSha, "Publication ownership differs from the admitted fixture.");
  const maintainer = facts("maintainer");
  // Neither shipped adapter exposes a compare-and-set of both refs at merge.
  need(maintainer?.authority === "external-maintainer",
    "Automatic fixture merge is unavailable. Supply an independent maintainer receipt.");
  need(digest(maintainer) === digest({ pr: publication.pr, repository: test.repository.id, head, base, headSha, baseSha, patchDigest, authority: "external-maintainer" }),
    "Use a separately authorized maintainer for the exact static patch, head and base.");
  need(exact(merged, ["pr", "headSha", "baseSha", "patchDigest", "mergeSha", "baseContainsMerge"]) &&
    merged.pr === publication.pr && merged.headSha === headSha && merged.baseSha === baseSha && merged.patchDigest === patchDigest &&
    sha(merged.mergeSha) && merged.baseContainsMerge === true, "The host must prove the exact approved fixture merge and ancestry.");
  need(digest(facts("externalReview")) === digest({ headSha, policy: test.review.policy, actor: test.review.externalActor, clear: true }) &&
    digest(facts("localReview")) === digest({ headSha, policy: test.review.policy, route: test.review.localRoute, clear: true }),
  "External and local review must clear the approved fixture head.");
  need(digest(facts("ciRepair")) === digest({ headSha, relevantFailure: true, relevantCheckGreen: true }), "Record the failed and repaired CI check on the bound fixture.");
  const recovery = facts("faultRecovery");
  need(exact(recovery, ["fault", "recovered", "duplicateSubmissions", "spendMicros", "turns", "manualResumes", "unsafeTakeovers",
    "lostWork", "falseTerminations", "startedAt", "unattendedMs"]) &&
    recovery.fault === test.fault && recovery.recovered === true && recovery.duplicateSubmissions === 0 &&
    count(recovery.spendMicros) && recovery.spendMicros <= test.maxSpendMicros && positive(recovery.turns) && recovery.turns <= test.maxTurns &&
    recovery.manualResumes === 0 && recovery.unsafeTakeovers === 0 && recovery.lostWork === 0 && recovery.falseTerminations === 0 &&
    elapsed("faultRecovery", test.unattendedMs ?? 0),
  "Recovery exceeded its allowance or violated an unattended safety invariant.");
  for (const recipe of test.recipes) {
    const result = facts(`recipe:${recipe}`);
    const route = qualificationOwnerFor(recipe) === "reviewer" ? test.review.localRoute : test.route;
    need(exact(result, ["recipe", "version", "route", "operation", "postcondition"]) &&
      result.recipe === recipe && result.version === 1 && result.route === route && hash(result.operation) &&
      result.postcondition === recoveryRecipes[recipe][1], "Mutation qualification requires proof of the exact recipe and route postcondition.");
  }
}

export function verifyCaseReceipt(scope, test, receipt) {
  const steps = requiredSteps(test), binding = qualificationBinding(scope, test);
  need(exact(receipt, Object.keys(steps)), `Incomplete protected case receipt for ${test.id}.`);
  const records = {};
  for (const [step, owner] of Object.entries(steps)) {
    const record = verifyQualificationSignature(scope, receipt[step], owner);
    need(exact(record, ["version", "binding", "step", "observedAt", "result", "observation", "facts"]) &&
      record.version === 1 && record.binding === binding && record.step === step && record.result === "passed" &&
      positive(record.observedAt) && record.observedAt >= test.startsAt &&
      record.observedAt < test.startsAt + test.deadlineMs && record.observedAt <= (scope.clock ?? Date).now() &&
      hash(record.observation), `Missing, stale or cross-case ${step} receipt for ${test.id}.`);
    records[step] = record;
  }
  validateFacts(test, records);
  return { id: test.id, mode: test.mode, digest: digest(receipt) };
}

const fixtureBinding = scope => digest([scope.admission.digest, scope.profile.digest, digest(scope.id), scope.artifact]);
export function checkFixtureEvidence(scope) {
  const record = verifyQualificationSignature(scope, readEvidence(scope.root, "fixtures.json"), "fixtures");
  need(exact(record, ["version", "binding", "aggregate", "result"]) && record.version === 1 &&
    record.binding === fixtureBinding(scope) && record.result === "passed" && hash(record.aggregate),
  "Run the complete offline qualification aggregate under its independent owner.");
  return digest(record);
}
export function readCaseEvidence(scope, test) {
  return verifyCaseReceipt(scope, test, readEvidence(scope.root, `cases/${test.id}.json`));
}

function validateCapacity(s) {
  const percentile = p => exact(p, ["p50", "p95", "p99"]) && [p.p50, p.p95, p.p99].every(count) && p.p50 <= p.p95 && p.p95 <= p.p99;
  need(exact(s, ["workload", "capacity", "cycles", "healthyRuns", "duplicateSubmissions", "unsafeTakeovers",
    "lostWork", "falseTerminations", "falseRecoveries", "scanSeconds", "boundedIoMs", "maxDiagnosisMs", "queueMs", "cycleMs"]) &&
    positive(s.workload) && positive(s.capacity) && positive(s.cycles) && positive(s.healthyRuns) &&
    s.duplicateSubmissions === 0 && s.unsafeTakeovers === 0 && s.lostWork === 0 && s.falseTerminations === 0 &&
    count(s.falseRecoveries) && s.falseRecoveries <= s.healthyRuns && s.scanSeconds === STRUCTURAL_SCAN_SECONDS &&
    positive(s.boundedIoMs) && s.boundedIoMs <= 60_000 && count(s.maxDiagnosisMs) &&
    s.maxDiagnosisMs <= 2 * s.scanSeconds * 1000 + s.boundedIoMs && percentile(s.queueMs) && percentile(s.cycleMs),
  "Measure the healthy workload, bounded diagnosis, queue/cycle percentiles and safety counters before rollout.");
  return { ...s, falseRecoveryRate: s.falseRecoveries / s.healthyRuns };
}

// This function has no execution, cleanup or administration capability.
export function checkQualificationEvidence(scope) {
  const fixture = checkFixtureEvidence(scope);
  const cases = scope.manifest.cases.map(test => readCaseEvidence(scope, test));
  const aggregate = verifyQualificationSignature(scope, readEvidence(scope.root, "aggregate.json"), "aggregate");
  need(exact(aggregate, ["version", "binding", "fixture", "cases", "result", "capacity"]) &&
    aggregate.version === 1 && aggregate.binding === fixtureBinding(scope) && aggregate.fixture === fixture &&
    digest(aggregate.cases) === digest(Object.fromEntries(cases.map(test => [test.id, test.digest]))) &&
    aggregate.result === "passed", "The independent aggregate must cover every bound case and the complete fault suite.");
  return { digest: digest(aggregate), cases, capacity: validateCapacity(aggregate.capacity), fixture,
    combinations: qualifiedCombinations(scope) };
}

export function qualifiedCombinations(scope) {
  const byPhase = phase => new Set(scope.manifest.cases.filter(test => test.mode === phase && test.outcome === "recovered")
    .flatMap(test => test.recipes.map(recipe => {
      const route = qualificationOwnerFor(recipe) === "reviewer" ? test.review.localRoute : test.route;
      return recoveryCombination({ surface: test.surface, harness: scope.routes.get(route).harness, recipe, route, environment: test.environment });
    })));
  const overnight = byPhase("overnight");
  return [...byPhase("live")].filter(value => overnight.has(value)).sort();
}
