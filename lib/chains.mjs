// Linear, operator-approved plans. The normal start/tick machinery still owns every individual run.
import { randomUUID } from "node:crypto";
import { requestFor } from "./sources/index.mjs";
import { resolveBase } from "./config.mjs";
import { entryId } from "./state.mjs";
import { branchFor } from "./git.mjs";
import { repoFromUrl } from "./gh.mjs";
import { start } from "./commands/start.mjs";
import { validateStartRequest, captureStartInput, contentDigest, checkBaseFiles } from "./start_contract.mjs";

const MAX_FAILURES = 5;
const flights = new Map();
const stamp = () => new Date().toISOString();
const validName = name => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name || "") || name.length > 80) throw new Error("chain name must be 1–80 lowercase letters, digits and single dashes");
};
const uncertain = id => `Unresolved start for ${id}. Inspect gallivant why, the runner logs and worktree before recovery; --retry never clears a start claim or launches a second process. Cancel this chain if a new plan is needed.`;

async function planStep(ctx, path, askedBase) {
  const request = await requestFor(path, ctx);
  validateStartRequest(request, ctx.config, path);
  const { base } = resolveBase({ config: ctx.config, repo: request.repo, defaultBranch: request.defaultBranch, asked: askedBase });
  if (!base) throw new Error(`no base branch for ${request.repo}`);
  const input = captureStartInput(request, base);
  return { request, input, step: {
    id: entryId(request.repo, request.id), path: request.path, checkout: request.checkout, relPath: request.relPath,
    harness: request.harness, digest: input.digest, baseFiles: {}, dispatch: null, entry: null, merged: null,
  }, repo: request.repo.toLowerCase(), base };
}

async function approveBaseFiles(ctx, plans) {
  const { repo, base } = plans[0];
  if (!await ctx.gh.branchExists(repo, base)) throw new Error(`base ${repo}:${base} is missing or GitHub is unavailable`);
  const sha = await ctx.gh.refSha(repo, base);
  if (!/^[a-f0-9]{40,64}$/.test(sha || "")) throw new Error(`GitHub did not return a base commit for ${repo}:${base}`);
  const files = new Map();
  for (const plan of plans) {
    for (const [path] of plan.input.files) {
      if (!files.has(path)) files.set(path, contentDigest(await ctx.gh.fileAtStrict(repo, path, sha)));
      plan.step.baseFiles[path] = files.get(path);
    }
  }
}

export async function queueChain(ctx, { name, paths, base = null }) {
  validName(name);
  if (!Array.isArray(paths) || paths.length < 2) throw new Error("a chain needs at least two ready PRD paths in execution order");
  const plans = [];
  for (const path of paths) plans.push(await planStep(ctx, path, base));
  const first = plans[0];
  if (plans.some(p => p.repo !== first.repo || p.base !== first.base || p.step.checkout !== first.step.checkout)) throw new Error("a chain must use one repository checkout and one base branch");
  if (new Set(plans.map(p => p.step.id)).size !== plans.length) throw new Error("a chain cannot contain duplicate PRDs");
  await approveBaseFiles(ctx, plans);
  return ctx.state.createChain({ name, repo: first.repo, base: first.base, status: "active", index: 0,
    steps: plans.map(p => p.step), reason: null, failures: 0, created_at: stamp(), updated_at: stamp() });
}

export function cancelChain(ctx, name) {
  return ctx.state.updateChain(name, c => {
    if (c.status === "done") throw new Error(`chain ${name} is already done`);
    return { status: "cancelled", reason: "Cancelled by operator; existing runs are preserved", updated_at: stamp() };
  });
}

export async function retryChain(ctx, { name, resnapshot = false }) {
  const c = ctx.state.getChain(name);
  if (!c) throw new Error(`no chain ${name}`);
  if (c.status !== "stopped") throw new Error(`chain ${name} is ${c.status}; --retry is for a stopped chain`);
  for (const step of c.steps) {
    if (ctx.state.startClaim(step.id) || (step.dispatch && !ctx.state.get(step.id))) throw new Error(uncertain(step.id));
  }
  const steps = structuredClone(c.steps);
  if (resnapshot) {
    const plans = [];
    for (let i = c.index; i < steps.length; i++) {
      if (steps[i].entry || steps[i].dispatch) continue;
      const p = await planStep(ctx, steps[i].path, c.base);
      if (p.repo !== c.repo || p.step.id !== steps[i].id || p.step.checkout !== steps[i].checkout) throw new Error("resnapshot cannot change a chain's repository or task identity");
      plans.push(p);
      steps[i] = p.step;
    }
    if (plans.length) await approveBaseFiles(ctx, plans);
  }
  return ctx.state.updateChain(name, current => {
    if (JSON.stringify(current) !== JSON.stringify(c)) throw new Error("chain changed while retrying; inspect it again");
    return { steps, status: "active", failures: 0, reason: null, updated_at: stamp() };
  });
}

// Never resurrect cancellation or apply an old tick's result to a different milestone.
function saveActive(ctx, c, patch) {
  return ctx.state.updateChain(c.name, current => current.status === "active" && current.index === c.index
    ? { ...patch, updated_at: stamp() } : {});
}

async function stop(ctx, c, reason) {
  const saved = saveActive(ctx, c, { status: "stopped", reason });
  if (saved.status !== "stopped") return;
  ctx.log.warn(`chain ${c.name}: ${reason}`);
  await ctx.notify?.error?.(`chain ${c.name} stopped`, `${reason}\nInspect: gallivant chain ${c.name}`).catch(() => {});
}

function matchesEntry(c, step, entry) {
  return entry && entry.chain?.name === c.name && entry.chain?.index === c.index && entry.chain?.dispatch === step.dispatch
    && entry.repo === c.repo && entry.base === c.base && entry.branch === branchFor(step.id.split("/").pop())
    && entry.checkout === step.checkout && entry.prd === step.relPath
    && entry.start_token && (!step.entry || step.entry.token === entry.start_token);
}

async function tickChain(ctx, c) {
  let step = c.steps[c.index];
  if (step.dispatch) {
    const entry = ctx.state.get(step.id);
    if (!matchesEntry(c, step, entry)) { await stop(ctx, c, entry ? `${step.id}: registered run identity changed; inspect before continuing` : uncertain(step.id)); return; }
    if (step.entry?.pr && entry.pr !== step.entry.pr) { await stop(ctx, c, `${step.id}: predecessor PR identity changed`); return; }
    // Capture the token immediately, and the PR identity once the normal tick discovers it.
    if (!step.entry || (!step.entry.pr && entry.pr)) {
      const steps = structuredClone(c.steps);
      steps[c.index].entry = { token: entry.start_token, pr: entry.pr || null };
      c = saveActive(ctx, c, { steps }); step = c.steps[c.index];
      if (c.status !== "active") return;
    }
    // The normal run remains the recovery surface. Never have two milestone agents mutating dependent work.
    if (!entry.pr || (entry.last?.run && entry.last.exit == null) || ctx.runnerFor(step.id).current()?.running) return;
    const pr = await ctx.gh.prView(c.repo, entry.pr);
    const identity = repoFromUrl(pr.url);
    if (identity?.repo !== c.repo || identity.number !== entry.pr || pr.number !== entry.pr
      || pr.headRefName !== entry.branch || pr.isCrossRepository !== false || pr.baseRefName !== c.base) {
      await stop(ctx, c, `${step.id}: PR identity or intended base changed`); return;
    }
    if (pr.state === "CLOSED") { await stop(ctx, c, `${step.id}: PR #${entry.pr} was closed without merging; reopen and register the PR before retrying, or cancel this chain`); return; }
    if (pr.state !== "MERGED") { if (c.failures) saveActive(ctx, c, { failures: 0, reason: null }); return; }
    const sha = pr.mergeCommit?.oid;
    if (!/^[a-f0-9]{40,64}$/.test(sha || "") || !pr.mergedAt || !await ctx.gh.containsCommit(c.repo, c.base, sha)) {
      await stop(ctx, c, `${step.id}: merge commit is missing from the intended base ${c.base}`); return;
    }
    const steps = structuredClone(c.steps);
    steps[c.index].merged = { pr: entry.pr, sha, at: pr.mergedAt };
    const index = c.index + 1;
    saveActive(ctx, c, { steps, index, status: index === steps.length ? "done" : "active", reason: null, failures: 0 });
    return; // At most one transition per chain per tick; another tick starts the successor.
  }

  if (ctx.state.get(step.id) || ctx.state.startClaim(step.id)) { await stop(ctx, c, uncertain(step.id)); return; }
  const p = await planStep(ctx, step.path, c.base);
  if (p.input.digest !== step.digest) { await stop(ctx, c, `${step.id}: queued PRD or sources changed; review them, then gallivant chain ${c.name} --retry --resnapshot`); return; }
  const after = c.steps.slice(0, c.index).map(s => s.merged?.sha);
  for (const sha of after) {
    if (!sha || !await ctx.gh.containsCommit(c.repo, c.base, sha)) { await stop(ctx, c, `predecessor merge is no longer in ${c.base}; inspect the base history`); return; }
  }
  // Fail before cloning for a normal source collision; start rechecks against the actual clone to close the race.
  const baseSha = await ctx.gh.refSha(c.repo, c.base);
  await checkBaseFiles(p.input, step.baseFiles, path => ctx.gh.fileAtStrict(c.repo, path, baseSha));
  const dispatch = randomUUID();
  c = ctx.state.updateChain(c.name, current => {
    if (current.status !== "active" || current.index !== c.index || current.steps[current.index].dispatch) return {};
    const steps = structuredClone(current.steps); steps[current.index].dispatch = dispatch;
    return { steps, updated_at: stamp() };
  });
  if (c.status !== "active" || c.steps[c.index].dispatch !== dispatch) return;
  step = c.steps[c.index];
  try {
    await start(ctx, { path: step.path, base: c.base, chain: { name: c.name, index: c.index, dispatch, digest: step.digest, baseFiles: step.baseFiles, after } });
  } catch (error) {
    const entry = ctx.state.get(step.id);
    // A post-registration failure (for example config persistence) still owns a valid run. Reconcile next tick.
    if (matchesEntry(c, step, entry)) { ctx.log.warn(`chain ${c.name}: run registered; ${error.message}`); return; }
    if (!ctx.state.startClaim(step.id)) {
      const steps = structuredClone(c.steps); steps[c.index].dispatch = null;
      c = saveActive(ctx, c, { steps });
    }
    await stop(ctx, c, `${step.id}: ${error.message}${ctx.state.startClaim(step.id) ? `\n${uncertain(step.id)}` : ""}`);
  }
}

export async function tickChains(ctx) {
  // up owns the cross-process daemon lock; this also serializes overlapping callers in tests/embedders.
  const key = ctx.state.file;
  if (flights.has(key)) return flights.get(key);
  const work = (async () => {
    const results = [];
    for (const [, chain] of ctx.state.chains()) {
      if (chain.status !== "active") continue;
      try { await tickChain(ctx, chain); results.push({ chain: chain.name, ok: true }); }
      catch (error) {
        const current = ctx.state.getChain(chain.name);
        const failures = (current.failures || 0) + 1;
        if (error.code === "CHAIN_INPUT_CHANGED") await stop(ctx, current, error.message);
        else if (failures >= MAX_FAILURES) await stop(ctx, current, `${error.message} (${failures} failed checks; retry after fixing)`);
        else saveActive(ctx, current, { failures, reason: `${error.message} (retrying ${failures}/${MAX_FAILURES})` });
        ctx.log.warn(`chain ${chain.name}: ${error.message}`);
        results.push({ chain: chain.name, ok: false, error: error.message });
      }
    }
    return results;
  })();
  flights.set(key, work);
  try { return await work; } finally { flights.delete(key); }
}

export function chainRows(ctx) {
  return ctx.state.chains().map(([name, c]) => {
    const step = c.steps[c.index], entry = step ? ctx.state.get(step.id) : null;
    return { name, status: c.status, repo: c.repo, base: c.base, completed: c.index, total: c.steps.length,
      current: step?.id || null, reason: c.reason || (c.status === "done" ? "all milestones merged" : entry ? (entry.reason || (entry.pr ? `waiting for PR #${entry.pr} to merge` : "waiting for the current run")) : "queued"),
      url: entry?.url || null };
  });
}

export function renderChains(ctx, name = null) {
  const rows = chainRows(ctx).filter(c => !name || c.name === name);
  if (name && !rows.length) throw new Error(`no chain ${name}`);
  const lines = rows.map(c => `${c.name}: ${c.status} — ${c.completed}/${c.total} merged -> ${c.repo}:${c.base}${["done", "cancelled"].includes(c.status) ? "" : ` — ${c.reason}`}`);
  if (name) {
    const c = ctx.state.getChain(name);
    c.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.id} — ${s.merged ? `merged #${s.merged.pr}` : s.dispatch ? "started" : "queued"}\n     ${s.path}`));
    if (c.status === "stopped") lines.push(`Inspect the reason, then: gallivant chain ${name} --retry`);
  }
  return lines.join("\n") || "No chains queued.";
}
