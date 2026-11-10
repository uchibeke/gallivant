import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { fixture, NOW } from "./fixture.mjs";

const name = process.argv[2];
if (!["before-overview-desktop", "foundation-overview-dark"].includes(name)) throw new Error("Choose an approved capture name");
const world = await fixture();
let browser;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
  await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(`${world.origin}/?theme=dark`, { waitUntil: "networkidle", timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  mkdirSync("docs/ui/previews", { recursive: true });
  await page.screenshot({ path: `docs/ui/previews/${name}.png`, fullPage: true });
  console.log(`${name}: Chromium ${browser.version()}, fixture v1, 1440 × 1000, ${NOW}`);
} finally { await browser?.close(); await world.close(); }
