import { PLAN_LIMITS } from "../dependency_plan_limits.mjs";
import { DIAGRAM_PAGE_SIZE } from "./plan_neighborhood.mjs";
import { badge, button, esc, field, icon, notice, select, textarea } from "./primitives.mjs";

export const planStatusLabel = value => ({
  integrated: "Integrated", "closed-unmerged": "Closed without integration", cancelled: "Cancelled", waiting: "Waiting",
  "producer-unavailable": "Producer unavailable", unavailable: "Unavailable", blocked: "Blocked", missing: "Receipt missing",
  held: "Held", planned: "Queued", active: "Active", queued: "Queued", unverified: "Unverified",
  "review-required": "Review required", "merge-unqualified": "Merge unqualified", "pr-registered": "PR registered",
}[value] ?? value);

export const groupLabel = mode => mode === "sequence" ? "Sequence group" : "Parallel group";

const relationship = {
  before: "Prerequisite",
  both: "Prerequisite and dependent through this group",
  focus: "Focused node",
  after: "Dependent",
};

function diagramItem(node, choose, list = false) {
  const status = node.phase?.label ?? (node.type === "group" && node.status === "open" ? "Collapsed group" : planStatusLabel(node.status));
  return `<li data-key="diagram:${esc(node.id)}" data-node-id="${esc(node.id)}" data-relation="${node.relation}"><a class="milestone-select" href="${esc(choose(node.id))}"${node.relation === "focus" ? ' aria-current="step"' : ""}>
<span>${esc(node.title)}</span>${node.id !== node.title ? `<small>${esc(node.id)}</small>` : ""}</a>
${list ? `<small>${relationship[node.relation]}</small>` : node.relation === "both" ? '<small>Also a dependent</small>' : ""}
${badge(status, node.status === "blocked" || node.status === "held" ? "attention" : "")}</li>`;
}

export function planDiagram(diagram, { choose, href }) {
  const nodes = diagram.nodes;
  const column = (heading, relation) => {
    const items = nodes.filter(node => relation.includes(node.relation));
    return `<div><h4>${heading}</h4><ul>${items.map(node => diagramItem(node, choose)).join("")}</ul>${items.length ? "" : '<p class="dim">None on this page</p>'}</div>`;
  };
  const page = offset => esc(href({ dp: String(offset) }));
  return `<section class="plan-neighborhood" aria-labelledby="plan-diagram-title" data-key="neighborhood">
<div class="plan-section-heading"><div><h3 id="plan-diagram-title">Dependency diagram</h3><p class="dim">One hop from the selected node. Select another node to refocus.</p></div>
<a href="${esc(href({ diagram: "", dp: "" }))}">Hide diagram</a></div>
<div class="plan-diagram" role="region" aria-label="Focused dependency diagram" tabindex="0">
${column('Prerequisites <span aria-hidden="true">→</span>', ["before", "both"])}
${column("Selected node", ["focus"])}
${column('<span aria-hidden="true">→</span> Dependents', ["after"])}
</div>
<p class="dim">${nodes.length} shown · ${diagram.omitted} neighbors omitted on this page · ${diagram.outside} outside the neighborhood · ${diagram.collapsed} inside collapsed groups</p>
${diagram.omitted || diagram.offset ? `<nav class="chain-pagination" aria-label="Diagram pages">
${diagram.offset ? `<a href="${page(Math.max(0, diagram.offset - DIAGRAM_PAGE_SIZE))}">Earlier neighbors</a>` : ""}
${diagram.offset + DIAGRAM_PAGE_SIZE < diagram.total ? `<a href="${page(diagram.offset + DIAGRAM_PAGE_SIZE)}">Later neighbors</a>` : ""}</nav>` : ""}
<details data-key="diagram-alternative"><summary>Diagram as a list</summary>
<ul class="diagram-list">${nodes.map(node => diagramItem(node, choose, true)).join("")}</ul></details></section>`;
}

export function futurePlanActions(plan, { access, authorized, group = null, authoring = false }) {
  const fence = group?.fence ?? plan.future;
  const cancelled = plan.lifecycle === "cancelled" || group?.status === "cancelled";
  const target = group ? { group: group.id } : {};
  const actions = [[fence === "held" ? "unhold" : "hold", fence === "held" ? "Review releasing hold" : "Review hold"],
    ["cancel", "Review future cancellation"],
    ...(!group && authoring ? [["edit", "Edit future inputs"], ["attach", "Attach a producer"]] : [])];
  const available = actions.filter(([action]) => authorized && access.planControl(plan.id, action, target));
  return `<section class="plan-future" aria-label="${esc(group ? `Future dispatch for ${group.id}` : `Future dispatch for ${plan.name}`)}">
<h${group ? "4" : "3"}>Future dispatch${group ? " in this group" : ""}</h${group ? "4" : "3"}>
<p class="dim">${cancelled ? "Future dispatch is cancelled in this scope." : "Review the affected future tasks before changing dispatch. Admitted workers use their own task controls."}</p>
${available.length && !cancelled ? `<div class="plan-actions">${available.map(([action, label]) => button(label, {
    "data-plan-action": action, "data-plan-id": plan.id, "data-plan-group": group?.id,
    "data-plan-edit": ["edit", "attach"].includes(action) ? "true" : null,
  })).join("")}</div>` : !cancelled ? notice("Future dispatch controls require the matching operator grant.") : ""}
</section>`;
}

export function retryPlanAction(plan, node, access, authorized) {
  if (!authorized || node.registered || node.status !== "blocked" || node.phase?.id !== "operator_attention" ||
      !access.planControl(plan.id, "retry", { node: node.plan.node })) return "";
  return button("Review dispatch retry", { "data-plan-action": "retry", "data-plan-id": plan.id, "data-plan-node": node.plan.node });
}

export function planAuthoring(choices) {
  const repositories = choices.map(row => `<option value="${esc(row.alias)}" data-repository="${esc(row.repository)}"
data-base="${esc(row.base)}" data-checkout="${esc(row.checkout)}">${esc(`${row.repository} · ${row.base} (${row.checkout})`)}</option>`).join("");
  const briefs = choices.flatMap(row => row.briefs.map(path =>
    `<option value="${esc(path)}" data-binding="${esc(row.alias)}">${esc(path)}</option>`)).join("");
  return `<section class="plan-editor" id="plan-editor" aria-labelledby="plan-editor-title" hidden data-max-bytes="${PLAN_LIMITS.sourceBytes}" data-max-nodes="${PLAN_LIMITS.nodes}" data-max-depth="${PLAN_LIMITS.depth}">
<div class="plan-section-heading"><h2 id="plan-editor-title" tabindex="-1">New plan</h2>${button("Close editor", { id: "plan-editor-close" })}</div>
<form id="plan-editor-form" method="post">
<div class="plan-fields"><label>Authoring method${select([{ value: "guided", label: "Guided form" }, { value: "import", label: "JSON or YAML import" }], { id: "plan-source-mode" })}</label></div>
<div id="plan-guided">
<div class="plan-fields"><label>Plan name${field({ id: "plan-draft-name", maxlength: PLAN_LIMITS.idLength, spellcheck: "false", required: true })}</label></div>
<p class="dim">Use lowercase IDs. Enter comma-separated prerequisite IDs in Needs. A leading slash selects from the root.</p>
<div class="plan-draft-nodes"></div>
<div class="plan-actions">${button("Add task", { "data-add-plan-node": "task" })}${button("Add group", { "data-add-plan-node": "group" })}${button("Add anchor", { "data-add-plan-node": "anchor" })}</div>
</div>
<div id="plan-import" hidden>
<div class="plan-fields"><label>Manifest format${select([{ value: "json", label: "JSON" }, { value: "yaml", label: "YAML" }], { id: "plan-format" })}</label>
<label>Choose a manifest<input id="plan-upload" type="file" accept=".json,.yaml,.yml"></label></div>
<label>Manifest text${textarea("", { id: "plan-manifest", rows: 10, spellcheck: "false", autocomplete: "off" })}</label>
<p class="dim">Paste or upload one UTF-8 manifest up to 1 MiB. Briefs, carried sources and includes use the operator’s approved bindings.</p>
</div>
<div class="plan-actions">${button("Preview plan", { type: "submit", id: "plan-preview", disabled: true })}</div>
<p id="plan-editor-status" role="status"></p>
</form>
<template id="plan-repositories"><option value="">Choose a repository and base</option>${repositories}</template>
<template id="plan-briefs">${briefs}</template>
</section>`;
}

export const newPlanButton = () => `<button type="button" class="plan-primary" id="plan-new" aria-controls="plan-editor" aria-expanded="false">${icon("plus")}New plan</button>`;
