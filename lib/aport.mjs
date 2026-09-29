// Reading what APort's installer leaves on disk: the mode file next to a harness settings file, and the audit log.
// One parser for each, shared by context, doctor and why, so all three agree on quoting and timestamps.
import { join, dirname } from "node:path";
import { readdirSync } from "node:fs";
import { readText } from "./fs.mjs";

/** The APort state directory for a Claude settings file: <dir of settings>/aport. */
export const aportDirFor = settingsPath => (settingsPath ? join(dirname(settingsPath), "aport") : null);

/** `guardrail-mode.env` as a key/value map. Values may be bare, double- or single-quoted. */
export function readGuardrailEnv(aportDir) {
  const out = {};
  if (!aportDir) return out;
  for (const line of (readText(join(aportDir, "guardrail-mode.env"), "") || "").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Summary of the mode file: { mode: "api"|"local"|null, agentId, apiKey, apiUrl, enforcement }. */
export function guardrailMode(aportDir) {
  const env = readGuardrailEnv(aportDir);
  return {
    mode: env.APORT_GUARDRAIL_MODE?.toLowerCase() || null,
    agentId: env.APORT_AGENT_ID || null,
    apiKey: env.APORT_API_KEY || null,
    apiUrl: env.APORT_API_URL || null,
    enforcement: env.APORT_ENFORCEMENT || env.APORT_ENFORCEMENT_MODE || "enforce",
  };
}

/**
 * Audit-log lines whose timestamp falls in [fromMs, toMs]. The hook stamps `[2026-09-24 03:48:31]` in UTC without a
 * zone marker; ISO stamps are accepted too. A minute of slack covers clock rounding.
 */
export function auditEntries(aportDir, { fromMs, toMs = Date.now(), filter = null } = {}) {
  if (!aportDir) return [];
  let files = [];
  try { files = readdirSync(aportDir).filter(f => /audit/i.test(f)); } catch { return []; }
  const out = [];
  for (const f of files) {
    for (const line of (readText(join(aportDir, f), "") || "").split("\n")) {
      const t = auditStamp(line);
      if (t === null || t < fromMs - 60_000 || t > toMs + 60_000) continue;
      if (filter && !filter.test(line)) continue;
      out.push(line.slice(0, 220));
    }
  }
  return out;
}

/**
 * How the guardrail's own decisions came out, read from `session-decisions.jsonl`.
 *
 * The distinction this exists to draw: `oap.blocked_pattern` is the hook deciding NO, and `oap.evaluation_error` is
 * the hook failing to decide at all and denying because it fails closed. A run cannot tell those apart, and neither
 * could an operator: both arrive at the session as "APort denied this tool call", so a week of rate limits from
 * aport.io reads as a policy that is too tight, and the operator loosens a policy that was never the problem.
 *
 * Measured on one machine's history: of 60 denials, 15 were evaluation errors. Thirteen were HTTP 429 ("Too many
 * failed attempts. Account temporarily blocked") which denied ordinary work for about three minutes straight, and the
 * rest were the hook's own request failing schema validation on fields it builds itself.
 *
 * Counts only, never the message, because a reason can carry a command line and this is printed by `doctor`.
 */
export function decisionCounts(aportDir, { file = "session-decisions.jsonl" } = {}) {
  const out = { total: 0, allowed: 0, denied: 0, codes: {}, evaluationErrors: 0 };
  if (!aportDir) return out;
  for (const line of (readText(join(aportDir, file), "") || "").split("\n")) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line).decision; } catch { continue; }
    if (!d) continue;
    out.total++;
    if (d.allow) out.allowed++; else out.denied++;
    for (const r of d.reasons || []) {
      if (!r?.code) continue;
      out.codes[r.code] = (out.codes[r.code] || 0) + 1;
      if (r.code === "oap.evaluation_error" && !d.allow) out.evaluationErrors++;
    }
  }
  return out;
}

const auditStamp = line => {
  const m = line.match(/^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?\]?/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(t) ? t : null;
};
