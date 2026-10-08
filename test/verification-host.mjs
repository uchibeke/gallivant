// CI/operator preflight: exercise the real boundary using synthetic files only.
// On failure print the native probe error rather than 90 downstream assertions.
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareVerificationSandbox } from "../lib/verification_sandbox.mjs";
import { execFileAsync } from "../lib/gh.mjs";

const root = mkdtempSync(join(tmpdir(), "verification-host-"));
const worktree = join(root, "checkout"), home = join(root, "home");
mkdirSync(worktree); mkdirSync(home);
try {
  const spec = await prepareVerificationSandbox({ worktree, home, env: { HOME: home, TMPDIR: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }, async (...args) => {
    try { return await execFileAsync(...args); }
    catch (error) {
      process.stderr.write(JSON.stringify({ command: args[0], code: error.code, stderr: String(error.stderr || "").slice(-4096) }) + "\n");
      throw error;
    }
  });
  console.log(JSON.stringify({ node: process.execPath, platform: process.platform, arch: process.arch, ...spec.evidence }));
} finally { rmSync(root, { recursive: true, force: true }); }
