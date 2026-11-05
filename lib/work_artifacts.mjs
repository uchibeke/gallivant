import { parseSourcesMeta } from "./config.mjs";

// Bump when classification or path-proof semantics change to invalidate saved checks.
export const PUBLICATION_POLICY_VERSION = 1;

/** Exact output exceptions come only from the coordinator's approved brief snapshot. */
export function publicationPolicyOf(prd, { sources = [], base = null } = {}) {
  const { paths, problems } = parseSourcesMeta(prd?.meta?.publish_files);
  if (paths.length > 100) problems.push("publish_files is limited to 100 exact deliverable paths");
  if (paths.some(path => path.split("/").includes("."))) problems.push("publish_files must use canonical paths without ./ components");
  if (problems.length) throw new Error(`Invalid publish_files: ${problems.join("; ")}`);
  return { publishFiles: paths, inputFiles: [...new Set([...parseSourcesMeta(prd?.meta?.sources).paths, ...sources])], ...(base ? { base } : {}) };
}

// Self-contained so the identical classifier can be embedded in the Git hook.
// This is a path hygiene policy, not a content classifier or a sandbox boundary.
export function workArtifactReason(path, policy = {}) {
  if (typeof path !== "string" || !path || path.startsWith("/") || /[\\\x00]/.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) return "invalid publication path";
  if (policy.publishFiles?.includes(path)) return null;
  if (policy.inputFiles?.includes(path)) return "carried task input, not an output deliverable";
  const name = path.normalize("NFC").toLowerCase();
  if (/(^|\/)(?:\.gallivant|\.agent-work|\.task-work|session-logs|session_logs|work-logs|work_logs|scratch|scratchpad)(\/|$)/.test(name)) return "task scratch or session storage";
  if (/(^|\/)(?:\.codex\/sessions|\.claude\/projects|docs\/(?:audit|audits|evidence|verification|work|notes|runs))(\/|$)/.test(name)) return "task audit, evidence or execution notes";
  if (/(^|\/)(?:work|session|agent)[-_]?(?:log|notes|summary)(?:[-_][^/]*)?\.(?:md|txt|log|jsonl?)$/i.test(name)) return "task work log, session notes or summary";
  if (/(^|\/)(?:handoff|audit|audit[-_]report|review|notes|scratch)(?:[-_][^/]*)?\.(?:md|txt|log|jsonl)$/i.test(name)) return "task review notes, audit or handoff";
  if (/(^|\/)docs\/(?:release|reporting)\/[^/]+[-_]validation\.md$/.test(name)) return "execution validation log";
  return null;
}

export function workArtifactViolations(paths, policy = {}) {
  return [...new Set(paths)].flatMap(path => { const reason = workArtifactReason(path, policy); return reason ? [{ path, reason }] : []; });
}

export function workArtifactError(violations) {
  return [
    "Task work artifacts must stay out of the commit/PR:",
    ...violations.slice(0, 30).map(v => `  ${JSON.stringify(v.path)}: ${v.reason}`),
    ...(violations.length > 30 ? [`  ... and ${violations.length - 30} more`] : []),
    "Unstage these files or remove them from the branch diff, preserving useful local copies. Keep carried inputs readable in the checkout; do not delete them.",
    "Keep scratch files outside the repository (for example, in a directory created with mktemp -d). Put concise verification results in the PR receipt; retain durable project documentation and tests.",
    "An explicitly requested report or evidence file may be listed by exact path in publish_files in the operator's approved brief. Do not edit the session copy to grant an exception, rename logs to evade this rule, or bypass hooks.",
  ].join("\n");
}

export function assertPublicationPaths(paths, policy = {}) {
  const violations = workArtifactViolations(paths, policy);
  if (violations.length) throw new Error(workArtifactError(violations));
}

/** Inlined, dependency-free policy shared by every local harness's existing hook. */
export function workArtifactHook(policy = {}) {
  return `
${workArtifactReason.toString()}
${workArtifactViolations.toString()}
${workArtifactError.toString()}
const { execFileSync } = await import("node:child_process");
try {
  const policy = ${JSON.stringify(policy)};
  const git = args => execFileSync("git", args, { encoding: "utf8", timeout: 10000, maxBuffer: 16777216 });
  let mergeHead = null;
  try { mergeHead = readFileSync(git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim(), "utf8").trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // A trusted base refresh brings upstream-owned files into the index. Judge
  // the candidate tree against that exact base parent, never skip a merge.
  let comparison = [];
  if (mergeHead && policy.base) {
    const approvedBase = git(["rev-parse", "--verify", "refs/remotes/origin/" + policy.base + "^{commit}"]).trim();
    if (mergeHead === approvedBase) comparison = [approvedBase];
  }
  const paths = git(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z", ...comparison]);
  if (paths && !paths.endsWith("\\0")) throw new Error("incomplete staged path list");
  const violations = workArtifactViolations(paths ? paths.slice(0, -1).split("\\0") : [], policy);
  if (violations.length) throw new Error(workArtifactError(violations));
} catch (error) {
  process.stderr.write("Publication check failed: " + error.message + "\\n");
  process.exit(1);
}
`;
}
