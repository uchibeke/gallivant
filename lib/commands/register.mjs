// `gallivant register <pr-url>`: put a hand-made PR, or one opened from a terminal session, into the loop.
// On an entry that already exists it is the reset: reason cleared, iteration zero, a reset comment posted so the
// count recovered from GitHub agrees, watching again.
import { resolve } from "node:path";
import { newEntry, entryId, STATES } from "../state.mjs";
import { worktreePath, isOurBranch, prdIdFromBranch } from "../git.mjs";
import { parseBlock, upsertBlock } from "../block.mjs";
import { repoFromUrl, remoteMatches, RESET_MARKER } from "../gh.mjs";
import { receiptHash } from "../deliverable.mjs";
import { rememberRepo, defaultHarness } from "../config.mjs";
import { isSessionFor } from "../harness.mjs";
import { ensurePrdSnapshot, toPrdId } from "../prd.mjs";
import { nowIso, floorSecond } from "../time.mjs";

/** The PRD id for a hand-made branch: our own convention when the branch follows it, else a slug of the name. */
const prdIdFor = branch => prdIdFromBranch(branch) ?? toPrdId(branch);

export async function register(ctx, { url, harness = null, session = null, worktree = null }) {
  const { config, state, gh, git, log } = ctx;
  // Resolved against the directory `register` runs in, before anything reads it. The registry is read back by a
  // daemon whose working directory is its own, so a relative path stored as typed would point somewhere else there:
  // the harness would run in the wrong tree, or `ensureWorktree` would clone over it. Absolute from here on.
  if (worktree) worktree = resolve(worktree);
  const parsed = repoFromUrl(url);
  if (!parsed) throw new Error(`not a GitHub PR URL: ${url}`);
  const pr = await gh.prView(parsed.repo, parsed.number);
  // The repo as GitHub spells it, so an oddly cased URL never yields a second entry for the same PR.
  const repo = repoFromUrl(pr.url)?.repo || parsed.repo;
  if (pr.isCrossRepository) throw new Error("fork PRs are not registered");
  if (pr.state !== "OPEN") throw new Error(`PR is ${pr.state}`);

  const { block } = parseBlock(pr.body);
  const prdId = prdIdFor(pr.headRefName);
  const found = state.findByPr(repo, pr.number);
  const id = found ? found[0] : entryId(repo, prdId);
  const existing = found ? found[1] : state.get(id);
  if (existing && existing.pr !== pr.number && existing.pr !== null) throw new Error(`${id} already watches PR #${existing.pr}`);
  const chosenHarness = harness || existing?.harness || block?.harness || defaultHarness(config);
  if (!config.harness[chosenHarness]) throw new Error(`harness "${chosenHarness}" is not configured`);
  if (session && !worktree && !existing?.worktree) throw new Error("--session needs --worktree: both harnesses key sessions by the directory they ran in");
  // The same rule the block is held to, so the flag and the block agree on what a session is. A value typed here
  // reaches argv position 2 on the next fix round, right after `--resume` or `--name`, where `assertSafeArgv` matches
  // flag spellings and not values in unexpected positions: `--session '--approval-mode=yolo'` was accepted, and
  // goose derives its session FILE from the name, so `--session ../../../etc/passwd` chose where that file went.
  if (session && !isSessionFor(chosenHarness, session)) throw new Error(`--session "${String(session).slice(0, 60)}" is not a ${chosenHarness} session id; nothing was registered`);

  if (worktree) await assertCheckout(git, worktree, repo, pr.headRefName);
  const dir = worktree || existing?.worktree || await git.fromBranch({ nameWithOwner: repo, prdId, branch: pr.headRefName, path: worktreePath(config, repo, prdId) });
  // The final harness and session pair, checked as a PAIR. `--session` is validated against the chosen harness above,
  // but an INHERITED session never was: `--harness codex` with no `--session` carried the old harness's id straight
  // through, so changing claude to opencode kept a UUID where opencode needs `ses_...`. The next fix round then resumed
  // an id its harness cannot mean, and the block written with it was refused by `parseBlock` on the way back, which
  // kills the recovery the block exists for.
  //
  // Cleared rather than refused. A session id from another harness is not a mistake the operator made, it is a value
  // that has no meaning under the new harness: opencode cannot resume claude's conversation whatever it is called. So
  // the honest result is no session, which is what a fresh registration has, and the next fix round starts one. What it
  // must not be is silent, because the operator loses a conversation they may have wanted: the drop is logged with both
  // harnesses and the id, and `register` returns the session it actually stored so the caller never reports a resume it
  // did not keep. An explicit `--session` is a different case and still refuses above, because an operator who typed an
  // id meant that id.
  let chosenSession = session || existing?.session || block?.session || null;
  const from = existing?.session === chosenSession ? existing.harness : block?.harness;
  if (chosenSession && !session && (from !== chosenHarness || !isSessionFor(chosenHarness, chosenSession))) {
    log.warn(`${id}: session ${chosenSession} is not a ${chosenHarness} session id${from && from !== chosenHarness ? ` (it is ${from}'s)` : ""}; dropped, and the next fix round will start a fresh ${chosenHarness} session`);
    chosenSession = null;
  }

  // The block records the branch as it is; a hand-made branch keeps its name, and recovery only trusts our own.
  // It is written when there is none, and rewritten when `--harness` or `--session` overrode what it records. The
  // invariant is that the block and the entry never disagree about identity: reconciliation rebuilds an entry from
  // the block alone after `state.json` is lost, so a block left saying the old harness or the old session would
  // restore the wrong one. The PRD path in an existing block is kept; only identity is being corrected here.
  const blockPrd = block?.prd || existing?.prd || (isOurBranch(pr.headRefName) ? `docs/prds/${prdId}.md` : null);
  const stale = block && (block.harness !== chosenHarness || block.session !== chosenSession);

  // Two durable GitHub writes, and the ORDER between them is the whole of this. Both are preconditions of the local
  // reset, so either failing throws and leaves the registry untouched; what the order decides is what GitHub is left
  // saying when the SECOND one fails.
  //
  // The body write is the point of no return, so it goes last. It changes the recovery identity: `reconcile` rebuilds
  // an entry from the block alone once `state.json` is lost, reading the harness and the session out of it. With the
  // body written first and the comment then failing, `register` reported that nothing was reset and left the registry
  // on the OLD identity while GitHub already recorded the new one, so a running daemon and a later recovery resumed
  // different harnesses or different sessions for the same PR. That is the one outcome no retry recovers from, because
  // neither side is wrong on its own terms and nothing compares them.
  //
  // The comment is safely repeatable, which is what qualifies it to go first. `countRounds` takes the LAST reset
  // marker among the daemon's own comments and counts the round comments after it (`events.mjs:208`), so a second
  // marker counts exactly as one does. A failed body write therefore leaves a reset comment on the PR, the registry
  // untouched, and an identity that still agrees with itself on both sides; running the same command again completes
  // the reset and the extra comment changes no count.
  //
  // Throwing is the choice for both, where the tick's equivalent has to leave a retryable state instead: `register` is
  // one interactive command with an operator in front of it, and it already refuses for other preconditions (a fork
  // PR, a closed PR, an unconfigured harness, a mistyped `--worktree`).

  // The reset comment IS the reset boundary. `countRounds` finds it among the daemon's own comments and counts the
  // round comments after it; with the comment missing, every round comment of every earlier round is still in front of
  // it, so a recovery after `state.json` is lost rebuilds the iteration this command had just zeroed. An entry restored
  // at `max_iterations` then stops with `reason: "iterations"` on its next event, having done no work in this round at
  // all, and the operator is told the budget is spent on a PR they had just reset.
  if (existing) {
    try { await gh.comment(repo, pr.number, `Watching again from here.\n\n${RESET_MARKER}`); }
    catch (e) { throw new Error(`cannot post the reset comment on ${pr.url}: ${e.message}. Nothing was reset; the entry keeps its ${existing.iteration} round${existing.iteration === 1 ? "" : "s"} and its state, and its recorded harness and session are unchanged. Fix the cause and run register again.`); }
  }
  // The identity of record, written last of the two and still before anything reaches the registry, so a failure here
  // leaves GitHub and the registry agreeing on the OLD identity rather than disagreeing.
  if (!block || stale) {
    try { await gh.setBody(repo, pr.number, upsertBlock(pr.body, { prd: blockPrd, harness: chosenHarness, session: chosenSession, branch: pr.headRefName })); }
    // The message names the identity that survived, and only claims the PR agrees when the PR actually had a block to
    // agree with: an existing entry on a PR with no block at all is a case where the registry has an identity and
    // GitHub has none, which is what this write was about to fix and is not the same as the two of them agreeing.
    catch (e) { throw new Error(`cannot write the gallivant block to ${pr.url}: ${e.message}. Nothing was registered${existing ? `: the entry keeps harness ${existing.harness} and session ${existing.session ?? "none"}${block ? ", which is still what the PR records" : ", and the PR still records no identity at all"}` : ""}. Fix the cause and run register again.`); }
    if (stale) log.info(`${id}: PR block updated to harness ${chosenHarness}, session ${chosenSession ?? "none"}`);
  }

  // `base` on the entry is the branch this PR targets, and it comes from the PR itself. A registered PR is one a person
  // opened, so the operator's config has no say in where it was aimed: `baseRefName` is the truth, and it is what the
  // daemon merges in before every later round. An existing entry keeps whatever it had unless the PR says otherwise,
  // which is how a retargeted PR is picked up on the next register.
  const prBase = typeof pr.baseRefName === "string" && pr.baseRefName ? pr.baseRefName : null;
  const base = existing || newEntry({ prd: blockPrd, harness: chosenHarness, repo, branch: pr.headRefName, worktree: dir, state: STATES.prOpen, nowIso: nowIso(), base: prBase });
  // A fresh registration sees the PR's whole history, so feedback already on it gets addressed; a reset starts now.
  // A reset keeps `last.run` and its exit so the tick never re-settles a run that already ended.
  //
  // Floored to the second. GitHub stamps comments and reviews to the second while `nowIso()` carries milliseconds,
  // and the cursor comparison is inclusive of its own boundary, so a cursor of 02:00:00.500Z would sit after every
  // piece of feedback written in that second and lose it for good.
  const since = floorSecond(existing ? nowIso() : pr.createdAt);
  const entry = {
    ...base, harness: chosenHarness, session: chosenSession, worktree: dir, pr: pr.number, url: pr.url, base: prBase ?? base.base ?? null,
    // `retry` goes with `reason`: it counts the consecutive failures of one GitHub write the tick declines a step for,
    // and a reset is the operator saying the cause is dealt with. Left behind, an entry reset after a `stuck` stop would
    // carry four failures into its next one and stop again on the first write that failed.
    //
    // `round_comment` goes with `iteration`, for the same reason and one more. It is the comment a counted round still
    // owes the PR, and the reset zeroes the count, so a debt carried across it would announce a round the registry no
    // longer claims: the daemon would post "round 0" and `why` would report a recovery counting minus one. The reset
    // comment posted above is the new boundary anyway, so every marker before it is already outside the count and one
    // more would change nothing. `labels_pending` goes with them, though it is inert rather than wrong: it is only read
    // on a `needs-human` entry and `needsHuman` recomputes it on the next stop, so a stale true never acts. It is
    // cleared anyway, because a reset entry carrying a debt from before the reset is a thing a reader has to reason
    // about, and there is no reading of it that should survive.
    //
    // `prd_divergence` goes with `reason` for the same reason and is inert in the same way. It is the difference between
    // the brief the run started against and the operator's own copy, recorded when the tick stopped the entry for it, and
    // every reader of it (`status`, `why`, the tracker) recomputes the comparison live rather than trusting the field. So
    // a stale one never decides anything. It is cleared because a reset entry carrying the record of a stop it no longer
    // has is a thing a reader has to reason about. What is deliberately NOT cleared is `checkout` and `prd_fingerprint`:
    // those say where the operator's copy lives and what contract the snapshot carries, which a reset does not change,
    // and dropping them would silently turn the comparison off for a PR the operator has just asked to watch again.
    state: STATES.prOpen, reason: null, retry: null, iteration: 0, round_comment: null, labels_pending: false, prd_divergence: null,
    // `checks_sha` is null, and `up.mjs`'s `reconcile` now agrees rather than setting it to the recovered head. It names
    // the head whose failing checks were already dispatched, and on a PR being taken over no head qualifies: a fix that
    // had been dispatched and had pushed would have moved the head, so red checks on the head that is actually there
    // have not been addressed by anything, and the operator running this command is asking for them to be.
    cursor: { since, dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
    rereview: { at: since, nudged: false },
    last: existing ? { ...(existing.last || {}), at: nowIso(), event: "reset by register" } : null,
    updated_at: nowIso(),
  };
  state.put(id, entry);
  // The snapshot the completion gate reads, taken the same way `reconcile` takes it. Without it `prdFor` returns
  // nothing, the gate logs "no PRD snapshot" and the PR can be marked ready with no acceptance criterion evaluated.
  // After the entry is stored, so a GitHub read that fails leaves a watched PR rather than an aborted registration.
  // A snapshot already on disk is kept, so a reset never replaces the authoritative copy with the one the session
  // could have edited.
  await ensurePrdSnapshot(ctx, { id, repo, path: blockPrd, ref: pr.headRefName });
  if (rememberRepo(repo, config.home)) await gh.ensureLabels(repo).catch(e => log.warn(`${repo}: labels not created: ${e.message}`));
  log.info(`${id}: ${existing ? "reset and " : ""}watching ${pr.url} with ${chosenHarness}${chosenSession ? " (resume)" : " (fresh session on first fix)"}`);
  return { id, pr: pr.number, worktree: dir, harness: chosenHarness, session: chosenSession };
}

/**
 * A worktree passed on the command line is stored as given and the harness then edits and pushes from it, so it is
 * checked before it is accepted: same repository on `origin`, already on the PR's head branch. A mistyped or stale
 * path is an error rather than a second repository quietly taking the session's commits. It is never relocated or
 * re-cloned, because a resumed session is keyed to the directory it ran in.
 */
async function assertCheckout(git, dir, repo, branch) {
  if (!git.exists(dir)) throw new Error(`--worktree ${dir} is not a git checkout`);
  let origin;
  try { origin = await git.originOf(dir); }
  catch (e) { throw new Error(`--worktree ${dir} has no origin remote: ${e.message}`); }
  if (!remoteMatches(origin, repo)) throw new Error(`--worktree ${dir} is a clone of ${origin}, not ${repo}`);
  let current;
  try { current = await git.currentBranch(dir); }
  catch (e) { throw new Error(`--worktree ${dir}: cannot read the checked-out branch: ${e.message}`); }
  if (current !== branch) throw new Error(`--worktree ${dir} is on ${current}, not the PR's branch ${branch}; check it out there first`);
}
