import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import Ajv from "ajv";
import { makeTick } from "../lib/tick.mjs";
import { completionPolicy, completionView, COMPLETION_CAPABILITIES, coordinatorEntryActive } from "../lib/task_completion.mjs";
import { TASK_OPERATIONS } from "../lib/task_delivery_contract.mjs";
import { taskView, modelSummary, taskListSummary, capabilitySummary } from "../lib/task_delivery_view.mjs";
import { ownerDelivery } from "../lib/owner_delivery.mjs";
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
  const deps = { config: { ...CONFIG, deliverable: { ...CONFIG.deliverable, evaluator: "local" } }, state, gh, git: fakeGit(), notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, credential: fakeCredential(), identity: fakeIdentity() };
  const tick = makeTick(deps);
  return { state, id, clock, gh, runner, notify, tick, deps, entry: () => state.get(id), view: () => completionView(null, state.get(id)) };
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
test("fulfilled delivery-ready stops automatic provider/GitHub observation and late fixes", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  assert.equal(w.view().status, "fulfilled");
  assert.equal(w.view().monitoring, false);
  assert.equal(coordinatorEntryActive(w.entry()), false);
  const saved = structuredClone(w.entry());
  w.gh.prView = async () => assert.fail("fulfilled delivery target must not poll GitHub");
  w.runner.reconcile = async () => assert.fail("fulfilled delivery target must not poll the provider");
  await w.tick.tick(); await w.tick.tickEntry(w.id, w.entry());
  assert.deepEqual(w.entry(), saved); assert.equal(w.runner.started.length, 0);
});
test("qualified handoff cannot stop live or uncollected execution, but settled history can", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  const settled = { version: 1, provider: "openai-agents", transport: "remote", acceptance: "accepted", providerJobId: "job", turnId: "turn", providerState: "succeeded", collected: true };
  for (const change of [{ providerState: "running" }, { collected: false }, { acceptance: "unknown" }, { turnId: null }]) {
    const entry = { ...w.entry(), execution: { ...settled, ...change } };
    assert.equal(coordinatorEntryActive(entry), true);
    assert.equal(completionView(null, entry).status, "pending");
  }
  assert.equal(coordinatorEntryActive({ ...w.entry(), execution: settled }), false);
});
test("qualified handoffs retry learning audits after restart without reopening review or execution", async t => {
  for (const transport of ["local", "remote"]) await t.test(transport, async t => {
    const outbox = { pending: { repo: { host: "github.com", id: "123" }, key: "advice", runId: "old-run" } };
    const w = world(t, "delivery_ready", { learning_deliveries: outbox });
    let locked = true, audits = 0;
    const learning = { identityFor: () => null, delivered: async () => {
      audits++; if (locked) throw new Error("learning store temporarily locked");
      return { key: "advice", runId: "old-run", delivered: true };
    } };
    const deps = { ...w.deps, learning, ...(transport === "remote" ? { executionFor: () => w.runner } : {}) };
    await makeTick(deps).tick();
    assert.equal(w.entry().state, STATES.ready);
    assert.deepEqual(w.entry().learning_deliveries, outbox);
    assert.equal(coordinatorEntryActive(w.entry()), true, "pending audit keeps the host awake");
    const proof = structuredClone(w.entry().completionEvidence), before = audits;
    w.gh.prView = async () => assert.fail("audit retry must not read late PR feedback");
    w.runner.reconcile = async () => assert.fail("audit retry must not poll settled execution");
    locked = false;
    await makeTick(deps).tick();
    assert.equal(audits, before + 1);
    assert.deepEqual(w.entry().learning_deliveries, {});
    assert.deepEqual(w.entry().completionEvidence, proof);
    assert.equal(coordinatorEntryActive(w.entry()), false);
    assert.equal(w.runner.started.length, 0);
    await makeTick(deps).tick();
    assert.equal(audits, before + 1, "settled audit does not keep the task awake");
  });
});
test("ledger ahead of qualified registry is reconciled before handoff stops without another dispatch", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  w.state.update(w.id, { last: { ...w.entry().last, run: "owned-run", exit: 0 } });
  const current = { id: "owned-run", running: true, execution: { version: 1, provider: "openai-agents", transport: "remote", acceptance: "accepted", providerJobId: "job", turnId: "turn", providerState: "running", collected: false } };
  let reconciled = 0;
  w.runner.current = () => structuredClone(current);
  w.runner.reconcile = async () => { reconciled++; current.running = false; current.execution.providerState = "succeeded"; current.execution.collected = true; };
  w.gh.prView = async () => assert.fail("settled handoff cannot read late feedback or dispatch another fix");
  const tick = makeTick({ ...w.deps, executionFor: () => w.runner });
  await tick.tick();
  assert.equal(reconciled, 1, "the saved ledger must not be filtered using stale registry proof");
  assert.equal(w.entry().execution.collected, true);
  assert.equal(w.view().monitoring, false);
  assert.equal(w.runner.started.length, 0);
  await tick.tick(); assert.equal(reconciled, 1, "historical settled execution does not keep polling");
});
test("delivery-ready fulfills at the canonical gate; integrated waits for observed external merge without another run", async t => {
  for (const target of ["delivery_ready", "integrated"]) await t.test(target, async t => {
    const w = world(t, target); await w.tick.tick();
    assert.equal(w.entry().state, STATES.ready); assert.equal(w.view().status, target === "integrated" ? "awaiting_integration" : "fulfilled");
    assert.equal(w.view().evidence.delivery.gate.allow, true); assert.equal(w.view().evidence.delivery.head, "a1b2c3d"); assert.equal(w.view().mergeAuthorized, false);
    await w.tick.tick(); assert.equal(w.runner.started.length, 0);
    Object.assign(w.gh.data.pr, { state: "MERGED", mergedAt: at(6), mergeCommit: { oid: "merge-sha" } }); w.clock.advance(2); await w.tick.tick();
    assert.equal(w.entry().state, target === "integrated" ? STATES.done : STATES.ready); assert.equal(w.view().status, "fulfilled");
    if (target === "integrated") assert.equal(w.view().evidence.integration.mergeCommit, "merge-sha");
    else assert.equal(w.view().evidence.integration, undefined, "handoff target does not continue observing merges");
    assert.equal(w.runner.started.length, 0);
    const view = taskView({ completion: w.view() }); assert.deepEqual(modelSummary(view).completion, w.view()); assert.deepEqual(taskListSummary(view).completion, w.view());
  });
});
test("source-owned publication joins actual canonical gate evidence without changing a false provider receipt", async t => {
  for (const met of [true, false]) await t.test(String(met), async t => {
    const owner = ownerDelivery("Implement CSV export and preserve the empty state. Open one pull request for review.");
    const w = world(t, "delivery_ready", { task: { id: "task-fixture", completion: completionPolicy(), ownerDelivery: owner } });
    if (!met) w.gh.data.pr.body = w.gh.data.pr.body.replace(/"met":true/g, '"met":false');
    const originalBody = w.gh.data.pr.body;
    await w.tick.tick();
    assert.equal(w.view().obligations[0].status, met ? "fulfilled" : "pending");
    assert.equal(w.view().status === "fulfilled", met);
    if (met) assert.equal(w.view().obligations[0].evidence.head, "a1b2c3d");
    else {
      const criteria = body => JSON.parse(body.match(/```work-attestations\n([\s\S]+?)\n```/)[1]).criteria_attestations;
      assert.deepEqual(criteria(w.gh.data.pr.body), criteria(originalBody), "false attestations cannot be rewritten by ownership separation; existing task-ID/session binding may still update metadata");
    }
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
test("integrated head changes and feedback retain the existing review loop until merge", async t => {
  for (const scenario of ["head", "feedback", "cancel"]) await t.test(scenario, async t => {
    const w = world(t, "integrated"); await w.tick.tick(); assert.equal(w.view().status, "awaiting_integration");
    if (scenario === "head") { w.gh.data.pr.headRefOid = "d4e5f6a"; w.gh.data.commitDates.d4e5f6a = at(6); }
    if (scenario === "feedback") w.gh.data.inline = [inline({ id: 4, by: BOT, bot: true, at: at(6), body: "Fix a regression" })];
    if (scenario === "cancel") w.state.update(w.id, { dispatch_stopped: "cancellation-requested", state: STATES.needsHuman, reason: "cancellation-requested" });
    w.clock.advance(2); await w.tick.tick(); assert.notEqual(w.view().status, "awaiting_integration");
    assert.equal(w.runner.started.length, scenario === "feedback" ? 1 : 0); if (scenario === "cancel") assert.equal(w.view().status, "cancelled");
  });
});
test("legacy state and skipped completion gates never gain fabricated fulfillment evidence", async t => {
  const w = world(t, "integrated", { task: undefined }); w.gh.data.pr.state = "CLOSED"; await w.tick.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().completionEvidence, undefined); assert.equal(w.view().legacy, true); assert.equal(w.view().status, "unverified");
  assert.equal(completionView(completionPolicy(), { state: STATES.ready, cursor: { fixed_sha: "head" }, gate_skipped: "no PRD snapshot" }).status, "unverified");
});

for (const scenario of ["receipt", "lost-review", "pending-check", "base"]) test(`open ready invalidation: ${scenario}`, async t => {
  const w = world(t, "integrated"); await w.tick.tick(); assert.equal(w.view().status, "awaiting_integration");
  if (scenario === "receipt") w.gh.data.pr.body = w.gh.data.pr.body.replace(/"met":\s*true/, '\"met\":false');
  if (scenario === "lost-review") w.gh.data.reviews = [];
  if (scenario === "pending-check") w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", status: "IN_PROGRESS", conclusion: null })];
  if (scenario === "base") w.gh.data.pr.baseRefName = "other-base";
  w.clock.advance(2); await w.tick.tick();
  assert.notEqual(w.view().status, "awaiting_integration", scenario + " must revoke stale readiness");
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
  const w = world(t, "integrated"); await w.tick.tick();
  const remove = w.gh.removeLabel;
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", status: "IN_PROGRESS", conclusion: null })];
  w.gh.removeLabel = async () => { throw new Error("temporary label failure"); };
  await w.tick.tick(); assert.equal(w.entry().state, STATES.ready); assert.equal(w.view().status, "unverified");
  assert.ok(w.view().evidence.delivery.invalidatedAt); assert.equal(w.runner.started.length, 0);
  w.gh.removeLabel = remove; await w.tick.tick(); assert.equal(w.entry().state, STATES.prOpen);
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "test", conclusion: "SUCCESS" })];
  await w.tick.tick(); assert.equal(w.view().status, "awaiting_integration"); assert.equal(w.view().evidence.delivery.invalidatedAt, undefined);
  assert.equal(w.runner.started.length, 0);
});

test("explicit recheck reopens handoff monitoring and may act on newly authorized review feedback", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  w.gh.data.inline = [inline({ id: 4, by: BOT, bot: true, at: at(6), body: "Fix a regression" })];
  w.clock.advance(2); await w.tick.tick(); assert.equal(w.runner.started.length, 0);
  w.state.update(w.id, { control: { id: "explicit-recheck", action: "recheck", status: "queued", at: at(7), note: "", interrupt: false } });
  assert.equal(coordinatorEntryActive(w.entry()), true);
  await w.tick.tick(); assert.equal(w.runner.started.length, 1);
  assert.equal(w.entry().control.status, "applied");
  assert.notEqual(w.view().status, "fulfilled");
});

test("mismatched proof, reopened entries and legacy readiness cannot suppress coordinator work", async t => {
  for (const field of ["head", "base", "repository", "pr", "reopened", "legacy", "integration-only"]) await t.test(field, async t => {
    const w = world(t, "delivery_ready"); await w.tick.tick();
    if (field === "reopened") w.state.update(w.id, { state: STATES.prOpen });
    else if (field === "legacy") w.state.update(w.id, { task: undefined });
    else if (field === "integration-only") w.state.update(w.id, { completionEvidence: { integration: { qualified: true } } });
    else {
      const evidence = structuredClone(w.entry().completionEvidence); evidence.delivery[field] = field === "pr" ? 99 : "changed";
      w.state.update(w.id, { completionEvidence: evidence });
    }
    assert.equal(coordinatorEntryActive(w.entry()), true, field);
    let reads = 0; const original = w.gh.prView; w.gh.prView = async (...args) => { reads++; return original(...args); };
    await w.tick.tick(); assert.ok(reads > 0, field);
  });
});

test("malformed owner proof cannot suppress work or prevent another entry from advancing", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  const broken = structuredClone(w.entry());
  broken.task.ownerDelivery = { version: 1, source: "broken" };
  w.state.put(w.id, broken);
  const otherId = w.id + "-other", healthy = structuredClone(broken);
  delete healthy.task.ownerDelivery; healthy.task.completion = completionPolicy({ target: "integrated" });
  w.state.put(otherId, healthy);
  assert.equal(coordinatorEntryActive(w.entry()), true, "malformed proof never means finished");
  const results = await w.tick.tick();
  assert.ok(results.some(result => result.id === otherId && result.ok), "an independent task must still advance");
});


test("missing or empty repository and base identities cannot qualify handoff or suppress work", async t => {
  const w = world(t, "delivery_ready"); await w.tick.tick();
  for (const [entryField, proofField] of [["repo", "repository"], ["base", "base"]]) {
    for (const value of [undefined, null, "", "   ", 17]) {
      const broken = structuredClone(w.entry());
      broken[entryField] = value; broken.completionEvidence.delivery[proofField] = value;
      assert.equal(completionView(null, broken).status, "unverified", `${entryField}: ${value}`);
      assert.equal(coordinatorEntryActive(broken), true, `${entryField}: ${value}`);
    }
  }
});
