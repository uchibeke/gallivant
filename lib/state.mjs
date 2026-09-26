// The registry: one entry per PRD or registered PR, keyed by `<owner>/<repo>/<prd id>`.
//
// The file is a cache with cursors. Identity (which PR, which session) can be rebuilt from GitHub; counters and
// cursors can be rebuilt by counting the daemon's own comments. Every write is atomic and every read-modify-write
// holds a lock file, so the CLI and the daemon cannot lose each other's updates.
import { join, basename } from "node:path";
import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { readJson, writeJsonAtomic, gallivantHome } from "./fs.mjs";
import { later } from "./time.mjs";

export const STATES = Object.freeze({
  running: "running",           // start run in progress, no PR yet
  prOpen: "pr-open",            // watched
  ready: "ready-for-human",     // watched, waiting for a person to merge
  needsHuman: "needs-human",    // stopped with a reason
  done: "done",                 // merged or closed
});

export const statePath = (home = gallivantHome()) => join(home, "state.json");

/**
 * The repository name without its owner, for a handle a person reads: `acme/widget` is `widget`. Anything that is
 * not `owner/name` degrades to what it was given rather than to `undefined`, and a missing repo to the empty string
 * rather than a throw. Both used to reach the operator: the ntfy title said `undefined#3` and told them to run
 * `gallivant why undefined#3`, and the throw happened inside `needsHuman` after the labels were written but before
 * the notification, where the tick's per-entry catch swallowed it and a stopped PR notified nobody at all.
 */
export const shortRepo = nameWithOwner => { const s = String(nameWithOwner ?? ""); return s.split("/")[1] || s; };

/** `<repo>#<pr>` when there is a PR, else the registry id. */
export const handleFor = (id, entry) => (entry.pr ? `${shortRepo(entry.repo)}#${entry.pr}` : id);

/** Registry id: a pure function of the repository and the PRD, so every path keyed by it agrees. */
export const entryId = (nameWithOwner, prdId) => `${nameWithOwner.toLowerCase()}/${prdId}`;

/** The PRD id is the last segment of the registry id. */
export const prdIdOf = id => id.split("/").pop();

/** A filesystem-safe form of the id for run and snapshot folders. */
export const idSlug = id => id.replaceAll("/", "__");

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

/** Hold an exclusive lock file for the duration of `fn`. Waits up to five seconds; a lock older than thirty is stale. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try { return fn(); } finally { closeSync(fd); try { unlinkSync(lock); } catch { /* gone */ } }
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`state is locked by another gallivant process (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

export function makeState(home = gallivantHome()) {
  const file = statePath(home);
  const load = () => readJson(file, { version: 1, entries: {} });
  const save = s => writeJsonAtomic(file, s, 0o600);
  const locked = fn => withLock(file, fn);
  return {
    file,
    load,
    entries: () => Object.entries(load().entries),
    get: id => load().entries[id] || null,
    /** The entry that watches this PR, if any. */
    findByPr: (repo, pr) => Object.entries(load().entries).find(([, e]) => e.repo === repo.toLowerCase() && e.pr === pr) || null,
    put: (id, entry) => locked(() => { const s = load(); s.entries[id] = entry; save(s); return entry; }),
    update: (id, patch) => locked(() => { const s = load(); const cur = s.entries[id]; if (!cur) throw new Error(`no entry ${id}`); s.entries[id] = { ...cur, ...patch }; save(s); return s.entries[id]; }),
    remove: id => locked(() => { const s = load(); delete s.entries[id]; save(s); }),
  };
}

/**
 * Resolve what the operator typed to a registry id. Accepts the id itself, a PRD path, or `repo#pr` where repo is
 * the short name or owner/name. Bare PR numbers are refused because they are ambiguous across repos.
 */
export function resolveHandle(entries, handle) {
  if (!handle) throw new Error("handle required: <owner>/<repo>/<prd id>, <prd path>, or <repo>#<pr>");
  if (/^\d+$/.test(handle)) throw new Error(`"${handle}" is ambiguous across repos; use <repo>#${handle}`);
  const direct = entries.find(([id]) => id === handle.toLowerCase() || id === handle);
  if (direct) return direct[0];
  const m = handle.match(/^([\w.-]+(?:\/[\w.-]+)?)#(\d+)$/);
  if (m) {
    const [, repo, n] = m;
    const key = repo.toLowerCase();
    const hit = entries.find(([, e]) => e.pr === Number(n) && (e.repo === key || shortRepo(e.repo) === key));
    if (hit) return hit[0];
    throw new Error(`no entry for ${handle}`);
  }
  const prdId = basename(handle).replace(/\.md$/, "");
  const byPrd = entries.filter(([id]) => id.endsWith(`/${prdId}`));
  if (byPrd.length === 1) return byPrd[0][0];
  if (byPrd.length > 1) throw new Error(`"${handle}" matches ${byPrd.map(([id]) => id).join(", ")}; use the full id`);
  throw new Error(`no entry for ${handle}`);
}

/**
 * The event cursor, in one place, so every writer obeys the same rule.
 *
 * `since` is the boundary and `dispatched` the keys already handled *at* that boundary. GitHub timestamps have
 * one-second precision, so the comparison in `deriveEvents` is inclusive of `since` and `dispatched` is the only
 * thing that keeps an event from being sent twice. The two therefore move together: any move to a different
 * instant clears the list, and a move that stays inside the same second keeps it and adds to it. Everything else
 * about the cursor (`fixed_sha`, `checks_sha`, `receipt_hash`) is carried through untouched.
 *
 * The cursor never goes backwards, and that is enforced here rather than asked of each caller. Three callers pass a
 * candidate boundary from a different source: the newest event dispatched, the head commit's committer date, and a
 * local clock reading. Only the first was guarded. A committer date older than the cursor (a force-push to an
 * earlier commit, a push of a commit made days ago) or a clock a second behind GitHub's would move `since` back,
 * and `advanceCursor` would then clear `dispatched` because the instant changed, so the event that started the
 * round became new again and was dispatched a second time in the same pass, with a round burned for it. A candidate
 * before the cursor leaves both fields alone: nothing new was read, so nothing is newly handled.
 */
export function advanceCursor(cursor = {}, candidate, keys = []) {
  const since = later(candidate, cursor.since);
  // A candidate strictly before the cursor is refused outright: the boundary does not move and the keys are not
  // recorded either, because nothing was newly read to record. Only a candidate at the cursor's own instant unions
  // into `dispatched`; one past it replaces the list, since a different second has nothing to remember.
  if (candidate && cursor.since && Date.parse(candidate) < Date.parse(cursor.since)) return { ...cursor, since };
  const same = cursor.since && since && Date.parse(cursor.since) === Date.parse(since);
  const dispatched = same ? [...new Set([...(cursor.dispatched || []), ...keys])] : [...new Set(keys)];
  return { ...cursor, since, dispatched };
}

/**
 * A fresh entry, so every field exists and `status` never has to guess.
 * cursor.since: events at or after this time are new. cursor.dispatched: the event keys already dispatched at
 * exactly `since`, which is what makes the inclusive comparison safe. cursor.fixed_sha: the head the loop last acted
 * on, so a change in it is a push nobody told the loop about. It is the head when the last run started, which is how
 * a run that pushed is recognised, and the head an entry was judged ready on, which is how a push after that is.
 * cursor.checks_sha: the head whose failing checks were already dispatched. cursor.receipt_hash: the completion
 * receipt when the last run started. last.run: the run this entry dispatched; the tick settles that run and no other.
 */
export function newEntry({ prd, harness, session = null, repo, branch, worktree, pr = null, url = null, state, nowIso }) {
  return {
    prd, harness, session, repo: repo.toLowerCase(), branch, worktree, pr, url, state,
    iteration: 0,
    cursor: { since: nowIso, dispatched: [], fixed_sha: null, checks_sha: null, receipt_hash: null },
    rereview: { at: null, nudged: false },
    reason: null,
    last: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
