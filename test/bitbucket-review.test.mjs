import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fixture, REPO, PATH, UUID, WORKSPACE, USER, HEAD, BASE, NOW, pr, comment, status, page, json } from "./bitbucket-fixture.mjs";
import { CONFIG, tempHome, makeClock, fakeRunner, fakeGit, fakeNotify, fakeIdentity, silentLog, codexLines } from "./helpers.mjs";
import { bitbucket } from "../lib/hosts/bitbucket.mjs";
import { bitbucketVerdict } from "../lib/hosts/bitbucket_review.mjs";
import { makeBitbucketReviewProducer } from "../lib/hosts/bitbucket_review_producer.mjs";
import { repositoryReviewConfig } from "../lib/review_policy.mjs";
import { createReviewService } from "../lib/first_party_review.mjs";
import { makeTrust, reviewerVerdict, deriveEvents, eventKey, requiredFeedback, isGreen, readFeedback } from "../lib/events.mjs";
import { makeHostRegistry, hosts } from "../lib/hosts.mjs";
import { observedIdentityProblem, terminalIdentityProblem, assertRepositoryAccess } from "../lib/host_contract.mjs";
import { newEntry, makeState, advanceCursor } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { tickChains } from "../lib/chains.mjs";
import { capabilitiesFor } from "../lib/harness.mjs";
import { runEnv } from "../lib/git.mjs";
import { resolveBitbucketCredential, BITBUCKET_REVIEW_SCOPES } from "../lib/hosts/bitbucket_credential.mjs";
import { prOperation } from "../lib/pr_operation.mjs";
import { startPrompt, fixPrompt } from "../lib/prompt.mjs";
import { init } from "../lib/commands/init.mjs";
import { merge, validate, repoEntries } from "../lib/config.mjs";

const REVIEWER = { ...USER, uuid: "{44444444-4444-4444-4444-444444444444}" };
const verdictBody = (verdict = "clear", head = HEAD) => '```work-review\n' + JSON.stringify({ head_sha: head, verdict, summary: verdict === "clear" ? "Reviewed the exact diff; no blocking findings." : "Fix the incorrect return value." }) + '\n```';
const reviewer = { actor_id: REVIEWER.uuid, rereview_comment: "Review the current commit and post a work-review verdict.", blocking_pattern: "\\bP[01]\\b" };
const settings = { reviewer, trusted_authors: [USER.uuid], required_checks: ["Tests"] };
const config = (extra = {}) => ({ ...CONFIG, repos: [REPO], git_hosts: { "bitbucket.org": { ...settings, ...extra } } });
const selected = c => repositoryReviewConfig(c, REPO);
const entry = () => ({ ...newEntry({ repo: REPO, harness: "codex", session: "22222222-2222-4222-8222-222222222222", branch: "work/feature", base: "main", worktree: "/fixture", pr: 7, url: "https://bitbucket.org/acme/widget/pull-requests/7", nowIso: NOW, state: "pr-open" }), cursor: { since: NOW, fixed_sha: HEAD, checks_sha: null, dispatched: [] } });
const verdict = (snapshot, c = config()) => reviewerVerdict({ ...snapshot.feedback, config: selected(c), trust: makeTrust(selected(c), USER.uuid), sinceIso: NOW, headSha: snapshot.headRefOid });
function cleanFixture(options) {
  const f = fixture(options);
  f.data.prs = [pr({ participants: [] })]; f.data.comments = []; f.data.tasks = [];
  return f;
}

test("repository policy isolates defaults, same-named repositories, actor UUIDs and explicit no-reviewer mode", () => {
  const c = config();
  assert.equal(repositoryReviewConfig(c, "acme/widget").reviewer.login, CONFIG.reviewer.login);
  assert.equal(selected(c).reviewer.actor_id, REVIEWER.uuid);
  assert.throws(() => selected({ ...CONFIG }), /explicit.*reviewer/);
  assert.throws(() => selected(config({ reviewer: { ...reviewer, actor_id: "nickname" } })), /stable host UUID/);
  assert.throws(() => selected(config({ reviewer: { ...reviewer, rereview_comment: "@codex review" } })), /unsupported/);
  assert.throws(() => selected(config({ trusted_authors: ["me"] })), /stable host/);
  c.repos = [{ repo: REPO, reviewer: null, required_checks: ["Lint"] }];
  assert.equal(selected(c).reviewer, null); assert.deepEqual(selected(c).required_checks, ["Lint"]);
  assert.equal(repositoryReviewConfig(c, "acme/widget").reviewer.login, CONFIG.reviewer.login);
  const trust = makeTrust(selected(config()), USER.uuid);
  assert.equal(trust.isReviewer({ login: REVIEWER.uuid, bot: false }), true, "a dedicated account need not have app_user type");
  assert.equal(trust.isReviewer({ login: USER.uuid, bot: true }), false);
});

test("review preflight preserves repository actor overrides and explicit no-reviewer policy", async () => {
  const registry = makeHostRegistry({ adapters: [{ ...bitbucket, dispatch: true,
    create: () => ({}) }] });
  const alternate = { ...reviewer, actor_id: "{55555555-5555-5555-5555-555555555555}" };
  for (const hostDefaults of [true, false]) for (const external of [alternate, null]) {
    const c = { ...config(), git_hosts: hostDefaults ? config().git_hosts : {}, repos: [
      { repo: PATH, reviewer: CONFIG.reviewer, review: { mode: "both-required" } },
      { repo: REPO, reviewer: external, trusted_authors: [USER.uuid], required_checks: ["Lint"],
        review: { mode: external ? "external-required" : null, zero_checks: true } },
    ] };
    c.repos = repoEntries(c);
    const service = createReviewService({ home: tempHome(), config: c, hosts: registry,
      executionFor: () => assert.fail("external/no-reviewer preflight must not prepare inference") });
    const selected = await service.preflight(REPO, { zero_checks: false });
    assert.deepEqual(selected.external, external, `host defaults: ${hostDefaults}`);
    assert.equal(selected.version, external ? 1 : 0);
    assert.equal(selected.mode, external ? "external-required" : null);
    if (external) assert.equal(selected.zeroChecks, false, "explicit policy edits override saved review settings");
    else assert.match(selected.disclosure, /no semantic review required or claimed/);
    assert.deepEqual(repositoryReviewConfig(c, PATH).reviewer, CONFIG.reviewer);
  }
});

test("Bitbucket first-party evidence binds exact PR commits and covers paginated added, modified, removed and renamed files", async () => {
  const f = cleanFixture({ intercept: call => {
    if (call.path.startsWith("/diffstat/")) {
      const request = new URL(call.url), pageNumber = request.searchParams.get("page");
      if (!pageNumber) { request.searchParams.set("page", "2"); return json({ values: f.data.diffstat.slice(0, 2), size: 4, pagelen: 2, next: request.href }); }
      return json({ values: f.data.diffstat.slice(2), size: 4, pagelen: 2 });
    }
  } });
  f.data.diffstat = [
    { status: "added", old: null, new: { type: "commit_file", path: "added.txt" } },
    { status: "modified", old: { type: "commit_file", path: "a" }, new: { type: "commit_file", path: "a" } },
    { status: "removed", old: { type: "commit_file", path: "removed.txt" }, new: null },
    { status: "renamed", old: { type: "commit_file", path: "old.txt" }, new: { type: "commit_file", path: "new.txt" } },
  ];
  f.data.comparisonDiff = [
    "diff --git a/added.txt b/added.txt\nnew file mode 100644\n--- /dev/null\n+++ b/added.txt\n@@ -0,0 +1 @@\n+added\n",
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-before\n+fixture file\n",
    "diff --git a/removed.txt b/removed.txt\ndeleted file mode 100644\n--- a/removed.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n",
    "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
  ].join("");
  Object.assign(f.data.sources, {
    [`${HEAD}:added.txt`]: "added\n", [`${BASE}:removed.txt`]: "removed\n",
    [`${BASE}:old.txt`]: "same\n", [`${HEAD}:new.txt`]: "same\n",
  });
  const evidence = await f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000);
  assert.deepEqual(evidence.context.map(file => [file.path, file.status]), [["added.txt", "added"], ["a", "modified"], ["removed.txt", "removed"], ["new.txt", "renamed"]]);
  assert.equal(evidence.repositoryId, UUID); assert.equal(evidence.pr, 7); assert.equal(evidence.head, HEAD); assert.equal(evidence.base, BASE); assert.equal(evidence.mergeBase, BASE);
  assert.equal(evidence.context[0].before, null); assert.equal(evidence.context[2].after, null);
  assert.equal(evidence.context[3].before, "same\n"); assert.equal(evidence.context[3].after, "same\n");
  assert.equal(f.calls.filter(call => call.path.startsWith("/diffstat/")).length, 2);
  const comparison = f.calls.find(call => call.path.startsWith("/diff/"));
  assert.match(comparison.path, new RegExp(`/diff/${HEAD}\\.\\.${BASE}`));
  assert.equal(new URL(comparison.url).searchParams.get("topic"), "true");
  assert.ok(f.calls.every(call => new URL(call.url).origin === "https://api.bitbucket.org"));
});

test("Bitbucket first-party evidence refuses stale, duplicate, binary, missing-patch, redirected, rate-limited and oversized capture", async () => {
  const cases = [
    ["stale", f => f.api.reviewEvidence(PATH, 7, BASE, HEAD, 100_000)],
    ["duplicate", f => { f.data.diffstat.push(structuredClone(f.data.diffstat[0])); return f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000); }],
    ["binary", f => { f.data.comparisonDiff += "GIT binary patch\n"; return f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000); }],
    ["binary metadata", f => { f.data.sourceAttributes[`${HEAD}:a`] = ["binary"]; return f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000); }],
    ["missing-patch", f => { f.data.comparisonDiff = "diff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-a\n+b\n"; return f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000); }],
    ["oversized", f => f.api.reviewEvidence(PATH, 7, HEAD, BASE, 20)],
  ];
  for (const [name, attempt] of cases) await assert.rejects(attempt(cleanFixture()), /current open|stale|duplicate|binary|submodule|regular text-file|changed-path|patch|bound|exceeds|oversized/i, name);
  for (const [name, response] of [["redirected", new Response(null, { status: 302, headers: { location: "https://evil.example/leak" } })], ["rate-limited", json({}, 429)]]) {
    const f = cleanFixture({ intercept: call => call.path.startsWith("/diffstat/") ? response : undefined });
    await assert.rejects(f.api.reviewEvidence(PATH, 7, HEAD, BASE, 100_000), /redirect|HTTP 429/i, name);
  }
});

test("only explicit current full-SHA feedback from the configured stable reviewer clears a head", async () => {
  for (const [body, user, expected] of [
    [verdictBody(), REVIEWER, "clear"], [verdictBody("blocking"), REVIEWER, "blocking"],
    [verdictBody(), USER, "waiting"], [verdictBody("clear", BASE), REVIEWER, "waiting"],
    [verdictBody("clear", HEAD.slice(0, 7)), REVIEWER, "waiting"],
    ["Pipeline ran Codex successfully", REVIEWER, "waiting"],
    [`Reviewed commit: \`${HEAD}\`\nNo problems`, REVIEWER, "waiting"],
  ]) {
    const f = cleanFixture(); f.data.comments = [{ ...comment(), user, content: { raw: body } }];
    const snapshot = await f.api.prView(PATH, 7);
    assert.equal(verdict(snapshot).verdict, expected);
    assert.equal(snapshot.feedback.complete, true);
  }
  const f = cleanFixture(); f.data.prs[0].participants = [{ user: REVIEWER, role: "REVIEWER", approved: true, participated_on: NOW }];
  assert.equal(verdict(await f.api.prView(PATH, 7)).verdict, "waiting", "native approval cannot prove which commit was reviewed");
  assert.equal(bitbucketVerdict(verdictBody() + '\n' + verdictBody()), null);
});

test("one event batch includes verdict, inline finding, required task, trusted fix and failed check; old heads and self replies stay out", async () => {
  const f = cleanFixture();
  f.data.comments = [
    { ...comment(1), user: REVIEWER, content: { raw: verdictBody("blocking") } },
    { ...comment(2), inline: { path: "lib/a.mjs", to: 4 }, content: { raw: `Reviewed commit: ${HEAD}\nFix this.` } },
    { ...comment(3), content: { raw: "/fix update tests" } },
    { ...comment(4), inline: { path: "lib/a.mjs", to: 4 }, content: { raw: `Reviewed commit: ${BASE}\nOld finding.` } },
    { ...comment(5), parent: { id: 2 }, inline: { path: "lib/a.mjs", to: 4 }, content: { raw: `Reviewed commit: ${HEAD}\nReplied.` } },
  ];
  f.data.tasks = [{ id: 9, creator: USER, content: { raw: "Required correction" }, state: "UNRESOLVED", created_on: NOW, updated_on: NOW }];
  f.data.statuses = [{ ...status(), state: "FAILED" }];
  const snapshot = await f.api.prView(PATH, 7), trust = makeTrust(selected(config()), USER.uuid), e = entry();
  const input = { pr: snapshot, ...snapshot.feedback, entry: e, trust };
  const batch = deriveEvents(input);
  assert.deepEqual(batch.events.map(eventKey).sort(), ["review:verdict:1", "inline:2", "command:3", "review:task:9", "check:undefined"].sort());
  const duplicate = deriveEvents({ ...input, reviews: [...input.reviews].reverse().concat(input.reviews), inline: [...input.inline].reverse().concat(input.inline) });
  assert.equal(duplicate.events.length, batch.events.length);
  e.cursor = { ...advanceCursor(e.cursor, batch.newest, batch.events.filter(e => e.id).map(eventKey)), checks_sha: HEAD };
  assert.equal(deriveEvents({ ...input, entry: e }).events.length, 0);
  assert.equal(requiredFeedback({ ...snapshot.feedback, trust, headSha: HEAD }).length, 1, "a dispatched unresolved task still blocks readiness");
});

test("snapshot ordering, partial feedback and unavailable API never manufacture clearance or green CI", async () => {
  let reads = 0;
  const f = cleanFixture({ intercept: c => c.path.endsWith("/comments") ? json(page(++reads % 2 ? [comment(1), comment(2)] : [comment(2), comment(1)])) : undefined });
  const snapshot = await f.api.prView(PATH, 7);
  assert.deepEqual((await readFeedback({}, REPO, snapshot))[2].map(c => c.id), [1, 2]);
  await assert.rejects(readFeedback({}, REPO, { ...snapshot, feedback: { ...snapshot.feedback, headSha: BASE } }), /mismatched/);
  for (const code of [403, 429, 503]) {
    const unavailable = cleanFixture({ intercept: c => c.path.endsWith("/tasks") ? json({}, code) : undefined });
    await assert.rejects(unavailable.api.prView(PATH, 7), /HTTP/);
  }
  assert.equal(isGreen([], ["Tests"]), false);
  assert.equal(isGreen([{ name: "Other", outcome: "passed" }], ["Tests"]), false);
  assert.equal(isGreen([{ name: "Tests", outcome: "pending" }], ["Tests"]), false);
  assert.equal(isGreen([{ name: "Tests", outcome: "passed" }], ["Tests"]), true);
});

test("setup and polling use the same inline-link normalization for every paginated comment", async () => {
  const f = cleanFixture();
  f.data.comments = [comment(1), { ...comment(2), inline: { path: "a.mjs", to: 2 }, links: { code: { href: `https://bitbucket.org/${PATH}/src/${HEAD}/a.mjs#lines-2` } } }];
  assert.equal((await f.api.preflight(PATH)).commentRead, "proved");
  assert.equal((await f.api.prView(PATH, 7)).feedback.inline[0].headSha, HEAD);
  f.data.comments[1].links.code.href = "malformed";
  await assert.rejects(f.api.preflight(PATH), /incomplete inline commit link/);
  await assert.rejects(f.api.prView(PATH, 7), /incomplete inline commit link/);
});

test("recovery operations prove actor, file revision, branch/base and merge ancestry without a merge API", async () => {
  const f = cleanFixture();
  assert.equal(await f.api.user(), USER.uuid);
  assert.equal(await f.api.fileAtStrict(PATH, "docs/brief.md", "main"), "fixture file\n");
  assert.equal(await f.api.containsCommit(PATH, "main", BASE), true);
  assert.equal(await f.api.containsCommit(PATH, "main", HEAD), false);
  const snapshot = await f.api.prView(PATH, 7), e = entry();
  assert.equal(observedIdentityProblem(e, snapshot), null);
  assert.match(observedIdentityProblem(e, { ...snapshot, baseRefName: "other" }), /base changed/);
  assert.match(await terminalIdentityProblem(f.registry.api, e, { ...snapshot, state: "CLOSED", hostState: "DECLINED" }), /DECLINED/);
  const merged = { ...snapshot, state: "MERGED", mergeCommit: { oid: BASE }, mergedAt: NOW };
  assert.equal(await terminalIdentityProblem(f.registry.api, e, merged), null);
  assert.match(await terminalIdentityProblem(f.registry.api, e, { ...merged, headRefOid: BASE }), /recorded head/);
  assert.match(await terminalIdentityProblem({ containsCommit: async () => false }, e, merged), /merge commit/);
  assert.ok(f.calls.every(c => c.method === "GET"));
  for (const metadata of [
    { type: "commit_directory", path: "docs/brief.md", commit: { hash: BASE }, size: 13 },
    { type: "commit_file", path: "docs/brief.md", commit: { hash: HEAD }, size: 13 },
    { type: "commit_file", path: "docs/brief.md", commit: { hash: BASE }, size: 100 },
  ]) {
    const bad = cleanFixture({ intercept: c => c.url.includes("format=meta") ? json(metadata) : undefined });
    await assert.rejects(bad.api.fileAtStrict(PATH, "docs/brief.md", "main"), /file metadata|file size/);
  }
});

test("Bitbucket PR operations bind checkout and API repository and provide safe prompts without GitHub commands", async () => {
  const f = cleanFixture(), env = { HOST_API_HOST: "bitbucket.org", HOST_API_REPOSITORY: PATH, HOST_API_TOKEN: "fixture" };
  const exec = async (_cmd, args) => ({ stdout: args[0] === "remote" ? `git@bitbucket.org:${PATH}.git` : "work/feature" });
  const options = { env, registry: f.registry, exec, read: path => ({ title: "Update widget", body: "Verified correction", reply: "Corrected the return value." })[path] };
  await prOperation(["create", "--base", "main", "--head", "work/feature", "--title-file", "title", "--body-file", "body"], options);
  f.data.comments = [comment(1)];
  await prOperation(["comment", "7", "--reply-to", "1", "--body-file", "reply"], options);
  assert.equal(f.calls.find(c => c.method === "POST").body.parent.id, 1);
  await assert.rejects(prOperation(["view", "7"], { ...options, env: { ...env, HOST_API_REPOSITORY: "other/widget" } }), /differs/);
  await assert.rejects(prOperation(["merge", "7"], options), /Use task-pr/);
  const prompts = bitbucket.prompts;
  const start = startPrompt({ host: prompts, prd: { text: "Implement change." }, repo: REPO, branch: "work/feature", base: "release/v2", verify: [] });
  const fix = fixPrompt({ host: prompts, repo: REPO, pr: 7, headSha: HEAD, events: [], verify: [] });
  assert.match(start, /task-pr\.mjs' create --base 'release\/v2'/); assert.match(fix, /task-pr\.mjs' edit/);
  assert.doesNotMatch(start + fix, /gh pr|github\.com|@codex review/);
  assert.throws(() => assertRepositoryAccess(capabilitiesFor("codex-cloud"), { host: "bitbucket.org" }), /cannot access/);
  assert.equal(hosts.select(REPO).repository.key, REPO);
});

test("repository credentials refresh in isolation and coding environment excludes reviewer tokens", async () => {
  const root = realpathSync(tempHome()), token = join(root, "token"), other = join(root, "other");
  writeFileSync(token, "selected", { mode: 0o600 }); writeFileSync(other, "other-secret", { mode: 0o600 });
  const c = config({ api: { email: "operator@example.test", token_file: other }, repositories: { [PATH]: { api: { email: "coder@example.test", token_file: token }, uuid: UUID, workspaceUuid: WORKSPACE } } });
  const cred = await resolveBitbucketCredential(c, { path: PATH });
  assert.equal(cred.token, "selected"); assert.equal(cred.email, "coder@example.test");
  const previous = process.env.BITBUCKET_REVIEWER_TOKEN; process.env.BITBUCKET_REVIEWER_TOKEN = "reviewer-secret";
  try {
    const env = runEnv(c, cred);
    assert.equal(env.BITBUCKET_REVIEWER_TOKEN, ""); assert.equal(env.GH_TOKEN, ""); assert.equal(env.HOST_API_TOKEN, "selected");
    assert.doesNotMatch(JSON.stringify(env), /reviewer-secret|other-secret/);
  } finally { if (previous === undefined) delete process.env.BITBUCKET_REVIEWER_TOKEN; else process.env.BITBUCKET_REVIEWER_TOKEN = previous; }
  writeFileSync(token, "rotated");
  assert.equal((await resolveBitbucketCredential(c, { path: PATH })).token, "rotated");
});

test("review publication accepts repository-read scopes without weakening coding credentials", async () => {
  const file = join(tempHome(), "reviewer-token");
  writeFileSync(file, "private-reviewer-token", { mode: 0o600 });
  const c = config({ api: { email: "reviewer@example.test", token_file: file, scopes: BITBUCKET_REVIEW_SCOPES } });
  const cred = await resolveBitbucketCredential(c, { path: PATH, operation: "review" });
  assert.equal(cred.token, "private-reviewer-token"); assert.equal(cred.environment, undefined);
  await assert.rejects(resolveBitbucketCredential(c, { path: PATH }), /write:repository:bitbucket/);
  c.git_hosts["bitbucket.org"].api.scopes = ["read:repository:bitbucket"];
  await assert.rejects(resolveBitbucketCredential(c, { path: PATH, operation: "review" }), /write:pullrequest:bitbucket/);
});

test("fresh Bitbucket setup imports explicit host settings and retains a non-default base with no GitHub sign-in", async () => {
  const root = realpathSync(tempHome()), home = join(root, "home"), token = join(root, "token"), file = join(root, "host.json");
  writeFileSync(token, "fixture-api-secret", { mode: 0o600 });
  writeFileSync(file, JSON.stringify({ ...settings, reviewer: null, api: { email: "operator@example.test", token_file: token } }));
  const f = cleanFixture();
  const options = { home, hostConfig: file, base: "release/v2", harness: "codex", worktrees: join(root, "trees"),
    gh: f.api, repository: () => ({ repo: REPO, origin: `git@bitbucket.org:${PATH}.git`, checkout: root }),
    discover: () => ({ codex: { bin: process.execPath } }), harnessCheck: async () => ({ ok: true }), doctor: async () => [],
    transportPreflight: async c => { assert.equal(c.repos[0].base, "release/v2"); return { identity: { uuid: UUID, workspaceUuid: WORKSPACE } }; },
  };
  const result = await init(options);
  const saved = JSON.parse(readFileSync(result.file, "utf8"));
  assert.equal(saved.repos[0].base, "release/v2"); assert.equal(saved.git_hosts["bitbucket.org"].reviewer, null);
  assert.deepEqual(validate(merge(saved, home), home), []);
  assert.equal((await init(options)).changed, false, "the original file need not include the generated repositories map");
});

test("repeated host imports preserve generated bindings and refuse policy or identity replacement", async () => {
  const root = realpathSync(tempHome()), home = join(root, "home"), file = join(root, "host.json"), f = cleanFixture();
  const supplied = { ...settings, api: { email: "operator@example.test", token_file: join(root, "token") },
    repositories: { [PATH]: { required_checks: ["Unit"] } } };
  writeFileSync(file, JSON.stringify(supplied));
  let probes = 0, reports = 0;
  const options = { home, hostConfig: file, base: "release/v2", harness: "codex", worktrees: join(root, "trees"),
    gh: f.api, repository: () => ({ repo: REPO, origin: `git@bitbucket.org:${PATH}.git`, checkout: root }),
    discover: () => ({ codex: { bin: process.execPath } }), harnessCheck: async () => ({ ok: true }),
    doctor: async () => { reports++; return [{ ok: false, detail: "live qualification pending" }]; },
    transportPreflight: async c => {
      probes++;
      if (probes > 1) assert.equal(c.git_hosts["bitbucket.org"].repositories[PATH].uuid, UUID);
      return { identity: { uuid: UUID, workspaceUuid: WORKSPACE } };
    },
  };
  const first = await init(options), before = readFileSync(first.file, "utf8");
  const repeated = await init(options);
  assert.equal(repeated.changed, false); assert.equal(repeated.created, false); assert.equal(repeated.recorded, false);
  assert.equal(reports, 2); assert.equal(readFileSync(first.file, "utf8"), before);
  // JSON member order is presentation, while omitted policy or changed identity is a replacement.
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(supplied).reverse())));
  assert.equal((await init(options)).changed, false);
  for (const change of [
    c => { c.reviewer = null; },
    c => { c.api.email = "other@example.test"; },
    c => { delete c.repositories; },
    c => { c.repositories[PATH].uuid = REVIEWER.uuid; c.repositories[PATH].workspaceUuid = WORKSPACE; },
  ]) {
    const replacement = structuredClone(supplied); change(replacement); writeFileSync(file, JSON.stringify(replacement));
    await assert.rejects(init(options), /Existing host settings differ/);
    assert.equal(readFileSync(first.file, "utf8"), before);
  }
  assert.equal(probes, 3, "conflicting imports stop before access checks or writes");
});

test("shared tick uses exact-head Bitbucket feedback with no reviewer and no-CI grace, and survives restart", async () => {
  const f = cleanFixture(), clock = makeClock(NOW), home = tempHome(), state = makeState(home), id = `${REPO}/feature`;
  f.data.statuses = [];
  // Dispatch is enabled ONLY in this injected offline contract fixture.
  const registry = makeHostRegistry({ adapters: [{ ...bitbucket, dispatch: true }], fetch: f.fetch,
    credential: async () => ({ host: "bitbucket.org", repository: PATH, token: f.data.token, email: f.data.email }) });
  const e = entry(); state.put(id, e);
  const runner = fakeRunner(clock);
  const ctx = { home, config: { ...config({ reviewer: null, required_checks: [] }), deliverable: null }, hosts: registry, host: registry.api,
    state, clock, ownLogin: USER.uuid, git: { ...fakeGit(), originOf: async () => `https://bitbucket.org/${PATH}.git` },
    identity: fakeIdentity(), runnerFor: () => runner, log: silentLog, notify: fakeNotify(), readPrd: () => null };
  assert.equal((await makeTick(ctx).tick())[0].ok, true);
  assert.equal(state.get(id).state, "pr-open", "empty CI is pending during grace");
  clock.advance(10);
  assert.equal((await makeTick({ ...ctx, state: makeState(home) }).tick())[0].ok, true);
  assert.equal(state.get(id).state, "ready-for-human"); assert.equal(runner.started.length, 0);
  assert.ok(!f.calls.some(c => c.path.includes("label")));
});

test("separate reviewer prepare/publish verifies actor and input head, reconciles retries, and never starts inference", async () => {
  const f = cleanFixture({ intercept: (call, data) => {
    if (call.path.endsWith("/comments") && call.method === "POST") {
      const row = { ...comment(10 + data.comments.length), user: REVIEWER, content: call.body.content }; data.comments.push(row); return json(row);
    }
  } });
  f.data.user = REVIEWER;
  const producer = makeBitbucketReviewProducer({ config: config(), registry: f.registry }), url = pr().links.html.href;
  const input = await producer.prepare(url);
  assert.equal(input.binding.headSha, HEAD); assert.doesNotMatch(JSON.stringify(input), /fixture-api-secret|token_file|operator@example/);
  const blocking = { head_sha: HEAD, verdict: "blocking", summary: "Correct the return value." };
  await producer.publish(url, input, blocking);
  assert.equal((await producer.publish(url, input, blocking)).reused, true);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  const clear = { ...blocking, verdict: "clear", summary: "Exact diff reviewed; correction is complete." };
  await producer.publish(url, input, clear);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 2);
  assert.equal(verdict(await f.api.prView(PATH, 7)).verdict, "clear", "same-timestamp verdict order uses the stable comment sequence");
  await assert.rejects(producer.publish(url, input, { ...clear, head_sha: BASE }), /prepared full SHA/);
  f.data.prs[0].destination.branch.name = "release/v2";
  await assert.rejects(producer.publish(url, input, clear), /changed since review/);
  const other = cleanFixture();
  await assert.rejects(makeBitbucketReviewProducer({ config: config(), registry: other.registry }).prepare(url), /not the configured reviewer/);
});

test("review publication reconciles only unsuperseded verdicts, including uncertain writes", async () => {
  let loseReply = false, nextId = 10;
  const f = cleanFixture({ intercept: (call, data) => {
    if (call.path.endsWith("/comments") && call.method === "POST") {
      const row = { ...comment(nextId++), user: REVIEWER, content: call.body.content }; data.comments.push(row);
      if (loseReply) { loseReply = false; throw new Error("reply lost after accepted write"); }
      return json(row);
    }
  } });
  f.data.user = REVIEWER;
  const producer = makeBitbucketReviewProducer({ config: config(), registry: f.registry }), url = pr().links.html.href;
  const input = await producer.prepare(url);
  const blocking = { head_sha: HEAD, verdict: "blocking", summary: "Correct the return value." };
  const clear = { ...blocking, verdict: "clear", summary: "Correction reviewed." };
  for (const result of [blocking, clear, blocking, clear]) {
    f.data.comments.reverse(); // Pages may reorder; every verdict has the same timestamp.
    const count = f.calls.filter(c => c.method === "POST").length;
    const published = await producer.publish(url, input, result);
    assert.notEqual(published.reused, true, "a superseded match must not swallow the new decision");
    assert.equal(f.calls.filter(c => c.method === "POST").length, count + 1);
    const retry = await producer.publish(url, input, result);
    assert.equal(retry.reused, true); assert.equal(retry.id, published.id);
    assert.equal(verdict(await f.api.prView(PATH, 7)).verdict, result.verdict);
  }
  loseReply = true;
  await assert.rejects(producer.publish(url, input, blocking), { code: "BB_TRANSPORT", uncertain: true });
  const count = f.calls.filter(c => c.method === "POST").length;
  assert.equal((await producer.publish(url, input, blocking)).reused, true);
  assert.equal(f.calls.filter(c => c.method === "POST").length, count, "an accepted uncertain write is reconciled without another POST");
  f.data.comments.push({ ...comment(nextId++), user: REVIEWER, content: { raw: verdictBody("clear", BASE) } });
  assert.equal(verdict(await f.api.prView(PATH, 7)).verdict, "waiting");
  assert.notEqual((await producer.publish(url, input, blocking)).reused, true, "a later old-head verdict also supersedes the old match");
  assert.equal(verdict(await f.api.prView(PATH, 7)).verdict, "blocking");
  const latest = (await producer.publish(url, input, blocking)).id;
  const body = f.data.comments.find(c => c.id === latest).content;
  f.data.comments.push({ ...comment(nextId++), user: REVIEWER, parent: { id: latest }, content: body },
    { ...comment(nextId++), user: REVIEWER, deleted: true, content: body });
  assert.equal((await producer.publish(url, input, blocking)).id, latest, "replies and deleted verdicts cannot replace the effective decision");
});

test("Bitbucket feedback resumes the saved session once across polling, reordering, retry and daemon restart", async () => {
  let unavailable = false;
  const f = cleanFixture({ intercept: c => unavailable && c.path.endsWith("/tasks") ? json({}, 503) : undefined });
  f.data.comments = [{ ...comment(1), content: { raw: "/fix repair the failing test" } }];
  f.data.statuses = [{ ...status(), state: "FAILED" }];
  const clock = makeClock(NOW), home = tempHome(), state = makeState(home), id = `${REPO}/feature`;
  const registry = makeHostRegistry({ adapters: [{ ...bitbucket, dispatch: true }], fetch: f.fetch,
    credential: async () => ({ host: "bitbucket.org", repository: PATH, token: f.data.token, email: f.data.email }) });
  const e = entry(); state.put(id, e);
  const runner = fakeRunner(clock);
  const ctx = { home, config: { ...config({ reviewer: null }), deliverable: null }, hosts: registry, host: registry.api,
    state, clock, ownLogin: USER.uuid, git: { ...fakeGit(), originOf: async () => `https://bitbucket.org/${PATH}.git` },
    identity: fakeIdentity(), runnerFor: () => runner, log: silentLog, notify: fakeNotify(), readPrd: () => null };
  const before = structuredClone(state.get(id).cursor);
  unavailable = true;
  assert.equal((await makeTick(ctx).tick())[0].ok, false);
  assert.deepEqual(state.get(id).cursor, before); assert.equal(runner.started.length, 0);
  unavailable = false;
  assert.equal((await makeTick(ctx).tick())[0].ok, true);
  assert.equal(runner.started.length, 1); assert.ok(runner.started[0].args.includes(e.session));
  assert.match(runner.started[0].args.join(" "), /task-pr\.mjs' edit/);
  await makeTick({ ...ctx, state: makeState(home) }).tick();
  assert.equal(runner.started.length, 1, "running session owns the feedback batch");
  runner.finish(codexLines({ thread: e.session }));
  f.data.statuses = [status()];
  clock.advance(1);
  await makeTick({ ...ctx, state: makeState(home) }).tick();
  await makeTick({ ...ctx, state: makeState(home) }).tick();
  assert.equal(runner.started.length, 1); assert.equal(state.get(id).session, e.session);
  assert.ok(state.get(id).cursor.dispatched.includes("command:1"));
});

test("Bitbucket chain advances only after recorded-head merge proof and stops on decline or changed base", async () => {
  const f = cleanFixture(), home = tempHome(), state = makeState(home), clock = makeClock(NOW), id = `${REPO}/feature`;
  const registry = makeHostRegistry({ adapters: [{ ...bitbucket, dispatch: true }], fetch: f.fetch,
    credential: async () => ({ host: "bitbucket.org", repository: PATH, token: f.data.token, email: f.data.email }) });
  state.put(id, { ...entry(), start_token: "owned", chain: { name: "release", index: 0, dispatch: "owned-dispatch" } });
  const chain = { name: "release", repo: REPO, base: "main", status: "active", index: 0, failures: 0,
    steps: [{ id, checkout: null, dispatch: "owned-dispatch", entry: { token: "owned", pr: 7 }, merged: null }], created_at: NOW, updated_at: NOW };
  const saved = state.load(); saved.chains = { release: chain }; writeFileSync(state.file, JSON.stringify(saved));
  const ctx = { home, state, config: config(), hosts: registry, host: registry.api, clock, log: silentLog, notify: fakeNotify(), runnerFor: () => fakeRunner(clock) };
  f.data.prs[0].state = "DECLINED";
  await tickChains(ctx); assert.equal(state.getChain("release").status, "stopped"); assert.equal(state.getChain("release").index, 0);
  state.updateChain("release", { status: "active", reason: null });
  f.data.prs[0].state = "MERGED"; f.data.prs[0].merge_commit = { hash: HEAD };
  await tickChains(ctx); assert.equal(state.getChain("release").status, "stopped");
  state.updateChain("release", { status: "active", reason: null });
  f.data.prs[0].merge_commit = { hash: BASE };
  await tickChains(ctx); assert.equal(state.getChain("release").status, "done"); assert.equal(state.getChain("release").steps[0].merged.sha, BASE);
});

test("changed PR identity stops explicit resume, initial publication settlement and normal polling before further writes or dispatch", async () => {
  for (const mode of ["resume", "settlement", "poll"]) {
    const f = cleanFixture(), home = tempHome(), state = makeState(home), clock = makeClock(NOW), id = `${REPO}/feature`;
    const registry = makeHostRegistry({ adapters: [{ ...bitbucket, dispatch: true }], fetch: f.fetch,
      credential: async () => ({ host: "bitbucket.org", repository: PATH, token: f.data.token, email: f.data.email }) });
    f.data.prs[0].destination.branch.name = "unexpected";
    const runner = fakeRunner(clock), e = entry();
    if (mode === "settlement") {
      const job = runner.start("start", "fixture", [], {});
      runner.finish(codexLines({ thread: e.session }));
      Object.assign(e, { state: "running", pr: null, url: null, last: { at: NOW, run: job.id, exit: null } });
    }
    state.put(id, e);
    const ctx = { home, config: { ...config({ reviewer: null }), deliverable: null }, hosts: registry, host: registry.api,
      state, clock, ownLogin: USER.uuid, git: fakeGit(), identity: fakeIdentity(), runnerFor: () => runner,
      log: silentLog, notify: fakeNotify(), readPrd: () => null };
    const tick = makeTick(ctx);
    if (mode === "resume") await assert.rejects(tick.startRun(id, e, { name: "resume", prompt: "Continue" }), { code: "PR_IDENTITY" });
    else await tick.tick();
    assert.equal(state.get(id).state, "needs-human", mode); assert.equal(state.get(id).reason, "pr-identity", mode);
    assert.equal(runner.started.length, mode === "settlement" ? 1 : 0);
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
});
