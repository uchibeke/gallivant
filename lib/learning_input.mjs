// Both initial and subsequent, local and hosted dispatch use this seam. No raw
// feedback, candidate, repository instruction or task field can enable learning.
import { hash, learningError } from "./learning_data.mjs";
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
  const snapshot = await service.context(repo, { operationId: input.operationId, profile: entry.harness, paths: [], inputDigest: hash(input), previous });
  if (snapshot.freshSessionRequired && entry.session) throw learningError("CONTINUITY", "retired/disabled advice remains in native session memory; fresh-provider continuity is required before resuming this logical task; code, PR and task state were preserved");
  return { ...input, prompt: input.prompt + (snapshot.section ? "\n\n" + snapshot.section : ""), learning: { ...snapshot, repo }, managedInputDigest: hash({ ...input, advice: snapshot.section || "" }) };
}

export async function learningDelivered(ctx, id, input, job) {
  if (!input.learning?.key || !job?.id) return;
  if (job.execution && job.execution.acceptance !== "accepted") return;
  const service = ctx.learning || ctx.learningFor?.();
  const snapshot = await service.delivered(input.learning.repo, input.learning.key, job.id);
  ctx.state?.update(id, { learning: { ...snapshot, repo: input.learning.repo } });
}
