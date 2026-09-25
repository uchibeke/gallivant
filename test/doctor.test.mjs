// The ruleset check, which is the only doctor check that speaks for a security control rather than for a config
// value. Section 6.11 of the spec credits "no push to the default branch, no force push" to a GitHub ruleset, so a
// check that passes on an unprotected default branch is worse than no check: it reports a control that is not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { protectsDefaultBranch } from "../lib/commands/doctor.mjs";

const gh = (branch = "main") => ({ repoDefaultBranch: async () => branch });

/** The shape `gh api repos/<r>/rulesets` returns, narrowed to the fields the check reads. */
const ruleset = (over = {}) => ({
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
  bypass_actors: [],
  ...over,
});

test("a ruleset protecting the default branch passes and names the branch it verified", async () => {
  const v = await protectsDefaultBranch(gh(), "acme/widget", [ruleset()]);
  assert.equal(v.ok, true);
  assert.match(v.detail, /default branch \(main\)/);
  assert.match(v.detail, /force pushes blocked/);
});

test("an active ruleset on some other branch does not count as protecting the default branch", async () => {
  // The bug this check exists for: `rs.some(r => r.enforcement === "active")` passed here while main sat open.
  const release = ruleset({ conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } } });
  const v = await protectsDefaultBranch(gh(), "acme/widget", [release]);
  assert.equal(v.ok, false);
  assert.match(v.detail, /none targeting the default branch \(main\)/);
});

test("the default branch named explicitly counts, and one excluded by name does not", async () => {
  const byName = ruleset({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } } });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [byName])).ok, true);
  const excluded = ruleset({ conditions: { ref_name: { include: ["~ALL"], exclude: ["~DEFAULT_BRANCH"] } } });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [excluded])).ok, false);
});

test("a ruleset that does not block force pushes or require a pull request is reported as incomplete, not as passing", async () => {
  const noForce = ruleset({ rules: [{ type: "deletion" }, { type: "pull_request" }] });
  const v = await protectsDefaultBranch(gh(), "acme/widget", [noForce]);
  assert.deepEqual([v.ok, /non_fast_forward/.test(v.detail)], [false, true]);
  const noPr = ruleset({ rules: [{ type: "non_fast_forward" }] });
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [noPr])).detail, /pull_request/);
});

test("rules spread across two rulesets on the default branch count together, as GitHub applies them", async () => {
  const force = ruleset({ rules: [{ type: "non_fast_forward" }] });
  const pr = ruleset({ rules: [{ type: "pull_request" }] });
  assert.equal((await protectsDefaultBranch(gh(), "acme/widget", [force, pr])).ok, true);
});

test("a bypass actor fails the check, because a run using that identity is not held by the ruleset", async () => {
  const v = await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin" }] })]);
  assert.deepEqual([v.ok, /bypass actor/.test(v.detail)], [false, true]);
  assert.match(v.fix, /bypass_actors/);
});

test("an inactive or tag-targeted ruleset is not an active branch ruleset", async () => {
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ enforcement: "evaluate" })])).detail, /none is active/);
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [ruleset({ target: "tag" })])).detail, /none is active/);
  assert.match((await protectsDefaultBranch(gh(), "acme/widget", [])).detail, /no active ruleset/);
});

test("when the default branch cannot be read, a ~DEFAULT_BRANCH ruleset still counts and the wording does not invent a name", async () => {
  // `gh repo view` can fail on a token without the scope; the check must not claim a branch name it does not have.
  const blind = { repoDefaultBranch: async () => { throw new Error("HTTP 403"); } };
  const v = await protectsDefaultBranch(blind, "acme/widget", [ruleset()]);
  assert.equal(v.ok, true);
  assert.ok(!v.detail.includes("("), "no parenthesised branch name when the name is unknown");
  const byName = ruleset({ conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } } });
  assert.equal((await protectsDefaultBranch(blind, "acme/widget", [byName])).ok, false, "a name-matched ruleset cannot be confirmed without the name");
});
