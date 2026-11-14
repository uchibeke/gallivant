import { test } from "node:test";
import assert from "node:assert/strict";
import { makePackageAuthPreflight, packageAuthEnvironment, packageAuthProblems } from "../lib/package_auth.mjs";
import { runEnv, runSessionEnv } from "../lib/git.mjs";
import { validate, repoEntries, rememberRepo, configPath } from "../lib/config.mjs";
import { writeJsonAtomic, readJson } from "../lib/fs.mjs";
import { CONFIG, tempHome } from "./helpers.mjs";

const policy = { provider: "github-packages", packages: ["@acme/editor", "@acme/core"] };
const config = { ...CONFIG, repos: [{ repo: "acme/widget", package_auth: policy }, "acme/other"] };
const credential = { host: "github.com", repository: "acme/widget", token: "package-test-secret" };
const input = { config, repo: "acme/widget", credential, transport: "cli", limits: { deadlineMs: 1000 } };
const response = status => ({ status, body: { cancel: async () => {} }, json: () => assert.fail("registry bodies are not read") });

test("only selected coding repositories receive the existing package credential", () => {
  const env = runSessionEnv({ NODE_AUTH_TOKEN: "wrong-settings-token", NPM_TOKEN: "ambient" }, config, credential);
  assert.equal(env.NODE_AUTH_TOKEN, credential.token);
  assert.equal(env.GITHUB_PACKAGES_TOKEN, credential.token);
  assert.equal(env.NPM_TOKEN, "");
  for (const other of [null, { ...credential, repository: "acme/other" }, { ...credential, host: "bitbucket.org" }]) {
    const isolated = runSessionEnv({ NODE_AUTH_TOKEN: "ambient", GITHUB_PACKAGES_TOKEN: "ambient", NPM_TOKEN: "ambient" }, config, other);
    for (const key of ["NODE_AUTH_TOKEN", "GITHUB_PACKAGES_TOKEN", "NPM_TOKEN"]) assert.equal(isolated[key], "");
  }
  for (const key of ["NODE_AUTH_TOKEN", "GITHUB_PACKAGES_TOKEN", "NPM_TOKEN"]) assert.equal(runEnv(config, credential)[key], undefined, "Git helpers are not coding sessions");
  assert.equal(packageAuthEnvironment({ repos: [] }, credential).NODE_AUTH_TOKEN, "");
});

test("package grants validate and survive repository normalization and base updates", () => {
  assert.deepEqual(validate(config), []);
  const normalized = { ...config, repos: repoEntries(config) };
  assert.deepEqual(normalized.repos[0].package_auth, policy);
  assert.equal(packageAuthEnvironment(normalized, credential).NODE_AUTH_TOKEN, credential.token);
  const home = tempHome(); writeJsonAtomic(configPath(home), config); rememberRepo("acme/widget", home, "development");
  assert.deepEqual(readJson(configPath(home)).repos[0].package_auth, policy);
  for (const value of [true, "github-packages", {}, { ...policy, token: "forbidden" }, { ...policy, packages: [] },
    { ...policy, packages: ["@acme/editor?token=other"] }, { ...policy, packages: ["@acme/editor", "@acme/editor"] },
    { ...policy, provider: "https://evil.invalid" }]) assert.ok(packageAuthProblems(value, "acme/widget").length);
  assert.ok(packageAuthProblems(policy, "bitbucket.org/acme/widget").length);
});

test("preflight pins registry/credentials, discards bodies, and bounds successful cache reuse", async () => {
  let now = 100, calls = 0, cancelled = 0;
  const preflight = makePackageAuthPreflight({ clock: { now: () => now }, ttlMs: 1000, fetch: async (url, options) => {
    calls++;
    assert.match(url, /^https:\/\/npm\.pkg\.github\.com\/%40acme%2F(?:editor|core)$/);
    assert.equal(options.headers.Authorization, `Bearer ${credential.token}`);
    assert.equal(options.redirect, "error"); assert.ok(options.signal);
    return { ...response(200), body: { cancel: async () => { cancelled++; } } };
  } });
  await preflight(input); await preflight(input); assert.equal(calls, 2); assert.equal(cancelled, 2);
  now += 1001; await preflight(input); assert.equal(calls, 4);
  await preflight({ ...input, credential: { ...credential, repository: "acme/other" }, repo: "acme/other" });
  assert.equal(calls, 4, "no configured grant means no probe");
});

test("parallel checks deduplicate but credential, package and repo changes cannot reuse clearance", async () => {
  let calls = 0;
  const preflight = makePackageAuthPreflight({ fetch: async () => { calls++; await new Promise(r => setTimeout(r, 5)); return response(200); } });
  await Promise.all([preflight(input), preflight(input), preflight(input)]); assert.equal(calls, 2);
  await preflight({ ...input, credential: { ...credential, token: "replacement-secret" } }); assert.equal(calls, 4);
  await preflight({ ...input, config: { repos: [{ repo: input.repo, package_auth: { ...policy, packages: ["@acme/extra"] } }] } }); assert.equal(calls, 5);
  await preflight({ ...input, repo: "acme/other", credential: { ...credential, repository: "acme/other" }, config: { repos: [{ repo: "acme/other", package_auth: policy }] } }); assert.equal(calls, 7);
});

test("failed, redirected and timed-out probes cannot grant access or disclose secrets", async () => {
  for (const status of [401, 403, 404, 429, 302, 500]) {
    let calls = 0;
    const preflight = makePackageAuthPreflight({ fetch: async () => { calls++; return response(status); } });
    for (let retry = 0; retry < 2; retry++) await assert.rejects(preflight(input), error => {
      assert.equal(error.code, "PACKAGE_AUTH"); assert.doesNotMatch(error.message, /package-test-secret/); return true;
    });
    assert.equal(calls, 2, "failed authentication is not cached as clearance");
  }
  const redirected = makePackageAuthPreflight({ fetch: async () => { throw new Error("Bearer package-test-secret"); } });
  await assert.rejects(redirected(input), error => !error.message.includes("package-test-secret"));
  const stalled = makePackageAuthPreflight({ fetch: () => new Promise(() => {}) });
  await assert.rejects(stalled({ ...input, limits: { deadlineMs: 10 } }), { code: "PACKAGE_AUTH" });
});

test("wrong repository/account and hosted routes fail before any registry request", async () => {
  const preflight = makePackageAuthPreflight({ fetch: () => assert.fail("must refuse before I/O") });
  for (const selected of [null, { ...credential, token: null }, { ...credential, repository: "acme/other" }, { ...credential, host: "bitbucket.org" }]) {
    await assert.rejects(preflight({ ...input, credential: selected }), { code: "PACKAGE_AUTH" });
  }
  await assert.rejects(preflight({ ...input, transport: "remote" }), { code: "PACKAGE_AUTH" });
});
