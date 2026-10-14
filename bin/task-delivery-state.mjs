#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { checkRuntimeState, migrateRuntimeState, backupRuntimeState, restoreRuntimeState } from "../lib/runtime_state.mjs";
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { home: { type: "string" }, manifest: { type: "string" }, out: { type: "string" }, backup: { type: "string" } } });
  if (!values.manifest || !values.home && positionals[0] !== "rollback") throw new Error("Pass --manifest runtime.json and --home the durable namespace");
  const manifest = JSON.parse(readFileSync(values.manifest, "utf8"));
  const fn = { check: checkRuntimeState, migrate: migrateRuntimeState, backup: backupRuntimeState, rollback: restoreRuntimeState }[positionals[0]];
  if (!fn) throw new Error("Use check, migrate, backup or rollback (rollback needs --backup and fresh --out)");
  console.log(JSON.stringify(fn({ ...values, manifest }), null, 2));
} catch (error) { console.error(`${error.code || "RUNTIME_STATE"}: ${error.message}`); process.exitCode = 1; }
