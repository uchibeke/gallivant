import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

test("the CLI ends at its dispatcher and contains no dynamic-code loader", () => {
  const path = new URL("../bin/gallivant.mjs", import.meta.url);
  const text = readFileSync(path, "utf8");
  // Check the source before executing it. The removed loader followed this statement on the same line.
  assert.match(text, /main\(process\.argv\.slice\(2\)\)\.then\(code => \{ process\.exitCode = code; \}, e => \{ console\.error\(`error: \$\{e\.message\}`\); process\.exitCode = 1; \}\);\s*$/);
  assert.doesNotMatch(text, /createRequire|\beval\s*\(|\bFunction\s*\(|global\s*[.[]/);
  const out = execFileSync(process.execPath, [path.pathname, "--help"], { encoding: "utf8", timeout: 5000 });
  assert.match(out, /^gallivant: write a PRD/);
  assert.match(out, /gallivant resume/);
});
