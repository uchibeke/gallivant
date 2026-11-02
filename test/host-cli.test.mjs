import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_DELIVERABLE } from "../lib/config.mjs";
import { evaluate } from "../lib/deliverable.mjs";
import { tempHome } from "./helpers.mjs";

test("host CLI entry points satisfy the unchanged completion output policy", () => {
  for (const name of ["task-pr", "task-review"]) {
    const context = { summary: "Verified command output preserves complete JSON and raw diff payloads on standard output while reporting operation failures on standard error with unsuccessful exit status.",
      criteria_attestations: [{ criterion_id: "ac-1", met: true, evidence: "test/host-cli.test.mjs" }], tests_passing: true,
      output_content: readFileSync(new URL(`../bin/${name}.mjs`, import.meta.url), "utf8") };
    assert.deepEqual(evaluate({ context, limits: DEFAULT_DELIVERABLE, criteria: [{ id: "ac-1" }] }), { allow: true, denials: [] }, name);
  }
});

// Exercise the shipped entry points with local transport stubs. These tests
// verify CLI streams and exit status, never host access or reviewer qualification.
function cliFixture(t, name, result, fail = false) {
  const root = tempHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "lib", "hosts"), { recursive: true });
  const bin = join(root, "bin", `${name}.mjs`), input = join(root, "input.json");
  copyFileSync(new URL(`../bin/${name}.mjs`, import.meta.url), bin);
  writeFileSync(input, "{}");
  const operation = fail ? 'throw new Error("operation unavailable");' : `return ${JSON.stringify(result)};`;
  writeFileSync(join(root, "lib", "pr_operation.mjs"), `export async function prOperation() { ${operation} }`);
  writeFileSync(join(root, "lib", "hosts", "bitbucket_review_producer.mjs"), `export function makeBitbucketReviewProducer() { const run = async () => { ${operation} }; return { prepare: run, publish: run }; }`);
  return (action = "prepare") => spawnSync(process.execPath, [bin, ...(name === "task-pr" ? [] : [action, "--config", input, "--url", "https://bitbucket.org/acme/widget/pull-requests/7", "--input", input, "--result", input])],
    { encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
}

test("PR CLI preserves JSON, raw diff and empty results and separates failures from output", t => {
  for (const value of [{ number: 7, title: "50% complete" }, "diff --git a/a b/a\n+" + "unicode µ %s\n".repeat(5000), undefined]) {
    const result = cliFixture(t, "task-pr", value)();
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  }
  const failed = cliFixture(t, "task-pr", null, true)();
  assert.equal(failed.status, 1); assert.equal(failed.stdout, ""); assert.equal(failed.stderr, "operation unavailable\n");
});

test("review CLI emits complete prepare and publish JSON and separates failures from output", t => {
  for (const action of ["prepare", "publish"]) {
    const value = { head_sha: "a".repeat(40), summary: "Exact output µ %s", action };
    const result = cliFixture(t, "task-review", value)(action);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
    assert.equal(result.stdout, JSON.stringify(value, null, 2) + "\n");
    const failed = cliFixture(t, "task-review", null, true)(action);
    assert.equal(failed.status, 1); assert.equal(failed.stdout, ""); assert.equal(failed.stderr, "operation unavailable\n");
  }
});
