import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { deferredCIError, deferredMaintenanceOwed, enrolledBranch } from "./ci_timing.mjs";
import { ciErrorText, ciSourceBinding } from "./deferred_ci.mjs";
import { checkContext, githubId } from "./hosts/github_ci_workflow.mjs";
import { hostApi } from "./hosts.mjs";
import { withReviewState } from "./review_state.mjs";
import { reviewBinding, reviewDigest } from "./review_policy.mjs";
import { controlPending } from "./control_contract.mjs";
import { recoveryHeld } from "./recovery_recipes.mjs";

const observationMs = 5 * 60_000;
const retryWindow = 5 * 60_000;
const clockFor = ctx => ctx.clock ?? Date;
const now = ctx => new Date(clockFor(ctx).now()).toISOString();
const pending = request => ["submitting", "accepted", "queued", "running", "ambiguous", "cancelling"].includes(request.status);
const jobName = (pilot, name) => pilot.jobs.some(job => name === job || name === `${pilot.workflowName} / ${job}`);
const checkSource = check => check.source?.host === "github.com";

export function ungatedRollup(pr, pilot) {
  if (!pilot) return pr.statusCheckRollup ?? [];
  return (pr.statusCheckRollup ?? []).filter(check => !(checkSource(check) &&
    (check.name === checkContext || jobName(pilot, check.name) && check.__typename === "CheckRun" && check.conclusion === "SKIPPED")));
}

export function ungatedRequirements(names, pilot) {
  return pilot ? names.filter(name => name !== checkContext && !jobName(pilot, name)) : names;
}

function binding(pilot, value) {
  const p = pilot.proposal;
  return { repositoryId: p.repositoryId, pr: value.number, head: value.head, base: value.base, merge: value.merge,
    tested: value.tested, workflow: p.revision, suite: reviewDigest([p.workflowId, pilot.jobs, pilot.actions]) };
}

function saveRecord(ctx, id, record) {
  const saved = ctx.state.update(id, current => {
    const rows = current.ciRecords ?? [];
    return { ciRecords: rows.some(row => row.key === record.key)
      ? rows.map(row => row.key === record.key ? record : row) : [...rows, record] };
  }, { durable: true, resync: true });
  return saved.ciRecords.find(row => row.key === record.key);
}
function saveRequest(ctx, id, record, request) {
  return saveRecord(ctx, id, { ...record, retry: null,
    requests: record.requests.some(item => item.id === request.id) ? record.requests.map(item => item.id === request.id ? request : item)
      : [...record.requests, request] });
}

const checkKey = (record, req) => reviewDigest([record.key, req.id, req.runId, req.attempt]);
const activationFailure = (pr, error) => ({ head: pr.headRefOid, phase: "blocked",
  next: ciErrorText(error, "Restore authenticated GitHub CI access and recheck the saved request.") });
const runLink = (ci, pilot, req) => req.runId ? ci.transport.verifiedRunUrl(pilot.proposal, req.runId) : null;

function dispatchGuard(ctx, id, entry, pilot) {
  ctx.deferredCI.owned(ctx, pilot, { active: true });
  const current = ctx.state.get(id);
  if (!current || current.start_token !== entry.start_token || current.ciTiming?.revision !== pilot.digest ||
      current.pr !== entry.pr || current.branch !== entry.branch || current.base !== entry.base ||
      !isDeepStrictEqual(current.rereview, entry.rereview) || current.dispatch_stopped || controlPending(current.control) ||
      !["pr-open", "ready-for-human"].includes(current.state) || recoveryHeld(ctx.state.load(), id, current))
    throw deferredCIError("The task, review request, or operator control changed before CI submission.", "CI_DRIFT");
}

async function observe(ctx, id, pilot, record, request) {
  const ci = ctx.deferredCI, { transport } = ci, p = pilot.proposal;
  const row = await transport.findRun(p, request);
  if (!row) {
    if (clockFor(ctx).now() - Date.parse(request.requestedAt) < observationMs || request.status === "ambiguous") return request;
    return saveRequest(ctx, id, record, { ...request, status: "ambiguous" }).requests.at(-1);
  }
  let status = row.status === "completed" ? "failed" : ["in_progress", "pending"].includes(row.status) ? "running" : "queued";
  let failure, reason;
  if (row.status === "completed") {
    const jobs = await transport.jobs(p, row, p.revision);
    const result = transport.suite(p, pilot.jobs, row, jobs, record.binding.tested, { reviewId: request.review.id });
    ({ failed: failure, reason } = result);
    status = result.ok ? "succeeded" : row.conclusion === "cancelled" && row.run_attempt === 1 ? "cancelled" : "failed";
  }
  const update = { ...request, status, runId: row.id, attempt: row.run_attempt, workflowRef: `refs/tags/${p.ref}`, workflowSha: row.head_sha,
    ...(row.status === "completed" ? { failure, reason, conclusion: row.conclusion } : {}) };
  return saveRequest(ctx, id, record, update).requests.at(-1);
}

async function maintainRecords(ctx, id, entry, pr, pilot, drifted = false) {
  const ci = ctx.deferredCI, p = pilot.proposal;
  const stopping = drifted || pilot.phase !== "active" || entry.state === "done" || entry.dispatch_stopped || pr?.state !== "OPEN" ||
    pr?.isDraft || pr?.headRefName !== entry.branch || pr?.baseRefName !== entry.base;
  for (let record of entry.ciRecords ?? []) {
    if (!record.requests.some(pending)) continue;
    const superseded = stopping || pr.headRefOid !== record.binding.head || pr.baseRefOid !== record.binding.base;
    if (!superseded && !record.obsolete) {
      if (entry.state === "needs-human") {
        const request = await observe(ctx, id, pilot, record, record.requests.at(-1));
        if (request.failure) ctx.state.update(id, { ciProgress: { head: pr.headRefOid, phase: "failed", failure: request.failure,
          attempt: request.attempt, run: request.runId, runUrl: runLink(ci, pilot, request), next: request.reason } });
      }
      continue;
    }
    if (!record.obsolete) record = saveRecord(ctx, id, { ...record, obsolete: now(ctx) });
    const request = record.requests.at(-1);
    if (!pending(request)) continue;
    const row = await ci.transport.findRun(p, request);
    if (!row) {
      if (clockFor(ctx).now() - Date.parse(request.requestedAt) >= observationMs && request.status !== "ambiguous")
        saveRequest(ctx, id, record, { ...request, status: "ambiguous" });
      continue;
    }
    const observed = { ...request, runId: row.id, workflowRef: `refs/tags/${p.ref}`, workflowSha: row.head_sha, attempt: row.run_attempt };
    if (row.status === "completed") {
      saveRequest(ctx, id, record, { ...observed, status: "obsolete", conclusion: row.conclusion, terminalAt: now(ctx) });
      continue;
    }
    if (Date.parse(request.cancelAt) + retryWindow > clockFor(ctx).now()) continue;
    const guard = () => {
      ci.owned(ctx, pilot);
      if (!ctx.state.get(id)?.ciRecords?.some(item => item.key === record.key && item.obsolete &&
          item.requests.at(-1)?.runId === row.id)) throw deferredCIError("The obsolete run is no longer owned.", "CI_DRIFT");
    };
    saveRequest(ctx, id, record, { ...observed, status: "cancelling", cancelAt: now(ctx) });
    await ci.serialize(ctx, p.repo, () => ci.transport.cancel(p, row.id, guard));
  }
}

// Also called by the maintenance lane for stopped or closed tasks. No
// submissions are possible on this path.
export async function maintainDeferredCI(ctx, id, entry, pr = null) {
  const ci = ctx.deferredCI;
  if (!ci || !deferredMaintenanceOwed(entry)) return;
  const { pilot } = ci.enrollment(ctx, id, entry);
  return withReviewState(ctx, ci.scope(entry.repo), async () => {
    ci.owned(ctx, pilot);
    const current = ctx.state.get(id);
    if (!current || current.pr !== entry.pr) return;
    let drifted = false;
    if (pilot.phase === "active" && current.state !== "done" && !current.dispatch_stopped) {
      try { await ci.live(ctx, pilot); }
      catch (error) { if (error.code !== "CI_DRIFT") throw error; drifted = true; }
      if (!pr && !drifted && current.pr) pr = await hostApi(ctx).prView(current.repo, current.pr);
    }
    await maintainRecords(ctx, id, current, pr, pilot, drifted);
  });
}

async function requestRun(ctx, id, entry, pr, external, pilot, record, value) {
  const ci = ctx.deferredCI, p = pilot.proposal;
  const guard = () => dispatchGuard(ctx, id, entry, pilot);
  return ci.serialize(ctx, p.repo, async () => {
    await ci.live(ctx, pilot);
    const { candidate } = await ci.latestClearance(ctx, id, entry, pr, external.evidence);
    if (!isDeepStrictEqual(binding(pilot, candidate), record.binding)) throw deferredCIError("The tested candidate moved before CI submission.", "CI_DRIFT");
    guard();
    let request = { id: randomUUID(), requestedAt: now(ctx), status: "submitting", review: external.evidence,
      source: ciSourceBinding(pr, entry.reviewPolicy) };
    record = saveRequest(ctx, id, record, request);
    try {
      const result = await ci.transport.dispatch(p, request, value, guard);
      if (githubId(result?.workflow_run_id)) {
        request = { ...request, status: "accepted", runId: result.workflow_run_id };
        saveRequest(ctx, id, record, request);
      }
    } catch (error) {
      if (error.notAccepted === true) {
        request = { ...request, status: "not-accepted", reason: "GitHub refused the request. Restore the dispatcher or quota and approve an explicit retry." };
        saveRequest(ctx, id, record, request);
      }
      // A transport loss is still a submission. The next poll owns observation.
      else if (!["GH_TRANSPORT", "GH_RATE_LIMIT"].includes(error.code)) throw error;
    }
    return request;
  });
}

export async function deferredChecks(ctx, id, entry, pr, external, { observeOnly = false } = {}) {
  const ci = ctx.deferredCI;
  if (!ci) return { head: pr.headRefOid, phase: "blocked", next: "Restore the protected CI coordinator for this enrolled task." };
  let progress = { head: pr.headRefOid, phase: "review" };
  try {
    const { pilot } = ci.enrollment(ctx, id, entry), p = pilot.proposal;
    return await withReviewState(ctx, ci.scope(p.repo), async () => {
      const checked = await ci.currentCandidate(ctx, id, entry, pr);
      await maintainRecords(ctx, id, ctx.state.get(id), pr, pilot);
      if (["restored", "retired"].includes(pilot.phase)) {
        await ci.live(ctx, pilot, { enabled: false, reportRequired: pilot.phase === "restored" });
        const run = await ci.immediate(ctx, pilot, checked);
        if (!run) return { ...progress, phase: "verifying", next: "Wait for immediate CI on the current head after rollback." };
        const proof = { ...binding(pilot, checked), run: run.id, attempt: run.run_attempt, timing: "immediate" };
        if (pilot.phase === "restored") {
          const key = immediateReportKey(pilot, checked, run.id);
          const check = await ci.transport.reportProof(p, checked, `post-review-ci:${key}`);
          if (check?.status === "completed" && check.conclusion === "success" &&
              check.details_url === ci.transport.verifiedRunUrl(p, run.id)) proof.check = check.id;
          if (!proof.check) return { ...progress, phase: "verifying" };
        }
        return { ...progress, phase: "verifying", proof, runUrl: ci.transport.verifiedRunUrl(p, run.id) };
      }
      ci.owned(ctx, pilot, { active: true });
      if (!checked.upToDate) return { ...progress, phase: "blocked", refreshBase: true, base: checked.base,
        next: "Bring the protected base into the PR and review the refreshed head." };
      if (!checked.mergeProved) return { ...progress, phase: "verifying", next: "Wait for GitHub to compute the exact current test merge." };
      const candidate = binding(pilot, checked), key = reviewDigest(candidate);
      // A moving test merge is obsolete even when GitHub kept both input SHAs.
      const current = ctx.state.get(id);
      if (current.ciRecords?.some(row => row.key !== key && row.requests.some(pending))) {
        for (const row of current.ciRecords.filter(row => row.key !== key && row.requests.some(pending) && !row.obsolete))
          saveRecord(ctx, id, { ...row, obsolete: now(ctx) });
        await maintainRecords(ctx, id, ctx.state.get(id), pr, pilot);
      }
      let record = ctx.state.get(id).ciRecords?.find(row => row.key === key) ?? { key, binding: candidate, requests: [] };
      let req = record.requests.at(-1);
      if (req && pending(req)) req = await observe(ctx, id, pilot, record, req);
      progress = { ...progress, ...(req ? { requestId: req.id, runUrl: runLink(ci, pilot, req) } : {}) };
      if (external?.evidence) progress.reviewUrl = `${entry.url}#pullrequestreview-${external.evidence.id}`;
      if (req?.status === "ambiguous") return { ...progress, phase: "blocked",
        next: "Inspect the saved request in GitHub Actions. A fresh dispatch requires proof that GitHub did not accept it." };
      if (req && pending(req)) return { ...progress, phase: ["running", "queued"].includes(req.status) ? req.status : "submitting" };
      if (record.obsolete) return { ...progress, phase: "blocked", next: "Inspect the obsolete saved request before reusing this tested revision." };
      if (external?.verdict !== "clear") return progress;
      record = ctx.state.get(id).ciRecords?.find(row => row.key === key) ?? record;
      if (!req || record.retry?.requestId === req.id && ["not-accepted", "failed", "cancelled"].includes(req.status)) {
        if (observeOnly) return progress;
        req = await requestRun(ctx, id, entry, pr, external, pilot, record, checked);
        return { ...progress, requestId: req.id, runUrl: null, phase: req.status === "not-accepted" ? "blocked" : "submitting", next: req.reason };
      }
      if (req.status === "not-accepted") return { ...progress, phase: "blocked", next: req.reason };
      if (req.status === "failed" || req.status === "cancelled") return { ...progress, phase: "failed",
        failure: req.failure, attempt: req.attempt, run: req.runId, next: req.reason };
      if (req.status !== "succeeded") return { ...progress, phase: "blocked" };
      // An in-place rerun after a previously successful poll cannot supply
      // the first-attempt proof or inherit its ready decision.
      const latest = await ci.transport.findRun(p, req);
      if (latest.run_attempt !== req.attempt || latest.status !== "completed" || latest.conclusion !== "success") {
        if (latest.status === "completed") await observe(ctx, id, pilot, record, req);
        return { ...progress, phase: "blocked", next: "Inspect the changed attempt and approve a new request after it becomes terminal." };
      }
      await ci.live(ctx, pilot);
      const { candidate: fresh } = await ci.latestClearance(ctx, id, entry, pr, external.evidence);
      if (!isDeepStrictEqual(binding(pilot, fresh), candidate)) return { ...progress, phase: "blocked",
        next: "The tested revision moved. Wait for binding to the live PR." };
      const reportKey = checkKey(record, req);
      const check = observeOnly
        ? (await ci.transport.reportProof(p, checked, `post-review-ci:${reportKey}`))
        : await ci.report(ctx, pilot, checked, reportKey, req.runId, async () => {
          await ci.live(ctx, pilot);
          const { candidate: current } = await ci.latestClearance(ctx, id, entry, pr, external.evidence);
          if (!isDeepStrictEqual(binding(pilot, current), candidate))
            throw deferredCIError("The candidate changed before reporting success.", "CI_DRIFT");
          dispatchGuard(ctx, id, entry, pilot);
        });
      const checkId = observeOnly ? check?.status === "completed" && check.conclusion === "success" &&
        check.details_url === runLink(ci, pilot, req) ? check.id : null : check;
      return { ...progress, phase: "verifying", ...(checkId ? { proof: { ...candidate, run: req.runId, attempt: req.attempt, check: checkId,
        request: req.id, requestedReview: req.review, review: external.evidence, source: ciSourceBinding(pr, entry.reviewPolicy) } } : {}) };
    });
  } catch (error) {
    ctx.log.warn(`${id}: CI observation deferred (${error.code || "host evidence unavailable"})`);
    return { ...progress, ...activationFailure(pr, error), ...(error.retryAt ? { retryAt: error.retryAt } : {}) };
  }
}

export async function recheckDeferredReadiness(ctx, id, entry, pr, external, previous) {
  const current = await deferredChecks(ctx, id, entry, pr, external, { observeOnly: true });
  if (!previous?.proof || !isDeepStrictEqual(current.proof, previous.proof)) return false;
  const fresh = await hostApi(ctx).prView(entry.repo, entry.pr);
  return fresh.state === "OPEN" && reviewBinding(pr, entry.reviewPolicy) === reviewBinding(fresh, entry.reviewPolicy);
}

export async function terminalDeferredChecks(ctx, id, entry, pr) {
  const ci = ctx.deferredCI, proof = entry.completionEvidence?.delivery?.checks?.ci;
  if (!ci || !proof || proof.head !== pr.headRefOid) return false;
  const { pilot } = ci.enrollment(ctx, id, entry), p = pilot.proposal;
  ci.assertBoundary(ctx, pilot);
  if (proof.timing === "immediate" && !proof.check && pilot.phase === "retired") return true;
  if (!githubId(proof.check)) return false;
  const raw = await ci.transport.api(p, `check-runs/${proof.check}`);
  if (raw.id !== proof.check || raw.name !== checkContext || raw.app?.id !== p.roles.reporter.appId ||
    raw.head_sha !== proof.merge || raw.status !== "completed" || raw.conclusion !== "success" ||
    raw.details_url !== ci.transport.verifiedRunUrl(p, proof.run)) return false;
  if (proof.timing === "immediate") return true;
  const record = entry.ciRecords?.find(row => row.key === reviewDigest(binding(pilot, { number: proof.pr, ...proof })));
  const req = record?.requests.find(item => item.id === proof.request);
  if (req?.runId !== proof.run) return false;
  const run = await ci.transport.findRun(p, req);
  return ci.transport.suite(p, pilot.jobs, run, await ci.transport.jobs(p, run, p.revision), proof.tested, { reviewId: req.review.id }).ok;
}

function immediateReportKey(pilot, value, run) {
  return reviewDigest(["immediate", pilot.digest, binding(pilot, value), run]);
}

export function makeImmediateCIObserver(ctx) {
  let nextAt = 0, cursor = 0;
  return async () => {
    const ci = ctx.deferredCI, pilot = ctx.state.ciPilot?.();
    const time = clockFor(ctx).now();
    if (!ci || !["active", "draining", "restored"].includes(pilot?.phase) || nextAt > time) return;
    nextAt = time + (ctx.config.poll_seconds ?? 30) * 1000;
    const p = pilot.proposal;
    try {
      await withReviewState(ctx, ci.scope(p.repo), async () => {
        if (pilot.phase === "active") ci.owned(ctx, pilot, { active: true });
        const restored = pilot.phase !== "active";
        await ci.live(ctx, pilot, { enabled: !restored });
        const open = await ci.openPulls(pilot);
        for (const row of open.slice(cursor, cursor + 4)) {
          if (!restored && enrolledBranch(row.head.ref)) continue;
          const value = await ci.transport.candidate(p, row.number);
          const run = await ci.immediate(ctx, pilot, value);
          if (!run) continue;
          const fresh = await ci.transport.candidate(p, row.number);
          if (!isDeepStrictEqual(value, fresh)) continue;
          await ci.report(ctx, pilot, value, immediateReportKey(pilot, value, run.id), run.id, async () => {
            await ci.live(ctx, pilot, { enabled: !restored });
            if (!isDeepStrictEqual(value, await ci.transport.candidate(p, row.number)))
              throw deferredCIError("The immediate CI candidate changed before reporting.", "CI_DRIFT");
            ci.owned(ctx, pilot, { active: !restored });
          });
        }
        cursor = cursor + 4 >= open.length ? 0 : cursor + 4;
      });
    } catch (error) {
      ctx.log.warn(`${p.repo}: immediate CI reporting deferred (${error.code || "host evidence unavailable"})`);
      if (error.retryAt > nextAt) nextAt = error.retryAt;
    }
  };
}
