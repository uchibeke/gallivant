// The contract. It is the one gate: a brief that fails any rule cannot be marked ready and cannot start. There is no
// override flag. The rules are data so `ready --check` can print them as a checklist.
//
// `check` takes a Request (see lib/sources/) rather than a parsed file. Today the only Request comes from a PRD file,
// so every rule runs on every brief; the shape is what makes a second source possible without a second gate. One
// rule depends on where the brief lives rather than on what it says, and says so in its own data: `path` lists the
// source kinds it applies to. A rule with no `kinds` applies to every source.
import { basename, dirname, join, resolve } from "node:path";
import { HARNESSES, DEFAULT_HARNESS, parseContextPathsMeta, parseSourcesMeta } from "./config.mjs";
import { shortHash } from "./hash.mjs";
import { readText } from "./fs.mjs";
import { readRepositoryText } from "./repository_files.mjs";
import { OWNER_DELIVERY_SECTION, ownerDeliveryFromPrd } from "./owner_delivery.mjs";
import { DELIVERY_PROFILE_SECTION, deliveryProfileFromPrd } from "./task_profile.mjs";

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
  // Scoped to `prd` because it resolves paths against the checkout the brief lives in, and only a PRD source has one.
  { id: "sources", kinds: ["prd"], text: "every file in `sources` exists, is readable text, and is named inside the repository" },
]);

/** The source a Request came from, defaulting to the PRD file so anything built before the shape existed still works. */
export const kindOf = req => req?.source?.kind ?? "prd";

/** Whether a rule applies to a source kind. A rule with no `kinds` applies to all of them. */
export const appliesTo = (rule, kind) => !rule.kinds || rule.kinds.includes(kind);

/** The rules a source of this kind is held to, in the order `RULES` declares them. */
export const rulesFor = kind => RULES.filter(r => appliesTo(r, kind));

/**
 * A PRD id: lowercase letters, digits and dashes, which is what the `path` rule accepts and therefore the only
 * shape a brief's filename, its branch and its run folder can share. One implementation because there were three,
 * in `commands/new.mjs`, `commands/register.mjs` and `run.mjs`, agreeing on every input anyone happened to try.
 * That is the expensive kind of duplication: a fix to one is invisibly absent from the others. `max` is for the run
 * folder, whose name is a filesystem path segment and so has a length to respect; a brief's id is not truncated,
 * because silently shortening a name the operator typed makes the file they asked for not the file they get.
 */
export const toPrdId = (value, { max = 0 } = {}) => {
  const slug = basename(String(value ?? ""), ".md").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return max > 0 ? slug.slice(0, max) : slug;
};

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
export const MAX_WORDS = 1500;

/**
 * `\r?\n` throughout, because a brief saved by an editor on Windows or touched by a `.gitattributes` rule has CRLF line
 * endings and is the same brief. It used to match `\n` only, which meant a CRLF copy parsed as having NO frontmatter at
 * all: `status` and `harness` fell back to their defaults and `ready` refused the file for a frontmatter block that was
 * right there. That was survivable while `ready` was the only reader, because the operator was standing in front of it.
 * It stopped being survivable when the brief started being compared against a running entry's snapshot: a line-ending
 * rewrite read as the harness changing and the frontmatter rule failing, so a healthy run stopped and blamed the wrong
 * thing entirely.
 */
export function parseFrontmatter(text) {
  const m = String(text ?? "").match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { meta: {}, body: text, hasFrontmatter: false, raw: null };
  const meta = {};
  // One key per line, plus the block-list shape, because that is how a person writes a list of files:
  //
  //     sources:
  //       - docs/a.md
  //       - docs/b.md
  //
  // Without the second half, `sources:` reads as the empty string and every path is silently dropped, which is worse
  // than refusing the brief: the operator's list is gone and nothing says so. A key whose value is empty and whose
  // following lines are `- ` items collects them into an array; anything else keeps the old one-line behaviour, so
  // `context_paths: [a, b]` and every existing brief parse exactly as before.
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const value = kv[2].trim().replace(/^["']|["']$/g, "");
    if (value === "") {
      const items = [];
      while (i + 1 < lines.length) {
        const item = lines[i + 1].match(/^\s+-\s*(.*)$/);
        if (!item) break;
        const one = item[1].trim().replace(/^["']|["']$/g, "");
        if (one) items.push(one);
        i++;
      }
      if (items.length) { meta[kv[1]] = items; continue; }
    }
    meta[kv[1]] = value;
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

/**
 * `[{ id: "ac-1", description }]` from the Acceptance criteria bullets, in order, ids stable by position.
 *
 * It lived in `deliverable.mjs` while the completion gate was its only reader, and it still carries the gate's own id
 * shape because the receipt on every open PR names those ids. It is here now because the divergence check below
 * compares this list and `verifyCommands` and nothing else, and those two ARE the contract: one of them cannot live in
 * a module that imports this one. `deliverable.mjs` re-exports it, so every caller keeps the import it had.
 */
export const criteriaFromPrd = prd => items(prd.sections["Acceptance criteria"]).map((description, i) => ({ id: `ac-${i + 1}`, description }));

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
/**
 * The files a brief carries, as a list of repository-relative paths. One accessor so `start`, the prompt and the
 * contract rule can never disagree about what a brief declared: the rule below refuses anything this returns that
 * cannot be read, so every caller after it may assume the list is legal.
 */
export const sourcePathsOf = prd => parseSourcesMeta(prd?.meta?.sources).paths;

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
  let ownershipError = ""; try { ownerDeliveryFromPrd(prd); deliveryProfileFromPrd(prd); } catch (error) { ownershipError = error.message; }
  rule("criteria", has("Acceptance criteria") && criteria.length >= Math.max(1, stories.length) && badCriteria.length === 0 && !ownershipError,
    ownershipError || (!has("Acceptance criteria") ? "section missing" : criteria.length < Math.max(1, stories.length) ? `${criteria.length} criteria for ${stories.length} stories; at least one each` : `${badCriteria.length} bullet(s) lack Given/When/Then: "${badCriteria[0]?.slice(0, 60)}"`));

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

  // The files the brief carries. Checked here rather than at `start` for the reason `resolveBase` validates the base
  // early: a mistyped path costs a second at the operator's terminal and thirty minutes inside a paid session. The read
  // is what makes it worth checking at all, since a path that parses and does not exist is the common mistake.
  const { paths: sourcePaths, problems: sourceProblems } = parseSourcesMeta(prd.meta?.sources);
  if (sourcePaths.length || sourceProblems.length) {
    const missing = [];
    // Paths are relative to the repository root, and the brief's own path gives it: the `path` rule above requires
    // `docs/prds/<id>.md`, so the root is two directories up. `prd.checkout` is the same answer when a Request has one,
    // but `gallivant ready` deliberately builds a Request without git access (see lib/sources/prd.mjs), and a rule that
    // could only run under the daemon would miss the moment the operator is standing there to fix it.
    const root = prd.checkout ?? (typeof prd.path === "string" ? resolve(dirname(prd.path), "..", "..") : null);
    for (const rel of root ? sourcePaths : []) {
      try {
        const text = readRepositoryText(root, rel);
        if (text.includes("\u0000")) missing.push(`${rel} is not text`);
      } catch (e) { missing.push(`${rel} is missing or unreadable: ${e.message}`); }
    }
    const detail = [...sourceProblems, ...missing];
    if (!root && sourcePaths.length) detail.push("no path on this request, so the files could not be resolved");
    rule("sources", detail.length === 0, detail.join("; "));
  } else {
    rule("sources", true, "none named");
  }

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

// ---- The brief's contract, and what it means for it to change under a running entry --------------------------------
//
// `start` snapshots the brief into ~/.gallivant/prds/<id>.md and the completion gate reads only that, so a session
// cannot widen its own acceptance criteria. That stays. What was missing is that nothing compared the snapshot to the
// operator's own copy, so an operator who edited `docs/prds/thing.md` after starting got a PR certified against a brief
// they had abandoned, silently.
//
// The comparison is expressed in the contract's own terms and nothing else: `criteriaFromPrd` and `verifyCommands` are
// what the gate judges and what the prompts carry, and `context_paths` is what the snapshot's frontmatter grants a
// session to read. A brief where all three match is a brief the work in flight is still against, whatever else moved.

/**
 * The parts of a brief that decide what the work is and what the gate will judge. Everything else about the file
 * (the Problem prose, the stories, Out of scope, the title, the word count) can be rewritten without changing what
 * anyone is being asked to build or what will be checked, which is the whole reason this is a list and not the file.
 *
 * `harness` is in it because a brief that names a different harness cannot be honoured by a running entry at all: the
 * session belongs to the old one. `context_paths` is in it because `resolveContextPaths` reads it off the snapshot to
 * decide what a fix round may read, so changing it changes the session's reach, which is a contract change even though
 * no criterion moved.
 */
export const contractOf = prd => ({
  // Typed stage ownership changes what provider receipts must attest. Preserve
  // legacy fingerprints exactly; new contracts include even malformed edits.
  ...(prd.sections[OWNER_DELIVERY_SECTION] !== undefined ? { ownerDelivery: prd.sections[OWNER_DELIVERY_SECTION].replaceAll("\r\n", "\n") } : {}),
  // The typed delivery profile is part of the contract for the same reason:
  // editing it changes which external action the coordinator may take.
  ...(prd.sections[DELIVERY_PROFILE_SECTION] !== undefined ? { deliveryProfile: prd.sections[DELIVERY_PROFILE_SECTION].replaceAll("\r\n", "\n") } : {}),
  // `id: description`, not the descriptions alone, and the id is the load-bearing half. `criteriaFromPrd` numbers
  // criteria BY POSITION (`ac-1`, `ac-2`), and the completion receipt on the open pull request attests those ids: an
  // attestation says `ac-1` is met, with evidence, and the gate matches it to whatever the brief's first criterion is
  // NOW. So reordering two criteria without touching a word of either one swaps what both ids mean, and the receipt
  // already on the PR then attests each criterion with the other's evidence, which the gate allows. Compared by
  // description alone, that edit looked like no change at all.
  criteria: criteriaFromPrd(prd).map(c => `${c.id}: ${c.description}`),
  verify: verifyCommands(prd),
  harness: prd.harness ?? null,
  context_paths: parseContextPathsMeta(prd.meta?.context_paths),
  // The files the brief carries, on the same reasoning as `context_paths` one line up: changing the list changes what
  // the session is given, so it is a contract change even though no criterion moved. Adding a file hands the session a
  // document it was not judged against; removing one takes away something a criterion may depend on.
  //
  // The list, not the contents. A carried file's bytes are compared separately by `sourceDivergence`, because a diff of
  // a document belongs next to that document and not in a summary of the brief's contract.
  sources: sourcePathsOf(prd),
});

/**
 * Twelve hex characters over the contract, through the one `shortHash` the receipt cursor already uses. Stored on the
 * entry at snapshot time so a later comparison is a string equality rather than a re-parse of two files, and so
 * `status` can say "the brief moved" without reading the operator's tree at all when it is not there to read.
 *
 * The fingerprint is of the CONTRACT and not of the text, deliberately. A fingerprint of the file would fire on a
 * typo fix, and an entry stopped for a typo fix is an entry whose operator learns to ignore this.
 */
export const prdFingerprint = prd => (prd ? shortHash(JSON.stringify(contractOf(prd))) : null);

/** The `aport_decision` the brief carries, which `ready` writes when it flips a brief to ready. */
export const prdDecision = prd => prd?.meta?.aport_decision ?? null;

/**
 * Whether two briefs have the same contract. The fingerprint is the authority on this, and `contractDiff` below is only
 * the explanation of it.
 *
 * Keeping the two jobs apart is not tidiness, it is the fix for a whole class of false negative. A diff has to describe
 * a change in a way a person can act on, which means grouping and set arithmetic, and set arithmetic loses information:
 * it cannot see a duplicate. Add a second `- \`npm test\`` to the Verify section and every element of both lists is
 * present in the other, so a set-based diff is empty while the list the session must run green has changed. The reorder
 * case was the same shape, and it got a targeted fix (the ids in `contractOf`); a targeted fix per shape is a bug per
 * shape nobody has thought of yet. So the verdict asks "is this the same contract", which is exactly what a hash of the
 * whole ordered structure answers, and the diff is allowed to be lossy because nothing decides anything on it.
 */
export const sameContract = (before, after) => prdFingerprint(before) === prdFingerprint(after);

/**
 * What changed between two briefs, in contract terms, as text an operator can act on.
 *
 * Each line names the specific difference rather than saying "the criteria changed", because the operator's next
 * question is always which one, and the answer is cheap to compute here and expensive to go and find by hand.
 *
 * It is NOT what decides whether the contract moved: see `sameContract`. It can be empty for a contract that really did
 * change (a duplicated Verify command is the case that proves it), which is why every caller that needs a verdict takes
 * it from the fingerprint and uses this only to explain one. When it has nothing to say about a contract that moved, the
 * caller says so in as many words rather than reporting no difference.
 */
export function contractDiff(before, after) {
  const a = contractOf(before);
  const b = contractOf(after);
  const out = [];
  if (a.ownerDelivery !== b.ownerDelivery) out.push("coordinator delivery ownership contract changed");
  if (a.deliveryProfile !== b.deliveryProfile) out.push("typed delivery profile changed");
  // Multiplicity-aware, so a duplicate that IS reported is reported once per copy rather than swallowed. It still cannot
  // describe every change on its own, which is `sameContract`'s job; this only makes the description less lossy.
  const listDiff = (was, now) => {
    const count = xs => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
    const [ca, cb] = [count(was), count(now)];
    const gone = [], added = [];
    for (const [x, n] of ca) for (let i = 0; i < n - (cb.get(x) ?? 0); i++) gone.push(x);
    for (const [x, n] of cb) for (let i = 0; i < n - (ca.get(x) ?? 0); i++) added.push(x);
    return { gone, added };
  };

  // The criteria carry their positional ids, so a reorder shows up here as the two ids each gaining the other's text,
  // which is exactly what happened and exactly what breaks a receipt that has already attested them. `id: text` is left
  // in the line rather than stripped, because the id is what the receipt on the pull request names and therefore what
  // the operator has to reason about.
  const crit = listDiff(a.criteria, b.criteria);
  for (const c of crit.gone) out.push(`acceptance criterion removed, reworded or renumbered: "${c}"`);
  for (const c of crit.added) out.push(`acceptance criterion added, reworded or renumbered: "${c}"`);
  const ver = listDiff(a.verify, b.verify);
  for (const c of ver.gone) out.push(`Verify command removed: \`${c}\``);
  for (const c of ver.added) out.push(`Verify command added: \`${c}\``);
  if (a.harness !== b.harness) out.push(`harness changed from ${a.harness} to ${b.harness}; the session in flight belongs to ${a.harness}`);
  const ctxp = listDiff(a.context_paths, b.context_paths);
  for (const p of ctxp.gone) out.push(`context_paths entry removed: ${p}`);
  for (const p of ctxp.added) out.push(`context_paths entry added: ${p}`);
  const sources = listDiff(a.sources, b.sources);
  for (const p of sources.gone) out.push(`source removed: ${p}`);
  for (const p of sources.added) out.push(`source added: ${p}`);
  return out;
}

/**
 * Compare the daemon's snapshot with the brief in the operator's own checkout, and say what should happen.
 *
 * `verdict` is one of four, and each of them is a different action because guessing between them is expensive in both
 * directions:
 *
 * - `same`: the files are byte-identical, or they differ only outside the contract. Nothing has to happen. The caller
 *   may re-snapshot so the session's own reads follow the operator's prose edits, and no human is told, because
 *   stopping an entry for a reworded Problem section throws away paid work for nothing.
 * - `changed`: the contract moved. The criteria set, a Verify command, the harness or `context_paths` is not what the
 *   work in flight was started against. The daemon cannot tell a brief that was TIGHTENED (a criterion added; the work
 *   is valid but incomplete) from one that was INVALIDATED (a criterion rewritten so what was built is no longer
 *   wanted), and it must not guess: finishing against the old brief certifies something nobody asked for, and
 *   restarting against the new one throws away work that may still be exactly right. So a person decides, with the
 *   difference named.
 * - `illegal`: the operator's copy no longer passes the contract `start` holds every brief to. There is nothing safe to
 *   re-snapshot, because a snapshot is what the gate judges and an illegal brief behind the gate is worse than a stale
 *   one. Reported whether or not the contract itself moved: an edit that leaves the criteria alone and introduces a
 *   `TODO` is still a brief `start` would have refused.
 * - `gone`: the brief is not in the operator's checkout any more, deleted or moved. Not a silent continue: a brief the
 *   operator deleted is a brief nobody is asking for. Not a re-snapshot either, since there is nothing to snapshot.
 *
 * `unknown` is the fifth answer and is not a verdict at all: no snapshot, no recorded checkout, or a checkout that is
 * not on this machine. It means "no comparison was possible", and every caller treats it as "carry on", because an
 * entry recovered from GitHub by `reconcile` never saw the operator's tree and must not be stopped for that.
 *
 * Pure but for one read: `readText` on the operator's file. It takes `readPrd` and `readText` from the caller so the
 * whole thing runs under `node --test` with no filesystem.
 */
/**
 * Which carried files have changed since the snapshot, as a list of relative paths.
 *
 * Separate from `prdDivergence` because the two answer different questions and a caller wants both. The brief's own
 * divergence has four verdicts, because a brief can stop passing the contract; a carried document has two states, the
 * snapshot's bytes or not, since nothing validates its shape. Folding them together would mean inventing a verdict for
 * "the brief is fine and a document it cites moved", which is the case this returns plainly instead.
 *
 * The comparison is on bytes, not on a fingerprint, for the same reason `prdDivergence` compares text before parsing:
 * there is nothing to parse, and a hash would only save reading a file that has to be read anyway to report the change.
 *
 * `missing` is kept apart from `changed` because they need different words from the operator: a file that moved is a
 * decision about which version is the brief, and a file that is gone is a question about whether the work still stands.
 */
export function sourceDivergence({ id, entry, readSource, read = null }) {
  const rel = sourcePathsOf({ meta: { sources: entry?.sources } });
  const checkout = entry?.checkout ?? null;
  if (!rel.length || !checkout || !readSource) return { changed: [], missing: [], checked: [] };
  const changed = [];
  const missing = [];
  for (const one of rel) {
    const snapshot = readSource(id, one);
    if (snapshot == null) { missing.push(one); continue; }
    let now = null;
    try { now = read ? read(join(checkout, one)) : readRepositoryText(checkout, one); } catch { /* missing or unsafe */ }
    if (now === null) missing.push(one);
    else if (now !== snapshot) changed.push(one);
  }
  return { changed, missing, checked: rel };
}

export const sourceDiff = d => [...d.changed.map(p => `source changed: ${p}`), ...d.missing.map(p => `source missing or unreadable: ${p}`)];

/** The readiness and status views must compare the same brief, including its supporting files. */
export function briefDivergence(args) {
  const prd = prdDivergence(args);
  const diff = sourceDiff(sourceDivergence(args));
  if (!diff.length) return prd;
  if (divergenceReason(prd)) return { ...prd, diff: [...prd.diff, ...diff] };
  return { ...prd, verdict: "changed", why: "carried files differ from the snapshot", diff };
}

export function prdDivergence({ id, entry, readPrd, read = readText }) {
  const snapshotText = readPrd(id);
  const rel = entry?.prd ?? null;
  const checkout = entry?.checkout ?? null;
  if (!snapshotText) return { verdict: "unknown", why: "no PRD snapshot on disk", diff: [], path: null };
  if (!checkout || !rel) return { verdict: "unknown", why: "no operator checkout recorded for this entry", diff: [], path: null };

  const path = join(checkout, rel);
  const repoText = read(path);
  if (repoText === null) return { verdict: "gone", why: `${path} is not there any more`, diff: [`the brief is gone from ${path}`], path };

  const snapshot = parsePrd(snapshotText, path);
  const repo = parsePrd(repoText, path);
  // Byte equality first, so the overwhelmingly common answer costs one string comparison and no parsing decisions.
  if (repoText === snapshotText) return { verdict: "same", why: "identical to the snapshot", diff: [], path, repoText, snapshot, repo };

  const diff = contractDiff(snapshot, repo);
  const verdict = check(repo);
  // The order matters. An illegal brief is reported as illegal even when the contract held, because the operator has to
  // fix the file either way and `start` would have refused it; the contract lines come along so a change that did both
  // says both.
  if (!verdict.ok) {
    const failed = verdict.results.filter(r => !r.ok);
    return {
      verdict: "illegal", path, repoText, snapshot, repo, rules: failed,
      why: `${path} no longer passes the contract: ${failed.map(r => r.id).join(", ")}`,
      diff: [...diff, ...failed.map(r => `contract rule ${r.id} now fails: ${r.detail || r.text}`)],
    };
  }
  // The verdict is the fingerprint's, never the diff's. A diff is a description for a person and descriptions are lossy:
  // a duplicated Verify command leaves every element of both lists present in the other, so the diff is empty while the
  // commands the session must run green have changed. Deciding on the diff let that through as `same` and re-snapshotted
  // it silently, which is the very thing this function exists to prevent.
  if (sameContract(snapshot, repo)) {
    return { verdict: "same", why: "edited outside the contract: the criteria, the Verify commands, the harness and context_paths all still match", diff: [], path, repoText, snapshot, repo };
  }
  return {
    verdict: "changed", path, repoText, snapshot, repo,
    why: `the contract in ${path} is not the one this run started against`,
    // A contract that moved with nothing to show for it says so, rather than reporting no difference and leaving the
    // operator to wonder why they were stopped. Reachable exactly when a list gained or lost a duplicate, which is the
    // one change the diff cannot name, so the line names that.
    diff: diff.length ? diff : [`the acceptance criteria or the Verify commands changed in a way a list of differences cannot show, which means a repeated entry was added or removed. Compare ${path} with the snapshot in the Gallivant home.`],
  };
}

/** One line per difference, indented, for `why` and for the log. Empty string when there is nothing to say. */
export const renderDivergence = d => (d.diff.length ? d.diff.map(l => `  - ${l}`).join("\n") : "");

/**
 * The reason a divergence stops an entry with, or null for one that does not. Kept here rather than spelled at each
 * caller so the tick, `status`, `why` and `resume` cannot drift into three reasons for one condition.
 */
export const DIVERGENCE_REASONS = Object.freeze({ changed: "prd-changed", illegal: "prd-illegal", gone: "prd-gone" });
export const divergenceReason = d => DIVERGENCE_REASONS[d.verdict] ?? null;

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
 *
 * The refusal to overwrite is no longer absolute, and that is the change a divergence forces. It used to mean "the
 * authoritative copy is taken once and never again", which is right against a session and wrong against the operator:
 * a brief they have deliberately edited can only become the brief the gate judges by replacing the snapshot. So an
 * overwrite is possible and it is an explicit act with an audit trail. `replace` is the operator's resolution, carried
 * through `resolvePrdSnapshot` below rather than passed by hand, and it never arrives from a session or from the tick's
 * own judgement.
 */
export async function ensurePrdSnapshot(ctx, { id, repo, path, ref }) {
  const { gh, log, readPrd, writePrd } = ctx;
  try {
    if (!path || readPrd(id)) return false;
    const text = await gh.fileAt(repo, path, ref);
    if (!text) { log.warn(`${id}: ${path} not found on ${ref}; the completion gate is skipped until a snapshot exists`); return false; }
    // A CLI start may have approved its own snapshot while this network read was in flight.
    if (readPrd(id) || ctx.state?.startClaim?.(id)) return false;
    writePrd(id, text);
    log.warn(`${id}: PRD snapshot taken from the PR branch (${path}); the session could have edited it`);
    return true;
  } catch (e) {
    log.warn(`${id}: PRD snapshot not taken: ${e.message}`);
    return false;
  }
}

/**
 * Replace the snapshot with the operator's own copy, and record the contract it now carries on the entry. The one
 * writer of a snapshot that already exists.
 *
 * It refuses everything `prdDivergence` will not stand behind: there is nothing to resolve when the verdict is `same`
 * or `unknown`, there is nothing to copy when the brief is `gone`, and an `illegal` brief must never reach the snapshot
 * the gate judges. So the only verdict it accepts is `changed`, which is exactly the case a person has to decide and
 * has now decided. `why` is what that person was told, so the log line says what the snapshot was replaced WITH and
 * not merely that it was replaced; `by` names who asked, in the same spirit as the existing line that says the session
 * could have edited the copy it took.
 *
 * The state write and the file write are one act from the caller's side, and the FILE goes first: a fingerprint that
 * describes a snapshot nobody took would make every later comparison say `same` about a brief that never moved, which
 * is the silent divergence this whole change exists to end. A file written with the fingerprint then unrecorded is the
 * recoverable half, because the next comparison simply finds the difference again.
 */
export function resolvePrdSnapshot(ctx, { id, entry, divergence, by }) {
  if (divergence.verdict !== "changed") throw new Error(`${id}: nothing to resolve (${divergence.verdict}: ${divergence.why})`);
  const patch = retakePrdSnapshot(ctx, { id, divergence });
  ctx.log.warn(`${id}: PRD snapshot REPLACED from ${divergence.path} by ${by}; the completion gate now judges the edited brief, not the one this run started against:\n${renderDivergence(divergence)}`);
  return patch;
}

/**
 * Follow an edit that left the contract alone: replace the snapshot, record the new fingerprint, say so at info level
 * and restart nothing.
 *
 * Separate from `resolvePrdSnapshot` because the two are different acts with the same mechanics. That one is a person
 * overruling a snapshot the daemon was refusing to replace, and it warns, names who asked and lists what moved. This one
 * is the snapshot following prose the operator rewrote, where there is nothing to decide and nothing to tell anyone: the
 * criteria, the Verify commands, the harness and `context_paths` all still match, so the work in flight is still the work
 * that was asked for. Sharing the writes keeps `ensurePrdSnapshot`'s "one writer" property, which is what stops a third
 * caller inventing its own way to put a file in `prds/`.
 *
 * Callers must have a `same` verdict in hand. It is not asserted here because both callers have just branched on it, and
 * an assertion on a caller-local invariant is the kind of duplication that goes stale.
 */
export function retakePrdSnapshot(ctx, { id, divergence }) {
  const { writePrd, state } = ctx;
  writePrd(id, divergence.repoText);
  const patch = { prd_fingerprint: prdFingerprint(divergence.repo), prd_decision: prdDecision(divergence.repo), prd_divergence: null };
  if (state) state.update(id, patch);
  return patch;
}
