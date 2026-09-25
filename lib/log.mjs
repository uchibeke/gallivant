// Logging: stderr for the terminal, plus errors.log on disk so `status` can show the newest problem when nobody
// was watching the terminal. The file is rotated at 1 MB and its last line is read from the tail, not the whole file.
import { join } from "node:path";
import { openSync, readSync, fstatSync, closeSync, renameSync } from "node:fs";
import { appendLine, fileMode } from "./fs.mjs";
import { nowIso } from "./time.mjs";

const MAX_BYTES = 1_000_000;

export function makeLog(home, { stream = process.stderr, clock = Date } = {}) {
  const file = join(home, "errors.log");
  const line = (level, msg) => `${nowIso(clock)} ${level} ${msg}`;
  const record = l => {
    try { if (fileSize(file) > MAX_BYTES) renameSync(file, file + ".1"); } catch { /* first write */ }
    appendLine(file, l);
  };
  return {
    info: msg => stream.write(line("info", msg) + "\n"),
    warn: msg => { stream.write(line("warn", msg) + "\n"); record(line("warn", msg)); },
    error: msg => { stream.write(line("error", msg) + "\n"); record(line("error", msg)); },
    /** Newest recorded problem, for the status header. Reads only the tail of the file. */
    latest: () => lastLine(file),
  };
}

const fileSize = p => { const fd = openSync(p, "r"); try { return fstatSync(fd).size; } finally { closeSync(fd); } };

function lastLine(p) {
  if (fileMode(p) === null) return null;
  const fd = openSync(p, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 4096);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString("utf8").trim().split("\n").filter(Boolean);
    return lines.at(-1) || null;
  } finally { closeSync(fd); }
}

export const silentLog = { info() {}, warn() {}, error() {}, latest: () => null };
