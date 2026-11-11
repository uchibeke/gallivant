import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, firefox, webkit } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW, TASK, RUN } from "./fixture.mjs";
import { seedChains, CHAIN } from "./chains-fixture.mjs";
import { settleControl } from "./controls-fixture.mjs";
import { intakeFixture, INTAKE_REQUEST } from "./intake-fixture.mjs";

async function surface(browser, world) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const errors = [], external = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
  return { page, async close() {
    await context.close();
    assert.deepEqual(errors, [], "served browser scripts have no errors");
    assert.deepEqual(external, [], "no external browser requests");
  } };
}

for (const type of [chromium, firefox, webkit]) {
  for (const base of ["", "/gallivant"]) test(`${type.name()} complete operator journey at ${base || "/"}`, { timeout: 90_000 }, async t => {
    const browser = await type.launch(); t.after(() => browser.close());
    const world = await fixture(); t.after(() => world.close());
    const chain = await seedChains(world), reads = chain.hostReads();
    const ui = await surface(browser, world); t.after(() => ui.close());
    const { page } = ui;
    await page.goto(`${world.origin}${base}/?theme=light`);
    // Safari on macOS uses Option-Tab to include links when full keyboard
    // access is off. Exercise that native keyboard route, without forcing focus.
    await page.keyboard.press(type === webkit && process.platform === "darwin" ? "Alt+Tab" : "Tab");
    assert.equal(await page.locator(":focus").textContent(), "Skip to main content");
    await page.keyboard.press("Enter");
    assert.equal(await page.locator(":focus").getAttribute("id"), "main");
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Tasks", exact: true }).click();
    await page.locator("#commands-open").click();
    await page.getByRole("navigation", { name: "Quick navigation" }).getByRole("link", { name: "Tasks", exact: true }).click();
    assert.equal(await page.locator("#commands").getAttribute("open"), null, "same-page task navigation dismisses the modal");
    assert.equal(await page.locator(":focus").getAttribute("id"), "overview-q");
    await page.locator(`[data-task-id="${TASK}"]`).getByRole("link", { name: "search-index", exact: true }).click();
    await page.locator("#run-note").fill("Keep the rollback path.");
    const denied = await page.evaluate(async () => (await fetch(`${location.pathname.replace(/\/run$/, "")}/api/run/control?id=${new URL(location.href).searchParams.get("id")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "recheck" }),
    })).status);
    assert.equal(denied, 403);
    await page.getByRole("button", { name: "Send message", exact: true }).focus(); await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("control-status").dataset.status === "queued");
    const requestId = world.state.get(TASK).control.id;
    settleControl(world, "failed", "Restore the approved brief before retrying.");
    await page.getByRole("button", { name: "Check request status", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("control-status").dataset.status === "failed");
    assert.equal(await page.locator("#run-note").inputValue(), "Keep the rollback path.");
    await page.reload();
    assert.equal(await page.locator("#run-note").inputValue(), "Keep the rollback path.");
    assert.equal(world.state.get(TASK).control.id, requestId);
    await page.goto(`${world.origin}${base}/chains?chain=${CHAIN}&milestone=${encodeURIComponent(TASK)}&theme=light`);
    assert.match(await page.locator(".chain-progress").textContent(), /1 of 4 dependencies merged/);
    await page.getByRole("link", { name: "migration-rollout", exact: true }).click();
    assert.match(await page.locator(".milestone-detail").textContent(), /Wait for milestone 2 to merge/);
    await page.goBack(); assert.equal(await page.locator('[aria-current="step"]').textContent(), "search-index");
    for (const [name, heading] of [["Run history", "Run history"], ["System health", "System health"], ["Overview", "Overview"]]) {
      await page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name, exact: true }).click();
      assert.equal(await page.locator("h1").textContent(), heading);
      assert.equal(new URL(page.url()).searchParams.get("theme"), "light");
      assert.ok(new URL(page.url()).pathname.startsWith(base || "/"));
    }
    assert.equal(chain.hostReads(), reads, "navigation never queries the host");

    const intake = await intakeFixture(); t.after(() => intake.close());
    const input = await surface(browser, intake); t.after(() => input.close());
    const p = input.page;
    await p.goto(`${intake.origin}${base}/task/new?theme=light`);
    await p.locator("#intake-repository").selectOption("acme/widget");
    await p.locator("#intake-harness").selectOption("codex");
    await p.locator("#intake-text").fill("   ");
    await p.locator("#intake-prepare").click();
    assert.equal(await p.locator("#intake-text").getAttribute("aria-invalid"), "true");
    await p.locator("#intake-text").fill(INTAKE_REQUEST);
    await p.locator("#intake-prepare").click();
    await p.getByLabel("Which file format should export use?").fill("Use CSV.");
    await p.reload();
    assert.equal(await p.getByLabel("Which file format should export use?").inputValue(), "Use CSV.");
    await p.getByRole("button", { name: "Save answers and prepare", exact: true }).click();
    await p.waitForFunction(() => document.getElementById("intake-review")?.dataset.status === "ready");
    assert.equal(intake.calls.start, 0);
    await p.getByRole("button", { name: "Review Start", exact: true }).click();
    assert.equal(await p.locator(":focus").getAttribute("id"), "intake-cancel");
    await p.keyboard.press("Escape"); assert.equal(intake.calls.start, 0);
    await p.getByRole("button", { name: "Review Start", exact: true }).click();
    await p.getByRole("button", { name: "Start approved revision", exact: true }).click();
    await p.waitForURL(url => url.pathname === `${base}/run`);
    assert.equal(intake.calls.start, 1); assert.equal(intake.calls.prepare, 2);
  });
}

test("all destinations reflow in both themes, landscape and enlarged content", { timeout: 180_000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const world = await fixture({ hostile: true }); t.after(() => world.close());
  await seedChains(world);
  const ui = await surface(browser, world); t.after(() => ui.close());
  const { page } = ui;
  const paths = ["/", `/run?id=${encodeURIComponent(TASK)}&run=${RUN}`, `/chains?chain=${CHAIN}`, "/task/new", "/health", "/runs"];
  for (const theme of ["dark", "light"]) {
    for (const [width, height, zoom] of [[360, 800], [390, 844], [768, 1024], [1280, 900], [1440, 1000], [844, 390], [640, 450], [1280, 900, true]]) {
      await page.setViewportSize({ width, height });
      for (const path of paths) {
        await page.goto(`${world.origin}/gallivant${path}${path.includes("?") ? "&" : "?"}theme=${theme}`);
        if (zoom) await page.addStyleTag({ url: `${world.origin}/zoom.css` });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width} zoom=${!!zoom} ${path}`);
        for (const control of await page.locator("main button:visible, main input:visible, main select:visible, .views a:visible").all()) {
          const box = await control.boundingBox();
          assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `action fits: ${path}`);
          assert.ok(box.height >= 44 || await control.getAttribute("type") === "checkbox", `touch target: ${path}`);
        }
        if (width === 1440) {
          const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
          assert.deepEqual(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), [], path);
        }
      }
    }
  }
});
