// The rules for what counts as an event, written as pure functions over the data `gh` returns, so every rule in
// PRD 6.8 has a unit test and the tick only orchestrates.
//
// Inputs are the raw shapes: `pr` from `gh pr view --json`, `reviews`, `inline` and `comments` from REST.
import { actor, normalizeLogin, ROUND_MARKER, NUDGE_MARKER, RESET_MARKER } from "./gh.mjs";
import { hasMarker } from "./public-format.mjs";
import { isAfter, isAtOrAfter, later, floorSecond } from "./time.mjs";

const FAILING = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const COMMAND = /^\s*(?:\/fix\b|@(?:work|gallivant)\s+fix\b)/i;
export const isFixCommand = body => COMMAND.test(String(body ?? ""));

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

export const isOwnComment = body => [ROUND_MARKER, NUDGE_MARKER, RESET_MARKER].some(m => hasMarker(body, m));
export const isRoundComment = body => hasMarker(body, ROUND_MARKER);
export const isResetComment = body => hasMarker(body, RESET_MARKER);

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
    if (!trust.isTrusted(a) || !isFixCommand(c.body)) continue;
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
export function reviewerVerdict({ reviews, inline, comments = [], config, trust, sinceIso, headSha = null, dispatched = [] }) {
  if (!config.reviewer) return { verdict: "none", note: "no reviewer configured" };
  const handled = new Set(dispatched);
  const fromReviews = reviews.filter(r => trust.isReviewer(actor(r.user)) && isAtOrAfter(r.submitted_at, sinceIso) && r.state !== "PENDING" && !handled.has(eventKey({ kind: "review", id: r.id })));

  // A verdict the reviewer posted as a plain comment rather than as a review, normalised into the shape above so the
  // head guard and the blocking rules below judge it identically. Everything after this line is unchanged.
  //
  // This exists because of how Codex answers. Findings arrive as a REVIEW, which carries `commit_id`. A clean verdict
  // arrives as an issue COMMENT, which carries none: "Codex Review: Didn't find any major issues", with the head named
  // in its body as `Reviewed commit: <sha>`. So a PR that passed review looked identical to one the reviewer had never
  // answered: the newest review stayed the one from two pushes ago, the head guard said "reviewer looked at <old>, head
  // is <new>", and the entry waited out `stall_hours` before stopping as `reviewer-silent`. It reported a silent
  // reviewer that had in fact approved the current head three minutes after being asked.
  //
  // The admission rule is deliberately narrow, and the narrowness is the point. A comment qualifies only when it names
  // a commit in its body, which `reviewedCommit` already parses and which the existing guard then checks against the
  // head. Clean is never INFERRED from the absence of findings, because the reviewer says other things in comments and
  // a chatty bot must not be able to clear a pull request by mentioning it. No commit named, no verdict.
  const fromComments = (comments || [])
    .filter(c => trust.isReviewer(actor(c.user)) && isAtOrAfter(c.created_at, sinceIso) && reviewedCommit(c.body, config.reviewer.reviewed_commit_pattern))
    .map(c => ({ id: c.id, body: c.body, user: c.user, submitted_at: c.created_at, state: "COMMENTED", commit_id: null, fromComment: true }));

  const mine = [...fromReviews, ...fromComments].sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
  if (!mine.length) return { verdict: "waiting", note: "waiting on reviewer" };
  const newest = mine[0];
  // Which commit was reviewed, from the reviewer's own body first and its `commit_id` second. A review that names no
  // commit at all is no answer about this head: `commit_id` is null once the reviewed commit is gone from the
  // repository, which is what a force-push plus garbage collection leaves, and a falsy value used to skip the guard
  // entirely and clear whatever the head happened to be. So an unknown reviewed commit is `waiting`, not `clear`.
  const reviewed = reviewedCommit(newest.body, config.reviewer.reviewed_commit_pattern) || newest.commit_id || null;
  if (headSha && !reviewed) return { verdict: "waiting", note: "reviewer named no commit, so it cannot clear this head" };
  if (headSha && !headSha.startsWith(reviewed) && !reviewed.startsWith(headSha)) return { verdict: "waiting", note: `reviewer looked at ${reviewed.slice(0, 7)}, head is ${headSha.slice(0, 7)}` };
  if (newest.state === "CHANGES_REQUESTED") return { verdict: "blocking", note: "changes requested" };
  const re = new RegExp(config.reviewer.blocking_pattern);
  if (re.test(newest.body || "")) return { verdict: "blocking", note: "blocking finding in reviewer message" };
  // Inline findings belong to a REVIEW. A comment-borne verdict has no review to own them, and `newest.id` is a
  // comment id from a different id space, so matching on it could pair a verdict with another review's findings.
  const hits = newest.fromComment ? [] : inline.filter(c => c.pull_request_review_id === newest.id && re.test(c.body || ""));
  if (hits.length) return { verdict: "blocking", note: `${hits.length} blocking finding${hits.length > 1 ? "s" : ""}` };
  return { verdict: "clear", note: "no blocking findings" };
}

/**
 * The commit a reviewer says it looked at, read out of its own body with the pattern that reviewer uses.
 *
 * The pattern is configuration, not a constant, for the same reason `rereview_comment` is: this ships configured for
 * Codex and must not be built around it. A reviewer whose wording differs sets `reviewer.reviewed_commit_pattern` and
 * needs no code change. One that never names a commit leaves the default unmatched and simply cannot clear a head from
 * a plain comment, which is a narrower loop rather than a broken one.
 *
 * A pattern with no capture group, or one that captures something that is not a sha, yields null rather than throwing:
 * an unparseable answer is no answer about this head, which is what the guard above already does with a missing one.
 */
export const reviewedCommit = (body, pattern) => {
  if (!pattern) return null;
  let m;
  try { m = String(body || "").match(new RegExp(pattern, "i")); } catch { return null; }
  const sha = m?.[1];
  return typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
};

/**
 * When the reviewer was last asked to look at a head. Three timers measure from it: the verdict's boundary above, the
 * nudge after `rereview_minutes` and the `reviewer-silent` stop after `stall_hours`. So it must be the moment the ask
 * happened, and every writer of `rereview.at` that has a head in hand comes through here for the one answer.
 *
 * The best available reading of "when this head arrived" is its committer date, which is when the commit was made and
 * not when it reached the branch. GitHub does not report the second, and the two differ by however long the commit sat
 * locally: `git commit` on Monday and `git push` on Thursday, or a merge whose tip carries the merged commit's date. A
 * clock older than `stall_hours` stopped the entry as `reviewer-silent` on the very tick that set it, with the reviewer
 * never asked once, and one older than `rereview_minutes` posted the nudge before the first ask.
 *
 * So the committer date is used only as far back as the nudge window: `floorAt` is the current time, and no clock is
 * set further back than `rereview_minutes` before it. Never one before the previous ask either, since the reviewer
 * cannot have been asked earlier than it already was; `previousAsk` is that value and is null when there was none.
 *
 * Pure, and here rather than in the tick, because the daemon is not the only writer. `reconcile` sets the same field on
 * a recovered entry and used to set it raw, so a PR whose last round comment was older than `stall_hours` was stopped
 * as `reviewer-silent` on the first tick after a crash recovery, for silence that accrued while no daemon was running
 * to ask. The floor gives a recovered entry the same grace a freshly nudged one gets.
 */
export function reviewerClock({ config, pushedAt, previousAsk = null, floorAt }) {
  const floor = new Date(Date.parse(floorAt) - config.rereview_minutes * 60_000).toISOString();
  return floorSecond(later(later(pushedAt, floor), previousAsk));
}

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
  .some(c => hasMarker(c.body, marker) && isAfter(c.created_at ?? c.createdAt, sinceIso));

/** Only the lines a diff adds, so the completion gate never judges context or removed text. */
export const addedLines = diff => String(diff || "").split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).map(l => l.slice(1)).join("\n");
