import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { seedChains, CHAIN } from "./chains-fixture.mjs";
import { seedWorkspace } from "./workspace-fixture.mjs";
import { fixture, NOW, TASK, RUN } from "./fixture.mjs";
import { CONTROL_NOTE, settleControl } from "./controls-fixture.mjs";
import { intakeFixture, INTAKE_REQUEST } from "./intake-fixture.mjs";

const name = process.argv[2];
if (!["task-intake-desktop", "task-intake-mobile", "chains-desktop", "chains-mobile", "before-overview-desktop", "foundation-overview-dark", "overview-desktop", "overview-mobile", "task-workspace-desktop", "task-workspace-mobile", "task-controls-desktop", "task-controls-mobile"].includes(name)) throw new Error("Choose an approved capture name");
const intakeCapture = name.startsWith("task-intake-");
const world = intakeCapture ? await intakeFixture() : await fixture();
const controlsCapture = name.startsWith("task-controls-");
const workspaceCapture = name.startsWith("task-workspace-") || controlsCapture;
let browser;
try {
  if (workspaceCapture) seedWorkspace(world);
  if (name.startsWith("chains-")) await seedChains(world);
  browser = await chromium.launch();
  const viewport = name.endsWith("-mobile") ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(name.startsWith("chains-") ? `${world.origin}/chains?chain=${CHAIN}&milestone=${encodeURIComponent(TASK)}&theme=${name.endsWith("-mobile") ? "light" : "dark"}` : `${world.origin}${workspaceCapture ? `/run?id=${encodeURIComponent(TASK)}&run=${RUN}` : "/?"}${workspaceCapture ? "&" : ""}theme=dark`, { waitUntil: "networkidle", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  if (intakeCapture) {
    await page.goto(`${world.origin}/task/new?theme=${name.endsWith("-mobile") ? "light" : "dark"}`);
    await page.locator("#intake-repository").selectOption("acme/widget");
    await page.locator("#intake-harness").selectOption("codex");
    await page.locator("#intake-text").fill(INTAKE_REQUEST);
    await page.locator("#intake-prepare").click();
    await page.getByLabel("Which file format should export use?").fill("Use CSV.");
    await page.getByRole("button", { name: "Save answers and prepare", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("intake-review")?.dataset.status === "ready");
    await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
  }
  if (controlsCapture) {
    await page.locator("#run-note").fill(CONTROL_NOTE);
    const accepted = page.waitForResponse(r => r.request().method() === "POST");
    await page.getByRole("button", { name: "Send message", exact: true }).click();
    if ((await accepted).status() !== 202) throw new Error("Fixture control was not accepted");
    world.state.update(TASK, { reason: "brief-changed: carried sources differ from the approved snapshot" });
    settleControl(world, "failed", "The brief or carried sources changed. Restore the approved sources or explicitly review the changed brief before continuing.");
    await page.getByRole("button", { name: "Check request status", exact: true }).click();
    await page.waitForFunction(() => document.getElementById("control-status").dataset.status === "failed");
    await page.locator(".cancel-controls summary").click();
  }
  mkdirSync("docs/ui/previews", { recursive: true });
  if (controlsCapture) await page.locator("#run-controls").screenshot({ path: `docs/ui/previews/${name}.png` });
  else await page.screenshot({ path: `docs/ui/previews/${name}.png`, fullPage: true });
} finally { await browser?.close(); await world.close(); }
