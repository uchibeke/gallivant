// Versioned durable transport boundary. No transport implements a review loop.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { capabilitiesFor, executionRegistry, adapterFor, preparationReceipt, isPreparationReceipt } from "./harness.mjs";
import { prepareLocalExecution } from "./execution_preparation.mjs";
import { EXECUTION_LIMITS, boundedCall, nextAttempt, executionError, ownsProviderSession, assertTerminalOutcome, redact, redactResultMetadata } from "./execution_io.mjs";
import { journalFor } from "./execution_journal.mjs";
import { requestRunCancellation } from "./run.mjs";

export const EXECUTION_VERSION = 1;
export const PROVIDER_STATES = Object.freeze(["queued", "provisioning", "running", "waiting-for-input", "retrieving-results", "succeeded", "failed", "cancellation-requested", "cancelled", "status-unknown"]);
const terminal = s => ["succeeded", "failed", "cancelled"].includes(s);
const exactIdentity = id => typeof id === "string" && !!id.trim();
const ownedRemote = ex => exactIdentity(ex?.providerJobId) && exactIdentity(ex?.turnId);
const maximumCost = (...amounts) => amounts.reduce((known, amount) =>
  Number.isFinite(amount) && amount >= 0 ? known === null ? amount : Math.max(known, amount) : known, null);
const completionTime = (value, startedAt, latestAt, code) => {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || !Number.isFinite(startedAt) || !Number.isFinite(latestAt) || value < Math.max(0, startedAt) || value > latestAt) throw executionError(code, "invalid owned root completion time; reconcile its authoritative timestamps");
  return value;
};
const runCost = (s, id) => maximumCost(s.current?.id === id ? s.current.execution.costUsd : null,
  Object.values(s.operations).find(op => op.runId === id)?.costUsd);
const digest = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const preparationFingerprint = input => {
  const { receipt: _receipt, ...prepared } = input.prepared || {};
  return digest({ environment: input.environment, ...(input.spec ? { spec: input.spec } : { prompt: input.prompt, prepared }) });
};
export const executionLive = job => {
  const ex = job?.execution;
  if (!ex) return false;
  const remote = (ex.transport ?? executionRegistry[ex.provider]?.transport) === "remote";
  return (remote && (ex.acceptance !== "accepted" || !ownedRemote(ex))) || !terminal(ex.providerState) || !ex.collected;
};
export const executionRunner = (ctx, id, provider = ctx.state.get(id)?.harness) => ctx.executionFor && provider ? ctx.executionFor(id, provider) : ctx.runnerFor(id);

export function assertExecutionDependency(taskService) {
  if (typeof taskService !== "function") throw executionError("EXECUTION_DEPENDENCY", "intake task service is missing; merge the natural-language intake predecessor into the selected base before implementation; do not recreate it");
}

/** transport: prepare, submit, inspect, continue, collect, cancel; optional lookup(intent).
 * Methods accept scoped immutable input plus AbortSignal and return bounded JSON.
 * A remote adapter never needs a local command, PID, or inherited environment.
 */
export function makeExecution({ root, taskId, provider, account = "operator", transport = null, runner = null, legacySessionId = null, capabilities = capabilitiesFor(provider), clock = Date, limits = {}, secrets = [], jitter = Math.random }) {
  const bounds = { ...EXECUTION_LIMITS, ...limits };
  const file = join(root, "execution.json");
  const read = () => {
    const s = readJson(file, { version: EXECUTION_VERSION, taskId, provider, account, operations: {}, current: null, stopped: null });
    if (s.version !== EXECUTION_VERSION) throw executionError("EXECUTION_VERSION", `unsupported execution version ${s.version}; stop the coordinator, back up ${root}, and use a compatible package or restore its matching backup; do not redispatch`);
    if (s.taskId !== taskId || s.provider !== provider || s.account !== account) throw executionError("EXECUTION_OWNERSHIP", "execution ownership differs; restore the recorded provider/account; sessions cannot be transplanted");
    // Older/incomplete remote acknowledgements cannot qualify a root turn.
    if (transport && s.current && !ownedRemote(s.current.execution)) {
      const ex = s.current.execution;
      if (ex.acceptance !== "unknown" || !ex.recoveryAction) ex.recoveryAction = "reconcile an exact provider job and root turn using the recorded key";
      Object.assign(ex, { acceptance: "unknown", collected: false,
        providerState: s.stopped ? "cancellation-requested" : "status-unknown",
        terminalState: null, terminalObservedAt: null, completedAt: null });
      const intent = s.operations[s.current.execution.operationId];
      if (intent) intent.acceptance = "unknown";
    }
    // Repair pre-fix failure records that claimed collection without a result.
    const ex = s.current?.execution;
    if (ex) ex.costUsd = runCost(s, s.current.id);
    if (transport && ex?.providerState === "failed" && ex.collected && !s.stopped && !ex.quarantined &&
      !existsSync(join(dirOf(s.current.id), "result.json"))) {
      Object.assign(ex, { providerState: "retrieving-results", terminalState: ex.terminalState ?? "failed", collected: false });
      s.current.exit = null; s.current.endedAt = null;
    }
    // Pre-fix collection could overwrite a retained terminal observation.
    // Keep the private cache for inspection but require reconciliation again.
    if (transport && ex?.collected && !s.stopped && !ex.quarantined &&
      ["succeeded", "failed"].includes(ex.terminalState) && ex.providerState !== ex.terminalState) {
      Object.assign(ex, { providerState: "retrieving-results", collected: false,
        recoveryAction: "result outcome contradicted the authoritative terminal root; reconcile the saved result" });
      s.current.exit = null; s.current.endedAt = null;
    }
    return s;
  };
  const save = s => writeJsonAtomic(file, s);
  const charge = (s, amount) => {
    const intent = s.operations[s.current.execution.operationId];
    if (intent) intent.costUsd = maximumCost(intent.costUsd, amount);
    if (s.allowance) s.allowance.chargedUsd = Math.max(s.allowance.reservedUsd,
      Object.values(s.operations).reduce((sum, op) => sum + Math.max(op.reservedUsd ?? 0, op.costUsd ?? 0), 0));
  };
  const locked = async fn => {
    ensureDir(root);
    const lock = acquireProcessLock(join(root, "execution.lock"), "execution");
    try { return await fn(read()); } finally { lock.release(); }
  };
  const call = (method, input) => boundedCall(signal => transport[method]({ ...input, signal }), bounds);
  const dirOf = id => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw executionError("EXECUTION_INPUT", "invalid run identity");
    return join(root, id);
  };
  const project = s => {
    if (!s.current) return;
    const dir = ensureDir(dirOf(s.current.id));
    writeJsonAtomic(join(dir, "job.json"), { id: s.current.id, name: s.current.name, startedAt: s.current.startedAt, exit: s.current.exit ?? null, endedAt: s.current.endedAt ?? null, ...(s.current.completionInferred !== undefined ? { completionInferred: s.current.completionInferred } : {}), execution: s.current.execution });
  };
  const cancellationIntent = s => {
    const ex = s.current.execution;
    ex.cancellation ??= { status: capabilities.controls?.cancel ? "pending" : "unsupported",
      reason: s.stopped, requestedAt: clock.now(), idempotencyKey: digest([taskId, provider, account, s.current.id, "cancel"]),
      attempts: 0, failures: 0, nextAttemptAt: clock.now() };
    return ex.cancellation;
  };
  const confirmCancellation = s => {
    Object.assign(s.current.execution, { providerState: "cancelled", collected: true, quarantined: true, recoveryAction: null });
    if (s.current.execution.cancellation) Object.assign(s.current.execution.cancellation, { status: "confirmed", confirmedAt: clock.now() });
    s.current.exit = 137; s.current.endedAt ??= clock.now();
  };
  const collectedLocalOutcome = s => !transport && s.current?.execution.collected && ["succeeded", "failed"].includes(s.current.execution.providerState);
  const completedLocalJob = (s, job) => !transport && job?.id === s.current?.id && job?.running === false && job.exit != null &&
    !job.killed && s.current.execution.acceptance === "accepted" && !s.current.execution.quarantined;
  const settleLocalResult = (s, job) => {
    const ex = s.current.execution, { running: _running, ...record } = job;
    s.current = { ...record, execution: ex };
    const redactions = [...secrets, ...(readJson(join(dirOf(job.id), "sensitive-redactions.json"))?.secrets || [])];
    const lines = runner.lines(job.id), outcome = redact(adapterFor(provider).outcome(lines), redactions);
    const sessionId = adapterFor(provider).sessionFrom(lines) || ex.sessionId;
    writeJsonAtomic(join(dirOf(job.id), "result.json"), { version: EXECUTION_VERSION, taskId, runId: job.id, providerJobId: ex.providerJobId,
      turnId: ex.turnId, inputHead: ex.inputHead, outcome, sessionId });
    Object.assign(ex, { collected: true, providerState: outcome.ok && job.exit === 0 ? "succeeded" : "failed",
      costUsd: maximumCost(ex.costUsd, outcome.cost), sessionId });
    charge(s, ex.costUsd); save(s); runner.annotate?.(job.id, { execution: ex });
  };
  const confirmLocalStop = (s, job) => {
    // A completed snapshot saved before the stop fences collection survives a
    // crash or result-cache write failure. Active stops have no such snapshot.
    if (!s.current.execution.collected && s.current.exit != null && !s.current.killed &&
      s.current.execution.providerState === "retrieving-results" && completedLocalJob(s, job)) settleLocalResult(s, job);
    // A task stop cannot rewrite a run that was settled before the request.
    // Reconciliation reaches this helper again after the fence is persisted.
    if (collectedLocalOutcome(s)) return;
    Object.assign(s.current.execution, { providerState: "cancelled", collected: true, quarantined: true, recoveryAction: null });
    s.current.exit = 137; s.current.endedAt ??= clock.now();
    // A local implementation timeout stops this run, while the canonical
    // lifecycle still permits an explicit same-session resume after shutdown.
    // Operator, preparation and remote cancellations retain their task fence.
    if (s.stopped === "timeout" && s.current.execution.kind !== "intake") s.stopped = null;
  };
  // Called only under the existing ownership lock and coordinator cadence.
  const sendCancellation = async s => {
    const ex = s.current.execution, request = cancellationIntent(s);
    if (terminal(ex.providerState) && ex.collected) {
      ex.quarantined = true;
      request.status = ex.providerState === "cancelled" ? "confirmed" : "terminal";
      return { confirmed: ex.providerState === "cancelled" };
    }
    if (request.status === "unsupported") return { confirmed: false, unsupported: true };
    if (request.status !== "pending" || ex.acceptance !== "accepted" || !ownedRemote(ex) || clock.now() < request.nextAttemptAt) return { confirmed: false };
    request.attempts++; request.lastAttemptAt = clock.now();
    save(s); project(s); // Persist exact recovered ownership before the stop I/O.
    try {
      const answer = await call("cancel", { taskId, provider, account, runId: s.current.id, providerJobId: ex.providerJobId,
        sessionId: ex.sessionId, turnId: ex.turnId, idempotencyKey: request.idempotencyKey });
      if (typeof answer?.confirmed !== "boolean") throw executionError("EXECUTION_PROTOCOL", "cancellation lacks an acknowledgement; reconcile or retry the recorded key");
      if (answer.confirmed === true) confirmCancellation(s);
      else { request.status = "acknowledged"; ex.recoveryAction = "confirm provider cancellation; no more dispatch"; }
      save(s); project(s);
      return { confirmed: answer?.confirmed === true };
    } catch (error) {
      request.failures++; request.nextAttemptAt = nextAttempt(clock.now(), request.failures, error.retryAfterMs, bounds, jitter);
      ex.recoveryAction = "cancellation reply unavailable; retry the recorded cancellation key";
      ex.nextAttemptAt = Math.max(ex.nextAttemptAt, request.nextAttemptAt);
      save(s); project(s); throw error;
    }
  };
  const authorize = input => {
    if (!capabilities.available) throw executionError("EXECUTION_UNAVAILABLE", `${provider}: ${capabilities.reason}; install its implemented transport before selecting it`);
    for (const policy of input.mandatoryPolicy || []) if (!capabilities.policy?.includes(policy)) throw executionError("EXECUTION_POLICY", `provider cannot enforce mandatory policy ${policy}; select a backend that can`);
    if (input.model && !capabilities.models?.includes(input.model)) throw executionError("EXECUTION_INPUT", "unsupported model selection; no fallback is allowed");
    if (input.environment && !capabilities.environments?.includes(input.environment)) throw executionError("EXECUTION_INPUT", "unsupported environment selection");
  };
  const authorizePreparation = s => {
    if (s.stopped) throw executionError("EXECUTION_STOPPED", `dispatch stopped: ${s.stopped}; no new preparation`);
    if ((s.current && executionLive(s.current)) || (!transport && runner.current()?.running)) throw executionError("BUSY", "previous preparation is not settled");
  };
  const dispatch = (method, input) => locked(async s => {
    authorize(input);
    if (input.kind === "intake") {
      const fingerprint = preparationFingerprint(input), issued = s.preparations?.[fingerprint];
      if (!isPreparationReceipt(provider, input.preparation, capabilities, account) || !issued || digest(issued) !== digest(input.preparation)) throw executionError("TASK_PREPARATION_BOUNDARY", "dispatch requires this provider/account's issued receipt for the exact prepared input");
    }
    if (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 256) throw executionError("EXECUTION_INPUT", "a bounded dispatch operationId is required");
    const signature = digest({ method, ...input });
    const prior = Object.hasOwn(s.operations, input.operationId) ? s.operations[input.operationId] : null;
    if (prior) {
      if (prior.signature !== signature) throw executionError("EXECUTION_CONFLICT", "operation identity already owns different input");
      if (prior.acceptance !== "accepted" || (transport && !ownedRemote(prior.job?.execution))) throw executionError("EXECUTION_UNKNOWN", `submission ${prior.runId} acceptance is unknown; reconcile its recorded idempotency key; no new dispatch`);
      return { ...prior.job };
    }
    if (s.stopped) throw executionError("EXECUTION_STOPPED", `dispatch stopped: ${s.stopped}; late results remain quarantined`);
    if (s.current && executionLive(s.current)) throw executionError("BUSY", "previous provider work is not settled");
    const legacy = !transport && !s.current ? runner.current() : null;
    if (legacy?.running) throw executionError("BUSY", "legacy local writer is still running");
    const ownedSession = s.current?.execution.sessionId ?? (!transport && legacy ? adapterFor(provider).sessionFrom(runner.lines(legacy.id)) || legacySessionId : null);
    if (method === "continue" && (!ownedSession || input.sessionId !== ownedSession || capabilities.continuation !== "native-session")) throw executionError("EXECUTION_CONTINUATION", "continuation requires this provider's recorded session and supported native continuity");
    if (input.allowance && (!Number.isFinite(input.allowance.reservedUsd) || input.allowance.reservedUsd < 0 || !Number.isFinite(input.allowance.remainingUsd) || input.allowance.reservedUsd > input.allowance.remainingUsd)) throw executionError("EXECUTION_ALLOWANCE", "unknown or exhausted allowance prevents dispatch");
    if (transport && !input.allowance) throw executionError("EXECUTION_ALLOWANCE", "remote dispatch requires a bounded reservation and remaining allowance");
    if (transport && (input.allowance.reservedUsd <= 0 || input.allowance.remainingUsd <= 0)) throw executionError("EXECUTION_ALLOWANCE", "remote dispatch requires a positive allowance and reservation; unknown usage is not zero");
    if (!transport) runner.prepareStart?.();
    if (input.allowance) {
      s.allowance ??= { totalUsd: input.allowance.remainingUsd, reservedUsd: 0 };
      if (Math.max(s.allowance.reservedUsd, s.allowance.chargedUsd ?? 0) + input.allowance.reservedUsd > s.allowance.totalUsd) throw executionError("EXECUTION_ALLOWANCE", "persisted task allowance exhausted; unknown usage retains its reservation");
      s.allowance.reservedUsd += input.allowance.reservedUsd;
    }
    const id = `run-${randomUUID()}`;
    const intent = { operationId: input.operationId, signature, runId: id, idempotencyKey: digest([taskId, provider, account, input.operationId]), acceptance: "unknown", at: clock.now(), inputHead: input.inputHead ?? null, reservedUsd: input.allowance?.reservedUsd ?? null, costUsd: null };
    s.operations = { ...s.operations, [input.operationId]: intent };
    s.current = { id, name: input.name || method, startedAt: clock.now(), exit: null, execution: {
      version: EXECUTION_VERSION, taskId, provider, account, transport: transport ? "remote" : "cli", runId: id, operationId: input.operationId,
      providerJobId: null, sessionId: input.sessionId ?? (!transport ? input.recordedSessionId : null) ?? null, turnId: null, inputHead: input.inputHead ?? null,
      environment: input.environment ?? null, model: input.model ?? null, providerState: "status-unknown", acceptance: "unknown",
      observedAt: null, reconciledAt: null, nextAttemptAt: clock.now(), failures: 0, costUsd: null, collected: false,
      recoveryAction: "reconcile dispatch acceptance using the recorded key", allowance: input.allowance ?? null,
      controls: capabilities.controls ?? {}, continuation: capabilities.continuation ?? null, mandatoryPolicy: input.mandatoryPolicy || [],
      workflow: input.workflow ?? null,
      kind: input.kind ?? null, preparation: input.kind === "intake" ? input.preparation : null,
    } };
    save(s); // Flush intent before a potentially paid operation.
    if (transport) project(s);
    let accepted;
    try {
      accepted = transport ? await call(method, { ...input, taskId, provider, account, runId: id, idempotencyKey: intent.idempotencyKey })
        : await runner.start(input.name, input.spec.cmd, input.spec.args, { ...input.spec.options, runId: id, privateOutput: { taskId, runId: id, provider } });
    } catch (e) { s.current.execution.recoveryAction = e.code === "EXECUTION_DEADLINE" ? "deadline exceeded; reconcile acceptance" : "submission reply lost; reconcile acceptance"; save(s); if (transport) project(s); throw e; }
    if (transport && (!ownedRemote(accepted) || !ownsProviderSession(s.current.execution.sessionId, accepted?.sessionId))) {
      if (exactIdentity(accepted?.providerJobId)) s.current.execution.providerJobId = accepted.providerJobId;
      s.current.execution.recoveryAction = "submission lacks exact job/root-turn/session ownership; reconcile the recorded key";
      save(s); project(s);
      throw executionError("EXECUTION_UNKNOWN", "submission did not acknowledge exact provider job and root-turn IDs or the owned session; reconcile before retrying");
    }
    const ex = s.current.execution;
    Object.assign(ex, { acceptance: "accepted", providerJobId: accepted.providerJobId ?? accepted.id, sessionId: accepted.sessionId ?? ex.sessionId, turnId: accepted.turnId ?? null, model: accepted.model ?? ex.model, providerState: "queued", recoveryAction: null });
    if (!transport) s.current = { ...accepted, execution: { ...ex, runId: accepted.id } };
    intent.acceptance = "accepted"; intent.job = s.current;
    save(s); if (transport) project(s); else runner.annotate?.(s.current.id, { execution: s.current.execution });
    return { ...s.current };
  });
  const current = () => {
    const s = read();
    if (!transport) {
      const job = runner.current();
      if (job && (!s.current || s.current.id === job.id)) return { ...job, ...(s.current ? { execution: s.current.execution,
        ...(s.current.execution.quarantined ? { exit: s.current.exit, endedAt: s.current.endedAt } : {}) } : {}) };
      if (!s.current) return job; // Legacy local runs retain their exact identity.
    }
    return s.current ? { ...s.current, running: executionLive(s.current) } : null;
  };
  async function reconcile({ force = false } = {}) {
    return locked(async s => {
      if (!transport) runner.observe?.();
      if (!s.current) return current();
      if (!transport) {
        let job = runner.current();
        if (!job || job.id !== s.current.id) return current();
        if (s.current.execution.acceptance === "unknown") {
          // Only an exact launch name supplied by the boundary proves local ownership.
          const intent = s.operations[s.current.execution.operationId];
          s.current = { ...job, execution: { ...s.current.execution, runId: job.id, acceptance: "accepted", providerJobId: job.id } };
          intent.acceptance = "accepted"; intent.job = s.current;
        }
        if (s.stopped && job.running && job.killed && capabilities.controls?.cancel && s.current.execution.acceptance === "accepted") {
          // A daemon restart loses the timer, but the runner owns its persisted
          // killAfter deadline and exact surviving process identities.
          try { requestRunCancellation(runner, job.id); job = runner.current(); s.current.execution.recoveryAction = null; }
          catch (error) { s.current.execution.recoveryAction = error.code || "local shutdown remains unverified"; }
          if (!job || job.id !== s.current.id) { save(s); return current(); }
        }
        Object.assign(s.current.execution, { providerState: job.running ? s.stopped || job.killed ? "cancellation-requested" : "running" : s.current.execution.collected ? s.current.execution.providerState : "retrieving-results", observedAt: clock.now(), reconciledAt: clock.now() });
        if (s.stopped && !job.running) confirmLocalStop(s, job);
        const { running: _running, ...record } = job;
        s.current = { ...record, ...(s.current.execution.quarantined ? { exit: s.current.exit, endedAt: s.current.endedAt } : {}), execution: s.current.execution };
        save(s); runner.annotate?.(s.current.id, { execution: s.current.execution }); return current();
      }
      const ex = s.current.execution;
      if (ex.collected && terminal(ex.providerState)) return current();
      if (s.stopped) cancellationIntent(s);
      if (!force && clock.now() < ex.nextAttemptAt) return current();
      try {
        const observation = ex.acceptance === "unknown"
          ? transport.lookup ? await call("lookup", { intent: s.operations[ex.operationId], taskId, account }) : null
          : await call("inspect", { taskId, account, providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, cursor: ex.cursor ?? null });
        if (!observation) { ex.providerState = "status-unknown"; ex.recoveryAction = "provider cannot reconcile acceptance; inspect the recorded key manually"; }
        else {
          if (!ownedRemote(observation) || (ex.providerJobId && observation.providerJobId !== ex.providerJobId) || (ex.turnId && observation.turnId !== ex.turnId) || !ownsProviderSession(ex.sessionId, observation.sessionId)) throw executionError("EXECUTION_OWNERSHIP", "observation does not identify the recorded provider job/root turn/session");
          if (!PROVIDER_STATES.includes(observation.state)) throw executionError("EXECUTION_PROTOCOL", "unsupported provider state");
          // A stale authoritative read cannot regress newer progress or settle this turn.
          if (!Number.isFinite(observation.observedAt) || observation.observedAt < s.current.startedAt || observation.observedAt < (ex.observedAt ?? 0)) throw executionError("EXECUTION_STALE", "stale provider observation; retrieve current authoritative state");
          if (ex.terminalState && observation.state !== ex.terminalState) throw executionError("EXECUTION_PROTOCOL", "observation contradicts the recorded terminal root; reconcile its authoritative state");
          const completedAt = completionTime(observation.completedAt, s.current.startedAt, observation.observedAt, "EXECUTION_PROTOCOL");
          if (completedAt !== null && (!terminal(observation.state) || (ex.completedAt != null && completedAt !== ex.completedAt))) throw executionError("EXECUTION_PROTOCOL", "completion time differs from the recorded terminal root");
          if (observation.events?.length > bounds.events || Buffer.byteLength(JSON.stringify(observation.events || [])) > bounds.eventBytes) throw executionError("EXECUTION_PROTOCOL", "provider event page exceeds the documented limits; paginate it");
          const journal = journalFor(dirOf(s.current.id), { taskId, runId: s.current.id, provider, secrets });
          for (const ev of observation.events || []) journal.append({ ...ev, providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId ?? ex.turnId });
          if (observation.gap) journal.append({ eventId: `gap-${observation.cursor}`, type: "gap", data: observation.gap, timestamp: clock.now() });
          Object.assign(ex, { providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId, providerState: s.stopped && !terminal(observation.state) ? "cancellation-requested" : observation.state, acceptance: "accepted", observedAt: observation.observedAt, reconciledAt: clock.now(), cursor: observation.cursor ?? ex.cursor, failures: 0, recoveryAction: null, costUsd: maximumCost(ex.costUsd, observation.costUsd) });
          const intent = s.operations[ex.operationId]; intent.acceptance = "accepted"; intent.job = s.current;
          charge(s, ex.costUsd);
          if (terminal(ex.providerState)) {
            ex.completedAt = completedAt ?? ex.completedAt ?? null;
            ex.terminalObservedAt ??= observation.observedAt;
            if (s.stopped) {
              ex.quarantined = true; ex.collected = true; s.current.exit = ex.providerState === "cancelled" ? 137 : 1;
              if (ex.providerState === "cancelled") confirmCancellation(s);
              else ex.cancellation.status = "terminal";
            }
            else if (ex.providerState === "cancelled") { ex.collected = true; s.current.exit = 1; }
            else { ex.terminalState = ex.providerState; ex.providerState = "retrieving-results"; }
          }
        }
        if (s.stopped) await sendCancellation(s);
        ex.nextAttemptAt = clock.now() + bounds.progressMs;
      } catch (e) { ex.providerState = s.stopped ? "cancellation-requested" : "status-unknown"; ex.failures++; ex.recoveryAction = e.code || "provider reconciliation failed"; ex.nextAttemptAt = Math.max(ex.cancellation?.nextAttemptAt ?? 0, nextAttempt(clock.now(), ex.failures, e.retryAfterMs, bounds, jitter)); }
      save(s); project(s); return current();
    });
  }
  const applyCollectedResult = (s, result) => {
    const job = s.current, ex = job.execution, cost = result.outcome.cost;
    Object.assign(ex, { collected: true, providerState: result.outcome.ok ? "succeeded" : "failed",
      sessionId: result.sessionId ?? ex.sessionId,
      costUsd: maximumCost(ex.costUsd, cost), ...(transport ? { completedAt: result.completedAt ?? ex.completedAt ?? null } : {}) });
    charge(s, ex.costUsd);
    job.exit = result.outcome.ok ? 0 : 1;
    if (transport) {
      job.endedAt = ex.completedAt ?? ex.terminalObservedAt ?? result.collectedAt ?? clock.now();
      job.completionInferred = ex.completedAt === null;
    } else job.endedAt ??= result.collectedAt ?? clock.now();
    save(s); if (transport) project(s);
  };
  async function collect() {
    return locked(async s => {
      const job = s.current;
      if (!job) return null;
      const path = join(dirOf(job.id), "result.json");
      const saved = readJson(path);
      const ex = job.execution;
      if (s.stopped || ex.quarantined) throw executionError("EXECUTION_QUARANTINED", "late results are quarantined after a stop");
      if (transport && !ownedRemote(ex)) throw executionError("EXECUTION_RESULT", "exact provider job/root-turn ownership is unresolved; reconcile the recorded key");
      if (transport && !["succeeded", "failed"].includes(ex.terminalState ?? ex.providerState)) throw executionError("EXECUTION_RESULT", "root turn has not authoritatively completed");
      const validResult = (result, cached = false) => {
        if (result?.outcome?.finished !== true || typeof result.outcome.ok !== "boolean" ||
          (transport && (result.providerJobId !== ex.providerJobId || result.turnId !== ex.turnId || result.inputHead !== ex.inputHead ||
            !ownsProviderSession(ex.sessionId, result.sessionId)))) return false;
        if (transport) {
          assertTerminalOutcome(ex, result.outcome);
          const latestAt = Math.min(ex.terminalObservedAt ?? clock.now(), cached ? result.collectedAt ?? clock.now() : clock.now());
          completionTime(ex.completedAt, job.startedAt, latestAt, "EXECUTION_RESULT");
          const completedAt = completionTime(result.completedAt, job.startedAt, latestAt, "EXECUTION_RESULT");
          if (completedAt !== null && ex.completedAt != null && completedAt !== ex.completedAt) throw executionError("EXECUTION_RESULT", "result completion time differs from the recorded terminal root");
        }
        return true;
      };
      if (saved) {
        if (!validResult(saved, true) || (transport && (saved.taskId !== taskId || saved.runId !== job.id))) throw executionError("EXECUTION_RESULT", "saved result does not own the exact completed turn");
        applyCollectedResult(s, saved); return saved;
      }
      if (!transport && runner.current()?.running) throw executionError("BUSY", "local writer is still running");
      if (transport && ex.providerState !== "retrieving-results") throw executionError("EXECUTION_RESULT", "root turn has not authoritatively completed");
      const result = transport ? await call("collect", { taskId, providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, inputHead: ex.inputHead }) : { outcome: adapterFor(provider).outcome(runner.lines(job.id)), sessionId: adapterFor(provider).sessionFrom(runner.lines(job.id)) };
      if (result && Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw executionError("EXECUTION_RESULT", "result exceeds the bounded manifest; retrieve paginated artifacts before collecting");
      if (!validResult(result)) throw executionError("EXECUTION_RESULT", "missing or mismatched results; reconcile the exact completed turn");
      const clean = redactResultMetadata({ ...result, version: EXECUTION_VERSION, taskId, runId: job.id, collectedAt: clock.now() }, secrets);
      writeJsonAtomic(path, clean);
      applyCollectedResult(s, clean);
      return clean;
    });
  }
  async function cancel(reason = "operator-cancelled") {
    return locked(async s => {
      const alreadyStopped = s.stopped;
      // A timeout retry must not downgrade an operator or preparation stop.
      if (!s.stopped || reason !== "timeout") s.stopped = reason;
      // An upgrade may have an owned local writer but no boundary submission.
      // Preserve its identity for stop recovery without inventing a paid intent.
      if (!s.current && !transport) {
        const job = runner.current();
        // Completed pre-boundary runs need only the future-dispatch fence.
        // Adopt live/unfinished writers for the existing shutdown recovery.
        if (job?.running === false && job.exit != null && !job.killed) { save(s); return { confirmed: true }; }
        if (job) {
          const { running: _running, ...record } = job;
          s.current = { ...record, execution: {
            version: EXECUTION_VERSION, taskId, provider, account, runId: job.id,
            operationId: null, legacy: true, transport: "cli", providerJobId: job.id,
            sessionId: legacySessionId, turnId: null, inputHead: null,
            environment: null, model: null, acceptance: "accepted",
            observedAt: clock.now(), reconciledAt: null, nextAttemptAt: clock.now(),
            failures: 0, costUsd: null, collected: false, allowance: null,
            controls: capabilities.controls ?? {}, continuation: capabilities.continuation ?? null,
            mandatoryPolicy: [], workflow: null, kind: null, preparation: null,
          } };
        }
      }
      if (!s.current) { save(s); return { confirmed: true }; }
      const ex = s.current.execution;
      if (collectedLocalOutcome(s)) { save(s); return { confirmed: true }; }
      if (!transport && (!alreadyStopped || (ex.providerState === "retrieving-results" && s.current.exit != null && !s.current.killed))) {
        const job = runner.current();
        if (completedLocalJob(s, job)) {
          const { running: _running, ...record } = job;
          s.current = { ...record, execution: { ...ex, providerState: "retrieving-results" } };
          save(s); // Fence dispatch and retain authoritative completion before collecting.
          settleLocalResult(s, job); return { confirmed: true };
        }
      }
      if (transport && terminal(ex.terminalState)) {
        Object.assign(ex, { providerState: ex.terminalState, collected: true, quarantined: true });
        s.current.exit = 1;
      }
      if (transport && ex.collected && terminal(ex.providerState)) {
        cancellationIntent(s); const answer = await sendCancellation(s); save(s); project(s); return answer;
      }
      ex.providerState = "cancellation-requested"; ex.recoveryAction = "confirm provider cancellation; no more dispatch";
      if (transport) cancellationIntent(s);
      save(s); if (transport) project(s);
      if (transport) return sendCancellation(s);
      if (!capabilities.controls?.cancel || ex.acceptance === "unknown") return { confirmed: false, unsupported: !capabilities.controls?.cancel };
      const answer = requestRunCancellation(runner, s.current.id);
      if (answer?.confirmed) { confirmLocalStop(s, runner.current()); save(s); }
      return { confirmed: answer?.confirmed === true };
    });
  }
  return {
    root, provider, account, capabilities, state: read, current, reconcile, collect, cancel,
    result: id => readJson(join(dirOf(id), "result.json")),
    sanitize: (value, id, extraSecrets = []) => redact(value, [...secrets, ...(readJson(join(dirOf(id), "sensitive-redactions.json"))?.secrets || []), ...extraSecrets]),
    prepare: async (input, { build } = {}) => {
      authorize(input);
      if (input.kind !== "intake") return transport ? call("prepare", input) : input;
      authorizePreparation(read());
      const receipt = preparationReceipt(provider, capabilities, account);
      let prepared;
      if (!transport) prepared = await prepareLocalExecution(provider, capabilities, account, input, build, bounds);
      else {
        if (typeof input.environment !== "string" || input.environment !== capabilities.preparation.environment) throw executionError("TASK_PREPARATION_BOUNDARY", "transport preparation requires its declared limited environment");
        const { kind, environment, prompt, allowance, mandatoryPolicy, model } = input;
        prepared = await call("prepare", { kind, environment, prompt, allowance, mandatoryPolicy, model, taskId, provider, account, preparation: receipt });
        if (!prepared || prepared.boundary !== receipt.boundary || prepared.environment !== input.environment || Buffer.byteLength(JSON.stringify(prepared)) > bounds.eventBytes) throw executionError("TASK_PREPARATION_BOUNDARY", "transport preparation did not confirm the selected bounded authority/environment");
      }
      const fingerprint = preparationFingerprint(transport ? { environment: input.environment, prompt: input.prompt, prepared } : prepared);
      const issued = { ...receipt, taskId, fingerprint };
      await locked(s => { authorizePreparation(s); s.preparations = { ...s.preparations, [fingerprint]: issued }; save(s); });
      return { ...prepared, receipt: issued };
    },
    submit: input => dispatch("submit", input), continue: input => dispatch("continue", input),
    inspect: () => current(), // Read-only: never reaches a transport or creates a polling loop.
    start: (name, cmd, args, options) => {
      const input = options.execution || {};
      return dispatch(input.sessionId ? "continue" : "submit", { ...input, name, operationId: input.operationId || digest([name, cmd, args, options.cwd]), spec: { cmd, args, options } });
    },
    lines: id => runner ? runner.lines(id) : readJson(join(dirOf(id), "result.json"))?.lines || [],
    read: id => runner ? runner.read(id) : readJson(join(dirOf(id), "job.json")),
    outcome: id => {
      const s = read(), dir = dirOf(id);
      const reported = readJson(join(dir, "result.json"))?.outcome ?? (runner ? adapterFor(provider).outcome(runner.lines(id)) :
        { finished: s.current?.id === id && terminal(s.current.execution.providerState), ok: false, cost: null, denials: [], error: "results unavailable" });
      return redact({ ...reported, cost: maximumCost(reported.cost, runCost(s, id)) },
        [...secrets, ...(readJson(join(dir, "sensitive-redactions.json"))?.secrets || [])]);
    },
    sessionFrom: id => readJson(join(dirOf(id), "result.json"))?.sessionId ?? (runner ? adapterFor(provider).sessionFrom(runner.lines(id)) || (read().current?.id === id ? read().current.execution.sessionId : legacySessionId) : read().current?.execution.sessionId),
    settle: (id, inferExit) => {
      if (!runner) return current();
      ensureDir(root);
      const lock = acquireProcessLock(join(root, "execution.lock"), "execution");
      try {
        const s = read();
        if (s.current?.id === id && s.current.execution.quarantined) return current();
        const job = runner.settle(id, inferExit);
        if (s.current?.id === id && job?.id === id && !job.running && !s.stopped && !s.current.execution.quarantined) settleLocalResult(s, job);
        return job;
      } finally { lock.release(); }
    },
    kill: id => { if (transport) throw executionError("EXECUTION_CONTROL", "remote cancellation must be requested and confirmed by the coordinator"); return runner.kill(id); },
    waitForKill: id => runner?.waitForKill(id), dirOf,
  };
}
