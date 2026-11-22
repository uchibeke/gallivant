import { join, dirname } from "node:path";
import { readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic, canonicalPath } from "./fs.mjs";
import { acquireRuntimeOwner, acquireTaskMutation } from "./daemon.mjs";
import { assertCompatible, CORE_VERSION, deliveryError } from "./task_delivery_contract.mjs";
import { learningStore } from "./learning_store.mjs";
import { executionLive } from "./execution.mjs";
import { preparationCancellationPending } from "./task_prepare.mjs";
import { completionStopsAutomation } from "./task_completion.mjs";
import { learningDeliveryPending } from "./learning_input.mjs";
import { idSlug, supportedStateVersion } from "./state.mjs";
import { reviewHistoryStore } from "./review_history.mjs";
import { recoveryDrainReasons, settledCancellation } from "./recovery_rollout.mjs";
import { checkPlanRegistry } from "./dependency_plan_registry.mjs";
import { DISPATCH_REGISTRY_VERSION, PLAN_REGISTRY_VERSION, PLAN_STORE_VERSION, matchesPlanFormat } from "./registry_versions.mjs";
import { checkDispatchState } from "./dispatch_capacity.mjs";
import { contentDigest, sourceManifestDigest } from "./start_contract.mjs";
import { readRepositoryText } from "./repository_files.mjs";

export const PLAN_RUNTIME_FORMAT = Object.freeze({ registryVersion: DISPATCH_REGISTRY_VERSION, dependencyPlanVersion: PLAN_STORE_VERSION });
const paths = ["state.json", "learning", "tasks", "prds", "runs", "delivery", "coordinator.json", "runtime-pin.json",
  "recovery-schedule.json", "recovery-cooldowns.json", "git-recovery"];
// Review execution scratch can contain many directories, links and unrelated
// data. Only the ledger and content-addressed history files are durable state.
const durableReviewPath = path => /^reviews\/(?:[a-f0-9]{64}\.json|history\/[a-f0-9]{64}\.json)$/.test(path);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
// Repository snapshots can contain any of these basenames. Only the layouts
// written by taskStore, context.executionFor and createDeliveryStore are owned.
const intakePath = path => /^tasks\/task-[a-f0-9]{24}\/intake\.json$/.test(path);
const deliveryPath = path => /^delivery\/[a-f0-9]{64}\/delivery\.json$/.test(path);
const executionLedgerPath = path => /^runs\/[^/]+\/execution(?:-[1-9]\d*)?\.json$/.test(path);
const ledgerPath = path => executionLedgerPath(path) || /^runs\/[^/]+\/(?:agents|cloud)\.json$/.test(path);
const processLockPath = path => /^learning\/operation\.lock(?:\.recovery)?$/.test(path) || /^(?:tasks\/task-[a-f0-9]{24}\/intake|runs\/[^/]+\/(?:execution(?:-[1-9]\d*)?|publication)|delivery\/[a-f0-9]{64}\/delivery|reviews\/[a-f0-9]{64}\.json)\.lock(?:\.recovery)?$/.test(path) || /^reviews\/history\/\.pending-/.test(path);
function files(root, prefix = "") {
  const result = [];
  for (const name of readdirSync(join(root, prefix))) {
    const path = join(prefix, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "State backup refuses symlinks; inspect the durable volume");
    if (processLockPath(path)) continue;
    if (stat.isDirectory()) result.push(...files(root, path));
    else if (stat.isFile()) result.push(path);
  }
  return result;
}
function stateFiles(home) {
  const regular = paths.filter(p => existsSync(join(home, p))).flatMap(path => {
    const stat = lstatSync(join(home, path));
    if (stat.isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "State backup refuses symlinks; inspect the durable volume");
    if (stat.isDirectory()) return files(home, path);
    if (!stat.isFile()) throw deliveryError("RUNTIME_STATE", "State contains an unsupported filesystem object");
    return [path];
  });
  const reviews = join(home, "reviews"), durable = [];
  if (!existsSync(reviews)) return regular;
  if (!lstatSync(reviews).isDirectory()) throw deliveryError("RUNTIME_STATE", "Review state path must be a private directory");
  const collect = (root, prefix) => {
    for (const name of readdirSync(root)) {
      const rel = `${prefix}/${name}`;
      if (!durableReviewPath(rel)) continue;
      if (!lstatSync(join(home, rel)).isFile()) throw deliveryError("RUNTIME_STATE", "Review backup refuses non-file evidence");
      durable.push(rel);
    }
  };
  collect(reviews, "reviews");
  const history = join(reviews, "history");
  if (existsSync(history)) {
    if (!lstatSync(history).isDirectory()) throw deliveryError("RUNTIME_STATE", "Review history path must be a private directory");
    collect(history, "reviews/history");
  }
  return [...regular, ...durable];
}
// Capture the process artifact once; never learn its identity from mutable state.
export function runtimePinManifest(manifest = {}) {
  assertCompatible(manifest || {});
  if (manifest.coreVersion !== CORE_VERSION || !/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("COORDINATOR_PIN", "Supply this package artifact's exact emitted runtime.json; drain active jobs before changing packages");
  return Object.freeze({ ...manifest });
}
export function assertRuntimePin({ home, manifest }) {
  const pin = readJson(join(home, "runtime-pin.json"));
  const pinnedFormat = matchesPlanFormat(pin) ? pin.registryVersion : null;
  const runtimeFormat = matchesPlanFormat(manifest) ? manifest.registryVersion : null;
  if (pin?.version !== 1 || pin.coreVersion !== manifest.coreVersion || pin.coreSha256 !== manifest.coreSha256 || pinnedFormat !== runtimeFormat) throw deliveryError("COORDINATOR_PIN", "Run task-delivery-state migrate with this package artifact's exact runtime.json before enabling mutations or wake-ups");
  checkRuntimeState({ home, manifest });
}

export function checkRuntimeState({ home, manifest }) {
  assertCompatible(manifest);
  const state = readJson(join(home, "state.json"), { version: 1, entries: {} });
  const registryVersion = manifest.registryVersion ?? 2;
  if (!supportedStateVersion(registryVersion) || !supportedStateVersion(state.version) || state.version > registryVersion)
    throw deliveryError("RUNTIME_STATE", "Unsupported registry; drain with its compatible runtime and preserve the matching state before changing packages");
  const pin = readJson(join(home, "runtime-pin.json"));
  try { checkPlanRegistry(state); checkDispatchState(state); } catch (error) { throw deliveryError("RUNTIME_STATE", error.message); }
  if (state.version >= PLAN_REGISTRY_VERSION && !matchesPlanFormat(manifest, state.version)) {
    throw deliveryError("RUNTIME_STATE", "This registry contains dependency plans or reserved authors. Use its compatible runtime manifest.");
  }
  if (state.version >= PLAN_REGISTRY_VERSION && pin?.coreSha256 && pin.coreSha256 === manifest.coreSha256 && !matchesPlanFormat(pin, state.version)) {
    throw deliveryError("RUNTIME_STATE", "The active artifact pin lacks the dependency plan format. Restore its matching pin and coherent backup.");
  }
  // Qualified handoffs and confirmed cancellations retain their registry history.
  // Unlike scheduling, migration still pins unresolved needs-human work. Pending
  // controls and live execution pin the artifact independently of registry state.
  const anchors = new Set(Object.values(state.chains || {}).filter(c => !["done", "cancelled"].includes(c.status)).map(c => c.after?.id));
  let active = Object.entries(state.entries).some(([id, e]) => recoveryDrainReasons(e, anchors.has(id)).length ||
    e.state !== "done" && !settledCancellation(e) && !completionStopsAutomation(e)) || Object.keys(state.starts || {}).length > 0 ||
    Object.values(state.chains || {}).some(c => !["done", "cancelled"].includes(c.status)) || Object.keys(state.dispatch?.authors ?? {}).length > 0;
  for (const rel of stateFiles(home)) {
      if (intakePath(rel) || ledgerPath(rel) || deliveryPath(rel)) {
        const record = readJson(join(home, rel));
        if (record?.version !== 1) throw deliveryError("RUNTIME_STATE", `Unsupported ${rel}; preserve it and migrate with its original package`);
        if (deliveryPath(rel)) {
          // Delivery intent can precede intake creation; unfinished scheduling
          // also belongs to the original artifact, including safety controls.
          for (const key of ["operations", "cancellations"]) {
            const receipts = record[key] ?? {};
            if (typeof receipts !== "object" || Array.isArray(receipts)) throw deliveryError("RUNTIME_STATE", `Unsupported ${rel} receipts; preserve them and recover with their original package`);
            active ||= Object.values(receipts).some(receipt => receipt?.status !== "acknowledged" || Boolean(receipt.wakePending));
          }
        } else if (intakePath(rel)) {
          const attempts = record.attempts || [];
          // Intake/readiness can own work before implementation registration,
          // including blocked attempts whose cancellation is still unresolved.
          // Successful starts retain historical intent alongside their acknowledged
          // implementation; only unresolved intent independently pins the intake.
          const dispatchPending = record.dispatchIntent && (record.status !== "started" || !record.dispatchIntent.id || record.implementation?.id !== record.dispatchIntent.id);
          active ||= Boolean(dispatchPending) || ["preparing", "validating"].includes(record.status) || record.readiness?.pending === true ||
            attempts.some(attempt => attempt.settled !== true || attempt.execution && executionLive({ execution: attempt.execution })) ||
            preparationCancellationPending({ ...record, attempts });
        } else if (executionLedgerPath(rel)) {
          // Use the canonical liveness rule; unknown acceptance and uncollected
          // terminal results cannot qualify an idle namespace.
          active ||= executionLive(record.current) || Object.values(record.operations || {}).some(op => op.acceptance !== "accepted");
        }
      }
  }
  if (active && (!pin || pin.coreSha256 !== manifest.coreSha256)) throw deliveryError("RUNTIME_ACTIVE_PIN", "Active jobs pin the old artifact. Keep their runtime, stop new intake and drain them; stage the update in another namespace. Do not replace active-job code.");
  return { compatible: true, active, pinned: pin?.coreSha256 || null, entries: Object.keys(state.entries).length };
}
const planFormat = manifest => ({ registryVersion: manifest.registryVersion, dependencyPlanVersion: manifest.dependencyPlanVersion });
function checkReviewHistoryArchives(home) {
  const state = readJson(join(home, "state.json"), { version: 1, entries: {} }), store = reviewHistoryStore(home);
  try {
    for (const entry of Object.values(state.entries)) for (const item of entry.reviewHistory || []) {
      if (item?._gallivantReviewArchive) store.hydrate(item);
    }
  } catch { throw deliveryError("RUNTIME_STATE", "Review history is missing or corrupted; restore its matching private archive before backup or restore"); }
}

function checkPlanBackupReferences(home, registry) {
  if (registry.version < PLAN_REGISTRY_VERSION) return;
  try {
    for (const [id, entry] of Object.entries(registry.entries)) {
      const slug = idSlug(id), root = join(home, "prds"), run = entry.execution?.runId ?? entry.last?.run;
      if (entry.snapshot_digest && contentDigest(readRepositoryText(root, `${slug}.md`)) !== entry.snapshot_digest) throw new Error();
      if (entry.sources_digest && sourceManifestDigest((entry.sources ?? []).map(path => [path, readRepositoryText(root, `${slug}.sources/${path}`)])) !== entry.sources_digest) throw new Error();
      if (executionLive(entry) && run && !readJson(join(home, "runs", slug, entry.execution_epoch ? `execution-${entry.execution_epoch}.json` : "execution.json"))) throw new Error();
    }
  } catch { throw deliveryError("RUNTIME_STATE", "Approved snapshots or live execution ledgers are missing or changed; restore the coherent private namespace before backup or import"); }
}
// CLI writes can coexist with the daemon, but maintenance excludes both owners.
export function acquireMaintenance(home) {
  const runtime = acquireRuntimeOwner(home);
  try {
    const task = acquireTaskMutation(home);
    try {
      const releaseLearning = learningStore(join(canonicalPath(home), "learning")).lock();
      return { release() { try { releaseLearning(); } finally { try { task.release(); } finally { runtime.release(); } } } };
    } catch (error) { task.release(); throw error; }
  } catch (error) { runtime.release(); throw error; }
}
export function migrateRuntimeState({ home, manifest }) {
  const lock = acquireMaintenance(home);
  try {
    const result = checkRuntimeState({ home, manifest });
    if (!/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("RUNTIME_STATE", "Use the exact emitted runtime.json with its artifact digest");
    writeJsonAtomic(join(home, "runtime-pin.json"), { version: 1, coreVersion: manifest.coreVersion, coreSha256: manifest.coreSha256,
      ...(matchesPlanFormat(manifest) ? planFormat(manifest) : {}) });
    return result;
  } finally { lock.release(); }
}
function checkBackupPin(pin, manifest) {
  if (!/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("RUNTIME_STATE", "Use the exact emitted runtime.json with its artifact digest");
  if (pin !== undefined && (pin?.version !== 1 || pin.coreSha256 !== manifest.coreSha256 || pin.coreVersion !== manifest.coreVersion)) {
    throw deliveryError("RUNTIME_STATE", "Backup and rollback require the currently pinned artifact's runtime.json; use the pre-upgrade manifest, then migrate with the candidate separately");
  }
}
export function backupRuntimeState({ home, out, manifest }) {
  home = canonicalPath(home); out = canonicalPath(out);
  if (out === home || out.startsWith(home + "/") || home.startsWith(out + "/")) throw deliveryError("RUNTIME_STATE", "Backup must be outside the durable namespace");
  const lock = acquireMaintenance(home);
  try {
    checkRuntimeState({ home, manifest });
    checkReviewHistoryArchives(home);
    const registry = readJson(join(home, "state.json"), { version: 1, entries: {} });
    checkPlanBackupReferences(home, registry);
    const pinPath = join(home, "runtime-pin.json");
    checkBackupPin(existsSync(pinPath) ? readJson(pinPath) : undefined, manifest);
    mkdirSync(out, { mode: 0o700 });
    try {
      const hashes = {}, members = stateFiles(home).sort();
      for (const rel of members) {
        mkdirSync(dirname(join(out, rel)), { recursive: true, mode: 0o700 });
        const bytes = readFileSync(join(home, rel));
        writeFileSync(join(out, rel), bytes, { mode: 0o600 }); hashes[rel] = sha(bytes);
      }
      const planRegistry = registry.version >= PLAN_REGISTRY_VERSION;
      if (planRegistry && (JSON.stringify(stateFiles(home).sort()) !== JSON.stringify(members) ||
          members.some(rel => sha(readFileSync(join(home, rel))) !== hashes[rel]))) {
        throw deliveryError("RUNTIME_STATE", "The namespace changed during backup; preserve the original and retry after writes settle");
      }
      writeJsonAtomic(join(out, "backup.json"), { version: planRegistry ? 2 : 1, coreSha256: manifest.coreSha256, hashes,
        ...(planRegistry ? { ...planFormat(manifest), namespaceDigest: namespaceDigest(hashes) } : {}) }, 0o600, { durable: true });
      return { backup: out, files: members.length };
    } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
  } finally { lock.release(); }
}
const namespaceDigest = hashes => sha(JSON.stringify(Object.entries(hashes).sort()));

export function restoreRuntimeState({ backup, out, manifest }) {
  if (lstatSync(backup).isSymbolicLink() || lstatSync(join(backup, "backup.json")).isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "Unsafe backup path");
  const record = readJson(join(backup, "backup.json"));
  assertCompatible(manifest);
  if (![1, 2].includes(record?.version) || record.coreSha256 !== manifest.coreSha256) throw deliveryError("RUNTIME_STATE", "Restore the matching package artifact and backup; never mix state and code");
  if (!record.hashes || typeof record.hashes !== "object" || Array.isArray(record.hashes)) throw deliveryError("RUNTIME_STATE", "Invalid backup manifest");
  const validated = [];
  for (const [path, hash] of Object.entries(record.hashes)) {
    const parts = path.split("/");
    if (processLockPath(path) || !durableReviewPath(path) && !paths.some(p => path === p || path.startsWith(p + "/")) || parts.some(p => ["..", ".", ""].includes(p)) || path.includes("\\") || !/^[a-f0-9]{64}$/.test(hash)) throw deliveryError("RUNTIME_STATE", "Unsafe backup path");
    for (let i = 1; i <= parts.length; i++) {
      const stat = lstatSync(join(backup, ...parts.slice(0, i)));
      if (stat.isSymbolicLink() || (i === parts.length ? !stat.isFile() : !stat.isDirectory())) throw deliveryError("RUNTIME_STATE", "Unsafe backup path");
    }
    const bytes = readFileSync(join(backup, path));
    if (sha(bytes) !== hash) throw deliveryError("RUNTIME_STATE", "Backup hash changed; restore the original immutable backup");
    validated.push([path, bytes]);
  }
  // The backup envelope and copied pin must identify the same artifact, even
  // for idle state (the ordinary state check intentionally allows idle upgrades).
  const savedPin = validated.find(([path]) => path === "runtime-pin.json");
  checkBackupPin(savedPin ? JSON.parse(savedPin[1].toString("utf8")) : undefined, manifest);
  const savedRegistry = validated.find(([path]) => path === "state.json");
  const registry = savedRegistry ? JSON.parse(savedRegistry[1].toString("utf8")) : { version: 1, entries: {} };
  if ((registry.version >= PLAN_REGISTRY_VERSION || record.version === 2) &&
      (registry.version < PLAN_REGISTRY_VERSION || record.version !== 2 || !matchesPlanFormat(record, registry.version) ||
      !matchesPlanFormat(manifest, registry.version) || record.registryVersion !== manifest.registryVersion ||
      record.namespaceDigest !== namespaceDigest(record.hashes))) {
    throw deliveryError("RUNTIME_STATE", "Dependency plans require a complete versioned namespace backup and matching runtime artifact");
  }
  // Validate every file before creating a fresh private namespace.
  mkdirSync(out, { mode: 0o700 });
  try {
    for (const [path, bytes] of validated) {
      mkdirSync(dirname(join(out, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(out, path), bytes, { mode: 0o600 });
    }
    const result = checkRuntimeState({ home: out, manifest });
    checkReviewHistoryArchives(out);
    checkPlanBackupReferences(out, registry);
    return result;
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}
