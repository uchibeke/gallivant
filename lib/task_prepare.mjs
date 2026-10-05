// Uses the same adapter and durable runner as implementation. There is no model
// client here. A lost launch acknowledgement is reconciled, never blindly retried.
import { join } from "node:path";
import { buildPreparationRun, PREPARATION_BOUNDARY, adapterFor } from "./harness.mjs";
import { requireHarness } from "./probe.mjs";
import { preparationEnvironment } from "./task_environment.mjs";
import { ensureDir } from "./fs.mjs";
import { taskRoot, taskError } from "./task_store.mjs";
import { draftPrompt, MAX_TURNS, MAX_PREPARATION_PROMPT_BYTES } from "./task_contract.mjs";

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
export function assertPreparationBoundary(task) {
  if (task.attempts.some(a => a.ok && a.boundary !== PREPARATION_BOUNDARY)) throw boundaryFailure();
}

// The builder injection is for offline runner fixtures, just like the service's
// existing prepare injection. Configuration cannot override the native boundary.
export async function prepareTurn(ctx, task, store, failures, build = buildPreparationRun) {
  const adapter = adapterFor(task.harness);
  const runner = ctx.runnerFor(`intake/${task.id}`);
  let attempt = task.attempts.at(-1);
  // A crash after recording output but before rendering its draft must replay
  // those bytes, not purchase another planning turn.
  if (attempt?.settled && !attempt.consumed) {
    if (overDeadline(attempt)) exhausted(task, store, attempt);
    if (!attempt.ok) throw failed(attempt);
    assertPreparationBoundary(task);
    return attempt.message;
  }
  if (!attempt || attempt.settled) {
    if (task.attempts.length >= MAX_TURNS) throw taskError("TASK_ALLOWANCE", `preparation stopped after ${MAX_TURNS} turns; inspect the unresolved requirements`);
    const usedMs = task.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0);
    const remainingMs = task.allowance.runtimeMs - usedMs;
    const knownCost = task.attempts.reduce((n, a) => n + (a.cost ?? 0), 0);
    if (remainingMs <= 0 || knownCost >= task.allowance.budgetUsd) throw taskError("TASK_ALLOWANCE", "preparation allowance exhausted; inspect the saved evidence before granting further work");
    const cwd = join(taskRoot(ctx.home, task.id), "preparation", `turn-${task.attempts.length + 1}`);
    const config = { ...ctx.config, max_budget_usd: task.allowance.budgetUsd - knownCost };
    // Selected documents are already in the prompt. Global implementation read
    // grants do not belong to preparation, even when the operator configured them.
    const spec = build({ harness: task.harness, config, mode: "start", session: adapter.newSession(), prompt: draftPrompt(task, failures), cwd });
    // Measure the actual UTF-8 argv payload, including JSON escaping, previous
    // output, answers, repair failures and buildRun's runtime preamble. Never
    // truncate requirements or create a launch intent for an unspawnable prompt.
    if (Buffer.byteLength(spec.args.at(-1)) > MAX_PREPARATION_PROMPT_BYTES) throw taskError("TASK_INPUT", `serialized preparation prompt exceeds ${MAX_PREPARATION_PROMPT_BYTES} bytes; select fewer or smaller context files, or prepare a smaller task; saved requirements were retained`);
    await requireHarness(task.harness, ctx.config);
    ensureDir(cwd);
    // Older version-1 records did not save the invocation directory. Their
    // checkout is the durable fallback, never the directory of a later resume.
    task.callerCwd ??= task.checkout;
    const env = preparationEnvironment(task.harness, cwd, spec.env, ctx.env, task.callerCwd);
    attempt = { name: `prepare-${task.attempts.length + 1}`, boundary: spec.boundary, startedAt: Date.now(), deadline: Date.now() + remainingMs, cwd, run: null, settled: false, cost: null, usage: null };
    task.attempts.push(attempt);
    task.status = "preparing";
    store.save(task); // Intent precedes spawn; unknown acceptance never authorizes a second call.
    const job = await runner.start(attempt.name, spec.cmd, spec.args, { cwd, env, inheritEnv: false });
    attempt.run = job.id;
    store.save(task);
  }
  let current = runner.current();
  if (!attempt.run) {
    if (!current || current.name !== attempt.name) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation launch acceptance is unknown; inspect the intake run directory before retrying; no new model call was made");
    attempt.run = current.id;
    store.save(task);
  }
  if (!current || current.id !== attempt.run) throw taskError("TASK_PREPARATION_UNKNOWN", "recorded preparation run is missing or has changed; inspect its artifacts; no new model call was made");
  const unsafe = attempt.boundary !== PREPARATION_BOUNDARY;
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
  const lines = runner.lines(attempt.run);
  const outcome = adapter.outcome(lines);
  const job = runner.settle(attempt.run, () => outcome.ok ? 0 : 1);
  if (!job || job.id !== attempt.run || job.running) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation completion ownership changed; inspect its saved run; no output was accepted");
  attempt.settled = true;
  // A detached child may finish while the coordinator is gone. Use the recorded
  // completion time; if unavailable, settlement time is a conservative bound.
  attempt.endedAt = Number.isFinite(job.endedAt) ? job.endedAt : Date.now();
  attempt.completionInferred = job.inferred === true || !Number.isFinite(job.endedAt);
  attempt.elapsedMs = Math.max(0, attempt.endedAt - attempt.startedAt);
  attempt.session = adapter.sessionFrom(lines);
  attempt.cost = outcome.cost;
  attempt.usage = lines.flatMap(line => { try { const event = JSON.parse(line); return event.usage ? [event.usage] : []; } catch { return []; } });
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
