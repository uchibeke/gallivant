import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { BRANCH, NAMED_CASES, TURN_MS, SUITE_MS, selection, classify, refusalEvidence, openSuiteLedger, sessionIdentity, effectiveModels, testExecution, verifyCheckout, verifySessionDirectory, verifyStartFixture } from "./live-support.mjs";

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
