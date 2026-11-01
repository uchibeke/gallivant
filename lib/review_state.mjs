import { dirname, join } from "node:path";
import { acquireProcessLock } from "./daemon.mjs";
import { reviewDigest } from "./review_policy.mjs";

// The CLI mutation lock does not exclude daemon decisions. Hold this per-entry
// owner across every await in a decision or operator revocation, including its
// public label and notification. A live owner never expires by elapsed time.
export async function withReviewState(ctx, id, fn) {
  const owner = acquireProcessLock(join(dirname(ctx.state.file), `review-state-${reviewDigest(id)}.lock`),
    "task review decision (retry after the current operation finishes)");
  try { return await fn(); }
  finally { owner.release(); }
}
