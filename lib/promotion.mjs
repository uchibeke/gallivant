// A deliberately narrow cross-host handoff. Review, credentials and publication
// remain owned by their existing services; this module never runs an agent.
import { reviewBinding, reviewDigest, policyConfig, reviewVerdict, assertReviewPolicy } from "./review_policy.mjs";
import { isGreen, makeTrust, readFeedback, exactReviewerVerdict, requiredFeedback } from "./events.mjs";
import { repositoryIdentity, assertBranchName } from "./repository.mjs";
import { withoutTaskMetadata } from "./block.mjs";
import { assertPublicText } from "./public_output.mjs";
import { STATES } from "./state.mjs";

const sha = value => {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value || "")) throw new Error("Missing exact Git commit identity");
  return value;
};
const requireOpen = pr => {
  if (pr.state !== "OPEN" || pr.isDraft || pr.isCrossRepository !== false) throw new Error("Promotion requires an open, non-draft, same-repository PR. Promote its reviewed branch before merging; merged/squashed commits are not substituted.");
};

/** Read-only live plan. A ready label or PR-authored assertion is not authority. */
export async function planPromotion(ctx, options, transfer) {
  const selected = ctx.hosts.fromUrl(options.githubPr, { transport: true });
  const sourceRepo = selected.repository.key;
  const targetRepo = repositoryIdentity(options.bitbucketRepo);
  if (selected.repository.host !== "github.com" || targetRepo.host !== "bitbucket.org") throw new Error("Supply an explicit GitHub PR and bitbucket.org/workspace/repository mapping");
  const found = ctx.state.findByPr(sourceRepo, selected.number);
  const entry = found?.[1];
  if (!entry || ![STATES.ready, STATES.done].includes(entry.state)) throw new Error("Source run must have retained accepted readiness");
  const pr = await ctx.host.prView(sourceRepo, selected.number);
  const accepted = options.acceptedPlan;
  if (accepted) {
    const { digest, ...payload } = accepted;
    if (accepted.version !== 1 || reviewDigest(payload) !== digest || accepted.source?.url !== pr.url || accepted.target?.repo !== targetRepo.key) throw new Error("Accepted plan is invalid or belongs to a different repository mapping");
  }
  if (pr.state === "MERGED") {
    if (!accepted || accepted.source?.head !== pr.headRefOid || accepted.source?.binding !== entry.review_readiness?.binding || pr.isCrossRepository !== false) throw new Error("Merged source requires its accepted pre-merge plan and retained exact readiness binding; never substitute the merge/squash commit");
  } else {
    requireOpen(pr);
    if (entry.state !== STATES.ready) throw new Error("Open source run is no longer ready-for-human");
  }
  if (entry.branch !== pr.headRefName || entry.base !== pr.baseRefName) throw new Error("Source PR branch or base changed from the registered run");
  const policy = assertReviewPolicy(entry.reviewPolicy);
  if (policy.version !== 1) throw new Error("Promotion requires an explicit review policy; legacy/no-review clearance is not accepted");
  const reviewedPr = pr.state === "MERGED" ? { ...pr, baseRefOid: sha(accepted.source.baseHead) } : pr;
  const binding = reviewBinding(reviewedPr, policy);
  if (entry.review_readiness?.binding !== binding || entry.review_readiness?.completion !== "accepted") throw new Error("Source readiness is stale or its completion gate was not accepted; recheck the run first");
  const config = policyConfig(ctx.config, entry);
  if (!isGreen(pr.statusCheckRollup, config.required_checks) || (!pr.statusCheckRollup.length && policy.zeroChecks !== true)) throw new Error("Checks are not green, required checks are missing, or zero checks were not explicitly allowed");
  const trust = makeTrust(config, await ctx.host.userFor(sourceRepo));
  const [reviews, inline, comments] = await readFeedback(ctx.host, sourceRepo, pr);
  if (requiredFeedback({ reviews, inline, trust, headSha: pr.headRefOid }).length) throw new Error("Required feedback remains unresolved");
  const external = await exactReviewerVerdict({ reviews, inline, comments, config, trust, sinceIso: "1970-01-01T00:00:00.000Z", headSha: pr.headRefOid }, ref => ctx.host.refSha(sourceRepo, ref));
  const verdict = reviewVerdict(policy, external, entry.firstPartyReview, binding);
  if (verdict.verdict !== "clear") throw new Error(`Review is not clear: ${verdict.note}`);
  // Local working files are not promotion inputs. Fetching the exact reviewed
  // remote ref into a disposable bare repository preserves untracked carried
  // sources and dirty checkouts without reading or publishing any of them.

  let existing = null;
  if (options.bitbucketPr !== undefined) {
    if (!Number.isSafeInteger(options.bitbucketPr) || options.bitbucketPr < 1) throw new Error("Invalid --bitbucket-pr number");
    existing = await ctx.host.prView(targetRepo.key, options.bitbucketPr);
    requireOpen(existing);
  }
  const branch = assertBranchName(existing?.headRefName ?? options.branch ?? `work/github-${selected.repository.path.replaceAll("/", "-")}-pr-${selected.number}`);
  const base = assertBranchName(options.base ?? existing?.baseRefName ?? pr.baseRefName);
  if (branch === base || existing && (existing.headRefName !== branch || existing.baseRefName !== base || options.branch && options.branch !== branch)) throw new Error("Bitbucket branch/base mapping conflicts with the selected PR");
  const candidates = await ctx.host.prListByHead(targetRepo.key, branch, { allStates: true });
  if (candidates.length > 1 || candidates.some(p => p.isCrossRepository !== false || p.state !== "OPEN" || p.baseRefName !== base)) throw new Error("Conflicting or duplicate Bitbucket PRs; reconcile the explicit mapping before promotion");
  if (existing && candidates[0]?.number !== existing.number) throw new Error("Selected Bitbucket PR no longer owns this branch");
  if (!existing && candidates.length) {
    existing = await ctx.host.prView(targetRepo.key, candidates[0].number);
    requireOpen(existing);
    // A deterministic name is not permission to overwrite somebody else's PR.
    if (!existing.body?.includes(`Source review: ${pr.url}\n`)) throw new Error("An existing PR needs an explicit --bitbucket-pr mapping");
  }
  const targetHead = await ctx.host.branchExists(targetRepo.key, branch) ? sha(await ctx.host.refSha(targetRepo.key, branch)) : null;
  if (existing && targetHead !== existing.headRefOid) throw new Error("Bitbucket PR head changed during planning");
  const body = `${withoutTaskMetadata(pr.body)}\n\nSource review: ${pr.url}\nReviewed source commit: ${sha(pr.headRefOid)}\n\nThis handoff preserves the source commits. Bitbucket merge and deployment approval remain separate.`.trim();
  const plan = { version: 1,
    source: { repo: sourceRepo, url: pr.url, number: pr.number, branch: pr.headRefName, head: sha(pr.headRefOid), base: pr.baseRefName, baseHead: sha(reviewedPr.baseRefOid), binding },
    target: { repo: targetRepo.key, branch, base, head: targetHead, baseHead: sha(await ctx.host.refSha(targetRepo.key, base)), pr: existing?.number ?? null,
      textDigest: existing ? reviewDigest({ title: existing.title, body: existing.body }) : null },
    title: assertPublicText(pr.title, "PR title"), body: assertPublicText(body, "PR body"),
    review: { mode: policy.mode, verdict: verdict.verdict, checks: pr.statusCheckRollup.length, zeroChecks: policy.zeroChecks === true },
  };
  await transfer.validate(plan);
  return { ...plan, digest: reviewDigest(plan) };
}

/** The approved digest binds both repositories, all heads and the public text. */
export async function promote(ctx, options, transfer) {
  const plan = await planPromotion(ctx, options, transfer);
  if (!options.apply) return { applied: false, plan };
  if (!/^[a-f0-9]{64}$/.test(options.expectedPlan || "") || options.expectedPlan !== plan.digest) throw new Error("Plan changed or approval pin missing. Run the dry run, inspect it, then pass --apply --expected-plan <digest>");
  let pushed = false;
  try {
    // Re-read immediately before the Git operation. The native pre-push hook
    // also checks the actual advertised target old OID, closing that race.
    const fresh = await planPromotion(ctx, options, transfer);
    if (fresh.digest !== plan.digest) throw new Error("Source, target or review changed before push; inspect a new plan");
    if (plan.target.head !== plan.source.head) { await transfer.push(plan); pushed = true; }
    const after = await planPromotion(ctx, options, transfer);
    const expected = { ...plan, target: { ...plan.target, head: plan.source.head } };
    delete expected.digest;
    if (after.digest !== reviewDigest(expected)) throw new Error("Source, target or review changed after push; no PR was published");
    const result = await ctx.host.publishResultPr({ repo: plan.target.repo, branch: plan.target.branch, base: plan.target.base, title: plan.title, body: plan.body, expectedNumber: plan.target.pr });
    if (result.headRefOid !== plan.source.head || result.baseRefOid !== plan.target.baseHead || result.headRefName !== plan.target.branch || result.baseRefName !== plan.target.base || plan.target.pr !== null && result.number !== plan.target.pr) throw new Error("Published PR moved during publication; inspect it before any merge");
    return { applied: true, url: result.url, head: plan.source.head, plan };
  } catch (error) {
    if (pushed) error.message += ` The branch may already contain ${plan.source.head}; no merge was attempted. Inspect the target and rerun the dry run; do not force-push.`;
    throw error;
  }
}
