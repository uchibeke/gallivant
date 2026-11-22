import { randomUUID } from "node:crypto";
import { executionLive } from "./execution_contract.mjs";
import { DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION } from "./registry_versions.mjs";

const defaults = Object.freeze({ authors: 8, per_repository: 8, per_plan: 8, preparations: 4,
  graph_authors: 0, graph_per_repository: 0 });
const graphLimits = new Set(["graph_authors", "graph_per_repository"]);
export const dispatchCapacity = config => ({ ...defaults, ...config?.dispatch_capacity });

export function dispatchCapacityProblems(value) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["dispatch_capacity must be an object"];
  return Object.entries(value).flatMap(([key, count]) =>
    Object.hasOwn(defaults, key) && Number.isSafeInteger(count) && count >= (graphLimits.has(key) ? 0 : 1) && count <= 64
      ? [] : [`Invalid dispatch_capacity.${key}; use a documented capacity in range`]);
}

export const authorCapacityWait = () => Object.assign(new Error("Author or preparation capacity is currently reserved."), { code: "AUTHOR_CAPACITY" });

export function liveAuthor(entry) {
  if (entry.author_settlement?.run && entry.author_settlement.run === entry.last?.run) return false;
  if (entry.initial_dispatch?.status === "unsubmitted" && !entry.last?.run) return false;
  if (entry.execution?.transport === "remote" && entry.execution.collected && !executionLive(entry)) return false;
  return executionLive(entry) || (entry.last?.run ? entry.last.exit == null : entry.state === "running");
}

export function dispatchState(state) {
  state.version = Math.max(state.version, DISPATCH_REGISTRY_VERSION);
  return state.dispatch ??= { version: 1, authors: {} };
}

const taskLane = entry => entry.plan?.instanceId ?? entry.chain?.name ?? null;

export function reserveAuthor(state, id, { repo, plan = null, graph = false, operation, previousRun = null,
  preparing = false, limits, approved = null, token = randomUUID(), requiresCessation = false }) {
  const authors = state.dispatch?.authors ?? {};
  if (authors[id]) throw authorCapacityWait();
  const ceilings = { ...limits };
  for (const [key, cap] of Object.entries(approved?.authorCapacity ?? {})) ceilings[key] = Math.min(ceilings[key], cap);
  let total = 0, inRepo = 0, inPlan = 0, preparations = 0, graphTotal = 0, graphInRepo = 0;
  const count = (slot, inGraph = slot.graph) => {
    total++;
    if (slot.repo === repo) inRepo++;
    if (plan && slot.plan === plan) inPlan++;
    if (slot.preparing) preparations++;
    if (inGraph) {
      graphTotal++;
      if (slot.repo === repo) graphInRepo++;
    }
  };
  // A saved fix round may predate graph classification on continuation slots.
  for (const [key, slot] of Object.entries(authors)) count(slot, slot.graph || Boolean(state.entries[key]?.plan));
  // Executions admitted by older versions still occupy capacity. Finished
  // entries and retained workspaces do not consume a slot.
  for (const [key, entry] of Object.entries(state.entries)) {
    if (key !== id && !authors[key] && liveAuthor(entry)) count({ repo: entry.repo, plan: taskLane(entry), graph: Boolean(entry.plan) });
  }
  for (const [key, claim] of Object.entries(state.starts ?? {})) {
    if (!authors[key] && !claim.unsent) count({ repo: claim.repo ?? key.slice(0, key.lastIndexOf("/")), plan: claim.chain });
  }
  if (total >= ceilings.authors || inRepo >= ceilings.per_repository || (plan && inPlan >= ceilings.per_plan) ||
      (preparing && preparations >= ceilings.preparations) ||
      (graph && (graphTotal >= Math.min(ceilings.graph_authors, approved?.maxLiveGraphAuthors ?? 0) ||
        graphInRepo >= Math.min(ceilings.graph_per_repository, approved?.maxGraphAuthorsPerRepository ?? 0)))) throw authorCapacityWait();
  const slot = { token, operation: operation ?? token, repo, plan, graph, previousRun, preparing, requiresCessation, pid: process.pid };
  dispatchState(state).authors[id] = slot;
  return slot;
}

export function settledAuthor(state, id, entry, cessation = false) {
  const slot = state.dispatch?.authors?.[id];
  if (!slot || slot.preparing || slot.requiresCessation && !cessation || entry.initial_dispatch || liveAuthor(entry)) return state;
  const matches = entry.execution?.operationId ? entry.execution.operationId === slot.operation
    : entry.last?.run && entry.last.run !== slot.previousRun;
  if (!matches) return state;
  const authors = { ...state.dispatch.authors };
  delete authors[id];
  return { ...state, dispatch: { ...state.dispatch, authors } };
}

export function checkDispatchState(state) {
  if (state.version !== DISPATCH_REGISTRY_VERSION && state.dispatch === undefined &&
      !state.plans?.instances.some(plan => plan.control.status === "active" || plan.runtime.nodes)) return;
  const { dispatch } = state;
  if (![DISPATCH_REGISTRY_VERSION, PLAN_CONTROL_REGISTRY_VERSION].includes(state.version) || dispatch?.version !== 1 || !dispatch.authors ||
      typeof dispatch.authors !== "object" || Array.isArray(dispatch.authors) ||
      Object.entries(dispatch.authors).some(([id, slot]) => (!state.entries[id] && !state.starts?.[id]) ||
        !slot || typeof slot.token !== "string" || typeof slot.operation !== "string" ||
        typeof slot.repo !== "string" || typeof slot.preparing !== "boolean" || typeof slot.graph !== "boolean")) {
    throw Object.assign(new Error("Invalid durable author reservations. Restore the matching private registry."), { code: "STATE_VERSION" });
  }
}
