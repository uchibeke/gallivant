// Shared navigation, disclosure and list controls. Served in tracker.js.
(() => {
// localStorage can throw, not only return null: a private window, a browser set to block site data, or a frame whose
// storage the embedder partitioned away. Every read and write is guarded and the page works with no stored value.
const LS = {
  get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* the page works without it */ } },
};

function carryNavigation(key, value) {
  const url = new URL(location.href);
  const base = document.body.dataset.base || "";
  for (const link of document.querySelectorAll("a[href]")) {
    if (link.getAttribute("href").startsWith("#")) continue;
    const target = new URL(link.href);
    if (target.origin !== url.origin || ![base + "/", base + "/run", base + "/runs", base + "/chains", base + "/task/new", base + "/health"].includes(target.pathname)) continue;
    if (value) target.searchParams.set(key, value); else target.searchParams.delete(key);
    link.href = target.pathname + target.search + target.hash;
  }
}

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
  if (q) q.value = new URL(location.href).searchParams.get("listq") || "";

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
  const remember = () => {
    const url = new URL(location.href);
    if (q.value) url.searchParams.set("listq", q.value); else url.searchParams.delete("listq");
    history.replaceState(null, "", url.pathname + url.search + url.hash); carryNavigation("listq", q.value); render();
  };
  q?.addEventListener("input", remember);
  globalThis.addEventListener?.("popstate", () => { if (q) q.value = new URL(location.href).searchParams.get("listq") || ""; render(); });
  // Escape clears the filter, which is what every filter box does and costs one line.
  q?.addEventListener("keydown", e => { if (e.key === "Escape") { q.value = ""; remember(); } });
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
  document.addEventListener?.("click", event => { if (!menu.contains(event.target)) menu.open = false; });
}
const theme = document.getElementById("theme");
if (theme) theme.addEventListener("change", () => {
  const url = new URL(location.href);
  if (theme.value) url.searchParams.set("theme", theme.value); else url.searchParams.delete("theme");
  // Appearance is a presentation update: retain drafts, focus and scroll.
  if (theme.value) document.documentElement.dataset.theme = theme.value;
  else delete document.documentElement.dataset.theme;
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  for (const form of document.querySelectorAll?.(".overview-filters, .chain-filters, .command-search") || []) {
    let input = form.querySelector('[name="theme"]');
    if (!input) { input = document.createElement("input"); input.type = "hidden"; input.name = "theme"; form.append(input); }
    input.value = theme.value;
  }
  carryNavigation("theme", theme.value);
});

const density = document.getElementById("density");
const densityKey = "gallivant.tracker.density:" + (document.body.dataset.base || "/");
if (density) {
  const saved = LS.get(densityKey, "comfortable");
  density.value = saved === "compact" ? "compact" : "comfortable";
  document.documentElement.dataset.density = density.value;
  density.addEventListener("change", () => { document.documentElement.dataset.density = density.value; LS.set(densityKey, density.value); });
}
const commands = document.getElementById("commands"), opener = document.getElementById("commands-open");
let returnFocus;
const openCommands = (invoker = document.activeElement) => {
  if (!commands || commands.open || document.querySelector("dialog[open]")) return;
  returnFocus = invoker; commands.showModal(); document.getElementById("command-search").focus();
};
const restoreCommandFocus = () => (returnFocus?.isConnected ? returnFocus : opener)?.focus({ preventScroll: true });
const closeCommands = () => { commands.close(); restoreCommandFocus(); };
opener?.addEventListener("click", () => openCommands(opener));
document.getElementById("commands-close")?.addEventListener("click", closeCommands);
commands?.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeCommands(); }
});
commands?.addEventListener("close", () => {
  // Native close events are queued. Do not steal focus if the reader has
  // already moved on after our synchronous Escape/button restoration.
  if (document.activeElement === document.body || commands.contains(document.activeElement)) restoreCommandFocus();
});
document.addEventListener?.("keydown", event => {
  if (event.defaultPrevented || event.isComposing || event.altKey || document.querySelector("dialog[open]")) return;
  const target = event.target;
  if (target.closest?.("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]")) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openCommands(); }
  else if (!event.ctrlKey && !event.metaKey && event.key === "/") {
    event.preventDefault();
    const search = document.querySelector("main input[type=search], #filter");
    if (search) search.focus(); else openCommands();
  }
});
// Delegate copy handling so refreshed onboarding keeps the same behaviour.
document.addEventListener?.("click", async event => {
  const button = event.target.closest?.("[data-copy-command]");
  if (!button) return;
  const status = button.closest(".onboarding").querySelector("[data-copy-status]");
  try { await navigator.clipboard.writeText(button.dataset.copyCommand); status.textContent = "Command copied. Review it in your terminal before running."; }
  catch { status.textContent = "Clipboard unavailable. Select and copy the command text above."; }
});
})();
