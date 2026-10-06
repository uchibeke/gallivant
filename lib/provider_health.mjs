import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./fs.mjs";
import { boundedCall, EXECUTION_LIMITS, nextAttempt } from "./execution_io.mjs";
export function makeProviderHealth({ home, file = join(home, "provider-health.json"), clock = Date, limits = {}, probe, jitter = Math.random }) {
  const bounds = { ...EXECUTION_LIMITS, ...limits }, pending = new Map();
  const key = (provider, account) => JSON.stringify([provider, account]);
  const read = () => {
    const s = readJson(file, { version: 1, scopes: {} });
    if (s.version !== 1) throw new Error("unsupported provider health version; restore a compatible backup before dispatch");
    return s;
  };
  const get = (provider, account = "operator") => {
    const s = read();
    const id = key(provider, account), saved = s.scopes[id];
    if (!saved) return { ok: false, detail: "provider/account check pending" };
    // Fence due scopes before refresh starts, including those waiting for a
    // probe worker. A read never probes; restart uses the same saved deadline.
    if (saved.ok && (pending.has(id) || clock.now() >= (saved.nextAttemptAt ?? saved.observedAt + bounds.progressMs))) return { ...saved, ok: false, detail: "provider/account health refresh pending; awaiting the coordinator's next probe" };
    if (saved.ok && clock.now() > saved.observedAt + bounds.progressMs * 2) return { ...saved, ok: false, detail: "provider/account health is stale; awaiting the coordinator's next probe" };
    return saved;
  };
  const refresh = async scopes => {
    const queue = [], errors = [];
    // Complete schema/deadline reads before registering any waiters. A refused
    // state read must not strand scopes that have not obtained a worker yet.
    const due = scopes.filter(([provider, account]) => !pending.has(key(provider, account)) && clock.now() >= (get(provider, account).nextAttemptAt || 0));
    for (const [provider, account] of due) {
      const id = key(provider, account);
      if (pending.has(id)) continue;
      let finish;
      pending.set(id, new Promise(resolve => { finish = resolve; }));
      queue.push({ provider, account, id, finish });
    }
    const worker = async () => {
      for (let scope = queue.shift(); scope; scope = queue.shift()) {
        const { provider, account, id, finish } = scope;
        try {
          let result;
          try { result = await boundedCall(signal => probe(provider, account, signal), bounds); }
          catch (e) { result = { ok: false, detail: e.code || "provider check failed", retryAfterMs: e.retryAfterMs }; }
          const s = read();
          const failures = result.ok ? 0 : (s.scopes[id]?.failures || 0) + 1;
          s.scopes[id] = { ...result, failures, observedAt: clock.now(), nextAttemptAt: result.ok ? clock.now() + bounds.progressMs : nextAttempt(clock.now(), failures, result.retryAfterMs, bounds, jitter) };
          writeJsonAtomic(file, s);
        } catch (error) { errors.push(error); }
        finally { pending.delete(id); finish(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(bounds.concurrency, queue.length) }, worker));
    if (errors.length) throw errors[0];
  };
  // Waiting only joins a probe already scheduled by the coordinator. It cannot
  // create provider I/O, and resolves after persistence, including failed writes.
  return { get, refresh, whenRefreshed: (provider, account = "operator") => pending.get(key(provider, account)) || null };
}
