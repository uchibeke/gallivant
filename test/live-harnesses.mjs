// Opt-in, sequential model calls. Deliberately outside the ordinary *.test.mjs glob.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { adapterFor, assertSafeArgv, buildRun } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { isOurProcess, makeRunner } from "../lib/run.mjs";
import { checkVersion } from "../lib/probe.mjs";
import { BRANCH, NAMED_CASES, TURN_MS, SUITE_MS, classify, codingPrompt, costEvidence, effectiveModels, openSuiteLedger, parseEvents, refusalEvidence, safeLabel, selection, sessionIdentity, testExecution, verifyCheckout, verifySessionDirectory, verifyStartFixture } from "./live-support.mjs";

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
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const json = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const sourceFiles = ["lib/harness.mjs", "lib/run.mjs", "lib/git.mjs", "test/live-harnesses.mjs", "test/live-support.mjs"];
const source = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  sha256: Object.fromEntries(sourceFiles.map(p => [p, createHash("sha256").update(readFileSync(join(repo, p))).digest("hex")])),
};
const ledgerPath = join(root, "report.json");
const report = retry || append ? openSuiteLedger(root) : { startedAt: new Date().toISOString(), source, privateEvidence: root, turnLimitMs: TURN_MS, suiteLimitMs: SUITE_MS, cases: [] };
const deadline = Date.parse(report.startedAt) + SUITE_MS;
const checkpoint = () => save(ledgerPath, report);
const identity = { name: "Live adapter probe", email: "probe@example.invalid" };
const config = { harness: Object.fromEntries(["claude", "codex", "gemini", "opencode", "goose"].map(h => [h, { bin: h }])) };
// Gallivant may configure a different binary from PATH. Copy only binary selectors into the test config.
const operatorConfig = json(join(homedir(), ".gallivant", "config.json"));
for (const [harness, configured] of Object.entries(operatorConfig?.harness || {})) {
  if (config.harness[harness] && typeof configured.bin === "string") config.harness[harness].bin = configured.bin;
}
let active = null;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (active) active.runner.kill(active.id);
  report.interrupted = signal;
  checkpoint();
  process.exitCode = 1;
});
const watchdog = setTimeout(() => {
  report.suiteTimedOut = true;
  if (active) active.runner.kill(active.id);
  checkpoint();
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
  const env = { ...process.env, ...runEnv(config, null, identity, cwd) };
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
  if (harness === "opencode" && (NAMED_CASES[entry.id] || previousTurn)) overrides.push("--model", NAMED_CASES[entry.id]?.model || previousTurn.models[0]);
  if (harness === "gemini" && (previousTurn || entry.configured.model !== "unknown")) overrides.push("--model", previousTurn?.models[0] || entry.configured.model);
  if (harness === "goose" && entry.configured.provider !== "unknown" && entry.configured.model !== "unknown") overrides.push("--provider", entry.configured.provider, "--model", entry.configured.model);
  spec.args.splice(harness === "gemini" ? 0 : spec.args.length - (harness === "goose" ? 2 : 1), 0, ...overrides);
  assertSafeArgv(spec.args);
  const env = { ...process.env, ...runEnv(config, null, identity, cwd), ...spec.env };
  if (phase === "start") verifyStartFixture({ ...entry, env });
  const startedAt = new Date().toISOString();
  const job = runner.start(`${phase}-${attempt}`, spec.cmd, spec.args, { cwd, env });
  active = { runner, id: job.id };
  const record = { phase, attempt, startedAt, source, command: [spec.cmd, ...spec.args.slice(0, -1), "<prompt in private cmd.json>"], run: relative(root, runner.dirOf(job.id)), status: "running" };
  entry.turns.push(record);
  checkpoint();
  process.stdout.write(`${entry.id} ${phase} attempt ${attempt}: ${record.run}\n`);
  // Reserve the runner's five-second TERM -> KILL grace inside the hard budget.
  const limit = Math.min(Date.parse(startedAt) + TURN_MS, deadline) - 6_000;
  let timedOut = false;
  let refused = false;
  while (runner.read(job.id)?.exit === null) {
    if (["guardrail", "permissions", "sandbox"].includes(classify(refusalEvidence(runner.lines(job.id))).category)) {
      assert.ok(runner.kill(job.id) || runner.read(job.id)?.exit !== null, "Cannot stop refused process; stop suite and resolve host process permissions");
      refused = true; break;
    }
    if (Date.now() >= limit || report.interrupted || report.suiteTimedOut) {
      assert.ok(runner.kill(job.id) || runner.read(job.id)?.exit !== null, "Cannot enforce deadline; stop suite and resolve host process permissions");
      timedOut = true; break;
    }
    await delay(200);
  }
  // Wait for makeRunner's process-group SIGKILL fallback before launching another harness.
  if (timedOut || refused) await delay(5_100);
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
    if (harness === "opencode" && NAMED_CASES[entry.id]) assert.equal(record.models[0], NAMED_CASES[entry.id].model);
    if (harness === "goose") assert.equal(record.models[0], `${entry.configured.provider}/${entry.configured.model}`);
    record.testToolCalls = testExecution(harness, lines, exported).filter(id => !previousTurn?.testToolCalls?.includes(id));
    assert.ok(record.testToolCalls.length, "No successful node:test tool execution in harness evidence");
    record.verification = verifyCheckout({ cwd, remote, env, previous: previousTurn?.verification.head || entry.initial, phase, evidence });
    record.status = "passed";
  } catch (e) {
    writeFileSync(join(evidence, `${phase}-${attempt}-verifier.txt`), e.stack, { mode: 0o600 });
    record.status = classified.category === "unclassified" ? "failed" : "blocked";
    record.failure = { ...classified, evidence: `${entry.id}/${phase}-${attempt}-verifier.txt` };
  }
  checkpoint();
  process.stdout.write(`${entry.id} ${phase}: ${record.status}; ${record.failure?.category || record.models.join(", ")}; ${record.elapsedMs}ms\n`);
  return record;
}

try {
  process.stdout.write(`Private evidence: ${root}\n`);
  if (!retry && !append) {
    report.versions = {};
    for (const harness of Object.keys(config.harness)) report.versions[harness] = await checkVersion(harness, config);
    report.binaries = Object.fromEntries(Object.entries(config.harness).map(([h, value]) => [h, value.bin]));
    report.pathVersions = {};
    for (const [harness, value] of Object.entries(config.harness)) {
      if (value.bin !== harness) report.pathVersions[harness] = await checkVersion(harness, { harness: { [harness]: { bin: harness } } });
    }
    checkpoint();
  }
  for (const id of selected) {
    if (Date.now() >= deadline || report.interrupted || report.suiteTimedOut) break;
    let entry = report.cases.find(c => c.id === id);
    if (retry) {
      assert.ok(entry && !entry.retry, "Only one targeted retry is allowed per combination");
      const failed = entry.turns.findLast(t => t.phase === retryPhase);
      assert.ok(failed && failed.status === "failed" && failed.failure.category === "unclassified", "External blocks and denials cannot be retried as adapter fixes");
      assert.notDeepEqual(source.sha256, failed.source.sha256, "A targeted retry requires a source change");
      const failedLines = readFileSync(join(root, failed.run, "job.log"), "utf8").split("\n");
      assert.equal(classify(`${refusalEvidence(failedLines)}\n${adapterFor(entry.harness).outcome(failedLines).error || ""}`).category, "unclassified", "A corrected parser must not turn an earlier unclassified external failure into a retry");
      entry.retry = { phase: retryPhase, fix, source };
      checkpoint();
    } else {
      assert.ok(!entry, "This case already ran; only a justified targeted retry can repeat it");
      const harness = id.startsWith("opencode") ? "opencode" : id.startsWith("goose") ? "goose" : id;
      const dir = join(root, id);
      mkdirSync(dir, { mode: 0o700 });
      entry = { id, harness, configured: configured(harness), requestedSession: adapterFor(harness).newSession(), turns: [] };
      if (NAMED_CASES[id]) entry.configured = { ...NAMED_CASES[id] };
      assert.ok(!report.cases.some(c => c.harness === harness && JSON.stringify(c.configured) === JSON.stringify(entry.configured)), "This provider/model combination already ran");
      report.cases.push(entry);
      if (/deepseek/i.test(JSON.stringify(entry.configured))) { entry.blocked = "DeepSeek excluded by the current operator scope; no model call made."; checkpoint(); continue; }
      if (!report.versions[harness].ok) { entry.blocked = "version preflight failed; install the adapter's minimum supported version"; checkpoint(); continue; }
      Object.assign(entry, fixture(dir));
    }
    const firstPhase = retry ? retryPhase : "start";
    const first = await turn(entry, firstPhase, retry ? 2 : 1);
    if (first.isolationFailure) { report.isolationFailure = entry.id; break; }
    if (first.status === "passed" && firstPhase === "start" && !entry.turns.some(t => t.phase === "resume")) {
      const resumed = await turn(entry, "resume", 1);
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
  if (active) active.runner.kill(active.id);
}
