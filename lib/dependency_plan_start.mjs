import { dirname, join } from "node:path";
import { realpathSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parsePrd } from "./prd.mjs";
import { hosts, hostApi } from "./hosts.mjs";
import { DEFAULTS, resolveTimeout } from "./config.mjs";
import { reviewSettings, repositoryReviewConfig } from "./review_policy.mjs";
import { authorRouteDigest } from "./recovery_preflight.mjs";
import { contentDigest, checkBaseFiles } from "./start_contract.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { dependencyIndex, dispatchablePlan, planNodeRuntime, planPrerequisites } from "./dependency_plan_runtime.mjs";
import { commitId, dependencyError, verifyIntegration, verifyRepositoryIdentity } from "./dependency_integration.mjs";
import { planCheckoutIdentity } from "./dependency_plan_admission.mjs";
import { selectedPackageAuth } from "./package_auth.mjs";
import { boundedCall } from "./recovery_io.mjs";
import { PLAN_LIMITS } from "./dependency_plan_limits.mjs";
import { repositoryMatches } from "./repository.mjs";

export function graphStartInput(ctx, selected) {
  const plan = ctx.state.graphPlan(selected.instanceId);
  const node = plan?.approval.graph.nodes.find(node => node.id === selected.node && node.type === "task");
  if (!node || !dispatchablePlan(plan) || planNodeRuntime(plan, selected.node).generation !== selected.generation ||
      plan.control.generation !== selected.control) throw dependencyError("The selected plan node changed before preparation.");
  const { bindings } = plan.approval, task = new Map(bindings.tasks).get(node.id);
  const repo = new Map(bindings.repositories).get(task.repositoryBinding);
  const index = dependencyIndex(plan);
  const receipts = planPrerequisites(plan, node.id, index);
  if (!receipts) throw dependencyError("The node is waiting for its approved prerequisites.");
  const { checkout, identity } = planCheckoutIdentity(plan.checkoutRoot, node.checkout);
  if (identity !== repo.checkoutIdentity) throw dependencyError("The approved checkout identity changed.");
  const files = new Map(task.files.map(file => [file.path, file]));
  const readSource = (_checkout, path) => {
    const file = files.get(path), bytes = file && ctx.state.approvedPlanBlob(file.digest);
    if (!bytes || contentDigest(bytes) !== file.digest) throw dependencyError("An approved plan snapshot is missing or changed.");
    return bytes.toString("utf8");
  };
  const path = join(checkout, node.prd);
  const request = { ...parsePrd(readSource(checkout, node.prd), path), repo: node.repository, checkout, relPath: node.prd };
  const { config } = ctx, review = reviewSettings(config, node.repository), scoped = repositoryReviewConfig(config, node.repository);
  const selectedHost = (ctx.hosts ?? hosts).select(node.repository);
  const harness = config.harness[request.harness];
  if (!harness || !task.route.routeAvailable || !repo.hostDispatch || !selectedHost.adapter.capabilities?.mergeProof ||
      digest([authorRouteDigest(config, request.harness, request), harness]) !== task.route.configurationDigest ||
      digest(config.harness[review.route] ?? null) !== repo.review.configurationDigest ||
      !isDeepStrictEqual(review, repo.review.settings) || !isDeepStrictEqual(scoped.required_checks, repo.review.requiredChecks) ||
      digest(scoped.trusted_authors) !== repo.review.trustedAuthorsDigest || digest(scoped.reviewer ?? null) !== repo.review.externalDigest ||
      !isDeepStrictEqual(selectedPackageAuth(config, node.repository), repo.packages) ||
      digest(config.deliverable === undefined ? DEFAULTS.deliverable : config.deliverable) !== bindings.limits.completionDigest ||
      resolveTimeout({ config, repo: node.repository }).minutes !== task.timeoutMinutes ||
      (config.max_budget_usd ?? DEFAULTS.max_budget_usd) !== bindings.limits.maxBudgetUsd ||
      (config.max_iterations ?? DEFAULTS.max_iterations) !== bindings.limits.maxIterations) {
    throw dependencyError("The approved author route, delivery policy or task allowance changed or is unavailable.");
  }
  const baseFiles = Object.fromEntries(task.files.map(file => [file.path, file.baseDigest]));
  async function prove(assertCurrent, { input, checkBase = false } = {}) {
    const host = hostApi(ctx);
    const local = await ctx.git.planCheckout(dirname(path));
    if (!repositoryMatches(local.repository, repo.key) || realpathSync.native(local.root) !== checkout ||
        planCheckoutIdentity(plan.checkoutRoot, node.checkout).identity !== repo.checkoutIdentity) throw dependencyError("The approved checkout binding changed.");
    assertCurrent();
    await verifyRepositoryIdentity(ctx, repo.key, repo.repositoryId);
    assertCurrent();
    for (const receipt of receipts) {
      await verifyIntegration(ctx, receipt);
      assertCurrent();
    }
    if (!checkBase) return;
    const base = await boundedCall(() => host.refSha(repo.key, repo.base), config.execution);
    if (!commitId(base)) throw dependencyError("The consumer base is unavailable.");
    await checkBaseFiles(input, baseFiles, rel => boundedCall(() => host.fileAtStrict(repo.key, rel, base,
      { bytes: true, maxBytes: PLAN_LIMITS.sourceBytes }), config.execution));
    assertCurrent();
  }
  return { request, path, base: node.base, readSource, baseFiles, repositoryId: repo.repositoryId, prove,
    after: [...new Set(receipts.filter(receipt => receipt.repository === repo.key && receipt.repositoryId === repo.repositoryId).map(receipt => receipt.sha))],
    reviewPolicy: repo.review.policy,
    authority: { ...selected, authority: ctx.planAuthority, approval: plan.approval.approvalDigest,
      holds: ctx.state.graphHolds(plan, node), dependencies: digest(receipts) } };
}
