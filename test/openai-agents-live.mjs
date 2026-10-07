// Explicit, phase-bounded G8 campaign. Never runs from npm test.
import { resolve, relative, isAbsolute, join } from "node:path";
import { readJson, writeJsonAtomic, ensureDir } from "../lib/fs.mjs";
import { makeContext } from "../lib/context.mjs";
import { checkAgentsAccess } from "../lib/openai_agents.mjs";
import { requestFor } from "../lib/sources/index.mjs";
import { start } from "../lib/commands/start.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeTick } from "../lib/tick.mjs";
import { acquireDaemon } from "../lib/daemon.mjs";
import { deriveEvents, makeTrust } from "../lib/events.mjs";
const phase = process.argv.find(v => v.startsWith("--phase="))?.slice(8) || "preflight";
const execute = process.argv.includes("--execute");
const report = { version: 1, kind: "live", status: "unverified", phase, at: new Date().toISOString(), blockers: [], costUsd: null };
const required = ["OPENAI_AGENTS_LIVE_HOME", "OPENAI_AGENTS_LIVE_PRD", "OPENAI_AGENTS_LIVE_REPO", "OPENAI_AGENTS_CAMPAIGN_LEDGER"];
for (const key of required) if (!process.env[key]) report.blockers.push(`${key} absent`);
try { if (!report.blockers.length) {
  const home = resolve(process.env.OPENAI_AGENTS_LIVE_HOME), ledgerPath = resolve(process.env.OPENAI_AGENTS_CAMPAIGN_LEDGER);
  const within = relative(process.cwd(), ledgerPath);
  if (!within || (!within.startsWith("..") && !isAbsolute(within))) report.blockers.push("campaign ledger must be outside the repository/public package");
  else {
    const ctx = makeContext({ home }); const selected = ctx.config.harness["openai-agents"];
    const access = await checkAgentsAccess(selected, { signal: AbortSignal.timeout(10_000) });
    if (!access.ok) report.blockers.push(`${access.detail}: ${access.fix}`);
    const ledger = readJson(ledgerPath);
    const committedUsd = Array.isArray(ledger?.attempts) ? ledger.attempts.reduce((sum, attempt) => sum + Math.max(attempt.reservedUsd, attempt.observedCostUsd ?? 0), 0) : NaN;
    if (!Number.isFinite(committedUsd) || ledger.remainingUsd < 0 || ledger.remainingUsd > ledger.limitUsd || committedUsd + ledger.reservationUsd > ledger.limitUsd || ledger.attempts.some(a => !Number.isFinite(a.reservedUsd) || a.reservedUsd <= 0)) report.blockers.push("campaign remaining balance and previous reservations must fit the aggregate USD 10 allowance");
    if (!ledger || ledger.version !== 1 || ledger.limitUsd !== 10 || !Array.isArray(ledger.attempts) || !Number.isFinite(ledger.remainingUsd) || !Number.isFinite(ledger.reservationUsd) || ledger.reservationUsd <= 0 || ledger.reservationUsd > ledger.remainingUsd || ledger.reservationUsd > selected?.allowance?.reservedUsd || !ledger.pricing?.url?.startsWith("https://developers.openai.com/") || !Number.isFinite(Date.parse(ledger.pricing.checkedAt)) || Math.abs(Date.now() - Date.parse(ledger.pricing.checkedAt)) > 86_400_000 || !Number.isFinite(ledger.turnSeconds) || ledger.turnSeconds <= 0 || ledger.turnSeconds > 120) report.blockers.push("ledger requires remaining aggregate allowance, priced reservation, current official pricing and a turn deadline of at most 120 seconds");
    if (ledger?.attempts.some(a => !Number.isFinite(a.observedCostUsd) || a.observedCostUsd < 0)) report.blockers.push("previous paid cost unknown; reconcile API and hosted compute billing before another phase");
    const request = await requestFor(process.env.OPENAI_AGENTS_LIVE_PRD, { git: ctx.git, gh: ctx.gh });
    if (request.repo !== process.env.OPENAI_AGENTS_LIVE_REPO || request.harness !== "openai-agents") report.blockers.push("live brief must select the explicitly authorized disposable repository and openai-agents before dispatch");
    const campaign = readJson(join(home, "agents-live-evidence.json"), { version: 1, status: "unverified", phases: {} });
    if (phase === "correction" && (!campaign.taskId || !campaign.sessionId || !campaign.pr || !process.env.OPENAI_AGENTS_LIVE_CORRECTION)) report.blockers.push("correction requires saved implementation task/session/PR and OPENAI_AGENTS_LIVE_CORRECTION with the forced CI/review finding");
    if (execute && !["implementation", "correction"].includes(phase)) report.blockers.push("paid execution requires --phase=implementation or --phase=correction");
    if (execute && campaign.phases[phase]) report.blockers.push("phase already dispatched; preserve its evidence and recover the existing task rather than rerun");
    if (execute && !report.blockers.length) {
      const lock = acquireDaemon(ensureDir(home));
      let taskId;
      try {
        const ownLogin = await ctx.gh.user();
        let findings = [];
        if (phase === "correction") {
          const entry = ctx.state.get(campaign.taskId);
          if (!entry || entry.repo !== process.env.OPENAI_AGENTS_LIVE_REPO || entry.harness !== "openai-agents" || entry.session !== campaign.sessionId || entry.pr !== campaign.pr) throw new Error("saved campaign identity differs; no correction authorized");
          const [pr, reviews, inline, comments] = await Promise.all([ctx.gh.prView(entry.repo, entry.pr), ctx.gh.reviews(entry.repo, entry.pr), ctx.gh.inlineComments(entry.repo, entry.pr, entry.cursor.since), ctx.gh.issueComments(entry.repo, entry.pr, entry.cursor.since)]);
          findings = deriveEvents({ pr, reviews, inline, comments, entry, trust: makeTrust(ctx.config, ownLogin) }).events;
          if (!findings.length || pr.headRefOid !== await ctx.git.head(entry.worktree)) throw new Error("force an actual current-head CI failure or configured trusted review finding before authorizing correction");
          findings = findings.map(({ kind, id, name, url, runId }) => ({ kind, id, name, url, runId, head: pr.headRefOid }));
        }
        const reservation = { phase, reservedUsd: ledger.reservationUsd, observedCostUsd: null, at: report.at };
        ledger.remainingUsd -= ledger.reservationUsd; ledger.attempts.push(reservation); writeJsonAtomic(ledgerPath, ledger);
        // Save the phase intent before dispatch. Crash recovery cannot spend a
        // second campaign reservation or start a second implementation.
        campaign.phases[phase] = { status: "dispatch-intent", at: report.at, findings }; writeJsonAtomic(join(home, "agents-live-evidence.json"), campaign);
        if (phase === "implementation") {
          const result = await start(ctx, { path: process.env.OPENAI_AGENTS_LIVE_PRD }); taskId = result.id;
        } else {
          taskId = campaign.taskId;
          const entry = ctx.state.get(taskId);
          if (entry.repo !== process.env.OPENAI_AGENTS_LIVE_REPO || entry.harness !== "openai-agents" || entry.session !== campaign.sessionId || entry.pr !== campaign.pr) throw new Error("saved campaign identity differs; no correction authorized");
          await resume(ctx, { handle: taskId, note: process.env.OPENAI_AGENTS_LIVE_CORRECTION });
        }
        const entry = ctx.state.get(taskId);
        if (entry.repo !== process.env.OPENAI_AGENTS_LIVE_REPO || entry.harness !== "openai-agents") throw new Error("live brief must select the explicitly authorized disposable repository and openai-agents");
        campaign.taskId = taskId; campaign.sessionId = entry.session; campaign.phases[phase].runId = entry.last.run; writeJsonAtomic(join(home, "agents-live-evidence.json"), campaign);
        const until = Date.now() + ledger.turnSeconds * 1000;
        let tick = makeTick({ ...ctx, ownLogin });
        // Recreate the context/coordinator midway to exercise saved ownership.
        let restarted = false, observedAfterRestart = false;
        while (Date.now() < until) {
          observedAfterRestart ||= restarted;
          await tick.tickEntry(taskId, ctx.state.get(taskId), { settleOnly: true });
          const current = ctx.executionFor(taskId, "openai-agents").current();
          if (!restarted) { tick = makeTick({ ...makeContext({ home }), ownLogin }); restarted = true; continue; }
          if (current?.execution.collected && !current.running) break;
          await new Promise(done => setTimeout(done, 1000));
        }
        const execution = ctx.executionFor(taskId, "openai-agents"), job = execution.current(), saved = ctx.state.get(taskId);
        if (job.running) { await execution.cancel("live-test-deadline"); throw new Error("live turn deadline reached; cancellation requested, cost unknown"); }
        const result = execution.result(job.id), verification = readJson(join(execution.dirOf(job.id), "verification.json"));
        if (!observedAfterRestart || !result?.outcome.ok || !verification?.evidence?.length || verification.evidence.some(t => t.exit !== 0) || !saved.pr || saved.session !== campaign.sessionId || (campaign.pr && saved.pr !== campaign.pr)) throw new Error("files/tests, observed restart or same-session/PR evidence missing");
        const head = await ctx.git.head(saved.worktree), remoteHead = await ctx.gh.refSha(saved.repo, saved.branch);
        if (head !== remoteHead || verification.head !== head) throw new Error("local/remote/current-test revisions differ");
        campaign.pr = saved.pr; campaign.phases[phase] = { status: "verified", findings, runId: job.id, sessionId: saved.session, turnId: job.execution.turnId, environmentId: job.execution.environment, head, pr: saved.pr, files: result.files?.map(({ path, beforeHash, afterHash }) => ({ path, beforeHash, afterHash })), tests: verification.evidence, artifact: result.artifact, usage: result.usage, costUsd: null, restarted };
        campaign.status = campaign.phases.implementation?.status === "verified" && campaign.phases.correction?.status === "verified" ? "verified" : "unverified";
        writeJsonAtomic(join(home, "agents-live-evidence.json"), campaign); report.status = campaign.status; report.evidence = join(home, "agents-live-evidence.json");
      } catch (error) {
        report.blockers.push(error.code || error.message); campaign.status = "unverified"; if (campaign.phases[phase]) campaign.phases[phase].error = error.code || error.message; writeJsonAtomic(join(home, "agents-live-evidence.json"), campaign);
      } finally { lock.release(); }
    }
  }
} } catch (error) { report.blockers.push(`${error.code || "LIVE_PREREQUISITES"}: verify the private configuration, selected API account/model and authorized repository; see docs/openai-agents.md`); }
if (!execute) report.blockers.push("preflight only; no paid implementation or correction evidence collected");
process.stdout.write(JSON.stringify(report, null, 2) + "\n"); process.exitCode = report.status === "verified" ? 0 : 1;
