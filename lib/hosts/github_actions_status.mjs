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

/** Called only by the GitHub adapter with normalized, authenticated PR data. */
export function pendingActionsStatuses({ read, clock = Date, log = null }) {
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
        const promise = Promise.resolve().then(() => read(repo, id)).then(record => runEvidence(record, repo, id, clock.now())).catch(() => {
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
      if (!evidence || evidence.status !== "completed" || githubCheckOutcome(String(evidence.conclusion).toUpperCase()) !== "failed" ||
          target.attempt && target.attempt !== evidence.attempt || created < Date.parse(evidence.startedAt) || created > Date.parse(evidence.updatedAt)) continue;
      changes.set(check, { ...check, outcome: "failed", updatedAt: evidence.updatedAt, failureSource: "github-actions-run", actionsRun: { ...evidence } });
    }
    return changes.size ? { ...pr, statusCheckRollup: pr.statusCheckRollup.map(check => changes.get(check) || check) } : pr;
  };
}
