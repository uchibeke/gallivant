// Small filesystem and path helpers shared by every module.
//
// Everything Gallivant owns lives under one home directory (default ~/.gallivant) so that a single `rm -rf` removes
// it and so that permissions can be set once. Paths in config may use `~`, which is expanded here and nowhere else.
import { homedir } from "node:os";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, chmodSync, readdirSync, lstatSync, realpathSync } from "node:fs";

export const HOME = homedir();

/**
 * Gallivant's own version, from its package.json, read once. Reported in the provenance an APort decision carries,
 * so a decision can be traced to the release that asked for it. Unknown rather than fatal if the file is missing:
 * a version string is never worth failing a run over.
 */
const PACKAGE = (() => {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")); }
  catch { return {}; }
})();
export const VERSION = PACKAGE.version || "unknown";

/**
 * The published npm name, read from the same package.json. `init` prints the `npx` and `npm install -g` commands
 * that run this package again, and a name typed into a command module would drift from the one npm publishes.
 */
export const PACKAGE_NAME = PACKAGE.name || "@uchibeke/gallivant";

/**
 * When the code a process is running was last changed, as the newest mtime across `lib/`. Paired with `VERSION`
 * because `VERSION` cannot answer the question this exists for: it comes from package.json, so it stays `0.1.0`
 * across every commit, and a daemon running code from before a fix reports the same string as one running the fix.
 *
 * This is for one failure and it is a bad one. `gallivant up` is long lived and node caches modules at import, so a
 * daemon started before an upgrade keeps executing the old code with no symptom of its own. Observed: a daemon ran
 * for three hours on a `runEnv` that predated its fix by 52 minutes, so every run it spawned failed on a gitconfig
 * path the current code does not name, and the failure looked like a sandbox problem rather than a stale process.
 * Every release can do this again.
 *
 * The newest mtime rather than a git revision, because an operator may run from a tarball or an npm install with no
 * `.git` at all, and because what matters is whether the FILES changed, not whether a commit happened. Unknown rather
 * than fatal, on the same reasoning as `VERSION`.
 */
export const codeStamp = (dir = join(dirname(fileURLToPath(import.meta.url)))) => {
  let newest = 0;
  const walk = d => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".mjs")) { try { newest = Math.max(newest, statSync(full).mtimeMs); } catch { /* raced */ } }
    }
  };
  walk(dir);
  return newest ? Math.round(newest) : null;
};

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
/**
 * A file that ships inside the package, resolved from this module so it is found wherever the package is installed.
 * Every quickstart and one of doctor's fix lines used to name `templates/<file>` relative to the reader's cwd, which
 * resolved only inside a clone. Paths into the package are this module's business, not a command's.
 */
export const templatePath = name => fileURLToPath(new URL(`../templates/${name}`, import.meta.url));

export const contract = p => (p && p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

export function ensureDir(dir, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  // mkdirSync's mode is masked by umask and ignored for existing dirs; set it explicitly for our private dirs.
  try { chmodSync(dir, mode); } catch { /* not ours to change */ }
  return dir;
}

export const exists = p => existsSync(p);

/** True only for a directory that is there now. A file or a broken symlink is not one. */
export const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };

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

// Resolve existing ancestors of fresh destinations; dangling symlinks fail closed.
export function canonicalPath(path) {
  path = resolve(path);
  try { lstatSync(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
  return realpathSync(path);
}
