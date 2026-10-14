// Config: one JSON file the operator writes by hand, validated here so every other module can trust its shape.
//
// Defaults hold nothing machine-specific. Anything that identifies the operator (trusted logins, token file,
// binaries) has to be written explicitly, which is what `doctor` walks you through.
import { join, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { expand, readJson, writeJsonAtomic, gallivantHome, isDir } from "./fs.mjs";
import { validateAgentsConfig } from "./openai_agents_config.mjs";
import { validateCloudConfig } from "./codex_cloud_config.mjs";
import { adapters, executionRegistry } from "./harness.mjs";
import { findExecutable } from "./executable.mjs";

// Recognition is independent of new-dispatch availability: a registered provider
// must retain configuration and recovery identities while its readiness is refused.
export const HARNESSES = Object.keys(executionRegistry);

/** The harness a brief with no `harness:` key is read as, when there is no config to narrow it. */
export const DEFAULT_HARNESS = HARNESSES[0];

/**
 * The harness to use when nothing named one. An install with exactly one configured harness means it, so a
 * goose-only machine is not handed `claude` and then told `harness "claude" is not configured`.
 */
export function defaultHarness(config) {
  const names = Object.keys(config?.harness || {});
  return names.length === 1 ? names[0] : DEFAULT_HARNESS;
}

// Prefer inherited PATH, then the operator's login shell for version managers.
// Memoised per process; restart the daemon after changing runtime installations.
const found = new Map();
export const whence = name => {
  if (!found.has(name)) {
    found.set(name, findExecutable(name));
  }
  return found.get(name);
};

/**
 * The harnesses installed on this machine, in the shape `config.harness` takes. Used when the operator names none,
 * so a fresh install works with whichever of the two they happen to have. Naming one explicitly in the config
 * turns discovery off for that install, which is what an operator wants when two versions are on the PATH or when
 * a harness is deliberately not in play.
 */
/**
 * A path with its symlinks resolved, or the path itself when it cannot be resolved (it does not exist yet, or a
 * component is not readable). Used by every refusal in `validateContextPaths`: a lexical comparison against a
 * symlink is not a refusal at all, and the directories on that list are the ones that bound and audit the run.
 */
const realOf = p => { try { return realpathSync(p); } catch { return p; } };

export function discoverHarnesses(home = gallivantHome()) {
  const out = {};
  for (const name of HARNESSES) {
    if (executionRegistry[name].transport !== "cli") continue;
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
  max_iterations: 30,
  checks_grace_minutes: 5,            // a head younger than this with no checks yet is not "green", it is "not reported yet"
  // What this number is FOR, because the value only makes sense once that is settled. The timeout catches a session that
  // is genuinely wedged: spinning on a command that never returns, waiting on a prompt that will never come, looping.
  // Nothing else. What bounds SPEND is `max_iterations` and `max_budget_usd`, which are the right tools for it and
  // already do the job; a clock is a bad spend limit because it cannot tell an expensive round from a stuck one.
  //
  // The measured facts, which are the whole argument. One review round that had not yet reached its `git commit` cost
  // 31.2 minutes and was killed at the then-limit of 30: it had 846 tests green and a tsc count matching its 611
  // baseline, and the kill destroyed the round and recorded it as `reason: timeout`, as though the session had failed.
  // The healthy run before it took 7.3 hours and exited 0. So any default under roughly 8 hours can cut a run like the
  // second one, and 30, 45 and 180 are all the same error at different scales: a limit set near the cost of real work.
  //
  // Hence "longer than any legitimate run" rather than "about what work costs". The tradeoff is real and is accepted
  // deliberately: a wedged session now burns up to 12 hours before the daemon stops it. That is a spend question and
  // `max_budget_usd` is its control. Do not add a second clock to compensate.
  //
  // A repository with a different shape sets its own on its `repos` entry; this is only the fallback. The validation
  // floor stays at 1, so an operator who deliberately wants a short timeout can have one.
  run_timeout_minutes: 720,
  max_budget_usd: 5,
  rereview_minutes: 6,
  stall_hours: 6,
  trusted_authors: [],
  reviewer: {
    login: "chatgpt-codex-connector[bot]",
    rereview_comment: "@codex review",
    blocking_pattern: "\\bP[01]\\b",
    // How the reviewer says which commit it looked at, as a regex whose first capture group is the sha. It is read
    // from a review's body and from a plain comment's, and it is what lets a verdict posted as a comment clear a head.
    //
    // The default is Codex's wording because Codex is the reviewer this ships configured for, exactly as
    // `rereview_comment` defaults to its phrase. A reviewer that names commits differently sets this and needs no code
    // change; one that never names a commit leaves it and simply cannot clear a head from a comment, which is the safe
    // answer rather than a broken one.
    reviewed_commit_pattern: "Reviewed commit:\\*{0,2}\\s*`([0-9a-f]{7,40})`",
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
    // Every comparison below is against the resolved path, not the written one. `expand` handles `~` and makes the
    // path absolute; it does not follow symlinks, so a link to `$HOME` or to `~/.claude` passed all of these checks
    // and handed the run exactly what they exist to refuse. The written form is kept for the message, because that is
    // what the operator has to go and change.
    const p = realOf(expand(raw));
    if (p === realOf(homedir())) { problems.push(`${label}: "${raw}" is your home directory; name the one directory the run needs, not everything you own`); continue; }
    const hit = forbidden.find(([dir]) => isInside(realOf(dir), p));
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

/**
 * The supporting files a brief carries into the checkout, from its `sources` frontmatter.
 *
 * Shares `parseContextPathsMeta`'s reader because both read a list out of frontmatter and both must tolerate the two
 * shapes YAML-ish frontmatter arrives in: a real list, and a bracketed string. What differs is what is legal in the
 * list, and every refusal below is a path shape that would turn one named file into something else:
 *
 *   - An absolute path names a file outside the operator's tree, which is the one place a brief may not reach: the
 *     whole point is that these travel WITH the brief.
 *   - A `..` segment escapes the checkout by another spelling, so it is refused on the same grounds.
 *   - A glob or a directory would make the brief's list a pattern rather than a manifest. A glob is how a brief
 *     accidentally carries a `.env`; an operator naming files one at a time cannot do that by accident.
 *
 * Refusals are returned rather than thrown, with the offending value, because the caller is a contract rule that
 * reports every problem at once instead of stopping at the first.
 */
export function parseSourcesMeta(value) {
  const raw = parseContextPathsMeta(value);
  const paths = [];
  const problems = [];
  for (const entry of raw) {
    const path = entry.trim();
    if (!path) continue;
    if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) { problems.push(`"${path}" is absolute; name files relative to the repository root`); continue; }
    if (path.split(/[\\/]/).includes("..")) { problems.push(`"${path}" leaves the repository; name files inside it`); continue; }
    if (/[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some(p => p.toLowerCase() === ".git")) { problems.push(`"${path}" is not a safe repository file path`); continue; }
    if (/[*?[\]]/.test(path)) { problems.push(`"${path}" is a glob; name each file on its own line`); continue; }
    if (path.endsWith("/")) { problems.push(`"${path}" is a directory; name each file, or use context_paths for a whole tree`); continue; }
    if (paths.includes(path)) continue;
    paths.push(path);
  }
  return { paths, problems };
}

/**
 * The base branch for one repository, and where it came from. One definition, read in one place, so the branch the
 * clone is cut from, the branch the prompt tells the session to target, and the branch a merge brings in can never
 * be three different answers.
 *
 * Precedence, and the reason for each rung:
 *   1. `asked`, an explicit `--base` on the command. The operator is looking at the output and has typed the answer.
 *   2. the base configured for this repository in `repos`. Typed once, then it is the repository's answer forever.
 *   3. `defaultBranch`, whatever `gh repo view` reports. Today's behaviour, and what an operator who configures
 *      nothing keeps.
 *
 * `source` rides along because `doctor`, `status` and `why` all print the base and an operator reading "staging"
 * needs to know whether that came from their config or from GitHub. A derived base would be the case where that
 * matters most; nothing here derives one, and that is deliberate (see docs/config.md).
 */
export function resolveBase({ config, repo, defaultBranch = null, asked = null }) {
  const configured = configuredBase(config, repo);
  if (asked) return { base: asked, source: "flag" };
  if (configured) return { base: configured, source: "config" };
  return { base: defaultBranch, source: "default" };
}

/**
 * How long a run in one repository may take, and where the number came from.
 *
 * Same shape as `resolveBase` and for the same reason: "how long does verification take here" is a property of the
 * codebase, not of the operator. An operator with a small repository and a large one has no single right global number,
 * and the one they pick is wrong for one of the two. So the repository answers it if it has been told, and the global
 * `run_timeout_minutes` is the fallback, which is what an operator who configures nothing keeps.
 *
 * `source` rides along because a timeout kill has to name the limit it exceeded and where that limit was set: an
 * operator reading "exceeded its 30 minute timeout" needs to know whether to raise the global or the repository's own.
 */
export function resolveTimeout({ config, repo }) {
  const configured = configuredTimeout(config, repo);
  if (configured != null) return { minutes: configured, source: "repo" };
  return { minutes: config?.run_timeout_minutes ?? DEFAULTS.run_timeout_minutes, source: "config" };
}

/**
 * Problems with the `repos` list. Both forms are legal and mixing them in one list is legal, because an operator who
 * sets a base on one repository should not have to rewrite the rest.
 *
 * A misspelled key is the failure worth naming. `{ "repo": "acme/widget", "branch": "staging" }` is a plausible thing
 * to write and would silently target the default branch forever, so an object with no `base` and an unknown key is
 * refused here rather than quietly read as the string form.
 */
export function validateRepos(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) return ['repos must be an array of "owner/name" strings or { repo, base, run_timeout_minutes } objects'];
  const problems = [];
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw === "string") {
      if (!/^[\w.-]+\/[\w.-]+$/.test(raw)) { problems.push(`repos: "${raw}" is not owner/name`); continue; }
    } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (typeof raw.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(raw.repo)) { problems.push(`repos: ${JSON.stringify(raw)} needs a "repo" of the form owner/name`); continue; }
      if (raw.base !== undefined && raw.base !== null && (typeof raw.base !== "string" || !raw.base.trim())) { problems.push(`repos: ${raw.repo} base must be a branch name`); continue; }
      // Refused rather than ignored, for the reason the unknown-key check above exists: a timeout typed as "45" or as 0
      // would read as "not configured" and the repository would keep the global forever, which is the silent failure.
      if (raw.run_timeout_minutes !== undefined && raw.run_timeout_minutes !== null && (typeof raw.run_timeout_minutes !== "number" || raw.run_timeout_minutes < 1)) { problems.push(`repos: ${raw.repo} run_timeout_minutes must be a number >= 1`); continue; }
      const extra = Object.keys(raw).filter(k => k !== "repo" && k !== "base" && k !== "run_timeout_minutes");
      if (extra.length) { problems.push(`repos: ${raw.repo} has unknown key${extra.length === 1 ? "" : "s"} ${extra.join(", ")} (only repo, base and run_timeout_minutes are read)`); continue; }
    } else { problems.push(`repos: ${JSON.stringify(raw)} is neither "owner/name" nor a { repo } object`); continue; }
    const key = repoEntry(raw).repo;
    if (seen.has(key)) problems.push(`repos: ${key} is listed twice`);
    seen.add(key);
  }
  return problems;
}

/** Raw file contents merged with defaults, the one way both `load` and `doctor` build the object they validate. */
export function merge(raw, home = gallivantHome()) {
  // No harness named: use whatever is installed. An empty object still means "none found", which validate refuses
  // with the install instruction rather than a path the operator has to write by hand.
  const harness = raw.harness && Object.keys(raw.harness).length ? raw.harness : discoverHarnesses(home);
  return {
    ...DEFAULTS, ...raw, harness,
    deliverable: raw.deliverable === undefined ? DEFAULTS.deliverable : raw.deliverable === null ? null : { ...DEFAULTS.deliverable, ...raw.deliverable },
    // `reviewer` is merged key by key, like `deliverable` above it and for the reason that block already demonstrates:
    // a spread of `raw` replaces the whole object, so every key the operator's file does not name disappears rather
    // than falling back to its default. That was latent until a key was ADDED: configs written before
    // `reviewed_commit_pattern` existed had no value for it, the merge left it undefined, and `validate` refused the
    // file. Every command then died at config load, which an operator saw as `gallivant resume` printing nothing at all.
    //
    // `null` is preserved as null, because that is the documented way to say there is no reviewer, and a deep merge
    // that turned it into the defaults would silently give a repository a reviewer it had switched off.
    reviewer: raw.reviewer === undefined ? DEFAULTS.reviewer : raw.reviewer === null ? null : { ...DEFAULTS.reviewer, ...raw.reviewer },
  };
}

/** Problems as human sentences; empty means valid. Used by `load` (throws) and by `doctor` (prints). */
export function validate(cfg, home = gallivantHome()) {
  const problems = [];
  const num = (k, min) => { if (typeof cfg[k] !== "number" || cfg[k] < min) problems.push(`${k} must be a number >= ${min}`); };
  num("poll_seconds", 30); num("max_iterations", 1); num("run_timeout_minutes", 1); num("max_budget_usd", 0);
  num("rereview_minutes", 1); num("stall_hours", 1); num("checks_grace_minutes", 0);
  if (cfg.execution !== undefined) {
    const ranges = { deadlineMs: [10, 120_000], progressMs: [100, 300_000], maxBackoffMs: [100, 3_600_000], concurrency: [1, 8], eventBytes: [1024, 65_536], events: [1, 100] };
    for (const [key, value] of Object.entries(cfg.execution || {})) {
      const range = ranges[key];
      if (!range || !Number.isSafeInteger(value) || value < range[0] || value > range[1]) problems.push(`execution.${key} must be an integer in ${range ? range.join("..") : "the documented execution limits"}`);
    }
  }
  if (!Array.isArray(cfg.trusted_authors) || cfg.trusted_authors.length === 0) problems.push("trusted_authors must list at least one GitHub login");
  if (cfg.reviewer !== null) {
    for (const k of ["login", "rereview_comment", "blocking_pattern"]) if (typeof cfg.reviewer?.[k] !== "string") problems.push(`reviewer.${k} must be a string (or set reviewer to null)`);
    // `reviewed_commit_pattern` is optional, and that is deliberate rather than an omission. It was added after configs
    // existed, so requiring it made every config written before it invalid: `loadConfig` threw on the key, and every
    // command died at config load. What an operator saw was `gallivant resume` producing no output at all. A key added
    // later must be absent-tolerant, and absent means "no pattern", which the reader already handles by declining to
    // clear a head from a comment.
    if (cfg.reviewer?.reviewed_commit_pattern !== undefined && typeof cfg.reviewer.reviewed_commit_pattern !== "string") problems.push("reviewer.reviewed_commit_pattern must be a string when set");
    for (const k of ["blocking_pattern", "reviewed_commit_pattern"]) {
      if (typeof cfg.reviewer?.[k] === "string") { try { new RegExp(cfg.reviewer[k]); } catch { problems.push(`reviewer.${k} is not a valid regex`); } }
    }
  }
  if (cfg.notify !== null && typeof cfg.notify?.ntfy !== "string") problems.push("notify.ntfy must be a URL (or set notify to null)");
  if (cfg.deliverable !== null && (typeof cfg.deliverable !== "object" || Array.isArray(cfg.deliverable))) problems.push("deliverable must be an object of limits (or null to disable the completion gate)");
  else if (cfg.deliverable && !["aport", "local"].includes(cfg.deliverable.evaluator)) problems.push('deliverable.evaluator must be "aport" or "local"');
  else if (cfg.deliverable && !["wait", "local"].includes(cfg.deliverable.on_unreachable)) problems.push('deliverable.on_unreachable must be "wait" or "local"');
  if (!cfg.worktrees) problems.push("worktrees must be a directory path outside the Gallivant home");
  else if (isInside(expand(cfg.worktrees), home)) problems.push("worktrees must not be under the Gallivant home directory");
  problems.push(...validateContextPaths(cfg.context_paths, home));
  problems.push(...validateRepos(cfg.repos));
  const names = Object.keys(cfg.harness || {});
  if (names.length === 0) problems.push(`no harness configured and none found on PATH. Install one of them, or set harness.<name>.bin explicitly. Looked for: ${HARNESSES.join(", ")}`);
  for (const n of names) {
    if (!HARNESSES.includes(n)) problems.push(`harness.${n} is not a known harness (${HARNESSES.join(", ")})`);
    else if (executionRegistry[n].transport === "remote") { try { (n === "codex-cloud" ? validateCloudConfig : validateAgentsConfig)(cfg.harness[n]); } catch (e) { problems.push(e.message); } }
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
    harness: Object.fromEntries(Object.entries(cfg.harness).map(([n, h]) => [n, executionRegistry[n]?.transport === "remote" ? { ...h, ...(h.api_key_file ? { api_key_file: expand(h.api_key_file) } : {}) } : { ...h, bin: expand(h.bin), settings: h.settings ? expand(h.settings) : undefined }])),
  };
}

/**
 * A `repos` entry as `{ repo, base }`, whichever of the two forms the operator wrote.
 *
 * `repos` was a flat array of `owner/name` strings, appended by `rememberRepo` and read by `reconcile` and `doctor`
 * to know which repositories to recover from and check. It now also accepts `{ repo, base }`, because the base branch
 * a pull request should target is a property of the repository and there was nowhere to put one. The string form
 * keeps meaning exactly what it meant: a repository whose base is its own default branch.
 *
 * `base` is null for the string form and for an object that names none, and null is what every reader treats as
 * "ask GitHub for the default branch", which is today's behaviour and the behaviour an operator who configures
 * nothing keeps.
 */
export function repoEntry(raw) {
  if (typeof raw === "string") return { repo: raw.toLowerCase(), base: null, run_timeout_minutes: null };
  if (raw && typeof raw === "object" && typeof raw.repo === "string") {
    const base = typeof raw.base === "string" && raw.base.trim() ? raw.base.trim() : null;
    const t = typeof raw.run_timeout_minutes === "number" && raw.run_timeout_minutes >= 1 ? raw.run_timeout_minutes : null;
    return { repo: raw.repo.toLowerCase(), base, run_timeout_minutes: t };
  }
  return null;
}

/** Every `repos` entry as `{ repo, base }`, bad ones dropped. `validate` is what refuses them; this is for readers. */
export const repoEntries = cfg => (Array.isArray(cfg?.repos) ? cfg.repos : []).map(repoEntry).filter(Boolean);

/** Just the `owner/name` strings, for the three readers that only ever wanted the name. */
export const repoNames = cfg => repoEntries(cfg).map(r => r.repo);

/**
 * The base branch configured for one repository, or null when none is.
 *
 * Null rather than a guess on purpose. The caller that wants a branch name has the repository's default branch to
 * fall back on, and it knows where that came from; a function here that returned "main" would be inventing one.
 */
export const configuredBase = (cfg, nameWithOwner) =>
  repoEntries(cfg).find(r => r.repo === String(nameWithOwner || "").toLowerCase())?.base ?? null;

/**
 * The run timeout configured for one repository, in minutes, or null when none is. Null rather than the global, for the
 * same reason `configuredBase` returns null: the caller knows what its own fallback is and where that came from, and a
 * function here that returned 45 would be hiding which of the two answered.
 */
export const configuredTimeout = (cfg, nameWithOwner) =>
  repoEntries(cfg).find(r => r.repo === String(nameWithOwner || "").toLowerCase())?.run_timeout_minutes ?? null;

/**
 * Record a repo for recovery, and the base branch it targets when one was chosen. Rewrites the raw file, keeping the
 * operator's other values as written.
 *
 * Two properties this has to keep. The string form is what a first use writes when nothing named a base, because an
 * operator who has never configured one must not find their config rewritten into a shape they did not choose. And
 * the dedupe stays a lowercased comparison of the repository name, whichever form each existing entry is in, so a
 * second start never appends a duplicate.
 *
 * Returns true when the file changed, which is what `start` reads to decide whether the labels are worth creating.
 */
export function rememberRepo(nameWithOwner, home = gallivantHome(), base = null) {
  const raw = readJson(configPath(home)) || {};
  const repos = Array.isArray(raw.repos) ? raw.repos : [];
  const key = nameWithOwner.toLowerCase();
  const at = repos.findIndex(r => repoEntry(r)?.repo === key);
  if (at === -1) {
    // A base only becomes an object entry. Without one this appends the bare string it always did.
    const next = base ? { repo: key, base } : key;
    writeJsonAtomic(configPath(home), { ...raw, repos: [...repos, next] }, 0o600);
    return true;
  }
  // Already known. The only thing left to write is a base that differs from the one recorded, which is how
  // `start --base` retargets a repository that was first used without one.
  if (!base || repoEntry(repos[at]).base === base) return false;
  const updated = [...repos];
  updated[at] = { ...(typeof repos[at] === "object" && repos[at] ? repos[at] : {}), repo: key, base };
  writeJsonAtomic(configPath(home), { ...raw, repos: updated }, 0o600);
  return true;
}
