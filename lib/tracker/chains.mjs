import { chainRevision } from "../chains.mjs";
import { linearNodeId } from "../dependency_plan_linear.mjs";
import { redact } from "../execution_io.mjs";
import { factoryRecords, factoryAccess, factoryObservations } from "./factory_access.mjs";
import { factoryCatalog, factoryNote, planWindow, PLAN_PAGE_SIZE, NODE_PAGE_SIZE, PREREQUISITE_PAGE_SIZE } from "./factory_projection.mjs";
import { OUTCOMES } from "./presentation.mjs";
import { chainControlAvailability } from "./chain_controls.mjs";
import { safeLink, externalLink } from "./links.mjs";
import { esc, badge, button, emptyState, notice, select } from "./primitives.mjs";
import { cooldown, decisionCard, fact, phaseBadge, requestStatus, reviewConfirmPanel } from "./presentation_html.mjs";
import { page, header, at } from "./shell.mjs";
import { workspaceQuery } from "./query.mjs";

export { PLAN_PAGE_SIZE as CHAIN_PAGE_SIZE, NODE_PAGE_SIZE as MILESTONE_PAGE_SIZE };
export { chainQuery } from "./query.mjs";
const unknown = value => esc(value ?? "unknown");
const nodeId = node => node.plan?.node ?? node.id;

function milestoneLabel(c, row) {
  if (row.status === "integrated") return ["merged", "Merged dependency", "The merge receipt is recorded."];
  if (row.status === "closed-unmerged") return ["closed-unmerged", "Closed without merge", row.attention.nextAction];
  // The reason can qualify the legacy label only. Controls still come from the
  // existing owner, and plain reason text cannot certify terminal outcomes.
  if (c.status === "stopped" && row.index === c.index) {
    const changed = /changed|fingerprint|snapshot|sources/i.test(row.gateReason || "");
    return [changed ? "changed-brief" : "stopped", changed ? "Approval changed · review required" : "Chain stopped",
      row.gateReason || "Inspect the saved prerequisite."];
  }
  if (row.status === "cancelled") return ["cancelled", "Future dispatch cancelled", row.attention.nextAction];
  if (row.status === "ready") return ["delivery-ready", "Delivery ready · merge required", `Wait for PR #${row.delivery.pr ?? "unknown"} to merge into ${c.base}.`];
  if (row.registered || c.steps[row.index]?.dispatch) {
    return ["active", row.workerEnded ? "Worker ended · merge required" : "Started · merge required", row.attention.nextAction];
  }
  const next = row.index > c.index ? `Wait for milestone ${row.index} to merge into ${c.base}.` : row.attention.nextAction;
  return ["queued", "Queued", next];
}

// Historical callers keep the display vocabulary. Status is sourced from the
// same canonical plan projection used by both routes.
export function milestoneProjection(c, step, index, entry = null) {
  const chain = { ...c, steps: c.steps.map((s, i) => i === index ? step : s) };
  const access = factoryAccess({ chains: { [chain.name]: chain }, entries: entry ? { [step.id]: entry } : {} });
  const row = factoryCatalog(access).plans[0]?.rows[index];
  if (!row) return null;
  const [status, label, next] = milestoneLabel(chain, row);
  return { ...row, status, label, next, source: row.phase.source, task: row.registered,
    url: row.delivery.url, observedAt: row.times.observed.at, target: row.delivery.target, taskPhase: row.phase.label };
}

const pager = (offset, total, size, href, earlier, later, label) => `<nav class="chain-pagination" aria-label="${esc(label)}">${offset > 0 ? `<a href="${esc(href(Math.max(0, offset - size)))}">${esc(earlier)}</a>` : ""}
<span>${offset < total ? `${offset + 1}–${Math.min(offset + size, total)} of ${total}` : `0 shown · ${total} total`}</span>${offset + size < total ? `<a href="${esc(href(offset + size))}">${esc(later)}</a>` : ""}</nav>`;

export function dependencyList(nodes, { offset = 0, selected, href, chain }) {
  return `<ol class="milestone-list${chain ? "" : " plan-nodes"}" start="${offset + 1}">${nodes.map((node, i) => {
    const id = nodeId(node), current = selected && id === nodeId(selected);
    const legacy = chain && node.type === "task" ? milestoneLabel(chain, node) : null;
    const detail = node.plan?.node.split("/").slice(0, -1).join("/");
    return `<li data-key="node:${esc(id)}" data-milestone="${esc(chain ? node.id : id)}"${current ? ' class="selected"' : ""}>
${chain ? `<div class="milestone-order" aria-hidden="true">${offset + i + 1}</div>` : ""}
<div>${detail ? `<span class="dim">${esc(detail)}</span>` : ""}
<a class="milestone-select" href="${esc(href(node))}"${current ? ' aria-current="step"' : ""}>${esc(node.title ?? id)}</a>
${legacy ? badge(legacy[1], node.status === "blocked" ? "attention" : "") : node.type === "task" ? phaseBadge(node) : badge(node.status === "unavailable" ? "Producer unavailable" : "Anchor")}
${node.type === "task" ? `<p>${esc(legacy?.[2] ?? node.attention.nextAction)}${node.blockerCount ? ` · ${node.blockerCount} missing prerequisite${node.blockerCount === 1 ? "" : "s"}` : ""}</p>` : ""}</div></li>`;
  }).join("")}</ol>`;
}

function prerequisiteList(node, href, choose) {
  if (!node.dependencyCount) return emptyState(node.type === "anchor" ? "Producer evidence is unavailable." : "No prerequisites recorded.");
  return `<ul class="prerequisite-list">${node.dependencies.map(d => `<li>${d.id && node.type === "task" ? `<a href="${esc(choose(d.id))}">${esc(d.id)}</a>` : esc(d.id || "Prerequisite")}${d.target ? ` / ${esc(d.target)}` : ""} · ${badge(d.status)}
${d.receipt?.merge ? ` <code>${esc(d.receipt.merge)}</code>` : ""}${d.receipt?.url ? ` · ${externalLink(d.receipt.url, "PR evidence")}` : ""}</li>`).join("")}</ul>
${node.dependencyCount > PREREQUISITE_PAGE_SIZE || node.dependencyOffset ? pager(node.dependencyOffset, node.dependencyCount, PREREQUISITE_PAGE_SIZE, href,
    "Earlier prerequisites", "Later prerequisites", "Prerequisite pages") : ""}`;
}

function nodeDetail(node, { plan, chain, base, query, choose, href }) {
  const isTask = node.type === "task", legacy = chain && isTask ? milestoneLabel(chain, node) : null;
  const link = isTask && node.registered ? at(base, "/run", query, { id: node.id, ...(chain && !query.plan
    ? { chain: chain.name, milestone: node.id } : { plan: plan.id, node: node.plan.node }) }) : null;
  const pr = node.delivery?.url ?? node.url;
  return `<section class="milestone-detail" id="selected-plan-node" tabindex="-1" data-key="node-detail:${esc(nodeId(node))}" aria-labelledby="milestone-title">
${legacy ? `<p class="eyebrow">Selected milestone ${node.index + 1} / ${plan.total}</p>` : ""}<h3 id="milestone-title">${esc(node.title ?? node.id)}</h3>
${legacy ? badge(legacy[1], node.status === "blocked" ? "attention" : "") + `<p>${esc(legacy[2])}</p>` : isTask ? decisionCard(node.attention) : badge(node.status)}
<div class="chain-links">${link ? `<a href="${esc(link)}">Open task</a>` : isTask ? '<span>Task link available after registration</span>' : ""}
${pr ? externalLink(pr, "Open PR") : ""}${node.producer?.linkable ? `<a href="${esc(at(base, "/plans", query, { plan: node.producer.id, node: "", mo: "", po: "" }))}">Open producer plan</a>` : ""}</div>
${isTask ? `<dl class="chain-facts">
${fact("Repository / approved base", `${unknown(node.repository)} / ${unknown(node.base)}`)}
${fact("Dispatch observation", unknown(node.dispatch))}
${fact("Last meaningful activity", unknown(node.times.meaningful.at))}
${fact("Last observation", `${unknown(node.times.observed.at)} · ${esc(node.times.freshness)}`)}
${fact("Last recovery activity", unknown(node.times.recovery.at))}
${node.recovery.original ? fact("Original cause", unknown(node.recovery.original.detail)) : ""}
${fact("Next retry", cooldown(node.recovery.retryAt))}
${node.recovery.nextAt && node.recovery.nextAt !== node.recovery.retryAt ? fact("Next observation", cooldown(node.recovery.nextAt)) : ""}
${fact("Rounds / limit", `${unknown(node.budget.rounds.used)} / ${unknown(node.budget.rounds.limit)}`)}
${fact("Recorded recovery attempts", unknown(node.budget.cumulativeRecoveryAttempts))}
${fact("Cumulative cost", node.budget.costUsd == null ? "unknown" : `USD ${unknown(node.budget.costUsd)} · ${unknown(node.budget.costStatus)}`)}
${fact("Capability", `${unknown(node.capability.harness)} · ${esc(node.capability.dispatch)}`)}
</dl>${requestStatus(node.request, "Last task request")}
<details data-key="node-evidence"><summary>Delivery evidence &amp; timeline</summary><dl class="chain-facts">
${fact("Target / readiness", `${unknown(node.delivery.target)} / ${unknown(node.delivery.status)}`)}
${fact("Checks / acceptance", `${unknown(node.evidence.checks.status)} / ${unknown(node.evidence.acceptance.status)}`)}
${fact("Review / head", `${unknown(node.evidence.review.status)} / ${unknown(node.evidence.review.head)}`)}
${fact("Recorded merge", unknown(node.evidence.integration?.merge))}
${fact("Capability source", unknown(node.capability.source))}
${node.brief ? fact("Brief / approved fingerprint", `${unknown(node.brief)} · <code>${unknown(node.fingerprint)}</code>`) : ""}
</dl></details>` : node.producer ? `<p>Frozen producer revision <code>${unknown(node.producer.revision)}</code></p>`
    : node.status === "unavailable" ? notice("Producer unavailable or access is outside this workspace’s scope.", "warning") : ""}
<h4>${isTask ? "Prerequisites" : "Frozen scope"}</h4>${prerequisiteList(node, offset => href({ po: String(offset) }), choose)}
<a class="plan-detail-jump" href="#milestones-heading">Back to dependencies</a></section>`;
}

function chainRecovery(ctx, chain, authorized, access) {
  const controls = chainControlAvailability(ctx, chain, authorized);
  for (const [action, control] of Object.entries(controls)) {
    if (control.available && !access.chainControl(chain, action)) {
      controls[action] = { available: false, reason: "This workspace identity has no grant for this control." };
    }
  }
  return `<section class="chain-recovery" aria-labelledby="chain-recovery-title"><h3 id="chain-recovery-title">Recovery for future milestones</h3><p>Repair the recorded blocker, review the scope, then confirm.</p>
<div class="chain-actions">${Object.entries(controls).map(([action, control]) => `<div>${button(action === "resnapshot" ? "Review changed inputs" : action === "retry" ? "Review retry" : "Review cancellation", { "data-chain-action": action, disabled: !control.available, "aria-describedby": `chain-${action}-help` })}<p id="chain-${action}-help">${esc(control.reason || control.scope)}</p></div>`).join("")}</div>
${requestStatus(chain.control, "Last chain request")}</section>`;
}

export function chainsSnapshot(ctx, { query = {}, base = "", authorized = true, legacy = true, access = factoryAccess(factoryRecords(ctx.state)) } = {}) {
  const q = workspaceQuery(query), path = legacy ? "/chains" : "/plans";
  const filters = { ...q, plan: legacy ? q.chain : q.plan ?? (q.chain !== "none" ? q.chain : null),
    node: legacy ? null : q.node,
    pq: legacy ? q.cq : q.pq ?? q.cq, ps: legacy ? q.cs : q.ps ?? (q.cs ? `lifecycle:${q.cs}` : null) };
  const factory = planWindow(factoryCatalog(access, factoryObservations(ctx, access)), filters, { legacyOnly: legacy });
  const detail = factory.detail;
  const chain = detail?.kind === "legacy" ? access.chains.get(detail.name) : null;
  const milestoneView = legacy && chain;
  const href = extra => at(base, path, q, extra);
  const selectPlan = p => legacy ? { chain: p.name, milestone: "", mo: "", po: "" } : { plan: p.id, node: "", mo: "", po: "", milestone: "" };
  const choose = id => href(milestoneView ? { chain: detail.name, milestone: chain.steps.find(s => linearNodeId(s.id) === id)?.id || id, mo: "", po: "" }
    : { plan: detail.id, node: id, mo: "", po: "", milestone: "" });
  const counts = detail ? OUTCOMES.filter(([key]) => detail.counts[key]).map(([key, label]) => `${detail.counts[key]} ${label.toLowerCase()}`).join(" · ") : "";
  const selection = detail?.selected;
  const content = `<div id="chains-results" data-key="plan-results"><div class="chain-index"><h2>${legacy ? "Chains" : "Plans"} <span class="dim">${factory.matched}</span></h2>
${factory.partial ? notice("Some saved records could not be projected.", "warning") : ""}
${factory.rows.length ? `<ul class="chain-index-list">${factory.rows.map(p => `<li data-key="plan:${esc(p.id)}"><a href="${esc(href(selectPlan(p)))}"${p.id === detail?.id ? ' aria-current="page"' : ""}><strong>${esc(p.name)}</strong><span>${esc(p.repositories.join(", "))} · ${esc(p.lifecycle)} · ${p.counts.integrated}/${p.total} integrated</span></a></li>`).join("")}</ul>`
    : emptyState(factory.total ? "No plans match this page and filters." : legacy ? "No chains queued. Create a chain with approved briefs through CLI intake." : "No plans are visible in this workspace. Use the operator CLI to inspect or queue an approved plan.")}
${pager(factory.offset, factory.matched, PLAN_PAGE_SIZE, offset => href({ co: String(offset) }), legacy ? "Previous chains" : "Previous plans", legacy ? "Next chains" : "Next plans", "Plan pages")}</div>
${detail ? `<section class="chain-workspace" aria-labelledby="chain-title" data-key="plan:${esc(detail.id)}" data-selected-plan="${esc(detail.id)}" data-selected-node="${esc(selection ? nodeId(selection) : "")}"${chain ? ` data-chain="${esc(chain.name)}" data-revision="${chainRevision(chain)}" data-selected-milestone="${esc(selection?.id || "")}"` : ""}>
${detail.outsideFilters ? notice("The selected plan is outside the current filters.") : ""}
<div class="chain-title"><div><h2 id="chain-title">${esc(detail.name)}</h2><p>${esc(detail.repositories.join(", "))}</p></div>${badge(detail.lifecycle)}</div>
<div class="chain-progress"><strong>${detail.counts.integrated} of ${detail.total} ${milestoneView ? "dependencies merged" : "tasks integrated"}</strong><span>${esc(counts)}</span></div>
${detail.activeCount ? `<p>Parallel activity · ${detail.activeCount} active ${detail.activeCount === 1 ? "task" : "tasks"}${detail.active.length ? ` · ${detail.active.map(id => `<a href="${esc(choose(id))}">${esc(id)}</a>`).join(", ")}` : ""}${detail.activeCount > detail.active.length ? ` · ${detail.activeCount - detail.active.length} more` : ""}</p>` : ""}
${detail.times.freshness === "stale" ? notice(`Saved plan observations are stale. Last recorded ${detail.times.observed.at}.`, "warning") : ""}
${chain?.reason && (!chain.after || access.localAnchor(chain.after)) ? notice(factoryNote(chain.reason), chain.status === "stopped" ? "warning" : "info") : ""}
${detail.missingNode ? notice("The linked node is unavailable. Select another node to inspect its evidence.", "warning") : ""}
<div class="chain-columns"><section aria-labelledby="milestones-heading"><h3 id="milestones-heading" tabindex="-1">${milestoneView ? "Milestones in dependency order" : "Dependencies"}</h3>
${selection ? `<a class="plan-detail-jump" href="#selected-plan-node">Selected ${esc(selection.title ?? selection.id)}</a>` : ""}
${dependencyList(milestoneView ? detail.nodes.filter(n => n.type === "task") : detail.nodes, { offset: detail.offset, selected: selection, href: n => choose(nodeId(n)), chain: milestoneView })}
${pager(detail.offset, milestoneView ? detail.total : detail.nodeCount, NODE_PAGE_SIZE, offset => href({ mo: String(offset) }), "Earlier milestones", "Later milestones", "Dependency pages")}</section>
${selection ? nodeDetail(selection, { plan: detail, chain: milestoneView, base, query: { ...q, ...(legacy ? {} : { plan: detail.id }) }, choose,
      href: extra => href({ ...(legacy ? { chain: detail.name, milestone: selection.id } : { plan: detail.id, node: nodeId(selection) }), ...extra }) }) : ""}</div>
${chain ? chainRecovery(ctx, chain, authorized && (!chain.after || access.localAnchor(chain.after)), access) : `<p class="note">Approved parallel authors ${unknown(detail.capacity.approvedParallel)} · per repository ${unknown(detail.capacity.approvedPerRepository)}. Review changes through the protected plan CLI.</p>`}</section>`
    : emptyState(factory.missingPlan ? "This plan is unavailable or access is outside this workspace’s scope." : "Choose a plan to inspect its saved dependencies.")}</div>`;
  return { factory, content: redact(content), observedAt: factory.snapshotAt };
}

export function chainsPage(ctx, { query = {}, base = "", theme = null, home = null, controlToken = null, legacy = true, access } = {}) {
  const q = workspaceQuery(query), path = legacy ? "/chains" : "/plans", name = legacy ? "Chains" : "Plans";
  const snapshot = chainsSnapshot(ctx, { query: q, base, authorized: !!controlToken, legacy, access });
  const search = legacy ? "cq" : "pq", status = legacy ? "cs" : "ps";
  const searchValue = q[search] || (!legacy ? q.cq : "") || "";
  const statusValue = q[status] || (!legacy && q.cs ? `lifecycle:${q.cs}` : "");
  const statuses = legacy ? ["active", "stopped", "cancelled", "done"].map(s => [s, s])
    : [["lifecycle:active", "Active plan"], ["lifecycle:observation-only", "Observation only"],
      ["lifecycle:stopped", "Stopped plan"], ["lifecycle:done", "Ended plan"], ["lifecycle:cancelled", "Cancelled plan"], ...OUTCOMES];
  return page({ title: name, theme, base, body: `${header(base, name, legacy ? "chains" : "plans", q, home)}
<main id="main" class="main chains" tabindex="-1" data-chains data-path="${path}" data-token="${esc(controlToken || "")}">
<div class="chain-connection"><p id="chains-status" role="status">Saved snapshot · ${snapshot.observedAt}</p>${button(legacy ? "Refresh chains" : "Refresh plans", { id: "chains-refresh" })}${button(legacy ? "Apply chain updates" : "Apply plan updates", { id: "chains-apply", hidden: true })}</div>
${!legacy ? '<p class="note">Plan discovery requires a protected operator session. Use <code>gallivant plan validate</code> and <code>gallivant plan preview</code> to prepare a plan for review.</p>' : ""}
<form class="chain-filters" action="${esc(base + path)}" method="get" aria-label="Filter ${name.toLowerCase()}"><label>Find ${legacy ? "chain" : "plan"}<input name="${search}" type="search" maxlength="256" value="${esc(searchValue)}"></label>
<label>${legacy ? "Chain" : "Plan"} status${select([["", "All statuses"], ...statuses].map(([value, label]) => ({ value, label, selected: statusValue === value })), { name: status })}</label>
<label>Sort plans${select([["recent", "Newest activity first"], ["attention", "Needs attention first"]].map(([value, label]) => ({ value, label, selected: (q.sort || "recent") === value })), { name: "sort" })}</label>
${Object.entries(q).filter(([key]) => ![search, status, "cq", "cs", "sort", "co", "mo", "po"].includes(key)).map(([key, value]) => `<input type="hidden" name="${esc(key)}" value="${esc(value)}">`).join("")}
${button(`Filter ${name.toLowerCase()}`, { type: "submit" })}<a href="${esc(at(base, path, { theme }))}">Clear filters</a></form>
${snapshot.content}${reviewConfirmPanel("chain", "Review chain recovery")}</main>` });
}
