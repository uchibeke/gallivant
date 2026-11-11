// Text and attributes are escaped here; composition slots accept only renderer-owned HTML.
export const esc = s => String(s ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const attrs = values => Object.entries(values).map(([key, value]) => {
  if (!/^(?:id|type|name|value|class|href|title|role|tabindex|placeholder|autocomplete|spellcheck|maxlength|rows|required|disabled|hidden|selected|aria-[\w-]+|data-[\w-]+)$/.test(key)) throw new Error(`Unsupported UI attribute: ${key}`);
  return value === false || value == null ? "" : value === true ? ` ${key}` : ` ${key}="${esc(value)}"`;
}).join("");

// A small, local, consistent 24px stroke vocabulary. No user-supplied SVG.
const paths = {
  workspace: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M3 9h18M9 9v12"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chain: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v9h9"/>',
  history: '<path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2"/>',
  arrow: '<path d="m10 5-7 7 7 7M3 12h18"/>',
  theme: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18a9 9 0 0 0 0-18"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  attention: '<path d="m12 3 10 18H2L12 3Z M12 9v5 M12 17v1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/>',
};
export const icon = name => `<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[name] || paths.info}</svg>`;
export const badge = (text, tone = "") => `<span class="tag${tone ? ` ${esc(tone)}` : ""}">${esc(text)}</span>`;
export const button = (text, attributes = {}) => `<button${attrs({ type: "button", ...attributes })}>${esc(text)}</button>`;
export const field = attributes => `<input${attrs(attributes)}>`;
export const textarea = (text, attributes) => `<textarea${attrs(attributes)}>${esc(text)}</textarea>`;
export const select = (options, attributes) => `<select${attrs(attributes)}>${options.map(o => `<option value="${esc(o.value)}"${o.selected ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
export const emptyState = text => `<p class="empty">${esc(text)}</p>`;
export const notice = (text, tone = "info") => `<p class="notice ${esc(tone)}">${icon(tone === "warning" || tone === "error" ? "attention" : tone === "success" ? "check" : "info")}<span>${esc(text)}</span></p>`;
export const loadingState = (text, attributes = {}) => `<p${attrs({ class: "note loading", role: "status", ...attributes })}>${esc(text)}</p>`;
export const menu = (label, content) => `<details class="menu"><summary>${icon("theme")}<span>${esc(label)}</span>${icon("chevron")}</summary><div class="menu-panel">${content}</div></details>`;
export const tabs = (label, items) => `<nav class="views" aria-label="${esc(label)}">${items.map(item => `<a href="${esc(item.href)}"${item.current ? ' aria-current="page"' : ""}>${icon(item.icon)}${esc(item.label)}</a>`).join("")}</nav>`;
