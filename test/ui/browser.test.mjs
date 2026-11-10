import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW, TASK, RUN, MALICIOUS } from "./fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30_000 });
after(async () => { await browser?.close(); });

async function open(t, options = {}) {
  const world = await fixture(options);
  t.after(() => world.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
  t.after(async () => { await context.close(); assert.deepEqual(external, [], "all product resources stay on the fixture origin"); assert.deepEqual(errors, [], "served JS runs without errors"); });
  return { ...world, page, context };
}
const runPath = base => `${base}/run?id=${encodeURIComponent(TASK)}&run=${RUN}&theme=dark&by=harness`;
const noOverflow = page => page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
const contrast = async page => {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
};

test("root and mounted routes serve real assets, APIs, links and historical selection", { timeout: 60_000 }, async t => {
  const { page, origin, state, context } = await open(t);
  const initial = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    const response = await page.goto(`${origin}${base}/?theme=dark&by=harness`);
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-security-policy"], /script-src 'self'/);
    assert.equal(await page.locator("main").count(), 1);
    assert.equal(await page.locator("h1").textContent(), "Overview");
    assert.equal(await page.locator("#side .row").count(), 6);
    for (const href of await page.locator("nav a").evaluateAll(links => links.map(a => a.href))) {
      const url = new URL(href); assert.equal(url.searchParams.get("theme"), "dark"); assert.equal(url.searchParams.get("by"), "harness");
      assert.equal((await context.request.get(href)).status(), 200);
    }
    for (const path of ["/tracker.css", "/tracker.js", "/api/status", "/api/runs", "/api/capabilities"]) {
      const resource = await context.request.get(`${origin}${base}${path}`);
      assert.equal(resource.status(), 200, path); assert.ok((await resource.body()).length > 20);
    }
    await page.goto(`${origin}${runPath(base)}`);
    await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Fixture run:"));
    assert.equal(await page.locator("#log").getAttribute("data-run"), RUN);
    await page.waitForFunction(() => document.querySelector("#logstate").textContent === "finished");
    assert.equal(await page.locator("#logstate.loading").count(), 0);
    const historyLink = await page.getByText("every run for this entry", { exact: true }).getAttribute("href");
    await page.goto(origin + historyLink);
    assert.equal(await page.locator("tbody tr").count(), 1);
    await page.locator("tbody a").last().click();
    assert.equal(new URL(page.url()).searchParams.get("open"), RUN);
    await page.reload();
    assert.equal(await page.locator("#log").getAttribute("data-run"), RUN);
    await page.goBack();
    assert.equal(new URL(page.url()).searchParams.get("entry"), TASK);
    if (base) { await page.locator("a.home").click(); assert.equal(new URL(page.url()).pathname, "/host"); }
  }
  assert.equal(JSON.stringify(state.entries()), initial, "GETs do not mutate task state");
});

test("dark, light, system and host overrides work standalone, mounted and framed", { timeout: 60_000 }, async t => {
  const { page, origin } = await open(t);
  for (const base of ["", "/gallivant"]) {
    for (const scheme of ["dark", "light"]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${origin}${base}/`);
      const system = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      await page.goto(`${origin}${base}/?theme=${scheme}`);
      assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), system);
      await contrast(page);
    }
    await page.goto(`${origin}${runPath(base)}`);
    await page.locator("#run-note").fill("Keep this draft across appearance changes.");
    await page.locator(".menu summary").click();
    await page.locator("#theme").selectOption("light");
    await page.waitForURL(/theme=light/);
    assert.equal(await page.locator("#run-note").inputValue(), "Keep this draft across appearance changes.");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
    for (const href of await page.locator("nav a").evaluateAll(links => links.map(a => a.href))) assert.equal(new URL(href).searchParams.get("theme"), "light");
    assert.equal(new URL(page.url()).searchParams.get("run"), RUN);
    assert.equal(new URL(page.url()).searchParams.get("by"), "harness");
    await page.addStyleTag({ url: `${origin}/host-tokens.css` });
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(240, 240, 240)");
    assert.equal(await page.locator(".brand .icon").evaluate(el => getComputedStyle(el).color), "rgb(0, 92, 110)");
  }
  await page.goto(`${origin}/host`);
  const frame = page.frameLocator("iframe");
  await frame.locator("h1").waitFor();
  assert.equal(await frame.locator("html").getAttribute("data-theme"), "dark");
  assert.match(await frame.locator("a.home").getAttribute("href"), /^\/host$/);
});

test("five viewport widths, landscape and 200 percent zoom contain long content and controls", { timeout: 90_000 }, async t => {
  const { page, origin } = await open(t, { hostile: true });
  for (const base of ["", "/gallivant"]) {
    for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1280, 900], [1440, 1000], [844, 390]]) {
      await page.setViewportSize({ width, height });
      for (const path of [`${base}/`, runPath(base), `${base}/runs`]) {
        await page.goto(origin + path);
        assert.deepEqual(await noOverflow(page), { width, scroll: width }, path);
        for (const element of await page.locator("nav a, .menu summary, #groupby, #filter, .run-actions button, #run-note").all()) {
          const rect = await element.boundingBox();
          assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= width + 1, `${path}: control fits ${width}`);
          assert.ok(rect.height >= 44, `${path}: touch target ${rect.height}`);
        }
      }
    }
    // Browser zoom at 1280 yields a 640 CSS-pixel layout; also scale content with
    // CSS zoom to exercise enlarged text/controls independently of viewport size.
    await page.setViewportSize({ width: 640, height: 450 });
    await page.goto(origin + runPath(base));
    assert.deepEqual(await noOverflow(page), { width: 640, scroll: 640 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addStyleTag({ url: `${origin}/zoom.css` });
    assert.deepEqual(await noOverflow(page), { width: 1280, scroll: 1280 });
    await page.locator("#run-note").focus();
    await page.keyboard.type("Keyboard at 200 percent");
    assert.equal(await page.locator("#run-note").inputValue(), "Keyboard at 200 percent");
  }
});

test("keyboard skip, disclosure return, grouping, filter and reduced motion", { timeout: 30_000 }, async t => {
  const { page, origin } = await open(t);
  await page.goto(`${origin}/gallivant/?theme=dark`);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(":focus").textContent(), "Skip to main content");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(":focus").getAttribute("id"), "main");
  const summary = page.locator(".menu summary");
  await summary.focus(); await page.keyboard.press("Enter");
  await page.keyboard.press("Tab"); assert.equal(await page.locator(":focus").getAttribute("id"), "theme");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".menu").getAttribute("open"), null);
  assert.equal(await summary.evaluate(el => el === document.activeElement), true);
  assert.equal(await summary.evaluate(el => getComputedStyle(el).outlineStyle), "solid");
  const toggle = page.locator(".group-toggle").first();
  await toggle.focus(); await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Enter"); assert.equal(await toggle.getAttribute("aria-expanded"), "true");
  await page.locator("#filter").fill("no match for this");
  assert.equal(await page.locator("#matches").textContent(), "0 matches");
  await page.keyboard.press("Escape"); assert.equal(await page.locator("#side a.row:visible").count(), 6);
  await page.locator("#groupby").selectOption("harness");
  await page.waitForURL(/by=harness/);
  assert.equal(new URL(page.url()).searchParams.get("theme"), "dark");
  const motion = await page.locator("*").evaluateAll(els => els.every(el => {
    const s = getComputedStyle(el); return s.animationName === "none" && s.transitionDuration.split(",").every(v => parseFloat(v) === 0);
  }));
  assert.equal(motion, true);
});

test("all pages and empty states pass accessibility in both themes", { timeout: 90_000 }, async t => {
  const { page, origin } = await open(t);
  for (const theme of ["dark", "light"]) {
    for (const path of [`/run?id=${encodeURIComponent(TASK)}`, "/runs", "/gallivant/run?id=missing"]) {
      await page.goto(`${origin}${path}${path.includes("?") ? "&" : "?"}theme=${theme}`);
      await contrast(page);
    }
  }
  const empty = await fixture({ empty: true });
  try {
    const emptyContext = await browser.newContext();
    try {
      await emptyContext.route("**/*", route => new URL(route.request().url()).origin === empty.origin ? route.continue() : route.abort());
      const emptyPage = await emptyContext.newPage();
      for (const path of ["/?theme=dark", "/runs?theme=light"]) {
        await emptyPage.goto(empty.origin + path); await contrast(emptyPage); assert.ok(await emptyPage.locator(".empty").count());
      }
    } finally { await emptyContext.close(); }
  } finally { await empty.close(); }
});

test("malicious rendered text is inert and CSP blocks inline script and external connections", { timeout: 30_000 }, async t => {
  const { page, origin } = await open(t, { hostile: true });
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/`);
    assert.ok((await page.locator("main").textContent()).includes(MALICIOUS));
    assert.equal(await page.locator("img, [onerror]").count(), 0);
    await page.goto(origin + runPath(base));
    await page.waitForFunction(() => document.querySelector("#log").textContent.includes("<img"));
    assert.equal(await page.locator("#log img").count(), 0);
    const blocked = await page.evaluate(async () => {
      const script = document.createElement("script"); script.textContent = "window.injected=true"; document.body.append(script);
      let externalBlocked = false;
      try { await fetch("https://example.invalid/"); } catch { externalBlocked = true; }
      return { injected: Boolean(window.injected), externalBlocked };
    });
    assert.deepEqual(blocked, { injected: false, externalBlocked: true });
  }
});

test("protected requests reject cross-origin and missing tokens; real controls queue only fixture state", { timeout: 45_000 }, async t => {
  const { page, origin, state, context } = await open(t);
  for (const base of ["", "/gallivant"]) {
    state.update(TASK, { control: null });
    await page.goto(origin + runPath(base));
    const endpoint = `${origin}${base}/api/run/control?id=${encodeURIComponent(TASK)}`;
    const token = await page.locator("#run-controls").getAttribute("data-token");
    for (const headers of [
      { Origin: origin },
      { Origin: "https://attacker.invalid", "X-Gallivant-Token": token },
      { Origin: "http://evil.invalid", Host: "evil.invalid", "X-Gallivant-Token": token },
    ]) {
      const denied = await context.request.post(endpoint, { headers, data: { action: "recheck" } });
      assert.equal(denied.status(), 403); assert.equal(state.get(TASK).control, null);
    }
    const noToken = await page.evaluate(async endpoint => (await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"recheck"}' })).status, endpoint);
    assert.equal(noToken, 403);
    await page.locator("#run-note").fill("Keep this unsent fixture draft.");
    const queued = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
    await page.getByRole("button", { name: "Recheck PR", exact: true }).click();
    const accepted = await queued; assert.equal(accepted.status(), 202, await accepted.text());
    assert.equal(state.get(TASK).control.status, "queued");
    assert.equal(state.get(TASK).control.action, "recheck");
    assert.equal(state.get(TASK).state, "needs-human");
    assert.equal(await page.locator("#run-note").inputValue(), "Keep this unsent fixture draft.");
    assert.equal(await page.locator('[data-action="recheck"]').isDisabled(), true);
    assert.equal((await context.request.post(endpoint, { headers: { Origin: origin, "X-Gallivant-Token": token }, data: { action: "recheck" } })).status(), 409);
    state.update(TASK, { control: { ...state.get(TASK).control, status: "applied", message: "Fixture coordinator applied this request." } });
    await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "success");
    assert.equal(await page.locator("#run-note").inputValue(), "Keep this unsent fixture draft.");
    assert.equal(await page.locator("#control-refresh").isVisible(), true);
    state.update(TASK, { control: { ...state.get(TASK).control, status: "queued" } });
    const rejected = page.waitForResponse(r => r.url() === endpoint && r.request().method() === "POST");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    assert.equal((await rejected).status(), 409);
    await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "error");
    assert.equal(await page.locator("#run-note").inputValue(), "Keep this unsent fixture draft.");
  }
});


test("read failures preserve content and drafts; page exit stops refresh", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  let reads = 0;
  page.on("request", request => { if (request.url().includes("/api/run/review-activity")) reads++; });
  await page.goto(origin + runPath(""));
  await page.waitForFunction(() => document.querySelector("#review-activity-state").textContent.includes("10 seconds"));
  const saved = await page.locator("#review-activity-log").textContent();
  await page.locator("#run-note").fill("A draft survives a read outage.");
  const originalRead = state.reviewActivityEntry.bind(state);
  state.reviewActivityEntry = () => { throw new Error("Fixture read unavailable"); };
  await page.clock.runFor(10_100);
  await page.waitForFunction(() => document.querySelector("#review-activity-state").textContent.includes("unavailable"));
  assert.equal(await page.locator("#review-activity-log").textContent(), saved);
  assert.equal(await page.locator("#run-note").inputValue(), "A draft survives a read outage.");
  state.reviewActivityEntry = originalRead;
  await page.clock.runFor(10_100);
  await page.waitForFunction(() => document.querySelector("#review-activity-state").textContent.includes("10 seconds"));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
  const stoppedAt = reads;
  await page.clock.runFor(60_000);
  assert.equal(reads, stoppedAt, "pagehide disposes the refresh controller");
});


test("page exit aborts a read whose headers arrived but JSON body is still pending", { timeout: 30_000 }, async t => {
  const { page, origin, holdReviewBody } = await open(t);
  holdReviewBody();
  const headers = page.waitForResponse(response => response.url().includes("/api/run/review-activity"));
  await page.goto(origin + runPath(""));
  await headers;
  const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url().includes("/api/run/review-activity") });
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
  assert.match((await aborted).failure().errorText, /ABORTED|CANCELLED/);
});
