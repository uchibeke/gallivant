// Every relative Markdown link in the operator-facing documentation resolves to a file in this checkout, every
// anchor to a heading in its target, and every link into this repository on github.com to a path that exists here.
// External links are checked by hand in the dated documentation audits; a test must not depend on another site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", ...readdirSync(join(root, "docs")).filter(f => f.endsWith(".md")).map(f => `docs/${f}`)];

/** GitHub's heading slug: lowercase, punctuation other than `-` and `_` dropped, spaces to hyphens, duplicates numbered. */
export function anchorsOf(markdown) {
  const seen = new Map(), out = new Set();
  // Inline code stays: GitHub slugs the text inside backticks. Only fenced blocks are dropped.
  for (const m of withoutFences(markdown).matchAll(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm)) {
    const text = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "");
    const slug = text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/g, "-");
    const n = seen.get(slug) || 0;
    seen.set(slug, n + 1);
    out.add(n ? `${slug}-${n}` : slug);
  }
  return out;
}

const withoutFences = text => text.replace(/```[\s\S]*?```/g, "");
const withoutCode = text => withoutFences(text).replace(/`[^`\n]*`/g, "");

export function linksOf(markdown) {
  return [...withoutCode(markdown).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(m => m[1]);
}

test("relative documentation links and anchors resolve inside this checkout", () => {
  const problems = [];
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    const own = anchorsOf(text);
    for (const link of linksOf(text)) {
      if (/^(?:mailto:|[a-z][a-z0-9+.-]*:\/\/)/i.test(link)) {
        const inRepo = link.match(/^https:\/\/github\.com\/uchibeke\/gallivant\/(?:blob|tree)\/main\/([^#?]+)/);
        if (inRepo && !existsSync(join(root, decodeURIComponent(inRepo[1])))) problems.push(`${file}: ${link} names a path this checkout does not have`);
        continue;
      }
      if (link.startsWith("#")) { if (!own.has(link.slice(1))) problems.push(`${file}: anchor ${link} has no heading`); continue; }
      const [path, anchor] = link.split("#");
      const target = resolve(dirname(join(root, file)), decodeURIComponent(path));
      if (!existsSync(target)) { problems.push(`${file}: ${link} does not exist`); continue; }
      if (anchor && target.endsWith(".md") && !anchorsOf(readFileSync(target, "utf8")).has(anchor)) problems.push(`${file}: ${link} has no heading #${anchor} in ${path}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("heading slugs follow GitHub's rules for code, punctuation and duplicates", () => {
  const a = anchorsOf("## `gallivant init [--harness codex|claude] [--worktrees <directory>]`\n### A. Setup?\n### A. Setup?\n## Hosted Agents API instead of a local CLI\n```\n# not a heading\n```\n");
  assert.deepEqual([...a], ["gallivant-init---harness-codexclaude---worktrees-directory", "a-setup", "a-setup-1", "hosted-agents-api-instead-of-a-local-cli"]);
  assert.deepEqual(linksOf("see [x](docs/a.md#b) and `[code](ignored.md)` and [y](https://example.com/p \"title\")"), ["docs/a.md#b", "https://example.com/p"]);
});
