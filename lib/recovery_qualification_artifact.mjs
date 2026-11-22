import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { VERSION } from "./fs.mjs";
import { EXECUTION_VERSION } from "./execution.mjs";
import { JOURNAL_VERSION } from "./execution_journal.mjs";
import { recoveryRecipes } from "./recovery_authority.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { RECOVERY_REGISTRY_VERSION } from "./state.mjs";

export function qualificationArtifact() {
  const root = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"] });
  const sha = file => createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
  const files = [...new Set(git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "bin", "lib", "scripts", "templates", "test", "package.json", "npm-shrinkwrap.json"]).split("\0").filter(Boolean))].sort();
  if (git(["rev-parse", "--show-toplevel"]).trim() !== root || !files.includes("package.json"))
    throw new Error("Use the exact qualification source checkout or the coordinator's independently pinned artifact identity.");
  return { source: git(["rev-parse", "HEAD"]).trim(), sourceTree: git(["rev-parse", "HEAD^{tree}"]).trim(),
    code: digest(files.map(file => [file, sha(file)])), packageVersion: VERSION, package: sha("package.json"),
    packageLock: sha("npm-shrinkwrap.json"), schemas: { registry: RECOVERY_REGISTRY_VERSION, profile: 1, decision: 1,
      observation: 1, execution: EXECUTION_VERSION, journal: JOURNAL_VERSION, qualification: 1 },
    recipes: Object.fromEntries(Object.keys(recoveryRecipes).map(recipe => [recipe, 1])) };
}
