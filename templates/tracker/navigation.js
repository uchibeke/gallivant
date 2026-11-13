// Shared link policy and native-navigation feedback. Never fetch, mutate task
// state or automatically replay a navigation/request.
(() => {
  if (!document.querySelectorAll || !document.addEventListener) return;
  function decorate(anchor) {
    if (anchor.hasAttribute('download')) return;
    let attributes;
    try { attributes = externalLinkAttributes(new URL(anchor.getAttribute('href'), location.href).href, location.origin); }
    catch { return; }
    if (!attributes) {
      if (anchor.dataset.externalLink === 'true') {
        delete anchor.dataset.externalLink;
        if (anchor.getAttribute('target') === '_blank') anchor.removeAttribute('target');
        const rel = (anchor.getAttribute('rel') || '').split(/\s+/).filter(value => !['noopener', 'noreferrer'].includes(value));
        if (rel.length) anchor.setAttribute('rel', rel.join(' ')); else anchor.removeAttribute('rel');
        anchor.querySelector('.external-link-mark')?.remove();
        const hints = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== 'external-link-help');
        if (hints.length) anchor.setAttribute('aria-describedby', hints.join(' ')); else anchor.removeAttribute('aria-describedby');
      }
      return;
    }
    anchor.dataset.externalLink = 'true';
    anchor.setAttribute('target', attributes.target);
    anchor.setAttribute('rel', [...new Set([...(anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean), ...attributes.rel.split(' ')])].join(' '));
    anchor.setAttribute('aria-describedby', [...new Set([...(anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean), 'external-link-help'])].join(' '));
    if (!anchor.querySelector('.external-link-mark')) {
      const mark = document.createElement('span'); mark.className = 'external-link-mark'; mark.setAttribute('aria-hidden', 'true'); mark.textContent = '↗'; anchor.append(mark);
    }
  }
  function scan(root) {
    if (root.matches?.('a[href]')) decorate(root);
    for (const anchor of root.querySelectorAll?.('a[href]') || []) decorate(anchor);
  }
  scan(document);
  if (typeof MutationObserver === 'function' && document.body?.nodeType === 1) {
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes') decorate(record.target);
        else for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
  }
  const indicator = document.getElementById('page-loading'), status = document.getElementById('page-loading-status');
  if (!indicator || !status) return;
  const main = document.getElementById('main');
  let deadline = null, reveal = null, previousBusy = null;
  const feedback = trackerFeedback(status);
  const clear = () => {
    clearTimeout(deadline); clearTimeout(reveal); deadline = reveal = null; indicator.hidden = true;
    if (main?.dataset.navigationPending) {
      delete main.dataset.navigationPending;
      if (previousBusy === null) main.removeAttribute('aria-busy'); else main.setAttribute('aria-busy', previousBusy);
    }
  };
  function begin(label) {
    clear(); previousBusy = main?.getAttribute('aria-busy') ?? null;
    if (main) { main.dataset.navigationPending = 'true'; main.setAttribute('aria-busy', 'true'); }
    feedback.show(label, { pending: true }); status.dataset.skeleton = 'true';
    // Fast native navigations need no transient panel. A zero-height host keeps
    // slower progress visible without shifting the header or current content.
    reveal = setTimeout(() => { indicator.hidden = false; }, 200);
    deadline = setTimeout(() => {
      delete status.dataset.skeleton;
      feedback.show('This view is taking longer to open. You can keep using the current page.', { state: 'pending' });
    }, 10000);
  }
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute('download')) return;
    decorate(link);
    if (link.target && link.target !== '_self') return;
    const target = new URL(link.href, location.href);
    if (target.origin !== location.origin || !['http:', 'https:'].includes(target.protocol)) return;
    if (target.pathname === location.pathname && target.search === location.search && target.hash) return;
    const name = (link.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    queueMicrotask(() => { if (!event.defaultPrevented) begin(name ? `Opening ${name}…` : 'Opening view…'); });
  });
  document.addEventListener('submit', event => {
    const form = event.target;
    if (form.method?.toLowerCase() !== 'get' || form.target && form.target !== '_self') return;
    if (new URL(form.action, location.href).origin !== location.origin) return;
    queueMicrotask(() => { if (!event.defaultPrevented) begin('Loading filtered results…'); });
  });
  document.getElementById('page-loading-dismiss')?.addEventListener('click', clear);
  globalThis.addEventListener?.('pagehide', clear);
  globalThis.addEventListener?.('pageshow', clear);
})();
