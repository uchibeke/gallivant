// Public log projection with fixed-width offsets. Reads are capped independently
// of file size; legacy files without an index use a bounded suffix with a gap.
import { openSync, closeSync, readSync, writeSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./execution_io.mjs";
import { readJson, writeJsonAtomic } from "./fs.mjs";
export const LOG_LIMITS = Object.freeze({ windowBytes: 262_144, lineBytes: 65_536, lines: 400, bufferedBytes: 327_680 });
const stat = file => { try { return statSync(file); } catch { return { size: 0, ino: 0 }; } };
const boundedItems = items => {
  let bytes = 2;
  const bounded = items.map(item => {
    const line = Buffer.byteLength(JSON.stringify(item.line)) > LOG_LIMITS.lineBytes ? "[gap: record exceeds encoded response limit]" : item.line;
    bytes += Buffer.byteLength(JSON.stringify(line)) + 1;
    return { ...item, line };
  });
  while (bytes > LOG_LIMITS.windowBytes && bounded.length) bytes -= Buffer.byteLength(JSON.stringify(bounded.shift().line)) + 1;
  return bounded;
};
export function appendProjection(dir, line, { sequence = null } = {}) {
  const file = join(dir, "job.log"), index = join(dir, "job.idx");
  const text = redact(String(line)).replace(/\n/g, "\\n");
  const data = Buffer.from(text + "\n");
  if (data.length > LOG_LIMITS.lineBytes) throw new Error("projection line exceeds limit; journal a gap instead");
  const offset = stat(file).size, previous = readJson(join(dir, "log-meta.json"), { version: 2, firstSequence: 1, lastSequence: 0, size: 0, ino: stat(file).ino });
  const id = sequence ?? previous.lastSequence + 1;
  if (previous.ino && (previous.ino !== stat(file).ino || offset < previous.size)) previous.firstSequence = id;
  const fd = openSync(file, "a", 0o600), ix = openSync(index, existsSync(index) ? "r+" : "w+", 0o600);
  try {
    writeSync(fd, data);
    const pointer = Buffer.alloc(8); pointer.writeBigUInt64LE(BigInt(offset + 1)); // zero means a retained-history gap.
    writeSync(ix, pointer, 0, 8, (id - 1) * 8);
    writeJsonAtomic(join(dir, "log-meta.json"), { ...previous, version: 2, lastSequence: Math.max(previous.lastSequence, id), ino: stat(file).ino, size: offset + data.length });
  } finally { closeSync(fd); closeSync(ix); }
}
const readRange = (file, start, length, meter) => {
  if (length <= 0) return Buffer.alloc(0);
  const fd = openSync(file, "r");
  try { const buf = Buffer.alloc(length); const n = readSync(fd, buf, 0, length, start); meter.bytesRead += n; return buf.subarray(0, n); }
  finally { closeSync(fd); }
};
export function logWindow(dir, { before = null, after = null, count = LOG_LIMITS.lines, meter = { bytesRead: 0 } } = {}) {
  const file = join(dir, "job.log"), index = join(dir, "job.idx");
  const size = stat(file).size;
  const n = Math.min(LOG_LIMITS.lines, Math.max(1, Math.trunc(Number(count)) || LOG_LIMITS.lines));
  if (existsSync(index)) {
    const meta = readJson(join(dir, "log-meta.json"));
    const total = Math.floor(stat(index).size / 8);
    const to = after !== null ? Math.min(total, Math.max(0, Number(after)) + n) : before === null ? total : Math.min(total, Math.max(0, Number(before) - 1));
    const requestedFrom = after !== null ? Math.min(total, Math.max(0, Number(after))) : Math.max(0, to - n);
    const from = Math.min(to, Math.max(requestedFrom, (meta?.firstSequence || 1) - 1));
    if (to <= from) return { total, from: from + 1, to, before: from, lines: [], ids: [], ...(to > 0 && meta?.firstSequence > 1 ? { gap: "rotation/retention removed earlier history" } : {}), generation: stat(file).ino };
    const offsets = readRange(index, from * 8, (to - from + (to < total ? 1 : 0)) * 8, meter);
    if (!offsets.length) return { total, from: from + 1, to, before: from, lines: [], ids: [], generation: stat(file).ino };
    const position = i => Number(offsets.readBigUInt64LE(i * 8)) - (meta?.version === 2 ? 1 : 0);
    let availableFrom = from;
    while (availableFrom < to && position(availableFrom - from) < 0) availableFrom++;
    if (availableFrom === to) return { total, from: to + 1, to, before: from, lines: [], ids: [], gap: "history retained as an explicit gap", generation: stat(file).ino };
    const start = position(availableFrom - from);
    const end = to < total ? position(to - from) : size;
    if (start > size || end > size || end < start) return { total, from: from + 1, to, before: from, lines: [], ids: [], gap: "log rotated or index recovery required", generation: stat(file).ino };
    // Prefer the newest complete lines within the response byte budget.
    let first = availableFrom;
    while (end - position(first - from) > LOG_LIMITS.windowBytes && first < to - 1) first++;
    const pos = position(first - from);
    const data = readRange(file, pos, Math.min(end - pos, LOG_LIMITS.windowBytes), meter).toString("utf8");
    const parsed = data.split("\n").filter(Boolean).map(redactLine);
    const items = boundedItems(parsed.map((line, i) => ({ line, id: first + i + 1 })));
    const actualFirst = items[0]?.id || first + 1;
    return { total, from: actualFirst, to: items.at(-1)?.id || first, before: actualFirst - 1, lines: items.map(x => x.line), ids: items.map(x => x.id), ...(actualFirst - 1 > requestedFrom ? { gap: actualFirst - 1 > from ? "window byte limit or interrupted projection; request an older page" : "rotation/retention removed earlier history" } : {}), generation: stat(file).ino };
  }
  const missingIndex = readJson(join(dir, "log-meta.json"));
  if (missingIndex) return { total: missingIndex.lastSequence, from: missingIndex.lastSequence + 1, to: missingIndex.lastSequence, before: 0, lines: [], ids: [], gap: "projection index unavailable; restore it from the journal before replay", generation: stat(file).ino };
  if (!size) return { total: 0, from: 1, to: 0, before: 0, lines: [], ids: [], generation: stat(file).ino };
  // Small legacy logs keep exact line-number contracts. Large legacy histories
  // use stable byte positions until a coordinator has built their projection.
  const byteMode = size > LOG_LIMITS.windowBytes;
  const end = byteMode && before !== null ? Math.min(size, Math.max(0, Number(before) - 1)) : size;
  const start = Math.max(0, end - LOG_LIMITS.windowBytes);
  const data = readRange(file, start, end - start, meter);
  let pos = 0, items = [];
  while (pos < data.length) {
    const newline = data.indexOf(10, pos), endOfLine = newline < 0 ? data.length : newline;
    const part = data.subarray(pos, endOfLine).toString("utf8");
    if (part && !(start > 0 && pos === 0)) items.push({ line: redactLine(part), id: byteMode ? start + pos + 1 : items.length + 1 });
    pos = endOfLine + 1;
  }
  const total = byteMode ? size : items.length;
  if (!byteMode && before !== null) items = items.slice(0, Math.min(items.length, Math.max(0, Number(before) - 1)));
  if (after !== null) items = items.filter(item => item.id > after).slice(0, n);
  else items = items.slice(-n);
  items = boundedItems(items);
  return { total, from: items[0]?.id ?? 1, to: items.at(-1)?.id ?? 0, before: Math.max(0, (items[0]?.id ?? 1) - 1), lines: items.map(x => x.line), ids: items.map(x => x.id), ...(byteMode ? { gap: "legacy log has no line index; replay IDs use byte positions", byteMode: true } : {}), generation: stat(file).ino };
}
const redactLine = line => Buffer.byteLength(line) > LOG_LIMITS.lineBytes ? "[gap: oversized log record]" : redact(line);
