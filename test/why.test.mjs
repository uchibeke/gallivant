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

  assert.match(out, /^permission denials \(the call, and the guardrail's reason where the run recorded it\):$/m);
  assert.match(out, /^ {2}- Bash: \{"command":"sudo rm -rf \/"\}$/m);
  assert.match(out, /^ {2}- WebFetch: \{"url":"https:\/\/example\.test"\}$/m);
});

/**
 * The legibility defect a live run exposed. APort blocked `grep -n ... web/src/lib/products.config.ts` on the pattern
 * "Access to sensitive configuration files", which is a broad pattern catching a legitimate read of a project source
 * file. The APort audit line names the pattern and carries no path; `permission_denials` names the path and carries no
 * reason. Neither half alone lets an operator tell that block from a correct one, and both halves were already in the
 * run's own log, joined by the tool_use_id they share.
 */
test("a denied call is printed with the guardrail's own reason, so the operator sees which path tripped which pattern", () => {
  const id = "toolu_01Lm6fj83qdiChPdG95xATji";
  const cmd = "grep -n \"productPages\" web/src/lib/products.config.ts";
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } }),
    JSON.stringify({
      type: "user",
      tool_result_meta: [{ id, non_execution_kind: "permission-rule" }],
      message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "APort denied this tool call. Policy: bash. Reason: oap.blocked_pattern. Detail: Command contains dangerous pattern: Access to sensitive configuration files." }] },
    }),
    JSON.stringify({ type: "result", is_error: false, result: "Done.", total_cost_usd: 0.4, permission_denials: [{ tool_name: "Bash", tool_use_id: id, tool_input: { command: cmd } }] }),
  ];
  const out = why(world({ lines }).ctx, { handle: "widget#142" });

  // The path is on the call line and the pattern that fired is on the line under it, indented beneath the bullet.
  assert.match(out, /^ {2}- Bash: .*products\.config\.ts/m, "the denied call still names the path it was denied on");
  assert.match(out, /^ {4}APort denied this tool call\..*Access to sensitive configuration files\.$/m, "and the guardrail's reason is under it");
});

test("a denied call whose reason the stream did not record prints as the call alone, inventing no reason", () => {
  const id = "toolu_nothing_recorded";
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", session_id: SESSION }),
    // An ordinary tool error, not a guardrail refusal: no permission-rule meta and no APort sentence. It must not be
    // read as the reason a different call was denied.
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true, content: "grep: no such file" }] } }),
    JSON.stringify({ type: "result", is_error: false, result: "Done.", total_cost_usd: 0.4, permission_denials: [{ tool_name: "Bash", tool_use_id: id, tool_input: { command: "grep x y" } }] }),
  ];
  const out = why(world({ lines }).ctx, { handle: "widget#142" });

  assert.match(out, /^ {2}- Bash: \{"command":"grep x y"\}$/m);
  assert.ok(!/no such file/.test(out), "a failing command's stderr is not a guardrail reason and is not shown as one");
});

test("a run with no denials says nothing about denials, so the list means something when it appears", () => {
  const out = why(world({ lines: claudeResultLines() }).ctx, { handle: "widget#142" });
  assert.ok(!/permission denials/.test(out));
});

/**
 * The timeout kill, on the screen an operator runs when something is already wrong. Being killed mid-commit is the worst
 * moment there is and the daemon has no notion of "nearly done", so the least it can do is say what it interrupted. The
 * uncommitted case is the one worth shouting about: `resume` recreates a missing worktree without asking, so an operator
 * who does not know those files exist can lose a whole review round by doing the obvious thing.
 */
test("a timeout kill names the limit it exceeded and warns about uncommitted work in the worktree", () => {
  const w = world({ entry: { state: STATES.needsHuman, reason: "timeout", worktree: "/tmp/wt", timeout: { limit: 30, source: "config", ran_minutes: 31, unpushed: 0, modified: 6, untracked: 4 } } });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out, /^killed: ran 31m and exceeded its 30m timeout \(the global run_timeout_minutes\)\./m, "the limit and where it was set, so the right number gets raised");
  assert.match(out, /UNCOMMITTED WORK IN THE WORKTREE: 6 modified, 4 untracked/, "the count, in the operator's own terms");
  assert.match(out, /held by no commit and in no PR/);
  assert.match(out, /git -C \/tmp\/wt status/, "and the command that shows them");
  assert.match(out, /Do NOT delete or recreate the checkout/, "with the warning that stops the obvious way to lose them");
});

test("a kill against a repository's own timeout says so, rather than blaming the global", () => {
  const w = world({ entry: { state: STATES.needsHuman, reason: "timeout", timeout: { limit: 90, source: "repo", ran_minutes: 95, unpushed: 0, modified: 0, untracked: 0 } } });
  assert.match(why(w.ctx, { handle: "widget#142" }), /exceeded its 90m timeout \(configured for widget\)/);
});

test("a kill with commits made but not pushed says that instead, and a clean one says nothing was stranded", () => {
  const committed = world({ entry: { state: STATES.needsHuman, reason: "timeout", timeout: { limit: 30, source: "config", ran_minutes: 31, unpushed: 4, modified: 0, untracked: 0 } } });
  const out = why(committed.ctx, { handle: "widget#142" });
  assert.match(out, /4 commits had been made and not pushed/);
  assert.ok(!/UNCOMMITTED WORK/.test(out), "a clean tree does not raise the uncommitted warning");

  // The case the timeout exists for. Saying so outright is what makes the warning above mean something when it appears.
  const clean = world({ entry: { state: STATES.needsHuman, reason: "timeout", timeout: { limit: 30, source: "config", ran_minutes: 31, unpushed: 0, modified: 0, untracked: 0 } } });
  assert.match(why(clean.ctx, { handle: "widget#142" }), /the worktree was clean and nothing was committed unpushed, so the kill stranded no work/);
});

test("an entry that did not stop for a timeout says nothing about a kill", () => {
  const out = why(world({ entry: { state: STATES.needsHuman, reason: "no-push" } }).ctx, { handle: "widget#142" });
  assert.ok(!/killed:/.test(out), "the block appears only for the stop it describes");
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

test("a retry in progress is explained, with what is failing and what happens if it keeps failing", () => {
  const w = world({ entry: { state: STATES.running, retry: { op: "ready label removal", count: 3 } } });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out, /waiting on GitHub: ready label removal has failed 3 ticks in a row/);
  assert.match(out, /the entry stops with "stuck" if it keeps failing/, "so the operator knows the wait is bounded and does not have to guess");
  assert.doesNotMatch(out, /otherwise ready/, "a removal is a step toward a fix round, not a PR held one label short");

  // The ready-label WRITE is the one op that means everything a person waits for has already happened. An operator
  // reading this screen needs to know the PR is finished and GitHub is the only thing in the way, because the action is
  // to fix a token, not to look at the diff.
  const blocked = world({ entry: { state: STATES.prOpen, retry: { op: "ready label write", count: 2 } } });
  const out2 = why(blocked.ctx, { handle: "widget#142" });
  assert.match(out2, /waiting on GitHub: ready label write has failed 2 ticks in a row/);
  assert.match(out2, /this PR is otherwise ready: checks green, reviewer clear, receipt accepted/);
  assert.match(out2, /Only the status:ready-for-review label will not write/);
});

test("a stopped entry names the write that would not land, so `stuck` is never a bare word", () => {
  const w = world({ entry: { state: STATES.needsHuman, reason: "stuck", last: { at: at(2), event: "PR #143 block write failed 5 ticks in a row: HTTP 403: Resource not accessible by personal access token" } } });
  const out = why(w.ctx, { handle: "widget#142" });

  assert.match(out, /needs-human \(stuck\)/);
  assert.match(out, /PR #143 block write failed 5 ticks in a row: HTTP 403/);
  assert.doesNotMatch(out, /waiting on GitHub/, "the counter is cleared by the stop, so nothing says it is still retrying");
});
