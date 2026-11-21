import { hostApi, hosts } from "../hosts.mjs";
// `gallivant up`: the daemon. Reconciles with GitHub on boot, then ticks on a setTimeout chain so ticks never
// overlap. Health is a file (daemon.json) that `status` reads; a second daemon exits when the first is alive.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeTick } from "../tick.mjs";
import { checkGh, checkHarness, probeFix } from "../probe.mjs";
import { makeProviderHealth, coordinatorHealthLimits, scheduleProviderHealth } from "../provider_health.mjs";
import { EXECUTION_LIMITS, boundedCall, recoveryDeadline, runRecoveryWork, redact } from "../execution_io.mjs";
import { coolingDown, serverRetryAt } from "../recovery_cooldown.mjs";
import { readJson, writeJsonAtomic, VERSION, codeStamp, gallivantHome } from "../fs.mjs";
import { nowIso, later } from "../time.mjs";
import { parseBlock } from "../block.mjs";
import { countRounds, lastOwnCommentAt, reviewerClock } from "../events.mjs";
import { ensurePrdSnapshot } from "../prd.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { receiptHash } from "../deliverable.mjs";
import { worktreePath, isOurBranch, prdIdFromBranch } from "../git.mjs";
import { daemonPath, readDaemon, daemonRecord, matchesProcess, assertDaemonUsable, acquireDaemon, assertUnpinnedHome } from "../daemon.mjs";
import { repositoryReviewConfig } from "../review_policy.mjs";
import { repoNames } from "../config.mjs";
import { STRUCTURAL_SCAN_SECONDS } from "../recovery_schedule.mjs";

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
  try {
    if (daemonRecord(home)?.instance !== d.instance || !matchesProcess(d)) return { stopped: false, why: "coordinator identity changed before stop" };
    process.kill(d.pid, "SIGTERM");
  }
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
async function reconcileRepository(ctx, ownLogin, work, added) {
  const { config, state, log } = ctx, { repo } = work;
  const host = hostApi(ctx);
  if (!work.candidates) {
    try { repositoryReviewConfig(config, repo, (ctx.hosts ?? hosts).select(repo).adapter); }
    catch (error) { log.warn(`reconcile ${repo}: ${error.message}`); return; }
    recoveryDeadline();
    const prs = await host.prListMine(repo);
    work.candidates = (prs || []).filter(pr => !pr.isCrossRepository && isOurBranch(pr.headRefName)).map(pr => ({ pr }));
  }
  for (; work.candidates.length; work.candidates.shift()) {
    recoveryDeadline();
    const candidate = work.candidates[0], { pr } = candidate;
    if (state.findByPr(repo, pr.number)) continue;
    const { block, reason } = parseBlock(pr.body);
    if (!block) { log.warn(`reconcile ${repo}#${pr.number}: ${reason}, ignored`); continue; }
    if (block.branch !== pr.headRefName) { log.warn(`reconcile ${repo}#${pr.number}: block branch differs from head, ignored`); continue; }
    const prdId = prdIdFromBranch(pr.headRefName);
    const id = entryId(repo, prdId);
    if (state.get(id)) { log.warn(`reconcile ${repo}#${pr.number}: id ${id} already in use, ignored`); continue; }
    const canRegister = () => {
      try { state.assertCanRegister(id); }
      catch (error) { log.warn(`reconcile ${repo}#${pr.number}: ${error.message}, ignored`); return false; }
      return true;
    };
    if (!canRegister()) continue;
    if (!candidate.feedback) {
      const [comments, login, headDate] = await Promise.allSettled([
        host.issueComments(repo, pr.number), host.userFor ? host.userFor(repo) : ownLogin, host.commitDate(repo, pr.headRefOid),
      ]);
      if (comments.status === "rejected") throw comments.reason;
      if (login.status === "rejected") throw login.reason;
      candidate.feedback = { lastOwn: lastOwnCommentAt(comments.value, login.value), iteration: countRounds(comments.value, login.value), headDate: headDate.value };
    }
    recoveryDeadline();
    await ensurePrdSnapshot(ctx, { id, repo, path: block.prd, ref: pr.headRefName });
    recoveryDeadline();
    if (state.get(id) || state.findByPr(repo, pr.number)) continue;
    const { lastOwn, iteration, headDate } = candidate.feedback;
    const entry = newEntry({ prd: block.prd, harness: block.harness, session: block.session, repo, branch: pr.headRefName, worktree: worktreePath(config, repo, prdId), pr: pr.number, url: pr.url, state: STATES.prOpen, nowIso: nowIso(), base: typeof pr.baseRefName === "string" && pr.baseRefName ? pr.baseRefName : null });
    let recoveredEntry;
    try {
      recoveredEntry = state.put(id, {
        ...entry, iteration,
        // Baseline the existing receipt and head. Failing checks on that head
        // are still eligible because recovery has no record of dispatching them.
        cursor: { since: later(lastOwn, headDate ?? pr.createdAt), dispatched: [], fixed_sha: pr.headRefOid, checks_sha: null, receipt_hash: receiptHash(pr.body) },
        // Give the reviewer the usual grace window after a coordinator outage.
        rereview: { at: reviewerClock({ config, pushedAt: later(lastOwn, pr.createdAt), floorAt: nowIso() }), nudged: false },
        last: { at: nowIso(), event: "recovered from GitHub" },
      });
    } catch (error) {
      if (!canRegister()) continue;
      throw error;
    }
    if (ctx.collaboration) {
      try { ctx.collaboration.observeEntry(id, null, recoveredEntry, { source: { type: "recovery", id: "host-reconcile" } }); }
      catch (error) { log.warn(`${id}: collaboration event capture unavailable (${error.code || "storage error"}); recovery preserved`); }
    }
    added.push(id);
    log.info(`${id}: recovered from ${pr.url}`);
  }
}

export function makeBootReconciler(ctx, ownLogin, repositories = repoNames(ctx.config)) {
  const { clock = Date, config, log } = ctx;
  const pending = repositories.map(repo => ({ repo, retryAt: 0, candidates: null }));
  // The boot sweep retains only unfinished reads. After a restart, entries
  // already committed to the registry are skipped during discovery.
  return async ({ once = false } = {}) => {
    const added = [], started = clock.now();
    for (let remaining = once ? pending.length : 1; remaining > 0; remaining--) {
      const next = pending.findIndex(work => work.retryAt <= started);
      if (next < 0) break;
      const [work] = pending.splice(next, 1);
      try { await reconcileRepository(ctx, ownLogin, work, added); }
      catch (error) {
        const budget = error.code === "RECOVERY_IO_BUDGET", time = clock.now();
        const serverAt = serverRetryAt(error, time);
        work.retryAt = Math.max(serverAt, budget ? time : time + config.poll_seconds * 1000);
        if (!budget && !coolingDown(error) && !serverAt && work.candidates?.length) {
          // A failure on one PR gets another turn after its peers.
          work.candidates.push(work.candidates.shift());
        }
        pending.push(work);
        log.warn(`reconcile ${work.repo}: ${redact(String(error.message || error.code).split("\n")[0])}, deferred`);
        if (budget) break;
      }
    }
    return added;
  };
}

export const reconcile = (ctx, ownLogin, repositories) => makeBootReconciler(ctx, ownLogin, repositories)({ once: true });

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
  assertUnpinnedHome(ctx.home);
  const existing = readDaemon(ctx.home);
  assertDaemonUsable(existing, { starting: true });
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
    assertUnpinnedHome(ctx.home);
    const d = readDaemon(ctx.home);
    assertDaemonUsable(d, { starting: true });
    if (d?.alive) return d;
    if (spawnError) throw new Error(`the daemon could not start: ${spawnError.message}; see ${join(ctx.home, "daemon.log")}`);
    if (child.exitCode !== null) throw new Error(`the daemon exited immediately (code ${child.exitCode}); see ${join(ctx.home, "daemon.log")}`);
    await sleep(200);
  }
  child.kill?.("SIGTERM");
  throw new Error(`the daemon did not report itself within ${Math.round(waitMs / 1000)}s; startup was cancelled; see ${join(ctx.home, "daemon.log")}`);
}

export async function up(ctx, { once = false } = {}) {
  const { home, config, notify, log, clock = Date } = ctx;
  const host = hostApi(ctx);
  const existing = readDaemon(home);
  if (existing?.alive && existing.pid !== process.pid) throw new Error(`daemon already running (pid ${existing.pid})`);
  if (existing?.unverified) throw new Error(`daemon pid ${existing.pid} has an unverifiable process identity; verify and stop the older daemon before restarting`);
  const { owner, release } = acquireDaemon(home);
  let ownLogin = null;
  let timer = null;
  let stopProviderHealth = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    stopProviderHealth?.(); stopProviderHealth = null;
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
    let initialFailure;
    try { ownLogin = await boundedCall(signal => host.user({ signal }), config.execution); }
    catch (error) {
      initialFailure = { ok: false, detail: redact(String(error.message).split("\n")[0]), ...(error.retryAt ? { retryAt: error.retryAt } : {}) };
      log.warn(`Initial host identity unavailable (${error.code || "read failed"}); local recovery remains scheduled`);
    }
    const providerHealth = makeProviderHealth({ home, clock, cooldowns: ctx.cooldowns, limits: coordinatorHealthLimits(config.execution), probe: (provider, account, signal) => checkHarness(provider, config, { signal }) });
    const githubHealth = makeProviderHealth({ home, file: join(home, "github-health.json"), clock,
      limits: { ...config.execution, progressMs: config.poll_seconds * 1000 },
      probe: (_provider, _account, signal) => {
        if (!initialFailure) return checkGh(host, { signal });
        const failed = initialFailure; initialFailure = null;
        return failed;
      } });
    const tickImpl = makeTick({ ...ctx, ownLogin, providerHealth });
    health({ starting: false });
    keepAwake();

    const reconcileBoot = makeBootReconciler(ctx, ownLogin);
    const tickMs = Math.min(config.poll_seconds * 1000, config.execution?.progressMs || EXECUTION_LIMITS.progressMs,
      (config.recovery_scan_seconds ?? STRUCTURAL_SCAN_SECONDS) * 1000);
    const scopes = Object.keys(config.harness).map(h => [h, config.harness[h]?.account || "operator"]);
    const providerInterval = Math.min(30_000, Math.max(1_000, Math.floor(coordinatorHealthLimits(config.execution).progressMs / 2)));
    stopProviderHealth = scheduleProviderHealth(providerHealth, scopes, { intervalMs: providerInterval, onError: e => log.warn(`provider health refresh failed: ${e.code || "check unavailable"}`) });

    /** One tick, with every failure caught: a daemon that dies on one bad tick is worse than one that logs it. */
    const loop = async () => {
      try {
        // Provider checks and GitHub/progress work use separate lanes. Failed or
        // due/pending health reads fence only that account/provider, even before
        // refresh gets a worker; the previous healthy cache cannot authorize work.
        let probes;
        const results = await tickImpl.tick({ tail: async () => {
          const reconcileRepo = async () => {
            const recovered = await runRecoveryWork(() => reconcileBoot({ once }));
            if (recovered.length) log.info(`recovered ${recovered.length} PR(s)`);
          };
          const hostAccount = ownLogin || "operator";
          const healthChecks = await Promise.allSettled([providerHealth.refresh(scopes), githubHealth.refresh([["gh", hostAccount]]), reconcileRepo()]);
          for (const outcome of healthChecks) if (outcome.status === "rejected") log.warn(`coordinator probe unavailable (${outcome.reason.code || "read failed"})`);
          probes = { gh: githubHealth.get("gh", hostAccount), ...Object.fromEntries(scopes.map(([h, a]) => [h, providerHealth.get(h, a)])) };
          for (const [k, p] of Object.entries(probes)) if (!p.ok) await notify.error(`${k} not ready`, `${probeFix(k, p)} (${p.detail})`);
        } });
        const errors = results.filter(r => !r.ok).length;
        health({ lastTick: nowIso(clock), nextTick: new Date(clock.now() + tickMs).toISOString(), probes, entries: results.length, errors,
          recoverySchedule: tickImpl.metrics });
      } catch (e) {
        log.error(`tick failed: ${e.stack || e.message}`);
        health({ lastTick: nowIso(clock), nextTick: new Date(clock.now() + tickMs).toISOString(), lastError: e.message });
      }
      if (once) return;
      // A referenced timer is what keeps the process alive between ticks; --once returned before scheduling one.
      timer = setTimeout(loop, tickMs);
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
