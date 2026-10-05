// Process exclusion is independent of best-effort health reporting.
import { execFileSync } from "node:child_process";
import { openSync, closeSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, codeStamp } from "./fs.mjs";

export const daemonPath = home => join(home, "daemon.json");
const lockPath = home => join(home, "daemon.lock");

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

export const isStableProcessIdentity = identity => typeof identity === "string" && identity.startsWith("v2:");
export const matchesProcess = (record, identity = processIdentity(record?.pid)) => Boolean(record?.identity && record.identity === identity);

export function pidExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
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
    if (!previous) throw new Error(`${label} startup already in progress; retry shortly`);
    const identity = processIdentity(previous.pid);
    // A legacy fingerprint has no recorded locale/timezone. A mismatch cannot
    // prove PID reuse: require that process to exit before replacing its lock.
    if (pidExists(previous.pid) && (!isStableProcessIdentity(previous.identity) || !identity || previous.identity === identity)) throw new Error(`${label} already running (pid ${previous.pid})`);
    unlinkSync(file);
  } finally { rmdirSync(recovery); }
}

export function daemonRecord(home) {
  const lock = readJson(lockPath(home), null);
  const health = readJson(daemonPath(home), null);
  if (!lock) return health;
  return { ...(health?.instance === lock.instance ? health : {}), ...lock };
}

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
  const unverified = !d.stoppedAt && !live && pidExists(d.pid) && (!isStableProcessIdentity(d.identity) || !identity);
  return { ...d, alive: live, unverified, onDisk, stale };
};


/** Refuse an incompatible live owner; an absent daemon can still be started later. */
export function assertDaemonUsable(daemon) {
  if (daemon?.unverified) throw new Error(`daemon pid ${daemon.pid} has an unverifiable process identity; verify and stop the older daemon before restarting`);
  if (daemon?.stale) throw new Error(`daemon pid ${daemon.pid} is running older code and cannot accept new requests. Restart it: gallivant down && gallivant up. Active agent runs keep going.`);
}

/** Claim before any await. Failure to publish ownership is fatal; health writes may fail later. */
export function acquireDaemon(home) {
  return acquireProcessLock(lockPath(home));
}

/** Also used for long-lived intake mutations; elapsed time never expires a live owner. */
export function acquireProcessLock(file, label = "daemon") {
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error(`cannot identify this ${label} process; refusing to start without process exclusion`);
  const owner = { pid: process.pid, identity, instance: randomUUID(), startedAt: new Date().toISOString() };
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
  const release = () => {
    if (readJson(file, null)?.instance === owner.instance) unlinkSync(file);
  };
  return { owner, release };
}
