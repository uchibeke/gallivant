import { recoveryAdminIntent } from "../lib/operator_intent.mjs";
import { profileDigest, recoveryRecipes } from "../lib/recovery_authority.mjs";
import { recoveryDigest } from "../lib/recovery_digest.mjs";

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
  ctx.recoveryQualificationFor = binding => ({ binding, qualified: true, isolated: true, launchDigest: recoveryDigest("fixture"),
    expiresAt: (ctx.clock ?? Date).now() + 60_000 });
  return { profile, route, run };
}
