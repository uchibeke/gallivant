import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { inspectPlanApproval, planControl, previewPlan, recordPlanApprovalConsent } from "../lib/dependency_plan_admission.mjs";
import { newPlanReviewId } from "../lib/dependency_plan_registry.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { bindPlanOperator } from "../lib/operator_intent.mjs";
import { makeState } from "../lib/state.mjs";
import { GOOD_PRD } from "./helpers.mjs";
import { ACTOR, anchor, encode, group, manifest, planFixture, task } from "./ui/dependency-plans-fixture.mjs";

async function client(world, base = "") {
  const get = (path, authorization = ACTOR) => fetch(world.origin + base + path, {
    headers: { authorization }, signal: AbortSignal.timeout(5000),
  });
  const html = await (await get("/plans")).text();
  const token = html.match(/data-token="([a-f0-9]{64})"/)[1];
  const post = async (data, headers = {}) => {
    const response = await fetch(world.origin + base + "/api/plan/control", {
      method: "POST", body: JSON.stringify(data), signal: AbortSignal.timeout(10000),
      headers: { authorization: ACTOR, origin: world.origin, "content-type": "application/json", "x-gallivant-token": token, ...headers },
    });
    return { status: response.status, data: await response.json() };
  };
  const read = async (id, actor) => {
    const response = await get(`/api/plan/approval?approval=${id}`, actor);
    return { status: response.status, data: await response.json() };
  };
  const create = async candidate => {
    const review = await post({ action: "queue", stage: "review", requestId: "preview", manifest: candidate });
    assert.equal(review.status, 200, JSON.stringify(review));
    const { saveRequestId: requestId, revision: approve } = review.data;
    const command = { action: "queue", stage: "save", requestId, approve, manifest: candidate };
    const saved = await post(command);
    assert.equal(saved.status, 200, JSON.stringify(saved));
    return { saved: saved.data, command, approval: { action: "queue", stage: "approve", requestId, approve } };
  };
  return { get, post, read, create };
}

test("read-only preview and copied mounted approval preserve exact YAML, briefs, sources and frozen gates across restart", async t => {
  const parent = mkdtempSync(join(tmpdir(), "plan-review-parent-"));
  const temporaryParent = join(parent, "alias");
  let world;
  try {
    symlinkSync(parent, temporaryParent, "dir");
    world = await planFixture(t, { temporaryParent });
  } finally { t.after(() => rmSync(parent, { recursive: true, force: true })); }
  const { ctx, state } = world, api = await client(world, "/gallivant");
  assert.notEqual(dirname(state.file), world.home, "the registry was originally opened through an alias");
  ctx.config.required_checks = ["Build and test / macOS"];
  const producer = await world.queue("release-producer", [task("upstream")]);
  const prd = GOOD_PRD.replace("harness: codex", "harness: codex\nsources: [inputs/reference.md]");
  world.input("docs/prds/reviewed.md", prd);
  world.input("inputs/reference.md", "Original carried source\r\n");
  world.brief("final");
  const candidate = encode(manifest("saved-release", [
    anchor("upstream", producer.name), group("checks", [task("reviewed"), task("final")], ["upstream"], "sequence"),
  ]), "yaml");
  candidate.text = candidate.text.replaceAll("\n", "\r\n");
  const before = readFileSync(state.file);
  const preview = await api.post({ action: "queue", stage: "review", requestId: "read-only", manifest: candidate });
  assert.equal(preview.status, 200);
  assert.deepEqual(readFileSync(state.file), before);
  const { saved, command, approval } = await api.create(candidate);
  assert.equal(saved.approvalLink, `/gallivant/plans?approval=${saved.requestId}`);
  assert.equal(saved.status, "pending");
  assert.deepEqual((await api.post(command)).data, saved);
  assert.equal(state.load().plans.reviews.length, 1);
  assert.equal(ctx.state.graphPlans().length, 1);
  const savedBytes = readFileSync(state.file), hostReads = world.calls.length;
  ctx.state = makeState(world.home);
  assert.equal((await api.read(saved.requestId)).status, 403, "a grant stays bound to its registry path");
  ctx.state = makeState(dirname(state.file));
  assert.notEqual(ctx.state, state, "reopen the durable registry with a fresh reader");
  const { status, data } = await api.read(saved.requestId);
  assert.equal(status, 200, JSON.stringify(data));
  assert.equal(data.revision, saved.revision);
  assert.deepEqual(data.proposal.order, ["upstream", "checks/reviewed", "checks/final"]);
  assert.equal(data.proposal.anchors[0].instanceId, producer.instanceId);
  assert.equal(data.proposal.dependency, "integrated");
  assert.deepEqual(data.proposal.repositories[0].requiredChecks, ["Build and test / macOS"]);
  assert.equal(data.proposal.repositories[0].baseCommit, "a".repeat(40));
  assert.match(await (await api.get(`/plans?approval=${saved.requestId}`)).text(), /Saved approval request/);
  const selector = `/api/artifact?approval=${saved.requestId}&artifact=`;
  const opened = await (await api.get(selector + data.artifact)).json();
  assert.equal(opened.text, candidate.text);
  for (const [path, role, text] of [["docs/prds/reviewed.md", "PRD", prd], ["inputs/reference.md", "Carried source", "Original carried source\r\n"]]) {
    const file = opened.files.find(file => file.path === path);
    assert.equal(file.role, role);
    assert.equal((await (await api.get(selector + file.ref)).json()).text, text);
  }
  assert.equal((await api.get(selector + data.artifact, "worker")).status, 404);
  assert.equal((await api.read(saved.requestId, "worker")).status, 403);
  assert.equal((await api.post(approval, { authorization: "worker" })).status, 403);
  assert.equal((await api.post(approval, { origin: "https://outside.invalid" })).status, 403);
  assert.equal((await api.post(approval, { "x-gallivant-token": "copied" })).status, 403);
  assert.deepEqual(readFileSync(state.file), savedBytes);
  assert.equal(world.calls.length, hostReads);
  assert.equal(world.spawned(), 0);
});

test("trusted host consent is exact and ephemeral, browser and tool reconcile to one durable scoped receipt", async t => {
  const world = await planFixture(t), { ctx, state } = world, api = await client(world);
  world.brief("first"); world.brief("last");
  const { approval } = await api.create(encode(manifest("sequence", [
    group("pipeline", [task("first"), task("last")], undefined, "sequence"),
  ])));
  const other = bindPlanOperator(state.file, () => ({
    principal: "unrelated", tenant: ACTOR, grant: () => "fixture-grant",
    isolation: { registry: state.file, qualified: true, workerExcluded: true, launchDigest: "e".repeat(64), expiresAt: Date.now() + 60000 },
  }));
  assert.throws(() => inspectPlanApproval({ ...ctx, planAuthority: other }, approval.requestId), { code: "PLAN_MISSING" });
  await assert.rejects(planControl({ ...ctx, planAuthority: other }, approval), { code: "PLAN_MISSING" });
  const tool = { ...approval, stage: "approve-tool" };
  assert.equal((await api.post({ ...tool, consent: "I approve this plan" })).status, 400);
  assert.equal((await api.post(tool, { "x-operator-consent": "true" })).data.code, "PLAN_CONSENT");
  const consent = recordPlanApprovalConsent(ctx, approval.requestId, approval.approve);
  const later = Date.now() + 120_001;
  const clock = t.mock.method(Date, "now", () => later);
  try { await assert.rejects(planControl(ctx, tool, { consent }), { code: "PLAN_CONSENT" }); }
  finally { clock.mock.restore(); }
  const { approval: second } = await api.create(encode(manifest("distinct", [task("first")])));
  await assert.rejects(planControl(ctx, { ...second, stage: "approve-tool" }, { consent }), { code: "PLAN_CONSENT" });
  await assert.rejects(planControl(ctx, tool, { consent: JSON.parse(JSON.stringify(consent)) }), { code: "PLAN_CONSENT" });
  await assert.rejects(planControl(ctx, { ...tool, approve: "b".repeat(64) }, { consent }), { code: "PLAN_STALE" });
  ctx.planApprovalConsentForRequest = (request, intent) => {
    assert.deepEqual(intent, { action: "approve-plan", requestId: approval.requestId, revision: approval.approve });
    return request.headers.authorization === ACTOR ? consent : null;
  };
  const accepted = await api.post(tool);
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.data.receipt.approvalDigest, approval.approve);
  assert.equal(accepted.data.planLink, `/plans?plan=${accepted.data.receipt.instanceId}`);
  const reads = world.calls.length;
  const replays = await Promise.all([api.post(approval), api.post(tool), api.post({ ...approval, stage: "reconcile-review" })]);
  for (const replay of replays) assert.deepEqual(replay, accepted);
  assert.equal(world.calls.length, reads);
  assert.equal(state.graphPlans().length, 1);
  assert.equal(world.spawned(), 0);
  await world.tick();
  assert.equal(world.spawned(), 1);
  assert.ok(state.get("acme/widget/first"));
  assert.equal(state.get("acme/widget/last"), null);
});

test("parallel confirmations, stale files and host bindings, lost grants and expired or ambiguous selectors stay fenced", async t => {
  const world = await planFixture(t), { ctx, state } = world, api = await client(world);
  for (const name of ["parallel", "changed", "denied", "expired", "host-changed"]) world.brief(name);
  const file = "local-sequence.json";
  world.input(file, encode(manifest("local-sequence", [task("parallel")])).text, false);
  const input = { file, options: { directory: world.inputs } }, requestId = newPlanReviewId();
  const { approvalDigest: approve } = await previewPlan(ctx, input);
  await planControl(ctx, { action: "queue", stage: "save", requestId, approve, input });
  const command = { action: "queue", stage: "approve", requestId, approve };
  const replies = await Promise.all(Array.from({ length: 4 }, () => api.post(command)));
  assert.equal(replies[0].status, 200, JSON.stringify(replies));
  for (const reply of replies) assert.deepEqual(reply, replies[0]);
  assert.equal(state.graphPlans().length, 1);

  const changed = await api.create(encode(manifest("changed", [task("changed")])));
  world.brief("changed", "\nEdited after review.\n");
  assert.equal((await api.read(changed.saved.requestId)).data.status, "stale");
  assert.equal((await api.post(changed.approval)).data.code, "PLAN_STALE");
  world.brief("changed");
  assert.equal((await api.read(changed.saved.requestId)).data.status, "stale", "a refused revision remains stale after the input is restored");

  const drift = await api.create(encode(manifest("host-changed", [task("host-changed")])));
  const repoInfo = ctx.gh.repoInfo;
  ctx.gh.repoInfo = async checkout => ({ ...await repoInfo(checkout), repositoryId: "replacement" });
  assert.equal((await api.post(drift.approval)).data.code, "PLAN_STALE");
  ctx.gh.repoInfo = repoInfo;
  assert.equal((await api.read(drift.saved.requestId)).data.status, "stale");

  const denied = await api.create(encode(manifest("denied", [task("denied")])));
  world.denied.add("queue");
  assert.equal((await api.read(denied.saved.requestId)).data.status, "denied");
  assert.equal((await api.post(denied.approval)).status, 403);
  world.denied.add("read");
  assert.equal((await api.read(denied.saved.requestId)).status, 403);
  world.denied.clear();

  const expired = await api.create(encode(manifest("expired", [task("expired")])));
  const store = state.load();
  store.plans.reviews.find(row => row.id === expired.saved.requestId).expiresAt = Date.now() - 1;
  writeJsonAtomic(state.file, store);
  assert.equal((await api.read(expired.saved.requestId)).data.status, "expired");
  assert.equal((await api.post(expired.approval)).data.code, "PLAN_EXPIRED");
  assert.equal((await api.read(`${expired.saved.requestId}&approval=${denied.saved.requestId}`)).status, 403);
  assert.equal((await api.read(denied.saved.requestId)).data.status, "pending");
  assert.equal(state.graphPlans().length, 1);
  assert.equal(world.spawned(), 0);
});

test("retention prunes expired snapshots, never reuses an old ID, and keeps the admission receipt", async t => {
  const world = await planFixture(t), api = await client(world);
  for (const name of ["retained", "pruned", "fresh"]) world.brief(name);
  const accepted = await api.create(encode(manifest("retained", [task("retained")])));
  const admitted = (await api.post(accepted.approval)).data;
  const pending = await api.create(encode(manifest("pruned", [task("pruned")])));
  const later = Date.now() + 48 * 60 * 60_000;
  const clock = t.mock.method(Date, "now", () => later);
  try {
    const fresh = await api.create(encode(manifest("fresh", [task("fresh")])));
    assert.equal((await api.read(pending.saved.requestId)).status, 403);
    assert.equal((await api.post(pending.command)).data.code, "PLAN_STALE");
    const receipt = (await api.read(accepted.saved.requestId)).data;
    assert.deepEqual(receipt.receipt, admitted.receipt);
    assert.equal(receipt.proposal, undefined);
    assert.equal((await api.read(fresh.saved.requestId)).data.status, "pending");
    assert.deepEqual(world.state.load().plans.reviews.map(row => row.id), [fresh.saved.requestId]);
    assert.equal(world.state.graphPlans().length, 1);
  } finally { clock.mock.restore(); }
});
