import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters, buildRun, buildPreparationRun, isPreparationReceipt, preparationCapability, capabilitiesFor } from "../lib/harness.mjs";
import { checkVersion } from "../lib/probe.mjs";
import { CONFIG, tempHome, harnessBin } from "./helpers.mjs";

const options = harness => ({ harness, config: CONFIG, mode: "start", session: "6f1c2d3e-1111-4111-8111-111111111111", prompt: "draft", cwd: "/tmp/fixture" });
test("preparation is an adapter capability; ordinary implementation argv stays unchanged", () => {
  for (const harness of ["claude", "codex"]) {
    const spec = buildPreparationRun(options(harness));
    assert.equal(spec.boundary, preparationCapability(harness).boundary);
    assert.ok(isPreparationReceipt(harness, spec.boundary));
    assert.equal(spec.cmd, CONFIG.harness[harness].bin);
    assert.equal(spec.args.at(-1), buildRun(options(harness)).args.at(-1));
  }
  assert.ok(!buildRun(options("codex")).args.includes("--strict-config"));
  assert.equal(preparationCapability("gemini"), null);
  assert.equal(isPreparationReceipt("codex", "unverified"), false);
  // A newly registered adapter uses exactly this path, without a task-service switch.
  adapters.fixture = { ...adapters.claude, preparation: { version: 1, authority: "text-only", boundary: "fixture-no-tools-v1", render: s => ["--fixture-only", ...s.args] } };
  try {
    const o = options("fixture"); o.config = { ...CONFIG, harness: { ...CONFIG.harness, fixture: CONFIG.harness.claude } };
    const capability = { ...capabilitiesFor("claude"), adapter: adapters.fixture, preparation: adapters.fixture.preparation };
    assert.equal(buildPreparationRun(o, capability).boundary, "fixture-no-tools-v1");
  } finally { delete adapters.fixture; }
});

test("Codex preparation removes native tools and disables every inherited MCP server", async () => {
  const dir = tempHome(), bin = join(dir, "codex-fixture.mjs");
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify([{name:'z-last'},{name:'a_first'}]));\n`, { mode: 0o755 });
  let spec = buildPreparationRun(options("codex")); spec.cmd = bin;
  writeFileSync(join(dir, "config.toml"), 'model="selected-model"\nmodel_provider="selected-provider"\nsandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access=true\n');
  const final = await spec.configure(spec, { cwd: dir, env: { PATH: process.env.PATH, CODEX_HOME: dir } });
  for (const flag of ['approval_policy="never"', 'default_permissions="gallivant_preparation"', 'web_search="disabled"', 'features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'features.hooks=false', 'features.computer_use=false', 'features.multi_agent=false', 'features.image_generation=false', 'features.view_image=false', 'features.goals=false', 'features.code_mode_host=false', 'mcp_servers.a_first.enabled=false', 'mcp_servers.z-last.enabled=false']) assert.ok(final.args.includes(flag), flag);
  assert.equal(final.args.at(-1), spec.args.at(-1));
  assert.ok(!final.args.includes("-m"), "the configured model remains selected");
  assert.ok(!final.args.some(a => a.startsWith("model_provider=")), "the configured provider remains selected");
  assert.ok(!final.args.some(a => /^sandbox_mode=|^sandbox_workspace_write\./.test(a)));
  const profile = readFileSync(join(dir, "config.toml"), "utf8");
  assert.match(profile, /selected-model/); assert.match(profile, /selected-provider/); assert.doesNotMatch(profile, /sandbox_mode|sandbox_workspace_write/);
});

test("ambiguous or malformed MCP discovery refuses preparation without leaking its output", async () => {
  for (const output of ["not JSON secret-credential", '{"secret":"credential"}', '[{"name":"a.b"}]', '[{"name":"same"},{"name":"same"}]']) {
    const dir = tempHome(), bin = join(dir, "codex-fixture.mjs");
    writeFileSync(bin, `#!${process.execPath}\nconsole.log(${JSON.stringify(output)});\n`, { mode: 0o755 });
    const spec = { ...buildPreparationRun(options("codex")), cmd: bin };
    await assert.rejects(spec.configure(spec, { cwd: dir, env: { CODEX_HOME: dir } }), error => error.code === "TASK_PREPARATION_BOUNDARY" && !error.message.includes("secret-credential"));
  }
});

test("preparation's minimum version does not raise the existing implementation minimum", async () => {
  const dir = tempHome(), bin = harnessBin(dir, "codex", { version: "0.158.0" });
  const config = { ...CONFIG, harness: { codex: { bin } } };
  assert.equal((await checkVersion("codex", config)).ok, true);
  assert.equal((await checkVersion("codex", config, { minimumVersion: preparationCapability("codex").minimumVersion })).ok, false);
});
