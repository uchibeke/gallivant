// The CLI and embedding call the same read-only service. Request data cannot
// supply owner observations, executable diagnostics or a replacement profile.
import { readFileSync, statSync } from "node:fs";
import { resolveHandle } from "../state.mjs";
import { recoveryDigest as digest } from "../recovery_digest.mjs";
import { inspectRecoveryAdmission, validateRecoveryDecision, validateRecoveryProfile } from "../recovery_authority.mjs";
import { adoptRecoveryBatch, adoptionInventory, validateReviewedBatch } from "../recovery_inventory.mjs";
import { turnBinding, authorReadiness } from "../recovery_preflight.mjs";
import { parsePrd } from "../prd.mjs";
import { checkHarness } from "../probe.mjs";
import { resolveCredentialFor } from "../credential.mjs";
import { preflightPackageAuth, selectedPackageAuth } from "../package_auth.mjs";
import { recoveryDispatchDeferred } from "../recovery_io.mjs";
import { capabilitiesFor } from "../harness.mjs";
import { hostApi } from "../hosts.mjs";
import { recoveryAdminIntent } from "../operator_intent.mjs";
import { measureResources, resourceSettings } from "../recovery_resources.mjs";
import { prepareRecoveryCanary, recoveryDrainStatus } from "../recovery_rollout.mjs";

export const recoveryUsage = "recovery inventory [profile-id] | adopt <profile-id> <approval.json> <backup-path> | canary <approval.json> | drain | resources [handle] | preflight <handle> <decision.json> | profile <profile.json> <previous-digest|new> | hold|resume|disable|enable <scope> <generation>";

function readDocument(path) {
  // Schema/parse diagnostics must never echo a credential or source contents.
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    return JSON.parse(readFileSync(path, "utf8"));
  } catch { throw new Error("Supply a readable JSON document of at most 64 KiB."); }
}

// An observation is valid for this evaluation only. Unknown fine-grained PR
// permissions, model access and capture surfaces stay explicit diagnostics.
export async function preflightRecoveryDecision(ctx, id, decision) {
  validateRecoveryDecision(decision);
  const read = () => {
    const registry = ctx.state.load(), entry = registry.entries[id];
    const profile = validateRecoveryProfile(registry.recovery?.profiles.find(p => p.digest === entry?.recovery_profile?.digest));
    const route = profile.routes.find(r => digest(r) === decision.expected.route);
    const snapshot = turnBinding(ctx, id, entry, parsePrd(ctx.readPrd(id), id));
    const run = ctx.executionFor(id, entry.harness).current();
    const result = inspectRecoveryAdmission({ registry, id, run, route, decision, snapshot, now: (ctx.clock ?? Date).now() });
    return { entry, route, result, run, qualification: profile.qualification };
  };
  const { entry, route, run, result, qualification } = read();
  if (decision.purpose === "disposable-qualification") {
    // Only a protected fixture owner can report its actual baseline. A receipt
    // for the standalone verifier or an author route is outside this binding.
    const fixture = { task: id, expected: result.binding, operationKey: decision.operationKey,
      action: decision.action, manifest: decision.manifest, evidenceRoot: qualification.evidenceRoot };
    const binding = digest(fixture);
    let proof;
    try { proof = await ctx.disposableQualificationOwner?.baselineFor({ ...fixture, binding }); }
    catch { /* A missing native surface leaves this fixture ineligible. */ }
    const current = read().result, now = (ctx.clock ?? Date).now();
    const eligible = proof?.binding === binding && proof.disposableOnly === true &&
      proof.owned === true && proof.isolated === true && /^[0-9a-f]{64}$/.test(proof.launchDigest) &&
      Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > now;
    return { ...current, disposable: { eligible, binding, ...fixture,
      ...(eligible ? { launchDigest: proof.launchDigest, expiresAt: Math.min(proof.expiresAt, decision.deadline) }
        : { remedy: "Qualify baseline isolation and ownership for the exact protected disposable launch and manifest." }) } };
  }
  const readiness = await checkAuthorRoute(ctx, id, entry, route, { run, deadline: decision.deadline, revalidate: read });
  const current = read();
  return { ...current.result, readiness };
}

export async function checkAuthorRoute(ctx, id, entry, route, { run, deadline, revalidate, runtimeReady = false, resolvedCredential }) {
  const h = ctx.config.harness[entry.harness], packages = selectedPackageAuth(ctx.config, entry.repo)?.packages ?? [];
  const remote = capabilitiesFor(entry.harness).transport === "remote";
  const request = { repo: entry.repo, route, packages, browser: route.capabilities.includes("browser-capture"),
    privateContext: remote && Boolean(entry.sources?.length) };
  const checks = {}, binding = authorReadiness(request).binding;
  const observe = async (name, fn) => {
    let ok = false;
    try { ok = await fn() === true; }
    catch (error) {
      if (recoveryDispatchDeferred(error)) throw error;
      // Failed proofs use fixed remedies without transport diagnostics.
    } finally { revalidate(); }
    checks[name] = { ok, binding, expiresAt: deadline };
  };
  await observe("host", async () => {
    const api = hostApi(ctx), permissions = await api.repoPermissions(entry.repo);
    if (permissions.archived || !await api.branchExists(entry.repo, entry.base)) return false;
    await api.prListByHead(entry.repo, entry.branch);
    // A successful list does not prove creation rights. Use host proof when
    // available or the same repository-scoped classic OAuth write grant.
    if (permissions.pullRequestCreate === "proved") return permissions.apiRepositoryWrite === "proved";
    const scopes = await (ctx.hosts?.select(entry.repo).api ?? api).tokenScopes?.();
    return permissions.push === true && /(?:^|[,\s])repo(?:$|[,\s])/.test(scopes || "");
  });
  await observe("runtime", async () => runtimeReady || (await (ctx.checkHarness ?? checkHarness)(entry.harness, ctx.config)).ok);
  // Sign-in and model catalog visibility alone cannot attest inference access.
  // Previous successful execution must have used this exact bound route.
  const protectedProof = name => {
    const proof = ctx.authorCapabilityEvidence?.({ id, route, binding, capability: name });
    return proof?.binding === binding && proof.ok === true && Number.isSafeInteger(proof.expiresAt) && proof.expiresAt > (ctx.clock ?? Date).now();
  };
  // Configuration selects a route. The owner must separately attest that its
  // launch enforces the full tuple, including credential and spending bounds.
  await observe("route", () => protectedProof("route"));
  await observe("model", () => h?.model === route.model && (h.account || "operator") === route.account && (protectedProof("model") ||
    run?.execution?.account === route.account && run.execution.model === route.model && run.execution.providerState === "succeeded" &&
    run.execution.recoveryRouteDigest === digest(route)));
  if (request.browser) await observe("browser", () => protectedProof("browser"));
  await observe("storage", async () => { await ctx.git.authorStorage(entry.worktree, ctx.home); return true; });
  if (packages.length) await observe("packages", async () => {
    const credential = resolvedCredential ?? await resolveCredentialFor(ctx, { worktree: entry.worktree, repo: entry.repo });
    await (ctx.packageAuthPreflight ?? preflightPackageAuth)({ config: ctx.config, repo: entry.repo, credential,
      transport: capabilitiesFor(entry.harness).transport, limits: ctx.config.execution });
    return true;
  });
  if (request.privateContext) await observe("privateContext", () => route.capabilities.includes("private-context") &&
    entry.harness === "openai-agents" && h.model === route.model && h.account === route.account &&
    route.environment === h.environment && route.dataLocation === h.data_location);
  return authorReadiness(request, checks, (ctx.clock ?? Date).now());
}

export async function requireAuthorRoute(ctx, id, entry, revalidate, options = {}) {
  if (!entry.recovery_profile) return;
  const admin = ctx.state.load().recovery;
  const profile = validateRecoveryProfile(admin?.profiles.find(p => p.digest === entry.recovery_profile.digest));
  if (profile.mode !== "recover") return;
  const h = ctx.config.harness[entry.harness];
  const matches = profile.routes.filter(route => route.harness === entry.harness && route.model === h?.model && route.account === (h.account || "operator"));
  if (matches.length !== 1) throw new Error("Select one approved route for the configured harness, account and model before author dispatch.");
  const report = await checkAuthorRoute(ctx, id, entry, matches[0], { ...options, deadline: (ctx.clock ?? Date).now() + 60000, revalidate });
  if (!report.ready) throw Object.assign(new Error(report.diagnostics.map(item => item.remedy).join(" ")), { code: "AUTHOR_PREFLIGHT" });
  return digest(matches[0]);
}

export async function recoveryCommand(ctx, args) {
  if (args[0] === "profile" && args.length === 3) {
    const profile = validateRecoveryProfile(readDocument(args[1]));
    const expected = args[2] === "new" ? null : args[2];
    const intent = recoveryAdminIntent(ctx.state.file, "profile", profile.digest, expected);
    return { digest: ctx.state.putRecoveryProfile(profile, expected, intent), mode: profile.mode };
  }
  if (["hold", "resume", "disable", "enable"].includes(args[0]) && args.length === 3 && /^(?:0|[1-9][0-9]*)$/.test(args[2])) {
    const generation = Number(args[2]);
    const intent = recoveryAdminIntent(ctx.state.file, args[0], args[1], generation);
    return ctx.state.setRecoveryHold(args[1], args[0], generation, intent);
  }
  if (args[0] === "inventory" && args.length <= 2) return adoptionInventory(ctx, args[1]);
  if (args[0] === "adopt" && args.length === 4) {
    const approval = readDocument(args[2]);
    const batch = validateReviewedBatch(adoptionInventory(ctx, args[1]), approval);
    const intent = recoveryAdminIntent(ctx.state.file, "adopt", batch.proposalDigest, batch.registry);
    return adoptRecoveryBatch(ctx, args[1], approval, args[3], intent);
  }
  if (args[0] === "canary" && args.length === 2) {
    const approval = readDocument(args[1]), record = prepareRecoveryCanary(ctx, approval);
    const intent = recoveryAdminIntent(ctx.state.file, "canary", digest(record), approval.generation);
    return ctx.state.commitRecoveryCanary(record, approval.generation, intent);
  }
  if (args[0] === "drain" && args.length === 1) return recoveryDrainStatus(ctx.state);
  if (args[0] === "resources" && args.length <= 2) {
    const entry = args[1] ? ctx.state.get(resolveHandle(ctx.state.entries(), args[1])) : null;
    const settings = resourceSettings(ctx.config);
    const { mounts, ...pressure } = measureResources({ stateDir: ctx.home, worktree: entry?.worktree || ctx.config.worktrees, planned: true }, settings);
    return { mode: "dry-run", cleanup: settings.cleanup, ...pressure,
      mounts: Object.fromEntries(Object.entries(mounts).map(([kind, value]) => [kind, value ? { bytes: value.bytes, inodes: value.inodes } : null])),
      ...(entry ? { artifacts: { checkout: { status: entry.workspace_cleanup?.status ?? null, reason: entry.workspace_cleanup?.code ?? null,
        nextAt: entry.workspace_cleanup?.retry_at ?? null }, runtime: { status: entry.runtime_cleanup?.code ?? null,
        class: entry.runtime_cleanup?.stage ?? null, bytes: entry.runtime_cleanup?.bytes ?? null, nextAt: entry.runtime_cleanup?.next_at ?? null } } } : {}) };
  }
  if (args[0] === "preflight" && args.length === 3) {
    const id = resolveHandle(ctx.state.entries(), args[1]);
    return preflightRecoveryDecision(ctx, id, readDocument(args[2]));
  }
  throw new Error(recoveryUsage);
}
