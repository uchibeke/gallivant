// Every transport operation must honor signal; a missed deadline still fences its late reply.
export const EXECUTION_LIMITS = Object.freeze({ deadlineMs: 2000, progressMs: 10_000, maxBackoffMs: 300_000, concurrency: 4, eventBytes: 65_536, events: 100 });
export const executionError = (code, message) => Object.assign(new Error(message), { code });
// Omitted sessions retain recorded ownership; reported sessions must be exact.
export const ownsProviderSession = (owned, reported) => reported == null ||
  (typeof reported === "string" && !!reported.trim() && (owned == null || reported === owned));
// A collected outcome cannot replace an authoritative root-turn observation.
// Older collected runs may retain that observation only in providerState.
export function assertTerminalOutcome(execution, outcome) {
  const observed = execution?.terminalState ?? execution?.providerState;
  if (["succeeded", "failed"].includes(observed) &&
    (outcome?.finished !== true || typeof outcome.ok !== "boolean" || outcome.ok !== (observed === "succeeded"))) {
    throw executionError("EXECUTION_RESULT", "result outcome contradicts the authoritative terminal root; reconcile the exact completed turn");
  }
}
export async function boundedCall(fn, { deadlineMs = EXECUTION_LIMITS.deadlineMs } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(executionError("EXECUTION_DEADLINE", "transport deadline exceeded; reconcile acceptance before retrying")); }, deadlineMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
export function nextAttempt(now, failures, retryAfterMs = 0, limits = EXECUTION_LIMITS, jitter = Math.random) {
  const backoff = limits.progressMs * 2 ** Math.min(failures, 10);
  return now + Math.min(limits.maxBackoffMs, Math.max(retryAfterMs, backoff + Math.floor(backoff * 0.1 * jitter())));
}
// Redaction precedes persistence in projections, journals and result evidence. Callers
// also supply resolved secrets, including tokens whose formats cannot be recognized.
export function redact(value, secrets = []) {
  const clean = text => {
    let out = text;
    // Replace enclosing credentials before their substrings, regardless of
    // environment order. Filtering produces a copy, preserving caller input.
    for (const secret of secrets.filter(s => typeof s === "string" && s.length).sort((a, b) => b.length - a.length)) out = out.split(secret).join("[redacted]");
    return out.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "[redacted]")
      .replace(/(Bearer\s+)[^\s"\\]+/gi, "$1[redacted]")
      .replace(/((?:api[_-]?key|token|password|secret|authorization)"?\s*[=:]\s*"?)[^"\s,;]+/gi, "$1[redacted]");
  };
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(?:api[_-]?key|token|password|secret|authorization|credentials)$/i.test(k) ? "[redacted]" : redact(v, secrets)]));
  return value;
}

// Artifact manifests are private publication input: changing their bytes or
// paths breaks the provider's hashes. Public readers use the redacted summary.
export function redactResultMetadata(result, secrets = []) {
  const { files, artifacts: _artifacts, ...metadata } = result;
  const clean = redact(metadata, secrets);
  if (files !== undefined) clean.files = structuredClone(files);
  clean.artifacts = redact(Array.isArray(files) ? files.slice(0, 100).map(file => ({ path: file?.path, hash: file?.afterHash })) : [], secrets);
  return clean;
}
