// `gallivant up`: the daemon. Reconciles with GitHub on boot, then ticks on a setTimeout chain so ticks never
// overlap. Health is a file (daemon.json) that `status` reads; a second daemon exits when the first is alive.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTick } from "../tick.mjs";
import { probeAll, allOk, probeFix } from "../probe.mjs";
import { readJson, writeJsonAtomic, VERSION, codeStamp, gallivantHome } from "../fs.mjs";
import { nowIso, later } from "../time.mjs";
import { parseBlock } from "../block.mjs";
import { countRounds, lastOwnCommentAt, reviewerClock } from "../events.mjs";
import { ensurePrdSnapshot } from "../prd.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { receiptHash } from "../deliverable.mjs";
import { worktreePath, isOurBranch, prdIdFromBranch } from "../git.mjs";
import { daemonPath, readDaemon, assertDaemonUsable, acquireDaemon } from "../daemon.mjs";
import { repoNames } from "../config.mjs";

export { daemonPath, readDaemon } from "../daemon.mjs";


/**
 * `gallivant down`: stop the daemon.
 *
 * It existed as a signal and not as a command, which is a gap an operator pays for at the worst moment. `up` already
 * traps SIGTERM and writes `stoppedAt` before exiting, so the mechanism was there; what was missing was any way to
 * reach it without reading a pid out of `ps`. That came up for real: a daemon had to be stopped because it was running
 * stale code, and the instruction was a raw `kill <pid>`.
 *
 * SIGTERM and not SIGKILL, so the trap runs and the heartbeat records that the daemon stopped on purpose rather than
 * leaving a file that says it is alive with a pid that is not.
 *
 * It does not wait for a run to finish, and says so rather than deciding for the operator. A spawned session is its own
 * process and survives the daemon; the next `up` settles it, because `last.exit` is null and that is what tells
 * `settleRun` the run is still owed an outcome.
 */
export function down(ctx, { home = ctx?.home ?? gallivantHome() } = {}) {
  const d = readDaemon(home);
  if (!d) return { stopped: false, why: `no daemon has run under ${home}` };
  if (!d.alive) return { stopped: false, why: `no daemon is running with a verified identity (pid ${d.pid}${d.stoppedAt ? `, stopped at ${d.stoppedAt}` : ""})`, pid: d.pid };
  try { process.kill(d.pid, "SIGTERM"); }
  catch (e) { return { stopped: false, why: `pid ${d.pid} could not be signalled (${e.code || e.message})`, pid: d.pid }; }
  ctx?.log?.info?.(`daemon ${d.pid} sent SIGTERM`);
  return { stopped: true, pid: d.pid, startedAt: d.startedAt };
}

/**
 * Bring the registry in line with GitHub: every open PR of ours on a gallivant/* branch with a valid block is
 * watched, iteration recovered from our round comments (since the last reset comment), cursors set so history is
 * not replayed. The PRD snapshot is taken from the PR branch when the daemon has none; that copy was writable by
 * the session, which the log says. Missing checkouts are recreated lazily by the tick when a run is needed.
 */
export async function reconcile(ctx, ownLogin) {
  const { config, state, gh, log } = ctx;
  const added = [];
  for (const repo of repoNames(config)) {
    let prs;
    try { prs = await gh.prListMine(repo); } catch (e) { log.warn(`reconcile ${repo}: ${e.message}`); continue; }
    for (const pr of prs || []) {
      if (pr.isCrossRepository || !isOurBranch(pr.headRefName)) continue;
      if (state.findByPr(repo, pr.number)) continue;
      const { block, reason } = parseBlock(pr.body);
      if (!block) { log.warn(`reconcile ${repo}#${pr.number}: ${reason}, ignored`); continue; }
      if (block.branch !== pr.headRefName) { log.warn(`reconcile ${repo}#${pr.number}: block branch differs from head, ignored`); continue; }
      const prdId = prdIdFromBranch(pr.headRefName);
      const id = entryId(repo, prdId);
      if (state.get(id)) { log.warn(`reconcile ${repo}#${pr.number}: id ${id} already in use, ignored`); continue; }
      const [comments, headDate] = await Promise.all([gh.issueComments(repo, pr.number), gh.commitDate(repo, pr.headRefOid).catch(() => null)]);
      const lastOwn = lastOwnCommentAt(comments, ownLogin);
      await ensurePrdSnapshot(ctx, { id, repo, path: block.prd, ref: pr.headRefName });
      // `base` is the branch the PR targets, read off the PR rather than guessed from config: a recovered entry has to merge
      // in the branch this pull request will actually be merged into, and only GitHub knows which that is.
      const entry = newEntry({ prd: block.prd, harness: block.harness, session: block.session, repo, branch: pr.headRefName, worktree: worktreePath(config, repo, prdId), pr: pr.number, url: pr.url, state: STATES.prOpen, nowIso: nowIso(), base: typeof pr.baseRefName === "string" && pr.baseRefName ? pr.baseRefName : null });
      state.put(id, {
        ...entry,
        iteration: countRounds(comments, ownLogin),
        // The receipt fingerprint comes from the body `prListMine` already returned, as every other writer of this
        // cursor sets it. Left null, a receipt that was on the PR before the recovery read as a change the next time
        // a run ended, so a run that did nothing counted as a round and posted "Completion receipt updated." to the
        // PR, which `countRounds` then read back as a real round on the recovery after that.
        //
        // `checks_sha` is null here, the same as `register.mjs` sets it and for the same reason, which is the one thing
        // the two files used to disagree about. It is the head whose failing checks were already dispatched, and no head
        // qualifies on a recovery: a fix that had been dispatched AND had pushed would have moved the head, so failures
        // on the head that is actually there have not been fixed by anything. The only case a recovery could dispatch
        // twice is a run that was still in flight when the daemon died, and that run is orphaned and its work lost
        // anyway, so redoing it is the point. Setting it to the recovered head instead suppressed those failures, and
        // suppressing them is not the same as stopping for them: `checks-red` only fires when the reviewer verdict is
        // not "waiting", and on a recovery with a bot reviewer that has not spoken it is, so a red head arrived
        // unaddressed and the entry then stopped with `reviewer-silent`, naming the wrong thing entirely.
        cursor: { since: later(lastOwn, headDate ?? pr.createdAt), dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
        // Through `reviewerClock`, the one place that rule lives, rather than raw. Recovery happens because the operator
        // lost state: a crash, a machine move. An unfloored clock stopped a PR whose last round comment was older than
        // `stall_hours` with `reviewer-silent` on the FIRST tick after the daemon came back, for silence that accrued
        // while no daemon was running to ask, and cost the operator a `register` to resume. The floor gives a recovered
        // entry the same grace a freshly nudged one gets; the ask is not older than the nudge window, because whatever
        // happened before this boot, the daemon is only asking now.
        rereview: { at: reviewerClock({ config, pushedAt: later(lastOwn, pr.createdAt), floorAt: nowIso() }), nudged: false },
        last: { at: nowIso(), event: "recovered from GitHub" },
      });
      added.push(id);
      log.info(`${id}: recovered from ${pr.url}`);
    }
  }
  return added;
}

/**
 * Start a daemon in the background and return once it is actually up, or null when one already is.
 *
 * `start` calls this because the two commands are one intention: a session that opens a pull request nobody watches
 * is a silent stall, and an operator who has to remember a second command in a second terminal will sometimes not.
 * The child is detached with its output to the log, so it outlives the terminal that ran `start`.
 *
 * It waits for verified process ownership, published before the first GitHub probe. A daemon still loading config
 * has not acquired its lock and does not yet count as started.
 */
export async function upInBackground(ctx, { bin = process.execPath, script = fileURLToPath(new URL("../../bin/gallivant.mjs", import.meta.url)), waitMs = 10_000, sleep = ms => new Promise(r => setTimeout(r, ms)), spawnFn = spawn } = {}) {
  const existing = readDaemon(ctx.home);
  assertDaemonUsable(existing);
  if (existing?.alive) return null;
  const out = openSync(join(ctx.home, "daemon.log"), "a", 0o600);
  let child;
  let spawnError = null;
  try {
    child = spawnFn(bin, [script, "up"], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, GALLIVANT_HOME: ctx.home } });
    child.on?.("error", e => { spawnError = e; });
    child.unref();
  } finally { closeSync(out); }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const d = readDaemon(ctx.home);
    assertDaemonUsable(d);
    if (d?.alive) return d;
    if (spawnError) throw new Error(`the daemon could not start: ${spawnError.message}; see ${join(ctx.home, "daemon.log")}`);
    if (child.exitCode !== null) throw new Error(`the daemon exited immediately (code ${child.exitCode}); see ${join(ctx.home, "daemon.log")}`);
    await sleep(200);
  }
  child.kill?.("SIGTERM");
  throw new Error(`the daemon did not report itself within ${Math.round(waitMs / 1000)}s; startup was cancelled; see ${join(ctx.home, "daemon.log")}`);
}

export async function up(ctx, { once = false } = {}) {
  const { home, config, gh, notify, log } = ctx;
  const existing = readDaemon(home);
  if (existing?.alive && existing.pid !== process.pid) throw new Error(`daemon already running (pid ${existing.pid})`);
  if (existing?.unverified) throw new Error(`daemon pid ${existing.pid} has an unverifiable process identity; verify and stop the older daemon before restarting`);
  const { owner, release } = acquireDaemon(home);
  let ownLogin = null;
  let timer = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    try { writeJsonAtomic(daemonPath(home), { ...readJson(daemonPath(home), {}), ...owner, stoppedAt: nowIso() }); } catch { /* exiting */ }
    try { release(); } catch { /* stale lock can be recovered next boot */ }
    process.off("SIGINT", stop); process.off("SIGTERM", stop); process.off("exit", cleanup);
  };
  const stop = () => { cleanup(); process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("exit", cleanup);
  try {
    // What code this daemon is actually running, recorded once at boot. `status` compares it with the code on disk and
    // says so when they differ: node caches modules at import, so a daemon started before an upgrade goes on executing
    // the old code with no symptom of its own. See `codeStamp` in lib/fs.mjs for the run this cost.
    const bootCode = codeStamp();
    // The live pid always wins over whatever a previous daemon left in the file.
    // Health is a convenience for `status`, not part of the loop. A home that cannot be written must not stop the
    // daemon doing the work it was started for. It matters twice over here: the recovery path below writes health
    // again from inside its own catch, so an unguarded write there would escape the handler meant to keep one bad
    // tick from killing the process.
    const health = patch => {
      try { writeJsonAtomic(daemonPath(home), { ...readJson(daemonPath(home), {}), ...patch, ...owner, login: ownLogin, stoppedAt: null, version: VERSION, code: bootCode }); }
      catch (e) { log.warn(`cannot write ${daemonPath(home)} (${e.code || e.message}); status will not see this tick`); }
    };
    health({ starting: true });
    ownLogin = await gh.user();
    const tickImpl = makeTick({ ...ctx, ownLogin });
    health({ starting: false });
    keepAwake();

    const recovered = await reconcile(ctx, ownLogin);
    if (recovered.length) log.info(`recovered ${recovered.length} PR(s)`);

    /** One tick, with every failure caught: a daemon that dies on one bad tick is worse than one that logs it. */
    const loop = async () => {
      try {
        const probes = await probeAll(ctx);
        let results = [];
        if (allOk(probes)) results = await tickImpl.tick();
        else for (const [k, p] of Object.entries(probes)) if (!p.ok) await notify.error(`${k} not ready`, `${probeFix(k, p)} (${p.detail})`);
        const errors = results.filter(r => !r.ok).length;
        health({ lastTick: nowIso(), nextTick: new Date(Date.now() + config.poll_seconds * 1000).toISOString(), probes, entries: results.length, errors });
      } catch (e) {
        log.error(`tick failed: ${e.stack || e.message}`);
        health({ lastTick: nowIso(), nextTick: new Date(Date.now() + config.poll_seconds * 1000).toISOString(), lastError: e.message });
      }
      if (once) return;
      // A referenced timer is what keeps the process alive between ticks; --once returned before scheduling one.
      timer = setTimeout(loop, config.poll_seconds * 1000);
    };
    log.info(`daemon up as ${ownLogin}, polling every ${config.poll_seconds}s`);
    await loop();
    if (once) cleanup();
  } catch (e) { cleanup(); throw e; }
}

/** On a Mac, hold off idle sleep for as long as the daemon lives. No-op elsewhere or when caffeinate is missing. */
function keepAwake() {
  if (process.platform !== "darwin") return;
  try { const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { detached: true, stdio: "ignore" }); child.on("error", () => {}); child.unref(); } catch { /* optional */ }
}
