// The Request shape and the source registry. Two things are worth proving: the rules did not change when `check`
// stopped taking a parsed file, and `repo` is now a field the source supplies rather than something `start` derives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { check, RULES, rulesFor, appliesTo, kindOf, parsePrd } from "../lib/prd.mjs";
import { requestFor, adapterFor, ADAPTERS, prd as prdSource } from "../lib/sources/index.mjs";
import { tempHome, GOOD_PRD } from "./helpers.mjs";

const PRD_PATH = "/r/docs/prds/widget-export.md";
const failing = verdict => verdict.results.filter(r => !r.ok).map(r => r.id);

test("a parsed PRD is a Request: every field the shape names, with the PRD source kind", () => {
  const req = prdSource.request(GOOD_PRD, PRD_PATH);
  assert.deepEqual(req.source, { kind: "prd", url: null, author: null });
  assert.equal(kindOf(req), "prd");
  assert.equal(req.id, "widget-export");
  assert.equal(req.title, "Widget export to CSV");
  assert.equal(req.harness, "codex");
  assert.equal(req.status, "ready");
  assert.equal(req.raw, GOOD_PRD, "raw is the text as it arrived");
  assert.equal(req.repo, null, "repo is a field, unset until a source fills it in");
  for (const k of ["id", "repo", "title", "body", "harness", "status", "source", "raw"]) assert.ok(k in req, `${k} is part of the Request`);
});

test("the contract runs on a Request with no parsed file behind it, and the rules are unchanged", () => {
  // The same text and the same verdict, built by hand rather than read off disk. If `check` still reached for a
  // file this would throw, and if a rule had changed the failing list would differ from the file's.
  const fromFile = check(parsePrd(GOOD_PRD, PRD_PATH));
  const byHand = check({ ...prdSource.request(GOOD_PRD, PRD_PATH) });
  assert.deepEqual(byHand.results, fromFile.results);
  assert.equal(byHand.ok, true);
  assert.deepEqual(byHand.results.map(r => r.id), RULES.map(r => r.id), "every rule is reported, in the order RULES declares them");
});

test("path is the one rule scoped to a source kind; every other rule applies to all of them", () => {
  const pathRule = RULES.find(r => r.id === "path");
  assert.deepEqual(pathRule.kinds, ["prd"], "the rule carries its own scope as data");
  for (const r of RULES) if (r.id !== "path") assert.equal(r.kinds, undefined, `${r.id} is not scoped to a source kind`);
  assert.deepEqual(rulesFor("prd").map(r => r.id), RULES.map(r => r.id));
  assert.equal(appliesTo(pathRule, "prd"), true);
  assert.equal(appliesTo(pathRule, "other"), false);
});

test("the same brief from a source with no path gets the same verdict, minus the rule that needs one", () => {
  // The Request shape is what lets a second source be added without a second gate. Standing in for one here: the
  // identical brief, carrying a source kind the `path` rule is not scoped to. Every rule about what the brief says
  // must agree with the file source; only the rule about where it lives may differ.
  const file = prdSource.request(GOOD_PRD, PRD_PATH);
  const pathless = { ...file, path: null, source: { kind: "elsewhere", url: "https://example.test/brief", author: "someone" } };

  const fileVerdict = check(file);
  const pathlessVerdict = check(pathless);
  assert.equal(pathlessVerdict.ok, true, "a brief that passes as a file passes without one");
  assert.deepEqual(pathlessVerdict.results.map(r => r.id), RULES.filter(r => r.id !== "path").map(r => r.id));
  assert.deepEqual(
    pathlessVerdict.results,
    fileVerdict.results.filter(r => r.id !== "path"),
    "rule for rule, verdict and detail, the two agree on everything but path",
  );

  // And a failure is the same failure whichever source it came from.
  const broken = GOOD_PRD.replace("- PDF export.", "- TBD");
  assert.deepEqual(failing(check(prdSource.request(broken, PRD_PATH))), ["placeholders"]);
  assert.deepEqual(failing(check({ ...prdSource.request(broken, PRD_PATH), path: null, source: { kind: "elsewhere", url: null, author: null } })), ["placeholders"]);
});

test("a PRD source with no path fails the path rule instead of throwing", () => {
  const v = check({ ...prdSource.request(GOOD_PRD, PRD_PATH), path: null });
  assert.deepEqual(failing(v), ["path"]);
  assert.match(v.results.find(r => r.id === "path").detail, /no path on this request/);
});

test("the registry picks the PRD source for a path and refuses what nothing can read", async () => {
  assert.deepEqual(ADAPTERS.map(a => a.kind), ["prd"], "one source is built; the registry exists so another can be added");
  assert.equal(adapterFor("docs/prds/widget-export.md"), prdSource);
  assert.equal(adapterFor("./x.md"), prdSource);
  assert.equal(adapterFor("https://github.com/acme/widget/issues/7"), null, "a URL is not a path, and no source reads one");
  await assert.rejects(() => requestFor("https://example.test/x", {}), /nothing can read/);
});

test("the PRD source names the target repository, so start never has to work it out from the directory", async () => {
  const root = tempHome();
  const dir = join(root, "repo", "docs", "prds");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "widget-export.md");
  writeFileSync(path, GOOD_PRD);

  const asked = [];
  const git = { toplevel: async d => { asked.push(["toplevel", d]); return join(root, "repo"); } };
  const gh = { repoInfo: async d => { asked.push(["repoInfo", d]); return { nameWithOwner: "acme/widget", defaultBranch: "main" }; } };

  const req = await requestFor(path, { git, gh });
  assert.equal(req.repo, "acme/widget", "repo is owner/name on the Request");
  assert.equal(req.defaultBranch, "main");
  assert.equal(req.relPath, "docs/prds/widget-export.md", "and the path inside that checkout, for the copy into the session's clone");
  assert.equal(req.checkout, join(root, "repo"));
  assert.deepEqual(asked, [["toplevel", dir], ["repoInfo", join(root, "repo")]], "the source does the deriving, once");

  // Without git and gh there is still a Request; it just cannot name a repository.
  const bare = await requestFor(path, {});
  assert.equal(bare.repo, null);
  assert.equal(check(bare).ok, true, "the contract does not depend on knowing the repository");
  await assert.rejects(() => requestFor(join(dir, "missing.md"), {}), /cannot read/);
});
