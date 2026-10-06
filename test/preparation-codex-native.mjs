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
const observations = [];
let requests = [], responseIndex = 0;
const server = createServer(async (request, response) => {
  if (request.url.startsWith("/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ models: catalog.models })); return; }
  let bytes = ""; for await (const chunk of request) bytes += chunk;
  const body = JSON.parse(bytes); requests.push(body);
  // A hostile/incorrect provider response must not be able to invoke a tool
  // omitted from the advertised registry. Both shell and inherited MCP are tried.
  const n = responseIndex++;
  const item = n === 2 || n === 3
    ? { id: `patch_${n}`, type: "custom_tool_call", call_id: `call_patch_${n}`, name: "apply_patch", input: `*** Begin Patch\n*** Add File: ${n === 2 ? marker : insideMarker}\n+unexpected write\n*** End Patch\n` }
    : n < 2
    ? { id: `fc_${n}`, type: "function_call", call_id: `call_${n}`, name: n === 0 ? "exec_command" : "mcp__fixture__write", arguments: JSON.stringify({ cmd: `touch ${marker}` }) }
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
      `notify=${JSON.stringify([process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(notifyMarker)},process.argv.at(-1))`])}`,
      'sandbox_mode="workspace-write"', '[sandbox_workspace_write]', 'network_access=true',
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
    assert.equal(requests.length, 5, "hostile shell, MCP and inside/outside patch replies were processed before completion");
    for (const request of requests) {
      assert.equal(request.model, model, "adapter changed the selected model");
      assert.ok((request.tools ?? []).every(t => ["request_user_input", "apply_patch"].includes(t.name)), "preparation exposed an unrestricted tool");
    }
    const outcome = adapterFor("codex").outcome(output.trim().split("\n"));
    assert.equal(outcome.ok, true, output); assert.equal(outcome.lastMessage, "prepared");
    observations.push({ model, requests: requests.length, tools: (requests[0].tools ?? []).map(t => t.name), hostileToolCallsRejected: 4, notifierDisabled: true, output: outcome.lastMessage });
  }
  const refusedOverrides = [];
  for (const override of ['sandbox_mode="workspace-write"', 'features.shell_tool=true', 'permissions.gallivant_preparation.filesystem.":root"="write"', `notify=${JSON.stringify([process.execPath, "-e", "process.exit(1)"])}`]) {
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
  console.log(JSON.stringify({ nativeVersion: spawnSync(bin, ["--version"], { encoding: "utf8", env }).stdout.trim(), provider: "loopback fixture; no inference", observations, refusedOverrides }, null, 2));
} finally { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); }
