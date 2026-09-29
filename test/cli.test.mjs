import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { GOOD_PRD, tempHome } from "./helpers.mjs";

test("ready --check ignores invalid runtime config and leaves the brief and home unchanged", () => {
  const home = tempHome();
  const path = join(tempHome(), "docs/prds/widget-export.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, GOOD_PRD);
  writeFileSync(join(home, "config.json"), "{invalid configuration");
  const before = readdirSync(home);
  const cli = new URL("../bin/gallivant.mjs", import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, "ready", path, ...args], {
    env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8", timeout: 5000,
  });
  const checked = run(["--check"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.match(checked.stdout, /ok/);
  assert.equal(checked.stderr, "");
  assert.equal(readFileSync(path, "utf8"), GOOD_PRD);
  assert.deepEqual(readdirSync(home), before);
  const recorded = run([]);
  assert.equal(recorded.status, 1);
  assert.match(recorded.stderr, /config|JSON/i);
  assert.equal(readFileSync(path, "utf8"), GOOD_PRD);
});
