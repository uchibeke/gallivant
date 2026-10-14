// Standalone tracker ownership. Embedded trackers keep their host's lifecycle.
import { spawn, execFile } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireProcessLock, assertUnpinnedHome, matchesProcess, pidExists } from "./daemon.mjs";
import { codeStamp, readJson, writeJsonAtomic } from "./fs.mjs";
import { serve, DEFAULT_PORT } from "./commands/serve.mjs";

const recordPath = home => join(home, "tracker.json");
const lockPath = home => join(home, "tracker.lock");
export const trackerUrl = port => `http://127.0.0.1:${port}`;
export function trackerPort(value = DEFAULT_PORT) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--port must be an integer from 1 to 65535");
  return port;
}

export function readTracker(home) {
  const lock = readJson(lockPath(home));
  if (!lock) return null;
  const health = readJson(recordPath(home));
  const record = { ...(health?.instance === lock.instance ? health : {}), ...lock };
  return { ...record, alive: matchesProcess(record), exists: pidExists(record.pid) };
}

function usable(record, port) {
  if (!record) return;
  if (!record.alive && record.exists) throw new Error("Tracker process identity cannot be verified; inspect tracker.json before retrying");
  if (!record.alive || !record.port) return;
  if (record.port !== port) throw new Error(`Tracker already uses port ${record.port}; use --port ${record.port}, or gallivant down before changing it`);
  if (record.code !== codeStamp()) throw new Error("Tracker is running different code; run gallivant down, then gallivant start");
}

export async function trackerForeground(ctx, { port = DEFAULT_PORT } = {}) {
  port = trackerPort(port);
  assertUnpinnedHome(ctx.home);
  const lock = acquireProcessLock(lockPath(ctx.home), "tracker");
  let server;
  const cleanup = () => {
    lock.release();
    process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("exit", cleanup);
  };
  const stop = () => { server?.closeAllConnections(); server?.close(); cleanup(); };
  try {
    server = await serve(ctx, { port, instance: lock.owner.instance });
    writeJsonAtomic(recordPath(ctx.home), { ...lock.owner, port, code: codeStamp() });
    server.once("close", cleanup);
    process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", cleanup);
    return server;
  } catch (error) { server?.close(); cleanup(); throw error; }
}

// Never accept an arbitrary listener on this port as our tracker. Check both the
// process fingerprint and the instance published only after this home bound it.
async function ready(record, port) {
  if (!record?.alive || record.port !== port) return false;
  try {
    const response = await fetch(`${trackerUrl(port)}/api/health`, { signal: AbortSignal.timeout(500), redirect: "error" });
    if (!response.ok) return false;
    return (await response.json()).instance === record.instance;
  } catch { return false; }
}

export async function trackerInBackground(ctx, { port = DEFAULT_PORT, waitMs = 10_000, spawnFn = spawn } = {}) {
  port = trackerPort(port);
  assertUnpinnedHome(ctx.home);
  const prior = readTracker(ctx.home);
  usable(prior, port);
  if (await ready(prior, port)) return prior;
  let child, spawnError;
  // A concurrent start may already own the lock but still be binding its port.
  if (!prior?.alive) {
    const out = openSync(join(ctx.home, "tracker.log"), "a", 0o600);
    try {
      child = spawnFn(process.execPath, [fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url)), "serve", "--foreground", "--no-daemon", "--no-open", "--port", String(port)], {
        detached: true, stdio: ["ignore", out, out], env: { ...process.env, GALLIVANT_HOME: ctx.home },
      });
      child.on("error", error => { spawnError = error; }); child.unref();
    } finally { closeSync(out); }
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    assertUnpinnedHome(ctx.home);
    const record = readTracker(ctx.home);
    usable(record, port);
    if (await ready(record, port)) return record;
    if (spawnError || child?.exitCode != null && !record?.alive) throw new Error(`Tracker failed to start; see ${join(ctx.home, "tracker.log")}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  child?.kill("SIGTERM");
  throw new Error(`Tracker did not become ready; see ${join(ctx.home, "tracker.log")}`);
}

export function stopTracker(ctx) {
  const record = readTracker(ctx.home);
  if (!record?.alive) return { stopped: false, unverified: !!record?.exists, why: record?.exists ? "Tracker identity is unverified; no signal sent" : "No standalone tracker is running" };
  process.kill(record.pid, "SIGTERM");
  return { stopped: true, pid: record.pid };
}

export async function openTracker(port, { platform = process.platform, env = process.env, exec = execFile } = {}) {
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const command = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!command) return false;
  return new Promise(resolve => exec(command, [trackerUrl(trackerPort(port))], { timeout: 5000, env }, error => resolve(!error)));
}
