// Both initial and subsequent, local and hosted dispatch use this seam. No raw
// feedback, candidate, repository instruction or task field can enable learning.
import { hash, learningError, literalPath } from "./learning_data.mjs";
import { executionRunner } from "./execution.mjs";

export async function revokeLearningAttempts(ctx, { repo, removed, reason }) {
  const outcomes = [];
  for (const [id, entry] of ctx.state.entries()) {
    if (!entry.learning || hash(entry.learning.repo) !== hash(repo) || !entry.learning.rules?.some(r => !removed || removed.some(x => x.id === r.id && x.digest === r.digest))) continue;
    // Preserve task identity, PR, code, review cursor and spend. Do not promise
    // cancellation or erased provider memory when the backend cannot confirm it.
    ctx.state.update(id, { learning_revocation: { reason, freshSessionRequired: true, at: new Date().toISOString() } });
    const runner = executionRunner(ctx, id), current = runner.current();
    let answer = { confirmed: false, unsupported: true };
    try { if (current?.running && runner.cancel) answer = await runner.cancel("learned advice retired"); else if (!current?.running) answer = { confirmed: true, terminal: true }; } catch { /* saved intent remains actionable */ }
    ctx.state.update(id, { learning_revocation: { reason, freshSessionRequired: true, cancellation: answer, at: new Date().toISOString() } });
    outcomes.push({ id, cancellation: answer, freshSessionRequired: true });
  }
  return outcomes;
}

export function learningPaths(entry, paths = []) {
  const selected = new Set();
  for (const path of [...paths, ...(entry.learning?.paths || []), ...(entry.sources || []), entry.prd].filter(Boolean)) {
    try { selected.add(literalPath(path)); } catch { continue; }
    if (selected.size >= 200) break;
  }
  return [...selected].sort();
}

export async function learningInput(ctx, id, entry, input) {
  const service = ctx.learning || ctx.learningFor?.();
  if (!service) return input;
  const repo = service.identityFor(entry.repo);
  if (!repo) return input;
  const previous = entry.learning ?? ctx.state?.get?.(id)?.learning ?? null;
  if (service.mode(repo) !== "apply" && !previous?.rules?.length) return input;
  // Recheck immutable GitHub identity; a cached renamed/replaced owner/name is
  // navigation, never authority for delivering old repository content.
  const actual = await service.resolveRepo(entry.repo);
  if (hash(actual) !== hash(repo)) throw learningError("REPOSITORY", "repository identity changed; foreign learning cannot be delivered");
  const paths = learningPaths(entry, input.paths);
  if (paths.length) input = { ...input, paths };
  const snapshot = await service.context(repo, { operationId: input.operationId, profile: entry.harness, paths, inputDigest: hash(input), previous });
  if (snapshot.freshSessionRequired && entry.session) throw learningError("CONTINUITY", "retired/disabled advice remains in native session memory; use resume --fresh-session after the prior run settles; code, PR and task state were preserved");
  return { ...input, prompt: input.prompt + (snapshot.section ? "\n\n" + snapshot.section : ""), learning: { ...snapshot, repo, paths }, managedInputDigest: hash({ ...input, advice: snapshot.section || "" }) };
}

// Save this patch atomically with accepted-run ownership. The registry outbox
// survives learning-store locks, process restarts, and later accepted attempts.
export function learningDeliveryPatch(entry, input, job) {
  if (!input.learning || !job?.id || (job.execution && job.execution.acceptance !== "accepted")) return {};
  const learning = { ...input.learning, rules: input.learning.rules || [], runId: job.id };
  if (!input.learning.key) return { learning };
  const delivery = { repo: input.learning.repo, key: input.learning.key, runId: job.id };
  const key = hash(delivery);
  return { learning, learning_deliveries: { ...entry?.learning_deliveries, [key]: delivery } };
}

export async function learningDelivered(ctx, id) {
  // Reporting must never undo or obscure provider acceptance. Successful writes
  // are idempotent if the process dies before removing the registry outbox item.
  try {
    for (const [key, delivery] of Object.entries(ctx.state.get(id)?.learning_deliveries || {}).slice(0, 10)) {
      const service = ctx.learning || ctx.learningFor?.();
      const snapshot = await service.delivered(delivery.repo, delivery.key, delivery.runId);
      ctx.state.update(id, entry => {
        const pending = { ...entry.learning_deliveries };
        delete pending[key];
        return { learning_deliveries: pending, ...(entry.last?.run === delivery.runId && entry.learning?.key === delivery.key
          ? { learning: { ...snapshot, repo: delivery.repo } } : {}) };
      });
    }
  } catch {
    ctx.log?.warn(`${id}: learning delivery audit pending; accepted run retained`);
  }
}
