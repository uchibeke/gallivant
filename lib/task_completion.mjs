// Portable milestones, with one currently supported observation adapter. A
// target selects what is fulfilled; it never grants merge/deployment authority.
import { ownerDeliveryEvidence, matchingDeliveryEvidence } from "./owner_delivery.mjs";
import { controlPending } from "./control_contract.mjs";
import { executionLive } from "./execution.mjs";
import { learningDeliveryPending } from "./learning_input.mjs";
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
export function completionView(policy, entry = null, ownerDelivery = null, current = null) {
  const selected = policy || entry?.task?.completion || { version: 1, target: "delivery_ready" };
  const descriptor = COMPLETION_CAPABILITIES.targets.find(target => target.id === selected.target);
  const evidence = entry?.completionEvidence || {};
  const legacy = !policy && !entry?.task?.completion;
  let status = "pending", reason = null;
  if (entry?.dispatch_stopped || ["cancelled", "cancellation-requested"].includes(entry?.reason)) { status = "cancelled"; reason = "Further dispatch is stopped; provider cancellation may still require confirmation."; }
  else if (evidence.terminal?.state === "CLOSED") { status = "blocked"; reason = "The delivery was closed without integration."; }
  else if (evidence.integration?.qualified === true) status = "fulfilled";
  else if (evidence.terminal?.state === "MERGED") { status = "unverified"; reason = evidence.integration?.reason || "Integration was observed without a matching qualified delivery."; }
  else if (entry?.state === "ready-for-human" && matchingDeliveryEvidence(entry)) status = selected.target === "integrated" ? "awaiting_integration" : "fulfilled";
  else if (entry?.state === "needs-human") { status = "blocked"; reason = entry.reason || "The delivery needs human attention."; }
  else if (entry && ["ready-for-human", "done"].includes(entry.state)) { status = "unverified"; reason = "No canonical completion evidence is recorded for this delivery."; }
  const ownership = ownerDelivery || entry?.task?.ownerDelivery;
  const obligations = ownerDeliveryEvidence(ownership, entry, status);
  if (obligations.some(o => o.status !== "fulfilled") && ["fulfilled", "awaiting_integration"].includes(status)) { status = "unverified"; reason = "The owner publication obligation lacks matching coordinator delivery evidence."; }
  if (["fulfilled", "awaiting_integration"].includes(status) && completionWorkPending(entry, current)) { status = "pending"; reason = "Owned execution still requires reconciliation or collection."; }
  return { ...selected, label: descriptor?.label || null, description: descriptor?.description || null, status, adapter: "github-pull-request", legacy, evidence, reason,
    ...(ownership ? { obligations } : {}),
    monitoring: Boolean(entry && ["pr-open", "ready-for-human", "running"].includes(entry.state) && !stopsAutomation(entry, selected, status, legacy, current)), mergeAuthorized: false };
}

const completionWorkPending = (entry, current) => Boolean(executionLive(entry) || executionLive(current) || current?.running ||
  current && current.id === entry?.last?.run && entry.last.exit == null);
const stopsAutomation = (entry, selected, status, legacy, current) => Boolean(entry?.state === "ready-for-human" && !legacy &&
  selected.version === 1 && selected.target === "delivery_ready" && status === "fulfilled" && matchingDeliveryEvidence(entry) && !controlPending(entry.control) && !completionWorkPending(entry, current));
export function completionStopsAutomation(entry, current = null) {
  // Malformed saved ownership remains unqualified and is handled per entry by
  // the normal tick. It must neither suppress work nor abort the entire sweep.
  try {
    const view = completionView(null, entry, null, current);
    return stopsAutomation(entry, view, view.status, view.legacy, current);
  } catch { return false; }
}
// Hosts consume the engine's decision, rather than interpreting ready as active
// forever. Other terminal/paused states retain the existing scheduling contract.
export function coordinatorEntryActive(entry, current = null) {
  return Boolean(entry && (learningDeliveryPending(entry) || !["done", "needs-human"].includes(entry.state) && !completionStopsAutomation(entry, current)));
}
