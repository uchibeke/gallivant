// Process exclusion is independent of best-effort health reporting.
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { openSync, closeSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, codeStamp } from "./fs.mjs";

export const daemonPath = home => join(home, "daemon.json");
const lockPath = home => join(home, "daemon.lock");
const liveOwners = new WeakMap();
const taskOwners = new AsyncLocalStorage();
export function withTaskMutationOwner(home, owner, fn) {
  borrowTaskMutation(home, owner);
  return taskOwners.run({ home: resolve(home), owner }, fn);
}
export function acquireServiceMutation(home, owner) {
  const inherited = taskOwners.getStore();
  owner ||= inherited?.home === resolve(home) ? inherited.owner : null;
  return owner ? borrowTaskMutation(home, owner) : acquireCliMutation(home);
}

// Borrow only an actual, still-held owner for this namespace.
export function borrowTaskMutation(home, owner) {
  const held = liveOwners.get(owner);
  if (!held || !((held.file === resolve(home, "task-mutation.lock")) ||
    (held.file === resolve(home, "daemon.lock") && held.purpose === "runtime"))) {
    throw new Error("task mutation requires a live owner for this namespace");
  }
  return { release() {} };
}

export function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // ps formats lstart using the caller's locale and timezone. A second CLI
    // must not mistake a formatting change for PID reuse and replace a live lock.
    const identity = execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    }).trim();
    return identity ? `v2:${identity}` : null;
  } catch { return null; }
}

export function processBirth(pid, { uid } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const fields = uid === undefined ? ["-o", "lstart="] : ["-o", "ruid=", "-o", "lstart="];
    const text = execFileSync("ps", [...fields, "-p", String(pid)], { encoding: "utf8", timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" } }).trim();
    if (uid === undefined) return text || null;
    const identity = /^(\d+)\s+(.+)$/.exec(text);
    return identity && Number(identity[1]) === uid ? identity[2] : null;
  } catch { return null; }
}

export const isStableProcessIdentity = identity => typeof identity === "string" && identity.startsWith("v2:");
export const matchesProcess = (record, identity = processIdentity(record?.pid)) => Boolean(record?.identity && record.identity === identity);

export function pidExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

function clearStaleLock(file, label = "daemon") {
  // Serialize stale-owner recovery too: two contenders must never unlink a replacement owner's lock.
  const recovery = `${file}.recovery`;
  try { mkdirSync(recovery, { mode: 0o700 }); }
  catch (e) {
    if (e.code === "EEXIST") throw new Error(`${label} lock recovery is in progress (${recovery}); retry shortly`);
    throw e;
  }
  try {
    const previous = readJson(file, null);
    if (!previous || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || !previous.instance)
      throw new Error(`${label} startup already in progress or lock ownership is unverified; inspect before retrying`);
    if (pidExists(previous.pid)) throw new Error(`${label} already running or PID still occupied (pid ${previous.pid})`);
    if (readJson(file, null)?.instance !== previous.instance) throw new Error(`${label} lock changed during dead-owner verification`);
    unlinkSync(file);
  } finally { rmdirSync(recovery); }
}

export function daemonRecord(home) {
  const lock = readJson(lockPath(home), null);
  const health = readJson(daemonPath(home), null);
  if (!lock) return health;
  return { ...(health?.instance === lock.instance ? health : {}), ...lock };
}

// Read-only contract for service-manager adapters. An observed lease can
// establish a dead owner; activation and throttle policy belong to the host.
export function supervisorStatus({ lease = null, health = null, supervisor = null, platform = process.platform,
  clock = Date, exists = pidExists, identity = processIdentity } = {}) {
  const record = lease || health;
  const valid = Number.isSafeInteger(record?.pid) && record.pid > 0 && typeof record.instance === "string" && !!record.instance;
  const present = valid && exists(record.pid);
  const owner = !record ? "absent" : !valid ? "unverified" : !present ? "dead" :
    isStableProcessIdentity(record.identity) && matchesProcess(record, identity(record.pid)) ? "live" : "unverified";
  const stopped = health?.instance === lease?.instance && health?.stoppedAt;
  const proof = Boolean(valid && lease && !present && lease.purpose !== "runtime" && !lease.stoppedAt && !stopped && isStableProcessIdentity(lease.identity));
  const qualified = supervisor?.qualified === true && supervisor.platform === platform && ["linux", "darwin"].includes(platform) &&
    typeof supervisor.executable === "string" && supervisor.executable.startsWith("/") && supervisor.executable !== "/" &&
    Number.isSafeInteger(supervisor.nextRestartAt);
  const state = !supervisor ? "unavailable" : !qualified ? "observation-only" : !proof ? "waiting-for-dead-lease" :
    supervisor.nextRestartAt > clock.now() ? "throttled" : "eligible";
  return { owner, state, restartEligible: state === "eligible", heartbeatAgeMs: Number.isFinite(Date.parse(health?.lastTick)) ?
    Math.max(0, clock.now() - Date.parse(health.lastTick)) : null };
}

export const inspectSupervision = (home, options = {}) => supervisorStatus({ ...options,
  lease: readJson(lockPath(home), null), health: readJson(daemonPath(home), null) });

export const readDaemon = home => {
  const d = daemonRecord(home);
  if (!d) return null;
  // `stale` is the code on disk being newer than the code this daemon booted with, which means it is running a version
  // of Gallivant that no longer exists. Only meaningful while it is alive, and only when it recorded a stamp at all: a
  // daemon from before this existed has no `code` field and must not be reported as fresh OR stale, because nothing
  // was measured.
  const onDisk = codeStamp();
  const identity = processIdentity(d.pid);
  const live = !d.stoppedAt && matchesProcess(d, identity);
  const stale = Boolean(d.code && onDisk && live && onDisk > d.code);
  const unverified = !d.stoppedAt && !live && pidExists(d.pid);
  return { ...d, alive: live && d.purpose !== "runtime", runtimeBusy: live && d.purpose === "runtime", unverified, onDisk, stale };
};


/** Refuse an incompatible live owner; an absent daemon can still be started later. */
export function assertDaemonUsable(daemon, { starting = false } = {}) {
  if (starting && daemon?.runtimeBusy) throw new Error("runtime maintenance or delivery owns this namespace; retry daemon startup after it finishes");
  if (daemon?.unverified) throw new Error(`daemon pid ${daemon.pid} has an unverifiable process identity; verify and stop the older daemon before restarting`);
  if (daemon?.stale) throw new Error(`daemon pid ${daemon.pid} is running older code and cannot accept new requests. Restart it: gallivant down && gallivant up. Active agent runs keep going.`);
}

/** Claim before any await. Failure to publish ownership is fatal; health writes may fail later. */
export function acquireDaemon(home) {
  const owner = acquireProcessLock(lockPath(home));
  try { assertUnpinnedHome(home); return owner; }
  catch (error) { owner.release(); throw error; }
}

// Same exclusion boundary, without claiming daemon liveness or shutdown rights.
export function acquireRuntimeOwner(home) {
  return acquireProcessLock(lockPath(home), "runtime", "runtime");
}

export function acquireTaskMutation(home) {
  return acquireProcessLock(join(home, "task-mutation.lock"), "task mutation");
}

export function assertUnpinnedHome(home) {
  if (existsSync(join(home, "runtime-pin.json"))) throw Object.assign(new Error("Use the manifest-aware task delivery adapter and coordinator for this pinned namespace; ordinary CLI writes and daemon startup require an unpinned local home"), { code: "TASK_RUNTIME_PIN", version: 1 });
}

// CLI writers share maintenance exclusion and cannot write artifact-pinned homes.
export function acquireCliMutation(home) {
  const owner = acquireTaskMutation(home);
  try {
    assertUnpinnedHome(home);
    return owner;
  } catch (error) { owner.release(); throw error; }
}

/** Also used for long-lived intake mutations; elapsed time never expires a live owner. */
export function acquireProcessLock(file, label = "daemon", purpose) {
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error(`cannot identify this ${label} process; refusing to start without process exclusion`);
  const owner = { ...(purpose ? { purpose } : {}), pid: process.pid, identity, instance: randomUUID(), startedAt: new Date().toISOString() };
  for (;;) {
    let fd;
    try { fd = openSync(file, "wx", 0o600); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      clearStaleLock(file, label);
      continue;
    }
    try { writeFileSync(fd, JSON.stringify(owner), { flush: true }); }
    catch (e) { try { unlinkSync(file); } catch { /* preserve original error */ } throw e; }
    finally { closeSync(fd); }
    break;
  }
  const token = { owner, release: () => {
    liveOwners.delete(token);
    if (readJson(file, null)?.instance === owner.instance) unlinkSync(file);
  } };
  liveOwners.set(token, { file: resolve(file), purpose });
  return token;
}
