import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeGit } from "../lib/git.mjs";
import { makeGh } from "../lib/gh.mjs";
import { makeState } from "../lib/state.mjs";
import { tempHome } from "./helpers.mjs";

test("GitHub merge ancestry requires the exact merge base, and encodes branch refs", async () => {
  const sha = "a".repeat(40), calls = [];
  let response = { status: "ahead", merge_base_commit: { sha } };
  const gh = makeGh({ exec: async (_cmd, args) => { calls.push(args); return { stdout: JSON.stringify(response) }; } });
  assert.equal(await gh.containsCommit("acme/widget", "release/next", sha), true);
  assert.equal(calls[0][1], `repos/acme/widget/compare/${sha}...release%2Fnext`);
  for (const status of ["behind", "diverged"]) {
    response = { status, merge_base_commit: { sha } };
    assert.equal(await gh.containsCommit("acme/widget", "main", sha), false);
  }
  response = { status: "ahead", merge_base_commit: { sha: "b".repeat(40) } };
  assert.equal(await gh.containsCommit("acme/widget", "main", sha), false);
  response = { status: "identical", merge_base_commit: { sha } };
  assert.equal(await gh.containsCommit("acme/widget", "main", sha), true);
});

test("chain file reads distinguish empty/absent content from authorization, rate-limit and encoding failures", async () => {
  let response = { type: "file", encoding: "base64", content: "" }, failure = null;
  const gh = makeGh({ exec: async () => { if (failure) throw failure; return { stdout: JSON.stringify(response) }; } });
  assert.equal(await gh.fileAtStrict("a/b", "empty.md", "main"), "");
  response.content = Buffer.from("a\n\n").toString("base64");
  assert.equal(await gh.fileAtStrict("a/b", "text.md", "main"), "a\n\n");
  response = { type: "file", encoding: "none", content: "" };
  await assert.rejects(() => gh.fileAtStrict("a/b", "large.md", "main"), /cannot read/);
  for (const code of [401, 403, 429, 500]) {
    failure = new Error(`gh: HTTP ${code}`);
    await assert.rejects(() => gh.fileAtStrict("a/b", "text.md", "main"), new RegExp(String(code)));
  }
  failure = new Error("gh: HTTP 404");
  assert.equal(await gh.fileAtStrict("a/b", "missing.md", "main"), null);
});

test("the real create path cuts a successor from the current base and preserves exact file bytes for collision checks", async () => {
  const home = tempHome(), repo = join(home, "remote");
  mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.test" };
  const git = args => execFileSync("git", args, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-b", "main"]);
  writeFileSync(join(repo, "context.md"), "initial\n");
  git(["add", "context.md"]); git(["commit", "-m", "Initial"]);
  const original = git(["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "context.md"), "predecessor output\n\n");
  git(["add", "context.md"]); git(["commit", "-m", "Integrate predecessor"]);
  const merged = git(["rev-parse", "HEAD"]);
  const exec = promisify(execFile);
  const g = makeGit({ config: { home, worktrees: join(home, "trees") }, exec: (cmd, args, opts) => {
    const options = { ...opts, env: { ...opts.env, ...env } };
    return cmd === "gh" ? exec("git", ["clone", "--no-checkout", repo, args[3]], options) : exec(cmd, args, options);
  } });
  const dir = await g.create({ nameWithOwner: "acme/widget", prdId: "second-step", base: "main" });
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf8" }).trim(), merged);
  assert.equal(await g.containsCommit(dir, original), true);
  assert.equal(await g.containsCommit(dir, merged), true);
  assert.equal(await g.fileAt(dir, "HEAD", "context.md"), "predecessor output\n\n");
  assert.equal(await g.fileAt(dir, "HEAD", "missing.md"), null);
  await assert.rejects(() => g.containsCommit(dir, "f".repeat(40)), /not a valid|bad object|fatal/);
});

test("durable start claims exclude another start and registration; only their owner can release or register", () => {
  const home = tempHome(), a = makeState(home), b = makeState(home), id = "acme/widget/task";
  assert.deepEqual(a.chains(), []);
  const claim = a.claimStart(id);
  assert.throws(() => b.claimStart(id), /unresolved start/);
  assert.throws(() => b.put(id, {}), /reserved/);
  b.releaseStart(id, "wrong-token");
  assert.equal(b.startClaim(id).token, claim.token);
  assert.throws(() => b.putStarted(id, {}, "wrong-token"), /claim changed/);
  a.putStarted(id, { repo: "acme/widget" }, claim.token);
  assert.equal(b.startClaim(id), null);
  assert.equal(b.get(id).start_token, claim.token);
  assert.throws(() => b.claimStart(id), /already exists/);
});
