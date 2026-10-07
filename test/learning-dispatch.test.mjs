import test from "node:test";
import assert from "node:assert/strict";
import { learningInput, learningDelivered, learningDeliveryPatch, revokeLearningAttempts } from "../lib/learning_input.mjs";
import { createLearningService } from "../lib/learning.mjs";
import { repo, fixture } from "./learning-fixtures.mjs";
import { hash } from "../lib/learning_data.mjs";
import { makeTick } from "../lib/tick.mjs";
import { learnCommand } from "../lib/commands/learn.mjs";
import { rmSync } from "node:fs";
import { makeTrust } from "../lib/events.mjs";
import { CONFIG, seededState, makeClock, fakeGh, fakeGit, fakeNotify, fakeRunner, fakeCredential, fakeIdentity, silentLog, STATES, inline, at } from "./helpers.mjs";

const input = { operationId: "op-1", prompt: "Task gates\nVerify: npm test\nAcceptance: exact contract", mandatoryPolicy: ["workspace-write", "auto-review"], allowance: { remainingUsd: 2, reservedUsd: 1 } };
test("shared local/hosted inputs retain exact task gates and record the managed digest", async () => {
  const updates = [], service = {
    identityFor: () => repo, mode: () => "apply", resolveRepo: async () => repo,
    context: async (_repo, options) => { assert.equal(options.inputDigest, hash(input)); return { key: "a".repeat(64), section: "Reviewed advisory guidance", rules: [{ id: "lesson-validation", digest: "b".repeat(64) }], freshSessionRequired: false }; },
    delivered: async (_repo, key, runId) => ({ key, runId, delivered: true }),
  };
  for (const harness of ["codex", "claude", "openai-agents", "codex-cloud"]) {
    let entry;
    const ctx = { learning: service, state: { get: () => entry, update: (_id, patch) => { entry = { ...entry, ...patch(entry) }; updates.push(entry); } } };
    const managed = await learningInput(ctx, "task-1", { repo: "example/project", harness }, input);
    assert(managed.prompt.startsWith(input.prompt)); assert(managed.prompt.includes("Reviewed advisory")); assert.equal(managed.allowance, input.allowance); assert.deepEqual(managed.mandatoryPolicy, input.mandatoryPolicy);
    entry = { last: { run: "run-1" }, ...learningDeliveryPatch({}, managed, { id: "run-1" }) };
    await learningDelivered(ctx, "task-1");
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
  await assert.rejects(learningInput({ learning: service }, "task", entry, input), /fresh-session/);
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

test("automatic observations retain configured private and internal visibility after restart", async t => {
  for (const visibility of ["private", "internal"]) {
    const { state, home } = seededState(); t.after(() => rmSync(home, { recursive: true, force: true }));
    const clock = makeClock(), runner = fakeRunner(clock);
    const gh = fakeGh({ inline: [inline({ id: 9, by: "maintainer", at: at(1), body: "Validate the error path" })] });
    gh.learningRepository = async () => ({ ...repo, visibility });
    const { service, store, root } = fixture(t, { gh });
    await learnCommand({ learning: service }, { args: ["configure"], values: { repo: "acme/widget", mode: "collect" } });
    gh.learningRepository = async () => { throw new Error("automatic observation must not fetch credentials or metadata"); };
    const restarted = createLearningService({ root, store, gh, trust: makeTrust({ trusted_authors: ["maintainer"], reviewer: null }, "me") });
    const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null, learning: restarted });
    const results = await tick.tick(); assert(results.every(r => r.ok));
    const observations = Object.values(store.load(repo).observations);
    assert.equal(observations.length, 1); assert.equal(observations[0].content.visibility, visibility);
    assert.deepEqual(observations[0].content.repo, repo); assert.deepEqual(restarted.identityFor("acme/widget"), repo);
  }
});

test("bounded automatic observation rotates across stable watched order and failed writes", async t => {
  const seeded = seededState(); t.after(() => rmSync(seeded.home, { recursive: true, force: true }));
  const template = seeded.state.get(seeded.id), clock = makeClock(), runner = fakeRunner(clock);
  const records = new Map(Array.from({ length: 201 }, (_, i) => [`entry-${i}`, { ...structuredClone(template), pr: i + 1 }]));
  const state = { ...seeded.state, entries: () => [...records], get: id => records.get(id), update: (id, patch) => { const old = records.get(id); const next = { ...old, ...(typeof patch === "function" ? patch(old) : patch) }; records.set(id, next); return next; } };
  const gh = fakeGh(); gh.prView = async (_repo, pr) => ({ ...gh.data.pr, number: pr });
  gh.setRecoveryMetadata = async (_repo, pr) => ({ ...gh.data.pr, number: pr });
  const observed = [], learning = { identityFor: () => repo, mode: () => "collect", observe: async (_repo, snapshot) => { observed.push(snapshot.pr.number); if (snapshot.pr.number === 1) throw new Error("temporary write failure"); } };
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, executionFor: () => runner, readPrd: () => null, learning });
  for (let i = 0; i < 3; i++) {
    const before = observed.length, results = await tick.tick();
    assert(results.every(r => r.ok)); assert.equal(observed.length - before, 100);
    assert.equal(runner.started.length, 0);
    await tick.tick(); assert.equal(observed.length - before, 100, "idle progress ticks retain the next observation window");
    clock.advance(2);
  }
  assert.equal(new Set(observed).size, 201);
  assert.deepEqual(observed.slice(0, 100).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(observed.slice(100, 200).sort((a, b) => a - b), Array.from({ length: 100 }, (_, i) => i + 101));
});


test("accepted fix ownership and cursor survive learning audit failure and restart without redispatch", async t => {
  const { state, id, home } = seededState(), clock = makeClock(), runner = fakeRunner(clock);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const gh = fakeGh({ inline: [inline({ id: 9, by: "me", at: at(1), body: "Validate the error path" })] });
  let locked = true, audits = 0;
  const learning = { identityFor: () => repo, mode: () => "apply", resolveRepo: async () => repo,
    context: async () => ({ key: "a".repeat(64), section: "Advisory", rules: [{ id: "lesson-x", digest: "b".repeat(64) }] }),
    observe: async () => {}, delivered: async (_repo, key, runId) => {
      audits++;
      assert.equal(state.get(id).last.run, runId, "ownership precedes audit");
      assert.equal(state.get(id).cursor.since, at(1), "feedback acknowledged before audit");
      assert.equal(state.get(id).learning.rules[0].id, "lesson-x", "revocation knows delivered advice even while audit is locked");
      if (locked) throw new Error("operation.lock busy");
      return { key, runId, delivered: true };
    } };
  const deps = { config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity(), learning };
  const before = state.get(id).iteration;
  assert((await makeTick(deps).tick()).every(r => r.ok));
  assert.equal(runner.started.length, 1); assert.equal(audits, 1);
  assert.equal(Object.keys(state.get(id).learning_deliveries).length, 1);
  assert.equal(state.get(id).iteration, before);
  locked = false;
  assert((await makeTick(deps).tick()).every(r => r.ok));
  assert.equal(audits, 2); assert.equal(runner.started.length, 1);
  assert.deepEqual(state.get(id).learning_deliveries, {});
  assert.equal(state.get(id).learning.delivered, true);
});

test("accepted execution recovery persists ownership before retryable delivery audit", async t => {
  for (const transport of ["local", "remote"]) {
    const { state, id, home } = seededState(); t.after(() => rmSync(home, { recursive: true, force: true }));
    const clock = makeClock(), runner = fakeRunner(clock), entry = state.get(id);
    const run = { id: "accepted-run", running: true, execution: { version: 1, acceptance: "accepted", transport,
      operationId: `${entry.last?.run || "initial"}:${entry.iteration}:fix`,
      workflow: { cursor: { ...entry.cursor, since: at(1) } },
      learning: { repo, key: "c".repeat(64), rules: [] } } };
    runner.current = () => run;
    let audits = 0;
    const learning = { identityFor: () => null, delivered: async () => {
      audits++; assert.equal(state.get(id).last.run, run.id); assert.equal(state.get(id).cursor.since, at(1));
      throw new Error("operation.lock busy");
    } };
    const tick = makeTick({ config: CONFIG, state, gh: fakeGh(), git: fakeGit(), notify: fakeNotify(), log: silentLog, clock,
      ownLogin: "me", runnerFor: () => runner, executionFor: () => runner, readPrd: () => null, learning });
    assert((await tick.tick()).every(r => r.ok));
    assert.equal(audits, 1); assert.equal(state.get(id).last.run, run.id);
    assert.equal(Object.keys(state.get(id).learning_deliveries).length, 1);
    assert.equal(runner.started.length, 0);
  }
});

test("delivery outbox retains older runs and retries lost replies without replacing newer advice", async () => {
  let entry = {}, calls = 0, fail = true;
  const managed = key => ({ learning: { repo, key, rules: [] } });
  for (const runId of ["run-old", "run-new"]) entry = { ...entry, last: { run: runId }, ...learningDeliveryPatch(entry, managed(runId), { id: runId }) };
  const ctx = { state: { get: () => entry, update: (_id, patch) => { if (fail) { fail = false; throw new Error("registry write failed after audit commit"); } entry = { ...entry, ...patch(entry) }; } },
    learning: { delivered: async (_repo, key, runId) => { calls++; return { key, runId, delivered: true }; } } };
  await learningDelivered(ctx, "task");
  assert.equal(Object.keys(entry.learning_deliveries).length, 2);
  assert.equal(entry.learning.key, "run-new");
  await learningDelivered(ctx, "task");
  assert.equal(calls, 3); assert.deepEqual(entry.learning_deliveries, {});
  assert.equal(entry.learning.key, "run-new"); assert.equal(entry.learning.runId, "run-new");
  assert.deepEqual(learningDeliveryPatch(entry, managed("unknown"), { id: "pending", execution: { acceptance: "unknown" } }), {});
});


test("known task and inline event paths reach shared scoped context selection", async t => {
  const { state, id, home } = seededState({ sources: ["packages/api/schema.json"] }); t.after(() => rmSync(home, { recursive: true, force: true }));
  const clock = makeClock(), runner = fakeRunner(clock), seen = [];
  const learning = { identityFor: () => repo, resolveRepo: async () => repo, mode: () => "apply", observe: async () => {},
    context: async (_repo, options) => { seen.push(options); return { key: "d".repeat(64), section: "Scoped advice", rules: [], paths: options.paths }; }, delivered: async (_repo, key, runId) => ({ key, runId, paths: seen.at(-1).paths }) };
  const gh = fakeGh({ inline: [{ ...inline({ id: 9, by: "me", at: at(1), body: "Validate input" }), path: "packages/api/input.mjs" }] });
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => null, credential: fakeCredential(), identity: fakeIdentity(), learning });
  assert((await tick.tick()).every(r => r.ok));
  assert(seen[0].paths.includes("packages/api/input.mjs")); assert(seen[0].paths.includes("packages/api/schema.json"));
  assert.deepEqual(state.get(id).learning.paths, seen[0].paths);
  await learningInput({ learning }, id, state.get(id), { ...input, paths: ["../escape", "/foreign", "packages/api/input.mjs"] });
  assert(!seen.at(-1).paths.includes("../escape")); assert(!seen.at(-1).paths.includes("/foreign"));
  assert.deepEqual(seen.at(-1).paths, [...new Set(seen.at(-1).paths)].sort());
});
