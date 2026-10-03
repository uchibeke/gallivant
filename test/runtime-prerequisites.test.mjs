import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { adapters, buildRun } from "../lib/harness.mjs";
import { harnessBinaryCheck } from "../lib/commands/doctor.mjs";
import { CONFIG, harnessBin, tempHome } from "./helpers.mjs";

test("every dispatch names the actual executable while retaining the native flags, session and complete prompt", () => {
  for (const [harness, adapter] of Object.entries(adapters)) {
    for (const mode of ["start", "resume"]) {
      const bin = `/opt/installed cli's/${harness}`;
      const settings = CONFIG.harness[harness].settings;
      const config = { ...CONFIG, harness: { ...CONFIG.harness, [harness]: { ...CONFIG.harness[harness], bin } } };
      const prompt = "Operator context\nDo not change models.\nEND OF BRIEF";
      const session = "11111111-1111-4111-8111-111111111111";
      const ctx = { session, prompt, budget: config.max_budget_usd, settings, cwd: "/work" };
      const native = adapter[mode](ctx);
      const run = buildRun({ harness, config, mode, ...ctx });
      assert.equal(run.cmd, bin);
      assert.deepEqual(run.args.slice(0, -1), native.slice(0, -1), `${harness} ${mode}: no model or safety overrides added`);
      const sent = run.args.at(-1);
      assert.ok(sent.includes(JSON.stringify(bin)));
      assert.ok(sent.endsWith(`\n\n${prompt}`));
      assert.match(sent, /version\/sign-in checks alone do not prove model access/);
      assert.match(sent, /browser or capture surface/);
      assert.match(sent, /does not authorize nested jobs/);
      assert.match(sent, /do not repeat unchanged blocked calls/);
    }
  }
});

test("doctor detects an older nested executable without prescribing a downgrade", async t => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, "new"));
  mkdirSync(join(home, "old"));
  const bin = harnessBin(join(home, "new"), "codex", { version: "0.160.0" });
  const shell = harnessBin(join(home, "old"), "codex", { version: "0.158.0" });
  const config = { ...CONFIG, harness: { codex: { bin } } };
  const result = await harnessBinaryCheck("codex", config, shell);
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes(bin) && result.detail.includes(shell));
  assert.match(result.detail, /0\.160\.0/);
  assert.match(result.detail, /0\.158\.0/);
  assert.match(result.fix, /configured executable explicitly/);
  assert.doesNotMatch(result.fix, /set harness\.codex\.bin to/);
  for (const dir of ["old", "new"]) {
    assert.deepEqual(readFileSync(join(home, dir, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"]], "diagnostic must not spend model calls");
  }
});

test("doctor accepts symlink aliases and a configured binary absent from PATH", async t => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = harnessBin(home, "codex", { version: "0.160.0" });
  const alias = join(home, "codex");
  symlinkSync(bin, alias);
  const config = { ...CONFIG, harness: { codex: { bin } } };
  assert.equal((await harnessBinaryCheck("codex", config, alias)).ok, true);
  assert.equal((await harnessBinaryCheck("codex", config, null)).ok, true);
  assert.deepEqual(readFileSync(join(home, "codex-calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse), [["--version"], ["--version"]]);
});

test("doctor names a missing or unsupported configured executable before considering PATH", async t => {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const missing = join(home, "missing");
  assert.match((await harnessBinaryCheck("codex", { harness: { codex: { bin: missing } } }, null)).detail, /not found/);
  const old = harnessBin(home, "codex", { version: "0.100.0" });
  const result = await harnessBinaryCheck("codex", { harness: { codex: { bin: old } } }, missing);
  assert.equal(result.ok, false);
  assert.match(result.detail, /older than/);
  assert.ok(result.fix.includes(old));
});
