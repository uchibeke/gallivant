import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { completeDependencyFixtureResults, dependencyFixtureGroups, dependencyQualificationArtifact, dependencyQualificationMatrix,
  qualifyDependencyPlans } from "../lib/dependency_plan_qualification.mjs";
import { recoveryDigest as digest } from "../lib/recovery_digest.mjs";
import { protectedQualification, qualificationGate } from "../lib/recovery_qualification.mjs";
import { runContracts } from "./qualify-autonomous-recovery.mjs";

const modes = new Set(["--fixtures", "--native", "--live", "--check-evidence"]);

function fixtures(artifact, runtime) {
  const deadline = Date.now() + 240_000, measurements = {};
  const observe = output => {
    for (const [, kind, line] of output.matchAll(/^# dependency-qualification-(load|capacity|browser) (.+)$/gm)) {
      measurements[kind] = JSON.parse(line);
    }
  };
  const results = dependencyFixtureGroups.map(({ id, suites, selected }) => ({ id, ...runContracts(suites, selected, deadline, observe) }));
  const passed = completeDependencyFixtureResults(results) && ["load", "capacity", "browser"].every(kind => measurements[kind]);
  const report = { version: 1, mode: "fixtures", artifact, runtime, results, measurements,
    matrix: dependencyQualificationMatrix(), result: passed ? "passed" : "failed" };
  return { ...report, digest: digest(report) };
}

export async function dependencyQualificationCommand(args, {
  ctx, task = process.env.GALLIVANT_QUALIFICATION_TASK,
} = {}) {
  if (args.length !== 1 || !modes.has(args[0]))
    throw qualificationGate("Choose exactly one of --fixtures, --native, --live, or --check-evidence.");
  const mode = args[0].slice(2), runtime = { node: process.version, platform: process.platform, arch: process.arch };
  if (mode === "fixtures") return fixtures(dependencyQualificationArtifact(), runtime);
  if (!task) throw qualificationGate("Set GALLIVANT_QUALIFICATION_TASK to the exact task with an operator-pinned disposable dependency qualification manifest and evidence root.");
  if (!ctx) {
    const { makeContext } = await import("../lib/context.mjs");
    ctx = makeContext({ readOnly: true });
  }
  protectedQualification(ctx, task, mode);
  const artifact = dependencyQualificationArtifact();
  const evidence = await qualifyDependencyPlans(ctx, task, mode, artifact, { ...runtime, digest: ctx.qualificationEnvironmentDigest });
  return { version: 1, mode, artifact, runtime, ...evidence, result: "passed" };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await dependencyQualificationCommand(process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.result !== "passed") process.exitCode = 1;
  } catch (error) {
    const remedy = ["RECOVERY_QUALIFICATION", "RECOVERY_AUTHORITY"].includes(error.code) ? error.message
      : "Inspect the protected coordinator or fixture diagnostics for the failed prerequisite.";
    console.error(JSON.stringify({ result: "gated", remedy, code: error.code ?? "QUALIFICATION_ERROR" }));
    process.exitCode = 1;
  }
}
