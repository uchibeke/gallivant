// Opt-in G8 phases through the existing start/resume/coordinator. No model call
// occurs from npm test or preflight, and no failed/unknown phase is redispatched.
import { resolve, relative, isAbsolute, join } from "node:path";
import { readJson, writeJsonAtomic, ensureDir } from "../lib/fs.mjs";
import { makeContext } from "../lib/context.mjs";
import { checkCloudAccess } from "../lib/codex_cloud.mjs";
import { requestFor } from "../lib/sources/index.mjs";
import { start } from "../lib/commands/start.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeTick } from "../lib/tick.mjs";
import { acquireDaemon } from "../lib/daemon.mjs";
import { entryId } from "../lib/state.mjs";
import { contentHash } from "../lib/openai_agents_sources.mjs";
import { deriveEvents, makeTrust } from "../lib/events.mjs";
import { cloudLedgerBlockers, cloudRequestBlockers, cloudCorrectionMatches } from "./codex-cloud-live-validation.mjs";
const phase = process.argv.find(value => value.startsWith("--phase="))?.slice(8) || "preflight";
const execute = process.argv.includes("--execute");
const report = { version: 1, kind: "live", status: "unverified", phase, at: new Date().toISOString(), blockers: [], costUsd: null, costSource: "chatgpt-account", continuity: "successor-task" };
const required = ["CODEX_CLOUD_LIVE_HOME", "CODEX_CLOUD_LIVE_PRD", "CODEX_CLOUD_LIVE_REPO", "CODEX_CLOUD_CAMPAIGN_LEDGER"];
for (const key of required) if (!process.env[key]) report.blockers.push(`${key} absent`);
try { if (!report.blockers.length) {
  const home = resolve(process.env.CODEX_CLOUD_LIVE_HOME), ledgerPath = resolve(process.env.CODEX_CLOUD_CAMPAIGN_LEDGER), within = relative(process.cwd(), ledgerPath);
  if (!within || !within.startsWith("..") && !isAbsolute(within)) throw new Error("campaign ledger must stay outside the repository/public package");
  const ctx = makeContext({ home }), config = ctx.config.harness["codex-cloud"], ledger = readJson(ledgerPath), evidencePath = join(home, "cloud-live-evidence.json");
  const access = await checkCloudAccess(config, { signal: AbortSignal.timeout(10_000) });
  if (!access.ok) report.blockers.push(`${access.detail}: ${access.fix}`);
  report.blockers.push(...cloudLedgerBlockers(config, ledger, process.env.CODEX_CLOUD_LIVE_REPO));
  const request = await requestFor(process.env.CODEX_CLOUD_LIVE_PRD, { git: ctx.git, gh: ctx.gh });
  report.blockers.push(...cloudRequestBlockers(config, request, process.env.CODEX_CLOUD_LIVE_REPO));
  const campaign = readJson(evidencePath, { version: 1, status: "unverified", phases: {}, taskId: entryId(request.repo, request.id) });
  if (execute && !["implementation", "correction"].includes(phase)) report.blockers.push("execution needs --phase=implementation or --phase=correction");
  if (execute && campaign.phases[phase]) report.blockers.push("phase already has a dispatch intent; reconcile saved task instead of submitting again");
  if (phase === "correction" && (!campaign.pr || !campaign.sessionId || !process.env.CODEX_CLOUD_LIVE_CORRECTION)) report.blockers.push("correction requires saved initial task/PR and CODEX_CLOUD_LIVE_CORRECTION describing the actual forced finding");
  if (execute && !report.blockers.length) {
    const lock = acquireDaemon(ensureDir(home));
    try {
      const ownLogin = await ctx.gh.user(); let findings = [];
      if (phase === "correction") {
        const entry = ctx.state.get(campaign.taskId);
        if (!cloudCorrectionMatches(entry, request, campaign)) throw new Error("saved campaign task/session/PR differs; no correction authorized");
        const [pr, reviews, inline, comments] = await Promise.all([ctx.gh.prView(entry.repo, entry.pr), ctx.gh.reviews(entry.repo, entry.pr), ctx.gh.inlineComments(entry.repo, entry.pr, entry.cursor.since), ctx.gh.issueComments(entry.repo, entry.pr, entry.cursor.since)]);
        findings = deriveEvents({ pr, reviews, inline, comments, entry, trust: makeTrust(ctx.config, ownLogin) }).events;
        if (!findings.length || pr.headRefOid !== await ctx.git.head(entry.worktree)) throw new Error("an actual current-head failed check or trusted review finding is required");
        findings = findings.map(({ kind, id, name, url, runId }) => ({ kind, id, name, url, runId, head: pr.headRefOid }));
      }
      ledger.cloud.remainingTasks--; ledger.cloud.phases ??= []; ledger.cloud.phases.push({ phase, at: report.at, status: "reserved", costUsd: null }); writeJsonAtomic(ledgerPath, ledger);
      campaign.phases[phase] = { status: "dispatch-intent", at: report.at, findings }; writeJsonAtomic(evidencePath, campaign);
      if (phase === "implementation") await start(ctx, { path: process.env.CODEX_CLOUD_LIVE_PRD });
      else await resume(ctx, { handle: campaign.taskId, note: process.env.CODEX_CLOUD_LIVE_CORRECTION });
      let tick = makeTick({ ...ctx, ownLogin }), restarted = false, observedAfterRestart = false;
      const until = Date.now() + ledger.cloud.taskSeconds * 1000;
      while (Date.now() < until) {
        observedAfterRestart ||= restarted;
        await tick.tickEntry(campaign.taskId, ctx.state.get(campaign.taskId), { settleOnly: true });
        const job = ctx.executionFor(campaign.taskId, "codex-cloud").current();
        if (!restarted) { tick = makeTick({ ...makeContext({ home }), ownLogin }); restarted = true; continue; }
        if (job?.execution.collected && !job.running) break;
        await new Promise(done => setTimeout(done, 1000));
      }
      const execution = ctx.executionFor(campaign.taskId, "codex-cloud"), job = execution.current(), entry = ctx.state.get(campaign.taskId);
      if (job?.running) { await execution.cancel("live-test-deadline"); throw new Error("observation deadline reached; future dispatch fenced, native remote cancellation unavailable and execution may continue at retained task link"); }
      const result = job && execution.result(job.id), verification = job && readJson(join(execution.dirOf(job.id), "verification.json"));
      if (!observedAfterRestart || !result?.outcome.ok || !result.files?.length || !verification?.evidence?.length || verification.evidence.some(test => test.exit !== 0) || !entry?.pr || campaign.pr && campaign.pr !== entry.pr || campaign.sessionId && campaign.sessionId !== entry.session) throw new Error("verified files/tests, observed restart or one logical PR/session evidence missing");
      const head = await ctx.git.head(entry.worktree);
      if (head !== await ctx.gh.refSha(entry.repo, entry.branch) || head !== verification.head) throw new Error("remote files and verification head differ");
      for (const file of result.files) {
        const actual = await ctx.gh.fileAtStrict(entry.repo, file.path, head);
        if (file.text !== actual || contentHash(actual) !== file.afterHash) throw new Error("remote result file bytes differ");
      }
      const previous = campaign.phases.implementation;
      if (phase === "correction" && (previous.providerTaskId === job.execution.providerJobId || job.execution.effective?.parentTaskId !== previous.providerTaskId || job.execution.effective?.continuity !== "successor-task")) throw new Error("actual successor continuity does not identify the initial task");
      campaign.sessionId = entry.session; campaign.pr = entry.pr;
      campaign.phases[phase] = { status: "verified", runId: job.id, providerTaskId: job.execution.providerJobId, providerAttemptId: null, attemptSelector: 1, continuity: job.execution.effective.continuity, parentTaskId: job.execution.effective.parentTaskId, taskUrl: job.execution.effective.taskUrl, head, pr: entry.pr, files: result.files.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })), tests: verification.evidence, findings, restarted, costUsd: null, costSource: "chatgpt-account", accountUsageEvidence: ledger.cloud.accountUsageEvidence };
      campaign.status = campaign.phases.implementation?.status === "verified" && campaign.phases.correction?.status === "verified" ? "verified" : "unverified";
      writeJsonAtomic(evidencePath, campaign); report.status = campaign.status; report.evidence = evidencePath;
    } catch (error) {
      report.blockers.push(error.code || error.message); campaign.status = "unverified"; if (campaign.phases[phase]) campaign.phases[phase].error = error.code || error.message; writeJsonAtomic(evidencePath, campaign);
    } finally { lock.release(); }
  }
} } catch (error) { report.blockers.push(error.code || error.message); }
if (!execute) report.blockers.push("preflight only; no paid implementation/correction evidence collected");
process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.status === "verified" ? 0 : 1;
