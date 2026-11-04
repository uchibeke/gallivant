import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { makeState } from "../lib/state.mjs";
import { tempHome } from "./helpers.mjs";

const record = status => ({ key: "review-1", status: "completed", disposition: { status }, evidence: { diff: "private evidence ".repeat(20000) } });
const seed = (home, history) => writeFileSync(join(home, "state.json"), JSON.stringify({ version: 1, entries: { "acme/repo/task": { repo: "acme/repo", reviewHistory: history } } }));

test("legacy reviews migrate under registry write, preserving distinct versions and restart hydration", () => {
  const home = tempHome(), pending = record("pending"), intent = record("dispatch-intent"), done = record("dispatched");
  seed(home, [pending, intent, pending, pending, done, done]);
  const before = statSync(join(home, "state.json")).size, state = makeState(home);
  const committed = state.update("acme/repo/task", { marker: 1 });
  assert.ok(committed.reviewHistory.every(r => !r.evidence && r._gallivantReviewArchive));
  assert.ok(statSync(join(home, "state.json")).size < before / 20);
  const saved = state.get("acme/repo/task");
  assert.deepEqual(saved.reviewHistory.map(r => r.disposition.status), ["pending", "dispatch-intent", "pending", "dispatched"]);
  assert.ok(saved.reviewHistory.every(r => !r.evidence && r._gallivantReviewArchive));
  assert.deepEqual(makeState(home).reviewHistory("acme/repo/task"), [pending, intent, pending, done]);
  assert.equal(statSync(join(home, "reviews", "history")).mode & 0o777, 0o700);
  for (const name of readdirSync(join(home, "reviews", "history"))) assert.equal(statSync(join(home, "reviews", "history", name)).mode & 0o777, 0o600);
});

test("archive corruption and forged references fail closed without rewriting legacy state", () => {
  const home = tempHome(), state = makeState(home), id = "acme/repo/task";
  seed(home, [record("pending")]); state.update(id, { marker: 1 });
  const item = state.get(id).reviewHistory[0], file = join(home, "reviews", "history", `${item._gallivantReviewArchive.digest}.json`);
  writeFileSync(file, "corrupt");
  assert.throws(() => makeState(home).reviewHistory(id), { code: "REVIEW_HISTORY" });
  assert.throws(() => state.update(id, e => ({ reviewHistory: [{ ...e.reviewHistory[0], disposition: { status: "dispatched" } }] })), { code: "REVIEW_HISTORY" });
  assert.equal(state.get(id).reviewHistory[0].disposition.status, "pending");
  const bad = tempHome(), preexisting = record("pending"); seed(bad, [preexisting]);
  const initial = readFileSync(join(bad, "state.json"), "utf8"), history = join(bad, "reviews", "history");
  mkdirSync(history, { recursive: true });
  const digest = createHash("sha256").update(JSON.stringify(preexisting)).digest("hex");
  writeFileSync(join(history, `${digest}.json`), "partial archive file");
  assert.throws(() => makeState(bad).update(id, { marker: 1 }), { code: "REVIEW_HISTORY" });
  assert.equal(readFileSync(join(bad, "state.json"), "utf8"), initial);
  const forged = makeState(home).get(id); forged.reviewHistory[0]._gallivantReviewArchive.digest = "../../secret";
  assert.throws(() => state.update(id, { reviewHistory: forged.reviewHistory }), { code: "REVIEW_HISTORY" });
});

test("an interrupted temporary write cannot poison a later archive and registry commit", () => {
  const home = tempHome(), id = "acme/repo/task", evidence = record("pending"); seed(home, [evidence]);
  const history = join(home, "reviews", "history"); mkdirSync(history, { recursive: true });
  writeFileSync(join(history, ".pending-crashed-process"), "incomplete bytes");
  const state = makeState(home), returned = state.update(id, { marker: 1 });
  assert.equal(returned.reviewHistory[0].evidence, undefined);
  assert.deepEqual(makeState(home).reviewHistory(id), [evidence]);
});

test("two independent state writers retain updates and hydrate archived evidence", async () => {
  const home = tempHome(), id = "acme/repo/task", state = makeState(home);
  seed(home, [record("pending")]); state.update(id, { a: 0, b: 0 });
  const module = new URL("../lib/state.mjs", import.meta.url).href;
  const run = key => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {makeState} from ${JSON.stringify(module)};const s=makeState(process.argv[1]);for(let i=0;i<4;i++)s.update(process.argv[2],e=>({[process.argv[3]]:(e[process.argv[3]]||0)+1}));`, home, id, key], { stdio: "pipe" });
    let stderr = ""; child.stderr.on("data", x => { stderr += x; }); child.on("error", reject); child.on("exit", code => code ? reject(new Error(stderr)) : resolve());
  });
  await Promise.all([run("a"), run("b")]);
  const final = makeState(home); assert.equal(final.get(id).a, 4); assert.equal(final.get(id).b, 4);
  assert.deepEqual(final.reviewHistory(id), [record("pending")]);
});

test("an old lock held by a live migration owner is not stolen", async () => {
  const home = tempHome(), id = "acme/repo/task", lock = join(home, "state.json.lock"); seed(home, [record("pending")]);
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 60_000); utimesSync(lock, old, old);
  const module = new URL("../lib/state.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {makeState} from ${JSON.stringify(module)};const state=makeState(process.argv[1]);process.stdout.write("ready\\n",()=>state.update(process.argv[2],{marker:1}));`, home, id], { stdio: "pipe" });
  let exited = false, stderr = ""; child.stderr.on("data", x => { stderr += x; });
  const complete = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => { exited = true; code ? reject(new Error(stderr)) : resolve(); }); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  await new Promise(resolve => setTimeout(resolve, 350)); assert.equal(exited, false, "a live owner must retain the old lock");
  unlinkSync(lock); await complete;
  assert.equal(makeState(home).get(id).marker, 1);
});
