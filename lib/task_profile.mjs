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
  ["deploy", /\bdeploy(?:s|ed|ing|ment|ments)?\b/iu],
  ["release", /\breleas(?:e|es|ed|ing)\b/iu],
  ["publish", /\bpublish(?:es|ed|ing)?\b|\bpublication\b/iu],
  ["push", /\bpush(?:es|ed|ing)?\b/iu],
  ["commit", /\bcommit(?:s|ted|ting)?\b/iu],
  ["branch", /\bbranch(?:es)?\b/iu],
  ["approval", /\bapprov(?:e|es|ed|ing|al|als)\b|\bsign[\s-]?off\b/iu],
  ["review", /\breview(?:s|ed|ing|er|ers)?\b/iu],
  ["wait", /\bwait(?:s|ed|ing)?\b|\bhold\s+(?:off|it|this|the)\b/iu],
  ["local", /\blocal-only\b|\bkeep\s+(?:it|this|that|the\s+changes?|changes)\s+local\b|\bpatch\s+only\b|\bdiff\s+only\b|\bdo\s+not\s+push\b|\bdon['’]t\s+push\b|\bun(?:committed|pushed|published|merged|deployed|released|submitted)\b/iu],
];
const ESCALATING = new Set(["merge", "deploy", "release", "approval", "wait", "local"]);
const CONTROLS = /\b(?:do\s+not|don['’]t|never|not|no|without|avoid|refrain|forbid(?:den|s)?|prohibit(?:ed|s)?|only\s+after|only\s+once|until|unless|instead\s+of|skip|cannot|can['’]t|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|won['’]t|will\s+not|is\s+(?:not\s+)?(?:required|mandatory|optional)|required|mandatory)\b/giu;

// Text that ends with a control phrase, optionally followed by an introductory
// colon, comma or dash: whatever comes next is the target of that control.
const CONTROL_TAIL = new RegExp(`${CONTROLS.source}[\\s:,\\-–—]*$`, "iu");
const SENTENCE_BREAK = /[;.!?]+/;

// Literal examples do not instruct. Paired quotes and code spans are masked;
// unmatched openers stay visible so a quote cannot hide an instruction. A span
// inside a statement that a control phrase already governs (`Do not ever
// "open a pull request"`) is emphasis on the control's target, not an example,
// and stays visible; over-reading such a span only costs a clarification.
const CONTROL_IN_STATEMENT = new RegExp(CONTROLS.source, "iu");
const LITERAL_SPAN = /`[^`\n]*`|"[^"\n]*"|[“][^”\n]*[”]/gu;
export function maskLiterals(text) {
  // Judge each span against the prefix as already masked, so a control word
  // inside an earlier example cannot unmask a later one.
  const whole = String(text);
  let out = "", last = 0;
  for (const match of whole.matchAll(LITERAL_SPAN)) {
    out += whole.slice(last, match.index);
    out += CONTROL_IN_STATEMENT.test(out.split(SENTENCE_BREAK).at(-1)) ? match[0] : " ".repeat(match[0].length);
    last = match.index + match[0].length;
  }
  return out + whole.slice(last);
}

// Control words bind within a statement. Only sentence and clause punctuation
// ends one; conjunctions do not, so "do not push and open a PR" keeps both
// terms under the control, and a colon that introduces a control's target
// ("Do not: open a pull request") does not end the statement either.
export function statements(text) {
  const out = [];
  for (const sentence of String(text).split(SENTENCE_BREAK)) {
    let current = null;
    for (const piece of sentence.split(":")) {
      if (current !== null && CONTROL_TAIL.test(current)) current += ":" + piece;
      else { if (current !== null) out.push(current); current = piece; }
    }
    if (current !== null) out.push(current);
  }
  return out;
}
export function deliveryScreen(text) {
  const visible = maskLiterals(typeof text === "string" ? text : "");
  const terms = TERMS.filter(([, pattern]) => pattern.test(visible)).map(([term]) => term);
  if (!terms.length) return { terms: [], controlled: [], controls: [], tier: "none" };
  const controls = [...new Set([...visible.matchAll(CONTROLS)].map(match => match[0].toLowerCase().replace(/\s+/g, " ")))];
  // A term is controlled when it shares a statement with a control word.
  const controlled = new Set();
  for (const statement of statements(visible)) {
    if (!new RegExp(CONTROLS.source, "iu").test(statement)) continue;
    for (const [term, pattern] of TERMS) if (pattern.test(statement)) controlled.add(term);
  }
  const tier = terms.some(term => ESCALATING.has(term)) || controls.length ? "question" : "assumption";
  return { terms, controlled: terms.filter(term => controlled.has(term)), controls, tier };
}

// A planner may annotate a clause with a typed delivery reading. The reading is
// checked against the owner's profile; it is evidence for a question, never a
// grant. Shapes outside this set are malformed output.
// `restrict` reads a clause that only forbids the listed effects; `local_only`
// reads a clause that forbids every external action.
const TAG_ACTIONS = new Set(["pull_request", "merge", "deploy", "release", "publish", "restrict", "local_only", "wait_for_approval"]);
const TAG_EFFECTS = new Set(["branch", "commit", "push", "pull_request", "merge", "deploy", "release", "publish"]);
export function validateDeliveryTag(tag) {
  if (!tag || typeof tag !== "object" || Array.isArray(tag)) throw new Error("delivery tag must be an object with action and optional prohibits/completion");
  const extra = Object.keys(tag).filter(key => !["action", "prohibits", "completion"].includes(key));
  if (extra.length) throw new Error(`delivery tag has unsupported keys: ${extra.join(", ")}`);
  if (!TAG_ACTIONS.has(tag.action)) throw new Error(`delivery tag action must be one of ${[...TAG_ACTIONS].join(", ")}`);
  if (tag.action === "restrict" && !Array.isArray(tag.prohibits)) throw new Error("a restrict delivery tag must list the prohibited effects");
  if (tag.prohibits !== undefined && (!Array.isArray(tag.prohibits) || tag.prohibits.length > 8 || tag.prohibits.some(effect => !TAG_EFFECTS.has(effect)) || new Set(tag.prohibits).size !== tag.prohibits.length)) throw new Error(`delivery tag prohibits must list distinct effects from ${[...TAG_EFFECTS].join(", ")}`);
  if (tag.completion !== undefined && !COMPLETION_CONDITIONS.includes(tag.completion)) throw new Error(`delivery tag completion must be one of ${COMPLETION_CONDITIONS.join(", ")}`);
  return { action: tag.action, ...(tag.prohibits ? { prohibits: [...tag.prohibits] } : {}), ...(tag.completion ? { completion: tag.completion } : {}) };
}

// The screened terms a planner tag speaks for. A tag that names one action
// cannot vouch for another action the same clause mentions.
const ACTION_TERMS = { pull_request: ["pull_request"], merge: ["merge"], deploy: ["deploy"], release: ["release"], publish: ["publish"], local_only: ["local"], wait_for_approval: ["wait", "approval", "review"], restrict: [] };
const EFFECT_TERMS = new Set(["branch", "commit", "push", "pull_request", "merge", "deploy", "release", "publish"]);
export function tagTerms(tag) {
  return { requested: new Set(ACTION_TERMS[tag.action] || []), prohibited: new Set(tag.prohibits || []) };
}
// Screened terms the tag leaves unaccounted for. A term under a control word
// ("do not open a PR") is spoken for only by a prohibition; a term without one
// ("merge the PR") only by the requested action. Every escalating term must be
// accounted for, and every effect term that sits under a control word.
export function unaccountedTerms(screen, tag) {
  const { requested, prohibited } = tagTerms(tag);
  const controlled = new Set(screen.controlled || []);
  return screen.terms.filter(term => {
    const required = ESCALATING.has(term) || (controlled.has(term) && EFFECT_TERMS.has(term));
    const spoken = controlled.has(term) ? prohibited.has(term) : requested.has(term);
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
  return { covered: true, reason: null };
}

export const deliveryQuestionId = requirementId => `${DELIVERY_QUESTION_PREFIX}${requirementId}`;
export const isDeliveryQuestion = id => typeof id === "string" && id.startsWith(DELIVERY_QUESTION_PREFIX);
// Question text depends only on the immutable clause and the owner's profile,
// so repeated planner turns reproduce it exactly and resumption can match it.
export function deliveryQuestion(profile, requirement) {
  return { id: deliveryQuestionId(requirement.id), requirements: [requirement.id],
    text: `Clause ${requirement.id} reads as a delivery instruction. The selected delivery profile is ${describeProfile(profile)} and a request cannot change it. State the implementation scope this clause keeps under that profile, or prepare a new task with a different typed profile.` };
}

export function profileAssumption(profile, requirement, screen) {
  return `Clause ${requirement.id} mentions ${screen.terms.map(term => term.replace("_", " ")).join(", ")}; it is treated as product behaviour. The typed delivery profile ${describeProfile(profile)} governs every external action and is not changed by this clause.`;
}

// The review projection for a saved task. Legacy tasks without a typed profile
// keep their original interpretation and are labelled instead of upgraded.
export function profileView(task) {
  if (!task?.deliveryProfile) {
    const condition = task?.completion?.target || null;
    return { legacy: true, version: null, action: task?.ownerDelivery ? "pull_request" : null, target: null, completion: condition ? { condition } : null, supported: true, source: task?.ownerDelivery ? "owner-delivery-contract" : task?.completion ? "completion-target" : "workflow-default", label: "Historical task; its original interpretation is retained" };
  }
  try {
    const profile = validateDeliveryProfile(task.deliveryProfile);
    const descriptor = actionFor(profile.action);
    return { ...profile, legacy: false, supported: true, source: "typed-profile", label: descriptor.label, mergeAuthorized: false, deployAuthorized: false };
  } catch (error) {
    return { legacy: false, version: task.deliveryProfile?.version ?? null, action: null, target: null, completion: null, supported: false, source: "typed-profile", error: { code: error.code, message: error.message } };
  }
}
