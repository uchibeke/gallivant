import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "./fs.mjs";

const MAX_DATE = 8_640_000_000_000_000;
const MAX_ACCEPTABLE_WAIT = 7 * 24 * 60 * 60_000;
const httpDate = /^(?:[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]+, \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT|[A-Za-z]{3} [A-Za-z]{3} [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

export function retryAfterAt(value, now) {
  const header = String(value ?? "").trim();
  if (/^\d+$/.test(header)) return Math.min(MAX_DATE, now + Number(header) * 1000);
  if (!httpDate.test(header)) return 0;
  return Date.parse(header.endsWith(" GMT") ? header : `${header} GMT`) || 0;
}

export function httpRetryAt(headers, now = Date.now()) {
  const get = name => headers?.get?.(name);
  const reset = get("x-ratelimit-reset");
  const duration = value => {
    if (!/^(?:\d+(?:\.\d+)?(?:ms|[dhms]))+$/.test(value || "")) return 0;
    const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
    const ms = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|[dhms])/g)].reduce((sum, [, n, unit]) => sum + Number(n) * units[unit], 0);
    return Math.min(MAX_DATE, now + Math.ceil(ms));
  };
  return Math.max(retryAfterAt(get("retry-after"), now), retryAfterAt(get("ratelimit-reset"), now),
    /^\d+$/.test(reset || "") ? Math.min(MAX_DATE, Number(reset) * 1000) : 0,
    duration(get("x-ratelimit-reset-requests")), duration(get("x-ratelimit-reset-tokens")));
}

export const serviceScope = (service, ...identity) => `${service}:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
export const providerScope = (provider, account) => serviceScope("provider", provider, account);
export const hostScope = (host, credential) => serviceScope("host", host, credential);
export const coolingDown = error => error?.code === "SERVICE_COOLDOWN";
export const serverRetryAt = (error, now) => Math.max(Number.isFinite(error?.retryAt) ? error.retryAt : 0,
  Number.isFinite(error?.retryAfterMs) ? Math.min(MAX_DATE, now + error.retryAfterMs) : 0, retryAfterAt(error?.retryAfter, now));

// Only typed transport/capacity failures enter the shared retry window. A
// recognized credential, billing or quota error keeps its ordinary remedy.
export function transientServiceFailure(error) {
  const status = error?.httpStatus ?? error?.status;
  const code = String(error?.code ?? "");
  if (status === 401 || /auth|billing|quota|credential|permission/i.test(code)) return false;
  if (status === 403) return code === "GH_RATE_LIMIT";
  return status === 429 || status >= 500 && status <= 599 ||
    /^(?:BB_RATE_LIMIT|GH_RATE_LIMIT|GH_TRANSPORT|BB_TRANSPORT|AGENTS_TRANSPORT|EXECUTION_DEADLINE|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT|MODEL_CAPACITY|SERVICE_BUSY|RATE_LIMITED)$/.test(code);
}

export function makeRecoveryCooldowns({ home, clock = Date, maxWaitMs = MAX_ACCEPTABLE_WAIT } = {}) {
  const file = home && join(home, "recovery-cooldowns.json");
  let memory = { version: 1, scopes: {} };
  const unsaved = new Map();
  const probes = new Set();
  const read = () => {
    let saved = memory;
    if (file) {
      try { saved = JSON.parse(readFileSync(file, "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw Object.assign(new Error("Recovery cooldown checkpoint is unreadable."), { code: "SERVICE_STATE_UNAVAILABLE" }); }
    }
    if (saved.version !== 1) throw new Error("Unsupported recovery cooldown checkpoint.");
    for (const [scope, bound] of unsaved) if (bound.nextAt > (saved.scopes[scope]?.nextAt || 0)) saved.scopes[scope] = bound;
    return saved;
  };
  const save = saved => {
    memory = saved;
    if (file) writeJsonAtomic(file, saved, 0o600, { durable: true });
    unsaved.clear();
  };
  const get = scope => read().scopes[scope] ?? null;
  const record = (scope, error) => {
    if (!transientServiceFailure(error) || coolingDown(error)) return;
    const now = clock.now(), saved = read(), prior = saved.scopes[scope];
    const serverAt = Math.max(prior?.serverAt || 0, serverRetryAt(error, now));
    const failures = Math.min(16, (prior?.failures || 0) + 1);
    const nextAt = Math.max(serverAt, now + Math.min(300_000, 15_000 * 2 ** (failures - 1)), prior?.nextAt || 0);
    const bound = { failures, serverAt, nextAt, suspended: serverAt - now > maxWaitMs };
    unsaved.set(scope, bound);
    save({ ...saved, scopes: { ...saved.scopes, [scope]: bound } });
  };
  const deferred = (scope) => {
    const value = get(scope), now = clock.now();
    if (!probes.has(scope) && (!value || value.nextAt <= now)) return null;
    const retryAt = Math.max(value?.nextAt || 0, probes.has(scope) ? now + 1000 : 0);
    const message = value?.suspended ? "Service recovery suspended until its server deadline" : "Shared service cooldown or recovery probe pending";
    return Object.assign(new Error(message), { code: "SERVICE_COOLDOWN", retryAt, retryAfterMs: retryAt - now });
  };
  async function call(scope, fn) {
    const refused = deferred(scope);
    if (refused) throw refused;
    const prior = get(scope);
    if (prior) probes.add(scope);
    try {
      const result = await fn();
      if (prior) {
        const saved = read();
        if (saved.scopes[scope]?.nextAt === prior.nextAt && saved.scopes[scope]?.failures === prior.failures) {
          delete saved.scopes[scope];
          save(saved);
        }
      }
      return result;
    } catch (error) { record(scope, error); throw error; }
    finally { if (prior) probes.delete(scope); }
  }
  return { call, deferred, get, record };
}
