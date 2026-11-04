import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createReviewService } from '../lib/first_party_review.mjs';
import { reviewCommand } from '../lib/commands/review.mjs';
import { reviewDigest } from '../lib/review_policy.mjs';
import { CONFIG, tempHome, makeClock } from './helpers.mjs';

function fixture() {
  const home = tempHome(), clock = makeClock(), fingerprint = 'f'.repeat(64);
  let current, expected, outcome, submitted = 0, lines = [];
  const operations = new Set(), runnerScopes = new Set();
  const runner = {
    prepare: async input => {
      expected = JSON.parse(input.prompt.split('Return exactly ')[1].slice(0, -1));
      return { receipt: { boundary: 'codex-draft-sandbox-v1' }, spec: {} };
    },
    submit: async input => {
      assert.ok(!operations.has(input.operationId), 'each fresh challenge needs its own durable dispatch identity');
      operations.add(input.operationId);
      return (current = { id: `probe-${++submitted}`, name: input.name, running: true });
    },
    current: () => current, settle: () => current, lines: () => lines,
    outcome: () => outcome, sanitize: value => value,
  };
  const config = { ...CONFIG, reviewer: null, review: { route: 'codex', mode: 'first-party-required', timeout_ms: 180000 } };
  const service = createReviewService({ home, config, executionFor: id => { runnerScopes.add(id); return runner; } }, { fingerprint: () => fingerprint, clock });
  const file = `${home}/reviews/${reviewDigest(`qualification/acme/widget/${fingerprint}`)}.json`;
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  return { service, saved, save: value => writeFileSync(file, JSON.stringify(value)), runnerScopes, get submitted() { return submitted; }, mutate: fn => { current = fn(current); }, setLines: value => { lines = value; }, setDenials: value => { outcome.denials = value; },
    finish: delay => { clock.advance(delay / 60000); current = { ...current, running: false, exit: 0, endedAt: clock.now() }; outcome = { ok: true, finished: true, denials: [], lastMessage: JSON.stringify(expected), cost: null }; } };
}
async function timedOut() {
  const w = fixture();
  await w.service.qualify('acme/widget', { run: true });
  w.finish(181000);
  assert.equal((await w.service.qualify('acme/widget', { run: true })).qualified, false);
  assert.equal(w.saved().jobs.qualification.errorCode, 'REVIEW_TIMEOUT');
  return w;
}

test('explicit qualification retry retains failure and requires a fresh successful challenge', async () => {
  const w = await timedOut(), original = w.saved();
  const running = await w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Repair delayed CLI observation' });
  assert.equal(running.qualified, false); assert.equal(running.status, 'running'); assert.equal(w.submitted, 2);
  const saved = w.saved();
  assert.deepEqual(saved.qualificationHistory[0].jobs, original.jobs);
  assert.equal(saved.qualificationHistory[0].spentReservedUsd, original.spentReservedUsd);
  assert.notEqual(saved.jobs[saved.qualificationKey].evidence.nonce, original.jobs.qualification.evidence.nonce);
  assert.notEqual(saved.jobs[saved.qualificationKey].run, original.jobs.qualification.run);
  assert.equal(w.runnerScopes.size, 2, 'retries use a distinct execution registry, even if the old one was cancelled');
  w.finish(1000);
  const completed = await w.service.qualify('acme/widget', { run: true }); assert.equal(completed.qualified, true, JSON.stringify(completed));
  assert.equal((await w.service.qualify('acme/widget')).run, 'probe-2');
  assert.equal(w.saved().qualificationHistory[0].jobs.qualification.status, 'failed');
});

test('qualification retry needs explicit launch and a reason', async () => {
  const w = await timedOut();
  for (const args of [{ retry: true, reason: 'reason' }, { retry: true, run: true }, { retry: true, run: true, reason: ' ' }]) {
    await assert.rejects(w.service.qualify('acme/widget', args), /requires --run/);
  }
  assert.equal(w.submitted, 1);
});

test('a refused legacy dispatch can recover only with the archived stopped owner', async () => {
  const w = await timedOut(), old = w.saved();
  w.save({ ...old, qualificationHistory: [{ jobs: old.jobs, spentReservedUsd: old.spentReservedUsd }],
    jobs: { qualification: { ...old.jobs.qualification, run: null, errorCode: 'EXECUTION_CONFLICT', error: 'operation identity already owns different input' } } });
  const rejected = w.saved();
  w.mutate(current => ({ ...current, running: true }));
  await assert.rejects(w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Repair refused dispatch' }), /ownership and cessation/);
  assert.deepEqual(w.saved(), rejected);
  w.mutate(current => ({ ...current, running: false }));
  const fresh = await w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Repair refused dispatch' });
  assert.equal(fresh.status, 'running'); assert.equal(w.submitted, 2);
  assert.equal(w.saved().qualificationHistory.length, 2);
  assert.equal(w.saved().qualificationHistory[1].jobs.qualification.errorCode, 'EXECUTION_CONFLICT');
  w.finish(1000);
  assert.equal((await w.service.qualify('acme/widget', { run: true })).qualified, true);
});

test('qualification cannot retry an active or successfully qualified attempt', async () => {
  const w = fixture(); await w.service.qualify('acme/widget', { run: true });
  const args = { run: true, retry: true, reason: 'Operator request' };
  await assert.rejects(w.service.qualify('acme/widget', args), /settled qualification/);
  w.finish(1000); const completed = await w.service.qualify('acme/widget', { run: true }); assert.equal(completed.qualified, true, JSON.stringify(completed));
  await assert.rejects(w.service.qualify('acme/widget', args), /settled qualification/);
  assert.equal(w.submitted, 1);
});

for (const [name, change] of [
  ['active process', current => ({ ...current, running: true })],
  ['different run', current => ({ ...current, id: 'unrelated' })],
  ['missing terminal time', current => ({ ...current, endedAt: null })],
  ['unknown liveness', current => ({ ...current, running: undefined })],
]) test(`qualification retry refuses ${name}`, async () => {
  const w = await timedOut(); w.mutate(change);
  await assert.rejects(w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Operator request' }), /ownership and cessation/);
  assert.equal(w.submitted, 1); assert.equal(w.saved().qualificationHistory, undefined);
});

test('qualification retry retains a recorded tool attempt for security review', async () => {
  const w = await timedOut(); w.setLines([JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } })]);
  await assert.rejects(w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Operator request' }), /ownership and cessation/);
  assert.equal(w.submitted, 1);
});

test('qualification retry retains a recorded denial for security review', async () => {
  const w = await timedOut(); w.setDenials(['sandbox policy denied an operation']);
  await assert.rejects(w.service.qualify('acme/widget', { run: true, retry: true, reason: 'Operator request' }), /ownership and cessation/);
  assert.equal(w.submitted, 1); assert.equal(w.saved().qualificationHistory, undefined);
});

test('qualification --wait reconciles the same attempt and never repeats retry authorization', async () => {
  const calls = [], ctx = { reviewService: { qualify: async (_repo, options) => {
    calls.push(options); return calls.length === 1 ? { qualified: false, status: 'running', run: 'owned' } : { qualified: true, status: 'completed', run: 'owned' };
  } } };
  const result = await reviewCommand(ctx, { action: 'qualify', repo: 'acme/widget', run: true, wait: true, retry: true, reason: 'Operator request' });
  assert.equal(result.qualified, true); assert.equal(calls.length, 2);
  assert.equal(calls[0].retry, true); assert.equal(calls[1].retry, undefined);
  await assert.rejects(reviewCommand(ctx, { action: 'qualify', repo: 'acme/widget', wait: true }), /requires --run/);
});
