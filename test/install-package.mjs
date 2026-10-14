// Exercise the actual npm tarball outside its source checkout. No account,
// model call, daemon or user settings are used by this installation check.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const source = fileURLToPath(new URL("..", import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), "install-consumer-")));
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], ...options });
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: source }))[0];
  assert.equal(packed.name, "gallivant");
  for (const f of packed.files) assert.ok(!/(^|\/)(?:\.env[^/]*|\.git|\.npmrc|test|audit)(?:\/|$)/.test(f.path), `private/test payload: ${f.path}`);
  const consumer = join(root, "consumer"), prefix = join(root, "prefix"), bin = join(root, "fixtures"), home = join(root, "home"), repo = join(root, "repo");
  for (const dir of [consumer, bin, home, repo]) mkdirSync(dir, { mode: 0o700 });
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], { cwd: consumer });
  const installed = join(prefix, "node_modules/gallivant"), cli = join(installed, "bin/gallivant.mjs");
  for (const [command, output] of [["codex", "fixture"], ["gh", '{"login":"fixture-user"}']]) writeFileSync(join(bin, command), `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, { mode: 0o700 });
  const env = { ...process.env, GALLIVANT_HOME: home, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
  const command = (...args) => run(process.execPath, [cli, ...args], { cwd: repo, env });
  assert.equal(command("--version").trim(), packed.version);
  assert.match(command("--help"), /--no-server/);
  assert.match(command("init", "--harness", "codex", "--worktrees", join(root, "worktrees")), /Created/);
  const config = JSON.parse(readFileSync(join(home, "config.json")));
  assert.deepEqual(config.trusted_authors, ["fixture-user"]);
  run("git", ["init", "-q"], { cwd: repo });
  assert.match(command("new", "first-task"), /docs\/prds\/first-task.md/);
  // A new brief is deliberately a draft with instructions to replace. Verify
  // that its packaged template loads, then check a complete offline fixture.
  const { GOOD_PRD } = await import("./helpers.mjs");
  writeFileSync(join(repo, "docs/prds/first-task.md"), GOOD_PRD);
  assert.match(command("ready", "docs/prds/first-task.md", "--check"), /ok/);
  assert.match(command("start", "--no-daemon", "--no-server"), /startup skipped/);
  // Every declared export must load from this installation, including optional
  // MCP integration (installed explicitly for this consumer check).
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "@modelcontextprotocol/sdk@1.32.1"], { cwd: consumer });
  const pkg = JSON.parse(readFileSync(join(installed, "package.json")));
  for (const [name, path] of Object.entries(pkg.exports)) {
    if (name.includes("*") || path.endsWith(".json")) continue;
    run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(installed, path))})`], { cwd: consumer, env });
  }
  console.log(`Installed ${packed.name}@${packed.version}: version, help, init, packaged PRD, validation and all module exports passed.`);
} finally { rmSync(root, { recursive: true, force: true }); }
