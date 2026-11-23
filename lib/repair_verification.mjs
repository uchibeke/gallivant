import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileAsync } from "./process.mjs";
import { verificationEnvironment } from "./execution_result.mjs";
import { prepareVerificationSandbox, validVerificationSandbox } from "./verification_sandbox.mjs";
import { recoveryDigest } from "./recovery_digest.mjs";
import { repairError } from "./base_repair.mjs";

export async function verifyRepair({ root, worktree, head, commands, guard, record,
  sandbox = prepareVerificationSandbox, execute = execFileAsync }) {
  if (!commands.length) throw repairError("The approved repair requires an explicit Verify contract.", "base-repair-verify");
  const home = mkdtempSync(join(root, "repair-verify-"));
  try {
    const env = verificationEnvironment(home);
    const isolation = await sandbox({ worktree, home, env });
    if (!validVerificationSandbox(isolation?.evidence))
      throw repairError("Restore the supported OS verification sandbox before publishing the repaired head.", "base-repair-verify");
    for (const [index, command] of commands.entries()) {
      await guard();
      try {
        await execute(isolation.cmd, [...isolation.args, "/bin/sh", "-c", command], { cwd: worktree, env, timeout: 120_000, maxBuffer: 262_144 });
      } catch (error) {
        record({ index, head, exit: typeof error.code === "number" ? error.code : null, command: recoveryDigest(command) });
        throw repairError(`Approved Verify command ${index + 1} failed. Inspect the verification receipt and reconcile the local repair.`, "base-repair-verify");
      }
      record({ index, head, exit: 0, command: recoveryDigest(command) });
    }
    await guard();
  } finally { rmSync(home, { recursive: true, force: true }); }
}
