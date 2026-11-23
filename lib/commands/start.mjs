import { requireAuthorRoute } from "./recovery.mjs";
import { validateRecoveryProfile } from "../recovery_authority.mjs";
import { approvedSnapshotDigests, authorConfigurationDigest, authorRouteDigest, turnBinding, verifyAuthorCopies } from "../recovery_preflight.mjs";
import { contentDigest } from "../start_contract.mjs";
import { preflightPackageAuth } from "../package_auth.mjs";
import { providerScope } from "../recovery_cooldown.mjs";
import { publicationPolicyOf } from "../work_artifacts.mjs";
import { repositoryReviewConfig } from "../review_policy.mjs";
import { repositoryPreflight } from "../repository_preflight.mjs";
import { hosts, hostApi } from "../hosts.mjs";
import { assertRepositoryAccess } from "../host_contract.mjs";
import { isDeepStrictEqual } from "node:util";
import { dispatchCapacity } from "../dispatch_capacity.mjs";
import { verifyRepositoryIdentity } from "../dependency_integration.mjs";
import { remoteMatches } from "../repository.mjs";
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
import { branchFor, runSessionEnv, worktreePath } from "../git.mjs";
import { resolveCredentialFor, describe as describeCredential } from "../credential.mjs";
import { requireIdentity, describeIdentity } from "../identity.mjs";
import { rememberRepo, resolveContextPaths, resolveBase, configuredBase, repoNames } from "../config.mjs";
import { readRepositoryText, writeRepositoryText } from "../repository_files.mjs";
import { validateStartRequest, captureStartInput, sourceManifestDigest, checkBaseFiles } from "../start_contract.mjs";
import { nowIso, floorSecond } from "../time.mjs";
import { requireHarness } from "../probe.mjs";
import { criteriaFromPrd, receiptInstructions } from "../deliverable.mjs";
import { dispatchProvenUnsent, executionRunner, EXECUTION_VERSION } from "../execution.mjs";
import { planRunConfig, taskExecutionConfig } from "../task_allowance.mjs";
import { selectReviewPolicy } from "../review_policy.mjs";
import { graphLaunchUnsent } from "../dependency_plan_runtime.mjs";
import { admitCITiming, CI_BRANCH_PREFIX, ciTimingView } from "../ci_timing.mjs";
import { resolveTimeout } from "../config.mjs";

export async function start(ctx, options) {
  ctx = { ...ctx, config: taskExecutionConfig(ctx.config, options.task) };
  const progress = { cloneAttempted: false, spawnAttempted: false };
  try {
    const request = () => startRequest(ctx, options, progress);
    return await (ctx.authorSlots ? ctx.authorSlots(request) : request());
  }
  catch (error) {
    // A clone can leave an owned checkout even if it throws or source delivery
    // fails before spawn. Only a pre-clone failure is a clean retry boundary.
    error.startUncertain = progress.cloneAttempted || progress.spawnAttempted;
    if (progress.registered && !progress.spawnAttempted) error.message += `; the unsubmitted task and checkout at ${progress.clone.worktree} are retained`;
    else if (progress.cloneAttempted && !progress.spawnAttempted) error.message += `; start ownership and the clone at ${progress.clone.worktree} are retained; inspect its snapshots and start claim before recovery`;
    throw error;
  }
}

async function startRequest(ctx, { path, base: askedBase = null, chain = null, graph = null, request: prepared = null, task = null, recoveryProfile = null }, progress) {
  const { config, state, git, log, runnerFor, writePrd, writeSource, readSource } = ctx;
  const host = hostApi(ctx);
  // Intake supplies an immutable, repository-resolved draft snapshot. All gates,
  // source capture and dispatch ownership below remain shared with file starts.
  // Load graph-only source tooling only for an actual graph start.
  const graphStart = graph && await import("../dependency_plan_start.mjs");
  const planned = graphStart ? graphStart.graphStartInput(ctx, graph) : null;
  const runConfig = planRunConfig(config, planned?.allowance);
  if (planned) ({ path, base: askedBase } = planned);
  const request = planned?.request ?? prepared ?? await requestFor(path, { git, host });
  // The gate. Every rule that applies to this source, every time, no override: a brief that fails cannot start.
  // A `context_paths:` key in the frontmatter adds to the config list for this brief alone. It is held to exactly
  // the same rules, so a PRD cannot hand a session the home directory or the Gallivant home that the config file is
  // refused for. This is the operator's list either way: the daemon's later runs read the snapshot written below,
  // not the copy in the checkout the session can edit.
  validateStartRequest(request, config, path, planned ? { readSource: planned.readSource } : undefined);

  // The source resolved these four by asking git which checkout the file is in and gh what that repository is
  // called. A PRD outside a checkout fails there, with git's own message, before anything is recorded.
  //
  // `checkout` is the operator's own tree, and it is recorded on the entry from here on. The source has always known
  // it (it is where `relPath` is relative TO) and `start` used to drop it on the floor, which is why nothing could
  // compare the daemon's snapshot with the brief the operator is actually looking at: `entry.prd` is a relative path
  // and there was no second half to join it to. It is the operator's path, never the session's, so nothing a session
  // does can move it, and the daemon reads it for exactly one thing: the divergence check.
  const { repo: nameWithOwner, defaultBranch, relPath: prdRel, checkout } = request;
  const selectedHost = (ctx.hosts ?? hosts).select(nameWithOwner);
  repositoryReviewConfig(config, nameWithOwner, selectedHost.adapter);
  assertRepositoryAccess(capabilitiesFor(request.harness), selectedHost.repository);
  const id = entryId(nameWithOwner, request.id);
  let recovery = null;
  if (recoveryProfile !== null) {
    const admin = state.load().recovery;
    const profile = validateRecoveryProfile(admin?.profiles.find(item => item.digest === recoveryProfile));
    if (admin.version !== 1 || admin.storeId !== profile.storeId) throw new Error("Recovery store identity changed.");
    recovery = { version: 1, digest: profile.digest };
  }
  const recovering = Boolean(planned?.authority.retry);
  const retainedEntry = recovering ? state.get(id) : null;
  if (!recovering && state.get(id)) throw new Error(`${id} already exists; \`gallivant why ${id}\` explains it, \`gallivant remove ${id}\` forgets it`);
  const worktreePlanned = worktreePath(config, nameWithOwner, request.id);
  ctx.resourcePreflight?.(worktreePlanned, true);
  const checkCooldown = () => {
    const unavailable = ctx.cooldowns?.deferred(providerScope(request.harness, config.harness[request.harness]?.account || "operator"));
    if (unavailable) throw unavailable;
  };
  checkCooldown();

  // The base branch this pull request will target, resolved once here and then carried everywhere it is needed: the
  // branch the clone is cut from, the instruction the session is given, and the branch the daemon merges in before
  // every later round. `resolveBase` owns the precedence (flag, then this repository's config entry, then the
  // repository's default branch), so there is one definition rather than three agreeing by luck.
  const selection = resolveBase({ config, repo: nameWithOwner, defaultBranch, asked: askedBase });
  const base = selection.base;
  // Intake pins the resolved base, including its original provenance. Passing
  // that frozen value must not turn a default into a persisted operator override.
  const baseSource = task?.baseSource || selection.source;
  if (!base) throw new Error(`no base branch for ${nameWithOwner}: the host reported no default branch and none is configured. Set one with \`gallivant start ${path} --base <branch>\`.`);
  const input = captureStartInput(request, base, planned?.readSource);
  if (task && input.digest !== task.digest) throw Object.assign(new Error("approved task input changed; validate the current revision before starting"), { code: "TASK_CONFLICT" });
  if (chain && input.digest !== chain.digest) throw new Error(`queued PRD or sources changed for ${id}; retry the chain with --resnapshot after reviewing the changes`);
  const claim = state.claimStart(id, chain, task, { repo: nameWithOwner, graph: planned?.authority, limits: dispatchCapacity(config) });
  if (recovering) {
    progress.clone = { worktree: worktreePlanned };
    progress.cloneAttempted = true;
    progress.registered = Boolean(retainedEntry);
  }
  const assertAdmission = () => {
    if (planned && !(dispatchCapacity(config).graph_authors && dispatchCapacity(config).graph_per_repository)) {
      throw Object.assign(new Error("Graph dispatch was disabled during preparation."), { code: "PLAN_START_FENCE" });
    }
    if (planned && authorConfigurationDigest(config, request.harness, request) !== planned.allowance.routeDigest)
      throw Object.assign(new Error("The approved author route changed during graph preparation."), { code: "PLAN_START_FENCE" });
    state.validateStart(id, claim.token, chain, planned?.authority, progress.spawnAttempted ? "dispatching" : "preparing");
  };
  const recheck = async value => { const result = await value; assertAdmission(); return result; };
  let execution;
  try {
    // Pin policy before cloning or launching the author. Config edits only apply
    // to future tasks; the explicit review policy command owns migration.
    const reviewPolicy = ctx.reviewService ? await recheck(ctx.reviewService.preflight(nameWithOwner)) : selectReviewPolicy(config, nameWithOwner);
    if (planned && (!planned.reviewPolicy || !isDeepStrictEqual(planned.reviewPolicy, reviewPolicy))) throw new Error("The approved plan review route is unavailable or changed.");
    const ciTiming = await recheck(admitCITiming(ctx, { repo: nameWithOwner, base, harness: request.harness, prd: request,
      admittedDependency: Boolean(chain || planned), reviewPolicy }));
    const deferred = ciTiming.timing === "after-review";
    log.info(`${id}: CI ${ciTiming.timing === "immediate" ? "immediately" : "after review"} · ${ciTimingView(config, state, nameWithOwner, base, ciTiming).activation}`);
    // A base that is not on the remote must fail HERE. Left to `gh pr create --base`, it fails after the session has
    // implemented the entire brief, run the tests and spent the budget, with the work stranded on a branch nobody asked
    // for. One API call before anything is cloned is the whole cost of not doing that.
    //
    // `branchExists` returns false for HTTP404; transport/CLI failures throw a
    // bounded credential-redacted diagnostic before any clone or provider dispatch.
    if (!await recheck(host.branchExists(nameWithOwner, base))) {
      const how = baseSource === "flag" ? "--base names it" : baseSource === "config" ? `repos in config.json names it for ${nameWithOwner}` : `it is ${nameWithOwner}'s default branch`;
      throw new Error(`base branch "${base}" is not on ${nameWithOwner} (${how}), or the host could not be asked. Nothing was cloned and nothing was started. Check the branch name and host access.`);
    }
    if (selectedHost.adapter.features?.transportSetup) await recheck(repositoryPreflight(config, nameWithOwner, { registry: ctx.hosts ?? hosts, git, base }));
    if (baseSource !== "default") log.info(`${id}: base branch ${base} (from ${baseSource === "flag" ? "--base" : "config"}), not ${nameWithOwner}'s default ${defaultBranch ?? "branch"}`);

    // Nothing is recorded or cloned for a harness too old to honour its adapter, or one that is signed out.
    await recheck(requireHarness(request.harness, config, ctx.localPlans?.checkHarnessOptions(request.harness)));

    // A credential, before anything is cloned or spawned.
    //
    // This refusal is the defect being fixed. A run with no credential implements the whole brief, commits it, and then
    // cannot push: the money is spent, the work is stranded in a worktree, and nothing warned anybody. So the credential
    // is resolved here, where there is an operator reading the output, and a run that could not push never starts.
    //
    // There is no checkout yet, so the host reads as github.com, which is what `gh repo clone owner/name` resolves.
    // An enterprise install is the case this cannot see from here, and `noCredentialMessage` says so by name: the
    // answer there is `github_token_file`, rather than sending a github.com token to a host it cannot authenticate.
    const minimumMs = Math.min(resolveTimeout({ config: runConfig, repo: nameWithOwner }).minutes * 60_000,
      task?.deliveryAllowance?.runtimeMs ?? Infinity);
    let credential = deferred ? await recheck(ctx.deferredCI.transport.credential(state.ciPilot().proposal, "author", minimumMs))
      : await recheck(resolveCredentialFor(ctx, { repo: nameWithOwner }));
    if (!credential.token) throw new Error(credential.why);
    await recheck((ctx.packageAuthPreflight || preflightPackageAuth)({ config, repo: nameWithOwner, credential, transport: capabilitiesFor(request.harness).transport, limits: config.execution }));
    log.info(`${id}: repository credential from ${describeCredential(credential)}`);
    // And an identity, refused here for the same reason and in the same place. A run commits as the operator, so with no
    // identity on the machine every commit the session makes would fail; refusing before the clone means no money spent.
    const identity = await recheck(requireIdentity(ctx));
    log.info(`${id}: commits as ${describeIdentity(identity)}`);

    const enrollment = deferred ? await recheck(ctx.deferredCI.enroll(ctx, id, claim.token, ciTiming,
      nonce => `${CI_BRANCH_PREFIX}${nonce}-${request.id}`)) : null;
    const branch = enrollment?.branch ?? branchFor(request.id);
    // Everything the run needs, worked out BEFORE the clone, because the clone is the one step here that leaves
    // something behind when a later one throws. `buildRun` refuses a harness that cannot grant the configured
    // `context_paths` as read-only, and it used to be called four lines after `git.create`: the refusal arrived with
    // the repository already cloned and nothing in the registry, so the next `gallivant start` failed on `git.create`
    // ("worktree already exists") and the operator had to find and delete the directory themselves. Nothing in the
    // spec needs the checkout to exist: `worktreePath` is a pure function of the config, the repo and the PRD id, and
    // `git.create` clones to that same path, so the `cwd` the spec carries is knowable first.
    const remote = capabilitiesFor(request.harness).transport === "remote";
    let session = recovering ? claim.clone.session : remote ? null : adapterFor(request.harness).newSession();
    const receipt = config.deliverable ? receiptInstructions(criteriaFromPrd(request), id) : null;
    // The list the brief declared, which the contract rule has already proved readable, so the prompt can name the files
    // before they are snapshotted below and there is no second source of truth about what a brief carries.
    const declared = sourcePathsOf(request);
    const prompt = startPrompt({ host: selectedHost.adapter.prompts, prd: request, repo: nameWithOwner, branch, base, verify: verifyCommands(request), receipt, carried: declared });
    // Read-only extras for this session: the config list plus this brief's own frontmatter, merged in one place.
    const contextPaths = resolveContextPaths(config, request);
    if (remote && contextPaths.length) throw Object.assign(new Error("hosted backend cannot enforce private read-only context_paths"), { code: "EXECUTION_POLICY" });
    let spec = remote ? null : buildRun({ harness: request.harness, config: runConfig, mode: "start", session, prompt, cwd: worktreePlanned, contextPaths });
    if (planned) await planned.prove(assertAdmission, { input, checkBase: true });
    if (chain?.repositoryId) await recheck(verifyRepositoryIdentity(ctx, nameWithOwner, chain.repositoryId));
    const sameRepoPredecessors = planned?.after ?? chain?.after ?? [];
    const proveClone = async worktree => {
      if (planned && git.originOf && !remoteMatches(await recheck(git.originOf(worktree)), nameWithOwner)) throw new Error("The fresh checkout has the wrong repository origin.");
      for (const sha of sameRepoPredecessors) {
        if (!await recheck(git.containsCommit(worktree, sha))) throw new Error(`the fresh ${base} checkout does not contain predecessor merge ${sha}; nothing spawned`);
      }
    };

    // The daemon's own copy of the brief: fix rounds and the completion gate read this, never the checkout.
    if (!recovering) writePrd(id, request.text);

    // The files the brief carries, snapshotted beside it and for the same reason. The contract rule has already read
    // every one of them, so a failure here is a race (an edit or a delete between `ready` and now) rather than a mistyped
    // path, and it must still be loud: the session would otherwise start against a brief citing a document that is not
    // there. This is above the clone because everything that can throw belongs before the irreversible step.
    const carried = [];
    for (const [rel, text] of input.sources) {
      if (!recovering) writeSource(id, rel, text);
      carried.push(rel);
    }
    const snapshot = { sources: carried, snapshot_digest: contentDigest(request.text), sources_digest: sourceManifestDigest(input.sources) };
    approvedSnapshotDigests(ctx, id, snapshot, request);

    progress.clone = { worktree: worktreePlanned, base, branch };
    assertAdmission();
    progress.cloneAttempted = true;
    let worktree = worktreePlanned, clone = claim.clone;
    if (recovering) {
      execution = executionRunner(ctx, id, request.harness);
      if (!graphLaunchUnsent(execution, claim.token)) throw new Error("The original execution needs reconciliation before retry.");
      await graphStart.verifyGraphClone(ctx, clone, { path: worktree, branch, repo: nameWithOwner, files: input.files,
        baseFiles: planned.baseFiles }, assertAdmission);
    } else {
      state.markStartClone(id, claim.token, progress.clone);
      try { worktree = await git.create({ nameWithOwner, prdId: request.id, base,
        ...(enrollment ? { enrolled: { branch, head: enrollment.head } } : {}),
        ...(planned || chain || deferred ? { dispatchGuard: () => {
          assertAdmission();
          if (deferred) ctx.deferredCI.assertLaunch(ctx, id, { ciTiming, branch });
        } } : {}) }); }
      catch (error) {
        // Keep ownership for unknown/partial failures. A known refusal before the
        // clone executor is invoked is the same clean retry boundary as preflight.
        if (error.cloneAttempted === false) progress.cloneAttempted = false;
        throw error;
      }
      if (planned && worktree === worktreePlanned) {
        clone = await graphStart.graphCloneProof(ctx, worktree, session);
        if (clone) state.markStartClone(id, claim.token, { ...progress.clone, proof: clone });
      }
    }
    assertAdmission();
    await proveClone(worktree);
    if (chain || planned) {
      await recheck(checkBaseFiles(input, planned?.baseFiles ?? chain.baseFiles, rel => recheck(git.fileAt(worktree, "HEAD", rel, { bytes: Boolean(planned) }))));
    }
    // The clone is where the process actually runs, so it is what the spawn below is given. The spec's own `cwd` was
    // `worktreePath` for the same repo and PRD id, which is what `git.create` returns; no adapter reads `ctx.cwd` today,
    // so the two are only ever compared here. A relocating `git.create` would want this to be a refusal rather than a
    // note, and if `cwd` ever reaches argv it has to become one.
    if (worktree !== worktreePlanned) log.warn(`${id}: the checkout landed at ${worktree}, not the ${worktreePlanned} the run spec was built for`);
    await recheck(git.authorStorage?.(worktree, ctx.home || config.home));
    const approved = { prd: prdRel, recovery_profile: recovery, repo: nameWithOwner, harness: request.harness, branch, base, worktree, ...snapshot,
      author_route_digest: authorRouteDigest(config, request.harness, request), task, ciTiming };
    const initialBinding = turnBinding(ctx, id, approved, request);
    const assertCurrent = () => {
      const current = progress.registered ? state.get(id) : approved;
      if (current?.dispatch_stopped || current?.repository_disabled || current?.hold?.active ||
          current?.control?.status === "queued" || current?.control?.status === "applying" ||
          turnBinding(ctx, id, current, request) !== initialBinding) throw new Error("Initial dispatch no longer owns its approved input.");
      assertAdmission();
      if (deferred) ctx.deferredCI.assertLaunch(ctx, id, current);
    };
    const routeDigest = await recheck(requireAuthorRoute(ctx, id, approved, () => {
      assertAdmission();
      if (turnBinding(ctx, id, approved, request) !== initialBinding) throw new Error("Initial approval changed.");
    }, { runtimeReady: true, resolvedCredential: credential }));
    const publicSince = floorSecond(nowIso());
    ctx.resourcePreflight?.(worktree);
    const owner = { ...(chain ? { chain: { name: chain.name, index: chain.index, dispatch: chain.dispatch } } : {}),
      ...(claim.plan ? { plan: claim.plan, repository_id: planned.repositoryId } : {}),
      ...(!claim.plan && chain?.repositoryId ? { repository_id: chain.repositoryId } : {}) };
    if (!progress.registered && (deferred || planned || remote || ctx.executionFor)) {
      assertAdmission();
      const pending = newEntry({ prd: prdRel, harness: request.harness, session: null, repo: nameWithOwner, branch, worktree, state: STATES.needsHuman, nowIso: nowIso(), checkout, prdFingerprint: prdFingerprint(request), prdDecision: prdDecision(request), base, sources: carried });
      if (recovery) pending.recovery_profile = recovery;
      Object.assign(pending, { snapshot_digest: approved.snapshot_digest, author_route_digest: approved.author_route_digest });
      pending.reviewPolicy = reviewPolicy;
      pending.ciTiming = ciTiming;
      pending.sources_digest = snapshot.sources_digest;
      // The clone is owned, but snapshot delivery and read-only API preparation
      // can still fail. Consume the claim into an actionable entry before them;
      // preserve the checkout rather than silently deleting unfinished files.
      state.putStarted(id, { ...pending, ...(remote || deferred ? { execution: { version: EXECUTION_VERSION, operationId: claim.token } } : {}),
        initial_dispatch: { version: 1, operationId: claim.token, status: "unsubmitted", ...(clone ? { clone } : {}) }, reason: "launch-preparation",
        public_since: publicSince, ...(task ? { task } : {}), ...owner,
        last: { at: nowIso(), run: null, exit: null, event: "Launch preparation pending" } }, claim.token);
      progress.registered = true;
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
    const hook = git.installHooks?.(worktree, publicationPolicyOf(request, { sources: carried, base }));
    if (hook && !hook.installed) log.warn(`${id}: publication hook could not be installed (${hook.why}); coordinator publication checks remain mandatory`);
    if (carried.length) log.info(`${id}: carried ${carried.length} file${carried.length === 1 ? "" : "s"} from ${request.checkout} into the checkout`);
    assertCurrent();
    execution = executionRunner(ctx, id, request.harness);
    const managed = await recheck(learningInput(ctx, id, { repo: nameWithOwner, harness: request.harness, session: null, prd: prdRel, sources: carried }, { ...(routeDigest ? { recoveryRouteDigest: routeDigest, recoveryProfileDigest: recovery.digest } : {}), approvalDigest: initialBinding, operationId: claim.token, sessionId: null, recordedSessionId: session, inputHead: git.head ? await recheck(git.head(worktree)) : null, prompt }));
    const { prompt: managedPrompt, ...dispatchInput } = managed;
    if (!remote && managedPrompt !== prompt) spec = buildRun({ harness: request.harness, config: runConfig, mode: "start", session, prompt: managedPrompt, cwd: worktree, contextPaths });
    let job;
    const effectGuard = () => {
      assertCurrent();
      checkCooldown();
      if (planned && input.files.some(([path, text]) => readRepositoryText(worktree, path) !== text)) throw new Error("The approved plan inputs changed in the fresh checkout.");
      verifyAuthorCopies(ctx, id, approved, request);
    };
    const launch = async dispatch => {
      effectGuard();
      if (planned) {
        await proveClone(worktree);
        await planned.prove(assertAdmission);
      }
      if (chain?.revalidate) await recheck(chain.revalidate());
      if (recovering) {
        await graphStart.verifyGraphClone(ctx, clone, { path: worktree, branch, repo: nameWithOwner, files: input.files,
          baseFiles: planned.baseFiles }, assertAdmission);
        if (!graphLaunchUnsent(execution, claim.token)) throw new Error("The original execution needs reconciliation before retry.");
      }
      if (deferred) credential = await ctx.deferredCI.author(ctx, id, approved, request, minimumMs);
      effectGuard();
      state.markStartDispatch(id, claim.token, chain, planned?.authority, !remote && typeof execution.cleanupSettled === "function");
      progress.spawnAttempted = true;
      return dispatch();
    };
    // Register the remote ownership before I/O. A launcher crash or lost reply
    // must leave an entry the existing coordinator can reconcile, with no second
    // start claim. Keep it actionable until exact launch identities are known.
    if (remote) {
      const preparedInput = await recheck(remoteInput(ctx, id, { harness: request.harness, prd: prdRel, worktree, checkout, repo: nameWithOwner, branch, base, sources: carried, task }, { ...dispatchInput, name: "start", prompt: managedPrompt }, contextPaths));
      await recheck(execution.prepare(preparedInput));
      try { job = await learningDispatch(ctx, id, managed, () => launch(() => execution.submit(preparedInput, effectGuard))); session = job.execution.sessionId; }
      catch (error) {
        if (progress.spawnAttempted && error.dispatchNotSent !== true) {
          const current = execution.current();
          if (current?.execution?.operationId === claim.token) state.update(id, {
            execution: current.execution, session: current.execution.sessionId, last: { at: nowIso(), run: current.id, exit: null, event: "managed dispatch acceptance unresolved" } });
        }
        throw error;
      }
    } else {
      job = await learningDispatch(ctx, id, managed, () => launch(() => execution.start("start", spec.cmd, spec.args, { cwd: worktree, runtimeSettings: spec.runtimeSettings, env: runSessionEnv(spec.env, config, credential, identity, worktree), execution: dispatchInput }, effectGuard)));
    }

    // `checkout` and the two prd fields are what the divergence check compares against: where the operator's copy lives,
    // the contract the snapshot above carries, and the readiness decision the brief was blessed with. All three are
    // recorded at the same moment as the snapshot, because a fingerprint of a brief other than the one snapshotted is
    // worse than no fingerprint at all.
    const entry = newEntry({
      prd: prdRel, harness: request.harness, session, repo: nameWithOwner, branch, worktree, state: STATES.running, nowIso: nowIso(),
      checkout, prdFingerprint: prdFingerprint(request), prdDecision: prdDecision(request), base, sources: carried,
    });
    if (recovery) entry.recovery_profile = recovery;
    entry.snapshot_digest = approved.snapshot_digest;
    entry.author_route_digest = approved.author_route_digest;
    entry.reviewPolicy = reviewPolicy;
    entry.ciTiming = ciTiming;
    entry.sources_digest = snapshot.sources_digest;
    const startedEntry = { ...entry, ...(progress.registered ? { initial_dispatch: null } : {}), ...(job.execution ? { execution: job.execution } : {}), ...(task ? { task: { ...task, run: job.id } } : {}), public_since: publicSince, ...owner, last: { at: nowIso(), run: job.id, exit: null, event: "start" } };
    let registeredEntry, previousEntry = null;
    if (progress.registered) registeredEntry = state.update(id, current => {
      previousEntry = current;
      if (current.start_token !== claim.token || current.initial_dispatch?.operationId !== claim.token) return {};
      return { initial_dispatch: null, session, execution: job.execution, ...(task ? { task: startedEntry.task } : {}),
        ...(current.dispatch_stopped || current.control?.status === "queued" || current.control?.status === "applying" ? {} : { state: startedEntry.state, reason: null }),
        last: startedEntry.last, ...learningDeliveryPatch(current, managed, job) };
    });
    else registeredEntry = state.putStarted(id, { ...startedEntry, ...learningDeliveryPatch(null, managed, job) }, claim.token);
    if (ctx.collaboration) {
      try { ctx.collaboration.observeEntry(id, previousEntry, registeredEntry, { actor: { type: "owner", id: "task-owner" }, source: { type: "command", id: "start" } }); }
      catch (error) { log.warn(`${id}: collaboration event capture unavailable (${error.code || "storage error"}); start preserved`); }
    }
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
    const persistBase = baseSource === "flag" && !chain && !graph ? base : null;
    rememberRepo(nameWithOwner, config.home, persistBase);
    if (persistBase) log.info(`${nameWithOwner}: base branch ${base} recorded in ${config.home}/config.json; later starts in this repository need no --base`);
    if (isNewRepo) await host.ensureLabels(nameWithOwner).catch(e => log.warn(`${nameWithOwner}: labels not created: ${e.message}`));
    log.info(`${id}: started ${request.harness} session in ${worktree}`);
    return { id, worktree, branch, base, baseSource, session, run: job.id };
  } catch (error) {
    const unsent = !progress.spawnAttempted || dispatchProvenUnsent(error, execution, claim.token);
    if (!progress.cloneAttempted && !progress.spawnAttempted) state.releaseStart(id, claim.token);
    else if (unsent) state.finishUnsentStart(id, claim.token);
    if (ctx.collaboration && progress.registered && unsent) {
      try { ctx.collaboration.observeInitialLaunchFailure(id, state.get(id), claim.token); }
      catch (captureError) { log.warn(`${id}: collaboration event capture unavailable (${captureError.code || "storage error"}); launch failure preserved`); }
    }
    throw error;
  }
}
