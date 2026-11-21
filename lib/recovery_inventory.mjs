import { join } from "node:path";
import { readFileSync } from "node:fs";
import { reviewLedgerPath, reviewExecutionId } from "./first_party_review.mjs";
import { briefDivergence, prdFingerprint } from "./prd.mjs";
import { turnBinding } from "./recovery_preflight.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { recoveryObservation } from "./recovery_observation.mjs";
import { ownedRecoveryRun, recoveryScopes, validateRecoveryProfile } from "./recovery_authority.mjs";

function reviewBackup(ctx, id, entry) {
  const root = join(ctx.home, "reviews");
  const history = ctx.state.reviewHistory(id);
  let ledger;
  try { ledger = JSON.parse(readFileSync(reviewLedgerPath(root, id), "utf8")); }
  catch (error) { if (error.code !== "ENOENT" || entry.firstPartyReview || history.length) throw error; }
  const executions = [];
  if (ledger) {
    if (ledger.version !== 1 || ledger.id !== id || !ledger.jobs ||
        entry.firstPartyReview?.key && !Object.hasOwn(ledger.jobs, entry.firstPartyReview.key)) throw new Error("Review ledger mismatch.");
    for (const [key, job] of Object.entries(ledger.jobs)) {
      if (job.key !== key || !/^[a-zA-Z0-9._:-]{1,256}$/.test(key)) throw new Error("Invalid review execution reference.");
      const owner = reviewExecutionId(root, id, key);
      const record = ctx.executionFor(owner, "codex").state();
      if (record.taskId !== owner || job.run && !Object.values(record.operations).some(op => op.runId === job.run)) throw new Error("Missing review execution.");
      executions.push({ owner, digest: digest(record) });
    }
  }
  return { ledger: ledger ? digest(ledger) : null, executions, history: digest(history) };
}

// A proposal names a complete, content-addressed recovery point. Applying or
// restoring one requires a separately qualified migration owner (M06).
export function adoptionInventory(ctx, profileId) {
  const registry = ctx.state.load(), admin = registry.recovery;
  const selected = admin?.profiles.find(p => p.id === profileId);
  const profile = selected && validateRecoveryProfile(selected);
  const candidates = [], excluded = [];
  for (const [id, entry] of Object.entries(registry.entries).sort(([a], [b]) => a.localeCompare(b))) {
    if (entry.recovery_profile || entry.state !== "needs-human") continue;
    let reason = "no matching protected profile";
    if (admin?.version === 1 && profile && admin.storeId === profile.storeId && profile.mode === "recover") {
      try {
        const execution = ctx.executionFor(id, entry.harness);
        const ledger = execution.state(), run = execution.current();
        const divergence = briefDivergence({ ...ctx, id, entry });
        const observation = recoveryObservation({ id, entry, run, divergence: divergence.verdict !== "same" });
        const held = recoveryScopes(id, entry, profile).some(scope => admin.holds[scope]?.active);
        if (held || ledger.stopped || observation.classification !== "due-recovery") reason = "hold, changed requirements or intentional gate";
        else if (entry.sources?.some(path => ctx.readSource?.(id, path) == null) ||
            !ownedRecoveryRun(id, entry, run) || ledger.current?.id !== run.id ||
            ledger.taskId !== id || ledger.provider !== entry.harness || ledger.operations?.[run.execution.operationId]?.acceptance !== "accepted" ||
            ledger.operations[run.execution.operationId].runId !== run.id ||
            entry.prd_fingerprint !== prdFingerprint(divergence.snapshot)) reason = "unverified snapshot or execution ownership";
        else {
          const snapshot = turnBinding(ctx, id, entry, divergence.snapshot);
          candidates.push({ id, task: digest(entry), snapshot, profile: profile.digest, run: digest(run),
            ownership: digest([id, entry.session, run.execution]), executionLedger: digest(ledger),
            review: reviewBackup(ctx, id, entry) });
          continue;
        }
      } catch { reason = "unavailable or inconsistent protected records"; }
    }
    excluded.push({ id, reason });
  }
  const plan = { version: 1, operation: "reviewed-batch-adoption", migration: { fromVersion: registry.version, toVersion: 3, commit: "atomic-registry-replacement", backup: ["registry", "snapshots", "execution-ledgers", "review-ledgers", "immutable-review-history"] }, registry: digest(registry),
    profile: profile?.digest ?? null, candidates, excluded };
  if (digest(ctx.state.load()) !== plan.registry) throw new Error("Registry moved during inventory. Request a fresh dry run.");
  return { ...plan, digest: digest(plan) };
}

export function validateReviewedBatch(proposal, approval) {
  if (!approval || Object.keys(approval).sort().join() !== "candidateIds,proposalDigest,version" ||
      approval.version !== 1 || proposal.version !== 1 || proposal.operation !== "reviewed-batch-adoption" ||
      !Array.isArray(approval.candidateIds) || !approval.candidateIds.length ||
      new Set(approval.candidateIds).size !== approval.candidateIds.length) throw new Error("Invalid reviewed batch.");
  const { digest: saved, ...plan } = proposal;
  if (digest(plan) !== saved || approval.proposalDigest !== saved ||
      !approval.candidateIds.every(id => plan.candidates.some(c => c.id === id))) throw new Error("Reviewed batch no longer matches its proposal.");
  return { version: 1, proposalDigest: saved, registry: plan.registry,
    records: plan.candidates.filter(c => approval.candidateIds.includes(c.id)), activation: "dry-run-only" };
}
