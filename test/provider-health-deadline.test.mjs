import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProviderHealth, coordinatorHealthLimits } from "../lib/provider_health.mjs";
import { EXECUTION_LIMITS } from "../lib/execution_io.mjs";
import { tempHome, makeClock } from "./helpers.mjs";

const flush = () => new Promise(resolve => setImmediate(resolve));

test("coordinator readiness remains usable during a slow tick and still expires", async () => {
  const home=tempHome(), clock=makeClock(), limits=coordinatorHealthLimits(undefined);
  const health=makeProviderHealth({home,clock,limits,probe:async()=>({ok:true,detail:"signed in"})});
  await health.refresh([["codex","operator"]]);clock.advance(0.5);
  assert.equal(health.get("codex").ok,true,"a 30-second coordinator tick does not invalidate a fresh probe");
  clock.advance(0.51);assert.equal(health.get("codex").ok,false,"expired or pending probes cannot authorize dispatch");
  assert.equal(coordinatorHealthLimits({progressMs:5000,deadlineMs:1234}).progressMs,5000,"explicit operator limits remain authoritative");
  assert.equal(coordinatorHealthLimits({deadlineMs:1234}).deadlineMs,1234);
});

test("readiness permits cold startup beyond the former two-second budget while fencing dispatch", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(), clock = makeClock(); let finish, signal;
  const health = makeProviderHealth({ home, clock, probe: async (_provider, _account, current) => {
    signal = current; return new Promise(resolve => { finish = resolve; });
  } });
  const pending = health.refresh([["codex", "operator"]]); await flush();
  t.mock.timers.tick(3000); await flush();
  assert.equal(signal.aborted, false, "CLI startup does not inherit the former two-second deadline");
  assert.equal(health.get("codex").ok, false, "pending readiness cannot authorize dispatch");
  finish({ ok: true, detail: "fixture signed in" }); await pending;
  assert.equal(health.get("codex").ok, true);
});

for (const deadlineMs of [undefined, 50]) test(`readiness deadline ${deadlineMs ?? "default"} aborts, backs off, and fences late success`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(), clock = makeClock(); let finish, signal, calls = 0;
  const options = { home, clock, jitter: () => 0, ...(deadlineMs === undefined ? {} : { limits: { deadlineMs } }),
    probe: async (_provider, _account, current) => { calls++; signal = current; return new Promise(resolve => { finish = resolve; }); } };
  const health = makeProviderHealth(options);
  const pending = health.refresh([["codex", "operator"]]); await flush();
  const bound = deadlineMs ?? EXECUTION_LIMITS.deadlineMs;
  t.mock.timers.tick(bound - 1); await flush(); assert.equal(signal.aborted, false);
  t.mock.timers.tick(1); await pending;
  assert.equal(signal.aborted, true);
  const failed = health.get("codex");
  assert.equal(failed.ok, false); assert.equal(failed.detail, "EXECUTION_DEADLINE");
  assert.equal(failed.nextAttemptAt, clock.now() + 20_000);
  finish({ ok: true }); await flush(); assert.equal(health.get("codex").ok, false);
  const reopened = makeProviderHealth(options); await reopened.refresh([["codex", "operator"]]);
  assert.equal(calls, 1, "restart preserves backoff instead of retrying immediately");
  assert.equal(reopened.get("codex").ok, false);
});
