// One bounded URL contract shared by navigation and existing view filters.
export const OVERVIEW_PAGE_SIZE = 25;
export const OVERVIEW_FILTERS = ["q", "repo", "phase", "harness", "attention", "chain"];
// Bounded strings only; filters are selectors, never state mutations or path inputs.
export function overviewQuery(query = {}) {
  const result = {};
  for (const key of OVERVIEW_FILTERS) if (typeof query[key] === "string" && query[key].trim()) result[key] = query[key].trim().slice(0, 256);
  if (["dark", "light"].includes(query.theme)) result.theme = query.theme;
  if (query.by === "harness") result.by = "harness";
  const offset = Number(query.offset);
  if (Number.isSafeInteger(offset) && offset > 0) result.offset = String(Math.floor(offset / OVERVIEW_PAGE_SIZE) * OVERVIEW_PAGE_SIZE);
  return result;
}

export const number = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
export function chainQuery(query = {}) {
  const result = {};
  for (const key of ["chain", "cq", "cs", "milestone"]) if (typeof query[key] === "string" && query[key]) result[key] = query[key].slice(0, 256);
  if (["light", "dark"].includes(query.theme)) result.theme = query.theme;
  for (const key of ["co", "mo"]) if (query[key] != null && /^\d+$/.test(String(query[key]))) result[key] = String(number(query[key]));
  return result;
}

export function workspaceQuery(query = {}) {
  return { ...overviewQuery(query), ...chainQuery(query),
    ...(typeof query.listq === "string" && query.listq ? { listq: query.listq.slice(0, 256) } : {}) };
}
