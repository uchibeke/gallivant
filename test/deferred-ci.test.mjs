import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { runInNewContext } from "node:vm";
import { makeState } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { selectReviewPolicy, reviewBinding } from "../lib/review_policy.mjs";
import { normalizeEvent } from "../lib/hosts/github.mjs";
import { renderPilotWorkflow, verifyPilotWorkflow, candidateJob, checkContext, requestName } from "../lib/hosts/github_ci_workflow.mjs";
import { githubDeferredCI } from "../lib/hosts/github_deferred_ci.mjs";
import { deferredCIService } from "../lib/deferred_ci.mjs";
import { maintainDeferredCI } from "../lib/deferred_ci_run.mjs";
import { scheduledEntry } from "../lib/recovery_schedule.mjs";
import { bindPlanOperator } from "../lib/operator_intent.mjs";
import { taskPresentation } from "../lib/tracker/presentation.mjs";
import { normalizePublicBody } from "../lib/block.mjs";
import { at, checkRun, CONFIG, fakeGh, fakeGit, fakeNotify, fakeRunner, GOOD_PRD, makeClock, prFixture, seededState, silentLog, T0 } from "./helpers.mjs";
import { RECEIPT_TAG } from "../lib/deliverable.mjs";

const base = "a".repeat(40), head = "b".repeat(40), merge = "c".repeat(40), revision = "d".repeat(40);
const branch = "review-ci/owned-task";
const proposal = {
  version: 1, repo: "acme/widget", repositoryId: 7, base: "main", workflow: ".github/workflows/browser.yml", workflowId: 9,
  originalRevision: "e".repeat(40), revision, ref: "review-ci-dispatch-browser", checkout: "merge", reviewerId: 101,
  checksRuleset: 11, enrollmentRuleset: 12, dispatchRuleset: 13, roles: {
    author: { appId: 21, actorId: 201 }, dispatcher: { appId: 22, actorId: 202 },
    reporter: { appId: 23 }, enroller: { appId: 24 },
  },
};
const original = `name: Browser
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]
  release:
    types: [published]
  schedule:
    - cron: '0 4 * * *'
permissions:
  contents: read
jobs:
  browser:
    name: Browser suite
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${"f".repeat(40)}
        with:
          persist-credentials: false
      - run: npm run test:ui
`;

test("the selected workflow keeps its automatic events and shares the original checkout and tests", () => {
  for (const semantics of ["merge", "head", "base"]) {
    const p = { ...proposal, checkout: semantics }, field = `github.event.pull_request.${semantics}.sha`;
    const source = semantics === "merge" ? original : original.replace("persist-credentials: false", `persist-credentials: false\n          ref: \${{ ${field} }}`);
    const rendered = renderPilotWorkflow(source, p), generated = parse(rendered.text);
    const jobs = generated.jobs, selected = jobs.browser, gate = jobs.review_ci_candidate;
    assert.deepEqual(Object.fromEntries(Object.entries(generated.on).filter(([key]) => key !== "workflow_dispatch")), parse(source).on);
    assert.equal(Object.hasOwn(generated, "concurrency"), false);
    assert.equal(selected.name, "Browser suite");
    assert.equal(selected.steps.at(-1).run, "npm run test:ui");
    assert.equal(selected.steps[0].with["persist-credentials"], false);
    assert.ok(selected.steps[0].with.ref.includes(`|| ${semantics === "merge" ? "github.sha" : field}`));
    assert.match(selected.if, /needs.review_ci_candidate.result == 'success'/);
    assert.match(selected.if, /CI_AFTER_REVIEW.*startsWith/);
    assert.match(gate.if, /github.actor_id == '202'.*github.run_attempt == 1.*github.workflow_sha == inputs.revision/);
    assert.equal(generated["cache-mode"], "none");
    assert.deepEqual(generated.permissions, { contents: "read" });
    assert.equal(verifyPilotWorkflow(source, rendered.text, p).workflowName, "Browser");
    assert.throws(() => verifyPilotWorkflow(source, rendered.text.replace("github.ref_protected", "true"), p), { code: "CI_DRIFT" });
  }
  assert.throws(() => renderPilotWorkflow(original.replace(/@f{40}/, "@v4"), proposal), { code: "CI_UNSUPPORTED" });
  assert.throws(() => renderPilotWorkflow(original.replace("run: npm", "continue-on-error: true\n        run: npm"), proposal), { code: "CI_UNSUPPORTED" });
});

test("dispatch concurrency isolates runs and attempts on the shared tag without changing automatic grouping", () => {
  const source = original + "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: true\n";
  const rendered = renderPilotWorkflow(source, proposal);
  const generated = parse(rendered.text);
  assert.deepEqual(generated.concurrency, {
    group: "${{ github.event_name == 'workflow_dispatch' && format('post-review-ci:{0}:{1}', github.run_id, github.run_attempt) || (format('{0}-{1}', github.workflow, github.ref)) }}",
    "cancel-in-progress": "${{ github.event_name != 'workflow_dispatch' }}",
  });
  assert.equal(verifyPilotWorkflow(source, rendered.text, proposal).workflowName, "Browser");
  const sharedGroup = rendered.text.replace(generated.concurrency.group, parse(source).concurrency.group);
  assert.throws(() => verifyPilotWorkflow(source, sharedGroup, proposal), { code: "CI_DRIFT" });
});

test("dispatch concurrency preserves automatic literal, expression and queue settings", () => {
  const render = concurrency => parse(renderPilotWorkflow(original + concurrency + "\n", proposal).text).concurrency;
  assert.match(render("concurrency: Don't deploy {prod}"), /\|\| \('Don''t deploy \{prod\}'\) \}\}$/);
  assert.deepEqual(render("concurrency:\n  group: ${{ github.head_ref || github.ref }}\n  queue: max\n  cancel-in-progress: false"), {
    group: "${{ github.event_name == 'workflow_dispatch' && format('post-review-ci:{0}:{1}', github.run_id, github.run_attempt) || (github.head_ref || github.ref) }}",
    queue: "max",
    "cancel-in-progress": false,
  });
  const templated = render("concurrency:\n  group: Team's {CI} ${{ format('v {{}} {0}', github.ref) }} done\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  assert.match(templated.group, /format\('Team''s \{\{CI\}\} \{0\} done', format\('v \{\{\}\} \{0\}', github\.ref\)\)/);
  assert.equal(templated["cancel-in-progress"], "${{ github.event_name != 'workflow_dispatch' && (github.event_name == 'pull_request') }}");
});

test("dispatch workflow rendering rejects unsupported concurrency settings", () => {
  for (const concurrency of [
    "concurrency: [group]",
    "concurrency: ${{ github.ref",
    "concurrency:\n  group: valid\n  cancel-in-progress: str-${{ true }}",
    "concurrency:\n  group: valid\n  queue: max\n  cancel-in-progress: true",
  ]) {
    assert.throws(() => renderPilotWorkflow(original + concurrency + "\n", proposal), { code: "CI_UNSUPPORTED" });
  }
});

test("the generated candidate step admits only the current exact approval, head, base and test merge", async () => {
  const shell = parse(renderPilotWorkflow(original, proposal).text).jobs.review_ci_candidate.steps[0].run;
  const code = shell.split("\n").slice(1, -1).join("\n");
  const responses = {
    "pulls/142": { number: 142, state: "open", draft: false, user: { id: 201 }, created_at: T0, mergeable: true, merge_commit_sha: merge,
      head: { repo: { id: 7 }, ref: branch, sha: head }, base: { repo: { id: 7 }, ref: "main", sha: base } },
    "git/ref/heads/main": { object: { sha: base } },
    [`compare/${base}...${head}`]: { status: "ahead", merge_base_commit: { sha: base } },
    [`git/commits/${merge}`]: { sha: merge, parents: [{ sha: base }, { sha: head }] },
    "pulls/142/reviews?per_page=100": [{ id: 8, user: { id: 101 }, commit_id: head, submitted_at: at(1), state: "APPROVED" }],
  };
  const run = async changes => {
    const output = [];
    const process = { env: { GITHUB_REPOSITORY: "acme/widget", GITHUB_OUTPUT: "/test/output", GH_TOKEN: "fixture",
      PR: "142", REVIEW: "8", REQUEST: "20260000-1000-1000-1000-202600000000", BRANCH: branch, PREFIX: "review-ci/",
      HEAD: head, BASE: base, MERGE: merge, TESTED: merge, TARGET: "main", REPO_ID: "7", AUTHOR: "201", REVIEWER: "101", CHECKOUT: "merge" } };
    await runInNewContext(code, { process, AbortSignal, console: { error() {} },
      require: () => ({ appendFileSync: (_, text) => output.push(text) }),
      fetch: async url => ({ ok: true, json: async () => ({ ...responses, ...changes })[url.split("/acme/widget/")[1]] }),
    });
    return [process.exitCode ?? 0, output];
  };
  assert.deepEqual(await run(), [0, [`tested=${merge}\n`]]);
  assert.deepEqual(await run({ "git/ref/heads/main": { object: { sha: head } } }), [1, []]);
  assert.deepEqual(await run({ "pulls/142/reviews?per_page=100": [{ ...responses["pulls/142/reviews?per_page=100"][0], state: "DISMISSED" }] }), [1, []]);
  assert.deepEqual(await run({ [`git/commits/${merge}`]: { sha: merge, parents: [{ sha: head }, { sha: base }] } }), [1, []]);
});

const repository = { id: proposal.repositoryId, full_name: proposal.repo };
const runRow = (request, patch = {}) => ({ id: 999, run_attempt: 1, actor: { id: 202 }, repository, head_repository: repository,
  event: "workflow_dispatch", workflow_id: proposal.workflowId, head_sha: revision, path: proposal.workflow,
  head_branch: proposal.ref, html_url: "https://github.com/acme/widget/actions/runs/999",
  status: "completed", conclusion: "success", created_at: request.requestedAt, display_title: requestName(request.id), ...patch });
const job = (id, name, conclusion = "success", attempt = 1) => ({ id, name, conclusion, status: "completed", run_id: 999, run_attempt: attempt, head_sha: revision });

test("Actions correlation is exact and requires actual first-attempt successes and an authenticated App check", async () => {
  const request = { id: "20fbe108-814f-4a47-8474-e55243db289e", requestedAt: at(5) };
  const row = runRow(request);
  let runs = [runRow(request, { actor: { id: 23 } }), runRow(request, { head_sha: head }), row];
  let checks = [{ id: 12, app: { id: 22 }, head_sha: merge, name: checkContext, conclusion: "success", external_id: "saved-request" }];
  const host = githubDeferredCI({ read: async (_repo, path) => path.includes("check-runs")
    ? { total_count: checks.length, check_runs: checks } : { total_count: runs.length, workflow_runs: runs } });
  assert.equal((await host.findRun(proposal, request)).id, row.id);
  runs.push({ ...row, id: 1000, html_url: "https://github.com/acme/widget/actions/runs/1000" });
  await assert.rejects(host.findRun(proposal, request), /More than one Actions run/);
  assert.equal(await host.reportProof(proposal, { merge }, "saved-request"), null);
  checks.push({ ...checks[0], id: 13, app: { id: 23 } });
  assert.equal((await host.reportProof(proposal, { merge }, "saved-request")).id, 13);
  const jobs = ["Browser suite"], options = { reviewId: 8 }, verify = job(1, candidateJob(merge, 8));
  assert.equal(host.suite(proposal, jobs, row, [verify, job(2, jobs[0])], merge, options).ok, true);
  for (const result of ["neutral", "skipped", "failure"])
    assert.equal(host.suite(proposal, jobs, row, [verify, job(2, jobs[0], result)], merge, options).ok, false);
  assert.equal(host.suite(proposal, jobs, { ...row, run_attempt: 2 }, [verify, job(2, jobs[0])], merge, options).ok, false);
  assert.equal(host.suite(proposal, jobs, row, [job(1, candidateJob(head, 8)), job(2, jobs[0])], merge, options).ok, false);
});

function pilotWorld() {
  const config = { ...CONFIG, repos: [{ repo: "acme/widget", base: "main", ci_timing: "after-review" }], reviewer: { ...CONFIG.reviewer, login: "reviewer[bot]" } };
  const reviewPolicy = selectReviewPolicy(config, "acme/widget");
  const session = "6f1c2d3e-1111-4111-8111-111111111111";
  const prd = "docs/prds/widget-export.md";
  const setup = renderPilotWorkflow(original, proposal);
  const approval = { proposal, phase: "active", generation: 4, digest: "1".repeat(64), launch: "2".repeat(64), authorRoute: "3".repeat(64),
    rules: { original: "rules", lockDigest: "locks" }, reports: {}, ...verifyPilotWorkflow(original, setup.text, proposal) };
  const originalCI = checkRun({ name: "Browser / Browser suite", conclusion: "SKIPPED" });
  const pr = prFixture({ headRefOid: head, headRefName: branch, baseRefOid: base, statusCheckRollup: [originalCI] });
  const { home, state, id } = seededState({ harness: "codex", branch, session, reviewPolicy,
    ciTiming: { version: 1, timing: "after-review", revision: approval.digest, reviewerId: 101 },
    cursor: { since: T0, fixed_sha: head, checks_sha: head, dispatched: [] },
  });
  pr.body = normalizePublicBody(pr.body, { identity: { prd, harness: "codex", session, branch }, taskId: id });
  approval.enrollments = { [id]: { branch, head: base, revision: approval.digest, status: "enrolled", at: T0 } };
  writeJsonAtomic(state.file, { ...state.load(), ciPilot: approval });
  const clock = makeClock(at(5)), gh = fakeGh({ pr }), requests = [], cancellations = [];
  gh.containsCommit = async () => true;
  const candidate = { number: pr.number, url: pr.url, branch, head, base, merge, tested: merge, mergeProved: true,
    createdAt: T0, draft: false, state: "open", author: 201 };
  const observation = { row: null, jobs: [], check: null, duringSubmit: null, disabled: false, writes: 0 };
  const transport = {
    configuration: async () => ({ ...approval.rules, reportRequired: true, enabled: !observation.disabled }),
    ref: async () => ({ object: { sha: base } }),
    candidate: async () => ({ ...candidate }),
    findRun: async () => observation.row,
    jobs: async () => observation.jobs,
    suite: githubDeferredCI({}).suite,
    verifiedRunUrl: (_p, id) => `https://github.com/acme/widget/actions/runs/${id}`,
    reportProof: async () => observation.check,
    api: async (_p, path) => {
      if (path.startsWith("pulls?")) return [{ number: pr.number, head: { repo: repository, ref: branch }, merge_commit_sha: merge }];
      return { type: "file", encoding: "base64", size: Buffer.byteLength(setup.text), content: Buffer.from(setup.text).toString("base64") };
    },
    dispatch: async (_p, request, _candidate, guard) => {
      guard();
      assert.equal(makeState(home).get(id).ciRecords[0].requests.at(-1).status, "submitting");
      requests.push(request);
      return observation.duringSubmit?.();
    },
    report: async (_p, _candidate, _key, url, _description, guard) => {
      await guard();
      observation.writes++;
      observation.check = { id: 18, status: "completed", conclusion: "success", details_url: url };
      return observation.check;
    },
    cancel: async (_p, run, guard) => { guard(); cancellations.push(run); },
  };
  const runner = fakeRunner(clock);
  const isolation = () => ({ registry: state.file, qualified: true, workerExcluded: true, launchDigest: approval.launch, authorRoute: approval.authorRoute, expiresAt: Date.parse(at(100)) });
  const deps = { home, state, config, gh, git: fakeGit(), ownLogin: "me", runnerFor: () => runner,
    readPrd: () => null, clock, notify: fakeNotify(), log: silentLog, deferredCI: deferredCIService({ transport, isolation }) };
  const approve = (id = 8, userId = 101, commit = head) => normalizeEvent({ user: { id: userId, login: "reviewer[bot]", type: "Bot" },
    id, commit_id: commit, submitted_at: at(4), state: "APPROVED", body: "" }, "review");
  return { deps, id, state, approval, pr, gh, clock, observation, requests, cancellations, runner, isolation, approve };
}

test("watching waits for the exact authenticated approval and reconciles a lost reply across restart without another request", async () => {
  const w = pilotWorld();
  let tick = makeTick(w.deps);
  const read = () => w.state.get(w.id);
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciProgress.phase, "review");
  assert.equal(read().reason, null);
  assert.equal(w.requests.length, 0);
  w.gh.data.reviews = [w.approve(8, 102), w.approve(9, 101, base)];
  await tick.tickEntry(w.id, read());
  assert.equal(w.requests.length, 0);
  w.gh.data.reviews = [w.approve()];
  w.observation.duringSubmit = () => { throw Object.assign(new Error("connection lost"), { code: "GH_TRANSPORT" }); };
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciProgress.phase, "submitting");
  assert.equal(w.requests.length, 1);
  assert.equal(read().ciRecords[0].requests[0].review.actor, 101);
  const rereview = read().rereview;
  const binding = read().reviewBinding;
  w.gh.data.pr.statusCheckRollup.push(checkRun({ name: "Lint", conclusion: "SUCCESS" }));
  tick = makeTick({ ...w.deps, state: makeState(w.deps.home) });
  w.clock.advance(6);
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciRecords[0].requests[0].status, "ambiguous", JSON.stringify(read().ciProgress));
  assert.equal(read().ciProgress.phase, "blocked");
  assert.deepEqual(read().rereview, rereview);
  assert.notEqual(read().reviewBinding, binding);
  assert.equal(w.requests.length, 1);
  w.observation.row = runRow(w.requests[0], { status: "in_progress", conclusion: null });
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciProgress.phase, "running");
  assert.equal(read().ciRecords[0].requests[0].workflowSha, revision);
  assert.equal(read().ciRecords[0].binding.tested, merge);
  w.observation.row = runRow(w.requests[0], { conclusion: "failure" });
  w.observation.jobs = [job(1, candidateJob(merge, 8)), job(2, "Browser suite", "failure")];
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciProgress.failure.url, "https://github.com/acme/widget/actions/runs/999/job/2");
  assert.deepEqual(read().reviewObservation.checks.deferredFailure, { run: 999, attempt: 1, job: 2 });
  assert.equal(w.runner.started.length, 0);
  assert.equal(taskPresentation({ entry: read() }).attention.group, "attention");
});

test("authorized terminal retry keeps its original record and cancels the owned late run after closure", async () => {
  const w = pilotWorld(), tick = makeTick(w.deps), read = () => w.state.get(w.id);
  w.gh.data.reviews = [w.approve()];
  w.observation.duringSubmit = () => ({ workflow_run_id: 999 });
  await tick.tickEntry(w.id, read());
  w.observation.row = runRow(w.requests[0], { conclusion: "failure" });
  w.observation.jobs = [job(1, candidateJob(merge, 8)), job(2, "Browser suite", "failure")];
  await tick.tickEntry(w.id, read());
  assert.equal(read().ciProgress.phase, "failed", JSON.stringify(read().ciProgress));
  const input = { action: "retry", revision: w.approval.digest, taskId: w.id, requestId: w.requests[0].id };
  await assert.rejects(w.deps.deferredCI.command(w.deps, {}, input), { code: "PLAN_AUTHORITY" });
  const operator = bindPlanOperator(w.state.file, () => ({ principal: "operator", tenant: "pilot",
    isolation: { ...w.isolation(), expiresAt: Date.now() + 60_000 }, grant: () => "pilot-ci" }));
  await w.deps.deferredCI.command(w.deps, operator, input);
  w.observation.duringSubmit = () => null;
  await tick.tickEntry(w.id, read());
  assert.equal(w.requests.length, 2);
  assert.notEqual(w.requests[0].id, w.requests[1].id);
  assert.equal(read().ciRecords.length, 1);
  assert.equal(read().ciRecords[0].requests.length, 2);
  w.state.update(w.id, { state: "done" });
  assert.equal(scheduledEntry(w.id, read(), { anchors: new Set() }), true);
  w.observation.row = runRow(w.requests[1], { status: "in_progress", conclusion: null });
  await maintainDeferredCI(w.deps, w.id, read());
  await maintainDeferredCI(w.deps, w.id, read());
  assert.deepEqual(w.cancellations, [999]);
  w.observation.row = runRow(w.requests[1], { conclusion: "cancelled" });
  await maintainDeferredCI(w.deps, w.id, read());
  assert.equal(read().ciRecords[0].requests.at(-1).status, "obsolete");
});

test("workflow drift fences dispatch even with an exact review", async () => {
  const w = pilotWorld();
  w.observation.disabled = true;
  w.gh.data.reviews = [w.approve()];
  await makeTick(w.deps).tickEntry(w.id, w.state.get(w.id));
  assert.equal(w.state.get(w.id).ciProgress.phase, "blocked");
  assert.equal(w.requests.length, 0);
  assert.equal(w.observation.writes, 0);
});

test("a successful run needs the reporting App observation and the full delivery gate before readiness", async () => {
  const w = pilotWorld(), read = () => w.state.get(w.id);
  const receipt = { task_id: w.id, output_type: "code",
    summary: "Added the export endpoint and browser control with verified output for populated and empty tables, including consistent formatting and safe downloads.",
    criteria_attestations: ["ac-1", "ac-2"].map(criterion_id => ({ criterion_id, met: true, evidence: "test/export.test.mjs" })),
  };
  w.gh.data.pr.body = normalizePublicBody(w.pr.body + "\n```" + RECEIPT_TAG + "\n" + JSON.stringify(receipt) + "\n```\n",
    { identity: { prd: read().prd, harness: read().harness, session: read().session, branch }, taskId: w.id });
  w.gh.data.reviews = [w.approve()];
  const config = { ...w.deps.config, deliverable: { ...CONFIG.deliverable, evaluator: "local" } };
  const tick = makeTick({ ...w.deps, config, readPrd: () => GOOD_PRD });
  await tick.tickEntry(w.id, read());
  w.observation.row = runRow(w.requests[0]);
  w.observation.jobs = [job(1, candidateJob(merge, 8)), job(2, "Browser suite")];
  await tick.tickEntry(w.id, read());
  assert.equal(read().state, "pr-open");
  assert.equal(w.observation.writes, 1);
  await tick.tickEntry(w.id, read());
  assert.equal(read().state, "ready-for-human", read().last?.event);
  assert.equal(read().completionEvidence.delivery.checks.ci.tested, merge);
  assert.equal(read().completionEvidence.delivery.checks.ci.check, 18);
  assert.equal(read().review_readiness.binding, reviewBinding(w.gh.data.pr, read().reviewPolicy));
  w.observation.row = runRow(w.requests[0], { run_attempt: 2 });
  await tick.tickEntry(w.id, read());
  assert.equal(read().state, "pr-open");
});
