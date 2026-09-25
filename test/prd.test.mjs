import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrd, check, withStatus, RULES, items } from "../lib/prd.mjs";
import { GOOD_PRD } from "./helpers.mjs";

const at = (path = "/r/docs/prds/widget-export.md", text = GOOD_PRD) => check(parsePrd(text, path));
const failing = verdict => verdict.results.filter(r => !r.ok).map(r => r.id);
const edit = (from, to) => GOOD_PRD.replace(from, to);

test("the good PRD passes every rule, and every rule is reported", () => {
  const v = at();
  assert.equal(v.ok, true);
  assert.deepEqual(v.results.map(r => r.id), RULES.map(r => r.id));
});

test("path: must live under docs/prds with a lowercase-dash name", () => {
  assert.deepEqual(failing(at("/r/_plan/widget-export.md")), ["path"]);
  assert.deepEqual(failing(at("/r/docs/prds/Widget Export.md")), ["path"]);
});

test("frontmatter: status and harness are validated; a missing block fails", () => {
  assert.deepEqual(failing(at(undefined, edit("status: ready", "status: done"))), ["frontmatter"]);
  assert.deepEqual(failing(at(undefined, edit("harness: codex", "harness: bash"))), ["frontmatter"]);
  assert.deepEqual(failing(at(undefined, GOOD_PRD.replace(/^---\n[\s\S]*?\n---\n/, ""))), ["frontmatter"]);
});

test("stories must follow As a / I want / so that; criteria must be Given / When / Then, one per story", () => {
  assert.deepEqual(failing(at(undefined, edit("so that I can reconcile spend in a spreadsheet", "because"))), ["stories"]);
  assert.deepEqual(failing(at(undefined, edit("then a CSV with three rows downloads", "a CSV downloads"))), ["criteria"]);
  const twoStories = edit("## Acceptance criteria", "- As a viewer, I want a preview, so that I trust the file.\n\n## Acceptance criteria")
    .replace("- Given an empty workspace, when I click Export,\n  then the button is disabled and a hint explains why.\n", "");
  assert.deepEqual(failing(at(undefined, twoStories)), ["criteria"]);
});

test("verify needs a command and refuses dangerous ones; look and scope need a bullet", () => {
  assert.deepEqual(failing(at(undefined, edit("- `npm test`\n```sh\nnpm run lint\n```", "run the tests"))), ["verify"]);
  assert.deepEqual(failing(at(undefined, edit("- `npm test`", "- `sudo npm test`"))), ["verify"]);
  assert.deepEqual(failing(at(undefined, edit("- `src/export/`", ""))), ["look"]);
  assert.deepEqual(failing(at(undefined, edit("- PDF export.", ""))), ["scope"]);
});

test("placeholders and size", () => {
  assert.deepEqual(failing(at(undefined, edit("- PDF export.", "- TBD"))), ["placeholders"]);
  assert.deepEqual(failing(at(undefined, edit("- PDF export.", "- <something>"))), ["placeholders"]);
  assert.deepEqual(failing(at(undefined, GOOD_PRD + "\n" + "word ".repeat(1500))), ["size"]);
});

test("a # comment inside a Verify code block is not a second title", () => {
  const withComment = GOOD_PRD.replace("```sh\nnpm run lint\n```", "```sh\n# run the linter\nnpm run lint\n```");
  assert.equal(check(parsePrd(withComment, "/r/docs/prds/widget-export.md")).ok, true);
});

test("problem needs forty words; a missing section names itself", () => {
  const short = GOOD_PRD.replace(/## Problem\n\n[\s\S]*?\n\n## User stories/, "## Problem\n\nToo short.\n\n## User stories");
  const v = at(undefined, short);
  assert.deepEqual(failing(v), ["problem"]);
  assert.match(v.results.find(r => r.id === "problem").detail, /2 words/);
  const gone = GOOD_PRD.replace(/## Where to look\n\n- `src\/export\/`\n\n/, "");
  assert.match(at(undefined, gone).results.find(r => r.id === "look").detail, /section missing/);
});

test("lint sentences and status flipping", () => {
  const draft = withStatus(GOOD_PRD.replace("status: ready", "status: draft"), "ready");
  assert.match(draft, /^---\nstatus: ready\nharness: codex\n---/);
  assert.match(withStatus("# No frontmatter\n", "ready"), /^---\nharness: claude\nstatus: ready\n---/);
  assert.deepEqual(items("- Given x, when y,\n  then z.\n- Given a, when b, then c."), ["Given x, when y, then z.", "Given a, when b, then c."]);
});
