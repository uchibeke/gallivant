import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, request } from "node:http";
import { lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { repoNames } from "./config.mjs";
import { acquireCliMutation, acquireRuntimeOwner, readDaemon } from "./daemon.mjs";
import { dispatchCapacity, occupiedAuthorSlots } from "./dispatch_capacity.mjs";
import { checkGh, checkHarness } from "./probe.mjs";
import { boundedCall, dispatchNotSentError, redact } from "./execution_io.mjs";
import { writeJsonAtomic } from "./fs.mjs";
import { repositoryIdentity } from "./repository.mjs";
import { planControl, inspectPlan, inspectPlanApproval, migratePlans, previewPlan } from "./dependency_plan_admission.mjs";
import { newPlanReviewId, operatorBinding } from "./dependency_plan_registry.mjs";
import { planFailure } from "./dependency_plan_anchors.mjs";
import { bindPlanOperator, planOperator } from "./operator_intent.mjs";
import { execFileAsync } from "./process.mjs";
import { recoveryDigest as digest } from "./recovery_digest.mjs";
import { grantPlanCheckout, grantPlanOverlayAccess, isManagedCheckout, localPlanError, localWorkerCommand, localWorkerSpec, planSocketPath,
  privatePlanConfig, privatePlanHome, probePlanWorker, PROOF_MS, validLocalPlan, workerGitCommand } from "./local_plan_boundary.mjs";

// This CLI release enforces admin-required sandbox settings against project overrides.
const PROTECTED_CLAUDE_MINIMUM = "2.1.285";
const workerProbeOptions = harness => harness === "claude" ? { minimumVersion: PROTECTED_CLAUDE_MINIMUM } : {};
const SESSION_MS = 30 * 60_000;
const APPROVAL_MS = 15 * 60_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const message = "Run plan setup --check and restore the qualified worker, grant and installation. Reload the coordinator after configuration changes.";
const setupRequired = () => localPlanError(`Local plan service is unavailable. ${message}`);
const scopes = config => [...new Set(repoNames(config))].sort();
const capacityEnabled = limits => Boolean(limits.graph_authors && limits.graph_per_repository);
const recorded = config => Object.hasOwn(config, "local_plan");
const scopeActions = /^(?:read|queue|observe|link|migrate|hold|unhold|cancel|retry|edit|attach|(?:chain|task)\/[a-z-]+)$/;
const expired = () => planFailure("PLAN_STALE", "The local plan approval expired. Preview and review the current plan again.");
const auth = () => planFailure("PLAN_AUTHORITY", "Obtain an operator session from the private local plan service.");
const hmac = (key, text) => createHmac("sha256", Buffer.from(key, "hex")).update(text).digest("hex");
const socketStat = path => { try { return lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; return null; } };
const enrollment = (spec, account) => digest([spec.fingerprint, spec.worker, account]);

// A checkout-scoped operator token never escapes this home by default. The
// approval window is separate from a browser token and from durable execution.
export function makeLocalPlans(ctx, { specFor = localWorkerSpec, probe = probePlanWorker, exec = execFileAsync, clock = Date } = {}) {
  const { home, config, state } = ctx;
  const enabled = recorded(config), record = config.local_plan;
  const bootPolicy = { repos: scopes(config), capacity: dispatchCapacity(config) };
  let proof, pending, cachedSpec, listener, listenerPid;
  let lastError = enabled ? message : null;
  const path = () => planSocketPath(realpathSync(home));
  const socketRunning = () => socketStat(path())?.isSocket();
  const currentRecord = () => {
    const raw = privatePlanConfig(home);
    if (!enabled || !validLocalPlan(record) || !isDeepStrictEqual(raw.local_plan, record) || !isDeepStrictEqual(record.repositories, bootPolicy.repos) ||
        !isDeepStrictEqual(scopes(raw), bootPolicy.repos) || !isDeepStrictEqual(dispatchCapacity(raw), bootPolicy.capacity)) throw setupRequired();
    for (const key of ["harness", "worktrees", "git_hosts", "github_token_file"]) {
      if (!isDeepStrictEqual(raw[key], bootRaw[key])) throw setupRequired();
    }
    privatePlanHome(home);
    return record;
  };
  const bootRaw = enabled ? (() => { try { return privatePlanConfig(home); } catch { return {}; } })() : null;
  const spec = () => {
    currentRecord();
    const next = specFor(ctx, record.worker);
    if (enrollment(next, record.account) !== record.launch) throw localPlanError(`The installed local plan launcher or runtime changed. ${message}`);
    cachedSpec = next;
    return next;
  };
  const currentProof = () => {
    if (!proof || proof.expiresAt <= clock.now() || !socketRunning()) throw localPlanError(lastError ?? message);
    spec();
    return proof;
  };
  async function verify({ requireSocket = true, checkout = null, checkoutParent = null } = {}) {
    try {
      const selected = spec();
      const socket = socketRunning() ? path() : null;
      if (!socket && requireSocket) throw localPlanError("Start the coordinator with gallivant up to open the local approval socket.");
      if (socket && requireSocket && !listener) {
        const status = await callLocalPlans(home, { op: "status" }, { timeout: 15_000 });
        if (status.launch !== record.launch) throw setupRequired();
      }
      const identity = await probe(selected, { exec, pid: listenerPid ?? process.pid, socket, checkout, checkoutParent });
      if (!isDeepStrictEqual(identity, record.account) || spec().fingerprint !== selected.fingerprint ||
          socket && !socketRunning()) throw setupRequired();
      if (socket) proof = { registry: state.file, qualified: true, workerExcluded: true, launchDigest: record.launch, expiresAt: clock.now() + PROOF_MS };
      lastError = null;
      return selected;
    } catch (error) {
      proof = null;
      lastError = error.code === "PLAN_QUALIFICATION" ? error.message : message;
      throw localPlanError(lastError);
    }
  }
  function refresh() {
    if (!pending) pending = verify().finally(() => { pending = null; });
    return pending;
  }
  function session(repositories, until = Infinity) {
    const current = currentProof();
    if (until <= clock.now()) throw auth();
    const grant = ({ action, scope }) => {
      if (!scopeActions.test(action) || scope.tenant !== "local" || !scope.repositories.every(repo => repositories.includes(repo))) return null;
      if (action === "migrate" && !isDeepStrictEqual(repositories, bootPolicy.repos)) return null;
      if (action === "queue" && !capacityEnabled(bootPolicy.capacity)) return null;
      return hmac(record.key, JSON.stringify([record.owner, action, scope.repositories]));
    };
    return { principal: record.owner, tenant: "local", grant, isolation: { ...current, expiresAt: Math.min(current.expiresAt, until) } };
  }
  const authority = (repositories = bootPolicy.repos, until) => bindPlanOperator(state.file, () => session(repositories, until));
  const dispatchAuthority = enabled ? bindPlanOperator(state.file, () => session(bootPolicy.repos), { dispatchOnly: true }) : undefined;
  const assertDispatch = binding => {
    const plan = state.graphPlan(binding.instanceId);
    if (!plan || !isDeepStrictEqual(operatorBinding(session(bootPolicy.repos), plan.scope), plan.approval.bindings.operator)) throw setupRequired();
  };

  const approvalWindow = () => {
    currentProof();
    const expiresAt = (Math.floor(clock.now() / APPROVAL_MS) + 1) * APPROVAL_MS;
    return { expiresAt, seal: hmac(record.key, `plan-preview:${expiresAt}`) };
  };
  const planContext = planAuthority => ({ planAuthority, planApprovalWindow: approvalWindow, refreshPlanAuthority: refresh,
    assertPlanWindow: window => { if (!isDeepStrictEqual(window, approvalWindow())) throw expired(); } });

  const sign = payload => hmac(record.key, `tracker-session:${payload}`);
  function issueSession(requested) {
    if (!Array.isArray(requested) || !requested.length || requested.length > 64) throw auth();
    const repositories = [...new Set(requested.map(repo => repositoryIdentity(repo).key))].sort();
    if (!repositories.every(repo => bootPolicy.repos.includes(repo))) throw auth();
    const expiresAt = clock.now() + SESSION_MS;
    // A session binds the enrollment and its explicit approved repository list.
    const payload = Buffer.from(JSON.stringify({ repositories, expiresAt, launch: record.launch })).toString("base64url");
    return { session: `${payload}.${sign(payload)}`, expiresAt, repositories };
  }
  function checkSession(token) {
    if (!enabled || !validLocalPlan(record) || typeof token !== "string" || token.length > 8192) return null;
    const [payload, signature, extra] = token.split(".");
    if (extra !== undefined || !/^[a-zA-Z0-9_-]+$/.test(payload) || !/^[a-f0-9]{64}$/.test(signature ?? "") ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(sign(payload)))) return null;
    try {
      const { repositories, expiresAt, launch } = JSON.parse(Buffer.from(payload, "base64url"));
      if (launch !== record.launch || expiresAt <= clock.now() || !repositories.every(repo => bootPolicy.repos.includes(repo))) return null;
      return { repositories, expiresAt };
    } catch { return null; }
  }
  function sessionForRequest(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string" || header.length > 12_000) return null;
    const bearer = header.match(/^Bearer (\S+)$/i)?.[1];
    if (bearer) return checkSession(bearer);
    const basic = header.match(/^Basic ([a-zA-Z0-9+/]+={0,2})$/i)?.[1];
    const login = basic && Buffer.from(basic, "base64").toString("utf8");
    return login?.startsWith("operator:") ? checkSession(login.slice(9)) : null;
  }
  const operatorForRequest = req => {
    const scoped = sessionForRequest(req);
    return scoped ? authority(scoped.repositories, scoped.expiresAt) : undefined;
  };

  async function listen() {
    if (!enabled) return null;
    const root = privatePlanHome(home).root, socket = planSocketPath(root);
    const original = socketStat(socket);
    if (original) {
      if (!original.isSocket() || original.uid !== process.getuid()) throw localPlanError("The local approval socket path is occupied. Inspect it before restarting the coordinator.");
      unlinkSync(socket); // Only the exclusive daemon owner calls listen.
    }
    let active = 0;
    const server = createServer({ requestTimeout: 8000, headersTimeout: 5000, keepAliveTimeout: 1000 }, async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/plan") { res.writeHead(404); res.end(); return; }
      if (active >= 4) { send(res, 503, { code: "PLAN_BUSY", error: "The local plan service is busy. Retry the same request." }); return; }
      active++;
      try {
        const command = await readRequest(req);
        await refresh();
        if (req.destroyed && !req.complete || res.destroyed) return;
        const scope = authority(), scoped = { ...ctx, ...planContext(scope) };
        const { op, ...input } = command;
        let data;
        if (op === "status") data = { launch: currentProof().launchDigest };
        else if (op === "session") { planOperator(state.file, scope); data = issueSession(input.repositories); }
        else if (op === "preview") data = { ...await previewPlan(scoped, input), requestId: newPlanReviewId() };
        else if (op === "approval") data = inspectPlanApproval(scoped, input.requestId);
        else if (op === "control") {
          if (["approve", "approve-tool"].includes(input.stage)) {
            throw planFailure("PLAN_CONSENT", "Open the saved approval link to approve this revision, or use a host that conveys recorded operator consent.");
          }
          data = await planControl(scoped, input);
        }
        else if (op === "inspect") data = inspectPlan(scoped, input.selector);
        else if (op === "migration") data = migratePlans(scoped, input.approve);
        else throw planFailure("PLAN_REQUEST", "Unknown local plan command.");
        send(res, 200, data);
      } catch (error) {
        send(res, 409, { code: String(error.code || "PLAN_ERROR"), error: redact(error.message) });
      } finally { active--; }
    });
    await new Promise((ok, fail) => {
      server.once("error", fail);
      server.listen(socket, () => { server.off("error", fail); ok(); });
    });
    server.on("error", error => { lastError = message; proof = null; ctx.log.warn(`Local plan service: ${error.code}`); });
    listener = server;
    listenerPid = process.pid;
    return () => {
      listener = null; proof = null;
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    };
  }

  const assertLegacyContext = () => {
    if (enabled) return;
    let enrolled = false;
    try { enrolled = recorded(privatePlanConfig(home)); } catch { /* Legacy configs retain their existing behavior. */ }
    if (enrolled) throw setupRequired();
  };
  function authorLaunch(provider, entry, cmd, args, options) {
    if (!enabled) {
      assertLegacyContext();
      const plan = entry?.plan && state.graphPlan(entry.plan.instanceId);
      if (plan?.approval.bindings.window) throw dispatchNotSentError(setupRequired());
      return null;
    }
    // Intake and first-party review use their existing separately enforced
    // tools-disabled preparation route and an explicit sanitized environment.
    if (options.executionKind === "intake" && options.inheritEnv === false && isManagedCheckout(home, options.cwd)) return null;
    return (async () => {
      const configured = Object.hasOwn(config.harness, provider) && config.harness[provider];
      if (!configured || cmd !== configured.bin) throw setupRequired();
      const cwd = realpathSync(options.cwd);
      const selected = await verify({ requireSocket: Boolean(entry?.plan), checkout: cwd });
      const route = selected.routes[provider];
      if (!route || cmd !== route.bin) throw setupRequired();
      if (!isManagedCheckout(selected.worktrees, cwd)) throw localPlanError("Launch the worker only in its managed checkout.");
      if (provider === "claude") {
        const settings = args.indexOf("--settings");
        if (settings < 0 || args[settings + 1] !== route.settings) throw setupRequired();
        // Repository and worker-writable settings cannot supply hooks or grant
        // permissions. Use only the qualified policy and the worker's login.
        args = [...args.slice(0, -1), "--setting-sources", "", "--strict-mcp-config",
          "--mcp-config", '{"mcpServers":{}}', args.at(-1)];
      }
      if (entry?.plan) assertDispatch(entry.plan);
      const git = workerGitCommand(selected, record.account, [], { cwd, env: options.env });
      const launch = localWorkerCommand(selected, record.account, cmd, args, git.options);
      // Do not give a worker a run-directory capability via the runner's env.
      return { ...launch, leaderOnly: true };
    })().catch(error => { throw dispatchNotSentError(error); });
  }

  const checkHarnessOptions = (harness, options = {}) => {
    if (!enabled || !["codex", "claude"].includes(harness)) return options;
    return { ...options, ...workerProbeOptions(harness), launcher: (cmd, args) => {
      const selected = spec(), route = selected.routes[harness];
      if (!route || cmd !== route.bin) throw setupRequired();
      return localWorkerCommand(selected, record.account, cmd, args);
    } };
  };
  const gitBoundary = enabled && {
    provision: async path => {
      const selected = await verify({ requireSocket: false, checkoutParent: dirname(path) });
      await grantPlanCheckout(selected, record.account, path, exec);
    },
    overlayAccess: checkout => {
      if (process.platform !== "linux") return;
      const root = cachedSpec?.worktrees ?? realpathSync(config.worktrees);
      if (!isManagedCheckout(root, resolve(checkout))) return;
      const selected = spec();
      if (checkout !== realpathSync(checkout) || relative(selected.worktrees, checkout).split(sep).length !== 3 ||
          !isManagedCheckout(selected.worktrees, checkout)) throw localPlanError("Use the canonical managed checkout for approved overlays.");
      return (fd, path) => grantPlanOverlayAccess(checkout, record.account, fd, path);
    },
    execute: (cmd, args, options, execute) => {
      const root = cachedSpec?.worktrees ?? realpathSync(config.worktrees);
      if (!isManagedCheckout(root, options.cwd && resolve(options.cwd))) return execute(cmd, args, options);
      const launch = workerGitCommand(spec(), record.account, args, options);
      return execute(launch.cmd, launch.args, { ...options, ...launch.options });
    },
  };
  return { enabled, listen, refresh, dispatchAuthority, assertDispatch, planContext, operatorForRequest, sessionForRequest,
    authorLaunch, checkHarnessOptions, gitBoundary, assertLegacyContext };
}

async function readRequest(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw planFailure("PLAN_REQUEST", "The local plan command is too large.");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw planFailure("PLAN_REQUEST", "Invalid local plan command.");
  return value;
}

function send(res, status, value) {
  if (res.destroyed) return;
  let bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > MAX_RESPONSE_BYTES) {
    status = 413;
    bytes = JSON.stringify({ code: "PLAN_LIMIT", error: "The local plan response exceeds its size bound." });
  }
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(bytes);
}

export function callLocalPlans(home, command, { timeout = 55_000 } = {}) {
  let socket;
  try { socket = planSocketPath(privatePlanHome(home).root); }
  catch (error) { return Promise.reject(error); }
  const data = JSON.stringify(command);
  if (Buffer.byteLength(data) > MAX_REQUEST_BYTES) return Promise.reject(planFailure("PLAN_REQUEST", "The local plan command is too large."));
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: "/v1/plan", method: "POST", agent: false, signal: AbortSignal.timeout(timeout),
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, async res => {
      try {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of res) {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) throw planFailure("PLAN_LIMIT", "The local plan response is too large.");
          chunks.push(chunk);
        }
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (res.statusCode !== 200) throw planFailure(value.code ?? "PLAN_SERVICE", value.error ?? "The local plan request failed.");
        resolve(value);
      } catch (error) { reject(error); }
    });
    req.on("error", error => reject(localPlanError(`The local plan socket request failed (${error.code ?? "unavailable"}). Start or reload the coordinator with gallivant up.`)));
    req.end(data);
  });
}

function proposedCapacity(config) {
  const caps = dispatchCapacity(config);
  const graph_authors = Math.min(caps.graph_authors || 2, caps.authors);
  return { graph_authors, graph_per_repository: Math.min(caps.graph_per_repository || 1, graph_authors, caps.per_repository) };
}

export async function setupLocalPlans(ctx, { check = false, worker }, { specFor = localWorkerSpec, probe = probePlanWorker,
  hostCheck = checkGh, harnessCheck = checkHarness, exec = execFileAsync, tracker = () => null } = {}) {
  const { config, home } = ctx, capacity = dispatchCapacity(config), repos = scopes(config);
  const current = config.local_plan, selected = worker ?? current?.worker ?? "gallivant-worker";
  const hosts = [...new Set(repos.map(repo => repositoryIdentity(repo).host))];
  const names = Object.keys(config.harness);
  const result = { platform: process.platform, architecture: process.arch, host: hosts.length ? hosts : ["github.com"],
    worker: { route: names.join(", "), executable: names.length === 1 ? config.harness[names[0]]?.bin ?? null : null,
      executables: Object.fromEntries(names.map(name => [name, config.harness[name]?.bin ?? null])),
      account: selected ?? null, modelAccess: "unverified" },
    isolation: { launcher: "/usr/bin/sudo", status: "unverified" }, approvalAccess: "unavailable", capacity,
    prerequisite: null, changed: false, reload: false };
  const blocked = reason => ({ ...result, prerequisite: reason });
  let raw, spec, account, launch;
  try {
    raw = privatePlanConfig(home);
    privatePlanHome(home);
    if (socketStat(join(home, "runtime-pin.json"))) return blocked("Use an unpinned local home or its manifest-aware operator service.");
    if (!repos.length || repos.length > 64 || hosts.some(host => host !== "github.com")) return blocked("Configure 1–64 GitHub repositories in repos before enrolling the local operator scope.");
    if (recorded(config) && !validLocalPlan(current)) return blocked("Restore the private local_plan setup record from its matching configuration backup.");
    if (current && selected !== current.worker) return blocked("Reuse the enrolled worker account for this home and its existing provider sessions.");
    spec = specFor(ctx, selected);
    const socket = socketStat(planSocketPath(spec.root))?.isSocket() ? planSocketPath(spec.root) : null;
    const view = socket && current && tracker();
    account = await probe(spec, { exec, socket, trackerPort: view?.alive ? view.port : null });
    launch = enrollment(spec, account);
    result.isolation = { ...result.isolation, status: "worker-excluded", uid: account.uid, launch, socket: socket ? "denied" : "unchecked",
      tracker: view?.alive ? "unauthenticated-mutations-denied" : "unchecked" };
    const host = await boundedCall(signal => hostCheck(ctx.host, { signal }), { deadlineMs: 5000 });
    if (!host.ok) return blocked("Authenticate the configured GitHub host and grant access to the registered repositories. Run gallivant doctor.");
    for (const provider of Object.keys(spec.routes)) {
      const harness = await harnessCheck(provider, config, { signal: AbortSignal.timeout(6000),
        ...workerProbeOptions(provider), launcher: (cmd, args) => localWorkerCommand(spec, account, cmd, args) });
      if (!harness.ok) return blocked(`${harness.fix ? harness.fix + ". " : ""}Install and sign in to the configured ${provider} executable under the dedicated worker account. Model access still needs a separately authorized check.`);
    }
  } catch (error) { return blocked(error.code === "PLAN_QUALIFICATION" ? error.message : `Local prerequisites could not be read (${error.code ?? "invalid configuration"}). Run gallivant doctor and inspect the local setup guide.`); }

  const same = current?.launch === launch && isDeepStrictEqual(current.repositories, repos) && capacityEnabled(capacity);
  if (same) {
    result.approvalAccess = "enrolled";
    result.owner = current.owner;
    if (!socketStat(planSocketPath(spec.root))?.isSocket() || !readDaemon(home)?.alive) {
      result.reload = true;
      return blocked("Start or reload the coordinator with gallivant up to open the approval socket.");
    }
    try {
      const live = await callLocalPlans(home, { op: "status" }, { timeout: 15_000 });
      if (live.launch === launch) return { ...result, approvalAccess: "local-socket" };
    } catch (error) { return blocked(redact(error.message)); }
    return blocked(`The running coordinator uses a different launcher. ${message}`);
  }
  const trackerRunning = () => { const record = tracker(); return record?.alive || record?.exists; };
  if (readDaemon(home)?.alive || trackerRunning()) return blocked("Run gallivant down and rerun setup after the coordinator and standalone tracker have stopped. Existing runs keep their ownership.");
  const busy = () => {
    if (current) return false;
    if ((socketStat(ctx.state.file)?.size ?? 0) > 64 * 1024 * 1024) return true;
    const saved = ctx.state.load();
    return [...occupiedAuthorSlots(saved)].some(slot => saved.entries[slot.id]?.execution?.transport !== "remote");
  };
  const settling = "Observe and settle existing local author runs or unsubmitted reservations before enrolling the worker boundary.";
  if (busy()) return blocked(settling);
  if (check) return blocked(current?.launch !== undefined && current.launch !== launch
    ? "Qualification changed. Restore the original installation or run plan setup to qualify the changed route."
    : "Run plan setup to enroll this operator and enable bounded graph capacity.");
  const runtime = acquireRuntimeOwner(home);
  let mutation;
  try {
    mutation = acquireCliMutation(home);
    if (trackerRunning()) return blocked("Stop the standalone tracker before changing local plan setup.");
    if (!isDeepStrictEqual(privatePlanConfig(home), raw) || specFor(ctx, selected).fingerprint !== spec.fingerprint) return blocked("Configuration or installation changed during setup. Rerun plan setup --check.");
    if (current && !isDeepStrictEqual(account, current.account)) return blocked("Restore the original dedicated OS account and profile before requalifying this home.");
    if (busy()) return blocked(settling);
    const local_plan = { version: 1, worker: selected, account, launch, repositories: repos, owner: current?.owner ?? randomUUID(), key: current?.key ?? randomBytes(32).toString("hex") };
    const dispatch_capacity = { ...raw.dispatch_capacity, ...proposedCapacity(config) };
    writeJsonAtomic(resolve(spec.root, "config.json"), { ...raw, local_plan, dispatch_capacity }, 0o600, { durable: true });
    return { ...result, owner: local_plan.owner, approvalAccess: "enrolled", capacity: { ...capacity, ...dispatch_capacity }, changed: true,
      reload: true, next: "Start the coordinator with gallivant up. Preview the plan and approve the exact digest." };
  } finally { mutation?.release(); runtime.release(); }
}
