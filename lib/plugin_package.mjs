import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, readdirSync, utimesSync, chmodSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import Ajv2020 from "ajv/dist/2020.js";
import { CORE_VERSION, TASK_OPERATIONS, DELIVERY_VERSION, uiResourceConfiguration, deliveryError } from "./task_delivery_contract.mjs";
import { NODE_RUNTIME_REQUIREMENTS } from "./runtime_node.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => JSON.stringify(value, null, 2) + "\n";
// Main bundles its locked TOML parser for isolated Codex preparation. Keep the
// dependency exception narrow; do not admit arbitrary node_modules contents.
const bundledRuntimeFile = path => /^node_modules\/smol-toml\/(?:package\.json|README\.md|LICENSE|dist\/[A-Za-z0-9_-]+\.(?:js|cjs|d\.ts))$/.test(path);
const runtimeFile = path => /^(?:bin\/.*\.mjs|lib\/.*\.mjs|templates\/[^.].*|docs\/[^/]+\.md|README\.md|LICENSE|package\.json|npm-shrinkwrap\.json)$/.test(path) || bundledRuntimeFile(path);
// npm applies nested ignore files independently of Git's tracked payload.
const packagingControl = path => /^(?:(?:bin|lib|templates)\/.*|docs\/)?\.(?:npmignore|gitignore|npmrc)$/.test(path);
const payloadChange = path => runtimeFile(path) || packagingControl(path) || /^(?:bin|lib|templates)\/(?:.*\/)?$/.test(path);
const ajv = new Ajv2020({ strict: true });
const schemas = Object.fromEntries(["plugin", "mcp"].map(name => [name, JSON.parse(readFileSync(join(root, "templates/plugin/schemas", `${name}.schema.json`), "utf8"))]));
const check = Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, ajv.compile(schema)]));
// IANA special-purpose registries (2025-10-09). Fail closed for reserved,
// multicast and transition space without an unambiguous global destination.
// https://www.iana.org/assignments/iana-ipv4-special-registry
// https://www.iana.org/assignments/iana-ipv6-special-registry
const globalIpv4 = host => {
  const [a, b, c, d] = host.split(".").map(Number);
  if (a === 192 && b === 0 && c === 0 && [9, 10].includes(d)) return true;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
    a === 172 && b >= 16 && b <= 31 ||
    a === 192 && (b === 168 || b === 0 && [0, 2].includes(c) || b === 88 && c === 99) ||
    a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) ||
    a === 203 && b === 0 && c === 113);
};
const globalIpv6 = host => {
  const [left, right] = host.slice(1, -1).split("::");
  const head = left ? left.split(":") : [], tail = right ? right.split(":") : [];
  const words = (right === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]).map(x => parseInt(x, 16));
  const [a, b, c] = words;
  // Apply the IPv4 classification to mapped and well-known NAT64 addresses.
  if (words.slice(0, 5).every(x => x === 0) && words[5] === 0xffff || a === 0x64 && b === 0xff9b && words.slice(2, 6).every(x => x === 0)) {
    return globalIpv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  }
  if (a < 0x2000 || a > 0x3fff || a === 0x2002 || a === 0x2001 && b === 0xdb8 || a === 0x3fff && b < 0x1000) return false;
  if (a === 0x2001 && b < 0x200) {
    return b === 1 && words.slice(2, 7).every(x => x === 0) && [1, 2, 3].includes(words[7]) ||
      b === 3 || b === 4 && c === 0x112 || b >= 0x20 && b <= 0x3f;
  }
  return true;
};
const publicLocalHost = hostname => {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  // WHATWG URL parsing canonicalizes shorthand, decimal and hex IPv4, and IPv6.
  if (host.startsWith("[")) return !globalIpv6(host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !globalIpv4(host);
  return /(?:^|\.)(?:localhost|localhost\.localdomain|localhost6|localhost6\.localdomain6|ip6-localhost|ip6-loopback|localdomain|local|example|example\.(?:com|org|net)|invalid|test)$/.test(host);
};
function readAsset(name, path, limit, png = false) {
  let stat;
  try { stat = typeof path === "string" && path ? lstatSync(path) : null; } catch { /* report a bounded configuration error */ }
  if (!stat?.isFile() || stat.isSymbolicLink()) throw deliveryError("PACKAGE_ASSET", `${name} must be a regular non-symlink file`);
  const bytes = readFileSync(path);
  if (bytes.length > limit || /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]+/.test(bytes.toString("utf8"))) throw deliveryError("PACKAGE_ASSET", `${name} exceeds its limit or contains credentials; remove secrets before packaging`);
  if (png) {
    try {
      if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG header");
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
      if (!width || !height || width * height > 16777216) throw new Error("PNG dimensions");
      PNG.sync.read(bytes, { checkCRC: true });
    } catch { throw deliveryError("PACKAGE_ASSET", `${name} must decode as a valid PNG of at most 16777216 pixels; export the image as PNG`); }
  }
  return bytes;
}
function screenshots(config) {
  const paths = config.assets?.screenshots ?? [];
  if (!Array.isArray(paths) || paths.length > 8) throw deliveryError("PACKAGE_ASSET", "assets.screenshots must be an array of at most eight authentic screenshot files");
  return Array.from(paths);
}
const httpsUrl = (value, name, publicMode) => {
  let u; try { u = new URL(value); } catch { throw deliveryError("PACKAGE_CONFIG", `Configure ${name} as an HTTPS URL`); }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || publicMode && publicLocalHost(u.hostname)) throw deliveryError("PACKAGE_CONFIG", `${name} must be a real HTTPS URL without credentials, query or fragment`);
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
  for (const [name, limit] of [["ui", 262144], ["icon", 1048576]]) {
    try { readAsset(`assets.${name}`, config.assets?.[name], limit, name === "icon"); }
    catch (error) { errors.push(error.message); }
  }
  try {
    const paths = screenshots(config);
    if (!paths.length) errors.push("Provide authentic host screenshots at assets.screenshots");
    paths.forEach((path, i) => {
      try { readAsset(`assets.screenshots[${i}]`, path, 5242880, true); }
      catch (error) { errors.push(error.message); }
    });
  } catch (error) { errors.push(error.message); }
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
      // Separate additions/deletions keep both sides of a rename observable.
      sourceChanges = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignored=matching"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean).map(record => record.slice(3));
      sourceVerified = true;
    }
  } catch (error) {
    if (error.code === "PACKAGE_SOURCE") throw error;
    if (!internal) throw deliveryError("PACKAGE_SOURCE", "Git source verification failed; make HEAD and git status succeed in the exact selected checkout before public packaging");
  }
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
    // Preflight and emission share file, size and secret constraints.
    emit(name, readAsset(name, path, limit, name.endsWith(".png")));
  };
  asset("assets/task-ui.html", config.assets.ui, 262144);
  if (config.assets.icon) asset("assets/icon.png", config.assets.icon, 1048576);
  for (const [i, path] of screenshots(config).entries()) { asset(`assets/screenshot-${i + 1}.png`, path, 5242880); }
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
    if (!runtimeFile(file.path) || /(?:^|\/)(?:\.env|auth\.json|credentials|config\.json)$/.test(file.path)) throw deliveryError("PACKAGE_CONTENT", `Unexpected runtime file ${file.path}; fix the package allowlist`);
  }
  // Removed payload files are absent from npm's current file list but still
  // invalidate the claimed source commit. Use the same runtime payload policy.
  const payloadChanges = sourceChanges.filter(payloadChange);
  if (!internal && payloadChanges.length) throw deliveryError("PACKAGE_SOURCE", "Commit the package payload before public packaging; executable, recipe, asset or npm packaging-control changes invalidate candidate evidence");
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
