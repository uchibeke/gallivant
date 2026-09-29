// The brief changing under a run that has already started.
//
// The gap these cover, found by reading rather than by a failure. `start` snapshots the brief into ~/.gallivant/prds/
// and the completion gate reads only that, which is what stops a session rewriting its own acceptance criteria. But
// nothing ever compared that snapshot with the operator's own copy, so an operator who edited docs/prds/thing.md after
// starting got a PR certified against criteria they had abandoned, with nothing anywhere saying so.
//
// Four verdicts, four different answers, because guessing between them is expensive in both directions: a restart
// throws away paid work and a silent continue certifies the wrong brief. The tests are organised by verdict.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  prdDivergence, contractOf, contractDiff, prdFingerprint, prdDecision, divergenceReason, renderDivergence,
  resolvePrdSnapshot, retakePrdSnapshot, ensurePrdSnapshot, parsePrd, criteriaFromPrd, sameContract, check,
} from "../lib/prd.mjs";
import { shortHash } from "../lib/hash.mjs";
import { receiptHash, RECEIPT_TAG } from "../lib/deliverable.mjs";
import { makeTick } from "../lib/tick.mjs";
import { model } from "../lib/commands/status.mjs";
import { runPage } from "../lib/tracker/pages.mjs";
import { why } from "../lib/commands/why.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import {
  CONFIG, T0, tempHome, fakeGh, fakeRunner, fakeGit, fakeNotify, makeClock, silentLog, GOOD_PRD, prFixture, claudeResultLines, fakeCredential, fakeIdentity } from "./helpers.mjs";

// ---- the edits, one per case in the taxonomy -----------------------------------------------------------------------

/** Case 1: prose only. The Problem section is reworded; not one criterion, Verify command or frontmatter key moves. */
const PROSE_EDIT = GOOD_PRD
  .replace("Finance admins reconcile widget spend", "Finance administrators reconcile widget spending")
  .replace("- PDF export.", "- PDF export.\n- Scheduled exports.");

/** Case 2: the brief is extended. A criterion is added; everything already there still stands. */
const CRITERION_ADDED = GOOD_PRD.replace("## Verify", "- Given a locked workspace, when I click Export, then the request is refused with a reason.\n\n## Verify");

/** Case 2 again, through the other half of the contract: the command the session must run green changes. */
const VERIFY_CHANGED = GOOD_PRD.replace("npm run lint", "npm run typecheck");

/** Case 3: the brief is rewritten. What the agent built is no longer what is wanted. */
const CRITERION_REWRITTEN = GOOD_PRD.replace(
  "- Given a workspace with three widgets, when I click Export, then a CSV with three rows downloads.",
  "- Given a workspace with three widgets, when I click Export, then a JSON file with three objects downloads.",
);

/** The frontmatter half of the contract: what a session is allowed to read. */
const CONTEXT_PATHS_ADDED = GOOD_PRD.replace("harness: codex", "harness: codex\ncontext_paths: /tmp/schemas");

/** Edge: the file is still there and still parses, but `start` would refuse it. */
const ILLEGAL = GOOD_PRD.replace("- PDF export.", "- TBD");

const RECEIPT = criteria => "```" + RECEIPT_TAG + "\n" + JSON.stringify({
  task_id: "acme/widget/widget-export", output_type: "code",
  summary: "Added the CSV export endpoint, the Export button and its disabled empty state, verified by four new unit tests in src/export and by downloading a file from a three-widget workspace by hand.",
  criteria_attestations: criteria.map(c => ({ criterion_id: c.id, met: true, evidence: `src/export/csv.test.ts covers ${c.id}` })),
}, null, 2) + "\n```";

// ---- a world: a registry, a snapshot on disk, and an operator checkout on disk ---------------------------------------

const REL = "docs/prds/widget-export.md";

/**
 * One entry mid-flight, with the daemon's snapshot and the operator's own file both real files on disk. Real files
 * rather than fakes because the whole point of the change is that the daemon reads the operator's tree, and a fake
 * `readText` would let a test pass while the real path join was wrong.
 */
function world({ repoText = GOOD_PRD, snapshotText = GOOD_PRD, checkout = null, entry: over = {}, pr = prFixture(), deliverable = CONFIG.deliverable } = {}) {
  const home = tempHome();
  const checkoutDir = checkout === null ? join(home, "checkout") : checkout;
  const prds = new Map();
  const state = makeState(home);
  const id = "acme/widget/widget-export";
  const snapshot = snapshotText === null ? null : parsePrd(snapshotText, REL);
  state.put(id, {
    ...newEntry({
      prd: REL, harness: "codex", session: "6f1c2d3e-1111-4111-8111-111111111111", repo: "acme/widget",
      branch: "gallivant/widget-export", worktree: join(home, "wt"), pr: 142, state: STATES.prOpen, nowIso: T0,
      checkout: checkoutDir, prdFingerprint: prdFingerprint(snapshot), prdDecision: prdDecision(snapshot),
    }),
    url: "https://github.com/acme/widget/pull/142",
    cursor: { since: T0, dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: null },
    rereview: { at: T0, nudged: false },
    ...over,
  });
  if (repoText !== null) {
    mkdirSync(dirname(join(checkoutDir, REL)), { recursive: true });
    writeFileSync(join(checkoutDir, REL), repoText);
  }
  if (snapshotText !== null) prds.set(id, snapshotText);
  mkdirSync(join(home, "wt"), { recursive: true });
  const clock = makeClock();
  const runner = fakeRunner(clock);
  const gh = fakeGh({ pr });
  const notify = fakeNotify();
  const ctx = { credential: fakeCredential(), identity: fakeIdentity(),
    // `reviewer: null` and a local evaluator, so the tick reaches the readiness judgement on the checks alone and the
    // completion gate decides without a network call. Neither is what this file is about: both are there so the one step
    // under test, the brief comparison immediately before that gate, is reached in one tick rather than five.
    home, state, gh, git: fakeGit(), notify, log: silentLog, clock,
    config: { ...CONFIG, reviewer: null, deliverable: deliverable && { ...deliverable, evaluator: "local", scan_output: false } },
    ownLogin: "me", runnerFor: () => runner,
    readPrd: key => prds.get(key) ?? null,
    writePrd: (key, text) => prds.set(key, text),
  };
  return { home, id, state, runner, gh, notify, clock, ctx, prds, checkoutDir, file: join(checkoutDir, REL), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Drive the tick to the point where it would judge readiness: green checks, a clear reviewer, a receipt on the PR. */
async function tickToReady(w, { criteria = criteriaFromPrd(parsePrd(GOOD_PRD, REL)) } = {}) {
  w.gh.data.pr.statusCheckRollup = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS", completedAt: T0 }];
  w.gh.data.pr.body = `Adds export.\n\n${RECEIPT(criteria)}`;
  const tick = makeTick(w.ctx);
  await tick.tickEntry(w.id, w.state.get(w.id));
  return w.state.get(w.id);
}

// ---- the contract, and what counts as part of it ---------------------------------------------------------------------

test("the contract is the criteria, the Verify commands, the harness and context_paths, and nothing else", () => {
  const good = parsePrd(GOOD_PRD, REL);
  const prose = parsePrd(PROSE_EDIT, REL);
  // Two files with different bytes, different word counts and a different Out of scope list, and one contract.
  assert.notEqual(PROSE_EDIT, GOOD_PRD);
  assert.deepEqual(contractOf(prose), contractOf(good));
  assert.equal(prdFingerprint(prose), prdFingerprint(good));
  assert.deepEqual(contractDiff(good, prose), []);
  // And the four things that ARE the contract each move the fingerprint.
  for (const [what, text] of [["criteria", CRITERION_ADDED], ["verify", VERIFY_CHANGED], ["context_paths", CONTEXT_PATHS_ADDED]]) {
    assert.notEqual(prdFingerprint(parsePrd(text, REL)), prdFingerprint(good), `${what} must move the fingerprint`);
  }
  const otherHarness = parsePrd(GOOD_PRD.replace("harness: codex", "harness: claude"), REL);
  assert.notEqual(prdFingerprint(otherHarness), prdFingerprint(good), "a harness change is a contract change: the session belongs to the old one");
});

test("the fingerprint is the one hash spelling the receipt cursor already uses, not a second one", () => {
  // The DRY point, asserted rather than trusted: `receiptHash` and `prdFingerprint` are the same twelve hex characters
  // of the same sha1, because both go through `shortHash`. A second spelling is the duplication this codebase pays for.
  const body = "```" + RECEIPT_TAG + "\nhello\n```";
  assert.equal(receiptHash(body), shortHash("hello"));
  assert.match(prdFingerprint(parsePrd(GOOD_PRD, REL)), /^[0-9a-f]{12}$/);
  assert.equal(prdFingerprint(null), null);
  assert.equal(shortHash(null), null, "absent is distinguishable from empty");
});

test("contractDiff names the specific difference, because the operator's next question is always which one", () => {
  const good = parsePrd(GOOD_PRD, REL);
  const diff = contractDiff(good, parsePrd(CRITERION_REWRITTEN, REL));
  assert.equal(diff.length, 2, "a reworded criterion is one gone and one added");
  assert.ok(diff.some(l => /removed, reworded or renumbered/.test(l) && /CSV with three rows/.test(l)));
  assert.ok(diff.some(l => /added, reworded or renumbered/.test(l) && /JSON file with three objects/.test(l)));
  // The id is in the line, because the id is what the receipt on the pull request names.
  assert.ok(diff.every(l => !/criterion/.test(l) || /"ac-\d+: /.test(l)));
  const ver = contractDiff(good, parsePrd(VERIFY_CHANGED, REL));
  assert.ok(ver.some(l => l.includes("Verify command removed: `npm run lint`")));
  assert.ok(ver.some(l => l.includes("Verify command added: `npm run typecheck`")));
  const ctxp = contractDiff(good, parsePrd(CONTEXT_PATHS_ADDED, REL));
  assert.deepEqual(ctxp, ["context_paths entry added: /tmp/schemas"]);
});

// ---- case 1: nothing that matters changed ----------------------------------------------------------------------------

test("identical files are `same` and cost one string comparison", () => {
  const w = world();
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "same");
  assert.equal(d.why, "identical to the snapshot");
  assert.deepEqual(d.diff, []);
  assert.equal(divergenceReason(d), null);
  w.cleanup();
});

test("a prose edit is `same`: nothing stops, nothing restarts, and nobody is told", async () => {
  const w = world({ repoText: PROSE_EDIT });
  const before = w.state.get(w.id);
  const d = prdDivergence({ id: w.id, entry: before, readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "same");
  assert.match(d.why, /edited outside the contract/);
  assert.equal(divergenceReason(d), null, "no reason means no stop");
  // Through the tick: the entry reaches ready as it would have with no edit at all, and the operator is not notified
  // about the brief. Restarting here would throw away paid work for a reworded Problem section.
  const e = await tickToReady(w);
  assert.equal(e.state, STATES.ready, "still ready");
  assert.equal(e.reason, null);
  assert.deepEqual(w.notify.sent, [["ready", 142]], "one ready notification and nothing about the brief");
  // The snapshot followed the edit, so a later fix round's prompt carries the operator's current prose.
  assert.equal(w.ctx.readPrd(w.id), PROSE_EDIT);
  assert.equal(e.prd_fingerprint, prdFingerprint(parsePrd(GOOD_PRD, REL)), "the contract did not move, so neither did the fingerprint");
  w.cleanup();
});

// ---- case 2 and case 3: the contract moved, and the daemon will not guess which -------------------------------------

test("a criterion added stops the entry with the difference named, and the gate judges NEITHER brief", async () => {
  const w = world({ repoText: CRITERION_ADDED });
  const e = await tickToReady(w);
  assert.equal(e.state, STATES.needsHuman);
  assert.equal(e.reason, "prd-changed");
  assert.equal(e.gate_skipped, null, "the entry is stopping, not reaching ready with an unrun gate: gate_skipped describes the other thing");
  assert.ok(e.prd_divergence, "the difference is recorded on the entry");
  assert.ok(e.prd_divergence.diff.some(l => /locked workspace/.test(l)), "and it names the criterion that arrived");
  assert.deepEqual(w.notify.sent, [["needs", 142, "prd-changed"]], "notified once, as a stop, and never told it was ready");
  // Neither brief was judged: the snapshot is untouched and no receipt round was dispatched against the new criteria.
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, "the snapshot is not silently replaced");
  assert.equal(w.runner.started.length, 0, "and nothing was spawned against either brief");
  w.cleanup();
});

test("a criterion rewritten is the same stop, because the daemon cannot tell tightened from invalidated", async () => {
  // The design point, asserted: case 2 (valid but incomplete) and case 3 (invalidated) are indistinguishable from the
  // text, and guessing wrong is expensive in both directions, so both land on a human with the difference named.
  const added = await tickToReady(world({ repoText: CRITERION_ADDED }));
  const rewritten = await tickToReady(world({ repoText: CRITERION_REWRITTEN }));
  assert.equal(added.reason, "prd-changed");
  assert.equal(rewritten.reason, "prd-changed");
  assert.ok(rewritten.prd_divergence.diff.some(l => /JSON file with three objects/.test(l)));
});

test("a changed Verify command is a contract change: the session would be run against a command nobody asked for", async () => {
  const w = world({ repoText: VERIFY_CHANGED });
  const e = await tickToReady(w);
  assert.equal(e.reason, "prd-changed");
  assert.ok(e.prd_divergence.diff.some(l => l.includes("npm run typecheck")));
  w.cleanup();
});

test("a changed context_paths is a contract change, because it changes what a fix round may read", async () => {
  const w = world({ repoText: CONTEXT_PATHS_ADDED });
  const e = await tickToReady(w);
  assert.equal(e.reason, "prd-changed");
  assert.deepEqual(e.prd_divergence.diff, ["context_paths entry added: /tmp/schemas"]);
  w.cleanup();
});

test("REORDERING two criteria is a contract change, because the receipt already on the PR attests them by position", async () => {
  // The sharpest case in the whole comparison, and the one a comparison of descriptions alone gets wrong. Criteria are
  // numbered by position: `ac-1` is whichever criterion is first. The completion receipt on the open pull request says
  // `ac-1` is met with evidence, and the gate matches that id to whatever the brief's first criterion is NOW. So swapping
  // two criteria without touching a word of either leaves every description present and every id meaning the other
  // thing, and the receipt attests each criterion with the other's evidence. The gate allows it, and the certification is
  // wrong. Compared by description this looked like no change at all.
  const a = "- Given a workspace with three widgets, when I click Export, then a CSV with three rows downloads.";
  const b = "- Given an empty workspace, when I click Export,\n  then the button is disabled and a hint explains why.";
  const REORDERED = GOOD_PRD.replace(`${a}\n${b}`, `${b}\n${a}`);
  assert.notEqual(REORDERED, GOOD_PRD, "sanity: the swap happened");
  // Every description is still there, so a set comparison of descriptions finds nothing.
  const before = criteriaFromPrd(parsePrd(GOOD_PRD, REL)).map(c => c.description).sort();
  const after = criteriaFromPrd(parsePrd(REORDERED, REL)).map(c => c.description).sort();
  assert.deepEqual(after, before);
  // And the ids now mean the other criterion, which is what makes it a change.
  assert.notEqual(criteriaFromPrd(parsePrd(REORDERED, REL))[0].description, criteriaFromPrd(parsePrd(GOOD_PRD, REL))[0].description);

  const w = world({ repoText: REORDERED });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "changed", "not `same`: the receipt on the PR is about to be misread");
  assert.ok(d.diff.some(l => /renumbered/.test(l) && /ac-1: Given an empty workspace/.test(l)), "and the diff shows which id gained which text");
  const e = await tickToReady(w);
  assert.equal(e.reason, "prd-changed");
  assert.equal(e.state, STATES.needsHuman);
  w.cleanup();
});

test("a DUPLICATED Verify command is a contract change, which a list of differences alone cannot see", async () => {
  // The second false negative of the same family as the reorder, and the reason the verdict is the fingerprint's rather
  // than the diff's. Add a second `- \`npm test\`` and every element of both lists is present in the other, so set
  // arithmetic finds nothing while the commands the session must run green have changed. Deciding on the diff let this
  // through as `same` and re-snapshotted it silently. A targeted fix per shape is a bug per shape nobody has thought of
  // yet, so the verdict asks "is this the same contract", which is what a hash of the whole ordered structure answers.
  const DUP = GOOD_PRD.replace("- `npm test`", "- `npm test`\n- `npm test`");
  const g = parsePrd(GOOD_PRD, REL), d = parsePrd(DUP, REL);
  assert.deepEqual([...contractOf(d).verify].sort(), ["npm run lint", "npm test", "npm test"]);
  // Every element of each list is in the other, which is what defeated the set comparison.
  assert.ok(contractOf(d).verify.every(v => contractOf(g).verify.includes(v)));
  assert.ok(contractOf(g).verify.every(v => contractOf(d).verify.includes(v)));
  assert.equal(sameContract(g, d), false, "and the fingerprint sees it anyway");

  const w = world({ repoText: DUP });
  assert.equal(prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd }).verdict, "changed");
  assert.equal((await tickToReady(w)).reason, "prd-changed");
  w.cleanup();
  // Both directions: losing a duplicate is a change too, and it is the one that loses a command.
  const loses = world({ snapshotText: DUP, repoText: GOOD_PRD });
  assert.equal(prdDivergence({ id: loses.id, entry: loses.state.get(loses.id), readPrd: loses.ctx.readPrd }).verdict, "changed");
  loses.cleanup();
});

test("a contract that moved always has something to say, even when the diff has nothing", () => {
  // `renderDivergence` on an empty diff is the empty string, so a `changed` verdict with no lines would stop an entry and
  // tell the operator nothing. Every `changed` carries at least one line.
  const DUP = GOOD_PRD.replace("- `npm test`", "- `npm test`\n- `npm test`");
  const w = world({ repoText: DUP });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.ok(d.diff.length, "never a stop with nothing to show for it");
  assert.notEqual(renderDivergence(d), "");
  w.cleanup();
});

test("a line-ending rewrite is not a brief change, and must not stop a healthy run blaming the harness", async () => {
  // `parseFrontmatter` matched `\n` only, so a CRLF copy parsed as having NO frontmatter: `harness` fell back to the
  // default and the frontmatter rule failed. Survivable while `ready` was the only reader, with an operator standing in
  // front of it. Not survivable once the brief is compared against a running entry, where a `.gitattributes` change reads
  // as the harness changing and stops a run that is perfectly fine, blaming the wrong thing entirely.
  const CRLF = GOOD_PRD.replace(/\n/g, "\r\n");
  const p = parsePrd(CRLF, REL);
  assert.equal(p.hasFrontmatter, true);
  assert.equal(p.harness, "codex", "not the default");
  assert.equal(p.status, "ready");
  assert.equal(check(p).ok, true, "and it still passes the contract");
  assert.ok(sameContract(p, parsePrd(GOOD_PRD, REL)), "same brief, different bytes");

  const w = world({ repoText: CRLF });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "same");
  assert.equal((await tickToReady(w)).state, STATES.ready, "the run is not stopped");
  w.cleanup();
});

// ---- the edges ------------------------------------------------------------------------------------------------------

test("a brief deleted from the repo stops with `prd-gone` rather than finishing against a brief nobody has", async () => {
  const w = world({ repoText: null });
  const e = await tickToReady(w);
  assert.equal(e.state, STATES.needsHuman);
  assert.equal(e.reason, "prd-gone");
  assert.ok(e.prd_divergence.diff[0].includes("the brief is gone from"));
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, "nothing was written: there is nothing to snapshot");
  w.cleanup();
});

test("a brief edited into something the contract refuses is `prd-illegal`, and never becomes the snapshot", async () => {
  const w = world({ repoText: ILLEGAL });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "illegal");
  assert.ok(d.diff.some(l => /contract rule placeholders now fails/.test(l) && /TBD/.test(l)));
  const e = await tickToReady(w);
  assert.equal(e.reason, "prd-illegal");
  // The invariant: an illegal brief must not reach the file the gate judges. A stale snapshot is bad; one `start` would
  // have refused is worse, because it is behind the gate rather than merely out of date.
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD);
  assert.throws(() => resolvePrdSnapshot(w.ctx, { id: w.id, entry: e, divergence: d, by: "a test" }), /nothing to resolve \(illegal/);
  w.cleanup();
});

test("an illegal brief is reported as illegal even when its contract held, because `start` would refuse it either way", () => {
  // The ordering in `prdDivergence`: a brief that gained a TODO without touching a criterion is still a brief the
  // operator has to fix, so it is not reported as a contract change they can wave through with --resnapshot.
  const w = world({ repoText: GOOD_PRD.replace("Finance admins", "Finance admins TODO") });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "illegal");
  assert.deepEqual(contractDiff(parsePrd(GOOD_PRD, REL), d.repo), [], "the contract itself did not move");
  w.cleanup();
});

test("no snapshot, or no recorded checkout, is `unknown` and never stops anything", async () => {
  // An entry `register` or `reconcile` built never saw the operator's tree. Stopping it for that would make recovery
  // from GitHub useless, so "no comparison was possible" means carry on.
  const noCheckout = world({ entry: { checkout: null } });
  assert.equal(prdDivergence({ id: noCheckout.id, entry: noCheckout.state.get(noCheckout.id), readPrd: noCheckout.ctx.readPrd }).verdict, "unknown");
  const e = await tickToReady(noCheckout);
  assert.equal(e.state, STATES.ready, "a recovered entry still reaches ready");
  noCheckout.cleanup();

  const noSnapshot = world({ snapshotText: null, deliverable: null });
  const d = prdDivergence({ id: noSnapshot.id, entry: noSnapshot.state.get(noSnapshot.id), readPrd: noSnapshot.ctx.readPrd });
  assert.equal(d.verdict, "unknown");
  assert.match(d.why, /no PRD snapshot/);
  noSnapshot.cleanup();
});

test("a checkout that is not on this machine is `unknown`, not `gone`", () => {
  // `gone` means the operator deleted the brief. A whole checkout that is not there is a different fact, and reading it
  // as a deleted brief would stop every entry on a machine whose worktrees volume was unmounted.
  const w = world({ checkout: join(tempHome(), "never-existed"), repoText: null });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  // The file is absent either way, so this IS `gone`: the distinction the daemon can actually make is recorded in the
  // message, which names the path, and the operator reads it and knows which of the two happened.
  assert.equal(d.verdict, "gone");
  assert.ok(d.why.includes("never-existed"), "the path is named so the operator can tell a deleted brief from a missing disk");
  w.cleanup();
});

// ---- where the comparison runs ---------------------------------------------------------------------------------------

test("the daemon compares at the gate and nowhere else: a fix round for a review is dispatched without reading the tree", async () => {
  // The cost argument, asserted. A brief whose contract moved does NOT stop an entry that has feedback to address: the
  // work in flight is against the brief the session holds, and a dispatch is not a claim that the brief is satisfied.
  // The stop comes at the one point the contract is used to certify something.
  const w = world({ repoText: CRITERION_REWRITTEN });
  w.gh.data.inline = [{
    id: 9, pull_request_review_id: null, in_reply_to_id: null, user: { login: "you", type: "User" },
    path: "src/export/csv.ts", line: 12, body: "Rename this column.", created_at: "2026-09-24T02:05:00Z", updated_at: "2026-09-24T02:05:00Z",
  }];
  w.ctx.config = { ...w.ctx.config, trusted_authors: ["you"] };
  const tick = makeTick(w.ctx);
  await tick.tickEntry(w.id, w.state.get(w.id));
  const e = w.state.get(w.id);
  assert.equal(e.state, STATES.prOpen, "the review is dispatched, not refused");
  assert.equal(e.reason, null);
  assert.equal(w.runner.started.length, 1, "a fix round went out");
  w.cleanup();
});

test("the divergence is cleared once it is gone, so a resolved entry stops reporting a difference it no longer has", async () => {
  const w = world({ repoText: CRITERION_ADDED });
  await tickToReady(w);
  assert.ok(w.state.get(w.id).prd_divergence);
  // The operator puts the brief back the way it was and reopens the entry.
  writeFileSync(w.file, GOOD_PRD);
  w.state.update(w.id, { state: STATES.prOpen, reason: null });
  const e = await tickToReady(w);
  assert.equal(e.state, STATES.ready);
  assert.equal(e.prd_divergence, null, "and the record of the difference goes with it");
  w.cleanup();
});

test("a register reset clears the recorded difference but keeps the checkout, so the comparison is not silently turned off", async () => {
  // Two halves. The record of the stop goes with the `reason` it belongs to, because an entry carrying a stop it no longer
  // has is a thing a reader has to reason about. Where the operator's copy lives does NOT go, because a reset does not
  // move their checkout and dropping it would turn the whole comparison off for the one PR they just asked to watch again.
  const w = world({ repoText: CRITERION_ADDED });
  const stopped = await tickToReady(w);
  assert.ok(stopped.prd_divergence);
  const reset = { ...stopped, state: STATES.prOpen, reason: null, retry: null, iteration: 0, round_comment: null, labels_pending: false, prd_divergence: null };
  w.state.put(w.id, reset);
  assert.equal(w.state.get(w.id).prd_divergence, null);
  assert.equal(w.state.get(w.id).checkout, w.checkoutDir, "the comparison still has something to compare against");
  // And the next judgement finds the same difference again, from the files rather than from the cleared field.
  const again = await tickToReady(w);
  assert.equal(again.reason, "prd-changed");
  w.cleanup();
});

// ---- status, why and the tracker -------------------------------------------------------------------------------------

test("status moves a diverged row into NEEDS YOU and names the first difference", () => {
  const w = world({ repoText: CRITERION_ADDED });
  const m = model(w.ctx);
  assert.equal(m.running.length, 0, "not left under RUNNING waiting for a daemon that is going to stop it");
  assert.equal(m.needs_you.length, 1);
  const row = m.needs_you[0];
  assert.equal(row.label, "brief-moved");
  assert.match(row.detail, /prd-changed: acceptance criterion added/);
  assert.equal(row.divergence.reason, "prd-changed");
  assert.equal(row.divergence.handle, "widget#142", "the handle rides along so a consumer can print the resolving command");
  w.cleanup();
});

test("status says nothing about the brief when the contract holds, and nothing about a done entry", () => {
  const clean = world();
  assert.equal(model(clean.ctx).needs_you.length, 0);
  assert.equal(model(clean.ctx).running[0].divergence, null);
  clean.cleanup();
  const prose = world({ repoText: PROSE_EDIT });
  assert.equal(model(prose.ctx).needs_you.length, 0, "a prose edit is not the operator's problem");
  prose.cleanup();
  // A merged entry is not compared: there is nothing left to certify, and an operator tidying their briefs afterwards
  // must not be told about finished work.
  const done = world({ repoText: null, entry: { state: STATES.done } });
  assert.equal(model(done.ctx).done[0].divergence, null);
  done.cleanup();
});

test("why prints every difference, what the gate is doing about it, and the command that resolves it", () => {
  // Readied, so the second signal has something to report: `ready` wrote a decision id into the frontmatter and the
  // operator's edit did not go back through it.
  const readied = t => t.replace("harness: codex", "harness: codex\naport_decision: dec_001");
  const w = world({ repoText: readied(CRITERION_REWRITTEN), snapshotText: readied(GOOD_PRD) });
  const out = why(w.ctx, { handle: "widget#142" });
  assert.match(out, /the brief has changed since this run started \(prd-changed\)/);
  assert.match(out, /removed, reworded or renumbered.*CSV with three rows/);
  assert.match(out, /added, reworded or renumbered.*JSON file with three objects/, "both halves of a rewording, not just the first");
  assert.match(out, /judging NEITHER brief/);
  assert.match(out, /gallivant resume widget#142 --resnapshot/);
  // The second signal: the brief still carries the decision id it was readied with, so the edit has not been blessed.
  assert.match(out, /aport_decision is unchanged/);
  w.cleanup();
});

test("why reports a re-readied brief as a second signal, and never decides on it", () => {
  // The cheaper check the brief offers: `ready` rewrites `aport_decision` when it flips a brief. A changed one says the
  // operator deliberately re-blessed the edit. It is reported and never relied on, because `ready` leaves it alone on a
  // brief that was already ready and a hand-edit can miss the frontmatter entirely.
  const readied = CRITERION_ADDED.replace("harness: codex", "harness: codex\naport_decision: dec_002");
  const w = world({
    repoText: readied,
    snapshotText: GOOD_PRD.replace("harness: codex", "harness: codex\naport_decision: dec_001"),
  });
  w.state.update(w.id, { prd_decision: "dec_001" });
  const out = why(w.ctx, { handle: "widget#142" });
  assert.match(out, /re-readied: aport_decision dec_001 became dec_002/);
  // And it changed nothing about the verdict, which the contract comparison owns.
  assert.equal(divergenceReason(prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd })), "prd-changed");
  w.cleanup();
});

test("why and status survive a brief they cannot read at all rather than failing the whole command", () => {
  const w = world({ repoText: null, entry: { checkout: "\0not-a-path" } });
  assert.doesNotThrow(() => why(w.ctx, { handle: "widget#142" }));
  assert.doesNotThrow(() => model(w.ctx));
  w.cleanup();
});

test("why says what to do for a gone brief and for an illegal one, which is not the same thing", () => {
  const gone = world({ repoText: null });
  assert.match(why(gone.ctx, { handle: "widget#142" }), /Restore the file, or `gallivant remove`/);
  gone.cleanup();
  const illegal = world({ repoText: ILLEGAL });
  const out = why(illegal.ctx, { handle: "widget#142" });
  assert.match(out, /would be refused by `gallivant start`/);
  assert.doesNotMatch(out, /--resnapshot/, "an illegal brief cannot be waved through");
  illegal.cleanup();
});

test("the tracker lists every difference above the facts, and escapes text that came out of a markdown file", () => {
  // Above the facts because it is the one thing on the page that says the work may be aimed at the wrong target. Escaped
  // because a criterion is text the operator wrote in a file, which is not hostile but is not this module's to trust.
  const html = runPage({
    id: "acme/widget/widget-export", handle: "widget#142",
    entry: { state: "pr-open", harness: "claude", iteration: 1, branch: "gallivant/widget-export", worktree: "/tmp/wt", session: "s" },
    run: null, maxIterations: 3, model: { needs_you: [], running: [], done: [] },
    divergence: {
      verdict: "changed", reason: "prd-changed", why: "the contract moved", handle: "widget#142", path: "/r/x.md",
      diff: ["criterion added: <script>alert(1)</script>", "Verify command added: `npm run typecheck`"],
    },
  });
  assert.ok(html.indexOf("prd-changed") < html.indexOf('class="facts"'), "above the facts");
  assert.match(html, /npm run typecheck/, "every difference, not just the first");
  assert.doesNotMatch(html, /<script>alert/, "and nothing an operator typed reaches the DOM as markup");
  assert.match(html, /gallivant resume widget#142 --resnapshot/);
});

// ---- resume ---------------------------------------------------------------------------------------------------------

test("resume refuses a diverged brief with the difference named, and spawns nothing", async () => {
  const w = world({ repoText: CRITERION_ADDED, entry: { state: STATES.needsHuman, reason: "prd-changed" } });
  await assert.rejects(() => resume(w.ctx, { handle: "widget#142" }), err => {
    assert.match(err.message, /acceptance criterion added, reworded or renumbered.*locked workspace/);
    assert.match(err.message, /Nothing was resumed/);
    assert.match(err.message, /--resnapshot/);
    return true;
  });
  assert.equal(w.runner.started.length, 0, "the session was not put back to work against a brief it does not hold");
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, "and the snapshot was not quietly replaced");
  w.cleanup();
});

test("resume --resnapshot replaces the snapshot, tells the session what moved, and leaves an audit trail", async () => {
  const lines = [];
  const w = world({ repoText: CRITERION_ADDED, entry: { state: STATES.needsHuman, reason: "prd-changed" } });
  w.ctx.log = { ...silentLog, warn: m => lines.push(m), info: () => {} };
  const r = await resume(w.ctx, { handle: "widget#142", resnapshot: true });
  // The snapshot is now the operator's copy, so the gate will judge the edited brief.
  assert.equal(w.ctx.readPrd(w.id), CRITERION_ADDED);
  const e = w.state.get(w.id);
  assert.equal(e.prd_fingerprint, prdFingerprint(parsePrd(CRITERION_ADDED, REL)), "and the fingerprint moved with it");
  assert.equal(e.prd_divergence, null);
  assert.equal(e.reason, null);
  // The audit trail: a warn naming the file, who asked, and what changed. The existing "the session could have edited
  // it" line is the model for this honesty.
  const replaced = lines.find(l => /REPLACED/.test(l));
  assert.ok(replaced, "the replacement is a warning, not a silent write");
  assert.match(replaced, /resume --resnapshot/);
  assert.match(replaced, /locked workspace/);
  // The session is told, because its memory holds the old brief and a gate deny on a criterion it has never seen reads
  // to the agent as the gate being broken.
  const prompt = w.runner.started[0].args.at(-1);
  assert.match(prompt, /THE BRIEF HAS CHANGED/);
  assert.match(prompt, /locked workspace/);
  assert.match(prompt, /Reread the brief in the worktree/);
  assert.deepEqual(r.resnapshotted, e.prd_divergence === null ? r.resnapshotted : []);
  assert.ok(r.resnapshotted.length, "and the caller is told what it changed");
  w.cleanup();
});

test("a --resnapshot that cannot spawn leaves the snapshot alone, so nothing moves with no run to show for it", async () => {
  // The ordering: every refusal comes before the write. A replaced snapshot with no run would move the file and the
  // fingerprint while the session was never told, so the next comparison would say `same` about a brief that moved. That
  // is the silent divergence this exists to end, reintroduced one command further along.
  const w = world({ repoText: CRITERION_ADDED, entry: { state: STATES.needsHuman, reason: "prd-changed" } });
  w.runner.start("fix", "/bin/claude", [], {});
  await assert.rejects(() => resume(w.ctx, { handle: "widget#142", resnapshot: true }), /already has a run in flight/);
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, "the snapshot is untouched");
  assert.equal(w.state.get(w.id).prd_fingerprint, prdFingerprint(parsePrd(GOOD_PRD, REL)), "and so is the fingerprint");
  w.cleanup();
});

test("a --resnapshot whose checkout cannot be recreated leaves the snapshot alone too", async () => {
  // Same rule as the busy runner, one step further along: a clone fails for reasons that have nothing to do with the
  // brief (a revoked token, a full disk, a deleted branch), and a snapshot replaced before it would leave the file and
  // the fingerprint moved with no run. The NEXT resume would then answer `same` and never tell the session the brief had
  // changed, which is the divergence this exists to end, reintroduced one command along.
  const w = world({ repoText: VERIFY_CHANGED, entry: { state: STATES.needsHuman, reason: "prd-changed" } });
  w.ctx.git = { ...fakeGit(), exists: () => false, fromBranch: async () => { throw new Error("could not read from remote"); } };
  await assert.rejects(() => resume(w.ctx, { handle: "widget#142", resnapshot: true }), /could not read from remote/);
  assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, "the snapshot is untouched");
  assert.equal(w.state.get(w.id).prd_fingerprint, prdFingerprint(parsePrd(GOOD_PRD, REL)));
  // So the retry, once the clone works, still tells the session what moved.
  w.ctx.git = fakeGit();
  const r = await resume(w.ctx, { handle: "widget#142", resnapshot: true });
  assert.ok(r.resnapshotted.length);
  assert.match(w.runner.started[0].args.at(-1), /THE BRIEF HAS CHANGED/);
  w.cleanup();
});

test("a --resnapshot whose base merge is refused leaves the snapshot alone, so the next attempt still says what moved", async () => {
  // The same rule again, one step further along, and this is the one it was breaking. `mergeBaseInto` can refuse the
  // whole resume on a conflict, and it used to run AFTER `resolvePrdSnapshot`: nothing ran, but the snapshot and the
  // fingerprint had already moved, so the next attempt compared as `same`, built an empty `briefChanged`, and resumed a
  // session that was never told its remembered contract was obsolete. Two refusals, checked separately because
  // `mergeBaseInto` produces `conflict: true` by two different routes and only one of them is a real conflict.
  for (const [what, git] of [
    ["a conflict", { ...fakeGit(), mergeBase: async (_d, base) => ({ merged: false, conflict: true, base, why: "CONFLICT (content): Merge conflict in src/a.ts" }) }],
    ["a failed fetch", { ...fakeGit(), mergeBase: async () => { throw new Error("fatal: couldn't find remote ref main"); } }],
  ]) {
    // `base` on the entry is what makes `mergeBaseInto` do anything at all: with none it returns null and there is no
    // merge to refuse. This world does not set one by default, because nothing else in this file needs the merge.
    const w = world({ repoText: CRITERION_ADDED, entry: { state: STATES.needsHuman, reason: "prd-changed", base: "main" } });
    w.ctx.git = git;
    await assert.rejects(() => resume(w.ctx, { handle: "widget#142", resnapshot: true }), /cannot be merged with origin\/main/, what);
    assert.equal(w.runner.started.length, 0, `${what}: nothing was resumed`);
    assert.equal(w.ctx.readPrd(w.id), GOOD_PRD, `${what}: the snapshot is untouched`);
    assert.equal(w.state.get(w.id).prd_fingerprint, prdFingerprint(parsePrd(GOOD_PRD, REL)), `${what}: and so is the fingerprint`);

    // The consequence, asserted rather than inferred, because it is the whole finding: once the merge works, the retry
    // still tells the session what moved. Before the reorder this paragraph was missing from the prompt, and the
    // session resumed believing the old brief with nothing anywhere saying otherwise.
    w.ctx.git = fakeGit();
    const r = await resume(w.ctx, { handle: "widget#142", resnapshot: true });
    assert.ok(r.resnapshotted.length, `${what}: the retry resnapshots`);
    assert.match(w.runner.started[0].args.at(-1), /THE BRIEF HAS CHANGED/, `${what}: and the session is told`);
    w.cleanup();
  }
});

test("resume --resnapshot refuses an illegal or a deleted brief, because neither can become the snapshot", async () => {
  const illegal = world({ repoText: ILLEGAL, entry: { state: STATES.needsHuman, reason: "prd-illegal" } });
  await assert.rejects(() => resume(illegal.ctx, { handle: "widget#142", resnapshot: true }), /would be refused by `gallivant start`/);
  assert.equal(illegal.ctx.readPrd(illegal.id), GOOD_PRD);
  illegal.cleanup();
  const gone = world({ repoText: null, entry: { state: STATES.needsHuman, reason: "prd-gone" } });
  await assert.rejects(() => resume(gone.ctx, { handle: "widget#142", resnapshot: true }), /Restore the file/);
  gone.cleanup();
});

test("resume carries on through a prose edit without a flag, and says nothing to the session about the brief", async () => {
  const w = world({ repoText: PROSE_EDIT, entry: { state: STATES.needsHuman, reason: "no-push" } });
  const r = await resume(w.ctx, { handle: "widget#142" });
  assert.equal(w.runner.started.length, 1, "resumed");
  assert.equal(w.ctx.readPrd(w.id), PROSE_EDIT, "the snapshot followed the prose");
  assert.doesNotMatch(w.runner.started[0].args.at(-1), /THE BRIEF HAS CHANGED/, "because it did not, in any way the session reads");
  assert.deepEqual(r.resnapshotted, []);
  w.cleanup();
});

// ---- the snapshot's one writer ---------------------------------------------------------------------------------------

test("ensurePrdSnapshot still refuses to overwrite, and resolvePrdSnapshot is the only thing that may", async () => {
  const w = world();
  const ctx = { credential: fakeCredential(), identity: fakeIdentity(), ...w.ctx, gh: { fileAt: async () => CRITERION_ADDED } };
  // The invariant a session must not be able to break: the snapshot is taken once from the branch and never replaced by
  // the copy the session could have edited.
  assert.equal(await ensurePrdSnapshot(ctx, { id: w.id, repo: "acme/widget", path: REL, ref: "gallivant/widget-export" }), false);
  assert.equal(ctx.readPrd(w.id), GOOD_PRD);
  // And the operator's resolution is the one thing that may, through the function that logs it.
  const d = prdDivergence({ id: w.id, entry: { ...w.state.get(w.id), checkout: w.checkoutDir }, readPrd: w.ctx.readPrd });
  assert.equal(d.verdict, "same", "sanity: this world has no divergence");
  assert.throws(() => resolvePrdSnapshot(w.ctx, { id: w.id, entry: w.state.get(w.id), divergence: d, by: "a test" }), /nothing to resolve \(same/);
  w.cleanup();
});

test("retakePrdSnapshot records the new contract alongside the file, so the next comparison agrees with it", () => {
  const w = world({ repoText: PROSE_EDIT });
  const d = prdDivergence({ id: w.id, entry: w.state.get(w.id), readPrd: w.ctx.readPrd });
  retakePrdSnapshot(w.ctx, { id: w.id, divergence: d });
  assert.equal(w.ctx.readPrd(w.id), PROSE_EDIT);
  const e = w.state.get(w.id);
  assert.equal(e.prd_fingerprint, prdFingerprint(d.repo));
  // And the comparison now says identical, so nothing re-derives the same answer every tick.
  assert.equal(prdDivergence({ id: w.id, entry: e, readPrd: w.ctx.readPrd }).verdict, "same");
  assert.equal(prdDivergence({ id: w.id, entry: e, readPrd: w.ctx.readPrd }).why, "identical to the snapshot");
  w.cleanup();
});

test("renderDivergence is one indented line per difference, and empty when there is nothing to say", () => {
  const good = parsePrd(GOOD_PRD, REL);
  assert.equal(renderDivergence({ diff: [] }), "");
  assert.equal(renderDivergence({ diff: contractDiff(good, parsePrd(CONTEXT_PATHS_ADDED, REL)) }), "  - context_paths entry added: /tmp/schemas");
});

// ---- the whole thing, once, against a run that pushes ----------------------------------------------------------------

test("end to end: a run pushes, the operator tightens the brief, and the PR is not certified against the old one", async () => {
  const w = world({ pr: prFixture({ headRefOid: "old1234" }) });
  // A fix round ends with a push. The round is counted and the brief is untouched, so nothing complains yet.
  w.state.update(w.id, { last: { at: T0, run: "1-fix", exit: null, event: "fix" } });
  w.runner.start("fix", "/bin/claude", [], {});
  w.runner.finish(claudeResultLines({ ok: true }));
  w.gh.data.pr.headRefOid = "new5678";
  w.gh.data.commitDates.new5678 = "2026-09-24T02:10:00Z";
  const tick = makeTick(w.ctx);
  await tick.tickEntry(w.id, w.state.get(w.id));
  assert.equal(w.state.get(w.id).iteration, 1, "the push is a round");

  // Now the operator adds a criterion. The next readiness judgement must not certify the brief the session worked to.
  writeFileSync(w.file, CRITERION_ADDED);
  const e = await tickToReady(w);
  assert.equal(e.state, STATES.needsHuman);
  assert.equal(e.reason, "prd-changed");
  assert.equal(e.iteration, 1, "and no round was spent on the argument");
  w.cleanup();
});
