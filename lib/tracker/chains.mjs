import { chainRows, chainRevision } from "../chains.mjs";
import { taskPresentation } from "./presentation.mjs";
import { chainControlAvailability, chainFileLabel } from "./chain_controls.mjs";
import { redact } from "../execution_io.mjs";
import { safeLink } from "./links.mjs";
import { esc, badge, button, emptyState, notice } from "./primitives.mjs";
import { page, header, at } from "./shell.mjs";

export const CHAIN_PAGE_SIZE = 20;
export const MILESTONE_PAGE_SIZE = 25;
const text = value => typeof value === "string" ? redact(value).slice(0, 600) : "unknown";
const digest = value => /^[a-f0-9]{64}$/.test(value || "") ? value : "not recorded";
const number = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
export function chainQuery(query = {}) {
  const result = {};
  for (const key of ["chain", "cq", "cs", "milestone"]) if (typeof query[key] === "string" && query[key]) result[key] = query[key].slice(0, 256);
  if (["light", "dark"].includes(query.theme)) result.theme = query.theme;
  for (const key of ["co", "mo"]) if (query[key] != null && /^\d+$/.test(String(query[key]))) result[key] = String(number(query[key]));
  return result;
}
const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
const tone = status => status === "merged" ? "live" : ["stopped", "changed-brief", "closed-unmerged"].includes(status) ? "attention" : "";

export function milestoneProjection(c, s, index, entry = null) {
  const p = entry ? taskPresentation({ entry }) : null;
  let status = "queued", label = "Queued", source = "chain.steps / chain.index";
  let next = index > c.index ? `Wait for milestone ${index} to merge into ${c.base}.` : c.after && !c.after.merged
    ? `Wait for predecessor PR #${c.after.pr} to merge into ${c.base}.` : "Wait for the daemon to validate approved inputs and dispatch.";
  // A chain merge receipt alone opens this dependency. Task readiness and worker
  // exit never move the index or contribute to integrated progress.
  if (s.merged) { status = "merged"; label = "Merged dependency"; source = "chain.steps[].merged"; next = `Merge ${s.merged.sha} recorded in ${c.base}.`; }
  else if (entry?.completionEvidence?.terminal?.state === "CLOSED") { status = "closed-unmerged"; label = "Closed without merge"; source = "entry.completionEvidence.terminal"; next = "Reopen and register the predecessor PR before retrying, or cancel future milestones."; }
  else if (s.dispatch || entry) {
    status = p?.phase.id === "delivery_ready" ? "delivery-ready" : "active";
    label = status === "delivery-ready" ? "Delivery ready · merge required" : entry?.last?.exit != null ? "Worker ended · merge required" : "Started · merge required";
    source = status === "delivery-ready" ? p.phase.source : "chain.steps[].dispatch / entry.last";
    next = entry?.pr ? `Inspect PR #${entry.pr}; the daemon must confirm its merge into ${c.base} before the next milestone.` : "Open the task to inspect its current run and delivery evidence.";
  }
  if (!s.merged && index >= c.index && !s.dispatch && !entry && c.status === "cancelled") { status = "cancelled"; label = "Future dispatch cancelled"; next = "This chain will not start this milestone. Existing runs are preserved."; source = "chain.status"; }
  if (!s.merged && index === c.index && c.status === "stopped") {
    status = /changed|fingerprint|snapshot|sources/i.test(c.reason || "") ? "changed-brief" : /closed without merging/i.test(c.reason || "") ? "closed-unmerged" : "stopped";
    label = status === "changed-brief" ? "Approval changed · review required" : status === "closed-unmerged" ? "Closed without merge" : "Chain stopped";
    next = text(c.reason); source = "chain.reason";
  }
  return { index, id: s.id, status, label, source, next, task: Boolean(entry), url: safeLink(entry?.url),
    observedAt: entry?.updated_at || c.updated_at || null, target: p?.delivery.target || "unknown until task registration",
    taskPhase: p?.phase.label || null, fingerprint: digest(s.digest), brief: chainFileLabel(s.relPath),
    files: Object.keys(s.baseFiles || {}).map(chainFileLabel), merged: s.merged || null };
}

function chainDetail(ctx, c, row, q, base, authorized, outsideFilters = false) {
  let selected = c.steps.findIndex(s => s.id === q.milestone);
  const missing = Boolean(q.milestone && selected < 0);
  if (selected < 0) selected = Math.min(c.index, c.steps.length - 1);
  const offset = q.mo ? Math.floor(number(q.mo) / MILESTONE_PAGE_SIZE) * MILESTONE_PAGE_SIZE : Math.floor(Math.max(selected, 0) / MILESTONE_PAGE_SIZE) * MILESTONE_PAGE_SIZE;
  const list = c.steps.slice(offset, offset + MILESTONE_PAGE_SIZE).map((s, i) => milestoneProjection(c, s, offset + i, ctx.state.get(s.id)));
  const chosen = c.steps[selected];
  const detail = chosen && (list.find(s => s.index === selected) || milestoneProjection(c, chosen, selected, ctx.state.get(chosen.id)));
  const merged = c.steps.filter(s => s.merged).length;
  const controls = chainControlAvailability(ctx, c, authorized);
  const href = extra => at(base, "/chains", q, { chain: c.name, ...extra });
  return `<section class="chain-workspace" aria-labelledby="chain-title" data-chain="${esc(c.name)}" data-revision="${chainRevision(c)}">
${outsideFilters ? notice("The selected chain is outside the current filters. Its context is retained below.") : ""}
<div class="chain-title"><div><p class="eyebrow">Dependency workspace</p><h2 id="chain-title">${esc(c.name)}</h2><p>${esc(c.repo)} · approved base <strong>${esc(c.base)}</strong></p></div>${badge(c.status, tone(c.status))}</div>
<div class="chain-progress"><strong>${merged} of ${c.steps.length} dependencies merged</strong><span>Ready PRs and ended workers do not count as integrated.</span></div>
${notice(`Next gate: ${text(row.reason)}. ${c.status === "cancelled" ? "Future dispatch is cancelled; existing workers are preserved." : c.status === "done" ? "All dependency merges are recorded." : `Only host-confirmed merges into ${c.base} unlock successors.`}`, ["stopped", "cancelled"].includes(c.status) ? "warning" : "info")}
${c.after ? `<p class="chain-anchor">Registered predecessor: ${esc(c.after.id)} · ${c.after.merged ? "merge recorded" : "waiting for merge"}${safeLink(c.after.url) ? ` · <a href="${esc(safeLink(c.after.url))}" rel="noreferrer">PR #${esc(c.after.pr)}</a>` : ""}. Evidence: chain.after${c.after.merged ? `.merged · ${esc(c.after.merged.sha)}` : ""}</p>` : ""}
${missing ? notice("The linked milestone is no longer in this chain. Current dependency shown; the requested URL is preserved.", "warning") : ""}
<div class="chain-columns"><section aria-labelledby="milestones-heading"><h3 id="milestones-heading">Milestones in dependency order</h3>
<ol class="milestone-list" start="${offset + 1}">${list.map(s => `<li data-milestone="${esc(s.id)}"${s.index === selected ? ' class="selected"' : ""}><div class="milestone-order" aria-hidden="true">${s.index + 1}</div><div><a class="milestone-select" href="${esc(href({ milestone: s.id, mo: "" }))}"${s.index === selected ? ' aria-current="step"' : ""}>${esc(s.id.split("/").at(-1))}</a>${badge(s.label, tone(s.status))}<p>${esc(s.next)}</p></div></li>`).join("")}</ol>
<nav class="chain-pagination" aria-label="Milestone pages">${offset > 0 ? `<a href="${esc(href({ mo: String(Math.max(0, offset - MILESTONE_PAGE_SIZE)) || "0" }))}">Earlier milestones</a>` : ""}<span>${Math.min(offset + 1, c.steps.length)}–${Math.min(offset + MILESTONE_PAGE_SIZE, c.steps.length)} of ${c.steps.length}</span>${offset + MILESTONE_PAGE_SIZE < c.steps.length ? `<a href="${esc(href({ mo: String(offset + MILESTONE_PAGE_SIZE) }))}">Later milestones</a>` : ""}</nav></section>
${detail ? `<section class="milestone-detail" aria-labelledby="milestone-title"><p class="eyebrow">Selected milestone ${detail.index + 1} / ${c.steps.length}</p><h3 id="milestone-title">${esc(detail.id.split("/").at(-1))}</h3>${badge(detail.label, tone(detail.status))}<p>${esc(detail.next)}</p><div class="chain-links">${detail.task ? `<a href="${esc(at(base, "/run", q, { id: detail.id, chain: c.name, milestone: detail.id }))}">Open task</a>` : '<span>Task link available after dispatch</span>'}${detail.url ? `<a href="${esc(detail.url)}" rel="noreferrer">Open PR</a>` : '<span>No safe PR link recorded</span>'}</div>
<dl class="chain-facts">${fact("Evidence", esc(detail.source))}${fact("Last observation", esc(detail.observedAt || "unknown"))}${fact("Task phase", esc(detail.taskPhase || "Not dispatched"))}${fact("Task delivery target", esc(detail.target))}${fact("Chain dependency target", "Merged into approved base")}${fact("Brief", esc(detail.brief))}</dl>
<details><summary>Approved fingerprint &amp; sources</summary><code>${esc(detail.fingerprint)}</code><ul>${detail.files.map(p => `<li>${esc(p)}</li>`).join("")}</ul><p>Fingerprint binds the repository, checkout, approved base, brief and carried sources. File contents are not exposed here.</p></details></section>` : ""}</div>
<section class="chain-recovery" aria-labelledby="chain-recovery-title"><h3 id="chain-recovery-title">Recovery for future milestones</h3><p>Repair the recorded blocker, review the scope, then confirm. New chains are created through CLI intake.</p>
<div class="chain-actions">${Object.entries(controls).map(([action, control]) => `<div>${button(action === "resnapshot" ? "Review changed inputs" : action === "retry" ? "Review retry" : "Review cancellation", { "data-chain-action": action, disabled: !control.available, "aria-describedby": `chain-${action}-help` })}<p id="chain-${action}-help">${esc(control.reason || control.scope)}</p></div>`).join("")}</div>
${c.control ? `<p>Last chain request: ${esc(c.control.action)} · ${esc(c.control.status)} · <code>${esc(c.control.id)}</code></p>` : ""}</section></section>`;
}

export function chainsSnapshot(ctx, { query = {}, base = "", authorized = true } = {}) {
  const q = chainQuery(query), all = chainRows(ctx);
  const filtered = all.filter(c => (!q.cs || c.status === q.cs) && (!q.cq || `${c.name} ${c.repo} ${c.base}`.toLowerCase().includes(q.cq.toLowerCase())));
  const offset = Math.floor(number(q.co) / CHAIN_PAGE_SIZE) * CHAIN_PAGE_SIZE;
  const rows = filtered.slice(offset, offset + CHAIN_PAGE_SIZE);
  const c = q.chain ? ctx.state.getChain(q.chain) : null, row = all.find(r => r.name === q.chain);
  const content = `<div id="chains-results"><div class="chain-index"><h2>Chains <span class="dim">${filtered.length}</span></h2>${rows.length ? `<ul class="chain-index-list">${rows.map(r => `<li><a href="${esc(at(base, "/chains", q, { chain: r.name, milestone: "", mo: "" }))}"${r.name === c?.name ? ' aria-current="page"' : ""}><strong>${esc(r.name)}</strong><span>${esc(r.repo)} · ${esc(r.status)} · ${r.completed}/${r.total} merged</span></a></li>`).join("")}</ul>` : emptyState(all.length ? "No chains match these filters. Clear the filters to browse again." : "No chains queued. Create a chain with approved ready briefs through CLI intake.")}
<nav class="chain-pagination" aria-label="Chain pages">${offset ? `<a href="${esc(at(base, "/chains", q, { co: String(Math.max(0, offset - CHAIN_PAGE_SIZE)) }))}">Previous chains</a>` : ""}<span>${CHAIN_PAGE_SIZE} chains per page</span>${offset + CHAIN_PAGE_SIZE < filtered.length ? `<a href="${esc(at(base, "/chains", q, { co: String(offset + CHAIN_PAGE_SIZE) }))}">Next chains</a>` : ""}</nav></div>
${c && row ? chainDetail(ctx, c, row, q, base, authorized, !filtered.some(r => r.name === c.name)) : emptyState(q.chain ? "This chain is no longer registered. Choose a chain from the list." : "Choose a chain to inspect its ordered dependencies and next gate.")}</div>`;
  return { content: redact(content), observedAt: new Date(ctx.clock?.now() ?? Date.now()).toISOString() };
}
export function chainsPage(ctx, { query = {}, base = "", theme = null, home = null, controlToken = null } = {}) {
  const q = chainQuery(query), snapshot = chainsSnapshot(ctx, { query: q, base, authorized: !!controlToken });
  return page({ title: "Chains", theme, base, body: `${header(base, "Chains", "chains", q, home)}<main id="main" class="main chains" tabindex="-1" data-chains data-token="${esc(controlToken || "")}">
<div class="chain-connection"><p id="chains-status" role="status">Saved snapshot · ${snapshot.observedAt}</p>${button("Refresh chains", { id: "chains-refresh" })}${button("Apply chain updates", { id: "chains-apply", hidden: true })}</div>
<form class="chain-filters" action="${esc(base)}/chains" method="get"><label>Find chain<input name="cq" type="search" maxlength="256" value="${esc(q.cq || "")}"></label><label>Chain status<select name="cs">${["", "active", "stopped", "cancelled", "done"].map(s => `<option value="${s}"${q.cs === s ? " selected" : ""}>${s || "All statuses"}</option>`).join("")}</select></label>${["theme", "chain", "milestone"].filter(k => q[k]).map(k => `<input type="hidden" name="${k}" value="${esc(q[k])}">`).join("")}${button("Filter chains", { type: "submit" })}<a href="${esc(at(base, "/chains", { theme }))}">Clear filters</a></form>
${snapshot.content}<dialog id="chain-confirm" aria-labelledby="chain-confirm-title"><h2 id="chain-confirm-title">Review chain recovery</h2><div id="chain-review" tabindex="0" role="region" aria-label="Reviewed scope and differences"></div><p id="chain-action-status" role="status"></p><div class="chain-dialog-actions">${button("Confirm reviewed action", { id: "chain-submit", disabled: true })}${button("Close", { id: "chain-close" })}</div></dialog></main>` });
}
