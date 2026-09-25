// Small filesystem and path helpers shared by every module.
//
// Everything Gallivant owns lives under one home directory (default ~/.gallivant) so that a single `rm -rf` removes
// it and so that permissions can be set once. Paths in config may use `~`, which is expanded here and nowhere else.
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, chmodSync } from "node:fs";

export const HOME = homedir();

/** Gallivant's own directory. Overridable for tests and for running a second instance. */
export const gallivantHome = () => expand(process.env.GALLIVANT_HOME || "~/.gallivant");

/** Expand a leading `~` and make the path absolute. Leaves absolute paths alone. */
export function expand(p) {
  if (!p) return p;
  const s = String(p);
  if (s === "~") return HOME;
  if (s.startsWith("~/")) return join(HOME, s.slice(2));
  return resolve(s);
}

/** Replace the home prefix with `~` for display. */
export const contract = p => (p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

export function ensureDir(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  // mkdirSync's mode is masked by umask and ignored for existing dirs; set it explicitly for our private dirs.
  try { chmodSync(dir, mode); } catch { /* not ours to change */ }
  return dir;
}

export const exists = p => existsSync(p);

export const fileMode = p => { try { return statSync(p).mode & 0o777; } catch { return null; } };

export function readText(p, fallback = null) {
  try { return readFileSync(p, "utf8"); } catch { return fallback; }
}

export function readJson(p, fallback = null) {
  const text = readText(p);
  if (text === null) return fallback;
  try { return JSON.parse(text); } catch (e) { throw new Error(`${p} is not valid JSON: ${e.message}`); }
}

/**
 * Write JSON via a temp file and rename, so a reader never sees a half-written file and a crash mid-write leaves
 * the previous version intact. Mode is applied to the temp file before the rename.
 */
export function writeJsonAtomic(p, value, mode = 0o600) {
  ensureDir(dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode, flush: true });
  renameSync(tmp, p);
}

/**
 * `dirMode` is for the one caller that writes outside Gallivant's own home: the PRD copied into a session's
 * checkout, whose parent directories are part of a source tree and must not be clamped to 0o700.
 */
export function writeText(p, text, mode = 0o600, dirMode = 0o700) {
  ensureDir(dirname(p), dirMode);
  writeFileSync(p, text, { mode, flush: true });
}

export function appendLine(p, line, mode = 0o600) {
  ensureDir(dirname(p));
  writeFileSync(p, line.endsWith("\n") ? line : line + "\n", { flag: "a", mode });
}
