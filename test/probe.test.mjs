import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkGh, checkHarness, checkSignIn, checkVersion, probeAll, probeFix, allOk } from "../lib/probe.mjs";
import { up } from "../lib/commands/up.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { makeGh } from "../lib/gh.mjs";
import { model } from "../lib/commands/status.mjs";
import { readJson, writeJsonAtomic } from "../lib/fs.mjs";
import { CONFIG, T0, tempHome, harnessBin, fakeGh, fakeGit, fakeNotify, makeClock, silentLog } from "./helpers.mjs";

test("harness readiness requires a supported, readable version before checking login", async () => {
  for (const options of [{ version: "0.155.1" }, { version: "unrecognised" }, { versionExit: 1 }]) {
    const home = tempHome();
    const config = { harness: { codex: { bin: harnessBin(home, "codex", options) } } };
    const result = await checkHarness("codex", config);
    assert.equal(result.ok, false);
    assert.match(probeFix("codex", result), /install codex 0\.158\.0 or newer/);
    assert.doesNotMatch(probeFix("codex", result), /codex login/);
    assert.deepEqual(readFileSync(join(home, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"]]);
  }
});

test("supported harnesses pass only when signed in, and authentication failures keep the login remedy", async () => {
  for (const signedIn of [true, false]) {
    const home = tempHome();
    const config = { harness: { codex: { bin: harnessBin(home, "codex", { signedIn }) } } };
    const probes = await probeAll({ config, gh: fakeGh() });
    assert.equal(allOk(probes), signedIn);
    assert.equal(probes.codex.ok, signedIn);
    if (!signedIn) assert.equal(probeFix("codex", probes.codex), "codex login");
    assert.deepEqual(readFileSync(join(home, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"], ["login", "status"]]);
  }
});

test("each local harness reports only the strength of its actual readiness probe", async () => {
  for (const [harness, scope, wording] of [["claude", "local-sign-in", "signed-in"], ["codex", "local-sign-in", "signed-in"], ["opencode", "local-credentials", "credentials present"], ["gemini", "local-binary", "installed"], ["goose", "local-binary", "installed"]]) {
    const home = tempHome();
    const config = { harness: { [harness]: { bin: harnessBin(home, harness, harness === "opencode" ? { signInOutput: "1 credential" } : {}) } } };
    const probe = (await probeAll({ config, gh: fakeGh() }))[harness];
    assert.equal(probe.ok, true, harness);
    assert.equal(probe.scope, scope, harness);
    assert.equal(probe.apiConnectivity, "unchecked", harness);
    assert.ok(probe.detail.includes(wording), harness);
    if (scope === "local-binary") assert.doesNotMatch(probe.detail, /signed-in/);
  }
});

test("daemon fences an old Codex account while GitHub review continues", async () => {
  const home = tempHome();
  const state = makeState(home);
  state.put("acme/widget/probe", newEntry({ repo: "acme/widget", pr: 1, branch: "gallivant/probe", worktree: "/tmp/unused-probe", harness: "codex", state: STATES.prOpen, nowIso: T0 }));
  let runsRead = 0;
  const notify = fakeNotify();
  // This case asserts version refusal and independent review progress, not
  // subprocess scheduling under full-suite load. Match the standalone native
  // probe budget; deterministic bounded-deadline/outage cases live in the
  // execution-backends suite. Readiness has its own bounded startup budget.
  await up({
    home, state, config: { ...CONFIG, execution: { deadlineMs: 20_000 }, repos: [], harness: { codex: { bin: harnessBin(home, "codex", { version: "0.155.1" }) } } },
    gh: fakeGh({ pr: { state: "MERGED" } }), log: silentLog, notify,
    runnerFor: () => { runsRead++; return { current: () => null, start: () => { throw new Error("dispatch must not be reached"); } }; },
  }, { once: true });
  const health = JSON.parse(readFileSync(join(home, "daemon.json"), "utf8"));
  assert.equal(health.probes.codex.ok, false);
  assert.equal(health.probes.gh.ok, true);
  assert.match(health.probes.codex.detail, /0\.155\.1 is older than 0\.158\.0/);
  assert.match(health.probes.codex.fix, /install codex/);
  assert.ok(runsRead > 0);
  assert.equal(state.get("acme/widget/probe").state, STATES.done);
  assert.ok(notify.sent.some(n => JSON.stringify(n).includes("install codex")));
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function daemonFixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const home = tempHome(), clock = makeClock(), state = makeState(home), gh = fakeGh(), notify = fakeNotify();
  const ctx = { home, clock, state, gh, notify, log: { ...silentLog, latest: () => null }, git: fakeGit(),
    config: { ...CONFIG, repos: [], execution: { deadlineMs: 10, progressMs: 10_000 }, harness: { "openai-agents": { account: "blocked" } } } };
  let progress = 0;
  ctx.executionFor = () => ({ current: () => null, reconcile: async () => { progress++; } });
  state.put("acme/widget/progress", newEntry({ repo: "acme/widget", harness: "openai-agents", state: STATES.done, nowIso: T0 }));
  const boot = () => {
    const before = new Set(process.listeners("exit")), work = up(ctx);
    const cleanup = process.listeners("exit").find(listener => !before.has(listener));
    t.after(() => cleanup?.());
    return work;
  };
  const advance = async ms => { clock.advance(ms / 60_000); t.mock.timers.tick(ms); await flush(); };
  return { home, ctx, gh, notify, clock, boot, advance, progress: () => progress, health: () => readJson(join(home, "daemon.json")) };
}

test("runtime GitHub authentication loss is visible with its remedy and recovers independently of providers", async t => {
  const f = daemonFixture(t); let calls = 0, expired = false;
  f.gh.user = async () => { calls++; if (expired) throw new Error("GitHub credentials expired: Bearer fixture-secret\nprivate detail"); return "me"; };
  await f.boot();
  assert.equal(calls, 2); assert.equal(f.health().probes.gh.ok, true); assert.equal(f.health().probes["openai-agents"].ok, false);
  expired = true;
  for (let i = 0; i < 11; i++) await f.advance(10_000);
  assert.equal(calls, 2, "GitHub health keeps the review cadence rather than the progress cadence");
  await f.advance(10_000);
  assert.equal(calls, 3); assert.equal(f.health().probes.gh.ok, false);
  assert.equal(f.health().probes.gh.detail, "GitHub credentials expired: Bearer [redacted]");
  assert.ok(f.notify.sent.some(n => n[0] === "error" && n[1] === "gh not ready" && /gh auth login.*github_token_file/.test(n[2])));
  assert.equal(model(f.ctx).daemon.probes.gh.ok, false);
  const failure = f.health().probes.gh;
  const next = f.health().probes.gh.nextAttemptAt;
  expired = false;
  await f.advance(10_000); assert.equal(calls, 3, "failure backoff persists between progress ticks");
  await f.advance(next - f.clock.now());
  assert.equal(calls, 4); assert.equal(f.health().probes.gh.ok, true);
  assert.equal(f.health().probes["openai-agents"].ok, false); assert.ok(f.progress() >= 15);
  assert.deepEqual(Object.keys(readJson(join(f.home, "github-health.json")).scopes), ['["gh","me"]']);
  assert.deepEqual(Object.keys(readJson(join(f.home, "provider-health.json")).scopes), ['["openai-agents","blocked"]']);
  const before = calls; model(f.ctx); model(f.ctx); assert.equal(calls, before, "status only reads persisted health");
  const evidence = join(f.home, "scheduler-health-evidence.json");
  writeJsonAtomic(evidence, { kind: "Offline runtime fixture; no live qualification", failure, recovered: f.health().probes.gh,
    provider: f.health().probes["openai-agents"], progress: f.progress(), githubCalls: calls, statusProviderCalls: calls - before,
    files: { daemon: join(f.home, "daemon.json"), github: join(f.home, "github-health.json"), providers: join(f.home, "provider-health.json") } });
  t.diagnostic(`scheduler health evidence: ${evidence}`);
});

test("a slow GitHub health probe aborts at the bound without occupying the progress lane or accepting late success", async t => {
  const f = daemonFixture(t); let calls = 0, signal, finish;
  f.gh.user = async options => {
    if (++calls === 1) return "me";
    signal = options.signal; return new Promise(resolve => { finish = () => resolve("me"); });
  };
  const boot = f.boot(); await flush();
  assert.ok(f.progress() > 0); assert.equal(signal.aborted, false);
  await f.advance(10); await boot;
  assert.equal(signal.aborted, true); assert.equal(f.health().probes.gh.ok, false);
  assert.equal(f.health().probes.gh.detail, "EXECUTION_DEADLINE");
  finish(); await flush(); assert.equal(f.health().probes.gh.ok, false);
  await f.advance(10_000); assert.equal(calls, 2); assert.ok(f.progress() >= 2);
  assert.ok(f.notify.sent.some(n => n[1] === "gh not ready" && /timed out/.test(n[2])));
  assert.ok(f.notify.sent.filter(n => n[1] === "gh not ready").every(n => !/gh auth login/.test(n[2])));
});

test("timeout and pending health never diagnose missing authentication", () => {
  for (const provider of ["gh", "claude", "codex", "openai-agents"]) {
    for (const detail of ["EXECUTION_DEADLINE", "EXECUTION_ABORTED", "provider/account check pending", "provider/account health refresh pending; awaiting the coordinator's next probe", "provider/account health is stale; awaiting the coordinator's next probe"]) {
      assert.doesNotMatch(probeFix(provider, { ok: false, detail }), /login|authenticate|API key/);
    }
  }
  assert.equal(probeFix("codex", { detail: "EXECUTION_DEADLINE", fix: "provider-specific remedy" }), "provider-specific remedy");
});

test("cancelled local readiness is refused without suggesting login or an upgrade", async () => {
  const home = tempHome(), config = { harness: { codex: { bin: harnessBin(home, "codex") } } };
  const controller = new AbortController(); controller.abort();
  for (const probe of [checkVersion, checkSignIn, checkHarness]) {
    const result = await probe("codex", config, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.detail, "EXECUTION_ABORTED");
    assert.match(result.fix, /cancelled/);
    assert.doesNotMatch(result.fix, /login|install codex/);
  }
});

test("failed sign-in diagnostics redact credential-shaped output and preserve the authentication remedy", async () => {
  const home = tempHome(), config = { harness: { codex: { bin: harnessBin(home, "codex", { signedIn: false, signInOutput: "authentication failed: Bearer fixture-secret" }) } } };
  const result = await checkHarness("codex", config);
  assert.equal(result.ok, false);
  assert.equal(result.detail, "authentication failed: Bearer [redacted]");
  assert.equal(result.fix, "codex login");
});

test("direct GitHub timeouts retain their remedy instead of claiming revoked credentials", async () => {
  for (const fields of [{ code: "EXECUTION_DEADLINE" }, { code: "ABORT_ERR" }, { killed: true }, { name: "TimeoutError" }]) {
    const result = await checkGh({ user: async () => { throw Object.assign(new Error("private subprocess output"), fields); } });
    assert.equal(result.ok, false);
    assert.match(result.detail, /^EXECUTION_(DEADLINE|ABORTED)$/);
    assert.doesNotMatch(probeFix("gh", result), /login|revoked/);
    assert.doesNotMatch(JSON.stringify(result), /private subprocess output/);
  }
  const auth = await checkGh({ user: async () => { throw new Error("HTTP 401: Bad credentials"); } });
  assert.equal(auth.detail, "HTTP 401: Bad credentials");
  assert.match(probeFix("gh", auth), /gh auth login/);
});

test("GitHub user probes forward cancellation and refuse a delayed credential reply after abort", async () => {
  const controller = new AbortController(); let resolveCredential, executed = 0;
  const gh = makeGh({ credential: () => new Promise(resolve => { resolveCredential = resolve; }), exec: async () => { executed++; return { stdout: '{"login":"me"}' }; } });
  const checking = checkGh(gh, { signal: controller.signal });
  await Promise.resolve(); controller.abort(); resolveCredential({ token: "private" });
  assert.equal((await checking).ok, false); assert.equal(executed, 0);
  const next = new AbortController(); let options;
  const ready = makeGh({ exec: async (_cmd, _args, opts) => { options = opts; return { stdout: '{"login":"me"}' }; } });
  assert.deepEqual(await checkGh(ready, { signal: next.signal }), { ok: true, detail: "me" });
  assert.equal(options.signal, next.signal);
});
