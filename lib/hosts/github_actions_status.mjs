import { parsePullRequestUrl, repositoryIdentity } from "../repository.mjs";

// Status contexts can remain PENDING when a workflow fails before publishing its
// final status. Its linked workflow is failure evidence only, never a substitute
// for successful current-head check evidence.
const FAILURES = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
export const githubCheckOutcome = state => ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state) ? "passed" : FAILURES.has(state) ? "failed" : "pending";
export const ACTIONS_STATUS_LIMITS = Object.freeze({ reads: 4, cacheEntries: 256, prEntries: 128, ttlMs: 60_000, timeoutMs: 10_000 });

function runTarget(value, repo) {
  try {
    const url = parsePullRequestUrl(value), match = url.pathname.match(/^([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?\/?$/);
    if (url.host !== "github.com" || !match || repositoryIdentity(match[1]).path !== repo || !Number.isSafeInteger(Number(match[2])) || match[3] && !Number.isSafeInteger(Number(match[3]))) return null;
    return { id: Number(match[2]), attempt: match[3] ? Number(match[3]) : null };
  } catch { return null; }
}

function runEvidence(record, repo, id, now) {
  const target = runTarget(record?.html_url, repo), repository = record?.repository;
  const created = Date.parse(record?.created_at), started = Date.parse(record?.run_started_at), updated = Date.parse(record?.updated_at);
  if (record?.id !== id || !target || target.id !== id || !Number.isSafeInteger(repository?.id) || repository.id < 1 ||
      typeof repository.full_name !== "string" || repository.full_name.toLowerCase() !== repo ||
      typeof record.status !== "string" || record.conclusion !== null && typeof record.conclusion !== "string" ||
      !Number.isSafeInteger(record.run_attempt) || record.run_attempt < 1 || target.attempt && target.attempt !== record.run_attempt ||
      !/^[a-f0-9]{40,64}$/.test(record.head_sha ?? "") || ![created, started, updated].every(Number.isFinite) ||
      started < created || updated < started || updated > now) return null;
  return { id, attempt: record.run_attempt, status: record.status, conclusion: record.conclusion,
    headSha: record.head_sha, startedAt: record.run_started_at, updatedAt: record.updated_at, url: record.html_url };
}

const remember = (map, key, value, limit) => {
  map.delete(key); map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
};

/** Authenticated job/attempt evidence for a single exact PR check. The
 * annotation text is never passed to the author or stored in recovery state. */
export function actionsRepairEvidence(read, clock = Date) {
  const number = value => Number.isSafeInteger(value) && value > 0;
  const bounded = (items, count, limit) => Array.isArray(items) && items.length === count && count <= limit;
  const key = job => typeof job.name === "string" && job.name.length <= 240 && !/[\x00-\x1f]/.test(job.name) ? job.name : null;
  return async (repo, { pr, check, baseSha, original }) => {
    if (pr.state !== "OPEN" || check.headSha !== pr.headRefOid || !/^[0-9a-f]{40}$/.test(pr.headRefOid) ||
        !/^[0-9a-f]{40}$/.test(baseSha) || check.source?.host !== "github.com") return null;
    let url;
    try { url = parsePullRequestUrl(check.url); } catch { return null; }
    const match = url.pathname.match(/^([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?(?:\/job\/([1-9]\d*))?\/?$/);
    if (url.host !== "github.com" || !match || match[1].toLowerCase() !== repo) return null;
    const [, , runValue, attempt, jobValue] = match, id = Number(runValue), jobId = Number(jobValue ?? check.actionsRun?.failedJob?.id);
    if (!number(id) || !number(jobId)) return null;
    const root = `repos/${repo}`;
    const api = path => read(`${root}/${path}`);
    const raw = await api(`actions/runs/${id}`);
    const run = runEvidence(raw, repo, id, clock.now());
    if (!run || run.headSha !== pr.headRefOid || attempt && Number(attempt) !== run.attempt ||
        raw.head_repository?.id !== raw.repository.id || !number(raw.workflow_id)) return null;
    const jobsFor = async (runId, runAttempt, head) => {
      const page = await api(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`);
      return bounded(page?.jobs, page?.total_count, 100) ? page.jobs.filter(job => job.run_id === runId &&
        job.run_attempt === runAttempt && job.head_sha === head && number(job.id) && job.status === "completed") : null;
    };
    const job = (await jobsFor(id, run.attempt, run.headSha))?.find(job => job.id === jobId);
    if (!job || !key(job) || !Array.isArray(job.steps) || job.steps.length > 100 ||
        Date.parse(job.completed_at) < Date.parse(run.startedAt) || !Number.isFinite(Date.parse(job.completed_at)) ||
        Date.parse(job.completed_at) > clock.now()) return null;
    const evidence = { run: id, attempt: run.attempt, job: jobId, workflow: raw.workflow_id, name: key(job), head: run.headSha };
    if (original) {
      if (check.outcome !== "passed" || job.conclusion !== "success" || evidence.workflow !== original.workflow ||
          evidence.name !== original.name || !job.steps.some(step => step.number === original.step && step.name === original.stepName &&
            step.status === "completed" && step.conclusion === "success")) return null;
      return { ...evidence, kind: "cleared", step: original.step };
    }
    if (check.outcome !== "failed" || job.conclusion === "success" || job.conclusion === "skipped") return null;
    if (job.conclusion !== "failure")
      return { ...evidence, kind: "infrastructure", conclusion: job.conclusion };
    const failures = job.steps.filter(step => step.status === "completed" && step.conclusion === "failure");
    if (failures.length !== 1 || !number(failures[0].number) || !key(failures[0])) return null;
    const step = failures[0];
    let checkRun;
    try { checkRun = parsePullRequestUrl(job.check_run_url); } catch { return null; }
    const checkId = checkRun.pathname.match(/^repos\/([^/]+\/[^/]+)\/check-runs\/([1-9]\d*)$/);
    if (checkRun.host !== "api.github.com" || !checkId || checkId[1].toLowerCase() !== repo || !number(Number(checkId[2]))) return null;
    const annotations = await api(`check-runs/${checkId[2]}/annotations?per_page=100`);
    if (!Array.isArray(annotations) || annotations.length >= 100) return null;
    const paths = [...new Set(annotations.filter(item => item.annotation_level === "failure" && typeof item.path === "string").map(item => item.path))].sort();
    if (!paths.length) return { ...evidence, kind: "unclassified" };
    const base = await api(`actions/workflows/${raw.workflow_id}/runs?head_sha=${baseSha}&per_page=20`);
    const latest = bounded(base?.workflow_runs, base?.total_count, 20) && base.workflow_runs.find(row =>
      row.head_sha === baseSha && row.workflow_id === raw.workflow_id && row.repository?.id === raw.repository.id &&
      row.head_repository?.id === raw.repository.id);
    const baseRun = latest && runEvidence(latest, repo, latest.id, clock.now());
    if (!baseRun || baseRun.status !== "completed") return null;
    const counterpart = (await jobsFor(baseRun.id, baseRun.attempt, baseSha))?.filter(other => key(other) === key(job));
    if (counterpart?.length !== 1) return null;
    const baseJob = counterpart[0], baseStep = baseJob.steps?.find(other => other.number === step.number && other.name === step.name);
    if (baseJob.conclusion === "failure" && baseStep?.conclusion === "failure")
      return { ...evidence, kind: "base-regression", baseRun: baseRun.id, baseJob: baseJob.id };
    if (baseJob.conclusion !== "success" || baseStep?.conclusion !== "success") return null;
    return { ...evidence, kind: "semantic", step: step.number, stepName: step.name, paths, baseRun: baseRun.id, baseJob: baseJob.id, baseSha };
  };
}

/** Called only by the GitHub adapter with normalized, authenticated PR data. */
export function pendingActionsStatuses({ read, readJobs, clock = Date, log = null }) {
  const cache = new Map(), positions = new Map();
  return async (repository, pr) => {
    const identity = repositoryIdentity(repository);
    if (identity.host !== "github.com" || pr.state !== "OPEN") return pr;
    const repo = identity.path, contexts = pr.statusCheckRollup.filter(check => check.__typename === "StatusContext" &&
      check.state === "PENDING" && check.outcome === "pending" && check.headSha === pr.headRefOid && Number.isFinite(Date.parse(check.createdAt)))
      .map(check => ({ check, target: runTarget(check.url, repo) })).filter(item => item.target);
    const ids = [...new Set(contexts.map(item => item.target.id))];
    if (!ids.length) return pr;
    const key = `${repo}#${pr.number}`, start = (positions.get(key) || 0) % ids.length, now = clock.now(), pending = [];
    let count = 0, next = start;
    for (let offset = 0; offset < ids.length; offset++) {
      const index = (start + offset) % ids.length, id = ids[index], cacheKey = `${repo}:${id}`;
      let saved = cache.get(cacheKey);
      if ((!saved || saved.expiresAt <= now) && count < ACTIONS_STATUS_LIMITS.reads) {
        count++; next = (index + 1) % ids.length;
        const promise = Promise.resolve().then(async () => {
          const run = runEvidence(await read(repo, id), repo, id, clock.now());
          if (!readJobs || run?.status !== "in_progress" || run.headSha !== pr.headRefOid) return run;
          const page = await readJobs(repo, id, run.attempt);
          if (!Array.isArray(page?.jobs) || page.jobs.length !== page.total_count || page.jobs.length > 100) return run;
          const failed = page.jobs.find(job => job.run_id === id && job.run_attempt === run.attempt &&
            job.head_sha === run.headSha && job.status === "completed" && Number.isSafeInteger(job.id) && job.id > 0 &&
            githubCheckOutcome(String(job.conclusion).toUpperCase()) === "failed" &&
            Date.parse(job.completed_at) >= Date.parse(run.startedAt) && Date.parse(job.completed_at) <= clock.now());
          return failed ? { ...run, failedJob: { id: failed.id, completedAt: failed.completed_at } } : run;
        }).catch(() => {
          log?.warn?.(`${repo}: Actions run ${id} evidence unavailable; retaining pending status`); return null;
        });
        saved = { expiresAt: now + ACTIONS_STATUS_LIMITS.ttlMs, promise };
        remember(cache, cacheKey, saved, ACTIONS_STATUS_LIMITS.cacheEntries);
      }
      if (saved?.expiresAt > now) pending.push(saved.promise);
    }
    remember(positions, key, next, ACTIONS_STATUS_LIMITS.prEntries);
    await Promise.all(pending);
    const changes = new Map();
    for (const { check, target } of contexts) {
      const saved = cache.get(`${repo}:${target.id}`);
      if (!saved || saved.expiresAt <= now) continue;
      const evidence = await saved.promise, created = Date.parse(check.createdAt);
      if (!evidence || !(evidence.failedJob || evidence.status === "completed" && githubCheckOutcome(String(evidence.conclusion).toUpperCase()) === "failed") ||
          target.attempt && target.attempt !== evidence.attempt || created < Date.parse(evidence.startedAt) || created > Date.parse(evidence.failedJob?.completedAt || evidence.updatedAt)) continue;
      changes.set(check, { ...check, outcome: "failed", updatedAt: evidence.failedJob?.completedAt || evidence.updatedAt, failureSource: evidence.failedJob ? "github-actions-job" : "github-actions-run", actionsRun: { ...evidence } });
    }
    return changes.size ? { ...pr, statusCheckRollup: pr.statusCheckRollup.map(check => changes.get(check) || check) } : pr;
  };
}
