// The pages: plain semantic HTML, with the stylesheet and the script served as their own files.
//
// Everything interpolated goes through `esc`. PR titles, branch names, reasons, run names and log lines come from
// GitHub or from an agent, and an agent that prints `<script>` into its log must not be able to run it in the
// reader's browser. There is one escape function and every template uses it.
import { ago } from "../time.mjs";
import { redact } from "../execution_io.mjs";
import { workspaceProjection, workspaceSummary, workspaceEvidence, workspaceReview, workspaceExecution } from "./workspace.mjs";
import { controlPending, CONTROL_LABELS, MAX_NOTE, lastMessage } from "../control.mjs";
import { taskPresentation } from "./presentation.mjs";
import { durationText, instant } from "./presentation_time.mjs";
import { taskWindow } from "./presentation_html.mjs";
import { controlAvailability } from "../control_contract.mjs";
import { needsAgentResume } from "../network_recovery.mjs";

import { esc, badge, button, textarea, emptyState, loadingState } from "./primitives.mjs";
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
${loadingState("connecting", { id: "logstate" })}`;

/**
 * The brief moved under this entry: above the facts, because it is the one thing on the page that says the work may be
 * aimed at the wrong target, and a reader who scrolls past it has been told nothing useful by the rest. Every difference
 * is listed rather than just the first, which is the whole reason this page has room the `status` row does not.
 *
 * Every field goes through `esc` like everything else here: the criteria text and the file path come from a markdown
 * file the operator wrote, which is not hostile but is not this module's to trust either.
 */
const briefMoved = d => `<div class="warn">
<p><strong>${esc(d.reason)}</strong>: ${esc(d.why)}</p>
<ul>${d.diff.map(l => `<li>${esc(l)}</li>`).join("")}</ul>
${d.verdict === "changed" ? `<p>The completion gate is judging neither brief. Resolve it: <code>gallivant resume ${esc(d.handle || "")} --resnapshot</code> makes the edited brief the one that counts, or put the brief back the way it was.</p>` : ""}
${d.verdict === "illegal" ? `<p><code>${esc(d.path)}</code> would be refused by <code>gallivant start</code> as it stands. Fix it, then <code>gallivant ready</code> it again.</p>` : ""}
${d.verdict === "gone" ? `<p>Restore the file, or <code>gallivant remove</code> the entry if the work is no longer wanted.</p>` : ""}
</div>`;

/** Canonical task summary and evidence, with selected-attempt output in a disclosure. */
export function runPage({ id, entry, handle, run, pinned = false, workspace = null, attempts = [], initialLaunch = false, maxIterations, model, divergence = null, controlToken = null, by = "state", theme = null, query = {}, base = "", home = null, clock = Date }) {
  const row = [...model.needs_you, ...model.running, ...model.done].find(r => r.id === id);
  const p = row?.presentation || taskPresentation({ entry, run, maxIterations, divergence, now: clock.now() });
  const availability = initialLaunch ? controlAvailability(entry, run, {}, { resumable: true }) : p.controls;
  const canResume = availability.resume;
  const canRecheck = availability.recheck;
  const canMessage = availability.message;
  const savedMessage = lastMessage(entry);
  const ctxq = { ...query, theme: query.theme, by: by === "state" ? "" : by };
  const w = workspace || workspaceProjection({ id, entry, run, presentation: p, now: clock.now() });
  const selectedQuery = { ...ctxq, run: run?.id || "" };
  // The log pane is driven by tracker.js, which reads these attributes. Passing the ids through the DOM rather than
  // through the script keeps the script one static file the CSP can allow by origin. `data-harness` is among them
  // because a log line's shape is the harness's, so the script needs the name to pick the right stream reader; the
  // registry is what knows it, and an entry with none renders every line as itself.
  return page({
    title: `${handle} - gallivant`,
    theme,
    base,
    body: `${header(base, handle, "run", ctxq, home)}
<div class="workspace-layout">
<main class="main workspace" id="main" tabindex="-1" data-entry="${esc(id)}" data-run="${esc(run?.id || "")}">
${divergence ? briefMoved(divergence) : ""}
<div id="workspace-summary">${workspaceSummary(w, { base, query: selectedQuery, clock })}</div>
<nav class="workspace-nav" aria-label="Workspace sections"><a href="#workspace-evidence">Overview &amp; evidence</a><a href="#workspace-attempts">Attempts</a>${controlToken && entry.state !== "done" ? '<a href="#run-controls">Actions</a>' : ""}<a href="#workspace-activity">Activity</a></nav>
<div class="workspace-freshness"><p id="workspace-state" role="status">Saved task snapshot · ${esc(p.freshness.snapshotAt || "unknown")}</p>${button("Refresh evidence", { id: "workspace-retry" })}<a id="workspace-new-attempt" href="${esc(at(base, "/run", ctxq, { id }))}" hidden>Open new attempt</a></div>
<section id="workspace-evidence" aria-labelledby="evidence-heading"><h2 id="evidence-heading">Delivery evidence</h2><div id="workspace-evidence-content">${workspaceEvidence(w)}</div></section>
<section aria-labelledby="review-activity-heading" id="review-activity" data-entry="${esc(id)}">
<h2 id="review-activity-heading">Reviewer activity</h2><div id="workspace-review-content">${workspaceReview(w)}</div>
<div id="review-activity-log" role="log" aria-live="polite" aria-relevant="additions text"></div>
<p class="note" id="review-activity-state">Review progress is refreshed with the task evidence.</p></section>
<section id="workspace-attempts" aria-labelledby="attempts-heading"><h2 id="attempts-heading">Attempts</h2>
<p class="note">Output, duration and execution metadata belong to the selected attempt. Task actions apply to the current logical task.</p>
<details><summary>Choose an attempt · ${attempts.length} recent attempts</summary><ol class="attempt-list">${attempts.map(r => `<li><a href="${esc(at(base, "/run", ctxq, { id, run: r.run }))}"${r.run === run?.id ? ' aria-current="true"' : ""}><code>${esc(r.run)}</code></a><span>${esc(duration(r))} · ${r.running ? "running" : `exit ${esc(r.exit ?? "unknown")}`}</span></li>`).join("")}</ol><a href="${esc(at(base, "/runs", ctxq, { entry: id }))}">every run for this entry</a></details>
<details id="execution-details"><summary>Selected attempt · execution &amp; artifacts</summary><div id="workspace-execution-content">${workspaceExecution(w)}</div>
${run ? `<div id="workspace-artifacts" data-url="${esc(at(base, "/api/run/result", {}, { id, run: run.id, view: "summary" }))}"><p id="artifact-state" role="status">Saved result not requested yet.</p><ul id="artifact-list"></ul>${button("Retry result", { id: "artifact-retry", hidden: true })}<a href="${esc(at(base, "/api/run/result", {}, { id, run: run.id }))}">Saved result and verification</a></div>` : ""}</details></section>
${controlToken && entry.state !== "done" ? `<section id="run-controls" data-pinned="${pinned ? "true" : "false"}" class="run-controls" aria-labelledby="control-heading" data-entry="${esc(id)}" data-token="${esc(controlToken)}" data-pending="${controlPending(entry.control)}">
<h2 id="control-heading">Run actions</h2>
<div class="run-actions">
<div>${button("Recheck PR", { "data-action": "recheck", "data-available": String(canRecheck), "aria-describedby": "recheck-help", disabled: !canRecheck || controlPending(entry.control) })}
<p id="recheck-help" class="note">${needsAgentResume(entry) ? "An agent failure needs Resume agent, not PR recheck. Any scheduled recovery is shown above." : entry.pr ? "Read the latest checks and review. Keeps the round budget; does not rerun CI." : "Available once this task has a PR."}</p></div>
<div>${button("Resume agent", { "data-action": "resume", "data-available": String(canResume), "aria-describedby": "resume-help", disabled: !canResume || controlPending(entry.control) })}
<p id="resume-help" class="note">${initialLaunch ? "Start the first run from the approved brief after repairing launch prerequisites." : entry.session ? "Continue the same session on its current instructions." : "Available once this task has an agent session."}</p></div>
<div>${button("Cancel task", { "data-action": "cancel", "data-available": String(availability.cancel), "aria-describedby": "cancel-help", disabled: !availability.cancel })}
<p id="cancel-help" class="note">Stops further dispatch and requests cancellation. Remote execution may continue until the provider confirms.</p></div>
</div>
<form id="message-form" class="message-composer">
<label for="run-note">Message agent</label>
${textarea("", { id: "run-note", rows: 3, maxlength: MAX_NOTE, required: true, "aria-describedby": "message-help", placeholder: "Share an update or give the agent direction…", disabled: !canMessage })}
${run?.running ? `<label class="interrupt-option"><input id="interrupt-run" type="checkbox" aria-describedby="interrupt-help"${availability.interrupt ? "" : " disabled"}><span>Interrupt the active run to apply this message</span></label><p id="interrupt-help" class="note">When available, stops the current process at the next daemon check, preserves files and resumes the same session. In-progress edits may need repair.</p>` : ""}
<div class="message-footer"><p id="message-help" class="note">${initialLaunch ? "Start the first run from the approved brief with your clarification after repairing launch prerequisites." : `Continues the same session with your correction when the action is available.${run?.running ? " Leave the option unchecked to queue until this run ends." : ""}`}</p>
${button("Send message", { type: "submit", "data-action": "message", "data-available": String(canMessage), disabled: true })}</div>
</form>
<p class="note control-help">Resume and messages use your agent plan and keep the approved brief and guardrails. Requests need the daemon running.</p>
<p id="control-status" role="status" aria-live="polite">${esc(entry.control ? `${CONTROL_LABELS[entry.control.action] || "Request"} — ${entry.control.status}: ${entry.control.message || "Waiting for the daemon and any active run."}` : "")}</p>
<a id="control-refresh" href="${esc(at(base, "/run", ctxq, { id }))}" hidden>View updated run</a>
<details id="last-message"${savedMessage ? "" : " hidden"}><summary>Last submitted message</summary><pre>${esc(redact(savedMessage?.note || ""))}</pre>${button("Edit and resend", { id: "restore-message" })}</details>
</section>` : entry.state === "done" ? `<p class="note">This PR is closed or merged. Start a follow-up PRD for further changes.</p>` : ""}
<details id="workspace-activity"><summary>Activity · Agent log</summary><p class="note">Author output for selected attempt <code>${esc(run?.id || "unknown")}</code>. Raw output is diagnostic, not delivery evidence.</p>
${run ? logPane(`data-entry="${esc(id)}" data-run="${esc(run.id)}" data-harness="${esc(entry.harness || "")}"`) : emptyState("No run has been dispatched for this entry yet.")}
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
