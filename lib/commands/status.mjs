// `gallivant status`: what needs you, what is running, and whether the daemon is alive. Built as a model first so
// `--json` and any UI get the same facts the text view shows.
import { STATES, handleFor } from "../state.mjs";
import { readDaemon } from "./up.mjs";
import { ago } from "../time.mjs";
// The one `retry.op` that is not a step on the way to a fix round, imported from the file that writes it so the two
// cannot drift into two spellings of one op.
import { READY_LABEL_WRITE } from "../tick.mjs";
import { briefDivergence, divergenceReason } from "../prd.mjs";

/**
 * The divergence for one entry, never fatal. `status` is what an operator runs when something already looks wrong, so a
 * brief that cannot be read must not be the thing that makes the whole command fail: the row loses one field and the
 * rest of the answer still arrives.
 */
function divergenceOf(ctx, id, entry, readPrd) {
  try { return briefDivergence({ id, entry, readPrd, readSource: ctx.readSource }); }
  catch { return { verdict: "unknown", why: "", diff: [] }; }
}

export function model(ctx) {
  const { home, config, state, runnerFor, log, readPrd = () => null } = ctx;
  const daemon = readDaemon(home);
  const rows = state.entries().map(([id, e]) => {
    // The brief compared with the operator's own copy, on every row that is still being worked on. The comparison is the
    // tick's too, but `status` runs it itself rather than reading a flag the tick left, for two reasons. An operator who
    // has JUST edited the brief will run `status` before the next tick comes round, and a row that only knew what the
    // last tick knew would say nothing for two minutes about the thing they are asking about. And `status` runs in the
    // operator's own session, where their checkout is present and readable, which is not guaranteed for the daemon.
    //
    // A `done` entry is not compared: it is merged or closed, there is nothing left to certify, and an operator
    // reorganising their briefs afterwards must not be told about finished work.
    const divergence = e.state === "done" ? { verdict: "unknown", why: "", diff: [] } : divergenceOf(ctx, id, e, readPrd);
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

    // A diverged brief outranks everything above and moves the row into NEEDS YOU, whatever the entry is otherwise
    // doing. It outranks them because it is the only thing on this row that says the work itself may be aimed at the
    // wrong target: a red check, a waiting reviewer and a retrying label are all questions about work whose brief nobody
    // disputes. And it moves sections because the operator is the only one who can resolve it, so a row sitting under
    // RUNNING would be telling them to wait for a daemon that is going to stop the entry the moment it judges it.
    //
    // The row says so for an entry the tick has ALREADY stopped too, where `reason` is one of the three: the reason
    // alone is a word, and `status` has room for the first difference, which is the thing the operator has to look at.
    const divReason = divergenceReason(divergence);
    if (divReason) {
      section = "needs_you";
      label = e.state === STATES.needsHuman ? "needs-human" : "brief-moved";
      detail = divergence.diff[0] ? `${divReason}: ${divergence.diff[0]}` : divReason;
    }
    return {
      id, handle, section, label, detail, round, state: e.state, reason: e.reason, gate_skipped: e.gate_skipped ?? null,
      // The branch this PR targets, or will target. It is on every row because the question "what will this open against?"
      // has a wrong answer that costs a whole run, and before the PR exists there is nowhere else to read it.
      base: e.base ?? null,
      // When the daemon last merged the base into this branch, so an operator can see the history was changed and when.
      base_merge: e.base_merge ?? null,
      retry: e.retry ?? null, pr: e.pr, url: e.url || null, harness: e.harness, since: e.updated_at,
      // `handle` rides along so a consumer can print the command that resolves it without rebuilding the handle from the
      // other fields: the tracker does exactly that, and `handleFor` is not its to know.
      divergence: divReason ? { verdict: divergence.verdict, reason: divReason, why: divergence.why, diff: divergence.diff, path: divergence.path ?? null, handle } : null,
      run: run ? { id: run.id, running: run.running, startedAt: run.startedAt } : null,
    };
  });
  return {
    daemon: daemon ? { alive: daemon.alive, pid: daemon.pid, startedAt: daemon.startedAt, lastTick: daemon.lastTick, nextTick: daemon.nextTick, probes: daemon.probes || {}, stale: Boolean(daemon.stale) } : null,
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
    // A daemon running code that no longer exists on disk. Its own line rather than a word in the header, because the
    // symptom it produces never points at the daemon: runs fail in whatever way the old code failed, so an operator
    // reads a sandbox error or a git error and debugs that instead. See `codeStamp` in lib/fs.mjs.
    if (m.daemon.stale) lines.push("           the daemon is running code older than what is installed; its runs use the old behaviour. Restart it: gallivant down && gallivant up");
  }
  if (m.latestError) lines.push(`latest error: ${m.latestError}`);
  const section = (title, rows) => {
    lines.push("", title);
    if (!rows.length) { lines.push("  (none)"); return; }
    for (const r of rows) {
      // `why` is the hint for a moved brief as well as for a stop, because `why` is where the whole difference is
      // printed and the row only has room for the first line of it.
      const hint = r.label === "needs-human" || r.label === "brief-moved" ? `gallivant why ${r.handle}` : r.label === "ready" ? (r.url || "") : "";
      // The base rides in the round column's neighbour rather than getting one of its own: it is short, it is constant for
      // the life of an entry, and a column of its own would push the hint off an 80-column terminal.
      lines.push(`  ${pad(r.handle, 26)} ${pad(r.label, 13)} ${pad(r.detail, 30)} ${pad(r.round, 11)} ${pad(r.base ? `-> ${r.base}` : "", 14)} ${pad(ago(r.since, clock), 10)} ${hint}`.replace(/\s+$/, ""));
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
