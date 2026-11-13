import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { finalCaptures, finalSurface } from "./final-captures.mjs";

// Semantic/geometry tests run on every OS. Pixels run only in the documented
// Playwright Noble arm64 image; never bless a different platform's font output.
test("pinned Chromium page and component visual references", { skip: process.env.UI_VISUAL !== "1", timeout: 120_000 }, async t => {
  assert.equal(process.platform, "linux"); assert.equal(process.arch, "arm64");
  const browser = await chromium.launch(); t.after(() => browser.close());
  assert.equal(browser.version(), "145.0.7632.0");
  for (const name of finalCaptures) {
    const ui = await finalSurface(browser, name);
    try {
      const expected = PNG.sync.read(readFileSync(new URL(`../../docs/ui/previews/${name}.png`, import.meta.url)));
      const actual = PNG.sync.read(await ui.page.screenshot({ fullPage: true, animations: "disabled" }));
      assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], `${name}: page dimensions`);
      const box = await ui.page.locator(ui.component).boundingBox();
      for (const [label, region] of [["page", { x: 0, y: 0, width: actual.width, height: actual.height }], [ui.component, box]]) {
        let changed = 0, pixels = 0;
        for (let y = Math.max(0, Math.floor(region.y)); y < Math.min(actual.height, Math.ceil(region.y + region.height)); y++) {
          for (let x = Math.max(0, Math.floor(region.x)); x < Math.min(actual.width, Math.ceil(region.x + region.width)); x++) {
            const i = (y * actual.width + x) * 4;
            if ([0, 1, 2, 3].some(c => Math.abs(actual.data[i + c] - expected.data[i + c]) > 16)) changed++;
            pixels++;
          }
        }
        assert.ok(pixels > 0);
        assert.ok(changed / pixels <= 0.001, `${name} ${label}: ${changed}/${pixels} pixels differ (limit 0.1%)`);
      }
    } finally { await ui.close(); }
  }
});
