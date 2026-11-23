import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { directoryIdentity, inventoryOwnedDirectory, sameDirectory } from "../lib/owned_artifacts.mjs";
import { retireRuntimeTemporary, runtimeTemporaryProof } from "../lib/runtime-environment.mjs";

let suite = null, count = 0;
let teardownInstalled = false;
const owned = new Set();
const bounds = { entries: 150_000, milliseconds: 3000, allowHardlinks: true };

function remove(proof) {
  const root = dirname(proof.path), rel = basename(proof.path), current = directoryIdentity(root, rel);
  if (!current) return;
  if (!sameDirectory(current, proof)) throw new Error("fixture ownership changed");
  inventoryOwnedDirectory(current, bounds);
  if (!sameDirectory(directoryIdentity(root, rel), proof)) throw new Error("fixture ownership changed before removal");
  rmSync(current.path, { recursive: true, force: true });
}

export function teardownFixtures() {
  for (const proof of owned) {
    try { remove(proof); owned.delete(proof); }
    catch (error) { process.stderr.write(`Retained test fixture tree (${error.code || "owner proof unavailable"}).\n`); }
  }
  if (!owned.size) suite = null;
}

function installTeardown() {
  if (teardownInstalled) return;
  teardownInstalled = true;
  process.once("exit", teardownFixtures);
  if (process.env.NODE_TEST_CONTEXT) {
    for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143]]) process.once(signal, () => {
      teardownFixtures(); process.exit(status);
    });
  }
}

// Every ordinary test home is inside a single, inode-bound root per process.
// Signal cleanup leaves committed diagnostic files outside this root alone.
export function fixtureHome() {
  if (!suite) {
    const path = mkdtempSync(join(tmpdir(), "gvt-fixtures-"));
    suite = directoryIdentity(dirname(path), basename(path));
    owned.add(suite);
    installTeardown();
  }
  const child = join(suite.path, String(++count));
  mkdirSync(child, { mode: 0o700 });
  return child;
}

export function ownRuntimeFixture(t, checkout) {
  installTeardown();
  const proof = runtimeTemporaryProof(checkout);
  if (proof.scratch) owned.add(proof.scratch);
  t.after(async () => {
    await retireRuntimeTemporary(checkout, proof);
    owned.delete(proof.scratch);
  });
  return proof;
}
