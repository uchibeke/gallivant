import { test } from "node:test";
import assert from "node:assert/strict";
import { taskPresentation, presentationDetail } from "../lib/tracker/presentation.mjs";
import { providerPresentation } from "../lib/tracker/provider_presentation.mjs";
import { instant, attemptPresentation } from "../lib/tracker/presentation_time.mjs";
import { taskWindow } from "../lib/tracker/presentation_html.mjs";
import { dashboard, runPage } from "../lib/tracker/pages.mjs";
import { taskView, modelSummary, taskListSummary } from "../lib/task_delivery_view.mjs";
import { completionView } from "../lib/task_completion.mjs";
import { controlAvailability } from "../lib/control_contract.mjs";
import { model, render } from "../lib/commands/status.mjs";
import { accessProbeFailure } from "../lib/execution_io.mjs";
import { CONFIG, tempHome, silentLog } from "./helpers.mjs";
import { rmSync } from "node:fs";

const NOW = "2026-09-24T14:30:00.000Z", START = "2026-09-24T14:00:00.000Z";
const base = () => ({ state: "pr-open", repo: "acme/widget", base: "main", pr: 12, iteration: 2,
  harness: "codex", session: "session", created_at: START, cursor: { fixed_sha: "head" },
  reviewHead: "head", reviewBinding: "binding", task: { completion: { version: 1, target: "delivery_ready" } } });
const qualified = () => ({ ...base(), state: "ready-for-human", completionEvidence: { delivery: {
  repository: "acme/widget", pr: 12, head: "head", base: "main", gate: { allow: true } } } });
const running = { id: "attempt", running: true, startedAt: START, exit: null };
const project = input => taskPresentation({ now: NOW, maxIterations: 5, ...input });

test("evidenced lifecycle phases keep actor, blocker and next action separate", () => {
  const observations = [
    [{ task: { status: "preparing" } }, "planning", "planner"],
    [{ task: { status: "validating" } }, "verifying", "planner"],
    [{ entry: { ...base(), state: "running", last: { run: "attempt", exit: null } }, run: running }, "implementing", "agent"],
    [{ entry: { ...base(), reviewPolicy: { version: 1, mode: "first-party-required" }, firstPartyReview: { binding: "binding", status: "running", pieces: [] } } }, "independent_review", "independent-reviewer"],
    [{ entry: { ...base(), reviewObservation: { head: "head", binding: "binding", external: "waiting", checks: { settled: true } } } }, "remote_review", "external-reviewer"],
    [{ entry: { ...base(), reviewObservation: { head: "head", binding: "binding", checks: { settled: false, count: 1 } } } }, "ci_wait", "ci"],
    [{ entry: { ...base(), state: "needs-human", network_retry: { phase: "waiting", next_at: NOW } } }, "retry_wait", "coordinator"],
    [{ entry: { ...base(), state: "needs-human", reason: "checks-red" } }, "operator_attention", "operator"],
    [{ entry: qualified() }, "delivery_ready", "operator"],
    [{ entry: { ...qualified(), state: "done", completionEvidence: { integration: { qualified: true } } } }, "integrated", "none"],
    [{ entry: { ...base(), state: "done", completionEvidence: { terminal: { state: "CLOSED" } } } }, "closed", "operator"],
    [{ entry: { ...base(), last: { event: "planning then verifying; review clear" } } }, "unknown", "unknown"],
  ];
  for (const [input, phase, actor] of observations) {
    const p = project(input);
    assert.equal(p.phase.id, phase); assert.equal(p.actor, actor); assert.equal(typeof p.nextAction, "string");
    assert.ok(Object.hasOwn(p, "blocker")); assert.equal(p.readiness.mergeAuthorized, false);
  }
});

test("completion projection never upgrades exit, skipped receipts, stale heads, closed or missing owner evidence", () => {
  const cases = [
    { ...base(), state: "done", last: { run: "attempt", exit: 0 } },
    { ...base(), state: "ready-for-human", gate_skipped: "no PRD snapshot" },
    { ...qualified(), cursor: { fixed_sha: "new-head" } },
    { ...qualified(), completionEvidence: { terminal: { state: "CLOSED" } } },
    { ...qualified(), task: { completion: { target: "delivery_ready" }, ownerDelivery: { malformed: true } } },
  ];
  for (const entry of cases) {
    const p = project({ entry, run: { ...running, running: false, exit: 0 } });
    assert.ok(!["delivery_ready", "integrated"].includes(p.phase.id));
    try { assert.equal(p.readiness.status, completionView(null, entry).status); } catch { assert.equal(p.readiness.status, "unknown"); }
  }
  const stale = project({ entry: { ...base(), reviewObservation: { head: "old", binding: "old", checks: { settled: true }, external: "clear" },
    reviewPolicy: { version: 1, mode: "first-party-required" }, firstPartyReview: { binding: "old", status: "completed", result: { verdict: "clear" } } } });
  assert.equal(stale.review.status, "unknown"); assert.equal(stale.phase.id, "unknown");
});

test("provider observations distinguish pending, unchecked, quota, dispatch and credentials without inferring access", () => {
  const cases = [
    [{ pending: true, ok: false }, {}, "pending"],
    [{ ok: true, scope: "local-sign-in", apiConnectivity: "unchecked" }, {}, "api-unchecked"],
    [{ ok: false, error: { providerCode: "insufficient_quota" } }, {}, "quota-exhausted"],
    [{ ok: true }, { available: false }, "unsupported"],
    [{ ok: false, error: { code: "AGENTS_AUTH" } }, {}, "credentials-unavailable"],
    [{ ok: true, scope: "local-binary" }, {}, "api-unchecked"],
    [{ ok: true, detail: "a model is visible" }, {}, "observed"],
  ];
  for (const [observation, capability, status] of cases) {
    const p = providerPresentation(observation, capability);
    assert.equal(p.status, status); assert.equal(p.inference, "unknown");
  }
  const probe = accessProbeFailure({ code: "AGENTS_THROTTLED", providerCode: "insufficient_quota", message: "private payload" }, null, "AGENTS_ACCESS");
  assert.equal(providerPresentation(probe).status, "quota-exhausted");
  assert.doesNotMatch(JSON.stringify(providerPresentation(probe)), /private payload/);
});

test("poll observations advance freshness without resetting meaningful activity or since", () => {
  const entry = { ...base(), last: { at: START }, updated_at: START };
  const before = project({ entry });
  const after = project({ entry: { ...entry, updated_at: NOW, reviewObservation: { head: "head", binding: "binding", observedAt: NOW } } });
  assert.deepEqual(after.activity, before.activity); assert.equal(after.since, before.since);
  assert.notEqual(after.freshness.observedAt, before.freshness.observedAt);
  for (const value of [null, undefined, "", "broken", false, {}, []]) assert.equal(instant(value), null);
  assert.equal(project({ entry: { updated_at: "bad", created_at: null } }).since, null);
});

test("checks keep absent, explicitly unconfigured, pending and passed observations distinct", () => {
  assert.equal(project({ entry: base() }).checks.status, "unknown");
  assert.equal(project({ entry: { ...base(), reviewObservation: { head: "head", binding: "binding", checks: { settled: true } } } }).checks.status, "unknown");
  for (const [count, settled, zeroChecks, expected] of [[0, false, false, "not-observed"], [0, true, true, "not-configured"], [1, false, false, "pending"], [1, true, false, "passed"]]) {
    const entry = { ...base(), reviewPolicy: { version: 1, zeroChecks }, reviewObservation: { head: "head", binding: "binding", checks: { count, settled } } };
    assert.equal(project({ entry }).checks.status, expected);
    assert.equal(project({ entry: { ...entry, cursor: { fixed_sha: "new" } } }).checks.status, "unknown");
  }
});

test("network retry explanations use validated facts and normalize source timestamps", () => {
  const entry = { ...base(), network_retry: { phase: "waiting", attempts: 1, first_at: START, run: "attempt", code: "ENOTFOUND",
    next_at: "Sep 24 2026 14:30:00 GMT (private-provider-payload)" } };
  const p = project({ entry });
  assert.match(p.nextAction, /waiting for API connectivity \(ENOTFOUND\); 1\/3 retries used/);
  assert.ok(p.nextAction.endsWith(NOW));
  assert.doesNotMatch(JSON.stringify(p), /private-provider-payload/);
  assert.equal(project({ entry: { ...entry, network_retry: { ...entry.network_retry, code: "private-provider-payload" } } }).nextAction,
    "Wait for the scheduled retry; inspect its saved failure if it persists.");
});

test("attempt durations and round accounting never borrow from a different attempt", () => {
  const entry = { ...base(), last: { run: "attempt", exit: null } };
  const active = attemptPresentation(running, { entry, maxIterations: 5, now: NOW });
  assert.deepEqual(active.duration, { kind: "elapsed", ms: 1800000, source: "run.startedAt/endedAt" });
  assert.equal(active.rounds.used, 2);
  const historic = attemptPresentation({ ...running, id: "older", running: false, endedAt: NOW, exit: 0 }, { entry, maxIterations: 5, now: "2027-01-01" });
  assert.equal(historic.duration.kind, "ended"); assert.equal(historic.duration.ms, 1800000); assert.equal(historic.rounds.used, null);
  for (const run of [{}, { startedAt: "bad", endedAt: NOW }, { startedAt: NOW, endedAt: START }, { ...running, endedAt: "bad" }, { ...running, running: false }]) assert.equal(attemptPresentation(run, { now: NOW }).duration.ms, null);
  assert.doesNotMatch(JSON.stringify(active), /percent|token|cost|eta/i);
});

test("host and execution capabilities use the same phase and readiness selectors", () => {
  for (const repo of ["acme/widget", "bitbucket.org/acme/widget"]) for (const provider of ["codex", "claude", "openai-agents", "codex-cloud"]) {
    const entry = { ...base(), repo, harness: provider, state: "needs-human", reason: "checks-red" };
    const p = project({ entry, capabilities: { available: provider !== "codex-cloud", controls: { interrupt: provider === "codex" } } });
    assert.equal(p.phase.id, "operator_attention"); assert.equal(p.readiness.status, completionView(null, entry).status);
    assert.equal(p.provider.status, provider === "codex-cloud" ? "unsupported" : "unknown");
  }
});

test("ended and uncertain runs expose ownership without authorizing another writer", () => {
  for (const run of [{ ...running, running: false }, { ...running, execution: { providerState: "status-unknown" } },
    { ...running, execution: { providerState: "cancellation-requested", cancellation: { status: "pending" } } }]) {
    const entry = { ...qualified(), last: { run: "attempt", exit: null } };
    const p = project({ entry, run });
    assert.equal(p.phase.id, "reconciling");
    for (const key of ["resume", "message", "interrupt"]) assert.equal(p.controls[key], false);
    assert.equal(p.readiness.status, "pending");
    assert.equal(controlAvailability(entry, run, {}).resume, false);
    assert.equal(taskView({ completion: completionView(null, entry, null, run) }, { entry, run }).controls.resume, false);
  }
});

test("operator stops retain attention independently of unresolved ownership and automatic waits", () => {
  for (const run of [null, { ...running, id: "different-attempt" }, { ...running, running: false, exit: 1 },
    { ...running, execution: { providerState: "status-unknown" } }]) {
    for (const reason of ["run-stop-unverified", "dispatch-refused", null]) {
      const entry = { ...base(), state: "needs-human", reason, last: { run: "attempt", exit: null, at: START } };
      const p = project({ entry, run });
      assert.equal(p.phase.id, "reconciling");
      assert.equal(p.attention.group, "attention");
      assert.equal(p.attention.actor, "operator");
      assert.equal(p.attention.source, "entry.reason/task.status");
      assert.match(p.nextAction, /reconcile/i);
      assert.doesNotMatch(p.attention.explanation, /Waiting on automatic/);
      if (reason === "run-stop-unverified") assert.equal(p.attention.title, "Execution stop unconfirmed");
      for (const key of ["resume", "message", "interrupt"]) {
        assert.equal(p.controls[key], false);
        assert.equal(controlAvailability(entry, run, {})[key], false);
      }
      assert.deepEqual(taskView({ repo: entry.repo }, { entry, run, now: NOW, maxIterations: 5 }).presentation.attention, p.attention);
    }
  }
  // A task-level stop uses the same projection even without a registry stop.
  const entry = { ...base(), last: { run: "attempt", exit: null } };
  for (const status of ["blocked", "needs-input"]) assert.equal(project({ entry, task: { status } }).attention.group, "attention");
  // An unresolved run alone, or an actual retry allowance, remains a wait.
  assert.equal(project({ entry }).attention.group, "waiting");
  for (const retry of [{ network_retry: { phase: "waiting", attempts: 1, first_at: START, run: "attempt", code: "ENOTFOUND", next_at: NOW } },
    { retry: { op: "ready-label-write", count: 1 } }]) {
    const stopped = { ...entry, state: "needs-human", reason: "provider-network", ...retry };
    assert.equal(project({ entry: stopped }).attention.group, "waiting");
    assert.equal(project({ entry: { ...stopped, last: { run: "attempt", exit: 1 } } }).phase.id, "retry_wait");
    assert.equal(project({ entry: { ...stopped, dispatch_stopped: true } }).attention.group, "attention");
  }
});

test("active work takes precedence over older check waits and supplied completion cannot upgrade current evidence", () => {
  const entry = { ...base(), last: { run: "attempt", exit: null }, reviewObservation: { head: "head", binding: "binding", checks: { settled: false, count: 1 } } };
  assert.equal(project({ entry, run: running }).phase.id, "implementing");
  const p = project({ entry, run: running, completion: { status: "fulfilled", target: "delivery_ready" } });
  assert.equal(p.readiness.status, "pending");
  const unowned = { ...running, execution: { transport: "remote", providerState: "running", acceptance: "unknown" } };
  assert.equal(project({ entry, run: unowned }).ownership, "uncertain");
  assert.equal(project({ entry, run: unowned }).controls.resume, false);
  const malformed = { ...qualified(), task: { ownerDelivery: { malformed: true } } };
  assert.equal(project({ entry: malformed, completion: { status: "fulfilled", target: "delivery_ready" } }).readiness.status, "unknown");
});

test("overview, detail, CLI and task summaries share facts and retain API fields", t => {
  const home = tempHome(); t.after(() => rmSync(home, { recursive: true, force: true }));
  const entry = { ...base(), state: "needs-human", reason: "checks-red" }, id = "acme/widget/task";
  const ctx = { home, state: { entries: () => [[id, entry]], get: () => entry, chains: () => [] }, config: CONFIG, clock: { now: () => Date.parse(NOW) }, log: silentLog, runnerFor: () => ({ current: () => null }) };
  const m = model(ctx), row = m.needs_you[0], p = row.presentation;
  const view = taskView({ repo: entry.repo, completion: completionView(null, entry) }, { entry, maxIterations: CONFIG.max_iterations, now: NOW, controls: controlAvailability(entry, null, {}) });
  assert.deepEqual(view.presentation, p);
  assert.deepEqual(modelSummary(view).presentation, p); assert.deepEqual(taskListSummary(view).presentation, p);
  for (const key of ["id", "handle", "label", "detail", "state", "reason", "round", "since", "base", "run"]) assert.ok(Object.hasOwn(row, key), key);
  const html = dashboard(m), detail = runPage({ id, entry, handle: id, run: null, model: m, maxIterations: 5 });
  assert.ok(render(m).includes(presentationDetail(p)));
  for (const value of [p.phase.label, p.reason, p.readiness.status, p.delivery.target, p.activity.at, p.nextAction]) {
    assert.ok(html.includes(value), value); assert.ok(detail.includes(value), value);
  }
});

test("1000 frozen tasks project purely with bounded data and at most 25 overview rows", () => {
  const entry = base();
  const deepFreeze = object => { Object.freeze(object); Object.values(object).filter(v => v && typeof v === "object").forEach(deepFreeze); return object; };
  deepFreeze(entry); const before = JSON.stringify(entry);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `task-${i}`, handle: `task-${i}`, section: "running", presentation: project({ entry }) }));
  assert.equal(JSON.stringify(entry), before);
  assert.ok(rows.every(row => JSON.stringify(row.presentation).length < 4000));
  const m = { needs_you: [], running: rows, done: [] }, html = dashboard(m);
  assert.equal((html.match(/data-task-id=/g) || []).length, 25);
  assert.equal((html.match(/class="row"/g) || []).length, 0);
  assert.equal(taskWindow(m, 100).model.running[0].id, "task-100");
  assert.ok(html.length < 300000);
});

test("malformed and legacy observations stay usable with bounded diagnostics and no provider prose", () => {
  const privateText = '<script>secret-provider-payload</script>';
  const entry = { ...base(), reason: privateText, firstPartyReview: { status: "running", pieces: {}, retryAt: "bad", error: privateText }, reviewPolicy: { version: 1, mode: "first-party-required" }, updated_at: {}, completionEvidence: { delivery: privateText } };
  const p = project({ entry, provider: { ok: false, detail: privateText, response: privateText } });
  assert.equal(p.phase.id, "unknown"); assert.ok(p.diagnostics.length <= 3);
  assert.doesNotMatch(JSON.stringify(p), /secret-provider-payload/);
  const m = { needs_you: [], running: [{ id: "task", handle: "task", presentation: p }], done: [] };
  const html = runPage({ id: "task", entry, handle: "task", run: null, model: m, maxIterations: 5 });
  assert.doesNotMatch(html, /secret-provider-payload/);
  assert.match(html, /Phase unknown/);
});

test("attention remains visible across active ownership, failed controls, review disposition and qualified readiness", () => {
  const entry = { ...base(), last: { run: "attempt", exit: null } };
  for (const run of [running, { ...running, execution: { providerState: "status-unknown" } }]) {
    const p = project({ entry, run, divergence: { reason: "prd-changed" } });
    assert.equal(p.attention.group, "attention"); assert.equal(p.attention.title, "Approved brief changed");
    assert.match(p.attention.nextAction, /approved copy/);
  }
  const failed = project({ entry: { ...entry, control: { status: "failed", action: "message", message: "private detail" } }, run: running });
  assert.equal(failed.attention.group, "attention"); assert.equal(failed.attention.title, "Control request failed");
  assert.doesNotMatch(JSON.stringify(failed), /private detail/);
  assert.equal(project({ entry: qualified() }).attention.group, "ready");
  const integrated = project({ entry: { ...qualified(), state: "done", control: { status: "failed" }, completionEvidence: { integration: { qualified: true } } } });
  assert.equal(integrated.attention.group, "ended", "historical control failures do not reopen an integrated delivery");
  assert.equal(project({ entry: { ...base(), network_retry: { phase: "waiting" } } }).attention.group, "waiting");
  const review = { ...base(), reviewPolicy: { version: 1, mode: "first-party-required" }, firstPartyReview: { binding: "binding", status: "completed", result: { verdict: "findings" } } };
  assert.equal(project({ entry: review }).attention.group, "attention");
  assert.equal(project({ entry: { ...review, reviewHead: "old" } }).review.verdict, "unknown");
  assert.notEqual(project({ entry: { ...review, reviewHead: "old" } }).attention.group, "attention");
  const dispatched = project({ entry: { ...review, last: entry.last, firstPartyReview: { ...review.firstPartyReview, disposition: { status: "dispatched" } } }, run: running });
  assert.equal(dispatched.attention.group, "progressing");
  for (const status of ["pending", "dispatch-intent"]) {
    const waiting = project({ entry: { ...review, firstPartyReview: { ...review.firstPartyReview, disposition: { status } } } });
    assert.equal(waiting.attention.group, "waiting"); assert.equal(waiting.attention.actor, "coordinator");
  }
});
