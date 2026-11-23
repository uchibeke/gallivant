import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CI_BRANCH_PREFIX, CI_VARIABLE, configuredCITiming, deferredCIError, enrolledBranch } from "./ci_timing.mjs";
import { planAdminIntent, planOperator } from "./operator_intent.mjs";
import { scopeGrants } from "./dependency_plan_anchors.mjs";
import { authorConfigurationDigest } from "./recovery_preflight.mjs";
import { withReviewState } from "./review_state.mjs";
import { readFeedback, makeTrust, requiredFeedback, deriveEvents, exactReviewerVerdict } from "./events.mjs";
import { reviewBinding, reviewDigest, policyConfig } from "./review_policy.mjs";
import { hostApi } from "./hosts.mjs";
import { makeGh } from "./gh.mjs";
import { createGitHubCIApps, githubDeferredCI } from "./hosts/github_deferred_ci.mjs";
import { checkContext, githubId, immediateName, pilotProposal, sha, verifyPilotWorkflow } from "./hosts/github_ci_workflow.mjs";

const digest = value => /^[a-f0-9]{64}$/.test(value ?? "");
const maxFile = 128 * 1024;
const scope = repo => `ci-timing:${repo}`;
const must = (ok, message, code) => { if (!ok) throw deferredCIError(message, code); };
const phase = (pilot, expected) => must(pilot?.phase === expected, `Review the saved CI activation. This operation requires the ${expected} phase.`);
const authority = () => deferredCIError("After-review CI requires an authenticated operator ingress and the qualified outer worker boundary.", "CI_AUTHORITY");
const branchSet = (ctx, id) => ctx.state.ciPilot()?.enrollments?.[id];
const clockFor = ctx => ctx.clock ?? Date;
const nowFor = ctx => new Date(clockFor(ctx).now()).toISOString();

const ciErrorText = (error, fallback) => ["CI_DRIFT", "CI_SETUP_PENDING", "CI_AUTHORITY", "CI_UNSUPPORTED"].includes(error.code) ? error.message : fallback;
export { ciErrorText };

function assertIsolation(ctx, proof, pilot) {
  if (proof?.registry !== ctx.state.file || proof.qualified !== true || proof.workerExcluded !== true ||
      !digest(proof.launchDigest) || !digest(proof.authorRoute) || proof.launchDigest !== (pilot?.launch ?? proof.launchDigest) ||
      proof.authorRoute !== (pilot?.authorRoute ?? proof.authorRoute) || !(proof.expiresAt > clockFor(ctx).now())) throw authority();
  if (ctx.assertCoordinatorOwner) ctx.assertCoordinatorOwner();
  return proof;
}

export function ciSourceBinding(pr, policy) {
  return reviewBinding({ ...pr, statusCheckRollup: [] }, policy);
}

// Clearance is scoped to the hosted PR and a native review's actual commit.
// The exact actor ID comes from GitHub's authenticated review response.
export async function deferredReviewerVerdict(entry, input) {
  const authenticated = record => record.source?.host === "github.com" &&
    record.user?.id === entry.ciTiming.reviewerId && (record.user.type === "User" || record.user.type === "Bot");
  const reviews = input.reviews.filter(authenticated);
  const inline = input.inline.filter(authenticated);
  const fresh = reviews.filter(row => row.state !== "PENDING" && Date.parse(row.submitted_at) >= Date.parse(input.sinceIso))
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id)[0];
  const verdict = await exactReviewerVerdict({ ...input, reviews, inline, comments: [] }, null);
  if (verdict.verdict === "blocking") return verdict;
  if (verdict.verdict !== "clear" || fresh?.state !== "APPROVED" || fresh.commit_id !== input.headSha ||
      !githubId(fresh.id) || !input.trust.isReviewer(fresh.actor)) return { verdict: "waiting", note: "Waiting for the configured reviewer to approve the exact current head" };
  return { ...verdict, evidence: { id: fresh.id, head: fresh.commit_id, at: fresh.submitted_at, actor: fresh.user.id } };
}

function workflowDiff(path, original, installed) {
  const split = value => value.replace(/\n$/, "").split("\n");
  const before = split(original), after = split(installed);
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map(line => "-" + line), ...(!original.endsWith("\n") ? ["\\ No newline at end of file"] : []),
    ...after.map(line => "+" + line), ...(!installed.endsWith("\n") ? ["\\ No newline at end of file"] : [])].join("\n") + "\n";
}

/**
 * Bind the coordinator half of the pilot in the actual protected deployment.
 * No keys or isolation claims are obtained from task input, config, PR text,
 * environment fallback, or the standalone same-user CLI.
 */
export function bindDeferredCI(ctx, { isolation, readInstallation, readCredential, exec, fetch } = {}) {
  if (![isolation, readInstallation, readCredential].every(fn => typeof fn === "function")) throw authority();
  const clock = clockFor(ctx);
  const proof = pilot => assertIsolation(ctx, isolation(), pilot);
  const gh = makeGh({ credential: async () => {
    proof();
    const credential = await readCredential();
    if (!credential?.token) throw deferredCIError("Restore the dedicated coordinator's GitHub ruleset read credential.");
    return credential;
  }, exec, clock, cooldowns: ctx.cooldowns });
  const apps = createGitHubCIApps({ cooldowns: ctx.cooldowns, fetch, clock,
    readInstallation: request => { proof(); return readInstallation(request); } });
  return deferredCIService({ transport: githubDeferredCI({ read: gh.ciRead, apps }), isolation });
}

export function deferredCIService({ transport, isolation }) {
  const assertBoundary = (ctx, pilot) => assertIsolation(ctx, isolation(), pilot);
  const hostFile = async (ctx, p, revision) => {
    // Read workflow bytes with the coordinator credential. Never consume
    // workflow text from the candidate's worktree.
    const data = await transport.api(p, `contents/${p.workflow}?ref=${revision}`);
    must(data?.type === "file" && data.encoding === "base64" && typeof data.content === "string" &&
      Number.isSafeInteger(data.size) && data.size > 0 && data.size <= maxFile, "The complete approved workflow file is unavailable.", "CI_DRIFT");
    const bytes = Buffer.from(data.content, "base64");
    must(bytes.length === data.size && bytes.toString("base64") === data.content.replace(/\r?\n/g, ""),
      "The host did not return the complete workflow revision.", "CI_DRIFT");
    return bytes.toString("utf8");
  };
  const serialize = (ctx, repo, fn) => ctx.hosts?.serializeWrite ? ctx.hosts.serializeWrite(repo, fn) : fn();
  const owned = (ctx, pilot, options = {}) => {
    const current = ctx.state.ciPilot?.();
    assertBoundary(ctx, pilot);
    must(current?.digest === pilot.digest && current.generation === pilot.generation,
      "The approved timing or rollback generation changed.", "CI_DRIFT");
    if (options.active) must(current.phase === "active" && configuredCITiming(ctx.config, pilot.proposal.repo) === "after-review",
      "After-review CI is fenced. Restore the approved activation or complete rollback.", "CI_DRIFT");
    return current;
  };
  async function live(ctx, pilot, { reportRequired = true, enabled = true } = {}) {
    assertBoundary(ctx, pilot);
    const p = pilot.proposal;
    const [setup, base] = await Promise.all([transport.configuration(p), transport.ref(p, "heads", p.base)]);
    must(sha(base?.object?.sha) && setup.original === pilot.rules.original && setup.lockDigest === pilot.rules.lockDigest &&
      setup.reportRequired === reportRequired && setup.enabled === enabled, "Live CI rules or the enrollment selector drifted. Inspect the activation before retrying.", "CI_DRIFT");
    const current = await hostFile(ctx, p, base.object.sha);
    must(reviewDigest(current) === pilot.workflowDigest, "The protected base has a different CI workflow. Restore its approved revision or begin rollback.", "CI_DRIFT");
    return base.object.sha;
  }
  async function preview(ctx, raw) {
    const boundary = assertBoundary(ctx);
    const p = pilotProposal(raw);
    const [rules, original, installed] = await Promise.all([
      transport.configuration(p), hostFile(ctx, p, p.originalRevision), hostFile(ctx, p, p.revision),
    ]);
    const workflow = verifyPilotWorkflow(original, installed, p);
    const existing = new Set(rules.required.map(check => check.context));
    must(workflow.jobs.every(job => existing.has(job)), "The selected jobs must retain their existing required contexts.", "CI_DRIFT");
    const binding = { proposal: p, rules: { original: rules.original, lockDigest: rules.lockDigest, required: rules.required },
      ...workflow, launch: boundary.launchDigest, authorRoute: boundary.authorRoute };
    return { ...binding, digest: reviewDigest(binding), diff: workflowDiff(p.workflow, original, installed),
      selector: `When ${CI_VARIABLE}=enabled, defer protected ${CI_BRANCH_PREFIX}** branch pushes and same-repository PRs from those branches to ${p.base}`,
      reportingContext: checkContext,
      rollback: "Fence admissions and dispatch. Reconcile owned runs. Disable the selector and prove immediate runs on every open head. Restore the required settings and revoke the CI App permissions." };
  }
  async function admitted(ctx, { repo, base, harness, prd, reviewPolicy }) {
    const pilot = ctx.state.ciPilot?.();
    must(pilot?.phase === "active" && configuredCITiming(ctx.config, repo) === "after-review",
      "After-review CI setup or rollback is pending. The saved brief and launch allowance are retained.");
    const { proposal: p } = pilot;
    must(repo.toLowerCase() === p.repo && base === p.base && harness === "codex" &&
      reviewPolicy?.mode === "external-required" && reviewPolicy.external?.login &&
      authorConfigurationDigest(ctx.config, harness, prd) === pilot.authorRoute,
    "This admission is outside the approved private repository, protected base, author route or independent review policy.", "CI_UNSUPPORTED");
    const reviewer = await transport.api(p, `pulls/${pilot.qualification.deferred.pr}/reviews?per_page=100`);
    must(Array.isArray(reviewer) && reviewer.some(row => row.id === pilot.qualification.deferred.review &&
      row.user?.id === p.reviewerId && row.user.login.replace(/\[bot\]$/, "").toLowerCase() === reviewPolicy.external.login.replace(/\[bot\]$/, "").toLowerCase()),
    "The configured reviewer does not match the authenticated pilot review.", "CI_DRIFT");
    await live(ctx, pilot);
    // No launch is admitted unless each coordinator-only role still resolves.
    await Promise.all(["author", "enroller", "dispatcher", "reporter"].map(role => transport.credential(p, role)));
    owned(ctx, pilot, { active: true });
    return { version: 1, timing: "after-review", revision: pilot.digest, reviewerId: p.reviewerId };
  }
  async function enroll(ctx, id, token, timing, deriveBranch) {
    const p = ctx.state.ciPilot().proposal;
    return withReviewState(ctx, scope(p.repo), async () => {
      const pilot = ctx.state.ciPilot();
      must(timing.revision === pilot.digest, "Enrollment lost its approved CI revision.", "CI_DRIFT");
      const head = await live(ctx, pilot);
      const guard = () => {
        owned(ctx, pilot, { active: true });
        must(ctx.state.startClaim(id)?.token === token, "Enrollment lost its original start claim.", "CI_DRIFT");
      };
      guard();
      let record = branchSet(ctx, id);
      if (!record) {
        const branch = deriveBranch(randomUUID());
        must(enrolledBranch(branch) && !await transport.ref(p, "heads", branch), "The new enrolled branch already exists.", "CI_DRIFT");
        record = ctx.state.saveCIEnrollment(id, token, pilot.digest, { branch, head, revision: pilot.digest, status: "intent", at: nowFor(ctx) });
      }
      const observed = await transport.ref(p, "heads", record.branch);
      if (!observed) {
        // A saved creation intent is directed at this unique ref. Existence
        // and contents can be reconciled without adopting another branch.
        await serialize(ctx, p.repo, () => transport.enroll(p, record.branch, record.head, guard));
      }
      const enrolled = await transport.ref(p, "heads", record.branch);
      must(enrolled?.object?.sha === record.head, "The protected enrollment branch moved before author dispatch. Inspect its original owner.", "CI_DRIFT");
      guard();
      return ctx.state.saveCIEnrollment(id, token, pilot.digest, { ...record, status: "enrolled" });
    });
  }
  function enrollment(ctx, id, entry) {
    const pilot = ctx.state.ciPilot?.();
    const saved = branchSet(ctx, id);
    must(entry && pilot?.digest === entry.ciTiming?.revision && saved?.status === "enrolled" &&
      saved.branch === entry.branch && saved.revision === entry.ciTiming.revision,
    "Restore the protected task enrollment record before observing or dispatching deferred CI.", "CI_DRIFT");
    return { pilot, saved };
  }
  async function author(ctx, id, entry, prd, minimumMs) {
    const { pilot, saved } = enrollment(ctx, id, entry);
    const p = pilot.proposal;
    assertBoundary(ctx, pilot);
    must(authorConfigurationDigest(ctx.config, entry.harness, prd) === pilot.authorRoute, "The saved pilot author route changed.", "CI_DRIFT");
    if (!entry.pr) {
      await live(ctx, pilot);
      owned(ctx, pilot, { active: true });
      const branch = await transport.ref(p, "heads", saved.branch);
      must(branch?.object?.sha === saved.head, "The enrolled branch moved before the retained launch.", "CI_DRIFT");
    }
    return transport.credential(p, "author", minimumMs);
  }
  function assertLaunch(ctx, id, entry) {
    const { pilot } = enrollment(ctx, id, entry);
    if (!entry.pr) owned(ctx, pilot, { active: true });
    else assertBoundary(ctx, pilot);
  }
  async function currentCandidate(ctx, id, entry, pr) {
    const { pilot, saved } = enrollment(ctx, id, entry), p = pilot.proposal;
    assertBoundary(ctx, pilot);
    const value = await transport.candidate(p, entry.pr);
    must(value.state === "open" && value.draft === false && value.author === p.roles.author.actorId &&
      value.branch === entry.branch && value.url.toLowerCase() === entry.url.toLowerCase() &&
      value.head === pr.headRefOid && value.base === pr.baseRefOid && Date.parse(value.createdAt) >= Date.parse(saved.at) - 1000,
    "Wait for a consistent observation of the approved regular PR, author, head and base.", "CI_DRIFT");
    const host = hostApi(ctx);
    must(await host.containsCommit(p.repo, value.head, saved.head), "The PR head does not descend from the protected enrollment.", "CI_DRIFT");
    return { ...value, upToDate: await host.containsCommit(p.repo, value.head, value.base) };
  }
  async function latestClearance(ctx, id, entry, pr, expected) {
    const host = hostApi(ctx);
    const fresh = await host.prView(entry.repo, entry.pr);
    const binding = ciSourceBinding(fresh, entry.reviewPolicy);
    must(binding === ciSourceBinding(pr, entry.reviewPolicy) && fresh.state === "OPEN" &&
      fresh.headRefName === entry.branch && fresh.baseRefName === entry.base && fresh.isDraft === false && fresh.isCrossRepository === false,
    "The PR identity, brief, head or base changed while verifying clearance.", "CI_DRIFT");
    const [reviews, inline, comments] = await readFeedback(host, entry.repo, fresh, entry.rereview.at, entry.rereview.at);
    const config = policyConfig(ctx.config, entry), trust = makeTrust(config, "ci-coordinator");
    const input = { reviews, inline, comments, config, trust, sinceIso: entry.rereview.at,
      headSha: fresh.headRefOid, dispatched: entry.cursor.dispatched };
    const verdict = await deferredReviewerVerdict(entry, input);
    must(verdict.verdict === "clear" && isDeepStrictEqual(verdict.evidence, expected) &&
      !requiredFeedback(input).length &&
      !deriveEvents({ ...input, pr: { ...fresh, statusCheckRollup: [] }, entry }).events.length,
    "The exact hosted approval or current feedback changed.", "CI_DRIFT");
    const candidate = await currentCandidate(ctx, id, entry, fresh);
    must(candidate.upToDate && candidate.mergeProved, "Refresh the protected base and review the refreshed head.", "CI_DRIFT");
    return { candidate, pr: fresh };
  }
  async function report(ctx, pilot, value, key, runId, guard) {
    const p = pilot.proposal, externalId = `post-review-ci:${key}`, url = transport.verifiedRunUrl(p, runId);
    const check = await transport.reportProof(p, value, externalId);
    const valid = row => githubId(row?.id) && row.status === "completed" && row.conclusion === "success" && row.details_url === url;
    if (check) {
      must(valid(check), "The reporting App context does not prove actual success for this run.", "CI_DRIFT");
      return check.id;
    }
    const saved = ctx.state.ciPilot().reports?.[key];
    if (saved && saved.status !== "not-accepted") return null;
    const reportOwners = Object.values(ctx.state.ciPilot().reports ?? {});
    must(!reportOwners.some(row => row.merge === value.merge && row.pr !== value.number) &&
      !(await openPulls(pilot)).some(row => row.number !== value.number && row.merge_commit_sha === value.merge),
    "Another PR uses this test merge. Obtain a distinct head and review it before reporting.", "CI_DRIFT");
    owned(ctx, pilot);
    ctx.state.saveCIReport(pilot.digest, key, { status: "submitting", at: nowFor(ctx), runId, pr: value.number, merge: value.merge });
    let result;
    try {
      result = await serialize(ctx, p.repo, () => transport.report(p, value, externalId, url,
        `PR #${value.number}. Head ${value.head}. Base ${value.base}. Tested revision ${value.tested}.`, guard));
    } catch (error) {
      if (error.notAccepted) ctx.state.saveCIReport(pilot.digest, key, { status: "not-accepted", at: nowFor(ctx), runId, pr: value.number, merge: value.merge });
      throw error;
    }
    if (valid(result)) ctx.state.saveCIReport(pilot.digest, key,
      { status: "acknowledged", at: nowFor(ctx), runId, pr: value.number, merge: value.merge, checkId: result.id });
    // Observe the independently authenticated App result on the next read.
    return null;
  }
  async function immediate(ctx, pilot, value, runId) {
    const p = pilot.proposal;
    if (value.state !== "open" || value.draft || !value.mergeProved ||
        !await hostApi(ctx).containsCommit(p.repo, value.head, value.base) ||
        reviewDigest(await hostFile(ctx, p, value.merge)) !== pilot.workflowDigest) return null;
    return transport.immediateRun(p, pilot, value, runId);
  }
  async function openPulls(pilot) {
    const p = pilot.proposal;
    const open = await transport.api(p, `pulls?state=open&base=${encodeURIComponent(p.base)}&per_page=100`);
    must(Array.isArray(open) && open.length < 100 && open.every(row => row.head?.repo?.id === p.repositoryId),
      "Inspect the complete same-repository open PR list before changing CI settings.", "CI_DRIFT");
    return open;
  }
  async function proveRollback(ctx, pilot) {
    const p = pilot.proposal;
    await live(ctx, pilot, { enabled: false, reportRequired: pilot.phase !== "restored" });
    const pending = ctx.state.entries(([, e]) => e.repo === p.repo && e.ciRecords?.some(r => r.requests.some(q =>
      ["submitting", "accepted", "ambiguous", "queued", "running", "cancelling"].includes(q.status))));
    must(!pending.length, "Reconcile the saved dispatch and cancellation records before changing required settings.");
    const opened = await openPulls(pilot), result = [];
    for (const row of opened) {
      const value = await transport.candidate(p, row.number);
      const run = await immediate(ctx, pilot, value);
      must(run, `Prove immediate CI for PR #${row.number} on its current head before changing required settings.`);
      result.push({ pr: value.number, head: value.head, base: value.base, merge: value.merge, run: run.id });
    }
    return result;
  }
  async function qualify(ctx, pilot, canary) {
    const p = pilot.proposal;
    await live(ctx, pilot, { reportRequired: false });
    const { deferred, automatic, blocked } = canary ?? {};
    must([deferred?.pr, deferred?.run, automatic?.pr, automatic?.run, blocked?.pr, blocked?.run].every(githubId) &&
      new Set([deferred.pr, automatic.pr, blocked.pr]).size === 3 && /^[0-9a-f-]{36}$/.test(deferred.request) &&
      Number.isFinite(Date.parse(deferred.requestedAt)), "Supply the three separately authorized pilot PR and run identities.");
    const [candidate, normal, waiting] = await Promise.all([deferred, automatic, blocked].map(x => transport.candidate(p, x.pr)));
    must(enrolledBranch(candidate.branch) && enrolledBranch(waiting.branch) && !enrolledBranch(normal.branch) &&
      candidate.author === p.roles.author.actorId && waiting.author === p.roles.author.actorId &&
      candidate.mergeProved && waiting.mergeProved && candidate.state === "open" && waiting.state === "open" &&
      !candidate.draft && !waiting.draft && await hostApi(ctx).containsCommit(p.repo, candidate.head, candidate.base),
    "The pilot is missing distinct, current enrolled and unenrolled PRs.");
    const run = await transport.findRun(p, { id: deferred.request, runId: deferred.run, requestedAt: deferred.requestedAt });
    const reviews = await transport.api(p, `pulls/${candidate.number}/reviews?per_page=100`);
    const review = Array.isArray(reviews) && reviews.length < 100 && reviews.filter(row => row.user?.id === p.reviewerId && row.state !== "PENDING")
      .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id)[0];
    must(review?.state === "APPROVED" && review.commit_id === candidate.head && Date.parse(review.submitted_at) >= Date.parse(candidate.createdAt) &&
      Date.parse(review.submitted_at) < Date.parse(run.created_at), "Prove the configured independent reviewer cleared the exact head before CI ran.");
    const suite = transport.suite(p, pilot.jobs, run, await transport.jobs(p, run, p.revision), candidate.tested, { reviewId: review.id });
    must(suite.ok, "The deferred pilot suite has no actual success for the tested revision.");
    const immediateRun = await immediate(ctx, pilot, normal, automatic.run);
    must(immediateRun, "The unenrolled PR has no actual successful automatic suite for the current head and base.");
    const skipped = await transport.run(p, blocked.run);
    must(skipped.id === blocked.run && skipped.repository?.id === p.repositoryId && skipped.workflow_id === p.workflowId &&
      skipped.event === "pull_request" && skipped.head_sha === waiting.head && skipped.head_branch === waiting.branch &&
      skipped.display_title === immediateName(waiting) && skipped.run_attempt === 1 && skipped.status === "completed",
    "The blocked-head run does not belong to the selected pull request workflow.");
    const skippedJobs = await transport.jobs(p, skipped, waiting.head);
    must(pilot.jobs.every(name => skippedJobs.filter(job => job.name === name).length === 1 &&
      skippedJobs.some(job => job.name === name && job.conclusion === "skipped" && !job.runner_id && !job.steps?.length)),
    "Selected jobs ran or lack skipped evidence on the blocked pilot head.");
    const guard = value => async () => {
      owned(ctx, pilot);
      await live(ctx, pilot, { reportRequired: false });
      must(isDeepStrictEqual(value, await transport.candidate(p, value.number)), "The qualification candidate moved.", "CI_DRIFT");
    };
    const first = `qualification:${pilot.digest}:${candidate.number}:${candidate.merge}:${run.id}`;
    const second = `qualification:${pilot.digest}:${normal.number}:${normal.merge}:${immediateRun.id}`;
    const reportId = await report(ctx, pilot, candidate, first, run.id, guard(candidate));
    const normalReport = await report(ctx, pilot, normal, second, immediateRun.id, guard(normal));
    must(reportId && normalReport, "Observe both authenticated reporting App checks alongside existing enforcement, then confirm the qualification again.");
    return { at: nowFor(ctx), deferred: { pr: candidate.number, head: candidate.head, merge: candidate.merge, tested: candidate.tested,
      run: run.id, review: review.id, check: reportId }, automatic: { pr: normal.number, head: normal.head, run: immediateRun.id, check: normalReport },
    blocked: { pr: waiting.number, head: waiting.head, run: skipped.id } };
  }
  async function command(ctx, handle, input) {
    const { action, proposal, revision, canary, taskId, requestId } = input;
    must(["preview", "status", "approve", "qualify", "approve-cutover", "cutover", "drain", "restore", "retire", "retry"].includes(action) &&
      Object.keys(input).every(key => ["action", "proposal", "revision", "canary", "taskId", "requestId"].includes(key)),
    "Unknown CI timing operation.", "CI_SETUP_INVALID");
    const repo = action === "preview" || action === "approve" ? pilotProposal(proposal).repo : ctx.state.ciPilot?.()?.proposal.repo;
    if (!repo) throw deferredCIError("Review the private pilot proposal first.");
    const authenticate = () => {
      const operator = planOperator(ctx.state.file, handle);
      const boundary = assertBoundary(ctx);
      if (operator.isolation.launchDigest !== boundary.launchDigest ||
          !scopeGrants(operator, { tenant: operator.tenant, repositories: [repo] }, ["read", `ci-timing/${action}`])) throw authority();
      return operator;
    };
    authenticate();
    return withReviewState(ctx, scope(repo), async () => {
      const pilot = ctx.state.ciPilot(), generation = pilot?.generation ?? 0;
      const save = (next, receipt) => ctx.state.setCIPilot({
        ...next, generation: generation + 1, receipts: [...(pilot?.receipts || []), { action, at: nowFor(ctx),
          operator: authenticate().principal, revision: next.digest, ...receipt }],
      }, generation, action, planAdminIntent(ctx.state.file, handle, `ci-timing/${action}`, repo, generation));
      if (action === "preview") return preview(ctx, proposal);
      if (action === "status") return pilot;
      if (action === "approve") {
        must(!pilot || pilot.phase === "retired" && !Object.keys(pilot.enrollments ?? {}).length,
          "This protected runtime already has a pilot record. Preserve its receipts and settle its admitted tasks.");
        const view = await preview(ctx, proposal);
        must(view.digest === revision, "Review the exact workflow diff and current settings before approval.");
        const { diff: _diff, selector: _selector, rollback: _rollback, reportingContext: _context, ...binding } = view;
        await live(ctx, binding, { reportRequired: false, enabled: false });
        return save({ ...binding, phase: "proposed", enrollments: {}, reports: {} });
      }
      must(pilot?.digest === revision, "The approved CI activation revision changed.");
      if (action === "qualify") {
        phase(pilot, "proposed");
        const qualification = await qualify(ctx, pilot, canary);
        return save({ ...ctx.state.ciPilot(), phase: "qualified", qualification });
      }
      if (action === "approve-cutover") {
        phase(pilot, "qualified");
        await live(ctx, pilot, { reportRequired: false });
        return save({ ...pilot, phase: "cutover-approved" });
      }
      if (action === "cutover") {
        phase(pilot, "cutover-approved");
        await live(ctx, pilot);
        return save({ ...pilot, phase: "active", activatedAt: nowFor(ctx) });
      }
      if (action === "drain") {
        phase(pilot, "active");
        return save({ ...pilot, phase: "draining" });
      }
      if (action === "restore") {
        phase(pilot, "draining");
        const rollback = await proveRollback(ctx, pilot);
        return save({ ...pilot, phase: "restored", rollback });
      }
      if (action === "retire") {
        phase(pilot, "restored");
        const rollback = await proveRollback(ctx, pilot);
        return save({ ...pilot, phase: "retired", rollback });
      }
      if (action === "retry") {
        phase(pilot, "active");
        const entry = ctx.state.get(taskId);
        enrollment(ctx, taskId, entry || {});
        const record = entry.ciRecords?.find(row => row.requests.at(-1)?.id === requestId);
        const request = record?.requests.at(-1);
        must(request && ["not-accepted", "failed", "cancelled"].includes(request.status) && !record.obsolete,
          "Retry requires proven nonacceptance or the owned terminal attempt. Inspect ambiguous requests before any retry.");
        const operator = authenticate();
        ctx.state.update(taskId, current => ({ ciRecords: current.ciRecords.map(row => row.key === record.key &&
          row.requests.at(-1)?.id === requestId ? { ...row, retry: { requestId, at: nowFor(ctx), operator: operator.principal } } : row) }), { durable: true });
        return { requestId, retry: true };
      }
      throw deferredCIError("Unknown CI timing operation.", "CI_SETUP_INVALID");
    });
  }
  return { admit: admitted, enroll, author, assertLaunch, enrollment, live, owned, currentCandidate, latestClearance,
    report, immediate, openPulls, command, assertBoundary, serialize, transport, scope };
}
