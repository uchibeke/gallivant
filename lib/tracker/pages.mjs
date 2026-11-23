// The pages: plain semantic HTML, with the stylesheet and the script served as their own files.
//
// Everything interpolated goes through `esc`. PR titles, branch names, reasons, run names and log lines come from
// GitHub or from an agent, and an agent that prints `<script>` into its log must not be able to run it in the
// reader's browser. There is one escape function and every template uses it.
import { ago } from "../time.mjs";
import { redact } from "../execution_io.mjs";
import { workspaceProjection, workspaceSnapshot } from "./workspace.mjs";
import { taskControls } from "./controls.mjs";
import { taskPresentation } from "./presentation.mjs";
import { durationText, instant } from "./presentation_time.mjs";
import { taskWindow } from "./presentation_html.mjs";

import { esc, badge, button, emptyState, loadingState } from "./primitives.mjs";
import { page, at, header, controls } from "./shell.mjs";
export { esc } from "./primitives.mjs";
export { page, CSP } from "./shell.mjs";

/**
 * The sidebar: one collapsible group per key, each holding rows. `view` names the localStorage bucket the collapsed
 * state lives in, so the two views remember their own groups. `hay` is the text a filter matches beyond what the row
 * shows, so searching for a branch or a reason finds a row that displays neither in full.
 */
const sidebar = (view, groups, controlsHtml) => `<aside id="side" data-view="${esc(view)}" aria-label="Browse ${esc(view)}">
${controlsHtml}
${groups.map(g => `<div class="group" data-group="${esc(g.key)}">
<h2 class="group-heading"><button type="button" class="group-toggle" aria-expanded="true"><i class="caret" aria-hidden="true"></i><span class="n">${esc(g.label)}</span><small>${g.rows.length}</small></button></h2>
<div class="rows">${g.rows.map(r => `<a class="row" href="${esc(r.href)}"${r.current ? ' aria-current="page"' : ""} data-hay="${esc(r.hay || "")}" title="${esc(r.title || r.label)}">
<i class="dot ${esc(r.tone || "")}"></i><span class="n">${esc(r.label)}</span><small>${esc(r.badge || "")}</small></a>`).join("")}</div>
</div>`).join("\n")}
${groups.length ? "" : emptyState("Nothing registered yet. Use gallivant start to add a task.")}
</aside>`;

/** needs-you first, then running, then done: the order `gallivant status` prints, so the two agree on sight. */
const SECTIONS = [["needs_you", "needs you"], ["running", "running"], ["done", "closed or ended"]];
const TONE = { needs_you: "needs", running: "running", done: "" };

/** How a state group's rows are built. `by=harness` regroups the same rows; nothing else about them changes. */
function entryGroups(base, m, by, current, ctxq) {
  const rows = SECTIONS.flatMap(([key]) => (m[key] || []).map(r => ({
    section: key,
    href: at(base, "/run", ctxq, { id: r.id }),
    label: r.handle,
    badge: r.presentation?.phase.label || r.label,
    tone: r.presentation ? r.presentation.phase.id === "operator_attention" || r.presentation.ownership !== "settled" ? "needs" : r.presentation.phase.id === "implementing" ? "running" : "" : TONE[key],
    title: `${r.handle} ${r.presentation?.phase.label || r.label}`,
    // What a filter searches beyond the visible text: the id, the reason, the harness and the round.
    hay: [r.id, r.presentation?.reason, r.harness, r.round].filter(Boolean).join(" "),
    harness: r.harness || "unknown",
    current: r.id === current,
  })));
  if (by === "harness") {
    const names = [...new Set(rows.map(r => r.harness))].sort();
    return names.map(h => ({ key: `harness:${h}`, label: h, rows: rows.filter(r => r.harness === h) }));
  }
  return SECTIONS.map(([key, label]) => ({ key, label, rows: rows.filter(r => r.section === key) })).filter(g => g.rows.length);
}

export const GROUPINGS = ["state", "harness"];

export { dashboard } from "./overview.mjs";

/**
 * The log pane, with the control that reaches back into the log above it.
 *
 * The stream sends the last 400 lines on open and an `event: skipped` frame saying how many it did not send, because
 * delivering thousands of lines as individual server-sent events stalls the browser until it drops the connection.
 * The button is how the reader gets the rest: it fetches the window before what the pane holds, from
 * `/api/run/history`, and keeps going back until the first line of the run.
 *
 * It is rendered disabled and says nothing, and the script fills in the count and enables it once the `skipped` frame
 * arrives. A run whose whole log fitted in the tail has nothing older, so the control never appears for it; rendering
 * it here rather than creating it in the script keeps the markup in the templates where the rest of it is.
 */
const logPane = attrs => `<div class="activity-tools"><label for="activity-search">Search loaded output<input id="activity-search" type="search" maxlength="256" placeholder="Search this bounded window"></label>${button("Next match", { id: "activity-next", disabled: true })}${button("Follow live output", { id: "follow-output", hidden: true })}<span id="activity-search-state" role="status"></span></div><p class="loadmore">${button("load earlier lines", { id: "earlier", disabled: true, hidden: true })}
<span class="hint" id="earlierstate"></span></p>
<div id="log" ${attrs} aria-live="off" aria-label="run log" tabindex="0"></div>
${loadingState("Connecting to activity…", { id: "logstate", "data-skeleton": "true" })}`;

/** Canonical task summary and evidence, with selected-attempt output in a disclosure. */
export function runPage({ id, entry, handle, run, workspace = null, attempts = [], initialLaunch = false, maxIterations, model, divergence = null, controlToken = null, controlContext = null, controlInstance = "", by = "state", theme = null, query = {}, base = "", home = null, clock = Date, access }) {
  const row = [...model.needs_you, ...model.running, ...model.done].find(r => r.id === id);
  const p = row?.presentation || taskPresentation({ id, entry, run, maxIterations, divergence, now: clock.now() });
  const ctxq = { ...query, theme: query.theme, by: by === "state" ? "" : by };
  const w = workspace || workspaceProjection({ id, entry, run, presentation: p, divergence, now: clock.now() });
  const snapshot = workspaceSnapshot(w, { base, query: ctxq, clock });
  // The log pane is driven by tracker.js, which reads these attributes. Passing the ids through the DOM rather than
  // through the script keeps the script one static file the CSP can allow by origin. `data-harness` is among them
  // because a log line's shape is the harness's, so the script needs the name to pick the right stream reader; the
  // registry is what knows it, and an entry with none renders every line as itself.
  return page({
    title: `${handle} - gallivant`,
    theme,
    base,
    body: `${header(base, id.split("/").at(-1), "run", ctxq, home)}
<div class="workspace-layout">
<main class="main workspace" id="main" tabindex="-1" data-entry="${esc(id)}" data-run="${esc(run?.id || "")}" data-latest="${esc(w.latest || "")}" data-observed="${esc(snapshot.snapshotAt || "")}" data-scoped="${Boolean(access?.protectedReads)}" data-brief-changed="${snapshot.briefChanged}">
<div id="workspace-summary">${snapshot.summary}</div>
<nav class="workspace-nav" aria-label="Workspace sections"><a href="#workspace-evidence">Evidence</a><a href="#run-controls">${controlToken && controlContext?.canSubmit !== false && entry.state !== "done" ? "Actions" : "Request status"}</a><a href="#workspace-provenance">Activity</a><a href="#workspace-recovery">Recovery</a><a href="#workspace-attempts">Attempts</a></nav>
<div class="workspace-freshness"><p id="workspace-state" role="status">Saved task snapshot · ${esc(snapshot.snapshotAt || "unknown")}</p>${button("Refresh evidence", { id: "workspace-retry" })}<a id="workspace-new-attempt" href="${esc(at(base, "/run", ctxq, { id }))}" hidden>Open new attempt</a></div>
<section id="workspace-evidence" aria-labelledby="evidence-heading"><h2 id="evidence-heading">Delivery evidence</h2><div id="workspace-evidence-content">${snapshot.evidence}</div></section>
<section aria-labelledby="review-activity-heading" id="review-activity" data-entry="${esc(id)}">
<h2 id="review-activity-heading">Reviewer activity</h2><div id="workspace-review-content">${snapshot.review}</div></section>
${taskControls({ id, entry, run, initialLaunch, controlContext, controlInstance, controlToken, refreshHref: at(base, "/run", ctxq, { id }) })}
<section id="workspace-provenance" aria-labelledby="provenance-heading"><h2 id="provenance-heading">Task activity</h2><div id="workspace-provenance-content">${snapshot.activity}</div></section>
<section id="workspace-recovery" aria-labelledby="recovery-heading"><h2 id="recovery-heading">Recovery and execution route</h2><div id="workspace-recovery-content">${snapshot.recovery}</div></section>
<section id="workspace-attempts" aria-labelledby="attempts-heading"><h2 id="attempts-heading">Attempts</h2>
<p class="note">Output, duration and execution metadata belong to the selected attempt. Task actions apply to the current logical task.</p>
<details><summary>Choose an attempt · ${attempts.length} recent attempts</summary><ol class="attempt-list">${attempts.map(r => `<li><a href="${esc(at(base, "/run", ctxq, { id, run: r.run }))}"${r.run === run?.id ? ' aria-current="true"' : ""}><code>${esc(r.run)}</code></a><span>${esc(duration(r))} · ${r.running ? "running" : `exit ${esc(r.exit ?? "unknown")}`}</span></li>`).join("")}</ol><a href="${esc(at(base, "/runs", ctxq, { entry: id }))}">every run for this entry</a></details>
<details id="execution-details"><summary>Selected attempt · execution &amp; artifacts</summary><div id="workspace-execution-content">${snapshot.execution}</div>
${run ? `<div id="workspace-artifacts" data-url="${esc(at(base, "/api/run/result", {}, { id, run: run.id, view: "summary" }))}"><p id="artifact-state" role="status">Saved result not requested yet.</p><p id="attempt-verification" class="note" hidden></p><ul id="artifact-list"></ul>${button("Retry result", { id: "artifact-retry", hidden: true })}<a href="${esc(at(base, "/api/run/result", {}, { id, run: run.id }))}">Saved result and verification</a></div>` : ""}</details></section>
<details id="workspace-activity"><summary>Activity · Agent log</summary><p class="note">Author output for selected attempt <code>${esc(run?.id || "unknown")}</code>. Raw output is diagnostic, not delivery evidence.</p>
${run ? logPane(`data-entry="${esc(id)}" data-run="${esc(run.id)}" data-harness="${esc(run.harness || "")}"`) : emptyState("No run has been dispatched for this entry yet.")}
</details>
<details class="workspace-browse"><summary>Browse tasks</summary>${sidebar("entries", entryGroups(base, taskWindow(model).model, by, id, ctxq), controls(by, GROUPINGS))}</details>
</main></div>` });
}

/** The runs tab: every run folder on disk, newest first, grouped in the sidebar and listed in full beside it. */
export function runsPage(rows, { entry = "", by = "state", theme = null, query = {}, base = "", home = null, open = null } = {}) {
  const ctxq = { ...query, theme: query.theme, by: by === "state" ? "" : by, entry };
  const groups = runGroups(base, rows, by, entry, ctxq, open);
  const body = rows.length ? `<div class="table-scroll" role="region" aria-label="Run history" tabindex="0"><table>
<thead><tr><th>started</th><th>entry</th><th>run</th><th>state</th><th class="num">duration</th><th><span class="sr-only">Open</span></th></tr></thead><tbody>
${rows.map(r => `<tr><td class="dim">${esc(when(r.startedAt))}</td>
${/* A run from another tool has no registry entry, so there is nothing to link to: it is listed, not opened. */ ""}
<td>${r.entry ? `<a href="${esc(at(base, "/run", ctxq, { id: r.entry }))}">${esc(r.handle)}</a>` : `${esc(r.handle)} ${badge(r.source || "")}`}</td>
<td class="mono">${esc(r.run)}</td>
<td>${r.running ? badge("running", "live") : r.exit === 0 ? badge("exit 0") : badge(`exit ${r.exit ?? "not recorded"}`, "bad")}</td>
<td class="num dim">${esc(duration(r))}</td>
<td><a href="${esc(at(base, "/runs", ctxq, { open: r.run, source: r.entry ? "" : r.source }))}">log</a></td></tr>`).join("\n")}
</tbody></table></div>` : emptyState(entry ? "No runs for that entry." : "No runs on disk yet.");
  return page({ title: "runs - gallivant", theme, base, body: `${header(base, "runs", "runs", ctxq, home)}
<div class="layout">${sidebar("runs", groups, controls(by, GROUPINGS))}
<main class="main" id="main" tabindex="-1">
${entry ? `<p class="dim">Filtered to <code>${esc(entry)}</code>. <a href="${esc(at(base, "/runs", ctxq, { entry: "" }))}">every entry</a></p>` : ""}
${open ? detail(base, open, ctxq) : ""}
<h2>${esc(open ? "every run" : "runs")}</h2>
${body}<p class="note">${esc(`${rows.length} run${rows.length === 1 ? "" : "s"}, newest first.`)}</p>
</main></div>` });
}

/**
 * The selected run, with its log tailing. The whole point of the sidebar: clicking a row fills this rather than
 * navigating away to the entry page, which is a different view answering a different question.
 */
const detail = (base, r, ctxq) => `<h2>${esc(r.handle)}</h2>
<dl class="facts">
<dt>run</dt><dd><code>${esc(r.run)}</code></dd>
<dt>${esc(r.entry ? "entry" : "source")}</dt><dd>${r.entry
  ? `<a href="${esc(at(base, "/run", ctxq, { id: r.entry }))}">${esc(r.entry)}</a>`
  : badge(r.source || "")}</dd>
<dt>started</dt><dd>${esc(when(r.startedAt))}</dd>
<dt>state</dt><dd>${r.running ? badge("running", "live") : r.exit === 0 ? badge("exit 0") : badge(`exit ${r.exit ?? "not recorded"}`, "bad")}${r.durationMs == null ? "" : ` <span class="dim">${esc(duration(r))}</span>`}</dd>
</dl>
${/* A foreign run's `harness` is its source label, which names no reader, so its lines render as themselves. That is
      the right answer for them: command-center's own trees hold prose lines, which the renderer already reads. */ ""}
${logPane(`data-entry="${esc(r.entry || "")}" data-source="${esc(r.source || "")}" data-run="${esc(r.run)}" data-harness="${esc(r.entry ? r.harness || "" : "")}"`)}`;

/** Runs group by state (running, failed, done) or by harness, the same two choices the entries view offers. */
function runGroups(base, rows, by, entry, ctxq, open = null) {
  // A row opens the run here rather than navigating to the entry page: the sidebar and the pane beside it are one
  // view. Every run can be opened this way, including one from another tool, which has no entry page to go to.
  const row = r => ({
    href: at(base, "/runs", ctxq, { open: r.run, source: r.entry ? "" : r.source }),
    current: open ? open.run === r.run && (open.source || "") === (r.source || "") : false,
    label: r.handle,
    badge: r.running ? "running" : duration(r) || `exit ${r.exit ?? "?"}`,
    tone: r.running ? "running" : r.exit === 0 ? "" : "failed",
    title: `${r.handle} ${r.run}`,
    hay: [r.entry, r.run, r.name, when(r.startedAt), r.harness, r.source].filter(Boolean).join(" "),
  });
  if (by === "harness") {
    const names = [...new Set(rows.map(r => r.harness || "unknown"))].sort();
    return names.map(h => ({ key: `harness:${h}`, label: h, rows: rows.filter(r => (r.harness || "unknown") === h).map(row) }));
  }
  const bucket = r => (r.running ? "running" : r.exit === 0 ? "done" : "failed");
  return [["running", "running"], ["failed", "failed"], ["done", "closed or ended"]]
    .map(([key, label]) => ({ key: `runs:${key}`, label, rows: rows.filter(r => bucket(r) === key).map(row) }))
    .filter(g => g.rows.length);
}

const when = value => {
  const at = instant(value);
  return at ? `${at.replace("T", " ").slice(0, 19)} UTC` : "unknown";
};

const duration = r => {
  if (r.attempt) return durationText(r.attempt.duration);
  if (r.running) return "running";
  return durationText({ kind: "ended", ms: Number.isFinite(r.durationMs) && r.durationMs >= 0 ? r.durationMs : null });
};
