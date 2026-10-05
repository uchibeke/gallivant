// The pages: plain semantic HTML, with the stylesheet and the script served as their own files.
//
// Everything interpolated goes through `esc`. PR titles, branch names, reasons, run names and log lines come from
// GitHub or from an agent, and an agent that prints `<script>` into its log must not be able to run it in the
// reader's browser. There is one escape function and every template uses it.
import { ago } from "../time.mjs";
import { contract } from "../fs.mjs";
import { controlPending, CONTROL_LABELS, MAX_NOTE, lastMessage } from "../control.mjs";

/** The five characters that matter in HTML text and in a double-quoted attribute. Nothing else is interpolated. */
export const esc = s => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

/**
 * The stylesheet and the script are served from their own routes rather than inlined, so `script-src 'self'` needs
 * neither 'unsafe-inline' nor a per-response nonce. A nonce would mean the HTML could never be cached and every page
 * would have to thread the value through; a hash would have to be recomputed whenever the file changes and would
 * drift silently. Two files on two routes is the version that cannot rot.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  // Framing is the point: this is meant to sit in a dashboard. It is bound to 127.0.0.1, so the only page that can
  // frame it is one already running on this machine.
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
].join("; ");

/**
 * One page shell. `theme` is dark, light or null; null leaves the choice to `prefers-color-scheme`.
 *
 * `base` is the path this tracker is mounted at, empty when it owns the origin and something like `/gallivant` when
 * a host server delegates a prefix to it. It is published on <body data-base> so the script can build its own URLs
 * from it: the script is one static file served from one route, so it cannot be told at build time where it lives.
 */
export function page({ title, body, theme = null, base = "" }) {
  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${esc(base)}/tracker.css"></head>
<body data-base="${esc(base)}">${body}<script src="${esc(base)}/tracker.js" defer></script></body></html>
`;
}

/**
 * Every internal URL goes through here: the mount path, then the page, then the query the reader is carrying.
 *
 * Emitting absolute paths (`/run?id=`) would work only when the tracker owns the origin, and would 404 the moment a
 * host server mounted it under a prefix. One builder means a mount point is a parameter rather than a rewrite.
 */
const at = (base, path, params = {}, extra = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return `${base}${path}${s ? `?${s}` : ""}`;
};

/**
 * `home` is a link back out to whatever is hosting the tracker, so a mounted tracker is not a one-way trip. The host
 * passes its own label and URL; standalone there is nowhere to go back to and the link is simply absent.
 */
const header = (base, heading, here, ctxq, home) => `<header class="top"><h1>${esc(heading)}</h1>
<nav class="views">${home ? `<a class="home" href="${esc(home.url)}">${esc(home.label)}</a>` : ""}
<a href="${esc(at(base, "/", ctxq))}"${here === "dash" ? ' aria-current="page"' : ""}>entries</a>
<a href="${esc(at(base, "/runs", ctxq))}"${here === "runs" ? ' aria-current="page"' : ""}>runs</a></nav></header>`;

/** The filter box, the grouping switch and the match count. One row, the same on both views. */
const controls = (by, groupings) => `<div class="controls">
<input type="search" id="filter" placeholder="filter" aria-label="filter the list" autocomplete="off" spellcheck="false">
${groupings.length > 1 ? `<label for="groupby">group by</label><select id="groupby" aria-label="group by">
${groupings.map(g => `<option value="${esc(g)}"${g === by ? " selected" : ""}>${esc(g)}</option>`).join("")}</select>` : ""}
</div><p class="hint" id="matches" aria-live="polite"></p>`;

/**
 * The sidebar: one collapsible group per key, each holding rows. `view` names the localStorage bucket the collapsed
 * state lives in, so the two views remember their own groups. `hay` is the text a filter matches beyond what the row
 * shows, so searching for a branch or a reason finds a row that displays neither in full.
 */
const sidebar = (view, groups, controlsHtml) => `<aside id="side" data-view="${esc(view)}">
${controlsHtml}
${groups.map(g => `<div class="group" data-group="${esc(g.key)}">
<h3><i class="caret"></i><span class="n">${esc(g.label)}</span><small>${g.rows.length}</small></h3>
<div class="rows">${g.rows.map(r => `<a class="row" href="${esc(r.href)}"${r.current ? ' aria-current="page"' : ""} data-hay="${esc(r.hay || "")}" title="${esc(r.title || r.label)}">
<i class="dot ${esc(r.tone || "")}"></i><span class="n">${esc(r.label)}</span><small>${esc(r.badge || "")}</small></a>`).join("")}</div>
</div>`).join("\n")}
${groups.length ? "" : `<p class="empty">Nothing registered yet. <code>gallivant start</code> puts a PRD in the loop.</p>`}
</aside>`;

/** needs-you first, then running, then done: the order `gallivant status` prints, so the two agree on sight. */
const SECTIONS = [["needs_you", "needs you"], ["running", "running"], ["done", "done"]];
const TONE = { needs_you: "needs", running: "running", done: "" };

/** How a state group's rows are built. `by=harness` regroups the same rows; nothing else about them changes. */
function entryGroups(base, m, by, current, ctxq) {
  const rows = SECTIONS.flatMap(([key]) => (m[key] || []).map(r => ({
    section: key,
    href: at(base, "/run", ctxq, { id: r.id }),
    label: r.handle,
    badge: r.label,
    tone: r.section === "running" && r.run?.running ? "running" : TONE[key],
    title: `${r.handle} ${r.label}${r.detail ? ` ${r.detail}` : ""}`,
    // What a filter searches beyond the visible text: the id, the reason, the harness and the round.
    hay: [r.id, r.detail, r.reason, r.harness, r.round].filter(Boolean).join(" "),
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

/** The dashboard: the sidebar plus the same groups as a table, so a wide frame shows detail and a narrow one a list. */
export function dashboard(m, { clock = Date, by = "state", theme = null, query = {}, base = "", home = null } = {}) {
  const ctxq = { theme: query.theme, by: by === "state" ? "" : by };
  const groups = entryGroups(base, m, by, null, ctxq);
  const table = (title, rows) => `<h2>${esc(title)}</h2>` + (rows.length ? `<table>
<thead><tr><th>entry</th><th>state</th><th>detail</th><th>round</th><th>since</th><th></th></tr></thead><tbody>
${rows.map(r => `<tr><td><a href="${esc(at(base, "/run", ctxq, { id: r.id }))}">${esc(r.handle)}</a></td>
<td><span class="tag${r.section === "needs_you" ? " bad" : r.run?.running ? " live" : ""}">${esc(r.label)}</span></td><td>${esc(r.detail)}</td><td class="dim">${esc(r.round)}</td>
<td class="dim">${esc(ago(r.since, clock))}</td><td>${r.url ? `<a href="${esc(r.url)}">PR</a>` : ""}</td></tr>`).join("\n")}
</tbody></table>` : `<p class="empty">(none)</p>`);
  const d = m.daemon;
  // A dead daemon is the first thing a reader needs, and "run gallivant up" on its own does not say how long it has
  // been dead. daemon.json survives the process, so when it was last seen is on disk and worth showing.
  const probes = Object.entries(d?.probes || {}).map(([k, p]) => `, ${k} ${p.ok ? "ok" : "FAIL"}`).join("");
  const state = d?.alive
    ? `daemon up since ${ago(d.startedAt, clock)}, last tick ${ago(d.lastTick, clock)}${probes}`
    : d
      ? `daemon DOWN, last tick ${ago(d.lastTick, clock)}. Run: gallivant up`
      : "daemon has never run here. Run: gallivant up";
  return page({ title: "gallivant", theme, base, body: `${header(base, "gallivant", "dash", ctxq, home)}
<div class="layout">${sidebar("entries", groups, controls(by, GROUPINGS))}
<section class="main">
<p class="${d?.alive ? "dim" : "warn"}">${esc(state)}</p>
${m.latestError ? `<p class="warn mono">${esc(m.latestError)}</p>` : ""}
${SECTIONS.map(([key, label]) => table(label, m[key] || [])).join("")}
</section></div>` });
}

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
const logPane = attrs => `<p class="loadmore"><button type="button" id="earlier" disabled hidden>load earlier lines</button>
<span class="hint" id="earlierstate"></span></p>
<div id="log" ${attrs} aria-live="polite" aria-label="run log" tabindex="0"></div>
<p class="note" id="logstate">connecting</p>`;

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

/** One entry: its facts, then the live log of the run it last dispatched, with the sidebar alongside. */
export function runPage({ id, entry, handle, run, maxIterations, model, divergence = null, controlToken = null, by = "state", theme = null, query = {}, base = "", home = null }) {
  const canMessage = !!entry.session || !!(run?.running && run.id === entry.last?.run);
  const savedMessage = lastMessage(entry);
  const ctxq = { theme: query.theme, by: by === "state" ? "" : by };
  const fact = (k, v) => (v ? `<dt>${esc(k)}</dt><dd>${v}</dd>` : "");
  const facts = [
    fact("state", `<span class="tag${entry.state === "needs-human" ? " bad" : run?.running ? " live" : ""}">${esc(entry.state)}</span>${entry.reason ? ` <span class="dim">${esc(entry.reason)}</span>` : ""}`),
    fact("harness", esc(entry.harness)),
    fact("round", esc(`round ${entry.iteration}/${maxIterations}`)),
    fact("PR", entry.url ? `<a href="${esc(entry.url)}">${esc(entry.url)}</a>` : entry.pr ? esc(`#${entry.pr}`) : ""),
    fact("branch", `<code>${esc(entry.branch)}</code>`),
    fact("worktree", `<code>${esc(contract(entry.worktree))}</code>`),
    fact("session", `<code>${esc(entry.session)}</code>`),
    fact("provider state", esc(entry.execution?.providerState)),
    fact("observed / reconciled", entry.execution ? esc(`${entry.execution.observedAt ?? "unknown"} / ${entry.execution.reconciledAt ?? "never"}`) : ""),
    fact("recovery action", esc(entry.execution?.recoveryAction)),
    fact("run", run ? `<code>${esc(run.id)}</code> ${run.running ? `<span class="live">running</span>` : `exit ${esc(String(run.exit ?? "not recorded yet"))}`}` : ""),
    fact("runs", `<a href="${esc(at(base, "/runs", ctxq, { entry: id }))}">every run for this entry</a>`),
    fact("result evidence", run ? `<a href="${esc(at(base, "/api/run/result", {}, { id, run: run.id }))}">saved result and verification</a>` : ""),
  ].join("");
  // The log pane is driven by tracker.js, which reads these attributes. Passing the ids through the DOM rather than
  // through the script keeps the script one static file the CSP can allow by origin. `data-harness` is among them
  // because a log line's shape is the harness's, so the script needs the name to pick the right stream reader; the
  // registry is what knows it, and an entry with none renders every line as itself.
  return page({
    title: `${handle} - gallivant`,
    theme,
    base,
    body: `${header(base, handle, "run", ctxq, home)}
<div class="layout">${sidebar("entries", entryGroups(base, model, by, id, ctxq), controls(by, GROUPINGS))}
<section class="main">
${divergence ? briefMoved(divergence) : ""}
<dl class="facts">${facts}</dl>
${controlToken && entry.state !== "done" ? `<section id="run-controls" class="run-controls" aria-labelledby="control-heading" data-entry="${esc(id)}" data-token="${esc(controlToken)}" data-pending="${controlPending(entry.control)}">
<h2 id="control-heading">Run actions</h2>
<div class="run-actions">
<div><button type="button" data-action="recheck" data-available="${!!entry.pr}" aria-describedby="recheck-help"${!entry.pr || controlPending(entry.control) ? " disabled" : ""}>Recheck PR</button>
<p id="recheck-help" class="note">${entry.pr ? "Read the latest checks and review. Keeps the round budget; does not rerun CI." : "Available once this task has a PR."}</p></div>
<div><button type="button" data-action="resume" data-available="${!!entry.session}" aria-describedby="resume-help"${!entry.session || controlPending(entry.control) ? " disabled" : ""}>Resume agent</button>
<p id="resume-help" class="note">${entry.session ? "Continue the same session on its current instructions." : "Available once this task has an agent session."}</p></div>
<div><button type="button" data-action="cancel" data-available="true" aria-describedby="cancel-help"${controlPending(entry.control) ? " disabled" : ""}>Cancel task</button>
<p id="cancel-help" class="note">Stops further dispatch and requests cancellation. Remote execution may continue until the provider confirms.</p></div>
</div>
<form id="message-form" class="message-composer">
<label for="run-note">Message agent</label>
<textarea id="run-note" rows="3" maxlength="${MAX_NOTE}" required aria-describedby="message-help" placeholder="Share an update or give the agent direction…"${!canMessage ? " disabled" : ""}></textarea>
${run?.running && entry.execution?.controls?.interrupt !== false ? `<label class="interrupt-option"><input id="interrupt-run" type="checkbox" aria-describedby="interrupt-help"><span>Interrupt the active run to apply this message</span></label><p id="interrupt-help" class="note">At the next daemon check, stops the current process, preserves files and resumes the same session. In-progress edits may need repair.</p>` : ""}
<div class="message-footer"><p id="message-help" class="note">${canMessage ? `Continues the same session with your correction, even after it finished.${run?.running ? " Leave the option unchecked to queue until this run ends." : ""}` : "Available once this task starts an agent run."}</p>
<button type="submit" data-action="message" data-available="${canMessage}" disabled>Send message</button></div>
</form>
<p class="note control-help">Resume and messages use your agent plan and keep the approved brief and guardrails. Requests need the daemon running.</p>
<p id="control-status" role="status" aria-live="polite">${esc(entry.control ? `${CONTROL_LABELS[entry.control.action] || "Request"} — ${entry.control.status}: ${entry.control.message || "Waiting for the daemon and any active run."}` : "")}</p>
<a id="control-refresh" href="${esc(at(base, "/run", ctxq, { id }))}" hidden>View updated run</a>
<details id="last-message"${savedMessage ? "" : " hidden"}><summary>Last submitted message</summary><pre>${esc(savedMessage?.note || "")}</pre><button id="restore-message" type="button">Edit and resend</button></details>
</section>` : entry.state === "done" ? `<p class="note">This PR is closed or merged. Start a follow-up PRD for further changes.</p>` : ""}
<h2>Log</h2>
${run ? logPane(`data-entry="${esc(id)}" data-run="${esc(run.id)}" data-harness="${esc(entry.harness || "")}"`) : `<p class="empty">No run has been dispatched for this entry yet.</p>`}
</section></div>` });
}

/** The runs tab: every run folder on disk, newest first, grouped in the sidebar and listed in full beside it. */
export function runsPage(rows, { entry = "", by = "state", theme = null, query = {}, base = "", home = null, open = null } = {}) {
  const ctxq = { theme: query.theme, by: by === "state" ? "" : by, entry };
  const groups = runGroups(base, rows, by, entry, ctxq, open);
  const body = rows.length ? `<table>
<thead><tr><th>started</th><th>entry</th><th>run</th><th>state</th><th class="num">duration</th><th></th></tr></thead><tbody>
${rows.map(r => `<tr><td class="dim">${esc(when(r.startedAt))}</td>
${/* A run from another tool has no registry entry, so there is nothing to link to: it is listed, not opened. */ ""}
<td>${r.entry ? `<a href="${esc(at(base, "/run", ctxq, { id: r.entry }))}">${esc(r.handle)}</a>` : `${esc(r.handle)} <span class="tag">${esc(r.source || "")}</span>`}</td>
<td class="mono">${esc(r.run)}</td>
<td>${r.running ? `<span class="tag live">running</span>` : r.exit === 0 ? `<span class="tag">exit 0</span>` : `<span class="tag bad">exit ${esc(String(r.exit ?? "not recorded"))}</span>`}</td>
<td class="num dim">${esc(duration(r))}</td>
<td><a href="${esc(at(base, "/runs", ctxq, { open: r.run, source: r.entry ? "" : r.source }))}">log</a></td></tr>`).join("\n")}
</tbody></table>` : `<p class="empty">${entry ? "No runs for that entry." : "No runs on disk yet."}</p>`;
  return page({ title: "runs - gallivant", theme, base, body: `${header(base, "runs", "runs", ctxq, home)}
<div class="layout">${sidebar("runs", groups, controls(by, GROUPINGS))}
<section class="main">
${entry ? `<p class="dim">Filtered to <code>${esc(entry)}</code>. <a href="${esc(at(base, "/runs", ctxq, { entry: "" }))}">every entry</a></p>` : ""}
${open ? detail(base, open, ctxq) : ""}
<h2>${esc(open ? "every run" : "runs")}</h2>
${body}<p class="note">${esc(`${rows.length} run${rows.length === 1 ? "" : "s"}, newest first.`)}</p>
</section></div>` });
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
  : `<span class="tag">${esc(r.source || "")}</span>`}</dd>
<dt>started</dt><dd>${esc(when(r.startedAt))}</dd>
<dt>state</dt><dd>${r.running ? `<span class="tag live">running</span>` : r.exit === 0 ? `<span class="tag">exit 0</span>` : `<span class="tag bad">exit ${esc(String(r.exit ?? "not recorded"))}</span>`}${r.durationMs == null ? "" : ` <span class="dim">${esc(duration(r))}</span>`}</dd>
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
  return [["running", "running"], ["failed", "failed"], ["done", "done"]]
    .map(([key, label]) => ({ key: `runs:${key}`, label, rows: rows.filter(r => bucket(r) === key).map(row) }))
    .filter(g => g.rows.length);
}

const when = ms => (ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "unknown");

const duration = r => {
  if (r.running) return "running";
  if (r.durationMs == null) return "";
  const s = Math.round(r.durationMs / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
