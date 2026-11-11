import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, TASK, RUN, NOW, MALICIOUS } from "./fixture.mjs";
import { seedWorkspace, OLD_RUN } from "./workspace-fixture.mjs";
import { cancelControl } from "../../lib/control.mjs";
import { settleControl as settle } from "./controls-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); }, { timeout: 30_000 });
after(async () => { await browser?.close(); });
const path = (base = "", task = TASK) => `${base}/run?id=${encodeURIComponent(task)}&run=${RUN}&theme=dark`;
async function open(t, options = {}) {
  const world = await fixture(options);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  await page.clock.install({ time: new Date(NOW) });
  await page.clock.setFixedTime(new Date(NOW));
  t.after(async () => { await context.close(); await world.close(); assert.deepEqual(errors, []); });
  return { ...world, page, context };
}
const status = (page, expected) => page.waitForFunction(value => document.getElementById("control-status").dataset.status === value, expected);
async function check(page, expected) {
  await page.getByRole("button", { name: "Check request status", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("control-check").disabled && document.getElementById("control-check").getAttribute("aria-busy") !== "true");
  await status(page, expected);
}

test("keyboard messaging shows exact coordinator states, timestamps and a recoverable failed draft", { timeout: 30_000 }, async t => {
  const world = await open(t), { page, state, origin } = world;
  await page.goto(origin + path());
  await page.locator("#run-note").fill("Preserve the existing task context.");
  await page.getByRole("button", { name: "Send message", exact: true }).focus();
  await page.keyboard.press("Enter");
  await status(page, "queued");
  await page.waitForFunction(() => document.getElementById("run-note").value === "");
  assert.equal(state.get(TASK).control.interrupt, false);
  assert.match(await page.locator("#control-times").textContent(), /Requested: 2026-09-24T14:30:00.000Z/);
  settle(world, "applying"); await check(page, "applying");
  assert.match(await page.locator("#control-times").textContent(), /Applying: 2026-09-24T14:30/);
  settle(world, "failed", "Restore the approved brief before retrying."); await check(page, "failed");
  assert.equal(await page.locator("#run-note").inputValue(), "Preserve the existing task context.");
  assert.match(await page.locator("#control-status").textContent(), /Restore the approved brief/);
  await page.getByRole("button", { name: "Discard draft", exact: true }).click();
  await check(page, "failed");
  assert.equal(await page.locator("#run-note").inputValue(), "", "discard is respected by subsequent polls");
  await page.locator("#last-message summary").click();
  await page.getByRole("button", { name: "Edit and resend", exact: true }).click();
  await page.locator("#run-note").fill("The prerequisite is repaired.");
  const previous = state.get(TASK).control.id;
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("run-note").value === "");
  assert.notEqual(state.get(TASK).control.id, previous, "an explicitly edited failed request is new input");
  settle(world, "applied"); await check(page, "applied");
  assert.match(await page.locator("#control-status").textContent(), /does not confirm model acknowledgement or task completion/);
  assert.match(await page.locator("#control-times").textContent(), /Finished: 2026-09-24/);
});

test("draft text, caret, textarea and reading position survive polling and navigation without task or instance leakage", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  await page.locator("#run-note").fill(Array.from({ length: 25 }, (_, i) => `Correction line ${i}`).join("\n"));
  const before = await page.evaluate(() => {
    const note = document.getElementById("run-note"); note.focus(); note.setSelectionRange(4, 18, "backward"); note.scrollTop = 70;
    scrollTo(0, document.getElementById("run-controls").offsetTop - 40);
    return { value: note.value, start: note.selectionStart, end: note.selectionEnd, direction: note.selectionDirection, top: note.scrollTop, pageY: scrollY };
  });
  await page.clock.runFor(10_100);
  const read = () => page.evaluate(() => { const n = document.getElementById("run-note"); return {
    value: n.value, start: n.selectionStart, end: n.selectionEnd, direction: n.selectionDirection, top: n.scrollTop, pageY: scrollY }; });
  assert.deepEqual(await read(), before);
  await page.reload(); assert.deepEqual(await read(), before);
  await page.goto(origin + path("", "acme/atlas/keyboard-navigation"));
  assert.equal(await page.locator("#run-note").inputValue(), "");
  await page.goto(origin + path("/gallivant")); assert.deepEqual(await read(), before);
  const token = await page.locator("#run-controls").getAttribute("data-token");
  const stored = await page.evaluate(() => localStorage.getItem("task-control-drafts-v1"));
  assert.equal(stored.includes(token), false);
  assert.equal(page.url().includes("Correction"), false);
  const other = await fixture(); t.after(() => other.close());
  // Copy the storage to another instance: its home fingerprint must still isolate it.
  await page.route(`${other.origin}/**`, route => route.continue());
  await page.goto(other.origin + path());
  await page.evaluate(value => localStorage.setItem("task-control-drafts-v1", value), stored);
  await page.reload(); assert.equal(await page.locator("#run-note").inputValue(), "");
  assert.equal(state.get(TASK).control, undefined);
});

test("a timed-out accepted POST and double click reconcile the same identity after reload", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path("/gallivant"));
  let posts = 0, release, received;
  const handled = new Promise(resolve => { received = resolve; });
  await page.route("**/api/run/control?*", async route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch(); // The real protected handler saves it.
    received();
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  t.after(() => release?.());
  await page.locator("#run-note").fill("Keep this correction exactly once.");
  await page.locator('[data-action="message"]').evaluate(button => { button.click(); button.click(); });
  await handled;
  const id = state.get(TASK).control.id;
  await page.clock.runFor(15_001); await status(page, "uncertain");
  assert.equal(await page.locator("#run-note").inputValue(), "Keep this correction exactly once.");
  release();
  await page.reload(); await check(page, "queued");
  assert.equal(state.get(TASK).control.id, id); assert.equal(posts, 1);
  assert.equal(await page.locator("#run-note").inputValue(), "");
  assert.equal(await page.getByRole("button", { name: "Retry same request", exact: true }).isVisible(), false);
});

test("unaccepted requests retry only after a saved read using their original immutable identity", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  let first = true, disconnected = true;
  const payloads = [];
  await page.route("**/api/run/control?*", route => {
    if (route.request().method() === "POST") {
      payloads.push(route.request().postDataJSON());
      if (first) { first = false; return route.abort(); }
    } else if (disconnected) return route.abort();
    return route.continue();
  });
  await page.locator("#run-note").fill("Original correction.");
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await status(page, "uncertain");
  await page.locator("#run-note").fill("A newer unsent draft.");
  await check(page, "uncertain");
  assert.equal(await page.getByRole("button", { name: "Retry same request", exact: true }).isDisabled(), true);
  await page.reload(); // Restored browser metadata must not become POST fields.
  await check(page, "uncertain");
  disconnected = false;
  await check(page, "uncertain");
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("control-status").textContent.includes("Waiting for the coordinator"));
  assert.equal(payloads.length, 2); assert.deepEqual(payloads[0], payloads[1]);
  assert.equal(state.get(TASK).control.id, payloads[0].requestId);
  assert.equal(state.get(TASK).control.note, "Original correction.");
  assert.equal(await page.locator("#run-note").inputValue(), "A newer unsent draft.");
});

test("an evicted or replaced uncertain request cannot silently become fresh work", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  let posts = 0;
  await page.route("**/api/run/control?*", route => {
    if (route.request().method() === "POST") { posts++; return route.abort(); }
    return route.continue();
  });
  await page.locator("#run-note").fill("An old uncertain correction.");
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await status(page, "uncertain");
  state.update(TASK, { control: { id: "different-request", action: "recheck", status: "applied", at: NOW, finished_at: NOW } });
  await check(page, "uncertain");
  assert.equal(await page.getByRole("button", { name: "Retry same request", exact: true }).isDisabled(), true);
  assert.match(await page.locator("#control-status").textContent(), /replay is unavailable/);
  assert.equal(posts, 1);
});

test("polling preserves keyboard focus and an old read cannot overwrite a newer submission", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  let release, received, hold = true;
  const read = new Promise(resolve => { received = resolve; });
  await page.route("**/api/run/control?*", async route => {
    if (route.request().method() !== "GET" || !hold) return route.continue();
    hold = false;
    const response = await route.fetch();
    received(); await new Promise(resolve => { release = resolve; });
    await route.fulfill({ response }).catch(() => {});
  });
  t.after(() => release?.());
  await page.locator("#run-note").fill("Send while observing the prior state.");
  await page.locator('[data-action="message"]').focus();
  await page.clock.runFor(10_001); await read;
  assert.equal(await page.locator('[data-action="message"]').evaluate(el => el === document.activeElement), true);
  const accepted = page.waitForResponse(r => r.request().method() === "POST");
  await page.keyboard.press("Enter"); assert.equal((await accepted).status(), 202);
  release();
  await page.waitForFunction(() => !document.getElementById("control-check").disabled && document.getElementById("control-check").getAttribute("aria-busy") !== "true");
  await status(page, "queued");
  assert.equal(state.get(TASK).control.note, "Send while observing the prior state.");
  assert.equal(await page.locator('[data-action="message"]').isDisabled(), true);
  assert.equal(await page.locator("#run-note").inputValue(), "");
});

test("rejected submissions retain caret and drafts; credential detection never blocks an unrelated fixed action", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  await page.locator("#run-note").fill("Keep this rejected draft.");
  await page.locator("#run-note").evaluate(el => el.setSelectionRange(2, 9, "backward"));
  state.update(TASK, { control: { id: "other-tab", action: "recheck", status: "queued" } });
  await page.getByRole("button", { name: "Send message", exact: true }).click(); await status(page, "failed");
  assert.deepEqual(await page.locator("#run-note").evaluate(el => [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection]), ["Keep this rejected draft.", 2, 9, "backward"]);
  state.update(TASK, { control: null }); await check(page, "idle");
  await page.locator("#run-note").fill("Bearer fixture-private-credential");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  assert.equal(state.get(TASK).control, null);
  assert.match(await page.locator("#draft-status").textContent(), /credential pattern/);
  const accepted = page.waitForResponse(r => r.request().method() === "POST");
  await page.getByRole("button", { name: "Recheck PR", exact: true }).click(); assert.equal((await accepted).status(), 202);
  assert.equal(state.get(TASK).control.note, "");
  assert.equal(await page.locator("#run-note").inputValue(), "Bearer fixture-private-credential");
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("fixture-private-credential")), false);
});

test("cancel confirms the logical task and retains unconfirmed remote cancellation until acknowledgement", { timeout: 30_000 }, async t => {
  const world = await open(t), { page, origin, state, ctx } = world;
  seedWorkspace(world);
  await page.goto(origin + path().replace(RUN, OLD_RUN));
  await page.locator(".cancel-controls summary").click();
  let prompt;
  page.once("dialog", async dialog => { prompt = dialog.message(); await dialog.dismiss(); });
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  assert.match(prompt, new RegExp(TASK)); assert.match(prompt, /not the selected historical attempt/);
  assert.equal(state.get(TASK).control, undefined);
  page.once("dialog", dialog => dialog.accept());
  const cancelled = page.waitForResponse(r => r.request().method() === "POST");
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  assert.equal((await cancelled).status(), 202);
  assert.equal(state.get(TASK).control.action, "cancel");
  assert.equal(state.get("acme/atlas/keyboard-navigation").control, undefined);
  ctx.executionFor = () => ({ current: () => ({ id: RUN }), cancel: async () => ({ confirmed: false }) });
  await cancelControl(ctx, TASK); await check(page, "applied");
  assert.match(await page.locator("#control-status").textContent(), /Cancellation unconfirmed: remote execution may continue/);
  assert.equal(await page.locator('[data-action="resume"]').isDisabled(), true);
  state.update(TASK, { reason: "cancelled", control: { ...state.get(TASK).control, message: "Cancellation confirmed." } });
  await check(page, "applied");
  assert.match(await page.locator("#control-status").textContent(), /Cancellation confirmed/);
  assert.doesNotMatch(await page.locator("#control-status").textContent(), /Cancellation unconfirmed/);
});

test("protected identity lookup, replay, allowlists and malicious text use real mounted handlers", { timeout: 30_000 }, async t => {
  const { page, context, origin, state } = await open(t);
  for (const base of ["", "/gallivant"]) {
    state.update(TASK, { control: null, control_history: [] });
    await page.goto(origin + path(base));
    const endpoint = `${origin}${base}/api/run/control?id=${encodeURIComponent(TASK)}`;
    const token = await page.locator("#run-controls").getAttribute("data-token");
    const headers = { Origin: origin, "X-Gallivant-Token": token };
    for (const data of [{ action: "shell" }, { action: "resume", resnapshot: true }, { action: "message", note: "x", requestId: "x".repeat(129) }, { action: "recheck", requestId: {} }]) {
      const response = await context.request.post(endpoint, { headers, data });
      assert.ok([400, 409].includes(response.status())); assert.equal(state.get(TASK).control, null);
    }
    assert.equal((await context.request.post(endpoint, { headers: { ...headers, "Content-Type": "text/plain" }, data: '{"action":"recheck"}' })).status(), 415);
    const input = { action: "message", note: MALICIOUS, requestId: "fixture-idempotent" };
    const accepted = await context.request.post(endpoint, { headers, data: input }); assert.equal(accepted.status(), 202);
    const original = await accepted.json();
    assert.deepEqual(await (await context.request.post(endpoint, { headers, data: input })).json(), original);
    assert.equal((await context.request.post(endpoint, { headers, data: { ...input, note: "changed" } })).status(), 409);
    state.update(TASK, { control_history: [{ ...state.get(TASK).control, status: "applied" }], control: { id: "newer", action: "recheck", status: "applied" } });
    const read = await context.request.get(`${endpoint}&requestId=fixture-idempotent`);
    assert.equal((await read.json()).request.id, original.id);
    assert.equal((await context.request.get(`${endpoint}&requestId=bad!`)).status(), 400);
    await page.reload(); await page.locator("#last-message summary").click();
    assert.equal(await page.locator("#last-message pre").textContent(), MALICIOUS);
    assert.equal(await page.locator("#last-message img").count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
  }
});

test("capability gates, current-run interruption, mobile layouts and keyboard controls stay accessible", { timeout: 60_000 }, async t => {
  const world = await open(t, { live: true }), { page, origin, state, ctx } = world;
  const runnerFor = ctx.runnerFor;
  ctx.runnerFor = id => { const runner = runnerFor(id); return { ...runner, current: () => ({ ...runner.current(), running: id === TASK }) }; };
  state.update(TASK, { last: { run: RUN, exit: null }, reason: "rounds-exhausted" });
  for (const base of ["", "/gallivant"]) for (const theme of ["light", "dark"]) {
    await page.goto(origin + path(base).replace("theme=dark", `theme=${theme}`));
    assert.equal(await page.locator("#interrupt-run").isChecked(), false);
    assert.match(await page.locator("#control-gate").textContent(), /rounds-exhausted/);
    assert.match(await page.locator("#recheck-help").textContent(), /Does not resume an agent or rerun CI/);
    for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1280, 900], [1440, 1000], [844, 390]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      for (const item of await page.locator("#run-controls button:visible, #run-controls summary:visible, #run-note").all()) {
        const rect = await item.boundingBox(); assert.ok(rect.height >= 44 && rect.x >= 0 && rect.x + rect.width <= width + 1);
      }
    }
    const result = await new AxeBuilder({ page }).include("#run-controls").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(result.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
  }
  await page.locator("#run-note").fill("Interrupt deliberately.");
  await page.locator("#interrupt-run").focus(); await page.keyboard.press("Space");
  const accepted = page.waitForResponse(r => r.request().method() === "POST");
  await page.getByRole("button", { name: "Send message", exact: true }).click(); assert.equal((await accepted).status(), 202);
  assert.equal(state.get(TASK).control.interrupt, true);
  state.update(TASK, { state: "done" }); await check(page, "queued");
  assert.equal(await page.locator('[data-action="message"]').isDisabled(), true);
  assert.match(await page.locator("#control-gate").textContent(), /follow-up PRD/);
  state.update(TASK, { state: "needs-human", control: null, last: { run: RUN, exit: 0 } });
  ctx.executionFor = id => ({ ...ctx.runnerFor(id), capabilities: { available: false, reason: "Fixture model access unavailable", controls: { interrupt: false, cancel: false } } });
  await page.goto(origin + path());
  assert.match(await page.locator("#control-gate").textContent(), /Fixture model access unavailable/);
  for (const action of ["resume", "message"]) assert.equal(await page.locator(`[data-action="${action}"]`).isDisabled(), true);
  assert.match(await page.locator("#cancel-help").textContent(), /provider cannot confirm cancellation/);
});

test("two tabs preserve an uncertain identity through stale saves and reconcile before another submission", { timeout: 30_000 }, async t => {
  const world = await open(t), { page, context, origin, state } = world;
  const stale = await context.newPage();
  await stale.clock.install({ time: new Date(NOW) });
  // A suspended tab may miss notifications. The submission lock must still read
  // current storage instead of trusting either the event or its initial snapshot.
  await stale.addInitScript(() => addEventListener("storage", event => event.stopImmediatePropagation(), true));
  await page.goto(origin + path()); await stale.goto(origin + path());
  let posts = 0;
  await context.route("**/api/run/control?*", async route => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    await route.fetch(); // Persist through the real protected handler; lose its receipt.
    await route.abort();
  });
  await page.locator("#run-note").fill("Only this immutable correction is submitted.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await status(page, "uncertain");
  const id = state.get(TASK).control.id;
  await stale.locator("#run-note").fill("Keep this competing draft.");
  await stale.getByRole("button", { name: "Send message", exact: true }).click();
  await status(stale, "uncertain");
  assert.match(await stale.locator("#control-status").textContent(), /Another tab/);
  assert.equal(posts, 1);
  await stale.goto(origin + "/"); // Its pagehide checkpoint cannot erase the identity.
  await page.reload(); await check(page, "queued");
  assert.equal(state.get(TASK).control.id, id);
  assert.equal(posts, 1);
  settle(world, "applied"); await check(page, "applied");
  await stale.goto(origin + path());
  assert.equal(await stale.locator("#run-note").inputValue(), "Keep this competing draft.");
  assert.deepEqual(await stale.evaluate(() => JSON.parse(localStorage.getItem("task-control-requests-v1"))), []);
  // The normal storage notification synchronizes an already open competing tab.
  await stale.close();
  const observing = await context.newPage(); await observing.goto(origin + path());
  await page.locator("#run-note").fill("Next explicit correction.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await status(observing, "uncertain");
  assert.equal(await observing.locator('[data-action="message"]').isDisabled(), true);
  assert.equal(posts, 2);
});

test("closed tasks reconcile full saved-request storage without dispatch, including missing history and failed reads", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  await page.goto(origin + path());
  const closed = "acme/atlas/settings-layout", expired = "acme/atlas/repository-picker";
  state.update(closed, { control: { id: "saved-0", action: "message", status: "applied", note: "Saved correction", at: NOW, finished_at: NOW } });
  await page.evaluate(({ closed, expired }) => {
    const instance = document.getElementById("run-controls").dataset.instance;
    // Legacy entries reproduce the original exhaustion and exercise migration.
    localStorage.setItem("task-control-drafts-v1", JSON.stringify(Array.from({ length: 20 }, (_, i) => ({
      key: JSON.stringify([instance, i === 0 ? closed : i === 1 ? expired : `fixture/pending/${i}`]), updated: Date.now(), value: "Saved correction",
      operation: { requestId: `saved-${i}`, action: "message", note: "Saved correction", interrupt: false, previousId: "" },
    }))));
  }, { closed, expired });
  let posts = 0, disconnected = true;
  await page.route("**/api/run/control?*", route => {
    if (route.request().method() === "POST") { posts++; return route.continue(); }
    return disconnected ? route.abort() : route.continue();
  });
  // Full storage refuses even fixed actions with a concrete reconciliation remedy.
  await page.locator(".cancel-controls summary").click();
  page.on("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("draft-status").textContent.includes("including closed tasks"));
  assert.equal(posts, 0);
  await page.goto(origin + path("", closed));
  assert.equal(await page.locator("#run-note, button[data-action]").count(), 0);
  await check(page, "uncertain");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("task-control-drafts-v1")).filter(row => row.operation).length), 20, "failed reads retain identities");
  disconnected = false;
  state.update(closed, { control: { ...state.get(closed).control, status: "uncertain" } });
  await check(page, "uncertain");
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("task-control-drafts-v1")).filter(row => row.operation).length), 20, "unknown states cannot settle identities");
  state.update(closed, { control: { ...state.get(closed).control, status: "applying" } });
  await check(page, "applying");
  assert.equal(await page.locator("#control-retry").isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("task-control-requests-v1")).length), 20, "unfinished server requests retain their slots");
  state.update(closed, { control: { ...state.get(closed).control, status: "applied" } });
  await check(page, "applied");
  assert.match(await page.locator("#control-status").textContent(), /does not confirm model acknowledgement/);
  assert.match(await page.locator("#control-times").textContent(), /Finished:/);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("task-control-requests-v1")).length), 19);
  const axe = await new AxeBuilder({ page }).include("#run-controls").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  assert.deepEqual(axe.violations, []);
  await page.goto(origin + path("/gallivant", expired));
  await check(page, "uncertain");
  assert.match(await page.locator("#control-status").textContent(), /outcome is unknown.*identity has been retired/);
  assert.equal(await page.locator("#control-retry").isVisible(), false);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("task-control-requests-v1")).length), 18);
  assert.equal(posts, 0, "completed-task reconciliation only reads the existing handler");
  await page.goto(origin + path()); await page.locator(".cancel-controls summary").click();
  await page.getByRole("button", { name: "Cancel task", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("control-check").disabled);
  assert.equal(posts, 1, "a reclaimed slot allows an authorized fixed action again");
  assert.equal(state.get(TASK).control.action, "cancel");
});
