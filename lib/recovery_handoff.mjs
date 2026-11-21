// Only a local target that can preassign a fresh native session and enforce
// the bounded turn cost is supported. The protected profile names both routes.
import { join } from "node:path";
import { executionRunner, reserveExecutionEpoch } from "./execution.mjs";
import { acquireProcessLock } from "./daemon.mjs";
import { readJson } from "./fs.mjs";
import { adapterFor, capabilitiesFor } from "./harness.mjs";
import { recoveryDigest as hash } from "./recovery_digest.mjs";
import { checkAuthorRoute } from "./commands/recovery.mjs";
import { planRecovery } from "./recovery_recipes.mjs";
import { authorRouteDigest } from "./recovery_preflight.mjs";
import { parsePrd } from "./prd.mjs";
import { networkRecoveryDeadline, transientProviderFailure, validNetworkRetry, retryPlan } from "./network_recovery.mjs";

const refuse = message => { throw Object.assign(new Error(message), { code: "RECOVERY_AUTHORITY" }); };
function contract(entry) {
  return hash([entry.repo, entry.pr, entry.base, entry.branch, entry.worktree, entry.chain,
    entry.cursor, entry.iteration, entry.task, entry.snapshot_digest, entry.sources_digest, entry.reviewBinding]);
}

// Revalidate the old accepted execution against its immutable ledger on each
// side of the epoch switch. The new session receives only the contract and
// evidence references, never the old session's transcript or credentials.
export async function prepareRecoveryHandoff(ctx, id) {
  const entry = ctx.state.get(id), previous = entry.route_recovery, retry = entry.network_retry;
  const clock = ctx.clock ?? Date;
  const owner = executionRunner(ctx, id);
  if (!owner.root || !validNetworkRetry(retry) || retryPlan(retry.code).kind !== "provider availability" ||
      retry.phase !== "waiting" || Date.parse(retry.next_at) > clock.now() ||
      entry.task?.deliveryAllowance || entry.learning?.rules?.length || entry.learning_continuity || entry.base_repair)
    refuse("Handoff requires an eligible capacity window and transferable task limits.");
  const deadline = networkRecoveryDeadline(retry);
  const assertWindow = () => {
    if (clock.now() >= deadline) throw Object.assign(new Error("Provider retry window expired during handoff."), { code: "NETWORK_RECOVERY_EXPIRED" });
  };
  assertWindow();
  const from = previous?.from ?? entry.harness, fromEpoch = previous?.fromEpoch ?? owner.ledgerEpoch ?? 0;
  const sourceLedger = () => readJson(join(owner.root, fromEpoch ? `execution-${fromEpoch}.json` : "execution.json"));
  const source = sourceLedger(), prior = source?.current, ex = prior?.execution;
  if (!prior || source.taskId !== id || source.provider !== from || source.stopped || ex?.transport !== "cli" ||
      entry.last?.run !== prior.id || retry.run !== prior.id || prior.exit !== entry.last.exit ||
      source.account !== ex.account || ex.taskId !== id || ex.provider !== from || ex.runId !== prior.id ||
      source.operations?.[ex.operationId]?.runId !== prior.id || source.operations[ex.operationId].acceptance !== "accepted" || ex.providerState !== "failed" ||
      !ex.collected || ex.quarantined || ex.cancellation || !ex.sessionId || ex.recoveryProfileDigest !== entry.recovery_profile?.digest)
    refuse("Handoff requires the original terminal, collected, owned operation.");
  const switched = previous && entry.harness === previous.to;
  if (!switched && (entry.session !== ex.sessionId || entry.execution?.operationId !== ex.operationId ||
      owner.current()?.id !== prior.id || owner.current()?.running !== false || transientProviderFailure(owner.outcome(prior.id)) !== retry.code))
    refuse("Inspect original provider failure and cessation before route handoff.");
  const registry = ctx.state.load();
  const profile = registry.recovery?.profiles.find(p => p.digest === entry.recovery_profile.digest);
  const oldRoute = profile?.routes.find(r => hash(r) === ex.recoveryRouteDigest && r.harness === from && r.account === ex.account);
  const targets = profile?.routes.filter(r => r.harness !== from && r.capabilities.includes("handoff-session"));
  if (!oldRoute || targets?.length !== 1) refuse("Select one exact fallback tuple and retain the approved source route.");
  const target = targets[0], adapter = capabilitiesFor(target.harness), selected = ctx.config.harness[target.harness];
  if (adapter.transport !== "cli" || !adapter.cost.hardCap || !(target.maxSpendMicros > 0) ||
      selected?.model !== target.model || (selected.account || "operator") !== target.account)
    refuse("The target must enforce the selected session, model, account and spending limit.");
  const binding = contract(entry);
  const handoff = { version: 1, task: id, contract: binding, snapshot: entry.snapshot_digest, sources: entry.sources_digest,
    route: hash(target), sourceRoute: hash(oldRoute), previousOperation: ex.operationId, epoch: fromEpoch + 1 };
  if (previous && (previous.binding !== binding || previous.handoffDigest !== hash(handoff))) refuse("Restore the original handoff contract and evidence binding.");
  const original = current => ({ ...current, harness: from, execution_epoch: fromEpoch, session: ex.sessionId,
    execution: ex, author_route_digest: previous ? previous.sourceConfig : entry.author_route_digest });
  const originContext = { ...ctx, state: { ...ctx.state, load: () => {
    const r = ctx.state.load(), current = r.entries[id];
    if (current.reason !== "provider-network" || hash(current.network_retry) !== hash(retry) ||
        current.harness !== from && (current.harness !== target.harness || current.execution_epoch !== handoff.epoch) ||
        contract(current) !== binding || current.route_recovery && current.route_recovery.handoffDigest !== hash(handoff) ||
        current.last?.run !== prior.id || hash(sourceLedger()) !== hash(source)) refuse("Handoff ownership or evidence changed.");
    return { ...r, entries: { ...r.entries, [id]: original(current) } };
  } }, executionFor: () => ({ current: () => ({ ...prior, running: false }) }) };
  const plan = planRecovery(originContext, id, "route-handoff", { cause: retry.code, input: handoff, routeDigest: hash(target), spendMicros: target.maxSpendMicros });
  const guard = () => { assertWindow(); plan.guard(); };
  const readiness = await checkAuthorRoute(ctx, id, { ...entry, harness: target.harness }, target,
    { run: null, deadline, revalidate: guard });
  if (!readiness.ready) refuse(readiness.diagnostics.map(item => item.remedy).join(" "));
  const operation = `${prior.id}:${entry.iteration}:handoff:${plan.key}`;
  const session = previous?.session ?? adapterFor(target.harness).newSession();
  if (!session || session === ex.sessionId || previous && previous.intent !== plan.key) refuse("A distinct, preassigned target session is required.");
  const marker = previous || { from, to: target.harness, fromEpoch, epoch: handoff.epoch, binding,
    handoffDigest: hash(handoff), intent: plan.key, operation, session, sourceConfig: entry.author_route_digest ?? null };
  guard();
  plan.reserve(operation);
  if (!previous) ctx.state.update(id, { route_recovery: marker });
  const exclusion = acquireProcessLock(join(owner.root, "execution.lock"), "execution", "route handoff");
  try {
    guard();
    reserveExecutionEpoch({ root: owner.root, taskId: id, provider: target.harness, account: target.account, epoch: marker.epoch, pr: entry.pr,
      recovery: { intent: plan.key, operation, session, previousOperation: ex.operationId, handoffDigest: marker.handoffDigest } });
    if (!switched) {
      guard();
      const nextConfig = authorRouteDigest(ctx.config, target.harness, parsePrd(ctx.readPrd(id), id));
      ctx.state.update(id, { harness: target.harness, session: null, execution_epoch: marker.epoch, author_route_digest: nextConfig,
        execution_handoff: { from, to: target.harness, previousRun: prior.id, intent: plan.key, epoch: marker.epoch } });
    }
  } finally { exclusion.release(); }
  return { plan: { ...plan, guard }, marker, handoff };
}
