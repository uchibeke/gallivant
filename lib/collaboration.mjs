import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { COLLABORATION_EVENT_VERSION, COLLABORATION_TRANSITIONS } from "./collaboration_contract.mjs";
import { withCollaborationDeadline } from "./collaboration_deadline.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const bounded = (value, max = 240) => String(value ?? "").replace(/[\0\r\n]+/g, " ").trim().slice(0, max);
const safeUrl = value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

const decisionFor = reason => ({
  "checks-red": "Review the saved check failures and decide whether to resume or cancel.",
  "reviewer-blocking": "Review the saved feedback and decide whether to resume or cancel.",
  iterations: "Decide whether a new bounded implementation run should be authorized.",
  cancelled: "Confirm whether the stopped task should remain cancelled.",
  "task-needs-input": "Answer the saved task questions in the task intake view.",
}[reason] || "Review the saved task state and decide whether to resume or cancel.");

const entryRun = entry => entry?.last?.run || entry?.task?.run || entry?.task?.id || null;
const taskTitle = id => bounded(String(id).split("/").at(-1), 128) || "task";

function linkFor(config, taskId, kind) {
  const base = config.link_base_url.replace(/\/$/, "");
  return kind === "intake" ? `${base}/task/new?task=${encodeURIComponent(taskId)}` : `${base}/run?id=${encodeURIComponent(taskId)}`;
}

function transitionEvent({ config, taskId, linkTaskId = null, runId, type, state, at, reason = null, pr = null, url = null, actor, source, token, kind = "entry", clock = Date }) {
  const stable = JSON.stringify([COLLABORATION_EVENT_VERSION, taskId, runId, type, token]);
  const id = `gvt-event-${digest(stable).slice(0, 32)}`;
  const taskLink = linkFor(config, linkTaskId || taskId, kind);
  const owner = type === "needs-owner";
  const event = {
    schema: "gallivant.task-transition",
    version: COLLABORATION_EVENT_VERSION,
    id,
    idempotency_key: `${taskId}:${runId || "unassigned"}:${id}`,
    task: { id: taskId, run_id: runId, title: taskTitle(taskId) },
    transition: { type, state: bounded(state, 64), occurred_at: at },
    provenance: {
      actor: { type: bounded(actor?.type || "service", 32), id: bounded(actor?.id || "coordinator", 128) },
      source: { type: bounded(source?.type || "state", 32), id: bounded(source?.id || "task-registry", 128) },
    },
    links: { task: taskLink },
  };
  const prUrl = safeUrl(url);
  if (pr && prUrl) event.links.pull_request = prUrl;
  if (reason) event.transition.reason = bounded(reason, 96);
  if (owner) {
    event.transition.requested_decision = decisionFor(reason);
    event.transition.expires_at = new Date(clock.now() + config.owner_decision_hours * 3600_000).toISOString();
  }
  return event;
}

function entryTransitions(before, after) {
  const out = [];
  if (!after) return out;
  const run = entryRun(after), at = after.updated_at || after.created_at || after.last?.at;
  if (!before) {
    if (!after.task?.id) out.push({ type: "accepted", token: after.created_at || run || after.branch, at });
    if (after.state === "running") out.push({ type: "started", token: run || after.created_at, at });
  } else {
    if (!before.pr && after.pr) out.push({ type: "pr-opened", token: after.pr, at });
    if (before.state !== "needs-human" && after.state === "needs-human") {
      out.push({ type: "needs-owner", token: `${after.reason || "unknown"}:${after.updated_at || after.last?.at || run}`, at, reason: after.reason || "unknown" });
      out.push({ type: "stopped", token: `${after.reason || "unknown"}:${after.updated_at || after.last?.at || run}`, at, reason: after.reason || "unknown" });
    }
    if (!before.dispatch_stopped && after.dispatch_stopped) out.push({ type: "stopped", token: `${after.dispatch_stopped}:${run}`, at, reason: after.dispatch_stopped });
    if (before.state === "needs-human" && ["running", "pr-open"].includes(after.state)) {
      const recheck = after.control?.action === "recheck" && after.control?.status === "applying" ? after.control.id : null;
      const resumeIdentity = recheck || after.updated_at || after.last?.at || run;
      out.push({ type: "resumed", token: resumeIdentity, at });
    }
    if (before.state !== "ready-for-human" && after.state === "ready-for-human") out.push({ type: "ready", token: `${after.pr || "no-pr"}:${after.cursor?.fixed_sha || after.updated_at}`, at });
    if (before.state !== "done" && after.state === "done") {
      const outcome = after.last?.event === "PR merged" ? "pr-merged" : after.last?.event === "PR closed" ? "pr-closed" : "task-complete";
      out.push({ type: "completed", token: `${after.pr || "no-pr"}:${outcome}`, at, reason: outcome });
    }
  }
  return out;
}

function taskTransitions(before, after) {
  if (!after) return [];
  const at = after.updatedAt || new Date().toISOString(), run = after.implementation?.run || null, out = [];
  if (before?.status !== "ready" && after.status === "ready") out.push({ type: "accepted", token: after.readiness?.digest || `${after.taskId}:${after.revision}`, at });
  if (before?.status !== "needs-input" && after.status === "needs-input") out.push({ type: "needs-owner", token: `${after.taskId}:${after.revision}`, at, reason: "task-needs-input" });
  if (before?.status !== "started" && after.status === "started") out.push({ type: "started", token: run || `${after.taskId}:${after.revision}`, at });
  return out;
}

const safeFailureCode = error => {
  const code = String(error?.code || error?.status || "board-unavailable").toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : "board-unavailable";
};

/**
 * Observe the canonical registry at its write boundary. The wrapper is installed only
 * for a configured adapter, so the default state object and every unconfigured caller
 * retain their predecessor behavior. Delivery capture failure never rolls back state.
 */
export function withCollaborationState(state, collaboration, log = { warn() {} }) {
  const wrapped = { ...state };
  for (const method of ["put", "putStarted", "update"]) wrapped[method] = (id, ...args) => {
    const before = state.get(id);
    const result = state[method](id, ...args);
    const after = result ?? state.get(id);
    if (!isDeepStrictEqual(before, after)) {
      try { collaboration.observeEntry(id, before, after); }
      catch (error) { log.warn(`${id}: collaboration event capture unavailable (${error.code || "storage error"}); task state preserved`); }
    }
    return result;
  };
  return wrapped;
}

export function createCollaborationService({ adapter, store, config, log = { info() {}, warn() {} }, clock = Date }) {
  const allowed = new Set(config.significant_events || COLLABORATION_TRANSITIONS);
  let recovered = false, policyReady = false, terminalPolicy = false;
  const threadFor = (taskId, runId, at) => store.threadForTask(taskId) || { key: `gvt-thread-${digest(JSON.stringify([taskId, runId || "unassigned"])).slice(0, 32)}`, taskId, runId, createdAt: at };
  const enqueue = (taskId, runId, transitions, details) => {
    for (const transition of transitions) {
      if (!allowed.has(transition.type)) continue;
      const at = transition.at || new Date(clock.now()).toISOString();
      const event = transitionEvent({ config, taskId, linkTaskId: details.linkTaskId, runId, state: details.state, pr: details.pr, url: details.url, actor: details.actor, source: details.source, kind: details.kind, clock, ...transition, at });
      store.enqueue(threadFor(taskId, runId, at), event);
    }
  };
  const observeEntry = (taskId, before, after, provenance = {}) => enqueue(taskId, entryRun(after) || entryRun(before), entryTransitions(before, after), {
    state: after?.state || "unknown", pr: after?.pr || null, url: after?.url || null,
    actor: provenance.actor, source: provenance.source, kind: "entry",
  });
  const observeTask = (before, after, provenance = {}) => enqueue(provenance.taskId || after?.taskId || before?.taskId, after?.implementation?.run || before?.implementation?.run || null, taskTransitions(before, after), {
    state: after?.status || "unknown", pr: after?.implementation?.pr || null, url: after?.implementation?.url || null,
    actor: provenance.actor || { type: "owner", id: "task-owner" }, source: provenance.source || { type: "task-api", id: "task-service" }, kind: "intake",
    linkTaskId: provenance.intakeId || after?.taskId || before?.taskId,
  });
  const retryAt = attempts => new Date(clock.now() + Math.min(config.retry.max_seconds, config.retry.base_seconds * 2 ** Math.max(0, attempts - 1)) * 1000).toISOString();
  async function verifyPolicy() {
    if (policyReady) return { ok: true };
    const health = store.read().health || {};
    // A terminal policy circuit gets one fresh probe after a daemon restart. That lets an
    // operator repair remote grants without turning every tick into an unbounded retry loop.
    if (terminalPolicy) return { ok: false, terminal: true, policy: { code: health.policyCode } };
    if (health.policyNextAttemptAt && Date.parse(health.policyNextAttemptAt) > clock.now()) return { ok: false, deferred: true };
    let policy;
    try {
      policy = await withCollaborationDeadline(config, signal => adapter.inspectPolicy({ signal }));
    } catch (error) {
      policy = { allow: false, code: safeFailureCode(error), detail: "Collaboration policy could not be verified within the configured deadline" };
    }
    if (!policy.allow) {
      const attempts = (health.policyAttempts || 0) + 1, terminal = attempts >= config.retry.max_attempts;
      const at = new Date(clock.now()).toISOString(), next = terminal ? null : retryAt(attempts);
      store.policy({ state: terminal ? "down" : "degraded", policy: "unresolved", policyCode: policy.code, policyDetail: bounded(policy.detail, 300), policyAttempts: attempts, policyNextAttemptAt: next, lastError: { code: policy.code, at }, nextAttemptAt: next });
      terminalPolicy = terminal;
      log.warn(`collaboration policy unresolved (${policy.code}); task execution and review continue`);
      return { ok: false, policy, terminal };
    }
    policyReady = true;
    store.policy({ policy: "verified", policyCode: null, policyDetail: null, policyAttempts: 0, policyNextAttemptAt: null, actor: policy.actor || null });
    return { ok: true };
  }
  async function flush({ limit = 8 } = {}) {
    if (!recovered) { store.recover(); recovered = true; }
    const snapshot = store.read();
    const hasPending = Object.values(snapshot.deliveries).some(item => item.status === "pending" || item.status === "delivering");
    if (!hasPending && !config.inbound.enabled) return { ok: true, delivered: 0, idle: true };
    if (!policyReady) {
      const policy = await verifyPolicy();
      if (!policy.ok) return policy;
    }
    let attempted = 0;
    while (attempted < limit) {
      // The store exposes at most the earliest outstanding transition for each
      // task. Claim one write at a time so a timed-out destination cannot leave
      // the rest of a batch claimed or multiply the tick's I/O deadline.
      const due = store.due(clock.now(), 1);
      if (!due.length) break;
      attempted += due.length;
      let failed = false;
      for (const delivery of due) {
        try {
          const thread = store.threadForTask(delivery.thread.taskId) || delivery.thread;
          const result = await withCollaborationDeadline(config, signal => adapter.deliver(thread, delivery.item.event, { signal }));
          store.delivered(delivery.id, delivery.claim, { ...result, deliveredAt: new Date(clock.now()).toISOString() });
        } catch (error) {
          const attempts = delivery.item.attempts + 1, terminal = attempts >= config.retry.max_attempts, code = safeFailureCode(error), at = new Date(clock.now()).toISOString();
          store.failed(delivery.id, delivery.claim, { attempts, terminal, code, at, nextAttemptAt: terminal ? null : retryAt(attempts) });
          log.warn(`collaboration delivery ${delivery.id} failed (${code}); task execution and review continue`);
          failed = true;
        }
      }
      if (failed) break;
    }
    return { ok: true, delivered: attempted };
  }
  async function synchronizeInbound() {
    if (!config.inbound.enabled) return { ignored: true, reason: "inbound-disabled" };
    const policy = await verifyPolicy();
    if (!policy.ok) return { ...policy, ignored: true, reason: "policy-unverified" };
    const current = store.inbound();
    const first = current.cursor ? { messages: [], cursor: current.cursor } : await withCollaborationDeadline(config, signal => adapter.snapshot({ channel: config.inbound.channel }, { signal }));
    const live = await withCollaborationDeadline(config, signal => adapter.poll({ channel: config.inbound.channel, cursor: first.cursor }, { signal }));
    const threads = store.threads();
    const suggestions = [...first.messages, ...live.messages].map(message => {
      const thread = threads.find(item => [item.externalId, item.ownerItemId].includes(message.threadId));
      return {
        version: 1, id: message.id, taskId: thread?.taskId || null, text: bounded(message.text, 2000),
        provenance: { destination: "board", eventId: message.id, actor: message.actor, source: message.source },
        trust: "untrusted", authority: "none", control: false, receivedAt: message.at || new Date(clock.now()).toISOString(),
      };
    });
    store.saveInbound({ cursor: live.cursor || first.cursor, suggestions });
    return { cursor: live.cursor || first.cursor, stored: suggestions.length };
  }
  return { observeEntry, observeTask, flush, synchronizeInbound, health: () => store.read().health, suggestions: () => store.inbound().suggestions };
}
