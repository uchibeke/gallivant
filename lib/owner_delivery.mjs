// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
// Treat publication as an action/object construction. Keep one verb-family
// grammar for all detection and ownership checks so a new inflection cannot
// escape the restriction check or remain in provider-owned implementation text.
const publicationVerb = String.raw`(?:open\w*|creat\w*|rais\w*|submit\w*|send\w*|sent|prepar\w*|mak(?:e|es|ing)|made|fil(?:e|es|ed|ing)|generat\w*|produc\w*|publish\w*)`;
// Broad detection includes quantities, up to three direct modifiers, and grammatical
// indirect recipients. It must not scan through an unrelated object phrase
// ("create a report with PR statistics") to find a later PR reference.
const publicationQuantity = String.raw`(?:\d+|a|an|the|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|hundred|thousand|million|billion|and|dozen|couple|both|several|multiple|many|few|some|any|all|another|single|more|new|draft)`;
const publicationCountPhrase = String.raw`(?:dozens?|pairs?|couples?|scores?|hundreds?|thousands?|millions?)\s+of`;
const publicationObject = String.raw`(?:(?:${publicationQuantity})\s+)*(?:(?:${publicationCountPhrase})\s+)?(?:(?!(?:for|with|in|on|into|onto|of|to|that|which|who|when|if|after|before|until|unless|during|while|upon|following|under|by|pending|merge|containing|including|featuring|mentioning|about|regarding)\b)[a-z][a-z-]*\s+){0,3}(?:pull[\s-]+requests?|prs?)(?!-[a-z])`;
const publicationRecipientObject = String.raw`(?:(?:the|our|their|his|her)\s+)?(?:(?!(?:for|with|in|on|into|onto|of|to|that|which|who|when|if|after|before|until|unless|during|while|upon|following|under|by|pending|a|an|one|another|new|draft)\b)[\p{L}\p{N}][\p{L}\p{N}-]*\s+){1,3}(?:a|an|one|another|new|draft)\s+(?:pull\s+request|pr)(?!-[a-z])`;
const publicationTarget = String.raw`(?:${publicationRecipientObject}|${publicationObject})`;
const publicationIndirectObject = String.raw`(?:(?:me|us)\s+)?`;
const supportedPublicationObject = String.raw`(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull\s+request|pr)(?!-[a-z])`;
const publicationPhrase = new RegExp(String.raw`\b${publicationVerb}\s+${publicationIndirectObject}${publicationTarget}\b`, "igu");
// Only present/imperative forms may grant coordinator publication authority.
// Past-tense mentions ("created/opened/submitted a PR") describe prior work and
// must be clarified rather than treated as a request to publish another PR.
const supportedPublicationVerb = String.raw`(?:open(?:s)?|creat(?:e|es)|rais(?:e|es)|submit(?:s)?|mak(?:e|es))`;
const directive = new RegExp(String.raw`\b${supportedPublicationVerb}\s+${publicationIndirectObject}${supportedPublicationObject}\b`, "ig");
const affirmative = new RegExp(String.raw`^(?:please\s+)?${supportedPublicationVerb}\s+${publicationIndirectObject}${supportedPublicationObject}(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$`, "i");
// Stored v1/v2 contracts keep their original publication grammar. Saved
// records may contain inflected actions and plural PR objects that new intake
// intentionally rejects; upgrading must not reclassify an accepted span.
// This is pinned to the actual v0.2.0 producer grammar (source commit
// 04c59178), which emitted v1/v2 records with inflected verbs and plural
// objects. Do not broaden it with newer verbs, quantifiers, or indirect objects.
const savedPublicationVerb = String.raw`(?:open\w*|creat\w*|rais\w*|submit\w*|mak(?:e|es|ing))`;
const savedPublicationObject = String.raw`(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull[\s-]+requests?|prs?)`;
const savedDirective = new RegExp(String.raw`\b${savedPublicationVerb}\s+${savedPublicationObject}\b`, "ig");
const savedAffirmative = new RegExp(String.raw`^(?:please\s+)?${savedPublicationVerb}\s+${savedPublicationObject}(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$`, "i");
const savedPublicationAction = /\b(?:open\w*|creat\w*|rais\w*|submit\w*|send\w*|sent|prepar\w*|mak(?:e|es|ing)|made|fil(?:e|es|ed|ing)|publish\w*)\s+(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull[\s-]+requests?|prs?)\b|\b(?:start|begin)\s+publishing\b|\b(?:send\w*|sent|submit\w*)\b[^.!;\n]*\bfor\s+(?:human\s+|code\s+)?review\b/i;
const publicationConnector = /(?:,\s*(?:and(?:\s+then)?|then)?|\band(?:\s+then)?|\bthen)\s*$/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
// A PR/template/title or published-article subject is not a publication request.
// Recognize actual actions and controls; supported affirmative clauses are still
// partitioned below, while unsupported/conditional forms require clarification.
// An imperative or coordinated action is a delivery direction. A feature's noun
// or infinitive ("a publish button", "a command to publish docs") is not.
const publishCommand = text => [...text.matchAll(/\bpublish\b/ig)].some(match =>
  /(?:^|[.!;:\n,]|\b(?:and|then|do\s+not|don['’]t|never|only|must|should|shall|please|avoid|prevent|without|skip|want\s+you\s+to|need\s+you\s+to))\s*(?:(?:please|ever|again|now|[a-z]+ly)\s+)*$/i.test(text.slice(0, match.index)));
// A denied publication can be written with an unfamiliar construction verb
// (for example, "do not generate any PR"). Match the negative command plus its
// direct PR object, rather than growing a verb whitelist. The bounded shape
// avoids reaching through a different action such as "do not require approval
// before creating a PR"; feature objects and literals are masked by the caller.
const withheldPublicationPattern = new RegExp(String.raw`\b(?:no|not|never|without|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:${publicationTarget})\b|\b(?:no|not|never|without|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:(?:any|a|an|the|all|new|another|one|single|more)\s+)*(?:publication|publishing)\b`, "igu");
const withheldPublicationActionPattern = new RegExp(String.raw`\b(?:do(?:es)?\s+not|did\s+not|don['’]t|doesn['’]t|didn['’]t|never|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay)\s+(?:(?:ever|again|automatically|publicly|directly|silently)\s+)*(?:creat(?:e|es|ed|ing)|generat(?:e|s|ed|ing)|produc(?:e|es|ed|ing)|mak(?:e|es|ing)|open(?:s|ed|ing)|rais(?:e|es|ed|ing)|submit(?:s|ted|ting)|prepar(?:e|es|ed|ing)|fil(?:e|es|ed|ing)|publish(?:es|ed|ing)|send(?:s|ing)|sent)\s+(?:${publicationTarget})\\b`, "igu");
// A PR is a direct publication target only when the phrase ends there or is
// followed by a condition, purpose or adverb. A following noun starts a
// PR-qualified feature object such as “PR preview”, even if that noun is new.
const directPublicationTail = /^(?:\s*(?:[.!?,;:]|$)|\s+(?:for|after|before|until|when|if|unless|pending|subject\s+to|because|while|once|now|again|already|anymore|henceforth|later|soon|today|tomorrow|only|just|ever|asap|this\s+time|from\s+now\s+on|going\s+forward|no\s+longer|titled|named|against|in|on|into|onto|to|with|without|as|at|by|during|upon|following|under|via|through|and|or|nor|but|then|please)\b|\s+(?:at\s+all|under\s+(?:any|no)\s+circumstances|in\s+any\s+case|whatsoever)\b|\s+[a-z][a-z-]*ly\b)/i;
const withheldPublication = { test: text => [...text.matchAll(withheldPublicationPattern)].some(match => directPublicationTail.test(text.slice(match.index + match[0].length))) };
const publicationActionTail = directPublicationTail;
const publicationAction = text => [...text.matchAll(publicationPhrase)].some(match => publicationActionTail.test(text.slice(match.index + match[0].length))) ||
  /\b(?:start|begin)\s+publishing\b|\b(?:send\w*|sent|submit\w*)\b[^.!;\n]*\bfor\s+(?:human\s+|code\s+)?review\b/i.test(text);
const withheldPublicationAction = text => [...text.matchAll(withheldPublicationActionPattern)].some(match => directPublicationTail.test(text.slice(match.index + match[0].length)));
const publicationRequirement = /\b(?:pull[\s-]+requests?|prs?)(?!-[a-z])\s+(?:(?:must|should|will|can|may|shall|is|are|be|not|never|only)\s+)*(?:created|opened|submitted|published|required|needed|allowed|permitted|forbidden|mandatory|obligatory|compulsory|optional|prohibited|disallowed|contingent|conditional|requires?|needs?|awaits?)\b|\b(?:publication|publishing)\s+(?:(?:must|should|will|can|may|shall|is|are|be|not|never|only)\s+)*(?:created|opened|submitted|published|required|needed|allowed|permitted|forbidden|mandatory|obligatory|compulsory|optional|prohibited|disallowed|contingent|conditional|requires?|needs?|awaits?)\b/i;
// Keep a new workflow predicate visible when it governs a release condition,
// rather than masking it as a product-feature adjective.
const publicationPredicateRequirement = /\b(?:pull[\s-]+requests?|prs?)(?!-[a-z])\s+(?:(?:are|is|must(?:\s+be)?|should(?:\s+be)?|shall(?:\s+be)?|will(?:\s+be)?|can(?:\s+be)?|may(?:\s+be)?|not)\s+)*[a-z][a-z-]*\s+(?:before|after|until|when|if|unless|once|during|while|upon|following|under|by|pending|subject\s+to)\b/i;
const publicationCondition = /\b(?:pull[\s-]+requests?|prs?)(?!-[a-z])\s+(?:(?:is|are|will\s+be|must\s+be)\s+)?(?:only\s+)?(?:after|before|until|when|if|unless|pending|subject\s+to|once|at(?:\s+the\s+(?:end|start|beginning))?|by|during|while|upon|following|under)\b|\b(?:publication|publishing)\s+(?:(?:is|are|will\s+be|must\s+be)\s+)?(?:only\s+)?(?:after|before|until|when|if|unless|pending|subject\s+to|once|at(?:\s+the\s+(?:end|start|beginning))?|by|during|while|upon|following|under)\b/i;
function outsideApplicationPublications(text) {
  // Mask only the application verb, not its object or a following action. The
  // negative-sequence check still sees the full text and any later Git control.
  return text.replace(/\b(?:publish(?:ing)?|publication)\b/ig, (verb, offset) =>
    technicalOperation(verb, text.slice(offset + verb.length)) ? " ".repeat(verb.length) : verb);
}
function outsidePublicationGerundSubjects(text) {
  return text.replace(/\b(?:opening|creating|raising|submitting|sending|preparing|making|filing|generating|producing|publishing)\s+(?:(?:one|a|an|the|single|another|new|draft)\s+)*(?:pull[\s-]+requests?|prs?)(?!-[a-z])(?:\s+for\s+(?:human\s+|code\s+)?review)?(?=\s+(?:should|must|will|can|may|shall|is|are)\b)/ig,
    (phrase, offset) => {
      const statementEnd = text.slice(offset).search(/[.!;\n]/);
      const statement = text.slice(offset, statementEnd < 0 ? text.length : offset + statementEnd + 1);
      // Do not hide explicit policy predicates such as “is forbidden” or
      // “is not allowed” behind the feature-subject exception.
      if ([withheldPublication, publicationRequirement, publicationPredicateRequirement, publicationCondition].some(pattern => pattern.test(statement))) return phrase;
      return " ".repeat(phrase.length);
    });
}
// Reuse the full verb-family grammar for declarative application behavior.
// An imperative or first/second-person request has no application subject.
const thirdPersonPublicationBehavior = new RegExp(String.raw`\b${publicationVerb}\s+${publicationIndirectObject}${publicationTarget}\b`, "igu");
const workflowPublicationActor = /\b(?:coordinator|agent|assistant|executor|runner|runtime|harness|worker|bot|orchestrator|model|provider|codex|claude|gemini|copilot|cursor|devin|aider|windsurf|opencode|openhands|swe-agent)\b/i;
const declarativeApplicationSubject = /^(?:(?:the|a|an|our|this|that)\s+)?[\p{L}\p{N}][\p{L}\p{N}'’_-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’_-]*){0,5}$/u;
const instructionalPublicationSubject = /^(?:please|now|again|first|next|finally|today|tomorrow|[a-z]+ly|do(?:n['’]t)?|does(?:n['’]t)?|did(?:n['’]t)?|never|avoid|prevent|skip|cancel|stop|pause|withhold|defer|delay|must|should|can|could|would|will|shall|need|want|ensure|have|let|let['’]s|and|then|or|nor|but|to|if|unless|when|after|before|i|we|you|me|us|implement|build|add|fix|update|change|refactor|write|test|run|deploy|ship|create|generate|produce|publish|send|submit|open|make|prepare|file|raise)\b/i;
const publicationInstructionTail = /\b(?:and|or|nor|but|then|to|if|unless|when|after|before)$/i;
const applicationBehaviorGerund = /^clicking\s+(?:submit|save|continue|run|start|send|publish|open|create|the\s+\w+)\b/i;
const outsideThirdPersonPublicationBehavior = text => {
  return text.replace(thirdPersonPublicationBehavior, (phrase, offset) => {
  const prefix = text.slice(0, offset);
  const statementStart = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf(";"), prefix.lastIndexOf("\n")) + 1;
  const subject = prefix.slice(statementStart).replace(/,\s*(?:when|if|while|once|after|before|unless)\b[^,]*,/ig, " ").trim();
  return declarativeApplicationSubject.test(subject) && !workflowPublicationActor.test(subject) && !instructionalPublicationSubject.test(subject) && !publicationInstructionTail.test(subject) || applicationBehaviorGerund.test(subject) ? " ".repeat(phrase.length) : phrase;
  });
};
// A synthetic PR used as test data is not a request to publish a repository PR.
// Keep this exception narrow: require an explicit synthetic-object label and a
// nearby test/fixture context, and mask only that action/object span.
const outsideSyntheticPublicationFixtures = text => text.replace(new RegExp(publicationPhrase.source, "igu"), (phrase, offset) => {
  const prefix = text.slice(0, offset);
  const statementStart = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"), prefix.lastIndexOf(";"), prefix.lastIndexOf("\n")) + 1;
  const statementEnd = text.slice(offset).search(/[.!;\n]/);
  const statement = text.slice(statementStart, statementEnd < 0 ? text.length : offset + statementEnd + 1);
  const syntheticObject = /\b(?:fake|mock|synthetic|sample|fixture)\s+(?:pull[\s-]+requests?|prs?)\b/i.test(phrase);
  const testContext = /\b(?:(?:unit|integration|system|acceptance|end[ -]to[ -]end|e2e)\s+)?tests?\b|\btest\s+fixtures?\b|\bfixtures?\b/i.test(statement);
  return syntheticObject && testContext ? " ".repeat(phrase.length) : phrase;
});
const publicationPolicyInquiry = /\bwhether\s+(?:(?:a|an|the|these|those|any|all)\s+)?(?:pull[\s-]+requests?|prs?)(?:\s+(?:are|is|will\s+be|would\s+be|should\s+be|must\s+be|can\s+be|may\s+be|shall\s+be))?\s+(?:optional|required|needed|mandatory|obligatory|compulsory|allowed|permitted|forbidden|prohibited|disallowed|contingent|conditional)\b/ig;
const outsidePublicationPolicyInquiry = text => text.replace(publicationPolicyInquiry, phrase => " ".repeat(phrase.length));
function publicationDirective(text, historical = false) {
  const source = historical ? text : outsidePublicationPolicyInquiry(outsideSyntheticPublicationFixtures(text));
  const visible = outsidePublicationGerundSubjects(historical ? outsideApplicationPublications(source) : outsideThirdPersonPublicationBehavior(outsideApplicationPublications(source)));
  if (historical) return publishCommand(visible) || [savedPublicationAction, withheldPublication, publicationRequirement, publicationCondition].some(pattern => pattern.test(visible));
  return publishCommand(visible) || withheldPublication.test(visible) || withheldPublicationAction(visible) || publicationAction(visible) || [publicationRequirement, publicationPredicateRequirement, publicationCondition].some(pattern => pattern.test(visible));
}
// Recognize directions about the workflow, not implementation nouns (a local
// store, review dashboard or diff viewer). This bounded grammar does not infer
// permission; unsupported explicit publication wording is refused separately.
// Direct and coordinated restrictions use the same bounded modal/subject forms.
const actionLead = String.raw`(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:should|must|may|can|could|would|will|shall|do|does|did)\s+)?(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:not|ever|again|now|first|[a-z]+ly)\s+)*(?:(?:run|running)\s+)?`;
const actionVerb = (current = true) => String.raw`(?<git>git\s+)?(?<verb>push(?:es|ing)?|commit(?:s|ting)?|deliver(?:ing|y)?|publish(?:ing)?${current ? "|publication|creat(?:e|ing)|mak(?:e|ing)" : ""})\b`;
const controlledActionPattern = new RegExp(String.raw`\b(?:do\s+not|don['’]t|never|must\s+not|should\s+not|avoid|prevent|without|no|skip|neither|nor)\s+(?:(?:any|a|the)\s+)?${actionLead}${actionVerb()}`, "ig");
const gitArtifactObject = tail => /^\s+(?:(?:any|a|an|the|this|that|these|those|new|another|additional|more)\s+)*(?:git\s+)?(?:commits?|branch(?:es)?)\b(?!\s+(?:selectors?|selection|templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?)\b)/i.test(tail);
const gitArtifactSequence = tail => gitArtifactObject(tail) || [...tail.split(/[.!;\n]/)[0].matchAll(/\b(?:and|or|nor)\b|,/ig)].some(match => gitArtifactObject(tail.slice(match.index + match[0].length)));
const applicationMessage = /^\s+(?:of\s+)?(?:(?:the|a|an|these|those|duplicate|new|existing|outgoing|incoming|user|email|webhook)\s+)*(?:events?|messages?|notifications?|emails?|webhooks?)\b/i;
function technicalOperation(verb, tail) {
  if (/^commit/i.test(verb)) return /^\s+(?:(?:the|a|this|that)\s+)?(?:(?:database|sql|db)\s+)?transactions?\b/i.test(tail);
  if (/^push/i.test(verb)) return /^\s+(?:(?:the|a|an|this|that|duplicate|new|existing)\s+)*(?:items?|elements?|values?|records?|messages?|entries)\s+(?:onto|into|to)\s+(?:(?:the|a|an|this|that)\s+)?(?:queue|stack|array|list)\b/i.test(tail);
  if (/^(?:publish|publication|deliver)/i.test(verb)) return applicationMessage.test(tail);
  if (/^(?:creat|mak)/i.test(verb)) return !gitArtifactSequence(tail);
  if (/^merge/i.test(verb)) return /^\s+(?:(?:the|a|an|two|duplicate|existing|new)\s+)*(?:arrays?|objects?|records?|contacts?|streams?|maps?|dictionaries|payloads?|configurations?)\b/i.test(tail);
  return false;
}
// Negation also spans "nor", including technical actions before a Git action.
// A technical exception for one verb must never exempt the rest of the sequence.
const coordinatedPattern = current => new RegExp(String.raw`(?:\b(?:and|or|nor|then|but)\s+|,\s*(?:(?:and|or|nor|then|but)\s+)?)${actionLead}${actionVerb(current)}`, "ig");
const coordinatedAction = coordinatedPattern(true), savedCoordinatedAction = coordinatedPattern(false);
const workflowAction = (verb, tail, git) => Boolean(git) || !technicalOperation(verb, tail);
function workflowSequence(verb, tail, git, saved = false) {
  const rest = tail.split(/[.!;\n]/)[0];
  return workflowAction(verb, rest, git) || [...rest.matchAll(saved ? savedCoordinatedAction : coordinatedAction)].some(match => workflowAction(match.groups.verb, rest.slice(match.index + match[0].length), match.groups.git));
}
const controlledAction = text => [...text.matchAll(controlledActionPattern)].some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length), match.groups.git));
const controlledWorkPattern = /\b(?:stop|pause|cancel|hold|withhold|delay|defer|skip)\s+(?:(?:the|this|these|my|our|your|all|any)\s+)?(?<verb>changes?|edits?|work|code|implementation|tasks?|runs?|push(?:es|ing)?|commit(?:s|ting)?|delivery|publication|review|it|them|everything)\b|\b(?:stop|pause|cancel)\s*(?:[.!;]|$)/ig;
const controlledWork = text => [...text.matchAll(controlledWorkPattern)].some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length)));
// Affirmative workflow merges are never delegated to implementation. Negative
// merge constraints and product features remain requirements; literals are masked
// by the caller. This check applies only to new requests/answers, not saved spans.
const mergeAction = /\b(?:(?:enable|allow|turn\s+on)\s+(?:the\s+)?(?<auto>auto[-\s]?merge|automatic\s+merging)|(?<git>git\s+)?(?<verb>(?:auto[-\s]?)?merge))\b/ig;
const mergeLead = /(?:^|[.!;:\n,]|\b(?:and|then))\s*(?:please\s+)?(?:(?:(?:you|we|the\s+agent)\s+(?:must|should|can|may|will)|(?:must|should|can|may|will)\s+you|I\s+(?:want|need)\s+you\s+to)\s+)?(?:(?:automatically|now|first|squash|rebase)\s+)*(?:(?:run|running)\s+)?$/i;
const mergeDirective = text => [...text.matchAll(mergeAction)].some(match => mergeLead.test(text.slice(0, match.index)) &&
  (match.groups.git || match.groups.auto || !technicalOperation("merge", text.slice(match.index + match[0].length))));
const gitArtifactProhibition = text => [...text.matchAll(/\b(?:no|without)\b/ig)].some(match => gitArtifactObject(text.slice(match.index + match[0].length)));
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
const ownerApproval = String.raw`(?:(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)\s+(?:(?:have|has|had|do|does|did)\s+)?(?:[a-z][a-z-]*ly\s+)*(?:approv(?:e|es|ed|ing)|confirm(?:s|ed|ing)?|consent(?:s|ed|ing)?|permit(?:s|ted|ting)?|agree(?:s|d|ing)?|review(?:s|ed|ing)?|authoriz(?:e|es|ed|ing))|(?:my|our|your|owner|human|manual|explicit)\s+(?:review|approval|permission|confirmation|consent))`;
const taskExecutionAfterApproval = String.raw`(?:proceed(?:ing)?|continu(?:e|ing)|run(?:ning)?|start(?:ing)?|begin(?:ning)?|execut(?:e|ing)|implement(?:ing)?|build(?:s|ing)?|add(?:s|ed|ing)?|update(?:s|d|ing)?|fix(?:es|ed|ing)?|modif(?:y|ies|ied|ying)|chang(?:e|es|ed|ing)|edit(?:s|ed|ing)?|writ(?:e|es|ten|ing)|refactor(?:s|ed|ing)?|test(?:s|ed|ing)?|proofread(?:s|ing)?|polish(?:es|ed|ing)?|refine(?:s|d|ing)?|revise(?:s|d|ing)?|rewrite(?:s|rewrote|rewritten|rewriting)|compose(?:s|d|ing)?|draft(?:s|ed|ing)?|author(?:s|ed|ing)?|inspect(?:s|ed|ing)?|analy[sz](?:e|es|ed|ing)|research(?:es|ed|ing)?|debug(?:s|ged|ging)?|translate(?:s|d|ing)?|format(?:s|ted|ting)?|summari[sz](?:e|es|ed|ing)|optimi[sz](?:e|es|ed|ing)|publish(?:ing)?|deliver(?:ing)?|push(?:ing)?|commit(?:ting)?|deploy(?:s|ed|ing)?|appl(?:y|ies|ied|ying)\s+(?:(?:the|this|these|current|proposed)\s+)?(?:changes?|patch|migration|configuration|infrastructure|plan)\b|finish(?:es|ed|ing)?\s+(?:(?:the|this|current|remaining)\s+)?(?:task|work|implementation|changes?|migration|deployment)\b)`;
const taskExecutionAfterApprovalPattern = new RegExp(taskExecutionAfterApproval, "i");
// An approval clause controls agent work only when it is connected to an
// execution/delivery action. Business rules such as approving a refund before
// emailing a customer or approving a purchase before showing a page stay in the
// implementation requirements.
const approvalCondition = String.raw`(?:before|after|until|unless|pending|once|when|if|provided|subject\s+to|conditioned\s+on)`;
const conditionedApproval = new RegExp(String.raw`\b${approvalCondition}\b[^.!;\n]*\b${ownerApproval}\b[^.!;\n]*\b${taskExecutionAfterApproval}\b|\b${taskExecutionAfterApproval}\b[^.!;\n]*\b${approvalCondition}\b[^.!;\n]*\b${ownerApproval}\b|\b(?:do\s+not|don['’]t|never|must\s+not|should\s+not)\s+(?:proceed|continue)\b[^.!;\n]*\b(?:until|unless|after)\b[^.!;\n]*\b${ownerApproval}\b`, "i");
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
// Match approval gates around work products structurally, so ordinary
// implementation verbs do not depend on a finite verb list. A business target
// alone is not sufficient for the product-rule exception below.
const approvalWorkAction = "\\b[a-z][a-z-]*\\b(?:\\s+(?:(?:the|this|these|current|proposed|new|existing|approved|selected|requested|planned|a|an)\\s+)?[a-z][a-z-]*\\b){0,3}";
// Unknown approval targets fail closed: a new work artifact such as code,
// output, or a branch must not become an application rule merely because its
// noun was absent from a target allowlist. Preserve only complete, unambiguous
// transaction statements; an unrelated implementation action in the same
// sentence prevents the exception from applying.
const approvalDeterminers = String.raw`(?:(?:the|a|an|this|that|my|our|your|any|new|current|proposed|selected|requested|planned|overall|final|explicit)\s+)*`;
const businessApprovalTarget = String.raw`(?:refund|purchase|support\s+request|expense|loan)`;
const businessApprovalGate = "\\b" + ownerApproval + "\\s+" + approvalDeterminers + businessApprovalTarget + "\\b";
const businessApprovalOutcome = String.raw`(?:send\s+(?:the\s+customer\s+an?\s+email|an?\s+receipt)|show\s+(?:the\s+)?(?:an?\s+)?confirmation\s+page|apply\s+(?:the\s+)?discount|finish\s+(?:the\s+)?checkout|notify\s+(?:the\s+)?user)`;
const businessApprovalRule = new RegExp("^\\s*(?:(?:if|when|once)\\s+" + businessApprovalGate + "\\s*,?\\s*" + businessApprovalOutcome + "|" + businessApprovalOutcome + "\\s+(?:after|once|when)\\s+" + businessApprovalGate + ")\\s*[.!?]?\\s*$", "i");
const conditionedWorkApprovalPattern = new RegExp(approvalWorkAction + "[^.!;\\n]*\\b" + approvalCondition + "\\b[^.!;\\n]*\\b" + ownerApproval + "\\b|\\b" + approvalCondition + "\\b[^.!;\\n]*\\b" + ownerApproval + "\\b[^.!;\\n]*" + approvalWorkAction, "i");
const conditionedWorkApproval = text => String(text).split(/(?<=[.!?])\s+|[;\n]+/).some(statement =>
  !businessApprovalRule.test(statement) && !businessApprovalReference(statement) && conditionedWorkApprovalPattern.test(statement));
// A business rule may use an unfamiliar transaction noun or result verb. An
// explicit reference back to the approved entity is a structural signal that
// this is application behavior ("approve the invoice, mark it paid"), while
// separate implementation work ("approve the purchase, refine the code")
// remains an owner-approval gate. No domain noun or outcome verb list is needed.
const businessApprovalReferenceRule = new RegExp("^\\s*(?:(?:if|when|once|after|upon)\\s+\\b" + ownerApproval + "\\b\\s+" + approvalDeterminers + "(?:[a-z][a-z-]*\\s+){0,3}[a-z][a-z-]*\\s*,\\s*([^.!?]+)|([^.!?]+?)\\s+(?:after|once|when)\\s+\\b" + ownerApproval + "\\b\\s+" + approvalDeterminers + "(?:[a-z][a-z-]*\\s+){0,3}[a-z][a-z-]*)\\s*[.!?]?\\s*$", "i");
const businessApprovalReference = statement => {
  const match = businessApprovalReferenceRule.exec(statement);
  const outcome = match?.[1] ?? match?.[2] ?? "";
  return Boolean(match && /\b(?:it|them|this|that|these|those)\b/i.test(outcome) &&
    !taskExecutionAfterApprovalPattern.test(outcome) && !/\b(?:and|or|nor|but|then)\b/i.test(outcome));
};
const ownerPrerequisite = (text, saved = false) => approvalForWorkflow(text, saved) || (!saved && conditionedWorkApproval(text)) || [requestedApproval, conditionedApproval, requiredApproval, standalonePrerequisite].some(pattern => pattern.test(text));
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
// Only the PR/merge modifier in an explicit software/document object is ignored by
// workflow recognition. Preserve its suffix and every other action/condition.
const deliveryFeatureObject = /^(?:details?|descriptions?|previews?|reviews?|status(?:es)?|templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?|clients?|parsers?|checkers?|validators?|editors?|numbers?|ids?|links?|urls?|titles?|names?|references?|identifiers?|fields?|searchable|visible|easier|easy|harder|available|accessible|discoverable|sortable|filterable|editable|readable|read-only|readonly|exports?|records?|events?|history|activity|filters?|search|summaries|cards|lists|tables|charts|reports|workflows|settings|configuration|config|api|endpoint|tool|tools|integration|integrations)\b/i;
const publicationFunctionPredicate = /^(?:for|to|in|on|into|onto|against|after|before|until|unless|when|if|once|at|by|during|while|upon|following|under|pending|subject|titled|named|from|with|without|via|through|and|or|nor|but|please|whatsoever|now|then|again|first|another|one|two|three|four|five|six|dozen|multiple|several|many|few|some|this|asap|simultaneously|concurrently|separately|individually|collectively|together|immediately|automatically|publicly|quickly|later|anymore|henceforth|no\s+longer|today|tomorrow|only|just|ever|never|require|requires|required|await|awaits|forbidden|allowed|permitted)$/i;
function outsideFeatureObjects(text) {
  // A bare generic plural after "make" is a product feature when followed by a
  // predicate. This grammatical construction accepts open-ended predicates
  // (private, collapsible, read-only, future adjectives) without listing them.
  // Prepositions, title qualifiers, temporal terms, quantifiers and common
  // publication adverbs remain visible ("Make PRs for review/simultaneously").
  let result = text.replace(/\bmak(?:e|es|ing)\s+(?:the\s+)?(pull[\s-]+requests|prs)\s+([a-z][a-z-]*)/ig, (full, object, predicate, offset) => {
    // Reuse the publication-condition grammar before masking the object. This
    // keeps “only after …” and “subject to …” visible to fail-closed detection.
    const statementEnd = text.slice(offset).search(/[.!;\n]/);
    const statement = text.slice(offset, statementEnd < 0 ? text.length : offset + statementEnd + 1);
    const objectOffset = full.indexOf(object);
    if (directPublicationTail.test(text.slice(offset + objectOffset + object.length))) return full;
    if (qualified.test(predicate.replace(/-/g, "")) || publicationCondition.test(statement) || publicationRequirement.test(statement) || publicationPredicateRequirement.test(statement)) return full;
    if (publicationFunctionPredicate.test(predicate) || /[a-z]+ly$/i.test(predicate)) return full;
    return full.slice(0, objectOffset) + " ".repeat(object.length) + full.slice(objectOffset + object.length);
  });
  // Singular PR objects after “make/create” are product features when followed
  // by a noun or predicate. Keep grammatical qualifiers visible for the
  // fail-closed publication detector rather than enumerating feature nouns.
  result = result.replace(/\b(?:mak(?:e|es|ing)|creat(?:e|es|ing))\s+(?:a|an|the)\s+(pull\s+request|pr)\s+([a-z][a-z-]*)/ig, (full, object, predicate, offset) => {
    const statementEnd = text.slice(offset).search(/[.!;\n]/);
    const statement = text.slice(offset, statementEnd < 0 ? text.length : offset + statementEnd + 1);
    const objectOffset = full.indexOf(object);
    if (directPublicationTail.test(text.slice(offset + objectOffset + object.length))) return full;
    if (qualified.test(predicate.replace(/-/g, "")) || publicationCondition.test(statement) || publicationRequirement.test(statement) || publicationPredicateRequirement.test(statement)) return full;
    if (publicationFunctionPredicate.test(predicate) || /[a-z]+ly$/i.test(predicate)) return full;
    return full.slice(0, objectOffset) + " ".repeat(object.length) + full.slice(objectOffset + object.length);
  });
  // Continue masking established singular product nouns, while the rule above
  // handles arbitrary plural feature predicates structurally.
  return result
    // Asking the interface to expose a PR policy value is a UI requirement,
    // not itself an instruction that the coordinator must create a PR.
    .replace(/\b(?:display|show|render|expose|include|edit|present)\s+whether\s+(?:(?:a|an|the)\s+)?(pull[\s-]+requests?|prs?)\b/ig,
      (full, object) => full.replace(object, " ".repeat(object.length)))
    .replace(/\b(?:display|show|render|expose|include|edit|present)\s+(?:(?:the|a|an|any|current|selected)\s+)*(pull[\s-]+requests?|prs?)\s+(?:(?:is|are)\s+)?(?:optional|required|mandatory|allowed|permitted|forbidden|prohibited|disallowed)\s+(?:field|metadata|setting|option|value|label)\b/ig,
      (full, object) => full.replace(object, " ".repeat(object.length)))
    // A hyphenated adjective such as PR-ready modifies the feature noun that
    // follows; the PR token is not itself a publication object.
    .replace(/\b(?:mak(?:e|es|ing)|creat(?:e|es|ing))\s+(?:a|an|the)\s+pr-[a-z][a-z-]*\s+[a-z][a-z-]*/ig, match => " ".repeat(match.length))
    // Possessive PR metadata is a product object (title, author, checks), not
    // a publication command.
    .replace(/\b(?:pull[\s-]+requests?|prs?)(?:'s|’s|s'|s’)\s+[a-z][a-z-]*/ig, match => " ".repeat(match.length))
    .replace(/\b(?:pull[\s-]+requests?|prs?)(?=\s+([a-z][a-z-]*)\b)/ig, (match, next) =>
      deliveryFeatureObject.test(next) ? " ".repeat(match.length) : match)
    .replace(/\b(?:auto[-\s]?)?merge(?=\s+(?:(?:details?|review|status)\s+)?(?:templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?|clients?|parsers?|numbers?|ids?|links?|urls?|titles?|names?|references?|identifiers?|fields?)\b)/ig, match => " ".repeat(match.length));
}

export function ownerDelivery(source) {
  const value = partitionOwnerDelivery(source, 3);
  const masked = outsideFeatureObjects(outsideLiterals(source));
  const outsidePublication = (value?.spans || []).filter(span => span.owner === "coordinator").reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (deliveryControl(outsidePublication) || ownerPrerequisite(outsidePublication)) fail("withheld, local-only or approval-dependent delivery needs an explicit supported delivery contract");
  return value;
}

// Version one remains canonical for saved tasks: changing its boundaries would
// silently rewrite accepted provider requirements and invalidate their receipts.
function partitionOwnerDelivery(source, version, saved = false) {
  if (typeof source !== "string" || !source.trim()) fail("a nonempty owner request is required");
  // Saved v1/v2 contracts retain their historical literal and prerequisite
  // exceptions. Version 3 uses the current intake grammar even when imported.
  const historical = saved && version < 3;
  const featureMasked = outsideFeatureObjects(outsideLiterals(source, historical));
  const masked = historical ? featureMasked : outsideThirdPersonPublicationBehavior(featureMasked), deliveries = [];
  let from = 0;
  const statements = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === ";" || masked[i] === "\n" || /[.!]/.test(masked[i]) && /\s|$/.test(masked[i + 1] || "")) {
    statements.push([from, i + 1]); from = i + 1;
  }
  statements.push([from, source.length]);
  let previousStatement = "";
  for (const [start, end] of statements) {
    const visible = masked.slice(start, end);
    const matches = [...visible.matchAll(historical ? savedDirective : directive)];
    const inherited = /:\s*$/.test(previousStatement) ? previousStatement : "";
    if (visible.trim()) previousStatement = visible;
    if (!matches.length) {
      // Unrecognized affirmative wording is no safer to delegate than a
      // restriction. Require clarification rather than making a provider attest
      // publication that only the coordinator can perform.
      if (publicationDirective(visible, historical)) fail("publication wording needs an explicit supported delivery contract");
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
    if (!(historical ? savedAffirmative : affirmative).test(clause)) fail("publication has unsupported qualifiers or is mixed with another action");
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
  if (ownerPrerequisite(outsidePublication, historical)) fail("publication prerequisites require an explicit clarified task contract");
  if (deliveries.length !== 1) fail("one task can publish only one review PR");
  const spans = [], publication = deliveries[0];
  if (publication.start > 0) spans.push({ start: 0, end: publication.start, owner: "implementation" });
  spans.push(publication);
  if (publication.end < source.length) spans.push({ start: publication.end, end: source.length, owner: "implementation" });
  // Negative feature requirements are meaningful work. Exclude only bare
  // delivery cautions/scope labels, preserving the historical technical exception.
  const implementation = spans.filter(s => s.owner === "implementation").map(s => source.slice(s.start, s.end)).join(" ")
    .split(/[;.!\n]/)
    .filter(s => !/^\s*(?:(?:please|and|then)\s+)*(?:scope\s*:|(?:do\s+not|never|no)\s+(?:merge|release|deploy)(?:\s*(?:,|and|or|nor)\s*(?:merge|release|deploy))*\s*$)/i.test(s) || [...s.matchAll(controlledActionPattern)].some(match => !match.groups.git && technicalOperation(match.groups.verb, s.slice(match.index + match[0].length))))
    .join(" ").replace(/\b(?:please|and|then)\b/ig, "");
  if (!/[\p{L}\p{N}]/u.test(implementation)) fail("describe the implementation as well as its delivery");
  return { version, offsets: "utf16", source, spans };
}

export function validateOwnerDelivery(value) {
  if (!value || ![1, 2, 3].includes(value.version) || typeof value.source !== "string") fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  const expected = value.version === 3 ? ownerDelivery(value.source) : partitionOwnerDelivery(value.source, value.version, true);
  if (stable(expected) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
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
