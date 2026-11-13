// The four approved product captures also serve as the pinned visual references.
// Keep this seed shared by the capture command and regression comparison.
import { fixture, NOW, TASK, RUN } from "./fixture.mjs";
import { seedWorkspace } from "./workspace-fixture.mjs";
import { seedChains, CHAIN } from "./chains-fixture.mjs";

export const finalCaptures = ["final-overview-dark", "final-overview-light", "final-task-mobile", "final-chain-desktop"];
export async function finalSurface(browser, name) {
  if (!finalCaptures.includes(name)) throw new Error("Unknown final capture");
  const world = await fixture();
  let context;
  try {
    const mobile = name === "final-task-mobile", chain = name === "final-chain-desktop";
    if (mobile) seedWorkspace(world);
    if (chain) await seedChains(world);
    context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    await context.route("**/*", route => new URL(route.request().url()).origin === world.origin ? route.continue() : route.abort());
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    await page.clock.install({ time: new Date(NOW) }); await page.clock.setFixedTime(new Date(NOW));
    const path = mobile ? `/run?id=${encodeURIComponent(TASK)}&run=${RUN}` : chain ? `/chains?chain=${CHAIN}&milestone=${encodeURIComponent(TASK)}` : "/?";
    await page.goto(`${world.origin}${path}&theme=${name.endsWith("light") ? "light" : "dark"}`);
    if (mobile) await page.waitForFunction(() => document.getElementById("workspace-state").textContent.includes("snapshot current"));
    await page.evaluate(() => document.fonts.ready);
    // Prevent timers advancing state while a long full-page capture is taken.
    await page.clock.pauseAt(new Date(Date.parse(NOW) + 1000));
    return { page, component: mobile ? "#run-controls" : chain ? ".milestone-detail" : ".overview-filters",
      async close() { await context.close(); await world.close(); } };
  } catch (error) { await context?.close(); await world.close(); throw error; }
}
