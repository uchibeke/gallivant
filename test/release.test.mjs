import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publishRelease } from "../scripts/publish-release.mjs";

test("release recovery skips identical bytes but refuses changed artifacts and registry failures", async () => {
  const bytes = Buffer.from("release tarball"), integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const deps = { read: () => bytes, run: () => assert.fail("must not publish"), request: async () => Response.json({ dist: { integrity } }) };
  assert.match(await publishRelease("0.2.0", deps), /Already published/);
  await assert.rejects(publishRelease("0.2.0", { ...deps, request: async () => Response.json({ dist: { integrity: "different" } }) }), /different bytes/);
  for (const status of [401, 403, 429, 500]) await assert.rejects(publishRelease("0.2.0", { ...deps, request: async () => new Response("unavailable", { status }) }), /publication refused/);
  await assert.rejects(publishRelease("0.2.0", { ...deps, request: async () => { throw new Error("offline"); } }), /offline/);
  await assert.rejects(publishRelease("../other", deps), /Invalid release version/);
});

test("only a confirmed absent version publishes the exact tarball with provenance", async () => {
  const calls = [];
  assert.equal(await publishRelease("0.2.0", { read: () => Buffer.from("artifact"), request: async () => new Response("missing", { status: 404 }), run: (...args) => calls.push(args) }), "Published");
  assert.deepEqual(calls[0].slice(0, 2), ["npm", ["publish", "dist/gallivant-0.2.0.tgz", "--ignore-scripts", "--access", "public", "--provenance"]]);
  await assert.rejects(publishRelease("0.2.0", { read: () => Buffer.from("artifact"), request: async () => new Response("missing", { status: 404 }), run: () => { throw new Error("publish denied"); } }), /publish denied/);
});
