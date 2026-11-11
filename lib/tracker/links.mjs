import { redact } from "../execution_io.mjs";

// Source links must not carry credentials, unsupported schemes or secret values.
export function safeLink(value) {
  if (typeof value !== "string" || value.length > 2048 || redact(value) !== value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || redact(decodeURIComponent(value)) !== decodeURIComponent(value)) return null;
    return url.href;
  } catch { return null; }
}
