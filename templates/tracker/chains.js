// One bounded lifecycle for this surface. No per-milestone reads or event streams.
(() => {
  const root = document.querySelector?.('[data-chains]');
  if (!root) return;
  const legacy = root.dataset.path === '/chains';
  const results = document.getElementById('chains-results');
  // Pin the server-preselected identifiers without replacing an explicit selection.
  function pinSelection(url) {
    const selected = results.querySelector('[data-selected-plan]')?.dataset;
    const selection = legacy ? { chain: selected?.chain, milestone: selected?.selectedMilestone }
      : { plan: selected?.selectedPlan, node: selected?.selectedNode };
    for (const [key, value] of Object.entries(selection)) {
      if (value && !url.searchParams.has(key)) url.searchParams.set(key, value);
    }
    return url;
  }
  const initialUrl = pinSelection(new URL(location.href));
  if (initialUrl.href !== location.href) history.replaceState(history.state, '', initialUrl);
  const planLocation = url => {
    const view = new URL(url);
    for (const key of ['artifact', 'artifactAt', 'fileView']) view.searchParams.delete(key);
    return view.pathname + view.search;
  };
  let shownLocation = planLocation(initialUrl);
  const status = document.getElementById('chains-status'), refresh = document.getElementById('chains-refresh');
  const apply = document.getElementById('chains-apply'), dialog = document.getElementById('chain-confirm');
  const review = document.getElementById('chain-review'), actionStatus = document.getElementById('chain-action-status');
  const submit = document.getElementById('chain-submit'), close = document.getElementById('chain-close');
  let busy = false, failures = 0, cancelTimer, pending, confirmation, posting = false, trigger, stale = false, reading;
  let observed = status.textContent;
  const feedback = trackerFeedback(status);
  const planControls = legacy ? null : trackerPlanControls(root, lifecycle, () => poll());
  const supported = typeof dialog.showModal === 'function' && typeof globalThis.crypto?.randomUUID === 'function';
  const enforceSupport = () => {
    if (supported) return;
    for (const button of root.querySelectorAll('[data-chain-action]')) {
      button.disabled = true;
      document.getElementById(button.getAttribute('aria-describedby')).textContent = 'This browser lacks secure request identities or accessible confirmation dialogs. Use a current browser on localhost.';
    }
  };
  enforceSupport();
  const held = () => {
    const selection = globalThis.getSelection?.();
    return dialog.open || planControls?.held || results.contains(document.activeElement)
      || selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))
      || document.querySelector('#chains-results details[open]') || scrollY > root.offsetTop;
  };
  function render(data, force = false, url = new URL(location.href)) {
    if (typeof data?.content !== 'string' || !Number.isFinite(Date.parse(data.observedAt))) throw new Error('Invalid chain snapshot');
    const next = new DOMParser().parseFromString(data.content, 'text/html').getElementById('chains-results');
    if (!next) throw new Error('Invalid chain snapshot');
    const restricted = data.factory?.permissions === 'scoped';
    if (!force && !restricted && held()) {
      pending = data; apply.hidden = false;
      feedback.show(`Updates ready · ${observed}. Apply when ready.`, { state: 'pending' });
      return;
    }
    const theme = url.searchParams.get('theme');
    for (const link of next.querySelectorAll('a[href]')) {
      const href = link.getAttribute('href');
      if (href.startsWith('#')) continue;
      const target = new URL(href, url);
      if (target.origin !== location.origin) continue;
      if (theme) target.searchParams.set('theme', theme); else target.searchParams.delete('theme');
      link.href = target.pathname + target.search + target.hash;
    }
    patchSnapshot(results, next);
    if (restricted && dialog.open && !root.querySelector('[data-chain-action]:enabled')) dialog.close();
    enforceSupport();
    stale = false; planControls?.sync(false);
    pending = null; apply.hidden = true; observed = `snapshot observed ${data.observedAt}`;
    feedback.show(`Current · ${observed}`);
    if (!force && !legacy) {
      const pinned = pinSelection(new URL(location.href));
      if (pinned.href !== location.href) {
        history.replaceState(history.state, '', pinned);
        carrySelection(pinned);
      }
    }
  }
  const schedule = delay => { cancelTimer?.(); cancelTimer = lifecycle.schedule(poll, delay); };
  async function poll(navigation) {
    if (posting || planControls?.busy || busy && !navigation) return;
    reading?.abort();
    const request = reading = new AbortController();
    busy = true; refresh.disabled = true; cancelTimer?.();
    const live = lifecycle.guard(), active = () => live() && reading === request;
    const url = navigation?.url ?? new URL(location.href);
    if (navigation) feedback.show('Loading selected plan view…', { pending: true });
    refresh.setAttribute('aria-busy', 'true');
    try {
      const data = await lifecycle.read(`${BASE}/api${root.dataset.path}${url.search}`, 'Plan snapshot unavailable', 8000, request.signal);
      if (!active()) return;
      const previous = navigation?.push ? historyView() : null;
      if (navigation?.push) {
        const theme = new URL(location.href).searchParams.get('theme');
        if (theme) url.searchParams.set('theme', theme); else url.searchParams.delete('theme');
      }
      render(data, !!navigation, url); failures = 0;
      if (navigation) finishNavigation(navigation, previous);
    } catch {
      if (!active()) return;
      failures++; pending = null; apply.hidden = true;
      stale = true; submit.disabled = true; planControls?.sync(true);
      for (const button of root.querySelectorAll('[data-chain-action]')) button.disabled = true;
      if (dialog.open) actionStatus.textContent = 'Plan observation is stale. Close this review and refresh before confirming.';
      feedback.show(`${failures > 1 ? 'Disconnected' : 'Stale'} · last good ${observed}. ${failures < 3 ? 'Retry scheduled.' : 'Automatic retry paused; use Refresh.'}${root.querySelector('[data-chain-action], [data-plan-action]') ? ' Refresh before reviewing a control.' : ''}`, { state: 'error' });
    } finally {
      if (active()) {
        busy = false; refresh.disabled = false; refresh.setAttribute('aria-busy', 'false');
        if (failures < 3) schedule(failures ? Math.min(60000, 10000 * 2 ** failures) : 10000);
      }
    }
  }
  function historyView() {
    return { x: scrollX, y: scrollY, open: [...results.querySelectorAll('details[open][data-key]')].map(item => item.dataset.key) };
  }
  function carrySelection(url) {
    const filter = root.querySelector('.chain-filters');
    for (const key of ['plan', 'node', 'diagram', 'milestone']) {
      const value = url.searchParams.get(key);
      let field = filter.querySelector(`input[name="${key}"]`);
      if (!field && value) { field = document.createElement('input'); field.type = 'hidden'; field.name = key; filter.append(field); }
      if (field) field.value = value ?? '';
      for (const link of document.querySelectorAll('.views a, .command-links a')) {
        const target = new URL(link.href);
        if (value) target.searchParams.set(key, value); else target.searchParams.delete(key);
        link.href = target.pathname + target.search + target.hash;
      }
    }
  }
  function finishNavigation({ url, push, link, focus, position }, previous) {
    pinSelection(url);
    if (push) {
      history.replaceState({ ...history.state, planView: previous }, '', location.href);
      history.pushState(null, '', url);
    } else if (url.href !== location.href) history.replaceState(history.state, '', url);
    const theme = url.searchParams.get('theme');
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    document.getElementById('theme').value = theme || '';
    carrySelection(url); shownLocation = planLocation(url);
    if (position) {
      const open = new Set(position.open);
      for (const item of results.querySelectorAll('details[data-key]')) item.open = open.has(item.dataset.key);
      scrollTo(position.x, position.y);
    }
    if (!link) return;
    const destination = focus === 'node' ? document.getElementById('selected-plan-node')
      : focus === 'diagram' ? results.querySelector('.plan-section-heading a, .plan-diagram-toggle')
      : link.isConnected ? link : document.getElementById('chain-title') ?? refresh;
    destination?.focus({ preventScroll: !matchMedia('(max-width: 700px)').matches });
  }
  if (!legacy) {
    carrySelection(initialUrl);
    root.addEventListener('click', event => {
      const link = event.target.closest('#chains-results a[href]:not([data-artifact-link])');
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target) return;
      const url = new URL(link.href);
      if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash) return;
      event.preventDefault();
      const focus = link.closest('.milestone-list, .plan-diagram, .diagram-list, .prerequisite-list') ? 'node'
        : link.closest('.plan-section-heading, .plan-diagram-toggle') ? 'diagram' : null;
      if (url.href !== location.href) poll({ url, push: true, link, focus });
    });
    globalThis.addEventListener('popstate', event => {
      if (location.hash) return;
      const url = new URL(location.href);
      if (event.state?.artifactNavigation && planLocation(url) === shownLocation) return;
      poll({ url, position: event.state?.planView });
    });
  }
  refresh.addEventListener('click', () => { failures = 0; poll(); });
  apply.addEventListener('click', () => { if (pending && !dialog.open) { render(pending, true); refresh.focus({ preventScroll: true }); } });
  const line = (label, value) => {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = label; dd.textContent = value ?? 'not recorded'; return [dt, dd];
  };
  function showReview(data) {
    review.replaceChildren();
    const scope = document.createElement('p'); scope.textContent = data.scope; review.append(scope);
    const facts = document.createElement('dl');
    facts.append(...line('Repository / approved base', `${data.repository} / ${data.base}`), ...line('Dependency target', data.dependencyTarget), ...line('Exact reviewed revision', data.revision));
    review.append(facts);
    for (const d of data.differences) {
      const item = document.createElement('details'), title = document.createElement('summary'), list = document.createElement('dl');
      title.textContent = `Milestone ${d.position} · ${d.brief} · ${d.fingerprint.before === d.fingerprint.after ? 'fingerprint unchanged' : 'fingerprint changed'}`;
      list.append(...line('Approved fingerprint', d.fingerprint.before), ...line('Candidate fingerprint', d.fingerprint.after), ...line('Harness before → after', `${d.harness.before || 'unknown'} → ${d.harness.after || 'unknown'}`));
      for (const file of d.files) {
        list.append(...line(`${file.path} · local fingerprint before → after`, `${file.inputBefore || 'not recorded'} → ${file.inputAfter || 'absent'}`));
        list.append(...line(`${file.path} · ${file.change} · base fingerprint before → after`, `${file.before || 'absent / unknown'} → ${file.after || 'absent / unknown'}`));
      }
      item.append(title, list); review.append(item);
    }
    const note = document.createElement('p'); note.textContent = 'Fingerprints include the entire brief, including any target changes. File contents are never included. Older chains may lack individual local source fingerprints. Review content differences in the repository; this view never reads them into the page. Repository, task identity and approved base cannot be replaced by recovery.';
    review.append(note);
  }
  async function post(input) {
    const data = await trackerControlPost(`${BASE}/api/chain/control?chain=${encodeURIComponent(confirmation.name)}`, input, root.dataset.token);
    if (data.requestId !== input.requestId || data.action !== input.action || data.status !== (input.stage === 'review' ? 'review' : 'applied')
      || input.stage === 'review' && (!/^[a-f0-9]{64}$/.test(data.revision || '') || !Array.isArray(data.differences))) throw new Error('Response identity unconfirmed.');
    return data;
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-chain-action]');
    if (!supported || !button || button.disabled || busy || posting || dialog.open || stale) return;
    trigger = button;
    const chain = button.closest('[data-chain]');
    confirmation = { name: chain.dataset.chain, action: button.dataset.chainAction, revision: chain.dataset.revision, requestId: crypto.randomUUID() };
    review.replaceChildren(); submit.disabled = true; close.disabled = true; posting = true;
    actionStatus.textContent = 'Reviewing saved scope and candidate approval…'; dialog.showModal();
    try {
      const data = await post({ action: confirmation.action, stage: 'review', revision: confirmation.revision, requestId: confirmation.requestId });
      if (!await lifecycle.whenActive()) return;
      confirmation.revision = data.revision; showReview(data); submit.disabled = false;
      actionStatus.textContent = 'Review ready. Nothing has been changed.';
    } catch (error) { if (await lifecycle.whenActive()) actionStatus.textContent = error.name === 'AbortError' ? 'Review timed out. Nothing was accepted; close and review again.' : error.message; }
    finally { posting = false; close.disabled = false; schedule(10000); }
  });
  submit.addEventListener('click', async () => {
    if (busy || posting || submit.disabled || stale) return;
    posting = true; submit.disabled = true; close.disabled = true;
    actionStatus.textContent = 'Applying the reviewed scope…';
    try {
      const { action, revision, requestId } = confirmation;
      await post({ action, stage: 'confirm', revision, requestId });
      if (!await lifecycle.whenActive()) return;
      actionStatus.textContent = 'Applied. Existing workers and their budgets are preserved. Close and refresh to inspect the saved chain.';
    } catch (error) {
      if (await lifecycle.whenActive()) actionStatus.textContent = error.refused ? error.message
        : `Outcome uncertain. Do not repeat this action. Close and refresh; inspect saved request ${confirmation.requestId}.`;
    } finally { posting = false; close.disabled = false; schedule(10000); }
  });
  close.addEventListener('click', () => { if (!posting) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (posting) event.preventDefault(); });
  dialog.addEventListener('close', () => { trigger?.focus({ preventScroll: true }); });
  lifecycle.onResume(() => { busy = false; poll(); });
  schedule(10000);
})();
