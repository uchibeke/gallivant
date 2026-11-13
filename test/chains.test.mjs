// Chains exercise the real start path and persisted registry, with no GitHub or model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { makeGit } from "../lib/git.mjs";
import { queueChain, retryChain, cancelChain, tickChains, chainRows, renderChains } from "../lib/chains.mjs";
import { makeState, STATES } from "../lib/state.mjs";
import { writeJsonAtomic } from "../lib/fs.mjs";
import { start } from "../lib/commands/start.mjs";
import { makeTick } from "../lib/tick.mjs";
import { model } from "../lib/commands/status.mjs";
import { overviewWindow } from "../lib/tracker/overview.mjs";
import { CONFIG, GOOD_PRD, T0, tempHome, fakeRunner, makeClock, silentLog, fakeCredential, fakeIdentity, harnessBin, prFixture, codexLines } from "./helpers.mjs";

const REPO = "acme/widget";
const FIRST = `${REPO}/first-step`;
const SECOND = `${REPO}/second-step`;
const BASE = "a".repeat(40);
const MERGE = "b".repeat(40);

function put(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function world({ sources = false, count = 2 } = {}) {
  const home = tempHome();
  const checkout = join(home, "operator");
  const clock = makeClock();
  const snapshots = new Map(), sourceSnapshots = new Map(), runners = new Map(), prs = new Map();
  const remoteFiles = new Map();
  const clones = [], ancestry = [], kills = [];
  const names = ["first-step", "second-step", "third-step"].slice(0, count);
  const paths = names.map(name => {
    const path = join(checkout, "docs/prds", `${name}.md`);
    const body = GOOD_PRD.replace("# Widget export to CSV", `# ${name} widget export`);
    put(path, sources ? body.replace("harness: codex", "harness: codex\nsources:\n  - docs/context.md") : body);
    return path;
  });
  if (sources) put(join(checkout, "docs/context.md"), "Approved context\n");
  const runnerFor = id => {
    if (!runners.has(id)) {
      const runner = fakeRunner(clock), kill = runner.kill;
      runner.kill = run => { kills.push([id, run]); return kill(run); };
      runners.set(id, runner);
    }
    return runners.get(id);
  };
  const ctx = {
    home,
    clock,
    ownLogin: "me",
    config: { ...CONFIG, home, worktrees: join(home, "worktrees"), harness: { codex: { bin: harnessBin(home, "codex") } } },
    state: makeState(home),
    log: silentLog,
    credential: fakeCredential(),
    identity: fakeIdentity(),
    runnerFor,
    readPrd: id => snapshots.get(id) ?? null,
    writePrd: (id, text) => snapshots.set(id, text),
    readSource: (id, rel) => sourceSnapshots.get(`${id}:${rel}`) ?? null,
    writeSource: (id, rel, text) => sourceSnapshots.set(`${id}:${rel}`, text),
    gh: {
      repoInfo: async () => ({ nameWithOwner: REPO, defaultBranch: "main" }),
      repoDefaultBranch: async () => "main",
      branchExists: async () => true,
      ensureLabels: async () => {},
      refSha: async () => BASE,
      fileAtStrict: async (_repo, path) => remoteFiles.get(path) ?? null,
      containsCommit: async (repo, base, sha) => { ancestry.push([repo, base, sha]); return true; },
      prView: async (_repo, pr) => {
        assert.ok(prs.has(pr), `test must supply PR ${pr}`);
        return prs.get(pr);
      },
    },
    git: {
      toplevel: async () => checkout,
      create: async spec => {
        clones.push(spec);
        const worktree = join(home, "worktrees", spec.nameWithOwner, spec.prdId);
        mkdirSync(worktree, { recursive: true });
        for (const [rel, text] of remoteFiles) put(join(worktree, rel), text);
        return worktree;
      },
      containsCommit: async (_dir, sha) => { ancestry.push(["clone", sha]); return true; },
      fileAt: async (_dir, _ref, path) => remoteFiles.get(path) ?? null,
    },
  };
  const markPr = (id = FIRST, { number = 1, state = "OPEN", entryState = STATES.ready, ...over } = {}) => {
    const entry = ctx.state.get(id);
    assert.ok(entry, `entry ${id} must have started`);
    runnerFor(id).finish(codexLines(), { exit: 0 });
    ctx.state.update(id, { pr: number, url: `https://github.com/${REPO}/pull/${number}`, state: entryState, last: { ...entry.last, exit: 0 } });
    prs.set(number, prFixture({
      number, url: `https://github.com/${REPO}/pull/${number}`, headRefName: entry.branch,
      state, mergeCommit: state === "MERGED" ? { oid: MERGE } : null,
      mergedAt: state === "MERGED" ? T0 : null, ...over,
    }));
  };
  const queue = (name = "release", chosen = paths) => queueChain(ctx, { name, paths: chosen });
  const starts = () => [...runners.values()].reduce((n, r) => n + r.started.length, 0);
  return { ctx, home, checkout, paths, clones, runners, remoteFiles, snapshots, sourceSnapshots, prs, ancestry, kills, markPr, queue, starts };
}

async function anchoredWorld(options = {}) {
  const w = world(options);
  await start(w.ctx, { path: w.paths[0] });
  w.markPr();
  w.anchor = selector => queueChain(w.ctx, { name: "follow-on", paths: w.paths.slice(1), after: selector ?? `${REPO}#1` });
  return w;
}

test("an existing registered PR gates one new milestone without adopting or restarting its run", async () => {
  const w = await anchoredWorld();
  const predecessor = w.ctx.state.get(FIRST);
  await w.anchor(predecessor.url);
  assert.equal(w.ctx.state.getChain("follow-on").steps.length, 1);
  await tickChains(w.ctx);
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "ready with an open PR cannot start its successor");
  assert.deepEqual(w.ctx.state.get(FIRST), predecessor, "ownership, session, review policy and counters stay untouched");
  const row = chainRows(w.ctx)[0];
  assert.equal(row.current, FIRST);
  assert.equal(row.url, predecessor.url);
  assert.match(row.reason, /predecessor PR #1/);
  assert.match(renderChains(w.ctx, "follow-on"), /after acme\/widget\/first-step/);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "merge observation and dispatch are separate ticks");
  assert.equal(w.ctx.state.getChain("follow-on").after.merged.sha, MERGE);
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
  assert.equal(w.ctx.state.get(SECOND).chain.index, 0);
  assert.ok(w.ancestry.some(call => call[0] === REPO && call.includes(MERGE)));
  assert.ok(w.ancestry.some(call => call[0] === "clone" && call.includes(MERGE)));
  w.markPr(SECOND, { number: 2, state: "MERGED", entryState: STATES.done });
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("follow-on").status, "done");
  assert.equal(w.starts(), 2);
});

test("a chain can depend on an existing owned milestone without stealing its original ownership", async () => {
  const w = world({ count: 3 });
  await w.queue("original", w.paths.slice(0, 2));
  await tickChains(w.ctx);
  w.markPr();
  const before = w.ctx.state.get(FIRST);
  await queueChain(w.ctx, { name: "follow-on", paths: [w.paths[2]], after: FIRST });
  await tickChains(w.ctx);
  assert.deepEqual(w.ctx.state.get(FIRST), before);
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.getChain("original").steps[0].id, FIRST);
  assert.equal(w.ctx.state.getChain("follow-on").steps[0].id, `${REPO}/third-step`);
  const summary = model(w.ctx), task = summary.needs_you.find(row => row.id === FIRST);
  assert.deepEqual(task.presentation.chains.map(c => [c.name, c.position, c.predecessor]), [["original", 1, false], ["follow-on", null, true]]);
  assert.equal(task.presentation.chain.name, "original", "the owned milestone remains the primary association");
  for (const chain of ["original", "follow-on"]) assert.equal(overviewWindow(summary, { chain }).rows[0].id, FIRST);
  assert.equal(overviewWindow(summary, { q: "follow-on" }).rows[0].id, FIRST);
  assert.deepEqual(w.ctx.state.get(FIRST), before, "reading associations cannot transfer ownership");
});

test("a repaired merged predecessor cannot release its successor without new-head completion evidence", async () => {
  const w = await anchoredWorld();
  await w.anchor();
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.prOpen });
  w.ctx.state.update(FIRST, { base_repair: { status: "verified" }, completionEvidence: { integration: { qualified: false } } });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.getChain("follow-on").status, "stopped");
  assert.match(w.ctx.state.getChain("follow-on").reason, /qualified new-head completion/);
  w.ctx.state.update(FIRST, { state: STATES.done, completionEvidence: { integration: { qualified: true, head: w.prs.get(1).headRefOid } } });
  await retryChain(w.ctx, { name: "follow-on" });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "merge observation and successor dispatch stay separate");
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
});

test("status preserves a pending predecessor until merge and then shows successor positions", async () => {
  const w = await anchoredWorld({ count: 3 });
  await w.anchor();
  const saved = readFileSync(w.ctx.state.file, "utf8");
  let summary = model(w.ctx);
  const predecessor = summary.needs_you.find(row => row.id === FIRST);
  assert.deepEqual(predecessor.presentation.chain, { name: "follow-on", status: "active", total: 2, position: null, predecessor: true });
  assert.equal(overviewWindow(summary, { chain: "follow-on" }).matched, 1);
  assert.equal(readFileSync(w.ctx.state.file, "utf8"), saved);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  await tickChains(w.ctx);
  summary = model(w.ctx);
  assert.equal(summary.done.find(row => row.id === FIRST).presentation.chain, null);
  assert.equal(overviewWindow(summary, { chain: "follow-on" }).matched, 0);
  await tickChains(w.ctx);
  summary = model(w.ctx);
  const successor = summary.running.find(row => row.id === SECOND);
  assert.deepEqual(successor.presentation.chain, { name: "follow-on", status: "active", total: 2, position: 1, predecessor: false });
  assert.equal(overviewWindow(summary, { chain: "follow-on" }).rows[0].id, SECOND);
});

test("queueing after a PR refuses unknown, cross-base, changed remote and closed identities", async () => {
  for (const change of [
    w => w.ctx.state.remove(FIRST),
    w => w.ctx.state.update(FIRST, { base: "other" }),
    w => w.prs.set(1, { ...w.prs.get(1), headRefName: "replacement" }),
    w => w.prs.set(1, { ...w.prs.get(1), state: "CLOSED" }),
  ]) {
    const w = await anchoredWorld();
    change(w);
    await assert.rejects(() => w.anchor());
    assert.equal(w.ctx.state.chains().length, 0);
    assert.equal(w.starts(), 1);
  }
  const w = await anchoredWorld();
  await assert.rejects(() => w.anchor(`https://github.com/${REPO}/pull/999`), /registered/);
  await assert.rejects(() => w.anchor(""), /requires a registered/);
  await assert.rejects(() => queueChain(w.ctx, { name: "empty", paths: [], after: FIRST }), /at least one/);
  await assert.rejects(() => queueChain(w.ctx, { name: "duplicate", paths: [w.paths[0]], after: FIRST }), /already exists/);
});

test("local or remote predecessor identity changes fail closed, including after its merge was recorded", async () => {
  const changes = [
    w => w.ctx.state.remove(FIRST),
    ...[{ branch: "work/replacement" }, { base: "other" }, { pr: 9 }, { url: `https://github.com/${REPO}/pull/9` }, { repo: "acme/other", url: "https://github.com/acme/other/pull/1" }]
      .map(patch => w => w.ctx.state.update(FIRST, patch)),
  ];
  for (const merged of [false, true]) for (const change of changes) {
    const w = await anchoredWorld();
    await w.anchor();
    if (merged) { w.markPr(FIRST, { state: "MERGED" }); await tickChains(w.ctx); }
    change(w);
    await tickChains(w.ctx);
    assert.equal(w.ctx.state.getChain("follow-on").status, "stopped");
    assert.equal(w.starts(), 1);
  }
  for (const patch of [
    { state: "CLOSED" }, { number: 9 }, { headRefName: "other" }, { baseRefName: "other" },
    { url: `https://github.com/acme/other/pull/1` }, { url: "not a URL" }, { isCrossRepository: true },
    { mergeCommit: null }, { mergedAt: null }, { strictIdentity: true, headRefOid: "different" },
  ]) {
    const w = await anchoredWorld();
    await w.anchor();
    w.markPr(FIRST, { state: "MERGED", ...patch });
    await tickChains(w.ctx);
    assert.equal(w.ctx.state.getChain("follow-on").status, "stopped", JSON.stringify(patch));
    assert.equal(w.starts(), 1);
  }
});

test("a merged anchor still waits for an active author and uses the strict host head contract", async () => {
  const w = await anchoredWorld();
  await w.anchor();
  w.markPr(FIRST, { state: "MERGED", strictIdentity: true });
  w.ctx.state.update(FIRST, e => ({ cursor: { ...e.cursor, fixed_sha: w.prs.get(1).headRefOid }, last: { ...e.last, exit: null } }));
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("follow-on").after.merged, null);
  w.ctx.state.update(FIRST, e => ({ last: { ...e.last, exit: 0 } }));
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
});

test("remote ancestry loss and stale successor clones cannot satisfy the existing-PR dependency", async () => {
  for (const stage of ["observation", "dispatch", "clone"]) {
    const w = await anchoredWorld();
    await w.anchor();
    w.markPr(FIRST, { state: "MERGED" });
    if (stage !== "observation") await tickChains(w.ctx);
    if (stage === "clone") w.ctx.git.containsCommit = async () => false;
    else w.ctx.gh.containsCommit = async () => false;
    await tickChains(w.ctx);
    assert.equal(w.ctx.state.getChain("follow-on").status, "stopped", stage);
    assert.equal(w.starts(), 1);
    assert.equal(w.ctx.state.get(SECOND), null);
  }
});

test("predecessor changes during queueing or clone preparation cannot race the identity pins", async () => {
  const queued = await anchoredWorld();
  const read = queued.ctx.gh.fileAtStrict;
  queued.ctx.gh.fileAtStrict = async (...args) => { queued.ctx.state.update(FIRST, { branch: "other" }); return read(...args); };
  await assert.rejects(() => queued.anchor(), /predecessor identity changed/);
  assert.equal(queued.ctx.state.chains().length, 0);

  const w = await anchoredWorld();
  await w.anchor();
  w.markPr(FIRST, { state: "MERGED" });
  await tickChains(w.ctx);
  const create = w.ctx.git.create;
  w.ctx.git.create = async spec => { const dir = await create(spec); w.ctx.state.update(FIRST, { branch: "other" }); return dir; };
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("follow-on").status, "stopped");
  assert.equal(w.starts(), 1, "lock-time validation prevents spawning after the asynchronous clone");
});

test("resnapshot only reapproves future inputs and cancellation cannot be undone by a pending merge check", async () => {
  const w = await anchoredWorld();
  await w.anchor();
  const before = w.ctx.state.getChain("follow-on");
  put(w.paths[1], readFileSync(w.paths[1], "utf8") + "\nUpdated successor instructions.\n");
  await retryChain(w.ctx, { name: "follow-on", resnapshot: true });
  const after = w.ctx.state.getChain("follow-on");
  assert.deepEqual(after.after, before.after);
  assert.notEqual(after.steps[0].digest, before.steps[0].digest);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  w.markPr(FIRST, { state: "MERGED" });
  const view = w.ctx.gh.prView;
  w.ctx.gh.prView = async (...args) => { cancelChain(w.ctx, "follow-on"); return view(...args); };
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("follow-on").status, "cancelled");
  assert.equal(w.ctx.state.getChain("follow-on").after.merged, null);
  assert.equal(w.starts(), 1);
});

test("queue approves a plan without starting work; ticks start its first PRD exactly once across registry reloads", async () => {
  const w = world();
  await w.queue();
  assert.equal(w.starts(), 0);
  assert.equal(w.clones.length, 0);
  assert.equal(w.ctx.state.getChain("release").steps.length, 2);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.ok(w.ctx.state.get(FIRST));
  assert.equal(w.ctx.state.get(SECOND), null);
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "daemon reload cannot dispatch the same approved step twice");
  assert.equal(w.clones.length, 1);
});

test("Bitbucket rate limiting pauses a queued chain without consuming its failure budget", async () => {
  const w = world();
  await w.queue();
  w.ctx.gh.refSha = async () => {
    const error = new Error("Bitbucket API rate limited");
    error.code = "BB_RATE_LIMIT";
    throw error;
  };
  await tickChains(w.ctx);
  const paused = w.ctx.state.getChain("release");
  assert.equal(paused.status, "active");
  assert.equal(paused.failures, 0);
  assert.ok(Date.parse(paused.rateLimitUntil) > Date.now() + 10 * 60_000);
  for (let i = 0; i < 6; i++) await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "active");
  assert.equal(w.starts(), 0);
});

test("an active legacy-prefix milestone survives upgrade and its neutral-prefix successor still waits for merge", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  const original = w.ctx.state.get(FIRST);
  // Persist the identity an older release actually wrote, then reconstruct the registry as on daemon upgrade.
  w.ctx.state.update(FIRST, { branch: "gallivant/first-step" });
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "active", "legacy naming is not an identity change");
  assert.equal(w.ctx.state.getChain("release").steps[0].entry.token, original.start_token);
  assert.equal(w.starts(), 1, "no duplicate process is launched during adoption");
  assert.equal(w.ctx.state.get(FIRST).branch, "gallivant/first-step", "the live branch is not renamed");
  w.markPr(FIRST, { state: "OPEN", entryState: STATES.ready });
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").index, 0);
  assert.equal(w.ctx.state.get(SECOND), null, "ready is still not a predecessor merge");
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "merge observation and successor launch remain separate transitions");
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
  assert.equal(w.ctx.state.get(SECOND).branch, "work/second-step", "new milestones use the neutral convention");
  assert.equal(w.ctx.state.get(FIRST).branch, "gallivant/first-step");
  assert.equal(w.ctx.state.get(FIRST).start_token, original.start_token);
  assert.ok(w.ancestry.some(call => call.includes(MERGE)), "the confirmed merge must still belong to the approved base");
  assert.deepEqual(w.kills, []);
});

test("two schedulers sharing persisted state cannot both clone or start the same queued milestone", async () => {
  const w = world();
  await w.queue();
  const other = { ...w.ctx, state: makeState(w.home) };
  await Promise.all([tickChains(w.ctx), tickChains(other)]);
  await tickChains(w.ctx);
  assert.equal(w.clones.length, 1);
  assert.equal(w.starts(), 1);
  assert.ok(w.ctx.state.get(FIRST));
});

test("a manual start cannot bypass the predecessor gate for a reserved successor", async () => {
  const w = world();
  await w.queue();
  await assert.rejects(() => start(w.ctx, { path: w.paths[1] }), /chain|reserved|claim/i);
  assert.equal(w.clones.length, 0);
  assert.equal(w.starts(), 0);
});

test("ready-for-human, a stopped agent and a local done label cannot unlock the successor of an OPEN PR", async () => {
  for (const entryState of [STATES.ready, STATES.prOpen, STATES.done]) {
    const w = world();
    await w.queue();
    await tickChains(w.ctx);
    w.markPr(FIRST, { entryState });
    await tickChains(w.ctx);
    await tickChains(w.ctx);
    assert.equal(w.starts(), 1, `${entryState} is not integration approval`);
    assert.equal(w.ctx.state.get(SECOND), null);
  }
});

test("closing without merging stops the chain instead of treating done as successful completion", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  w.markPr(FIRST, { state: "CLOSED", entryState: STATES.done });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
  assert.match(w.ctx.state.getChain("release").reason, /closed|unmerged|not merged/i);
});

test("confirmed merge on the intended base starts the next PRD once and finishes only after its merge", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
  assert.equal(w.ctx.state.get(SECOND).base, "main");
  assert.deepEqual(w.clones.map(c => c.base), ["main", "main"]);
  assert.ok(w.ancestry.some(call => call.includes(MERGE)), "the merge must be reachable, not just reported by an old PR");
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 2);
  w.markPr(SECOND, { number: 2, state: "OPEN" });
  await tickChains(w.ctx);
  assert.notEqual(w.ctx.state.getChain("release").status, "done");
  w.markPr(SECOND, { number: 2, state: "MERGED", entryState: STATES.done, mergeCommit: { oid: "c".repeat(40) } });
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "done");
  assert.equal(w.starts(), 2);
});

test("merge into another base, another repository, or from another branch never approves a successor", async () => {
  for (const wrong of [
    { baseRefName: "staging" },
    { url: "https://github.com/acme/elsewhere/pull/1" },
    { headRefName: "some-other-feature" },
    { isCrossRepository: true },
  ]) {
    const w = world();
    await w.queue();
    await tickChains(w.ctx);
    w.markPr(FIRST, { state: "MERGED", entryState: STATES.done, ...wrong });
    await tickChains(w.ctx);
    assert.equal(w.starts(), 1, JSON.stringify(wrong));
    assert.equal(w.ctx.state.getChain("release").status, "stopped");
  }
});

test("a reported merge missing from the remote base cannot start downstream work", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  w.ctx.gh.containsCommit = async () => false;
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.equal(w.clones.length, 1);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
});

test("MERGED without a usable merge commit does not authorize a successor", async () => {
  for (const mergeCommit of [null, { oid: "" }, { oid: "not-a-commit" }]) {
    const w = world();
    await w.queue();
    await tickChains(w.ctx);
    w.markPr(FIRST, { state: "MERGED", entryState: STATES.done, mergeCommit });
    await tickChains(w.ctx);
    assert.equal(w.starts(), 1);
    assert.equal(w.ctx.state.getChain("release").status, "stopped");
  }
});

test("fresh clone must contain the accepted predecessor merge even if the remote check passed", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  w.ctx.git.containsCommit = async () => false;
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1, "a race or stale clone cannot run on a base missing approved work");
  assert.equal(w.ctx.state.get(SECOND), null);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
});

test("edited queued PRD or carried source stops before the next clone; it is never silently reapproved", async () => {
  for (const source of [false, true]) {
    const w = world({ sources: source });
    await w.queue();
    const changed = source ? join(w.checkout, "docs/context.md") : w.paths[0];
    put(changed, readFileSync(changed, "utf8") + "\nThe operator changed this after queuing.\n");
    await tickChains(w.ctx);
    assert.equal(w.starts(), 0);
    assert.equal(w.clones.length, 0);
    assert.equal(w.ctx.state.getChain("release").status, "stopped");
  }
});

test("a predecessor's changes to a carried file are preserved rather than overwritten by the queued source", async () => {
  const w = world({ sources: true });
  w.remoteFiles.set("docs/context.md", "Approved context\n");
  await w.queue();
  await tickChains(w.ctx);
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
  w.remoteFiles.set("docs/context.md", "New content accepted in the predecessor merge\n");
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
  const successorFile = join(w.home, "worktrees", REPO, "second-step", "docs/context.md");
  if (existsSync(successorFile)) assert.equal(readFileSync(successorFile, "utf8"), w.remoteFiles.get("docs/context.md"));
});

test("cancel stops future dispatch without killing or changing an already running milestone", async () => {
  const w = world();
  await w.queue();
  await tickChains(w.ctx);
  const before = w.ctx.state.get(FIRST);
  cancelChain(w.ctx, "release");
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "cancelled");
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.runnerFor(FIRST).current().running, true);
  assert.deepEqual(w.ctx.state.get(FIRST), before);
  assert.deepEqual(w.kills, []);
});

test("cancellation while cloning prevents a queued milestone from spawning after the clone returns", async () => {
  const w = world();
  await w.queue();
  const clone = w.ctx.git.create;
  let entered, release;
  const cloning = new Promise(resolve => { entered = resolve; });
  const finish = new Promise(resolve => { release = resolve; });
  w.ctx.git.create = async spec => { entered(); await finish; return clone(spec); };
  const tick = tickChains(w.ctx);
  await cloning;
  cancelChain(w.ctx, "release");
  release();
  await tick;
  assert.equal(w.starts(), 0);
  assert.equal(w.ctx.state.get(FIRST), null);
  assert.equal(w.ctx.state.getChain("release").status, "cancelled");
  assert.deepEqual(w.kills, []);
});

test("only fresh, unique PRDs may be queued and active plans cannot overlap", async () => {
  const duplicate = world();
  await assert.rejects(() => duplicate.queue("duplicate", [duplicate.paths[0], duplicate.paths[0]]), /duplicate|same|twice/i);
  assert.equal(duplicate.ctx.state.chains().length, 0);

  const existing = world();
  await start(existing.ctx, { path: existing.paths[0] });
  await assert.rejects(() => existing.queue(), /already|exist|fresh/i);
  assert.equal(existing.ctx.state.chains().length, 0);

  const overlap = world({ count: 3 });
  await overlap.queue("one", overlap.paths.slice(0, 2));
  await assert.rejects(() => overlap.queue("two", overlap.paths.slice(1)), /already|overlap|chain|reserved/i);
  assert.equal(overlap.ctx.state.chains().length, 1);
  assert.equal(overlap.starts(), 0);
});

test("queue validates every step before recording a plan", async () => {
  for (const change of [
    w => put(w.paths[1], GOOD_PRD.replace("status: ready", "status: draft")),
    w => put(w.paths[1], "# Not a valid brief\n"),
    w => { let count = 0; w.ctx.gh.repoInfo = async () => ({ nameWithOwner: ++count === 1 ? REPO : "acme/other", defaultBranch: "main" }); },
    w => { w.ctx.gh.branchExists = async () => false; },
  ]) {
    const w = world();
    change(w);
    await assert.rejects(() => w.queue());
    assert.equal(w.ctx.state.chains().length, 0);
    assert.equal(w.clones.length, 0);
    assert.equal(w.starts(), 0);
  }
  const w = world();
  await assert.rejects(() => w.queue("only-one", w.paths.slice(0, 1)), /two|2|at least/i);
});

test("replacing a pinned entry's branch or start token cannot substitute other work as the approved milestone", async () => {
  for (const changed of [
    { branch: "gallivant/replacement" }, { branch: "work/replacement" }, { branch: "feature/first-step" },
    { branch: "gallivant/first-step/extra" }, { branch: "work/first-step-extra" }, { start_token: "replacement-start" },
  ]) {
    const w = world();
    await w.queue();
    await tickChains(w.ctx);
    await tickChains(w.ctx);
    w.ctx.state.update(FIRST, changed);
    w.markPr(FIRST, { state: "MERGED", entryState: STATES.done });
    await tickChains(w.ctx);
    assert.equal(w.starts(), 1);
    assert.equal(w.ctx.state.getChain("release").status, "stopped");
  }
});

test("an active chain can refresh future briefs without restarting its current job or bypassing merge", async () => {
  const w=world();await w.queue();await tickChains(w.ctx);
  const before=w.ctx.state.getChain("release"), first=w.ctx.state.get(FIRST);
  put(w.paths[1],readFileSync(w.paths[1],"utf8").replace("# second-step widget export", "# second-step revised export"));
  await retryChain(w.ctx,{name:"release",resnapshot:true});
  const after=w.ctx.state.getChain("release");assert.equal(after.status,"active");assert.equal(after.index,0);
  assert.deepEqual(after.steps[0],before.steps[0]);assert.notEqual(after.steps[1].digest,before.steps[1].digest);
  assert.equal(w.ctx.state.get(FIRST).start_token,first.start_token);await tickChains(w.ctx);
  assert.equal(w.starts(),1);assert.equal(w.ctx.state.get(SECOND),null);
});

test("retrying a changed queued brief requires explicit resnapshot and starts it once after acceptance", async () => {
  const w = world();
  await w.queue();
  put(w.paths[0], readFileSync(w.paths[0], "utf8") + "\nUpdated operator instructions.\n");
  await tickChains(w.ctx);
  await retryChain(w.ctx, { name: "release" });
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
  assert.equal(w.starts(), 0);
  await retryChain(w.ctx, { name: "release", resnapshot: true });
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.equal(w.snapshots.get(FIRST), readFileSync(w.paths[0], "utf8"));
});

test("ambiguous spawn failure retains its claim across reload and retry cannot duplicate the dispatch", async () => {
  const w = world();
  await w.queue();
  const runner = w.ctx.runnerFor(FIRST), spawn = runner.start;
  runner.start = async (...args) => { await spawn(...args); throw new Error("lost connection after child might have started"); };
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.ok(w.ctx.state.startClaim(FIRST));
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  await assert.rejects(() => retryChain(w.ctx, { name: "release", resnapshot: true }), /claim|ambiguous|dispatch|inspect|start/i);
  await tickChains(w.ctx);
  assert.equal(w.clones.length, 1);
  assert.equal(w.starts(), 1);
  assert.ok(w.ctx.state.startClaim(FIRST), "operator retry is not permission to forget an uncertain start");
});

test("failure after persisting the started entry reconciles its existing run instead of dispatching again", async () => {
  const w = world();
  await w.queue();
  const persist = w.ctx.state.putStarted;
  w.ctx.state.putStarted = (...args) => { persist(...args); throw new Error("post-registration bookkeeping failed"); };
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
  assert.ok(w.ctx.state.get(FIRST));
  w.ctx.state = makeState(w.home);
  await tickChains(w.ctx);
  await tickChains(w.ctx);
  assert.equal(w.clones.length, 1);
  assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.getChain("release").status, "active");
});

test("chain post-clone base refusal retains dispatch and start ownership across reload and retry", async () => {
  const w=world({sources:true});await w.queue();
  w.ctx.git.fileAt=async (_dir,_ref,path)=>{if(path==="docs/context.md")throw Error("Base source changed into a symlink");return null;};
  await tickChains(w.ctx);
  const chain=w.ctx.state.getChain("release"),claim=w.ctx.state.startClaim(FIRST);
  assert.equal(chain.status,"stopped");assert.match(chain.reason,/Base source changed into a symlink/);assert.ok(chain.steps[0].dispatch);
  assert.equal(claim.clone.worktree,join(w.home,"worktrees",FIRST));assert.equal(w.clones.length,1);assert.equal(w.starts(),0);
  w.ctx.state=makeState(w.home);await assert.rejects(()=>retryChain(w.ctx,{name:"release"}),/start|claim|inspect/i);await tickChains(w.ctx);
  assert.deepEqual(w.ctx.state.startClaim(FIRST),claim);assert.equal(w.clones.length,1);assert.equal(w.starts(),0);
});

test("chain known create refusal releases start and dispatch ownership for an explicit corrected retry", async () => {
  const w = world(), path = join(w.home, "worktrees", FIRST); let clones = 0;
  mkdirSync(join(path, ".git"), { recursive: true }); writeFileSync(join(path, "stale-evidence"), "retained operator files");
  w.ctx.git.create = makeGit({ config: w.ctx.config, exec: async (cmd, args) => {
    if (cmd === "git" && args[0] === "clone") { clones++; mkdirSync(join(args.at(-1), ".git"), { recursive: true }); }
    return { stdout: args[0] === "remote" ? "https://github.com/acme/widget.git" : "" };
  } }).create;
  await w.queue(); await tickChains(w.ctx);
  const stopped = w.ctx.state.getChain("release");
  assert.equal(stopped.status, "stopped"); assert.match(stopped.reason, /worktree already exists/);
  assert.equal(stopped.steps[0].dispatch, null); assert.equal(w.ctx.state.startClaim(FIRST), null);
  assert.equal(clones, 0); assert.equal(w.starts(), 0); assert.equal(readFileSync(join(path, "stale-evidence"), "utf8"), "retained operator files");
  rmSync(path, { recursive: true }); w.ctx.state = makeState(w.home);
  await retryChain(w.ctx, { name: "release" }); await tickChains(w.ctx); await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "active"); assert.equal(clones, 1); assert.equal(w.starts(), 1);
  assert.equal(w.ctx.state.startClaim(FIRST), null); assert.equal(w.ctx.state.get(FIRST).chain.name, "release");
});

test("transient GitHub failures retry without dispatch, eventually stop, and recover through explicit retry", async () => {
  const w = world();
  await w.queue();
  w.ctx.gh.refSha = async () => { throw new Error("GitHub unavailable"); };
  await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "active");
  assert.match(w.ctx.state.getChain("release").reason, /retry/i);
  for (let i = 0; i < 4; i++) await tickChains(w.ctx);
  assert.equal(w.ctx.state.getChain("release").status, "stopped");
  assert.equal(w.clones.length, 0);
  assert.equal(w.starts(), 0);
  w.ctx.gh.refSha = async () => BASE;
  await retryChain(w.ctx, { name: "release" });
  await tickChains(w.ctx);
  assert.equal(w.starts(), 1);
});

test("status names the chain and its waiting milestone without creating a run", async () => {
  const w = world();
  await w.queue();
  const rows = chainRows(w.ctx);
  assert.equal(rows.length, 1);
  assert.match(JSON.stringify(rows), /release/);
  assert.match(renderChains(w.ctx, "release"), /release/);
  assert.match(renderChains(w.ctx, "release"), /first-step/);
  assert.equal(w.starts(), 0);
});

test("the normal daemon tick settles entries before advancing their chains and dispatches the successor", async () => {
  const w = world();
  await w.queue();
  const daemon = makeTick(w.ctx);
  await daemon.tick();
  assert.equal(w.starts(), 1, "a queued chain is picked up through the existing daemon loop");
  w.markPr(FIRST, { state: "MERGED", entryState: STATES.ready });
  let observedSettled = false;
  w.ctx.gh.containsCommit = async () => {
    assert.equal(w.ctx.state.get(FIRST).state, STATES.done, "normal entry processing runs before dependent scheduling");
    observedSettled = true;
    return true;
  };
  w.ctx.clock.advance(CONFIG.poll_seconds / 60);
  await daemon.tick();
  assert.equal(observedSettled, true);
  w.ctx.clock.advance(CONFIG.poll_seconds / 60);
  await daemon.tick();
  assert.equal(w.starts(), 2);
  assert.equal(w.ctx.state.get(SECOND).state, STATES.running);
});

test("fast progress ticks retain chain review cadence, bound outage retries and reconcile on restart", async t => {
  const w = world(); let progress = 0, reads = 0;
  w.ctx.executionFor = id => ({ ...w.ctx.runnerFor(id), reconcile: async () => { progress++; } });
  await w.queue(); const tick = makeTick(w.ctx); await tick.tick();
  w.markPr(FIRST, { entryState: STATES.done });
  const prView = w.ctx.gh.prView;
  w.ctx.gh.prView = async (...args) => { reads++; return prView(...args); };
  w.ctx.clock.advance(2); await tick.tick(); assert.equal(reads, 1);
  for (let i = 0; i < 11; i++) { w.ctx.clock.advance(1 / 6); await tick.tick(); }
  assert.equal(reads, 1); assert.equal(w.starts(), 1); assert.ok(progress >= 12);
  w.ctx.clock.advance(1 / 6); await tick.tick(); assert.equal(reads, 2);
  w.ctx.gh.prView = async () => { reads++; throw new Error("GitHub offline"); };
  w.ctx.clock.advance(2); await tick.tick(); assert.equal(w.ctx.state.getChain("release").failures, 1);
  for (let i = 0; i < 11; i++) { w.ctx.clock.advance(1 / 6); await tick.tick(); }
  assert.equal(reads, 3); assert.equal(w.ctx.state.getChain("release").failures, 1);
  w.ctx.clock.advance(1 / 6); await tick.tick(); assert.equal(reads, 4); assert.equal(w.ctx.state.getChain("release").failures, 2);
  w.ctx.gh.prView = async (...args) => { reads++; return prView(...args); };
  await makeTick(w.ctx).tick(); assert.equal(reads, 5); assert.equal(w.ctx.state.getChain("release").failures, 0);
  assert.equal(w.starts(), 1, "restart inspects the owned chain without redispatching");
  const evidence = join(w.home, "scheduler-chain-evidence.json");
  writeJsonAtomic(evidence, { kind: "Offline chain fixture; no live qualification", reviewMs: CONFIG.poll_seconds * 1000,
    progressMs: 10_000, progress, chainReads: reads, startedRuns: w.starts(), statePath: w.ctx.state.file,
    chain: { status: w.ctx.state.getChain("release").status, index: w.ctx.state.getChain("release").index, failures: w.ctx.state.getChain("release").failures } });
  t.diagnostic(`scheduler chain evidence: ${evidence}`);
});

test("reviewed retry binds candidate bytes, base files and chain identity without accepting changes", async () => {
  const { chainRevision, reviewChainRetry } = await import("../lib/chains.mjs");
  const { chainControl } = await import("../lib/tracker/chain_controls.mjs");
  const w = world({ sources: true });
  await w.queue();
  w.ctx.state.updateChain("release", { status: "stopped", reason: "sources changed" });
  put(join(w.checkout, "docs/context.md"), "Reviewed updated context\n");
  const before = w.ctx.state.getChain("release");
  const review = await chainControl(w.ctx, "release", { stage: "review", action: "resnapshot", revision: chainRevision(before), requestId: "chain-review-123" });
  assert.deepEqual(w.ctx.state.getChain("release"), before);
  assert.notEqual(review.differences[0].fingerprint.before, review.differences[0].fingerprint.after);
  const sourceDiff = review.differences[0].files.find(f => f.path === "docs/context.md");
  assert.notEqual(sourceDiff.inputBefore, sourceDiff.inputAfter);
  assert.doesNotMatch(JSON.stringify(review), /Reviewed updated context|operator\//);
  put(join(w.checkout, "docs/context.md"), "Changed after review\n");
  await assert.rejects(chainControl(w.ctx, "release", { stage: "confirm", action: "resnapshot", revision: review.revision, requestId: review.requestId }), /inputs changed after review/);
  assert.deepEqual(w.ctx.state.getChain("release"), before);
  const plan = await reviewChainRetry(w.ctx, { name: "release", resnapshot: true });
  w.remoteFiles.set("docs/context.md", "New base input\n");
  await assert.rejects(retryChain(w.ctx, { name: "release", resnapshot: true, revision: plan.revision }), /inputs changed after review/);
  const last = await reviewChainRetry(w.ctx, { name: "release", resnapshot: true });
  w.ctx.state.updateChain("release", { base: "release" });
  await assert.rejects(retryChain(w.ctx, { name: "release", resnapshot: true, revision: last.revision }), /inputs changed after review/);
  assert.equal(w.starts(), 0);
});

test("chain controls apply exact reviewed recovery once and preserve active workers and budgets", async () => {
  const { chainRevision } = await import("../lib/chains.mjs");
  const { chainControl } = await import("../lib/tracker/chain_controls.mjs");
  const w = world(); await w.queue(); await tickChains(w.ctx);
  w.ctx.state.updateChain("release", { status: "stopped", reason: "repair prerequisite" });
  const entry = w.ctx.state.get(FIRST), runs = w.starts();
  for (const action of ["retry", "cancel"]) {
    const review = await chainControl(w.ctx, "release", { action, stage: "review", revision: chainRevision(w.ctx.state.getChain("release")), requestId: `chain-${action}-request` });
    const input = { action, stage: "confirm", revision: review.revision, requestId: review.requestId };
    assert.equal((await chainControl(w.ctx, "release", input)).status, "applied");
    const saved = w.ctx.state.getChain("release");
    assert.equal((await chainControl(w.ctx, "release", input)).status, "applied");
    assert.deepEqual(w.ctx.state.getChain("release"), saved, "duplicate request observes receipt only");
    await assert.rejects(chainControl(w.ctx, "release", { ...input, revision: "a".repeat(64) }), /different input/);
    assert.deepEqual(w.ctx.state.get(FIRST), entry);
    assert.equal(w.starts(), runs); assert.equal(w.kills.length, 0);
  }
});

test("chain projection distinguishes every dependency state from worker and delivery completion", async () => {
  const { milestoneProjection, chainsSnapshot } = await import("../lib/tracker/chains.mjs");
  const w = world(); await w.queue(); await tickChains(w.ctx); w.markPr();
  let c = w.ctx.state.getChain("release"), s = c.steps[0];
  let entry = w.ctx.state.get(FIRST);
  assert.equal(milestoneProjection(c, c.steps[1], 1).status, "queued");
  assert.match(milestoneProjection(c, s, 0, entry).label, /Worker ended/);
  const evidence = { delivery: { repository: REPO, pr: 1, head: "head", base: "main", gate: { allow: true } } };
  entry = { ...entry, cursor: { fixed_sha: "head" }, completionEvidence: evidence };
  assert.equal(milestoneProjection(c, s, 0, entry).status, "delivery-ready");
  assert.equal(c.index, 0);
  assert.equal(milestoneProjection(c, s, 0, { ...entry, completionEvidence: { terminal: { state: "CLOSED" } } }).status, "closed-unmerged");
  assert.equal(milestoneProjection({ ...c, status: "stopped", reason: "queued sources changed" }, s, 0, entry).status, "changed-brief");
  assert.equal(milestoneProjection({ ...c, status: "stopped", reason: "repair access" }, s, 0, entry).status, "stopped");
  assert.equal(milestoneProjection({ ...c, status: "cancelled" }, c.steps[1], 1).status, "cancelled");
  assert.equal(milestoneProjection(c, { ...s, merged: { sha: MERGE } }, 0, entry).status, "merged");
  w.ctx.gh = new Proxy({}, { get() { throw new Error("GET must not query host"); } });
  const page = chainsSnapshot(w.ctx, { query: { chain: "release" } });
  assert.match(page.content, /0 of 2 dependencies merged/);
  assert.match(page.content, /Worker ended/);
});

test("chain review hides protected paths, preserves legacy unknowns and refuses altered repository identity", async () => {
  const { chainReviewDifferences } = await import("../lib/tracker/chain_controls.mjs");
  const { reviewChainRetry } = await import("../lib/chains.mjs");
  const c = { index: 0, steps: [{ id: FIRST, relPath: "docs/prds/first-step.md", digest: "a".repeat(64), baseFiles: { ".env": null, "docs/context.md": "b".repeat(64) } }] };
  const differences = chainReviewDifferences(c, c.steps);
  assert.equal(differences[0].files[0].path, "Protected source path");
  assert.equal(differences[0].files[1].inputBefore, null);
  assert.doesNotMatch(JSON.stringify(differences), /\.env/);
  const w = world(); await w.queue(); w.ctx.state.updateChain("release", { status: "stopped" });
  w.ctx.gh.repoInfo = async () => ({ nameWithOwner: "other/widget", defaultBranch: "main" });
  await assert.rejects(reviewChainRetry(w.ctx, { name: "release", resnapshot: true }), /repository or task identity/);
  assert.equal(w.ctx.state.getChain("release").status, "stopped"); assert.equal(w.starts(), 0);
});
