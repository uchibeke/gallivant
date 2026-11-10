import { esc, badge } from "./primitives.mjs";
import { presentationDetail } from "./presentation.mjs";

export const phaseBadge = p => badge(p.phase.label, p.phase.id === "operator_attention" || p.ownership !== "settled" ? "attention" : p.phase.id === "implementing" ? "live" : "");
export const summaryText = p => esc(presentationDetail(p));
export function presentationFacts(p) {
  const facts = [["phase", p.phase.label], ["actor", p.actor], ["reason", p.reason || "none recorded"],
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
