// One dialog and request lifecycle for Task, intake, Plans and review.
(() => {
  const dialog = typeof document !== 'undefined' && document.getElementById?.('artifact-viewer');
  if (!dialog) return;
  const $ = name => document.getElementById('artifact-' + name);
  const header = $('title'), meta = $('meta'), body = $('body'), status = $('status'), loading = $('loading');
  const close = $('close'), preview = $('preview'), source = $('source'), retry = $('retry-file'), scroll = $('scroll');
  const copySource = $('copy-source'), copyLink = $('copy-link'), feedback = $('feedback');
  const selectors = ['artifact', 'artifactAt', 'fileView'];
  const scope = ['id', 'task', 'plan', 'node', 'chain', 'milestone'];
  const readFields = [...scope, 'artifact', 'artifactAt'];
  let trigger, request, stopCheck, current, renderedView, activeKey;

  const element = (tag, text, attributes = {}) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
    return node;
  };
  const selectedView = () => new URL(location.href).searchParams.get('fileView') === 'source' ? 'source' : 'preview';
  const selectorKey = url => JSON.stringify(readFields.map(key => url.searchParams.get(key)));
  const push = (url, opening = false) => {
    const depth = opening ? 1 : Number(history.state?.artifactDepth || 0);
    if (opening) history.replaceState({ ...history.state, artifactNavigation: true }, '', location.href);
    history.pushState({ ...history.state, artifactNavigation: true, artifactDepth: depth ? depth + Number(!opening) : 0 }, '', url);
    sync();
  };
  const fileUrl = (ref, base = location.href) => {
    const url = new URL(base, location.href);
    url.searchParams.set('artifact', ref);
    url.searchParams.delete('artifactAt');
    url.hash = '';
    return url;
  };
  const clear = () => {
    current = renderedView = null;
    header.textContent = 'File viewer';
    meta.replaceChildren(); meta.hidden = true;
    body.replaceChildren();
    status.replaceChildren();
    copySource.disabled = true; retry.hidden = true;
    feedback.textContent = '';
  };
  function pin(data) {
    if (data.state !== 'ready') return;
    const url = new URL(location.href);
    url.searchParams.set('artifact', data.file.ref);
    url.searchParams.set('artifactAt', data.digest);
    activeKey = selectorKey(url);
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }
  function facts(rows) {
    const list = element('dl', null, { class: 'artifact-facts' });
    for (const [label, value] of rows) {
      if (value == null) continue;
      list.append(element('dt', label), element('dd', value));
    }
    return list;
  }
  function field(label, control) {
    const row = element('div', null, { class: 'artifact-field' });
    row.append(element('label', label, { for: control.id }), control);
    return row;
  }
  function showMeta(data) {
    header.textContent = data.file.path.split('/').at(-1);
    const revision = String(data.revision ?? 'Unrecorded');
    const label = revision.replace(/\b[a-f0-9]{64}\b/g, digest => digest.slice(0, 12));
    const nodes = [element('p', `${data.file.origin} · ${label}`, { class: 'note artifact-origin' })];
    if (data.detail) nodes.push(element('p', data.detail, { class: 'note' }));
    if (data.files.length > 1) {
      const select = element('select', null, { id: 'artifact-file' });
      for (const file of data.files) select.append(element('option', `${file.role} · ${file.path}`, { value: file.ref }));
      select.value = data.file.ref;
      select.addEventListener('change', () => push(fileUrl(select.value)));
      nodes.unshift(field('File', select));
    }
    const details = element('details', null, { class: 'artifact-provenance' });
    details.append(element('summary', 'File provenance'), facts([
      ['Path', data.file.path], ['Revision', revision],
      ['Content SHA-256', data.digest === data.revision ? null : data.digest ?? data.file.digest],
      ['Carried source digest', data.sourceDigest],
    ]));
    if (data.files.length > 1) {
      const list = element('ul');
      for (const file of data.files) {
        const item = element('li');
        item.append(element('strong', file.path), facts([
          ['Role', file.role], ['Origin', file.origin], ['Approved SHA-256', file.digest ?? 'Unrecorded'],
          ['Approved base SHA-256', Object.hasOwn(file, 'baseDigest') ? file.baseDigest ?? 'Absent' : null],
        ]));
        list.append(item);
      }
      details.append(list);
    }
    nodes.push(details);
    meta.replaceChildren(...nodes); meta.hidden = false;
  }
  function jump(id) {
    const heading = document.getElementById(id);
    if (!heading || !body.contains(heading)) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: 'start' });
  }
  function showView() {
    const view = selectedView();
    preview.setAttribute('aria-pressed', String(view === 'preview'));
    source.setAttribute('aria-pressed', String(view === 'source'));
    if (current?.state !== 'ready' || view === renderedView) return;
    renderedView = view;
    body.replaceChildren();
    if (view === 'preview' && current.preview) {
      const { html, headings } = current.preview;
      if (headings.length) {
        const select = element('select', null, { id: 'artifact-outline' });
        select.append(element('option', 'Choose a heading', { value: '' }));
        for (const heading of headings) select.append(element('option', heading.label, { value: heading.id }));
        select.addEventListener('change', () => jump(select.value));
        body.append(field('Jump to heading', select));
      }
      const article = element('article', null, { class: 'artifact-document', 'aria-label': 'Markdown preview' });
      // The service emits HTML only from its strict Markdown renderer.
      article.innerHTML = html;
      for (const block of article.querySelectorAll('pre')) {
        block.tabIndex = 0; block.setAttribute('role', 'region'); block.setAttribute('aria-label', 'Code block');
      }
      for (const table of article.querySelectorAll('table')) {
        const region = element('div', null, { class: 'artifact-table', tabindex: '0', role: 'region', 'aria-label': 'Document table' });
        table.before(region); region.append(table);
      }
      body.append(article);
    } else {
      const raw = element('pre', current.text, { class: `artifact-text artifact-${view}-text`, tabindex: '0',
        role: 'region', 'aria-label': view === 'source' ? 'Original source' : 'Text preview' });
      body.append(raw);
    }
  }

  async function load({ revalidate = false, focusFile = false } = {}) {
    request?.abort();
    stopCheck?.();
    const url = new URL(location.href), guard = lifecycle.guard(), key = selectorKey(url);
    const pending = request = new AbortController();
    const active = () => guard() && request === pending && dialog.open && selectorKey(new URL(location.href)) === key;
    if (!revalidate) {
      if (focusFile) close.focus();
      clear(); loading.hidden = false; scroll.scrollTop = 0;
    }
    const params = new URLSearchParams();
    for (const name of readFields) {
      const value = url.searchParams.get(name);
      if (value) params.set(name, value);
    }
    try {
      const data = await lifecycle.read(`${BASE}/api/artifact?${params}`, 'File read unavailable', 8000, pending.signal);
      if (!active()) return;
      loading.hidden = true;
      pin(data);
      if (revalidate && current && data.digest === current.digest && JSON.stringify(data.file) === JSON.stringify(current.file) &&
          data.state === current.state && data.detail === current.detail) return;
      clear(); current = data;
      showMeta(data);
      if (data.state === 'ready') {
        copySource.disabled = false; showView();
      } else {
        status.append(element('p', data.message), ...(['unavailable', 'changed'].includes(data.state) ? [element('p', data.recovery)] : []));
        retry.hidden = !['unavailable', 'changed'].includes(data.state);
      }
    } catch (error) {
      if (!active()) return;
      loading.hidden = true; clear();
      status.textContent = [401, 403, 404].includes(error.status) ?
        'This file is unavailable within this workspace. Reopen it from an authorized workspace or start a fresh plan review.' :
        'The file could not be loaded. Check the connection and retry.';
      retry.hidden = [401, 403].includes(error.status);
    } finally {
      if (request === pending && dialog.open) {
        request = null;
        if (guard()) stopCheck = lifecycle.schedule(() => load({ revalidate: true }), 10_000);
        if (focusFile && document.activeElement === close) $('file')?.focus({ preventScroll: true });
      }
    }
  }

  function sync() {
    const url = new URL(location.href), key = selectorKey(url);
    if (!url.searchParams.has('artifact')) {
      if (dialog.open) {
        request?.abort(); request = null; stopCheck?.();
        activeKey = null; clear(); dialog.close();
        if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
        else document.querySelector('[data-artifact-link]')?.focus({ preventScroll: true });
        trigger = null;
      }
      return;
    }
    if (!dialog.open) { dialog.showModal(); close.focus(); }
    showView();
    if (key !== activeKey) {
      activeKey = key;
      load({ focusFile: document.activeElement?.id === 'artifact-file' });
    }
  }
  function dismiss() {
    const depth = Number(history.state?.artifactDepth || 0);
    if (depth > 0) { history.go(-depth); return; }
    const url = new URL(location.href);
    for (const name of selectors) url.searchParams.delete(name);
    history.replaceState(history.state, '', url); sync();
  }
  function switchView(view) {
    if (selectedView() === view) return;
    const url = new URL(location.href);
    if (view === 'source') url.searchParams.set('fileView', view);
    else url.searchParams.delete('fileView');
    push(url);
  }
  async function copy(value, kind) {
    try {
      await navigator.clipboard.writeText(value);
      if (dialog.open) feedback.textContent = `${kind} copied.`;
    } catch { if (dialog.open) feedback.textContent = `Clipboard unavailable. ${kind === 'Link' ? 'Copy the URL from the address bar.' : 'Open Source and select the text to copy it.'}`; }
  }
  document.addEventListener('click', event => {
    const heading = event.target.closest('[data-artifact-heading]');
    if (heading && dialog.contains(heading)) { event.preventDefault(); jump(heading.dataset.artifactHeading); return; }
    const link = event.target.closest('[data-artifact-link]');
    if (event.defaultPrevented || !link || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== location.pathname) return;
    event.preventDefault();
    trigger = link; push(url, !dialog.open);
  });
  close.addEventListener('click', dismiss);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  retry.addEventListener('click', () => { close.focus(); load(); });
  preview.addEventListener('click', () => switchView('preview'));
  source.addEventListener('click', () => switchView('source'));
  copySource.addEventListener('click', () => { if (current?.state === 'ready') copy(current.text, 'Source'); });
  copyLink.addEventListener('click', () => {
    const url = new URL(location.pathname, location.origin), currentUrl = new URL(location.href);
    for (const name of [...scope, 'run', 'theme', ...selectors]) {
      const value = currentUrl.searchParams.get(name);
      if (value) url.searchParams.set(name, value);
    }
    copy(url.href, 'Link');
  });
  globalThis.addEventListener('popstate', sync);
  globalThis.addEventListener('pagehide', clear);
  globalThis.addEventListener('workspace-evidence-state', event => {
    if (dialog.open && event.detail === 'unavailable') load();
  });
  document.addEventListener('visibilitychange', () => {
    if (dialog.open && !document.hidden) load();
  });
  lifecycle.onResume(() => { if (dialog.open) load(); });
  sync();
})();
