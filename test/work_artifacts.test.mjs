import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { workArtifactViolations, publicationPolicyOf, assertPublicationPaths } from "../lib/work_artifacts.mjs";
import { gitDiffChangedPaths } from "../lib/git_diff.mjs";
import { makeGit } from "../lib/git.mjs";
import { parsePrd, check, sameContract, contractDiff } from "../lib/prd.mjs";
import { GOOD_PRD } from "./helpers.mjs";

test("work artifacts and carried inputs are rejected without rejecting product documentation or tests", () => {
  const bad = ["WORK_LOG.md", "notes-round-2.md", "session-log.jsonl", "session-log.json", "SESSION_SUMMARY.md", "AGENT_NOTES.md", "WORK_NOTES.md", "docs/audit/check.md", "docs/evidence/browser/a.png", "docs/verification/video.md", "docs/release/fix-validation.md", ".agent-work/progress.json", "scratch/output.txt", "context/task.json"];
  assert.equal(workArtifactViolations(bad, { inputFiles: ["context/task.json"] }).length, bad.length);
  assertPublicationPaths(["README.md", "AGENTS.md", "docs/prds/feature.md", "docs/release.md", "docs/reporting/purchase-activation.md", "test/fixtures/audit.json", "lib/audit.mjs", "docs/architecture.md"]);
  assert.equal(workArtifactViolations(["../notes.md", "notes\0.md", "./NOTES.md", "a\\notes.md"]).length, 4);
});

test("only exact approved paths override work-artifact policy; output exceptions change the brief contract", () => {
  const original = parsePrd(GOOD_PRD, "/r/docs/prds/widget-export.md");
  const approved = parsePrd(GOOD_PRD.replace("status: ready", "status: ready\npublish_files:\n  - docs/evidence/browser/a.png\n  - docs/audit/report.md"), original.path);
  assert.equal(check(approved).ok, true);
  const policy = publicationPolicyOf(approved);
  assertPublicationPaths(["docs/evidence/browser/a.png", "docs/audit/report.md"], policy);
  assert.throws(() => assertPublicationPaths(["docs/evidence/browser/b.png"], policy), /publish_files/);
  assert.equal(sameContract(original, approved), false);
  assert.match(contractDiff(original, approved).join("\n"), /publish_files/);
  for (const path of ["docs/evidence/*", "docs/evidence/", "../report.md", "/tmp/report.md", ".git/config", "docs/./audit/report.md"]) {
    const bad = parsePrd(GOOD_PRD.replace("status: ready", `status: ready\npublish_files:\n  - ${path}`), original.path);
    assert.equal(check(bad).results.find(r => r.id === "publish-files").ok, false, path);
  }
});

function repository(t) {
  const dir = mkdtempSync(join(tmpdir(), "publication-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" }, stdio: ["ignore", "pipe", "pipe"] });
  const write = (path, text = "test\n") => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  git("init", "-q"); git("commit", "--allow-empty", "-m", "Initial revision");
  return { dir, git, write, install: policy => makeGit({ config: {} }).installHooks(dir, policy) };
}

for (const type of ["module", "commonjs"]) test(`real Git hook blocks notes, accepts approved evidence and permits cleanup in ${type} repos`, t => {
  const r = repository(t);
  r.write("package.json", JSON.stringify({ type }));
  r.write("NOTES.md"); r.git("add", ".");
  assert.deepEqual(r.install(), { installed: true });
  assert.throws(() => r.git("commit", "-m", "Implement export"), error => /Task work artifacts/.test(error.stderr));
  assert.equal(r.git("rev-list", "--count", "HEAD").trim(), "1");
  // Simulate a pre-existing/bypassed commit: subsequent cleanup must be possible.
  r.git("-c", "core.hooksPath=/dev/null", "commit", "-m", "Legacy notes");
  r.git("rm", "NOTES.md"); r.git("commit", "-m", "Remove work notes");
  r.write("docs/evidence/image.png", "synthetic image fixture"); r.git("add", ".");
  assert.throws(() => r.git("commit", "-m", "Add requested evidence"));
  r.install(publicationPolicyOf({ meta: { publish_files: ["docs/evidence/image.png"] } }));
  r.git("commit", "-m", "Add requested evidence");
  // Reinstall on resume updates exceptions; old hook permissions cannot linger.
  r.install(); r.write("docs/evidence/image.png", "changed\n"); r.git("add", ".");
  assert.throws(() => r.git("commit", "-m", "Update evidence"));
});

test("approved base merges ignore inherited audit files but still reject task-owned work artifacts", t => {
  for (const dirty of [false, true]) {
    const r = repository(t);
    r.git("branch", "-M", "main");
    r.write("docs/audit/existing.md", "old upstream document\n"); r.git("add", "."); r.git("commit", "-m", "Existing documentation");
    r.git("checkout", "-b", "work/test");
    r.write("product.js"); if (dirty) r.write("WORK_LOG.md");
    r.git("add", "."); r.git("commit", "-m", "Product implementation");
    r.git("checkout", "main"); r.write("docs/audit/existing.md", "new upstream document\n");
    r.git("add", "."); r.git("commit", "-m", "Update upstream document");
    r.git("update-ref", "refs/remotes/origin/main", "HEAD"); r.git("checkout", "work/test");
    r.install(publicationPolicyOf(null, { base: "main" }));
    if (dirty) assert.throws(() => r.git("merge", "--no-ff", "--no-edit", "main"), error => /WORK_LOG\.md/.test(error.stderr));
    else r.git("merge", "--no-ff", "--no-edit", "main");
  }
});

test("a different merge parent never receives the approved-base comparison", t => {
  const r = repository(t);
  r.git("branch", "-M", "main"); r.git("update-ref", "refs/remotes/origin/main", "HEAD");
  r.git("checkout", "-b", "other"); r.write("docs/audit/notes.md"); r.git("add", "."); r.git("commit", "-m", "Other branch");
  r.git("checkout", "-b", "work/test", "main"); r.install(publicationPolicyOf(null, { base: "main" }));
  assert.throws(() => r.git("merge", "--no-ff", "--no-edit", "other"), error => /docs\/audit\/notes\.md/.test(error.stderr));
});

test("complete diff path extraction handles Git quoting, renames, copies, binary and mode changes", t => {
  const r = repository(t);
  const paths = ["space b/name.txt", "évidence.txt", "tab\tname.txt", "old.txt", "binary.dat", "mode.sh"];
  for (const path of paths) r.write(path, path === "binary.dat" ? "\0a" : "initial\n");
  r.git("add", "."); r.git("commit", "-m", "Fixture");
  const base = r.git("rev-parse", "HEAD").trim();
  for (const path of paths.slice(0, 3)) r.write(path, "changed\n");
  r.write("binary.dat", "\0b"); r.git("mv", "old.txt", "NOTES.md"); r.git("update-index", "--chmod=+x", "mode.sh"); r.git("add", ".");
  // add refreshes file modes from the worktree, so set the index mode last.
  r.git("update-index", "--chmod=+x", "mode.sh");
  const diff = r.git("diff", "--cached", "--find-renames", base);
  assert.deepEqual(gitDiffChangedPaths(diff).sort(), [...paths.filter(p => p !== "old.txt"), "NOTES.md"].sort());
  assert.throws(() => assertPublicationPaths(gitDiffChangedPaths(diff)), /Task work artifacts/);
  r.git("commit", "-m", "Changes"); r.git("rm", "NOTES.md");
  assert.deepEqual(gitDiffChangedPaths(r.git("diff", "--cached")), []);
  assert.deepEqual(gitDiffChangedPaths("diff --git a/old.md b/docs/audit/new.md\nsimilarity index 100%\ncopy from old.md\ncopy to docs/audit/new.md\n"), ["docs/audit/new.md"]);
});

test("unavailable or malformed diff metadata fails closed", () => {
  for (const diff of [null, "+not a complete diff\n", "diff --git a/x b/y\n", "diff --git a/x b/x\n", 'diff --git "a/x b/x\n']) assert.throws(() => gitDiffChangedPaths(diff));
  assert.deepEqual(gitDiffChangedPaths(""), []);
});
