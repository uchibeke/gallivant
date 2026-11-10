// Saved instants only. In particular, null, empty strings and booleans are not now.
export function instant(value) {
  if (!(typeof value === "number" && Number.isFinite(value)) && !(typeof value === "string" && value.trim())) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function meaningfulActivity(entry = {}, run = null) {
  const candidates = [["activity_at", entry.activity_at], ["last.at", entry.last?.at],
    ["created_at", entry.created_at], ["firstPartyReview.startedAt", entry.firstPartyReview?.startedAt],
    ["firstPartyReview.completedAt", entry.firstPartyReview?.completedAt],
    ["run.startedAt", run?.id === entry.last?.run ? run?.startedAt : null]];
  const latest = candidates.map(([source, value]) => ({ source, at: instant(value) }))
    .filter(item => item.at).sort((a, b) => b.at.localeCompare(a.at))[0];
  return latest || { source: null, at: null };
}

export function attemptPresentation(run, { entry = null, maxIterations = null, now = null } = {}) {
  const startedAt = instant(run?.startedAt), endedAt = instant(run?.endedAt), observedNow = instant(now);
  const running = run?.running === true && run?.endedAt == null && run?.exit == null;
  const end = running ? observedNow : endedAt;
  const ms = startedAt && end ? Date.parse(end) - Date.parse(startedAt) : null;
  const valid = Number.isFinite(ms) && ms >= 0;
  const matching = Boolean(run?.id && run.id === entry?.last?.run);
  return { id: typeof run?.id === "string" ? run.id.slice(0, 128) : null, startedAt, endedAt,
    duration: { kind: valid ? running ? "elapsed" : "ended" : "unknown", ms: valid ? ms : null, source: run ? "run.startedAt/endedAt" : null },
    rounds: { used: matching && Number.isSafeInteger(entry.iteration) && entry.iteration >= 0 ? entry.iteration : null,
      limit: matching && Number.isSafeInteger(maxIterations) && maxIterations > 0 ? maxIterations : null,
      source: matching ? "entry.iteration/config.max_iterations" : null } };
}

export function durationText(duration) {
  if (duration?.ms == null) return "unknown";
  const seconds = Math.floor(duration.ms / 1000);
  const value = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${value}${duration.kind === "elapsed" ? " elapsed" : ""}`;
}
