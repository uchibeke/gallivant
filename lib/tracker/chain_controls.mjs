import { assertUnpinnedHome } from "../daemon.mjs";
import { chainRevision, reviewChainRetry, retryChain, cancelChain } from "../chains.mjs";
import { validControlRequestId } from "../control.mjs";

export const CHAIN_SCOPE = {
  retry: "Retry future milestones after repairing the blocker. Does not resume workers or reset their budgets. The daemon still requires each predecessor merge.",
  resnapshot: "Replace approval fingerprints for undispatched milestones only. Review changed briefs and sources locally before confirming. Does not resume workers or reset their budgets.",
  cancel: "Cancel future chain dispatch only. Existing runs are preserved; an active worker is not cancelled. Use its task controls separately if needed.",
};
export function chainControlAvailability(ctx, c, authorized = true) {
  let gate = authorized ? null : "Open this workspace on localhost to use chain controls.";
  try { assertUnpinnedHome(ctx.home); } catch { gate = "This namespace is artifact-pinned. Use its manifest-aware coordinator; browser chain mutations are unavailable."; }
  const futureCount = c.steps.slice(c.index).filter(s => !s.dispatch && !s.entry).length;
  const uncertain = c.steps.some(s => ctx.state.startClaim(s.id) || s.dispatch && !ctx.state.get(s.id));
  return Object.fromEntries(Object.keys(CHAIN_SCOPE).map(action => {
    const reason = gate || (action === "cancel" ? ["done", "cancelled"].includes(c.status) ? `Chain is already ${c.status}.` : null
      : uncertain ? "A start claim or unresolved dispatch needs reconciliation. Retry cannot clear it."
        : action === "retry" && c.status !== "stopped" ? "Retry is available for a stopped chain after its blocker is repaired."
          : action === "resnapshot" && !["active", "stopped"].includes(c.status) ? "Only active or stopped chains can review undispatched inputs."
            : action === "resnapshot" && futureCount > 25 ? "More than 25 future approvals require CLI review; browser recovery is bounded to 25 milestones."
            : action === "resnapshot" && !futureCount ? "No undispatched milestones remain to resnapshot." : null);
    return [action, { available: !reason, reason, scope: CHAIN_SCOPE[action] }];
  }));
}

// No content, absolute paths, checkout paths, dispatch tokens or arbitrary fields
// leave the approval boundary. Fingerprints are comparisons, never file previews.
export const chainFileLabel = path => typeof path === "string" && path.length < 300 && !path.startsWith("/") && !/[\\\0]/.test(path)
  && path.split("/").every(p => p && !p.startsWith(".")) && !/(?:credential|secret|token|password|\.pem$|\.key$)/i.test(path) ? path : "Protected source path";
const hash = value => /^[a-f0-9]{64}$/.test(value || "") ? value : null;
export function chainReviewDifferences(c, steps) {
  return steps.flatMap((s, i) => {
    const old = c.steps[i];
    if (s.entry || s.dispatch || i < c.index) return [];
    return [{ position: i + 1, id: s.id, brief: chainFileLabel(s.relPath),
      fingerprint: { before: hash(old.digest), after: hash(s.digest) },
      harness: { before: old.harness, after: s.harness },
      files: [...new Set([...Object.keys(old.baseFiles || {}), ...Object.keys(s.baseFiles || {}), ...Object.keys(old.inputFiles || {}), ...Object.keys(s.inputFiles || {})])].map(path => ({
        path: chainFileLabel(path), inputBefore: hash(old.inputFiles?.[path]), inputAfter: hash(s.inputFiles?.[path]), before: hash(old.baseFiles?.[path]), after: hash(s.baseFiles?.[path]),
        change: !Object.hasOwn(old.baseFiles || {}, path) ? "added" : !Object.hasOwn(s.baseFiles || {}, path) ? "removed"
          : old.baseFiles[path] !== s.baseFiles[path] ? "base changed" : "base unchanged",
      })) }];
  });
}
const fail = message => { throw new Error(message); };
export async function chainControl(ctx, name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(k => !["action", "stage", "revision", "requestId"].includes(k))
    || !Object.hasOwn(CHAIN_SCOPE, input.action) || !["review", "confirm"].includes(input.stage)
    || !/^[a-f0-9]{64}$/.test(input.revision || "") || !validControlRequestId(input.requestId)) fail("Invalid chain control request.");
  const c = ctx.state.getChain(name);
  if (!c) fail("Chain is no longer registered.");
  // Exact replay observes the saved receipt. It never invokes the service twice.
  if (input.stage === "confirm" && c.control?.id === input.requestId) {
    if (c.control.action !== input.action || c.control.revision !== input.revision) fail("Request identity was already used for different input.");
    return { status: "applied", action: input.action, requestId: input.requestId };
  }
  const gate = chainControlAvailability(ctx, c)[input.action];
  if (!gate.available) fail(gate.reason);
  if (input.stage === "review") {
    if (input.revision !== chainRevision(c)) fail("Chain changed after review; refresh and inspect it again.");
    const plan = input.action === "cancel" ? { steps: c.steps, revision: chainRevision(c) }
      : await reviewChainRetry(ctx, { name, resnapshot: input.action === "resnapshot" });
    if (chainRevision(ctx.state.getChain(name)) !== chainRevision(c)) fail("Chain changed during review; refresh and inspect it again.");
    return { status: "review", action: input.action, requestId: input.requestId, revision: plan.revision,
      repository: c.repo, base: c.base, dependencyTarget: "merged into approved base", scope: gate.scope,
      differences: input.action === "resnapshot" ? chainReviewDifferences(c, plan.steps) : [] };
  }
  if (input.action === "cancel") cancelChain(ctx, name, input);
  else await retryChain(ctx, { name, resnapshot: input.action === "resnapshot", revision: input.revision, requestId: input.requestId });
  return { status: "applied", action: input.action, requestId: input.requestId };
}
