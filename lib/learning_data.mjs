// All learning input is data. These bytes are also the approval/signature format.
import { createHash } from "node:crypto";
import { redact } from "./execution_io.mjs";

export const learningError = (code, message) => Object.assign(new Error(message), { code: `LEARNING_${code}` });
export const hash = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const bad = message => { throw learningError("INPUT", message); };
const dangerousText = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
export function textField(value, name, max = 2048) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max || dangerousText.test(value) || /[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) bad(`invalid ${name}`);
  return value;
}
export function closed(value, keys, name) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(value, k))) bad(`invalid ${name} schema`);
}
export function canonical(value) {
  // RFC 8785: ECMAScript number serialization, UTF-16 key order, no Unicode normalization.
  const walk = (v, depth = 0) => {
    if (depth > 24) bad("JSON nesting limit");
    if (v === null || typeof v === "boolean") return JSON.stringify(v);
    if (typeof v === "number") { if (!Number.isFinite(v)) bad("nonfinite JSON number"); return JSON.stringify(v); }
    if (typeof v === "string") {
      if (/[\ud800-\udfff]/u.test(v.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""))) bad("invalid Unicode");
      return JSON.stringify(v);
    }
    if (Array.isArray(v)) return `[${v.map(x => walk(x, depth + 1)).join(",")}]`;
    if (v && Object.getPrototypeOf(v) === Object.prototype) return `{${Object.keys(v).sort().map(k => `${walk(k)}:${walk(v[k], depth + 1)}`).join(",")}}`;
    bad("non-JSON value");
  };
  return walk(value);
}
export function parseJson(input, max = 256 * 1024) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length > max) bad("JSON byte limit");
  let raw;
  try { raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { bad("invalid UTF-8"); }
  // Parse object keys before JSON.parse can discard duplicates. Bound nesting and tokens.
  let pos = 0, tokens = 0;
  const ws = () => { while (/\s/.test(raw[pos] || "") && pos < raw.length) pos++; };
  const string = () => {
    const start = pos++;
    while (pos < raw.length) {
      const c = raw[pos++];
      if (c === "\\") pos++;
      else if (c === '"') { try { return JSON.parse(raw.slice(start, pos)); } catch { bad("invalid JSON string"); } }
    }
    bad("unterminated JSON string");
  };
  const value = (depth = 0) => {
    if (depth > 24 || ++tokens > 100_000) bad("JSON structure limit");
    ws();
    const c = raw[pos];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      const object = c === "{", end = object ? "}" : "]", keys = new Set(); pos++; ws();
      if (raw[pos] === end) { pos++; return; }
      for (;;) {
        if (object) {
          ws(); if (raw[pos] !== '"') bad("invalid JSON key");
          const key = string(); if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) bad("duplicate or unsafe JSON key"); keys.add(key);
          ws(); if (raw[pos++] !== ":") bad("invalid JSON object");
        }
        value(depth + 1); ws();
        if (raw[pos] === end) { pos++; return; }
        if (raw[pos++] !== ",") bad("invalid JSON delimiter");
      }
    }
    const m = raw.slice(pos).match(/^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
    if (!m) bad("invalid JSON value"); pos += m[0].length;
  };
  value(); ws(); if (pos !== raw.length) bad("trailing JSON");
  let result; try { result = JSON.parse(raw); } catch { bad("invalid JSON"); }
  canonical(result);
  return result;
}
export function literalPath(path) {
  textField(path, "project path", 512);
  if (path.startsWith("/") || /[\\:*?\[\]{}\s]/.test(path) || path.split("/").some(x => !x || x === "." || x === "..") || path.split("/").some(x => x.startsWith("."))) bad("unsafe literal project path");
  return path;
}
export function repository(repo) {
  closed(repo, ["host", "id"], "repository");
  if (repo.host !== "github.com" || typeof repo.id !== "string" || !/^[1-9]\d{0,19}$/.test(repo.id)) bad("unsupported repository identity");
  return repo;
}
export function repositoryName(name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name) || name.includes("..")) bad("expected owner/repository");
  return name;
}
export const digestField = v => { if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) bad("expected SHA-256 digest"); return v; };
export const candidateId = v => { if (typeof v !== "string" || !/^lesson-[a-z0-9-]{1,80}$/.test(v)) bad("invalid candidate ID"); return v; };
export function candidate(value, repo) {
  closed(value, ["version", "id", "repo", "paths", "applicability", "guidance", "rationale", "example", "evidence", "disposition", "regression", "provenance"], "candidate");
  if (value.version !== 1) bad("unsupported candidate version");
  candidateId(value.id); repository(value.repo);
  if (canonical(value.repo) !== canonical(repo)) bad("foreign repository candidate");
  if (!Array.isArray(value.paths) || value.paths.length > 20 || new Set(value.paths).size !== value.paths.length) bad("invalid project scopes");
  value.paths.forEach(literalPath);
  for (const name of ["applicability", "guidance", "rationale", "example"]) textField(value[name], name);
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 20 || new Set(value.evidence).size !== value.evidence.length) bad("invalid candidate evidence");
  value.evidence.forEach(digestField);
  if (!["unconfirmed", "fixed", "contested", "retracted"].includes(value.disposition)) bad("invalid fix disposition");
  if (value.regression !== null) literalPath(value.regression);
  closed(value.provenance, ["provider", "inputDigest", "at"], "provenance");
  textField(value.provenance.provider, "provider", 80); digestField(value.provenance.inputDigest); iso(value.provenance.at);
  // A lesson is advice, never an alternative configuration/policy program.
  const advice = [value.applicability, value.guidance, value.rationale, value.example].join("\n");
  if (/\b(?:disable|skip|bypass|override|change|replace|ignore|increase|remove|set|grant)\b[^.\n]{0,120}\b(?:permissions?|tools?|budgets?|trust|verify|verification|acceptance|merge policy|aport|gates?|sandbox|signer|checkpoint)\b/i.test(advice)) bad("candidate attempts to change authority or task gates");
  if (canonical(redact(value)) !== canonical(value)) bad("candidate contains unredacted secret material");
  if (Buffer.byteLength(canonical(value)) > 16 * 1024) bad("candidate byte limit");
  return { content: parseJson(canonical(value)), digest: hash(value) };
}
export function iso(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) bad("invalid UTC timestamp");
  return value;
}
export function dateRange(since, until, now) {
  const end = until ? date(until) : now, start = since ? date(since) : end - 30 * 86400_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) bad("expected half-open UTC date range");
  return { since: new Date(start).toISOString(), until: new Date(end).toISOString() };
}
const date = value => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\d$/.test(value)) bad("dates use YYYY-MM-DD");
  const n = Date.parse(value + "T00:00:00Z");
  if (!Number.isFinite(n) || new Date(n).toISOString().slice(0, 10) !== value) bad("invalid date");
  return n;
};
export function minimized(text, secrets = []) {
  const raw = String(text ?? "");
  const clean = redact(raw, secrets).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  const bytes = Buffer.from(clean), excerpt = new TextDecoder().decode(bytes.subarray(0, 2048));
  return { excerpt, incomplete: bytes.length > 2048, redacted: clean !== raw, sourceDigest: hash(raw) };
}
// JSON escapes all terminal controls; Markdown is a view, never interpreted or fetched.
export const safeDisplay = value => JSON.stringify(value, null, 2).replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
