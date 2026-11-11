import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { fixture, NOW, TASK, RUN } from "./fixture.mjs";
import { appendProjection } from "../../lib/run_log.mjs";
import { seedWorkspace, OLD_RUN } from "./workspace-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });
async function open(t, options = {}) {
  const world = await fixture(options);
  t.after(() => world.close());
  const paths = seedWorkspace(world);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.clock.install({ time: new Date(NOW) }); await page.clock.setFixedTime(new Date(NOW));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  return { ...world, ...paths, page, context };
}
const path = (base = "", run = RUN) => `${base}/run?id=${encodeURIComponent(TASK)}&run=${run}&theme=dark`;
const ready = page => page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("snapshot current"));

test("workspace separates canonical evidence, findings, execution metadata and source freshness", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  for (const base of ["", "/gallivant"]) {
    await page.goto(origin + path(base)); await ready(page);
    const summary = await page.locator("#workspace-summary").innerText();
    for (const text of [TASK, RUN, "main", "delivery_ready", "round 1/5", "search-release", "10m ago", "Checks need attention"]) assert.ok(summary.includes(text), text);
    assert.equal(await page.locator("#workspace-activity").getAttribute("open"), null);
    const cards = page.locator(".evidence-card"); assert.equal(await cards.count(), 6);
    assert.match(await cards.nth(0).innerText(), /pending/); assert.match(await cards.nth(1).innerText(), /findings/);
    assert.match(await cards.nth(2).innerText(), /waiting/); assert.match(await cards.nth(3).innerText(), /unknown/);
    assert.match(await page.locator("#workspace-review-content").innerText(), /rollback path/);
    await page.locator("#execution-details > summary").click();
    await page.waitForFunction(() => document.querySelector("#artifact-list").textContent.includes("src/search/index.mjs"));
    const metadata = await page.locator("#workspace-execution-content").innerText();
    assert.match(metadata, /recorded-fixture-model/); assert.match(metadata, /current-fixture-session/); assert.match(metadata, /unknown/);
    const summaryResponse = await page.request.get(`${origin}${base}/api/run/result?id=${encodeURIComponent(TASK)}&run=${RUN}&view=summary`);
    const resultSummary = await summaryResponse.json();
    assert.deepEqual(Object.keys(resultSummary), ["version", "taskId", "runId", "artifacts"]);
    const saved = await page.locator("#artifact-list").innerText();
    await page.route("**/api/run/result?**", route => route.fulfill({ status: 503, body: "unavailable" }));
    await page.locator("#artifact-retry").click();
    await page.waitForFunction(() => document.querySelector("#artifact-state").textContent.includes("Last good"));
    assert.equal(await page.locator("#artifact-list").innerText(), saved);
    await page.unroute("**/api/run/result?**");
  }
  state.update(TASK, { gate_skipped: "fixture-gate", cursor: { fixed_sha: "new-head" } });
  await page.locator("#workspace-retry").click();
  await page.waitForFunction(() => document.querySelector("#workspace-evidence-content").textContent.includes("stale-head"));
  assert.match(await page.locator("#workspace-evidence-content").innerText(), /stale-head/);
  assert.match(await page.locator("#workspace-evidence-content").innerText(), /gate was skipped/);
  assert.match(await page.locator("#workspace-review-content").innerText(), /Historical review/);
  for (const [zeroChecks, expected] of [[true, "not-configured"], [false, "not-observed"]]) {
    state.update(TASK, { reviewPolicy: { ...state.get(TASK).reviewPolicy, zeroChecks },
      reviewObservation: { head: "new-head", binding: "fixture-binding", checks: { count: 0, settled: true }, observedAt: NOW } });
    await page.locator("#workspace-retry").click();
    await page.waitForFunction(expected => document.querySelector(".evidence-card").textContent.includes(expected), expected);
  }
  state.update(TASK, { reviewHead: "new-head", firstPartyReview: { binding: "fixture-binding", status: "running", startedAt: NOW, pieces: [{ status: "completed" }, { status: "running" }] } });
  await page.locator("#workspace-retry").click();
  await page.waitForFunction(() => document.querySelector("#workspace-review-content").textContent.includes("reviewing job 2 of 2"));
  assert.match(await page.locator(".evidence-card").nth(1).innerText(), /running/);
  assert.match(await page.locator(".evidence-card").nth(3).innerText(), /skipped/);
});

test("historical attempt survives applied controls, refresh, reload and browser back", { timeout: 30_000 }, async t => {
  const { page, origin, state } = await open(t);
  for (const base of ["", "/gallivant"]) {
    state.update(TASK, { control: null });
    await page.goto(origin + path(base, OLD_RUN)); await ready(page);
    assert.match(await page.locator("#workspace-summary").innerText(), /5m 0s/);
    assert.match(await page.locator("#workspace-execution-content").textContent(), /historical-fixture-session/);
    assert.doesNotMatch(await page.locator("#workspace-execution-content").textContent(), /current-fixture-session/);
    await page.getByRole("button", { name: "Recheck PR", exact: true }).click();
    // The sending label is optimistic; wait for the saved receipt and its local
    // identity checkpoint before advancing the synthetic coordinator/clock.
    await page.waitForFunction(() => !document.getElementById("control-check").disabled && document.getElementById("control-status").dataset.status === "queued");
    assert.ok(state.get(TASK).control?.id);
    state.update(TASK, { control: { ...state.get(TASK).control, status: "applied", message: "Fixture applied" } });
    await page.clock.runFor(3100);
    await page.waitForFunction(() => document.querySelector("#control-status").dataset.state === "success").catch(async error => { throw new Error(`${error.message}: ${await page.locator("#control-status").textContent()}`); });
    assert.equal(new URL(page.url()).searchParams.get("run"), OLD_RUN);
    await page.locator("#workspace-retry").click(); await ready(page);
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#log").getAttribute("data-run"), OLD_RUN);
    await page.waitForFunction(() => document.querySelector("#log").textContent.includes("Historical attempt output only"));
    await page.getByRole("link", { name: "Open latest attempt", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("run"), RUN);
    await page.goBack(); assert.equal(new URL(page.url()).searchParams.get("run"), OLD_RUN);
  }
});

test("10000 mixed events keep bounded ordered history, deduplicate, search locally and pause for selection", { timeout: 45_000 }, async t => {
  const { page, origin, root } = await open(t);
  const dir = join(root, RUN), job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8"));
  writeFileSync(join(dir, "job.json"), JSON.stringify({ ...job, bin: null, exit: null, endedAt: null, execution: { provider: "fixture", providerState: "running", acceptance: "accepted", transport: "remote" } }));
  const lines = Array.from({ length: 10_000 }, (_, i) => i % 2 ? `raw fixture event ${i + 1}` : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: `author fixture event ${i + 1}` } }));
  writeFileSync(join(dir, "job.log"), lines.join("\n") + "\n");
  const index = Buffer.alloc(lines.length * 8); let offset = 0;
  for (let i = 0; i < lines.length; i++) { index.writeBigUInt64LE(BigInt(offset + 1), i * 8); offset += Buffer.byteLength(lines[i]) + 1; }
  writeFileSync(join(dir, "job.idx"), index);
  writeFileSync(join(dir, "log-meta.json"), JSON.stringify({ version: 2, firstSequence: 1, lastSequence: lines.length, size: offset }));
  const started = performance.now();
  await page.goto(origin + path()); await ready(page);
  await page.locator("#workspace-activity > summary").click();
  await page.waitForFunction(() => document.querySelector("#log").textContent.includes("event 10000"));
  assert.ok(await page.locator("#log > div").count() <= 402);
  t.diagnostic(`10000 events: initial tail ${(performance.now() - started).toFixed(1)}ms; ${process.platform}/${process.arch}, ${process.version}, Chromium ${browser.version()}`);
  assert.match(await page.locator("#earlierstate").innerText(), /9600 earlier/);
  for (let i = 0; i < 6; i++) { await page.locator("#earlier").click(); await page.waitForFunction(() => !document.querySelector("#earlier").disabled); }
  const ids = await page.locator("#log [data-replay]").evaluateAll(rows => rows.map(r => Number(r.dataset.replay)));
  assert.ok(ids.length <= 2400); assert.equal(new Set(ids).size, ids.length); assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  await page.locator("#activity-search").fill("event 10000");
  assert.match(await page.locator("#activity-search-state").innerText(), /1 matching rows.*loaded output only/);
  await page.locator("#activity-search").fill("");
  await page.locator("#log").evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); el.focus(); const range = document.createRange(); range.selectNodeContents(el.querySelector("[data-replay]")); const s = getSelection(); s.removeAllRanges(); s.addRange(range); });
  const before = await page.evaluate(() => ({ selected: getSelection().toString(), top: document.querySelector("#log").scrollTop, focus: document.activeElement.id }));
  appendProjection(dir, "new live fixture event");
  await page.waitForFunction(() => document.querySelector("#follow-output").textContent.includes("1 new events"));
  assert.deepEqual(await page.evaluate(() => ({ selected: getSelection().toString(), top: document.querySelector("#log").scrollTop, focus: document.activeElement.id })), before);
  await page.locator("#follow-output").click();
  await page.waitForFunction(() => document.querySelector("#log").textContent.includes("new live fixture event"));
  assert.ok(await page.locator("#log > div").count() <= 4001);
});

test("workspace hostile metadata stays bounded, redacted, inert and within both themes at all widths", { timeout: 60_000 }, async t => {
  const { page, origin, state, context, home } = await open(t);
  const token = "ghp_" + "fixture".repeat(6);
  state.update(TASK, { branch: `<script>${token}</script>`,
    firstPartyReview: { ...state.get(TASK).firstPartyReview, result: { verdict: "findings", findings: Array.from({ length: 500 }, () => ({ severity: "high", description: `<img src=x onerror=alert(1)> ${token} ${"long/".repeat(300)}` })) } } });
  const response = await context.request.get(origin + `/api/run/workspace?id=${encodeURIComponent(TASK)}&run=${RUN}`);
  assert.equal(response.status(), 200);
  const body = await response.text(); assert.ok(body.length < 25_000); assert.ok(!body.includes(token)); assert.ok(!body.includes("user:password"));
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const response = await page.goto(origin + path().replace("theme=dark", `theme=${theme}`)); assert.equal(response.status(), 200, await response.text()); await ready(page);
      assert.equal(await page.locator("main img, main script").count(), 0);
      assert.equal(await page.locator(".review-findings li").count(), 8);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(result.violations.map(v => v.id), []);
  }
  const statePath = join(home, "state.json"), savedState = readFileSync(statePath, "utf8");
  const savedSummary = await page.locator("#workspace-summary").textContent();
  // The existing repository parser rejects credential-bearing URLs before render.
  state.update(TASK, { url: "https://user:password@example.invalid/" });
  await page.locator("#workspace-retry").click();
  await page.waitForFunction(() => document.querySelector("#workspace-state").textContent.includes("disconnected"));
  assert.equal(await page.locator("#workspace-summary").textContent(), savedSummary);
  assert.ok(!(await page.locator("main").textContent()).includes("user:password"));
  writeFileSync(statePath, savedState);
  await page.locator("#workspace-activity > summary").focus(); await page.keyboard.press("Enter");
  assert.equal(await page.locator("#workspace-activity").getAttribute("open"), "");
  for (const route of ["output", "history", "result", "workspace"]) assert.equal((await context.request.get(`${origin}/api/run/${route}?id=${encodeURIComponent(TASK)}&run=..%2Foutside`)).status(), 404);
});


test("an initially empty workspace offers a newly recorded attempt without replacing its view", { timeout: 30_000 }, async t => {
  const { page, origin, state, ctx } = await open(t);
  const original = ctx.runnerFor; let empty = true;
  ctx.runnerFor = id => { const runner = original(id); return id === TASK ? { ...runner, current: () => empty ? null : runner.current() } : runner; };
  state.update(TASK, { last: null });
  await page.goto(`${origin}/run?id=${encodeURIComponent(TASK)}`); await ready(page);
  assert.equal(await page.locator("#log").count(), 0);
  empty = false; state.update(TASK, { last: { run: RUN, exit: 0 } });
  await page.locator("#workspace-retry").click();
  await page.locator("#workspace-new-attempt").waitFor({ state: "visible" });
  assert.equal(await page.locator("#log").count(), 0);
  await page.locator("#workspace-new-attempt").click(); await ready(page);
  assert.equal(await page.locator("#log").getAttribute("data-run"), RUN);
});
