// SSE and history share the bounded public projection reader. Only the
// coordinator reconciles providers; these routes read files and clean up on close.
import { readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { logWindow, LOG_LIMITS } from "../run_log.mjs";
export const TAIL = LOG_LIMITS.lines;
const jobOf = dir => { try { return JSON.parse(readFileSync(join(dir, "job.json"), "utf8")); } catch { return null; } };
export function sliceRun(dir, { end = null, count = TAIL, meter } = {}) {
  const tail = end === null ? logWindow(dir, { meter }) : null;
  return logWindow(dir, { before: end === null ? tail.from : end, count, meter });
}
export function streamRun(res, dir, { isRunning, req = res.req, pollMs = 1000, beatMs = 20_000, meter } = {}) {
  res.setTimeout?.(0);
  req?.setTimeout?.(0); req?.socket?.setTimeout?.(0);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
  if (!jobOf(dir)) { res.write(`data: ${JSON.stringify("[no run]")}\n\n`); return res.end(); }
  const initial = logWindow(dir, { meter });
  const resume = Number(req?.headers?.["last-event-id"]);
  const resuming = Number.isSafeInteger(resume) && resume >= 0;
  let sent = resuming ? resume : Math.max(0, initial.from - 1);
  let generation = initial.generation, blocked = false, closing = false, pending = [], buffered = 0;
  let watcher, timer, beat;
  const stop = () => {
    closing = true; clearInterval(timer); clearInterval(beat); watcher?.close();
    res.off?.("drain", drain); res.off?.("close", stop); res.off?.("error", stop);
    pending = []; buffered = 0;
  };
  const write = frame => {
    if (blocked) return false;
    if (res.write(frame) === false) blocked = true;
    return true;
  };
  const enqueue = frame => { pending.push(frame); buffered += Buffer.byteLength(frame); };
  if (!resuming && sent > 0) enqueue(`event: skipped\ndata: ${sent}\n\n`);
  if (initial.gap) enqueue(`event: gap\ndata: ${JSON.stringify(initial.gap)}\n\n`);
  const drain = () => { if (closing) return; blocked = false; tick(); };
  const flush = () => {
    while (pending.length && !blocked) {
      const frame = pending.shift(); buffered -= Buffer.byteLength(frame);
      write(frame);
    }
  };
  const tick = () => {
    if (closing || blocked) return;
    flush(); if (blocked) return;
    const window = logWindow(dir, { after: sent, meter });
    if (generation !== window.generation || (sent > window.total && !window.byteMode)) {
      // Never renumber IDs after retention or rotate a reconnect to a new file.
      write(`event: gap\ndata: ${JSON.stringify("log rotated; history unavailable after the recorded cursor")}\n\n`);
      stop(); res.end(); return;
    }
    generation = window.generation;
    if (window.gap && window.from > sent + 1) enqueue(`event: gap\ndata: ${JSON.stringify(window.gap)}\n\n`);
    for (let i = 0; i < window.lines.length; i++) {
      const frame = `id: ${window.ids[i]}\ndata: ${JSON.stringify(window.lines[i])}\n\n`;
      if (buffered + Buffer.byteLength(frame) > LOG_LIMITS.bufferedBytes) break;
      enqueue(frame); sent = window.ids[i];
    }
    flush();
    if (blocked || pending.length || sent < window.total && window.lines.length) return;
    const job = jobOf(dir);
    if (!isRunning(job)) {
      const message = job?.exit == null ? "[ended, waiting for the next tick to record the exit]" : `[exit ${job.exit}]`;
      write(`data: ${JSON.stringify(message)}\n\n`);
      if (!blocked) { stop(); res.end(); }
    }
  };
  res.on("close", stop); res.on?.("error", stop); res.on?.("drain", drain);
  timer = setInterval(tick, pollMs);
  beat = setInterval(() => { if (!closing && !blocked && !pending.length) write(": keepalive\n\n"); }, beatMs);
  try { watcher = watch(join(dir, "job.log"), { persistent: false }, tick); } catch { /* timer is the recovery path */ }
  tick();
  return { close: stop, bufferedBytes: () => buffered, blocked: () => blocked };
}
