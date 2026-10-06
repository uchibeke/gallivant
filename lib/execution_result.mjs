// Result transport ends here. Git/gh own the one publication path; the existing
// tick still owns readiness, receipts, review rounds, conflicts and human merge.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { repositoryPath, repositoryRelativePath, assertRepositoryTargets, readRepositoryText, writeRepositoryText } from "./repository_files.mjs";
import { isOurBranch, runEnv } from "./git.mjs";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { execFileAsync, remoteMatches } from "./gh.mjs";
import { parsePrd, verifyCommands } from "./prd.mjs";
import { normalizePublicBody } from "./block.mjs";
import { assertPublicText, assertNoNul } from "./public_output.mjs";
import { executionError, ownsProviderSession, assertTerminalOutcome, redact } from "./execution_io.mjs";
const hash = text => text === null ? null : createHash("sha256").update(text).digest("hex");

// Verification executes provider-controlled code, never coordinator credentials.
// Keep only tooling/display basics and an empty private profile for this list.
export function verificationEnvironment(root, source = process.env) {
  const basics = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "CI"];
  const env = Object.fromEntries(basics.filter(key => typeof source[key] === "string").map(key => [key, source[key]]));
  const git = runEnv(), count = Number(git.GIT_CONFIG_COUNT);
  return { ...env, PATH: env.PATH || "/usr/bin:/bin", ...git,
    [`GIT_CONFIG_KEY_${count}`]: "credential.helper", [`GIT_CONFIG_VALUE_${count}`]: "", GIT_CONFIG_COUNT: String(count + 1),
    HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: ensureDir(join(root, "config")), XDG_DATA_HOME: ensureDir(join(root, "data")),
    XDG_STATE_HOME: ensureDir(join(root, "state")), XDG_CACHE_HOME: ensureDir(join(root, "cache")),
    TMPDIR: ensureDir(join(root, "tmp")), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    GH_CONFIG_DIR: ensureDir(join(root, "gh")), GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: "false", GIT_ASKPASS: "false", SSH_ASKPASS: "false", NPM_CONFIG_GLOBALCONFIG: "/dev/null" };
}

export function executionResultCheckpoint(execution, run = execution?.current?.()) {
  return run && execution?.dirOf ? readJson(join(execution.dirOf(run.id), "result-application.json")) : null;
}

export async function reconcileExecutionResult(ctx, input) {
  const checkpoint = join(input.dir, "result-application.json");
  if (readJson(checkpoint)?.phase === "blocked") throw executionError("EXECUTION_RESULT_BLOCKED", "result publication is blocked; inspect result-application.json, result.json and any verification.json, then explicitly resume for correction");
  try { return await applyExecutionResult(ctx, input); }
  catch (error) {
    if (error.code === "EXECUTION_RESULT" && error.publicationValidation) {
      const prior = readJson(checkpoint, {});
      writeJsonAtomic(checkpoint, { ...prior, fingerprint: prior.fingerprint ?? hash(JSON.stringify(input.result)),
        phase: "blocked", reason: "result-validation", blockedAt: new Date().toISOString() });
    }
    throw error;
  }
}

async function applyExecutionResult(ctx, { id, entry, result, dir, verify = execFileAsync }) {
  // Collection and unavailable I/O remain retryable; rejected owned publication
  // input requires an explicit corrective run, with no repeated application.
  const fail = (message, retryable = false) => { throw Object.assign(executionError("EXECUTION_RESULT", message), { publicationValidation: !retryable }); };
  const validate = fn => { try { return fn(); } catch (error) { if (error.code) throw error; fail(error.message); } };
  const assertNotStopped = () => {
    const current = ctx.state?.get(id) || entry;
    if (current.dispatch_stopped || current.execution?.quarantined) fail("late results are quarantined after a concurrent stop", true);
  };
  assertNotStopped();
  const ex = entry.execution;
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("result requires a bounded object manifest");
  if (!ex || result.taskId !== id || result.runId !== ex.runId || result.providerJobId !== ex.providerJobId || result.turnId !== ex.turnId || result.inputHead !== ex.inputHead || !ownsProviderSession(ex.sessionId, result.sessionId)) fail("result does not belong to this task/run/root turn/input head/session");
  try { assertTerminalOutcome(ex, result.outcome); } catch (error) { fail(error.message); }
  if (result.outcome?.ok === false) fail("failed root-turn results cannot authorize publication; preserve diagnostics and explicitly resume for correction");
  if (entry.dispatch_stopped || ex.quarantined || ["cancelled", "cancellation-requested"].includes(ex.providerState)) fail("late results are quarantined", true);
  if (!isOurBranch(entry.branch) || entry.branch === entry.base || result.repo !== entry.repo || result.branch !== entry.branch) fail("result branch is not owned by the task");
  if (await ctx.git.currentBranch(entry.worktree) !== entry.branch || !remoteMatches(await ctx.git.originOf(entry.worktree), entry.repo)) fail("checkout repository/branch differs from recorded ownership");
  if (!/^[a-f0-9]{40,64}$/.test(result.inputHead || "")) fail("result requires an exact input revision");
  if (!result.pr || typeof result.pr.title !== "string" || typeof result.pr.body !== "string") fail("result requires a reviewable PR title and receipt body");
  validate(() => assertPublicText(result.pr.title, "PR title"));
  validate(() => assertNoNul(result.pr.body, "PR body"));
  const body = validate(() => normalizePublicBody(result.pr.body, { identity: { prd: entry.prd, harness: entry.harness, session: entry.session || result.sessionId, branch: entry.branch }, taskId: id }));
  validate(() => assertPublicText(body, "PR body"));
  const checkpoint = join(dir, "result-application.json");
  const prior = readJson(checkpoint, {});
  const fingerprint = hash(JSON.stringify(result));
  if (prior.fingerprint && prior.fingerprint !== fingerprint) fail("run already owns a different result; inspect the application checkpoint");
  const block = (reason, message, appliedHead = prior.appliedHead) => {
    writeJsonAtomic(checkpoint, { ...readJson(checkpoint, {}), fingerprint, phase: "blocked", appliedHead, reason, blockedAt: new Date().toISOString() });
    throw executionError("EXECUTION_RESULT_BLOCKED", `${message}; preserve the checkout and verification.json, then explicitly resume the same session for a corrective run`);
  };
  if (prior.phase === "blocked") throw executionError("EXECUTION_RESULT_BLOCKED", "result publication is blocked; inspect verification.json and explicitly resume the same session for a corrective run");
  // Commands can have side effects. A lost verification acknowledgement cannot
  // be repaired by replaying the command list on the next coordinator poll.
  if (prior.phase === "verifying") block("verification-interrupted", "verification acknowledgement is unresolved; commands will not be replayed");
  if (prior.phase === "published") return { head: prior.appliedHead, pr: { number: prior.pr, url: prior.url }, evidence: readJson(join(dir, "verification.json"), {}).evidence || [] };
  const verified = prior.phase === "verified";
  const head = await ctx.git.head(entry.worktree);
  const validateTargets = async paths => {
    let tracked;
    try { tracked = await ctx.git.trackedPaths(entry.worktree); }
    catch { fail("tracked repository paths unavailable; preserve the checkout and retrieve complete Git path metadata before publication", true); }
    try { assertRepositoryTargets([], tracked); }
    catch (error) { fail(error.message, true); }
    try { assertRepositoryTargets(paths ?? tracked, tracked); }
    catch (error) { fail(error.message); }
  };
  if (result.pushedHead) {
    if (result.files?.length || await ctx.gh.refSha(entry.repo, entry.branch) !== result.pushedHead || !await ctx.gh.containsCommit(entry.repo, entry.branch, result.inputHead)) fail("pushed result revision or input ancestry cannot be verified");
    if (head !== result.pushedHead) fail("reconcile the exact pushed provider branch into its isolated checkout before collection");
    await validateTargets();
  } else {
    if (!Array.isArray(result.files) || !result.files.length || result.files.length > 100 || Buffer.byteLength(JSON.stringify(result.files)) > 1_048_576) fail("missing, truncated or oversized artifact manifest; use bounded verified artifacts");
    const paths = new Set(), changes = [];
    for (const file of result.files) {
      if (!file || (file.text !== null && typeof file.text !== "string") || file.text?.includes("\0")) fail("duplicate or invalid result file");
      const path = validate(() => repositoryRelativePath(entry.worktree, file.path, { allowMissingParents: true }));
      paths.add(path);
      changes.push({ ...file, path });
    }
    await validateTargets(changes.map(file => file.path));
    let modesMatch;
    try { modesMatch = await ctx.git.resultModesMatch(entry.worktree, result.inputHead, [...paths]); }
    catch { fail("artifact mode metadata unavailable; retrieve complete input, HEAD, index and filesystem modes before publication", true); }
    if (typeof modesMatch !== "boolean") fail("artifact mode metadata unavailable; retrieve complete input, HEAD, index and filesystem modes before publication", true);
    if (modesMatch !== true) fail("artifact target mode differs from its input revision; text artifacts cannot authorize mode changes");
    if (!verified) {
      // Resolve the entire manifest before reading content or applying any file.
      // Commit/recovery ownership uses these same canonical repository targets.
      for (const file of changes) {
        let current = null;
        try { current = validate(() => readRepositoryText(entry.worktree, file.path)); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (file.afterHash !== hash(file.text)) fail("artifact content hash differs; result may be truncated");
        if (hash(current) !== file.beforeHash && hash(current) !== file.afterHash) fail("artifact base differs from owned checkout");
        file.current = current;
      }
      if (head !== result.inputHead && head !== prior.appliedHead) {
        const applied = changes.every(file => hash(file.current) === file.afterHash);
        if (!applied || !ctx.git.resultHeadMatches || !await ctx.git.resultHeadMatches(entry.worktree, result.inputHead, [...paths])) fail("input head changed; reconcile before applying a result");
      }
      assertNotStopped();
      writeJsonAtomic(checkpoint, { ...prior, fingerprint, phase: "applying", paths: [...paths] });
      for (const file of changes) if (hash(file.current) !== file.afterHash) {
        if (file.text === null) unlinkSync(validate(() => repositoryPath(entry.worktree, file.path)));
        else validate(() => writeRepositoryText(entry.worktree, file.path, file.text));
      }
      await ctx.git.commitResult(entry.worktree, [...paths]);
    }
  }
  const appliedHead = verified ? prior.appliedHead : await ctx.git.head(entry.worktree);
  const assertVerifiedTree = async () => {
    let revision, tree;
    try {
      revision = await ctx.git.head(entry.worktree);
      tree = await ctx.git.dirty(entry.worktree, { strict: true });
    } catch { block("verification-state-unavailable", "cannot verify the checkout revision and clean index/worktree", appliedHead); }
    if (revision !== appliedHead) block("verification-head-changed", "verification changed the input head; review that change before publishing", appliedHead);
    if (!tree || ![tree.modified, tree.untracked].every(count => Number.isInteger(count) && count >= 0)) block("verification-state-unavailable", "cannot verify clean index/worktree status", appliedHead);
    if (tree.modified || tree.untracked) block("verification-dirty", "verification requires a clean index/worktree; preserve uncommitted files before correction", appliedHead);
  };
  await assertVerifiedTree();
  const evidenceFile = join(dir, "verification.json");
  const savedEvidence = readJson(evidenceFile, {});
  let commands;
  try { commands = verifyCommands(parsePrd(ctx.readPrd(id), `${id}.md`)); }
  catch { block("verification-brief-unavailable", "cannot read the approved verification commands", appliedHead); }
  const evidence = verified ? savedEvidence.evidence : [];
  if (verified && (savedEvidence.head !== appliedHead || !Array.isArray(evidence) || evidence.length !== commands.length || evidence.some((item, i) => item.command !== commands[i] || item.head !== appliedHead || item.exit !== 0 || item.source !== "coordinator-executed"))) {
    block("verification-evidence-unavailable", "saved verification evidence does not cover this revision and approved command list", appliedHead);
  }
  const saveEvidence = () => writeJsonAtomic(evidenceFile, { version: 1, head: appliedHead, evidence });
  const secrets = Object.entries(process.env).filter(([key]) => /token|password|secret|api.?key/i.test(key)).map(([, value]) => value);
  const execution = ctx.executionFor?.(id, entry.harness);
  const cleanOutput = output => execution?.sanitize ? execution.sanitize(output, ex.runId, secrets) : redact(output, secrets);
  if (!verified) {
    writeJsonAtomic(checkpoint, { fingerprint, phase: "verifying", appliedHead });
    saveEvidence();
  }
  let verificationHome;
  try {
    const env = !verified && commands.length ? verificationEnvironment(verificationHome = mkdtempSync(join(dir, "verification-"))) : null;
    for (const command of verified ? [] : commands) {
      assertNotStopped();
      const startedAt = new Date().toISOString();
      try {
        const observed = await verify("/bin/sh", ["-c", command], { cwd: entry.worktree, timeout: 120_000, maxBuffer: 262_144, env });
        evidence.push({ command, head: appliedHead, startedAt, finishedAt: new Date().toISOString(), exit: 0, source: "coordinator-executed", output: cleanOutput(`${observed.stdout || ""}${observed.stderr || ""}`) });
      } catch (e) {
        evidence.push({ command, head: appliedHead, startedAt, finishedAt: new Date().toISOString(), exit: typeof e.code === "number" ? e.code : null, source: "coordinator-executed", output: cleanOutput(`${e.stdout || ""}${e.stderr || ""}`) });
        saveEvidence();
        block("verification-failed", "approved verification failed", appliedHead);
      }
      saveEvidence();
      await assertVerifiedTree();
    }
  } finally {
    if (verificationHome) rmSync(verificationHome, { recursive: true, force: true });
  }
  // Empty checks remain empty evidence, never a claim that tests passed.
  saveEvidence();
  await assertVerifiedTree();
  writeJsonAtomic(checkpoint, { fingerprint, phase: "verified", appliedHead });
  assertNotStopped();
  await ctx.git.pushResult(entry.worktree, entry.branch);
  await assertVerifiedTree();
  assertNotStopped();
  const pr = await ctx.gh.publishResultPr({ repo: entry.repo, branch: entry.branch, base: entry.base, title: result.pr.title, body });
  writeJsonAtomic(checkpoint, { fingerprint, phase: "published", appliedHead, pr: pr.number, url: pr.url });
  return { head: appliedHead, pr, evidence };
}
