// Operator configuration for the APort-funded intake model route. Pure: no
// imports, no environment reads at module level, no provider knowledge beyond
// the two documented request shapes. Nothing here is task-selectable.
//
// config.json:
//   "intake_model": {
//     "adapter": "openai-chat" | "anthropic-messages",
//     "model": "<provider model id>",
//     "endpoint": "https://.../v1/chat/completions" | "https://.../v1/messages",
//     "credential_env": "NAME_OF_ENV_VAR_HOLDING_THE_KEY",
//     "budget": { "max_calls": 3, "max_input_tokens": 50000, "max_output_tokens": 6000,
//                 "allowance_usd": 0.10, "input_usd_per_million": 0.25, "output_usd_per_million": 2 },
//     "timeout_ms": 60000
//   }
// Ceilings below are absolute: configuration can lower them, never raise them.
export const MODEL_ROUTE_CEILINGS = Object.freeze({ maxCalls: 3, maxInputTokens: 50_000, maxOutputTokens: 6_000, allowanceUsd: 0.10, timeoutMs: 120_000 });
export const MODEL_ROUTE_ADAPTERS = Object.freeze(["openai-chat", "anthropic-messages"]);
const DEFAULT_TIMEOUT_MS = 60_000;

const localHost = host => {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h.startsWith("[")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  return !h.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|home\.arpa|onion)$/.test(h);
};

export function intakeModelProblems(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return ["intake_model must be an object (adapter, model, endpoint, credential_env, budget, timeout_ms)"];
  const extra = Object.keys(raw).filter(key => !["adapter", "model", "endpoint", "credential_env", "budget", "timeout_ms"].includes(key));
  if (extra.length) problems.push(`intake_model has unknown key${extra.length === 1 ? "" : "s"} ${extra.join(", ")}`);
  if (!MODEL_ROUTE_ADAPTERS.includes(raw.adapter)) problems.push(`intake_model.adapter must be one of ${MODEL_ROUTE_ADAPTERS.join(", ")}`);
  if (typeof raw.model !== "string" || !/^[\w.:/-]{1,128}$/.test(raw.model)) problems.push("intake_model.model must be the provider's model identifier (letters, digits, . : / _ -)");
  let endpoint = null;
  try { endpoint = new URL(raw.endpoint); } catch { /* reported below */ }
  if (!endpoint || endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) problems.push("intake_model.endpoint must be an HTTPS URL without credentials, query or fragment");
  else if (localHost(endpoint.hostname)) problems.push("intake_model.endpoint must name a public provider host, not a local or private address");
  if (typeof raw.credential_env !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(raw.credential_env)) problems.push("intake_model.credential_env must name the environment variable holding the API key (for example OPENAI_API_KEY); keys never belong in config.json");
  const budget = raw.budget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) problems.push("intake_model.budget must set max_calls, max_input_tokens, max_output_tokens, allowance_usd, input_usd_per_million and output_usd_per_million");
  else {
    const integer = (key, ceiling) => { const value = budget[key]; if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) problems.push(`intake_model.budget.${key} must be an integer from 1 to ${ceiling}`); };
    integer("max_calls", MODEL_ROUTE_CEILINGS.maxCalls);
    integer("max_input_tokens", MODEL_ROUTE_CEILINGS.maxInputTokens);
    integer("max_output_tokens", MODEL_ROUTE_CEILINGS.maxOutputTokens);
    if (!Number.isFinite(budget.allowance_usd) || budget.allowance_usd <= 0 || budget.allowance_usd > MODEL_ROUTE_CEILINGS.allowanceUsd) problems.push(`intake_model.budget.allowance_usd must be above 0 and at most ${MODEL_ROUTE_CEILINGS.allowanceUsd}`);
    for (const key of ["input_usd_per_million", "output_usd_per_million"]) if (!Number.isFinite(budget[key]) || budget[key] < 0) problems.push(`intake_model.budget.${key} must be the provider's list price per million tokens (0 or more); spend is estimated from it`);
    const extraBudget = Object.keys(budget).filter(key => !["max_calls", "max_input_tokens", "max_output_tokens", "allowance_usd", "input_usd_per_million", "output_usd_per_million"].includes(key));
    if (extraBudget.length) problems.push(`intake_model.budget has unknown key${extraBudget.length === 1 ? "" : "s"} ${extraBudget.join(", ")}`);
  }
  if (raw.timeout_ms !== undefined && (!Number.isSafeInteger(raw.timeout_ms) || raw.timeout_ms < 1000 || raw.timeout_ms > MODEL_ROUTE_CEILINGS.timeoutMs)) problems.push(`intake_model.timeout_ms must be an integer from 1000 to ${MODEL_ROUTE_CEILINGS.timeoutMs}`);
  return problems;
}

export function validateIntakeModelConfig(raw) {
  const problems = intakeModelProblems(raw);
  if (problems.length) throw Object.assign(new Error(problems.join("; ")), { code: "TASK_MODEL_ROUTE" });
  return Object.freeze({ adapter: raw.adapter, model: raw.model, endpoint: raw.endpoint, credentialEnv: raw.credential_env, timeoutMs: raw.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    budget: Object.freeze({ maxCalls: raw.budget.max_calls, maxInputTokens: raw.budget.max_input_tokens, maxOutputTokens: raw.budget.max_output_tokens, allowanceUsd: raw.budget.allowance_usd, inputUsdPerMillion: raw.budget.input_usd_per_million, outputUsdPerMillion: raw.budget.output_usd_per_million }) });
}

// Route availability without secrets. The credential value is never returned;
// only whether the named variable is present in the operator environment.
export function intakeModelRoute(config, env = {}) {
  const raw = config?.intake_model;
  if (raw === undefined || raw === null) return { enabled: false, reason: "intake_model is not configured; add it to config.json to enable the APort-funded model route", route: null };
  let route;
  try { route = validateIntakeModelConfig(raw); }
  catch (error) { return { enabled: false, reason: `intake_model configuration is invalid: ${error.message}`, route: null }; }
  const credentialPresent = typeof env?.[route.credentialEnv] === "string" && env[route.credentialEnv].trim().length > 0;
  if (!credentialPresent) return { enabled: false, reason: `export ${route.credentialEnv} in the operator environment to enable the configured ${route.adapter} model route; the key is read at call time and never saved`, route };
  return { enabled: true, reason: null, route };
}

// Public summary for capability discovery and task views: no endpoint secrets,
// no credential names beyond the variable the operator chose to configure.
export function intakeModelRouteSummary(config, env = {}) {
  const selection = intakeModelRoute(config, env);
  const host = selection.route ? new URL(selection.route.endpoint).hostname : null;
  return { enabled: selection.enabled, reason: selection.reason, adapter: selection.route?.adapter || null, model: selection.route?.model || null, endpointHost: host,
    budget: selection.route ? { ...selection.route.budget } : null, ceilings: { ...MODEL_ROUTE_CEILINGS }, tools: [], source: "operator-configuration" };
}
