import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHostRegistry } from "../lib/hosts.mjs";
import { validateHostRecord, MAX_DIFF_BYTES } from "../lib/host_contract.mjs";
import { fixture, REPO } from "./bitbucket-fixture.mjs";
import { prFixture } from "./helpers.mjs";

const fixtures = {
  github: () => {
    const state = { pr: prFixture(), diff: "diff --git a/a b/a\n+change\n", fail: false };
    const registry = makeHostRegistry({ credential: async () => ({ host: "github.com", token: "fixture-token" }), exec: async (_cmd, args) => {
      if (state.fail) throw new Error("transport unavailable");
      return { stdout: args[1] === "diff" ? state.diff : JSON.stringify(state.pr) };
    } });
    return { api: registry.api, repo: "acme/widget", host: "github.com", number: 142,
      missing: () => { state.pr.headRefOid = null; }, oversized: () => { state.diff = "x".repeat(MAX_DIFF_BYTES); }, unavailable: () => { state.fail = true; } };
  },
  bitbucket: () => {
    let oversized = false, unavailable = false;
    const f = fixture({ intercept: c => {
      if (unavailable) throw new Error("transport unavailable");
      if (oversized && c.path.endsWith("/diff")) return new Response("x".repeat(MAX_DIFF_BYTES));
    } });
    return { api: f.registry.api, repo: REPO, host: "bitbucket.org", number: 7,
      missing: () => { f.data.repository.uuid = null; }, oversized: () => { oversized = true; }, unavailable: () => { unavailable = true; } };
  },
};

// The same assertions run against both real adapter implementations with injected wire transports.
for (const [name, create] of Object.entries(fixtures)) {
  test(`${name} bounded host contract: normalized PR, exact URL, complete diff and explicit failures`, async () => {
    const f = create(), pr = await f.api.prView(f.repo, f.number);
    validateHostRecord(pr, f.host, { pr: true, full: true });
    assert.equal(new URL(pr.url).hostname, f.host); assert.equal(pr.number, f.number);
    assert.match(await f.api.prDiff(f.repo, f.number), /diff --git/);
    f.missing(); await assert.rejects(f.api.prView(f.repo, f.number));
    const large = create(); large.oversized(); await assert.rejects(large.api.prDiff(large.repo, large.number));
    const failed = create(); failed.unavailable(); await assert.rejects(failed.api.prView(failed.repo, failed.number));
  });
}
