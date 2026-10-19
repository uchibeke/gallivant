// Versioned, in-process task API. Importing this module reads no user config,
// starts no daemon and makes no network calls. Clients supply the usual context.
import { acquireServiceMutation } from "./daemon.mjs";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join, dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { ensureDir, readText } from "./fs.mjs";
import { resolveBase } from "./config.mjs";
import { capabilitiesFor, executionCapabilities } from "./harness.mjs";
import { repositoryPath, readRepositoryText, writeRepositoryText } from "./repository_files.mjs";
import { request as prdRequest } from "./sources/prd.mjs";
import { contentDigest, captureStartInput } from "./start_contract.mjs";
import { ready } from "./commands/ready.mjs";
import { start } from "./commands/start.mjs";
import { upInBackground } from "./commands/up.mjs";
import { entryId } from "./state.mjs";
import { taskStore, taskRoot, taskError } from "./task_store.mjs";
import { redact } from "./execution_io.mjs";
import { executionRunner } from "./execution.mjs";
import { recoverControl } from "./control.mjs";
import { canonical } from "./learning_data.mjs";
import { COMPLETION_CAPABILITIES, completionPolicy, completionView } from "./task_completion.mjs";
import { assertDeliveryAnswer } from "./owner_delivery.mjs";
import { prepareTurn, assertPreparationBoundary, preparationCancellationPending, preparationPreflightRetryable, PREPARATION_PENDING } from "./task_prepare.mjs";
import { TASK_VERSION, MAX_REPAIRS, MAX_CONTEXT_BYTES, MANAGER_LOCKFILES, requireText, fragments, requireTaskCapacity, parseTaskSources, parseDraft, renderDraft, validateDraft, collectCommands, mappedQuestions } from "./task_contract.mjs";
import { MAX_ANSWER_BYTES, MAX_ANSWER_COUNT, MAX_LEGACY_ANSWER_BATCH_BYTES } from "./task_limits.mjs";
import { DELIVERY_CAPABILITIES, deliveryProfile, savedProfile, typedEraTask, assertProfileBound, profileView, stableProfile, profileAssumption } from "./task_profile.mjs";
import { prepareModelTurn } from "./task_model_route.mjs";
import { intakeModelRoute, intakeModelRouteSummary, pinnedModelRoute } from "./task_model_config.mjs";
import { repositorySnapshot } from "./task_repository_context.mjs";

export { TASK_VERSION } from "./task_contract.mjs";
export const TASK_ROUTES = Object.freeze(["harness", "model"]);

// The planner route is a saved task property. Harness drafting keeps the
// existing dispatch; the model route is the bounded text-only request.
const routedPrepare = (ctx, task, store, failures) => task.route === "model" ? prepareModelTurn(ctx, task, store, failures) : prepareTurn(ctx, task, store, failures);

// A saved typed profile must validate before any mutation can act on it; an
// unsupported version, or a typed-era record with no profile at all, fails
// closed with its recovery path and leaves reads open.
const assertProfileUsable = task => { const profile = savedProfile(task); if (profile) assertProfileBound(profile, task); };

// Reported, bounded or unknown. Never zero while any call lacks evidence.
function costView(attempts) {
  const calls = attempts.filter(a => a.startedAt);
  if (!calls.length) return { status: "none", usd: 0, detail: "no planning call has been made" };
  const unknown = calls.filter(a => a.cost == null);
  if (!unknown.length) return { status: "reported", usd: calls.reduce((sum, a) => sum + a.cost, 0), detail: "sum of provider-reported or usage-derived costs" };
  if (unknown.every(a => Number.isFinite(a.reservedUsd))) return { status: "bounded", usd: calls.reduce((sum, a) => sum + Math.max(a.cost ?? 0, a.reservedUsd ?? 0), 0), detail: `${unknown.length} call(s) reported no cost; their reservations bound the total` };
  return { status: "unknown", usd: null, detail: `${unknown.length} call(s) reported no cost and carry no reservation` };
}
function routeView(task) {
  const attempts = task.attempts || [];
  const usage = attempts.reduce((sum, a) => {
    const u = a.usage && !Array.isArray(a.usage) ? a.usage : null;
    return u && Number.isSafeInteger(u.inputTokens) ? { inputTokens: (sum?.inputTokens || 0) + u.inputTokens, outputTokens: (sum?.outputTokens || 0) + (u.outputTokens || 0) } : sum;
  }, null);
  const base = { route: task.route || "harness", calls: attempts.length, usage, cost: costView(attempts), tools: [] };
  if (task.route === "model") return { ...base, kind: "model", adapter: task.modelRoute?.adapter || null, model: task.modelRoute?.model || null, endpointHost: task.modelRoute?.endpointHost || null, limits: task.modelRoute?.budget || null, boundary: attempts.at(-1)?.boundary || null, harness: task.harness };
  return { ...base, kind: "harness", harness: task.harness, boundary: attempts.at(-1)?.boundary || null, account: attempts.at(-1)?.receipt?.account || null };
}
// Everything an owner must see before approving, pinned to one revision and
// digested so a changed material input is detectable, not merely re-rendered.
// Reads tolerate an unsupported saved profile (inspection must keep working);
// every mutation validates it first and fails closed.
const safeProfile = task => { try { return savedProfile(task); } catch { return null; } };
function reviewDigest(task) {
  const profile = safeProfile(task);
  return contentDigest(JSON.stringify({ original: task.original, requirements: task.requirements, answers: task.answers, deliveryProfile: profile ? stableProfile(profile) : task.deliveryProfile ? { unsupported: task.deliveryProfile } : typedEraTask(task) ? { unsupported: null } : null, completion: task.completion || null,
    harness: task.harness, route: task.route || "harness", modelRoute: task.modelRoute ? { adapter: task.modelRoute.adapter, model: task.modelRoute.model, endpoint: task.modelRoute.endpoint, budget: task.modelRoute.budget, timeoutMs: task.modelRoute.timeoutMs } : null, draft: task.draft?.hash || null, sources: task.context.map(c => ({ path: c.path, hash: c.hash })), verify: task.explicitVerifyCommands || [], repository: task.repositoryContext?.digest || null, allowance: task.allowance }));
}
function reviewView(task) {
  if (!task.draft || !task.output) return null;
  const profile = safeProfile(task);
  const requirements = new Map(task.requirements.map(r => [r.id, r]));
  const screened = [];
  const requirementMap = task.output.mapping.map(m => {
    const r = requirements.get(m.requirementId);
    if (profile && m.screen?.tier === "assumption") screened.push(profileAssumption(profile, r, m.screen));
    return { requirementId: m.requirementId, source: r?.source || null, text: r?.text,
      target: m.questionId ? { kind: "question", id: m.questionId } : m.assumption !== undefined ? { kind: "assumption", text: m.assumption } : { kind: "criteria", ids: m.criteria },
      resolvedBy: m.resolvedBy || null, delivery: m.delivery || null, covered: m.covered ?? null, screen: m.screen || null, conflict: m.conflict || null };
  });
  return { revision: task.revision, digest: reviewDigest(task), request: { text: task.original, immutable: true, hash: contentDigest(task.original) },
    requirements: task.requirements, requirementMap, questions: task.questions, assumptions: [...task.output.assumptions, ...screened],
    draft: { path: task.draft.path, hash: task.draft.hash, revision: task.draft.revision, text: readText(task.draft.path) },
    deliveryProfile: profileView(task), harness: task.harness, allowance: task.allowance, modelRoute: routeView(task), cost: costView(task.attempts || []),
    repositoryContext: task.repositoryContext || null, readiness: task.readiness, approval: task.approval || null };
}

function selectedPaths(selected) {
  if (!Array.isArray(selected) || selected.some(p => typeof p !== "string")) throw taskError("TASK_INPUT", "context must be an array of selected repository file paths");
  const selection = parseTaskSources(selected);
  if (selection.problems.length) throw taskError("TASK_INPUT", selection.problems.join("; "));
  return selection.paths;
}

function selectedContext(checkout, selected, pinned = [], secrets = null) {
  const selection = selectedPaths(selected);
  const paths = new Set([...pinned.map(c => c.path), ...selection]);
  for (const p of ["AGENTS.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile"]) {
    if (existsSync(join(checkout, p))) paths.add(p);
  }
  for (const manifest of paths) if (/(?:^|\/)package\.json$/.test(manifest)) {
    for (const name of Object.keys(MANAGER_LOCKFILES)) {
      const path = join(dirname(manifest), name);
      if (existsSync(join(checkout, path))) paths.add(path);
    }
  }
  for (const p of selection) {
    let dir = dirname(p);
    while (dir !== "." && dir !== "/") {
      const instructions = join(dir, "AGENTS.md");
      if (existsSync(join(checkout, instructions))) paths.add(instructions);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const parsed = parseTaskSources([...paths]);
  if (parsed.problems.length) throw taskError("TASK_INPUT", parsed.problems.join("; "));
  let bytes = 0;
  return parsed.paths.map(path => {
    const previous = pinned.find(c => c.path === path);
    // Accepted bytes stay pinned when collecting instructions for new documents.
    // Explicit reselection must match them, rather than overwrite earlier context.
    const read = !previous || selection.includes(path);
    if (read && statSync(repositoryPath(checkout, path)).size + bytes > MAX_CONTEXT_BYTES) throw taskError("TASK_INPUT", `selected context exceeds ${MAX_CONTEXT_BYTES} bytes; select fewer documents`);
    const text = read ? readRepositoryText(checkout, path) : previous.text;
    if (secrets !== null && text !== redact(text, secrets)) throw taskError("TASK_SECRET", "Selected context contains credential material; remove it before preparation");
    bytes += Buffer.byteLength(text);
    if (text.includes("\0") || bytes > MAX_CONTEXT_BYTES) throw taskError("TASK_INPUT", `selected context must be text under ${MAX_CONTEXT_BYTES} total bytes; select fewer documents`);
    const hash = contentDigest(text);
    if (previous && hash !== previous.hash) throw taskError("TASK_CONFLICT", `selected context is already pinned: ${path}; use a new task to replace accepted context`);
    return { path, text, hash };
  });
}

function explicitCommands(value) {
  if (!Array.isArray(value)) throw taskError("TASK_INPUT", "verifyCommands must be an array of explicitly selected commands");
  return value;
}
function commandCandidates(context, explicit = []) {
  return collectCommands(context, explicitCommands(explicit)).commands;
}

const same = isDeepStrictEqual;
function implementationMatches(task, entry) {
  return entry.task?.id === task.id && entry.task?.digest === task.readiness?.digest && same(entry.task?.completion, task.completion) && same(entry.task?.ownerDelivery, task.ownerDelivery) && same(entry.task?.deliveryProfile, task.deliveryProfile);
}
function questionOwnership(task) {
  const ownership = { ...task.questionMappings };
  if (!task.output?.questions.length) return ownership;
  const mappings = mappedQuestions(task.output);
  for (const q of task.output.questions) {
    if (!same(task.questionHistory[q.id], q)) throw new Error(`saved question ${q.id} differs from its accepted history`);
    const owned = ownership[q.id];
    if (owned && (new Set(owned).size !== owned.length || owned.length !== mappings[q.id].length || owned.some(id => !mappings[q.id].includes(id)))) throw new Error(`saved question ${q.id} ownership differs from its unresolved mappings`);
    ownership[q.id] = mappings[q.id];
  }
  return ownership;
}
// Only explicit pre-effect refusals carry this proof. Unknown/provider errors
// must retain their durable delivery intent for reconciliation.
const taskRejection = (code, message) => Object.assign(taskError(code, message), { taskEffects: "none" });
const beforeTaskEffects = fn => {
  try { return fn(); } catch (error) { error.taskEffects = "none"; throw error; }
};
const expectRevision = (task, expected) => {
  if (!Number.isSafeInteger(expected) || expected !== task.revision) throw taskRejection("TASK_CONFLICT", `expected revision ${expected ?? "missing"}, current revision ${task.revision}; inspect the task and retry with its current revision`);
};
const mutate = (task, store) => { task.revision++; task.updatedAt = new Date().toISOString(); store.save(task); };

export function createTaskService(ctx, { prepare = routedPrepare, decideReady = ready, dispatch = start, daemon = upInBackground, store = taskStore(ctx.home), mutationOwner = null } = {}) {
  const result = task => {
    const entry = task.implementation && ctx.state.get(task.implementation.id);
    const claim = ctx.state.startClaim(entryId(task.repo, task.id));
    const candidates = collectCommands(task.context, task.explicitVerifyCommands || []);
    return {
    version: TASK_VERSION, taskId: task.id, revision: task.revision, status: task.status,
    original: task.original, repo: task.repo, checkout: task.checkout, callerCwd: task.callerCwd || task.checkout, base: task.base, baseSource: task.baseSource, harness: task.harness,
    questions: task.questions, answers: task.answers, requirements: task.requirements,
    assumptions: task.output?.assumptions || [], mapping: task.output?.mapping || [], stories: task.output?.stories || [],
    draft: task.draft ? { path: task.draft.path, hash: task.draft.hash, revision: task.draft.revision, current: task.draft.requirementsHash === contentDigest(JSON.stringify(task.requirements)), text: readText(task.draft.path) } : null,
    readiness: task.readiness, validation: task.validation || null,
    completion: completionView(task.completion, entry, task.ownerDelivery, entry ? executionRunner(ctx, task.implementation.id, entry.harness)?.current?.() : null),
    deliveryProfile: profileView(task), route: task.route || "harness", modelRoute: routeView(task), cost: costView(task.attempts || []),
    repositoryContext: task.repositoryContext || null, review: reviewView(task), approval: task.approval || null,
    errorCode: task.errorCode || null,
    implementation: task.implementation ? { ...task.implementation, state: entry?.state || null, pr: entry?.pr || null, url: entry?.url || null } : null, failures: task.failures,
    dispatchRecovery: claim?.clone || null,
    preparation: { repairs: task.repairs, attempts: task.attempts.map(({ message: _message, ...attempt }) => attempt), allowance: task.allowance },
    sources: task.context.map(c => ({ path: c.path, hash: c.hash })),
    verifyCommands: candidates.commands.map(command => ({ command, sources: candidates.sources[command] || [] })), commandIssues: candidates.issues,
    artifacts: task.draft ? [{ id: "brief", path: task.draft.path, hash: task.draft.hash }, ...task.output.sources.map(path => ({ id: `source:${path}`, path: join(task.draft.root, path), hash: task.context.find(c => c.path === path).hash }))] : [],
    nextAction: preparationCancellationPending(task) ? "resume the owned cancellation with the current revision; no new preparation or implementation is authorized" : task.status === "needs-input" ? "answer the saved question IDs using the current revision" : task.status === "ready" ? (task.runAuthorized ? "start the approved revision" : "review the draft, then start with explicit run authorization") : task.status === "started" ? "follow the implementation through status, why, and the tracker" : task.status === "blocked" ? (preparationPreflightRetryable(task) ? "resume the current revision to retry the pre-submit provider check; no model job was submitted" : "resolve the reported failure; inspect the saved evidence before retrying") : "resume preparation with the current revision",
    };
  };
  const requestForTask = task => {
    const text = readText(task.draft?.path);
    if (text === null) throw taskError("TASK_CONFLICT", "saved draft is missing; inspect the task artifacts");
    const req = { ...prdRequest(text, task.draft.path), checkout: task.draft.root, relPath: `docs/prds/${task.id}.md`, repo: task.repo, defaultBranch: task.defaultBranch };
    const sources = parseTaskSources(task.output.sources);
    if (sources.problems.length) throw taskError("TASK_CONFLICT", sources.problems.join("; "));
    for (const path of sources.paths) {
      const source = task.context.find(c => c.path === path);
      if (!source) throw taskError("TASK_CONFLICT", `saved source was not selected: ${path}`);
      if (contentDigest(readRepositoryText(task.draft.root, path)) !== source.hash) throw taskError("TASK_CONFLICT", `saved source snapshot changed: ${path}`);
    }
    return req;
  };
  const savedDraft = task => {
    const req = requestForTask(task);
    if (contentDigest(req.text) !== task.draft.hash) {
      // ready writes status/decision before intake can save the acknowledgement.
      // Recover that narrow write, then ask the actual gate again. Body, sources,
      // runtime and all other settings still have to match the pinned contract.
      if (task.status !== "validating" || !task.readiness?.pending || req.status !== "ready" || !validateDraft(task, req).ok) throw taskError("TASK_CONFLICT", "draft revision changed outside intake; accepted requirements were not overwritten");
      task.draft.hash = contentDigest(req.text);
      store.save(task);
    }
    return req;
  };
  const block = (task, error) => {
    if (error.code === "TASK_PREPARATION_BOUNDARY") task.readiness = null;
    task.status = "blocked";
    task.failures = [error.message];
    task.errorCode = error.code || "TASK_FAILED";
    mutate(task, store);
    return result(task);
  };
  const validateInternal = async task => {
    assertPreparationBoundary(task, ctx);
    const request = savedDraft(task);
    const validation = validateDraft(task, request);
    if (task.questions.length) return result(task);
    if (!validation.ok) return block(task, taskError("TASK_VALIDATION", validation.failures.join("\n")));
    if (task.readiness?.allow && task.readiness.hash === task.draft.hash) return result(task);
    // Persist the decision intent too; a crash can repeat the readiness check,
    // but can never treat an unrecorded/denied result as approval.
    task.readiness = { allow: false, revision: task.revision, hash: task.draft.hash, pending: true };
    store.save(task);
    const decision = await decideReady({ path: request.path, config: ctx.config, apiKey: ctx.aportApiKey, log: ctx.log });
    if (!decision.ok) {
      task.readiness = { allow: false, hash: task.draft.hash, report: decision.report, decisionId: decision.decisionId };
      return block(task, taskError("TASK_READINESS_DENIED", decision.report));
    }
    const approved = requestForTask(task);
    const post = validateDraft(task, approved);
    if (!post.ok || approved.status !== "ready") throw taskError("TASK_CONFLICT", "readiness did not preserve the generated contract or mark it ready");
    task.draft.hash = contentDigest(approved.text);
    const input = captureStartInput(approved, task.base);
    task.readiness = { allow: true, hash: task.draft.hash, digest: input.digest, decisionId: decision.decisionId, report: decision.report };
    task.status = "ready";
    task.failures = [];
    mutate(task, store);
    task.readiness.revision = task.revision;
    store.save(task);
    return result(task);
  };
  const startInternal = async (task, noDaemon = false) => {
    const id = entryId(task.repo, task.id);
    const entry = ctx.state.get(id);
    if (entry) {
      if (!implementationMatches(task, entry)) throw taskError("TASK_CONFLICT", "implementation ownership or completion target differs from the approved intake");
      task.implementation = { id, run: entry.task.run || entry.last?.run, worktree: entry.worktree, branch: entry.branch, base: entry.base, baseSource: entry.task.baseSource || task.baseSource, session: entry.session };
      task.status = "started";
      const saved = store.read(task.id);
      if (saved.status !== "started" || !same(task.implementation, saved.implementation)) mutate(task, store);
    } else {
      const claim = ctx.state.startClaim(id);
      if (claim) return block(task, taskError("TASK_DISPATCH_UNKNOWN", `unresolved start claim for ${id}; inspect ${claim.clone?.worktree ? `its clone at ${claim.clone.worktree}, ` : ""}its run and snapshots before recovery; no duplicate was dispatched`));
      if (task.dispatchIntent) return block(task, taskError("TASK_DISPATCH_UNKNOWN", `dispatch acceptance for ${id} is unknown; inspect its saved artifacts before recovery; no duplicate was dispatched`));
      if (!task.runAuthorized) throw taskError("TASK_AUTHORIZATION", "start requires explicit run authorization");
      assertPreparationBoundary(task, ctx);
      const req = savedDraft(task);
      if (task.questions.length || !task.readiness?.allow || task.readiness.hash !== task.draft.hash || task.readiness.digest !== captureStartInput(req, task.base).digest) throw taskError("TASK_NOT_READY", "current revision has unresolved requirements or no exact readiness approval; validate it before starting");
      const validation = validateDraft(task, req);
      if (!validation.ok) throw taskError("TASK_CONFLICT", validation.failures.join("\n"));
      let deliveryAllowance;
      if (ctx.enforceTaskAllowance) {
        if (task.attempts.some(a => a.cost == null && !Number.isFinite(a.reservedUsd))) throw taskError("TASK_ALLOWANCE", "Preparation cost is unknown without a reservation; reconcile it before authorizing implementation");
        const spent = task.attempts.reduce((sum, a) => sum + Math.max(a.cost ?? 0, a.reservedUsd ?? 0), 0);
        deliveryAllowance = { budgetUsd: task.allowance.budgetUsd - spent, runtimeMs: task.allowance.runtimeMs - task.attempts.reduce((sum, a) => sum + (a.elapsedMs || 0), 0) };
        if (deliveryAllowance.budgetUsd <= 0 || deliveryAllowance.runtimeMs <= 0) throw taskError("TASK_ALLOWANCE", "Preparation exhausted the task allowance; no implementation was dispatched");
      }
      // The approval pins the reviewed revision. A separate explicit start
      // records it; `--run` preparation records it at the first dispatch of
      // the validated revision. Any later material change clears it.
      const digest = reviewDigest(task);
      if (task.approval && task.approval.digest !== digest) throw taskError("TASK_CONFLICT", "the approved review revision changed; inspect the current review and approve it again before starting");
      task.approval ??= { revision: task.revision, digest, draftHash: task.draft.hash, readinessDigest: task.readiness.digest, at: new Date().toISOString() };
      task.dispatchIntent = { id, revision: task.revision, digest: task.readiness.digest, at: new Date().toISOString() };
      store.save(task);
      try {
        task.implementation = await dispatch(ctx, { path: req.path, request: req, base: task.base, task: { id: task.id, revision: task.revision, digest: task.readiness.digest, baseSource: task.baseSource, ...(task.completion ? { completion: task.completion } : {}), ...(task.ownerDelivery ? { ownerDelivery: task.ownerDelivery } : {}), ...(task.deliveryProfile ? { deliveryProfile: task.deliveryProfile, approval: task.approval } : {}), ...(deliveryAllowance ? { deliveryAllowance } : {}) } });
      } catch (e) {
        if (e.startUncertain === false && !ctx.state.get(id) && !ctx.state.startClaim(id)) task.dispatchIntent = null;
        return block(task, e);
      }
      task.status = "started";
      mutate(task, store);
    }
    if (!noDaemon) {
      try { await daemon(ctx); task.daemonError = null; }
      catch (e) { task.daemonError = `implementation is saved, but the daemon could not start: ${e.message}; run gallivant up after fixing it; do not dispatch again`; }
      store.save(task);
    }
    return { ...result(task), daemonError: task.daemonError || null };
  };
  const prepareInternal = async (task, noDaemon = false) => {
    if (task.status === "started") return startInternal(task, noDaemon);
    // An implementation accepted before this safety change still belongs to its
    // original dispatch. Reconcile that ownership without preparing or spawning.
    if (ctx.state.get(entryId(task.repo, task.id))) return startInternal(task, noDaemon);
    if (["needs-input", "ready"].includes(task.status)) {
      try { assertPreparationBoundary(task, ctx); }
      catch (e) { return block(task, e); }
      return task.status === "ready" && task.runAuthorized ? startInternal(task, noDaemon) : result(task);
    }
    // A blocked legacy timeout may still own a pending remote stop. An explicit
    // resume reconciles only that control; it cannot retry preparation/refusals.
    if (task.status === "blocked" && !preparationCancellationPending(task)) {
      if (!preparationPreflightRetryable(task)) return result(task);
      task.status = "preparing";
      task.failures = task.preflightFailure.validationFailures || [];
      task.errorCode = null;
      delete task.preflightFailure;
      mutate(task, store);
    }
    // A legacy answer may have been saved just before a crash. Its unresolved
    // output still proves ownership; recover that before replay or a new turn.
    try { task.questionMappings = questionOwnership(task); }
    catch (e) { return block(task, taskError("TASK_CONFLICT", `${e.message}; inspect the saved brief before resuming`)); }
    if (task.status === "validating") {
      try {
        const validated = await validateInternal(task);
        return task.runAuthorized && validated.readiness?.allow ? await startInternal(task, noDaemon) : validated;
      } catch (e) { return block(task, e); }
    }
    // Rebuild inferred candidates on reopen; a legacy cached command is not an
    // explicit owner selection. Saved validation applies the same policy.
    task.commandCandidates = commandCandidates(task.context, task.explicitVerifyCommands || []);
    let failures = task.failures || [];
    for (;;) {
      let message;
      try {
        // Reconcile an already-owned turn before rejecting legacy oversized
        // state, so usage/cleanup survive recovery. Never launch a new turn.
        const previous = task.attempts.at(-1);
        if (!previous || (previous.settled && previous.consumed)) requireTaskCapacity(task);
        message = await prepare(ctx, task, store, failures);
        if (message === PREPARATION_PENDING) return result(task); // Owned remote preparation is pending.
        if (Array.isArray(ctx.taskSecrets) && message !== redact(message, ctx.taskSecrets)) throw taskError("TASK_SECRET", "Preparation output contains credential material; inspect the private provider record before recovery");
        requireTaskCapacity(task);
      }
      catch (e) { if (e.code === "TASK_INPUT") task.readiness = null; return block(task, e); }
      try {
        const output = parseDraft(message, task);
        task.output = output;
        task.questions = output.questions;
        for (const q of output.questions) task.questionHistory[q.id] = q;
        task.questionMappings = { ...task.questionMappings, ...mappedQuestions(output) };
        const root = ensureDir(join(taskRoot(ctx.home, task.id), "drafts", `revision-${task.revision + 1}`));
        for (const c of task.context) writeRepositoryText(root, c.path, c.text);
        const rel = `docs/prds/${task.id}.md`;
        const text = renderDraft(task, output);
        writeRepositoryText(root, rel, text);
        task.draft = { root, path: join(root, rel), hash: contentDigest(text), revision: task.revision + 1, requirementsHash: contentDigest(JSON.stringify(task.requirements)) };
        task.readiness = null;
        const validation = validateDraft(task, requestForTask(task));
        task.validation = { ok: validation.ok, failures: validation.failures };
        if (output.questions.length) {
          if (task.attempts.at(-1)) task.attempts.at(-1).consumed = true;
          task.status = "needs-input";
          task.failures = [];
          mutate(task, store);
          return result(task);
        }
        if (!validation.ok) throw taskError("TASK_VALIDATION", validation.failures.join("\n"));
      } catch (e) {
        if (task.attempts.at(-1)) task.attempts.at(-1).consumed = true;
        failures = [e.message];
        task.failures = failures;
        if (task.repairs >= MAX_REPAIRS) return block(task, taskError("TASK_VALIDATION", `after ${MAX_REPAIRS} repair attempts: ${failures.join("; ")}`));
        task.repairs++;
        mutate(task, store);
        continue;
      }
      if (task.attempts.at(-1)) task.attempts.at(-1).consumed = true;
      task.status = "validating";
      mutate(task, store);
      try {
        const validated = await validateInternal(task);
        if (!validated.readiness?.allow) return validated;
        return task.runAuthorized ? await startInternal(task, noDaemon) : validated;
      } catch (e) { return block(task, e); }
    }
  };
  const service = {
    version: TASK_VERSION,
    capabilities: () => ({ version: TASK_VERSION, providers: executionCapabilities(), completion: COMPLETION_CAPABILITIES, delivery: DELIVERY_CAPABILITIES, routes: TASK_ROUTES, modelRoute: intakeModelRouteSummary(ctx.config, ctx.env ?? process.env) }),
    inspect: ({ taskId }) => result(store.read(taskId)),
    list: () => ({ version: TASK_VERSION, tasks: store.list().map(result) }),
    prepare: async ({ text, dir = process.cwd(), repo = null, base = null, harness = null, context = [], requestId = null, run = false, noDaemon = false, verifyCommands = [], completion, delivery, route = null }) => {
      // Capture before any async repository resolution or isolated planning turn.
      // Repository selection can differ from the invocation directory.
      const callerCwd = process.cwd();
      beforeTaskEffects(() => requireText(text, "task request"));
      const selectedCompletion = beforeTaskEffects(() => completionPolicy(completion));
      // Typed delivery input is validated before any effect; the resolved
      // repository and base are bound into the profile once they are known.
      beforeTaskEffects(() => deliveryProfile(delivery, { completion: completion === undefined ? undefined : selectedCompletion.target, repository: "owner/name", base: "main" }));
      if (route !== null && !TASK_ROUTES.includes(route)) throw taskRejection("TASK_INPUT", `route must be one of ${TASK_ROUTES.join(", ")}`);
      const originalRequirements = beforeTaskEffects(() => requireTaskCapacity({ requirements: fragments(text) }));
      if (requestId !== null) beforeTaskEffects(() => requireText(requestId, "request identity", 256));
      beforeTaskEffects(() => selectedPaths(context)); // Pure path checks precede even legacy identity replay.
      const checkout = await ctx.git.toplevel(resolve(callerCwd, dir));
      const info = await ctx.gh.repoInfo(checkout);
      if (!/^[\w.-]+\/[\w.-]+$/.test(info.nameWithOwner)) throw taskRejection("TASK_INPUT", "repository must resolve to owner/name");
      if (repo && repo.toLowerCase() !== info.nameWithOwner.toLowerCase()) throw taskRejection("TASK_CONFLICT", "selected repository does not match the checkout");
      const selected = harness || Object.keys(ctx.config.harness)[0];
      const capability = beforeTaskEffects(() => ctx.capabilitiesFor?.(selected) || capabilitiesFor(selected));
      if (!ctx.config.harness[selected]) throw taskRejection("TASK_INPUT", `harness ${selected} is not configured`);
      // Route selection: a connected harness with a declared preparation
      // boundary drafts through existing dispatch; otherwise the operator's
      // configured model route, if enabled. Neither is chosen by request text.
      const modelRoute = intakeModelRoute(ctx.config, ctx.env ?? process.env);
      const harnessUsable = Boolean(capability.available && capability.preparation);
      // Live route availability matters only when a task is created; an exact
      // retry of a saved task replays below even if the credential is absent now.
      let selectedRoute = route;
      if (route === null) selectedRoute = harnessUsable ? "harness" : modelRoute.enabled ? "model" : "harness";
      const selection = beforeTaskEffects(() => resolveBase({ config: ctx.config, repo: info.nameWithOwner, defaultBranch: info.defaultBranch, asked: base }));
      const resolvedBase = selection.base;
      if (!resolvedBase) throw taskRejection("TASK_INPUT", "repository has no resolved base; supply --base");
      // Retry identity includes repo, but not content: different content using the
      // same identity must conflict rather than silently allocate a second task.
      const id = requestId ? `task-${contentDigest(JSON.stringify([info.nameWithOwner.toLowerCase(), requestId])).slice(0, 24)}` : `task-${randomBytes(12).toString("hex")}`;
      return store.locked(id, async () => {
        // Omitted policy retains legacy request signatures and replay identity.
        const profile = beforeTaskEffects(() => deliveryProfile(delivery, { completion: completion === undefined ? undefined : selectedCompletion.target, repository: info.nameWithOwner, base: resolvedBase }));
        // Omitted typed inputs retain legacy request signatures and replay identity.
        const signature = contentDigest(JSON.stringify({ text, checkout, base: resolvedBase, harness: selected, context, verifyCommands, run, ...(completion === undefined ? {} : { completion: selectedCompletion }), ...(delivery === undefined ? {} : { delivery: stableProfile(profile) }), ...(route === null ? {} : { route }) }));
        let task;
        try { task = store.read(id); } catch (e) { if (e.code !== "TASK_NOT_FOUND") throw e; }
        if (task) {
          if (task.signature !== signature) throw taskRejection("TASK_CONFLICT", "request identity already belongs to different input; reopen that task or use a new identity");
          beforeTaskEffects(() => assertProfileUsable(task));
          if (["ready", "needs-input"].includes(task.status)) {
            if (ctx.state.get(entryId(task.repo, task.id))) return startInternal(task, noDaemon);
            try { assertPreparationBoundary(task, ctx); }
            catch (e) { return block(task, e); }
          }
          // Retries retain the first accepted path base, including version-1
          // records whose signatures predate callerCwd. Readiness may have been
          // saved just before a crash; honor its already-persisted authorization.
          return ["preparing", "validating"].includes(task.status) || (task.status === "ready" && task.runAuthorized)
            ? prepareInternal(task, noDaemon) : result(task);
        }
        if (route === "model" && !modelRoute.enabled) throw taskRejection("TASK_MODEL_ROUTE", `${modelRoute.reason}; no model call was made`);
        // New tasks use only the typed profile. The free-text ownership
        // partition is never created here; saved request identities, approved
        // drafts and provider receipts retain their original semantics.
        const requirements = originalRequirements;
        beforeTaskEffects(() => requireTaskCapacity({ requirements, deliveryProfile: profile }));
        const selectedFiles = beforeTaskEffects(() => selectedContext(checkout, context, [], ctx.taskSecrets ?? null));
        const explicit = beforeTaskEffects(() => [...explicitCommands(verifyCommands)]);
        const candidates = beforeTaskEffects(() => commandCandidates(selectedFiles, explicit));
        const repositoryContext = await repositorySnapshot(ctx.git, checkout, { secrets: ctx.taskSecrets ?? [] });
        // Pin the complete route selection; later turns execute against it and
        // the review digest covers it, so a configuration change cannot swap the
        // route under an existing draft. The credential stays in the environment.
        const pinnedRoute = selectedRoute === "model" ? pinnedModelRoute(modelRoute.route) : null;
        task = {
          version: TASK_VERSION, id, revision: 1, original: text, signature, requestId,
          checkout, callerCwd, repo: info.nameWithOwner.toLowerCase(), defaultBranch: info.defaultBranch, base: resolvedBase, baseSource: selection.source, harness: selected,
          context: selectedFiles, explicitVerifyCommands: explicit, commandCandidates: candidates, completion: { version: 1, target: profile.completion.condition },
          deliveryProfile: profile, route: selectedRoute, repositoryContext, approval: null,
          ...(pinnedRoute ? { modelRoute: pinnedRoute } : {}),
          requirements, answers: {}, questionHistory: {}, questionMappings: {}, questions: [],
          output: null, draft: null, readiness: null, implementation: null, dispatchIntent: null,
          runAuthorized: run === true, status: "preparing", repairs: 0, attempts: [], failures: [],
          allowance: { budgetUsd: ctx.config.max_budget_usd, runtimeMs: ctx.config.run_timeout_minutes * 60_000 },
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), operations: {},
        };
        store.save(task);
        return prepareInternal(task, noDaemon);
      });
    },
    answer: async ({ taskId, expectedRevision, answers, operationId, context = [], verifyCommands = [], noDaemon = false }) => store.locked(taskId, async () => {
      const task = store.read(taskId);
      beforeTaskEffects(() => requireText(operationId, "answer operation identity", 256));
      if (!answers || Array.isArray(answers) || typeof answers !== "object") throw taskRejection("TASK_INPUT", "answers must map saved question IDs to text");
      const answerIds = Object.keys(answers);
      if (!answerIds.length) throw taskRejection("TASK_INPUT", "answers must map saved question IDs to text");
      if (answerIds.length > MAX_ANSWER_COUNT) throw taskRejection("TASK_INPUT", `answer batch exceeds ${MAX_ANSWER_COUNT} question IDs`);
      const replayingOperation = Object.hasOwn(task.operations, operationId);
      const answerByteLimit = replayingOperation ? MAX_LEGACY_ANSWER_BATCH_BYTES : MAX_ANSWER_BYTES;
      let answerBytes = 0;
      const answerEntries = [];
      for (const id of answerIds) {
        const value = answers[id];
        answerEntries.push([id, value]);
        answerBytes += Buffer.byteLength(id) + (typeof value === "string" ? Buffer.byteLength(value) : 0);
        if (answerBytes > answerByteLimit) {
          const limitDescription = replayingOperation ? "legacy answer operation" : "answer batch";
          throw taskRejection("TASK_INPUT", `${limitDescription} exceeds ${answerByteLimit} total UTF-8 bytes`);
        }
      }
      // New over-limit work stops before canonical hashing or semantic parsing.
      // Existing receipts can replay only within the maximum batch that the old
      // per-answer limits and question-ID schema could have accepted.
      beforeTaskEffects(() => selectedPaths(context)); // Duplicate answers still never reread accepted files.
      // Retain exact legacy retries; new receipts ignore object member order.
      const signatureInput = { answers, verifyCommands, ...(context.length ? { context } : {}) };
      const signature = "canonical-v1:" + contentDigest(canonical(JSON.parse(JSON.stringify(signatureInput))));
      // An exact replay can resume preparation or dispatch; it needs a usable
      // saved profile just like a new answer does.
      beforeTaskEffects(() => assertProfileUsable(task));
      if (replayingOperation) {
        if (task.operations[operationId] !== signature && task.operations[operationId] !== contentDigest(JSON.stringify(signatureInput))) throw taskRejection("TASK_CONFLICT", "answer identity already belongs to different answers");
        return ["preparing", "validating"].includes(task.status) || (task.status === "ready" && task.runAuthorized)
          ? prepareInternal(task, noDaemon) : result(task);
      }
      expectRevision(task, expectedRevision);
      if (task.status !== "needs-input") throw taskRejection("TASK_CONFLICT", "this intake is not waiting for answers");
      beforeTaskEffects(() => assertProfileUsable(task));
      beforeTaskEffects(() => assertPreparationBoundary(task, ctx));
      let questionMappings;
      try { questionMappings = questionOwnership(task); }
      catch (e) { throw taskRejection("TASK_CONFLICT", `${e.message}; inspect the saved brief before answering`); }
      for (const [id, value] of answerEntries) {
        beforeTaskEffects(() => requireText(value, `answer ${id}`));
        // Legacy free-text contracts keep their saved answer grammar. Typed
        // tasks screen answer fragments against the profile after drafting.
        if (task.ownerDelivery) beforeTaskEffects(() => assertDeliveryAnswer(task, value));
        if (!task.questions.some(q => q.id === id)) throw taskRejection("TASK_INPUT", `unknown answer identifier ${id}`);
        if (task.answers[id] && task.answers[id] !== value) throw taskRejection("TASK_CONFLICT", `answer ${id} is already accepted`);
      }
      const requirements = beforeTaskEffects(() => requireTaskCapacity({ ...task, questionMappings, answers: { ...task.answers, ...answers }, requirements: [...task.requirements, ...Object.entries(answers).flatMap(([id, value]) => fragments(value, `a-${id}`))] }));
      const selectedFiles = beforeTaskEffects(() => context.length ? selectedContext(task.checkout, context, task.context, ctx.taskSecrets ?? null) : task.context);
      const explicit = beforeTaskEffects(() => [...new Set([...(task.explicitVerifyCommands || []), ...explicitCommands(verifyCommands)])]);
      const candidates = beforeTaskEffects(() => commandCandidates(selectedFiles, explicit));
      // Backfill only ownership proven by a saved unresolved mapping, never by
      // an older question's claimed requirement list alone.
      task.questionMappings = questionMappings;
      for (const [id, value] of answerEntries) {
        task.answers[id] = value;
      }
      task.requirements = requirements;
      task.context = selectedFiles;
      task.explicitVerifyCommands = explicit;
      task.commandCandidates = candidates;
      // Computed properties are own data keys, including __proto__, and survive
      // JSON persistence without invoking a plain object's prototype setter.
      task.operations = { ...task.operations, [operationId]: signature };
      task.questions = task.questions.filter(q => !task.answers[q.id]);
      task.status = task.questions.length ? "needs-input" : "preparing";
      task.readiness = null;
      // New material input: the owner reviews the next revision again. For typed
      // tasks that includes earlier `--run` consent, which covered the revision
      // the owner saw, not the one an answer will produce. Legacy tasks keep
      // their documented persisted authorization.
      task.approval = null;
      if (task.deliveryProfile) task.runAuthorized = false;
      mutate(task, store);
      return task.status === "preparing" ? prepareInternal(task, noDaemon) : result(task);
    }),
    resume: async ({ taskId, expectedRevision, noDaemon = false }) => store.locked(taskId, async () => {
      const task = store.read(taskId);
      expectRevision(task, expectedRevision);
      beforeTaskEffects(() => assertProfileUsable(task));
      const id=entryId(task.repo,task.id),entry=ctx.state.get(id);
      if (entry) {
        if (!implementationMatches(task, entry)) throw taskRejection("TASK_CONFLICT", "implementation ownership or completion target differs from the approved intake");
        const runner=executionRunner(ctx,id,task.harness);
        // Bind an already queued ambiguous Resume to observation recovery before
        // this explicit rearm can adopt its root. It must never become a new turn.
        const recoveredControl=await recoverControl(ctx,id),run=runner.current?.();
        if (recoveredControl || run?.execution?.providerState==="status-unknown" && runner.recover) {
          try {
            const observed=recoveredControl?run:await runner.recover({authorized:true,operationId:`task-resume:${task.id}:${expectedRevision}`});
            if(observed?.execution?.acceptance==="accepted"){task.failures=[];task.errorCode=null;}
          }
          catch(error) {return block(task,error);}
          // Consume this revision even if adoption below leaves the view stable.
          // A stale/replayed request cannot reset another retry circuit.
          mutate(task,store);
        }
      }
      return prepareInternal(task, noDaemon);
    }),
    validate: async ({ taskId, expectedRevision }) => store.locked(taskId, async () => {
      const task = store.read(taskId);
      expectRevision(task, expectedRevision);
      // The previous question-bearing draft can outlive an accepted final answer.
      // Leave its owned turn and revision intact for explicit preparation recovery.
      if (task.status === "preparing") throw taskRejection("TASK_NOT_READY", "resume preparation with the current revision before validating its draft");
      if (!task.draft) throw taskRejection("TASK_NOT_READY", "no generated draft to validate");
      if (task.status === "started") return result(task);
      beforeTaskEffects(() => assertProfileUsable(task));
      beforeTaskEffects(() => assertPreparationBoundary(task, ctx));
      return validateInternal(task);
    }),
    start: async ({ taskId, expectedRevision, run = false, noDaemon = false }) => store.locked(taskId, async () => {
      const task = store.read(taskId);
      expectRevision(task, expectedRevision);
      beforeTaskEffects(() => assertProfileUsable(task));
      if (task.status !== "started" && !ctx.state.get(entryId(task.repo, task.id))) beforeTaskEffects(() => assertPreparationBoundary(task, ctx));
      if (run === true && !task.runAuthorized) {
        if (task.questions.length || !task.readiness?.allow) throw taskRejection("TASK_NOT_READY", "resolve requirements and validate the current draft before authorizing start");
        const request = savedDraft(task);
        if (!validateDraft(task, request).ok) throw taskRejection("TASK_CONFLICT", "approved requirements changed; no start authorization was saved");
        // Explicit approval of exactly this reviewed revision.
        task.approval = { revision: task.revision, digest: reviewDigest(task), draftHash: task.draft.hash, readinessDigest: task.readiness.digest, at: new Date().toISOString() };
        task.runAuthorized = true; mutate(task, store);
      }
      return startInternal(task, noDaemon);
    }),
  };
  // Preserve synchronous inspect/list and asynchronous mutations while giving
  // every structured error the same version/code envelope the CLI renders.
  const normalizeError = e => { e.version ??= TASK_VERSION; e.code ??= "TASK_FAILED"; return e; };
  for (const key of ["prepare", "answer", "resume", "validate", "start", "inspect", "list"]) {
    const original = service[key];
    const operation = ["inspect", "list"].includes(key) ? original : async (...args) => {
      let owner;
      try { owner = acquireServiceMutation(ctx.home, mutationOwner); }
      catch (error) { error.code ??= "TASK_BUSY"; throw error; }
      try { return await original(...args); } finally { owner.release(); }
    };
    service[key] = (...args) => {
      try {
        const value = operation(...args);
        return value instanceof Promise ? value.catch(e => { throw normalizeError(e); }) : value;
      } catch (e) { throw normalizeError(e); }
    };
  }
  return service;
}
