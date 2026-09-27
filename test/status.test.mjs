// `gallivant status`: the model first, then the text and the exit code. The tracker UI reads the same model, so
// every claim about what an operator sees is made here against `model`, not against a rendered string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { model, render, status } from "../lib/commands/status.mjs";
import { READY_LABEL_REMOVAL, READY_LABEL_WRITE } from "../lib/tick.mjs";
import { makeState, newEntry, STATES } from "../lib/state.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { CONFIG, T0, at, tempHome, makeClock, silentLog } from "./helpers.mjs";

const entryAt = (over = {}) => ({
  ...newEntry({ prd: "docs/prds/widget-export.md", harness: "claude", session: null, repo: "acme/widget", branch: "gallivant/widget-export", worktree: "/tmp/wt", pr: 142, url: "https://github.com/acme/widget/pull/142", state: STATES.prOpen, nowIso: T0 }),
  ...over,
});

/** A registry, a daemon file if the test asks for one, and a runner fake per entry. */
function world({ entries = {}, daemon = null, runs = {} } = {}) {
  const home = tempHome();
  const state = makeState(home);
  for (const [id, e] of Object.entries(entries)) state.put(id, e);
  if (daemon) writeJsonAtomic(join(home, "daemon.json"), daemon);
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
