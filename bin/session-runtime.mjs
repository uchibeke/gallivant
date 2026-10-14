import { appendFileSync } from "node:fs";
import { sessionExports } from "../lib/runtime-environment.mjs";

if (!process.env.CLAUDE_ENV_FILE) {
  process.stderr.write("Gallivant runtime setup: CLAUDE_ENV_FILE unavailable; Node tool runtime is unverified.\n");
  process.exitCode = 1;
} else {
  appendFileSync(process.env.CLAUDE_ENV_FILE, sessionExports(process.execPath, process.cwd()));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: `Selected tool runtime: ${process.execPath} (${process.platform}/${process.arch}, ${process.version}). The session environment prepends its directory to PATH for Bash commands. Before installing native dependencies, check node -p 'JSON.stringify({execPath:process.execPath,arch:process.arch,version:process.version})'. Native packages must match the Node process, not hardware architecture alone. If the selected runtime is inaccessible or differs, report the mismatch and blocked read; do not patch native packages, weaken the sandbox or change toolchains to conceal it.`,
  } }));
}
