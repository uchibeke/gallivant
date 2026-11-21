// Coordinator-only policy data. Validation never confers a capability.
import { createRequire } from "node:module";
import { posix } from "node:path";
import { recoveryDigest } from "./recovery_digest.mjs";
import { HARNESSES } from "./config.mjs";
import { redact } from "./execution_io.mjs";
import { controlOwnership, controlPending } from "./control_contract.mjs";
import { executionLive, providerTerminal } from "./execution_contract.mjs";
import { capabilitiesFor } from "./harness.mjs";
import { qualificationOwnerFor, rolloutAllows } from "./recovery_eligibility.mjs";

const closed = properties => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const list = (items, maxItems = 64) => ({ type: "array", items, maxItems, uniqueItems: true });
const choice = (...values) => ({ enum: values });
const one = { const: 1 };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...count, minimum: 1 };
const digest = { type: "string", pattern: "^[0-9a-f]{64}$" };
const ref = { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$" };
const credentialRef = { type: "string", pattern: "^credential:[a-z][a-z0-9._-]{0,63}$" };
const root = { type: "string", maxLength: 1024, pattern: "^/[^\\\\\\u0000-\\u001f]*$" };

export const recoveryRecipes = Object.freeze({
  "execution-reconciliation": ["observe-execution", "execution-settled"],
  "review-reconciliation": ["observe-review", "review-current"],
  "review-output-retry": ["retry-review-output", "review-current"],
  "feedback-continuation": ["continue-feedback", "feedback-consumed"],
  "publication-continuation": ["continue-publication", "publication-observed"],
  "provider-continuation": ["continue-session", "execution-settled"],
  "route-handoff": ["handoff-session", "epoch-reserved"],
  "policy-refresh": ["refresh-derivation", "derivation-current"],
  "git-repair": ["repair-owned-merge", "verified-merge-published"],
  "ci-repair": ["repair-task-ci", "failed-job-cleared"],
  "workspace-cleanup": ["collect-owned-artifacts", "owned-space-released"],
  "qualification": ["verify-disposable-isolation", "isolation-proved"],
});
export const qualificationActions = Object.freeze({ native: "qualify-native", live: "qualify-live",
  overnight: "qualify-overnight", "check-evidence": "check-evidence" });
const recipeId = choice(...Object.keys(recoveryRecipes));
const action = choice(...Object.values(recoveryRecipes).map(([name]) => name));
const route = closed({ harness: choice(...HARNESSES), provider: ref, model: ref, account: ref,
  environment: ref, dataLocation: ref, credentialRef, capabilities: list(choice(...action.enum, "browser-capture", "private-context")), maxSpendMicros: count });
const manifest = closed({ reference: { type: "string", pattern: "^manifest:[a-z0-9._-]{1,64}$" },
  digest, evidenceRoot: root, actions: list(choice("verify-disposable-isolation", ...Object.values(qualificationActions))) });
const limits = closed({ mutations: count, paidTurns: count, spendMicros: count });
const profileSchema = closed({ version: one, storeId: ref, id: ref, revision: positive, digest,
  mode: choice("off", "observe", "recover"), recipes: list(closed({ id: recipeId, version: one, limits })),
  taskLimits: limits, routes: list(route), cleanup: list(closed({ root, classes: list(choice("settled-scratch", "settled-checkout")),
    retentionSeconds: positive, maxBytes: count })), revocationGeneration: count, holdGeneration: count,
  qualification: { anyOf: [manifest, { type: "null" }] } });
const decisionSchema = closed({ version: one, recipe: recipeId, recipeVersion: one, action,
  authority: choice("operator-intent", "admitted-recovery-intent"), purpose: choice("recovery", "disposable-qualification"),
  manifest: { anyOf: [closed({ reference: manifest.properties.reference, digest }), { type: "null" }] },
  expected: closed({ task: digest, snapshot: digest, profile: digest, revision: positive, ownership: digest, route: digest, holds: digest }),
  preconditions: closed({ accepted: { const: true }, settled: { const: true } }),
  operationKey: digest, deadline: positive, reservation: limits,
  postcondition: choice(...new Set(Object.values(recoveryRecipes).map(([, post]) => post))) });

let validators;
function schemas() {
  // Basic CLI/help also runs from unpacked distributions before dependencies
  // are installed. Load the validator only when evaluating recovery policy.
  if (!validators) {
    const Ajv = createRequire(import.meta.url)("ajv");
    const ajv = new Ajv({ ownProperties: true });
    validators = { profile: ajv.compile(profileSchema), decision: ajv.compile(decisionSchema) };
  }
  return validators;
}
const refuse = message => { throw Object.assign(new Error(message), { code: "RECOVERY_AUTHORITY" }); };
export function profileDigest({ digest: ignored, ...policy }) { return recoveryDigest(policy); }
export function validateRecoveryProfile(profile) {
  if (!schemas().profile(profile) || profile.digest !== profileDigest(profile) || recoveryDigest(redact(profile)) !== recoveryDigest(profile)) refuse("Unsupported recovery profile shape, revision or digest.");
  if (new Set(profile.recipes.map(r => r.id)).size !== profile.recipes.length) refuse("Duplicate recovery recipe.");
  const roots = profile.cleanup.map(item => item.root);
  if (profile.qualification) roots.push(profile.qualification.evidenceRoot);
  if (roots.some(path => path === "/" || posix.normalize(path) !== path || path.endsWith("/"))) refuse("Expected an exact canonical owned root.");
  return profile;
}

export function validateRecoveryDecision(decision) {
  if (!schemas().decision(decision)) refuse("Unsupported recovery decision.");
  const [name, post] = recoveryRecipes[decision.recipe];
  if (decision.action !== name || decision.postcondition !== post) refuse("Recipe action or postcondition mismatch.");
  if (decision.recipe === "qualification") {
    if (decision.authority !== "admitted-recovery-intent" || decision.purpose !== "disposable-qualification" || !decision.manifest) refuse("Disposable qualification requires its protected manifest.");
  } else if (decision.purpose !== "recovery" || decision.manifest !== null) refuse("Manifest is scoped to disposable qualification.");
  return decision;
}

export function ownedRecoveryRun(id, entry, run) {
  const ex = run?.execution;
  return Boolean(ex?.version === 1 && ex.taskId === id && ex.runId === run.id && ex.provider === entry.harness &&
    (!entry.execution || entry.execution.runId === ex.runId && entry.execution.operationId === ex.operationId && entry.execution.acceptance === "accepted") &&
    ex.operationId && ex.acceptance === "accepted" && run.id === entry.last?.run && run.running === false &&
    entry.last.exit != null && controlOwnership(entry, run) === "settled" && !executionLive(run) &&
    !ex.cancellation && ex.providerState !== "cancelled" && !ex.quarantined);
}

// Read all administrative fences from the same protected registry revision.
// A chain's scope applies only while claiming a successor.
export function recoveryScopes(id, entry, profile, chainClaim = null) {
  return [`task/${id}`, `repo/${entry.repo}`, `profile/${profile.id}`, ...(chainClaim ? [`chain/${chainClaim}`] : [])];
}
export function chainRecoveryFences(admin, chain, id) {
  return [`chain/${chain.name}`, `repo/${chain.repo}`, `task/${id}`].map(scope => admin?.holds?.[scope] ?? null);
}
export function recoveryFences(registry, id, entry, profile) {
  const admin = registry.recovery;
  const scopes = recoveryScopes(id, entry, profile).map(scope => admin.holds[scope] ?? null);
  const canary = admin.canaries?.[profile.id];
  return canary ? [...scopes, { active: false, generation: canary.generation }] : scopes;
}
export function recoveryBinding(id, entry, run, snapshot, profile, selectedRoute, holds) {
  return { task: recoveryDigest([id, entry.task?.revision, entry.task?.digest, entry.repo, entry.branch, entry.base]),
    snapshot, profile: profile.digest, revision: profile.revision, ownership: recoveryDigest([entry.session, run?.id, run?.execution]),
    route: recoveryDigest(selectedRoute), holds: recoveryDigest(holds) };
}

// A protected profile reference is pinned per task. An operator string in a
// decision is never an operator capability. No public generic effect callback.
export function inspectRecoveryAdmission({ registry, id, run, snapshot, route: selectedRoute, decision, now = Date.now(), qualificationFor }) {
  validateRecoveryDecision(decision);
  if (decision.authority !== "admitted-recovery-intent") refuse("Operator decisions require the operator command owner.");
  const entry = registry.entries[id], admin = registry.recovery;
  if (!entry?.recovery_profile || admin?.version !== 1 || entry.recovery_profile.version !== 1) refuse("Observation only. Explicit protected task admission is required.");
  const profile = validateRecoveryProfile(admin.profiles.find(p => p.digest === entry.recovery_profile.digest));
  if (profile.storeId !== admin.storeId || profile.mode !== "recover") refuse("Profile disabled or replaced.");
  if (entry.state === "done" && decision.recipe !== "workspace-cleanup" || entry.state === "ready-for-human" && !["git-repair", "ci-repair", "workspace-cleanup"].includes(decision.recipe) || entry.prd_divergence ||
      ["cancelled", "cancellation-requested", "operator-interrupted", "release-decision", "merge-decision", "physical-evidence"].includes(entry.reason)) refuse("Recovery blocked by task disposition.");
  const holds = recoveryFences(registry, id, entry, profile);
  if (entry.dispatch_stopped || entry.hold?.active || entry.repository_disabled || controlPending(entry.control) ||
      holds.some(h => h && h.active !== false) || !ownedRecoveryRun(id, entry, run)) refuse("Recovery blocked by control, hold or execution ownership.");
  const binding = recoveryBinding(id, entry, run, snapshot, profile, selectedRoute, holds);
  if (recoveryDigest(binding) !== recoveryDigest(decision.expected) || now >= decision.deadline) refuse("Recovery decision expired or its approved binding changed.");
  if (decision.recipe === "qualification" && (decision.reservation.paidTurns || decision.reservation.spendMicros)) refuse("Isolation qualification cannot reserve a paid turn.");
  const recipe = profile.recipes.find(r => r.id === decision.recipe);
  const approvedRoute = profile.routes.find(r => recoveryDigest(r) === binding.route);
  const requiredHarness = decision.recipe === "review-output-retry" ? entry.reviewPolicy?.route?.name : entry.harness;
  const wrongHarness = decision.recipe === "route-handoff" ? approvedRoute?.harness === entry.harness : approvedRoute?.harness !== requiredHarness;
  if (!recipe || !approvedRoute?.capabilities.includes(decision.action) || wrongHarness ||
      decision.reservation.spendMicros > approvedRoute.maxSpendMicros) refuse("Recipe or bound route is outside the profile.");
  for (const key of Object.keys(decision.reservation)) {
    if (decision.reservation[key] > recipe.limits[key] || decision.reservation[key] > profile.taskLimits[key]) refuse("Reservation exceeds the approved limit.");
  }
  if (decision.manifest && (profile.qualification?.digest !== decision.manifest.digest ||
      profile.qualification.reference !== decision.manifest.reference || !profile.qualification.actions.includes(decision.action))) refuse("Disposable fixture manifest mismatch.");
  // Supplied by the coordinator's execution owner, never from a task, a
  // decision document or disposable isolation qualification. Production
  // adapters without a matching recipe/launch receipt remain observe-only.
  if (qualificationFor && qualificationOwnerFor(decision.recipe)) {
    const request = recoveryDigest([binding, decision.recipe, decision.recipeVersion, decision.action,
      decision.operationKey, entry.reviewPolicy?.route?.fingerprint, entry.execution_epoch ?? 0]);
    const proof = qualificationFor(request);
    if (proof?.binding === request && proof.isolated === true && proof.qualified === true &&
        /^[a-f0-9]{64}$/.test(proof.launchDigest) && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now) {
      if (rolloutAllows(registry, id, profile, approvedRoute, decision.recipe, proof, now))
        return { mode: "recover", binding, launchDigest: proof.launchDigest };
      return { mode: "observe", binding, reason: "The exact task, owner, recipe and runtime require a current operator-admitted canary with complete qualification evidence." };
    }
  }
  // None of the installed author launch paths encloses all of the protected
  // state, administration, and operator-control routes. Standalone OS probes
  // and sandbox receipts from a different owner cannot change this result.
  const adapter = capabilitiesFor(selectedRoute.harness);
  return { mode: "observe", adapter: selectedRoute.harness, transport: adapter.transport, action: decision.action,
    reason: adapter.transport === "remote"
      ? "The hosted adapter lacks verified isolation of private input delivery and coordinator control routes."
      : "The local author launch lacks a qualified outer sandbox for the protected registry, snapshots and coordinator control routes.",
    binding };
}

// Reuse normal inspection for unknown acceptance and result collection for
// terminal work. Only the exact accepted run can be cancelled after a policy
// change, including acceptance that arrived after the administrative update.
export async function reconcileRevokedRun(state, id, execution, run) {
  const ex = run?.execution, profile = ex?.recoveryProfileDigest;
  if (!profile || ex.taskId !== id || ex.runId !== run.id || ex.acceptance !== "accepted" ||
      providerTerminal(ex.providerState) || !executionLive(run) || ex.cancellation) return false;
  const registry = state.load(), entry = registry.entries[id];
  if (!entry || entry.harness !== ex.provider || entry.last?.run !== run.id && entry.execution?.operationId !== ex.operationId) return false;
  if (entry.recovery_profile?.digest === profile && registry.recovery?.profiles.some(p => p.digest === profile && p.mode === "recover")) return false;
  await execution.cancel("recovery-profile-revoked", { runId: run.id, operationId: ex.operationId, profile });
  state.update(id, current => current.last?.run === run.id || current.execution?.operationId === ex.operationId
    ? { dispatch_stopped: current.dispatch_stopped || "recovery-profile-revoked",
      recovery_revocation: { version: 1, profile, run: run.id, operation: ex.operationId, provenance: "profile-revision" } } : {});
  return true;
}
