// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
const directive = /\b(?:open|create|raise|submit)\s+(?:(?:one|a|an|the|single|another)\s+)?(?:new\s+)?(?:pull\s+request|pr)\b/ig;
const affirmative = /^(?:please\s+)?(?:open|create|raise|submit)\s+(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
const publicationMention = /\b(?:pull[\s-]+requests?|prs?|publication|publish(?:ed|ing)?)\b/i;
// Later answers have no contract-amendment authority. Treat lifecycle/artifact
// language conservatively, including requests to withhold a push or return only
// a diff, rather than guessing whether it countermanded the original delivery.
const deliveryControl = /\b(?:review|delivery|deliver|local|withhold|cancel|stop|pause|hold|push|commit|diff|patch|branch)\b/i;
// This is a deliberately limited grammar, not a semantic authorization model.
// Prerequisites outside the publication clause cannot be moved into provider
// criteria: publication precedes their receipt gate. Unsupported control language
// therefore requires a new explicit owner contract, before any inference occurs.
const prerequisite = /\b(?:if|unless|when|whenever|once|before|after|until|pending|wait|await|approval|permission|confirmation|consent|provided|assuming|subject\s+to|conditional|conditioned|otherwise)\b/i;
const stable = value => JSON.stringify(value, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

// Keep offsets in JavaScript UTF-16 units, explicitly. Mask literals before
// locating punctuation or directives: examples/code are not publication authority.
function outsideLiterals(source) {
  let quote = null, escaped = false, out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      out += c === "\n" ? "\n" : " ";
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "`" || c === "'" && !/[\p{L}\p{N}]/u.test(source[i - 1] || "")) { quote = c; out += " "; }
    else out += c;
  }
  return out;
}

export function ownerDelivery(source) {
  if (typeof source !== "string" || !source.trim()) fail("a nonempty owner request is required");
  const masked = outsideLiterals(source), deliveries = [];
  let from = 0;
  const statements = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === ";" || masked[i] === "\n" || masked[i] === "." && /\s|$/.test(masked[i + 1] || "")) {
    statements.push([from, i + 1]); from = i + 1;
  }
  statements.push([from, source.length]);
  for (const [start, end] of statements) {
    const visible = masked.slice(start, end), matches = [...visible.matchAll(directive)];
    if (!matches.length) {
      // Unrecognized affirmative wording is no safer to delegate than a
      // restriction. Require clarification rather than making a provider attest
      // publication that only the coordinator can perform.
      if (publicationMention.test(visible)) fail("publication wording needs an explicit supported delivery contract");
      continue;
    }
    // Negation/conditions can scope a later coordinated verb. Do not guess that
    // a comma or 'and' ended that scope ("do not merge, open a PR").
    const sentenceStart = masked.slice(0, start).search(/[^.]*$/);
    const inherited = masked.slice(sentenceStart, start);
    if (qualified.test(visible) || qualified.test(inherited) || matches.length !== 1) fail("negated, conditional or multiple publication clauses need an explicit supported delivery goal");
    const match = matches[0], prefix = visible.slice(0, match.index);
    const boundary = /^\s*(?:please\s+)?$/i.test(prefix) || /(?:,|\band(?:\s+then)?|\bthen)\s*$/i.test(prefix);
    if (!boundary) fail("publication must be an unambiguous affirmative clause, not an example or an instruction to describe it");
    // Courtesy text and punctuation belong to this clause too. Leaving a final
    // period behind would turn it into an authoritative implementation fragment.
    let a = /^\s*please\s+$/i.test(prefix) ? start + prefix.search(/\S/) : start + match.index, b = end;
    while (b > a && /\s/.test(source[b - 1])) b--;
    const clause = source.slice(a, b).replace(/;$/, "");
    if (!affirmative.test(clause)) fail("publication has unsupported qualifiers or is mixed with another action");
    deliveries.push({ start: a, end: b, owner: "coordinator", kind: "pull_request" });
  }
  if (!deliveries.length) return null;
  if (prerequisite.test(masked)) fail("publication prerequisites require an explicit clarified task contract");
  if (deliveries.length !== 1) fail("one task can publish only one review PR");
  const spans = [], publication = deliveries[0];
  if (publication.start > 0) spans.push({ start: 0, end: publication.start, owner: "implementation" });
  spans.push(publication);
  if (publication.end < source.length) spans.push({ start: publication.end, end: source.length, owner: "implementation" });
  const implementation = spans.filter(s => s.owner === "implementation").map(s => source.slice(s.start, s.end)).join(" ")
    .replace(/\b(?:please|and|then)\b/ig, "").split(/[;.\n]/)
    .filter(s => !/^\s*(?:do\s+not\b|never\b|no\b|scope\s*:)/i.test(s)).join(" ");
  if (!/[\p{L}\p{N}]/u.test(implementation)) fail("describe the implementation as well as its delivery");
  return { version: 1, offsets: "utf16", source, spans };
}

export function validateOwnerDelivery(value) {
  if (!value || value.version !== 1 || typeof value.source !== "string" || stable(ownerDelivery(value.source)) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  return value;
}

export function assertDeliveryAnswer(task, text) {
  const visible = outsideLiterals(text);
  // Answers may refine implementation, but cannot silently replace the approved
  // publication contract, including a new prerequisite in a separate sentence.
  // Legacy exact operation replays are handled before this check by the service.
  if (publicationMention.test(visible) || (task.ownerDelivery || task.completion) && (prerequisite.test(visible) || deliveryControl.test(visible))) fail("delivery changes in answers require a new clarified task request");
}

export function ownerImplementation(value) {
  validateOwnerDelivery(value);
  return value.spans.filter(s => s.owner === "implementation").map(s => value.source.slice(s.start, s.end));
}

export function ownerDeliveryFromPrd(prd) {
  const section = prd?.sections?.[OWNER_DELIVERY_SECTION];
  if (section === undefined) return null;
  if ((String(prd.body || "").match(/^## Coordinator delivery contract\s*$/gm) || []).length !== 1) fail("the coordinator contract must have exactly one section");
  const match = section.trim().match(/^```json\r?\n([\s\S]+)\r?\n```$/);
  if (!match) fail("the coordinator contract must be one complete JSON block");
  let value; try { value = JSON.parse(match[1]); } catch { fail("the coordinator contract is invalid JSON"); }
  return validateOwnerDelivery(value);
}

export function ownerDeliveryEvidence(value, entry, status) {
  if (!value) return [];
  validateOwnerDelivery(value);
  const delivery = entry?.completionEvidence?.delivery;
  const fulfilled = ["fulfilled", "awaiting_integration"].includes(status) && matchingDeliveryEvidence(entry);
  return value.spans.filter(s => s.owner === "coordinator").map((span, i) => ({ id: `delivery-${i + 1}`, kind: span.kind,
    source: { start: span.start, end: span.end, text: value.source.slice(span.start, span.end) },
    status: fulfilled ? "fulfilled" : "pending", evidence: fulfilled ? { source: "coordinator-observed", repository: delivery.repository, pr: delivery.pr, head: delivery.head, base: delivery.base, observedAt: delivery.observedAt } : null }));
}

export function matchingDeliveryEvidence(entry) {
  const delivery = entry?.completionEvidence?.delivery;
  return Boolean(delivery?.gate?.allow === true && !delivery.invalidatedAt &&
    typeof entry.repo === "string" && entry.repo.trim().length > 0 &&
    typeof entry.base === "string" && entry.base.trim().length > 0 &&
    delivery.repository === entry.repo && delivery.pr === entry.pr && Number.isSafeInteger(delivery.pr) && delivery.pr > 0 &&
    typeof delivery.head === "string" && delivery.head.length > 0 && delivery.head === entry.cursor?.fixed_sha && delivery.base === entry.base);
}
