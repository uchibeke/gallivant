// The live log of a run, as server-sent events. Ported from command-center's lib/run.mjs `stream`, where every
// detail below was paid for by a bug that reached the browser as "the log does not update".
//
// Gallivant's runs are one level deeper than command-center's (a run root per registry entry, then a run folder
// inside it), so the caller hands us a directory rather than an id. Everything else is the same file layout:
// job.json for state, job.log for output, so the tail logic ports unchanged.
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";

// How many lines a fresh connection is given. Enough to see what a run is doing now without handing the browser
// thousands of events at once; a reconnect resumes exactly where it left off and is not affected by this.
export const TAIL = 400;

const linesOf = dir => { try { return readFileSync(join(dir, "job.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
const jobOf = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };

/**
 * Stream `dir`'s job.log to `res` as events. `isRunning` answers liveness from the operating system (run.mjs's
 * `isOurProcess`, through the runner), never from a variable this process set, which is what lets a browser attach
 * to a run started by a daemon that has since restarted.
 */
export function streamRun(res, dir, { isRunning, req = res.req, pollMs = 1000, beatMs = 20_000 } = {}) {
  // A log stream outlives any normal request: a fix round goes for half an hour. Node's requestTimeout (five
  // minutes by default) would cut it off, and the reader would see a pane that stalled for no visible reason.
  // Clearing it on this one response leaves every other route's deadline alone.
  res.setTimeout?.(0);
  if (req) { req.setTimeout?.(0); if (req.socket) req.socket.setTimeout?.(0); }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive",
    // Without this a proxy buffers the stream and the reader sees nothing until the run ends.
    "x-accel-buffering": "no" });
  const job = dir && jobOf(dir);
  if (!job) { res.write(`data: ${JSON.stringify("[no run]")}\n\n`); return res.end(); }
  // A reconnecting EventSource sends back the id of the last frame it saw, so resume there instead of replaying
  // the whole log. Without this a five-minute cut on an hour-long run restarted the pane from line 1 each time.
  //
  // On a fresh connection, send only the tail. A long run reaches thousands of lines, and delivering all of them
  // as individual events on open stalls the browser badly enough that it drops the connection and retries,
  // forever. The reader wants to see what is happening now. `skipped` tells the page what it is not showing.
  const total = linesOf(dir).length;
  const resume = Number(req?.headers?.["last-event-id"]);
  const resuming = Number.isInteger(resume) && resume >= 0;
  let sent = resuming ? resume : Math.max(0, total - TAIL);
  if (!resuming && sent > 0) res.write(`event: skipped\ndata: ${sent}\n\n`);
  // Ids are positions in the whole log, not in the tail, so a reconnect after a truncated replay resumes in the
  // right place rather than rewinding to the start of what this connection happened to show.
  const push = () => { const l = linesOf(dir); for (; sent < l.length; sent++) res.write(`id: ${sent + 1}\ndata: ${JSON.stringify(l[sent])}\n\n`); };
  push();
  // The terminal frame. A run whose process is gone but whose exit was never written ended while no daemon was
  // watching; command-center inferred the outcome and wrote it back, but here the tick is the only writer, so the
  // frame says the process ended and leaves the verdict to the tick rather than inventing one or printing "unknown".
  const end = () => {
    const exit = jobOf(dir)?.exit;
    res.write(`data: ${JSON.stringify(exit == null ? "[ended, waiting for the next tick to record the exit]" : `[exit ${exit}]`)}\n\n`);
    res.end();
  };
  if (!isRunning(jobOf(dir))) return end();
  // The harness writes straight to the log file, so follow the file rather than the child's pipes. That is what
  // lets a browser attached after a daemon restart still see the output of a run this process never spawned.
  //
  // Watching beats polling here: a run that prints a line every 200ms was being delivered in one-second clumps,
  // which reads as a frozen pane. fs.watch fires within milliseconds of the write. It is not reliable on every
  // platform and can miss an event under load, so a slow timer still runs underneath as the floor, and it is also
  // what notices that the process has exited.
  let closing = false;
  // Liveness is asked of the OS on every tick, not only at connect. That is what ends the stream for a run whose
  // process was killed: otherwise the pane waits on a file that will never grow.
  const tick = () => { if (closing) return; push(); if (!isRunning(jobOf(dir))) { closing = true; stop(); end(); } };
  let watcher = null;
  try { watcher = watch(join(dir, "job.log"), { persistent: false }, tick); } catch { /* fall back to the timer */ }
  const t = setInterval(tick, pollMs);
  // A quiet run writes nothing for minutes at a time, and a connection with no bytes on it is indistinguishable
  // from a dead one. This comment frame is ignored by the EventSource parser and keeps the path warm.
  const beat = setInterval(() => { if (!closing) res.write(": keepalive\n\n"); }, beatMs);
  const stop = () => { clearInterval(t); clearInterval(beat); watcher?.close(); };
  res.on("close", stop);
}
