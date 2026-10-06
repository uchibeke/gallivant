// Versioned durable transport boundary. No transport implements a review loop.
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { capabilitiesFor, adapterFor, preparationReceipt, isPreparationReceipt } from "./harness.mjs";
import { prepareLocalExecution } from "./execution_preparation.mjs";
import { EXECUTION_LIMITS, boundedCall, nextAttempt, executionError, redact } from "./execution_io.mjs";
import { journalFor } from "./execution_journal.mjs";

export const EXECUTION_VERSION = 1;
export const PROVIDER_STATES = Object.freeze(["queued", "provisioning", "running", "waiting-for-input", "retrieving-results", "succeeded", "failed", "cancellation-requested", "cancelled", "status-unknown"]);
const terminal = s => ["succeeded", "failed", "cancelled"].includes(s);
const digest = v => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const preparationFingerprint = input => {
  const { receipt: _receipt, ...prepared } = input.prepared || {};
  return digest({ environment: input.environment, ...(input.spec ? { spec: input.spec } : { prompt: input.prompt, prepared }) });
};
export const executionLive = job => !!job?.execution && (!terminal(job.execution.providerState) || !job.execution.collected);
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
    return s;
  };
  const save = s => writeJsonAtomic(file, s);
  const charge = (s, amount) => {
    const intent = s.operations[s.current.execution.operationId];
    if (Number.isFinite(amount) && amount >= 0) intent.costUsd = Math.max(intent.costUsd ?? 0, amount);
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
    writeJsonAtomic(join(dir, "job.json"), { id: s.current.id, name: s.current.name, startedAt: s.current.startedAt, exit: s.current.exit ?? null, endedAt: s.current.endedAt ?? null, execution: s.current.execution });
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
      if (prior.acceptance !== "accepted") throw executionError("EXECUTION_UNKNOWN", `submission ${prior.runId} acceptance is unknown; reconcile its recorded idempotency key; no new dispatch`);
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
    if (input.allowance) {
      s.allowance ??= { totalUsd: input.allowance.remainingUsd, reservedUsd: 0 };
      if (Math.max(s.allowance.reservedUsd, s.allowance.chargedUsd ?? 0) + input.allowance.reservedUsd > s.allowance.totalUsd) throw executionError("EXECUTION_ALLOWANCE", "persisted task allowance exhausted; unknown usage retains its reservation");
      s.allowance.reservedUsd += input.allowance.reservedUsd;
    }
    const id = `run-${randomUUID()}`;
    const intent = { operationId: input.operationId, signature, runId: id, idempotencyKey: digest([taskId, provider, account, input.operationId]), acceptance: "unknown", at: clock.now(), inputHead: input.inputHead ?? null, reservedUsd: input.allowance?.reservedUsd ?? null, costUsd: null };
    s.operations = { ...s.operations, [input.operationId]: intent };
    s.current = { id, name: input.name || method, startedAt: clock.now(), exit: null, execution: {
      version: EXECUTION_VERSION, taskId, provider, account, runId: id, operationId: input.operationId,
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
    if (transport && !accepted?.providerJobId) throw executionError("EXECUTION_UNKNOWN", "submission did not acknowledge an exact provider job ID; reconcile before retrying");
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
      if (job && (!s.current || s.current.id === job.id)) return { ...job, ...(s.current ? { execution: s.current.execution } : {}) };
      if (!s.current) return job; // Legacy local runs retain their exact identity.
    }
    return s.current ? { ...s.current, running: executionLive(s.current) } : null;
  };
  async function reconcile({ force = false } = {}) {
    return locked(async s => {
      if (!s.current) return current();
      if (!transport) {
        const job = runner.current();
        if (s.current.execution.acceptance === "unknown") {
          // Only an exact launch name supplied by the boundary proves local ownership.
          if (!job || job.id !== s.current.id) return current();
          const intent = s.operations[s.current.execution.operationId];
          s.current = { ...job, execution: { ...s.current.execution, runId: job.id, acceptance: "accepted", providerJobId: job.id } };
          intent.acceptance = "accepted"; intent.job = s.current;
        }
        if (runner.observe) runner.observe();
        if (job) Object.assign(s.current.execution, { providerState: job.running ? job.killed ? "cancellation-requested" : "running" : s.current.execution.collected ? s.current.execution.providerState : "retrieving-results", observedAt: clock.now(), reconciledAt: clock.now() });
        if (s.stopped && job && !job.running) Object.assign(s.current.execution, { providerState: "cancelled", quarantined: true, collected: true, recoveryAction: null });
        save(s); runner.annotate?.(s.current.id, { execution: s.current.execution }); return current();
      }
      const ex = s.current.execution;
      if (ex.collected && terminal(ex.providerState)) return current();
      if (!force && clock.now() < ex.nextAttemptAt) return current();
      try {
        const observation = ex.acceptance === "unknown"
          ? transport.lookup ? await call("lookup", { intent: s.operations[ex.operationId], taskId, account }) : null
          : await call("inspect", { taskId, account, providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, cursor: ex.cursor ?? null });
        if (!observation) { ex.providerState = "status-unknown"; ex.recoveryAction = "provider cannot reconcile acceptance; inspect the recorded key manually"; }
        else {
          if (!observation.providerJobId || (ex.providerJobId && observation.providerJobId !== ex.providerJobId) || (ex.turnId && observation.turnId !== ex.turnId)) throw executionError("EXECUTION_OWNERSHIP", "observation does not identify the recorded provider job/root turn");
          if (!PROVIDER_STATES.includes(observation.state)) throw executionError("EXECUTION_PROTOCOL", "unsupported provider state");
          // A stale authoritative read cannot regress newer progress or settle this turn.
          if (!Number.isFinite(observation.observedAt) || observation.observedAt < (ex.observedAt ?? 0)) throw executionError("EXECUTION_STALE", "stale provider observation; retrieve current authoritative state");
          if (observation.events?.length > bounds.events || Buffer.byteLength(JSON.stringify(observation.events || [])) > bounds.eventBytes) throw executionError("EXECUTION_PROTOCOL", "provider event page exceeds the documented limits; paginate it");
          const journal = journalFor(dirOf(s.current.id), { taskId, runId: s.current.id, provider, secrets });
          for (const ev of observation.events || []) journal.append({ ...ev, providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId ?? ex.turnId });
          if (observation.gap) journal.append({ eventId: `gap-${observation.cursor}`, type: "gap", data: observation.gap, timestamp: clock.now() });
          Object.assign(ex, { providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId ?? ex.turnId, providerState: s.stopped && !terminal(observation.state) ? "cancellation-requested" : observation.state, acceptance: "accepted", observedAt: observation.observedAt, reconciledAt: clock.now(), cursor: observation.cursor ?? ex.cursor, failures: 0, recoveryAction: null, costUsd: Number.isFinite(observation.costUsd) && observation.costUsd >= 0 ? observation.costUsd : null });
          const intent = s.operations[ex.operationId]; intent.acceptance = "accepted"; intent.job = s.current;
          charge(s, observation.costUsd);
          if (terminal(ex.providerState)) {
            if (s.stopped) { ex.quarantined = true; ex.collected = true; s.current.exit = ex.providerState === "cancelled" ? 137 : 1; }
            else if (ex.providerState !== "succeeded") { ex.collected = true; s.current.exit = 1; }
            else ex.providerState = "retrieving-results";
          }
        }
        ex.nextAttemptAt = clock.now() + bounds.progressMs;
      } catch (e) { ex.providerState = s.stopped ? "cancellation-requested" : "status-unknown"; ex.failures++; ex.recoveryAction = e.code || "provider reconciliation failed"; ex.nextAttemptAt = nextAttempt(clock.now(), ex.failures, e.retryAfterMs, bounds, jitter); }
      save(s); project(s); return current();
    });
  }
  async function collect() {
    return locked(async s => {
      const job = s.current;
      if (!job) return null;
      const path = join(dirOf(job.id), "result.json");
      const saved = readJson(path);
      const ex = job.execution;
      if (s.stopped) throw executionError("EXECUTION_QUARANTINED", "late results are quarantined after a stop");
      if (saved) {
        ex.collected = true; ex.providerState = saved.outcome.ok ? "succeeded" : "failed"; job.exit = saved.outcome.ok ? 0 : 1;
        save(s); if (transport) project(s); return saved;
      }
      if (!transport && runner.current()?.running) throw executionError("BUSY", "local writer is still running");
      if (transport && ex.providerState !== "retrieving-results") throw executionError("EXECUTION_RESULT", "root turn has not authoritatively completed");
      const result = transport ? await call("collect", { taskId, providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, inputHead: ex.inputHead }) : { outcome: adapterFor(provider).outcome(runner.lines(job.id)), sessionId: adapterFor(provider).sessionFrom(runner.lines(job.id)) };
      if (result && Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw executionError("EXECUTION_RESULT", "result exceeds the bounded manifest; retrieve paginated artifacts before collecting");
      if (result?.outcome?.finished !== true || typeof result.outcome.ok !== "boolean" || (transport && (result.providerJobId !== ex.providerJobId || result.turnId !== ex.turnId || result.inputHead !== ex.inputHead || (result.sessionId && ex.sessionId && result.sessionId !== ex.sessionId)))) throw executionError("EXECUTION_RESULT", "missing or mismatched results; reconcile the exact completed turn");
      const clean = redact({ ...result, version: EXECUTION_VERSION, taskId, runId: job.id }, secrets);
      writeJsonAtomic(path, clean);
      ex.collected = true; ex.providerState = result.outcome.ok ? "succeeded" : "failed";
      ex.sessionId = result.sessionId ?? ex.sessionId;
      charge(s, result.outcome.cost);
      job.exit = result.outcome.ok ? 0 : 1; job.endedAt = clock.now();
      save(s); if (transport) project(s);
      return clean;
    });
  }
  async function cancel(reason = "operator-cancelled") {
    return locked(async s => {
      s.stopped = reason;
      if (!s.current) { save(s); return { confirmed: true }; }
      const ex = s.current.execution;
      ex.providerState = "cancellation-requested"; ex.recoveryAction = "confirm provider cancellation; no more dispatch";
      save(s); if (transport) project(s);
      if (!capabilities.controls?.cancel || ex.acceptance === "unknown") return { confirmed: false, unsupported: !capabilities.controls?.cancel };
      const answer = transport ? await call("cancel", { taskId, providerJobId: ex.providerJobId, turnId: ex.turnId }) : { confirmed: !runner.kill(s.current.id) && !runner.current()?.running };
      if (answer?.confirmed) { ex.providerState = "cancelled"; ex.collected = true; ex.quarantined = true; s.current.exit = 137; save(s); if (transport) project(s); }
      return { confirmed: answer?.confirmed === true };
    });
  }
  return {
    root, provider, account, capabilities, state: read, current, reconcile, collect, cancel,
    result: id => readJson(join(dirOf(id), "result.json")),
    sanitize: (value, id) => redact(value, [...secrets, ...(readJson(join(dirOf(id), "sensitive-redactions.json"))?.secrets || [])]),
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
    outcome: id => redact(readJson(join(dirOf(id), "result.json"))?.outcome ?? (runner ? adapterFor(provider).outcome(runner.lines(id)) : { finished: terminal(read().current?.execution.providerState), ok: false, cost: read().current?.execution.costUsd ?? null, denials: [], error: "results unavailable" }), [...secrets, ...(readJson(join(dirOf(id), "sensitive-redactions.json"))?.secrets || [])]),
    sessionFrom: id => readJson(join(dirOf(id), "result.json"))?.sessionId ?? (runner ? adapterFor(provider).sessionFrom(runner.lines(id)) || (read().current?.id === id ? read().current.execution.sessionId : legacySessionId) : read().current?.execution.sessionId),
    settle: (id, inferExit) => {
      if (!runner) return current();
      ensureDir(root);
      const lock = acquireProcessLock(join(root, "execution.lock"), "execution");
      try {
        const job = runner.settle(id, inferExit), s = read();
        if (s.current?.id === id && job && !job.running && !s.stopped) {
          const redactions = [...secrets, ...(readJson(join(dirOf(id), "sensitive-redactions.json"))?.secrets || [])];
          const outcome = redact(adapterFor(provider).outcome(runner.lines(id)), redactions);
          writeJsonAtomic(join(dirOf(id), "result.json"), { version: EXECUTION_VERSION, taskId, runId: id, providerJobId: s.current.execution.providerJobId, turnId: s.current.execution.turnId, inputHead: s.current.execution.inputHead, outcome, sessionId: adapterFor(provider).sessionFrom(runner.lines(id)) || s.current.execution.sessionId });
          Object.assign(s.current.execution, { collected: true, providerState: outcome.ok && job.exit === 0 ? "succeeded" : "failed", costUsd: Number.isFinite(outcome.cost) && outcome.cost >= 0 ? outcome.cost : null, sessionId: adapterFor(provider).sessionFrom(runner.lines(id)) ?? s.current.execution.sessionId });
          save(s); runner.annotate?.(id, { execution: s.current.execution });
        }
        return job;
      } finally { lock.release(); }
    },
    kill: id => { if (transport) throw executionError("EXECUTION_CONTROL", "remote cancellation must be requested and confirmed by the coordinator"); return runner.kill(id); },
    waitForKill: id => runner?.waitForKill(id), dirOf,
  };
}
