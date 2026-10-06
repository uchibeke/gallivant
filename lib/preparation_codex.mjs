// Preparation is a restricted inference turn through the ordinary Codex runner.
// Keep model/provider/auth settings. Do not reuse implementation's approvals or
// tools, and do not assume an empty TOML table replaces inherited MCP entries.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";

const SETTINGS = {
  approval_policy: "never", web_search: "disabled",
  default_permissions: "gallivant_preparation",
  "features.apps": false, "features.plugins": false, "features.remote_plugin": false,
  "features.hooks": false, "features.shell_tool": false, "features.unified_exec": false,
  "features.shell_snapshot": false, "features.browser_use": false,
  "features.browser_use_external": false, "features.in_app_browser": false,
  "features.computer_use": false, "features.multi_agent": false,
  "features.image_generation": false, "features.view_image": false,
  "features.goals": false, "features.code_mode": false, "features.code_mode_host": false,
  "features.skip_host_skill_discovery": true, "features.skill_search": false,
  "features.skill_mcp_dependency_install": false, project_doc_max_bytes: 0,
};
export const codexPreparationSettings = Object.freeze(Object.entries(SETTINGS).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]));
const PROFILE = ["-c", 'permissions.gallivant_preparation.filesystem={":minimal"="read"}', "-c", "permissions.gallivant_preparation.network.enabled=false"];
const fail = detail => Object.assign(new Error(`Codex preparation configuration could not be isolated: ${detail}; no drafting call was made`), { code: "TASK_PREPARATION_BOUNDARY" });
const inspect = (cmd, args, options) => new Promise((resolve, reject) => {
  execFile(cmd, args, { ...options, encoding: "utf8", timeout: 20_000, maxBuffer: 1_048_576 }, (error, stdout) => {
    // Never relay native configuration or stderr; either can contain credentials.
    if (error) reject(fail("the configured binary could not list its MCP configuration"));
    else resolve(stdout);
  });
});

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
    const configPath = join(env.CODEX_HOME, "config.toml");
    if (existsSync(configPath)) {
      const { parse, stringify } = await import("smol-toml");
      if (!lstatSync(configPath).isFile() || lstatSync(configPath).isSymbolicLink()) throw fail("the private configuration is not a regular file");
      let config;
      try { config = parse(readFileSync(configPath, "utf8")); } catch { throw fail("the private provider configuration is invalid TOML"); }
      if (config.profile) throw fail("a named Codex config profile requires an explicit isolated profile snapshot");
      delete config.sandbox_mode; delete config.sandbox_workspace_write;
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
    return { ...spec, args: [
      ...spec.args.slice(0, -1),
      ...[...names].sort().flatMap(name => ["-c", `mcp_servers.${name}.enabled=false`]),
      spec.args.at(-1),
    ] };
  },
});
