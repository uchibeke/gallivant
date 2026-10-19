// Versioned durable transport boundary. No transport implements a review loop.
import { join } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { capabilitiesFor, adapterFor, preparationReceipt, isPreparationReceipt } from "./harness.mjs";
import { executionLive, PROVIDER_STATES, providerTerminal as terminal, ownedRemoteExecution as ownedRemote } from "./execution_contract.mjs";
export { executionLive, PROVIDER_STATES } from "./execution_contract.mjs";
import { prepareLocalExecution } from "./execution_preparation.mjs";
import { EXECUTION_LIMITS, boundedCall, nextAttempt, executionError, assertExecutionCursor, ownsProviderSession, assertTerminalOutcome, redact, redactResultMetadata } from "./execution_io.mjs";
import { journalFor } from "./execution_journal.mjs";
import { requestRunCancellation } from "./run.mjs";

export const EXECUTION_VERSION = 1;
const exactIdentity = id => typeof id === "string" && !!id.trim();
const freshSessionMatches = (s, sessionId) => !s.learningContinuity?.pending || exactIdentity(sessionId) && sessionId !== s.learningContinuity.sessionId;
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
export const executionRunner = (ctx, id, provider = ctx.state.get(id)?.harness) => ctx.executionFor && provider ? ctx.executionFor(id, provider) : ctx.runnerFor(id);

const epochFile = (root, epoch) => join(root, epoch ? `execution-${epoch}.json` : "execution.json");
const validEpoch = epoch => Number.isSafeInteger(epoch) && epoch >= 0 && epoch <= 1000;
const latestLedger = root => {
  const epochs = readdirSync(root, { withFileTypes: true }).filter(file => file.isFile() && /^execution-[1-9][0-9]*\.json$/.test(file.name))
    .map(file => Number(file.name.slice(10, -5)));
  if (!epochs.length) return null;
  const epoch = Math.max(...epochs);
  if (!validEpoch(epoch)) throw executionError("EXECUTION_VERSION", "invalid execution handoff epoch; restore its matching ledger backup");
  return { epoch, ledger: readJson(epochFile(root, epoch)) };
};

// Reserve a new provider epoch before changing the registry or starting a run.
// Its empty ledger is also the durable route recovered after state.json loss.
export function reserveExecutionEpoch({ root, taskId, provider, account, epoch, pr = null }) {
  if (!validEpoch(epoch) || epoch === 0) throw executionError("EXECUTION_VERSION", "invalid execution handoff epoch");
  const file = epochFile(root, epoch);
  if (existsSync(file)) {
    const saved = readJson(file);
    if (saved?.version !== EXECUTION_VERSION || saved.taskId !== taskId || saved.provider !== provider || saved.account !== account ||
        saved.handoff && (saved.handoff.epoch !== epoch || pr != null && saved.handoff.pr !== pr)) {
      throw executionError("EXECUTION_OWNERSHIP", "reserved handoff ledger belongs to a different execution; restore its matching backup");
    }
    return;
  }
  writeJsonAtomic(file, { version: EXECUTION_VERSION, taskId, provider, account, operations: {}, current: null, stopped: null,
    ...(pr != null ? { handoff: { epoch, pr } } : {}) });
}

// A registered PR may change local harnesses only after its previous run has
// settled. Keep that provider's execution.json intact and give the new harness
// a separate ledger while run directories remain under the same task root.
// The legacy inference repairs registrations made before the epoch was saved:
// it is deliberately limited to the exact settled reset, not an arbitrary
// provider mismatch or a remote task whose ownership remains unresolved.
export function executionEpoch({ root, taskId, entry, provider, account, runner }) {
  if (entry?.execution_epoch != null) {
    if (!validEpoch(entry.execution_epoch)) throw executionError("EXECUTION_VERSION", "invalid execution handoff epoch; restore its matching registry backup");
  }
  const latest = existsSync(root) ? latestLedger(root) : null;
  if (latest) {
    const pending = entry?.handoff_pending;
    const oldEpoch = entry?.execution_epoch ?? 0;
    // A reset interrupted after reserving its new empty ledger keeps the old
    // registry entry fenced. Let a retry inspect that exact old ledger, while
    // `dispatch_stopped` prevents a daemon from launching the old provider.
    if (entry?.dispatch_stopped === "harness-handoff-pending" && pending?.from === provider &&
        pending.to === latest.ledger?.provider && pending.epoch === latest.epoch && pending.pr === entry.pr &&
        oldEpoch === latest.epoch - 1 && latest.ledger?.taskId === taskId && latest.ledger.handoff?.pr === entry.pr &&
        latest.ledger.current === null && !latest.ledger.stopped && Object.keys(latest.ledger.operations ?? {}).length === 0) {
      return oldEpoch;
    }
    if (entry?.execution_epoch != null && entry.execution_epoch !== latest.epoch) throw executionError("EXECUTION_OWNERSHIP", "registry and latest handoff ledger disagree; reconcile the interrupted reset before dispatch");
    if (latest.ledger?.version !== EXECUTION_VERSION || latest.ledger.taskId !== taskId || latest.ledger.provider !== provider || latest.ledger.account !== account ||
        latest.ledger.handoff && (latest.ledger.handoff.epoch !== latest.epoch || latest.ledger.handoff.pr !== entry?.pr)) {
      throw executionError("EXECUTION_OWNERSHIP", "latest handoff ledger belongs to another provider/account; do not reopen an older session");
    }
    return latest.epoch;
  }
  if (entry?.execution_epoch != null) return entry.execution_epoch;
  const old = readJson(epochFile(root, 0));
  if (!old || old.provider === provider && old.account === account) return 0;
  const prior = old.current?.execution;
  const current = runner?.current();
  const exactReset = entry?.pr && entry.session === null &&
    entry.last?.run === old.current?.id && entry.last?.exit === old.current?.exit &&
    entry.execution?.provider === old.provider && entry.execution?.account === old.account &&
    old.taskId === taskId && old.account === "operator" && account === "operator" &&
    prior?.transport === "cli" && prior.provider === old.provider && prior.collected === true &&
    ["succeeded", "failed"].includes(prior.providerState) && !old.stopped &&
    current?.id === old.current.id && current.running === false;
  return exactReset ? 1 : 0;
}

// A sessionless resume is allowed only for an owned, proven unsubmitted first
// launch. Older refusal entries can recover from the private transport proof;
// a registry reason or an absent session alone never authorizes a new session.
export function unsubmittedInitialDispatch(entry, execution) {
  if (execution.capabilities?.transport !== "remote" || entry.session || entry.pr || entry.last?.run || entry.state !== "needs-human" || !["launch-preparation", "dispatch-refused"].includes(entry.reason)) return null;
  const saved = execution.state(), key = entry.start_token;
  const marker = entry.initial_dispatch ?? (entry.reason === "dispatch-refused" && saved.dispatchRefusals?.some(refusal => refusal.operationId === key)
    ? { version: 1, operationId: key, status: "unsubmitted" } : null);
  if (!marker || marker.version !== 1 || marker.status !== "unsubmitted" || typeof key !== "string" || !key || key.length > 256 || marker.operationId !== key || entry.execution?.operationId !== key) return null;
  if (entry.dispatch_stopped || saved.stopped) throw executionError("EXECUTION_STOPPED", "initial dispatch stopped; no new session is authorized");
  if (saved.current || Object.keys(saved.operations).length) throw executionError("EXECUTION_UNKNOWN", "initial launch already has an execution intent or run; reconcile its ownership before resume; no new session is authorized");
  return marker;
}

export function assertExecutionDependency(taskService) {
  if (typeof taskService !== "function") throw executionError("EXECUTION_DEPENDENCY", "intake task service is missing; merge the natural-language intake predecessor into the selected base before implementation; do not recreate it");
}

/** transport: prepare, submit, inspect, continue, collect, cancel; optional lookup(intent).
 * Methods accept scoped immutable input plus AbortSignal and return bounded JSON.
 * A remote adapter never needs a local command, PID, or inherited environment.
 */
export function makeExecution({ root, taskId, provider, account = "operator", transport = null, runner = null, legacySessionId = null, ledgerFile = join(root, "execution.json"), ledgerEpoch = 0, capabilities = capabilitiesFor(provider), clock = Date, limits = {}, secrets = [], jitter = Math.random }) {
  const bounds = { ...EXECUTION_LIMITS, ...limits };
  const file = ledgerFile;
  const collectionRejection = s => {
    const job = s.current, ex = job?.execution;
    if (!transport || !ownedRemote(ex) || !["succeeded", "failed"].includes(ex.terminalState)) return null;
    const checkpoint = readJson(join(dirOf(job.id), "result-application.json"));
    return checkpoint?.phase === "blocked" && checkpoint.reason === "result-collection-validation" &&
      checkpoint.taskId === taskId && checkpoint.runId === job.id && checkpoint.providerJobId === ex.providerJobId &&
      checkpoint.sessionId === ex.sessionId && checkpoint.turnId === ex.turnId && checkpoint.inputHead === ex.inputHead ? checkpoint : null;
  };
  const settleCollectionRejection = s => {
    const job = s.current, ex = job.execution;
    Object.assign(ex, { collected: true, resultRejected: true, providerState: ex.terminalState,
      recoveryAction: "result collection rejected; inspect result-application.json and explicitly resume the same session for correction" });
    // Settle provider liveness without inventing a valid result or rewriting its
    // root outcome. The blocked checkpoint prevents implementation completion.
    job.exit = ex.terminalState === "succeeded" ? 0 : 1;
    job.endedAt = ex.completedAt ?? ex.terminalObservedAt ?? clock.now();
    job.completionInferred = ex.completedAt == null;
  };
  const read = () => {
    const s = readJson(file, { version: EXECUTION_VERSION, taskId, provider, account, operations: {}, current: null, stopped: null });
    if (s.version !== EXECUTION_VERSION) throw executionError("EXECUTION_VERSION", `unsupported execution version ${s.version}; stop the coordinator, back up ${root}, and use a compatible package or restore its matching backup; do not redispatch`);
    if (s.taskId !== taskId || s.provider !== provider || s.account !== account) throw executionError("EXECUTION_OWNERSHIP", "execution ownership differs; restore the recorded provider/account; sessions cannot be transplanted");
    if (transport) {
      assertExecutionCursor(s.current?.execution.cursor, { persisted: true });
      for (const op of Object.values(s.operations)) assertExecutionCursor(op.job?.execution?.cursor, { persisted: true });
    }
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
    // The checkpoint is written first. Recover a crash before execution.json or
    // job.json settlement without contacting or redownloading from the provider.
    if (!s.stopped && !ex?.quarantined && collectionRejection(s)) settleCollectionRejection(s);
    if (transport && ex?.providerState === "failed" && ex.collected && !ex.resultRejected && !s.stopped && !ex.quarantined &&
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
  const localSession = (s, id, reported) => {
    const intent = Object.values(s.operations).find(op => op.runId === id);
    const ex = s.current?.id === id ? s.current.execution : null;
    // The acknowledgement retains a preassigned session even if an older
    // settlement replaced the current identity. Anonymous first turns may
    // establish their session; the legacy registry applies only to old runs.
    const owned = intent?.job?.execution?.sessionId ?? ex?.sessionId ?? (ex || intent ? null : legacySessionId);
    if (s.learningContinuity?.nextRun === id && reported != null && reported === s.learningContinuity.sessionId) throw executionError("EXECUTION_RESULT", "local result reused retired provider memory");
    if ((ex && !ownsProviderSession(owned, ex.sessionId)) || !ownsProviderSession(owned, reported)) {
      throw executionError("EXECUTION_RESULT", "local result does not identify the recorded provider session; reconcile the exact owned session before continuing");
    }
    return reported ?? owned ?? null;
  };
  const settleLocalResult = (s, job) => {
    const ex = s.current.execution, { running: _running, ...record } = job;
    const redactions = [...secrets, ...(readJson(join(dirOf(job.id), "sensitive-redactions.json"))?.secrets || [])];
    const lines = runner.lines(job.id), outcome = redact(adapterFor(provider).outcome(lines), redactions);
    const sessionId = localSession(s, job.id, adapterFor(provider).sessionFrom(lines));
    s.current = { ...record, execution: ex };
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
      ex.quarantined = true; ex.recoveryAction = null;
      request.status = ex.providerState === "cancelled" ? "confirmed" : "terminal";
      return ex.providerState === "cancelled" ? { confirmed: true } : { confirmed: false, terminal: true };
    }
    if (request.status === "unsupported") { ex.recoveryAction = "remote cancellation unsupported; execution may continue at the retained task link; no future dispatch, late results quarantined"; save(s); project(s); return { confirmed: false, unsupported: true }; }
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
    if (!capabilities.available) throw executionError("EXECUTION_UNAVAILABLE", `${provider}: ${capabilities.reason}; ${capabilities.fix || "install its implemented transport before selecting it"}`);
    if (capabilities.transport === "remote" && !transport) throw executionError("EXECUTION_TRANSPORT", "remote provider requires its implemented transport; no local executable fallback");
    for (const policy of input.mandatoryPolicy || []) if (!capabilities.policy?.includes(policy)) throw executionError("EXECUTION_POLICY", `provider cannot enforce mandatory policy ${policy}; select a backend that can`);
    if (input.model && !capabilities.models?.includes(input.model)) throw executionError("EXECUTION_INPUT", "unsupported model selection; no fallback is allowed");
    const environments = input.kind === "intake" && capabilities.preparation?.environment ? [capabilities.preparation.environment] : capabilities.environments;
    if (input.environment && !environments?.includes(input.environment)) throw executionError("EXECUTION_INPUT", "unsupported environment selection");
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
    if (s.learningContinuity?.pending && (method !== "submit" || input.sessionId)) throw executionError("EXECUTION_CONTINUATION", "retired advice requires a new provider session, not continuation");
    if (s.stopped) throw executionError("EXECUTION_STOPPED", `dispatch stopped: ${s.stopped}; late results remain quarantined`);
    if (s.current && executionLive(s.current)) throw executionError("BUSY", "previous provider work is not settled");
    const legacy = !transport && !s.current && ledgerEpoch === 0 ? runner.current() : null;
    if (legacy?.running) throw executionError("BUSY", "legacy local writer is still running");
    const ownedSession = transport ? s.current?.execution.sessionId : s.current
      ? localSession(s, s.current.id, s.current.execution.sessionId)
      : legacy ? localSession(s, legacy.id, adapterFor(provider).sessionFrom(runner.lines(legacy.id))) : null;
    if (method === "continue" && (!ownedSession || input.sessionId !== ownedSession || !["native-session", "successor-task"].includes(capabilities.continuation))) throw executionError("EXECUTION_CONTINUATION", "continuation requires this provider's recorded logical session and supported continuity");
    if (input.allowance && (!Number.isFinite(input.allowance.reservedUsd) || input.allowance.reservedUsd < 0 || !Number.isFinite(input.allowance.remainingUsd) || input.allowance.reservedUsd > input.allowance.remainingUsd)) throw executionError("EXECUTION_ALLOWANCE", "unknown or exhausted allowance prevents dispatch");
    if (transport && !input.allowance) throw executionError("EXECUTION_ALLOWANCE", "remote dispatch requires a bounded reservation and remaining allowance");
    if (transport && (input.allowance.reservedUsd <= 0 || input.allowance.remainingUsd <= 0)) throw executionError("EXECUTION_ALLOWANCE", "remote dispatch requires a positive allowance and reservation; unknown usage is not zero");
    if (!transport) runner.prepareStart?.();
    const beforeDispatch = structuredClone(s);
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
      ...(input.learning ? { learning: input.learning, managedInputDigest: input.managedInputDigest } : {}),
    } };
    save(s); // Flush intent before a potentially paid operation.
    if (transport) project(s);
    let accepted;
    try {
      accepted = transport ? await call(method, { ...input, taskId, provider, account, runId: id, idempotencyKey: intent.idempotencyKey })
        : await runner.start(input.name, input.spec.cmd, input.spec.args, { ...input.spec.options, runId: id, privateOutput: { taskId, runId: id, provider } });
    } catch (e) {
      if (transport && e.dispatchNotSent === true) {
        // Restore the previous owned root and reservation, while retaining a
        // bounded private refusal record. No provider identity was dispatched;
        // the same authorized operation may be retried after host/input repair.
        beforeDispatch.dispatchRefusals = [...(beforeDispatch.dispatchRefusals || []).slice(-19), { operationId: input.operationId, runId: id, code: String(e.code || "EXECUTION_INPUT").slice(0, 128), at: clock.now() }];
        save(beforeDispatch);
        rmSync(dirOf(id), { recursive: true, force: true });
        throw e;
      }
      s.current.execution.recoveryAction = e.code === "EXECUTION_DEADLINE" ? "deadline exceeded; reconcile acceptance" : "submission reply lost; reconcile acceptance";
      save(s); if (transport) project(s); throw e;
    }
    if (transport && (!ownedRemote(accepted) || !ownsProviderSession(s.current.execution.sessionId, accepted?.sessionId) || !freshSessionMatches(s, accepted?.sessionId))) {
      if (exactIdentity(accepted?.providerJobId)) s.current.execution.providerJobId = accepted.providerJobId;
      s.current.execution.recoveryAction = "submission lacks exact job/root-turn/session ownership; reconcile the recorded key";
      save(s); project(s);
      throw executionError("EXECUTION_UNKNOWN", "submission did not acknowledge exact provider job and root-turn IDs or the owned session; reconcile before retrying");
    }
    const ex = s.current.execution;
    Object.assign(ex, { acceptance: "accepted", providerJobId: accepted.providerJobId ?? accepted.id, sessionId: accepted.sessionId ?? ex.sessionId, turnId: accepted.turnId ?? null, model: accepted.model ?? ex.model, environment: accepted.environment ?? ex.environment, ...(accepted.effective ? { effective: accepted.effective } : {}), providerState: "queued", recoveryAction: null });
    if (!transport) s.current = { ...accepted, execution: { ...ex, runId: accepted.id } };
    if (s.learningContinuity?.pending) s.learningContinuity = { ...s.learningContinuity, pending: false, nextRun: s.current.id, nextSession: ex.sessionId };
    intent.acceptance = "accepted"; intent.job = s.current;
    save(s); if (transport) project(s); else runner.annotate?.(s.current.id, { execution: s.current.execution });
    return { ...s.current };
  });
  const current = () => {
    const s = read();
    if (!transport) {
      const job = runner.current();
      if (job && ((ledgerEpoch === 0 && !s.current) || s.current?.id === job.id)) return { ...job, ...(s.current ? { execution: s.current.execution,
        ...(s.current.execution.quarantined ? { exit: s.current.exit, endedAt: s.current.endedAt } : {}) } : {}) };
      if (!s.current) return ledgerEpoch === 0 ? job : null; // Only the original epoch may adopt a legacy local run.
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
          if (s.current.execution.sessionId && !freshSessionMatches(s, s.current.execution.sessionId)) throw executionError("EXECUTION_CONTINUATION", "recovered local run reused retired memory");
          if (s.learningContinuity?.pending) s.learningContinuity = { ...s.learningContinuity, pending: false, nextRun: s.current.id, nextSession: s.current.execution.sessionId };
          intent.acceptance = "accepted"; intent.job = s.current;
        }
        if (s.stopped && job.running && capabilities.controls?.cancel && s.current.execution.acceptance === "accepted") {
          // Recover acceptance before initiating a requested stop or resuming
          // the runner's persisted deadline and exact process identities.
          save(s);
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
          assertExecutionCursor(observation.cursor);
          if (!ownedRemote(observation) || (ex.providerJobId && observation.providerJobId !== ex.providerJobId) || (ex.turnId && observation.turnId !== ex.turnId) || !ownsProviderSession(ex.sessionId, observation.sessionId) || !freshSessionMatches(s, observation.sessionId)) throw executionError("EXECUTION_OWNERSHIP", "observation does not identify the recorded provider job/root turn/session");
          if (!PROVIDER_STATES.includes(observation.state)) throw executionError("EXECUTION_PROTOCOL", "unsupported provider state");
          // A stale authoritative read cannot regress newer progress or settle this turn.
          if (!Number.isFinite(observation.observedAt) || observation.observedAt < s.current.startedAt || observation.observedAt < (ex.observedAt ?? 0)) throw executionError("EXECUTION_STALE", "stale provider observation; retrieve current authoritative state");
          if (observation.observedAt > clock.now()) throw executionError("EXECUTION_PROTOCOL", "future provider observation; return current UTC epoch milliseconds before retrying");
          if (ex.terminalState && observation.state !== ex.terminalState) throw executionError("EXECUTION_PROTOCOL", "observation contradicts the recorded terminal root; reconcile its authoritative state");
          const completedAt = completionTime(observation.completedAt, s.current.startedAt, observation.observedAt, "EXECUTION_PROTOCOL");
          if (completedAt !== null && (!terminal(observation.state) || (ex.completedAt != null && completedAt !== ex.completedAt))) throw executionError("EXECUTION_PROTOCOL", "completion time differs from the recorded terminal root");
          if (observation.events?.length > bounds.events || Buffer.byteLength(JSON.stringify(observation.events || [])) > bounds.eventBytes) throw executionError("EXECUTION_PROTOCOL", "provider event page exceeds the documented limits; paginate it");
          const journal = journalFor(dirOf(s.current.id), { taskId, runId: s.current.id, provider, secrets });
          for (const ev of observation.events || []) journal.append({ ...ev, providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId ?? ex.turnId });
          if (observation.gap) {
            const gapId = `gap-${observation.cursor}`;
            journal.append({ eventId: gapId.length <= 512 ? gapId : `gap:${digest([observation.cursor])}`, type: "gap", data: observation.gap, timestamp: clock.now() });
          }
          Object.assign(ex, { providerJobId: observation.providerJobId, sessionId: observation.sessionId ?? ex.sessionId, turnId: observation.turnId, providerState: s.stopped && !terminal(observation.state) ? "cancellation-requested" : observation.state, acceptance: "accepted", observedAt: observation.observedAt, reconciledAt: clock.now(), cursor: observation.cursor ?? ex.cursor, ...(observation.environment ? { environment: observation.environment } : {}), ...(observation.effective ? { effective: observation.effective } : {}), ...(observation.usage !== undefined ? { usage: observation.usage } : {}), ...(observation.environmentState ? { environmentState: observation.environmentState } : {}), failures: 0, recoveryAction: null, costUsd: maximumCost(ex.costUsd, observation.costUsd) });
          if (s.learningContinuity?.pending) s.learningContinuity = { ...s.learningContinuity, pending: false, nextRun: s.current.id, nextSession: ex.sessionId };
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
      } catch (e) {
        if (e.providerObservationError === true) journalFor(dirOf(s.current.id), { taskId, runId: s.current.id, provider, secrets }).append({ eventId: `inspection-error:${clock.now()}:${ex.failures}`, type: "error", timestamp: clock.now(), provenance: "coordinator", data: { code: e.code || "provider reconciliation failed" } });
        ex.providerState = s.stopped ? "cancellation-requested" : "status-unknown"; ex.failures++; ex.recoveryAction = e.code || "provider reconciliation failed"; ex.nextAttemptAt = Math.max(ex.cancellation?.nextAttemptAt ?? 0, nextAttempt(clock.now(), ex.failures, e.retryAfterMs, bounds, jitter)); }
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
      if (collectionRejection(s)) throw executionError("EXECUTION_RESULT_BLOCKED", "result collection is blocked; inspect result-application.json and explicitly resume the same session for correction");
      const validResult = (result, cached = false) => {
        if (result?.outcome?.finished !== true || typeof result.outcome.ok !== "boolean" ||
          (transport && (result.providerJobId !== ex.providerJobId || result.turnId !== ex.turnId || result.inputHead !== ex.inputHead ||
            !ownsProviderSession(ex.sessionId, result.sessionId)))) return false;
        if (!transport) localSession(s, job.id, result.sessionId);
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
      let result;
      try {
        result = transport ? await call("collect", { taskId, providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, inputHead: ex.inputHead }) : { outcome: adapterFor(provider).outcome(runner.lines(job.id)), sessionId: adapterFor(provider).sessionFrom(runner.lines(job.id)) };
      } catch (error) {
        if (transport && error.code === "EXECUTION_RESULT" && error.collectionValidation === true) {
          writeJsonAtomic(join(dirOf(job.id), "result-application.json"), { version: 1, taskId, runId: job.id,
            providerJobId: ex.providerJobId, sessionId: ex.sessionId, turnId: ex.turnId, inputHead: ex.inputHead,
            phase: "blocked", reason: "result-collection-validation", blockedAt: new Date(clock.now()).toISOString() });
          settleCollectionRejection(s); charge(s, ex.costUsd); save(s); project(s);
        }
        throw error;
      }
      if (result && Buffer.byteLength(JSON.stringify(result)) > 1_048_576) throw executionError("EXECUTION_RESULT", "result exceeds the bounded manifest; retrieve paginated artifacts before collecting");
      if (!validResult(result)) throw executionError("EXECUTION_RESULT", "missing or mismatched results; reconcile the exact completed turn");
      if (!transport) result.sessionId = localSession(s, job.id, result.sessionId);
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
      if (!s.current && !transport && ledgerEpoch === 0) {
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
      if (transport && !ex.collected && terminal(ex.terminalState)) {
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
    root, provider, account, ledgerEpoch, capabilities, state: read, current, reconcile, collect, cancel,
    recover: async ({ operationId, authorized = false } = {}) => {
      const pending=await locked(async s => {
      const job=s.current,ex=job?.execution;
      if (authorized!==true || typeof operationId!=="string" || !operationId || operationId.length>256) throw executionError("EXECUTION_CONTROL", "recovery requires explicit authorization and a bounded request identity");
      if (s.stopped || ex?.quarantined) throw executionError("EXECUTION_STOPPED", "recovery cannot clear a stop or release quarantined results");
      if (!transport || !job || !transport.resetRecovery || ex.providerState!=="status-unknown") return null;
      const intent=s.operations[ex.operationId];
      if (!intent || intent.runId!==job.id) throw executionError("EXECUTION_OWNERSHIP", "recovery cannot replace the saved dispatch intent");
      const key=digest([taskId,provider,account,job.id,ex.operationId,operationId]);
      if (ex.recoveryRequests?.[key]==="acknowledged") return null;
      if (!Object.hasOwn(ex.recoveryRequests || {},key) && Object.keys(ex.recoveryRequests || {}).length>=32) throw executionError("EXECUTION_CONTROL", "recovery receipt capacity reached; preserve the saved operation");
      ex.recoveryRequests={...ex.recoveryRequests,[key]:"intent"};save(s);
      await call("resetRecovery",{intent,providerJobId:ex.providerJobId,sessionId:ex.sessionId,turnId:ex.turnId,operationId:key,authorized:true});
      ex.recoveryRequests[key]="reset";ex.failures=0;ex.nextAttemptAt=clock.now();
      ex.recoveryAction="explicit recovery authorized; reconcile the saved operation without resending input";
      save(s);project(s);return {key,runId:job.id};
      });
      if(pending) {
        // Observe the authoritative completion before the coordinator's parallel
        // timeout lane. A result completed within allowance remains collectable
        // even when recovery happens later; no input or continuation is sent.
        await reconcile({force:true});
        await locked(s=>{if(s.current?.id!==pending.runId)throw executionError("EXECUTION_OWNERSHIP","recovered run changed before acknowledgement");s.current.execution.recoveryRequests[pending.key]="acknowledged";save(s);});
      }
      return current();
    },
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
    respond: input => locked(async s => {
      if (s.stopped || s.current?.execution.quarantined) throw executionError("EXECUTION_STOPPED", "answers are fenced after a stop");
      const ex = s.current?.execution;
      if (!transport?.respond || !ex || ex.acceptance !== "accepted" || input.sessionId !== ex.sessionId || input.turnId !== ex.turnId || input.authorized !== true) throw executionError("EXECUTION_ACTION", "answer requires authorization and the current owned session/root turn");
      if (typeof input.operationId !== "string" || !input.operationId || input.operationId.length > 256) throw executionError("EXECUTION_INPUT", "answer requires a bounded operation identity");
      const signature = digest(input), key = digest([taskId, provider, account, ex.turnId, input.operationId]);
      const prior = s.answers?.[key];
      if (prior && prior.signature !== signature) throw executionError("EXECUTION_CONFLICT", "answer identity owns different input");
      if (prior?.accepted) return { accepted: true };
      if (prior && typeof transport.recoverResponse !== "function") throw executionError("EXECUTION_UNKNOWN", "answer acceptance unknown; this transport cannot safely recover it; inspect the owned turn without changing the answer identity");
      // Explicitly repeating the identical authorized answer delegates recovery
      // to the provider's authoritative pending-call/idempotency boundary.
      if (!prior) { s.answers = { ...s.answers, [key]: { signature, accepted: false } }; save(s); }
      const result = await call(prior ? "recoverResponse" : "respond", { ...input, taskId, account, providerJobId: ex.providerJobId, idempotencyKey: key });
      s.answers[key].accepted = result?.accepted === true; save(s); return result;
    }),
    freshLearningSession: ({ runId, sessionId }) => locked(s => {
      const job = s.current, ex = job?.execution;
      if (!job || job.id !== runId || ex.sessionId !== sessionId || ex.acceptance !== "accepted" || executionLive(job)) throw executionError("EXECUTION_CONTINUATION", "fresh learning continuity requires the exact settled provider run and session");
      if (s.stopped && s.stopped !== "learned advice retired") throw executionError("EXECUTION_STOPPED", "fresh learning continuity cannot clear an unrelated stop");
      if (s.learningContinuity?.pending) return s.learningContinuity;
      // Preserve old results/quarantine, operations and cumulative allowance.
      // The persisted fence permits only submission of a new provider session.
      s.learningContinuity = { runId, sessionId, pending: true };
      s.stopped = null; save(s);
      return s.learningContinuity;
    }),
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
        { finished: s.current?.id === id && terminal(s.current.execution.providerState), ok: false, cost: null, denials: [], error: s.current?.id === id && s.current.execution.resultRejected ? "result collection rejected; inspect result-application.json" : "results unavailable" });
      return redact({ ...reported, cost: maximumCost(reported.cost, runCost(s, id)) },
        [...secrets, ...(readJson(join(dir, "sensitive-redactions.json"))?.secrets || [])]);
    },
    sessionFrom: id => {
      const s = read(), saved = readJson(join(dirOf(id), "result.json"));
      return runner ? localSession(s, id, saved?.sessionId ?? adapterFor(provider).sessionFrom(runner.lines(id)))
        : saved?.sessionId ?? s.current?.execution.sessionId;
    },
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
