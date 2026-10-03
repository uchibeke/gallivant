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
import { shortHash } from "./hash.mjs";
import { criteriaFromPrd } from "./prd.mjs";
import { quote } from "./prompt.mjs";
import { VERSION } from "./fs.mjs";
import { DEFAULT_DELIVERABLE as DEFAULT_LIMITS } from "./config.mjs";

export const POLICY_ID = "deliverable.task.complete.v1";
export { RECEIPT_TAG } from "./public-format.mjs";
import { RECEIPT_TAG, RECEIPT_TAGS } from "./public-format.mjs";
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

const RECEIPT_RE = new RegExp("^```(?:" + RECEIPT_TAGS.join("|") + ")\\s*\\n([\\s\\S]*?)\\n```[ \t]*\\r?(?=\\n|$)", "gm");
const receiptMatches = body => [...String(body || "").matchAll(RECEIPT_RE)];
export const publicTaskId = taskId => "task-" + createHash("sha256").update(String(taskId)).digest("hex").slice(0, 24);
const FETCH_TIMEOUT_MS = 15_000;
// The hosted route limits the whole JSON body to 256 KiB, including the passport and JSON escaping.
export const MAX_POLICY_BYTES = 240 * 1024;

/**
 * Fingerprint of the receipt block, so a round that only rewrote the receipt is recognised as progress. The hashing
 * itself is `shortHash`, shared with the brief's contract fingerprint: one spelling of "twelve hex characters of a
 * sha1" rather than two that happen to agree.
 */
export function receiptHash(body) {
  const matches = receiptMatches(body);
  if (matches.length !== 1) return null;
  // Migration changes transport names/IDs, not evidence. Ignore task_id (the gate binds its own trusted task ID)
  // in this progress fingerprint, so rewriting only the format never spends a review round.
  try {
    const receipt = JSON.parse(matches[0][1]);
    if (receipt && typeof receipt === "object" && !Array.isArray(receipt)) {
      delete receipt.task_id;
      return shortHash(JSON.stringify(receipt));
    }
  } catch { /* malformed receipts retain a useful fingerprint */ }
  return shortHash(matches[0][1]);
}

/** Accepted stored fingerprints during the one-time transport upgrade; new writes use receiptHash. */
export function receiptHashes(body) {
  const matches = receiptMatches(body);
  return matches.length === 1 ? [...new Set([receiptHash(body), shortHash(matches[0][1])])] : [];
}

/**
 * `[{ id: "ac-1", description }]` from the PRD's Acceptance criteria bullets, in order, ids stable by position.
 *
 * Re-exported from `prd.mjs`, where it now lives, because it is a fact about the brief's contract and not about this
 * gate: the divergence check in `prd.mjs` compares exactly this list plus `verifyCommands`, and reaching back here for
 * half of that would have made `prd.mjs` import the module that imports it. Every existing caller still takes it from
 * here, since this is where it has always been named.
 */
export { criteriaFromPrd };

/** What the session is told to put in the PR body. Rendered into the start and fix prompts. */
export function receiptInstructions(criteria, taskId) {
  const example = {
    task_id: publicTaskId(taskId),
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
  const matches = receiptMatches(body);
  if (matches.length > 1) return { receipt: null, reason: "multiple completion receipt blocks in the PR body" };
  const m = matches[0];
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

/** Migrate only the understood receipt transport. Evidence and all other JSON fields keep their exact values. */
export function normalizeReceipt(body, taskId = null) {
  const text = String(body || "");
  const matches = receiptMatches(text);
  if (matches.length > 1) throw new Error("multiple completion receipt blocks; keep exactly one receipt");
  if (!matches.length) return text;
  const match = matches[0];
  let json = match[1];
  if (taskId !== null) {
    let value;
    try { value = JSON.parse(json); } catch { /* leave malformed evidence for the gate to refuse */ }
    if (value && typeof value === "object" && !Array.isArray(value) && value.task_id === taskId) {
      value.task_id = publicTaskId(taskId);
      json = JSON.stringify(value, null, 2);
    }
  }
  return text.slice(0, match.index) + "```" + RECEIPT_TAG + "\n" + json + "\n```" + text.slice(match.index + match[0].length);
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
    const output = context.output_content.toLowerCase();
    const hit = (limits.blocked_patterns || []).slice(0, 100).find(p => output.includes(p.toLowerCase()));
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
const policyBody = (passport, context) => JSON.stringify({ passport, context: {
  ...context, agent_id: passport.agent_id,
  idempotency_key: `${context.task_id}-${createHash("sha1").update(JSON.stringify(context)).digest("hex").slice(0, 12)}`,
} });

/** Full output, in overlapping pieces. Each request retains the complete criteria, receipt and policy limits. */
function* policyBodies(passport, context) {
  const body = policyBody(passport, context);
  if (Buffer.byteLength(body) <= MAX_POLICY_BYTES) { yield body; return; }
  const content = context.output_content;
  if (typeof content !== "string" || !content.length) throw new Error("APort request exceeds the JSON size limit without splittable output content");
  const patterns = passport.limits["deliverable.task.complete"]?.blocked_patterns ?? [];
  // The hosted matcher uses case-insensitive substrings. Overlap every possible matching span; never drop a tail.
  const overlap = Math.max(0, ...patterns.map(p => p.toLowerCase().length - 1));
  const sha256 = createHash("sha256").update(content).digest("hex");
  let start = 0, part = 0;
  while (start < content.length) {
    const partBody = end => policyBody(passport, { ...context, output_content: content.slice(start, end),
      meta: { ...context.meta, output_scan: { sha256, part, offset: start } } });
    // UTF-16 length bounds the search, actual serialized UTF-8 bytes decide what fits (quotes and control chars too).
    let lo = start, hi = Math.min(content.length, start + MAX_POLICY_BYTES);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(partBody(mid)) <= MAX_POLICY_BYTES) lo = mid;
      else hi = mid - 1;
    }
    let end = lo;
    if (end < content.length && /[\uDC00-\uDFFF]/.test(content[end]) && /[\uD800-\uDBFF]/.test(content[end - 1] ?? "")) end--;
    if (end <= start || (end < content.length && end - start <= overlap)) {
      throw new Error("APort request metadata or blocked-pattern overlap leaves no room for output; nothing was approved");
    }
    yield partBody(end);
    if (end === content.length) return;
    let next = end - overlap;
    if (/[\uDC00-\uDFFF]/.test(content[next]) && /[\uD800-\uDBFF]/.test(content[next - 1] ?? "")) next--;
    if (next <= start) throw new Error("APort output overlap cannot advance within the request size limit");
    start = next;
    part++;
  }
}

export async function evaluateHosted({ apiUrl = "https://api.aport.io", apiKey = null, passport, context, fetch = globalThis.fetch }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const decisions = [];
  let result;
  for (const body of policyBodies(passport, context)) {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/verify/policy/${POLICY_ID}`, {
      method: "POST", headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 400 && data.error === "context_validation_failed") {
      return { allow: false, decisionId: null, denials: (data.required_context_errors || [{ path: "context", message: data.message }]).map(e => ({ code: "oap.invalid_context", message: `${e.path}: ${e.message}` })) };
    }
    if (!res.ok || !data.decision) throw new Error(`aport verify ${res.status}: ${data.error || data.message || "no decision"}`);
    const d = data.decision;
    result = { allow: d.allow === true, decisionId: d.decision_id || null, denials: d.allow ? [] : (d.reasons || []).map(r => ({ code: r.code, message: r.message })) };
    if (!result.allow) return result;
    decisions.push(result.decisionId);
  }
  return { ...result, ...(decisions.length > 1 ? { decisionIds: decisions } : {}) };
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
// criteria are the contract rules, the deterministic checker supplies met and evidence per rule, and the
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
