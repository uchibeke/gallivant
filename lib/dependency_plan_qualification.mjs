import { DEFAULTS } from "./config.mjs";
import { PLAN_APPROVAL_VERSION, isPlanDigest as hash } from "./dependency_plan_approval.mjs";
import { PLAN_LIMITS, PLAN_VERSION } from "./dependency_plan_limits.mjs";
import { dispatchCapacity } from "./dispatch_capacity.mjs";
import { capabilitiesFor, executionCapabilities } from "./harness.mjs";
import { HOST_DEFINITIONS } from "./host_definitions.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { loadQualificationManifest, nativeQualificationSteps, protectedQualification, qualificationFixtureBinding,
  qualificationGate, readQualificationEvidence, validateQualificationCases, verifyCaseReceipt as verifyNativeCase,
  verifyQualificationSignature, verifyQualificationSteps } from "./recovery_qualification.mjs";
import { qualificationArtifact } from "./recovery_qualification_artifact.mjs";
import { prepareQualificationCase } from "./recovery_qualification_run.mjs";
import { assertBranchName, repositoryIdentity } from "./repository.mjs";
import { PLAN_RUNTIME_FORMAT } from "./runtime_state.mjs";
import { FACTORY_VERSION } from "./tracker/factory_projection.mjs";

const platforms = ["linux", "darwin"];
const surfaces = { github: "github.com", "bitbucket-private": "bitbucket.org", "bitbucket-public": "bitbucket.org" };
const leaves = ["producer", "root", "left", "right", "join"];
const launchStep = { launch: "supervisor" };
const liveSteps = { ...launchStep, graph: "coordinator", execution: "execution", host: "host",
  maintainer: "maintainer", review: "reviewer", closeout: "delivery" };
const roles = [...new Set([...Object.values(nativeQualificationSteps), ...Object.values(liveSteps), "fixtures", "aggregate"])];
const purpose = "disposable-synthetic-dependency-plans";
const need = (condition, message) => { if (!condition) throw qualificationGate(message); };
const count = value => Number.isSafeInteger(value) && value >= 0;
const commit = value => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const label = value => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= PLAN_LIMITS.idLength;
const nodeId = value => typeof value === "string" && value.split("/").length <= PLAN_LIMITS.depth && value.split("/").every(label);
const unique = values => new Set(values).size === values.length;
const same = (a, b) => digest(a) === digest(b);

export const dependencyFixtureGroups = Object.freeze([
  { id: "plan-contracts", suites: ["qualification", "contract", "admission", "dispatch", "controls"]
    .map(name => `dependency-plan-${name}.test.mjs`).concat("factory-projection.test.mjs"), selected: [] },
  { id: "shared-owners", suites: ["chains.test.mjs", "live-merge-closeout.test.mjs", "recovery-resource.test.mjs",
    "recovery-scheduling.test.mjs", "review-qualification-retry.test.mjs", "workspace-cleanup.test.mjs"], selected: [] },
  { id: "publication-replay", suites: ["execution-backends.test.mjs"], selected: [
    "openai-agents fixture: lost reply persists intent and reconciles without duplicate paid dispatch",
    "uncertain PR creation survives worker restart and only observes the original verified publication",
  ] },
  { id: "reviewer-capacity", suites: ["first-party-review.test.mjs"], selected: [
    "a stopped reviewer reaches current-head clearance from its owned capacity retry without an author turn",
    "a new review head preserves uncertain cancellation and waits for exact cessation",
  ] },
  { id: "served-browser", suites: ["ui/dependency-plans.test.mjs", "ui/factory-task-workspace.test.mjs"], selected: [] },
]);

export function dependencyQualificationArtifact() {
  return { ...qualificationArtifact(["docs/ui-feature-matrix.md"]), planRuntime: PLAN_RUNTIME_FORMAT, planContract: {
    graph: PLAN_VERSION, approval: PLAN_APPROVAL_VERSION, projection: FACTORY_VERSION, qualification: 1,
  } };
}

const supports = (adapter, host) => adapter.available && (adapter.repositoryAccess.hosts?.includes(host) ?? true) &&
  HOST_DEFINITIONS.some(definition => definition.host === host && definition.dispatch !== false && definition.capabilities.mergeProof);

export function dependencyQualificationMatrix(scope, proved = []) {
  const results = new Map(proved.map(result => [result.id, result]));
  const cases = new Map(scope?.manifest.cases.map(test => [test.id, test]));
  const evidence = id => {
    const test = cases.get(id), proof = results.get(id);
    return { id, status: proof?.mode ?? "unvalidated", ...(test && { environment: test.environment, launch: test.launch,
      route: test.route, operation: test.operation, ...(test.review && { repository: test.repository.id, reviewRoute: test.review.localRoute }),
      ...(test.graph && { graph: test.graph.digest, approval: test.graph.approval }) }), ...(proof && { receipt: proof.digest }) };
  };
  return { manifest: scope?.admission.digest ?? null, profile: scope?.profile.digest ?? null,
    defaultCapacity: dispatchCapacity(DEFAULTS),
    native: platforms.map(platform => ({ ...evidence(`native-${platform}`), platform,
      owners: [...new Set(Object.values(nativeQualificationSteps))] })),
    live: platforms.flatMap(platform => Object.entries(surfaces).flatMap(([surface, host]) => {
      const definition = HOST_DEFINITIONS.find(item => item.host === host);
      return executionCapabilities().map(adapter => {
        const required = supports(adapter, host);
        return { ...evidence(`live-${platform}-${surface}-${adapter.name}`), platform, surface, host, harness: adapter.name, required,
          ...(required ? {} : { status: "gated" }), owners: [...new Set(Object.values(liveSteps))],
          hostCapabilities: definition?.capabilities ?? null,
          authorCapabilities: { transport: adapter.transport, available: adapter.available, repositoryAccess: adapter.repositoryAccess,
            continuation: adapter.continuation, controls: adapter.controls, cost: adapter.cost } };
      });
    })) };
}

function inspectCase(test, routes, limits) {
  const native = test?.mode === "native";
  const fields = ["id", "mode", "operation", "route", "environment", "launch", "startsAt", "deadlineMs", "maxSpendMicros", "maxTurns"];
  if (!native) fields.push("surface", "repository", "graph", "refs", "review", "maintainer");
  need(exact(test, fields) && (native || test.mode === "live") && hash(test.operation) && routes.has(test.route) &&
    hash(test.launch) && count(test.startsAt) && test.startsAt >= limits.startsAt && count(test.deadlineMs) && test.deadlineMs > 0 &&
    test.deadlineMs <= limits.expiresAt - test.startsAt && count(test.maxSpendMicros) && count(test.maxTurns),
  "Bind each case to an exact operation, approved route, launch and finite allowance.");
  const env = test.environment, route = routes.get(test.route);
  need(exact(env, ["platform", "arch", "node", "digest"]) && platforms.includes(env.platform) &&
    ["arm64", "x64"].includes(env.arch) && typeof env.node === "string" && /^v\d+\.\d+\.\d+$/.test(env.node) && hash(env.digest),
  "Pin the native platform, architecture, Node and runtime fingerprint for each case.");
  if (native) {
    need(test.id === `native-${env.platform}` && test.maxTurns === 0 && test.maxSpendMicros === 0 &&
      route.capabilities.includes("verify-disposable-isolation"), "Native cases require the admitted isolation route and zero paid turns or spend.");
    return;
  }
  const { graph, refs, repository, review } = test, host = surfaces[test.surface];
  need(Object.hasOwn(surfaces, test.surface) && test.id === `live-${env.platform}-${test.surface}-${route.harness}` &&
    supports(capabilitiesFor(route.harness), host) && test.maxTurns >= leaves.length * 2,
  "Bind each live case to a supported host and harness and its approved allowance.");
  need(exact(repository, ["identity", "id", "credentialRef"]) && hash(repository.id) && repository.credentialRef === route.credentialRef,
    "Bind the exact disposable repository identity and credential reference.");
  try {
    const identity = repositoryIdentity(repository.identity);
    need(identity.remoteIdentity === repository.identity && identity.host === host, "Disposable repository differs from the admitted host.");
  } catch { throw qualificationGate("Supply a canonical disposable repository for the selected host and visibility."); }
  need(exact(graph, ["digest", "approval", "producer", "nodes"]) && hash(graph.digest) && hash(graph.approval) &&
    exact(graph.producer, ["chain", "node", "contract"]) && label(graph.producer.chain) && nodeId(graph.producer.node) &&
    hash(graph.producer.contract) && exact(graph.nodes, leaves.slice(1)) && Object.values(graph.nodes).every(nodeId) &&
    unique(Object.values(graph.nodes)), "Pin the graph and approval digests, frozen chain endpoint and distinct diamond nodes.");
  need(exact(refs, ["base", "prefix", "leaves"]) && exact(refs.leaves, leaves), "Scope every leaf to an admitted disposable ref.");
  try {
    assertBranchName(refs.base); assertBranchName(refs.prefix);
    for (const ref of Object.values(refs.leaves)) {
      need(exact(ref, ["task", "operation", "head", "headSha", "baseSha", "patch"]) && hash(ref.task) && hash(ref.operation) &&
        assertBranchName(ref.head) === ref.head && ref.head !== refs.base && ref.head.startsWith(refs.prefix + "/") &&
        commit(ref.headSha) && commit(ref.baseSha) && ref.headSha !== ref.baseSha && hash(ref.patch), "Invalid disposable leaf.");
    }
  } catch { throw qualificationGate("Pin exact disposable heads, base commits, static patches and original leaf operations."); }
  const reviewer = routes.get(review?.localRoute);
  need(exact(review, ["policy", "externalActor", "localRoute", "capture"]) && hash(review.policy) && hash(review.externalActor) &&
    reviewer?.harness === "codex" && typeof review.capture === "boolean" &&
    test.maxSpendMicros <= route.maxSpendMicros + reviewer.maxSpendMicros &&
    (!review.capture || reviewer.capabilities.includes("browser-capture")) && hash(test.maintainer) && test.maintainer !== review.externalActor,
  "Pin the independent maintainer, external actor, first-party Codex route and any required capture capability.");
}

export function loadDependencyQualification(ctx, id, mode, artifact) {
  need(["native", "live", "check-evidence"].includes(mode), "Choose an admitted dependency qualification mode.");
  const scope = loadQualificationManifest(ctx, id, mode, artifact, purpose, roles);
  validateQualificationCases(scope, inspectCase);
  const matrix = dependencyQualificationMatrix(scope), expected = [...matrix.native, ...matrix.live.filter(row => row.required)].map(row => row.id);
  const cases = new Map(scope.manifest.cases.map(test => [test.id, test]));
  const missing = expected.filter(id => !cases.has(id));
  need(!missing.length && cases.size === expected.length, `Admit the complete dependency case matrix. Missing: ${missing.join(", ") || "none"}.`);
  const refs = [], tasks = [], operations = [...cases.values()].map(test => test.operation);
  for (const test of cases.values()) if (test.mode === "live") {
    need(same(cases.get(`native-${test.environment.platform}`).environment, test.environment),
      `Pin the native receipt for the exact live runtime of ${test.id}.`);
    const entries = Object.values(test.refs.leaves);
    refs.push(...entries.map(ref => `${test.repository.id}:${ref.head}`));
    tasks.push(...entries.map(ref => ref.task));
    operations.push(...entries.map(ref => ref.operation));
  }
  need(unique(refs) && unique(operations) && unique(tasks), "Give each leaf its own disposable ref and operation and preserve distinct task identities.");
  return scope;
}

function checkLaunch(scope, test, envelope) {
  const { launch: record } = verifyQualificationSteps(scope, test, { launch: envelope }, launchStep);
  const { facts } = record, route = scope.routes.get(test.route);
  const proofs = ["isolation", "runtime"];
  if (test.mode === "live") {
    proofs.push("host", "plugin", "authorModel", "reviewModel", "reviewHost", "allowance");
    if (test.review.capture || route.capabilities.includes("browser-capture")) proofs.push("capture");
  }
  need(exact(facts, ["launch", "environment", "route", "reviewRoute", "operation", "proofs"]) && facts.launch === test.launch &&
    facts.environment === test.environment.digest && facts.route === test.route && facts.reviewRoute === (test.review?.localRoute ?? null) &&
    facts.operation === test.operation && exact(facts.proofs, proofs) && Object.values(facts.proofs).every(hash),
  `Restore the exact installed launch and independent runtime${test.mode === "live" ? ", host, plugin, model, review, allowance and required capture" : " and isolation"} proof for ${test.id}.`);
  return record;
}

function validateLive(scope, test, records) {
  const { graph, execution, host, maintainer, review, closeout } = Object.fromEntries(
    Object.entries(records).map(([role, record]) => [role, record.facts]));
  const { refs, repository } = test;
  const within = (time, step) => count(time) && time >= records.launch.observedAt && time <= records[step].observedAt;
  need(exact(execution, ["route", "leaves", "spendMicros", "turns"]) && execution.route === test.route && exact(execution.leaves, leaves) &&
    count(execution.spendMicros) && execution.spendMicros <= scope.routes.get(test.route).maxSpendMicros &&
    count(execution.turns) && execution.turns >= leaves.length && execution.turns <= test.maxTurns,
  "Record the exact execution route, per-leaf ownership and measured consumption within the case allowance.");
  need(exact(host, ["surface", "repository", "leaves"]) && host.surface === test.surface && host.repository === repository.id && exact(host.leaves, leaves) &&
    exact(maintainer, ["actor", "leaves"]) && maintainer.actor === test.maintainer && exact(maintainer.leaves, leaves) &&
    exact(review, ["route", "policy", "heads", "capture", "turns", "spendMicros"]) && review.route === test.review.localRoute && review.policy === test.review.policy &&
    exact(review.heads, leaves) && review.capture === test.review.capture &&
    exact(closeout, leaves), "Provide independent host, maintainer, review and delivery receipts for every leaf.");
  need(count(review.turns) && review.turns >= leaves.length && review.turns <= test.maxTurns - execution.turns &&
    count(review.spendMicros) && review.spendMicros <= scope.routes.get(review.route).maxSpendMicros &&
    review.spendMicros <= test.maxSpendMicros - execution.spendMicros,
  "Author and independent review usage must fit their route caps and the shared case allowance.");

  for (const leaf of leaves) {
    const run = execution.leaves[leaf], ref = refs.leaves[leaf], effect = host.leaves[leaf], done = closeout[leaf];
    need(exact(run, ["task", "operation", "run", "starts", "startedAt", "ceasedAt"]) && run.task === ref.task && run.operation === ref.operation &&
      hash(run.run) && run.starts === 1 && within(run.startedAt, "execution") && within(run.ceasedAt, "execution") && run.startedAt <= run.ceasedAt,
    `Execution owner or cessation differs for ${leaf}.`);
    need(exact(effect, ["pr", "count", "head", "headSha", "base", "baseSha", "patch", "merge", "baseContainsMerge",
      "publishedAt", "mergedAt", "mergeActor", "externalActor", "externalReviewAt"]) &&
      count(effect.pr) && effect.pr > 0 && effect.count === 1 && effect.head === ref.head && effect.headSha === ref.headSha && effect.base === refs.base &&
      effect.baseSha === ref.baseSha && effect.patch === ref.patch && commit(effect.merge) && effect.merge !== ref.baseSha && effect.baseContainsMerge === true &&
      effect.mergeActor === test.maintainer && effect.externalActor === test.review.externalActor && within(effect.publishedAt, "host") &&
      within(effect.externalReviewAt, "host") && within(effect.mergedAt, "host") && run.startedAt <= effect.publishedAt &&
      effect.publishedAt <= effect.externalReviewAt && effect.externalReviewAt < effect.mergedAt, `Host PR, current review or ancestry differs for ${leaf}.`);
    const approval = maintainer.leaves[leaf], local = review.heads[leaf];
    need(exact(approval, ["repository", "pr", "head", "headSha", "base", "baseSha", "patch", "authority", "authorizedAt"]) &&
      approval.repository === repository.id && approval.pr === effect.pr && approval.head === ref.head && approval.headSha === ref.headSha &&
      approval.base === refs.base && approval.baseSha === ref.baseSha && approval.patch === ref.patch && approval.authority === "external-maintainer" &&
      within(approval.authorizedAt, "maintainer") && effect.externalReviewAt <= approval.authorizedAt && approval.authorizedAt <= effect.mergedAt &&
      exact(local, ["head", "clearedAt"]) && local.head === ref.headSha && within(local.clearedAt, "review") &&
      effect.publishedAt <= local.clearedAt && local.clearedAt <= approval.authorizedAt,
      `Supply the exact independently authorized maintainer merge and current-head review for ${leaf}.`);
    need(exact(done, ["pr", "merge", "run", "delivered", "cleanup", "settledAt"]) && done.pr === effect.pr && done.merge === effect.merge &&
      done.run === run.run && done.delivered === true && ["removed", "retained"].includes(done.cleanup) && within(done.settledAt, "closeout") &&
      done.settledAt >= Math.max(effect.mergedAt, run.ceasedAt), `Delivery and cleanup did not settle for the exact ${leaf} operation.`);
  }
  need(unique(leaves.map(leaf => host.leaves[leaf].pr)) && unique(leaves.map(leaf => execution.leaves[leaf].run)),
    "Each leaf must preserve its original distinct PR and run.");
  const start = leaf => execution.leaves[leaf].startedAt, settled = leaf => closeout[leaf].settledAt;
  const { root, left, right, join } = test.graph.nodes;
  need(exact(graph, ["instance", "graph", "approval", "attachment", "fanOut", "join"]) && hash(graph.instance) &&
    graph.graph === test.graph.digest && graph.approval === test.graph.approval &&
    exact(graph.attachment, ["frozen", "observedAt", "pr"]) && same(graph.attachment.frozen, [test.graph.producer]) &&
    graph.attachment.pr === null && within(graph.attachment.observedAt, "graph") && graph.attachment.observedAt < host.leaves.producer.publishedAt &&
    start("root") >= settled("producer"), "Attach the frozen future chain endpoint before its final PR exists and wait for settlement.");
  need(exact(graph.fanOut, ["from", "children", "eligibleAt"]) && graph.fanOut.from === root && same(graph.fanOut.children, [left, right]) &&
    within(graph.fanOut.eligibleAt, "graph") && graph.fanOut.eligibleAt >= settled("root") && graph.fanOut.eligibleAt <= Math.min(start("left"), start("right")),
  "Prove both siblings became eligible from the same integrated root.");
  need(same(graph.join, { node: join, needs: [left, right], merges: [host.leaves.left.merge, host.leaves.right.merge],
    claims: 1, startedAt: start("join") }) && within(start("join"), "graph") && start("join") >= Math.max(settled("left"), settled("right")),
  "Release exactly one join from both original, settled sibling integrations.");
}

export function verifyDependencyCase(scope, test, receipt) {
  if (test.mode === "native") {
    const { launch, ...native } = receipt ?? {};
    const { observedAt } = checkLaunch(scope, test, launch);
    verifyNativeCase(scope, test, native);
    need(Object.values(native).every(step => step.record.observedAt >= observedAt), "Native observations must follow the admitted launch.");
  } else {
    const records = verifyQualificationSteps(scope, test, receipt, liveSteps);
    checkLaunch(scope, test, receipt.launch);
    validateLive(scope, test, records);
  }
  return { id: test.id, mode: test.mode, digest: digest(receipt) };
}

function readCase(scope, test) {
  return verifyDependencyCase(scope, test, readQualificationEvidence(scope.root, `cases/${test.id}.json`));
}

export function completeDependencyFixtureResults(results) {
  return Array.isArray(results) && results.length === dependencyFixtureGroups.length && dependencyFixtureGroups.every((group, index) => {
    const result = results[index];
    return exact(result, ["id", "suites", "selected", "exit", "timeout", "result", "passed", "missing"]) && result.id === group.id &&
      same(result.suites, group.suites) && same(result.selected, group.selected) && result.exit === 0 && result.timeout === false &&
      result.result === "passed" && count(result.passed) && result.passed >= group.suites.length && same(result.missing, []);
  });
}

function fixtureEvidence(scope) {
  const record = verifyQualificationSignature(scope, readQualificationEvidence(scope.root, "fixtures.json"), "fixtures");
  need(exact(record, ["version", "binding", "aggregate", "results", "result"]) && record.version === 1 &&
    record.binding === qualificationFixtureBinding(scope) && record.result === "passed" && hash(record.aggregate) &&
    completeDependencyFixtureResults(record.results), "Sign the complete offline and served-browser fixture aggregate for this build.");
  return digest(record);
}

export async function qualifyDependencyPlans(ctx, id, mode, artifact, runtime) {
  const scope = loadDependencyQualification(ctx, id, mode, artifact), fixture = fixtureEvidence(scope);
  const checkAdmission = () => {
    const { profile } = protectedQualification(ctx, id, mode);
    need(profile.digest === scope.profile.digest, "The protected dependency qualification admission changed.");
  };
  if (mode === "check-evidence") {
    const cases = scope.manifest.cases.map(test => readCase(scope, test));
    const record = verifyQualificationSignature(scope, readQualificationEvidence(scope.root, "aggregate.json"), "aggregate");
    need(same(record, { version: 1, binding: qualificationFixtureBinding(scope), fixture,
      cases: Object.fromEntries(cases.map(item => [item.id, item.digest])), result: "passed" }),
    "Sign exactly every admitted native and live case and the fixture aggregate.");
    checkAdmission();
    return { cases, fixture, evidence: digest(record), matrix: dependencyQualificationMatrix(scope, cases) };
  }
  const cases = [], missing = [];
  for (const test of scope.manifest.cases) {
    if (mode === "native" && test.mode !== mode) continue;
    try { cases.push(readCase(scope, test)); }
    catch (error) {
      if (!error.missingEvidence || test.mode !== mode) throw error;
      missing.push(test);
    }
  }
  // Preflight the entire phase before asking any owner to reconcile effects.
  const prepared = [];
  for (const test of missing) prepared.push(await prepareQualificationCase(ctx, scope, test, runtime, {
    remote: true, readCase, verifyCase: verifyDependencyCase,
    validateBaseline: baseline => {
      need(baseline.launchDigest === test.launch, `Restore the pinned executable and installed launch for ${test.id}.`);
      checkLaunch(scope, test, baseline.launchReceipt);
    },
  }));
  for (const { fence } of prepared) fence();
  for (const { reconcile } of prepared) cases.push(await reconcile());
  checkAdmission();
  return { cases, fixture, matrix: dependencyQualificationMatrix(scope, cases) };
}
