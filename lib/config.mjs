// Config: one JSON file the operator writes by hand, validated here so every other module can trust its shape.
//
// Defaults hold nothing machine-specific. Anything that identifies the operator (trusted logins, token file,
// binaries) has to be written explicitly, which is what `doctor` walks you through.
import { join, relative, isAbsolute } from "node:path";
import { expand, readJson, writeJsonAtomic, gallivantHome } from "./fs.mjs";

export const HARNESSES = ["claude", "codex"];

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
  repos: [],
});

export const configPath = (home = gallivantHome()) => join(home, "config.json");

/** True when `child` is inside `parent` (or equal), by path segments, not by string prefix. */
export const isInside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Raw file contents merged with defaults, the one way both `load` and `doctor` build the object they validate. */
export function merge(raw) {
  return {
    ...DEFAULTS, ...raw,
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
  const names = Object.keys(cfg.harness || {});
  if (names.length === 0) problems.push("harness must configure at least one of: " + HARNESSES.join(", "));
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
  const cfg = merge(raw);
  const problems = validate(cfg, home);
  if (problems.length) throw new Error(`Config problems in ${configPath(home)}:\n  - ${problems.join("\n  - ")}`);
  return {
    ...cfg,
    home,
    worktrees: expand(cfg.worktrees),
    github_token_file: cfg.github_token_file ? expand(cfg.github_token_file) : null,
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
