import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeGit } from "../lib/git.mjs";
import { execFileAsync } from "../lib/process.mjs";
import { overlayBackupPath } from "../lib/merge_overlays.mjs";
import { tempHome } from "./helpers.mjs";

const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
function world(t, { conflict = false, baseDelete = false, execute = execFileAsync } = {}) {
  const home = tempHome(); t.after(() => rmSync(home, { recursive: true, force: true }));
  const origin = join(home, "origin"), tree = join(home, "tree"), prd = "docs/prds/task.md";
  const g = (args, cwd = tree) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "test@example.test" } }).trim();
  mkdirSync(origin); g(["init", "-qb", "main"], origin);
  put(join(origin, prd), "Tracked original brief\n"); put(join(origin, "app.txt"), "original\n");
  g(["add", "."], origin); g(["commit", "-qm", "Initial code"], origin);
  g(["clone", "-q", origin, tree], home); g(["checkout", "-qb", "work/task"]);
  put(join(tree, conflict ? "app.txt" : "task.txt"), "task implementation\n");
  g(["add", "."]); g(["commit", "-qm", "Task implementation"]);
  if (baseDelete) g(["rm", prd], origin);
  else put(join(origin, prd), "New tracked base brief\n");
  put(join(origin, conflict ? "app.txt" : "base.txt"), "base implementation\n");
  g(["add", "."], origin); g(["commit", "-qm", "Base updates"], origin);
  const approved = "Approved private brief\r\nKeep this exact input.\r\n";
  put(join(tree, prd), approved); put(join(tree, "PRIVATE.md"), "Approved source\n");
  const overlays = [{ path: prd, text: approved }, { path: "PRIVATE.md", text: "Approved source\n" }];
  const git = makeGit({ config: { home }, exec: execute, identity: async () => ({ name: "Fixture", email: "test@example.test" }) });
  const backup = overlayBackupPath(join(tree, ".git"));
  return { home, origin, tree, prd, approved, overlays, git, g, backup };
}

test("base merge preserves exact approved tracked overlay bytes without publishing them", async t => {
  const w = world(t), before = w.g(["rev-parse", "HEAD"]);
  await w.git.assertClean(w.tree, w.overlays);
  const result = await w.git.mergeBase(w.tree, "main", { overlays: w.overlays });
  assert.equal(result.merged, true);
  assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), w.approved);
  assert.equal(w.g(["show", `HEAD:${w.prd}`]), "New tracked base brief");
  assert.equal(w.g(["show", `:${w.prd}`]), "New tracked base brief");
  assert.equal(w.g(["merge-base", "--is-ancestor", before, "HEAD"]), "");
  assert.equal(w.g(["diff", "--cached", "--name-only"]), "");
  assert.equal(existsSync(w.backup), false);
  const again = await w.git.mergeBase(w.tree, "main", { overlays: w.overlays });
  assert.equal(again.merged, false); assert.equal(existsSync(w.backup), false);
  await w.git.assertClean(w.tree, w.overlays);
});

test("a real code conflict aborts and restores approved overlays before reporting its unpaid limitation", async t => {
  const w = world(t, { conflict: true }), head = w.g(["rev-parse", "HEAD"]), observed = [];
  const result = await w.git.mergeBase(w.tree, "main", { overlays: w.overlays, onConflict: info => observed.push(info) });
  assert.equal(result.conflict, true); assert.equal(result.aborted, true); assert.equal(result.overlayConflict, true);
  assert.deepEqual(result.overlayPaths, [w.prd]); assert.equal(observed.length, 1);
  assert.equal(w.g(["rev-parse", "HEAD"]), head);
  assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), w.approved);
  assert.deepEqual(await w.git.mergeState(w.tree), { head: null, unmerged: 0, other: [] });
  assert.equal(existsSync(w.backup), false); await w.git.assertClean(w.tree, w.overlays);
});

test("base deletion recreates only the private approved overlay, leaving it out of the merge commit", async t => {
  const w = world(t, { baseDelete: true });
  const result = await w.git.mergeBase(w.tree, "main", { overlays: w.overlays });
  assert.equal(result.merged, true); assert.equal(await w.git.fileAt(w.tree, "HEAD", w.prd), null);
  assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), w.approved);
  assert.equal(existsSync(w.backup), false); await w.git.assertClean(w.tree, w.overlays);
});

test("staged, unapproved and linked working files stop before overlay hydration", async t => {
  for (const fault of ["staged-overlay", "staged-other", "unapproved", "symlink"]) await t.test(fault, async t => {
    const w = world(t), head = w.g(["rev-parse", "HEAD"]);
    if (fault === "staged-overlay") w.g(["add", w.prd]);
    if (fault === "staged-other") { put(join(w.tree, "task.txt"), "new work\n"); w.g(["add", "task.txt"]); }
    if (fault === "unapproved") put(join(w.tree, w.prd), "Unknown operator edit\n");
    if (fault === "symlink") { rmSync(join(w.tree, w.prd)); symlinkSync(join(w.origin, w.prd), join(w.tree, w.prd)); }
    const status = w.g(["status", "--porcelain=v1"]);
    await assert.rejects(w.git.mergeBase(w.tree, "main", { overlays: w.overlays }), /unfinished repository edits|immutable approved snapshot|symlink/);
    assert.equal(w.g(["rev-parse", "HEAD"]), head); assert.equal(w.g(["status", "--porcelain=v1"]), status);
    assert.equal(existsSync(w.backup), false);
  });
});

test("merge execution failure restores approved bytes and cleans its successful transaction", async t => {
  const w = world(t, { execute: async (command, args, options) => {
    if (args[0] === "merge" && args.includes("--no-ff")) throw new Error("Injected merge execution failure");
    return execFileAsync(command, args, options);
  } });
  await assert.rejects(w.git.mergeBase(w.tree, "main", { overlays: w.overlays }), /Injected merge execution failure/);
  assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), w.approved);
  assert.equal(existsSync(w.backup), false); await w.git.assertClean(w.tree, w.overlays);
});

test("unknown bytes after merge are preserved with a private backup and block another merge", async t => {
  const w = world(t, { execute: async (command, args, options) => {
    const result = await execFileAsync(command, args, options);
    if (args[0] === "merge" && args.includes("--no-ff")) put(join(options.cwd, "docs/prds/task.md"), "Concurrent unknown bytes\n");
    return result;
  } });
  await assert.rejects(w.git.mergeBase(w.tree, "main", { overlays: w.overlays }), /private backup/);
  assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), "Concurrent unknown bytes\n");
  assert.equal(readFileSync(join(w.backup, "0.bin"), "utf8"), w.approved);
  await assert.rejects(w.git.mergeBase(w.tree, "main", { overlays: w.overlays }), /interrupted approved-input merge/);
});

test("failed conflict abort preserves its unresolved index and the approved-byte recovery backup", async t => {
  const w = world(t, { conflict: true, execute: async (command, args, options) => {
    if (args[0] === "merge" && args.includes("--abort")) throw new Error("Injected abort failure");
    return execFileAsync(command, args, options);
  } });
  await assert.rejects(w.git.mergeBase(w.tree, "main", { overlays: w.overlays }), /unresolved Git operation.*private backup/);
  assert.ok((await w.git.mergeState(w.tree)).unmerged > 0);
  assert.equal(readFileSync(join(w.backup, "0.bin"), "utf8"), w.approved);
});
