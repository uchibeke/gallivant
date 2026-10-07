// Native app-server protocol fixture. Kept independent of the production
// settings so a removed restriction cannot make its own regression test pass.
import { createInterface } from "node:readline";

export const restrictedCodexConfig = () => ({
  approval_policy: "never", web_search: "disabled", notify: [],
  default_permissions: "gallivant_preparation", project_doc_max_bytes: 0,
  agents: { enabled: false },
  features: {
    apps: false, plugins: false, remote_plugin: false, hooks: false,
    shell_tool: false, unified_exec: false, shell_snapshot: false,
    browser_use: false, browser_use_external: false, in_app_browser: false,
    computer_use: false, multi_agent: false, multi_agent_v2: false, image_generation: false,
    view_image: false, goals: false, code_mode: false, code_mode_host: false,
    skip_host_skill_discovery: true, skill_search: false, skill_mcp_dependency_install: false,
  },
  permissions: { gallivant_preparation: { filesystem: { ":minimal": "read" }, network: { enabled: false } } },
  mcp_servers: {},
});

export function serveCodexConfig(config = restrictedCodexConfig()) {
  const input = createInterface({ input: process.stdin });
  input.on("line", line => {
    const request = JSON.parse(line);
    if (request.method === "initialize") console.log(JSON.stringify({ id: request.id, result: { userAgent: "fixture" } }));
    else if (request.method === "config/read") console.log(JSON.stringify({ id: request.id, result: { config, layers: [] } }));
    else if (request.method !== "initialized") process.exit(1);
  });
}
