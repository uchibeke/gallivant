import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { planControl, previewPlan } from "../../lib/dependency_plan_admission.mjs";
import { newPlanReviewId } from "../../lib/dependency_plan_registry.mjs";
import { ACTOR, encode, group, manifest, planFixture, task } from "./dependency-plans-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch({ timeout: 15000 }); }, { timeout: 20000 });
after(async () => { await browser?.close(); });

async function save(world, name, nested = false) {
  world.brief(name);
  const nodes = nested ? [group("delivery", [task(name)], undefined, "sequence")] : [task(name)];
  const { text } = encode(manifest(name, nodes), "yaml");
  const file = name + ".yaml";
  world.input(file, text, false);
  const input = { file, options: { directory: world.inputs } };
  const { approvalDigest: approve } = await previewPlan(world.ctx, input);
  const command = { action: "queue", stage: "save", requestId: newPlanReviewId(), approve, input };
  const review = await planControl(world.ctx, command);
  assert.equal(review.status, "pending");
  return { ...review, text };
}

for (const base of ["", "/gallivant"]) {
  test(`copied ${base ? "mounted" : "standalone"} approval supports file viewing, keyboard confirmation, reload and Back`, { timeout: 30000 }, async t => {
    const world = await planFixture(t), saved = await save(world, "review-release", true);
    const context = await browser.newContext({ extraHTTPHeaders: { authorization: ACTOR },
      viewport: base ? { width: 390, height: 844 } : { width: 1280, height: 900 }, reducedMotion: "reduce" });
    t.after(() => context.close());
    const page = await context.newPage(), errors = [], posts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") posts.push(request.postDataJSON()); });
    page.setDefaultTimeout(6000);
    const url = world.origin + base + saved.approvalLink, before = readFileSync(world.state.file), hostReads = world.calls.length;
    await page.goto(url);
    await page.waitForFunction(() => document.activeElement?.id === "approval-heading");
    const approve = page.getByRole("button", { name: "Approve plan", exact: true });
    await approve.waitFor();
    assert.equal(await approve.count(), 1);
    assert.match(await page.locator("#approval-proposal").textContent(), new RegExp(saved.revision));
    assert.match(await page.locator("#approval-proposal").textContent(), /acme\/widget @ main.*qualified receipt/s);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    assert.deepEqual(results.violations.map(item => item.id), []);
    if (base) assert.ok((await page.screenshot({ animations: "disabled", timeout: 5000 })).length > 0);
    await page.getByRole("link", { name: "View reviewed files" }).focus();
    await page.keyboard.press("Enter");
    const viewer = page.getByRole("dialog", { name: "review-release.yaml" });
    await viewer.waitFor();
    await viewer.getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await viewer.locator("pre").textContent(), saved.text);
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    assert.deepEqual(readFileSync(world.state.file), before, "sharing and file navigation perform no write");
    assert.equal(world.calls.length, hostReads);
    assert.deepEqual(posts, []);

    const hold = Promise.withResolvers();
    let readFailed = false;
    if (base) {
      await page.route("**/api/plan/approval?*", route => {
        if (readFailed) return route.continue();
        readFailed = true;
        return route.fulfill({ status: 503, body: "Fixture read outage" });
      });
    }
    await page.route("**/api/plan/control", async route => {
      await hold.promise;
      if (!base) return route.continue();
      const response = await route.fetch({ timeout: 8000 });
      assert.equal(response.status(), 200, await response.text());
      await response.dispose();
      await route.abort("failed");
    });
    try {
      await approve.focus();
      await page.keyboard.press("Enter");
      await page.getByText("Submitting plan approval…", { exact: true }).waitFor();
      assert.equal(await approve.isDisabled(), true);
      assert.equal(await approve.getAttribute("aria-busy"), "true");
    } finally { hold.resolve(); }
    if (base) {
      await page.getByText("The saved request could not be checked", { exact: false }).waitFor();
      assert.equal(await approve.isDisabled(), true);
      assert.match(await page.locator("#approval-proposal").textContent(), new RegExp(saved.revision));
      await page.getByRole("button", { name: "Check saved request" }).click();
    }
    const accepted = page.getByRole("link", { name: "Open saved plan" });
    await accepted.waitFor();
    if (!base) assert.equal(await accepted.evaluate(node => node === document.activeElement), true);
    assert.match(await page.locator("#approval-status").textContent(), /admission receipt is saved/);
    const instance = world.state.graphPlans()[0].id;
    assert.equal(await accepted.getAttribute("href"), `${base}/plans?plan=${instance}`);
    assert.equal(await approve.count(), 0);
    await page.reload();
    await accepted.waitFor();
    await accepted.click();
    await page.waitForURL(value => value.searchParams.get("plan") === instance);
    await page.goBack();
    await accepted.waitFor();
    assert.deepEqual(posts, [{ action: "queue", stage: "approve", requestId: saved.requestId, approve: saved.revision }]);
    assert.equal(world.state.graphPlans().length, 1);
    assert.equal(world.spawned(), 0);
    assert.deepEqual(errors, []);
  });
}

test("a copied link distinguishes stale, denied and unavailable reviews without offering approval", { timeout: 20000 }, async t => {
  const world = await planFixture(t), stale = await save(world, "stale-work"), denied = await save(world, "denied-work");
  world.brief("stale-work", "\nSource changed after review.\n");
  const context = await browser.newContext({ extraHTTPHeaders: { authorization: ACTOR } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.goto(world.origin + stale.approvalLink);
  await page.getByText("This approval request is stale.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve plan" }).count(), 0);
  world.denied.add("queue");
  await page.goto(world.origin + denied.approvalLink);
  await page.getByText("Approval denied for this repository scope.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Approve plan" }).count(), 0);
  world.allowBrowser(false);
  await page.reload();
  await page.getByText("Approval request unavailable.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("link", { name: "View reviewed files" }).count(), 0);
  assert.equal(world.state.graphPlans().length, 0);
});
