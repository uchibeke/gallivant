import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resume } from "../lib/commands/resume.mjs";
import { runSessionEnv } from "../lib/git.mjs";
import { check, parsePrd } from "../lib/prd.mjs";
import { publicationPolicyOf, workArtifactReason } from "../lib/work_artifacts.mjs";
import { checkBaseFiles, contentDigest } from "../lib/start_contract.mjs";
import { turnBinding, verifyAuthorCopies, authorReadiness, checkAuthorStorage } from "../lib/recovery_preflight.mjs";
import { makeTick } from "../lib/tick.mjs";
import { CONFIG, GOOD_PRD, seededState, fakeRunner, fakeGit, fakeIdentity, fakeGh, fakeCredential, harnessBin, silentLog } from "./helpers.mjs";

test("ready reports the exact explicit implementation/source contradiction and rejects protected exceptions", () => {
  const parsed = parsePrd(GOOD_PRD, "docs/prds/example.md");
  parsed.meta.sources = ["lib/command.mjs"];
  parsed.meta.implementation_targets = ["lib/command.mjs"];
  assert.match(check(parsed).results.find(r => r.id === "publish-files").detail, /lib\/command\.mjs is both/);
  assert.equal(parsed.meta.publish_files, undefined);
  assert.match(workArtifactReason("lib/command.mjs", { inputFiles: ["./lib//command.mjs"] }), /carried task input/);
  parsed.meta.publish_files = ["lib/command.mjs"];
  assert.deepEqual(publicationPolicyOf(parsed).inputFiles, ["lib/command.mjs"]);
  for (const path of [".ssh/key", "docs/../private", "doc//file", "dir/*", ".npmrc"]) {
    parsed.meta.publish_files = [path];
    assert.throws(() => publicationPolicyOf(parsed));
  }
});

test("newly tracked base collision reports the exact private source even when bytes match", async () => {
  const files = [["docs/private", "same"]];
  await assert.rejects(checkBaseFiles({ files, sources: files }, { "docs/private": null }, async () => "same"), /docs\/private.*newly tracked/);
});

test("tool sign-in does not attest model access, browser or private transport; diagnostics are redacted", () => {
  const request = { repo: "org/repo", route: { model: "small" }, browser: true, packages: ["pkg"], privateContext: true };
  const result = authorReadiness(request);
  const proof = { ok: true, binding: result.binding, expiresAt: 100 };
  assert.equal(authorReadiness(request, { runtime: proof }, 50).ready, false);
  const evidence = Object.fromEntries(result.diagnostics.map(({ check }) => [check, proof]));
  assert.equal(authorReadiness(request, evidence, 50).ready, true);
  assert.equal(authorReadiness({ ...request, route: { model: "different" } }, evidence, 50).ready, false);
  assert.equal(authorReadiness(request, evidence, 100).ready, false);
  assert.doesNotMatch(JSON.stringify(authorReadiness(request, { model: { detail: "secret-token" } })), /secret-token/);
});

test("actual mount paths are checked including Git metadata, scratch bytes and inodes", () => {
  const paths = { stateDir: "/state", worktree: "/tree", gitDirs: ["/meta"], scratch: "/scratch" };
  for (const [path, stat, expected] of [["/scratch", { bavail: 0n }, /scratch/], ["/state", { ffree: 0n }, /state/], ["/meta", null, /Git metadata/]]) {
    assert.throws(() => checkAuthorStorage(paths, { access(p) { if (p === path && !stat) throw new Error("private path data"); },
      statfs: p => ({ bavail: 10000n, bsize: 4096n, ffree: 1000n, ...(p === path ? stat : {}) }) }), expected);
  }
});

test("edited protected snapshot and replacement profile during author preparation prevent dispatch", async () => {
  for (const change of ["snapshot", "profile"]) {
    const { state, id } = seededState({ snapshot_digest: contentDigest(GOOD_PRD) });
    const runner = fakeRunner(Date);
    let brief = GOOD_PRD;
    const ctx = { state, config: CONFIG, log: silentLog, git: fakeGit(), runnerFor: () => runner, ownLogin: "me",
      readPrd: () => brief, identity: fakeIdentity(), credential: async () => {
        if (change === "snapshot") brief += "\n";
        else state.update(id, { recovery_profile: { version: 1, digest: "f".repeat(64) } });
        return { token: "fixture" };
      } };
    const entry = state.get(id);
    assert.match(turnBinding(ctx, id, entry, parsePrd(brief, id)), /^[a-f0-9]{64}$/);
    await assert.rejects(makeTick(ctx).startRun(id, entry, { name: "fix", prompt: "approved" }), /Approved .* changed/);
    assert.equal(runner.started.length, 0);
  }
});

test("operator resnapshot replaces a hook already derived during base preparation before the corrective turn", async () => {
  const { state, home, id } = seededState({ state: "needs-human", reason: "prd-changed", harness: "codex" });
  const checkout = join(home, "operator"), worktree = join(home, "worktree");
  mkdirSync(join(checkout, "docs/prds"), { recursive: true });
  mkdirSync(worktree);
  const rel = state.get(id).prd, output = "docs/evidence/result.md";
  const replacement = GOOD_PRD.replace("harness: codex", "harness: codex\npublish_files: [" + output + "]")
    .replace("npm run lint", "npm run verify-export");
  writeFileSync(join(checkout, rel), replacement);
  state.update(id, { worktree, checkout, snapshot_digest: contentDigest(GOOD_PRD) });
  const policies = [], runner = fakeRunner(Date);
  let protectedText = GOOD_PRD;
  const ctx = { home, state, git: { ...fakeGit(), installHooks(_dir, policy) { policies.push(policy); return { installed: true }; } },
    gh: fakeGh(), config: { ...CONFIG, home, harness: { codex: { bin: harnessBin(home) } } },
    clock: Date, log: silentLog, runnerFor: () => runner, readPrd: () => protectedText, writePrd: (_id, text) => { protectedText = text; },
    identity: fakeIdentity(), credential: fakeCredential() };
  await resume(ctx, { handle: id, resnapshot: true });
  assert.deepEqual(policies.map(p => p.publishFiles), [[], [output]]);
  assert.equal(state.get(id).snapshot_digest, contentDigest(replacement));
  assert.equal(readFileSync(join(worktree, rel), "utf8"), replacement);
  assert.match(runner.started[0].args.at(-1), /npm run verify-export/);
});

test("author environment blanks inherited completion and non-opted-in package credentials", () => {
  const keys = ["APORT_API_KEY", "APORT_AGENT_ID", "NODE_AUTH_TOKEN", "GITHUB_PACKAGES_TOKEN", "NPM_TOKEN"];
  const env = runSessionEnv(Object.fromEntries(keys.map(key => [key, "private"])), CONFIG, {}, {}, "/tmp/fixture");
  assert.ok(keys.every(key => env[key] === ""));
});

test("worker edits to an admitted private copy cannot replace the accepted source and remain intact", () => {
  const { home, id } = seededState();
  writeFileSync(join(home, "private.md"), "worker edit");
  const ctx = { readSource: () => "approved bytes" };
  assert.throws(() => verifyAuthorCopies(ctx, id, { recovery_profile: { version: 1, digest: "a".repeat(64) },
    worktree: home, sources: ["private.md"] }, parsePrd(GOOD_PRD, id)), /private.md/);
  assert.equal(readFileSync(join(home, "private.md"), "utf8"), "worker edit");
});
