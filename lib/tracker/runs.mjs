// Every run on disk, newest first. The history is already there: `~/.gallivant/runs/<entry slug>/<run id>/` holds
// job.json and job.log for each dispatch the daemon ever made, and nothing deletes them. This module is the index
// over that tree, plus the id validation every route goes through before it touches a path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { idSlug } from "../state.mjs";

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

const readJob = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };
const ls = dir => { try { return readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return []; } };

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
      const running = job.exit === null && isRunning(job);
      rows.push({
        entry: id, handle: handleOf(id, e), run: job.id || runId, name: job.name || "",
        // The harness is the entry's, not the run's: job.json records the binary it spawned, and the registry is
        // what says which adapter that was. A grouping by harness needs the name, not the path.
        harness: e?.harness || "unknown",
        startedAt: job.startedAt ?? null, endedAt: job.endedAt ?? null,
        // A killed or crashed run whose exit was never recorded is not a success; it is simply unknown until the
        // tick settles it, and saying so beats printing "0".
        exit: running ? null : job.exit ?? null, running,
        // A run still going has no duration yet; one whose end was never recorded has none either, and a made-up
        // number would read as fact.
        durationMs: job.startedAt && job.endedAt ? job.endedAt - job.startedAt : null,
      });
    }
  }
  // Run ids start with an ISO stamp, so a string sort is a time sort, and it works for runs whose job.json lost
  // its startedAt. Ties fall back to the stamp inside the id.
  rows.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.run.localeCompare(a.run));
  return rows.slice(0, limit);
}

const handleOf = (id, e) => (e?.pr ? `${e.repo?.split("/")[1] || e.repo}#${e.pr}` : id);
