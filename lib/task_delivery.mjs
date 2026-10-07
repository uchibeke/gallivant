// APort owns OAuth, audience/region/repository authorization. This adapter has no
// anonymous fallback; every operation reauthorizes before touching scoped state.
import Ajv from "ajv";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTaskService } from "./tasks.mjs";
import { executionCapabilities, capabilitiesFor } from "./harness.mjs";
import { requestControl } from "./control.mjs";
import { controlAvailability } from "./control_contract.mjs";
import { logWindow } from "./run_log.mjs";
import { idSlug } from "./state.mjs";
import { redact } from "./execution_io.mjs";
import { scopeKey } from "./task_delivery_store.mjs";
import { TASK_OPERATIONS, DELIVERY_VERSION, deliveryError } from "./task_delivery_contract.mjs";
import { taskView } from "./task_delivery_view.mjs";
import { readJson } from "./fs.mjs";
const validators = new Map(TASK_OPERATIONS.map(op => [op.name, new Ajv({ strict: true, allErrors: true }).compile(op.inputSchema)]));
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createTaskDelivery({ authorize, contextFor, store, schedule, secretsFor = () => [] }) {
  if (typeof authorize !== "function" || typeof contextFor !== "function" || !store?.transaction || !store?.read || typeof schedule !== "function") throw deliveryError("DELIVERY_CONFIG", "Supply APort authorization, scoped context, durable receipt store and wake-up scheduling adapters");
  const owned = (data, taskId) => {
    if (!Object.hasOwn(data.tasks, taskId)) throw deliveryError("DELIVERY_NOT_FOUND", "Task is unavailable in this account");
    return data.tasks[taskId];
  };
  async function dispatch(name, input, identity) {
    const op = TASK_OPERATIONS.find(o => o.name === name), validate = validators.get(name);
    if (!op || !validate(input)) throw deliveryError("DELIVERY_INPUT", `Invalid ${name} request; use its documented schema (no paths, endpoints or credentials)`);
    const scope = await authorize({ identity, operation: name, requiredScope: op.scope, taskId: input.taskId, repositoryId: input.repositoryId });
    scopeKey(scope);
    const secrets = secretsFor(scope);
    const serialized = JSON.stringify(input);
    if (serialized !== redact(serialized, secrets)) throw deliveryError("DELIVERY_SECRET", "Remove credential material from task text, answers or notes before sending them to a model");
    if (!Array.isArray(scope.scopes) || !scope.scopes.includes(op.scope) || !Array.isArray(scope.repositories)) throw deliveryError("DELIVERY_AUTHORIZATION", "APort did not grant the required scope and repository set");
    const allowedRepo = id => { if (!scope.repositories.includes(id)) throw deliveryError("DELIVERY_AUTHORIZATION", "Repository is unavailable in this account"); };
    const project = (ctx, task) => {
      const entry = task.implementation && ctx.state.get(task.implementation.id);
      const execution = entry && (ctx.executionFor ? ctx.executionFor(task.implementation.id, task.harness) : ctx.runnerFor(task.implementation.id));
      const run = execution?.current();
      const result = run?.id && execution.result?.(run.id);
      const verification = run?.id && /^[A-Za-z0-9_-]+$/.test(run.id) ? readJson(join(ctx.home, "runs", idSlug(task.implementation.id), run.id, "verification.json")) : null;
      const capability = executionCapabilities().find(c => c.name === task.harness);
      return taskView(task, { entry, run, result, verification, capabilities: capability, controls: controlAvailability(entry, run, capability), secrets: [...secretsFor(scope), ctx.home, task.checkout].filter(Boolean) });
    };
    const getContext = async (repoId, allowance) => {
      allowedRepo(repoId);
      // Server configuration resolves all filesystem paths and transport URLs.
      const bound = await contextFor(scope, repoId);
      if (!bound?.ctx || !bound.repository?.dir || !bound.repository?.repo) throw deliveryError("DELIVERY_CONFIG", "APort must bind the authorized repository to a scoped runtime context");
      const ctx = bound.ctx;
      bound.ctx = { ...ctx, taskSecrets: secrets, enforceTaskAllowance: true };
      if (allowance) {
        if (allowance.budgetUsd > ctx.config.max_budget_usd || allowance.runtimeMs > ctx.config.run_timeout_minutes * 60000) throw deliveryError("DELIVERY_ALLOWANCE", "Requested allowance exceeds the configured account limit");
        // Narrow a copy: shared account settings are never mutated by requests.
        bound.ctx = { ...bound.ctx, config: { ...ctx.config, max_budget_usd: allowance.budgetUsd, run_timeout_minutes: allowance.runtimeMs / 60000 } };
      }
      return { ...bound, service: createTaskService(bound.ctx, bound.taskOptions) };
    };
    if (name === "capabilities") {
      const repositories = [];
      for (const id of scope.repositories.slice(0, 100)) {
        const { ctx } = await getContext(id);
        repositories.push({ id, providers: executionCapabilities().map(capability => ({ ...capability,
          configured: Boolean(ctx.config.harness[capability.name]),
          available: capability.available && Boolean(ctx.config.harness[capability.name]),
          accountAccess: "unverified-until-setup-check", setup: capability.reason || (!ctx.config.harness[capability.name] ? "APort must configure this provider for the authorized account" : "Dispatch validates the configured account/model/environment and allowance"),
          canPrepare: Boolean(capability.preparation && capability.available && ctx.config.harness[capability.name]),
          preparationSetup: capability.preparation ? "Uses the declared bounded preparation adapter" : "Bounded preparation is unavailable; use the existing hand-authored ready/start workflow until this provider supports an enforced tool-free boundary",
        })) });
      }
      return redact({ version: DELIVERY_VERSION, providers: executionCapabilities(), repositories }, secretsFor(scope));
    }
    if (op.annotations.readOnlyHint) {
      const data = await store.read(scope);
      if (name === "list") {
        const tasks = [];
        for (const [taskId, record] of Object.entries(data.tasks).slice(0, 100)) {
          if (!scope.repositories.includes(record.repositoryId)) continue;
          const { ctx, service } = await getContext(record.repositoryId);
          tasks.push(project(ctx, await service.inspect({ taskId })));
        }
        return { version: DELIVERY_VERSION, tasks, truncated: Object.keys(data.tasks).length > 100 };
      }
      const record = owned(data, input.taskId), { ctx, service } = await getContext(record.repositoryId);
      const task = await service.inspect({ taskId: input.taskId }), view = project(ctx, task);
      if (name === "logs") {
        if (!task.implementation?.run) return { version: DELIVERY_VERSION, lines: [], gap: null };
        const runId = view.implementation.run;
        if (!/^[A-Za-z0-9_-]+$/.test(runId || "")) throw deliveryError("DELIVERY_STATE", "Saved run identity is invalid; repair the scoped runtime record");
        const root = join(ctx.home, "runs", idSlug(task.implementation.id), runId);
        return redact(logWindow(root, { after: input.after, count: input.count || 100 }), [...secretsFor(scope), ctx.home, task.checkout].filter(Boolean));
      }
      if (name === "evidence") return { version: DELIVERY_VERSION, taskId: view.taskId, revision: view.revision, brief: view.brief, sources: view.sources, artifacts: view.artifacts, readiness: view.readiness, implementation: view.implementation, evidence: view.evidence };
      return view;
    }
    return store.transaction(scope, async (data, save) => {
      const key = input.operationId, signature = hash([name, input]);
      const previous = Object.hasOwn(data.operations, key) ? data.operations[key] : null;
      if (previous && previous.signature !== signature) throw deliveryError("DELIVERY_CONFLICT", "Operation identity already belongs to different input");
      const record = name === "prepare" ? { repositoryId: input.repositoryId, allowance: input.allowance } : owned(data, input.taskId);
      const { ctx, service, repository } = await getContext(record.repositoryId, record.allowance);
      if (previous?.status === "acknowledged") {
        if (previous.wakePending) { await schedule(scope); previous.wakePending = false; await save(data); }
        return previous.result;
      }
      const task = name === "prepare" ? null : await service.inspect({ taskId: input.taskId });
      if (!previous && task?.revision !== input.expectedRevision && name !== "prepare") throw deliveryError("DELIVERY_CONFLICT", "Task revision changed; inspect before retrying");
      const ctxPaths = (input.contextIds || []).map(id => {
        if (!Object.hasOwn(repository.context || {}, id)) throw deliveryError("DELIVERY_INPUT", "Selected context ID is unavailable");
        return repository.context[id];
      });
      if (!previous) data.operations = { ...data.operations, [key]: { signature, status: "intent", name, taskId: input.taskId || null } };
      await save(data); // crash-safe intent before any inference, readiness or execution
      let result;
      const shared = { taskId: input.taskId, expectedRevision: input.expectedRevision, noDaemon: true };
      if (name === "prepare") result = await service.prepare({ text: input.text, dir: repository.dir, repo: repository.repo, harness: input.harness, context: ctxPaths, requestId: hash([scopeKey(scope), key]), noDaemon: true });
      else if (name === "answer") result = await service.answer({ ...shared, answers: input.answers, operationId: key });
      else if (name === "control") {
        if (!task.implementation) throw deliveryError("DELIVERY_CONTROL", "No implementation exists to control");
        const requestId = hash([scopeKey(scope), key]);
        const entry = ctx.state.get(task.implementation.id);
        if (previous && ![entry?.control, ...(entry?.control_history || [])].some(c => c?.id === requestId)) throw deliveryError("DELIVERY_UNKNOWN", "Interrupted control has no retained acknowledgement; inspect its effects before authorizing a new request identity");
        requestControl(ctx, { handle: task.implementation.id, action: input.action, note: input.note || "", interrupt: input.interrupt || false, requestId });
        result = await service.inspect({ taskId: input.taskId });
      } else {
        // A lost readiness/start reply is recovered only from saved state; a
        // moved revision cannot grant fresh authority or replay a control.
        if (previous && task.revision !== input.expectedRevision) {
          if (name === "start" && task.status === "started" || name === "validate" && task.readiness?.allow) result = task;
          else throw deliveryError("DELIVERY_UNKNOWN", "Interrupted operation changed revision; inspect the owned task before any new request");
        } else result = await service[name]({ ...shared, ...(name === "start" ? { run: true } : {}) });
      }
      data.tasks[result.taskId] = record;
      const view = project(ctx, result);
      data.operations[key] = { ...data.operations[key], taskId: result.taskId, status: "acknowledged", result: view, wakePending: true };
      await save(data);
      await schedule(scope); // adapter enqueues/alarm; never runs a second poll loop
      data.operations[key].wakePending = false;
      await save(data);
      return view;
    });
  }
  return { version: DELIVERY_VERSION, operations: TASK_OPERATIONS, dispatch };
}
