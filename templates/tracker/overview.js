// Server-composed snapshots: no state mapping, task mutation or per-row requests here.
(() => {
  const root = document.querySelector?.("[data-overview]");
  if (!root) return;
  const status = document.getElementById("overview-status");
  const refresh = document.getElementById("overview-refresh"), apply = document.getElementById("overview-apply");
  const filterSelects = [...root.querySelectorAll(".overview-filters select")];
  const deferredChoices = new Map();
  let busy = false, failures = 0, pending = null, cancelTimer = null;
  let observedAt = status.querySelector("time").dateTime;
  const announce = (message, state) => { status.textContent = message; status.dataset.state = state; };
  const held = () => {
    const selection = getSelection();
    return selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode)) ||
      document.getElementById("overview-results").contains(document.activeElement);
  };
  // Keyed nodes and native details survive. Never replace the list or an open disclosure.
  const key = node => node.nodeType === 1 ? node.getAttribute("data-key") : null;
  function patch(current, next) {
    if (current.nodeType === Node.TEXT_NODE) {
      if (current.data !== next.data) current.data = next.data;
      return;
    }
    if (current.nodeType !== Node.ELEMENT_NODE) return;
    for (const attr of [...current.attributes]) {
      if (current.tagName === "DETAILS" && attr.name === "open") continue;
      if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
    }
    for (const attr of next.attributes) {
      if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
    }
    const keyed = new Map([...current.childNodes].filter(key).map(node => [key(node), node]));
    let cursor = current.firstChild;
    for (const child of next.childNodes) {
      let existing = key(child) ? keyed.get(key(child)) : cursor && !key(cursor) && cursor.nodeType === child.nodeType && cursor.nodeName === child.nodeName ? cursor : null;
      if (!existing) { existing = child.cloneNode(true); current.insertBefore(existing, cursor); }
      else { if (existing !== cursor) current.insertBefore(existing, cursor); patch(existing, child); }
      cursor = existing.nextSibling;
    }
    while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
  }
  function reconcileChoices(current, next) {
    // Native pickers must not change under a keyboard or pointer interaction.
    if (current === document.activeElement) { deferredChoices.set(current, next); return; }
    deferredChoices.delete(current);
    const value = current.value, options = [...next.options].map(option => option.cloneNode(true));
    if (!options.some(option => option.value === value)) options.push(new Option(`${value} (no current tasks)`, value));
    for (const option of options) option.selected = option.defaultSelected = option.value === value;
    const same = options.length === current.options.length && options.every((option, i) => option.value === current.options[i].value && option.text === current.options[i].text);
    if (!same) current.replaceChildren(...options);
    current.value = value;
  }
  for (const select of filterSelects) select.addEventListener("blur", () => {
    const next = deferredChoices.get(select);
    if (next) reconcileChoices(select, next);
  });
  const prepare = data => {
    if (typeof data?.content !== "string" || typeof data.filters !== "string" || !Number.isFinite(Date.parse(data.observedAt))) throw new Error("Invalid overview snapshot");
    const parsed = new DOMParser().parseFromString(data.content, "text/html").getElementById("overview-results");
    const filters = new DOMParser().parseFromString(data.filters, "text/html");
    const choices = filterSelects.map(select => filters.getElementById(select.id));
    if (!parsed || choices.some(select => select?.tagName !== "SELECT" || !select.options.length)) throw new Error("Invalid overview snapshot");
    // Appearance can change during a read; navigation keeps the current choice.
    const theme = new URL(location.href).searchParams.get("theme");
    for (const link of parsed.querySelectorAll("a[href]")) {
      const url = new URL(link.getAttribute("href"), location.href);
      if (url.origin !== location.origin) continue;
      if (theme) url.searchParams.set("theme", theme); else url.searchParams.delete("theme");
      link.setAttribute("href", url.pathname + url.search + url.hash);
    }
    return { next: parsed, choices };
  };
  function render(data, force = false) {
    const { next, choices } = prepare(data), current = document.getElementById("overview-results");
    // Only options change: unsaved search, selected values, focus and disclosure stay local.
    choices.forEach((select, i) => reconcileChoices(filterSelects[i], select));
    const order = el => [...el.querySelectorAll("[data-task-id]")].map(row => row.closest("section").dataset.kind + ":" + row.dataset.taskId).join("|");
    const structureChanged = order(current) !== order(next);
    if (!force && (held() || structureChanged && (scrollY > current.offsetTop || current.querySelector("details[open]")))) {
      pending = data; apply.hidden = false;
      announce(`Updates ready · displayed snapshot ${observedAt}. Apply when ready.`, "pending");
      return;
    }
    const anchor = [...current.querySelectorAll("[data-task-id]")].find(row => row.getBoundingClientRect().bottom > 0);
    const top = anchor?.getBoundingClientRect().top;
    const expanded = new Set([...current.querySelectorAll("details[open][data-key]")].map(key));
    patch(current, next);
    for (const details of current.querySelectorAll("details[data-key]")) if (expanded.has(key(details))) details.open = true;
    if (anchor?.isConnected && scrollY > current.offsetTop) scrollBy(0, anchor.getBoundingClientRect().top - top);
    observedAt = data.observedAt; pending = null; apply.hidden = true;
    announce(`Current · snapshot observed ${observedAt}`, "success");
  }
  const schedule = delay => { cancelTimer?.(); cancelTimer = lifecycle.schedule(poll, delay); };
  async function poll() {
    if (busy) return;
    busy = true; refresh.disabled = true; cancelTimer?.();
    const active = lifecycle.guard();
    announce(`Refreshing · showing snapshot ${observedAt}`, "pending");
    try {
      const url = new URL(location.href);
      const data = await lifecycle.read(`${BASE}/api/overview${url.search}`, "Overview unavailable", 8000);
      if (!active()) return;
      render(data); failures = 0;
    } catch {
      if (!active()) return;
      failures++; pending = null; apply.hidden = true;
      announce(`${failures > 1 ? "Disconnected" : "Stale"} · showing last good snapshot ${observedAt}. Retry ${failures < 3 ? `in ${Math.min(60, 10 * 2 ** failures)}s` : "paused; use Refresh"}.`, "error");
    } finally {
      if (active()) { busy = false; refresh.disabled = false; if (failures < 3) schedule(failures ? Math.min(60_000, 10_000 * 2 ** failures) : 10_000); }
    }
  }
  refresh.addEventListener("click", () => { failures = 0; poll(); });
  apply.addEventListener("click", () => { if (pending) { render(pending, true); refresh.focus({ preventScroll: true }); } });
  lifecycle.onResume(() => { busy = false; poll(); });
  schedule(10_000);
})();
