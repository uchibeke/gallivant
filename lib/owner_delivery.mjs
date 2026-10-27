// A narrow, deterministic ownership partition for new natural-language tasks.
// Models may organize implementation criteria; they cannot reclassify owner text.
export const OWNER_DELIVERY_SECTION = "Coordinator delivery contract";
const fail = detail => { throw Object.assign(new Error(`Clarify the pull-request instruction: ${detail}. Gallivant can publish one review PR; selecting a completion target never authorizes a merge.`), { code: "TASK_DELIVERY_SCOPE" }); };
const negativeModal = String.raw`(?:(?:do|does|did|can|could|may|might|must|should|will|would|shall|need|is|are)\s+not|cannot|(?:don|doesn|didn|can|couldn|mayn|mightn|mustn|shouldn|won|wouldn|shan|needn|isn|aren)['’]t)`;
const prohibitionVerb = String.raw`forbid(?:s|den|ding)?|prohibit(?:s|ed|ing)?|ban(?:s|ned|ning)?|disallow(?:s|ed|ing)?|prevent(?:s|ed|ing)?|refrain|abstain|stop|pause|cancel|defer|delay`;
const negativeLead = String.raw`${negativeModal}|never|avoid|without|no|skip|neither|nor|${prohibitionVerb}`;
const directive = /\b(?:open|create|raise|submit|make)\s+(?:(?:me|us)\s+)?(?:(?:one|a|an|the|single|another)\s+)?(?:new\s+)?(?:pull\s+request|pr)\b/ig;
const affirmative = /^(?:please\s+)?(?:open|create|raise|submit|make)\s+(?:(?:me|us)\s+)?(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
// v3/v4 snapshots were produced by the earlier inflected publication grammar.
// Preserve its complete accepted affirmative forms on replay; new v5 intake
// intentionally uses the narrower `affirmative` grammar below.
const savedV3V4PublicationVerb = String.raw`open(?:s|ed|ing)?|creat(?:e|es|ed|ing)|rais(?:e|es|ed|ing)|submit(?:s|ted|ting)?|mak(?:e|es|ing)|made`;
const savedV3V4PublicationObject = String.raw`(?:(?:one|a|an|the|single|another|new)\s+)*(?:pull\s+request|pr)`;
const savedV3V4Affirmative = new RegExp(String.raw`^(?:please\s+)?(?:${savedV3V4PublicationVerb})\s+(?:(?:me|us)\s+)?${savedV3V4PublicationObject}(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$`, "i");
const savedV3V4Directive = new RegExp(String.raw`\b(?:${savedV3V4PublicationVerb})\s+(?:(?:me|us)\s+)?${savedV3V4PublicationObject}\b`, "ig");
const publicationConnector = /(?:,\s*(?:and(?:\s+then)?|then)?|\band(?:\s+then)?|\bthen)\s*$/i;
const leadingPublicationConnector = /^\s*(?:,\s*(?:(?:and(?:\s+then)?|then)\s*)?|(?:and(?:\s+then)?|then)\s+)/i;
const qualified = /\b(?:no|not|never|without|avoid|prevent|unless|if|when|after|before|until|whether|maybe|might|could|should|only)\b/i;
// A PR/template/title or published-article subject is not a publication request.
// Recognize actual actions and controls; supported affirmative clauses are still
// partitioned below, while unsupported/conditional forms require clarification.
// A workflow PR object can have arbitrary qualifiers ("any GitHub PR", "an
// experimental review PR"). Stop at references or another clause instead of
// enumerating adjectives or consuming "a report about the PR" as a PR action.
const publicationReferenceBoundary = String.raw`to|of|for|from|with|without|using|about|by|on|in|at|into|onto|through|via|referencing|mentioning|describing|concerning|regarding|reviewing|documenting|related`;
const publicationObjectBoundary = String.raw`and|or|nor|then|but|${publicationReferenceBoundary}|before|after|until|unless|when|if|while|because|that|which|whose|where|open(?:s|ed|ing)?|creat(?:e|es|ed|ing)|rais(?:e|es|ed|ing)|submit(?:s|ted|ting)?|send(?:s|ing)?|prepar(?:e|es|ed|ing)|mak(?:e|es|ing)|generat(?:e|es|ed|ing)|produc(?:e|es|ed|ing)|start(?:s|ed|ing)?|begin(?:s|ning)?|fil(?:e|es|ed|ing)|issu(?:e|es|ed|ing)|publish(?:es|ed|ing)?|deliver(?:s|ed|ing)?|draft(?:s|ed|ing)?|reports?|dashboards?|summar(?:y|ies)|summari[sz]ing|listing|showing|checkers?|apis?|fields?|titles?|numbers|counts?|lists?|collections?|arrays?|tables?|catalogs?|catalogues?|feeds?|indices|index(?:es)?|settings?|options?|metadata|preferences?`;
// Only count heads with clear quantity semantics match an "of PRs" phrase.
// Open noun vocabularies misread product containers such as "graph of PRs" as
// publication quantities; unknown nouns stay in the implementation grammar.
const publicationCountOf = String.raw`(?:(?:a|an|any|all|each|every|some|many|several|multiple|few|numerous|countless)\s+)?(?:(?:large|small|great|huge|vast|significant|considerable|substantial|total)\s+)?(?:dozens?|pairs?|couples?|scores?|hundreds?|thousands?|millions?|billions?|handfuls?|series|plethora|multitude|truckloads?|loads?|tons?|bunch(?:es)?|lots?|number)\s+of\s+`;
// A word that normally starts a following feature description is still a
// valid qualifier when it directly modifies the PR object ("an API PR"). A
// non-count noun followed by "of" instead heads an application collection
// ("a graph of PRs"); only explicit count phrases above may cross that relation.
// This keeps the rule structural without treating every new product-container
// noun as a publication quantity.
// Modifier words may contain any dash ("non‑fake", "draft-ready"), not only the
// ASCII hyphen; otherwise a typographic hyphen hides the PR object entirely.
// Reference relations always end the current object, even directly before a
// PR noun. The modifier exception for "API PR" must not consume "tests for PRs".
const publicationObjectLead = String.raw`(?:${publicationCountOf}|(?:(?:(?:any|all|some|each|none|one)\s+of\s+)?(?!(?:${publicationReferenceBoundary})(?![\p{L}\p{N}_\x27’\p{Pd}]))(?!(?:${publicationObjectBoundary})(?![\p{L}\p{N}_\x27’\p{Pd}])(?! +(?:pull(?: |-)+requests?|prs?)\b))(?!(?:[\p{L}\p{N}_'’\p{Pd}]+)\s+of\b)[\p{L}\p{N}_'’\p{Pd}]+\s+)*)`;
// Numeric quantities are not count nouns ("one hundred and six PRs"), so
// parse a bounded cardinal phrase before the plural workflow object rather
// than letting the generic noun grammar absorb it as an application feature.
const cardinalWord = String.raw`zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|and`;
const quantifiedPublication = new RegExp(String.raw`\b(?:open|create|raise|submit|send|prepare|make|generate|produce|start|begin|file|issue|publish|deliver|draft)\s+(?:\d[\d,]*(?:\.\d+)?|(?:${cardinalWord})(?:[\s-]+(?:${cardinalWord})){1,11})\s+(?:pull[\s-]+requests?|prs)\b`, "iu");
const currentPublicationVerbs = String.raw`open|create|raise|submit|send|prepare|make|generate|produce|start|begin|file|issue|publish|deliver|draft`;
const savedPublicationObjectLead = String.raw`(?:(?:one|a|an|the|single|another|new)\s+)*`;
// Authority follows the grammar that could emit each stored version, not the
// broader vocabulary used to detect publication controls. v2 also emitted
// inflected and plural directives (3db059f); v1 kept its original imperative.
const savedV1Affirmative = /^(?:please\s+)?(?:open|create|raise|submit)\s+(?:(?:one|a|the|single)\s+)?(?:new\s+)?(?:pull\s+request|pr)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$/i;
const savedV2PublicationVerb = String.raw`open\w*|creat\w*|rais\w*|submit\w*|mak(?:e|es|ing)|made`;
const savedV2Affirmative = new RegExp(String.raw`^(?:please\s+)?(?:${savedV2PublicationVerb})\s+${savedPublicationObjectLead}(?:pull\s+requests?|prs?)(?:\s+for\s+(?:human\s+|code\s+)?review)?[.!]?$`, "i");
const publicationActionPattern = current => {
  // Saved v1/v2 spans were produced by broader publication grammars. Keep
  // those exact durable contracts readable without accepting the same forms at
  // new-task intake.
  const verbs = current
    ? currentPublicationVerbs
    : String.raw`open(?:ed)?|creat(?:e|ed)|rais(?:e|ed)|submit(?:ted)?|send|sent|prepar(?:e|ed)|mak(?:e|es)|made|fil(?:e|ed)|publish(?:ed)?`;
  return new RegExp(String.raw`\b(?:${verbs})\s+${current ? publicationObjectLead : savedPublicationObjectLead}(?:pull[\s-]+requests?|prs?)\b|\b(?:start|begin)\s+publishing\b|\b(?:send|submit)\b[^.!;\n]*\bfor\s+${current ? publicationObjectLead : "(?:human\\s+|code\\s+)?"}review\b`, current ? "iu" : "i");
};
const publicationAction = publicationActionPattern(true), savedPublicationAction = publicationActionPattern(false);
// A synthetic PR used as test data is not a request to publish a repository PR.
// Require both an explicitly synthetic object and test/fixture context in the
// same sentence. Mask only that action/object phrase; a request for review stays
// visible and continues through the normal publication checks.
// A synthetic qualifier is evidence only as a standalone word. A negated form
// ("non-fake PR", "not-synthetic PR", "non mock PR") asks for a live object, so
// the same word boundary must not read its tail as the fixture qualifier.
const syntheticQualifierWord = String.raw`mock|fake|dummy|stub|synthetic|fabricated|sample|example|fixture`;
const syntheticQualifierNegation = String.raw`(?<!\bnon[\p{Pd}\s]|\bnot[\p{Pd}\s]|[\p{L}\p{N}]\p{Pd})`;
const syntheticQualifier = String.raw`${syntheticQualifierNegation}\b(?:${syntheticQualifierWord})\b`;
const syntheticPublicationFixture = new RegExp(String.raw`${syntheticQualifier}(?:(?![.!?;\n]).){0,32}\b(?:pull[\s-]+requests?|prs?)\b(?:(?![.!?;\n]).){0,32}\b(?:fixture|test\s+data|fixture\s+data|test\s+object)\b|${syntheticQualifier}(?:(?![.!?;\n]).){0,32}\b(?:pull[\s-]+requests?|prs?)\b\s+(?:in|within|for)\s+(?:(?:a|the)\s+)?(?:(?:unit|integration|system|acceptance|end[ -]to[ -]end|e2e)\s+)?tests?\b|\b(?:unit|integration|system|acceptance|end[ -]to[ -]end|e2e)\s+fixtures?\b(?:(?![.!?;\n]).){0,32}\b(?:pull[\s-]+requests?|prs?)\b`, "iu");
const syntheticFixtureSignal = new RegExp(syntheticQualifier, "iu");
const pullRequestSignal = /\b(?:pull[\s-]+requests?|prs?)\b/i;
// A private marker distinguishes explicit endpoints from ordinary repo paths.
const fixtureNetworkEndpoint = "\uE000";
const syntheticLiveDestination = new RegExp(String.raw`\b(?:on|against|into|onto|to|at|via|through|using)\s+${publicationObjectLead}(?:(?:github|gitlab|remote|origin|upstream|repository|repo)\b|${fixtureNetworkEndpoint})|\b(?:in|inside|within)\s+${publicationObjectLead}(?:(?:github|gitlab|remote|origin|upstream)\b|${fixtureNetworkEndpoint})`, "iu");
const fixtureQuotedDestinationPrefix = new RegExp(String.raw`\b(?:on|against|into|onto|to|at|via|through|using|in|inside|within)\s+${publicationObjectLead}$`, "iu");
// An explicit network endpoint is live regardless of its forge or host name.
// A URL needs an authority; local file:/// paths remain fixture data.
// Scheme-less domains, IPs and localhost paths are endpoints too. Do not
// recognize an embedded host after a local path separator or file: prefix.
const fixtureDestinationHost = String.raw`(?:(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f]*:[0-9a-f:]+\]|localhost)(?::\d+)?`;
// SCP permits an omitted username and SSH host aliases. Keep explicit local
// paths, file: URLs and absolute Windows drive paths outside that grammar.
const fixtureScpDestination = String.raw`(?<![\p{L}\p{N}_./\\:@-])(?![a-z]:[\\/]|[a-z][a-z0-9+.-]*:\/\/)(?:[\w.-]+@)?(?:[\w.-]+|\[[0-9a-f]*:[0-9a-f:]+\]):[^\s<>"\x60]+`;
const fixtureDestinationUrl = new RegExp(String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s/<>"\x60]+(?:\/[^\s<>"\x60]*)?|${fixtureScpDestination}|(?<![\p{L}\p{N}_./\\:@-])(?:\/\/)?${fixtureDestinationHost}(?:\/[^\s<>"\x60]*)?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])`, "giu");
// Analyze network URLs as live destinations before splitting clauses.
// URL punctuation is data; keep sentence punctuation and UTF-16 offsets so
// separate uploads stay separate and the original source spans remain exact.
const fixtureFieldValuePrefix = /\b(?:url|title|body|label|fields?|propert(?:y|ies)|attributes?|values?|columns?|keys?)\s+(?:(?:is|are|be|being|was|were|must|should|will|set|assigned|point(?:s|ed|ing)?|equal)\s+){0,8}(?:to|as)\s*$/iu;
const fixtureDestinationText = text => text.replace(fixtureDestinationUrl, (url, offset) => {
  const fieldValue = fixtureFieldValuePrefix.test(text.slice(Math.max(0, offset - 128), offset));
  const destination = fieldValue ? " " : fixtureNetworkEndpoint;
  // Keep enough endpoint text for the marker even with a short SCP path such
  // as "a@b:."; punctuation cannot make padding negative or change offsets.
  const bodyEnd = Math.max(destination.length, /[.!?,;:)\]}]+$/.exec(url)?.index ?? url.length);
  return destination + " ".repeat(bodyEnd - destination.length) + url.slice(bodyEnd);
});
const syntheticMultipleObjects = new RegExp(String.raw`\b(?:[2-9]|\d{2,}|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|many|several|multiple|numerous|dozens?|scores?|hundreds?|thousands?|millions?|billions?|(?:one|a)[\s-]+(?:hundred|thousand|million|billion)(?:[\s-]+and[\s-]+(?:${cardinalWord})){0,3})\s+(?:(?:${syntheticQualifierWord})\s+)?(?:pull[\s-]+requests?|prs?)\b`, "iu");
const publicationObjectMentions = /\b(?:pull[\s-]+requests?|prs?)\b/giu;
const syntheticObjectQualifier = new RegExp(syntheticQualifier, "iu");
// Synthetic evidence must affirm the requested object. Contrastively
// excluded qualifiers ("real rather than fake") cannot grant the exemption.
function affirmativeSyntheticObject(text) {
  for (const match of text.matchAll(new RegExp(syntheticQualifier, "giu"))) {
    const before = text.slice(0, match.index);
    if (/\b(?:rather\s+than|instead\s+of|in\s+place\s+of|as\s+opposed\s+to|anything\s+but|neither|nor|without|not)\s+(?:(?:a|an|the)\s+)?$/iu.test(before)) continue;
    return true;
  }
  return false;
}
const sharedPublicationVerb = new RegExp(String.raw`\b(?:${currentPublicationVerbs})\b`, "iu");
const coordination = String.raw`and|or|nor|as\s+well\s+as|along\s+with|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides|plus`;
// Keep "vs." whole when a following action-boundary check could backtrack to "vs".
const contrastivePublicationObjectConnector = String.raw`\b(?:versus|vs|compared\s+(?:with|to))\b\.?(?!\.)`;
const publicationObjectSymbol = String.raw`[&+/]`;
const publicationModifierCoordination = new RegExp(String.raw`\s*(?:\b(?:${coordination}|but|yet|alongside|then)\b|${contrastivePublicationObjectConnector}|${publicationObjectSymbol}|,)\s*`, "iu");
const publicationModifiersBeforeObject = new RegExp(String.raw`\b(?:${currentPublicationVerbs})\s+(?<modifiers>[^.!?;\n]{0,96}?)\b(?:pull[\s-]+requests?|prs?)\b(?=\s*(?:[.!?;,\n]|$|\b(?:for|in|on|to|at|against|with|after|before|fixtures?)\b))`, "giu");
const publicationModifiersWhole = new RegExp(String.raw`^${publicationObjectLead}$`, "iu");
function hasMixedSyntheticPrModifiers(text) {
  return [...text.matchAll(publicationModifiersBeforeObject)].some(match => {
    const modifiers = match.groups.modifiers.split(publicationModifierCoordination).filter(Boolean);
    return modifiers.length > 1 && modifiers.some(part => syntheticObjectQualifier.test(part)) &&
      modifiers.some(part => !syntheticObjectQualifier.test(part));
  });
}
function hasMixedSyntheticPrObjects(statement) {
  const mentions = [...statement.matchAll(publicationObjectMentions)];
  let previousActionEnd = 0;
  const actionPattern = new RegExp(String.raw`\b(?:${currentPublicationVerbs})\b`, "giu");
  const objects = mentions.map((mention, index) => {
    const priorEnd = mentions[index - 1] ? mentions[index - 1].index + mentions[index - 1][0].length : 0;
    const gap = statement.slice(priorEnd, mention.index);
    // A bare comma or "then" also coordinates objects under one verb ("a fake
    // PR, a real PR"). A coordinated segment that carries its own publication
    // verb is a new action, which the replacement below inspects separately.
    const coordination = index ? [...gap.matchAll(new RegExp(String.raw`,\s*(?:\b(?:and(?:\s+then)?|or|nor|plus|then)\b\s*)?|${publicationObjectSymbol}|\b(?:and(?:\s+then)?|or|nor|plus|then|but|yet|as\s+well\s+as|along\s+with|alongside|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides)\b|${contrastivePublicationObjectConnector}`, "giu"))].at(-1) : null;
    let qualifier;
    if (coordination) qualifier = gap.slice(coordination.index + coordination[0].length);
    else if (index) qualifier = gap;
    else {
      // Match indexes share the same sliced statement origin. Adding each
      // index to the last match end overshoots when two verbs precede a PR.
      const actionOrigin = previousActionEnd;
      for (const action of statement.slice(actionOrigin, mention.index).matchAll(actionPattern))
        previousActionEnd = actionOrigin + action.index + action[0].length;
      qualifier = statement.slice(previousActionEnd, mention.index);
    }
    const sharedVerb = Boolean(coordination) && !sharedPublicationVerb.test(qualifier);
    return { mention, coordination: sharedVerb, synthetic: syntheticObjectQualifier.test(qualifier) };
  });
  for (let index = 0; index + 1 < mentions.length; index++) {
    if (objects[index + 1].coordination && objects[index].synthetic !== objects[index + 1].synthetic) return true;
  }
  return false;
}
// A live destination belongs to the synthetic action only inside its own
// clause. Punctuation or a coordinator that starts a new action ends that
// clause; a coordinator followed by another object ("and a mock PR on GitHub")
// continues the same action's object list.
const dataActionVerb = String.raw`(?:up|down)load(?:s|ing)?|cop(?:y|ies|ying)|mov(?:e|es|ing)|stor(?:e|es|ing)|sav(?:e|es|ing)|writ(?:e|es|ing)|send(?:s|ing)?|read(?:s|ing)?|fetch(?:es|ing)?|sync(?:s|ing)?|synchroniz(?:e|es|ing)|transfer(?:s|ring)?|persist(?:s|ing)?|record(?:s|ing)?|emit(?:s|ting)?|export(?:s|ing)?|import(?:s|ing)?|archiv(?:e|es|ing)|collect(?:s|ing)?|back(?:s|ing)?\s+up|log(?:s|ging)?|ship(?:s|ping)?`;
// A later data action may have its own Git destination. Keep a later PR
// object in the fixture clause so its live destination cannot be hidden.
const temporalFixtureDataAction = String.raw`\b(?:before|after|while)\s+(?=(?:${dataActionVerb})\b)(?![^.!?;\n]{0,80}\b(?:pull[\s-]+requests?|prs?)\b)`;
// Only a standalone slash ends an action; path separators cannot hide a later
// destination. Object and modifier lists above also support compact slashes.
const symbolicActionConnector = String.raw`[&+]|(?<=\s)/(?=\s)`;
// A comma ends the action only when it introduces an independent action.
// Destination/review complements stay with the PR they qualify.

// Publishing a previously synthetic object is live even without a named
// destination. Construction/formatting verbs alone do not imply publication.
const fixtureReferenceObject = String.raw`(?:it|them|(?:the|this|that|these|those)\s+(?:(?:${syntheticQualifierWord})\s+)*(?:prs?|pull[\s-]+requests?|fixtures?))`;
const fixtureReference = new RegExp(String.raw`\b${fixtureReferenceObject}\b`, "iu");
const fixturePublicationVerb = String.raw`(?:review(?:s|ed|ing)?|publish(?:es|ed|ing)?|submit(?:s|ted|ting)?|send(?:s|ing)?|sent|deliver(?:s|ed|ing)?|fil(?:e|es|ed|ing)|issu(?:e|es|ed|ing))`;
function fixtureReferencePublication(text) {
  for (const pattern of [fixtureReferencePublicationPattern, fixtureReferenceCausativePublication])
    for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) {
      const actor = publicationActorBefore(text, match.index);
      if (!actor || !applicationPublicationSurface.test(actor)) return true;
    }
  return false;
}
const outsideSyntheticPublicationFixtures = text => {
  if (!syntheticFixtureSignal.test(text) || !pullRequestSignal.test(text)) return text;
  // An explicitly local forge mock is fixture tooling, not a remote target.
  // Mask only that complete phrase; any separate live destination stays visible.
  const fixtureText = fixtureDestinationText(text).replace(/\busing\s+(?:(?:a|an|the)\s+)?local\s+(?:github|gitlab)\s+(?:mocks?|fixtures?|stubs?)\b/giu, match => " ".repeat(match.length));
  // "Of" and "to" normally end a PR modifier phrase, but contrastive
  // exclusions use them inside the object. Inspect that complete modifier
  // phrase before the narrow publication matcher can lose its action head.
  for (const match of fixtureText.matchAll(publicationModifiersBeforeObject)) {
    const modifiers = match.groups.modifiers;
    if (!syntheticObjectQualifier.test(modifiers) || affirmativeSyntheticObject(modifiers)) continue;
    const excluded = /\b(?:rather\s+than|instead\s+of|in\s+place\s+of|as\s+opposed\s+to|anything\s+but|neither|nor|without|not)\b/iu.exec(modifiers);
    if (excluded && publicationModifiersWhole.test(modifiers.slice(0, excluded.index)))
      fail("a synthetic qualifier is excluded from the requested pull-request object");
  }
  // One PR noun can carry both fixture and live modifiers ("fake and real
  // PRs"). There may be no publicationAction match when commas separate those
  // modifiers, so check the noun phrase before replacing any action spans.
  if (hasMixedSyntheticPrModifiers(fixtureText)) fail("one pull-request object has both synthetic and live modifiers");
  const statementStarts = [0];
  for (let i = 0; i < fixtureText.length; i++)
    if (/[.!?;\n]/.test(fixtureText[i]) && !(fixtureText[i] === "." && /\bvs$/i.test(fixtureText.slice(Math.max(0, i - 3), i)))) statementStarts.push(i + 1);
  // Partition once at complete action boundaries. A quoted title can be much
  // longer than the local fixture window; its unchecked suffix is never proof
  // of a safe destination. Each clause is scanned once, with suffix reference
  // facts preserve later references, including a following sentence, without
  // rescanning the source for every fixture candidate.
  const clauses = [];
  let clauseStart = 0;
  for (const boundary of fixtureText.matchAll(new RegExp(fixtureActionBoundary.source, "giu"))) {
    clauses.push({ start: clauseStart, end: boundary.index });
    clauseStart = boundary.index + boundary[0].length;
  }
  clauses.push({ start: clauseStart, end: fixtureText.length });
  for (const clause of clauses) {
    const value = fixtureText.slice(clause.start, clause.end);
    clause.live = syntheticLiveDestination.test(value);
    clause.lastReview = -1;
    for (const match of value.matchAll(syntheticReviewDestination)) {
      const after = value.slice(match.index + match[0].length), before = value.slice(Math.max(0, match.index - 128), match.index);
      // Review is an obligation regardless of its complement's word order.
      // Explicit metadata and declarative product subjects remain test data.
      const metadataTail = /^\s+(?:status|state|fields?|propert(?:y|ies)|attributes?|values?|labels?|titles?|bodies|columns?|keys?|ids?|urls?|links?|counts?|dates?|timestamps?|badges?|buttons?|panels?|pages?|components?)\b/iu.test(after);
      const metadataHead = /\b(?:status|state|field|property|attribute|value|label|title|body|column|key)\s+(?:(?:is|set|assigned|equal)\s+)?(?:(?:to|as)\s+)?$/iu.test(before);
      const actor = publicationActorBefore(value, match.index);
      if (!metadataTail && !metadataHead && (!actor || !applicationPublicationSurface.test(actor))) clause.lastReview = clause.start + match.index;
    }
    clause.referenceLive = fixtureReference.test(value) && (clause.live || clause.lastReview >= 0 || fixtureReferencePublication(value));
  }
  let laterReferenceLive = false;
  for (const clause of [...clauses].reverse()) {
    clause.laterReferenceLive = laterReferenceLive;
    laterReferenceLive ||= clause.referenceLive;
  }
  let clauseIndex = 0;
  let statementIndex = 0, activeStatementIndex = -1, activeStatement = "", activeFlags = null;
  const flagsFor = index => {
    while (statementIndex + 1 < statementStarts.length && statementStarts[statementIndex + 1] <= index) statementIndex++;
    if (statementIndex !== activeStatementIndex) {
      const statementEnd = statementStarts[statementIndex + 1] ?? text.length;
      activeStatement = fixtureText.slice(statementStarts[statementIndex], statementEnd);
      activeFlags = {
        testContext: /\b(?:(?:unit|integration|system|acceptance|end[ -]to[ -]end|e2e)\s+)?tests?\b|\btest\s+fixtures?\b|\bfixtures?\b/i.test(activeStatement),
        workflowCondition: publicationCondition.test(activeStatement) || publicationRequirement.test(activeStatement) || withheldPublication.test(activeStatement),
        mixedSyntheticObjects: hasMixedSyntheticPrObjects(activeStatement),
      };
      activeStatementIndex = statementIndex;
    }
    return activeFlags;
  };
  return text.replace(new RegExp(publicationAction.source, "giu"), (phrase, offset) => {
    // Fixture relationships below are local (the explicit PR/fixture gaps are
    // bounded). Precomputed statement flags and a fixed local window prevent
    // comma-separated candidates from rescanning their full shared sentence.
    const windowStart = Math.max(0, offset - 96), windowEnd = Math.min(text.length, offset + phrase.length + 96);
    const window = fixtureText.slice(windowStart, windowEnd), actionStart = offset - windowStart;
    const leftBoundary = Math.max(window.lastIndexOf(".", actionStart - 1), window.lastIndexOf("!", actionStart - 1), window.lastIndexOf("?", actionStart - 1), window.lastIndexOf(";", actionStart - 1), window.lastIndexOf("\n", actionStart - 1)) + 1;
    const flags = flagsFor(offset);
    // A placeholder adjective is not enough: "sample PR after tests pass" can
    // still ask the coordinator to publish a real PR. Require a grammatical
    // fixture/data relationship to the PR object and no publication condition.
    const syntheticObject = affirmativeSyntheticObject(phrase);
    const fixtureRelationship = syntheticPublicationFixture.test(window) ||
      /(?:^|[,;])\s*(?:for|in|within)\s+(?:(?:a|an|the)\s+)?(?:(?:unit|integration|system|acceptance|end[ -]to[ -]end|e2e)\s+)?tests?\b/iu.test(window.slice(leftBoundary, actionStart));
    while (clauseIndex + 1 < clauses.length && clauses[clauseIndex + 1].start <= offset) clauseIndex++;
    const clause = clauses[clauseIndex];
    // Fixture/data labels may intervene before "for review". Keep review
    // requests visible throughout this action, without borrowing a later
    // action's review destination ("and upload logs for review").
    const requestsReview = clause.lastReview >= offset + phrase.length;
    const countedLiveTarget = syntheticMultipleObjects.test(phrase);
    // Judge a live destination by this action's own clause, not the whole
    // statement: "create a fake PR fixture and upload logs to GitHub" sends the
    // logs, not the fixture, to GitHub.
    const explicitLiveTarget = clause.live;
    const referentialLiveTarget = clause.referenceLive || clause.laterReferenceLive;
    if (syntheticObject && flags.testContext && fixtureRelationship && !flags.workflowCondition && flags.mixedSyntheticObjects)
      fail("a coordinated pull-request object is not explicitly a synthetic fixture");
    if (syntheticObject && flags.testContext && fixtureRelationship && explicitLiveTarget)
      fail(countedLiveTarget ? "a counted synthetic pull-request action targets a live repository" : "a synthetic pull-request action targets a live repository");
    if (syntheticObject && flags.testContext && fixtureRelationship && requestsReview)
      fail("a synthetic pull-request action requests review");
    if (syntheticObject && flags.testContext && fixtureRelationship && referentialLiveTarget)
      fail("a synthetic pull-request fixture is later directed to a live repository or review");
    return syntheticObject && flags.testContext && fixtureRelationship && !flags.workflowCondition ? " ".repeat(phrase.length) : phrase;
  });
};
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
const publicationGerund = String.raw`opening|creating|raising|submitting|sending|preparing|making|generating|producing|starting|beginning|filing|issuing|publishing|delivering|drafting`;
// Demonstrative temporal transitions delimit both product-condition tails and
// later actor clauses. Keep the shared grammar bounded and word-delimited so
// product labels and quoted examples retain their original ownership.
const temporalPublicationConnector = String.raw`(?:(?:after|before|following)\s+(?:this|that)|at\s+(?:this|that)\s+point|from\s+(?:then|(?:this|that)\s+point)\s+on)`;
// Conjunctive adverbs end product tails and introduce their own actors;
// they cannot become actor names or modifiers borrowed from the prior clause.
const applicationPublicationClauseConnector = String.raw`(?:${temporalPublicationConnector}|and|but|or(?:\s+else)?|nor|then|yet|while|although|whereas|where|even\s+though|though|albeit|because|as\s+well\s+as|along\s+with|together\s+with|in\s+addition(?:\s+to)?|not\s+to\s+mention|besides|plus|moreover|furthermore|additionally|also|likewise|similarly|equally|correspondingly|analogously|in\s+the\s+same\s+way|therefore|consequently|accordingly|thus|hence|meanwhile|meantime|in\s+the\s+meantime|subsequently|afterwards?|thereafter|however|nevertheless|nonetheless|instead|otherwise|conversely|contrariwise|(?:in|by)\s+contrast|on\s+the\s+(?:contrary|other\s+hand)|alternatively|alternately|as\s+(?:an\s+alternative|another\s+option))`;
// Only a clearly named product surface is treated as declarative app behavior.
// Unknown people, roles and automation subjects remain visible and fail closed.
const applicationPublicationSurfacePattern = String.raw`(?:(?:the|a|an|our|this|that)\s+)?(?:(?:[\p{L}\p{N}'’-]+\s+){0,3})(?:app|application|button|service|website|site|page|form|screen|interface|ui|panel|widget|component|menu|link|toggle|control|dialog|modal|dashboard|cli|api|parser|serializer|webhook\s+handler)`;
const applicationPublicationSurface = new RegExp(String.raw`^${applicationPublicationSurfacePattern}$`, "iu");
const publicationActorDeterminer = String.raw`the|a|an|our|this|one|another`;
// Actor clauses and product conditions cover the complete current publication
// vocabulary, with explicit finite forms alongside the shared base/gerund lists.
const publicationActorVerb = String.raw`${currentPublicationVerbs}|${publicationGerund}|open(?:s|ed)|creat(?:es|ed)|rais(?:es|ed)|submit(?:s|ted)|sends|sent|prepar(?:es|ed)|makes|made|generat(?:es|ed)|produc(?:es|ed)|start(?:s|ed)|begins|began|begun|fil(?:es|ed)|issu(?:es|ed)|publish(?:es|ed)|deliver(?:s|ed)|draft(?:s|ed)`;
const publicationActorBoundaryWord = String.raw`${applicationPublicationClauseConnector}|${coordination}|${publicationActorVerb}|before|after|until|unless|when|if|once|provided|assuming|to`;
// Role modifiers stay in one noun phrase, before a recognized role. A verb,
// determiner or clause connector cannot be borrowed from another actor.
const publicationActorRoleModifier = String.raw`(?!(?:${publicationActorDeterminer}|${publicationActorBoundaryWord})\b)[\p{L}][\p{L}\p{N}'’-]*\s+`;
const publicationActorRole = String.raw`(?:${publicationActorRoleModifier}){0,4}(?:team|agent|assistant|worker|developer|engineer|coordinator|bot|workflow|automation|pipeline|job|runner|scheduler|daemon)`;
// Prefer a one-word name before consuming further components. Every component
// stays inside this clause; the subject check requires actual capitalization.
const publicationActorNamePart = String.raw`(?!(?:${publicationActorBoundaryWord})\b)\p{Lu}[\p{L}'’-]*`;
const publicationActorName = String.raw`${publicationActorNamePart}(?:\s+${publicationActorNamePart})*?`;
// Bound grammatical modifiers without consuming another actor, verb or clause.
// Share the lead with product conditions so adverbs do not change ownership.
const publicationActorActionLead = String.raw`(?:(?:to|will|would|shall|should|can|could|may|might|must|do|does|did|not|never|please|ever|again|now|first|also|likewise|contrariwise|just|only|still|already|soon|very|quite|[\p{L}]{1,48}ly)\s+){0,8}`;
// Causative passives need no "be": have/get the fixture published. The
// shared action modifiers retain negation and bounded adverbs as controls.
const fixturePassivePublicationLead = String.raw`${publicationActorActionLead}(?:(?:needs?|have|has|had)\s+to\s+${publicationActorActionLead})?(?:(?:be|been|being|have|has|had|is|are|was|were)\s+${publicationActorActionLead}){0,3}`;
const syntheticReviewDestination = /\breview(?:s|ed|ing|ers?)?\b/giu;
const fixtureReferencePublicationPattern = new RegExp(String.raw`\b${fixturePublicationVerb}\s+${fixtureReferenceObject}\b|\b${fixtureReferenceObject}\s+${fixturePassivePublicationLead}${fixturePublicationVerb}\b`, "iu");
const fixtureReferenceCausativePublication = new RegExp(String.raw`\b(?:have|has|had|having|get|gets|got|getting|want|wants|wanted|need|needs|needed|make|makes|made)\s+${fixtureReferenceObject}\s+${fixturePassivePublicationLead}${fixturePublicationVerb}\b`, "iu");
const publicationActorPrefix = String.raw`(?<actor>${applicationPublicationSurfacePattern}|(?:(?:${publicationActorDeterminer})\s+)?(?:${publicationActorRole}|${publicationActorName}))\s+${publicationActorActionLead}`;
// A separator can introduce a modifier instead of a second action. Only
// positive action evidence can detach a later live target from the fixture.
const fixtureIndependentAction = String.raw`(?=\s*(?:(?:and(?:\s+then)?|then)\s+)?(?:(?:${dataActionVerb}|${currentPublicationVerbs}|run|execute|invoke|verify|assert|check|test|format|display|render|show|inspect|review|have|get|need|want|ask|tell|instruct|ensure|let)\b|${applicationPublicationSurfacePattern}\s+${publicationActorActionLead}(?:${dataActionVerb}|${publicationActorVerb})\b))`;
const fixtureActionBoundary = new RegExp(String.raw`(?:[;!?\n]|(?<!\bvs)\.|(?:,|${symbolicActionConnector})|\b(?:and(?:\s+then)?|or|nor|then|but|yet|plus|as\s+well\s+as|along\s+with|alongside|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides)\b|${contrastivePublicationObjectConnector})${fixtureIndependentAction}|${temporalFixtureDataAction}`, "iu");
const publicationActorAction = String.raw`${publicationActorPrefix}(?<action>${publicationActorVerb})\s+${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\b`;
const delegatedPublication = new RegExp(String.raw`\b(?:ensure|have|let|tell|instruct|ask|assign|request|authorize|demand|mandate|get)\s+${publicationActorAction}`, "iu");
// A coordinated actor need not repeat the delegation verb: "ensure the button
// creates a PR and the agent opens another PR" still directs two actions.
// Reuse the actor/action grammar and product-surface exclusion at every clause
// head, including policy tails that the product-condition mask inspects.
const actorPublicationBoundary = String.raw`(?:^|[,;.!?:\n]|${symbolicActionConnector}|\s+(?:--|[-–—])\s*|\b(?:${applicationPublicationClauseConnector}|${coordination}|(?:provided|assuming)\s+that|(?:as|so)\s+long\s+as)(?:\s+then)?\b)`;
const actorLedPublication = new RegExp(String.raw`${actorPublicationBoundary}\s*${publicationActorAction}`, "giu");
// Delegation supplies actor context; a bare subject needs its own evidence.
// Case-folding proper names would also classify "Clicking submit" as a person.
const publicationActorSubject = new RegExp(String.raw`^(?:(?:${publicationActorDeterminer})\s+)?(?:${publicationActorRole}|[\p{L}'’-]+)$`, "iu");
const publicationProperName = new RegExp(String.raw`^(?:(?:${publicationActorDeterminer})\s+)?${publicationActorName}$`, "u");
const workflowActorPublication = text => [...text.matchAll(actorLedPublication)].some(match => {
  const actor = match.groups.actor.trim();
  return !applicationPublicationSurface.test(actor) && (publicationActorSubject.test(actor) || publicationProperName.test(actor));
});
// A product condition must not hide a real actor publication merely because
// its connective is unfamiliar. Scan action heads once, then inspect at most
// 512 preceding characters and 12 candidate word starts using the same actor
// and modifier grammar. Feature/literal masks retain PR templates and examples;
// skip application masking here to avoid recursive product-tail classification.
const publicationModifiersOnly = new RegExp(String.raw`^${publicationActorActionLead}$`, "iu");
const productTailActorPrefix = new RegExp(String.raw`^${publicationActorPrefix}$`, "iu");
const productTailPublicationAction = new RegExp(String.raw`\b(?:${publicationActorVerb})\s+${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\b`, "giu");
function publicationActorBefore(text, end) {
  const prefix = text.slice(Math.max(0, end - 512), end);
  const starts = [...prefix.matchAll(/\b[\p{L}\p{N}]/gu)].slice(-12);
  for (const start of starts.reverse()) {
    const candidate = prefix.slice(start.index);
    if (publicationModifiersOnly.test(candidate)) continue;
    const actor = productTailActorPrefix.exec(candidate)?.groups.actor?.trim();
    if (actor && (applicationPublicationSurface.test(actor) || publicationActorSubject.test(actor) || publicationProperName.test(actor))) return actor;
  }
  return null;
}
function workflowPublicationPositions(text) {
  const positions = [];
  const visible = outsideFeatureObjects(text, false, true);
  for (const action of visible.matchAll(productTailPublicationAction)) {
    const actor = publicationActorBefore(visible, action.index);
    if (actor && !applicationPublicationSurface.test(actor)) positions.push(action.index);
  }
  return positions;
}
const outsideDelegatedApplicationPublications = text => outsideDeclarativeApplicationConditions(text).replace(new RegExp(delegatedPublication.source, "giu"), (phrase, ...args) => {
  const { actor } = args.at(-1);
  if (!applicationPublicationSurface.test(actor.trim())) return phrase;
  // Stop at the PR object, preserving every following policy or prerequisite.
  // Mask the subject too: "submit button" must not become a command after its
  // product verb disappears. Original source spans remain untouched.
  return " ".repeat(phrase.length);
});
const applicationPublicationClauseBoundary = String.raw`(?:[,;.!?:\n]|${symbolicActionConnector}|\s+(?:--|[-–—])\s*|\b${applicationPublicationClauseConnector}\b)`;
const applicationPublicationCondition = new RegExp(String.raw`\b(?<subject>(?:the|a|an|our|this|that)\s+[\p{L}\p{N}][\p{L}\p{N}'’_-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’_-]*){0,3}?)(?<context>,\s*(?:when|whenever|if|once|after|before|unless|while|although)\b[^,.;\n]{1,48},)?\s+${publicationActorActionLead}(?:${publicationActorVerb})\s+${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\s+(?:only\s+)?(?:after|before|until|when|if|unless|pending|subject\s+to)\b(?:(?!${applicationPublicationClauseBoundary})[^.!;\n])*`, "giu");
const applicationContextContainsControl = context => {
  const text = outsideLiterals(context);
  return /\b(?:pull[\s-]+requests?|prs?|publication|publishing|publish(?:es|ed|ing)?|push(?:es|ed|ing)?|commit(?:s|ted|ting)?|merge(?:s|d|ing)?|owner|human|approval|permission|consent|confirmation|review|release|deploy|local(?:ly)?|unpublished|uncommitted|unpushed)\b/i.test(text);
};
function outsideDeclarativeApplicationConditions(text) {
  if (!text.match(applicationPublicationCondition)) return text;
  // Classify action heads once for this source, including text after a comma
  // that ends the product match. Monotonic cursors keep repeated clauses linear
  // instead of rescanning every suffix or relying on connective spellings.
  const actorPositions = workflowPublicationPositions(text);
  const statementEnds = [...text.matchAll(/\r?\n|;|[.!?](?=\s|$)/gu)].map(match => match.index + match[0].length);
  let actorCursor = 0, statementCursor = 0;
  return text.replace(applicationPublicationCondition, (phrase, _subject, _context, offset, source, groups) => {
    if (!applicationPublicationSurface.test(groups.subject.trim()) || applicationContextContainsControl(groups.context || "")) return phrase;
    const action = phrase.slice(groups.subject.length + (groups.context || "").length);
    const condition = publicationCondition.exec(action);
    const tailStart = condition ? groups.subject.length + (groups.context || "").length + condition.index + condition[0].length : phrase.length;
    const tail = phrase.slice(tailStart);
    while (actorCursor < actorPositions.length && actorPositions[actorCursor] < offset + tailStart) actorCursor++;
    while (statementCursor < statementEnds.length && statementEnds[statementCursor] <= offset) statementCursor++;
    if (actorPositions[actorCursor] < (statementEnds[statementCursor] ?? source.length))
      fail("a product condition contains an independent actor publication that needs clarification");
    const laterPolicy = publicationRequirement.test(tail) || publicationCondition.test(tail) ||
      deliveryControl(tail) || ownerPrerequisite(tail) || publicationDirective(tail);
    return laterPolicy ? phrase : " ".repeat(phrase.length);
  });
}
// Past-tense clauses without an actor are ambiguous at new-task intake: they
// can be shorthand for a requested publication or a status claim. Require the
// owner to restate the intended action; declarative product subjects remain
// ordinary implementation behavior.
const unattributedPastPublication = new RegExp(String.raw`(?:^|[.!;\n])\s*(?:opens|opened|creates|created|raises|raised|submits|submitted|sends|sent|prepares|prepared|makes|made|files|filed|publishes|published)\s+${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\b`, "iu");
function outsideApplicationPublications(text, saved = false) {
  // Mask only the application verb, not its object or a following action. The
  // negative-sequence check still sees the full text and any later Git control.
  return text.replace(/\b(?:publish(?:ing)?|publication)\b/ig, (verb, offset) =>
    technicalOperation(verb, text.slice(offset + verb.length), saved) && (saved || !mixedApplicationObjects(verb, text.slice(offset + verb.length))) ? " ".repeat(verb.length) : verb);
}
function publicationDirective(text, saved = false) {
  const source = saved ? text : outsideSyntheticPublicationFixtures(text);
  const visible = outsideApplicationPublications(saved ? source : outsideDelegatedApplicationPublications(source), saved);
  const conditions = saved ? source : outsideDeclarativeApplicationConditions(source);
  return publishCommand(visible) || !saved && (delegatedPublication.test(visible) || workflowActorPublication(visible) || quantifiedPublication.test(visible)) || [saved ? savedPublicationAction : publicationAction, withheldPublication].some(pattern => pattern.test(visible)) ||
    !saved && unattributedPastPublication.test(visible) ||
    !saved && publicationGerundProhibition.test(visible) ||
    [saved ? savedPublicationRequirement : publicationRequirement, publicationCondition].some(pattern => pattern.test(conditions));
}
// Recognize directions about the workflow, not implementation nouns (a local
// store, review dashboard or diff viewer). This bounded grammar does not infer
// permission; unsupported explicit publication wording is refused separately.
// Direct and coordinated restrictions use the same bounded modal/subject forms.
const controlAdverb = String.raw`(?:under|in|at|by|for|on|without)\s+(?:(?:any|a|the|all|no|these|those|my|our|your|every)\s+)*[a-z][\w-]*(?:\s+whatsoever)?`;
const actionLeadFor = current => String.raw`(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:should|must|may|can|could|would|will|shall|do|does|did)\s+)?(?:(?:you|we|I|it|they|the\s+agent)\s+)?(?:(?:not|ever|again|now|first${current ? `|please|even|once|just|only|${controlAdverb}` : ""}|[a-z]+ly)\s+)*(?:(?:run|running)\s+)?`;
const actionLead = actionLeadFor(true);
const actionVerb = (current = true) => String.raw`(?<git>git\s+)?(?<verb>push(?:es|ing)?|commit(?:s|ting)?|deliver(?:ing|y)?|publish(?:ing)?${current ? "|publication|creat(?:e|ing)|mak(?:e|ing)|generat(?:e|ing)|produc(?:e|ing)" : ""})\b`;
const permissionLead = String.raw`(?:(?:be\s+)?(?:allowed|permitted|authorized|supposed|expected|required|able)\s+to\s+|(?:allow|permit)\s+)?`;
const prohibitionBridge = String.raw`(?:${publicationObjectLead}(?:from|against|to)\s+)?`;
const unfinishedControlPrefix = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}(?:(?:any|a|the|all|more|new)\s+)*${actionLead}(?:to\s*)?$`, "iu");
const publicationGerundProhibition = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}${publicationObjectLead}(?:${publicationGerund})\s+(?:of\s+)?${publicationObjectLead}(?:pull[\s-]+requests?|prs?)\b`, "iu");
const controlledActionPattern = new RegExp(String.raw`\b(?:${negativeLead})\s+${prohibitionBridge}${permissionLead}(?:(?:any|a|the)\s+)?${actionLead}${actionVerb()}`, "igu");
const gitArtifactObject = tail => /^\s+(?:(?:any|a|an|the|this|that|these|those|new|another|additional|more)\s+)*(?:git\s+)?(?:commits?|branch(?:es)?)\b/i.test(outsideFeatureObjects(tail));
const coordinatedObjects = (tail, predicate) => [...tail.split(/[.!;\n]/)[0].matchAll(new RegExp(String.raw`\b(?:${coordination})\b|,`, "ig"))].some(match => {
  const candidate = tail.slice(match.index + match[0].length);
  // Parse a coordinated verb before treating "commit" as the Git artifact
  // noun. Committing a database transaction is application work; committing
  // code or a branch remains a repository action.
  const commitAction = /^\s+commit(?:s|ting)?\b/i.exec(candidate);
  if (commitAction && technicalOperation("commit", candidate.slice(commitAction[0].length))) return false;
  return predicate(candidate);
});
const gitArtifactSequence = tail => gitArtifactObject(tail) || coordinatedObjects(tail, gitArtifactObject);
const objectHead = tail => tail.replace(/^\s+(?:of\s+)?/i, "").split(/[.!;\n,]|\b(?:and|or|nor|but|then|to|into|onto|on|via|through|using|from|in|at|for|with|twice|before|after|until|unless|when|if|once)\b/i)[0];
const workflowObject = (tail, saved = false) => {
  const object = outsideFeatureObjects(objectHead(tail));
  return /\b(?:git|github|remote|origin|upstream|pull[\s-]+requests?|prs?|commits?|branch(?:es)?|changes?|edits?|code|patch(?:es)?|work|implementation|release|build|package|results?|outputs?|anything|everything|nothing|it|them|this|that)\b/i.test(object) ||
    !saved && /\b(?:solutions?|tasks?|deliverables?|artifacts?|fix(?:es)?|updates?|modifications?|revisions?|features?)\s*$/i.test(object);
};
const referentialApplicationAction = candidate => {
  const action = /^\s*(?<verb>[\p{L}][\p{L}'’-]*)\s+(?<object>it|them|this|that)[.!?;]*\s*$/iu.exec(candidate);
  if (!action) return false;
  return !/^(?:merge|push|commit|publish|deliver|release|deploy|open|create|raise|submit|send|prepare|generate|produce|start|begin|file|issue)$/i.test(action.groups.verb);
};
const mixedApplicationObjects = (verb, tail) => {
  // For prohibitions, retain unrecognized object phrases: an adjective before
  // "changes" or "the PR" cannot hide a workflow object. Known later actions
  // are checked independently, so a database commit is not a Git object here.
  const next = [...tail.matchAll(coordinatedAction)][0];
  return /^(?:publish|publication|deliver|merge)/i.test(verb) && coordinatedObjects(tail.slice(0, next?.index), candidate =>
    !referentialApplicationAction(candidate) && workflowObject(candidate));
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
function actionTail(tail, mergeOperands = false) {
  // A destination belongs to this action, not a later coordinated action or
  // incidental source/metadata. Keep shared destinations for noun lists.
  const sentence = tail.split(/[.!;\n]|\b(?:before|after|while|when|until|unless|if|because)\b|\bfor\s+(?:(?:human|code)\s+)?review\b/i)[0];
  for (const match of sentence.matchAll(new RegExp(String.raw`\b(?<conjunction>${coordination}|then|but)\s+|,\s*(?:(?:and|or|nor)\s+)?`, "ig"))) {
    const initial = sentence.slice(0, match.index);
    const remaining = sentence.slice(match.index + match[0].length);
    const nextAction = [...sentence.slice(match.index).matchAll(coordinatedAction)][0];
    if (nextAction?.index === 0 || dataAction(remaining)) return initial;
    if (mergeOperands && !/^(?:then|but)$/i.test(match.groups.conjunction || "")) continue;
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
function actionDestinationsIn(current) {
  return [...current.matchAll(/\b(?:to|into|onto|via|through|on)\s+/ig)].map(match =>
    current.slice(match.index + match[0].length).split(/\b(?:using|with|from|for|by|while|because)\b/i)[0]);
}
const MAX_APPLICATION_DELIVERY_TAIL = 2048;
const nextPublicationAction = new RegExp(String.raw`(?:[,;]\s*|\b(?:and|then|or|but)\b\s+)(?:please\s+)?(?:${currentPublicationVerbs})\b`, "iu");
function applicationDelivery(tail, saved = false) {
  // Preserve the earlier v1/v2 message exception only when validating saved
  // spans; new requests must pass the contextual checks below.
  if (saved && savedMessageObject.test(tail)) return true;
  // Application context may come from the object, a transport, repeated delivery
  // or nominal "delivery of ...". Unknown nouns alone never waive a workflow
  // restriction ("do not publish the solution").
  // This predicate is called once per `publish` token. The supported answer
  // limit is 32 KiB, so scanning the remaining suffix each time still permits
  // quadratic synchronous work. New-task destinations must be close to their
  // action; a longer ambiguous tail remains visible and fails closed.
  const firstWindow = saved ? tail : tail.slice(0, MAX_APPLICATION_DELIVERY_TAIL + 1);
  const nextAction = saved ? null : nextPublicationAction.exec(firstWindow);
  // Bound each publication action while still finding the next action in a
  // repeated, comma-separated application sequence. If no boundary is visible
  // in the bounded window, the destination could be beyond it (for example,
  // "publish messages [large description] to GitHub"). Keep that action visible
  // for the normal fail-closed workflow checks.
  if (!saved && tail.length > MAX_APPLICATION_DELIVERY_TAIL && !nextAction) return false;
  const actionTailText = nextAction ? tail.slice(0, nextAction.index) : tail;
  const bounded = saved ? actionTailText : actionTailText.slice(0, MAX_APPLICATION_DELIVERY_TAIL);
  const scoped = saved ? bounded : actionTail(bounded);
  const head = objectHead(scoped).replace(/^(?:(?:the|a|an|any|all|these|those|my|our|your|new|existing|duplicate)\s+)*/i, "").trim();
  if (!head || /^(?:only|now|yet|today|tomorrow|later|again|online|pending|without|never|not|[a-z]+ly)\b/i.test(head) && !applicationObject(scoped, saved)) return false;
  const destinations = actionDestinationsIn(scoped);
  const gitDestination = destinations.some(destination => /\b(?:git(?:hub)?|remote|origin|upstream|repository|repo)\b/i.test(destination));
  const applicationDestination = destinations.some(destination => /\b(?:bus|queue|topic|broker|webhook|kafka|rabbitmq|nats|s3|gcs|r2|minio|storage|buckets?|sftp|ftp|scp)\b/i.test(destination)) ||
    saved && savedApplicationDestination.test(bounded);
  const applicationContext = /^\s+of\s+/i.test(tail) || /\b(?:events?|messages?|notifications?|emails?|webhooks?)\b/i.test(head) ||
    /\b(?:twice|duplicates?|multiple\s+times|more\s+than\s+once)\b/i.test(scoped);
  const workflow = workflowObject(scoped, saved);
  return !gitDestination && (applicationDestination && (saved || !workflow) || applicationContext && !workflow);
}
// Active and passive application merges must reject every explicit Git target,
// including a target coordinated with an application destination.
function workflowMergeDestination(tail, saved = false) {
  const operands = actionTail(tail, true);
  const prepositions = new RegExp(String.raw`\b(?:from|to|into|onto|on|via|through|using|in|at|for|with|against${saved ? "" : "|inside|within"})\s+`, "ig");
  const targets = [...operands.matchAll(prepositions)].flatMap(match => operands.slice(match.index + match[0].length).split(new RegExp(String.raw`\b(?:${coordination})\b|,`, "i")).map(objectHead));
  return targets.some(target => workflowObject(target) || gitMergeReference(target));
}
function technicalOperation(verb, tail, saved = false) {
  if (/^commit/i.test(verb)) return /^\s+(?:(?:the|a|this|that)\s+)?(?:(?:database|sql|db)\s+)?transactions?\b/i.test(tail) ||
    /^\s+(?:it|them|this|that|these|those)\b/i.test(tail) && /\b(?:to|into|in)\s+(?:(?:the|a|an)\s+)?(?:database|db)\b/i.test(tail) && !/\b(?:git|github|remote|origin|upstream|repository|repo)\b/i.test(tail);
  if (/^push/i.test(verb)) return /^\s+(?:(?:the|a|an|this|that|duplicate|new|existing)\s+)*(?:items?|elements?|values?|records?|messages?|entries)\s+(?:onto|into|to)\s+(?:(?:the|a|an|this|that)\s+)?(?:queue|stack|array|list)\b/i.test(tail);
  if (/^(?:publish|publication|deliver)/i.test(verb)) return applicationDelivery(tail, saved);
  if (/^(?:creat|mak|generat|produc)/i.test(verb)) return !gitArtifactSequence(tail);
  if (/^merge/i.test(verb)) {
    const head = objectHead(tail).trim().replace(/^(?:(?:a|an|the|any|all|some|more|only|just|please|my|our|your)(?:\s+|$))+/i, "").replace(/\s+please$/i, "");
    const data = bareDataNoun.test(head.split(/\s+/).at(-1) || "") || /\b(?:arrays?|objects?|records?|contacts?|rows?|accounts?|files?|invoices?|streams?|maps?|dictionar(?:y|ies)|payloads?|configurations?|tables?|datasets?|database|json|sql)\b/i.test(head);
    const headCountData = /^head\s+counts?$/i.test(head) && /\b(?:to|into)\s+(?:the\s+)?database\b/i.test(actionTail(tail));
    return Boolean(head) && data && (headCountData || !gitMergeReference(head)) && !workflowMergeDestination(tail, saved) &&
      !/^(?:now|yet|today|tomorrow|later|again|online|pending|without|never|not)(?:\s|$)/i.test(head) && applicationObject(tail) && applicationObject(` ${head}`) && !mixedApplicationObjects(verb, tail);
  }
  return false;
}
const mergeOperandText = value => value.replace(/[()[\]{}<>]/g, " ").trim().replace(/\s+/g, " ");
function gitMergeReference(value) {
  const ref = mergeOperandText(mergeOperandText(value).replace(/^(?:(?:a|an|the|also|another|any|all|some|both|either|neither|other|more|further|extra|additional|remaining|selected|specified|following|this|that|these|those|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|\d+)\s+)+/i, ""));
  const candidates = ref.split(/\s+/).map(mergeOperandText).filter(token => !/^(?:\/|\.{1,2}\/|~\/|[a-z][a-z0-9+.-]*:\/\/|[a-z]:[\\/])/i.test(token)).join(" ");
  const untyped = candidates.replace(/\b(?:objectid|uuid|checksum|digest)(?:\s*[:=]\s*|\s+)[a-f0-9-]{4,128}(?=$|[^\p{L}\p{N}_-])/giu, " ");
  if (/[\/~^@]/.test(untyped) || /(?:^|[^\p{L}\p{N}_-])[a-f0-9]{7,64}(?=$|[^\p{L}\p{N}_-])/iu.test(untyped) ||
      /\b(?:sha(?:\p{Pd}?(?:1|256))?|oid|hash|changeset)[\s:=\p{Pd}]+[a-f0-9]{4,64}(?=$|[^\p{L}\p{N}_-])/iu.test(untyped)) return true;
  const qualified = /^(?:(?:git|remote|local)\s+)*(?:branches?|tags?|revisions?|commits?|refs?|references?|remotes?|heads?)(?:[\s:=\p{Pd}]+(.*))?$/iu.exec(ref);
  if (qualified) {
    const operand = (qualified[1] || "").trim();
    if (!operand && /^(?:tags|references)$/i.test(ref)) return false;
    // Typed application compounds describe data, while a single ref token or
    // revision expression after a qualifier identifies the Git operand.
    if (/^(?:counts?|metadata|data|details?|names?|labels?|statistics|metrics|records?|objects?|payloads?|schemas?|models?|tables?|fields?)\s+(?:data|metadata|records?|objects?|tables?)$/i.test(operand)) return false;
    return true;
  }
  // Git refs cannot contain whitespace. Named data fields such as "the main
  // table" remain data, while bare branch names, qualified refs and revisions
  // cannot supply application evidence.
  return !/\s/.test(ref) && /^(?:main|master|develop|development|dev|stage|staging|prod|production|release|trunk|head|fetch_head|orig_head|merge_head|v\d+)$/i.test(ref);
}
// Negation also spans "nor", including technical actions before a Git action.
// A technical exception for one verb must never exempt the rest of the sequence.
const coordinatedPattern = current => new RegExp(String.raw`(?:\b(?:${current ? coordination : "and|or|nor"}|then|but)\s+|,\s*(?:(?:and|or|nor|then|but)\s+)?)${actionLeadFor(current)}${actionVerb(current)}`, "ig");
const coordinatedAction = coordinatedPattern(true), savedCoordinatedAction = coordinatedPattern(false);
const workflowAction = (verb, tail, git, saved = false) => Boolean(git) || !technicalOperation(verb, tail, saved) || !saved && mixedApplicationObjects(verb, tail);
const MAX_CONTROL_ACTION_MATCHES = 64;
const MAX_COORDINATED_ACTIONS = 1024;
function coordinatedWorkflowSequence(rest, saved = false) {
  const matches = [...rest.matchAll(saved ? savedCoordinatedAction : coordinatedAction)];
  if (matches.length > MAX_COORDINATED_ACTIONS) return true;
  return matches.some((match, index) => {
    const start = match.index + match[0].length, end = matches[index + 1]?.index ?? rest.length;
    return workflowAction(match.groups.verb, rest.slice(start, end), match.groups.git, saved);
  });
}
function workflowSequence(verb, tail, git, saved = false) {
  const rest = tail.split(/[.!;\n]/)[0];
  const matches = [...rest.matchAll(saved ? savedCoordinatedAction : coordinatedAction)];
  if (matches.length > MAX_COORDINATED_ACTIONS) return true;
  const firstSegmentEnd = matches[0]?.index ?? rest.length;
  if (workflowAction(verb, rest.slice(0, firstSegmentEnd), git, saved)) return true;
  return matches.some((match, index) => {
    const start = match.index + match[0].length, end = matches[index + 1]?.index ?? rest.length;
    return workflowAction(match.groups.verb, rest.slice(start, end), match.groups.git, saved);
  });
}
const negativeClause = new RegExp(String.raw`\b(?:${negativeLead})\b`, "ig");
const controlledAction = text => {
  const direct = [...text.matchAll(controlledActionPattern)], negatives = [...text.matchAll(negativeClause)];
  // Pathological repetitions are ambiguous owner controls. Fail closed before
  // repeatedly parsing overlapping suffixes; ordinary clause sequences are
  // indexed once by `workflowSequence` above.
  if (direct.length > MAX_CONTROL_ACTION_MATCHES || negatives.length > MAX_CONTROL_ACTION_MATCHES) return true;
  if (direct.some(match => workflowSequence(match.groups.verb, text.slice(match.index + match[0].length), match.groups.git))) return true;
  return negatives.some(negative => {
    // An unknown first application verb ("do not log keys or commit changes")
    // must not erase a later coordinated workflow restriction. Conditions and
    // independent statements end this scope; literals are already masked.
    const clause = text.slice(negative.index + negative[0].length).split(/[.!;\n]|\b(?:before|after|while|when|until|unless|if|because)\b/i)[0];
    return coordinatedWorkflowSequence(clause);
  });
};
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
// Classify imperative merges against the original, literal-masked request
// before product-feature masking. This is intentionally an action/object
// grammar: the merge verb must begin a command clause and the governed object
// must be a branch. Editing or UI nouns that merely contain “merge” are not
// candidates. The single global scan keeps each candidate and its local clause
// bounded, avoiding the old repeated-prefix/suffix classification pattern.
const mergeBranchCommand = new RegExp(String.raw`(?:^|[.!?;:\n,]|\b(?:and|then)\s+)\s*(?:please\s+)?(?:(?:(?:you|we|I|the\s+agent)\s+)?(?:must|should|shall|will|would|can|could|may|might|need\s+to|have\s+to|please)\s+)*(?:git\s+)?(?:(?:auto|squash|rebase)[ \t-]?)?merge\b(?<tail>[^.!?;\n]{0,160})`, "giu");
// Modifier vocabulary is deliberately open here; branch is the grammatical
// object. Requiring it to end the phrase (or introduce a Git destination)
// keeps “branch selector” feature nouns outside this command match.
const mergeBranchObject = /^\s+(?:(?:[\p{L}\p{N}][\p{L}\p{N}'’-]*)\s+){0,4}branches?\b(?=\s*(?:[.!?;,:]|$|\b(?:from|into|to|against|on|in)\b))/iu;
const hasMergeBranchCommand = text => [...text.matchAll(mergeBranchCommand)].some(match => mergeBranchObject.test(match.groups.tail));
// Passive Git and merge controls share bounded adverbs around the infinitive
// and passive auxiliaries. Modifiers cannot hide "cannot ever be merged" or
// "are not to be silently created" inside a product condition's tail.
const passiveControlModifiers = String.raw`(?:(?:[\p{L}][\p{L}'’-]*ly|ever|again|still|yet|now|then|always|already|just|even|very|quite|rather|so|too|almost|not|never|soon|today|tomorrow|once|forever)\s+){0,4}`;
const passiveControlBridge = String.raw`${passiveControlModifiers}(?:to\s+${passiveControlModifiers})?(?:be\s+${passiveControlModifiers})?`;
const passiveMergeProhibition = new RegExp(String.raw`\b(?:changes?|edits?|work|code|implementation|branch(?:es)?|pull[\s-]+requests?|prs?)\s+(?:${negativeModal}|(?:must|should|shall|may|can|will|is|are)\s+never)\s+${passiveControlBridge}merged\b`, "giu");
const passiveGitProhibition = new RegExp(String.raw`\b(?:commits?|committing|branch(?:es|ing)?)(?:\s+(?:creation|generation|production))?\s+(?:(?:${negativeModal}|(?:(?:must|should|shall|may|can|will|is|are)\s+)?(?:not|never))\s+${passiveControlBridge}(?:created|generated|made|produced|written|allowed|permitted|happen|occur)|(?:(?:is|are|must\s+be|should\s+be)\s+)?(?:forbidden|prohibited|disallowed|banned))\b`, "giu");
const gitContext = /\b(?:git(?:hub|lab)?|repo(?:sitory)?|checkout|remote|origin|upstream|version[ -]+control|source[ -]+control|pull[ -]+requests?|prs?|commits?|merges?|push(?:ed|ing)?)\b/i;
const passiveControlClauseBoundary = new RegExp(String.raw`${applicationPublicationClauseBoundary}|\b(?:since|before|after|when|whenever|if|once|until|unless|provided|assuming)\b`, "iu");
const passiveControlContext = (text, passive) => {
  const start = Math.max(text.lastIndexOf(".", passive.index), text.lastIndexOf("!", passive.index), text.lastIndexOf("?", passive.index), text.lastIndexOf(";", passive.index), text.lastIndexOf("\n", passive.index)) + 1;
  const endMatch = text.slice(passive.index).search(/[.!?;\n]/);
  const sentence = text.slice(start, endMatch < 0 ? text.length : passive.index + endMatch + 1);
  // A prior condition or another action cannot supply a domain modifier or
  // complement for this branch head ("tests pass since branches cannot...").
  const prefix = sentence.slice(0, passive.index - start).split(passiveControlClauseBoundary).at(-1).trim();
  const remainder = sentence.slice(passive.index - start + passive[0].length).split(passiveControlClauseBoundary, 1)[0];
  return { sentence, prefix, remainder };
};
const passiveBranchIsGit = (text, passive) => {
  const { sentence, prefix, remainder } = passiveControlContext(text, passive);
  const domainModifier = prefix && !/^(?:(?:the|a|an|all|any|no|these|those|new|another|additional|more)\s+)*(?:the|a|an|all|any|no|these|those|new|another|additional|more)?$/i.test(prefix);
  const domainComplement = /\b(?:in|inside|within|of|from|across)\s+(?!(?:git(?:hub|lab)?|repo(?:sitory)?|checkout|remote|origin|upstream)\b)(?:the\s+)?[\p{L}\p{N}]/iu.test(remainder);
  // Creation and merge controls share the application-domain exception.
  // Explicit repository context wins; bare branch heads still mean Git.
  return gitContext.test(sentence) || !domainModifier && !domainComplement;
};
const passiveApplicationMerge = (text, passive) => {
  const { prefix, remainder } = passiveControlContext(text, passive);
  const destination = /^\s+(?:to|into|onto|in|inside|within)\s+(.+)/iu.exec(remainder);
  if (!destination || gitContext.test(prefix + " " + passive[0] + remainder)) return false;
  const target = objectHead(destination[1]).trim();
  // Generic work/code heads need positive application context in their own
  // complement. An arbitrary modifier or remote destination cannot exempt them.
  const application = applicationPublicationSurface.test(target) || /^(?:[\p{L}\p{N}'’-]+\s+){0,4}(?:cells?|editors?)$/iu.test(target);
  const tail = text.slice(passive.index + passive[0].length);
  return application && !workflowMergeDestination(tail);
};
const passiveMergeControl = text => [...text.matchAll(passiveMergeProhibition)].some(passive => {
  if (/^branch(?:es)?\b/iu.test(passive[0])) return passiveBranchIsGit(text, passive);
  if (/^(?:pull[\s-]+requests?|prs?)\b/iu.test(passive[0])) return true;
  return !passiveApplicationMerge(text, passive);
});
const gitArtifactProhibition = text => {
  for (const passive of text.matchAll(passiveGitProhibition))
    if (!/\bbranch(?:es|ing)?\b/i.test(passive[0]) || passiveBranchIsGit(text, passive)) return true;
  return [...text.matchAll(/\b(?:no|without)\b/ig)].some(match => gitArtifactObject(text.slice(match.index + match[0].length)));
};
const localWork = /\b(?:keep|leave|save|retain)\s+(?:(?:the|this|these|those|my|our|all)\s+)?(?:changes?|edits?|work|code|results?|outputs?|files?|branches|branch|it|them|this|these|those|everything)\s+(?:(?:only|strictly)\s+)?(?:local(?:ly|-only)?|unpublished|uncommitted|unpushed)\b|\b(?:keep|leave)\s+(?:only\s+)?local(?:ly)?(?=\s*(?:[.!;]|$))|\b(?:work|operate)\s+(?:only\s+locally|locally\s+only)\b/i;
const artifactOnly = /\b(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:only|just)\s+(?:(?:a|the)\s+)?(?:patch|diff)|(?:(?:a|the)\s+)?(?:patch|diff)\s+only)\b|\b(?:only|just)\s+(?:return|show|provide|give|send)\s+(?:(?:me|us)\s+)?(?:(?:a|the)\s+)?(?:patch|diff)\b/i;
const awaitReview = /\b(?:wait(?:\s+for)?|await)\s+(?:(?:my|our|your|the|an?|explicit|human|owner|user)\s+){0,3}(?:review|approval|permission|confirmation|consent)\b/i;
const heldForApproval = /\b(?:hold|keep|leave)\s+(?:(?:the|this|these|my|our)\s+)?(?:changes?|edits?|work|code|it|them)\s+(?:for|until|pending)\s+(?:(?:my|our|the|explicit|human|owner)\s+){0,3}(?:approval|permission|confirmation|consent)\b/i;
// New-request/answer validation must not reinterpret already accepted spans.
const publicationPreference = /\b(?:no|not|don['’]t|doesn['’]t|didn['’]t|never|without|avoid|prevent|skip)\s+(?:want|need|require|request)\s+(?:for\s+)?(?:(?:any|a|the|all|new)\s+)*(?:pull[\s-]+requests?|prs?|publication|publishing)\b/i;
const deliveryControl = text => controlledAction(text) || controlledWork(text) || mergeDirective(text) || passiveMergeControl(text) || gitArtifactProhibition(text) ||
  publicationPreference.test(outsideApplicationPublications(text)) || [localWork, artifactOnly, awaitReview, heldForApproval].some(pattern => pattern.test(text));
// Owner authorization prerequisites affect the whole task. Technical conditions
// (if a name is empty; commit a database transaction after validation) remain
// implementation scope. Conditional/negative publication clauses themselves are
// independently rejected by `qualified` above; punctuation cannot erase them.
const requestedApproval = /\b(?:ask|obtain|request|require)\s+(?:for\s+)?(?:(?:the|explicit|further|manual)\s+)*(?:my|our|your|owner)\s+(?:(?:explicit|further|manual)\s+)*(?:review|approval|permission|confirmation|consent|go-ahead)\b/i;
const ownerApprovalConditionLead = String.raw`(?:before|after|until|unless|pending|once|when|if|provided(?:\s+that)?|subject\s+to|conditioned\s+on)`;
const ownerApprovalSignal = /\b(?:approv(?:e|es|ed|ing|al|als)|confirm(?:s|ed|ation)?|consent(?:s|ed)?|permit(?:s|ted)?|permission|agree(?:s|d)?|review(?:s|ed)?|authoriz(?:e|es|ed|ation))\b/i;
const ownerApprovalConditionSignal = /\b(?:before|after|until|unless|pending|once|when|if|provided|subject|conditioned)\b/i;
const approvalActorPhrase = String.raw`(?:\b(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)(?:(?:\s+(?:have|has|had))|(?:['’](?:ve|s)))?\s+(?:(?:[\p{L}]+ly|only|just)\s+){0,8}(?:approve|approves|approved|confirm|confirms|confirmed|consent|consents|consented|permit|permits|permitted|agree|agrees|agreed|review|reviews|reviewed|authorize|authorizes|authorized)\b|\b(?:my|our|your|owner|human|manual|explicit)\s+(?:review|approval|permission|confirmation|consent)\b)`;
const approvalFlowToken = new RegExp(String.raw`(?<boundary>[.!;:\n\u2012-\u2015]|(?<=\s)--?(?=\s))|(?<condition>\b${ownerApprovalConditionLead}\b)|(?<approval>${approvalActorPhrase})`, "giu");
// Share the complete concessive connector across approval flow, object and
// action boundaries. Explicit case variants preserve named-actor matching.
const concessiveBusinessActionConnector = String.raw`(?:[eE][vV][eE][nN]\s+)?[tT][hH][oO][uU][gG][hH]|[aA][lL][tT][hH][oO][uU][gG][hH]|[wW][hH][eE][rR][eE][aA][sS]|[aA][lL][bB][eE][iI][tT]`;
// A prepositional concession can own noun data as well as an action. Share
// action checks without treating its nominal complement as coordination.
const prepositionalConcessiveBusinessActionConnector = String.raw`[dD][eE][sS][pP][iI][tT][eE]|[nN][oO][tT][wW][iI][tT][hH][sS][tT][aA][nN][dD][iI][nN][gG]`;
// Both spellings share temporal, coordination and surrounding approval-flow
// boundaries, including case-sensitive named-actor action checks.
const concurrentBusinessActionConnector = String.raw`[wW][hH][iI][lL](?:[eE]|[sS][tT])`;
const approvalFlowWithConjunction = new RegExp(String.raw`(?<boundary>[.!;:\n\u2012-\u2015]|(?<=\s)--?(?=\s))|(?<conjunction>,\s*|\s+(?:and|but|then|or|nor|yet|${concurrentBusinessActionConnector}|${concessiveBusinessActionConnector}|as\s+well\s+as|along\s+with|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides|plus)\s+)|(?<condition>\b${ownerApprovalConditionLead}\b)|(?<approval>${approvalActorPhrase})`, "giu");
// Scan condition, owner-approval and clause-boundary tokens in one forward
// pass. The former unanchored `condition[^.!;\n]*approval` expression retried
// each condition token through the rest of long punctuation-free answers.
const approvalConditionCandidate = text => ownerApprovalSignal.test(text) && ownerApprovalConditionSignal.test(text);
const conditionedApprovalMatches = text => {
  if (!approvalConditionCandidate(text)) return false;
  let conditionSeen = false;
  for (const token of text.matchAll(approvalFlowToken)) {
    if (token.groups.boundary) conditionSeen = false;
    else if (token.groups.condition) conditionSeen = true;
    else if (token.groups.approval && conditionSeen) return true;
  }
  return false;
};
// For each conjunction, determine whether its remaining clause contains a
// condition followed by an owner-approval signal. Walk the token stream once
// from right to left: a conjunction is relevant only after we have seen a
// valid condition/approval pair to its right. This avoids rescanning every
// shrinking suffix of a maximum-size answer.
const conditionedApprovalConjunction = text => {
  if (!approvalConditionCandidate(text)) return -1;
  const events = [...text.matchAll(approvalFlowWithConjunction)];
  let approvalSeen = false, conditionedPairSeen = false, earliest = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.groups.boundary) {
      approvalSeen = false;
      conditionedPairSeen = false;
    } else if (event.groups.approval) {
      approvalSeen = true;
    } else if (event.groups.condition && approvalSeen) {
      conditionedPairSeen = true;
    } else if (event.groups.conjunction && conditionedPairSeen) {
      earliest = event.index;
    }
  }
  return earliest;
};
// A business rule may branch on approval of a purchase/refund/etc. That is not
// a gate on this agent's implementation unless the approved object or resulting
// action is itself software/repository work. Keep this exemption structural and
// Only explicitly recognized business actions are exempted from owner gates.
const businessApprovalStem = new RegExp(String.raw`\b${ownerApprovalConditionLead}\s+(?:(?:I|we|you|the\s+owner|a\s+human|the\s+reviewer)(?:(?:\s+(?:have|has|had))|(?:['’](?:ve|s)))?\s+)(?:approve(?:s|d)?|confirm(?:s|ed)?|consent(?:s|ed)?|permit(?:s|ted)?|agree(?:s|d)?|review(?:s|ed)?|authorize(?:s|ed)?)\b`, "giu");
const implementationAfterApproval = /\b(?:proceed|continue|resume|implement|develop|build|change|modify|refactor|rewrite|execute|run|fix|repair|deploy|release|push|commit|publish|deliver|merge|tests?|compile|package)\b/i;
const businessApprovalAction = /\b(?:send|show|display|apply|mark|notify|email|finish|complete|process|issue|grant|charge|refund|credit|record|capture|create|generate)\b/i;
const businessApprovalGerunds = String.raw`sending|showing|displaying|applying|marking|notifying|emailing|finishing|completing|processing|issuing|granting|charging|refunding|crediting|recording|capturing|creating|generating`;
const businessApprovalGerund = new RegExp(String.raw`^(?:${businessApprovalGerunds})$`, "iu");
const businessApprovalThirdPersons = String.raw`sends|shows|displays|applies|marks|notifies|emails|finishes|completes|processes|issues|grants|charges|refunds|credits|records|captures|creates|generates`;
const businessApprovalThirdPerson = new RegExp(String.raw`^(?:${businessApprovalThirdPersons})$`, "iu");
const businessApprovalActionForm = new RegExp(String.raw`${businessApprovalAction.source}|\b(?:${businessApprovalGerunds}|${businessApprovalThirdPersons})\b`, "giu");
const technicalImplementationObject = /\b(?:database|sql|schema|migration|code|source|repository|repo|branch|commit|pull[\s-]+request|pr|test|build|package|module|script|endpoint|api|configuration|config|workflow|deployment|artifact|runtime|service|docker|image|lockfile|terraform|kubernetes|sdk|manifest)\b/i;
const businessOutcomeObject = /\b(?:customer|client|user|buyer|seller|merchant|account|checkout|order|purchase|refund|payment|invoice|receipt|discount|loan|transaction|support|request|consent|confirmation|notification|email|message|comment|subscription|charge|credit|address|cart)\b/iu;
// Every business action needs positive business-object evidence in its own
// clause. An unlisted object is not business data by default: "apply the
// Terraform plan" or "send the report" after an owner approval stay owner gates
// rather than being exempted because the verb alone looks commercial.
const businessNounDeterminer = /(?:\b(?:a|an|the|this|that|these|those|my|our|your|their|his|her|its|each|every|any|some|no|new|another)|['’]s)\s+$/iu;
const businessPossessiveDeterminer = /(?:\b(?:my|our|your|their|his|her|its)|['’]s|s['’])\s+$/iu;
// The object is judged by its noun-phrase head, not by any business word in
// the clause: "the payment SDK" is a software artifact with a business
// modifier, while "a confirmation page" is business data presented on a surface.
const businessPresentationNoun = /^(?:pages?|screens?|dialogs?|modals?|banners?|toasts?|notices?|views?|summar(?:y|ies)|popups?|prompts?|letters?|slips?|statements?|notes?|alerts?|reminders?)$/iu;
// "Upon" and "following" share prepositional and temporal checks, including
// case-sensitive named actors and complete relative bridges below.
const prepositionalTemporalBusinessActionConnector = String.raw`(?:[uU][pP][oO][nN]|[fF][oO][lL][lL][oO][wW][iI][nN][gG]|[pP][eE][nN][dD][iI][nN][gG]|[aA][wW][aA][iI][tT][iI][nN][gG])`;
// Object-ending prepositions can also introduce another action. Share them
// with the gerund grammar so stopping object validation cannot hide that work.
// Prepositional concessions use these nominal/gerund checks too: "despite
// proofreading" is an action, while "despite the discount" remains noun data.
const methodBusinessActionConnector = String.raw`for|with|from|by|at|in|on|into|onto|via|through|about|of|${prepositionalConcessiveBusinessActionConnector}|${prepositionalTemporalBusinessActionConnector}`;
const methodBusinessActionLead = new RegExp(String.raw`^(?:${methodBusinessActionConnector})$`, "iu");
const relativeBusinessActionConnector = String.raw`that|which`;
// A recipient named "So" after "to" is not a purpose clause. Spell out the
// connector's case variants for the case-sensitive named-actor matcher too.
// Consume "so that" completely; backtracking must not reinterpret THAT as a name.
const finitePurposeBusinessActionConnector = String.raw`(?<!\bto\s+)[sS][oO](?:\s+[tT][hH][aA][tT]|(?!\s+[tT][hH][aA][tT]\b))(?=\s+[\p{L}])`;
// These conditional participles permit bare and "that" forms. Consume the
// complete connector so neither workflow pronouns nor named actors can claim
// its optional "that"; explicit case variants also serve named-actor matching.
const conditionalBusinessActionConnector = String.raw`(?:[aA][sS][sS][uU][mM][iI][nN][gG]|[pP][rR][oO][vV][iI][dD](?:[eE][dD]|[iI][nN][gG])|[gG][iI][vV][eE][nN]|[sS][uU][pP][pP][oO][sS][iI][nN][gG])(?:\s+[tT][hH][aA][tT]|(?!\s+[tT][hH][aA][tT]\b))`;
const businessConnectorWorkflowWords = new RegExp(String.raw`\b(?:${finitePurposeBusinessActionConnector}|${conditionalBusinessActionConnector})\b`, "giu");
// Subordinate actions share their head and object checks; ending an object
// must not hide the next clause's action.
// Consume the relative bridge with its temporal connector so "which" cannot
// hide the finite actor or be reinterpreted as a capitalized actor name.
// "Whereupon" uses the same action checks and guard for unrecognized heads.
const relativeTemporalBusinessActionConnector = String.raw`(?:(?:[aA][fF][tT][eE][rR]|[bB][eE][fF][oO][rR][eE]|${prepositionalTemporalBusinessActionConnector})\s+[wW][hH][iI][cC][hH]|[wW][hH][eE][rR][eE][uU][pP][oO][nN])`;
const preventiveBusinessActionConnector = String.raw`[lL][eE][sS][tT]`;
const guardedBusinessActionClause = new RegExp(String.raw`\b(?:${relativeTemporalBusinessActionConnector}|${preventiveBusinessActionConnector})\b`, "giu");
const temporalBusinessActionConnector = String.raw`${relativeTemporalBusinessActionConnector}|${preventiveBusinessActionConnector}|${concessiveBusinessActionConnector}|${prepositionalConcessiveBusinessActionConnector}|${prepositionalTemporalBusinessActionConnector}(?!\s+[wW][hH][iI][cC][hH]\b)|${conditionalBusinessActionConnector}|before|after|${concurrentBusinessActionConnector}|once|until|when|whenever|if|unless|because|since|thereby|thus|hence|${finitePurposeBusinessActionConnector}|as\s+soon\s+as|by\s+the\s+time|as`;
const businessObjectBoundary = new RegExp(String.raw`\s+(?:to|${methodBusinessActionConnector}|${temporalBusinessActionConnector}|${relativeBusinessActionConnector})\b`, "iu");
const businessObjectWords = tail => tail.split(businessObjectBoundary, 1)[0]
  .trim().split(/\s+/).filter(word => word && !/^(?:a|an|the|this|that|these|those|my|our|your|their|his|her|its|each|every|any|some|all|no|new|another)$/i.test(word));
const businessObjectEvidence = phrase => {
  const words = businessObjectWords(phrase), head = words.at(-1) || "", modifier = words.at(-2) || "";
  return businessOutcomeObject.test(head) || businessPresentationNoun.test(head) && businessOutcomeObject.test(modifier);
};
const businessNominalObjectEvidence = phrase => businessObjectEvidence(phrase) && businessObjectWords(phrase)
  .every(word => businessOutcomeObject.test(word) || businessPresentationNoun.test(word));
const businessActionCoordination = String.raw`${coordination}|alongside|then|but|yet|${concurrentBusinessActionConnector}|${concessiveBusinessActionConnector}`;
// Symbols have no word boundaries. Share their complete separator grammar
// between object ownership and every coordinated action-head check.
const businessActionCoordinationBoundary = String.raw`(?:${symbolicActionConnector}|\b(?:${businessActionCoordination})\b)`;
const purposeBusinessActionNoun = String.raw`purpose|aim|goal|intent(?:ion)?|objective`;
const purposeBusinessActionConnector = String.raw`(?:(?:in\s+order|so\s+as)\s+(?:not\s+)?to|with\s+a\s+view\s+to|(?:for|with)\s+(?:(?:a|an|the)\s+)?(?:${purposeBusinessActionNoun})s?\s+of)`;
const supportedPurposeBusinessConnector = new RegExp(String.raw`^(?:${purposeBusinessActionConnector})$`, "iu");
const businessActionBoundary = new RegExp(String.raw`[,.;:]|${businessActionCoordinationBoundary}|\b(?:${temporalBusinessActionConnector}|${purposeBusinessActionConnector}|${methodBusinessActionConnector}|${relativeBusinessActionConnector})\b`, "iu");
function businessActionsHaveObjects(response, approvedBusinessPronoun) {
  const possessiveGerundStarts = new Set([...response.matchAll(gerundBusinessActionHead)]
    .filter(match => possessiveBusinessGerundAction(response, match))
    .map(match => match.index + match[0].length - match.groups.head.length));
  for (const action of response.matchAll(businessApprovalActionForm)) {
    // "send the customer an email": a determined word is the object noun, not
    // a second action. A possessive gerund still needs its own object:
    // "your emailing the report" cannot inherit the customer's business scope.
    if (businessNounDeterminer.test(response.slice(0, action.index)) && !possessiveGerundStarts.has(action.index)) continue;
    const start = action.index + action[0].length;
    const tail = response.slice(start, start + 160).split(businessActionBoundary, 1)[0];
    const pronounAction = approvedBusinessPronoun && /^(?:show|display|mark|apply)$/i.test(action[0]) && /^\s+(?:it|them)\b/i.test(tail);
    if (!businessObjectEvidence(tail) && !pronounAction) return false;
  }
  return true;
}
const coordinatedBusinessActionHead = new RegExp(String.raw`(?:,|${businessActionCoordinationBoundary})\s*(?:and\s+|then\s+)?(?<head>[\p{L}][\p{L}'’-]*)`, "giu");
const purposeBusinessActionHead = new RegExp(String.raw`\b${purposeBusinessActionConnector}\s+(?:not\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b`, "giu");
const bareBusinessActionHead = /\bto\s+(?:not\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b/giu;
const businessToConnector = new RegExp(String.raw`${businessActionCoordinationBoundary}|\b(?:${purposeBusinessActionConnector})\b`, "giu");
const businessRecipientPronoun = /^(?:me|us|you|him|her|them|it)$/iu;
const businessRecipientName = /^(?:[\p{Lu}][\p{L}'’-]*)(?:\s+[\p{Lu}][\p{L}'’-]*)*$/u;
const temporalApprovalRole = String.raw`(?:owner|reviewer|editor|author|developer|team|agent|assistant|worker|customer|manager|maintainer|engineer|designer)s?`;
// Actor modifiers stay inside this clause. Stopping at connectors prevents a
// failed role match from rescanning later temporal clauses as a long noun phrase.
const temporalApprovalActorModifier = String.raw`(?!(?:${businessActionCoordination}|${temporalBusinessActionConnector}|${purposeBusinessActionConnector}|${relativeBusinessActionConnector})\b)[\p{L}][\p{L}'’-]*\s+`;
// Any object-ending method preposition may introduce a nominal complement,
// including a gerund after "of", a finite clause after "that", or "in case".
// Unsupported complements retain the gate instead of inheriting an earlier
// business action's exemption. "Case-sensitive" does not start a clause.
const nominalPurposeBusinessAction = new RegExp(String.raw`\b(?<connector>(?:${methodBusinessActionConnector})\s+(?:(?!(?:of|that)\b)${temporalApprovalActorModifier}){1,6}(?:of(?=\s+(?:${temporalApprovalActorModifier})*?[\p{L}]+ing\b)|that\b)|in\s+case(?=\s|[,.;:]|$))`, "giu");
const temporalApprovalActor = String.raw`I|we|you|they|he|she|(?:the|a|an|my|our|your|their|his|her)\s+(?:${temporalApprovalActorModifier})*?(?:${temporalApprovalRole})`;
// Intervening words cannot hide a gerund or borrow a supported action from a
// later temporal or method clause. Keep actor noun phrases in their own grammar.
const gerundBusinessActionModifier = String.raw`(?!(?:${methodBusinessActionConnector})\b)${temporalApprovalActorModifier}`;
const gerundBusinessActionActor = new RegExp(String.raw`^\s*(?:${temporalApprovalActor})\s+(?:${gerundBusinessActionModifier})*$`, "iu");
const gerundBusinessActionHead = new RegExp(String.raw`\b(?<connector>${temporalBusinessActionConnector}|${methodBusinessActionConnector})\s+(?<modifiers>(?:${gerundBusinessActionModifier})*?)(?<head>[\p{L}]+ing)\b`, "giu");
function possessiveBusinessGerundAction(response, match) {
  if (!match.groups.modifiers.trim().split(/\s+/u).some(word => businessPossessiveDeterminer.test(word + " "))) return false;
  const tail = response.slice(match.index + match[0].length);
  // Only positive nominal evidence can waive action validation. An unknown
  // gerund may take an "of" complement or a bare object; neither makes it
  // business data. Retain ordinary nominal modifiers such as recurring payment.
  const nominalModifier = /^(?:recurring|ongoing|outstanding|upcoming|pending|existing)$/iu.test(match.groups.head);
  // Billing/shipping address are domain fields, not commands to bill or ship.
  const addressField = /^(?:billing|shipping)$/iu.test(match.groups.head) && /^\s+address(?:es)?\b/iu.test(tail);
  return businessApprovalGerund.test(match.groups.head) || !(addressField || nominalModifier && businessNominalObjectEvidence(tail));
}
const finiteTemporalBusinessActionHead = new RegExp(String.raw`\b(?:${temporalBusinessActionConnector})\s+(?:${temporalApprovalActor})\s+(?:(?:have|has|had|will|can|should|must)\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b`, "giu");
const namedTemporalBusinessActionHead = new RegExp(String.raw`\b(?:${temporalBusinessActionConnector})\s+(?:[\p{Lu}][\p{L}'’-]*\s+){1,2}(?:(?:have|has|had|will|can|should|must)\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b`, "gu");
const initialBusinessActionHead = new RegExp(String.raw`^\s*(?:please\s+)?(?:(?:${temporalApprovalActor})\s+(?:(?:have|has|had|will|can|should|must)\s+)?)?(?<head>[\p{L}][\p{L}'’-]*)\b`, "iu");
const initialNamedBusinessActionHead = /^(?:[\p{Lu}][\p{L}'’-]*\s+){1,2}(?:(?:have|has|had|will|can|should|must)\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b/u;
// Modifiers, modals and negation precede the same causative action. Reuse the
// clause-bounded word grammar so an unlisted adverb cannot hide that action or
// make the matcher borrow a causative from a later clause.
const relativeCausativeBusinessAction = new RegExp(String.raw`\b(?:${relativeBusinessActionConnector})\s+(?:${gerundBusinessActionModifier})*?(?:lets?|makes?|helps?|allows?|enables?|permits?|requires?|(?<having>have|has|had))\b`, "giu");
const relativeCausativeBusinessActionHead = new RegExp(String.raw`^\s+(?:${temporalApprovalActor}|me|us|him|her|them|it)\s+(?:to\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b`, "iu");
const namedRelativeCausativeBusinessActionHead = /^\s+(?:[\p{Lu}][\p{L}'’-]*\s+){1,2}(?:to\s+)?(?<head>[\p{L}][\p{L}'’-]*)\b/u;
const passiveTemporalBusinessAction = new RegExp(String.raw`\b(?:${temporalBusinessActionConnector})\s+(?<object>(?:(?:the|a|an|this|that|these|those|my|our|your|their)\s+)?[\p{L}][\p{L}'’-]*(?:\s+[\p{L}][\p{L}'’-]*){0,3}?)\s+(?:(?:is|are|was|were)\s+(?:being\s+)?|(?:gets?|got|being)\s+|(?:has|have|had)\s+been\s+|(?:will|can|could|must|should|would|may|might)\s+be\s+)(?<head>[\p{L}][\p{L}'’-]*)\b`, "giu");
const businessApprovalPassiveHead = /^(?:sent|shown|displayed|applied|marked|notified|emailed|finished|completed|processed|issued|granted|charged|refunded|credited|recorded|captured|created|generated|paid)$/iu;
const supportedBusinessActionHead = head => businessApprovalAction.test(head) || businessApprovalGerund.test(head) || businessApprovalThirdPerson.test(head);
function supportedBareBusinessActions(response) {
  const connectors = [...response.matchAll(businessToConnector)];
  let connectorIndex = 0;
  for (const match of response.matchAll(bareBusinessActionHead)) {
    while (connectorIndex < connectors.length && connectors[connectorIndex].index + connectors[connectorIndex][0].length <= match.index) connectorIndex++;
    // The complete named connector already validates its following head (for
    // example, "not to mention" must not turn "mention" into another action).
    if (connectors[connectorIndex]?.index <= match.index) continue;
    const { head } = match.groups;
    if (supportedBusinessActionHead(head)) continue;
    const start = match.index + match[0].length - head.length;
    // Retain "to" while finding contextual boundaries, so a recipient named
    // "So Smith" cannot become a purpose clause when its prefix is sliced off.
    const boundary = response.slice(match.index).search(businessActionBoundary);
    const recipient = response.slice(start, boundary < 0 ? undefined : match.index + boundary).trim();
    if (businessNounDeterminer.test(head + " ") || businessRecipientPronoun.test(head) ||
        (recipient === head && businessOutcomeObject.test(head)) || businessRecipientName.test(recipient)) continue;
    return false;
  }
  return true;
}
function supportedBusinessActionSequence(response) {
  // The exemption covers explicit business workflows, not a business action
  // followed by an arbitrary coordinated imperative. Treat an unsupported or
  // ambiguous second head as task work so an approval condition stays visible.
  if (![initialBusinessActionHead.exec(response), initialNamedBusinessActionHead.exec(response)]
    .some(match => match && supportedBusinessActionHead(match.groups.head))) return false;
  if (!supportedBareBusinessActions(response)) return false;
  for (const match of response.matchAll(nominalPurposeBusinessAction))
    if (!supportedPurposeBusinessConnector.test(match.groups.connector)) return false;
  // A relative clause can enable another action under the same approval.
  // Require a supported head even when the actor is unfamiliar; descriptive
  // relatives such as "which contains the receipt" are still object metadata.
  for (const match of response.matchAll(relativeCausativeBusinessAction)) {
    const start = match.index + match[0].length, tail = response.slice(start, start + 160);
    // "Has" also describes possession. Exempt a complete nominal business
    // object, not an arbitrary actor/action phrase ending in a business noun.
    if (match.groups.having && (start + tail.length === response.length || businessActionBoundary.test(tail))) {
      const possession = tail.trim().split(businessActionBoundary, 1)[0];
      if (businessNominalObjectEvidence(possession)) continue;
      const passive = /^(?<object>.+)\s+(?<head>[\p{L}][\p{L}'’-]*)$/u.exec(possession);
      if (passive && businessNominalObjectEvidence(passive.groups.object) && businessApprovalPassiveHead.test(passive.groups.head)) continue;
    }
    if (![relativeCausativeBusinessActionHead.exec(tail), namedRelativeCausativeBusinessActionHead.exec(tail)]
      .some(head => head && supportedBusinessActionHead(head.groups.head))) return false;
  }
  const passiveTemporalHeads = [...response.matchAll(passiveTemporalBusinessAction)];
  for (const match of passiveTemporalHeads)
    if (!businessObjectEvidence(match.groups.object) ||
        !(businessApprovalAction.test(match.groups.head) || businessApprovalPassiveHead.test(match.groups.head))) return false;
  const finiteTemporalHeads = [...response.matchAll(finiteTemporalBusinessActionHead)];
  const seenTemporalStarts = new Set(finiteTemporalHeads.map(match => match.index));
  for (const match of response.matchAll(namedTemporalBusinessActionHead))
    if (!seenTemporalStarts.has(match.index)) finiteTemporalHeads.push(match);
  const finiteTemporalStarts = new Set(finiteTemporalHeads.map(match => match.index));
  const gerundHeads = [...response.matchAll(gerundBusinessActionHead)].filter(match => {
    // Finite actors and determined noun phrases are not gerund modifiers:
    // "Alice King emails" and "the recurring payment clears" retain their
    // existing finite-action and business-condition validation.
    const firstModifier = /^\S+\s+/u.exec(match.groups.modifiers)?.[0] || "";
    if (finiteTemporalStarts.has(match.index)) return false;
    const method = methodBusinessActionLead.test(match.groups.connector);
    if (businessNounDeterminer.test(firstModifier) && (!method || !gerundBusinessActionActor.test(match.groups.modifiers)) &&
        !possessiveBusinessGerundAction(response, match)) return false;
    // A standalone name after a method preposition is a destination, not a
    // gerund action ("by Alice King"). A following object keeps it actionable.
    const clause = response.slice(match.index + match.groups.connector.length).split(businessActionBoundary, 1)[0].trim();
    return !(method && match.groups.modifiers.trim() && businessRecipientName.test(clause));
  });
  // Every validated clause head takes precedence over a connector's possible
  // coordination reading, including passive business outcomes after "though".
  const parsedActionStarts = new Set([...finiteTemporalHeads, ...gerundHeads, ...passiveTemporalHeads].map(match => match.index));
  // Relative and preventive clauses need a recognized action head, even when
  // their actor is unfamiliar, before inheriting the business exemption.
  for (const match of response.matchAll(guardedBusinessActionClause))
    if (!parsedActionStarts.has(match.index)) return false;
  return [...response.matchAll(coordinatedBusinessActionHead)].filter(match => !parsedActionStarts.has(match.index))
    .concat(finiteTemporalHeads, gerundHeads, [...response.matchAll(purposeBusinessActionHead)])
    .every(match => supportedBusinessActionHead(match.groups.head));
}
const taskArtifactCreation = /\b(?:create|generate|make|build|develop|implement)\b(?:(?![.!?;:\n\u2012-\u2015]).){0,160}\b(?:pages?|dashboards?|widgets?|views?|panels?|forms?|screens?|interfaces?|components?|endpoints?|apis?|features?|services?|modules?|templates?|buttons?|dialogs?|modals?|routes?|frontends?)\b/i;
const businessApprovalPunctuation = /[:\u2012-\u2015]|(?<=\s)--?(?=\s)/g;
// Colons and dashes continue the approval response; validate their next action
// before masking. Preserve UTF-16 length so the resulting spans still fit source.
const businessApprovalText = text => text.replace(businessApprovalPunctuation, match => "," + " ".repeat(match.length - 1));
function businessApprovalHints(text) {
  const commas = new Uint32Array(text.length + 1), boundaries = new Uint32Array(text.length + 1), previousBoundary = new Uint32Array(text.length + 1);
  commas[text.length] = boundaries[text.length] = text.length;
  let previous = 0;
  for (let i = 0; i < text.length; i++) {
    if (/[.!?;:\n\u2012-\u2015]/.test(text[i])) previous = i + 1;
    previousBoundary[i + 1] = previous;
  }
  for (let i = text.length - 1; i >= 0; i--) {
    commas[i] = text[i] === "," ? i : commas[i + 1];
    boundaries[i] = /[.!?;:\n\u2012-\u2015]/.test(text[i]) ? i : boundaries[i + 1];
  }
  return { commas, boundaries, previousBoundary };
}
const businessApprovalCandidates = (text, hints, stems) => stems.flatMap((match, index) => {
  // Match only the short approval stem, then use precomputed delimiters to
  // capture one response clause. Stop at the next approval rule too, so
  // repeated comma-separated rules do not allocate overlapping suffixes.
  const start = match.index + match[0].length, comma = hints.commas[start], boundary = hints.boundaries[start];
  const nextStem = stems[index + 1]?.index ?? text.length;
  if (comma >= boundary || comma >= nextStem) return [];
  const subject = text.slice(start, comma).trim(), responseEnd = Math.min(hints.boundaries[comma + 1], nextStem);
  const response = text.slice(comma + 1, responseEnd).trim();
  if (!subject || !response) return [];
  return [{ match: { index: match.index, 0: text.slice(match.index, responseEnd), groups: { subject, response } }, leadingApproval: true }];
});
const MAX_BUSINESS_APPROVAL_CONTEXT = 1024;
const actionBefore = (positions, start, end) => {
  let left = 0, right = positions.length;
  while (left < right) { const middle = (left + right) >>> 1; if (positions[middle] < start) left = middle + 1; else right = middle; }
  return left < positions.length && positions[left] < end;
};
const trailingBusinessApprovalCandidates = (text, hints, actionPositions, stems) => stems.flatMap((match, index) => {
  // The approval stem and punctuation map are linear; only inspect a short
  // preceding clause that already contains a recognizable business action.
  const clauseStart = hints.previousBoundary[match.index];
  if (match.index - clauseStart > MAX_BUSINESS_APPROVAL_CONTEXT || !actionBefore(actionPositions, clauseStart, match.index)) return [];
  const rawResponse = text.slice(clauseStart, match.index), trimmed = rawResponse.trim();
  if (!trimmed) return [];
  const responseStart = clauseStart + rawResponse.indexOf(trimmed), subjectStart = match.index + match[0].length;
  const subjectEnd = Math.min(hints.commas[subjectStart], hints.boundaries[subjectStart]);
  const subject = text.slice(subjectStart, subjectEnd).trim();
  if (!subject) return [];
  // A trailing condition can govern actions on both sides of its subject.
  // Validate that continuation too, without crossing the next approval rule.
  const responseEnd = Math.min(hints.boundaries[subjectEnd], stems[index + 1]?.index ?? text.length);
  const response = trimmed + text.slice(subjectEnd, responseEnd);
  return [{ match: { index: responseStart, 0: text.slice(responseStart, responseEnd), groups: { subject, response } }, leadingApproval: false }];
});
const businessApprovalCoordinator = new RegExp(String.raw`[,;]?\s*(?:and|but|then|or|nor|yet|${concurrentBusinessActionConnector}|${concessiveBusinessActionConnector})\s*$`, "iu");
const precedingBusinessApprovalContext = new RegExp(String.raw`^(?:when|whenever|once|after|before|unless|${concurrentBusinessActionConnector}|${concessiveBusinessActionConnector}|if|provided(?:\s+that)?)\b[^.!?;:]*,\s*$`, "iu");
const businessApprovalMatches = source => {
  const text = businessApprovalText(source);
  if (!approvalConditionCandidate(text)) return [];
  const hints = businessApprovalHints(text);
  const actionPositions = [...text.matchAll(new RegExp(businessApprovalAction.source, "giu"))].map(match => match.index);
  const stems = [...text.matchAll(businessApprovalStem)];
  return [...businessApprovalCandidates(text, hints, stems), ...trailingBusinessApprovalCandidates(text, hints, actionPositions, stems)].filter(({ match, leadingApproval }) => {
    const { subject, response } = match.groups;
    // "That" in a complete action connector is not a workflow pronoun.
    // Keep every other response word visible to the existing workflow check.
    const responseWorkflow = response.replace(businessConnectorWorkflowWords, phrase => " ".repeat(phrase.length));
    const approvedBusinessPronoun = businessObjectEvidence(subject) && !technicalImplementationObject.test(subject);
    const displaysApprovedBusinessData = approvedBusinessPronoun && /\b(?:show|display|mark|apply)\s+(?:it|them)\b/i.test(response);
    const clauseStart = hints.previousBoundary[match.index], clauseLength = match.index - clauseStart;
    const precedingClause = text.slice(Math.max(clauseStart, match.index - MAX_BUSINESS_APPROVAL_CONTEXT), match.index);
    const followsCoordinator = businessApprovalCoordinator.test(precedingClause);
    const beginsClause = clauseLength <= MAX_BUSINESS_APPROVAL_CONTEXT && !precedingClause.trim() || followsCoordinator ||
      clauseLength <= MAX_BUSINESS_APPROVAL_CONTEXT && precedingBusinessApprovalContext.test(precedingClause.trim());
    // Ambiguous actions need a business object in their own clause. Explicit
    // implementation surfaces remain owner gates even when their names
    // contain a business noun such as “account”.
    return !workflowObject(` ${subject}`) && (!workflowObject(` ${responseWorkflow}`) || displaysApprovedBusinessData) && !taskArtifactCreation.test(response) &&
      !(businessApprovalAction.test(response) && technicalImplementationObject.test(response)) &&
      (businessApprovalAction.test(response) || displaysApprovedBusinessData) && businessActionsHaveObjects(response, approvedBusinessPronoun) && supportedBusinessActionSequence(response) &&
      !implementationAfterApproval.test(response) && (!leadingApproval || beginsClause);
  }).map(({ match, leadingApproval }) => {
    let end = match.index + match[0].length;
    if (leadingApproval) {
      const response = match.groups.response;
      const responseStart = match.index + match[0].lastIndexOf(response);
      // A business outcome can be followed by a separate coordinated owner gate
      // (“email the customer and wait until the owner approves”). Exempt only
      // the business action; leave that later prerequisite visible to intake.
      const conditionedConjunction = conditionedApprovalConjunction(response);
      if (conditionedConjunction !== -1) end = responseStart + conditionedConjunction;
    }
    return { start: match.index, end };
  });
};
const outsideBusinessApprovalRules = text => {
  const spans = businessApprovalMatches(text).sort((a, b) => a.start - b.start);
  if (!spans.length) return text;
  let output = "", cursor = 0, maskStart = spans[0].start, maskEnd = spans[0].end;
  const appendMask = (start, end) => { output += text.slice(start, end).replace(/[^\n]/g, " "); };
  for (const span of spans.slice(1)) {
    if (span.start <= maskEnd) maskEnd = Math.max(maskEnd, span.end);
    else {
      output += text.slice(cursor, maskStart); appendMask(maskStart, maskEnd);
      cursor = maskEnd; maskStart = span.start; maskEnd = span.end;
    }
  }
  output += text.slice(cursor, maskStart); appendMask(maskStart, maskEnd);
  return output + text.slice(maskEnd);
};
const completedApprovalGate = /\b(?:after|once|when)\s+(?:(?:I|we|you|the\s+owner)(?:(?:\s+(?:have|has|had))|(?:['’](?:ve|s)))?|the\s+owner\s+(?:has|had))\s+(?:approved|confirmed|consented|permitted|agreed|reviewed|authorized)\b(?=\s*[,;:]|\s+(?:then|now)\b)/i;
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
const historicalApprovalQualifierPrefix = new RegExp(String.raw`^\s*(?:only\s+)?${ownerApprovalConditionLead}\b[^.!;\n]*\b(?:approve(?:s|d)?|confirm(?:s|ed)?|consent(?:s|ed)?|permit(?:s|ted)?|agree(?:s|d)?|review(?:s|ed)?|authoriz(?:e|es|ed)|approval|permission|confirmation|consent)\b[^.!;\n]*$`, "iu");
const historicalDeliveryQualifierPrefix = /^\s*(?:today|tomorrow|tonight|later|soon|immediately|eventually|only|after|before|until|unless|when|once|if|provided|subject\s+to|pending|following|against\s+(?:(?:a|an|the|our|my|your)\s+)?[\p{L}\p{N}-]+\b|(?:from|into|onto|to|in|at|on|via|through)\s+(?:(?:a|an|the|our|my|your)\s+)?(?:github|gitlab|remote|origin|upstream|repository|repo|branch|release|main|master|develop|development|trunk|staging|production|review)\b|for\s+(?:review|release|merge)\b|with(?:out)?\s+(?:(?:my|our|your|owner|human)\s+)?(?:approval|permission|consent|confirmation|review)\b)/iu;
const ownerPrerequisite = (text, saved = false) => approvalForWorkflow(text, saved) || !saved && completedApprovalGate.test(text) || requestedApproval.test(text) || conditionedApprovalMatches(saved ? text : outsideBusinessApprovalRules(text)) || requiredApproval.test(text) || standalonePrerequisite.test(text);
const stable = value => JSON.stringify(value, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);

// Keep offsets in JavaScript UTF-16 units, explicitly. Mask literals before
// locating punctuation or directives: examples/code are not publication authority.
const apostrophe = (source, index) => /[\p{L}\p{N}]/u.test(source[index - 1] || "") && /[\p{L}\p{N}]/u.test(source[index + 1] || "");
const leadingElisionWord = /^(?:\d{2}s|tis|twas|twere|cause|em|til|till|round|bout)\b/i;
const leadingElision = (source, index) => ["'", "‘"].includes(source[index]) && !/[\p{L}\p{N}]/u.test(source[index - 1] || "") && leadingElisionWord.test(source.slice(index + 1, index + 7));
const elisionQuoteTail = new Set(["in", "as", "for", "to", "from", "with", "before", "after", "when", "where", "by", "on", "at", "is", "was", "means", "appears", "written", "spelled", "verbatim", "literally", "and"]);
function literalHints(source) {
  const size = source.length, escaped = new Uint8Array(size), nextClause = new Uint32Array(size + 1), nextSingle = new Uint32Array(size + 1), nextSmart = new Uint32Array(size + 1);
  let slashes = 0;
  for (let i = 0; i < size; i++) {
    if (source[i] === "\\") { slashes++; continue; }
    escaped[i] = slashes % 2;
    slashes = 0;
  }
  nextClause[size] = nextSingle[size] = nextSmart[size] = size;
  for (let i = size - 1; i >= 0; i--) {
    nextClause[i] = /[,;.!?\n]/.test(source[i]) ? i : nextClause[i + 1];
    const validQuote = !escaped[i] && !apostrophe(source, i) && !leadingElision(source, i);
    nextSingle[i] = source[i] === "'" && validQuote ? i : nextSingle[i + 1];
    nextSmart[i] = source[i] === "’" && validQuote ? i : nextSmart[i + 1];
  }
  return { nextClause, nextSingle, nextSmart };
}
function elisionCloseAllowed(source, closeAt, limit) {
  // In a coordinated possessive (“customers' and admins' safety”), neither
  // apostrophe closes a leading elision such as “'cause”.
  if (/^\s+(?:and(?:\s+then)?|or|nor|plus|as\s+well\s+as|along\s+with|together\s+with|in\s+addition\s+to|not\s+to\s+mention|besides)\s+[\p{L}\p{N}_-]+['’]\s+[\p{L}\p{N}_-]+/iu.test(source.slice(closeAt + 1, limit))) return false;
  let i = closeAt + 1;
  while (i < limit && /\s/u.test(source[i])) i++;
  const start = i;
  while (i < limit && /[\p{L}\p{N}_-]/u.test(source[i])) i++;
  return i === start || elisionQuoteTail.has(source.slice(start, i).toLowerCase());
}
function literalClose(source, start, close, saved = false) {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (!source.startsWith(close, i) || (["'", "’"].includes(close) && apostrophe(source, i)) || !saved && leadingElision(source, i)) continue;
    if (close[0] === "`" && (source[i - 1] === "`" || source[i + close.length] === "`")) continue;
    return i;
  }
  return -1;
}
function outsideLiterals(source, saved = false, elisionNonOpeners = true, fixtureDestinations = false) {
  let out = "";
  const hasLeadingElision = !saved && elisionNonOpeners && /(?:^|[^\p{L}\p{N}])['‘](?:\d{2}s|tis|twas|twere|cause|em|til|till|round|bout)\b/iu.test(source);
  const hints = hasLeadingElision ? literalHints(source) : null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i], smart = c === "“" || c === "‘";
    const opener = smart || c === '"' || c === "`" || c === "'" && !/[\p{L}\p{N}]/u.test(source[i - 1] || "");
    if (!opener) { out += c; continue; }
    const elisionOpener = !saved && elisionNonOpeners && leadingElision(source, i);
    const close = smart ? c === "“" ? "”" : "’" : c === "`" ? source.slice(i).match(/^`+/)[0] : c;
    // A leading elision can also begin a quoted example. Treat it as a quote
    // only if its closing delimiter occurs before the next clause boundary;
    // otherwise a later apostrophe in another clause must not hide policy text.
    let end;
    if (elisionOpener) {
      const limit = hints.nextClause[i + 1];
      const candidate = close === "'" ? hints.nextSingle[i + 1] : close === "’" ? hints.nextSmart[i + 1] : source.length;
      if (candidate >= limit || !elisionCloseAllowed(source, candidate, limit)) { out += c; continue; }
      end = candidate;
    } else end = literalClose(source, i + (c === "`" ? close.length - 1 : 0), close, saved);
    if (end === -1) {
      // Historical v1/v2 ownership used an open ASCII literal through EOF.
      // Preserve those approved spans, but never create or answer a new task
      // with a malformed literal that could hide a delivery restriction.
      if (smart || elisionOpener) { out += c; continue; }
      if (!saved) fail("literal examples need matching closing delimiters");
      out += source.slice(i).replace(/[^\n]/g, " "); break;
    }
    const length = end + close.length - i;
    const inner = source.slice(i + close.length, end).trim();
    // A literal in a destination slot is an argument, not example text.
    // Preserve only a same-length live-target marker; never reinterpret saved
    // ownership contracts or expose literal content to the general grammar.
    const destinationContext = out.slice(-128);
    // Share destination modifiers with unquoted targets. A truncated run of
    // object modifiers is uncertainty, not proof that a live URL is test data.
    const truncatedModifiers = out.length > 128 && publicationModifiersWhole.test(destinationContext.trimStart() + " ");
    const destinationSlot = fixtureDestinations && (fixtureQuotedDestinationPrefix.test(destinationContext) || truncatedModifiers);
    const fieldValueSlot = fixtureFieldValuePrefix.test(out.slice(-128));
    const liveLiteral = destinationSlot && !fieldValueSlot && syntheticLiveDestination.test(`on ${fixtureDestinationText(inner)}`);
    const masked = source.slice(i, i + length).replace(/[^\n]/g, " ");
    out += liveLiteral ? fixtureNetworkEndpoint + masked.slice(1) : masked; i += length - 1;
  }
  return out;
}
// Only the workflow modifier in an explicit software/document object is ignored by
// workflow recognition. Preserve its suffix and every other action/condition.
// An actual PR/Git object is not automatically a fixture. These ambiguous data
// suffixes need an explicit synthetic/representation qualifier in the same noun
// phrase; clause boundaries prevent a qualifier from masking a later real action.
const localObjectLead = publicationObjectLead.replaceAll(String.raw`\s`, String.raw`[ \t]`);
const representedPrObject = new RegExp(String.raw`${syntheticQualifierNegation}\b(?:mock|synthetic|fake|dummy|stub|normalized|serialized|deserialized|json|in-memory|sample|example|test|fixture)[ \t]+${localObjectLead}(?<modifier>(?:pull[ \t-]+requests?|prs?)(?:['’]s|['’])?)(?=[ \t-]+(?:objects?|records?|payloads?|schemas?|models?|representations?)\b)`, "igu");
const applicationPrRepresentation = /\b(?:pull[ \t-]+requests?|prs?)(?:['’]s|['’])?(?=[ \t]+(?:models?|records?|payloads?|schemas?|representations?)\b)/giu;
const featureObjectsPattern = current => {
  const space = current ? String.raw`[ \t-]+` : String.raw`[\s-]+`;
  const modifierSpace = current ? String.raw`[ \t-]?` : String.raw`[-\s]?`;
  const policyField = String.raw`(?:(?:optional|editable|searchable|visible|configurable|filterable|sortable|selectable)${space})?(?:fields?|checkers?|apis?|controls?|settings?|options?|preferences?|values?|properties|attributes|(?:[\p{L}][\p{L}-]*(?:able|ible)))`;
  return new RegExp(String.raw`\b(?:pull${space}requests?|prs?|commits?|branch(?:es)?|(?:(?:auto|squash|rebase)${modifierSpace})?merge)(?:['’]s|['’])?(?=${space}(?:(?:details?|review|status|ready|friendly)${space})?(?:${current ? "fixtures?|mocks?|stubs?|examples?|samples?|" : ""}templates?|dialogs?|forms?|components?|views?|pages?|panels?|dashboards?|buttons?|badges?|widgets?|selectors?|selection|messages?|reports?|changelogs?|summar(?:y|ies)|descriptions?|previews?|numbers?|titles?|bod(?:y|ies)|labels?|comments?|discussions?|reviews?|feedback|diffs?|checks?|status(?:es)?|states?|names?|ids?|hashes?|shas?|metadata|history|counts?|links?|urls?|references?|private|public|collapsible|read[-\s]?only|${policyField}|(?:easier|harder|faster|slower|better|worse|simpler|clearer|safer|cheaper|friendlier|costlier))\b)`, "igu");
};
const featureObjects = featureObjectsPattern(true), savedFeatureObjects = featureObjectsPattern(false);
const publicationPolicyPredicates = /^(?:[ \t]+)(?:visible|public|private|collapsible|read[-\s]?only|editable|configurable|filterable|sortable|selectable|searchable|optional|[\p{L}][\p{L}-]*(?:able|ible))\b/iu;
const publicationDirectivePrefix = new RegExp(String.raw`(?:^|[.!?;:\n]|,\s*|\b(?:and|then|but|or|nor|yet)\s+)\s*(?<negative>(?:${negativeLead})\s+)?(?:please\s+)?(?<verb>${currentPublicationVerbs})\s+(?:(?:me|us)\s+)?(?<determiner>one|a|an|the|single|another|new)?\s*${localObjectLead}$`, "iu");
const imperativeOverlapModifier = String.raw`(?:visible|public|private|collapsible|read[-\s]?only|editable|configurable|filterable|sortable|selectable|searchable|optional|[\p{L}][\p{L}-]*(?:able|ible))`;
const imperativeOverlapObject = new RegExp(String.raw`^[ \t-]+${imperativeOverlapModifier}[ \t-]+(?:pull[\s-]+requests?|prs?|commits?|branches?)\b`, "iu");
const controlledPrObject = new RegExp(String.raw`^\s+${localObjectLead}(?:pull[ \t-]+requests?|prs?)$`, "iu");
const publicationVerbWhole = new RegExp(String.raw`^(?:${publicationActorVerb})$`, "iu");
const MAX_IMPERATIVE_OVERLAP_CONTEXT = 512;
function outsideFeatureObjects(text, saved = false, skipApplicationMask = false) {
  const applicationVisible = saved || skipApplicationMask ? text : outsideDelegatedApplicationPublications(text);
  const visible = saved ? applicationVisible : applicationVisible.replace(representedPrObject, (match, modifier) => match.slice(0, -modifier.length) + " ".repeat(modifier.length)).replace(applicationPrRepresentation, match => " ".repeat(match.length));
  let boundaryCursor = 0, clauseStart = 0;
  return visible.replace(saved ? savedFeatureObjects : featureObjects, (match, offset, whole) => {
    // Replacement offsets are monotonic. Advance one boundary cursor instead
    // of slicing and searching every growing prefix; inspect only bounded
    // local context around an overlapping action/object pair.
    while (boundaryCursor < offset) {
      if (/[.!?;\n]/.test(whole[boundaryCursor])) clauseStart = boundaryCursor + 1;
      boundaryCursor++;
    }
    const prefix = whole.slice(Math.max(clauseStart, offset - MAX_IMPERATIVE_OVERLAP_CONTEXT), offset);
    const suffix = whole.slice(offset + match.length, offset + match.length + MAX_IMPERATIVE_OVERLAP_CONTEXT);
    // "Merge" can be either a workflow verb or a noun. Before a
    // generic policy modifier masks one, keep it visible when it is the
    // imperative for a real PR/commit object. Bound the context check; an
    // unusually long ambiguous lead fails closed instead of rescanning a large
    // prefix for every overlapping object.
    // "Commit" is the same kind of verb/noun pair: "do not commit reviewable
    // changes" is a workflow prohibition, "a commit selectable field" a feature.
    const mergeOverlap = /^(?:(?:auto|squash|rebase)[ \t-]?)?merge$/i.test(match.trim()) && imperativeOverlapObject.test(suffix);
    const commitOverlap = /^commits?$/i.test(match.trim()) && publicationPolicyPredicates.test(suffix);
    if (!saved && (mergeOverlap || commitOverlap)) {
      if (offset - clauseStart > MAX_IMPERATIVE_OVERLAP_CONTEXT) fail(`ambiguous ${mergeOverlap ? "merge" : "commit"} command needs clarification`);
      const commandHead = prefix + match;
      if (mergeOverlap && mergeDirective(commandHead) || controlledAction(commandHead)) return match;
    }
    if (!saved && publicationPolicyPredicates.test(suffix)) {
      // Reuse complete negative/action and actor grammar before applying the
      // feature mask; courtesy words and modal actors cannot erase controls.
      // A predicate modifying an explicit field/setting remains a UI object.
      const field = /^\s+[\p{L}-]+\s+(?:fields?|controls?|settings?|options?|preferences?|values?|properties|attributes)\b/iu.test(suffix);
      // A bounded prefix that lost the command head cannot prove an ordinary
      // feature. Keep the object visible for the complete publication scan.
      if (!field && offset - clauseStart > MAX_IMPERATIVE_OVERLAP_CONTEXT) return match;
      const commandHead = prefix + match;
      const productActor = [...commandHead.matchAll(actorLedPublication)].some(actor => applicationPublicationSurface.test(actor.groups.actor.trim()));
      const controlledPublication = [...commandHead.matchAll(controlledActionPattern)].some(control =>
        publicationVerbWhole.test(control.groups.verb) && controlledPrObject.test(commandHead.slice(control.index + control[0].length)));
      const controlledHead = !field && ((!productActor && (controlledAction(commandHead) || controlledPublication)) || workflowActorPublication(commandHead));
      // `prefix` is already relative to this clause (and bounded above). The
      // absolute clause offset must not trim its command/negation a second time.
      const instruction = publicationDirectivePrefix.exec(prefix);
      const determiner = instruction?.groups.determiner?.toLowerCase();
      const productFeature = instruction?.groups.verb?.toLowerCase() === "make" && !instruction.groups.negative && (determiner === "the" || !determiner && /^(?:pull[ \t-]+requests?|prs)\b/i.test(match));
      if (!productFeature && (instruction || controlledHead)) return match;
    }
    return " ".repeat(match.length);
  });
}

export function ownerDelivery(source) {
  if (typeof source === "string" && hasMergeBranchCommand(outsideLiterals(source)))
    fail("merge actions on a branch need a separately approved delivery target");
  const value = partitionOwnerDelivery(source, 5);
  const masked = outsideFeatureObjects(outsideSyntheticPublicationFixtures(outsideLiterals(source, false, true, true)));
  if (publicationGerundProhibition.test(masked)) fail("withheld publication needs an explicit supported delivery contract");
  const outsidePublication = (value?.spans || []).filter(span => span.owner === "coordinator").reduce((text, span) => text.slice(0, span.start) + " ".repeat(span.end - span.start) + text.slice(span.end), masked);
  if (deliveryControl(outsidePublication) || ownerPrerequisite(outsidePublication)) fail("withheld, local-only or approval-dependent delivery needs an explicit supported delivery contract");
  return value;
}

// Saved versions retain their historical literal scanner. Version four treats
// elisions as non-openers; version five bounds feature objects to the same line.
function partitionOwnerDelivery(source, version, saved = false) {
  if (typeof source !== "string" || !source.trim()) fail("a nonempty owner request is required");
  const literalMasked = outsideLiterals(source, saved && version < 3, !saved || version >= 4, !saved);
  const masked = outsideFeatureObjects(saved ? literalMasked : outsideSyntheticPublicationFixtures(literalMasked), saved && version < 5), deliveries = [];
  let from = 0;
  const statements = [];
  for (let i = 0; i < masked.length; i++) if (masked[i] === ";" || masked[i] === "\n" || /[.!]/.test(masked[i]) && /\s|$/.test(masked[i + 1] || "")) {
    statements.push([from, i + 1]); from = i + 1;
  }
  statements.push([from, source.length]);
  let previousStatement = "";
  for (const [start, end] of statements) {
    const visible = masked.slice(start, end);
    const deliveryDirective = saved && version >= 3 && version < 5 ? savedV3V4Directive : directive;
    const matches = [...visible.matchAll(deliveryDirective)];
    const inherited = /:\s*$/.test(previousStatement) ? previousStatement : "";
    const inheritedControl = !saved && unfinishedControlPrefix.test(previousStatement);
    if (visible.trim()) previousStatement = visible;
    if (!matches.length) {
      // Unrecognized affirmative wording is no safer to delegate than a
      // restriction. Require clarification rather than making a provider attest
      // publication that only the coordinator can perform.
      if (publicationDirective(visible, saved && version < 5)) fail("publication wording needs an explicit supported delivery contract");
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
    const acceptedAffirmative = saved && version < 5 ? savedV3V4Affirmative : affirmative;
    if (!acceptedAffirmative.test(clause)) fail("publication has unsupported qualifiers or is mixed with another action");
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
  if (ownerPrerequisite(outsidePublication, saved && version < 5)) fail("publication prerequisites require an explicit clarified task contract");
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
  if (!value || ![1, 2, 3, 4, 5].includes(value.version) || typeof value.source !== "string") fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  if (value.version <= 2) {
    validateHistoricalOwnerDelivery(value);
    validateSavedImplementationControls(value);
    return value;
  }
  if (stable(partitionOwnerDelivery(value.source, value.version, true)) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  // v3/v4 already persisted ownership boundaries. Keep their original parser
  // contract, but refuse an explicit publication direction hidden in the
  // implementation span (for example, "Do not generate a PR" before its
  // coordinator-owned "Open a PR"). Do not reclassify unrelated historical
  // wording with the newer intake grammar.
  if (value.version < 5) {
    const literals = outsideLiterals(value.source, true, value.version >= 4);
    for (const span of value.spans.filter(item => item.owner === "implementation")) {
      const visible = outsideFeatureObjects(literals.slice(span.start, span.end), true);
      if (/\b(?:pull[\s-]+requests?|prs?)\b/i.test(visible) && publicationDirective(visible)) fail("the saved implementation scope contradicts its coordinator publication contract");
    }
  }
  validateSavedImplementationControls(value);
  return value;
}

function validateSavedImplementationControls(value) {
  const literalMasked = outsideLiterals(value.source, value.version < 3, value.version >= 4);
  const featureMasked = outsideFeatureObjects(literalMasked, value.version < 5);
  const implementationSpans = value.spans.filter(span => span.owner === "implementation");
  if (value.version < 5) {
    // Versions 1–4 were already persisted with their own publication grammar;
    // replay only the missing human gate that can still prevent delivery.
    // Re-running today's broader controls here would reinterpret old scope.
    const coordinator = value.spans.find(span => span.owner === "coordinator");
    const coordinatorEnd = coordinator.end;
    const coordinatorText = value.source.slice(coordinator.start, coordinator.end);
    if (!/[.!?\n]\s*$/.test(coordinatorText)) {
      const unownedDeliveryTail = value.source.slice(coordinator.end).split(/[.!?\n]/, 1)[0]
        .replace(/^\s*(?:[,;:]|[-\u2012-\u2015])?\s*/, "");
      if (historicalDeliveryQualifierPrefix.test(unownedDeliveryTail))
        fail("the saved implementation scope contains a delivery timing, destination or condition outside coordinator ownership");
    }
    const postDelivery = implementationSpans.filter(span => span.start >= coordinatorEnd)
      .map(span => featureMasked.slice(span.start, span.end)).join(" ");
    const postDeliveryHead = postDelivery.replace(/^\s*(?:[,;:]|[-\u2012-\u2015])?\s*(?:(?:and|then|but|or|nor|yet)\s+)?/iu, "");
    if ((!/[.!?\n]\s*$/.test(coordinatorText) && historicalDeliveryQualifierPrefix.test(postDeliveryHead)) || awaitReview.test(postDelivery) || heldForApproval.test(postDelivery) || requiredApproval.test(postDelivery))
      fail("the saved implementation scope contains a delivery restriction or approval prerequisite");
    return;
  }
  // Old records intentionally keep their original implementation wording even
  // when today's parser would classify a local/PR preference differently. A
  // human approval gate after the persisted delivery action is different: it
  // can prevent the next side effect and must not be smuggled into criteria.
  const implementation = implementationSpans
    .map(span => featureMasked.slice(span.start, span.end)).join(" ");
  const containsPostDeliveryApprovalGate = awaitReview.test(implementation) || heldForApproval.test(implementation) || requiredApproval.test(implementation);
  if (publicationGerundProhibition.test(implementation) || containsPostDeliveryApprovalGate || deliveryControl(implementation))
    fail("the saved implementation scope contains a delivery restriction or approval prerequisite");
}

function validateHistoricalOwnerDelivery(value) {
  const spans = value.spans;
  if (value.offsets !== "utf16" || !Array.isArray(spans) || !spans.length) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  let cursor = 0;
  const coordinators = [], normalized = [], implementation = [];
  for (const span of spans) {
    if (!span || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start !== cursor || span.end <= span.start || span.end > value.source.length) fail("the saved ownership spans must be contiguous and cover the original request");
    if (span.owner === "implementation" && Object.keys(span).sort().join(",") === "end,owner,start") {
      normalized.push({ start: span.start, end: span.end, owner: "implementation" });
      implementation.push(value.source.slice(span.start, span.end));
    } else if (span.owner === "coordinator" && span.kind === "pull_request" && Object.keys(span).sort().join(",") === "end,kind,owner,start") {
      normalized.push({ start: span.start, end: span.end, owner: "coordinator", kind: "pull_request" });
      coordinators.push(span);
    } else fail("the saved ownership spans contain an unsupported owner or delivery kind");
    cursor = span.end;
  }
  if (cursor !== value.source.length || coordinators.length !== 1 || !/[\p{L}\p{N}]/u.test(implementation.join(""))) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");

  const publication = coordinators[0], prefix = value.source.slice(0, publication.start);
  const rawClause = value.source.slice(publication.start, publication.end);
  const leading = rawClause.match(leadingPublicationConnector);
  // Version one leaves a coordinating word with implementation text; version
  // two owns it with publication. Preserve that stored boundary exactly.
  if (value.version === 1 && leading || value.version === 2 && publicationConnector.test(prefix) || !leading && rawClause !== rawClause.trimStart()) fail("the saved publication connector does not match its original ownership version");
  const clause = rawClause.slice(value.version === 2 ? leading?.[0].length || 0 : 0).trim().replace(/;$/, "").trimEnd();
  const historicalSource = outsideLiterals(value.source, true, false);
  const historicalVisible = historicalSource.slice(publication.start, publication.end);
  const visibleClause = historicalVisible.slice(value.version === 2 ? leading?.[0].length || 0 : 0).trim().replace(/;$/, "").trimEnd();
  const historicalAffirmative = value.version === 1 ? savedV1Affirmative : savedV2Affirmative;
  if (!historicalAffirmative.test(clause) || !historicalAffirmative.test(visibleClause)) fail("the saved coordinator span is not a supported historical affirmative publication clause");

  // The coordinator span alone cannot prove that its original statement was
  // affirmative: a malformed saved range could begin after a negation ("Do
  // not Open a PR"). Recheck only the immediately governing prefix, so an
  // unrelated implementation restriction in an earlier sentence stays valid.
  const statementStart = Math.max(
    historicalSource.lastIndexOf(".", publication.start - 1),
    historicalSource.lastIndexOf("!", publication.start - 1),
    historicalSource.lastIndexOf("?", publication.start - 1),
    historicalSource.lastIndexOf(";", publication.start - 1),
    historicalSource.lastIndexOf("\n", publication.start - 1),
  ) + 1;
  const statementPrefix = historicalSource.slice(statementStart, publication.start);
  // The historical span must begin at a statement boundary or after a
  // recognized connector. A qualifier in any preceding comma clause still
  // governs publication ("Implement export, after CI passes, Open a PR").
  const precedingConnector = publicationConnector.exec(statementPrefix);
  if (statementPrefix.trim() && !precedingConnector && !leading)
    fail("the historical publication span begins inside an unsupported statement");
  const governingPrefix = precedingConnector ? statementPrefix.slice(0, precedingConnector.index) : statementPrefix;
  const governingClauses = governingPrefix.split(",");
  if (unfinishedControlPrefix.test(statementPrefix) || publicationDirective(statementPrefix) || governingClauses.some(clause =>
    historicalApprovalQualifierPrefix.test(clause) || historicalDeliveryQualifierPrefix.test(clause) || /\bto\s*$/iu.test(clause)))
    fail("the historical publication span is preceded by a delivery restriction, condition or approval prerequisite");

  const coordinatorEndsSentence = /[.!?\n]\s*$/.test(historicalSource.slice(publication.start, publication.end));
  // A saved span cannot stop inside its own PR clause and leave an arbitrary
  // qualifier as implementation scope. Historical semicolon clauses remain
  // separate; their post-delivery controls are checked below.
  const coordinatorEndsClause = /[.!?;\n]\s*$/.test(historicalSource.slice(publication.start, publication.end));
  if (!coordinatorEndsClause && historicalSource.slice(publication.end).trim())
    fail("the historical publication span leaves part of its clause outside coordinator ownership");
  if (!coordinatorEndsSentence) {
    const afterPublication = historicalSource.slice(publication.end);
    const afterBoundary = afterPublication.search(/[.!?\n]/);
    const statementSuffix = afterPublication.slice(0, afterBoundary < 0 ? afterPublication.length : afterBoundary)
      .replace(/^\s*(?:[,;:]|[-\u2012-\u2015])?\s*/, "");
    if (historicalDeliveryQualifierPrefix.test(statementSuffix) || ownerPrerequisite(statementSuffix, true) || deliveryControl(statementSuffix) || publicationDirective(statementSuffix))
      fail("the historical publication span leaves a delivery restriction or approval prerequisite outside coordinator ownership");
  }

  const normalizedValue = { version: value.version, offsets: "utf16", source: value.source, spans: normalized };
  if (stable(normalizedValue) !== stable(value)) fail("the saved ownership spans must exactly cover the original request and its supported publication clause");
  return value;
}

export function assertDeliveryAnswer(task, text) {
  if (typeof text === "string" && hasMergeBranchCommand(outsideLiterals(text)))
    fail("merge actions on a branch need a separately approved delivery target");
  const literalMasked = outsideLiterals(text, false, true, true);
  // A PR fixture can be a feature object, but a coordinated live PR shares its
  // publication verb. Check the mixed object list before feature masking.
  if (syntheticFixtureSignal.test(literalMasked) && publicationAction.test(literalMasked) && hasMixedSyntheticPrObjects(literalMasked))
    fail("delivery changes in answers require a new clarified task request");
  // Reuse the intake fixture checks for live destinations before a feature
  // object can hide the publication action from answer validation.
  outsideSyntheticPublicationFixtures(literalMasked);
  const visible = outsideFeatureObjects(literalMasked);
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
