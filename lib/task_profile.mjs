// Typed delivery profiles for natural-language intake. Portable: no Node
// imports, no configuration reads, no provider calls. Agent Passport vendors
// this exact file; `templates/plugin/task-intake-contract.json` pins its bytes.
//
// A profile is the only source of delivery authority for a new task. Request
// text and model output can describe implementation and can raise clarification
// questions, but neither can add, widen or remove an external action.
//
// This module is self-contained: no imports, so the vendored copy loads alone
// and its pinned hash covers every rule it applies. The completion conditions
// below must match task_completion.mjs; a test asserts that agreement.

export const PROFILE_VERSION = 1;
export const DELIVERY_PROFILE_SECTION = "Delivery profile";
export const DELIVERY_QUESTION_PREFIX = "q-delivery-";
export const COMPLETION_CONDITIONS = Object.freeze(["delivery_ready", "integrated"]);

const profileError = (code, message) => Object.assign(new Error(message), { code, version: PROFILE_VERSION });

// Every action Gallivant can name. Only `pull_request` has a supported adapter
// in this release; merge and deployment are recognised so a request for them
// fails closed with a remedy instead of being read as a product feature.
export const DELIVERY_ACTIONS = Object.freeze([
  Object.freeze({ id: "pull_request", label: "Open one review pull request", supported: true, adapter: "github-pull-request",
    effects: Object.freeze(["branch", "commit", "push", "pull_request"]),
    description: "Implement on a task branch and open exactly one pull request for human review. Grants no merge, release or deployment authority." }),
  Object.freeze({ id: "merge", label: "Merge the pull request", supported: false, adapter: null, effects: Object.freeze(["merge"]),
    requires: "an explicit supported merge control and authorization; this release has none, so merges stay with the repository's own controls" }),
  Object.freeze({ id: "deploy", label: "Deploy the change", supported: false, adapter: null, effects: Object.freeze(["deploy"]),
    requires: "an explicit supported deployment control and authorization; this release has none" }),
]);
export const DELIVERY_PROFILE_SCHEMA = Object.freeze({ type: "object", properties: {
  action: { type: "string", enum: DELIVERY_ACTIONS.map(action => action.id) },
  completion: { type: "string", enum: COMPLETION_CONDITIONS },
}, required: ["action"], additionalProperties: false });
export const DELIVERY_CAPABILITIES = Object.freeze({ version: PROFILE_VERSION, defaultAction: "pull_request", defaultCompletion: "delivery_ready",
  actions: DELIVERY_ACTIONS.map(({ id, label, supported, adapter, description, requires }) => ({ id, label, supported, adapter, ...(description ? { description } : {}), ...(requires ? { requires } : {}) })),
  completions: COMPLETION_CONDITIONS, selectedBy: "owner", expandableBy: [] });

const actionFor = id => DELIVERY_ACTIONS.find(action => action.id === id) || null;
const supportedActions = DELIVERY_ACTIONS.filter(action => action.supported).map(action => action.id);

// Build a new task's profile from typed owner input. The legacy `completion`
// selection remains accepted; it must agree with any explicit profile value.
export function deliveryProfile(input, { completion, repository, base } = {}) {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw profileError("TASK_INPUT", "delivery must be an object selecting a typed action and optional completion condition");
  const extra = input ? Object.keys(input).filter(key => !["action", "completion"].includes(key)) : [];
  if (extra.length) throw profileError("TASK_INPUT", `delivery has unsupported keys: ${extra.join(", ")}; only action and completion are typed profile inputs`);
  const action = input?.action === undefined ? "pull_request" : input.action;
  const descriptor = actionFor(action);
  if (!descriptor) throw profileError("TASK_INPUT", `delivery action ${JSON.stringify(action)} is unknown; supported actions: ${supportedActions.join(", ")}`);
  if (!descriptor.supported) throw profileError("TASK_INPUT", `delivery action ${action} requires ${descriptor.requires}; select ${supportedActions.join(" or ")} and perform ${action} through the repository's own authorized controls`);
  if (input?.completion !== undefined && !COMPLETION_CONDITIONS.includes(input.completion)) throw profileError("TASK_INPUT", `delivery completion must be one of ${COMPLETION_CONDITIONS.join(", ")}`);
  if (completion !== undefined && input?.completion !== undefined && completion !== input.completion) throw profileError("TASK_INPUT", "delivery.completion and the completion target disagree; select one condition");
  const condition = input?.completion ?? completion ?? "delivery_ready";
  if (!COMPLETION_CONDITIONS.includes(condition)) throw profileError("TASK_INPUT", `completion condition must be one of ${COMPLETION_CONDITIONS.join(", ")}`);
  if (typeof repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw profileError("TASK_INPUT", "delivery target requires a resolved owner/name repository");
  if (typeof base !== "string" || !base.trim() || /[\s\0]/.test(base)) throw profileError("TASK_INPUT", "delivery target requires a resolved base branch");
  return { version: PROFILE_VERSION, action, target: { kind: descriptor.adapter, repository: repository.toLowerCase(), base }, completion: { condition } };
}

// Saved profiles are validated on every read that can lead to an effect. An
// unknown version fails closed with a recovery path; it never degrades to the
// legacy free-text contract.
export function validateDeliveryProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw profileError("TASK_PROFILE_UNSUPPORTED", "the saved delivery profile is missing or malformed; inspect the task read-only and prepare a new task with a typed profile");
  if (value.version !== PROFILE_VERSION) throw profileError("TASK_PROFILE_UNSUPPORTED", `delivery profile version ${JSON.stringify(value.version)} is not supported by this package (supported: ${PROFILE_VERSION}); inspect or export the task read-only, then prepare a new task; this record does not pin the namespace`);
  const descriptor = actionFor(value.action);
  if (!descriptor || !descriptor.supported) throw profileError("TASK_PROFILE_UNSUPPORTED", `delivery action ${JSON.stringify(value.action)} is not supported; prepare a new task with ${supportedActions.join(" or ")}`);
  const target = value.target;
  if (!target || typeof target !== "object" || target.kind !== descriptor.adapter || typeof target.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(target.repository) || typeof target.base !== "string" || !target.base.trim()) throw profileError("TASK_PROFILE_UNSUPPORTED", "the saved delivery target is malformed; prepare a new task with a resolved repository and base");
  if (!value.completion || typeof value.completion !== "object" || !COMPLETION_CONDITIONS.includes(value.completion.condition)) throw profileError("TASK_PROFILE_UNSUPPORTED", "the saved completion condition is not supported; prepare a new task");
  const keys = Object.keys(value).sort().join(","), targetKeys = Object.keys(target).sort().join(","), completionKeys = Object.keys(value.completion).join(",");
  if (keys !== "action,completion,target,version" || targetKeys !== "base,kind,repository" || completionKeys !== "condition") throw profileError("TASK_PROFILE_UNSUPPORTED", "the saved delivery profile has unsupported fields; prepare a new task");
  return { version: value.version, action: value.action, target: { kind: target.kind, repository: target.repository, base: target.base }, completion: { condition: value.completion.condition } };
}

// Records created since typed profiles exist carry a planner route, a
// repository snapshot or a pinned model route. One of those without a saved
// profile is damaged typed state, not a historical task: it fails closed like
// an unsupported version instead of inheriting legacy free-text semantics.
export const typedEraTask = task => Boolean(task) && (task.route !== undefined || task.repositoryContext !== undefined || (task.modelRoute !== undefined && task.modelRoute !== null));
export function savedProfile(task) {
  if (task?.deliveryProfile) return validateDeliveryProfile(task.deliveryProfile);
  if (typedEraTask(task)) throw profileError("TASK_PROFILE_UNSUPPORTED", "the task was created with a typed delivery profile but none is saved; inspect or export the task read-only, then prepare a new task; this record does not pin the namespace");
  return null;
}

// Canonical JSON for hashing and for the brief's typed section.
export const stableProfile = value => {
  const profile = validateDeliveryProfile(value);
  return JSON.stringify({ version: profile.version, action: profile.action, target: { kind: profile.target.kind, repository: profile.target.repository, base: profile.target.base }, completion: { condition: profile.completion.condition } });
};

export function deliveryProfileFromPrd(prd) {
  const section = prd?.sections?.[DELIVERY_PROFILE_SECTION];
  if (section === undefined) return null;
  if ((String(prd.body || "").match(/^## Delivery profile\s*$/gm) || []).length !== 1) throw profileError("TASK_PROFILE_UNSUPPORTED", "the delivery profile must have exactly one section");
  const match = section.trim().match(/^```json\r?\n([\s\S]+)\r?\n```$/);
  if (!match) throw profileError("TASK_PROFILE_UNSUPPORTED", "the delivery profile must be one complete JSON block");
  let value; try { value = JSON.parse(match[1]); } catch { throw profileError("TASK_PROFILE_UNSUPPORTED", "the delivery profile is invalid JSON"); }
  const profile = validateDeliveryProfile(value);
  if (stableProfile(profile) !== JSON.stringify(value)) throw profileError("TASK_PROFILE_UNSUPPORTED", "the delivery profile block is not in canonical form; regenerate the brief");
  return profile;
}

export const describeProfile = profile => `${profile.action} (${profile.completion.condition})`;

// ---- Deterministic delivery screen -----------------------------------------
//
// This is not a grammar and grants nothing. It finds delivery vocabulary in an
// immutable clause so the owner sees it in review. A hit can add a visible
// assumption or a clarification question; it can never add an external action.
const TERMS = [
  ["pull_request", /\bpull[\s-]+requests?\b|\bprs?\b/iu],
  ["merge", /\bmerg(?:e|es|ed|ing)\b/iu],
  // Shipping, rollout, go-live, cut-over and promotion wording, and any
  // "to production" destination, are deployment instructions too.
  ["deploy", /\bdeploy(?:s|ed|ing|ment|ments)?\b|\brollouts?\b|\broll(?:s|ed|ing)?[\s-]+(?:(?:it|this|that|them|the\s+\w+)\s+)?out\b|\bgo(?:es|ing)?[\s-]+live\b|\bcut[\s-]*over\b|\bship(?:s|ped|ping)?\s+(?:it|this|that|them|the\s+\w+)\b|\bpromot(?:e|es|ed|ing)\s+\S+(?:\s+\S+)?\s+to\s+(?:production|prod|staging|live)\b|\b(?:to|into)\s+(?:production|prod)\b/iu],
  ["release", /\breleas(?:e|es|ed|ing)\b/iu],
  // Submitting, uploading or pushing a package or build to a registry or
  // store, and registry tool commands, are publication wording too.
  ["publish", /\bpublish(?:es|ed|ing)?\b|\bpublication\b|\b(?:submit|upload|post|send|put|push|release)(?:s|ted|ed|ting|ing)?\s+(?:\S+\s+){0,4}?(?:to|onto|on|into)\s+(?:the\s+|a\s+|our\s+)?(?:npm|npmjs|pypi|rubygems|crates\.io|crates|maven(?:\s+central)?|nuget|packagist|docker\s+hub|homebrew|hex\.pm|cocoapods|(?:package\s+|artifact\s+|container\s+|image\s+)?registry|(?:app|play|chrome\s+web|extension|snap)\s+store|marketplace|testflight)\b|\b(?:gem|nuget|helm|docker|oras)\s+push\b|\btwine\s+upload\b/iu],
  ["push", /\bpush(?:es|ed|ing)?\b/iu],
  // A write aimed at the base branch itself, or at skipping the task branch
  // and pull request, is a delivery the profile never performs.
  // An explicitly direct or straight write names any branch ("push directly to
  // staging"); the selected base itself is matched by name through the
  // screen's base option, since a profile's base is arbitrary.
  ["direct_push", /\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly\s+|straight\s+)?(?:to|into|on|onto)\s+(?:the\s+)?(?:main|master|trunk|develop(?:ment)?|base(?:\s+branch)?|default\s+branch|release\s+branch|production\s+branch)\b|\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly|straight)\s+(?:to|into|on|onto)\s+(?:the\s+)?[\p{L}\p{N}_./-]+|\bdirectly\s+(?:to|into|on|onto)\s+(?:the\s+)?(?:main|master|trunk|develop|base(?:\s+branch)?|default\s+branch|[\p{L}\p{N}_./-]+\s+branch)\b|\bwithout\s+(?:a\s+|any\s+)?(?:pull\s+request|pr|task\s+branch|feature\s+branch|branch)\b/iu],
  ["commit", /\bcommit(?:s|ted|ting)?\b/iu],
  ["branch", /\bbranch(?:es)?\b/iu],
  ["approval", /\bapprov(?:e|es|ed|ing|al|als)\b|\bsign[\s-]?off\b/iu],
  ["review", /\breview(?:s|ed|ing|er|ers)?\b/iu],
  ["wait", /\bwait(?:s|ed|ing)?\b|\bhold\s+(?:off|it|this|the)\b/iu],
  ["local", /\blocal-only\b|\bkeep\s+(?:it|this|that|the\s+changes?|changes)\s+local\b|\bpatch\s+only\b|\bdiff\s+only\b|\bdo\s+not\s+push\b|\bdon['’]t\s+push\b|\bun(?:committed|staged|pushed|published|merged|deployed|released|submitted)\b|\b(?:in|within)\s+(?:the\s+|my\s+|your\s+)?(?:working\s+(?:tree|copy|directory)|worktree|checkout)\s+only\b|\b(?:keep|leave)\s+(?:\S+\s+){0,4}?(?:in|within)\s+(?:the\s+|my\s+|your\s+)?(?:working\s+(?:tree|copy|directory)|worktree|checkout)\b|\bworking[\s-]tree[\s-]only\b|\bdo\s+not\s+(?:stage|commit)\b|\bdon['’]t\s+(?:stage|commit)\b/iu],
];
// The selected base is matched by name: with base "staging", "push the
// changes to staging" or "land it on the staging branch" is a direct write to
// the base. The name is matched whole, so "staging2" is not "staging".
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const baseWritePattern = base => {
  if (typeof base !== "string" || !base.trim()) return null;
  const name = escapeRegExp(base.trim());
  return new RegExp(String.raw`\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly\s+|straight\s+)?(?:to|into|on|onto)\s+(?:the\s+)?${name}(?:\s+branch)?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])|\bdirectly\s+(?:to|into|on|onto)\s+(?:the\s+)?${name}(?:\s+branch)?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])`, "iu");
};
const termMatches = (term, pattern, text, baseWrite) => pattern.test(text) || (term === "direct_push" && baseWrite !== null && baseWrite.test(text)) || (term === "local" && stopAfterCommit(text));
// Publication and approval escalate per statement (see publishInstruction and
// approvalInstruction) so product nouns such as "a publish button" or "an
// approval workflow" stay assumptions.
const ESCALATING = new Set(["merge", "deploy", "release", "wait", "local", "direct_push"]);
// A bare "publish" verb anywhere in a statement is an instruction to publish
// ("and publish the package to npm", "could you publish it") unless it is a
// noun modifier ("a publish button") or the infinitive of a feature phrase
// ("a command to publish docs"). Inflected descriptive forms ("the button
// publishes", "published articles") describe product behaviour. A bare
// submission verb aimed at a registry or store ("submit the package to npm",
// "upload the build to the App Store") and a registry tool command ("gem
// push", "twine upload") are publication instructions under the same rules.
const PUBLISH_MODIFIER_HEAD = /\b(?:a|an|the|this|that|our|its|new|auto|manual|one-click)\s*$/iu;
const PUBLISH_FEATURE_INFINITIVE = /\b(?:command|button|option|ability|way|tool|script|action|feature|endpoint|page|link|menu|job|task|method|function|flag|setting|permission|right|role|form|screen|dialog|modal|workflow|service|handler|hook|api|ui|cli)s?\s+to\s*$/iu;
// A terminal stop after a Git commit withholds the push and review PR that the
// selected profile requires. Read both clause orders, within statement bounds;
// feature infinitives and database transactions retain their product meaning.
const STOP_AFTER_COMMIT = /\b(?:stop|pause|halt)\s+(?:right\s+|immediately\s+)?(?:after|once|when)\s+(?:[^\s;.!?]+\s+){0,6}?commit(?:ted|ting)?\b|\b(?:after|once|when)\s+(?:[^\s;.!?]+\s+){0,6}?commit(?:ted|ting)?\b(?:\s+[^\s;.!?,]+){0,6}\s*,?\s*(?:stop|pause|halt)\b/giu;
function stopAfterCommit(text) {
  for (const statement of statements(text)) for (const match of statement.matchAll(STOP_AFTER_COMMIT)) {
    const prefix = statement.slice(0, match.index);
    if (PUBLISH_FEATURE_INFINITIVE.test(prefix) && !/\b(?:task|job)s?\s+to\s*$/iu.test(prefix)) continue;
    const commit = match[0].match(/\bcommit(?:ted|ting)?\b/iu);
    const object = statement.slice(match.index + commit.index + commit[0].length);
    if (/^\s+(?:(?:the|a|this|that|our)\s+)?(?:database\s+|sql\s+)?transaction\b/iu.test(object)) continue;
    return true;
  }
  return false;
}
const PUBLISH_MODIFIER_TAIL = /^\s*(?:button|command|action|feature|flag|option|toggle|status|state|date|time|event|events|endpoint|api|page|menu|dialog|workflow|pipeline|step|hook|permission|job|tab|screen|form)\b/iu;
const PUBLISH_VERBS = /\bpublish\b|\b(?:submit|upload|post|send|put|push|release)\s+(?:\S+\s+){0,4}?(?:to|onto|on|into)\s+(?:the\s+|a\s+|our\s+)?(?:npm|npmjs|pypi|rubygems|crates\.io|crates|maven(?:\s+central)?|nuget|packagist|docker\s+hub|homebrew|hex\.pm|cocoapods|(?:package\s+|artifact\s+|container\s+|image\s+)?registry|(?:app|play|chrome\s+web|extension|snap)\s+store|marketplace|testflight)\b|\b(?:gem|nuget|helm|docker|oras)\s+push\b|\btwine\s+upload\b/giu;
function publishInstruction(statement) {
  for (const match of statement.matchAll(PUBLISH_VERBS)) {
    const before = statement.slice(0, match.index), after = statement.slice(match.index + match[0].length);
    if (PUBLISH_MODIFIER_HEAD.test(before) || PUBLISH_FEATURE_INFINITIVE.test(before) || PUBLISH_MODIFIER_TAIL.test(after)) continue;
    return true;
  }
  return false;
}
// Approval wording is an instruction to wait for someone's decision ("wait
// for my approval", "get sign-off before opening a PR", "once approved")
// unless it names product behaviour: an approval noun followed by a feature
// noun ("an approval workflow", "the approval status column"), an approval
// verb as a feature infinitive ("a button to approve comments") or "approved"
// as an adjective on a product noun ("list approved expenses").
const APPROVAL_WORDS = /\bapprov(?:e|es|ed|ing|al|als)\b|\bsign[\s-]?off\b/giu;
const APPROVAL_FEATURE_TAIL = /^\s*(?:workflow|workflows|flow|flows|process|processes|step|steps|stage|stages|status|statuses|state|states|button|buttons|screen|screens|page|pages|form|forms|dialog|modal|queue|queues|request|requests|rule|rules|policy|policies|chain|chains|matrix|gate|gates|history|log|logs|email|emails|notification|notifications|badge|badges|column|columns|field|fields|table|tables|model|models|endpoint|endpoints|api|ui|feature|features|logic|level|levels|limit|limits|threshold|thresholds|role|roles|permission|permissions|type|types|record|records|comment|comments|action|actions|checkbox|toggle|setting|settings|icon|icons|list|lists|view|views|tab|tabs|timestamp|timestamps|date|dates|count|counts|rate|rates|flag|flags|event|events|hook|hooks|routing|system|module|service|handler|controller|component|widget|panel|dashboard|report|reports|requirement|requirements|mechanism|pipeline|tracking|audit|reminder|reminders|deadline|deadlines|sla|engine|manager|managers|reviewer|reviewers|approver|approvers|chain|template|templates|message|messages|reason|reasons|note|notes|metadata|data|entity|entities|object|objects|flow)\b/iu;
const APPROVAL_PRODUCT_NOUN = /^\s*(?:expenses?|invoices?|requests?|claims?|orders?|refunds?|applications?|documents?|comments?|posts?|articles?|submissions?|items?|records?|users?|accounts?|vendors?|suppliers?|timesheets?|budgets?|purchases?|leave|transactions?|payments?|listings?|reviews?|entries|entry|drafts?|changes?\s+list|content|uploads?|images?|products?|templates?|designs?|proposals?)\b/iu;
function approvalInstruction(statement) {
  for (const match of statement.matchAll(APPROVAL_WORDS)) {
    const word = match[0].toLowerCase(), before = statement.slice(0, match.index), after = statement.slice(match.index + match[0].length);
    if (/^approvals?$/u.test(word) && APPROVAL_FEATURE_TAIL.test(after)) continue;
    if (word === "approved" && APPROVAL_PRODUCT_NOUN.test(after)) continue;
    if (PUBLISH_FEATURE_INFINITIVE.test(before)) continue;
    return true;
  }
  return false;
}
const CONTROLS = /\b(?:do\s+not|don['’]t|never|not|no|without|avoid|refrain|forbid(?:den|s)?|prohibit(?:ed|s)?|only\s+after|only\s+once|until|unless|instead\s+of|skip|cannot|can['’]t|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|won['’]t|will\s+not|is\s+(?:not\s+)?(?:required|mandatory|optional)|required|mandatory|out\s+of\s+scope|outside\s+(?:of\s+)?(?:the\s+|this\s+|our\s+)?scope|exclud(?:e|es|ed|ing)|except(?:\s+for)?|other\s+than|apart\s+from|aside\s+from|but\s+not|minus|leave\s+out|leaving\s+out|(?:I|we)(?:['’]ll|\s+will|\s+shall|\s+plan\s+to|\s+intend\s+to|\s+would\s+(?:rather|prefer\s+to))\s+(?:\w+\s+){0,2}?(?:open|create|raise|submit|make|file|merge|deploy|release|publish|push|ship|handle|take\s+care\s+of|do)|let\s+(?:me|us)\s+(?:\w+\s+){0,2}?(?:open|create|raise|submit|make|file|merge|deploy|release|publish|push|ship|handle|take\s+care\s+of|do|review|approve|sign\s+off|decide)|myself|ourselves|leave\s+(?:\S+\s+){0,4}?to\s+(?:me|us)|is\s+(?:mine|ours)\s+to|on\s+my\s+own|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|disallow(?:ed|s)?|not\s+permitted|unauthori[sz]ed|off[\s-]limits|stop(?:s|ped|ping)?\s+(?:short\s+of|before|at|prior\s+to|right\s+before|just\s+before)|paus(?:e|es|ed|ing)\s+(?:before|at|prior\s+to)|halt(?:s|ed|ing)?\s+(?:before|at|prior\s+to)|short\s+of)\b/giu;

// Text that ends with a control phrase, optionally followed by an introductory
// colon, comma or dash: whatever comes next is the target of that control.
const CONTROL_TAIL = new RegExp(`${CONTROLS.source}[\\s:,\\-–—]*$`, "iu");
// Affirmative controls state a requirement rather than a prohibition. A
// negated form ("is not required") keeps its "not" and reads as negative.
const AFFIRMATIVE_CONTROLS = /\b(?:(?:is|are|be|remains?|stays?)\s+(?:required|mandatory|compulsory|optional)|required|mandatory|compulsory)\b/giu;
// Dots inside registry, repository and branch names are not sentence ends.
// Contrast starts a new control scope; conjunctions such as "and" retain it.
const SENTENCE_BREAK = /[;!?]+|\.(?![\p{L}\p{N}_/-])|\b(?:but|however|yet|nevertheless)\b/iu;

// Literal examples do not instruct. Paired quotes and code spans are masked;
// unmatched openers stay visible so a quote cannot hide an instruction. A span
// inside a statement that a control phrase already governs (`Do not ever
// "open a pull request"`) is emphasis on the control's target, not an example,
// and stays visible; over-reading such a span only costs a clarification.
const CONTROL_IN_STATEMENT = new RegExp(CONTROLS.source, "iu");
const LITERAL_SPAN = /`[^`\n]*`|"[^"\n]*"|[“][^”\n]*[”]/gu;
export function maskLiterals(text) {
  // Judge each span against its whole statement (before and after it) with
  // every span blanked, so a control word inside an example never counts and
  // a trailing control ("... is forbidden") still governs the span before it.
  const whole = String(text);
  const spans = [...whole.matchAll(LITERAL_SPAN)];
  if (!spans.length) return whole;
  const blank = spans.reduce((acc, m) => acc.slice(0, m.index) + " ".repeat(m[0].length) + acc.slice(m.index + m[0].length), whole);
  const breaks = [...blank.matchAll(new RegExp(SENTENCE_BREAK.source, "giu"))];
  const statementAt = index => {
    const before = breaks.findLast(m => m.index < index), after = breaks.find(m => m.index >= index);
    const start = before ? before.index + before[0].length : 0, end = after?.index ?? blank.length;
    return blank.slice(start, end);
  };
  let out = "", last = 0;
  for (const m of spans) {
    out += whole.slice(last, m.index);
    out += CONTROL_IN_STATEMENT.test(statementAt(m.index)) ? m[0] : " ".repeat(m[0].length);
    last = m.index + m[0].length;
  }
  return out + whole.slice(last);
}

// Control words bind within a statement. Sentence/clause punctuation and
// contrast end one; additive conjunctions do not, so "do not push and open a PR" keeps both
// terms under the control, and a colon that introduces a control's target
// ("Do not: open a pull request") does not end the statement either.
export function statements(text) {
  const out = [];
  for (const sentence of String(text).split(SENTENCE_BREAK)) {
    let current = null;
    for (const piece of sentence.split(/:(?!\/\/)/u)) {
      if (current !== null && CONTROL_TAIL.test(current)) current += ":" + piece;
      else { if (current !== null) out.push(current); current = piece; }
    }
    if (current !== null) out.push(current);
  }
  return out;
}
// A review prohibited outright ("do not send this for review", "no code
// review", "reviews are forbidden") conflicts with pull-request delivery, which
// exists to request review, so it escalates and no tag can speak for it. A
// review named as a condition ("until someone has reviewed it", "do not merge
// until reviewed") or as optional ("a review is not required") does not. The
// nearest control word in the statement decides, a preceding one first.
const REVIEW_TERM = /\breview(?:s|ed|ing|er|ers)?\b/giu;
const NON_PROHIBITIVE_CONTROL = /^(?:until|unless|only after|only once|is (?:not )?(?:required|mandatory|optional))$/u;
function reviewProhibited(statement) {
  const controls = [...statement.matchAll(CONTROLS)].map(match => ({ index: match.index, text: match[0].toLowerCase().replace(/\s+/g, " ") }));
  if (!controls.length) return false;
  for (const match of statement.matchAll(REVIEW_TERM)) {
    const nearest = controls.filter(control => control.index < match.index).at(-1) || controls.find(control => control.index > match.index);
    if (nearest && !NON_PROHIBITIVE_CONTROL.test(nearest.text)) return true;
  }
  return false;
}

// Retain explicit PR destinations independently of the planner's action tag.
// These are comparisons with the selected target, never target selection.
// Ambiguous destinations ask rather than guessing which repository or branch
// the owner meant. Feature infinitives and quoted examples remain product text.
const PR_INSTRUCTION = /\b(?:open(?:ing)?|creat(?:e|ing)|rais(?:e|ing)|submit(?:ting)?|mak(?:e|ing)|fil(?:e|ing)|send(?:ing)?)\s+(?:\S+\s+){0,4}?(?:pull[\s-]+requests?|prs?)\b/giu;
const PR_BASE = /\b(?:against|into|to|in|on|targeting|targets?|(?:base|target)(?:\s+branch)?\s*(?:is|to|:))\s+(?:the\s+)?(?:branch\s+)?([^\s,;!?]+)/giu;
const PR_REPOSITORY = /\b(?:in|to|for|on)\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?(https?:\/\/[^\s,;!?]+|(?:github\.com\/)?[\w.-]+\/[\w.-]+)/giu;
function pullRequestTargetConflicts(statement, { base, repository }) {
  const instructions = [...statement.matchAll(PR_INSTRUCTION)].filter(m => !PUBLISH_FEATURE_INFINITIVE.test(statement.slice(0, m.index)));
  if (!instructions.length) return [];
  const conflicts = [];
  const repositories = [...statement.matchAll(PR_REPOSITORY)];
  for (const match of repositories) {
    const requested = match[1].replace(/^(?:https?:\/\/)?github\.com\//iu, "").replace(/\.git$/iu, "").toLowerCase();
    if (requested !== repository?.toLowerCase()) conflicts.push(`repository ${JSON.stringify(requested)} differs from selected repository ${JSON.stringify(repository ?? null)}`);
  }
  for (const match of statement.matchAll(PR_BASE)) {
    if (!instructions.some(m => match.index >= m.index + m[0].length) && statement.slice(0, match.index).trim()) continue;
    // A repository destination has already been checked as a repository.
    if (repositories.some(r => r.index === match.index)) continue;
    const requested = match[1];
    if (requested !== base) conflicts.push(`base ${JSON.stringify(requested)} differs from selected base ${JSON.stringify(base ?? null)}`);
  }
  if (/\b(?:in|to|for|on)\s+(?:another|a\s+different|the\s+other)\s+repo(?:sitory)?\b/iu.test(statement)) conflicts.push("the clause names a different repository");
  // A literal destination may have been masked. Its qualifier still requires
  // clarification instead of silently losing the requested target.
  if (/\b(?:against|into|targeting)\s*$/iu.test(statement)) conflicts.push("the requested PR target is not an unambiguous repository or base");
  return conflicts;
}
export function deliveryScreen(text, { base, repository } = {}) {
  const visible = maskLiterals(typeof text === "string" ? text : "");
  const baseWrite = baseWritePattern(base);
  const terms = TERMS.filter(([term, pattern]) => termMatches(term, pattern, visible, baseWrite)).map(([term]) => term);
  if (!terms.length) return { terms: [], controlled: [], affirmed: [], escalated: [], controls: [], tier: "none" };
  const controls = [...new Set([...visible.matchAll(CONTROLS)].map(match => match[0].toLowerCase().replace(/\s+/g, " ")))];
  // A term is controlled when it shares a statement with a control word. A
  // publication is escalated when the statement instructs one ("Publish this
  // package to npm", "Submit the package to npm"), not when it names product
  // behaviour ("Add a publish button"); the profile never publishes anywhere.
  // Approval is escalated when the statement waits on someone's decision, not
  // when it describes an approval feature ("Add an approval workflow").
  // Control polarity: a statement with any negative control ("do not",
  // "is not required", "except") puts its terms under a prohibition; one with
  // only affirmative controls ("is required", "mandatory") states a
  // requirement, which a requested-action tag can speak for.
  const controlled = new Set(), affirmed = new Set(), uncontrolled = new Set(), escalated = new Set(terms.filter(term => ESCALATING.has(term))), targetConflicts = [];
  for (const statement of statements(visible)) {
    targetConflicts.push(...pullRequestTargetConflicts(statement, { base, repository }));
    if (publishInstruction(statement)) escalated.add("publish");
    if (approvalInstruction(statement)) escalated.add("approval");
    const negative = new RegExp(CONTROLS.source, "iu").test(statement.replace(AFFIRMATIVE_CONTROLS, " "));
    const affirmative = !negative && AFFIRMATIVE_CONTROLS.test(statement);
    if (negative && reviewProhibited(statement)) escalated.add("review");
    for (const [term, pattern] of TERMS) if (termMatches(term, pattern, statement, baseWrite)) (negative ? controlled : affirmative ? affirmed : uncontrolled).add(term);
  }
  if (targetConflicts.length) { terms.push("pull_request_target"); escalated.add("pull_request_target"); }
  // Only a control that shares a statement with a delivery term asks; a
  // control elsewhere on the line ("Authentication is required.") does not.
  const tier = escalated.size || controlled.size || affirmed.size ? "question" : "assumption";
  return { terms, controlled: terms.filter(term => controlled.has(term)), affirmed: terms.filter(term => affirmed.has(term)), uncontrolled: terms.filter(term => uncontrolled.has(term)), escalated: terms.filter(term => escalated.has(term)), controls, tier, ...(targetConflicts.length ? { targetConflicts } : {}) };
}

// A planner may annotate a clause with a typed delivery reading. The reading is
// checked against the owner's profile; it is evidence for a question, never a
// grant. Shapes outside this set are malformed output.
// `restrict` reads a clause that only forbids the listed effects; `local_only`
// reads a clause that forbids every external action.
const TAG_ACTIONS = new Set(["pull_request", "merge", "deploy", "release", "publish", "restrict", "local_only", "wait_for_approval"]);
const TAG_EFFECTS = new Set(["branch", "commit", "push", "pull_request", "merge", "deploy", "release", "publish", "direct_push"]);
export function validateDeliveryTag(tag) {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) throw new Error("delivery tag must be an object with action and optional prohibits/completion/target");
  const extra = Object.keys(tag).filter(key => !["action", "prohibits", "completion", "target"].includes(key));
  if (extra.length) throw new Error(`delivery tag has unsupported keys: ${extra.join(", ")}`);
  if (!TAG_ACTIONS.has(tag.action)) throw new Error(`delivery tag action must be one of ${[...TAG_ACTIONS].join(", ")}`);
  if (tag.action === "restrict" && !Array.isArray(tag.prohibits)) throw new Error("a restrict delivery tag must list the prohibited effects");
  if (tag.prohibits !== undefined && (!Array.isArray(tag.prohibits) || tag.prohibits.length > 8 || tag.prohibits.some(effect => !TAG_EFFECTS.has(effect)) || new Set(tag.prohibits).size !== tag.prohibits.length)) throw new Error(`delivery tag prohibits must list distinct effects from ${[...TAG_EFFECTS].join(", ")}`);
  if (tag.completion !== undefined && !COMPLETION_CONDITIONS.includes(tag.completion)) throw new Error(`delivery tag completion must be one of ${COMPLETION_CONDITIONS.join(", ")}`);
  if (tag.target !== undefined) {
    const target = tag.target;
    if (!target || typeof target !== "object" || Array.isArray(target) || !Object.keys(target).length || Object.keys(target).some(key => !["repository", "base"].includes(key))) throw new Error("delivery tag target must name repository and/or base only");
    if (target.repository !== undefined && (typeof target.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(target.repository))) throw new Error("delivery tag target repository must be owner/name");
    if (target.base !== undefined && (typeof target.base !== "string" || !target.base.trim() || /[\s\0]/.test(target.base) || target.base.length > 255)) throw new Error("delivery tag target base must be a nonempty branch name under 256 characters");
  }
  return { action: tag.action, ...(tag.prohibits ? { prohibits: [...tag.prohibits] } : {}), ...(tag.completion ? { completion: tag.completion } : {}), ...(tag.target ? { target: { ...tag.target } } : {}) };
}

// The screened terms a planner tag speaks for. A tag that names one action
// cannot vouch for another action the same clause mentions.
const ACTION_TERMS = { pull_request: ["pull_request"], merge: ["merge"], deploy: ["deploy"], release: ["release"], publish: ["publish"], local_only: ["local"], wait_for_approval: ["wait", "approval", "review"], restrict: [] };
const EFFECT_TERMS = new Set(["branch", "commit", "push", "pull_request", "merge", "deploy", "release", "publish", "direct_push"]);
export function tagTerms(tag) {
  return { requested: new Set(ACTION_TERMS[tag.action] || []), prohibited: new Set(tag.prohibits || []) };
}
// A clarification reply must itself state its typed reading. An empty
// restriction or an invented action/prohibition cannot resolve an anaphoric
// "do it anyway" merely because the selected profile covers that tag.
export function deliveryReplyGrounded(screen, tag) {
  const { requested, prohibited } = tagTerms(tag);
  const explicitAction = [...requested].some(term => (screen.uncontrolled || []).includes(term) || (screen.affirmed || []).includes(term));
  const explicitRestrictions = prohibited.size > 0 && [...prohibited].every(term => (screen.controlled || []).includes(term));
  return tag.action === "restrict" ? explicitRestrictions : explicitAction && (prohibited.size === 0 || explicitRestrictions);
}
// Screened terms the tag leaves unaccounted for. A term under a control word
// ("do not open a PR") is spoken for only by a prohibition; a term without one
// ("merge the PR") only by the requested action. Every escalating term must be
// accounted for, and every effect term that sits under a control word.
export function unaccountedTerms(screen, tag) {
  const { requested, prohibited } = tagTerms(tag);
  const controlled = new Set(screen.controlled || []), affirmed = new Set(screen.affirmed || []), escalated = new Set([...(screen.escalated || []), ...screen.terms.filter(term => ESCALATING.has(term))]);
  return screen.terms.filter(term => {
    const required = escalated.has(term) || ((controlled.has(term) || affirmed.has(term)) && EFFECT_TERMS.has(term));
    const positive = affirmed.has(term) || (screen.uncontrolled || []).includes(term) || !controlled.has(term);
    const spoken = (!controlled.has(term) || prohibited.has(term)) && (!positive || requested.has(term));
    return required && !spoken;
  });
}

// Does the typed profile already do exactly what the clause reads as asking?
export function profileCovers(profile, tag) {
  const descriptor = actionFor(profile.action);
  if (!descriptor) return { covered: false, reason: "unsupported profile action" };
  if (tag.action !== profile.action && tag.action !== "restrict") return { covered: false, reason: `the clause reads as ${tag.action}; the profile performs ${profile.action}` };
  const conflicting = (tag.prohibits || []).filter(effect => descriptor.effects.includes(effect));
  if (conflicting.length) return { covered: false, reason: `the clause prohibits ${conflicting.join(", ")}, which ${profile.action} requires` };
  if (tag.completion && tag.completion !== profile.completion.condition) return { covered: false, reason: `the clause expects completion ${tag.completion}; the profile selects ${profile.completion.condition}` };
  if (tag.target?.repository !== undefined && tag.target.repository.toLowerCase() !== profile.target.repository.toLowerCase()) return { covered: false, reason: `the clause targets repository ${JSON.stringify(tag.target.repository)}; the profile selects ${JSON.stringify(profile.target.repository)}` };
  if (tag.target?.base !== undefined && tag.target.base !== profile.target.base) return { covered: false, reason: `the clause targets base ${JSON.stringify(tag.target.base)}; the profile selects ${JSON.stringify(profile.target.base)}` };
  return { covered: true, reason: null };
}

export const deliveryQuestionId = requirementId => `${DELIVERY_QUESTION_PREFIX}${requirementId}`;
export const isDeliveryQuestion = id => typeof id === "string" && id.startsWith(DELIVERY_QUESTION_PREFIX);
// Question text depends only on the immutable clause and the owner's profile,
// so repeated planner turns reproduce it exactly and resumption can match it.
export function deliveryQuestion(profile, requirement) {
  return { id: deliveryQuestionId(requirement.id), requirements: [requirement.id],
    text: `Clause ${requirement.id} reads as a delivery instruction. The selected delivery profile is ${describeProfile(profile)} targeting ${profile.target.repository} against ${profile.target.base} and a request cannot change it. Explicitly restate the supported delivery action or prohibited effects and the implementation scope this clause keeps, or prepare a new task with a different typed profile.` };
}

export function profileAssumption(profile, requirement, screen) {
  return `Clause ${requirement.id} mentions ${screen.terms.map(term => term.replace("_", " ")).join(", ")}; it is treated as product behaviour. The typed delivery profile ${describeProfile(profile)} governs every external action and is not changed by this clause.`;
}

// The review projection for a saved task. Legacy tasks without a typed profile
// keep their original interpretation and are labelled instead of upgraded.
// A saved profile is authority only for the task it was reviewed on: its target
// and completion must match the task's own repository, base and completion
// target exactly, so a profile copied or restored from another task fails closed.
export function assertProfileBound(profile, task) {
  const repository = typeof task?.repo === "string" ? task.repo.toLowerCase() : null;
  const mismatches = [];
  if (profile.target.repository !== repository) mismatches.push(`repository ${JSON.stringify(profile.target.repository)} is not the task's ${JSON.stringify(repository)}`);
  if (profile.target.base !== task?.base) mismatches.push(`base ${JSON.stringify(profile.target.base)} is not the task's ${JSON.stringify(task?.base ?? null)}`);
  if (profile.completion.condition !== task?.completion?.target) mismatches.push(`completion ${JSON.stringify(profile.completion.condition)} is not the task's ${JSON.stringify(task?.completion?.target ?? null)}`);
  if (mismatches.length) throw profileError("TASK_PROFILE_UNSUPPORTED", `the saved delivery profile is not bound to this task (${mismatches.join("; ")}); inspect the task read-only and prepare a new task`);
  return profile;
}

export function profileView(task) {
  if (!task?.deliveryProfile && !typedEraTask(task)) {
    const condition = task?.completion?.target || null;
    return { legacy: true, version: null, action: task?.ownerDelivery ? "pull_request" : null, target: null, completion: condition ? { condition } : null, supported: true, source: task?.ownerDelivery ? "owner-delivery-contract" : task?.completion ? "completion-target" : "workflow-default", label: "Historical task; its original interpretation is retained" };
  }
  try {
    const profile = assertProfileBound(savedProfile(task), task);
    const descriptor = actionFor(profile.action);
    return { ...profile, legacy: false, supported: true, source: "typed-profile", label: descriptor.label, mergeAuthorized: false, deployAuthorized: false };
  } catch (error) {
    return { legacy: false, version: task.deliveryProfile?.version ?? null, action: null, target: null, completion: null, supported: false, source: "typed-profile", error: { code: error.code, message: error.message } };
  }
}
