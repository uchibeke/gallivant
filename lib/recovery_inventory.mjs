import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { reviewLedgerPath, reviewExecutionId } from "./first_party_review.mjs";
import { briefDivergence, prdFingerprint } from "./prd.mjs";
import { turnBinding } from "./recovery_preflight.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { recoveryObservation } from "./recovery_observation.mjs";
import { ownedRecoveryRun, recoveryScopes, validateRecoveryProfile } from "./recovery_authority.mjs";
import { executionLive } from "./execution_contract.mjs";
import { canonicalPath, syncDirectory, writeJsonAtomic } from "./fs.mjs";
import { idSlug } from "./state.mjs";
import { acquireMaintenance } from "./runtime_state.mjs";
import { recoveryFile } from "./workspace_recovery.mjs";

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
      if (record.taskId !== owner || executionLive(record.current) ||
          Object.values(record.operations).some(op => op.acceptance !== "accepted") ||
          job.run && !Object.values(record.operations).some(op => op.runId === job.run)) throw new Error("Unsettled or missing review execution.");
      executions.push({ owner, digest: digest(record) });
    }
  }
  return { ledger: ledger ? digest(ledger) : null, executions, history: digest(history) };
}

// A proposal names a complete, content-addressed recovery point.
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
        if (held || ledger.stopped || entry.route_recovery || entry.base_repair?.journal && entry.base_repair.status !== "verified" ||
            observation.classification !== "due-recovery") reason = "hold, changed requirements or intentional gate";
        else if (entry.sources?.some(path => ctx.readSource?.(id, path) == null) ||
            !ownedRecoveryRun(id, entry, run) || ledger.current?.id !== run.id ||
            ledger.taskId !== id || ledger.provider !== entry.harness || Object.values(ledger.operations || {}).some(op => op.acceptance !== "accepted") ||
            ledger.operations?.[run.execution.operationId]?.acceptance !== "accepted" ||
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

const inside = (root, path) => path === root || path.startsWith(root + sep);
function selectionPaths(ctx, home, records) {
  const files = new Map([["state.json", true]]);
  const add = (path, required = true) => {
    if (!inside(home, path)) throw new Error("Referenced adoption file is outside its coordinator namespace.");
    files.set(relative(home, path), required);
  };
  const ledgers = (id, harness, run) => {
    const execution = ctx.executionFor(id, harness), root = join(home, "runs", idSlug(id));
    // The exact original provider epoch and earlier epochs are preserved.
    if (canonicalPath(execution.root) !== root) throw new Error("Unexpected execution ledger owner.");
    const selected = execution.ledgerEpoch ? `execution-${execution.ledgerEpoch}.json` : "execution.json";
    add(join(root, selected));
    for (const name of readdirSync(root)) if (/^execution(?:-[1-9]\d*)?\.json$/.test(name)) add(join(root, name));
    for (const name of ["agents.json", "cloud.json", "latest-run"]) add(join(root, name), false);
    if (run) {
      if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error("Invalid referenced execution run.");
      for (const name of ["job.json", "result.json", "result-application.json", "verification.json", "journal.json"])
        add(join(root, run, name), false);
    }
  };
  for (const record of records) {
    const { id } = record, entry = ctx.state.get(id), slug = idSlug(id);
    add(join(home, "prds", `${slug}.md`));
    for (const path of entry.sources || []) add(join(home, "prds", `${slug}.sources`, path));
    ledgers(id, entry.harness, entry.last?.run);
    if (record.review.ledger) add(reviewLedgerPath(join(home, "reviews"), id));
    for (const { owner } of record.review.executions) ledgers(owner, "codex", ctx.executionFor(owner, "codex").current()?.id);
    for (const item of entry.reviewHistory || []) {
      const hash = item?._gallivantReviewArchive?.digest;
      if (hash) add(join(home, "reviews", "history", `${hash}.json`));
    }
  }
  return files;
}

function copyAdoptionBackup(home, out, files, batch) {
  mkdirSync(out, { mode: 0o700 });
  const copied = new Map(), dirs = new Set([dirname(out)]);
  const read = path => recoveryFile(home, path, undefined, { allowMissingParents: true, maxBytes: 256 * 1024 * 1024 });
  for (const [path, required] of files) {
    const found = read(path);
    if (!found.file && required) throw new Error("A referenced adoption record is missing. Restore it before migrating.");
    copied.set(path, [found.file, found.hash]);
    if (!found.file) continue;
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, found.bytes, { flag: "wx", mode: 0o600, flush: true });
    for (let dir = dirname(target); dir !== out; dir = dirname(dir)) dirs.add(dir);
  }
  for (const path of [...dirs].sort((a, b) => b.length - a.length)) syncDirectory(path);
  const record = { version: 1, proposal: batch.proposalDigest, registry: batch.registry,
    files: Object.fromEntries([...copied].filter(([, [file]]) => file).map(([path, [, hash]]) => [path, hash])) };
  writeJsonAtomic(join(out, "backup.json"), record, 0o600, { durable: true });
  return () => {
    for (const [path, proof] of copied) {
      const current = read(path);
      if (digest([current.file, current.hash]) !== digest(proof))
        throw new Error("The referenced adoption records changed during backup.");
    }
    return digest(record);
  };
}

export function adoptRecoveryBatch(ctx, profileId, approval, destination, intent) {
  const home = canonicalPath(ctx.home);
  if (!isAbsolute(destination)) throw new Error("Supply an absolute private adoption backup destination outside the state and worktrees.");
  const out = canonicalPath(destination);
  const worktrees = ctx.config.worktrees && canonicalPath(ctx.config.worktrees);
  if (inside(home, out) || inside(out, home) || worktrees && (inside(worktrees, out) || inside(out, worktrees)) || out !== destination)
    throw new Error("The adoption backup destination must be a fresh canonical path outside the state and worktrees.");
  const owner = acquireMaintenance(home);
  try {
    const batch = validateReviewedBatch(adoptionInventory(ctx, profileId), approval);
    return ctx.state.adoptRecoveryBatch(batch.proposalDigest, batch.registry, () => {
      const current = validateReviewedBatch(adoptionInventory(ctx, profileId), approval);
      const verify = copyAdoptionBackup(home, out, selectionPaths(ctx, home, current.records), current);
      const final = validateReviewedBatch(adoptionInventory(ctx, profileId), approval);
      const backup = verify();
      return { records: final.records, backup };
    }, intent);
  } finally { owner.release(); }
}
