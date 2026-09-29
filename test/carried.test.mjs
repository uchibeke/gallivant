// The files a brief carries into the checkout.
//
// The gap these cover, from a live run: a brief cited three documents beside it, `start` copied only the brief, and the
// session stopped naming files it could not find. It behaved correctly and the run was wasted. The escape hatch did not
// reach either, because `context_paths` grants reads outside the worktree and `contextSupport` refuses that for codex
// and gemini and is a no-op for opencode and goose. Copying files in needs no flag from any harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parsePrd, check, contractOf, sourcePathsOf, sourceDivergence } from "../lib/prd.mjs";
import { parseSourcesMeta } from "../lib/config.mjs";
import { GOOD_PRD } from "./helpers.mjs";

/** A repo with a brief at docs/prds/brief.md and whatever supporting files the caller asks for. */
const repoWith = (files = {}, sources = []) => {
  const root = mkdtempSync(join(tmpdir(), "gallivant-carried-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  // Inserted after the harness line, whatever it names: GOOD_PRD's harness is not this test's business.
  const block = sources.length ? `${sources.map(s => `  - ${s}`).join("\n")}\n` : "";
  const text = GOOD_PRD.replace(/^(harness: .*)$/m, sources.length ? `$1\nsources:\n${block.trimEnd()}` : "$1");
  const path = join(root, "docs", "prds", "brief.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { root, path, text };
};

const sourcesResult = verdict => verdict.results.find(r => r.id === "sources");

test("a brief naming files that exist passes, and one naming a missing file is refused by name", () => {
  const ok = repoWith({ "docs/a.md": "# A", "AGENTS.md": "rules" }, ["docs/a.md", "AGENTS.md"]);
  assert.equal(sourcesResult(check(parsePrd(ok.text, ok.path))).ok, true);

  // The whole value of checking at `ready`: a mistyped path costs a second here and thirty minutes inside a run.
  const bad = repoWith({ "docs/a.md": "# A" }, ["docs/a.md", "docs/typo.md"]);
  const r = sourcesResult(check(parsePrd(bad.text, bad.path)));
  assert.equal(r.ok, false);
  assert.match(r.detail, /docs\/typo\.md is missing or unreadable/);
  assert.doesNotMatch(r.detail, /docs\/a\.md/, "the file that is fine is not named as a problem");
});

test("a path that could name something outside the repository is refused, one shape at a time", () => {
  // Each of these turns a manifest into something else, so each is refused with its own words rather than one generic
  // message: an operator who typed a glob and an operator who typed an absolute path made different mistakes.
  for (const [path, expected] of [
    ["/etc/passwd", /absolute/],
    ["../../secrets.md", /leaves the repository/],
    ["docs/*.md", /glob/],
    ["docs/", /directory/],
  ]) {
    const { problems } = parseSourcesMeta([path]);
    assert.equal(problems.length, 1, `${path} is refused`);
    assert.match(problems[0], expected);
  }
  // A glob is how a brief accidentally carries a `.env`, which is the reason globs are refused rather than expanded.
  assert.deepEqual(parseSourcesMeta(["**/.env"]).paths, []);
});

test("a binary file is refused, because a changed one could not be reported", () => {
  const r = repoWith({ "logo.png": "PNG\u0000binary" }, ["logo.png"]);
  const v = sourcesResult(check(parsePrd(r.text, r.path)));
  assert.equal(v.ok, false);
  assert.match(v.detail, /logo\.png is not text/);
});

test("a brief naming no files passes, and says so rather than reporting nothing", () => {
  const r = repoWith({}, []);
  const v = sourcesResult(check(parsePrd(r.text, r.path)));
  assert.equal(v.ok, true);
  assert.equal(v.detail, "none named");
});

test("frontmatter carries a block list, and a scalar key is unchanged by the parser that reads it", () => {
  // The block list is how a person writes a list of files. Before this, `sources:` read as the empty string and every
  // path was silently dropped, which is worse than a refusal: the operator's list is gone and nothing says so.
  const prd = parsePrd(["---", "status: ready", "harness: claude", "sources:", "  - docs/a.md", '  - "docs/b.md"', "---", "", "# A title here", ""].join("\n"), "/r/docs/prds/x.md");
  assert.deepEqual(prd.meta.sources, ["docs/a.md", "docs/b.md"], "quotes are stripped the same way a scalar's are");
  assert.equal(prd.meta.status, "ready", "a scalar beside a list is still a scalar");
  assert.equal(prd.meta.harness, "claude");

  // The bracketed form still works, because that is what `context_paths` has always accepted.
  const inline = parsePrd(["---", "status: ready", "harness: claude", "sources: [docs/a.md, docs/b.md]", "---", "", "# A title here", ""].join("\n"), "/r/docs/prds/x.md");
  assert.deepEqual(sourcePathsOf(inline), ["docs/a.md", "docs/b.md"]);
});

test("the list of carried files is part of the contract, so changing it is a contract change", () => {
  // Same reasoning as `context_paths`, which is already in the contract: changing the list changes what the session is
  // given. Adding a file hands it a document it was not judged against; removing one takes away something a criterion
  // may depend on. The CONTENTS are compared separately, by `sourceDivergence`.
  const one = repoWith({ "docs/a.md": "# A", "docs/b.md": "# B" }, ["docs/a.md"]);
  const two = repoWith({ "docs/a.md": "# A", "docs/b.md": "# B" }, ["docs/a.md", "docs/b.md"]);
  assert.deepEqual(contractOf(parsePrd(one.text, one.path)).sources, ["docs/a.md"]);
  assert.deepEqual(contractOf(parsePrd(two.text, two.path)).sources, ["docs/a.md", "docs/b.md"]);
  assert.notDeepEqual(contractOf(parsePrd(one.text, one.path)), contractOf(parsePrd(two.text, two.path)));
});

test("a carried file that was edited is reported changed, and one that is gone is reported missing", () => {
  // Two states rather than four, because nothing validates a document's shape. They are kept apart because they need
  // different words from the operator: a file that moved is a decision about which version is the brief, and a file
  // that is gone is a question about whether the work still stands.
  const root = mkdtempSync(join(tmpdir(), "gallivant-div-"));
  for (const rel of ["same.md", "moved.md", "gone.md"]) writeFileSync(join(root, rel), `original ${rel}`);
  const snapshots = { "same.md": "original same.md", "moved.md": "original moved.md", "gone.md": "original gone.md" };
  const entry = { checkout: root, sources: ["same.md", "moved.md", "gone.md"] };
  const readSource = (_id, rel) => snapshots[rel] ?? null;

  writeFileSync(join(root, "moved.md"), "edited after the snapshot");
  rmSync(join(root, "gone.md"));

  const d = sourceDivergence({ id: "x", entry, readSource });
  assert.deepEqual(d.changed, ["moved.md"]);
  assert.deepEqual(d.missing, ["gone.md"]);
  assert.deepEqual(d.checked, ["same.md", "moved.md", "gone.md"]);
});

test("an entry that carries nothing, or has no checkout, is compared without touching the filesystem", () => {
  // `register` and `reconcile` build entries with neither, so this is the common case rather than an edge one.
  const boom = () => { throw new Error("should not read"); };
  assert.deepEqual(sourceDivergence({ id: "x", entry: { checkout: "/nope", sources: [] }, readSource: boom, read: boom }).changed, []);
  assert.deepEqual(sourceDivergence({ id: "x", entry: { sources: ["a.md"] }, readSource: boom, read: boom }).changed, []);
  assert.deepEqual(sourceDivergence({ id: "x", entry: null, readSource: boom, read: boom }).checked, []);
});
