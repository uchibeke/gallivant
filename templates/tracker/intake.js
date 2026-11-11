(() => {
  const root = document.querySelector?.("[data-intake]");
  if (!root) return;
  const base = document.body.dataset.base || "", lifecycle = trackerLifecycle();
  const $ = id => document.getElementById(id), caps = JSON.parse(root.dataset.capabilities);
  const form = $("intake-request"), status = $("intake-status"), retry = $("intake-retry"), dialog = $("intake-confirm");
  const initialTask = $("intake-review")?.dataset.task;
  let key = `task-intake-v1:${root.dataset.instance}:${initialTask || "new"}`;
  let busy = false, canRetry = false, stale = false, confirmation = null;
  let lastDraft = null;
  const read = () => JSON.parse(localStorage.getItem(key) || "{}");
  const write = value => localStorage.setItem(key, JSON.stringify(value));
  const message = (text, state = "current") => { status.textContent = text; status.dataset.state = state; };
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
    $("intake-refresh").disabled = busy;
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
        const target = position.id && $(position.id);
        target?.focus({ preventScroll: true });
        if (target?.setSelectionRange && position.start != null) target.setSelectionRange(position.start, position.end, position.direction);
        if (target) target.scrollTop = position.top;
        scrollTo(0, position.pageY);
      }
      lastDraft = JSON.stringify(draft());
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
  async function refresh() {
    if (busy) return;
    const op = operation(), scope = key;
    if (!op && !snapshot()) { message("No saved task yet. Preparation requires the explicit Prepare action."); return; }
    busy = true; canRetry = false; availability();
    const live = lifecycle.guard();
    try {
      const result = await lifecycle.read(urlForRead(op), "Saved status is unavailable. Last review and drafts retained.");
      if (!live()) return;
      // Changed revisions are observed, never automatically approved or retried.
      const resolved = op && result.task && (op.action === "prepare" || result.task.revision !== op.input.expectedRevision);
      canRetry = !!op && !resolved;
      apply(result);
      if (resolved) await settle(op, scope);
      message(canRetry ? "Saved status checked. Retry only the original request with its retained identity." : "Saved revision refreshed. Review it before any further action.");
    } catch (error) { stale = true; message(error.message, "error"); }
    finally { busy = false; availability(); }
  }
  async function send(op, replay = false) {
    if (busy || replay && !canRetry) return;
    if (!checkpoint(true)) return;
    busy = true; canRetry = false;
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
      message(`${op.action === "start" ? "Submitting explicit Start" : "Saving preparation request"}… Keep this page or return to check the saved status.`);
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
      if (claimed.action === "answer") {
        const saved = read();
        for (const [id, value] of Object.entries(claimed.input.answers)) if (saved.answers?.[id] === value) delete saved.answers[id];
        write(saved);
      }
      apply(result, true);
      await settle(claimed, scope);
      message("Saved for review. Execution requires explicit Start.");
      if (claimed.action === "start" && result.task?.implementation) location.assign($("intake-workspace").href);
    } catch (error) {
      message(claimed ? "Response uncertain. The original request and draft are retained. Refresh saved status before retrying; do not create a new request." : error.message, "error");
    } finally { busy = false; availability(); }
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
})();
