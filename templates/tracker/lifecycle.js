// Browser controllers share cancellation and bounded, non-overlapping timers.
function trackerLifecycle() {
  let stopped = false, cached = false, generation = 0;
  const timers = new Set(), requests = new Set();
  const resumes = [], waiting = new Set();
  const schedule = (work, delay) => {
    if (stopped) return;
    let timer;
    const arm = () => {
      timer = setTimeout(() => {
        timers.delete(timer);
        if (stopped) return;
        if (document.hidden) { arm(); return; }
        return work();
      }, delay);
      timers.add(timer);
    };
    arm();
    return () => { clearTimeout(timer); timers.delete(timer); };
  };
  const read = async (url, failure, timeoutMs = 10_000) => {
    const request = new AbortController();
    requests.add(request);
    const deadline = setTimeout(() => request.abort(), timeoutMs);
    try {
      const response = await fetch(url, { cache: "no-store", signal: request.signal });
      if (!response.ok) throw new Error(failure);
      return await response.json();
    }
    finally { clearTimeout(deadline); requests.delete(request); }
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
