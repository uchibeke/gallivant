import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSshSigner, storedOpenSshSigner, encryptedKey, signingEnvironment, NAMESPACE, SIGNER_ID } from "../lib/learning_signer.mjs";
import { canonical, hash } from "../lib/learning_data.mjs";
import { createLearningService, LEARNING_LIMITS } from "../lib/learning.mjs";
import { learnCommand } from "../lib/commands/learn.mjs";
import { fixture, pending, proposed, repo } from "./learning-fixtures.mjs";
import { learningDispatch, learningPaths, revokeLearningAttempts } from "../lib/learning_input.mjs";
import { makeExecution } from "../lib/execution.mjs";
import { executionRegistry } from "../lib/harness.mjs";

let dir, key, otherKey, plainKey, authority, askpass, askpassMarker;
const real = openSshSigner(), passphrase = "disposable-test-passphrase-only";
const signFixture = (bytes, namespace = NAMESPACE, keyPath = key) => {
  const file = join(dir, `data-${hash(bytes + namespace + keyPath)}`);
  writeFileSync(file, bytes, { mode: 0o600 }); rmSync(file + ".sig", { force: true });
  execFileSync("/usr/bin/ssh-keygen", ["-Y", "sign", "-f", keyPath, "-n", namespace, file], { env: { ...signingEnvironment(dir), DISPLAY: "fixture", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  return readFileSync(file + ".sig", "utf8");
};
before(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), "learning-openssh-"));
  key = join(dir, "dedicated"); otherKey = join(dir, "other"); plainKey = join(dir, "plain");
  for (const path of [key, otherKey, plainKey]) execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-a", "100", "-N", path === plainKey ? "" : passphrase, "-f", path], { stdio: "pipe", timeout: 10_000 });
  askpass = join(dir, "fixture-askpass"); askpassMarker = join(dir, "askpass-calls");
  writeFileSync(askpass, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(askpassMarker)},'called\\n'); process.stdout.write(${JSON.stringify(passphrase)}+'\\n');\n`, { mode: 0o700 });
  authority = { version: 1, id: "11111111-1111-4111-8111-111111111111", namespace: NAMESPACE, identity: SIGNER_ID, ...encryptedKey(key), signer: real.pinned(), keyPath: key, enrollment: null, signature: null };
  authority.enrollment = { version: 1, type: "enrollment", authority: authority.id, repo: null, namespace: NAMESPACE, identity: SIGNER_ID, publicKey: authority.publicKey, fingerprint: authority.fingerprint, signer: authority.signer, keyPath: key };
  authority.signature = signFixture(canonical(authority.enrollment));
});
after(() => rmSync(dir, { recursive: true, force: true }));
const signer = () => ({ ...real, terminal() {}, sign: bytes => signFixture(bytes) });
async function enrolled(t, options = {}) {
  const f = fixture(t, { signer: signer(), qualify: () => ({ qualified: true, fixtureOnly: true }), ...options });
  f.store.init(); f.store.writeAuthority(authority);
  f.candidate = await pending(f.service, f.store);
  return f;
}

test("real disposable OpenSSH interoperates; encryption and minimal environment are enforced", () => {
  assert.equal(real.probe().verify, true); assert.equal(encryptedKey(key).publicKey, authority.publicKey);
  assert.throws(() => encryptedKey(plainKey), /encrypted/);
  const env = signingEnvironment(dir);
  for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_ASKPASS", "DISPLAY", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "OPENAI_API_KEY"]) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(env.SSH_ASKPASS_REQUIRE, "never");
  assert.throws(() => real.sign("unattended", authority), /terminal/);
});

test("OpenSSH rejects edited content, wrong key and wrong namespace", () => {
  const bytes = canonical({ approved: "exact bytes" }), signature = signFixture(bytes);
  assert.equal(real.verify(bytes, signature, authority), true);
  assert.throws(() => real.verify(bytes + " ", signature, authority), /verification failed/);
  assert.throws(() => real.verify(bytes, signFixture(bytes, NAMESPACE, otherKey), authority), /verification failed/);
  assert.throws(() => real.verify(bytes, signFixture(bytes, "foreign-namespace"), authority), /verification failed/);
  assert.throws(() => real.verify(bytes, signature, { ...authority, signer: { ...authority.signer, digest: "a".repeat(64) } }), /signer changed/);
});

test("loaded SSH agent and hostile askpass cannot replace the fresh encrypted-key prompt", t => {
  const agent = execFileSync("/usr/bin/ssh-agent", ["-s"], { encoding: "utf8" });
  const pid = Number(agent.match(/SSH_AGENT_PID=(\d+)/)?.[1]), sock = agent.match(/SSH_AUTH_SOCK=([^;]+)/)?.[1];
  assert(pid && sock); t.after(() => { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } });
  execFileSync("/usr/bin/ssh-add", [key], { env: { ...signingEnvironment(dir), SSH_AUTH_SOCK: sock, DISPLAY: "fixture", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" }, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  const beforeCalls = readFileSync(askpassMarker, "utf8");
  const authFile = join(dir, "authority.json"), bytesFile = join(dir, "pty-manifest");
  writeFileSync(authFile, canonical(authority), { mode: 0o600 }); writeFileSync(bytesFile, "exact reviewed fixture", { mode: 0o600 });
  const python = `import os,pty,sys,select,time
pid,fd=pty.fork()
if pid==0: os.execve(sys.argv[1],[sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]],dict(os.environ))
buf=b''; prompts=0; end=time.monotonic()+12
while time.monotonic()<end:
 if select.select([fd],[],[],0.1)[0]:
  try: chunk=os.read(fd,8192)
  except OSError: break
  if not chunk: break
  buf+=chunk
  if b'Enter passphrase' in buf and prompts==0:
   prompts+=1; os.write(fd,b'disposable-test-passphrase-only\\n')
try: waited,status=os.waitpid(pid,os.WNOHANG)
except ChildProcessError: waited=pid; status=0
while not waited and time.monotonic()<end:
 time.sleep(0.05); waited,status=os.waitpid(pid,os.WNOHANG)
if not waited: os.kill(pid,15); os.waitpid(pid,0); sys.stdout.buffer.write(buf); sys.exit(2)
sys.stdout.buffer.write(buf); print('PROMPTS:'+str(prompts)); sys.exit(os.waitstatus_to_exitcode(status))`;
  const result = spawnSync("python3", ["-c", python, process.execPath, fileURLToPath(new URL("./learning-sign.mjs", import.meta.url)), authFile, bytesFile], { env: { ...process.env, SSH_AUTH_SOCK: sock, SSH_AGENT_PID: String(pid), DISPLAY: "fixture", SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" }, encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, (result.stderr || result.stdout).replaceAll(passphrase, "[fixture-secret]"));
  assert.match(result.stdout, /PROMPTS:1/);
  const signature = Buffer.from(result.stdout.match(/SIGNATURE_RESULT:([A-Za-z0-9+/=]+)/)[1], "base64").toString();
  assert(real.verify("exact reviewed fixture", signature, authority));
  assert.equal(readFileSync(askpassMarker, "utf8"), beforeCalls);
});

test("complete frozen preview precedes signing; cancellation changes no state", async t => {
  let signed = false, previewed = false;
  const f = await enrolled(t, { signer: { ...signer(), sign(bytes) { assert(previewed); signed = true; return signFixture(bytes); } } });
  const before = canonical(f.store.load(repo));
  await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: preview => { assert(preview.includes(f.candidate.content.guidance)); assert(preview.includes(f.candidate.content.example)); assert(preview.includes('"evidence"')); assert(preview.includes('"conflicts"')); return false; } }), /cancelled/);
  assert.equal(canonical(f.store.load(repo)), before); assert.equal(signed, false);
  const reason = "Reviewed regression evidence for input validation";
  const result = await learnCommand({ learning: { ...f.service, resolveRepo: async () => repo } }, {
    args: ["approve", f.candidate.content.id], values: { repo: "example/project", revision: f.candidate.digest, reason },
    confirm: preview => { previewed = true; assert(preview.includes(f.candidate.digest)); assert(preview.includes(reason)); return true; },
  });
  assert.equal(result.sequence, 1); assert.equal(signed, true); assert.equal(f.store.load(repo).checkpoint.sequence, 1);
  assert.equal(f.store.load(repo).transitions["1"].manifest.reason, reason);
});

test("signed activation, relevant bounded context, retirement and fresh-memory fencing", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true });
  await f.service.configure(repo, "apply");
  const first = await f.service.context(repo, { operationId: "attempt-1", profile: "fixture", inputDigest: "a".repeat(64) });
  assert(first.section.includes(f.candidate.content.guidance)); assert.equal(first.rules.length, 1); assert.equal(first.delivered, false);
  const delivery = await f.service.delivered(repo, first.key, "run-1"); assert.equal(delivery.delivered, true);
  assert.equal(canonical(await f.service.context(repo, { operationId: "attempt-1", profile: "fixture", inputDigest: "a".repeat(64) })), canonical(first), "delivery audit changes cannot change immutable retry input");
  const retired = await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { action: "retire", reason: "Regression test replaced advice", confirm: () => true }); assert.equal(retired.sequence, 2);
  const next = await f.service.context(repo, { operationId: "attempt-2", profile: "fixture", inputDigest: "b".repeat(64), previous: first });
  assert.equal(next.section, ""); assert.equal(next.rules.length, 0); assert.equal(next.freshSessionRequired, true);
  assert.equal(f.service.report(repo).eligibleRunDenominator, 1);
});

test("recovery commits exactly signed prepared bytes after an interrupted atomic activation", async t => {
  const f = await enrolled(t), originalSave = f.store.saveLocked;
  let writes = 0;
  f.store.saveLocked = (repo, state) => { writes++; if (writes === 3) throw new Error("fixture crash before activation rename"); return originalSave(repo, state); };
  await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }), /fixture crash/);
  assert.equal(f.store.load(repo).sequence, 0); assert(Object.values(f.store.load(repo).prepared)[0].signature);
  f.store.saveLocked = originalSave;
  const restarted = createLearningService({ store: f.store, signer: signer(), qualify: () => ({ qualified: true, fixtureOnly: true }) });
  assert.equal((await restarted.recover(repo))[0].sequence, 1); assert.deepEqual(await restarted.recover(repo), []);
});

test("concurrent approval cannot change a preview or active checkpoint", async t => {
  const f = await enrolled(t);
  await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: async () => { await f.service.reject(repo, f.candidate.content.id, f.candidate.digest, "concurrent"); return true; } }), /approval state changed/);
  assert.equal(f.store.load(repo).sequence, 0);
  assert.deepEqual(f.store.load(repo).prepared, {});
});

test("context rechecks disabled mode under lock after asynchronous qualification", async t => {
  for (const mode of ["off", "collect"]) {
    let disable = false, service;
    const f = await enrolled(t, { qualify: async () => {
      if (disable) { disable = false; await service.configure(repo, mode); }
      return { qualified: true, fixtureOnly: true };
    } });
    service = f.service;
    await service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true });
    await service.configure(repo, "apply"); disable = true;
    const context = await service.context(repo, { operationId: "racing-disable", profile: "fixture", inputDigest: "a".repeat(64), previous: { rules: [{ id: "old" }] } });
    assert.equal(context.mode, mode); assert.equal(context.section, ""); assert.equal(context.freshSessionRequired, true);
    assert.deepEqual(f.store.load(repo).deliveries, {});
  }
});

test("retirement and disabled modes durably fence prepared launch admission", async t => {
  for (const action of ["retire", "off", "collect"]) {
    const f = await enrolled(t);
    const selection = [{ id: f.candidate.content.id, digest: f.candidate.digest }];
    await f.service.approve(repo, selection, { confirm: () => true }); await f.service.configure(repo, "apply");
    const snapshot = await f.service.context(repo, { taskId: "example/project/new", operationId: "prepared", profile: "codex", inputDigest: "a".repeat(64) });
    const unqualifiedService = createLearningService({ store: f.store, signer: signer() });
    await assert.rejects(learningDispatch({ learning: unqualifiedService }, "example/project/new", { learning: { ...snapshot, repo } }, () => assert.fail("unqualified profile")), e => e.code === "LEARNING_UNQUALIFIED" && e.dispatchNotSent);
    if (action === "retire") await f.service.approve(repo, selection, { action, reason: "Retire before launch", confirm: () => true });
    else await f.service.configure(repo, action);
    assert(f.store.load(repo).deliveries[snapshot.key].revoked);
    const restarted = createLearningService({ store: f.store, signer: signer(), qualify: () => ({ qualified: true, fixtureOnly: true }) });
    await restarted.configure(repo, "apply");
    await assert.rejects(learningDispatch({ learning: restarted }, "example/project/new", { learning: { ...snapshot, repo } }, () => assert.fail("retired guidance must never launch")), e => e.code === "LEARNING_STALE_CONTEXT" && e.dispatchNotSent === true);
  }
});

test("launch admission serializes retirement and cancels accepted work before registry registration", async t => {
  for (const provider of ["codex", "openai-agents"]) {
    let execution, job = null, cancelled = 0;
    const ctx = { state: { entries: () => [], get: () => null, update: () => assert.fail("start has no entry yet") }, executionFor: () => execution };
    const f = await enrolled(t, { onRevocation: intent => revokeLearningAttempts(ctx, intent) });
    const selection = [{ id: f.candidate.content.id, digest: f.candidate.digest }], taskId = "example/project/new";
    await f.service.approve(repo, selection, { confirm: () => true }); await f.service.configure(repo, "apply");
    const snapshot = await f.service.context(repo, { taskId, operationId: "prepared", profile: provider, inputDigest: "a".repeat(64) });
    const remote = provider === "openai-agents";
    execution = makeExecution({ root: join(f.dir, "execution"), taskId, provider,
      ...(remote ? { transport: { submit: async () => ({ providerJobId: "job", sessionId: "session", turnId: "turn" }), cancel: async () => { cancelled++; return { confirmed: true }; } }, capabilities: { ...executionRegistry[provider], available: true, controls: { cancel: true } } }
        : { runner: { current: () => job, lines: () => [], annotate() {}, start: async (_name, _cmd, _args, options) => job = { id: options.runId, running: true, exit: null }, kill: () => { cancelled++; job.running = false; job.exit = 137; return true; } } }),
    });
    const managed = { operationId: "prepared", learning: { ...snapshot, repo }, allowance: { remainingUsd: 1, reservedUsd: 0.1 } };
    const accepted = await learningDispatch({ learning: f.service }, taskId, managed, async () => {
      await assert.rejects(f.service.configure(repo, "off"), /already running/);
      assert.equal(f.service.mode(repo), "apply");
      return remote ? execution.submit(managed) : execution.start("start", "fixture", [], { execution: managed });
    });
    assert.equal(execution.current().id, accepted.id);
    await f.service.approve(repo, selection, { action: "retire", reason: "Retire after acceptance", confirm: () => true });
    assert.equal(execution.state().stopped, "learned advice retired"); assert.equal(cancelled, 1);
    assert.equal(f.store.load(repo).deliveries[snapshot.key].delivered, false);
    t.diagnostic(JSON.stringify({ preparedDeliveryRevocation: { provider, taskId, key: snapshot.key, acceptedRun: accepted.id, registryEntries: ctx.state.entries().length, stopped: execution.state().stopped, cancellationCalls: cancelled, qualification: "offline fixture; UNQUALIFIED for production" } }));
  }
});

test("recovery retries committed retirement controls without signing another transition", async t => {
  const f = await enrolled(t, { onRevocation: async intent => {
    if (intent.removed?.length) throw new Error("registry locked after signed commit");
    return [];
  } });
  const selection = [{ id: f.candidate.content.id, digest: f.candidate.digest }];
  await f.service.approve(repo, selection, { confirm: () => true });
  await assert.rejects(f.service.approve(repo, selection, { action: "retire", reason: "No longer applicable", confirm: () => true }), /registry locked/);
  f.service.rememberRepo("example/project", repo);
  const committed = canonical(f.store.load(repo));
  assert.equal(f.store.load(repo).sequence, 2); assert.deepEqual(f.store.load(repo).active, []);
  const calls = [], restarted = createLearningService({ store: f.store, gh: { learningRepository() { assert.fail("offline recovery must not resolve GitHub identity"); } }, signer: { ...signer(), sign() { throw new Error("must not sign during recovery"); } }, qualify: () => ({ qualified: true, fixtureOnly: true }), onRevocation: async intent => {
    const release = f.store.lock(); release(); // Controls run after the atomic transaction.
    calls.push(intent); return [{ cancellation: { confirmed: true } }];
  } });
  for (let retry = 0; retry < 2; retry++) {
    assert.equal((await learnCommand({ learning: restarted }, { args: ["recover"], values: { repo: "example/project" } }))[0].controls[0].cancellation.confirmed, true);
    assert.equal(canonical(f.store.load(repo)), committed);
  }
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].removed, selection);
});

test("stale signed intent requires another preview and cannot silently rebase", async t => {
  const f = await enrolled(t), save = f.store.saveLocked; let writes = 0;
  f.store.saveLocked = (repo, s) => { if (++writes === 3) throw new Error("interrupted activation"); save(repo, s); };
  await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }), /interrupted/);
  f.store.saveLocked = save;
  const other = await f.service.revise(repo, "lesson-other", { ...f.candidate.content, id: "lesson-other", guidance: "Validate all fields as one record." });
  await f.service.approve(repo, [{ id: other.content.id, digest: other.digest }], { confirm: () => true });
  const obsolete = await f.service.recover(repo);
  assert.equal(obsolete[0].disposition, "obsolete"); assert.equal(obsolete[0].supersededBy, f.store.load(repo).parent);
  assert.deepEqual(await f.service.recover(repo), []);
  assert.equal(f.store.load(repo).sequence, 1); assert.equal(f.service.show(repo, f.candidate.content.id).status, "pending");
});

test("obsolete signed preparations cannot poison later recovery and retirement is atomic", async t => {
  const f = await enrolled(t), save = f.store.saveLocked;
  const crashApproval = async (selection, reason) => {
    let writes = 0;
    f.store.saveLocked = (repo, state) => { if (++writes === 3) throw new Error("crash after signing"); save(repo, state); };
    try { await assert.rejects(f.service.approve(repo, selection, { reason, confirm: () => true }), /crash after signing/); }
    finally { f.store.saveLocked = save; }
  };
  const first = [{ id: f.candidate.content.id, digest: f.candidate.digest }];
  await crashApproval(first, "First review");
  const [obsoleteKey, obsolete] = Object.entries(f.store.load(repo).prepared)[0];
  await f.service.approve(repo, first, { reason: "Explicitly reviewed retry", confirm: () => true });
  const other = await f.service.revise(repo, "lesson-other", { ...f.candidate.content, id: "lesson-other", guidance: "Validate all fields as one record." });
  await crashApproval([{ id: other.content.id, digest: other.digest }], "Later review");
  const before = canonical(f.store.load(repo)), transaction = f.store.transaction;
  f.store.transaction = (repo, fn) => transaction(repo, async s => { await fn(s); throw new Error("crash before recovery rename"); });
  try { await assert.rejects(f.service.recover(repo), /crash before recovery rename/); }
  finally { f.store.transaction = transaction; }
  assert.equal(canonical(f.store.load(repo)), before);
  // Corrupt obsolete signatures remain an error, never a silently deleted item.
  await transaction(repo, s => { s.prepared[obsoleteKey].signature = signFixture(canonical(obsolete.manifest), NAMESPACE, otherKey); });
  const corrupt = canonical(f.store.load(repo));
  await assert.rejects(f.service.recover(repo), /verification failed/);
  assert.equal(canonical(f.store.load(repo)), corrupt);
  await transaction(repo, s => { s.prepared[obsoleteKey] = obsolete; });
  const restarted = createLearningService({ store: f.store, signer: { ...signer(), sign() { assert.fail("recovery cannot sign"); } }, qualify: () => ({ qualified: true, fixtureOnly: true }) });
  const results = await restarted.recover(repo), state = f.store.load(repo);
  assert.equal(results[0].disposition, "obsolete"); assert.equal(results[1].sequence, 2);
  assert.equal(state.sequence, 2); assert.equal(state.active.length, 2); assert.deepEqual(state.prepared, {});
  assert.deepEqual(state.preparationHistory[obsoleteKey].manifest, obsolete.manifest);
  assert.equal(state.preparationHistory[obsoleteKey].signature, obsolete.signature);
  assert.deepEqual(restarted.report(repo).preparations, { pending: 0, obsolete: 1 });
  assert.deepEqual(await restarted.recover(repo), []);
  t.diagnostic(JSON.stringify({ obsoletePreparationRecovery: results, archiveCount: Object.keys(state.preparationHistory).length, activeSequence: state.sequence }));
});

test("trust substitution and missing checkpoint fail before any context, including after restart", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }); await f.service.configure(repo, "apply");
  const substitute = { ...authority, ...encryptedKey(otherKey), keyPath: otherKey };
  substitute.enrollment = { ...authority.enrollment, publicKey: substitute.publicKey, fingerprint: substitute.fingerprint, keyPath: otherKey };
  substitute.signature = signFixture(canonical(substitute.enrollment), NAMESPACE, otherKey);
  f.store.writeAuthority(substitute);
  const input = { operationId: "substituted-trust", profile: "fixture", inputDigest: "a".repeat(64) };
  await assert.rejects(f.service.context(repo, input), /trust root changed/);
  const restarted = createLearningService({ store: f.store, signer: signer(), qualify: () => ({ qualified: true, fixtureOnly: true }) });
  await assert.rejects(restarted.context(repo, input));
  f.store.writeAuthority(authority);
  const s = f.store.load(repo); s.checkpoint = null;
  const release = f.store.lock(); try { f.store.saveLocked(repo, s); } finally { release(); }
  await assert.rejects(f.service.context(repo, input), /checkpoint inconsistent/);
});

test("held-out relevance fixtures use literal scopes and disclose every omission", async t => {
  const f = await enrolled(t), wide = f.candidate;
  const project = await f.service.revise(repo, "lesson-project", proposed(wide.content.evidence[0], { id: "lesson-project", paths: ["src/input"], guidance: "Validate each parser input record completely." }));
  await f.service.approve(repo, [project, wide].map(c => ({ id: c.content.id, digest: c.digest })), { confirm: preview => { assert(preview.includes(project.digest)); assert(preview.includes(wide.digest)); return true; } });
  await f.service.configure(repo, "apply");
  const heldout = JSON.parse(readFileSync(new URL("./fixtures/learning-heldout.json", import.meta.url), "utf8"));
  for (const [i, expected] of heldout.entries()) {
    const selected = await f.service.context(repo, { operationId: `heldout-${i}`, profile: "fixture", paths: expected.paths, inputDigest: hash(expected) });
    assert.deepEqual(selected.rules.map(r => r.id), expected.selected); assert.deepEqual(selected.omitted.map(r => r.id), expected.omitted);
    if (expected.reason) assert(selected.omitted.every(r => r.reason === expected.reason));
    assert(Buffer.byteLength(selected.section) <= 8192);
  }
});

test("revisions stay unapproved until signed replacement and stale undelivered inputs are fenced", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }); await f.service.configure(repo, "apply");
  const intent = { operationId: "not-yet-dispatched", profile: "fixture", inputDigest: "a".repeat(64) };
  await f.service.context(repo, intent);
  const next = await f.service.revise(repo, f.candidate.content.id, { ...f.candidate.content, guidance: "Validate all fields together before persistence." });
  assert.equal(f.service.show(repo, next.content.id, next.digest).status, "pending");
  assert.equal(f.store.load(repo).active[0].digest, f.candidate.digest);
  await f.service.approve(repo, [{ id: next.content.id, digest: next.digest }], { confirm: () => true });
  assert.equal(f.service.show(repo, f.candidate.content.id, f.candidate.digest).status, "retired");
  await assert.rejects(f.service.context(repo, intent), /revoked/);
});

test("forged transitions, extra batch rules, foreign repo, replay and rollback cannot dispatch", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true });
  await f.service.configure(repo, "apply");
  const original = f.store.load(repo);
  const mutations = [s => { s.transitions[1].signature = signFixture(canonical(s.transitions[1].manifest), NAMESPACE, otherKey); }, s => { s.transitions[1].manifest.add[0].content.guidance = "substitution"; }, s => { s.transitions[1].manifest.repo.id = "9999"; }, s => { s.transitions[1].manifest.namespace = "wrong"; }, s => { s.transitions[1].manifest.add.push(s.transitions[1].manifest.add[0]); }, s => { s.parent = "0".repeat(64); }, s => { s.checkpoint.sequence = 0; }, s => { s.active = []; }, s => { s.transitions[1].manifest.sequence = 2; }];
  for (const mutate of mutations) {
    const s = JSON.parse(JSON.stringify(original)); mutate(s);
    const release = f.store.lock(); try { f.store.saveLocked(repo, s); } finally { release(); }
    await assert.rejects(f.service.context(repo, { operationId: "hostile", profile: "fixture", inputDigest: "a".repeat(64) }));
  }
  const release = f.store.lock(); try { f.store.saveLocked(repo, original); } finally { release(); }
  const t1 = original.transitions[1];
  original.prepared[t1.digest] = { manifest: t1.manifest, signature: t1.signature };
  const lock = f.store.lock(); try { f.store.saveLocked(repo, original); } finally { lock(); }
  assert.equal((await f.service.recover(repo))[0].idempotent, true);
  assert.equal(f.store.load(repo).sequence, 1);
});

test("the hostile-signature security oracle detects a deliberately bypassed verifier", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }); await f.service.configure(repo, "apply");
  const s = f.store.load(repo); s.transitions[1].signature = signFixture(canonical(s.transitions[1].manifest), NAMESPACE, otherKey);
  const release = f.store.lock(); try { f.store.saveLocked(repo, s); } finally { release(); }
  const oracle = service => assert.rejects(service.context(repo, { operationId: "oracle", profile: "fixture", inputDigest: "a".repeat(64) }), /verification failed/);
  await oracle(f.service);
  const bypassed = createLearningService({ store: f.store, signer: { ...signer(), verify() { return true; } }, qualify: () => ({ qualified: true, fixtureOnly: true }) });
  await assert.rejects(oracle(bypassed), /Missing expected rejection/);
});


test("batch approval refuses duplicate candidate IDs before terminal or signing", async t => {
  const f = await enrolled(t);
  const revision = await f.service.revise(repo, f.candidate.content.id, { ...f.candidate.content, guidance: "Validate the complete record before persisting it." });
  const before = canonical(f.store.load(repo));
  const service = createLearningService({ store: f.store, signer: { ...signer(), terminal() { assert.fail("must reject before terminal"); }, sign() { assert.fail("must not sign"); } } });
  const first = { id: f.candidate.content.id, digest: f.candidate.digest };
  for (const second of [first, { id: revision.content.id, digest: revision.digest }]) {
    for (const action of ["approve", "retire"]) await assert.rejects(service.approve(repo, [first, second], { action, confirm() { assert.fail("must not preview"); } }), { code: "LEARNING_INPUT" });
  }
  assert.equal(canonical(f.store.load(repo)), before);
});


test("setup retries pending encrypted key enrollment after signing failure", async t => {
  let creates = 0;
  const f = fixture(t), approval = join(f.dir, "approval"); mkdirSync(approval, { mode: 0o700 });
  const keyPath = join(approval, "key");
  const firstSigner = { ...signer(), probe() {}, createKey(path) { creates++; copyFileSync(key, path); copyFileSync(key + ".pub", path + ".pub"); return encryptedKey(path); }, sign() { throw new Error("signing cancelled"); } };
  const qualify = () => ({ qualified: true, fixtureOnly: true });
  const first = createLearningService({ store: f.store, signer: firstSigner, qualify });
  await assert.rejects(first.setup({ keyPath, confirm: () => true }), /signing cancelled/);
  const intent = canonical(f.store.readEnrollment()); assert.equal(f.store.readAuthority(), null);
  const restarted = createLearningService({ store: f.store, signer: { ...signer(), probe() {}, createKey() { assert.fail("retry must not recreate key"); } }, qualify });
  await assert.rejects(restarted.setup({ keyPath, confirm: () => false }), { code: "LEARNING_CANCELLED" });
  assert.equal(canonical(f.store.readEnrollment()), intent); assert.equal(f.store.readAuthority(), null);
  copyFileSync(otherKey, keyPath);
  await assert.rejects(restarted.setup({ keyPath, confirm() { assert.fail("substituted key must fail before preview"); } }), /pending enrollment/);
  copyFileSync(key, keyPath);
  const result = await restarted.setup({ keyPath, confirm: preview => { assert.match(preview, /retry signed enrollment/); assert.match(preview, /fingerprint/); return true; } });
  assert.equal(result.enrolled, true); assert.equal(creates, 1);
  const enrolled = f.store.readAuthority(); real.verify(canonical(enrolled.enrollment), enrolled.signature, enrolled);
  assert.equal(enrolled.id, JSON.parse(intent).id);
});

test("setup releases the shared lock for prompts and refuses changed enrollment intents", async t => {
  const f = fixture(t), approval = join(f.dir, "approval"); mkdirSync(approval, { mode: 0o700 });
  const keyPath = join(approval, "key"), qualify = () => ({ qualified: true, fixtureOnly: true });
  let changed = false;
  const checkUnlocked = () => { const release = f.store.lock(); release(); };
  const setupSigner = { ...signer(), probe() {}, createKey(path) { checkUnlocked(); copyFileSync(key, path); copyFileSync(key + ".pub", path + ".pub"); return encryptedKey(path); }, sign(bytes) {
    checkUnlocked();
    if (!changed) { changed = true; const release = f.store.lock(); try { const intent = f.store.readEnrollment(); intent.id = "22222222-2222-4222-8222-222222222222"; f.store.writeEnrollment(intent); } finally { release(); } }
    return signFixture(bytes);
  } };
  const service = createLearningService({ store: f.store, signer: setupSigner, qualify });
  await assert.rejects(service.setup({ keyPath, confirm: async () => { await f.service.configure(repo, "collect"); await f.service.prune(repo); return true; } }), /concurrent enrollment changed/);
  assert.equal(f.store.readAuthority(), null); assert.equal(f.service.mode(repo), "collect");
  assert.equal((await service.setup({ keyPath, confirm: () => { checkUnlocked(); return true; } })).enrolled, true);
});

test("recovery retries committed revocations before refusing unqualified prepared activation", async t => {
  const f = await enrolled(t, { onRevocation: async intent => { if (intent.removed?.length) throw new Error("controls unavailable"); return []; } });
  const selection = [{ id: f.candidate.content.id, digest: f.candidate.digest }];
  await f.service.approve(repo, selection, { confirm: () => true });
  await assert.rejects(f.service.approve(repo, selection, { action: "retire", reason: "Remove stale advice", confirm: () => true }), /controls unavailable/);
  let controls = 0;
  const recovery = createLearningService({ store: f.store, signer: signer(), qualify: () => ({ qualified: false }), onRevocation: async () => { controls++; return [{ cancellation: { confirmed: true } }]; } });
  assert.equal((await recovery.recover(repo))[0].controls[0].cancellation.confirmed, true);
  const candidate = await f.service.revise(repo, f.candidate.content.id, { ...f.candidate.content, guidance: "Validate complete records before writing any fields." });
  const save = f.store.saveLocked; let writes = 0;
  f.store.saveLocked = (r, s) => { if (++writes === 3) throw new Error("interrupted activation"); return save(r, s); };
  try { await assert.rejects(f.service.approve(repo, [{ id: candidate.content.id, digest: candidate.digest }], { confirm: () => true }), /interrupted activation/); }
  finally { f.store.saveLocked = save; }
  const before = canonical(f.store.load(repo));
  assert(Object.values(f.store.load(repo).prepared)[0].signature);
  await assert.rejects(recovery.recover(repo), { code: "LEARNING_UNQUALIFIED" });
  assert.equal(controls, 2); assert.equal(canonical(f.store.load(repo)), before);
  assert.deepEqual(f.store.load(repo).active, []);
});


test("approval prompts release the lock and disabled state fences signing", async t => {
  for (const phase of ["confirm", "sign"]) {
    let f;
    const custom = signer();
    custom.sign = bytes => {
      const release = f.store.lock();
      try { const s = f.store.load(repo); s.mode = "off"; f.store.saveLocked(repo, s); } finally { release(); }
      return signFixture(bytes);
    };
    f = await enrolled(t, phase === "sign" ? { signer: custom } : {});
    await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: async () => {
      await f.service.prune(repo);
      if (phase === "confirm") await f.service.configure(repo, "off");
      return true;
    } }), /approval state changed/);
    const state = f.store.load(repo);
    assert.equal(state.mode, "off"); assert.equal(state.sequence, 0);
    assert(Object.values(state.prepared).every(p => p.signature === null));
    await f.service.recover(repo); assert.equal(f.store.load(repo).sequence, 0);
  }
});

test("delivery capacity preserves exact retries and emergency controls", async t => {
  const f = await enrolled(t);
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true });
  await f.service.configure(repo, "apply");
  const input = { operationId: "retained", profile: "fixture", inputDigest: "a".repeat(64) };
  const first = await f.service.context(repo, input);
  await assert.rejects(f.service.context(repo, { ...input, operationId: "oversized", profile: "x".repeat(LEARNING_LIMITS.deliveryBytes) }), /delivery detail byte limit/);
  await f.store.transaction(repo, s => {
    for (let i = 1; i < LEARNING_LIMITS.deliveries; i++) {
      const key = hash(String(i)); s.deliveries[key] = { ...first, key, operationId: String(i), delivered: true, runId: String(i) };
    }
  });
  assert.deepEqual(await f.service.context(repo, input), first);
  await assert.rejects(f.service.context(repo, { ...input, operationId: "overflow" }), /delivery audit capacity/);
  await f.service.delivered(repo, first.key, "original-run");
  await f.service.prune(repo);
  assert.equal(f.service.report(repo).eligibleRunDenominator, LEARNING_LIMITS.deliveries);
  await f.service.configure(repo, "off");
  assert.equal(f.store.load(repo).mode, "off");
  assert.equal(Object.keys(f.store.load(repo).deliveries).length, LEARNING_LIMITS.deliveries);
  assert.equal(f.service.explain(repo, "original-run")[0].contextDigest, first.contextDigest);
});


test("full accepted long path budgets select advice with bounded audit detail", async t => {
  const f = await enrolled(t);
  const paths = learningPaths({}, Array.from({ length: 200 }, (_, i) => `src/${String(i).padStart(3, "0")}/` + "é".repeat(252)));
  assert.equal(paths.length, 200); assert.equal(Buffer.byteLength(paths[0]), 512);
  const scoped = await f.service.revise(repo, "lesson-last-path", proposed(f.candidate.content.evidence[0], { id: "lesson-last-path", paths: [paths.at(-1)] }));
  await f.service.approve(repo, [{ id: scoped.content.id, digest: scoped.digest }], { confirm: () => true });
  await f.service.configure(repo, "apply");
  for (const [profile, known] of [["local-fixture", paths], ["hosted-fixture", paths.map(p => p.replace("src/", "lib/"))]]) {
    const input = { operationId: profile, profile, paths: known, inputDigest: hash(known), taskId: profile };
    const delivery = await f.service.context(repo, input);
    assert.equal(delivery.rules.length, profile === "local-fixture" ? 1 : 0);
    assert.equal(delivery.pathAudit.digest, hash(known)); assert.equal(delivery.pathAudit.count, 200);
    assert.equal(delivery.pathAudit.omitted, 200 - delivery.paths.length); assert(delivery.pathAudit.omitted > 0);
    assert(Buffer.byteLength(canonical(delivery.paths)) <= LEARNING_LIMITS.pathAuditBytes);
    assert(Buffer.byteLength(canonical(delivery)) <= LEARNING_LIMITS.deliveryBytes);
    assert.deepEqual(await f.service.context(repo, input), delivery);
    assert.equal(await learningDispatch({ learning: f.service }, profile, { learning: { ...delivery, repo } }, () => "accepted"), "accepted");
    await f.service.delivered(repo, delivery.key, profile);
    assert.deepEqual(f.service.explain(repo, profile)[0].pathAudit, delivery.pathAudit);
  }
});


test("custom enrolled signer survives CLI restart and refuses changed executable bytes", async t => {
  const f = fixture(t), executable = join(f.dir, "portable-ssh-keygen"), approval = join(f.dir, "approval");
  writeFileSync(executable, '#!/bin/sh\nexec /usr/bin/ssh-keygen "$@"\n', { mode: 0o700 }); mkdirSync(approval, { mode: 0o700 });
  const keyPath = join(approval, "key"), qualify = () => ({ qualified: true, fixtureOnly: true });
  let selectedPath;
  const ctx = { learningFor(_login, options) {
    selectedPath = options.signerExecutable;
    const actual = storedOpenSshSigner(f.store, { executable: selectedPath });
    return createLearningService({ store: f.store, qualify, signer: { ...actual, terminal() {},
      createKey(path) { copyFileSync(key, path); copyFileSync(key + ".pub", path + ".pub"); return encryptedKey(path); },
      sign: bytes => signFixture(bytes),
    } });
  } };
  await learnCommand(ctx, { args: ["setup"], values: { "key-path": keyPath, "ssh-keygen": executable }, confirm: () => true });
  assert.equal(selectedPath, executable); assert.equal(f.store.readAuthority().signer.path, executable);
  const c = await pending(f.service, f.store);
  const reviewer = createLearningService({ store: f.store, qualify, signer: { ...storedOpenSshSigner(f.store), terminal() {}, sign: bytes => signFixture(bytes) } });
  await reviewer.approve(repo, [{ id: c.content.id, digest: c.digest }], { confirm: () => true });
  f.service.rememberRepo("example/project", repo);
  const restarted = createLearningService({ store: f.store, qualify, probeIsolation: async () => ({ qualified: false }) });
  const doctor = await restarted.doctor(); assert.equal(doctor.enrollment.enrolled, true); assert.equal(doctor.openssh.signer.path, executable);
  assert.deepEqual(await learnCommand({ learning: restarted }, { args: ["recover"], values: { repo: "example/project" } }), []);
  await restarted.configure(repo, "apply");
  assert.equal((await restarted.context(repo, { operationId: "after-restart", profile: "fixture", inputDigest: "a".repeat(64) })).rules.length, 1);
  const marker = join(f.dir, "must-not-execute");
  writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\n`);
  const changed = createLearningService({ store: f.store, qualify, probeIsolation: async () => ({ qualified: false }) });
  assert.equal((await changed.doctor()).openssh.available, false);
  await assert.rejects(changed.recover(repo), /pinned signer changed/);
  assert.equal(existsSync(marker), false);
  await changed.configure(repo, "off"); assert.equal(changed.mode(repo), "off");
});
