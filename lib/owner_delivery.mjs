// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
const directive = /\b(?:open|create|raise|submit)\s+(?:(?:one|a|an|the|single|another)\s+)?(?:new\s+)?(?:pull\s+request|pr)\b/ig;
const affirmative = /^(?:please\s+)?(?:open|create|raise|submit)\s+(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
// A PR/template/title or published-article subject is not a publication request.
// Recognize actual actions and controls; supported affirmative clauses are still
// partitioned below, while unsupported/conditional forms require clarification.
const publicationAction = /\bpublish\b|\b(?:open|create|raise|submit|send)\s+(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull[\s-]+requests?|prs?)\b|\b(?:start|begin)\s+publishing\b|\b(?:send|submit)\b[^.;\n]*\bfor\s+(?:human\s+|code\s+)?review\b/i;
const withheldPublication = /\b(?:no|not|never|without|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:(?:any|a|the|all|new)\s+)*(?:pull[\s-]+requests?|prs?|publication|publishing)\b/i;
const publicationRequirement = /\b(?:pull[\s-]+requests?|prs?|publication|publishing)\s+(?:(?:must|should|will|can|may|shall|is|are|be|not|never|only)\s+)*(?:created|opened|submitted|published|required|needed|allowed|permitted|forbidden)\b/i;
const publicationDirective = text => [publicationAction, withheldPublication, publicationRequirement].some(pattern => pattern.test(text));
// Recognize directions about the workflow, not implementation nouns (a local
// store, review dashboard or diff viewer). This bounded grammar does not infer
// permission; unsupported explicit publication wording is refused separately.
const controlledAction = /\b(?:do\s+not|don't|never|must\s+not|should\s+not|avoid|prevent|without|no|skip)\s+(?:(?:ever|any|a|the)\s+)?(?:push(?:es|ing)?|commit(?:s|ting)?|deliver(?:ing|y)?|send(?:ing)?\b[^.;\n]*\bfor\s+(?:human\s+|code\s+)?review)\b/i;
const controlledWork = /\b(?:stop|pause|cancel|hold|withhold|delay|defer)\s+(?:(?:the|this|these|my|our|your|all|any)\s+)?(?:changes?|work|code|implementation|tasks?|runs?|push(?:es|ing)?|commit(?:s|ting)?|delivery|review|it|them|everything)\b|\b(?:stop|pause|cancel)\s*(?:[.!;]|$)/i;
const localWork = /\b(?:keep|leave|retain)\s+(?:(?:the|this|these|my|our|your|all)\s+)?(?:changes?|work|code|implementation|tasks?|branches?|it|them|this|everything)\s+(?:(?:strictly|only)\s+)?local(?:ly)?\b|\b(?:keep|leave)\s+(?:only\s+)?local(?:ly)?(?=\s*(?:[.!;]|$))|\b(?:work|operate)\s+(?:only\s+locally|locally\s+only)\b/i;
const artifactOnly = /\b(?:show|return|produce|provide|give|send)\s+(?:(?:me|us|a|an|the|this|only|just)\s+)*(?:diff|patch)(?=\s+(?:only|without|instead)\b|\s*[.!;]|\s*$)|\b(?:diff|patch)\s*[- ]only\b/i;
const awaitReview = /\b(?:wait|await)\s+(?:for\s+)?(?:(?:my|our|your|human|owner|user|explicit)\s+)*(?:review|approval|permission|confirmation|consent)\b/i;
const deliveryControl = text => [controlledAction, controlledWork, localWork, artifactOnly, awaitReview].some(pattern => pattern.test(text));
// Owner authorization prerequisites affect the whole task. Technical conditions
// (if a name is empty; commit a database transaction after validation) remain
// implementation scope. Conditional/negative publication clauses themselves are
// independently rejected by `qualified` above; punctuation cannot erase them.
const requestedApproval = /\b(?:wait|await|ask|obtain|request|require)\s+(?:for\s+)?(?:(?:my|our|your|human|owner|user|explicit|further|manual|the)\s+)*(?:review|approval|permission|confirmation|consent|go-ahead)\b/i;
const conditionedApproval = /\b(?:before|after|until|unless|pending|once|when|if|provided|subject\s+to|conditioned\s+on)\b[^.;\n]*\b(?:(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)\s+(?:approve|confirm|consent|permit|agree|review|authorize)|(?:my|our|your|owner|human|manual|explicit)\s+(?:review|approval|permission|confirmation|consent))\b/i;
const requiredApproval = /\b(?:approval|permission|confirmation|consent)\s+(?:(?:is|are|must\s+be)\s+)?(?:required|needed|pending|first)\b|\bask\s+(?:me|us|the\s+owner)\s+(?:first|before)\b/i;
const ownerPrerequisite = text => [requestedApproval, conditionedApproval, requiredApproval].some(pattern => pattern.test(text));
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
      // Passive/negative publication is still a restriction, not an ordinary
      // provider criterion that may be checked only after the PR already exists.
      if (publicationDirective(visible)) fail("publication wording needs an explicit supported delivery contract");
      continue;
    }
    // Negation/conditions can scope a later coordinated verb. Do not guess that
    // a comma or 'and' ended that scope ("do not merge, open a PR").
    const sentenceStart = masked.slice(0, start).search(/[^.]*$/);
    const inherited = masked.slice(sentenceStart, start);
    if (qualified.test(visible) || qualified.test(inherited) || matches.length !== 1) fail("negated, conditional or multiple publication clauses need an explicit supported delivery goal");
    const match = matches[0], prefix = visible.slice(0, match.index);
    const connector = prefix.match(/(?:,\s*)?(?:\band(?:\s+then)?|\bthen)\s*$|,\s*$/i);
    const boundary = /^\s*(?:please\s+)?$/i.test(prefix) || connector;
    if (!boundary) fail("publication must be an unambiguous affirmative clause, not an example or an instruction to describe it");
    // Courtesy text and punctuation belong to this clause too. Leaving a final
    // period behind would turn it into an authoritative implementation fragment.
    let a = /^\s*please\s+$/i.test(prefix) ? start + prefix.search(/\S/) : start + match.index, b = end;
    while (b > a && /\s/.test(source[b - 1])) b--;
    const clause = source.slice(a, b).replace(/;$/, "");
    if (!affirmative.test(clause)) fail("publication has unsupported qualifiers or is mixed with another action");
    // The same recognized connector that admitted this boundary belongs to the
    // publication clause, not a dangling authoritative implementation fragment.
    if (connector) {
      a = start + connector.index;
      while (a > start && /\s/.test(source[a - 1])) a--;
    }
    deliveries.push({ start: a, end: b, owner: "coordinator", kind: "pull_request" });
  }
  // Every new task has a review-PR workflow even when no publication clause was
  // written. A local-only restriction cannot be deferred to provider criteria:
  // the coordinator publishes before their completion gate. Exclude only exact
  // clauses already admitted above; quoted examples were masked at the source.
  const outsidePublication = deliveries.reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (deliveryControl(outsidePublication)) fail("delivery controls outside the supported publication clause require a clarified task contract");
  if (ownerPrerequisite(outsidePublication)) fail("publication prerequisites require an explicit clarified task contract");
  if (!deliveries.length) return null;
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
  if (publicationDirective(visible) || (task.ownerDelivery || task.completion) && (ownerPrerequisite(visible) || deliveryControl(visible))) fail("delivery changes in answers require a new clarified task request");
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
    typeof delivery.repository === "string" && delivery.repository.length > 0 && delivery.repository === entry.repo &&
    delivery.pr === entry.pr && Number.isSafeInteger(delivery.pr) && delivery.pr > 0 &&
    typeof delivery.head === "string" && delivery.head.length > 0 && delivery.head === entry.cursor?.fixed_sha &&
    typeof delivery.base === "string" && delivery.base.length > 0 && delivery.base === entry.base);
}
