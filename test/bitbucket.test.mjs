import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fixture, REPO, PATH, UUID, WORKSPACE, USER, HEAD, BASE, NOW, HOST_KEY, pr, prSummary, page, json, comment, status } from "./bitbucket-fixture.mjs";
import { makeHostRegistry, hosts, pullRequestUrl } from "../lib/hosts.mjs";
import { validateHostRecord } from "../lib/host_contract.mjs";
import { makeGit, runEnv } from "../lib/git.mjs";
import { resolveBitbucketCredential, verifyBitbucketHostKeys } from "../lib/hosts/bitbucket_credential.mjs";
import { resolveCredential } from "../lib/credential.mjs";
import { parseRemote } from "../lib/repository.mjs";
import { repositoryPreflight } from "../lib/repository_preflight.mjs";
import { init, targetRepository, renderInit } from "../lib/commands/init.mjs";
import { doctor, renderDoctor } from "../lib/commands/doctor.mjs";
import { model, render } from "../lib/commands/status.mjs";
import { dashboard } from "../lib/tracker/pages.mjs";
import { CONFIG, GOOD_PRD, tempHome as temporaryHome, silentLog } from "./helpers.mjs";
import { parsePrd } from "../lib/prd.mjs";
import { makeState } from "../lib/state.mjs";
import { validate, merge } from "../lib/config.mjs";
import { parseBlock } from "../lib/block.mjs";

const publication = { repo: PATH, branch: "work/feature", base: "main", title: "Add transport", body: "Approved change" };
const tempHome = () => realpathSync(temporaryHome());
const ready = async () => ({ ok: true, detail: "fixture harness; no model call" });
function selectedConfig(home, transport = "https") {
  const token = join(home, "token"), ssh = join(home, "selected key"), known = join(home, "known hosts");
  writeFileSync(token, "fixture-api-secret", { mode: 0o600 }); writeFileSync(ssh, "fixture-key", { mode: 0o600 }); writeFileSync(known, HOST_KEY);
  return { ...CONFIG, repos: [REPO], worktrees: tempHome(), harness: { codex: { bin: process.execPath } },
    git_hosts: { "bitbucket.org": { reviewer: null, trusted_authors: [USER.uuid], api: { email: "operator@example.test", token_file: token }, git: { transport, ssh_key: ssh, known_hosts: known } } } };
}

test("Bitbucket identity binds HTTPS, both Cloud SSH origins, mixed case and public/private UUIDs", async () => {
  for (const origin of ["https://bitbucket.org/Acme/Widget.git", "git@bitbucket.org:Acme/Widget.git", "ssh://git@bitbucket.org/Acme/Widget.git", "git@ssh.bitbucket.org:Acme/Widget.git"]) {
    const f = fixture();
    const target = f.registry.inspectRemote(origin);
    assert.equal(target.repository.key, REPO);
    for (const privateRepo of [true, false]) {
      f.data.repository.is_private = privateRepo;
      const identity = await target.api.inspectRepository(target.repository.path);
      assert.equal(identity.uuid, UUID); assert.equal(identity.workspaceUuid, WORKSPACE); assert.equal(identity.private, privateRepo);
    }
  }
  for (const url of ["http://bitbucket.org/acme/widget", "https://bitbucket.example/acme/widget", "https://ssh.bitbucket.org/acme/widget", "ssh://git@bitbucket.org:22/acme/widget"]) assert.throws(() => hosts.inspectRemote(url));
  assert.equal(pullRequestUrl(REPO, 7), "https://bitbucket.org/acme/widget/pull-requests/7");
});

test("Bitbucket rejects rename, transfer, replacement UUID, wrong clone links and persisted binding changes", async () => {
  for (const mutate of [r => { r.slug = "renamed"; }, r => { r.workspace.slug = "other"; }, r => { r.uuid = WORKSPACE; }, r => { r.workspace.uuid = UUID; }, r => { r.links.clone[0].href = "https://github.com/acme/widget.git"; }]) {
    const f = fixture(); await f.api.inspectRepository(PATH); mutate(f.data.repository);
    await assert.rejects(f.api.inspectRepository(PATH), /identity|renamed|clone links/);
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
  const f = fixture({ config: { git_hosts: { "bitbucket.org": { repositories: { [PATH]: { uuid: WORKSPACE, workspaceUuid: UUID } } } } } });
  await assert.rejects(f.api.inspectRepository(PATH), /identity changed/);
});

test("Bitbucket preflight checks base, role, PR/comments and restrictions, distinguishing unknown write and archive access", async () => {
  const f = fixture(); f.data.prs = [pr()];
  f.data.restrictions = [{ id: 1, kind: "push", pattern: "main", users: [], groups: [] }];
  const report = await f.api.preflight(PATH, { base: "release/v2" });
  assert.equal(report.base, "release/v2"); assert.equal(report.baseSha, BASE); assert.equal(report.accountPush, "proved");
  assert.equal(report.commentRead, "proved"); assert.equal(report.pullRequestCreate, "unknown"); assert.equal(report.archived, "unknown"); assert.equal(report.branchRestrictions.length, 1);
  const detailRead = f.calls.findIndex(c => c.path === "/pullrequests/7");
  assert.ok(detailRead >= 0 && detailRead < f.calls.findIndex(c => c.path === "/pullrequests/7/comments"));
  await assert.rejects(f.api.preflight(PATH, { base: "missing" }), /HTTP 404/);
  f.data.permission = "read"; await assert.rejects(f.api.preflight(PATH), /no repository push access/);
  f.data.permission = "write"; f.data.repository.is_archived = true; await assert.rejects(f.api.preflight(PATH), /archived/);
  const unavailable = fixture({ intercept: c => c.path === "/branch-restrictions" ? json({}, 403) : undefined });
  assert.equal((await unavailable.api.preflight(PATH)).branchRestrictions, "unknown");
  for (const path of ["", "/pullrequests", "/pullrequests/7/comments"]) {
    const denied = fixture({ intercept: c => c.path === path ? json({}, 403) : undefined }); denied.data.prs = [pr()];
    await assert.rejects(denied.api.preflight(PATH), /restore the selected token/);
  }
});

test("Bitbucket preflight leaves comment access unknown when only fork PRs can be sampled", async () => {
  const f = fixture();
  f.data.prs = [pr({ source: { ...pr().source, repository: { uuid: WORKSPACE, full_name: "fork/widget" } } })];
  const report = await f.api.preflight(PATH);
  assert.equal(report.accountPush, "proved");
  assert.equal(report.commentRead, "unknown");
  assert.ok(!f.calls.some(c => c.path === "/pullrequests/7"));
});

test("Bitbucket credentials never fall back to GitHub; refresh is per operation without changing API account", async () => {
  await assert.rejects(resolveBitbucketCredential({ github_token_file: "ignored" }), /SSH key.*Git only.*PR\/comment/);
  await assert.rejects(resolveCredential({}, { host: "bitbucket.org", env: { GH_TOKEN: "never-send" } }), /cannot authorize/);
  const home = tempHome(), config = selectedConfig(home), options = { host: "bitbucket.org", path: PATH };
  assert.equal((await resolveBitbucketCredential(config, options)).token, "fixture-api-secret");
  writeFileSync(config.git_hosts["bitbucket.org"].api.token_file, "rotated-token");
  assert.equal((await resolveBitbucketCredential(config, options)).token, "rotated-token");
  chmodSync(config.git_hosts["bitbucket.org"].api.token_file, 0o644);
  await assert.rejects(resolveBitbucketCredential(config, options), /chmod 600/);
  await assert.rejects(resolveBitbucketCredential(config, { host: "evil.test" }), /host mismatch/);
  const f = fixture(); await f.api.inspectRepository(PATH); f.data.token = "rotated"; await f.api.inspectRepository(PATH);
  f.data.email = "other@example.test"; const count = f.calls.length;
  await assert.rejects(f.api.inspectRepository(PATH), /account changed/); assert.equal(f.calls.length, count);
});

test("Bitbucket preflight uses the authenticated user's effective role without workspace administration", async () => {
  const memberPath = "/2.0/workspaces/acme/permissions/repositories";
  const userPath = "/2.0/user/workspaces/acme/permissions/repositories";
  for (const permission of ["write", "admin", "read"]) {
    const f = fixture({ intercept: (c, data) => {
      // An administrator would see multiple members for the same repository here.
      if (c.path === memberPath) return json(page([
        { user: USER, repository: data.repository, permission },
        { user: { uuid: WORKSPACE }, repository: data.repository, permission: "admin" },
      ]));
    } });
    f.data.permission = permission;
    if (permission === "read") await assert.rejects(f.api.preflight(PATH), /no repository push access/);
    else assert.equal((await f.api.preflight(PATH)).accountPush, "proved");
    assert.ok(!f.calls.some(c => c.path === memberPath));
    const request = f.calls.find(c => c.path === userPath);
    assert.equal(new URL(request.url).searchParams.get("q"), `repository.uuid=${JSON.stringify(UUID)}`);
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
  const missing = fixture({ intercept: c => c.path === userPath ? json(page([])) : undefined });
  await assert.rejects(missing.api.preflight(PATH), /no repository push access/);
  const denied = fixture({ intercept: c => c.path === userPath ? json({}, 403) : undefined });
  await assert.rejects(denied.api.preflight(PATH), /restore the selected token/);
  for (const row of [{ user: {}, repository: { uuid: UUID }, permission: "write" }, { user: USER, repository: { uuid: WORKSPACE }, permission: "write" }]) {
    const malformed = fixture({ intercept: c => c.path === userPath ? json(page([row])) : undefined });
    await assert.rejects(malformed.api.preflight(PATH), /incomplete.*permissions/);
  }
  const switched = fixture(); await switched.api.preflight(PATH);
  switched.data.token = "rotated-token"; await switched.api.preflight(PATH);
  switched.data.user.uuid = WORKSPACE;
  await assert.rejects(switched.api.preflight(PATH), /account changed/);
});

test("Bitbucket API rejects redirects, foreign pagination, rates and transport secrets without leaking credentials", async () => {
  for (const response of [() => new Response(null, { status: 302, headers: { location: "https://evil.test/" } }), () => json({}, 429, { "Retry-After": "20" }), () => { throw new Error("fixture-api-secret Authorization: encoded-secret"); }]) {
    const f = fixture({ intercept: () => response() });
    await assert.rejects(f.api.inspectRepository(PATH), e => /BB_/.test(e.code) && !JSON.stringify({ message: e.message, stack: e.stack }).includes("secret"));
    assert.equal(f.calls.length, 1);
  }
  const f = fixture({ intercept: c => c.path === "/pullrequests" ? json({ values: [pr()], next: "https://evil.test/token" }) : undefined });
  await assert.rejects(f.api.prListByHead(PATH, "work/feature"), /refused API/);
  assert.ok(f.calls.every(c => c.url.startsWith("https://api.bitbucket.org/")));
});

test("Bitbucket snapshot is complete, normalized and bounded across comments, tasks, participants and current-head statuses", async () => {
  const f = fixture(); const snapshot = await f.registry.api.prView(REPO, 7);
  validateHostRecord(snapshot, "bitbucket.org", { pr: true, full: true });
  assert.equal(snapshot.repositoryId, UUID); assert.equal(snapshot.headSha, HEAD); assert.equal(snapshot.baseRefOid, BASE);
  assert.equal(snapshot.comments.length, 1); assert.equal(snapshot.tasks[0].state, "UNRESOLVED"); assert.equal(snapshot.participants[0].state, "changes_requested");
  assert.equal(snapshot.statusCheckRollup[0].outcome, "passed"); assert.match(snapshot.diff, /diff --git/);
  for (const [state, expected] of [["OPEN", "OPEN"], ["MERGED", "MERGED"], ["DECLINED", "CLOSED"]]) {
    f.data.prs = [pr({ state, draft: state === "OPEN", merge_commit: state === "MERGED" ? { hash: BASE } : null })];
    const next = await f.api.prView(PATH, 7); assert.equal(next.state, expected); assert.equal(next.hostState, state); assert.equal(next.isDraft, state === "OPEN");
  }
});

test("Bitbucket reads documented paginated status links for prView and prDiff", async () => {
  assert.equal(status().commit, undefined);
  for (const [state, outcome] of [["SUCCESSFUL", "passed"], ["FAILED", "failed"], ["INPROGRESS", "pending"], ["STOPPED", "failed"]]) {
    const f = fixture({ intercept: c => {
      if (!c.path.endsWith("/statuses")) return;
      assert.equal(c.path, `/commit/${HEAD}/statuses`);
      return c.url.includes("page=2") ? json({ values: [{ ...status(), key: "lint", state }], size: 2 })
        : json({ values: [status()], size: 2, next: `${c.url}&page=2` });
    } });
    const snapshot = await f.api.prView(PATH, 7);
    assert.deepEqual(snapshot.statusCheckRollup.map(s => [s.eventId, s.headSha, s.outcome]), [["build", HEAD, "passed"], ["lint", HEAD, outcome]]);
    assert.match(await f.api.prDiff(PATH, 7), /diff --git/);
  }
  const mixedCase = fixture();
  mixedCase.data.statuses[0].links.commit.href = status().links.commit.href.replace("acme/widget", "Acme/Widget");
  assert.equal((await mixedCase.api.prView(PATH, 7)).statusCheckRollup[0].headSha, HEAD);
});

test("Bitbucket rejects missing, foreign or stale status commit links on either snapshot read", async () => {
  for (const href of [undefined, "invalid", status().links.commit.href.replace(HEAD, BASE), status().links.commit.href.replace("acme/widget", "acme/other"), status().links.commit.href.replace("api.bitbucket.org", "evil.test"), `${status().links.commit.href}?unexpected=true`]) {
    for (const failedRead of [1, 2]) {
      for (const method of ["prView", "prDiff"]) {
        let reads = 0;
        const f = fixture({ intercept: c => c.path.endsWith("/statuses") && ++reads === failedRead ? json(page([{ ...status(), links: { commit: { href } } }])) : undefined });
        await assert.rejects(f.api[method](PATH, 7), { code: "BB_INCOMPLETE" });
        assert.equal(reads, failedRead);
        assert.ok(f.calls.every(c => c.method === "GET"));
      }
    }
  }
});

test("Bitbucket incomplete, stale, oversized and truncated evidence never becomes an empty or green snapshot", async () => {
  for (const mutate of [f => { f.data.comments = [{}]; }, f => { f.data.tasks = [{}]; }, f => { f.data.statuses = [{ ...status(), links: undefined }]; }, f => { f.data.statuses = [{ ...status(), state: "UNKNOWN" }]; }, f => { f.data.prs = [pr({ description: undefined })]; }, f => { f.data.prs = [pr({ draft: undefined })]; }]) {
    const f = fixture(); mutate(f); await assert.rejects(f.api.prView(PATH, 7), /incomplete/);
  }
  const oversized = fixture({ limits: { diffBytes: 10 } }); await assert.rejects(oversized.api.prView(PATH, 7), /exceeds/);
  let reads = 0;
  const stale = fixture({ intercept: c => c.path === "/pullrequests/7" && ++reads === 2 ? json(pr({ updated_on: "2026-11-01T12:00:00Z" })) : undefined });
  await assert.rejects(stale.api.prView(PATH, 7), /changed while reading/);
  const truncated = fixture({ intercept: c => c.path.endsWith("/comments") ? json({ values: [], size: 3 }) : undefined });
  await assert.rejects(truncated.api.prView(PATH, 7), /pagination size/);
});

test("Bitbucket pagination handles multiple pages and refuses cycles, changed filters, missing fields and limits", async () => {
  const f = fixture({ intercept: c => {
    if (c.path !== "/pullrequests/7/comments") return;
    return c.url.includes("page=2") ? json({ values: [comment(2)], size: 2 }) : json({ values: [comment(1)], size: 2, next: `${c.url}&page=2` });
  } });
  assert.deepEqual((await f.api.prView(PATH, 7)).comments.map(c => c.id), [1, 2]);
  for (const reply of [c => ({ values: [pr()], next: c.url }), c => ({ values: [pr()], next: c.url.replace("q=", "other=") }), () => ({}), () => ({ values: [], next: "https://api.bitbucket.org/2.0/repositories/acme/other/pullrequests" })]) {
    const bad = fixture({ intercept: c => c.path === "/pullrequests" ? json(reply(c)) : undefined });
    await assert.rejects(bad.api.prListByHead(PATH, "work/feature"), /pagination|incomplete|target/);
  }
  const limited = fixture({ limits: { items: 0 } }); limited.data.prs = [pr()];
  await assert.rejects(limited.api.prListByHead(PATH, "work/feature"), /bound/);
});

test("Bitbucket publishes or updates one same-repository PR, including read-after-timeout, with public validation", async () => {
  const f = fixture();
  assert.equal((await f.api.publishResultPr(publication)).number, 7);
  await f.api.publishResultPr(publication);
  await f.api.publishResultPr({ ...publication, title: "Update transport" });
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1); assert.equal(f.calls.filter(c => c.method === "PUT").length, 1);
  const payload = f.calls.find(c => c.method === "POST").body;
  assert.ok(f.calls.find(c => c.method === "POST").url.includes(`${encodeURIComponent(WORKSPACE)}/${encodeURIComponent(UUID)}`));
  assert.equal(payload.source.repository.uuid, UUID); assert.equal(payload.destination.repository.uuid, UUID);
  await assert.rejects(f.api.publishResultPr({ ...publication, title: "Generated with Gallivant" }), /public|branding|attribution/i);
  const timed = fixture({ intercept: (c, data) => {
    if (c.method === "POST") { data.prs = [pr()]; throw new Error("response lost"); }
  } });
  await timed.api.publishResultPr(publication); await timed.api.publishResultPr(publication);
  assert.equal(timed.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(timed.calls.at(-1).method, "GET");
});

test("Bitbucket resolves abbreviated live PR commits before publication and snapshot decisions", async () => {
  const shortHead = HEAD.slice(0, 12), shortBase = BASE.slice(0, 12);
  const f = fixture({ intercept: (call, data) => {
    if (call.path === "/pullrequests/7" && data.prs.length) {
      const row = structuredClone(data.prs[0]);
      row.source.commit.hash = shortHead; row.destination.commit.hash = shortBase;
      return json(row);
    }
    if (call.path === `/commit/${shortHead}`) return json({ hash: HEAD, date: NOW });
    if (call.path === `/commit/${shortBase}`) return json({ hash: BASE, date: NOW });
  } });
  const created = await f.api.publishResultPr(publication);
  assert.equal(created.headRefOid, HEAD); assert.equal(created.baseRefOid, BASE);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  const viewed = await f.api.prView(PATH, 7);
  assert.equal(viewed.headRefOid, HEAD); assert.equal(viewed.baseRefOid, BASE);
  assert.ok(f.calls.some(c => c.path === `/commit/${shortHead}`));
  assert.ok(f.calls.some(c => c.path === `/commit/${shortBase}`));
  f.data.prs[0].state = "MERGED"; f.data.prs[0].merge_commit = { hash: shortHead };
  const merged = await f.api.prView(PATH, 7);
  assert.equal(merged.mergeCommit.oid, HEAD);
});

test("Bitbucket's trimmed PR description remains idempotent for file-backed publication", async () => {
  const f = fixture(), request = { ...publication, body: "Approved change\n\n" };
  const first = await f.api.publishResultPr(request);
  assert.equal(first.body, "Approved change");
  await f.api.publishResultPr(request);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  assert.equal(f.calls.filter(c => c.method === "PUT").length, 0);
  const edited = await f.api.setBody(PATH, 7, "Updated receipt\n");
  assert.equal(edited.body, "Updated receipt");
  await f.api.setBody(PATH, 7, "Updated receipt\n");
  assert.equal(f.calls.filter(c => c.method === "PUT").length, 1);
});

test("Bitbucket recovery metadata survives description normalization and remains bound to the PR head", async () => {
  const f = fixture(), identity = { prd: "docs/prds/host-test.md", harness: "goose",
    session: "gallivant-068021d7-3490-4f2e-a6f1-30e1c00498c9", branch: "work/feature" };
  f.data.prs = [pr()];
  const observed = await f.api.setRecoveryMetadata(PATH, 7, identity);
  assert.deepEqual(parseBlock(observed.body).block, identity);
  assert.equal(observed.headRefOid, HEAD);
  assert.equal(observed.body.endsWith("\n"), false);
  assert.equal(f.calls.filter(c => c.method === "PUT").length, 1);
});

test("Bitbucket refuses ambiguous or mismatched PR commit expansion before any write", async () => {
  const shortHead = HEAD.slice(0, 12);
  for (const resolved of [BASE, shortHead, null]) {
    const f = fixture({ intercept: (call, data) => {
      if (call.path === "/pullrequests/7") {
        const row = structuredClone(data.prs[0]); row.source.commit.hash = shortHead; return json(row);
      }
      if (call.path === `/commit/${shortHead}`) return json({ hash: resolved, date: NOW });
    } });
    f.data.prs = [pr()];
    await assert.rejects(f.api.publishResultPr(publication), { code: "BB_INCOMPLETE" });
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
});

test("Bitbucket expands paginated PR summaries into complete records by repository and ID", async () => {
  const rows = [pr(), pr({ id: 8, links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/8" } } })];
  const f = fixture({ intercept: c => {
    if (c.path !== "/pullrequests") return;
    const summary = prSummary(rows[c.url.includes("page=2") ? 1 : 0]);
    assert.equal(summary.reviewers, undefined); assert.equal(summary.participants, undefined);
    summary.links = { ...summary.links, self: { href: "https://evil.test/pullrequests/7" } };
    return json({ values: [summary], size: 2, ...(c.url.includes("page=2") ? {} : { next: `${c.url}&page=2` }) });
  } });
  f.data.prs = rows;
  const result = await f.api.prListByHead(PATH, "work/feature");
  assert.deepEqual(result.map(p => p.number), [7, 8]);
  for (const record of result) {
    assert.equal(record.reviewers[0].login, USER.uuid);
    assert.equal(record.participants[0].state, "changes_requested");
    assert.equal(record.repositoryId, UUID);
  }
  assert.deepEqual(f.calls.filter(c => /^\/pullrequests\/\d+$/.test(c.path)).map(c => c.path), ["/pullrequests/7", "/pullrequests/8"]);
  assert.ok(f.calls.every(c => c.method === "GET" && new URL(c.url).host === "api.bitbucket.org"));
});

test("Bitbucket PR detail failures stop listing, preflight and publication without dropping evidence", async () => {
  const operations = [api => api.prListByHead(PATH, "work/feature"), api => api.preflight(PATH), api => api.publishResultPr(publication)];
  for (const operation of operations) {
    for (const [response, code] of [
      [() => json({}, 403), "BB_HTTP"], [() => json({}, 404), "BB_HTTP"], [() => json({}, 429), "BB_RATE_LIMIT"],
      [() => { throw new Error("detail unavailable"); }, "BB_TRANSPORT"],
      [() => json(pr({ reviewers: undefined })), "BB_INCOMPLETE"], [() => json(pr({ participants: undefined })), "BB_INCOMPLETE"],
      [() => json(pr({ id: 8, links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/8" } } })), "BB_IDENTITY"],
      [() => json(pr({ destination: { ...pr().destination, repository: { uuid: WORKSPACE, full_name: PATH } } })), "BB_IDENTITY"],
    ]) {
      const f = fixture({ intercept: c => c.path === "/pullrequests/7" ? response() : undefined }); f.data.prs = [pr()];
      await assert.rejects(operation(f.api), { code });
      assert.ok(f.calls.every(c => c.method === "GET"));
    }
    for (const id of [undefined, "7", -1, 1.5]) {
      const f = fixture({ intercept: c => c.path === "/pullrequests" ? json(page([{ ...prSummary(pr()), id }])) : undefined });
      await assert.rejects(operation(f.api), { code: "BB_INCOMPLETE" });
      assert.ok(!f.calls.some(c => /^\/pullrequests\//.test(c.path)));
    }
  }
});

test("Bitbucket retains uncertain publication when a post-write PR detail read fails", async () => {
  let created = false, allowDetails = false;
  const f = fixture({ intercept: c => {
    if (c.method === "POST") created = true;
    if (created && !allowDetails && c.path === "/pullrequests/7") return json({}, 403);
  } });
  await assert.rejects(f.api.publishResultPr(publication), /HTTP 403/);
  f.data.prs = [];
  await assert.rejects(f.api.publishResultPr(publication), /previous PR write/);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
  f.data.prs = [pr()]; allowDetails = true;
  assert.equal((await f.api.publishResultPr(publication)).number, 7);
  assert.equal(f.calls.filter(c => c.method === "POST").length, 1);
});

test("Bitbucket PR conflicts, forks and uncertain acceptance stop further writes", async () => {
  for (const rows of [[pr(), pr({ id: 8, links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/8" } } })], [pr({ destination: { ...pr().destination, branch: { name: "other" } } })], [pr({ source: { ...pr().source, repository: { uuid: WORKSPACE, full_name: "fork/widget" } } })]]) {
    const f = fixture(); f.data.prs = rows;
    await assert.rejects(f.api.publishResultPr(publication), /conflicting/);
    assert.ok(f.calls.every(c => c.method === "GET"));
  }
  const unknown = fixture({ intercept: c => { if (c.method === "POST") throw new Error("lost response"); } });
  await assert.rejects(unknown.api.publishResultPr(publication), /acceptance|unknown/);
  await assert.rejects(unknown.api.publishResultPr(publication), /previous PR write/);
  assert.equal(unknown.calls.filter(c => c.method === "POST").length, 1);
  const closed = fixture(); closed.data.prs = [pr({ state: "DECLINED" })];
  await assert.rejects(closed.api.setTitle(PATH, 7, "New title"), /conflicting/);
  assert.ok(closed.calls.every(c => c.method === "GET"));
});

test("Bitbucket native clone uses selected HTTPS or SSH, fresh base and operator identity, without tokens in argv", async () => {
  for (const transport of ["https", "ssh"]) {
    const home = tempHome(), config = selectedConfig(home, transport), calls = [];
    const f = fixture({ config, credential: options => resolveBitbucketCredential(config, options) });
    const git = makeGit({ config, hosts: f.registry, identity: async () => ({ name: "Operator", email: "operator@example.test" }), exec: async (cmd, args, options) => {
      calls.push({ cmd, args, env: options.env });
      if (args[0] === "remote") return { stdout: f.registry.remote(REPO).url };
      if (args[0] === "ls-remote") return { stdout: `${BASE}\trefs/heads/main\n` };
      return { stdout: "" };
    } });
    const report = await repositoryPreflight(config, REPO, { registry: f.registry, git });
    assert.equal(report.gitRead, "proved"); assert.equal(report.gitPush, "unknown");
    const path = await git.create({ nameWithOwner: REPO, prdId: "feature", base: "main" });
    assert.ok(path.startsWith(config.worktrees));
    assert.ok(calls.some(c => c.args[0] === "fetch" && c.args[2] === "main"));
    assert.ok(calls.some(c => c.args.join(" ") === "checkout -b work/feature origin/main"));
    const clone = calls.find(c => c.args[0] === "clone");
    assert.equal(clone.cmd, "git"); assert.ok(clone.args.includes(f.registry.remote(REPO).url));
    assert.doesNotMatch(JSON.stringify(calls.map(c => c.args)), /fixture-api-secret|fixture-git-secret/);
    const pairs = Object.entries(clone.env).filter(([k]) => k.startsWith("GIT_CONFIG_VALUE_")).map(([, v]) => v);
    assert.ok(pairs.includes("Operator")); assert.ok(pairs.includes("operator@example.test")); assert.equal(clone.env.GH_TOKEN, "");
    if (transport === "ssh") {
      assert.match(clone.env.GIT_SSH_COMMAND, /StrictHostKeyChecking=yes/); assert.match(clone.env.GIT_SSH_COMMAND, /IdentityAgent=none/); assert.match(clone.env.GIT_SSH_COMMAND, /selected key/); assert.match(clone.env.GIT_SSH_COMMAND, /UserKnownHostsFile="[^"\n]*known hosts"/); assert.equal(clone.env.GIT_HOST_TOKEN, "");
    } else { assert.equal(clone.env.GIT_HOST_USERNAME, "x-bitbucket-api-token-auth"); assert.equal(clone.env.GIT_HOST_TOKEN, "fixture-api-secret"); }
  }
});

test("Bitbucket Git/API mismatch, unverified SSH pins, and foreign credential-helper requests fail closed", async () => {
  assert.doesNotThrow(() => verifyBitbucketHostKeys(HOST_KEY));
  for (const key of ["", HOST_KEY.replace("ssh.bitbucket.org", "evil.test"), "ssh.bitbucket.org ssh-ed25519 aW52YWxpZA=="]) assert.throws(() => verifyBitbucketHostKeys(key), /published.*fingerprints/);
  const f = fixture(), git = makeGit({ config: { worktrees: tempHome() }, hosts: f.registry, exec: async () => ({ stdout: `${HEAD}\trefs/heads/main` }) });
  await assert.rejects(repositoryPreflight({}, REPO, { registry: f.registry, git }), /Git and API base identities differ/);
  const root = tempHome(); execFileSync("git", ["init", "-q", root]);
  const env = { PATH: process.env.PATH, HOME: root, GIT_TERMINAL_PROMPT: "0", ...runEnv(null, { host: "bitbucket.org", repository: PATH, username: "x-bitbucket-api-token-auth", token: "fixture-git-secret" }) };
  const fill = host => execFileSync("git", ["credential", "fill"], { cwd: root, env, input: `protocol=https\nhost=${host}\npath=acme/widget.git\n\n`, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  assert.match(fill("bitbucket.org"), /username=x-bitbucket-api-token-auth\npassword=fixture-git-secret/);
  for (const host of ["github.com", "evil.test"]) assert.throws(() => fill(host), e => !String(e.stdout).includes("fixture-git-secret"));
});

test("Bitbucket-only init and doctor need no gh and report disabled dispatch without a model call", async () => {
  const home = tempHome(), config = selectedConfig(home), f = fixture({ config });
  f.data.prs = [pr()];
  writeFileSync(join(home, "config.json"), JSON.stringify(config), { mode: 0o600 });
  const git = { probeAccess: async (_repo, base, hash) => { assert.equal(base, "main"); assert.equal(hash, BASE); return { gitRead: "proved", gitPush: "unknown" }; } };
  const transportPreflight = (c, repo) => repositoryPreflight(c, repo, { registry: f.registry, git });
  const results = await doctor({ home, registry: f.registry, transportPreflight, harnessCheck: ready, resolve: () => { throw new Error("GitHub resolver called"); } });
  assert.ok(results.some(r => /bitbucket.org access/.test(r.name) && r.ok)); assert.ok(!results.some(r => /gh auth/.test(r.name)));
  assert.match(renderDoctor(results).text, /Unknown until write.*PR creation/); assert.match(renderDoctor(results).text, /dispatch is disabled/);
  const output = await init({ home, gh: f.api, repository: () => ({ repo: REPO, origin: "git@bitbucket.org:acme/widget.git", checkout: home }), harnessCheck: ready, transportPreflight, doctor: async () => results });
  assert.match(renderInit(output, renderDoctor(results)), /dispatch is disabled/); assert.doesNotMatch(renderInit(output, renderDoctor(results)), /First task|gh auth login/);
  const saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")); assert.deepEqual(saved.git_hosts["bitbucket.org"].repositories[PATH], { uuid: UUID, workspaceUuid: WORKSPACE });
  delete config.git_hosts["bitbucket.org"].api;
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const failed = await doctor({ home, harnessCheck: ready });
  assert.match(renderDoctor(failed).text, /SSH key.*Git only.*PR\/comment/);
});

test("Bitbucket host gate survives config, status, dashboard and URL parsing without claiming review qualification", () => {
  const home = tempHome(), config = selectedConfig(home);
  assert.deepEqual(validate(merge(config, home), home), []);
  config.git_hosts["bitbucket.org"].api.token = "never-store";
  assert.ok(validate(merge(config, home), home).some(p => p.includes("private token file")));
  delete config.git_hosts["bitbucket.org"].api.token;
  assert.throws(() => hosts.select(REPO), /dispatch is disabled/);
  assert.throws(() => hosts.fromUrl("https://bitbucket.org/acme/widget/pull-requests/7"), /git-host-bitbucket/);
  const ctx = { home, config, state: makeState(home), log: silentLog };
  const m = model(ctx); assert.match(render(m), /dispatch is disabled/); assert.match(dashboard(m), /dispatch is disabled/);
  const checkout = tempHome(); execFileSync("git", ["init", "-q", checkout]); execFileSync("git", ["-C", checkout, "remote", "add", "origin", "git@ssh.bitbucket.org:Acme/Widget.git"]);
  assert.equal(targetRepository(checkout).repo, REPO); assert.equal(parseRemote("git@bitbucket.org:acme/widget.git").host, "bitbucket.org");
});

test("Bitbucket write targets remain immutable and branch validation precedes clone side effects", async () => {
  const f = fixture({ intercept: c => {
    if (c.method !== "GET") assert.ok(c.url.includes(`${encodeURIComponent(WORKSPACE)}/${encodeURIComponent(UUID)}`));
  } });
  await f.api.publishResultPr(publication);
  const count = f.calls.length;
  await assert.rejects(f.api.inspectRepository("other/repository"), /credential repository binding mismatch/);
  assert.equal(f.calls.length, count);
  let clones = 0;
  const git = makeGit({ config: { worktrees: tempHome() }, hosts: f.registry, exec: async () => { clones++; return { stdout: "" }; } });
  for (const args of [{ base: "--upload-pack=anything", prdId: "feature" }, { base: "main", prdId: "../escape" }]) {
    await assert.rejects(git.create({ nameWithOwner: REPO, ...args }), error => /Invalid Git branch/.test(error.message) && error.cloneAttempted === false);
  }
  assert.equal(clones, 0);
});

test("Bitbucket snapshot refuses duplicated pages and CI changes without a head movement", async () => {
  let statusReads = 0;
  const stale = fixture({ intercept: c => c.path.endsWith("/statuses") ? json(page([{ ...status(), state: ++statusReads === 1 ? "SUCCESSFUL" : "FAILED" }])) : undefined });
  await assert.rejects(stale.api.prView(PATH, 7), /changed while reading/);
  const duplicate = fixture({ intercept: c => c.path.endsWith("/comments") ? json(page([comment(1), comment(1)])) : undefined });
  await assert.rejects(duplicate.api.prView(PATH, 7), /duplicate identity/);
});

test("Bitbucket honors only the documented same-repository diff redirect", async () => {
  const f = fixture({ intercept: c => {
    if (c.path.endsWith("/7/diff")) return new Response(null, { status: 302, headers: { Location: `https://api.bitbucket.org/2.0/repositories/acme/widget/diff/${HEAD}..${BASE}` } });
    if (c.path.startsWith("/diff/")) return new Response("diff --git a/a b/a\n+change\n");
  } });
  assert.match((await f.api.prView(PATH, 7)).diff, /diff --git/);
  const foreign = fixture({ intercept: c => c.path.endsWith("/7/diff") ? new Response(null, { status: 302, headers: { Location: "https://api.bitbucket.org/2.0/repositories/acme/other/diff/x" } }) : undefined });
  await assert.rejects(foreign.api.prView(PATH, 7), /refused API/);
});

test("Bitbucket start and register refuse before clone, publication or model dispatch", async () => {
  const { register } = await import("../lib/commands/register.mjs");
  const { start } = await import("../lib/commands/start.mjs");
  const f = fixture(), home = tempHome();
  const ctx = { home, config: selectedConfig(home), state: makeState(home), hosts: f.registry, host: f.registry.api, log: silentLog, git: { create: () => { throw new Error("unexpected clone"); } } };
  await assert.rejects(register(ctx, { url: "https://bitbucket.org/acme/widget/pull-requests/7" }), /dispatch is disabled/);
  const request = { ...parsePrd(GOOD_PRD, "docs/prds/feature.md"), repo: REPO, harness: "codex", defaultBranch: "main" };
  await assert.rejects(start(ctx, { request }), error => /dispatch is disabled/.test(error.message) && error.startUncertain === false);
  assert.equal(f.calls.length, 0);
});

test("Bitbucket rejected HTTP and redirect responses release unread bodies", async () => {
  for (const code of [302, 403, 429]) {
    let cancelled = false;
    const f = fixture({ intercept: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: code, headers: { location: 'https://evil.test/' } }) });
    await assert.rejects(f.api.inspectRepository(PATH));
    assert.equal(cancelled, true);
  }
});
