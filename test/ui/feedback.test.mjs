import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { fixture, NOW, TASK } from './fixture.mjs';
import { intakeFixture, INTAKE_REQUEST } from './intake-fixture.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function open(t, world, viewport = { width: 1440, height: 1000 }) {
  t.after(() => world.close());
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
  t.after(() => context.close());
  await context.route('**/*', route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  return { ...world, page, context };
}
async function fill(page) {
  await page.locator('#intake-repository').selectOption('acme/widget');
  await page.locator('#intake-harness').selectOption('codex');
  await page.locator('#intake-text').fill(INTAKE_REQUEST);
}

test('slow navigation feedback never shifts the document, standalone, mounted or framed; fast links never flash it', { timeout: 30000 }, async t => {
  const w = await open(t, await fixture()), { page, origin } = w;
  let shown = 0;
  await page.exposeFunction('feedbackShown', () => { shown++; });
  for (const base of ['', '/gallivant']) {
    await page.goto(origin + base + '/');
    await page.evaluate(() => new MutationObserver(() => {
      if (!document.getElementById('page-loading').hidden) window.feedbackShown();
    }).observe(document.getElementById('page-loading'), { attributes: true, attributeFilter: ['hidden'] }));
    await page.getByRole('link', { name: 'Run history', exact: true }).click();
    assert.equal(shown, 0, 'quick native navigation does not reveal a transient loader');
  }
  for (const framed of [false, true]) {
    await page.goto(origin + (framed ? '/host' : '/gallivant/'));
    const frame = framed ? page.frames().find(f => f.url().includes('/gallivant')) : page.mainFrame();
    await frame.locator('#main').waitFor();
    let release; const gate = new Promise(resolve => { release = resolve; });
    const hold = async route => { await gate; await route.continue(); };
    await page.route(origin + '/gallivant/chains*', hold);
    try {
      const observation = await frame.evaluate(() => {
        const main = document.getElementById('main'), before = main.getBoundingClientRect().top;
        [...document.querySelectorAll('nav a')].find(link => link.textContent.trim() === 'Chains').click();
        const immediate = document.getElementById('page-loading').hidden;
        return new Promise(resolve => setTimeout(() => resolve({ immediate,
          delayed: document.getElementById('page-loading').hidden, before, after: main.getBoundingClientRect().top,
          height: document.getElementById('page-loading').getBoundingClientRect().height,
          busy: main.getAttribute('aria-busy') }), 260));
      });
      assert.equal(observation.immediate, true); assert.equal(observation.delayed, false);
      assert.equal(observation.before, observation.after); assert.equal(observation.height, 0); assert.equal(observation.busy, 'true');
    } finally { release(); }
    await frame.waitForURL('**/gallivant/chains*');
    await page.unroute(origin + '/gallivant/chains*', hold);
  }
});

test('long preparation is visibly pending at submission, survives a lost response/reload, and discovers its result without resubmitting', { timeout: 60000 }, async t => {
  const w = await open(t, await intakeFixture()), { page, origin, calls, ctx } = w;
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  const prepare = ctx.taskIntakeOptions.prepare;
  ctx.taskIntakeOptions.prepare = async (...args) => { await gate; return prepare(...args); };
  const posts = []; page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.goto(origin + '/gallivant/task/new'); await page.clock.install({ time: new Date(NOW) }); await fill(page);
  await page.locator('#intake-prepare').click();
  assert.equal(await page.locator('#intake-prepare').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('#intake-prepare').textContent(), 'Preparing…');
  assert.equal(await page.locator('#intake-local-feedback').isVisible(), true);
  assert.match(await page.locator('#intake-local-feedback').textContent(), /Preparing requirements/);
  await page.clock.runFor(2200);
  await page.waitForFunction(() => document.getElementById('intake-status').textContent.includes('saved revision'));
  assert.equal(await page.locator('#intake-saved-task').isVisible(), true);
  assert.equal(await page.locator('#intake-open-start').count(), 0);
  await page.clock.runFor(16000);
  await page.waitForFunction(() => document.getElementById('intake-prepare').getAttribute('aria-busy') === 'false');
  await page.reload();
  assert.equal(await page.locator('#intake-prepare').isDisabled(), true, 'unresolved identity fences another submission');
  release();
  await page.clock.runFor(6000);
  await page.waitForFunction(() => document.getElementById('intake-review')?.dataset.status === 'needs-input');
  assert.match(await page.locator('#intake-status').textContent(), /answers are needed/);
  assert.equal(await page.locator('[data-intake-step][aria-current="step"]').getAttribute('data-intake-step'), '2');
  assert.equal(posts.length, 1); assert.equal(calls.prepare, 1); assert.equal(calls.start, 0);
});

test('the shared header and disclosure icon slots stay padded, accessible and contained at narrow widths in both themes', { timeout: 60000 }, async t => {
  const { page, origin } = await open(t, await fixture());
  for (const theme of ['dark', 'light']) for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 }); await page.goto(origin + '/gallivant/?theme=' + theme);
    assert.equal(await page.locator('.new-task span').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'New task', exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const slot of await page.locator('.disclosure-icon').all()) {
      const metrics = await slot.evaluate(el => ({ pad: parseFloat(getComputedStyle(el).paddingLeft), size: el.getBoundingClientRect().width }));
      assert.ok(metrics.pad >= 3); assert.ok(metrics.size >= 24);
    }
    await page.locator('details.menu > summary').click();
    const panel = await page.locator('.menu-panel').boundingBox();
    assert.ok(panel.width >= 200 && panel.x >= 0 && panel.x + panel.width <= width);
    assert.equal(await page.locator('#theme').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.locator('.task-context > summary').first().click();
    assert.equal(await page.locator('.task-context[open] .disclosure-icon .icon').first().evaluate(el => getComputedStyle(el).transform), 'matrix(-1, 0, 0, -1, 0, 0)');
    const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(a11y.violations.map(v => v.id), []);
  }
});

test('failed background reads pause after bounded retries and manual recovery never sends another preparation', { timeout: 30000 }, async t => {
  const { page, context, origin, calls } = await open(t, await intakeFixture());
  await context.route('**/api/task/intake/prepare?*', async route => { await route.fetch(); await route.abort(); });
  let reads = 0;
  const failRead = async route => { reads++; await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); };
  await page.route('**/api/task/intake?*', failRead);
  await page.goto(origin + '/task/new'); await page.clock.install({ time: new Date(NOW) }); await fill(page);
  await page.locator('#intake-prepare').click();
  await page.waitForFunction(() => document.getElementById('intake-status').textContent.includes('Response uncertain'));
  for (const delay of [2000, 10000, 20000]) {
    await page.clock.runFor(delay);
    await page.waitForFunction(() => !document.getElementById('intake-refresh').disabled);
  }
  await page.waitForFunction(() => document.getElementById('intake-status').textContent.includes('updates paused'));
  const pausedReads = reads; assert.equal(pausedReads, 3);
  await page.clock.runFor(120000); assert.equal(reads, pausedReads);
  assert.equal(await page.locator('#intake-prepare').isDisabled(), true);
  await page.unroute('**/api/task/intake?*', failRead);
  await page.locator('#intake-refresh').click();
  await page.waitForFunction(() => document.getElementById('intake-review')?.dataset.status === 'needs-input');
  assert.equal(calls.prepare, 1); assert.equal(calls.start, 0);
});

test('unchanged shared feedback preserves selected text while coordinator polling continues', { timeout: 30000 }, async t => {
  const { page, origin, state } = await open(t, await fixture());
  state.update(TASK, { control: { id: 'fixture-feedback', action: 'recheck', status: 'queued', at: NOW } });
  await page.goto(origin + '/gallivant/run?id=' + encodeURIComponent(TASK));
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.runFor(10000);
  const selected = await page.locator('#control-status').evaluate(el => {
    const selection = getSelection(), range = document.createRange(); range.selectNodeContents(el);
    selection.removeAllRanges(); selection.addRange(range); return selection.toString();
  });
  await page.clock.runFor(10000);
  assert.equal(await page.evaluate(() => getSelection().toString()), selected);
  assert.equal(state.get(TASK).control.status, 'queued');
});
