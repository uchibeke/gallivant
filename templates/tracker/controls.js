// Review status, relative time and protected operator controls.
// Where this tracker is mounted: empty when it owns the origin, something like "/gallivant" when a host server
// delegates a prefix to it. The server publishes it on <body data-base> because this file is served from one route
// and cannot be told at build time where it lives.
const BASE = document.body.dataset.base || "";
const lifecycle = trackerLifecycle();

// A live, bounded status feed; it never opens raw reviewer output or submits work.
const reviewActivity = document.getElementById("review-activity");
if (reviewActivity && !document.querySelector?.(".workspace")) {
  const log = document.getElementById("review-activity-log"), status = document.getElementById("review-activity-state");
  const url = `${BASE}/api/run/review-activity?id=${encodeURIComponent(reviewActivity.dataset.entry)}`;
  let previous = log.firstElementChild?.textContent || "";
  const pollReview = async () => {
    const active = lifecycle.guard();
    try {
      const data = await lifecycle.read(url, "Review status unavailable");
      if (!active()) return;
      if (typeof data.message !== "string") throw new Error("Review status unavailable");
      if (data.message !== previous) {
        const line = document.createElement("p");
        line.textContent = `${new Date().toLocaleTimeString()} — ${data.message}`;
        log.appendChild(line); previous = data.message;
        while (log.childElementCount > 40) log.firstElementChild.remove();
      }
      status.classList?.remove("loading");
      status.textContent = "Updates every 10 seconds while this page is open.";
    } catch { if (!active()) return; status.classList?.remove("loading"); status.textContent = "Review status unavailable; retrying."; }
    lifecycle.schedule(pollReview, 10_000);
  };
  lifecycle.onResume(pollReview);
  pollReview();
}

// Relative times must age while the dashboard stays open.
const relativeTimes = document.querySelectorAll?.("time[data-relative-time]") || [];
if (relativeTimes.length) {
  const refreshTimes = () => {
    const selection = globalThis.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    (document.querySelectorAll?.("time[data-relative-time]") || []).forEach(el => {
      const at = Date.parse(el.getAttribute("datetime"));
      if (!Number.isFinite(at)) { el.textContent = "unknown"; return; }
      const ms = Math.max(0, Date.now() - at), minutes = Math.round(ms / 60_000), hours = Math.round(minutes / 60);
      el.textContent = ms < 45_000 ? "just now" : minutes < 60 ? `${minutes}m ago` : hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
    });
  };
  const tickTimes = () => { refreshTimes(); lifecycle.schedule(tickTimes, 30_000); };
  lifecycle.onResume(tickTimes);
  tickTimes();
}

// Fixed actions never consume the composer. Delivery identity is retained before
// POST; uncertain requests can only be replayed after a successful saved read.
const runControls = document.getElementById("run-controls");
if (runControls) {
  const buttons = [...runControls.querySelectorAll("button[data-action]")];
  const note = document.getElementById("run-note"), form = document.getElementById("message-form");
  const status = document.getElementById("control-status"), times = document.getElementById("control-times");
  const refresh = document.getElementById("control-refresh"), check = document.getElementById("control-check");
  const retry = document.getElementById("control-retry"), draftStatus = document.getElementById("draft-status");
  const lastMessage = document.getElementById("last-message"), interrupt = document.getElementById("interrupt-run");
  const store = taskControlDrafts(runControls.dataset.instance, runControls.dataset.entry);
  const endpoint = `${BASE}/api/run/control?id=${encodeURIComponent(runControls.dataset.entry)}`;
  let operation = store.initial.operation, latestId = runControls.dataset.requestId || "";
  let pending = runControls.dataset.pending === "true", uncertain = Boolean(operation), closed = false, sending = false;
  let reading = null, cancelTimer, failures = 0, canReplay = false, restoredFailure = null, deliveryGeneration = 0;
  const saved = store.initial;
  if (saved.value) {
    note.value = saved.value;
    note.setSelectionRange(saved.start || 0, saved.end || 0, saved.direction || "none");
    note.scrollTop = saved.top || 0;
    globalThis.addEventListener?.("pageshow", event => {
      if (event.persisted) return;
      if (saved.focused) note.focus({ preventScroll: true });
      globalThis.scrollTo?.(0, saved.pageY || 0);
    });
  }
  const persist = () => {
    const sensitiveDraft = redact(note.value) !== note.value;
    const ok = store.save({ value: sensitiveDraft ? "" : note.value, start: note.selectionStart, end: note.selectionEnd,
      direction: note.selectionDirection, top: note.scrollTop, pageY: globalThis.scrollY || 0,
      focused: document.activeElement === note, operation });
    if (draftStatus) draftStatus.textContent = sensitiveDraft ? "A credential pattern was detected. This draft stays only on this page; remove credentials before saving or sending."
      : ok ? "Draft saved only in this browser for this task · up to 7 days. Discard clears it."
      : store.error;
    return ok;
  };
  const syncButtons = () => {
    for (const button of buttons) {
      button.setAttribute?.("aria-busy", String(pending || sending));
      button.disabled = pending || sending || uncertain || closed || button.dataset.available !== "true"
        || (button.dataset.action === "message" && !note.value.trim());
    }
    if (retry) { retry.hidden = !uncertain; retry.disabled = sending || !canReplay; retry.setAttribute("aria-busy", String(Boolean(reading))); }
    if (check) { check.disabled = sending; check.setAttribute("aria-busy", String(Boolean(reading))); }
  };
  const feedback = (control, reason) => {
    const view = controlFeedback(control, reason);
    status.setAttribute?.("data-status", view.state); status.setAttribute?.("data-state", view.tone);
    if (status.textContent !== view.text) status.textContent = view.text;
    if (times) times.textContent = view.times;
  };
  const markUncertain = message => {
    uncertain = Boolean(operation); canReplay = false;
    feedback({ action: operation?.action, status: "uncertain", message });
    syncButtons();
  };
  const schedule = delay => { cancelTimer?.(); cancelTimer = lifecycle.schedule(poll, delay); };
  const updateAvailability = data => {
    latestId = data.control?.id || "";
    pending = ["queued", "applying"].includes(data.control?.status);
    closed = data.state === "done";
    for (const button of buttons) button.dataset.available = String(data.controls?.[button.dataset.action] === true);
    // While our accepted request is pending, allow a newer draft in an already
    // enabled composer. Never enable an initially unavailable capability.
    if (!pending || closed) note.disabled = closed || data.controls?.message !== true;
    if (interrupt) {
      interrupt.disabled = pending || closed || data.controls?.interrupt !== true;
      if (interrupt.disabled) interrupt.checked = false;
    }
    const activeOption = document.getElementById("interrupt-option");
    if (activeOption) activeOption.hidden = !data.active;
    for (const [id, value] of [["control-gate", data.gate], ["resume-help", data.resume], ["recheck-help", data.recheck], ["cancel-help", data.cancellation]]) {
      const element = document.getElementById(id);
      if (element && typeof value === "string") { element.textContent = value; if (id === "control-gate") element.hidden = !value; }
    }
    if (data.lastMessage?.note) { lastMessage.querySelector("pre").textContent = data.lastMessage.note; lastMessage.hidden = false; }
  };
  const accept = control => {
    if (operation?.action === "message" && !operation.acknowledged) {
      if (note.value === operation.note) note.value = "";
      lastMessage.querySelector("pre").textContent = operation.note; lastMessage.hidden = false;
    }
    if (control.status === "failed" && control.action === "message" && restoredFailure !== control.id) {
      if (!note.value) note.value = control.note || lastMessage.querySelector("pre").textContent;
      restoredFailure = control.id;
    }
    if (operation) operation.acknowledged = true;
    uncertain = false; canReplay = false;
    if (!["queued", "applying"].includes(control.status)) operation = null;
    persist();
  };
  async function poll() {
    if (reading || sending) return;
    cancelTimer?.();
    const active = lifecycle.guard(), request = reading = {}, generation = deliveryGeneration;
    syncButtons();
    try {
      const data = await lifecycle.read(`${endpoint}${operation ? `&requestId=${encodeURIComponent(operation.requestId)}` : ""}`, "Request status unavailable");
      if (!active() || generation !== deliveryGeneration) return;
      updateAvailability(data);
      if (operation && (data.requestId !== operation.requestId || !data.request)) {
        markUncertain("No saved result for this request was found. Your draft is retained.");
        // History is bounded. A different latest request may mean our identity
        // was evicted; never replay it as new paid work in that case.
        canReplay = data.requestId === operation.requestId && latestId === operation.previousId && !pending && !closed && data.controls?.[operation.action] === true;
        if (!canReplay) status.textContent += " Inspect the current request and execution before further work; replay is unavailable.";
      } else {
        const control = operation ? data.request : data.control;
        if (control) { accept(control); feedback(control, data.reason); refresh.hidden = ["queued", "applying"].includes(control.status); }
        else feedback(null);
      }
      failures = 0;
    } catch {
      if (!active() || generation !== deliveryGeneration) return;
      failures++;
      if (operation) markUncertain("Could not read saved status. Check the local server connection, then Check request status. No new request was sent.");
      else { status.textContent += status.textContent.includes("Status disconnected") ? "" : " Status disconnected; last observation retained. Check request status to reconnect."; }
    } finally {
      if (reading === request) {
        reading = null; syncButtons();
        if (active()) schedule(Math.min(60_000, (pending || uncertain ? 3000 : 10_000) * 2 ** failures));
      }
    }
  }
  async function deliver() {
    deliveryGeneration++;
    sending = true; canReplay = false; syncButtons(); cancelTimer?.(); refresh.hidden = true;
    feedback({ action: operation.action, status: "queued", message: "Sending request; awaiting the server receipt." });
    const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), 15_000);
    try {
      // Only service inputs cross the boundary, including after storage restore.
      const payload = { action: operation.action, requestId: operation.requestId,
        ...(operation.action === "message" ? { note: operation.note, interrupt: operation.interrupt } : {}) };
      const response = await fetch(endpoint, { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-Gallivant-Token": runControls.dataset.token }, body: JSON.stringify(payload) });
      const data = await response.json();
      clearTimeout(deadline);
      if (!await lifecycle.whenActive()) return;
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          feedback({ action: operation.action, status: "failed", message: data.error || "The server refused this request. Repair the prerequisite and try again." });
          operation = null; uncertain = pending = false; persist(); schedule(10_000); return;
        }
        throw new Error("Response unconfirmed");
      }
      if (data.id !== operation.requestId || !["queued", "applying", "applied", "failed"].includes(data.status)) throw new Error("Receipt identity unavailable");
      latestId = data.id; pending = ["queued", "applying"].includes(data.status);
      accept(data); feedback(data); schedule(1000);
    } catch {
      if (!await lifecycle.whenActive()) return;
      markUncertain("Delivery response was lost or timed out. Your draft is retained. Check saved status before retrying.");
      schedule(1000);
    } finally { clearTimeout(deadline); sending = false; syncButtons(); }
  }
  const submit = async action => {
    const button = buttons.find(b => b.dataset.action === action);
    if (!button || button.disabled) return;
    if (action === "cancel" && !globalThis.confirm(`Cancel task ${runControls.dataset.entry}? This stops further dispatch and requests cancellation of its current work, not the selected historical attempt. Unfinished files remain. Remote execution may continue until provider confirmation.`)) return;
    operation = { requestId: crypto.randomUUID(), action, note: action === "message" ? note.value : "",
      interrupt: action === "message" && Boolean(interrupt?.checked), previousId: latestId };
    if (!persist()) { operation = null; return; }
    await deliver();
  };
  for (const button of buttons.filter(b => b.dataset.action !== "message")) button.addEventListener("click", () => submit(button.dataset.action));
  form.addEventListener("submit", event => { event.preventDefault(); submit("message"); });
  note.addEventListener("input", () => { persist(); syncButtons(); });
  for (const event of ["select", "keyup", "click", "scroll", "blur"]) note.addEventListener(event, persist);
  globalThis.addEventListener?.("pagehide", persist);
  document.getElementById("discard-draft")?.addEventListener("click", () => { note.value = ""; persist(); syncButtons(); note.focus(); });
  document.getElementById("restore-message")?.addEventListener("click", () => {
    if (!note.value.trim()) note.value = lastMessage.querySelector("pre").textContent;
    note.focus(); persist(); syncButtons();
  });
  check?.addEventListener("click", poll);
  retry?.addEventListener("click", async () => {
    if (!operation || sending || reading) return;
    await poll(); // Reconcile again immediately before an explicit retry.
    if (uncertain && canReplay) await deliver();
  });
  lifecycle.onResume(() => { reading = null; if (!sending) poll(); });
  if (uncertain) markUncertain("Restored an unconfirmed request. Checking its saved identity before further work.");
  syncButtons();
  schedule(pending || uncertain ? 1000 : 10_000);
}
