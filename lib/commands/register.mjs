// `gallivant register <pr-url>`: put a hand-made PR, or one opened from a terminal session, into the loop.
// On an entry that already exists it is the reset: reason cleared, iteration zero, a reset comment posted so the
// count recovered from GitHub agrees, watching again.
import { newEntry, entryId, STATES } from "../state.mjs";
import { worktreePath, isOurBranch, prdIdFromBranch } from "../git.mjs";
import { parseBlock, upsertBlock } from "../block.mjs";
import { repoFromUrl, remoteMatches, RESET_MARKER } from "../gh.mjs";
import { receiptHash } from "../deliverable.mjs";
import { rememberRepo } from "../config.mjs";
import { nowIso } from "../time.mjs";

/** The PRD id for a hand-made branch: our own convention when the branch follows it, else a slug of the name. */
const prdIdFor = branch => prdIdFromBranch(branch) ?? branch.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");

export async function register(ctx, { url, harness = null, session = null, worktree = null }) {
  const { config, state, gh, git, log } = ctx;
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
  const chosenHarness = harness || existing?.harness || block?.harness || "claude";
  if (!config.harness[chosenHarness]) throw new Error(`harness "${chosenHarness}" is not configured`);
  if (session && !worktree && !existing?.worktree) throw new Error("--session needs --worktree: both harnesses key sessions by the directory they ran in");

  if (worktree) await assertCheckout(git, worktree, repo, pr.headRefName);
  const dir = worktree || existing?.worktree || await git.fromBranch({ nameWithOwner: repo, prdId, branch: pr.headRefName, path: worktreePath(config, repo, prdId) });
  const chosenSession = session || existing?.session || block?.session || null;

  // The block records the branch as it is; a hand-made branch keeps its name, and recovery only trusts our own.
  if (!block) {
    const prd = existing?.prd || (isOurBranch(pr.headRefName) ? `docs/prds/${prdId}.md` : null);
    await gh.setBody(repo, pr.number, upsertBlock(pr.body, { prd, harness: chosenHarness, session: chosenSession, branch: pr.headRefName }))
      .catch(e => log.warn(`${id}: block write failed: ${e.message}`));
  }
  if (existing) await gh.comment(repo, pr.number, `Watching again from here.\n\n${RESET_MARKER}`).catch(e => log.warn(`${id}: reset comment failed: ${e.message}`));

  const base = existing || newEntry({ prd: block?.prd || null, harness: chosenHarness, repo, branch: pr.headRefName, worktree: dir, state: STATES.prOpen, nowIso: nowIso() });
  // A fresh registration sees the PR's whole history, so feedback already on it gets addressed; a reset starts now.
  // A reset keeps `last.run` and its exit so the tick never re-settles a run that already ended.
  const since = existing ? nowIso() : pr.createdAt;
  const entry = {
    ...base, harness: chosenHarness, session: chosenSession, worktree: dir, pr: pr.number, url: pr.url,
    state: STATES.prOpen, reason: null, iteration: 0,
    cursor: { since, fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
    rereview: { at: since, nudged: false },
    last: existing ? { ...(existing.last || {}), at: nowIso(), event: "reset by register" } : null,
    updated_at: nowIso(),
  };
  state.put(id, entry);
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
