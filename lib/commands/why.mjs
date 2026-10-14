// `gallivant why <handle>`: the reason a PR stopped, what was dispatched, what the harness last said, any permission
// denials, and APort audit lines from the run's window. Reads files; never calls GitHub.
import { resolveHandle, shortRepo } from "../state.mjs";
import { adapterFor } from "../harness.mjs";
import { prdDivergence, divergenceReason, renderDivergence, prdDecision, sourceDivergence } from "../prd.mjs";
import { contract } from "../fs.mjs";
import { aportDirFor, auditEntries } from "../aport.mjs";
import { READY_LABEL_WRITE, COMPLETION_GATE } from "../tick.mjs";
import { READY_LABEL } from "../gh.mjs";
import { executionRunner } from "../execution.mjs";
import { redact } from "../execution_io.mjs";

export function why(ctx, { handle }) {
  const { config, state, runnerFor, readPrd = () => null } = ctx;
  const id = resolveHandle(state.entries(), handle);
  const e = state.get(id);
  const runner = executionRunner(ctx, id);
  const runId = e.last?.run || runner.current()?.id || null;
  const job = runId ? runner.read(runId) : null;
  const lines = runId && !runner.outcome ? runner.lines(runId) : [];
  const outcome = redact(runId && runner.outcome ? runner.outcome(runId) : lines.length ? adapterFor(e.harness).outcome(lines) : null);
  const out = [];
  out.push(`${id}  ${e.state}${e.reason ? ` (${e.reason})` : ""}  ${e.harness}  round ${e.iteration}/${config.max_iterations}`);
  if (e.url) out.push(`PR: ${e.url}`);
  if (e.execution) out.push(`provider: ${e.execution.providerState}; observed ${e.execution.observedAt ?? "unknown"}; reconciled ${e.execution.reconciledAt ?? "never"}; next ${e.execution.nextAttemptAt ?? "unknown"}; action ${e.execution.recoveryAction ?? "none"}`);
  if (e.control) out.push(`operator request: ${e.control.action} ${e.control.status}${e.control.message ? ` — ${e.control.message}` : " (waiting for the daemon and any active run)"}`);
  // The branch this pull request targets. Printed whether or not the PR exists yet, because the case worth catching is
  // the one before it exists: a branch cut from the wrong base and a session told to open against the wrong base are
  // both this line being wrong, and both cost a whole run to find out any other way.
  if (e.base) out.push(`base: ${e.base}  (the branch this PR targets, and the one merged in before each round)`);
  // A merge the daemon made is a change to this branch's history that nobody typed, so it is reported rather than left in
  // the log: an operator reading a diff they did not expect needs to know where the extra commit came from.
  if (e.base_merge) {
    out.push(e.base_merge.conflict
      ? `base merge FAILED at ${e.base_merge.at}: origin/${e.base_merge.base} could not be merged into ${e.branch} (${e.base_merge.why}). The merge was aborted, so the checkout is clean.`
      : `base merge: origin/${e.base_merge.base} was merged into ${e.branch} at ${e.base_merge.at}${e.base_merge.sha ? ` as ${e.base_merge.sha.slice(0, 7)}` : ""}${e.base_merge.onto ? `, onto ${e.base_merge.onto.slice(0, 7)}` : ""}. History was added to, never rewritten: no rebase, no force-push.`);
  }
  // A kill is the one stop an operator cannot reconstruct from anything else on this screen: `state` says needs-human,
  // `reason` says timeout, and the exit is 137, none of which says what the run was doing when SIGKILL landed. The run
  // this block was written for had finished: four commits made, its tests green, and the session writing a commit
  // message. So the limit it exceeded is named, and so is where that limit was set, because raising the wrong one of
  // the global and the repository's own is the obvious next mistake.
  if (e.timeout) {
    const where = e.timeout.source === "task" ? "the remaining authorized task runtime allowance" : e.timeout.source === "repo" ? `configured for ${shortRepo(e.repo)}` : "the global run_timeout_minutes";
    out.push(`killed: ran ${e.timeout.ran_minutes}m and exceeded its ${e.timeout.limit}m timeout (${where}). SIGKILL, so the session had no chance to finish what it was doing; the run log below is the last thing it did.`);
    if (e.timeout.source === "task") out.push("  Raising repository or global timeouts cannot extend the saved task allowance; inspect the original authorization before requesting further work.");
    // Work the kill left behind, uncommitted first because it is the fragile half and the half nothing else reports. A
    // run killed one tool call before `git commit` has an unpushed count of zero and a tree full of work, so a commit
    // count alone would have said "nothing stranded" about the worst case there is.
    const { modified = 0, untracked = 0, unpushed = 0 } = e.timeout;
    if (modified || untracked) {
      out.push(`  UNCOMMITTED WORK IN THE WORKTREE: ${modified} modified, ${untracked} untracked, held by no commit and in no PR.`,
        "  A SIGKILL can land between the last edit and `git commit`, and this one did. Nothing on GitHub reflects these files.",
        `  Read them before anything else touches that directory: \`git -C ${e.worktree || "<worktree>"} status\`.`,
        "  Do NOT delete or recreate the checkout: `gallivant resume` rebuilds a missing worktree without asking, which would discard this.");
    }
    if (unpushed) out.push(`  ${unpushed} commit${unpushed === 1 ? "" : "s"} had been made and not pushed, so that work is in the worktree only. \`gallivant resume\` pushes them rather than redoing them.`);
    if (!modified && !untracked && !unpushed) out.push("  the worktree was clean and nothing was committed unpushed, so the kill stranded no work.");
  }
  if (e.gate_skipped) out.push(`completion gate: NOT RUN (${e.gate_skipped}); no acceptance criterion was evaluated for this PR`);

  // The brief against the operator's own copy, with every difference spelled out. This is the place the whole diff goes:
  // `status` has one line per row and the tracker has a paragraph, and neither of those can hold five criteria. It is
  // printed for a stopped entry and for a running one alike, because an operator who edited the brief two minutes ago
  // will ask `why` before the daemon's next tick has had a chance to stop anything.
  //
  // What the gate does about it is stated outright rather than left to be inferred, because the useful thing to know is
  // not that the files differ, it is that no decision is being made about either of them until a person says which brief
  // is the brief.
  // The carried files, before the brief's own divergence, because a document that moved is the cheaper thing to check
  // and an operator reading this wants both in one place. It is its own block rather than folded into the brief's four
  // verdicts: a document has two states, the snapshot's bytes or not, since nothing validates its shape.
  const carried = sourceDivergence({ id, entry: e, readSource: ctx.readSource });
  if (carried.changed.length || carried.missing.length) {
    out.push("", `${carried.checked.length} file${carried.checked.length === 1 ? "" : "s"} carried with this brief, and not all of them still match:`);
    for (const f of carried.changed) out.push(`  changed  ${f}`);
    for (const f of carried.missing) out.push(`  gone     ${f}`);
    out.push("  The session was given the snapshot's copy, so it is working from what was carried and not from what is",
      "  in your tree now. A changed file is a decision about which version is the brief; a file that is gone is a",
      "  question about whether the work still stands.");
  }

  const div = divergenceFor(ctx, id, e, readPrd);
  if (divergenceReason(div)) {
    out.push("", `the brief has changed since this run started (${divergenceReason(div)}): ${div.why}`);
    out.push(renderDivergence(div));
    if (div.verdict === "changed") {
      out.push("  The completion gate is judging NEITHER brief: the snapshot is one the operator has moved on from, and",
        "  the edited copy names criteria this session was never given and has not attested. Decide which is the brief:",
        `    gallivant resume ${e.pr ? `${shortRepo(e.repo)}#${e.pr}` : id} --resnapshot   # the edit is the brief; the session is told what moved`,
        `    (or put the brief back the way it was, and the next tick carries on)`);
    }
    if (div.verdict === "illegal") out.push(`  ${div.path} would be refused by \`gallivant start\` as it stands. Fix it, then \`gallivant ready\` it again.`);
    if (div.verdict === "gone") out.push("  Restore the file, or `gallivant remove` the entry if the work is no longer wanted.");
    // A decision id that moved says the operator re-ran `ready`, which is a deliberate re-blessing of the brief rather
    // than a stray edit. It is reported and never relied on: `ready` leaves it untouched on a brief that was already
    // ready, and a hand-edit that misses the frontmatter leaves it identical, so it can only ever add confidence to an
    // answer the contract comparison has already given.
    const now = div.repo ? prdDecision(div.repo) : null;
    if (e.prd_decision && now && e.prd_decision !== now) out.push(`  and it was re-readied: aport_decision ${e.prd_decision} became ${now}, so the edit was blessed by \`gallivant ready\`.`);
    else if (e.prd_decision && now === e.prd_decision) out.push(`  aport_decision is unchanged (${e.prd_decision}), so the edit has not been through \`gallivant ready\`.`);
  }
  if (e.retry) out.push(`waiting on ${e.retry.op === COMPLETION_GATE ? "completion verification" : "GitHub"}: ${e.retry.op} has failed ${e.retry.count} tick${e.retry.count === 1 ? "" : "s"} in a row; the entry stops with "stuck" if it keeps failing`);
  if (e.retry?.op === COMPLETION_GATE) out.push(`  checks green and reviewer clear; completion verification is pending: ${e.retry.error ?? "no decision from the gate"}`);
  // The one retry whose op is not a step toward a fix round: everything a person waits for has already happened and
  // only the label that says so will not write, which is worth spelling out where the operator is already reading.
  if (e.retry?.op === READY_LABEL_WRITE) out.push(`  this PR is otherwise ready: checks green, reviewer clear, receipt accepted. Only the ${READY_LABEL} label will not write.`);
  // The round comment is the announcement of a round that is already counted, so the operator needs both halves: the
  // work is on the branch and charged, and the PR does not say so. The second half matters because the count on GitHub
  // is what a recovery rebuilds from, so an unposted marker is a round a recovery after this would not see.
  if (e.round_comment) {
    const recovered = e.iteration - 1;
    out.push(`  round ${e.iteration} is counted and its push is on the branch; only the comment announcing it is missing, so a recovery from GitHub would count ${recovered} round${recovered === 1 ? "" : "s"} until it posts.`);
  }
  if (e.worktree) out.push(`worktree: ${contract(e.worktree)}`);
  if (e.session) out.push(runner.capabilities?.transport === "remote" ? `session: ${e.session} (owned by ${e.harness}; use its recorded recovery action)` : `session: ${e.session}  (by hand: ${adapterFor(e.harness).attach({ pr: e.pr, session: e.session })} in the worktree)`);
  if (e.last) out.push(`last event: ${e.last.event}${e.last.at ? ` at ${e.last.at}` : ""}${e.last.exit != null ? `, exit ${e.last.exit}` : ""}${e.last.error ? `, error: ${e.last.error}` : ""}`);
  if (job) out.push(`run: ${contract(runner.dirOf(job.id))}  ${job.exit === null ? "running" : `exited ${job.exit}`}${job.killed ? " (killed)" : ""}`);
  if (outcome) {
    if (outcome.cost != null) out.push(`cost: $${outcome.cost.toFixed(2)}`);
    // Each denial carries the call that was denied and, where the run's own stream recorded it, the guardrail's reason
    // on the line beneath. Both come from the same log: the APort audit file printed below names the pattern that fired
    // and never the path it fired on, so the pairing here is the only place an operator can see a broad pattern catching
    // a legitimate read. A denial whose reason the stream did not carry prints as the call alone.
    if (outcome.denials?.length) out.push("permission denials (the call, and the guardrail's reason where the run recorded it):", ...outcome.denials.map(d => `  - ${d}`));
    if (outcome.lastMessage) out.push("", "harness said:", indent(outcome.lastMessage.trim().slice(-2000)));
  }
  if (job) {
    const audit = auditEntries(aportDirFor(config.harness?.claude?.settings), { fromMs: job.startedAt, toMs: job.endedAt || Date.now(), filter: /allow=false|den|block|warn/i }).slice(-40);
    if (audit.length) out.push("", "APort audit (run window):", ...audit.map(l => "  " + l));
  }
  return out.join("\n");
}

const indent = s => s.split("\n").map(l => "  " + l).join("\n");

/** Never fatal, for the same reason `status`'s is not: `why` is what an operator runs when something is already wrong. */
function divergenceFor(ctx, id, entry, readPrd) {
  try { return prdDivergence({ id, entry, readPrd }); }
  catch (e) { return { verdict: "unknown", why: e.message, diff: [] }; }
}
