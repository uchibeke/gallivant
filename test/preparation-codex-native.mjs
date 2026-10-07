// Opt-in native CLI contract check against a loopback Responses fixture. No paid
// provider and no user's credentials. Supply a real cached model catalog so this
// checks the selected model's tool surface rather than Codex fallback metadata.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { buildPreparationRun, adapterFor } from "../lib/harness.mjs";

const [bin, catalogPath, ...selectedModels] = process.argv.slice(2);
if (!bin || !catalogPath || !selectedModels.length) throw new Error("Usage: node test/preparation-codex-native.mjs /absolute/codex /path/models_cache.json model [model...]");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const root = mkdtempSync(join(tmpdir(), "gallivant-native-preparation-"));
const cwd = join(root, "draft"), home = join(cwd, "home"), configHome = join(home, ".codex");
mkdirSync(cwd); mkdirSync(configHome, { recursive: true });
const marker = join(root, "unexpected-tool-execution");
const insideMarker = join(cwd, "unexpected-implementation");
const notifyMarker = join(root, "unexpected-notification");
const instructionFile = join(root, "unselected-owner-instructions.md");
const privateInstruction = "GALLIVANT_UNSELECTED_PRIVATE_INSTRUCTION_SENTINEL";
writeFileSync(instructionFile, privateInstruction);
const inlineSentinels = ["GALLIVANT_PRIVATE_SYSTEM_SENTINEL", "GALLIVANT_PRIVATE_DEVELOPER_SENTINEL", "GALLIVANT_PRIVATE_COMPACT_SENTINEL"];
const discoverySentinels = ["PROJECT_AGENTS", "HOME_AGENTS", "MEMORY", "SKILL"].map(name => `GALLIVANT_UNSELECTED_${name}_SENTINEL`);
for (const [i, path] of [join(cwd, "AGENTS.md"), join(configHome, "AGENTS.md"), join(configHome, "memories", "memory_summary.md"), join(configHome, "skills", "owner", "SKILL.md")].entries()) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, path.endsWith("SKILL.md") ? `---\nname: owner\ndescription: ${discoverySentinels[i]}\n---\n${discoverySentinels[i]}` : discoverySentinels[i]);
}
const ownerLog = join(root, "owner-log"), ownerDb = join(root, "owner-db");
// Force the catalog into the native loader. A custom provider's /models URL
// alone does not prove that its metadata was used to resolve agent tools.
const privateCatalog = join(configHome, "fixture-model-catalog.json");
writeFileSync(privateCatalog, JSON.stringify({ models: catalog.models }));
const observations = [];
let requests = [], responseIndex = 0, telemetryRequests = 0;
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ models: catalog.models })); return; }
  if (request.url.startsWith("/telemetry")) { telemetryRequests++; request.resume(); response.writeHead(200); response.end("{}"); return; }
  let bytes = ""; for await (const chunk of request) bytes += chunk;
  const body = JSON.parse(bytes); requests.push(body);
  // A hostile/incorrect provider response must not be able to invoke a tool
  // omitted from the advertised registry. Both shell and inherited MCP are tried.
  const n = responseIndex++;
  const item = n === 2 || n === 3
    ? { id: `patch_${n}`, type: "custom_tool_call", call_id: `call_patch_${n}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${n === 2 ? marker : insideMarker}\n+unexpected write\n*** End Patch\n` }
    : n < 2 || n === 4
    ? { id: `fc_${n}`, type: "function_call", call_id: `call_${n}`, name: n === 4 ? "spawn_agent" : n === 0 ? "exec_command" : "mcp__fixture__write", arguments: JSON.stringify(n === 4 ? { task_name: "forbidden", message: "Return unexpected delegation" } : { cmd: `touch ${marker}` }) }
    : { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "prepared", annotations: [] }] };
  const result = { id: `resp_${n}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of [
    { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: result },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: configHome, XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local/share"), TMPDIR: root };
  for (const model of selectedModels) {
    assert.ok(catalog.models.some(m => m.slug === model), `missing real metadata for ${model}`);
    writeFileSync(join(configHome, "config.toml"), [
      `model=${JSON.stringify(model)}`, 'model_provider="preparation_fixture"',
      'model_reasoning_effort="high"',
      `model_catalog_json=${JSON.stringify(privateCatalog)}`,
      ...["instructions", "developer_instructions", "compact_prompt"].map((key, i) => `${key}=${JSON.stringify(inlineSentinels[i])}`),
      `model_instructions_file=${JSON.stringify(instructionFile)}`,
      `experimental_compact_prompt_file=${JSON.stringify(instructionFile)}`,
      `log_dir=${JSON.stringify(ownerLog)}`, `sqlite_home=${JSON.stringify(ownerDb)}`,
      `notify=${JSON.stringify([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(notifyMarker)},process.argv.at(-1))`])}`,
      'sandbox_mode="workspace-write"', '[agents]', 'enabled=true', '[features]', 'multi_agent_v2=true', 'memories=true', 'request_permissions_tool=true',
      `token_budget={enabled=true,auto_compact_fallback_prompt=${JSON.stringify(inlineSentinels[2])},auto_compact_fallback_buffer_tokens=64}`,
      '[skills]', 'include_instructions=true', '[skills.bundled]', 'enabled=true',
      '[memories]', 'generate_memories=true', 'use_memories=true',
      '[otel]', 'log_user_prompt=true', 'log_agent_responses=true',
      '[otel.exporter.otlp-http]', `endpoint=${JSON.stringify(`${url}/telemetry`)}`, 'protocol="json"',
      '[sandbox_workspace_write]', 'network_access=true',
      '[permissions.gallivant_preparation.filesystem]', '":root"="write"',
      '[model_providers.preparation_fixture]', 'name="preparation_fixture"', `base_url=${JSON.stringify(url)}`,
      'wire_api="responses"', 'requires_openai_auth=false', 'supports_websockets=false',
      '[mcp_servers.fixture]', `command=${JSON.stringify(process.execPath)}`,
      `args=${JSON.stringify(["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'MCP launched')`])}`,
    ].join("\n"));
    let spec = buildPreparationRun({ harness: "codex", config: { harness: { codex: { bin } }, max_budget_usd: 0 }, mode: "start", session: null, prompt: "Return only prepared. Do not call tools.", cwd });
    spec = await spec.configure(spec, { cwd, env });
    requests = []; responseIndex = 0;
    const child = spawn(spec.cmd, spec.args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", stderr = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 45_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); clearTimeout(timeout);
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(marker), false, "disabled tools executed");
    assert.equal(existsSync(insideMarker), false, "preparation modified its workspace");
    assert.equal(existsSync(notifyMarker), false, "legacy notify received the intake prompt outside the sandbox");
    assert.equal(requests.length, 6, "hostile shell, MCP, inside/outside patch and delegation replies were processed before completion");
    for (const request of requests) {
      assert.equal(request.model, model, "adapter changed the selected model");
      assert.equal(request.reasoning?.effort, "high", "adapter changed the selected reasoning effort");
      assert.ok((request.tools ?? []).every(t => ["request_user_input", "apply_patch"].includes(t.name)), "preparation exposed an unrestricted tool");
      for (const sentinel of [privateInstruction, ...inlineSentinels, ...discoverySentinels]) assert.ok(!JSON.stringify(request).includes(sentinel), `unselected host context reached the model: ${sentinel}`);
    }
    const outcome = adapterFor("codex").outcome(output.trim().split("\n"));
    assert.equal(outcome.ok, true, output); assert.equal(outcome.lastMessage, "prepared");
    observations.push({ model, catalogMultiAgentVersion: catalog.models.find(m => m.slug === model).multi_agent_version, requests: requests.length, tools: (requests[0].tools ?? []).map(t => t.name), hostileToolCallsRejected: 5, notifierDisabled: true, unselectedInstructionsExcluded: true, reasoningEffortPreserved: true, output: outcome.lastMessage });
  }
  const refusedOverrides = [];
  for (const override of ['sandbox_mode="workspace-write"', 'features.shell_tool=true', 'agents.enabled=true', 'features.multi_agent_v2=true', 'instructions="unselected-system"', 'developer_instructions="unselected-developer"', 'compact_prompt="unselected-compaction"', 'skills.include_instructions=true', 'memories.use_memories=true', 'otel.log_user_prompt=true', `model_instructions_file=${JSON.stringify(instructionFile)}`, `experimental_compact_prompt_file=${JSON.stringify(instructionFile)}`, 'permissions.gallivant_preparation.filesystem.":root"="write"', `notify=${JSON.stringify([process.execPath, "-e", "process.exit(1)"])}`]) {
    let spec = buildPreparationRun({ harness: "codex", config: { harness: { codex: { bin } }, max_budget_usd: 0 }, mode: "start", session: null, prompt: "This must never reach the provider", cwd });
    // Inject a conflicting effective value without changing system/MDM policy.
    // The unit fixture separately exercises merged administrator-layer results.
    spec = { ...spec, args: [...spec.args.slice(0, -1), "-c", override, spec.args.at(-1)] };
    const before = requests.length;
    await assert.rejects(spec.configure(spec, { cwd, env }), e => e.code === "TASK_PREPARATION_BOUNDARY");
    assert.equal(requests.length, before, "configuration inspection sent a model request");
    refusedOverrides.push(override.split("=")[0]);
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(existsSync(notifyMarker), false, "legacy notifier ran asynchronously");
  assert.equal(telemetryRequests, 0, "native telemetry exported preparation data");
  assert.equal(existsSync(ownerLog), false, "native logs escaped the private home");
  assert.equal(existsSync(ownerDb), false, "native state escaped the private home");
  assert.equal(readFileSync(instructionFile, "utf8"), privateInstruction, "operator instruction file was changed");
  console.log(JSON.stringify({ nativeVersion: spawnSync(bin, ["--version"], { encoding: "utf8", env }).stdout.trim(), provider: "loopback fixture; no inference", observations, refusedOverrides }, null, 2));
} finally { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); }
