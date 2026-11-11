// Browser-only drafts and unresolved delivery identities. Never store a control
// token, URL, transcript or diagnostic. Unresolved identities are not evicted.
function taskControlDrafts(instance, task) {
  const storageKey = "task-control-drafts-v1", key = JSON.stringify([instance, task]);
  const lifetime = 7 * 24 * 60 * 60 * 1000, limit = 20;
  const read = () => {
    const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.filter(row => row && typeof row.key === "string" && Number.isFinite(row.updated)).slice(-limit) : [];
  };
  const validOperation = op => op && /^[A-Za-z0-9_-]{1,128}$/.test(op.requestId) &&
    ["message", "resume", "recheck", "cancel"].includes(op.action) && typeof op.note === "string" && op.note.length <= 4000 &&
    typeof op.interrupt === "boolean" && typeof op.previousId === "string";
  let saved = null, error = "";
  try { saved = read().find(row => row.key === key); } catch { /* Storage may be disabled. Retain work in this page. */ }
  const operation = validOperation(saved?.operation) ? saved.operation : null;
  return {
    get error() { return error; },
    initial: saved && Date.now() - saved.updated < lifetime && typeof saved.value === "string"
      ? { ...saved, value: saved.value.slice(0, 4000), operation } : { operation },
    save(value) {
      try {
        error = "Browser storage unavailable or full. Keep this page open; enable local storage or resolve saved requests before sending.";
        if (redact(value.value) !== value.value || value.operation && redact(value.operation.note) !== value.operation.note) {
          error = "A credential pattern was detected. This draft stays only on this page; remove credentials before saving or sending.";
          // Erase any prior persisted draft, but retain an existing unresolved identity.
          const rows = read().map(row => row.key === key ? { ...row, value: "" } : row).filter(row => row.value || row.operation);
          if (rows.length) localStorage.setItem(storageKey, JSON.stringify(rows));
          else localStorage.removeItem(storageKey);
          return false;
        }
        let rows = read().filter(row => row.key !== key && (row.operation || Date.now() - row.updated < lifetime));
        if (value.value || value.operation) {
          if (rows.length >= limit) {
            const evict = rows.findIndex(row => !row.operation);
            if (evict < 0) return false;
            rows.splice(evict, 1);
          }
          // Whitelist persisted fields; DOM attributes include credentials.
          rows.push({ key, updated: Date.now(), value: value.value.slice(0, 4000), start: value.start, end: value.end,
            direction: value.direction, top: value.top, pageY: value.pageY, focused: value.focused,
            operation: value.operation ? { requestId: value.operation.requestId, action: value.operation.action,
              note: value.operation.note, interrupt: value.operation.interrupt, previousId: value.operation.previousId, acknowledged: value.operation.acknowledged === true } : null });
        }
        if (rows.length) localStorage.setItem(storageKey, JSON.stringify(rows));
        else localStorage.removeItem(storageKey);
        return true;
      } catch { return false; }
    },
  };
}
