// Chains exercise the real start path and persisted registry, with no GitHub or model calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { queueChain, retryChain, cancelChain, tickChains, chainRows, renderChains } from "../lib/chains.mjs";
import { makeState, STATES } from "../lib/state.mjs";
import { start } from "../lib/commands/start.mjs";
import { makeTick } from "../lib/tick.mjs";
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
  for (const changed of [{ branch: "gallivant/replacement" }, { start_token: "replacement-start" }]) {
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
  await daemon.tick();
  assert.equal(observedSettled, true);
  await daemon.tick();
  assert.equal(w.starts(), 2);
  assert.equal(w.ctx.state.get(SECOND).state, STATES.running);
});
