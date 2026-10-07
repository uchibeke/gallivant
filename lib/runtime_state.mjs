import { join, resolve, dirname } from "node:path";
import { readdirSync, lstatSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireDaemon } from "./daemon.mjs";
import { assertCompatible, deliveryError } from "./task_delivery_contract.mjs";
import { executionLive } from "./execution.mjs";
import { preparationCancellationPending } from "./task_prepare.mjs";
const paths = ["state.json", "tasks", "prds", "runs", "delivery", "coordinator.json", "runtime-pin.json"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function files(root, prefix = "") {
  const result = [];
  for (const name of readdirSync(join(root, prefix))) {
    const path = join(prefix, name), stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) throw deliveryError("RUNTIME_STATE", "State backup refuses symlinks; inspect the durable volume");
    if (stat.isDirectory()) result.push(...files(root, path));
    else if (stat.isFile() && !path.endsWith(".lock") && !path.endsWith(".lock.recovery")) result.push(path);
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
export function checkRuntimeState({ home, manifest }) {
  assertCompatible(manifest);
  const state = readJson(join(home, "state.json"), { version: 1, entries: {} });
  if (state.version !== 1) throw deliveryError("RUNTIME_STATE", "Unsupported registry; restore its matching backup/package before restart");
  const pin = readJson(join(home, "runtime-pin.json"));
  let active = Object.values(state.entries).some(e => e.state !== "done") || Object.keys(state.starts || {}).length > 0 ||
    Object.values(state.chains || {}).some(c => !["done", "cancelled"].includes(c.status));
  for (const rel of stateFiles(home)) {
      if (/(?:intake|execution|agents|codex-cloud)\.json$/.test(rel)) {
        const record = readJson(join(home, rel));
        if (record?.version !== 1) throw deliveryError("RUNTIME_STATE", `Unsupported ${rel}; preserve it and migrate with its original package`);
        if (/intake\.json$/.test(rel)) {
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
  if (pin && pin.coreSha256 !== manifest.coreSha256 && active) throw deliveryError("RUNTIME_ACTIVE_PIN", "Active jobs pin the old artifact. Keep their runtime, stop new intake and drain them; stage the update in another namespace. Do not replace active-job code.");
  return { compatible: true, active, pinned: pin?.coreSha256 || null, entries: Object.keys(state.entries).length };
}
export function migrateRuntimeState({ home, manifest }) {
  const lock = acquireDaemon(home);
  try {
    const result = checkRuntimeState({ home, manifest });
    if (!/^[a-f0-9]{64}$/.test(manifest.coreSha256 || "")) throw deliveryError("RUNTIME_STATE", "Use the exact emitted runtime.json with its artifact digest");
    writeJsonAtomic(join(home, "runtime-pin.json"), { version: 1, coreVersion: manifest.coreVersion, coreSha256: manifest.coreSha256 });
    return result;
  } finally { lock.release(); }
}
export function backupRuntimeState({ home, out, manifest }) {
  home = resolve(home); out = resolve(out);
  if (out === home || out.startsWith(home + "/") || home.startsWith(out + "/")) throw deliveryError("RUNTIME_STATE", "Backup must be outside the durable namespace");
  const lock = acquireDaemon(home);
  try {
    checkRuntimeState({ home, manifest });
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
