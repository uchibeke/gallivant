// Local operator requests. UI and CLI enqueue; the daemon is the only consumer.
// One outstanding request per entry avoids competing resumes and needs no second runner.
import { randomUUID } from "node:crypto";
import { needsAgentResume } from "./network_recovery.mjs";
import { resolveHandle, STATES } from "./state.mjs";
import { readDaemon, assertDaemonUsable } from "./daemon.mjs";
import { nowIso } from "./time.mjs";
import { NEEDS_LABEL, READY_LABEL } from "./gh.mjs";
import { adapterFor } from "./harness.mjs";
import { executionRunner, unsubmittedInitialDispatch, PROVIDER_STATES } from "./execution.mjs";
import { requestRunCancellation } from "./run.mjs";
import { executionResultCheckpoint, acquirePublicationLock } from "./execution_result.mjs";
import { controlAvailability, controlPending } from "./control_contract.mjs";
export { controlAvailability, controlPending } from "./control_contract.mjs";

export const CONTROL_LABELS = { recheck: "Recheck PR", resume: "Resume agent", message: "Send message", cancel: "Cancel task" };
export const CONTROL_ACTIONS = Object.keys(CONTROL_LABELS);
export const MAX_NOTE = 4000; // resumePrompt's quote limit; never silently truncate a message.
export const lastMessage = entry => [entry.control, ...(entry.control_history || []).slice().reverse()].find(c => c?.action === "message" && c.note) ?? null;
export const cancellationStatus = answer => answer.confirmed
  ? { reason: "cancelled", message: "Cancellation confirmed." }
  : answer.terminal
    ? { reason: "cancelled", message: "Further dispatch stopped; provider execution had already completed." }
    : { reason: "cancellation-requested", message: "Further dispatch stopped; provider cancellation is unconfirmed. Remote execution may continue." };

// Never expose subprocess output (which can contain credentials) in the tracker.
export function controlFailure(error) {
  const text = error.message || "";
  if (error.code === "AGENT_RESUME_REQUIRED") return "The agent stopped with an execution error. Use Resume agent after fixing connectivity or credentials. Recheck PR cannot resume the agent or clear this failure.";
  if (error.code === "EXECUTION_OWNERSHIP") return "The saved request no longer owns the current run. Inspect its execution identity before submitting a new request.";
  if (error.code === "EXECUTION_RESULT_BLOCKED") return "Result publication is blocked. Inspect result-application.json, result.json and any verification.json, then explicitly resume the same session for correction; PR recheck cannot retry publication.";
  if (/PR is no longer open|closed or merged/.test(text)) return "The PR is closed or merged. Start a follow-up PRD for further changes.";
  if (/resnapshot|carried files differ|brief.*(changed|missing)|snapshot/i.test(text)) return "The brief or carried sources changed. Review gallivant why, then restore them or explicitly use gallivant resume --resnapshot to accept the changes.";
  if (/already has a run|still needs settling/.test(text)) return "The previous run has not settled yet. Wait for it to stop, then retry. Your message is saved below.";
  if (/no session/.test(text)) return "No resumable session or proven unsubmitted launch is available. Inspect execution ownership and the run log before retrying. Your message is saved below.";
  if (/older than/.test(text)) return "The configured harness is too old. Run gallivant doctor --probe, update that binary, then retry.";
  if (error.code === "NO_CREDENTIAL") return error.reason === "configured-token-file-unavailable"
    ? "The configured github_token_file is unavailable. Restore that private token file, or set github_token_file to null and restart the daemon before retrying."
    : "GitHub authentication is unavailable. Authenticate with gh auth login, then retry.";
  if (error.code === "NO_IDENTITY") return "Git has no commit identity. Configure your Git name and email, then retry.";
  return "Could not apply the request. Inspect gallivant why and the daemon log. Your last message is saved below for editing and resending.";
}

export function requestControl(ctx, { handle, action, note = "", interrupt = false, requestId = null }) {
  if (!CONTROL_ACTIONS.includes(action)) throw new Error("Unknown run action.");
  if (typeof note !== "string" || note.length > MAX_NOTE) throw new Error(`Messages must be at most ${MAX_NOTE} characters.`);
  if (action === "message" && !note.trim()) throw new Error("Write a message before sending it.");
  if (action !== "message" && note.trim()) throw new Error("Use Send message to deliver a message to the agent.");
  if (typeof interrupt !== "boolean" || (interrupt && action !== "message")) throw new Error("Interrupt is available only when sending a message.");
  const id = resolveHandle(ctx.state.entries(), handle);
  if (requestId !== null && (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId))) throw new Error("Invalid control request identity.");
  const saved = ctx.state.get(id);
  const previous = requestId && [saved?.control, ...(saved?.control_history || [])].find(c => c?.id === requestId);
  if (requestId && previous?.id === requestId) {
    if (previous.action !== action || previous.note !== note.trim() || previous.interrupt !== interrupt) throw new Error("Control identity belongs to different input.");
    return { entry: id, ...previous };
  }
  // UI and CLI must refuse before saving a request an old daemon cannot consume.
  assertDaemonUsable(ctx.coordinatorHealth ? ctx.coordinatorHealth() : readDaemon(ctx.home));
  const request = { id: requestId || randomUUID(), action, note: note.trim(), interrupt, status: "queued", at: nowIso(ctx.clock) };
  const runner = executionRunner(ctx, id);
  const exclusion = action === "cancel" ? acquirePublicationLock(ctx, id, { execution: runner }) : null;
  try { ctx.state.update(id, entry => {
    if (entry.state === STATES.done) throw new Error("This task is already closed or merged.");
    if (controlPending(entry.control)) throw new Error("A request is already queued or being applied. Wait for its result.");
    if (action === "recheck" && !entry.pr) throw new Error("This entry has no PR to recheck.");
    if (action === "recheck" && needsAgentResume(entry)) throw Object.assign(new Error(controlFailure({ code: "AGENT_RESUME_REQUIRED" })), { code: "AGENT_RESUME_REQUIRED" });
    const run = runner.current();
    const available = controlAvailability(entry, run, runner.capabilities, { resumable: Boolean(entry.session || unsubmittedInitialDispatch(entry, runner)) });
    if (["resume", "message"].includes(action) && entry.dispatch_stopped) throw new Error("Further dispatch is stopped; reconcile cancellation before authorizing another task.");
    if (action === "recheck" && executionResultCheckpoint(runner, run)?.phase === "blocked") throw Object.assign(new Error("Result publication needs an explicit corrective resume."), { code: "EXECUTION_RESULT_BLOCKED" });
    if (interrupt && runner.capabilities?.controls?.interrupt === false) throw new Error("This provider cannot safely interrupt; cancel stops further dispatch and requires remote confirmation.");
    if (interrupt && !available.interrupt) throw new Error("This task cannot currently be interrupted.");
    const active = run?.running && run.id === entry.last?.run;
    if (!["recheck", "cancel"].includes(action) && !entry.session && !active && !unsubmittedInitialDispatch(entry, runner)) throw new Error("This entry has no session to resume or proven unsubmitted launch. Inspect its execution ownership before retrying.");
    // A new fixed action must not erase a failed message. Keep a small local history.
    return { control: { ...request, ...(action === "resume" && run?.execution?.providerState === "status-unknown" ? { recoveryRun: run.id } : {}) }, ...(action === "cancel" ? { dispatch_stopped: "cancellation-requested" } : {}), control_history: [...(entry.control_history || []), ...(entry.control ? [entry.control] : [])].slice(-20) };
  }); } finally { exclusion?.release(); }
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
  const status = cancellationStatus(answer);
  ctx.state.update(id, { state: STATES.needsHuman, reason: status.reason, network_retry: null, control: { ...request, status: "applied", stop_run: run?.id ?? null, message: status.message, finished_at: nowIso(ctx.clock) } });
  return true;
}

// An explicit resume of an ambiguous remote launch means observing the owned
// input, not sending a second turn. Persist that meaning before recovery so a
// crash after adoption cannot turn the same request into a continuation.
export async function recoverControl(ctx, id) {
  const entry = ctx.state.get(id), request = entry?.control;
  if (request?.status !== "queued" || request.action !== "resume" || entry.dispatch_stopped) return false;
  try {
    const runner = executionRunner(ctx, id), run = runner.current();
    const canRecover = runner.recover && runner.capabilities?.transport === "remote" && run && run.id === entry.last?.run;
    if (request.recoveryRun && (!canRecover || request.recoveryRun !== run.id)) throw Object.assign(new Error("Recovery control no longer owns its saved run"), { code: "EXECUTION_OWNERSHIP" });
    if (!canRecover || !request.recoveryRun && run.execution?.providerState !== "status-unknown") return false;
    let retained = false;
    ctx.state.update(id, current => {
      if (current.control?.id !== request.id || current.control.status !== "queued") return {};
      if (current.dispatch_stopped || current.last?.run !== run.id) throw Object.assign(new Error("Recovery control no longer owns its saved run"), { code: "EXECUTION_OWNERSHIP" });
      retained = true;
      return { control: { ...current.control, recoveryRun: run.id } };
    });
    if (!retained) return true;
    const observed = await runner.recover({ authorized: true, operationId: `control-recovery:${request.id}` });
    const ex = observed?.execution;
    // Earlier input acceptance does not prove this observation recovered access.
    const recovered = ex?.acceptance === "accepted" && PROVIDER_STATES.includes(ex.providerState) && !["status-unknown", "cancellation-requested"].includes(ex.providerState);
    ctx.state.update(id, current => current.control?.id === request.id ? { control: { ...current.control, status: recovered ? "applied" : "failed", finished_at: nowIso(ctx.clock), message: recovered ? "Recovered observation of the existing provider input; no new input was sent." : "The bounded observation retry did not resolve the existing input. Inspect its saved evidence before retrying; no new input was sent." } } : {});
  } catch (error) {
    ctx.state.update(id, current => current.control?.id === request.id ? { control: { ...current.control, status: "failed", finished_at: nowIso(ctx.clock), message: controlFailure(error) } } : {});
  }
  return true;
}

export function interruptControl(ctx, id) {
  const entry = ctx.state.get(id), request = entry?.control;
  if (request?.status !== "queued" || !request.interrupt) return;
  const runner = executionRunner(ctx, id), run = runner.current();
  if (!run?.running || run.id !== entry.last?.run) return;
  if (request.stop_run && request.stop_run !== run.id) return;
  const session = entry.session || (runner.sessionFrom ? runner.sessionFrom(run.id) : adapterFor(entry.harness).sessionFrom(runner.lines(run.id)));
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
    let run = null, initialLaunch = false;
    if (request.action === "recheck") {
      if (needsAgentResume(entry)) throw Object.assign(new Error("The agent failure requires resume, not PR recheck."), { code: "AGENT_RESUME_REQUIRED" });
      if (executionResultCheckpoint(runner)?.phase === "blocked") throw Object.assign(new Error("Result publication needs an explicit corrective resume."), { code: "EXECUTION_RESULT_BLOCKED" });
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
      initialLaunch = result.initialLaunch === true;
      // A cosmetic label failure after spawning must not invite another resume.
      if (entry.pr) await ctx.gh.removeLabel(entry.repo, entry.pr, NEEDS_LABEL).catch(e => ctx.log.warn(`${id}: could not remove stopped label: ${e.message}`));
    }
    finish({ status: "applied", run, message: initialLaunch ? "Started the initial run after repairing launch prerequisites." : request.action === "message"
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
