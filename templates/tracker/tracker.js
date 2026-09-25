// The tracker's one script, served as a file so the CSP is `script-src 'self'` with no nonce and no hash, and so
// nothing here needs an inline event handler.
//
// Two jobs: the sidebar (filter, collapse, persist) and the log pane (stream, auto-scroll). Both are wired from
// data attributes the server rendered, so this file knows no ids or paths of its own.
"use strict";

// Where this tracker is mounted: empty when it owns the origin, something like "/gallivant" when a host server
// delegates a prefix to it. The server publishes it on <body data-base> because this file is served from one route
// and cannot be told at build time where it lives.
const BASE = document.body.dataset.base || "";

// localStorage can throw, not only return null: a private window, a browser set to block site data, or a frame whose
// storage the embedder partitioned away. Every read and write is guarded and the page works with no stored value.
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* the page works without it */ } },
};

// ---- sidebar --------------------------------------------------------------------
// Groups collapse, a filter searches every row's text, and collapsed state survives a reload. The one detail that
// makes a filter feel right, taken from command-center's explorer: while a filter is active, collapsed state is
// ignored and every match shows expanded. Otherwise a match hidden inside a closed group reads as "no results".
const side = document.getElementById("side");
if (side) {
  const key = "gallivant.tracker.collapsed:" + (side.dataset.view || "default");
  const closed = () => LS.get(key, {});
  const groups = [...side.querySelectorAll(".group")];
  const q = document.getElementById("filter");
  const count = document.getElementById("matches");

  const render = () => {
    const term = (q?.value || "").trim().toLowerCase();
    const shut = term ? {} : closed();          // a filter ignores collapsed state, so every match is visible
    let shown = 0;
    for (const g of groups) {
      const rows = [...g.querySelectorAll("a.row")];
      let hits = 0;
      for (const row of rows) {
        // The row's own text is what is searched: its handle, its detail and its badge, whatever the server put
        // there. `hay` is filled in by the server so a filter matches fields the row does not display in full.
        const hay = ((row.dataset.hay || "") + " " + row.textContent).toLowerCase();
        const hit = !term || hay.includes(term);
        row.hidden = !hit;
        if (hit) hits++;
      }
      g.hidden = rows.length > 0 && hits === 0;
      g.classList.toggle("closed", !!shut[g.dataset.group]);
      const tally = g.querySelector("h3 small");
      if (tally) tally.textContent = term ? hits + "/" + rows.length : String(rows.length);
      shown += hits;
    }
    if (count) count.textContent = term ? shown + (shown === 1 ? " match" : " matches") : "";
  };

  for (const g of groups) {
    const head = g.querySelector("h3");
    if (!head) continue;
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    const toggle = () => {
      // A toggle while a filter is active would be invisible (the filter overrides collapse), so it only records
      // the intent for when the filter is cleared.
      const c = closed();
      if (c[g.dataset.group]) delete c[g.dataset.group]; else c[g.dataset.group] = true;
      LS.set(key, c);
      render();
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  }
  q?.addEventListener("input", render);
  // Escape clears the filter, which is what every filter box does and costs one line.
  q?.addEventListener("keydown", e => { if (e.key === "Escape") { q.value = ""; render(); } });
  render();
}

// ---- grouping switch ------------------------------------------------------------
// Two groupings, so this is a navigation, not a state machine: the server renders the grouping the URL asks for and
// the page reloads into it. Nothing to keep in sync, and a grouped view is a link somebody can bookmark or frame.
const by = document.getElementById("groupby");
if (by) by.addEventListener("change", () => {
  const u = new URL(location.href);
  u.searchParams.set("by", by.value);
  location.assign(u.pathname + "?" + u.searchParams.toString());     // same document, never the top-level window
});

// ---- log pane -------------------------------------------------------------------
const pane = document.getElementById("log"), state = document.getElementById("logstate");
// The most lines the pane keeps on screen. Beyond this the oldest are dropped; the complete log is on disk.
const MAX_LINES = 2000;
if (pane) {
  // Auto-scroll follows the reader: the pane jumps to the bottom only when it was already at the bottom, so
  // scrolling up to read something does not yank you back down on the next line.
  const atBottom = () => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  // Lines arrive in bursts: a reconnect delivers hundreds at once, and a busy harness writes faster than the screen
  // refreshes. Appending per line stalled the main thread badly enough that the browser dropped the stream and
  // retried, which replayed the burst, which stalled it again. Buffer and paint once per frame instead.
  let pending = [], painting = false, closed = false;
  const paint = () => {
    painting = false;
    if (closed || !pending.length) return;
    const stick = atBottom();
    const frag = document.createElement("div");
    frag.innerHTML = pending.map(renderLine).join("");
    pane.append(frag);
    pending = [];
    if (stick) pane.scrollTop = pane.scrollHeight;
    // A very long pane costs memory and scroll performance for lines nobody scrolls back to. The whole log is on
    // disk, so dropping the oldest rows here loses nothing.
    while (pane.childElementCount > MAX_LINES) pane.firstElementChild.remove();
  };
  const push = line => { pending.push(line); if (!painting) { painting = true; requestAnimationFrame(paint); } };
  const note = (text, cls) => { const el = document.createElement("div"); el.className = "ll " + cls; el.textContent = text; pane.append(el); };
  // A run from another tool has no registry entry and is addressed by its source label instead; one of Gallivant's
  // own is addressed by entry. The server validates whichever arrives.
  const q = new URLSearchParams({ run: pane.dataset.run });
  if (pane.dataset.source) q.set("source", pane.dataset.source); else q.set("id", pane.dataset.entry);
  const url = BASE + "/api/run/output?" + q.toString();
  const es = new EventSource(url);
  const say = text => { if (state) state.textContent = text; };
  es.addEventListener("skipped", e => note(e.data + " earlier lines not shown; the whole log is in the run folder", "skip"));
  es.onmessage = e => {
    const text = JSON.parse(e.data);
    // A terminal frame is the one thing the stream sends that is not a log line, and it is where the pane stops
    // reconnecting. Every one of them is bracketed and nothing else the server sends is.
    if (/^\[(exit|no run|ended)\b/.test(text)) {
      paint();
      closed = true;
      es.close();
      note(text.slice(1, -1), "d " + (text === "[exit 0]" ? "ok" : "bad"));
      say(text === "[no run]" ? "no run on disk" : text === "[exit 0]" ? "finished" : text.slice(1, -1));
      return;
    }
    push(text);
  };
  es.onopen = () => say("live");
  // readyState 2 is closed, which is the normal end of a finished run and not a failure to report.
  es.onerror = () => { if (es.readyState !== 2) say("reconnecting"); };
}

// ---- log lines ------------------------------------------------------------------
// Ported from command-center's public/logline.js, unchanged apart from the escaper, which is inlined here because
// Gallivant has no md.js. A Gallivant run log is harness output, which is the exact shape that file was written
// for: an indented "Tool: argument" line, or prose, with URLs and file paths inside either. Keeping the parse
// identical is the point. Two copies that drift are how the five log panels it replaced went wrong in the first
// place, so a fix to the regexes belongs in both.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));


// Tool calls arrive indented by the harness reducer in lib/harness.mjs: "  WebSearch: quiet hotels in Lisbon".
const TOOL = /^ {2}([A-Za-z_][\w.]*):\s?(.*)$/;
// A terminal line the runner appends: "done in 42s (harness exit 0)" or "failed after 271s: ...".
const DONE = /^(done in |wrote |failed after )/;
// The runner's own opening line, written by lib/harness_run.mjs before the harness says anything.
const HEAD = /^harness \S+.*prompt \d+ chars/;
// Bare URLs. Stops before trailing punctuation so a sentence-final period is not swallowed into the link.
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
// A project-relative path with an extension: ideas/2026-09-25-trip.md, gtm/posts/one.md.
const PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.[a-z]{1,5}\b/g;

/** Which tools are worth colouring apart. Everything else is a neutral tool call. */
const TOOL_KIND = {
  WebSearch: "search", WebFetch: "fetch", Read: "read", Write: "write", Edit: "write",
  Bash: "shell", Agent: "agent", Task: "agent", ToolSearch: "meta", ListAgents: "meta",
  SendMessage: "meta", Monitor: "meta", Glob: "read", Grep: "read",
};

/**
 * Classify one line.
 *   { kind: "tool", tool, arg }   an indented tool call
 *   { kind: "done", text, ok }    the run's own closing line
 *   { kind: "text", text }        anything else the model said
 */
function parseLine(line) {
  const raw = String(line);
  const m = TOOL.exec(raw);
  if (m) return { kind: "tool", tool: m[1], arg: m[2].trim(), tone: TOOL_KIND[m[1]] || "" };
  const t = raw.trim();
  if (HEAD.test(t)) return { kind: "head", text: t };
  if (DONE.test(t)) return { kind: "done", text: t, ok: !t.startsWith("failed") };
  return { kind: "text", text: t };
}

/** Escape text, then turn URLs and file paths inside it into links. Escaping first is what keeps this safe: every
 *  replacement operates on already-escaped text and inserts only markup this function wrote. */
function linkify(text, { fileHref } = {}) {
  let html = esc(text);
  html = html.replace(URL_RE, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${short(u)}</a>`);
  if (fileHref) {
    html = html.replace(PATH_RE, p => {
      const href = fileHref(p);
      return href ? `<a href="${href}" class="fl">${p}</a>` : p;
    });
  }
  return html;
}

/** A URL short enough to read in a narrow panel: host plus the last meaningful segment. */
function short(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    const tail = parts.length ? "/" + parts[parts.length - 1] : "";
    const host = u.hostname.replace(/^www\./, "");
    const s = host + (tail.length > 28 ? tail.slice(0, 27) + "…" : tail);
    return esc(s.length > 48 ? s.slice(0, 47) + "…" : s);
  } catch { return esc(url.length > 48 ? url.slice(0, 47) + "…" : url); }
}

/** One line as HTML. Paths are left as text here: the tracker has no file browser to open them in. */
function renderLine(line, opts = {}) {
  const p = parseLine(line);
  if (p.kind === "tool") {
    const arg = p.arg ? `<span class="a">${linkify(p.arg, opts)}</span>` : "";
    return `<div class="ll t${p.tone ? " " + p.tone : ""}"><span class="n">${esc(p.tool)}</span>${arg}</div>`;
  }
  if (p.kind === "head") return `<div class="ll h">${linkify(p.text, opts)}</div>`;
  if (p.kind === "done") return `<div class="ll d ${p.ok ? "ok" : "bad"}">${linkify(p.text, opts)}</div>`;
  return `<div class="ll">${linkify(p.text, opts)}</div>`;
}
