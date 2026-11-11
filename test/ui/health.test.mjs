import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW } from "./fixture.mjs";
import { seedHealth, HEALTH_SECRET } from "./health-fixture.mjs";
import { serve } from "../../lib/commands/serve.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30_000 });
after(async () => { await browser?.close(); });
async function open(t, { empty = false } = {}) {
  const world = await fixture({ empty }); t.after(() => world.close());
  if (empty) { world.ctx.config.repos = []; world.ctx.config.harness = {}; }
  else seedHealth(world);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  t.after(() => context.close());
  const requests = [], errors = [], external = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (r.url().includes("/api/")) requests.push(r.url()); });
  await page.clock.install({ time: new Date(NOW) }); await page.clock.setFixedTime(new Date(NOW));
  t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(external, []); });
  return { ...world, page, context, requests };
}
const updated = page => page.waitForFunction(() => !document.getElementById("health-refresh").disabled);
const api = page => page.waitForResponse(r => r.url().includes("/api/system-health"));

test("health routes show saved mixed capabilities and retries without exposing secrets or changing tasks", { timeout: 45_000 }, async t => {
  const { page, origin, state, context, home, requests } = await open(t);
  const saved = JSON.stringify(state.entries()), file = join(home, "provider-health.json"), probes = readFileSync(file, "utf8");
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/health?theme=dark`);
    assert.equal(await page.locator("h1").textContent(), "System health");
    assert.match(await page.locator(".health-coordinator").textContent(), /stale/);
    const codex = page.locator('[data-key="provider:codex"]');
    assert.match(await codex.textContent(), /Readiness refresh pending/);
    assert.match(await codex.textContent(), /Live qualificationunknown/);
    assert.match(await page.locator('[data-key="provider:openai-agents"]').textContent(), /quota exhausted/);
    assert.match(await page.locator('[data-key="provider:codex-cloud"]').textContent(), /Dispatch unsupported/);
    await page.locator('[data-key="support:codex-cloud"] summary').click();
    assert.match(await page.locator('[data-key="support:codex-cloud"]').textContent(), /cannot access|does not declare repository access/);
    assert.match(await page.locator('[data-key="host:bitbucket.org"]').textContent(), /Labels are unavailable/);
    for (let n = 0; n < 2; n++) { const done = api(page); await page.locator("#health-refresh").click(); await done; await updated(page); }
    const response = await context.request.get(`${origin}${base}/api/system-health`);
    assert.equal(response.status(), 200);
    const data = await response.json(); assert.equal(data.health.coordinator.state, "stale");
    assert.ok(!JSON.stringify(data).includes(HEALTH_SECRET)); assert.ok(!(await page.content()).includes(HEALTH_SECRET));
    assert.equal(readFileSync(file, "utf8"), probes); assert.equal(JSON.stringify(state.entries()), saved);
  }
  assert.ok(requests.every(url => url.includes("/api/system-health")), "one health polling surface, no provider calls");
});

test("health keeps last good data, backs off, pauses hidden/offline reads and cleans up on navigation", { timeout: 45_000 }, async t => {
  const { page, origin, requests } = await open(t);
  await page.goto(`${origin}/health`);
  const content = await page.locator("#health-results").innerHTML();
  await page.route("**/api/system-health*", route => route.fulfill({ status: 503, body: "temporarily unavailable" }));
  for (const delay of [10_000, 20_000, 40_000]) {
    const done = api(page); await page.clock.runFor(delay); await done; await updated(page);
  }
  assert.match(await page.locator("#health-status").textContent(), /Disconnected.*last good.*paused/);
  assert.equal(await page.locator("#health-results").innerHTML(), content);
  assert.equal(requests.length, 3); await page.clock.runFor(120_000); assert.equal(requests.length, 3);
  await page.unroute("**/api/system-health*");
  let done = api(page); await page.locator("#health-refresh").click(); await done; await updated(page);
  assert.match(await page.locator("#health-status").textContent(), /Current/);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const count = requests.length; await page.clock.runFor(120_000); assert.equal(requests.length, count);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, value: false }); document.dispatchEvent(new Event("visibilitychange")); });
  done = api(page); await page.clock.runFor(10_000); await done; await updated(page);
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: false }); dispatchEvent(new Event("offline")); });
  const offline = requests.length; await page.clock.runFor(120_000); assert.equal(requests.length, offline);
  await page.evaluate(() => { Object.defineProperty(navigator, "onLine", { configurable: true, value: true }); dispatchEvent(new Event("online")); });
  done = api(page); await page.clock.runFor(10_000); await done; await updated(page);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  const hidden = requests.length; await page.clock.runFor(60_000); assert.equal(requests.length, hidden);
  done = api(page); await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }))); await done; await updated(page);
  await page.getByRole("navigation", { name: "Workspace", exact: true }).getByRole("link", { name: "Overview", exact: true }).click();
  const left = requests.filter(url => url.includes("system-health")).length;
  await page.clock.runFor(20_000); assert.equal(requests.filter(url => url.includes("system-health")).length, left);
});

test("health reads are non-overlapping, time out and retain open disclosure and focus", { timeout: 30_000 }, async t => {
  const { page, origin, requests } = await open(t);
  await page.goto(`${origin}/health`);
  await page.locator('[data-key="support:codex"] summary').click();
  const focused = await page.evaluate(() => document.activeElement.outerHTML);
  let release;
  await page.route("**/api/system-health*", async route => { await new Promise(resolve => { release = resolve; }); await route.abort().catch(() => {}); });
  await page.clock.runFor(10_000);
  await page.waitForFunction(() => document.getElementById("health-refresh").disabled);
  await page.locator("#health-refresh").evaluate(button => { button.dispatchEvent(new MouseEvent("click")); button.dispatchEvent(new MouseEvent("click")); });
  assert.equal(requests.length, 1);
  await page.clock.runFor(8000); await updated(page); release();
  assert.match(await page.locator("#health-status").textContent(), /Stale/);
  assert.equal(await page.locator('[data-key="support:codex"]').getAttribute("open"), "");
  assert.equal(await page.evaluate(() => document.activeElement.outerHTML), focused);
});

test("keyboard discovery uses existing search, retains typing shortcuts and carries filters across views", { timeout: 45_000 }, async t => {
  const { page, origin } = await open(t);
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/?theme=dark&q=search&harness=codex`);
    await page.locator("#commands-open").click(); assert.equal(await page.locator("#commands").getAttribute("open"), "");
    await page.keyboard.press("Escape"); await page.waitForFunction(() => document.activeElement.id === "commands-open");
    await page.keyboard.press("Control+k");
    assert.equal(await page.evaluate(() => document.activeElement.id), "command-search");
    await page.keyboard.type("/"); assert.ok((await page.locator("#command-search").inputValue()).includes("/"));
    await page.keyboard.press("Escape");
    await page.locator("#main").focus(); await page.keyboard.press("/");
    assert.equal(await page.evaluate(() => document.activeElement.name), "q");
    await page.keyboard.press("Control+k"); assert.equal(await page.locator("#commands").getAttribute("open"), null);
    const nav = () => page.getByRole("navigation", { name: "Workspace", exact: true });
    await nav().getByRole("link", { name: "Chains", exact: true }).click();
    await page.getByRole("button", { name: "Filter chains", exact: true }).click();
    await nav().getByRole("link", { name: "System health", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("q"), "search");
    await page.locator("#commands-open").click();
    assert.equal(await page.locator("#commands [data-action]").count(), 0);
    await page.locator("#command-search").fill("activity"); await page.getByRole("button", { name: "Search tasks", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, `${base}/`); assert.equal(new URL(page.url()).searchParams.get("q"), "activity");
    assert.equal(await page.locator("[data-task-id]").count(), 1);
    await page.goBack(); assert.equal(new URL(page.url()).pathname, `${base}/health`);
    await page.reload(); assert.equal(new URL(page.url()).searchParams.get("harness"), "codex");
  }
});

test("empty setup offers copyable supported commands and both themes fit all supported widths", { timeout: 90_000 }, async t => {
  const world = await open(t, { empty: true });
  const { page, origin, context } = world;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`${origin}/?theme=light`);
  assert.match(await page.locator(".onboarding").textContent(), /Connect your first repository/);
  await page.getByRole("button", { name: "Copy initialize repository command", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "'gallivant' 'init' '--harness' 'codex'");
  await page.goto(`${origin}/task/new`); assert.match(await page.locator(".onboarding").textContent(), /No repositories/);
  seedHealth(world);
  for (const theme of ["dark", "light"]) for (const width of [360, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/gallivant/health?theme=${theme}`);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(geometry.scroll <= geometry.width, `${theme}/${width}`);
    const refresh = await page.locator("#health-refresh").boundingBox(); assert.ok(refresh.width > 140 && refresh.height < 90, "refresh label stays readable");
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `${theme}/${width}`);
  }
  await page.locator(".menu summary").click(); await page.locator("#density").selectOption("compact");
  await page.reload(); assert.equal(await page.locator("html").getAttribute("data-density"), "compact");
  await page.setViewportSize({ width: 844, height: 390 });
  await page.locator("#commands-open").click();
  const dialogAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag22aa"]).analyze();
  assert.deepEqual(dialogAxe.violations, []);
  await page.keyboard.press("Escape"); await page.addStyleTag({ url: `${origin}/zoom.css` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test("standalone server identity health and system observations coexist without changing ports", { timeout: 30_000 }, async t => {
  const world = await fixture(); t.after(() => world.close()); seedHealth(world, "up");
  const server = await serve(world.ctx, { port: 0, instance: "fixture-server" });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { instance: "fixture-server" });
  assert.equal((await (await fetch(`${origin}/api/system-health`)).json()).health.coordinator.state, "up");
  assert.equal((await fetch(`${origin}/health`)).status, 200);
});
