// `gallivant why`: the one screen that explains a stopped PR. It reads files only, so these tests give it a real
// runner root on disk and a registry in a temp dir, and assert on the text an operator actually reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { why } from "../lib/commands/why.mjs";
import { makeState } from "../lib/state.mjs";
import { makeRunner } from "../lib/run.mjs";
import { ensureDir } from "../lib/fs.mjs";
import { CONFIG, T0, at, tempHome, makeClock, seededState, silentLog, STATES, claudeResultLines, codexLines } from "./helpers.mjs";

const SESSION = "6f1c2d3e-1111-4111-8111-111111111111";

/**
 * A `why` context over a real run directory. `lines` are written to the run's log the way the harness would, and
 * `exit` is recorded in job.json, so `why` reads them through the same runner the daemon uses.
 */
function world({ entry = {}, lines = null, exit = 0, pid = null } = {}) {
  const home = tempHome();
  const { state, id } = seededState(entry);
  const root = join(home, "runs");
  const clock = makeClock();
  const runner = makeRunner(root, { clock, probe: p => p === pid });
  if (lines) {
    const runId = "2026-09-24T02-00-00-000-fix";
    ensureDir(runner.dirOf(runId), 0o700);
    writeFileSync(join(runner.dirOf(runId), "job.log"), lines.join("\n") + "\n");
    writeFileSync(join(runner.dirOf(runId), "job.json"), JSON.stringify({ id: runId, name: "fix", pid: pid ?? 424242, bin: "/bin/claude", startedAt: Date.parse(T0), exit, endedAt: Date.parse(at(2)) }));
    writeFileSync(join(root, "latest-run"), runId);
    state.update(id, { last: { ...(state.get(id).last || {}), at: at(2), run: runId, exit, event: "review 2201 by chatgpt-codex-connector" } });
  }
  const ctx = { home, config: { ...CONFIG, home }, state, log: silentLog, runnerFor: () => runner };
  return { ctx, state, id, runner };
}

test("the first line names the entry, its state, the reason it stopped and the round it stopped in", () => {
  const w = world({ entry: { state: STATES.needsHuman, reason: "no-push", iteration: 2 } });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out.split("\n")[0], /^widget\/widget-export\s+needs-human \(no-push\)\s+claude\s+round 2\/3$/);
});

test("the PR URL is shown, so the operator can open it from the same screen", () => {
  const w = world();
  assert.match(why(w.ctx, { handle: "widget#142" }), /^PR: https:\/\/github\.com\/acme\/widget\/pull\/142$/m);
});

test("the dispatched event and its time are shown, so it is clear what the harness was asked to do", () => {
  const w = world({ lines: claudeResultLines() });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out, /^last event: review 2201 by chatgpt-codex-connector at 2026-09-24T02:02:00\.000Z, exit 0$/m);
});

test("the run's exit code is shown for a run that has ended, and \"running\" for one still in flight", () => {
  const ended = world({ lines: claudeResultLines({ ok: false }), exit: 1 });
  assert.match(why(ended.ctx, { handle: "widget#142" }), /^run: .*2026-09-24T02-00-00-000-fix\s+exited 1$/m);

  const inFlight = world({ lines: claudeResultLines(), exit: null, pid: process.pid });
  assert.match(why(inFlight.ctx, { handle: "widget#142" }), /^run: .*\s+running$/m);
});

test("the harness's last message is shown, so the reason is in the harness's own words", () => {
  const w = world({ lines: claudeResultLines({ text: "I could not write to src/export.ts." }) });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out, /harness said:\n {2}I could not write to src\/export\.ts\./);
});

test("permission denials in the run log are listed one per line", () => {
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    JSON.stringify({ type: "result", is_error: false, result: "Done.", total_cost_usd: 0.4, permission_denials: [{ tool_name: "Bash", tool_input: { command: "sudo rm -rf /" } }, { tool_name: "WebFetch", tool_input: { url: "https://example.test" } }] }),
  ];
  const out = why(world({ lines }).ctx, { handle: "widget#142" });

  assert.match(out, /^permission denials:$/m);
  assert.match(out, /^ {2}- Bash: \{"command":"sudo rm -rf \/"\}$/m);
  assert.match(out, /^ {2}- WebFetch: \{"url":"https:\/\/example\.test"\}$/m);
});

test("a run with no denials says nothing about denials, so the list means something when it appears", () => {
  const out = why(world({ lines: claudeResultLines() }).ctx, { handle: "widget#142" });
  assert.ok(!/permission denials/.test(out));
});

test("the cost of the run is shown when the harness reported one", () => {
  const out = why(world({ lines: claudeResultLines({ cost: 1.25 }) }).ctx, { handle: "widget#142" });
  assert.match(out, /^cost: \$1\.25$/m);
});

test("the by-hand attach command is the one the entry's own harness understands", () => {
  const claude = world({ entry: { harness: "claude", session: SESSION } });
  assert.match(why(claude.ctx, { handle: "widget#142" }), new RegExp(`by hand: claude --resume ${SESSION} in the worktree`));

  const thread = "22222222-2222-4222-8222-222222222222";
  const codex = world({ entry: { harness: "codex", session: thread } });
  assert.match(why(codex.ctx, { handle: "widget#142" }), new RegExp(`by hand: codex resume ${thread} in the worktree`));
});

test("an entry with no run and no PR prints what it knows instead of throwing", () => {
  const w = world({ entry: { state: STATES.running, reason: null, pr: null, url: null, session: null, last: null } });
  let out;
  assert.doesNotThrow(() => { out = why(w.ctx, { handle: "widget/widget-export" }); });

  assert.match(out, /^widget\/widget-export\s+running\s+claude\s+round 0\/3$/m);
  assert.ok(!/^PR:/m.test(out), "nothing is invented for a PR that does not exist yet");
  assert.ok(!/^run:/m.test(out), "and nothing for a run that never started");
  assert.ok(!/^session:/m.test(out), "a codex entry before its first turn has no session id to attach to");
});

test("a codex run's outcome is read with the codex adapter, so the message is not lost to the wrong parser", () => {
  const w = world({ entry: { harness: "codex", session: "22222222-2222-4222-8222-222222222222" }, lines: codexLines({ ok: false, text: "The build is broken." }) });
  assert.match(why(w.ctx, { handle: "widget#142" }), /harness said:\n {2}The build is broken\./);
});

test("an unknown handle is refused by name rather than printing someone else's entry", () => {
  const w = world();
  assert.throws(() => why(w.ctx, { handle: "widget#999" }), /no entry for widget#999/);
});
