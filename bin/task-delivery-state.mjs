#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { checkRuntimeState, migrateRuntimeState, backupRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { home: { type: "string" }, manifest: { type: "string" }, out: { type: "string" }, backup: { type: "string" } } });
  const [action] = positionals, restoring = ["rollback", "import"].includes(action);
  if (!values.manifest || !values.home && !restoring) throw new Error("Pass --manifest runtime.json and --home the durable namespace");
  if (restoring && (!values.backup || !values.out) || ["backup", "export"].includes(action) && !values.out) throw new Error("Supply a fresh --out; import and rollback also need --backup");
  const manifest = JSON.parse(readFileSync(values.manifest, "utf8"));
  const fn = { check: checkRuntimeState, migrate: migrateRuntimeState, backup: backupRuntimeState, export: backupRuntimeState, rollback: restoreRuntimeState, import: restoreRuntimeState }[action];
  if (!fn) throw new Error("Use check, migrate, backup, export, rollback or import");
  console.log(JSON.stringify(fn({ ...values, manifest }), null, 2));
} catch (error) { console.error(`${error.code || "RUNTIME_STATE"}: ${error.message}`); process.exitCode = 1; }
