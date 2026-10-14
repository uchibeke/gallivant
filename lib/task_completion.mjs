// Portable milestones, with one currently supported observation adapter. A
// target selects what is fulfilled; it never grants merge/deployment authority.
export const COMPLETION_SCHEMA = Object.freeze({ type: "object", properties: {
  target: { type: "string", enum: ["delivery_ready", "integrated"] },
}, required: ["target"], additionalProperties: false });
export const COMPLETION_CAPABILITIES = Object.freeze({ version: 1, defaultTarget: "delivery_ready", targets: [
  { id: "delivery_ready", label: "Ready for handoff", description: "The current delivery passes the existing checks, reviewer and completion gate.", adapter: "github-pull-request" },
  { id: "integrated", label: "Merged", description: "Keep watching the qualified delivery until an authorized person or system merges it. This does not authorize a merge.", adapter: "github-pull-request" },
] });
export function completionPolicy(value) {
  if (value === undefined) return { version: 1, target: "delivery_ready" };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "target") || !COMPLETION_SCHEMA.properties.target.enum.includes(value.target)) {
    throw Object.assign(new Error("completion must select a supported target: delivery_ready or integrated; it does not grant integration authority"), { code: "TASK_INPUT" });
  }
  return { version: 1, target: value.target };
}
export function completionView(policy, entry = null) {
  const selected = policy || entry?.task?.completion || { version: 1, target: "delivery_ready" };
  const descriptor = COMPLETION_CAPABILITIES.targets.find(target => target.id === selected.target);
  const evidence = entry?.completionEvidence || {};
  const legacy = !policy && !entry?.task?.completion;
  let status = "pending", reason = null;
  if (entry?.dispatch_stopped || ["cancelled", "cancellation-requested"].includes(entry?.reason)) { status = "cancelled"; reason = "Further dispatch is stopped; provider cancellation may still require confirmation."; }
  else if (evidence.terminal?.state === "CLOSED") { status = "blocked"; reason = "The delivery was closed without integration."; }
  else if (evidence.integration?.qualified === true) status = "fulfilled";
  else if (evidence.terminal?.state === "MERGED") { status = "unverified"; reason = evidence.integration?.reason || "Integration was observed without a matching qualified delivery."; }
  else if (entry?.state === "ready-for-human" && evidence.delivery?.head === entry.cursor?.fixed_sha && evidence.delivery?.gate?.allow === true && !evidence.delivery.invalidatedAt) status = selected.target === "integrated" ? "awaiting_integration" : "fulfilled";
  else if (entry?.state === "needs-human") { status = "blocked"; reason = entry.reason || "The delivery needs human attention."; }
  else if (entry && ["ready-for-human", "done"].includes(entry.state)) { status = "unverified"; reason = "No canonical completion evidence is recorded for this delivery."; }
  return { ...selected, label: descriptor?.label || null, description: descriptor?.description || null, status, adapter: "github-pull-request", legacy, evidence, reason,
    monitoring: Boolean(entry && ["pr-open", "ready-for-human", "running"].includes(entry.state)), mergeAuthorized: false };
}
