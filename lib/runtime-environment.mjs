import { dirname, delimiter, join } from "node:path";
import { readFileSync, writeFileSync, realpathSync, openSync, closeSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

// Use the interpreter that successfully started Gallivant, not a second Node
// selected by a harness shell snapshot (which may have a different ABI/arch).
export function runtimeEnvironment(env = process.env, node = process.execPath, cwd) {
  const bin = dirname(node);
  const cache = cwd ? join(cwd, "node_modules", ".cache", "gallivant", "npm") : null;
  return {
    PATH: [bin, ...(env.PATH || "/usr/bin:/bin").split(delimiter).filter(p => p && p !== bin)].join(delimiter),
    ...(cache ? { NPM_CONFIG_CACHE: cache, npm_config_cache: cache } : {}),
  };
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
