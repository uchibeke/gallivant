// Test-only evidence checks. Importing this module never launches a harness.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkVersion } from "../lib/probe.mjs";
import { runEnv } from "../lib/git.mjs";

export const TURN_MS = 180_000;
export const SUITE_MS = 30 * 60_000;
export const STOP_GRACE_MS = 6_000; // Includes the runner's five-second TERM -> KILL grace.
export const CASES = ["gemini", "opencode-default", "opencode-go", "goose"];
// Native, test-local selections. Console BYOK routes are distinct from OpenCode Zen/Go subscriptions.
export const NAMED_CASES = Object.freeze({
  "opencode-go": { model: "opencode-go/qwen3.8-max" },
  "goose-meta": { provider: "meta", model: "muse-spark-1.1" },
  "goose-xai": { provider: "xai", model: "grok-4.5" },
  "goose-alibaba": { provider: "alibaba", model: "qwen3.7-max" },
  "opencode-console-meta": { model: "console-meta/muse-spark-1.1" },
  "opencode-console-xai": { model: "console-xai/grok-4.5" },
  "opencode-console-alibaba": { model: "console-alibaba/qwen3.8-max" },
});
const SELECTABLE = [...new Set([...CASES, ...Object.keys(NAMED_CASES)])];
export const BRANCH = "gallivant/live-probe";
export const parseEvents = lines => lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
export const safeLabel = value => typeof value === "string" && /^[\w./:-]{1,160}$/.test(value) ? value : "unknown";
export const harnessForCase = id => id.startsWith("opencode") ? "opencode" : id.startsWith("goose") ? "goose" : id;

// Undefined overrides prevent makeRunner's parent-env merge from restoring credential
// channels. Rebuild Git settings from runEnv only, after clearing inherited/adapter values.
// Native provider setup is retained; these disposable tasks have no GitHub work.
export function liveRunEnv(config, identity, cwd, extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|GH_|GITHUB_|SSH_|GCM_|VSCODE_(?:GIT|SSH)_)/i.test(key)) env[key] = undefined;
  }
  return { ...env, ...runEnv(config, null, identity, cwd), GIT_TERMINAL_PROMPT: "0",
    // Local bare remotes need no network transport or SSH identity, including keys
    // discoverable from HOME. Keep HOME intact for the selected provider's setup.
    GIT_ALLOW_PROTOCOL: "file", GIT_SSH_COMMAND: "false",
  };
}

export function assertUnspentVersionBlock(entry, report) {
  assert.ok(Number.isInteger(entry.blockedInvocation) && entry.blockedInvocation >= 0
    && report.invocations?.[entry.blockedInvocation]?.versions?.[entry.harness]?.ok === false
    && Array.isArray(entry.turns) && entry.turns.length === 0 && !entry.retry
    && !entry.cwd && !entry.remote && !entry.initial,
  "This case already ran or was not blocked solely by version preflight; only an unspent version-blocked case can be appended again");
}

export function selection(args) {
  const selected = args.length ? args : CASES;
  assert.ok(selected.every(id => SELECTABLE.includes(id)), `Select only: ${SELECTABLE.join(", ")}`);
  assert.equal(new Set(selected).size, selected.length, "duplicate cases would spend extra calls");
  return selected;
}

// Each invocation checks the binaries it will actually use; never overwrite an earlier invocation's evidence.
export async function auditLiveInvocation(report, config, { mode, selected, source }) {
  const audit = { mode, selected: [...selected], source, checkedAt: new Date().toISOString(), versions: {}, binaries: {} };
  const harnesses = mode === "start" ? Object.keys(config.harness) : [...new Set(selected.map(harnessForCase))];
  for (const harness of harnesses) {
    audit.binaries[harness] = config.harness[harness]?.bin ?? null;
    audit.versions[harness] = await checkVersion(harness, config);
  }
  (report.invocations ||= []).push(audit);
  if (mode === "start") { report.versions = audit.versions; report.binaries = audit.binaries; }
  return audit;
}

// Call only after synchronous preflight. Nothing that can spend time belongs between this check and start.
export function launchLiveTurn({ report, entry, phase, attempt, deadline, runner, spec, env, fix, source, invocation, checkpoint }, now = Date.now) {
  // Preserve the durable retry reservation across a crash after launch, but include its I/O in the final check.
  if (attempt === 2) { entry.retry = { phase, fix, source }; checkpoint(); }
  const startedMs = now();
  const startedAt = new Date(startedMs).toISOString();
  const limit = Math.min(startedMs + TURN_MS, deadline) - STOP_GRACE_MS;
  if (report.interrupted || report.suiteTimedOut || startedMs >= limit) {
    if (attempt === 2) delete entry.retry;
    (report.unstartedTurns ||= []).push({
      case: entry.id, phase, attempt, invocation, checkedAt: startedAt,
      reason: report.interrupted ? "suite interrupted before launch" : "suite has no usable time after reserving termination grace",
    });
    checkpoint();
    return null;
  }
  const job = runner.start(`${phase}-${attempt}`, spec.cmd, spec.args, { cwd: entry.cwd, env });
  return { job, startedAt, limit };
}

// Existing roots are operator input. Do not change their permissions until the ledger identifies this suite.
export function openSuiteLedger(root) {
  let report;
  try { report = JSON.parse(readFileSync(join(root, "report.json"), "utf8")); }
  catch { throw new Error("Missing or unreadable suite ledger"); }
  assert.ok(report && report.privateEvidence === realpathSync(root)
    && typeof report.startedAt === "string" && Number.isFinite(Date.parse(report.startedAt))
    && report.turnLimitMs === TURN_MS && report.suiteLimitMs === SUITE_MS
    && Array.isArray(report.cases), "Invalid suite ledger for this directory");
  chmodSync(root, 0o700);
  return report;
}

export function costEvidence(entry, nativeCost) {
  const nativeReportedCostUsd = nativeCost ?? "unknown";
  // Custom Console routes emit cost metadata without establishing the provider's BYOK charge.
  const consoleByok = entry.harness === "opencode" && entry.configured.model?.startsWith("console-");
  return { costUsd: consoleByok ? "unknown" : nativeReportedCostUsd, nativeReportedCostUsd };
}

export function classify(text, timedOut = false) {
  // A denial takes precedence over a model's claim of success or a later timeout.
  if (/APort denied|guardrail.{0,40}(denied|blocked)|auto.?review.{0,40}(denied|rejected)/i.test(text))
    return { category: "guardrail", remedy: "Ask the operator to review the named guardrail decision; do not retry or route around it." };
  if (/operation not permitted|sandbox.{0,40}(denied|restricted)|PermissionDenied|Path not in workspace|outside the allowed workspace/i.test(text))
    return { category: "sandbox", remedy: "Use the host's supported scoped approval for the recorded operation; do not change sandbox policy." };
  if (/requires? (approval|confirmation)|permission.{0,40}(denied|rejected|auto-reject)|rejected permission|permission requested:|approval.{0,40}(required|stdin)|non.interactive.{0,60}(approve|permission)/i.test(text))
    return { category: "permissions", remedy: "Review the recorded tool request and provide a supported scoped approval path for closed stdin; do not enable blanket approval." };
  if (/quota|creditsExhausted|RESOURCE_EXHAUSTED|insufficient.{0,20}(balance|credit)|rate.limit|\b429\b/i.test(text))
    return { category: "quota", remedy: "Restore quota for the recorded provider/model or wait for its stated reset, then explicitly schedule a new suite." };
  if (/API.key.{0,30}(invalid|missing|not|expired)|unauthorized|UNAUTHENTICATED|\b401\b|authentication.{0,30}(fail|required)/i.test(text))
    return { category: "credentials", remedy: "Repair this provider's existing login/key through its normal setup, then explicitly schedule a new suite; do not search for other credentials." };
  if (/Recursive JSON schemas are not currently supported/i.test(text))
    return { category: "provider-rejection", remedy: "Resolve the native provider's tool-schema compatibility for this exact model before scheduling a new suite; do not remove guards or extensions to evade the rejection." };
  if (/model.{0,60}(not found|not available|not supported|not allowed)|ProviderModelNotFound|\b403\b|\b404\b|forbidden|provider.{0,40}(reject|not allowed)/i.test(text))
    return { category: "provider-rejection", remedy: "Confirm this exact provider/model and subscription permit the task; enable access through the operator without substituting a model." };
  // "Not allowed" alone can describe entitlement. Check provider context first, even for a model named command-r.
  if (/\b(tool|command|path|directory)\b.{0,40}not allowed/i.test(text))
    return { category: "permissions", remedy: "Review the recorded tool request and provide a supported scoped approval path for closed stdin; do not enable blanket approval." };
  if (timedOut) return { category: "timeout", remedy: "Inspect the private log for provider latency or a pending approval. Do not increase the 180-second turn limit." };
  return { category: "unclassified", remedy: "Inspect the private stream and verifier log. Only a demonstrated adapter defect justifies a targeted retry after a regression-tested fix." };
}

export function turnFailure(classified, stage, evidence) {
  const failure = { ...classified, stage, evidence };
  if (classified.category === "unclassified" && stage === "verification") {
    failure.category = "verification";
    failure.remedy = "Preserve the failed task evidence. File, test and Git verification failures cannot use an adapter retry; another model call requires a newly authorized suite.";
  }
  return { status: ["unclassified", "verification"].includes(failure.category) ? "failed" : "blocked", failure };
}

export function assertAdapterRetry(failed, source) {
  assert.ok(failed?.status === "failed" && failed.failure?.category === "unclassified" && failed.failure.stage === "adapter",
    "Only a recorded unclassified adapter-check failure can be retried; verification failures, external blocks and legacy failures without a stage are ineligible");
  assert.notDeepEqual(source.sha256, failed.source.sha256, "A targeted retry requires a source change");
}

// Exclude echoed prompts and narrated assistant text. Only structured tool failures and CLI diagnostics can
// terminate a running child; a prompt mentioning a denial must never trip its own monitor.
export function refusalEvidence(lines) {
  return lines.flatMap(line => {
    let e;
    try { e = JSON.parse(line); } catch { return [line]; }
    // Preserve tool context for terse native permission errors such as just "not allowed".
    if (e.type === "tool_result" && e.status === "error") return [`Tool failure: ${JSON.stringify(e.error)}`, `Tool failure: ${e.output || ""}`];
    if (e.part?.state?.status === "error") return [`Tool failure: ${e.part.state.error || ""}`];
    if (e.type === "error") return [JSON.stringify(e.error || e.message)];
    // Goose provider errors and tool errors appear inside content blocks.
    return (e.message?.content || []).flatMap(c => c.type === "error" ? [JSON.stringify(c)]
      : c.type === "toolResponse" && c.toolResult?.isError ? [`Tool failure: ${JSON.stringify(c.toolResult)}`] : []);
  }).join("\n");
}

export function sessionIdentity(harness, adapter, lines, requested, exported) {
  const parsed = adapter.sessionFrom(lines);
  if (harness === "goose") {
    assert.ok(adapter.isSession(requested), "invalid Goose session name");
    // Goose's adapter identity is a name, not a JSONL session id. The native export ties the name to storage.
    const session = exported?.session ?? exported;
    assert.ok(session?.id, "Goose export must supply its stored session id");
    assert.equal(session.name, requested, "Goose export must resolve the requested name");
    return { adapterSession: requested, storedSession: String(session.id) };
  }
  assert.ok(adapter.isSession(parsed), "missing/invalid session in actual output");
  if (requested) assert.equal(parsed, requested, "harness silently changed session");
  return { adapterSession: parsed, storedSession: parsed };
}

export function effectiveModels(harness, lines, exported) {
  if (harness === "opencode") {
    return [...new Set((exported?.messages || []).filter(m => m.info?.role === "assistant")
      .map(m => `${safeLabel(m.info.providerID)}/${safeLabel(m.info.modelID)}`))].sort();
  }
  if (harness === "gemini") {
    const evs = parseEvents(lines);
    const models = [...evs.flatMap(e => Object.keys(e.stats?.models || {})), ...(exported?.messages || []).map(e => e.model).filter(Boolean)];
    // `auto` is a routing alias, not proof of the model that served the request.
    return [...new Set(models.length ? models : evs.filter(e => e.type === "init" && e.model !== "auto").map(e => e.model).filter(Boolean))].map(safeLabel).sort();
  }
  const s = exported?.session ?? exported;
  const model = s?.model_config?.model_name ?? s?.model_config?.model ?? s?.model;
  const provider = s?.provider_name ?? s?.provider;
  return model && provider ? [`${safeLabel(provider)}/${safeLabel(model)}`] : [];
}

export function verifySessionDirectory(exported, cwd) {
  assert.ok(exported?.info?.directory, "OpenCode export must identify its actual tool directory");
  assert.equal(realpathSync(exported.info.directory), realpathSync(cwd), "OpenCode tool directory escaped the disposable checkout");
}

export function verifyStartFixture({ cwd, remote, initial, env }) {
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git("rev-parse", "HEAD"), initial, "start fixture already has model commits");
  assert.equal(git("status", "--porcelain"), "", "start fixture must be clean");
  assert.equal(git("ls-files"), "", "start fixture must contain no prewritten files");
  assert.equal(git("remote", "get-url", "origin"), remote, "start fixture remote changed");
  assert.equal(git("ls-remote", "--refs", "origin"), "", "start fixture remote already contains commits; do not retry in a contaminated fixture");
}

export function verifyResumeFixture({ cwd, remote, previous, env }) {
  assert.ok(previous?.head && previous.clean === true, "resume requires a verified previous turn");
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.equal(git("rev-parse", "HEAD"), previous.head, "resume fixture HEAD changed since the last passed turn");
  assert.equal(git("status", "--porcelain"), "", "resume fixture must be clean since the last passed turn");
  assert.equal(git("branch", "--show-current"), BRANCH, "resume fixture branch changed");
  assert.equal(git("remote", "get-url", "origin"), remote, "resume fixture remote changed");
  assert.equal(git("remote", "get-url", "--push", "--all", "origin"), remote, "resume fixture push destination changed");
  assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${BRANCH}`, "resume fixture upstream changed");
  assert.equal(git("rev-parse", "@{upstream}"), previous.head, "resume fixture upstream moved since the last passed turn");
  assert.equal(git("--git-dir", remote, "rev-parse", "HEAD"), previous.head, "resume fixture bare remote HEAD changed since the last passed turn");
  assert.equal(git("ls-remote", "origin", `refs/heads/${BRANCH}`).split(/\s/)[0], previous.head, "resume fixture remote branch changed since the last passed turn");
}

/** A successful test TOOL result, never the echoed prompt or the assistant's claimed success. */
export function testExecution(harness, lines, exported) {
  const evs = parseEvents(lines);
  const command = value => /\bnode\s+--test\b[^\n]*\blive\.test\.mjs\b/.test(value || "");
  const passed = value => /# pass [1-9]/.test(value || "") && /# fail 0\b/.test(value || "");
  if (harness === "opencode") return evs.filter(e => e.type === "tool_use" && e.part?.state?.status === "completed"
    && command(e.part.state.input?.command) && passed(e.part.state.output)).map(e => e.part.callID || e.part.id);
  if (harness === "gemini") return evs.filter(e => e.type === "tool_use" && command(e.parameters?.command)
    && evs.some(r => r.type === "tool_result" && r.tool_id === e.tool_id && r.status === "success" && passed(r.output))).map(e => e.tool_id);
  const content = [...evs.flatMap(e => e.message?.content || []), ...(exported?.conversation || []).flatMap(e => e.content || [])];
  return content.filter(c => c.type === "toolRequest" && command(c.toolCall?.value?.arguments?.command)
    && content.some(r => r.type === "toolResponse" && r.id === c.id && r.toolResult?.status === "success"
      && !r.toolResult.value?.isError && passed((r.toolResult.value?.content || []).map(p => p.text || "").join("\n")))).map(c => c.id);
}

export function verifyCheckout({ cwd, remote, env, previous, phase, evidence }) {
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT; // Ordinary regression tests may themselves be running inside node:test.
  const run = (cmd, args) => execFileSync(cmd, args, { cwd, env: childEnv, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args) => run("git", args);
  for (const file of ["function.mjs", "live.test.mjs"]) assert.ok(lstatSync(join(cwd, file)).isFile(), `${file} must be a regular file`);
  assert.deepEqual(git("ls-files").split("\n").sort(), ["function.mjs", "live.test.mjs"]);
  const test = run(process.execPath, ["--test", "--test-reporter=tap", "live.test.mjs"]);
  writeFileSync(join(evidence, `${phase}-tests.txt`), test, { mode: 0o600 });
  assert.match(test, /# pass [1-9]/, "the written tests must run assertions");
  assert.match(readFileSync(join(cwd, "live.test.mjs"), "utf8"), /assert/, "test must assert behavior");
  const expected = phase === "start" ? "Hello,   Ada  !" : "Hello, Ada!";
  const check = `import assert from 'node:assert/strict'; import { greet } from './function.mjs'; assert.equal(greet('  Ada  '), ${JSON.stringify(expected)}); assert.equal(greet('Lin'), 'Hello, Lin!');`;
  run(process.execPath, ["--input-type=module", "-e", check]);
  assert.equal(git("status", "--porcelain"), "", "Git state must be clean after external tests");
  assert.equal(git("branch", "--show-current"), BRANCH);
  const head = git("rev-parse", "HEAD");
  assert.notEqual(head, previous, "turn must create a new commit");
  assert.equal(git("rev-parse", "HEAD^"), previous, "turn must preserve previous work in one new commit");
  assert.deepEqual(git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n").sort(), ["function.mjs", "live.test.mjs"]);
  assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), `origin/${BRANCH}`);
  assert.equal(git("rev-parse", "@{upstream}"), head);
  assert.equal(git("remote", "get-url", "origin"), remote);
  assert.equal(git("--git-dir", remote, "rev-parse", "HEAD"), head, "bare remote HEAD must match");
  assert.equal(git("ls-remote", "origin", `refs/heads/${BRANCH}`).split(/\s/)[0], head);
  return { head, parent: previous, upstream: `origin/${BRANCH}`, remoteHead: head, clean: true, tests: `${phase}-tests.txt`, behavior: expected };
}

export function codingPrompt(phase, remote) {
  return `This is an authorized, disposable Gallivant live adapter test. Work only in this checkout; its only remote is the local bare Git repository ${remote}. Do not access GitHub, other repositories, credentials, configuration, permissions, or hooks. Do not use subagents or delegate. Do not install dependencies or select another model/provider.
${phase === "start" ? 'Write function.mjs exporting greet(name), returning exactly "Hello, " + name + "!" (include the comma and space after Hello; leave the name unchanged). For greet("  Ada  "), return "Hello,   Ada  !". Write live.test.mjs using node:test and node:assert/strict, with assertions for normal and space-padded names.' : 'Continue the SAME session and existing work. Change greet(name) to trim leading/trailing whitespace from the name, returning exactly "Hello, " + name.trim() + "!". For greet("  Ada  "), return "Hello, Ada!". Update live.test.mjs to assert the changed padded-name behavior and preserve the normal-name test.'}
Run node --test --test-reporter=tap live.test.mjs and fix any failures. These must be real file edits and tool calls. Stage only function.mjs and live.test.mjs, check the staged diff, create exactly one commit with a plain descriptive message, and push with upstream to origin ${BRANCH}. Verify clean status, upstream, and remote HEAD. Keep file writes and Git writes in separate tool calls. Stop on command failures. No harness attribution or Co-Authored-By trailers.
A guardrail/reviewer denial is a boundary: stop and report it, never re-spell or wrap a denied command. For a filesystem sandbox error only, use the harness's supported scoped approval if available. Never weaken safety or use blanket approval. If approval needs interactive stdin, report blocked. Do not rebase, force-push, create an orphan branch, or change origin. Stop on any failed Git command. Do not narrate success without doing the work.`;
}
