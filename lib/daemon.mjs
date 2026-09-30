// Process exclusion is independent of best-effort health reporting.
import { execFileSync } from "node:child_process";
import { openSync, closeSync, writeFileSync, unlinkSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJson } from "./fs.mjs";

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

function clearStaleLock(file) {
  // Serialize stale-owner recovery too: two contenders must never unlink a replacement owner's lock.
  const recovery = `${file}.recovery`;
  try { mkdirSync(recovery, { mode: 0o700 }); }
  catch (e) {
    if (e.code === "EEXIST") throw new Error(`daemon lock recovery is in progress (${recovery}); retry shortly`);
    throw e;
  }
  try {
    const previous = readJson(file, null);
    if (!previous) throw new Error("daemon startup already in progress; retry shortly");
    const identity = processIdentity(previous.pid);
    // A legacy fingerprint has no recorded locale/timezone. A mismatch cannot
    // prove PID reuse: require that process to exit before replacing its lock.
    if (pidExists(previous.pid) && (!isStableProcessIdentity(previous.identity) || !identity || previous.identity === identity)) throw new Error(`daemon already running (pid ${previous.pid})`);
    unlinkSync(file);
  } finally { rmdirSync(recovery); }
}

export function daemonRecord(home) {
  const lock = readJson(lockPath(home), null);
  const health = readJson(daemonPath(home), null);
  if (!lock) return health;
  return { ...(health?.instance === lock.instance ? health : {}), ...lock };
}

/** Claim before any await. Failure to publish ownership is fatal; health writes may fail later. */
export function acquireDaemon(home) {
  const file = lockPath(home);
  const identity = processIdentity(process.pid);
  if (!identity) throw new Error("cannot identify this daemon process; refusing to start without process exclusion");
  const owner = { pid: process.pid, identity, instance: randomUUID(), startedAt: new Date().toISOString() };
  for (;;) {
    let fd;
    try { fd = openSync(file, "wx", 0o600); }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      clearStaleLock(file);
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
