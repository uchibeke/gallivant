import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import Ajv from "ajv";
import { makeTick } from "../lib/tick.mjs";
import { completionPolicy, completionView, COMPLETION_CAPABILITIES } from "../lib/task_completion.mjs";
import { TASK_OPERATIONS } from "../lib/task_delivery_contract.mjs";
import { taskView, modelSummary, taskListSummary, capabilitySummary } from "../lib/task_delivery_view.mjs";
import { CONFIG, T0, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, prFixture, review, inline, checkRun, silentLog, STATES, GOOD_PRD, fakeCredential, fakeIdentity } from "./helpers.mjs";

const BOT = "chatgpt-codex-connector[bot]";
const receipt = "\n```work-attestations\n" + JSON.stringify({ task_id: "widget/widget-export", output_type: "code",
  summary: "Added a CSV export endpoint and button, with unit tests for three rows and the empty state, verified by npm test and npm run lint locally.",
  criteria_attestations: [{ criterion_id: "ac-1", met: true, evidence: "src/export/csv.test.ts exports three rows" }, { criterion_id: "ac-2", met: true, evidence: "src/export/Button.tsx disables empty export" }],
}) + "\n```\n";
function world(t, target = "integrated", overrides = {}) {
  const { home, state, id } = seededState({ task: { id: "task-fixture", completion: completionPolicy({ target }) }, ...overrides });
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = makeClock(); clock.advance(5);
  const gh = fakeGh({ pr: prFixture({ body: "Adds export.\n" + receipt, statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })] }),
    reviews: [review({ id: 2, by: BOT, bot: true, at: at(3), body: "**Reviewed commit:** `a1b2c3d`" })] });
  const runner = fakeRunner(clock), notify = fakeNotify();
  const tick = makeTick({ config: { ...CONFIG, deliverable: { ...CONFIG.deliverable, evaluator: "local" } }, state, gh, git: fakeGit(), notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, credential: fakeCredential(), identity: fakeIdentity() });
  return { state, id, clock, gh, runner, notify, tick, entry: () => state.get(id), view: () => completionView(null, state.get(id)) };
}
test("completion schemas advertise only supported portable milestones and never merge authority", () => {
  assert.deepEqual(completionPolicy(), { version: 1, target: "delivery_ready" });
  assert.equal(completionView(completionPolicy()).label, COMPLETION_CAPABILITIES.targets[0].label);
  assert.equal(completionView(completionPolicy({ target: "integrated" })).description, COMPLETION_CAPABILITIES.targets[1].description);
  for (const value of [null, { target: "released" }, { target: "integrated", autoMerge: true }, "integrated"]) assert.throws(() => completionPolicy(value), { code: "TASK_INPUT" });
  const validate = new Ajv({ strict: true }).compile(TASK_OPERATIONS.find(op => op.name === "prepare").inputSchema);
  const input = { repositoryId: "repo", text: "Implement a fix", harness: "codex", allowance: { budgetUsd: 1, runtimeMs: 1000 }, operationId: "one", expectedRevision: 0 };
  assert.ok(validate(input)); assert.ok(validate({ ...input, completion: { target: "integrated" } })); assert.equal(validate({ ...input, completion: { target: "integrated", merge: true } }), false);
  assert.deepEqual(capabilitySummary({ repositories: [{ id: "repo", completion: COMPLETION_CAPABILITIES, providers: [] }] }).repositories[0].completion, COMPLETION_CAPABILITIES);
});
test("delivery-ready fulfills at the canonical gate; integrated waits for observed external merge without another run", async t => {
  for (const target of ["delivery_ready", "integrated"]) await t.test(target, async t => {
    const w = world(t, target); await w.tick.tick();
    assert.equal(w.entry().state, STATES.ready); assert.equal(w.view().status, target === "integrated" ? "awaiting_integration" : "fulfilled");
    assert.equal(w.view().evidence.delivery.gate.allow, true); assert.equal(w.view().evidence.delivery.head, "a1b2c3d"); assert.equal(w.view().mergeAuthorized, false);
    await w.tick.tick(); assert.equal(w.runner.started.length, 0);
    Object.assign(w.gh.data.pr, { state: "MERGED", mergedAt: at(6), mergeCommit: { oid: "merge-sha" } }); w.clock.advance(2); await w.tick.tick();
    assert.equal(w.entry().state, STATES.done); assert.equal(w.view().status, "fulfilled"); assert.equal(w.view().evidence.integration.mergeCommit, "merge-sha"); assert.equal(w.runner.started.length, 0);
    const view = taskView({ completion: w.view() }); assert.deepEqual(modelSummary(view).completion, w.view()); assert.deepEqual(taskListSummary(view).completion, w.view());
  });
});
test("closed, early and stale merges retain observed evidence without claiming fulfillment", async t => {
  for (const scenario of ["closed", "before-ready", "head", "receipt", "review", "checks", "base", "before-ready-observation", "invalid-merge-time", "missing-merge-proof"]) await t.test(scenario, async t => {
    const w = world(t); if (scenario !== "before-ready") await w.tick.tick();
    Object.assign(w.gh.data.pr, { state: scenario === "closed" ? "CLOSED" : "MERGED", mergedAt: at(6), mergeCommit: { oid: "merge-sha" } });
    if (scenario === "head") w.gh.data.pr.headRefOid = "new-head";
    if (scenario === "base") w.gh.data.pr.baseRefName = "other-base";
    if (scenario === "receipt") { const before = w.gh.data.pr.body; w.gh.data.pr.body = before.replace(/"met":\s*true/, '"met":false'); assert.notEqual(w.gh.data.pr.body, before); }
    if (scenario === "review") w.gh.data.reviews.push(review({ id: 3, by: BOT, bot: true, at: at(6), state: "CHANGES_REQUESTED", body: "Fix a regression" }));
    if (scenario === "checks") w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", conclusion: "FAILURE" })];
    if (scenario === "before-ready-observation") w.gh.data.pr.mergedAt = at(4);
    if (scenario === "invalid-merge-time") w.gh.data.pr.mergedAt = "not-a-date";
    if (scenario === "missing-merge-proof") w.gh.data.pr.mergeCommit = null;
    w.clock.advance(2); await w.tick.tick();
    assert.equal(w.entry().state, STATES.done); assert.equal(w.view().status, scenario === "closed" ? "blocked" : "unverified"); assert.equal(w.runner.started.length, 0); assert.equal(w.view().evidence.terminal.state, w.gh.data.pr.state);
  });
});
test("post-ready head changes and feedback use the existing review loop and revoke fulfilled status", async t => {
  for (const scenario of ["head", "feedback", "cancel"]) await t.test(scenario, async t => {
    const w = world(t, "delivery_ready"); await w.tick.tick(); assert.equal(w.view().status, "fulfilled");
    if (scenario === "head") { w.gh.data.pr.headRefOid = "d4e5f6a"; w.gh.data.commitDates.d4e5f6a = at(6); }
    if (scenario === "feedback") w.gh.data.inline = [inline({ id: 4, by: BOT, bot: true, at: at(6), body: "Fix a regression" })];
    if (scenario === "cancel") w.state.update(w.id, { dispatch_stopped: "cancellation-requested", state: STATES.needsHuman, reason: "cancellation-requested" });
    w.clock.advance(2); await w.tick.tick(); assert.notEqual(w.view().status, "fulfilled");
    assert.equal(w.runner.started.length, scenario === "feedback" ? 1 : 0); if (scenario === "cancel") assert.equal(w.view().status, "cancelled");
  });
});
test("legacy state and skipped completion gates never gain fabricated fulfillment evidence", async t => {
  const w = world(t, "integrated", { task: undefined }); w.gh.data.pr.state = "CLOSED"; await w.tick.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().completionEvidence, undefined); assert.equal(w.view().legacy, true); assert.equal(w.view().status, "unverified");
  assert.equal(completionView(completionPolicy(), { state: STATES.ready, cursor: { fixed_sha: "head" }, gate_skipped: "no PRD snapshot" }).status, "unverified");
});

for (const scenario of ["receipt", "lost-review", "pending-check", "base"]) test(`open ready invalidation: ${scenario}`, async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick(); assert.equal(w.view().status, "fulfilled");
  if (scenario === "receipt") w.gh.data.pr.body = w.gh.data.pr.body.replace(/"met":\s*true/, '\"met\":false');
  if (scenario === "lost-review") w.gh.data.reviews = [];
  if (scenario === "pending-check") w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", status: "IN_PROGRESS", conclusion: null })];
  if (scenario === "base") w.gh.data.pr.baseRefName = "other-base";
  w.clock.advance(2); await w.tick.tick();
  assert.notEqual(w.view().status, "fulfilled", scenario + " must revoke stale readiness");
  assert.equal(w.runner.started.length, 0, "invalidation itself must not launch implementation");
  assert.equal(w.view().evidence.delivery.gate.allow, true, "keep the historical qualified observation");
  assert.ok(w.view().evidence.delivery.invalidatedAt);
});

test("dismissed review cannot qualify merge", async t => {
  const w = world(t); await w.tick.tick(); assert.equal(w.view().status, "awaiting_integration");
  w.gh.data.reviews[0].state = "DISMISSED";
  Object.assign(w.gh.data.pr, { state: "MERGED", mergedAt: at(6), mergeCommit: { oid: "merge-sha" } });
  w.clock.advance(2); await w.tick.tick();
  assert.notEqual(w.view().status, "fulfilled", "dismissed review must not prove readiness");
});

test("failed stale-label removal cannot preserve fulfillment and restored checks requalify normally", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  const remove = w.gh.removeLabel;
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", status: "IN_PROGRESS", conclusion: null })];
  w.gh.removeLabel = async () => { throw new Error("temporary label failure"); };
  await w.tick.tick(); assert.equal(w.entry().state, STATES.ready); assert.equal(w.view().status, "unverified");
  assert.ok(w.view().evidence.delivery.invalidatedAt); assert.equal(w.runner.started.length, 0);
  w.gh.removeLabel = remove; await w.tick.tick(); assert.equal(w.entry().state, STATES.prOpen);
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", conclusion: "SUCCESS" })];
  await w.tick.tick(); assert.equal(w.view().status, "fulfilled"); assert.equal(w.view().evidence.delivery.invalidatedAt, undefined);
  assert.equal(w.runner.started.length, 0);
});
