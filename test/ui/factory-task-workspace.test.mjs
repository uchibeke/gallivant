import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { makeRecoveryCooldowns, providerScope } from "../../lib/recovery_cooldown.mjs";
import { GOOD_PRD } from "../helpers.mjs";
import { fixture, NOW, RUN, TASK } from "./fixture.mjs";
import { settleControl } from "./controls-fixture.mjs";
import { ACTOR, diamondPlans, planFixture, REPO } from "./dependency-plans-fixture.mjs";
import { HEALTH_SECRET, seedHealth } from "./health-fixture.mjs";
import { OLD_RUN, seedWorkspace } from "./workspace-fixture.mjs";

const MOUNTS = ["", "/gallivant"], THEMES = ["light", "dark"];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
const HEAD = "b".repeat(40), BASE = "a".repeat(40), BEFORE = "2026-09-24T14:07:00.000Z";
let browser;
before(async () => { browser = await chromium.launch({ timeout: 15_000 }); }, { timeout: 20_000 });
after(async () => { await browser?.close(); });

async function open(t, world, headers = {}) {
  if (!world) {
    world = await fixture();
    t.after(() => world.close());
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 },
    reducedMotion: "reduce", extraHTTPHeaders: headers });
  const requests = [], errors = [], external = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(10_000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => requests.push({ path: new URL(request.url()).pathname, method: request.method() }));
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
  t.after(async () => {
    await context.close();
    assert.deepEqual(errors, [], "served browser code");
    assert.deepEqual(external, [], "only same-origin assets and reads before opening a PR link");
  });
  return { ...world, page, requests };
}

const url = (world, base, route, values) => `${world.origin}${base}${route}?${new URLSearchParams(values)}`;
const runUrl = (world, base = "", values = {}) => url(world, base, "/run", { id: TASK, theme: "dark", ...values });
const current = page => page.waitForFunction(() => document.getElementById("workspace-state")?.textContent.startsWith("Task snapshot current"));
const show = (parent, text) => parent.getByText(text, { exact: false }).first().waitFor();
const phase = (page, value) => page.waitForFunction(phase => document.getElementById("control-status")?.dataset.phase === phase, value);
async function checkRequest(page, value) {
  await page.getByRole("button", { name: "Check request status" }).click();
  await phase(page, value);
  await page.waitForFunction(() => document.getElementById("control-check").getAttribute("aria-busy") !== "true");
}

async function capture(page, name) {
  const folder = process.env.FACTORY_TASK_CAPTURES;
  if (!folder) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(folder, name + ".png"), fullPage: true, animations: "disabled", timeout: 8000 });
}

function seedDecisions(world) {
  const paths = seedWorkspace(world), { state } = world;
  const review = state.get(TASK).firstPartyReview;
  state.update(TASK, { cursor: { fixed_sha: HEAD }, reviewHead: HEAD, reason: "first-party-review-failed",
    reviewObservation: { head: HEAD, binding: "fixture-binding", observedAt: BEFORE, external: "waiting",
      checks: { count: 2, failed: 1, settled: false, jobs: [
        { name: "Verify / unit tests", status: "failed", runId: 349 },
        { name: "Verify / package", status: "pending" },
      ] } },
    firstPartyReview: { ...review, status: "failed", completedAt: BEFORE, pieces: [{ status: "completed" }, { status: "failed" }] } });
  state.update(TASK, { hold: { active: true, generation: 3 }, recovery_profile: { version: 1, digest: "d".repeat(64) },
    base_repair: { status: "blocked", baseSha: BASE, head: HEAD, operationId: "repair-operation", journal: {
      id: "repair-journal", phase: "verification", candidate: { head: "c".repeat(40) }, verification: [{ exit: 1 }], ci: { job: 349 },
    } } });
  const record = state.get(TASK);
  state.update(TASK, { execution: { version: 1, provider: "codex", model: "current-author-model", transport: "cli" },
    completionEvidence: { acceptance: { allow: false, source: "local", repository: record.repo,
      pr: record.pr, base: record.base, head: HEAD, binding: "fixture-binding", brief: null, observedAt: BEFORE } } });
  const oldPath = join(paths.old, "job.json");
  const old = JSON.parse(readFileSync(oldPath));
  writeFileSync(oldPath, JSON.stringify({ ...old, harness: "openai-agents", execution: { ...old.execution,
    provider: "openai-agents", transport: "remote", model: "earlier-author-model", usage: { input_tokens: 24, total_tokens: 30 },
  } }));
  const update = (slug, patch) => state.update(`acme/atlas/${slug}`, patch);
  const delivery = pr => ({ repository: "acme/atlas", base: "main", head: HEAD, pr,
    gate: { allow: true, source: "local" }, observedAt: BEFORE });
  update("activity-feed", { state: "ready-for-human", cursor: { fixed_sha: HEAD }, completionEvidence: { delivery: delivery(44) } });
  update("settings-layout", { completionEvidence: { integration: { qualified: true } } });
  update("repository-picker", { completionEvidence: { terminal: { state: "CLOSED", head: HEAD, observedAt: BEFORE } } });
  update("keyboard-navigation", { reason: "harness-error", last: { run: RUN, exit: 1, at: BEFORE } });
  update("export-history", { state: "needs-human", reason: "cancelled", dispatch_stopped: "cancellation-requested" });
  return paths;
}

test("Overview outcomes and task evidence keep failed review, acceptance and earlier attempts bound", { timeout: 40_000 }, async t => {
  const world = await open(t), { page, state } = world;
  seedDecisions(world);
  for (const base of MOUNTS) {
    await page.goto(url(world, base, "/", { theme: "light" }));
    const outcomes = page.getByRole("navigation", { name: "Task outcomes" });
    for (const label of ["Integrated 1", "Ready for handoff 1", "Closed without integration 1", "Failed 1", "Cancelled 1"]) {
      await outcomes.getByRole("link", { name: label, exact: true }).waitFor();
    }
    assert.equal(await page.locator(".overview-section:visible").first().getAttribute("data-kind"), "attention");
    await show(page.locator('[data-task-id="acme/atlas/keyboard-navigation"]'), "Responsible actor");
    if (!base) await capture(page, "overview-decisions");
    await outcomes.getByRole("link", { name: "Failed 1", exact: true }).click();
    assert.equal(await page.locator(".overview-task").count(), 1);
    assert.equal(await page.getByRole("navigation", { name: "Task outcomes" }).getByRole("link", { name: "Failed 1", exact: true }).getAttribute("aria-current"), "page");
    await page.goto(runUrl(world, base, { run: OLD_RUN, q: "search", status: "blocked" }));
    await current(page);
    assert.equal(await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "Tasks", exact: true }).getAttribute("aria-current"), "page");
    const evidence = page.locator("#workspace-evidence");
    await show(evidence, "Verify / unit tests");
    await show(evidence, "Evaluator");
    await show(evidence, "denied");
    await show(page.locator("#workspace-review-content"), "could not finish");
    await show(page.locator("#workspace-provenance"), "Original failure");
    await show(page.locator("#workspace-recovery"), "Held");
    assert.equal(await page.getByRole("link", { name: "Inspect recovery hold" }).getAttribute("href"), "#workspace-recovery");
    await page.getByText("Pinned repair evidence", { exact: true }).click();
    await show(page.locator("#workspace-recovery"), BASE);
    await page.getByText("Task route and limits", { exact: true }).click();
    await show(page.locator("#workspace-recovery"), "current-author-model");
    await page.locator("#execution-details > summary").click();
    const attempt = page.locator("#workspace-execution-content");
    for (const term of ["earlier-author-model", "historical-fixture-session", "0.12", "5m 0s", "openai-agents"]) await show(attempt, term);
    assert.doesNotMatch(await attempt.innerText(), /current-author-model|current-fixture-session/);
    const prLinks = await page.locator('main a[href^="https://"]').evaluateAll(links =>
      links.map(link => [link.target, link.rel, link.dataset.externalLink]));
    assert.ok(prLinks.length);
    assert.ok(prLinks.every(link => link.join("|") === "_blank|noopener noreferrer|true"));
    if (base) await capture(page, "task-evidence-and-recovery");
  }
  const evidence = page.locator("#workspace-evidence");
  await evidence.getByText("Provenance", { exact: false }).first().click();
  const detail = evidence.locator("details").first();
  state.update(TASK, { cursor: { fixed_sha: "e".repeat(40) } });
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await show(evidence, "stale-head");
  assert.equal(await detail.getAttribute("open"), "");
  assert.equal(await evidence.getByText("Verify / unit tests", { exact: false }).count(), 0);
  assert.equal(new URL(page.url()).searchParams.get("run"), OLD_RUN);
  assert.equal(new URL(page.url()).searchParams.get("q"), "search");
  assert.equal(world.requests.filter(req => req.path.endsWith("/api/run/output")).length, 0, "logs open only on request");
  await page.locator("#workspace-activity > summary").click();
  await show(page.locator("#log"), "Historical attempt output only");
});

test("brief edits and disconnected reads retain the view and preserve approved inputs", { timeout: 30_000 }, async t => {
  const world = await open(t), { page, state, ctx, home } = world;
  seedWorkspace(world);
  const path = join(home, state.get(TASK).prd);
  mkdirSync(join(home, "docs", "prds"), { recursive: true });
  writeFileSync(path, GOOD_PRD);
  ctx.readPrd = id => id === TASK ? GOOD_PRD : null;
  state.update(TASK, { checkout: home });
  await page.goto(runUrl(world, "/gallivant", { run: RUN }));
  await current(page);
  const draft = page.getByLabel("Message agent"), age = page.locator("#workspace-summary time").first();
  const meaningfulAt = await age.getAttribute("datetime");
  await draft.fill("Keep the source index pinned until review.");
  await draft.evaluate(el => { el.focus(); el.setSelectionRange(2, 9); });
  const focus = await draft.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd, Math.round(el.getBoundingClientRect().top)]);
  writeFileSync(path, GOOD_PRD.replace("`npm test`", "`node --test`"));
  assert.notEqual(readFileSync(path, "utf8").trim(), GOOD_PRD.trim(), "fixture changes the Verify command");
  const before = readFileSync(state.file, "utf8");
  await page.clock.runFor(10_100);
  await show(page.locator("#workspace-summary"), "Approved brief changed");
  const after = await draft.evaluate(el => [el === document.activeElement, el.selectionStart, el.selectionEnd, Math.round(el.getBoundingClientRect().top)]);
  assert.deepEqual(after.slice(0, 3), focus.slice(0, 3));
  assert.ok(Math.abs(after[3] - focus[3]) <= 2, "draft remains in the same visible position");
  assert.equal(await age.getAttribute("datetime"), meaningfulAt);
  assert.notEqual(await age.innerText(), "just now");
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await page.getByRole("link", { name: "Review brief changes" }).click();
  await show(page.locator("#workspace-brief"), "--resnapshot");
  await checkRequest(page, "idle");
  assert.equal(await page.getByRole("button", { name: "Resume agent" }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Send message" }).isDisabled(), true);
  await page.route("**/api/run/workspace?**", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await show(page.locator("#workspace-state"), "Last good snapshot retained");
  assert.equal(await page.getByRole("button", { name: "Recheck PR" }).isDisabled(), true);
  assert.equal(await draft.inputValue(), "Keep the source index pinned until review.");
  assert.equal(await age.getAttribute("datetime"), meaningfulAt);
  assert.equal(readFileSync(state.file, "utf8"), before);
  assert.equal(ctx.readPrd(TASK), GOOD_PRD);
});

test("task controls show submitting, accepted, queued, working and final under the original identity", { timeout: 40_000 }, async t => {
  const world = await open(t), { page, state } = world;
  seedWorkspace(world);
  const sent = [];
  let release, received;
  const paused = new Promise(resolve => { received = resolve; });
  const respond = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/run/control?**", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const body = route.request().postDataJSON();
    sent.push(body);
    const response = await route.fetch();
    if (body.action === "message") {
      received();
      await respond;
    }
    if (body.action === "resume") return route.abort();
    return route.fulfill({ response });
  });
  await page.goto(runUrl(world, "/gallivant", { run: OLD_RUN }));
  await phase(page, "idle");
  await page.getByLabel("Message agent").fill("Keep the original rollback guard.");
  await page.getByRole("button", { name: "Send message" }).click();
  await paused;
  await phase(page, "submitting");
  const identity = page.locator("#control-request-identity");
  const messageId = state.get(TASK).control.id;
  assert.equal(await identity.innerText(), messageId);
  assert.equal(await page.getByRole("button", { name: "Send message" }).isDisabled(), true);
  release();
  await phase(page, "accepted");
  assert.match(await page.locator("#control-status").innerText(), /accepted and queued/);
  await checkRequest(page, "queued");
  settleControl(world, "applying"); await checkRequest(page, "working");
  settleControl(world, "applied"); await checkRequest(page, "final");
  assert.equal(await identity.innerText(), messageId);
  assert.match(await page.locator("#control-status").innerText(), /does not confirm model acknowledgement or task completion/);
  await page.getByLabel("Message agent").fill("An unsent draft.");
  await page.getByRole("button", { name: "Resume agent" }).click();
  await phase(page, "uncertain");
  const original = state.get(TASK).control.id;
  assert.equal(await identity.innerText(), original);
  await checkRequest(page, "queued");
  assert.equal(await identity.innerText(), original);
  assert.equal(await page.getByRole("button", { name: "Retry same request" }).isVisible(), false);
  settleControl(world, "failed"); await checkRequest(page, "final");
  await page.getByRole("button", { name: "Recheck PR" }).click();
  await phase(page, "accepted");
  settleControl(world, "applied"); await checkRequest(page, "final");
  await page.getByText("Stop this task", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel task" }).click();
  await phase(page, "accepted");
  assert.equal(state.get(TASK).dispatch_stopped, "cancellation-requested");
  assert.deepEqual(sent.map(body => body.action), ["message", "resume", "recheck", "cancel"]);
  assert.deepEqual(Object.keys(sent[0]).sort(), ["action", "interrupt", "note", "requestId"]);
  assert.ok(sent.slice(1).every(body => Object.keys(body).sort().join() === "action,requestId"));
  assert.equal(await page.getByLabel("Message agent").inputValue(), "An unsent draft.");
  assert.equal(new URL(page.url()).searchParams.get("run"), OLD_RUN);
  assert.equal(state.get(TASK).iteration, 1);
});

test("System exposes scoped cooldowns, occupied capacity, retained cleanup and supervisor limits", { timeout: 40_000 }, async t => {
  const world = await open(t), { page, state, ctx, home } = world;
  seedHealth(world);
  ctx.config.dispatch_capacity = { authors: 1, preparations: 1 };
  ctx.config.resource_headroom = { minimum_free_bytes: Number.MAX_SAFE_INTEGER };
  state.update(TASK, { workspace_cleanup: { status: "retained" }, runtime_cleanup: { code: "removed" } });
  const now = Date.parse(NOW), until = new Date(now + 9 * 86400_000).toISOString();
  makeRecoveryCooldowns({ home, clock: ctx.clock }).record(providerScope("openai-agents", HEALTH_SECRET), { status: 429, retryAt: Date.parse(until) });
  const before = readFileSync(state.file, "utf8");
  for (const base of MOUNTS) {
    await page.goto(url(world, base, "/system", { theme: base ? "dark" : "light" }));
    const capacity = page.getByRole("region", { name: "Capacity", exact: true });
    await show(capacity, "1 · recorded tasks");
    const cooldowns = page.getByRole("region", { name: "Service cooldowns" });
    await show(cooldowns, "suspended until the service deadline");
    await show(cooldowns, until);
    const storage = page.getByRole("region", { name: "Storage and retained work" });
    await show(storage, "free bytes");
    await show(storage, "free inodes");
    await show(storage, "Workspaces retained");
    await show(page.getByRole("region", { name: "Supervisor", exact: true }), "unavailable");
    assert.doesNotMatch(await page.locator("main").textContent(), new RegExp(HEALTH_SECRET));
    assert.equal(await page.getByRole("button", { name: /purge|kill|edit credential|probe|activate/i }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: /company goals|mandates|external receipts/i }).count(), 0);
  }
  const snapshot = await page.request.get(url(world, "/gallivant", "/api/system-health", {}));
  const { health } = await snapshot.json();
  assert.equal(health.capacity.activeAuthors, health.capacity.authorLimit);
  assert.equal(health.installation.cleanup.retained, 1);
  assert.equal(health.installation.cleanup.runtimeRemoved, 1);
  assert.equal(health.cooldowns[0].nextAt, until);
  assert.equal(readFileSync(state.file, "utf8"), before);
  assert.ok(world.requests.every(req => req.method === "GET"));
  await capture(page, "system-resource-waits");
});

test("protected plan task links, capacity waits and permission loss retain the shell", { timeout: 45_000 }, async t => {
  const api = await planFixture(t), world = await open(t, api, { authorization: ACTOR }), { page, calls, state } = world;
  const { producer } = await diamondPlans(world);
  const admittedTask = `${REPO}/api`;
  const until = world.clock.now() + 9 * 86400_000;
  const cooldowns = makeRecoveryCooldowns({ home: world.home, clock: world.clock });
  const routeScope = providerScope("codex", world.ctx.config.harness.codex.account);
  cooldowns.record(routeScope, { status: 429, retryAt: until });
  cooldowns.record(providerScope("openai-agents", "another-tenant-account"), { status: 429, retryAt: until });
  const before = calls.length;
  await page.goto(runUrl(world, "/gallivant", { id: admittedTask, pq: producer.name,
    plan: producer.instanceId, node: "implementation/api", diagram: "1", po: "1" }));
  await current(page);
  await show(page.locator("#workspace-summary"), "1 prerequisite");
  await show(page.locator("#workspace-summary"), "foundation");
  await page.getByRole("link", { name: "Back to plan" }).click();
  const selected = new URL(page.url()).searchParams;
  assert.equal(selected.get("plan"), producer.instanceId);
  assert.equal(selected.get("node"), "implementation/api");
  assert.equal(selected.get("pq"), producer.name);
  assert.equal(selected.get("diagram"), "1");
  assert.equal(selected.get("po"), "1");
  await page.goto(url(world, "/gallivant", "/system", { theme: "dark" }));
  const health = await (await page.request.get(url(world, "/gallivant", "/api/system-health", {}))).json();
  assert.equal(health.health.capacity.waitingCapacity, 1);
  assert.equal(health.health.capacity.authorLimit, null);
  assert.equal(health.health.installation, undefined);
  assert.deepEqual(health.health.cooldowns.map(wait => [wait.label, wait.nextAt]), [["codex plan routes", new Date(until).toISOString()]]);
  assert.doesNotMatch(JSON.stringify(health), new RegExp(routeScope));
  const saved = readFileSync(state.file, "utf8");
  for (const action of ["message", "resume", "recheck", "cancel"]) world.denied.add(`task/${action}`);
  await page.goto(runUrl(world, "/gallivant", { id: admittedTask }));
  await show(page.locator("#run-controls"), "This view has read access");
  assert.equal(await page.getByLabel("Message agent").count(), 0);
  world.allowBrowser(false);
  await page.getByRole("button", { name: "Refresh evidence" }).click();
  await show(page.locator("#workspace-state"), "unavailable within this workspace scope");
  assert.equal(await page.locator("#workspace-summary").isVisible(), false);
  assert.equal(await page.getByRole("navigation", { name: "Workspace", exact: true }).isVisible(), true);
  const missing = await page.goto(runUrl(world, "/gallivant", { id: admittedTask }));
  assert.equal(missing.status(), 404);
  assert.doesNotMatch(await page.locator("main").innerText(), /acme\/widget|implementation\/api/);
  assert.equal(readFileSync(state.file, "utf8"), saved);
  assert.equal(calls.length, before, "GET does not call the host");
});

test("synthetic task pages stay labelled and operable across mounts, themes, widths and zoom", { timeout: 75_000 }, async t => {
  const world = await open(t), { page } = world;
  seedDecisions(world);
  const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, page.url());
  for (const base of MOUNTS) for (const theme of THEMES) {
    for (const width of [360, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(runUrl(world, base, { theme, run: RUN }));
      await current(page);
      await noOverflow();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
      if (width === 390 && base && theme === "dark") await capture(page, "task-decisions-mobile");
    }
    await page.setViewportSize({ width: 740, height: 360 });
    await noOverflow();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addStyleTag({ url: world.origin + "/zoom.css" });
    assert.equal(await page.locator("body").evaluate(el => getComputedStyle(el).zoom), "2");
    await noOverflow();
    await page.reload(); await current(page);
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.textContent), "Skip to main content");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "main");
    await page.locator("#workspace-activity summary").focus();
    assert.notEqual(await page.locator("#workspace-activity summary").evaluate(el => getComputedStyle(el).outlineStyle), "none");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#workspace-activity").getAttribute("open"), "");
    const result = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
    assert.deepEqual(result.violations.map(violation => ({ id: violation.id, nodes: violation.nodes.map(node => node.target) })), []);
    const audit = await page.evaluate(() => {
      const targets = [...document.querySelectorAll("header a, header button, header summary, main a, main button, main summary")];
      const failures = targets.filter(element => element.checkVisibility()).filter(element =>
        !(element.getAttribute("aria-label") || element.textContent.trim()) || element.getBoundingClientRect().height < 43.9);
      const icons = [...document.querySelectorAll("svg.icon")].filter(el => el.getAttribute("aria-hidden") !== "true" || el.getAttribute("focusable") !== "false");
      return [...failures, ...icons].map(el => el.outerHTML.slice(0, 180));
    });
    assert.deepEqual(audit, [], "accessible names, nonfocusing icons and 44px targets");
  }
  const started = performance.now();
  await page.goto(runUrl(world, "/gallivant", { run: RUN }));
  await current(page);
  const renderMs = Math.round(performance.now() - started);
  const response = await page.request.get(url(world, "", "/api/run/workspace", { id: TASK, run: RUN }));
  const size = Buffer.byteLength(await response.text());
  assert.ok(size < 25_000);
  t.diagnostic(`Task fixture first render and refresh ${renderMs}ms · refresh payload ${size} bytes · Chromium ${browser.version()}`);
});

test("an empty workspace and missing attempt remain distinct from missing evidence", { timeout: 25_000 }, async t => {
  const empty = await fixture({ empty: true });
  t.after(() => empty.close());
  const world = await open(t, empty), { page } = world;
  await page.goto(url(world, "/gallivant", "/tasks", { theme: "light", q: "search" }));
  await show(page.locator("main"), "No tasks registered yet");
  assert.equal(await page.locator("[data-task-id]").count(), 0);
  for (const base of MOUNTS) {
    const missing = await page.goto(runUrl(world, base, { run: "missing-attempt" }));
    assert.equal(missing.status(), 404);
    await show(page.locator("main"), "This task is unavailable");
  }
  const full = await fixture();
  t.after(() => full.close());
  const populated = (await open(t, full)).page;
  const saved = await populated.goto(runUrl(full, "", { run: "missing-attempt" }));
  assert.equal(saved.status(), 404);
  await show(populated.locator("main"), "No such run");
  await populated.goto(runUrl(full, "", { run: RUN }));
  await current(populated);
  await show(populated.locator("#workspace-evidence"), "an unknown head");
});
