import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRemote, repositoryIdentity, remoteMatches, safeOrigin } from "../lib/repository.mjs";
import { makeHostRegistry, hosts, pullRequestUrl } from "../lib/hosts.mjs";
import { github, normalizePr, normalizeEvent, normalizeCheck } from "../lib/hosts/github.mjs";
import { assertRepositoryAccess } from "../lib/host_contract.mjs";
import { capabilitiesFor } from "../lib/harness.mjs";
import { makeState, newEntry, entryId, idSlug, resolveHandle, advanceCursor } from "../lib/state.mjs";
import { makeGit, worktreePath, runEnv } from "../lib/git.mjs";
import { makeGh } from "../lib/gh.mjs";
import { makeTick } from "../lib/tick.mjs";
import { deriveEvents, makeTrust, reviewerVerdict, eventKey } from "../lib/events.mjs";
import { tickChains } from "../lib/chains.mjs";
import { startPrompt } from "../lib/prompt.mjs";
import { resolveCredentialFor } from "../lib/credential.mjs";
import { resume } from "../lib/commands/resume.mjs";
import { validateRepos } from "../lib/config.mjs";
import { reviewCommand } from "../lib/commands/review.mjs";
import { selectReviewPolicy } from "../lib/review_policy.mjs";
import { CONFIG, T0, at, tempHome, prFixture, review, fakeGh, fakeGit, fakeNotify, fakeRunner, makeClock, silentLog } from "./helpers.mjs";

// Deliberately not a shipped adapter. No scheduler, event, completion or chain fork.
const synthetic = (api, overrides = {}) => ({
  ...github, host: "forge.example", id: "fixture-pull-request",
  remote: r => ({ host: r.host, path: r.path, protocol: "https", url: `https://${r.host}/${r.path}.git` }),
  parsePr: url => { const m = url.match(/^https:\/\/forge\.example\/([^/]+\/[^/]+)\/changes\/([1-9]\d*)$/); return m ? { repo: `forge.example/${m[1]}`, number: Number(m[2]) } : null; },
  prUrl: (r, n) => `https://${r.host}/${r.path}/changes/${n}`,
  credential: async (_config, r) => ({ host: r.host, token: "fixture-credential" }),
  create: () => api,
  prompts: { create: () => "fixture-cli propose", inspect: () => "Inspect the proposed change.", check: ({ check }) => `. See ${check.url}.`, editReceipt: "Update the proposal receipt." },
  ...overrides,
});
const thirdPr = extra => ({ ...normalizePr(prFixture()), source: { host: "forge.example", adapter: "fixture-pull-request" }, url: "https://forge.example/acme/widget/changes/142", ...extra });
const thirdEntry = extra => ({ ...newEntry({ repo: "forge.example/acme/widget", harness: "codex", branch: "work/test", base: "main", worktree: "/fixture", pr: 142, url: "https://forge.example/acme/widget/changes/142", nowIso: T0, state: "pr-open" }), cursor: { since: T0, fixed_sha: "a1b2c3d", dispatched: [] }, rereview: { at: T0, nudged: false }, ...extra });

test("review commands qualify canonical hosts and invalidate through their selected label adapter", async () => {
  for (const action of ["policy", "dispute"]) for (const labels of [true, false]) {
    const calls = [], adapter = synthetic({ removeLabel: async (...args) => calls.push(["remove", ...args]) });
    adapter.capabilities = { ...adapter.capabilities, labels };
    const registry = makeHostRegistry({ adapters: [adapter] }), state = makeState(tempHome()), id = "forge.example/acme/widget/test";
    state.put(id, thirdEntry({ firstPartyReview: { result: { findings: [{ id: "finding" }] } } }));
    const ctx = { state, hosts: registry, host: registry.api, runnerFor: () => ({ current: () => null }),
      gh: new Proxy({}, { get: () => assert.fail("review command bypassed the selected adapter") }),
      reviewService: { qualify: async repo => { calls.push(["qualify", repo]); return { qualified: false }; },
        preflight: async repo => { calls.push(["preflight", repo]); return selectReviewPolicy(CONFIG, repo); } } };
    await reviewCommand(ctx, { action: "qualify", repo: "FORGE.EXAMPLE/Acme/Widget" });
    assert.deepEqual(calls.shift(), ["qualify", "forge.example/acme/widget"]);
    await reviewCommand(ctx, { action, handle: id, finding: "finding", mode: "external-required", reason: "Operator requested re-evaluation" });
    assert.equal(state.get(id).review_readiness, null);
    assert.equal(calls.filter(c => c[0] === "remove").length, Number(labels));
    if (labels) assert.deepEqual(calls.at(-1).slice(0, 3), ["remove", "acme/widget", 142]);
    await assert.rejects(reviewCommand(ctx, { action: "qualify", repo: "unknown.example/acme/widget", run: true }), /Unsupported/);
  }
});

test("canonical origins retain GitHub forms and reject ambiguous or secret-bearing diagnostics", () => {
  for (const url of ["https://GITHUB.com/Acme/Widget.git", "https://name:SECRET@github.com/acme/widget/", "http://github.com/acme/widget", "git@github.com:acme/widget.git", "ssh://git@github.com/acme/widget.git"]) {
    const r = parseRemote(url);
    assert.equal(r.host, "github.com"); assert.equal(r.path, "acme/widget"); assert.equal(r.remoteIdentity, "github.com/acme/widget");
    assert.ok(remoteMatches(url, "acme/widget")); assert.doesNotMatch(JSON.stringify(r), /SECRET/);
  }
  for (const url of ["https://github.com.evil/acme/widget.git", "git@bitbucket.org:acme/widget.git"]) {
    assert.throws(() => hosts.fromRemote(url), /Unsupported repository host/);
    assert.equal(remoteMatches(url, "acme/widget"), false);
  }
  for (const url of ["", "/tmp/repo", "file:///tmp/repo", "https://github.com:443/acme/widget", "https://github.com/acme/../widget", "https://github.com/acme/%2e%2e", "https://github.com/acme/widget?token=SECRET", "ssh://name:SECRET@github.com/acme/widget", "https://name:SECRET@github.com/acme/widget#frag"]) {
    assert.throws(() => parseRemote(url), error => !error.message.includes("SECRET"));
    assert.doesNotMatch(safeOrigin(url), /SECRET/);
  }
  for (const url of ["https://user:SECRET@github.com/acme/widget/pull/1", "https://evil.test/github.com/acme/widget/pull/1", "https://github.com/acme/widget/pull/1/trailing"]) assert.throws(() => hosts.fromUrl(url));
  assert.doesNotMatch(validateRepos(["https://user:SECRET@github.com/acme/widget", { repo: "https://user:SECRET@github.com/acme/widget" }]).join("\n"), /SECRET|user:/);
});

test("legacy state is read byte-for-byte with stable IDs and cursor keys; ambiguity refuses recovery", () => {
  const home = tempHome(), file = join(home, "state.json");
  const entry = { ...thirdEntry(), repo: "acme/widget", url: "https://github.com/acme/widget/pull/142" }; delete entry.host;
  entry.cursor = { since: T0, dispatched: ["review:42"], fixed_sha: "head", receipt_hash: "receipt" };
  const original = { version: 1, entries: { "acme/widget/test": entry }, chains: { release: { repo: "acme/widget", steps: [{ id: "acme/widget/test", merged: null }], index: 0 } } };
  writeFileSync(file, JSON.stringify(original));
  const state = makeState(home);
  assert.deepEqual(state.load(), JSON.parse(JSON.stringify(original))); assert.equal(readFileSync(file, "utf8"), JSON.stringify(original));
  assert.equal(entryId("acme/widget", "test"), "acme/widget/test");
  assert.deepEqual(advanceCursor(entry.cursor, T0, ["review:42"]), entry.cursor);
  assert.equal(resolveHandle(state.entries(), "widget#142"), "acme/widget/test");
  writeFileSync(file, JSON.stringify({ ...original, entries: { "acme/widget/test": { ...entry, host: "forge.example" } } }));
  assert.throws(() => state.load(), /back up state.*Do not redispatch/);
  writeFileSync(file, JSON.stringify({ ...original, entries: { "acme/widget/test": entry, "acme/widget/duplicate": entry } }));
  assert.throws(() => state.load(), /Duplicate saved PR identity/);
  assert.throws(() => hosts.select({ ...entry, pr: 143 }), /Ambiguous saved PR identity.*Do not redispatch/);
});

test("two hosts cannot collide in state, worktrees, run folders, cursors, handles or UI links", () => {
  const registry = makeHostRegistry({ adapters: [github, synthetic({})] });
  const a = "acme/widget", b = "forge.example/acme/widget", first = entryId(a, "test"), second = entryId(b, "test");
  assert.notEqual(first, second); assert.notEqual(idSlug(first), idSlug(second));
  assert.notEqual(worktreePath(CONFIG, a, "test"), worktreePath(CONFIG, b, "test"));
  const entries = [[first, { repo: a, pr: 142 }], [second, { repo: b, pr: 142 }]];
  assert.throws(() => resolveHandle(entries, "widget#142"), /qualified host/);
  assert.throws(() => resolveHandle(entries, "acme/widget#142"), /qualified host/);
  assert.equal(resolveHandle(entries, "github.com/acme/widget#142"), first);
  assert.equal(resolveHandle(entries, "forge.example/acme/widget#142"), second);
  assert.equal(pullRequestUrl(b, 142, registry), "https://forge.example/acme/widget/changes/142");
  assert.notEqual(pullRequestUrl(a, 142, registry), pullRequestUrl(b, 142, registry));
});

test("normalized GitHub feedback retains legacy dispatch keys and uses one review decision", () => {
  const raw = review({ id: 42, by: "chatgpt-codex-connector", bot: true, at: at(1), state: "CHANGES_REQUESTED", body: "[P1] Fix this" }); raw.commit_id = "a1b2c3d";
  const record = normalizeEvent(raw, "review"), trust = makeTrust(CONFIG, "me");
  assert.equal(record.eventId, "42"); assert.equal(record.headSha, "a1b2c3d"); assert.equal(record.actor.bot, true); assert.equal(record.source.host, "github.com"); assert.equal(record.at, at(1));
  const input = { pr: normalizePr(prFixture()), reviews: [record], inline: [], comments: [], entry: thirdEntry(), trust };
  const events = deriveEvents(input).events;
  assert.deepEqual(events.map(eventKey), ["review:42"]);
  assert.equal(deriveEvents({ ...input, entry: { ...input.entry, cursor: { since: at(1), dispatched: ["review:42"] } } }).events.length, 0);
  const neutral = { eventId: record.eventId, actor: record.actor, source: { host: "forge.example" }, headSha: record.headSha, at: record.at, state: record.state, body: record.body };
  assert.deepEqual(deriveEvents({ ...input, reviews: [neutral] }).events.map(eventKey), ["review:42"]);
  const judge = reviews => reviewerVerdict({ reviews, inline: [], config: CONFIG, trust, sinceIso: T0, headSha: "a1b2c3d" });
  assert.deepEqual(judge([record]), judge([neutral]));
});

test("registry resolves credentials per adapter and repository on every operation", async () => {
  const resolved = [], sent = [];
  let token = "first-token";
  const adapter = host => synthetic({}, {
    host, id: `fixture-${host}`, credential: async (_config, r) => { resolved.push(r.remoteIdentity); return { host: r.host, repository: r.path, token }; },
    create: ({ credential }) => ({ user: async () => { const value = await credential({}); sent.push(value); return host; } }),
  });
  const registry = makeHostRegistry({ adapters: [adapter("first.example"), adapter("second.example")], config: { repos: ["second.example/acme/widget"] } });
  assert.equal(await registry.api.user(), "second.example");
  await registry.api.userFor("first.example/acme/widget");
  token = "reauthenticated-token";
  await registry.api.userFor("first.example/acme/other");
  await registry.api.userFor("first.example/acme/widget");
  assert.deepEqual(resolved, ["second.example/acme/widget", "first.example/acme/widget", "first.example/acme/other", "first.example/acme/widget"]);
  assert.deepEqual(sent.map(r => r.token), ["first-token", "first-token", token, token]);
  assert.deepEqual(sent.map(r => r.repository), ["acme/widget", "acme/widget", "acme/other", "acme/widget"]);
});

test("provider access declarations allow a qualified local host and refuse bound-provider mismatches", () => {
  const r = repositoryIdentity("forge.example/acme/widget");
  assert.doesNotThrow(() => assertRepositoryAccess(capabilitiesFor("codex"), r));
  assert.doesNotThrow(() => assertRepositoryAccess(capabilitiesFor("openai-agents"), r));
  assert.throws(() => assertRepositoryAccess(capabilitiesFor("codex-cloud"), r), /cannot access repository host/);
  const registry = makeHostRegistry({ adapters: [synthetic({})] });
  const prompt = startPrompt({ repo: r.key, host: registry.select(r).adapter.prompts, prd: { text: "approved" }, branch: "work/test", base: "main", verify: [] });
  assert.match(prompt, /fixture-cli propose/); assert.doesNotMatch(prompt, /gh pr create/);
  assert.throws(() => makeHostRegistry({ adapters: [synthetic({}, { capabilities: { ...github.capabilities, checks: false } })] }).select(r), /lacks required checks evidence/);
});

test("native clone uses only the verified host URL and a credential bound to that host and repository", async () => {
  const calls = [], home = tempHome();
  const registry = makeHostRegistry({ credential: async ({ host }) => ({ host, token: "fixture-credential" }) });
  const git = makeGit({ config: { worktrees: home }, hosts: registry, exec: async (cmd, args, options) => {
    calls.push({ cmd, args, env: options.env });
    return { stdout: args[0] === "remote" ? "https://github.com/acme/widget.git" : "" };
  } });
  await git.create({ nameWithOwner: "acme/widget", prdId: "test", base: "main" });
  assert.equal(calls[0].cmd, "git"); assert.equal(calls[0].args[0], "clone");
  assert.ok(calls[0].args.includes("https://github.com/acme/widget.git"));
  assert.equal(calls[0].env.GIT_CREDENTIAL_HOST, "github.com"); assert.equal(calls[0].env.GIT_CREDENTIAL_REPOSITORY, "acme/widget");
  assert.doesNotMatch(JSON.stringify(calls.map(({ cmd, args }) => [cmd, args])), /fixture-credential|gh/);
  const before = calls.length;
  await assert.rejects(() => git.create({ nameWithOwner: "bitbucket.org/acme/widget", prdId: "unsupported", base: "main" }), /Unsupported/);
  assert.equal(calls.length, before);
});

test("credential fill refuses foreign hosts, repositories, redirects and inherited helpers", () => {
  const root = tempHome(), token = "fixture-credential";
  execFileSync("git", ["init", "-q", root]);
  // A local read can lazily fetch a partial clone's missing objects. Without
  // bound credentials even repository-configured SSH must remain unreachable.
  execFileSync("git", ["-C", root, "config", "core.sshCommand", "sh -c 'echo AMBIENT_SSH >&2; exit 1'"]);
  assert.throws(() => execFileSync("git", ["ls-remote", "ssh://git@fixture.invalid/acme/widget"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, ...runEnv() }, stdio: ["ignore", "pipe", "pipe"],
  }), error => !`${error.message}${error.stderr}`.includes("AMBIENT_SSH"));
  execFileSync("git", ["-C", root, "config", "credential.helper", "!echo password=ambient-secret"]);
  const env = { PATH: process.env.PATH, HOME: root, GIT_TERMINAL_PROMPT: "0", ...runEnv(null, { host: "github.com", repository: "acme/widget", token }) };
  const fill = (host, path, protocol = "https") => execFileSync("git", ["credential", "fill"], { cwd: root, env, input: `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  assert.match(fill("github.com", "acme/widget.git"), /password=fixture-credential/);
  for (const [host, path, protocol] of [["evil.test", "acme/widget", "https"], ["github.com", "elsewhere/repo", "https"], ["github.com", "acme/widget", "http"]]) {
    assert.throws(() => fill(host, path, protocol), error => !`${error.stdout}${error.stderr}${error.message}`.includes(token) && !`${error.stdout}`.includes("ambient-secret"));
  }
  assert.equal(execFileSync("git", ["config", "--get", "http.followRedirects"], { cwd: root, env, encoding: "utf8" }).trim(), "false");
});

test("mismatched checkout and API credentials stop before transport, and errors redact secrets", async () => {
  let calls = 0;
  await assert.rejects(() => resolveCredentialFor({ git: { originOf: async () => "https://evil.test/acme/widget" }, credential: async () => { calls++; return { token: "secret" }; } }, { worktree: "/fixture", repo: "acme/widget" }), /mismatch/);
  assert.equal(calls, 0);
  const api = makeGh({ credential: async () => ({ host: "evil.test", token: "secret" }), exec: async () => { calls++; } });
  await assert.rejects(() => api.user(), /mismatch/); assert.equal(calls, 0);
  const ssh = makeHostRegistry({ credential: async () => ({ host: "github.com", sshKey: "/fixture/id" }) });
  await assert.rejects(() => ssh.api.user(), /SSH key/);
  const fail = async () => { const error = Object.assign(new Error("fixture-secret at https://user:URLSECRET@github.com/acme/widget"), { stderr: "denied fixture-secret", stdout: "fixture-secret" }); void error.stack; throw error; };
  const redacted = error => !JSON.stringify({ message: error.message, stderr: error.stderr, stdout: error.stdout, stack: error.stack }).match(/fixture-secret|URLSECRET|user:/);
  const failing = makeGh({ credential: async () => ({ host: "github.com", token: "fixture-secret" }), exec: fail });
  await assert.rejects(() => failing.prView("acme/widget", 142), redacted);
  const git = makeGit({ config: { worktrees: tempHome() }, credential: async () => ({ host: "github.com", token: "fixture-secret" }), exec: fail });
  await assert.rejects(() => git.create({ nameWithOwner: "acme/widget", prdId: "redacted", base: "main" }), redacted);
});

test("incomplete, unauthorized and rate-limited host reads preserve state and never yield readiness", async () => {
  for (const failure of [{ items: [], complete: false }, Object.assign(new Error("HTTP 429"), { retryAfter: 10 }), new Error("HTTP 401")]) {
    const home = tempHome(), state = makeState(home), id = "forge.example/acme/widget/test", clock = makeClock(at(2));
    state.put(id, thirdEntry());
    const api = fakeGh({ pr: thirdPr() });
    api.reviews = async () => { if (failure instanceof Error) throw failure; return failure; };
    const registry = makeHostRegistry({ adapters: [synthetic(api)] });
    const before = state.get(id);
    const ctx = { home, config: CONFIG, hosts: registry, host: registry.api, state, clock, ownLogin: "me", git: fakeGit(), runnerFor: () => fakeRunner(clock), log: silentLog, notify: fakeNotify(), readPrd: () => null };
    const result = await makeTick(ctx).tick();
    assert.equal(result[0].ok, false); assert.deepEqual(state.get(id).cursor, before.cursor); assert.equal(state.get(id).state, "pr-open");
    assert.ok(!api.calls.some(c => c[0] === "addLabel"));
  }
  assert.throws(() => normalizePr(prFixture({ statusCheckRollup: null })), /Incomplete/);
  assert.throws(() => normalizeCheck({ name: "unknown" }), /Incomplete/);
});

test("synthetic host uses the shared readiness and merge-proof chain, with optional labels absent", async () => {
  const home = tempHome(), state = makeState(home), id = "forge.example/acme/widget/test", clock = makeClock(at(20));
  const entry = thirdEntry({ base: "main", start_token: "owned", chain: { name: "release", index: 0, dispatch: "dispatch" } });
  state.put(id, entry);
  const source = { host: "forge.example", adapter: "fixture-pull-request" };
  const check = { source, actor: { login: "ci", bot: true }, eventId: "ci-1", headSha: "a1b2c3d", createdAt: T0, updatedAt: at(1), name: "tests", outcome: "passed" };
  const approval = { source, actor: { login: "chatgpt-codex-connector", bot: true }, eventId: "approval-1", headSha: "a1b2c3d", createdAt: at(1), updatedAt: at(1), at: at(1), state: "APPROVED", body: "Approved." };
  const api = fakeGh({ pr: thirdPr({ headRefName: "work/test", statusCheckRollup: [check] }), reviews: [approval] });
  const registry = makeHostRegistry({ adapters: [synthetic(api, { capabilities: { ...github.capabilities, labels: false } })] });
  const runner = fakeRunner(clock);
  const ctx = { home, config: { ...CONFIG, deliverable: null }, hosts: registry, host: registry.api, state, clock, ownLogin: "me", git: fakeGit(), runnerFor: () => runner, log: silentLog, notify: fakeNotify(), readPrd: () => null };
  assert.equal((await makeTick(ctx).tick())[0].ok, true);
  assert.equal(state.get(id).state, "ready-for-human");
  assert.ok(!api.calls.some(c => /Label/.test(c[0])));
  // Persist the existing ownership shape; no new chain state machine or host branch.
  state.update(id, { state: "done" });
  const chain = { name: "release", repo: entry.repo, base: "main", status: "active", index: 0, failures: 0,
    steps: [{ id, checkout: null, dispatch: "dispatch", entry: { token: "owned", pr: 142 }, merged: null }], created_at: T0, updated_at: T0 };
  // The entry pre-exists, so fixture writes the recorded v1 chain directly.
  const saved = state.load(); saved.chains = { release: chain }; writeFileSync(state.file, JSON.stringify(saved));
  const sha = "a".repeat(40);
  api.data.pr = thirdPr({ state: "MERGED", headRefName: "work/test", mergedAt: at(1), mergeCommit: { oid: sha } });
  let contains = false; api.containsCommit = async () => contains;
  await tickChains(ctx); assert.equal(state.getChain("release").index, 0); assert.equal(state.getChain("release").status, "stopped");
  state.updateChain("release", { status: "active", reason: null }); contains = true;
  await tickChains(ctx); assert.equal(state.getChain("release").status, "done"); assert.equal(state.getChain("release").steps[0].merged.sha, sha);
});

test("saved-repository binding refuses retargeted origins and push URLs before resolving a token", async () => {
  for (const changed of ["https://github.com/acme/other.git", "https://user:SECRET@github.com/acme/widget.git", "git@github.com:acme/widget.git"]) {
    let credentials = 0, network = 0;
    const registry = makeHostRegistry({ credential: async ({ host }) => { credentials++; return { host, token: "fixture-credential" }; } });
    const git = makeGit({ hosts: registry, exec: async (_cmd, args) => { if (args[0] === "push") network++; return { stdout: changed }; } });
    await assert.rejects(() => git.pushResult("/fixture", "work/test", "acme/widget"), error => /mismatch/.test(error.message) && !error.message.includes("SECRET"));
    assert.equal(credentials, 0); assert.equal(network, 0);
  }
  let credentials = 0;
  const registry = makeHostRegistry({ credential: async () => { credentials++; return { token: "fixture-credential" }; } });
  const git = makeGit({ hosts: registry, exec: async (_cmd, args) => ({ stdout: args.includes("--push") ? "https://evil.test/acme/widget.git" : "https://github.com/acme/widget.git" }) });
  await assert.rejects(() => git.pushSnapshotRef("/fixture", "work/test-input", "acme/widget"), /mismatch/);
  assert.equal(credentials, 0);
});

test("GitHub incomplete pages and bounded lists fail closed; recovery metadata writes are idempotent", async () => {
  let response = null, writes = 0;
  const raw = makeGh({ exec: async () => ({ stdout: JSON.stringify(response) }) });
  await assert.rejects(() => raw.reviews("acme/widget", 142), /Incomplete host page/);
  response = [[]]; assert.deepEqual(await raw.reviews("acme/widget", 142), []);
  response = null;
  await assert.rejects(() => raw.publishResultPr({ repo: "acme/widget", branch: "work/test", base: "main", title: "Fixture", body: "Fixture" }), /Incomplete result PR list/);
  const pr = prFixture({ headRefName: "work/test" });
  const registry = makeHostRegistry({ credential: async () => ({ host: "github.com", token: "fixture-credential" }), exec: async (_cmd, args) => {
    if (args[0] === "pr" && args[1] === "edit") { writes++; pr.body = args[args.indexOf("--body") + 1]; return { stdout: "" }; }
    return { stdout: JSON.stringify(pr) };
  } });
  const identity = { prd: "docs/test.md", harness: "codex", session: null, branch: "work/test" };
  await registry.api.setRecoveryMetadata("acme/widget", 142, identity);
  await registry.api.setRecoveryMetadata("acme/widget", 142, identity);
  assert.equal(writes, 1);
  const incomplete = makeHostRegistry({ credential: async () => ({ token: "fixture-credential" }), exec: async () => ({ stdout: JSON.stringify(Array(100).fill(pr)) }) });
  await assert.rejects(() => incomplete.api.prListMine("acme/widget"), /Incomplete PR recovery list/);
  const ambiguous = makeHostRegistry({ credential: async () => ({ token: "fixture-credential" }), exec: async () => ({ stdout: JSON.stringify([prFixture(), prFixture({ number: 143 })]) }) });
  await assert.rejects(() => ambiguous.api.prListByHead("acme/widget", "work/test"), /Ambiguous PR ownership.*Do not redispatch/);
});

test("resume refuses an incompatible saved host/provider before checkout recovery", async () => {
  const home = tempHome(), state = makeState(home), id = "forge.example/acme/widget/test";
  state.put(id, thirdEntry({ state: "needs-human", harness: "codex-cloud", session: "task_owned" }));
  let clones = 0;
  const registry = makeHostRegistry({ adapters: [synthetic({})] });
  await assert.rejects(() => resume({ home, state, hosts: registry, config: CONFIG, git: { fromBranch: async () => { clones++; } } }, { handle: id }), /cannot access repository host/);
  assert.equal(clones, 0); assert.equal(state.get(id).state, "needs-human");
});
