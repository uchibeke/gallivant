// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
const negativeModal = String.raw`(?:(?:do|does|did|can|could|may|might|must|should|will|would|shall|need|is|are)\s+not|cannot|(?:don|doesn|didn|can|couldn|mayn|mightn|mustn|shouldn|won|wouldn|shan|needn|isn|aren)['’]t)`;
const prohibitionVerb = String.raw`forbid(?:s|den|ding)?|prohibit(?:s|ed|ing)?|ban(?:s|ned|ning)?|disallow(?:s|ed|ing)?|prevent(?:s|ed|ing)?|refrain|abstain|stop|pause|cancel|defer|delay`;
const negativeLead = String.raw`${negativeModal}|never|avoid|without|no|skip|neither|nor|${prohibitionVerb}`;
const directive = /\b(?:open|create|raise|submit)\s+(?:(?:one|a|an|the|single|another)\s+)?(?:new\s+)?(?:pull\s+request|pr)\b/ig;
const affirmative = /^(?:please\s+)?(?:open|create|raise|submit)\s+(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
const publicationConnector = /(?:,\s*(?:and(?:\s+then)?|then)?|\band(?:\s+then)?|\bthen)\s*$/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
// A PR/template/title or published-article subject is not a publication request.
// Recognize actual actions and controls; supported affirmative clauses are still
// partitioned below, while unsupported/conditional forms require clarification.
// A workflow PR object can have arbitrary qualifiers ("any GitHub PR", "an
// experimental review PR"). Stop at references or another clause instead of
// enumerating adjectives or consuming "a report about the PR" as a PR action.
const publicationObjectBoundary = String.raw`and|or|nor|then|but|to|of|for|from|with|without|using|about|before|after|until|unless|when|if|while|because|by|on|in|at|into|onto|through|via|that|which|whose|where|referencing|mentioning|describing|concerning|regarding|reviewing|documenting|related`;
const publicationObjectLead = String.raw`(?:(?:(?:any|all|some|each|none|one)\s+of\s+)?(?!(?:${publicationObjectBoundary})\b)[\p{L}\p{N}_'’-]+\s+)*`;
const savedPublicationObjectLead = String.raw`(?:(?:one|a|an|the|single|another|new)\s+)*`;
const publicationActionPattern = current => new RegExp(String.raw`\b(?:open|create|raise|submit|send|prepare${current ? "|make|generate|produce|start|begin|file|issue|publish|deliver|draft" : ""})\s+${current ? publicationObjectLead : savedPublicationObjectLead}(?:pull[\s-]+requests?|prs?)\b|\b(?:start|begin)\s+publishing\b|\b(?:send|submit)\b[^.!;\n]*\bfor\s+(?:human\s+|code\s+)?review\b`, current ? "iu" : "i");
const publicationAction = publicationActionPattern(true), savedPublicationAction = publicationActionPattern(false);
// An imperative or coordinated action is a delivery direction. A feature's noun
// or infinitive ("a publish button", "a command to publish docs") is not.
const publishCommand = text => [...text.matchAll(/\bpublish\b/ig)].some(match =>
  /(?:^|[.!;:\n,]|\b(?:and|then|do\s+not|don['’]t|never|only|must|should|shall|please|avoid|prevent|without|skip|want\s+you\s+to|need\s+you\s+to))\s*(?:(?:please|ever|again|now|[a-z]+ly)\s+)*$/i.test(text.slice(0, match.index)));
const withheldPublication = /\b(?:no|not|never|without|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:(?:any|a|the|all|new)\s+)*(?:pull[\s-]+requests?|prs?|publication|publishing)\b/i;
const publicationRequirementPattern = current => {
  const subject = current ? String.raw`(?:['’]s|['’])?\s+(?:(?:creation|opening|submission|generation|production|preparation|publication|publishing|delivery|drafting)\s+)?` : String.raw`\s+`;
  return new RegExp(String.raw`\b(?:pull[\s-]+requests?|prs?|publication|publishing)${subject}(?:(?:${current ? negativeModal + "|" : ""}must|should|will|can|may|shall|is|are|be|not|never|only)\s+)*(?:created|opened|submitted|published|required|needed|allowed|permitted|forbidden${current ? "|prohibited|disallowed|banned" : ""}|requires?|needs?|awaits?)\b`, "i");
};
const publicationRequirement = publicationRequirementPattern(true), savedPublicationRequirement = publicationRequirementPattern(false);
const publicationCondition = /\b(?:pull[\s-]+requests?|prs?|publication|publishing)\s+(?:(?:is|are|will\s+be|must\s+be)\s+)?(?:only\s+)?(?:after|before|until|when|if|unless|pending|subject\s+to)\b/i;
function outsideApplicationPublications(text, saved = false) {
  // Mask only the application verb, not its object or a following action. The
  // negative-sequence check still sees the full text and any later Git control.
  return text.replace(/\b(?:publish(?:ing)?|publication)\b/ig, (verb, offset) =>
    technicalOperation(verb, text.slice(offset + verb.length), saved) && (saved || !mixedApplicationObjects(verb, text.slice(offset + verb.length))) ? " ".repeat(verb.length) : verb);
}
function publicationDirective(text, saved = false) {
  const visible = outsideApplicationPublications(text, saved);
  return publishCommand(visible) || [saved ? savedPublicationAction : publicationAction, withheldPublication].some(pattern => pattern.test(visible)) ||
    !saved && publicationGerundProhibition.test(visible) ||
    [saved ? savedPublicationRequirement : publicationRequirement, publicationCondition].some(pattern => pattern.test(text));
}
// Recognize directions about the workflow, not implementation nouns (a local
// store, review dashboard or diff viewer). This bounded grammar does not infer
// permission; unsupported explicit publication wording is refused separately.
// Direct and coordinated restrictions use the same bounded modal/subject forms.
const controlAdverb = String.raw`(?:under|in|at|by|for|on|without)\s+(?:(?:any|a|the|all|no|these|those|my|our|your|every)\s+)*[a-z][\w-]*(?:\s+whatsoever)?`;
const actionLeadFor = current => String.raw`(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:should|must|may|can|could|would|will|shall|do|does|did)\s+)?(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:not|ever|again|now|first${current ? `|please|even|once|just|only|${controlAdverb}` : ""}|[a-z]+ly)\s+)*(?:(?:run|running)\s+)?`;
const actionLead = actionLeadFor(true);
const actionVerb = (current = true) => String.raw`(?<git>git\s+)?(?<verb>push(?:es|ing)?|commit(?:s|ting)?|deliver(?:ing|y)?|publish(?:ing)?${current ? "|publication|creat(?:e|ing)|mak(?:e|ing)|generat(?:e|ing)|produc(?:e|ing)" : ""})\b`;
const coordination = String.raw`and|or|nor|as\s+well\s+as|along\s+with|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides|plus`;
const permissionLead = String.raw`(?:(?:be\s+)?(?:allowed|permitted|authorized|supposed|expected|required|able)\s+to\s+|(?:allow|permit)\s+)?`;
const prohibitionBridge = String.raw`(?:${publicationObjectLead}(?:from|against|to)\s+)?`;
const unfinishedControlPrefix = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}(?:(?:any|a|the|all|more|new)\s+)*${actionLead}(?:to\s*)?$`, "iu");
const publicationGerund = String.raw`opening|creating|raising|submitting|sending|preparing|making|generating|producing|starting|beginning|filing|issuing|publishing|delivering|drafting`;
const publicationGerundProhibition = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}${publicationObjectLead}(?:${publicationGerund})\s+(?:of\s+)?${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\b`, "iu");
const controlledActionPattern = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}(?:(?:any|a|the)\s+)?${actionLead}${actionVerb()}`, "igu");
const gitArtifactObject = tail => /^\s+(?:(?:any|a|an|the|this|that|these|those|new|another|additional|more)\s+)*(?:git\s+)?(?:commits?|branch(?:es)?)\b/i.test(outsideFeatureObjects(tail));
const coordinatedObjects = (tail, predicate) => [...tail.split(/[.!;\n]/)[0].matchAll(new RegExp(String.raw`\b(?:${coordination})\b|,`, "ig"))].some(match => predicate(tail.slice(match.index + match[0].length)));
const gitArtifactSequence = tail => gitArtifactObject(tail) || coordinatedObjects(tail, gitArtifactObject);
const objectHead = tail => tail.replace(/^\s+(?:of\s+)?/i, "").split(/[.!;\n,]|\b(?:and|or|nor|but|then|to|into|onto|on|via|through|using|from|in|at|for|with|twice|before|after|until|unless|when|if|once)\b/i)[0];
const workflowObject = (tail, saved = false) => {
  const object = outsideFeatureObjects(objectHead(tail));
  return /\b(?:git|github|remote|origin|upstream|pull[\s-]+requests?|prs?|commits?|branch(?:es)?|changes?|edits?|code|patch(?:es)?|work|implementation|release|build|package|results?|outputs?|anything|everything|nothing|it|them|this|that)\b/i.test(object) ||
    !saved && /\b(?:solutions?|tasks?|deliverables?|artifacts?|fix(?:es)?|updates?|modifications?|revisions?|features?)\s*$/i.test(object);
};
const mixedApplicationObjects = (verb, tail) => {
  // For prohibitions, retain unrecognized object phrases: an adjective before
  // "changes" or "the PR" cannot hide a workflow object. Known later actions
  // are checked independently, so a database commit is not a Git object here.
  const next = [...tail.matchAll(coordinatedAction)][0];
  return /^(?:publish|publication|deliver|merge)/i.test(verb) && coordinatedObjects(tail.slice(0, next?.index), workflowObject);
};
const savedMessageObject = /^\s+(?:of\s+)?(?:(?:the|a|an|these|those|duplicate|new|existing|outgoing|incoming|user|email|webhook)\s+)*(?:events?|messages?|notifications?|emails?|webhooks?)\b/i;
const savedApplicationDestination = /\b(?:to|into|onto|via|through|on)\s+(?:[\w-]+\s+)*(?:bus|queue|topic|broker|webhook|kafka|rabbitmq|nats|s3|gcs|r2|minio|storage|buckets?|sftp|ftp|scp)\b/i;
// Object names are open vocabulary. A shared explicit application destination
// supplies context; named workflow objects and bare temporal/adverbial controls
// never become application data just because another object follows them.
const applicationObject = (tail, saved = false) => {
  const head = objectHead(tail).trim();
  return !workflowObject(tail, saved) && /[\p{L}\p{N}]/u.test(head) &&
    !/^(?:only|now|yet|today|tomorrow|later|again|online|pending|without|never|not|[a-z]+ly)$/i.test(head);
};
// Data-transfer actions are boundaries too, although they are not coordinator
// controls themselves. Require an object after the verb so plural nouns such
// as "logs to S3" and "archives to S3" can still share a destination.
const dataActionVerb = String.raw`(?:up|down)load(?:s|ing)?|cop(?:y|ies|ying)|mov(?:e|es|ing)|stor(?:e|es|ing)|sav(?:e|es|ing)|writ(?:e|es|ing)|send(?:s|ing)?|read(?:s|ing)?|fetch(?:es|ing)?|sync(?:s|ing)?|synchroniz(?:e|es|ing)|transfer(?:s|ring)?|persist(?:s|ing)?|record(?:s|ing)?|emit(?:s|ting)?|export(?:s|ing)?|import(?:s|ing)?|archiv(?:e|es|ing)|collect(?:s|ing)?|back(?:s|ing)?\s+up|log(?:s|ging)?|ship(?:s|ping)?`;
const dataActionPattern = new RegExp(String.raw`\b(?:${dataActionVerb})\b\s+(?!(?:to|into|onto|on|via|through|for|from|with|using|in|at|before|after|and|or|nor)\b)\S`, "ig");
const dataActionLead = new RegExp(String.raw`^${actionLead}(?:(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}${actionLead})?$`, "iu");
const compoundDataObject = /^(?:log\s+entries|(?:download|upload)\s+(?:links?|urls?|paths?|names?|ids?|metadata))\b/i;
const dataAction = text => [...text.matchAll(dataActionPattern)].some(match => {
  const lead = text.slice(0, match.index);
  return dataActionLead.test(lead) || positiveActionLead.test(lead);
});
// An explicit destination permits an open application object, but borrowing a
// later object's destination requires positive noun-phrase evidence. Unknown
// words before an object may be verbs ("forward reports", "relay records");
// absence from the action vocabulary is not evidence that they are modifiers.
// Keep open noun heads with determiners, grammatical modifiers and established
// compounds. Ambiguous bare phrases can put a destination on each action.
// Suffixes are not evidence of a modifier: "give", "apply", "seal" and
// "seed" are imperative verbs. This bounded vocabulary is positive evidence,
// not a growing exclusion list of verbs. Unrecognized modifiers need an
// explicit destination; noun heads themselves remain open vocabulary.
const nounModifier = /^(?:new|existing|sent|tax|billing|daily|weekly|monthly|quarterly|annual|regional|archived|uploaded|downloaded|stored|copied|customized|cached|processed|normalized|validated|compressed|encrypted|sanitized|anonymized|redacted|generated|collected|aggregated)$/i;
const determinedModifier = /^(?:duplicate|parallel)$/i;
const bareDataNoun = /^(?:[\p{L}\p{N}-]+(?<!s|u)s|data|metadata|telemetry)$/iu;
const sharedApplicationObject = tail => {
  if (!applicationObject(tail)) return false;
  const head = objectHead(tail).trim();
  const words = head.split(/\s+/);
  const determined = /^(?:a|an|the|these|those|my|our|your|any|all|some)$/i.test(words[0]);
  if (determined) words.shift();
  // "log entries" and "download links" are both commands and noun compounds.
  // Only an explicit determiner establishes the noun reading for shared scope.
  const compound = words.join(" ");
  if (determined && compound.match(compoundDataObject)?.[0] === compound) return true;
  const noun = words.pop();
  return Boolean(noun && (determined || bareDataNoun.test(noun)) && words.every(word => nounModifier.test(word) || determined && determinedModifier.test(word)));
};
function actionTail(tail) {
  // A destination belongs to this action, not a later coordinated action or
  // incidental source/metadata. Keep shared destinations for noun lists.
  const sentence = tail.split(/[.!;\n]|\b(?:before|after|while|when|until|unless|if|because)\b|\bfor\s+(?:(?:human|code)\s+)?review\b/i)[0];
  for (const match of sentence.matchAll(new RegExp(String.raw`\b(?<conjunction>${coordination}|then|but)\s+|,\s*(?:(?:and|or|nor)\s+)?`, "ig"))) {
    const initial = sentence.slice(0, match.index);
    const remaining = sentence.slice(match.index + match[0].length);
    const nextAction = [...sentence.slice(match.index).matchAll(coordinatedAction)][0];
    if (nextAction?.index === 0 || dataAction(remaining)) return initial;
    // Explicit Git targets still take precedence over application transports.
    const destinationList = /\b(?:to|into|onto|on|via|through)\b/i.test(initial) && /^\s*(?:(?:the|a|an|public|private)\s+)*(?:git|github|remote|origin|upstream|repository|repo)\b/i.test(remaining);
    // Purpose/condition text ("reports for review") ends the noun phrase and
    // cannot borrow a later action's destination or repetition qualifier.
    const initialObject = initial.split(new RegExp(String.raw`\b(?:${coordination})\b|,`, "i")).at(-1);
    const nounList = initialObject.trim() === objectHead(initialObject).trim() && sharedApplicationObject(initialObject) && sharedApplicationObject(remaining);
    if (/^(?:then|but)$/i.test(match.groups.conjunction || "") || !destinationList && !nounList) return initial;
  }
  return sentence;
}
function actionDestinations(tail) {
  const current = actionTail(tail);
  return [...current.matchAll(/\b(?:to|into|onto|via|through|on)\s+/ig)].map(match =>
    current.slice(match.index + match[0].length).split(/\b(?:using|with|from|for|by|while|because)\b/i)[0]);
}
function applicationDelivery(tail, saved = false) {
  // Preserve the earlier v1/v2 message exception only when validating saved
  // spans; new requests must pass the contextual checks below.
  if (saved && savedMessageObject.test(tail)) return true;
  // Application context may come from the object, a transport, repeated delivery
  // or nominal "delivery of ...". Unknown nouns alone never waive a workflow
  // restriction ("do not publish the solution").
  const scoped = saved ? tail : actionTail(tail);
  const head = objectHead(scoped).replace(/^(?:(?:the|a|an|any|all|these|those|my|our|your|new|existing|duplicate)\s+)*/i, "").trim();
  if (!head || /^(?:only|now|yet|today|tomorrow|later|again|online|pending|without|never|not|[a-z]+ly)\b/i.test(head) && !applicationObject(scoped, saved)) return false;
  const destinations = actionDestinations(tail);
  const gitDestination = destinations.some(destination => /\b(?:git(?:hub)?|remote|origin|upstream|repository|repo)\b/i.test(destination));
  const applicationDestination = destinations.some(destination => /\b(?:bus|queue|topic|broker|webhook|kafka|rabbitmq|nats|s3|gcs|r2|minio|storage|buckets?|sftp|ftp|scp)\b/i.test(destination)) ||
    saved && savedApplicationDestination.test(tail);
  const applicationContext = /^\s+of\s+/i.test(tail) || /\b(?:events?|messages?|notifications?|emails?|webhooks?)\b/i.test(head) ||
    /\b(?:twice|duplicates?|multiple\s+times|more\s+than\s+once)\b/i.test(scoped);
  const workflow = workflowObject(scoped, saved);
  return !gitDestination && (applicationDestination && (saved || !workflow) || applicationContext && !workflow);
}
function technicalOperation(verb, tail, saved = false) {
  if (/^commit/i.test(verb)) return /^\s+(?:(?:the|a|this|that)\s+)?(?:(?:database|sql|db)\s+)?transactions?\b/i.test(tail);
  if (/^push/i.test(verb)) return /^\s+(?:(?:the|a|an|this|that|duplicate|new|existing)\s+)*(?:items?|elements?|values?|records?|messages?|entries)\s+(?:onto|into|to)\s+(?:(?:the|a|an|this|that)\s+)?(?:queue|stack|array|list)\b/i.test(tail);
  if (/^(?:publish|publication|deliver)/i.test(verb)) return applicationDelivery(tail, saved);
  if (/^(?:creat|mak|generat|produc)/i.test(verb)) return !gitArtifactSequence(tail);
  if (/^merge/i.test(verb)) {
    const head = objectHead(tail).trim().replace(/^(?:(?:a|an|the|any|all|some|more|only|just|please|my|our|your)(?:\s+|$))+/i, "").replace(/\s+please$/i, "");
    const targets = [...actionTail(tail).matchAll(/\b(?:from|to|into|onto|with)\s+/ig)].map(match => objectHead(tail.slice(match.index + match[0].length)));
    const data = bareDataNoun.test(head.split(/\s+/).at(-1) || "") || /\b(?:arrays?|objects?|records?|contacts?|rows?|accounts?|files?|invoices?|streams?|maps?|dictionar(?:y|ies)|payloads?|configurations?|tables?|datasets?|database|json|sql)\b/i.test(head);
    const headCountData = /^head\s+counts?$/i.test(head) && /\b(?:to|into)\s+(?:the\s+)?database\b/i.test(actionTail(tail));
    return Boolean(head) && data && (headCountData || !gitMergeReference(head)) && !targets.some(target => workflowObject(target) || gitMergeReference(target)) &&
      !/^(?:now|yet|today|tomorrow|later|again|online|pending|without|never|not)(?:\s|$)/i.test(head) && applicationObject(tail) && applicationObject(` ${head}`) && !mixedApplicationObjects(verb, tail);
  }
  return false;
}
function gitMergeReference(value) {
  const ref = value.trim().replace(/^(?:a|an|the)\s+/i, "");
  const qualified = /^(?:(?:git|remote|local)\s+)*(?:branches?|tags?|revisions?|commits?|refs?|references?|remotes?|heads?)\s+(.+)$/i.exec(ref);
  if (qualified) {
    const operand = qualified[1].trim();
    // Typed application compounds describe data, while a single ref token or
    // revision expression after a qualifier identifies the Git operand.
    if (/^(?:counts?|metadata|data|details?|names?|labels?|statistics|metrics|records?|objects?|payloads?|schemas?|models?|tables?|fields?)\s+(?:data|metadata|records?|objects?|tables?)$/i.test(operand)) return false;
    return !/\s/.test(operand) || gitMergeReference(operand);
  }
  // Git refs cannot contain whitespace. Named data fields such as "the main
  // table" remain data, while bare branch names, qualified refs and revisions
  // cannot supply application evidence.
  return !/\s/.test(ref) && (/^(?:main|master|develop|development|dev|stage|staging|prod|production|release|trunk|head|fetch_head|orig_head|merge_head|v\d+)$/i.test(ref) || /[\/~^@]/.test(ref) || /^[a-f0-9]{7,64}$/i.test(ref));
}
// Negation also spans "nor", including technical actions before a Git action.
// A technical exception for one verb must never exempt the rest of the sequence.
const coordinatedPattern = current => new RegExp(String.raw`(?:\b(?:${current ? coordination : "and|or|nor"}|then|but)\s+|,\s*(?:(?:and|or|nor|then|but)\s+)?)${actionLeadFor(current)}${actionVerb(current)}`, "ig");
const coordinatedAction = coordinatedPattern(true), savedCoordinatedAction = coordinatedPattern(false);
const workflowAction = (verb, tail, git, saved = false) => Boolean(git) || !technicalOperation(verb, tail, saved) || !saved && mixedApplicationObjects(verb, tail);
function workflowSequence(verb, tail, git, saved = false) {
  const rest = tail.split(/[.!;\n]/)[0];
  return workflowAction(verb, rest, git, saved) || [...rest.matchAll(saved ? savedCoordinatedAction : coordinatedAction)].some(match => workflowAction(match.groups.verb, rest.slice(match.index + match[0].length), match.groups.git, saved));
}
const negativeClause = new RegExp(String.raw`\b(?:${negativeLead})\b`, "ig");
const controlledAction = text => [...text.matchAll(controlledActionPattern)].some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length), match.groups.git)) ||
  [...text.matchAll(negativeClause)].some(negative => {
    // An unknown first application verb ("do not log keys or commit changes")
    // must not erase a later coordinated workflow restriction. Conditions and
    // independent statements end this scope; literals are already masked.
    const clause = text.slice(negative.index + negative[0].length).split(/[.!;\n]|\b(?:before|after|while|when|until|unless|if|because)\b/i)[0];
    return [...clause.matchAll(coordinatedAction)].some(match => workflowAction(match.groups.verb, clause.slice(match.index + match[0].length), match.groups.git));
  });
const controlledWorkPattern = /\b(?:stop|pause|cancel|hold|withhold|delay|defer|skip)\s+(?:(?:the|this|these|my|our|your|all|any)\s+)?(?<verb>changes?|edits?|work|code|implementation|tasks?|runs?|push(?:es|ing)?|commit(?:s|ting)?|delivery|publication|review|it|them|everything)\b|\b(?:stop|pause|cancel)\s*(?:[.!;]|$)/ig;
const controlledWork = text => [...text.matchAll(controlledWorkPattern)].some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length)));
// Affirmative workflow merges are never delegated to implementation. Negative
// merge constraints and product features remain requirements; literals are masked
// by the caller. This check applies only to new requests/answers, not saved spans.
const mergeAction = /\b(?:(?:(?:enable|allow|turn\s+on|set)\s+(?:the\s+)?|set\s+(?:(?:this|that|the|a)\s+)?(?:pr|pull\s+request)\s+to\s+)(?<auto>auto[-\s]?merge|automatic\s+merging)|(?<git>git\s+)?(?<verb>(?:(?:auto|squash|rebase)[-\s]?)?merge))\b/ig;
// Positive auxiliary sequences share one grammar ("will need to", "will have
// to", "will be required to"). Negatives are intentionally absent.
const positiveActionLead = /(?:^|[.!;:\n,]|\b(?:and|then))\s*(?:please\s+)?(?:(?:you|we|I|the\s+agent)\s+)?(?:(?:must|should|can|could|may|might|will|would|shall|needs?|wants?|requires?|requests?|expects?|instructs?|directs?|orders?|tells?|asks?|demands?|mandates?|authoriz(?:e|es)|allows?|permits?|assigns?|tasks?|make\s+sure|makes?|gets?|let|let['’]s|like|have|has|be|are|is|required|expected|supposed|going|got|you|us|me|them|the\s+(?:agent|assistant|worker)|to|that|please)\s+)*(?:(?:automatically|now|first|squash|rebase)\s+)*(?:(?:run|running)\s+)?$/i;
const mergeDirective = text => [...text.matchAll(mergeAction)].some(match => positiveActionLead.test(text.slice(0, match.index)) &&
  (match.groups.git || match.groups.auto || !technicalOperation("merge", text.slice(match.index + match[0].length))));
const passiveGitProhibition = new RegExp(String.raw`\b(?:commits?|committing|branch(?:es|ing)?)(?:\s+(?:creation|generation|production))?\s+(?:(?:${negativeModal}|(?:(?:must|should|shall|may|can|will|is|are)\s+)?(?:not|never))\s+(?:to\s+)?(?:be\s+)?(?:created|generated|made|produced|written|allowed|permitted|happen|occur)|(?:(?:is|are|must\s+be|should\s+be)\s+)?(?:forbidden|prohibited|disallowed|banned))\b`, "i");
const gitArtifactProhibition = text => passiveGitProhibition.test(text) || [...text.matchAll(/\b(?:no|without)\b/ig)].some(match => gitArtifactObject(text.slice(match.index + match[0].length)));
const localWork = /\b(?:keep|leave|save|retain)\s+(?:(?:the|this|these|those|my|our|all)\s+)?(?:changes?|edits?|work|code|results?|outputs?|files?|branches|branch|it|them|this|these|those|everything)\s+(?:(?:only|strictly)\s+)?(?:local(?:ly|-only)?|unpublished|uncommitted|unpushed)\b|\b(?:keep|leave)\s+(?:only\s+)?local(?:ly)?(?=\s*(?:[.!;]|$))|\b(?:work|operate)\s+(?:only\s+locally|locally\s+only)\b/i;
const artifactOnly = /\b(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:only|just)\s+(?:(?:a|the)\s+)?(?:patch|diff)|(?:(?:a|the)\s+)?(?:patch|diff)\s+only)\b|\b(?:only|just)\s+(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:a|the)\s+)?(?:patch|diff)\b/i;
const awaitReview = /\b(?:wait(?:\s+for)?|await)\s+(?:(?:my|our|your|the|an?|explicit|human|owner|user)\s+){0,3}(?:review|approval|permission|confirmation|consent)\b/i;
const heldForApproval = /\b(?:hold|keep|leave)\s+(?:(?:the|this|these|my|our)\s+)?(?:changes?|edits?|work|code|it|them)\s+(?:for|until|pending)\s+(?:(?:my|our|the|explicit|human|owner)\s+){0,3}(?:approval|permission|confirmation|consent)\b/i;
// New-request/answer validation must not reinterpret already accepted spans.
const publicationPreference = /\b(?:no|not|don['’]t|doesn['’]t|didn['’]t|never|without|avoid|prevent|skip)\s+(?:want|need|require|request)\s+(?:for\s+)?(?:(?:any|a|the|all|new)\s+)*(?:pull[\s-]+requests?|prs?|publication|publishing)\b/i;
const deliveryControl = text => controlledAction(text) || controlledWork(text) || mergeDirective(text) || gitArtifactProhibition(text) ||
  publicationPreference.test(outsideApplicationPublications(text)) || [localWork, artifactOnly, awaitReview, heldForApproval].some(pattern => pattern.test(text));
// Owner authorization prerequisites affect the whole task. Technical conditions
// (if a name is empty; commit a database transaction after validation) remain
// implementation scope. Conditional/negative publication clauses themselves are
// independently rejected by `qualified` above; punctuation cannot erase them.
const requestedApproval = /\b(?:ask|obtain|request|require)\s+(?:for\s+)?(?:(?:the|explicit|further|manual)\s+)*(?:my|our|your|owner)\s+(?:(?:explicit|further|manual)\s+)*(?:review|approval|permission|confirmation|consent|go-ahead)\b/i;
const conditionedApproval = /\b(?:before|after|until|unless|pending|once|when|if|provided|subject\s+to|conditioned\s+on)\b[^.!;\n]*\b(?:(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)\s+(?:approve|confirm|consent|permit|agree|review|authorize)|(?:my|our|your|owner|human|manual|explicit)\s+(?:review|approval|permission|confirmation|consent))\b/i;
const requiredApproval = /\b(?:my|our|your|owner)\s+(?:approval|permission|confirmation|consent)\s+(?:(?:is|are|must\s+be)\s+)?(?:required|needed|pending|first)\b|\bask\s+(?:me|us|the\s+owner)\s+(?:first|before)\b|(?:^|[.!;\n])\s*(?:approval|permission|confirmation|consent)\s+(?:(?:is|are|must\s+be)\s+)?(?:required|needed|pending|first)\s*(?:[.!;]|$)/i;
const standalonePrerequisite = /(?:^|[.!;\n])\s*(?:only\s+(?:after|before|until|when|if)|not\s+until)\b/i;
const approvalAction = /\b(?:approval|permission|confirmation|consent)\b[^.!;\n]*?\b(?:before|after|until|for|to)\s+(?:we\s+|you\s+)?(?:(?:run|running)\s+)?(?<git>git\s+)?(?<verb>proceed(?:ing)?|continu(?:e|ing)|publish(?:ing)?|deliver(?:ing)?|push(?:ing)?|commit(?:ting)?|open(?:ing)?|creat(?:e|ing)|submit(?:ting)?)\b/ig;
const approvalForWorkflow = (text, saved = false) => [...text.matchAll(approvalAction)].some(match => {
  const { verb, git } = match.groups, tail = text.slice(match.index + match[0].length);
  // These new controls apply at intake. Saved v1/v2 contracts retain the action
  // grammar under which their source spans were originally approved.
  if (saved && /^deliver/i.test(verb)) return false;
  if (/^(?:push|commit|publish|deliver)/i.test(verb)) return workflowSequence(verb, tail, git, saved);
  if (/^(?:open|creat|submit)/i.test(verb)) return /^\s+(?:(?:a|the|one)\s+)?(?:pr|pull\s+request)\b/i.test(tail);
  return true;
});
const ownerPrerequisite = (text, saved = false) => approvalForWorkflow(text, saved) || [requestedApproval, conditionedApproval, requiredApproval, standalonePrerequisite].some(pattern => pattern.test(text));
const stable = value => JSON.stringify(value, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

// Keep offsets in JavaScript UTF-16 units, explicitly. Mask literals before
// locating punctuation or directives: examples/code are not publication authority.
const apostrophe = (source, index) => /[\p{L}\p{N}]/u.test(source[index - 1] || "") && /[\p{L}\p{N}]/u.test(source[index + 1] || "");
const leadingElision = (source, index) => source[index] === "'" && !/[\p{L}\p{N}]/u.test(source[index - 1] || "") && /^(?:\d{2}s|tis|twas|twere|cause|em|til|till|round|bout)\b/i.test(source.slice(index + 1));
function literalClose(source, start, close, saved = false) {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (!source.startsWith(close, i) || (["'", "’"].includes(close) && apostrophe(source, i)) || !saved && leadingElision(source, i)) continue;
    if (close[0] === "`" && (source[i - 1] === "`" || source[i + close.length] === "`")) continue;
    return i;
  }
  return -1;
}
function outsideLiterals(source, saved = false, elisionNonOpeners = true) {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i], smart = c === "“" || c === "‘";
    const opener = smart || c === '"' || c === "`" || c === "'" && !/[\p{L}\p{N}]/u.test(source[i - 1] || "");
    if (!opener) { out += c; continue; }
    if (!saved && elisionNonOpeners && leadingElision(source, i)) { out += c; continue; }
    const close = smart ? c === "“" ? "”" : "’" : c === "`" ? source.slice(i).match(/^`+/)[0] : c;
    const end = literalClose(source, i + (c === "`" ? close.length - 1 : 0), close, saved);
    if (end === -1) {
      // Historical v1/v2 ownership used an open ASCII literal through EOF.
      // Preserve those approved spans, but never create or answer a new task
      // with a malformed literal that could hide a delivery restriction.
      if (smart || !saved && leadingElision(source, i)) { out += c; continue; }
      if (!saved) fail("literal examples need matching closing delimiters");
      out += source.slice(i).replace(/[^\n]/g, " "); break;
    }
    const length = end + close.length - i;
    out += source.slice(i, i + length).replace(/[^\n]/g, " "); i += length - 1;
  }
  return out;
}
// Only the workflow modifier in an explicit software/document object is ignored by
// workflow recognition. Preserve its suffix and every other action/condition.
// An actual PR/Git object is not automatically a fixture. These ambiguous data
// suffixes need an explicit synthetic/representation qualifier in the same noun
// phrase; clause boundaries prevent a qualifier from masking a later real action.
const localObjectLead = publicationObjectLead.replaceAll(String.raw`\s`, String.raw`[ \t]`);
const representedPrObject = new RegExp(String.raw`\b(?:mock|synthetic|fake|dummy|stub|normalized|serialized|deserialized|json|in-memory|sample|example|test|fixture)[ \t]+${localObjectLead}(?<modifier>(?:pull[ \t-]+requests?|prs?)(?:['’]s|['’])?)(?=[ \t-]+(?:objects?|records?|payloads?|schemas?|models?|representations?)\b)`, "igu");
const featureObjectsPattern = current => {
  const space = current ? String.raw`[ \t-]+` : String.raw`[\s-]+`;
  const modifierSpace = current ? String.raw`[ \t-]?` : String.raw`[-\s]?`;
  return new RegExp(String.raw`\b(?:pull${space}requests?|prs?|commits?|branch(?:es)?|(?:(?:auto|squash|rebase)${modifierSpace})?merge)(?:['’]s|['’])?(?=${space}(?:(?:details?|review|status)${space})?(?:${current ? "fixtures?|mocks?|stubs?|examples?|samples?|" : ""}templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?|selectors?|selection|messages?|reports?|summar(?:y|ies)|descriptions?|titles?|bod(?:y|ies)|labels?|comments?|discussions?|reviews?|feedback|diffs?|checks?|status(?:es)?|states?|names?|ids?|hashes?|shas?|metadata|history|counts?|links?|urls?|references?)\b)`, "ig");
};
const featureObjects = featureObjectsPattern(true), savedFeatureObjects = featureObjectsPattern(false);
function outsideFeatureObjects(text, saved = false) {
  const visible = saved ? text : text.replace(representedPrObject, (match, modifier) => match.slice(0, -modifier.length) + " ".repeat(modifier.length));
  return visible.replace(saved ? savedFeatureObjects : featureObjects, match => " ".repeat(match.length));
}

export function ownerDelivery(source) {
  const value = partitionOwnerDelivery(source, 5);
  const masked = outsideFeatureObjects(outsideLiterals(source));
  if (publicationGerundProhibition.test(masked)) fail("withheld publication needs an explicit supported delivery contract");
  const outsidePublication = (value?.spans || []).filter(span => span.owner === "coordinator").reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (deliveryControl(outsidePublication) || ownerPrerequisite(outsidePublication)) fail("withheld, local-only or approval-dependent delivery needs an explicit supported delivery contract");
  return value;
}

// Saved versions retain their historical literal scanner. Version four treats
// elisions as non-openers; version five bounds feature objects to the same line.
function partitionOwnerDelivery(source, version, saved = false) {
  if (typeof source !== "string" || !source.trim()) fail("a nonempty owner request is required");
  const masked = outsideFeatureObjects(outsideLiterals(source, saved && version < 3, !saved || version >= 4), saved && version < 5), deliveries = [];
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
    const inheritedControl = !saved && unfinishedControlPrefix.test(previousStatement);
    if (visible.trim()) previousStatement = visible;
    if (!matches.length) {
      // Unrecognized affirmative wording is no safer to delegate than a
      // restriction. Require clarification rather than making a provider attest
      // publication that only the coordinator can perform.
      if (publicationDirective(visible, saved)) fail("publication wording needs an explicit supported delivery contract");
      continue;
    }
    // Negation/conditions can scope a later coordinated verb. Do not guess that
    // a comma or 'and' ended that scope ("do not merge, open a PR").
    if (qualified.test(visible) || qualified.test(inherited) || inheritedControl || matches.length !== 1) fail("negated, conditional or multiple publication clauses need an explicit supported delivery goal");
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
    if (version >= 2) {
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
  if (ownerPrerequisite(outsidePublication, saved)) fail("publication prerequisites require an explicit clarified task contract");
  if (deliveries.length !== 1) fail("one task can publish only one review PR");
  const spans = [], publication = deliveries[0];
  if (publication.start > 0) spans.push({ start: 0, end: publication.start, owner: "implementation" });
  spans.push(publication);
  if (publication.end < source.length) spans.push({ start: publication.end, end: source.length, owner: "implementation" });
  // Negative feature requirements are meaningful work. Exclude only bare
  // delivery cautions/scope labels, preserving the historical technical exception.
  const implementation = spans.filter(s => s.owner === "implementation").map(s => source.slice(s.start, s.end)).join(" ")
    .split(/[;.!\n]/)
    .filter(s => !/^\s*(?:(?:please|and|then)\s+)*(?:scope\s*:|(?:do\s+not|never|no)\s+(?:merge|release|deploy)(?:\s*(?:,|and|or|nor)\s*(?:merge|release|deploy))*\s*$)/i.test(s) || [...s.matchAll(controlledActionPattern)].some(match => !match.groups.git && technicalOperation(match.groups.verb, s.slice(match.index + match[0].length), saved)))
    .join(" ").replace(/\b(?:please|and|then)\b/ig, "");
  if (!/[\p{L}\p{N}]/u.test(implementation)) fail("describe the implementation as well as its delivery");
  return { version, offsets: "utf16", source, spans };
}

export function validateOwnerDelivery(value) {
  if (!value || ![1, 2, 3, 4, 5].includes(value.version) || typeof value.source !== "string" || stable(partitionOwnerDelivery(value.source, value.version, true)) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  return value;
}

export function assertDeliveryAnswer(task, text) {
  const visible = outsideFeatureObjects(outsideLiterals(text));
  // Answers may refine implementation, but cannot silently replace the approved
  // publication contract, including a new prerequisite in a separate sentence.
  // Legacy exact operation replays are handled before this check by the service.
  if (publicationDirective(visible) || ownerPrerequisite(visible) || deliveryControl(visible)) fail("delivery changes in answers require a new clarified task request");
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
