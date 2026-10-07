import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";

export function findExecutable(name, env = process.env) {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  for (const directory of (env.PATH || "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, name);
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path; } catch {}
  }
  // Version managers may be initialized only by the operator's login shell.
  // Linux must not depend on zsh or its non-portable `whence` builtin.
  const shells = [...new Set([env.SHELL, "/bin/sh"].filter(p => p && isAbsolute(p)))];
  for (const shell of shells) {
    try {
      const path = execFileSync(shell, ["-lc", `command -v ${name}`], {
        env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (!isAbsolute(path)) continue;
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  return null;
}
