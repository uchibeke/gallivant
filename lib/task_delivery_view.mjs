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
    failures: task.failures, nextAction: task.nextAction,
    progress: { workflowState: entry?.state || task.status, providerState: ex.providerState || null,
      observedAt: ex.observedAt || null, reconciledAt: ex.reconciledAt || null, nextAttemptAt: ex.nextAttemptAt || null,
      recoveryAction: ex.recoveryAction || null, costUsd: ex.costUsd ?? null, continuity: capabilities.continuation || null },
    implementation: task.implementation ? { id: task.implementation.id, run: run?.id || entry?.last?.run || task.implementation.run, state: entry?.state || task.implementation.state, pr, url } : null,
    sources: task.sources, artifacts: [...(task.artifacts || []).map(a => ({ id: a.id, hash: a.hash })),
      ...(result?.files || []).slice(0, 100).map((a, i) => ({ id: `result-${i}`, path: a.path, hash: a.afterHash || a.hash || null }))].slice(0, 100),
    evidence: { providerTests: (result?.tests || []).slice(0, 100), verification: verification ? { inputHead: verification.inputHead, head: verification.head, ok: verification.ok, commands: verification.commands, status: verification.status } : null },
    controls, capability: capabilities,
  }, secrets);
}

export function modelSummary(view) {
  // Briefs, logs, artifacts and errors are deliberately outside automatic model context.
  return { version: view.version, taskId: view.taskId, revision: view.revision, status: view.status, harness: view.harness,
    questionIds: (view.questions || []).map(q => q.id), workflowState: view.progress?.workflowState, pr: view.implementation?.url || null };
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
