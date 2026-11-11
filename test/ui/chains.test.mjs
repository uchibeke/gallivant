import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW, TASK } from "./fixture.mjs";
import { seedChains, CHAIN, RECOVERY } from "./chains-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30000 });
after(async () => { await browser?.close(); });
async function open(t) {
  const world = await fixture(); t.after(() => world.close());
  const data = await seedChains(world);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  t.after(() => context.close());
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.clock.install({ time: new Date(NOW) }); await page.clock.setFixedTime(new Date(NOW));
  return { ...world, ...data, page, context };
}
const path = (base = "", chain = CHAIN) => `${base}/chains?chain=${chain}&milestone=${encodeURIComponent(TASK)}&theme=dark`;
const awaitReview = page => page.waitForFunction(() => !document.getElementById("chain-submit").disabled);
const awaitAction = page => page.waitForFunction(() => !document.getElementById("chain-close").disabled);

test("chain journey preserves selection, filters, PR and task context across root, mount and history", { timeout: 60000 }, async t => {
  const { page, origin, state, hostReads, context } = await open(t);
  const saved = JSON.stringify(state.chains()), reads = hostReads();
  for (const base of ["", "/gallivant"]) {
    await page.goto(origin + path(base) + "&cq=search&cs=active");
    assert.match(await page.locator(".chain-progress").textContent(), /1 of 4 dependencies merged/);
    assert.match(await page.locator(".milestone-detail").textContent(), /Delivery ready · merge required/);
    assert.equal(await page.locator('[aria-current="step"]').textContent(), "search-index");
    assert.equal(await page.locator(".milestone-detail").getByRole("link", { name: "Open PR", exact: true }).getAttribute("href"), "https://github.com/acme/atlas/pull/42");
    // A local response supplies the synthetic PR page while exercising real link/history navigation.
    await context.route("https://github.com/acme/atlas/pull/42", route => route.fulfill({ body: "<h1>Fixture PR</h1>", contentType: "text/html" }));
    await page.getByRole("link", { name: "Open PR", exact: true }).click(); await page.goBack();
    assert.equal(await page.locator('[aria-current="step"]').textContent(), "search-index");
    await page.getByRole("link", { name: "Open task", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, `${base}/run`);
    await page.getByRole("link", { name: `Back to chain ${CHAIN}`, exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("cq"), "search");
    assert.equal(new URL(page.url()).searchParams.get("cs"), "active");
    assert.equal(await page.locator('[aria-current="step"]').textContent(), "search-index");
    await page.getByRole("link", { name: "migration-rollout", exact: true }).click();
    assert.match(await page.locator(".milestone-detail").textContent(), /Wait for milestone 2 to merge/);
    await page.reload(); assert.equal(await page.locator('[aria-current="step"]').textContent(), "migration-rollout");
    await page.goBack(); assert.equal(await page.locator('[aria-current="step"]').textContent(), "search-index");
  }
  assert.equal(JSON.stringify(state.chains()), saved); assert.equal(hostReads(), reads, "GET navigation has no host calls");
});

test("changed-brief review rejects a newer source and confirms the exact replacement once", { timeout: 60000 }, async t => {
  const { page, origin, state, source } = await open(t);
  await page.goto(origin + path("/gallivant", RECOVERY));
  const before = state.getChain(RECOVERY), posts = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(request.postDataJSON()); });
  await page.getByRole("button", { name: "Review changed inputs", exact: true }).click(); await awaitReview(page);
  assert.match(await page.locator("#chain-review").textContent(), /Does not resume workers or reset their budgets/);
  assert.match(await page.locator("#chain-review").textContent(), /fingerprint changed/);
  assert.doesNotMatch(await page.locator("#chain-review").textContent(), /Changed fixture source|operator\//);
  assert.deepEqual(state.getChain(RECOVERY), before, "review cannot accept changes");
  writeFileSync(source, "New change after the displayed review\n");
  await page.getByRole("button", { name: "Confirm reviewed action", exact: true }).click(); await awaitAction(page);
  assert.match(await page.locator("#chain-action-status").textContent(), /inputs changed after review/);
  assert.deepEqual(state.getChain(RECOVERY), before);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Review changed inputs", exact: true }).click(); await awaitReview(page);
  const reviewed = await page.locator("#chain-review dd").nth(2).textContent();
  await page.getByRole("button", { name: "Confirm reviewed action", exact: true }).dblclick(); await awaitAction(page);
  assert.match(await page.locator("#chain-action-status").textContent(), /Applied/);
  assert.equal(posts.filter(p => p.stage === "confirm" && p.revision === reviewed).length, 1);
  assert.equal(state.getChain(RECOVERY).status, "active");
  assert.equal(state.getChain(RECOVERY).control.revision, reviewed);
  assert.notEqual(state.getChain(RECOVERY).steps[0].digest, before.steps[0].digest);
  assert.equal(state.entries().length, 7, "no task dispatch");
});

test("cancellation and ordinary retry preserve existing task ownership and explain scope", { timeout: 60000 }, async t => {
  const { page, origin, state } = await open(t);
  const saved = JSON.stringify(state.entries());
  state.updateChain(CHAIN, { status: "stopped", reason: "repair prerequisite" });
  for (const [action, name, status] of [["retry", "Review retry", "active"], ["cancel", "Review cancellation", "cancelled"]]) {
    await page.goto(origin + path());
    await page.getByRole("button", { name, exact: true }).click(); await awaitReview(page);
    assert.match(await page.locator("#chain-review").textContent(), action === "retry" ? /Does not resume workers or reset their budgets/ : /active worker is not cancelled/);
    await page.getByRole("button", { name: "Confirm reviewed action", exact: true }).click(); await awaitAction(page);
    assert.equal(state.getChain(CHAIN).status, status); assert.equal(JSON.stringify(state.entries()), saved);
  }
  await page.reload(); assert.match(await page.locator(".milestone-list").textContent(), /Future dispatch cancelled/);
  assert.equal(await page.getByRole("button", { name: "Review retry", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Review changed inputs", exact: true }).isDisabled(), true);
});

test("large chain collections window rows, share polling, retain stale data and avoid host reads", { timeout: 60000 }, async t => {
  const { page, origin, home, chain, hostReads } = await open(t);
  const file = join(home, "state.json"), saved = JSON.parse(readFileSync(file, "utf8"));
  const large = { ...chain, name: "large", index: 400, steps: Array.from({ length: 1000 }, (_, i) => ({ id: `acme/atlas/milestone-${i}`, digest: "a".repeat(64) })) };
  saved.chains = { large, ...Object.fromEntries(Array.from({ length: 999 }, (_, i) => [`chain-${i}`, { ...chain, name: `chain-${i}` }])) };
  writeFileSync(file, JSON.stringify(saved));
  let polls = 0, streams = 0;
  page.on("request", request => { if (request.url().includes("/api/chains")) polls++; if (request.url().includes("/output")) streams++; });
  const reads = hostReads();
  await page.goto(`${origin}/chains?chain=large&milestone=acme%2Fatlas%2Fmilestone-410`);
  assert.equal(await page.locator(".chain-index-list > li").count(), 20);
  assert.equal(await page.locator(".milestone-list > li").count(), 25);
  assert.equal(await page.locator('[aria-current="step"]').textContent(), "milestone-410");
  await page.getByRole("link", { name: "Earlier milestones", exact: true }).click();
  assert.equal(await page.locator(".milestone-list").getAttribute("start"), "376");
  for (let i = 0; i < 3; i++) { await page.clock.runFor(10001); await page.waitForFunction(() => !document.getElementById("chains-refresh").disabled); }
  assert.equal(polls, 3); assert.equal(streams, 0); assert.equal(hostReads(), reads);
  const text = await page.locator("#chains-results").textContent();
  await page.route("**/api/chains?*", route => route.fulfill({ status: 503, body: "unavailable" }));
  await page.getByRole("button", { name: "Refresh chains", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("chains-status").textContent.startsWith("Stale"));
  assert.equal(await page.locator("#chains-results").textContent(), text);
  assert.equal(await page.locator(".milestone-list > li").count(), 25);
});

test("chain themes, narrow widths, zoom and keyboard dialogs remain accessible", { timeout: 120000 }, async t => {
  const { page, origin } = await open(t);
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 950 });
      await page.goto(`${origin}/gallivant/chains?chain=${CHAIN}&milestone=${encodeURIComponent(TASK)}&theme=${theme}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme} ${width}`);
      assert.equal(await page.locator(".milestone-list > li").count(), 4);
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], `${theme} ${width}`);
    }
  }
  await page.setViewportSize({ width: 780, height: 390 });
  await page.addStyleTag({ url: `${origin}/zoom.css` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const button = page.getByRole("button", { name: "Review cancellation", exact: true });
  await button.focus(); await page.keyboard.press("Enter"); await awaitReview(page);
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  assert.deepEqual(result.violations, []);
  await page.keyboard.press("Escape"); assert.equal(await button.evaluate(el => el === document.activeElement), true);
});

test("lost chain confirmations remain uncertain and a saved receipt prevents duplicate application", { timeout: 30000 }, async t => {
  const { page, origin, state, context } = await open(t);
  await page.goto(origin + path());
  let payload, writes = 0;
  const update = state.updateChain;
  state.updateChain = (...args) => { writes++; return update(...args); };
  await page.route("**/api/chain/control?*", async route => {
    if (route.request().postDataJSON().stage !== "confirm") return route.continue();
    payload = route.request().postDataJSON();
    const response = await route.fetch(); assert.equal(response.status(), 200);
    // The service applied the action, but a proxy returns an invalid body.
    await route.fulfill({ status: 200, contentType: "application/json", body: "{" });
  });
  await page.getByRole("button", { name: "Review cancellation", exact: true }).click(); await awaitReview(page);
  await page.getByRole("button", { name: "Confirm reviewed action", exact: true }).click(); await awaitAction(page);
  assert.match(await page.locator("#chain-action-status").textContent(), /Outcome uncertain/);
  assert.equal(await page.locator("#chain-submit").isDisabled(), true); assert.equal(writes, 1);
  const token = await page.locator("[data-chains]").getAttribute("data-token");
  const replay = await context.request.post(`${origin}/api/chain/control?chain=${CHAIN}`, { headers: { Origin: origin, "X-Gallivant-Token": token }, data: payload });
  assert.equal(replay.status(), 200); assert.equal((await replay.json()).status, "applied"); assert.equal(writes, 1);
  await page.reload(); assert.ok((await page.locator(".chain-recovery").textContent()).includes(payload.requestId));
});

test("chain refresh defers focused content, pauses while hidden and cleans up on navigation", { timeout: 30000 }, async t => {
  const { page, origin, state } = await open(t);
  let reads = 0, release, receive;
  const received = new Promise(resolve => { receive = resolve; });
  await page.goto(origin + path());
  const selected = page.locator('[aria-current="step"]');
  await selected.focus(); state.updateChain(CHAIN, { reason: "New saved dependency observation" });
  await page.getByRole("button", { name: "Refresh chains", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("chains-refresh").disabled);
  // An expanded evidence disclosure must not be replaced beneath the reader.
  await page.locator(".milestone-detail summary").click();
  state.updateChain(CHAIN, { reason: "Another saved dependency observation" });
  await page.clock.runFor(10001);
  await page.waitForFunction(() => !document.getElementById("chains-refresh").disabled);
  assert.equal(await page.locator(".milestone-detail details").getAttribute("open"), "");
  assert.equal(await page.getByRole("button", { name: "Apply chain updates", exact: true }).isVisible(), true);
  await page.route("**/api/chains?*", async route => { reads++; receive(); await new Promise(resolve => { release = resolve; }); await route.abort().catch(() => {}); });
  t.after(() => release?.());
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { configurable: true, get: () => true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(30001); assert.equal(reads, 0);
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(10001); await received; assert.equal(reads, 1);
  await page.clock.runFor(1000); assert.equal(reads, 1, "no overlapping read");
  await page.getByRole("link", { name: "Overview", exact: true }).click(); release();
  await page.clock.runFor(20001); assert.equal(reads, 1, "chain polling ends with navigation");
});

test("unsupported browser controls show a remedy and do not submit through delegated clicks", { timeout: 30000 }, async t => {
  const { page, origin, state } = await open(t);
  const before = JSON.stringify(state.chains()); let posts = 0;
  await page.addInitScript(() => Object.defineProperty(globalThis.crypto, "randomUUID", { value: undefined }));
  page.on("request", request => { if (request.method() === "POST") posts++; });
  await page.goto(origin + path());
  const cancel = page.getByRole("button", { name: "Review cancellation", exact: true });
  assert.equal(await cancel.isDisabled(), true);
  assert.match(await page.locator("#chain-cancel-help").textContent(), /current browser on localhost/);
  await cancel.dispatchEvent("click"); assert.equal(posts, 0);
  await page.getByRole("button", { name: "Refresh chains", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("chains-refresh").disabled);
  assert.equal(await cancel.isDisabled(), true); assert.equal(JSON.stringify(state.chains()), before);
});
