// GitHub-facing names live here. Read old spellings indefinitely; write only the neutral format.
export const BRANCH_PREFIX = "work/";
export const BRANCH_PREFIXES = [BRANCH_PREFIX, "gallivant/"];
export const BLOCK_OPEN = "<!-- work-session";
export const BLOCK_OPENS = [BLOCK_OPEN, "<!-- gallivant"];
export const RECEIPT_TAG = "work-attestations";
export const RECEIPT_TAGS = [RECEIPT_TAG, "gallivant-attestations"];
export const ROUND_MARKER = "<!-- work-round -->";
export const NUDGE_MARKER = "<!-- work-nudge -->";
export const RESET_MARKER = "<!-- work-reset -->";
export const MARKER_ALIASES = new Map([
  [ROUND_MARKER, [ROUND_MARKER, "<!-- gallivant round -->"]],
  [NUDGE_MARKER, [NUDGE_MARKER, "<!-- gallivant nudge -->"]],
  [RESET_MARKER, [RESET_MARKER, "<!-- gallivant reset -->"]],
]);
export const READY_LABEL = "status:ready-for-review";
export const NEEDS_LABEL = "status:needs-attention";
export const LABEL_ALIASES = new Map([
  [READY_LABEL, [READY_LABEL, "gallivant:ready-for-human"]],
  [NEEDS_LABEL, [NEEDS_LABEL, "gallivant:needs-human"]],
]);

export const markerAliases = marker => [...MARKER_ALIASES.values()].find(names => names.includes(marker)) ?? [marker];
export const hasMarker = (body, marker) => markerAliases(marker).some(value => String(body || "").includes(value));
export const labelAliases = label => [...LABEL_ALIASES.values()].find(names => names.includes(label)) ?? [label];

/** GitHub labels arrive as objects from GraphQL or strings from local callers. Only our two legacy aliases count. */
export const hasLegacyStatusLabels = labels => (labels ?? []).some(label => {
  const name = typeof label === "string" ? label : label?.name;
  return typeof name === "string" && [...LABEL_ALIASES.values()].some(([, ...legacy]) => legacy.includes(name.toLowerCase()));
});
