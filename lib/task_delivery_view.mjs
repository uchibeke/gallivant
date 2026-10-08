import { DELIVERY_VERSION } from "./task_delivery_contract.mjs";
import { redact } from "./execution_io.mjs";

// All inputs are saved observations, never a transport or live credential.
export function taskView(task, { entry = null, run = null, result = null, verification = null, capabilities = {}, controls = {}, secrets = [] } = {}) {
  const ex = run?.execution || entry?.execution || {};
  const pr = task.implementation?.pr || entry?.pr || null;
  const url = pr && /^[-\w.]+\/[-\w.]+$/.test(task.repo) ? `https://github.com/${task.repo}/pull/${Number(pr)}` : null;
  return redact({ version: DELIVERY_VERSION, taskId: task.taskId, revision: task.revision, status: task.status,
    repo: task.repo, base: task.base, harness: task.harness, original: task.original,
    questions: task.questions, answers: task.answers, requirements: task.requirements,
    assumptions: task.assumptions, mapping: task.mapping, stories: task.stories,
    brief: task.draft ? { hash: task.draft.hash, revision: task.draft.revision, current: task.draft.current, text: task.draft.text } : null,
    readiness: task.readiness, validation: task.validation, allowance: task.preparation?.allowance,
    failures: task.failures, errorCode: task.errorCode, nextAction: task.nextAction,
    progress: { workflowState: entry?.state || task.status, providerState: ex.providerState || null,
      observedAt: ex.observedAt || null, reconciledAt: ex.reconciledAt || null, nextAttemptAt: ex.nextAttemptAt || null,
      recoveryAction: ex.recoveryAction || null, costUsd: ex.costUsd ?? null, continuity: capabilities.continuation || null },
    implementation: task.implementation ? { id: task.implementation.id, run: run?.id || entry?.last?.run || task.implementation.run, state: entry?.state || task.implementation.state, pr, url } : null,
    sources: task.sources, artifacts: [
      ...(task.artifacts || []).filter(a => a.id === "brief").slice(0, 1).map(a => ({ id: a.id, hash: a.hash })),
      ...(result?.files || []).slice(0, 100).map((a, i) => ({ id: `result-${i}`, path: a.path, hash: a.afterHash || a.hash || null })),
      ...(task.artifacts || []).filter(a => a.id !== "brief").slice(0, 100).map(a => ({ id: a.id, hash: a.hash })),
    ].slice(0, 100),
    evidence: { providerTests: (result?.tests || []).slice(0, 100), verification: verification ? { inputHead: verification.inputHead, head: verification.head, ok: verification.ok, commands: verification.commands, status: verification.status, observations: verification.evidence } : null },
    controls, capability: capabilities,
  }, secrets);
}

export function modelSummary(view) {
  // Only bounded redacted recovery reasons enter model context; raw diagnostics,
  // briefs and logs remain in the explicit UI/evidence projection.
  return { version: view.version, taskId: view.taskId, revision: view.revision, status: view.status, harness: view.harness, repo: boundedText(view.repo, 256),
    recovery: view.status === "blocked" ? {
      code: /^TASK_[A-Z_]{1,64}$/.test(view.errorCode || "") ? view.errorCode : "TASK_BLOCKED",
      reasons: (Array.isArray(view.failures) ? view.failures : []).slice(0, 5).map(reason => boundedText(reason, 500)).filter(Boolean),
      nextAction: boundedText(view.nextAction, 500),
    } : null,
    controls: Object.fromEntries(["recheck", "resume", "message", "cancel", "interrupt"].map(key => [key, view.controls?.[key] === true])),
    cancellation: ["stop-future-dispatch; remote-compute-may-continue", "requires-provider-confirmation"].includes(view.controls?.cancellation) ? view.controls.cancellation : null,
    questionIds: (view.questions || []).map(q => q.id),
    questions: (view.questions || []).map(q => ({ id: q.id, text: q.text })), workflowState: view.progress?.workflowState, pr: view.implementation?.url || null };
}

// Discovery must reach the model as well as the UI. Only public capability
// fields are projected; server config, paths and arbitrary adapter extras stay out.
export function capabilitySummary(view) {
  return { version: view.version, repositories: view.repositories.slice(0, 100).map(repo => ({
    id: repo.id, providers: repo.providers.map(provider => ({
      name: provider.name, configured: provider.configured, available: provider.available,
      transport: provider.transport, continuation: provider.continuation,
      controls: { cancel: provider.controls?.cancel, interrupt: provider.controls?.interrupt },
      cost: { source: provider.cost?.source, hardCap: provider.cost?.hardCap },
      canPrepare: provider.canPrepare, accountAccess: provider.accountAccess,
      setup: provider.setup, preparationSetup: provider.preparationSetup,
    })),
  })), truncated: view.truncated, nextCursor: view.nextCursor };
}


// Explicit requested evidence only: no raw brief, source paths, logs or diagnostics.
const boundedText = (value, limit = 300) => typeof value === "string" ? value.slice(0, limit) : null;
export function evidenceSummary(view) {
  const verification = view.evidence?.verification;
  return { version: view.version, taskId: view.taskId, revision: view.revision,
    artifacts: (view.artifacts || []).slice(0, 100).map(a => ({ id: boundedText(a.id, 128), hash: boundedText(a.hash, 128) })),
    providerTests: (view.evidence?.providerTests || []).slice(0, 100).map(t => ({ command: boundedText(t.command), inputHead: boundedText(t.inputHead, 128), exit: Number.isInteger(t.exit) ? t.exit : null })),
    verification: verification ? { ok: typeof verification.ok === "boolean" ? verification.ok : null, status: boundedText(verification.status), inputHead: boundedText(verification.inputHead, 128), head: boundedText(verification.head, 128),
      observations: (verification.observations || []).slice(0, 100).map(t => ({ command: boundedText(t.command), head: boundedText(t.head, 128), exit: Number.isInteger(t.exit) ? t.exit : null })),
      commands: (Array.isArray(verification.commands) ? verification.commands : []).slice(0, 100).map(command => boundedText(command)) } : null,
    pr: view.implementation?.url || null };
}
export function logSummary(view) {
  return { version: view.version, taskId: view.taskId, revision: view.revision,
    total: view.total ?? 0, from: view.from ?? null, to: view.to ?? null, nextAfter: view.to ?? null,
    returnedLines: view.lines?.length || 0, gap: boundedText(view.gap), rawLogsInUi: true };
}


// List pages identify tasks; inspect supplies question text and recovery detail.
export function taskListSummary(view) {
  return { version: view.version, taskId: view.taskId, revision: view.revision,
    status: boundedText(view.status, 64), harness: boundedText(view.harness, 128),
    repo: boundedText(view.repo, 256), questionCount: view.questions?.length || 0,
    workflowState: boundedText(view.progress?.workflowState, 64), pr: boundedText(view.implementation?.url, 512) };
}
