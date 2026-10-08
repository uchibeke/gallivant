import { PNG } from "pngjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { buildPluginPackage, validatePublicRelease } from "../lib/plugin_package.mjs";
import { tempHome } from "./helpers.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const sourceCommit = "a".repeat(40);
function fixture() {
  const home = tempHome(), ui = join(home, "ui.html"), image = join(home, "image.png");
  writeFileSync(ui, "<!doctype html><p>Unpaid package validation fixture.</p>");
  writeFileSync(image, PNG.sync.write({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) }));
  return { out: join(home, "out"), coreVersion: "0.2.0", sourceCommit,
    config: { publisher: "APort", supportEmail: "support@aport.io", endpoint: "https://aport.io/mcp",
      homepage: "https://aport.io", supportUrl: "https://aport.io/support", privacyUrl: "https://aport.io/privacy",
      termsUrl: "https://aport.io/terms", licenseUrl: "https://aport.io/license",
      resource: { uri: "ui://task-delivery/app", domain: "https://aport.io" }, assets: { ui, icon: image, screenshots: [image] } } };
}
function gitFixture(t, { fail, head = sourceCommit, status = "" } = {}) {
  const original = childProcess.execFileSync, calls = [];
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (file !== "git") return original(file, args, options);
    calls.push(args);
    const operation = args[0] === "status" ? "status" : args[1] === "HEAD" ? "head" : "root";
    if (operation === "status") assert.ok(args.includes("--no-renames"), "Git must report removed and added paths separately");
    if (operation === fail) throw Object.assign(new Error("Git fixture output buffer exhausted"), { code: "ENOBUFS" });
    return operation === "status" ? status : operation === "head" ? head + "\n" : root + "\n";
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

for (const fail of ["root", "head", "status"]) test(`public packaging fails closed when Git ${fail} inspection fails`, t => {
  const calls = gitFixture(t, { fail }), input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE", message: /Git source verification failed/ });
  assert.equal(existsSync(input.out), false, "source errors must not emit a candidate or partial output");
  if (fail === "status") assert.deepEqual(calls, [["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignored=matching"]]);
});
test("internal packaging never claims source verification after failed Git status", t => {
  gitFixture(t, { fail: "status" });
  const manifest = buildPluginPackage({ ...fixture(), internal: true });
  assert.equal(manifest.sourceVerified, false);
  assert.equal(manifest.classification, "internal-development-fixture; not-installed-host-evidence");
  assert.equal(manifest.submissionReady, false);
});
test("bundled preparation parser is included without admitting other dependency payloads", t => {
  gitFixture(t);
  const manifest = buildPluginPackage({ ...fixture(), internal: true });
  assert.ok(manifest.payloadHashes["node_modules/smol-toml/dist/index.js"]);
  assert.ok(manifest.payloadHashes["node_modules/smol-toml/package.json"]);
  const original = childProcess.execFileSync;
  let injected;
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    const result = original(file, args, options);
    if (file !== "npm" || args[0] !== "pack") return result;
    const packed = JSON.parse(result);
    packed[0].files.push({ path: injected });
    return JSON.stringify(packed);
  });
  syncBuiltinESMExports();
  for (const path of ["node_modules/unlisted/index.js", "node_modules/smol-toml/.env", "node_modules/smol-toml/dist/../secret.js", "node_modules/smol-toml/install.sh"]) {
    injected = path;
    const input = { ...fixture(), internal: true };
    assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_CONTENT" });
    assert.equal(existsSync(input.out), false);
  }
});
test("successful Git status still rejects modified public payload and removes partial output", t => {
  gitFixture(t, { status: " M lib/plugin_package.mjs\0" });
  const input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE", message: /Commit the package payload/ });
  assert.equal(existsSync(input.out), false);
});
for (const status of [" D lib/removed_runtime.mjs\0", "D  lib/renamed_runtime.mjs\0?? unrelated.mjs\0"]) test(`public packaging refuses removed runtime payload: ${status.includes("unrelated") ? "rename outside payload" : "deletion"}`, t => {
  gitFixture(t, { status });
  const input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE", message: /Commit the package payload/ });
  assert.equal(existsSync(input.out), false);
});
test("source commit mismatch remains an explicit refusal in public and internal builds", t => {
  gitFixture(t, { head: "b".repeat(40) });
  for (const internal of [false, true]) {
    const input = fixture();
    assert.throws(() => buildPluginPackage({ ...input, internal }), { code: "PACKAGE_SOURCE", message: /differs from HEAD/ });
    assert.equal(existsSync(input.out), false);
  }
});

for (const path of [".npmignore", ".gitignore", ".npmrc", "lib/.npmignore", "lib/nested/.gitignore", "bin/.npmignore", "templates/plugin/.npmignore", "docs/.npmignore"]) test(`public packaging refuses uncommitted npm control ${path}`, t => {
  gitFixture(t, { status: `?? ${path}\0` });
  const input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE", message: /packaging-control/ });
  assert.equal(existsSync(input.out), false);
});
for (const status of ["!! lib/.npmignore\0", "!! lib/ignored/\0", " D .npmignore\0"]) test(`public packaging refuses ignored or deleted controls: ${status.trim()}`, t => {
  gitFixture(t, { status }); const input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE" });
  assert.equal(existsSync(input.out), false);
});
test("internal packaging records npm controls without claiming public qualification", t => {
  gitFixture(t, { status: "?? lib/.npmignore\0!! node_modules/\0" });
  const manifest = buildPluginPackage({ ...fixture(), internal: true });
  assert.deepEqual(manifest.uncommittedPayload, ["lib/.npmignore"]);
  assert.equal(manifest.submissionReady, false);
});

for (const control of [".npmignore", ".gitignore"]) test(`npm pack applies nested ${control} to exported modules`, () => {
  const dir = tempHome(); mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pack-control-fixture", version: "1.0.0", files: ["lib"], exports: { ".": "./lib/task_delivery.mjs" } }));
  writeFileSync(join(dir, "lib/task_delivery.mjs"), "export const fixture = true;\n");
  writeFileSync(join(dir, "lib/retained.mjs"), "export const retained = true;\n");
  writeFileSync(join(dir, "lib", control), "task_delivery.mjs\n");
  const packed = JSON.parse(childProcess.execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: dir, encoding: "utf8" }))[0];
  assert.ok(packed.files.some(file => file.path === "lib/retained.mjs"));
  assert.ok(!packed.files.some(file => file.path === "lib/task_delivery.mjs"), "ignore controls can remove an exported module from a real tarball");
});


test("public URLs reject canonical loopbacks and aliases across every configured URL", t => {
  gitFixture(t);
  for (const host of ["a..com", "-bad.com", "bad-.com", "bad_label.com", "a".repeat(64) + ".com", Array(4).fill("a".repeat(63)).join("."), "intranet", "INTRANET.", "service", "internal", "service.internal", "SERVICE.FOO.INTERNAL.", "alt", "service.alt", "SERVICE.FOO.ALT.", "onion", "service.onion", "SERVICE.FOO.ONION.", "home.arpa", "service.home.arpa", "SERVICE.HOME.ARPA.", "local", "api.local", "API.FOO.LOCAL.", "example", "api.foo.example", "API.FOO.EXAMPLE.", "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "100.64.0.1", "198.18.0.1", "192.0.0.8", "192.88.99.2", "[2001:db8::1]", "[3fff::1]", "[ff02::1]", "[100::1]", "[2001:2::1]", "[2002::1]", "[::ffff:192.0.2.1]", "[64:ff9b::a00:1]", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "[fc00::1]", "[fdff::1]", "[fe80::1]", "[febf::1]", "[::ffff:10.0.0.1]", "[::ffff:192.168.1.1]", "[::ffff:169.254.169.254]", "0.0.0.0", "0", "0x0", "[::]", "[0:0:0:0:0:0:0:0]", "[::ffff:0.0.0.0]", "127.0.0.1", "127.9.8.7", "127.1", "2130706433", "0x7f000001", "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "localhost.localdomain", "LOCALHOST.", "child.localhost", "localhost.localdomain.", "localhost6.localdomain6", "ip6-localhost", "ip6-loopback", "example.com."]) {
    for (const field of ["endpoint", "homepage", "supportUrl", "privacyUrl", "termsUrl", "licenseUrl", "domain", "connectDomains", "resourceDomains"]) {
      const input = fixture(), url = `https://${host}`;
      if (field === "domain") input.config.resource.domain = url;
      else if (field.endsWith("Domains")) input.config.resource[field] = [url];
      else input.config[field] = url;
      assert.equal(validatePublicRelease(input.config).ok, false, `${field}: ${host}`);
      assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_RELEASE" });
      assert.equal(existsSync(input.out), false);
    }
  }
  const input = fixture();
  assert.equal(validatePublicRelease(input.config).ok, true);
  for (const host of ["api.aport.io", "API.APORT.IO.", "xn--bcher-kva.de", "a".repeat(63) + ".com", "8.8.8.8", "192.0.0.9", "[2606:4700:4700::1111]", "[2001:4860:4860::8888]", "[::ffff:8.8.8.8]", "[64:ff9b::808:808]"]) {
    input.config.endpoint = `https://${host}`;
    assert.equal(validatePublicRelease(input.config).ok, true, host);
  }
  input.config.endpoint = "https://localhost";
  assert.equal(buildPluginPackage({ ...input, internal: true }).submissionReady, false);
});

test("public asset preflight and builder share regular file, size and secret constraints", t => {
  gitFixture(t);
  for (const kind of ["missing", "directory", "symlink", "oversize", "secret"]) {
    for (const field of ["ui", "icon", "screenshots"]) {
      const input = fixture(), path = join(dirname(input.out), "bad-asset");
      if (kind === "directory") mkdirSync(path);
      if (kind === "symlink") symlinkSync(input.config.assets.icon, path);
      if (kind === "oversize") writeFileSync(path, Buffer.alloc(5242881));
      if (kind === "secret") writeFileSync(path, "Bearer fixture_secret_token");
      input.config.assets[field] = field === "screenshots" ? [input.config.assets.icon, path] : path;
      const result = validatePublicRelease(input.config);
      assert.equal(result.ok, false, `${field}: ${kind}`);
      assert.ok(result.errors.some(error => error.includes(`assets.${field}`)));
      assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_RELEASE" });
      assert.equal(existsSync(input.out), false);
      assert.throws(() => buildPluginPackage({ ...input, internal: true }), { code: "PACKAGE_ASSET" });
      assert.equal(existsSync(input.out), false);
    }
  }
  for (const invalid of ["image.png", {}, Array(9).fill("image.png"), [null], Array(1)]) {
    const input = fixture(); input.config.assets.screenshots = invalid;
    assert.equal(validatePublicRelease(input.config).ok, false);
  }
  const input = fixture(), config = join(dirname(input.out), "config.json");
  input.config.assets.screenshots = [join(dirname(input.out), "missing.png")];
  writeFileSync(config, JSON.stringify(input.config));
  const result = childProcess.spawnSync(process.execPath, [join(root, "bin/package-plugin.mjs"), "--config", config, "--validate-public"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).ok, false);
});


test("image assets must decode as bounded PNG in both preflight and emission", t => {
  gitFixture(t);
  const valid = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([0, 0, 0, 255]) });
  const corrupt = Buffer.from(valid); corrupt[corrupt.length - 1] ^= 1;
  const huge = Buffer.from(valid); huge.writeUInt32BE(0xffffffff, 16);
  for (const bytes of [Buffer.from("plain text"), Buffer.from([255,216,255,224]), valid.subarray(0, 40), corrupt, huge]) {
    for (const field of ["icon", "screenshots"]) {
      const input = fixture(), path = join(dirname(input.out), "invalid.png"); writeFileSync(path, bytes);
      input.config.assets[field] = field === "icon" ? path : [path];
      assert.equal(validatePublicRelease(input.config).ok, false);
      assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_RELEASE" });
      assert.throws(() => buildPluginPackage({ ...input, internal: true }), { code: "PACKAGE_ASSET" });
      assert.equal(existsSync(join(input.out, "manifest.json")), false);
    }
  }
});


test("package outputs cannot enter the source root through fresh paths or symlink aliases", t => {
  gitFixture(t);
  const home = tempHome(), alias = join(home, "source"); symlinkSync(root, alias);
  for (const out of [root, join(root, "templates", "release-fixture"), join(root, "fresh-output-parent", "release"), alias, join(alias, "templates", "release-fixture")]) {
    for (const internal of [false, true]) {
      assert.throws(() => buildPluginPackage({ ...fixture(), out, internal }), { code: "PACKAGE_OUTPUT", message: /outside the source package root/ });
      if (![root, alias].includes(out)) assert.equal(existsSync(out), false);
    }
  }
});

for (const change of ["payload", "head", "status-failure"]) test(`public packaging rejects source changes during pack: ${change}`, t => {
  gitFixture(t);
  const original = childProcess.execFileSync;
  let packed = false;
  t.mock.method(childProcess, "execFileSync", (file, args, options) => {
    if (packed && file === "git") {
      if (change === "head" && args[0] === "rev-parse") return "b".repeat(40) + "\n";
      if (args[0] === "status") {
        if (change === "status-failure") throw new Error("post-pack status failed");
        if (change === "payload") return " M lib/tasks.mjs\0";
      }
    }
    const result = original(file, args, options);
    if (file === "npm" && args[0] === "pack") packed = true;
    return result;
  });
  syncBuiltinESMExports();
  const input = fixture();
  assert.throws(() => buildPluginPackage(input), { code: "PACKAGE_SOURCE" });
  assert.equal(packed, true);
  assert.equal(existsSync(input.out), false, "remove tarball and staged plugin on failed revalidation");
});
