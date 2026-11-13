import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW } from "./fixture.mjs";
import { seedOverview } from "./overview-fixture.mjs";
import { seedChains } from "./chains-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function open(t, { empty = false, chains = false, javaScriptEnabled = true } = {}) {
  const world = await fixture({ empty: !chains }); t.after(() => world.close());
  const ids = !empty && !chains ? seedOverview(world) : [];
  if (chains) await seedChains(world);
  if (ids.length) {
    const source = world.state.get(ids[7]);
    for (const [id, at, pr] of [["recent-completed", "2026-09-24T14:29:00Z", 90], ["older-completed", "2026-09-24T14:28:00Z", 91]]) world.state.put(`acme/atlas/${id}`, {
      ...source, repo: "acme/atlas", state: "done", activity_at: at, created_at: at, reviewObservation: null,
      control: { status: "failed", action: "resume" }, url: `https://github.com/acme/atlas/pull/${pr}`, pr,
    });
    world.state.put("acme/atlas/status-unobserved", { ...source, repo: "acme/atlas", pr: 92, url: "https://github.com/acme/atlas/pull/92", reviewObservation: null, created_at: null });
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", javaScriptEnabled }); t.after(() => context.close());
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on("pageerror", error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  return { ...world, page, context, ids };
}

test("newest activity leads across status groups; completed and unknown tabs select and restore correctly", { timeout: 60000 }, async t => {
  const w = await open(t), { page, origin, context, state } = w, saved = JSON.stringify(state.entries());
  for (const base of ["", "/gallivant"]) {
    await page.goto(`${origin}${base}/`);
    assert.deepEqual(await page.locator('[data-task-id]').evaluateAll(rows => rows.slice(0, 2).map(row => row.dataset.taskId)), ['acme/atlas/recent-completed', 'acme/atlas/older-completed']);
    assert.equal(await page.locator('.overview-total[aria-current="page"]').getAttribute('data-kind'), 'all');
    await page.locator('[data-key="total:ended"]').click();
    assert.equal(await page.locator('[data-task-id]').count(), 2);
    assert.equal(await page.locator('.overview-total[aria-current="page"]').getAttribute('data-kind'), 'ended');
    const snapshot = await (await context.request.get(`${origin}${base}/api/status`)).json();
    const completed = snapshot.done.find(row => row.id === 'acme/atlas/recent-completed');
    assert.equal(completed.presentation.phase.id, 'completed'); assert.equal(completed.presentation.readiness.status, 'unverified');
    await page.locator('[data-key="total:unknown"]').click();
    assert.equal(await page.locator('[data-task-id]').count(), 1);
    assert.equal(await page.locator('.overview-total[aria-current="page"]').getAttribute('data-kind'), 'unknown');
    await page.goBack();
    assert.equal(await page.locator('.overview-total[aria-current="page"]').getAttribute('data-kind'), 'ended');
    await page.reload(); assert.equal(await page.locator('[data-task-id]').count(), 2);
    await page.locator('[data-key="total:all"]').click();
    await page.locator('#overview-sort').selectOption('attention');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    assert.equal(await page.locator('.overview-section:visible').first().getAttribute('data-kind'), 'attention');
    assert.match(new URL(page.url()).search, /sort=attention/);
  }
  assert.equal(JSON.stringify(state.entries()), saved, 'display choices cannot certify or mutate task state');
});

test("external PR links open a safe new tab; live links share the policy and internal links stay local", { timeout: 30000 }, async t => {
  const { page, context, origin } = await open(t);
  await context.route('https://github.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>PR fixture</title><p>Review fixture</p>' }));
  await page.goto(`${origin}/gallivant/?attention=ended`);
  const link = page.locator('[data-task-id]').first().locator('a[target="_blank"]').first(), before = page.url();
  assert.match(await link.getAttribute('rel'), /noopener/); assert.match(await link.getAttribute('rel'), /noreferrer/);
  const opened = context.waitForEvent('page'); await link.click(); const popup = await opened;
  await popup.waitForLoadState('domcontentloaded'); assert.equal(await popup.evaluate(() => window.opener), null); await popup.close();
  assert.equal(page.url(), before);
  await page.evaluate(() => { const link = document.createElement('a'); link.id = 'new-external'; link.href = 'https://example.com/report'; link.textContent = 'New report'; document.querySelector('main').append(link); });
  await page.waitForFunction(() => document.getElementById('new-external').target === '_blank');
  await page.locator('#new-external').evaluate(el => { el.href = '/gallivant/'; });
  await page.waitForFunction(() => !document.getElementById('new-external').hasAttribute('target'));
  assert.equal(await page.locator('.task-identity h3 a').first().getAttribute('target'), null);
});

test("shared navigation shows a skeleton while a page is pending and Chains preselects a real item", { timeout: 30000 }, async t => {
  const { page, origin, state } = await open(t, { chains: true }); const saved = JSON.stringify(state.chains());
  await page.goto(`${origin}/gallivant/`);
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route(`${origin}/gallivant/chains*`, async route => { await gate; await route.continue(); });
  // Read the outgoing document directly: locators wait for the deliberately
  // held navigation to finish before resolving against a document.
  const pending = await page.evaluate(() => {
    document.querySelector('nav a[href="/gallivant/chains"]').click();
    return new Promise(resolve => setTimeout(() => resolve({ hidden: document.getElementById('page-loading').hidden,
      busy: document.getElementById('main').getAttribute('aria-busy'),
      text: document.getElementById('page-loading-status').textContent,
      skeleton: document.getElementById('page-loading-status').dataset.skeleton }), 250));
  });
  assert.equal(pending.hidden, false); assert.equal(pending.busy, 'true');
  assert.match(pending.text, /Opening Chains/); assert.equal(pending.skeleton, 'true');
  release(); await page.waitForURL('**/gallivant/chains*');
  await page.locator('.chain-workspace').waitFor();
  assert.ok(new URL(page.url()).searchParams.get('chain'));
  assert.equal(await page.locator('.chain-index-list [aria-current="page"]').count(), 1);
  assert.equal(await page.locator('#page-loading').isVisible(), false);
  await page.goBack(); assert.equal(await page.locator('#page-loading').isVisible(), false);
  assert.equal(JSON.stringify(state.chains()), saved);
});

test("empty, filtered, mobile and both-theme states remain readable, operable and accessible", { timeout: 90000 }, async t => {
  const { page, origin } = await open(t);
  for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(`${origin}/gallivant/?theme=${theme}`);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
    assert.ok(dimensions.content <= dimensions.width + 1, `${theme} at ${width}: horizontal overflow`);
    for (const el of await page.locator('.overview-total').all()) assert.ok((await el.boundingBox()).height >= 44);
    await page.locator('[data-key="total:ended"]').focus(); assert.notEqual(await page.locator('[data-key="total:ended"]').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(axe.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
  }
  await page.goto(`${origin}/gallivant/?q=no-such-task`);
  assert.equal(await page.locator('[data-task-id]').count(), 0); assert.match(await page.locator('[data-key="empty"]').textContent(), /No tasks match/);
  assert.ok(await page.getByRole('link', { name: 'Reset filters', exact: true }).isVisible());
});

test("server-rendered completed filters and PR links remain usable without JavaScript", { timeout: 30000 }, async t => {
  const { page, origin } = await open(t, { javaScriptEnabled: false });
  await page.goto(`${origin}/gallivant/?attention=ended`);
  assert.equal(await page.locator('[data-task-id]').count(), 2);
  assert.equal(await page.locator('.overview-total[aria-current="page"]').getAttribute('data-kind'), 'ended');
  assert.equal(await page.locator('[data-task-id]').first().locator('a[target="_blank"]').count(), 1);
  assert.equal(await page.locator('#page-loading').isVisible(), false);
});
