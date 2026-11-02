// Bitbucket wire transport only. Review decisions and task state stay in the shared lifecycle.
import { bitbucketFeedback, bitbucketVerdict } from "./bitbucket_review.mjs";
import { normalizePublicBody, parseBlock, renderBlock } from "../block.mjs";
import { bitbucketDefinition, bitbucketPrompts } from "./bitbucket_contract.mjs";
import { fileURLToPath } from "node:url";
import { resolveBitbucketCredential } from "./bitbucket_credential.mjs";
import { repositoryIdentity, parseRemote, assertBranchName } from "../repository.mjs";
import { MAX_DIFF_BYTES } from "../host_contract.mjs";
import { assertPublicText } from "../public_output.mjs";

const ROOT = "https://api.bitbucket.org/2.0";
const source = Object.freeze({ host: "bitbucket.org", adapter: "bitbucket-pull-request" });
const uuid = value => typeof value === "string" && /^\{[0-9a-f-]{36}\}$/i.test(value);
const sha = value => typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const fault = (code, message, extra = {}) => Object.assign(new Error(`Bitbucket ${message}`), { code, ...extra });
const incomplete = what => fault("BB_INCOMPLETE", `incomplete ${what}; preserve state and retrieve complete evidence`);
const actor = user => {
  if (!uuid(user?.uuid)) throw incomplete("actor identity");
  return { login: user.uuid.toLowerCase(), bot: user.type === "app_user", displayName: user.display_name ?? null, accountId: user.account_id ?? null };
};
function stamp(row, kind, headSha = null) {
  if (row.id == null || !date(row.created_on) || !date(row.updated_on)) throw incomplete(`${kind} timestamps or identity`);
  return { source, eventId: String(row.id), actor: actor(row.user ?? row.author), headSha, createdAt: row.created_on, updatedAt: row.updated_on, at: row.created_on, kind };
}
export const bitbucketBranch = assertBranchName;
function repositoryRecord(row, expected) {
  if (!uuid(row?.uuid) || !uuid(row.workspace?.uuid) || typeof row.is_private !== "boolean" || row.scm !== "git" || !row.mainbranch?.name || !row.slug || !row.workspace.slug || !row.full_name) throw incomplete("repository identity");
  const actual = repositoryIdentity(`${row.workspace.slug}/${row.slug}`, "bitbucket.org");
  if (actual.remoteIdentity !== expected.remoteIdentity || repositoryIdentity(row.full_name, "bitbucket.org").remoteIdentity !== expected.remoteIdentity) throw fault("BB_IDENTITY", "repository renamed or transferred; inspect origin and explicitly rebind before retrying");
  if (!Array.isArray(row.links?.clone) || !row.links.clone.length || row.links.clone.some(link => !["https", "ssh"].includes(link.name) || parseRemote(link.href).remoteIdentity !== expected.remoteIdentity)) throw fault("BB_IDENTITY", "API clone links do not match the selected repository");
  return { ...expected, uuid: row.uuid.toLowerCase(), workspaceUuid: row.workspace.uuid.toLowerCase(), workspace: actual.path.split("/")[0], slug: actual.path.split("/")[1], private: row.is_private, defaultBranch: row.mainbranch.name,
    archived: typeof row.is_archived === "boolean" ? row.is_archived : "unknown" };
}
function normalizePr(row, identity) {
  if (!Number.isSafeInteger(row?.id) || row.id < 1 || !["OPEN", "MERGED", "DECLINED", "SUPERSEDED"].includes(row.state) || typeof row.draft !== "boolean" || typeof row.title !== "string" || typeof row.description !== "string" || !Array.isArray(row.participants) || !Array.isArray(row.reviewers)) throw incomplete("pull request");
  for (const side of [row.source, row.destination]) {
    if (!side?.branch?.name || !sha(side.commit?.hash) || !uuid(side.repository?.uuid) || !side.repository.full_name) throw incomplete("PR branch, commit or repository");
  }
  if (row.destination.repository.uuid.toLowerCase() !== identity.uuid || repositoryIdentity(row.destination.repository.full_name, "bitbucket.org").path !== identity.path) throw fault("BB_IDENTITY", "PR destination identity mismatch");
  const cross = row.source.repository.uuid.toLowerCase() !== identity.uuid || repositoryIdentity(row.source.repository.full_name, "bitbucket.org").path !== identity.path;
  const url = bitbucketDefinition.prUrl(identity, row.id);
  if (row.links?.html?.href !== url) throw fault("BB_IDENTITY", "PR URL identity mismatch");
  const participants = row.participants.map(p => {
    if (typeof p.approved !== "boolean" || !["PARTICIPANT", "REVIEWER"].includes(p.role)) throw incomplete("reviewer participant");
    return { actor: actor(p.user), role: p.role, approved: p.approved, state: p.state ?? null, participatedAt: p.participated_on ?? null };
  });
  return { ...stamp(row, "pull-request", row.source.commit.hash), number: row.id, url, title: row.title, body: row.description,
    headRefName: row.source.branch.name, baseRefName: row.destination.branch.name, headRefOid: row.source.commit.hash, baseRefOid: row.destination.commit.hash,
    repositoryId: identity.uuid, sourceRepositoryId: row.source.repository.uuid.toLowerCase(), baseRepositoryId: identity.uuid,
    isCrossRepository: cross, isDraft: row.draft, state: row.state === "MERGED" ? "MERGED" : row.state === "OPEN" ? "OPEN" : "CLOSED", hostState: row.state,
    mergeCommit: sha(row.merge_commit?.hash) ? { oid: row.merge_commit.hash } : null, mergedAt: null, strictIdentity: true,
    participants, reviewers: row.reviewers.map(actor), complete: true };
}
function normalizeComment(row, prUrl = null) {
  if (typeof row.deleted !== "boolean" || (!row.deleted && typeof row.content?.raw !== "string")) throw incomplete("comment");
  let headSha = bitbucketVerdict(row.content?.raw)?.headSha ?? row.content?.raw?.match(/^Reviewed commit:\s*`?([0-9a-f]{40})`?\s*$/mi)?.[1]?.toLowerCase() ?? null;
  if (row.links?.code?.href && prUrl) {
    let code, pr;
    try { code = new URL(row.links.code.href); pr = new URL(prUrl); } catch { throw incomplete("inline commit link"); }
    const match = code.pathname.match(/^\/([^/]+\/[^/]+)\/src\/([0-9a-f]{40})(?:\/|$)/i);
    if (code.origin !== pr.origin || !match || match[1].toLowerCase() !== pr.pathname.split("/").slice(1, 3).join("/").toLowerCase()) throw incomplete("inline commit link");
    if (headSha && headSha !== match[2].toLowerCase()) throw incomplete("conflicting comment commit");
    headSha = match[2].toLowerCase();
  }
  return { ...stamp(row, row.inline ? "inline" : "comment", headSha), headBinding: headSha || row.inline || bitbucketVerdict(row.content?.raw) ? "exact" : "cursor", url: prUrl ? `${prUrl}#comment-${row.id}` : null, id: row.id, body: row.deleted ? "" : row.content.raw, deleted: row.deleted, replyTo: row.parent?.id ?? null,
    path: row.inline?.path ?? null, line: row.inline?.to ?? row.inline?.from ?? null, resolved: row.resolution != null };
}
function normalizeTask(row) {
  if (!Number.isSafeInteger(row?.id) || !["RESOLVED", "UNRESOLVED"].includes(row.state) || typeof row.content?.raw !== "string" || !date(row.created_on) || !date(row.updated_on)) throw incomplete("task");
  return { source, eventId: String(row.id), actor: actor(row.creator), headSha: null, createdAt: row.created_on, updatedAt: row.updated_on,
    id: row.id, state: row.state, body: row.content.raw, commentId: row.comment?.id ?? null };
}
function normalizeStatus(row, head, commitUrl) {
  // Statuses carry a commit link, not a nested commit. Bind evidence to the queried head;
  // compare the canonical link without following it or accepting another repository.
  const commitLink = row?.links?.commit?.href;
  if (!row?.key || !row.name || !["SUCCESSFUL", "FAILED", "INPROGRESS", "STOPPED"].includes(row.state) || !date(row.created_on) || !date(row.updated_on) || typeof commitLink !== "string" || commitLink.toLowerCase() !== commitUrl.toLowerCase() || typeof row.url !== "string") throw incomplete("current-head build status");
  return { source, eventId: row.key, actor: { login: "", bot: false }, headSha: head, name: row.name, state: row.state,
    outcome: row.state === "SUCCESSFUL" ? "passed" : row.state === "INPROGRESS" ? "pending" : "failed", url: row.url, runId: null, createdAt: row.created_on, updatedAt: row.updated_on };
}

export function makeBitbucket({ config = {}, credential, fetch: request = globalThis.fetch, limits = {} } = {}) {
  const bound = new Map(), pending = new Set(), publishing = new Set();
  let account = null, accountUuid = null;
  const maxPages = limits.pages ?? 100, maxItems = limits.items ?? 10_000, maxJson = limits.jsonBytes ?? 4 * 1024 * 1024;
  function allowed(url, prefix) {
    let target;
    try { target = new URL(url); } catch { throw fault("BB_TARGET", "invalid API target"); }
    if (target.origin !== "https://api.bitbucket.org" || target.username || target.password || target.hash || !target.pathname.startsWith(`${prefix}/`) && target.pathname !== prefix) throw fault("BB_TARGET", "refused API host/repository redirect or pagination target");
    return target;
  }
  async function call(url, { method = "GET", body, text = false, prefix, diffRedirect = false } = {}) {
    const target = allowed(url, prefix);
    const c = await credential({ operation: "api" });
    if (c?.host !== "bitbucket.org" || !c.token || typeof c.email !== "string" || !/^[^\s:@]+@[^\s:@]+$/.test(c.email)) throw fault("NO_CREDENTIAL", "account API token and email required for PR/comment access");
    const binding = bound.get(c.repository);
    const immutablePrefix = binding ? `/2.0/repositories/${encodeURIComponent(binding.workspaceUuid)}/${encodeURIComponent(binding.uuid)}` : null;
    if (c.repository && ![`/2.0/repositories/${c.repository}`, `/2.0/user/workspaces/${c.repository.split("/")[0]}/permissions/repositories`, immutablePrefix].includes(prefix)) throw fault("BB_IDENTITY", "credential repository binding mismatch");
    const login = c.email.toLowerCase();
    if (account && account !== login) throw fault("BB_IDENTITY", "API account changed; explicitly rebind instead of silently changing identity");
    account = login;
    const auth = `Basic ${Buffer.from(`${c.email}:${c.token}`).toString("base64")}`;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), limits.timeoutMs ?? 20_000);
    let response;
    try {
      response = await request(target.href, { method, headers: { Authorization: auth, Accept: text ? "text/plain" : "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, redirect: "manual", cache: "no-store", signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        // The PR diff endpoint documents a redirect to the repository diff endpoint. Never follow arbitrary links.
        const location = response.headers.get("location");
        if (diffRedirect && [301, 302, 303, 307].includes(response.status) && location) {
          const next = allowed(new URL(location, target).href, prefix);
          if (!next.pathname.startsWith(`${prefix}/diff/`)) throw fault("BB_TARGET", "unexpected diff redirect");
          return await call(next.href, { text: true, prefix });
        }
        throw fault("BB_IDENTITY", "API redirect refused; repository may have been renamed or transferred");
      }
      if (!response.ok) throw fault(response.status === 429 ? "BB_RATE_LIMIT" : "BB_HTTP", `API returned HTTP ${response.status}; ${[401, 403].includes(response.status) ? "restore the selected token's repository and pull-request read/write access" : "restore API access and retry the read before writing"}`, { status: response.status, retryAfter: response.headers.get("retry-after") });
      const max = text ? (limits.diffBytes ?? MAX_DIFF_BYTES) : maxJson;
      if (Number(response.headers.get("content-length")) >= max) { await response.body?.cancel(); throw fault("BB_OVERSIZED", "response exceeds the evidence bound"); }
      if (!response.body) throw incomplete("response body");
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.byteLength;
        if (length >= max) { controller.abort(); throw fault("BB_OVERSIZED", "response exceeds the evidence bound"); }
        chunks.push(Buffer.from(chunk));
      }
      const value = Buffer.concat(chunks).toString("utf8");
      if (text) return value;
      try { return JSON.parse(value); } catch { throw incomplete("JSON response"); }
    } catch (error) {
      if (error.code?.startsWith("BB_")) throw error;
      // Transport diagnostics may contain Authorization or a token in an echoed URL. Never retain them.
      throw fault("BB_TRANSPORT", `${method} transport failed or timed out; acceptance is unknown, read before retrying`, { uncertain: method !== "GET" });
    } finally {
      clearTimeout(timer);
      // Release unread error/redirect bodies too; repeated failures must not retain sockets.
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
  }
  async function pages(url, prefix) {
    const first = allowed(url, prefix), seen = new Set(), ids = new Set(), rows = []; let count = 0, expectedSize = null;
    while (url) {
      const target = allowed(url, prefix);
      const filters = value => [...value.searchParams].filter(([key]) => !["page", "pagelen", "after", "before"].includes(key)).sort().toString();
      if (target.pathname !== first.pathname || filters(target) !== filters(first) || seen.has(target.href) || ++count > maxPages) throw incomplete("pagination (cycle, changed query or page limit)");
      seen.add(target.href);
      const data = await call(target.href, { prefix });
      if (!Array.isArray(data?.values) || (data.next != null && (typeof data.next !== "string" || !data.next)) || (data.size != null && (!Number.isSafeInteger(data.size) || data.size < 0))) throw incomplete("page");
      if (data.size != null) {
        if (expectedSize !== null && expectedSize !== data.size) throw fault("BB_STALE", "collection changed during pagination; retry a complete read");
        expectedSize = data.size;
      }
      for (const row of data.values) {
        const id = row?.id ?? row?.uuid ?? row?.key ?? row?.repository?.uuid;
        if (id != null && ids.has(String(id))) throw incomplete("pagination duplicate identity");
        if (id != null) ids.add(String(id));
        rows.push(row);
      }
      if (rows.length > maxItems || (data.next && !data.values.length)) throw incomplete("collection bound");
      url = data.next || null;
    }
    if (expectedSize !== null && rows.length !== expectedSize) throw incomplete("pagination size");
    return rows;
  }
  const scope = (repo, identity = null) => {
    const r = repositoryIdentity(repo, "bitbucket.org");
    if (r.host !== "bitbucket.org") throw fault("BB_TARGET", "unsupported repository host");
    const path = identity ? `${encodeURIComponent(identity.workspaceUuid)}/${encodeURIComponent(identity.uuid)}` : r.path;
    return { r, prefix: `/2.0/repositories/${path}`, url: `${ROOT}/repositories/${path}` };
  };
  async function inspect(repo) {
    const { r, prefix, url } = scope(repo), raw = await call(url, { prefix });
    const result = repositoryRecord(raw, r), previous = bound.get(r.path) ?? config.git_hosts?.["bitbucket.org"]?.repositories?.[r.path];
    if (previous?.uuid && (previous.uuid !== result.uuid || previous.workspaceUuid !== result.workspaceUuid)) throw fault("BB_IDENTITY", "immutable repository/workspace identity changed; inspect and explicitly rebind");
    bound.set(r.path, result);
    return result;
  }
  async function branch(repo, name) {
    bitbucketBranch(name);
    const { url, prefix } = scope(repo), row = await call(`${url}/refs/branches/${encodeURIComponent(name)}`, { prefix });
    if (row?.name !== name || !sha(row.target?.hash)) throw incomplete("base branch");
    return row.target.hash;
  }
  async function listPr(repo, name, { allStates = false, skipForks = false } = {}) {
    const identity = await inspect(repo), { url, prefix } = scope(repo);
    const q = name ? `source.branch.name=${JSON.stringify(bitbucketBranch(name))}` : null;
    const states = allStates ? "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED" : "state=OPEN";
    const rows = await pages(`${url}/pullrequests?pagelen=50&${states}${q ? `&q=${encodeURIComponent(q)}` : ""}`, prefix);
    // Collections omit reviewers and participants. Read each bounded result by ID
    // through the selected repository, never through a response-supplied URL.
    const records = [];
    for (const row of rows) {
      // Repository-wide discovery cannot use a fork's commit endpoint through
      // this repository binding. Publication still examines every matching
      // branch, including forks, so it can refuse a conflicting PR.
      if (skipForks && uuid(row?.source?.repository?.uuid) && row.source.repository.uuid.toLowerCase() !== identity.uuid) continue;
      records.push(await readPr(repo, row?.id, identity));
    }
    return records;
  }
  async function readPr(repo, n, identity) {
    if (!Number.isSafeInteger(n) || n < 1) throw incomplete("PR number");
    const { url, prefix } = scope(repo), raw = await call(`${url}/pullrequests/${n}`, { prefix });
    // Bitbucket's detail API abbreviates commit hashes even when the branch API
    // returns full IDs. Resolve the PR's pinned commits, not the current branch
    // tips: either branch may move while this snapshot is being collected.
    const exactCommit = async abbreviated => {
      if (sha(abbreviated)) return abbreviated;
      if (!/^[0-9a-f]{12,39}$/.test(abbreviated ?? "")) throw incomplete("PR commit abbreviation");
      const row = await call(`${url}/commit/${abbreviated}`, { prefix });
      if (!sha(row?.hash) || !row.hash.startsWith(abbreviated) || !date(row.date)) throw incomplete("resolved PR commit identity/date");
      return row.hash;
    };
    const expand = async side => {
      if (!side?.branch?.name || !uuid(side.repository?.uuid) || !side.repository?.full_name) throw incomplete("PR branch or repository");
      if (side.repository.uuid.toLowerCase() !== identity.uuid || repositoryIdentity(side.repository.full_name, "bitbucket.org").path !== identity.path) throw fault("BB_IDENTITY", "conflicting cross-repository PR cannot be bound to this checkout");
      return { ...side, commit: { ...side.commit, hash: await exactCommit(side.commit?.hash) } };
    };
    const source = await expand(raw?.source), destination = await expand(raw?.destination);
    const merge = raw?.merge_commit?.hash;
    const mergeCommit = merge ? { ...raw.merge_commit, hash: await exactCommit(merge) } : raw?.merge_commit;
    const normalized = normalizePr({ ...raw, source, destination, merge_commit: mergeCommit }, identity);
    if (normalized.number !== n) throw fault("BB_IDENTITY", "PR number mismatch");
    return normalized;
  }
  const fingerprint = pr => JSON.stringify([pr.eventId, pr.headRefOid, pr.baseRefOid, pr.headRefName, pr.baseRefName, pr.sourceRepositoryId, pr.baseRepositoryId, pr.updatedAt, pr.title, pr.body, pr.hostState, pr.isDraft, pr.participants, pr.mergeCommit]);
  async function snapshot(repo, n) {
    const identity = await inspect(repo), { url, prefix } = scope(repo), first = await readPr(repo, n, identity);
    const comments = (await pages(`${url}/pullrequests/${n}/comments?pagelen=50`, prefix)).map(row => normalizeComment(row, first.url));
    const tasks = (await pages(`${url}/pullrequests/${n}/tasks?pagelen=50`, prefix)).map(normalizeTask);
    const commitUrl = `${url}/commit/${first.headSha}`;
    const statusCheckRollup = (await pages(`${commitUrl}/statuses?pagelen=50`, prefix)).map(row => normalizeStatus(row, first.headSha, commitUrl));
    const diff = await call(`${url}/pullrequests/${n}/diff`, { text: true, prefix, diffRedirect: true });
    // Activity/CI can change without moving a branch. Recheck collections as well as PR metadata.
    const finalComments = (await pages(`${url}/pullrequests/${n}/comments?pagelen=50`, prefix)).map(row => normalizeComment(row, first.url));
    const finalTasks = (await pages(`${url}/pullrequests/${n}/tasks?pagelen=50`, prefix)).map(normalizeTask);
    const finalStatuses = (await pages(`${commitUrl}/statuses?pagelen=50`, prefix)).map(row => normalizeStatus(row, first.headSha, commitUrl));
    const last = await readPr(repo, n, await inspect(repo));
    if (fingerprint(first) !== fingerprint(last) || collectionKey([comments, tasks, statusCheckRollup]) !== collectionKey([finalComments, finalTasks, finalStatuses])) throw fault("BB_STALE", "PR changed while reading evidence; discard snapshot and retry");
    const result = { ...first, comments, tasks, statusCheckRollup, diff };
    if (first.state === "MERGED") {
      if (!first.mergeCommit) throw incomplete("merge commit");
      // The merge commit's date is verifiable; updated_on may describe a later edit.
      result.mergedAt = (await commit(repo, first.mergeCommit.oid)).date;
    }
    return { ...result, feedback: bitbucketFeedback(result) };
  }
  const collectionKey = lists => JSON.stringify(lists.map(rows => [...rows].sort((a, b) => String(a.eventId).localeCompare(String(b.eventId)))));
  async function commit(repo, hash) {
    if (!sha(hash)) throw incomplete("full commit SHA");
    const { url, prefix } = scope(repo), row = await call(`${url}/commit/${hash}`, { prefix });
    if (row?.hash !== hash || !date(row.date)) throw incomplete("commit identity/date");
    return row;
  }
  async function user(repo) {
    const identity = await inspect(repo), prefix = `/2.0/user/workspaces/${identity.workspace}/permissions/repositories`;
    const rows = await pages(`https://api.bitbucket.org${prefix}?pagelen=50&q=${encodeURIComponent(`repository.uuid=${JSON.stringify(identity.uuid)}`)}`, prefix);
    if (rows.length !== 1 || rows[0].repository?.uuid?.toLowerCase() !== identity.uuid) throw incomplete("authenticated repository actor");
    const login = actor(rows[0].user).login;
    if (accountUuid && accountUuid !== login) throw fault("BB_IDENTITY", "API actor changed; explicitly rebind before retrying");
    accountUuid = login;
    return login;
  }
  async function fileAtStrict(repo, path, ref) {
    if (typeof path !== "string" || !path || /[\\\0]/.test(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git")) throw incomplete("repository file path");
    await inspect(repo);
    const hash = sha(ref) ? ref : await branch(repo, ref);
    await commit(repo, hash); // A 404 below means a missing file, not a missing revision.
    const { url, prefix } = scope(repo);
    const target = `${url}/src/${hash}/${path.split("/").map(encodeURIComponent).join("/")}`;
    let metadata;
    try { metadata = await call(`${target}?format=meta`, { prefix }); }
    catch (e) { if (e.status === 404) return null; throw e; }
    if (metadata?.type !== "commit_file" || metadata.path !== path || metadata.commit?.hash !== hash || !Number.isSafeInteger(metadata.size) || metadata.size < 0) throw incomplete("repository file metadata");
    const content = await call(target, { text: true, prefix });
    if (Buffer.byteLength(content) !== metadata.size) throw incomplete("repository file size");
    return content;
  }
  async function preflight(repo, { base = null } = {}) {
    const identity = await inspect(repo), { url, prefix } = scope(repo);
    if (identity.archived === true) throw fault("BB_PERMISSION", "repository is archived; select a writable repository");
    const approvedBase = bitbucketBranch(base ?? identity.defaultBranch), baseSha = await branch(repo, approvedBase);
    // The /user endpoint returns only the authenticated account's effective role.
    // The workspace-wide member endpoint requires administration and cannot prove this account's access.
    const permissionPrefix = `/2.0/user/workspaces/${identity.workspace}/permissions/repositories`;
    const permissions = await pages(`${ROOT}/user/workspaces/${identity.workspace}/permissions/repositories?pagelen=50&q=${encodeURIComponent(`repository.uuid=${JSON.stringify(identity.uuid)}`)}`, permissionPrefix);
    if (permissions.length > 1 || permissions.some(p => !uuid(p?.repository?.uuid) || p.repository.uuid.toLowerCase() !== identity.uuid || !uuid(p.user?.uuid) || !["read", "write", "admin"].includes(p.permission))) throw incomplete("repository permissions");
    const permission = permissions[0];
    if (permission) {
      const userUuid = permission.user.uuid.toLowerCase();
      if (accountUuid && accountUuid !== userUuid) throw fault("BB_IDENTITY", "API account changed; explicitly rebind instead of silently changing identity");
      accountUuid = userUuid;
    }
    if (!permission || !["write", "admin"].includes(permission.permission)) throw fault("BB_PERMISSION", "selected API account has no repository push access; grant repository write access before starting a task");
    const prs = await pages(`${url}/pullrequests?pagelen=50&state=OPEN`, prefix);
    let commentRead = "unknown";
    // A fork PR may have a source commit that the selected repository cannot
    // resolve. Only sample a same-repository PR for comment-read evidence.
    const sample = prs.find(row => row?.source?.repository?.uuid?.toLowerCase() === identity.uuid);
    if (sample) {
      const pr = await readPr(repo, sample.id, identity);
      (await pages(`${url}/pullrequests/${pr.number}/comments?pagelen=50`, prefix)).map(row => normalizeComment(row, pr.url));
      commentRead = "proved";
    }
    let restrictions;
    try {
      restrictions = await pages(`${url}/branch-restrictions?pagelen=50`, prefix);
      if (restrictions.some(r => !Number.isSafeInteger(r.id) || typeof r.kind !== "string" || typeof r.pattern !== "string")) throw incomplete("branch restrictions");
    } catch (error) {
      if (error.status !== 403) throw error;
      restrictions = "unknown"; // Not all non-admin tokens can inspect restrictions. Do not claim they are absent.
    }
    return { identity, base: approvedBase, baseSha, repositoryRead: "proved", accountPush: "proved", pullRequestRead: "proved", commentRead,
      gitRead: "unknown", gitPush: "unknown", apiRepositoryWrite: "unknown", pullRequestCreate: "unknown", commentWrite: "unknown", archived: identity.archived, branchRestrictions: restrictions,
      unknownAtWrite: ["Git push", "repository token write scope", "PR creation", "comment creation", ...(identity.archived === "unknown" ? ["archive state (not exposed)"] : [])] };
  }
  async function publish({ repo, branch: head, base, title, body, expectedNumber = null }) {
    if (typeof title !== "string" || typeof body !== "string") throw incomplete("public title/body text");
    // Bitbucket strips trailing newlines from PR descriptions. Compare and
    // publish the same canonical text so an accepted write is not mistaken for
    // an unresolved write on every subsequent read.
    title = title.trim(); body = body.trimEnd();
    assertPublicText(title, "PR title"); assertPublicText(body, "PR body"); bitbucketBranch(head); bitbucketBranch(base);
    if (!title || head === base) throw fault("BB_PR_CONFLICT", "PR requires a title and separate source/base branches");
    const identity = await inspect(repo), { url, prefix } = scope(repo, identity), key = `${identity.uuid}/${head}/${base}`;
    await branch(repo, head); await branch(repo, base);
    const reconcile = async () => {
      const rows = await listPr(repo, head, { allStates: true });
      if (rows.length > 1 || rows.some(p => p.isCrossRepository || p.repositoryId !== identity.uuid || p.headRefName !== head || p.baseRefName !== base || p.state !== "OPEN")) throw fault("BB_PR_CONFLICT", "conflicting existing PR; inspect branch/base and repository ownership before retrying");
      return rows[0] ?? null;
    };
    const existing = await reconcile();
    if (expectedNumber !== null && existing?.number !== expectedNumber) throw fault("BB_PR_CONFLICT", "selected PR no longer matches the open branch/base; inspect before writing");
    if (!existing && pending.has(key)) throw fault("BB_WRITE_UNKNOWN", "previous PR write remains unresolved; inspect the repository before another create");
    if (existing?.title === title && existing.body === body) { pending.delete(key); return existing; }
    const payload = existing ? { title, description: body } : { title, description: body, source: { branch: { name: head }, repository: { uuid: identity.uuid } }, destination: { branch: { name: base }, repository: { uuid: identity.uuid } }, close_source_branch: false };
    let failure;
    try { await call(`${url}/pullrequests${existing ? `/${existing.number}` : ""}`, { method: existing ? "PUT" : "POST", body: payload, prefix }); }
    catch (error) {
      if (!error.uncertain && !(error.status >= 500) && !["BB_INCOMPLETE", "BB_OVERSIZED"].includes(error.code)) throw error;
      failure = error;
    }
    // A successful write is unresolved until every reconciliation read succeeds.
    // Preserve this marker if a list or detail read fails after the server accepted it.
    pending.add(key);
    const accepted = await reconcile(); // Always read after a write, including an accepted write whose response was lost.
    if (!accepted || accepted.title !== title || accepted.body !== body || existing && accepted.number !== existing.number) {
      pending.add(key); throw failure ?? fault("BB_WRITE_UNKNOWN", "PR write acceptance unresolved; read before retrying");
    }
    pending.delete(key);
    return accepted;
  }
  async function publishResultPr(options) {
    const key = scope(options.repo).r.remoteIdentity;
    if (publishing.has(key)) throw fault("BB_BUSY", "repository publication already in progress; read before retrying");
    publishing.add(key);
    try { return await publish(options); } finally { publishing.delete(key); }
  }
  return {
    inspectRepository: inspect, preflight, publishResultPr,
    user: async () => { const c = await credential({ operation: "api" }); if (!c.repository) throw incomplete("credential repository binding"); return user(c.repository); },
    commitDate: async (repo, hash) => { await inspect(repo); return (await commit(repo, hash)).date; },
    fileAt: fileAtStrict, fileAtStrict,
    containsCommit: async (repo, ref, hash) => {
      await inspect(repo); await commit(repo, hash);
      const head = sha(ref) ? ref : await branch(repo, ref), { url, prefix } = scope(repo);
      const common = await call(`${url}/merge-base/${hash}..${head}`, { prefix });
      if (!sha(common?.hash)) throw incomplete("merge ancestry");
      return common.hash === hash;
    },
    repoInfo: async (_dir, repo) => { const r = await inspect(repo); return { nameWithOwner: r.path, defaultBranch: r.defaultBranch, repository: r }; },
    repoDefaultBranch: async repo => (await inspect(repo)).defaultBranch,
    repoPermissions: async repo => preflight(repo),
    branchExists: async (repo, name) => { await inspect(repo); try { await branch(repo, name); return true; } catch (e) { if (e.status === 404) return false; throw e; } },
    refSha: async (repo, name) => { await inspect(repo); return branch(repo, name); },
    prView: snapshot, prDiff: async (repo, n) => (await snapshot(repo, n)).diff,
    prListByHead: listPr,
    prListMine: async repo => { const login = await user(repo); return (await listPr(repo, null, { skipForks: true })).filter(pr => pr.actor.login === login); },
    reviews: async (repo, n) => (await snapshot(repo, n)).feedback.reviews,
    async setRecoveryMetadata(repo, n, identity, { taskId = null } = {}) {
      const pr = await snapshot(repo, n);
      if (pr.isCrossRepository || identity.branch !== pr.headRefName) throw fault("BB_IDENTITY", "recovery branch differs from PR head");
      const validated = parseBlock(renderBlock(identity));
      if (!validated.block) throw fault("BB_IDENTITY", "invalid recovery identity");
      const body = normalizePublicBody(pr.body, { identity: validated.block, taskId }).trimEnd();
      await publishResultPr({ repo, branch: pr.headRefName, base: pr.baseRefName, title: pr.title, body, expectedNumber: n });
      const observed = await snapshot(repo, n);
      if (observed.headRefName !== pr.headRefName || observed.baseRefName !== pr.baseRefName || observed.headRefOid !== pr.headRefOid || observed.body !== body) throw fault("BB_STALE", "PR changed during recovery metadata publication; reconcile before continuing");
      return observed;
    },
    async markReady(repo, n) {
      const identity = await inspect(repo), pr = await readPr(repo, n, identity), { url, prefix } = scope(repo, identity);
      if (pr.isCrossRepository || pr.state !== "OPEN") throw fault("BB_PR_CONFLICT", "cannot mark this PR ready");
      if (!pr.isDraft) return pr;
      await call(`${url}/pullrequests/${n}`, { method: "PUT", body: { draft: false }, prefix });
      const observed = await snapshot(repo, n);
      if (observed.isDraft) throw fault("BB_WRITE_UNKNOWN", "regular PR conversion not observed");
      return observed;
    },
    inlineComments: async (repo, n) => (await snapshot(repo, n)).comments.filter(c => c.path),
    issueComments: async (repo, n) => (await snapshot(repo, n)).comments.filter(c => !c.path),
    async comment(repo, n, body, { replyTo = null } = {}) {
      if (typeof body !== "string") throw incomplete("public comment text");
      assertPublicText(body, "PR comment");
      const identity = await inspect(repo), pr = await readPr(repo, n, identity), { url, prefix } = scope(repo, identity);
      if (pr.isCrossRepository || pr.state !== "OPEN") throw fault("BB_PR_CONFLICT", "comment writes require an open same-repository PR");
      if (replyTo !== null) {
        if (!Number.isSafeInteger(replyTo) || replyTo < 1) throw incomplete("reply parent");
        const parent = await call(`${scope(repo).url}/pullrequests/${n}/comments/${replyTo}`, { prefix: scope(repo).prefix });
        if (parent.id !== replyTo || parent.deleted) throw incomplete("reply parent");
      }
      // Never retry a comment automatically: a timeout may already have published it.
      return normalizeComment(await call(`${url}/pullrequests/${n}/comments`, { method: "POST", body: { content: { raw: body }, ...(replyTo ? { parent: { id: replyTo } } : {}) }, prefix }), pr.url);
    },
    async setBody(repo, n, body) { assertPublicText(body, "PR body"); const pr = await snapshot(repo, n); if (pr.isCrossRepository) throw fault("BB_PR_CONFLICT", "fork PR writes are unsupported"); return publishResultPr({ repo, branch: pr.headRefName, base: pr.baseRefName, title: pr.title, body, expectedNumber: n }); },
    async setTitle(repo, n, title) { assertPublicText(title, "PR title"); const pr = await snapshot(repo, n); if (pr.isCrossRepository) throw fault("BB_PR_CONFLICT", "fork PR writes are unsupported"); return publishResultPr({ repo, branch: pr.headRefName, base: pr.baseRefName, title, body: pr.body, expectedNumber: n }); },
  };
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const taskPr = `${quote(process.execPath)} ${quote(fileURLToPath(new URL("../../bin/task-pr.mjs", import.meta.url)))}`;
export const bitbucket = Object.freeze({ ...bitbucketDefinition, prompts: bitbucketPrompts(taskPr), credential: resolveBitbucketCredential, create: makeBitbucket });
