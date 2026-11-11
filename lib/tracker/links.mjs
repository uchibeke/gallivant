import { redact } from "../execution_io.mjs";
import { esc } from "./primitives.mjs";

// Source links must not carry credentials, unsupported schemes or secret values.
export function safeLink(value) {
  if (typeof value !== "string" || value.length > 2048 || redact(value) !== value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || redact(decodeURIComponent(value)) !== decodeURIComponent(value)) return null;
    return url.href;
  } catch { return null; }
}

// Shared by server-rendered links and links introduced by live updates.
export function externalLinkAttributes(value, origin = null) {
  const href = safeLink(value);
  if (!href || origin && new URL(href).origin === new URL(origin).origin) return null;
  return { href, target: "_blank", rel: "noopener noreferrer" };
}

export function externalLink(value, label) {
  const attributes = externalLinkAttributes(value);
  if (!attributes) return esc(label);
  return `<a ${Object.entries(attributes).map(([key, value]) => `${key}="${esc(value)}"`).join(" ")} data-external-link="true" aria-describedby="external-link-help">${esc(label)}<span class="external-link-mark" aria-hidden="true">↗</span></a>`;
}
