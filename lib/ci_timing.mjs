import { repositoryIdentity } from "./repository.mjs";

export const CI_BRANCH_PREFIX = "review-ci/";
export const CI_BRANCH_RULE = "refs/heads/[rR][eE][vV][iI][eE][wW]-[cC][iI]/*";
export const CI_VARIABLE = "CI_AFTER_REVIEW";
export const IMMEDIATE_CI = Object.freeze({ version: 1, timing: "immediate", revision: null });
export const deferredCIError = (message, code = "CI_SETUP_PENDING") => Object.assign(new Error(message), { code });
export const enrolledBranch = branch => typeof branch === "string" && branch.toLowerCase().startsWith(CI_BRANCH_PREFIX);

export function configuredCITiming(config, repo) {
  const key = repositoryIdentity(repo).key;
  return config.repos?.find(item => item?.repo && repositoryIdentity(item.repo).key === key)?.ci_timing ?? null;
}

export function reservedCIBranch(ctx, repo, branch) {
  return enrolledBranch(branch) && (configuredCITiming(ctx.config, repo) === "after-review" ||
    ctx.state.ciPilot?.()?.proposal.repo === repositoryIdentity(repo).key);
}

export function ciTimingView(config, state, repo, base, admitted) {
  const choice = configuredCITiming(config, repo);
  const pilot = state.ciPilot?.();
  const record = pilot?.proposal.repo === repositoryIdentity(repo).key ? pilot : null;
  const active = record?.phase === "active" && choice === "after-review" && (!base || base === record.proposal.base);
  return {
    timing: admitted?.timing ?? choice ?? "immediate",
    activation: admitted?.timing === "immediate" ? choice === "immediate" ? "Operator choice saved" : "Admitted with immediate CI" : active ? "Active"
      : record?.phase === "draining" ? "Rollback in progress"
      : record?.phase === "restored" ? "Immediate CI restored"
      : record?.phase === "retired" ? "Rolled back"
      : admitted?.timing === "after-review" || choice === "after-review" ? "Setup pending"
      : choice === "immediate" ? "Operator choice saved" : "Default",
    revision: admitted?.revision ?? record?.digest ?? null,
  };
}

export function assertImmediateDependency(config, state, repo, base) {
  const pilot = state.ciPilot?.();
  if (configuredCITiming(config, repo) === "after-review" ||
      pilot?.proposal.repo === repositoryIdentity(repo).key && pilot.proposal.base === base && ["active", "draining", "restored"].includes(pilot.phase)) {
    throw deferredCIError("New dependency work cannot enter the after-review CI pilot. Use a standalone PR task, or finish rolling back the pilot.", "CI_UNSUPPORTED");
  }
}

export async function admitCITiming(ctx, { repo, base, harness, prd, admittedDependency, reviewPolicy }) {
  // Dependencies reach here only after the dependency coordinator's own
  // admission. New dependency admissions are refused at their queue boundary.
  if (admittedDependency) return IMMEDIATE_CI;
  const view = ciTimingView(ctx.config, ctx.state, repo, base);
  if (view.timing === "immediate" && !["Active", "Rollback in progress", "Immediate CI restored"].includes(view.activation)) {
    const pilot = ctx.state.ciPilot?.();
    if (pilot?.proposal.repo !== repositoryIdentity(repo).key || !["active", "draining", "restored"].includes(pilot.phase)) return IMMEDIATE_CI;
  }
  if (!ctx.deferredCI) throw deferredCIError("After-review CI needs the protected coordinator and an approved private GitHub pilot. The brief and launch allowance are retained.");
  return ctx.deferredCI.admit(ctx, { repo, base, harness, prd, reviewPolicy });
}

export const deferredMaintenanceOwed = entry => entry?.ciRecords?.some(record =>
  record.requests.some(request => ["submitting", "accepted", "queued", "running", "ambiguous", "cancelling"].includes(request.status)));

export function ciProgressView(ci) {
  if (!ci) return null;
  const progress = {
    review: ["Waiting for review", "external-reviewer", "The configured reviewer can clear the exact current head."],
    submitting: ["Confirming CI request", "coordinator", "Wait for GitHub to confirm the saved request."],
    queued: ["CI queued", "github-actions", "GitHub Actions can start the approved suite."],
    running: ["CI running", "github-actions", "Wait for the selected jobs to finish."],
    verifying: ["Verifying delivery", "coordinator", "The coordinator checks the tested revision and required result."],
    failed: ["CI needs attention", "operator", "Inspect the verified run and resolve the reported failure."],
    blocked: ["CI needs attention", "operator", "Inspect the saved CI request and restore its prerequisites."],
  }[ci.phase];
  return progress && { label: progress[0], actor: progress[1], next: ci.next || progress[2], phase: ci.phase };
}
