import { join } from "node:path/posix";
import { anchorGrants, canReadPlan, planCatalog, planFailure, planScope } from "../dependency_plan_anchors.mjs";
import { isPlanDigest } from "../dependency_plan_approval.mjs";
import { PLAN_LIMITS } from "../dependency_plan_limits.mjs";
import { localPlanPath } from "../dependency_plan_sources.mjs";
import { redact } from "../execution_io.mjs";
import { assertBranchName, repositoryIdentity } from "../repository.mjs";
import { PRIVATE_PATH } from "../task_repository_context.mjs";
import { chainFileLabel } from "./chain_controls.mjs";
import { factoryNote } from "./factory_projection.mjs";

const briefPath = /(?:^|\/)docs\/prds\/[a-z0-9][a-z0-9-]*\.md$/;
const uploadedPath = /^uploaded-plan\.(?:json|yaml)$/;
const bindingKey = ({ repository, base, checkout }) => JSON.stringify([repository, base, checkout]);
const compactNumber = value => Number.isFinite(value) && value >= 0 ? value : null;
const routeLabel = value => typeof value === "string" && /^[a-z0-9_][\w./:@+-]{0,127}$/i.test(value) && !value.includes("//") &&
  !value.split("/").includes("..") && redact(value) === value ? value : null;

// A mount supplies exact, trusted checkout/base and input bindings. A browser
// chooses among them, and does not send authority, a directory or a file list.
export function authoringBindings(ctx, operator) {
  const configured = ctx.planInputs;
  if (!operator || !configured?.directory || !Array.isArray(configured.bindings)) return new Map();
  const bindings = new Map();
  for (const row of configured.bindings) {
    try {
      const repository = repositoryIdentity(row.repository).key;
      if (!canReadPlan(operator, planScope(operator.tenant, [repository]))) continue;
      const checkout = localPlanPath(row.checkout, "approved checkout", { directory: true });
      const base = assertBranchName(row.base);
      const binding = { repository, base, checkout, files: new Set() };
      const key = bindingKey(binding);
      const saved = bindings.get(key) ?? binding;
      for (const file of row.files ?? []) {
        const path = localPlanPath(file, "approved input"), rooted = join(checkout, path);
        if (!PRIVATE_PATH.test(rooted) && !uploadedPath.test(rooted)) saved.files.add(path);
      }
      bindings.set(key, saved);
    } catch { /* An invalid operator binding grants no input access. */ }
  }
  return bindings;
}

export function authoringChoices(ctx, operator) {
  return [...authoringBindings(ctx, operator).values()].map(({ files, ...binding }, index) => ({
    ...binding, alias: `repository-${index + 1}`, briefs: [...files].filter(path => briefPath.test(path) && chainFileLabel(path) === path).sort(),
  }));
}

export function uploadedPlanInput(ctx, operator, manifest, { receiptOnly = false } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.keys(manifest).some(key => !["format", "text"].includes(key)) ||
    !["json", "yaml"].includes(manifest.format) || typeof manifest.text !== "string" ||
    !manifest.text.trim() || Buffer.byteLength(manifest.text) > PLAN_LIMITS.sourceBytes || /\p{Cs}/u.test(manifest.text)) {
    throw planFailure("PLAN_REQUEST", "Supply one UTF-8 JSON or YAML manifest of at most 1 MiB.");
  }
  const file = `uploaded-plan.${manifest.format}`, inline = { path: file, text: manifest.text };
  return { file, options: receiptOnly ? { inline } : boundPlanOptions(ctx, operator, inline) };
}

export function boundPlanOptions(ctx, operator, inline) {
  const bindings = authoringBindings(ctx, operator);
  if (!bindings.size) throw planFailure("PLAN_AUTHORITY", "No approved browser input bindings are available.");
  const filesFor = new Map([...bindings].map(([key, binding]) => [key, new Set([...binding.files].map(path => join(binding.checkout, path)))]));
  const rooted = new Set([...filesFor.values()].flatMap(files => [...files]));
  return {
    directory: ctx.planInputs.directory,
    checkouts: [...new Set([...bindings.values()].map(binding => binding.checkout))],
    inline,
    authorizeRepository: spec => {
      if (!bindings.has(bindingKey(spec))) throw planFailure("PLAN_INPUT", "The repository, checkout and base must match an approved input binding.");
    },
    authorizeFile: (path, _at, task) => {
      const allowed = task ? filesFor.get(bindingKey(task))?.has(path) : rooted.has(path);
      if (!allowed) throw planFailure("PLAN_INPUT", task
        ? "A ready brief or carried source is outside its approved checkout input binding."
        : "The manifest or include is outside the approved input bindings. Use inline children or ask the operator to bind that file.");
    },
  };
}

export function planReferences(ctx, access, params) {
  const operator = access.operator;
  const bindings = authoringBindings(ctx, operator);
  const allowed = new Set([...bindings.values()].map(binding => binding.repository));
  const repos = params.getAll("repo"), name = params.get("producer"), search = (params.get("q") ?? "").slice(0, 80).toLowerCase();
  if (!repos.length || repos.length > PLAN_LIMITS.files || repos.some(repo => !allowed.has(repo))) {
    throw planFailure("PLAN_INPUT", "Choose the consumer repositories from the approved bindings to find producers.");
  }
  const scope = planScope(operator.tenant, repos);
  const catalog = planCatalog(access.saved, { tolerateUnavailable: true })
    .filter(plan => !plan.cancelled && anchorGrants(operator, scope, plan.scope));
  if (name) {
    const matches = catalog.filter(plan => plan.name === name);
    if (matches.length !== 1) throw planFailure("PLAN_ANCHOR", "Producer unavailable.");
    const nodes = matches[0].graph.nodes.filter(node => node.type === "task" && node.id.includes(search)).map(node => node.id);
    return { nodes: nodes.slice(0, 25), omitted: Math.max(0, nodes.length - 25) };
  }
  const byName = new Map();
  for (const plan of catalog) byName.set(plan.name, (byName.get(plan.name) ?? 0) + 1);
  const matches = [...byName].filter(([value, count]) => count === 1 && value.includes(search)).map(([value]) => value).sort();
  return { producers: matches.slice(0, 20), omitted: Math.max(0, matches.length - 20) };
}

// Review data sent to the dialog is a projection, never a serialized policy,
// route configuration, credential binding, checkout or source document.
export function planReviewView(result) {
  if (result.status !== "review") return result;
  const { preview, scope, ...identity } = result;
  const view = { ...identity };
  if (scope) view.scope = {
    ...scope,
    ...(Object.hasOwn(scope, "firstFailure") ? { firstFailure: factoryNote(scope.firstFailure) } : {}),
    ...(scope.sources ? { sources: scope.sources.map(change => ({ ...change, id: chainFileLabel(change.id) })) } : {}),
  };
  if (preview) {
    const { bindings, graph, observation } = preview, limits = bindings.limits;
    const repositories = new Map(bindings.repositories);
    const observations = new Map(observation.anchors);
    const anchors = bindings.anchors.map(([id, pin]) => {
      const saved = observations.get(id), statuses = new Map(saved?.nodes);
      return { id, name: saved?.name, instanceId: pin.producer.instanceId, revision: pin.producer.structuralRevision,
        nodes: pin.nodes.map(node => ({ id: node.id, contract: node.contract, status: statuses.get(node.id) ?? "missing" })) };
    });
    const hostBlocked = [...repositories.values()].some(repo => !repo.hostDispatch);
    const reviewBlocked = [...repositories.values()].some(repo => repo.review.status === "qualification-required");
    const routeBlocked = bindings.tasks.some(([, task]) => !task.route.routeAvailable);
    const blockers = [
      ...(!observation.canQueue ? ["This operator has no queue grant for the proposed repository scope."] : []),
      ...(observation.dispatch === "disabled" ? ["Graph dispatch is disabled. Admission records an observation-only plan."] : []),
      ...(hostBlocked ? ["A repository host has no qualified dispatch route."] : []),
      ...(reviewBlocked ? ["An approved review route still requires qualification."] : []),
      ...(routeBlocked ? ["An author route is unavailable for dispatch."] : []),
      ...(anchors.some(anchor => anchor.nodes.some(node => node.status !== "integrated")) ? ["One or more frozen prerequisites await an integration receipt."] : []),
      ...(bindings.controls.some(([, hold]) => hold.active) ? ["A saved dispatch hold applies to the proposed scope."] : []),
    ];
    const groups = [];
    function groupRows(nodes) {
      for (const node of nodes) if (node.type === "group") {
        groups.push({ id: node.id, mode: node.mode, entries: node.entries, exits: node.exits });
        groupRows(node.children);
      }
    }
    groupRows(graph.hierarchy);
    const author = limits.authorCapacity;
    const parallel = Math.min(limits.maxLiveGraphAuthors, author?.authors ?? 0, author?.per_plan ?? 0);
    view.proposal = {
      name: graph.name, graphDigest: preview.graphDigest, dependency: graph.dependency, groups, edges: graph.edges, anchors,
      repositories: [...repositories.values()].map(repo => ({ repository: repo.key, base: repo.base, host: repo.host, review: repo.review.mode })),
      tasks: bindings.tasks.map(([id, task]) => {
        const repo = repositories.get(task.repositoryBinding);
        return { id, repository: repo.key, base: repo.base, harness: routeLabel(task.route.harness), transport: routeLabel(task.route.transport),
          model: routeLabel(task.route.model), provider: routeLabel(task.route.provider), routeAvailable: task.route.routeAvailable,
          providerPerRunCap: task.route.providerPerRunCap === true, timeoutMinutes: compactNumber(task.timeoutMinutes),
          files: task.files.map(file => ({ path: chainFileLabel(file.path), digest: file.digest, baseDigest: file.baseDigest })) };
      }),
      sources: preview.sources.map(({ path, digest }) => ({ path: chainFileLabel(path), digest: isPlanDigest(digest) ? digest : null })),
      parallel: { admitted: parallel, perRepository: Math.min(parallel, limits.maxGraphAuthorsPerRepository, author?.per_repository ?? 0),
        preparations: author?.preparations ?? null, requestedGroups: groups.filter(group => group.mode === "parallel").length },
      budgetUsd: compactNumber(limits.maxBudgetUsd), rounds: compactNumber(limits.maxIterations),
      resources: {
        freeBytes: compactNumber(limits.resources.minimum_free_bytes), freeInodes: compactNumber(limits.resources.minimum_free_inodes),
        memoryBytes: compactNumber(limits.resources.minimum_memory_bytes), loadPerCpu: compactNumber(limits.resources.maximum_load_per_cpu),
      },
      canConfirm: result.action !== "queue" || observation.canQueue,
      blockers,
    };
  }
  return view;
}

export function planValidationMessage(error) {
  const diagnostic = error.planDiagnostic;
  if (!diagnostic) return null;
  const location = /^(uploaded-plan\.(?:yaml|json):\d+:\d+)$/.exec(diagnostic.at)?.[1];
  const reason = diagnostic.message;
  const messages = [
    [/^invalid JSON syntax$/, "Invalid JSON syntax."],
    [/^invalid plan syntax|^YAML /, "Invalid syntax or unsupported YAML feature."],
    [/^duplicate mapping key/, "Duplicate mapping key."],
    [/^forbidden mapping key|^interpolation/, "Forbidden key, interpolation or control character."],
    [/^unknown field/, "Unknown manifest field."],
    [/^cannot read/, "An approved input could not be read. Check its operator binding and regular file."],
    [/^expected a contained local path/, "Use contained relative paths for checkouts, briefs and includes."],
    [/^checkout requires/, "The checkout is outside the approved input bindings."],
    [/^dependency cycle|^unresolved local needs|^duplicate node|^duplicate canonical task/, "Check dependency references, cycles and duplicate identities."],
    [/\blimit\b/, "A manifest input or expansion limit was exceeded."],
    [/^[^\n]*PRD must declare status: ready/, "Every task input must be a ready brief."],
  ];
  const message = messages.find(([pattern]) => pattern.test(reason))?.[1] ??
    "The manifest does not match the version 1 schema. Check node types, required fields and input references.";
  return location ? `${message} See ${location}.` : message;
}
