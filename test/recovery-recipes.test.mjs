import test from "node:test";
import assert from "node:assert/strict";
import { makeState } from "../lib/state.mjs";
import { acceptedRecovery, incidentMutationAllowed, planRecovery, recordReviewCycle } from "../lib/recovery_recipes.mjs";
import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { makeGh } from "../lib/gh.mjs";
import { join, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeExecution } from "../lib/execution.mjs";
import { makeTick } from "../lib/tick.mjs";
import { ownerDelivery } from "../lib/owner_delivery.mjs";
import { CONFIG, GOOD_PRD, at, comment, fakeCredential, fakeGit, fakeGh, fakeIdentity, fakeNotify, fakeRunner, makeClock, seededState, silentLog } from "./helpers.mjs";
import { admitFixture } from "./recovery-recipe-fixture.mjs";

function fixture() {
  const { home, state, id } = seededState({ state: "needs-human", reason: "reviewer-silent" });
  const ctx = { home, state, config: CONFIG, clock: makeClock(), readPrd: () => GOOD_PRD };
  const { run } = admitFixture(ctx, id, "feedback-continuation");
  ctx.runnerFor = () => ({ current: () => run });
  const plan = (input = "cursor") => planRecovery(ctx, id, "feedback-continuation", { cause: "feedback", input, spendMicros: 10 });
  return { ctx, id, plan, run };
}

test("intent and one operation survive restart at reservation and uncertain submission", () => {
  const { ctx, id, plan } = fixture();
  const first = plan();
  first.reserve("op-1");
  ctx.state = makeState(ctx.home);
  const next = plan();
  assert.equal(first.key, next.key);
  assert.notEqual(first.key, "op-1");
  next.reserve("op-1");
  assert.throws(() => next.reserve("op-2"), /different operation/);
  next.executing();
  assert.throws(() => plan().executing(), /Observe the original/);
  const journal = ctx.state.get(id).recovery_actions;
  assert.equal(journal.intents[first.key].priorOperation, "original-turn");
  assert.deepEqual(journal.total, { paidTurns: 1, mutations: 1, spendMicros: 10 });
});

test("control, qualification and hold generation are rechecked before the effect", () => {
  const { ctx, id, plan } = fixture();
  const prepared = plan(), scope = `task/${id}`;
  ctx.state.setRecoveryHold(scope, "hold", 0, recoveryAdminIntent(ctx.state.file, "hold", scope, 0));
  assert.throws(() => prepared.reserve("op"));
  ctx.state.setRecoveryHold(scope, "resume", 1, recoveryAdminIntent(ctx.state.file, "resume", scope, 1));
  assert.throws(() => prepared.reserve("op"));
  const fresh = plan();
  ctx.state.update(id, { control: { id: "message", action: "message", status: "queued" } });
  assert.throws(() => fresh.reserve("op"));
  ctx.state.update(id, { control: null });
  delete ctx.recoveryQualificationFor;
  assert.throws(() => plan(), /sandbox/);
  assert.equal(ctx.state.get(id).recovery_actions.total.paidTurns, 0);
});

test("unchanged findings retain their mutation ceiling across new heads and inputs", () => {
  const { ctx, id, plan } = fixture();
  for (const head of ["a", "b"]) {
    ctx.state.update(id, { cursor: { fixed_sha: head } });
    const p = plan(head); p.reserve(head); p.executing(); p.phase("resumed");
  }
  assert.throws(() => plan("c").reserve("c"), /incident/);
  assert.equal(ctx.state.get(id).iteration, 0);
  assert.equal(incidentMutationAllowed({ semanticRepairs: 0 }, "semantic"), true);
  assert.equal(incidentMutationAllowed({ semanticRepairs: 1 }, "semantic"), false);
});

test("publication checks all branch history and never replaces a closed PR or an uncertain create", async () => {
  let rows = [], creates = 0;
  const gh = makeGh({ exec: async (_cmd, args) => {
    if (args.includes("list")) { assert.ok(args.includes("all")); return { stdout: JSON.stringify(rows) }; }
    creates++; throw new Error("reply lost");
  } });
  const input = { repo: "acme/widget", branch: "work/test", base: "main", title: "Fix", body: "Verified" };
  await assert.rejects(gh.publishResultPr(input));
  await assert.rejects(gh.publishResultPr({ ...input, observeOnly: true }), /unresolved/);
  rows = [{ number: 1, isCrossRepository: false, headRefName: input.branch, baseRefName: input.base, state: "CLOSED" }];
  await assert.rejects(gh.publishResultPr(input), /Terminal/);
  assert.equal(creates, 1);
});

test("accepted receipts, unknown reservations and unsuccessful review cycles survive re-entry independently", () => {
  const { ctx, id, plan, run } = fixture();
  const a = plan("a"); a.reserve("one"); a.executing();
  assert.throws(() => plan("different").reserve("two"), /uncertain/);
  assert.equal(ctx.state.get(id).recovery_actions.submitted, undefined);
  acceptedRecovery(ctx.state, id, a.key, "one", "resumed");
  acceptedRecovery(ctx.state, id, a.key, "one", "resumed");
  assert.equal(ctx.state.get(id).recovery_actions.submittedRecipes["feedback-continuation"].paidTurns, 1);
  for (const cycle of [1, 2, 3]) {
    const entry = ctx.state.get(id);
    run.execution = { ...entry.execution, operationId: "author-" + cycle };
    const updated = ctx.state.update(id, { execution: run.execution });
    assert.equal(recordReviewCycle(ctx.state, id, updated, "head-" + cycle, false), cycle);
    assert.equal(recordReviewCycle(ctx.state, id, updated, "another observation", false), cycle);
  }
  assert.throws(() => plan("different").reserve("two"), /incident/);
  assert.equal(ctx.state.get(id).iteration, 0);
  assert.equal(recordReviewCycle(ctx.state, id, ctx.state.get(id), "verified-clear", true), 0);
});

for (const [recipe, missingSession] of [["feedback-continuation", false], ["publication-continuation", false], ["feedback-continuation", true]])
  test(`stopped ${recipe} ${missingSession ? "refuses a lost native session" : "dispatches one linked native turn and survives repeat observation"}`, async () => {
  const publication = recipe === "publication-continuation";
  const { home, state, id } = seededState({ state: "needs-human", reason: publication ? "no-pr" : "reviewer-silent",
    ...(publication ? { pr: null, url: null, task: { ownerDelivery: ownerDelivery("Fix the widget. Open a pull request.") } } : {}) });
  const worktree = join(home, "checkout"), root = join(home, "author");
  const entry = state.update(id, { worktree });
  const briefFile = join(worktree, entry.prd);
  mkdirSync(dirname(briefFile), { recursive: true }); mkdirSync(root);
  writeFileSync(briefFile, GOOD_PRD);
  const clock = makeClock(at(10)), runner = fakeRunner(clock);
  const config = { ...CONFIG, home, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, model: "fixture" } } };
  const ctx = { home, state, config, clock, readPrd: () => GOOD_PRD, gh: fakeGh({ comments: [
    comment({ id: 123, by: "me", at: at(6), body: "/fix Keep widget exports in order." })] }),
    git: { ...fakeGit(), currentBranch: () => entry.branch, authorStorage() {} }, credential: fakeCredential(), identity: fakeIdentity(),
    ownLogin: "me", log: silentLog, notify: fakeNotify(), checkHarness: async () => ({ ok: true }),
    authorCapabilityEvidence: ({ binding }) => ({ binding, ok: true, expiresAt: clock.now() + 60_000 }) };
  Object.assign(ctx.gh, { repoPermissions: async () => ({ pullRequestCreate: "proved", apiRepositoryWrite: "proved" }), branchExists: async () => true });
  const { run, profile } = admitFixture(ctx, id, recipe);
  run.execution.recoveryProfileDigest = profile.digest;
  if (missingSession) run.execution.sessionId = null;
  state.update(id, { execution: run.execution, session: run.execution.sessionId });
  writeFileSync(join(root, "execution.json"), JSON.stringify({ version: 1, provider: "claude", account: "operator", taskId: id, current: run,
    operations: { [run.execution.operationId]: { acceptance: "accepted", runId: run.id, job: run } } }));
  ctx.executionFor = () => makeExecution({ root, taskId: id, provider: "claude", runner, clock });
  const tick = makeTick(ctx);
  await tick.tickEntry(id, state.get(id));
  const updated = state.get(id);
  if (missingSession) {
    assert.equal(runner.started.length, 0);
    assert.equal(updated.recovery_wait.phase, "blocked-authority");
    assert.match(updated.recovery_wait.reason, /native session/);
    return;
  }
  assert.equal(runner.started.length, 1, JSON.stringify(updated.recovery_wait || updated.last));
  assert.equal(updated.execution.previousOperationId, run.execution.operationId);
  assert.equal(updated.execution.sessionId, entry.session);
  assert.equal(updated.recovery_actions.submitted.paidTurns, 1);
  assert.equal(updated.recovery_actions.intents[updated.execution.recoveryIntent].operation, updated.execution.operationId);
  await makeTick(ctx).tickEntry(id, updated);
  assert.equal(runner.started.length, 1);
});
