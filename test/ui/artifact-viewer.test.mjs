import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { contentDigest } from "../../lib/hash.mjs";
import { sourceManifestDigest } from "../../lib/start_contract.mjs";
import { prdSnapshotPath, sourceSnapshotPath } from "../../lib/task_snapshots.mjs";
import { taskStore } from "../../lib/task_store.mjs";
import { ACTOR, encode, manifest, planFixture, task } from "./dependency-plans-fixture.mjs";
import { fixture, TASK } from "./fixture.mjs";
import { intakeFixture, INTAKE_REQUEST } from "./intake-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch({ timeout: 15_000 }); }, { timeout: 20_000 });
after(async () => { await browser?.close(); });

const MOUNTS = ["", "/gallivant"];
const NOTES = "docs/review.json";
const JSON_NOTES = '{"items":["approved café"]}\r\n';
const EXACT = [
  "# Approved search index", "", "[Jump down](#last-section)", "", "- Check indexing", "  - Compare with baseline", "",
  "| Check | Outcome |", "| :--- | --- |", "| Exact | Pending |", "",
  "```sh", "A".repeat(800), "```", "", "[Inert](javascript:alert(1)) ![Remote](https://example.test/pixel.png) <img src=x>", "",
  ...Array.from({ length: 80 }, (_, index) => `Evidence paragraph ${index}.\n`), "## Last section", "",
].join("\r\n");

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function seed(world) {
  put(prdSnapshotPath(world.home, TASK), EXACT);
  put(sourceSnapshotPath(world.home, TASK, NOTES), JSON_NOTES);
  world.state.update(TASK, { snapshot_digest: contentDigest(EXACT), sources: [NOTES],
    sources_digest: sourceManifestDigest([[NOTES, JSON_NOTES]]) });
}
async function open(t, world, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 },
    reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"], ...options });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => {
    await context.close();
    assert.deepEqual(external, [], "preview did not request remote media");
    assert.deepEqual(errors, [], "served browser code");
  });
  return page;
}
const viewer = page => page.locator("#artifact-viewer");
const original = page => viewer(page).getByRole("region", { name: "Original source" });
const close = page => viewer(page).getByRole("button", { name: "Close", exact: true });
const target = (world, base, path, params = {}) => `${world.origin}${base}${path}?${new URLSearchParams(params)}`;

test("Task viewer preserves exact Markdown source, file and history across both mounts", { timeout: 35_000 }, async t => {
  const world = await fixture();
  t.after(() => world.close());
  seed(world);
  const page = await open(t, world);
  for (const base of MOUNTS) {
    const url = target(world, base, "/run", { id: TASK, theme: "dark", q: "index" });
    await page.goto(url);
    const trigger = page.getByRole("link", { name: "View PRD", exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await viewer(page).getByRole("heading", { name: "Approved search index" }).waitFor();
    assert.equal(await close(page).evaluate(node => node === document.activeElement), true);
    assert.equal(await viewer(page).locator("img, script, a[href^=javascript]").count(), 0);
    const navigation = viewer(page).getByLabel("Jump to heading");
    await navigation.selectOption({ label: "Last section" });
    assert.equal(await page.locator(":focus").textContent(), "Last section");
    assert.equal(await page.locator(":focus").evaluate(el => getComputedStyle(el).outlineStyle), "solid");
    await viewer(page).getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await original(page).textContent(), EXACT);
    await viewer(page).getByRole("button", { name: "Copy source" }).click();
    await viewer(page).getByText("Source copied.").waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /# Approved search index/);
    await viewer(page).getByLabel("File", { exact: true }).selectOption({ label: `Source · ${NOTES}` });
    assert.equal(await original(page).textContent(), JSON_NOTES);
    await viewer(page).getByRole("button", { name: "Copy link" }).click();
    await viewer(page).getByText("Link copied.").waitFor();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const selected = new URL(link);
    assert.equal(selected.pathname, base + "/run");
    assert.equal(selected.searchParams.get("id"), TASK);
    assert.equal(selected.searchParams.get("fileView"), "source");
    assert.equal(selected.searchParams.get("artifactAt"), contentDigest(JSON_NOTES));
    assert.ok(!selected.searchParams.has("q"));
    await page.goBack();
    assert.equal(await original(page).textContent(), EXACT);
    await page.goBack();
    await viewer(page).getByRole("heading", { name: "Approved search index" }).waitFor();
    await page.goForward();
    assert.equal(await original(page).textContent(), EXACT);
    await page.goForward();
    assert.equal(await original(page).textContent(), JSON_NOTES);
    await page.reload();
    assert.equal(await original(page).textContent(), JSON_NOTES);
    await page.keyboard.press("Escape");
    await viewer(page).waitFor({ state: "hidden" });
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    await page.goto(link);
    assert.equal(await original(page).textContent(), JSON_NOTES);
  }
});

test("intake, approved Plans and plan review all open saved inputs through the same viewer", { timeout: 45_000 }, async t => {
  const intake = await intakeFixture({ question: false });
  t.after(() => intake.close());
  const intakePage = await open(t, intake);
  await intakePage.goto(target(intake, "", "/task/new", { theme: "light" }));
  await intakePage.locator("#intake-repository").selectOption("acme/widget");
  await intakePage.locator("#intake-harness").selectOption("codex");
  await intakePage.locator("#intake-text").fill(INTAKE_REQUEST);
  await intakePage.getByRole("button", { name: "Prepare requirements", exact: true }).click();
  await intakePage.getByRole("link", { name: "View prepared brief" }).click();
  await viewer(intakePage).locator(".artifact-origin").filter({ hasText: "Saved intake draft" }).waitFor();
  await viewer(intakePage).getByRole("button", { name: "Source", exact: true }).click();
  const saved = taskStore(intake.home).read(new URL(intakePage.url()).searchParams.get("task"));
  assert.equal(await original(intakePage).textContent(), readFileSync(saved.draft.path, "utf8"));
  await intakePage.reload();
  await original(intakePage).waitFor();

  const world = await planFixture(t), page = await open(t, world, { extraHTTPHeaders: { authorization: ACTOR } });
  const plan = await world.queue("viewer-plan", [task("queued-leaf"), task("other-leaf")]);
  world.brief("review-leaf");
  for (const base of MOUNTS) {
    await page.goto(target(world, base, "/plans", { plan: plan.instanceId, node: "queued-leaf", theme: "light" }));
    await page.getByRole("link", { name: "View plan PRD" }).click();
    await viewer(page).getByRole("heading", { name: "queued-leaf.md" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("link", { name: "View manifest" }).click();
    await viewer(page).getByRole("heading", { name: "viewer-plan.json" }).waitFor();
    await viewer(page).getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(JSON.parse(await original(page).textContent()).name, "viewer-plan");
    await page.goBack();
    await viewer(page).getByRole("region", { name: "Text preview" }).waitFor();
    await page.goForward();
    await original(page).waitFor();
    await page.reload();
    assert.equal(JSON.parse(await original(page).textContent()).name, "viewer-plan");
    assert.equal(new URL(page.url()).searchParams.get("node"), "queued-leaf");
  }
  await close(page).click();
  await viewer(page).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  const editor = page.getByRole("region", { name: "New plan" });
  await editor.getByLabel("Authoring method").selectOption("import");
  const input = encode(manifest("viewer-review", [task("review-leaf")]), "yaml");
  await editor.getByLabel("Manifest format").selectOption(input.format);
  await editor.getByLabel("Manifest text").fill(input.text);
  await editor.getByRole("button", { name: "Preview plan" }).click();
  const review = page.getByRole("dialog", { name: /Review plan/ });
  await review.getByRole("link", { name: "View reviewed files" }).click();
  await viewer(page).locator(".artifact-origin").filter({ hasText: "Reviewed plan preview" }).waitFor();
  assert.equal(await viewer(page).getByRole("region", { name: "Text preview" }).textContent(), input.text);
  await close(page).click();
  const create = review.getByRole("button", { name: "Create approval request", exact: true });
  await create.waitFor();
  assert.equal(await create.isEnabled(), true);
});

test("long files keep the toolbar reachable through touch, narrow reflow, zoom and both themes", { timeout: 50_000 }, async t => {
  const world = await fixture();
  t.after(() => world.close());
  seed(world);
  const page = await open(t, world, { hasTouch: true });
  for (const [theme, base] of [["light", ""], ["dark", "/gallivant"]]) {
    for (const width of [360, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(target(world, base, "/run", { id: TASK, theme }));
      await page.getByRole("link", { name: "View PRD" }).tap();
      await viewer(page).getByRole("heading", { name: "Approved search index" }).waitFor();
      if (width === 360) {
        const table = viewer(page).getByRole("region", { name: "Document table" });
        assert.ok(await table.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "a compact two-column table fits without scrolling");
        const { violations } = await new AxeBuilder({ page }).include("#artifact-viewer")
          .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
        assert.deepEqual(violations.map(v => v.id), []);
        if (process.env.ARTIFACT_CAPTURES) await page.screenshot({ path: join(process.env.ARTIFACT_CAPTURES, `viewer-${theme}-mobile.png`) });
        await page.addStyleTag({ url: `${world.origin}/zoom.css` });
        if (process.env.ARTIFACT_CAPTURES) await page.screenshot({ path: join(process.env.ARTIFACT_CAPTURES, `viewer-${theme}-zoom.png`) });
      }
      await viewer(page).getByLabel("Jump to heading").selectOption({ label: "Last section" });
      const sizes = await page.evaluate(() => {
        const dialog = document.getElementById("artifact-viewer"), close = document.getElementById("artifact-close");
        const rect = dialog.getBoundingClientRect(), action = close.getBoundingClientRect();
        const scroll = document.getElementById("artifact-scroll"), root = document.documentElement;
        return { fits: rect.left >= 0 && rect.right <= innerWidth + 1 && root.scrollWidth <= root.clientWidth + 1 &&
          scroll.scrollWidth <= scroll.clientWidth + 1, close: action.top >= 0 && action.bottom < innerHeight, scroll: scroll.scrollTop, dialog: rect.toJSON(), action: action.toJSON(), window: [innerWidth, innerHeight] };
      });
      assert.ok(sizes.fits, `${theme} at ${width}px: ${JSON.stringify(sizes)}`);
      assert.ok(sizes.close, `${theme} at ${width}px: ${JSON.stringify(sizes)}`);
      assert.ok(sizes.scroll > 0);
      await close(page).tap();
      await viewer(page).waitFor({ state: "hidden" });
    }
  }
});

test("recoverable reads and empty files retain the viewer layout and task actions", { timeout: 20_000 }, async t => {
  const world = await fixture();
  t.after(() => world.close());
  seed(world);
  const page = await open(t, world);
  await page.goto(target(world, "", "/run", { id: TASK }));
  await page.route("**/api/artifact?**", route => route.fulfill({ status: 503, body: "Unavailable" }), { times: 1 });
  await page.getByRole("link", { name: "View PRD" }).click();
  await viewer(page).getByText("The file could not be loaded.", { exact: false }).waitFor();
  const size = await viewer(page).boundingBox();
  await viewer(page).getByRole("button", { name: "Retry file" }).click();
  await viewer(page).getByRole("heading", { name: "Approved search index" }).waitFor();
  assert.deepEqual(await viewer(page).boundingBox(), size);
  await close(page).click();
  await page.getByRole("button", { name: "Resume agent" }).waitFor();
  put(prdSnapshotPath(world.home, TASK), "");
  world.state.update(TASK, { snapshot_digest: contentDigest("") });
  await page.reload();
  await page.getByRole("link", { name: "View PRD" }).click();
  await viewer(page).getByText("This file is empty.", { exact: true }).waitFor();
  assert.equal(await viewer(page).getByRole("button", { name: "Copy source" }).isDisabled(), true);
  assert.deepEqual(await viewer(page).boundingBox(), size);
});

test("permission loss clears protected content and a superseded response cannot reopen it", { timeout: 25_000 }, async t => {
  const world = await planFixture(t), page = await open(t, world, { extraHTTPHeaders: { authorization: ACTOR } });
  const plan = await world.queue("permission-plan", [task("private-content")]);
  await page.clock.install();
  await page.goto(target(world, "/gallivant", "/plans", { plan: plan.instanceId, node: "private-content" }));
  const main = page.getByRole("link", { name: "View manifest" });
  const leaf = page.getByRole("link", { name: "View plan PRD" });
  let send, received;
  const receivedRequest = new Promise(resolve => { received = resolve; });
  const release = new Promise(resolve => { send = resolve; });
  await page.route("**/api/artifact?**", async route => {
    if (new URL(route.request().url()).searchParams.has("artifactAt")) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    if (data.file?.role !== "Manifest") return route.fulfill({ response, json: data });
    received();
    await release;
    await route.fulfill({ response, json: data }).catch(() => {});
  });
  try {
    await main.click();
    await receivedRequest;
    await viewer(page).getByText("Loading saved file…").waitFor();
    await close(page).click();
    await leaf.click();
    await viewer(page).getByRole("heading", { name: "private-content.md" }).waitFor();
    send();
    world.allowBrowser(false);
    await page.clock.runFor(10_100);
    await viewer(page).getByText("This file is unavailable within this workspace.", { exact: false }).waitFor();
    assert.equal(await viewer(page).locator("#artifact-body").textContent(), "");
    assert.equal(await viewer(page).getByRole("button", { name: "Copy source" }).isDisabled(), true);
    assert.doesNotMatch(await viewer(page).textContent(), /private-content\.md|permission-plan\.json/);
  } finally { send(); }
});
