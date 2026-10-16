// Portable execution metadata shared by projections and Node transport adapters.
export const EXECUTION_TRANSPORTS = Object.freeze({
  claude: "cli", codex: "cli", gemini: "cli", opencode: "cli", goose: "cli",
  "openai-agents": "remote", "codex-cloud": "remote",
});
export const PROVIDER_STATES = Object.freeze(["queued", "provisioning", "running", "waiting-for-input", "retrieving-results", "succeeded", "failed", "cancellation-requested", "cancelled", "status-unknown"]);
export const providerTerminal = state => ["succeeded", "failed", "cancelled"].includes(state);
const exactIdentity = id => typeof id === "string" && !!id.trim();
export const ownedRemoteExecution = ex => exactIdentity(ex?.providerJobId) && exactIdentity(ex?.turnId);
export const executionLive = job => {
  const ex = job?.execution;
  if (!ex) return false;
  const remote = (ex.transport ?? EXECUTION_TRANSPORTS[ex.provider]) === "remote";
  return (remote && (ex.acceptance !== "accepted" || !ownedRemoteExecution(ex))) || !providerTerminal(ex.providerState) || !ex.collected;
};
