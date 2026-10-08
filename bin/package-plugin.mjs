#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { buildPluginPackage, validatePublicRelease } from "../lib/plugin_package.mjs";
try {
  const { values } = parseArgs({ options: { config: { type: "string" }, out: { type: "string" }, "core-version": { type: "string" }, "source-commit": { type: "string" }, internal: { type: "boolean" }, "validate-public": { type: "boolean" } } });
  if (!values.config) throw new Error("Pass --config with the APort endpoint, resource, publisher and asset inputs");
  const config = JSON.parse(readFileSync(values.config, "utf8"));
  if (values["validate-public"]) {
    const result = validatePublicRelease(config); console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
  } else {
    if (!values.out) throw new Error("Pass --out with an empty artifact directory");
    const manifest = buildPluginPackage({ config, out: values.out, coreVersion: values["core-version"], sourceCommit: values["source-commit"], internal: values.internal });
    console.log(JSON.stringify({ classification: manifest.classification, coreSha256: manifest.coreSha256, hashes: manifest.hashes }, null, 2));
  }
} catch (error) { console.error(`${error.code || "PACKAGE_FAILED"}: ${error.message}`); process.exitCode = 1; }
