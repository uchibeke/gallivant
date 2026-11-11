import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW } from "./fixture.mjs";
import { seedOverview, LONG_REPO } from "./overview-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30_000 });
after(async () => { await browser?.close(); });
async function open(t, options = {}) {
  const world = await fixture({ empty: true });
  t.after(() => world.close());
  const ids = seedOverview(world);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", ...options });
  t.after(() => context.close());
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
  return { ...world, page, context, ids };
}
const row = (page, id) => page.locator(`[data-task-id="${id}"]`);
const updated = page => page.waitForFunction(() => !document.querySelector("#overview-refresh").disabled);

test("overview prioritizes decisions with qualified readiness, meaningful summaries and safe context", { timeout: 30_000 }, async t => {
  const { page, origin, state, context, ids } = await open(t);
  const saved = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/?theme=dark`);
    const snapshot = await (await context.request.get(`${origin}${base}/api/status`)).json();
    const models = [...snapshot.needs_you, ...snapshot.running, ...snapshot.done];
    const groups = await page.locator(".overview-section:visible").evaluateAll(els => els.map(el => el.dataset.kind));
    assert.deepEqual(groups, ["attention", "ready", "progressing", "waiting"]);
    assert.equal(await page.locator('.overview-section[data-kind="attention"] [data-task-id]').count(), 4);
    assert.match(await page.getByRole("link", { name: "New task", exact: true }).getAttribute("href"), /\/task\/new/);
    for (const id of ids) {
      const p = models.find(r => r.id === id).presentation;
      const task = row(page, id);
      const content = await task.textContent();
      for (const value of [p.phase.label, p.attention.nextAction, p.readiness.status, p.checks.status, p.attention.actor, LONG_REPO, "Rounds 2 / 5", "release"])
        assert.ok(content.includes(value), `${id}: ${value}`);
      assert.match(await task.locator("h3 a").getAttribute("href"), new RegExp(`^${base}/run`));
      await task.locator(".task-context > summary").click();
      assert.ok(await task.locator(".task-context-body").isVisible());
      assert.ok((await task.locator(".task-context-body").textContent()).includes(p.attention.explanation));
      assert.equal(await task.locator(".technical-reason").getAttribute("open"), null);
      await task.locator(".technical-reason > summary").click();
      assert.ok((await task.locator(".technical-reason").textContent()).includes(p.attention.source));
      assert.equal(await task.locator(`a[href="https://github.com/${LONG_REPO}/pull/${42 + ids.indexOf(id)}"]`).count(), 1);
      assert.equal(await task.locator("button[data-action]").count(), 0, "mutations stay in protected task controls");
    }
    assert.match(await row(page, ids[4]).textContent(), /automatic coordinator work/);
    assert.match(await row(page, ids[2]).textContent(), /2026-09-24T14:10:00.000Z/);
    assert.match(await row(page, ids[6]).textContent(), /7\/8/);
  }
  assert.equal(JSON.stringify(state.entries()), saved);
});

test("stopped tasks with missing owned runs stay actionable without enabling another writer", { timeout: 30_000 }, async t => {
  const { page, origin, state, context, ids } = await open(t);
  const id = ids[1], at = "2026-09-24T14:10:00.000Z";
  state.update(id, { reason: "run-stop-unverified", last: { run: "missing-attempt", exit: null, at } });
  const saved = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/?attention=attention`);
    const task = row(page, id);
    assert.equal(await task.count(), 1);
    assert.equal(await task.evaluate(el => el.closest("section").dataset.kind), "attention");
    assert.equal(await task.locator(".task-decision strong").textContent(), "Execution stop unconfirmed");
    assert.match(await task.locator(".task-decision p").textContent(), /reconcile its status before starting another writer/);
    assert.equal(await task.locator("time").getAttribute("datetime"), at);
    const snapshot = await (await context.request.get(`${origin}${base}/api/status`)).json();
    const p = snapshot.needs_you.find(task => task.id === id).presentation;
    assert.equal(p.phase.id, "reconciling");
    assert.equal(p.ownership, "reconciling");
    assert.equal(p.attention.actor, "operator");
    for (const action of ["resume", "message", "interrupt"]) assert.equal(p.controls[action], false);
    await task.locator(".task-context > summary").click();
    assert.match(await task.locator(".task-context-body").textContent(), /previous execution has not been confirmed stopped/);
    await task.locator(".technical-reason > summary").click();
    assert.match(await task.locator(".technical-reason").textContent(), /run-stop-unverified/);
    await task.locator(".task-open").click();
    assert.equal(await page.getByRole("button", { name: "Resume agent", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("#run-note").isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isDisabled(), true);
  }
  assert.equal(JSON.stringify(state.entries()), saved);
});

test("all overview filters and page context survive task navigation, theme, reload and browser back", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  const saved = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    const params = new URLSearchParams({ q: "brief", repo: LONG_REPO, phase: "operator_attention", harness: "codex", attention: "attention", chain: "release", theme: "dark" });
    await page.goto(`${origin}${base}/?${params}`);
    assert.equal(await page.locator("[data-task-id]").count(), 1);
    assert.match(await page.locator(".overview-scope").textContent(), /all 8 registered tasks.*1 match/);
    for (const [key, value] of params) if (key !== "theme") assert.equal(await page.locator(`#overview-${key}`).inputValue(), value);
    await page.locator("[data-task-id] h3 a").click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    for (const [key, value] of params) assert.equal(new URL(page.url()).searchParams.get(key), value);
    await page.reload();
    assert.equal(await page.locator("[data-task-id]").count(), 1);
    await page.locator(".menu summary").click(); await page.locator("#theme").selectOption("light");
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("theme"), "light");
    await page.getByRole("link", { name: "Clear filters", exact: true }).click();
    assert.equal(await page.locator("[data-task-id]").count(), 8);
    await page.goBack(); assert.equal(await page.locator("#overview-q").inputValue(), "brief");
    await page.goto(`${origin}${base}/?${params}&offset=25`);
    assert.equal(await page.locator("[data-task-id]").count(), 0);
    await page.locator("#overview-refresh").click(); await updated(page);
    assert.equal(new URL(page.url()).searchParams.get("offset"), "25");
    assert.match(await page.locator(".overview-scope").textContent(), /No tasks on this page/);
    await page.getByRole("link", { name: "Previous tasks", exact: true }).click();
    assert.equal(await page.locator("[data-task-id]").count(), 1);
  }
  assert.equal(JSON.stringify(state.entries()), saved);
});

test("snapshot refresh reconciles filter choices without replacing drafts, selections or focused controls", { timeout: 30_000 }, async t => {
  const { page, origin, state, ids } = await open(t);
  const repo = "acme/new-repository", id = `${repo}/new-task`, chain = "next-release", harness = "fixture-harness";
  // A completed synthetic chain permits registration/removal without any dispatch.
  state.createChain({ name: chain, repo, base: "main", status: "done", index: 0, steps: [{ id }] });
  const entry = { ...state.get(ids[7]), repo, harness, pr: 52, url: `https://github.com/${repo}/pull/52`,
    reviewObservation: { head: "head", binding: "binding", external: "waiting", checks: { count: 1, settled: false }, observedAt: NOW } };
  const choices = { repo, phase: "ci_wait", harness, chain };
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/?${new URLSearchParams({ repo: LONG_REPO, theme: "dark" })}`);
    const url = page.url();
    await page.evaluate(() => { window.savedForm = document.querySelector(".overview-filters"); window.savedSearch = document.querySelector("#overview-q"); });
    for (const [key, value] of Object.entries({ phase: "operator_attention", harness: "claude", attention: "ready", chain: "release" }))
      await page.locator(`#overview-${key}`).selectOption(value);
    await page.locator("#overview-q").fill("unfinished search");
    await page.locator("#overview-q").evaluate(el => el.setSelectionRange(1, 5));
    state.put(id, entry);
    await page.clock.runFor(10_000); await updated(page);
    for (const [key, value] of Object.entries(choices))
      assert.equal(await page.locator(`#overview-${key} option`).evaluateAll((options, value) => options.some(option => option.value === value), value), true, `${key} gains its new choice`);
    assert.deepEqual(await page.evaluate(() => ({ form: window.savedForm === document.querySelector(".overview-filters"),
      search: window.savedSearch === document.activeElement, value: window.savedSearch.value, start: window.savedSearch.selectionStart, end: window.savedSearch.selectionEnd })),
    { form: true, search: true, value: "unfinished search", start: 1, end: 5 });
    for (const [key, value] of Object.entries({ repo: LONG_REPO, phase: "operator_attention", harness: "claude", attention: "ready", chain: "release" }))
      assert.equal(await page.locator(`#overview-${key}`).inputValue(), value);
    assert.equal(page.url(), url);
    assert.equal(await page.locator(".overview-filter-options").getAttribute("open"), "");

    // Removed choices remain selected, including unsaved choices absent from the URL.
    await page.locator("#overview-q").fill("");
    for (const [key, value] of Object.entries({ ...choices, attention: "waiting" })) await page.locator(`#overview-${key}`).selectOption(value);
    await page.locator("#overview-harness").focus();
    const activeOptions = await page.locator("#overview-harness").innerHTML();
    state.remove(id);
    await page.clock.runFor(10_000); await updated(page);
    assert.equal(await page.locator("#overview-harness").evaluate(el => el === document.activeElement), true);
    assert.equal(await page.locator("#overview-harness").innerHTML(), activeOptions, "an active native picker is not rewritten");
    await page.locator("#overview-q").focus();
    for (const [key, value] of Object.entries(choices)) {
      assert.equal(await page.locator(`#overview-${key}`).inputValue(), value);
      assert.match(await page.locator(`#overview-${key} option:checked`).textContent(), /no current tasks/);
    }
    assert.equal(page.url(), url);

    // Manual refresh brings the choices back without resetting the unsaved form.
    state.put(id, entry);
    await page.locator("#overview-refresh").click(); await updated(page);
    for (const [key, value] of Object.entries(choices)) {
      assert.equal(await page.locator(`#overview-${key}`).inputValue(), value);
      assert.doesNotMatch(await page.locator(`#overview-${key} option:checked`).textContent(), /no current tasks/);
    }
    const saved = JSON.stringify(state.entries());
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("repo") === repo);
    assert.equal(await row(page, id).count(), 1);
    await page.reload();
    for (const [key, value] of Object.entries(choices)) assert.equal(await page.locator(`#overview-${key}`).inputValue(), value);
    assert.equal(JSON.stringify(state.entries()), saved);
    state.remove(id);
  }
});

test("pending predecessor chains appear in refreshed choices and filters alongside owned milestones", { timeout: 30_000 }, async t => {
  const { page, origin, state, context, ids } = await open(t);
  const id = ids[5];
  state.update(id, { branch: "work/ready" });
  const entry = state.get(id);
  for (const [i, base] of ["", "/gallivant"].entries()) {
    const name = `follow-on-${i}`;
    await page.goto(`${origin}${base}/?theme=dark`);
    const after = { id, ...Object.fromEntries(["repo", "base", "branch", "pr", "url"].map(key => [key, entry[key]])), merged: null };
    state.createChain({ name, repo: entry.repo, base: entry.base, status: "active", index: 0, after,
      steps: [{ id: `${LONG_REPO}/next-${i}` }, { id: `${LONG_REPO}/last-${i}` }] });
    const saved = JSON.stringify(state.entries());
    await page.clock.runFor(10_000); await updated(page);
    const task = row(page, id);
    assert.match(await task.locator(".task-progress").textContent(), /release · 6\/8 · active/);
    assert.ok((await task.locator(".task-progress").textContent()).includes(`${name} · Predecessor · active`));
    const snapshot = await (await context.request.get(`${origin}${base}/api/status`)).json();
    const p = snapshot.needs_you.find(row => row.id === id).presentation;
    assert.deepEqual(p.chains.map(c => [c.name, c.position, c.predecessor]), [["release", 6, false], [name, null, true]]);
    await page.locator(".overview-filter-options > summary").click();
    await page.locator("#overview-chain").selectOption(name);
    await page.getByRole("button", { name: "Apply filters", exact: true }).click();
    await page.waitForURL(url => url.searchParams.get("chain") === name);
    assert.equal(await page.locator("[data-task-id]").count(), 1);
    assert.equal(await row(page, id).count(), 1);
    await row(page, id).locator("h3 a").click();
    await page.getByRole("link", { name: "Overview", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("chain"), name);
    assert.equal(await row(page, id).count(), 1);
    assert.equal(JSON.stringify(state.entries()), saved);
    // Once the recorded predecessor merge is observed, only owned membership remains.
    state.updateChain(name, { after: { ...after, merged: { sha: "a".repeat(40), at: NOW } } });
    await page.locator("#overview-refresh").click(); await updated(page);
    assert.equal(await page.locator("[data-task-id]").count(), 0);
    assert.equal(await page.locator("#overview-chain").inputValue(), name);
    assert.match(await page.locator("#overview-chain option:checked").textContent(), /no current tasks/);
    const refreshed = await (await context.request.get(`${origin}${base}/api/status`)).json();
    assert.deepEqual(refreshed.needs_you.find(row => row.id === id).presentation.chains.map(chain => chain.name), ["release"]);
    assert.equal(JSON.stringify(state.entries()), saved);
  }
});

test("overview retains its last snapshot on failed and slow reads with bounded retry and recovery", { timeout: 30_000 }, async t => {
  const { page, origin } = await open(t);
  let requests = 0, mode = "fail";
  await page.route("**/api/overview*", async route => {
    requests++;
    if (mode === "slow") return; // The real read's AbortController owns its deadline.
    if (mode === "invalid") {
      const response = await route.fetch(), data = await response.json();
      return route.fulfill({ response, json: { ...data, filters: "" } });
    }
    return mode === "fail" ? route.fulfill({ status: 503, body: "offline" }) : route.continue();
  });
  await page.goto(`${origin}/`);
  const initial = await page.locator("#overview-results").innerHTML();
  await page.clock.runFor(10_000); await updated(page);
  assert.match(await page.locator("#overview-status").textContent(), /Stale.*last good snapshot/);
  assert.equal(await page.locator("#overview-results").innerHTML(), initial);
  await page.clock.runFor(20_000); await updated(page);
  await page.clock.runFor(40_000); await updated(page);
  assert.equal(requests, 3);
  assert.match(await page.locator("#overview-status").textContent(), /Disconnected.*paused/);
  await page.clock.runFor(120_000); assert.equal(requests, 3);
  mode = "slow"; await page.locator("#overview-refresh").click();
  assert.equal(await page.locator("[data-task-id]").count(), 8);
  assert.equal(await page.locator("#overview-refresh").isDisabled(), true);
  await page.clock.runFor(8001); await updated(page);
  assert.match(await page.locator("#overview-status").textContent(), /Stale/);
  const filters = await page.locator(".overview-filters").innerHTML();
  mode = "invalid"; await page.locator("#overview-refresh").click(); await updated(page);
  assert.match(await page.locator("#overview-status").textContent(), /Stale/);
  assert.equal(await page.locator("#overview-results").innerHTML(), initial);
  assert.equal(await page.locator(".overview-filters").innerHTML(), filters);
  mode = "ok"; await page.locator("#overview-refresh").click(); await updated(page);
  assert.match(await page.locator("#overview-status").textContent(), /^Current/);
});

test("keyed refresh preserves disclosure, selection, focus, scroll and meaningful age", { timeout: 30_000 }, async t => {
  const { page, origin, state, ids } = await open(t);
  await page.goto(`${origin}/`);
  const task = row(page, ids[0]), details = task.locator(".task-context");
  await details.locator(":scope > summary").click();
  await task.locator(".technical-reason > summary").click();
  await page.evaluate(id => { window.savedTask = document.querySelector(`[data-task-id="${id}"]`); }, ids[0]);
  const activity = await task.locator("time").getAttribute("datetime");
  // Blur keyboard focus; a normal keyed poll updates fields inside the same open node.
  await page.locator("#main").focus();
  state.update(ids[0], { iteration: 3, updated_at: NOW });
  await page.clock.runFor(10_000); await updated(page);
  assert.equal(await page.evaluate(() => window.savedTask.isConnected), true);
  assert.equal(await details.getAttribute("open"), "");
  assert.equal(await task.locator(".technical-reason").getAttribute("open"), "");
  assert.match(await task.locator(".task-progress").textContent(), /Rounds 3/);
  assert.equal(await task.locator("time").getAttribute("datetime"), activity);
  // Select real text: defer the complete patch until the user chooses to apply it.
  await task.locator(".task-decision strong").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range); });
  const selected = await page.evaluate(() => getSelection().toString());
  state.update(ids[0], { iteration: 4 });
  await page.clock.runFor(10_000); await updated(page);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.match(await task.locator(".task-progress").textContent(), /Rounds 3/);
  assert.equal(await page.locator("#overview-apply").isVisible(), true);
  await page.evaluate(() => getSelection().removeAllRanges());
  await task.locator("h3 a").focus();
  const y = await page.evaluate(() => scrollY);
  await page.clock.runFor(10_000); await updated(page);
  assert.equal(await task.locator("h3 a").evaluate(el => el === document.activeElement), true);
  assert.equal(await page.evaluate(() => scrollY), y);
  // Structural changes while reading are offered, never forced into the scrolled list.
  await page.locator("#main").evaluate(el => el.focus({ preventScroll: true }));
  state.update(ids[0], { state: "pr-open", reason: null });
  await page.clock.runFor(10_000); await updated(page);
  assert.equal(await page.evaluate(() => scrollY), y);
  assert.equal(await details.getAttribute("open"), "");
  await page.locator("#overview-apply").click();
  assert.match(await page.locator("#overview-status").textContent(), /^Current/);
  assert.equal(await page.locator("[data-task-id]").count(), 8);
});

test("overview themes, five widths, landscape, zoom and expanded long names are accessible", { timeout: 90_000 }, async t => {
  const { page, origin } = await open(t);
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 390, 768, 1280, 1440, 844]) {
      await page.setViewportSize({ width, height: width === 844 ? 390 : 900 });
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator(".task-context > summary").first().click();
      await page.locator(".overview-filter-options > summary").click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      for (const control of await page.locator('.overview-filters input:not([type="hidden"]), .overview-filters select, .overview-filters button, .overview-task h3 a, .task-context > summary, #overview-refresh').all()) {
        const box = await control.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.height >= 44);
      }
      if ([390, 1440].includes(width)) {
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        assert.deepEqual(result.violations.map(v => v.id), []);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addStyleTag({ url: `${origin}/zoom.css` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1280);
    await page.locator("#overview-q").focus(); await page.keyboard.type("brief");
    await page.keyboard.press("Enter");
    await page.waitForURL(/q=brief/);
    assert.equal(await page.locator("[data-task-id]").count(), 1);
  }
});

test("overview lifecycle cancels slow reads, pauses hidden polling and resumes one controller", { timeout: 30_000 }, async t => {
  const { page, origin } = await open(t);
  let requests = 0;
  const firstRead = Promise.withResolvers();
  await page.route("**/api/overview*", route => {
    requests++;
    if (requests === 1) { firstRead.resolve(); return; }
    return route.continue();
  });
  await page.goto(`${origin}/`);
  await page.clock.runFor(10_000);
  // Advancing browser time does not wait for the driver's route callback.
  await firstRead.promise;
  assert.equal(requests, 1);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.clock.runFor(120_000);
  assert.equal(requests, 1);
  await page.evaluate(() => dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await updated(page);
  assert.equal(requests, 2);
  assert.match(await page.locator("#overview-status").textContent(), /^Current/);
  await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
  await page.clock.runFor(60_000); assert.equal(requests, 2);
  await page.evaluate(() => delete document.hidden);
  await page.clock.runFor(10_000); await updated(page); assert.equal(requests, 3);
  await page.getByRole("link", { name: "Run history", exact: true }).click();
  await page.clock.runFor(60_000); assert.equal(requests, 3);
});
