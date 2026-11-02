import assert from "node:assert/strict";
import { makeHostRegistry } from "../lib/hosts.mjs";

export const REPO = "bitbucket.org/acme/widget", PATH = "acme/widget";
export const UUID = "{11111111-1111-1111-1111-111111111111}", WORKSPACE = "{22222222-2222-2222-2222-222222222222}";
export const HEAD = "a".repeat(40), BASE = "b".repeat(40), NOW = "2026-10-31T12:00:00.000Z";
export const USER = { uuid: "{33333333-3333-3333-3333-333333333333}", type: "user", display_name: "Fixture Operator" };
export const HOST_KEY = "ssh.bitbucket.org ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO\n";
export const repository = () => ({ uuid: UUID, workspace: { uuid: WORKSPACE, slug: "Acme" }, slug: "Widget", full_name: "Acme/Widget", scm: "git", is_private: true, mainbranch: { name: "main" },
  links: { clone: [{ name: "https", href: "https://bitbucket.org/Acme/Widget.git" }, { name: "ssh", href: "git@bitbucket.org:Acme/Widget.git" }] } });
export const pr = (extra = {}) => ({ id: 7, title: "Add transport", description: "Approved change", state: "OPEN", draft: false, author: USER, created_on: NOW, updated_on: NOW,
  source: { branch: { name: "work/feature" }, commit: { hash: HEAD }, repository: { uuid: UUID, full_name: "acme/widget" } },
  destination: { branch: { name: "main" }, commit: { hash: BASE }, repository: { uuid: UUID, full_name: "acme/widget" } },
  reviewers: [USER], participants: [{ user: USER, role: "REVIEWER", approved: false, state: "changes_requested", participated_on: NOW }], links: { html: { href: "https://bitbucket.org/acme/widget/pull-requests/7" } }, ...extra });
export const prSummary = row => { const summary = { ...row }; delete summary.reviewers; delete summary.participants; return summary; };
export const comment = (id = 1) => ({ id, user: USER, content: { raw: "Check the implementation" }, deleted: false, created_on: NOW, updated_on: NOW });
export const task = () => ({ id: 9, creator: USER, content: { raw: "Address comment" }, state: "UNRESOLVED", created_on: NOW, updated_on: NOW, comment: { id: 1 } });
export const status = () => ({ key: "build", name: "Tests", state: "SUCCESSFUL", links: { commit: { href: `https://api.bitbucket.org/2.0/repositories/acme/widget/commit/${HEAD}` } }, url: "https://bitbucket.org/acme/widget/pipelines/results/1", created_on: NOW, updated_on: NOW });
export const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
export const page = values => ({ values, size: values.length, pagelen: 50 });

export function fixture({ config = {}, limits = {}, intercept = null, credential = null } = {}) {
  const data = { repository: repository(), user: { ...USER }, prs: [], comments: [comment()], tasks: [task()], statuses: [status()], restrictions: [], permission: "write", branch: "main", token: "fixture-api-secret", email: "operator@example.test" };
  const calls = [];
  const fetch = async (url, options) => {
    assert.equal(new URL(url).origin, "https://api.bitbucket.org");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${data.email}:${data.token}`).toString("base64")}`);
    const u = new URL(url), path = u.pathname.replace(`/2.0/repositories/${encodeURIComponent(WORKSPACE)}/${encodeURIComponent(UUID)}`, "").replace("/2.0/repositories/acme/widget", "");
    const call = { url, path, method: options.method, body: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    const intercepted = await intercept?.(call, data, options);
    if (intercepted !== undefined) return intercepted;
    if (path === "") return json(data.repository);
    if (path.startsWith("/refs/branches/")) {
      const name = decodeURIComponent(path.slice("/refs/branches/".length));
      return [data.branch, "work/feature", "release/v2"].includes(name) ? json({ name, target: { hash: name === "work/feature" ? HEAD : BASE } }) : json({}, 404);
    }
    if (u.pathname === "/2.0/user/workspaces/acme/permissions/repositories") return json(page([{ user: data.user, repository: data.repository, permission: data.permission }]));
    if (u.pathname === "/2.0/workspaces/acme/permissions/repositories") return json({}, 403);
    if (path === "/branch-restrictions") return json(page(data.restrictions));
    if (path === "/pullrequests" && options.method === "GET") return json(page(data.prs.filter(p => u.searchParams.getAll("state").includes(p.state)).map(prSummary)));
    if (path === "/pullrequests" && options.method === "POST") { const row = pr({ title: call.body.title.trim(), description: call.body.description.trimEnd() }); row.destination.branch.name = call.body.destination.branch.name; data.prs.push(row); return json(row, 201); }
    if (path === "/pullrequests/7" && options.method === "PUT") { Object.assign(data.prs[0], call.body, { ...(call.body.title ? { title: call.body.title.trim() } : {}), ...(call.body.description !== undefined ? { description: call.body.description.trimEnd() } : {}) }); return json(data.prs[0]); }
    if (/^\/pullrequests\/\d+$/.test(path)) {
      const id = Number(path.split("/").at(-1)), row = data.prs.find(p => p.id === id) ?? (id === 7 ? pr() : null);
      return row ? json(row) : json({}, 404);
    }
    if (path === "/pullrequests/7/comments" && options.method === "POST") { const row = { ...comment(100 + data.comments.length), content: call.body.content, ...(call.body.parent ? { parent: call.body.parent } : {}) }; data.comments.push(row); return json(row); }
    if (path === "/pullrequests/7/comments") return json(page(data.comments));
    if (/^\/pullrequests\/7\/comments\/\d+$/.test(path)) return json(data.comments.find(c => c.id === Number(path.split("/").at(-1))) ?? {}, 200);
    if (path === `/commit/${HEAD}` || path === `/commit/${BASE}`) return json({ hash: path.split("/").at(-1), date: NOW });
    if (path.startsWith("/merge-base/")) return json({ hash: BASE });
    if (path.startsWith("/src/")) return u.searchParams.get("format") === "meta"
      ? json({ type: "commit_file", path: decodeURIComponent(path.split("/").slice(3).join("/")), commit: { hash: path.split("/")[2] }, size: 13 }) : new Response("fixture file\n");
    if (path === "/pullrequests/7/tasks") return json(page(data.tasks));
    if (path === `/commit/${HEAD}/statuses`) return json(page(data.statuses));
    if (path === "/pullrequests/7/diff") return new Response("diff --git a/a b/a\n+change\n");
    throw new Error(`Unexpected fixture request: ${options.method} ${path}`);
  };
  const registry = makeHostRegistry({ config, limits, fetch, credential: credential ?? (async ({ host, path, operation }) => ({ host, repository: path, token: operation === "git" ? "fixture-git-secret" : data.token, email: data.email, username: "x-bitbucket-api-token-auth" })) });
  return { data, calls, registry, api: registry.inspect(REPO).api, fetch };
}
