import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deliveryProfile, validateDeliveryProfile, stableProfile, deliveryScreen, maskLiterals, statements, validateDeliveryTag, profileCovers, unaccountedTerms, deliveryQuestion, deliveryProfileFromPrd, profileView, DELIVERY_CAPABILITIES, PROFILE_VERSION, COMPLETION_CONDITIONS } from "../lib/task_profile.mjs";
import { intakeModelProblems, validateIntakeModelConfig, intakeModelRoute, intakeModelRouteSummary, pinnedModelRoute, savedModelRoute, MODEL_ROUTE_CEILINGS } from "../lib/task_model_config.mjs";
import { COMPLETION_SCHEMA } from "../lib/task_completion.mjs";
import { prepareModelTurn, isModelRouteReceipt, estimateTokens, estimateUsd } from "../lib/task_model_route.mjs";
import { repositorySnapshot, REPOSITORY_CONTEXT_LIMITS } from "../lib/task_repository_context.mjs";
import { fragments, parseDraft, renderDraft, draftPrompt, MAX_INPUT_BYTES } from "../lib/task_contract.mjs";
import { check, parsePrd, contractOf } from "../lib/prd.mjs";
import { validate as validateConfig, merge as mergeConfig } from "../lib/config.mjs";
import { makeGit } from "../lib/git.mjs";
import { profileRequests } from "../templates/plugin/task-profile-requests.mjs";
import { draftFor } from "./fixtures/task-intake.mjs";
import { currentContract, savedContract, contractDrift } from "../scripts/task-intake-contract.mjs";
import { tempHome, CONFIG } from "./helpers.mjs";

const PROFILE = { version: 1, action: "pull_request", target: { kind: "github-pull-request", repository: "acme/widget", base: "main" }, completion: { condition: "delivery_ready" } };
const ROUTE = { adapter: "openai-chat", model: "fixture-model", endpoint: "https://api.example-provider.com/v1/chat/completions", credential_env: "FIXTURE_MODEL_KEY",
  budget: { max_calls: 3, max_input_tokens: 50000, max_output_tokens: 6000, allowance_usd: 0.1, input_usd_per_million: 1, output_usd_per_million: 10 }, timeout_ms: 5000 };
const sha = value => createHash("sha256").update(value).digest("hex");
// Tasks pin their route selection at creation; later turns run against it.
const pinned = config => pinnedModelRoute(validateIntakeModelConfig(config));
const withRoute = (task, config) => Object.assign(task, { modelRoute: pinned(config) });

function taskFor(text, overrides = {}) {
  const requirements = fragments(text);
  return { id: "task-" + "0".repeat(24), original: text, requirements, answers: {}, questionHistory: {}, questionMappings: {}, context: [{ path: "package.json", text: JSON.stringify({ scripts: { test: "node --test" }, packageManager: "npm@10.0.0" }), hash: "x" }], modelRoute: pinned(ROUTE),
    explicitVerifyCommands: [], attempts: [], allowance: { budgetUsd: 5, runtimeMs: 60_000 }, repo: "acme/widget", base: "main", harness: "gemini", route: "model", deliveryProfile: PROFILE, completion: { version: 1, target: "delivery_ready" }, ...overrides };
}
const memoryStore = () => { const saves = []; return { saves, save: task => saves.push(structuredClone(task)) }; };
const response = (body, { status = 200, headers = {} } = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] ?? null }, text: async () => typeof body === "string" ? body : JSON.stringify(body), body: { cancel: async () => {} } });

test("typed profiles are built only from owner input and bound to the resolved repository and base", () => {
  const profile = deliveryProfile(undefined, { repository: "Acme/Widget", base: "main" });
  assert.deepEqual(profile, PROFILE);
  assert.deepEqual(deliveryProfile({ action: "pull_request", completion: "integrated" }, { repository: "acme/widget", base: "main" }).completion, { condition: "integrated" });
  assert.deepEqual(deliveryProfile(undefined, { completion: "integrated", repository: "acme/widget", base: "main" }).completion, { condition: "integrated" });
  for (const action of ["merge", "deploy"]) assert.throws(() => deliveryProfile({ action }, { repository: "acme/widget", base: "main" }), e => e.code === "TASK_INPUT" && /explicit supported .* control and authorization/.test(e.message));
  assert.throws(() => deliveryProfile({ action: "publish" }, { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile({ action: "pull_request", completion: "integrated" }, { completion: "delivery_ready", repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile({ action: "pull_request", merge: true }, { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.throws(() => deliveryProfile("pull_request", { repository: "acme/widget", base: "main" }), { code: "TASK_INPUT" });
  assert.equal(DELIVERY_CAPABILITIES.actions.filter(a => a.supported).map(a => a.id).join(), "pull_request");
  assert.deepEqual(DELIVERY_CAPABILITIES.expandableBy, []);
  assert.equal(stableProfile(PROFILE), JSON.stringify(PROFILE));
});

test("saved profiles validate strictly and unsupported versions fail closed with a recovery path", () => {
  assert.deepEqual(validateDeliveryProfile(PROFILE), PROFILE);
  for (const broken of [{ ...PROFILE, version: 2 }, { ...PROFILE, action: "merge" }, { ...PROFILE, target: { ...PROFILE.target, kind: "gitlab" } }, { ...PROFILE, completion: { condition: "shipped" } }, { ...PROFILE, extra: true }, null, "pull_request"]) {
    assert.throws(() => validateDeliveryProfile(broken), e => e.code === "TASK_PROFILE_UNSUPPORTED" && /prepare a new task/.test(e.message));
  }
  const view = profileView({ deliveryProfile: { ...PROFILE, version: 2 } });
  assert.equal(view.supported, false); assert.equal(view.error.code, "TASK_PROFILE_UNSUPPORTED"); assert.match(view.error.message, /does not pin the namespace/);
  assert.deepEqual(profileView({ completion: { version: 1, target: "integrated" } }), { legacy: true, version: null, action: null, target: null, completion: { condition: "integrated" }, supported: true, source: "completion-target", label: "Historical task; its original interpretation is retained" });
  assert.equal(profileView({ ownerDelivery: { version: 5 } }).source, "owner-delivery-contract");
  assert.equal(profileView({ deliveryProfile: PROFILE }).mergeAuthorized, false);
});

test("the delivery screen is deterministic over the fixture corpus and masks literal examples", () => {
  for (const fixture of profileRequests) {
    const first = deliveryScreen(fixture.text), second = deliveryScreen(fixture.text);
    assert.deepEqual(first, second, fixture.text);
    assert.equal(first.tier, fixture.screen.tier, `${fixture.kind}: ${fixture.text} → ${JSON.stringify(first)}`);
    for (const term of fixture.screen.terms || []) assert.ok(first.terms.includes(term), `${fixture.text} should mention ${term}`);
  }
  assert.equal(maskLiterals('Keep "do not push" and `merge main` and “deploy” visible?'), 'Keep ' + " ".repeat(13) + ' and ' + " ".repeat(12) + ' and ' + " ".repeat(8) + ' visible?');
  assert.equal(deliveryScreen('"Unmatched quote hides nothing: merge it').tier, "question");
  // Emphasis directly after a control phrase is the control's target, not an example, and an introductory colon does not end the statement.
  for (const text of ['Do not "open a pull request" for this.', "Do not `open a pull request` for this.", "Do not: open a pull request.", "Do not -- open a pull request.", 'Never “merge the PR”.']) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.controlled.includes(/merge/.test(text) ? "merge" : "pull_request"), `${text} → ${JSON.stringify(screen)}`);
  }
  assert.equal(maskLiterals('Do not "open a pull request".'), 'Do not "open a pull request".');
  assert.equal(maskLiterals('Please do not ever "open a pull request".'), 'Please do not ever "open a pull request".');
  assert.ok(deliveryScreen('Please do not ever "open a pull request" for this.').controlled.includes("pull_request"));
  assert.equal(maskLiterals('Add a test; keep the "do not merge" label text.'), 'Add a test; keep the ' + " ".repeat(14) + ' label text.', "a span in an uncontrolled statement is still an example");
  // A control after the span governs it too, and a control inside another example never counts.
  assert.equal(maskLiterals('"Open a pull request" is forbidden.'), '"Open a pull request" is forbidden.');
  assert.ok(deliveryScreen('"Open a pull request" is forbidden for this change.').controlled.includes("pull_request"));
  assert.equal(deliveryScreen('Opening a `pull request` is not allowed; label it "merge later".').controlled.includes("pull_request"), true);
  assert.equal(maskLiterals('Show "do not merge" and "open a PR" labels.'), "Show " + " ".repeat(14) + " and " + " ".repeat(11) + " labels.");
  for (const text of ["Opening a pull request is out of scope.", "A merge is outside the scope of this task.", "Exclude deployment from this work.", "Implement the change, except opening a pull request.", "Do everything except create a PR.", "Do the implementation, other than opening a PR.", "Everything apart from the PR is yours.", "Implement it but not the pull request."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.controlled.length, `${text} → ${JSON.stringify(screen)}`);
  }
  assert.deepEqual(unaccountedTerms(deliveryScreen("Opening a pull request is out of scope."), { action: "pull_request" }), ["pull_request"]);
  for (const text of ["Leave the changes uncommitted.", "Leave all changes unpublished.", "Keep the branch unpushed and unmerged."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("local"), text);
  }
  assert.equal(maskLiterals('Keep the literal "open a pull request" text.'), "Keep the literal " + " ".repeat(21) + " text.");
  assert.deepEqual(statements("Do not: open a PR. Then: run tests; stop"), ["Do not: open a PR", " Then", " run tests", " stop"]);
  assert.deepEqual(deliveryScreen(""), { terms: [], controlled: [], escalated: [], controls: [], tier: "none" });
  assert.deepEqual(deliveryScreen(42), { terms: [], controlled: [], escalated: [], controls: [], tier: "none" });
  // A bare publish verb anywhere escalates; publish as a noun modifier or a feature infinitive stays an assumption.
  for (const text of ["Publish this package to npm.", "Implement export. Then publish it to the registry.", "Please publish the docs site.", "Implement the feature and publish the package to npm.", "After implementation, publish the package.", "Could you publish the package?"]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.deepEqual(screen.escalated, ["publish"], text);
    assert.deepEqual(unaccountedTerms(screen, { action: "pull_request" }), ["publish"], text);
  }
  for (const text of ["Add a publish button.", "Add a command to publish docs.", "The button publishes the report.", "Add a list of published articles.", "Show the publish status on the page."]) assert.equal(deliveryScreen(text).tier, "assumption", text);
  // Shipping, rollout and go-live wording, and a production destination, read as deployment.
  for (const text of ["Ship this change to production.", "Roll this out to production.", "Implement export, then roll it out.", "Go live with the new pricing page.", "Promote the build to staging.", "Ship it."]) {
    const screen = deliveryScreen(text);
    assert.equal(screen.tier, "question", text); assert.ok(screen.terms.includes("deploy"), `${text} → ${JSON.stringify(screen)}`);
  }
  for (const text of ["Add a shipping address field.", "Show the shipment tracker.", "Fix the crash reported in production logs."]) assert.equal(deliveryScreen(text).terms.includes("deploy"), false, text);
  // A control word elsewhere on the line does not turn an ordinary feature clause into a question.
  const unrelated = deliveryScreen("Add a PR status badge. Authentication is required.");
  assert.equal(unrelated.tier, "assumption"); assert.deepEqual(unrelated.controlled, []); assert.ok(unrelated.controls.length, "the control word is still recorded for the review");
});

test("planner delivery tags are validated and compared with the profile without granting anything", () => {
  assert.deepEqual(validateDeliveryTag({ action: "pull_request", prohibits: ["merge"] }), { action: "pull_request", prohibits: ["merge"] });
  for (const bad of [null, { action: "ship" }, { action: "pull_request", prohibits: ["rm -rf"] }, { action: "pull_request", prohibits: ["merge", "merge"] }, { action: "pull_request", completion: "done" }, { action: "pull_request", grant: "merge" }, { action: "restrict" }]) {
    assert.throws(() => validateDeliveryTag(bad));
  }
  assert.equal(profileCovers(PROFILE, { action: "pull_request" }).covered, true);
  assert.equal(profileCovers(PROFILE, { action: "pull_request", prohibits: ["merge", "deploy"] }).covered, true);
  assert.equal(profileCovers(PROFILE, { action: "restrict", prohibits: ["merge"] }).covered, true);
  for (const tag of [{ action: "merge" }, { action: "deploy" }, { action: "local_only" }, { action: "wait_for_approval" }, { action: "pull_request", prohibits: ["push"] }, { action: "restrict", prohibits: ["pull_request"] }, { action: "pull_request", completion: "integrated" }]) {
    const coverage = profileCovers(PROFILE, tag);
    assert.equal(coverage.covered, false, JSON.stringify(tag)); assert.ok(coverage.reason);
  }
  // A requested action speaks only for terms outside a control word; a prohibition only for terms under one.
  const unaccounted = (text, tag) => unaccountedTerms(deliveryScreen(text), tag);
  assert.deepEqual(unaccounted("Do not open a pull request.", { action: "pull_request" }), ["pull_request"]);
  assert.deepEqual(unaccounted("Do not open a pull request.", { action: "restrict", prohibits: ["pull_request"] }), []);
  assert.deepEqual(unaccounted("Merge the PR.", { action: "pull_request", prohibits: ["merge"] }), ["merge"]);
  assert.deepEqual(unaccounted("Merge the PR.", { action: "merge" }), []);
  assert.deepEqual(unaccounted("Open a PR for review; do not merge it.", { action: "pull_request", prohibits: ["merge"] }), []);
  // "do not push" also reads as local-only output, an escalating term no pull_request tag can speak for.
  assert.deepEqual(unaccounted("Do not push and open a PR.", { action: "pull_request", prohibits: ["push"] }), ["pull_request", "local"], "a control word binds across a conjunction");
  assert.deepEqual(deliveryScreen("Open a PR for review; do not merge it.").controlled, ["merge"]);
  const requirement = { id: "r-3", text: "Merge it." };
  assert.deepEqual(deliveryQuestion(PROFILE, requirement), deliveryQuestion(PROFILE, requirement));
  assert.equal(deliveryQuestion(PROFILE, requirement).id, "q-delivery-r-3");
  assert.doesNotMatch(deliveryQuestion(PROFILE, requirement).text, /Merge it/, "question text never echoes a planner reading");
});

test("fragments carry stable source spans into the immutable request and answers", () => {
  const text = "  Add export.  \r\n\n\tDo not add dependencies.\nOpen a PR.";
  const parts = fragments(text);
  assert.deepEqual(parts.map(p => p.id), ["r-1", "r-2", "r-3"]);
  for (const part of parts) assert.equal(text.slice(part.source.start, part.source.end), part.text);
  assert.equal(parts[0].source.of, "original");
  assert.equal(fragments("Use CSV.", "a-q-r-1")[0].source.of, "answer:q-r-1");
});

test("the brief carries the canonical profile section and the PRD checker and fingerprint read it", () => {
  const task = taskFor("Add CSV export.\nDo not add dependencies.", { commandCandidates: ["npm test"] });
  const output = parseDraft(JSON.stringify(draftFor(task)), task);
  const rendered = renderDraft(task, output);
  const prd = parsePrd(rendered, "docs/prds/task-000000000000000000000000.md");
  assert.deepEqual(deliveryProfileFromPrd(prd), PROFILE);
  assert.equal(check(prd).ok, true);
  assert.equal(contractOf(prd).deliveryProfile.trim(), "```json\n" + stableProfile(PROFILE) + "\n```");
  const edited = rendered.replace('"action":"pull_request"', '"action":"merge"');
  const verdict = check(parsePrd(edited, prd.path));
  assert.equal(verdict.ok, false); assert.match(verdict.results.find(r => r.id === "criteria").detail, /not supported/);
  assert.notEqual(contractOf(parsePrd(edited, prd.path)).deliveryProfile, contractOf(prd).deliveryProfile, "editing the profile changes the contract");
  const doubled = rendered.replace("## Delivery profile", "## Delivery profile\n\n```json\n{}\n```\n\n## Delivery profile");
  assert.equal(check(parsePrd(doubled, prd.path)).ok, false);
});

test("mapping targets include explicit assumptions and planner output cannot author reserved questions", () => {
  const task = taskFor("Add CSV export.\nWe use Postgres in production.", { commandCandidates: ["npm test"] });
  const out = draftFor(task, { assumptions: { "r-2": "The Postgres note is context only; no database change is requested." } });
  const parsed = parseDraft(JSON.stringify(out), task);
  assert.deepEqual(parsed.mapping[1], { requirementId: "r-2", assumption: "The Postgres note is context only; no database change is requested." });
  assert.match(renderDraft(task, parsed), /r-2: "We use Postgres in production\." → assumption "The Postgres note is context only/);
  const missing = draftFor(task, { assumptions: { "r-2": "Not listed." } }); missing.assumptions = ["Export includes the currently visible rows."];
  assert.throws(() => parseDraft(JSON.stringify(missing), task), /must appear verbatim in assumptions/);
  const both = draftFor(task); both.mapping[1].assumption = both.assumptions[0];
  assert.throws(() => parseDraft(JSON.stringify(both), task), /criteria or one explicit assumption, not both/);
  const forged = draftFor(task); forged.questions = [{ id: "q-delivery-r-1", text: "Shall I merge?", requirements: ["r-1"] }]; forged.mapping[0] = { requirementId: "r-1", questionId: "q-delivery-r-1" };
  assert.throws(() => parseDraft(JSON.stringify(forged), task), /reserved for the delivery profile/);
  const badTag = draftFor(task); badTag.mapping[0].delivery = { action: "grant-merge" };
  assert.throws(() => parseDraft(JSON.stringify(badTag), task), /delivery tag action must be one of/);
  const legacy = taskFor("Add CSV export.", { deliveryProfile: undefined, commandCandidates: ["npm test"] });
  const tagged = draftFor(legacy); tagged.mapping[0].delivery = { action: "pull_request" };
  assert.throws(() => parseDraft(JSON.stringify(tagged), legacy), /delivery tags require a typed delivery profile/);
});

test("intake model configuration is validated, ceilings cannot be raised and secrets stay in the environment", () => {
  assert.deepEqual(intakeModelProblems(ROUTE), []);
  const validated = validateIntakeModelConfig(ROUTE);
  assert.equal(validated.budget.maxCalls, 3); assert.equal(validated.credentialEnv, "FIXTURE_MODEL_KEY");
  for (const [patch, pattern] of [
    [{ budget: { ...ROUTE.budget, max_calls: 4 } }, /max_calls must be an integer from 1 to 3/],
    [{ budget: { ...ROUTE.budget, max_input_tokens: 50001 } }, /max_input_tokens/],
    [{ budget: { ...ROUTE.budget, max_output_tokens: 6001 } }, /max_output_tokens/],
    [{ budget: { ...ROUTE.budget, allowance_usd: 0.11 } }, /allowance_usd/],
    [{ budget: { ...ROUTE.budget, input_usd_per_million: undefined } }, /input_usd_per_million/],
    [{ endpoint: "http://api.example-provider.com/v1" }, /HTTPS/],
    [{ endpoint: "https://localhost/v1" }, /public provider host/],
    [{ endpoint: "https://10.0.0.5/v1" }, /public provider host/],
    [{ endpoint: "https://user:pw@api.example-provider.com/v1" }, /HTTPS/],
    [{ adapter: "shell" }, /adapter must be one of/],
    [{ credential_env: "sk-live-123" }, /environment variable/],
    [{ api_key: "sk-live-123" }, /unknown key api_key/],
    [{ timeout_ms: 999999 }, /timeout_ms/],
  ]) assert.match(intakeModelProblems({ ...ROUTE, ...patch }).join("\n"), pattern, JSON.stringify(patch));
  assert.equal(MODEL_ROUTE_CEILINGS.allowanceUsd, 0.1);
  const disabled = intakeModelRoute({}, {});
  assert.equal(disabled.enabled, false); assert.match(disabled.reason, /intake_model is not configured/);
  const noKey = intakeModelRoute({ intake_model: ROUTE }, {});
  assert.equal(noKey.enabled, false); assert.match(noKey.reason, /export FIXTURE_MODEL_KEY/);
  assert.equal(intakeModelRoute({ intake_model: ROUTE }, { FIXTURE_MODEL_KEY: "k" }).enabled, true);
  const summary = intakeModelRouteSummary({ intake_model: ROUTE }, { FIXTURE_MODEL_KEY: "secret-value" });
  assert.doesNotMatch(JSON.stringify(summary), /secret-value|FIXTURE_MODEL_KEY|chat\/completions/);
  assert.equal(summary.endpointHost, "api.example-provider.com"); assert.deepEqual(summary.tools, []);
  // The whole operator config file validates the route together with everything else.
  const cfg = mergeConfig({ ...CONFIG, intake_model: { ...ROUTE, budget: { ...ROUTE.budget, allowance_usd: 1 } } }, CONFIG.home);
  assert.ok(validateConfig(cfg, CONFIG.home).some(problem => /allowance_usd/.test(problem)));
  assert.equal(validateConfig(mergeConfig({ ...CONFIG, intake_model: ROUTE }, CONFIG.home), CONFIG.home).filter(problem => /intake_model/.test(problem)).length, 0);
});

test("the model route records usage-derived cost, labels unknown billing honestly and never stores the key", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 800 } }); };
  const ctx = { config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-000000" }, fetch: fetcher };
  const task = taskFor("Add CSV export.", { commandCandidates: ["npm test"] }), store = memoryStore();
  const message = await prepareModelTurn(ctx, task, store, []);
  assert.equal(message, draft);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, ROUTE.endpoint); assert.equal(calls[0].init.redirect, "error");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.max_tokens, 6000); assert.equal(body.tools, undefined); assert.equal(body.functions, undefined); assert.equal(body.model, "fixture-model");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-fixture-secret-000000");
  const attempt = task.attempts[0];
  // The reservation bounds the complete billed request, not only the user prompt.
  assert.ok(attempt.estimate.inputTokens >= Buffer.byteLength(calls[0].init.body) + 64, "system message, framing fields and protocol margin are inside the bound");
  assert.ok(attempt.estimate.inputTokens > Buffer.byteLength(body.messages[1].content) + Buffer.byteLength(body.messages[0].content));
  assert.equal(attempt.route, "model"); assert.equal(isModelRouteReceipt(attempt.receipt), true); assert.equal(isModelRouteReceipt(attempt.receipt, task), true); assert.deepEqual(attempt.receipt.tools, []);
  // The receipt is bound to this task and its pinned route: a foreign task, route or model cannot replay it.
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, id: "task-" + "1".repeat(24) }), false);
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, route: "harness" }), false);
  assert.equal(isModelRouteReceipt(attempt.receipt, { ...task, modelRoute: { ...task.modelRoute, model: "other-model" } }), false);
  const foreign = taskFor("Add CSV export.", { id: "task-" + "2".repeat(24), commandCandidates: ["npm test"], attempts: [{ ...structuredClone(attempt), consumed: false }] });
  await assert.rejects(prepareModelTurn({ config: {}, env: ctx.env, fetch: async () => { throw new Error("must not call"); } }, foreign, memoryStore(), []), e => e.code === "TASK_PREPARATION_BOUNDARY" && /this task's text-only model route/.test(e.message));
  assert.deepEqual(attempt.usage, { inputTokens: 1200, outputTokens: 800 });
  assert.equal(attempt.cost, estimateUsd(validateIntakeModelConfig(ROUTE).budget, 1200, 800)); assert.equal(attempt.spend.status, "reported");
  assert.match(attempt.spend.basis, /not a provider invoice/);
  // Valid reported usage releases the pre-call reservation, so the allowance that follows this call is the reported spend, not the ceiling held during the call.
  assert.equal(attempt.reservedUsd, null); assert.ok(attempt.spend.releasedReservationUsd > attempt.cost); assert.equal(attempt.estimate.usd, attempt.spend.releasedReservationUsd);
  assert.equal(task.attempts.reduce((sum, a) => sum + Math.max(a.cost ?? 0, a.reservedUsd ?? 0), 0), attempt.cost, "the implementation allowance subtracts the reported cost only");
  assert.doesNotMatch(JSON.stringify(task) + JSON.stringify(store.saves), /sk-fixture-secret/);
  assert.ok(store.saves.length >= 2, "intent is persisted before the request and settled after it");
  assert.equal(store.saves[0].attempts[0].settled, false);
  // Without usage the cost is unknown, never zero, and the reservation stays as the bound.
  const silent = { ...ctx, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }] }) };
  const quiet = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await prepareModelTurn(silent, quiet, memoryStore(), []);
  assert.equal(quiet.attempts[0].cost, null); assert.equal(quiet.attempts[0].spend.status, "unknown"); assert.ok(quiet.attempts[0].reservedUsd > 0);
});

test("the model route stops before a call that would exceed its limits and rejects over-limit or truncated output", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const key = { FIXTURE_MODEL_KEY: "sk-fixture-key-333333" };
  let calls = 0;
  const ok = async () => { calls++; return response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }); };
  // Call ceiling: three settled calls, the fourth is refused before any request.
  const exhausted = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  exhausted.attempts = Array.from({ length: 3 }, (_, i) => ({ name: `model-${i + 1}`, route: "model", settled: true, consumed: true, ok: true, cost: 0.001, reservedUsd: 0.001, startedAt: 1 }));
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, exhausted, memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /allows 3 calls/.test(e.message));
  assert.equal(calls, 0);
  // Input token ceiling, checked before the request.
  const big = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  big.context = [{ path: "docs/big.md", text: "word ".repeat(16_000), hash: "h" }];
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(big, { ...ROUTE, budget: { ...ROUTE.budget, max_input_tokens: 20_000 } }), memoryStore(), []), e => e.code === "TASK_INPUT" && /input limit is 20000/.test(e.message));
  assert.equal(calls, 0);
  // Allowance pre-check: the estimate for one call exceeds what is left, so nothing is started and billing uncertainty is stated.
  const pricey = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(pricey, { ...ROUTE, budget: { ...ROUTE.budget, allowance_usd: 0.05, output_usd_per_million: 10 } }), memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /the call was not started/.test(e.message) && /not provider invoices/.test(e.message));
  assert.equal(calls, 0); assert.deepEqual(pricey.attempts, []);
  // The task's own allowance also bounds the route.
  const capped = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 0.0001, runtimeMs: 1000 } });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, capped, memoryStore(), []), { code: "TASK_ALLOWANCE" });
  assert.equal(calls, 0);
  // The remaining task runtime bounds the call's deadline, and too little remaining runtime refuses before the request.
  const spent = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 5, runtimeMs: 1500 }, attempts: [{ route: "model", settled: true, consumed: true, ok: true, elapsedMs: 1000, cost: 0.001 }] });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, spent, memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /500 ms left, below the 1000 ms/.test(e.message));
  assert.equal(calls, 0); assert.equal(spent.attempts.length, 1);
  const shortRun = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 5, runtimeMs: 4000 }, attempts: [{ route: "model", settled: true, consumed: true, ok: true, elapsedMs: 1000, cost: 0.001 }] });
  await prepareModelTurn({ config: {}, env: key, fetch: ok }, shortRun, memoryStore(), []);
  assert.equal(shortRun.attempts[1].timeoutMs, 3000, "the deadline is capped to the remaining runtime rather than the configured timeout"); assert.equal(shortRun.attempts[1].deadline - shortRun.attempts[1].startedAt, 3000);
  calls = 0;
  // Truncated output is rejected with a bounded error; the call is still recorded with its usage.
  const truncated = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: "{" }, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 6000 } }) }, truncated, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /incomplete/.test(e.message));
  assert.equal(truncated.attempts[0].ok, false); assert.equal(truncated.attempts[0].spend.status, "reported");
  // Over-limit output reported by the provider is rejected too.
  const over = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 6001 } }) }, over, memoryStore(), []), /above the configured limit/);
  // Provider failures keep the reservation and report unknown billing; the message never echoes the key.
  const failing = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-111111" }, fetch: async () => response("denied", { status: 401 }) }, failing, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /HTTP 401/.test(e.message) && !/sk-fixture/.test(e.message));
  assert.equal(failing.attempts[0].spend.status, "unknown"); assert.ok(failing.attempts[0].reservedUsd > 0);
  const network = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: { FIXTURE_MODEL_KEY: "sk-fixture-secret-222222" }, fetch: async () => { throw new Error("connect ECONNREFUSED sk-fixture-secret-222222"); } }, network, memoryStore(), []), e => /failed/.test(e.message) && !/sk-fixture/.test(e.message));
  // A settled failure replays without a second request; a settled success replays its message.
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, network, memoryStore(), []), { code: "TASK_MODEL_ROUTE" });
  assert.equal(calls, 0);
  const replay = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, replay, memoryStore(), []);
  assert.equal(await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, replay, memoryStore(), []), draft);
  assert.equal(calls, 1);
  // Disabled configuration is an actionable refusal, not a silent fallback.
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, taskFor("Add CSV export.", { modelRoute: undefined }), memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /no pinned model route/.test(e.message) && /no model call was made/.test(e.message));
  // A pinned route cannot carry budgets above the ceilings or run without its named credential.
  assert.throws(() => savedModelRoute({ ...pinned(ROUTE), budget: { ...pinned(ROUTE).budget, maxCalls: 9 } }), { code: "TASK_MODEL_ROUTE" });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: {}, fetch: ok }, taskFor("Add CSV export."), memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /export FIXTURE_MODEL_KEY/.test(e.message));
  assert.equal(calls, 1);
  // The Anthropic request shape is text-only too.
  const anthropic = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  let seen;
  withRoute(anthropic, { ...ROUTE, adapter: "anthropic-messages", endpoint: "https://api.example-provider.com/v1/messages" });
  await prepareModelTurn({ config: {}, env: key, fetch: async (url, init) => { seen = { url, init }; return response({ content: [{ type: "text", text: draft }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 } }); } }, anthropic, memoryStore(), []);
  assert.equal(seen.init.headers["x-api-key"], "sk-fixture-key-333333"); assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  const anthropicBody = JSON.parse(seen.init.body);
  assert.equal(anthropicBody.tools, undefined); assert.equal(anthropicBody.max_tokens, 6000);
  assert.deepEqual(anthropic.attempts[0].usage, { inputTokens: 5, outputTokens: 7 });
  // The pre-call bound is one token per UTF-8 byte, so emoji and rare scripts
  // cannot slip under the ceiling or the spend reservation.
  assert.equal(estimateTokens("abcdef"), 6); assert.equal(estimateTokens("🚀".repeat(10)), 40); assert.equal(estimateTokens("日本語"), 9);
  const emoji = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  emoji.context = [{ path: "docs/emoji.md", text: "🚀".repeat(6_000), hash: "h" }];
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, withRoute(emoji, { ...ROUTE, budget: { ...ROUTE.budget, max_input_tokens: 20_000 } }), memoryStore(), []), e => e.code === "TASK_INPUT" && /input limit is 20000/.test(e.message));
  assert.equal(calls, 1);
  // Negative or malformed usage is a malformed response: it never becomes a spend record that could offset the allowance.
  for (const usage of [{ prompt_tokens: -900, completion_tokens: 10 }, { prompt_tokens: 10, completion_tokens: -50_000 }, { prompt_tokens: 1.5, completion_tokens: 2 }, { prompt_tokens: "10", completion_tokens: 10 }]) {
    const negative = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
    await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage }) }, negative, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /usage is malformed/.test(e.message));
    assert.equal(negative.attempts[0].ok, false); assert.equal(negative.attempts[0].cost, null); assert.equal(negative.attempts[0].spend.status, "unknown"); assert.ok(negative.attempts[0].reservedUsd > 0);
  }
  // Reported input usage above the ceiling is rejected even when the byte bound passed.
  const overInput = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => response({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 50_001, completion_tokens: 10 } }) }, overInput, memoryStore(), []), /reported 50001 input tokens, above the configured limit/);
  assert.equal(overInput.attempts[0].ok, false);
});

test("the model route enforces the response limit while streaming and keeps its deadline over a stalled body", async () => {
  const draft = JSON.stringify(draftFor(taskFor("Add CSV export.", { commandCandidates: ["npm test"] })));
  const key = { FIXTURE_MODEL_KEY: "sk-fixture-key-666666" };
  // A chunked body with no Content-Length is cancelled once the limit is crossed, before it is buffered.
  let pulls = 0, cancelled = false;
  const chunk = new Uint8Array(256 * 1024).fill(32);
  const endless = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(chunk); }, cancel() { cancelled = true; } });
  const big = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => new Response(endless, { status: 200 }) }, big, memoryStore(), []), /exceeds the bounded limit/);
  assert.ok(pulls <= 6, `the reader stopped after ${pulls} chunks`); assert.equal(cancelled, true); assert.equal(big.attempts[0].spend.status, "unknown");
  // A well-formed streamed body still parses, with the usage it carries.
  const encoded = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
  const streamed = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  const parts = [encoded.subarray(0, 100), encoded.subarray(100)];
  await prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: async () => new Response(new ReadableStream({ pull(controller) { if (parts.length) controller.enqueue(parts.shift()); else controller.close(); } }), { status: 200 }) }, streamed, memoryStore(), []);
  assert.deepEqual(streamed.attempts[0].usage, { inputTokens: 20, outputTokens: 30 }); assert.equal(streamed.attempts[0].message, draft);
  // Headers arrive promptly but the body never completes: the configured timeout aborts the read and settles the attempt.
  let stalledCancelled = false;
  const stalled = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { stalledCancelled = true; } });
  const hung = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  const startedAt = Date.now();
  withRoute(hung, { ...ROUTE, timeout_ms: 1000 });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => new Response(stalled, { status: 200 }) }, hung, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /did not complete within 1000 ms/.test(e.message));
  assert.ok(Date.now() - startedAt < 5000, "the stalled body was abandoned at the deadline"); assert.equal(stalledCancelled, true);
  assert.equal(hung.attempts[0].settled, true); assert.equal(hung.attempts[0].spend.status, "unknown");
  // A complete JSON prefix followed by a stream that never closes is cancelled at the deadline and must not be accepted as a draft.
  const prefix = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30 } }));
  let prefixSent = false, openCancelled = false;
  const openEnded = new ReadableStream({ pull(controller) { if (!prefixSent) { prefixSent = true; controller.enqueue(prefix); return; } return new Promise(() => {}); }, cancel() { openCancelled = true; } });
  const dangling = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  withRoute(dangling, { ...ROUTE, timeout_ms: 1000 });
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: async () => new Response(openEnded, { status: 200 }) }, dangling, memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /did not complete within 1000 ms/.test(e.message));
  assert.equal(openCancelled, true); assert.equal(dangling.attempts[0].ok, false); assert.equal(dangling.attempts[0].message, undefined);
});

test("repository snapshots are read-only, bounded, exclude private and ignored paths and report unavailability", async () => {
  const revision = "a".repeat(40);
  const tree = ["src/app.mjs", ".env", "config/credentials.json", "keys/id_rsa", "build/out.js", "docs/a.md", "deploy.pem", "x\u0001y", "docs/removed.md"];
  const treeRequests = [];
  // The index holds a staged addition (not in the tree, never listed) and lacks a staged deletion (in the tree, excluded as unverified).
  const ruleRequests = [];
  const git = { revision: async () => revision, treePaths: async (_dir, rev) => { treeRequests.push(rev); return tree; }, indexPaths: async () => [...tree.filter(p => p !== "docs/removed.md"), "docs/staged-new.md"], ignoredTrackedPaths: async () => ["build/out.js"], ignoreRuleChanges: async (_dir, rev) => { ruleRequests.push(rev); return []; } };
  const snapshot = await repositorySnapshot(git, "/checkout");
  assert.equal(snapshot.status, "collected"); assert.equal(snapshot.revision, revision); assert.equal(snapshot.readOnly, true);
  assert.deepEqual(treeRequests, [revision], "the listing is enumerated from the recorded revision's tree");
  assert.deepEqual(ruleRequests, [revision, revision], "ignore rules are compared against the recorded revision before and after enumeration");
  // A .gitignore edit or a moved HEAD between the reads makes the collected state inconsistent: nothing is listed.
  let ruleCalls = 0;
  const racedRules = await repositorySnapshot({ ...git, ignoreRuleChanges: async () => ruleCalls++ === 0 ? [] : [".gitignore"] }, "/checkout");
  assert.equal(racedRules.status, "unavailable"); assert.match(racedRules.reason, /changed while the snapshot was being collected/); assert.deepEqual(racedRules.paths, []);
  let revisionCalls = 0;
  const racedHead = await repositorySnapshot({ ...git, revision: async () => revisionCalls++ === 0 ? revision : "b".repeat(40) }, "/checkout");
  assert.equal(racedHead.status, "unavailable"); assert.match(racedHead.reason, /changed while the snapshot was being collected/);
  // An index that changes between the listings (a staged deletion of a force-tracked ignored path) is detected by re-reading it afterwards.
  let indexCalls = 0;
  const racedIndex = await repositorySnapshot({ ...git, indexPaths: async () => { indexCalls++; return indexCalls === 1 ? [...tree, "docs/staged-new.md"] : tree.filter(p => p !== "build/out.js"); } }, "/checkout");
  assert.equal(racedIndex.status, "unavailable"); assert.match(racedIndex.reason, /revision, index or \.gitignore files changed/); assert.equal(indexCalls, 2);
  // An edited or untracked .gitignore means the rules in force are not the recorded revision's: nothing is listed or guessed.
  const diverged = await repositorySnapshot({ ...git, ignoreRuleChanges: async () => [".gitignore", "docs/.gitignore"] }, "/checkout");
  assert.equal(diverged.status, "unavailable"); assert.match(diverged.reason, /2 \.gitignore file\(s\) differ from the recorded revision/); assert.deepEqual(diverged.paths, []); assert.equal(diverged.digest, null);
  assert.deepEqual(snapshot.paths, ["docs/a.md", "src/app.mjs"]);
  assert.deepEqual(snapshot.counts, { tracked: 9, ignored: 1, private: 5, unverified: 1, listed: 2, truncated: 0 });
  assert.equal(snapshot.digest, sha(JSON.stringify({ revision, paths: ["docs/a.md", "src/app.mjs"] })));
  assert.notEqual((await repositorySnapshot({ ...git, revision: async () => "b".repeat(40) }, "/checkout")).digest, snapshot.digest, "the digest is pinned to the revision");
  const bulk = Array.from({ length: 1000 }, (_, i) => `src/file-${String(i).padStart(4, "0")}.mjs`);
  const many = await repositorySnapshot({ ...git, treePaths: async () => bulk, indexPaths: async () => bulk, ignoredTrackedPaths: async () => [], ignoreRuleChanges: async () => [] }, "/checkout");
  assert.equal(many.paths.length, REPOSITORY_CONTEXT_LIMITS.paths); assert.equal(many.counts.truncated, 1000 - REPOSITORY_CONTEXT_LIMITS.paths);
  for (const broken of [{}, { ...git, revision: async () => { throw new Error("fatal: not a git repository token=abc"); } }, { ...git, revision: async () => "HEAD" }]) {
    const result = await repositorySnapshot(broken, "/checkout", { secrets: ["abc"] });
    assert.equal(result.status, "unavailable"); assert.equal(result.digest, null); assert.deepEqual(result.paths, []); assert.doesNotMatch(result.reason, /abc/);
  }
  // A real repository through the production Git adapter.
  const home = tempHome(), repo = join(home, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.mjs"), "export const x = 1;\n"); writeFileSync(join(repo, ".env"), "SECRET=1\n"); writeFileSync(join(repo, "notes.log"), "ignored\n"); writeFileSync(join(repo, ".gitignore"), "*.log\n");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: home };
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"], ["add", "-f", "notes.log"], ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "force-add"]]) execFileSync("git", args, { cwd: repo, env, stdio: "ignore" });
  const real = await repositorySnapshot(makeGit({ config: { home, worktrees: join(home, "wt") } }), repo);
  assert.equal(real.status, "collected"); assert.match(real.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(real.paths, [".gitignore", "src/index.mjs"]); assert.equal(real.counts.ignored, 1); assert.equal(real.counts.private, 1);
});

test("the screen and mapping stay fast at the request and mapping limits", () => {
  const clause = "Implement export and merge the PR after approval; do not push until reviewed. ";
  const text = clause.repeat(Math.floor(MAX_INPUT_BYTES / clause.length));
  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) deliveryScreen(text);
  const perCall = Number(process.hrtime.bigint() - started) / 20 / 1e6;
  assert.ok(perCall < 50, `screening a ${Buffer.byteLength(text)} byte request took ${perCall.toFixed(1)} ms`);
  const lines = Array.from({ length: 64 }, (_, i) => `Merge ${i + 1}.`).join("\n");
  const task = taskFor(lines, { commandCandidates: ["npm test"] });
  const out = draftFor(task);
  const parseStart = process.hrtime.bigint();
  const parsed = parseDraft(JSON.stringify(out), task);
  renderDraft(task, parsed);
  const elapsed = Number(process.hrtime.bigint() - parseStart) / 1e6;
  assert.equal(parsed.questions.length, 64, "every escalating clause is screened");
  assert.ok(elapsed < 2000, `parsing and rendering 64 screened clauses took ${elapsed.toFixed(0)} ms`);
  assert.ok(Buffer.byteLength(draftPrompt(task)) < 120 * 1024);
});

test("the vendored validator and fixture corpus are pinned byte-for-byte with their schema version", () => {
  const saved = savedContract(), current = currentContract();
  assert.deepEqual(contractDrift(), [], "run npm run contract:intake -- --write after reviewing a validator change");
  assert.equal(saved.profileVersion, PROFILE_VERSION); assert.equal(saved.validator, "lib/task_profile.mjs");
  assert.equal(saved.files["lib/task_profile.mjs"], sha(readFileSync(new URL("../lib/task_profile.mjs", import.meta.url))));
  assert.equal(current.files["templates/plugin/task-profile-requests.mjs"], saved.files["templates/plugin/task-profile-requests.mjs"]);
  // Both pinned files live under packaged paths, so the published artifact carries the exact corpus.
  const packaged = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).files;
  for (const path of Object.keys(saved.files)) assert.ok(packaged.some(entry => path === entry || path.startsWith(entry + "/")), `${path} is inside the package allowlist`);
  assert.match(saved.upgrade, /task-intake-vendor-sync/);
  // The vendored validator loads on its own: no imports, so the pinned hash covers every rule it applies.
  const source = readFileSync(new URL("../lib/task_profile.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^\s*import\s/m); assert.doesNotMatch(source, /\brequire\(/);
  assert.deepEqual([...COMPLETION_CONDITIONS], COMPLETION_SCHEMA.properties.target.enum, "the self-contained copy of the completion conditions matches the coordinator schema");
});
