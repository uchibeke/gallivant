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
const pane = document.getElementById("log"), note = document.getElementById("logstate");
if (pane) {
  // Auto-scroll follows the reader: the pane jumps to the bottom only when it was already at the bottom, so
  // scrolling up to read something does not yank you back down on the next line.
  const atBottom = () => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  const add = (text, cls) => {
    const stick = atBottom();
    const line = document.createElement("div");
    if (cls) line.className = cls;
    line.textContent = text;        // assigned as text, never parsed as markup: a log line can contain anything
    pane.appendChild(line);
    if (stick) pane.scrollTop = pane.scrollHeight;
  };
  const url = BASE + "/api/run/output?id=" + encodeURIComponent(pane.dataset.entry) + "&run=" + encodeURIComponent(pane.dataset.run);
  const es = new EventSource(url);
  es.addEventListener("skipped", e => add("[" + e.data + " earlier lines not shown; the whole log is in the run folder]", "meta"));
  es.onmessage = e => {
    const text = JSON.parse(e.data);
    // A terminal frame is the one thing the stream sends that is not a log line, and it is where the pane stops
    // reconnecting. Every one of them is bracketed and nothing else the server sends is.
    const done = /^\[(exit|no run|ended)\b/.test(text);
    add(text, done ? "meta" : null);
    if (done) { es.close(); if (note) note.textContent = text === "[no run]" ? "no run on disk" : "run finished"; }
  };
  es.onopen = () => { if (note) note.textContent = "live"; };
  // readyState 2 is closed, which is the normal end of a finished run and not a failure to report.
  es.onerror = () => { if (note && es.readyState !== 2) note.textContent = "reconnecting"; };
}
