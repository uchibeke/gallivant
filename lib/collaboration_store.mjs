import { randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs.mjs";

const WAIT_MS = 5_000;
const STALE_MS = 30_000;
const INITIAL = () => ({ version: 1, threads: {}, deliveries: {}, inbound: { cursor: null, suggestions: [] }, health: { state: "idle", pending: 0, failed: 0 } });

const alive = file => {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
    try { process.kill(owner.pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
  } catch { return false; }
};

function withLock(file, fn) {
  const lock = `${file}.lock`, deadline = Date.now() + WAIT_MS;
  for (;;) {
    let fd;
    try { fd = openSync(lock, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_MS && !alive(lock)) { unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new Error("collaboration delivery state is locked by another process");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid })); return fn(); }
    finally { closeSync(fd); try { unlinkSync(lock); } catch { /* already recovered */ } }
  }
}

const validate = value => {
  if (!value || value.version !== 1 || !value.threads || !value.deliveries || !value.inbound || !value.health) throw new Error("unsupported collaboration delivery state; restore a compatible private state file before retrying");
  return value;
};

export const collaborationStatePath = home => join(home, "collaboration.json");

/** Private, durable outbox and inbound cursor. Destination content never enters the canonical task registry. */
export function createCollaborationStore(home) {
  const file = collaborationStatePath(home);
  const load = () => validate(readJson(file, INITIAL()));
  const transaction = fn => withLock(file, () => {
    const state = load(), result = fn(state);
    writeJsonAtomic(file, state, 0o600);
    return result;
  });
  return {
    file,
    read: () => structuredClone(load()),
    threads: () => Object.values(load().threads).map(thread => structuredClone(thread)),
    threadForTask: taskId => {
      const thread = Object.values(load().threads).find(item => item.taskId === taskId);
      return thread ? structuredClone(thread) : null;
    },
    enqueue(thread, event) {
      return transaction(state => {
        state.threads[thread.key] ||= thread;
        if (state.deliveries[event.id]) return false;
        if (Object.keys(state.deliveries).length >= 4096) throw new Error("collaboration outbox reached its 4096-event safety limit; archive delivered records without changing retained idempotency keys before enabling new delivery");
        state.deliveries[event.id] = { event, threadKey: thread.key, status: "pending", attempts: 0, nextAttemptAt: null, claim: null };
        state.health = { ...state.health, state: "pending", pending: Object.values(state.deliveries).filter(item => item.status === "pending").length };
        return true;
      });
    },
    due(now, limit = 8) {
      return transaction(state => {
        const blockedThreads = new Set(), items = [];
        for (const entry of Object.entries(state.deliveries)) {
          const [, item] = entry;
          if (item.status === "delivered" || blockedThreads.has(item.threadKey)) continue;
          // Every non-delivered record blocks later records for its task. A due
          // pending record is the only one claimable; retry backoff, an active
          // claim, or a terminal failure keeps successors queued behind it.
          blockedThreads.add(item.threadKey);
          if (item.status === "pending" && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now)) items.push(entry);
          if (items.length >= limit) break;
        }
        return items.map(([id, item]) => {
          const claim = randomUUID();
          item.status = "delivering"; item.claim = claim; item.claimedAt = new Date(now).toISOString();
          return { id, claim, item: structuredClone(item), thread: structuredClone(state.threads[item.threadKey]) };
        });
      });
    },
    recover() {
      transaction(state => {
        for (const item of Object.values(state.deliveries)) if (item.status === "delivering") { item.status = "pending"; item.claim = null; item.claimedAt = null; }
      });
    },
    delivered(id, claim, patch = {}) {
      transaction(state => {
        const item = state.deliveries[id];
        if (!item || item.claim !== claim) return;
        Object.assign(item, { status: "delivered", claim: null, claimedAt: null, deliveredAt: patch.deliveredAt, externalId: patch.externalId || null, error: null });
        if (patch.threadId) state.threads[item.threadKey].externalId = patch.threadId;
        if (patch.ownerItemId) state.threads[item.threadKey].ownerItemId = patch.ownerItemId;
        const pending = Object.values(state.deliveries).filter(record => record.status === "pending" || record.status === "delivering").length;
        const failed = Object.values(state.deliveries).filter(record => record.status === "failed").length;
        state.health = { ...state.health, state: failed ? "degraded" : pending ? "pending" : "up", pending, failed, lastSuccessAt: patch.deliveredAt, lastError: failed ? state.health.lastError : null };
      });
    },
    failed(id, claim, { attempts, nextAttemptAt, terminal, at, code }) {
      transaction(state => {
        const item = state.deliveries[id];
        if (!item || item.claim !== claim) return;
        Object.assign(item, { status: terminal ? "failed" : "pending", attempts, nextAttemptAt, claim: null, claimedAt: null, error: { code, at } });
        const pending = Object.values(state.deliveries).filter(record => record.status === "pending" || record.status === "delivering").length;
        const failed = Object.values(state.deliveries).filter(record => record.status === "failed").length;
        state.health = { ...state.health, state: terminal ? "down" : "degraded", pending, failed, lastError: { code, at }, nextAttemptAt };
      });
    },
    policy(result) { transaction(state => { state.health = { ...state.health, ...result }; }); },
    inbound() { return structuredClone(load().inbound); },
    saveInbound({ cursor, suggestions }) {
      transaction(state => {
        const known = new Set(state.inbound.suggestions.map(item => item.id));
        for (const suggestion of suggestions) if (!known.has(suggestion.id)) { state.inbound.suggestions.push(suggestion); known.add(suggestion.id); }
        if (state.inbound.suggestions.length > 256) state.inbound.suggestions.splice(0, state.inbound.suggestions.length - 256);
        if (cursor) state.inbound.cursor = cursor;
      });
    },
  };
}
