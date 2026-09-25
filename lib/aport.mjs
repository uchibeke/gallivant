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

const auditStamp = line => {
  const m = line.match(/^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)Z?\]?/);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isFinite(t) ? t : null;
};
