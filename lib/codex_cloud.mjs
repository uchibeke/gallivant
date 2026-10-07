// Supported CLI only. There is no private Cloud HTTP client or review engine.
import { join } from "node:path";
import { execFileAsync, repositoryMatches } from "./gh.mjs";
import { ensureDir, readJson, writeJsonAtomic } from "./fs.mjs";
import { executionError, dispatchNotSentError, redact } from "./execution_io.mjs";
import { validateCloudConfig, CLOUD_VERSION } from "./codex_cloud_config.mjs";
import { contentHash } from "./openai_agents_sources.mjs";
import { cloudDiffResult, CLOUD_RESULT_PATH } from "./codex_cloud_result.mjs";
import { requireVerificationSandbox } from "./execution_result.mjs";
const taskIdFor = value => {
  if (typeof value !== "string" || !/^task_[a-zA-Z0-9_-]{1,200}$/.test(value)) throw executionError("CLOUD_PROTOCOL", "unsupported Cloud task ID; preserve acknowledgement for operator reconciliation");
  return value;
};
const taskUrl = id => `https://chatgpt.com/codex/tasks/${taskIdFor(id)}`;
const stateFor = status => ({ pending: "queued", ready: "succeeded", applied: "succeeded", error: "failed" })[status];
export function cloudCli(config, exec = execFileAsync) {
  return async (args, signal) => {
    // The shared request signal owns the deadline, including submission's
    // acknowledgement window. Keep a bound only for standalone diagnostic calls.
    const { stdout, stderr } = await exec(config.bin, args, { signal, timeout: signal ? 0 : 10_000, maxBuffer: 1_048_576,
      // No GitHub/API credentials or model overrides travel to the CLI. Its own
      // operator sign-in store stays native, outside generated source/prompts.
      env: Object.fromEntries(["PATH", "HOME", "CODEX_HOME", "LANG", "LC_ALL", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME"].filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]])) });
    return args[0] === "login" ? `${stdout}${stderr || ""}` : stdout;
  };
}
async function listPage(cli, config, signal, cursor = null) {
  const args = ["cloud", "list", "--json", "--env", config.environment, "--limit", "20"];
  if (cursor !== null) args.push("--cursor", cursor);
  let page;
  try { page = JSON.parse(await cli(args, signal)); } catch (error) { if (signal?.aborted) throw error; throw executionError("CLOUD_LIST", "Cloud listing failed; check the authorized account/environment using the configured CLI"); }
  if (!Array.isArray(page.tasks) || page.tasks.length > 20 || page.cursor != null && (typeof page.cursor !== "string" || !page.cursor || page.cursor.length > 4096)) throw executionError("CLOUD_PROTOCOL", "invalid Cloud listing page/cursor");
  return page;
}
export async function checkCloudAccess(config, { signal, cli = null } = {}) {
  try {
    validateCloudConfig(config); signal ||= AbortSignal.timeout(10_000); cli ||= cloudCli(config);
    const version = (await cli(["--version"], signal)).trim();
    // Experimental output formats are pinned, rather than assuming a future
    // CLI has the same semantics. Upgrade only after requalification.
    if (!new RegExp(`^codex-cli ${CLOUD_VERSION.replaceAll(".", "\\.")}$`).test(version)) throw executionError("CLOUD_VERSION", `install the qualified Codex ${CLOUD_VERSION} at the configured bin; requalify before changing versions`);
    if (!(await cli(["login", "status"], signal)).includes("Logged in using ChatGPT")) throw executionError("CLOUD_AUTH", "sign in with the authorized operator's ChatGPT account using the configured Codex login; API-key login is unsupported");
    for (const [command, flags] of [["exec", ["--env", "--branch", "--attempts"]], ["list", ["--env", "--json", "--cursor", "--limit"]], ["diff", ["--attempt"]]]) {
      const help = await cli(["cloud", command, "--help"], signal);
      if (flags.some(flag => !help.includes(flag))) throw executionError("CLOUD_VERSION", "required documented Cloud command capability missing");
    }
    await listPage(cli, config, signal);
    return { ok: true, detail: `${version}; ChatGPT sign-in and selected environment listing authorized; inference remains unverified until live dispatch`, effective: { account: config.account, environment: config.environment, repository: config.repository, continuation: "successor-task", costSource: config.billing_source, hardSpendCap: false, nativeCancel: false, providerAttemptId: null } };
  } catch (error) { return { ok: false, detail: error.code || "CLOUD_ACCESS", fix: error.code ? redact(error.message) : "Check the configured executable, authorized ChatGPT login and published Cloud environment; see docs/codex-cloud.md" }; }
}
export function makeCloudTransport({ root, taskId, account, config, cli = cloudCli(config), clock = Date, verification = requireVerificationSandbox, verifyRemote = null }) {
  const path = join(root, "cloud.json");
  const read = () => {
    const s = readJson(path, { version: 1, taskId, account, environment: config.environment, repository: config.repository, operations: {} });
    if (s.version !== 1 || s.taskId !== taskId || s.account !== account || s.environment !== config.environment || !repositoryMatches(s.repository, config.repository)) throw executionError("EXECUTION_OWNERSHIP", "Cloud task/account/environment ownership changed; restore recorded configuration");
    return s;
  };
  const save = s => { ensureDir(root); writeJsonAtomic(path, s); };
  const ack = op => ({ providerJobId: op.taskId, sessionId: op.logicalSessionId, turnId: op.taskId, environment: config.environment,
    effective: { taskUrl: op.url, continuity: op.continuity, parentTaskId: op.parentTaskId, attemptSelector: 1, providerAttemptId: null, rootIdentity: "cloud-task", costSource: config.billing_source, tokenToolLogs: "unavailable" } });
  const owned = (s, req) => {
    const op = Object.values(s.operations).find(op => op.taskId === req.providerJobId);
    if (!op || op.logicalSessionId !== req.sessionId || req.turnId !== op.taskId) throw executionError("EXECUTION_OWNERSHIP", "Cloud request does not own the exact saved task and single-attempt selector");
    return op;
  };
  async function prepare(req) {
    validateCloudConfig(config);
    if (!repositoryMatches(req.repo, config.repository) || req.environment !== config.environment || req.mandatoryPolicy?.length) throw executionError("CLOUD_SOURCE", "selected repository/environment or policy differs");
    const source = req.sources;
    if (!source || !/^[a-f0-9]{40,64}$/.test(req.inputHead || "") || source.inputHead !== req.inputHead || source.repo !== req.repo || source.branch !== req.branch || source.inputBranch !== `${req.branch}-cloud-${req.inputHead}` || contentHash(Buffer.from(source.data || "", "base64")) !== source.hash) throw executionError("CLOUD_SOURCE", "Cloud needs an exact verified pushed snapshot and immutable input branch");
    if (typeof req.prompt !== "string" || Buffer.byteLength(req.prompt) > 65_536 || /(?:\/Users\/|\/home\/|file:\/\/|[A-Z]:\\)/.test(req.prompt)) throw executionError("CLOUD_SOURCE", "Cloud input contains oversized context or absolute local paths; deliver approved repository snapshots");
    await verification({ signal: req.signal });
    const access = await checkCloudAccess(config, { cli, signal: req.signal });
    if (!access.ok) throw executionError(access.detail, access.fix);
    if (typeof verifyRemote !== "function") throw executionError("CLOUD_SOURCE", "Cloud dispatch requires the coordinator's remote revision/hash verifier");
    await verifyRemote(req);
    return { effective: access.effective };
  }
  async function dispatch(req, continuing = false) {
    const s = read(), prior = s.operations[req.idempotencyKey];
    if (prior) {
      if (prior.taskId) return ack(prior);
      throw executionError("EXECUTION_UNKNOWN", "Cloud acknowledgement unknown; inspect saved dispatch, never resubmit");
    }
    let previous;
    try {
      await prepare(req);
      if (continuing) {
        previous = Object.values(s.operations).findLast(op => op.logicalSessionId === req.sessionId && op.taskId);
        if (!previous || !["succeeded", "failed"].includes(previous.state)) throw executionError("EXECUTION_CONTINUATION", "successor requires the same logical session and settled owned predecessor");
      }
    } catch (error) { throw dispatchNotSentError(error); }
    const op = { runId: req.runId, name: req.name, key: req.idempotencyKey, inputHead: req.inputHead, repo: req.repo, branch: req.branch, base: req.base, sources: req.sources,
      taskId: null, logicalSessionId: req.sessionId || null, parentTaskId: previous?.taskId || null, continuity: continuing ? "successor-task" : "initial-task", state: "status-unknown", at: clock.now(), acceptance: "unknown" };
    const envelope = { version: 1, inputHead: op.inputHead, repo: op.repo, branch: op.branch, runId: op.runId, sourceHashes: op.sources.hashes, pr: { title: "<neutral change title>", body: "<complete approved completion receipt>" }, tests: [] };
    const prompt = `${req.prompt}\n\nCloud delivery contract: the coordinator is the only PR writer. Do not push, open/update a PR or contact reviewers. Verify git rev-parse HEAD equals ${op.inputHead} BEFORE making changes; stop on mismatch. Verify approved source SHA-256 hashes: ${JSON.stringify(op.sources.hashes)}. Read the approved brief and sources on this revision; local paths are not delivery.\nContinuity: ${op.continuity}; predecessor: ${op.parentTaskId || "none"}. No native session memory is transferred; the supplied current code, requirements, feedback and decisions are authoritative.\nWrite ${CLOUD_RESULT_PATH} as JSON following this exact identity envelope: ${JSON.stringify(envelope)}. Replace title/body with the actual neutral change and truthful criterion receipt. Record each actual test in tests using command (string), inputHead (exactly ${op.inputHead}), exit (integer), and output (actual output); absent tests stay an empty list. Include this file in the returned diff with all implementation changes. An approved successor may return only this envelope when source changes are unnecessary, including receipt/public-text corrections or their explicit resume; do not invent unrelated edits. The coordinator excludes the envelope from the PR, executes approved Verify commands, and publishes exactly one PR.`;
    if (Buffer.byteLength(prompt) > 100_000) throw dispatchNotSentError(executionError("CLOUD_SIZE", "serialized Cloud delivery contract too large; reduce approved context before dispatch"));
    s.operations[req.idempotencyKey] = op; save(s);
    const output = (await cli(["cloud", "exec", "--env", config.environment, "--branch", op.sources.inputBranch, "--attempts", "1", prompt], req.signal)).trim();
    const urls = output.split(/\s+/).filter(value => /^https:\/\/chatgpt\.com\/codex\/tasks\/task_[A-Za-z0-9_-]+$/.test(value));
    if (urls.length !== 1) throw executionError("EXECUTION_UNKNOWN", "Cloud submission finished without an exact task URL; preserve intent for manual reconciliation");
    op.taskId = taskIdFor(urls[0].split("/").at(-1)); op.url = urls[0]; op.logicalSessionId ||= op.taskId; op.acceptance = "accepted"; op.state = "queued"; op.acknowledgedAt = clock.now(); save(s);
    return ack(op);
  }
  async function observe(req) {
    const s = read(), op = owned(s, req); let cursor = null, totalBytes = 0; const seen = new Set();
    for (let n = 0; n < 20; n++) {
      const page = await listPage(cli, config, req.signal, cursor); totalBytes += Buffer.byteLength(JSON.stringify(page));
      if (totalBytes > 1_048_576) throw executionError("CLOUD_SIZE", "Cloud recovery listing exceeds 1 MiB; narrow environment or recover manually");
      const matches = page.tasks.filter(task => task.id === op.taskId);
      if (matches.length > 1) throw executionError("CLOUD_PROTOCOL", "duplicate Cloud listing identity");
      if (matches.length === 1) {
        const task = matches[0], state = stateFor(task.status);
        // 0.160.0 resolves --env before listing, but its list mapper leaves the
        // row's environment_id null. Every page is scoped by listPage; reject
        // contradictory metadata when supplied without requiring that field.
        // Missing sibling metadata cannot contradict our owned --attempts 1
        // dispatch; an explicit non-single count still refuses collection.
        if (!state || (task.environment_id != null && task.environment_id !== config.environment) || task.url !== taskUrl(op.taskId) || (task.attempt_total != null && task.attempt_total !== 1)) throw executionError("CLOUD_PROTOCOL", "Cloud task environment/status/attempt ownership cannot be proven; best-of-N results are not selected implicitly");
        const observedAt = clock.now(); op.state = state; op.observedAt = observedAt; op.summary = task.summary; op.updatedAt = task.updated_at; save(s);
        const data = { state, providerStatus: task.status, environment: config.environment, environmentSource: "filtered-listing", summary: task.summary, providerUpdatedAt: task.updated_at, taskUrl: op.url, attemptSelector: 1, providerAttemptTotal: task.attempt_total ?? null, providerAttemptId: null, diffAvailable: state === "succeeded" && task.summary?.files_changed > 0, error: state === "failed" ? "provider reports error; detailed tool/token logs unavailable" : null, tokenToolLogs: "unavailable" };
        return { ...ack(op), state, observedAt, costUsd: null, events: [{ eventId: `cloud:${op.taskId}:${contentHash(JSON.stringify(data))}`, timestamp: observedAt, type: "status", provenance: "provider-listing", data }] };
      }
      if (page.cursor == null) throw executionError("CLOUD_NOT_FOUND", "exact saved Cloud task absent; retain unknown status and task link, never adopt newest task");
      if (seen.has(page.cursor)) throw executionError("CLOUD_PROTOCOL", "repeated Cloud pagination cursor");
      seen.add(page.cursor); cursor = page.cursor;
    }
    throw executionError("CLOUD_SIZE", "Cloud listing exceeds bounded 20-page recovery; no implicit task adoption");
  }
  async function inspect(req) {
    try { return await observe(req); }
    catch (error) { error.providerObservationError = true; throw error; }
  }
  async function collect(req) {
    const s = read(), op = owned(s, req);
    if (req.inputHead !== op.inputHead || !["succeeded", "failed"].includes(op.state)) throw executionError("EXECUTION_RESULT", "Cloud task/base has not authoritatively completed");
    const outcome = { ok: op.state === "succeeded", finished: true, cost: null, lastMessage: null, denials: [], error: op.state === "failed" ? "Cloud task failed; inspect retained native task link" : null };
    if (!outcome.ok) return { ...ack(op), inputHead: op.inputHead, outcome };
    const diff = await cli(["cloud", "diff", op.taskId, "--attempt", "1"], req.signal);
    const result = await cloudDiffResult(diff, op, { signal: req.signal });
    return { ...result, ...ack(op), inputHead: op.inputHead, outcome };
  }
  return { prepare, submit: req => dispatch(req), continue: req => dispatch(req, true), inspect, collect,
    lookup: async req => { const op = read().operations[req.intent.idempotencyKey]; return op?.taskId ? inspect({ ...req, ...ack(op) }) : null; },
    cancel: async () => ({ confirmed: false, unsupported: true }) };
}
