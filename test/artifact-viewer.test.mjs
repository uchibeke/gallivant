import assert from "node:assert/strict";
import { linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { contentDigest } from "../lib/hash.mjs";
import { sourceManifestDigest } from "../lib/start_contract.mjs";
import { prdSnapshotPath, sourceSnapshotPath } from "../lib/task_snapshots.mjs";
import { artifactMarkdown } from "../lib/tracker/artifact_markdown.mjs";
import { artifactKey, artifactRef, chainFilesRef, planFilesRef, taskBriefRef } from "../lib/tracker/artifact_links.mjs";
import { taskStore } from "../lib/task_store.mjs";
import { TASK_VERSION } from "../lib/task_contract.mjs";
import { fixture, NOW, TASK } from "./ui/fixture.mjs";
import { ACTOR, encode, manifest, planFixture, task } from "./ui/dependency-plans-fixture.mjs";

function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function world(t) {
  const env = await fixture();
  t.after(() => env.close());
  return env;
}

async function artifact(env, query, { base = "", actor, headers } = {}) {
  const response = await fetch(`${env.origin}${base}/api/artifact?${new URLSearchParams(query)}`, {
    headers: { ...(actor ? { authorization: actor } : {}), ...headers },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  return { status: response.status, data: await response.json() };
}

test("task reads exact approved bytes and carried source snapshots after checkout edits or disappearance", async t => {
  const env = await world(t), { state, home } = env;
  const text = "\uFEFF---\r\nstatus: ready\r\n---\r\n\r\n# Approved\r\n\r\nTwo spaces  \r\n";
  const source = [".github/docs/data.yaml", "key: café\r\n"];
  const checkout = join(home, "checkout"), path = state.get(TASK).prd;
  put(join(checkout, path), "# Checkout replacement");
  put(join(checkout, source[0]), "key: checkout replacement");
  put(prdSnapshotPath(home, TASK), text);
  put(sourceSnapshotPath(home, TASK, source[0]), source[1]);
  state.update(TASK, { checkout, snapshot_digest: contentDigest(text), sources: [source[0]], sources_digest: sourceManifestDigest([source]) });
  const query = { id: TASK, artifact: taskBriefRef(TASK, state.get(TASK)) };
  const { data } = await artifact(env, query);
  assert.equal(data.text, text);
  assert.equal(data.digest, contentDigest(text));
  assert.equal(data.sourceDigest, sourceManifestDigest([source]));
  assert.deepEqual(data.files.map(file => [file.path, file.origin]), [[path, "Saved task snapshot"], [source[0], "Carried task snapshot"]]);
  rmSync(checkout, { recursive: true });
  const sourceQuery = { ...query, artifact: data.files[1].ref };
  assert.equal((await artifact(env, sourceQuery, { base: "/gallivant" })).data.text, source[1]);
  put(sourceSnapshotPath(home, TASK, source[0]), "changed source");
  assert.equal((await artifact(env, sourceQuery)).data.state, "changed");
  put(prdSnapshotPath(home, TASK), "# Changed stored copy");
  assert.equal((await artifact(env, query)).data.state, "changed");
  rmSync(prdSnapshotPath(home, TASK));
  const missing = (await artifact(env, query)).data;
  assert.equal(missing.state, "unavailable");
  assert.match(missing.recovery, /saved copy/);
  assert.equal(missing.files[1].path, source[0]);
  state.update(TASK, { snapshot_digest: null, prd_fingerprint: "a".repeat(12) });
  const old = (await artifact(env, { ...query, artifact: taskBriefRef(TASK, state.get(TASK)) })).data;
  assert.equal(old.legacy, true);
  assert.equal(old.revision, "a".repeat(12));
  assert.equal(old.text, undefined);
});

test("artifact routes reject replaced paths, scope mismatches and protected content before returning text", async t => {
  const env = await world(t), { state, home } = env;
  const snapshot = prdSnapshotPath(home, TASK);
  mkdirSync(dirname(snapshot));
  const target = join(home, "outside-copy");
  put(target, "Sensitive");
  const query = { id: TASK, artifact: taskBriefRef(TASK, state.get(TASK)) };
  for (const attach of [symlinkSync, linkSync]) {
    attach(target, snapshot);
    assert.equal((await artifact(env, query)).data.state, "unavailable");
    rmSync(snapshot);
  }
  put(snapshot, "Approved snapshot");
  const parent = dirname(snapshot), relocated = join(home, "relocated-prds");
  state.update(TASK, { snapshot_digest: contentDigest("Approved snapshot") });
  const pinnedQuery = { id: TASK, artifact: taskBriefRef(TASK, state.get(TASK)) };
  renameSync(parent, relocated);
  symlinkSync(relocated, parent);
  const moved = (await artifact(env, pinnedQuery)).data;
  assert.equal(moved.state, "unavailable");
  assert.equal(moved.text, undefined);
  rmSync(parent);
  renameSync(relocated, parent);
  assert.equal((await artifact(env, pinnedQuery)).data.text, "Approved snapshot");
  state.update(TASK, { snapshot_digest: null });
  for (const [bytes, expected] of [[Buffer.from([0, 0xff]), "binary"], ["", "empty"], [Buffer.alloc(1048577, 65), "oversized"],
    ["api_key=some-private-credential", "protected"], ["Workspace /Users/example/private/checkout", "protected"]]) {
    put(snapshot, bytes);
    const { data } = await artifact(env, query);
    assert.equal(data.state, expected);
    assert.equal(data.text, undefined);
    assert.ok(!JSON.stringify(data).includes(home));
  }
  put(snapshot, "Legacy revision");
  assert.equal((await artifact(env, { ...query, artifactAt: contentDigest("Other revision") })).data.state, "changed");
  assert.equal((await artifact(env, { ...query, path: target })).status, 400);
  assert.equal((await artifact(env, { ...query, id: "../../outside" })).status, 404);
  assert.equal((await artifact(env, query, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const [, key] = query.artifact.split(".");
  assert.equal((await artifact(env, { ...query, artifact: artifactRef("task", key, "../outside") })).status, 404);
  env.ctx.planOperatorForRequest = () => null;
  assert.equal((await artifact(env, query)).status, 404);
});

test("intake references read saved draft revisions and reject edited draft files", async t => {
  const env = await world(t), id = "task-" + "1".repeat(24), revision = 2, exact = "# Prepared\r\n";
  const draft = { revision, hash: contentDigest(exact) }, repo = "acme/atlas";
  const dir = join(env.home, "tasks", id, "drafts", "revision-2", "docs", "prds", id + ".md");
  put(dir, exact);
  taskStore(env.home).save({ id, version: TASK_VERSION, repo, draft });
  const reference = artifactRef("intake", artifactKey(id, draft.revision, draft.hash));
  const query = { task: id, artifact: reference };
  const saved = (await artifact(env, query)).data;
  assert.equal(saved.text, exact);
  assert.equal(saved.revision, "Draft revision 2");
  assert.equal(saved.file.origin, "Saved intake draft");
  put(dir, "An edited draft");
  assert.equal((await artifact(env, query)).data.state, "changed");
  env.ctx.config.repos = ["other/repo"];
  assert.equal((await artifact(env, query)).status, 404);
});

test("legacy chains pin checkout-only approvals to the recorded digest and retain change evidence", async t => {
  const env = await world(t), repo = "acme/atlas", checkout = join(env.home, "checkout");
  const path = "docs/prds/first.md", source = "docs/notes.txt", text = "---\nstatus: ready\nsources: " + source + "\n---\n# Queued\n";
  const body = "approved context\r\n";
  put(join(checkout, path), text);
  put(join(checkout, source), body);
  const chain = { name: "legacy-chain", created_at: NOW, updated_at: NOW, repo, base: "main", status: "stopped", index: 0,
    reason: "queued PRD or sources changed; review them", steps: [{ id: repo + "/first", path: join(checkout, path), relPath: path, checkout,
      harness: "codex", digest: contentDigest(JSON.stringify([repo, checkout, "main", [[path, text], [source, body]]])) }] };
  env.state.createChain(chain);
  const query = { chain: chain.name, milestone: chain.steps[0].id, artifact: chainFilesRef(chain, chain.steps[0]) };
  const seen = (await artifact(env, query)).data;
  assert.equal(seen.text, text);
  assert.equal(seen.files[1].path, source);
  assert.equal((await artifact(env, { ...query, artifact: seen.files[1].ref })).data.text, body);
  put(join(checkout, source), "edited context");
  const changed = (await artifact(env, query)).data;
  assert.equal(changed.state, "changed");
  assert.equal(changed.detail, chain.reason);
  rmSync(join(checkout, path));
  const missing = (await artifact(env, query)).data;
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.detail, chain.reason);
});

test("approved plan blobs stay frozen and a reviewed preview rechecks its operator scope", async t => {
  const env = await planFixture(t), headers = { authorization: ACTOR };
  env.brief("planned-leaf");
  const reviewed = encode(manifest("about-to-queue", [task("planned-leaf")]), "yaml");
  const page = await (await fetch(env.origin + "/gallivant/plans", { headers })).text();
  const token = /data-token="([a-f0-9]+)"/.exec(page)?.[1];
  const response = await fetch(env.origin + "/gallivant/api/plan/control", {
    method: "POST", headers: { ...headers, "content-type": "application/json", origin: env.origin, "x-gallivant-token": token },
    body: JSON.stringify({ action: "queue", stage: "review", requestId: "artifact-preview", manifest: reviewed }),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  const reviewQuery = { artifact: result.artifact };
  const preview = (await artifact(env, reviewQuery, { base: "/gallivant", actor: ACTOR })).data;
  assert.equal(preview.text, reviewed.text);
  assert.equal(preview.revision, result.revision);
  assert.equal(preview.file.origin, "Reviewed plan preview");
  assert.equal((await artifact(env, reviewQuery)).status, 404);
  const brief = preview.files.find(file => file.role === "PRD");
  assert.ok(brief);
  env.brief("planned-leaf", "\nNew checkout line");
  assert.doesNotMatch((await artifact(env, { artifact: brief.ref }, { actor: ACTOR })).data.text, /New checkout line/);
  env.denied.add("read");
  assert.equal((await artifact(env, reviewQuery, { actor: ACTOR })).status, 404);
  env.denied.delete("read");

  const queued = await env.queue("approved-plan", [task("planned-leaf")]);
  const privatePlan = await env.queue("private-plan", [task("private-leaf")], { privatePlan: true });
  const planQuery = { plan: queued.instanceId, artifact: planFilesRef(env.state.graphPlan(queued.instanceId)) };
  env.brief("planned-leaf", "\nA later line");
  const plan = (await artifact(env, planQuery, { actor: ACTOR })).data;
  assert.equal(plan.file.path, "approved-plan.json");
  const leaf = plan.files.find(file => file.role === "PRD");
  const approvedFile = (await artifact(env, { ...planQuery, artifact: leaf.ref }, { actor: ACTOR })).data;
  assert.match(approvedFile.text, /New checkout line/);
  assert.doesNotMatch(approvedFile.text, /A later line/);
  assert.equal((await artifact(env, { ...planQuery, plan: privatePlan.instanceId }, { actor: ACTOR })).status, 404);
});

test("Markdown preview keeps structure and disables raw HTML, unsafe links and media", () => {
  const input = [
    "# Heading", "", "[Reach heading](#heading) · [Bad](javascript:alert(1)) · [Relative](/api/private) · [Good](https://example.test/docs)",
    "", "![Remote](https://unsafe.example/image.png) <img src=x>", "", "- item", "  - nested", "",
    "| A | B |", "| --- | --- |", "| a | b |", "", "```sh", "<script>readable code</script>", "```", "",
  ].join("\n");
  const { html, headings } = artifactMarkdown(input, "http://127.0.0.1:8791");
  assert.deepEqual(headings, [{ id: "artifact-heading-1", label: "Heading" }]);
  assert.match(html, /data-artifact-heading="artifact-heading-1"/);
  assert.match(html, /<a href="https:\/\/example.test\/docs" target="_blank" rel="noopener noreferrer">Good<\/a>/);
  assert.match(html, /<span>Bad<\/span>/);
  assert.match(html, /<span>Relative<\/span>/);
  assert.match(html, /<ul>[\s\S]*<ul>[\s\S]*nested/);
  assert.match(html, /<table>[\s\S]*<td>a<\/td>/);
  assert.match(html, /<pre><code class="language-sh">&lt;script&gt;readable code&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img|<script|unsafe\.example|href="javascript/);
});
