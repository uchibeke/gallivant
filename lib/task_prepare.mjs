// Uses the same adapter and durable runner as implementation. There is no model
// client here. A lost launch acknowledgement is reconciled, never blindly retried.
import { join } from "node:path";
import { buildPreparationRun, capabilitiesFor, isPreparationReceipt, adapterFor } from "./harness.mjs";
import { prepareLocalExecution } from "./execution_preparation.mjs";
import { taskRoot, taskError } from "./task_store.mjs";
import { draftPrompt, MAX_TURNS, MAX_PREPARATION_PROMPT_BYTES } from "./task_contract.mjs";
import { executionRunner } from "./execution.mjs";
import { redact } from "./execution_io.mjs";

export const PREPARATION_PENDING = Symbol("preparation-pending");
export const preparationCancellationPending = task => {
  const attempt = task.attempts.at(-1);
  return !!attempt && ((attempt.cancellation && !["confirmed", "terminal"].includes(attempt.cancellation.status)) ||
    (attempt.execution?.transport === "remote" && attempt.execution.providerState === "cancellation-requested"));
};

const overDeadline = attempt => {
  const endedAt = attempt.endedAt ?? (Number.isFinite(attempt.elapsedMs) ? attempt.startedAt + attempt.elapsedMs : null);
  return Number.isFinite(endedAt) && endedAt > attempt.deadline;
};
const exhausted = (task, store, attempt) => {
  attempt.settled = true;
  attempt.ok = false;
  attempt.errorCode = "TASK_ALLOWANCE";
  attempt.error = "preparation runtime allowance exhausted";
  store.save(task);
  throw taskError(attempt.errorCode, attempt.error);
};
const failed = attempt => {
  const reason = attempt.error || "saved preparation failed";
  return taskError(attempt.errorCode || "TASK_PREPARATION_FAILED", attempt.errorCode ? reason : `preparation failed: ${reason}; inspect ${attempt.log || "the saved run log"}`);
};

const boundaryFailure = () => taskError("TASK_PREPARATION_BOUNDARY", "saved preparation used an unverified tool boundary; its output cannot authorize readiness or dispatch; use a hand-authored PRD with ready/start until an isolated preparation adapter is supported");
const safeAttempt = (task, attempt, capabilities, account) => isPreparationReceipt(task.harness, attempt.receipt ?? attempt.boundary, capabilities, account)
  && (!attempt.receipt?.taskId || attempt.receipt.taskId === `intake/${task.id}`);
export function assertPreparationBoundary(task, ctx = {}) {
  const capabilities = ctx.capabilitiesFor?.(task.harness) || capabilitiesFor(task.harness);
  const account = ctx.config?.harness[task.harness]?.account || "operator";
  if (task.attempts.some(a => a.ok && !safeAttempt(task, a, capabilities, account))) throw boundaryFailure();
}

// The builder injection is for offline runner fixtures, just like the service's
// existing prepare injection. Configuration cannot override the native boundary.
export async function prepareTurn(ctx, task, store, failures, build = buildPreparationRun) {
  const runner = executionRunner(ctx, `intake/${task.id}`, task.harness);
  const capabilities = runner.capabilities || ctx.capabilitiesFor?.(task.harness) || capabilitiesFor(task.harness);
  const account = runner.account || ctx.config.harness[task.harness]?.account || "operator";
  const remote = capabilities.transport === "remote";
  const adapter = remote ? null : adapterFor(task.harness);
  let attempt = task.attempts.at(-1);
  const stopping = preparationCancellationPending(task);
  // A crash after recording output but before rendering its draft must replay
  // those bytes, not purchase another planning turn.
  if (attempt?.settled && !attempt.consumed && !stopping) {
    if (overDeadline(attempt)) exhausted(task, store, attempt);
    if (!attempt.ok) throw failed(attempt);
    assertPreparationBoundary(task, ctx);
    return attempt.message;
  }
  if ((!attempt || attempt.settled) && !stopping) {
    if (task.attempts.length >= MAX_TURNS) throw taskError("TASK_ALLOWANCE", `preparation stopped after ${MAX_TURNS} turns; inspect the unresolved requirements`);
    const usedMs = task.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0);
    const remainingMs = task.allowance.runtimeMs - usedMs;
    const knownCost = task.attempts.reduce((n, a) => n + Math.max(a.cost ?? 0, a.reservedUsd ?? 0), 0);
    if (remainingMs <= 0 || knownCost >= task.allowance.budgetUsd) throw taskError("TASK_ALLOWANCE", "preparation allowance exhausted; inspect the saved evidence before granting further work");
    const cwd = join(taskRoot(ctx.home, task.id), "preparation", `turn-${task.attempts.length + 1}`);
    const config = { ...ctx.config, max_budget_usd: task.allowance.budgetUsd - knownCost };
    // Selected documents are already in the prompt. Global implementation read
    // grants do not belong to preparation, even when the operator configured them.
    // Older version-1 records did not save the invocation directory. Their
    // checkout is the durable fallback, never the directory of a later resume.
    task.callerCwd ??= task.checkout;
    const prompt = draftPrompt(task, failures);
    if (Buffer.byteLength(prompt) > MAX_PREPARATION_PROMPT_BYTES) throw taskError("TASK_INPUT", `serialized preparation prompt exceeds ${MAX_PREPARATION_PROMPT_BYTES} bytes; select fewer or smaller context files, or prepare a smaller task; saved requirements were retained`);
    const environment = remote ? capabilities.preparation?.environment : "isolated-checkout";
    const reservedUsd = remote ? Math.min(config.max_budget_usd, task.allowance.budgetUsd / MAX_TURNS) : null;
    const allowance = remote ? { remainingUsd: config.max_budget_usd, reservedUsd } : null;
    const input = { kind: "intake", environment, prompt, ...(remote ? { allowance } : { config, cwd, sourceEnv: ctx.env, callerCwd: task.callerCwd }) };
    const prepared = runner.prepare ? await runner.prepare(input, { build }) : await prepareLocalExecution(task.harness, capabilities, account, input, build);
    if (!isPreparationReceipt(task.harness, prepared.receipt, capabilities, account)) throw boundaryFailure();
    attempt = { name: `prepare-${task.attempts.length + 1}`, boundary: prepared.receipt.boundary, receipt: prepared.receipt, reservedUsd, startedAt: Date.now(), deadline: Date.now() + remainingMs, cwd, run: null, settled: false, cost: null, usage: null };
    task.attempts.push(attempt);
    task.status = "preparing";
    store.save(task); // Intent precedes spawn; unknown acceptance never authorizes a second call.
    const dispatch = { kind: "intake", preparation: prepared.receipt, operationId: attempt.name, name: attempt.name, environment };
    try {
      const job = runner.submit ? await runner.submit({ ...dispatch, ...(remote ? { prompt, prepared, allowance } : { spec: prepared.spec }) })
        : await runner.start(attempt.name, prepared.spec.cmd, prepared.spec.args, { ...prepared.spec.options, execution: dispatch });
      attempt.run = job.id;
    } catch (error) {
      const owned = runner.current();
      if (!remote || owned?.name !== attempt.name || owned.execution?.acceptance !== "unknown") throw error;
      attempt.run = owned.id; // Lost acknowledgement remains unresolved, never retried.
    }
    store.save(task);
  }
  let current = runner.current();
  if (remote) {
    await runner.reconcile(); // One bounded, persisted-cadence mutation; inspect/list never poll.
    current = runner.current();
  }
  if (!attempt.run) {
    if (!current || current.name !== attempt.name) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation launch acceptance is unknown; inspect the intake run directory before retrying; no new model call was made");
    attempt.run = current.id;
    store.save(task);
  }
  if (!current || current.id !== attempt.run) throw taskError("TASK_PREPARATION_UNKNOWN", "recorded preparation run is missing or has changed; inspect its artifacts; no new model call was made");
  const unsafe = !safeAttempt(task, attempt, capabilities, account);
  if (remote) {
    attempt.execution = current.execution;
    const completed = ["succeeded", "failed"].includes(current.execution.terminalState) ||
      (current.execution.collected && ["succeeded", "failed"].includes(current.execution.providerState));
    if (stopping || unsafe || (!completed && Date.now() >= attempt.deadline)) {
      attempt.cancellation ??= { reason: current.execution.cancellation?.reason || (unsafe ? "unsafe-preparation" : "preparation-timeout"), requestedAt: Date.now(), status: "intent" };
      attempt.settled = false; task.status = "preparing"; task.readiness = null;
      store.save(task);
      // Once fenced, only the boundary's persisted cadence retries cancellation.
      // An intent whose fence was not saved may retry the same owned control.
      if (!runner.state().stopped) {
        try { await runner.cancel(attempt.cancellation.reason); }
        catch (error) { attempt.recoveryAction = runner.sanitize ? runner.sanitize(error.message, attempt.run) : redact(error.message); }
      }
      current = runner.current();
      if (!current || current.id !== attempt.run) throw taskError("TASK_PREPARATION_UNKNOWN", "cancellation ownership changed; restore the recorded intake run before reconciliation");
      attempt.execution = current.execution;
      attempt.cancellation.status = "pending";
      if (current.running) {
        attempt.recoveryAction = current.execution.recoveryAction || "resume owned preparation cancellation; no new turn is authorized";
        task.failures = [attempt.recoveryAction]; store.save(task); return PREPARATION_PENDING;
      }
      attempt.cancellation.status = current.execution.providerState === "cancelled" ? "confirmed" : "terminal";
      attempt.cancellation.confirmedAt = Date.now(); attempt.recoveryAction = null;
      attempt.endedAt = current.endedAt ?? Date.now(); attempt.elapsedMs = Math.max(0, attempt.endedAt - attempt.startedAt);
      attempt.cost = current.execution.costUsd ?? null;
      store.save(task);
      if (attempt.cancellation.reason === "unsafe-preparation") { attempt.settled = true; store.save(task); throw boundaryFailure(); }
      exhausted(task, store, attempt);
    }
    if (current.execution.providerState === "retrieving-results" || completed) {
      try { await runner.collect(); } catch (error) {
        if (error.code !== "EXECUTION_RESULT" && error.code !== "EXECUTION_DEADLINE") throw error;
        attempt.recoveryAction = error.message;
        attempt.execution = runner.current().execution; store.save(task); return PREPARATION_PENDING;
      }
      current = runner.current();
    }
    attempt.execution = current.execution;
    store.save(task);
    if (current.running) return PREPARATION_PENDING; // Authoritative completion/results are still pending.
    if (current.execution.quarantined || current.execution.providerState === "cancelled") throw taskError("TASK_PREPARATION_FAILED", "preparation cancelled; late output cannot authorize readiness");
  }
  if (unsafe && current.running) {
    runner.kill(attempt.run);
    await runner.waitForKill?.(attempt.run);
    current = runner.current();
    if (!current || current.id !== attempt.run || current.running) throw taskError("TASK_PREPARATION_UNKNOWN", "unsafe preparation could not be stopped; inspect the owned run before any further work");
  }
  while (current.running) {
    if (Date.now() >= attempt.deadline) {
      runner.kill(attempt.run);
      await runner.waitForKill?.(attempt.run);
      attempt.endedAt = Date.now();
      attempt.elapsedMs = Math.max(0, attempt.endedAt - attempt.startedAt);
      exhausted(task, store, attempt);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    current = runner.current();
    if (!current || current.id !== attempt.run) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation run ownership changed; inspect saved run artifacts");
  }
  const lines = remote ? [] : runner.lines(attempt.run);
  let outcome = remote ? runner.outcome(attempt.run) : adapter.outcome(lines);
  const job = remote ? current : runner.settle(attempt.run, () => outcome.ok ? 0 : 1);
  if (!job || job.id !== attempt.run || job.running) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation completion ownership changed; inspect its saved run; no output was accepted");
  outcome = runner.outcome?.(attempt.run) || outcome; // Reuse the boundary's redacted result.
  attempt.settled = true;
  // A detached child may finish while the coordinator is gone. Use the recorded
  // completion time; if unavailable, settlement time is a conservative bound.
  attempt.endedAt = Number.isFinite(job.endedAt) ? job.endedAt : Date.now();
  attempt.completionInferred = job.completionInferred === true || job.inferred === true || !Number.isFinite(job.endedAt);
  attempt.elapsedMs = Math.max(0, attempt.endedAt - attempt.startedAt);
  attempt.session = remote ? current.execution.sessionId : adapter.sessionFrom(lines);
  attempt.cost = outcome.cost;
  const usage = remote ? runner.result(attempt.run)?.usage ?? null : lines.flatMap(line => { try { const event = JSON.parse(line); return event.usage ? [event.usage] : []; } catch { return []; } });
  attempt.usage = runner.sanitize ? runner.sanitize(usage, attempt.run) : redact(usage);
  attempt.log = join(runner.dirOf(attempt.run), "job.log");
  attempt.message = outcome.lastMessage;
  attempt.ok = job.exit === 0 && outcome.ok && !outcome.denials?.length;
  // Adapter denials are already display strings, including any recorded
  // guardrail reason. Persist them before blocking so settled replay says the
  // same thing as the original failure, even when the process exited zero.
  attempt.error = [outcome.error, ...(outcome.denials || [])].filter(Boolean).join("; ") || (attempt.ok ? null : `exit ${job.exit}`);
  // Preserve usage/log evidence even when a completed/recovered run ran late.
  // Such output cannot authorize readiness, implementation or another repair.
  if (overDeadline(attempt)) exhausted(task, store, attempt);
  if (unsafe && !outcome.denials?.length) {
    attempt.ok = false;
    attempt.errorCode = "TASK_PREPARATION_BOUNDARY";
    attempt.error = [attempt.error, boundaryFailure().message].filter(Boolean).join("; ");
  }
  store.save(task);
  if (!attempt.ok) throw failed(attempt);
  return outcome.lastMessage;
}
