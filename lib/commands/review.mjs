import { resolveHandle } from "../state.mjs";
import { executionRunner } from "../execution.mjs";
import { STATES } from "../state.mjs";
import { READY_LABEL } from "../host_contract.mjs";
import { hostApi, hosts } from "../hosts.mjs";
import { reviewDisclosure, REVIEW_MODES } from "../review_policy.mjs";

export async function reviewCommand(ctx, { action, handle, repo, mode, reason, finding, run = false }) {
  if (action === "qualify") {
    if (!repo) throw new Error("review qualify requires --repo owner/name or host/owner/name");
    const { repository } = (ctx.hosts ?? hosts).select(repo);
    return ctx.reviewService.qualify(repository.key, { run });
  }
  if (!handle) throw new Error("review status|policy|dispute needs a task handle");
  const id = resolveHandle(ctx.state.entries(), handle), entry = ctx.state.get(id);
  if (action === "status") return { id, policy: entry.reviewPolicy, disclosure: reviewDisclosure(entry), record: entry.firstPartyReview, readiness: entry.review_readiness, history: entry.reviewHistory || [] };
  if (!reason?.trim()) throw new Error("review policy/dispute requires --reason with an explicit operator reason");
  (ctx.hosts ?? hosts).select(entry);
  const host = hostApi(ctx);
  if (executionRunner(ctx, id).current()?.running) throw new Error("settle the active coding run before changing review state");
  if (action === "dispute") {
    if (!entry.firstPartyReview?.result?.findings?.some(f => f.id === finding)) throw new Error("--finding must identify a recorded first-party finding");
    const dispute = { finding, reason: reason.trim(), status: "pending-human", at: new Date().toISOString() };
    ctx.state.update(id, { reviewDisputes: [...(entry.reviewDisputes || []), dispute], state: STATES.needsHuman, reason: "review-dispute", review_readiness: null });
    if (entry.pr) await host.removeLabel(entry.repo, entry.pr, READY_LABEL);
    return dispute;
  }
  if (action !== "policy" || !REVIEW_MODES.includes(mode)) throw new Error(`review policy requires --mode ${REVIEW_MODES.join("|")}`);
  const policy = await ctx.reviewService.preflight(entry.repo, { mode, legacy_no_review: false });
  const at = new Date().toISOString();
  const patch = { reviewPolicy: policy, reviewPolicyHistory: [...(entry.reviewPolicyHistory || []), { policy: entry.reviewPolicy, reason, at }],
    firstPartyReview: null, reviewHistory: [...(entry.reviewHistory || []), ...(entry.firstPartyReview ? [entry.firstPartyReview] : [])],
    reviewBinding: null, review_readiness: null, rereview: { at, nudged: false },
    ...(entry.completionEvidence?.delivery ? { completionEvidence: { ...entry.completionEvidence, delivery: { ...entry.completionEvidence.delivery, invalidatedAt: at, invalidationReason: "explicit review policy change" } } } : {}),
    state: STATES.needsHuman, reason: "review-policy-changed" };
  // Fence before the host label write. A failed write cannot preserve clearance.
  ctx.state.update(id, patch);
  if (entry.pr) await host.removeLabel(entry.repo, entry.pr, READY_LABEL);
  ctx.state.update(id, { state: entry.pr ? STATES.prOpen : STATES.needsHuman });
  return { id, policy, reason, reevaluation: "current head requires new review evidence" };
}
