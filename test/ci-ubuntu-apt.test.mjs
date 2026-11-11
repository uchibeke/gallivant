import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { configureUbuntuApt, officialUbuntuSources } from "../.github/actions/ubuntu-apt/configure.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "ci-ubuntu-apt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, text) => { const path = join(root, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  write("etc/os-release", 'ID=ubuntu\nVERSION_CODENAME=noble\n');
  return { root, write, read: rel => readFileSync(join(root, rel), "utf8") };
}

test("deb822 archives change transport without changing suites, components or signing authority", t => {
  const f = fixture(t), rel = "etc/apt/sources.list.d/ubuntu.sources";
  const before = "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: mirror+file:/etc/apt/apt-mirrors-security.txt\nSuites: noble-security\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
  f.write(rel, before);
  f.write("etc/apt/sources.list.d/microsoft.sources", "URIs: https://packages.microsoft.com/ubuntu/24.04/prod\n");
  assert.deepEqual(configureUbuntuApt(f.root).changed, [rel]);
  assert.equal(f.read(rel), before.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://archive.ubuntu.com/ubuntu").replace("mirror+file:/etc/apt/apt-mirrors-security.txt", "https://security.ubuntu.com/ubuntu"));
  assert.equal(f.read("etc/apt/sources.list.d/microsoft.sources"), "URIs: https://packages.microsoft.com/ubuntu/24.04/prod\n");
  assert.deepEqual(configureUbuntuApt(f.root).changed, []);
  assert.deepEqual(readdirSync(join(f.root, "etc/apt/sources.list.d")).sort(), ["microsoft.sources", "ubuntu.sources"]);
});

test("legacy sources and mirror files use the official archive; retries are bounded and failed updates fail closed", t => {
  const f = fixture(t);
  f.write("etc/apt/sources.list", "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://azure.archive.ubuntu.com/ubuntu/ noble main\n");
  f.write("etc/apt/apt-mirrors.txt", "http://azure.archive.ubuntu.com/ubuntu/\nhttps://archive.ubuntu.com/ubuntu/\n");
  configureUbuntuApt(f.root);
  assert.equal(f.read("etc/apt/sources.list"), "deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu/ noble main\n");
  assert.equal(f.read("etc/apt/apt-mirrors.txt").includes("azure.archive"), false);
  const config = f.read("etc/apt/apt.conf.d/80-ci-network");
  assert.match(config, /Acquire::Retries "2"/); assert.match(config, /Timeout "15"/); assert.match(config, /Error-Mode "any"/);
  assert.doesNotMatch(config, /AllowUnauthenticated|AllowInsecure|trusted=yes/);
  assert.equal(officialUbuntuSources("deb https://example.com/ubuntu noble main\n"), "deb https://example.com/ubuntu noble main\n");
});

test("unsupported runners and redirected configuration are refused without changing the outside file", t => {
  const f = fixture(t); f.write("etc/os-release", "ID=debian\n");
  assert.throws(() => configureUbuntuApt(f.root), /requires an Ubuntu/);
  f.write("etc/os-release", 'ID="ubuntu"\n');
  const outside = join(f.root, "outside"); writeFileSync(outside, "deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n");
  mkdirSync(join(f.root, "etc/apt/sources.list.d"), { recursive: true });
  symlinkSync(outside, join(f.root, "etc/apt/sources.list.d/ubuntu.sources"));
  assert.throws(() => configureUbuntuApt(f.root), /regular file/);
  assert.equal(readFileSync(outside, "utf8"), "deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n");
});
