// Local operator requests. UI and CLI enqueue; the daemon is the only consumer.
// One outstanding request per entry avoids competing resumes and needs no second runner.
import { randomUUID } from "node:crypto";
import { resolveHandle, STATES } from "./state.mjs";
import { readDaemon, assertDaemonUsable } from "./daemon.mjs";
import { nowIso } from "./time.mjs";
import { NEEDS_LABEL, READY_LABEL } from "./gh.mjs";
import { adapterFor } from "./harness.mjs";
import { executionRunner } from "./execution.mjs";
import { requestRunCancellation } from "./run.mjs";
import { executionResultCheckpoint } from "./execution_result.mjs";

export const CONTROL_LABELS = { recheck: "Recheck PR", resume: "Resume agent", message: "Send message", cancel: "Cancel task" };
export const CONTROL_ACTIONS = Object.keys(CONTROL_LABELS);
export const controlPending = c => c?.status === "queued" || c?.status === "applying";
export const MAX_NOTE = 4000; // resumePrompt's quote limit; never silently truncate a message.
export const lastMessage = entry => [entry.control, ...(entry.control_history || []).slice().reverse()].find(c => c?.action === "message" && c.note) ?? null;

// Never expose subprocess output (which can contain credentials) in the tracker.
export function controlFailure(error) {
  const text = error.message || "";
  if (error.code === "EXECUTION_RESULT_BLOCKED") return "Result publication is blocked. Inspect verification.json, then explicitly resume the same session for correction; PR recheck cannot retry verification.";
  if (/PR is no longer open|closed or merged/.test(text)) return "The PR is closed or merged. Start a follow-up PRD for further changes.";
  if (/resnapshot|carried files differ|brief.*(changed|missing)|snapshot/i.test(text)) return "The brief or carried sources changed. Review gallivant why, then restore them or explicitly use gallivant resume --resnapshot to accept the changes.";
  if (/already has a run|still needs settling/.test(text)) return "The previous run has not settled yet. Wait for it to stop, then retry. Your message is saved below.";
  if (/no session/.test(text)) return "The harness did not record a resumable session. Check its run log before starting again. Your message is saved below.";
  if (/older than/.test(text)) return "The configured harness is too old. Run gallivant doctor --probe, update that binary, then retry.";
  if (error.code === "NO_CREDENTIAL") return "GitHub authentication is unavailable. Authenticate with gh auth login, then retry.";
  if (error.code === "NO_IDENTITY") return "Git has no commit identity. Configure your Git name and email, then retry.";
  return "Could not apply the request. Inspect gallivant why and the daemon log. Your last message is saved below for editing and resending.";
}

export function requestControl(ctx, { handle, action, note = "", interrupt = false }) {
  if (!CONTROL_ACTIONS.includes(action)) throw new Error("Unknown run action.");
  if (typeof note !== "string" || note.length > MAX_NOTE) throw new Error(`Messages must be at most ${MAX_NOTE} characters.`);
  if (action === "message" && !note.trim()) throw new Error("Write a message before sending it.");
  if (action !== "message" && note.trim()) throw new Error("Use Send message to deliver a message to the agent.");
  if (typeof interrupt !== "boolean" || (interrupt && action !== "message")) throw new Error("Interrupt is available only when sending a message.");
  const id = resolveHandle(ctx.state.entries(), handle);
  // UI and CLI must refuse before saving a request an old daemon cannot consume.
  assertDaemonUsable(readDaemon(ctx.home));
  const request = { id: randomUUID(), action, note: note.trim(), interrupt, status: "queued", at: nowIso(ctx.clock) };
  ctx.state.update(id, entry => {
    if (entry.state === STATES.done) throw new Error("This task is already closed or merged.");
    if (controlPending(entry.control)) throw new Error("A request is already queued or being applied. Wait for its result.");
    if (action === "recheck" && !entry.pr) throw new Error("This entry has no PR to recheck.");
    const runner = executionRunner(ctx, id), run = runner.current();
    if (action === "recheck" && executionResultCheckpoint(runner, run)?.phase === "blocked") throw Object.assign(new Error("Result verification needs an explicit corrective resume."), { code: "EXECUTION_RESULT_BLOCKED" });
    if (interrupt && runner.capabilities?.controls?.interrupt === false) throw new Error("This provider cannot safely interrupt; cancel stops further dispatch and requires remote confirmation.");
    const active = run?.running && run.id === entry.last?.run;
    if (!["recheck", "cancel"].includes(action) && !entry.session && !active) throw new Error("This entry has no session to resume. Use gallivant start.");
    // A new fixed action must not erase a failed message. Keep a small local history.
    return { control: request, ...(action === "cancel" ? { dispatch_stopped: "cancellation-requested" } : {}), control_history: [...(entry.control_history || []), ...(entry.control ? [entry.control] : [])].slice(-20) };
  });
  ctx.log.info(`${id}: operator ${action} queued (${request.id})`);
  return { entry: id, ...request };
}

/** Optional stop-and-resume steering, using the existing runner and session parser. */
export async function cancelControl(ctx, id) {
  const entry = ctx.state.get(id), request = entry?.control;
  if (request?.status !== "queued" || request.action !== "cancel") return false;
  const runner = executionRunner(ctx, id), run = runner.current();
  let answer = { confirmed: false };
  try { answer = runner.cancel ? await runner.cancel() : run?.running ? requestRunCancellation(runner, run.id) : { confirmed: true }; }
  catch (error) {
    if (/already running|lock recovery/.test(error.message)) {
      ctx.state.update(id, { control: { ...request, message: "Cancellation is queued behind provider reconciliation; further dispatch is stopped." } });
      return true;
    }
    ctx.log.warn(`${id}: cancellation requested, confirmation unavailable (${error.code || "control failed"})`);
  }
  ctx.state.update(id, { state: STATES.needsHuman, reason: answer.confirmed ? "cancelled" : "cancellation-requested", control: { ...request, status: "applied", message: answer.confirmed ? "Cancellation confirmed." : "Further dispatch stopped; provider cancellation is unconfirmed. Remote execution may continue.", finished_at: nowIso(ctx.clock) } });
  return true;
}

export function interruptControl(ctx, id) {
  const entry = ctx.state.get(id), request = entry?.control;
  if (request?.status !== "queued" || !request.interrupt) return;
  const runner = executionRunner(ctx, id), run = runner.current();
  if (!run?.running || run.id !== entry.last?.run) return;
  if (request.stop_run && request.stop_run !== run.id) return;
  const session = entry.session || adapterFor(entry.harness).sessionFrom(runner.lines(run.id));
  if (!session) return; // Never stop a first turn before it gives us a resumable identity.
  ctx.state.update(id, { session, control: { ...request, stop_run: run.id, message: "Stopping the active run; your files will be preserved before the same session resumes." } });
  try { runner.kill(run.id); }
  catch (error) {
    ctx.log.warn(`${id}: interrupt failed: ${error.message}`);
    ctx.state.update(id, { state: STATES.needsHuman, reason: "run-stop-unverified", control: {
      ...request, status: "failed", finished_at: nowIso(ctx.clock),
      message: "Could not safely stop the previous run. Inspect its process group using gallivant why and the daemon log before retrying. Your message is saved below; no replacement was started.",
    } });
    return true; // The daemon completes the central needs-human labels/notification transition.
  }
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
  const runner = executionRunner(ctx, id);
  if (runner.current()?.running) return false;
  ctx.state.update(id, { control: { ...request, status: "applying" } });
  try {
    if (entry.state === STATES.done) throw new Error("The task was closed or merged before this request ran.");
    if (entry.pr) {
      const pr = await ctx.gh.prView(entry.repo, entry.pr);
      if (pr.state !== "OPEN") throw new Error("The PR is no longer open.");
    }
    let run = null;
    if (request.action === "recheck") {
      if (executionResultCheckpoint(runner)?.phase === "blocked") throw Object.assign(new Error("Result verification needs an explicit corrective resume."), { code: "EXECUTION_RESULT_BLOCKED" });
      await ctx.gh.removeLabel(entry.repo, entry.pr, READY_LABEL);
      await ctx.gh.removeLabel(entry.repo, entry.pr, NEEDS_LABEL);
      ctx.state.update(id, {
        state: STATES.prOpen, reason: null, retry: null, labels_pending: false, public_fix: null,
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
    finish({ status: "failed", message: controlFailure(e) });
  }
  return true;
}
