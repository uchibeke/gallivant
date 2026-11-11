import { test } from "node:test";
import assert from "node:assert/strict";
import { taskPresentation } from "../lib/tracker/presentation.mjs";
import { overviewWindow, overviewSnapshot } from "../lib/tracker/overview.mjs";
import { externalLink, externalLinkAttributes } from "../lib/tracker/links.mjs";
import { completionView } from "../lib/task_completion.mjs";

const entry = (state, at) => ({ repo: "acme/widget", base: "main", pr: 12, state, harness: "codex", iteration: 2, activity_at: at,
  cursor: { fixed_sha: "head" }, task: { completion: { version: 1, target: "delivery_ready" } } });
const row = (id, saved) => ({ id, handle: id, state: saved.state, harness: saved.harness,
  presentation: taskPresentation({ entry: saved, maxIterations: 60 }) });
const model = (...rows) => ({ needs_you: rows.filter(r => r.state === "needs-human"), running: rows.filter(r => !["needs-human", "done"].includes(r.state)), done: rows.filter(r => r.state === "done") });

test("legacy completed tasks have a completed lifecycle without fabricating completion or review assurance", () => {
  const saved = { ...entry("done", "2026-11-10T10:00:00Z"), reason: "old-stop", control: { status: "failed", action: "resume" } };
  const original = JSON.stringify(saved), p = taskPresentation({ entry: saved });
  assert.equal(p.phase.id, "completed"); assert.equal(p.attention.group, "ended");
  assert.equal(p.readiness.status, completionView(null, saved).status); assert.equal(p.readiness.status, "unverified");
  assert.equal(p.acceptance.status, "unknown"); assert.equal(p.review.verdict, "unknown"); assert.equal(p.readiness.mergeAuthorized, false);
  assert.equal(JSON.stringify(saved), original);
  const pending = taskPresentation({ entry: { ...saved, last: { run: "owned", exit: null } }, run: { id: "owned", running: true } });
  assert.notEqual(pending.attention.group, "ended"); assert.equal(pending.controls.resume, false);
});

test("recency spans lifecycle groups, ignores poll freshness, places missing dates last and breaks ties deterministically", () => {
  const old = row("old-blocker", { ...entry("needs-human", "2026-09-10T10:00:00Z"), updated_at: "2026-11-11T14:00:00Z" });
  const recent = row("recent-completion", entry("done", "2026-11-11T10:00:00Z"));
  const first = row("a-same-time", entry("pr-open", "2026-11-10T10:00:00Z"));
  const second = row("b-same-time", entry("pr-open", "2026-11-10T10:00:00Z"));
  const unknown = row("missing-time", entry("pr-open", null));
  const input = model(second, unknown, old, recent, first), before = JSON.stringify(input);
  assert.deepEqual(overviewWindow(input).rows.map(r => r.id), [recent.id, first.id, second.id, old.id, unknown.id]);
  assert.equal(overviewWindow(input, { sort: "attention" }).rows[0].id, old.id);
  assert.equal(JSON.stringify(input), before);
});

test("status counts follow other filters and exactly one selected tab remains represented in server snapshots", () => {
  const a = row("done-a", entry("done", "2026-11-11T10:00:00Z")), b = row("done-b", { ...entry("done", "2026-11-10T10:00:00Z"), repo: "other/project" });
  const unknown = row("unknown", entry("pr-open", "2026-11-09T10:00:00Z")), input = model(a, b, unknown);
  const selected = overviewWindow(input, { attention: "ended", repo: "acme/widget" });
  assert.equal(selected.scopedTotal, 2); assert.equal(selected.counts.ended, 1); assert.equal(selected.counts.unknown, 1);
  assert.deepEqual(selected.rows.map(r => r.id), [a.id]);
  for (const attention of ["", "ended", "unknown"]) {
    const html = overviewSnapshot(input, { query: { attention }, base: "/gallivant" }).content;
    assert.equal((html.match(/<a data-key="total:[^>]*aria-current="page"/g) || []).length, 1);
    assert.match(html, new RegExp(`data-kind="${attention || "all"}" aria-current="page"`));
  }
  const emptyPage = overviewSnapshot(input, { query: { offset: "25" } }).content;
  assert.match(emptyPage, /No tasks on this page/); assert.doesNotMatch(emptyPage, /undefined matching/);
});

test("one outgoing-link policy supports server HTML and browser decoration without weakening URL filtering", () => {
  const url = "https://github.com/acme/widget/pull/12", policy = externalLinkAttributes(url, "http://localhost:8790");
  assert.equal(policy.target, "_blank"); assert.equal(policy.rel, "noopener noreferrer");
  assert.equal(externalLinkAttributes("http://localhost:8790/gallivant", "http://localhost:8790"), null);
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "https://user:secret@example.com", "https://example.com/%ZZ"]) assert.equal(externalLinkAttributes(value), null);
  const html = externalLink(url, '<img src=x onerror="alert(1)">');
  assert.match(html, /target="_blank"/); assert.match(html, /aria-describedby="external-link-help"/);
  assert.doesNotMatch(html, /<img/); assert.match(html, /&lt;img/);
});
