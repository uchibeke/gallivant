import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { repositoryIdentity } from "./repository.mjs";

const recipeOwners = {
  "review-output-retry": "reviewer",
  "feedback-continuation": "author",
  "publication-continuation": "author",
  "provider-continuation": "author",
  "route-handoff": "author",
  "git-repair": "author",
  "ci-repair": "verification",
  "workspace-cleanup": "delivery",
};
export const qualificationOwnerFor = recipe => Object.hasOwn(recipeOwners, recipe) ? recipeOwners[recipe] : null;
export const semanticRecipe = recipe => recipe === "git-repair" || recipe === "ci-repair";
export const rolloutTaskBinding = (id, entry) => digest([id, entry.repo, entry.branch, entry.base,
  entry.task?.revision, entry.task?.digest, entry.snapshot_digest, entry.sources_digest, entry.recovery_profile]);
export function currentQualificationSource(registry, source) {
  if (!source) return false;
  const admin = registry.recovery, task = registry.entries[source.task];
  const profile = admin?.profiles.find(item => item.digest === source.profile);
  const hold = admin?.holds?.[`profile/${profile?.id}`];
  return Boolean(task?.recovery_profile?.digest === source.profile && profile?.mode === "recover" && profile.qualification?.digest === source.manifest &&
    !hold?.active && (hold?.generation ?? 0) === source.generation);
}
export function recoveryCombination({ surface, harness, recipe, route, environment }) {
  return digest({ surface, harness, recipe, route, environment, owner: qualificationOwnerFor(recipe) });
}

export function rolloutAllows(registry, id, profile, route, recipe, proof, now) {
  const entry = registry.entries[id], admission = registry.recovery?.canaries?.[profile.id];
  if (registry.version !== 3 || !admission || admission.version !== 1 || admission.stage === "observe" ||
      !currentQualificationSource(registry, admission.source) ||
      admission.profile !== profile.digest || !admission.artifact || admission.artifact !== proof.artifact ||
      !Number.isSafeInteger(admission.expiresAt) || admission.expiresAt <= now ||
      !admission.tasks || !Object.hasOwn(admission.tasks, id) || admission.tasks[id] !== rolloutTaskBinding(id, entry) ||
      semanticRecipe(recipe) && admission.stage !== "semantic" ||
      !["operational", "semantic"].includes(admission.stage) || !Array.isArray(admission.combinations)) return false;
  const host = repositoryIdentity(entry.repo).host;
  if (host === "github.com" && proof.surface !== "github" || host === "bitbucket.org" &&
      !["bitbucket-private", "bitbucket-public"].includes(proof.surface) || !["github.com", "bitbucket.org"].includes(host)) return false;
  const environment = proof.environment;
  if (environment?.platform !== process.platform || environment.arch !== process.arch || environment.node !== process.version) return false;
  return admission.combinations.includes(recoveryCombination({ surface: proof.surface, harness: route.harness, recipe,
    route: digest(route), environment }));
}
