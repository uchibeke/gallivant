import { contentDigest } from "../hash.mjs";
import { esc } from "./primitives.mjs";
import { at } from "./shell.mjs";

export const artifactReference = /^(task|intake|plan|chain|review)\.([a-f0-9]{64})\.([a-f0-9]{64})$/;

export const artifactKey = (...parts) => contentDigest(JSON.stringify(parts));
export const artifactRef = (kind, key, file = null) => `${kind}.${key}.${artifactKey(file)}`;

export const taskBriefRef = (id, entry) => entry.prd ? artifactRef("task", artifactKey(id, entry.created_at, entry.prd,
  entry.snapshot_digest, entry.prd_fingerprint, entry.sources_digest, entry.sources)) : null;
export const intakeBriefRef = (id, draft) => draft ? artifactRef("intake", artifactKey(id, draft.revision, draft.hash)) : null;
export const planFilesRef = plan => plan ? artifactRef("plan", artifactKey(plan.id, plan.approval.revision, plan.approval.approvalDigest)) : null;
export function planNodeFilesRef(plan, node) {
  const root = planFilesRef(plan);
  const task = plan?.approval.graph.nodes.find(item => item.type === "task" && item.id === node);
  const brief = task && plan.approval.bindings.tasks.find(([id]) => id === node)?.[1].files.find(file => file.path === task.prd);
  return root && brief ? artifactRef("plan", root.split(".")[1], brief.source) : null;
}
export const chainFilesRef = (chain, step) => step?.relPath ? artifactRef("chain", artifactKey(chain.name, chain.created_at, step.id, step.digest)) : null;

export function artifactLink(base, path, query, reference, label, selection = {}) {
  return reference ? `<a class="artifact-trigger" data-artifact-link href="${esc(at(base, path, query, { ...selection, artifact: reference }))}" aria-haspopup="dialog">${esc(label)}</a>` : "";
}
