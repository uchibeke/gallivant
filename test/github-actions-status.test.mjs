import { test } from "node:test";
import assert from "node:assert/strict";
import { github } from "../lib/hosts/github.mjs";
import { ACTIONS_STATUS_LIMITS } from "../lib/hosts/github_actions_status.mjs";
import { deriveEvents, isGreen, makeTrust } from "../lib/events.mjs";
import { makeTick } from "../lib/tick.mjs";
import { CONFIG, T0, at, makeClock, prFixture, seededState, fakeGh, fakeGit, fakeRunner, fakeCredential, fakeIdentity, fakeNotify, silentLog, STATES } from "./helpers.mjs";

const REPO = "acme/widget", HEAD = "a".repeat(40), BASE = "b".repeat(40), RUN = 43824743815;
const url = id => `https://github.com/${REPO}/actions/runs/${id}`;
const context = (over = {}) => ({ __typename: "StatusContext", id: "status-1", context: "Release branch order", state: "PENDING", startedAt: at(2), targetUrl: url(RUN), ...over });
const workflow = (id = RUN, over = {}) => ({ id, repository: { id: 123, full_name: REPO }, html_url: url(id),
  head_sha: BASE, event: "pull_request_target", status: "completed", conclusion: "failure", run_attempt: 1,
  created_at: at(0), run_started_at: at(1), updated_at: at(5), ...over });
function world({ check = context(), record = id => workflow(id), state = "OPEN" } = {}) {
  const clock = makeClock(at(6)), calls = [], logs = [];
  const pr = { ...prFixture({ headRefOid: HEAD, state }), statusCheckRollup: Array.isArray(check) ? check : [check] };
  const client = github.create({ clock, credential: async () => ({ host: "github.com", token: "selected-fixture-credential" }), log: { warn: message => logs.push(message) },
    exec: async (cmd, args, options) => {
      assert.equal(cmd, "gh");
      if (args[0] === "pr" && args[1] === "view") return { stdout: JSON.stringify(pr) };
      if (args[0] === "pr" && args[1] === "edit") { pr.body = args[args.indexOf("--body") + 1]; return { stdout: "" }; }
      const route = args.find(value => typeof value === "string" && value.startsWith(`repos/${REPO}/actions/runs/`));
      assert.ok(route, `unexpected API command ${args.join(" ")}`);
      assert.deepEqual(args, ["api", "--hostname", "github.com", route]);
      assert.equal(options.env.GH_TOKEN, "selected-fixture-credential");
      assert.equal(options.timeout, ACTIONS_STATUS_LIMITS.timeoutMs);
      const id = Number(route.split("/").at(-1)); calls.push(id);
      return { stdout: JSON.stringify(await record(id)) };
    } });
  return { clock, calls, logs, pr, client, view: () => client.prView(REPO, pr.number) };
}

test("a current pending context exposes authenticated workflow failure without changing its remote state or head", async () => {
  const w = world(), pr = await w.view(), check = pr.statusCheckRollup[0];
  assert.equal(check.state, "PENDING"); assert.equal(check.outcome, "failed"); assert.equal(check.headSha, HEAD);
  assert.equal(check.actionsRun.headSha, BASE, "a base-triggered sweep can fail while publishing status to another PR head");
  assert.equal(check.actionsRun.id, RUN); assert.equal(check.failureSource, "github-actions-run");
  assert.equal(check.updatedAt, at(5)); assert.equal(w.pr.statusCheckRollup[0].state, "PENDING");
  assert.equal(isGreen(pr.statusCheckRollup), false);
  assert.equal(check.headSha, HEAD); assert.equal(check.actionsRun.headSha, BASE);
  const entry = { cursor: { since: T0, fixed_sha: HEAD, checks_sha: null, dispatched: [] }, rereview: { at: T0 } };
  const events = deriveEvents({ pr, entry, reviews: [], inline: [], comments: [], trust: makeTrust(CONFIG, "me") }).events;
  assert.deepEqual(events.map(({ kind, name, runId, at: time }) => ({ kind, name, runId, time })),
    [{ kind: "check", name: "Release branch order", runId: String(RUN), time: at(5) }]);
});

test("metadata refresh and ordinary PR reads share the same reconciled checks", async () => {
  const w = world(); await w.view();
  const pr = await w.client.setRecoveryMetadata(REPO, 142, { prd: "docs/prds/widget-export.md", harness: "claude",
    session: "6f1c2d3e-1111-4111-8111-111111111111", branch: w.pr.headRefName });
  assert.equal(pr.statusCheckRollup[0].outcome, "failed"); assert.deepEqual(w.calls, [RUN]);
});

test("terminal workflow failures reach the existing fixer once through the normal adapter seam", async () => {
  const w = world(), { state, id } = seededState({ cursor: { since: T0, fixed_sha: HEAD, checks_sha: null, dispatched: [] } });
  const runner = fakeRunner(w.clock), gh = { ...fakeGh({ pr: w.pr }), prView: w.client.prView, setRecoveryMetadata: w.client.setRecoveryMetadata };
  const tick = makeTick({ config: CONFIG, state, clock: w.clock, gh, runnerFor: () => runner, git: fakeGit(),
    credential: fakeCredential(), identity: fakeIdentity(), ownLogin: "me", readPrd: () => null, log: silentLog, notify: fakeNotify() });
  await tick.tickEntry(id, state.get(id)); await tick.tickEntry(id, state.get(id));
  assert.equal(runner.started.length, 1); assert.equal(state.get(id).state, STATES.prOpen);
  assert.equal(state.get(id).cursor.checks_sha, HEAD); assert.match(runner.started[0].args.at(-1), /Release branch order/);
  assert.deepEqual(w.calls, [RUN]);
});

test("every recognized terminal failure remains red and never grants readiness", async t => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "startup_failure", "error"]) await t.test(conclusion, async () => {
    const w = world({ record: id => workflow(id, { conclusion }) });
    const pr = await w.view(); assert.equal(pr.statusCheckRollup[0].outcome, "failed"); assert.equal(isGreen(pr.statusCheckRollup), false);
  });
});

test("successful, unknown and still-running workflows never turn a pending context green", async t => {
  for (const [status, conclusion] of [["completed", "success"], ["completed", "neutral"], ["completed", "skipped"], ["completed", null],
    ["completed", "unknown"], ["completed", "stale"], ["queued", null], ["in_progress", "failure"], ["waiting", null]]) await t.test(`${status}/${conclusion}`, async () => {
    const w = world({ record: id => workflow(id, { status, conclusion }) });
    const pr = await w.view(); assert.equal(pr.statusCheckRollup[0].outcome, "pending"); assert.equal(isGreen(pr.statusCheckRollup), false);
  });
});

test("foreign, malformed and ambiguous URLs are never fetched", async t => {
  for (const targetUrl of ["https://example.com/acme/widget/actions/runs/123", "https://github.com/other/repo/actions/runs/123",
    "http://github.com/acme/widget/actions/runs/123", "https://user@github.com/acme/widget/actions/runs/123", "https://github.com:443/acme/widget/actions/runs/123",
    `${url(RUN)}?redirect=other`, `${url(RUN)}#fragment`, "https://github.com/acme/widget/actions/runs/01", "https://github.com/acme/widget/actions/runs/999999999999999999999",
    "https://github.com/acme/widget/../widget/actions/runs/123", "https://github.com/acme/widget/actions/runs/%31%32%33"]) await t.test(targetUrl, async () => {
    const w = world({ check: context({ targetUrl }) }), pr = await w.view();
    assert.equal(pr.statusCheckRollup[0].outcome, "pending"); assert.deepEqual(w.calls, []);
  });
});

test("stale, contradictory and unbound API records retain pending", async t => {
  for (const [name, patch] of Object.entries({ id: { id: RUN + 1 }, repository: { repository: { id: 123, full_name: "other/repo" } },
    "repository-id": { repository: { id: null, full_name: REPO } }, url: { html_url: "https://github.com/other/repo/actions/runs/123" },
    head: { head_sha: "short" }, attempt: { run_attempt: 0 }, "invalid-status": { status: ["completed"] },
    "invalid-conclusion": { conclusion: ["failure"] }, "invalid-time": { updated_at: "invalid" },
    "future-time": { updated_at: at(8) }, "before-status": { updated_at: at(1) }, "newer-attempt": { run_attempt: 2, run_started_at: at(3) },
    "reversed-time": { run_started_at: at(-1) } })) await t.test(name, async () => {
    const w = world({ record: id => workflow(id, patch) }), pr = await w.view();
    assert.equal(pr.statusCheckRollup[0].outcome, "pending"); assert.equal(isGreen(pr.statusCheckRollup), false);
  });
  const explicitAttempt = world({ check: context({ targetUrl: `${url(RUN)}/attempts/1` }), record: id => workflow(id, { run_attempt: 2 }) });
  assert.equal((await explicitAttempt.view()).statusCheckRollup[0].outcome, "pending");
});

test("cache refresh notices reruns and source errors do not hide or weaken pending checks", async () => {
  let record = workflow();
  const w = world({ record: () => record });
  assert.equal((await w.view()).statusCheckRollup[0].outcome, "failed"); await w.view(); assert.equal(w.calls.length, 1);
  w.clock.advance(2); record = workflow(RUN, { status: "in_progress", conclusion: null, run_attempt: 2, run_started_at: at(7), updated_at: at(7) });
  assert.equal((await w.view()).statusCheckRollup[0].outcome, "pending"); assert.equal(w.calls.length, 2);
  const errors = world({ record: () => { throw new Error("HTTP 403 selected-fixture-credential"); } });
  assert.equal((await errors.view()).statusCheckRollup[0].outcome, "pending"); await errors.view();
  assert.equal(errors.calls.length, 1); assert.equal(errors.logs.length, 1);
  assert.doesNotMatch(errors.logs.join(" "), /selected-fixture-credential/);
});

test("bounded rotating reads qualify every context without duplicate reads for one workflow", async () => {
  const checks = Array.from({ length: 10 }, (_, i) => context({ id: `status-${i}`, context: `context-${i}`, targetUrl: url(RUN + i) }));
  const w = world({ check: checks });
  assert.equal((await w.view()).statusCheckRollup.filter(c => c.outcome === "failed").length, ACTIONS_STATUS_LIMITS.reads);
  assert.equal(w.calls.length, ACTIONS_STATUS_LIMITS.reads);
  await w.view(); const final = await w.view();
  assert.equal(final.statusCheckRollup.every(c => c.outcome === "failed"), true);
  assert.equal(w.calls.length, 10); assert.equal(new Set(w.calls).size, 10);
  const shared = world({ check: checks.map(c => ({ ...c, targetUrl: url(RUN) })) });
  assert.equal((await shared.view()).statusCheckRollup.every(c => c.outcome === "failed"), true); assert.equal(shared.calls.length, 1);
});

test("returned diagnostic evidence cannot mutate the authenticated workflow cache", async () => {
  const w = world(), first = await w.view(); first.statusCheckRollup[0].actionsRun.conclusion = "success";
  assert.equal((await w.view()).statusCheckRollup[0].outcome, "failed"); assert.equal(w.calls.length, 1);
});

test("closed PRs, ordinary check runs and already-final status contexts do not incur enrichment reads", async () => {
  for (const state of ["MERGED", "CLOSED"]) { const w = world({ state }); await w.view(); assert.deepEqual(w.calls, []); }
  for (const check of [context({ state: "SUCCESS" }), context({ state: "FAILURE" }), context({ startedAt: undefined }),
    { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, detailsUrl: url(RUN), startedAt: at(2) }]) {
    const w = world({ check }); await w.view(); assert.deepEqual(w.calls, []);
  }
});
