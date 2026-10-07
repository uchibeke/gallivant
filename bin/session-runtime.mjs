import { appendFileSync } from "node:fs";
import { sessionExports } from "../lib/runtime-environment.mjs";

if (!process.env.CLAUDE_ENV_FILE) {
  process.stderr.write("Gallivant runtime setup: CLAUDE_ENV_FILE unavailable; Node tool runtime is unverified.\n");
  process.exitCode = 1;
} else {
  appendFileSync(process.env.CLAUDE_ENV_FILE, sessionExports(process.execPath, process.cwd()));
  process.stdout.write(JSON.stringify({ hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: `Gallivant tool runtime: ${process.execPath} (${process.platform}/${process.arch}, ${process.version}). PATH is restored before Bash commands. Verify node -p process.execPath before installing native dependencies. Do not replace native packages to compensate for a different interpreter.`,
  } }));
}
