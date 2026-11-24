import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DEFAULTS, resolveBase, resolveTimeout } from "./config.mjs";
import { acquireServiceMutation } from "./daemon.mjs";
import { captureDependencyPlan, capturePlanBrief, compileLinearChain } from "./dependency_plan.mjs";
import { localPlanPath, planSources } from "./dependency_plan_sources.mjs";
import { PLAN_LIMITS, qualifiedIdLength } from "./dependency_plan_limits.mjs";
import { isPlanDigest } from "./dependency_plan_approval.mjs";
import { assertAnchorCurrent, observePlanAnchor, planCatalog, planFailure, planScope, resolvePlanAnchor, scopeGrants } from "./dependency_plan_anchors.mjs";
import { assertPlanAdmissionCurrent, describePlanControl, findPlanControlReceipt, findPlanReceipt, findSavedPlanReview, isPlanReviewId, newPlanReviewId, operatorBinding,
  planApproval, planControlPins, planInspection, planMigrationPreview, reviewFilesAllowed, savedApprovalReceipt, selectPlanControl,
  validatePlanRequest } from "./dependency_plan_registry.mjs";
import { factoryAccess, factoryRecords, factoryObservations } from "./tracker/factory_access.mjs";
import { factoryCatalog, planWindow } from "./tracker/factory_projection.mjs";
import { boundPlanOptions, planReviewView } from "./tracker/plan_authoring.mjs";
import { contentDigest, validateStartRequest } from "./start_contract.mjs";
import { parsePrd, prdDecision, sourcePathsOf } from "./prd.mjs";
import { assertBranchName, repositoryIdentity, repositoryMatches } from "./repository.mjs";
import { hostApi } from "./hosts.mjs";
import { capabilitiesFor } from "./harness.mjs";
import { assertRepositoryAccess } from "./host_contract.mjs";
import { EXECUTION_LIMITS } from "./execution_io.mjs";
import { authorConfigurationDigest } from "./recovery_preflight.mjs";
import { resourceSettings } from "./recovery_resources.mjs";
import { boundedCall, runRecoveryWork } from "./recovery_io.mjs";
import { bindPlanApprovalConsent, planAdminIntent, planOperator, requirePlanApprovalConsent } from "./operator_intent.mjs";
import { selectedPackageAuth } from "./package_auth.mjs";
import { effectiveReviewMode, repositoryReviewConfig, reviewSettings, selectReviewPolicy } from "./review_policy.mjs";
import { publicationPolicyOf } from "./work_artifacts.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { knownTextReviewRoute } from "./first_party_review.mjs";
import { dispatchCapacity } from "./dispatch_capacity.mjs";
import { verifyRepositoryIdentity } from "./dependency_integration.mjs";
import { executionRunner } from "./execution.mjs";
import { graphLaunchUnsent } from "./dependency_plan_runtime.mjs";
import { assertImmediateDependency } from "./ci_timing.mjs";

const invalid = message => planFailure("PLAN_PREVIEW", message);
const changed = () => planFailure("PLAN_STALE", "Plan inputs, bindings or approval changed. Run preview and review the current proposal again.");
const read = fn => boundedCall(fn, { deadlineMs: 10_000 });
const inputPath = (checkout, path) => localPlanPath(join(checkout, path), "plan task input");
const repoKey = node => `${node.repository}:${node.base}:${node.checkout}`;

export function futurePlanTarget(name, afterChain, afterNode) {
  const [plan, node, extra] = afterNode === undefined ? [afterChain] : afterNode.split(":");
  const valid = id => typeof id === "string" && id.length <= PLAN_LIMITS.idLength && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id);
  const parts = node?.split("/") ?? [];
  if (!valid(name) || !valid(plan) || afterNode !== undefined && (!node || extra !== undefined || parts.length > PLAN_LIMITS.depth || !parts.every(valid))) {
    throw invalid("Use a plan name and either --after-chain NAME or --after-node NAME:NODE.");
  }
  return node ? { plan, node } : { plan, boundary: "terminal" };
}

export function planCheckoutIdentity(root, path) {
  const checkout = join(root, path);
  if (realpathSync.native(checkout) !== checkout) throw invalid("Approved checkout must be a canonical local directory.");
  const stat = lstatSync(checkout, { bigint: true });
  if (!stat.isDirectory()) throw invalid("Approved checkout must be a directory.");
  return { checkout, identity: digest([checkout, String(stat.dev), String(stat.ino)]) };
}

async function verifyLocalCheckout(ctx, checkout, node) {
  const local = await read(() => ctx.git.planCheckout(dirname(join(checkout, node.prd))));
  if (!local.root || realpathSync.native(local.root) !== checkout || !repositoryMatches(local.repository, node.repository)) {
    throw invalid("Approved checkout differs from the declared repository root or origin.");
  }
}

async function verifyRepository(ctx, sources, node) {
  const host = hostApi(ctx), { checkout, identity } = planCheckoutIdentity(sources.root, node.checkout);
  await verifyLocalCheckout(ctx, checkout, node);
  const info = await read(() => host.repoInfo(checkout));
  const repository = repositoryIdentity(node.repository);
  const repositoryId = info.repositoryId ?? info.repository?.uuid;
  if (!repositoryMatches(info.nameWithOwner, node.repository) || typeof repositoryId !== "string" || !/^[\w{}+/=-]{1,128}$/.test(repositoryId)) {
    throw invalid("The checkout and host could not verify the declared repository identity.");
  }
  const base = assertBranchName(node.base);
  if (!await read(() => host.branchExists(repository.key, base))) throw invalid(`Approved base ${base} is unavailable for ${repository.key}.`);
  const sha = await read(() => host.refSha(repository.key, base));
  if (!/^[a-f0-9]{40,64}$/.test(sha ?? "")) throw invalid("Host did not return a valid commit for the approved base.");
  const selected = ctx.hosts?.inspect(repository.key);
  const review = reviewSettings(ctx.config, repository.key);
  const mode = effectiveReviewMode(ctx.config, repository.key, review);
  const internal = mode === "first-party-required" || mode === "both-required";
  const qualification = internal ? knownTextReviewRoute(ctx, repository.key) : null;
  const policy = internal && !qualification ? null : selectReviewPolicy(ctx.config, repository.key, qualification);
  const scoped = repositoryReviewConfig(ctx.config, repository.key);
  const files = new Map();
  return { sha, files, binding: { ...repository, repositoryId, base, checkout: node.checkout, checkoutIdentity: identity,
    review: { mode, settings: review, policy, configurationDigest: digest(ctx.config.harness[review.route] ?? null),
      requiredChecks: scoped.required_checks, trustedAuthorsDigest: digest(scoped.trusted_authors),
      externalDigest: digest(scoped.reviewer ?? null), status: internal && !qualification ? "qualification-required" : "configured" },
    packages: selectedPackageAuth(ctx.config, repository.key), hostDispatch: selected?.adapter.dispatch !== false } };
}

async function resolveTask(ctx, sources, node, repository) {
  const { config } = ctx, { checkout } = planCheckoutIdentity(sources.root, node.checkout);
  const readSource = (_root, path) => sources.read(inputPath(node.checkout, path), node.prd, node).bytes.toString("utf8");
  const request = { ...parsePrd(readSource(null, node.prd), node.prd), repo: node.repository, checkout, relPath: node.prd };
  validateStartRequest(request, config, node.prd, { readSource });
  const carried = sourcePathsOf(request);
  const bindings = [];
  for (const path of [node.prd, ...carried]) {
    const rel = inputPath(node.checkout, path), source = sources.read(rel, node.prd, node);
    if (!repository.files.has(path)) {
      const base = await read(() => hostApi(ctx).fileAtStrict(node.repository, path, repository.sha, { bytes: true, maxBytes: PLAN_LIMITS.sourceBytes }));
      if (base !== null && (!Buffer.isBuffer(base) || base.length > PLAN_LIMITS.sourceBytes)) {
        throw invalid("An approved base file is unreadable or exceeds the per-file limit.");
      }
      repository.files.set(path, contentDigest(base));
    }
    bindings.push({ path, source: rel, digest: source.digest, baseDigest: repository.files.get(path) });
  }
  const harness = config.harness[request.harness], capability = capabilitiesFor(request.harness);
  assertRepositoryAccess(capability, repository.binding);
  return { repositoryBinding: repoKey(node), files: bindings, readiness: { status: request.status, decision: prdDecision(request) },
    route: { harness: request.harness, model: harness.model ?? null, provider: harness.provider ?? request.harness,
      account: harness.account ?? "operator", environment: harness.environment ?? null, transport: capability.transport,
      configurationDigest: authorConfigurationDigest(config, request.harness, request),
      routeAvailable: capability.available, modelAccess: "unverified", providerPerRunCap: capability.cost.hardCap,
      ...(!capability.available ? { restriction: capability.reason } : {}) },
    timeoutMinutes: resolveTimeout({ config, repo: node.repository }).minutes,
    publication: publicationPolicyOf(request, { sources: carried, base: node.base }) };
}

async function captureLinear(ctx, { name, paths, base: askedBase, target }, operator) {
  if (!Array.isArray(paths) || !paths.length || paths.length > PLAN_LIMITS.files) throw invalid("Supply one to 32 ready PRD paths.");
  const absolute = paths.map(path => resolve(path));
  const local = await read(() => ctx.git.planCheckout(dirname(absolute[0])));
  const checkout = realpathSync.native(local.root), repo = repositoryIdentity(local.repository).key;
  if (!scopeGrants(operator, planScope(operator.tenant, [repo]), ["read", "observe", "link"])) {
    throw planFailure("PLAN_AUTHORITY", "The consumer scope is unavailable or access is not authorized.");
  }
  const host = await read(() => hostApi(ctx).repoInfo(checkout));
  if (!repositoryMatches(host.nameWithOwner, repo)) throw invalid("The checkout and host could not verify the declared repository identity.");
  const { base } = resolveBase({ config: ctx.config, repo, defaultBranch: host.defaultBranch, asked: askedBase });
  assertBranchName(base);
  const sources = planSources(checkout);
  const steps = absolute.map(path => {
    const prd = localPlanPath(relative(checkout, path), "chain PRD");
    if (!/^docs\/prds\/[a-z0-9][a-z0-9-]*\.md$/.test(prd)) throw invalid("Future chain inputs must use the same checkout and ready PRD paths.");
    capturePlanBrief({ checkout: ".", prd }, sources, prd);
    return { id: `${repo}/${prd.split("/").at(-1).slice(0, -3)}`, relPath: prd };
  });
  const graph = compileLinearChain({ name, repo, base, steps, after: { target } });
  return { preview: { graph, graphDigest: digest(graph), sources: sources.closure() }, sources };
}

// Read-only and explicitly called. No launch probes, repo writes, registry
// mutations or clones. One shared deadline bounds the full resolution pass.
async function prepare(ctx, input, operator, prior = null) {
  return runRecoveryWork(async () => {
    const state = ctx.state.load();
    const configuration = digest(ctx.config);
    if (input.linear && !operator) throw planFailure("PLAN_AUTHORITY", "Future references require the qualified operator ingress.");
    const { preview, sources } = input.linear ? await captureLinear(ctx, input.linear, operator) : captureDependencyPlan(input.file, input.options);
    const { graph } = preview, taskNodes = graph.nodes.filter(node => node.type === "task");
    const scope = planScope(operator?.tenant ?? "local", taskNodes.map(node => node.repository));
    if (operator && !scopeGrants(operator, scope, ["read"])) throw planFailure("PLAN_AUTHORITY", "The consumer scope is unavailable or access is not authorized.");
    if (prior && !isDeepStrictEqual(scope, prior.scope)) throw invalid("The proposal must keep the approved repository scope.");
    const anchorNodes = graph.nodes.filter(node => node.type === "anchor");
    const catalog = anchorNodes.length && operator ? planCatalog(state) : [];
    const frozen = new Map(prior?.approval.bindings.anchors);
    const targets = new Map(prior?.approval.graph.nodes.filter(node => node.type === "anchor").map(node => [node.id, node.target]));
    const anchors = anchorNodes.map(node => {
      const pin = frozen.get(node.id);
      if (!pin || !isDeepStrictEqual(targets.get(node.id), node.target)) return [node.id, resolvePlanAnchor(catalog, operator, scope, node.target)];
      const producer = catalog.find(plan => plan.id === pin.producer.instanceId);
      assertAnchorCurrent(producer?.kind === "graph" ? { ...producer, cancelled: false } : producer, operator, scope, pin);
      return [node.id, pin];
    });
    const capacity = dispatchCapacity(ctx.config);
    if (capacity.graph_authors && capacity.graph_per_repository) {
      for (const [id, pin] of anchors) {
        const producer = catalog.find(plan => plan.id === pin.producer.instanceId);
        if (producer.kind === "legacy" && !frozen.has(id)) {
          pin.repositoryIds = [[producer.chain.repo, await verifyRepositoryIdentity(ctx, producer.chain.repo, producer.chain.repository_id)]];
        }
      }
    }
    const repositories = new Map(), tasks = [];
    for (const node of taskNodes) {
      const key = repoKey(node);
      if (!prior?.approval.graph.nodes.some(previous => previous.id === node.id &&
          previous.type === "task" && repoKey(previous) === key))
        assertImmediateDependency(ctx.config, ctx.state, node.repository, node.base);
      if (!repositories.has(key)) repositories.set(key, await verifyRepository(ctx, sources, node));
      else await verifyLocalCheckout(ctx, join(sources.root, node.checkout), node);
      tasks.push([node.id, await resolveTask(ctx, sources, node, repositories.get(key))]);
      if (planCheckoutIdentity(sources.root, node.checkout).identity !== repositories.get(key).binding.checkoutIdentity) throw changed();
    }
    if (prior) {
      for (const { binding, sha } of repositories.values()) {
        const host = hostApi(ctx);
        if (await read(() => host.refSha(binding.key, binding.base)) !== sha) throw changed();
        if (host.repositoryIdentity) await verifyRepositoryIdentity(ctx, binding.key, binding.repositoryId);
      }
    }
    const config = ctx.config;
    const policy = operatorBinding(operator, scope);
    const window = ctx.planApprovalWindow?.();
    if (window && !policy) throw planFailure("PLAN_AUTHORITY", "Graph admissions are disabled for this local operator scope. Check plan setup and graph capacity.");
    const limits = { maxIterations: config.max_iterations ?? DEFAULTS.max_iterations, maxBudgetUsd: config.max_budget_usd ?? DEFAULTS.max_budget_usd,
      execution: { ...EXECUTION_LIMITS, ...config.execution }, resources: resourceSettings(config),
      completionDigest: digest(config.deliverable === undefined ? DEFAULTS.deliverable : config.deliverable),
      maxLiveGraphAuthors: capacity.graph_authors, maxGraphAuthorsPerRepository: capacity.graph_per_repository,
      ...(capacity.graph_authors && capacity.graph_per_repository ? { authorCapacity: { authors: capacity.authors,
        per_repository: capacity.per_repository, per_plan: capacity.per_plan, preparations: capacity.preparations } } : {}),
      recoveryProfile: null };
    const result = planApproval(preview, { scope, operator: policy, ...(window ? { window } : {}),
      repositories: [...repositories].map(([key, value]) => [key, value.binding]), tasks, anchors, limits,
      controls: planControlPins(state, graph.name, scope, taskNodes.map(node => node.taskId)) });
    const observation = { bases: [...repositories].map(([key, value]) => [key, value.sha]), canQueue: Boolean(policy),
      ...(window ? { approvalExpiresAt: new Date(window.expiresAt).toISOString() } : {}),
      dispatch: capacity.graph_authors && capacity.graph_per_repository ? "requires-qualified-runtime" : "disabled",
      anchors: anchors.map(([id, pin]) => {
        const producer = catalog.find(plan => plan.id === pin.producer.instanceId);
        return [id, { name: producer.name, nodes: observePlanAnchor(state, producer, pin).map(({ id, status }) => [id, status]) }];
      }) };
    if (Buffer.byteLength(JSON.stringify({ ...result, observation })) > PLAN_LIMITS.previewBytes) throw invalid("Admission preview exceeds the 4 MiB output limit.");
    const snapshots = new Map(sources.snapshots().map(source => [source.path, source.bytes]));
    // Resolution awaits the host. Reopen the same contained local files at
    // commit so a source or checkout replacement cannot use this approval.
    const assertLocal = () => {
      if (window) ctx.assertPlanWindow(window);
      try {
        if (digest(ctx.config) !== configuration) throw changed();
        const current = sources.reopen();
        if (current.root !== sources.root) throw changed();
        for (const { path, digest } of result.sources) if (current.read(path, "approved source").digest !== digest) throw changed();
        for (const [, repo] of result.bindings.repositories) {
          if (planCheckoutIdentity(current.root, repo.checkout).identity !== repo.checkoutIdentity) throw changed();
        }
      } catch { throw changed(); }
    };
    return { result, observation, snapshots, root: sources.root, configuration, assertLocal };
  });
}

export async function previewPlan(ctx, input) {
  const operator = ctx.planAuthority ? planOperator(ctx.state.file, ctx.planAuthority) : null;
  const { result, observation } = await prepare(ctx, input, operator);
  return { ...result, observation };
}

function mutatePlan(ctx, fn) {
  const owner = acquireServiceMutation(ctx.home, ctx.taskMutationOwner);
  try { return fn(); } finally { owner.release(); }
}

function reconcileAdmission(ctx, requestId, revision, options) {
  return mutatePlan(ctx, () => ctx.state.reconcilePlanAdmission(ctx.planAuthority, requestId, revision, options));
}

function admitPreparedPlan(ctx, { result, snapshots, root, assertLocal }, requestId, { savedReview = false, checkConsent } = {}) {
  return mutatePlan(ctx, () => ctx.state.admitPlan(result, snapshots, requestId,
    planAdminIntent(ctx.state.file, ctx.planAuthority, savedReview ? "approve-review" : "queue", requestId, result.approvalDigest),
    root, () => { assertLocal(); checkConsent?.(); }, savedReview));
}

export async function queuePlan(ctx, input, { approve, requestId = approve } = {}) {
  if (approve === undefined) return previewPlan(ctx, input);
  validatePlanRequest(requestId, approve);
  const file = ctx.state.file, authority = ctx.planAuthority;
  const operator = planOperator(file, authority);
  const receipt = reconcileAdmission(ctx, requestId, approve);
  if (receipt) return receipt; // Lost response: reconcile before repeating host reads.
  const prepared = await prepare(ctx, input, operator);
  if (approve !== prepared.result.approvalDigest) throw changed();
  if (ctx.refreshPlanAuthority) await ctx.refreshPlanAuthority();
  return admitPreparedPlan(ctx, prepared, requestId);
}

const approvalHref = (base, requestId) => `${base}/plans?approval=${encodeURIComponent(requestId)}`;
const reviewUnavailable = () => planFailure("PLAN_MISSING", "The approval request is unavailable or access is not authorized.");
const reviewExpired = () => planFailure("PLAN_EXPIRED", "The approval request expired. Create a new review.");
const approvalReport = (base, requestId, revision, status, receipt) => ({
  requestId, revision, status, approvalLink: approvalHref(base, requestId),
  ...(receipt ? { receipt, planLink: `${base}/plans?plan=${encodeURIComponent(receipt.instanceId)}` } : {}),
});
const currentOperator = ctx => planOperator(ctx.state.file, ctx.planAuthority);

function savedReviewInput(ctx, state, operator, review) {
  const { source, root, approval } = review, file = approval.manifestPath;
  let options = { directory: root, checkouts: source.checkouts };
  if (source.mode === "file") {
    if (!ctx.planInputs?.directory || Array.isArray(ctx.planInputs.bindings)) throw changed();
    options = ctx.planInputs;
  } else if (source.mode === "bound" || source.mode === "upload") {
    const inline = source.mode === "upload" ? { path: file,
      text: Buffer.from(state.plans.reviewBlobs[approval.sources.find(item => item.path === file).digest], "base64").toString("utf8") } : undefined;
    options = boundPlanOptions(ctx, operator, inline);
  }
  return { file, options };
}

function assertReviewInputs(ctx, state, operator, review) {
  const { approval, root } = review, { bindings } = approval;
  if (digest(ctx.config) !== review.configuration) throw changed();
  if (!reviewFilesAllowed(operator, review) || !isDeepStrictEqual(operatorBinding(operator, review.scope), bindings.operator)) throw changed();
  if (bindings.window) {
    if (!ctx.assertPlanWindow) throw changed();
    ctx.assertPlanWindow(bindings.window);
  }
  const input = savedReviewInput(ctx, state, operator, review);
  const sources = planSources(input.options.directory, input.options);
  if (sources.root !== root) throw changed();
  const tasks = approval.graph.nodes.filter(node => node.type === "task");
  const byNode = new Map(tasks.map(node => [node.id, node]));
  const taskFiles = new Map();
  for (const [id, task] of bindings.tasks) {
    const node = byNode.get(id);
    input.options.authorizeRepository?.(node);
    for (const file of task.files) {
      taskFiles.set(file.source, sources.read(file.source, node.prd, node).digest);
    }
  }
  for (const { path, digest: hash } of approval.sources) {
    if ((taskFiles.get(path) ?? sources.read(path, "approved source").digest) !== hash) throw changed();
  }
  for (const [, repo] of bindings.repositories) {
    if (planCheckoutIdentity(root, repo.checkout).identity !== repo.checkoutIdentity) throw changed();
  }
  assertPlanAdmissionCurrent(state, operator, approval);
  return input;
}

export function inspectPlanApproval(ctx, requestId, base = "") {
  if (!isPlanReviewId(requestId)) throw reviewUnavailable();
  const operator = currentOperator(ctx), state = ctx.state.load();
  const saved = findSavedPlanReview(state, operator, requestId);
  const revision = saved?.approval.approvalDigest;
  const allowed = saved && reviewFilesAllowed(operator, saved);
  const proposal = allowed ? planReviewView({
    status: "review", action: "queue", requestId, revision,
    preview: { ...saved.approval, observation: saved.observation },
  }).proposal : undefined;
  let receipt, status;
  try { receipt = savedApprovalReceipt(state, operator, requestId); }
  catch (error) { if (error.code !== "PLAN_CONFLICT") throw error; status = "denied"; }
  if (receipt) status = "accepted";
  if (!saved && !status) throw reviewUnavailable();
  if (!status) {
    if (saved.expiresAt <= Date.now()) status = "expired";
    else if (!operatorBinding(operator, saved.scope)) status = "denied";
    else if (saved.stale) status = "stale";
    else {
      try { assertReviewInputs(ctx, state, operator, saved); status = "pending"; }
      catch { status = "stale"; }
    }
  }
  return { ...approvalReport(base, requestId, revision ?? receipt?.approvalDigest, status, receipt),
    ...(saved ? { expiresAt: new Date(saved.expiresAt).toISOString() } : {}), ...(proposal ? { proposal } : {}) };
}

async function saveApprovalReview(ctx, command, sourceMode, base) {
  const { input, requestId, approve } = command, operator = currentOperator(ctx);
  if (!isPlanReviewId(requestId) || input.linear || Boolean(input.options?.inline) !== (sourceMode === "upload")) {
    throw planFailure("PLAN_REQUEST", "Create the approval request from a current YAML or JSON plan preview.");
  }
  const state = ctx.state.load();
  const saved = findSavedPlanReview(state, operator, requestId);
  const receipt = savedApprovalReceipt(state, operator, requestId, approve);
  if (receipt) return approvalReport(base, requestId, approve, "accepted", reconcileAdmission(ctx, requestId, approve, { savedReview: true }));
  if (saved) {
    if (saved.approval.approvalDigest !== approve) throw changed();
    const review = inspectPlanApproval(ctx, requestId, base);
    return approvalReport(base, requestId, approve, review.status, review.receipt);
  }
  const prepared = await prepare(ctx, input, operator);
  if (prepared.result.approvalDigest !== approve) throw changed();
  if (ctx.refreshPlanAuthority) await ctx.refreshPlanAuthority();
  const source = { mode: sourceMode, checkouts: [...new Set(input.options?.checkouts ?? [])]
    .map(path => localPlanPath(path, "approved checkout", { directory: true })).sort() };
  if (source.checkouts.length > PLAN_LIMITS.files) throw planFailure("PLAN_LIMIT", "Too many approved checkouts.");
  mutatePlan(ctx, () => ctx.state.savePlanReview(prepared, source, requestId, approve,
    planAdminIntent(ctx.state.file, ctx.planAuthority, "save-review", requestId, approve)));
  const review = inspectPlanApproval(ctx, requestId, base);
  return approvalReport(base, requestId, approve, review.status, review.receipt);
}

// Call only after the trusted host has recorded consent for the action it displayed.
// The opaque return value stays in the host process and cannot be deserialized.
export function recordPlanApprovalConsent(ctx, requestId, revision) {
  validatePlanRequest(requestId, revision);
  const operator = currentOperator(ctx);
  const saved = findSavedPlanReview(ctx.state.load(), operator, requestId);
  if (!saved || saved.approval.approvalDigest !== revision) throw reviewUnavailable();
  const binding = operatorBinding(operator, saved.scope);
  if (!binding || !isDeepStrictEqual(binding, saved.approval.bindings.operator)) throw changed();
  const expiresAt = Math.min(Date.now() + 2 * 60_000, saved.expiresAt, operator.isolation.expiresAt);
  if (expiresAt <= Date.now()) throw reviewExpired();
  return bindPlanApprovalConsent(ctx.state.file, requestId, revision, digest([saved.scope, binding]), expiresAt);
}

async function approveSavedReview(ctx, { requestId, approve, stage }, { consent, consentFor, base }) {
  const operator = currentOperator(ctx), state = ctx.state.load();
  const reconcile = () => reconcileAdmission(ctx, requestId, approve, { savedReview: true });
  const receipt = reconcile();
  if (receipt) return approvalReport(base, requestId, approve, "accepted", receipt);
  const saved = findSavedPlanReview(state, operator, requestId);
  if (!saved) throw reviewUnavailable();
  if (saved.approval.approvalDigest !== approve || saved.stale) throw changed();
  if (saved.expiresAt <= Date.now()) throw reviewExpired();
  if (stage === "reconcile-review") return approvalReport(base, requestId, approve, "unrecorded");
  if (stage === "approve-tool" && consentFor) consent = await consentFor({ action: "approve-plan", requestId, revision: approve });
  const checkConsent = stage === "approve-tool" ? (consume = false) => {
    const binding = operatorBinding(currentOperator(ctx), saved.scope);
    requirePlanApprovalConsent(consent, ctx.state.file, requestId, approve, digest([saved.scope, binding]), { consume });
  } : undefined;
  checkConsent?.();
  try {
    let input;
    try { input = assertReviewInputs(ctx, state, operator, saved); }
    catch {
      if (!operatorBinding(operator, saved.scope)) throw planFailure("PLAN_AUTHORITY", "Approval is denied for this repository scope.");
      throw changed();
    }
    const prepared = await prepare(ctx, input, operator);
    if (prepared.result.approvalDigest !== approve) throw changed();
    if (ctx.refreshPlanAuthority) await ctx.refreshPlanAuthority();
    // Browser allowlists are host-owned and can change during repository reads.
    const assertLocal = saved.source.mode === "local" ? prepared.assertLocal : () => assertReviewInputs(ctx, state, currentOperator(ctx), saved);
    const admitted = admitPreparedPlan(ctx, { ...prepared, assertLocal }, requestId,
      { savedReview: true, checkConsent: checkConsent && (() => checkConsent(true)) });
    return approvalReport(base, requestId, approve, "accepted", admitted);
  } catch (error) {
    const accepted = reconcile();
    if (accepted) return approvalReport(base, requestId, approve, "accepted", accepted);
    if (["PLAN_STALE", "PLAN_INPUT", "PLAN_PREVIEW", "PLAN_CONFLICT", "PLAN_ANCHOR", "PLAN_CYCLE"].includes(error.code) || error.planDiagnostic) {
      mutatePlan(ctx, () => ctx.state.markPlanReviewStale(requestId, approve,
        planAdminIntent(ctx.state.file, ctx.planAuthority, "stale-review", requestId, approve)));
      throw changed();
    }
    throw error;
  }
}

export const PLAN_CONTROL_ACTIONS = ["queue", "attach", "hold", "unhold", "cancel", "retry", "edit"];
const selection = value => typeof value === "string" && value.length <= qualifiedIdLength && /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/.test(value);

export async function planControl(ctx, command, { onReview, sourceMode = "local", consent, consentFor, base = "" } = {}) {
  const { action, plan, group, node, requestId, input, stage, approve } = command;
  const savedStage = ["approve", "approve-tool", "reconcile-review"].includes(stage);
  const saveStage = stage === "save";
  const hasInput = !savedStage && ["queue", "edit", "attach"].includes(action);
  const reviewStage = stage === "review";
  if (Object.keys(command).some(key => !["action", "plan", "group", "node", "requestId", "input", "stage", "approve"].includes(key)) ||
      !PLAN_CONTROL_ACTIONS.includes(action) || !["review", "confirm", "reconcile", "save", "approve", "approve-tool", "reconcile-review"].includes(stage) ||
      (savedStage || saveStage) && (action !== "queue" || !isPlanReviewId(requestId)) ||
      hasInput !== Boolean(input) || (action === "queue" ? plan !== undefined : !selection(plan) || plan.includes("/")) ||
      (action === "retry" ? !selection(node) : node !== undefined) ||
      group !== undefined && (!["hold", "unhold", "cancel"].includes(action) || !selection(group)) ||
      (reviewStage ? approve !== undefined : !isPlanDigest(approve))) {
    throw planFailure("PLAN_REQUEST", "Invalid plan control request.");
  }
  validatePlanRequest(requestId, approve ?? "0".repeat(64));
  if (saveStage) return saveApprovalReview(ctx, command, sourceMode, base);
  if (savedStage) return approveSavedReview(ctx, command, { consent, consentFor, base });
  const { file } = ctx.state, authority = ctx.planAuthority;
  const operator = planOperator(file, authority);
  if (stage === "reconcile") {
    const state = ctx.state.load();
    if (action !== "queue") selectPlanControl(state, operator, command);
    const receipt = action === "queue" ? findPlanReceipt(state, operator, requestId, approve) : findPlanControlReceipt(state, operator, command);
    return receipt ? { ...receipt, action } : { status: "unrecorded", action, requestId };
  }
  if (action === "queue") {
    if (stage === "confirm") return queuePlan(ctx, input, { approve, requestId });
    const prepared = await prepare(ctx, input, operator);
    const preview = { ...prepared.result, observation: prepared.observation };
    const review = { status: "review", action, requestId, saveRequestId: newPlanReviewId(), revision: preview.approvalDigest, preview };
    onReview?.(review, { approval: prepared.result, snapshots: prepared.snapshots });
    return review;
  }
  if (stage === "confirm") {
    const receipt = mutatePlan(ctx, () => ctx.state.reconcilePlanControl(authority, command));
    if (receipt) return receipt;
  }
  const { plan: prior } = selectPlanControl(ctx.state.load(), operator, command);
  try {
    const prepared = input ? await prepare(ctx, input, operator, prior) : action === "retry" ? {
      provenUnsent: (id, token, leaf, plan) => {
        const harness = plan.approval.bindings.tasks.find(([node]) => node === leaf.id)?.[1].route.harness;
        try { return graphLaunchUnsent(executionRunner(ctx, id, harness), token); }
        catch { return false; }
      },
    } : null;
    if (reviewStage) {
      const { review } = describePlanControl(ctx.state.load(), planOperator(file, authority), command, prepared);
      if (prepared?.result) onReview?.(review, { approval: prepared.result, snapshots: prepared.snapshots });
      return input?.options?.inline ? { ...review, preview: { ...prepared.result, observation: prepared.observation } } : review;
    }
    if (ctx.refreshPlanAuthority) await ctx.refreshPlanAuthority();
    return mutatePlan(ctx, () => ctx.state.controlPlan(command, prepared, planAdminIntent(file, authority, action, requestId, approve)));
  } catch (error) {
    if (stage === "confirm" && ["PLAN_CONTROL", "PLAN_PREVIEW", "PLAN_CYCLE"].includes(error.code)) throw changed();
    throw error;
  }
}

export function inspectPlan(ctx, selector, query = {}) {
  const operator = planOperator(ctx.state.file, ctx.planAuthority);
  const saved = factoryRecords(ctx.state);
  const result = planInspection(saved, operator, selector);
  if (!selector) return result;
  const access = factoryAccess(saved, { operator, protectedReads: true });
  const catalog = factoryCatalog(access, factoryObservations(ctx, access));
  return { ...result, factory: planWindow(catalog, { ...query, plan: result.instanceId }) };
}

export function requirePlanTaskControl(ctx, binding, action) {
  const operator = planOperator(ctx.state.file, ctx.planAuthority);
  selectPlanControl(ctx.state.load(), operator, { plan: binding.instanceId, node: binding.node, action: `task/${action}` });
}

export function requireLegacyControl(ctx, repository, action, target) {
  const operator = planOperator(ctx.state.file, ctx.planAuthority);
  const scope = { ...planScope("local", [repository]), ...target };
  if (operator.tenant !== scope.tenant || !scopeGrants(operator, scope, ["read", action])) {
    throw planFailure("PLAN_AUTHORITY", "The control is unavailable or access is not authorized.");
  }
}

export function migratePlans(ctx, approve) {
  const file = ctx.state.file, authority = ctx.planAuthority;
  const operator = planOperator(file, authority);
  if (approve === undefined) return planMigrationPreview(ctx.state.load(), operator);
  if (!isPlanDigest(approve)) throw invalid("Supply the reviewed migration SHA-256 digest.");
  const owner = acquireServiceMutation(ctx.home, ctx.taskMutationOwner);
  try { return ctx.state.migratePlans(approve, planAdminIntent(file, authority, "migrate", null, approve)); }
  finally { owner.release(); }
}
