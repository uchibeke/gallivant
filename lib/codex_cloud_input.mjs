import { prepareAgentsSources, contentHash, portablePath } from "./openai_agents_sources.mjs";
import { validateCloudConfig } from "./codex_cloud_config.mjs";
import { executionError } from "./execution_io.mjs";
import { isOurBranch } from "./git.mjs";
import { remoteMatches, repositoryMatches } from "./gh.mjs";
import { acquirePublicationLock } from "./execution_result.mjs";
import { executionLive } from "./execution.mjs";
import { CLOUD_RESULT_PATH } from "./codex_cloud_result.mjs";
import { taskProviderAllowance } from "./task_allowance.mjs";

// Called by the same initial/resume/review dispatch boundary as the API adapter.
// Commit only the already approved overlays in the task's isolated checkout.
export async function cloudInput(ctx, id, entry, input, contextPaths = []) {
  const execution = ctx.executionFor?.(id, entry.harness);
  const lock = ctx.home ? acquirePublicationLock(ctx, id, { execution, ownsExecution: true }) : null;
  try {
    const saved = execution?.state();
    if (entry.dispatch_stopped || saved?.stopped || saved?.current && executionLive(saved.current)) throw executionError("BUSY", "Cloud input cannot mutate an active or stopped task checkout");
    return await deliverCloudInput(ctx, id, entry, input, contextPaths);
  } finally { lock?.release(); }
}
async function deliverCloudInput(ctx, id, entry, input, contextPaths) {
  const config = validateCloudConfig(ctx.config.harness[entry.harness]);
  if (contextPaths.length) throw executionError("EXECUTION_POLICY", "Cloud cannot deliver private absolute context paths");
  if (!repositoryMatches(entry.repo, config.repository) || !isOurBranch(entry.branch) || entry.branch === entry.base || entry.worktree === entry.checkout ||
      await ctx.git.currentBranch(entry.worktree) !== entry.branch || !remoteMatches(await ctx.git.originOf(entry.worktree), entry.repo)) throw executionError("CLOUD_SOURCE", "Cloud requires its configured repository and isolated owned task checkout");
  const overlays = [entry.prd && { path: entry.prd, text: ctx.readPrd(id) }, ...(entry.sources || []).map(path => ({ path, text: ctx.readSource(id, path) }))].filter(Boolean);
  const snapshot = await prepareAgentsSources({ worktree: entry.worktree, inputHead: input.inputHead, repo: entry.repo, branch: entry.branch, base: entry.base, overlays });
  if (Object.hasOwn(snapshot.hashes, CLOUD_RESULT_PATH)) throw executionError("CLOUD_SOURCE", "reserved Cloud result envelope path exists in the approved input; choose another repository layout before dispatch");
  if (!await ctx.git.resultModesMatch(entry.worktree, input.inputHead, overlays.map(item => item.path))) throw executionError("CLOUD_SOURCE", "approved snapshot mode changed; preserve the checkout and repair input before dispatch");
  await ctx.git.commitResult(entry.worktree, overlays.map(item => portablePath(item.path)));
  const inputHead = await ctx.git.head(entry.worktree);
  await ctx.git.pushResult(entry.worktree, entry.branch);
  if (await ctx.gh.refSha(entry.repo, entry.branch) !== inputHead) throw executionError("CLOUD_SOURCE", "remote task branch does not match the exact committed input head");
  const hashes = {};
  for (const item of overlays) {
    const text = await ctx.gh.fileAtStrict(entry.repo, item.path, inputHead);
    if (text !== item.text) throw executionError("CLOUD_SOURCE", "approved snapshot remote bytes differ; nothing dispatched");
    hashes[item.path] = contentHash(text);
  }
  // A unique input ref is never advanced by the coordinator. Cloud reads this
  // revision even if a reviewer/operator later advances the logical PR branch.
  const inputBranch = `${entry.branch}-cloud-${inputHead}`;
  await ctx.git.pushSnapshotRef(entry.worktree, inputBranch);
  if (await ctx.gh.refSha(entry.repo, inputBranch) !== inputHead || await ctx.git.head(entry.worktree) !== inputHead) throw executionError("CLOUD_SOURCE", "Cloud input revision moved before dispatch");
  const sources = await prepareAgentsSources({ worktree: entry.worktree, inputHead, repo: entry.repo, branch: entry.branch, base: entry.base, overlays: [] });
  return { ...input, inputHead, repo: entry.repo, branch: entry.branch, base: entry.base, environment: config.environment, allowance: taskProviderAllowance(config.allowance, entry.task),
    mandatoryPolicy: config.mandatory_policy || [], sources: { data: sources.bytes.toString("base64"), hash: sources.hash, hashes, inputHead, inputBranch, repo: entry.repo, branch: entry.branch, snapshotHash: snapshot.hash } };
}
