import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { controlPending } from "./control_contract.mjs";
import { executionLive } from "./execution_contract.mjs";
import { learningDeliveryPending } from "./learning_contract.mjs";
import { completionStopsAutomation } from "./task_completion.mjs";

export const STRUCTURAL_SCAN_SECONDS = 60;
export const RECOVERY_LANES = Object.freeze({
  control: 4, settlement: 8, author: 8, host: 12, reviewer: 4, chain: 4, maintenance: 4,
});
const SAMPLE_LIMIT = 120;
const byKey = ([a], [b]) => a < b ? -1 : a > b ? 1 : 0;

export const executionOwed = entry => Boolean(entry && (executionLive(entry) || entry.last?.run && entry.last.exit == null ||
  entry.initial_dispatch?.status === "dispatching" || entry.route_recovery?.phase === "preparing"));

const handoffProjectionPending = entry => Boolean(entry.last?.run && entry.execution?.runId !== entry.last.run && completionStopsAutomation(entry));

// A missing projection can hide an accepted continuation or an unsettled run
// already named by a delivery-ready handoff. Both require an exact ledger owner.
export function unprojectedExecution(id, entry, run) {
  const ex = run?.execution;
  if (!entry || entry.state === "done" || !run?.id || ex?.version !== 1 || ex.taskId !== id || ex.runId !== run.id ||
      ex.provider !== entry.harness || !["accepted", "unknown"].includes(ex.acceptance)) return null;
  if (run.id === entry.last?.run) return handoffProjectionPending(entry) ? "handoff" : null;
  return typeof ex.operationId === "string" && ex.operationId.startsWith(`${entry.last?.run || "initial"}:${entry.iteration}:`) ? "continuation" : null;
}

export function cleanupOwed(entry, anchored) {
  if (!entry.pr || !entry.worktree || !["done", "ready-for-human"].includes(entry.state) ||
      entry.state !== "done" && !completionStopsAutomation(entry)) return false;
  const cleanup = entry.workspace_cleanup;
  const terminal = entry.completionEvidence?.terminal;
  return !["done", "retained"].includes(cleanup?.status) || Boolean((entry.chain || anchored) &&
    (!terminal || cleanup.pr !== entry.pr || cleanup.head !== terminal.head));
}

export function scheduledEntry(id, entry, { anchors, cleanup, maintenance }) {
  if (controlPending(entry.control) || executionOwed(entry) || learningDeliveryPending(entry) || Number.isFinite(entry.output_next_at)) return true;
  if (cleanup && cleanupOwed(entry, anchors.has(id))) return true;
  if (maintenance && (entry.workspace_cleanup?.retry_at || entry.runtime_cleanup?.next_at)) return true;
  if (entry.state === "done" || completionStopsAutomation(entry)) return false;
  return Boolean(entry.pr || entry.state === "running" || entry.base_repair && entry.base_repair.status !== "verified" ||
    entry.firstPartyReview?.status === "running" || ["launching", "waiting", "reconciling"].includes(entry.network_retry?.phase) ||
    entry.recovery_profile && entry.reason === "no-pr");
}

export const recoverySchedulePath = home => join(home, "recovery-schedule.json");

export function makeWorkSlots(capacity) {
  let active = 0;
  const waiters = [];
  return async fn => {
    if (active >= capacity) await new Promise(resolve => waiters.push(resolve));
    else active++;
    try { return await fn(); }
    finally {
      const next = waiters.shift();
      if (next) next();
      else active--;
    }
  };
}

export function makeRecoverySchedule({ clock = Date, scanSeconds = STRUCTURAL_SCAN_SECONDS, home, limits = {}, checkpoint }) {
  const file = home && recoverySchedulePath(home);
  const load = checkpoint?.load ?? (() => file ? readJson(file, null) : null);
  const persist = checkpoint?.save ?? (value => { if (file) writeJsonAtomic(file, value, 0o600, { durable: true }); });
  let snapshot = null, registryStamp, scanAt = 0, saved, metrics;
  const firstDue = new Map();

  function scan(state, options) {
    const at = clock.now(), stamp = state.registryStamp?.();
    if (!snapshot || at >= scanAt || stamp !== registryStamp) {
      const active = ([, chain]) => chain.status === "active";
      const chains = state.chains(active).filter(active);
      const anchors = new Set(chains.map(([, chain]) => chain.after?.id).filter(Boolean));
      const outputDue = new Map();
      const eligible = ([id, entry]) => {
        if (options.outputNextAtFor && entry.output_next_at === undefined && entry.last?.run && entry.last.exit != null && !outputDue.has(id)) {
          try { outputDue.set(id, options.outputNextAtFor(id, entry)); }
          catch { outputDue.set(id, at); } // Let a bounded maintenance worker report the unreadable queue.
        }
        return scheduledEntry(id, entry, { ...options, anchors }) || Number.isFinite(outputDue.get(id));
      };
      const candidate = row => eligible(row) || Boolean(options.readExecution && handoffProjectionPending(row[1]));
      const entries = state.entries(candidate).filter(candidate), unprojected = new Map();
      if (options.readExecution) for (const [id, entry] of entries) {
        if (entry.state === "done" || controlPending(entry.control) || executionOwed(entry) ||
            (completionStopsAutomation(entry) && !handoffProjectionPending(entry))) continue;
        try {
          const run = options.readExecution(id, entry);
          const projection = unprojectedExecution(id, entry, run);
          if (projection === "continuation" || projection === "handoff" && (run.running || executionLive(run))) unprojected.set(id, run);
        } catch { /* The ordinary bounded entry work handles unreadable ledgers. */ }
      }
      const ids = entries.filter(row => unprojected.has(row[0]) || eligible(row)).map(([id]) => id);
      snapshot = { ids, chains: chains.map(([name]) => name), anchors, outputDue, unprojected };
      scanAt = at + scanSeconds * 1000;
      registryStamp = stamp;
      const valid = new Set([...snapshot.ids, ...snapshot.chains]);
      for (const lane of firstDue.values()) for (const id of lane.keys()) if (!valid.has(id)) lane.delete(id);
    }
    return snapshot;
  }

  function begin(started = clock.now()) {
    saved ??= load() || { version: 1, cursors: {}, samples: [] };
    if (saved.version !== 1) throw new Error("Unsupported recovery scheduler checkpoint. Restore a compatible coordinator before resuming.");
    const cursors = { ...saved.cursors }, lanes = {};
    function batch(lane, candidates, { wrap = true, priority } = {}) {
      const capacity = limits[lane] ?? RECOVERY_LANES[lane];
      const due = candidates.filter(([, at]) => at <= started).sort(byKey);
      if (!firstDue.has(lane)) firstDue.set(lane, new Map());
      const waiting = firstDue.get(lane), keys = new Set(due.map(([id]) => id));
      for (const id of waiting.keys()) if (!keys.has(id)) waiting.delete(id);
      for (const [id, at] of due) if (!waiting.has(id)) waiting.set(id, at > 0 ? at : started);
      const after = cursors[lane], pivot = after == null ? 0 : due.findIndex(([id]) => id > after);
      const ordered = pivot < 0 ? (wrap ? due : []) : wrap ? [...due.slice(pivot), ...due.slice(0, pivot)] : due.slice(pivot);
      const eligible = priority?.size ? [...ordered.filter(([id]) => priority.has(id)), ...ordered.filter(([id]) => !priority.has(id))] : ordered;
      const chosen = eligible.slice(0, capacity);
      if (capacity) cursors[lane] = wrap ? chosen.at(-1)?.[0] ?? null : ordered.length > capacity ? chosen.at(-1)[0] : null;
      const report = lanes[lane] = { capacity, due: due.length, selected: chosen.length, saturated: ordered.length > capacity,
        oldestDueMs: due.reduce((max, [id]) => Math.max(max, started - waiting.get(id)), 0), queueDelayMs: 0, progressed: 0 };
      return { ids: chosen.map(([id]) => id), cursor: cursors[lane], start(id) {
        report.queueDelayMs = Math.max(report.queueDelayMs, clock.now() - waiting.get(id));
        waiting.delete(id);
      }, progress() { report.progressed++; } };
    }
    function finish() {
      const overall = Object.values(lanes);
      const sample = { durationMs: Math.max(0, clock.now() - started), queueDelayMs: Math.max(0, ...overall.map(lane => lane.queueDelayMs)),
        oldestDueMs: Math.max(0, ...overall.map(lane => lane.oldestDueMs)) };
      const samples = [...saved.samples, sample].slice(-SAMPLE_LIMIT);
      const percentile = key => {
        const values = samples.map(item => item[key]).sort((a, b) => a - b);
        return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, values[Math.ceil(values.length * p / 100) - 1]]));
      };
      metrics = { ...sample, scanSeconds, samples: samples.length, lanes, percentiles: Object.fromEntries(Object.keys(sample).map(key => [key, percentile(key)])) };
      saved = { version: 1, cursors, samples, metrics };
      persist(saved);
      return metrics;
    }
    return { started, batch, finish, cursor: lane => cursors[lane] };
  }
  return { scan, begin, settled(state) { registryStamp = state.registryStamp?.(); }, get metrics() { return metrics; } };
}
