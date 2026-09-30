// Local operator requests. UI and CLI enqueue; the daemon is the only consumer.
// One outstanding request per entry avoids competing resumes and needs no second runner.
import { randomUUID } from "node:crypto";
import { resolveHandle, STATES } from "./state.mjs";
import { nowIso } from "./time.mjs";
import { NEEDS_LABEL, READY_LABEL } from "./gh.mjs";

export const CONTROL_LABELS = { recheck: "Recheck PR", resume: "Resume agent", message: "Send message" };
export const CONTROL_ACTIONS = Object.keys(CONTROL_LABELS);
export const controlPending = c => c?.status === "queued" || c?.status === "applying";
export const MAX_NOTE = 4000; // resumePrompt's quote limit; never silently truncate a message.

export function requestControl(ctx, { handle, action, note = "" }) {
  if (!CONTROL_ACTIONS.includes(action)) throw new Error("Unknown run action.");
  if (typeof note !== "string" || note.length > MAX_NOTE) throw new Error(`Messages must be at most ${MAX_NOTE} characters.`);
  if (action === "message" && !note.trim()) throw new Error("Write a message before sending it.");
  if (action !== "message" && note.trim()) throw new Error("Use Send message to deliver a message to the agent.");
  const id = resolveHandle(ctx.state.entries(), handle);
  const request = { id: randomUUID(), action, note: note.trim(), status: "queued", at: nowIso(ctx.clock) };
  ctx.state.update(id, entry => {
    if (entry.state === STATES.done) throw new Error("This task is already closed or merged.");
    if (controlPending(entry.control)) throw new Error("A request is already queued or being applied. Wait for its result.");
    if (action === "recheck" && !entry.pr) throw new Error("This entry has no PR to recheck.");
    if (action !== "recheck" && !entry.session) throw new Error("This entry has no session to resume. Use gallivant start.");
    return { control: request };
  });
  ctx.log.info(`${id}: operator ${action} queued (${request.id})`);
  return { entry: id, ...request };
}

/** Run only after the previous harness process has settled. */
export async function applyControl(ctx, id) {
  const entry = ctx.state.get(id);
  const request = entry?.control;
  if (!controlPending(request)) return false;
  const finish = patch => ctx.state.update(id, current => current.control?.id === request.id
    ? { control: { ...request, ...patch, finished_at: nowIso(ctx.clock) } } : {});
  // A crash after spawning is indistinguishable from one just before it. Never auto-replay it.
  if (request.status === "applying") {
    finish({ status: "failed", message: "Request interrupted. Check the latest run before trying again." });
    return true;
  }
  if (ctx.runnerFor(id).current()?.running) return false;
  ctx.state.update(id, { control: { ...request, status: "applying" } });
  try {
    if (entry.state === STATES.done) throw new Error("The task was closed or merged before this request ran.");
    if (entry.pr) {
      const pr = await ctx.gh.prView(entry.repo, entry.pr);
      if (pr.state !== "OPEN") throw new Error("The PR is no longer open.");
    }
    let run = null;
    if (request.action === "recheck") {
      await ctx.gh.removeLabel(entry.repo, entry.pr, READY_LABEL);
      await ctx.gh.removeLabel(entry.repo, entry.pr, NEEDS_LABEL);
      ctx.state.update(id, {
        state: STATES.prOpen, reason: null, retry: null, labels_pending: false,
        last: { ...entry.last, event: "operator requested PR recheck" }, updated_at: nowIso(ctx.clock),
      });
      // Preserve budgets, dispatch markers and the brief. Only the normal tick judges readiness.
    } else {
      const { resume } = await import("./commands/resume.mjs");
      const result = await resume(ctx, { handle: id, note: request.note || null });
      run = result.run;
      // A cosmetic label failure after spawning must not invite another resume.
      if (entry.pr) await ctx.gh.removeLabel(entry.repo, entry.pr, NEEDS_LABEL).catch(e => ctx.log.warn(`${id}: could not remove stopped label: ${e.message}`));
    }
    finish({ status: "applied", run, message: request.action === "message"
      ? "Started the next run in the same session with your message."
      : run ? "Resumed the same agent session." : "Watching PR checks and review again." });
    return request.action !== "recheck"; // A recheck continues through normal judgement in this same tick.
  } catch (e) {
    ctx.log.warn(`${id}: operator ${request.action} failed: ${e.message}`);
    // Subprocess errors can carry credentials. Details stay in the local daemon log.
    finish({ status: "failed", message: "Request failed. Inspect gallivant why and the daemon log before retrying." });
  }
  return true;
}
