import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { validateRecoveryProfile } from "./recovery_authority.mjs";
import { loadQualification, checkQualificationEvidence, qualifiedCombinations } from "./recovery_qualification.mjs";
import { qualificationArtifact } from "./recovery_qualification_artifact.mjs";
import { rolloutTaskBinding } from "./recovery_eligibility.mjs";
import { controlPending } from "./control_contract.mjs";
import { executionLive } from "./execution_contract.mjs";
import { executionOwed, cleanupOwed } from "./recovery_schedule.mjs";
import { learningDeliveryPending } from "./learning_contract.mjs";
import { unresolvedWorkspaceRepair } from "./workspace_recovery.mjs";

const sha = str => /^[0-9a-f]{64}$/.test(str ?? "");
const keys = ["combinations", "evidence", "generation", "profile", "qualificationTask", "stage", "tasks", "version"];
export function prepareRecoveryCanary(ctx, approval) {
  if (!approval || Object.keys(approval).sort().join() !== keys.join() || approval.version !== 1 ||
      !["observe", "operational", "semantic"].includes(approval.stage) || !sha(approval.profile) ||
      !Number.isSafeInteger(approval.generation) || approval.generation < 0 || !Number.isSafeInteger(approval.generation + 1) ||
      !Array.isArray(approval.tasks) || !approval.tasks.length || approval.tasks.length > 128 ||
      new Set(approval.tasks).size !== approval.tasks.length || !Array.isArray(approval.combinations) ||
      !approval.combinations.every(sha) || new Set(approval.combinations).size !== approval.combinations.length) {
    throw new Error("Supply a reviewed canary approval for explicit task and combination bindings.");
  }
  const registry = ctx.state.load();
  const profile = validateRecoveryProfile(registry.recovery?.profiles.find(item => item.digest === approval.profile));
  const tasks = Object.fromEntries(approval.tasks.map(id => {
    const entry = typeof id === "string" && registry.entries[id];
    if (entry?.recovery_profile?.digest !== profile.digest) throw new Error("Canary requires each task's exact admitted profile.");
    return [id, rolloutTaskBinding(id, entry)];
  }));
  const record = { version: 1, generation: approval.generation + 1, stage: approval.stage, profile: profile.digest, tasks,
    combinations: [...approval.combinations].sort(), evidence: null, expiresAt: null, artifact: null };
  if (record.stage === "observe") {
    if (approval.qualificationTask !== null || approval.evidence !== null || record.combinations.length)
      throw new Error("Observe canary admission has no mutation combinations or qualification receipt.");
    return record;
  }
  if (profile.mode !== "recover" || profile.qualification || typeof approval.qualificationTask !== "string" ||
      !record.combinations.length || !sha(approval.evidence)) throw new Error("Mutation canaries require a separate protected qualification task and complete evidence.");
  const artifact = ctx.qualificationArtifact ?? qualificationArtifact();
  const scope = loadQualification(ctx, approval.qualificationTask, "check-evidence", artifact);
  const evidence = checkQualificationEvidence(scope), eligible = new Set(qualifiedCombinations(scope));
  if (evidence.digest !== approval.evidence || !record.combinations.every(key => eligible.has(key))) {
    throw new Error("This approval includes missing, stale or unqualified mutation combinations.");
  }
  return { ...record, evidence: evidence.digest, expiresAt: scope.manifest.limits.evidenceExpiresAt, artifact: digest(artifact),
    source: { task: scope.id, profile: scope.profile.digest, manifest: scope.admission.digest,
      generation: scope.registry.recovery.holds[`profile/${scope.profile.id}`]?.generation ?? 0 } };
}

export const settledCancellation = entry => entry.state === "needs-human" && entry.reason === "cancelled" &&
  Boolean(entry.dispatch_stopped) && !controlPending(entry.control) && !executionLive(entry);
export function recoveryDrainReasons(entry, anchored = false) {
  const reasons = [];
  if (controlPending(entry.control)) reasons.push("control");
  if (!settledCancellation(entry) && executionOwed(entry)) reasons.push("execution or acceptance");
  if (entry.firstPartyReview?.status === "running") reasons.push("review execution");
  if (learningDeliveryPending(entry)) reasons.push("delivery");
  if (entry.workspace_cleanup?.status === "pending" || cleanupOwed(entry, anchored)) reasons.push("merged closeout");
  if (unresolvedWorkspaceRepair(entry)) reasons.push("Git recovery journal");
  if (Object.values(entry.recovery_actions?.intents ?? {}).some(intent =>
    ["reserved", "executing", "verifying"].includes(intent.phase))) reasons.push("recovery reservation");
  return reasons;
}

export function recoveryDrainStatus(state) {
  const saved = state.load(), chains = Object.values(saved.chains ?? {});
  const anchors = new Set(chains.filter(chain => !["done", "cancelled"].includes(chain.status)).map(chain => chain.after?.id));
  const pending = Object.entries(saved.entries).flatMap(([id, entry]) => {
    const retained = recoveryDrainReasons(entry, anchors.has(id));
    return retained.length ? [{ id, retained }] : [];
  });
  const starts = Object.keys(saved.starts ?? {}).length;
  const activeChains = chains.filter(chain => !["done", "cancelled"].includes(chain.status)).length;
  return { registryVersion: saved.version, drained: !pending.length && !starts && !activeChains, starts, activeChains, pending };
}
