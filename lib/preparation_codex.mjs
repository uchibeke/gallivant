// Preparation is a restricted inference turn through the ordinary Codex runner.
// Keep model/provider/auth settings. Do not reuse implementation's approvals or
// tools, and do not assume an empty TOML table replaces inherited MCP entries.
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, realpathSync, lstatSync, rmSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";

const SETTINGS = {
  approval_policy: "never", approvals_reviewer: "user", web_search: "disabled", notify: [],
  default_permissions: "gallivant_preparation",
  "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
  "features.hooks": false, "features.shell_tool": false, "features.unified_exec": false,
  "features.shell_snapshot": false, "features.browser_use": false,
  "features.browser_use_external": false, "features.in_app_browser": false,
  "features.computer_use": false, "features.multi_agent": false,
  // V2 can be selected by model metadata or an explicit feature override.
  // Disabling V1 alone does not prevent either route to agent delegation.
  "agents.enabled": false, "features.multi_agent_v2": false,
  "features.image_generation": false, "features.view_image": false,
  "features.goals": false, "features.code_mode": false, "features.code_mode_host": false,
  "features.token_budget": false, "features.request_permissions_tool": false,
  "features.skip_host_skill_discovery": true, "features.skill_search": false,
  "features.skill_mcp_dependency_install": false, project_doc_max_bytes: 0,
  "skills.include_instructions": false, "skills.bundled.enabled": false,
  "cloud.skills.enabled": false, "features.memories": false,
  "features.external_agent_memory_import": false,
  "memories.generate_memories": false, "memories.use_memories": false,
  // Native telemetry is outside the model-tool sandbox, just like notify.
  "analytics.enabled": false, "feedback.enabled": false,
  "otel.exporter": "none", "otel.trace_exporter": "none", "otel.metrics_exporter": "none",
  "otel.log_user_prompt": false, "otel.log_agent_responses": false,
};
export const codexPreparationSettings = Object.freeze(Object.entries(SETTINGS).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]));
const PROFILE = ["-c", 'permissions.gallivant_preparation.filesystem={":minimal"="read"}', "-c", "permissions.gallivant_preparation.network.enabled=false"];
// Native context loading and state writes happen outside model-tool sandbox
// enforcement. Keep intake context explicit and state in the private home.
const PRIVATE_ONLY_FIELDS = [
  "instructions", "developer_instructions", "compact_prompt",
  "model_instructions_file", "experimental_compact_prompt_file",
  "sqlite_home", "log_dir",
];
const fail = detail => Object.assign(new Error(`Codex preparation configuration could not be isolated: ${detail}; no drafting call was made`), { code: "TASK_PREPARATION_BOUNDARY" });
const inspect = (cmd, args, options) => new Promise((resolve, reject) => {
  execFile(cmd, args, { ...options, encoding: "utf8", timeout: 20_000, maxBuffer: 1_048_576 }, (error, stdout) => {
    // Never relay native configuration or stderr; either can contain credentials.
    if (error) reject(fail("the configured binary could not list its MCP configuration"));
    else resolve(stdout);
  });
});

// Read the native merged config, including system/MDM managed layers which can
// outrank -c. This starts no thread/turn and never sends the intake prompt.
// Bound and discard all diagnostics: config results can contain credentials.
function effectiveConfig(spec, { cwd, env, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(fail("configuration inspection was cancelled")); return; }
    const overrides = [];
    for (let i = 0; i < spec.args.length - 1; i++) {
      if (spec.args[i] === "-c") overrides.push(spec.args[i], spec.args[++i]);
    }
    const child = spawn(spec.cmd, ["app-server", "--stdio", "--strict-config", ...overrides], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", bytes = 0, initialized = false, settled = false, config;
    const finish = (error, config) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.kill("SIGKILL"); child.stdin.destroy();
      if (error) reject(error); else resolve(config);
    };
    const invalid = () => finish(fail("effective configuration could not be verified; check managed Codex policy and the supported CLI version"));
    const abort = () => finish(fail("configuration inspection was cancelled"));
    const timer = setTimeout(invalid, 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", invalid); child.on("exit", invalid); child.stdin.on("error", invalid);
    child.stderr.on("data", chunk => { bytes += chunk.length; if (bytes > 1_048_576) invalid(); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk); if (bytes > 1_048_576) { invalid(); return; }
      buffer += chunk;
      let end;
      while (!settled && (end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { invalid(); return; }
        if (!message || typeof message !== "object" || message.error) { invalid(); return; }
        if (message.id === 1 && !initialized && message.result) {
          initialized = true;
          send({ method: "initialized" });
          send({ id: 2, method: "config/read", params: { cwd, includeLayers: true } });
        } else if (message.id === 2 && initialized && !config && message.result?.config && Array.isArray(message.result.layers)) {
          config = message.result.config;
          // Additional managed developer instructions are requirements-owned;
          // they are not represented in config/read's merged ConfigToml.
          send({ id: 3, method: "configRequirements/read" });
        } else if (message.id === 3 && config && Object.hasOwn(message.result ?? {}, "requirements")) {
          const requirements = message.result.requirements;
          if (requirements !== null && (typeof requirements !== "object" || Array.isArray(requirements))) { invalid(); return; }
          finish(null, { config, requirements });
        } else if (message.id !== undefined) { invalid(); return; }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "gallivant_preparation", version: "1" } } });
  });
}

function verifyEffectiveConfig({ config, requirements }) {
  const incompatible = () => { throw fail("effective Codex settings conflict with restricted drafting; use an administrator-approved compatible configuration"); };
  for (const [key, expected] of Object.entries(SETTINGS)) {
    const actual = key.split(".").reduce((value, part) => value?.[part], config);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) incompatible();
  }
  // Legacy sandbox keys win over named profiles, even when they say read-only
  // (that legacy mode grants broad reads). Profiles can also inherit grants.
  if (config.sandbox_mode != null || config.sandbox_workspace_write != null || config.profile != null) incompatible();
  if (PRIVATE_ONLY_FIELDS.some(key => config[key] != null)) incompatible();
  if (requirements?.additionalDeveloperInstructions != null) incompatible();
  // These constraints can cause native runtime fallbacks after config/read.
  // Verify our chosen values are allowed, not just present in the raw config.
  for (const [key, value] of [["allowedApprovalPolicies", "never"], ["allowedSandboxModes", "read-only"], ["allowedWebSearchModes", "disabled"]]) {
    const allowed = requirements?.[key];
    if (allowed != null && (!Array.isArray(allowed) || !allowed.includes(value))) incompatible();
  }
  if (requirements?.allowedPermissionProfiles != null && requirements.allowedPermissionProfiles.gallivant_preparation !== true) incompatible();
  // Feature requirements are applied after the raw config is read. Do not let
  // managed policy silently reinstate a disabled native capability.
  const features = requirements?.featureRequirements;
  if (features != null && (typeof features !== "object" || Array.isArray(features))) incompatible();
  for (const [key, required] of Object.entries(features ?? {})) {
    if (typeof required !== "boolean") incompatible();
    if (Object.hasOwn(SETTINGS, `features.${key}`) && required !== SETTINGS[`features.${key}`]) incompatible();
  }
  const profile = config.permissions?.gallivant_preparation;
  if (!profile || profile.extends != null || profile.workspace_roots != null) incompatible();
  const present = object => Object.entries(object ?? {}).filter(([, value]) => value != null);
  const filesystem = present(profile.filesystem), network = present(profile.network);
  if (filesystem.length !== 1 || filesystem[0][0] !== ":minimal" || filesystem[0][1] !== "read") incompatible();
  if (network.length !== 1 || network[0][0] !== "enabled" || network[0][1] !== false) incompatible();
  if (!config.mcp_servers || typeof config.mcp_servers !== "object" || Array.isArray(config.mcp_servers)) incompatible();
  if (Object.values(config.mcp_servers).some(server => server?.enabled !== false)) incompatible();
}

export const codexPreparation = Object.freeze({
  version: 1,
  authority: "sandboxed-draft",
  boundary: "codex-draft-sandbox-v1",
  minimumVersion: "0.160.0",
  render(spec) {
    const args = [];
    // Legacy sandbox keys take precedence over permission profiles even when
    // default_permissions was supplied later. Drop implementation's keys here.
    for (let i = 0; i < spec.args.length - 1; i++) {
      if (spec.args[i] === "-c" && /^(sandbox_mode|sandbox_workspace_write\.)/.test(spec.args[i + 1])) { i++; continue; }
      args.push(spec.args[i]);
    }
    return [...args, "--strict-config", ...codexPreparationSettings, ...PROFILE, spec.args.at(-1)];
  },
  async configure(spec, { cwd, env, signal }) {
    // Only the task-private snapshot is edited. A TOML parser preserves model,
    // provider and authentication values; text matching would mis-handle tables
    // and multiline strings. Never rewrite operator or managed policy files.
    if (typeof env.CODEX_HOME !== "string") throw fail("the task-private Codex home is missing");
    const child = relative(realpathSync(cwd), realpathSync(env.CODEX_HOME));
    if (isAbsolute(child) || child.split(sep).includes("..")) throw fail("the Codex home is outside the preparation workspace");
    // Global AGENTS files ignore project_doc_max_bytes. The snapshot does not
    // copy them, but remove stale private-home entries on retries as well.
    // Unlink a file/symlink only; never follow it or recursively remove a folder.
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      try { rmSync(join(env.CODEX_HOME, name), { force: true }); }
      catch { throw fail("the private Codex home contains an unsupported instruction entry"); }
    }
    const configPath = join(env.CODEX_HOME, "config.toml");
    if (existsSync(configPath)) {
      const { parse, stringify } = await import("smol-toml");
      if (!lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink()) throw fail("the private configuration is not a regular file");
      let config;
      try { config = parse(readFileSync(configPath, "utf8")); } catch { throw fail("the private provider configuration is invalid TOML"); }
      if (config.profile) throw fail("a named Codex config profile requires an explicit isolated profile snapshot");
      delete config.sandbox_mode; delete config.sandbox_workspace_write;
      // Legacy notify spawns outside the tool sandbox independently of hooks.
      delete config.notify;
      for (const key of PRIVATE_ONLY_FIELDS) delete config[key];
      // Discard exporter tables before applying scalar "none" overrides.
      delete config.otel;
      // A fresh profile name must not inherit wider per-user grants.
      if (config.permissions) delete config.permissions.gallivant_preparation;
      writeFileSync(configPath, stringify(config), { mode: 0o600 });
    }
    const text = await inspect(spec.cmd, ["mcp", "list", "--json", ...codexPreparationSettings, ...PROFILE], { cwd, env, signal });
    let servers;
    try { servers = JSON.parse(text); } catch { throw fail("MCP configuration discovery returned invalid JSON"); }
    if (!Array.isArray(servers) || servers.length > 128) throw fail("MCP configuration discovery returned an unsupported server list");
    const names = new Set();
    for (const server of servers) {
      // Codex's dotted CLI-key parser does not unquote JSON/TOML key fragments.
      // Refuse ambiguous names rather than silently disabling a different key.
      if (!server || typeof server.name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(server.name) || names.has(server.name)) {
        throw fail("an MCP server name cannot be addressed unambiguously by this binary");
      }
      names.add(server.name);
    }
    const configured = { ...spec, args: [
      ...spec.args.slice(0, -1),
      ...[...names].sort().flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]),
      spec.args.at(-1),
    ] };
    verifyEffectiveConfig(await effectiveConfig(configured, { cwd, env, signal }));
    return configured;
  },
});
