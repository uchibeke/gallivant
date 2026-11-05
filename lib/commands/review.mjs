import { resolveHandle } from "../state.mjs";
import { executionRunner } from "../execution.mjs";
import { STATES } from "../state.mjs";
import { READY_LABEL } from "../host_contract.mjs";
import { hostApi, hosts } from "../hosts.mjs";
import { reviewDisclosure, REVIEW_MODES } from "../review_policy.mjs";
import { withReviewState } from "../review_state.mjs";

export async function reviewCommand(ctx, { action, handle, repo, mode, reason, finding, run = false, capability = "text", retry = false, wait = false }) {
  if (action === "qualify") {
    if (!repo) throw new Error("review qualify requires --repo owner/name or host/owner/name");
    const { repository } = (ctx.hosts ?? hosts).select(repo);
    if (wait && !run) throw new Error("qualification --wait requires --run");
    let result = await ctx.reviewService.qualify(repository.key, { run, capability, retry, reason });
    while (wait && ["preparing", "launch-intent", "running", "retry-waiting"].includes(result.status)) {
      await new Promise(resolve => setTimeout(resolve, 250));
      result = await ctx.reviewService.qualify(repository.key, { run: true, capability });
    }
    return result;
  }
  if (!handle) throw new Error("review status|policy|dispute|retry needs a task handle");
  const id = resolveHandle(ctx.state.entries(), handle), entry = ctx.state.get(id);
  if (action === "status") return { id, policy: entry.reviewPolicy, disclosure: reviewDisclosure(entry), record: entry.firstPartyReview, readiness: entry.review_readiness, history: entry.reviewHistory || [] };
  if (!reason?.trim()) throw new Error("review policy/dispute/retry requires --reason with an explicit operator reason");
  return withReviewState(ctx, id, () => mutateReview(ctx, id, { action, mode, reason, finding }));
}

async function mutateReview(ctx, id, { action, mode, reason, finding }) {
  const entry = ctx.state.get(id);
  (ctx.hosts ?? hosts).select(entry);
  const host = hostApi(ctx);
  if (executionRunner(ctx, id).current()?.running) throw new Error("settle the active coding run before changing review state");
  if (action === "retry") {
    const audit = await ctx.reviewService.retry(id, entry, reason);
    ctx.state.update(id, { state: STATES.prOpen, reason: null, firstPartyReview: null,
      reviewHistory: [...(entry.reviewHistory || []), entry.firstPartyReview], review_readiness: null, reviewBinding: null,
      // Only local output is retried. Keep the existing external review window
      // so an exact-head approval remains usable by a both-required task.
      review_next_at: 0,
      last: { ...entry.last, event: "operator authorized retry of a settled review job" } });
    return { id, ...audit, reevaluation: "failed pieces queued; completed pieces and original attempts retained" };
  }
  if (action === "dispute") {
    if (!entry.firstPartyReview?.result?.findings?.some(f => f.id === finding)) throw new Error("--finding must identify a recorded first-party finding");
    const dispute = { finding, reason: reason.trim(), status: "pending-human", at: new Date().toISOString() };
    ctx.state.update(id, { reviewDisputes: [...(entry.reviewDisputes || []), dispute], state: STATES.needsHuman, reason: "review-dispute", review_readiness: null, review_label_pending: Boolean(entry.pr) });
    if (entry.pr) await host.removeLabel(entry.repo, entry.pr, READY_LABEL);
    ctx.state.update(id, { review_label_pending: false });
    return dispute;
  }
  if (action !== "policy" || !REVIEW_MODES.includes(mode)) throw new Error(`review policy requires --mode ${REVIEW_MODES.join("|")}`);
  const policy = await ctx.reviewService.preflight(entry.repo, { mode, legacy_no_review: false });
  const at = new Date().toISOString();
  const patch = { reviewPolicy: policy, reviewPolicyHistory: [...(entry.reviewPolicyHistory || []), { policy: entry.reviewPolicy, reason, at }],
    firstPartyReview: null, reviewHistory: [...(entry.reviewHistory || []), ...(entry.firstPartyReview ? [entry.firstPartyReview] : [])],
    reviewBinding: null, review_readiness: null, review_next_at: 0, rereview: { at, nudged: false },
    ...(entry.completionEvidence?.delivery ? { completionEvidence: { ...entry.completionEvidence, delivery: { ...entry.completionEvidence.delivery, invalidatedAt: at, invalidationReason: "explicit review policy change" } } } : {}),
    state: STATES.needsHuman, reason: "review-policy-changed", review_label_pending: Boolean(entry.pr) };
  // Fence before the host label write. A failed write cannot preserve clearance.
  ctx.state.update(id, patch);
  if (entry.pr) await host.removeLabel(entry.repo, entry.pr, READY_LABEL);
  ctx.state.update(id, { state: entry.pr ? STATES.prOpen : STATES.needsHuman, review_label_pending: false });
  return { id, policy, reason, reevaluation: "current head requires new review evidence" };
}
