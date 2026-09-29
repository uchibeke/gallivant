// Time helpers. The daemon and the tests both go through `clock` so a test can move time forward without sleeping.

export const nowIso = (clock = Date) => new Date(clock.now()).toISOString();

/** Filesystem-safe timestamp for run folder names: 2026-09-24T02-04-00-123 */
export const stamp = (clock = Date) => new Date(clock.now()).toISOString().replace(/[:.]/g, "-").replace("Z", "");

export const minutes = n => n * 60_000;
export const hours = n => n * 3_600_000;

export const isAfter = (iso, sinceIso) => !!iso && (!sinceIso || Date.parse(iso) > Date.parse(sinceIso));

/**
 * Inclusive of the boundary itself. GitHub stamps events to the second, so two that arrive in the same second
 * carry the same timestamp; a cursor set to one of them would hide the other under a strict comparison. Callers
 * that use this pair the cursor with a list of ids already handled at that instant.
 */
export const isAtOrAfter = (iso, sinceIso) => !!iso && (!sinceIso || Date.parse(iso) >= Date.parse(sinceIso));

/** An ISO instant with its milliseconds dropped, so it never sorts after a GitHub timestamp in the same second. */
export const floorSecond = iso => (iso ? new Date(Math.floor(Date.parse(iso) / 1000) * 1000).toISOString() : iso);

export const later = (a, b) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
export const earlier = (a, b) => (!a ? b : !b ? a : Date.parse(a) <= Date.parse(b) ? a : b);

/** "3m ago", "2h ago", "just now". */
export function ago(iso, clock = Date) {
  if (!iso) return "never";
  const ms = clock.now() - Date.parse(iso);
  if (ms < 45_000) return "just now";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
