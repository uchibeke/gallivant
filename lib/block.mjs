// The PR block: an HTML comment in the PR body that names the PRD, harness, session and branch. Identity only, no
// counters, written once by the daemon. Parsing is strict because on a public repo anyone can edit a PR body.
import { HARNESSES } from "./config.mjs";
import { adapters } from "./harness.mjs";

const OPEN = "<!-- gallivant";
const CLOSE = "-->";

// The fields in validation order, because `session` is judged against the `harness` already accepted above it: what
// a session id looks like is per-harness knowledge and lives with the adapters, not as one shape in here. A regex
// for claude's UUID was silently refusing goose's `gallivant-<uuid>` and opencode's `ses_...`, which made a block
// this very module had just written unreadable, and `reconcile` then ignored the PR without an entry to show for it.
const FIELDS = ["prd", "harness", "session", "branch"];

const RULES = {
  // A relative path under the repo, no `..` segments, no leading slash.
  prd: v => /^[a-z0-9][a-z0-9_./-]*\.md$/.test(v) && !v.split("/").includes("..") && !v.includes("//"),
  harness: v => HARNESSES.includes(v),
  session: (v, fields) => v === "none" || adapters[fields.harness]?.isSession(v) === true,
  branch: v => /^gallivant\/[a-z0-9][a-z0-9-]*$/.test(v),
};

export function renderBlock({ prd, harness, session, branch }) {
  return [OPEN, `prd: ${prd}`, `harness: ${harness}`, `session: ${session ?? "none"}`, `branch: ${branch}`, CLOSE].join("\n");
}

/** Parsed and validated fields, or null with a reason when anything is off. */
export function parseBlock(body) {
  const text = String(body || "");
  const start = text.indexOf(OPEN);
  if (start < 0) return { block: null, reason: "no block" };
  const end = text.indexOf(CLOSE, start);
  if (end < 0) return { block: null, reason: "unterminated block" };
  const fields = {};
  for (const line of text.slice(start + OPEN.length, end).split("\n")) {
    const m = line.trim().match(/^(prd|harness|session|branch):\s*(\S+)$/);
    if (m) fields[m[1]] = m[2];
  }
  for (const k of FIELDS) {
    const v = fields[k];
    if (v === undefined) return { block: null, reason: `missing ${k}` };
    if (!RULES[k](v, fields)) return { block: null, reason: `invalid ${k}: ${v.slice(0, 40)}` };
  }
  return { block: { ...fields, session: fields.session === "none" ? null : fields.session }, reason: null };
}

/** The body with exactly one block: an existing block (valid or not) is replaced, otherwise one is appended. */
export function upsertBlock(body, block) {
  const text = String(body || "");
  const start = text.indexOf(OPEN);
  const end = start >= 0 ? text.indexOf(CLOSE, start) : -1;
  if (start >= 0 && end >= 0) return text.slice(0, start) + renderBlock(block) + text.slice(end + CLOSE.length);
  return `${text.replace(/\s+$/, "")}\n\n${renderBlock(block)}\n`;
}
