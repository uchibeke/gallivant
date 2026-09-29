// Opt-in: node --test test/live-codex-git.mjs
// Uses the installed, signed-in Codex (and model calls), real Git, and a disposable local remote. No GitHub writes.
// Kept outside *.test.mjs so `npm test` never needs a login or spends a model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adapters, buildRun } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { checkVersion } from "../lib/probe.mjs";

test("Codex starts and resumes with working index, commit, push and upstream writes", { timeout: 600_000 }, async t => {
  const config = { harness: { codex: { bin: process.env.CODEX_BIN || "codex" } } };
  const version = await checkVersion("codex", config);
  assert.ok(version.ok, version.detail);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gallivant-codex-git-"));
  const cwd = join(root, "checkout");
  const remote = join(root, "remote.git");
  mkdirSync(cwd);
  // Use Gallivant's actual Git environment, with a test identity and no GitHub credential needed.
  const env = { ...process.env, ...runEnv(config, null, { name: "Git probe", email: "probe@example.invalid" }) };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--bare", remote);
  git("init", "-b", "gallivant/probe");
  git("remote", "add", "origin", remote);
  git("commit", "--allow-empty", "-m", "Initialize disposable probe");
  // Leave both the .git directory and the user's Codex config/rules alone. The compound command below reproduces
  // the shape that did NOT match simple saved `git add`/`git push` allow rules in the two failed production jobs.
  t.diagnostic(`Codex ${version.detail}; evidence: ${root}`);

  let session = null;
  for (const [mode, value] of [["start", "one"], ["resume", "two"]]) {
    const prompt = `This is an authorized Gallivant integration test in a disposable repository. The only remote is a local bare repository at ${remote}; do not use GitHub or change any other repository, permissions, rules, or hooks.
Run the following block as ONE shell tool call to reproduce a compound-command Git write. This one-call form is intentional for the regression test. If the sandbox requires approval for Git metadata, use the supported escalation request. An actual policy/reviewer denial must stop the test and be reported; do not route around it.
\n\`\`\`sh
set -e
cat > probe.txt <<'PROBE'
${value}
PROBE
git add -- probe.txt
git diff --cached --check
git commit -m 'Record probe ${value}'
git push -u origin gallivant/probe
\`\`\`
Then read back the remote branch and upstream and confirm they match HEAD. Do not claim success if any Git error remains. Stop after this probe; no other work is requested.`;
    const spec = buildRun({ harness: "codex", config, mode, session, prompt, cwd });
    const result = await new Promise(resolve => {
      const child = execFile(spec.cmd, spec.args, { cwd, env: { ...env, ...spec.env }, encoding: "utf8", timeout: 240_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
      child.stdin.end(); // Match the runner's ignored stdin; otherwise Codex waits for additional input forever.
    });
    writeFileSync(join(root, `${mode}.jsonl`), result.stdout, { mode: 0o600 });
    writeFileSync(join(root, `${mode}.stderr`), result.stderr, { mode: 0o600 });
    assert.ok(!result.error, `${mode} failed; inspect ${root}/${mode}.stderr`);
    const lines = result.stdout.split("\n");
    const outcome = adapters.codex.outcome(lines);
    assert.ok(outcome.ok, `${mode}: ${outcome.error}`);
    const reported = adapters.codex.sessionFrom(lines);
    if (session) assert.equal(reported, session, "resume must continue the same session");
    else session = reported;
    assert.ok(adapters.codex.isSession(session), "start must report a resumable session");
    assert.equal(readFileSync(join(cwd, "probe.txt"), "utf8"), `${value}\n`);
    assert.equal(git("status", "--porcelain"), "", `${mode}: no uncommitted or stale-index work`);
    assert.equal(git("log", "-1", "--format=%s"), `Record probe ${value}`);
    assert.equal(git("rev-parse", "--abbrev-ref", "@{upstream}"), "origin/gallivant/probe");
    assert.equal(git("rev-parse", "@{upstream}"), git("rev-parse", "HEAD"), `${mode}: tracking ref updated`);
    assert.equal(git("ls-remote", "origin", "refs/heads/gallivant/probe").split(/\s/)[0], git("rev-parse", "HEAD"), `${mode}: remote updated`);
    t.diagnostic(`${mode}: committed, pushed, and verified upstream and remote`);
  }
});
