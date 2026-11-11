import { dirname, delimiter, join, resolve, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, realpathSync, openSync, closeSync, rmSync, symlinkSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { repositoryPath } from "./repository_files.mjs";

export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Tools may put Unix sockets in TMPDIR (104/108-byte limits). Keep their path
// short while their bytes remain in the task clone. Never overwrite an alias.
const canonical = cwd => { try { return realpathSync(cwd); } catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; return resolve(cwd); } };
export const runtimeTemporaryPath = cwd => join(process.platform === "win32" ? tmpdir() : "/tmp", `gvt-${createHash("sha256").update(canonical(cwd)).digest("hex").slice(0, 24)}`);
function checkTemporaryAlias(cwd) {
  const alias = runtimeTemporaryPath(cwd), target = join(canonical(cwd), ".cache", "gallivant", "tmp");
  const stat = lstatSync(alias);
  if (!stat.isSymbolicLink()) throw new Error("task temporary alias is occupied or changed; preserve it and inspect before retrying");
  const destination = readlinkSync(alias);
  if (!isAbsolute(destination) || resolve(destination) !== target) throw new Error("task temporary alias is occupied or changed; preserve it and inspect before retrying");
  return alias;
}
export function removeRuntimeTemporaryAlias(cwd) {
  try { unlinkSync(checkTemporaryAlias(cwd)); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// Use the interpreter that successfully started Gallivant, not a second Node
// selected by a harness shell snapshot (which may have a different ABI/arch).
export function runtimeEnvironment(env = process.env, node = process.execPath, cwd) {
  const bin = dirname(node);
  const cache = cwd ? join(cwd, ".cache", "gallivant", "npm") : null;
  const temporary = cwd ? runtimeTemporaryPath(cwd) : null;
  return {
    PATH: [bin, ...(env.PATH || "/usr/bin:/bin").split(delimiter).filter(p => p && p !== bin)].join(delimiter),
    ...(cache ? { NPM_CONFIG_CACHE: cache, npm_config_cache: cache } : {}),
    ...(temporary ? { TMPDIR: temporary, TMP: temporary, TEMP: temporary } : {}),
  };
}

// Materialize only at dispatch, never while describing/speculating a launch.
// Keep npm ci's cache and standard tool scratch space inside the task clone,
// outside node_modules and ignored without changing a
// repository's tracked ignore rules or granting access to the operator's cache.
export function prepareRuntimeCache(cwd, env) {
  if (!cwd || env.NPM_CONFIG_CACHE !== runtimeEnvironment({}, process.execPath, cwd).NPM_CONFIG_CACHE) return;
  for (const leaf of ["npm", "tmp"]) {
    const ignore = repositoryPath(cwd, `.cache/gallivant/${leaf}/.gitignore`, { createParents: true });
    try { writeFileSync(ignore, "*\n", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if (error.code !== "EEXIST" || readFileSync(ignore, "utf8") !== "*\n") throw error;
    }
  }
  try { symlinkSync(realpathSync(join(cwd, ".cache", "gallivant", "tmp")), runtimeTemporaryPath(cwd), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (error.code !== "EEXIST") throw error; checkTemporaryAlias(cwd); }
}

export function sessionExports(node = process.execPath, cwd) {
  const env = runtimeEnvironment({}, node, cwd);
  return `export PATH=${shellQuote(dirname(node))}:"$PATH"\n` +
    Object.entries(env).filter(([key]) => key !== "PATH").map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join("");
}

export function runtimeReadPaths(node = process.execPath) {
  const paths = [realpathSync(node)];
  for (const name of ["npm", "npx", "pnpm", "corepack"]) {
    let target;
    try { target = realpathSync(join(dirname(node), name)); } catch { continue; }
    let directory = dirname(target);
    for (let depth = 0; depth < 5; depth++) {
      try {
        const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
        if (["npm", "pnpm", "corepack"].includes(pkg.name)) { paths.push(directory); break; }
      } catch {}
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...new Set(paths)];
}

export const RUNTIME_SETTINGS_FILE = "runtime-settings.json";

// A print-mode worker must collect its tools before returning. Background
// notifications are not durable coordinator wakeups. Monitor is separately
// denied by the adapter because this native switch does not disable it.
export const CLAUDE_FOREGROUND_ENV = Object.freeze({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" });

export function claudeRuntimeSettings(settings, destination, node = process.execPath) {
  if (!settings) return settings;
  // Leave missing settings to the native client's existing error handling.
  let source;
  try { source = readFileSync(settings, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return settings; throw error; }
  const original = JSON.parse(source);
  const command = `${shellQuote(node)} ${shellQuote(fileURLToPath(new URL("../bin/session-runtime.mjs", import.meta.url)))}`;
  const merged = {
    ...original,
    env: { ...original.env, ...CLAUDE_FOREGROUND_ENV },
    sandbox: {
      ...original.sandbox,
      filesystem: {
        ...original.sandbox?.filesystem,
        allowRead: [...new Set([...(original.sandbox?.filesystem?.allowRead || []), ...runtimeReadPaths(node)])],
      },
    },
    hooks: {
      ...original.hooks,
      SessionStart: [...(original.hooks?.SessionStart || []), { hooks: [{ type: "command", command }] }],
    },
  };
  // The actual launcher owns this private file, outside the checkout. Exclusive
  // creation refuses symlinks/existing snapshots and never edits source settings.
  const content = JSON.stringify(merged), fd = openSync(destination, "wx", 0o600);
  try { writeFileSync(fd, content); }
  catch (error) { rmSync(destination, { force: true }); throw error; }
  finally { closeSync(fd); }
  return destination;
}
