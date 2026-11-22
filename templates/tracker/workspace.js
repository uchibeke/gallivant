// One read loop for task facts, readiness and reviewer progress. The selected
// attempt is pinned in every request; a new run is offered as an explicit link.
const workspace = document.querySelector?.(".workspace");
if (workspace) {
  const status = document.getElementById("workspace-state");
  const retry = document.getElementById("workspace-retry");
  const newAttempt = document.getElementById("workspace-new-attempt");
  const feedback = trackerFeedback(status);
  const targets = Object.entries({
    summary: "workspace-summary", evidence: "workspace-evidence-content", review: "workspace-review-content",
    recovery: "workspace-recovery-content", activity: "workspace-provenance-content", execution: "workspace-execution-content",
  }).map(([key, id]) => [key, document.getElementById(id)]);
  const rendered = new Map();
  let cancelTimer, failures = 0, lastGood = workspace.dataset.observed, currentRead = null;
  const announce = (message, state, access = "current") => {
    feedback.show(message, { state });
    globalThis.dispatchEvent(new CustomEvent("workspace-evidence-state", { detail: access }));
  };
  const restrict = restricted => {
    for (const child of workspace.children) {
      if (!child.matches(".workspace-freshness")) child.hidden = restricted;
    }
    if (restricted) {
      newAttempt.hidden = true;
      document.getElementById("workspace-activity").open = false;
    }
  };
  const refresh = async () => {
    if (currentRead) return;
    cancelTimer?.();
    retry.setAttribute("aria-busy", "true");
    const active = lifecycle.guard(), request = currentRead = {};
    try {
      const query = new URLSearchParams(location.search);
      query.set("id", workspace.dataset.entry);
      if (workspace.dataset.run) query.set("run", workspace.dataset.run);
      else query.set("attempt", "none");
      const data = await lifecycle.read(`${BASE}/api/run/workspace?${query}`, "Task evidence could not be retrieved");
      if (!active()) return;
      if (data.id !== workspace.dataset.entry || (data.run || "") !== workspace.dataset.run ||
          !targets.every(([key]) => typeof data[key] === "string")) throw new Error("Task snapshot unavailable");
      if (workspace.dataset.restricted === "true") { restrict(false); delete workspace.dataset.restricted; }
      workspace.dataset.briefChanged = String(data.briefChanged === true);
      failures = 0;
      const latest = data.latest || "";
      newAttempt.hidden = !latest || latest === workspace.dataset.latest || latest === workspace.dataset.run;
      const selection = globalThis.getSelection?.();
      const holdingText = selection && !selection.isCollapsed &&
        (workspace.contains(selection.anchorNode) || workspace.contains(selection.focusNode));
      const changes = targets.filter(([key]) => rendered.get(key) !== data[key]);
      if (changes.length && (holdingText || changes.some(([, target]) => target.contains(document.activeElement)))) {
        announce("Task updates are available. Evidence refresh pauses while you use the current view.", "pending", "deferred");
        return;
      }
      for (const [key, target] of changes) {
        const next = target.cloneNode(false);
        next.innerHTML = data[key];
        patchSnapshot(target, next);
        rendered.set(key, data[key]);
      }
      lastGood = data.snapshotAt || lastGood;
      announce(!newAttempt.hidden ? "Task snapshot current. A new attempt is available." :
        data.freshness === "stale" ? "Task snapshot current. The last task observation is stale." : "Task snapshot current.", "current");
    } catch (error) {
      if (!active()) return;
      failures++;
      const restricted = [401, 403].includes(error.status) || error.status === 404 && workspace.dataset.scoped === "true";
      if (restricted) { workspace.dataset.restricted = "true"; restrict(true); }
      const message = restricted ? "Task or attempt unavailable within this workspace scope." :
        error.status === 404 ? "Task or selected attempt missing. Last saved evidence retained." :
          `Task evidence disconnected. Last good snapshot retained${lastGood ? ` (${lastGood})` : ""}.`;
      announce(message, "error", restricted || error.status === 404 ? "unavailable" : "stale");
    } finally {
      if (currentRead === request) {
        retry.removeAttribute("aria-busy"); currentRead = null;
        if (active() && failures < 3) cancelTimer = lifecycle.schedule(refresh, Math.min(60_000, 10_000 * 2 ** failures));
      }
    }
  };
  retry.addEventListener("click", () => { failures = 0; refresh(); });
  lifecycle.onResume(() => { currentRead = null; refresh(); });
  refresh();

  const artifacts = document.getElementById("workspace-artifacts");
  if (artifacts) {
    const state = document.getElementById("artifact-state"), list = document.getElementById("artifact-list");
    const verification = document.getElementById("attempt-verification");
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
        state.textContent = `Saved result · showing ${Math.min(result.artifacts.length, 20)} of ${result.artifacts.length} projected artifacts (projection capped at 100).`;
        const verify = result.verification;
        verification.textContent = verify
          ? `Selected attempt Verify · ${verify.status} · ${verify.passed} passed, ${verify.failed} failed · head ${verify.head}`
          : "No coordinator Verify results recorded for this attempt.";
        verification.hidden = false;
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
