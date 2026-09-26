// The completion gate, shaped after APort's deliverable.task.complete.v1 policy.
//
// The PRD's acceptance criteria become passport-style criteria ({ id, description }). The session must leave a
// completion receipt in the PR body: a fenced JSON block in the policy's own context shape, one attestation with
// evidence per criterion. Before a PR can be ready for a human, the daemon builds the policy context (taking
// tests_passing from the checks it observed, never from the agent's claim) and evaluates it. A deny dispatches a
// fix round whose prompt carries the policy's deny codes, which are written so the agent can self-correct.
//
// The same machinery decides PRD readiness: the deliverable is the PRD, the criteria are the contract rules.
import { createHash } from "node:crypto";
import { items } from "./prd.mjs";
import { quote } from "./prompt.mjs";
import { VERSION } from "./fs.mjs";
import { DEFAULT_DELIVERABLE as DEFAULT_LIMITS } from "./config.mjs";

export const POLICY_ID = "deliverable.task.complete.v1";
export const RECEIPT_TAG = "gallivant-attestations";
export { DEFAULT_LIMITS };

/**
 * Provenance for `context.meta`: which harness did the work and which Gallivant asked. A machine running both Claude
 * Code and Codex against one passport produces decisions that are otherwise indistinguishable, and the decision
 * object itself is closed (`additionalProperties: false` in the OAP decision schema), so the request context is
 * where this belongs. The policy packs leave `additionalProperties` unset and the hosted validator's context schemas
 * are `.unknown(true)`, so an extra `meta` object needs no specification change: an old verifier ignores it and a
 * new one reads it.
 *
 * SELF-REPORTED, NEVER AN AUTHORIZATION INPUT. Gallivant asserts these values; nothing verifies them. A field the
 * caller controls, used to gate a decision, is a trivially forged capability. Record it for audit and analytics.
 * Do not read it back to decide anything.
 */
export const provenance = (framework = null) => ({ ...(framework ? { framework } : {}), gallivant_version: VERSION });

const RECEIPT_RE = new RegExp("```" + RECEIPT_TAG + "\\s*\\n([\\s\\S]*?)\\n```");
const FETCH_TIMEOUT_MS = 15_000;

/** Fingerprint of the receipt block, so a round that only rewrote the receipt is recognised as progress. */
export function receiptHash(body) {
  const m = String(body || "").match(RECEIPT_RE);
  return m ? createHash("sha1").update(m[1]).digest("hex").slice(0, 12) : null;
}

/** `[{ id: "ac-1", description }]` from the PRD's Acceptance criteria bullets, in order, ids stable by position. */
export const criteriaFromPrd = prd => items(prd.sections["Acceptance criteria"]).map((description, i) => ({ id: `ac-${i + 1}`, description }));

/** What the session is told to put in the PR body. Rendered into the start and fix prompts. */
export function receiptInstructions(criteria, taskId) {
  const example = {
    task_id: taskId,
    output_type: "code",
    summary: "What changed and how it was verified, at least 20 words.",
    criteria_attestations: criteria.map(c => ({ criterion_id: c.id, met: true, evidence: "file path, test name, command output or CI run id that proves it" })),
  };
  return [
    "The PR body must end with a completion receipt: a fenced code block tagged `" + RECEIPT_TAG + "` holding JSON in exactly this shape.",
    "One attestation per criterion, `met` true only when it holds, `evidence` a concrete pointer (file path, test name, command output, run id), never a restatement of the criterion.",
    "Criteria:",
    ...criteria.map(c => `- ${c.id}: ${c.description}`),
    "",
    "```" + RECEIPT_TAG,
    JSON.stringify(example, null, 2),
    "```",
  ].join("\n");
}

/**
 * The receipt parsed out of a PR body, or null with a reason.
 *
 * The shape is checked here and not left to `evaluate`, because a receipt is agent-written JSON: `[null]` or
 * `["ac-1"]` parses happily and then throws on the first field read, which the tick catches and logs on every poll,
 * so the entry never reaches a corrective round nor a diagnosable stop. Every element must be an object with a
 * `criterion_id` string, which is the only field the rules identify an attestation by; `met` and `evidence` are
 * judged by the rules, so a wrong value there is a deny with a code the agent can act on, not a parse failure.
 */
export function parseReceipt(body) {
  const m = String(body || "").match(RECEIPT_RE);
  if (!m) return { receipt: null, reason: "no completion receipt block in the PR body" };
  let r;
  try { r = JSON.parse(m[1]); }
  catch (e) { return { receipt: null, reason: `completion receipt is not valid JSON: ${e.message}` }; }
  if (!r || typeof r !== "object" || Array.isArray(r)) return { receipt: null, reason: "completion receipt is not a JSON object" };
  if (!Array.isArray(r.criteria_attestations)) return { receipt: null, reason: "criteria_attestations is not an array" };
  const bad = r.criteria_attestations.findIndex(a => !isAttestation(a));
  if (bad >= 0) return { receipt: null, reason: `criteria_attestations[${bad}] is not an attestation object with a criterion_id string` };
  return { receipt: r, reason: null };
}

/** One attestation: an object carrying the id the rules match it to a criterion by. */
const isAttestation = a => !!a && typeof a === "object" && !Array.isArray(a) && typeof a.criterion_id === "string";

/**
 * The policy's rules, in the policy's order, with the policy's deny codes. Returns { allow, denials: [{ code,
 * message }] }. `context` is the receipt plus the daemon's own observations; `limits` is the task's limits fragment.
 */
export function evaluate({ context, limits, criteria }) {
  const d = [];
  // No criteria means nothing to judge, and nothing to judge is not a pass. Every criteria rule below is vacuously
  // satisfied by an empty list (`missing`, `unknown`, `notMet` and `noEvidence` are all empty because there are no
  // attestations to be any of those), so the gate allowed on the summary and the checks alone and the PR reached
  // ready with not one acceptance criterion evaluated. Reachable through the snapshot taken from the PR branch, the
  // copy the session could have edited: delete the `## Acceptance criteria` heading and the gate stops checking.
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { allow: false, denials: [{ code: "oap.criteria_incomplete", message: "The brief this gate reads has no acceptance criteria, so there is nothing to attest. Restore the `## Acceptance criteria` section of the PRD on this branch." }] };
  }
  // Malformed elements are dropped rather than dereferenced: `parseReceipt` refuses them before the gate ever gets
  // here, and a caller that builds a context by hand must not be able to turn a bad field into a thrown exception.
  // They still count as missing attestations, so nothing passes by being unreadable.
  const atts = (Array.isArray(context.criteria_attestations) ? context.criteria_attestations : []).filter(isAttestation);
  const missing = criteria.filter(c => !atts.some(a => a.criterion_id === c.id));
  if (missing.length) d.push({ code: "oap.criteria_incomplete", message: `Missing attestations for: ${missing.map(c => c.id).join(", ")}. Submit one per criterion.` });
  const noEvidence = atts.filter(a => typeof a.evidence !== "string" || !a.evidence.trim());
  if (noEvidence.length) d.push({ code: "oap.evidence_missing", message: `Empty evidence on: ${noEvidence.map(a => a.criterion_id).join(", ")}. Give a file path, test name, command output or run id.` });
  const notMet = atts.filter(a => a.met !== true);
  if (notMet.length) d.push({ code: "oap.criteria_not_met", message: `Not met: ${notMet.map(a => a.criterion_id).join(", ")}. Resolve them or explain in the PR why the criterion is wrong.` });
  const unknown = atts.filter(a => !criteria.some(c => c.id === a.criterion_id));
  if (unknown.length) d.push({ code: "oap.criteria_unknown", message: `Attestations for ids not in the PRD: ${unknown.map(a => a.criterion_id).join(", ")}.` });
  if (limits.require_summary) {
    const words = String(context.summary || "").split(/\s+/).filter(Boolean).length;
    if (words < (limits.min_summary_words ?? 0)) d.push({ code: "oap.summary_insufficient", message: `Summary has ${words} words; at least ${limits.min_summary_words} describing what changed and how it was verified.` });
  }
  if (limits.require_tests_passing && context.tests_passing !== true) d.push({ code: "oap.tests_not_passing", message: "Checks on the head commit are not all green. Fix them; the daemon observes CI itself." });
  if (limits.scan_output && typeof context.output_content === "string") {
    const hit = (limits.blocked_patterns || []).slice(0, 100).find(p => context.output_content.includes(p));
    if (hit) d.push({ code: "oap.blocked_pattern_detected", message: `The output contains "${hit}". Remove it.` });
  }
  return { allow: d.length === 0, denials: d };
}

/**
 * A per-task passport in OAP shape, carrying this task's criteria as the policy's limits. APort's verify route
 * accepts a passport in the request body ("local mode") and evaluates it as sent, without persisting a decision,
 * which is what lets one hosted evaluator gate many tasks with different criteria.
 */
export function taskPassport({ taskId, criteria, limits = DEFAULT_LIMITS, ownerId = "gallivant" }) {
  const id = "ap_gallivant_" + createHash("sha1").update(taskId).digest("hex").slice(0, 24);
  const { evaluator, api_url, on_unreachable, ...policyLimits } = limits;
  return {
    passport_id: id, agent_id: id, kind: "template", spec_version: "oap/1.0",
    owner_id: ownerId, owner_type: "user", assurance_level: "L0", status: "active",
    capabilities: [{ id: "deliverable.task.complete", params: {} }],
    limits: { "deliverable.task.complete": { ...policyLimits, acceptance_criteria: criteria } },
    regions: [], version: "1.0.0",
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * Ask APort's hosted evaluator. Returns { allow, denials, decisionId }. Throws on transport or non-200 errors so
 * the caller can decide what an unreachable evaluator means.
 */
export async function evaluateHosted({ apiUrl = "https://api.aport.io", apiKey = null, passport, context, fetch = globalThis.fetch }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/verify/policy/${POLICY_ID}`, {
    method: "POST", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ passport, context: { ...context, agent_id: passport.agent_id, idempotency_key: `${context.task_id}-${createHash("sha1").update(JSON.stringify(context)).digest("hex").slice(0, 12)}` } }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 400 && body.error === "context_validation_failed") {
    return { allow: false, decisionId: null, denials: (body.required_context_errors || [{ path: "context", message: body.message }]).map(e => ({ code: "oap.invalid_context", message: `${e.path}: ${e.message}` })) };
  }
  if (!res.ok || !body.decision) throw new Error(`aport verify ${res.status}: ${body.error || body.message || "no decision"}`);
  const d = body.decision;
  return { allow: d.allow === true, decisionId: d.decision_id || null, denials: d.allow ? [] : (d.reasons || []).map(r => ({ code: r.code, message: r.message })) };
}

/**
 * The one decision procedure for both gates. The built-in rules run first and report every problem at once. When
 * they pass and `limits.evaluator` is "aport", APort's evaluator confirms with a per-task passport; its deny wins.
 * If APort cannot be reached, `limits.on_unreachable` decides: "wait" returns no decision (allow false, code
 * `aport.unreachable`, `pending` true) so the caller tries again later, and "local" lets the built-in verdict stand
 * with `source` saying so. Returns { allow, denials, decisionId, source, pending }.
 */
export async function decide({ taskId, context, criteria, limits = DEFAULT_LIMITS, apiKey = null, fetch = globalThis.fetch, log = null, label = "gate" }) {
  const local = evaluate({ context, limits, criteria });
  if (!local.allow || limits.evaluator !== "aport") return { ...local, decisionId: null, source: "local" };
  try {
    const hosted = await evaluateHosted({ apiUrl: limits.api_url, apiKey, passport: taskPassport({ taskId, criteria, limits }), context, fetch });
    return { ...hosted, source: "aport" };
  } catch (e) {
    if (limits.on_unreachable === "local") {
      log?.warn(`${label}: APort unreachable (${e.message}); using the local verdict`);
      return { ...local, decisionId: null, source: "local (aport unreachable)" };
    }
    log?.warn(`${label}: APort unreachable (${e.message}); no decision until it answers`);
    return { allow: false, pending: true, denials: [{ code: "aport.unreachable", message: e.message }], decisionId: null, source: "aport (unreachable)" };
  }
}

/**
 * The completion gate for a PR. Builds the policy context from the PR body and the daemon's observations, then
 * decides. `diff` is the PR diff for the output scan. Returns { allow, denials, decisionId, source, context }.
 */
export async function gate({ taskId, prBody, criteria, checksGreen, diff = null, framework = null, limits = DEFAULT_LIMITS, apiKey = null, fetch = globalThis.fetch, log = null }) {
  const { receipt, reason } = parseReceipt(prBody);
  if (!receipt) return { allow: false, denials: [{ code: "oap.receipt_missing", message: reason }], decisionId: null, context: null, source: "local" };
  const context = {
    task_id: taskId,
    output_type: receipt.output_type || "code",
    summary: receipt.summary,
    criteria_attestations: receipt.criteria_attestations,
    tests_passing: checksGreen === true,
    ...(typeof diff === "string" ? { output_content: diff } : {}),
    meta: provenance(framework),
  };
  const result = await decide({ taskId, context, criteria, limits, apiKey, fetch, log, label: "completion gate" });
  return { ...result, context };
}

/**
 * The deny list as a prompt fragment for the fix round. Messages carry text from the PR body (criterion ids, the
 * JSON parser's error), so they are quoted like everything else that came from GitHub.
 */
export const denialsPrompt = denials => [
  "The completion receipt on this PR was denied by the task-completion gate. The codes and messages, quoted:",
  quote(denials.map(x => `${x.code}: ${x.message}`).join("\n")),
  "Fix the code or the receipt, then push.",
].join("\n");

// ---- The PRD contract as a deliverable ------------------------------------------------------------------------
// `gallivant ready` is a task-completion decision too: the deliverable is the PRD (output_type "document"), the
// criteria are the eleven contract rules, the deterministic checker supplies met and evidence per rule, and the
// policy's own output scan catches placeholders. The status flips only on an allow, and the decision id is
// recorded in the PRD, so "ready" is an auditable APort decision rather than a local flag.

export const PRD_BLOCKED_PATTERNS = Object.freeze(["TODO", "TBD", "FIXME", "???", "lorem ipsum", "<who>", "<what>", "<why>", "<a starting state>", "<an action>", "<an observable result>"]);

export const PRD_LIMITS = Object.freeze({
  evaluator: "aport", api_url: "https://api.aport.io", on_unreachable: "wait",
  require_summary: true, min_summary_words: 8, require_tests_passing: false,
  scan_output: true, blocked_patterns: PRD_BLOCKED_PATTERNS,
});

/**
 * Criteria and context for a PRD-readiness decision, from the contract rules and the checker's verdict. The harness
 * named in the brief is the provenance here: it is the one that will do the work this readiness decision authorises.
 */
export function prdContract(prd, verdict, rules) {
  const criteria = rules.map(r => ({ id: `prd-${r.id}`, description: r.text }));
  const context = {
    task_id: `prd:${prd.id}`,
    output_type: "document",
    summary: `PRD ${prd.id}: ${prd.title || "untitled"}. ${verdict.results.filter(r => r.ok).length} of ${verdict.results.length} contract rules pass.`,
    criteria_attestations: verdict.results.map(r => ({ criterion_id: `prd-${r.id}`, met: r.ok === true, evidence: r.ok ? `rule ${r.id} verified by gallivant ready` : (r.detail || "failed") })),
    output_content: prd.body,
    meta: provenance(prd.harness || null),
  };
  return { criteria, context };
}

/** Decide readiness through the shared procedure. Returns { allow, denials, decisionId, source }. */
export function decidePrdReady({ prd, verdict, rules, limits = PRD_LIMITS, apiKey = null, fetch = globalThis.fetch, log = null }) {
  const { criteria, context } = prdContract(prd, verdict, rules);
  return decide({ taskId: context.task_id, context, criteria, limits, apiKey, fetch, log, label: "PRD gate" });
}
