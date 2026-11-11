import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW, TASK, RUN, MALICIOUS } from "./fixture.mjs";
import { idSlug } from "../../lib/state.mjs";

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
    assert.equal(await page.locator("[data-task-id]").count(), 6);
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
        for (const element of await page.locator("nav a:visible, .menu summary:visible, #groupby:visible, #filter:visible, .run-actions button:visible, #run-note:visible").all()) {
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
  const toggle = page.locator(".task-context > summary").first();
  await toggle.focus(); await page.keyboard.press("Space");
  assert.equal(await page.locator(".task-context").first().getAttribute("open"), "");
  await page.keyboard.press("Enter"); assert.equal(await page.locator(".task-context").first().getAttribute("open"), null);
  await page.locator("#overview-q").fill("no match for this");
  await page.getByRole("button", { name: "Apply filters", exact: true }).click();
  assert.match(await page.locator(".overview-scope").textContent(), /0 match/);
  await page.getByRole("link", { name: "Clear filters", exact: true }).click();
  assert.equal(await page.locator("[data-task-id]").count(), 6);
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
    assert.ok(!(await page.locator("main").textContent()).includes(MALICIOUS), "summary excludes arbitrary source prose");
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

test("overview and detail show the same canonical presentation as the status API", { timeout: 30_000 }, async t => {
  const { page, origin, state, context } = await open(t);
  state.update(TASK, { state: "ready-for-human", reason: null, base: "main", cursor: { fixed_sha: "fixture-head" },
    last: { run: RUN, exit: 0, at: NOW }, task: { completion: { version: 1, target: "integrated" } },
    completionEvidence: { delivery: { repository: "acme/atlas", pr: 42, head: "fixture-head", base: "main", gate: { allow: true } } } });
  const saved = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    const snapshot = await (await context.request.get(`${origin}${base}/api/status`)).json();
    const row = snapshot.needs_you.find(row => row.id === TASK), p = row.presentation;
    assert.equal(row.label, "ready", "legacy API code remains available");
    assert.equal(p.readiness.status, "awaiting_integration");
    await page.goto(`${origin}${base}/`);
    const overview = await page.locator("main").textContent();
    for (const value of [p.phase.label, p.actor, p.readiness.status, p.delivery.target, p.nextAction]) assert.ok(overview.includes(value), value);
    await page.goto(origin + runPath(base));
    for (const [key, value] of [["phase", p.phase.label], ["actor", p.actor], ["readiness", p.readiness.status],
      ["delivery target", p.delivery.target], ["last meaningful activity", p.activity.at], ["next action", p.nextAction]]) {
      assert.equal(await page.locator(`[data-fact="${key}"]`).textContent(), value);
    }
    assert.match(await page.locator("main").textContent(), /selected attempt duration20m/);
  }
  assert.equal(JSON.stringify(state.entries()), saved, "presentation GETs cannot write state");
});

test("malformed review observations remain bounded and unresolved ownership disables writing controls", { timeout: 30_000 }, async t => {
  const { page, origin, state, context } = await open(t);
  state.update(TASK, { state: "running", reason: null, last: { run: RUN, exit: null },
    reviewPolicy: { version: 1, mode: "first-party-required", route: { name: "codex", fingerprint: "f".repeat(64), qualification: "fixture" }, external: null, specialist: null, zeroChecks: true, limits: { timeoutMs: 900000, maxJobs: 2048, retries: 2, budgetUsd: 100, maxInputBytes: 100000 } },
    firstPartyReview: { pieces: {}, retryAt: "invalid", status: "private-provider-payload".repeat(1000), error: MALICIOUS } });
  await page.goto(origin + runPath(""));
  assert.equal(await page.locator('[data-fact="phase"]').textContent(), "Awaiting reconciliation");
  for (const action of ["resume", "message"]) assert.equal(await page.locator(`[data-action="${action}"]`).isDisabled(), true);
  const review = await context.request.get(`${origin}/api/run/review-activity?id=${encodeURIComponent(TASK)}`);
  assert.equal(review.status(), 200); const body = await review.text();
  assert.ok(body.length < 1000); assert.doesNotMatch(body, /private-provider-payload|onerror/);
  assert.equal(await page.locator('[data-fact="ownership"]').textContent(), "reconciling");
});

test("1000 tasks use bounded real DOM pages with no probe, host, model or state writes", { timeout: 60_000 }, async t => {
  const { page, origin, home, ctx } = await open(t, { empty: true });
  const entries = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`acme/atlas/task-${i}`, {
    repo: "acme/atlas", state: "pr-open", harness: "codex", iteration: 0, created_at: NOW,
  }]));
  const path = join(home, "state.json");
  writeFileSync(path, JSON.stringify({ version: 1, entries, chains: {} }));
  const saved = readFileSync(path, "utf8");
  let runReads = 0;
  const forbidden = () => assert.fail("presentation must not invoke external services or dispatch");
  ctx.runnerFor = () => ({ current: () => { runReads++; return null; }, start: forbidden, kill: forbidden });
  ctx.gh = new Proxy({}, { get: () => forbidden }); ctx.git = ctx.gh;
  ctx.providerHealth = { refresh: forbidden }; ctx.probe = forbidden;
  for (const base of ["", "/gallivant"]) {
    runReads = 0;
    await page.goto(`${origin}${base}/?theme=light`);
    assert.equal(runReads, 1000, "one existing saved-run read per task; projection adds none");
    assert.equal(await page.locator("[data-task-id]").count(), 25);
    assert.equal(await page.locator("#side .row").count(), 0);
    assert.ok(await page.locator("body").evaluate(el => el.outerHTML.length) < 300000);
    await page.getByRole("link", { name: "Next tasks", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("offset"), "25");
    assert.match(await page.locator("[data-task-id]").first().textContent(), /task-25/);
    assert.equal(new URL(page.url()).searchParams.get("theme"), "light");
    await page.goBack(); assert.match(await page.locator("[data-task-id]").first().textContent(), /task-0/);
    assert.match(await page.locator(".overview-scope").textContent(), /all 1000 registered tasks/);
    const requests = [];
    const track = request => requests.push(new URL(request.url()).pathname);
    page.on("request", track);
    await page.locator("#overview-q").fill("task-999");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    assert.equal(await page.locator("[data-task-id]").count(), 1);
    assert.match(await page.locator(".overview-scope").textContent(), /all 1000 registered tasks.*1 match/);
    assert.ok(requests.every(path => !path.includes("/api/run/")), "search loads no per-row data or transcripts");
    page.off("request", track);
  }
  assert.equal(readFileSync(path, "utf8"), saved);
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


test("pages opened during queued or applying messages restore current controls after failure", { timeout: 45_000 }, async t => {
  for (const live of [false, true]) {
    const { page, origin, state, ctx } = await open(t, { live });
    if (live) {
      const runnerFor = ctx.runnerFor;
      ctx.runnerFor = id => { const runner = runnerFor(id); return { ...runner, current: () => ({ ...runner.current(), running: id === TASK }) }; };
      state.update(TASK, { last: { run: RUN, exit: null } });
    }
    for (const base of ["", "/gallivant"]) for (const status of ["queued", "applying"]) {
      state.update(TASK, { control: { id: "fixture-pending", action: "message", status, note: "Saved failed message." } });
      await page.goto(origin + runPath(base));
      assert.equal(await page.locator("#run-note").isDisabled(), true);
      if (live) assert.equal(await page.locator("#interrupt-run").isDisabled(), true);
      for (const button of await page.locator("#run-controls button[data-action]").all()) assert.equal(await button.isDisabled(), true);
      state.update(TASK, { control: { ...state.get(TASK).control, status: "failed", message: "Fixture request failed." } });
      await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "error");
      assert.equal(await page.locator("#run-note").isDisabled(), false);
      if (live) assert.equal(await page.locator("#interrupt-run").isDisabled(), false);
      assert.match(await page.locator("#message-help").textContent(), /Continues the same session with your correction/);
      assert.equal(await page.locator("#run-note").inputValue(), "Saved failed message.");
      for (const button of await page.locator("#run-controls button[data-action]").all()) assert.equal(await button.isDisabled(), false);
      assert.equal(await page.locator("#control-refresh").isVisible(), true);
      assert.equal(page.url(), origin + runPath(base), "draft recovery preserves the selected attempt and query");
      await page.locator("#run-note").fill("Edited retry message.");
      const accepted = page.waitForResponse(r => r.request().method() === "POST");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      assert.equal((await accepted).status(), 202);
      assert.equal(state.get(TASK).control.note, "Edited retry message.");
    }
  }
});

test("settled requests refresh controls from current ownership rather than the selected historical attempt", { timeout: 45_000 }, async t => {
  const { page, origin, state } = await open(t);
  const original = state.get(TASK);
  for (const base of ["", "/gallivant"]) for (const change of [
    { state: "done" }, { session: null }, { last: { run: RUN, exit: null } },
    { execution: { version: 1, provider: "fixture", transport: "remote", acceptance: "unknown", providerState: "status-unknown" } },
  ]) {
    state.put(TASK, { ...original, control: { id: "fixture-pending", action: "message", status: "applying", note: "Preserve this message." } });
    await page.goto(origin + runPath(base));
    state.update(TASK, { ...change, control: { ...state.get(TASK).control, status: "failed", message: "Fixture ownership changed." } });
    await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "error").catch(async error => {
      assert.fail(`${JSON.stringify(change)}: ${await page.locator("#control-status").textContent()}; ${error.message}`);
    });
    assert.equal(await page.locator("#run-note").inputValue(), "Preserve this message.");
    assert.equal(await page.locator("#run-note").isDisabled(), true);
    for (const action of ["message", "resume"]) assert.equal(await page.locator(`[data-action="${action}"]`).isDisabled(), true);
    assert.equal(await page.locator('[data-action="cancel"]').isDisabled(), change.state === "done");
  }
});

test("read failures preserve content and drafts; page exit stops refresh", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  let reads = 0;
  page.on("request", request => { if (request.url().includes("/api/run/workspace")) reads++; });
  await page.goto(origin + runPath(""));
  await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));
  const saved = await page.locator("#workspace-review-content").textContent();
  await page.locator("#run-note").fill("A draft survives a read outage.");
  const originalRead = state.entries.bind(state);
  state.entries = () => { throw new Error("Fixture read unavailable"); };
  await page.clock.runFor(10_100);
  await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("disconnected"));
  assert.equal(await page.locator("#workspace-review-content").textContent(), saved);
  assert.equal(await page.locator("#run-note").inputValue(), "A draft survives a read outage.");
  state.entries = originalRead;
  await page.getByRole("button", { name: "Refresh evidence", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide")));
  const stoppedAt = reads;
  await page.clock.runFor(60_000);
  assert.equal(reads, stoppedAt, "pagehide disposes the refresh controller");
});


test("cached page exit aborts a pending JSON body and restoration restarts the read", { timeout: 30_000 }, async t => {
  const { page, origin, holdReviewBody } = await open(t);
  holdReviewBody();
  const headers = page.waitForResponse(response => response.url().includes("/api/run/workspace"));
  await page.goto(origin + runPath(""));
  await headers;
  const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url().includes("/api/run/workspace") });
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  assert.match((await aborted).failure().errorText, /ABORTED|CANCELLED/);
  holdReviewBody(false);
  const restored = page.waitForResponse(response => response.url().includes("/api/run/workspace"));
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await restored;
  await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));
});

test("cached page restoration preserves the composer and resumes one refresh loop without resubmitting actions", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  let reads = 0, posts = 0, documents = 0;
  page.on("request", request => {
    if (request.url().includes("/api/run/workspace")) reads++;
    if (request.method() === "POST") posts++;
    if (request.isNavigationRequest()) documents++;
  });
  for (const base of ["", "/gallivant"]) {
    state.update(TASK, { control: null });
    await page.goto(origin + runPath(base));
    await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));
    await page.locator("#run-note").fill("A cached draft stays with this task.\nKeep the selection too.");
    const accepted = page.waitForResponse(r => r.request().method() === "POST");
    await page.getByRole("button", { name: "Recheck PR", exact: true }).click();
    assert.equal((await accepted).status(), 202);
    await page.waitForFunction(() => document.querySelector("#control-status").textContent.includes("queued."));
    await page.locator("#run-note").focus();
    const before = await page.evaluate(() => {
      const note = document.getElementById("run-note");
      note.setSelectionRange(2, 12, "backward");
      window.cachedNote = note;
      return { value: note.value, scroll: scrollY, url: location.href };
    });
    const navigations = documents, submissions = posts;
    for (let restore = 0; restore < 2; restore++) {
      // Exercise the browser lifecycle events against the actual served script.
      // Explicit persisted events are deterministic under the default browser flags.
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
      const stoppedAt = reads;
      await page.clock.runFor(60_000);
      assert.equal(reads, stoppedAt, "cached pages stop polling");
      state.update(TASK, { control: { ...state.get(TASK).control, status: "applied", message: "Applied while away." } });
      const refreshed = page.waitForResponse(r => r.url().includes("/api/run/workspace"));
      await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
      await refreshed;
      await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "success");
      assert.deepEqual(await page.evaluate(() => {
        const note = document.getElementById("run-note");
        return { same: note === window.cachedNote, value: note.value, start: note.selectionStart,
          end: note.selectionEnd, direction: note.selectionDirection, focused: document.activeElement === note, scroll: scrollY, url: location.href };
      }), { same: true, value: before.value, start: 2, end: 12, direction: "backward", focused: true, scroll: before.scroll, url: before.url });
      assert.equal(documents, navigations, "restoration does not reload the document");
      assert.equal(posts, submissions, "restoration never replays an action");
      await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));
      const resumedAt = reads;
      const tick = page.waitForResponse(r => r.url().includes("/api/run/workspace"));
      await page.clock.runFor(10_100);
      await tick;
      assert.equal(reads, resumedAt + 1, "exactly one refresh loop resumes");
    }
  }
});

test("restored live logs resume from their cursor and preserve rows, history and drafts", { timeout: 30_000 }, async t => {
  const { page, origin, home } = await open(t, { live: true });
  const dir = join(home, "runs", idSlug(TASK), RUN);
  // A bounded tail with older history, using only synthetic files and liveness.
  appendFileSync(join(dir, "job.log"), Array.from({ length: 600 }, (_, i) => `Fixture line ${i + 1}\n`).join(""));
  for (const base of ["", "/gallivant"]) {
    await page.goto(origin + runPath(base));
    await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Fixture line 600"));
    await page.locator("#workspace-activity").evaluate(el => { el.open = true; });
    await page.getByRole("button", { name: "load earlier lines", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Fixture run:"));
    await page.locator("#run-note").fill("Keep the draft while the log reconnects.");
    const before = await page.locator("#log").evaluate(el => {
      el.scrollTop = 50;
      window.savedLogRow = el.querySelector("[data-replay]");
      return { rows: [...el.querySelectorAll("[data-replay]")].map(row => row.textContent), scroll: el.scrollTop };
    });
    const restoredLine = `Output recorded while away from ${base || "root"}.`;
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    appendFileSync(join(dir, "job.log"), restoredLine + "\n");
    const stream = page.waitForRequest(request => request.url().includes("/api/run/output"));
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    const cursor = new URL((await stream).url()).searchParams.get("after");
    assert.ok(Number(cursor) > 0, "a new connection resumes after the last delivered event");
    await page.waitForFunction(line => document.querySelector("#log").textContent.includes(line), restoredLine);
    assert.deepEqual(await page.locator("#log").evaluate(el => ({
      same: el.querySelector("[data-replay]") === window.savedLogRow,
      rows: [...el.querySelectorAll("[data-replay]")].map(row => row.textContent), scroll: el.scrollTop,
    })), { same: true, rows: [...before.rows, restoredLine], scroll: before.scroll });
    assert.equal(await page.locator("#run-note").inputValue(), "Keep the draft while the log reconnects.");
  }
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  writeFileSync(join(dir, "job.json"), JSON.stringify({ ...job, exit: 0,
    execution: { ...job.execution, providerState: "succeeded", collected: true } }));
  await page.waitForFunction(() => document.querySelector("#logstate").textContent === "finished");
  const rows = await page.locator("#log > *").count();
  await page.evaluate(() => {
    dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
  });
  assert.equal(await page.locator("#log > *").count(), rows, "finished logs stay intact on restore");
});
