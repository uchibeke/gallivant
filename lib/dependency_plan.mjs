import { basename, dirname, join } from "node:path/posix";
import { parseContextPathsMeta, parseSourcesMeta } from "./config.mjs";
import { dependencyGraph } from "./dependency_plan_graph.mjs";
import { PLAN_LIMITS, PLAN_VERSION, planError, qualifiedIdLength } from "./dependency_plan_limits.mjs";
import { localPlanPath, planSources } from "./dependency_plan_sources.mjs";
import { parseFrontmatter } from "./prd.mjs";
import { recoveryDigest } from "./recovery_digest.mjs";
import { assertBranchName, repositoryIdentity } from "./repository.mjs";
import { entryId } from "./state.mjs";
import { dependencyPlanApprovalDigest } from "./dependency_plan_approval.mjs";

export { PLAN_LIMITS, PLAN_VERSION };
export { dependencyPlanApprovalDigest } from "./dependency_plan_approval.mjs";
export { compileLinearChain } from "./dependency_plan_linear.mjs";

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const nodeTypes = {
  task: ["id", "type", "repository", "prd", "needs"],
  group: ["id", "type", "mode", "children", "file", "needs"],
  anchor: ["id", "type", "target"],
};
const field = (node, key) => node.value[key] ?? { at: node.at, value: undefined };

function mapping(node, keys) {
  if (!node.value || Object.getPrototypeOf(node.value) !== null) throw planError(node.at, "expected a mapping");
  if (keys) {
    for (const [key, value] of Object.entries(node.value)) {
      if (!keys.includes(key)) {
        const label = key.length <= PLAN_LIMITS.idLength ? ` ${JSON.stringify(key)}` : "";
        throw planError(value.keyAt, `unknown field${label}`);
      }
    }
  }
  return node;
}

function sequence(node) {
  if (!Array.isArray(node.value)) throw planError(node.at, "expected a list");
  return node.value;
}

function string(node, label, max = PLAN_LIMITS.pathBytes) {
  if (typeof node.value !== "string" || !node.value || Buffer.byteLength(node.value) > max) {
    throw planError(node.at, `expected ${label} (at most ${max} bytes)`);
  }
  return node.value;
}

function identifier(node) {
  const id = string(node, "an ID", PLAN_LIMITS.idLength);
  if (!slug.test(id)) throw planError(node.at, "ID must use lowercase letters, digits and single dashes");
  return id;
}

function reference(node, { allowRoot = false } = {}) {
  const ref = string(node, "a node reference", qualifiedIdLength + Number(allowRoot));
  const parts = (allowRoot && ref.startsWith("/") ? ref.slice(1) : ref).split("/");
  if (parts.length > PLAN_LIMITS.depth || parts.some(id => !slug.test(id) || id.length > PLAN_LIMITS.idLength)) {
    throw planError(node.at, "invalid node reference; use slash-separated IDs");
  }
  return ref;
}

function versioned(document, keys) {
  mapping(document, ["version", ...keys]);
  const version = field(document, "version");
  if (version.value !== PLAN_VERSION) throw planError(version.at, "unsupported plan version; expected 1");
}

function declaredRepositories(document, checkouts, authorizeRepository) {
  const repos = new Map();
  for (const [alias, spec] of Object.entries(mapping(document).value)) {
    identifier({ value: alias, at: spec.keyAt });
    mapping(spec, ["repository", "checkout", "base"]);
    const repo = field(spec, "repository"), base = field(spec, "base"), checkout = field(spec, "checkout");
    const repoName = string(repo, "an owner/name or host/owner/name repository");
    const branch = string(base, "a base branch");
    let repository;
    try { repository = repositoryIdentity(repoName).key; }
    catch (error) { throw planError(repo.at, error.message); }
    try { assertBranchName(branch); }
    catch (error) { throw planError(base.at, error.message); }
    const directory = localPlanPath(checkout.value, checkout.at, { directory: true });
    if (!checkouts.has(directory)) throw planError(checkout.at, "checkout requires explicit operator approval with --checkout");
    const binding = { repository, base: branch, checkout: directory };
    authorizeRepository?.(binding, repo.at);
    repos.set(alias, binding);
  }
  return repos;
}

function externalTarget(fieldNode) {
  const target = mapping(fieldNode, ["plan", "boundary", "node"]);
  const plan = identifier(field(target, "plan"));
  const boundary = field(target, "boundary"), node = field(target, "node");
  if ((boundary.value === undefined) === (node.value === undefined)) {
    throw planError(target.at, "anchor target needs exactly one of boundary or node");
  }
  if (node.value !== undefined) return { plan, node: reference(node) };
  if (boundary.value !== "terminal") throw planError(boundary.at, "anchor boundary must be terminal");
  return { plan, boundary: "terminal" };
}

function taskSource(node, repos) {
  const repoField = field(node, "repository"), prdField = field(node, "prd");
  const repo = repos.get(identifier(repoField));
  if (!repo) throw planError(repoField.at, "unknown repository alias");
  const prd = localPlanPath(prdField.value, prdField.at);
  if (!/(^|\/)docs\/prds\/[a-z0-9][a-z0-9-]*\.md$/.test(prd)) {
    throw planError(prdField.at, "expected a PRD path under docs/prds with a lowercase-dash filename");
  }
  return { ...repo, prd, taskId: entryId(repo.repository, basename(prd, ".md")) };
}

export function capturePlanBrief(task, sources, at) {
  const path = localPlanPath(join(task.checkout, task.prd), at);
  const { meta } = parseFrontmatter(sources.read(path, at, task).text);
  if (meta.status !== "ready") throw planError(at, `${path}: PRD must declare status: ready`);
  // Bound the shared PRD source parser before its duplicate and path checks.
  if (parseContextPathsMeta(meta.sources).length > PLAN_LIMITS.files) {
    throw planError(at, `${path}: exceeds the 32-file source closure limit`);
  }
  const { paths, problems } = parseSourcesMeta(meta.sources);
  if (problems.length) throw planError(at, `${path}: invalid PRD sources; use contained local file paths`);
  for (const pathField of paths) {
    const carriedAt = `${path} sources`;
    const carried = localPlanPath(pathField, carriedAt);
    sources.read(localPlanPath(join(task.checkout, carried), carriedAt), carriedAt, task);
  }
}

function assertPreviewSize(preview, at) {
  if (Buffer.byteLength(JSON.stringify(preview)) > PLAN_LIMITS.previewBytes) {
    throw planError(at, "exceeds the 4 MiB normalized preview limit");
  }
}

/** Read-only compilation inside an operator-selected local directory. */
export function captureDependencyPlan(file, { directory = process.cwd(), checkouts = [], inline, authorizeFile, authorizeRepository } = {}) {
  const approved = new Set([".", ...checkouts.map(path => localPlanPath(path, "--checkout", { directory: true }))]);
  const sources = planSources(directory, { inline, authorizeFile });
  const path = sources.rootFile(file);
  const document = sources.document(path, path);
  versioned(document, ["name", "repositories", "nodes"]);
  const name = identifier(field(document, "name"));
  const repos = declaredRepositories(field(document, "repositories"), approved, authorizeRepository);
  const graph = dependencyGraph(name, document.at);
  const active = new Set([path]);
  const briefs = new Set();

  function append(parent, list, containing) {
    for (const node of sequence(list)) {
      mapping(node);
      const type = field(node, "type");
      if (typeof type.value !== "string" || !Object.hasOwn(nodeTypes, type.value)) {
        throw planError(type.at, "node type must be task, group or anchor");
      }
      mapping(node, nodeTypes[type.value]);
      const id = identifier(field(node, "id"));
      const rawNeeds = field(node, "needs");
      const needs = rawNeeds.value === undefined ? [] : sequence(rawNeeds).map(item => ({ ref: reference(item, { allowRoot: true }), at: item.at }));
      if (type.value === "task") {
        const task = taskSource(node, repos);
        graph.add(parent, { id, type: "task", ...task }, node.at, needs);
        const key = `${task.checkout}\0${task.prd}`;
        if (!briefs.has(key)) {
          capturePlanBrief(task, sources, field(node, "prd").at);
          briefs.add(key);
        }
      } else if (type.value === "anchor") {
        graph.add(parent, { id, type: "anchor", target: externalTarget(field(node, "target")), resolution: "unresolved" }, node.at);
      } else {
        const mode = field(node, "mode"), inline = field(node, "children"), include = field(node, "file");
        if (!["sequence", "parallel"].includes(mode.value)) throw planError(mode.at, "group mode must be sequence or parallel");
        if ((inline.value === undefined) === (include.value === undefined)) {
          throw planError(node.at, "group needs exactly one of children or file");
        }
        const group = graph.add(parent, { id, type: "group", mode: mode.value }, node.at, needs);
        if (include.value === undefined) append(group, inline, containing);
        else {
          const fragmentPath = localPlanPath(join(dirname(containing), localPlanPath(include.value, include.at)), include.at);
          if (active.has(fragmentPath)) throw planError(include.at, `recursive include of ${fragmentPath}`);
          if (active.size >= PLAN_LIMITS.depth) throw planError(include.at, "exceeds the 32-source include depth limit");
          const fragment = sources.document(fragmentPath, include.at);
          versioned(fragment, ["children"]);
          active.add(fragmentPath);
          append(group, field(fragment, "children"), fragmentPath);
          active.delete(fragmentPath);
        }
      }
    }
    if (parent !== graph.root && !parent.children.length) throw planError(list.at, "group must contain at least one child");
  }

  append(graph.root, field(document, "nodes"), path);
  const preview = { graph: graph.finish(), sources: sources.closure(), manifestPath: path, admission: "unbound" };
  assertPreviewSize(preview, document.at);
  preview.graphDigest = recoveryDigest(preview.graph);
  preview.approvalDigest = dependencyPlanApprovalDigest(preview);
  assertPreviewSize(preview, document.at);
  return { preview, sources };
}

export function compileDependencyPlan(file, options) {
  return captureDependencyPlan(file, options).preview;
}
