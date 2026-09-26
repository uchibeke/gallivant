// Config: one JSON file the operator writes by hand, validated here so every other module can trust its shape.
//
// Defaults hold nothing machine-specific. Anything that identifies the operator (trusted logins, token file,
// binaries) has to be written explicitly, which is what `doctor` walks you through.
import { join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { expand, readJson, writeJsonAtomic, gallivantHome, isDir } from "./fs.mjs";

export const HARNESSES = ["claude", "codex", "gemini", "opencode", "goose"];

// Where a harness binary is, asked of a login shell so a version manager's PATH is the one that answers. Memoised
// per process: a login shell per lookup is slow, and the answer cannot change while the daemon runs.
const found = new Map();
export const whence = name => {
  if (!found.has(name)) {
    try { found.set(name, execFileSync("zsh", ["-lc", `whence -p ${name}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null); }
    catch { found.set(name, null); }
  }
  return found.get(name);
};

/**
 * The harnesses installed on this machine, in the shape `config.harness` takes. Used when the operator names none,
 * so a fresh install works with whichever of the two they happen to have. Naming one explicitly in the config
 * turns discovery off for that install, which is what an operator wants when two versions are on the PATH or when
 * a harness is deliberately not in play.
 */
export function discoverHarnesses(home = gallivantHome()) {
  const out = {};
  for (const name of HARNESSES) {
    const bin = whence(name);
    if (!bin) continue;
    // Only Claude takes a settings file; the other four are configured by flags and env in the adapter.
    out[name] = name === "claude" ? { bin, settings: join(home, "claude", "settings.json") } : { bin };
  }
  return out;
}

/** Limits for the completion gate, in the shape of APort's deliverable.task.complete passport limits. */
export const DEFAULT_DELIVERABLE = Object.freeze({
  evaluator: "aport",                 // "aport": confirm with APort's hosted evaluator; "local": the built-in rules only
  api_url: "https://api.aport.io",
  on_unreachable: "wait",             // "wait": no decision until APort answers (the daemon retries next tick); "local": the built-in verdict stands
  require_summary: true,
  min_summary_words: 20,
  require_tests_passing: true,
  scan_output: true,
  blocked_patterns: ["TODO", "FIXME", "XXX", "console.log(", "debugger;", "lorem ipsum"],
});

export const DEFAULTS = Object.freeze({
  deliverable: DEFAULT_DELIVERABLE,
  poll_seconds: 120,
  max_iterations: 3,
  checks_grace_minutes: 5,            // a head younger than this with no checks yet is not "green", it is "not reported yet"
  run_timeout_minutes: 30,
  max_budget_usd: 5,
  rereview_minutes: 6,
  stall_hours: 6,
  trusted_authors: [],
  reviewer: {
    login: "chatgpt-codex-connector[bot]",
    rereview_comment: "@codex review",
    blocking_pattern: "\\bP[01]\\b",
  },
  notify: null,
  worktrees: null,
  github_token_file: null,
  harness: {},
  context_paths: [],
  repos: [],
});

export const configPath = (home = gallivantHome()) => join(home, "config.json");

/** True when `child` is inside `parent` (or equal), by path segments, not by string prefix. */
export const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * Directories a run may READ beyond its own checkout, validated. `label` names where the list came from, so a bad
 * entry in a PRD's frontmatter does not read as a config problem.
 *
 * The refusals are the point. A run that can read the Gallivant home or `~/.claude` can read the settings file that
 * bounds it and the APort passport that audits it; a run that can read `$HOME` can read every credential on the
 * machine. Neither is a theoretical loss: whatever the agent reads can leave in a commit, a PR body or a log.
 * A parent of any of those directories is refused for the same reason a child would be pointless to refuse.
 */
export function validateContextPaths(list, home = gallivantHome(), label = "context_paths") {
  const problems = [];
  if (list === undefined || list === null) return problems;    // absent means none, as every optional key does
  if (!Array.isArray(list)) return [`${label} must be an array of directory paths`];
  const forbidden = [
    [home, "the Gallivant home"],
    [expand("~/.claude"), "~/.claude"],
    [expand("~/.codex"), "~/.codex"],
    [expand("~/.config/opencode"), "~/.config/opencode"],
    [expand("~/.aport"), "~/.aport"],
  ];
  for (const raw of list) {
    if (typeof raw !== "string" || !raw.trim()) { problems.push(`${label} entries must be non-empty strings`); continue; }
    // `expand` resolves a relative path against the process cwd, which for a daemon is whatever directory it was
    // launched from. So the absolute check runs on what the operator WROTE: only `/` and `~` are accepted, and
    // "./docs" is refused by name rather than quietly meaning something different on the next boot.
    if (!isAbsolute(raw) && !raw.startsWith("~")) { problems.push(`${label}: "${raw}" is not an absolute path`); continue; }
    const p = expand(raw);
    if (p === homedir()) { problems.push(`${label}: "${raw}" is your home directory; name the one directory the run needs, not everything you own`); continue; }
    const hit = forbidden.find(([dir]) => isInside(dir, p));
    if (hit) { problems.push(`${label}: "${raw}" contains ${hit[1]}, which holds the settings and passport that bound the run`); continue; }
    if (!isDir(p)) { problems.push(`${label}: "${raw}" does not exist (looked for ${p})`); continue; }
  }
  return problems;
}

/**
 * The one place the two lists are merged: the operator's config list plus whatever this brief's own frontmatter
 * adds. `tick` and `start` both call this rather than merging for themselves.
 *
 * The PRD's `context_paths:` key is read from the daemon's snapshot, taken when the run started, never from the
 * agent-writable checkout. A session cannot widen its own reads by editing the PRD it was given.
 */
export function resolveContextPaths(config, prd = null, home = config?.home) {
  const own = Array.isArray(config?.context_paths) ? config.context_paths : [];
  // The config list was validated by `load`. A brief's own list was validated by `start`, but an entry recovered
  // from GitHub by `up` never passed through `start`, and a directory that existed then may be gone now. So each
  // frontmatter entry is checked again here and a bad one is dropped rather than handed to a harness: a stale path
  // must not silently become a grant, and it must not fail a fix round either.
  const extra = parseContextPathsMeta(prd?.meta?.context_paths)
    .filter(p => validateContextPaths([p], home ?? gallivantHome()).length === 0);
  const seen = new Set();
  return [...own, ...extra].map(p => expand(p)).filter(p => !seen.has(p) && seen.add(p));
}

/** A frontmatter `context_paths:` value as a list. Comma-separated or a `[a, b]` literal; anything else is empty. */
export function parseContextPathsMeta(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  return value.replace(/^\[|\]$/g, "").split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

/** Raw file contents merged with defaults, the one way both `load` and `doctor` build the object they validate. */
export function merge(raw, home = gallivantHome()) {
  // No harness named: use whatever is installed. An empty object still means "none found", which validate refuses
  // with the install instruction rather than a path the operator has to write by hand.
  const harness = raw.harness && Object.keys(raw.harness).length ? raw.harness : discoverHarnesses(home);
  return {
    ...DEFAULTS, ...raw, harness,
    deliverable: raw.deliverable === undefined ? DEFAULTS.deliverable : raw.deliverable === null ? null : { ...DEFAULTS.deliverable, ...raw.deliverable },
  };
}

/** Problems as human sentences; empty means valid. Used by `load` (throws) and by `doctor` (prints). */
export function validate(cfg, home = gallivantHome()) {
  const problems = [];
  const num = (k, min) => { if (typeof cfg[k] !== "number" || cfg[k] < min) problems.push(`${k} must be a number >= ${min}`); };
  num("poll_seconds", 30); num("max_iterations", 1); num("run_timeout_minutes", 1); num("max_budget_usd", 0);
  num("rereview_minutes", 1); num("stall_hours", 1); num("checks_grace_minutes", 0);
  if (!Array.isArray(cfg.trusted_authors) || cfg.trusted_authors.length === 0) problems.push("trusted_authors must list at least one GitHub login");
  if (cfg.reviewer !== null) {
    for (const k of ["login", "rereview_comment", "blocking_pattern"]) if (typeof cfg.reviewer?.[k] !== "string") problems.push(`reviewer.${k} must be a string (or set reviewer to null)`);
    if (typeof cfg.reviewer?.blocking_pattern === "string") { try { new RegExp(cfg.reviewer.blocking_pattern); } catch { problems.push("reviewer.blocking_pattern is not a valid regex"); } }
  }
  if (cfg.notify !== null && typeof cfg.notify?.ntfy !== "string") problems.push("notify.ntfy must be a URL (or set notify to null)");
  if (cfg.deliverable !== null && (typeof cfg.deliverable !== "object" || Array.isArray(cfg.deliverable))) problems.push("deliverable must be an object of limits (or null to disable the completion gate)");
  else if (cfg.deliverable && !["aport", "local"].includes(cfg.deliverable.evaluator)) problems.push('deliverable.evaluator must be "aport" or "local"');
  else if (cfg.deliverable && !["wait", "local"].includes(cfg.deliverable.on_unreachable)) problems.push('deliverable.on_unreachable must be "wait" or "local"');
  if (!cfg.worktrees) problems.push("worktrees must be a directory path outside the Gallivant home");
  else if (isInside(expand(cfg.worktrees), home)) problems.push("worktrees must not be under the Gallivant home directory");
  problems.push(...validateContextPaths(cfg.context_paths, home));
  const names = Object.keys(cfg.harness || {});
  if (names.length === 0) problems.push(`no harness configured and none found on PATH. Install one of them, or set harness.<name>.bin explicitly. Looked for: ${HARNESSES.join(", ")}`);
  for (const n of names) {
    if (!HARNESSES.includes(n)) problems.push(`harness.${n} is not a known harness (${HARNESSES.join(", ")})`);
    else if (typeof cfg.harness[n]?.bin !== "string") problems.push(`harness.${n}.bin must be an absolute path`);
    if (n === "claude" && typeof cfg.harness[n]?.settings !== "string") problems.push("harness.claude.settings must point at the Gallivant Claude settings file");
  }
  return problems;
}

export const hasConfig = (home = gallivantHome()) => readJson(configPath(home)) !== null;

/** Merge defaults, expand paths, validate. Throws a single error listing every problem. */
export function load(home = gallivantHome()) {
  const raw = readJson(configPath(home));
  if (!raw) throw new Error(`No config at ${configPath(home)}. Run \`gallivant doctor\` for the file to write.`);
  const cfg = merge(raw, home);
  const problems = validate(cfg, home);
  if (problems.length) throw new Error(`Config problems in ${configPath(home)}:\n  - ${problems.join("\n  - ")}`);
  return {
    ...cfg,
    home,
    worktrees: expand(cfg.worktrees),
    github_token_file: cfg.github_token_file ? expand(cfg.github_token_file) : null,
    context_paths: (cfg.context_paths || []).map(p => expand(p)),
    harness: Object.fromEntries(Object.entries(cfg.harness).map(([n, h]) => [n, { ...h, bin: expand(h.bin), settings: h.settings ? expand(h.settings) : undefined }])),
  };
}

/** Record a repo for recovery. Rewrites the raw file, keeping the operator's other values as written. */
export function rememberRepo(nameWithOwner, home = gallivantHome()) {
  const raw = readJson(configPath(home)) || {};
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  const key = nameWithOwner.toLowerCase();
  if (repos.some(r => r.toLowerCase() === key)) return false;
  writeJsonAtomic(configPath(home), { ...raw, repos: [...repos, key] }, 0o600);
  return true;
}
