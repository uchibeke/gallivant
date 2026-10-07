import { join, isAbsolute } from "node:path";
import { readJson, writeJsonAtomic, ensureDir } from "./fs.mjs";
import { acquireDaemon } from "./daemon.mjs";
import { makeTick } from "./tick.mjs";
import { createCoordinator } from "./coordinator.mjs";
import { assertCompatible, CORE_VERSION, deliveryError } from "./task_delivery_contract.mjs";
import { checkRuntimeState } from "./runtime_state.mjs";

export const NODE_RUNTIME_REQUIREMENTS = Object.freeze({ runtime: "node>=22", store: "durable single-host volume", replicas: 1,
  dependencies: ["git", "gh", "isolated verification sandbox", "configured provider transports"],
  pagesRemedy: "Keep Pages for OAuth/MCP/UI. Route authorized operations through an authenticated binding to one Node 22 coordinator with Git/gh, durable volume and external wake-up scheduling. Codex Cloud additionally needs the pinned CLI and its trusted operator account; environment repository verification remains blocked. Evaluate an existing Node-capable runtime or Cloudflare Container before provisioning; do not add a mandatory Worker." });

export function createNodeOwnerStore({ home, durable = false, replicas = 1 }) {
  if (!isAbsolute(home || "") || !durable || replicas !== 1) throw deliveryError("COORDINATOR_STORE", "Configure an absolute durable volume and exactly one single-host replica; filesystem locks are not distributed leases");
  ensureDir(home);
  return { withOwner: async fn => {
    const lock = acquireDaemon(home), file = join(home, "coordinator.json");
    try {
      const previous = readJson(file, { fence: 0, version: 1 });
      if (previous.version !== 1) throw deliveryError("COORDINATOR_VERSION", "Stop wake-ups and restore the matching coordinator package/state backup");
      const fence = previous.fence + 1, instance = lock.owner.instance;
      writeJsonAtomic(file, { ...previous, version: 1, fence, instance });
      const owner = { fence, processIdentity: `${lock.owner.pid}:${lock.owner.identity}`, assertCurrent: () => {
        const current = readJson(file), locked = readJson(join(home, "daemon.lock"));
        if (current?.fence !== fence || current.instance !== instance || locked?.instance !== instance) throw deliveryError("COORDINATOR_FENCE", "Coordinator ownership changed; stale effects are forbidden");
      }, checkpoint: () => readJson(file), saveCheckpoint: patch => {
        owner.assertCurrent(); writeJsonAtomic(file, { ...readJson(file), ...patch, version: 1, fence, instance });
      } };
      return await fn(owner);
    } finally { lock.release(); }
  } };
}

// Fence each I/O boundary, including continuations after an await. Store adapters
// used across machines must enforce fencing in their own atomic transactions.
function fenced(value, owner) {
  if (!value || typeof value !== "object") return value;
  return new Proxy(value, { get(target, key) {
    const member = target[key];
    if (typeof member !== "function") return member;
    return (...args) => { const pending = owner.assertCurrent(); if (pending?.then) throw deliveryError("COORDINATOR_STORE", "The Node adapter requires synchronous fence checks; use its durable single-host owner adapter"); return member.apply(target, args); };
  } });
}

export function createNodeCoordinator({ ctx, store, schedule, manifest, maxEntries = 20, maxChains = 10, intervalMs = 10000 }) {
  assertCompatible(manifest);
  if (manifest.coreVersion !== CORE_VERSION) throw deliveryError("COORDINATOR_PIN", "Use the package pinned by this runtime manifest; drain active jobs before staging a compatible upgrade");
  checkRuntimeState({ home: ctx.home, manifest });
  const pin = readJson(join(ctx.home, "runtime-pin.json"));
  if (!pin || pin.coreSha256 !== manifest.coreSha256) throw deliveryError("COORDINATOR_PIN", "Run task-delivery-state migrate with this exact runtime.json before enabling wake-ups");
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxChains) || maxChains < 0) throw deliveryError("COORDINATOR_CONFIG", "Specify bounded entry/chain batches");
  let cursor = 0;
  return createCoordinator({ store, schedule, clock: ctx.clock || Date, intervalMs, advance: async owner => {
    // All workflow/review decisions still live in makeTick. Only the bounded
    // registry window changes; context transports/credentials are injected.
    const checkpoint = owner.checkpoint?.() || {};
    const startupReconciliation = checkpoint.processIdentity !== owner.processIdentity;
    // A new process must cover the prefix too, even if its predecessor stopped
    // at a nonzero cursor. The pending identity lets later wakes keep advancing.
    cursor = startupReconciliation && checkpoint.startupProcessIdentity !== owner.processIdentity ? 0 : checkpoint.cursor ?? cursor;
    const entries = ctx.state.entries(), selected = entries.slice(cursor, cursor + maxEntries);
    cursor = cursor + maxEntries >= entries.length ? 0 : cursor + maxEntries;
    const state = fenced(ctx.state, owner);
    const deps = { ...ctx, startupReconciliation, state: new Proxy(state, { get(target, key) {
      if (key === "entries") return () => { owner.assertCurrent(); return selected; };
      if (key === "chains") return () => { owner.assertCurrent(); const chains = ctx.state.chains(); if (chains.length > maxChains) throw deliveryError("COORDINATOR_CAPACITY", "Reduce queued chains or increase the bounded chain batch before waking"); return chains; };
      return target[key];
    } }), gh: fenced(ctx.gh, owner), git: fenced(ctx.git, owner), notify: fenced(ctx.notify, owner),
      credential: (...args) => { owner.assertCurrent(); return ctx.credential(...args); },
      runnerFor: (...args) => { owner.assertCurrent(); return fenced(ctx.runnerFor(...args), owner); },
      ...(ctx.executionFor ? { executionFor: (...args) => { owner.assertCurrent(); return fenced(ctx.executionFor(...args), owner); } } : {}),
    };
    const result = await makeTick(deps).tick();
    owner.saveCheckpoint?.({ cursor, startupProcessIdentity: startupReconciliation && cursor !== 0 ? owner.processIdentity : null,
      // Commit restart completion only after every bounded entry batch ran.
      ...(!startupReconciliation || cursor === 0 ? { processIdentity: owner.processIdentity } : {}),
    });
    return result;
  } });
}
