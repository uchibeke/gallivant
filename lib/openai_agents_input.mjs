// Same source/authority boundary for first launch, resume and review corrections.
import { prepareAgentsSources } from "./openai_agents_sources.mjs";
import { executionError } from "./execution_io.mjs";
import { taskProviderAllowance } from "./task_allowance.mjs";
export async function agentsInput(ctx, id, entry, input, contextPaths) {
  if (contextPaths?.length) throw executionError("EXECUTION_POLICY", "hosted backend cannot enforce configured read-only private context_paths");
  const config = ctx.config.harness[entry.harness];
  if (!config) throw executionError("AGENTS_CONFIG", "selected managed API account is not configured");
  const overlays = [];
  if (entry.prd) overlays.push({ path: entry.prd, text: ctx.readPrd(id) });
  for (const path of entry.sources || []) overlays.push({ path, text: ctx.readSource(id, path) });
  const source = await prepareAgentsSources({ worktree: entry.worktree, inputHead: input.inputHead, repo: entry.repo, branch: entry.branch, base: entry.base, overlays });
  return { ...input, repo: entry.repo, branch: entry.branch, base: entry.base, allowance: taskProviderAllowance(config.allowance, entry.task), mandatoryPolicy: config.mandatory_policy || [], model: config.model, environment: config.environment,
    sources: { data: source.bytes.toString("base64"), hash: source.hash, hashes: source.hashes, modes: source.modes, inputHead: source.inputHead, repo: source.repo, branch: source.branch } };
}
