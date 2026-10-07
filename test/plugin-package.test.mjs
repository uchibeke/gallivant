import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { buildPluginPackage } from "../lib/plugin_package.mjs";
import { tempHome } from "./helpers.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const sourceCommit = "a".repeat(40);
function fixture() {
  const home = tempHome(), ui = join(home, "ui.html"), image = join(home, "image.png");
  writeFileSync(ui, "<!doctype html><p>Unpaid package validation fixture.</p>");
  writeFileSync(image, "unpaid image fixture");
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
  if (fail === "status") assert.deepEqual(calls, [["rev-parse", "--show-toplevel"], ["rev-parse", "HEAD"], ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"]]);
});
test("internal packaging never claims source verification after failed Git status", t => {
  gitFixture(t, { fail: "status" });
  const manifest = buildPluginPackage({ ...fixture(), internal: true });
  assert.equal(manifest.sourceVerified, false);
  assert.equal(manifest.classification, "internal-development-fixture; not-installed-host-evidence");
  assert.equal(manifest.submissionReady, false);
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
