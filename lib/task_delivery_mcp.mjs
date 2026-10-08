// Transport registration only. Production identity and OAuth stay with APort.
import { TASK_OPERATIONS } from "./task_delivery_contract.mjs";
import { modelSummary, taskListSummary, capabilitySummary, evidenceSummary, logSummary } from "./task_delivery_view.mjs";

export async function registerTaskDelivery(server, { delivery, identityFor, resource = null, readResource = null }) {
  if (!delivery?.dispatch || typeof identityFor !== "function") throw new Error("Supply the scoped dispatcher and APort's authenticated request identity resolver");
  const { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TASK_OPERATIONS.map(op => ({ name: `task_${op.name}`, description: op.description,
    inputSchema: op.inputSchema, annotations: op.annotations, ...(resource ? { _meta: resource.toolMeta } : {}) })) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name.replace(/^task_/, "");
    try {
      const view = await delivery.dispatch(name, request.params.arguments || {}, await identityFor(extra));
      const summary = name === "capabilities" ? capabilitySummary(view) : name === "evidence" ? evidenceSummary(view) : name === "logs" ? logSummary(view) : view.tasks ? { version: view.version, tasks: view.tasks.map(taskListSummary), truncated: view.truncated, nextCursor: view.nextCursor } : view.taskId && view.status ? modelSummary(view) : { version: view.version, available: true };
      return { structuredContent: summary, content: [{ type: "text", text: JSON.stringify(summary) }], _meta: { taskDelivery: name === "list" ? summary : view } };
    } catch (error) {
      // Authentication challenges are owned by APort's transport layer. Never
      // serialize a raw credential/provider/filesystem error into model context.
      return { isError: true, content: [{ type: "text", text: `${/^DELIVERY_[A-Z_]+$/.test(error.code || "") ? error.code : "DELIVERY_FAILED"}: Inspect the authorized task or reconnect your account before retrying.` }] };
    }
  });
  if (resource) {
    if (typeof readResource !== "function") throw new Error("Supply the built APort resource reader");
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: resource.uri, name: "Task delivery", mimeType: resource.mimeType }] }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
      try {
        if (request.params.uri !== resource.uri) throw new Error("Resource unavailable");
        const identity = await identityFor(extra);
        // The supplied asset callback must authorize the identity as well as load
        // built assets. It receives no path or user-supplied URL.
        const text = await readResource(identity);
        if (typeof text !== "string" || Buffer.byteLength(text) > 262144) throw new Error("Built UI resource exceeds 256 KiB or is unavailable");
        return { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text, _meta: resource.resourceMeta }] };
      } catch { throw new Error("Task resource unavailable; reconnect the authorized account or repair its built UI asset"); }
    });
  }
  return server;
}
