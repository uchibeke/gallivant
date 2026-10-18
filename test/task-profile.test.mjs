import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deliveryProfile, validateDeliveryProfile, stableProfile, deliveryScreen, maskLiterals, validateDeliveryTag, profileCovers, deliveryQuestion, deliveryProfileFromPrd, profileView, DELIVERY_CAPABILITIES, PROFILE_VERSION } from "../lib/task_profile.mjs";
import { intakeModelProblems, validateIntakeModelConfig, intakeModelRoute, intakeModelRouteSummary, MODEL_ROUTE_CEILINGS } from "../lib/task_model_config.mjs";
import { prepareModelTurn, isModelRouteReceipt, estimateTokens, estimateUsd } from "../lib/task_model_route.mjs";
import { repositorySnapshot, REPOSITORY_CONTEXT_LIMITS } from "../lib/task_repository_context.mjs";
import { fragments, parseDraft, renderDraft, draftPrompt, MAX_INPUT_BYTES } from "../lib/task_contract.mjs";
import { check, parsePrd, contractOf } from "../lib/prd.mjs";
import { validate as validateConfig, merge as mergeConfig } from "../lib/config.mjs";
import { makeGit } from "../lib/git.mjs";
import { profileRequests } from "./fixtures/task-profile-requests.mjs";
import { draftFor } from "./fixtures/task-intake.mjs";
import { currentContract, savedContract, contractDrift } from "../scripts/task-intake-contract.mjs";
import { tempHome, CONFIG } from "./helpers.mjs";

const PROFILE = { version: 1, action: "pull_request", target: { kind: "github-pull-request", repository: "acme/widget", base: "main" }, completion: { condition: "delivery_ready" } };
const ROUTE = { adapter: "openai-chat", model: "fixture-model", endpoint: "https://api.example-provider.com/v1/chat/completions", credential_env: "FIXTURE_MODEL_KEY",
  budget: { max_calls: 3, max_input_tokens: 50000, max_output_tokens: 6000, allowance_usd: 0.1, input_usd_per_million: 1, output_usd_per_million: 10 }, timeout_ms: 5000 };
const sha = value => createHash("sha256").update(value).digest("hex");

function taskFor(text, overrides = {}) {
  const requirements = fragments(text);
  return { id: "task-" + "0".repeat(24), original: text, requirements, answers: {}, questionHistory: {}, questionMappings: {}, context: [{ path: "package.json", text: JSON.stringify({ scripts: { test: "node --test" }, packageManager: "npm@10.0.0" }), hash: "x" }],
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
  assert.deepEqual(deliveryScreen(""), { terms: [], controls: [], tier: "none" });
  assert.deepEqual(deliveryScreen(42), { terms: [], controls: [], tier: "none" });
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
  assert.equal(attempt.route, "model"); assert.equal(isModelRouteReceipt(attempt.receipt), true); assert.deepEqual(attempt.receipt.tools, []);
  assert.deepEqual(attempt.usage, { inputTokens: 1200, outputTokens: 800 });
  assert.equal(attempt.cost, estimateUsd(validateIntakeModelConfig(ROUTE).budget, 1200, 800)); assert.equal(attempt.spend.status, "reported");
  assert.match(attempt.spend.basis, /not a provider invoice/);
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
  await assert.rejects(prepareModelTurn({ config: { intake_model: { ...ROUTE, budget: { ...ROUTE.budget, max_input_tokens: 20_000 } } }, env: key, fetch: ok }, big, memoryStore(), []), e => e.code === "TASK_INPUT" && /input limit is 20000/.test(e.message));
  assert.equal(calls, 0);
  // Allowance pre-check: the estimate for one call exceeds what is left, so nothing is started and billing uncertainty is stated.
  const pricey = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  await assert.rejects(prepareModelTurn({ config: { intake_model: { ...ROUTE, budget: { ...ROUTE.budget, allowance_usd: 0.05, output_usd_per_million: 10 } } }, env: key, fetch: ok }, pricey, memoryStore(), []), e => e.code === "TASK_ALLOWANCE" && /the call was not started/.test(e.message) && /not provider invoices/.test(e.message));
  assert.equal(calls, 0); assert.deepEqual(pricey.attempts, []);
  // The task's own allowance also bounds the route.
  const capped = taskFor("Add CSV export.", { commandCandidates: ["npm test"], allowance: { budgetUsd: 0.0001, runtimeMs: 1000 } });
  await assert.rejects(prepareModelTurn({ config: { intake_model: ROUTE }, env: key, fetch: ok }, capped, memoryStore(), []), { code: "TASK_ALLOWANCE" });
  assert.equal(calls, 0);
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
  await assert.rejects(prepareModelTurn({ config: {}, env: key, fetch: ok }, taskFor("Add CSV export."), memoryStore(), []), e => e.code === "TASK_MODEL_ROUTE" && /no model call was made/.test(e.message));
  // The Anthropic request shape is text-only too.
  const anthropic = taskFor("Add CSV export.", { commandCandidates: ["npm test"] });
  let seen;
  await prepareModelTurn({ config: { intake_model: { ...ROUTE, adapter: "anthropic-messages", endpoint: "https://api.example-provider.com/v1/messages" } }, env: key, fetch: async (url, init) => { seen = { url, init }; return response({ content: [{ type: "text", text: draft }], stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 7 } }); } }, anthropic, memoryStore(), []);
  assert.equal(seen.init.headers["x-api-key"], "sk-fixture-key-333333"); assert.equal(seen.init.headers["anthropic-version"], "2023-06-01");
  const anthropicBody = JSON.parse(seen.init.body);
  assert.equal(anthropicBody.tools, undefined); assert.equal(anthropicBody.max_tokens, 6000);
  assert.deepEqual(anthropic.attempts[0].usage, { inputTokens: 5, outputTokens: 7 });
  assert.ok(estimateTokens("abcdef") >= 2);
});

test("repository snapshots are read-only, bounded, exclude private and ignored paths and report unavailability", async () => {
  const revision = "a".repeat(40);
  const git = { revision: async () => revision, trackedPaths: async () => ["src/app.mjs", ".env", "config/credentials.json", "keys/id_rsa", "build/out.js", "docs/a.md", "deploy.pem", "xy"], ignoredTrackedPaths: async () => ["build/out.js"] };
  const snapshot = await repositorySnapshot(git, "/checkout");
  assert.equal(snapshot.status, "collected"); assert.equal(snapshot.revision, revision); assert.equal(snapshot.readOnly, true);
  assert.deepEqual(snapshot.paths, ["docs/a.md", "src/app.mjs"]);
  assert.deepEqual(snapshot.counts, { tracked: 8, ignored: 1, private: 5, listed: 2, truncated: 0 });
  assert.equal(snapshot.digest, sha(JSON.stringify({ revision, paths: ["docs/a.md", "src/app.mjs"] })));
  assert.notEqual((await repositorySnapshot({ ...git, revision: async () => "b".repeat(40) }, "/checkout")).digest, snapshot.digest, "the digest is pinned to the revision");
  const many = await repositorySnapshot({ ...git, trackedPaths: async () => Array.from({ length: 1000 }, (_, i) => `src/file-${String(i).padStart(4, "0")}.mjs`), ignoredTrackedPaths: async () => [] }, "/checkout");
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
  assert.equal(current.files["test/fixtures/task-profile-requests.mjs"], saved.files["test/fixtures/task-profile-requests.mjs"]);
  assert.match(saved.upgrade, /task-intake-vendor-sync/);
});
