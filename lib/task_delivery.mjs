// APort owns OAuth, audience/region/repository authorization. This adapter has no
// anonymous fallback; every operation reauthorizes before touching scoped state.
import Ajv from "ajv";
import { MAX_DELIVERY_OPERATIONS, receiptCapacityError } from "./task_delivery_store.mjs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createTaskService } from "./tasks.mjs";
import { executionCapabilities, capabilitiesFor } from "./harness.mjs";
import { unsubmittedInitialDispatch } from "./execution.mjs";
import { runtimePinManifest, assertRuntimePin } from "./runtime_state.mjs";
import { acquireRuntimeOwner } from "./daemon.mjs";
import { requestControl } from "./control.mjs";
import { controlAvailability } from "./control_contract.mjs";
import { logWindow } from "./run_log.mjs";
import { idSlug } from "./state.mjs";
import { redact } from "./execution_io.mjs";
import { canonical } from "./learning_data.mjs";
import { scopeKey } from "./task_delivery_store.mjs";
import { TASK_OPERATIONS, REPOSITORY_ID_SCHEMA, DELIVERY_VERSION, deliveryError } from "./task_delivery_contract.mjs";
import { taskView } from "./task_delivery_view.mjs";
import { readJson } from "./fs.mjs";
const validators = new Map(TASK_OPERATIONS.map(op => [op.name, new Ajv({ strict: true, allErrors: true }).compile(op.inputSchema)]));
const validRepositoryId = new Ajv({ strict: true }).compile(REPOSITORY_ID_SCHEMA);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createTaskDelivery({ authorize, contextFor, store, schedule, manifest, secretsFor = () => [] }) {
  if (typeof authorize !== "function" || typeof contextFor !== "function" || !store?.transaction || !store?.read || typeof schedule !== "function") throw deliveryError("DELIVERY_CONFIG", "Supply APort authorization, scoped context, durable receipt store and wake-up scheduling adapters");
  manifest = runtimePinManifest(manifest);
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
    if (!scope.repositories.every(id => validRepositoryId(id))) throw deliveryError("DELIVERY_CONFIG", "APort returned an unsupported repository ID; use the bounded repository-ID schema");
    const allowedRepo = id => { if (!scope.repositories.includes(id)) throw deliveryError("DELIVERY_AUTHORIZATION", "Repository is unavailable in this account"); };
    const project = (ctx, task) => {
      const entry = task.implementation && ctx.state.get(task.implementation.id);
      const execution = entry && (ctx.executionFor ? ctx.executionFor(task.implementation.id, task.harness) : ctx.runnerFor(task.implementation.id));
      const run = execution?.current();
      const result = run?.id && execution.result?.(run.id);
      const verification = run?.id && /^[A-Za-z0-9_-]+$/.test(run.id) ? readJson(join(ctx.home, "runs", idSlug(task.implementation.id), run.id, "verification.json")) : null;
      const capability = execution?.capabilities ?? executionCapabilities().find(c => c.name === task.harness);
      let resumable = Boolean(entry?.session);
      if (entry && execution && !resumable) {
        try { resumable = Boolean(unsubmittedInitialDispatch(entry, execution)); }
        catch (error) { if (!["EXECUTION_STOPPED", "EXECUTION_UNKNOWN"].includes(error.code)) throw error; }
      }
      return taskView(task, { entry, run, result, verification, capabilities: capability, controls: controlAvailability(entry, run, capability, { resumable }), secrets: [...secretsFor(scope), ctx.home, task.checkout].filter(Boolean) });
    };
    const getContext = async (repoId, allowance) => {
      allowedRepo(repoId);
      // Server configuration resolves all filesystem paths and transport URLs.
      const bound = await contextFor(scope, repoId);
      if (!bound?.ctx || !bound.repository?.dir || !bound.repository?.repo) throw deliveryError("DELIVERY_CONFIG", "APort must bind the authorized repository to a scoped runtime context");
      const ctx = bound.ctx;
      let scopedCtx = { ...ctx, taskSecrets: secrets, enforceTaskAllowance: true };
      if (allowance) {
        if (allowance.budgetUsd > ctx.config.max_budget_usd || allowance.runtimeMs > ctx.config.run_timeout_minutes * 60000) throw deliveryError("DELIVERY_ALLOWANCE", "Requested allowance exceeds the configured account limit");
        // Narrow a copy: shared account settings are never mutated by requests.
        scopedCtx = { ...scopedCtx, config: { ...ctx.config, max_budget_usd: allowance.budgetUsd, run_timeout_minutes: allowance.runtimeMs / 60000 } };
      }
      return { ...bound, ctx: scopedCtx, service: createTaskService(scopedCtx, bound.taskOptions) };
    };
    if (name === "capabilities") {
      const repositories = [];
      const ids = [...new Set(scope.repositories)].sort().filter(id => !input.cursor || id > input.cursor);
      for (const id of ids.slice(0, 100)) {
        const { ctx } = await getContext(id);
        repositories.push({ id, providers: executionCapabilities().map(capability => ({ ...capability,
          configured: Boolean(ctx.config.harness[capability.name]),
          available: capability.available && Boolean(ctx.config.harness[capability.name]),
          accountAccess: "unverified-until-setup-check", setup: capability.reason || (!ctx.config.harness[capability.name] ? "APort must configure this provider for the authorized account" : "Dispatch validates the configured account/model/environment and allowance"),
          canPrepare: Boolean(capability.preparation && capability.available && ctx.config.harness[capability.name]),
          preparationSetup: capability.preparation ? "Uses the declared bounded preparation adapter" : "Bounded preparation is unavailable; use the existing hand-authored ready/start workflow until this provider supports an enforced tool-free boundary",
        })) });
      }
      return redact({ version: DELIVERY_VERSION, providers: executionCapabilities(), repositories,
        truncated: ids.length > 100, nextCursor: ids.length > 100 ? repositories.at(-1).id : null }, secretsFor(scope));
    }
    if (op.annotations.readOnlyHint) {
      const data = await store.read(scope);
      if (name === "list") {
        const tasks = [], authorized = Object.entries(data.tasks).filter(([, record]) => scope.repositories.includes(record.repositoryId)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).filter(([id]) => !input.cursor || id > input.cursor);
        for (const [taskId, record] of authorized.slice(0, 100)) {
          const { ctx, service } = await getContext(record.repositoryId);
          tasks.push(project(ctx, await service.inspect({ taskId })));
        }
        return { version: DELIVERY_VERSION, tasks, truncated: authorized.length > 100, nextCursor: authorized.length > 100 ? tasks.at(-1).taskId : null };
      }
      const record = owned(data, input.taskId), { ctx, service } = await getContext(record.repositoryId);
      const task = await service.inspect({ taskId: input.taskId }), view = project(ctx, task);
      if (name === "logs") {
        if (!task.implementation?.run) return { version: DELIVERY_VERSION, taskId: view.taskId, revision: view.revision, lines: [], ids: [], total: 0, from: 1, to: 0, gap: null };
        const runId = view.implementation.run;
        if (!/^[A-Za-z0-9_-]+$/.test(runId || "")) throw deliveryError("DELIVERY_STATE", "Saved run identity is invalid; repair the scoped runtime record");
        const root = join(ctx.home, "runs", idSlug(task.implementation.id), runId);
        return redact({ version: DELIVERY_VERSION, taskId: view.taskId, revision: view.revision, ...logWindow(root, { after: input.after, count: input.count || 100 }) }, [...secretsFor(scope), ctx.home, task.checkout].filter(Boolean));
      }
      if (name === "evidence") return { version: DELIVERY_VERSION, taskId: view.taskId, revision: view.revision, brief: view.brief, sources: view.sources, artifacts: view.artifacts, readiness: view.readiness, implementation: view.implementation, evidence: view.evidence };
      return view;
    }
    return store.transaction(scope, async (data, save) => {
      const key = input.operationId, signature = "canonical-v1:" + createHash("sha256").update(canonical(JSON.parse(JSON.stringify([name, input])))).digest("hex");
      const cancellation = name === "control" && input.action === "cancel";
      const cancellations = data.cancellations || {};
      const previous = Object.hasOwn(data.operations, key) ? data.operations[key] : Object.hasOwn(cancellations, key) ? cancellations[key] : null;
      // One compact safety receipt per retained task, independent of ordinary
      // count/byte capacity. Never evict identities or allow one task to consume
      // another task's cancellation reserve.
      if (!previous && cancellation && Object.values(cancellations).some(receipt => receipt.taskId === input.taskId)) throw deliveryError("DELIVERY_CAPACITY", "This task already has a retained cancellation; retry its original operation ID or inspect the task's cancellation status");
      if (!previous && !cancellation && Object.keys(data.operations).length >= MAX_DELIVERY_OPERATIONS) throw receiptCapacityError();
      if (!previous && cancellation && Object.keys(cancellations).length >= MAX_DELIVERY_OPERATIONS) throw receiptCapacityError();
      const reserved = cancellation && !Object.hasOwn(data.operations, key);
      const receipts = reserved ? cancellations : data.operations;
      if (previous && previous.signature !== signature && previous.signature !== hash([name, input])) throw deliveryError("DELIVERY_CONFLICT", "Operation identity already belongs to different input");
      // Only the original request may advance a task while its intent is open.
      // A prepare intent has not yet published its task binding, so conservatively
      // fence ordinary mutations in the scope until its exact retry settles it.
      if (!cancellation && Object.entries(data.operations).some(([id, receipt]) => id !== key && receipt.status === "intent" &&
        (receipt.name === "prepare" || name === "prepare" || receipt.taskId === input.taskId))) throw deliveryError("DELIVERY_PENDING", "Retry the unresolved operation with its original identity before another task mutation; cancellation remains available");
      const record = name === "prepare" ? { repositoryId: input.repositoryId, allowance: input.allowance } : owned(data, input.taskId);
      const { ctx, service, repository } = await getContext(record.repositoryId, record.allowance);
      // Share ownership with coordinator wakes, backup and migration. Claim
      // before durable intent or task effects, and retain it through receipt saves.
      const runtimeOwner = acquireRuntimeOwner(ctx.home);
      try {
        assertRuntimePin({ home: ctx.home, manifest });
        if (previous?.status === "acknowledged") {
          if (previous.wakePending) { await schedule(scope); previous.wakePending = false; await save(data); }
          return previous.result ?? project(ctx, await service.inspect({ taskId: previous.taskId }));
        }
        const task = name === "prepare" ? null : await service.inspect({ taskId: input.taskId });
        if (!previous && task?.revision !== input.expectedRevision && name !== "prepare") throw deliveryError("DELIVERY_CONFLICT", "Task revision changed; inspect before retrying");
        if (cancellation && !task.implementation) throw deliveryError("DELIVERY_CONTROL", "No implementation exists to control");
        const ctxPaths = (input.contextIds || []).map(id => {
          if (!Object.hasOwn(repository.context || {}, id)) throw deliveryError("DELIVERY_INPUT", "Selected context ID is unavailable");
          return repository.context[id];
        });
        if (!previous) Object.defineProperty(receipts, key, { value: { signature, status: "intent", mutationFence: true, name, taskId: input.taskId || null }, enumerable: true, writable: true, configurable: true });
        if (reserved) data.cancellations = receipts;
        // A compact acknowledgement plus the bounded repository/task binding
        // must fit before effects. Legacy intents also reserve before recovery.
        if (!reserved) receipts[key].acknowledgementReserve = " ".repeat(4096);
        await save(data); // crash-safe intent before any inference, readiness or execution
        let result;
        const shared = { taskId: input.taskId, expectedRevision: input.expectedRevision, noDaemon: true };
        if (name === "prepare") result = await service.prepare({ text: input.text, dir: repository.dir, repo: repository.repo, harness: input.harness, context: ctxPaths, requestId: hash([scopeKey(scope), key]), noDaemon: true });
        else if (name === "answer") result = await service.answer({ ...shared, answers: input.answers, operationId: key });
        else if (name === "control") {
          if (!task.implementation) throw deliveryError("DELIVERY_CONTROL", "No implementation exists to control");
          const requestId = hash([scopeKey(scope), key]);
          const entry = ctx.state.get(task.implementation.id);
          // Cancellation can safely be re-enqueued with its deterministic ID
          // after intent-only crashes; it only fences dispatch, never starts work.
          // Other controls remain ambiguous when their bounded history is gone.
          if (previous && !cancellation && ![entry?.control, ...(entry?.control_history || [])].some(c => c?.id === requestId)) throw deliveryError("DELIVERY_UNKNOWN", "Interrupted control has no retained acknowledgement; inspect its effects before authorizing a new request identity");
          requestControl(ctx, { handle: task.implementation.id, action: input.action, note: input.note || "", interrupt: input.interrupt || false, requestId });
          result = await service.inspect({ taskId: input.taskId });
        } else {
          // A moved revision settles an interrupted request with the current
          // saved outcome, including denial or incomplete preparation. Never
          // repeat effects or grant authority from its stale revision; further
          // recovery requires a new request against the inspected revision.
          if (previous && task.revision !== input.expectedRevision) {
            if (!previous.mutationFence) throw deliveryError("DELIVERY_UNKNOWN", "Legacy intent lacks exclusive mutation evidence; preserve it for reconciliation with its original runtime");
            result = task;
          }
          else result = await service[name]({ ...shared, ...(name === "start" ? { run: true } : {}) });
        }
        data.tasks[result.taskId] = record;
        receipts[key] = { signature, name, taskId: result.taskId, status: "acknowledged", wakePending: true };
        await save(data);
        await schedule(scope); // adapter enqueues/alarm; never runs a second poll loop
        receipts[key].wakePending = false;
        await save(data);
        return project(ctx, result);
      } finally { runtimeOwner.release(); }
    });
  }
  return { version: DELIVERY_VERSION, operations: TASK_OPERATIONS, dispatch };
}
