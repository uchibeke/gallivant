import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { boundedCall, EXECUTION_LIMITS, nextAttempt } from "./execution_io.mjs";
export function makeProviderHealth({ home, clock = Date, limits = {}, probe, jitter = Math.random }) {
  const bounds = { ...EXECUTION_LIMITS, ...limits }, pending = new Map();
  const file = join(home, "provider-health.json");
  const key = (provider, account) => JSON.stringify([provider, account]);
  const get = (provider, account = "operator") => {
    const s = readJson(file, { version: 1, scopes: {} });
    if (s.version !== 1) throw new Error("unsupported provider health version; restore a compatible backup before dispatch");
    const saved = s.scopes[key(provider, account)];
    if (!saved) return { ok: false, detail: "provider/account check pending" };
    if (saved.ok && clock.now() > saved.observedAt + bounds.progressMs * 2) return { ...saved, ok: false, detail: "provider/account health is stale; awaiting the coordinator's next probe" };
    return saved;
  };
  const refresh = async scopes => {
    const queue = scopes.filter(([p, a]) => !pending.has(key(p, a)) && clock.now() >= (get(p, a).nextAttemptAt || 0));
    const worker = async () => {
      for (let scope = queue.shift(); scope; scope = queue.shift()) {
        const [provider, account] = scope, id = key(provider, account);
        const work = boundedCall(signal => probe(provider, account, signal), bounds);
        pending.set(id, work);
        let result;
        try { result = await work; } catch (e) { result = { ok: false, detail: e.code || "provider check failed", retryAfterMs: e.retryAfterMs }; }
        finally { pending.delete(id); }
        const s = readJson(file, { version: 1, scopes: {} });
        const failures = result.ok ? 0 : (s.scopes[id]?.failures || 0) + 1;
        s.scopes[id] = { ...result, failures, observedAt: clock.now(), nextAttemptAt: result.ok ? clock.now() + bounds.progressMs : nextAttempt(clock.now(), failures, result.retryAfterMs, bounds, jitter) };
        writeJsonAtomic(file, s);
      }
    };
    await Promise.all(Array.from({ length: Math.min(bounds.concurrency, queue.length) }, worker));
  };
  return { get, refresh };
}
