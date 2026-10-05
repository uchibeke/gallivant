// Result transport ends here. Git/gh own the one publication path; the existing
// tick still owns readiness, receipts, review rounds, conflicts and human merge.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { repositoryPath, readRepositoryText, writeRepositoryText } from "./repository_files.mjs";
import { isOurBranch } from "./git.mjs";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { execFileAsync, remoteMatches } from "./gh.mjs";
import { parsePrd, verifyCommands } from "./prd.mjs";
import { normalizePublicBody } from "./block.mjs";
import { assertPublicText } from "./public_output.mjs";
import { executionError, redact } from "./execution_io.mjs";
const hash = text => text === null ? null : createHash("sha256").update(text).digest("hex");

export async function reconcileExecutionResult(ctx, { id, entry, result, dir, verify = execFileAsync }) {
  const fail = message => { throw executionError("EXECUTION_RESULT", message); };
  const assertNotStopped = () => {
    const current = ctx.state?.get(id) || entry;
    if (current.dispatch_stopped || current.execution?.quarantined) fail("late results are quarantined after a concurrent stop");
  };
  assertNotStopped();
  const ex = entry.execution;
  if (!ex || result.taskId !== id || result.runId !== ex.runId || result.providerJobId !== ex.providerJobId || result.turnId !== ex.turnId || result.inputHead !== ex.inputHead) fail("result does not belong to this task/run/root turn/input head");
  if (entry.dispatch_stopped || ex.quarantined || ["cancelled", "cancellation-requested"].includes(ex.providerState)) fail("late results are quarantined");
  if (!isOurBranch(entry.branch) || entry.branch === entry.base || result.repo !== entry.repo || result.branch !== entry.branch) fail("result branch is not owned by the task");
  if (await ctx.git.currentBranch(entry.worktree) !== entry.branch || !remoteMatches(await ctx.git.originOf(entry.worktree), entry.repo)) fail("checkout repository/branch differs from recorded ownership");
  if (!/^[a-f0-9]{40,64}$/.test(result.inputHead || "")) fail("result requires an exact input revision");
  if (!result.pr || typeof result.pr.title !== "string" || typeof result.pr.body !== "string") fail("result requires a reviewable PR title and receipt body");
  assertPublicText(result.pr.title, "PR title");
  const body = normalizePublicBody(result.pr.body, { identity: { prd: entry.prd, harness: entry.harness, session: entry.session || result.sessionId, branch: entry.branch }, taskId: id });
  assertPublicText(body, "PR body");
  const checkpoint = join(dir, "result-application.json");
  const prior = readJson(checkpoint, {});
  const fingerprint = hash(JSON.stringify(result));
  if (prior.fingerprint && prior.fingerprint !== fingerprint) fail("run already owns a different result; inspect the application checkpoint");
  const head = await ctx.git.head(entry.worktree);
  if (result.pushedHead) {
    if (result.files?.length || await ctx.gh.refSha(entry.repo, entry.branch) !== result.pushedHead || !await ctx.gh.containsCommit(entry.repo, entry.branch, result.inputHead)) fail("pushed result revision or input ancestry cannot be verified");
    if (head !== result.pushedHead) fail("reconcile the exact pushed provider branch into its isolated checkout before collection");
  } else {
    if (!Array.isArray(result.files) || !result.files.length || result.files.length > 100 || Buffer.byteLength(JSON.stringify(result.files)) > 1_048_576) fail("missing, truncated or oversized artifact manifest; use bounded verified artifacts");
    const paths = new Set(), changes = [];
    for (const file of result.files) {
      if (!file || paths.has(file.path) || (file.text !== null && typeof file.text !== "string") || file.text?.includes("\0")) fail("duplicate or invalid result file");
      paths.add(file.path);
      repositoryPath(entry.worktree, file.path, { allowMissingParents: true });
      let current = null;
      try { current = readRepositoryText(entry.worktree, file.path); } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (file.afterHash !== hash(file.text)) fail("artifact content hash differs; result may be truncated");
      if (hash(current) !== file.beforeHash && hash(current) !== file.afterHash) fail("artifact base differs from owned checkout");
      changes.push({ ...file, current });
    }
    if (head !== result.inputHead && head !== prior.appliedHead) {
      const applied = changes.every(file => hash(file.current) === file.afterHash);
      if (!applied || !ctx.git.resultHeadMatches || !await ctx.git.resultHeadMatches(entry.worktree, result.inputHead, [...paths])) fail("input head changed; reconcile before applying a result");
    }
    assertNotStopped();
    writeJsonAtomic(checkpoint, { ...prior, fingerprint, phase: "applying", paths: [...paths] });
    for (const file of changes) if (hash(file.current) !== file.afterHash) {
      if (file.text === null) unlinkSync(repositoryPath(entry.worktree, file.path));
      else writeRepositoryText(entry.worktree, file.path, file.text);
    }
    await ctx.git.commitResult(entry.worktree, [...paths]);
  }
  const appliedHead = await ctx.git.head(entry.worktree);
  writeJsonAtomic(checkpoint, { fingerprint, phase: "verifying", appliedHead });
  const commands = verifyCommands(parsePrd(ctx.readPrd(id), `${id}.md`));
  const evidence = [];
  const secrets = Object.entries(process.env).filter(([key]) => /token|password|secret|api.?key/i.test(key)).map(([, value]) => value);
  for (const command of commands) {
    const startedAt = new Date().toISOString();
    try {
      const observed = await verify(process.env.SHELL || "/bin/sh", ["-lc", command], { cwd: entry.worktree, timeout: 120_000, maxBuffer: 262_144 });
      evidence.push({ command, head: appliedHead, startedAt, finishedAt: new Date().toISOString(), exit: 0, source: "coordinator-executed", output: redact(`${observed.stdout || ""}${observed.stderr || ""}`, secrets) });
    } catch (e) {
      evidence.push({ command, head: appliedHead, startedAt, finishedAt: new Date().toISOString(), exit: typeof e.code === "number" ? e.code : null, source: "coordinator-executed", output: redact(`${e.stdout || ""}${e.stderr || ""}`, secrets) });
      writeJsonAtomic(join(dir, "verification.json"), { version: 1, head: appliedHead, evidence });
      fail("approved verification failed; preserve artifacts and inspect verification.json before publication");
    }
  }
  // Empty checks remain empty evidence, never a claim that tests passed.
  writeJsonAtomic(join(dir, "verification.json"), { version: 1, head: appliedHead, evidence });
  if (await ctx.git.head(entry.worktree) !== appliedHead) fail("verification changed the input head; review that change before publishing");
  assertNotStopped();
  await ctx.git.pushResult(entry.worktree, entry.branch);
  assertNotStopped();
  const pr = await ctx.gh.publishResultPr({ repo: entry.repo, branch: entry.branch, base: entry.base, title: result.pr.title, body });
  writeJsonAtomic(checkpoint, { fingerprint, phase: "published", appliedHead, pr: pr.number, url: pr.url });
  return { head: appliedHead, pr, evidence };
}
