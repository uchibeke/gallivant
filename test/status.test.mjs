// `gallivant status`: the model first, then the text and the exit code. The tracker UI reads the same model, so
// every claim about what an operator sees is made here against `model`, not against a rendered string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { model, render, status } from "../lib/commands/status.mjs";
import { READY_LABEL_REMOVAL, READY_LABEL_WRITE, COMPLETION_GATE } from "../lib/tick.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { processIdentity } from "../lib/daemon.mjs";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { CONFIG, T0, at, tempHome, makeClock, silentLog } from "./helpers.mjs";

const entryAt = (over = {}) => ({
  ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: null, repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, url: "https://github.com/acme/widget/pull/142", state: STATES.prOpen, nowIso: T0 }),
  ...over,
});

test("a completion gate wait names its cause instead of waiting on an already-clear reviewer", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ retry: { op: COMPLETION_GATE, count: 2, error: "aport verify 413: request_too_large" } }) } });
  const row = model(w.ctx).running[0];
  assert.equal(row.label, "blocked");
  assert.match(row.detail, /completion gate.*413/);
  assert.doesNotMatch(row.detail, /on reviewer/);
});

/** A registry, a daemon file if the test asks for one, and a runner fake per entry. */
function world({ entries = {}, daemon = null, runs = {} } = {}) {
  const home = tempHome();
  const state = makeState(home);
  for (const [id, e] of Object.entries(entries)) state.put(id, e);
  if (daemon) writeJsonAtomic(join(home, "daemon.json"), { identity: processIdentity(daemon.pid), ...daemon });
  const ctx = {
    home,
    config: { ...CONFIG, home },
    state,
    log: silentLog,
    runnerFor: id => ({ current: () => runs[id] ?? null }),
  };
  return { ctx, state, home };
}

test("a needs-human entry lands in needs_you with its reason as the detail", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.needsHuman, reason: "no-push", iteration: 2 }) } });
  const m = model(w.ctx);

  assert.equal(m.running.length, 0);
  assert.equal(m.done.length, 0);
  assert.deepEqual(m.needs_you.map(r => [r.handle, r.label, r.detail, r.round]), [["widget#142", "needs-human", "no-push", "round 2/3"]]);
});

test("a ready entry lands in needs_you too, because it is a person who merges it", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.ready }) } });
  const m = model(w.ctx);

  assert.deepEqual(m.needs_you.map(r => [r.label, r.detail]), [["ready", "green, no blocking findings, receipt accepted"]]);
  assert.equal(m.needs_you[0].url, "https://github.com/acme/widget/pull/142", "the link a person opens to merge is in the row");
});

test("a ready entry whose completion gate never ran says so, rather than reading like one that passed it", () => {
  // An entry with no PRD snapshot reaches ready on the checks and the reviewer alone, with nothing about what the PR
  // was supposed to deliver ever read. That used to be one line in errors.log and nothing on the row a person merges
  // from, which said exactly what it says for a PR whose receipt was accepted.
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.ready, gate_skipped: "no PRD snapshot" }) } });
  const row = model(w.ctx).needs_you[0];
  assert.match(row.detail, /RECEIPT NOT CHECKED \(no PRD snapshot\)/);
  assert.equal(row.gate_skipped, "no PRD snapshot", "and a UI reading the model can tell the two apart by a field");
});

test("a done entry is in done and nowhere else, so a merged PR never clutters the two live sections", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.done }) } });
  const m = model(w.ctx);

  assert.deepEqual([m.needs_you.length, m.running.length], [0, 0]);
  assert.deepEqual(m.done.map(r => [r.label, r.detail]), [["done", ""]]);
});

test("a pr-open entry waiting on the reviewer is running, and says whether it was already nudged", () => {
  const waiting = world({ entries: { "acme/widget/widget-export": entryAt({ rereview: { at: T0, nudged: false } }) } });
  assert.deepEqual(model(waiting.ctx).running.map(r => [r.label, r.detail]), [["waiting", "on reviewer"]]);

  const nudged = world({ entries: { "acme/widget/widget-export": entryAt({ rereview: { at: T0, nudged: true } }) } });
  assert.deepEqual(model(nudged.ctx).running.map(r => [r.label, r.detail]), [["waiting", "on reviewer, nudged once"]]);
});

test("a run in flight reads as running, labelled by whether it is the first session or a fix round", () => {
  const run = { id: "2026-09-24T02-00-00-000-fix", running: true, startedAt: Date.parse(T0) };
  const fixing = world({
    entries: { "acme/widget/widget-export": entryAt({ state: STATES.prOpen, last: { at: T0, run: run.id, exit: null, event: "review 2201 by chatgpt-codex-connector" } }) },
    runs: { "acme/widget/widget-export": run },
  });
  const fix = model(fixing.ctx).running;
  assert.deepEqual(fix.map(r => [r.label, r.detail]), [["fixing", "review 2201 by chatgpt-codex-connector"]]);
  assert.deepEqual(fix[0].run, { id: run.id, running: true, startedAt: run.startedAt }, "the row carries the run so a UI can link its log");

  const starting = world({
    entries: { "acme/widget/widget-export": entryAt({ state: STATES.running, pr: null, url: null, last: { at: T0, run: run.id, exit: null, event: "start" } }) },
    runs: { "acme/widget/widget-export": run },
  });
  assert.deepEqual(model(starting.ctx).running.map(r => [r.handle, r.label]), [["acme/widget/widget-export", "implementing"]], "no PR yet, so the handle is the registry id");
});

test("a run whose process is gone but whose exit the tick has not recorded says it is settling, not that it is working", () => {
  const run = { id: "2026-09-24T02-00-00-000-fix", running: false, startedAt: Date.parse(T0) };
  const w = world({
    entries: { "acme/widget/widget-export": entryAt({ last: { at: T0, run: run.id, exit: null, event: "review 2201 by chatgpt-codex-connector" } }) },
    runs: { "acme/widget/widget-export": run },
  });
  assert.deepEqual(model(w.ctx).running.map(r => [r.label, r.detail]), [["fixing", "ended, settling on the next tick"]]);
});

test("a running entry with no run recorded says it is waiting for the daemon rather than claiming progress", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.running, pr: null, url: null, last: null }) } });
  assert.deepEqual(model(w.ctx).running.map(r => [r.label, r.detail]), [["starting", "waiting for the daemon to settle the run"]]);
});

test("a daemon file left behind by a dead process reports dead, because liveness is asked of the operating system", () => {
  const dead = world({ daemon: { pid: 0x7ffffffe, startedAt: T0, lastTick: T0, nextTick: at(2), probes: { gh: { ok: true, detail: "me" } } } });
  const m = model(dead.ctx);
  assert.equal(m.daemon.alive, false, "a stale pid in daemon.json is not a running daemon");
  assert.equal(m.daemon.pid, 0x7ffffffe);
  assert.deepEqual(m.daemon.probes, { gh: { ok: true, detail: "me" } }, "the probes the daemon last recorded are still shown");

  const live = world({ daemon: { pid: process.pid, startedAt: T0, lastTick: T0, nextTick: at(2), probes: {} } });
  assert.equal(model(live.ctx).daemon.alive, true);
});

test("no daemon file at all is a null daemon block, not a crash", () => {
  assert.equal(model(world().ctx).daemon, null);
});

test("status exits 1 when no daemon is alive and 0 when one is, so a shell can tell", () => {
  assert.equal(status(world().ctx).exitCode, 1, "no daemon file");
  assert.equal(status(world({ daemon: { pid: 0x7ffffffe, startedAt: T0 } }).ctx).exitCode, 1, "a dead pid is not a daemon");
  assert.equal(status(world({ daemon: { pid: process.pid, startedAt: T0 } }).ctx).exitCode, 0);
});

test("the rendered text carries each entry's handle, label and round, under the section it belongs to", () => {
  const w = world({
    entries: {
      "acme/widget/widget-export": entryAt({ state: STATES.needsHuman, reason: "conflict", iteration: 1 }),
      "acme/widget/widget-import": entryAt({ pr: 143, url: "https://github.com/acme/widget/pull/143", branch: "gallivant/widget-import", rereview: { at: T0, nudged: false }, iteration: 2 }),
    },
    daemon: { pid: process.pid, startedAt: T0, lastTick: T0, nextTick: at(2), probes: { gh: { ok: true } } },
  });
  const clock = makeClock(at(1));
  const text = render(model(w.ctx), { clock });
  const line = label => text.split("\n").find(l => l.includes(label));

  assert.match(text, /^gallivant {2}daemon up since 1m ago {2}last tick 1m ago {2}next in 60s {2}gh ok$/m);
  assert.match(text, /^NEEDS YOU$/m);
  assert.match(line("needs-human"), /widget#142\s+needs-human\s+conflict\s+round 1\/3\s+1m ago\s+gallivant why widget#142/, "with the command that explains it");
  assert.match(text, /^RUNNING$/m);
  assert.match(line("waiting"), /widget#143\s+waiting\s+on reviewer\s+round 2\/3\s+1m ago/);
  assert.ok(text.indexOf("NEEDS YOU") < text.indexOf("RUNNING"), "what needs a person comes first");
});

test("a down daemon is the first thing the text says, with the command that starts one", () => {
  const text = render(model(world().ctx), { clock: makeClock() });
  assert.equal(text.split("\n")[0], "gallivant  daemon DOWN  run: gallivant up");
});

test("done entries are hidden unless --all asks for them", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.done }) } });
  const m = model(w.ctx);
  assert.ok(!/^DONE$/m.test(render(m, { clock: makeClock() })));
  assert.match(render(m, { all: true, clock: makeClock() }), /^DONE$/m);
});

test("--json prints the model itself, so a script and the text view cannot disagree", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.ready }) } });
  const { text } = status(w.ctx, { json: true });
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(model(w.ctx))));
});

test("the newest recorded error is in the model and in the header, so a problem nobody watched is not lost", () => {
  const w = world({ entries: { "acme/widget/widget-export": entryAt() } });
  w.ctx.log = { ...silentLog, latest: () => "2026-09-24T02:01:00.000Z error acme/widget/widget-export: gh: 403" };
  const m = model(w.ctx);

  assert.equal(m.latestError, "2026-09-24T02:01:00.000Z error acme/widget/widget-export: gh: 403");
  assert.match(render(m, { clock: makeClock() }), /^latest error: .*gh: 403$/m);
});

test("an entry retrying one GitHub write says so, rather than claiming a finished run is still settling", () => {
  // A start run whose identity block will not write keeps `last.exit` unrecorded on purpose, because that is the state
  // the next tick re-enters. The side effect was that `status` read the entry as a run in flight, and since the process
  // HAD ended, printed "ended, settling on the next tick" on every poll. The tick was not settling it; it was retrying
  // one write and counting the failures, which is the thing worth printing.
  const w = world({
    entries: { "acme/widget/widget-export": entryAt({ state: STATES.running, pr: null, url: null, last: { at: T0, run: "1-start", exit: null, event: "start" }, retry: { op: "PR #143 block write", count: 3 } }) },
    runs: { "acme/widget/widget-export": { id: "1-start", running: false, startedAt: Date.parse(T0) } },
  });
  const m = model(w.ctx);

  assert.deepEqual(m.running.map(r => [r.label, r.detail]), [["implementing", "PR #143 block write failing (3), retrying"]]);
  assert.deepEqual(m.running[0].retry, { op: "PR #143 block write", count: 3 }, "and the same facts reach --json and the tracker");
});

test("a pr-open entry retrying the READY label says blocked, not fixing: nothing is being fixed", () => {
  // The fourth caller of the retry bound interacts with this row, and the round that predicted a fourth would appear
  // flagged this as where to look. The prediction was about `retry` hiding a live run, which cannot happen (`settleRun`
  // returns before this branch while a run this entry owns is alive). The real interaction is the label: the other
  // three ops are steps on the way to a fix round, so `fixing` is true for them, but the ready-label WRITE is reached
  // only once checks are green, the reviewer is clear and the receipt is accepted. Reading `fixing` off the state alone
  // told the operator a round was under way on a PR that was one label away from them.
  const w = world({
    entries: { "acme/widget/widget-export": entryAt({ state: STATES.prOpen, retry: { op: READY_LABEL_WRITE, count: 3 } }) },
  });
  const m = model(w.ctx);
  assert.deepEqual(m.running.map(r => [r.label, r.detail]), [["blocked", "ready label write failing (3), retrying"]]);
  assert.deepEqual(m.running[0].retry, { op: READY_LABEL_WRITE, count: 3 }, "and --json and the tracker get the same facts");

  // The other ops on the same state are unchanged: a removal really does precede a fix round.
  const fixing = world({ entries: { "acme/widget/widget-export": entryAt({ state: STATES.prOpen, retry: { op: READY_LABEL_REMOVAL, count: 2 } }) } });
  assert.deepEqual(model(fixing.ctx).running.map(r => r.label), ["fixing"]);

  // And the row is not the "waiting on reviewer" fallback, which is what it used to be before this path was counted at
  // all: that said the entry was waiting on a reviewer who had already answered.
  assert.ok(!m.running.some(r => /reviewer/.test(r.detail)), "the row names GitHub, not the reviewer");
});

test("an entry with no retry in flight reads exactly as it did", () => {
  const w = world({
    entries: { "acme/widget/widget-export": entryAt({ state: STATES.running, last: { at: T0, run: "1-start", exit: null, event: "start" } }) },
    runs: { "acme/widget/widget-export": { id: "1-start", running: false, startedAt: Date.parse(T0) } },
  });
  assert.deepEqual(model(w.ctx).running.map(r => [r.label, r.detail]), [["implementing", "ended, settling on the next tick"]]);
});

/** A pid no process holds, found by asking rather than assumed: pid 1 is launchd and very much alive. */
const deadPid = () => { for (let p = 999_99; p > 40_000; p -= 7) { try { process.kill(p, 0); } catch (e) { if (e.code === "ESRCH") return p; } } throw new Error("no free pid found"); };

// --- a daemon running code that no longer exists ---------------------------------------------------------------------
//
// The failure these pin cost three hours of a live run. `gallivant up` is long lived and node caches modules at import,
// so a daemon started before an upgrade keeps executing the old code. There was no symptom pointing at the daemon: the
// runs it spawned failed the way the OLD code failed, on a gitconfig path the current code does not name, so it read as
// a sandbox problem. Every release can do this again, which is why the check is here rather than in a release note.

test("codeStamp moves when a module is written, so it can tell two versions of the code apart", async () => {
  const { codeStamp } = await import("../lib/fs.mjs");
  const dir = mkdtempSync(join(tmpdir(), "gallivant-stamp-"));
  writeFileSync(join(dir, "a.mjs"), "export const a = 1;\n");
  const first = codeStamp(dir);
  assert.ok(first, "a directory with a module has a stamp");

  // A second module written later moves the stamp forward: the newest mtime is what the daemon is compared against.
  utimesSync(join(dir, "a.mjs"), new Date(first + 5_000), new Date(first + 5_000));
  assert.ok(codeStamp(dir) > first, "the stamp follows the newest module");

  // A file that is not a module is not code and must not move it, or a log or a lockfile in lib/ would report every
  // daemon as stale forever.
  writeFileSync(join(dir, "notes.txt"), "not code");
  utimesSync(join(dir, "notes.txt"), new Date(first + 50_000), new Date(first + 50_000));
  assert.equal(codeStamp(dir), codeStamp(dir), "stable across calls");
  assert.ok(codeStamp(dir) < first + 50_000, "a non-module does not move the stamp");

  assert.equal(codeStamp(join(dir, "nope")), null, "a directory that is not there has no stamp, rather than throwing");
});

test("a live daemon whose code is older than the code on disk is reported stale, and told how to fix it", async () => {
  const { readDaemon } = await import("../lib/commands/up.mjs");
  const home = tempHome();
  // `process.pid` is this test, which is certainly alive: staleness is only meaningful for a daemon that is running.
  writeJsonAtomic(join(home, "daemon.json"), { pid: process.pid, identity: processIdentity(process.pid), startedAt: T0, lastTick: T0, code: 1, version: "0.1.0", probes: {} });
  const d = readDaemon(home);
  assert.equal(d.stale, true, "code stamped as 1ms after the epoch is older than anything on disk");

  const m = model({ state: makeState(home), config: CONFIG, home, log: silentLog });
  assert.equal(m.daemon.stale, true, "the model carries it, so the tracker sees it too");
  const text = render(m, { clock: makeClock(T0) });
  assert.match(text, /running code older than what is installed/);
  assert.match(text, /gallivant down && gallivant up/, "the line names the fix, not just the problem");
});

test("a daemon that recorded no stamp is reported neither fresh nor stale, because nothing was measured", async () => {
  const { readDaemon } = await import("../lib/commands/up.mjs");
  const home = tempHome();
  // Every daemon started before the stamp existed looks like this. Guessing either way would be worse than saying
  // nothing: `stale: true` would tell an operator to restart a daemon that may be current, and the warning would fire
  // once for every operator on upgrade.
  writeJsonAtomic(join(home, "daemon.json"), { pid: process.pid, startedAt: T0, lastTick: T0, probes: {} });
  assert.equal(readDaemon(home).stale, false);
  assert.doesNotMatch(render(model({ state: makeState(home), config: CONFIG, home, log: silentLog }), { clock: makeClock(T0) }), /older than what is installed/);
});

test("status does not suggest starting another daemon when a legacy owner is still alive", () => {
  const w = world({ daemon: { pid: process.pid, identity: "legacy process identity", startedAt: T0 } });
  const result = status(w.ctx);
  assert.equal(result.exitCode, 1);
  assert.match(result.text, /daemon UNVERIFIED/);
  assert.match(result.text, /verify and stop/);
  assert.doesNotMatch(result.text, /daemon DOWN|run: gallivant up/);
});

test("a dead daemon is never stale, whatever it was running", async () => {
  const { readDaemon } = await import("../lib/commands/up.mjs");
  const home = tempHome();
  // A stopped daemon's code version is not a thing to act on, and the header already says DOWN, so a second line about
  // staleness would be noise on top of the real answer. The pid has to be one that genuinely does not exist: pid 1 is
  // launchd, which IS alive, so it would be reported stale and correctly so.
  writeJsonAtomic(join(home, "daemon.json"), { pid: deadPid(), startedAt: T0, lastTick: T0, code: 1, stoppedAt: T0, probes: {} });
  assert.equal(readDaemon(home).stale, false);
});

// --- gallivant down -------------------------------------------------------------------------------------------------

test("down refuses clearly when there is no daemon to stop, rather than pretending it worked", async () => {
  const { down } = await import("../lib/commands/up.mjs");
  const home = tempHome();
  const none = down({ log: silentLog }, { home });
  assert.equal(none.stopped, false);
  assert.match(none.why, /no daemon has run/);

  // A heartbeat left behind by a daemon that has exited, so there is nothing to signal.
  writeJsonAtomic(join(home, "daemon.json"), { pid: deadPid(), startedAt: T0, lastTick: T0, stoppedAt: T0, probes: {} });
  const dead = down({ log: silentLog }, { home });
  assert.equal(dead.stopped, false);
  assert.match(dead.why, /no daemon is running/);
  assert.match(dead.why, /stopped at/, "it says the daemon stopped on purpose, which is not an error to chase");
});
