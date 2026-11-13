// Browser controllers share cancellation and bounded, non-overlapping timers.
function trackerLifecycle() {
  let stopped = false, cached = false, generation = 0;
  const timers = new Set(), requests = new Set();
  const suspended = () => document.hidden || globalThis.navigator?.onLine === false;
  const resumes = [], waiting = new Set();
  const schedule = (work, delay) => {
    if (stopped) return;
    const task = { timer: null, due: Date.now() + delay, arm: null };
    const arm = task.arm = () => {
      if (suspended() || stopped) return;
      task.timer = setTimeout(() => {
        task.timer = null;
        if (stopped) return;
        if (suspended()) return;
        timers.delete(task);
        return work();
      }, Math.max(0, task.due - Date.now()));
    };
    timers.add(task);
    arm();
    return () => { clearTimeout(task.timer); timers.delete(task); };
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
    timers.forEach(task => clearTimeout(task.timer)); timers.clear();
    requests.forEach(request => request.abort()); requests.clear();
    if (!cached) { waiting.forEach(resolve => resolve(false)); waiting.clear(); }
  };
  globalThis.addEventListener?.("pagehide", stop);
  const visibility = () => {
    for (const task of timers) {
      clearTimeout(task.timer); task.timer = null;
      if (!suspended() && !stopped) task.arm();
    }
  };
  document.addEventListener?.("visibilitychange", visibility);
  globalThis.addEventListener?.("online", visibility);
  globalThis.addEventListener?.("offline", visibility);
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
