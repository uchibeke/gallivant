// The CLI and embedding call the same read-only service. Request data cannot
// supply owner observations, executable diagnostics or a replacement profile.
import { readFileSync, statSync } from "node:fs";
import { resolveHandle } from "../state.mjs";
import { recoveryDigest as digest } from "../recovery_digest.mjs";
import { inspectRecoveryAdmission, validateRecoveryDecision, validateRecoveryProfile } from "../recovery_authority.mjs";
import { adoptionInventory } from "../recovery_inventory.mjs";
import { turnBinding, authorReadiness } from "../recovery_preflight.mjs";
import { parsePrd } from "../prd.mjs";
import { checkHarness } from "../probe.mjs";
import { resolveCredentialFor } from "../credential.mjs";
import { preflightPackageAuth, selectedPackageAuth } from "../package_auth.mjs";
import { capabilitiesFor } from "../harness.mjs";
import { hostApi } from "../hosts.mjs";
import { recoveryAdminIntent } from "../operator_intent.mjs";

export const recoveryUsage = "recovery inventory [profile-id] | preflight <handle> [decision.json] | profile <profile.json> <previous-digest|new> | hold|resume|disable|enable <scope> <generation>";

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
  const clock = ctx.clock ?? Date;
  const observe = async (name, fn) => {
    let result;
    try { result = await fn(); } catch { /* Expose a fixed remedy, never stderr. */ }
    revalidate();
    checks[name] = result === true ? { ok: true, binding, expiresAt: deadline } : result;
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
  const protectedProof = async name => {
    const proof = await ctx.authorCapabilityEvidence?.({ id, route, binding, capability: name });
    if (proof?.binding === binding && proof.ok === true && Number.isSafeInteger(proof.expiresAt)) {
      return { ok: true, binding, expiresAt: Math.min(proof.expiresAt, deadline) };
    }
  };
  // Configuration selects a route. The owner must separately attest that its
  // launch enforces the full tuple, including credential and spending bounds.
  await observe("route", () => protectedProof("route"));
  await observe("model", async () => {
    if (h?.model !== route.model || (h.account || "operator") !== route.account) return false;
    const proof = await protectedProof("model");
    if (proof) return proof;
    const ex = run?.execution;
    const completedAt = ex?.completedAt ?? run?.endedAt;
    if (ex?.taskId !== id || ex.provider !== entry.harness || ex.account !== route.account || ex.model !== route.model ||
        ex.runId !== run.id || run.id !== entry.last?.run || ex.acceptance !== "accepted" || ex.providerState !== "succeeded" ||
        ex.recoveryProfileDigest !== entry.recovery_profile?.digest || ex.recoveryRouteDigest !== digest(route) ||
        !Number.isSafeInteger(completedAt) || completedAt > clock.now()) return false;
    return { ok: true, binding, expiresAt: Math.min(deadline, completedAt + 60_000) };
  });
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

function selectedProfile(ctx, entry) {
  const admin = ctx.state.load().recovery;
  const profile = validateRecoveryProfile(admin?.profiles.find(p => p.digest === entry.recovery_profile.digest));
  if (entry.recovery_profile.version !== 1 || admin.version !== 1 || profile.storeId !== admin.storeId) {
    throw new Error("Restore the pinned profile in the approved coordinator store.");
  }
  return profile;
}

function matchingRoute(ctx, entry, profile) {
  const h = ctx.config.harness[entry.harness];
  const matches = profile.routes.filter(route => route.harness === entry.harness && route.model === h?.model && route.account === (h?.account || "operator"));
  return matches.length === 1 ? matches[0] : null;
}
const selectRouteRemedy = "Select one approved route for the configured harness, account and model before author dispatch.";

export async function requireAuthorRoute(ctx, id, entry, revalidate, options = {}) {
  if (!entry.recovery_profile) return;
  const profile = selectedProfile(ctx, entry);
  if (profile.mode !== "recover") return;
  const route = matchingRoute(ctx, entry, profile);
  if (!route) throw new Error(selectRouteRemedy);
  const report = await checkAuthorRoute(ctx, id, entry, route, { ...options, deadline: (ctx.clock ?? Date).now() + 60000, revalidate });
  if (!report.ready) throw Object.assign(new Error(report.diagnostics.map(item => item.remedy).join(" ")), { code: "AUTHOR_PREFLIGHT" });
  return { digest: digest(route), assertFresh() {
    if ((ctx.clock ?? Date).now() >= report.expiresAt) throw Object.assign(new Error("Author-route evidence expired during preparation. Refresh the execution owner's evidence before dispatch."), { code: "AUTHOR_PREFLIGHT" });
  } };
}

async function inspectAuthorRoute(ctx, id) {
  const entry = ctx.state.get(id), diagnostics = [];
  if (!entry.recovery_profile) diagnostics.push({ check: "profile", remedy: "Explicitly pin a protected recovery profile when admitting a new task." });
  if (!ctx.config.harness[entry.harness]?.model) diagnostics.push({ check: "model", remedy: "Select an exact model in the approved harness configuration." });
  const profile = entry.recovery_profile && selectedProfile(ctx, entry);
  const route = profile && matchingRoute(ctx, entry, profile);
  if (profile && !route) diagnostics.push({ check: "route", remedy: selectRouteRemedy });
  if (diagnostics.length) return { mode: "observe", readiness: { ready: false, binding: null, expiresAt: null, diagnostics } };
  const prd = parsePrd(ctx.readPrd(id), id);
  const initial = turnBinding(ctx, id, entry, prd);
  const run = ctx.executionFor(id, entry.harness).current();
  const revalidate = () => {
    const current = ctx.state.get(id);
    if (!current || turnBinding(ctx, id, current, prd) !== initial || current.last?.run !== entry.last?.run) {
      throw new Error("The approved author route or run changed during preflight. Inspect the current task revision.");
    }
  };
  const readiness = await checkAuthorRoute(ctx, id, entry, route, { run, revalidate, deadline: (ctx.clock ?? Date).now() + 60000 });
  return { mode: "observe", readiness };
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
  if (args[0] === "preflight" && [2, 3].includes(args.length)) {
    const id = resolveHandle(ctx.state.entries(), args[1]);
    if (args.length === 2) return inspectAuthorRoute(ctx, id);
    return preflightRecoveryDecision(ctx, id, readDocument(args[2]));
  }
  throw new Error(recoveryUsage);
}
