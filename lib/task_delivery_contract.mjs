// Portable wire contract. No filesystem, credentials, configuration or providers.
export const DELIVERY_VERSION = 1;
export const CORE_VERSION = "0.2.0";
// One byte limit for the built APort MCP resource, package and runtime reader.
export const MAX_TASK_UI_BYTES = 2_000_000;
export const deliveryError = (code, message) => Object.assign(new Error(message), { code, version: DELIVERY_VERSION });
// Only the delivery receipt boundary may label a bounded/redacted rejection.
// Arbitrary provider errors with a TASK_* code must not expose their message.
const settledRejections = new WeakMap();
const safeRejectionCodes = new Set(["TASK_INPUT", "TASK_CONFLICT", "TASK_NOT_READY", "TASK_AUTHORIZATION", "TASK_SECRET", "TASK_PREPARATION_BOUNDARY"]);
export function settledTaskRejection(code, message) {
  const error = deliveryError(code, message);
  if (safeRejectionCodes.has(code) && typeof message === "string") settledRejections.set(error, { code, message: message.slice(0, 500) });
  return error;
}
export const taskRejectionForModel = error => settledRejections.get(error) || null;

const id = { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" };
export const REPOSITORY_ID_SCHEMA = { type: "string", maxLength: 128, pattern: "^[A-Za-z0-9_-][A-Za-z0-9_.-]*(/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$" };
const taskId = { type: "string", pattern: "^task-[a-f0-9]{24}$" };
const text = { type: "string", minLength: 1, maxLength: 32768 };
const revision = { type: "integer", minimum: 1 };
const verifyCommands = { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 500 } };
const object = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const mutation = (properties, required = Object.keys(properties)) => object({ ...properties, operationId: id, expectedRevision: revision }, [...required, "operationId", "expectedRevision"]);
const definition = (name, description, inputSchema, { write = false, destructive = false, open = false } = {}) => ({
  name, description, inputSchema, scope: write ? "task-delivery:write" : "task-delivery:read",
  annotations: { readOnlyHint: !write, destructiveHint: destructive, idempotentHint: true, openWorldHint: open },
});
export const TASK_OPERATIONS = Object.freeze([
  definition("capabilities", "Read up to 100 authorized repositories and configured harness capabilities; pass nextCursor as cursor for more. Does not probe providers.", object({ cursor: REPOSITORY_ID_SCHEMA }, [])),
  definition("prepare", "Prepare requirements using an authorized repository and allowance; may use paid inference.", object({
    repositoryId: REPOSITORY_ID_SCHEMA, text, harness: id, contextIds: { type: "array", items: id, maxItems: 100, uniqueItems: true }, verifyCommands,
    allowance: object({ budgetUsd: { type: "number", exclusiveMinimum: 0 }, runtimeMs: { type: "integer", minimum: 1 } }),
    operationId: id, expectedRevision: { type: "integer", const: 0 },
  }, ["repositoryId", "text", "harness", "allowance", "operationId", "expectedRevision"]), { write: true, open: true }),
  definition("answer", "Answer saved question IDs and optionally select verification commands on the expected revision; may continue paid preparation.", mutation({ taskId, answers: { type: "object", minProperties: 1, maxProperties: 100, propertyNames: id, additionalProperties: text }, verifyCommands }, ["taskId", "answers"]), { write: true, open: true }),
  definition("resume", "Resume owned preparation without allocating another task.", mutation({ taskId }), { write: true, open: true }),
  definition("validate", "Run the canonical readiness gate and preserve its decision.", mutation({ taskId }), { write: true, open: true }),
  definition("start", "Start the exact approved task revision with explicit execution authorization.", mutation({ taskId, run: { type: "boolean", const: true } }), { write: true, open: true }),
  definition("list", "Read up to 100 authorized saved tasks; pass nextCursor as cursor for more. Does not poll providers.", object({ cursor: taskId }, [])),
  definition("inspect", "Read a saved task, brief, progress and supported controls.", object({ taskId })),
  definition("evidence", "Read bounded saved evidence and artifact identities; does not reconcile providers.", object({ taskId })),
  definition("logs", "Read one bounded saved log window; does not create a provider poller.", object({ taskId, after: { type: "integer", minimum: 0 }, count: { type: "integer", minimum: 1, maximum: 100 } }, ["taskId"])),
  definition("control", "Queue a supported control for the existing coordinator; cancellation may leave remote compute running.", mutation({ taskId, action: { type: "string", enum: ["recheck", "resume", "message", "cancel"] }, note: { type: "string", maxLength: 4000 }, interrupt: { type: "boolean" } }, ["taskId", "action"]), { write: true, destructive: true, open: true }),
]);

export function assertCompatible({ coreVersion, operationVersion, taskVersion, executionVersion }) {
  if (!/^0\.2\.\d+$/.test(coreVersion || "") || operationVersion !== DELIVERY_VERSION || taskVersion !== 1 || executionVersion !== 1) {
    throw deliveryError("DELIVERY_VERSION", "Incompatible core or contract. Stop wake-ups, back up the durable namespace, migrate with a compatible package, or restore the matching package and state backup. Never replace active-job code.");
  }
}

export function uiResourceConfiguration({ uri, domain, connectDomains = [], resourceDomains = [] }) {
  const origin = value => { const u = new URL(value); if (u.protocol !== "https:" || u.origin !== value || u.username || u.password) throw deliveryError("DELIVERY_RESOURCE", "UI configuration needs exact HTTPS origins"); return value; };
  if (typeof uri !== "string" || !/^ui:\/\/[A-Za-z0-9/-]+$/.test(uri)) throw deliveryError("DELIVERY_RESOURCE", "Configure a registered ui:// resource URI");
  return { uri, mimeType: "text/html;profile=mcp-app", toolMeta: { ui: { resourceUri: uri }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } },
    resourceMeta: { ui: { domain: origin(domain), csp: { connectDomains: connectDomains.map(origin), resourceDomains: resourceDomains.map(origin) } } } };
}
