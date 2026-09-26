// The rules for what counts as an event, written as pure functions over the data `gh` returns, so every rule in
// PRD 6.8 has a unit test and the tick only orchestrates.
//
// Inputs are the raw shapes: `pr` from `gh pr view --json`, `reviews`, `inline` and `comments` from REST.
import { actor, normalizeLogin, ROUND_MARKER, NUDGE_MARKER, RESET_MARKER } from "./gh.mjs";
import { isAfter, isAtOrAfter } from "./time.mjs";

const FAILING = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const COMMAND = /^\s*@gallivant\s+fix\b/i;

export function makeTrust(config, ownLogin) {
  if (!ownLogin) throw new Error("trust rules need the daemon's own login");
  const trusted = new Set(config.trusted_authors.map(normalizeLogin));
  const reviewer = config.reviewer ? normalizeLogin(config.reviewer.login) : null;
  const own = normalizeLogin(ownLogin);
  return {
    isTrusted: a => trusted.has(a.login) && !a.bot,
    isReviewer: a => reviewer !== null && a.bot && a.login === reviewer,
    isOwn: a => a.login === own,
  };
}

export const isOwnComment = body => [ROUND_MARKER, NUDGE_MARKER, RESET_MARKER].some(m => String(body || "").includes(m));
export const isRoundComment = body => String(body || "").includes(ROUND_MARKER);
export const isResetComment = body => String(body || "").includes(RESET_MARKER);

/** The key an event is remembered by in `cursor.dispatched`. Review, inline and issue-comment ids are three id spaces. */
export const eventKey = e => `${e.kind}:${e.id}`;

/**
 * Qualifying events since the cursor. Returns normalised events and the newest event time. Failing checks count
 * against `cursor.checks_sha`, the head whose failures were already dispatched, never against the push cursor.
 *
 * The cursor invariant, for everything that carries a GitHub timestamp: an item is new when it is at or after
 * `cursor.since` and its key is not in `cursor.dispatched`. The comparison is inclusive because GitHub timestamps
 * have one-second precision, so a second comment written in the same second as the one that moved the cursor is
 * not "after" it; `dispatched` holds the keys already sent for exactly that second and is what stops a replay.
 * `tick` writes the pair together and resets `dispatched` whenever the second changes, so the list stays short.
 *
 * Editing an item later does not make it new again: the comparison is on `created_at`, never on `updated_at`.
 */
export function deriveEvents({ pr, reviews, inline, comments = [], entry, trust }) {
  const since = entry.cursor.since;
  const dispatched = new Set(entry.cursor.dispatched || []);
  const isNew = (iso, kind, id) => isAtOrAfter(iso, since) && !dispatched.has(`${kind}:${id}`);
  const out = [];

  // Reviews our own login submitted, so an inline note hanging off one is recognised as the harness's own comment on
  // its own work rather than as feedback on it.
  const ownReviews = new Set(reviews.filter(r => trust.isOwn(actor(r.user))).map(r => r.id));

  const inlineByReview = new Map();
  for (const c of inline) {
    const rid = c.pull_request_review_id;
    if (!inlineByReview.has(rid)) inlineByReview.set(rid, []);
    inlineByReview.get(rid).push(c);
  }

  for (const r of reviews) {
    if (!isNew(r.submitted_at, "review", r.id)) continue;
    const a = actor(r.user);
    const attached = (inlineByReview.get(r.id) || []).filter(c => !c.in_reply_to_id);
    const qualifies = (trust.isReviewer(a) && (r.state === "CHANGES_REQUESTED" || (r.state === "COMMENTED" && attached.length > 0)))
      || (trust.isTrusted(a) && r.state === "CHANGES_REQUESTED");
    if (!qualifies) continue;
    out.push({ kind: "review", id: r.id, reviewId: r.id, author: a.login, state: r.state, body: r.body || "", at: r.submitted_at });
    for (const c of attached) out.push(inlineEvent(c, a.login));
    inlineByReview.delete(r.id);
  }

  // Inline comments not attached to a dispatched review: standalone trusted comments, or later comments on a review
  // that was already handled. Replies by our own login are the harness's thread replies.
  for (const list of inlineByReview.values()) {
    for (const c of list) {
      if (!isNew(c.created_at, "inline", c.id)) continue;
      const a = actor(c.user);
      // Our own login writes in two capacities and they have to be told apart, because on a one-operator install the
      // operator's login IS the daemon's: config.md says `trusted_authors` is where your own login belongs. The
      // operator leaving a standalone inline comment is the main feedback channel and must dispatch. The harness
      // answering the fix prompt's "reply to each inline thread" is not feedback, and it arrives two ways: as a reply
      // carrying `in_reply_to_id`, and as inline notes hanging off a review of its own, which is what
      // `gh pr review --comment` produces. Both are the daemon's own work explaining itself, and dispatching a round
      // to answer it is the loop feeding itself.
      if (trust.isOwn(a) && (c.in_reply_to_id || ownReviews.has(c.pull_request_review_id))) continue;
      if (!(trust.isTrusted(a) || trust.isReviewer(a))) continue;
      out.push(inlineEvent(c, a.login));
    }
  }

  for (const c of comments) {
    if (!isNew(c.created_at, "command", c.id) || isOwnComment(c.body)) continue;
    const a = actor(c.user);
    if (!trust.isTrusted(a) || !COMMAND.test(c.body)) continue;
    out.push({ kind: "command", id: c.id, author: a.login, body: c.body.replace(COMMAND, "").trim(), at: c.created_at });
  }

  if (pr.headRefOid && pr.headRefOid !== entry.cursor.checks_sha) {
    const seen = new Set();
    for (const c of failingChecks(pr.statusCheckRollup)) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      out.push({ kind: "check", ...c, at: c.at || pr.createdAt });
    }
  }

  out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  return { events: out, newest: out.length ? out[out.length - 1].at : null };
}

const inlineEvent = (c, login) => ({
  kind: "inline", id: c.id, reviewId: c.pull_request_review_id ?? null, author: login,
  path: c.path, line: c.line ?? c.original_line ?? null, body: c.body || "", at: c.created_at,
});

/** CheckRun and StatusContext entries that failed, with the Actions run id when the URL carries one. */
export function failingChecks(rollup = []) {
  const out = [];
  for (const c of rollup || []) {
    if (c.__typename === "StatusContext") {
      if (["FAILURE", "ERROR"].includes(c.state)) out.push({ name: c.context, url: c.targetUrl, runId: runIdFrom(c.targetUrl), at: c.createdAt });
    } else if (c.status === "COMPLETED" && FAILING.has(c.conclusion)) {
      out.push({ name: c.workflowName ? `${c.workflowName} / ${c.name}` : c.name, url: c.detailsUrl, runId: runIdFrom(c.detailsUrl), at: c.completedAt });
    }
  }
  return out;
}

const runIdFrom = url => (String(url || "").match(/\/actions\/runs\/(\d+)/) || [])[1] ?? null;

/** Every check concluded green. Pending checks are not green. No checks at all is green. */
export function isGreen(rollup = []) {
  const items = rollup || [];
  return items.every(c => c.__typename === "StatusContext" ? c.state === "SUCCESS" : c.status === "COMPLETED" && GREEN.has(c.conclusion));
}

/**
 * The reviewer's verdict since the last request: "none" when no reviewer is configured, "waiting" when it has not
 * reviewed since `sinceIso`, "blocking" when the newest review requests changes or has a blocking inline comment,
 * otherwise "clear". A review that names an older commit than the head does not clear the head.
 *
 * The boundary is inclusive, and `dispatched` deduplicates it, the same pair `deriveEvents` uses and for the same
 * reason: GitHub stamps to the second, so a review submitted in the very second the re-review was requested is not
 * "after" it. A blocking review is dispatched as an event and comes back, but a clear one never is, so under a
 * strict comparison it was excluded permanently and the entry waited until it stopped as `reviewer-silent`.
 * `dispatched` holds the event keys already handled at exactly the cursor's instant, so a review the daemon is
 * already fixing cannot also read as the reviewer clearing this head.
 */
export function reviewerVerdict({ reviews, inline, config, trust, sinceIso, headSha = null, dispatched = [] }) {
  if (!config.reviewer) return { verdict: "none", note: "no reviewer configured" };
  const handled = new Set(dispatched);
  const mine = reviews.filter(r => trust.isReviewer(actor(r.user)) && isAtOrAfter(r.submitted_at, sinceIso) && r.state !== "PENDING" && !handled.has(eventKey({ kind: "review", id: r.id })))
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
  if (!mine.length) return { verdict: "waiting", note: "waiting on reviewer" };
  const newest = mine[0];
  // Which commit was reviewed, from the reviewer's own body first and its `commit_id` second. A review that names no
  // commit at all is no answer about this head: `commit_id` is null once the reviewed commit is gone from the
  // repository, which is what a force-push plus garbage collection leaves, and a falsy value used to skip the guard
  // entirely and clear whatever the head happened to be. So an unknown reviewed commit is `waiting`, not `clear`.
  const reviewed = reviewedCommit(newest.body) || newest.commit_id || null;
  if (headSha && !reviewed) return { verdict: "waiting", note: "reviewer named no commit, so it cannot clear this head" };
  if (headSha && !headSha.startsWith(reviewed) && !reviewed.startsWith(headSha)) return { verdict: "waiting", note: `reviewer looked at ${reviewed.slice(0, 7)}, head is ${headSha.slice(0, 7)}` };
  if (newest.state === "CHANGES_REQUESTED") return { verdict: "blocking", note: "changes requested" };
  const re = new RegExp(config.reviewer.blocking_pattern);
  const hits = inline.filter(c => c.pull_request_review_id === newest.id && re.test(c.body || ""));
  if (hits.length) return { verdict: "blocking", note: `${hits.length} blocking finding${hits.length > 1 ? "s" : ""}` };
  return { verdict: "clear", note: "no blocking findings" };
}

const reviewedCommit = body => (String(body || "").match(/Reviewed commit:\*{0,2}\s*`([0-9a-f]{7,40})`/i) || [])[1] ?? null;

const ownComments = (issueComments, ownLogin) => issueComments
  .filter(c => actor(c.user ?? c.author).login === normalizeLogin(ownLogin))
  .sort((a, b) => Date.parse(a.created_at ?? a.createdAt) - Date.parse(b.created_at ?? b.createdAt));

/**
 * The iteration number: the daemon's own round comments since its last reset comment. Every round posts one
 * (pushed rounds carry the re-review request, receipt-only rounds a note), and `register` posts a reset, so the
 * count on GitHub always equals the counter in the registry.
 */
export function countRounds(issueComments, ownLogin) {
  const mine = ownComments(issueComments, ownLogin);
  const lastReset = mine.map((c, i) => (isResetComment(c.body) ? i : -1)).filter(i => i >= 0).at(-1) ?? -1;
  return mine.slice(lastReset + 1).filter(c => isRoundComment(c.body)).length;
}

export const lastOwnCommentAt = (issueComments, ownLogin) => ownComments(issueComments, ownLogin)
  .filter(c => isOwnComment(c.body)).map(c => c.created_at ?? c.createdAt).at(-1) ?? null;

/** Whether the daemon already posted a comment carrying `marker` after `sinceIso`. */
export const hasOwnComment = (issueComments, ownLogin, marker, sinceIso) => ownComments(issueComments, ownLogin)
  .some(c => String(c.body || "").includes(marker) && isAfter(c.created_at ?? c.createdAt, sinceIso));

/** Only the lines a diff adds, so the completion gate never judges context or removed text. */
export const addedLines = diff => String(diff || "").split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1)).join("\n");
