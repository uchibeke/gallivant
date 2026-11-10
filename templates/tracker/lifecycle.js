// Browser controllers share cancellation and bounded, non-overlapping timers.
function trackerLifecycle() {
  let stopped = false;
  const timers = new Set(), requests = new Set();
  const schedule = (work, delay) => {
    if (stopped) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped) return;
      if (document.hidden) { schedule(work, delay); return; }
      return work();
    }, delay);
    timers.add(timer);
  };
  const read = async (url, failure) => {
    const request = new AbortController();
    requests.add(request);
    try {
      const response = await fetch(url, { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error(failure);
      return await response.json();
    }
    finally { requests.delete(request); }
  };
  const stop = () => {
    stopped = true;
    timers.forEach(timer => clearTimeout(timer)); timers.clear();
    requests.forEach(request => request.abort()); requests.clear();
  };
  globalThis.addEventListener?.("pagehide", stop, { once: true });
  // A restored back/forward-cache document reconnects through its normal load.
  globalThis.addEventListener?.("pageshow", event => { if (event.persisted) location.reload(); });
  return { schedule, read, active: () => !stopped };
}
