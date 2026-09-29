// The log is a convenience, not a dependency. A command that has already done its work and printed its verdict must
// not die because the place it keeps a copy of that warning is unwritable. This came from a real report: Codex ran
// `gallivant ready` inside a sandbox that refused writes outside the repository, the command did its job, printed the
// warning the operator needed, and then crashed on the append.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { makeLog } from "../lib/log.mjs";
import { tempHome } from "./helpers.mjs";

/** A home no process can create, which is what a sandbox denial looks like from inside the process. */
const DENIED = join(tempHome(), "not-a-directory");
writeFileSync(DENIED, "a file cannot contain errors.log");

const capture = () => { const lines = []; return { lines, stream: { write: l => { lines.push(l); return true; } } }; };

test("a warning still reaches the terminal when the log file cannot be written, and nothing throws", () => {
  const { lines, stream } = capture();
  const log = makeLog(DENIED, { stream });
  log.warn("the thing the operator needs to read");
  log.error("and an error after it");
  assert.ok(lines.some(l => l.includes("the thing the operator needs to read")), "the report itself is not lost");
  assert.ok(lines.some(l => l.includes("and an error after it")));
});

test("the unwritable log is reported once, not once per line", () => {
  const { lines, stream } = capture();
  const log = makeLog(DENIED, { stream });
  for (let i = 0; i < 5; i++) log.warn(`warning ${i}`);
  // A home that cannot be written stays that way for the whole run, so repeating the notice would bury the warnings
  // it sits among. Once is the notice; the warnings themselves still all arrive.
  assert.equal(lines.filter(l => l.includes("cannot write")).length, 1);
  assert.equal(lines.filter(l => /warn warning \d/.test(l)).length, 5);
});

test("latest() returns nothing rather than throwing when the log cannot be read", () => {
  // `status` calls this for its header, so an unreadable log must not break the whole view.
  assert.equal(makeLog(DENIED, { stream: capture().stream }).latest(), null);
});

test("with a writable home the log still records what it always did", () => {
  const home = tempHome();
  const log = makeLog(home, { stream: capture().stream });
  log.warn("recorded");
  log.error("also recorded");
  const text = readFileSync(join(home, "errors.log"), "utf8");
  assert.match(text, /warn recorded/);
  assert.match(text, /error also recorded/);
  assert.match(log.latest(), /error also recorded/, "latest is the newest line");
});

test("info never touches the file, because it is progress rather than a problem to look at later", () => {
  const home = tempHome();
  const log = makeLog(home, { stream: capture().stream });
  log.info("progress, not a problem");
  assert.equal(log.latest(), null);
});
