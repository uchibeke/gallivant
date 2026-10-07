import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { adapters, buildRun, buildPreparationRun, isPreparationReceipt, preparationCapability, capabilitiesFor } from "../lib/harness.mjs";
import { checkVersion } from "../lib/probe.mjs";
import { CONFIG, tempHome, harnessBin } from "./helpers.mjs";
import { restrictedCodexConfig } from "./codex-config-fixture.mjs";

function codexFixture(dir, { config = restrictedCodexConfig(), servers = [{ name: "z-last" }, { name: "a_first" }], probeSource = null } = {}) {
  const bin = join(dir, "codex-fixture.mjs");
  writeFileSync(bin, `#!${process.execPath}
if (process.argv[2] === 'mcp') console.log(${JSON.stringify(JSON.stringify(servers))});
else if (process.argv[2] === 'app-server') {
  ${probeSource ?? `const { serveCodexConfig } = await import(${JSON.stringify(new URL("./codex-config-fixture.mjs", import.meta.url).href)}); serveCodexConfig(${JSON.stringify(config)});`}
} else { (await import('node:fs')).writeFileSync(${JSON.stringify(join(dir, "unexpected-turn"))}, 'draft started'); }
`, { mode: 0o755 });
  return { ...buildPreparationRun(options("codex")), cmd: bin };
}

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
  const dir = tempHome(), spec = codexFixture(dir);
  writeFileSync(join(dir, "config.toml"), 'model="selected-model"\nmodel_provider="selected-provider"\nnotify=["private-command", "private-argument"]\nsandbox_mode="workspace-write"\n[sandbox_workspace_write]\nnetwork_access=true\n');
  const final = await spec.configure(spec, { cwd: dir, env: { PATH: process.env.PATH, CODEX_HOME: dir } });
  for (const flag of ['approval_policy="never"', 'default_permissions="gallivant_preparation"', 'web_search="disabled"', 'features.shell_tool=false', 'features.apps=false', 'features.plugins=false', 'features.hooks=false', 'features.computer_use=false', 'features.multi_agent=false', 'features.image_generation=false', 'features.view_image=false', 'features.goals=false', 'features.code_mode_host=false', 'mcp_servers.a_first.enabled=false', 'mcp_servers.z-last.enabled=false']) assert.ok(final.args.includes(flag), flag);
  assert.equal(final.args.at(-1), spec.args.at(-1));
  assert.ok(final.args.includes("notify=[]"));
  assert.ok(final.args.includes("agents.enabled=false"));
  assert.ok(final.args.includes("features.multi_agent_v2=false"));
  assert.ok(!final.args.includes("-m"), "the configured model remains selected");
  assert.ok(!final.args.some(a => a.startsWith("model_provider=")), "the configured provider remains selected");
  assert.ok(!final.args.some(a => /^sandbox_mode=|^sandbox_workspace_write\./.test(a)));
  const profile = readFileSync(join(dir, "config.toml"), "utf8");
  assert.match(profile, /selected-model/); assert.match(profile, /selected-provider/); assert.doesNotMatch(profile, /sandbox_mode|sandbox_workspace_write|notify|private-command/);
});

test("managed effective settings cannot override the preparation boundary", async t => {
  const mutations = {
    "writable legacy sandbox": c => { c.sandbox_mode = "workspace-write"; },
    "broad read-only legacy sandbox": c => { c.sandbox_mode = "read-only"; },
    "legacy workspace settings": c => { c.sandbox_workspace_write = {}; },
    "different permission profile": c => { c.default_permissions = "workspace"; },
    "inherited permission grants": c => { c.permissions.gallivant_preparation.extends = "workspace"; },
    "workspace grants": c => { c.permissions.gallivant_preparation.workspace_roots = ["/private"]; },
    "additional file grant": c => { c.permissions.gallivant_preparation.filesystem[":root"] = "write"; },
    "network enabled": c => { c.permissions.gallivant_preparation.network.enabled = true; },
    "MCP enabled": c => { c.mcp_servers = { managed: { enabled: true } }; },
    "MCP enabled by default": c => { c.mcp_servers = { managed: { command: "private-command" } }; },
    "tools re-enabled": c => { c.features.shell_tool = true; },
    "hooks re-enabled": c => { c.features.hooks = true; },
    "model-selected delegation restored": c => { c.agents.enabled = true; },
    "explicit V2 delegation restored": c => { c.features.multi_agent_v2 = true; },
    "instruction file restored": c => { c.model_instructions_file = "/private/secret-credential"; },
    "compact instruction file restored": c => { c.experimental_compact_prompt_file = "/private/secret-credential"; },
    "notifier restored": c => { c.notify = ["private-command", "secret-credential"]; },
    "named config profile": c => { c.profile = "implementation"; },
    "incomplete protocol result": c => { delete c.features; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async () => {
    const dir = tempHome(), config = restrictedCodexConfig(); mutate(config);
    const policy = 'model="managed-model"\n# preserved administrator policy\n';
    writeFileSync(join(dir, "managed_config.toml"), policy);
    const spec = codexFixture(dir, { config });
    await assert.rejects(spec.configure(spec, { cwd: dir, env: { CODEX_HOME: dir } }), e => e.code === "TASK_PREPARATION_BOUNDARY" && !/private-command|secret-credential/.test(e.message));
    assert.equal(readFileSync(join(dir, "managed_config.toml"), "utf8"), policy);
    assert.equal(existsSync(join(dir, "unexpected-turn")), false);
  });
});

test("preparation strips unselected instruction files without modifying their contents or provider settings", async () => {
  const dir = tempHome(), spec = codexFixture(dir);
  const instruction = join(dir, "owner-instructions.md");
  writeFileSync(instruction, "private-owner-context");
  writeFileSync(join(dir, "config.toml"), `model="selected-model"\nmodel_provider="selected-provider"\nmodel_instructions_file=${JSON.stringify(instruction)}\nexperimental_compact_prompt_file=${JSON.stringify(instruction)}\n[agents]\nenabled=true\n[features]\nmulti_agent_v2=true\n`);
  await spec.configure(spec, { cwd: dir, env: { CODEX_HOME: dir } });
  const saved = readFileSync(join(dir, "config.toml"), "utf8");
  assert.doesNotMatch(saved, /model_instructions_file|experimental_compact_prompt_file|owner-instructions/);
  assert.match(saved, /selected-model/); assert.match(saved, /selected-provider/);
  assert.equal(readFileSync(instruction, "utf8"), "private-owner-context");
});

test("compatible managed provider settings remain usable; invalid inspection fails closed", async () => {
  const dir = tempHome(), config = { ...restrictedCodexConfig(), model: "managed-model", model_provider: "managed-provider", mcp_servers: { managed: { enabled: false } } };
  const spec = codexFixture(dir, { config });
  await spec.configure(spec, { cwd: dir, env: { CODEX_HOME: dir } });
  for (const probeSource of ["console.log('secret-credential')", "process.exit(1)", "console.log(JSON.stringify({id:1,error:{message:'secret-credential'}}))", "console.log('x'.repeat(1_048_577))"]) {
    const bad = codexFixture(dir, { probeSource });
    await assert.rejects(bad.configure(bad, { cwd: dir, env: { CODEX_HOME: dir } }), e => e.code === "TASK_PREPARATION_BOUNDARY" && !e.message.includes("secret-credential"));
  }
});

test("effective configuration inspection honors cancellation without issuing a turn", async () => {
  const dir = tempHome(), spec = codexFixture(dir, { probeSource: "setInterval(() => {}, 1000)" });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(spec.configure(spec, { cwd: dir, env: { CODEX_HOME: dir }, signal: controller.signal }), e => e.code === "TASK_PREPARATION_BOUNDARY" || e.name === "AbortError");
    assert.equal(existsSync(join(dir, "unexpected-turn")), false);
  } finally { clearTimeout(timer); }
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
