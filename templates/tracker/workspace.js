// One read loop for task facts, readiness and reviewer progress. The selected
// attempt is pinned in every request; a new run is offered as an explicit link.
const workspace = document.querySelector?.(".workspace");
if (workspace) {
  const status = document.getElementById("workspace-state");
  const retry = document.getElementById("workspace-retry");
  const query = new URLSearchParams(location.search);
  query.set("id", workspace.dataset.entry);
  if (workspace.dataset.run) query.set("run", workspace.dataset.run);
  const endpoint = `${BASE}/api/run/workspace?${query}`;
  let busy = false, cancelTimer, failures = 0, lastGood = null, currentRead = null;
  const refresh = async () => {
    if (busy) return;
    cancelTimer?.(); busy = true; retry.disabled = true;
    status.textContent = "Refreshing task evidence; displayed snapshot retained.";
    const active = lifecycle.guard(), request = currentRead = {};
    try {
      const data = await lifecycle.read(endpoint, "Task evidence could not be retrieved");
      if (!active()) return;
      if (data.id !== workspace.dataset.entry ||
          ![data.summary, data.evidence, data.review, data.execution].every(v => typeof v === "string")) throw new Error("Task snapshot unavailable");
      if ((data.run || "") !== workspace.dataset.run) {
        document.getElementById("workspace-new-attempt").hidden = false;
        status.textContent = "A new attempt has been recorded. Open the new attempt to inspect its output; this view is preserved.";
        failures = 0; return;
      }
      // Never replace selected text or a focused disclosure/link. Try again on
      // the next scheduled read, without stealing focus or scrolling the page.
      const selection = globalThis.getSelection?.();
      const targets = [["workspace-summary", data.summary], ["workspace-evidence-content", data.evidence],
        ["workspace-review-content", data.review], ["workspace-execution-content", data.execution]];
      if (selection && !selection.isCollapsed || targets.some(([id]) => document.getElementById(id).contains(document.activeElement))) {
        status.textContent = "New task observation available; updates pause while you read or select text. Refresh evidence when ready.";
      } else {
        for (const [id, html] of targets) {
          const target = document.getElementById(id);
          if (target.dataset.snapshot === html) continue;
          const expanded = [...target.querySelectorAll("details")].map(el => el.open);
          target.innerHTML = html; target.dataset.snapshot = html;
          [...target.querySelectorAll("details")].forEach((el, i) => { el.open = expanded[i] || false; });
        }
        lastGood = data.snapshotAt || "unknown";
        status.textContent = `Task snapshot current · ${lastGood}. Each evidence source has its own observation time.`;
      }
      failures = 0;
    } catch {
      if (!active()) return;
      failures++;
      status.textContent = `Task evidence disconnected; last good snapshot retained${lastGood ? ` (${lastGood})` : ""}. Check the local server connection, then Refresh evidence. This read failure does not establish worker failure or completion.`;
    } finally {
      if (currentRead === request) {
        busy = false; retry.disabled = false; currentRead = null;
        if (active()) cancelTimer = lifecycle.schedule(refresh, Math.min(60_000, 10_000 * 2 ** failures));
      }
    }
  };
  retry.addEventListener("click", refresh);
  lifecycle.onResume(() => { currentRead = null; busy = false; refresh(); });
  refresh();

  const artifacts = document.getElementById("workspace-artifacts");
  if (artifacts) {
    const state = document.getElementById("artifact-state"), list = document.getElementById("artifact-list");
    const retryResult = document.getElementById("artifact-retry");
    let reading = null, loaded = false;
    const readResult = async () => {
      if (reading) return;
      const request = reading = {}; retryResult.disabled = true;
      state.textContent = loaded ? 'Refreshing saved artifacts…' : 'Loading saved artifacts…';
      state.classList.add('loading'); state.dataset.skeleton = loaded ? 'false' : 'true';
      list.setAttribute('aria-busy', 'true');
      const active = lifecycle.guard();
      try {
        const result = await lifecycle.read(artifacts.dataset.url, "Saved result unavailable");
        if (!active()) return;
        if (result.runId !== workspace.dataset.run || !Array.isArray(result.artifacts)) throw new Error("Result identity unavailable");
        const fragment = document.createDocumentFragment();
        for (const artifact of result.artifacts.slice(0, 20)) {
          const row = document.createElement("li");
          row.textContent = `${String(artifact.path || "unknown").slice(0, 256)} · ${String(artifact.hash || "hash unknown").slice(0, 128)}`;
          fragment.append(row);
        }
        list.replaceChildren(fragment); loaded = true;
        state.textContent = `Saved result · showing ${Math.min(result.artifacts.length, 20)} of ${result.artifacts.length} projected artifacts (projection capped at 100). Output source: selected run result; total inventory may be unknown.`;
      } catch {
        if (active()) state.textContent = "Saved result unavailable or not collected. Last good artifact metadata retained. Retry result after collection or restoring the local connection; worker outcome remains separate.";
      } finally {
        if (reading === request) {
          reading = null; retryResult.disabled = false; retryResult.hidden = false;
          state.classList.remove('loading'); delete state.dataset.skeleton; list.removeAttribute('aria-busy');
        }
      }
    };
    document.getElementById("execution-details").addEventListener("toggle", event => { if (event.target.open && !loaded) readResult(); });
    retryResult.addEventListener("click", readResult);
    lifecycle.onResume(() => { reading = null; if (document.getElementById('execution-details').open && !loaded) readResult(); });
  }
}
