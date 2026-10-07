import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, readdirSync, utimesSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { CORE_VERSION, TASK_OPERATIONS, DELIVERY_VERSION, uiResourceConfiguration, deliveryError } from "./task_delivery_contract.mjs";
import { NODE_RUNTIME_REQUIREMENTS } from "./runtime_node.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
const ajv = new Ajv2020({ strict: true });
const schemas = Object.fromEntries(["plugin", "mcp"].map(name => [name, JSON.parse(readFileSync(join(root, "templates/plugin/schemas", `${name}.schema.json`), "utf8"))]));
const check = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
const httpsUrl = (value, name, publicMode) => {
  let u; try { u = new URL(value); } catch { throw deliveryError("PACKAGE_CONFIG", `Configure ${name} as an HTTPS URL`); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || publicMode && /(?:^|\.)(?:localhost|example\.(?:com|org|net)|invalid|test)$/.test(u.hostname)) throw deliveryError("PACKAGE_CONFIG", `${name} must be a real HTTPS URL without credentials, query or fragment`);
  return value;
};

export function validatePublicRelease(config) {
  const errors = [];
  if (config.publisher !== "APort") errors.push("Set publisher to APort");
  if (!config.supportEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.supportEmail)) errors.push("Configure the publisher's supportEmail");
  for (const name of ["endpoint", "homepage", "supportUrl", "privacyUrl", "termsUrl", "licenseUrl"]) {
    try { httpsUrl(config[name], name, true); } catch (e) { errors.push(e.message); }
  }
  try {
    uiResourceConfiguration(config.resource || {});
    for (const [i, value] of [config.resource.domain, ...(config.resource.connectDomains || []), ...(config.resource.resourceDomains || [])].entries()) httpsUrl(value, `resource origin ${i}`, true);
  } catch (e) { errors.push(e.message); }
  if (config.fixture) errors.push("Fixture assets cannot qualify a public release; provide the built APort UI and authentic assets");
  for (const name of ["ui", "icon"]) {
    try { if (!config.assets?.[name] || !lstatSync(config.assets[name]).isFile()) throw new Error(); }
    catch { errors.push(`Provide the actual built ${name} asset at assets.${name}`); }
  }
  if (!config.assets?.screenshots?.length) errors.push("Provide authentic host screenshots at assets.screenshots");
  return { ok: !errors.length, errors, submissionReady: false, qualification: "M6 live/deployment/host/publisher gates remain mandatory" };
}

export function buildPluginPackage({ config, out, coreVersion, sourceCommit, internal = false }) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (coreVersion !== pkg.version || coreVersion !== CORE_VERSION) throw deliveryError("PACKAGE_VERSION", "Pass the exact installed core version; build runtime and plugin from that same package");
  if (!/^[a-f0-9]{40}$/.test(sourceCommit || "")) throw deliveryError("PACKAGE_SOURCE", "Supply the exact 40-character source commit");
  let sourceVerified = false, sourceChanges = [];
  try {
    const actualRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (realpathSync(actualRoot) === realpathSync(root)) {
      const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      if (actualCommit !== sourceCommit) throw deliveryError("PACKAGE_SOURCE", "Source commit differs from HEAD; build from the exact selected checkout");
      sourceVerified = true;
      sourceChanges = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(record => record.slice(3));
    }
  } catch (error) { if (error.code === "PACKAGE_SOURCE") throw error; }
  if (!internal && !sourceVerified) throw deliveryError("PACKAGE_SOURCE", "Build the public candidate from the exact merged source checkout; an installed tarball cannot attest its supplied commit");
  if (!internal) {
    const verdict = validatePublicRelease(config);
    if (!verdict.ok) throw deliveryError("PACKAGE_RELEASE", verdict.errors.join("\n"));
  }
  const endpoint = httpsUrl(config.endpoint, "endpoint", !internal), resource = uiResourceConfiguration(config.resource);
  if (config.publisher !== "APort") throw deliveryError("PACKAGE_CONFIG", "APort is the publisher");
  if (!config.assets?.ui) throw deliveryError("PACKAGE_ASSET", "Provide built APort UI HTML; --internal may use an explicitly labeled fixture");
  out = resolve(out);
  mkdirSync(out, { recursive: true });
  if (readdirSync(out).length) throw deliveryError("PACKAGE_OUTPUT", "Use one empty bounded output directory; preserve older artifacts for rollback");
  const stage = join(out, "plugin"); mkdirSync(stage);
  try {
  const hashes = {};
  const emit = (path, bytes) => {
    const file = join(stage, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes, { mode: 0o644 });
    hashes[path] = sha(bytes); utimesSync(file, 946684800, 946684800);
  };
  const asset = (name, path, limit) => {
    // Only explicit regular files; never traverse asset directories or include
    // credential files by accident. Resolving a symlink is not authorization.
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw deliveryError("PACKAGE_ASSET", `${name} must be a regular non-symlink file`);
    const bytes = readFileSync(path);
    if (bytes.length > limit || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]+/.test(bytes.toString("utf8"))) throw deliveryError("PACKAGE_ASSET", `${name} exceeds its limit or contains credentials; remove secrets before packaging`);
    emit(name, bytes);
  };
  asset("assets/task-ui.html", config.assets.ui, 262144);
  if (config.assets.icon) asset("assets/icon.png", config.assets.icon, 1048576);
  for (const [i, path] of (config.assets.screenshots || []).entries()) { if (i >= 8) throw deliveryError("PACKAGE_ASSET", "At most eight authentic screenshots"); asset(`assets/screenshot-${i + 1}.png`, path, 5242880); }
  const plugin = { $schema: schemas.plugin.$id, name: "aport-task-delivery", version: coreVersion,
    description: "Prepare scoped tasks, follow implementation and review the resulting pull request.", author: { name: "APort", ...(config.supportEmail ? { email: config.supportEmail } : {}), ...(config.homepage ? { url: httpsUrl(config.homepage, "homepage", !internal) } : {}) },
    ...(config.homepage ? { homepage: config.homepage } : {}), license: "Apache-2.0", keywords: ["tasks", "pull-request", "aport"],
    extensions: { "com.openai": { interface: { displayName: "APort Task Delivery", developerName: "APort", shortDescription: "Describe work and review a PR", longDescription: "Prepare scoped requirements, choose a configured harness, follow saved progress and review a pull request. Repository access and paid execution allowance require an authorized account.", category: "Productivity", capabilities: ["Read", "Write"],
      ...(config.homepage ? { websiteURL: config.homepage } : {}), ...(config.privacyUrl ? { privacyPolicyURL: config.privacyUrl } : {}), ...(config.termsUrl ? { termsOfServiceURL: config.termsUrl } : {}),
      ...(config.supportUrl ? { supportURL: config.supportUrl } : {}), ...(config.assets.icon ? { logo: "./assets/icon.png", composerIcon: "./assets/icon.png" } : {}),
      ...(config.assets.screenshots?.length ? { screenshots: config.assets.screenshots.map((_, i) => `./assets/screenshot-${i + 1}.png`) } : {}), defaultPrompt: ["Prepare a task in my connected repository."] } } } };
  const mcp = { $schema: schemas.mcp.$id, mcpServers: { "task-delivery": { type: "streamable-http", url: endpoint } } };
  if (!check.plugin(plugin) || !check.mcp(mcp)) throw deliveryError("PACKAGE_SCHEMA", json(check.plugin.errors || check.mcp.errors));
  emit("plugin.json", json(plugin)); emit("mcp.json", json(mcp)); emit("LICENSE", readFileSync(join(root, "LICENSE")));
  emit("skills/task-delivery/SKILL.md", readFileSync(join(root, "templates/plugin/task-delivery.SKILL.md")));
  const contracts = { coreVersion, operationVersion: DELIVERY_VERSION, taskVersion: 1, executionVersion: 1 };
  const lock = readFileSync(join(root, "npm-shrinkwrap.json"));
  // npm's allowlist is the runtime payload; tests install this emitted tarball.
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8", maxBuffer: 1048576 }))[0];
  for (const file of packed.files) {
    if (!/^(?:bin\/.*\.mjs|lib\/.*\.mjs|templates\/[^.].*|docs\/[^/]+\.md|README\.md|LICENSE|package\.json|npm-shrinkwrap\.json)$/.test(file.path) || /(?:^|\/)(?:\.env|auth\.json|credentials|config\.json)$/.test(file.path)) throw deliveryError("PACKAGE_CONTENT", `Unexpected runtime file ${file.path}; fix the package allowlist`);
  }
  const payloadChanges = sourceChanges.filter(path => packed.files.some(file => file.path === path));
  if (!internal && payloadChanges.length) throw deliveryError("PACKAGE_SOURCE", "Commit the package payload before public packaging; executable, recipe or asset changes invalidate candidate evidence");
  const archive = join(out, "aport-task-delivery.zip");
  execFileSync("zip", ["-X", "-q", archive, ...Object.keys(hashes).sort()], { cwd: stage });
  const runtime = { ...contracts, sourceCommit, sourceVerified, uncommittedPayload: payloadChanges, requirements: NODE_RUNTIME_REQUIREMENTS, exports: pkg.exports, endpoint, resource,
    coreArtifact: packed.filename, coreSha256: sha(readFileSync(join(out, packed.filename))), dependencyLockSha256: sha(lock), assetHashes: hashes };
  writeFileSync(join(out, "runtime.json"), json(runtime));
  writeFileSync(join(out, "operations.json"), json(TASK_OPERATIONS));
  writeFileSync(join(out, "RUNTIME.md"), readFileSync(join(root, "docs/task-delivery.md")));
  const manifest = { format: 1, publisher: "APort", classification: internal ? "internal-development-fixture; not-installed-host-evidence" : "public-candidate-unqualified",
    submissionReady: false, ...runtime, hashes: { plugin: sha(readFileSync(archive)), runtime: sha(readFileSync(join(out, "runtime.json"))), operations: sha(readFileSync(join(out, "operations.json"))) },
    payloadHashes: Object.fromEntries(packed.files.map(f => [f.path, sha(readFileSync(join(root, f.path)))])), schemaHashes: Object.fromEntries(Object.keys(schemas).map(n => [schemas[n].$id, sha(readFileSync(join(root, "templates/plugin/schemas", `${n}.schema.json`)))])) };
  writeFileSync(join(out, "manifest.json"), json(manifest));
  for (const name of readdirSync(out)) if (lstatSync(join(out, name)).isFile()) chmodSync(join(out, name), 0o644);
  return manifest;
  } catch (error) { rmSync(out, { recursive: true, force: true }); throw error; }
}
