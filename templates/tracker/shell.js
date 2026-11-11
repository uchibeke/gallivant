// Shared navigation, disclosure and list controls. Served in tracker.js.
(() => {
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
  const closed = () => {
    const value = LS.get(key, {});
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  };
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
      g.querySelector(".group-toggle")?.setAttribute("aria-expanded", String(!shut[g.dataset.group]));
      const tally = g.querySelector(".group-toggle small");
      if (tally) tally.textContent = term ? hits + "/" + rows.length : String(rows.length);
      shown += hits;
    }
    if (count) count.textContent = term ? shown + (shown === 1 ? " match" : " matches") : "";
  };

  for (const g of groups) {
    const head = g.querySelector(".group-toggle");
    if (!head) continue;
    const toggle = () => {
      // A toggle while a filter is active would be invisible (the filter overrides collapse), so it only records
      // the intent for when the filter is cleared.
      const c = closed();
      if (c[g.dataset.group]) delete c[g.dataset.group]; else c[g.dataset.group] = true;
      LS.set(key, c);
      render();
    };
    head.addEventListener("click", toggle);
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


// A native disclosure keeps tab order ordinary. Escape and outside clicks dismiss;
// only Escape returns focus, so pointer navigation never steals focus.
for (const menu of document.querySelectorAll?.(".menu") || []) {
  menu.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !menu.open) return;
    event.preventDefault(); menu.open = false; menu.querySelector("summary").focus();
  });
  document.addEventListener("click", event => { if (!menu.contains(event.target)) menu.open = false; });
}
const theme = document.getElementById("theme");
if (theme) theme.addEventListener("change", () => {
  const url = new URL(location.href);
  if (theme.value) url.searchParams.set("theme", theme.value); else url.searchParams.delete("theme");
  // Appearance is a presentation update: retain drafts, focus and scroll.
  if (theme.value) document.documentElement.dataset.theme = theme.value;
  else delete document.documentElement.dataset.theme;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  const form = document.querySelector?.(".overview-filters, .chain-filters");
  if (form) {
    let input = form.querySelector('[name="theme"]');
    if (!input) { input = document.createElement("input"); input.type = "hidden"; input.name = "theme"; form.append(input); }
    input.value = theme.value;
  }
  const base = document.body.dataset.base || "";
  for (const link of document.querySelectorAll("a[href]")) {
    if (link.getAttribute("href").startsWith("#")) continue;
    const target = new URL(link.href);
    if (target.origin !== url.origin || ![base + "/", base + "/run", base + "/runs", base + "/chains", base + "/task/new"].includes(target.pathname)) continue;
    if (theme.value) target.searchParams.set("theme", theme.value); else target.searchParams.delete("theme");
    link.href = target.pathname + target.search + target.hash;
  }
});

})();
