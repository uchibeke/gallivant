import { safeLink } from "./links.mjs";
import { shellQuote } from "../runtime-environment.mjs";
import { ago } from "../time.mjs";
import { durationText } from "./presentation_time.mjs";
import { ATTENTION_GROUPS } from "./attention.mjs";
import { esc, badge, button, field, select, emptyState, notice, icon } from "./primitives.mjs";
import { phaseBadge } from "./presentation_html.mjs";
import { page, at, header } from "./shell.mjs";

export const OVERVIEW_PAGE_SIZE = 25;
export const OVERVIEW_FILTERS = ["q", "repo", "phase", "harness", "attention", "chain"];
const chainsOf = row => row.presentation?.chains ?? (row.presentation?.chain ? [row.presentation.chain] : []);
// Bounded strings only; filters are selectors, never state mutations or path inputs.
export function overviewQuery(query = {}) {
  const result = {};
  for (const key of OVERVIEW_FILTERS) if (typeof query[key] === "string" && query[key].trim()) result[key] = query[key].trim().slice(0, 256);
  if (["dark", "light"].includes(query.theme)) result.theme = query.theme;
  if (query.by === "harness") result.by = "harness";
  const offset = Number(query.offset);
  if (Number.isSafeInteger(offset) && offset > 0) result.offset = String(Math.floor(offset / OVERVIEW_PAGE_SIZE) * OVERVIEW_PAGE_SIZE);
  return result;
}

export function overviewWindow(model, query = {}) {
  const filters = overviewQuery(query);
  const rows = ["needs_you", "running", "done"].flatMap(key => model[key] || []);
  const group = row => row.presentation?.attention?.group || "unknown";
  const counts = items => Object.fromEntries(ATTENTION_GROUPS.map(([key]) => [key, items.filter(row => group(row) === key).length]));
  const matches = rows.filter(row => {
    const p = row.presentation;
    const values = { repo: p?.delivery.repository || "unknown", phase: p?.phase.id || "unknown", harness: row.harness || "unknown", attention: group(row) };
    const names = chainsOf(row).map(chain => chain.name || "none"), chainNames = names.length ? names : ["none"];
    if (Object.keys(values).some(key => filters[key] && filters[key] !== values[key])) return false;
    if (filters.chain && !chainNames.includes(filters.chain)) return false;
    const hay = [row.id, row.handle, ...Object.values(values), ...chainNames, p?.phase.label, p?.reason, p?.attention.title, p?.nextAction].join(" ").toLowerCase();
    return !filters.q || hay.includes(filters.q.toLowerCase());
  });
  const order = new Map(ATTENTION_GROUPS.map(([key], i) => [key, i]));
  // Stable tie order avoids reshuffling otherwise equivalent rows at each observation.
  matches.sort((a, b) => order.get(group(a)) - order.get(group(b)) || (a.presentation?.attention?.priority ?? 5) - (b.presentation?.attention?.priority ?? 5));
  // Keep a selected page even if its last task disappears: explain the empty page.
  const start = Number(filters.offset || 0);
  return { filters, all: rows, total: rows.length, matched: matches.length, counts: counts(rows), matchedCounts: counts(matches),
    start, rows: matches.slice(start, start + OVERVIEW_PAGE_SIZE), next: start + OVERVIEW_PAGE_SIZE < matches.length ? start + OVERVIEW_PAGE_SIZE : null };
}

const time = (value, clock) => value ? `<time datetime="${esc(value)}" data-relative-time>${esc(ago(value, clock))}</time>` : "unknown";
const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
function taskRow(row, { base, query, clock }) {
  const p = row.presentation, a = p.attention;
  const href = at(base, "/run", query, { id: row.id });
  const pr = safeLink(row.url);
  const chains = chainsOf(row).map(chain => `${chain.name || "Chain"} · ${chain.predecessor ? "Predecessor" : `${chain.position ?? "?"}/${chain.total ?? "?"}`} · ${chain.status || "unknown"}`);
  const chainSummary = (chains.length ? chains : ["No chain recorded"]).map(value => `<span>${esc(value)}</span>`).join("");
  return `<article class="overview-task" data-key="task:${esc(row.id)}" data-task-id="${esc(row.id)}">
<div class="task-identity"><p class="task-repository">${esc(p.delivery.repository || "Repository unknown")}</p>
<h3><a href="${esc(href)}">${esc(row.id.split("/").at(-1))}</a></h3><span class="task-handle">${esc(row.handle)}</span>
<div class="task-tags">${phaseBadge(p)}${badge(row.harness || "Harness unknown")}</div></div>
<div class="task-decision"><strong>${esc(a.title)}</strong><p>${esc(a.nextAction)}</p>
<div class="task-evidence"><span>Delivery: ${esc(p.readiness.status)}</span><span>Checks: ${esc(p.checks.status)}</span><span>Independent review: ${esc(p.review.verdict === "findings" || p.review.verdict === "clear" ? p.review.verdict : p.review.status)}</span><span>External review: ${esc(p.review.external || "unknown")}</span></div></div>
<div class="task-progress"><span>Activity ${time(p.activity.at, clock)}</span><span>Rounds ${p.rounds.used ?? "?"} / ${p.rounds.limit ?? "?"}</span>${chainSummary}</div>
<details class="task-context" data-key="context:${esc(row.id)}"><summary>Context &amp; next step${icon("chevron")}</summary>
<div class="task-context-body"><p>${esc(a.explanation)}</p><dl class="context-facts">
${fact("Responsible actor", esc(a.actor))}${fact("Approved base / target", `${esc(p.delivery.base || "unknown")} / ${esc(p.delivery.target)}`)}
${fact("Last meaningful activity", p.activity.at ? esc(p.activity.at) : "unknown")}${fact("Last observed", esc(p.freshness.observedAt || "unknown"))}
${fact("Attempt duration", esc(durationText(p.attempt.duration)))}${fact("Acceptance receipt", esc(p.acceptance.status))}
${fact("Provider / model", `${esc(p.execution.provider || "unknown")} / ${esc(p.execution.model || "unknown")}`)}${fact("Provider readiness", esc(p.provider.label))}${fact("Retry scheduled", esc(p.retryAt || "none recorded"))}</dl>
<p class="next-step"><strong>Next step</strong> ${esc(a.nextAction)}</p>
<div class="context-links"><a class="task-open" href="${esc(href)}">Open task${p.controls.resume || p.controls.message || p.controls.recheck ? " & actions" : ""}</a>${pr ? `<a href="${esc(pr)}">PR #${esc(p.delivery.pr || "link")}</a>` : `<span class="dim">${p.delivery.pr ? `PR #${p.delivery.pr} · link unavailable` : "No PR recorded"}</span>`}</div>
<details class="technical-reason" data-key="technical:${esc(row.id)}"><summary>Technical reason &amp; evidence</summary>
<dl class="context-facts">${fact("Reason code", `<code>${esc(p.reason || "none recorded")}</code>`)}${fact("Source", `<code>${esc(a.source || "unknown")}</code>`)}${fact("Execution ownership", esc(p.ownership))}${fact("Activity source", esc(p.activity.source || "unknown"))}</dl>
<p class="note">Inspect saved diagnostics: <code>gallivant why ${esc(shellQuote(row.handle))}</code></p></details></div></details></article>`;
}

function filterForm(window, base) {
  const f = window.filters;
  const choices = (key, values, label) => {
    const options = [...new Map(values.map(([value, name]) => [value, name])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    if (f[key] && !options.some(([value]) => value === f[key])) options.push([f[key], `${f[key]} (no current tasks)`]);
    return `<label for="overview-${key}">${label}${select([{ value: "", label: `All ${label.toLowerCase()}`, selected: !f[key] }, ...options.map(([value, label]) => ({ value, label, selected: value === f[key] }))], { id: `overview-${key}`, name: key })}</label>`;
  };
  return `<form class="overview-filters" method="get" action="${esc(base)}/" role="search" aria-label="Find tasks">
<label class="overview-search" for="overview-q">Search tasks${field({ type: "search", id: "overview-q", name: "q", value: f.q || "", placeholder: "Task, repository, reason…", autocomplete: "off", maxlength: 256 })}</label>
<div class="filter-actions">${button("Apply filters", { type: "submit" })}<a href="${esc(at(base, "/", { theme: f.theme, by: f.by }))}">Clear filters</a></div>
<details class="overview-filter-options"${OVERVIEW_FILTERS.slice(1).some(key => f[key]) ? " open" : ""}><summary>Filters <span>Repository, phase, harness, attention &amp; chain</span></summary><div class="overview-filter-fields">
${choices("repo", window.all.map(r => [r.presentation.delivery.repository || "unknown", r.presentation.delivery.repository || "Unknown"]), "Repositories")}
${choices("phase", window.all.map(r => [r.presentation.phase.id, r.presentation.phase.label]), "Phases")}
${choices("harness", window.all.map(r => [r.harness || "unknown", r.harness || "Unknown"]), "Harnesses")}
${choices("attention", ATTENTION_GROUPS.map(([key, label]) => [key, label]), "Attention")}
${choices("chain", [["none", "No chain recorded"], ...window.all.flatMap(chainsOf).filter(chain => chain.name).map(chain => [chain.name, chain.name])], "Chains")}
</div></details>
${f.theme ? `<input type="hidden" name="theme" value="${esc(f.theme)}">` : ""}${f.by ? '<input type="hidden" name="by" value="harness">' : ""}
</form>`;
}

function overviewContent(model, w, { base, clock }) {
  const f = w.filters;
  return `<div id="overview-results" data-key="results">
<div class="overview-totals" data-key="totals" aria-label="All registered tasks">${ATTENTION_GROUPS.map(([key, title]) => `<a data-key="total:${key}" href="${esc(at(base, "/", { ...f, attention: key, offset: "" }))}" class="overview-total" data-kind="${key}"><span>${esc(title)}</span><strong>${w.counts[key]}</strong></a>`).join("")}</div>
<p class="overview-scope" data-key="scope">Counts above: all ${w.total} registered tasks. <strong>${w.matched} match current filters.</strong> ${w.rows.length ? `Showing ${w.start + 1}–${w.start + w.rows.length}.` : "No tasks on this page."}</p>
${ATTENTION_GROUPS.map(([key, title, description]) => {
    const rows = w.rows.filter(r => r.presentation.attention.group === key);
    return `<section class="overview-section" data-key="section:${key}" data-kind="${key}"${rows.length ? "" : " hidden"}><div class="overview-section-heading"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${badge(`${rows.length} on page · ${w.matchedCounts[key]} matching`)}</div><div class="overview-rows" data-key="rows:${key}">${rows.map(row => taskRow(row, { base, query: f, clock })).join("")}</div></section>`;
  }).join("")}
${!w.rows.length ? `<div data-key="empty">${emptyState(w.total ? "No tasks match this page. Adjust your filters or return to the first page." : "No tasks registered yet. Register a task from the CLI to see its progress here.")}</div>` : ""}
<nav class="overview-pagination" data-key="pagination" aria-label="Task pages">${w.start ? `<a href="${esc(at(base, "/", f, { offset: String(Math.max(0, w.start - OVERVIEW_PAGE_SIZE)) }))}">Previous tasks</a><a href="${esc(at(base, "/", f, { offset: "" }))}">First page</a>` : ""}<span>${OVERVIEW_PAGE_SIZE} tasks per page</span>${w.next !== null ? `<a href="${esc(at(base, "/", f, { offset: String(w.next) }))}">Next tasks</a>` : ""}</nav>
<details class="overview-health" data-key="health"><summary>Workspace status${model.daemon?.alive ? " · daemon running" : " · daemon unavailable"}</summary>
${notice(model.daemon?.alive ? `Daemon running. Last tick ${model.daemon.lastTick || "unknown"}.` : model.daemon ? `Daemon down, last tick ${model.daemon.lastTick || "unknown"}. Run: gallivant up` : "daemon has never run here. Run: gallivant up", model.daemon?.alive ? "info" : "warning")}
${model.latestError ? notice(model.latestError, "error") : ""}${(model.repositoryGuidance || []).map(r => notice(`${r.repo}: ${r.detail}`, "warning")).join("")}</details></div>`;
}

// Initial pages and refreshes compose choices and results from one read model.
export function overviewSnapshot(model, { query = {}, base = "", clock = Date } = {}) {
  const w = overviewWindow(model, query);
  return { content: overviewContent(model, w, { base, clock }), filters: filterForm(w, base), observedAt: new Date(clock.now()).toISOString() };
}

export function dashboard(model, { query = {}, by = "state", base = "", theme = null, home = null, clock = Date } = {}) {
  const f = overviewQuery({ ...query, by });
  const snapshot = overviewSnapshot(model, { query: f, base, clock });
  const actions = `<div class="new-task"><a class="intake-primary-link" href="${esc(at(base, "/task/new", { theme }))}">New task</a><span>Prepare, review, then explicitly start</span></div>`;
  return page({ title: "Overview", theme, base, body: `${header(base, "Overview", "dash", f, home, actions)}
<main class="overview main" id="main" tabindex="-1" data-overview>
<div class="overview-connection"><p id="overview-status" role="status">Snapshot loaded · <time datetime="${snapshot.observedAt}">${snapshot.observedAt}</time></p>${button("Refresh", { id: "overview-refresh" })}${button("Apply updates", { id: "overview-apply", hidden: true })}</div>
${snapshot.filters}${snapshot.content}</main>` });
}
