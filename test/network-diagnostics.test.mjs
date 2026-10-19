import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { diagnoseNetwork, diagnosticOrigin, renderNetworkDiagnostics, systemDns } from "../lib/network_diagnostics.mjs";

test("diagnostics reject credentials, paths, queries and non-HTTPS before doing I/O", async () => {
  for (const input of ["not a url", "http://example.com", "https://user:secret@example.com", "https://example.com/?token=secret", "https://example.com/private", "https://example.com/#secret"]) {
    await assert.rejects(() => diagnoseNetwork(input, { dns: () => assert.fail("must not resolve"), https: () => assert.fail("must not connect") }));
  }
  assert.equal(diagnosticOrigin("https://example.com:8443").origin, "https://example.com:8443");
});

test("intermittent DNS failure remains visible even after later successful responses", async () => {
  let i = 0;
  const result = await diagnoseNetwork("https://example.com", {
    dns: async () => ++i === 1 ? { ok: false, code: "EAI_AGAIN" } : { ok: true },
    https: async url => { assert.equal(url.origin, "https://example.com"); return { ok: true, status: 401 }; }, env: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.samples.length, 3);
  assert.match(renderNetworkDiagnostics(result), /EAI_AGAIN/);
  assert.match(renderNetworkDiagnostics(result), /reachable \(HTTP 401\)/);
});

test("diagnostics distinguish reachability from authorization and never expose proxy credentials", async () => {
  const result = await diagnoseNetwork("https://example.com", { dns: async () => ({ ok: true }), https: async () => ({ ok: true, status: 404 }), env: { HTTPS_PROXY: "https://user:secret@proxy.invalid" } });
  assert.equal(result.ok, true);
  assert.equal(result.proxyEnvironmentPresent, true);
  assert.doesNotMatch(JSON.stringify(result), /secret|proxy\.invalid/);
  assert.match(renderNetworkDiagnostics(result), /does not.*prove model access/);
});

test("system DNS uses the installed Node and resolves localhost without platform commands", async () => {
  const result = await systemDns("localhost");
  assert.equal(result.ok, true);
  assert.ok(result.families.length);
});

test("CLI network diagnosis validates without requiring config, auth or a running daemon", () => {
  try {
    execFileSync(process.execPath, ["bin/gallivant.mjs", "doctor", "--network", "http://example.com"], { env: { ...process.env, GALLIVANT_HOME: "/nonexistent-network-diagnostic-home" }, encoding: "utf8", stdio: "pipe" });
    assert.fail("must reject HTTP");
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(error.stderr, /HTTPS origin/);
    assert.doesNotMatch(error.stderr, /config\.json|gh auth/);
  }
});
