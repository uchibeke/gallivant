// Exercise the actual npm tarball outside its source checkout, including the README fast path run through `npx`.
// No account, model call, daemon or user settings are used: HOME, the Gallivant home and the npm cache all point
// into one disposable root, and the only `gh` and `codex` on PATH are fixtures that answer the probes doctor makes.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const source = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const root = realpathSync(mkdtempSync(join(tmpdir(), "install-consumer-")));
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"], ...options });
const mode = p => statSync(p).mode & 0o777;
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: source }))[0];
  assert.equal(packed.name, "@uchibeke/gallivant");
  for (const f of packed.files) assert.ok(!/(^|\/)(?:\.env[^/]*|\.git|\.npmrc|test|audit|prds|plans|design)(?:\/|$)/.test(f.path), `private/test payload: ${f.path}`);
  assert.ok(packed.files.some(f => f.path === "README.md"), "README is packaged");
  const tarball = join(root, packed.filename);
  const consumer = join(root, "consumer"), prefix = join(root, "prefix"), bin = join(root, "fixtures"), home = join(root, "home-dir"),
    ghome = join(root, "gallivant-home"), repo = join(root, "repo"), cache = join(root, "npm-cache");
  for (const dir of [consumer, bin, home, repo, cache]) mkdirSync(dir, { mode: 0o700 });

  // Fixture CLIs. `codex` answers the version and sign-in probes; `gh` answers the login, token, permission, default
  // branch and ruleset reads doctor makes. Neither holds or asks for a real credential.
  writeFileSync(join(bin, "codex"), `#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.160.0";; *) echo "Logged in using ChatGPT";; esac\n`, { mode: 0o700 });
  writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "api user --jq {login: .login}") echo '{"login":"fixture-user"}';;
  "auth token") echo 'fixture-token';;
  "api user -i") printf 'HTTP/2.0 200 OK\\nx-oauth-scopes: repo\\n\\n{}\\n';;
  api\\ repos/*/rulesets*) echo '[]';;
  api\\ repos/*\\ --jq\\ *push*) echo '{"push":true,"admin":true,"archived":false}';;
  repo\\ view*) echo '{"defaultBranchRef":{"name":"main"}}';;
  *) echo '{}';;
esac
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, GALLIVANT_HOME: ghome, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, npm_config_cache: cache, NPM_CONFIG_CACHE: cache };

  // The README fast path, word for word except that the package spec is this tarball rather than the registry name, so
  // the revision under test is what runs and not whatever is published. `npx` resolves the `gallivant` bin itself.
  const npx = (cwd, ...args) => spawnSync("npx", ["--yes", `--package=${tarball}`, "gallivant", ...args], { cwd, env, encoding: "utf8", timeout: 300_000 });
  const version = npx(consumer, "--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), packed.version);

  // Not a repository: the prerequisite is named and no Gallivant state appears anywhere.
  const plain = npx(consumer, "init", "--harness", "codex");
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /not inside a Git checkout[\s\S]*nothing was written/);
  assert.equal(existsSync(ghome), false);

  run("git", ["init", "-q"], { cwd: repo });
  run("git", ["remote", "add", "origin", "https://github.com/uchibeke/gallivant.git"], { cwd: repo });
  const first = npx(repo, "init", "--harness", "codex");
  // Doctor has open items on a fresh machine (no APort hook, no ruleset), and init's exit code is doctor's.
  assert.equal(first.status, 1, first.stderr);
  const out = first.stdout;
  assert.match(out, new RegExp(`Package:\\s+@uchibeke/gallivant ${packed.version.replace(/\\./g, "\\.")} \\(run by npx\\)`));
  const running = out.match(/^Running:\s+(\S+)$/m)?.[1];
  assert.ok(running && running.startsWith(cache) && /[\\/]_npx[\\/]/.test(running) && running.endsWith("bin/gallivant.mjs"), `selected binary from the npx cache: ${running}`);
  assert.ok(!running.startsWith(source), "the source checkout was not what ran");
  assert.match(out, /Config:\s+\S+ \(created, mode 600\)/);
  assert.match(out, /Repository: uchibeke\/gallivant \(recorded in repos\)/);
  for (const line of [/^ok {3}config/m, /^ok {3}gh auth\s+fixture-user/m, /^ok {3}run credential/m, /^ok {3}push rights uchibeke\/gallivant/m, /^ok {3}codex binary/m, /^ok {3}codex sign-in/m, /^FAIL codex hook/m, /^FAIL ruleset uchibeke\/gallivant/m, /fix: gh api -X POST repos\/uchibeke\/gallivant\/rulesets/]) assert.match(out, line);
  assert.match(out, /Fix the \d+ failing check\(s\) above, then run:\s+npx --yes @uchibeke\/gallivant doctor/);
  assert.match(out, /npx ran @uchibeke\/gallivant on demand from npm's cache\. Nothing was installed globally/);
  assert.match(out, /Optional persistent install:\s+npm install -g @uchibeke\/gallivant/);
  assert.match(out, /npx --yes @uchibeke\/gallivant task "Document how to run the existing tests[^\n]*--harness codex/);
  assert.match(out, /did not create a GitHub ruleset, install harness hooks, start a task or merge anything/);
  assert.equal(mode(ghome), 0o700);
  assert.equal(mode(join(ghome, "config.json")), 0o600);
  const config = JSON.parse(readFileSync(join(ghome, "config.json"), "utf8"));
  assert.deepEqual(config.trusted_authors, ["fixture-user"]);
  assert.deepEqual(config.repos, ["uchibeke/gallivant"]);
  assert.deepEqual(config.harness, { codex: { bin: join(bin, "codex") } });
  assert.equal(config.github_token_file, null);
  assert.equal(mode(config.worktrees), 0o700);
  assert.ok(!config.worktrees.startsWith(ghome));
  // The developer's home is untouched: no control-plane directories, no credentials, nothing of Gallivant's.
  assert.deepEqual(readdirSync(home).filter(n => /^\.(?:gallivant|codex|claude|config|aport|gitconfig|git-credentials)/.test(n)), []);

  // Repeat safety: same bytes, one repos entry, the report runs again.
  const bytes = readFileSync(join(ghome, "config.json"), "utf8");
  const again = npx(repo, "init", "--harness", "codex");
  assert.equal(again.status, 1, again.stderr);
  assert.match(again.stdout, /Config:\s+\S+ \(unchanged\)/);
  assert.match(again.stdout, /Repository: uchibeke\/gallivant \(already in repos; not duplicated\)/);
  assert.equal(readFileSync(join(ghome, "config.json"), "utf8"), bytes);

  // The same tarball installed as a dependency: help, a packaged brief template, offline validation and every export.
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumer, env });
  const installed = join(prefix, "node_modules/@uchibeke/gallivant"), cli = join(installed, "bin/gallivant.mjs");
  const command = (...args) => run(process.execPath, [cli, ...args], { cwd: repo, env });
  assert.equal(command("--version").trim(), packed.version);
  assert.match(command("--help"), /--no-server/);
  assert.match(command("--help"), /gallivant init/);
  assert.match(command("new", "first-task"), /docs\/prds\/first-task.md/);
  // A new brief is deliberately a draft with instructions to replace. Verify
  // that its packaged template loads, then check a complete offline fixture.
  const { GOOD_PRD } = await import("./helpers.mjs");
  writeFileSync(join(repo, "docs/prds/first-task.md"), GOOD_PRD);
  assert.match(command("ready", "docs/prds/first-task.md", "--check"), /ok/);
  assert.match(command("start", "--no-daemon", "--no-server"), /startup skipped/);
  // Every declared export must load from this installation, including optional
  // MCP integration (installed explicitly for this consumer check).
  run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "@modelcontextprotocol/sdk@1.32.1"], { cwd: consumer, env });
  const pkg = JSON.parse(readFileSync(join(installed, "package.json")));
  for (const [name, path] of Object.entries(pkg.exports)) {
    if (name.includes("*") || path.endsWith(".json")) continue;
    run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(installed, path))})`], { cwd: consumer, env });
  }
  console.log(`Installed ${packed.name}@${packed.version}: npx fast path (binary, config permissions, repository registration, repeat safety, next steps), version, help, packaged PRD, validation and all module exports passed.`);
} finally { rmSync(root, { recursive: true, force: true }); }
