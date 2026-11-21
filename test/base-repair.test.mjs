import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { makeGit } from "../lib/git.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { makeState, newEntry, entryId } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { checkAuthorStorage } from "../lib/recovery_preflight.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { requestControl, applyControl, MAX_NOTE } from "../lib/control.mjs";
import { quote } from "../lib/prompt.mjs";
import { makeHostRegistry } from "../lib/hosts.mjs";
import { execFileAsync } from "../lib/process.mjs";
import { CONFIG, FIXTURE_HEADROOM, GOOD_PRD, T0, at, tempHome, makeClock, fakeRunner, fakeGh, fakeNotify, fakeCredential, fakeIdentity, silentLog, prFixture, claudeResultLines, review, STATES, harnessBin } from "./helpers.mjs";

const write = (file, text) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const combined = "export function calculate(n) { return Math.max(0, n) + 1; }\n";
const baseCode = "export function calculate(n) { return Math.max(0, n); }\n";

// Native repositories and the real execution ledger; the worker is deliberately
// controlled by the fixture, with no paid provider calls or host writes.
function world(t, { hostConflict = true, superseded = false, baseUpdate = "conflict", state: stateName = STATES.prOpen, host = "github.com" } = {}) {
  const home = tempHome(); t.after(() => rmSync(home, { recursive: true, force: true }));
  const origin = join(home, "origin"), tree = join(home, "trees", "task"), operator = join(home, "operator");
  const calls = [];
  const g = (args, cwd = tree) => {
    calls.push(args);
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  };
  mkdirSync(origin); mkdirSync(dirname(tree)); mkdirSync(operator);
  g(["init", "-q", "-b", "main"], origin);
  write(join(origin, "shared.mjs"), "export function calculate(n) { return n; }\n");
  g(["add", "shared.mjs"], origin); g(["commit", "-qm", "Initial behavior"], origin);
  g(["clone", "-q", origin, tree], home); g(["checkout", "-qb", "work/repair"]);
  write(join(tree, "shared.mjs"), "export function calculate(n) { return n + 1; }\n");
  g(["add", "shared.mjs"]); g(["commit", "-qm", "Add task behavior"]); g(["push", "-q", "origin", "work/repair"]);
  if (baseUpdate !== "none") {
    const file = baseUpdate === "independent" ? "base.mjs" : "shared.mjs";
    write(join(origin, file), superseded ? "export function calculate(n) { return Math.max(0, n + 1); }\n" : baseCode);
    g(["add", file], origin); g(["commit", "-qm", "Preserve safe base behavior"], origin);
  }
  const head = g(["rev-parse", "HEAD"]), base = g(["rev-parse", "HEAD"], origin);
  const prd = "docs/prds/widget-export.md", source = "AGENTS.md";
  for (const dir of [tree, operator]) { write(join(dir, prd), GOOD_PRD); write(join(dir, source), "Keep approved security requirements.\n"); }
  const clock = makeClock(at(6)), raw = fakeRunner(clock);
  const seed = raw.start("initial", "fixture", [], {});
  raw.finish(claudeResultLines(), { exit: 0 });
  const repo = host === "github.com" ? "acme/widget" : `${host}/acme/widget`;
  const url = host === "github.com" ? "https://github.com/acme/widget/pull/142" : `https://${host}/acme/widget/pull-requests/142`;
  mkdirSync(join(home, "registry"));
  const state = makeState(join(home, "registry")), id = entryId(repo, "widget-export");
  state.put(id, { ...newEntry({ repo, prd, harness: "claude", session: "6f1c2d3e-1111-4111-8111-111111111111", worktree: tree, branch: "work/repair", pr: 142, state: stateName, nowIso: T0 }),
    host, url, base: "main", checkout: operator, sources: [source],
    cursor: { since: T0, fixed_sha: head, dispatched: [] }, last: { at: T0, run: seed.id, exit: 0 },
    review_readiness: { head }, firstPartyReview: { key: "old", status: "completed", head },
    completionEvidence: { delivery: { head, gate: { allow: true } } } });
  const gh = fakeGh({ pr: prFixture({ url, headRefName: "work/repair", headRefOid: head, mergeable: hostConflict ? "CONFLICTING" : "MERGEABLE" }),
    reviews: hostConflict ? [] : [review({ id: 1, by: "me", state: "CHANGES_REQUESTED", at: at(5) })] });
  gh.now = () => new Date(clock.now()).toISOString();
  const config = { ...CONFIG, home, worktrees: dirname(tree), resource_headroom: FIXTURE_HEADROOM,
    ...(host === "bitbucket.org" ? { repos: [{ repo, reviewer: null, trusted_authors: ["{11111111-1111-4111-8111-111111111111}"] }] } : {}) };
  const git = makeGit({ config, identity: fakeIdentity() });
  // Host binding is faked only at the transport edge; fetch/merge/ancestry/index
  // proofs operate on real Git objects through makeGit.
  git.originOf = async () => `https://${host}/acme/widget.git`;
  git.ensureHttpsRemote = async () => {};
  const runner = makeExecution({ root: join(home, "runs"), taskId: id, provider: "claude", runner: raw, legacySessionId: state.get(id).session, clock });
  const registry = makeHostRegistry({ credential: fakeCredential() });
  const ctx = { config, state, clock, ownLogin: "me", gh, host: gh, hosts: registry, git,
    log: silentLog, notify: fakeNotify(), credential: fakeCredential(), identity: fakeIdentity(), runnerFor: () => runner,
    readPrd: () => GOOD_PRD, readSource: () => "Keep approved security requirements.\n" };
  const tick = async () => {
    const results = await makeTick(ctx).tick();
    assert.ok(results.every(result => result.ok), JSON.stringify(results));
    return results;
  };
  const entry = () => state.get(id);
  const beginMerge = () => {
    assert.throws(() => g(["merge", "--no-ff", "--no-edit", "-m", "Merge approved base into task branch", entry().base_repair.baseSha]));
  };
  const resolveMerge = async ({ push = true } = {}) => {
    beginMerge();
    write(join(tree, "shared.mjs"), superseded ? "export function calculate(n) { return Math.max(0, n + 1); }\n" : combined);
    const { calculate } = await import(pathToFileURL(join(tree, "shared.mjs")).href);
    assert.equal(calculate(2), 3); assert.equal(calculate(-2), superseded ? 0 : 1);
    g(["add", "shared.mjs"]); g(["commit", "-qm", superseded ? "Merge base implementation superseding the task edit" : "Merge approved base into task branch"]);
    const repaired = g(["rev-parse", "HEAD"]);
    if (push) { g(["push", "origin", "HEAD:refs/heads/work/repair"]); gh.data.pr.headRefOid = repaired; gh.data.pr.mergeable = "MERGEABLE"; }
    return repaired;
  };
  return { ...ctx, ctx, home, id, tree, origin, operator, prd, source, head, base, g, calls, raw, runner, entry, tick, beginMerge, resolveMerge };
}

// A real operator continuation sees a clean task clone with private carried
// inputs ignored by Git, while the repair proof still validates their bytes.
function continuationWorld(t, options) {
  const w = world(t, options);
  write(join(w.tree, ".git", "info", "exclude"), `/${w.prd}\n/${w.source}\n`);
  w.ctx.home = w.home;
  w.ctx.coordinatorHealth = () => ({ alive: true, stale: false });
  w.ctx.config.harness = { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(w.home, "claude") } };
  return w;
}

test("repair fixtures tolerate host pressure while checking native Git mounts", async t => {
  const w = world(t);
  const paths = { stateDir: w.home, worktree: w.tree, gitDirs: [join(w.tree, ".git")] };
  const adapters = { pressure: () => ({ memoryBytes: 0, loadPerCpu: 8 }) };
  assert.throws(() => checkAuthorStorage(paths, adapters), /memory, process-pressure/);
  assert.deepEqual(checkAuthorStorage(paths, adapters, w.ctx.config).blocked, []);
  const { mounts } = await w.git.authorStorage(w.tree, w.home);
  assert.deepEqual(Object.keys(mounts), ["state", "checkout", "scratch", "git-1", "git-2", "git-3"]);
  assert.throws(() => checkAuthorStorage({ ...paths, gitDirs: [join(w.tree, "missing")] }, adapters, w.ctx.config), /git-1-unverified/);
});

test("owned UI resume and message repair conflicts from watching and explicitly stopped tasks", async t => {
  for (const action of ["resume", "message"]) for (const state of [STATES.prOpen, STATES.needsHuman]) await t.test(`${action} ${state}`, async t => {
    const w = continuationWorld(t, { state });
    if (state === STATES.needsHuman) {
      w.raw.finish(claudeResultLines(), { exit: 1 });
      w.state.update(w.id, e => ({ reason: "harness-error", last: { ...e.last, exit: 1 } }));
    }
    const note = action === "message" ? "Preserve the guest path.\n````An operator clarification is not a new brief.````" : "";
    const request = requestControl(w.ctx, { handle: w.id, action, note, requestId: `repair-${action}` });
    await applyControl(w.ctx, w.id);
    const entry = w.entry(), prompt = w.raw.started.at(-1).args.at(-1);
    assert.equal(entry.control.id, request.id); assert.equal(entry.control.status, "applied", JSON.stringify(entry));
    assert.equal(entry.base_repair.status, "running"); assert.equal(entry.state, STATES.prOpen);
    assert.equal(entry.iteration, 1); assert.equal(w.raw.started.length, 2);
    assert.equal(entry.firstPartyReview, null); assert.equal(entry.review_readiness, null);
    assert.ok(entry.completionEvidence.delivery.invalidatedAt, "old completion cannot survive the repaired head");
    if (note) { assert.equal(entry.base_repair.operatorNote, note); assert.ok(prompt.includes(quote(note))); assert.match(prompt, /does not change the approved brief/); }
    assert.equal(readFileSync(join(w.tree, w.source), "utf8"), "Keep approved security requirements.\n");
    await w.tick(); assert.equal(w.raw.started.length, 2, "the applied control cannot duplicate the repair");
  });
});

test("explicit CLI resume can repair a clean conflict after a settled harness failure", async t => {
  const w = continuationWorld(t, { state: STATES.needsHuman });
  w.raw.finish(claudeResultLines(), { exit: 1 });
  w.state.update(w.id, e => ({ reason: "harness-error", last: { ...e.last, exit: 1 } }));
  const result = await resume(w.ctx, { handle: w.id });
  assert.equal(result.run, w.entry().last.run); assert.equal(w.entry().base_repair.status, "running");
  assert.equal(w.raw.started.length, 2); assert.equal(w.entry().iteration, 1);
});

test("oversized operator repair messages fail before any Git or dispatch side effects", async t => {
  const w = continuationWorld(t), before = structuredClone(w.entry()), calls = w.calls.length;
  await assert.rejects(() => resume(w.ctx, { handle: w.id, note: "x".repeat(MAX_NOTE + 1) }), /Messages must be at most/);
  assert.deepEqual(w.entry(), before); assert.equal(w.calls.length, calls);
  assert.equal(w.raw.started.length, 1); assert.equal(w.entry().base_repair, undefined);
});

test("superseding or revoked UI ownership still fences repair before paid dispatch", async t => {
  for (const change of ["new-id", "cancel", "queued", "removed"]) await t.test(change, async t => {
    const w = continuationWorld(t), clean = w.git.assertClean;
    const request = requestControl(w.ctx, { handle: w.id, action: "resume", requestId: "original-repair" });
    let changed = false;
    w.git.assertClean = async (...args) => {
      await clean(...args);
      if (!changed && w.entry().base_repair?.status === "prepared") {
        changed = true;
        const current = w.entry().control;
        w.state.update(w.id, { control: change === "removed" ? null : { ...current,
          ...(change === "new-id" ? { id: "replacement-repair" } : {}),
          ...(change === "cancel" ? { id: "cancel-repair", action: "cancel", status: "queued" } : {}),
          ...(change === "queued" ? { status: "queued" } : {}) } });
      }
    };
    await applyControl(w.ctx, w.id);
    assert.ok(changed); assert.equal(w.raw.started.length, 1, "a stale owner must not submit");
    assert.equal(w.entry().base_repair.charged, false); assert.equal(w.entry().iteration, 0);
    if (change === "new-id") assert.equal(w.entry().control.id, "replacement-repair");
    if (change === "cancel") { assert.equal(w.entry().control.id, "cancel-repair"); assert.equal(w.entry().control.status, "queued"); }
    assert.notEqual(w.entry().control?.status, "applied");
    assert.notEqual(w.entry().last.run, request.id);
  });
});

test("UI retry of a proven unsubmitted repair retains its operation and current message", async t => {
  const w = continuationWorld(t); w.ctx.hosts.credential = fakeCredential(null);
  await w.tick();
  const op = structuredClone(w.entry().base_repair);
  assert.equal(op.charged, false); assert.equal(w.raw.started.length, 1);
  w.ctx.hosts.credential = fakeCredential();
  const note = "Keep the existing accessibility behavior while resolving this conflict.";
  requestControl(w.ctx, { handle: w.id, action: "message", note, requestId: "retry-repair" });
  await applyControl(w.ctx, w.id);
  assert.equal(w.entry().control.status, "applied", JSON.stringify(w.entry()));
  assert.equal(w.entry().base_repair.operationId, op.operationId);
  assert.equal(w.entry().base_repair.operatorNote, note);
  assert.ok(w.raw.started.at(-1).args.at(-1).includes(quote(note)));
  assert.equal(w.entry().iteration, 1); assert.equal(w.entry().base_repair_attempts.length, 1);
  assert.equal(w.raw.started.length, 2);
});

test("automatic provider recovery cannot use explicit conflict repair admission", async t => {
  const w = continuationWorld(t, { state: STATES.needsHuman });
  w.state.update(w.id, { reason: "provider-network" });
  await assert.rejects(() => resume(w.ctx, { handle: w.id, automaticNetworkRecovery: true }), /cannot be merged/);
  assert.equal(w.raw.started.length, 1); assert.equal(w.entry().base_repair, undefined); assert.equal(w.entry().iteration, 0);
});

test("a pushed repair reconciliation reports watching or actually delivers an operator message once", async t => {
  for (const action of ["resume", "message"]) await t.test(action, async t => {
    const w = continuationWorld(t); await w.tick(); await w.resolveMerge();
    w.raw.finish(claudeResultLines(), { exit: 1 }); await w.tick();
    assert.equal(w.entry().base_repair.status, "blocked"); assert.equal(w.raw.started.length, 2);
    const note = action === "message" ? "After the repair, also preserve the verified guest behavior." : "";
    requestControl(w.ctx, { handle: w.id, action, note, requestId: "reconcile-pushed-repair" });
    await applyControl(w.ctx, w.id);
    assert.equal(w.entry().base_repair.status, "verified"); assert.equal(w.entry().control.status, "applied", JSON.stringify(w.entry()));
    if (note) {
      assert.equal(w.raw.started.length, 3); assert.ok(w.raw.started.at(-1).args.at(-1).includes(quote(note)));
      assert.equal(w.entry().control.run, w.entry().last.run);
    } else {
      assert.equal(w.raw.started.length, 2, "a plain proof reconciliation cannot buy a second worker");
      assert.equal(w.entry().control.run, null); assert.match(w.entry().control.message, /Watching PR checks/);
    }
    await applyControl(w.ctx, w.id); assert.equal(w.raw.started.length, note ? 3 : 2);
  });
});

test("merge or superseding cancellation during pushed repair proof blocks the follow-up message", async t => {
  for (const change of ["merged", "cancel"]) await t.test(change, async t => {
    const w = continuationWorld(t); await w.tick(); await w.resolveMerge();
    w.raw.finish(claudeResultLines(), { exit: 1 }); await w.tick();
    requestControl(w.ctx, { handle: w.id, action: "message", note: "A follow-up correction.", requestId: "proof-follow-up" });
    const fetch = w.git.fetchBranchHead;
    w.git.fetchBranchHead = async (...args) => {
      const result = await fetch(...args);
      if (change === "merged") w.gh.data.pr.state = "MERGED";
      else w.state.update(w.id, { control: { id: "new-cancel", action: "cancel", status: "queued", at: T0 } });
      return result;
    };
    await applyControl(w.ctx, w.id);
    assert.equal(w.entry().verified_progress.kind, "verified-push", "the existing remote push proof remains recorded");
    assert.equal(w.entry().base_repair.status, change === "cancel" ? "blocked" : "verified", "a superseded request cannot accept a failed paid result");
    assert.equal(w.raw.started.length, 2, "terminal integration or a new owner cannot launch a follow-up");
    if (change === "cancel") { assert.equal(w.entry().control.id, "new-cancel"); assert.equal(w.entry().control.status, "queued"); }
    else assert.equal(w.entry().control.status, "failed");
  });
});

// A real task can carry a release guide and explicitly approve updating it.
// Its published result must not replace the coordinator's requirement snapshot.
function withPublishedGuide(w, { eol = "\n" } = {}) {
  const guide = "docs/release/guide.md", original = `Approved release context.${eol}`, updated = `Updated candidate and rollback instructions.${eol}`;
  const brief = GOOD_PRD.replace("---\n", `---\npublish_files:\n  - ${guide}\n  - ${w.prd}\n`);
  const readSource = w.ctx.readSource;
  w.ctx.readPrd = () => brief;
  w.ctx.readSource = (id, path) => path === guide ? original : readSource(id, path);
  w.state.update(w.id, { sources: [w.source, guide] });
  for (const dir of [w.operator, w.tree]) write(join(dir, w.prd), brief);
  write(join(w.operator, guide), original); write(join(w.tree, guide), updated);
  w.g(["add", guide]); w.g(["commit", "-qm", "Update approved release guide"]); w.g(["push", "-q", "origin", "work/repair"]);
  const head = w.g(["rev-parse", "HEAD"]);
  w.gh.data.pr.headRefOid = head;
  w.state.update(w.id, { cursor: { ...w.entry().cursor, fixed_sha: head } });
  return { guide, original, updated, brief, head };
}

for (const host of ["github.com", "bitbucket.org"]) test(`committed published context survives the next review round on ${host}`, async t => {
  for (const baseUpdate of ["none", "independent", "conflict"]) await t.test(baseUpdate, async t => {
    const w = world(t, { host, hostConflict: baseUpdate === "conflict", baseUpdate });
    const doc = withPublishedGuide(w);
    await w.tick();
    assert.equal(w.raw.started.length, 2, JSON.stringify(w.entry()));
    assert.equal(w.entry().reason, null);
    assert.equal(w.entry().session, "6f1c2d3e-1111-4111-8111-111111111111");
    assert.equal(readFileSync(join(w.tree, doc.guide), "utf8"), doc.updated);
    assert.equal(w.ctx.readSource(w.id, doc.guide), doc.original);
    assert.equal(w.ctx.readPrd(w.id), doc.brief);
    if (baseUpdate === "conflict") {
      assert.equal(w.entry().base_repair.status, "running");
      assert.equal(w.entry().base_repair.head, doc.head);
      assert.equal(w.entry().base_repair.baseSha, w.base);
      await w.resolveMerge(); w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
      assert.equal(w.entry().base_repair.status, "verified", JSON.stringify(w.entry()));
      assert.equal(w.ctx.readSource(w.id, doc.guide), doc.original);
    } else {
      assert.equal(await w.git.containsCommit(w.tree, w.base), true);
      assert.equal(await w.git.containsCommit(w.tree, doc.head), true);
      if (baseUpdate === "independent") assert.match(w.raw.started.at(-1).args.at(-1), /origin\/main.*was merged/);
    }
  });
});

test("published context respects Git checkout conversions before and after an approved edit", async t => {
  for (const conversion of ["attributes", "autocrlf", "ident"]) for (const changed of [false, true]) await t.test(`${conversion}: ${changed ? "updated output" : "unchanged snapshot"}`, async t => {
    const w = world(t, { hostConflict: false, baseUpdate: "independent" });
    if (conversion === "autocrlf") w.g(["config", "core.autocrlf", "true"]);
    else {
      write(join(w.tree, ".gitattributes"), `docs/release/guide.md ${conversion === "ident" ? "ident" : "text eol=crlf"}\n`);
      w.g(["add", ".gitattributes"]); w.g(["commit", "-qm", "Define checkout conversion"]);
    }
    const doc = withPublishedGuide(w, { eol: conversion === "ident" ? "\n" : "\r\n" });
    if (conversion === "ident") {
      write(join(w.tree, doc.guide), "$Id$\n" + doc.updated);
      w.g(["add", doc.guide]); w.g(["commit", "-qm", "Use checkout identifier"]);
    }
    // Force Git itself to produce the configured working-copy representation.
    rmSync(join(w.tree, doc.guide));
    w.g(["checkout-index", "-f", "--", doc.guide]);
    const checkout = readFileSync(join(w.tree, doc.guide), "utf8");
    assert.notEqual(checkout, w.g(["show", `HEAD:${doc.guide}`]) + "\n");
    assert.equal(w.g(["diff", "--name-only", "HEAD", "--", doc.guide]), "");
    if (!changed) {
      const readSource = w.ctx.readSource;
      w.ctx.readSource = (id, path) => path === doc.guide ? checkout : readSource(id, path);
      write(join(w.operator, doc.guide), checkout);
    }
    const head = w.g(["rev-parse", "HEAD"]);
    w.gh.data.pr.headRefOid = head;
    w.state.update(w.id, { cursor: { ...w.entry().cursor, fixed_sha: head } });
    await w.tick();
    assert.equal(w.raw.started.length, 2, JSON.stringify(w.entry()));
    assert.equal(w.entry().reason, null);
    assert.equal(readFileSync(join(w.tree, doc.guide), "utf8"), checkout);
    assert.equal(w.ctx.readSource(w.id, doc.guide), changed ? doc.original : checkout);
    assert.equal(await w.git.containsCommit(w.tree, w.base), true);
  });
});

test("published output validation refuses changes after its Git cleanliness proof", async t => {
  for (const change of ["working copy", "commit"]) await t.test(change, async t => {
    const w = world(t, { hostConflict: false, baseUpdate: "none" });
    const doc = withPublishedGuide(w);
    let changed = false;
    const git = makeGit({ config: w.ctx.config, identity: fakeIdentity(), exec: async (command, args, options) => {
      const result = await execFileAsync(command, args, options);
      if (!changed && args[0] === "hash-object") {
        changed = true;
        if (change === "working copy") write(join(w.tree, doc.guide), "Concurrent unfinished edit.\n");
        else {
          write(join(w.tree, "concurrent.mjs"), "export const changed = true;\n");
          w.g(["add", "concurrent.mjs"]); w.g(["commit", "-qm", "Concurrent task commit"]);
        }
      }
      return result;
    } });
    const { repairOverlays } = await import("../lib/base_repair.mjs");
    await assert.rejects(git.assertClean(w.tree, repairOverlays(w.ctx, w.id, w.entry())), /immutable approved snapshot|head changed/);
    assert.equal(changed, true);
    assert.equal(w.raw.started.length, 1);
    assert.equal(w.ctx.readSource(w.id, doc.guide), doc.original);
    if (change === "working copy") assert.equal(readFileSync(join(w.tree, doc.guide), "utf8"), "Concurrent unfinished edit.\n");
  });
});

test("publication approval cannot admit unfinished outputs or changed private authority", async t => {
  for (const fault of ["unstaged output", "staged output", "assumed unchanged output", "skip-worktree output", "skip-worktree deleted output", "deleted output", "linked output", "committed private instructions", "committed published brief", "worker-only publication approval"]) await t.test(fault, async t => {
    const w = world(t, { hostConflict: false, baseUpdate: "independent" });
    const doc = withPublishedGuide(w);
    if (["unstaged output", "staged output"].includes(fault)) {
      write(join(w.tree, doc.guide), "Unfinished operator edits.\n");
      if (fault === "staged output") w.g(["add", doc.guide]);
    }
    if (["assumed unchanged output", "skip-worktree output"].includes(fault)) {
      write(join(w.tree, doc.guide), "Unfinished hidden output.\n");
      w.g(["update-index", fault === "assumed unchanged output" ? "--assume-unchanged" : "--skip-worktree", "--", doc.guide]);
      assert.equal(w.g(["diff", "--name-only", "HEAD", "--", doc.guide]), "", "the ordinary Git diff must actually hide this edit");
    }
    if (fault === "skip-worktree deleted output") {
      w.g(["update-index", "--skip-worktree", "--", doc.guide]);
      rmSync(join(w.tree, doc.guide));
      assert.equal(w.g(["diff", "--name-only", "HEAD", "--", doc.guide]), "");
    }
    if (fault === "deleted output") rmSync(join(w.tree, doc.guide));
    if (fault === "linked output") { rmSync(join(w.tree, doc.guide)); symlinkSync(join(w.home, "outside"), join(w.tree, doc.guide)); }
    if (fault === "committed private instructions") {
      write(join(w.tree, w.source), "Change the approved security instructions.\n");
      w.g(["add", w.source]); w.g(["commit", "-qm", "Alter worker context"]);
    }
    if (fault === "committed published brief") {
      write(join(w.tree, w.prd), doc.brief.replace("npm test", "echo skip-tests"));
      w.g(["add", w.prd]); w.g(["commit", "-qm", "Alter worker brief"]);
    }
    if (fault === "worker-only publication approval") {
      w.ctx.readPrd = () => GOOD_PRD;
      write(join(w.operator, w.prd), GOOD_PRD);
      write(join(w.tree, w.prd), GOOD_PRD);
    }
    const before = w.g(["rev-parse", "HEAD"]), status = w.g(["status", "--porcelain=v1", "-z"]);
    const index = readFileSync(join(w.tree, ".git/index"));
    await assert.rejects(makeTick(w.ctx).mergeBaseInto(w.id, w.entry()), /immutable approved snapshot|unfinished repository edits|symlink/);
    assert.equal(w.g(["rev-parse", "HEAD"]), before);
    assert.equal(w.g(["status", "--porcelain=v1", "-z"]), status);
    assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index);
    assert.equal(w.raw.started.length, 1);
    assert.equal(w.ctx.readSource(w.id, doc.guide), doc.original);
  });
});

test("resume recreates private approved overlays after checking a clean branch against its base", async t => {
  for (const baseUpdate of ["none", "independent"]) await t.test(baseUpdate, async t => {
    const w = world(t, { hostConflict: false, baseUpdate });
    w.ctx.config.harness = { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(w.home, "claude") } };
    rmSync(w.tree, { recursive: true });
    w.git.fromBranch = async ({ branch, path }) => { w.g(["clone", "-q", "--branch", branch, w.origin, path], w.home); return path; };
    const before = w.entry();
    const result = await resume(w.ctx, { handle: w.id });
    assert.equal(result.session, before.session);
    assert.equal(w.raw.started.length, 2);
    const prompt = w.raw.started.at(-1).args.at(-1);
    assert.match(prompt, /npm test/);
    assert.match(prompt, /this is the same session/);
    assert.match(prompt, /keeping this branch on its base is done for you/);
    assert.equal(readFileSync(join(w.tree, w.prd), "utf8"), GOOD_PRD);
    assert.equal(readFileSync(join(w.tree, w.source), "utf8"), w.ctx.readSource());
    assert.equal(w.g(["show", "HEAD:shared.mjs"]), "export function calculate(n) { return n + 1; }");
    assert.equal(await w.git.containsCommit(w.tree, w.base), true);
    assert.equal(w.g(["ls-files", "--", w.prd, w.source]), "", "restored private inputs are never staged");
    if (baseUpdate === "none") assert.equal(w.g(["rev-parse", "HEAD"]), w.head);
    else assert.equal(readFileSync(join(w.tree, "base.mjs"), "utf8"), baseCode);
  });
});

test("daemon fix recreation permits a private brief absent from the branch before its base check", async t => {
  const w = world(t, { hostConflict: false, baseUpdate: "none" });
  rmSync(w.tree, { recursive: true });
  w.git.fromBranch = async ({ branch, path }) => { w.g(["clone", "-q", "--branch", branch, w.origin, path], w.home); return path; };
  await w.tick();
  assert.equal(w.raw.started.length, 2);
  assert.equal(w.entry().last.exit, null);
  assert.equal(w.entry().reason, null);
  assert.equal(w.g(["rev-parse", "HEAD"]), w.head);
  assert.equal(readFileSync(join(w.tree, w.source), "utf8"), w.ctx.readSource());
});

test("pre-merge missing-overlay allowance preserves existing edits, deletions and links", async t => {
  for (const fault of ["ignored edit", "tracked deletion", "dangling link", "linked parent"]) await t.test(fault, async t => {
    const w = world(t, { hostConflict: false, baseUpdate: "none" });
    rmSync(join(w.tree, w.prd));
    // Hidden files still require byte validation; missing files may never hide
    // a tracked deletion or a link escaping the owned checkout.
    if (fault === "tracked deletion") {
      w.g(["add", w.source]); w.g(["commit", "-qm", "Track fixture instructions"]);
    }
    else write(join(w.tree, ".git/info/exclude"), `${w.source}\ndocs/\n`);
    if (fault === "ignored edit") write(join(w.tree, w.source), "Keep unfinished operator edits.\n");
    if (fault === "tracked deletion" || fault === "dangling link") rmSync(join(w.tree, w.source));
    if (fault === "dangling link") symlinkSync(join(w.home, "absent"), join(w.tree, w.source));
    if (fault === "linked parent") {
      rmSync(join(w.tree, "docs"), { recursive: true });
      symlinkSync(join(w.home, "absent"), join(w.tree, "docs"));
    }
    const status = w.g(["status", "--porcelain=v1", "-z"]);
    const index = readFileSync(join(w.tree, ".git/index"));
    w.git.mergeBase = async () => assert.fail("unsafe overlays must stop before merging");
    await assert.rejects(makeTick(w.ctx).mergeBaseInto(w.id, w.entry()), /immutable approved snapshot|unfinished repository edits|symlink/);
    assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index);
    assert.equal(w.g(["status", "--porcelain=v1", "-z"]), status);
    assert.equal(w.raw.started.length, 1);
    if (fault === "ignored edit") assert.equal(readFileSync(join(w.tree, w.source), "utf8"), "Keep unfinished operator edits.\n");
  });
});

test("repair admission still requires every private approved overlay to exist", async t => {
  const w = world(t);
  rmSync(join(w.tree, w.prd));
  await w.tick();
  assert.equal(w.entry().reason, "base-repair-dirty");
  assert.equal(w.raw.started.length, 1);
  assert.equal(w.entry().base_repair, undefined);
  assert.equal(existsSync(join(w.tree, w.prd)), false);
  assert.equal(w.g(["rev-parse", "HEAD"]), w.head);
});

for (const hostConflict of [true, false]) test(`native overlapping merge dispatches once from ${hostConflict ? "host conflict" : "normal fix merge"}`, async t => {
  const w = world(t, { hostConflict });
  await w.tick();
  assert.equal(w.entry().base_repair?.status, "running", JSON.stringify(w.entry()));
  assert.equal(w.entry().base_repair.head, w.head); assert.equal(w.entry().base_repair.baseSha, w.base);
  assert.equal(w.entry().base_merge.aborted, true); assert.equal((await w.git.mergeState(w.tree)).head, null);
  assert.equal(w.entry().iteration, 1); assert.equal(w.raw.started.length, 2);
  const run = w.runner.current(), prompt = w.raw.started.at(-1).args.at(-1);
  assert.equal(run.execution.sessionId, w.entry().session); assert.equal(run.execution.operationId, w.entry().base_repair.operationId);
  for (const pattern of [/both changes/, /blindly taking either side/, /superseded/, /explain that decision and test/, /pinned commit/, /npm test/, /npm run lint/, /Do not merge the PR/, /rebase or force-push/]) assert.match(prompt, pattern);
  assert.doesNotMatch(prompt, /keeping this branch on its base is done for you/);
  await w.tick(); await w.tick();
  assert.equal(w.raw.started.length, 2, "duplicate tick never dispatches");
  assert.equal(readFileSync(join(w.tree, w.source), "utf8"), "Keep approved security requirements.\n");
});

for (const superseded of [false, true]) test(`repair proves remote ancestry and invalidates old readiness${superseded ? " with a superseded task edit" : ""}`, async t => {
  const w = world(t, { superseded, state: STATES.ready });
  await w.tick();
  assert.equal(w.entry().firstPartyReview, null); assert.equal(w.entry().review_readiness, null);
  assert.ok(w.entry().completionEvidence.delivery.invalidatedAt);
  const repaired = await w.resolveMerge();
  w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
  assert.equal(w.entry().base_repair.status, "verified", JSON.stringify(w.entry()));
  assert.equal(w.entry().base_repair.repairSha, repaired); assert.equal(w.entry().base_repair.remoteSha, repaired);
  assert.equal(w.entry().state, STATES.prOpen); assert.equal(w.entry().iteration, 1, "no double charge on settlement");
  assert.equal(w.entry().cursor.since, T0, "pending feedback is retained");
  assert.equal(w.entry().cursor.checks_sha, null);
  assert.equal(w.g(["show", "HEAD:shared.mjs"]), (superseded ? "export function calculate(n) { return Math.max(0, n + 1); }" : combined.trim()));
  assert.equal(w.g(["merge-base", "--is-ancestor", w.head, repaired]), "");
  assert.equal(w.g(["merge-base", "--is-ancestor", w.base, repaired]), "");
  assert.ok(w.entry().round_comment); assert.equal(w.notify.sent.filter(([kind]) => kind === "ready").length, 0);
  assert.ok(w.calls.every(args => !args.includes("--force") && !args.includes("rebase")));
  // Old-head clearance plus pending new-head CI cannot qualify readiness.
  w.gh.data.pr.statusCheckRollup = [{ status: "IN_PROGRESS", conclusion: null }];
  await w.tick(); assert.notEqual(w.entry().state, STATES.ready); assert.equal(w.raw.started.length, 2);
});

test("restart adopts the accepted repair ledger without touching its dirty merge", async t => {
  const w = world(t); await w.tick();
  w.beginMerge();
  const op = w.entry().base_repair, index = readFileSync(join(w.tree, ".git/index")), content = readFileSync(join(w.tree, "shared.mjs"));
  w.state.update(w.id, { base_repair: { ...op, status: "dispatching", run: null }, last: { at: T0, run: "1-initial", exit: 0 } });
  await w.tick();
  assert.equal(w.entry().last.run, w.runner.current().id); assert.equal(w.raw.started.length, 2);
  assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index); assert.deepEqual(readFileSync(join(w.tree, "shared.mjs")), content);
  w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
  assert.equal(w.entry().reason, "base-repair-unresolved");
  assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index); assert.deepEqual(readFileSync(join(w.tree, "shared.mjs")), content);
  await assert.rejects(() => resume(w.ctx, { handle: w.id }), /Unresolved Git operation/);
});

test("unrelated dirty recovery, unknown ownership and failed push preserve work", async t => {
  for (const fault of ["dirty", "missing-overlay", "session", "base", "branch", "operation", "push"]) await t.test(fault, async t => {
    const w = world(t); await w.tick();
    await w.resolveMerge({ push: fault !== "push" });
    if (fault === "dirty") write(join(w.tree, "unrelated.txt"), "Operator edits\n");
    if (fault === "missing-overlay") rmSync(join(w.tree, w.source));
    if (["session", "base", "branch"].includes(fault)) w.state.update(w.id, { [fault]: "different" });
    if (fault === "operation") w.state.update(w.id, { base_repair: { ...w.entry().base_repair, operationId: "foreign" } });
    const index = readFileSync(join(w.tree, ".git/index")), content = readFileSync(join(w.tree, "shared.mjs"));
    w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
    assert.equal(w.entry().state, STATES.needsHuman); assert.match(w.entry().reason, /^base-repair-/);
    assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index); assert.deepEqual(readFileSync(join(w.tree, "shared.mjs")), content);
    if (fault === "dirty") assert.equal(readFileSync(join(w.tree, "unrelated.txt"), "utf8"), "Operator edits\n");
    if (fault === "missing-overlay") { assert.equal(w.entry().reason, "base-repair-dirty"); assert.equal(existsSync(join(w.tree, w.source)), false); }
    await w.tick(); assert.equal(w.raw.started.length, 2); assert.equal(w.entry().iteration, 1);
  });
});

test("launch failure and provider failure cannot buy a second operation", async t => {
  for (const fault of ["launch", "provider"]) await t.test(fault, async t => {
    const w = world(t);
    if (fault === "launch") w.raw.start = () => { throw new Error("provider launch failed"); };
    await w.tick();
    if (fault === "provider") { w.raw.finish(claudeResultLines({ ok: false }), { exit: 1 }); await w.tick(); }
    const operation = w.entry().base_repair.operationId;
    await w.tick(); await w.tick();
    assert.equal(w.entry().base_repair.operationId, operation); assert.equal(w.entry().base_repair_attempts.length, 1);
    assert.equal(w.entry().iteration, 1); assert.equal(w.entry().state, STATES.needsHuman);
    assert.equal(w.entry().base_merge.head, w.head); assert.equal(w.entry().base_merge.baseSha, w.base);
    assert.match(w.entry().base_merge.why, /merge/i);
  });
});

test("live base movement keeps the dispatched SHA pinned and charges another pair only within the limit", async t => {
  const w = world(t); w.ctx.config.max_iterations = 1; await w.tick();
  write(join(w.origin, "shared.mjs"), "export function calculate(n) { return Math.max(10, n); }\n");
  w.g(["add", "shared.mjs"], w.origin); w.g(["commit", "-qm", "Move base again"], w.origin);
  const newer = w.g(["rev-parse", "HEAD"], w.origin);
  w.g(["fetch", "origin", "main"]);
  const repaired = await w.resolveMerge();
  assert.equal(await w.git.containsCommit(w.tree, newer, repaired), false);
  w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
  assert.equal(w.entry().base_repair.baseSha, w.base); assert.equal(w.entry().base_repair.status, "verified");
  w.gh.data.pr.mergeable = "CONFLICTING"; await w.tick();
  assert.equal(w.entry().reason, "base-repair-iterations"); assert.equal(w.raw.started.length, 2);
});

test("changed brief, carried instructions, permissions and checkout identity block repair without resnapshot", async t => {
  for (const fault of ["brief", "source", "worktree-source", "permission", "session", "base", "outside", "unsupported"]) await t.test(fault, async t => {
    const w = world(t, fault === "unsupported" ? { host: "example.test" } : {});
    if (fault === "brief") write(join(w.operator, w.prd), GOOD_PRD.replace("npm test", "npm run different"));
    if (fault === "source") write(join(w.operator, w.source), "changed operator instructions\n");
    if (fault === "worktree-source") write(join(w.tree, w.source), "changed worker instructions\n");
    if (fault === "permission") w.ctx.hosts.credential = fakeCredential(null);
    if (fault === "session") w.state.update(w.id, { session: null });
    if (fault === "base") w.state.update(w.id, { base: null });
    if (fault === "outside") w.ctx.config.worktrees = w.operator;
    const original = w.g(["rev-parse", "HEAD"]); await w.tick();
    assert.equal(w.entry().state, STATES.needsHuman, JSON.stringify(w.entry())); assert.equal(w.raw.started.length, 1);
    assert.equal(w.g(["rev-parse", "HEAD"]), original); assert.equal(w.ctx.readPrd(w.id), GOOD_PRD);
    assert.match(w.entry().last.event, /snapshot|input|credential|session|base|checkout|host/i);
  });
});

test("qualified Bitbucket and GitHub use the identical repair coordinator", async t => {
  const w = world(t, { host: "bitbucket.org" }); await w.tick();
  assert.equal(w.entry().base_repair?.status, "running", JSON.stringify(w.entry()));
  const prompt = w.raw.started.at(-1).args.at(-1);
  assert.match(prompt, /pinned commit/); assert.doesNotMatch(prompt, /gh pr/);
  await w.resolveMerge(); w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
  assert.equal(w.entry().base_repair.status, "verified"); assert.equal(w.entry().state, STATES.prOpen);
});

test("Git never aborts a pre-existing unresolved merge", async t => {
  const w = world(t); await w.tick(); w.beginMerge();
  const before = readFileSync(join(w.tree, ".git/index")), content = readFileSync(join(w.tree, "shared.mjs"));
  await assert.rejects(() => w.git.mergeBase(w.tree, "main"), /Unfinished Git operation/);
  assert.deepEqual(readFileSync(join(w.tree, ".git/index")), before); assert.deepEqual(readFileSync(join(w.tree, "shared.mjs")), content);
});

test("the same task head and base cannot dispatch twice, even if the watcher was reset", async t => {
  const w = world(t);
  w.state.update(w.id, { base_repair_attempts: [`${w.head}:${w.base}`] });
  await w.tick(); await w.tick();
  assert.equal(w.entry().reason, "base-repair-duplicate"); assert.equal(w.raw.started.length, 1);
  assert.equal(w.entry().iteration, 0); assert.equal(w.entry().base_merge.baseSha, w.base);
});

test("transient Git failures retry finitely without creating a repair operation", async t => {
  const w = world(t); let calls = 0;
  w.git.mergeBase = async () => { calls++; throw new Error("temporary fetch outage"); };
  for (let i = 0; i < 6; i++) await w.tick();
  assert.equal(calls, 5); assert.equal(w.entry().reason, "stuck");
  assert.equal(w.entry().base_repair, undefined); assert.equal(w.raw.started.length, 1);
});

test("numeric Git exit codes retain bounded retries for both conflict and feedback merges", async t => {
  for (const hostConflict of [true, false]) await t.test(`host conflict ${hostConflict}`, async t => {
    const w = world(t, { hostConflict }); let calls = 0;
    w.git.mergeBase = async () => { calls++; throw Object.assign(new Error("Git fetch exited with status 128"), { code: 128 }); };
    const session = w.entry().session, cursor = w.entry().cursor;
    for (let i = 0; i < 6; i++) await w.tick();
    assert.equal(calls, 5); assert.equal(w.entry().reason, "stuck");
    assert.equal(w.entry().base_repair, undefined); assert.equal(w.raw.started.length, 1);
    assert.equal(w.entry().session, session); assert.equal(w.entry().iteration, 0);
    assert.deepEqual(w.entry().cursor, cursor); assert.match(w.entry().last.event, /status 128/);
  });
});

test("an active unrelated worker fences the merge and every repair launch", async t => {
  const w = world(t);
  w.raw.start("unrelated", "fixture", [], {});
  w.git.mergeBase = async () => assert.fail("active checkout must not be merged");
  await w.tick();
  assert.equal(w.entry().base_repair, undefined); assert.equal(w.raw.started.length, 2);
});

test("normal fix merge refuses a checkout outside the saved worktree root before touching Git", async t => {
  const w = world(t, { hostConflict: false }); w.ctx.config.worktrees = w.operator;
  w.git.mergeBase = async () => assert.fail("must validate checkout before merging");
  await w.tick();
  assert.equal(w.entry().reason, "base-repair-ownership"); assert.equal(w.raw.started.length, 1);
  assert.equal(w.g(["rev-parse", "HEAD"]), w.head);
});

test("an initial abort failure records the conflict and preserves the failed merge without dispatch", async t => {
  const w = world(t); let aborts = 0;
  w.ctx.git = makeGit({ config: w.ctx.config, identity: fakeIdentity(), exec: async (cmd, args, options) => {
    if (cmd === "git" && args[0] === "merge" && args[1] === "--abort") { aborts++; throw Object.assign(new Error("fixture index write refused"), { code: "ENOSPC" }); }
    return execFileAsync(cmd, args, options);
  } });
  w.ctx.git.originOf = w.git.originOf; w.ctx.git.ensureHttpsRemote = w.git.ensureHttpsRemote;
  await w.tick();
  assert.equal(w.entry().base_merge.resourceCode, "ENOSPC");
  assert.equal(w.entry().base_merge.aborted, false); assert.equal(w.entry().base_merge.head, w.head);
  assert.equal(w.entry().base_merge.baseSha, w.base); assert.match(w.entry().base_merge.why, /CONFLICT/);
  assert.equal(w.entry().state, STATES.needsHuman); assert.equal(w.raw.started.length, 1);
  const index = readFileSync(join(w.tree, ".git/index")), content = readFileSync(join(w.tree, "shared.mjs"));
  await w.tick();
  assert.equal(aborts, 1); assert.deepEqual(readFileSync(join(w.tree, ".git/index")), index);
  assert.deepEqual(readFileSync(join(w.tree, "shared.mjs")), content);
});

test("operator control arriving during dispatch validation prevents a repair launch", async t => {
  const w = world(t), clean = w.git.assertClean;
  w.git.assertClean = async (...args) => {
    await clean(...args);
    if (w.entry().base_repair?.status === "prepared") w.state.update(w.id, { control: { action: "pause", status: "queued" } });
  };
  await w.tick();
  assert.equal(w.raw.started.length, 1); assert.equal(w.entry().base_repair.charged, false);
  assert.equal(w.entry().iteration, 0); assert.match(w.entry().last.event, /ownership changed/);
});

test("repair proof transport retries stop at the shared bound and preserve the terminal run", async t => {
  for (const fault of ["git", "host"]) await t.test(fault, async t => {
    const w = world(t); await w.tick(); await w.resolveMerge();
    w.raw.finish(claudeResultLines(), { exit: 0 }); let calls = 0;
    const failed = async () => { calls++; throw new Error("temporary evidence outage"); };
    if (fault === "git") w.git.fetchBranchHead = failed;
    else w.gh.prView = failed;
    for (let i = 0; i < 5; i++) await w.tick();
    assert.equal(calls, 5); assert.equal(w.entry().reason, "stuck");
    assert.equal(w.entry().base_repair.status, "blocked"); assert.equal(w.entry().last.exit, 0);
    // Stopped entries may observe labels, but never re-enter repair settlement.
    if (fault === "host") w.gh.prView = async () => w.gh.data.pr;
    await w.tick(); await w.tick();
    assert.equal(calls, 5); assert.equal(w.raw.started.length, 2);
  });
});

test("restoring the exact session permits explicit reconciliation of an ownership stop", async t => {
  const w = world(t); await w.tick(); await w.resolveMerge();
  const session = w.entry().session;
  w.state.update(w.id, { session: "foreign-session" }); w.raw.finish(claudeResultLines(), { exit: 0 });
  await w.tick(); assert.equal(w.entry().reason, "base-repair-ownership");
  await assert.rejects(() => resume(w.ctx, { handle: w.id }), /ownership/);
  w.state.update(w.id, { session });
  await resume(w.ctx, { handle: w.id });
  assert.equal(w.entry().base_repair.status, "verified"); assert.equal(w.entry().last.exit, 0);
  assert.equal(w.raw.started.length, 2);
});

test("a failed push can be explicitly reconciled after pushing the saved repair without another worker", async t => {
  const w = world(t); await w.tick();
  const repaired = await w.resolveMerge({ push: false });
  w.raw.finish(claudeResultLines({ ok: false }), { exit: 1 }); await w.tick();
  assert.equal(w.entry().reason, "base-repair-push");
  w.g(["push", "origin", "HEAD:refs/heads/work/repair"]); w.gh.data.pr.headRefOid = repaired; w.gh.data.pr.mergeable = "MERGEABLE";
  const result = await resume(w.ctx, { handle: w.id });
  assert.equal(result.reconciled, true); assert.equal(w.entry().base_repair.status, "verified");
  assert.equal(w.entry().last.exit, 1, "original failed worker outcome remains visible");
  assert.equal(w.entry().state, STATES.prOpen); assert.equal(w.raw.started.length, 2);
});

test("explicit resume retries a proven unsubmitted repair under the same operation and allowance", async t => {
  const w = world(t); w.ctx.hosts.credential = fakeCredential(null);
  w.ctx.config.harness = { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(w.home, "claude") } };
  await w.tick();
  const op = w.entry().base_repair;
  assert.equal(op.charged, false); assert.equal(w.entry().iteration, 0);
  w.ctx.hosts.credential = fakeCredential();
  const result = await resume(w.ctx, { handle: w.id });
  assert.equal(result.run, w.entry().last.run); assert.equal(w.entry().base_repair.operationId, op.operationId);
  assert.equal(w.entry().base_repair_attempts.length, 1); assert.equal(w.entry().iteration, 1); assert.equal(w.raw.started.length, 2);
});

test("retired agent instructions and exhausted saved allowance still block normal runner admission", async t => {
  for (const fault of ["instructions", "allowance"]) await t.test(fault, async t => {
    const w = world(t);
    if (fault === "allowance") w.state.update(w.id, { task: { deliveryAllowance: { budgetUsd: 0, runtimeMs: 1000 } } });
    else {
      w.state.update(w.id, { learning: { rules: [{ id: "retired" }] } });
      w.ctx.learning = { identityFor: () => ({}), mode: () => "off" };
    }
    await w.tick(); assert.equal(w.raw.started.length, 1); assert.equal(w.entry().state, STATES.needsHuman);
    assert.match(w.entry().last.event, /retired|allowance/i); assert.equal(w.entry().iteration, 0);
  });
});

test("repaired head waits for fresh reviewer clearance and the completion gate before integration", async t => {
  const w = world(t); w.ctx.config.deliverable = { ...CONFIG.deliverable, evaluator: "local" };
  await w.tick(); const repaired = await w.resolveMerge();
  w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
  w.gh.data.pr.statusCheckRollup = [{ status: "COMPLETED", conclusion: "SUCCESS" }];
  w.gh.data.pr.body += `\n\`\`\`work-attestations\n${JSON.stringify({ task_id: w.id, output_type: "code",
    summary: "Reconciled the overlapping base and task behavior, preserved both histories, and verified positive and negative inputs with the existing tests before pushing the merge.",
    criteria_attestations: [1, 2].map(i => ({ criterion_id: `ac-${i}`, met: true, evidence: "test/base-repair.test.mjs native merge fixtures" })) })}\n\`\`\`\n`;
  const clearance = head => review({ id: 20, by: "chatgpt-codex-connector[bot]", bot: true, at: at(8), body: `Reviewed commit: \`${head}\`` });
  w.gh.data.reviews = [clearance(w.head)]; w.clock.advance(3); await w.tick();
  assert.equal(w.entry().state, STATES.prOpen, "old head clearance never qualifies the repaired code");
  w.gh.data.reviews = [clearance(repaired)]; await w.tick();
  assert.equal(w.entry().state, STATES.ready, JSON.stringify(w.entry()));
  assert.equal(w.entry().completionEvidence.delivery.gate.allow, true);
  assert.equal(w.entry().completionEvidence.delivery.head, repaired);
  w.gh.data.pr.state = "MERGED"; w.gh.data.pr.mergedAt = at(10); w.gh.data.pr.mergeCommit = { oid: repaired };
  w.clock.advance(2); await w.tick();
  assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().completionEvidence.integration.qualified, true);
});

test("a maintainer merge closes repaired tasks without inventing readiness or repeating work", async t => {
  for (const status of ["verified", "blocked"]) await t.test(status, async t => {
    const w = world(t); await w.tick(); const repaired = await w.resolveMerge();
    w.raw.finish(claudeResultLines(), { exit: 0 }); await w.tick();
    w.state.update(w.id, e => ({ state: STATES.needsHuman, reason: "base-repair-review",
      base_repair: { ...e.base_repair, status } }));
    const before = structuredClone(w.entry()); let cleaned = 0;
    w.ctx.cleanupMergedWorkspace = async () => { cleaned++; return { status: "retained", reason: "local work preserved" }; };
    w.g(["merge", "--ff-only", "work/repair"], w.origin);
    w.gh.containsCommit = async (repository, base, sha) => {
      assert.equal(repository, w.entry().repo);
      w.g(["merge-base", "--is-ancestor", sha, base], w.origin);
      return true;
    };
    w.gh.data.pr.state = "MERGED"; w.gh.data.pr.mergedAt = at(10); w.gh.data.pr.mergeCommit = { oid: repaired };
    await w.tick();
    assert.equal(w.entry().state, STATES.done); assert.equal(w.entry().reason, null);
    assert.equal(w.entry().completionEvidence.integration.qualified, false);
    assert.equal(w.entry().completionEvidence.terminal.head, repaired);
    assert.equal(w.entry().base_repair.status, status, "a merge cannot certify an unproved repair");
    assert.deepEqual(w.entry().firstPartyReview, before.firstPartyReview);
    assert.equal(w.entry().iteration, before.iteration); assert.equal(w.entry().session, before.session);
    assert.equal(cleaned, 1); assert.equal(w.raw.started.length, 2);
    assert.equal(readFileSync(join(w.tree, "shared.mjs"), "utf8"), combined);
    await w.tick(); assert.equal(w.entry().state, STATES.done); assert.equal(w.raw.started.length, 2);
  });
});
