// Browser controllers share cancellation and bounded, non-overlapping timers.
function trackerLifecycle() {
  let stopped = false, cached = false, generation = 0;
  const timers = new Set(), requests = new Set();
  const resumes = [], waiting = new Set();
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
  const stop = event => {
    stopped = true;
    cached = event?.persisted === true;
    generation++;
    timers.forEach(timer => clearTimeout(timer)); timers.clear();
    requests.forEach(request => request.abort()); requests.clear();
    if (!cached) { waiting.forEach(resolve => resolve(false)); waiting.clear(); }
  };
  globalThis.addEventListener?.("pagehide", stop);
  globalThis.addEventListener?.("pageshow", event => {
    if (!event.persisted || !stopped || !cached) return;
    stopped = cached = false;
    waiting.forEach(resolve => resolve(true)); waiting.clear();
    resumes.forEach(work => work());
  });
  return {
    schedule, read,
    // An aborted read must stay stale even if its rejection arrives after restore.
    guard: () => { const started = generation; return () => !stopped && started === generation; },
    onResume: work => resumes.push(work),
    // A POST is never replayed: settle its original response after restoration.
    whenActive: () => stopped && cached ? new Promise(resolve => waiting.add(resolve)) : Promise.resolve(!stopped),
  };
}
