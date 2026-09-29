// Resume a stopped session after validating its contract and preserving any unsettled run.
import { resolveHandle, handleFor, STATES } from "../state.mjs";
import { readRepositoryText, writeRepositoryText, repositoryPath } from "../repository_files.mjs";
import { makeTick } from "../tick.mjs";
import { adapterFor } from "../harness.mjs";
import { resumePrompt } from "../prompt.mjs";
import { verifyCommands, parsePrd, prdDivergence, sourceDivergence, sourceDiff, sourcePathsOf, divergenceReason, renderDivergence, resolvePrdSnapshot, retakePrdSnapshot } from "../prd.mjs";
import { criteriaFromPrd, receiptInstructions } from "../deliverable.mjs";
import { nowIso } from "../time.mjs";

/** States worth resuming. A `done` entry is merged or closed, and a `running` one already has a live run. */
const RESUMABLE = new Set([STATES.needsHuman, STATES.prOpen, STATES.ready]);

export async function resume(ctx, { handle, note = null, resnapshot = false }) {
  const { state, git, log, readPrd } = ctx;
  const id = resolveHandle(state.entries(), handle);
  let entry = state.get(id);

  if (!RESUMABLE.has(entry.state)) throw new Error(`${handleFor(id, entry)} is ${entry.state}; resume takes a stopped or watched entry`);
  if (!entry.session) throw new Error(`${handleFor(id, entry)} has no session to resume. It never got past its first run, so start it again: gallivant start ${entry.prd ?? "<prd>"}`);

  const divergence = prdDivergence({ id, entry, readPrd });
  const divReason = divergenceReason(divergence);
  let briefChanged = [...(entry.brief_changes ?? [])];
  if (divReason) {
    if (divergence.verdict !== "changed" || !resnapshot) {
      throw new Error([
        `${handleFor(id, entry)}: ${divergence.why}`,
        renderDivergence(divergence),
        divergence.verdict === "changed"
          ? `Nothing was resumed. The session holds the brief this run started against, so resuming would put it back to work on one contract while the gate judges another.\nDecide: rerun with --resnapshot to make the edited brief the brief (the session is told what changed), or put the brief back the way it was.`
          : divergence.verdict === "illegal"
            ? `Nothing was resumed. ${divergence.path} would be refused by \`gallivant start\` as it stands, so it cannot become the brief the gate judges. Fix it and \`gallivant ready\` it again.`
            : `Nothing was resumed. Restore the file, or \`gallivant remove ${handleFor(id, entry)}\` if the work is no longer wanted.`,
      ].filter(Boolean).join("\n"));
    }
  }

  if (resnapshot && divergence.repo && divergence.repo.harness !== entry.harness) {
    throw new Error(`${handleFor(id, entry)}: cannot change harness from ${entry.harness} to ${divergence.repo.harness} with --resnapshot; the recorded session belongs to ${entry.harness}. Restore the harness or start a new entry.`);
  }
  const sources = sourceDivergence({ id, entry, readSource: ctx.readSource });
  const sourceChanges = sourceDiff(sources);
  if (sourceChanges.length && !resnapshot) {
    throw new Error(`${handleFor(id, entry)}: carried files differ from the snapshot:\n${sourceChanges.join("\n")}\nNothing was resumed. Restore the files or use --resnapshot to accept the edited sources; remove deleted files from the brief's sources list first.`);
  }
  if (resnapshot && sourceChanges.length && !divergence.repo) throw new Error("cannot resnapshot carried files without the operator's brief; restore the brief first");
  const acceptedSources = resnapshot && divergence.repo ? sourcePathsOf(divergence.repo) : null;
  const sourceTexts = new Map();
  for (const rel of acceptedSources ?? []) {
    const text = readRepositoryText(entry.checkout, rel);
    if (text.includes("\u0000")) throw new Error(`${rel} is not text`);
    sourceTexts.set(rel, text);
  }

  const runner = ctx.runnerFor(id);
  const current = runner.current();
  if (current?.running) throw new Error(`${handleFor(id, entry)} already has a run in flight (${current.id}); wait for it or stop it first`);
  if (entry.last?.run && entry.last.exit == null) {
    throw new Error(`${handleFor(id, entry)}: run ${entry.last.run} still needs settling; wait for the daemon (gallivant up) before resuming`);
  }

  const recreated = !git.exists(entry.worktree);
  if (recreated) {
    log.info(`${id}: recreating the checkout at ${entry.worktree}`);
    await git.fromBranch({ nameWithOwner: entry.repo, prdId: id.split("/").pop(), branch: entry.branch, path: entry.worktree });
  }

  const tick = makeTick({ ...ctx, ownLogin: ctx.ownLogin ?? "resume" });

  if (git.dirty) {
    const tree = await git.dirty(entry.worktree).catch(() => null);
    if (tree && (tree.modified || tree.untracked)) {
      const parts = [tree.modified && `${tree.modified} modified`, tree.untracked && `${tree.untracked} untracked`].filter(Boolean);
      throw new Error([
        `${handleFor(id, entry)}: ${parts.join(" and ")} file${tree.modified + tree.untracked === 1 ? "" : "s"} in ${entry.worktree} are not committed.`,
        `Nothing was resumed and nothing was touched: this is read before origin/${entry.base ?? "the base"} is merged in, because that merge would refuse to overwrite them.`,
        "Commit what the last run left, then resume:",
        `    cd ${entry.worktree} && git add -A && git commit`,
        `    gallivant resume ${handleFor(id, entry)}`,
      ].join("\n"));
    }
  }

  // A failed fetch or merge must leave the accepted contract unchanged.
  const merged = await tick.mergeBaseInto(id, entry);
  if (merged?.conflict) {
    throw new Error([
      `${handleFor(id, entry)}: ${entry.branch} cannot be merged with origin/${merged.base}: ${merged.why}`,
      "Nothing was resumed, and the checkout was left clean: the merge was aborted.",
      `Resolve it in ${entry.worktree} (\`git merge origin/${merged.base}\`, fix the conflicts, commit, push), then resume again.`,
    ].join("\n"));
  }
  if (merged?.merged) entry = state.get(id) ?? entry;

  await tick.reopen(id, entry);
  const copyingBrief = divReason || recreated || briefChanged.length || sourceChanges.length;
  const sourcesToCopy = acceptedSources ?? ((recreated || briefChanged.length) ? entry.sources ?? [] : []);
  if (copyingBrief && entry.prd) repositoryPath(entry.worktree, entry.prd, { createParents: true });
  for (const rel of sourcesToCopy) repositoryPath(entry.worktree, rel, { createParents: true });
  briefChanged = [...new Set([...briefChanged, ...(divReason ? divergence.diff : []), ...sourceChanges])];
  // Persist the notice before snapshots move, so a failed write or spawn cannot silently lose it.
  if (briefChanged.length) state.update(id, { brief_changes: briefChanged });

  // Source writes must succeed before accepting a new manifest in the authoritative PRD.
  if (acceptedSources) for (const [rel, text] of sourceTexts) ctx.writeSource(id, rel, text);

  if (divReason) {
    resolvePrdSnapshot(ctx, { id, entry, divergence, by: "gallivant resume --resnapshot" });
    entry = state.get(id);
  } else if (divergence.verdict === "same" && divergence.repoText !== undefined && divergence.repoText !== readPrd(id)) {
    retakePrdSnapshot(ctx, { id, divergence });
    log.info(`${id}: the brief was edited outside its contract; snapshot re-taken from ${divergence.path} before resuming`);
    entry = state.get(id);
  }

  if (acceptedSources) {
    entry = state.update(id, { sources: acceptedSources });
  }

  const text = readPrd(id);
  const parsed = text ? parsePrd(text, `${id}.md`) : null;

  if ((briefChanged.length || recreated) && entry.prd && text) writeRepositoryText(entry.worktree, entry.prd, text);
  for (const rel of sourcesToCopy) {
    const source = ctx.readSource(id, rel);
    if (source == null) throw new Error(`${rel}: carried-file snapshot is missing; restore it before resuming`);
    writeRepositoryText(entry.worktree, rel, source);
  }

  const unpushed = git.unpushed ? await git.unpushed(entry.worktree, entry.branch, entry.base ?? null) : [];
  if (unpushed.length) log.info(`${id}: ${unpushed.length} unpushed commit${unpushed.length === 1 ? "" : "s"} on ${entry.branch}; the session is told to push them rather than redo them`);

  const prompt = resumePrompt({
    repo: entry.repo,
    pr: entry.pr,
    base: entry.base,
    branch: entry.branch,
    reason: entry.reason,
    note,
    verify: parsed ? verifyCommands(parsed) : [],
    receipt: parsed ? receiptInstructions(criteriaFromPrd(parsed), id) : null,
    briefChanged,
    unpushed,
    merged: merged?.merged ? merged : null,
  });

  const { job, session } = await tick.startRun(id, entry, { name: "resume", prompt });

  state.update(id, {
    state: entry.pr ? STATES.prOpen : STATES.running,
    reason: null,
    gate_skipped: null,
    labels_pending: false,
    retry: null,
    brief_changes: null,
    session,
    prd_divergence: null,
    timeout: null,
    last: { at: nowIso(), run: job.id, exit: null, event: `resumed after ${entry.reason ?? entry.state}${briefChanged.length ? ", brief resnapshotted" : ""}` },
    updated_at: nowIso(),
  });
  log.info(`${id}: resumed ${entry.harness} session ${session} (run ${job.id})${briefChanged.length ? ` against the edited brief (${briefChanged.length} change${briefChanged.length === 1 ? "" : "s"})` : ""}`);
  return { id, handle: handleFor(id, entry), run: job.id, session, worktree: entry.worktree, resnapshotted: briefChanged, attach: adapterFor(entry.harness).attach({ pr: entry.pr, session }) };
}
