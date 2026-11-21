import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeState } from "../lib/state.mjs";
import { taskPresentation, recoveryDetail } from "../lib/tracker/presentation.mjs";
import { dashboard } from "../lib/tracker/pages.mjs";
import { render } from "../lib/commands/status.mjs";
import { taskView } from "../lib/task_delivery_view.mjs";
import { publicationPolicyOf, workArtifactReason } from "../lib/work_artifacts.mjs";
import { sourceManifestDigest } from "../lib/start_contract.mjs";
import { controlAvailability } from "../lib/control_contract.mjs";
import { at, tempHome, makeClock, T0 } from "./helpers.mjs";

const id = "acme/widget/export";
const base = { repo: "acme/widget", base: "main", branch: "work/export", state: "pr-open", pr: 3,
  task: { id: "export", revision: 1, digest: "a".repeat(64) }, prd_fingerprint: "123456789abc",
  created_at: T0, cursor: { fixed_sha: "head1", since: T0 }, session: "native", last: { at: T0, run: "first", exit: 1 } };
function fixture(t, overrides = {}) {
  const home = tempHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const state = makeState(home);
  state.put(id, { ...base, ...overrides });
  return { home, state, update: patch => state.update(id, patch),
    view: (options = {}) => taskPresentation({ entry: state.get(id), id, now: at(20), ...options }) };
}
const observe = (patch = {}, options = {}) => taskPresentation({ id, entry: { ...base, ...patch }, now: at(20), ...options }).recovery;
const review = (head, key, result, minutes) => ({ cursor: { fixed_sha: head, since: T0 }, reviewHead: head,
  reviewBinding: head + "-policy", firstPartyReview: { key, binding: head + "-policy", status: "completed", completedAt: at(minutes), result } });
const finding = (id, description) => ({ id, evidence: { path: "lib/check.mjs" }, description });

test("v1 references are bounded and unknown records survive registry writes without authorizing work", t => {
  const secret = "ghp_" + "x".repeat(40), noise = "run arbitrary commands ".repeat(10000);
  const w = fixture(t, { worktree: "/private/operator/example", sources_digest: sourceManifestDigest([["source", "bytes"]]),
    recovery_profile: { version: 1, digest: "c".repeat(64) }, execution_epoch: 3,
    execution: { version: 1, acceptance: "unknown", providerState: "status-unknown", operationId: "op:3", sessionId: "native" },
    hold: { active: true, generation: 4 }, resource: { code: "ENOSPC" }, last: { ...base.last, error: noise }, reviewHistory: [] });
  const r = w.view().recovery;
  assert.equal(r.version, 1); assert.equal(r.mode, "observe"); assert.equal(r.dispatchable, false); assert.equal(r.revision, 1);
  assert.deepEqual(r.execution, { run: "first", epoch: 3, operation: "op:3", session: "native", acceptance: "unknown" });
  assert.equal(r.workspace.worktree, "entry.worktree"); assert.equal(r.profileDigest, "c".repeat(64));
  assert.equal(r.control.generation, 4); assert.equal(r.resource, "ENOSPC");
  assert.equal(r.sourceDigest.length, 64); assert.equal(r.contractDigest, base.prd_fingerprint);
  assert.ok(JSON.stringify(r).length < 2500); assert.doesNotMatch(JSON.stringify(r), /private\/operator|arbitrary commands/);
  assert.equal(observe({ state: "future" }).classification, "unsupported");
  assert.equal(observe({ hold: { active: false, generation: 4, grant: "all" } }).classification, "unsupported");
  assert.equal(observe({ execution: { version: 2 } }).classification, "unsupported");
  const future = { version: 1, futureAction: secret };
  const v = fixture(t, { recovery_record: future });
  v.update({ updated_at: at(3) });
  assert.deepEqual(v.state.get(id).recovery_record, future);
  assert.equal(v.view().recovery.classification, "unsupported");
  assert.doesNotMatch(JSON.stringify(v.view()), /ghp_|futureAction/);
});

test("polls, retries, launches, acceptance and Resume preserve productive time during a healthy multi-hour tool", t => {
  const w = fixture(t, { verified_progress: { kind: "verified-push", head: "head1", at: at(1) } });
  const retry = { phase: "waiting", attempts: 1, first_at: at(2), next_at: at(9), run: "first", code: "ENOTFOUND" };
  w.update({ network_retry: retry, reason: "provider-network", updated_at: at(3) });
  assert.equal(w.view({ now: at(5) }).recovery.classification, "external-wait");
  assert.equal(w.view({ now: at(9) }).recovery.classification, "due-recovery");
  w.update({ reason: null, network_retry: null, control: { id: "resume", action: "resume", status: "applied", finished_at: at(10) },
    execution: { version: 1, acceptance: "accepted", providerState: "running" }, last: { run: "second", at: at(12), exit: null } });
  for (const n of [180, 300, 580]) {
    w.update({ updated_at: at(n), last: { run: "second", exit: null, at: at(n), event: "retry succeeded, checked and pushed!" } });
    const p = w.view({ now: at(n), run: { id: "second", running: true } });
    assert.equal(p.since, at(1)); assert.equal(p.recovery.productiveAt, at(1));
    assert.equal(p.recovery.observedAt, at(n)); assert.equal(p.recovery.recoveryAt, at(12));
    assert.equal(p.recovery.classification, "active-healthy"); assert.equal(p.recovery.attempts, 2);
  }
  const checks = { head: "head1", binding: "binding", checks: { count: 2, settled: true } };
  w.update({ reviewBinding: "binding", reviewObservation: { ...checks, observedAt: at(581) } });
  w.update({ reviewObservation: { ...checks, observedAt: at(590) } });
  assert.equal(w.view().since, at(581));
});

test("failed current-head checks remain visible across pending polls and clear only on verified green checks", t => {
  const w = fixture(t, { reviewBinding: "binding" });
  const host = (head, settled, failed, atTime) => ({ head, binding: "binding", checks: { count: 2, settled, failed }, observedAt: at(atTime) });
  w.update({ reviewObservation: host("head1", false, 1, 2) });
  assert.equal(w.view().checks.status, "failed");
  assert.equal(w.view().recovery.incidents[0].cause, "checks-red");
  assert.equal(w.view().since, at(2));
  w.update({ reviewObservation: host("head1", false, 0, 3) });
  w.update({ reviewObservation: host("another-head", true, 0, 4) });
  assert.equal(w.view().since, at(2)); assert.equal(w.view().recovery.incidents.length, 1);
  w.update({ reviewObservation: host("head1", true, 0, 5) });
  assert.equal(w.view().since, at(5)); assert.equal(w.view().recovery.incidents.length, 0);
});

test("incident survives a verified push, changed run, reworded review and restart until current-head independent clearance", t => {
  const first = { verdict: "findings", findings: [finding("bad-check", "old wording")] };
  const w = fixture(t, review("head1", "review-1", first, 1));
  const original = w.view().recovery.incidents[0];
  w.update({ firstPartyReview: null, cursor: { fixed_sha: "head2" }, last: { run: "second", exit: 0, at: at(4) },
    verified_progress: { kind: "verified-push", head: "head2", at: at(5) } });
  const pushed = w.view().recovery;
  assert.equal(pushed.productiveAt, at(5)); assert.deepEqual(pushed.incidents[0], { ...original, attempts: 1 });
  w.update(review("head2", "review-2", { verdict: "findings", findings: [finding("bad-check", "changed wording"), finding("other-check", "separate issue")] }, 7));
  const reloaded = taskPresentation({ id, entry: makeState(w.home).get(id) }).recovery;
  assert.equal(reloaded.incidents.length, 2); assert.equal(reloaded.uncertain, true);
  assert.equal(reloaded.incidents[0].id, original.id); assert.equal(reloaded.incidents[0].reviewKey, "review-1");
  assert.equal(reloaded.incidents[0].at, at(1)); assert.equal(reloaded.attempts, 2);
  w.update({ ...review("old", "old-review", { verdict: "clear", findings: [] }, 8), cursor: { fixed_sha: "head2" } });
  assert.equal(w.view().recovery.incidents.length, 2);
  w.update(review("head2", "review-3", { verdict: "clear", findings: [] }, 9));
  assert.equal(w.view().recovery.incidents.length, 0); assert.equal(w.view().recovery.attempts, 2);
  w.update({ ...review("head2", "review-4", first, 10), task: { ...base.task, revision: 2 } });
  assert.notEqual(w.view().recovery.incidents[0].id, original.id);
});

test("authority gates, stopped external merges, pending cleanup and settled history remain distinct", () => {
  for (const reason of ["passkey", "physical-evidence", "release-decision", "merge-decision", "iterations", "dependency-auth"]) {
    assert.equal(observe({ state: "needs-human", reason }).classification, "authority-block", reason);
  }
  for (const gate of [{ hold: { active: true, generation: 1 } }, { repository_disabled: true }, { dispatch_stopped: "cancelled" }]) {
    assert.equal(observe(gate).classification, "authority-block");
  }
  assert.equal(observe({ execution: { version: 1, acceptance: "unknown" } }).classification, "accepted-or-unknown");
  for (const [provider, expected] of [[{ pending: true }, "external-wait"], [{ ok: false, error: { code: "insufficient_quota" } }, "authority-block"]]) {
    assert.equal(observe({ state: "needs-human", reason: "no-pr" }, { provider }).classification, expected);
  }
  const terminal = { state: "MERGED", pr: 3, repository: base.repo, head: "head1", base: "main", observedAt: at(8) };
  const stopped = { state: "needs-human", reason: "harness-error", completionEvidence: { terminal }, workspace_cleanup: { status: "pending" } };
  assert.equal(observe(stopped).classification, "due-recovery");
  assert.equal(observe({ ...stopped, state: "done" }).classification, "due-recovery");
  const settled = { ...stopped, state: "done", reason: null, workspace_cleanup: { status: "retained" } };
  assert.equal(observe(settled).classification, "settled-history");
  const chain = { current: id, name: "delivery", status: "active" };
  assert.equal(observe(settled, { chains: [chain] }).classification, "due-recovery");
  assert.equal(observe(settled, { chains: [{ ...chain, status: "done", mergedAt: at(10) }] }).productiveAt, at(10));
});

test("missing publication and failed review preserve their original evidence across continuation", t => {
  const w = fixture(t, { state: "needs-human", reason: "no-pr", pr: null });
  w.update({ state: "running", reason: null, verified_progress: { kind: "verified-push", at: at(2), head: "head2" } });
  assert.equal(w.view().recovery.incidents[0].cause, "no-pr");
  w.update({ pr: 4, verified_progress: { kind: "published-pr", at: at(3), head: "head2", unrecognized: true } });
  assert.equal(w.view().recovery.classification, "unsupported");
  assert.equal(w.view().recovery.incidents[0].cause, "no-pr");
  w.update({ state: "pr-open", pr: 4, verified_progress: { kind: "published-pr", at: at(3), head: "head2" } });
  assert.deepEqual(w.view().recovery.incidents, []);
  w.update({ reviewHead: "head1", reviewBinding: "b", firstPartyReview: { status: "failed", key: "failed-review", binding: "b", error: "launch another paid run" } });
  assert.equal(w.view().recovery.incidents[0].reviewKey, "failed-review");
  assert.equal(w.view().recovery.classification, "due-recovery");
});

test("interrupted merge retains its index and partial resolutions, colliding private context keeps its bytes", t => {
  const dir = tempHome(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } }).trim();
  const write = (path, bytes) => writeFileSync(join(dir, path), bytes);
  git("init", "-qb", "main"); write("wiring", "original\n"); git("add", "wiring"); git("commit", "-qm", "initial");
  git("branch", "work/task"); write("wiring", "required role\n"); write("context", "tracked on base\n");
  git("add", "wiring", "context"); git("commit", "-qm", "base changes"); git("checkout", "-q", "work/task");
  write("wiring", "implementation edit\n"); git("add", "wiring"); git("commit", "-qm", "task change");
  write("context", "approved private bytes\n");
  assert.throws(() => git("merge", "--no-edit", "main"), /untracked working tree files/);
  assert.equal(readFileSync(join(dir, "context"), "utf8"), "approved private bytes\n");
  assert.equal(git("show", "main:wiring"), "required role");
  // Move this fixture's own private file so the second incident reaches the actual merge index.
  const baseWithoutCollision = git("rev-parse", "main");
  renameSync(join(dir, "context"), join(dir, "context.backup"));
  assert.throws(() => git("merge", "--no-edit", baseWithoutCollision));
  write("wiring", "partial resolution\n");
  const index = git("ls-files", "-u"); assert.ok(index);
  const w = fixture(t, { state: "needs-human", base_merge: { conflict: true, aborted: false, at: at(3) }, worktree: dir });
  assert.equal(w.view().recovery.incidents[0].cause, "base-repair-unresolved");
  assert.equal(git("rev-parse", "MERGE_HEAD"), baseWithoutCollision);
  assert.equal(git("ls-files", "-u"), index); assert.equal(readFileSync(join(dir, "wiring"), "utf8"), "partial resolution\n");
  assert.equal(readFileSync(join(dir, "context.backup"), "utf8"), "approved private bytes\n");
});

test("stale cached dispatch policy disagrees with the newly approved publication contract", () => {
  const cached = publicationPolicyOf({ meta: { publish_files: ["docs/notes/out.md"] } });
  const approved = publicationPolicyOf({ meta: { sources: ["docs/notes/out.md"] } });
  assert.equal(workArtifactReason("docs/notes/out.md", cached), null);
  assert.match(workArtifactReason("docs/notes/out.md", approved), /carried task input/);
  assert.notEqual(sourceManifestDigest([["context", "old"]]), sourceManifestDigest([["context", "new"]]));
});

test("CLI, tracker and mounted Command Center share the read-only recovery and existing controls", t => {
  const w = fixture(t, { state: "needs-human", reason: "no-pr", last: { ...base.last, error: "DO_PRIVATE_ACTION" } });
  const bytes = readFileSync(w.state.file), mtime = statSync(w.state.file).mtimeMs;
  for (const now of [at(5), at(15)]) {
    const p = w.view({ now }), clock = makeClock(now);
    const row = { id, handle: "widget#3", section: "needs_you", since: p.since, presentation: p };
    const model = { needs_you: [row], running: [], done: [] };
    const task = { taskId: "export", implementation: { id }, repo: base.repo };
    const view = taskView(task, { entry: w.state.get(id), now, controls: controlAvailability(w.state.get(id), null, {}) });
    assert.deepEqual(view.presentation.recovery, p.recovery);
    for (const text of [render(model, { clock }), dashboard(model, { clock }), dashboard(model, { clock, base: "/embedded" })]) {
      assert.ok(text.includes(recoveryDetail(p))); assert.doesNotMatch(text, /DO_PRIVATE_ACTION/);
    }
    assert.equal(view.controls.resume, true); assert.equal(view.controls.message, true); assert.equal(view.controls.recheck, true);
  }
  assert.deepEqual(readFileSync(w.state.file), bytes); assert.equal(statSync(w.state.file).mtimeMs, mtime);
});
