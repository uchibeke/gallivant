#!/usr/bin/env node
// Pins the exact bytes of the shared typed-profile validator and its fixture
// corpus so Agent Passport can verify that its vendored copy is byte-identical
// and on the same schema version. `--write` refreshes the pin after a deliberate
// change; `--check` (default) fails when the pin is stale.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROFILE_VERSION } from "../lib/task_profile.mjs";
import { TASK_VERSION } from "../lib/task_contract.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONTRACT_PATH = "templates/plugin/task-intake-contract.json";
// Both files live under packaged paths, so the published artifact carries the
// exact corpus a consumer is told to run, not only its hash.
export const VENDORED_FILES = ["lib/task_profile.mjs", "templates/plugin/task-profile-requests.mjs"];
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

export function currentContract() {
  return { format: 1, profileVersion: PROFILE_VERSION, taskVersion: TASK_VERSION, validator: "lib/task_profile.mjs", fixtures: "templates/plugin/task-profile-requests.mjs",
    files: Object.fromEntries(VENDORED_FILES.map(path => [path, sha(readFileSync(join(root, path)))])),
    upgrade: "Vendor the listed files byte-for-byte. A profileVersion change requires the Agent Passport task-intake-vendor-sync PRD; older saved profiles keep their original interpretation and fail closed when unsupported." };
}
export function savedContract() { return JSON.parse(readFileSync(join(root, CONTRACT_PATH), "utf8")); }
export function contractDrift() {
  const current = currentContract(), saved = savedContract();
  return Object.keys(current.files).filter(path => current.files[path] !== saved.files?.[path]).concat(current.profileVersion !== saved.profileVersion ? ["profileVersion"] : [], current.taskVersion !== saved.taskVersion ? ["taskVersion"] : []);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    writeFileSync(join(root, CONTRACT_PATH), JSON.stringify(currentContract(), null, 2) + "\n");
    console.log(`wrote ${CONTRACT_PATH}`);
  } else {
    const drift = contractDrift();
    if (drift.length) { console.error(`task-intake contract pin is stale for ${drift.join(", ")}; run npm run contract:intake -- --write after reviewing the change`); process.exit(1); }
    console.log("task-intake contract pin matches the source");
  }
}
