import { join, dirname } from "node:path";
import { readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic, canonicalPath } from "./fs.mjs";
import { acquireRuntimeOwner, acquireTaskMutation } from "./daemon.mjs";
import { assertCompatible, CORE_VERSION, deliveryError } from "./task_delivery_contract.mjs";
import { controlPending } from "./control.mjs";
import { executionLive } from "./execution.mjs";
import { preparationCancellationPending } from "./task_prepare.mjs";
const paths = ["state.json", "tasks", "prds", "runs", "delivery", "coordinator.json", "runtime-pin.json"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
// Repository snapshots can contain any of these basenames. Only the layouts
// written by taskStore, context.executionFor and createDeliveryStore are owned.
const intakePath = path => /^tasks\/task-[a-f0-9]{24}\/intake\.json$/.test(path);
const ledgerPath = path => /^runs\/[^/]+\/(?:execution|agents|cloud)\.json$/.test(path);
const processLockPath = path => /^(?:tasks\/task-[a-f0-9]{24}\/intake|runs\/[^/]+\/(?:execution|publication)|delivery\/[a-f0-9]{64}\/delivery)\.lock(?:\.recovery)?$/.test(path);
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
  return paths.filter(p => existsSync(join(home, p))).flatMap(path => {
    const stat = lstatSync(join(home, path));
    if (stat.isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "State backup refuses symlinks; inspect the durable volume");
    if (stat.isDirectory()) return files(home, path);
    if (!stat.isFile()) throw deliveryError("RUNTIME_STATE", "State contains an unsupported filesystem object");
    return [path];
  });
}
// Capture the process artifact once; never learn its identity from mutable state.
export function runtimePinManifest(manifest = {}) {
  assertCompatible(manifest || {});
  if (manifest.coreVersion !== CORE_VERSION || !/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("COORDINATOR_PIN", "Supply this package artifact's exact emitted runtime.json; drain active jobs before changing packages");
  return Object.freeze({ ...manifest });
}
export function assertRuntimePin({ home, manifest }) {
  const pin = readJson(join(home, "runtime-pin.json"));
  if (pin?.version !== 1 || pin.coreVersion !== manifest.coreVersion || pin.coreSha256 !== manifest.coreSha256) throw deliveryError("COORDINATOR_PIN", "Run task-delivery-state migrate with this package artifact's exact runtime.json before enabling mutations or wake-ups");
  checkRuntimeState({ home, manifest });
}

export function checkRuntimeState({ home, manifest }) {
  assertCompatible(manifest);
  const state = readJson(join(home, "state.json"), { version: 1, entries: {} });
  if (state.version !== 1) throw deliveryError("RUNTIME_STATE", "Unsupported registry; restore its matching backup/package before restart");
  const pin = readJson(join(home, "runtime-pin.json"));
  // Confirmed cancellations retain their registry history in needs-human.
  // Pending controls and live execution still pin the artifact independently.
  const cancelled = e => e.state === "needs-human" && e.reason === "cancelled" && e.dispatch_stopped &&
    !controlPending(e.control) && !executionLive(e);
  let active = Object.values(state.entries).some(e => e.state !== "done" && !cancelled(e)) || Object.keys(state.starts || {}).length > 0 ||
    Object.values(state.chains || {}).some(c => !["done", "cancelled"].includes(c.status));
  for (const rel of stateFiles(home)) {
      if (intakePath(rel) || ledgerPath(rel)) {
        const record = readJson(join(home, rel));
        if (record?.version !== 1) throw deliveryError("RUNTIME_STATE", `Unsupported ${rel}; preserve it and migrate with its original package`);
        if (intakePath(rel)) {
          const attempts = record.attempts || [];
          // Intake/readiness can own work before implementation registration,
          // including blocked attempts whose cancellation is still unresolved.
          active ||= ["preparing", "validating"].includes(record.status) || record.readiness?.pending === true ||
            attempts.some(attempt => attempt.settled !== true || attempt.execution && executionLive({ execution: attempt.execution })) ||
            preparationCancellationPending({ ...record, attempts });
        } else if (/execution\.json$/.test(rel)) {
          // Use the canonical liveness rule; unknown acceptance and uncollected
          // terminal results cannot qualify an idle namespace.
          active ||= executionLive(record.current) || Object.values(record.operations || {}).some(op => op.acceptance !== "accepted");
        }
      }
  }
  if (active && (!pin || pin.coreSha256 !== manifest.coreSha256)) throw deliveryError("RUNTIME_ACTIVE_PIN", "Active jobs pin the old artifact. Keep their runtime, stop new intake and drain them; stage the update in another namespace. Do not replace active-job code.");
  return { compatible: true, active, pinned: pin?.coreSha256 || null, entries: Object.keys(state.entries).length };
}
// CLI writes can coexist with the daemon, but maintenance excludes both owners.
function acquireMaintenance(home) {
  const runtime = acquireRuntimeOwner(home);
  try {
    const task = acquireTaskMutation(home);
    return { release() { try { task.release(); } finally { runtime.release(); } } };
  } catch (error) { runtime.release(); throw error; }
}
export function migrateRuntimeState({ home, manifest }) {
  const lock = acquireMaintenance(home);
  try {
    const result = checkRuntimeState({ home, manifest });
    if (!/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("RUNTIME_STATE", "Use the exact emitted runtime.json with its artifact digest");
    writeJsonAtomic(join(home, "runtime-pin.json"), { version: 1, coreVersion: manifest.coreVersion, coreSha256: manifest.coreSha256 });
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
    const pinPath = join(home, "runtime-pin.json");
    checkBackupPin(existsSync(pinPath) ? readJson(pinPath) : undefined, manifest);
    mkdirSync(out, { mode: 0o700 });
    const hashes = {};
    for (const rel of stateFiles(home)) {
      mkdirSync(dirname(join(out, rel)), { recursive: true, mode: 0o700 });
      const bytes = readFileSync(join(home, rel));
      writeFileSync(join(out, rel), bytes, { mode: 0o600 }); hashes[rel] = sha(bytes);
    }
    writeJsonAtomic(join(out, "backup.json"), { version: 1, coreSha256: manifest.coreSha256, hashes });
    return { backup: out, files: Object.keys(hashes).length };
  } finally { lock.release(); }
}
export function restoreRuntimeState({ backup, out, manifest }) {
  if (lstatSync(backup).isSymbolicLink() || lstatSync(join(backup, "backup.json")).isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "Unsafe backup path");
  const record = readJson(join(backup, "backup.json"));
  assertCompatible(manifest);
  if (record?.version !== 1 || record.coreSha256 !== manifest.coreSha256) throw deliveryError("RUNTIME_STATE", "Restore the matching package artifact and backup; never mix state and code");
  if (!record.hashes || typeof record.hashes !== "object" || Array.isArray(record.hashes)) throw deliveryError("RUNTIME_STATE", "Invalid backup manifest");
  const validated = [];
  for (const [path, hash] of Object.entries(record.hashes)) {
    const parts = path.split("/");
    if (!paths.some(p => path === p || path.startsWith(p + "/")) || parts.some(p => ["..", ".", ""].includes(p)) || path.includes("\\") || !/^[a-f0-9]{64}$/.test(hash)) throw deliveryError("RUNTIME_STATE", "Unsafe backup path");
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
  // Validate every file before creating a fresh private namespace.
  mkdirSync(out, { mode: 0o700 });
  try {
    for (const [path, bytes] of validated) {
      mkdirSync(dirname(join(out, path)), { recursive: true, mode: 0o700 });
      writeFileSync(join(out, path), bytes, { mode: 0o600 });
    }
    return checkRuntimeState({ home: out, manifest });
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}
