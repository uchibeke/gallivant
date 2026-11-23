import { at } from "./shell.mjs";

export const planHref = (base, query, plan) => at(base, "/plans", query,
  { plan: plan.id, node: plan.node ?? "", mo: "", po: "", dp: "" });

export function factoryTaskHref(base, query, row) {
  if (row.registered) return at(base, "/run", query, { id: row.id,
    ...(row.plan ? { plan: row.plan.id, node: row.plan.node, milestone: "" } : {}) });
  if (row.plan) return planHref(base, query, row.plan);
  return at(base, "/task/new", query, { task: row.id });
}
