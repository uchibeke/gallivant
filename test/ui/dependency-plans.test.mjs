import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";
import { ACTOR, REPO, SECRET, anchor, diamondPlans, encode, group, manifest, planFixture, task } from "./dependency-plans-fixture.mjs";
import { NOW } from "./fixture.mjs";
import { GOOD_PRD } from "../helpers.mjs";

const MOUNT = "/gallivant", TAGS = ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"];
let browser;
before(async () => { browser = await chromium.launch({ timeout: 20000 }); }, { timeout: 25000 });
after(async () => { await browser?.close(); });

async function open(t) {
  const world = await planFixture(t);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce",
    extraHTTPHeaders: { authorization: ACTOR } });
  t.after(() => context.close());
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (new URL(route.request().url()).origin === world.origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000); page.setDefaultNavigationTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  t.after(() => { assert.deepEqual(errors, [], "served browser code"); assert.deepEqual(external, [], "same-origin assets and requests"); });
  await page.clock.install({ time: new Date(NOW) }); await page.clock.setFixedTime(new Date(NOW));
  return { ...world, context, page };
}

const path = (world, base = "", params = {}) => `${world.origin}${base}/plans?${new URLSearchParams(params)}`;
const dependencies = page => page.locator("[data-plan-list]");
const detail = page => page.locator("#selected-plan-node");
const review = page => page.getByRole("dialog", { name: /Review plan/ });
const submit = page => review(page).getByRole("button", { name: "Confirm reviewed action" });
const status = page => page.locator("#plan-action-status");
const show = (page, text) => page.getByText(text, { exact: false }).first().waitFor();
const ready = page => page.waitForFunction(() => !document.getElementById("plan-submit").disabled);
const finished = page => page.waitForFunction(() => !document.getElementById("plan-close").disabled);
const close = async page => { await review(page).getByRole("button", { name: "Close", exact: true }).click(); await refreshed(page); };
const refreshed = page => page.waitForFunction(() => !document.getElementById("chains-refresh").disabled);
const editor = page => page.getByRole("region", { name: /New plan|Edit future inputs|Attach a producer/ });
const preview = page => editor(page).getByRole("button", { name: "Preview plan" });
const choose = async (page, locator, id) => {
  await locator.click();
  await page.waitForURL(url => url.searchParams.get("node") === id);
};
const discard = page => editor(page).getByRole("button", { name: "Close editor" }).click();

async function openImport(page) {
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await editor(page).getByLabel("Authoring method").selectOption("import");
}
async function paste(page, input) {
  await editor(page).getByLabel("Manifest format").selectOption(input.format);
  await editor(page).getByLabel("Manifest text").fill(input.text);
}
async function previewReply(page, expected = 200) {
  const response = page.waitForResponse(event => event.url().endsWith("/api/plan/control") && event.request().postDataJSON()?.stage === "review");
  await preview(page).click();
  const result = await response, body = await result.json();
  assert.equal(result.status(), expected, JSON.stringify(body));
  await finished(page);
  return body;
}
async function capture(page, name) {
  if (!process.env.PLAN_UI_CAPTURES) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(process.env.PLAN_UI_CAPTURES, name + ".png"), animations: "disabled", timeout: 8000 });
}

test("a nested diamond shows active branches, capacity, exact receipts and frozen shared producers", { timeout: 45000 }, async t => {
  const world = await open(t), { page, state, calls } = world;
  const { producer, consumer, second, merge } = await diamondPlans(world);
  assert.equal(world.spawned(), 3, JSON.stringify(world.diagnostics));
  const saved = readFileSync(state.file), reads = calls.length;
  for (const base of ["", MOUNT]) {
    await page.goto(path(world, base, { pq: producer.name, theme: "dark" }));
    const selected = new URL(page.url());
    assert.equal(selected.searchParams.get("plan"), producer.instanceId);
    assert.ok(selected.searchParams.get("node"));
    assert.match(await page.locator(".chain-progress").textContent(), /1 of 5 tasks integrated/);
    await show(page, "2 active tasks");
    assert.match(await dependencies(page).textContent(), /Waiting for capacity/);
    assert.match(await dependencies(page).textContent(), /Waiting on prerequisites/);
    assert.equal(await dependencies(page).locator('[data-type="group"]').count(), 2);
    await choose(page, dependencies(page).getByRole("link", { name: "implementation", exact: true }), "implementation");
    assert.match(await detail(page).textContent(), /3 entry · 3 exit/);
    await choose(page, dependencies(page).getByRole("link", { name: "interface", exact: true }), "implementation/experience/interface");
    assert.match(await detail(page).textContent(), new RegExp(merge));
    await detail(page).getByRole("link", { name: "Open task", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, base + "/run");
    assert.ok(await page.getByRole("button", { name: "Message agent", exact: false }).count() || await page.locator("#run-note").count());
    await page.getByRole("link", { name: "Back to plan", exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("node"), "implementation/experience/interface");
    assert.equal(new URL(page.url()).searchParams.get("pq"), producer.name);
    await page.goto(`${world.origin}${base}/run?id=${REPO}/release&theme=light`);
    assert.equal(new URL(page.url()).searchParams.get("node"), "release");
    assert.equal(await detail(page).getByRole("link", { name: "Open task" }).count(), 0);
    assert.equal(await detail(page).locator('[data-receipt-status]:not([data-receipt-status="integrated"])').count(), 3);

    for (const [plan, id, target] of [[consumer, "producer-terminal", "release"], [second, "producer-task", "implementation/api"]]) {
      await page.goto(path(world, base, { plan: plan.instanceId, node: id, theme: "dark" }));
      assert.match(await detail(page).textContent(), new RegExp(producer.instanceId));
      assert.match(await detail(page).textContent(), new RegExp(target));
      assert.equal(await detail(page).getByRole("link", { name: "Open producer plan" }).count(), 1);
      assert.equal(await detail(page).locator("[data-plan-action]").count(), 0);
    }
    await page.goto(path(world, base, { plan: producer.instanceId, node: "deleted-node" }));
    await show(page, "The linked node is unavailable");
    assert.equal(await detail(page).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get("node"), "deleted-node");
    await page.goto(path(world, base, { plan: "deleted-plan", node: "deleted-node" }));
    await show(page, "This plan is unavailable");
    assert.equal(new URL(page.url()).searchParams.get("plan"), "deleted-plan");
  }
  assert.deepEqual(readFileSync(state.file), saved, "viewing plans and navigating task detail change no state");
  assert.equal(calls.length, reads, "GET performs no host/Git reads");

  await page.goto(path(world, "", { plan: producer.instanceId, node: "release", diagram: "1", theme: "dark" }));
  await page.evaluate(() => { document.getElementById("chain-title").scrollIntoView(); scrollBy(0, -16); });
  await capture(page, "dependency-plans-desktop");
  await world.settle("api", "CLOSED");
  await world.tick();
  await page.getByRole("button", { name: "Refresh plans" }).click(); await refreshed(page);
  assert.match(await dependencies(page).textContent(), /Closed without integration/);
  assert.equal(await detail(page).locator('[data-receipt-status="closed-unmerged"]').count(), 1);
  assert.match(await page.locator(".chain-progress").textContent(), /1 of 5 tasks integrated/);
  assert.equal(state.get(`${REPO}/release`), null);
});

test("diagram and list paginate a large saved neighborhood with matching identities and keyboard navigation", { timeout: 30000 }, async t => {
  const world = await open(t), { page } = world;
  await world.queue("shared-source", [task("upstream")]);
  const anchors = Array.from({ length: 110 }, (_, i) => anchor(`source-${String(i).padStart(3, "0")}`, "shared-source"));
  const plan = await world.queue("wide-join", [...anchors, group("checks", [task("join", anchors.map(node => `/${node.id}`))])]);
  await page.goto(path(world, MOUNT, { plan: plan.instanceId, node: "checks/join", theme: "dark" }));
  const toggle = page.getByRole("link", { name: "Show diagram" });
  await toggle.focus();
  assert.equal(await toggle.evaluate(el => getComputedStyle(el).outlineStyle), "solid");
  await page.keyboard.press("Enter");
  await page.waitForURL(url => url.searchParams.has("diagram"));
  await page.getByText("Diagram as a list", { exact: true }).click();
  const ids = selector => page.locator(`${selector} [data-node-id]`).evaluateAll(rows => rows.map(row => row.dataset.nodeId));
  assert.deepEqual(await ids(".plan-diagram"), await ids(".diagram-list"));
  assert.equal((await ids(".plan-diagram")).length, 25);
  assert.equal(await dependencies(page).locator("li").count(), 12);
  assert.match(await page.getByRole("navigation", { name: "Dependency pages" }).textContent(), /100 omitted/);
  assert.match(await page.locator(".plan-neighborhood").textContent(), /86 neighbors omitted/);
  await page.getByRole("link", { name: "Later neighbors" }).focus(); await page.keyboard.press("Enter");
  await page.waitForURL(url => url.searchParams.get("dp") === "24");
  assert.deepEqual(await ids(".plan-diagram"), await ids(".diagram-list"));
  assert.equal(await page.locator(".plan-neighborhood details").getAttribute("open"), "");
  await page.locator(".diagram-list").getByRole("link", { name: "source-024" }).focus(); await page.keyboard.press("Enter");
  await page.waitForURL(url => url.searchParams.get("node") === "source-024");
  assert.equal(await detail(page).locator("h3").textContent(), "source-024");
  assert.match(await page.locator(".plan-diagram").textContent(), /Collapsed group/);
  await page.goBack();
  await page.waitForFunction(() => document.querySelector("[data-selected-node]")?.dataset.selectedNode === "checks/join");
  assert.equal(await page.locator(".plan-neighborhood details").getAttribute("open"), "");
});

test("guided tasks, groups and saved producer references compile like exact JSON and YAML imports", { timeout: 45000 }, async t => {
  const world = await open(t), { page, state } = world;
  const upstream = await world.queue("new-producer", [task("future")]);
  world.input("inputs/case.md", SECRET);
  world.input(task("assemble").prd, GOOD_PRD.replace("harness: codex", "harness: codex\nsources: [inputs/case.md]"));
  world.brief("inspect");
  const saved = readFileSync(state.file);
  await page.goto(path(world, MOUNT, { theme: "light" }));
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  await editor(page).getByLabel("Plan name").fill("guided-release");
  const primary = editor(page).locator('[data-draft-node="task"]').first();
  await primary.getByLabel("Task ID").fill("assemble");
  await primary.getByLabel("Approved repository and base").selectOption("repository-1");
  await primary.getByLabel("Ready brief").selectOption(task("assemble").prd);
  await primary.getByLabel("Needs").fill("producer");
  await editor(page).getByRole("button", { name: "Add group", exact: true }).click();
  const section = editor(page).locator('[data-draft-node="group"]');
  await section.getByLabel("Group ID").fill("checks");
  await section.getByLabel("Group mode").selectOption("sequence");
  await section.getByRole("button", { name: "Add nested task" }).click();
  const child = section.locator('[data-draft-node="task"]');
  await child.getByLabel("Task ID").fill("inspect");
  await child.getByLabel("Approved repository and base").selectOption("repository-1");
  await child.getByLabel("Ready brief").selectOption(task("inspect").prd);
  await child.getByLabel("Needs").fill("/assemble");
  await editor(page).getByRole("button", { name: "Add anchor", exact: true }).click();
  const producer = editor(page).locator('[data-draft-node="anchor"]');
  await producer.getByLabel("Anchor ID").fill("producer");
  await producer.getByRole("button", { name: "Find producer plans" }).click();
  await show(page, "1 matches");
  await producer.getByLabel("Producer plan name").fill(upstream.name);
  await producer.getByLabel("Frozen boundary").selectOption("node");
  await producer.getByRole("button", { name: "Find producer tasks" }).click();
  await producer.locator("datalist").last().locator("option").waitFor({ state: "attached" });
  await producer.getByLabel("Producer task ID").fill("future");
  const guided = await previewReply(page);
  assert.equal(guided.proposal.anchors[0].instanceId, upstream.instanceId);
  assert.equal(guided.proposal.anchors[0].nodes[0].id, "future");
  assert.match(await review(page).textContent(), /Requested parallelism/);
  assert.match(await review(page).textContent(), /provider cap not enforceable/);
  assert.match(await review(page).textContent(), /Resource limits/);
  assert.match(await review(page).textContent(), /frozen prerequisites await/);
  assert.doesNotMatch(JSON.stringify(guided), new RegExp(`${SECRET}|PRIVATE_ACCOUNT_FIXTURE|${world.inputs}`));
  await close(page);
  await editor(page).getByLabel("Authoring method").selectOption("import");
  const candidate = manifest("guided-release", [task("assemble", ["producer"]),
    group("checks", [task("inspect", ["/assemble"])], undefined, "sequence"), anchor("producer", upstream.name, "future")]);
  await paste(page, encode(candidate));
  assert.equal((await previewReply(page)).proposal.graphDigest, guided.proposal.graphDigest);
  await close(page);
  const yaml = encode(candidate, "yaml");
  const bytes = Buffer.from(yaml.text.replaceAll("\n", "\r\n"));
  await editor(page).getByLabel("Choose a manifest").setInputFiles({ name: "fixture-source.yml", mimeType: "text/yaml", buffer: bytes });
  await show(page, "Manifest loaded");
  const uploaded = await previewReply(page);
  assert.equal(uploaded.proposal.graphDigest, guided.proposal.graphDigest);
  assert.equal(uploaded.proposal.sources.find(file => file.path === "uploaded-plan.yaml").digest, createHash("sha256").update(bytes).digest("hex"));
  assert.doesNotMatch(JSON.stringify(uploaded), new RegExp(SECRET));
  assert.notEqual(uploaded.revision, guided.revision);
  assert.deepEqual(readFileSync(state.file), saved, "all three preview paths and reference lookups are read-only");
  assert.equal(world.spawned(), 0);
});

test("import rejects malformed and private references before unapproved reads and resolves only bound includes", { timeout: 35000 }, async t => {
  const world = await open(t), { page, state, calls } = world;
  await world.queue("private-producer", [task("private-terminal")], { privatePlan: true });
  world.brief("assemble");
  world.brief("unbound-brief", "\n" + SECRET, false);
  const fragment = { version: 1, children: [task("assemble")] };
  world.input("parts/allowed.yml", encode(fragment, "yaml").text);
  world.input("parts/unbound.yml", encode(fragment, "yaml").text, false);
  world.input("unbound-plan.json", encode(manifest("unbound", [task("assemble")])).text, false);
  const saved = readFileSync(state.file), initialReads = calls.length;
  await page.goto(path(world));
  await openImport(page);
  const included = file => manifest("imported", [{ id: "included", type: "group", mode: "parallel", file }]);
  const unauthorizedRepo = manifest("imported", [task("assemble")]);
  unauthorizedRepo.repositories["repository-1"].repository = "private/project";
  for (const [value, code, diagnostic] of [
    [{ format: "json", text: '{"version": ' + SECRET }, 409, /Invalid JSON syntax/],
    [{ format: "yaml", text: "version: &forbidden 1" }, 409, /unsupported YAML/],
    [encode(included("https://example.invalid/include.yml")), 409, /contained relative paths/],
    [encode(included("/etc/private.yml")), 409, /contained relative paths/],
    [encode(included("parts/unbound.yml")), 400, /include is outside/],
    [encode(manifest("imported", [task("unbound-brief")])), 400, /outside its approved checkout/],
    [encode(unauthorizedRepo), 400, /match an approved input binding/],
    [encode(manifest("imported", [anchor("upstream", "private-producer"), task("assemble", ["upstream"])])), 403, /producer is unavailable/],
  ]) {
    await paste(page, value);
    const result = await previewReply(page, code);
    assert.match(result.error, diagnostic);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`${SECRET}|private-producer|private-terminal|private/project|/etc/private`));
    assert.ok(await submit(page).isDisabled());
    await close(page);
  }
  const token = await page.locator("main[data-token]").getAttribute("data-token");
  const bypass = await page.request.post(world.origin + "/api/plan/control", {
    headers: { origin: world.origin, "x-gallivant-token": token },
    data: { action: "queue", stage: "review", requestId: "unbound-route", file: "unbound-plan.json" },
  });
  assert.equal(bypass.status(), 400, "a protected file operand cannot escape configured browser input bindings");
  await bypass.dispose();
  assert.equal(calls.length, initialReads);
  await paste(page, encode(included("parts/allowed.yml"), "yaml"));
  const good = await previewReply(page);
  assert.equal(good.proposal.groups[0].id, "included");
  assert.ok(good.proposal.sources.some(file => file.path === "parts/allowed.yml" && /^[0-9a-f]{64}$/.test(file.digest)));
  assert.deepEqual(readFileSync(state.file), saved);
  assert.equal(world.spawned(), 0);
  await close(page);
  const attempt = await page.request.post(world.origin + "/api/plan/control", {
    headers: { authorization: "browser-without-grant", origin: world.origin, "x-gallivant-token": token },
    data: { action: "queue", stage: "review", requestId: "unauthorized", manifest: encode(included("parts/allowed.yml")) },
  });
  assert.equal(attempt.status(), 403);
  await attempt.dispose();
  world.allowBrowser(false);
  await page.reload();
  assert.equal(await page.getByRole("button", { name: "New plan", exact: true }).count(), 0);
  await show(page, "requires a protected operator session");
});

test("changed previews require review and a dropped confirmation response observes the original receipt", { timeout: 45000 }, async t => {
  const world = await open(t), { page, state } = world;
  world.brief("snapshot");
  await page.goto(path(world, MOUNT, { theme: "light" }));
  await openImport(page);
  await paste(page, encode(manifest("exact-review", [task("snapshot")])));
  const before = await previewReply(page);
  world.brief("snapshot", "\nA changed input must have a new approval.\n");
  await submit(page).click(); await finished(page);
  assert.match(await status(page).textContent(), /Plan inputs, bindings or approval changed/);
  assert.equal(state.load().plans?.instances.length ?? 0, 0);
  assert.ok(await submit(page).isDisabled());
  await close(page);
  const afterReview = await previewReply(page);
  assert.notEqual(before.revision, afterReview.revision);
  const posts = [];
  await page.route("**/api/plan/control", async route => {
    const command = route.request().postDataJSON(); posts.push(command);
    if (command.stage !== "confirm") return route.continue();
    const response = await route.fetch({ timeout: 10000 });
    assert.equal(response.status(), 200);
    await response.dispose();
    await route.abort("failed");
  });
  await submit(page).evaluate(button => { button.click(); button.click(); }); await finished(page);
  assert.match(await status(page).textContent(), /Plan accepted for coordinator dispatch/);
  assert.deepEqual(posts.map(p => p.stage), ["confirm", "reconcile"]);
  assert.ok(posts.every(post => post.requestId === afterReview.requestId && post.approve === afterReview.revision));
  assert.equal(state.load().plans.instances.length, 1);
  const token = await page.locator("main[data-token]").getAttribute("data-token");
  const hostReads = world.calls.length;
  const replay = await page.request.post(world.origin + MOUNT + "/api/plan/control", {
    headers: { origin: world.origin, "x-gallivant-token": token }, data: posts[0],
  });
  assert.equal(replay.status(), 200);
  assert.equal((await replay.json()).instanceId, state.load().plans.instances[0].id);
  await replay.dispose();
  assert.equal(world.calls.length, hostReads, "reconciling or repeating the exact receipt does not recompile");
  assert.equal(world.spawned(), 0);
  await review(page).getByRole("link", { name: "Open saved plan" }).click();
  await page.waitForURL(url => url.searchParams.has("plan"));
  assert.match(await detail(page).textContent(), /Queued/);
  assert.match(await detail(page).textContent(), /Task link available after registration/);
});

test("group reviews show affected future nodes and retain independent worker controls", { timeout: 40000 }, async t => {
  const world = await open(t), { page, state } = world;
  const { producer } = await diamondPlans(world);
  await page.goto(path(world, "", { plan: producer.instanceId, node: "implementation" }));
  const groupScope = detail(page).getByRole("region", { name: "Future dispatch for implementation" });
  const active = state.get(`${REPO}/api`), initial = world.spawned();
  await groupScope.getByRole("button", { name: "Review hold" }).click(); await ready(page);
  assert.match(await review(page).textContent(), /Affected future tasks \(1\).*implementation\/overflow-check/s);
  assert.match(await review(page).textContent(), /Admitted tasks with independent controls \(2\)/);
  await submit(page).click(); await finished(page);
  assert.match(await status(page).textContent(), /dispatch change applied/);
  await close(page);
  await groupScope.getByRole("button", { name: "Review releasing hold" }).click(); await ready(page);
  await submit(page).click(); await finished(page);
  await close(page);
  await groupScope.getByRole("button", { name: "Review future cancellation" }).click(); await ready(page);
  assert.match(await review(page).textContent(), /implementation\/overflow-check/);
  await submit(page).click(); await finished(page);
  await close(page);
  await show(page, "Future dispatch is cancelled in this scope.");
  assert.match(await dependencies(page).locator('[data-milestone="implementation/overflow-check"]').textContent(), /Future dispatch cancelled/);
  assert.match(await page.locator(".chain-progress").textContent(), /1 of 5 tasks integrated/);
  assert.deepEqual(state.get(`${REPO}/api`), active);
  assert.equal(world.spawned(), initial);
  assert.equal(state.graphPlan(producer.instanceId).control.groups.implementation.status, "cancelled");
});

test("a single lifecycle preserves the shell, active focus and disclosures, and disables stale approvals", { timeout: 45000 }, async t => {
  const world = await open(t), { page } = world;
  await page.goto(path(world, MOUNT, { pq: "update", theme: "dark" }));
  assert.equal(new URL(page.url()).searchParams.has("plan"), false);
  const plan = await world.queue("updates", [task("first"), task("second", ["first"])]);
  await page.getByRole("button", { name: "Refresh plans" }).click();
  await page.waitForURL(url => url.searchParams.get("plan") === plan.instanceId && url.searchParams.get("node") === "first");
  await page.evaluate(() => { document.querySelector(".top").dataset.retained = "true"; });
  const evidence = detail(page).locator("details");
  await evidence.locator("summary").click();
  await detail(page).locator("summary").focus();
  const oldScroll = await page.evaluate(() => scrollY);
  await page.clock.runFor(10001); await refreshed(page);
  assert.equal(await evidence.getAttribute("open"), "");
  assert.equal(await detail(page).locator("summary").evaluate(element => document.activeElement === element), true);
  assert.equal(await page.evaluate(() => scrollY), oldScroll);
  assert.equal(await page.locator(".top").getAttribute("data-retained"), "true");
  await page.getByRole("button", { name: "Review hold", exact: true }).click(); await ready(page);
  await world.tick();
  await page.clock.runFor(10001); await refreshed(page);
  assert.ok(await submit(page).isDisabled());
  assert.match(await status(page).textContent(), /plan or your access changed/);
  await close(page);
  await page.getByRole("button", { name: "Review hold", exact: true }).click(); await ready(page);
  const outages = [];
  await page.route("**/api/plans?*", route => { outages.push(route.request().url()); return route.fulfill({ status: 503, body: "offline" }); });
  await page.clock.runFor(11000); await refreshed(page);
  assert.match(await page.locator("#chains-status").textContent(), /Stale · last good/);
  assert.ok(await submit(page).isDisabled());
  assert.match(await status(page).textContent(), /observations are stale/);
  assert.equal(await evidence.getAttribute("open"), "");
  await close(page);
  assert.ok(outages.length >= 1);
  await page.unroute("**/api/plans?*");
  const requests = [], failed = [];
  page.on("request", request => { if (request.url().includes("/api/plans?") || request.resourceType() === "eventsource") requests.push(request); });
  page.on("requestfailed", request => failed.push(request.url()));
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(45000);
  assert.equal(requests.length, 0);
  const delayed = Promise.withResolvers(), release = Promise.withResolvers();
  let held = true;
  await page.route("**/api/plans?*", async route => {
    if (!held) return route.continue();
    delayed.resolve(); await release.promise; await route.continue().catch(() => {});
  });
  t.after(() => release.resolve());
  await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event("visibilitychange")); });
  await page.clock.runFor(1000); await delayed.promise;
  await page.clock.runFor(1000);
  assert.equal(requests.length, 1, "one visible poll and no SSE");
  held = false;
  await choose(page, dependencies(page).getByRole("link", { name: "second", exact: true }), "second");
  assert.equal(await page.locator(".top").getAttribute("data-retained"), "true");
  assert.equal(new URL(page.url()).searchParams.get("pq"), "update");
  assert.equal(new URL(page.url()).searchParams.get("theme"), "dark");
  assert.equal(requests.length, 2, "one poll followed by one selection read");
  assert.deepEqual([...new Set(failed)], [requests[0].url()]);
  release.resolve();
  await page.unroute("**/api/plans?*");
  const departing = Promise.withResolvers(), finish = Promise.withResolvers();
  t.after(() => finish.resolve());
  await page.route("**/api/plans?*", async route => {
    departing.resolve(); await finish.promise; await route.continue().catch(() => {});
  });
  await page.clock.runFor(10001); await departing.promise;
  const departedURL = requests.at(-1).url();
  const aborted = page.waitForEvent("requestfailed", { predicate: request => request.url() === departedURL, timeout: 5000 });
  await Promise.all([aborted, page.goto(world.origin + MOUNT + "/", { waitUntil: "domcontentloaded", timeout: 10000 })]);
  finish.resolve();
  await page.clock.runFor(25000);
  assert.equal(requests.length, 3, "departing from Plans ends its reads");
});

test("plan workspace and review are accessible on both mounts, themes, five widths, landscape and zoom", { timeout: 90000 }, async t => {
  const world = await open(t), { page } = world;
  const { producer } = await diamondPlans(world);
  world.brief("mobile-release");
  for (const base of ["", MOUNT]) for (const theme of ["light", "dark"]) {
    for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1280, 900], [1440, 1000], [844, 390]]) {
      await page.setViewportSize({ width, height });
      await page.goto(path(world, base, { plan: producer.instanceId, node: "release", theme, diagram: "1" }));
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${height} ${theme} ${base}`);
      assert.ok((await dependencies(page).locator("a").first().boundingBox()).height >= 44);
      assert.ok((await page.getByRole("link", { name: "Hide diagram" }).boundingBox()).height >= 44);
      if (width === 360 || width === 1440) {
        const axe = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        assert.deepEqual(axe.violations.map(item => [item.id, item.nodes.map(node => node.target)]), []);
      }
    }
    await page.setViewportSize({ width: 640, height: 450 });
    await page.goto(path(world, base, { plan: producer.instanceId, node: "release", theme, diagram: "1" }));
    await page.addStyleTag({ url: world.origin + "/zoom.css" });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "200% zoom");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path(world, MOUNT, { theme: "light" }));
  await openImport(page);
  await paste(page, encode(manifest("mobile-review", [anchor("foundation", producer.name), task("mobile-release", ["foundation"])]), "yaml"));
  await previewReply(page); await ready(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok((await submit(page).boundingBox()).height >= 44);
  assert.deepEqual((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations.map(item => item.id), []);
  await capture(page, "dependency-plans-review-mobile");
  await page.keyboard.press("Escape");
  assert.equal(await review(page).count(), 0);
  assert.ok(await preview(page).evaluate(button => document.activeElement === button));
  await discard(page);
});

test("an uploaded edit and producer attachment use the saved future scope and reconcile a lost edit", { timeout: 35000 }, async t => {
  const world = await open(t), { page, state } = world;
  const consumer = await world.queue("editable", [task("editable-task")]);
  const producer = await world.queue("producer", [task("producer-task")]);
  await page.goto(path(world, MOUNT, { plan: consumer.instanceId }));
  world.brief("editable-task", "\nThe revised acceptance keeps the same task identity.\n");
  const scope = page.getByRole("region", { name: "Future dispatch for editable" });
  await scope.getByRole("button", { name: "Edit future inputs" }).click();
  await paste(page, encode(manifest(consumer.name, [task("editable-task")])));
  const edit = await previewReply(page);
  assert.equal(edit.action, "edit");
  assert.deepEqual(edit.scope.changes.map(change => change.id), ["editable-task"]);
  const posts = [];
  await page.route("**/api/plan/control", async route => {
    const command = route.request().postDataJSON(); posts.push(command);
    if (command.stage !== "confirm") return route.continue();
    const result = await route.fetch({ timeout: 10000 });
    assert.equal(result.status(), 200);
    await result.dispose();
    await route.abort("failed");
  });
  await submit(page).click(); await finished(page);
  assert.match(await status(page).textContent(), /dispatch change applied/);
  assert.deepEqual(posts.map(post => post.stage), ["confirm", "reconcile"]);
  assert.equal(state.graphPlan(consumer.instanceId).approval.revision, 2);
  await page.unroute("**/api/plan/control");
  await close(page);
  await page.waitForFunction(() => document.querySelector("[data-approval-revision]")?.dataset.approvalRevision === "2");
  await discard(page);
  await scope.getByRole("button", { name: "Attach a producer" }).click();
  await paste(page, encode(manifest(consumer.name, [
    anchor("upstream", producer.name), task("editable-task", ["upstream"]),
  ]), "yaml"));
  const attachment = await previewReply(page);
  assert.equal(attachment.action, "attach");
  assert.equal(attachment.proposal.anchors[0].instanceId, producer.instanceId);
  await submit(page).click(); await finished(page);
  assert.match(await status(page).textContent(), /dispatch change applied/);
  assert.equal(state.graphPlan(consumer.instanceId).approval.revision, 3);
  assert.equal(state.graphPlan(producer.instanceId).approval.revision, 1);
  assert.equal(world.spawned(), 0);
});
