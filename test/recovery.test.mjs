// `reconcile` in lib/commands/up.mjs: the boot path that rebuilds the registry from GitHub after state.json is
// lost. Every assertion here is about what the operator gets back, and about what is deliberately not replayed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile, upInBackground } from "../lib/commands/up.mjs";
import { makeState } from "../lib/state.mjs";
import { renderBlock } from "../lib/block.mjs";
import { receiptHash } from "../lib/deliverable.mjs";
import { ROUND_MARKER, RESET_MARKER, NUDGE_MARKER } from "../lib/gh.mjs";
import { deriveEvents, makeTrust } from "../lib/events.mjs";
import { CONFIG, T0, at, tempHome, prFixture, comment, silentLog, STATES, fakeCredential, fakeIdentity } from "./helpers.mjs";
import { join } from "node:path";
import { nowIso } from "../lib/time.mjs";
import { codeStamp, writeJsonAtomic } from "../lib/fs.mjs";
import { processIdentity } from "../lib/daemon.mjs";

const SESSION = "6f1c2d3e-1111-4111-8111-111111111111";

const blockBody = (over = {}) =>
  `Adds export.\n\n${renderBlock({ prd: "docs/prds/widget-export.md", harness: "claude", session: SESSION, branch: "gallivant/widget-export", ...over })}\n`;

const openPr = (over = {}) => prFixture({ number: 142, headRefName: "gallivant/widget-export", body: blockBody(), createdAt: T0, headRefOid: "a1b2c3d", ...over });

/** A world for reconcile: one repo in config, whatever PRs and comments the test names, PRD snapshots in memory. */
function world({ prs = [openPr()], comments = [], commitDates = {}, files = {}, snapshots = new Map() } = {}) {
  const home = tempHome();
  const logged = [];
  const log = { info: m => logged.push(["info", m]), warn: m => logged.push(["warn", m]), error: m => logged.push(["error", m]), latest: () => null };
  const ctx = { credential: fakeCredential(), identity: fakeIdentity(),
    home,
    config: { ...CONFIG, home },
    state: makeState(home),
    log,
    gh: {
      prListMine: async () => prs,
      issueComments: async () => comments,
      commitDate: async (_r, sha) => commitDates[sha] ?? null,
      fileAt: async (_r, path) => files[path] ?? null,
    },
    readPrd: id => snapshots.get(id) ?? null,
    writePrd: (id, text) => snapshots.set(id, text),
  };
  return { ctx, logged, snapshots, id: "acme/widget/widget-export" };
}

test("an open PR of ours with a valid block is adopted with its identity taken from the block and the PR", async () => {
  const w = world();
  const added = await reconcile(w.ctx, "me");

  assert.deepEqual(added, [w.id], "the id is the repo plus the PRD id from the branch");
  const e = w.ctx.state.get(w.id);
  assert.equal(e.state, STATES.prOpen, "a recovered PR is watched, not restarted");
  assert.equal(e.pr, 142);
  assert.equal(e.url, "https://github.com/acme/widget/pull/142");
  assert.equal(e.repo, "acme/widget");
  assert.equal(e.branch, "gallivant/widget-export");
  assert.equal(e.harness, "claude", "the harness comes from the block, so the right CLI resumes");
  assert.equal(e.session, SESSION, "and the session id, so the run resumes rather than starting over");
  assert.equal(e.prd, "docs/prds/widget-export.md");
  assert.equal(e.worktree, `${CONFIG.worktrees}/acme/widget/widget-export`, "the checkout path is derived, and recreated lazily by the tick");
});

test("boot recovery preserves pending starts instead of adopting their PR or overwriting their snapshots", async () => {
  const w = world();
  const claim = w.ctx.state.claimStart(w.id);
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.get(w.id), null);
  assert.equal(w.ctx.state.startClaim(w.id).token, claim.token);
  assert.equal(w.snapshots.size, 0);
  assert.ok(w.logged.some(([, message]) => /reserved/.test(message)));
});

test("a reservation racing boot recovery cannot prevent the daemon from starting", async () => {
  const w = world();
  w.ctx.gh.issueComments = async () => { w.ctx.state.claimStart(w.id); return []; };
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.get(w.id), null);
  assert.ok(w.ctx.state.startClaim(w.id));
});

test("a slow recovery fetch cannot replace the snapshot approved by a concurrent start", async () => {
  const w = world();
  w.ctx.gh.fileAt = async () => {
    w.ctx.state.claimStart(w.id);
    w.ctx.writePrd(w.id, "Approved operator brief");
    return "Different PR branch brief";
  };
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.readPrd(w.id), "Approved operator brief");
});

test("the recovered iteration is the count of our own round comments since the last reset comment", async () => {
  const w = world({
    comments: [
      comment({ id: 1, by: "me", at: at(1), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 2, by: "me", at: at(2), body: `Watching again from here.\n\n${RESET_MARKER}` }),
      comment({ id: 3, by: "me", at: at(3), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 4, by: "me", at: at(4), body: `@codex review\n\n${NUDGE_MARKER}` }),
      comment({ id: 5, by: "me", at: at(5), body: `@codex review\n\n${ROUND_MARKER}` }),
      comment({ id: 6, by: "someone-else", at: at(6), body: `@codex review\n\n${ROUND_MARKER}` }),
    ],
  });
  await reconcile(w.ctx, "me");

  assert.equal(w.ctx.state.get(w.id).iteration, 2, "two rounds after the reset: the nudge and another login's comment do not count");
});

test("the recovered cursors sit at the head and the last own comment, so no history is replayed", async () => {
  const w = world({
    comments: [comment({ id: 1, by: "me", at: at(10), body: `@codex review\n\n${ROUND_MARKER}` })],
    commitDates: { a1b2c3d: at(4) },
  });
  await reconcile(w.ctx, "me");
  const e = w.ctx.state.get(w.id);

  assert.equal(e.cursor.since, at(10), "the later of the head's commit date and our last comment, so neither is re-read as new");
  assert.deepEqual(e.cursor.dispatched, [], "a fresh boundary has nothing already handled at it");
  assert.equal(e.cursor.checks_sha, null, "no head's failing checks count as dispatched on a recovery, the same answer register gives");
  assert.equal(e.cursor.fixed_sha, "a1b2c3d", "and the head is the push baseline, so nothing reads as a fresh push");
  assert.equal(e.rereview.nudged, false);
});

test("a recovered entry's reviewer clock is floored at the nudge window, so a stale PR is not stopped on the first tick", async () => {
  // `reconcile` wrote `later(lastOwn, pr.createdAt)` raw. A PR whose last round comment was older than `stall_hours`
  // was stopped `reviewer-silent` on the FIRST tick after a crash recovery, for silence that accrued while no daemon
  // was running to ask, and the operator had to `register` it to get it back. The clock now goes through
  // `reviewerClock`, the same function the tick's own writers use, so a recovered entry gets the grace a nudged one does.
  const w = world({
    comments: [comment({ id: 1, by: "me", at: at(10), body: `@codex review\n\n${ROUND_MARKER}` })],
    commitDates: { a1b2c3d: at(4) },
  });
  await reconcile(w.ctx, "me");
  const { rereview } = w.ctx.state.get(w.id);

  // The floor is `rereview_minutes` before now, and `reconcile` reads the wall clock, so the assertion is on the age.
  const waited = Date.now() - Date.parse(rereview.at);
  assert.ok(waited >= 0, `the ask is not in the future (${rereview.at})`);
  assert.ok(waited <= CONFIG.rereview_minutes * 60_000 + 5_000, `the ask is no older than the nudge window, not the comment's own age (${rereview.at})`);
  assert.ok(Date.parse(rereview.at) > Date.parse(at(10)), "so the two-day-old round comment is not what the stall timer measures from");
  assert.ok(waited < CONFIG.stall_hours * 3_600_000, "and nothing about it is already past the reviewer-silent threshold");
});

test("with no comments of ours the cursor falls back to the head's commit date", async () => {
  const w = world({ commitDates: { a1b2c3d: at(7) } });
  await reconcile(w.ctx, "me");
  assert.equal(w.ctx.state.get(w.id).cursor.since, at(7));
});

test("when GitHub cannot date the head the cursor falls back to the PR's creation time", async () => {
  const w = world({ prs: [openPr({ createdAt: at(3) })] });
  await reconcile(w.ctx, "me");
  assert.equal(w.ctx.state.get(w.id).cursor.since, at(3));
});

test("a PR whose head is on a fork is ignored: the daemon never pushes to someone else's branch", async () => {
  const w = world({ prs: [openPr({ isCrossRepository: true })] });
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 0);
});

test("a PR on a branch that is not ours is skipped before its body is even parsed", async () => {
  // The branch check comes first, and it has to: the block's own rules only describe `gallivant/*` branches, so a
  // hand-made branch could never carry a block reconcile would accept. `register` is how such a PR joins the loop.
  // Skipping it silently is the point; a warning per foreign PR would bury the ones that are actually broken.
  const w = world({ prs: [openPr({ headRefName: "feature/hand-made", body: blockBody() })] });
  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 0);
  assert.deepEqual(w.logged, [], "no warning, because there is nothing wrong with a PR that is simply not ours");
});

test("a PR with a missing or malformed block is ignored and the reason is logged", async () => {
  const cases = [
    ["Adds export.\n", /no block/],
    [`Adds export.\n\n<!-- gallivant\nprd: docs/prds/widget-export.md\nharness: claude\nsession: ${SESSION}\n`, /unterminated block/],
    ["Adds export.\n\n<!-- gallivant\nharness: claude\nsession: none\nbranch: gallivant/widget-export\n-->\n", /missing prd/],
    [blockBody({ harness: "bash" }), /invalid harness: bash/],
    [blockBody({ session: "not-a-uuid" }), /invalid session: not-a-uuid/],
    [blockBody({ prd: "../../etc/passwd.md" }), /invalid prd/],
    [blockBody({ branch: "gallivant/other" }), /block branch differs from head/],
  ];
  for (const [body, expected] of cases) {
    const w = world({ prs: [openPr({ body })] });
    assert.deepEqual(await reconcile(w.ctx, "me"), [], `adopted a PR whose block says: ${body.slice(0, 60)}`);
    assert.equal(w.ctx.state.entries().length, 0);
    assert.ok(w.logged.some(([level, m]) => level === "warn" && expected.test(m)), `nothing logged matching ${expected} (got ${JSON.stringify(w.logged)})`);
  }
});

test("a PR already in the registry is left exactly as it is, never adopted a second time", async () => {
  const w = world();
  await reconcile(w.ctx, "me");
  const first = w.ctx.state.get(w.id);

  const added = await reconcile(w.ctx, "me");
  assert.deepEqual(added, [], "the second boot recovers nothing");
  assert.deepEqual(w.ctx.state.get(w.id), first, "and the entry the daemon has been updating is untouched");
  assert.equal(w.ctx.state.entries().length, 1);
});

test("a PR already watched under a different id is recognised by its number, not by the id recovery would pick", async () => {
  // `register` keys an entry off the branch it was given, which need not be the id the branch convention yields.
  // A PR is one entry; finding it by number is what keeps a recovery from opening a second one beside it.
  const w = world();
  w.ctx.state.put("acme/widget/export-by-hand", { repo: "acme/widget", pr: 142, branch: "gallivant/widget-export", state: STATES.prOpen, iteration: 4 });

  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.entries().length, 1, "no second entry for a PR that is already watched");
  assert.equal(w.ctx.state.get("acme/widget/export-by-hand").iteration, 4, "and the round count the daemon has been keeping survives");
});

test("an id already taken by another entry is refused rather than overwriting it", async () => {
  const w = world();
  const other = { ...prFixture(), repo: "acme/widget", pr: 999, state: STATES.prOpen, branch: "gallivant/widget-export" };
  w.ctx.state.put(w.id, other);

  assert.deepEqual(await reconcile(w.ctx, "me"), []);
  assert.equal(w.ctx.state.get(w.id).pr, 999, "the entry that holds the id keeps it");
  assert.ok(w.logged.some(([level, m]) => level === "warn" && /already in use/.test(m)));
});

test("the PRD snapshot is fetched from the PR branch when the daemon has none", async () => {
  const w = world({ files: { "docs/prds/widget-export.md": "# Widget export\n" } });
  const asked = [];
  w.ctx.gh.fileAt = async (repo, path, ref) => { asked.push([repo, path, ref]); return "# Widget export\n"; };

  await reconcile(w.ctx, "me");
  assert.deepEqual(asked, [["acme/widget", "docs/prds/widget-export.md", "gallivant/widget-export"]], "read at the PR's branch, where the session left it");
  assert.equal(w.snapshots.get(w.id), "# Widget export\n", "the snapshot the completion gate reads is restored");
  assert.ok(w.logged.some(([, m]) => /PRD snapshot taken from the PR branch/.test(m)), "and the log says the session could have edited that copy");
});

test("a snapshot the daemon still has is kept, and the branch is not read", async () => {
  const snapshots = new Map([["acme/widget/widget-export", "# The daemon's own copy\n"]]);
  const w = world({ snapshots, files: { "docs/prds/widget-export.md": "# The branch copy\n" } });
  let asked = 0;
  w.ctx.gh.fileAt = async () => { asked++; return "# The branch copy\n"; };

  await reconcile(w.ctx, "me");
  assert.equal(asked, 0, "the authoritative snapshot is never replaced by the agent-writable copy");
  assert.equal(snapshots.get(w.id), "# The daemon's own copy\n");
});

test("a PRD the PR branch does not have is logged as a skipped completion gate, not silently ignored", async () => {
  const w = world({ files: {} });
  await reconcile(w.ctx, "me");

  assert.equal(w.snapshots.size, 0);
  assert.ok(
    w.logged.some(([level, m]) => level === "warn" && /not found on gallivant\/widget-export; the completion gate is skipped/.test(m)),
    `no warning about the missing snapshot (got ${JSON.stringify(w.logged)})`,
  );
  assert.equal(w.ctx.state.get(w.id).state, STATES.prOpen, "the PR is still watched; only the gate is affected");
});

test("a repo whose PR listing fails is logged and the next repo is still reconciled", async () => {
  const w = world();
  w.ctx.config = { ...w.ctx.config, repos: ["acme/broken", "acme/widget"] };
  w.ctx.gh.prListMine = async repo => { if (repo === "acme/broken") throw new Error("gh: 403"); return [openPr()]; };

  assert.deepEqual(await reconcile(w.ctx, "me"), [w.id]);
  assert.ok(w.logged.some(([level, m]) => level === "warn" && /reconcile acme\/broken: gh: 403/.test(m)));
});

test("a snapshot that cannot be taken does not stop the daemon from watching the PR", async () => {
  // `reconcile` runs before the first tick and outside the loop's catch, so an error escaping the snapshot would take
  // the daemon down before it watched anything. The snapshot only decides whether the completion gate runs.
  for (const [what, break_] of [
    ["GitHub cannot be reached", ctx => { ctx.gh.fileAt = async () => { throw new Error("HTTP 502: Bad gateway"); }; }],
    ["the snapshot cannot be written", ctx => { ctx.writePrd = () => { throw new Error("EACCES: permission denied"); }; }],
  ]) {
    const w = world({ files: { "docs/prds/widget-export.md": "# Widget export\n" } });
    break_(w.ctx);
    const added = await reconcile(w.ctx, "me");
    assert.deepEqual(added, [w.id], `${what}: the PR is still adopted`);
    assert.equal(w.ctx.state.get(w.id).state, STATES.prOpen);
    assert.ok(w.logged.some(([, m]) => /PRD snapshot not taken/.test(m)), `${what}: the reason is logged (got ${JSON.stringify(w.logged)})`);
  }
});


test("a recovered entry carries the receipt already on the PR, so a run that changed nothing is not a round", () => {
  // `reconcile` wrote `receipt_hash: null` while holding the body that has the receipt in it. `settleRun` then read
  // any pre-existing receipt as a change, so a run that did nothing counted as a round and posted "Completion receipt
  // updated." to the PR, which `countRounds` read back as a real round on the recovery after that.
  const body = `Adds export.\n\n\`\`\`gallivant-attestations\n{"task_id":"t","criteria_attestations":[]}\n\`\`\`\n${renderBlock({ prd: "docs/prds/widget-export.md", harness: "claude", session: SESSION, branch: "gallivant/widget-export" })}\n`;
  const w = world({ prs: [openPr({ body })] });
  return reconcile(w.ctx, "me").then(() => {
    const e = w.ctx.state.get(w.id);
    assert.equal(e.cursor.receipt_hash, receiptHash(body), "the fingerprint is the one the body already carries");
    assert.notEqual(e.cursor.receipt_hash, null);
    // A PR with no receipt at all still recovers as null, which is the honest answer for a body with nothing in it.
    const bare = world();
    return reconcile(bare.ctx, "me").then(() => assert.equal(bare.ctx.state.get(bare.id).cursor.receipt_hash, null));
  });
});

test("a red head at recovery is dispatched, not suppressed: reconcile and register give the same answer", async () => {
  // `reconcile` set `checks_sha` to the recovered head, which told `deriveEvents` those failures had already been sent.
  // `register` set it to null for the same situation, so the same red PR was dispatched or ignored depending on which
  // command adopted it, with neither file acknowledging the other.
  //
  // Null is the right answer for both. A fix that had been dispatched AND had pushed would have moved the head, so red
  // checks on the head that is actually there have not been addressed by anything. And suppressing them was not the same
  // as stopping for them: `checks-red` only fires when the reviewer verdict is not "waiting", and on a recovery with a
  // bot reviewer that has said nothing it is waiting, so the entry sat on an unaddressed red head until it stopped with
  // `reviewer-silent`, naming a reviewer problem for a CI problem.
  const w = world({ commitDates: { a1b2c3d: at(4) } });
  await reconcile(w.ctx, "me");
  const e = w.ctx.state.get(w.id);

  assert.equal(e.cursor.checks_sha, null, "no head's failures count as dispatched on a recovery");
  assert.equal(e.cursor.fixed_sha, "a1b2c3d", "which is a different question from which head the loop last acted on");

  // Read through the rule that consumes it: the failing check on the recovered head is a new event.
  const pr = openPr({ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/widget/actions/runs/9981/job/1", completedAt: at(5) }] });
  const { events } = deriveEvents({ pr, reviews: [], inline: [], comments: [], entry: e, trust: makeTrust(CONFIG, "me") });
  assert.deepEqual(events.map(x => [x.kind, x.name]), [["check", "test"]], "so the loop fixes the red head instead of waiting on a reviewer for it");
});

// `start` brings the daemon up, because a session that opens a pull request nobody watches is a silent stall. The
// operator hit exactly that: they ran `start`, the docs never said a second command was needed, and the PR sat there.
test("upInBackground starts a daemon, waits for it to report itself, and does nothing when one is already alive", async () => {
  const home = tempHome();
  const ctx = { credential: fakeCredential(), identity: fakeIdentity(), home, log: silentLog };
  // The fake child writes the daemon file the way the real `up` does, a moment after being spawned.
  let spawned = 0;
  const fakeSpawn = () => { spawned++; setTimeout(() => writeJsonAtomic(join(home, "daemon.json"), { pid: process.pid, identity: processIdentity(process.pid), startedAt: nowIso() }), 5); return { unref() {}, exitCode: null }; };
  const started = await upInBackground(ctx, { spawnFn: fakeSpawn, sleep: ms => new Promise(r => setTimeout(r, ms)) });
  assert.equal(started.pid, process.pid, "it returns the daemon it waited for, not the child handle");
  assert.equal(spawned, 1);
  // A second call must not add another daemon: two ticking at once would double every comment and every run.
  assert.equal(await upInBackground(ctx, { spawnFn: fakeSpawn }), null);
  assert.equal(spawned, 1, "no second process");
});

test("upInBackground reports a daemon that died immediately rather than waiting out the timeout", async () => {
  const home = tempHome();
  // A bad config kills the daemon on boot. That must read as a failure with somewhere to look, not as a long pause.
  const dead = () => ({ unref() {}, exitCode: 1 });
  await assert.rejects(() => upInBackground({ home, log: silentLog }, { spawnFn: dead, waitMs: 5_000 }), /exited immediately/);
});

test("background startup never reports a stale daemon as usable, before or during startup", async () => {
  const home = tempHome();
  const record = { pid: process.pid, identity: processIdentity(process.pid), code: 1 };
  assert.ok(record.identity);
  writeJsonAtomic(join(home, "daemon.json"), record);
  let spawned = 0;
  const spawnFn = () => {
    spawned++;
    writeJsonAtomic(join(home, "daemon.json"), record);
    return { unref() {}, exitCode: null };
  };
  await assert.rejects(() => upInBackground({ home }, { spawnFn }), /older code.*gallivant down && gallivant up/);
  assert.equal(spawned, 0, "do not start a competing daemon or signal the existing one");
  writeJsonAtomic(join(home, "daemon.json"), { ...record, stoppedAt: T0 });
  await assert.rejects(() => upInBackground({ home }, { spawnFn }), /older code/);
  assert.equal(spawned, 1, "a stale owner that appears during startup is refused too");
  writeJsonAtomic(join(home, "daemon.json"), { ...record, code: codeStamp() });
  assert.equal(await upInBackground({ home }, { spawnFn }), null);
  assert.equal(spawned, 1);
});

test("upInBackground gives up with the log to read when the daemon never reports itself", async () => {
  const home = tempHome();
  const silent = () => ({ unref() {}, exitCode: null });   // spawns, writes nothing, never dies
  await assert.rejects(() => upInBackground({ home, log: silentLog }, { spawnFn: silent, waitMs: 60, sleep: ms => new Promise(r => setTimeout(r, ms)) }), /did not report itself/);
});
