import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLearningService } from "../lib/learning.mjs";
import { learningStore, safePath } from "../lib/learning_store.mjs";
import { canonical, parseJson, candidate, hash, minimized } from "../lib/learning_data.mjs";
import { makeTrust } from "../lib/events.mjs";
import { learnCommand } from "../lib/commands/learn.mjs";
import { makeGh } from "../lib/gh.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";

import { fixture, pending, observed, proposed, snapshot, repo, now } from "./learning-fixtures.mjs";
const foreign = { host: "github.com", id: "9999" };
const trust = makeTrust({ trusted_authors: ["maintainer"], reviewer: { login: "reviewer[bot]" } }, "maintainer");

test("canonical JSON follows RFC 8785 number, escaping and UTF-16 order vectors", () => {
  assert.equal(canonical(parseJson('{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"€$\\u000f\\nA\\\\B\\\"/","literals":[null,true,false]}')), '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\\\\B\\\"/"}');
  assert.equal(canonical({ "\u20ac": 1, "\r": 2, "\ud83d\ude00": 3, "\ufb33": 4, "1": 5 }), '{"\\r":2,"1":5,"€":1,"😀":3,"דּ":4}');
  assert.equal(canonical({ n: -0 }), '{"n":0}');
});

test("hostile JSON and candidate fields are rejected before hashing", () => {
  for (const raw of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"__proto__":{}}', '{"x":1e999}', '"\\ud800"', '[1] trailing']) assert.throws(() => parseJson(raw));
  assert.throws(() => parseJson(Buffer.from([0xc0, 0xaf])));
  const good = proposed("a".repeat(64));
  assert.equal(candidate(good, repo).digest, hash(good));
  for (const changes of [{ approved: true }, { repo: foreign }, { paths: ["../key"] }, { paths: ["/tmp"] }, { paths: ["src/**"] }, { paths: [".codex"] }, { guidance: "hello\u001b[2J" }, { guidance: "hello\u202e" }, { guidance: "Disable APort gates" }, { guidance: "token=supersecret" }, { evidence: ["https://malicious.example"] }, { provenance: { ...good.provenance, command: "touch x" } }]) assert.throws(() => candidate({ ...good, ...changes }, repo));
});

test("collection uses shared eligibility and records bounded independent source revisions", async t => {
  const { service, store } = fixture(t);
  assert.equal((await service.observe(repo, snapshot())).skipped, "learning off");
  await observed(service);
  const before = store.load(repo), key = Object.keys(before.observations)[0], item = before.observations[key].content;
  assert.equal(item.author, "reviewer"); assert.equal(item.originalSha, "a".repeat(40)); assert.equal(item.fixSha, "b".repeat(40));
  assert.equal((await service.observe(repo, snapshot())).duplicates, 1);
  assert.equal((await service.observe(repo, snapshot("edited guidance", { updated_at: "2026-10-06T01:00:00Z" }))).added, 1);
  assert.equal(Object.keys(store.load(repo).observations).length, 2);
  assert.equal(store.load(repo).observations[key].superseded, true);
  assert.equal((await service.observe(repo, snapshot("untrusted", { user: { login: "outsider", type: "User" } }))).eligible, 0);
  assert.equal(Object.hasOwn(store.load(repo), "cursor"), false); assert.equal(Object.hasOwn(store.load(repo), "iteration"), false);
});

test("deletion requires full source enumeration and does not alter candidate content", async t => {
  const { service, store } = fixture(t);
  const c = await pending(service, store);
  await service.observe(repo, { pr: snapshot().pr, inline: [] });
  const key = c.content.evidence[0]; assert.equal(store.load(repo).observations[key].deleted, false);
  await service.observe(repo, { pr: snapshot().pr, inline: [], completeKinds: ["inline"] });
  assert.equal(store.load(repo).observations[key].deleted, true);
  assert.equal(service.show(repo, c.content.id, c.digest).digest, c.digest);
});

test("out-of-order automatic observations retain only the newest source revision", async t => {
  const { service, store } = fixture(t);
  await observed(service);
  await service.observe(repo, snapshot("Newest correction", { updated_at: "2026-10-06T02:00:00Z" }));
  await service.observe(repo, snapshot("Delayed correction", { updated_at: "2026-10-06T01:00:00Z" }));
  const current = Object.values(store.load(repo).observations).filter(o => !o.superseded);
  assert.equal(current.length, 1); assert.equal(current[0].content.excerpt, "Newest correction");
});

test("historical merges reconcile concurrent source revisions without losing dispositions", async t => {
  for (const newer of ["automatic", "historical"]) {
    let injected = false, service, store;
    const historical = snapshot("Historical correction", { updated_at: newer === "historical" ? "2026-10-06T02:00:00Z" : "2026-10-06T01:00:00Z" });
    const automatic = snapshot("Automatic correction", { updated_at: newer === "automatic" ? "2026-10-06T02:00:00Z" : "2026-10-06T01:00:00Z" });
    const gh = { learningPage: async (_name, kind) => {
      if (kind === "inline" && !injected) {
        injected = true;
        await service.observe(repo, automatic);
        await service.reject(repo, c.content.id, c.digest, "Keep rejection across scan merges");
      }
      return { items: kind === "pulls" ? [historical.pr] : kind === "inline" ? historical.inline : [], complete: true };
    } };
    ({ service, store } = fixture(t, { gh }));
    const c = await pending(service, store);
    assert((await service.collect(repo, "example/project")).complete);
    const state = store.load(repo), current = Object.values(state.observations).filter(o => !o.superseded);
    assert.equal(Object.keys(state.observations).length, 3);
    assert.equal(current.length, 1); assert.equal(current[0].content.excerpt, newer === "automatic" ? "Automatic correction" : "Historical correction");
    assert.equal(service.show(repo, c.content.id, c.digest).status, "rejected");
    await service.collect(repo, "example/project");
    assert.deepEqual(Object.values(store.load(repo).observations).filter(o => !o.superseded), current);
  }
});

test("candidate review, exact rejection suppression, revision and overlap conflicts persist", async t => {
  const { service, store, root } = fixture(t);
  const c = await pending(service, store);
  await service.reject(repo, c.content.id, c.digest, "contested correction");
  assert.equal((await service.revise(repo, c.content.id, c.content)).status, "rejected");
  const revision = await service.revise(repo, c.content.id, { ...c.content, guidance: "Validate fields together before persistence." });
  assert.equal(revision.status, "pending"); assert.notEqual(revision.digest, c.digest);
  assert.throws(() => service.show(repo, c.content.id), /exact/);
  await service.revise(repo, "lesson-overlap", { ...c.content, id: "lesson-overlap", guidance: "Validate records as one transaction." });
  assert.equal(service.show(repo, c.content.id, revision.digest).conflicts.length, 1);
  const restarted = createLearningService({ root });
  assert.equal(restarted.show(repo, c.content.id, c.digest).reason, "contested correction");
});

test("historical pagination scans old PR updates; dry-run never writes or infers", async t => {
  const calls = [], gh = { learningPage: async (_name, kind, { page }) => { calls.push([kind, page]); if (kind === "pulls") return { items: [snapshot().pr], complete: true }; if (kind === "inline") return { items: page === 1 ? snapshot().inline : [{ ...snapshot().inline[0], id: 78 }], complete: page === 2 }; return { items: [], complete: true }; } };
  const { service, store, root } = fixture(t, { gh, extractor: { execute() { throw new Error("paid work forbidden"); } } });
  const dry = await service.collect(repo, "example/project", { since: "2026-10-01", until: "2026-10-07", dryRun: true });
  assert.equal(dry.eligible, 2); assert.equal(dry.complete, true); assert.equal(readdirSync(join(root, "..")).includes("state"), false);
  await service.configure(repo, "collect");
  const scan = await service.collect(repo, "example/project", { since: "2026-10-01", until: "2026-10-07" });
  assert.equal(scan.added, 2); assert.equal(scan.pages, 5);
  assert.equal((await service.collect(repo, "example/project", { since: "2026-10-01", until: "2026-10-07" })).duplicates, 2);
  assert.equal(store.load(repo).observations[Object.keys(store.load(repo).observations)[0]].content.createdAt, "2026-09-15T00:00:00Z");
  assert(calls.some(c => c[0] === "inline" && c[1] === 2));
});

test("rate-limit continuation survives restart without acknowledging a coding cursor", async t => {
  let limited = true, time = Date.parse(now);
  const gh = { learningPage: async (_name, kind) => kind === "pulls" ? { items: [snapshot().pr], complete: true } : limited ? { items: [], complete: false, rateLimited: true, retryAt: time + 60_000 } : { items: kind === "inline" ? snapshot().inline : [], complete: true } };
  const { service, store, root } = fixture(t, { gh, clock: { now: () => time } });
  await service.configure(repo, "collect");
  const r = await service.collect(repo, "example/project"); assert.equal(r.retryAt, time + 60_000);
  const restarted = createLearningService({ root, store, trust, gh, clock: { now: () => time } });
  assert.equal((await restarted.collect(repo, "example/project")).pages, 0);
  assert.equal((await restarted.collect(repo, "example/project", { since: "2026-09-01" })).pages, 0, "another date range cannot bypass repository backoff");
  limited = false; time += 60_001;
  const resumed = await restarted.collect(repo, "example/project");
  assert.equal(resumed.added, 1); assert.equal(resumed.id, r.id); assert.equal(resumed.until, r.until);
});

test("default scan windows survive page caps, advancing clocks, dry-run and restart", async t => {
  for (const variant of ["default", "since", "legacy"]) {
    let time = Date.parse(now);
    const calls = [], options = variant === "since" ? { since: "2026-10-01" } : {};
    const gh = { learningPage: async (_name, kind, { pr }) => {
      calls.push([kind, pr]);
      return { items: kind === "pulls" ? Array.from({ length: 20 }, (_, i) => ({ ...snapshot().pr, number: i + 1 })) : kind === "inline" ? snapshot().inline : [], complete: true };
    } };
    const { service, store, root } = fixture(t, { gh, clock: { now: () => time } });
    await service.configure(repo, "collect");
    const first = await service.collect(repo, "example/project", options);
    assert.equal(first.capped, true); assert.equal(first.complete, false);
    assert.equal(first.continuation.page, 1); assert.equal(first.continuation.index, 19);
    if (variant === "legacy") await store.transaction(repo, s => { delete s.scans[0].request; });
    time += 86400_000;
    const restarted = createLearningService({ root, store, trust, gh, clock: { now: () => time } });
    const before = canonical(store.load(repo)); calls.length = 0;
    const dry = await restarted.collect(repo, "example/project", { ...options, dryRun: true });
    assert.equal(dry.id, first.id); assert.equal(dry.until, first.until); assert.equal(dry.complete, true);
    assert.equal(canonical(store.load(repo)), before); assert(calls.filter(([kind]) => kind !== "pulls").every(([, pr]) => pr === 20));
    const resumed = await restarted.collect(repo, "example/project", options);
    assert.equal(resumed.id, first.id); assert.equal(resumed.since, first.since); assert.equal(first.added + resumed.added, 20);
    assert.equal(resumed.complete, true); assert.equal(Object.keys(store.load(repo).observations).length, 20);
    const next = await restarted.collect(repo, "example/project", { ...options, dryRun: true });
    assert.notEqual(next.id, first.id); assert.equal(next.until, new Date(time).toISOString());
    const explicit = await restarted.collect(repo, "example/project", { since: "2026-10-01", until: "2026-10-06", dryRun: true });
    assert.equal(explicit.until, "2026-10-06T00:00:00.000Z"); assert.notEqual(explicit.id, first.id);
  }
});

test("historical dismissals preserve retraction metadata and exclude stale extraction evidence", async t => {
  let time = Date.parse(now), dismissed = false, removed = false, duringScan = null;
  const review = { id: 9, user: { login: "reviewer[bot]", type: "Bot" }, state: "CHANGES_REQUESTED", body: "Validate the whole record.", submitted_at: "2026-10-06T00:00:00Z" };
  const gh = { learningPage: async (_name, kind) => {
    if (kind === "pulls" && duringScan) { const run = duringScan; duringScan = null; await run(); }
    return { items: kind === "pulls" ? [snapshot().pr] : kind === "reviews" ? [{ ...review, state: dismissed ? "DISMISSED" : review.state }] : kind === "inline" && !removed ? [{ ...snapshot().inline[0], pull_request_review_id: 9 }] : [], complete: true };
  } };
  let extracted;
  const { service, store, root } = fixture(t, { gh, clock: { now: () => time }, qualify: () => ({ qualified: true, fixtureOnly: true }), extractor: { dataOnly: true, execute: async input => { extracted = input.observations; return { json: "[]" }; } } });
  await service.configure(repo, "collect"); await service.collect(repo, "example/project");
  const original = store.load(repo), evidence = Object.keys(original.observations);
  assert.equal(evidence.length, 2);
  const c = await service.revise(repo, "lesson-validation", proposed(evidence[0], { evidence }));
  dismissed = true; time += 60_000;
  const before = canonical(store.load(repo));
  await service.collect(repo, "example/project", { dryRun: true }); assert.equal(canonical(store.load(repo)), before);
  // Collection merges a stale snapshot over a concurrent candidate disposition.
  duringScan = () => service.reject(repo, c.content.id, c.digest, "Review was dismissed");
  await service.collect(repo, "example/project");
  const retractedAt = new Date(time).toISOString();
  const restarted = createLearningService({ root });
  const shown = restarted.show(repo, c.content.id, c.digest);
  assert.equal(shown.status, "rejected"); assert.equal(shown.digest, c.digest);
  for (const e of shown.evidence) {
    assert.equal(e.retracted, true); assert.equal(e.retractedAt, retractedAt);
    assert.equal(hash(e.content), e.digest); assert.deepEqual(e.content, original.observations[e.digest].content);
  }
  time += 60_000; removed = true; await service.collect(repo, "example/project");
  for (const e of service.list(repo)[0].evidence) assert.equal(e.retractedAt, retractedAt);
  assert(service.show(repo, c.content.id, c.digest).evidence.some(e => e.deleted));
  await service.observe(repo, snapshot("Unrelated current feedback", { id: 88 }));
  await service.extract(repo, { allowanceUsd: 0.1 });
  assert.equal(extracted.length, 1); assert.equal(extracted[0].id, "88");
});

test("resolved visibility survives CLI collection, review and extraction without widening identity", async t => {
  let visibility = "private", resolvedId = repo.id, extracted;
  const gh = { learningRepository: async () => ({ ...repo, id: resolvedId, visibility }), learningPage: async (_name, kind) => ({ items: kind === "pulls" ? [snapshot().pr] : kind === "inline" ? snapshot().inline : [], complete: true }) };
  const { service, store, root } = fixture(t, { gh, qualify: () => ({ qualified: true, fixtureOnly: true }), extractor: { dataOnly: true, execute: async input => { extracted = input.observations; return { json: "[]" }; } } });
  const ctx = { learning: service };
  await learnCommand(ctx, { args: [], values: { repo: "example/project", "dry-run": true } });
  assert.equal(readdirSync(join(root, "..")).includes("state"), false);
  await learnCommand(ctx, { args: ["configure"], values: { repo: "example/project", mode: "collect" } });
  await learnCommand(ctx, { args: [], values: { repo: "example/project" } });
  assert.deepEqual(service.identityFor("example/project"), repo);
  const evidence = Object.keys(store.load(repo).observations)[0];
  const c = await service.revise(repo, "lesson-validation", proposed(evidence));
  const restarted = createLearningService({ root });
  assert.equal(restarted.show(repo, c.content.id, c.digest).evidence[0].content.visibility, "private");
  await service.extract(repo, { allowanceUsd: 0.1 });
  assert.equal(extracted[0].visibility, "private"); assert.deepEqual(extracted[0].repo, repo);
  visibility = "public"; assert.deepEqual(await service.resolveRepo("example/project"), repo);
  await service.observe(repo, snapshot("New public source", { id: 88 }));
  assert.equal(Object.values(store.load(repo).observations).find(o => o.content.id === "88").content.visibility, "public");
  resolvedId = foreign.id; await service.resolveRepo("example/project");
  await service.observe(repo, snapshot("Unresolved source identity", { id: 89 }));
  assert.equal(Object.values(store.load(repo).observations).find(o => o.content.id === "89").content.visibility, "unknown");
  await service.observe(repo, { ...snapshot("Invalid visibility", { id: 90 }), visibility: "private\u001b[2J" });
  assert.equal(Object.values(store.load(repo).observations).find(o => o.content.id === "90").content.visibility, "unknown");
});

test("transport failure checkpoints coverage without writes during dry-run", async t => {
  const { service, store } = fixture(t, { gh: { learningPage: async () => { throw new Error("transport unavailable"); } } });
  await service.configure(repo, "collect");
  const before = canonical(store.load(repo));
  const dry = await service.collect(repo, "example/project", { dryRun: true });
  assert.equal(dry.complete, false); assert.equal(dry.error.code, "LEARNING_TRANSPORT"); assert.equal(canonical(store.load(repo)), before);
  const saved = await service.collect(repo, "example/project"); assert.equal(saved.complete, false); assert.equal(store.load(repo).scans.length, 1);
});

test("relative reviewed JSON files work and read-only CLI explain accepts --run RUN_ID", async t => {
  const { service, store, dir } = fixture(t);
  const c = await pending(service, store), path = join(dir, "reviewed-rule.json");
  writeFileSync(path, canonical({ ...c.content, guidance: "Validate complete records before persistence." }));
  const next = await service.reviseFromFile(repo, c.content.id, relative(process.cwd(), path)); assert.equal(next.status, "pending");
  const home = join(dir, "cli-home"); mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "config.json"), canonical({ trusted_authors: ["maintainer"], harness: { codex: { bin: "/fixture/not-launched" } }, notify: null, worktrees: join(dir, "worktrees") }));
  const cliStore = learningStore(join(home, "learning")); cliStore.remember("example/project", repo);
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url)), "learn", "explain", "--repo", "example/project", "--run", "run-not-delivered"], { env: { ...process.env, GALLIVANT_HOME: home }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), []);
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url)), "--help"], { encoding: "utf8" }); assert.match(help, /learn explain --repo owner\/repo --run RUN_ID/);
  const hostile = spawnSync(process.execPath, [fileURLToPath(new URL("../bin/gallivant.mjs", import.meta.url)), "learn", "--evil\u001b[2J"], { encoding: "utf8" });
  assert.equal(hostile.status, 1); assert(!hostile.stderr.includes("\u001b")); assert.match(hostile.stderr, /\\u001b/);
});

test("expired evidence is hidden in inspection before a mutation and raw retention is applied on observation", async t => {
  let time = Date.parse(now);
  const { service, store } = fixture(t, { clock: { now: () => time } });
  const c = await pending(service, store);
  time += 31 * 86400_000;
  const shown = service.show(repo, c.content.id, c.digest); assert.equal(shown.evidence[0].expired, true); assert.equal(shown.evidence[0].content.excerpt, "[raw excerpt expired]");
  await service.observe(repo, snapshot("fresh source", { updated_at: "2026-11-07T00:00:00Z" }));
  assert.equal(store.load(repo).observations[c.content.evidence[0]].expired, true);
});

test("transport uses bounded typed routes and reports Retry-After", async () => {
  const calls = [];
  const gh = makeGh({ exec: async (_cmd, args) => { calls.push(args); return { stdout: 'HTTP/2.0 200 OK\nLink: <arbitrary>; rel="next"\n\n[{"id":1}]' }; } });
  assert.equal((await gh.learningPage("example/project", "inline", { pr: 2, page: 3 })).complete, false);
  assert(calls[0].includes("repos/example/project/pulls/2/comments?per_page=100&page=3"));
  assert(!calls[0].includes("--paginate"));
  await assert.rejects(gh.learningPage("example/project", "https://attacker"));
  const limited = makeGh({ exec: async () => { throw Object.assign(new Error("limited"), { stdout: "HTTP/2.0 429 Too Many Requests\nRetry-After: 10\n\n{}" }); } });
  const r = await limited.learningPage("example/project", "pulls"); assert.equal(r.rateLimited, true); assert(r.retryAt >= Date.now());
});

test("extraction unavailable preserves collection; inspection cannot start paid work", async t => {
  let calls = 0;
  const { service, store } = fixture(t, { extractor: { dataOnly: true, execute: () => { calls++; } } });
  const c = await pending(service, store);
  assert.equal((await service.extract(repo, { allowanceUsd: 1 })).status, "unavailable");
  service.list(repo); service.show(repo, c.content.id); service.report(repo); service.explain(repo, "run");
  assert.equal(calls, 0); assert.equal(service.report(repo).observations, 1);
  await assert.rejects(service.configure(repo, "apply")); assert.equal(service.mode(repo), "collect");
});

test("bounded extraction validates data atomically and never approves recurrence", async t => {
  let calls = 0;
  const { service, store } = fixture(t, { qualify: () => ({ qualified: true, fixtureOnly: true }), extractor: { dataOnly: true, execute: async input => { calls++; return { json: canonical([proposed(input.observations[0].digest, { provenance: { provider: "fixture", inputDigest: input.inputDigest, at: now } })]), costUsd: null }; } } });
  await observed(service);
  const output = await service.extract(repo, { allowanceUsd: 0.1 }); assert.equal(output.count, 1);
  assert.equal(service.list(repo)[0].status, "pending");
  assert.equal((await service.extract(repo, { allowanceUsd: 0.1 })).count, 1); assert.equal(calls, 1);
  assert.equal(store.load(repo).sequence, 0); assert.equal(service.report(repo).costs.knownUsd, null);
});

test("privacy retention and exports disclose redaction, incomplete evidence and unknown outcomes", async t => {
  const { service, store } = fixture(t, { clock: { now: () => Date.parse(now) + 31 * 86400_000 } });
  await service.configure(repo, "collect");
  const minimizedText = minimized("token=secret \u001b[2J " + "x".repeat(4000)); assert.equal(minimizedText.incomplete, true); assert(!minimizedText.excerpt.includes("secret")); assert(!minimizedText.excerpt.includes("\u001b"));
  await service.observe(repo, snapshot("token=secret"));
  const report = service.report(repo); assert.equal(report.eligibleRunDenominator, 0); assert.match(report.effectiveness, /unmeasured/);
  const state = store.load(repo); Object.values(state.observations)[0].observedAt = now;
  const release = store.lock(); try { store.saveLocked(repo, state); } finally { release(); }
  assert.equal((await service.prune(repo)).expired, 1); assert(Object.values(store.load(repo).observations)[0].expired);
});

test("filesystem refuses symlinks, cross-repository scopes and concurrent mutation", async t => {
  const { service, store, dir } = fixture(t);
  await pending(service, store);
  const target = join(dir, "target"); mkdirSync(target); symlinkSync(target, join(dir, "link"));
  assert.throws(() => safePath(join(dir, "link")), /symlink/);
  assert.throws(() => safePath(join(dir, "link", "key"), { file: true }), /symlink/);
  assert.throws(() => safePath(join(dir, "key\u001b[2J"), { file: true }), /terminal controls/);
  assert.throws(() => safePath(join(dir, "key\u202e"), { file: true }), /terminal controls/);
  assert.throws(() => learningStore(`${dir}/../elsewhere`), /normalized/);
  const release = store.lock(); try { await assert.rejects(service.configure(repo, "off"), /already running/); } finally { release(); }
  assert.equal(service.mode(repo), "collect");
  const path = join(dir, "rule.json"); writeFileSync(path, '{"id":"lesson-x","id":"lesson-y"}');
  await assert.rejects(service.reviseFromFile(repo, "lesson-x", path), /duplicate/);
});

test("legacy learning stores gain an empty preparation archive without read-time writes", async t => {
  const { service, store } = fixture(t);
  await service.configure(repo, "collect");
  const legacy = store.load(repo); delete legacy.preparationHistory;
  const release = store.lock(); try { store.saveLocked(repo, legacy); } finally { release(); }
  const file = join(store.root, `repo-${hash(repo)}.json`), before = readFileSync(file, "utf8");
  assert.deepEqual(store.load(repo).preparationHistory, {});
  assert.deepEqual(service.report(repo).preparations, { pending: 0, obsolete: 0 });
  assert.equal(readFileSync(file, "utf8"), before);
});

test("repository identity lookup forwards cancellation and rejects late aborted results", async t => {
  const controller = new AbortController();
  const gh = makeGh({ exec: async (_cmd, _args, options) => {
    assert.equal(options.signal, controller.signal);
    return { stdout: JSON.stringify({ id: 1234, private: true }) };
  } });
  const { service } = fixture(t, { gh });
  assert.deepEqual(await service.resolveRepo("example/project", { signal: controller.signal }), repo);
  gh.learningRepository = async () => { controller.abort(); return { ...repo, id: "9999" }; };
  await assert.rejects(service.resolveRepo("example/project", { signal: controller.signal }), e => e.name === "AbortError");
});

test("CLI refuses forged flags, unknown commands and implicit approval selection", async t => {
  const { service, store } = fixture(t);
  const c = await pending(service, store);
  const ctx = { learning: service };
  await assert.rejects(learnCommand(ctx, { args: ["activate"], values: { repo: "example/project" } }), /unknown/);
  await assert.rejects(learnCommand(ctx, { args: ["approve", c.content.id], values: { repo: "example/project", yes: true } }), /not allowed/);
  await assert.rejects(learnCommand(ctx, { args: ["approve", c.content.id], values: { repo: "example/project", run: true } }), /not allowed/);
  await assert.rejects(learnCommand(ctx, { args: ["approve", c.content.id], values: { repo: "example/project" } }));
  const before = canonical(store.load(repo));
  await assert.rejects(service.setup({ keyPath: join(store.root, "key"), confirm: () => true }), /terminal/);
  assert.equal(canonical(store.load(repo)), before);
});

test("CLI disables locally during GitHub outages and invokes revocation controls", async t => {
  const controls = [], gh = { learningRepository: async () => { throw new Error("GitHub unavailable"); } };
  const { service, store } = fixture(t, { gh, onRevocation: async intent => { assert.equal(service.mode(repo), "off"); controls.push(intent); return [{ cancellation: { unsupported: true }, freshSessionRequired: true }]; } });
  store.remember("example/project", repo); // Legacy identity-only records remain usable offline.
  await store.transaction(repo, s => { s.mode = "apply"; });
  const result = await learnCommand({ learning: service }, { args: ["configure"], values: { repo: "example/project", mode: "off" } });
  assert.equal(result.mode, "off"); assert.equal(result.controls[0].freshSessionRequired, true);
  assert.equal(controls.length, 1); assert.deepEqual(controls[0].repo, repo);
  assert.deepEqual(service.identityFor("example/project"), repo);
  for (const mode of ["collect", "apply"]) await assert.rejects(learnCommand({ learning: service }, { args: ["configure"], values: { repo: "example/project", mode } }), /GitHub unavailable/);
  await assert.rejects(learnCommand({ learning: service }, { args: ["configure"], values: { repo: "unknown/project", mode: "off" } }), /no learning state/);
  assert.equal(service.mode(repo), "off");
});

test("disabled modes retry revocation after a committed mode and failed controls across restart", async t => {
  for (const mode of ["off", "collect"]) {
    const { service, store, root } = fixture(t, { onRevocation: async () => { throw new Error("registry locked"); } });
    await store.transaction(repo, s => { s.mode = "apply"; });
    await assert.rejects(service.configure(repo, mode), /registry locked/);
    assert.equal(service.mode(repo), mode);
    let calls = 0;
    const restarted = createLearningService({ root, store, onRevocation: async intent => {
      calls++; assert.deepEqual(intent.repo, repo); assert.equal(intent.removed, null);
      return [{ cancellation: { confirmed: true } }];
    } });
    for (let retry = 0; retry < 2; retry++) {
      const result = await restarted.configure(repo, mode);
      assert.equal(result.before, mode); assert.equal(result.controls[0].cancellation.confirmed, true);
    }
    assert.equal(calls, 2);
  }
});


test("oversized PR source pages checkpoint across restart, rate limits and dry-run before reaching older PRs", async t => {
  for (const kind of ["reviews", "inline", "comments"]) {
    let time = Date.parse(now), limited = false;
    const calls = [], raw = snapshot().inline[0];
    const gh = { learningPage: async (_name, source, { pr, page }) => {
      calls.push([source, pr, page]);
      if (source === "pulls") return { items: [snapshot().pr, { ...snapshot().pr, number: 2 }], complete: true };
      if (source !== kind || pr === 2) return { items: [], complete: true };
      if (limited) return { items: [], complete: false, rateLimited: true, retryAt: time + 1000 };
      return { items: Array.from({ length: 100 }, (_, i) => ({ ...raw, id: (page - 1) * 100 + i + 1,
        user: { login: "maintainer" }, state: "CHANGES_REQUESTED", submitted_at: raw.updated_at,
        body: kind === "comments" ? "/fix Validate input" : "Validate input" })), complete: page === 12 };
    } };
    const { service, store, root } = fixture(t, { gh, clock: { now: () => time } });
    await service.configure(repo, "collect");
    const first = await service.collect(repo, "example/project");
    assert(first.capped); assert(first.continuation.source.page > 1);
    const nextPage = first.continuation.source.page;
    const restart = () => createLearningService({ root, store, gh, trust, clock: { now: () => time } });
    limited = true; const throttled = await restart().collect(repo, "example/project");
    assert.equal(throttled.continuation.source.page, nextPage); assert(throttled.retryAt);
    time += 2000; limited = false;
    const before = canonical(store.load(repo)); calls.length = 0;
    const dry = await restart().collect(repo, "example/project", { dryRun: true });
    assert(dry.complete); assert.equal(canonical(store.load(repo)), before);
    assert.equal(calls.find(([source]) => source === kind)[2], nextPage);
    const done = await restart().collect(repo, "example/project");
    assert(done.complete); assert.equal(done.prs, 2);
    assert.equal(Object.keys(store.load(repo).observations).length, 1200);
  }
});

test("large transport pages preserve long bodies while enforcing one shared byte bound", async () => {
  const body = "x".repeat(65536), items = Array.from({ length: 100 }, (_, id) => ({ id, body }));
  let bound;
  const gh = makeGh({ exec: async (_cmd, _args, options) => { bound = options.maxBuffer; return { stdout: "HTTP/2.0 200 OK\n\n" + JSON.stringify(items) }; } });
  const page = await gh.learningPage("example/project", "comments", { pr: 1 });
  assert(page.complete); assert.equal(page.items.length, 100); assert.equal(page.items[99].body, body);
  assert.equal(bound, 64 * 1024 * 1024);
  const tooLarge = makeGh({ exec: async () => ({ stdout: "HTTP/2.0 200 OK\n\n[\"" + "x".repeat(bound) + "\"]" }) });
  await assert.rejects(tooLarge.learningPage("example/project", "comments", { pr: 1 }), /JSON.*limit|JSON.*large/i);
});


test("source checkpoints preserve review eligibility and defer deletions until complete enumeration", async t => {
  let time = Date.parse(now), limited = true;
  const raw = snapshot().inline[0], review = { id: 9, user: raw.user, state: "COMMENTED", body: "Review summary", submitted_at: raw.updated_at };
  const calls = [];
  const gh = { learningPage: async (_name, kind, { page, pr }) => {
    calls.push([kind, page]);
    if (kind === "pulls") return { items: [snapshot().pr], complete: true };
    if (kind === "reviews") return { items: [review, { ...review, id: 10, user: { login: "maintainer" } }], complete: true };
    if (kind === "comments") return { items: [], complete: true };
    if (page === 2 && limited) return { items: [], complete: false, rateLimited: true, retryAt: time + 1000 };
    return { items: page === 1 ? [{ ...raw, id: 100, pull_request_review_id: 9 }, { ...raw, id: 101, user: { login: "maintainer" }, pull_request_review_id: 10 }] : [{ ...raw, id: 77, pull_request_review_id: 9 }], complete: page === 2 };
  } };
  const { service, store, root } = fixture(t, { gh, clock: { now: () => time } });
  await service.configure(repo, "collect");
  await service.observe(repo, { ...snapshot(), inline: [raw, { ...raw, id: 88 }] });
  const first = await service.collect(repo, "example/project");
  assert.equal(first.continuation.source.page, 2);
  assert(Object.values(store.load(repo).observations).every(o => !o.deleted));
  const beforeReport = canonical(store.load(repo)); time += 31 * 86400_000;
  const report = service.report(repo);
  assert(report.scans[0].continuation.source.reviews.every(r => r.excerpt.excerpt === "[raw excerpt expired]"));
  assert.equal(canonical(store.load(repo)), beforeReport); time -= 31 * 86400_000;
  limited = false; time += 2000; calls.length = 0;
  const restarted = createLearningService({ root, store, gh, trust, clock: { now: () => time } });
  assert((await restarted.collect(repo, "example/project")).complete);
  assert(!calls.some(([kind, page]) => kind === "inline" && page === 1));
  const observations = Object.values(store.load(repo).observations);
  assert(observations.some(o => o.content.id === "9" && o.content.sourceDigest === minimized(review.body).sourceDigest));
  assert(!observations.some(o => o.content.id === "101"));
  assert(observations.find(o => o.content.id === "88").deleted);
  assert(!observations.find(o => o.content.id === "77").deleted);
});

test("ineligible raw pages still checkpoint and reach older PRs across the transport page cap", async t => {
  const calls = [];
  const gh = { learningPage: async (_name, kind, { pr, page }) => {
    calls.push([kind, pr, page]);
    if (kind === "pulls") return { items: [snapshot().pr, { ...snapshot().pr, number: 2 }], complete: true };
    if (pr === 1 && kind === "inline") return { items: Array.from({ length: 100 }, (_, i) => ({ ...snapshot().inline[0], id: page * 100 + i, user: { login: "untrusted" } })), complete: page === 65 };
    return { items: pr === 2 && kind === "inline" ? snapshot().inline : [], complete: true };
  } };
  const { service, store, root } = fixture(t, { gh }); await service.configure(repo, "collect");
  const first = await service.collect(repo, "example/project"); assert(first.capped); assert.equal(first.eligible, 0);
  const next = first.continuation.source.page; assert(next > 1);
  calls.length = 0;
  const restarted = createLearningService({ root, store, gh, trust, clock: { now: () => Date.parse(now) } });
  assert((await restarted.collect(repo, "example/project")).complete);
  assert.equal(calls.find(([kind]) => kind === "inline")[2], next);
  assert.equal(Object.values(store.load(repo).observations)[0].content.pr, 2);
});
