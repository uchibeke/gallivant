// `gallivant up`: the daemon. Reconciles with GitHub on boot, then ticks on a setTimeout chain so ticks never
// overlap. Health is a file (daemon.json) that `status` reads; a second daemon exits when the first is alive.
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeTick } from "../tick.mjs";
import { probeAll, allOk, probeFix } from "../probe.mjs";
import { readJson, writeJsonAtomic } from "../fs.mjs";
import { nowIso, later } from "../time.mjs";
import { parseBlock } from "../block.mjs";
import { countRounds, lastOwnCommentAt, reviewerClock } from "../events.mjs";
import { ensurePrdSnapshot } from "../prd.mjs";
import { newEntry, entryId, STATES } from "../state.mjs";
import { receiptHash } from "../deliverable.mjs";
import { worktreePath, isOurBranch, prdIdFromBranch } from "../git.mjs";
import { alive } from "../run.mjs";

export const daemonPath = home => join(home, "daemon.json");

export const readDaemon = home => {
  const d = readJson(daemonPath(home), null);
  return d ? { ...d, alive: alive(d.pid) } : null;
};

/**
 * Bring the registry in line with GitHub: every open PR of ours on a gallivant/* branch with a valid block is
 * watched, iteration recovered from our round comments (since the last reset comment), cursors set so history is
 * not replayed. The PRD snapshot is taken from the PR branch when the daemon has none; that copy was writable by
 * the session, which the log says. Missing checkouts are recreated lazily by the tick when a run is needed.
 */
export async function reconcile(ctx, ownLogin) {
  const { config, state, gh, log } = ctx;
  const added = [];
  for (const repo of config.repos || []) {
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
      const entry = newEntry({ prd: block.prd, harness: block.harness, session: block.session, repo, branch: pr.headRefName, worktree: worktreePath(config, repo, prdId), pr: pr.number, url: pr.url, state: STATES.prOpen, nowIso: nowIso() });
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

export async function up(ctx, { once = false } = {}) {
  const { home, config, gh, notify, log } = ctx;
  const existing = readDaemon(home);
  if (existing?.alive && existing.pid !== process.pid) throw new Error(`daemon already running (pid ${existing.pid})`);

  const ownLogin = await gh.user();
  const tickImpl = makeTick({ ...ctx, ownLogin });
  const startedAt = nowIso();
  // The live pid always wins over whatever a previous daemon left in the file.
  const health = patch => writeJsonAtomic(daemonPath(home), { ...readJson(daemonPath(home), {}), ...patch, pid: process.pid, startedAt, login: ownLogin, stoppedAt: null });
  health({});
  keepAwake();

  const recovered = await reconcile(ctx, ownLogin);
  if (recovered.length) log.info(`recovered ${recovered.length} PR(s)`);

  let timer = null;
  const stop = () => { if (timer) clearTimeout(timer); try { writeJsonAtomic(daemonPath(home), { ...readJson(daemonPath(home), {}), stoppedAt: nowIso() }); } catch { /* exiting anyway */ } process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);

  /** One tick, with every failure caught: a daemon that dies on one bad tick is worse than one that logs it. */
  const loop = async () => {
    try {
      const probes = await probeAll(ctx);
      let results = [];
      if (allOk(probes)) results = await tickImpl.tick();
      else for (const [k, p] of Object.entries(probes)) if (!p.ok) await notify.error(`${k} not ready`, `${probeFix(k)} (${p.detail})`);
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
}

/** On a Mac, hold off idle sleep for as long as the daemon lives. No-op elsewhere or when caffeinate is missing. */
function keepAwake() {
  if (process.platform !== "darwin") return;
  try { spawn("caffeinate", ["-i", "-w", String(process.pid)], { detached: true, stdio: "ignore" }).unref(); } catch { /* optional */ }
}
