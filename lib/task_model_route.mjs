// The APort-funded intake model route: one bounded, tool-free text request per
// planning turn against an operator-configured endpoint. It drafts; it never
// implements, reads the repository, runs commands or publishes. Budget ceilings
// are absolute and checked before a call is started; spend is reported from
// provider usage at configured list prices or labelled unknown, never zero.
import { draftPrompt, MAX_PREPARATION_PROMPT_BYTES } from "./task_contract.mjs";
import { taskError } from "./task_store.mjs";
import { redact } from "./execution_io.mjs";
import { intakeModelRoute, MODEL_ROUTE_CEILINGS } from "./task_model_config.mjs";

export const MODEL_ROUTE_PROVIDER = "aport-model";
export const MODEL_ROUTE_BOUNDARY = "aport-model-text-only-v1";
export const MODEL_ROUTE_LIMITS = Object.freeze({ responseBytes: 1_048_576 });
export const isModelRouteReceipt = receipt => Boolean(receipt && receipt.version === 1 && receipt.provider === MODEL_ROUTE_PROVIDER && receipt.account === "operator"
  && receipt.boundary === MODEL_ROUTE_BOUNDARY && receipt.authority === "text-only" && Array.isArray(receipt.tools) && receipt.tools.length === 0);

// Deliberately pessimistic: three bytes per token overestimates English prose,
// so the pre-call allowance check fails closed rather than optimistically.
export const estimateTokens = text => Math.ceil(Buffer.byteLength(text) / 3);
export const estimateUsd = (budget, inputTokens, outputTokens) => (inputTokens * budget.inputUsdPerMillion + outputTokens * budget.outputUsdPerMillion) / 1_000_000;
const usd = value => `$${value.toFixed(4)}`;
const SYSTEM = "You prepare requirements for a repository task. Reply with exactly one JSON object and nothing else. You have no tools, no repository access and no ability to perform actions; describe, map and ask, never execute.";

// Two documented request shapes. Neither admits tools, functions, web search or
// file access; the request body is built here and only here.
const ADAPTERS = {
  "openai-chat": {
    request: ({ route, key, prompt }) => ({ headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: { model: route.model, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }], max_tokens: route.budget.maxOutputTokens, temperature: 0 } }),
    parse: json => ({ text: json?.choices?.[0]?.message?.content, finish: json?.choices?.[0]?.finish_reason ?? null, truncated: json?.choices?.[0]?.finish_reason === "length",
      usage: Number.isSafeInteger(json?.usage?.prompt_tokens) && Number.isSafeInteger(json?.usage?.completion_tokens) ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens } : null }),
  },
  "anthropic-messages": {
    request: ({ route, key, prompt }) => ({ headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: { model: route.model, max_tokens: route.budget.maxOutputTokens, system: SYSTEM, messages: [{ role: "user", content: prompt }] } }),
    parse: json => ({ text: Array.isArray(json?.content) ? json.content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("") : undefined, finish: json?.stop_reason ?? null, truncated: json?.stop_reason === "max_tokens",
      usage: Number.isSafeInteger(json?.usage?.input_tokens) && Number.isSafeInteger(json?.usage?.output_tokens) ? { inputTokens: json.usage.input_tokens, outputTokens: json.usage.output_tokens } : null }),
  },
};

const failed = attempt => taskError(attempt.errorCode || "TASK_MODEL_ROUTE", attempt.error || "saved model route call failed");

async function boundedJson(response) {
  if (Number(response.headers?.get?.("content-length") || 0) > MODEL_ROUTE_LIMITS.responseBytes) { await response.body?.cancel?.(); throw new Error("provider response exceeds the bounded limit"); }
  const text = typeof response.text === "function" ? await response.text() : "";
  if (Buffer.byteLength(text) > MODEL_ROUTE_LIMITS.responseBytes) throw new Error("provider response exceeds the bounded limit");
  try { return JSON.parse(text); } catch { throw new Error("provider returned invalid JSON"); }
}

// Same contract as prepareTurn: returns the planner's final message, records
// usage and cost on the attempt, and throws bounded task errors. An attempt is
// persisted before the request so a crash cannot purchase a second call.
export async function prepareModelTurn(ctx, task, store, failures, { fetcher = ctx.fetch ?? globalThis.fetch, clock = Date } = {}) {
  const env = ctx.env ?? process.env;
  const selection = intakeModelRoute(ctx.config, env);
  if (!selection.enabled) throw taskError("TASK_MODEL_ROUTE", `${selection.reason}; no model call was made`);
  const route = selection.route;
  let attempt = task.attempts.at(-1);
  if (attempt?.settled && !attempt.consumed) {
    if (!attempt.ok) throw failed(attempt);
    if (attempt.route !== "model" || !isModelRouteReceipt(attempt.receipt)) throw taskError("TASK_PREPARATION_BOUNDARY", "saved output was not produced by the text-only model route; it cannot authorize readiness");
    return attempt.message;
  }
  if (attempt && !attempt.settled) throw taskError("TASK_PREPARATION_UNKNOWN", "a model route call is recorded without a settled result; inspect the saved attempt before retrying; no new model call was made");
  const calls = task.attempts.filter(a => a.route === "model");
  if (calls.length >= route.budget.maxCalls || calls.length >= MODEL_ROUTE_CEILINGS.maxCalls) throw taskError("TASK_ALLOWANCE", `the model route allows ${Math.min(route.budget.maxCalls, MODEL_ROUTE_CEILINGS.maxCalls)} calls per task and ${calls.length} were used; inspect the saved draft and its validation failures, then answer, clarify or prepare a new task; no further model call was made`);
  const prompt = draftPrompt(task, failures);
  if (Buffer.byteLength(prompt) > MAX_PREPARATION_PROMPT_BYTES) throw taskError("TASK_INPUT", `serialized preparation prompt exceeds ${MAX_PREPARATION_PROMPT_BYTES} bytes; select fewer or smaller context files, or prepare a smaller task; saved requirements were retained`);
  const inputTokens = estimateTokens(prompt);
  if (inputTokens > route.budget.maxInputTokens) throw taskError("TASK_INPUT", `the intake prompt is about ${inputTokens} tokens; the model route input limit is ${route.budget.maxInputTokens} (ceiling ${MODEL_ROUTE_CEILINGS.maxInputTokens}); select fewer or smaller documents or prepare a smaller task; no model call was made`);
  const reservedUsd = estimateUsd(route.budget, inputTokens, route.budget.maxOutputTokens);
  // A reported cost replaces its pre-call reservation; an unknown cost keeps
  // the reservation as the conservative bound.
  const spent = calls.reduce((sum, a) => sum + (a.cost ?? a.reservedUsd ?? 0), 0);
  const allowance = Math.min(route.budget.allowanceUsd, MODEL_ROUTE_CEILINGS.allowanceUsd, task.allowance?.budgetUsd ?? Infinity);
  if (spent + reservedUsd > allowance) throw taskError("TASK_ALLOWANCE", `the next model call could cost up to ${usd(reservedUsd)} at the configured list prices (about ${inputTokens} input and up to ${route.budget.maxOutputTokens} output tokens); ${usd(spent)} of the ${usd(allowance)} model allowance is already spent or reserved, so the call was not started. Select less context, split the request, or raise intake_model.budget.allowance_usd up to ${usd(MODEL_ROUTE_CEILINGS.allowanceUsd)}. Estimates are not provider invoices.`);
  const key = env[route.credentialEnv];
  const endpointHost = new URL(route.endpoint).hostname;
  const receipt = { version: 1, provider: MODEL_ROUTE_PROVIDER, account: "operator", boundary: MODEL_ROUTE_BOUNDARY, authority: "text-only", tools: [], adapter: route.adapter, model: route.model, taskId: `intake/${task.id}` };
  attempt = { name: `model-${task.attempts.length + 1}`, route: "model", adapter: route.adapter, model: route.model, endpointHost, receipt, boundary: MODEL_ROUTE_BOUNDARY, reservedUsd,
    estimate: { inputTokens, outputTokens: route.budget.maxOutputTokens, usd: reservedUsd, basis: "configured list prices; not a provider invoice" },
    startedAt: clock.now(), deadline: clock.now() + route.timeoutMs, settled: false, consumed: false, ok: null, cost: null, usage: null, spend: { status: "reserved", usd: reservedUsd, basis: "pre-call reservation at configured list prices" } };
  task.attempts.push(attempt);
  task.status = "preparing";
  store.save(task); // Intent precedes the request; an unknown outcome never buys a second call.
  const settle = (ok, patch) => { Object.assign(attempt, patch, { ok, settled: true, endedAt: clock.now() }); attempt.elapsedMs = Math.max(0, attempt.endedAt - attempt.startedAt); store.save(task); };
  const adapter = ADAPTERS[route.adapter];
  const { headers, body } = adapter.request({ route, key, prompt });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), route.timeoutMs);
  let response;
  try {
    response = await fetcher(route.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal, redirect: "error" });
  } catch (error) {
    settle(false, { errorCode: "TASK_MODEL_ROUTE", error: `model route request to ${endpointHost} failed: ${error?.name === "AbortError" ? `timed out after ${route.timeoutMs} ms` : redact(String(error?.message || error), [key])}; billing for this call is unknown and its reservation of ${usd(reservedUsd)} is retained`, spend: { status: "unknown", usd: null, reservedUsd, reason: "no provider usage was received" } });
    throw failed(attempt);
  } finally { clearTimeout(timer); }
  if (!response?.ok) {
    await response?.body?.cancel?.().catch?.(() => {});
    settle(false, { errorCode: "TASK_MODEL_ROUTE", error: `model route HTTP ${response?.status ?? "unknown"} from ${endpointHost}; check intake_model.endpoint, intake_model.model and ${route.credentialEnv}; billing for this call is unknown and its reservation of ${usd(reservedUsd)} is retained`, spend: { status: "unknown", usd: null, reservedUsd, reason: `HTTP ${response?.status ?? "unknown"}` } });
    throw failed(attempt);
  }
  let parsed;
  try { parsed = adapter.parse(await boundedJson(response)); }
  catch (error) {
    settle(false, { errorCode: "TASK_MODEL_ROUTE", error: `model route response from ${endpointHost} was unusable: ${error.message}; billing for this call is unknown`, spend: { status: "unknown", usd: null, reservedUsd, reason: error.message } });
    throw failed(attempt);
  }
  const usage = parsed.usage;
  const cost = usage ? estimateUsd(route.budget, usage.inputTokens, usage.outputTokens) : null;
  const spend = usage ? { status: "reported", usd: cost, usage, basis: "provider-reported usage at configured list prices; not a provider invoice" } : { status: "unknown", usd: null, reservedUsd, reason: "the provider reported no usage; the pre-call reservation remains the spend bound" };
  if (usage && usage.outputTokens > route.budget.maxOutputTokens) {
    settle(false, { usage, cost, spend, errorCode: "TASK_MODEL_ROUTE", error: `the provider reported ${usage.outputTokens} output tokens, above the configured limit of ${route.budget.maxOutputTokens}; the draft was rejected` });
    throw failed(attempt);
  }
  if (typeof parsed.text !== "string" || !parsed.text.trim()) {
    settle(false, { usage, cost, spend, errorCode: "TASK_MODEL_ROUTE", error: "the provider returned no text draft; the call is recorded and no implementation was started" });
    throw failed(attempt);
  }
  if (parsed.truncated) {
    settle(false, { usage, cost, spend, errorCode: "TASK_MODEL_ROUTE", error: `the draft stopped at the configured output limit of ${route.budget.maxOutputTokens} tokens and is incomplete; prepare a smaller intake or select fewer documents` });
    throw failed(attempt);
  }
  settle(true, { usage, cost, spend, finish: parsed.finish, message: redact(parsed.text, [key]), error: null });
  return attempt.message;
}
