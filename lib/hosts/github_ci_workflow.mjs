import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { CI_BRANCH_PREFIX, CI_VARIABLE, deferredCIError } from "../ci_timing.mjs";
import { repositoryIdentity, assertBranchName } from "../repository.mjs";
import { reviewDigest } from "../review_policy.mjs";

const require = createRequire(import.meta.url);
// Help and read-only coordination views also run from a freshly unpacked
// package. Load the workflow parser only when an operator reviews setup.
const parseWorkflow = input => require("yaml").parse(input, { maxAliasCount: 0 });

export const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
export const githubId = value => Number.isSafeInteger(value) && value > 0;
export const checkContext = "Post-review CI / verified suite";
export const requestName = id => `Post-review CI ${id}`;
export const candidateJob = (tested, reviewId) => `Verify candidate ${tested} review ${reviewId}`;
export const inactiveGuardJob = "Verify dispatched candidate";
export const immediateName = ({ number, base, merge }) => `PR CI #${number} base ${base} merge ${merge}`;

const workflowPath = /^\.github\/workflows\/[a-zA-Z0-9_-]+\.ya?ml$/;
const dispatchTag = /^review-ci-dispatch-[a-zA-Z0-9_-]+$/;
const requiredFields = ["base", "checksRuleset", "checkout", "dispatchRuleset", "enrollmentRuleset", "originalRevision",
  "ref", "repo", "repositoryId", "revision", "roles", "reviewerId", "version", "workflow", "workflowId"];
const invalid = () => deferredCIError("Supply the exact private GitHub pilot identity, workflow revisions, rulesets and independent actors.", "CI_SETUP_INVALID");
const keys = (value, fields) => value && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());

export function pilotProposal(value) {
  if (!keys(value, requiredFields) || value.version !== 1 || repositoryIdentity(value.repo).host !== "github.com" ||
      !workflowPath.test(value.workflow) || !dispatchTag.test(value.ref) || !sha(value.revision) || !sha(value.originalRevision) ||
      value.revision === value.originalRevision || !["head", "base", "merge"].includes(value.checkout) ||
      ![value.repositoryId, value.workflowId, value.reviewerId, value.checksRuleset, value.dispatchRuleset, value.enrollmentRuleset].every(githubId) ||
      new Set([value.checksRuleset, value.dispatchRuleset, value.enrollmentRuleset]).size !== 3 ||
      !keys(value.roles, ["author", "dispatcher", "enroller", "reporter"])) throw invalid();
  for (const [role, identity] of Object.entries(value.roles)) {
    const bot = role === "author" || role === "dispatcher";
    if (!keys(identity, bot ? ["appId", "actorId"] : ["appId"]) || !githubId(identity.appId) || bot && !githubId(identity.actorId)) throw invalid();
  }
  if (new Set(Object.values(value.roles).map(role => role.appId)).size !== 4 ||
      new Set([value.reviewerId, value.roles.author.actorId, value.roles.dispatcher.actorId]).size !== 3) throw invalid();
  assertBranchName(value.base);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(value.base)) throw invalid();
  if (value.base === value.ref || value.base.startsWith(CI_BRANCH_PREFIX)) throw invalid();
  return { ...structuredClone(value), repo: repositoryIdentity(value.repo).key };
}

const expression = value => "\${{ " + value + " }}";
const guardId = "review_ci_candidate";
const event = "github.event_name";
const dispatch = `${event} == 'workflow_dispatch'`;
const pull = `${event} == 'pull_request'`;
const attemptOne = "github.run_attempt == 1";
const inputs = ["request", "pr", "branch", "head", "base", "merge", "tested", "revision", "review"];
const unsupported = detail => {
  throw deferredCIError(`The selected workflow is outside the pilot format (${detail}). Review a supported workflow before activation.`, "CI_UNSUPPORTED");
};

// This step runs from the protected workflow ref before any candidate code.
// Even its outputs are discarded if any input has moved at the host.
const validateCandidate = String.raw`node <<'NODE'
const fs = require("node:fs");
const e = process.env;
const valid = s => /^[0-9a-f]{40}$/.test(s);
const requireProof = ok => { if (!ok) throw new Error("The approved CI candidate changed or could not be authenticated"); };
async function api(path) {
  const url = "https://api.github.com/repos/" + e.GITHUB_REPOSITORY + "/" + path;
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Authorization: "Bearer " + e.GH_TOKEN, Accept: "application/vnd.github+json" } });
  requireProof(response.ok);
  return response.json();
}
async function main() {
  requireProof(/^[1-9][0-9]*$/.test(e.PR) && /^[1-9][0-9]*$/.test(e.REVIEW) && /^[0-9a-f-]{36}$/.test(e.REQUEST) &&
    [e.HEAD, e.BASE, e.MERGE, e.TESTED].every(valid) && e.BRANCH.startsWith(e.PREFIX));
  const [pr, base, compare, merge, reviews] = await Promise.all([
    api("pulls/" + e.PR),
    api("git/ref/heads/" + encodeURIComponent(e.TARGET)),
    api("compare/" + e.BASE + "..." + e.HEAD),
    api("git/commits/" + e.MERGE),
    api("pulls/" + e.PR + "/reviews?per_page=100")
  ]);
  requireProof(Array.isArray(reviews) && reviews.length < 100);
  const review = reviews.filter(row => row.user?.id === Number(e.REVIEWER) && row.state !== "PENDING")
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at) || b.id - a.id)[0];
  requireProof(review?.id === Number(e.REVIEW) && review.state === "APPROVED" && review.commit_id === e.HEAD &&
    Date.parse(review.submitted_at) >= Date.parse(pr.created_at));
  requireProof(pr.state === "open" && pr.draft === false && pr.number === Number(e.PR) &&
    pr.user.id === Number(e.AUTHOR) && pr.head.repo.id === Number(e.REPO_ID) && pr.base.repo.id === Number(e.REPO_ID) &&
    pr.head.ref === e.BRANCH && pr.base.ref === e.TARGET && pr.head.sha === e.HEAD && pr.base.sha === e.BASE &&
    base.object.sha === e.BASE && pr.mergeable === true && pr.merge_commit_sha === e.MERGE &&
    merge.sha === e.MERGE && merge.parents.length === 2 && merge.parents[0].sha === e.BASE && merge.parents[1].sha === e.HEAD &&
    compare.merge_base_commit.sha === e.BASE && ["ahead", "identical"].includes(compare.status) &&
    e.TESTED === {head: e.HEAD, base: e.BASE, merge: e.MERGE}[e.CHECKOUT]);
  fs.appendFileSync(e.GITHUB_OUTPUT, "tested=" + e.TESTED + "\n");
}
main().catch(() => { console.error("The approved CI candidate changed or could not be authenticated"); process.exitCode = 1; });
NODE`;

/** Admit only a suite whose existing jobs can be shared without changing
 * their test steps, runner settings, names or non-dispatch checkout. */
export function renderPilotWorkflow(original, p) {
  const yml = parseWorkflow(original);
  const top = ["name", "on", "permissions", "jobs", "concurrency", "env", "defaults", "cache-mode"];
  if (!yml || Object.keys(yml).some(key => !top.includes(key)) || typeof yml.name !== "string" ||
      !Object.hasOwn(yml.on ?? {}, "pull_request") || !yml.jobs || !Object.keys(yml.jobs).length ||
      Object.keys(yml.jobs).length > 20 || !isDeepStrictEqual(yml.permissions, { contents: "read" }) ||
      yml["cache-mode"] && yml["cache-mode"] !== "none" || /\b(?:secrets|github\s*\.\s*token)\b/i.test(original)) unsupported("triggers, jobs or permissions");
  if (Object.hasOwn(yml.on, "workflow_dispatch") || Object.hasOwn(yml.on, "workflow_call") ||
      Object.hasOwn(yml.jobs, guardId)) unsupported("the selected suite must have its own workflow");
  const runsOn = /^(?:ubuntu-(?:latest|24\.04(?:-arm)?|22\.04)|macos-(?:latest|14|15|26)|windows-(?:latest|2022|2025))$/;
  const action = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_./-]+)?@[a-f0-9]{40}$/;
  const refFor = { head: "github.event.pull_request.head.sha", base: "github.event.pull_request.base.sha", merge: "github.sha" }[p.checkout];
  const jobs = [];
  const actions = new Set();
  // Qualification teams may turn off the selector while restoring ordinary CI.
  const selected = [
    pull, `vars.${CI_VARIABLE} == 'enabled'`, `github.event.pull_request.base.ref == '${p.base}'`,
    `github.event.pull_request.head.repo.id == ${p.repositoryId}`, `startsWith(github.event.pull_request.head.ref, '${CI_BRANCH_PREFIX}')`,
  ].join(" && ");
  const dispatchGate = [dispatch, `github.ref == 'refs/tags/${p.ref}'`, "github.ref_protected",
    `github.repository_id == '${p.repositoryId}'`, `github.actor_id == '${p.roles.dispatcher.actorId}'`, attemptOne,
    "github.workflow_sha == inputs.revision", "github.sha == inputs.revision"].join(" && ");
  for (const [id, job] of Object.entries(yml.jobs)) {
    const name = job?.name ?? id;
    const allowed = ["name", "runs-on", "timeout-minutes", "steps", "env", "defaults"];
    if (!/^[a-zA-Z_][\w-]*$/.test(id) || typeof name !== "string" || !name.trim() || name.length > 100 ||
        /[\x00-\x1f$]/.test(name) || name === checkContext || jobs.includes(name) ||
        !job || Object.keys(job).some(k => !allowed.includes(k)) || !runsOn.test(job["runs-on"]) ||
        !Array.isArray(job.steps) || !job.steps.length) unsupported("selected jobs must be unconditional, statically named GitHub-hosted jobs");
    const [checkout, ...steps] = job.steps;
    if (!/^actions\/checkout@[a-f0-9]{40}$/.test(checkout?.uses ?? "") ||
        checkout.if !== undefined || checkout["continue-on-error"] !== undefined ||
        Object.keys(checkout.with ?? {}).some(k => !["fetch-depth", "persist-credentials", "ref"].includes(k)) ||
        checkout.with?.["persist-credentials"] !== false ||
        (p.checkout === "merge" ? checkout.with.ref !== undefined && checkout.with.ref !== expression(refFor) : checkout.with.ref !== expression(refFor)))
      unsupported("the first step must pin checkout and preserve approved checkout semantics");
    for (const step of job.steps) {
      if (!step || step.if !== undefined || step["continue-on-error"] !== undefined || step.uses && !action.test(step.uses) ||
          step !== checkout && step.uses?.startsWith("actions/checkout@")) unsupported("steps require pinned actions and strict outcomes");
      if (step.uses) actions.add(step.uses);
    }
    if (!steps.some(step => typeof step.run === "string" && step.run.trim())) unsupported("the suite must run its selected tests directly");
    jobs.push(name);
    job.needs = guardId;
    job.if = expression(`!cancelled() && ((${dispatch} && needs.${guardId}.result == 'success') || (${event} != 'workflow_dispatch' && !(${selected})))`);
    job.steps = [{ ...checkout, with: { ...checkout.with,
      ref: expression(`${dispatch} && needs.${guardId}.outputs.tested || ${refFor}`) } },
    { name: "Confirm dispatch checkout", if: expression(dispatch), shell: "bash",
      env: { TESTED: expression(`needs.${guardId}.outputs.tested`) }, run: 'test "$(git rev-parse HEAD)" = "$TESTED"' }, ...steps];
  }
  yml.on.workflow_dispatch = { inputs: Object.fromEntries(inputs.map(key => [key, { required: true, type: "string" }])) };
  yml["run-name"] = expression(`${dispatch} && format('Post-review CI {0}', inputs.request) || (${pull} && format('PR CI #{0} base {1} merge {2}', github.event.pull_request.number, github.event.pull_request.base.sha, github.sha)) || github.event.head_commit.message || github.ref`);
  // The protected tag gives dispatches a distinct cache scope. An explicit
  // disabled cache token also prevents writes from the tested process.
  yml["cache-mode"] = "none";
  yml.jobs = { [guardId]: {
    name: expression(`${dispatch} && format('Verify candidate {0} review {1}', inputs.tested, inputs.review) || '${inactiveGuardJob}'`),
    if: expression(dispatchGate), "runs-on": "ubuntu-24.04", "timeout-minutes": 2,
    permissions: { contents: "read", "pull-requests": "read" },
    outputs: { tested: expression("steps.candidate.outputs.tested") },
    steps: [{ id: "candidate", shell: "bash", env: {
      GH_TOKEN: expression("github.token"), TARGET: p.base, PREFIX: CI_BRANCH_PREFIX, REPO_ID: String(p.repositoryId),
      AUTHOR: String(p.roles.author.actorId), REVIEWER: String(p.reviewerId), CHECKOUT: p.checkout,
      ...Object.fromEntries(inputs.filter(key => key !== "revision").map(key => [key.toUpperCase(), expression(`inputs.${key}`)])),
    }, run: validateCandidate }],
  }, ...yml.jobs };
  return { text: require("yaml").stringify(yml, { lineWidth: 0 }), jobs, actions: [...actions].sort(), workflowName: yml.name };
}

export function verifyPilotWorkflow(original, installed, p) {
  const rendered = renderPilotWorkflow(original, p);
  if (!isDeepStrictEqual(parseWorkflow(installed), parseWorkflow(rendered.text)))
    throw deferredCIError("The installed workflow differs from the reviewed transformation. Inspect its exact diff and revise the setup.", "CI_DRIFT");
  return { jobs: rendered.jobs, actions: rendered.actions, workflowName: rendered.workflowName, workflowDigest: reviewDigest(installed) };
}
