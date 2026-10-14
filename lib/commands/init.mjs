import { mkdirSync, openSync, closeSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { gallivantHome, expand, templatePath } from "../fs.mjs";
import { discoverHarnesses, validate, merge } from "../config.mjs";
import { makeGh } from "../gh.mjs";
import { silentLog } from "../log.mjs";

// Explicit setup only; never rewrite an existing config or touch global harness
// settings, credentials or repository permissions.
export async function init({ home = gallivantHome(), harness = "codex", login, worktrees,
  discover = discoverHarnesses, user = () => makeGh({ log: silentLog }).user() } = {}) {
  if (!["codex", "claude"].includes(harness)) throw new Error("init supports --harness codex or claude; configure other adapters explicitly after checking docs/install.md");
  home = expand(home);
  const file = join(home, "config.json");
  if (existsSync(file)) throw new Error(`Config already exists at ${file}; edit it or run gallivant doctor. Nothing was overwritten.`);
  for (let dir = home; ; dir = dirname(dir)) {
    if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) throw new Error(`Setup directory must not be a symlink: ${dir}`);
    if (dirname(dir) === dir) break;
  }
  const selected = discover(home)[harness];
  if (!selected) throw new Error(`${harness} is not on PATH. Install it and sign in, then retry gallivant init --harness ${harness}`);
  const ownLogin = login || await user();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(ownLogin || "")) throw new Error("Sign in with gh auth login before running init");
  const config = { trusted_authors: [ownLogin], worktrees: expand(worktrees || join(dirname(home), ".gallivant-worktrees")),
    harness: { [harness]: selected }, notify: null, github_token_file: null, repos: [] };
  const problems = validate(merge(config, home), home);
  if (problems.length) throw new Error(problems.join("; "));
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(config.worktrees, { recursive: true, mode: 0o700 });
  // wx also refuses a dangling symlink and protects concurrent invocations.
  const fd = openSync(file, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(config, null, 2) + "\n"); } finally { closeSync(fd); }
  return { file, harness, config, templates: { passport: templatePath("passport.gallivant.json"), sandbox: templatePath("claude-settings.json") } };
}
