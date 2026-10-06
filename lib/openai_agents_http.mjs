// Direct documented Agents REST transport. No SDK loop or inference fallback.
import { executionError } from "./execution_io.mjs";
export const AGENTS_API_VERSION = "agents=v1";
export const AGENTS_LIMITS = Object.freeze({ responseBytes: 1_048_576, pageSize: 100, pages: 20, streamBytes: 65_536, streamEvents: 100, uploadBytes: 5 * 1024 * 1024, inputBytes: 3 * 1024 * 1024 });
export function agentsHttp({ credential, organization, project, fetcher = fetch }) {
  const headers = async () => {
    const key = await credential();
    if (!key) throw executionError("AGENTS_AUTH", "provide an application OPENAI_API_KEY with api.agents.read/write and api.responses.write; API billing is separate from ChatGPT subscriptions");
    return { Authorization: `Bearer ${key}`, "OpenAI-Beta": AGENTS_API_VERSION, ...(organization ? { "OpenAI-Organization": organization } : {}), ...(project ? { "OpenAI-Project": project } : {}) };
  };
  async function response(path, { signal, method = "GET", body, key, accept } = {}) {
    if (!/^\/(?:agents|models)\//.test(path) && path !== "/agents/sessions") throw executionError("AGENTS_PATH", "unsupported Agents endpoint");
    if (body && Buffer.byteLength(JSON.stringify(body)) > AGENTS_LIMITS.inputBytes) throw executionError("AGENTS_SIZE", "input exceeds the bounded request; supply smaller portable sources");
    const result = await fetcher(`https://api.openai.com/v1${path}`, { method, signal, redirect: "error", headers: { ...await headers(), ...(body ? { "Content-Type": "application/json" } : {}), ...(key ? { "Idempotency-Key": key } : {}), ...(accept ? { Accept: accept } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!result.ok) {
      await result.body?.cancel(); // Never put provider error bodies/credentials in public errors.
      const error = executionError(result.status === 401 || result.status === 403 ? "AGENTS_AUTH" : result.status === 429 ? "AGENTS_THROTTLED" : "AGENTS_HTTP", `Agents API HTTP ${result.status}; request ${result.headers.get("x-request-id") || "unknown"}; check scoped access, billing or resource configuration`);
      error.retryAfterMs = Math.min(300_000, Math.max(0, Number(result.headers.get("retry-after") || 0) * 1000));
      throw error;
    }
    return result;
  }
  async function bytes(result, max = AGENTS_LIMITS.responseBytes) {
    if (Number(result.headers.get("content-length") || 0) > max) { await result.body?.cancel(); throw executionError("AGENTS_SIZE", "provider response exceeds the bounded limit"); }
    const reader = result.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > max) throw executionError("AGENTS_SIZE", "provider response exceeds the bounded limit"); chunks.push(value); }
      return Buffer.concat(chunks);
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  const request = async (path, options) => {
    const value = await bytes(await response(path, options));
    if (!value.length) return null;
    try { return JSON.parse(value.toString("utf8")); } catch { throw executionError("AGENTS_PROTOCOL", "invalid provider JSON"); }
  };
  // Connect first, buffer while the caller retrieves authoritative state. Each
  // bounded operation closes its stream; periodic coordinator polling recovers it.
  async function subscribe(sessionId, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    let reader;
    try { reader = (await response(`/agents/sessions/${encodeURIComponent(sessionId)}/events?stream=true`, { signal: controller.signal, accept: "text/event-stream" })).body.getReader(); }
    catch (error) { signal?.removeEventListener("abort", abort); throw error; }
    const events = []; let gap = false, pending = "", total = 0;
    const decoder = new TextDecoder();
    const pumping = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) { gap = true; break; }
          total += value.length;
          if (total > AGENTS_LIMITS.streamBytes) { gap = true; break; }
          pending = (pending + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          let end;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            try { const event = JSON.parse(data); if (events.length < AGENTS_LIMITS.streamEvents) events.push(event); else gap = true; }
            catch { gap = true; }
          }
          if (events.length >= AGENTS_LIMITS.streamEvents) { gap = true; break; }
        }
      } catch { gap = true; }
    })();
    return { events, get gap() { return gap; }, async close() { controller.abort(); await reader.cancel().catch(() => {}); await pumping; reader.releaseLock(); signal?.removeEventListener("abort", abort); } };
  }
  async function page(path, signal, after = null) {
    const separator = path.includes("?") ? "&" : "?";
    const value = await request(`${path}${separator}limit=${AGENTS_LIMITS.pageSize}&order=asc${after ? `&after=${encodeURIComponent(after)}` : ""}`, { signal });
    if (!Array.isArray(value?.data) || value.data.length > AGENTS_LIMITS.pageSize || typeof value.has_more !== "boolean") throw executionError("AGENTS_PROTOCOL", "invalid provider page");
    const next = value.has_more ? value.last_id || value.data.at(-1)?.id : null;
    if (value.has_more && (!next || next === after || typeof next !== "string" || next.length > 512)) throw executionError("AGENTS_PROTOCOL", "provider pagination does not advance");
    return { data: value.data, next };
  }
  return { request, subscribe, page, download: async (path, signal) => bytes(await response(path, { signal })) };
}
