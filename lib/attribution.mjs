// Harness attribution in a commit message, and the `commit-msg` hook that refuses it.
//
// Gallivant's commits are Gallivant's. The identity already is: `RUN_GIT_CONFIG` (lib/git.mjs) sets `user.name` and
// `user.email` to `gallivant` on the command line, where nothing in a repo can override them. What was NOT Gallivant's
// was the message body. Every commit on a live PR carried
//
//     Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
//
// because the harness adds that trailer on its own, and nothing in this repository said not to. A public pull request
// ended up crediting a harness for the operator's work.
//
// This is a HOOK and not a line in the prompt, and the choice is the whole design. A prompt is a request a session can
// forget, and forgetting it is exactly how those four commits happened. A hook fires on whatever process runs
// `git commit`, so one mechanism covers all five adapters and the sixth nobody has written yet, with no per-harness
// code and nothing to keep in step. It fails the commit rather than editing the message, because silently rewriting what
// a session wrote would leave it believing it committed something it did not.
//
// `.git/hooks` rather than a directory in the checkout. A relative `core.hooksPath` would also work and would keep
// `runEnv` free of absolute paths, but it puts a directory INSIDE the working tree, where it shows up as untracked in
// `git status`, in the `git diff --check` the briefs run, and in the uncommitted-work count a timeout kill now reports.
// A hook that makes a clean tree look dirty would be traded away by the first session that wanted a clean `git status`.
// `.git/hooks` is git's own default path, needs no config at all, is already outside the working tree, and dies with
// the clone. Nothing is added to `runEnv`, which keeps its no-absolute-paths property intact.

/**
 * The trailers that are refused, matched at the start of a line and case-insensitively.
 *
 * Deliberately narrow. It matches a `Co-Authored-By:` trailer naming a harness or its vendor, and the two forms Claude
 * Code appends to bodies it writes. It does NOT match a bare mention of a harness anywhere in a message, and that is a
 * requirement rather than an oversight: this repository has `lib/harness.mjs`, five adapters and a doctor check, so
 * "fix: claude adapter drops the session id" is a commit that must go through. A matcher that blocked it would be worse
 * than the trailer it was trying to stop, because the way around it is to describe the change dishonestly.
 */
const VENDORS = "claude|anthropic|codex|openai|gemini|google|opencode|goose";
export const ATTRIBUTION_PATTERNS = [
  // A co-author trailer naming any of them, anywhere on the line: the vendor may be in the name, the email or both.
  new RegExp(String.raw`^\s*co-authored-by:.*(?:${VENDORS}).*$`, "im"),
  // The footer Claude Code adds to messages and PR bodies, in both the forms it writes.
  new RegExp(String.raw`^\s*(?:🤖\s*)?generated with\b.*(?:${VENDORS}).*$`, "im"),
  new RegExp(String.raw`^\s*🤖\s*generated with.*$`, "im"),
];

/**
 * The offending line of a message, or null when there is none. The LINE and not just a boolean, because the whole value
 * of failing early is an error a session can act on: "rejected" with no reason gets the identical message retried.
 *
 * Comment lines are ignored. `git commit` passes the message file with its own `#` commentary still in it, and the
 * template shown on a conflict lists the co-authors of the commits being merged.
 */
export function attributionIn(message) {
  const body = String(message ?? "")
    .split("\n")
    .filter(l => !l.trimStart().startsWith("#"))
    .join("\n");
  for (const re of ATTRIBUTION_PATTERNS) {
    const m = body.match(re);
    if (m) return m[0].trim();
  }
  return null;
}

/** The message the hook prints on a refusal. One place, so the test and the script cannot drift. */
export const attributionError = line => [
  "gallivant: this commit message credits an AI harness, which is not permitted on this project.",
  `  offending line: ${line}`,
  "  Remove that line from the message and commit again. Everything else about the commit is fine:",
  "  the code, the summary and the author identity all stand. Only the attribution trailer has to go.",
  "  The commit is authored by the operator, and the harness that wrote it is recorded in the run log, not in the history.",
].join("\n");

/**
 * The `commit-msg` hook, as the text of the file. Self-contained node with no imports, because it runs as its own
 * process inside a sandboxed checkout that cannot read this repository: a `require` of anything here would fail at
 * commit time, on the operator's machine, for a reason nothing would explain. So the matcher is inlined, and
 * `test/attribution.test.mjs` asserts the inlined copy agrees with `attributionIn` on every case rather than trusting
 * that they were kept in step by hand.
 *
 * Exits 1 on a match, which is what makes `git commit` create no commit object at all.
 */
export const COMMIT_MSG_HOOK = `#!/usr/bin/env node
// Written by Gallivant (lib/attribution.mjs). Refuses a commit message that credits an AI harness.
// Self-contained on purpose: this runs inside a sandboxed checkout that cannot read Gallivant's own source.
const { readFileSync } = require("node:fs");
const ATTRIBUTION_PATTERNS = ${JSON.stringify(ATTRIBUTION_PATTERNS.map(re => [re.source, re.flags]))}.map(([source, flags]) => new RegExp(source, flags));
${attributionIn.toString()}
let text = "";
try { text = readFileSync(process.argv[2], "utf8"); } catch { process.exit(0); }
const line = attributionIn(text);
if (line) {
  process.stderr.write(${JSON.stringify(attributionError("__LINE__"))}.replace("__LINE__", line) + "\\n");
  process.exit(1);
}
process.exit(0);
`;
