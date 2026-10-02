// Opt-in, sequential model calls. Deliberately outside the ordinary *.test.mjs glob.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { adapterFor, assertSafeArgv, buildRun, MIN_VERSIONS } from "../lib/harness.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { isOurProcess, makeRunner } from "../lib/run.mjs";
import { checkVersion } from "../lib/probe.mjs";
import { BRANCH, NAMED_CASES, TURN_MS, SUITE_MS, assertAdapterRetry, assertUnspentVersionBlock, auditLiveInvocation, classify, codingPrompt, costEvidence, effectiveModels, harnessForCase, launchLiveTurn, liveRunEnv, openSuiteLedger, parseEvents, refusalEvidence, safeLabel, selection, sessionIdentity, testExecution, turnFailure, verifyCheckout, verifyResumeFixture, verifySessionDirectory, verifyStartFixture } from "./live-support.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
assert.equal(args.shift(), "--live", "Model calls require explicit opt-in: npm run test:live-harnesses -- --live [case ...]");
assert.ok(isOurProcess(process.pid, process.execPath), "Live suite requires process inspection to enforce its deadlines; use the host's supported approval before any model call");
process.umask(0o077);
const retry = args[0] === "--retry";
const append = args[0] === "--append";
let root, selected, retryPhase, fix;
if (retry) {
  args.shift();
  root = realpathSync(args.shift());
  const [id, phase] = (args.shift() || "").split(":");
  selected = selection([id]);
  assert.ok(["start", "resume"].includes(phase));
  retryPhase = phase;
  fix = args.shift();
  assert.ok(fix && !isAbsolute(fix) && !relative(repo, resolve(repo, fix)).startsWith("..") && existsSync(resolve(repo, fix)), "Retry requires a repository file documenting the defect, regression test, and fix");
  assert.equal(args.length, 0);
} else if (append) {
  args.shift();
  root = realpathSync(args.shift());
  assert.ok(args.length, "Append requires explicit untested cases");
  selected = selection(args);
} else {
  selected = selection(args);
  root = mkdtempSync(join(realpathSync(tmpdir()), "gallivant-live-harnesses-"));
  chmodSync(root, 0o700);
}
assert.ok(relative(repo, root).startsWith(".."), "Private evidence must be outside the repository");
const json = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const sourceFiles = ["lib/harness.mjs", "lib/run.mjs", "lib/git.mjs", "test/live-harnesses.mjs", "test/live-support.mjs"];
const source = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  sha256: Object.fromEntries(sourceFiles.map(p => [p, createHash("sha256").update(readFileSync(join(repo, p))).digest("hex")])),
};
const ledgerPath = join(root, "report.json");
const report = retry || append ? openSuiteLedger(root) : { startedAt: new Date().toISOString(), source, privateEvidence: root, turnLimitMs: TURN_MS, suiteLimitMs: SUITE_MS, cases: [] };
const deadline = Date.parse(report.startedAt) + SUITE_MS;
const checkpoint = () => writeJsonAtomic(ledgerPath, report);
const identity = { name: "Live adapter probe", email: "probe@example.invalid" };
const config = { harness: Object.fromEntries(["claude", "codex", "gemini", "opencode", "goose"].map(h => [h, { bin: h }])) };
// Gallivant may configure a different binary from PATH. Copy only binary selectors into the test config.
const operatorConfig = json(join(homedir(), ".gallivant", "config.json"));
for (const [harness, configured] of Object.entries(operatorConfig?.harness || {})) {
  if (config.harness[harness] && typeof configured.bin === "string") config.harness[harness].bin = configured.bin;
}
let active = null;
let invocationIndex;
let stopError;
function requestStop() {
  if (!active || active.stopping) return;
  active.stopping = true;
  try {
    assert.ok(active.runner.kill(active.id) || active.runner.read(active.id)?.exit !== null,
      "Cannot stop process; resolve host process permissions before another suite");
  } catch (error) { stopError ||= error; }
  finally {
    // kill can schedule its fallback and then fail to write job.json. Reference
    // the timer even then; the main async path awaits it before surfacing errors.
    active.runner.waitForKill(active.id);
  }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  report.interrupted = signal;
  process.exitCode = 1;
  requestStop(); // Checkpoint only in the main async path, after the kill fallback.
});
const watchdog = setTimeout(() => {
  report.suiteTimedOut = true;
  requestStop();
}, Math.max(1, deadline - Date.now()));

// Read only model selectors, never authentication files. No global setting is changed.
function configured(harness) {
  if (harness === "gemini") {
    const settings = json(join(homedir(), ".gemini", "settings.json"));
    return { provider: safeLabel(settings?.security?.auth?.selectedType), model: safeLabel(process.env.GEMINI_MODEL || settings?.model?.name) };
  }
  if (harness === "opencode") {
    const settings = json(join(homedir(), ".config", "opencode", "opencode.json"));
    const recent = json(join(homedir(), ".local", "state", "opencode", "model.json"))?.recent?.[0];
    return { model: safeLabel(settings?.model || (recent && `${recent.providerID}/${recent.modelID}`)) };
  }
  const path = join(homedir(), ".config", "goose", "config.yaml");
  const yaml = existsSync(path) ? readFileSync(path, "utf8") : "";
  const scalar = value => value?.trim().replace(/^['"]|['"]$/g, "");
  const provider = process.env.GOOSE_PROVIDER || scalar(yaml.match(/^active_provider:\s*(.+)$/m)?.[1]) || scalar(yaml.match(/^GOOSE_PROVIDER:\s*(.+)$/m)?.[1]);
  let selectedProvider, model;
  for (const line of yaml.split("\n")) {
    if (/^  [\w-]+:$/.test(line)) selectedProvider = line.trim().slice(0, -1);
    if (selectedProvider === provider && /^    model:/.test(line)) model = scalar(line.slice(line.indexOf(":") + 1));
  }
  return { provider: safeLabel(provider), model: safeLabel(process.env.GOOSE_MODEL || model || scalar(yaml.match(/^GOOSE_MODEL:\s*(.+)$/m)?.[1])) };
}

// Metadata/export commands do not make model calls. Their complete output stays private too.
function capture(cmd, argv, cwd, env, path) {
  const out = openSync(path, "w", 0o600), err = openSync(`${path}.stderr`, "w", 0o600);
  try {
    // Direct file output also avoids OpenCode 1.18.31 truncating a large export when stdout is a pipe.
    execFileSync(cmd, argv, { cwd, env, timeout: Math.max(1, Math.min(20_000, deadline - Date.now())), stdio: ["ignore", out, err] });
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Metadata command failed; see ${path}`);
  } finally { closeSync(out); closeSync(err); }
}

function fixture(dir) {
  const cwd = join(dir, "checkout"), remote = join(dir, "remote.git");
  mkdirSync(cwd, { mode: 0o700 });
  const env = liveRunEnv(config, identity, cwd);
  const git = (...argv) => capture("git", argv, cwd, env, join(dir, "fixture-git.txt")).trim();
  git("init", "--bare", `--initial-branch=${BRANCH}`, remote);
  git("init", "-b", BRANCH);
  git("remote", "add", "origin", remote);
  git("commit", "--allow-empty", "-m", "Initialize disposable live probe");
  return { cwd, remote, initial: git("rev-parse", "HEAD") };
}

async function turn(entry, phase, attempt) {
  const { harness, cwd, remote } = entry;
  const adapter = adapterFor(harness);
  const previousTurn = entry.turns.findLast(t => t.status === "passed");
  const session = previousTurn?.identity.adapterSession || entry.requestedSession;
  const evidence = join(root, entry.id);
  const runner = makeRunner(join(evidence, "runs"));
  const spec = buildRun({ harness, config, mode: phase, session, prompt: codingPrompt(phase, remote), cwd });
  // Native overrides belong to this test, not Gallivant's per-task configuration.
  const overrides = [];
  if (harness === "opencode") overrides.push("--model", entry.configured.model);
  if (harness === "gemini" && (previousTurn || entry.configured.model !== "unknown")) overrides.push("--model", previousTurn?.models[0] || entry.configured.model);
  if (harness === "goose") overrides.push("--provider", entry.configured.provider, "--model", entry.configured.model);
  spec.args.splice(harness === "gemini" ? 0 : spec.args.length - (harness === "goose" ? 2 : 1), 0, ...overrides);
  assertSafeArgv(spec.args);
  const env = liveRunEnv(config, identity, cwd, spec.env);
  if (phase === "start") verifyStartFixture({ ...entry, env });
  else verifyResumeFixture({ ...entry, env, previous: previousTurn?.verification });
  const launch = await launchLiveTurn({ report, entry, phase, attempt, deadline, runner, spec, env, fix, source, invocation: invocationIndex, checkpoint });
  if (!launch) return null;
  const { job, record, startedAt, limit } = launch;
  active = { runner, id: job.id };
  record.run = relative(root, runner.dirOf(job.id));
  checkpoint();
  process.stdout.write(`${entry.id} ${phase} attempt ${attempt}: ${record.run}\n`);
  let timedOut = false;
  while (runner.read(job.id)?.exit === null) {
    if (stopError) throw stopError;
    if (["guardrail", "permissions", "sandbox"].includes(classify(refusalEvidence(runner.lines(job.id))).category)) {
      requestStop();
      break;
    }
    if (Date.now() >= limit || report.interrupted || report.suiteTimedOut) {
      requestStop();
      timedOut = true; break;
    }
    await delay(200);
  }
  // Includes watchdog/signal kills, which set exit 137 before this loop observes a timeout.
  // The runner keeps its fallback timer referenced until the process-group kill has run.
  await runner.waitForKill(job.id);
  if (stopError) throw stopError;
  timedOut ||= !!(report.suiteTimedOut || report.interrupted);
  active = null;
  const lines = runner.lines(job.id);
  const outcome = adapter.outcome(lines);
  record.endedAt = new Date().toISOString();
  record.elapsedMs = Date.parse(record.endedAt) - Date.parse(startedAt);
  record.exit = runner.read(job.id)?.exit;
  Object.assign(record, costEvidence(entry, outcome.cost));
  record.outcome = { ok: outcome.ok, finished: outcome.finished, denials: outcome.denials.length };
  const classified = classify(`${refusalEvidence(lines)}\n${outcome.error || ""}`, timedOut);
  // Collect model/session evidence even on a rejected or failed turn. Export is a read-only metadata command.
  const parsedSession = adapter.sessionFrom(lines) || session;
  let exported;
  if (harness !== "gemini" && adapter.isSession(parsedSession)) {
    const argv = harness === "opencode" ? ["export", parsedSession] : ["session", "export", "--name", session, "--format", "json"];
    try { exported = JSON.parse(capture(spec.cmd, argv, cwd, env, join(evidence, `${phase}-${attempt}-session.json`))); }
    catch { record.metadataError = "Session export unavailable; inspect private export output."; }
  } else if (harness === "gemini" && adapter.isSession(parsedSession)) {
    // Gemini 0.59 records the resolved model in its own JSONL transcript, while init only says `auto`.
    // Read only the file for this turn's UUID, then validate the full identity before using it.
    const chats = join(homedir(), ".gemini", "tmp", basename(cwd), "chats");
    try {
      const matches = readdirSync(chats).filter(p => p.startsWith("session-") && p.endsWith(`-${parsedSession.slice(0, 8)}.jsonl`));
      assert.equal(matches.length, 1);
      const raw = readFileSync(join(chats, matches[0]), "utf8");
      const messages = parseEvents(raw.split("\n"));
      assert.equal(messages[0]?.sessionId, parsedSession);
      writeFileSync(join(evidence, `${phase}-${attempt}-session.jsonl`), raw, { mode: 0o600 });
      exported = { messages };
    } catch { record.metadataError = "Gemini resolved model transcript unavailable; init alias alone is insufficient."; }
  }
  record.models = effectiveModels(harness, lines, exported);
  let failureStage = "adapter";
  try {
    if (harness === "opencode") {
      try { verifySessionDirectory(exported, cwd); record.directoryVerified = true; }
      catch (e) { record.isolationFailure = true; throw e; }
    }
    assert.ok(!timedOut, "turn time limit reached");
    assert.equal(record.exit, 0, "harness exited nonzero");
    assert.ok(outcome.ok && outcome.finished, "adapter outcome not successful");
    assert.equal(outcome.denials.length, 0, "adapter reported denials");
    assert.ok(!["guardrail", "permissions", "sandbox"].includes(classified.category), "tool refusal in stream");
    record.identity = sessionIdentity(harness, adapter, lines, session, exported);
    if (previousTurn) assert.deepEqual(record.identity, previousTurn.identity, "resume changed stored session identity");
    assert.equal(record.models.length, 1, "effective model must be knowable and constant, without fallback");
    assert.ok(!record.models[0].includes("unknown"), "model metadata missing");
    if (previousTurn) assert.deepEqual(record.models, previousTurn.models, "resume changed effective model");
    if (harness === "opencode") assert.equal(record.models[0], entry.configured.model, "OpenCode effective model differs from the recorded provider/model");
    if (harness === "goose") assert.equal(record.models[0], `${entry.configured.provider}/${entry.configured.model}`);
    failureStage = "verification";
    record.testToolCalls = testExecution(harness, lines, exported).filter(id => !previousTurn?.testToolCalls?.includes(id));
    assert.ok(record.testToolCalls.length, "No successful node:test tool execution in harness evidence");
    record.verification = verifyCheckout({ cwd, remote, env, previous: previousTurn?.verification.head || entry.initial, phase, evidence });
    record.status = "passed";
  } catch (e) {
    writeFileSync(join(evidence, `${phase}-${attempt}-verifier.txt`), e.stack, { mode: 0o600 });
    Object.assign(record, turnFailure(classified, failureStage, `${entry.id}/${phase}-${attempt}-verifier.txt`, outcome));
  }
  checkpoint();
  process.stdout.write(`${entry.id} ${phase}: ${record.status}; ${record.failure?.category || record.models.join(", ")}; ${record.elapsedMs}ms\n`);
  return record;
}

try {
  process.stdout.write(`Private evidence: ${root}\n`);
  const invocation = await auditLiveInvocation(report, config, { mode: retry ? "retry" : append ? "append" : "start", selected, source });
  invocationIndex = report.invocations.length - 1;
  if (!retry && !append) {
    report.pathVersions = {};
    for (const [harness, value] of Object.entries(config.harness)) {
      if (value.bin !== harness) report.pathVersions[harness] = await checkVersion(harness, { harness: { [harness]: { bin: harness } } });
    }
  }
  checkpoint();
  for (const id of selected) {
    if (Date.now() >= deadline || report.interrupted || report.suiteTimedOut) break;
    let entry = report.cases.find(c => c.id === id);
    if (retry) {
      assert.ok(entry && !entry.retry, "Only one targeted retry is allowed per combination");
      const failed = entry.turns.findLast(t => t.phase === retryPhase);
      assertAdapterRetry(failed, source);
      const failedLines = readFileSync(join(root, failed.run, "job.log"), "utf8").split("\n");
      const failedOutcome = adapterFor(entry.harness).outcome(failedLines);
      assertAdapterRetry({ ...failed, outcome: failedOutcome }, source);
      assert.equal(classify(`${refusalEvidence(failedLines)}\n${failedOutcome.error || ""}`).category, "unclassified", "A corrected parser must not turn an earlier unclassified external failure into a retry");
    } else if (entry) {
      assert.ok(append, "This case already ran; only an explicit append can reuse an unspent version block");
      assertUnspentVersionBlock(entry, report);
    } else {
      const harness = harnessForCase(id);
      const dir = join(root, id);
      mkdirSync(dir, { mode: 0o700 });
      entry = { id, harness, configured: configured(harness), requestedSession: adapterFor(harness).newSession(), turns: [] };
      if (NAMED_CASES[id]) entry.configured = { ...NAMED_CASES[id] };
      assert.ok(!report.cases.some(c => c.harness === harness && JSON.stringify(c.configured) === JSON.stringify(entry.configured)), "This provider/model combination already ran");
      report.cases.push(entry);
    }
    if (/deepseek/i.test(JSON.stringify(entry.configured))) { entry.blocked = "DeepSeek excluded by the current operator scope; no model call made."; checkpoint(); continue; }
    // Pin the observed default just like a named case. Missing components and routing
    // aliases cannot safely establish the provider/model against operator exclusions.
    if (entry.harness === "opencode" && (!/^[\w.-]+\/[\w][\w./:-]*$/.test(entry.configured.model)
      || /(^|\/)(unknown|undefined|null|auto|default)(\/|$)/i.test(entry.configured.model))) {
      entry.blocked = "OpenCode provider/model cannot be established from the recorded settings; configure an explicit allowed provider/model through native setup before authorizing a new suite. No model call made.";
      checkpoint(); continue;
    }
    if (entry.harness === "goose" && [entry.configured.provider, entry.configured.model].some(value =>
      !value || safeLabel(value) !== value || /(^|\/)(unknown|undefined|null|auto|default)(\/|$)/i.test(value))) {
      entry.blocked = "Goose provider/model cannot be established from the recorded settings; configure explicit allowed provider and model selectors through native setup before authorizing a new suite. No model call made.";
      checkpoint(); continue;
    }
    if (!invocation.versions[entry.harness]?.ok) {
      entry.blocked = `version preflight failed (${invocation.versions[entry.harness]?.detail || "missing check"}); install ${entry.harness} ${MIN_VERSIONS[entry.harness]} or newer at ${invocation.binaries[entry.harness] || "the configured bin path"}`;
      entry.blockedInvocation = invocationIndex;
      checkpoint(); continue;
    }
    if (entry.blockedInvocation !== undefined) { delete entry.blocked; delete entry.blockedInvocation; }
    if (!retry) Object.assign(entry, fixture(join(root, id)));
    else if (retryPhase === "start" && !entry.previousStartFixture) {
      // A parser defect may be discovered after real edits/commits/pushes. Preserve
      // that evidence and retry the start in a distinct pristine checkout/remote.
      const previous = { cwd: entry.cwd, remote: entry.remote, initial: entry.initial, requestedSession: entry.requestedSession };
      const fresh = fixture(mkdtempSync(join(root, id, "start-retry-")));
      entry.previousStartFixture = previous;
      Object.assign(entry, fresh, { requestedSession: adapterFor(entry.harness).newSession() });
      checkpoint();
    }
    const firstPhase = retry ? retryPhase : "start";
    const first = await turn(entry, firstPhase, retry ? 2 : 1);
    if (!first) break;
    if (first.isolationFailure) { report.isolationFailure = entry.id; break; }
    if (first.status === "passed" && firstPhase === "start" && !entry.turns.some(t => t.phase === "resume")) {
      const resumed = await turn(entry, "resume", 1);
      if (!resumed) break;
      if (resumed.isolationFailure) { report.isolationFailure = entry.id; break; }
    }
    if (!entry.turns.some(t => t.phase === "resume")) entry.resumeBlocked = "Start was not verified; no resume model call made.";
  }
  report.endedAt = new Date().toISOString();
  report.elapsedMs = Date.parse(report.endedAt) - Date.parse(report.startedAt);
  report.unstarted = selected.filter(id => !report.cases.some(c => c.id === id));
  checkpoint();
  process.exitCode = report.unstarted.length || report.cases.some(c => c.blocked || ["start", "resume"].some(phase => c.turns.findLast(t => t.phase === phase)?.status !== "passed")) ? 1 : 0;
} finally {
  clearTimeout(watchdog);
  if (active) {
    requestStop();
    await active.runner.waitForKill(active.id);
  }
  if (stopError) throw stopError;
}
