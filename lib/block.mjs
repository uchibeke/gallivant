// Recovery identity in the PR body. The neutral record is versioned canonical JSON, transported as base64url.
// This is encoding, not secrecy or authorization: all decoded fields retain the legacy strict validation.
import { HARNESSES } from "./config.mjs";
import { adapters } from "./harness.mjs";
import { BLOCK_OPEN, BLOCK_OPENS, BRANCH_PREFIXES } from "./public-format.mjs";
import { normalizeReceipt } from "./deliverable.mjs";

const CLOSE = "-->";
const FIELDS = ["prd", "harness", "session", "branch"];
const RULES = {
  prd: v => /^[a-z0-9][a-z0-9_./-]*\.md$/.test(v) && !v.split("/").includes("..") && !v.includes("//"),
  harness: v => HARNESSES.includes(v),
  session: (v, fields) => v === null || adapters[fields.harness]?.isSession(v) === true,
  branch: v => BRANCH_PREFIXES.some(prefix => v.startsWith(prefix) && /^[a-z0-9][a-z0-9-]*$/.test(v.slice(prefix.length))),
};

// Require the opening marker to occupy a complete line. Old round/nudge/reset comments share the old prefix but
// are not identities, and must never be mistaken for a recovery block or removed when a body is normalized.
const OPEN_RE = new RegExp("^(?:" + BLOCK_OPENS.join("|") + ")[ \\t]*(?=\\r?$)", "gm");
function blocks(body) {
  return [...body.matchAll(OPEN_RE)].map(match => ({ start: match.index, open: match[0].trimEnd(), end: body.indexOf(CLOSE, match.index + match[0].length) }));
}

export function renderBlock({ prd, harness, session, branch }) {
  const data = Buffer.from(JSON.stringify({ version: 1, prd, harness, session: session ?? null, branch }), "utf8").toString("base64url");
  return `${BLOCK_OPEN}\n${data}\n${CLOSE}`;
}

/** Parsed and validated fields, or null with a reason when anything is off. */
export function parseBlock(body) {
  const text = String(body || "");
  const found = blocks(text);
  if (!found.length) return { block: null, reason: "no block" };
  if (found.length !== 1) return { block: null, reason: "multiple recovery blocks" };
  const { start, open, end } = found[0];
  if (end < 0) return { block: null, reason: "unterminated block" };
  const payload = text.slice(start + open.length, end).trim();
  let fields;
  if (open === BLOCK_OPEN) {
    if (payload.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(payload)) return { block: null, reason: "invalid recovery record encoding" };
    try {
      const bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) throw new Error("noncanonical encoding");
      const value = JSON.parse(bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
          || Object.keys(value).some(k => !["version", ...FIELDS].includes(k))) throw new Error("unknown recovery record schema");
      fields = Object.fromEntries(FIELDS.filter(k => Object.hasOwn(value, k)).map(k => [k, value[k]]));
    } catch { return { block: null, reason: "invalid recovery record" }; }
  } else {
    fields = {};
    for (const line of payload.split("\n")) {
      const match = line.trim().match(/^(prd|harness|session|branch):\s*(\S+)$/);
      if (!match) continue;
      if (Object.hasOwn(fields, match[1])) return { block: null, reason: `duplicate ${match[1]}` };
      fields[match[1]] = match[2];
    }
    if (fields.session === "none") fields.session = null;
  }
  for (const key of FIELDS) {
    const value = fields[key];
    if (value === undefined) return { block: null, reason: `missing ${key}` };
    if ((key === "session" && value === null) || (typeof value === "string" && RULES[key](value, fields))) continue;
    return { block: null, reason: `invalid ${key}: ${String(value).slice(0, 40)}` };
  }
  return { block: fields, reason: null };
}

/** Replace one known block (valid or not), or append one. Ambiguous identities are never silently discarded. */
export function upsertBlock(body, block) {
  const text = String(body || "");
  const found = blocks(text);
  if (found.length > 1) throw new Error("multiple recovery blocks; keep exactly one identity");
  if (found.length) {
    const { start, end } = found[0];
    if (end < 0) throw new Error("unterminated recovery block; repair the body before updating identity");
    return text.slice(0, start) + renderBlock(block) + text.slice(end + CLOSE.length);
  }
  return `${text.replace(/\s+$/, "")}\n\n${renderBlock(block)}\n`;
}

/** Migrate machine-owned formatting only. Never redact a title, prose, evidence, source path or URL. */
export function normalizePublicBody(body, { identity = null, taskId = null } = {}) {
  let text = normalizeReceipt(body, taskId);
  const parsed = parseBlock(text);
  if (identity) text = upsertBlock(text, identity);
  else if (parsed.block) text = upsertBlock(text, parsed.block);
  else if (parsed.reason !== "no block") throw new Error(parsed.reason);
  return text;
}
