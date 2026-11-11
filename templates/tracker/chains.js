// One bounded lifecycle for this surface. No per-milestone reads or event streams.
(() => {
  const root = document.querySelector?.('[data-chains]');
  if (!root) return;
  const status = document.getElementById('chains-status'), refresh = document.getElementById('chains-refresh');
  const apply = document.getElementById('chains-apply'), dialog = document.getElementById('chain-confirm');
  const review = document.getElementById('chain-review'), actionStatus = document.getElementById('chain-action-status');
  const submit = document.getElementById('chain-submit'), close = document.getElementById('chain-close');
  let busy = false, failures = 0, cancelTimer, pending, confirmation, posting = false, trigger;
  let observed = status.textContent;
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
    return dialog.open || document.getElementById('chains-results').contains(document.activeElement)
      || selection && !selection.isCollapsed && (root.contains(selection.anchorNode) || root.contains(selection.focusNode))
      || document.querySelector('#chains-results details[open]') || scrollY > root.offsetTop;
  };
  function render(data, force = false) {
    if (typeof data?.content !== 'string' || !Number.isFinite(Date.parse(data.observedAt))) throw new Error('Invalid chain snapshot');
    const next = new DOMParser().parseFromString(data.content, 'text/html').getElementById('chains-results');
    if (!next) throw new Error('Invalid chain snapshot');
    if (!force && held()) { pending = data; apply.hidden = false; status.textContent = `Updates ready · ${observed}. Apply when ready.`; return; }
    const theme = new URL(location.href).searchParams.get('theme');
    for (const link of next.querySelectorAll('a[href]')) {
      const url = new URL(link.href);
      if (url.origin !== location.origin) continue;
      if (theme) url.searchParams.set('theme', theme); else url.searchParams.delete('theme');
      link.href = url.pathname + url.search;
    }
    document.getElementById('chains-results').replaceWith(next); enforceSupport();
    pending = null; apply.hidden = true; observed = `snapshot observed ${data.observedAt}`;
    status.textContent = `Current · ${observed}`;
  }
  const schedule = delay => { cancelTimer?.(); cancelTimer = lifecycle.schedule(poll, delay); };
  async function poll() {
    if (busy || posting) return;
    busy = true; refresh.disabled = true; cancelTimer?.();
    const active = lifecycle.guard();
    try {
      const data = await lifecycle.read(`${BASE}/api/chains${location.search}`, 'Chain snapshot unavailable', 8000);
      if (!active()) return;
      render(data); failures = 0;
    } catch {
      if (!active()) return;
      failures++; pending = null; apply.hidden = true;
      status.textContent = `${failures > 1 ? 'Disconnected' : 'Stale'} · last good ${observed}. ${failures < 3 ? 'Retry scheduled.' : 'Automatic retry paused; use Refresh chains.'}`;
    } finally {
      if (active()) { busy = false; refresh.disabled = false; if (failures < 3) schedule(failures ? Math.min(60000, 10000 * 2 ** failures) : 10000); }
    }
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
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`${BASE}/api/chain/control?chain=${encodeURIComponent(confirmation.name)}`, {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Gallivant-Token': root.dataset.token }, body: JSON.stringify(input),
      });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || 'Request refused. Refresh and review again.'), { refused: response.status >= 400 && response.status < 500 });
      if (data.requestId !== input.requestId || data.action !== input.action || data.status !== (input.stage === 'review' ? 'review' : 'applied')
        || input.stage === 'review' && (!/^[a-f0-9]{64}$/.test(data.revision || '') || !Array.isArray(data.differences))) throw new Error('Response identity unconfirmed.');
      return data;
    } finally { clearTimeout(timer); }
  }
  root.addEventListener('click', async event => {
    const button = event.target.closest('[data-chain-action]');
    if (!supported || !button || button.disabled || posting || dialog.open) return;
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
    if (posting || submit.disabled) return;
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
