import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planPromotion, promote } from "../lib/promotion.mjs";
import { makePromotionTransfer, pushGuard } from "../lib/promotion_git.mjs";
import { DEFAULTS } from "../lib/config.mjs";
import { selectReviewPolicy, reviewBinding } from "../lib/review_policy.mjs";
import { repositoryIdentity } from "../lib/repository.mjs";
import { renderBlock } from "../lib/block.mjs";
import { execFileAsync } from "../lib/process.mjs";

const head = "a".repeat(40), base = "b".repeat(40), old = "c".repeat(40);
function world() {
  const config = { ...DEFAULTS, repos: [], trusted_authors: ["owner"], required_checks: [], review: { mode: "external-required", zero_checks: true } };
  const policy = selectReviewPolicy(config, "owner/app");
  const pr = { number: 1, url: "https://github.com/owner/app/pull/1", title: "Fix invitation state", body: "Describe the fix.", state: "OPEN", isDraft: false, isCrossRepository: false, headRefName: "work/fix", baseRefName: "main", headRefOid: head, baseRefOid: base, statusCheckRollup: [] };
  const target = { ...pr, number: 93, url: "https://bitbucket.org/team/app/pull-requests/93", headRefOid: old };
  const entry = { repo: "owner/app", branch: pr.headRefName, base: "main", state: "ready-for-human", worktree: "/fixture", reviewPolicy: policy,
    cursor: { since: "2026-11-04T00:00:00Z", dispatched: [], checks_sha: head } };
  const reviews = [{ id: 1, user: { login: "chatgpt-codex-connector[bot]" }, submitted_at: "2026-11-05T00:00:00Z", state: "APPROVED", commit_id: head, body: "No issues found." }];
  let targetHead = old, dirty = false, candidates = [target], pushes = 0, publications = 0;
  const refresh = () => { entry.review_readiness = { binding: reviewBinding(pr, policy), completion: "accepted" }; };
  refresh();
  const ctx = { config, state: { findByPr: () => ["owner/app/fix", entry] }, hosts: { fromUrl: () => ({ repository: repositoryIdentity("owner/app"), number: 1 }) },
    git: { dirty: async () => ({ modified: dirty ? 1 : 0, untracked: 0 }), revision: async () => head, originOf: async () => "https://github.com/owner/app.git" },
    host: {
      prView: async repo => repo === "owner/app" ? structuredClone(pr) : { ...target, headRefOid: targetHead },
      userFor: async () => "owner", reviews: async () => reviews, inlineComments: async () => [], issueComments: async () => [],
      refSha: async (_repo, ref) => ref === "main" ? base : targetHead, branchExists: async () => targetHead !== null,
      prListByHead: async () => candidates,
      publishResultPr: async options => {
        assert.equal(options.expectedNumber, candidates.length ? 93 : null);
        assert.equal(options.expectAbsent, candidates.length === 0);
        assert.deepEqual(options.expectedPreviousText, candidates.length ? { title: target.title, body: target.body } : null);
        publications++; target.body = options.body; return { ...target, headRefOid: targetHead };
      },
    },
  };
  const transfer = { validate: async () => {}, push: async plan => { pushes++; targetHead = plan.source.head; } };
  return { ctx, pr, target, entry, policy, reviews, transfer, refresh, options: { githubPr: pr.url, bitbucketRepo: "bitbucket.org/team/app", bitbucketPr: 93 },
    setDirty: v => { dirty = v; }, setHead: v => { targetHead = v; }, setCandidates: v => { candidates = v; }, calls: () => ({ pushes, publications }) };
}

test("dry run is read-only; exact plan applies once and reuses the mapped PR", async () => {
  const w = world();
  const { plan } = await promote(w.ctx, w.options, w.transfer);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
  const result = await promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer);
  assert.equal(result.head, head);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 1 });
  const again = await planPromotion(w.ctx, w.options, w.transfer);
  await promote(w.ctx, { ...w.options, apply: true, expectedPlan: again.digest }, w.transfer);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 2 });
});

for (const [name, change, pattern] of [
  ["missing reviewer", w => { w.reviews.length = 0; }, /Review is not clear/],
  ["review of old head", w => { w.reviews[0].commit_id = old; }, /Review is not clear/],
  ["new blocking reviewer", w => { w.reviews[0].state = "CHANGES_REQUESTED"; }, /Pending trusted feedback|Review is not clear/],
  ["zero CI without explicit policy", w => { w.policy.zeroChecks = false; w.refresh(); }, /zero checks/],
  ["required CI missing", w => { w.ctx.config.required_checks = ["tests"]; }, /required checks/],
  ["failed CI", w => { w.pr.statusCheckRollup = [{ name: "tests", outcome: "failed" }]; w.refresh(); }, /Checks are not green/],
  ["stale completion", w => { w.pr.body += "changed"; }, /readiness is stale/],
  ["gate skipped", w => { w.entry.review_readiness.completion = "skipped"; }, /completion gate/],
  ["fork source", w => { w.pr.isCrossRepository = true; }, /same-repository/],
  ["closed source", w => { w.pr.state = "CLOSED"; }, /open/],
  ["merged source without retained acceptance", w => { w.pr.state = "MERGED"; delete w.entry.review_readiness; }, /readiness is stale/],
  ["duplicate target PRs", w => { w.setCandidates([w.target, { ...w.target, number: 94 }]); }, /duplicate/],
  ["fork destination", w => { w.target.isCrossRepository = true; }, /same-repository/],
  ["changed destination base", w => { w.options.base = "staging"; }, /mapping conflicts/],
]) test(`refuses ${name} before writes`, async () => {
  const w = world(); change(w);
  await assert.rejects(planPromotion(w.ctx, w.options, w.transfer), pattern);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
});

test("local edits and approved untracked context are never promotion inputs", async () => {
  const w = world(); w.setDirty(true);
  w.ctx.git = new Proxy({}, { get() { throw new Error("must not read operator checkout"); } });
  const plan = await planPromotion(w.ctx, w.options, w.transfer);
  assert.equal(plan.source.head, head);
  delete w.entry.worktree;
  assert.equal((await planPromotion(w.ctx, w.options, w.transfer)).digest, plan.digest);
});

test("old digest cannot approve a changed source body, mapping or target head", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer);
  w.pr.title = "New title";
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /Plan changed/);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
});

test("post-push race stops before PR publication and discloses partial result", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer), push = w.transfer.push;
  w.transfer.push = async p => { await push(p); w.pr.title = "Moved during push"; };
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /changed after push.*branch may already/s);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 0 });
});

test("a remotely accepted push with a lost response reports the possible partial write", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer), push = w.transfer.push;
  w.transfer.push = async p => { await push(p); throw new Error("push response lost"); };
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /response lost.*branch may already contain/s);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 0 });
});

for (const kind of ["command", "inline", "review"]) test(`new trusted ${kind} invalidates an approved plan before coordinator polling`, async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer);
  const feedback = { id: 42, user: { login: "owner", type: "User" }, created_at: "2026-11-05T00:00:01Z", submitted_at: "2026-11-05T00:00:01Z", body: kind === "command" ? "/fix Please correct this" : "Please correct this", state: "CHANGES_REQUESTED", commit_id: head, path: "app.js", line: 1 };
  if (kind === "command") w.ctx.host.issueComments = async () => [feedback];
  if (kind === "inline") w.ctx.host.inlineComments = async () => [feedback];
  if (kind === "review") w.reviews.push(feedback);
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /Pending trusted feedback/);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
  w.entry.cursor.dispatched = [`${kind}:42`];
  assert.equal((await planPromotion(w.ctx, w.options, w.transfer)).digest, plan.digest);
  w.entry.cursor.dispatched = []; w.entry.cursor.since = "2026-11-05T00:00:02Z";
  assert.equal((await planPromotion(w.ctx, w.options, w.transfer)).digest, plan.digest);
});

test("trusted feedback arriving during push blocks publication", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer), push = w.transfer.push;
  w.transfer.push = async p => { await push(p); w.ctx.host.issueComments = async () => [{ id: 51, user: { login: "owner" }, created_at: "2026-11-05T01:00:00Z", body: "/fix New issue" }]; };
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /Pending trusted feedback.*branch may already contain/s);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 0 });
});

test("target edit between approval and final pre-push check causes no writes", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer);
  let count = 0;
  w.transfer.validate = async () => { if (++count === 1) w.target.body = "Concurrent human edit"; };
  await assert.rejects(promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer), /changed before push/);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
});

test("required first-party review is not bypassed by external clearance", async () => {
  const w = world();
  w.policy.mode = "both-required";
  w.policy.route = { name: "codex", fingerprint: "a".repeat(64), qualification: "qualification-run" };
  w.refresh();
  await assert.rejects(planPromotion(w.ctx, w.options, w.transfer), /first-party review pending/);
  w.entry.firstPartyReview = { binding: w.entry.review_readiness.binding, status: "completed", result: { verdict: "clear" } };
  assert.equal((await planPromotion(w.ctx, w.options, w.transfer)).review.mode, "both-required");
});

test("new targets get a deterministic branch; an unclaimed existing PR needs explicit mapping", async () => {
  const w = world(); delete w.options.bitbucketPr;
  w.setCandidates([]); w.setHead(null);
  const plan = await planPromotion(w.ctx, w.options, w.transfer);
  assert.equal(plan.target.branch, "work/github-owner-app-pr-1");
  assert.equal(plan.target.pr, null);
  w.target.headRefName = plan.target.branch; w.setCandidates([w.target]); w.setHead(old);
  await assert.rejects(planPromotion(w.ctx, w.options, w.transfer), /explicit --bitbucket-pr/);
  w.target.body = `Source review: ${w.pr.url}\nReviewed source commit: ${head}`;
  assert.equal((await planPromotion(w.ctx, w.options, w.transfer)).target.pr, 93);
});

test("merged source with an unchanged accepted binding needs no pre-merge plan", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer);
  w.pr.state = "MERGED"; w.entry.state = "done";
  w.pr.mergeCommit = { oid: "e".repeat(40) };
  const result = await promote(w.ctx, { ...w.options, apply: true, expectedPlan: plan.digest }, w.transfer);
  assert.equal(result.head, head);
  assert.equal(result.plan.source.baseHead, base);
  assert.deepEqual(w.calls(), { pushes: 1, publications: 1 });
});

for (const field of ["head", "base", "body", "checks"]) test(`merged source rejects changed ${field} without an accepted base fallback`, async () => {
  const w = world(); w.pr.state = "MERGED"; w.entry.state = "done";
  if (field === "head") w.pr.headRefOid = old;
  if (field === "base") w.pr.baseRefOid = old;
  if (field === "body") w.pr.body += " Changed evidence.";
  if (field === "checks") w.pr.statusCheckRollup = [{ name: "test", outcome: "passed" }];
  await assert.rejects(planPromotion(w.ctx, w.options, w.transfer), /readiness is stale/);
  assert.deepEqual(w.calls(), { pushes: 0, publications: 0 });
});

test("merged/squashed source uses a captured plan only to reconstruct its accepted base", async () => {
  const w = world(), plan = await planPromotion(w.ctx, w.options, w.transfer);
  w.pr.state = "MERGED"; w.pr.baseRefOid = "d".repeat(40); w.pr.mergeCommit = { oid: "e".repeat(40) }; w.entry.state = "done";
  const merged = await planPromotion(w.ctx, { ...w.options, acceptedPlan: plan }, w.transfer);
  assert.equal(merged.source.head, head);
  assert.equal(merged.source.baseHead, base);
  assert.equal(merged.digest, plan.digest);
  w.pr.body += "changed after acceptance";
  await assert.rejects(planPromotion(w.ctx, { ...w.options, acceptedPlan: plan }, w.transfer), /readiness is stale/);
  w.pr.body = "Describe the fix.";
  w.pr.statusCheckRollup = [{ name: "test", outcome: "passed" }];
  await assert.rejects(planPromotion(w.ctx, { ...w.options, acceptedPlan: plan }, w.transfer), /readiness is stale/);
  w.pr.statusCheckRollup = []; delete w.entry.review_readiness;
  await assert.rejects(planPromotion(w.ctx, { ...w.options, acceptedPlan: plan }, w.transfer), /retained exact readiness/);
});

test("public prose survives; source runtime identity and task receipt do not", async () => {
  const w = world();
  w.pr.body += `\n\n${renderBlock({ prd: "docs/prds/fix.md", harness: "codex", session: null, branch: "work/fix" })}\n\n\`\`\`work-attestations\n{"task_id":"old-task","attestations":[]}\n\`\`\``;
  w.refresh();
  const plan = await planPromotion(w.ctx, w.options, w.transfer);
  assert.match(plan.body, /Describe the fix/);
  assert.match(plan.body, /Source review: https:\/\/github.com\/owner\/app\/pull\/1/);
  assert.doesNotMatch(plan.body, /work-session|work-attestations|old-task/);
});

test("pre-push guard checks advertised old SHA, destination and exact source", () => {
  const script = pushGuard({ branch: "work/fix", head, previous: old });
  const run = input => spawnSync(process.execPath, ["--input-type=commonjs", "-e", script], { input, encoding: "utf8" });
  assert.equal(run(`${head} ${head} refs/heads/work/fix ${old}\n`).status, 0);
  for (const input of [`${head} ${head} refs/heads/work/fix ${base}\n`, `${head} ${base} refs/heads/work/fix ${old}\n`, `${head} ${head} refs/heads/main ${old}\n`, "", `${head} ${head} refs/heads/work/fix ${old}\nextra\n`]) assert.equal(run(input).status, 1);
});

test("native Git transfer preserves commits and refuses divergent histories", async t => {
  const root = await mkdtemp(join(tmpdir(), "promotion-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (cwd, args) => (await execFileAsync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } })).stdout.trim();
  await git(root, ["init", "--bare", "source.git"]); await git(root, ["init", "--bare", "target.git"]);
  await git(root, ["init", "--initial-branch=main", "work"]);
  const work = join(root, "work");
  await git(work, ["config", "user.name", "Test"]); await git(work, ["config", "user.email", "test@example.invalid"]);
  await writeFile(join(work, "app.txt"), "base\n"); await git(work, ["add", "."]); await git(work, ["commit", "-m", "base"]);
  const b = await git(work, ["rev-parse", "HEAD"]);
  await git(work, ["push", join(root, "source.git"), "HEAD:main"]); await git(work, ["push", join(root, "target.git"), "HEAD:main"]);
  await writeFile(join(work, "app.txt"), "reviewed\n"); await git(work, ["commit", "-am", "fix"]);
  const h = await git(work, ["rev-parse", "HEAD"]);
  await git(work, ["push", join(root, "source.git"), "HEAD:refs/pull/1/head"]);
  const ctx = { config: {}, hosts: { gitCredential: async () => null, remote: repo => ({ url: join(root, `${repo}.git`) }) } };
  const transfer = await makePromotionTransfer(ctx); t.after(() => transfer.close());
  const plan = { source: { repo: "source", number: 1, head: h, baseHead: b }, target: { repo: "target", base: "main", baseHead: b, head: null, branch: "work/fix" } };
  await transfer.validate(plan); await transfer.push(plan);
  assert.equal(await git(join(root, "target.git"), ["rev-parse", "refs/heads/work/fix"]), h);
  // A concurrent branch creation must fail even if the resulting push would be a fast-forward.
  await assert.rejects(transfer.push(plan), /Promotion target changed/);
  await git(work, ["checkout", "--detach", b]); await writeFile(join(work, "other.txt"), "divergent\n"); await git(work, ["add", "."]); await git(work, ["commit", "-m", "other"]);
  const other = await git(work, ["rev-parse", "HEAD"]);
  await git(work, ["push", join(root, "target.git"), "HEAD:refs/heads/work/divergent"]);
  await assert.rejects(transfer.validate({ ...plan, target: { ...plan.target, head: other, branch: "work/divergent" } }), /diverged/);
  await git(work, ["push", join(root, "target.git"), "HEAD:refs/heads/main"]);
  await assert.rejects(transfer.validate({ ...plan, target: { ...plan.target, baseHead: other } }), /base trees differ/);
});
