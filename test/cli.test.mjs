import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { GOOD_PRD, tempHome, CONFIG, seededState } from "./helpers.mjs";
import { processIdentity } from "../lib/daemon.mjs";
import { codeStamp, writeJsonAtomic } from "../lib/fs.mjs";

test("chain CLI shows persisted progress, retries explicitly and cancels future work", () => {
  const { home, state } = seededState();
  writeJsonAtomic(join(home, "config.json"), { ...CONFIG, worktrees: tempHome(), harness: { codex: { bin: process.execPath } }, notify: null });
  state.createChain({ name: "launch", repo: "acme/widget", base: "main", status: "stopped", index: 0, reason: "GitHub unavailable",
    steps: ["foundation", "release"].map(id => ({ id: `acme/widget/${id}`, path: `/repo/docs/prds/${id}.md`, dispatch: null })) });
  const run = args => spawnSync(process.execPath, [new URL("../bin/gallivant.mjs", import.meta.url).pathname, "chain", ...args], {
    env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8", timeout: 5000,
  });
  const listed = run([]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /launch: stopped.*0\/2 merged.*GitHub unavailable/);
  const retried = run(["launch", "--retry", "--no-daemon"]);
  assert.equal(retried.status, 0, retried.stderr);
  assert.equal(state.getChain("launch").status, "active");
  const cancelled = run(["launch", "--cancel"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(state.getChain("launch").status, "cancelled");
  assert.equal(run(["launch", "--retry"]).status, 1);
  assert.equal(run(["launch", "--cancel", "--retry"]).status, 1);
});

test("ready --check ignores invalid runtime config and leaves the brief and home unchanged", () => {
  const home = tempHome();
  const path = join(tempHome(), "docs/prds/widget-export.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, GOOD_PRD);
  writeFileSync(join(home, "config.json"), "{invalid configuration");
  const before = readdirSync(home);
  const cli = new URL("../bin/gallivant.mjs", import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [cli, "ready", path, ...args], {
    env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8", timeout: 5000,
  });
  const checked = run(["--check"]);
  assert.equal(checked.status, 0, checked.stderr + checked.stdout);
  assert.match(checked.stdout, /ok/);
  assert.equal(checked.stderr, "");
  assert.equal(readFileSync(path, "utf8"), GOOD_PRD);
  assert.deepEqual(readdirSync(home), before);
  const recorded = run([]);
  assert.equal(recorded.status, 1);
  assert.match(recorded.stderr, /config|JSON/i);
  assert.equal(readFileSync(path, "utf8"), GOOD_PRD);
});

test("say and recheck refuse stale daemons before saving anything, including with --no-daemon", () => {
  const { home, state, id } = seededState();
  writeJsonAtomic(join(home, "config.json"), { ...CONFIG, worktrees: tempHome(), harness: { codex: { bin: process.execPath } }, notify: null });
  const daemon = { pid: process.pid, identity: processIdentity(process.pid), code: 1 };
  assert.ok(daemon.identity);
  writeJsonAtomic(join(home, "daemon.json"), daemon);
  const before = readFileSync(state.file, "utf8");
  const run = args => spawnSync(process.execPath, [new URL("../bin/gallivant.mjs", import.meta.url).pathname, ...args], {
    env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8", timeout: 5000,
  });
  for (const command of [["say", id, "--note", "Please check the fixture."], ["recheck", id]]) {
    for (const flags of [[], ["--no-daemon"]]) {
      const result = run([...command, ...flags]);
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.match(result.stderr, /older code.*gallivant down && gallivant up/);
      assert.doesNotMatch(result.stdout, /queued/);
      assert.equal(readFileSync(state.file, "utf8"), before);
    }
  }
  // Simulate a restart: the same request now succeeds without creating a second daemon.
  writeJsonAtomic(join(home, "daemon.json"), { ...daemon, code: codeStamp() });
  const current = run(["say", id, "--note", "Please check the fixture."]);
  assert.equal(current.status, 0, current.stderr + current.stdout);
  assert.match(current.stdout, /message queued/);
  assert.equal(state.get(id).control.note, "Please check the fixture.");
});
