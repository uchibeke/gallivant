// The contract. It is the one gate: a brief that fails any rule cannot be marked ready and cannot start. There is no
// override flag. The rules are data so `ready --check` can print them as a checklist.
//
// `check` takes a Request (see lib/sources/) rather than a parsed file. Today the only Request comes from a PRD file,
// so every rule runs on every brief; the shape is what makes a second source possible without a second gate. One
// rule depends on where the brief lives rather than on what it says, and says so in its own data: `path` lists the
// source kinds it applies to. A rule with no `kinds` applies to every source.
import { basename } from "node:path";
import { HARNESSES, DEFAULT_HARNESS } from "./config.mjs";

export const RULES = Object.freeze([
  { id: "path", kinds: ["prd"], text: "lives under docs/prds/ with a lowercase-dash filename" },
  { id: "frontmatter", text: `frontmatter has status (draft|ready) and harness (${HARNESSES.join("|")})` },
  { id: "title", text: "one H1 title, 8 to 80 characters" },
  { id: "problem", text: "## Problem: at least 40 words on what is wrong today and for whom" },
  { id: "stories", text: "## User stories: every bullet reads 'As a <who>, I want <what>, so that <why>'" },
  { id: "criteria", text: "## Acceptance criteria: every bullet is Given / When / Then, at least one per story" },
  { id: "verify", text: "## Verify: at least one command the session must run green; no sudo, rm -rf or piped installers" },
  { id: "look", text: "## Where to look: files or directories to start from, or 'none'" },
  { id: "scope", text: "## Out of scope: at least one bullet" },
  { id: "placeholders", text: "no TODO, TBD, FIXME, ???, lorem or <angle-bracket> placeholders anywhere" },
  { id: "size", text: "under 1,500 words; a PRD is one pull request, split anything bigger" },
]);

/** The source a Request came from, defaulting to the PRD file so anything built before the shape existed still works. */
export const kindOf = req => req?.source?.kind ?? "prd";

/** Whether a rule applies to a source kind. A rule with no `kinds` applies to all of them. */
export const appliesTo = (rule, kind) => !rule.kinds || rule.kinds.includes(kind);

/** The rules a source of this kind is held to, in the order `RULES` declares them. */
export const rulesFor = kind => RULES.filter(r => appliesTo(r, kind));

export const REQUIRED_SECTIONS = ["Problem", "User stories", "Acceptance criteria", "Verify", "Where to look", "Out of scope"];

const STORY = /^as an? .+?, i want .+?, so that .+/i;
const GWT = /\bgiven\b[\s\S]*\bwhen\b[\s\S]*\bthen\b/i;
// `<who>`, `<your repo>`: angle-bracketed words. Inline HTML a PRD might legitimately carry is not a placeholder.
const HTML_TAGS = new Set(["a", "b", "i", "em", "strong", "code", "pre", "kbd", "br", "p", "div", "span", "ul", "ol", "li", "table", "tr", "td", "th", "thead", "tbody", "details", "summary", "sub", "sup", "img", "hr", "blockquote"]);
const PLACEHOLDER = /\b(TODO|TBD|FIXME|lorem ipsum)\b|\?\?\?|<([a-z][a-z-]*(?: [a-z-]+)*)>/gi;
export function findPlaceholder(text) {
  for (const m of String(text || "").matchAll(PLACEHOLDER)) {
    if (m[2] !== undefined && HTML_TAGS.has(m[2].toLowerCase())) continue;
    return m[0];
  }
  return null;
}
const DANGEROUS = /\bsudo\b|rm\s+-rf|curl[^|\n]*\|\s*(ba)?sh|wget[^|\n]*\|\s*(ba)?sh/i;
const MAX_WORDS = 1500;

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!m) return { meta: {}, body: text, hasFrontmatter: false, raw: null };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length), hasFrontmatter: true, raw: m[1] };
}

/** One fence grammar for the whole file: backtick or tilde fences of three or more, any info string. */
const FENCE = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;

/** The body with fenced code blocks blanked out (line count preserved), so `#` lines inside them are not headings. */
export const withoutFences = body => body.replace(FENCE, m => m.split("\n").map(() => "").join("\n"));

/** The contents of every fenced block, in order. */
export const fencedBlocks = text => [...String(text || "").matchAll(FENCE)].map(m => m[2].replace(/\n$/, ""));

/** Headings and the text under each, so a check can tell an empty section from a missing one. */
export function sections(body) {
  const out = {};
  let current = null;
  const masked = withoutFences(body).split("\n");
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const h = masked[i].match(/^##\s+(.+?)\s*$/);
    if (h) { current = h[1]; out[current] = ""; continue; }
    if (current !== null) out[current] += lines[i] + "\n";
  }
  return out;
}

export const bullets = text => (text || "").split("\n").filter(l => /^\s*[-*]\s+\S/.test(l)).map(l => l.replace(/^\s*[-*]\s+/, "").trim());

/** Bullets that span continuation lines (a Given on one line, When and Then indented below) joined into one. */
export function items(text) {
  const out = [];
  for (const line of (text || "").split("\n")) {
    if (/^\s*[-*]\s+\S/.test(line)) out.push(line.replace(/^\s*[-*]\s+/, "").trim());
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += " " + line.trim();
  }
  return out;
}

/**
 * A PRD file as a Request. Kept as the PRD source's parser and as the shape the tick's snapshot reader builds, so
 * everything that took a parsed PRD before the Request existed still works: a parsed PRD is a Request with
 * `source.kind` "prd". `text` stays alongside `raw` because the prompts and the tick read it by that name.
 */
export function parsePrd(text, path) {
  const { meta, body, hasFrontmatter } = parseFrontmatter(text);
  const titles = [...withoutFences(body).matchAll(/^#\s+(.+?)\s*$/gm)].map(m => m[1]);
  return {
    path,
    repo: null,
    id: basename(path).replace(/\.md$/, ""),
    status: meta.status || "draft",
    harness: meta.harness || DEFAULT_HARNESS,
    hasFrontmatter,
    meta,
    title: titles[0] || null,
    titles,
    body,
    sections: sections(body),
    text,
    raw: text,
    source: { kind: "prd", url: null, author: null },
    words: body.split(/\s+/).filter(Boolean).length,
  };
}

/** The `Verify` section as shell commands, from code blocks or backticked bullets. Takes any Request. */
export function verifyCommands(prd) {
  const v = prd.sections["Verify"] || "";
  const fromBlocks = fencedBlocks(v).flatMap(b => b.split("\n"));
  const fromBullets = bullets(v).map(b => b.replace(/^`|`$/g, ""));
  return [...fromBlocks, ...fromBullets].map(s => s.trim()).filter(s => s && !s.startsWith("#") && s.toLowerCase() !== "none");
}

/**
 * Every rule that applies to this Request's source, with its verdict. `ok` is true only when all pass. Details are
 * written so the operator knows what to change, not just which rule fired. A rule this source cannot be held to is
 * not reported at all, rather than reported as a failure it can do nothing about.
 */
export function check(prd) {
  const s = prd.sections;
  const kind = kindOf(prd);
  const has = name => name in s;
  const results = [];
  const rule = (id, ok, detail = "") => {
    const r = RULES.find(x => x.id === id);
    if (appliesTo(r, kind)) results.push({ id, text: r.text, ok, detail });
  };

  if (typeof prd.path === "string") {
    const posix = prd.path.replace(/\\/g, "/");
    rule("path", /(^|\/)docs\/prds\/[a-z0-9][a-z0-9-]*\.md$/.test(posix),
      /docs\/prds\//.test(posix) ? `filename "${basename(prd.path)}" must be lowercase letters, digits and dashes` : "move it to docs/prds/<id>.md in the target repo");
  } else {
    rule("path", false, "no path on this request; the PRD source supplies one");
  }

  const statusOk = ["draft", "ready"].includes(prd.meta.status);
  const harnessOk = !("harness" in prd.meta) || HARNESSES.includes(prd.meta.harness);
  rule("frontmatter", prd.hasFrontmatter && statusOk && harnessOk,
    !prd.hasFrontmatter ? "add a --- block with status: draft and harness: claude" : !statusOk ? `status "${prd.meta.status}" must be draft or ready` : `harness "${prd.meta.harness}" must be one of ${HARNESSES.join(", ")}`);

  rule("title", prd.titles.length === 1 && prd.title.length >= 8 && prd.title.length <= 80,
    prd.titles.length !== 1 ? `${prd.titles.length} H1 headings; exactly one` : `title is ${prd.title.length} characters`);

  const problemWords = (s["Problem"] || "").split(/\s+/).filter(Boolean).length;
  rule("problem", has("Problem") && problemWords >= 40, !has("Problem") ? "section missing" : `${problemWords} words; say what is wrong today, for whom, and what changes when this ships`);

  const stories = items(s["User stories"]);
  const badStories = stories.filter(x => !STORY.test(x));
  rule("stories", has("User stories") && stories.length >= 1 && badStories.length === 0,
    !has("User stories") ? "section missing" : stories.length === 0 ? "no bullets" : `${badStories.length} bullet(s) do not follow the form: "${badStories[0]?.slice(0, 60)}"`);

  const criteria = items(s["Acceptance criteria"]);
  const badCriteria = criteria.filter(x => !GWT.test(x));
  rule("criteria", has("Acceptance criteria") && criteria.length >= Math.max(1, stories.length) && badCriteria.length === 0,
    !has("Acceptance criteria") ? "section missing" : criteria.length < Math.max(1, stories.length) ? `${criteria.length} criteria for ${stories.length} stories; at least one each` : `${badCriteria.length} bullet(s) lack Given/When/Then: "${badCriteria[0]?.slice(0, 60)}"`);

  const verify = has("Verify") ? verifyCommands(prd) : [];
  const dangerous = verify.filter(c => DANGEROUS.test(c));
  rule("verify", has("Verify") && verify.length >= 1 && dangerous.length === 0,
    !has("Verify") ? "section missing" : verify.length === 0 ? "list at least one command in backticks or a code block" : `refusing: "${dangerous[0]}"`);

  const look = bullets(s["Where to look"]);
  rule("look", has("Where to look") && look.length >= 1, !has("Where to look") ? "section missing" : "list files or directories to start from, or a single bullet: none");

  rule("scope", has("Out of scope") && bullets(s["Out of scope"]).length >= 1, !has("Out of scope") ? "section missing" : "at least one bullet naming what this PRD will not do");

  const ph = findPlaceholder(prd.body);
  rule("placeholders", !ph, ph ? `found "${ph}"` : "");

  rule("size", prd.words <= MAX_WORDS, `${prd.words} words`);

  return { ok: results.every(r => r.ok), results };
}

export function renderCheck(prd, { ok, results }) {
  const lines = results.map(r => `${r.ok ? "ok  " : "FAIL"} ${r.id.padEnd(13)} ${r.ok ? r.text : `${r.text}\n       ${r.detail}`}`);
  lines.push("", ok ? `${prd.id}: ready to start.` : `${prd.id}: ${results.filter(r => !r.ok).length} rule(s) failed; not ready.`);
  return lines.join("\n");
}

/** Set or replace one frontmatter key, creating the block when the file has none. Rebuilds from the parsed block. */
export function withFrontmatterKey(text, key, value) {
  const { hasFrontmatter, raw, body } = parseFrontmatter(text);
  if (!hasFrontmatter) return `---\n${key}: ${value}\n---\n\n${text}`;
  const re = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:.*$`, "m");
  const next = re.test(raw) ? raw.replace(re, `${key}: ${value}`) : `${raw}\n${key}: ${value}`;
  return `---\n${next}\n---\n${body}`;
}

/** Flip status in the frontmatter, adding a default harness when the file had no frontmatter at all. */
export function withStatus(text, status) {
  const { hasFrontmatter } = parseFrontmatter(text);
  const base = hasFrontmatter ? text : withFrontmatterKey(text, "harness", DEFAULT_HARNESS);
  return withFrontmatterKey(base, "status", status);
}

/**
 * Take the daemon's own snapshot of a brief from the PR branch, unless it already has one. The snapshot is what fix
 * rounds and the completion gate read, so an entry without one skips every acceptance criterion: `register` and
 * `reconcile` both have to take it, and they take it the same way, from here.
 *
 * Never throws, because for both callers the snapshot is not what makes the PR watchable. `register` has already put
 * the entry in the registry, and `reconcile` runs before the daemon's first tick and outside its catch, so an error
 * escaping here would abort a registration that succeeded or take the daemon down before it watched anything. A path
 * the branch does not carry, an unreachable GitHub and an unwritable home all come back as false with the reason in
 * the log; the completion gate is skipped until a later boot takes it.
 *
 * The copy on the branch was writable by the session, which the log says.
 */
export async function ensurePrdSnapshot(ctx, { id, repo, path, ref }) {
  const { gh, log, readPrd, writePrd } = ctx;
  try {
    if (!path || readPrd(id)) return false;
    const text = await gh.fileAt(repo, path, ref);
    if (!text) { log.warn(`${id}: ${path} not found on ${ref}; the completion gate is skipped until a snapshot exists`); return false; }
    writePrd(id, text);
    log.warn(`${id}: PRD snapshot taken from the PR branch (${path}); the session could have edited it`);
    return true;
  } catch (e) {
    log.warn(`${id}: PRD snapshot not taken: ${e.message}`);
    return false;
  }
}
