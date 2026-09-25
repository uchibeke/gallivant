// The registry: one entry per PRD or registered PR, keyed by `<owner>/<repo>/<prd id>`.
//
// The file is a cache with cursors. Identity (which PR, which session) can be rebuilt from GitHub; counters and
// cursors can be rebuilt by counting the daemon's own comments. Every write is atomic and every read-modify-write
// holds a lock file, so the CLI and the daemon cannot lose each other's updates.
import { join, basename } from "node:path";
import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { readJson, writeJsonAtomic, gallivantHome } from "./fs.mjs";

export const STATES = Object.freeze({
  running: "running",           // start run in progress, no PR yet
  prOpen: "pr-open",            // watched
  ready: "ready-for-human",     // watched, waiting for a person to merge
  needsHuman: "needs-human",    // stopped with a reason
  done: "done",                 // merged or closed
});

export const statePath = (home = gallivantHome()) => join(home, "state.json");

export const shortRepo = nameWithOwner => nameWithOwner.split("/")[1];

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
 * A fresh entry, so every field exists and `status` never has to guess.
 * cursor.since: events after this time are new. cursor.fixed_sha: the head when the last run started, so a run
 * that pushed is recognised by the head moving. cursor.checks_sha: the head whose failing checks were already
 * dispatched. cursor.receipt_hash: the completion receipt when the last run started. last.run: the run this entry
 * dispatched; the tick settles that run and no other.
 */
export function newEntry({ prd, harness, session = null, repo, branch, worktree, pr = null, url = null, state, nowIso }) {
  return {
    prd, harness, session, repo: repo.toLowerCase(), branch, worktree, pr, url, state,
    iteration: 0,
    cursor: { since: nowIso, fixed_sha: null, checks_sha: null, receipt_hash: null },
    rereview: { at: null, nudged: false },
    reason: null,
    last: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
