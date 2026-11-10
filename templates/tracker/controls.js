// Review status, relative time and protected operator controls.
// Where this tracker is mounted: empty when it owns the origin, something like "/gallivant" when a host server
// delegates a prefix to it. The server publishes it on <body data-base> because this file is served from one route
// and cannot be told at build time where it lives.
const BASE = document.body.dataset.base || "";
const lifecycle = trackerLifecycle();

// A live, bounded status feed; it never opens raw reviewer output or submits work.
const reviewActivity = document.getElementById("review-activity");
if (reviewActivity) {
  const log = document.getElementById("review-activity-log"), status = document.getElementById("review-activity-state");
  const url = `${BASE}/api/run/review-activity?id=${encodeURIComponent(reviewActivity.dataset.entry)}`;
  let previous = log.firstElementChild?.textContent || "";
  const pollReview = async () => {
    try {
      const data = await lifecycle.read(url, "Review status unavailable");
      if (!lifecycle.active()) return;
      if (typeof data.message !== "string") throw new Error("Review status unavailable");
      if (data.message !== previous) {
        const line = document.createElement("p");
        line.textContent = `${new Date().toLocaleTimeString()} — ${data.message}`;
        log.appendChild(line); previous = data.message;
        while (log.childElementCount > 40) log.firstElementChild.remove();
      }
      status.classList?.remove("loading");
      status.textContent = "Updates every 10 seconds while this page is open.";
    } catch { if (!lifecycle.active()) return; status.classList?.remove("loading"); status.textContent = "Review status unavailable; retrying."; }
    lifecycle.schedule(pollReview, 10_000);
  };
  pollReview();
}

// Relative times must age while the dashboard stays open.
const relativeTimes = document.querySelectorAll?.("time[data-relative-time]") || [];
if (relativeTimes.length) {
  const refreshTimes = () => relativeTimes.forEach(el => {
    const at = Date.parse(el.getAttribute("datetime"));
    if (!Number.isFinite(at)) { el.textContent = "unknown"; return; }
    const ms = Math.max(0, Date.now() - at), minutes = Math.round(ms / 60_000), hours = Math.round(minutes / 60);
    el.textContent = ms < 45_000 ? "just now" : minutes < 60 ? `${minutes}m ago` : hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
  });
  const tickTimes = () => { refreshTimes(); lifecycle.schedule(tickTimes, 30_000); };
  tickTimes();
}

// Fixed actions and messages share delivery, but only Send message reads the composer's draft.
const runControls = document.getElementById("run-controls");
if (runControls) {
  const buttons = [...runControls.querySelectorAll("button[data-action]")];
  const note = document.getElementById("run-note");
  const form = document.getElementById("message-form");
  const status = document.getElementById("control-status");
  const refresh = document.getElementById("control-refresh");
  const lastMessage = document.getElementById("last-message");
  const interrupt = document.getElementById("interrupt-run");
  document.getElementById("restore-message")?.addEventListener("click", () => {
    if (!note.value.trim()) note.value = lastMessage.querySelector("pre").textContent;
    note.focus(); syncButtons();
  });
  const endpoint = `${BASE}/api/run/control?id=${encodeURIComponent(runControls.dataset.entry)}`;
  let pending = runControls.dataset.pending === "true";
  let closed = false;
  const syncButtons = () => buttons.forEach(button => {
    button.setAttribute?.("aria-busy", String(pending));
    button.disabled = pending || closed || button.dataset.available !== "true"
      || (button.dataset.action === "message" && !note.value.trim());
  });
  const label = action => buttons.find(b => b.dataset.action === action)?.textContent || "Request";
  const poll = async () => {
    try {
      const data = await lifecycle.read(endpoint, "Could not check the request. Reload to see its status.");
      if (!lifecycle.active()) return;
      const control = data.control;
      if (!control) throw new Error("Request status is unavailable. Reload before retrying.");
      status.setAttribute?.("data-state", control.status === "failed" ? "error" : control.status === "applied" ? "success" : "pending");
      status.textContent = `${label(control.action)} — ${control.status}: ${control.message || "Waiting for the daemon and any active run."}`;
      if (control.status === "queued" || control.status === "applying") { lifecycle.schedule(poll, 3000); return; }
      pending = false;
      closed = data.state === "done";
      if (data.lastMessage?.note) {
        lastMessage.querySelector("pre").textContent = data.lastMessage.note;
        lastMessage.hidden = false;
      }
      if (control.status === "failed" && control.action === "message" && !note.value) note.value = control.note || lastMessage.querySelector("pre").textContent;
      syncButtons();
      // Follow the newest run unless that would discard a draft or interrupt typing.
      if (!note.value && document.activeElement !== note) { location.replace(refresh.href); return; }
      refresh.hidden = false;
    } catch (e) { if (!lifecycle.active()) return; status.textContent = e.message; lifecycle.schedule(poll, 5000); }
  };
  const submit = async action => {
    const button = buttons.find(b => b.dataset.action === action);
    if (!button || button.disabled) return;
    const draft = action === "message" ? note.value : "";
    pending = true; syncButtons(); refresh.hidden = true;
    status.setAttribute?.("data-state", "pending");
    status.textContent = `${label(action)} — queuing…`;
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json", "X-Gallivant-Token": runControls.dataset.token },
        body: JSON.stringify(action === "message" ? { action, note: draft, ...(interrupt?.checked ? { interrupt: true } : {}) } : { action }),
      });
      const data = await response.json();
      if (!lifecycle.active()) return;
      if (!response.ok) throw new Error(data.error || "Request failed. Reload to check its status before retrying.");
      if (action === "message") {
        // A user can keep composing while delivery is pending. Never erase newer edits.
        if (note.value === draft) note.value = "";
        lastMessage.querySelector("pre").textContent = draft;
        lastMessage.hidden = false;
      }
      status.textContent = `${label(action)} — queued. Waiting for the daemon and any active run.`;
      lifecycle.schedule(poll, 1000);
    } catch (e) {
      if (!lifecycle.active()) return;
      status.setAttribute?.("data-state", "error");
      status.textContent = `${label(action)} — ${e.message}`;
      pending = false; syncButtons();
    }
  };
  for (const button of buttons.filter(b => b.dataset.action !== "message")) {
    button.addEventListener("click", () => submit(button.dataset.action));
  }
  form.addEventListener("submit", event => { event.preventDefault(); submit("message"); });
  note.addEventListener("input", syncButtons);
  syncButtons();
  if (pending) lifecycle.schedule(poll, 1000);
}
