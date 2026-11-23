import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { profileDigest, recoveryRecipes } from "../lib/recovery_authority.mjs";
import { recoveryDigest } from "../lib/recovery_digest.mjs";
import { recoveryCombination, rolloutTaskBinding, semanticRecipe } from "../lib/recovery_eligibility.mjs";

export function admitFixture(ctx, id, recipe, harness = "claude", limits = { mutations: 4, paidTurns: 4, spendMicros: 4_000_000 }, additionalRoutes = [], cleanup = []) {
  const route = { harness, provider: "fixture", model: "fixture", account: "operator", environment: "fixture",
    dataLocation: "local", credentialRef: "credential:fixture", maxSpendMicros: 1_000_000, capabilities: [recoveryRecipes[recipe][0]] };
  const profile = { version: 1, storeId: "fixture", id: "fixture", revision: 1, mode: "recover", recipes: [{ id: recipe, version: 1, limits }],
    taskLimits: limits, routes: [route, ...additionalRoutes], cleanup, revocationGeneration: 0, holdGeneration: 0, qualification: null };
  profile.digest = profileDigest(profile);
  ctx.state.putRecoveryProfile(profile, null, recoveryAdminIntent(ctx.state.file, "profile", profile.digest, null));
  const entry = ctx.state.get(id);
  const run = { id: "fixture-author", running: false, exit: 0, execution: { version: 1, taskId: id, provider: entry.harness,
    runId: "fixture-author", operationId: "original-turn", sessionId: entry.session, account: "operator", transport: "cli",
    acceptance: "accepted", providerState: "succeeded", collected: true, recoveryRouteDigest: recoveryDigest(route) } };
  ctx.state.update(id, { recovery_profile: { version: 1, digest: profile.digest }, execution: run.execution, last: { exit: 0, run: run.id } });
  const artifact = recoveryDigest("fixture artifact");
  const environment = { platform: process.platform, arch: process.arch, node: process.version, digest: recoveryDigest("fixture environment") };
  const surface = entry.repo.startsWith("bitbucket.org/") ? "bitbucket-private" : "github";
  const combinations = profile.routes.map(candidate => recoveryCombination({ surface, harness: candidate.harness, recipe,
    route: recoveryDigest(candidate), environment }));
  const proofTask = "fixture/qualification/proof", proofManifest = recoveryDigest("fixture manifest");
  const proofProfile = { ...profile, id: "fixture-proof", qualification: { reference: "manifest:fixture",
    digest: proofManifest, evidenceRoot: "/fixture-evidence", actions: ["check-evidence"] } };
  proofProfile.digest = profileDigest(proofProfile);
  ctx.state.putRecoveryProfile(proofProfile, null, recoveryAdminIntent(ctx.state.file, "profile", proofProfile.digest, null));
  ctx.state.put(proofTask, { repo: "fixture/qualification", state: "done", recovery_profile: { version: 1, digest: proofProfile.digest } });
  for (const [index, stage] of (semanticRecipe(recipe) ? ["observe", "operational", "semantic"] : ["observe", "operational"]).entries()) {
    const record = { version: 1, generation: index + 1, stage, profile: profile.digest,
      tasks: { [id]: rolloutTaskBinding(id, ctx.state.get(id)) }, combinations: stage === "observe" ? [] : combinations,
      evidence: stage === "observe" ? null : recoveryDigest("fixture evidence"), artifact,
      source: { task: proofTask, profile: proofProfile.digest, manifest: proofManifest, generation: 0 },
      expiresAt: (ctx.clock ?? Date).now() + 86_400_000 };
    ctx.state.commitRecoveryCanary(record, index, recoveryAdminIntent(ctx.state.file, "canary", recoveryDigest(record), index));
  }
  ctx.recoveryQualificationFor = binding => ({ binding, qualified: true, isolated: true, launchDigest: recoveryDigest("fixture"),
    expiresAt: (ctx.clock ?? Date).now() + 60_000, artifact, environment, surface });
  return { profile, route, run };
}
