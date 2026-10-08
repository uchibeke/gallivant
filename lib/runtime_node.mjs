import { join, isAbsolute } from "node:path";
import { readJson, writeJsonAtomic, ensureDir } from "./fs.mjs";
import { acquireRuntimeOwner } from "./daemon.mjs";
import { makeTick } from "./tick.mjs";
import { createCoordinator } from "./coordinator.mjs";
import { deliveryError } from "./task_delivery_contract.mjs";
import { runtimePinManifest, assertRuntimePin } from "./runtime_state.mjs";

export const NODE_RUNTIME_REQUIREMENTS = Object.freeze({ runtime: "node>=22", store: "durable single-host volume", replicas: 1,
  dependencies: ["git", "gh", "isolated verification sandbox", "configured provider transports"],
  pagesRemedy: "Keep Pages for OAuth/MCP/UI. Route authorized operations through an authenticated binding to one Node 22 coordinator with Git/gh, durable volume and external wake-up scheduling. Codex Cloud additionally needs the pinned CLI and its trusted operator account; environment repository verification remains blocked. Evaluate an existing Node-capable runtime or Cloudflare Container before provisioning; do not add a mandatory Worker." });

export function createNodeOwnerStore({ home, durable = false, replicas = 1 }) {
  if (!isAbsolute(home || "") || !durable || replicas !== 1) throw deliveryError("COORDINATOR_STORE", "Configure an absolute durable volume and exactly one single-host replica; filesystem locks are not distributed leases");
  ensureDir(home);
  return { withOwner: async fn => {
    const lock = acquireRuntimeOwner(home), file = join(home, "coordinator.json");
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
  manifest = runtimePinManifest(manifest);
  const validatePin = () => assertRuntimePin({ home: ctx.home, manifest });
  validatePin();
  // A delayed callback can outlive an idle migration. Validate under ownership
  // before the portable envelope schedules or advances any task work.
  if (typeof store?.withOwner !== "function") throw deliveryError("COORDINATOR_CONFIG", "Inject a durable fenced owner store");
  const pinnedStore = { withOwner: fn => store.withOwner(async owner => {
    await owner.assertCurrent();
    validatePin();
    return fn(owner);
  }) };
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxChains) || maxChains < 0) throw deliveryError("COORDINATOR_CONFIG", "Specify bounded entry/chain batches");
  let lastEntry = null;
  return createCoordinator({ store: pinnedStore, schedule, clock: ctx.clock || Date, intervalMs, advance: async owner => {
    // All workflow/review decisions still live in makeTick. Only the bounded
    // registry window changes; context transports/credentials are injected.
    const checkpoint = owner.checkpoint?.() || {};
    const startupReconciliation = checkpoint.processIdentity !== owner.processIdentity;
    // Ignore legacy numeric offsets: replay from the beginning rather than risk
    // skipping an entry after removals. New processes also restart the sweep.
    const after = startupReconciliation && checkpoint.startupProcessIdentity !== owner.processIdentity ? null :
      Object.hasOwn(checkpoint, "entryCursor") ? checkpoint.entryCursor : lastEntry;
    const entries = ctx.state.entries().sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const window = entries.filter(([id]) => !after || id > after), selected = window.slice(0, maxEntries);
    const entryCursor = window.length > maxEntries ? selected.at(-1)[0] : null;
    // Keyset rotation remains fair when earlier chains finish or are cancelled.
    // Retained history is never eligible for canonical tickChains processing.
    owner.assertCurrent();
    const activeChains = ctx.state.chains().filter(([, chain]) => chain.status === "active").sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const chainWindow = activeChains.filter(([name]) => !checkpoint.chainCursor || name > checkpoint.chainCursor);
    const selectedChains = chainWindow.slice(0, maxChains);
    const chainCursor = maxChains === 0 ? checkpoint.chainCursor ?? null : chainWindow.length > maxChains ? selectedChains.at(-1)[0] : null;
    const state = fenced(ctx.state, owner);
    let chainsPolled = false;
    const deps = { ...ctx, startupReconciliation,
      // Complete an unfinished sweep before waiting; never revisit its prefix.
      // Otherwise restore makeTick's own review deadline across process wakes.
      nextChainAt: maxChains === 0 ? Infinity : checkpoint.chainCursor ? 0 : checkpoint.nextChainAt ?? 0,
      state: new Proxy(state, { get(target, key) {
      if (key === "entries") return () => { owner.assertCurrent(); return selected; };
      if (key === "chains") return () => { owner.assertCurrent(); chainsPolled = true; return selectedChains; };
      return target[key];
    } }), gh: fenced(ctx.gh, owner), git: fenced(ctx.git, owner), notify: fenced(ctx.notify, owner),
      credential: (...args) => { owner.assertCurrent(); return ctx.credential(...args); },
      runnerFor: (...args) => { owner.assertCurrent(); return fenced(ctx.runnerFor(...args), owner); },
      ...(ctx.executionFor ? { executionFor: (...args) => { owner.assertCurrent(); return fenced(ctx.executionFor(...args), owner); } } : {}),
    };
    const tick = makeTick(deps), result = await tick.tick();
    owner.saveCheckpoint?.({ cursor: 0, entryCursor,
      ...(chainsPolled ? { chainCursor, nextChainAt: tick.nextChainAt } : {}),
      startupProcessIdentity: startupReconciliation && entryCursor !== null ? owner.processIdentity : null,
      // Commit restart completion only after every bounded entry batch ran.
      ...(!startupReconciliation || entryCursor === null ? { processIdentity: owner.processIdentity } : {}),
    });
    lastEntry = entryCursor;
    return result;
  } });
}
