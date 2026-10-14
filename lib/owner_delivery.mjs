// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
const directive = /\b(?:open|create|raise|submit)\s+(?:(?:one|a|an|the|single|another)\s+)?(?:new\s+)?(?:pull\s+request|pr)\b/ig;
const affirmative = /^(?:please\s+)?(?:open|create|raise|submit)\s+(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
const publicationConnector = /(?:,\s*(?:and(?:\s+then)?|then)?|\band(?:\s+then)?|\bthen)\s*$/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
// A PR/template/title or published-article subject is not a publication request.
// Recognize actual actions and controls; supported affirmative clauses are still
// partitioned below, while unsupported/conditional forms require clarification.
const publicationAction = /\b(?:open|create|raise|submit|send|prepare)\s+(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull[\s-]+requests?|prs?)\b|\b(?:start|begin)\s+publishing\b|\b(?:send|submit)\b[^.!;\n]*\bfor\s+(?:human\s+|code\s+)?review\b/i;
// An imperative or coordinated action is a delivery direction. A feature's noun
// or infinitive ("a publish button", "a command to publish docs") is not.
const publishCommand = text => [...text.matchAll(/\bpublish\b/ig)].some(match =>
  /(?:^|[.!;:\n,]|\b(?:and|then|do\s+not|don['’]t|never|only|must|should|shall|please|avoid|prevent|without|skip|want\s+you\s+to|need\s+you\s+to))\s*(?:(?:please|ever|again|now|[a-z]+ly)\s+)*$/i.test(text.slice(0, match.index)));
const withheldPublication = /\b(?:no|not|never|without|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:(?:any|a|the|all|new)\s+)*(?:pull[\s-]+requests?|prs?|publication|publishing)\b/i;
const publicationRequirement = /\b(?:pull[\s-]+requests?|prs?|publication|publishing)\s+(?:(?:must|should|will|can|may|shall|is|are|be|not|never|only)\s+)*(?:created|opened|submitted|published|required|needed|allowed|permitted|forbidden|requires?|needs?|awaits?)\b/i;
const publicationCondition = /\b(?:pull[\s-]+requests?|prs?|publication|publishing)\s+(?:(?:is|are|will\s+be|must\s+be)\s+)?(?:only\s+)?(?:after|before|until|when|if|unless|pending|subject\s+to)\b/i;
const publicationDirective = text => publishCommand(text) || [publicationAction, withheldPublication, publicationRequirement, publicationCondition].some(pattern => pattern.test(text));
// Recognize directions about the workflow, not implementation nouns (a local
// store, review dashboard or diff viewer). This bounded grammar does not infer
// permission; unsupported explicit publication wording is refused separately.
// Direct and coordinated restrictions use the same bounded modal/subject forms.
const actionLead = String.raw`(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:should|must|may|can|could|would|will|shall|do|does|did)\s+)?(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:not|ever|again|now|first|any|a|the|[a-z]+ly)\s+)*(?:(?:run|running)\s+)?`;
const actionVerb = String.raw`(?<git>git\s+)?(?<verb>push(?:es|ing)?|commit(?:s|ting)?|deliver(?:ing|y)?|publish(?:ing)?)\b`;
const controlledActionPattern = new RegExp(String.raw`\b(?:do\s+not|don['’]t|never|must\s+not|should\s+not|avoid|prevent|without|no|skip|neither|nor)\s+${actionLead}${actionVerb}`, "ig");
const technicalOperation = (verb, tail) => /^commit/i.test(verb)
  ? /^\s+(?:(?:the|a|this|that)\s+)?(?:(?:database|sql|db)\s+)?transactions?\b/i.test(tail)
  : /^push/i.test(verb) && /^\s+(?:(?:the|a|an|this|that|duplicate|new|existing)\s+)*(?:items?|elements?|values?|records?|messages?|entries)\s+(?:onto|into|to)\s+(?:(?:the|a|an|this|that)\s+)?(?:queue|stack|array|list)\b/i.test(tail);
// Negation also spans "nor", including technical actions before a Git action.
// A technical exception for one verb must never exempt the rest of the sequence.
const coordinatedAction = new RegExp(String.raw`(?:\b(?:and|or|nor|then|but)\s+|,\s*(?:(?:and|or|nor|then|but)\s+)?)${actionLead}${actionVerb}`, "ig");
const workflowAction = (verb, tail, git) => Boolean(git) || !technicalOperation(verb, tail);
function workflowSequence(verb, tail, git) {
  const rest = tail.split(/[.!;\n]/)[0];
  return workflowAction(verb, rest, git) || [...rest.matchAll(coordinatedAction)].some(match => workflowAction(match.groups.verb, rest.slice(match.index + match[0].length), match.groups.git));
}
const controlledAction = text => [...text.matchAll(controlledActionPattern)].some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length), match.groups.git));
const controlledWork = /\b(?:stop|pause|cancel|hold|withhold|delay|defer|skip)\s+(?:(?:the|this|these|my|our|your|all|any)\s+)?(?:changes?|edits?|work|code|implementation|tasks?|runs?|push(?:es|ing)?|commit(?:s|ting)?|delivery|publication|review|it|them|everything)\b|\b(?:stop|pause|cancel)\s*(?:[.!;]|$)/i;
const localWork = /\b(?:keep|leave|save|retain)\s+(?:(?:the|this|these|those|my|our|all)\s+)?(?:changes?|edits?|work|code|results?|outputs?|files?|branches|branch|it|them|this|these|those|everything)\s+(?:(?:only|strictly)\s+)?(?:local(?:ly|-only)?|unpublished|uncommitted|unpushed)\b|\b(?:keep|leave)\s+(?:only\s+)?local(?:ly)?(?=\s*(?:[.!;]|$))|\b(?:work|operate)\s+(?:only\s+locally|locally\s+only)\b/i;
const artifactOnly = /\b(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:only|just)\s+(?:(?:a|the)\s+)?(?:patch|diff)|(?:(?:a|the)\s+)?(?:patch|diff)\s+only)\b|\b(?:only|just)\s+(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:a|the)\s+)?(?:patch|diff)\b/i;
const awaitReview = /\b(?:wait(?:\s+for)?|await)\s+(?:(?:my|our|your|the|an?|explicit|human|owner|user)\s+){0,3}(?:review|approval|permission|confirmation|consent)\b/i;
const heldForApproval = /\b(?:hold|keep|leave)\s+(?:(?:the|this|these|my|our)\s+)?(?:changes?|edits?|work|code|it|them)\s+(?:for|until|pending)\s+(?:(?:my|our|the|explicit|human|owner)\s+){0,3}(?:approval|permission|confirmation|consent)\b/i;
const deliveryControl = text => controlledAction(text) || [controlledWork, localWork, artifactOnly, awaitReview, heldForApproval].some(pattern => pattern.test(text));
// Owner authorization prerequisites affect the whole task. Technical conditions
// (if a name is empty; commit a database transaction after validation) remain
// implementation scope. Conditional/negative publication clauses themselves are
// independently rejected by `qualified` above; punctuation cannot erase them.
const requestedApproval = /\b(?:ask|obtain|request|require)\s+(?:for\s+)?(?:(?:the|explicit|further|manual)\s+)*(?:my|our|your|owner)\s+(?:(?:explicit|further|manual)\s+)*(?:review|approval|permission|confirmation|consent|go-ahead)\b/i;
const conditionedApproval = /\b(?:before|after|until|unless|pending|once|when|if|provided|subject\s+to|conditioned\s+on)\b[^.!;\n]*\b(?:(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)\s+(?:approve|confirm|consent|permit|agree|review|authorize)|(?:my|our|your|owner|human|manual|explicit)\s+(?:review|approval|permission|confirmation|consent))\b/i;
const requiredApproval = /\b(?:my|our|your|owner)\s+(?:approval|permission|confirmation|consent)\s+(?:(?:is|are|must\s+be)\s+)?(?:required|needed|pending|first)\b|\bask\s+(?:me|us|the\s+owner)\s+(?:first|before)\b|(?:^|[.!;\n])\s*(?:approval|permission|confirmation|consent)\s+(?:(?:is|are|must\s+be)\s+)?(?:required|needed|pending|first)\s*(?:[.!;]|$)/i;
const standalonePrerequisite = /(?:^|[.!;\n])\s*(?:only\s+(?:after|before|until|when|if)|not\s+until)\b/i;
const approvalAction = /\b(?:approval|permission|confirmation|consent)\b[^.!;\n]*?\b(?:before|after|until|for|to)\s+(?:we\s+|you\s+)?(?:(?:run|running)\s+)?(?<git>git\s+)?(?<verb>proceed(?:ing)?|continu(?:e|ing)|publish(?:ing)?|push(?:ing)?|commit(?:ting)?|open(?:ing)?|creat(?:e|ing)|submit(?:ting)?)\b/ig;
const approvalForWorkflow = text => [...text.matchAll(approvalAction)].some(match => {
  const { verb, git } = match.groups, tail = text.slice(match.index + match[0].length);
  if (/^(?:push|commit)/i.test(verb)) return workflowSequence(verb, tail, git);
  if (/^(?:open|creat|submit)/i.test(verb)) return /^\s+(?:(?:a|the|one)\s+)?(?:pr|pull\s+request)\b/i.test(tail);
  return true;
});
const ownerPrerequisite = text => approvalForWorkflow(text) || [requestedApproval, conditionedApproval, requiredApproval, standalonePrerequisite].some(pattern => pattern.test(text));
const stable = value => JSON.stringify(value, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

// Keep offsets in JavaScript UTF-16 units, explicitly. Mask literals before
// locating punctuation or directives: examples/code are not publication authority.
const apostrophe = (source, index) => /[\p{L}\p{N}]/u.test(source[index - 1] || "") && /[\p{L}\p{N}]/u.test(source[index + 1] || "");
function literalClose(source, start, close) {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (!source.startsWith(close, i) || (["'", "’"].includes(close) && apostrophe(source, i))) continue;
    if (close[0] === "`" && (source[i - 1] === "`" || source[i + close.length] === "`")) continue;
    return i;
  }
  return -1;
}
function outsideLiterals(source, saved = false) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i], smart = c === "“" || c === "‘";
    const opener = smart || c === '"' || c === "`" || c === "'" && !/[\p{L}\p{N}]/u.test(source[i - 1] || "");
    if (!opener) { out += c; continue; }
    const close = smart ? c === "“" ? "”" : "’" : c === "`" ? source.slice(i).match(/^`+/)[0] : c;
    const end = literalClose(source, i + (c === "`" ? close.length - 1 : 0), close);
    if (end === -1) {
      // Historical v1/v2 ownership used an open ASCII literal through EOF.
      // Preserve those approved spans, but never create or answer a new task
      // with a malformed literal that could hide a delivery restriction.
      if (smart) { out += c; continue; }
      if (!saved) fail("literal examples need matching closing delimiters");
      out += source.slice(i).replace(/[^\n]/g, " "); break;
    }
    const length = end + close.length - i;
    out += source.slice(i, i + length).replace(/[^\n]/g, " "); i += length - 1;
  }
  return out;
}
// Only the PR modifier in an explicit software/document object is ignored by
// workflow recognition. Preserve its suffix and every other action/condition.
function outsideFeatureObjects(text) {
  return text.replace(/\b(?:pull[\s-]+requests?|prs?)(?=\s+(?:(?:details?|review|status)\s+)?(?:templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?)\b)/ig, match => " ".repeat(match.length));
}

export function ownerDelivery(source) {
  const value = partitionOwnerDelivery(source, 2);
  const masked = outsideFeatureObjects(outsideLiterals(source));
  const outsidePublication = (value?.spans || []).filter(span => span.owner === "coordinator").reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (deliveryControl(outsidePublication) || ownerPrerequisite(outsidePublication)) fail("withheld, local-only or approval-dependent delivery needs an explicit supported delivery contract");
  return value;
}

// Version one remains canonical for saved tasks: changing its boundaries would
// silently rewrite accepted provider requirements and invalidate their receipts.
function partitionOwnerDelivery(source, version, saved = false) {
  if (typeof source !== "string" || !source.trim()) fail("a nonempty owner request is required");
  const masked = outsideFeatureObjects(outsideLiterals(source, saved)), deliveries = [];
  let from = 0;
  const statements = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === ";" || masked[i] === "\n" || /[.!]/.test(masked[i]) && /\s|$/.test(masked[i + 1] || "")) {
    statements.push([from, i + 1]); from = i + 1;
  }
  statements.push([from, source.length]);
  let previousStatement = "";
  for (const [start, end] of statements) {
    const visible = masked.slice(start, end), matches = [...visible.matchAll(directive)];
    const inherited = /:\s*$/.test(previousStatement) ? previousStatement : "";
    if (visible.trim()) previousStatement = visible;
    if (!matches.length) {
      // Unrecognized affirmative wording is no safer to delegate than a
      // restriction. Require clarification rather than making a provider attest
      // publication that only the coordinator can perform.
      if (publicationDirective(visible)) fail("publication wording needs an explicit supported delivery contract");
      continue;
    }
    // Negation/conditions can scope a later coordinated verb. Do not guess that
    // a comma or 'and' ended that scope ("do not merge, open a PR").
    if (qualified.test(visible) || qualified.test(inherited) || matches.length !== 1) fail("negated, conditional or multiple publication clauses need an explicit supported delivery goal");
    const match = matches[0], prefix = visible.slice(0, match.index);
    const connector = prefix.match(publicationConnector);
    const boundary = /^\s*(?:please\s+)?$/i.test(prefix) || connector;
    if (!boundary) fail("publication must be an unambiguous affirmative clause, not an example or an instruction to describe it");
    // Courtesy text and punctuation belong to this clause too. Leaving a final
    // period behind would turn it into an authoritative implementation fragment.
    let a = /^\s*please\s+$/i.test(prefix) ? start + prefix.search(/\S/) : start + match.index, b = end;
    while (b > a && /\s/.test(source[b - 1])) b--;
    const clause = source.slice(a, b).replace(/;$/, "");
    if (!affirmative.test(clause)) fail("publication has unsupported qualifiers or is mixed with another action");
    // A recognized conjunction/delimiter belongs to the following publication
    // clause, not an incomplete provider requirement. Validate that clause first;
    // moving its boundary must not discard a condition or approve another action.
    if (version === 2) {
      // A connector split over statement boundaries is outside this grammar.
      // Do not leave it in provider criteria or consume another statement.
      if (publicationConnector.test(masked.slice(0, start))) fail("publication connectors must stay in the same statement as the publication clause");
      if (connector) {
        const rawConnector = source.slice(start, start + match.index).match(publicationConnector);
        if (rawConnector?.index !== connector.index) fail("publication connectors cannot contain quoted implementation text");
        a = start + connector.index;
        while (a > start && /\s/.test(source[a - 1])) a--;
      }
    }
    deliveries.push({ start: a, end: b, owner: "coordinator", kind: "pull_request" });
  }
  if (!deliveries.length) return null;
  const outsidePublication = deliveries.reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (ownerPrerequisite(outsidePublication)) fail("publication prerequisites require an explicit clarified task contract");
  if (deliveries.length !== 1) fail("one task can publish only one review PR");
  const spans = [], publication = deliveries[0];
  if (publication.start > 0) spans.push({ start: 0, end: publication.start, owner: "implementation" });
  spans.push(publication);
  if (publication.end < source.length) spans.push({ start: publication.end, end: source.length, owner: "implementation" });
  const implementation = spans.filter(s => s.owner === "implementation").map(s => source.slice(s.start, s.end)).join(" ")
    .replace(/\b(?:please|and|then)\b/ig, "").split(/[;.!\n]/)
    .filter(s => !/^\s*(?:do\s+not\b|never\b|no\b|scope\s*:)/i.test(s) || [...s.matchAll(controlledActionPattern)].some(match => !match.groups.git && technicalOperation(match.groups.verb, s.slice(match.index + match[0].length)))).join(" ");
  if (!/[\p{L}\p{N}]/u.test(implementation)) fail("describe the implementation as well as its delivery");
  return { version, offsets: "utf16", source, spans };
}

export function validateOwnerDelivery(value) {
  if (!value || ![1, 2].includes(value.version) || typeof value.source !== "string" || stable(partitionOwnerDelivery(value.source, value.version, true)) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  return value;
}

export function assertDeliveryAnswer(task, text) {
  const visible = outsideFeatureObjects(outsideLiterals(text));
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
    typeof entry.repo === "string" && entry.repo.trim().length > 0 &&
    typeof entry.base === "string" && entry.base.trim().length > 0 &&
    delivery.repository === entry.repo && delivery.pr === entry.pr && Number.isSafeInteger(delivery.pr) && delivery.pr > 0 &&
    typeof delivery.head === "string" && delivery.head.length > 0 && delivery.head === entry.cursor?.fixed_sha && delivery.base === entry.base);
}
