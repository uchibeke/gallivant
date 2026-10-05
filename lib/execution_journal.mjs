import { join } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, appendFileSync, fsyncSync, openSync, closeSync, statSync, readSync } from "node:fs";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { redact } from "./execution_io.mjs";
import { appendProjection, LOG_LIMITS } from "./run_log.mjs";
export const JOURNAL_VERSION = 1;
const size = file => { try { return statSync(file).size; } catch { return 0; } };
export function journalFor(dir, { taskId, runId, provider, secrets = [] }) {
  ensureDir(dir);
  const stateFile = join(dir, "journal.json"), events = join(dir, "events.jsonl");
  const keys = ensureDir(join(dir, "event-keys"));
  const load = () => {
    const s = readJson(stateFile, { version: JOURNAL_VERSION, sequence: 0 });
    if (s.version !== JOURNAL_VERSION) throw new Error("unsupported journal version; restore a matching backup/package before replay");
    return s;
  };
  const project = record => appendProjection(dir, typeof record.data === "string" && record.data ? record.data : JSON.stringify(record), { sequence: record.sequence });
  // Repair an interrupted append before accepting another event. Inspect at most
  // one bounded record at the saved offset, never scan the journal in full.
  const recover = () => {
    const s = load(), pending = s.pending;
    if (!pending) return;
    let record = null;
    if (existsSync(events)) {
      const fd = openSync(events, "r");
      try {
        const buf = Buffer.alloc(LOG_LIMITS.lineBytes + 1);
        const n = readSync(fd, buf, 0, buf.length, pending.offset);
        try { record = JSON.parse(buf.subarray(0, n).toString("utf8").split("\n")[0]); } catch { /* interrupted record */ }
      } finally { closeSync(fd); }
    }
    if (record?.sequence !== s.sequence) {
      record = { version: JOURNAL_VERSION, taskId, runId, provider, sequence: s.sequence, eventId: pending.eventId, timestamp: pending.timestamp, type: "gap", provenance: "coordinator", data: "interrupted journal append; this event's history is unrecoverable" };
      appendFileSync(events, "\n" + JSON.stringify(record) + "\n", { mode: 0o600, flush: true });
    }
    writeJsonAtomic(join(keys, pending.hash), { sequence: s.sequence, eventId: pending.eventId });
    if (Math.floor(size(join(dir, "job.idx")) / 8) < s.sequence) project({ ...record, type: "gap", data: "[gap: interrupted projection recovered; consult normalized history]" });
    writeJsonAtomic(stateFile, { version: JOURNAL_VERSION, sequence: s.sequence });
  };
  recover();
  return { recover, append(input) {
    if (typeof input.eventId !== "string" || !input.eventId || input.eventId.length > 512) throw new Error("journal requires a bounded provider event identity");
    recover();
    const state = load();
    const identity = [provider, input.providerJobId ?? null, input.turnId ?? null, input.eventId];
    const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const key = join(keys, hash);
    if (existsSync(key)) return readJson(key);
    const sequence = state.sequence + 1;
    let record = redact({ ...input, providerSequence: input.sequence ?? null, version: JOURNAL_VERSION, taskId, runId, provider, sequence, provenance: input.provenance || "provider", timestamp: input.timestamp ?? Date.now() }, secrets);
    if (Buffer.byteLength(JSON.stringify(record)) + 1 > LOG_LIMITS.lineBytes) record = { version: JOURNAL_VERSION, taskId, runId, provider, sequence, eventId: record.eventId, type: "gap", timestamp: record.timestamp, provenance: record.provenance, data: "oversized provider record omitted" };
    writeJsonAtomic(stateFile, { version: JOURNAL_VERSION, sequence, pending: { hash, eventId: record.eventId, timestamp: record.timestamp, offset: size(events) } });
    appendFileSync(events, JSON.stringify(record) + "\n", { mode: 0o600, flush: true });
    writeJsonAtomic(key, { sequence, eventId: record.eventId });
    project(record);
    for (const file of ["job.log", "job.idx"]) { const fd = openSync(join(dir, file), "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
    writeJsonAtomic(stateFile, { version: JOURNAL_VERSION, sequence });
    return { sequence, eventId: record.eventId };
  } };
}
