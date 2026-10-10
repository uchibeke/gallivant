import { validateAgentsConfig } from "./openai_agents_config.mjs";
// Managed Codex session transport under the shared execution/coordinator contract.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { agentsHttp, AGENTS_LIMITS } from "./openai_agents_http.mjs";
import { contentHash, portablePath, AGENTS_WORKSPACE_HELPER } from "./openai_agents_sources.mjs";
import { readJson, writeJsonAtomic, ensureDir } from "./fs.mjs";
import { executionError, collectionValidationError, dispatchNotSentError, redact, validProviderTestRecords } from "./execution_io.mjs";
import { assertRepositoryTargets } from "./repository_files.mjs";
import { requireVerificationSandbox } from "./execution_result.mjs";
import { agentsPreparation, intakeAgent, intakeSettings, assertIntakeInput, assertIntakeSession, assertIntakeItems, intakeText } from "./preparation_agents.mjs";
const id = value => { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) throw executionError("AGENTS_ID", "invalid provider identity"); return value; };
const sessionPath = session => `/agents/sessions/${id(session)}`;
const stateFor = status => ({ queued: "queued", in_progress: "running", waiting: "waiting-for-input", completed: "succeeded", failed: "failed", cancelled: "cancelled" })[status];
export { validateAgentsConfig } from "./openai_agents_config.mjs";
export const agentsCredential = config => () => config.api_key_file ? readFileSync(config.api_key_file, "utf8").trim() : process.env.OPENAI_API_KEY;
export async function checkAgentsAccess(config, { signal, http = null } = {}) {
  try {
    signal ||= AbortSignal.timeout(10_000);
    validateAgentsConfig(config);
    const api = http || agentsHttp({ credential: agentsCredential(config), organization: config.organization, project: config.project });
    const model = await api.request(`/models/${encodeURIComponent(config.model)}`, { signal });
    if (model?.id !== config.model) throw executionError("AGENTS_MODEL", "account cannot retrieve the exact selected model");
    await api.page("/agents/sessions", signal);
    if (config.environment_template_id) await api.request(`/agents/environments/templates/${id(config.environment_template_id)}`, { signal });
    return { ok: true, detail: "Agents read access and selected model visible; inference and hosted setup remain unverified until dispatch", effective: { account: config.account, organization: config.organization, project: config.project, model: config.model, environment: config.environment, container_size: config.container_size, network: config.network, allowance: config.allowance, cost: { source: "API tokens plus hosted compute", hardCap: false }, apiVersion: "agents=v1" } };
  } catch (error) { return { ok: false, detail: error.code || "AGENTS_ACCESS", fix: error.message, ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}) }; }
}

export function makeAgentsTransport({ root, taskId, account, config, http = null, clock = Date }) {
  const api = http || agentsHttp({ credential: agentsCredential(config), organization: config.organization, project: config.project, clock });
  const file = join(root, "agents.json");
  const read = () => {
    const s = readJson(file, { version: 1, taskId, account, organization: config.organization, project: config.project, operations: {}, sessions: {} });
    if (s.version !== 1 || s.taskId !== taskId || s.account !== account || s.organization !== config.organization || s.project !== config.project) throw executionError("EXECUTION_OWNERSHIP", "Agents task/account/project state differs; restore its original configuration");
    return s;
  };
  const save = s => { ensureDir(root); writeJsonAtomic(file, s); };
  const owned = (s, req) => {
    const op = Object.values(s.operations).find(op => op.runId === req.providerJobId);
    if (!op || op.sessionId !== req.sessionId || op.turnId !== req.turnId || op.runId !== req.providerJobId) throw executionError("EXECUTION_OWNERSHIP", "Agents operation does not own this session/root turn");
    return op;
  };
  const assertSession = (session, op) => {
    if (session?.id !== op.sessionId || session.metadata?.task_id !== taskId || session.metadata?.account !== account || session.agent?.model !== config.model) throw executionError("EXECUTION_OWNERSHIP", "retrieved session/model/environment does not identify the owned task/account");
    if (op.kind === "intake") {
      if (op.settings !== intakeSettings(config)) throw executionError("TASK_PREPARATION_BOUNDARY", "intake configuration changed; restore the original account/model settings for recovery");
      assertIntakeSession(session, config);
      op.effective = { account, organization: config.organization, project: config.project, model: session.agent.model, environment: { type: "none" }, preparation: agentsPreparation, allowance: config.allowance, hardSpendCap: false };
      return;
    }
    if (session.environment?.id !== op.environmentId) throw executionError("EXECUTION_OWNERSHIP", "retrieved environment does not identify the owned task");
    const env = session.environment;
    if (env.type !== "openai_hosted" || env.container_size !== config.container_size || env.network?.access !== config.network.access || (config.network.access === "restricted" && (env.network.allowed_domains || []).some(domain => !config.network.allowed_domains.includes(domain)))) throw executionError("EXECUTION_POLICY", "effective hosted environment cannot confirm the selected container/network requirements");
    op.effective = { account, organization: config.organization, project: config.project, model: session.agent.model, environment: { id: env.id, type: env.type, container_size: env.container_size, network: env.network, packages: env.packages ?? null }, allowance: config.allowance, hardSpendCap: false };
  };
  const turn = async (op, signal) => {
    const value = await api.request(`${sessionPath(op.sessionId)}/turns/${id(op.turnId)}`, { signal });
    if (value?.id !== op.turnId || value.session_id !== op.sessionId || value.subagent_id != null || !stateFor(value.status)) throw executionError("AGENTS_PROTOCOL", "authoritative root turn does not match ownership");
    return value;
  };
  async function allPages(path, signal) {
    const results = []; let cursor = null, size = 0;
    for (let n = 0; n < AGENTS_LIMITS.pages; n++) {
      const page = await api.page(path, signal, cursor); size += Buffer.byteLength(JSON.stringify(page.data));
      if (size > AGENTS_LIMITS.responseBytes) throw executionError("AGENTS_SIZE", "saved provider history exceeds bounded recovery; preserve state and narrow the task");
      results.push(...page.data); if (!page.next) return results; cursor = page.next;
    }
    throw executionError("AGENTS_SIZE", "provider pagination exceeds bounded recovery; no truncated result accepted");
  }
  const acknowledge = op => ({ providerJobId: op.runId, sessionId: op.sessionId, turnId: op.turnId, environment: op.environmentId, model: config.model, effective: op.effective });
  async function resolveTurn(s, op, signal) {
    // No arbitrary latest-turn adoption: only one new root after the saved
    // pre-send turn set, in this single-writer session, can resolve acceptance.
    const turns = await allPages(`${sessionPath(op.sessionId)}/turns`, signal);
    const candidates = turns.filter(t => t.subagent_id == null && !(op.previousTurns || []).includes(t.id));
    if (candidates.length !== 1) return null;
    op.turnId = id(candidates[0].id); op.acceptance = "accepted"; save(s); return acknowledge(op);
  }
  async function dispatch(req, continuing = false) {
    const s = read(); let op = s.operations[req.idempotencyKey];
    if (op) { validateAgentsConfig(config); if (op.turnId) return acknowledge(op); throw executionError("EXECUTION_UNKNOWN", "Agents acceptance unknown; reconcile the saved dispatch before retrying"); }
    const source = req.sources, intake = req.kind === "intake";
    let snapshotPath, previous;
    try {
      validateAgentsConfig(config);
      if (intake) {
        assertIntakeInput(req, config, true);
        if (continuing) throw executionError("TASK_PREPARATION_BOUNDARY", "each intake attempt requires a new tool-free session");
      } else if (!source || contentHash(Buffer.from(source.data || "", "base64")) !== source.hash || source.inputHead !== req.inputHead || source.repo !== req.repo || source.branch !== req.branch) throw executionError("AGENTS_SOURCE", "dispatch requires a verified portable snapshot for its exact input head");
      snapshotPath = `/workspace/input-${id(req.runId)}.json.gz`;
      if (continuing) {
        previous = Object.values(s.operations).find(old => old.sessionId === req.sessionId && old.turnId);
        if (!previous) throw executionError("EXECUTION_CONTINUATION", "no owned Agents session to continue");
      }
      if (!intake) await requireVerificationSandbox({ signal: req.signal });
    } catch (error) { throw dispatchNotSentError(error); }
    const helperPath = "/workspace/transport.py";
    const restore = intake ? null : `python3 ${helperPath} restore ${snapshotPath} ${source.hash}`;
    op = { runId: req.runId, key: req.idempotencyKey, kind: intake ? "intake" : "implementation", ...(intake ? { settings: intakeSettings(config) } : {}), inputHead: req.inputHead ?? null, repo: req.repo, branch: req.branch, sourceHash: source?.hash, hashes: source?.hashes, modes: source?.modes, acceptance: "unknown", createdAt: clock.now(), sessionId: req.sessionId || null, environmentId: null, turnId: null, previousTurns: [] };
    s.operations[req.idempotencyKey] = op; save(s);
    if (continuing) {
      op.environmentId = previous.environmentId;
      const session = await api.request(sessionPath(op.sessionId), { signal: req.signal }); assertSession(session, op);
      const environment = await api.request(`/agents/environments/${id(op.environmentId)}`, { signal: req.signal });
      if (session.status === "failed" || environment.status !== "connected") throw executionError("AGENTS_ENVIRONMENT", "session failed or filesystem expired; retain published artifacts, repair setup and explicitly authorize a replacement session");
      op.previousTurns = (await allPages(`${sessionPath(op.sessionId)}/turns`, req.signal)).filter(t => t.subagent_id == null).map(t => t.id);
      if (!["completed", "failed"].includes((await turn(previous, req.signal)).status)) throw executionError("BUSY", "owned root turn has not settled");
      save(s);
      await api.request(`/agents/environments/${id(op.environmentId)}/files`, { method: "POST", signal: req.signal, body: { type: "inline", path: snapshotPath, data: source.data } });
    } else {
      // Conversation-only sessions require initial input (live API, 2026-10-08).
      // Persist its intent first; recovery adopts the exact initial root and
      // never sends that text again. Coding sessions still stage sources first.
      if (intake) { op.sendIntent = true; save(s); }
      const session = await api.request("/agents/sessions", { method: "POST", signal: req.signal, ...(intake ? { key: op.key } : {}), body: {
        agent: intake ? intakeAgent(config) : { model: config.model, ...(config.reasoning ? { reasoning: config.reasoning } : {}), ...(config.service_tier ? { service_tier: config.service_tier } : {}), multi_agent: { enabled: false }, instructions: "Work only in /workspace/repo. Publish requested files and real test records. The application owns GitHub publication; never request or infer credentials.", tools: [{ type: "function", name: "ask_operator", description: "Ask a concise question requiring an operator answer", parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"], additionalProperties: false } }] },
        environment: intake ? { type: "none" } : { type: "openai_hosted", container_size: config.container_size, network: config.network, ...(config.packages ? { packages: config.packages } : {}), ...(config.environment_template_id ? { environment_template_id: config.environment_template_id } : {}), files: [{ type: "inline", path: snapshotPath, data: source.data }, { type: "inline", path: helperPath, data: Buffer.from(AGENTS_WORKSPACE_HELPER).toString("base64") }], setup_commands: [{ command: restore }] },
        metadata: { task_id: taskId, account, dispatch_key: req.idempotencyKey },
        ...(intake ? { input: [{ role: "user", content: [{ type: "input_text", text: req.prompt }] }] } : {}),
      } });
      op.sessionId = id(session.id); op.environmentId = intake ? "none" : id(session.environment?.id); s.sessions[op.sessionId] = { environmentId: op.environmentId }; save(s); assertSession(session, op); save(s);
    }
    if (intake) {
      const stream = await api.subscribe(op.sessionId, req.signal);
      try {
        const ack = await resolveTurn(s, op, req.signal);
        if (!ack) throw executionError("EXECUTION_UNKNOWN", "initial intake turn unresolved; recover by saved metadata without resending");
        return ack;
      } finally { await stream.close(); }
    }
    return send(s, op, req, continuing ? restore : null);
  }
  async function send(s, op, req, restore = null) {
    const stream = await api.subscribe(op.sessionId, req.signal);
    try {
      op.sendIntent = true; save(s);
      const delivery = op.kind === "intake" ? req.prompt : `${restore ? `Before continuing, reconcile to the current coordinator source by running ${restore}. This replaces the previous round filesystem with the verified current branch input.\n` : ""}Work in /workspace/repo. Input revision: ${op.inputHead}.\n${req.prompt}\n\nDelivery: do not push or create a PR from this environment. Write /workspace/pr.json with neutral title and complete receipt body, and /workspace/tests.json with each actual command, exit, output and inputHead. Run python3 /workspace/transport.py publish /workspace/pr.json /workspace/tests.json. Finish only after /workspace/outputs/result.json exists. Preserve the supplied input head; the coordinator verifies, commits and publishes the files.`;
      await api.request(`${sessionPath(op.sessionId)}/events`, { method: "POST", signal: req.signal, key: op.key, body: { events: [{ type: "agent.session.input.message", input: [{ role: "user", content: [{ type: "input_text", text: delivery }] }] }] } });
      op.sendAcknowledged = true; save(s);
      const ack = await resolveTurn(s, op, req.signal);
      if (!ack) throw executionError("EXECUTION_UNKNOWN", "input accepted but root identity unresolved; reconcile saved turns without resending");
      return ack;
    } finally { await stream.close(); }
  }
  async function lookup(req) {
    const s = read(), op = s.operations[req.intent.idempotencyKey];
    if (!op || op.recoveryBlocked) return null;
    let stream;
    const unresolved = () => {
      op.lookupFailures = (op.lookupFailures || 0) + 1;
      if (op.lookupFailures >= 3) op.recoveryBlocked = "three launch reconciliation failures; inspect the recorded dispatch key and repair access before explicitly resetting recovery; input was not resent";
      save(s); return null;
    };
    try {
      if (!op.sessionId) {
        const sessions = await allPages("/agents/sessions", req.signal);
        const matches = sessions.filter(x => x.metadata?.dispatch_key === op.key && x.metadata?.task_id === taskId && x.metadata?.account === account);
        if (matches.length !== 1) return unresolved();
        op.sessionId = id(matches[0].id); op.environmentId = op.kind === "intake" ? "none" : id(matches[0].environment?.id); save(s);
      }
      stream = await api.subscribe(op.sessionId, req.signal);
      const session = await api.request(sessionPath(op.sessionId), { signal: req.signal }); assertSession(session, op);
      if (session.status === "failed" || !op.sendIntent) {
        op.sessionFailed = session.status === "failed";
        op.recoveryBlocked = op.sessionFailed ? "session failed before launch acknowledgement; recover saved outputs and repair setup; no automatic reconnect or replacement" : "session creation recovered before any input send; inspect the saved session and explicitly authorize recovery; no implementation was launched";
        save(s); return null;
      }
      if (!op.turnId && !await resolveTurn(s, op, req.signal)) return unresolved();
    } catch (error) { unresolved(); throw error; }
    finally { await stream?.close(); }
    return inspect({ ...req, ...acknowledge(op) });
  }
  async function inspect(req) {
    const s = read(), op = owned(s, req); let stream = null;
    if (op.recoveryBlocked) throw executionError("AGENTS_RECOVERY_REQUIRED", op.recoveryBlocked);
    // Failed sessions are not reconnected again, even after a process restart.
    try {
      if (!op.sessionFailed) stream = await api.subscribe(op.sessionId, req.signal);
      const session = await api.request(sessionPath(op.sessionId), { signal: req.signal }); assertSession(session, op);
      const rootTurn = await turn(op, req.signal);
      const events = [], checkpoint = op.items || {}, items = await api.page(`${sessionPath(op.sessionId)}/items?turn_id=${id(op.turnId)}`, req.signal, op.itemCursor || null);
      if (op.kind === "intake") assertIntakeItems(items.data, op);
      for (const item of items.data) {
        if (!item.id || item.turn_id !== op.turnId || item.subagent_id != null) throw executionError("AGENTS_PROTOCOL", "saved item does not identify the owned root turn");
        const digest = contentHash(JSON.stringify(item));
        if (checkpoint[item.id] !== digest) events.push({ eventId: `item:${item.id}:${digest}`, type: "output-replace", data: redact({ itemId: item.id, content: item.content, status: item.status }), timestamp: clock.now() });
        checkpoint[item.id] = digest;
      }
      op.items = checkpoint; op.itemCursor = items.next;
      op.itemPages = (op.itemPages || 0) + 1;
      if (items.next && op.itemPages >= AGENTS_LIMITS.pages) throw executionError("AGENTS_SIZE", "saved item pagination exceeds bounded recovery");
      if (!items.next) { op.items = {}; op.itemCursor = null; op.itemPages = 0; } // rescan authoritative current items after each cycle
      if (session.status === "failed") op.sessionFailed = true;
      const actions = (session.required_actions || []).filter(action => action.turn_id === op.turnId);
      op.requiredActions = actions;
      if (actions.length) events.push({ eventId: `actions:${contentHash(JSON.stringify(actions))}`, type: "required-action", data: redact(actions), timestamp: clock.now() });
      op.finalItems ||= {};
      for (const item of items.data) if (["completed", "done"].includes(item.status)) op.finalItems[item.id] = true;
      const finalItems = new Set(Object.keys(op.finalItems));
      op.parts ||= {};
      for (const event of stream?.events || []) {
        if (event.session_id !== op.sessionId || event.turn_id !== op.turnId || event.subagent_id != null || !event.event_id || finalItems.has(event.item_id)) continue;
        const part = `${event.item_id}:${event.output_index}:${event.content_index}`;
        if (!["agent.session.turn.output_text.delta", "agent.session.turn.output_text.done"].includes(event.type) || op.parts[part]?.done) continue;
        const text = event.type.endsWith(".done") ? event.text : (op.parts[part]?.text || "") + (event.delta || "");
        if (typeof text !== "string" || Buffer.byteLength(text) > 16_384 || Object.keys(op.parts).length > 100) continue;
        op.parts[part] = { text: redact(text), done: event.type.endsWith(".done") };
        events.push({ eventId: event.event_id, type: "output-replace", data: { itemId: event.item_id, outputIndex: event.output_index, contentIndex: event.content_index, ...op.parts[part] }, timestamp: clock.now() });
      }
      const environment = op.kind === "intake" ? { id: "none", status: "connected" } : await api.request(`/agents/environments/${id(op.environmentId)}`, { signal: req.signal });
      if (environment.id !== op.environmentId) throw executionError("EXECUTION_OWNERSHIP", "environment identity differs");
      op.environmentState = environment.status; op.usage = rootTurn.usage ?? null; op.rootStatus = rootTurn.status; op.error = redact(rootTurn.error || session.error || null); save(s);
      // Completed artifacts remain recoverable after filesystem expiry. Failure
      // settles only the authoritative owned root; session idle is irrelevant.
      let state = stateFor(rootTurn.status);
      if (!["succeeded", "failed", "cancelled"].includes(state)) {
        if (op.sessionFailed || ["failed", "expired", "deleted"].includes(environment.status)) {
          op.recoveryBlocked = "session/environment unavailable; saved files remain recoverable, filesystem continuity is unverified; no automatic replacement session"; save(s);
          throw executionError("AGENTS_ENVIRONMENT", op.recoveryBlocked);
        }
        if (environment.status !== "connected") state = "provisioning";
      }
      if (events.length > 100 || Buffer.byteLength(JSON.stringify(events)) > 60_000) throw executionError("AGENTS_SIZE", "normalized event page exceeds journal limits");
      if (items.next && ["succeeded", "failed"].includes(state)) state = "running";
      op.recoveryFailures = 0; save(s);
      return { ...acknowledge(op), state, observedAt: clock.now(), completedAt: !["succeeded", "failed", "cancelled"].includes(state) || rootTurn.completed_at == null ? null : rootTurn.completed_at * 1000, events, cursor: op.itemCursor || `snapshot:${contentHash(JSON.stringify(checkpoint))}`, gap: "saved items restore final output; intermediate deltas between bounded subscriptions may be unavailable", costUsd: null, usage: op.usage, environmentState: op.environmentState };
    } catch (error) {
      op.recoveryFailures = (op.recoveryFailures || 0) + 1;
      if (op.recoveryFailures >= 3) op.recoveryBlocked ||= "three reconciliation failures; repair access/configuration, then explicitly reset recovery without resending input";
      save(s); throw error;
    } finally { await stream?.close(); }
  }
  async function collect(req) {
    const s = read(), op = owned(s, req);
    if (op.kind === "intake") assertSession(await api.request(sessionPath(op.sessionId), { signal: req.signal }), op);
    if (op.collectionRejection) throw collectionValidationError("saved immutable artifact was rejected; explicitly resume the same session for correction");
    const rootTurn = await turn(op, req.signal);
    if (!["completed", "failed"].includes(rootTurn.status)) throw executionError("EXECUTION_RESULT", "owned root has not completed");
    if (rootTurn.status === "failed") return { ...acknowledge(op), inputHead: op.inputHead, completedAt: rootTurn.completed_at == null ? null : rootTurn.completed_at * 1000, outcome: { finished: true, ok: false, cost: null, denials: [], error: redact(rootTurn.error || "root turn failed") }, usage: rootTurn.usage ?? null };
    if (op.kind === "intake") {
      const items = await allPages(`${sessionPath(op.sessionId)}/items?turn_id=${id(op.turnId)}`, req.signal);
      return { ...acknowledge(op), inputHead: op.inputHead, completedAt: rootTurn.completed_at == null ? null : rootTurn.completed_at * 1000,
        outcome: { finished: true, ok: true, lastMessage: intakeText(items, op), cost: null, denials: [] }, usage: rootTurn.usage ?? null };
    }
    const artifacts = await allPages(`${sessionPath(op.sessionId)}/artifacts`, req.signal);
    const candidates = artifacts.filter(a => a.turn_id === op.turnId && a.path === "/workspace/outputs/result.json");
    if (candidates.length !== 1 || candidates[0].session_id !== op.sessionId || candidates[0].environment_id !== op.environmentId || !Number.isInteger(candidates[0].size_bytes) || candidates[0].size_bytes > AGENTS_LIMITS.responseBytes) throw executionError("EXECUTION_RESULT", "one bounded completed-turn result artifact is required");
    const bytes = await api.download(`${sessionPath(op.sessionId)}/artifacts/${id(candidates[0].id)}/content`, req.signal);
    if (bytes.length !== candidates[0].size_bytes) throw executionError("EXECUTION_RESULT", "artifact download size differs from immutable metadata");
    let result;
    try {
      try { result = JSON.parse(bytes.toString("utf8")); } catch { throw collectionValidationError("invalid artifact JSON"); }
      if (!result || result.version !== 1 || result.inputHead !== op.inputHead || result.repo !== op.repo || result.branch !== op.branch || !Array.isArray(result.files) || !result.files.length || result.files.length > 100 || !validProviderTestRecords(result.tests, op.inputHead)) throw collectionValidationError("artifact source identity/files/test records are incomplete");
      const paths = [];
      for (const f of result.files) {
        if (!f || f.text !== null && (typeof f.text !== "string" || f.text.includes("\0"))) throw collectionValidationError("artifact must contain regular UTF-8 text files");
        try { paths.push(portablePath(f.path)); } catch { throw collectionValidationError("unsafe or private artifact path"); }
        if (f.beforeHash !== (op.hashes[f.path] ?? null) || f.afterHash !== contentHash(f.text)) throw collectionValidationError("artifact hash/base mismatch");
      }
      try { assertRepositoryTargets(paths, Object.keys(op.hashes)); } catch { throw collectionValidationError("artifact aliases a repository path"); }
    } catch (error) {
      if (error.collectionValidation !== true) throw error;
      // Preserve rejected bytes privately for inspection, never as publication
      // input or public diagnostics. This refusal also fences retries if the
      // coordinator crashes before it can save its application checkpoint.
      const artifact = { id: candidates[0].id, hash: contentHash(bytes), size: bytes.length };
      const cache = `${id(op.runId)}-rejected-artifact.json`;
      writeJsonAtomic(join(root, cache), { version: 1, taskId, providerJobId: op.runId, sessionId: op.sessionId,
        turnId: op.turnId, inputHead: op.inputHead, artifact, contentBase64: bytes.toString("base64") });
      op.collectionRejection = { artifact, cache }; save(s);
      throw error;
    }
    const saved = { ...result, ...acknowledge(op), inputHead: op.inputHead, completedAt: rootTurn.completed_at == null ? null : rootTurn.completed_at * 1000, outcome: { finished: true, ok: true, cost: null, denials: [] }, usage: rootTurn.usage ?? null, artifact: { id: candidates[0].id, hash: contentHash(bytes), turnId: op.turnId } };
    // The boundary also saves result.json before settlement; this download cache
    // independently protects outputs before any explicit session deletion.
    writeJsonAtomic(join(root, `${id(op.runId)}-artifacts.json`), saved); op.savedArtifacts = true; save(s); return saved;
  }
  async function cancel(req) {
    const s = read(), op = owned(s, req), session = await api.request(sessionPath(op.sessionId), { signal: req.signal }); assertSession(session, op);
    const rootTurn = await turn(op, req.signal);
    if (rootTurn.status === "cancelled") return { confirmed: true };
    if (["completed", "failed"].includes(rootTurn.status)) return { confirmed: false };
    const active = (await allPages(`${sessionPath(op.sessionId)}/turns`, req.signal)).filter(t => t.subagent_id == null && !["completed", "failed", "cancelled"].includes(t.status));
    if (active.length !== 1 || active[0].id !== op.turnId) throw executionError("EXECUTION_CONTROL", "session cancellation cannot target a different active root turn");
    await api.request(`${sessionPath(op.sessionId)}/events`, { method: "POST", key: req.idempotencyKey, signal: req.signal, body: { events: [{ type: "agent.session.input.cancel" }] } });
    return { confirmed: (await turn(op, req.signal)).status === "cancelled" };
  }
  async function respond(req, recovering = false) {
    const s = read(), op = owned(s, req);
    if (req.authorized !== true || typeof req.answer !== "string" || Buffer.byteLength(req.answer) > 16_384 || typeof req.idempotencyKey !== "string" || !req.idempotencyKey || req.idempotencyKey.length > 256) throw executionError("EXECUTION_ACTION", "an authorized bounded answer and stable identity are required");
    const key = contentHash(req.idempotencyKey), signature = contentHash(JSON.stringify([op.turnId, req.callId, req.answer]));
    const prior = op.answers?.[key];
    if (prior && prior.signature !== signature) throw executionError("EXECUTION_CONFLICT", "answer identity owns different input");
    if (prior?.accepted) return { accepted: true };
    const stream = await api.subscribe(op.sessionId, req.signal);
    try {
      const session = await api.request(sessionPath(op.sessionId), { signal: req.signal }); assertSession(session, op);
      const rootTurn = await turn(op, req.signal);
      const actions = (session.required_actions || []).filter(a => a.turn_id === op.turnId && a.call_id === req.callId);
      if (actions.length > 1 || actions.some(a => a.type !== "function_call" || a.name !== "ask_operator")) throw executionError("EXECUTION_ACTION", "only the current ask_operator call can receive an answer");
      if (!actions.length) {
        if (!recovering) throw executionError("EXECUTION_ACTION", "the current ask_operator turn/call is not pending");
        const items = await allPages(`${sessionPath(op.sessionId)}/turns/${id(op.turnId)}/items`, req.signal);
        if (items.some(item => !item.id || item.turn_id !== op.turnId || item.subagent_id != null)) throw executionError("AGENTS_PROTOCOL", "answer recovery items do not identify the owned root turn");
        const calls = items.filter(item => item.type === "function_call" && item.call_id === req.callId);
        const outputs = items.filter(item => item.type === "function_call_output" && item.call_id === req.callId);
        if (calls.length !== 1 || calls[0].name !== "ask_operator" || outputs.length !== 1 || outputs[0].status !== "completed" || outputs[0].error != null) throw executionError("EXECUTION_UNKNOWN", "answer is no longer pending and saved items cannot confirm acceptance; inspect the owned turn; no input was sent");
        if (outputs[0].output !== req.answer) throw executionError("EXECUTION_CONFLICT", "saved call output differs from the authorized answer; no input was sent");
      } else {
        if (session.status === "failed" || !["in_progress", "waiting"].includes(rootTurn.status)) throw executionError("EXECUTION_ACTION", "the owned root cannot receive another answer");
        op.answers = { ...op.answers, [key]: { signature, accepted: false } }; save(s);
        await api.request(`${sessionPath(op.sessionId)}/events`, { method: "POST", signal: req.signal, key: req.idempotencyKey,
          body: { events: [{ type: "agent.session.input.tool_result", turn_id: op.turnId, call_id: req.callId, success: true, output: req.answer }] } });
      }
      // Preserve the acknowledgement before stream cleanup or a coordinator
      // checkpoint fails, so retry never needs another input send.
      op.answers = { ...op.answers, [key]: { signature, accepted: true } }; save(s);
      return { accepted: true };
    } finally { await stream.close(); }
  }
  return {
    prepare: async req => {
      if (req.contextPaths?.length) throw executionError("EXECUTION_POLICY", "hosted backend cannot enforce private read-only context");
      validateAgentsConfig(config);
      if (req.kind === "intake") assertIntakeInput(req, config);
      const verificationSandbox = req.kind === "intake" ? null : await requireVerificationSandbox({ signal: req.signal });
      const result = await checkAgentsAccess(config, { signal: req.signal, http: api });
      if (!result.ok) throw executionError(result.detail, result.fix);
      if (req.kind === "intake") return { boundary: agentsPreparation.boundary, environment: "none", model: config.model, settings: intakeSettings(config) };
      const state = read(); state.capabilities = { ...result.effective, verificationSandbox }; save(state); return state.capabilities;
    },
    submit: req => dispatch(req), continue: req => dispatch(req, true), lookup, inspect, collect, cancel,
    respond: req => respond(req), recoverResponse: req => respond(req, true),
    resetRecovery: req => {
      const s = read(), op = owned(s, req);
      if (op.sessionFailed || ["failed", "expired", "deleted"].includes(op.environmentState)) throw executionError("AGENTS_ENVIRONMENT", "failed/expired sessions require saved artifact recovery and explicit replacement authorization");
      if (req.authorized !== true) throw executionError("EXECUTION_CONTROL", "explicit recovery authorization is required");
      op.recoveryBlocked = null; op.recoveryFailures = 0; op.lookupFailures = 0; save(s);
    },
    deleteSession: async req => {
      const s = read(), op = owned(s, req);
      if (!op.savedArtifacts || !["completed", "failed", "cancelled"].includes((await turn(op, req.signal)).status)) throw executionError("EXECUTION_CONTROL", "save published artifacts and settle the root before session deletion");
      await api.request(sessionPath(op.sessionId), { method: "DELETE", signal: req.signal });
    },
  };
}
