// Uses the same adapter and durable runner as implementation. There is no model
// client here. A lost launch acknowledgement is reconciled, never blindly retried.
import { join } from "node:path";
import { buildRun, adapterFor } from "./harness.mjs";
import { requireHarness } from "./probe.mjs";
import { preparationEnvironment } from "./task_environment.mjs";
import { ensureDir } from "./fs.mjs";
import { taskRoot, taskError } from "./task_store.mjs";
import { draftPrompt, MAX_TURNS } from "./task_contract.mjs";

export async function prepareTurn(ctx, task, store, failures) {
  const adapter = adapterFor(task.harness);
  const runner = ctx.runnerFor(`intake/${task.id}`);
  let attempt = task.attempts.at(-1);
  // A crash after recording output but before rendering its draft must replay
  // those bytes, not purchase another planning turn.
  if (attempt?.settled && !attempt.consumed) {
    if (!attempt.ok) throw taskError("TASK_PREPARATION_FAILED", attempt.error || "saved preparation failed; inspect its log");
    return attempt.message;
  }
  if (!attempt || attempt.settled) {
    if (task.attempts.length >= MAX_TURNS) throw taskError("TASK_ALLOWANCE", `preparation stopped after ${MAX_TURNS} turns; inspect the unresolved requirements`);
    const usedMs = task.attempts.reduce((n, a) => n + (a.elapsedMs || 0), 0);
    const remainingMs = task.allowance.runtimeMs - usedMs;
    const knownCost = task.attempts.reduce((n, a) => n + (a.cost ?? 0), 0);
    if (remainingMs <= 0 || knownCost >= task.allowance.budgetUsd) throw taskError("TASK_ALLOWANCE", "preparation allowance exhausted; inspect the saved evidence before granting further work");
    await requireHarness(task.harness, ctx.config);
    const cwd = ensureDir(join(taskRoot(ctx.home, task.id), "preparation", `turn-${task.attempts.length + 1}`));
    const config = { ...ctx.config, max_budget_usd: task.allowance.budgetUsd - knownCost };
    // Selected documents are already in the prompt. Global implementation read
    // grants do not belong to preparation, even when the operator configured them.
    const spec = buildRun({ harness: task.harness, config, mode: "start", session: adapter.newSession(), prompt: draftPrompt(task, failures), cwd });
    // Older version-1 records did not save the invocation directory. Their
    // checkout is the durable fallback, never the directory of a later resume.
    task.callerCwd ??= task.checkout;
    const env = preparationEnvironment(task.harness, cwd, spec.env, ctx.env, task.callerCwd);
    attempt = { name: `prepare-${task.attempts.length + 1}`, startedAt: Date.now(), deadline: Date.now() + remainingMs, cwd, run: null, settled: false, cost: null, usage: null };
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
  while (current.running) {
    if (Date.now() >= attempt.deadline) {
      runner.kill(attempt.run);
      await runner.waitForKill?.(attempt.run);
      attempt.settled = true;
      attempt.ok = false;
      attempt.elapsedMs = Math.max(0, Date.now() - attempt.startedAt);
      attempt.error = "preparation runtime allowance exhausted";
      store.save(task);
      throw taskError("TASK_ALLOWANCE", attempt.error);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    current = runner.current();
    if (!current || current.id !== attempt.run) throw taskError("TASK_PREPARATION_UNKNOWN", "preparation run ownership changed; inspect saved run artifacts");
  }
  const lines = runner.lines(attempt.run);
  const outcome = adapter.outcome(lines);
  const job = runner.settle(attempt.run, () => outcome.ok ? 0 : 1);
  attempt.settled = true;
  attempt.elapsedMs = Math.max(0, (job.endedAt || Date.now()) - attempt.startedAt);
  attempt.session = adapter.sessionFrom(lines);
  attempt.cost = outcome.cost;
  attempt.usage = lines.flatMap(line => { try { const event = JSON.parse(line); return event.usage ? [event.usage] : []; } catch { return []; } });
  attempt.log = join(runner.dirOf(attempt.run), "job.log");
  attempt.error = outcome.error || null;
  attempt.message = outcome.lastMessage;
  attempt.ok = job.exit === 0 && outcome.ok && !outcome.denials?.length;
  store.save(task);
  if (!attempt.ok) throw taskError("TASK_PREPARATION_FAILED", `preparation failed: ${outcome.error || outcome.denials?.map(d => d.reason || d.tool).join("; ") || `exit ${job.exit}`}; inspect ${attempt.log}`);
  return outcome.lastMessage;
}
