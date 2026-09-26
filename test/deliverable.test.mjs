import { test } from "node:test";
import assert from "node:assert/strict";
import { criteriaFromPrd, parseReceipt, evaluate, gate, taskPassport, evaluateHosted, receiptInstructions, receiptHash, RECEIPT_TAG, DEFAULT_LIMITS, provenance } from "../lib/deliverable.mjs";
import { parsePrd } from "../lib/prd.mjs";
import { VERSION } from "../lib/fs.mjs";
import { makeTick } from "../lib/tick.mjs";
import { READY_LABEL } from "../lib/gh.mjs";
import { DEFAULT_DELIVERABLE } from "../lib/config.mjs";
import { CONFIG, GOOD_PRD, at, makeClock, fakeGh, fakeRunner, fakeGit, fakeNotify, seededState, prFixture, review, checkRun, claudeResultLines, silentLog, STATES } from "./helpers.mjs";

const prd = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
const criteria = criteriaFromPrd(prd);
const receiptBlock = (over = {}) => "\n```" + RECEIPT_TAG + "\n" + JSON.stringify({
  task_id: "widget/widget-export", output_type: "code",
  summary: "Added a CSV export endpoint and button, with unit tests for three rows and the empty state, verified by npm test and npm run lint locally.",
  criteria_attestations: [
    { criterion_id: "ac-1", met: true, evidence: "src/export/csv.test.ts: 'exports three rows'" },
    { criterion_id: "ac-2", met: true, evidence: "src/export/Button.tsx:41 disabled when items.length === 0; test 'empty state hint'" },
  ],
  ...over,
}, null, 2) + "\n```\n";

test("criteria come from the PRD in order with stable ids", () => {
  assert.deepEqual(criteria.map(c => c.id), ["ac-1", "ac-2"]);
  assert.match(criteria[1].description, /^Given an empty workspace, when I click Export, then/);
  const text = receiptInstructions(criteria, "widget/widget-export");
  assert.match(text, /- ac-1: Given a workspace/);
  assert.match(text, new RegExp("```" + RECEIPT_TAG));
});

test("the receipt parses from a PR body and is fingerprinted", () => {
  const body = "Adds export.\n" + receiptBlock();
  assert.equal(parseReceipt(body).receipt.criteria_attestations.length, 2);
  assert.match(parseReceipt("no block").reason, /no completion receipt/);
  assert.match(parseReceipt("```" + RECEIPT_TAG + "\n{nope\n```").reason, /not valid JSON/);
  assert.equal(receiptHash(body).length, 12);
  assert.notEqual(receiptHash(body), receiptHash("x\n" + receiptBlock({ summary: "different words here to change the hash of this receipt block text" })));
  assert.equal(receiptHash("nothing"), null);
});

test("every deny code fires for its condition, with the policy's names", () => {
  const ctx = JSON.parse(receiptBlock().match(/\n([\s\S]*)\n```/)[1].replace(/^```.*\n/, ""));
  const ev = (c, limits = DEFAULT_LIMITS) => evaluate({ context: { ...ctx, tests_passing: true, ...c }, limits, criteria }).denials.map(d => d.code);
  assert.deepEqual(ev({}), []);
  assert.deepEqual(ev({ criteria_attestations: ctx.criteria_attestations.slice(0, 1) }), ["oap.criteria_incomplete"]);
  assert.deepEqual(ev({ criteria_attestations: [{ ...ctx.criteria_attestations[0], evidence: " " }, ctx.criteria_attestations[1]] }), ["oap.evidence_missing"]);
  assert.deepEqual(ev({ criteria_attestations: [{ ...ctx.criteria_attestations[0], met: "true" }, ctx.criteria_attestations[1]] }), ["oap.criteria_not_met"]);
  assert.deepEqual(ev({ criteria_attestations: [...ctx.criteria_attestations, { criterion_id: "ac-9", met: true, evidence: "x" }] }), ["oap.criteria_unknown"]);
  assert.deepEqual(ev({ summary: "short" }), ["oap.summary_insufficient"]);
  assert.deepEqual(ev({ tests_passing: false }), ["oap.tests_not_passing"]);
  assert.deepEqual(ev({ output_content: "const x = 1; // TODO later" }), ["oap.blocked_pattern_detected"]);
  assert.deepEqual(ev({ summary: "" }, { ...DEFAULT_LIMITS, require_summary: false }), []);
});

const LOCAL = { ...DEFAULT_LIMITS, evaluator: "local" };
const fetchWith = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
const allowResponse = { decision: { decision_id: "dec_1", allow: true, reasons: [{ code: "oap.allowed", message: "All policy checks passed", severity: "info" }] } };
const denyResponse = { decision: { decision_id: "dec_2", allow: false, reasons: [{ code: "oap.summary_insufficient", message: "Summary is required", severity: "error" }] } };

test("gate takes tests_passing from the daemon, never from the receipt", async () => {
  const body = "Adds export.\n" + receiptBlock({ tests_passing: true });
  assert.equal((await gate({ taskId: "t", prBody: body, criteria, checksGreen: false, limits: LOCAL })).denials[0].code, "oap.tests_not_passing");
  assert.equal((await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, limits: LOCAL })).allow, true);
  assert.equal((await gate({ taskId: "t", prBody: "no receipt", criteria, checksGreen: true, limits: LOCAL })).denials[0].code, "oap.receipt_missing");
});

test("the per-task passport carries the criteria as the policy's limits, and the hosted call is shaped for APort", async () => {
  const p = taskPassport({ taskId: "widget/widget-export", criteria });
  assert.match(p.agent_id, /^ap_gallivant_[0-9a-f]{24}$/);
  assert.deepEqual(p.limits["deliverable.task.complete"].acceptance_criteria, criteria);
  assert.equal(p.limits["deliverable.task.complete"].evaluator, undefined, "evaluator and api_url are Gallivant settings, not passport limits");
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => allowResponse }; };
  const r = await evaluateHosted({ passport: p, context: { task_id: "t", output_type: "code", criteria_attestations: [] }, fetch, apiKey: "apk_x" });
  assert.equal(r.allow, true);
  assert.equal(r.decisionId, "dec_1");
  assert.equal(calls[0].url, "https://api.aport.io/api/verify/policy/deliverable.task.complete.v1");
  assert.equal(calls[0].init.headers["X-API-Key"], "apk_x");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.passport.agent_id, p.agent_id);
  assert.equal(sent.context.agent_id, p.agent_id);
  assert.match(sent.context.idempotency_key, /^t-[0-9a-f]{12}$/);
});

test("with evaluator aport the hosted verdict confirms or overrides a local pass; an outage waits by default and falls back only when asked", async () => {
  const body = "Adds export.\n" + receiptBlock();
  const ok = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, fetch: fetchWith(200, allowResponse) });
  assert.deepEqual([ok.allow, ok.source], [true, "aport"]);
  const denied = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, fetch: fetchWith(200, denyResponse) });
  assert.deepEqual([denied.allow, denied.source, denied.denials[0].code], [false, "aport", "oap.summary_insufficient"]);
  const invalid = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, fetch: fetchWith(400, { error: "context_validation_failed", required_context_errors: [{ path: "criteria_attestations.0.met", message: "must be a boolean" }] }) });
  assert.deepEqual([invalid.allow, invalid.denials[0].code], [false, "oap.invalid_context"]);
  const warned = [];
  const down = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, fetch: async () => { throw new Error("ECONNREFUSED"); }, log: { warn: m => warned.push(m) } });
  assert.deepEqual([down.allow, down.pending, down.source, down.denials[0].code], [false, true, "aport (unreachable)", "aport.unreachable"]);
  assert.match(warned[0], /ECONNREFUSED/);
  const fallback = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, limits: { ...DEFAULT_DELIVERABLE, on_unreachable: "local" }, fetch: async () => { throw new Error("ECONNREFUSED"); }, log: { warn: () => {} } });
  assert.deepEqual([fallback.allow, fallback.pending, fallback.source], [true, undefined, "local (aport unreachable)"]);
  const localFail = await gate({ taskId: "t", prBody: body, criteria, checksGreen: false, fetch: async () => { throw new Error("must not be called when local already denies"); } });
  assert.deepEqual([localFail.allow, localFail.source], [false, "local"]);
});

function world(stateOver = {}, ghOver = {}) {
  const clock = makeClock();
  const { state, id } = seededState(stateOver);
  const gh = fakeGh(ghOver);
  const runner = fakeRunner(clock);
  const notify = fakeNotify();
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify, log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, fetch: fetchWith(200, allowResponse) });
  return { clock, state, id, gh, runner, notify, tick, entry: () => state.get(id) };
}
const clearReviewer = () => [review({ id: 2, by: "chatgpt-codex-connector[bot]", bot: true, state: "COMMENTED", at: at(3), body: "**Reviewed commit:** `a1b2c3d`" })];

test("the gate's context carries self-reported provenance, and the hosted call sends it", async () => {
  const body = "Adds export.\n" + receiptBlock();
  const g = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, framework: "codex", limits: LOCAL });
  assert.deepEqual(g.context.meta, { framework: "codex", gallivant_version: VERSION });
  assert.equal(VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  // With no harness named, the version still goes: the field is provenance, not a required input.
  assert.deepEqual((await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, limits: LOCAL })).context.meta, { gallivant_version: VERSION });

  const sent = [];
  const fetch = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => allowResponse }; };
  const hosted = await gate({ taskId: "t", prBody: body, criteria, checksGreen: true, framework: "claude", fetch });
  assert.equal(hosted.allow, true);
  assert.deepEqual(sent[0].context.meta, { framework: "claude", gallivant_version: VERSION }, "meta rides inside the existing context, so no schema changes");
  assert.equal(sent[0].passport.limits["deliverable.task.complete"].meta, undefined, "provenance is context, never a passport limit");
});

test("provenance never decides anything: the local rules ignore meta entirely", async () => {
  // Self-reported and never an authorization input. A forged meta must not change a verdict in either direction.
  const ctx = { task_id: "t", output_type: "code", summary: "x".repeat(5), criteria_attestations: [], tests_passing: false };
  const plain = evaluate({ context: ctx, limits: DEFAULT_LIMITS, criteria });
  const forged = evaluate({ context: { ...ctx, meta: { framework: "trust-me", gallivant_version: "99.0.0", allow: true } }, limits: DEFAULT_LIMITS, criteria });
  assert.deepEqual(forged.denials.map(d => d.code), plain.denials.map(d => d.code));
  assert.equal(forged.allow, false);
});

test("PRD readiness carries the harness named in the brief as its provenance", async () => {
  const good = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
  const { context } = prdContract(good, check(good), RULES);
  assert.deepEqual(context.meta, { framework: "codex", gallivant_version: VERSION }, "the harness that will do the work is the provenance of the decision authorising it");
  const sent = [];
  await decidePrdReady({ prd: good, verdict: check(good), rules: RULES, limits: PRD_LIMITS, fetch: async (_u, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => allowResponse }; } });
  assert.deepEqual(sent[0].context.meta, { framework: "codex", gallivant_version: VERSION });
});

test("green checks and a clear reviewer are not enough without a valid receipt: a receipt round starts", async () => {
  const w = world({ rereview: { at: at(0), nudged: false } }, { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "Adds export." }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.entry().state, STATES.prOpen);
  assert.equal(w.runner.started.length, 1);
  assert.match(w.runner.started[0].args.at(-1), /oap.receipt_missing/);
  assert.match(w.runner.started[0].args.at(-1), /- ac-1: Given a workspace/);
  assert.match(w.entry().last.event, /^receipt denied: oap.receipt_missing/);
  assert.deepEqual(w.notify.sent, []);
});

test("a receipt round that only edits the PR body counts as a round and then the PR is ready", async () => {
  const w = world({ rereview: { at: at(0), nudged: false } }, { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "Adds export." }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  w.gh.data.pr = prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "Adds export.\n" + receiptBlock() });
  w.runner.finish(claudeResultLines());
  await w.tick.tick(); // settles the receipt round, then evaluates the new receipt in the same tick
  assert.equal(w.entry().iteration, 1);
  const comments = w.gh.calls.filter(c => c[0] === "comment").map(c => c[2]);
  assert.equal(comments.length, 1, "a receipt round leaves a round marker so the count survives a lost state file");
  assert.ok(!comments[0].startsWith("@codex review"), "no re-review request when no code moved");
  assert.equal(w.entry().state, STATES.ready);
  assert.ok(w.gh.calls.some(c => c[0] === "addLabel" && c[2] === READY_LABEL));
  assert.deepEqual(w.notify.sent, [["ready", 142]]);
});

test("a valid receipt with one criterion not met keeps the PR out of ready", async () => {
  const body = "Adds export.\n" + receiptBlock({ criteria_attestations: [{ criterion_id: "ac-1", met: true, evidence: "t" }, { criterion_id: "ac-2", met: false, evidence: "not done" }] });
  const w = world({ rereview: { at: at(0), nudged: false } }, { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  const prompt = w.runner.started[0].args.at(-1);
  assert.match(prompt, /oap.criteria_not_met/);
  assert.match(prompt, /````\n[\s\S]*oap.criteria_not_met[\s\S]*````/, "deny messages carry PR-body text, so they are quoted like any other GitHub text");
});

test("the gate respects the iteration cap and is skipped when deliverable is null", async () => {
  const w = world({ iteration: 3, rereview: { at: at(0), nudged: false } }, { pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "no receipt" }), reviews: clearReviewer() });
  w.clock.advance(4);
  await w.tick.tick();
  assert.equal(w.entry().reason, "iterations");
  const clock = makeClock();
  const { state, id } = seededState({ rereview: { at: at(0), nudged: false } });
  const gh = fakeGh({ pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body: "no receipt" }), reviews: clearReviewer() });
  const tick = makeTick({ config: { ...CONFIG, deliverable: null }, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => fakeRunner(clock), readPrd: () => GOOD_PRD, fetch: async () => { throw new Error("no gate, no call"); } });
  clock.advance(4);
  await tick.tick();
  assert.equal(state.get(id).state, STATES.ready);
});

test("an unreachable evaluator leaves the PR waiting: no receipt round, no iteration, no label", async () => {
  const body = "Adds export.\n" + receiptBlock();
  const clock = makeClock();
  const { state, id } = seededState({ rereview: { at: at(0), nudged: false } });
  const gh = fakeGh({ pr: prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body }), reviews: clearReviewer() });
  const runner = fakeRunner(clock);
  const tick = makeTick({ config: CONFIG, state, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, fetch: async () => { throw new Error("ECONNREFUSED"); } });
  clock.advance(4);
  await tick.tick();
  await tick.tick();
  assert.deepEqual([state.get(id).state, state.get(id).iteration, runner.started.length], [STATES.prOpen, 0, 0]);
  assert.ok(!gh.calls.some(c => c[0] === "addLabel"));
});

test("a diff the output scan cannot read is no decision, so a blocked pattern is never let through as a clean scan", async () => {
  // The fail-open, end to end. The receipt is valid and the checks are green, so the only rule left is the output
  // scan, and the diff carries a blocked pattern. `prDiff` used to swallow its own failure and answer null;
  // `addedLines(null)` is the empty string, which no pattern matches, so the gate allowed and the PR went ready with
  // `console.log(` in it. Unreadable now means undecided: pr-open, no round, no label, and the reason logged.
  const body = "Adds export.\n" + receiptBlock();
  const pr = prFixture({ statusCheckRollup: [checkRun({ name: "test", conclusion: "SUCCESS" })], body });
  for (const [label, prDiff] of [
    ["a failure", async () => { throw new Error("gh pr diff: HTTP 502"); }],
    ["nothing at all", async () => null],
  ]) {
    const clock = makeClock();
    const { state, id } = seededState({ rereview: { at: at(0), nudged: false } });
    const gh = fakeGh({ pr, reviews: clearReviewer() });
    gh.prDiff = prDiff;
    const runner = fakeRunner(clock);
    const logged = [];
    const log = { ...silentLog, info: m => logged.push(m), warn: m => logged.push(m) };
    // `evaluator: "local"` so the built-in rules give the verdict and no hosted call is in the way.
    const config = { ...CONFIG, deliverable: { ...CONFIG.deliverable, evaluator: "local" } };
    const tick = makeTick({ config, state, gh, git: fakeGit(), notify: fakeNotify(), log, clock, ownLogin: "me", runnerFor: () => runner, readPrd: () => GOOD_PRD, fetch: async () => { throw new Error("no hosted call on a local evaluator"); } });

    clock.advance(4);
    await tick.tick();
    assert.deepEqual([state.get(id).state, state.get(id).iteration, runner.started.length], [STATES.prOpen, 0, 0], `${label}: waiting, not ready and not a round`);
    assert.ok(!gh.calls.some(c => c[0] === "addLabel"), `${label}: no ready label`);
    assert.ok(logged.some(l => /diff unreadable/.test(l)), `${label}: the reason is logged (got ${logged})`);
  }

  // And with a diff the daemon can read, the same PR is denied on the pattern rather than allowed.
  const denied = await gate({ taskId: "widget/widget-export", prBody: body, criteria, checksGreen: true, diff: 'console.log("x")', limits: LOCAL });
  assert.deepEqual([denied.allow, denied.denials[0].code], [false, "oap.blocked_pattern_detected"]);
});

// ---- PRD readiness as an APort decision ------------------------------------------------------------------------
import { prdContract, decidePrdReady, PRD_LIMITS, PRD_BLOCKED_PATTERNS } from "../lib/deliverable.mjs";
import { check, RULES } from "../lib/prd.mjs";
import { ready } from "../lib/commands/ready.mjs";
import { withFrontmatterKey } from "../lib/prd.mjs";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tempHome } from "./helpers.mjs";

test("the PRD contract maps every rule to a criterion with the checker's verdict as evidence", () => {
  const good = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
  const { criteria, context } = prdContract(good, check(good), RULES);
  assert.equal(criteria.length, RULES.length);
  assert.equal(criteria[0].id, "prd-path");
  assert.equal(context.output_type, "document");
  assert.ok(context.criteria_attestations.every(a => a.met === true && a.evidence.length > 0));
  assert.equal(context.output_content, good.body);
  const bad = parsePrd(GOOD_PRD.replace("- PDF export.", "- TBD"), "/r/docs/prds/widget-export.md");
  const v = check(bad);
  const att = prdContract(bad, v, RULES).context.criteria_attestations.find(a => a.criterion_id === "prd-placeholders");
  assert.deepEqual([att.met, att.evidence], [false, 'found "TBD"']);
});

test("readiness: local rules deny a failing PRD; a passing one is confirmed by APort, whose deny wins", async () => {
  const good = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
  const local = await decidePrdReady({ prd: good, verdict: check(good), rules: RULES, limits: { ...PRD_LIMITS, evaluator: "local" } });
  assert.deepEqual([local.allow, local.source], [true, "local"]);
  const bad = parsePrd(GOOD_PRD.replace("- PDF export.", "- <why>"), "/r/docs/prds/widget-export.md");
  const denied = await decidePrdReady({ prd: bad, verdict: check(bad), rules: RULES, limits: PRD_LIMITS, fetch: async () => { throw new Error("must not call APort for a locally failing PRD"); } });
  assert.equal(denied.allow, false);
  assert.ok(denied.denials.some(d => d.code === "oap.criteria_not_met"));
  assert.ok(PRD_BLOCKED_PATTERNS.includes("<why>"));
  const hostedDeny = await decidePrdReady({ prd: good, verdict: check(good), rules: RULES, limits: PRD_LIMITS, fetch: fetchWith(200, denyResponse) });
  assert.deepEqual([hostedDeny.allow, hostedDeny.source, hostedDeny.denials[0].code], [false, "aport", "oap.summary_insufficient"]);
  const hostedAllow = await decidePrdReady({ prd: good, verdict: check(good), rules: RULES, limits: PRD_LIMITS, fetch: fetchWith(200, allowResponse) });
  assert.deepEqual([hostedAllow.allow, hostedAllow.decisionId], [true, "dec_1"]);
});

test("gallivant ready flips the status only on an allow and records the decision id", async () => {
  const dir = join(tempHome(), "repo", "docs", "prds");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "widget-export.md");
  writeFileSync(path, GOOD_PRD.replace("status: ready", "status: draft"));
  const denied = await ready({ path, config: { deliverable: { evaluator: "aport", api_url: "https://x" } }, fetch: fetchWith(200, denyResponse) });
  assert.equal(denied.ok, false);
  assert.match(readFileSync(path, "utf8"), /^---\nstatus: draft/);
  const allowed = await ready({ path, config: { deliverable: { evaluator: "aport", api_url: "https://x" } }, fetch: fetchWith(200, allowResponse) });
  assert.deepEqual([allowed.ok, allowed.changed, allowed.decisionId], [true, true, "dec_1"]);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^---\nstatus: ready\nharness: codex\naport_decision: dec_1\n---/);
  assert.match(withFrontmatterKey(text, "aport_decision", "dec_9"), /harness: codex\naport_decision: dec_9\n---/);
  const again = await ready({ path, config: { deliverable: null } });
  assert.deepEqual([again.ok, again.changed], [true, false]);
  const noConfig = await ready({ path, config: null, fetch: async () => { throw new Error("no config must mean no APort call"); } });
  assert.deepEqual([noConfig.ok, noConfig.changed], [true, false]);
});

test("a malformed attestation is a deny with a reason, never a thrown exception the tick logs on every poll", async () => {
  // `"criteria_attestations": [null]` parsed as a receipt, then `evaluate` read `a.criterion_id` and threw. The
  // per-entry catch logged it every poll, so the entry never got a corrective receipt round and never reached a
  // diagnosable stop. A receipt is agent-written JSON, so its shape is checked where it is parsed.
  const cases = [
    [[null], /criteria_attestations\[0\] is not an attestation object/],
    [["ac-1"], /criteria_attestations\[0\] is not an attestation object/],
    [[{ met: true, evidence: "x" }], /criteria_attestations\[0\] is not an attestation object/],
    [[{ criterion_id: 1, met: true, evidence: "x" }], /criteria_attestations\[0\] is not an attestation object/],
    [[[{ criterion_id: "ac-1" }]], /criteria_attestations\[0\] is not an attestation object/],
    [[{ criterion_id: "ac-1", met: true, evidence: "x" }, null], /criteria_attestations\[1\] is not an attestation object/],
    ["nope", /criteria_attestations is not an array/],
    [null, /criteria_attestations is not an array/],
  ];
  for (const [atts, reason] of cases) {
    const what = JSON.stringify(atts);
    assert.match(parseReceipt("x" + receiptBlock({ criteria_attestations: atts })).reason, reason, what);
    const g = await gate({ taskId: "t", prBody: "x" + receiptBlock({ criteria_attestations: atts }), criteria, checksGreen: true, limits: LOCAL });
    assert.equal(g.allow, false, what);
    assert.deepEqual(g.denials.map(d => d.code), ["oap.receipt_missing"], `${what}: a code the fix round can carry`);
    assert.match(g.denials[0].message, reason, what);
  }
  // A receipt that is not an object at all, and one that is an array, are refused the same way.
  assert.match(parseReceipt("```" + RECEIPT_TAG + "\n[]\n```").reason, /not a JSON object/);
  assert.match(parseReceipt("```" + RECEIPT_TAG + "\n42\n```").reason, /not a JSON object/);
  assert.match(parseReceipt("```" + RECEIPT_TAG + "\nnull\n```").reason, /not a JSON object/);
});

test("evaluate itself never dereferences a malformed attestation, so no caller building a context by hand can crash it", () => {
  // The second line of defence: `parseReceipt` refuses these, and `evaluate` counts them as missing rather than
  // reading fields off them, so nothing passes by being unreadable.
  const context = { task_id: "t", summary: "a b c d e f g h i j k l m n o p q r s t u v", tests_passing: true, criteria_attestations: [null, "ac-1", 7, { criterion_id: "ac-1", met: true, evidence: "src/x.ts" }] };
  const r = evaluate({ context, limits: DEFAULT_LIMITS, criteria });
  assert.equal(r.allow, false);
  assert.deepEqual(r.denials.map(d => d.code), ["oap.criteria_incomplete"], "the readable one counts, the rest are simply absent");
  assert.match(r.denials[0].message, /Missing attestations for: ac-2/);
  assert.deepEqual(evaluate({ context: { ...context, criteria_attestations: "nope" }, limits: DEFAULT_LIMITS, criteria }).denials.map(d => d.code), ["oap.criteria_incomplete"]);
});


test("a brief with no acceptance criteria denies rather than passing with nothing evaluated", async () => {
  // Every criteria rule is vacuously satisfied by an empty list: `missing`, `unknown`, `notMet` and `noEvidence` are
  // all empty because there are no attestations to be any of those. What was left was the summary word count and the
  // checks, both of which a green PR with a wordy receipt satisfies, so the gate allowed and the PR reached ready with
  // not one acceptance criterion evaluated. Reachable through the snapshot taken from the agent-writable PR branch:
  // delete the `## Acceptance criteria` heading and the gate stops checking.
  const empty = evaluate({ context: { task_id: "t", summary: "a b c d e f g h i j k l m n o p q r s t u v w", tests_passing: true, criteria_attestations: [] }, limits: DEFAULT_LIMITS, criteria: [] });
  assert.equal(empty.allow, false);
  assert.deepEqual(empty.denials.map(d => d.code), ["oap.criteria_incomplete"]);
  assert.match(empty.denials[0].message, /no acceptance criteria/);

  // Through the gate, which is how the tick reaches it, and with a receipt the rules would otherwise accept.
  const g = await gate({ taskId: "t", prBody: "x" + receiptBlock({ criteria_attestations: [] }), criteria: [], checksGreen: true, limits: LOCAL });
  assert.equal(g.allow, false);
  assert.deepEqual(g.denials.map(d => d.code), ["oap.criteria_incomplete"]);

  // And a PRD parsed from a brief with the section removed yields exactly that empty list, which is the reachable path.
  const noCriteria = parsePrd(GOOD_PRD.replace("## Acceptance criteria", "## Notes"), "/r/docs/prds/x.md");
  assert.deepEqual(criteriaFromPrd(noCriteria), []);
});
