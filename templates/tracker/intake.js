(() => {
  const root = document.querySelector?.("[data-intake]");
  if (!root) return;
  const base = document.body.dataset.base || "";
  const $ = id => document.getElementById(id), caps = JSON.parse(root.dataset.capabilities);
  const form = $("intake-request"), status = $("intake-status"), retry = $("intake-retry"), dialog = $("intake-confirm");
  const initialTask = $("intake-review")?.dataset.task;
  let key = `task-intake-v1:${root.dataset.instance}:${initialTask || "new"}`;
  let busy = false, canRetry = false, stale = false, confirmation = null;
  let lastDraft = null;
  let observation = null, cancelObservation = null, observationFailures = 0;
  const feedback = trackerFeedback(status, { mirror: $("intake-local-feedback") });
  const read = () => JSON.parse(localStorage.getItem(key) || "{}");
  const write = value => localStorage.setItem(key, JSON.stringify(value));
  const message = (text, state = "current", options = {}) => feedback.show(text, { state, ...options });
  const preparing = task => ["preparing", "validating"].includes(task?.status);
  const phaseMessage = task => task.status === "ready" ? "Requirements ready. Review them before starting."
    : task.status === "needs-input" ? "Your answers are needed to finish preparing this task."
    : task.status === "blocked" ? "Preparation needs attention. Review the saved reason and recovery actions."
    : task.implementation ? "Implementation has started. Open the task workspace for progress."
    : `Saved preparation status: ${task.status}.`;
  const snapshot = () => {
    const el = $("intake-review");
    return el ? { taskId: el.dataset.task, revision: Number(el.dataset.revision), status: el.dataset.status, canStart: el.dataset.canStart === "true" } : null;
  };
  // Draft checkpoints never write request identities: another tab may be
  // claiming one concurrently. Only the origin-wide Web Lock changes these.
  const operation = (scope = key) => JSON.parse(localStorage.getItem(`${scope}:operation`) || "null");
  const draft = () => ({ fields: Object.fromEntries(new FormData(form)),
    answers: $("intake-answers") ? Object.fromEntries(new FormData($("intake-answers"))) : {}, answerVerify: $("intake-answer-verify")?.value || "" });
  const checkpoint = (force = false) => {
    try {
      const { fields, answers, answerVerify } = draft();
      const serialized = JSON.stringify({ fields, answers, answerVerify });
      if (redact(serialized) !== serialized) {
        const saved = read(); delete saved.fields; delete saved.answers; delete saved.answerVerify; write(saved);
        message("A credential pattern was detected. Remove credentials before saving or sending.", "error"); return false;
      }
      // Navigation/blur in an older tab cannot replace another tab's newer edit.
      if (serialized === lastDraft && force !== true) return true;
      write({ ...read(), fields, answers, answerVerify, updated: Date.now() }); lastDraft = serialized; return true;
    } catch { message("Browser storage is unavailable or full. Enable storage before sending; retain this draft and any unresolved request.", "error"); return false; }
  };
  const options = () => {
    const repo = caps.repositories.find(r => r.id === form.elements.repositoryId.value);
    const selected = form.elements.harness.value;
    $("intake-harness").replaceChildren(new Option("Select a provider", ""), ...(repo?.providers || []).map(p => new Option(p.name, p.name)));
    form.elements.harness.value = selected;
    $("intake-repository-help").textContent = repo?.reason || (repo ? `Approved base: ${repo.base || "repository default, resolved during preparation"}. Uses the registered source checkout.` : "Select an approved repository. No filesystem browsing is available.");
    availability();
  };
  function availability() {
    const repo = caps.repositories.find(r => r.id === form.elements.repositoryId.value);
    const provider = repo?.providers.find(p => p.name === form.elements.harness.value);
    const model = form.elements.route.value === "model";
    const reason = !repo ? "Select a repository." : !repo.available ? repo.reason : !provider ? "Select an execution provider." : !provider.available ? provider.reason : model ? caps.modelRoute.reason : provider.preparationReason;
    const source = model ? `${caps.modelRoute.adapter || "unconfigured adapter"} · ${caps.modelRoute.model || "unconfigured model"}` : provider?.name || "selected harness";
    $("intake-provider-help").textContent = reason || `Preparation: ${source}. ${caps.accountAccess}`;
    $("intake-cost").textContent = `Prepare with ${source} may incur charges. Configured task allowance: $${caps.allowance.budgetUsd} / ${caps.allowance.runtimeMinutes} minutes. Implementation requires a separate Start.`;
    let pending = true;
    try { pending = !!operation(); } catch { /* fail closed */ }
    $("intake-prepare").disabled = busy || pending || !!reason || !root.dataset.token;
    root.querySelectorAll("#intake-answers button, [data-intake-action], #intake-open-start").forEach(el => {
      el.disabled = busy || pending || stale || (el.id === "intake-open-start" && !snapshot()?.canStart);
    });
    $("intake-start").disabled = busy || pending || stale;
    $("intake-refresh").disabled = busy || !!observation;
    $("intake-refresh").setAttribute('aria-busy', String(!!observation));
    retry.hidden = !pending; retry.disabled = busy || !canRetry;
  }
  function restoreAnswers() {
    try {
      for (const [name, value] of Object.entries(read().answers || {})) {
        const field = $("intake-answers")?.elements.namedItem(name);
        if (field && typeof value === "string") field.value = value;
      }
      if ($("intake-answer-verify")) $("intake-answer-verify").value = read().answerVerify || "";
    } catch { /* submission will fail closed if storage is unavailable */ }
  }
  function apply(result, focus = false) {
    stale = false;
    if (result.task) {
      const active = document.activeElement, position = { id: active?.id, start: active?.selectionStart, end: active?.selectionEnd,
        direction: active?.selectionDirection, top: active?.scrollTop, pageY: scrollY };
      const nextKey = `task-intake-v1:${root.dataset.instance}:${result.task.taskId}`;
      if (nextKey !== key) {
        const saved = read();
        if (!localStorage.getItem(nextKey)) localStorage.setItem(nextKey, JSON.stringify({ fields: saved.fields, answers: saved.answers }));
        key = nextKey;
      }
      $("intake-result").innerHTML = result.content; // Only shared escaped server presentation.
      $("intake-request-section").hidden = true;
      const url = new URL(location.href); url.searchParams.set("task", result.task.taskId);
      history.replaceState(null, "", url.pathname + url.search);
      restoreAnswers();
      if (focus) $("intake-review-title").focus();
      else {
        const target = position.id ? $(position.id) : null;
        target?.focus?.({ preventScroll: true });
        if (target?.setSelectionRange && position.start != null) target.setSelectionRange(position.start, position.end, position.direction);
        if (target) target.scrollTop = position.top;
        scrollTo(0, position.pageY);
      }
      lastDraft = JSON.stringify(draft());
      for (const step of root.querySelectorAll('[data-intake-step]')) {
        if (Number(step.dataset.intakeStep) === (result.task.implementation ? 3 : preparing(result.task) ? 1 : 2)) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
      }
    }
    availability();
  }
  const settle = async (op, scope = key) => navigator.locks.request(scope, () => {
    if (operation(scope)?.input.operationId === op.input.operationId) localStorage.removeItem(`${scope}:operation`);
  });
  const urlForRead = op => {
    const task = snapshot();
    const query = op?.action === "prepare" ? { repositoryId: op.input.repositoryId, operationId: op.input.operationId } : { taskId: op?.input.taskId || task?.taskId };
    return `${base}/api/task/intake?${new URLSearchParams({ ...query, theme: document.documentElement.dataset.theme || "" })}`;
  };
  const resolvedOperation = (op, task) => !!op && !!task && (op.action === "prepare" || task.revision !== op.input.expectedRevision);
  const savedLink = task => {
    const link = $("intake-saved-task");
    if (!task || !link) return;
    const url = new URL(location.href); url.searchParams.set("task", task.taskId);
    link.href = url.pathname + url.search; link.hidden = false;
  };
  function scheduleObservation(delay = 2000) {
    cancelObservation?.();
    if (operation() || preparing(snapshot())) cancelObservation = lifecycle.schedule(observe, delay);
  }
  async function observe() {
    if (observation) return;
    const op = operation(), scope = key, task = snapshot();
    if (!op && !preparing(task)) return;
    const request = observation = {}, live = lifecycle.guard();
    availability();
    try {
      const result = await lifecycle.read(urlForRead(op), "Saved progress is unavailable.", 8000);
      if (!live() || observation !== request || scope !== key || (operation()?.input.operationId || null) !== (op?.input.operationId || null)) return;
      observationFailures = 0; savedLink(result.task);
      const resolved = resolvedOperation(op, result.task);
      // A new revision invalidates the old retry even while preparation is
      // pending. The same unresolved revision preserves a prior explicit read.
      if (resolved) canRetry = false;
      if (!busy && result.task && !preparing(result.task) && (!op || resolved)) {
        if (op) await settle(op, scope);
        if (!live() || scope !== key || busy) return;
        canRetry = false;
        apply(result);
        message(phaseMessage(result.task), result.task.status === "blocked" ? "error" : "success");
      } else if (result.task && preparing(result.task)) {
        message(`Preparing requirements · saved revision ${result.task.revision}.`, "pending", {
          pending: true, detail: "Checking saved progress automatically. You can reopen this preparation; implementation still requires a separate Start.",
        });
      } else if (op && !busy) {
        // Observing unchanged input cannot revoke an already validated retry.
        // Missing preparation still permits only the retained original request.
        canRetry = canRetry || !result.task;
        message(canRetry ? "Saved status checked. Retry same request is available." : "Checking saved progress. The original request is retained.", "pending", {
          detail: canRetry ? "No request has been resent. An explicit retry reuses the saved input and identity." : "No new request is being sent. Refresh saved status before choosing any recovery action.",
        });
      }
    } catch {
      if (!live() || observation !== request) return;
      observationFailures++;
      message(observationFailures >= 3 ? "Progress updates paused. Refresh saved status to reconnect; your request is retained." : "Progress connection interrupted. Checking again; your request is retained.", "error");
    } finally {
      if (observation === request) {
        observation = null;
        if (live()) {
          availability();
          if (observationFailures < 3) scheduleObservation(observationFailures ? Math.min(30000, 5000 * 2 ** observationFailures) : 5000);
        }
      }
    }
  }
  async function refresh() {
    if (busy || observation) return;
    const op = operation(), scope = key;
    if (!op && !snapshot()) { message("No saved task yet. Preparation requires the explicit Prepare action."); return; }
    busy = true; canRetry = false; availability();
    const live = lifecycle.guard();
    try {
      const result = await lifecycle.read(urlForRead(op), "Saved status is unavailable. Last review and drafts retained.");
      if (!live()) return;
      // Changed revisions are observed, never automatically approved or retried.
      const resolved = resolvedOperation(op, result.task);
      canRetry = !!op && !resolved;
      if (resolved) await settle(op, scope);
      apply(result);
      savedLink(result.task); observationFailures = 0;
      message(canRetry ? "Saved status checked. Retry only the original request with its retained identity." : "Saved revision refreshed. Review it before any further action.");
    } catch (error) { stale = true; message(error.message, "error"); }
    finally { busy = false; availability(); scheduleObservation(); }
  }
  async function send(op, replay = false) {
    if (busy || replay && !canRetry) return;
    if (!op?.input || !["prepare", "answer", "resume", "validate", "start"].includes(op.action)) {
      message("Saved request type is unsupported. Keep this request and inspect it before continuing.", "error"); return;
    }
    if (!checkpoint(true)) return;
    busy = true; canRetry = false;
    const activeButton = op.action === "prepare" ? $("intake-prepare") : op.action === "answer" ? $("intake-answers")?.querySelector('button[type="submit"]')
      : op.action === "start" ? $("intake-start") : root.querySelector(`[data-intake-action="${op.action}"]`);
    const idleLabel = activeButton?.textContent;
    const progress = {
      prepare: ["Preparing requirements…", "Preparing…"], answer: ["Saving answers and updating requirements…", "Updating…"],
      resume: ["Continuing preparation…", "Continuing…"], validate: ["Checking readiness…", "Checking…"], start: ["Starting the approved task…", "Starting…"],
    }[op.action];
    availability();
    message(progress[0], "pending", { pending: true, button: activeButton, label: progress[1],
      detail: op.action === "start" ? "Submitting only the revision you approved. Waiting for its saved result." : "Preparing the saved requirements. Implementation begins only after a separate Start.",
    });
    let claimed;
    const scope = key;
    try {
      if (!navigator.locks) throw new Error("This browser cannot coordinate requests. Use a browser with Web Locks support on localhost.");
      claimed = await navigator.locks.request(key, () => {
        const pending = operation();
        if (pending) return replay && pending.input.operationId === op.input.operationId ? pending : null;
        if (replay) return null;
        localStorage.setItem(`${key}:operation`, JSON.stringify(op)); return op;
      });
      if (!claimed) { message("Another unresolved request is retained. Refresh saved status before continuing."); return; }
      availability();
      observationFailures = 0; scheduleObservation();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15_000);
      let response, result;
      const stop = () => controller.abort();
      addEventListener("pagehide", stop, { once: true });
      try {
        response = await fetch(`${base}/api/task/intake/${claimed.action}?theme=${encodeURIComponent(document.documentElement.dataset.theme || "")}`, { method: "POST", headers: { "content-type": "application/json", "x-gallivant-token": root.dataset.token }, body: JSON.stringify(claimed.input), signal: controller.signal });
        result = await response.json();
      } finally { clearTimeout(timer); removeEventListener("pagehide", stop); }
      if (!await lifecycle.whenActive()) return;
      if (!response.ok) {
        if (result.noEffects || [400, 403, 413, 415].includes(response.status)) await settle(claimed, scope);
        stale = true; message(result.error || "Request outcome is uncertain. Check saved status before retrying.", "error"); return;
      }
      if (!result.task || typeof result.content !== 'string' || !Number.isSafeInteger(result.task.revision)) throw new Error('Saved result is unavailable');
      if (claimed.action === "answer") {
        const saved = read();
        for (const [id, value] of Object.entries(claimed.input.answers)) if (saved.answers?.[id] === value) delete saved.answers[id];
        write(saved);
      }
      await settle(claimed, scope);
      apply(result, true); savedLink(result.task);
      message(preparing(result.task) ? "Preparation is saved and awaiting its next result. Refresh saved status to inspect recovery actions." : phaseMessage(result.task), result.task?.status === "blocked" ? "error" : "success");
      if (claimed.action === "start" && result.task?.implementation) location.assign($("intake-workspace").href);
    } catch (error) {
      message(claimed ? "Response uncertain. The original request and draft are retained. Checking saved progress; do not create a new request." : error.message, "error", {
        detail: claimed ? "The provider may still be working. Status checks only read the saved request; they never resubmit it." : "",
      });
    } finally {
      if (activeButton) { activeButton.textContent = idleLabel; activeButton.setAttribute("aria-busy", "false"); }
      busy = false; availability(); scheduleObservation();
    }
  }
  function revisionAction(action) {
    const task = snapshot();
    if (!task) return;
    return { action, input: { taskId: task.taskId, expectedRevision: task.revision, operationId: intakeRevisionOperation(action, task.taskId, task.revision), ...(action === "start" ? { run: true } : {}) } };
  }
  root.addEventListener("input", checkpoint);
  form.elements.repositoryId.addEventListener("change", options);
  form.elements.harness.addEventListener("change", availability);
  form.elements.route.addEventListener("change", availability);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form));
    if (!fields.text.trim()) { $("intake-text").setAttribute("aria-invalid", "true"); $("intake-text").focus(); message("Describe the task before preparing requirements.", "error"); return; }
    $("intake-text").removeAttribute("aria-invalid");
    send({ action: "prepare", input: { repositoryId: fields.repositoryId, text: fields.text, harness: fields.harness, route: fields.route,
      delivery: { action: caps.delivery.defaultAction, completion: fields.completion }, verifyCommands: fields.verify.split("\n").map(s => s.trim()).filter(Boolean), operationId: crypto.randomUUID(), expectedRevision: 0 } });
  });
  root.addEventListener("submit", event => {
    if (event.target.id !== "intake-answers") return;
    event.preventDefault();
    const task = snapshot();
    const answers = Object.fromEntries([...new FormData(event.target)].filter(([, value]) => value.trim()));
    if (!Object.keys(answers).length) { message("Answer at least one saved question before continuing.", "error"); event.target.querySelector("textarea")?.focus(); return; }
    send({ action: "answer", input: { taskId: task.taskId, expectedRevision: task.revision, operationId: crypto.randomUUID(), answers,
      verifyCommands: $("intake-answer-verify").value.split("\n").map(s => s.trim()).filter(Boolean) } });
  });
  root.addEventListener("click", event => {
    const action = event.target.closest("[data-intake-action]")?.dataset.intakeAction;
    if (action) send(revisionAction(action));
    if (event.target.id === "intake-open-start") {
      confirmation = revisionAction("start");
      $("intake-confirm-scope").textContent = `Approve revision ${confirmation.input.expectedRevision} of ${confirmation.input.taskId}. The requirements, acceptance criteria, verification and delivery shown on this page are the contract you are approving.`;
      dialog.showModal(); $("intake-cancel").focus();
    }
  });
  $("intake-cancel").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => $("intake-open-start")?.focus());
  $("intake-start").addEventListener("click", () => {
    if (!confirmation || snapshot()?.revision !== confirmation.input.expectedRevision) return;
    dialog.close(); send(confirmation);
  });
  $("intake-refresh").addEventListener("click", refresh);
  retry.addEventListener("click", () => { const op = operation(); if (op) send(op, true); });
  addEventListener("pagehide", checkpoint);
  addEventListener("storage", event => { if (event.key === key || event.key === `${key}:operation`) { canRetry = false; availability(); } });
  try {
    const saved = read();
    for (const [name, value] of Object.entries(saved.fields || {})) if (form.elements.namedItem(name) && typeof value === "string") form.elements.namedItem(name).value = value;
    options();
    if (saved.fields?.harness) form.elements.harness.value = saved.fields.harness;
    restoreAnswers();
    if (operation()) message("An unresolved request is retained. Refresh saved status before retrying the original operation.");
  } catch { message("Browser storage is unavailable. Enable it before sending any request.", "error"); }
  lastDraft = JSON.stringify(draft());
  availability();
  scheduleObservation();
  lifecycle.onResume(() => { observation = null; observationFailures = 0; scheduleObservation(0); });
})();
