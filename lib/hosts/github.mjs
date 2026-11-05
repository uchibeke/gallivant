import { githubDefinition } from "./github_contract.mjs";
// GitHub's transport, credentials, prompt commands and wire-to-domain conversion.
import { makeGh } from "../gh.mjs";
import { resolveCredential } from "../credential.mjs";
import { actor } from "../host_contract.mjs";
import { githubReviewSummary } from "./github_review_summary.mjs";

const source = Object.freeze({ host: "github.com", adapter: "github-pull-request" });
const stamp = (record, kind) => ({ source, eventId: String(record.id ?? record.number ?? ""), actor: actor(record.user ?? record.author),
  headSha: record.commit_id ?? record.headRefOid ?? null, createdAt: record.created_at ?? record.createdAt ?? record.submitted_at ?? null,
  updatedAt: record.updated_at ?? record.updatedAt ?? null, kind });
export function normalizeEvent(record, kind) {
  if (!record || record.id == null || (record.state !== "PENDING" && !Number.isFinite(Date.parse(record.submitted_at ?? record.created_at)))) throw new Error(`Incomplete ${kind} record`);
  const reviewSummary = kind === "comment" ? githubReviewSummary(record) : null;
  const structuredReview = kind === "comment" && String(record.body ?? "").includes("codex-review-state:");
  return { ...record, ...stamp(record, kind), at: record.submitted_at ?? record.created_at, reviewId: record.pull_request_review_id ?? null,
    replyTo: record.in_reply_to_id ?? null, ...(structuredReview ? { reviewSummary } : {}) };
}
export function normalizeCheck(record, headSha) {
  const context = record.__typename === "StatusContext";
  const state = context ? record.state : record.status === "COMPLETED" ? record.conclusion : "PENDING";
  if (typeof (context ? record.state : record.status) !== "string" || typeof state !== "string" || !(record.name || record.context)) throw new Error("Incomplete CI record");
  return { ...record, source, actor: actor(record.creator), eventId: String(record.id ?? record.context ?? record.name), headSha,
    name: context ? record.context : record.workflowName ? `${record.workflowName} / ${record.name}` : record.name,
    outcome: ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state) ? "passed" : ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(state) ? "failed" : "pending",
    url: context ? record.targetUrl : record.detailsUrl, runId: String(record.detailsUrl ?? record.targetUrl ?? "").match(/\/actions\/runs\/(\d+)/)?.[1] ?? null,
    createdAt: record.createdAt ?? record.startedAt ?? null, updatedAt: record.completedAt ?? record.createdAt ?? null };
}
export function normalizePr(record, { full = true } = {}) {
  if (!record || !Number.isSafeInteger(record.number) || !record.url || !record.headRefOid || !["OPEN", "CLOSED", "MERGED"].includes(record.state) ||
      (full && (!Array.isArray(record.statusCheckRollup) || record.statusCheckRollup.length >= 100))) throw new Error("Incomplete pull request or CI evidence; preserve the last known state");
  return { ...record, ...stamp(record, "pull-request"), ...(full ? { statusCheckRollup: record.statusCheckRollup.map(c => normalizeCheck(c, record.headRefOid)) } : {}) };
}

export const github = Object.freeze({
  ...githubDefinition,
  credential: (config, options) => resolveCredential(config, options),
  create(options) {
    const api = makeGh(options);
    return { ...api,
      prView: async (...args) => normalizePr(await api.prView(...args)),
      setRecoveryMetadata: async (...args) => normalizePr(await api.setRecoveryMetadata(...args)),
      prListByHead: async (...args) => {
        const rows = await api.prListByHead(...args);
        if (!Array.isArray(rows) || rows.length >= 30) throw new Error("Incomplete PR list; narrow or recover the branch before retrying");
        return rows.map(r => normalizePr(r, { full: false }));
      },
      prListMine: async (...args) => {
        const rows = await api.prListMine(...args);
        if (!Array.isArray(rows) || rows.length >= 100) throw new Error("Incomplete PR recovery list; recover explicitly by PR URL before retrying");
        return rows.map(r => normalizePr(r, { full: false }));
      },
      ...Object.fromEntries([["reviews", "review"], ["inlineComments", "inline"], ["issueComments", "comment"]].map(([method, kind]) =>
        [method, async (...args) => (await api[method](...args)).map(r => normalizeEvent(r, kind))])),
    };
  },
});
