// Local HTTP adapter over the same task service as the CLI. No second task or
// ownership store: repository paths come only from the configured registry.
import { isAbsolute } from "node:path";
import { taskStore } from "../task_store.mjs";
import { createTaskService, taskIdForRequest } from "../tasks.mjs";
import { repoEntries } from "../config.mjs";
import { capabilitiesFor } from "../harness.mjs";
import { hostDefinition } from "../host_definitions.mjs";
import { assertRepositoryAccess } from "../host_contract.mjs";
import { taskView } from "../task_delivery_view.mjs";
import { TASK_OPERATIONS } from "../task_delivery_contract.mjs";
import { redact } from "../execution_io.mjs";
import { taskError as serviceError } from "../task_store.mjs";
import { intakeRevisionOperation } from "./intake_contract.mjs";

const names = ["prepare", "answer", "resume", "validate", "start"];
const schemas = names.map(name => {
  const schema = structuredClone(TASK_OPERATIONS.find(op => op.name === name).inputSchema);
  if (name === "prepare") {
    // Local CLI allowances are operator configured. No browser paths, context
    // files, endpoints, credentials or global configuration can be submitted.
    delete schema.properties.allowance; delete schema.properties.contextIds;
    schema.required = schema.required.filter(key => key !== "allowance").concat("route", "delivery");
  }
  return [name, schema];
});
// CLI help and read-only pages also load serve.mjs in a freshly unpacked
// package. Load the existing validation dependency only for protected writes.
let validators;
const inputValidators = () => validators ??= import("ajv").then(({ default: Ajv }) => new Map(schemas.map(([name, schema]) => [name, new Ajv({ strict: true }).compile(schema)])));
const taskError = (code, message) => Object.assign(serviceError(code, message), { taskEffects: "none" });
const secrets = ctx => [ctx.home, ...(ctx.taskSecrets || []),
  (ctx.env ?? process.env)[ctx.config.intake_model?.credential_env]].filter(Boolean);
const service = (ctx, owner) => createTaskService(ctx, { ...ctx.taskIntakeOptions, mutationOwner: owner });
const configured = ctx => {
  const entries = ctx.state.entries();
  return repoEntries(ctx.config).map(repo => {
    let checkout = null;
    for (const [, entry] of entries) {
      if (entry.repo !== repo.repo) continue;
      let source = entry;
      // Intake implementations register a brief snapshot as entry.checkout.
      // Resolve their existing task reference to the original source checkout.
      if (entry.task?.id) {
        try { source = taskStore(ctx.home).read(entry.task.id); }
        catch { continue; }
      }
      if (source.repo === repo.repo && typeof source.checkout === "string" && isAbsolute(source.checkout)) { checkout = source.checkout; break; }
    }
    return { ...repo, checkout };
  });
};
const repository = (ctx, id) => {
  const repo = configured(ctx).find(r => r.repo === id);
  if (!repo) throw taskError("TASK_AUTHORIZATION", "Repository is not in the approved configuration.");
  return repo;
};
const owned = (ctx, task) => { repository(ctx, task.repo); return task; };
const project = (ctx, task) => taskView(task, { secrets: [...secrets(ctx), task.checkout].filter(Boolean) });

export function intakeCapabilities(ctx) {
  const declared = service(ctx).capabilities();
  return redact({ repositories: configured(ctx).map(repo => ({ id: repo.repo, base: repo.base,
    available: !!repo.checkout, reason: repo.checkout ? null : "No registered source checkout. Use the CLI prepare/start workflow from this repository to register one, then reopen this page.",
    providers: declared.providers.map(provider => {
      const cap = ctx.capabilitiesFor?.(provider.name) || capabilitiesFor(provider.name);
      let reason = !ctx.config.harness[provider.name] ? "This provider is not configured. Configure it through the CLI." : !cap.available ? cap.reason || "Implementation is unavailable for this provider." : null;
      try { assertRepositoryAccess(cap, hostDefinition(repo.repo).repository); }
      catch { reason = "This provider cannot access this repository host. Use a provider that declares support for this host."; }
      return { name: cap.name, available: !reason, reason,
        canPrepare: !reason && !!cap.preparation,
        preparationReason: cap.preparation ? null : "This harness has no enforced tool-free preparation adapter. Use a configured bounded model route or the hand-authored CLI ready/start workflow.",
      };
    }),
  })), delivery: declared.delivery,
  modelRoute: { enabled: declared.modelRoute.enabled, adapter: declared.modelRoute.adapter, model: declared.modelRoute.model,
    reason: declared.modelRoute.enabled ? null : "The bounded model route is unavailable. Ask the operator to check intake_model configuration and its credential through the CLI." },
  allowance: { budgetUsd: ctx.config.max_budget_usd, runtimeMinutes: ctx.config.run_timeout_minutes },
  accountAccess: "Not checked on page load. Preparation and Start enforce the configured provider, repository and readiness checks.",
  }, secrets(ctx));
}

export function inspectIntake(ctx, input) {
  const taskId = input.taskId || (repository(ctx, input.repositoryId),
    /^[A-Za-z0-9_-]{1,128}$/.test(input.operationId || "") ? taskIdForRequest(input.repositoryId, input.operationId) : null);
  if (!/^task-[a-f0-9]{24}$/.test(taskId || "")) throw taskError("TASK_INPUT", "Invalid task identity.");
  try { return project(ctx, owned(ctx, service(ctx).inspect({ taskId }))); }
  catch (error) { if (!input.taskId && error.code === "TASK_NOT_FOUND") return null; throw error; }
}

export async function mutateIntake(ctx, action, input, owner) {
  if (!(await inputValidators()).get(action)?.(input)) throw taskError("TASK_INPUT", "Invalid intake request. Reload the page and review its fields.");
  if (redact(JSON.stringify(input), secrets(ctx)) !== JSON.stringify(input)) throw taskError("TASK_SECRET", "Remove credentials from task text and answers before submitting.");
  const api = service(ctx, owner);
  if (action === "prepare") {
    const repo = repository(ctx, input.repositoryId);
    if (!repo.checkout) throw taskError("TASK_INPUT", "No registered source checkout. Use the CLI prepare/start workflow from the repository first.");
    return project(ctx, await api.prepare({ text: input.text, repo: repo.repo, dir: repo.checkout, base: repo.base,
      harness: input.harness, route: input.route, delivery: input.delivery, completion: input.completion, requestId: input.operationId, verifyCommands: input.verifyCommands || [], run: false }));
  }
  owned(ctx, api.inspect({ taskId: input.taskId }));
  if (action !== "answer" && input.operationId !== intakeRevisionOperation(action, input.taskId, input.expectedRevision)) {
    throw taskError("TASK_CONFLICT", "Operation identity does not match the reviewed revision. Refresh and review again.");
  }
  return project(ctx, await api[action](input));
}

// Provider/host errors can include arbitrary remote output. Never echo them as
// HTTP diagnostics. Saved task failures use the existing redacted task view.
export function intakeError(error) {
  const messages = {
    TASK_INPUT: "Check the request fields and configured source checkout. Refresh before retrying.",
    TASK_SECRET: "Remove credentials from task text and answers before submitting.",
    TASK_AUTHORIZATION: "This repository is no longer approved. Ask the operator to check repository configuration.",
    TASK_NOT_FOUND: "This saved task is unavailable. Keep the draft and check the original task identity.",
    TASK_CONFLICT: "The revision or operation changed. Refresh the saved task and review it again; your draft is retained.",
    TASK_NOT_READY: "This revision is not ready. Resolve the saved questions or readiness failure before Start.",
    TASK_BUSY: "Another task mutation owns this runtime. Check saved status before retrying the same request.",
    TASK_PREPARATION_BOUNDARY: "This harness cannot prepare within the required tool-free boundary. Use an explicitly configured bounded model route or the CLI ready/start workflow.",
    EXECUTION_UNAVAILABLE: "The selected execution provider is unavailable. Repair its CLI setup before retrying; no provider was substituted.",
    TASK_MODEL_ROUTE: "The selected model route is unavailable. Ask the operator to repair its configured model access and credential through the CLI.",
    TASK_PROFILE_UNSUPPORTED: "The saved delivery profile is unsupported. Inspect it with a compatible CLI or explicitly prepare a new task from the saved request.",
    TASK_RUNTIME_PIN: "This runtime is pinned to a managed delivery package. Use its manifest-aware task delivery workspace; ordinary local intake cannot mutate it.",
  };
  return { error: messages[error.code] || "The request could not be confirmed. Check saved status and repair the provider through the CLI before retrying the same request.",
    code: Object.hasOwn(messages, error.code) ? error.code : "TASK_FAILED", noEffects: error.taskEffects === "none" };
}
