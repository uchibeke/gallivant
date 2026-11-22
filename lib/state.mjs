import { chainRecoveryFences, validateRecoveryProfile } from "./recovery_authority.mjs";
import { consumePlanAdminIntent, consumeRecoveryAdminIntent, planOperator } from "./operator_intent.mjs";
import { admitGraphPlan, admitLegacyChain, applyPlanControl, applyPlanMigration, checkLegacyOwnership, checkPlanRegistry,
  compactPlanSources, findPlanControlReceipt, findPlanReceipt, operatorBinding, planInputPaths, planTaskOwner, reconcilePlanAnchors, settleCancelledPlanStarts } from "./dependency_plan_registry.mjs";
import { anchorGrants, matchesLegacyNode, matchesRegisteredPr } from "./dependency_plan_anchors.mjs";
import { DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION, PLAN_REGISTRY_VERSION, RECOVERY_REGISTRY_VERSION, matchesPlanFormat } from "./registry_versions.mjs";
import { checkDispatchState, liveAuthor, reserveAuthor, settledAuthor } from "./dispatch_capacity.mjs";
import { changePlanNode, dependencyIndex, dispatchablePlan, futureDisposition, planNodeHolds, planNodeRuntime, planPrerequisites } from "./dependency_plan_runtime.mjs";
import { matchesIntegration } from "./dependency_integration.mjs";
import { controlPending } from "./control_contract.mjs";
import { recoveryRecord } from "./recovery_observation.mjs";
import { repositoryIdentity, savedRepository } from "./repository.mjs";
// The registry: one entry per PRD or registered PR, keyed by `<owner>/<repo>/<prd id>`.
//
// The file is a cache with cursors. Identity (which PR, which session) can be rebuilt from GitHub; counters and
// cursors can be rebuilt by counting the daemon's own comments. Every write is atomic and every read-modify-write
// holds a lock file, so the CLI and the daemon cannot lose each other's updates.
import { join, basename, dirname } from "node:path";
import { openSync, closeSync, unlinkSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { exists, readJson, writeJsonAtomic, gallivantHome, syncDirectory, syncExistingFile } from "./fs.mjs";
import { reviewHistoryStore } from "./review_history.mjs";
import { later } from "./time.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertReviewPolicy } from "./review_policy.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { currentQualificationSource, rolloutTaskBinding } from "./recovery_eligibility.mjs";
import { contentDigest } from "./hash.mjs";
import { assertPlanRounds, planExecutionAllowance } from "./task_allowance.mjs";

export const STATES = Object.freeze({
  running: "running",           // start run in progress, no PR yet
  prOpen: "pr-open",            // watched
  ready: "ready-for-human",     // watched, waiting for a person to merge
  needsHuman: "needs-human",    // stopped with a reason
  done: "done",                 // merged or closed
});

export const statePath = (home = gallivantHome()) => join(home, "state.json");
export { RECOVERY_REGISTRY_VERSION };
export const supportedStateVersion = version => [1, 2, RECOVERY_REGISTRY_VERSION, PLAN_REGISTRY_VERSION, DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION].includes(version);

/**
 * The repository name without its owner, for a handle a person reads: `acme/widget` is `widget`. Anything that is
 * not `owner/name` degrades to what it was given rather than to `undefined`, and a missing repo to the empty string
 * rather than a throw. Both used to reach the operator: the ntfy title said `undefined#3` and told them to run
 * `gallivant why undefined#3`, and the throw happened inside `needsHuman` after the labels were written but before
 * the notification, where the tick's per-entry catch swallowed it and a stopped PR notified nobody at all.
 */
export const shortRepo = nameWithOwner => { const s = String(nameWithOwner ?? ""); return s.split("/").at(-1) || s; };

/** `<repo>#<pr>` when there is a PR, else the registry id. */
export const handleFor = (id, entry) => {
  if (!entry.pr) return id;
  let repo = shortRepo(entry.repo);
  try { const identity = repositoryIdentity(entry.repo); if (identity.host !== "github.com") repo = identity.remoteIdentity; } catch { /* Display opaque historical handles safely. */ }
  return `${repo}#${entry.pr}`;
};

/** Registry id: a pure function of the repository and the PRD, so every path keyed by it agrees. */
export const entryId = (nameWithOwner, prdId) => `${repositoryIdentity(nameWithOwner).key}/${prdId}`;

/** An existing predecessor is observed, never adopted into a chain's owned steps. */
export const matchesChainAnchor = matchesRegisteredPr;

/** The PRD id is the last segment of the registry id. */
export const prdIdOf = id => id.split("/").pop();

/** A filesystem-safe form of the id for run and snapshot folders. */
export const idSlug = id => id.split("/").length === 4 ? `host~${id.split("/").map(encodeURIComponent).join("~")}` : id.replaceAll("/", "__");

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;

// A live owner can hold the lock longer than the stale interval during the
// one-time migration of large histories. PID reuse may delay recovery, but it
// must never permit a second writer while the recorded owner is still alive.
function lockOwnerAlive(lock) {
  try {
    const { pid } = JSON.parse(readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  } catch { return false; } // historical empty lock files retain old recovery behavior
}

/** Hold an exclusive lock file for the duration of `fn`. Waits up to five seconds; recover stale dead-owner locks. */
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    let fd;
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS && !lockOwnerAlive(lock)) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error(`state is locked by another gallivant process (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); return fn(); }
    finally { closeSync(fd); try { unlinkSync(lock); } catch { /* gone */ } }
  }
}

export function makeState(home = gallivantHome()) {
  const file = statePath(home), pinPath = join(home, "runtime-pin.json");
  const historyStore = reviewHistoryStore(home);
  let cached = null;
  const signature = () => {
    try { const s = statSync(file, { bigint: true }); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
    catch { return null; }
  };
  const read = () => {
    const before = signature();
    if (before && cached?.signature === before) return cached.value;
    const s = readJson(file, { version: 1, entries: {} });
    if (!supportedStateVersion(s.version)) throw Object.assign(new Error(`unsupported registry version ${s.version}; stop the coordinator, back up ${home}, and install a compatible package or restore its matching backup; do not redispatch`), { code: "STATE_VERSION" });
    checkPlanRegistry(s);
    checkDispatchState(s);
    for (const e of Object.values(s.entries)) if (e.execution && e.execution.version !== 1) throw Object.assign(new Error("unsupported execution state version; restore a compatible package/backup before restarting"), { code: "EXECUTION_VERSION" });
    for (const e of Object.values(s.entries)) if (e.reviewPolicy) assertReviewPolicy(e.reviewPolicy);
    const identities = new Set();
    for (const [id, entry] of Object.entries(s.entries)) {
      if (!entry.repo) continue;
      const repository = savedRepository(entry);
      const expected = `${repository.key}/`;
      if (repository.host !== "github.com" && !id.toLowerCase().startsWith(expected)) throw new Error("Ambiguous saved entry ID; back up state and reconcile its qualified repository before restarting. Do not redispatch.");
      if (entry.pr) {
        const key = `${repository.remoteIdentity}#${entry.pr}`;
        if (identities.has(key)) throw new Error("Duplicate saved PR identity; back up state and reconcile its entries and cursors before restarting. Do not redispatch.");
        identities.add(key);
      }
    }
    for (const chain of Object.values(s.chains || {})) if (chain.repo) savedRepository(chain);
    const after = signature();
    cached = before && before === after ? { signature: after, value: s } : null;
    return s;
  };
  // Public reads and mutation callbacks receive detached values, as they did
  // when each read parsed a fresh file. Atomic replacement by another process
  // changes the signature and forces validation of the new registry.
  const load = () => structuredClone(read());
  const writeRegistry = (state, durable) => {
    // An older pinned artifact must never publish a reservation it cannot read on replay.
    if (state.version >= DISPATCH_REGISTRY_VERSION && exists(pinPath)) {
      const pin = readJson(pinPath);
      if (pin?.version !== 1 || !matchesPlanFormat(pin, state.version)) throw Object.assign(new Error("Run task-delivery-state migrate with the exact runtime.json that supports dispatch reservations before starting new work."), { code: "RUNTIME_STATE" });
    }
    const next = compactPlanSources(reconcilePlanAnchors(settleCancelledPlanStarts(state)));
    cached = null;
    writeJsonAtomic(file, next, 0o600, { durable: durable || Boolean(state.plans) });
    return next;
  };
  const save = (s, durable = false) => {
    // Archive before publishing references. Unchanged summaries do not read or
    // serialize full historical evidence, even across process restarts.
    let hasArchivedHistory = false;
    const entries = Object.fromEntries(Object.entries(s.entries).map(([id, entry]) => {
      if (!Array.isArray(entry.reviewHistory)) return [id, entry];
      const lastByKey = new Map(), reviewHistory = [];
      for (const item of entry.reviewHistory) {
        let archived;
        try { archived = historyStore.archive(item); }
        catch (error) {
          if (!["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EIO", "ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          // Preserve original evidence inline if the optional archive cannot
          // accept it. Registry and delivery checks still use their own proof.
          archived = item;
        }
        const marker = archived?._gallivantReviewArchive?.digest;
        if (marker) hasArchivedHistory = true;
        // Repeated persistence of the same key/version is redundant, but an
        // earlier identical version after an intervening disposition is not:
        // e.g. pending -> intent -> pending represents a proven unsent retry.
        if (marker && typeof archived.key === "string") {
          if (lastByKey.get(archived.key) === marker) continue;
          lastByKey.set(archived.key, marker);
        }
        reviewHistory.push(archived);
      }
      return [id, { ...entry, reviewHistory }];
    }));
    // Version 2 fences older processes that do not understand the compact
    // references. Never downgrade, even if the last archived entry is removed.
    return writeRegistry({ ...s, version: Math.max(s.version, hasArchivedHistory ? 2 : 1), entries }, durable);
  };
  const locked = fn => withLock(file, fn);
  const assertCanPut = (s, id) => {
    const owner = planTaskOwner(s, id);
    if (s.starts?.[id] || owner?.kind === "graph" || (!s.entries[id] && owner)) throw new Error(`${id} is reserved for a start, chain or plan`);
  };
  const dispatchEdit = () => {
    const s = read();
    return { ...s, starts: { ...s.starts }, entries: { ...s.entries },
      ...(s.dispatch ? { dispatch: { ...s.dispatch, authors: { ...s.dispatch.authors } } } : {}),
      ...(s.plans ? { plans: { ...s.plans, instances: s.plans.instances.map(plan => ({ ...plan })) } } : {}) };
  };
  const findPlan = (s, instanceId) => s.plans?.instances.find(plan => plan.id === instanceId);
  const graphAuthor = (s, id) => {
    const entry = s.entries[id], binding = entry?.plan;
    const plan = binding && findPlan(s, binding.instanceId);
    const node = plan?.approval.graph.nodes.find(node => node.id === binding.node && node.type === "task" && node.taskId === id);
    const task = node && plan.approval.bindings.tasks.find(([key]) => key === node.id)?.[1];
    const runtime = node && planNodeRuntime(plan, node.id);
    if (!task || runtime.approval !== binding.approval || !entry.start_token || runtime.token !== entry.start_token ||
        binding.contract && binding.contract !== plan.approval.nodeContracts.find(([id]) => id === node.id)?.[1])
      throw Object.assign(new Error("The author continuation no longer owns its approved plan."), { code: "PLAN_START_FENCE" });
    const limits = plan.approval.bindings.limits;
    return { limits, allowance: planExecutionAllowance(limits, task) };
  };
  const graphInputs = (s, graph, id, token = null) => {
    const plan = findPlan(s, graph.instanceId);
    const node = plan?.approval.graph.nodes.find(node => node.id === graph.node && node.type === "task" && node.taskId === id);
    const conflict = () => Object.assign(new Error("The graph start no longer owns its approved node or prerequisites."), { code: "PLAN_START_FENCE" });
    if (!node || !dispatchablePlan(plan) || futureDisposition(plan, node.id)) throw conflict();
    const runtime = planNodeRuntime(plan, node.id);
    if (token ? runtime.token !== token || runtime.approval !== (graph.admittedApproval ?? graph.approval)
      : plan.approval.approvalDigest !== graph.approval || runtime.generation !== graph.generation || runtime.token || runtime.status === "blocked") throw conflict();
    const operator = planOperator(file, graph.authority);
    if (!isDeepStrictEqual(operatorBinding(operator, plan.scope), plan.approval.bindings.operator)) throw conflict();
    const index = dependencyIndex(plan);
    const ancestors = new Set(index.incoming.get(node.id));
    for (const from of ancestors) {
      const anchor = index.anchors.get(from);
      if (anchor && anchorGrants(operator, plan.scope, anchor.producer.scope) !== anchor.authorization) throw conflict();
      for (const parent of index.incoming.get(from)) ancestors.add(parent);
    }
    const holds = planNodeHolds(s, plan, node), receipts = planPrerequisites(plan, node.id, index);
    if (holds.some(hold => hold.active) || !isDeepStrictEqual(holds, graph.holds) || !receipts || digest(receipts) !== graph.dependencies) throw conflict();
    // A receipt pins the original registered graph producer. A later change
    // to that entry cannot lend its status to the consumer's saved start.
    for (const receipt of receipts) {
      const producer = findPlan(s, receipt.owner.instanceId);
      if (!producer) continue; // The legacy anchor projector checks its original start/PR.
      const source = producer.approval.graph.nodes.find(item => item.id === receipt.owner.node);
      const entry = source && s.entries[source.taskId];
      const binding = producer.approval.bindings.repositories.find(([, repo]) => repo.key === source?.repository && repo.base === source?.base)?.[1];
      if (!binding || entry?.start_token !== receipt.owner.token ||
          !matchesIntegration(entry, binding, receipt)) throw conflict();
    }
    return { plan, node, runtime, holds, receipts };
  };
  function validateStartOwner(s, id, token, chain, graph, authorPhase) {
    const claim = s.starts?.[id], entry = s.entries[id], slot = s.dispatch?.authors?.[id];
    const pending = entry?.start_token === token && entry.initial_dispatch?.operationId === token;
    if (!(claim?.token === token && !entry) && !pending) throw new Error(`${id}: start claim changed before spawn`);
    if (authorPhase) {
      const preparing = authorPhase === "preparing";
      if (slot?.token !== token || slot.operation !== token || slot.preparing !== preparing ||
          pending && entry.initial_dispatch.status !== (preparing ? "unsubmitted" : "dispatching")) {
        throw Object.assign(new Error("The reserved author slot changed before dispatch."), { code: "PLAN_START_FENCE" });
      }
    }
    const owner = claim || slot;
    if (owner?.holds?.some(([scope, generation]) => {
      const hold = s.recovery?.holds?.[scope];
      return (hold?.generation ?? 0) !== generation || hold && hold.active !== false;
    })) throw Object.assign(new Error("A task or repository hold changed before dispatch."), { code: "PLAN_START_FENCE" });
    if (graph) graphInputs(s, graph, id, token);
    if (chain) {
      const c = s.chains?.[chain.name], holds = c && chainRecoveryFences(s.recovery, c, id);
      const generations = owner?.holdGenerations ?? chain.holdGenerations ?? [claim?.holdGeneration ?? 0];
      if (c?.status !== "active" || c.index !== chain.index || c.steps[chain.index]?.dispatch !== (claim?.dispatch ?? chain.dispatch) ||
          holds.some((hold, index) => hold && hold.active !== false || (hold?.generation ?? 0) !== (generations[index] ?? 0)))
        throw new Error(`chain ${chain.name} no longer authorizes this start`);
      if (c.after && (!c.after.merged || !matchesChainAnchor(c.after, s.entries[c.after.id]))) throw new Error("chain predecessor merge or identity is no longer approved");
      if (c.steps.slice(0, chain.index).some((step, index) => !step.merged ||
        !matchesLegacyNode(c, { step, index }, s.entries[step.id])))
        throw new Error("An earlier chain milestone no longer owns its registered integration.");
    }
  }

  const reserveGraphRetry = (s, id, graph, limits) => {
    const { plan, node, runtime } = graphInputs(s, graph, id, graph.retry);
    const entry = s.entries[id], claim = s.starts[id];
    const unsentClaim = claim?.token === runtime.token && claim.unsent && claim.clone?.proof;
    const unsentEntry = entry?.start_token === runtime.token && entry.initial_dispatch?.status === "unsubmitted" &&
      entry.initial_dispatch.clone && !entry.session && !entry.last?.run && !entry.pr &&
      entry.dispatch_stopped === "plan-start-unsubmitted" && !controlPending(entry.control);
    if (runtime.generation !== graph.generation || runtime.retry?.token !== graph.retry || !unsentClaim && !unsentEntry) {
      throw Object.assign(new Error("The original start no longer qualifies for retry."), { code: "PLAN_START_FENCE" });
    }
    const binding = claim?.plan ?? entry.plan;
    const slot = reserveAuthor(s, id, { repo: node.repository, plan: plan.id, graph: true,
      approved: plan.approval.bindings.limits, token: runtime.token, preparing: true, limits });
    slot.holds = [`task/${id}`, `repo/${node.repository}`].map(scope => [scope, s.recovery?.holds?.[scope]?.generation ?? 0]);
    if (claim) s.starts[id] = { ...claim, unsent: false, holds: slot.holds };
    else s.entries[id] = { ...entry, dispatch_stopped: null };
    changePlanNode(plan, node.id, { status: "starting", retry: null, reason: null, wait: null });
    writeRegistry(s, true);
    return { token: runtime.token, plan: binding, clone: claim?.clone?.proof ?? entry.initial_dispatch.clone };
  };
  return {
    file,
    load,
    // Only coordinator administration receives these methods. No worker-facing
    // config, prompt, comment or control body is deserialized into this API.
    putRecoveryProfile: (profile, expectedDigest, intent) => locked(() => {
      validateRecoveryProfile(profile);
      consumeRecoveryAdminIntent(intent, file, "profile", profile.digest, expectedDigest);
      const s = load(), admin = s.recovery ?? { version: 1, storeId: profile.storeId, profiles: [], holds: {} };
      const prior = admin.profiles.find(p => p.id === profile.id);
      if (admin.version !== 1 || admin.storeId !== profile.storeId || expectedDigest !== (prior?.digest ?? null) ||
          profile.revision !== (prior?.revision ?? 0) + 1 || prior && (profile.revocationGeneration <= prior.revocationGeneration ||
          profile.holdGeneration < prior.holdGeneration)) throw new Error("Recovery profile compare-and-set failed.");
      s.recovery = { ...admin, profiles: [...admin.profiles.filter(p => p.id !== profile.id), profile] };
      if (profile.qualification?.actions.some(action => action !== "verify-disposable-isolation")) s.version = Math.max(s.version, RECOVERY_REGISTRY_VERSION);
      save(s, true);
      return profile.digest;
    }),
    setRecoveryHold: (scope, action, expectedGeneration, intent) => locked(() => {
      consumeRecoveryAdminIntent(intent, file, action, scope, expectedGeneration);
      const s = load(), admin = s.recovery;
      const [type] = scope.split("/");
      if (admin?.version !== 1 || !/^(?:task|repo|profile|chain)\/[a-zA-Z0-9][\w./~-]{0,255}$/.test(scope) ||
          !(type === "repo" || type === "profile" ? ["disable", "enable"] : ["hold", "resume"]).includes(action)) {
        throw new Error("Invalid scoped recovery control.");
      }
      const previous = admin.holds[scope], active = action === "hold" || action === "disable";
      if (!Number.isSafeInteger(expectedGeneration) || !Number.isSafeInteger(expectedGeneration + 1)) throw new Error("Invalid hold generation.");
      if ((previous?.generation ?? 0) !== expectedGeneration || (previous?.active ?? false) === active) throw new Error("Recovery hold generation or disposition changed.");
      const next = { active, generation: expectedGeneration + 1, provenance: "operator", action };
      admin.holds[scope] = next;
      s.version = Math.max(s.version, RECOVERY_REGISTRY_VERSION);
      writeRegistry(s, true);
      return next;
    }),
    commitRecoveryCanary: (record, expectedGeneration, intent) => locked(() => {
      consumeRecoveryAdminIntent(intent, file, "canary", digest(record), expectedGeneration);
      const s = load(), admin = s.recovery;
      const profile = admin?.profiles.find(item => item.digest === record.profile);
      const previous = profile && admin.canaries?.[profile.id];
      const priorStage = previous?.profile === record.profile ? previous.stage : null;
      if (!profile || (previous?.generation ?? 0) !== expectedGeneration || record.generation !== expectedGeneration + 1 ||
          record.version !== 1 || !["observe", "operational", "semantic"].includes(record.stage) ||
          record.stage === "operational" && !["observe", "operational", "semantic"].includes(priorStage) ||
          record.stage === "semantic" && (!["operational", "semantic"].includes(priorStage) ||
            previous.evidence !== record.evidence || digest(previous.tasks) !== digest(record.tasks)) ||
          record.stage !== "observe" && (profile.mode !== "recover" || admin.holds[`profile/${profile.id}`]?.active ||
            !currentQualificationSource(s, record.source)) ||
          Object.entries(record.tasks).some(([id, binding]) => s.entries[id]?.recovery_profile?.digest !== record.profile ||
            rolloutTaskBinding(id, s.entries[id]) !== binding))
        throw new Error("Canary task bindings, stage, profile or approval generation changed.");
      s.recovery = { ...admin, canaries: { ...admin.canaries, [profile.id]: record } };
      s.version = Math.max(s.version, RECOVERY_REGISTRY_VERSION);
      writeRegistry(s, true);
      return record;
    }),
    adoptRecoveryBatch: (proposalDigest, registryDigest, prepare, intent) => locked(() => {
      consumeRecoveryAdminIntent(intent, file, "adopt", proposalDigest, registryDigest);
      const s = load();
      if (digest(s) !== registryDigest) throw new Error("Registry changed. Review a fresh adoption inventory.");
      const { records, backup } = prepare();
      if (digest(load()) !== registryDigest || !records.length) throw new Error("Adoption bindings changed before registry replacement.");
      for (const record of records) {
        const entry = s.entries[record.id];
        if (!entry || entry.recovery_profile || digest(entry) !== record.task ||
            !s.recovery.profiles.some(profile => profile.digest === record.profile && profile.mode === "recover"))
          throw new Error("The reviewed task or profile changed before adoption.");
        s.entries[record.id] = { ...entry, recovery_profile: { version: 1, digest: record.profile } };
      }
      s.version = Math.max(s.version, RECOVERY_REGISTRY_VERSION);
      const next = writeRegistry(s, true);
      return { adopted: records.map(record => record.id), registryVersion: next.version, backup };
    }),
    registryStamp: signature,
    workspaceRecords: () => {
      const { entries, chains, plans, starts, recovery, dispatch } = read();
      return structuredClone({ entries, chains, plans: { instances: plans?.instances ?? [] }, starts, recovery, dispatch });
    },
    recoverySettings: () => structuredClone(read().recovery),
    resyncCleanup: (id, removal) => {
      if (!isDeepStrictEqual(read().entries[id]?.workspace_cleanup?.removal, removal)) return false;
      syncExistingFile(file);
      return isDeepStrictEqual(read().entries[id]?.workspace_cleanup?.removal, removal);
    },
    entries: (select = null) => {
      const entries = Object.entries(read().entries);
      return (select ? entries.filter(select) : entries).map(([id, entry]) => [id, structuredClone(entry)]);
    },
    get: id => { const entry = read().entries[id]; return entry ? structuredClone(entry) : null; },
    reviewHistory: id => (read().entries[id]?.reviewHistory || []).map(item => structuredClone(historyStore.hydrate(item))),
    reviewHistoryRecord: (id, key) => { const item = read().entries[id]?.reviewHistory?.findLast(record => record.key === key); return item ? structuredClone(historyStore.hydrate(item)) : null; },
    /** The entry that watches this PR, if any. */
    findByPr: (repo, pr) => { const found = Object.entries(read().entries).find(([, e]) => savedRepository(e).remoteIdentity === repositoryIdentity(repo).remoteIdentity && e.pr === pr); return found ? structuredClone(found) : null; },
    put: (id, entry) => locked(() => {
      const s = load();
      assertCanPut(s, id);
      const previous = s.entries[id];
      if (previous?.base_repair?.journal && previous.base_repair.status !== "verified" &&
          !isDeepStrictEqual(previous.base_repair, entry.base_repair)) throw new Error("Reconcile the saved repair journal before replacing this task.");
      const next = { ...entry, recovery_record: recoveryRecord(id, entry, previous) };
      if (isDeepStrictEqual(previous, next)) return structuredClone(next);
      s.entries[id] = next;
      return structuredClone(save(s).entries[id]);
    }),
    update: (id, patch, observation) => locked(() => {
      // Only the selected entry is exposed to a mutation callback. Cloning the
      // entire registry here makes every small update copy unrelated review
      // histories, which can be hundreds of megabytes. Keep the cached root
      // untouched and detach the selected entry before invoking user code.
      const original = read(), entry = original.entries[id];
      if (!entry) throw new Error(`no entry ${id}`);
      const current = structuredClone(entry);
      const updated = { ...current, ...(typeof patch === "function" ? patch(current) : patch) };
      // Compare under the lock against freshly observed state, not a caller's
      // cache. A no-op neither rewrites the registry nor migrates its format.
      if (isDeepStrictEqual(entry, updated)) {
        if (observation?.durable && observation.resync) syncDirectory(dirname(file));
        return updated;
      }
      updated.recovery_record = recoveryRecord(id, updated, entry, observation);
      const next = settledAuthor({ ...original, entries: { ...original.entries, [id]: updated } }, id, updated);
      return structuredClone(save(next, observation?.durable === true).entries[id]);
    }),
    remove: id => locked(() => {
      const s = load();
      const owner = planTaskOwner(s, id);
      if (owner?.kind === "legacy") throw new Error(`${id} belongs to chain ${owner.name}; cancel the chain before forgetting its run`);
      if (owner) throw new Error(`${id} is reserved by a dependency plan`);
      if (!Object.hasOwn(s.entries, id)) return;
      if (s.dispatch?.authors?.[id]) throw new Error("Reconcile the owned author execution before removing this task.");
      if (s.entries[id].base_repair?.journal && s.entries[id].base_repair.status !== "verified")
        throw new Error("Reconcile the saved repair journal before removing this task.");
      delete s.entries[id]; save(s);
    }),
    chains: (select = null) => {
      const chains = Object.entries(read().chains || {});
      return (select ? chains.filter(select) : chains).map(([name, chain]) => [name, structuredClone(chain)]);
    },
    isChainPredecessor: id => Object.values(read().chains ?? {}).some(chain => chain.status === "active" && chain.after?.id === id),
    getChain: name => { const chains = read().chains ?? {}; return Object.hasOwn(chains, name) ? structuredClone(chains[name]) : null; },
    createChain: chain => locked(() => {
      const s = load();
      if (chain.after && !matchesChainAnchor(chain.after, s.entries[chain.after.id])) throw new Error("chain predecessor identity changed while queueing");
      admitLegacyChain(s, chain);
      save(s); return chain;
    }),
    updateChain: (name, patch) => locked(() => {
      const s = load(), cur = s.chains?.[name];
      if (!cur || !Object.hasOwn(s.chains, name)) throw new Error(`no chain ${name}`);
      const before = structuredClone(cur);
      const after = { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) };
      if (isDeepStrictEqual(before, after)) return after;
      if (after.name !== before.name || after.created_at !== before.created_at || after.plan_instance !== before.plan_instance) {
        throw new Error("The chain instance cannot change.");
      }
      checkLegacyOwnership(s, before, after);
      s.chains[name] = after;
      save(s); return after;
    }),
    reconcilePlanAdmission: (authority, requestId, expected) => locked(() => {
      const receipt = findPlanReceipt(read(), planOperator(file, authority), requestId, expected);
      if (receipt) syncDirectory(dirname(file));
      return receipt;
    }),
    admitPlan: (proposal, snapshots, requestId, intent, root, assertLocal) => locked(() => {
      const expected = proposal.approvalDigest;
      const operator = consumePlanAdminIntent(file, intent, "queue", requestId, expected);
      const s = load();
      const previous = s.plans?.instances.length || 0;
      const receipt = admitGraphPlan(s, operator, proposal, snapshots, requestId, root, assertLocal);
      if (s.plans.instances.length > previous) writeRegistry(s, true);
      else syncDirectory(dirname(file));
      return receipt;
    }),
    reconcilePlanControl: (authority, command) => locked(() => {
      const receipt = findPlanControlReceipt(read(), planOperator(file, authority), command);
      if (receipt) syncDirectory(dirname(file));
      return receipt;
    }),
    controlPlan: (command, prepared, intent) => locked(() => {
      const operator = consumePlanAdminIntent(file, intent, command.action, command.requestId, command.approve);
      const s = load(), { result, replay } = applyPlanControl(s, operator, command, prepared);
      if (replay) syncDirectory(dirname(file));
      else writeRegistry(s, true);
      return result;
    }),
    migratePlans: (expected, intent) => locked(() => {
      const operator = consumePlanAdminIntent(file, intent, "migrate", null, expected);
      const s = load(), before = s.plans?.migration;
      const receipt = applyPlanMigration(s, operator, expected);
      if (receipt !== before) writeRegistry(s, true);
      else syncDirectory(dirname(file));
      return receipt;
    }),
    graphPlans: () => structuredClone((read().plans?.instances ?? []).filter(plan => dispatchablePlan(plan) || plan.runtime.nodes)),
    planCheckoutReferences: () => [...planInputPaths(read())],
    graphPlan: id => { const plan = findPlan(read(), id); return plan ? structuredClone(plan) : null; },
    graphAuthorAllowance: id => graphAuthor(read(), id).allowance,
    approvedPlanBlob: hash => {
      const blob = read().plans?.blobs[hash];
      return typeof blob === "string" ? Buffer.from(blob, "base64") : null;
    },
    graphHolds: (plan, node) => planNodeHolds(read(), plan, node),
    updateGraphNode: (instanceId, node, generation, patch, proof) => locked(() => {
      const s = dispatchEdit(), plan = findPlan(s, instanceId);
      const runtime = plan && planNodeRuntime(plan, node);
      if (!plan?.approval.bindings.tasks.some(([id]) => id === node) || runtime.generation !== generation || runtime.status === "integrated" ||
          !runtime.token && (!dispatchablePlan(plan) || futureDisposition(plan, node))) return false;
      if (Object.keys(patch).some(key => !["status", "reason", "nextAt", "receipt", "observedAt", "wait"].includes(key)) ||
          patch.wait != null && !["capacity", "resources"].includes(patch.wait) ||
          (patch.receipt || patch.status === "integrated") && !proof)
        throw new Error("A node transition must retain its owner and qualified integration evidence.");
      if (proof) {
        const entry = s.entries[proof.id];
        const owner = proof.receipt.owner;
        if (owner.instanceId !== instanceId || owner.node !== node || owner.token !== runtime.token || entry?.start_token !== owner.token ||
            owner.contract !== plan.approval.nodeContracts.find(([id]) => id === node)?.[1] ||
            !matchesIntegration(entry, proof.binding, proof.receipt)) return false;
      }
      if (!changePlanNode(plan, node, patch)) return false;
      writeRegistry(s, true);
      return true;
    }),
    startClaim: id => { const claim = read().starts?.[id]; return claim ? structuredClone(claim) : null; },
    assertCanRegister: id => assertCanPut(read(), id),
    // This lock covers CLI starts and chain dispatches. Never hold it across a probe, clone or spawn.
    claimStart: (id, chain = null, task = null, admission = null) => locked(() => {
      const s = dispatchEdit(), reserved = planTaskOwner(s, id), graph = admission?.graph;
      if (graph?.retry) return reserveGraphRetry(s, id, graph, admission.limits);
      if (s.entries[id] || s.starts?.[id]) throw new Error(`${id} already exists or has an unresolved start; inspect it before retrying`);
      if (reserved?.kind === "graph" && !graph) throw new Error(`${id} is reserved by a dependency plan; graph dispatch is disabled for direct starts`);
      const input = graph ? graphInputs(s, graph, id) : null;
      let holdGenerations, legacy;
      if (chain) {
        const c = s.chains?.[chain.name], step = c?.steps[chain.index];
        const holds = c ? chainRecoveryFences(s.recovery, c, id) : [];
        holdGenerations = holds.map(hold => hold?.generation ?? 0);
        legacy = c;
        const dispatchable = step?.dispatch === chain.dispatch || (admission && !step?.dispatch &&
          step?.digest === chain.digest && chain.revision === contentDigest(JSON.stringify(c)));
        if (c?.status !== "active" || holds.some(hold => hold && hold.active !== false) ||
            chain.holdGenerations && !isDeepStrictEqual(chain.holdGenerations, holdGenerations) ||
            c.index !== chain.index || step?.id !== id || !dispatchable) throw Object.assign(new Error(`chain ${chain.name} no longer authorizes this start`), { code: "PLAN_START_FENCE" });
        if (c.after && (!c.after.merged || !matchesChainAnchor(c.after, s.entries[c.after.id]))) throw new Error("chain predecessor merge or identity is no longer approved");
      } else if (reserved && !input) throw new Error(`${id} is reserved by chain ${reserved.name}`);
      const token = randomUUID(), repo = admission?.repo;
      const holds = repo ? [`task/${id}`, `repo/${repo}`].map(scope => [scope, s.recovery?.holds?.[scope]?.generation ?? 0]) : null;
      if (holds?.some(([scope]) => s.recovery?.holds?.[scope]?.active)) throw new Error("A task or repository hold prevents dispatch.");
      const plan = input ? { instanceId: input.plan.id, node: input.node.id, approval: graph.approval,
        contract: input.plan.approval.nodeContracts.find(([id]) => id === input.node.id)[1],
        control: input.plan.control.generation, dependencies: graph.dependencies } : null;
      if (admission) {
        const slot = reserveAuthor(s, id, { repo, plan: plan?.instanceId ?? chain?.name ?? null, graph: Boolean(input),
          approved: input?.plan.approval.bindings.limits, token, preparing: true, limits: admission.limits });
        Object.assign(slot, { holds, holdGenerations, ...(chain ? { dispatch: chain.dispatch } : {}) });
      }
      if (input) changePlanNode(input.plan, input.node.id, { status: "starting", token, reason: null, nextAt: null, wait: null, ...plan, holds: input.holds });
      const installedChainDispatch = Boolean(legacy && !legacy.steps[chain.index].dispatch);
      if (installedChainDispatch) {
        const steps = [...legacy.steps];
        steps[chain.index] = { ...steps[chain.index], dispatch: chain.dispatch };
        s.chains = { ...s.chains, [chain.name]: { ...legacy, steps, updated_at: new Date().toISOString() } };
      }
      const claim = { token, chain: chain?.name || null, ...(repo ? { repo, holds } : {}), ...(plan ? { plan } : {}),
        ...(chain ? { dispatch: chain.dispatch, installedChainDispatch } : {}),
        ...(holdGenerations ? { holdGeneration: holdGenerations[0], ...(s.version >= RECOVERY_REGISTRY_VERSION ? { holdGenerations } : {}) } : {}),
        ...(task ? { task } : {}), at: new Date().toISOString() };
      s.starts[id] = claim; writeRegistry(s, Boolean(admission)); return claim;
    }),
    releaseStart: (id, token) => locked(() => {
      const s = dispatchEdit(), claim = s.starts[id], slot = s.dispatch?.authors[id];
      if (claim?.token !== token) return;
      if (claim.plan) changePlanNode(findPlan(s, claim.plan.instanceId), claim.plan.node, { status: "queued", token: null });
      const chain = claim.chain && s.chains?.[claim.chain], step = chain?.steps[chain.index];
      // Earlier capacity-aware chain starts installed the step dispatch together with this slot.
      const installed = claim.installedChainDispatch ?? (slot?.token === token && slot.preparing && slot.dispatch === claim.dispatch);
      if (installed && step?.id === id && step.dispatch === claim.dispatch) {
        const steps = [...chain.steps];
        steps[chain.index] = { ...step, dispatch: null };
        s.chains = { ...s.chains, [claim.chain]: { ...chain, steps } };
      }
      delete s.starts[id];
      if (slot?.token === token) delete s.dispatch.authors[id];
      writeRegistry(s, Boolean(s.dispatch));
    }),
    markStartClone: (id, token, clone) => locked(() => {
      const s = dispatchEdit();
      if (s.starts?.[id]?.token !== token || s.entries[id]) throw new Error(`${id}: start claim changed before clone`);
      s.starts[id] = { ...s.starts[id], clone: { ...clone, at: new Date().toISOString() } };
      writeRegistry(s, Boolean(s.dispatch));
    }),
    validateStart: (id, token, chain = null, graph = null, authorPhase = null) =>
      locked(() => validateStartOwner(read(), id, token, chain, graph, authorPhase)),
    markStartDispatch: (id, token, chain, graph, requiresCessation = false) => locked(() => {
      const s = dispatchEdit(), slot = s.dispatch?.authors[id], entry = s.entries[id];
      validateStartOwner(s, id, token, chain, graph, "preparing");
      s.dispatch.authors[id] = { ...slot, preparing: false, requiresCessation };
      if (entry) s.entries[id] = { ...entry, initial_dispatch: { ...entry.initial_dispatch, status: "dispatching" },
        execution: { version: 1, operationId: token }, reason: "dispatch-intent" };
      writeRegistry(s, true);
    }),
    finishUnsentStart: (id, token) => locked(() => {
      const s = dispatchEdit(), claim = s.starts[id], slot = s.dispatch?.authors[id];
      if (slot?.token !== token) return;
      const entry = s.entries[id], initial = entry?.initial_dispatch, plan = claim?.plan ?? entry?.plan;
      if (claim?.token === token) s.starts[id] = { ...claim, unsent: true };
      else if (entry?.start_token === slot.operation && initial?.operationId === slot.operation) {
        // Preparation already has its own actionable reason. Rearm only an actual dispatch intent.
        const refusal = initial.status === "dispatching" ? { initial_dispatch: { ...initial, status: "unsubmitted" },
          execution: entry.execution?.version === 1 ? { version: 1, operationId: slot.operation } : null,
          ...(entry.reason === "dispatch-intent" ? { reason: "dispatch-refused" } : {}) } : {};
        s.entries[id] = { ...entry, ...refusal, ...(plan && !entry.dispatch_stopped ? { dispatch_stopped: "plan-start-unsubmitted" } : {}) };
      } else return;
      if (plan) changePlanNode(findPlan(s, plan.instanceId), plan.node, { status: "blocked", retry: null,
        reason: "Initial dispatch was refused. Inspect the retained start and checkout." });
      delete s.dispatch.authors[id];
      writeRegistry(s, true);
      return true;
    }),
    reserveAuthorTurn: (id, previousRun, operation, limits, { requiresCessation = false, settled = null } = {}) => locked(() => {
      const s = dispatchEdit(), entry = s.entries[id];
      if (!entry || (entry.last?.run ?? null) !== previousRun) throw new Error("The author execution changed before reservation.");
      const exactSettlement = settled && settled.run === previousRun &&
        (!entry.execution?.runId || entry.execution.runId === previousRun) &&
        (!entry.execution?.operationId || entry.execution.operationId === settled.operation);
      const unassigned = !previousRun && !entry.execution?.runId && entry.initial_dispatch?.status !== "dispatching";
      if (liveAuthor(entry) && !unassigned && !exactSettlement)
        throw Object.assign(new Error("The previous author still needs settling before dispatch."), { code: "BUSY" });
      const prior = s.dispatch?.authors[id];
      if (prior && exactSettlement && !prior.preparing &&
          (settled.operation ? prior.operation === settled.operation : prior.previousRun !== previousRun)) delete s.dispatch.authors[id];
      const approved = entry.plan && graphAuthor(s, id);
      assertPlanRounds(entry, approved?.allowance);
      const slot = reserveAuthor(s, id, { repo: entry.repo, plan: entry.plan?.instanceId ?? entry.chain?.name ?? null,
        graph: Boolean(entry.plan), approved: approved?.limits, operation, previousRun, limits, requiresCessation });
      writeRegistry(s, true);
      return slot.token;
    }),
    releaseAuthorTurn: (id, token) => locked(() => {
      const s = dispatchEdit();
      if (s.dispatch?.authors[id]?.token !== token) return;
      delete s.dispatch.authors[id];
      writeRegistry(s, true);
    }),
    authorReservations: () => new Set(Object.entries(read().dispatch?.authors ?? {})
      .filter(([, slot]) => slot.requiresCessation && !slot.preparing).map(([id]) => id)),
    hasAuthorReservation: id => Boolean(read().dispatch?.authors[id]),
    savedAuthorReservations: () => Object.entries(read().dispatch?.authors ?? {}).map(([id, slot]) => [id, structuredClone(slot)]),
    settleAuthorReservation: (id, run, operation) => locked(() => {
      const s = read(), entry = s.entries[id], slot = s.dispatch?.authors[id];
      if (!entry || !slot || slot.preparing || entry.initial_dispatch || entry.last?.run !== run ||
          (operation ? slot.operation !== operation : run === slot.previousRun)) return;
      const settled = { ...entry, author_settlement: { run, operation: slot.operation } };
      const next = settledAuthor({ ...s, entries: { ...s.entries, [id]: settled } }, id, settled, true);
      if (!next.dispatch.authors[id]) writeRegistry(next, true);
    }),
    putStarted: (id, entry, token) => locked(() => {
      const s = dispatchEdit();
      if (s.starts?.[id]?.token !== token || s.entries[id]) throw new Error(`${id}: start claim changed; inspect the spawned run`);
      s.entries[id] = { ...entry, recovery_record: recoveryRecord(id, entry), start_token: token };
      delete s.starts[id];
      writeRegistry(s, Boolean(s.dispatch)); return s.entries[id];
    }),
    // Progress polling must not clone the full captured source and review history.
    reviewActivityEntry: id => {
      const entry = read().entries[id]; if (!entry) return null;
      const p = entry.reviewPolicy, r = entry.firstPartyReview;
      return { reviewPolicy: p ? { version: p.version, mode: p.mode } : null,
        reviewBinding: entry.reviewBinding, reviewHead: entry.reviewHead, cursor: { fixed_sha: entry.cursor?.fixed_sha },
        firstPartyReview: r ? { binding: r.binding, status: r.status, phase: r.phase, error: r.error,
          pieces: (Array.isArray(r.pieces) ? r.pieces : []).map(piece => ({ status: piece?.status })),
          result: r.result ? { verdict: r.result.verdict, findingsCount: Array.isArray(r.result.findings) ? r.result.findings.length : 0 } : null,
          disposition: r.disposition ? { status: r.disposition.status } : null } : null };
    },
  };
}

/**
 * Resolve what the operator typed to a registry id. Accepts the id itself, a PRD path, or `repo#pr` where repo is
 * the short name or owner/name. Bare PR numbers are refused because they are ambiguous across repos.
 */
export function resolveHandle(entries, handle) {
  if (!handle) throw new Error("handle required: <owner>/<repo>/<prd id>, <prd path>, or <repo>#<pr>");
  if (/^\d+$/.test(handle)) throw new Error(`"${handle}" is ambiguous across repos; use <repo>#${handle}`);
  const direct = entries.find(([id]) => id === handle.toLowerCase() || id === handle);
  if (direct) return direct[0];
  const m = handle.match(/^([\w.-]+(?:\/[\w.-]+){0,2})#(\d+)$/);
  if (m) {
    const [, repo, n] = m;
    const key = repo.toLowerCase();
    const hits = entries.filter(([, e]) => e.pr === Number(n) && (e.repo === key || savedRepository(e).remoteIdentity === key || shortRepo(e.repo) === key || savedRepository(e).path === key));
    if (hits.length > 1) throw new Error(`Ambiguous handle; use a qualified host/owner/repository#${n}: ${hits.map(([, e]) => `${savedRepository(e).remoteIdentity}#${n}`).join(", ")}`);
    if (hits.length === 1) return hits[0][0];
    throw new Error(`no entry for ${handle}`);
  }
  const prdId = basename(handle).replace(/\.md$/, "");
  const byPrd = entries.filter(([id]) => id.endsWith(`/${prdId}`));
  if (byPrd.length === 1) return byPrd[0][0];
  if (byPrd.length > 1) throw new Error(`"${handle}" matches ${byPrd.map(([id]) => id).join(", ")}; use the full id`);
  throw new Error(`no entry for ${handle}`);
}

/**
 * The event cursor, in one place, so every writer obeys the same rule.
 *
 * `since` is the boundary and `dispatched` the keys already handled *at* that boundary. GitHub timestamps have
 * one-second precision, so the comparison in `deriveEvents` is inclusive of `since` and `dispatched` is the only
 * thing that keeps an event from being sent twice. The two therefore move together: any move to a different
 * instant clears the list, and a move that stays inside the same second keeps it and adds to it. Everything else
 * about the cursor (`fixed_sha`, `checks_sha`, `receipt_hash`) is carried through untouched.
 *
 * The cursor never goes backwards, and that is enforced here rather than asked of each caller. Three callers pass a
 * candidate boundary from a different source: the newest event dispatched, the head commit's committer date, and a
 * local clock reading. Only the first was guarded. A committer date older than the cursor (a force-push to an
 * earlier commit, a push of a commit made days ago) or a clock a second behind GitHub's would move `since` back,
 * and `advanceCursor` would then clear `dispatched` because the instant changed, so the event that started the
 * round became new again and was dispatched a second time in the same pass, with a round burned for it. A candidate
 * before the cursor leaves both fields alone: nothing new was read, so nothing is newly handled.
 */
export function advanceCursor(cursor = {}, candidate, keys = []) {
  const since = later(candidate, cursor.since);
  // A candidate strictly before the cursor is refused outright: the boundary does not move and the keys are not
  // recorded either, because nothing was newly read to record. Only a candidate at the cursor's own instant unions
  // into `dispatched`; one past it replaces the list, since a different second has nothing to remember.
  if (candidate && cursor.since && Date.parse(candidate) < Date.parse(cursor.since)) return { ...cursor, since };
  const same = cursor.since && since && Date.parse(cursor.since) === Date.parse(since);
  const dispatched = same ? [...new Set([...(cursor.dispatched || []), ...keys])] : [...new Set(keys)];
  return { ...cursor, since, dispatched };
}

/**
 * A fresh entry, so every field exists and `status` never has to guess.
 * cursor.since: events at or after this time are new. cursor.dispatched: the event keys already dispatched at
 * exactly `since`, which is what makes the inclusive comparison safe. cursor.fixed_sha: the head the loop last acted
 * on, so a change in it is a push nobody told the loop about. It is the head when the last run started, which is how
 * a run that pushed is recognised, and the head an entry was judged ready on, which is how a push after that is.
 * cursor.checks_sha: the head whose failing checks were already dispatched. cursor.receipt_hash: the completion
 * receipt when the last run started. last.run: the run this entry dispatched; the tick settles that run and no other.
 * retry: `{ op, count }` while one GitHub write the tick declines a step for keeps failing, null otherwise. It is the
 * bound on those waits: `tick.mjs` stops the entry with `stuck` once one operation has failed enough ticks in a row,
 * and clears the field the moment the write lands, so an entry that recovers is never stopped for the ticks it lost.
 */
export function newEntry({ prd, harness, session = null, repo, branch, worktree, pr = null, url = null, state, nowIso, checkout = null, prdFingerprint = null, prdDecision = null, base = null, sources = [] }) {
  return {
    prd, harness, session, repo: repositoryIdentity(repo).key, host: repositoryIdentity(repo).host, branch, worktree, pr, url, state,
    // The branch this pull request targets, recorded because it is what the daemon merges in before every fix round
    // and what `status` and `why` print so an operator can see what a PR will target before it is opened. Null on an
    // entry that never learned one, which is every entry `register` and `reconcile` build before they read the PR's own
    // `baseRefName`; null means "ask the PR", never "assume the default branch".
    base,
    // Where the OPERATOR's copy of the brief lives, and what the snapshot's contract looked like when it was taken.
    // `checkout` is what makes the comparison possible at all: `join(checkout, prd)` is the file to compare the snapshot
    // against, and `entry.prd` is relative, so without this half there is nothing to join it to. Null on an entry that
    // never saw the operator's tree, which is every entry `register` and `reconcile` build, and null is what makes the
    // comparison answer "unknown" rather than stopping a recovered PR for a tree it was never told about.
    //
    // `prd_fingerprint` and `prd_decision` are the contract and the readiness decision the snapshot carries, recorded at
    // the same moment as the snapshot itself. They are a record rather than an input: the comparison recomputes both
    // fingerprints from the two files, because the snapshot on disk is the thing the gate actually reads and a stored
    // fingerprint that disagreed with it would be worse than no fingerprint at all. What they are for is telling an
    // operator what moved: `why` compares `prd_decision` with the brief's current `aport_decision` to say whether the edit
    // went through `gallivant ready`.
    checkout, prd_fingerprint: prdFingerprint, prd_decision: prdDecision,
    // The files this brief carries, recorded so the daemon can compare them without re-reading the brief. Empty on
    // every entry `register` and `reconcile` build, which is correct: a PR adopted from GitHub carries nothing, because
    // nothing was carried into it.
    sources,
    iteration: 0,
    cursor: { since: nowIso, dispatched: [], fixed_sha: null, checks_sha: null, receipt_hash: null },
    rereview: { at: null, nudged: false },
    reason: null,
    retry: null,
    last: null,
    created_at: nowIso,
    updated_at: nowIso,
  };
}
