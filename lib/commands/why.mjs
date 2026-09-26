// `gallivant why <handle>`: the reason a PR stopped, what was dispatched, what the harness last said, any permission
// denials, and APort audit lines from the run's window. Reads files; never calls GitHub.
import { resolveHandle } from "../state.mjs";
import { adapterFor } from "../harness.mjs";
import { contract } from "../fs.mjs";
import { aportDirFor, auditEntries } from "../aport.mjs";

export function why(ctx, { handle }) {
  const { config, state, runnerFor } = ctx;
  const id = resolveHandle(state.entries(), handle);
  const e = state.get(id);
  const runner = runnerFor(id);
  const runId = e.last?.run || runner.current()?.id || null;
  const job = runId ? runner.read(runId) : null;
  const lines = runId ? runner.lines(runId) : [];
  const outcome = lines.length ? adapterFor(e.harness).outcome(lines) : null;
  const out = [];
  out.push(`${id}  ${e.state}${e.reason ? ` (${e.reason})` : ""}  ${e.harness}  round ${e.iteration}/${config.max_iterations}`);
  if (e.url) out.push(`PR: ${e.url}`);
  if (e.gate_skipped) out.push(`completion gate: NOT RUN (${e.gate_skipped}); no acceptance criterion was evaluated for this PR`);
  if (e.worktree) out.push(`worktree: ${contract(e.worktree)}`);
  if (e.session) out.push(`session: ${e.session}  (by hand: ${adapterFor(e.harness).attach({ pr: e.pr, session: e.session })} in the worktree)`);
  if (e.last) out.push(`last event: ${e.last.event}${e.last.at ? ` at ${e.last.at}` : ""}${e.last.exit != null ? `, exit ${e.last.exit}` : ""}${e.last.error ? `, error: ${e.last.error}` : ""}`);
  if (job) out.push(`run: ${contract(runner.dirOf(job.id))}  ${job.exit === null ? "running" : `exited ${job.exit}`}${job.killed ? " (killed)" : ""}`);
  if (outcome) {
    if (outcome.cost != null) out.push(`cost: $${outcome.cost.toFixed(2)}`);
    if (outcome.denials?.length) out.push("permission denials:", ...outcome.denials.map(d => `  - ${d}`));
    if (outcome.lastMessage) out.push("", "harness said:", indent(outcome.lastMessage.trim().slice(-2000)));
  }
  if (job) {
    const audit = auditEntries(aportDirFor(config.harness?.claude?.settings), { fromMs: job.startedAt, toMs: job.endedAt || Date.now(), filter: /allow=false|den|block|warn/i }).slice(-40);
    if (audit.length) out.push("", "APort audit (run window):", ...audit.map(l => "  " + l));
  }
  return out.join("\n");
}

const indent = s => s.split("\n").map(l => "  " + l).join("\n");
