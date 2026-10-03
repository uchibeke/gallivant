// Detached runs, adapted from command-center's lib/run.mjs so its log viewer can read a Gallivant run unchanged.
//
// A run is a child process whose stdout is a file. Nothing about it lives only in this process: the pid is on disk,
// liveness is asked of the operating system, and a daemon restarted mid-run picks it up from the folder. Each entry
// gets its own root, so one run per entry is the natural lock and entries never block each other.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { ensureDir } from "./fs.mjs";
import { stamp } from "./time.mjs";
import { toPrdId } from "./prd.mjs";

/** Signal 0 says whether a pid exists; EPERM means it exists but belongs to someone else, which still counts. */
export const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

const sameProcess = (a, b) => a.pid === b.pid && a.started === b.started;
const ownedGroups = (pid, members) => new Set([pid, ...members.filter(m => m.pid === m.group).map(m => m.group)]);

/** Live descendants, including tool helpers that create their own process groups. */
export function runProcesses(pid, known = [], exec = execFileSync) {
  try {
    const text = exec("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
    });
    const rows = text.split("\n").filter(row => row.trim()).map(row => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(row);
      if (!m) throw new Error("unreadable process row");
      return { pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), zombie: m[4].includes("Z"), started: m[5] };
    });
    // Recorded group leaders keep orphaned tools discoverable after a daemon restart.
    // A tool in a shared outside group never grants ownership of that entire group.
    const groups = ownedGroups(pid, known);
    const ids = new Set(rows.filter(m => groups.has(m.group) || known.some(old => sameProcess(m, old))).map(m => m.pid));
    let count;
    do {
      count = ids.size;
      for (const m of rows) if (ids.has(m.parent)) ids.add(m.pid);
    } while (ids.size !== count);
    return rows.filter(m => ids.has(m.pid) && !m.zombie).map(({ pid, group, started }) => ({ pid, group, started }));
  } catch { return null; } // Unknown must not authorize another writer or a signal.
}

/**
 * Liveness that survives pid reuse: after a daemon crash the exit is never recorded, and days later the same pid
 * can belong to a stranger. A run is ours only if the process's command still names the harness binary.
 */
export function isOurProcess(pid, cmd) {
  if (!alive(pid)) return false;
  try {
    const comm = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return comm.includes(basename(cmd)) || comm.includes(cmd);
  } catch { return false; }
}

// The run folder name. One shape with the brief's id, capped because this is a path segment.
const slug = s => toPrdId(s, { max: 40 }) || "run";

export function makeRunner(root, { clock = Date, probe = isOurProcess, processes = runProcesses, signal = (pid, sig) => process.kill(pid, sig) } = {}) {
  const pendingKills = new Map();
  const pointer = join(root, "latest-run");
  const dirOf = id => {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid run id ${id}`);
    return join(root, id);
  };
  const currentId = () => { try { return readFileSync(pointer, "utf8").trim() || null; } catch { return null; } };
  const read = id => { try { return JSON.parse(readFileSync(join(dirOf(id), "job.json"), "utf8")); } catch { return null; } };
  const write = (id, job) => writeFileSync(join(dirOf(id), "job.json"), JSON.stringify(job, null, 1), { mode: 0o600 });
  const lines = id => { try { return readFileSync(join(dirOf(id), "job.log"), "utf8").split("\n").filter(Boolean); } catch { return []; } };
  // A terminated leader can leave tool subprocesses behind. Do not start a second
  // writer until its tool processes are gone, even though cancellation recorded an exit.
  const running = job => {
    if (!job?.pid) return false;
    if (!job.killed) return job.exit === null && probe(job.pid, job.bin);
    const members = processes(job.pid, job.stopMembers ?? []);
    return members === null || members.length > 0;
  };
  const signalRun = (job, members, sig) => {
    const fail = () => { throw Object.assign(new Error("Cannot verify the interrupted process tree. Inspect its remaining processes before retrying; no replacement was started."), { code: "RUN_STOP_UNVERIFIED" }); };
    if (members === null) fail();
    const groups = ownedGroups(job.pid, job.stopMembers ?? []), targets = new Set();
    for (const m of members) {
      if (groups.has(m.group)) {
        if (!members.some(peer => peer.group === m.group && job.stopMembers?.some(old => sameProcess(peer, old)))) fail();
        targets.add(-m.group);
      } else {
        if (!job.stopMembers?.some(old => sameProcess(m, old))) fail();
        targets.add(m.pid);
      }
    }
    // Stop tools first, then their owner. Validate every target before signalling any.
    for (const target of [...targets].sort((a, b) => (a === -job.pid) - (b === -job.pid))) {
      try { signal(target, sig); } catch (e) { if (e.code !== "ESRCH") throw e; }
    }
  };
  const finishKill = job => {
    if (job?.killed) signalRun(job, processes(job.pid, job.stopMembers ?? []), "SIGKILL");
  };

  /** Spawn. Return a durable job, or stop its process group before rejecting a bookkeeping failure. */
  async function start(name, cmd, args, { cwd, env = {} }) {
    const cur = currentId();
    if (cur && running(read(cur))) throw Object.assign(new Error(`run in progress: ${cur}`), { code: "BUSY" });
    const id = `${stamp(clock)}-${slug(name)}`;
    ensureDir(dirOf(id), 0o700);
    const out = openSync(join(dirOf(id), "job.log"), "w", 0o600);
    try {
      writeFileSync(join(dirOf(id), "cmd.json"), JSON.stringify({ cmd, args, cwd }, null, 1), { mode: 0o600 });
      // spawn changes the OS directory but inherits PWD. OpenCode 1.18.31 prefers PWD for its tool root;
      // leaving the daemon's value here can send edits and Git writes to the wrong checkout.
      const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env, PWD: resolve(cwd || process.cwd()), CP_RUN_DIR: dirOf(id) }, detached: true, stdio: ["ignore", out, out] });
      const job = { id, name, pid: p.pid ?? null, bin: cmd, startedAt: clock.now(), exit: null, cmd: `${cmd} ${args.slice(0, 4).join(" ")}` };
      let startupFailed = false;
      p.on("error", err => {
        if (startupFailed) return;
        const j = read(id) || job;
        write(id, { ...j, exit: 127, endedAt: clock.now(), error: err.message });
      });
      // A death by signal has no exit code; record the signal so it is never mistaken for success.
      p.on("exit", (code, signal) => {
        const j = read(id);
        // kill owns the terminal record while its fallback is pending. If that write
        // failed, retrying it here could throw out of band before descendants are killed.
        if (!startupFailed && j && j.pid === p.pid && j.exit === null && !pendingKills.has(id)) write(id, { ...j, exit: code ?? 128, signal: signal ?? null, endedAt: clock.now() });
      });
      p.unref();
      try {
        write(id, job);
        writeFileSync(pointer, id);
        return job;
      } catch (error) {
        startupFailed = true;
        // This PID belongs to the child just spawned. Do not depend on job.json or
        // latest-run: either may be missing, truncated, or still point to an older run.
        if (job.pid) {
          terminate(job);
          await waitForKill(id);
        }
        throw error;
      }
    } finally {
      // spawn duplicates this descriptor for the child. Close the parent's copy
      // on successful startup and on pre/post-spawn failures alike.
      try { closeSync(out); } catch { /* closed */ }
    }
  }

  /** The newest run with liveness resolved: { ...job, running }. Null when nothing has run. */
  function current() {
    const id = currentId();
    const job = id && read(id);
    return job ? { ...job, running: running(job) } : null;
  }

  /**
   * Record the outcome of a run whose process is gone but whose exit was never written (the daemon was not there
   * when it ended). `inferExit` decides from the log lines the caller already read.
   */
  function settle(id, inferExit = () => 1) {
    const job = read(id);
    if (!job || job.exit !== null) return job;
    if (running(job)) return { ...job, running: true };
    const settled = { ...job, exit: inferExit(), endedAt: clock.now(), inferred: true };
    write(id, settled);
    return settled;
  }

  // A persisted, ownership-checked job or a child just created by start owns this PID.
  function terminate(job) {
    if (pendingKills.has(job.id)) return;
    try { process.kill(-job.pid, "SIGTERM"); } catch { try { process.kill(job.pid, "SIGTERM"); } catch { /* gone */ } }
    scheduleKill(job.id, () => {
      // A leader may exit on TERM while its descendants keep the group alive.
      // Do not signal a reused leader PID now belonging to another command.
      if (!alive(job.pid) || probe(job.pid, job.bin)) {
        try { process.kill(-job.pid, "SIGKILL"); }
        catch { if (probe(job.pid, job.bin)) { try { process.kill(job.pid, "SIGKILL"); } catch { /* gone */ } } }
      }
    });
  }

  function scheduleKill(id, fallback) {
    if (pendingKills.has(id)) return;
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const timer = setTimeout(() => {
      let error = null;
      try { fallback(); } catch (e) { error = e; }
      finally { pendingKills.delete(id); finish(error); }
    }, 5000);
    timer.unref();
    pendingKills.set(id, { timer, done });
  }

  /** SIGTERM the process group, then SIGKILL if it is still there. Only a process that is still ours. */
  function kill(id) {
    const job = read(id);
    if (job?.killed) {
      // Recovery is based on surviving process identities, not an arbitrary deadline.
      // Reads (including tracker GETs) never signal.
      if (clock.now() >= job.killAfter) finishKill(job);
      return false;
    }
    if (!job || !running(job)) return false;
    const stopMembers = processes(job.pid);
    if (stopMembers === null) throw Object.assign(new Error("Cannot inspect the active process group; nothing was stopped."), { code: "RUN_STOP_UNVERIFIED" });
    const stopped = { ...job, exit: 137, endedAt: clock.now(), killed: true, stopMembers, killAfter: clock.now() + 5000 };
    // Own the fallback before writing evidence: a full disk must not leave the
    // child alive or let an exit callback throw before its tools are stopped.
    scheduleKill(id, () => finishKill(stopped));
    try { write(id, stopped); }
    finally { signalRun(stopped, stopMembers, "SIGTERM"); }
    return true;
  }

  /** Keep a short-lived caller alive until its requested process-group fallback has run. */
  function waitForKill(id) {
    const pending = pendingKills.get(id);
    if (!pending) return Promise.resolve();
    pending.timer.ref();
    return pending.done.then(error => { if (error) throw error; });
  }

  return { root, start, current, read, lines, settle, kill, waitForKill, dirOf };
}
