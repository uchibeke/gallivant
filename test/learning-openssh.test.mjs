import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openSshSigner, encryptedKey, signingEnvironment, NAMESPACE, SIGNER_ID } from "../lib/learning_signer.mjs";
import { canonical, hash } from "../lib/learning_data.mjs";
import { createLearningService } from "../lib/learning.mjs";
import { fixture, pending, proposed, repo } from "./learning-fixtures.mjs";

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
  const result = await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: preview => { previewed = true; assert(preview.includes(f.candidate.digest)); return true; } });
  assert.equal(result.sequence, 1); assert.equal(signed, true); assert.equal(f.store.load(repo).checkpoint.sequence, 1);
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
  await f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: async () => { await assert.rejects(f.service.reject(repo, f.candidate.content.id, f.candidate.digest, "concurrent"), /already running/); return true; } });
  assert.equal(f.store.load(repo).sequence, 1);
});

test("stale signed intent requires another preview and cannot silently rebase", async t => {
  const f = await enrolled(t), save = f.store.saveLocked; let writes = 0;
  f.store.saveLocked = (repo, s) => { if (++writes === 3) throw new Error("interrupted activation"); save(repo, s); };
  await assert.rejects(f.service.approve(repo, [{ id: f.candidate.content.id, digest: f.candidate.digest }], { confirm: () => true }), /interrupted/);
  f.store.saveLocked = save;
  const other = await f.service.revise(repo, "lesson-other", { ...f.candidate.content, id: "lesson-other", guidance: "Validate all fields as one record." });
  await f.service.approve(repo, [{ id: other.content.id, digest: other.digest }], { confirm: () => true });
  await assert.rejects(f.service.recover(repo), /stale\/replayed/);
  assert.equal(f.store.load(repo).sequence, 1); assert.equal(f.service.show(repo, f.candidate.content.id).status, "pending");
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
  await assert.rejects(f.service.context(repo, intent), /older bundle/);
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
