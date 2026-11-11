import { esc, icon, field, select, menu, tabs } from "./primitives.mjs";

/**
 * The stylesheet and the script are served from their own routes rather than inlined, so `script-src 'self'` needs
 * neither 'unsafe-inline' nor a per-response nonce. A nonce would mean the HTML could never be cached and every page
 * would have to thread the value through; a hash would have to be recomputed whenever the file changes and would
 * drift silently. Two files on two routes is the version that cannot rot.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  // Framing is the point: this is meant to sit in a dashboard. It is bound to 127.0.0.1, so the only page that can
  // frame it is one already running on this machine.
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*",
].join("; ");

/**
 * One page shell. `theme` is dark, light or null; null leaves the choice to `prefers-color-scheme`.
 *
 * `base` is the path this tracker is mounted at, empty when it owns the origin and something like `/gallivant` when
 * a host server delegates a prefix to it. It is published on <body data-base> so the script can build its own URLs
 * from it: the script is one static file served from one route, so it cannot be told at build time where it lives.
 */
export function page({ title, body, theme = null, base = "" }) {
  return `<!doctype html>
<html lang="en"${theme ? ` data-theme="${esc(theme)}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><link rel="stylesheet" href="${esc(base)}/tracker.css"></head>
<body data-base="${esc(base)}"><a class="skip-link" href="#main">Skip to main content</a>${body}<script src="${esc(base)}/tracker.js" defer></script></body></html>
`;
}

/**
 * Every internal URL goes through here: the mount path, then the page, then the query the reader is carrying.
 *
 * Emitting absolute paths (`/run?id=`) would work only when the tracker owns the origin, and would 404 the moment a
 * host server mounted it under a prefix. One builder means a mount point is a parameter rather than a rewrite.
 */
export const at = (base, path, params = {}, extra = {}) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...extra })) if (v) q.set(k, v);
  const s = q.toString();
  return `${base}${path}${s ? `?${s}` : ""}`;
};

/**
 * `home` is a link back out to whatever is hosting the tracker, so a mounted tracker is not a one-way trip. The host
 * passes its own label and URL; standalone there is nowhere to go back to and the link is simply absent.
 */
export const header = (base, heading, here, ctxq, home, actions = "") => `<header class="top">
<a class="brand" href="${esc(at(base, "/", ctxq))}">${icon("workspace")}<span>gallivant<small>OPERATIONS WORKSPACE</small></span></a>
${tabs("Workspace", [
  { label: "Overview", href: at(base, "/", ctxq), icon: "overview", current: here === "dash" },
  { label: "Chains", href: at(base, "/chains", ctxq), icon: "chain", current: here === "chains" },
  { label: "Run history", href: at(base, "/runs", ctxq), icon: "history", current: here === "runs" },
])}
<div class="shell-tools">${home ? `<a class="home" href="${esc(home.url)}">${icon("arrow")}${esc(home.label)}</a>` : ""}
${menu("Appearance", `<label for="theme">Theme</label>${select([
  { value: "", label: "System / host", selected: !ctxq.theme },
  { value: "dark", label: "Dark", selected: ctxq.theme === "dark" },
  { value: "light", label: "Light", selected: ctxq.theme === "light" },
], { id: "theme" })}`)}</div></header>
<div class="page-heading${here === "dash" ? " overview-heading" : ""}"><div><p class="eyebrow">${here === "run" ? "Task workspace" : "Workspace"}</p><h1>${esc(here === "dash" ? "Overview" : here === "runs" ? "Run history" : heading)}</h1>
<p>${here === "dash" ? "Decisions first. Progress and waits in their own lanes." : here === "runs" ? "Recorded attempts and their logs, newest first." : here === "chains" ? "Ordered dependencies, merge gates, and recovery for future work." : "Task details, operator actions, and recorded activity."}</p></div>${actions}</div>`;

export const controls = (by, groupings) => `<div class="controls">
<label class="search-label" for="filter">Find in task list</label>
${field({ type: "search", id: "filter", placeholder: "Filter tasks…", "aria-label": "filter the list", autocomplete: "off", spellcheck: "false" })}
${groupings.length > 1 ? `<label for="groupby">Group by</label>${select(groupings.map(g => ({ value: g, label: g, selected: g === by })), { id: "groupby", "aria-label": "group by" })}` : ""}
</div><p class="hint" id="matches" aria-live="polite"></p>`;
