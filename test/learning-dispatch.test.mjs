import test from "node:test";
import assert from "node:assert/strict";
import { learningInput, learningDelivered, revokeLearningAttempts } from "../lib/learning_input.mjs";
import { createLearningService } from "../lib/learning.mjs";
import { repo, fixture } from "./learning-fixtures.mjs";
import { hash } from "../lib/learning_data.mjs";
import { makeTick } from "../lib/tick.mjs";
import { CONFIG, seededState, makeClock, fakeGh, fakeGit, fakeNotify, fakeRunner, fakeCredential, fakeIdentity, silentLog, STATES, inline, at } from "./helpers.mjs";

const input = { operationId: "op-1", prompt: "Task gates\nVerify: npm test\nAcceptance: exact contract", mandatoryPolicy: ["workspace-write", "auto-review"], allowance: { remainingUsd: 2, reservedUsd: 1 } };
test("shared local/hosted inputs retain exact task gates and record the managed digest", async () => {
  const updates = [], service = {
    identityFor: () => repo, mode: () => "apply", resolveRepo: async () => repo,
    context: async (_repo, options) => { assert.equal(options.inputDigest, hash(input)); return { key: "a".repeat(64), section: "Reviewed advisory guidance", rules: [{ id: "lesson-validation", digest: "b".repeat(64) }], freshSessionRequired: false }; },
    delivered: async (_repo, key, runId) => ({ key, runId, delivered: true }),
  };
  for (const harness of ["codex", "claude", "openai-agents", "codex-cloud"]) {
    const ctx = { learning: service, state: { update: (...args) => updates.push(args) } };
    const managed = await learningInput(ctx, "task-1", { repo: "example/project", harness }, input);
    assert(managed.prompt.startsWith(input.prompt)); assert(managed.prompt.includes("Reviewed advisory")); assert.equal(managed.allowance, input.allowance); assert.deepEqual(managed.mandatoryPolicy, input.mandatoryPolicy);
    await learningDelivered(ctx, "task-1", managed, { id: "run-1" });
    assert.equal(managed.managedInputDigest, hash({ ...input, advice: "Reviewed advisory guidance" }));
  }
  assert.equal(updates.length, 4);
});

test("pending and unknown/foreign repositories never become managed context", async t => {
  const { service } = fixture(t);
  assert.deepEqual(await learningInput({ learning: service }, "task", { repo: "example/project", harness: "codex" }, input), input);
  const foreign = { identityFor: () => repo, mode: () => "apply", resolveRepo: async () => ({ host: "github.com", id: "9999" }), context: () => { throw new Error("must not construct foreign context"); } };
  await assert.rejects(learningInput({ learning: foreign }, "task", { repo: "example/project", harness: "codex" }, input), /identity changed/);
});

test("retired native session memory blocks resume while preserving logical task and code", async () => {
  const entry = { repo: "example/project", harness: "codex", session: "native-session", learning: { rules: [{ id: "lesson-x", digest: "b".repeat(64) }] }, pr: 27, worktree: "/checkout", cursor: { since: "unchanged" }, iteration: 2 };
  const original = JSON.stringify(entry);
  const service = { identityFor: () => repo, mode: () => "collect", resolveRepo: async () => repo, context: async () => ({ section: "", freshSessionRequired: true }) };
  await assert.rejects(learningInput({ learning: service }, "task", entry, input), /fresh-provider continuity/);
  assert.equal(JSON.stringify(entry), original);
});

test("default migrated profiles cannot activate with forged configuration or fixture flags", async t => {
  const { root } = fixture(t);
  const service = createLearningService({ root });
  await assert.rejects(service.configure(repo, "apply", { qualified: true, fixtureOnly: true, tty: true }));
  assert.equal(service.mode(repo), "off");
});

test("automatic collection runs after fixing feedback and cannot consume rounds or delay dispatch", async () => {
  const { state, id } = seededState({ state: STATES.prOpen }), clock = makeClock(), runner = fakeRunner(clock);
  const gh = fakeGh({ inline: [inline({ id: 9, by: "me", at: at(1), body: "Validate the error path" })] });
  let observations = 0;
  const learning = { identityFor: () => repo, mode: () => "collect", observe: async () => { observations++; assert.equal(runner.started.length, 1, "fix dispatch precedes collection"); throw new Error("learning storage unavailable"); } };
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity(), learning });
  const before = state.get(id).iteration;
  const result = await tick.tick();
  assert.equal(result[0].ok, true); assert.equal(runner.started.length, 1); assert.equal(observations, 1); assert.equal(state.get(id).iteration, before);
});
