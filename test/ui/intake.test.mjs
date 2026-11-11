import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { intakeFixture, INTAKE_REQUEST } from "./intake-fixture.mjs";
import { taskStore } from "../../lib/task_store.mjs";
import { createTaskService } from "../../lib/tasks.mjs";
import { intakeRevisionOperation } from "../../lib/tracker/intake_contract.mjs";
import { intakeCapabilities } from "../../lib/tracker/intake_service.mjs";
import { NOW, MALICIOUS } from "./fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30_000 });
after(async () => { await browser?.close(); });
async function open(t, options = {}) {
  const world = await intakeFixture(options), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(NOW) });
  t.after(async () => { await context.close(); await world.close(); assert.deepEqual(errors, []); });
  return { ...world, page, context };
}
async function fill(page, text = INTAKE_REQUEST) {
  await page.locator("#intake-repository").selectOption("acme/widget");
  await page.locator("#intake-harness").selectOption("codex");
  await page.locator("#intake-text").fill(text);
}
const state = (page, value) => page.waitForFunction(value => document.querySelector("#intake-review")?.dataset.status === value, value);
async function prepare(page) {
  await fill(page);
  await page.getByRole("button", { name: "Prepare requirements", exact: true }).click();
  await state(page, "needs-input");
}
async function answer(page) {
  await page.getByLabel("Which file format should export use?").fill("Use CSV.");
  await page.getByRole("button", { name: "Save answers and prepare", exact: true }).click();
  await state(page, "ready");
}
const post = async (world, base, token, action, input, headers = {}) => {
  const response = await fetch(`${world.origin}${base}/api/task/intake/${action}`, { method: "POST", headers: { origin: world.origin, "content-type": "application/json", "x-gallivant-token": token, ...headers }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
};

for (const base of ["", "/gallivant"]) test(`protected intake adapters reuse CLI contracts at ${base || "/"}`, { timeout: 30_000 }, async t => {
  const world = await open(t), { page, origin, calls, ctx, home } = world;
  await page.goto(`${origin}${base}/task/new?theme=dark`);
  const token = await page.locator("[data-intake]").getAttribute("data-token"), before = { ...calls };
  await page.reload();
  assert.deepEqual(calls, before, "GET and refresh run no host, Git, inference, readiness or dispatch");
  const input = { repositoryId: "acme/widget", text: INTAKE_REQUEST, harness: "codex", route: "harness", delivery: { action: "pull_request", completion: "delivery_ready" }, operationId: "route-prepare", expectedRevision: 0 };
  for (const headers of [{ origin: "https://evil.example" }, { "x-gallivant-token": "wrong" }, { "content-type": "text/plain" }]) assert.ok((await post(world, base, token, "prepare", input, headers)).status >= 400);
  for (const extra of [{ dir: "/tmp/elsewhere" }, { route: undefined }, { repositoryId: "other/repo" }, { run: true }, { endpoint: "https://example.com" }, { text: "x".repeat(40000) }]) assert.ok((await post(world, base, token, "prepare", { ...input, ...extra })).status >= 400);
  assert.deepEqual(calls, before);
  assert.equal((await post(world, base, token, "prepare", { ...input, completion: { target: "integrated" } })).status, 409, "conflicting portable completion inputs are not silently ignored");
  const prepared = await post(world, base, token, "prepare", input);
  assert.equal(prepared.status, 200, JSON.stringify(prepared));
  assert.equal(prepared.body.task.status, "needs-input");
  assert.equal(calls.prepare, 1); assert.equal(calls.start, 0);
  const replay = await post(world, base, token, "prepare", input);
  assert.deepEqual(replay.body.task, prepared.body.task); assert.equal(calls.prepare, 1);
  assert.equal((await post(world, base, token, "prepare", { ...input, text: "Different work." })).status, 409);
  const task = prepared.body.task, a = { taskId: task.taskId, expectedRevision: task.revision, operationId: "route-answer", answers: { "q-r-1": "Use CSV." } };
  const answered = await post(world, base, token, "answer", a);
  assert.equal(answered.body.task.status, "ready", JSON.stringify(answered.body));
  assert.equal(calls.ready, 1); assert.equal(calls.start, 0);
  assert.equal(taskStore(home).read(task.taskId).runAuthorized, false);
  assert.equal(createTaskService(ctx).inspect({ taskId: task.taskId }).revision, answered.body.task.revision);
  assert.equal((await post(world, base, token, "answer", a)).status, 200);
  assert.equal(calls.prepare, 2);
  const ready = answered.body.task, start = { taskId: task.taskId, expectedRevision: ready.revision, operationId: intakeRevisionOperation("start", task.taskId, ready.revision), run: true };
  assert.equal((await post(world, base, token, "start", { ...start, expectedRevision: ready.revision + 1 })).status, 409);
  assert.equal((await post(world, base, token, "start", { ...start, run: false })).status, 409);
  const started = await post(world, base, token, "start", start);
  assert.equal(started.body.task.status, "started", JSON.stringify(started.body));
  assert.equal(started.body.task.approval.revision, ready.revision);
  assert.equal(started.body.task.approval.digest, ready.review.digest);
  assert.equal((await post(world, base, token, "start", start)).status, 409, "stale replay cannot approve a different revision");
  assert.equal(calls.start, 1); assert.equal(calls.ready, 1);
  assert.equal([...world.runners.values()].flatMap(r => r.started).length, 1);
  // Intake starts register the immutable brief snapshot, which is not a Git
  // checkout. Future preparations resolve the original source through task.id.
  ctx.state.remove("acme/widget/source");
  assert.equal(intakeCapabilities(ctx).repositories[0].available, true);
  const next = await post(world, base, token, "prepare", { ...input, operationId: "second-source-checkout" });
  assert.equal(next.body.task.status, "needs-input", JSON.stringify(next.body));
});

for (const base of ["", "/gallivant"]) test(`verification review matches the saved brief at ${base || "/"}`, { timeout: 30_000 }, async t => {
  const { page, origin, calls, home } = await open(t, { selectedVerify: ["npm test"] });
  await page.goto(`${origin}${base}/task/new`); await prepare(page); await answer(page);
  const checks = page.getByRole("heading", { name: "Verification", exact: true }).locator("xpath=following-sibling::ul[1]/li");
  assert.deepEqual(await checks.allTextContents(), ["npm test"]);
  const task = taskStore(home).list()[0];
  assert.ok(task.commandCandidates.includes("npm run lint"));
  assert.deepEqual(task.output.verify, ["npm test"]);
  const response = await fetch(`${origin}${base}/api/task/intake?taskId=${task.id}`), view = await response.json();
  assert.deepEqual(view.task.selectedVerifyCommands, ["npm test"]);
  await page.reload(); assert.deepEqual(await checks.allTextContents(), ["npm test"]);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("intake-refresh").disabled);
  assert.deepEqual(await checks.allTextContents(), ["npm test"]);
  assert.equal(calls.start, 0);
});

test("competing tabs and draft checkpoints cannot replace an unresolved preparation identity", { timeout: 30_000 }, async t => {
  const { page, context, origin, calls } = await open(t), other = await context.newPage();
  await page.goto(`${origin}/task/new`); await other.goto(`${origin}/gallivant/task/new`);
  await fill(page); await fill(other);
  let posts = 0;
  await context.route("**/api/task/intake/prepare?*", async route => { posts++; await route.fetch(); await route.abort(); });
  await Promise.all([page, other].map(p => p.locator("#intake-request").evaluate(form => form.requestSubmit())));
  await page.waitForFunction(() => Object.keys(localStorage).some(key => key.endsWith(":operation")));
  await other.locator("#intake-text").fill("A different unsent draft.");
  const pending = await other.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.endsWith(":operation")))));
  assert.equal(pending.input.text, INTAKE_REQUEST);
  await page.waitForFunction(() => !document.getElementById("intake-refresh").disabled);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click(); await state(page, "needs-input");
  assert.equal(posts, 1); assert.equal(calls.prepare, 1); assert.equal(calls.start, 0);
});

test("unknown task links, storage refusal and credential-bearing failures remain safe", { timeout: 30_000 }, async t => {
  const { page, context, origin, ctx, calls } = await open(t);
  await page.goto(`${origin}/task/new?task=task-${"a".repeat(24)}`);
  assert.equal(await page.locator("#intake-request-section").isVisible(), false);
  await page.goto(`${origin}/task/new`); await fill(page);
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error("full"); }; });
  await page.getByRole("button", { name: "Prepare requirements", exact: true }).click();
  assert.match(await page.locator("#intake-status").textContent(), /storage is unavailable or full/);
  assert.equal(calls.prepare, 0);
  const fresh = await context.newPage(); await fresh.goto(`${origin}/task/new`);
  const token = await fresh.locator("[data-intake]").getAttribute("data-token");
  ctx.git.toplevel = async () => { throw new Error("private-provider-secret and /private/credential/path"); };
  const result = await post({ origin }, "", token, "prepare", { repositoryId: "acme/widget", text: INTAKE_REQUEST, harness: "codex", route: "harness", delivery: { action: "pull_request" }, operationId: "private-failure", expectedRevision: 0 });
  assert.equal(result.status, 409); assert.doesNotMatch(JSON.stringify(result.body), /private-provider-secret|credential\/path/);
});

test("keyboard clarification, cancel and explicit Start open the authoritative workspace", { timeout: 30_000 }, async t => {
  const { page, origin, calls, home } = await open(t);
  await page.goto(`${origin}/gallivant/task/new?theme=dark`);
  await fill(page, "   ");
  await page.locator("#intake-prepare").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#intake-text").getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator("#intake-text").evaluate(el => el === document.activeElement), true);
  await prepare(page);
  await page.getByLabel("Which file format should export use?").fill("Use CSV.");
  await page.reload();
  assert.equal(await page.getByLabel("Which file format should export use?").inputValue(), "Use CSV.");
  await answer(page);
  for (const title of ["Deliverables & requirements", "Acceptance criteria", "Verification", "Delivery & permissions"]) assert.ok(await page.getByRole("heading", { name: title, exact: true }).isVisible());
  const saved = taskStore(home).list()[0]; assert.equal(saved.runAuthorized, false);
  await page.getByRole("button", { name: "Review Start", exact: true }).focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#intake-cancel").evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Enter"); assert.equal(calls.start, 0);
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Start approved revision", exact: true }).focus(); await page.keyboard.press("Enter");
  await page.waitForURL(/\/gallivant\/run\?theme=dark&id=/);
  assert.equal(calls.start, 1); assert.equal(calls.ready, 1);
  assert.equal(new URL(page.url()).searchParams.get("id"), taskStore(home).list()[0].implementation.id);
});

test("uncertain preparation survives reload and double submission without another model turn", { timeout: 30_000 }, async t => {
  const { page, origin, calls } = await open(t);
  await page.goto(`${origin}/task/new`); await fill(page);
  let posts = 0;
  await page.route("**/api/task/intake/prepare?*", async route => { posts++; await route.fetch(); await route.abort(); });
  await page.locator("#intake-prepare").evaluate(el => { el.click(); el.click(); });
  await page.waitForFunction(() => document.getElementById("intake-status").textContent.includes("Response uncertain"));
  await page.reload(); assert.equal(calls.prepare, 1);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click(); await state(page, "needs-input");
  assert.equal(posts, 1); assert.equal(calls.start, 0);
  assert.equal(await page.locator("#intake-retry").isVisible(), false);
});

test("a delayed refresh preserves answer text, keyboard focus and caret", { timeout: 30_000 }, async t => {
  const { page, origin } = await open(t);
  await page.goto(`${origin}/task/new`); await prepare(page);
  let release, received;
  const read = new Promise(resolve => { received = resolve; });
  await page.route("**/api/task/intake?*", async route => {
    const response = await route.fetch(); received();
    await new Promise(resolve => { release = resolve; }); await route.fulfill({ response });
  });
  t.after(() => release?.());
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click(); await read;
  const field = page.getByLabel("Which file format should export use?");
  await field.fill("Use CSV and preserve every visible row.");
  await field.evaluate(el => { el.focus(); el.setSelectionRange(4, 7, "backward"); });
  release();
  await page.waitForFunction(() => !document.getElementById("intake-refresh").disabled);
  assert.deepEqual(await field.evaluate(el => ({ value: el.value, focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection })),
    { value: "Use CSV and preserve every visible row.", focused: true, start: 4, end: 7, direction: "backward" });
});

test("unaccepted answer retries exact input after observation, while failed preparation retains answers", { timeout: 30_000 }, async t => {
  const world = await open(t), { page, origin, calls, home } = world;
  await page.goto(`${origin}/task/new`); await prepare(page);
  let fail = true; const inputs = [];
  await page.route("**/api/task/intake/answer?*", async route => { inputs.push(route.request().postDataJSON()); return fail ? route.abort() : route.continue(); });
  await page.getByLabel("Which file format should export use?").fill("Use CSV.");
  await page.getByRole("button", { name: "Save answers and prepare", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("intake-status").textContent.includes("Response uncertain"));
  await page.reload();
  assert.equal(await page.locator("#intake-retry").isDisabled(), true);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("intake-retry").disabled);
  fail = false; world.failPreparation(new Error("Provider unavailable; repair account access."));
  await page.getByRole("button", { name: "Retry same request", exact: true }).click(); await state(page, "blocked");
  assert.deepEqual(inputs[0], inputs[1]);
  const saved = taskStore(home).list()[0]; assert.equal(saved.answers["q-r-1"], "Use CSV."); assert.ok(saved.draft);
  assert.equal(calls.start, 0); assert.equal(saved.runAuthorized, false);
});

test("stale review cannot start another contract and hostile text is escaped", { timeout: 30_000 }, async t => {
  const { page, origin, home, calls } = await open(t);
  await page.goto(`${origin}/task/new`); await prepare(page); await answer(page);
  const store = taskStore(home), saved = store.list()[0];
  saved.revision++; saved.failures = [MALICIOUS]; store.save(saved);
  await page.getByRole("button", { name: "Review Start", exact: true }).click();
  await page.getByRole("button", { name: "Start approved revision", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("intake-status").textContent.includes("revision or operation changed"));
  assert.equal(calls.start, 0);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("intake-review").textContent.includes("<img"));
  assert.equal(await page.locator("#intake-review img").count(), 0); assert.equal(await page.evaluate(() => window.injected), undefined);
});

test("clarification can add missing verification and retains it on reload", { timeout: 30_000 }, async t => {
  const { page, origin, checkout, home, calls } = await open(t);
  rmSync(join(checkout, "package.json")); rmSync(join(checkout, "AGENTS.md"));
  await page.goto(`${origin}/task/new`); await prepare(page);
  await page.getByLabel("Which file format should export use?").fill("Use CSV and verify using python -m unittest.");
  await page.locator("#intake-answer-verify").fill("python -m unittest");
  await page.reload();
  assert.equal(await page.locator("#intake-answer-verify").inputValue(), "python -m unittest");
  await page.getByRole("button", { name: "Save answers and prepare", exact: true }).click(); await state(page, "ready");
  assert.deepEqual(taskStore(home).list()[0].explicitVerifyCommands, ["python -m unittest"]);
  assert.match(await page.locator("#intake-review").textContent(), /python -m unittest/); assert.equal(calls.start, 0);
});

test("an unsupported saved profile stays disabled after browser initialization and refresh", { timeout: 30_000 }, async t => {
  const { page, origin, home, calls } = await open(t);
  await page.goto(`${origin}/task/new`); await prepare(page); await answer(page);
  const store = taskStore(home), saved = store.list()[0]; saved.deliveryProfile.version = 999; store.save(saved);
  await page.reload(); assert.equal(await page.locator("#intake-open-start").isDisabled(), true);
  await page.getByRole("button", { name: "Refresh saved status", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("intake-refresh").disabled);
  assert.equal(await page.locator("#intake-open-start").isDisabled(), true); assert.equal(calls.start, 0);
});

for (const options of [{ unsupported: true }, { missing: true }]) test(`capability remedies remain truthful ${JSON.stringify(options)}`, async t => {
  const { page, origin, calls } = await open(t, options);
  await page.goto(`${origin}/task/new`); await fill(page);
  assert.equal(await page.locator("#intake-prepare").isDisabled(), true);
  assert.match(await page.locator("#intake-provider-help").textContent(), /tool-free|registered source checkout/);
  await page.locator("#intake-route").selectOption("model");
  assert.equal(await page.locator("#intake-prepare").isDisabled(), true);
  assert.equal(calls.prepare, 0); assert.equal(calls.host, 0); assert.equal(calls.git, 0);
});

test("both themes, narrow screens, enlarged text and axe preserve usable review", { timeout: 45_000 }, async t => {
  const { page, origin } = await open(t);
  await page.goto(`${origin}/task/new?theme=dark`); await prepare(page); await answer(page);
  for (const theme of ["dark", "light"]) {
    await page.locator(".menu summary").click(); await page.locator("#theme").selectOption(theme); await page.keyboard.press("Escape");
    for (const width of [360, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const audit = await new AxeBuilder({ page }).analyze(); assert.deepEqual(audit.violations, []);
  }
  await page.setViewportSize({ width: 844, height: 390 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addStyleTag({ url: `${origin}/zoom.css` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});
