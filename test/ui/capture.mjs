import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { seedWorkspace } from "./workspace-fixture.mjs";
import { fixture, NOW, TASK, RUN } from "./fixture.mjs";

const name = process.argv[2];
if (!["before-overview-desktop", "foundation-overview-dark", "overview-desktop", "overview-mobile", "task-workspace-desktop", "task-workspace-mobile"].includes(name)) throw new Error("Choose an approved capture name");
const world = await fixture();
const workspaceCapture = name.startsWith("task-workspace-");
let browser;
try {
  if (workspaceCapture) seedWorkspace(world);
  browser = await chromium.launch();
  const viewport = name.endsWith("-mobile") ? { width: 390, height: 844 } : { width: 1440, height: 1000 };
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(`${world.origin}${workspaceCapture ? `/run?id=${encodeURIComponent(TASK)}&run=${RUN}` : "/?"}${workspaceCapture ? "&" : ""}theme=dark`, { waitUntil: "networkidle", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync("docs/ui/previews", { recursive: true });
  await page.screenshot({ path: `docs/ui/previews/${name}.png`, fullPage: true });
} finally { await browser?.close(); await world.close(); }
