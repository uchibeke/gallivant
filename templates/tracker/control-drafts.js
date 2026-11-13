// Draft checkpoints are synchronous (including pagehide). Request identities live
// separately: only an origin-wide Web Lock may claim, acknowledge or settle them.
function taskControlDrafts(instance, task) {
  const storageKey = "task-control-drafts-v1", requestsKey = "task-control-requests-v1", key = JSON.stringify([instance, task]);
  const lifetime = 7 * 24 * 60 * 60 * 1000, limit = 20;
  const read = () => {
    const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.filter(row => row && typeof row.key === "string" && Number.isFinite(row.updated)).slice(-limit) : [];
  };
  const validOperation = op => op && /^[A-Za-z0-9_-]{1,128}$/.test(op.requestId) &&
    ["message", "resume", "recheck", "cancel"].includes(op.action) && typeof op.note === "string" && op.note.length <= 4000 &&
    typeof op.interrupt === "boolean" && typeof op.previousId === "string";
  const fields = op => ({ requestId: op.requestId, action: op.action, note: op.note, interrupt: op.interrupt,
    previousId: op.previousId, acknowledged: op.acknowledged === true });
  // An existing registry, even when empty, supersedes legacy embedded identities.
  // The first locked write migrates all legacy identities atomically.
  const requests = () => {
    const saved = localStorage.getItem(requestsKey);
    return (saved === null || saved === undefined ? read() : JSON.parse(saved))
      .filter(row => row && typeof row.key === "string" && validOperation(row.operation))
      .map(row => ({ key: row.key, operation: fields(row.operation) }));
  };
  let error = "";
  const unavailable = "Browser storage unavailable or full. Enable local storage or open tasks with saved requests (including closed tasks) and Check request status before sending.";
  const change = async (kind, operation) => {
    error = unavailable;
    if (!globalThis.navigator?.locks) {
      error = "This browser cannot coordinate requests across tabs. Use a browser with Web Locks support on this local server before sending.";
      throw new Error(error);
    }
    if (kind === "claim" && validOperation(operation) && redact(operation.note) !== operation.note) {
      error = "A credential pattern was detected. Remove credentials before saving or sending.";
      throw new Error(error);
    }
    try {
      return await globalThis.navigator.locks.request(requestsKey, () => {
        const rows = requests(), index = rows.findIndex(row => row.key === key), current = rows[index]?.operation;
        if (kind === "claim" && !current) {
          if (rows.length >= limit || !validOperation(operation)) throw new Error(unavailable);
          rows.push({ key, operation: fields(operation) });
        } else if (current?.requestId === operation.requestId) {
          if (kind === "settle") rows.splice(index, 1);
          else if (kind === "acknowledge") current.acknowledged = true;
        }
        localStorage.setItem(requestsKey, JSON.stringify(rows));
        return rows.find(row => row.key === key)?.operation || null;
      });
    } catch { throw new Error(error); }
  };
  let saved = null, operation = null;
  try { saved = read().find(row => row.key === key); operation = requests().find(row => row.key === key)?.operation || null; }
  catch { error = unavailable; }
  let lastValue = saved && Date.now() - saved.updated < lifetime ? saved.value || "" : "";
  return {
    get error() { return error; },
    get operation() { return requests().find(row => row.key === key)?.operation || null; },
    changed: event => event.key === requestsKey || event.key === storageKey || event.key === null,
    claim: operation => change("claim", operation),
    acknowledge: operation => change("acknowledge", operation),
    settle: requestId => change("settle", { requestId }),
    initial: saved && Date.now() - saved.updated < lifetime && typeof saved.value === "string"
      ? { ...saved, value: saved.value.slice(0, 4000), operation } : { operation },
    save(value, { ifValue } = {}) {
      try {
        error = unavailable;
        const sensitive = redact(value.value) !== value.value;
        const legacy = localStorage.getItem(requestsKey) == null;
        const previous = read(), currentValue = previous.find(row => row.key === key)?.value || "";
        // Poll/blur/pagehide checkpoints must not overwrite a newer edit in a
        // competing tab. Acceptance only clears the draft that was submitted.
        const stale = ifValue !== undefined && currentValue !== ifValue
          || value.value === lastValue && currentValue !== lastValue;
        lastValue = value.value;
        if (stale && !sensitive) return true;
        // Ordinary saves cannot create, replace or erase an unresolved identity.
        const retained = legacy ? previous.find(row => row.key === key)?.operation : null;
        let rows = previous.filter(row => row.key !== key && (legacy && row.operation || Date.now() - row.updated < lifetime));
        if (value.value && !sensitive || retained) {
          if (rows.length >= limit) {
            const evict = rows.findIndex(row => !legacy || !row.operation);
            if (evict < 0) return false;
            rows.splice(evict, 1);
          }
          rows.push({ key, updated: Date.now(), value: sensitive ? "" : value.value.slice(0, 4000), start: value.start, end: value.end,
            direction: value.direction, top: value.top, pageY: value.pageY, focused: value.focused,
            ...(retained ? { operation: retained } : {}) });
        }
        if (rows.length) localStorage.setItem(storageKey, JSON.stringify(rows));
        else localStorage.removeItem(storageKey);
        if (sensitive) error = "A credential pattern was detected. This draft stays only on this page; remove credentials before saving or sending.";
        return !sensitive;
      } catch { return false; }
    },
  };
}
