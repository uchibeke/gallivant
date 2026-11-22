import { esc, badge, notice } from "./primitives.mjs";
import { presentationDetail, recoveryDetail } from "./presentation.mjs";

export const phaseBadge = p => badge(p.phase.label,
  p.attention?.group === "attention" || p.ownership && p.ownership !== "settled" ? "attention" : p.phase.id === "implementing" ? "live" : "");
export const decisionCard = (attention, { compact = false } = {}) => compact
  ? `<strong>${esc(attention.title)}</strong><p>${esc(attention.nextAction)}</p>`
  : notice(`${attention.title} · ${attention.actor || "unknown"}. ${attention.nextAction}`, attention.group === "attention" ? "warning" : "info");
export const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
export const cooldown = nextAt => nextAt ? `<time datetime="${esc(nextAt)}">${esc(nextAt)}</time>` : "No retry time recorded";
export const requestStatus = (request, label) => request
  ? `<p>${esc(label)} ${esc(request.action || "request")} · ${esc(request.status || "unknown")} · <code>${esc(request.id || "unknown")}</code></p>` : "";
export const reviewConfirmPanel = (id, label) => `<dialog id="${id}-confirm" aria-labelledby="${id}-confirm-title"><h2 id="${id}-confirm-title">${esc(label)}</h2><div id="${id}-review" tabindex="0" role="region" aria-label="Reviewed scope and differences"></div><p id="${id}-action-status" role="status"></p><div class="chain-dialog-actions"><button id="${id}-submit" type="button" disabled>Confirm reviewed action</button><button id="${id}-close" type="button">Close</button></div></dialog>`;
export const summaryText = p => esc(presentationDetail(p));
export function presentationFacts(p) {
  const facts = [["phase", p.phase.label], ["recovery", recoveryDetail(p)], ["actor", p.actor], ["reason", p.reason || "none recorded"],
    ["blocker", p.blocker || "none recorded"], ["next action", p.nextAction], ["readiness", p.readiness.status],
    ["receipt", p.acceptance.status], ["delivery target", p.delivery.target], ["approved base", p.delivery.base || "unknown"],
    ["last meaningful activity", p.activity.at || "unknown"], ["last observed", p.freshness.observedAt || "unknown"],
    ["provider readiness", p.provider.label], ["ownership", p.ownership]];
  return facts.map(([key, value]) => `<dt>${esc(key)}</dt><dd data-fact="${esc(key)}">${esc(value)}</dd>`).join("") +
    (p.diagnostics.length ? `<dt>diagnostic</dt><dd>${p.diagnostics.map(esc).join(" ")}</dd>` : "");
}

export const TASK_PAGE_SIZE = 100;
export function taskWindow(model, offset = 0) {
  const keys = ["needs_you", "running", "done"];
  const total = keys.reduce((n, key) => n + (model[key]?.length || 0), 0);
  const start = Number.isSafeInteger(Number(offset)) ? Math.max(0, Math.min(Number(offset), Math.max(0, total - 1))) : 0;
  let cursor = 0;
  const result = { ...model };
  for (const key of keys) {
    const rows = model[key] || [];
    result[key] = rows.slice(Math.max(0, start - cursor), Math.max(0, start + TASK_PAGE_SIZE - cursor));
    cursor += rows.length;
  }
  return { model: result, total, start, next: start + TASK_PAGE_SIZE < total ? start + TASK_PAGE_SIZE : null };
}
