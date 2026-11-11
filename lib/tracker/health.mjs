// Read-only, allowlisted observations. No credentials, probe prose or executable paths.
import { readDaemon } from "../daemon.mjs";
import { executionCapabilities } from "../capabilities.mjs";
import { HOST_DEFINITIONS } from "../host_definitions.mjs";
import { assertRepositoryAccess } from "../host_contract.mjs";
import { repoNames } from "../config.mjs";
import { makeProviderHealth, coordinatorHealthLimits } from "../provider_health.mjs";
import { probeFix } from "../probe.mjs";
import { providerPresentation } from "./provider_presentation.mjs";
import { instant } from "./presentation_time.mjs";

export function coordinatorPresentation(daemon, { now = Date.now(), pollSeconds = 120 } = {}) {
  const observedAt = instant(daemon?.lastTick) || instant(daemon?.startedAt);
  const nextAt = instant(daemon?.nextTick);
  let state = "unknown", nextStep = "No coordinator observation is recorded. Check setup with gallivant doctor, then start services with gallivant up.";
  if (daemon?.unverified) nextStep = "The process identity cannot be verified. Inspect it with gallivant status before stopping or restarting services.";
  else if (daemon?.runtimeBusy) { state = "busy"; nextStep = "Runtime maintenance or delivery owns the workspace. Wait for it to release ownership before starting the daemon."; }
  else if (daemon?.alive === false) { state = "down"; nextStep = "The coordinator is stopped. Run gallivant up to resume observation; existing task activity is preserved."; }
  else if (daemon?.alive === true) {
    const overdue = observedAt && now - Date.parse(observedAt) > Math.max(30_000, pollSeconds * 3000);
    if (daemon.stale || overdue) {
      state = "stale";
      nextStep = daemon.stale ? "Installed code changed. Run gallivant down, then gallivant up. Active agent runs keep going." : "The last coordinator observation is overdue. Inspect gallivant status and the coordinator log before restarting; a slow cycle does not prove task failure.";
    } else if (daemon.starting) { state = "busy"; nextStep = "The coordinator is starting. Wait for its first completed cycle; refreshing this page does not start work."; }
    else if (observedAt) { state = "up"; nextStep = "The coordinator is observing work. Task progress and provider readiness are separate facts."; }
    else nextStep = "The coordinator process is present, but no observation time is recorded. Inspect gallivant status.";
  }
  return { state, observedAt, nextAt, nextStep, source: daemon ? "daemon observation" : null };
}

const tri = value => value === true ? "qualified" : value === false ? "not qualified" : "unknown";
// Reuse the dispatch reader, including expiry, for every presentation caller.
export function providerObservations(ctx) {
  const reader = makeProviderHealth({ home: ctx.home, clock: ctx.clock || Date, limits: coordinatorHealthLimits(ctx.config.execution) });
  return Object.fromEntries(executionCapabilities().map(cap => {
    const configured = ctx.config.harness?.[cap.name];
    const observation = configured ? reader.get(cap.name, configured.account || "operator") : null;
    // The dispatch reader fences a missing record as pending. With no saved
    // observation, the UI cannot claim a check has actually been scheduled.
    return [cap.name, instant(observation?.observedAt) ? observation : null];
  }));
}
export function systemHealth(ctx, { daemon = readDaemon(ctx.home), observations = providerObservations(ctx) } = {}) {
  const now = (ctx.clock || Date).now();
  const registry = executionCapabilities().map(c => ctx.capabilitiesFor?.(c.name) || c);
  const providers = registry.map(cap => {
    const configured = !!ctx.config.harness?.[cap.name];
    // Account selection is private. The UI only receives the selected account's
    // safe status; get() applies the same saved expiry fence as dispatch.
    const observation = observations[cap.name];
    const account = providerPresentation(observation, cap);
    const local = cap.transport === "cli";
    const installed = local ? account.scope && account.observedAt ? "observed installed" : "unknown" : "unknown; hosted transport dependencies checked at start";
    const ready = !cap.available || !configured ? "unavailable" : observation?.pending ? "pending" : observation?.ok === false ? "unavailable" : observation?.ok === true && account.observedAt ? "readiness check passed; start rechecks" : "unknown";
    // Only adapter-owned remedies are allowed, never saved arbitrary fix/detail strings.
    let nextStep = !configured ? "Add this provider to the operator configuration, then run gallivant doctor." : !cap.available ? cap.fix || cap.reason : account.status === "pending" ? probeFix(cap.name, { detail: "provider/account check pending" }) : observation?.ok === false ? "Run gallivant doctor to inspect the current failure. Repair the reported prerequisite through the CLI; the coordinator retries on its saved schedule." : "Start and Resume enforce readiness again. Model access is unproven by installation or sign-in alone.";
    if (account.status === "quota-exhausted") nextStep = "Restore provider quota through the authorized account, then wait for the scheduled readiness check. Use the existing Resume action only after the task prerequisite is repaired.";
    if (configured && cap.available && !observation) nextStep = "No account observation is recorded. Run gallivant doctor to check setup and inspect coordinator status before waiting for a scheduled check.";
    return { name: cap.name, registered: true, transport: local ? "Local" : "Hosted", installed,
      configured, supported: cap.available === true, qualification: tri(cap.liveQualified), account,
      dispatch: ready, nextAt: instant(observation?.nextAttemptAt), nextStep,
      preparation: !!cap.preparation, interrupt: cap.controls?.interrupt === true,
      hosts: HOST_DEFINITIONS.map(host => {
        let reason = !cap.available ? cap.reason || "Provider dispatch is unavailable." : null;
        try { assertRepositoryAccess(cap, { host: host.host }); }
        catch { reason = "This provider does not declare repository access for this host."; }
        return { host: host.host, available: !reason && host.dispatch !== false, reason: reason || host.dispatchReason || null };
      }) };
  });
  return { observedAt: instant(now), coordinator: coordinatorPresentation(daemon, { now, pollSeconds: ctx.config.poll_seconds }), providers,
    hosts: HOST_DEFINITIONS.map(host => ({ host: host.host, supported: host.dispatch !== false,
      pullRequests: host.capabilities.pullRequests === true, labels: host.capabilities.labels === true,
      nextStep: host.dispatchReason || (host.capabilities.labels ? "Pull requests and labels are supported. Repository permissions and review policy are checked at start." : "Pull requests are supported. Labels are unavailable on this host; readiness uses the recorded review policy.") })),
    setup: { repositories: repoNames(ctx.config).length, tasks: ctx.state.entries().length,
      configuredProviders: providers.filter(p => p.configured).length } };
}
