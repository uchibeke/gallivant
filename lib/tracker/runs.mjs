// Every run on disk, newest first. The history is already there: `~/.gallivant/runs/<entry slug>/<run id>/` holds
// job.json and job.log for each dispatch the daemon ever made, and nothing deletes them. This module is the index
// over that tree, plus the id validation every route goes through before it touches a path.
//
// Two shapes of tree, one reader. Gallivant nests runs under the entry that dispatched them, because one run per
// entry is its lock. Command-center keeps them flat in `<project>/.content-pipeline/runs/`, because a run there
// belongs to a project rather than to a row. The folder inside is identical either way (job.json, job.log, the same
// field names), which is what `lib/run.mjs` was adapted from, so `readJob` and the row shape are shared and only
// the walk differs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { idSlug, handleFor } from "../state.mjs";

/** Run ids are stamp-plus-slug, the same character class `run.mjs`'s `dirOf` enforces. Anything else is not an id. */
export const validRunId = id => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);

/**
 * Resolve `<entry id>/<run id>` to a directory, or null.
 *
 * Two separate checks, because the two ids have different shapes. A run id is validated by pattern. An entry id
 * contains slashes, so a pattern is the wrong tool: it is checked against the registry instead, and only the slug
 * of an id that is actually registered is ever joined to a path. A query string can therefore name no directory
 * that the registry does not already name, whatever it contains.
 */
export function runDir(home, entries, entryId, runId) {
  if (!validRunId(runId)) return null;
  if (!entries.some(([id]) => id === entryId)) return null;
  return join(home, "runs", idSlug(entryId), runId);
}

/**
 * Resolve `<source label>/<run id>` to a directory in one of the configured flat trees, or null.
 *
 * The same two-part rule as `runDir`, for a tree that has no registry: the run id is validated by pattern, and the
 * source is matched against the configured list rather than trusted, so only a directory the operator already named
 * in config is ever joined to a path. A query string cannot reach a tree nobody configured.
 */
export function sourceRunDir(sources = [], label, runId) {
  if (!validRunId(runId)) return null;
  const source = sources.find(s => s.label === label);
  return source ? join(source.dir, runId) : null;
}

const readJob = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };
const ls = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

/** One run folder as a row. The same shape whichever tree it came from, so one table renders both. */
const rowOf = (job, runId, { entry, handle, harness, running }) => ({
  entry, handle, run: job.id || runId, name: job.name || "", harness,
  startedAt: job.startedAt ?? null, endedAt: job.endedAt ?? null,
  // A killed or crashed run whose exit was never recorded is not a success; it is unknown until something settles
  // it, and saying so beats printing "0".
  exit: running ? null : job.exit ?? null, running,
  // A run still going has no duration yet; one whose end was never recorded has none either, and a made-up number
  // would read as fact.
  durationMs: job.startedAt && job.endedAt ? job.endedAt - job.startedAt : null,
});

/** Newest first. Run ids start with an ISO stamp, so the id is the tiebreak when startedAt is missing. */
const newestFirst = (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.run.localeCompare(a.run);

/**
 * A flat tree of run folders, as command-center writes under `<project>/.content-pipeline/runs/`. Same folder
 * contents, no entry to key them by, so the source's name stands in for one and the rows are read-only: there is no
 * registry here to validate an id against, so nothing addresses these by id and they are listed, not opened.
 */
export function listFlatRuns(dir, { source = "runs", isRunning = () => false, limit = 200 } = {}) {
  const rows = [];
  for (const runId of ls(dir)) {
    const job = readJob(join(dir, runId));
    if (!job) continue;
    const running = job.exit === null && isRunning(job);
    rows.push({ ...rowOf(job, runId, { entry: null, handle: job.name || runId, harness: source, running }), source });
  }
  return rows.sort(newestFirst).slice(0, limit);
}

/**
 * Every run, newest first, with the entry it belongs to. The registry is the list of entries, so a run folder left
 * behind by an entry that was removed is skipped rather than shown with no context: `runDir` would refuse to serve
 * it anyway, and a row nothing can open is worse than no row.
 *
 * `isRunning` is the runner's liveness check, so a run whose daemon died is listed as ended rather than as live.
 */
export function listRuns(home, entries, { isRunning = () => false, entry: only = null, limit = 200 } = {}) {
  const rows = [];
  for (const [id, e] of entries) {
    if (only && id !== only) continue;
    const root = join(home, "runs", idSlug(id));
    for (const runId of ls(root)) {
      const job = readJob(join(root, runId));
      if (!job) continue;
      // The harness is the entry's, not the run's: job.json records the binary it spawned, and the registry is what
      // says which adapter that was. A grouping by harness needs the name, not the path.
      rows.push(rowOf(job, runId, { entry: id, handle: handleOf(id, e), harness: e?.harness || "unknown", running: job.exit === null && isRunning(job) }));
    }
  }
  return rows.sort(newestFirst).slice(0, limit);
}

// The canonical handle, from state.mjs. An entry the index has no registry row for is `id` on its own.
const handleOf = (id, e) => (e ? handleFor(id, e) : id);
