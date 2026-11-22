import { dependencyGraph } from "./dependency_plan_graph.mjs";
import { PLAN_LIMITS, planError } from "./dependency_plan_limits.mjs";
import { repositoryIdentity } from "./repository.mjs";

export const linearNodeId = id => id.split("/").at(-1);

/** Adapt the linear CLI's saved description without reading state or a Git host. */
export function compileLinearChain({ name, repo, base, steps, after = null }) {
  const at = "linear chain";
  const repository = repositoryIdentity(repo).key;
  const graph = dependencyGraph(name, at, "sequence");
  if (after) {
    const stepIds = new Set(steps.map(step => linearNodeId(step.id)));
    let id = "predecessor";
    for (let n = 1; stepIds.has(id); n++) id = `predecessor-${n}`;
    graph.add(graph.root, { id, type: "anchor", target: after.target ?? { taskId: after.id, pr: after.pr }, resolution: "unresolved" }, at);
  }
  for (const step of steps) {
    graph.add(graph.root, { id: linearNodeId(step.id), type: "task", repository, base, checkout: ".", prd: step.relPath, taskId: step.id }, at);
  }
  const normalized = graph.finish();
  if (Buffer.byteLength(JSON.stringify(normalized)) > PLAN_LIMITS.previewBytes) throw planError(at, "exceeds the 4 MiB normalized preview limit");
  return normalized;
}
