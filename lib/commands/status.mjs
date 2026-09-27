// `gallivant status`: what needs you, what is running, and whether the daemon is alive. Built as a model first so
// `--json` and any UI get the same facts the text view shows.
import { STATES, handleFor } from "../state.mjs";
import { readDaemon } from "./up.mjs";
import { ago } from "../time.mjs";
// The one `retry.op` that is not a step on the way to a fix round, imported from the file that writes it so the two
// cannot drift into two spellings of one op.
import { READY_LABEL_WRITE } from "../tick.mjs";

export function model(ctx) {
  const { home, config, state, runnerFor, log } = ctx;
  const daemon = readDaemon(home);
  const rows = state.entries().map(([id, e]) => {
    const run = runnerFor(id).current();
    // A run is in flight from dispatch until the tick records its exit, whether or not the process is still alive.
    const inFlight = !!e.last?.run && e.last?.exit == null;
    const handle = handleFor(id, e);
    const round = `round ${e.iteration}/${config.max_iterations}`;
    let section, label, detail;
    if (e.state === STATES.needsHuman) { section = "needs_you"; label = "needs-human"; detail = e.reason; }
    // `gate_skipped` says the completion gate never ran, which is a different thing from passing it, and a person
    // deciding whether to merge on this line needs to be told which of the two it was.
    else if (e.state === STATES.ready) { section = "needs_you"; label = "ready"; detail = e.gate_skipped ? `green, no blocking findings, RECEIPT NOT CHECKED (${e.gate_skipped})` : "green, no blocking findings, receipt accepted"; }
    else if (e.state === STATES.done) { section = "done"; label = "done"; detail = ""; }
    // `retry` names the one GitHub write the tick is declining a step for, and it is the truest thing this row can say
    // while it is set. Without it, a start run whose identity block will not write read as "ended, settling on the next
    // tick" on every poll: the process HAD ended, and the tick was not settling it, it was retrying one write and
    // counting the failures. It outranks the run's own liveness because it is what the entry is actually waiting on.
    //
    // The label cannot come from the state alone. A `pr-open` entry is `fixing` for the two removals, which a fix round
    // genuinely follows, but the ready-label WRITE is reached only after every readiness condition has passed: checks
    // green, reviewer clear, receipt accepted. Nothing is being fixed, the PR is one label away from a person, and the
    // row said `fixing` for it because the state was the only thing consulted. `blocked` says the entry is finished and
    // held up by GitHub, which is what the operator needs to hear.
    else if (e.retry) { section = "running"; label = e.retry.op === READY_LABEL_WRITE ? "blocked" : e.state === STATES.running ? "implementing" : "fixing"; detail = `${e.retry.op} failing (${e.retry.count}), retrying`; }
    else if (inFlight) { section = "running"; label = e.state === STATES.running ? "implementing" : "fixing"; detail = run?.running ? (e.last?.event || "") : "ended, settling on the next tick"; }
    else if (e.state === STATES.running) { section = "running"; label = "starting"; detail = "waiting for the daemon to settle the run"; }
    else { section = "running"; label = "waiting"; detail = e.rereview?.nudged ? "on reviewer, nudged once" : "on reviewer"; }
    return { id, handle, section, label, detail, round, state: e.state, reason: e.reason, gate_skipped: e.gate_skipped ?? null, retry: e.retry ?? null, pr: e.pr, url: e.url || null, harness: e.harness, since: e.updated_at, run: run ? { id: run.id, running: run.running, startedAt: run.startedAt } : null };
  });
  return {
    daemon: daemon ? { alive: daemon.alive, pid: daemon.pid, startedAt: daemon.startedAt, lastTick: daemon.lastTick, nextTick: daemon.nextTick, probes: daemon.probes || {} } : null,
    latestError: log.latest(),
    needs_you: rows.filter(r => r.section === "needs_you"),
    running: rows.filter(r => r.section === "running"),
    done: rows.filter(r => r.section === "done"),
  };
}

const pad = (s, n) => String(s ?? "").padEnd(n);

export function render(m, { all = false, clock = Date } = {}) {
  const lines = [];
  if (!m.daemon || !m.daemon.alive) lines.push("gallivant  daemon DOWN  run: gallivant up");
  else {
    const probes = Object.entries(m.daemon.probes).map(([k, p]) => `${k} ${p.ok ? "ok" : "FAIL"}`).join("  ");
    const next = m.daemon.nextTick ? `next in ${Math.max(0, Math.round((Date.parse(m.daemon.nextTick) - clock.now()) / 1000))}s` : "";
    lines.push(`gallivant  daemon up since ${ago(m.daemon.startedAt, clock)}  last tick ${ago(m.daemon.lastTick, clock)}  ${next}  ${probes}`);
  }
  if (m.latestError) lines.push(`latest error: ${m.latestError}`);
  const section = (title, rows) => {
    lines.push("", title);
    if (!rows.length) { lines.push("  (none)"); return; }
    for (const r of rows) {
      const hint = r.label === "needs-human" ? `gallivant why ${r.handle}` : r.label === "ready" ? (r.url || "") : "";
      lines.push(`  ${pad(r.handle, 26)} ${pad(r.label, 13)} ${pad(r.detail, 30)} ${pad(r.round, 11)} ${pad(ago(r.since, clock), 10)} ${hint}`.replace(/\s+$/, ""));
    }
  };
  section("NEEDS YOU", m.needs_you);
  section("RUNNING", m.running);
  if (all) section("DONE", m.done);
  return lines.join("\n");
}

export function status(ctx, { all = false, json = false } = {}) {
  const m = model(ctx);
  const text = json ? JSON.stringify(m, null, 2) : render(m, { all });
  return { text, exitCode: m.daemon?.alive ? 0 : 1 };
}
