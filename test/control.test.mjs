import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { requestControl, applyControl, cancelControl, recoverControl, interruptControl, lastMessage, controlFailure, controlPending } from "../lib/control.mjs";
import { makeState } from "../lib/state.mjs";
import { makeTick } from "../lib/tick.mjs";
import { NEEDS_LABEL } from "../lib/gh.mjs";
import { CONFIG, seededState, makeClock, fakeGh, fakeGit, fakeNotify, fakeRunner, fakeCredential, fakeIdentity, harnessBin, GOOD_PRD, silentLog, STATES, review, at, checkRun, prFixture } from "./helpers.mjs";

function world(over = {}) {
  const { home, state, id } = seededState({ state: STATES.needsHuman, reason: "checks-red", iteration: 2, ...over });
  const worktree = join(home, "worktree"); mkdirSync(worktree);
  state.update(id, { worktree });
  const clock = makeClock();
  const runner = fakeRunner(clock);
  const gh = fakeGh();
  const ctx = { home, state, clock, runnerFor: () => runner, gh, git: fakeGit(), notify: fakeNotify(), log: silentLog,
    config: { ...CONFIG, home, harness: { ...CONFIG.harness, claude: { ...CONFIG.harness.claude, bin: harnessBin(home, "claude") } } },
    credential: fakeCredential(), identity: fakeIdentity(), readPrd: () => GOOD_PRD, ownLogin: "me" };
  return { ctx, state, id, home, runner, gh, tick: makeTick(ctx) };
}

test("queued unknown recovery settles one bounded observation without turning into continuation", async () => {
  for (const result of ["accepted", "accepted-unresolved", "unknown", "denied"]) {
    const w=world(),job={id:"owned-run",running:true,execution:{providerState:"status-unknown",acceptance:"unknown"}},calls=[];
    const runner={capabilities:{transport:"remote"},current:()=>job,recover:async args=>{calls.push(args);if(result==="denied")throw Object.assign(new Error("private refusal"),{code:"AGENTS_AUTH"});job.execution.acceptance=result==="accepted-unresolved"?"accepted":result;if(result==="accepted")job.execution.providerState="running";return job;}};
    w.ctx.executionFor=()=>runner;w.state.update(w.id,{last:{run:job.id},control:{id:"same-request",action:"resume",status:"queued",note:"",interrupt:false}});
    assert.equal(await recoverControl(w.ctx,w.id),true);
    const control=w.state.get(w.id).control;
    assert.equal(control.id,"same-request");assert.equal(control.recoveryRun,job.id);
    assert.equal(control.status,result==="accepted"?"applied":"failed");assert.equal(calls.length,1);
    assert.deepEqual(calls[0],{authorized:true,operationId:"control-recovery:same-request"});
    assert.equal(await recoverControl(w.ctx,w.id),false);assert.equal(calls.length,1);
    assert.equal(JSON.stringify(control).includes("private refusal"),false);
  }
});

test("recovery controls never override a stop, another run or a non-resume action", async () => {
  for(const mode of ["stopped","foreign","message","known-running"]){
    const w=world(),job={id:"owned",running:true,execution:{providerState:mode==="known-running"?"running":"status-unknown"}};
    w.ctx.executionFor=()=>({capabilities:{transport:"remote"},current:()=>job,recover:()=>assert.fail("unauthorized recovery")});
    w.state.update(w.id,{last:{run:mode==="foreign"?"other":"owned"},dispatch_stopped:mode==="stopped"?"cancelled":null,control:{id:"r",action:mode==="message"?"message":"resume",status:"queued"}});
    const before=w.state.get(w.id);assert.equal(await recoverControl(w.ctx,w.id),false);assert.deepEqual(w.state.get(w.id),before);
  }
});

test("recovery preflight failures settle the retained request without dispatching another run", async () => {
  for (const mode of ["advanced", "registry-moved", "missing", "constructor", "current"]) {
    const w = world(), request = { id: "old-request", action: "resume", status: "queued", recoveryRun: "old-run" };
    const job = { id: mode === "advanced" ? "new-run" : "old-run", running: true, execution: { version: 1, provider: "openai-agents", transport: "remote", providerState: "status-unknown" } };
    w.state.update(w.id, { last: { run: mode === "registry-moved" ? "new-run" : job.id }, control: request });
    const fail = () => { throw new Error("Bearer private-recovery-failure"); };
    w.ctx.executionFor = mode === "constructor" ? fail : () => ({
      capabilities: { transport: "remote" },
      current: mode === "current" ? fail : () => mode === "missing" ? null : job,
      recover: () => assert.fail("preflight failure must not observe or submit provider work"),
    });
    await makeTick(w.ctx).tick();
    const saved = makeState(w.home).get(w.id).control;
    assert.equal(saved.id, request.id, mode); assert.equal(saved.recoveryRun, request.recoveryRun, mode);
    assert.equal(saved.status, "failed", mode); assert.ok(saved.finished_at, mode);
    assert.equal(controlPending(saved), false, mode);
    assert.doesNotMatch(JSON.stringify(saved), /private-recovery-failure/);
    assert.equal(await recoverControl(w.ctx, w.id), false, "the failed request is not replayed");
    assert.equal(w.runner.started.length, 0, mode);
  }
});

test("recovery preflight failure cannot overwrite a newer control", async () => {
  const w = world(), replacement = { id: "new-request", action: "cancel", status: "queued" };
  w.state.update(w.id, { control: { id: "old-request", action: "resume", status: "queued", recoveryRun: "old-run" } });
  w.ctx.executionFor = () => { w.state.update(w.id, { control: replacement }); throw new Error("private error"); };
  assert.equal(await recoverControl(w.ctx, w.id), true);
  assert.deepEqual(w.state.get(w.id).control, replacement);
});

test("recovery preflight cannot adopt a replaced request or a changed run", async () => {
  for (const change of ["control", "run", "stop"]) {
    const w = world(), replacement = { id: "new-request", action: "cancel", status: "queued" };
    w.state.update(w.id, { last: { run: "owned" }, control: { id: "old-request", action: "resume", status: "queued", recoveryRun: "owned" } });
    w.ctx.executionFor = () => ({ capabilities: { transport: "remote" }, current: () => {
      w.state.update(w.id, change === "control" ? { control: replacement } : change === "run" ? { last: { run: "new-run" } } : { dispatch_stopped: "cancelled" });
      return { id: "owned", execution: { providerState: "status-unknown" } };
    }, recover: () => assert.fail("changed ownership must not reach the provider") });
    assert.equal(await recoverControl(w.ctx, w.id), true);
    if (change === "control") assert.deepEqual(w.state.get(w.id).control, replacement);
    else assert.equal(w.state.get(w.id).control.status, "failed");
  }
});

test("legacy control cancellation verifies cessation instead of trusting the kill return", async () => {
  for (const remaining of ["running", "missing", "different", "stopped"]) {
    const w = world(), run = w.runner.start("legacy", "codex", [], {});
    const current = w.runner.current;
    w.runner.kill = id => {
      assert.equal(id, run.id);
      w.runner.current = () => remaining === "missing" ? null : remaining === "different" ? { id: "another", running: false }
        : { ...current(), running: remaining === "running" };
      return true;
    };
    requestControl(w.ctx, { handle: w.id, action: "cancel" });
    assert.equal(await cancelControl(w.ctx, w.id), true);
    assert.equal(w.state.get(w.id).dispatch_stopped, "cancellation-requested");
    assert.equal(w.state.get(w.id).reason, remaining === "stopped" ? "cancelled" : "cancellation-requested");
    assert.equal(w.state.get(w.id).control.message === "Cancellation confirmed.", remaining === "stopped");
  }
});

test("requests survive a new context, refuse duplicates, and never silently truncate", () => {
  const w = world();
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Keep the approved scope." });
  assert.equal(makeState(w.home).get(w.id).control.note, "Keep the approved scope.");
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "recheck" }), /already queued/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "message", note: "x".repeat(4001) }), /4000/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "shell" }), /Unknown/);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "recheck", note: "Do not lose me" }), /Use Send message/);
  assert.equal(w.state.get(w.id).iteration, before.iteration);
  assert.equal(w.runner.started.length, 0);
});

test("messages require text and a session; fixed actions never accept a draft", async () => {
  const w = world();
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "message", note: "   " }), /Write a message/);
  for (const action of ["resume", "recheck"]) {
    assert.throws(() => requestControl(w.ctx, { handle: w.id, action, note: "unsent draft" }), /Use Send message/);
  }
  assert.equal(w.state.get(w.id).control, undefined);
  requestControl(w.ctx, { handle: w.id, action: "resume" });
  await applyControl(w.ctx, w.id);
  assert.equal(w.runner.started.length, 1);
  assert.equal(w.state.get(w.id).control.note, "");
  assert.equal(w.state.get(w.id).control.message, "Resumed the same agent session.");
  w.runner.finish([], { exit: 0 });
  w.state.update(w.id, { session: null });
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "message", note: "Hello" }), /no session/);
});

test("a stopped PR rechecks without spending a run, resetting budgets or changing its contract", async () => {
  const w = world();
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await applyControl(w.ctx, w.id);
  const after = w.state.get(w.id);
  assert.equal(after.control.status, "applied");
  assert.equal(after.state, STATES.prOpen);
  assert.equal(after.reason, null);
  assert.equal(after.iteration, before.iteration);
  assert.deepEqual(after.cursor, before.cursor);
  assert.equal(after.prd_fingerprint, before.prd_fingerprint);
  assert.equal(w.runner.started.length, 0);
  assert.ok(w.gh.calls.some(c => c[0] === "removeLabel" && c[2] === NEEDS_LABEL));
});

test("rechecking unchanged red checks stops again; it does not bypass CI or spend another fixer", async () => {
  const w = world();
  w.ctx.readPrd = () => null;
  w.state.update(w.id, { cursor: { ...w.state.get(w.id).cursor, checks_sha: "a1b2c3d" } });
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "guard", conclusion: "FAILURE" })];
  w.gh.data.reviews = [review({ id: 1, by: "chatgpt-codex-connector[bot]", bot: true, at: at(1), body: "**Reviewed commit:** `a1b2c3d`" })];
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await w.tick.tick(); await w.tick.tick();
  assert.equal(w.state.get(w.id).reason, "checks-red");
  assert.equal(w.runner.started.length, 0);
});

test("the same recheck can reach ready after the external check passes", async () => {
  const w = world();
  w.ctx.readPrd = () => null;
  w.gh.data.pr.statusCheckRollup = [checkRun({ name: "guard", conclusion: "SUCCESS" })];
  w.gh.data.reviews = [review({ id: 1, by: "chatgpt-codex-connector[bot]", bot: true, at: at(1), body: "**Reviewed commit:** `a1b2c3d`" })];
  const tick = makeTick(w.ctx);
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await tick.tick(); await tick.tick();
  assert.equal(w.state.get(w.id).state, STATES.ready);
  assert.equal(w.runner.started.length, 0);
});

test("a message waits for a live run, then uses the existing resume with the same session and worktree", async () => {
  const w = world();
  w.runner.start("old", "claude", [], {});
  const before = w.state.get(w.id);
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Use the revised fixture. ``` keep literal" });
  assert.equal(await applyControl(w.ctx, w.id), false);
  assert.equal(w.state.get(w.id).control.status, "queued");
  assert.equal(w.runner.started.length, 1);
  w.runner.finish([], { exit: 0 });
  await applyControl(w.ctx, w.id);
  const run = w.runner.started[1];
  assert.ok(run.args.includes(before.session));
  assert.equal(run.opts.cwd, before.worktree);
  assert.match(run.args.at(-1), /Use the revised fixture/);
  assert.match(w.state.get(w.id).control.message, /with your message/);
  assert.match(run.args.at(-1), /does not change the approved brief/);
  assert.equal(w.state.get(w.id).control.status, "applied");
  assert.equal(w.state.get(w.id).iteration, before.iteration);
});

test("message delivery preserves dirty work; later fixed actions retain the message", async () => {
  const w = world();
  w.ctx.git.dirty = async () => ({ modified: 2, untracked: 0 });
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Finish the docs." });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "applied");
  assert.equal(w.state.get(w.id).control.note, "Finish the docs.");
  assert.equal(w.runner.started.length, 1);
  assert.doesNotThrow(() => requestControl(w.ctx, { handle: w.id, action: "recheck" }));
  assert.equal(lastMessage(w.state.get(w.id)).note, "Finish the docs.");
});

test("interrupted delivery is not replayed, and closed PRs cannot be resumed", async () => {
  const w = world();
  const request = requestControl(w.ctx, { handle: w.id, action: "message", note: "one update" });
  w.state.update(w.id, { control: { ...request, status: "applying" } });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.match(w.state.get(w.id).control.message, /interrupted/);
  requestControl(w.ctx, { handle: w.id, action: "resume" });
  w.gh.data.pr = prFixture({ state: "MERGED" });
  await applyControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.equal(w.runner.started.length, 0);
});


test("first-run messages queue before the session id is known", () => {
  const w = world({ state: STATES.running, session: null, pr: null });
  const job = w.runner.start("start", "codex", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Preserve the article." });
  assert.equal(w.state.get(w.id).control.status, "queued");
  assert.equal(w.runner.started.length, 1);
});

test("interrupt stops only the owned run then resumes the same session with dirty work", async () => {
  const w = world({ state: STATES.prOpen });
  const job = w.runner.start("fix", "claude", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  w.ctx.git.dirty = async () => ({ modified: 1, untracked: 2 });
  const session = w.state.get(w.id).session;
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Keep the original detail.", interrupt: true });
  await w.tick.tick();
  assert.equal(w.runner.started.length, 2);
  assert.equal(w.state.get(w.id).session, session);
  assert.equal(w.state.get(w.id).control.status, "applied");
  assert.match(w.runner.started[1].args.at(-1), /Keep the original detail/);
  assert.match(w.runner.started[1].args.at(-1), /1 modified and 2 untracked/);
});

test("interrupt waits for a first session and never stops an unrelated run", () => {
  const w = world({ state: STATES.running, session: null, pr: null });
  const job = w.runner.start("start", "codex", [], {});
  w.state.update(w.id, { harness: "codex", last: { run: job.id, exit: null } });
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Correction", interrupt: true });
  interruptControl(w.ctx, w.id);
  assert.equal(w.runner.current().running, true);
  w.runner.current().lines.push(JSON.stringify({ type: "thread.started", thread_id: "01a0f4b3-85e5-7c52-856a-57d14aadaa89" }));
  w.state.update(w.id, { last: { run: "someone-else", exit: null } });
  interruptControl(w.ctx, w.id);
  assert.equal(w.runner.current().running, true);
  assert.throws(() => requestControl(w.ctx, { handle: w.id, action: "resume", interrupt: true }), /only when sending/);
});

test("interrupt discovers a PR opened during the first turn before resuming it", async () => {
  const w = world({ state: STATES.running, pr: null });
  const job = w.runner.start("start", "claude", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  const pr = prFixture({ number: 42 });
  w.gh.prListByHead = async () => [pr];
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Keep the original article.", interrupt: true });
  await w.tick.tick();
  assert.equal(w.state.get(w.id).pr, 42);
  assert.equal(w.state.get(w.id).control.status, "applied");
  assert.match(w.runner.started[1].args.at(-1), /pull request #42/);
  assert.ok(w.gh.calls.some(c => c[0] === "setBody"));
});

test("actionable failures do not echo subprocess credentials", () => {
  assert.match(controlFailure(new Error("carried files differ from the snapshot: private text")), /resnapshot/);
  assert.match(controlFailure(new Error("The PR is no longer open.")), /follow-up PRD/);
  assert.doesNotMatch(controlFailure(new Error("fetch failed https://secret@github.com")), /secret/);
});

test("control failures preserve the selected token-file remedy without exposing error details", async () => {
  const w = world();
  const failure = Object.assign(new Error("private token path: /secret/location"), {
    code: "NO_CREDENTIAL", reason: "configured-token-file-unavailable",
  });
  w.gh.prView = async () => { throw failure; };
  requestControl(w.ctx, { handle: w.id, action: "recheck" });
  await applyControl(w.ctx, w.id);
  const saved = w.state.get(w.id).control;
  assert.equal(saved.status, "failed");
  assert.match(saved.message, /Restore that private token file/);
  assert.match(saved.message, /set github_token_file to null and restart the daemon/);
  assert.doesNotMatch(saved.message, /gh auth login|\/secret\/location/);
  assert.match(controlFailure({ code: "NO_CREDENTIAL" }), /gh auth login/);
});

test("an unverifiable interrupt fails visibly and retains the message without starting a replacement", () => {
  const w = world({ state: STATES.prOpen });
  const job = w.runner.start("fix", "claude", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Keep the detail.", interrupt: true });
  w.runner.kill = () => { throw Object.assign(new Error("unverified group"), { code: "RUN_STOP_UNVERIFIED" }); };
  interruptControl(w.ctx, w.id);
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.equal(w.state.get(w.id).control.note, "Keep the detail.");
  assert.equal(w.state.get(w.id).reason, "run-stop-unverified");
  assert.match(w.state.get(w.id).control.message, /process group/);
  assert.equal(w.runner.started.length, 1);
});

test("the daemon notifies and retries stop labels when an operator interrupt cannot inspect the process", async () => {
  const w = world({ state: STATES.prOpen });
  const job = w.runner.start("fix", "claude", [], {});
  w.state.update(w.id, { last: { run: job.id, exit: null } });
  requestControl(w.ctx, { handle: w.id, action: "message", note: "Preserve the detail.", interrupt: true });
  w.runner.kill = () => { throw Object.assign(new Error("ps unavailable"), { code: "RUN_STOP_UNVERIFIED" }); };
  const addLabel = w.gh.addLabel;
  w.gh.addLabel = async () => { throw new Error("GitHub unavailable"); };
  await w.tick.tick();
  assert.equal(w.state.get(w.id).control.status, "failed");
  assert.equal(w.state.get(w.id).labels_pending, true);
  assert.deepEqual(w.ctx.notify.sent, [["needs", 142, "run-stop-unverified"]]);
  w.gh.addLabel = addLabel;
  await w.tick.tick();
  assert.equal(w.state.get(w.id).labels_pending, false);
  assert.equal(w.ctx.notify.sent.length, 1);
  assert.equal(w.runner.started.length, 1);
});
