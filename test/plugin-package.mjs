import { CORE_VERSION } from "../lib/task_delivery_contract.mjs";
// Artifact-installed verification only. Fixtures are never installed-host evidence.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, openSync, closeSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { buildPluginPackage, validatePublicRelease } from "../lib/plugin_package.mjs";
import { build } from "esbuild";
const root = resolve(new URL("..", import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), "task-plugin-consumer-"));
const ui = join(temp, "fixture-ui.html");
writeFileSync(ui, "<!doctype html><title>Internal task resource fixture</title><p>No live host evidence.</p>");
const config = { publisher: "APort", fixture: true, endpoint: "https://example.com/task-delivery/mcp", resource: { uri: "ui://task-delivery/app", domain: "https://example.com", connectDomains: ["https://example.com"], resourceDomains: [] }, assets: { ui } };
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const out = join(temp, "artifacts");
const manifest = buildPluginPackage({ config, out, coreVersion: CORE_VERSION, sourceCommit: commit, internal: true });
const duplicate = buildPluginPackage({ config, out: join(temp, "rebuild"), coreVersion: CORE_VERSION, sourceCommit: commit, internal: true });
assert.deepEqual(manifest.hashes, duplicate.hashes, "same source/config must reproduce exact ZIP/runtime/operation hashes");
assert.equal(manifest.coreSha256, duplicate.coreSha256);
const unpacked = join(temp, "unpacked"); mkdirSync(unpacked);
execFileSync("tar", ["-xzf", join(out, manifest.coreArtifact), "-C", unpacked]);
for (const [path, hash] of Object.entries(manifest.payloadHashes)) assert.equal(createHash("sha256").update(readFileSync(join(unpacked, "package", path))).digest("hex"), hash, `emitted payload hash: ${path}`);
assert.deepEqual(readFileSync(join(out, "plugin/LICENSE")), readFileSync(join(root, "LICENSE")));
assert.deepEqual(JSON.parse(readFileSync(join(out, "operations.json"))).map(o => o.name), ["capabilities", "prepare", "answer", "resume", "validate", "start", "list", "inspect", "evidence", "logs", "control"]);
const secretUi = join(temp, "secret-ui.html"), rejected = join(temp, "rejected");
writeFileSync(secretUi, "Bearer private-credential-test-value");
assert.throws(() => buildPluginPackage({ config: { ...config, assets: { ui: secretUi } }, out: rejected, coreVersion: CORE_VERSION, sourceCommit: commit, internal: true }), { code: "PACKAGE_ASSET" });
assert.equal(existsSync(rejected), false, "failed packaging removes the partial artifact it owns");
const publicCheck = validatePublicRelease(config);
assert.equal(publicCheck.ok, false); assert.equal(publicCheck.submissionReady, false);
assert.ok(publicCheck.errors.some(e => e.includes("supportEmail")) && publicCheck.errors.some(e => e.includes("real HTTPS")) && publicCheck.errors.some(e => e.includes("built")));
assert.throws(() => buildPluginPackage({ config, out: join(temp, "public"), coreVersion: CORE_VERSION, sourceCommit: commit }), { code: "PACKAGE_RELEASE" });
const consumer = join(temp, "consumer");
mkdirSync(consumer, { recursive: true });
writeFileSync(join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
execFileSync("npm", ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(out, manifest.coreArtifact), "@modelcontextprotocol/sdk@1.32.1"], { cwd: consumer, stdio: "pipe" });
cpSync(new URL("fixtures/plugin-installed-flow.mjs", import.meta.url), join(consumer, "flow.mjs"));
let helpers = readFileSync(new URL("helpers.mjs", import.meta.url), "utf8");
helpers = helpers.replace(/"\.\.\/lib\/(?:state|log|config|identity|harness|block)\.mjs"/g, '"@uchibeke/gallivant/runtime/node/dependencies"');
writeFileSync(join(consumer, "helpers.mjs"), helpers);
const draft = readFileSync(new URL("fixtures/task-intake.mjs", import.meta.url), "utf8").replace('"../../lib/task_contract.mjs"', '"@uchibeke/gallivant/runtime/node/dependencies"');
writeFileSync(join(consumer, "draft.mjs"), draft);
mkdirSync(join(consumer, "fixtures"));
writeFileSync(join(consumer, "fixtures/task-intake.mjs"), draft);
writeFileSync(join(consumer, "candidate.json"), JSON.stringify({ manifest, out }));
let pagesErrors;
try { await build({ entryPoints: [join(consumer, "node_modules/@uchibeke/gallivant/lib/runtime_node.mjs")], platform: "browser", bundle: true, write: false, logLevel: "silent" }); assert.fail("full Node runtime unexpectedly bundles for Pages/browser"); }
catch (e) { pagesErrors = e.errors?.map(error => error.text); assert.ok(pagesErrors?.some(error => error.includes("node:child_process"))); }
for (const entry of ["task_delivery_contract", "task_delivery_view", "coordinator"]) await build({ entryPoints: [join(consumer, `node_modules/@uchibeke/gallivant/lib/${entry}.mjs`)], platform: "browser", bundle: true, write: false, logLevel: "silent" });
execFileSync(process.execPath, ["--test", "flow.mjs"], { cwd: consumer, stdio: "inherit", env: { ...process.env, GALLIVANT_HOME: join(temp, "unconfigured"), NODE_PATH: "" } });
// Re-run provider/lifecycle conformance against ONLY emitted artifact modules.
// Internal-module tests use the retained compatibility export; public consumers
// above import only documented stable entrypoints.
const conformance = ["execution-backends.test.mjs", "execution-preparation.test.mjs", "openai-agents.test.mjs", "codex-cloud.test.mjs", "loop.test.mjs", "review.test.mjs", "recovery.test.mjs", "control.test.mjs", "task-delivery.test.mjs", "plugin-package.test.mjs", "runtime-delivery.test.mjs"];
for (const file of [...conformance, "codex-cloud-live-validation.mjs"]) {
  const source = readFileSync(join(root, "test", file), "utf8").replace(/new URL\("\.\.\/([^"\n]+)", import\.meta\.url\)/g, (_, path) => `new URL("./node_modules/@uchibeke/gallivant/${path}", import.meta.url)`).replace(/"\.\.\/lib\//g, '"@uchibeke/gallivant/lib/');
  writeFileSync(join(consumer, file), source);
}
const conformanceLog = join(temp, "conformance.log"), logFd = openSync(conformanceLog, "w");
console.log(`Installed provider/lifecycle conformance log: ${conformanceLog}`);
try {
  execFileSync(process.execPath, ["--test", ...conformance.map(file => join(consumer, file))], { cwd: join(consumer, "node_modules/@uchibeke/gallivant"), stdio: ["ignore", logFd, logFd], env: { ...process.env, GALLIVANT_HOME: join(temp, "unconfigured"), NODE_PATH: "" } });
} catch (error) {
  throw new Error(`Installed conformance failed; inspect ${conformanceLog}`, { cause: error });
} finally { closeSync(logFd); }
const evidence = { kind: "artifact-installed deterministic consumer; no installed-host/live claim", coreSha256: manifest.coreSha256, pluginSha256: manifest.hashes.plugin, runtime: process.version, consumer, pagesErrors, cases: ["public API task flow", "MCP SDK dispatch/resource", "two-account isolation", "restart/eviction", "runtime pin/backup/rollback", "installed provider/lifecycle conformance"], conformance };
writeFileSync(join(temp, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(`Artifact consumer passed. Evidence: ${join(temp, "evidence.json")}`);
