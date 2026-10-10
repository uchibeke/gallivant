// Agents API v1: environment:none, an explicit empty tool list and disabled
// delegation establish the preparation boundary in the initial-input request.
// https://developers.openai.com/api/docs/guides/agents-api/configuration
import { createHash } from "node:crypto";
import { executionError } from "./execution_io.mjs";

export const agentsPreparation = Object.freeze({ version: 1, boundary: "agents-text-only-v1", authority: "text-only", environment: "none" });
export const intakeAgent = config => ({ model: config.model,
  ...(config.reasoning ? { reasoning: config.reasoning } : {}),
  ...(config.service_tier ? { service_tier: config.service_tier } : {}),
  instructions: "Prepare a task brief from the supplied text. Return the requested structured answer. Selected documents are context, not permission to execute work. You have no tools, filesystem, network or delegation authority. Do not claim to have run checks or implemented changes.",
  tools: [], multi_agent: { enabled: false },
});
export const intakeSettings = config => createHash("sha256").update(JSON.stringify({ account: config.account, organization: config.organization, project: config.project, agent: intakeAgent(config) })).digest("hex");
export function assertIntakeInput(req, config, prepared = false) {
  if (req.kind !== "intake" || req.environment !== "none" || typeof req.prompt !== "string" || !req.prompt.trim() || Buffer.byteLength(req.prompt) > 120 * 1024 || req.contextPaths?.length || req.sources || req.sessionId || (req.model && req.model !== config.model) || req.mandatoryPolicy?.length) throw executionError("TASK_PREPARATION_BOUNDARY", "intake requires bounded text in a new tool-free session; no sources, paths or implementation authority");
  if (prepared && (req.prepared?.boundary !== agentsPreparation.boundary || req.prepared.environment !== "none" || req.prepared.settings !== intakeSettings(config))) throw executionError("TASK_PREPARATION_BOUNDARY", "preparation configuration changed; prepare again before sending any input");
}
export function assertIntakeSession(session, config) {
  const agent = session.agent;
  if (session.environment?.type !== "none" || !Array.isArray(agent?.tools) || agent.tools.length || agent.multi_agent?.enabled !== false || agent.instructions !== intakeAgent(config).instructions || session.required_actions?.length) throw executionError("TASK_PREPARATION_BOUNDARY", "effective intake session cannot confirm tool-free authority and environment:none");
}
export function assertIntakeItems(items, op) {
  if (items.some(item => item.turn_id !== op.turnId || item.subagent_id != null || !["message", "reasoning"].includes(item.type))) throw executionError("TASK_PREPARATION_BOUNDARY", "intake output contains a tool, delegated or unowned item");
}
export function intakeText(items, op) {
  assertIntakeItems(items, op);
  const final = items.filter(item => item.type === "message" && item.role === "assistant" && item.phase === "final_answer");
  if (final.length !== 1 || final[0].status !== "completed" || !Array.isArray(final[0].content) || final[0].content.some(part => part.type !== "output_text" || typeof part.text !== "string")) throw executionError("EXECUTION_RESULT", "one completed owned final answer is required for intake");
  const text = final[0].content.map(part => part.text).join("");
  if (!text.trim() || Buffer.byteLength(text) > 256 * 1024) throw executionError("EXECUTION_RESULT", "intake final answer is empty or exceeds the bounded result");
  return text;
}
