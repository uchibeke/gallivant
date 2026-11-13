// Presentation only. Callers own request identities, authority and retries.
// Reusable for navigation, submissions and coordinator request observations.
function trackerFeedback(status, { mirror = null, region = null } = {}) {
  return {
    show(text, { state = 'current', pending = false, detail = '', button = null, label = null } = {}) {
      if (!status) return;
      if (status.textContent !== text) status.textContent = text;
      status.dataset.state = state;
      status.dataset.busy = String(pending);
      status.classList?.add('feedback-status');
      status.setAttribute?.('aria-atomic', 'true');
      if (mirror) {
        mirror.hidden = false;
        mirror.dataset.state = state;
        mirror.dataset.busy = String(pending);
        const message = mirror.querySelector('[data-feedback-message]');
        const description = mirror.querySelector('[data-feedback-detail]');
        if (message && message.textContent !== text) message.textContent = text;
        if (description) { if (description.textContent !== detail) description.textContent = detail; description.hidden = !detail; }
      }
      region?.setAttribute?.('aria-busy', String(pending));
      if (button) {
        button.setAttribute('aria-busy', String(pending));
        if (label) { button.dataset.pendingLabel = 'true'; button.textContent = label; }
      }
    },
  };
}
