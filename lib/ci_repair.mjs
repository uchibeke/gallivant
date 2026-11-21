import { publicationPolicyOf, workArtifactReason } from "./work_artifacts.mjs";
import { parsePrd, verifyCommands } from "./prd.mjs";
import { PRIVATE_PATH } from "./task_repository_context.mjs";

// Workflow, dependency, toolchain and assertion files aren't semantic CI
// repair targets even if a broad implementation contract includes them.
const ciControl = /(?:^|\/)(?:\.[^/]+|(?:tests?|specs?|fixtures?|__tests__)\/|[^/]+\.(?:test|spec)\.[^/]+$|[^/]*(?:lock|shrinkwrap)\.[^/]+$|(?:package\.json|Gemfile|pyproject\.toml|requirements[^/]*\.txt|Cargo\.toml|go\.mod|go\.sum|Makefile|Dockerfile|Jenkinsfile|[^/]*\.ya?ml)$)/i;

export async function scopeCIFailure(ctx, id, entry, baseSha, evidence) {
  if (evidence?.kind !== "semantic" || evidence.baseSha !== baseSha || typeof evidence.stepName !== "string" ||
      ![evidence.run, evidence.attempt, evidence.job, evidence.workflow, evidence.step].every(n => Number.isSafeInteger(n) && n > 0) ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(evidence.head ?? "") || !Array.isArray(evidence.paths)) return null;
  const prd = parsePrd(ctx.readPrd(id), id);
  const policy = publicationPolicyOf(prd, { sources: entry.sources, base: entry.base });
  if (!policy.implementationTargets?.length || !verifyCommands(prd).length) return null;
  const changes = await ctx.git.pathsBetween(entry.worktree, baseSha, evidence.head);
  if (changes.some(path => ciControl.test(path))) return null;
  const targets = policy.implementationTargets.filter(path => path !== entry.prd && !PRIVATE_PATH.test(path) && !ciControl.test(path) && !workArtifactReason(path, policy));
  const paths = [...new Set(evidence.paths.filter(path => changes.includes(path) && targets.includes(path)))].sort();
  if (!paths.length) return null;
  return { ...evidence, paths, targets, cause: ["failed-job", evidence.workflow, evidence.name, evidence.step, evidence.stepName] };
}
