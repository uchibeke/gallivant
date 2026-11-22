import { OVERVIEW_PAGE_SIZE, OVERVIEW_FILTERS, workspaceQuery } from "./query.mjs";
import { onboarding } from "./onboarding.mjs";
import { safeLink, externalLink } from "./links.mjs";
import { shellQuote } from "../runtime-environment.mjs";
import { ago } from "../time.mjs";
import { durationText } from "./presentation_time.mjs";
import { ATTENTION_GROUPS } from "./attention.mjs";
import { esc, badge, button, field, select, emptyState, notice, icon, disclosureIcon } from "./primitives.mjs";
import { OUTCOMES, outcomeLabel, readinessLabel, recoveryDetail } from "./presentation.mjs";
import { decisionCard, fact, phaseBadge, relativeTime } from "./presentation_html.mjs";
import { FACTORY_VERSION, factoryTaskSummary } from "./factory_projection.mjs";
import { factoryTaskHref } from "./factory_links.mjs";
import { page, at, header } from "./shell.mjs";

export { OVERVIEW_PAGE_SIZE, OVERVIEW_FILTERS, overviewQuery } from "./query.mjs";
const chainsOf = row => row.presentation?.chains?.length ? row.presentation.chains
  : row.presentation?.chain ? [row.presentation.chain] : row.plan ? [{ name: row.plan.name }] : [];
const outcome = row => row.status ?? row.presentation?.outcome ?? "unknown";
export function overviewWindow(model, query = {}) {
  const filters = workspaceQuery(query);
  const rows = model.factory?.tasks ?? ["needs_you", "running", "done"].flatMap(key => model[key] || []);
  const group = row => row.presentation?.attention?.group || "unknown";
  const counts = items => Object.fromEntries(ATTENTION_GROUPS.map(([key]) => [key, items.filter(row => group(row) === key).length]));
  const scoped = rows.filter(row => {
    const p = row.presentation;
    const values = { repo: row.repository || p?.delivery.repository || "unknown", phase: p?.phase.id || "unknown", harness: row.harness || "unknown", attention: group(row) };
    const names = chainsOf(row).map(chain => chain.name || "none"), chainNames = names.length ? names : ["none"];
    if (Object.keys(values).some(key => key !== "attention" && filters[key] && filters[key] !== values[key])) return false;
    if (filters.chain && !chainNames.includes(filters.chain)) return false;
    const hay = [row.id, row.handle, row.plan?.node, outcome(row), ...Object.values(values), ...chainNames, p?.phase.label, p?.reason, p?.attention.title, p?.nextAction].join(" ").toLowerCase();
    return !filters.q || hay.includes(filters.q.toLowerCase());
  });
  const attentionScope = scoped.filter(row => !filters.status || outcome(row) === filters.status);
  const outcomeScope = scoped.filter(row => !filters.attention || group(row) === filters.attention);
  const matches = attentionScope.filter(row => !filters.attention || group(row) === filters.attention);
  const outcomes = Object.fromEntries(OUTCOMES.map(([key]) => [key, outcomeScope.filter(row => outcome(row) === key).length]));
  const order = new Map(ATTENTION_GROUPS.map(([key], i) => [key, i]));
  // Saved activity only: polling must never promote an older task to the top.
  const activity = row => row.times?.meaningful.at ?? row.presentation?.activity.at ?? "";
  const recent = (a, b) => activity(b).localeCompare(activity(a)) || a.id.localeCompare(b.id) ||
    (a.plan?.id ?? "").localeCompare(b.plan?.id ?? "");
  matches.sort(filters.sort === "attention" ? (a, b) => order.get(group(a)) - order.get(group(b)) ||
    (a.presentation?.attention?.priority ?? 5) - (b.presentation?.attention?.priority ?? 5) || recent(a, b) : recent);
  // Keep a selected page even if its last task disappears: explain the empty page.
  const start = Number(filters.offset || 0);
  return { filters, all: rows, total: rows.length, scopedTotal: attentionScope.length, outcomeTotal: outcomeScope.length,
    matched: matches.length, counts: counts(attentionScope), matchedCounts: counts(matches), outcomes,
    start, rows: matches.slice(start, start + OVERVIEW_PAGE_SIZE), next: start + OVERVIEW_PAGE_SIZE < matches.length ? start + OVERVIEW_PAGE_SIZE : null };
}

function taskRow(row, { base, query, clock }) {
  const p = row.presentation, a = p.attention;
  const href = row.version ? factoryTaskHref(base, query, row) : at(base, "/run", query, { id: row.id });
  const pr = safeLink(row.delivery?.url ?? row.url);
  const key = row.plan ? `${row.plan.id}:${row.plan.node}` : row.id;
  const activityAt = row.times?.meaningful.at ?? p.activity.at;
  const handle = row.handle || (p.delivery.pr ? `${p.delivery.repository?.split("/").at(-1)}#${p.delivery.pr}` : row.id);
  const plans = row.plan?.kind === "graph" ? [row.plan.name] : chainsOf(row).map(chain =>
    [chain.name, chain.predecessor ? "Predecessor" : chain.total ? `${chain.position ?? "?"}/${chain.total}` : null, chain.status].filter(Boolean).join(" · "));
  const planSummary = plans.map(value => `<span>Plan · ${esc(value)}</span>`).join("");
  return `<article class="overview-task" data-key="task:${esc(key)}" data-task-id="${esc(row.id)}" data-outcome="${esc(outcome(row))}">
<div class="task-identity"><p class="task-repository">${esc(row.repository || p.delivery.repository || "Repository unknown")}</p>
<h3><a href="${esc(href)}">${esc(row.title ?? row.id.split("/").at(-1))}</a></h3><span class="task-handle">${esc(handle)}</span>
<div class="task-tags">${phaseBadge(p)}${p.phase.label === outcomeLabel(outcome(row)) ? "" : badge(outcomeLabel(outcome(row)))}</div></div>
<div class="task-decision">${decisionCard(a, { compact: true })}
<div class="task-evidence"><span>Delivery: ${esc(readinessLabel(p))}</span><span>Checks: ${esc(p.checks.status)}</span><span>Independent review: ${esc(p.review.verdict === "findings" || p.review.verdict === "clear" ? p.review.verdict : p.review.status)}</span><span>External review: ${esc(p.review.external || "unknown")}</span><span>Acceptance: ${esc(p.acceptance.status)}</span></div></div>
<div class="task-progress"><span>Responsible actor · ${esc(a.actor?.replaceAll("-", " ") || "unknown")}</span><span>Last activity · ${relativeTime(activityAt, clock)}</span><span>Rounds ${p.rounds.used ?? "?"} / ${p.rounds.limit ?? "?"}</span>${planSummary}${row.blockerCount ? `<span>${row.blockerCount} of ${row.prerequisiteCount} prerequisites waiting</span>` : ""}${pr ? `<div class="task-primary-links">${externalLink(pr, `PR #${row.delivery?.pr || p.delivery.pr || "link"}`)}</div>` : ""}</div>
<details class="task-context" data-key="context:${esc(key)}"><summary>Context &amp; next step${disclosureIcon()}</summary>
<div class="task-context-body"><p>${esc(a.explanation)}</p><dl class="context-facts">
${fact("Recovery", esc(recoveryDetail(p)))}
${fact("Responsible actor", esc(a.actor))}${fact("Approved base / target", `${esc(row.base ?? p.delivery.base ?? "unknown")} / ${esc(row.delivery?.target ?? p.delivery.target)}`)}
${fact("Last meaningful activity", esc(activityAt || "unknown"))}${fact("Last observed", esc(row.times?.observed.at || p.freshness.observedAt || "unknown"))}
${fact("Attempt duration", esc(durationText(p.attempt.duration)))}${fact("Acceptance receipt", esc(p.acceptance.status))}
${fact("Provider / model", `${esc(p.execution.provider || "unknown")} / ${esc(p.execution.model || "unknown")}`)}${fact("Provider readiness", esc(p.provider.label))}${fact("Retry scheduled", esc(row.recovery?.retryAt ?? p.recovery.nextAt ?? p.retryAt ?? "none recorded"))}</dl>
<p class="next-step"><strong>Next step</strong> ${esc(a.nextAction)}</p>
<div class="context-links"><a class="task-open" href="${esc(href)}">${row.registered === false ? row.plan ? "Open plan node" : "Open intake" : "Open task"}</a>${!pr ? `<span class="dim">${p.delivery.pr ? `PR #${p.delivery.pr} · link unavailable` : "No PR recorded"}</span>` : ""}</div>
<details class="technical-reason" data-key="technical:${esc(key)}"><summary>Technical reason &amp; evidence</summary>
<dl class="context-facts">${fact("Reason code", `<code>${esc(p.reason || "none recorded")}</code>`)}${fact("Source", `<code>${esc(a.source || "unknown")}</code>`)}${fact("Execution ownership", esc(p.ownership))}${fact("Activity source", esc(p.activity.source || "unknown"))}</dl>
${row.registered === false ? "" : `<p class="note">Inspect saved diagnostics with <code>gallivant why ${esc(shellQuote(handle))}</code></p>`}</details></div></details></article>`;
}

function filterForm(window, base, path) {
  const f = window.filters;
  const choices = (key, values, label) => {
    const choices = new Map(values);
    const options = [...choices.entries()].sort((a, b) => a[1].localeCompare(b[1])).slice(0, 100);
    if (f[key] && !options.some(([value]) => value === f[key])) options.push([f[key], choices.get(f[key]) ?? `${f[key]} (no current tasks)`]);
    const id = key === "status" ? "overview-outcome" : `overview-${key}`;
    return `<label for="${id}">${label}${select([{ value: "", label: `All ${label.toLowerCase()}`, selected: !f[key] }, ...options.map(([value, label]) => ({ value, label, selected: value === f[key] }))], { id, name: key })}</label>`;
  };
  return `<form class="overview-filters" method="get" action="${esc(base + path)}" role="search" aria-label="Find tasks">
<label class="overview-search" for="overview-q">Search tasks${field({ type: "search", id: "overview-q", name: "q", value: f.q || "", placeholder: "Task, repository, reason…", autocomplete: "off", maxlength: 256 })}</label>
<label class="overview-sort" for="overview-sort">Sort tasks${select([{ value: "recent", label: "Newest activity first", selected: f.sort !== "attention" }, { value: "attention", label: "Needs attention first", selected: f.sort === "attention" }], { id: "overview-sort", name: "sort" })}</label>
<div class="filter-actions">${button("Apply filters", { type: "submit" })}<a href="${esc(at(base, path, { theme: f.theme, by: f.by }))}">Reset filters</a></div>
<details class="overview-filter-options"${["repo", "phase", "harness", "chain", "status"].some(key => f[key]) ? " open" : ""}><summary>Filters <span>Repository, phase, harness, attention, plan &amp; outcome</span></summary><div class="overview-filter-fields">
${choices("repo", window.all.map(r => [r.repository || r.presentation.delivery.repository || "unknown", r.repository || r.presentation.delivery.repository || "Unknown"]), "Repositories")}
${choices("phase", window.all.map(r => [r.presentation.phase.id, r.presentation.phase.label]), "Phases")}
${choices("harness", window.all.map(r => [r.harness || "unknown", r.harness || "Unknown"]), "Harnesses")}
${choices("attention", ATTENTION_GROUPS.map(([key, label]) => [key, label]), "Attention")}
${choices("chain", [["none", "No plan recorded"], ...window.all.flatMap(chainsOf).filter(chain => chain.name).map(chain => [chain.name, chain.name])], "Plans")}
${choices("status", OUTCOMES, "Outcomes")}
</div></details>
${Object.entries(f).filter(([k, v]) => v && ![...OVERVIEW_FILTERS, "theme", "by", "sort", "offset"].includes(k)).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("")}
${f.theme ? `<input type="hidden" name="theme" value="${esc(f.theme)}">` : ""}${f.by ? '<input type="hidden" name="by" value="harness">' : ""}
</form>`;
}

function overviewContent(model, w, { base, clock, path, surface }) {
  const f = w.filters;
  return `<div id="${surface}-results" data-key="results">
<nav class="overview-totals" data-key="totals" aria-label="Task attention">${[["", "All tasks"], ...ATTENTION_GROUPS].map(([key, title]) => `<a data-key="total:${key || "all"}" href="${esc(at(base, path, { ...f, attention: key, offset: "" }))}" class="overview-total" data-kind="${key || "all"}"${(f.attention || "") === key ? ' aria-current="page"' : ""}><span>${esc(title)}</span><strong>${key ? w.counts[key] : w.scopedTotal}</strong></a>`).join("")}</nav>
<nav class="outcome-filters" data-key="outcomes" aria-label="Task outcomes">${[["", "All outcomes"], ...OUTCOMES].map(([key, title]) => `<a href="${esc(at(base, path, f, { status: key, offset: "" }))}"${(f.status || "") === key ? ' aria-current="page"' : ""}>${esc(title)} <strong>${key ? w.outcomes[key] : w.outcomeTotal}</strong></a>`).join("")}</nav>
${model.factory?.permissions === "scoped" ? notice("Showing work available to this workspace identity. Some tasks or plans may be outside its scope.") : ""}
${model.factory?.partial ? notice("Some saved records could not be loaded. The counts reflect available records.", "warning") : ""}
<p class="overview-scope" data-key="scope">${w.rows.length ? `Showing ${w.start + 1}–${w.start + w.rows.length} of` : w.matched ? "No tasks on this page." : "No tasks match."} <strong>${w.matched} matching task${w.matched === 1 ? "" : "s"}</strong>${w.scopedTotal !== w.total ? ` · ${w.total} visible in this workspace` : ""}. Status counts follow your search and filters.</p>
${(f.sort === "attention" ? ATTENTION_GROUPS : [["recent", f.attention ? ATTENTION_GROUPS.find(([key]) => key === f.attention)?.[1] || "Tasks" : "Recent tasks", "Ordered by last meaningful activity"]]).map(([key, title, description]) => {
    const rows = key === "recent" ? w.rows : w.rows.filter(r => r.presentation.attention.group === key);
    return `<section class="overview-section" data-key="section:${key}" data-kind="${key}"${rows.length ? "" : " hidden"}><div class="overview-section-heading"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${badge(`${rows.length} shown · ${key === "recent" ? w.matched : w.matchedCounts[key]} matching`)}</div><div class="overview-rows" data-key="rows:${key}">${rows.map(row => taskRow(row, { base, query: f, clock })).join("")}</div></section>`;
  }).join("")}
${model.factory?.permissions === "scoped" ? "" : onboarding(model.health?.setup, { base, query: f })}
${!w.rows.length ? `<div data-key="empty">${emptyState(w.total ? "No tasks match this page. Adjust your filters or return to the first page." : "No tasks registered yet. Prepare a task or follow the CLI setup steps above.")}</div>` : ""}
<nav class="overview-pagination" data-key="pagination" aria-label="Task pages">${w.start ? `<a href="${esc(at(base, path, f, { offset: String(Math.max(0, w.start - OVERVIEW_PAGE_SIZE)) }))}">Previous tasks</a><a href="${esc(at(base, path, f, { offset: "" }))}">First page</a>` : ""}<span>${OVERVIEW_PAGE_SIZE} tasks per page</span>${w.next !== null ? `<a href="${esc(at(base, path, f, { offset: String(w.next) }))}">Next tasks</a>` : ""}</nav>
<details class="overview-health" data-key="health"><summary>Workspace status · ${esc(model.health?.coordinator.state || "unknown")}</summary>
${model.health ? notice(`${model.health.coordinator.nextStep} Last observation: ${model.health.coordinator.observedAt || "unknown"}.`, model.health.coordinator.state === "up" ? "info" : "warning") : notice("daemon has never run here. Run: gallivant up", "warning")}
<a href="${esc(at(base, "/system", f))}">View system health and setup</a></details></div>`;
}

// Initial pages and refreshes compose choices and results from one read model.
export function overviewSnapshot(model, { query = {}, base = "", clock = Date, surface = "overview" } = {}) {
  const w = overviewWindow(model, model.factory && surface === "overview" && !query.sort ? { ...query, sort: "attention" } : query);
  const path = surface === "overview" ? "/" : "/tasks";
  return { content: overviewContent(model, w, { base, clock, path, surface }), filters: filterForm(w, base, path),
    observedAt: new Date(clock.now()).toISOString(),
    ...(model.factory ? { factory: { version: FACTORY_VERSION, snapshotAt: model.factory.snapshotAt, permissions: model.factory.permissions,
      partial: model.factory.partial, counts: w.outcomes, total: w.total, matched: w.matched, offset: w.start, next: w.next,
      tasks: w.rows.map(factoryTaskSummary) } } : {}) };
}

export function dashboard(model, { query = {}, by = "state", base = "", theme = null, home = null, clock = Date, surface = "overview" } = {}) {
  const f = workspaceQuery({ ...query, by });
  const snapshot = overviewSnapshot(model, { query: f, base, clock, surface });
  const label = surface === "overview" ? "Overview" : "Tasks";
  const intake = model.factory?.permissions === "scoped" ? "" : `<a class="intake-primary-link header-action" href="${esc(at(base, "/task/new", f))}">${icon("plus")}<span>New task</span></a>`;
  const actions = `<div class="workspace-actions">${intake}<a href="${esc(at(base, "/runs", f))}">${icon("history")}Run history</a></div>`;
  return page({ title: label, theme, base, body: `${header(base, label, surface === "overview" ? "dash" : "tasks", f, home, actions)}
<main class="overview main" id="main" tabindex="-1" data-${surface} data-snapshot="${surface}">
<div class="overview-connection"><p id="${surface}-status" role="status">View refreshed <time datetime="${snapshot.observedAt}" data-relative-time title="${snapshot.observedAt}">${esc(ago(snapshot.observedAt, clock))}</time></p>${button("Refresh", { id: `${surface}-refresh` })}${button("Apply updates", { id: `${surface}-apply`, hidden: true })}</div>
${snapshot.filters}${snapshot.content}</main>` });
}
