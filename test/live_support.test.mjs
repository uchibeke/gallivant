import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { harnessBin } from "./helpers.mjs";
import { BRANCH, NAMED_CASES, TURN_MS, SUITE_MS, STOP_GRACE_MS, auditLiveInvocation, launchLiveTurn, selection, classify, costEvidence, refusalEvidence, openSuiteLedger, sessionIdentity, effectiveModels, testExecution, verifyCheckout, verifyResumeFixture, verifySessionDirectory, verifyStartFixture } from "./live-support.mjs";

test("live launch leaves exhausted or interrupted phases unstarted without spending a retry", () => {
  const now = 1_000_000;
  for (const phase of ["start", "resume"]) for (const attempt of [1, 2]) {
    for (const [remaining, flags] of [[-1, {}], [0, {}], [STOP_GRACE_MS - 1, {}], [STOP_GRACE_MS, {}], [SUITE_MS, { suiteTimedOut: true }], [SUITE_MS, { interrupted: "SIGTERM" }]]) {
      const entry = { id: "goose-meta", cwd: "/unused", turns: phase === "resume" ? [{ phase: "start", status: "passed" }] : [] };
      if (attempt === 2) entry.turns.push({ phase, attempt: 1, status: "failed" });
      const before = structuredClone(entry);
      const report = { ...flags };
      let persisted;
      const launch = launchLiveTurn({ report, entry, phase, attempt, deadline: now + remaining, invocation: 2,
        checkpoint() { persisted = structuredClone({ entry, report }); },
        runner: { start() { assert.fail("an exhausted or interrupted suite must not launch a child"); } },
      }, () => now);
      assert.equal(launch, null);
      assert.deepEqual(entry, before, "no turn or retry reservation may be consumed");
      assert.equal(report.unstartedTurns.length, 1);
      assert.deepEqual(persisted, { entry, report });
      assert.deepEqual(report.unstartedTurns[0], {
        case: entry.id, phase, attempt, invocation: 2, checkedAt: new Date(now).toISOString(),
        reason: flags.interrupted ? "suite interrupted before launch" : "suite has no usable time after reserving termination grace",
      });
    }
  }
});

test("live automatic resume rechecks time spent by the first turn and synchronous preflight", () => {
  let now = 1_000_000;
  const deadline = now + SUITE_MS;
  const calls = [];
  const report = {};
  const entry = { id: "goose-meta", cwd: "/unused", turns: [] };
  const options = { report, entry, attempt: 1, deadline, spec: { cmd: "offline-probe", args: [] },
    checkpoint() {},
    runner: { start(...args) { calls.push(args); return { id: "first" }; } },
  };
  const first = launchLiveTurn({ ...options, phase: "start" }, () => now);
  assert.equal(first.job.id, "first");
  entry.turns.push({ phase: "start", status: "passed", startedAt: first.startedAt });
  // Model work, metadata collection and synchronous preflight can consume the outer loop's remaining time.
  now = deadline - STOP_GRACE_MS;
  assert.equal(launchLiveTurn({ ...options, phase: "resume" }, () => now), null);
  assert.equal(calls.length, 1);
  assert.equal(entry.turns.length, 1);
  assert.equal(entry.turns[0].status, "passed");
  assert.equal(report.unstartedTurns[0].phase, "resume");
});

test("live launch preserves both time caps and persists retries before starting a child", () => {
  const now = 1_000_000;
  for (const [remaining, usable] of [[SUITE_MS, 174_000], [90_000, 84_000], [STOP_GRACE_MS + 1, 1]]) {
    const entry = { id: "goose-meta", cwd: "/unused", turns: [] };
    const source = { revision: "fixed" }, fix = "docs/audit/fix.md", env = { PROBE: "offline" };
    const report = {};
    let persisted;
    const options = { report, entry, phase: "resume", attempt: 2, deadline: now + remaining, fix, source, env,
      checkpoint() { persisted = structuredClone(entry); },
      spec: { cmd: "offline-probe", args: ["resume"] },
      runner: { start(...args) {
        assert.deepEqual(persisted.retry, { phase: "resume", fix, source });
        assert.deepEqual(args, ["resume-2", "offline-probe", ["resume"], { cwd: entry.cwd, env }]);
        return { id: "retry" };
      } },
    };
    const launch = launchLiveTurn(options, () => now);
    assert.equal(launch.job.id, "retry");
    assert.equal(launch.startedAt, new Date(now).toISOString());
    assert.equal(launch.limit, now + usable);
    assert.deepEqual(entry.retry, { phase: "resume", fix, source });
    assert.equal(report.unstartedTurns, undefined);
  }
  const entry = { id: "goose-meta", cwd: "/unused", turns: [] };
  assert.throws(() => launchLiveTurn({ report: {}, entry, phase: "resume", attempt: 2,
    deadline: now + SUITE_MS, spec: { cmd: "offline-probe", args: [] },
    checkpoint() {},
    runner: { start() { throw new Error("child could not start"); } },
  }, () => now), /child could not start/);
  assert.equal(entry.retry.phase, "resume", "a launch exception must not erase a durable reservation");
});

test("live deadline includes retry checkpoint time and releases an unlaunched reservation", () => {
  let now = 1_000_000;
  const deadline = now + SUITE_MS;
  const entry = { id: "goose-meta", cwd: "/unused", turns: [{ phase: "resume", attempt: 1, status: "failed" }] };
  const report = {};
  const saved = [];
  const result = launchLiveTurn({ report, entry, phase: "resume", attempt: 2, deadline,
    checkpoint() {
      saved.push(structuredClone({ entry, report }));
      now = deadline - STOP_GRACE_MS;
    },
    runner: { start() { assert.fail("checkpoint time exhausted the suite budget"); } },
  }, () => now);
  assert.equal(result, null);
  assert.equal(saved.length, 2);
  assert.equal(saved[0].entry.retry.phase, "resume");
  assert.equal(saved[1].entry.retry, undefined);
  assert.equal(saved[1].entry.turns.length, 1);
  assert.equal(saved[1].report.unstartedTurns[0].phase, "resume");
});

test("live retry and append recheck current binaries while preserving earlier version evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gallivant-live-versions-"));
  try {
    const config = { harness: Object.fromEntries(["gemini", "opencode", "goose"].map(h => [h, { bin: harnessBin(dir, h) }])) };
    const report = { cases: [{ id: "goose-meta", turns: [{ invocation: 0, status: "failed" }] }] };
    const first = await auditLiveInvocation(report, config, { mode: "start", selected: ["goose-meta"], source: { revision: "first" } });
    const original = structuredClone(report);
    const replacement = join(dir, "replacement");
    mkdirSync(replacement);
    config.harness.goose.bin = harnessBin(replacement, "goose", { version: "2.0.0" });
    const retried = await auditLiveInvocation(report, config, { mode: "retry", selected: ["goose-meta"], source: { revision: "fixed" } });
    assert.deepEqual(retried.versions, { goose: { ok: true, detail: "2.0.0" } });
    assert.deepEqual(retried.binaries, { goose: config.harness.goose.bin });
    assert.notEqual(retried.binaries.goose, first.binaries.goose);
    assert.equal(retried.source.revision, "fixed");
    assert.ok(Number.isFinite(Date.parse(retried.checkedAt)));
    // An upgrade at the same configured path must be detected too, once per selected harness.
    harnessBin(dir, "opencode", { version: "2.0.0" });
    const appended = await auditLiveInvocation(report, config, { mode: "append", selected: ["opencode-console-meta", "opencode-console-xai"], source: { revision: "fixed" } });
    assert.deepEqual(appended.versions, { opencode: { ok: true, detail: "2.0.0" } });
    assert.deepEqual(appended.binaries, { opencode: config.harness.opencode.bin });
    assert.deepEqual(report.invocations, [first, retried, appended]);
    assert.deepEqual(report.invocations[0], original.invocations[0]);
    assert.deepEqual(report.versions, original.versions);
    assert.deepEqual(report.binaries, original.binaries);
    assert.deepEqual(report.cases, original.cases);
    const calls = (root, harness) => readFileSync(join(root, `${harness}-calls.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls(dir, "goose"), [["--version"]]);
    assert.deepEqual(calls(dir, "gemini"), [["--version"]]);
    assert.deepEqual(calls(dir, "opencode"), [["--version"], ["--version"]]);
    assert.deepEqual(calls(replacement, "goose"), [["--version"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live resumed invocation refuses stale success for downgraded unreadable or missing binaries", async () => {
  for (const mode of ["retry", "append"]) {
    for (const options of [{ version: "0.1.0" }, { version: "unrecognised" }, { versionExit: 1 }, null]) {
      const dir = mkdtempSync(join(tmpdir(), "gallivant-live-version-failure-"));
      try {
        const bin = options ? harnessBin(dir, "goose", options) : join(dir, "missing-goose");
        const report = { versions: { goose: { ok: true, detail: "1.50.1" } }, binaries: { goose: "/previous/goose" }, cases: [] };
        const original = structuredClone(report);
        const audit = await auditLiveInvocation(report, { harness: { goose: { bin } } }, { mode, selected: ["goose-meta"], source: { revision: "fixed" } });
        assert.equal(audit.versions.goose.ok, false);
        assert.match(audit.versions.goose.detail, /older than|could not read version/);
        assert.equal(audit.binaries.goose, bin);
        assert.equal(report.invocations[0], audit);
        assert.deepEqual(report.versions, original.versions);
        assert.deepEqual(report.binaries, original.binaries);
        if (options) assert.deepEqual(readFileSync(join(dir, "goose-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"]]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test("live suite ledger rejection preserves supplied directory permissions and contents", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-ledger-rejection-")));
  const ledger = { privateEvidence: root, startedAt: "2026-10-01T00:00:00.000Z", turnLimitMs: TURN_MS, suiteLimitMs: SUITE_MS, cases: [] };
  try {
    chmodSync(root, 0o755);
    writeFileSync(join(root, "unrelated.txt"), "Keep this shared directory unchanged.\n");
    const reject = () => {
      const files = readdirSync(root).map(name => [name, readFileSync(join(root, name), "utf8")]);
      assert.throws(() => openSuiteLedger(root), /suite ledger/);
      assert.equal(statSync(root).mode & 0o777, 0o755);
      assert.deepEqual(readdirSync(root).map(name => [name, readFileSync(join(root, name), "utf8")]), files);
    };
    reject(); // No ledger: the reported mistyped-directory case.
    for (const contents of ["{broken", "null", "{}",
      JSON.stringify({ ...ledger, privateEvidence: join(root, "another-suite") }),
      JSON.stringify({ ...ledger, startedAt: "not a date" }),
      JSON.stringify({ ...ledger, turnLimitMs: TURN_MS + 1 }),
      JSON.stringify({ ...ledger, suiteLimitMs: SUITE_MS + 1 }),
      JSON.stringify({ ...ledger, cases: {} }),
    ]) {
      writeFileSync(join(root, "report.json"), contents);
      reject();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live suite opens its matching ledger before making the root private", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gallivant-ledger-valid-")));
  const report = { privateEvidence: root, startedAt: "2026-10-01T00:00:00.000Z", turnLimitMs: TURN_MS, suiteLimitMs: SUITE_MS, cases: [] };
  const text = JSON.stringify(report) + "\n";
  try {
    chmodSync(root, 0o755);
    writeFileSync(join(root, "report.json"), text);
    assert.deepEqual(openSuiteLedger(root), report);
    assert.equal(statSync(root).mode & 0o777, 0o700);
    assert.equal(readFileSync(join(root, "report.json"), "utf8"), text);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("live selection is explicit, unique, and includes both OpenCode cases", () => {
  assert.deepEqual(selection([]), ["gemini", "opencode-default", "opencode-go", "goose"]);
  assert.throws(() => selection(["opencode-go", "opencode-go"]), /duplicate/);
  assert.throws(() => selection(["claude"]), /Select only/);
  assert.throws(() => selection(["goose-deepseek"]), /Select only/);
});

test("named live provider cases pin Console routes and saved Goose selectors", () => {
  assert.deepEqual(NAMED_CASES["goose-meta"], { provider: "meta", model: "muse-spark-1.1" });
  assert.deepEqual(NAMED_CASES["goose-xai"], { provider: "xai", model: "grok-4.5" });
  assert.deepEqual(NAMED_CASES["goose-alibaba"], { provider: "alibaba", model: "qwen3.7-max" });
  assert.equal(NAMED_CASES["opencode-console-meta"].model, "console-meta/muse-spark-1.1");
  assert.equal(NAMED_CASES["opencode-console-xai"].model, "console-xai/grok-4.5");
  assert.equal(NAMED_CASES["opencode-console-alibaba"].model, "console-alibaba/qwen3.8-max");
  const names = Object.keys(NAMED_CASES).filter(id => id !== "opencode-go");
  assert.deepEqual(selection(names), names);
});

test("live cost evidence keeps Console BYOK billing unknown and native values separate", () => {
  for (const id of ["opencode-console-meta", "opencode-console-xai", "opencode-console-alibaba"]) {
    for (const cost of [0, 0.25, null, undefined]) {
      assert.deepEqual(costEvidence({ id, harness: "opencode", configured: NAMED_CASES[id] }, cost), {
        costUsd: "unknown", nativeReportedCostUsd: cost ?? "unknown",
      });
    }
  }
  // A Console model selected as the existing default has the same unknown billing semantics.
  assert.deepEqual(costEvidence({ id: "opencode-default", harness: "opencode", configured: { model: "console-xai/grok-4.5" } }, 0), {
    costUsd: "unknown", nativeReportedCostUsd: 0,
  });
  for (const cost of [0, 0.25, null, undefined]) {
    assert.deepEqual(costEvidence({ id: "opencode-go", harness: "opencode", configured: NAMED_CASES["opencode-go"] }, cost), {
      costUsd: cost ?? "unknown", nativeReportedCostUsd: cost ?? "unknown",
    });
  }
});

test("live provider access rejection is distinct from tool permission refusal", () => {
  const lines = message => [JSON.stringify({ type: "error", error: { message } })];
  for (const message of ["model grok is not allowed for this account", "model command-r is not allowed for this account", "Provider access is not allowed for this subscription"]) {
    const evidence = refusalEvidence(lines(message));
    const result = classify(evidence);
    assert.equal(result.category, "provider-rejection");
    assert.match(result.remedy, /exact provider\/model and subscription/);
    assert.doesNotMatch(result.remedy, /scoped approval/);
    assert.equal(classify(`${evidence}\nThe user rejected permission to use this specific tool call.`).category, "permissions");
  }
  for (const error of ["Tool execution is not allowed by the current policy.", "not allowed"]) {
    const tool = JSON.stringify({ type: "tool_use", part: { state: { status: "error", error } } });
    assert.equal(classify(refusalEvidence([tool])).category, "permissions");
    const gemini = JSON.stringify({ type: "tool_result", status: "error", error: { message: error } });
    assert.equal(classify(refusalEvidence([gemini])).category, "permissions");
  }
  const providerFromTool = JSON.stringify({ type: "tool_use", part: { state: { status: "error", error: "model grok is not allowed for this account" } } });
  assert.equal(classify(refusalEvidence([providerFromTool])).category, "provider-rejection");
  assert.equal(classify("This is not allowed").category, "unclassified");
});

test("live failure classification keeps external failures distinct and denials take priority", () => {
  for (const [message, category] of [
    ["APort denied tool; 429 quota exceeded", "guardrail"],
    ["Operation not permitted", "sandbox"],
    ["permission denied for shell", "permissions"],
    ["The user rejected permission to use this specific tool call.", "permissions"],
    ["Path not in workspace", "sandbox"],
    ["RESOURCE_EXHAUSTED quota", "quota"],
    ["401 unauthorized", "credentials"],
    ["ProviderModelNotFound", "provider-rejection"],
    ["Bad request (400): Recursive JSON schemas are not currently supported.", "provider-rejection"],
    ["no result event", "unclassified"],
  ]) assert.equal(classify(message).category, category);
  assert.equal(classify("", true).category, "timeout");
});

test("live refusal monitor ignores prompt echoes and stops on actual tool errors", () => {
  const prompt = JSON.stringify({ type: "message", role: "user", content: "APort denied is an example" });
  assert.equal(refusalEvidence([prompt]), "");
  assert.equal(classify(refusalEvidence([JSON.stringify({ type: "tool_use", part: { state: { status: "error", error: "The user rejected permission to use this specific tool call." } } })])).category, "permissions");
  assert.equal(classify(refusalEvidence([JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "error", kind: "authentication", message: "401 Unauthorized" }] } })])).category, "credentials");
});

test("live OpenCode directory evidence rejects tools rooted outside the disposable checkout", () => {
  const checkout = mkdtempSync(join(tmpdir(), "gallivant-directory-probe-"));
  assert.throws(() => verifySessionDirectory({}, checkout), /actual tool directory/);
  assert.throws(() => verifySessionDirectory({ info: { directory: tmpdir() } }, checkout), /escaped/);
  verifySessionDirectory({ info: { directory: checkout } }, checkout);
});

test("live identity requires the actual adapter identity and refuses a new session on resume", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const lines = [JSON.stringify({ type: "init", session_id: id })];
  assert.equal(sessionIdentity("gemini", adapters.gemini, lines, id).adapterSession, id);
  assert.throws(() => sessionIdentity("gemini", adapters.gemini, lines, "22222222-2222-4222-8222-222222222222"), /changed session/);
  const name = "gallivant-test";
  assert.deepEqual(sessionIdentity("goose", adapters.goose, [], name, { session: { id: "stored-1", name } }), { adapterSession: name, storedSession: "stored-1" });
  assert.throws(() => sessionIdentity("goose", adapters.goose, [], name, { session: { id: "stored-1", name: "other" } }), /requested name/);
});

test("live model evidence comes from structured metadata and retains fallback models", () => {
  const messages = ["qwen3.8-max", "other"].map(modelID => ({ info: { role: "assistant", providerID: "opencode-go", modelID } }));
  assert.deepEqual(effectiveModels("opencode", [], { messages }), ["opencode-go/other", "opencode-go/qwen3.8-max"]);
  assert.deepEqual(effectiveModels("gemini", [JSON.stringify({ type: "init", model: "gemini-model" })]), ["gemini-model"]);
  assert.deepEqual(effectiveModels("goose", [], {}), []);
  assert.deepEqual(effectiveModels("gemini", [JSON.stringify({ type: "init", model: "auto" })]), []);
  assert.deepEqual(effectiveModels("gemini", [], { messages: [{ type: "gemini", model: "gemini-3.5-flash" }] }), ["gemini-3.5-flash"]);
});

test("live test execution requires matching successful tool output, not narration", () => {
  const call = { type: "tool_use", tool_id: "test-1", parameters: { command: "node --test --test-reporter=tap live.test.mjs" } };
  const result = { type: "tool_result", tool_id: "test-1", status: "success", output: "# pass 2\n# fail 0" };
  const lines = values => values.map(v => JSON.stringify(v));
  assert.deepEqual(testExecution("gemini", lines([call, result])), ["test-1"]);
  assert.deepEqual(testExecution("gemini", lines([call, { ...result, tool_id: "other" }])), []);
  assert.deepEqual(testExecution("gemini", lines([{ type: "message", role: "assistant", content: JSON.stringify([call, result]) }])), []);
  assert.deepEqual(testExecution("opencode", lines([{ type: "tool_use", part: { callID: "test-2", state: { status: "completed", input: { command: call.parameters.command }, output: result.output } } }])), ["test-2"]);
});

test("external live verifier rejects missing push and uncommitted resume, then proves both real Git turns", () => {
  const evidence = mkdtempSync(join(tmpdir(), "gallivant-verifier-"));
  const cwd = join(evidence, "checkout"), remote = join(evidence, "remote.git");
  mkdirSync(cwd);
  const env = { ...process.env, ...runEnv({}, null, { name: "Verifier test", email: "test@example.invalid" }, cwd) };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", `--initial-branch=${BRANCH}`, remote);
  git("init", "-b", BRANCH);
  git("remote", "add", "origin", remote);
  git("commit", "--allow-empty", "-m", "Initialize verifier fixture");
  let previous = git("rev-parse", "HEAD");
  verifyStartFixture({ cwd, remote, initial: previous, env });
  git("push", "origin", "HEAD:refs/heads/contaminated");
  assert.throws(() => verifyStartFixture({ cwd, remote, initial: previous, env }), /remote already contains commits/);
  git("push", "origin", ":refs/heads/contaminated");
  for (const phase of ["start", "resume"]) {
    const trim = phase === "resume";
    writeFileSync(join(cwd, "function.mjs"), `export const greet = name => 'Hello, ' + name${trim ? ".trim()" : ""} + '!';\n`);
    writeFileSync(join(cwd, "live.test.mjs"), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {greet} from './function.mjs'; test('greet',()=>assert.equal(greet(' Ada '), '${trim ? "Hello, Ada!" : "Hello,  Ada !"}'));\n`);
    const verify = () => verifyCheckout({ cwd, remote, env, previous, phase, evidence });
    assert.throws(verify);
    git("add", "--", "function.mjs", "live.test.mjs");
    git("commit", "-m", `Record ${phase} fixture`);
    assert.throws(verify, phase === "start" ? /upstream|Command failed/ : /Expected values/);
    git("push", "-u", "origin", BRANCH);
    const checked = verify();
    assert.equal(checked.remoteHead, checked.head);
    assert.equal(checked.clean, true);
    previous = checked.head;
  }
});

test("live resume preflight accepts only the last passed checkout and remote without changing either", async t => {
  const cases = [
    ["unchanged verified start", () => {}, null],
    ["missing passed turn", f => { f.previous = null; }, /verified previous turn/],
    ["uncommitted edits", f => writeFileSync(join(f.cwd, "function.mjs"), "partial resume\n"), /must be clean/],
    ["staged edits", f => { writeFileSync(join(f.cwd, "function.mjs"), "partial resume\n"); f.git("add", "function.mjs"); }, /must be clean/],
    ["untracked edits", f => writeFileSync(join(f.cwd, "partial.txt"), "partial resume\n"), /must be clean/],
    ["unpublished resume commit", f => f.git("commit", "--allow-empty", "-m", "Failed resume fixture"), /HEAD changed/],
    ["pushed resume commit", f => { f.git("commit", "--allow-empty", "-m", "Failed resume fixture"); f.git("push", "origin", BRANCH); }, /HEAD changed/],
    ["changed branch", f => f.git("switch", "-c", "other-probe"), /branch changed/],
    ["missing upstream", f => f.git("branch", "--unset-upstream"), /upstream/],
    ["moved tracking ref", f => f.git("update-ref", `refs/remotes/origin/${BRANCH}`, f.previous.parent), /upstream moved/],
    ["changed origin", f => f.git("remote", "set-url", "origin", join(f.evidence, "other.git")), /remote changed/],
    ["changed push destination", f => f.git("remote", "set-url", "--push", "origin", join(f.evidence, "other.git")), /push destination changed/],
    ["changed bare remote with unchanged local tracking ref", f => f.git("--git-dir", f.remote, "update-ref", `refs/heads/${BRANCH}`, f.previous.parent), /bare remote HEAD changed/],
    ["changed remote branch with unchanged bare HEAD", f => {
      f.git("--git-dir", f.remote, "update-ref", "--no-deref", "HEAD", f.previous.head);
      f.git("--git-dir", f.remote, "update-ref", `refs/heads/${BRANCH}`, f.previous.parent);
    }, /remote branch changed/],
  ];
  for (const [name, change, error] of cases) await t.test(name, () => {
    const evidence = mkdtempSync(join(tmpdir(), "gallivant-resume-preflight-"));
    const cwd = join(evidence, "checkout"), remote = join(evidence, "remote.git");
    mkdirSync(cwd);
    const env = { ...process.env, ...runEnv({}, null, { name: "Resume verifier test", email: "test@example.invalid" }, cwd) };
    const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "--bare", `--initial-branch=${BRANCH}`, remote);
      git("init", "-b", BRANCH);
      git("remote", "add", "origin", remote);
      git("commit", "--allow-empty", "-m", "Initialize resume verifier fixture");
      const initial = git("rev-parse", "HEAD");
      writeFileSync(join(cwd, "function.mjs"), "export const greet = name => 'Hello, ' + name + '!';\n");
      writeFileSync(join(cwd, "live.test.mjs"), "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {greet} from './function.mjs'; test('greet',()=>assert.equal(greet(' Ada '), 'Hello,  Ada !'));\n");
      git("add", "function.mjs", "live.test.mjs");
      git("commit", "-m", "Record passed start fixture");
      git("push", "-u", "origin", BRANCH);
      const previous = verifyCheckout({ cwd, remote, env, previous: initial, phase: "start", evidence });
      const fixture = { cwd, remote, env, previous, evidence, git };
      change(fixture);
      const state = () => ({
        head: git("rev-parse", "HEAD"), status: git("status", "--porcelain"), branch: git("branch", "--show-current"),
        refs: git("show-ref"), remoteRefs: git("--git-dir", remote, "show-ref", "--head"),
        config: readFileSync(join(cwd, ".git", "config"), "utf8"),
        files: readdirSync(cwd).filter(name => name !== ".git").map(name => [name, readFileSync(join(cwd, name), "utf8")]),
      });
      const before = state();
      if (error) assert.throws(() => verifyResumeFixture(fixture), error);
      else verifyResumeFixture(fixture);
      assert.deepEqual(state(), before, "preflight must preserve failed-turn evidence");
    } finally { rmSync(evidence, { recursive: true, force: true }); }
  });
});
