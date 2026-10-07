// `gallivant start <prd path>`: one brief becomes one running session in its own checkout.
//
// The brief arrives as a Request (lib/sources/), which already names the target repository. `start` no longer works
// the repo out from the file's directory: it reads `request.repo`, so the only thing that has to know where a brief
// lives is the source that read it.
import { verifyCommands, prdFingerprint, prdDecision, sourcePathsOf } from "../prd.mjs";
import { requestFor } from "../sources/index.mjs";
import { startPrompt } from "../prompt.mjs";
import { remoteInput } from "../execution_input.mjs";
import { learningInput, learningDispatch, learningDelivered, learningDeliveryPatch } from "../learning_input.mjs";
import { capabilitiesFor, adapterFor, buildRun } from "../harness.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { branchFor, runEnv, worktreePath } from "../git.mjs";
import { resolveCredentialFor, describe as describeCredential } from "../credential.mjs";
import { requireIdentity, describeIdentity } from "../identity.mjs";
import { rememberRepo, resolveContextPaths, resolveBase, configuredBase, repoNames } from "../config.mjs";
import { writeRepositoryText } from "../repository_files.mjs";
import { validateStartRequest, captureStartInput, checkBaseFiles } from "../start_contract.mjs";
import { nowIso, floorSecond } from "../time.mjs";
import { requireHarness } from "../probe.mjs";
import { criteriaFromPrd, receiptInstructions } from "../deliverable.mjs";
import { executionRunner, EXECUTION_VERSION } from "../execution.mjs";
import { taskExecutionConfig } from "../task_allowance.mjs";

export async function start(ctx, options) {
  ctx = { ...ctx, config: taskExecutionConfig(ctx.config, options.task) };
  const progress = { cloneAttempted: false, spawnAttempted: false };
  try { return await startRequest(ctx, options, progress); }
  catch (error) {
    // A clone can leave an owned checkout even if it throws or source delivery
    // fails before spawn. Only a pre-clone failure is a clean retry boundary.
    error.startUncertain = progress.cloneAttempted || progress.spawnAttempted;
    if (progress.remoteRegistered && !progress.spawnAttempted) error.message += `; the unsubmitted task and checkout at ${progress.clone.worktree} are retained; repair preparation and explicitly resume the registered task`;
    else if (progress.cloneAttempted && !progress.spawnAttempted) error.message += `; start ownership and the clone at ${progress.clone.worktree} are retained; inspect its snapshots and start claim before recovery`;
    throw error;
  }
}

async function startRequest(ctx, { path, base: askedBase = null, chain = null, request: prepared = null, task = null }, progress) {
  const { config, state, gh, git, log, runnerFor, writePrd, writeSource, readSource } = ctx;
  // Intake supplies an immutable, repository-resolved draft snapshot. All gates,
  // source capture and dispatch ownership below remain shared with file starts.
  const request = prepared ?? await requestFor(path, { git, gh });
  // The gate. Every rule that applies to this source, every time, no override: a brief that fails cannot start.
  // A `context_paths:` key in the frontmatter adds to the config list for this brief alone. It is held to exactly
  // the same rules, so a PRD cannot hand a session the home directory or the Gallivant home that the config file is
  // refused for. This is the operator's list either way: the daemon's later runs read the snapshot written below,
  // not the copy in the checkout the session can edit.
  validateStartRequest(request, config, path);

  // The source resolved these four by asking git which checkout the file is in and gh what that repository is
  // called. A PRD outside a checkout fails there, with git's own message, before anything is recorded.
  //
  // `checkout` is the operator's own tree, and it is recorded on the entry from here on. The source has always known
  // it (it is where `relPath` is relative TO) and `start` used to drop it on the floor, which is why nothing could
  // compare the daemon's snapshot with the brief the operator is actually looking at: `entry.prd` is a relative path
  // and there was no second half to join it to. It is the operator's path, never the session's, so nothing a session
  // does can move it, and the daemon reads it for exactly one thing: the divergence check.
  const { repo: nameWithOwner, defaultBranch, relPath: prdRel, checkout } = request;
  const id = entryId(nameWithOwner, request.id);
  if (state.get(id)) throw new Error(`${id} already exists; \`gallivant why ${id}\` explains it, \`gallivant remove ${id}\` forgets it`);

  // The base branch this pull request will target, resolved once here and then carried everywhere it is needed: the
  // branch the clone is cut from, the instruction the session is given, and the branch the daemon merges in before
  // every later round. `resolveBase` owns the precedence (flag, then this repository's config entry, then the
  // repository's default branch), so there is one definition rather than three agreeing by luck.
  const selection = resolveBase({ config, repo: nameWithOwner, defaultBranch, asked: askedBase });
  const base = selection.base;
  // Intake pins the resolved base, including its original provenance. Passing
  // that frozen value must not turn a default into a persisted operator override.
  const baseSource = task?.baseSource || selection.source;
  if (!base) throw new Error(`no base branch for ${nameWithOwner}: GitHub reported no default branch and none is configured. Set one with \`gallivant start ${path} --base <branch>\`.`);
  // A base that is not on the remote must fail HERE. Left to `gh pr create --base`, it fails after the session has
  // implemented the entire brief, run the tests and spent the budget, with the work stranded on a branch nobody asked
  // for. One API call before anything is cloned is the whole cost of not doing that.
  //
  // `branchExists` is false for a 404 and false for a GitHub that would not answer, so the two are named separately:
  // a briefly unreachable API must not read to the operator as a misspelled branch name.
  if (!await gh.branchExists(nameWithOwner, base)) {
    const how = baseSource === "flag" ? "--base names it" : baseSource === "config" ? `repos in config.json names it for ${nameWithOwner}` : `it is ${nameWithOwner}'s default branch`;
    throw new Error(`base branch "${base}" is not on ${nameWithOwner} (${how}), or GitHub could not be asked. Nothing was cloned and nothing was started. Check the branch name, or run \`gh api repos/${nameWithOwner}/branches/${base}\` to see what GitHub says.`);
  }
  if (baseSource !== "default") log.info(`${id}: base branch ${base} (from ${baseSource === "flag" ? "--base" : "config"}), not ${nameWithOwner}'s default ${defaultBranch ?? "branch"}`);

  // Nothing is recorded or cloned for a harness too old to honour its adapter, or one that is signed out.
  await requireHarness(request.harness, config);

  // A credential, before anything is cloned or spawned.
  //
  // This refusal is the defect being fixed. A run with no credential implements the whole brief, commits it, and then
  // cannot push: the money is spent, the work is stranded in a worktree, and nothing warned anybody. So the credential
  // is resolved here, where there is an operator reading the output, and a run that could not push never starts.
  //
  // There is no checkout yet, so the host reads as github.com, which is what `gh repo clone owner/name` resolves.
  // An enterprise install is the case this cannot see from here, and `noCredentialMessage` says so by name: the
  // answer there is `github_token_file`, rather than sending a github.com token to a host it cannot authenticate.
  const credential = await resolveCredentialFor(ctx);
  if (!credential.token) throw new Error(credential.why);
  log.info(`${id}: GitHub credential from ${describeCredential(credential)}`);
  // And an identity, refused here for the same reason and in the same place. A run commits as the operator, so with no
  // identity on the machine every commit the session makes would fail; refusing before the clone means no money spent.
  const identity = await requireIdentity(ctx);
  log.info(`${id}: commits as ${describeIdentity(identity)}`);

  const branch = branchFor(request.id);
  // Everything the run needs, worked out BEFORE the clone, because the clone is the one step here that leaves
  // something behind when a later one throws. `buildRun` refuses a harness that cannot grant the configured
  // `context_paths` as read-only, and it used to be called four lines after `git.create`: the refusal arrived with
  // the repository already cloned and nothing in the registry, so the next `gallivant start` failed on `git.create`
  // ("worktree already exists") and the operator had to find and delete the directory themselves. Nothing in the
  // spec needs the checkout to exist: `worktreePath` is a pure function of the config, the repo and the PRD id, and
  // `git.create` clones to that same path, so the `cwd` the spec carries is knowable first.
  const worktreePlanned = worktreePath(config, nameWithOwner, request.id);
  const remote = capabilitiesFor(request.harness).transport === "remote";
  let session = remote ? null : adapterFor(request.harness).newSession();
  const receipt = config.deliverable ? receiptInstructions(criteriaFromPrd(request), id) : null;
  // The list the brief declared, which the contract rule has already proved readable, so the prompt can name the files
  // before they are snapshotted below and there is no second source of truth about what a brief carries.
  const declared = sourcePathsOf(request);
  const prompt = startPrompt({ prd: request, repo: nameWithOwner, branch, base, verify: verifyCommands(request), receipt, carried: declared });
  // Read-only extras for this session: the config list plus this brief's own frontmatter, merged in one place.
  const contextPaths = resolveContextPaths(config, request);
  if (remote && contextPaths.length) throw Object.assign(new Error("hosted backend cannot enforce private read-only context_paths"), { code: "EXECUTION_POLICY" });
  let spec = remote ? null : buildRun({ harness: request.harness, config, mode: "start", session, prompt, cwd: worktreePlanned, contextPaths });
  const input = captureStartInput(request, base);
  if (task && input.digest !== task.digest) throw Object.assign(new Error("approved task input changed; validate the current revision before starting"), { code: "TASK_CONFLICT" });
  if (chain && input.digest !== chain.digest) throw new Error(`queued PRD or sources changed for ${id}; retry the chain with --resnapshot after reviewing the changes`);
  const claim = state.claimStart(id, chain, task);
  try {

    // The daemon's own copy of the brief: fix rounds and the completion gate read this, never the checkout.
    writePrd(id, request.text);

    // The files the brief carries, snapshotted beside it and for the same reason. The contract rule has already read
    // every one of them, so a failure here is a race (an edit or a delete between `ready` and now) rather than a mistyped
    // path, and it must still be loud: the session would otherwise start against a brief citing a document that is not
    // there. This is above the clone because everything that can throw belongs before the irreversible step.
    const carried = [];
    for (const [rel, text] of input.sources) {
      writeSource(id, rel, text);
      carried.push(rel);
    }

    progress.clone = { worktree: worktreePlanned, base, branch };
    state.markStartClone(id, claim.token, progress.clone);
    progress.cloneAttempted = true;
    let worktree;
    try { worktree = await git.create({ nameWithOwner, prdId: request.id, base }); }
    catch (error) {
      // Keep ownership for unknown/partial failures. A known refusal before the
      // clone executor is invoked is the same clean retry boundary as preflight.
      if (error.cloneAttempted === false) progress.cloneAttempted = false;
      throw error;
    }
    if (chain) {
      for (const sha of chain.after) {
        if (!await git.containsCommit(worktree, sha)) throw new Error(`the fresh ${base} checkout does not contain predecessor merge ${sha}; nothing spawned`);
      }
      await checkBaseFiles(input, chain.baseFiles, rel => git.fileAt(worktree, "HEAD", rel));
    }
    // The clone is where the process actually runs, so it is what the spawn below is given. The spec's own `cwd` was
    // `worktreePath` for the same repo and PRD id, which is what `git.create` returns; no adapter reads `ctx.cwd` today,
    // so the two are only ever compared here. A relocating `git.create` would want this to be a refusal rather than a
    // note, and if `cwd` ever reaches argv it has to become one.
    if (worktree !== worktreePlanned) log.warn(`${id}: the checkout landed at ${worktree}, not the ${worktreePlanned} the run spec was built for`);
    const publicSince = floorSecond(nowIso());
    let remoteRegistered = false;
    if (remote) {
      state.validateStart(id, claim.token, chain);
      const pending = newEntry({ prd: prdRel, harness: request.harness, session: null, repo: nameWithOwner, branch, worktree, state: STATES.needsHuman, nowIso: nowIso(), checkout, prdFingerprint: prdFingerprint(request), prdDecision: prdDecision(request), base, sources: carried });
      // The clone is owned, but snapshot delivery and read-only API preparation
      // can still fail. Consume the claim into an actionable entry before them;
      // preserve the checkout rather than silently deleting unfinished files.
      state.putStarted(id, { ...pending, execution: { version: EXECUTION_VERSION, operationId: claim.token }, initial_dispatch: { version: 1, operationId: claim.token, status: "unsubmitted" }, reason: "launch-preparation", public_since: publicSince, ...(task ? { task } : {}), ...(chain ? { chain: { name: chain.name, index: chain.index, dispatch: chain.dispatch } } : {}), last: { at: nowIso(), run: null, exit: null, event: "managed launch preparation pending; repair prerequisites and explicitly resume" } }, claim.token);
      remoteRegistered = progress.remoteRegistered = true;
    }
    // The PRD usually only exists in the operator's own checkout, so the fresh clone off the base branch does not
    // have it. Write it in at the same relative path before the session starts, so the branch carries the brief and
    // the PR can link it. The daemon's snapshot above stays the authoritative copy for the completion gate; this one
    // is writable by the session and is never read back for a decision.
    writeRepositoryText(worktree, prdRel, request.text);
    // The carried files, written from the daemon's snapshot rather than from the operator's tree. Reading the snapshot is
    // the point: it is the copy the gate judges, so the session and the gate cannot be handed different bytes even if the
    // operator edits the file in the second between the two writes. Same 0o644/0o755 as the brief, because these are
    // files in a source tree and must not be clamped to daemon-state modes.
    for (const rel of carried) writeRepositoryText(worktree, rel, readSource(id, rel));
    if (carried.length) log.info(`${id}: carried ${carried.length} file${carried.length === 1 ? "" : "s"} from ${request.checkout} into the checkout`);
    if (!remote) state.validateStart(id, claim.token, chain);
    const execution = executionRunner(ctx, id, request.harness);
    const managed = await learningInput(ctx, id, { repo: nameWithOwner, harness: request.harness, session: null, prd: prdRel, sources: carried }, { operationId: claim.token, sessionId: null, recordedSessionId: session, inputHead: git.head ? await git.head(worktree) : null, prompt });
    const { prompt: managedPrompt, ...dispatchInput } = managed;
    if (!remote && managedPrompt !== prompt) spec = buildRun({ harness: request.harness, config, mode: "start", session, prompt: managedPrompt, cwd: worktree, contextPaths });
    let job;
    // Register the remote ownership before I/O. A launcher crash or lost reply
    // must leave an entry the existing coordinator can reconcile, with no second
    // start claim. Keep it actionable until exact launch identities are known.
    if (remote) {
      const preparedInput = await remoteInput(ctx, id, { harness: request.harness, prd: prdRel, worktree, checkout, repo: nameWithOwner, branch, base, sources: carried }, { ...dispatchInput, name: "start", prompt: managedPrompt }, contextPaths);
      await execution.prepare(preparedInput);
      state.update(id, { initial_dispatch: { version: 1, operationId: claim.token, status: "dispatching" }, reason: "dispatch-intent", last: { at: nowIso(), run: null, exit: null, event: "managed dispatch pending" } });
      progress.spawnAttempted = true;
      try { job = await learningDispatch(ctx, id, managed, () => execution.submit(preparedInput)); session = job.execution.sessionId; }
      catch (error) {
        const current = execution.current();
        if (error.dispatchNotSent === true) state.update(id, { initial_dispatch: { version: 1, operationId: claim.token, status: "unsubmitted" }, reason: "dispatch-refused", last: { at: nowIso(), run: null, exit: null, event: "managed dispatch refused before any provider request; repair prerequisites and explicitly resume" } });
        else if (current) state.update(id, { execution: current.execution, session: current.execution.sessionId, last: { at: nowIso(), run: current.id, exit: null, event: "managed dispatch acceptance unresolved" } });
        throw error;
      }
    } else {
      // Even a throwing local spawn can have created a child.
      progress.spawnAttempted = true;
      job = await learningDispatch(ctx, id, managed, () => execution.start("start", spec.cmd, spec.args, { cwd: worktree, env: { ...runEnv(config, credential, identity, worktree), ...spec.env }, execution: dispatchInput }));
    }

    // `checkout` and the two prd fields are what the divergence check compares against: where the operator's copy lives,
    // the contract the snapshot above carries, and the readiness decision the brief was blessed with. All three are
    // recorded at the same moment as the snapshot, because a fingerprint of a brief other than the one snapshotted is
    // worse than no fingerprint at all.
    const entry = newEntry({
      prd: prdRel, harness: request.harness, session, repo: nameWithOwner, branch, worktree, state: STATES.running, nowIso: nowIso(),
      checkout, prdFingerprint: prdFingerprint(request), prdDecision: prdDecision(request), base, sources: carried,
    });
    const startedEntry = { ...entry, ...(remote ? { initial_dispatch: null } : {}), ...(job.execution ? { execution: job.execution } : {}), ...(task ? { task: { ...task, run: job.id } } : {}), public_since: publicSince, ...(chain ? { chain: { name: chain.name, index: chain.index, dispatch: chain.dispatch } } : {}), last: { at: nowIso(), run: job.id, exit: null, event: "start" } };
    if (remoteRegistered) state.update(id, current => ({ ...startedEntry, ...learningDeliveryPatch(current, managed, job) }));
    else state.putStarted(id, { ...startedEntry, ...learningDeliveryPatch(null, managed, job) }, claim.token);
    await learningDelivered(ctx, id);
    // The repository is recorded for recovery, and the base with it when one was chosen explicitly. `--base` is the
    // "when initiating" half of configuring this: typed once, persisted for this repository, and every later start in it
    // reads the same answer without the flag. A base that came from the repository's own default is NOT written, so an
    // operator who configures nothing keeps the bare-string `repos` entry they have always had.
    //
    // `isNewRepo` is asked BEFORE the write, and it is a different question from "did the file change". The labels exist
    // per repository and only want creating the first time one is seen; `rememberRepo` also returns true when it merely
    // retargets the base of a repository already listed, so reading its return value for both would spend an
    // `ensureLabels` call on every `--base` change.
    const isNewRepo = configuredBase(config, nameWithOwner) === null && !repoNames(config).includes(nameWithOwner.toLowerCase());
    const persistBase = baseSource === "flag" && !chain ? base : null;
    rememberRepo(nameWithOwner, config.home, persistBase);
    if (persistBase) log.info(`${nameWithOwner}: base branch ${base} recorded in ${config.home}/config.json; later starts in this repository need no --base`);
    if (isNewRepo) await gh.ensureLabels(nameWithOwner).catch(e => log.warn(`${nameWithOwner}: labels not created: ${e.message}`));
    log.info(`${id}: started ${request.harness} session in ${worktree}`);
    return { id, worktree, branch, base, baseSource, session, run: job.id };
  } catch (error) {
    if (!progress.cloneAttempted && !progress.spawnAttempted) state.releaseStart(id, claim.token);
    throw error;
  }
}
