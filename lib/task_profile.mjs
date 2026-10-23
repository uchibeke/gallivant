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
// Missing pins mean the historical line-based source interpretation.
export const FRAGMENT_VERSION = 2;
export function sourceFragmentVersion(task) {
  const version = task.fragmentVersion === undefined ? 1 : task.fragmentVersion;
  if (version !== 1 && version !== FRAGMENT_VERSION) throw profileError("TASK_PROFILE_UNSUPPORTED", "unsupported source fragment version; inspect the saved request with a compatible package or prepare a new task from it");
  return version;
}
export function sourceFragments(text, { prefix = "r", source = prefix === "r" ? "original" : `answer:${prefix.replace(/^a-/, "")}`, version = FRAGMENT_VERSION } = {}) {
  sourceFragmentVersion({ fragmentVersion: version });
  const out = [];
  const add = (start, end) => {
    const value = text.slice(start, end), trimmed = value.trim();
    if (trimmed) { start += value.indexOf(trimmed); out.push({ id: `${prefix}-${out.length + 1}`, text: trimmed, source: { of: source, start, end: start + trimmed.length } }); }
  };
  if (version === 1) {
    let index = 0;
    for (const piece of text.split(/(\r?\n)/)) { if (!/^\r?\n$/.test(piece)) add(index, index + piece.length); index += piece.length; }
    return out;
  }
  // Delimit outside quoted literals/code only. Whitespace and punctuation keep
  // their original UTF-16 positions; nothing is normalized or discarded.
  const visible = text.replace(LITERAL_SPAN, span => " ".repeat(span.length));
  let start = 0;
  for (const match of visible.matchAll(/\r?\n|[.!?;](?=\s|$)/gu)) {
    if (match[0] === "." && (/[\s.]/u.test(text[match.index - 1] || " ") || /\b(?:e\.g|i\.e|mr|mrs|ms|dr|prof|vs|etc)\.$/iu.test(visible.slice(Math.max(start, match.index - 8), match.index + 1)))) continue;
    const end = match.index + match[0].length;
    add(start, end); start = end;
  }
  add(start, text.length);
  return out;
}
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
// Share the vocabulary between initial detection and per-statement gate
// checks; a covered PR tag cannot hide an owner decision expressed differently.
const APPROVAL_TERM = /\b(?:approv(?:e|es|ed|ing|al|als)\b|sign[\s-]?off\b|consent(?:s|ed|ing)?\b|authori[sz](?:e|es|ed|ing|ation|ations)\b|permissions?\b|confirmations?\b|(?:check(?:ing)?|confirm(?:ing)?|clear(?:ing)?)\s+with\s+(?:me|us)\b|(?:ask(?:ing)?|consult(?:ing)?)\s+(?:me|us)\b|(?:(?:get|obtain|seek|await)(?:\s+(?:my|our|your|their|the|a))?|my|our|your|their|the|a)\s+go[\s-]?ahead\b)/iu;
// Registry removals, administration and index changes have the same unsupported external
// effect as publication. Local dependency removal is not a registry mutation.
// Share registry destinations between term detection, escalation and removal
// checks. Hosts may carry a scheme, port or artifact path; they are destinations
// only when a mutation verb points at them, never grants of publication access.
const REGISTRY_HOST = String.raw`(?:(?:https?|oci)://)?(?:ghcr\.io|(?:[\w-]+\.)?gcr\.io|quay\.io|(?:registry-1\.)?docker\.io|public\.ecr\.aws|[\w-]+\.dkr\.ecr(?:-fips)?\.[\w-]+\.amazonaws\.com(?:\.cn)?|[\w-]+\.dkr-ecr(?:-fips)?\.[\w-]+\.on\.aws|[\w-]+\.azurecr\.io|[\w-]+\.pkg\.dev|[\w-]+\.pkg\.github\.com|[\w-]+\.jfrog\.io|(?:[\w-]+\.)*(?:registry|packages|artifacts|artifactory|harbor|nexus)\.[\w-]+(?:\.[\w-]+)*)(?![\w-]|\.[\w-])`;
const REGISTRY_DESTINATION = String.raw`(?:${REGISTRY_HOST}|github\s+(?:packages|(?:container\s+)?registry)|gitlab\s+(?:(?:container|package)\s+)?registry|(?:google(?:\s+cloud)?\s+)?artifact\s+registry|(?:amazon|aws)\s+(?:ecr|(?:elastic\s+)?container\s+registry)|azure\s+(?:artifacts|(?:container\s+)?registry)|(?:jfrog\s+)?artifactory|npm|npmjs|pypi|rubygems(?:\.org)?|crates\.io|crates|maven(?:\s+central)?|nuget|packagist|docker\s+hub|homebrew|hex\.pm|cocoapods|(?:package\s+|artifact\s+|container\s+|image\s+)?registry)`;
const PUBLICATION_DESTINATION = String.raw`(?:${REGISTRY_DESTINATION}|(?:app|play|chrome\s+web|extension|snap)\s+store|marketplace|testflight)`;
const SUBMISSION_VERB = String.raw`(?:submit|upload|post|send|put|push|release)`;
const SUBMISSION_TARGET = String.raw`\s+(?:\S+\s+){0,4}?(?:to|onto|on|into)\s+(?:the\s+|a\s+|our\s+)?`;
const REGISTRY_REMOVAL_VERB = String.raw`(?:remov(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing)|yank(?:s|ed|ing)?)`;
const REGISTRY_MUTATION = new RegExp(String.raw`\bunpublish\b|\bnpm(?:\s+(?:--(?:registry|userconfig|prefix|loglevel)(?:=|\s+)[^\s;|&]+|--(?:force|silent|quiet|yes)|-[fsyq]))*\s+(?:unpublish|deprecate)\b|\b(?:cargo|gem)\s+yank\b|\b${REGISTRY_REMOVAL_VERB}\s+(?:\S+\s+){0,6}?(?:from|on|in|at)\s+(?:the\s+|our\s+)?${REGISTRY_DESTINATION}\b`, "giu");
// Parse registry administration with the same bounded, quote-aware argument
// reader as PR creation. Option values and later commands cannot supply writes.
const NPM_COMMAND = /\bnpm\b/giu;
const NPM_VALUE_OPTIONS = new Set(["--registry", "--userconfig", "--globalconfig", "--prefix", "--loglevel", "--scope", "--otp", "--workspace", "-w", "--location", "--cache", "--access", "--tag"]);
const NPM_ADMIN_VALUE_OPTIONS = new Set([...NPM_VALUE_OPTIONS, "--cidr", "--name", "--token-description", "--expires", "--packages", "--scopes", "--orgs", "--packages-and-scopes-permission", "--orgs-permission", "--password"]);
const NPM_ADMIN_CONTINUATION = /^[ \t]*(?:--?[a-zA-Z]|(?:access|owner|dist-tag|token|create|revoke|list|set|grant|add|rm|remove|public|restricted|2fa-required|2fa-not-required)\b)/u;
const REGISTRY_ADMIN_WRITES = {
  access: new Set(["set", "grant", "revoke", "public", "restricted", "2fa-required", "2fa-not-required"]),
  owner: new Set(["add", "rm", "remove"]),
  "dist-tag": new Set(["add", "rm", "remove"]),
  token: new Set(["create", "revoke"]),
};
function* commandReadings(source, text, pattern, options) {
  const commands = [...text.matchAll(pattern)];
  if (!commands.length) return;
  const spans = [...source.matchAll(LITERAL_SPAN)];
  let consumed = 0, spanIndex = 0;
  for (const match of commands) {
    if (match.index < consumed) continue;
    if (!options?.includeFeatures && featureDeliveryPrefix(deliveryPrefix(text, match.index))) continue;
    while (spanIndex < spans.length && spans[spanIndex].index + spans[spanIndex][0].length <= match.index) spanIndex++;
    const span = spans[spanIndex], end = span && span.index <= match.index ? span.index + span[0].length - 1 : source.length;
    const parsed = commandArguments(source, match.index + match[0].length, end, options);
    consumed = parsed.end;
    yield { match, args: parsed.args, end: parsed.end };
  }
}
// Publication namespaces share the existing quote-aware reader. A command's
// flags are not prose, and only a fully understood simulation/help mode can
// remove its delivery vocabulary. Unknown arity or dynamic/overridden modes
// retain the conflict. Wrapped commands can reveal writes, never prove a dry run.
const PUBLICATION_COMMAND = /\b(?:docker\s+(?:buildx\s+(?:imagetools\s+create|build|b)|(?:image|manifest|compose)\s+push|(?:builder|image)\s+build|build|push)|(?:npm|cargo)\s+publish|docker|npm|cargo)\b/giu;
const PUBLICATION_PRESENT = /\b(?:docker|npm|cargo)\b/iu;
const PUBLICATION_PATHS = {
  npm: { publish: "npm" }, cargo: { publish: "cargo" },
  docker: { push: "write", "image push": "write", "manifest push": "write", "compose push": "dry", "buildx imagetools create": "dry",
    build: "build", "builder build": "build", "image build": "build", "buildx build": "build", "buildx b": "build" },
};
const PUBLICATION_VALUES = {
  npm: new Set([...NPM_VALUE_OPTIONS, "--provenance-file", "--cafile", "--cert", "--key", "--logs-dir", "-w"]),
  cargo: new Set(["--registry", "--index", "--token", "--manifest-path", "--target", "--target-dir", "--package", "--exclude", "--features", "--jobs", "--config", "--color", "--message-format", "--lockfile-path", "-p", "-F", "-j", "-Z", "-C"]),
  docker: new Set(["--config", "--context", "--host", "--log-level", "--builder", "--file", "--project-name", "--project-directory", "--env-file", "--profile", "--parallel", "--progress", "--ansi", "--tag", "--label", "--annotation", "--metadata-file", "--platform", "--build-arg", "--build-context", "--target", "--secret", "--ssh", "--network", "--cache-from", "--cache-to", "--output", "--attest", "--provenance", "--sbom", "--call", "-c", "-H", "-l", "-f", "-p", "-t", "-o"]),
};
const PUBLICATION_SWITCHES = {
  npm: new Set(["--json", "--ignore-scripts", "--foreground-scripts", "--force", "--silent", "--quiet", "--workspaces", "--include-workspace-root", "--provenance", "-f", "-s", "-q"]),
  cargo: new Set(["--no-verify", "--allow-dirty", "--workspace", "--all", "--all-features", "--no-default-features", "--locked", "--offline", "--frozen", "--keep-going", "--verbose", "--quiet", "-v", "-vv", "-q"]),
  docker: new Set(["--all-tags", "--quiet", "--insecure", "--purge", "--include-deps", "--ignore-push-failures", "--append", "--prefer-index", "--load", "--pull", "--no-cache", "--check", "--debug", "-a", "-q", "-D"]),
};
function publicationCommands(source, text) {
  if (!PUBLICATION_PRESENT.test(text)) return { text, writes: [] };
  const parts = [], writes = []; let last = 0;
  for (const { match, args: tail, end } of commandReadings(source, text, PUBLICATION_COMMAND, { newlines: true, includeFeatures: true })) {
    const [tool, ...prefix] = match[0].toLowerCase().split(/\s+/u), paths = PUBLICATION_PATHS[tool], path = [];
    const args = [...prefix.map(value => ({ value, dynamic: false })), ...tail];
    let kind = null, unknown = false, dry = false, drySeen = false, help = false, push = false, output = false, positional = 0;
    const boolean = (arg, equal) => {
      if (arg.dynamic || (equal >= 0 && !/^(?:true|false)$/u.test(arg.value.slice(equal + 1)))) { unknown = true; return null; }
      return equal < 0 || arg.value.slice(equal + 1) === "true";
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
      if (arg.value === "--") { positional += args.length - i - 1; if (args.slice(i + 1).some(value => value.dynamic)) unknown = true; break; }
      if (option === "--help" || option === "-h") { if (tool === "cargo" && equal >= 0) unknown = true; help = boolean(arg, equal) === true; continue; }
      if (option === "--dry-run") {
        if (tool === "cargo" && (equal >= 0 || drySeen)) unknown = true;
        drySeen = true;
        dry = boolean(arg, equal) === true; continue;
      }
      if (tool === "npm" && option === "--no-dry-run") { dry = false; if (equal >= 0 || arg.dynamic) unknown = true; continue; }
      if (tool === "docker" && option === "--push") { push = boolean(arg, equal) !== false; continue; }
      let valueOption = option, inline = equal >= 0, attached = false;
      if (!PUBLICATION_VALUES[tool].has(valueOption) && /^-[^-].+/u.test(arg.value) && PUBLICATION_VALUES[tool].has(arg.value.slice(0, 2))) { valueOption = arg.value.slice(0, 2); inline = true; attached = true; }
      if (PUBLICATION_VALUES[tool].has(valueOption)) {
        const value = inline ? { value: arg.value.slice(attached ? 2 : equal + 1), dynamic: arg.dynamic } : args[++i];
        if (!value?.value || value.dynamic || value.value.startsWith("-")) unknown = true;
        if (tool === "docker" && ["--output", "-o", "--cache-to"].includes(valueOption)) {
          // Registry/image exporters publish just like --push. Local and inline
          // cache exports do not; unresolved exporter values cannot prove that.
          const spec = value?.value || "";
          if (value?.dynamic || /(?:^|,)type=registry(?:,|$)|(?:^|,)push=(?!false(?:,|$))/u.test(spec)
            || (valueOption === "--cache-to" && !/^(?:type=(?:local|inline))(?:,|$)/u.test(spec))) output = true;
        }
        continue;
      }
      if (arg.value.startsWith("-")) { if (!PUBLICATION_SWITCHES[tool].has(option) || arg.dynamic || equal >= 0) unknown = true; continue; }
      if (!kind) {
        path.push(arg.value); const name = path.join(" ");
        if (arg.dynamic || (!Object.hasOwn(paths, name) && !Object.keys(paths).some(candidate => candidate.startsWith(name + " ")))) break;
        kind = paths[name] || null;
      } else { positional++; if (arg.dynamic) unknown = true; }
    }
    if (!kind) {
      if (tool === "docker" && path.length && Object.keys(paths).some(candidate => candidate.startsWith(path.join(" ") + " ")) && /[\r\n]/u.test(source[end] || "")) writes.push({ start: match.index, end });
      continue;
    }
    if ((kind === "npm" && positional > 1) || (kind === "cargo" && positional)) unknown = true;
    const simulation = dry && ["npm", "cargo", "dry"].includes(kind);
    const feature = featureDeliveryPrefix(deliveryPrefix(text, match.index));
    const safe = feature || (!unknown && !/[\r\n]/u.test(source.slice(match.index, end)) && (help || simulation));
    if (!safe && (kind !== "build" || push || output || (unknown && args.some(arg => arg.dynamic)))) writes.push({ start: match.index, end });
    else if (safe || kind === "build") {
      parts.push(text.slice(last, match.index), " ".repeat(end - match.index)); last = end;
    }
  }
  return { text: parts.join("") + text.slice(last), writes };
}
function registryAdministration(source, text = source) {
  for (const { args } of commandReadings(source, text, NPM_COMMAND, { newlines: NPM_ADMIN_CONTINUATION })) {
    let family = null, action = null, help = false, literal = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], option = arg.value.split("=", 1)[0];
      if (!literal && arg.value === "--") { literal = true; continue; }
      if (!literal && (option === "--help" || option === "-h") && !arg.dynamic && (!arg.value.includes("=") || /^(?:true|1|t)$/iu.test(arg.value.slice(arg.value.indexOf("=") + 1)))) { help = true; break; }
      if (!literal && NPM_ADMIN_VALUE_OPTIONS.has(option)) { if (!arg.value.includes("=")) i++; continue; }
      if (!literal && arg.value.startsWith("-")) continue;
      if (!family) { if (!Object.hasOwn(REGISTRY_ADMIN_WRITES, arg.value)) break; family = arg.value; }
      else if (!action) action = arg;
    }
    if (!help && action && (action.dynamic || REGISTRY_ADMIN_WRITES[family].has(action.value))) return true;
  }
  return false;
}
function registryMutation(text, source = text) {
  if (registryAdministration(source, text)) return true;
  for (const match of text.matchAll(REGISTRY_MUTATION)) if (!featureDeliveryPrefix(deliveryPrefix(text, match.index))) return true;
  return false;
}
// Object-storage writes are not task-branch delivery. Read operands with the
// shared command parser: remote sources alone mean downloads, while a move
// also deletes its remote source. Unknown option arity/dynamic operands cannot
// prove a download or simulation. No command is executed during screening.
const STORAGE_DESTINATION = String.raw`(?:s3\b|(?:amazon|aws)\s+s3\b|google\s+cloud\s+storage\b|gcs\b|azure\s+blob\s+storage\b|object[\s-]+storage\b|(?:s3|gs|az)://)`;
const STORAGE_TRANSFER = new RegExp(String.raw`\b(?:upload|send|push|copy|sync)(?:s|ed|ing)?${SUBMISSION_TARGET}${STORAGE_DESTINATION}`, "giu");
const STORAGE_COMMAND = /\b(?:aws|gsutil)\b/giu;
const STORAGE_REMOTE = /^(?:s3|gs|az):\/\//iu;
const STORAGE_VALUE_OPTIONS = new Set(["--profile", "--region", "--endpoint-url", "--output", "--query", "--ca-bundle", "--cli-read-timeout", "--cli-connect-timeout", "--include", "--exclude", "--acl", "--sse", "--sse-c", "--sse-c-key", "--sse-kms-key-id", "--sse-c-copy-source", "--sse-c-copy-source-key", "--storage-class", "--website-redirect", "--content-type", "--cache-control", "--content-disposition", "--content-encoding", "--content-language", "--expires", "--source-region", "--request-payer", "--checksum-mode", "--checksum-algorithm", "--metadata", "--copy-props", "--metadata-directive", "--expected-size", "--page-size", "--progress-frequency", "--case-conflict"]);
const STORAGE_SWITCH_OPTIONS = new Set(["--quiet", "--recursive", "--delete", "--debug", "--no-verify-ssl", "--no-sign-request", "--no-paginate", "--no-cli-pager", "--follow-symlinks", "--no-follow-symlinks", "--no-guess-mime-type", "--only-show-errors", "--no-progress", "--progress-multiline", "--ignore-glacier-warnings", "--force-glacier-transfer", "--size-only", "--exact-timestamps", "--no-overwrite"]);
function objectStorageMutation(source, text = source) {
  for (const match of text.matchAll(STORAGE_TRANSFER)) {
    const before = deliveryPrefix(text, match.index), after = text.slice(match.index + match[0].length);
    if (!PUBLISH_MODIFIER_HEAD.test(before) && !featureDeliveryPrefix(before) && !PUBLISH_MODIFIER_TAIL.test(after)) return true;
  }
  for (const { match, args } of commandReadings(source, text, STORAGE_COMMAND)) {
    const aws = match[0].toLowerCase() === "aws", paths = [];
    let namespace = !aws, action = null, unknown = false, simulation = false, help = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
      if (arg.value === "--help" || (aws && arg.value === "help")) { help = true; break; }
      if (aws && STORAGE_VALUE_OPTIONS.has(option)) {
        const value = equal < 0 ? args[++i] : arg;
        if (!value || value.dynamic || value.value.startsWith("-")) unknown = true;
        continue;
      }
      if (!aws && (option === "-o" || option === "-h" || (action === "rsync" && ["-a", "-x", "-j"].includes(option)) || (action === "cp" && ["-a", "-L", "-j", "-s"].includes(option)))) {
        const value = args[++i]; if (!value || value.dynamic || value.value.startsWith("-")) unknown = true;
        continue;
      }
      if (aws && option === "--dryrun") { simulation = !arg.dynamic && (equal < 0 || /^(?:true|1)$/iu.test(arg.value.slice(equal + 1))); if (!simulation) unknown = true; continue; }
      if (!aws && action === "rsync" && arg.value === "-n") { simulation = true; continue; }
      if (arg.value.startsWith("-") && arg.value !== "-") {
        if (arg.dynamic || (aws ? !STORAGE_SWITCH_OPTIONS.has(arg.value) : !/^-[mqrRnNcCdDeJpPuvzZ]+$/u.test(arg.value))) unknown = true;
        continue;
      }
      if (!namespace) { if (arg.value !== "s3" || arg.dynamic) break; namespace = true; }
      else if (!action) { if (!["cp", "sync", "rsync", "mv"].includes(arg.value) || arg.dynamic) break; action = arg.value; }
      else paths.push(arg);
    }
    if (!action || ((help || simulation) && !unknown)) continue;
    const destination = paths.at(-1);
    if (unknown || paths.length < 2 || (aws && paths.length !== 2) || paths.some(path => path.dynamic) || STORAGE_REMOTE.test(destination.value) || (action === "mv" && paths.slice(0, -1).some(path => path.dynamic || STORAGE_REMOTE.test(path.value)))) return true;
  }
  return false;
}
// Messages and HTTP writes are external effects, never PR delivery authority.
// Use the same feature/literal boundaries and argument reader as other effects.
const COMMUNICATION_DESTINATION = String.raw`(?:(?:slack|(?:microsoft\s+)?teams|discord|telegram|email|e-mail|webhooks?)\b|https?://)`;
const COMMUNICATION_ACTION = new RegExp(String.raw`\b(?:send|sending|post|posting|deliver|delivering)\s+(?:(?:a|an|the|this|that|our|my)\s+){0,2}(?:e-?mails?|messages?|notifications?)\b|\b(?:send|sending|post|posting|share|sharing|report|reporting|upload|uploading)\s+(?:\S+\s+){0,6}?(?:to|on|in|via|through)\s+(?:(?:a|the|our|my)\s+)?${COMMUNICATION_DESTINATION}|\b(?:e-?mail|notify|message|text)\s+(?:(?:the|our|my|all)\s+)?(?:me|us|them|team|owner|users?|customers?)\b|\bsendmail\b`, "giu");
const LOCAL_MESSAGE_TARGET = /^\s+(?:to|on|in)\s+(?:the\s+)?(?:stdout|stderr|console|local\s+(?:logs?|files?))\b/iu;
function outboundCommunication(text) {
  for (const match of text.matchAll(COMMUNICATION_ACTION)) {
    if (featureDeliveryPrefix(deliveryPrefix(text, match.index))) continue;
    if (LOCAL_MESSAGE_TARGET.test(text.slice(match.index + match[0].length))) continue;
    return true;
  }
  return false;
}
const CURL_COMMAND = /\bcurl\b/giu;
const READ_ONLY_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);
const CURL_BODY_OPTIONS = new Set(["--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode", "--json", "--form", "--form-string"]);
const CURL_VALUE_OPTIONS = new Set([...CURL_BODY_OPTIONS, "--request", "--upload-file", "--config", "--header", "--proxy-header", "--url", "--user", "--proxy-user", "--proxy", "--output", "--write-out", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--connect-timeout", "--max-time", "--retry", "--cacert", "--cert", "--key", "--resolve", "--connect-to", "--request-target", "--url-query"]);
const CURL_SHORT_OPTIONS = { X: "--request", d: "--data", F: "--form", T: "--upload-file", K: "--config", H: "--header", u: "--user", U: "--proxy-user", x: "--proxy", o: "--output", w: "--write-out", A: "--user-agent", e: "--referer", b: "--cookie", c: "--cookie-jar", m: "--max-time", G: "--get", I: "--head", h: "--help", V: "--version", ":": "--next" };
function curlMutation(source, text = source) {
  for (const { args } of commandReadings(source, text, CURL_COMMAND)) {
    let method = null, data = false, upload = false, get = false, head = false, unknown = false, mutation = false, help = false;
    const writes = () => unknown || upload || (method ? !READ_ONLY_HTTP_METHODS.has(method) : data && !get && !head);
    const read = (option, arg) => {
      if (option === "--next") { mutation ||= writes(); method = null; data = upload = get = head = unknown = false; }
      else if (option === "--help" || option === "--version") help = true;
      else if (option === "--request") method = !arg?.value || arg.dynamic ? "UNKNOWN" : arg.value.toUpperCase();
      else if (CURL_BODY_OPTIONS.has(option)) data = true;
      else if (option === "--upload-file") upload = true;
      else if (option === "--config") unknown = true;
      else if (option === "--get") get = true;
      else if (option === "--no-get") get = false;
      else if (option === "--head") head = true;
      else if (option === "--no-head") head = false;
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.value === "--") break;
      if (arg.value.startsWith("--")) {
        const equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
        read(option, CURL_VALUE_OPTIONS.has(option) ? (equal < 0 ? args[++i] : { value: arg.value.slice(equal + 1), dynamic: arg.dynamic }) : null);
      } else if (arg.value.startsWith("-")) {
        for (let j = 1; j < arg.value.length; j++) {
          const option = CURL_SHORT_OPTIONS[arg.value[j]];
          if (CURL_VALUE_OPTIONS.has(option)) { read(option, j + 1 < arg.value.length ? { value: arg.value.slice(j + 1), dynamic: arg.dynamic } : args[++i]); break; }
          read(option, null);
        }
      } else if (arg.dynamic) unknown = true;
    }
    if (!help && (mutation || writes())) return true;
  }
  return false;
}
// Authenticated API calls share the HTTP restriction, not PR creation
// authority. Field/input flags select POST unless a method is explicit. Keep
// option values atomic and never execute requests while screening a clause.
const GH_API_COMMAND = /\bgh\s+api\b/giu;
const GH_API_BODY_OPTIONS = new Set(["--field", "--raw-field", "--input"]);
const GH_API_VALUE_OPTIONS = new Set([...GH_API_BODY_OPTIONS, "--method", "--header", "--hostname", "--cache", "--jq", "--template", "--preview"]);
const GH_API_SWITCH_OPTIONS = new Set(["--include", "--paginate", "--slurp", "--silent", "--verbose", "--allow-escape-sequences"]);
const GH_API_SHORT_OPTIONS = { X: "--method", f: "--raw-field", F: "--field", H: "--header", p: "--preview", q: "--jq", t: "--template", i: "--include", h: "--help" };
function githubApiMutation(source, text = source) {
  for (const { args } of commandReadings(source, text, GH_API_COMMAND)) {
    let method = null, body = false, unknown = false, help = false;
    const read = (option, value) => {
      if (option === "--help") { help = !value || (!value.dynamic && /^(?:true|1|t)$/iu.test(value.value)); return; }
      if (GH_API_VALUE_OPTIONS.has(option) && (!value?.value || (value.value.startsWith("-") && !(option === "--input" && value.value === "-")))) unknown = true;
      if (option === "--method") method = !value?.value || value.dynamic ? "UNKNOWN" : value.value.toUpperCase();
      else if (GH_API_BODY_OPTIONS.has(option)) body = true;
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.value === "--") break;
      if (arg.value.startsWith("--")) {
        const equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
        const value = equal < 0 ? null : { value: arg.value.slice(equal + 1), dynamic: arg.dynamic };
        if (GH_API_VALUE_OPTIONS.has(option)) read(option, equal < 0 ? args[++i] : value);
        else if (option === "--help") read(option, value);
        else if (!GH_API_SWITCH_OPTIONS.has(option) || arg.dynamic) unknown = true;
      } else if (arg.value.startsWith("-")) {
        for (let j = 1; j < arg.value.length; j++) {
          const option = GH_API_SHORT_OPTIONS[arg.value[j]];
          if (!option) { unknown = true; break; }
          if (GH_API_VALUE_OPTIONS.has(option)) { read(option, j + 1 < arg.value.length ? { value: arg.value.slice(j + 1).replace(/^=/u, ""), dynamic: arg.dynamic } : args[++i]); break; }
          read(option, null);
        }
      } else if (arg.dynamic) unknown = true;
    }
    if (!(help && !unknown) && (unknown || (method ? !READ_ONLY_HTTP_METHODS.has(method) : body))) return true;
  }
  return false;
}
const TERMS = [
  ["pull_request", /\bpull[\s-]+requests?\b|\bprs?\b/iu],
  // Existing-PR mutations are not the profile's creation of one review PR.
  ["pull_request_lifecycle", null],
  // Issue writes are outside task-branch and review-PR delivery authority.
  ["issue_mutation", null],
  ["workflow_mutation", null],
  ["label_mutation", null],
  ["project_mutation", null],
  ["codespace_mutation", null],
  ["gist_mutation", null],
  ["discussion_mutation", null],
  ["account_key_mutation", null],
  ["authentication_mutation", null],
  ["configuration_mutation", null],
  ["repository_mutation", null],
  ["external_communication", null],
  ["http_mutation", null],
  ["storage_mutation", null],
  ["merge", /\bmerg(?:e|es|ed|ing)\b/iu],
  // Shipping, rollout, go-live, cut-over and promotion wording, and any
  // "to production" destination, are deployment instructions too.
  ["deploy", /\b(?:deploy(?:s|ed|ing|ment|ments)?\b|rollouts?\b|roll(?:s|ed|ing)?[\s-]+(?:(?:it|this|that|them|the\s+\w+)\s+)?out\b|go(?:es|ing)?[\s-]+live\b|cut[\s-]*over\b|ship(?:s|ped|ping)?\s+(?:it|this|that|them|the\s+\w+)\b|promot(?:e|es|ed|ing)\s+\S+(?:\s+\S+)?\s+to\s+(?:production|prod|staging|live)\b|(?:to|into)\s+(?:production|prod)\b)/iu],
  // Product release names/metadata are not requests to mutate a release.
  ["release", null],
  // Submitting, uploading or pushing a package or build to a registry or
  // store, and registry tool commands, are publication wording too.
  ["publish", new RegExp(String.raw`\bpublish(?:es|ed|ing)?\b|\bpublication\b|\b${SUBMISSION_VERB}(?:s|ted|ed|ting|ing)?${SUBMISSION_TARGET}${PUBLICATION_DESTINATION}\b|\b(?:gem|nuget|helm|docker|oras)\s+push\b|\btwine\s+upload\b`, "iu")],
  ["push", /\bpush(?:es|ed|ing)?\b/iu],
  // A write aimed at the base branch itself, or at skipping the task branch
  // and pull request, is a delivery the profile never performs.
  // An explicitly direct or straight write names any branch ("push directly to
  // staging"); the selected base itself is matched by name through the
  // screen's base option, since a profile's base is arbitrary.
  ["direct_push", /\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly\s+|straight\s+)?(?:to|into|on|onto)\s+(?:the\s+)?(?:main|master|trunk|develop(?:ment)?|base(?:\s+branch)?|default\s+branch|release\s+branch|production\s+branch)\b|\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly|straight)\s+(?:to|into|on|onto)\s+(?:the\s+)?[\p{L}\p{N}_./-]+|\bdirectly\s+(?:to|into|on|onto)\s+(?:the\s+)?(?:main|master|trunk|develop|base(?:\s+branch)?|default\s+branch|[\p{L}\p{N}_./-]+\s+branch)\b|\bwithout\s+(?:a\s+|any\s+)?(?:pull\s+request|pr|task\s+branch|feature\s+branch|branch)\b/iu],
  ["commit", /\bcommit(?:s|ted|ting)?\b/iu],
  ["branch", /\bbranch(?:es)?\b/iu],
  ["approval", APPROVAL_TERM],
  ["review", /\breview(?:s|ed|ing|er|ers)?\b/iu],
  ["wait", /\bwait(?:s|ed|ing)?\b|\bhold\s+(?:off|it|this|the)\b/iu],
  ["local", /\b(?:local-only\b|keep\s+(?:it|this|that|the\s+changes?|changes)\s+local\b|patch\s+only\b|diff\s+only\b|do\s+not\s+push\b|don['’]t\s+push\b|un(?:committed|staged|pushed|published|merged|deployed|released|submitted)\b|(?:in|within)\s+(?:the\s+|my\s+|your\s+)?(?:working\s+(?:tree|copy|directory)|worktree|checkout)\s+only\b|(?:keep|leave)\s+(?:\S+\s+){0,4}?(?:in|within)\s+(?:the\s+|my\s+|your\s+)?(?:working\s+(?:tree|copy|directory)|worktree|checkout)\b|working[\s-]tree[\s-]only\b|do\s+not\s+(?:stage|commit)\b|don['’]t\s+(?:stage|commit)\b)/iu],
];
// The selected base is matched by name: with base "staging", "push the
// changes to staging" or "land it on the staging branch" is a direct write to
// the base. The name is matched whole, so "staging2" is not "staging".
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const baseWritePattern = base => {
  const selected = typeof base === "string" && base.trim();
  const name = selected ? escapeRegExp(base.trim()) : "(?:main|master|trunk|develop(?:ment)?)";
  // Imperative code can use Git refspec syntax instead of "push to main".
  const gitPush = String.raw`\bgit\s+push\s+(?:--?[^\s]+\s+)*(?:[^\s]+\s+)?(?:--?[^\s]+\s+)*(?:[^\s:]+:)?["']?(?:refs/heads/)?${name}["']?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])`;
  if (!selected) return new RegExp(gitPush, "iu");
  return new RegExp(String.raw`\b(?:push|commit|land|write)(?:es|ed|ing|s)?\s+(?:\S+\s+){0,4}?(?:directly\s+|straight\s+)?(?:to|into|on|onto)\s+(?:the\s+)?${name}(?:\s+branch)?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])|\bdirectly\s+(?:to|into|on|onto)\s+(?:the\s+)?${name}(?:\s+branch)?(?![\p{L}\p{N}_-]|[./][\p{L}\p{N}])|${gitPush}`, "iu");
};
// Every base-write alternative starts with one of these roots; the prefix
// guard is deliberately broader than its grammar, including inflected words.
// It avoids full ref-write matching for large requests containing only PRs.
const BASE_WRITE_PRESENT = /\b(?:push|commit|land|write|directly|without)/iu;
const termMatches = (term, pattern, text, baseWrite, source = text, base) => (term !== "direct_push" || BASE_WRITE_PRESENT.test(text)) && (pattern?.test(text) || (term === "pull_request_lifecycle" && pullRequestLifecycle(text, source)) || (term === "issue_mutation" && issueMutation(text)) || (term === "workflow_mutation" && workflowMutation(text)) || (term === "label_mutation" && labelMutation(source, text)) || (term === "project_mutation" && projectMutation(source, text)) || (term === "codespace_mutation" && codespaceMutation(source, text)) || (term === "gist_mutation" && gistMutation(source, text)) || (term === "discussion_mutation" && discussionMutation(source, text)) || (term === "account_key_mutation" && accountKeyMutation(source, text)) || (term === "authentication_mutation" && authenticationMutation(source, text)) || (term === "configuration_mutation" && configurationMutation(source, text)) || (term === "repository_mutation" && repositoryMutation(source, text)) || (term === "external_communication" && outboundCommunication(text)) || (term === "http_mutation" && (curlMutation(source, text) || githubApiMutation(source, text))) || (term === "storage_mutation" && objectStorageMutation(source, text)) || (term === "merge" && landingInstruction(text)) || (term === "deploy" && infrastructureMutation(text, source)) || (term === "release" && releaseInstruction(text, source)) || (term === "publish" && registryMutation(text, source)) || (term === "direct_push" && ((baseWrite !== null && baseWrite.test(text)) || nonTaskRefPush(text, base, source))) || (term === "local" && stopAfterCommit(text)));
// Publication and approval escalate per statement (see publishInstruction and
// approvalInstruction) so product nouns such as "a publish button" or "an
// approval workflow" stay assumptions.
const ESCALATING = new Set(["pull_request_lifecycle", "issue_mutation", "workflow_mutation", "label_mutation", "project_mutation", "codespace_mutation", "gist_mutation", "discussion_mutation", "account_key_mutation", "authentication_mutation", "configuration_mutation", "repository_mutation", "external_communication", "http_mutation", "storage_mutation", "merge", "deploy", "release", "wait", "local", "direct_push"]);
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
const EXAMPLE_INFINITIVE = /\b(?:how|code|tests?|examples?|instructions?|documentation)\s+to\s*$/iu;
const FEATURE_DELIVERY_CONTEXT = /\b(?:support|code|tests?|examples?|documentation)\s+for(?:\s+(?:running|executing|invoking|issuing))?\s*$/iu;
// Landing a PR, patch or change means merging it. Keep the existing merge
// effect and polarity checks; landing pages and literal product examples do
// not request that effect. Both active and passive instructions are screened.
const LANDING_WORDS = /\bland(?:s|ed|ing)?\b/giu;
const LANDING_OBJECT = /^\s+(?:(?:a|an|the|this|that|these|those|my|our|your)\s+)?(?:pull[\s-]+requests?|prs?|changes?|patch(?:es)?|commits?|it|them|this|that)\b/iu;
const LANDED_SUBJECT = /\b(?:pull[\s-]+requests?|prs?|changes?|patch(?:es)?|commits?|it|they|this|that)\s+(?:(?:must|should|shall|will|would|could|can|has|have|had|needs?\s+to)\s+)?(?:be|been|is|are|was|were|gets?|got)\s*$/iu;
// Filter with the existing object/subject grammar before building context.
// Repeated bare inflections then require no per-word slices or prefix scans.
const LANDING_CANDIDATE = new RegExp(`${LANDING_WORDS.source}(?=${LANDING_OBJECT.source.slice(1)})|${LANDED_SUBJECT.source.slice(0, -1)}(landed)\\b`, "giu");
function deliveryPrefix(text, end) {
  // These subject/infinitive patterns need at most five preceding words.
  // Scan six tokens once, including all whitespace, instead of rechecking
  // the whole growing prefix for every landing word in a large request.
  let start = end;
  for (let words = 0; words < 6 && start > 0; words++) {
    while (start > 0 && /\s/u.test(text[start - 1])) start--;
    while (start > 0 && !/\s/u.test(text[start - 1])) start--;
  }
  return text.slice(start, end);
}
function featureDeliveryPrefix(before) {
  const command = before.match(COMMAND_SPAN_PREFIX);
  return [before, ...(command ? [before.slice(0, command.index)] : [])].some(prefix => PUBLISH_FEATURE_INFINITIVE.test(prefix) || EXAMPLE_INFINITIVE.test(prefix) || FEATURE_DELIVERY_CONTEXT.test(prefix));
}
// Tag publication, force modes, broad/deleting pushes and explicit non-task
// refs exceed a normal task-branch push. Reuse the direct_push restriction; this detector
// only adds conflicts and never chooses a ref or executes a command.
const PUSH_WORDS = /\bpush(?:es|ed|ing)?\b/giu;
const PUSH_PRESENT = /\bpush(?:es|ed|ing)?\b/iu;
const NON_TASK_REF_OBJECT = /^\s+(?:(?:the|a|an|all|our|these|those)\s+){0,3}(?:(?:git|release|remote)\s+)?(?:tags?|refs?|notes)\b|^\s+(?:all|every|other|unrelated)\s+branches?\b|^\s+--(?:tags|follow-tags|all|mirror|delete|prune)(?=\s|=|$|[.;])/iu;
const NAMED_BRANCH_OBJECT = /^\s+(?:(?:the|a)\s+)?branch\s+(?!for\b|to\b|after\b|when\b|once\b|and\b)([\p{L}\p{N}_./-]+)/iu;
const GIT_PUSH_COMMAND = /\bgit(?:\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+[^\s;|&]+|--(?:git-dir|work-tree)=[^\s;|&]+)){0,4}\s+push\b/giu;
const REF_PUSH_FLAG = /^--(?:tags|follow-tags|all|mirror|delete|prune|force(?:-with-lease)?)(?:=|$)/iu;
const PUSH_VALUE_OPTIONS = new Set(["--push-option", "--receive-pack", "--exec"]);
const PUSH_MODE_CONTINUATION = /\r?\n(?=[ \t]*(?:--force(?:-with-lease)?(?:[=\s]|$)|-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)))/gu;
const FORCE_PUSH_PROSE = /\bforce[\s-]+push(?:es|ed|ing)?\b/giu;
const FORCE_PUSH_FEATURE_TAIL = /^\s+(?:support|options?|flags?|buttons?|settings?|warnings?|status|documentation)\b/iu;
// A source ref before the remote still names a base/non-task write. Match
// selected base names literally; descriptive task/feature branches and feature
// infinitives do not choose another ref. Reuse the existing push conflict.
const REVERSED_BRANCH_OBJECT = /^\s+(?:(?:the|our|a)\s+)?(?!task\s|feature\s|current\s|this\s)([\p{L}\p{N}_./+-]+)\s+branch\s+(?:to|onto)\s+\S/iu;
function sourceRefPushPattern(base) {
  const selected = typeof base === "string" && base.trim();
  const name = selected ? `${escapeRegExp(base.trim())}|main|master|trunk|develop(?:ment)?` : "main|master|trunk|develop(?:ment)?";
  return new RegExp(String.raw`^\s+(?:(?:the|our)\s+)?(?:refs/heads/)?(?:${name})(?:\s+branch)?\s+(?:to|onto)\s+(?:(?:the|a|our)\s+)?(?:remote\s+)?[\p{L}\p{N}_./:@-]+`, "iu");
}
function nonTaskRefPush(text, base, source = text) {
  if (!PUSH_PRESENT.test(text)) return false;
  const sourceRef = sourceRefPushPattern(base);
  for (const match of text.matchAll(PUSH_WORDS)) {
    if (featureDeliveryPrefix(deliveryPrefix(text, match.index))) continue;
    const after = text.slice(match.index + match[0].length);
    if (NON_TASK_REF_OBJECT.test(after) || NAMED_BRANCH_OBJECT.test(after) || REVERSED_BRANCH_OBJECT.test(after) || sourceRef.test(after)) return true;
  }
  // Share the quote-aware command reader: option data cannot supply a mode,
  // and feature examples cannot request a write. Force modes conflict even
  // when the destination is HEAD; the worker never force-pushes its branch.
  const proseParts = []; let last = 0;
  // A mode may wrap onto the next request line. Same-length spaces preserve
  // the immutable source offsets and the reader's quoted/value boundaries.
  const joinModes = value => value.replace(PUSH_MODE_CONTINUATION, space => " ".repeat(space.length));
  for (const { match, args, end } of commandReadings(joinModes(source), joinModes(text), GIT_PUSH_COMMAND)) {
    proseParts.push(text.slice(last, match.index), " ".repeat(end - match.index)); last = end;
    const positional = [];
    let remoteOption = false, options = true;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i].value;
      if (options && arg === "--") { options = false; continue; }
      if (options) {
        if (REF_PUSH_FLAG.test(arg)) return true;
        if (arg === "--repo") { remoteOption = true; if (!args[++i] || args[i].value.startsWith("-")) return true; continue; }
        if (arg.startsWith("--repo=")) { remoteOption = true; continue; }
        if (PUSH_VALUE_OPTIONS.has(arg)) { i++; continue; }
        if (arg.startsWith("-") && !arg.startsWith("--")) {
          for (let j = 1; j < arg.length; j++) {
            if (arg[j] === "o") { if (j + 1 === arg.length) i++; break; }
            if (arg[j] === "f" || arg[j] === "d") return true;
          }
        }
        if (!arg || arg.startsWith("-")) continue;
      }
      positional.push(arg);
    }
    // Without --repo, the first positional word is the remote. A destination must
    // identify only the current task branch, not another named ref/refspec.
    if (positional.slice(remoteOption ? 0 : 1).some(ref => ref !== "HEAD")) return true;
  }
  return lifecycleInstruction(proseParts.join("") + text.slice(last), [FORCE_PUSH_PROSE], FORCE_PUSH_FEATURE_TAIL);
}
const WRITTEN_FEEDBACK_ACTION = /(?:comment(?:ing)?(?:\s+on)?|reply(?:ing)?\s+to|(?:leav(?:e|ing)|post(?:ing)?|add(?:ing)?|send(?:ing)?|writ(?:e|ing))\s+(?:(?:a|the)\s+)?(?:review|comments?|feedback)\s+(?:on|to|for))/.source;
const PR_LIFECYCLE_ACTION = String.raw`(?:clos(?:e|ing)|reopen(?:ing)?|delet(?:e|ing)|edit(?:ing)?|lock(?:ing)?|unlock(?:ing)?|retarget(?:ing)?|convert(?:ing)?|mark(?:ing)?|review(?:ing)?|${WRITTEN_FEEDBACK_ACTION})`;
const PR_LIFECYCLE_VERB = new RegExp(String.raw`\b${PR_LIFECYCLE_ACTION}\s+(?:(?:the|a|an|this|that|existing|current|old)\s+){0,3}(?:pull[\s-]+requests?|prs?)\b`, "giu");
const PR_LIFECYCLE_PASSIVE = /\b(?:pull[\s-]+requests?|prs?)(?:\s*#\d+|\s+\d+)?\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:closed|reopened|deleted|edited|locked|unlocked|retargeted|converted|marked|reviewed|commented\s+on)\b/giu;
const cliRepositoryOptions = actions => String.raw`(?:\s+(?:(?:--repo|-R)(?:=[^\s;|&]*|\s+(?!-|${actions}(?:\s|[.;]|$))[^\s;|&]+)?|-R[^\s;|&]+))*`;
const PR_LIFECYCLE_CLI_ACTION = String.raw`(?:close|reopen|edit|lock|unlock|ready|comment|review)`;
const PR_LIFECYCLE_COMMAND = new RegExp(String.raw`\bgh\s+pr${cliRepositoryOptions(PR_LIFECYCLE_CLI_ACTION)}\s+${PR_LIFECYCLE_CLI_ACTION}\b`, "giu");
function lifecycleInstruction(text, patterns, featureTail = null) {
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    if (featureDeliveryPrefix(deliveryPrefix(text, match.index))) continue;
    if (featureTail?.test(text.slice(match.index + match[0].length))) continue;
    return true;
  }
  return false;
}
function pullRequestLifecycle(text, source = text) {
  return lifecycleInstruction(text, [PR_LIFECYCLE_VERB, PR_LIFECYCLE_PASSIVE, PR_LIFECYCLE_COMMAND])
    || (/\bupdate-branch\b/iu.test(text) && contentMutation(source, text, PR_BRANCH_UPDATE));
}
// Issue writes never become a supported action or prohibition tag. Read-only
// commands and issue-related product features keep their ordinary meaning.
const ISSUE_CREATE_ACTION = String.raw`(?:open(?:ing)?|creat(?:e|ing)|fil(?:e|ing)|rais(?:e|ing)|submit(?:ting)?)`;
const ISSUE_WRITE_ACTION = String.raw`(?:clos(?:e|ing)|reopen(?:ing)?|delet(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|modif(?:y|ying)|lock(?:ing)?|unlock(?:ing)?|assign(?:ing)?|label(?:ling|ing)?|transfer(?:ring)?|pin(?:ning)?|unpin(?:ning)?|${WRITTEN_FEEDBACK_ACTION})`;
const ISSUE_NOUN = String.raw`(?:github\s+)?issues?`;
const ISSUE_URL = String.raw`https?://github\.com/[\w.-]+/[\w.-]+/issues/\d+`;
const ISSUE_REFERENCE = String.raw`(?:${ISSUE_NOUN}(?:\s*#\d+|\s+\d+)?|${ISSUE_URL})`;
const ISSUE_DETERMINERS = String.raw`(?:(?:the|a|an|this|that|new|existing|current|old)\s+){0,3}`;
const ISSUE_VERB = new RegExp(String.raw`\b(?:${ISSUE_CREATE_ACTION}\s+${ISSUE_DETERMINERS}${ISSUE_NOUN}|${ISSUE_WRITE_ACTION}\s+${ISSUE_DETERMINERS}(?:${ISSUE_NOUN}|${ISSUE_URL}))\b`, "giu");
const ISSUE_PASSIVE_AFTER = /^\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|opened|filed|raised|submitted|edited|updated|modified|commented\s+on|closed|reopened|deleted|locked|unlocked|assigned|labelled|labeled|transferred|pinned|unpinned)\b/iu;
const ISSUE_PASSIVE = new RegExp(String.raw`\b${ISSUE_REFERENCE}${ISSUE_PASSIVE_AFTER.source.slice(1)}`, "giu");
const ISSUE_QUOTED_REFERENCE = new RegExp(String.raw`^${ISSUE_DETERMINERS}${ISSUE_REFERENCE}$`, "iu");
const ISSUE_SPAN_PREFIX = new RegExp(String.raw`\b${ISSUE_WRITE_ACTION}\s+${ISSUE_DETERMINERS}$`, "iu");
const ISSUE_FEATURE_TAIL = /^\s*(?:templates?|dialogs?|modals?|editors?|forms?|buttons?|panels?|pages?|views?|screens?|components?|tabs?|menus?|badges?|fields?|lists?|tables?|models?|endpoints?|api)\b/iu;
const ISSUE_CLI_ACTION = String.raw`(?:create|edit|comment|close|reopen|delete|develop|lock|unlock|pin|unpin|transfer)`;
// gh accepts the repository selector before the subcommand as well. A quoted
// value may be blanked by literal masking; never consume the action as a value.
const ISSUE_CLI_REPO = cliRepositoryOptions(ISSUE_CLI_ACTION);
const ISSUE_COMMAND = new RegExp(String.raw`\bgh\s+issue${ISSUE_CLI_REPO}\s+${ISSUE_CLI_ACTION}\b`, "giu");
function issueMutation(text) {
  if (!/\bissues?\b/iu.test(text)) return false;
  return lifecycleInstruction(text, [ISSUE_VERB], ISSUE_FEATURE_TAIL)
    || lifecycleInstruction(text, [ISSUE_PASSIVE, ISSUE_COMMAND]);
}
// Workflow dispatch and state writes are outside PR delivery authority, as
// are rerunning, cancelling or deleting an existing Actions run. No tag grants
// these effects. Share CLI selector and product-context boundaries with issues.
const WORKFLOW_CLI_ACTION = String.raw`(?:run|enable|disable)`;
const RUN_CLI_ACTION = String.raw`(?:rerun|cancel|delete)`;
const WORKFLOW_COMMAND = new RegExp(String.raw`\b(?:gh\s+workflow${cliRepositoryOptions(WORKFLOW_CLI_ACTION)}\s+${WORKFLOW_CLI_ACTION}|gh\s+run${cliRepositoryOptions(RUN_CLI_ACTION)}\s+${RUN_CLI_ACTION})\b`, "giu");
const WORKFLOW_VERB = /\b(?:trigger(?:ing)?|dispatch(?:ing)?|run(?:ning)?|rerun(?:ning)?|re-run(?:ning)?|enabl(?:e|ing)|disabl(?:e|ing)|cancel(?:ling|ing)?)\s+(?:(?:the|a|this|that)\s+)?(?:github\s+(?:actions\s+)?)?workflows?\b/giu;
const RUN_MUTATION_ACTION = String.raw`(?:cancel(?:ling|ing)?|rerun(?:ning)?|re-run(?:ning)?|delet(?:e|ing))`;
const RUN_DETERMINERS = String.raw`(?:(?:the|a|an|this|that|these|those|all|failed|running|queued|completed|latest|current|existing|old)\s+){0,4}`;
const RUN_NOUN = String.raw`(?:(?:github\s+)?actions|(?:github\s+(?:actions\s+)?)?workflow)\s+runs?`;
const RUN_REFERENCE = String.raw`${RUN_DETERMINERS}${RUN_NOUN}(?:\s*#\d+|\s+\d+)?`;
const RUN_VERB = new RegExp(String.raw`\b${RUN_MUTATION_ACTION}\s+${RUN_REFERENCE}\b`, "giu");
const RUN_PASSIVE_AFTER = /^\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:cancelled|canceled|rerun|re-run|deleted)\b/iu;
const RUN_PASSIVE = new RegExp(String.raw`\b${RUN_REFERENCE}${RUN_PASSIVE_AFTER.source.slice(1)}`, "giu");
const RUN_QUOTED_REFERENCE = new RegExp(String.raw`^${RUN_REFERENCE}$`, "iu");
const RUN_SPAN_PREFIX = new RegExp(String.raw`\b${RUN_MUTATION_ACTION}\s+${RUN_DETERMINERS}$`, "iu");
function workflowMutation(text) {
  return /\b(?:workflows?|runs?)\b/iu.test(text) && (lifecycleInstruction(text, [WORKFLOW_COMMAND, WORKFLOW_VERB, RUN_PASSIVE])
    || lifecycleInstruction(text, [RUN_VERB], ISSUE_FEATURE_TAIL));
}
// Repository label writes are independent of creating the task's review PR.
// Parse the family once: names/option values cannot supply an action or help,
// while clone writes destination labels just like create/edit/delete.
const LABEL_COMMAND = /\bgh\s+label\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|edit|delete|clone|list|ls)\b))?/giu;
const LABEL_WRITES = new Set(["create", "edit", "delete", "clone"]);
const LABEL_VALUE_OPTIONS = new Set(["--repo", "--color", "--description", "--name", "--limit", "--search", "--json", "--jq", "--template", "--order", "--sort"]);
const LABEL_SHORT_OPTIONS = { R: "--repo", c: "--color", d: "--description", n: "--name", L: "--limit", S: "--search", q: "--jq", t: "--template", h: "--help" };
const LABEL_NOUN = String.raw`(?:github|repository|repo)\s+labels?`;
const LABEL_VERB = new RegExp(String.raw`\b(?:creat(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing))\s+${ISSUE_DETERMINERS}${LABEL_NOUN}\b`, "giu");
const LABEL_PASSIVE = new RegExp(String.raw`\b${LABEL_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|edited|updated|deleted|removed)\b`, "giu");
const CONTENT_FEATURE_TAIL = /^\s*(?:selectors?|fields?|templates?|dialogs?|editors?|forms?|buttons?|panels?|pages?|view(?:er)?s?|screens?|components?|tabs?|menus?|badges?|lists?|tables?|models?|endpoints?|api)\b/iu;
const LABEL_MUTATION = { command: LABEL_COMMAND, writes: LABEL_WRITES, valueOptions: LABEL_VALUE_OPTIONS, shortOptions: LABEL_SHORT_OPTIONS,
  verbs: [LABEL_VERB], passives: [LABEL_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
// Gists publish or change account-owned content even when secret. In contrast,
// gh gist clone only downloads locally; it does not copy labels to GitHub.
const GIST_COMMAND = /\bgh\s+gist\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|new|edit|delete|rename|list|ls|view|clone)\b))?/giu;
const GIST_WRITES = new Set(["create", "new", "edit", "delete", "rename"]);
const GIST_VALUE_OPTIONS = new Set(["--desc", "--filename", "--add", "--remove", "--limit", "--filter"]);
const GIST_SHORT_OPTIONS = { d: "--desc", f: "--filename", a: "--add", r: "--remove", L: "--limit", h: "--help" };
const GIST_NOUN = String.raw`(?:github\s+)?gists?`;
const GIST_VERB = new RegExp(String.raw`\b(?:creat(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing)|renam(?:e|ing))\s+${ISSUE_DETERMINERS}${GIST_NOUN}\b`, "giu");
const GIST_PASSIVE = new RegExp(String.raw`\b${GIST_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|edited|updated|deleted|removed|renamed)\b`, "giu");
const GIST_MUTATION = { command: GIST_COMMAND, writes: GIST_WRITES, valueOptions: GIST_VALUE_OPTIONS, shortOptions: GIST_SHORT_OPTIONS,
  verbs: [GIST_VERB], passives: [GIST_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
// Discussion posts, edits and comment/reply writes are external content;
// list/view, help and quoted title/body data share the existing family reader.
const DISCUSSION_PRESENT = /\bdiscussions?\b/iu;
const DISCUSSION_COMMAND = /\bgh\s+discussion\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|edit|comment|list|view)\b))?/giu;
const DISCUSSION_NOUN = String.raw`(?:github|repository|repo)\s+discussions?`;
const DISCUSSION_VERB = new RegExp(String.raw`\b(?:creat(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|comment(?:ing)?\s+on|reply(?:ing)?\s+to)\s+${ISSUE_DETERMINERS}${DISCUSSION_NOUN}\b`, "giu");
const DISCUSSION_PASSIVE = new RegExp(String.raw`\b${DISCUSSION_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|edited|updated)\b`, "giu");
const DISCUSSION_MUTATION = { command: DISCUSSION_COMMAND, writes: new Set(["create", "edit", "comment"]),
  valueOptions: new Set(["--repo", "--title", "--body", "--body-file", "--category", "--label", "--add-label", "--remove-label", "--limit", "--search", "--json", "--jq", "--template"]),
  shortOptions: { R: "--repo", t: "--title", b: "--body", F: "--body-file", c: "--category", l: "--label", L: "--limit", S: "--search", q: "--jq", h: "--help" },
  verbs: [DISCUSSION_VERB], passives: [DISCUSSION_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
function discussionMutation(source, text = source) { return DISCUSSION_PRESENT.test(text) && contentMutation(source, text, DISCUSSION_MUTATION); }
// Secret/variable writes change remote configuration beyond task-branch/PR
// scope. Share command data/help boundaries; secret set --no-store is the
// documented local encryption mode, so only a proven true flag excludes it.
const CONFIGURATION_PRESENT = /\b(?:secrets?|variables?)\b/iu;
const CONFIGURATION_COMMAND = /\bgh\s+(?:secret|variable)\b(?:[ \t]*\r?\n[ \t]*(?=(?:set|delete|list|get)\b))?/giu;
const CONFIGURATION_NOUN = String.raw`github\s+(?:(?:repository|repo|environment|organization|org|user|account)\s+)?(?:secrets?|variables?)`;
const CONFIGURATION_VERB = new RegExp(String.raw`\b(?:set(?:ting)?|creat(?:e|ing)|updat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing))\s+${ISSUE_DETERMINERS}${CONFIGURATION_NOUN}\b`, "giu");
const CONFIGURATION_PASSIVE = new RegExp(String.raw`\b${CONFIGURATION_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:set|created|updated|deleted|removed)\b`, "giu");
const CONFIGURATION_MUTATION = { command: CONFIGURATION_COMMAND, localOnly: { action: "set", option: "--no-store", command: /\bgh\s+secret\b/iu }, writes: new Set(["set", "delete"]),
  valueOptions: new Set(["--repo", "--app", "--body", "--env", "--env-file", "--org", "--repos", "--visibility", "--json", "--jq", "--template", "--limit"]),
  shortOptions: { R: "--repo", a: "--app", b: "--body", e: "--env", f: "--env-file", o: "--org", r: "--repos", v: "--visibility", q: "--jq", t: "--template", L: "--limit", h: "--help" },
  verbs: [CONFIGURATION_VERB], passives: [CONFIGURATION_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
function configurationMutation(source, text = source) {
  return CONFIGURATION_PRESENT.test(text) && contentMutation(source, text, CONFIGURATION_MUTATION);
}
// Projects, their fields/items and repository/team links are account-owned
// external state. Share only parsing; each namespace supplies its write set.
const PROJECT_COMMAND = /\bgh\s+project\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|edit|delete|close|copy|field-create|field-delete|item-add|item-archive|item-create|item-delete|item-edit|link|unlink|mark-template|list|view|field-list|item-list)\b))?/giu;
const PROJECT_WRITES = new Set(["create", "edit", "delete", "close", "copy", "field-create", "field-delete", "item-add", "item-archive", "item-create", "item-delete", "item-edit", "link", "unlink", "mark-template"]);
const PROJECT_VALUE_OPTIONS = new Set(["--owner", "--title", "--description", "--readme", "--visibility", "--format", "--jq", "--template", "--source-owner", "--target-owner", "--data-type", "--name", "--single-select-options", "--id", "--url", "--body", "--date", "--field", "--field-id", "--iteration-id", "--number", "--project-id", "--single-select-option-id", "--text", "--value", "--repo", "--team", "--limit", "--query"]);
const PROJECT_SHORT_OPTIONS = { d: "--description", q: "--jq", t: "--template", R: "--repo", T: "--team", L: "--limit", h: "--help" };
const PROJECT_NOUN = String.raw`github\s+projects?`;
const PROJECT_VERB = new RegExp(String.raw`\b(?:creat(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing)|clos(?:e|ing)|reopen(?:ing)?|copy(?:ing)?)\s+${ISSUE_DETERMINERS}${PROJECT_NOUN}\b`, "giu");
const PROJECT_PASSIVE = new RegExp(String.raw`\b${PROJECT_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|edited|updated|deleted|removed|closed|reopened|copied)\b`, "giu");
const PROJECT_MUTATION = { command: PROJECT_COMMAND, writes: PROJECT_WRITES, valueOptions: PROJECT_VALUE_OPTIONS, shortOptions: PROJECT_SHORT_OPTIONS,
  verbs: [PROJECT_VERB], passives: [PROJECT_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
// Codespace lifecycle writes allocate, change or discard remote workspaces.
// The CLI alias and quoted option values share the content-family reader;
// status/list/view/logs and help cannot supply a mutating subcommand as data.
const CODESPACE_COMMAND = /\bgh\s+(?:codespace|cs)\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|delete|stop|rebuild|edit|list|ls|status|view|logs)\b))?/giu;
const CODESPACE_WRITES = new Set(["create", "delete", "stop", "rebuild", "edit"]);
const CODESPACE_VALUE_OPTIONS = new Set(["--codespace", "--repo", "--repo-owner", "--org", "--user", "--branch", "--display-name", "--location", "--machine", "--idle-timeout", "--retention-period", "--devcontainer-path", "--days", "--json", "--jq", "--template", "--limit"]);
const CODESPACE_SHORT_OPTIONS = { c: "--codespace", R: "--repo", o: "--org", u: "--user", b: "--branch", d: "--display-name", l: "--location", m: "--machine", q: "--jq", t: "--template", L: "--limit", h: "--help" };
const CODESPACE_NOUN = String.raw`(?:github\s+)?codespaces?`;
const CODESPACE_DETERMINERS = String.raw`(?:(?:the|a|an|this|that|these|those|all|my|our|your|new|existing|current|old)\s+){0,3}`;
const CODESPACE_ACTION = String.raw`(?:creat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing)|stop(?:ping)?|rebuild(?:ing)?|edit(?:ing)?|resiz(?:e|ing))`;
const CODESPACE_VERB = new RegExp(String.raw`\b${CODESPACE_ACTION}\s+${CODESPACE_DETERMINERS}${CODESPACE_NOUN}\b`, "giu");
const CODESPACE_PASSIVE_AFTER = /^\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|deleted|removed|stopped|rebuilt|edited|resized)\b/iu;
const CODESPACE_PASSIVE = new RegExp(String.raw`\b${CODESPACE_NOUN}${CODESPACE_PASSIVE_AFTER.source.slice(1)}`, "giu");
const CODESPACE_QUOTED_REFERENCE = new RegExp(String.raw`^${CODESPACE_DETERMINERS}${CODESPACE_NOUN}$`, "iu");
const CODESPACE_SPAN_PREFIX = new RegExp(String.raw`\b${CODESPACE_ACTION}\s+${CODESPACE_DETERMINERS}$`, "iu");
const CODESPACE_MUTATION = { command: CODESPACE_COMMAND, writes: CODESPACE_WRITES, valueOptions: CODESPACE_VALUE_OPTIONS, shortOptions: CODESPACE_SHORT_OPTIONS,
  verbs: [CODESPACE_VERB], passives: [CODESPACE_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
function codespaceMutation(source, text = source) { return contentMutation(source, text, CODESPACE_MUTATION); }
function projectMutation(source, text = source) { return contentMutation(source, text, PROJECT_MUTATION); }
function labelMutation(source, text = source) { return contentMutation(source, text, LABEL_MUTATION); }
function gistMutation(source, text = source) { return contentMutation(source, text, GIST_MUTATION); }
// Authentication configuration is persistent account authority, not task-PR
// delivery. Reuse content-family boundaries; -h is a hostname value here,
// whereas only --help is help. Status/token merely read existing credentials.
const AUTHENTICATION_PRESENT = /\bgh\s+auth\b/iu;
const AUTHENTICATION_COMMAND = /\bgh\s+auth\b(?:[ \t]*\r?\n[ \t]*(?=(?:login|logout|switch|refresh|setup-git|status|token)\b))?/giu;
const AUTHENTICATION_MUTATION = { command: AUTHENTICATION_COMMAND, writes: new Set(["login", "logout", "switch", "refresh", "setup-git"]),
  valueOptions: new Set(["--hostname", "--user", "--scopes", "--remove-scopes", "--git-protocol", "--json", "--jq", "--template"]),
  shortOptions: { h: "--hostname", u: "--user", s: "--scopes", r: "--remove-scopes", p: "--git-protocol", q: "--jq", t: "--template" },
  verbs: [], passives: [] };
function authenticationMutation(source, text = source) { return AUTHENTICATION_PRESENT.test(text) && contentMutation(source, text, AUTHENTICATION_MUTATION); }
// Account keys are outside branch/PR authority. The shared command reader
// keeps list/help and key title/type values separate from add/delete actions.
const ACCOUNT_KEY_PRESENT = /\b(?:ssh|gpg)[\s-]+keys?\b/iu;
const ACCOUNT_KEY_COMMAND = /\bgh\s+(?:ssh|gpg)-key\b(?:[ \t]*\r?\n[ \t]*(?=(?:add|delete|list|ls)\b))?/giu;
const ACCOUNT_KEY_KIND = String.raw`(?:ssh|gpg)[\s-]+keys?`;
const ACCOUNT_KEY_NOUN = String.raw`github\s+(?:account\s+)?${ACCOUNT_KEY_KIND}`;
const ACCOUNT_KEY_ACTION = String.raw`(?:add(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|revok(?:e|ing))`;
const ACCOUNT_KEY_VERB = new RegExp(String.raw`\b${ACCOUNT_KEY_ACTION}\s+${ISSUE_DETERMINERS}${ACCOUNT_KEY_NOUN}\b`, "giu");
const ACCOUNT_KEY_DESTINATION = new RegExp(String.raw`\b${ACCOUNT_KEY_ACTION}\s+${ISSUE_DETERMINERS}${ACCOUNT_KEY_KIND}\s+(?:to|from|on|in)\s+(?:(?:the|my|our|your)\s+)?github\s+account\b`, "giu");
const ACCOUNT_KEY_PASSIVE = new RegExp(String.raw`\b${ACCOUNT_KEY_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:added|deleted|removed|revoked)\b`, "giu");
const ACCOUNT_KEY_MUTATION = { command: ACCOUNT_KEY_COMMAND, writes: new Set(["add", "delete"]),
  valueOptions: new Set(["--title", "--type"]), shortOptions: { t: "--title", h: "--help" },
  verbs: [ACCOUNT_KEY_VERB, ACCOUNT_KEY_DESTINATION], passives: [ACCOUNT_KEY_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
function accountKeyMutation(source, text = source) { return ACCOUNT_KEY_PRESENT.test(text) && contentMutation(source, text, ACCOUNT_KEY_MUTATION); }
// Repository lifecycle/settings writes are not task-branch or PR delivery.
// Share command/data/help boundaries with the other unsupported mutations.
const REPOSITORY_PRESENT = /\b(?:gh\s+repo|github\s+(?:repos?|repositor(?:y|ies)))\b/iu;
const REPOSITORY_COMMAND = /\bgh\s+repo\b(?:[ \t]*\r?\n[ \t]*(?=(?:delete|archive|unarchive|rename|edit|create|fork|sync|autolink|view|list|clone)\b))?/giu;
const REPOSITORY_NOUN = String.raw`github\s+(?:repos?|repositor(?:y|ies))`;
const REPOSITORY_ACTION = String.raw`(?:delet(?:e|ing)|remov(?:e|ing)|archiv(?:e|ing)|unarchiv(?:e|ing)|renam(?:e|ing))`;
const REPOSITORY_VERB = new RegExp(String.raw`\b${REPOSITORY_ACTION}\s+${ISSUE_DETERMINERS}${REPOSITORY_NOUN}\b`, "giu");
const REPOSITORY_PASSIVE = new RegExp(String.raw`\b${REPOSITORY_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:deleted|removed|archived|unarchived|renamed)\b`, "giu");
const REPOSITORY_MUTATION = { command: REPOSITORY_COMMAND, writes: new Set(["delete", "archive", "unarchive", "rename", "edit", "create", "fork", "sync"]),
  valueOptions: new Set(["--repo", "--description", "--homepage", "--gitignore", "--license", "--remote", "--source", "--team", "--template", "--fork-name", "--org", "--remote-name", "--branch", "--visibility", "--default-branch", "--add-topic", "--remove-topic", "--squash-merge-commit-message", "--json", "--jq", "--limit", "--language", "--topic"]),
  shortOptions: { R: "--repo", d: "--description", h: "--homepage", g: "--gitignore", l: "--license", r: "--remote", s: "--source", t: "--team", p: "--template", b: "--branch", q: "--jq", L: "--limit" },
  subcommands: new Map([["autolink", { writes: new Set(["create", "new", "delete"]), shortOptions: { R: "--repo", q: "--jq", t: "--template", h: "--help" } }]]),
  verbs: [REPOSITORY_VERB], passives: [REPOSITORY_PASSIVE], featureTail: CONTENT_FEATURE_TAIL };
function repositoryMutation(source, text = source) { return REPOSITORY_PRESENT.test(text) && contentMutation(source, text, REPOSITORY_MUTATION); }
// Keep command/help parsing and quoted-data boundaries identical across the
// content families; their own command tables decide which actions write.
function contentMutation(source, text, { command, writes, valueOptions, shortOptions, verbs, passives, featureTail, proseCheck = null, subcommands = null, localOnly = null }) {
  const proseParts = []; let last = 0;
  for (const { match, args, end } of commandReadings(source, text, command)) {
    // A preserved code span can contain quoted arguments. They are data, even
    // when their contents look like qualified natural-language writes.
    proseParts.push(text.slice(last, match.index), " ".repeat(end - match.index)); last = end;
    let action = null, help = false, nested = null, local = false;
    const readHelp = value => { help = !value || (!value.dynamic && /^(?:true|1|t)$/iu.test(value.value)); };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
      if (arg.value === "--") break;
      if (option === localOnly?.option && (!localOnly.command || localOnly.command.test(match[0]))) { local = equal < 0 || (!arg.dynamic && /^(?:true|1|t)$/iu.test(arg.value.slice(equal + 1))); continue; }
      if (option === "--help") { readHelp(equal < 0 ? null : { value: arg.value.slice(equal + 1), dynamic: arg.dynamic }); continue; }
      if (valueOptions.has(option)) { if (equal < 0) i++; continue; }
      if (arg.value.startsWith("-") && !arg.value.startsWith("--")) {
        for (let j = 1; j < arg.value.length; j++) {
          const short = (nested?.shortOptions ?? shortOptions)[arg.value[j]];
          if (valueOptions.has(short)) { if (j + 1 === arg.value.length) i++; break; }
          if (short === "--help") {
            const assigned = arg.value[j + 1] === "=";
            readHelp(assigned ? { value: arg.value.slice(j + 2), dynamic: arg.dynamic } : null);
            if (assigned) break;
          }
        }
      } else if (!arg.value.startsWith("-") && !action) {
        // Consume only a configured namespace, never an option value. Dynamic
        // namespace/action words still fail closed through the normal rule.
        const child = !nested && !arg.dynamic && subcommands?.get(arg.value);
        if (child) nested = child;
        else action = arg;
      }
    }
    if (action && (action.dynamic || (!help && (nested?.writes ?? writes).has(action.value) && !(local && action.value === localOnly?.action)))) return true;
  }
  const prose = proseParts.join("") + text.slice(last);
  return lifecycleInstruction(prose, verbs, featureTail) || lifecycleInstruction(prose, passives) || Boolean(proseCheck?.(prose));
}
// Canonical infrastructure writes request deployment even without a deploy
// verb. Reuse the existing effect, feature/literal context and statement bounds.
const INFRA_OPTIONS = String.raw`(?:\s+(?:-(?:n|f)\s+[^\s;|&]+|--(?:namespace|kube-context|kubeconfig|context|values)(?:=|\s+)[^\s;|&]+|--dry-run(?:=[^\s;|&]+)?|--(?:debug|wait|atomic|create-namespace)))*`;
const NODE_MAINTENANCE = String.raw`(?:drain|cordon|uncordon|taint)`;
const NODE_MAINTENANCE_COMMAND = new RegExp(String.raw`^kubectl${INFRA_OPTIONS}\s+${NODE_MAINTENANCE}\b`, "iu");
const INFRA_MUTATION = new RegExp(String.raw`\b(?:(?:terraform|tofu)(?:\s+-chdir(?:=[^\s;|&]+|\s+[^\s;|&]+))?\s+(?:apply|destroy)|helm${INFRA_OPTIONS}\s+(?:install|upgrade|rollback|uninstall|delete)|kubectl${INFRA_OPTIONS}\s+(?:apply|create|replace|patch|delete|scale|run|${NODE_MAINTENANCE}|rollout\s+(?:restart|undo)|set\s+image))\b`, "giu");
const INFRA_VALUE_OPTIONS = new Set(["-f", "--filename", "-k", "--kustomize", "-n", "--namespace", "--context", "--kube-context", "--kubeconfig", "--values", "--set", "--set-string", "--set-json", "--set-file", "--set-literal", "-o", "--output"]);
const NODE_VALUE_OPTIONS = new Set([...INFRA_VALUE_OPTIONS, "-l", "--selector", "--pod-selector", "--grace-period", "--timeout", "--chunk-size", "--skip-wait-for-delete-timeout", "--field-manager", "--template", "--validate"]);
const NODE_SWITCH_OPTIONS = new Set(["--force", "--ignore-daemonsets", "--delete-emptydir-data", "--disable-eviction", "--all", "--overwrite", "--show-managed-fields"]);
function infrastructureDryRun(command, nodeMaintenance = false) {
  // Only unambiguous simulation flags exempt a command: flag-shaped values,
  // quoted arguments, unknown option arity and later overrides ask instead.
  if (/["'`\\]/u.test(command) || (nodeMaintenance && /\$/u.test(command))) return false;
  const args = command.trim().split(/\s+/u);
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (nodeMaintenance && arg === "--") break;
    if (arg === "--dry-run" || arg.startsWith("--dry-run=")) {
      if (nodeMaintenance ? arg !== "--dry-run=client" : arg !== "--dry-run" && !/^--dry-run=(?:client|server)$/u.test(arg)) return false;
      dryRun = true;
    } else if (nodeMaintenance && NODE_VALUE_OPTIONS.has(arg.split("=", 1)[0])) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++i];
      if (!value || value.startsWith("-")) return false;
    } else if (nodeMaintenance && arg.startsWith("-")) {
      const option = arg.split("=", 1)[0];
      if (!NODE_SWITCH_OPTIONS.has(option) || (arg.includes("=") && !/=(?:true|false)$/u.test(arg))) return false;
    } else if (INFRA_VALUE_OPTIONS.has(arg)) {
      if (!args[++i]) return false;
    } else if (arg.startsWith("-") && !arg.includes("=")) return false;
  }
  return dryRun;
}
// Pulumi preview/history/output are not writes. Resource updates, deletion,
// state refresh/import and cancelling an update retain the deployment conflict.
// Parse global option values atomically so --cwd up cannot become an update.
const PULUMI_COMMAND = /\bpulumi\b/giu;
const PULUMI_VALUE_OPTIONS = new Set(["--cwd", "-C", "--stack", "-s", "--color", "--profiling", "--tracing", "--verbose", "-v", "--message", "-m", "--config", "-c", "--config-file", "--parallel", "-p", "--plan", "--policy-pack", "--policy-pack-config", "--target", "--replace", "--target-replace", "--exec-agent", "--exec-kind", "--import-file", "--out", "--parent", "--provider", "--properties"]);
const PULUMI_SWITCH_OPTIONS = new Set(["--yes", "-y", "--skip-preview", "-f", "--expect-no-changes", "--non-interactive", "--disable-integrity-checking", "--logflow", "--logtostderr", "--debug", "-d", "--json", "-j"]);
const PULUMI_WRITES = new Set(["up", "update", "destroy", "refresh", "import", "cancel"]);
function pulumiMutation(source, text = source) {
  for (const { args } of commandReadings(source, text, PULUMI_COMMAND)) {
    let action = null, help = false, unknown = false, preview = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i], option = arg.value.split("=", 1)[0];
      if (arg.value === "--help" || arg.value === "-h") { help = true; continue; }
      if (PULUMI_VALUE_OPTIONS.has(option)) { const value = arg.value.includes("=") ? arg : args[++i]; if (!value || value.dynamic) unknown = true; continue; }
      if (option === "--preview-only") { preview = !arg.dynamic && (!arg.value.includes("=") || /^(?:true|1)$/iu.test(arg.value.slice(arg.value.indexOf("=") + 1))); continue; }
      if (arg.value.startsWith("-")) { if (!PULUMI_SWITCH_OPTIONS.has(option) || arg.dynamic) unknown = true; continue; }
      if (!action) action = arg;
    }
    if (action && (action.dynamic || PULUMI_WRITES.has(action.value)) && !(help && !unknown) && !(action.value === "refresh" && preview && !unknown)) return true;
  }
  return false;
}
function infrastructureMutation(text, source = text) {
  if (pulumiMutation(source, text)) return true;
  for (const match of text.matchAll(INFRA_MUTATION)) {
    if (featureDeliveryPrefix(deliveryPrefix(text, match.index))) continue;
    const after = text.slice(match.index + match[0].length), stop = after.search(INFRA_COMMAND_BREAK);
    const args = stop < 0 ? after : after.slice(0, stop);
    if (/^(?:helm|kubectl)\b/iu.test(match[0]) && infrastructureDryRun(match[0] + args, NODE_MAINTENANCE_COMMAND.test(match[0]))) continue;
    return true;
  }
  return false;
}
function landingInstruction(text) {
  for (const match of text.matchAll(LANDING_CANDIDATE)) {
    // Passive candidates include their subject. Feature context still ends
    // at the landing word, just as it does for an active object candidate.
    const word = match.index + (match[1] ? match[0].length - match[1].length : 0);
    if (featureDeliveryPrefix(deliveryPrefix(text, word))) continue;
    return true;
  }
  return false;
}
// A terminal stop after a Git commit withholds the push and review PR that the
// selected profile requires. Read both clause orders, within statement bounds;
// feature infinitives and database transactions retain their product meaning.
const STOP_AFTER_COMMIT = /\b(?:stop|pause|halt)\s+(?:right\s+|immediately\s+)?(?:after|once|when)\s+(?:[^\s;.!?]+\s+){0,6}?commit(?:ted|ting)?\b|\b(?:after|once|when)\s+(?:[^\s;.!?]+\s+){0,6}?commit(?:ted|ting)?\b(?:\s+[^\s;.!?,]+){0,6}\s*,?\s*(?:stop|pause|halt)\b/giu;
function stopAfterCommit(text) {
  if (!/\bcommit(?:ted|ting)?\b/iu.test(text)) return false;
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
const PUBLISH_VERBS = new RegExp(String.raw`\bpublish\b|\b${SUBMISSION_VERB}${SUBMISSION_TARGET}${PUBLICATION_DESTINATION}\b|\b(?:gem|nuget|helm|docker|oras)\s+push\b|\btwine\s+upload\b`, "giu");
function publishInstruction(statement, source = statement) {
  if (registryMutation(statement, source)) return true;
  for (const match of statement.matchAll(PUBLISH_VERBS)) {
    const before = deliveryPrefix(statement, match.index), after = statement.slice(match.index + match[0].length);
    if (PUBLISH_MODIFIER_HEAD.test(before) || featureDeliveryPrefix(before) || PUBLISH_MODIFIER_TAIL.test(after)) continue;
    return true;
  }
  return false;
}
// Release actions keep their existing unsupported effect. Product nouns,
// local resource release and read-only CLI data never supply that action.
// Reuse command masking so a read-only template cannot become release prose.
const RELEASE_PRESENT = /\breleas(?:e|es|ed|ing)\b/iu;
const RELEASE_WORDS = /\breleas(?:e|es|ed|ing)\b/giu;
const RELEASE_COMMAND = /\bgh\s+release\b(?:[ \t]*\r?\n[ \t]*(?=(?:create|edit|delete|delete-asset|upload|list|view|download|verify|verify-asset)\b))?/giu;
const RELEASE_WRITES = new Set(["create", "edit", "delete", "delete-asset", "upload"]);
const RELEASE_VALUE_OPTIONS = new Set(["--repo", "--notes", "--notes-file", "--title", "--target", "--tag", "--discussion-category", "--notes-start-tag", "--json", "--jq", "--template", "--limit", "--archive", "--pattern", "--dir", "--output"]);
const RELEASE_SHORT_OPTIONS = { R: "--repo", n: "--notes", F: "--notes-file", t: "--title", q: "--jq", L: "--limit", h: "--help" };
const RELEASE_FEATURE_TAIL = /^\s*(?:notes?|metadata|management|changelogs?|history|dashboards?|viewers?|browsers?|panels?|dialogs?|buttons?|forms?|schemas?|fields?|checklists?|(?:version|status)\s+(?:fields?|columns?|badges?|selectors?))\b/iu;
const RELEASE_DETERMINERS = String.raw`(?:(?:a|an|the|this|that|new|latest|current|previous|old)\s+){0,3}`;
const RELEASE_NOUN = String.raw`(?:github\s+)?releases?`;
const RELEASE_LIFECYCLE = new RegExp(String.raw`\b(?:creat(?:e|ing)|cut(?:ting)?|publish(?:ing)?|draft(?:ing)?|delet(?:e|ing)|remov(?:e|ing)|edit(?:ing)?|updat(?:e|ing))\s+${RELEASE_DETERMINERS}${RELEASE_NOUN}\b`, "giu");
const RELEASE_DESTINATION = new RegExp(String.raw`\b(?:upload(?:ing)?|attach(?:ing)?|submit(?:ting)?|post(?:ing)?|send(?:ing)?|push(?:ing)?)${SUBMISSION_TARGET}${RELEASE_NOUN}\b`, "giu");
const RELEASE_PASSIVE = new RegExp(String.raw`\b${RELEASE_NOUN}\s+(?:(?:must|should|shall|will|needs?\s+to)\s+)?(?:be|is|are|get|gets)\s+(?:created|cut|published|drafted|deleted|removed|edited|updated)\b`, "giu");
const RELEASE_REMOTE_METADATA = new RegExp(String.raw`\b(?:creat(?:e|ing)|edit(?:ing)?|updat(?:e|ing)|delet(?:e|ing)|remov(?:e|ing))\s+${RELEASE_DETERMINERS}github\s+releases?\s+(?:notes?|metadata)\b`, "giu");
const RELEASE_METADATA_FEATURE = /^\s*(?:pages?|parsers?|viewers?|browsers?|panels?|dialogs?|forms?|schemas?|fields?|models?|serializers?|validators?|formatters?)\b/iu;
const RELEASE_READ_HEAD = /\b(?:display|show|list|parse|read|fetch|query|inspect|render|describe|document|track|check|verify|cache|index|filter|sort|count|compare|load|serialize|validate)\s+(?:(?:the|a|an|latest|current|previous|next|new|old|stable|beta|github)\s+){0,4}$/iu;
const RELEASE_FEATURE_HEAD = /\b(?:add|build|implement|fix|improve|refactor|redesign|enhance|adjust|test|update|edit|create|extend|change|alter|remove|delete|support)\s+(?:(?:the|a|an|latest|current|previous|new|old|github)\s+){0,3}$/iu;
const RELEASE_NOUN_HEAD = /\b(?:the|a|an|latest|current|previous|next|new|old|stable|beta|of|for|against|on|in|github)\s*$|(?:[/:]|--)\s*$/iu;
const RELEASE_RESOURCE = /^\s+(?:(?:the|a|an|this|our|your)\s+)?(?:memory|mutex(?:es)?|locks?|semaphores?|file\s+handles?|file\s+descriptors?)\b/iu;
const RELEASE_PASSIVE_HEAD = /\b(?:be|been|being|is|are|was|were|gets?|got)\s*$|\b(?:have|get)\s+(?:(?:the|a|this|that|our)\s+)?(?:it|package|build|version|changes?|artifact|app)\s*$/iu;
function releaseProse(text) {
  if (!RELEASE_PRESENT.test(text)) return false;
  if (lifecycleInstruction(text, [RELEASE_REMOTE_METADATA], RELEASE_METADATA_FEATURE)) return true;
  for (const statement of statements(text)) for (const match of statement.matchAll(RELEASE_WORDS)) {
    const before = deliveryPrefix(statement, match.index), after = statement.slice(match.index + match[0].length);
    if (/\bgh\s*$/iu.test(before) || featureDeliveryPrefix(before) || RELEASE_READ_HEAD.test(before) || RELEASE_FEATURE_HEAD.test(before) || RELEASE_RESOURCE.test(after) || /^[./_-]|^:(?=\S)/u.test(after)) continue;
    if (/^\s*(?:notes?|metadata)\b/iu.test(after) && !/^\s*(?:notes?|metadata)(?:\s+\S+){0,2}?\s+(?:to|onto)\b/iu.test(after)) continue;
    if (match[0].toLowerCase() === "released" && !RELEASE_PASSIVE_HEAD.test(before)) continue;
    const control = after.match(CONTROL_IN_STATEMENT);
    const controlledAfter = control && /^\s*(?:(?:is|are|remains?|stays?|must|should|shall|will)(?:\s+be)?\s*)?$/iu.test(after.slice(0, control.index));
    if (RELEASE_NOUN_HEAD.test(before) && !CONTROL_IN_STATEMENT.test(before) && !controlledAfter) continue;
    return true;
  }
  return false;
}
const RELEASE_MUTATION = { command: RELEASE_COMMAND, writes: RELEASE_WRITES, valueOptions: RELEASE_VALUE_OPTIONS, shortOptions: RELEASE_SHORT_OPTIONS,
  verbs: [RELEASE_LIFECYCLE, RELEASE_DESTINATION], passives: [RELEASE_PASSIVE], featureTail: RELEASE_FEATURE_TAIL, proseCheck: releaseProse };
function releaseInstruction(text, source = text) { return RELEASE_PRESENT.test(text) && contentMutation(source, text, RELEASE_MUTATION); }
// Approval wording is an instruction to wait for someone's decision ("wait
// for my approval", "get my consent", "get my authorization", "once approved")
// unless it names product behaviour: an approval noun followed by a feature
// noun ("an approval workflow", "the approval status column"), an approval
// verb as a feature infinitive ("a button to approve comments") or "approved"
// as an adjective on a product noun ("list approved expenses").
const APPROVAL_WORDS = new RegExp(APPROVAL_TERM.source, "giu");
const APPROVAL_FEATURE_TAIL = /^\s*(?:workflow|workflows|flow|flows|process|processes|step|steps|stage|stages|status|statuses|state|states|button|buttons|screen|screens|page|pages|form|forms|dialog|modal|queue|queues|request|requests|rule|rules|policy|policies|chain|chains|matrix|gate|gates|history|log|logs|email|emails|notification|notifications|badge|badges|column|columns|field|fields|table|tables|model|models|endpoint|endpoints|api|ui|feature|features|logic|level|levels|limit|limits|threshold|thresholds|role|roles|permission|permissions|type|types|record|records|comment|comments|action|actions|checkbox|toggle|setting|settings|icon|icons|list|lists|view|views|tab|tabs|timestamp|timestamps|date|dates|count|counts|rate|rates|flag|flags|event|events|hook|hooks|routing|system|module|service|handler|controller|component|widget|panel|dashboard|report|reports|requirement|requirements|mechanism|pipeline|tracking|audit|reminder|reminders|deadline|deadlines|sla|engine|manager|managers|reviewer|reviewers|approver|approvers|chain|template|templates|message|messages|reason|reasons|note|notes|metadata|data|entity|entities|object|objects|flow|banners?|middleware|checks?)\b/iu;
const APPROVAL_PRODUCT_NOUN = /^\s*(?:expenses?|invoices?|requests?|claims?|orders?|refunds?|applications?|documents?|comments?|posts?|articles?|submissions?|items?|records?|users?|accounts?|vendors?|suppliers?|timesheets?|budgets?|purchases?|leave|transactions?|payments?|listings?|reviews?|entries|entry|drafts?|changes?\s+list|content|uploads?|images?|products?|templates?|designs?|proposals?)\b/iu;
function approvalInstruction(statement) {
  for (const match of statement.matchAll(APPROVAL_WORDS)) {
    const word = match[0].toLowerCase(), after = statement.slice(match.index + match[0].length);
    if ((/^(?:approvals?|consents?|authori[sz]ations?|permissions?|confirmations?|sign[\s-]?off)$/u.test(word) || /\bgo[\s-]?ahead$/u.test(word)) && APPROVAL_FEATURE_TAIL.test(after)) continue;
    if (/^(?:approved|authori[sz]ed|consented)$/u.test(word) && APPROVAL_PRODUCT_NOUN.test(after)) continue;
    if (featureDeliveryPrefix(deliveryPrefix(statement, match.index))) continue;
    return true;
  }
  return false;
}
const CONTROLS = /\b(?:do\s+not|don['’]t|never|not|no|without|avoid|refrain|forbid(?:den|s)?|prohibit(?:ed|s)?|only\s+after|only\s+once|until|unless|instead\s+of|skip|cannot|can['’]t|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|won['’]t|will\s+not|is\s+(?:not\s+)?(?:required|mandatory|optional)|required|mandatory|out\s+of\s+scope|outside\s+(?:of\s+)?(?:the\s+|this\s+|our\s+)?scope|exclud(?:e|es|ed|ing)|except(?:\s+for)?|other\s+than|apart\s+from|aside\s+from|but\s+not|minus|leave\s+out|leaving\s+out|(?:I|we)(?:['’]ll|\s+will|\s+shall|\s+plan\s+to|\s+intend\s+to|\s+would\s+(?:rather|prefer\s+to))\s+(?:\w+\s+){0,2}?(?:open|create|raise|submit|make|file|review|comment|close|reopen|edit|lock|unlock|retarget|convert|mark|merge|land|deploy|release|publish|push|ship|handle|take\s+care\s+of|do)|let\s+(?:me|us)\s+(?:\w+\s+){0,2}?(?:open|create|raise|submit|make|file|review|comment|close|reopen|edit|lock|unlock|retarget|convert|mark|merge|land|deploy|release|publish|push|ship|handle|take\s+care\s+of|do|approve|sign\s+off|decide)|myself|ourselves|leave\s+(?:\S+\s+){0,4}?to\s+(?:me|us)|is\s+(?:mine|ours)\s+to|on\s+my\s+own|isn['’]t|aren['’]t|wasn['’]t|weren['’]t|disallow(?:ed|s)?|not\s+permitted|unauthori[sz]ed|off[\s-]limits|stop(?:s|ped|ping)?\s+(?:short\s+of|before|at|prior\s+to|right\s+before|just\s+before)|paus(?:e|es|ed|ing)\s+(?:before|at|prior\s+to)|halt(?:s|ed|ing)?\s+(?:before|at|prior\s+to)|short\s+of)\b/giu;

// Text that ends with a control phrase, optionally followed by an introductory
// colon, comma or dash: whatever comes next is the target of that control.
const CONTROL_TAIL = new RegExp(`${CONTROLS.source}[\\s:,\\-–—]*$`, "iu");
// Affirmative controls state a requirement rather than a prohibition. A
// negated form ("is not required") keeps its "not" and reads as negative.
const AFFIRMATIVE_CONTROLS = /\b(?:(?:is|are|be|remains?|stays?)\s+(?:required|mandatory|compulsory|optional)|required|mandatory|compulsory)\b/giu;
const AFFIRMATIVE_PRESENT = new RegExp(AFFIRMATIVE_CONTROLS.source, "iu");
const AFFIRMATIVE_WHOLE = new RegExp(`^(?:${AFFIRMATIVE_CONTROLS.source})$`, "iu");
// Dots inside registry, repository and branch names are not sentence ends.
// Contrast starts a new control scope; conjunctions such as "and" retain it.
const SENTENCE_BREAK = /[;!?]+|\.(?![\p{L}\p{N}_/-])|\r?\n[ \t]*\r?\n|\r?\n(?=[ \t]*(?:[-*+]|\d+[.)])\s)|\b(?:but|however|yet|nevertheless)\b/iu;
const COMMAND_BREAK = new RegExp(`${SENTENCE_BREAK.source}|[\\n&|]`, "iu");
const INFRA_COMMAND_BREAK = new RegExp(`${COMMAND_BREAK.source}|\\b(?:and|then|after|once|when|before)\\b`, "iu");

// Literal examples do not instruct. Paired quotes and code spans are masked;
// unmatched openers stay visible so a quote cannot hide an instruction. A span
// inside a statement that a control phrase already governs (`Do not ever
// "open a pull request"`) is emphasis on the control's target, not an example,
// and stays visible; over-reading such a span only costs a clarification.
const CONTROL_IN_STATEMENT = new RegExp(CONTROLS.source, "iu");
// Apostrophes inside words are not quote openers or closers. A quoted label
// may itself contain a contraction, such as 'Don't deploy'.
const LITERAL_SPAN = /`[^`]*`|"[^"]*"|[“][^”]*[”]|(?<![\p{L}\p{N}_])'(?:[^']|(?<=[\p{L}\p{N}])'(?=[\p{L}\p{N}]))*'(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])‘(?:[^’]|(?<=[\p{L}\p{N}])’(?=[\p{L}\p{N}]))*’(?![\p{L}\p{N}_])/gu;
const COMMAND_SPAN_PREFIX = /\b(?:run|execute|invoke|issue)(?:\s+(?:the|this|that|following))?(?:\s+(?:shell|terminal|cli))?(?:\s+commands?)?\s*:?\s*(?:(?:,|and|then)\s*)*$/iu;
const DELIVERY_SPAN_PREFIX = new RegExp(String.raw`\b(?:open|create|raise|submit|make|file|send|${PR_LIFECYCLE_ACTION}|merge|land(?:s|ed|ing)?|deploy|publish|push|commit)(?:\s+(?:a|an|the|one|two|three|four|five|single|separate|multiple|several|another|\d+)){0,3}\s*$`, "iu");
const PUBLICATION_TARGET_PREFIX = new RegExp(String.raw`\b(?:${SUBMISSION_VERB}${SUBMISSION_TARGET}|${REGISTRY_REMOVAL_VERB}\s+(?:\S+\s+){0,6}?(?:from|on|in|at)\s+(?:the\s+|our\s+)?)$`, "iu");
const COMMUNICATION_SPAN_PREFIX = /\b(?:post|notify)\s*$/iu;
const APPROVAL_SPAN_PREFIX = /\b(?:get|obtain|seek|request|await)(?:\s+(?:my|our|your|their|the|a))?\s*$|\b(?:check|confirm|clear)\s+with\s*$|\b(?:ask|consult)\s*$/iu;
const STOP_SPAN_PREFIX = /\b(?:stop|pause|halt)\s+(?:after|once|when)\s*$/iu;
function quotedPrTargetSpans(source, blank, spans) {
  const kept = new Set();
  if (!PR_INSTRUCTION_PRESENT.test(blank)) return kept;
  const parts = []; let last = 0;
  for (const span of spans) { parts.push(source.slice(last, span.index), " " + span[0].slice(1, -1) + " "); last = span.index + span[0].length; }
  const values = parts.join("") + source.slice(last);
  const keep = (start, end) => {
    let lo = 0, hi = spans.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (spans[mid].index < start) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < spans.length && spans[i].index < end; i++) if (spans[i].index + spans[i][0].length - 1 <= end) kept.add(spans[i].index);
  };
  for (const { start, end } of statementRanges(blank)) {
    let first = true;
    for (const match of blank.slice(start, end).matchAll(PR_INSTRUCTION)) {
      const at = start + match.index, after = at + match[0].length;
      if (featureDeliveryPrefix(deliveryPrefix(blank, at))) continue;
      if (first) {
        const leading = pullRequestQualifiers(values.slice(start, at), source.slice(start, at));
        if (/^[\s,]*(?:please\s*)?$/iu.test(leading.rest)) for (const range of leading.ranges) keep(start + range.start, start + range.end);
        first = false;
      }
      const following = pullRequestQualifiers(values.slice(after, end), source.slice(after, end));
      for (const range of following.ranges) keep(after + range.start, after + range.end);
    }
  }
  return kept;
}
function imperativeSpan(before, after, span, atStart) {
  const issueReference = ISSUE_QUOTED_REFERENCE.test(span.slice(1, -1).trim());
  const runReference = RUN_QUOTED_REFERENCE.test(span.slice(1, -1).trim());
  const codespaceReference = CODESPACE_QUOTED_REFERENCE.test(span.slice(1, -1).trim());
  const message = before.match(COMMUNICATION_SPAN_PREFIX);
  const messageCommand = message && !PUBLISH_MODIFIER_HEAD.test(before.slice(0, message.index)) && outboundCommunication(message[0] + span.slice(1, -1)) ? message : null;
  const command = messageCommand || (codespaceReference && before.match(CODESPACE_SPAN_PREFIX)) || (runReference && before.match(RUN_SPAN_PREFIX)) || (issueReference && before.match(ISSUE_SPAN_PREFIX)) || before.match(COMMAND_SPAN_PREFIX) || before.match(DELIVERY_SPAN_PREFIX) || before.match(PUBLICATION_TARGET_PREFIX) || before.match(APPROVAL_SPAN_PREFIX) || before.match(STOP_SPAN_PREFIX);
  if (command) {
    const prefix = before.slice(0, command.index);
    if (!PUBLISH_FEATURE_INFINITIVE.test(prefix) && !EXAMPLE_INFINITIVE.test(prefix)) return true;
  }
  return (codespaceReference && CODESPACE_PASSIVE_AFTER.test(after)) || (runReference && RUN_PASSIVE_AFTER.test(after)) || (issueReference && ISSUE_PASSIVE_AFTER.test(after))
    || /^\s*(?:must|should|shall|will)\s+be\s+(?:run|executed|invoked)\b/iu.test(after)
    || (span.startsWith("`") && atStart && /^\s*(?:$|(?:after|once|when|then)\b)/iu.test(after));
}
export function maskLiterals(text, { syntax = false } = {}) {
  // Judge each span against its whole statement (before and after it) with
  // every span blanked, so a control word inside an example never counts and
  // a trailing control ("... is forbidden") still governs the span before it.
  const whole = String(text);
  const spans = [...whole.matchAll(LITERAL_SPAN)];
  if (!spans.length) return whole;
  const parts = [];
  let blankEnd = 0;
  for (const m of spans) {
    parts.push(whole.slice(blankEnd, m.index), " ".repeat(m[0].length));
    blankEnd = m.index + m[0].length;
  }
  const blank = parts.join("") + whole.slice(blankEnd);
  const prTargets = quotedPrTargetSpans(whole, blank, spans);
  const breaks = [...blank.matchAll(new RegExp(SENTENCE_BREAK.source, "giu"))];
  let nextBreak = 0;
  let out = "", last = 0, statementStart = -1;
  let controlled = false, command = false, prefixWhitespace = true, bareList = false, trailingCommand = false;
  for (let i = 0; i < spans.length; i++) {
    const m = spans[i];
    while (nextBreak < breaks.length && breaks[nextBreak].index < m.index) nextBreak++;
    const previous = breaks[nextBreak - 1], next = breaks[nextBreak];
    const start = previous ? previous.index + previous[0].length : 0, end = next?.index ?? blank.length;
    if (start !== statementStart) {
      statementStart = start;
      const statement = blank.slice(start, end);
      controlled = CONTROL_IN_STATEMENT.test(statement);
      bareList = !blank.slice(start, m.index).trim() && /^(?:\s|,|and\b|then\b)*(?:$|(?:after|once|when)\b)/iu.test(statement);
      trailingCommand = /^(?:\s|,|and\b|then\b)*(?:must|should|shall|will)\s+be\s+(?:run|executed|invoked)\b/iu.test(statement);
      command = false; prefixWhitespace = true;
    }
    // Adjacent outside segments are disjoint: long lists of quoted examples
    // do not repeatedly scan their whole statement or all preceding spans.
    const before = blank.slice(Math.max(start, last), m.index);
    const after = blank.slice(m.index + m[0].length, Math.min(end, spans[i + 1]?.index ?? end));
    prefixWhitespace &&= !before.trim();
    command = prTargets.has(m.index) || trailingCommand || (bareList && m[0].startsWith("`")) || (command && /^(?:\s|,|and\b|then\b)*$/iu.test(before)) || imperativeSpan(before, after, m[0], prefixWhitespace);
    out += whole.slice(last, m.index);
    out += controlled || command ? (syntax ? " " + m[0].slice(1, -1) + " " : m[0]) : " ".repeat(m[0].length);
    last = m.index + m[0].length;
  }
  return out + whole.slice(last);
}

// Control words bind within a statement. Sentence/clause punctuation and
// contrast end one; additive conjunctions do not, so "do not push and open a PR" keeps both
// terms under the control, and a colon that introduces a control's target
// ("Do not: open a pull request") does not end the statement either.
function statementRanges(text) {
  const ranges = [];
  const sentence = (start, end) => {
    let current = start;
    for (const colon of text.slice(start, end).matchAll(/:(?!\/\/)/gu)) {
      const at = start + colon.index;
      if (!CONTROL_TAIL.test(text.slice(current, at))) { ranges.push({ start: current, end: at }); current = at + 1; }
    }
    ranges.push({ start: current, end });
  };
  let start = 0;
  for (const boundary of text.matchAll(new RegExp(SENTENCE_BREAK.source, "giu"))) {
    sentence(start, boundary.index);
    start = boundary.index + boundary[0].length;
  }
  sentence(start, text.length);
  return ranges;
}
export function statements(text) {
  const source = String(text);
  return statementRanges(source).map(({ start, end }) => source.slice(start, end));
}

// Keep immutable line IDs while screening the complete statements they touch.
// Quoted spans cannot manufacture context boundaries. Cache shared windows so
// many lines of one wrapped instruction are screened once, within input limits.
export function deliveryScreens(text, requirements, target = {}) {
  const source = String(text);
  const ranges = statementRanges(source.replace(LITERAL_SPAN, span => " ".repeat(span.length)));
  const cache = new Map(), screens = new Map();
  for (const requirement of requirements) {
    const span = requirement.source;
    const touching = span && Number.isInteger(span.start) && Number.isInteger(span.end)
      && source.slice(span.start, span.end) === requirement.text
      ? ranges.filter(range => range.end > span.start && range.start < span.end) : [];
    if (!touching.length) { screens.set(requirement.id, deliveryScreen(requirement.text, target)); continue; }
    const start = touching[0].start, end = touching.at(-1).end, key = `${start}:${end}`;
    if (!cache.has(key)) {
      let contextStart = start;
      // A nounless "then another for the UI" needs its prior PR reference.
      // Extend only across adjacent follow-ons, and only to a real creation
      // reading; feature requests and unrelated clauses cannot supply it.
      if (PR_LEADING_ELLIPSIS.test(source.slice(start, end))) {
        for (let i = ranges.indexOf(touching[0]) - 1; i >= 0; i--) {
          const previous = maskLiterals(source.slice(ranges[i].start, ranges[i].end), { syntax: true });
          if (!previous.trim()) continue;
          const { instructions, requests } = pullRequestReadings(previous);
          if (instructions.length || requests.length || lifecycleInstruction(previous, [PR_LEADING_REFERENCE], CONTENT_FEATURE_TAIL)) { contextStart = ranges[i].start; break; }
          if (!lifecycleInstruction(previous, [PR_LEADING_FOLLOW_ON], CONTENT_FEATURE_TAIL)) break;
        }
      }
      cache.set(key, deliveryScreen(source.slice(contextStart, end), target));
    }
    screens.set(requirement.id, cache.get(key));
  }
  return screens;
}
// A review prohibited outright ("do not send this for review", "no code
// review", "reviews are forbidden") conflicts with pull-request delivery, which
// exists to request review, so it escalates and no tag can speak for it. A
// review named as a condition ("until someone has reviewed it", "do not merge
// until reviewed") or as optional ("a review is not required") does not. The
// nearest control word in the statement decides, a preceding one first.
const REVIEW_TERM = /\breview(?:s|ed|ing|er|ers)?\b/giu;
const NON_PROHIBITIVE_CONTROL = /^(?:until|unless|only after|only once|is (?:not )?(?:required|mandatory|optional))$/u;
function reviewProhibited(statement, matches) {
  const controls = matches.map(match => ({ index: match.index, text: match[0].toLowerCase().replace(/\s+/g, " ") }));
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
const PR_COUNT_REQUEST = /\b(?:use|return|deliver|provide|want|need)\s+(?:\S+\s+){0,4}?(?:pull[\s-]+requests?|prs?)\b/giu;
const PR_CREATE_COMMAND = /\bgh\s+pr\s+create\b/giu;
const PR_INSTRUCTION_PRESENT = new RegExp(PR_INSTRUCTION.source, "iu");
// Elliptical follow-ons still request another external PR, including when
// punctuation moves them into their own source clause. Product noun tails
// and feature context keep the same shared lifecycle boundaries.
const PR_ADDITIONAL_REFERENCE = String.raw`(?:another|an?\s+(?:additional|separate|second)|one\s+more)\s+(?:pull[\s-]+requests?|prs?)\b`;
const PR_ADDITIONAL = String.raw`(?:another\s+for\b|${PR_ADDITIONAL_REFERENCE})`;
const PR_TEMPORAL = String.raw`(?:then|next|afterwards?|later|subsequently|after\s+that)`;
const PR_CONNECTOR = String.raw`(?:and(?:\s*,?\s+${PR_TEMPORAL})?|${PR_TEMPORAL})`;
const PR_FOLLOW_ON = new RegExp(String.raw`(?:\b${PR_CONNECTOR}(?:\s+|\s*,\s*)|,\s*)${PR_ADDITIONAL}`, "giu");
const PR_LEADING_FOLLOW_ON = new RegExp(String.raw`^\s*(?:${PR_CONNECTOR}(?:\s+|\s*,\s*))?${PR_ADDITIONAL}`, "giu");
const PR_LEADING_REFERENCE = new RegExp(String.raw`^\s*(?:${PR_CONNECTOR}(?:\s+|\s*,\s*))?${PR_ADDITIONAL_REFERENCE}`, "giu");
const PR_LEADING_ELLIPSIS = new RegExp(String.raw`^\s*(?:${PR_CONNECTOR}(?:\s+|\s*,\s*))?another\s+for\b`, "iu");
const PR_REQUEST_PRESENT = new RegExp(`(?:${PR_INSTRUCTION.source}|${PR_COUNT_REQUEST.source}|${PR_CREATE_COMMAND.source}|${PR_ADDITIONAL}|\\b(?:separate|multiple|several|individual|distinct)\\s+(?:pull[\\s-]+requests|prs)\\b)`, "iu");
// The supported profile opens exactly one PR. Quantity and per-component
// requests remain conflicts independently of an optional planner action tag.
function pullRequestReadings(statement) {
  const instructions = [...statement.matchAll(PR_INSTRUCTION), ...statement.matchAll(PR_CREATE_COMMAND)].filter(m => !PUBLISH_FEATURE_INFINITIVE.test(statement.slice(0, m.index)));
  const requests = [...statement.matchAll(PR_COUNT_REQUEST)].filter(m => !PUBLISH_FEATURE_INFINITIVE.test(statement.slice(0, m.index)));
  return { instructions, requests };
}
function multiplePullRequests(text) {
  if (!PR_REQUEST_PRESENT.test(text)) return false;
  let count = 0;
  const featureStatements = new Set();
  for (const statement of statements(text)) {
    if (featureStatements.has(statement)) continue;
    if (lifecycleInstruction(statement, [count ? PR_LEADING_FOLLOW_ON : PR_LEADING_REFERENCE], CONTENT_FEATURE_TAIL)) return true;
    const { instructions, requests } = pullRequestReadings(statement);
    count += instructions.length + requests.filter(m => !instructions.some(i => i.index < m.index + m[0].length && m.index < i.index + i[0].length)).length;
    if (count > 1 || /^\s*(?:please\s+)?(?:separate|multiple|several|individual|distinct)\s+(?:pull[\s-]+requests|prs)\b/iu.test(statement)) return true;
    // Repeated feature statements contribute no creation request. Cache only
    // zero-count readings; repeated actual requests must still count twice.
    if (!instructions.length && !requests.length) featureStatements.add(statement);
    for (const match of [...instructions, ...requests]) {
      const after = statement.slice(match.index + match[0].length);
      if (/\b(?:two|three|four|five|six|seven|eight|nine|ten|multiple|several|another|additional|second|third|[2-9]\d*|1\d+)\b/iu.test(match[0])
        || /\b(?:pull[\s-]+requests|prs)\b/iu.test(match[0])
        || /^[`'"”’]*\s*(?:twice|for\s+(?:each|every)|per)\b/iu.test(after)
        || /^\s*for\s+(?:(?:code|team)\s+)?review\s+(?:per|for\s+(?:each|every))\b/iu.test(after)
        || lifecycleInstruction(after, [PR_FOLLOW_ON], CONTENT_FEATURE_TAIL)) return true;
    }
  }
  return false;
}
const PR_DRAFT_QUALIFIER = /^(?:as\s+(?:a\s+)?draft\b|in\s+draft\s+mode\b)/iu;
const PR_BASE = /^(?:against|into|to|in|on|targeting|targets?|(?:base|target)(?:\s+branch)?\s*(?:is|to|:))\s+(?:the\s+)?(?:branch\s+)?([^\s,;!?]+)/iu;
const PR_REPOSITORY = /^(?:in|to|for|on)\s+(?:the\s+)?(?:repo(?:sitory)?\s+)?(https?:\/\/[^\s,;!?]+|(?:github\.com\/)?[\w.-]+\/[\w.-]+)/iu;
const PR_OTHER_REPOSITORY = /^(?:in|to|for|on)\s+(?:another|a\s+different|the\s+other)\s+repo(?:sitory)?\b/iu;
const PR_MISSING_TARGET = /^(?:against|into|targeting|in|on|to)\s*(?=,|$)/iu;
// Read only a contiguous sequence attached to the PR, with an optional review
// purpose. Stop at the first independent action instead of borrowing its
// prepositions ("run tests on Linux", "document it in docs/README.md").
// Descriptive values must be one complete quoted span. Read them from source,
// skip them atomically, and expose ranges only for actual target qualifiers.
const PR_DESCRIPTION_HEAD = /^(?:titled|named|called|(?:with\s+(?:(?:the|a)\s+)?)?(?:title|body|description))\b(?:\s+(?:of|is)\b)?\s*/iu;
const PR_DESCRIPTION_VALUE = new RegExp(`^(?:${LITERAL_SPAN.source})`, "u");
function pullRequestQualifiers(text, source = text) {
  const targets = [], ranges = [];
  let rest = text;
  for (;;) {
    const tail = rest.replace(/^(?:\s+|,|and\b|for\s+(?:(?:code|team)\s+)?review\b)*/iu, "");
    const at = text.length - tail.length, original = source.slice(at);
    if (PR_DRAFT_QUALIFIER.test(tail)) return { targets, rest, ranges };
    const description = original.match(PR_DESCRIPTION_HEAD);
    if (description) {
      const value = original.slice(description[0].length).match(PR_DESCRIPTION_VALUE);
      if (!value || value[0].includes("\\")) { targets.push({ kind: "description" }); return { targets, rest, ranges }; }
      rest = tail.slice(description[0].length + value[0].length);
      continue;
    }
    const other = tail.match(PR_OTHER_REPOSITORY), repo = tail.match(PR_REPOSITORY);
    const base = tail.match(PR_BASE), missing = tail.match(PR_MISSING_TARGET);
    const match = other || repo || base || missing;
    if (!match) return { targets, rest, ranges };
    targets.push(other ? { kind: "other" } : repo ? { kind: "repository", value: repo[1] } : base ? { kind: "base", value: base[1] } : { kind: "missing" });
    ranges.push({ start: at, end: at + match[0].length });
    rest = tail.slice(match[0].length);
  }
}
function pullRequestTargetConflicts(statement, profile, source = statement) {
  const instructions = [...statement.matchAll(PR_INSTRUCTION)].filter(m => !PUBLISH_FEATURE_INFINITIVE.test(statement.slice(0, m.index)));
  if (!instructions.length) return [];
  const targets = [];
  for (const instruction of instructions) {
    const leading = pullRequestQualifiers(statement.slice(0, instruction.index), source.slice(0, instruction.index));
    targets.push(...(/^[\s,]*(?:please\s*)?$/iu.test(leading.rest) ? leading.targets : []), ...pullRequestQualifiers(statement.slice(instruction.index + instruction[0].length), source.slice(instruction.index + instruction[0].length)).targets);
  }
  return requestedTargetConflicts(targets, profile);
}
function requestedTargetConflicts(targets, { base, repository }) {
  const conflicts = [];
  for (const target of targets) {
    if (target.kind === "repository") {
      const requested = target.value.replace(/^(?:https?:\/\/)?github\.com\//iu, "").replace(/\.git$/iu, "").toLowerCase();
      if (requested !== repository?.toLowerCase()) conflicts.push(`repository ${JSON.stringify(requested)} differs from selected repository ${JSON.stringify(repository ?? null)}`);
    } else if (target.kind === "base") {
      if (target.value !== base) conflicts.push(`base ${JSON.stringify(target.value)} differs from selected base ${JSON.stringify(base ?? null)}`);
    } else if (target.kind === "head") conflicts.push(`requested PR head ${JSON.stringify(target.value)} cannot be verified as the managed task branch during preparation`);
    else if (target.kind === "description") conflicts.push("the PR title/body qualifier needs one complete unambiguous quoted value before its target can be checked");
    else if (target.kind === "other") conflicts.push("the clause names a different repository");
    else conflicts.push("the requested PR target is not an unambiguous repository or base");
  }
  return conflicts;
}
// Read command arguments without running a shell. Source and screened text
// have identical offsets: only commands still visible after literal masking
// contribute, while their original quotes keep title/body values atomic.
const PR_CREATE_PRESENT = new RegExp(PR_CREATE_COMMAND.source, "iu");
const PR_VALUE_OPTIONS = new Set(["--assignee", "--attach", "--base", "--body", "--body-file", "--head", "--label", "--milestone", "--project", "--recover", "--repo", "--reviewer", "--template", "--title"]);
// The adapter creates a regular review PR. Draft and simulation
// modes cannot be covered by its action tag; explicit false flags are harmless.
const PR_MODE_OPTIONS = new Set(["--draft", "--dry-run"]);
const PR_SWITCH_OPTIONS = new Set(["--draft", "--dry-run", "--editor", "--fill", "--fill-first", "--fill-verbose", "--help", "--no-maintainer-edit", "--web"]);
const PR_SHORT_OPTIONS = { a: "--assignee", B: "--base", b: "--body", F: "--body-file", H: "--head", l: "--label", m: "--milestone", p: "--project", R: "--repo", r: "--reviewer", T: "--template", t: "--title", d: "--draft", e: "--editor", f: "--fill", h: "--help", w: "--web" };
// Only update-branch extends this screen: parse the whole PR command so read-only
// template values cannot supply that action, while preserving legacy lifecycle rules.
const PR_BRANCH_UPDATE = { command: /\bgh\s+pr\b/giu, writes: new Set(["update-branch"]),
  valueOptions: new Set([...PR_VALUE_OPTIONS, "--json", "--jq", "--limit", "--state", "--search"]),
  shortOptions: { ...PR_SHORT_OPTIONS, q: "--jq", L: "--limit", S: "--search" }, verbs: [], passives: [] };

function commandArguments(source, start, end, { newlines = false } = {}) {
  const args = [];
  let value = "", quote = null, quoted = false, dynamic = false, stopped = end;
  const emit = () => {
    if (!value && !quoted) return true;
    if (!quoted && (/^(?:and|then|after|once|when|before)$/iu.test(value) || (newlines && /^(?:but|however|yet|nevertheless)$/iu.test(value)))) return false;
    args.push({ value, dynamic }); value = ""; quoted = false; dynamic = false;
    return true;
  };
  for (let i = start; i < end; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        value += c;
        if (quote !== "'" && /[$`\\]/u.test(c)) dynamic = true;
        if (c === "\\" && quote !== "'" && i + 1 < end) value += source[++i];
      }
    } else if (c === '"' || c === "'") { quote = c; quoted = true; }
    else if (c === "\\") { dynamic = true; value += c; if (i + 1 < end) value += source[++i]; }
    else if (/[;|&!?]/u.test(c) || (newlines && c === "," && /\s/u.test(source[i + 1] || "")) || (c === "\n" && (!newlines || !(newlines instanceof RegExp ? newlines : /^[ \t]*--?[a-zA-Z]/u).test(source.slice(i + 1)))) || (c === "." && !/[\p{L}\p{N}_/-]/u.test(source[i + 1] || "")) || (c === "#" && !value)) { stopped = i; break; }
    else if (/\s/u.test(c)) { if (!emit()) return { args, end: i }; }
    else { value += c; if (/[$`\\]/u.test(c)) dynamic = true; }
  }
  if (quote) dynamic = true;
  emit();
  return { args, end: stopped };
}
function pullRequestCommandQualifiers(source, visible) {
  if (!PR_CREATE_PRESENT.test(visible)) return [];
  const spans = [...source.matchAll(LITERAL_SPAN)], commands = [...visible.matchAll(PR_CREATE_COMMAND)], targets = [];
  let spanIndex = 0;
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex++) {
    const command = commands[commandIndex];
    if (featureDeliveryPrefix(deliveryPrefix(visible, command.index))) continue;
    while (spanIndex < spans.length && spans[spanIndex].index + spans[spanIndex][0].length <= command.index) spanIndex++;
    const span = spans[spanIndex];
    const end = Math.min(commands[commandIndex + 1]?.index ?? source.length, span && span.index <= command.index ? span.index + span[0].length - 1 : source.length);
    const { args } = commandArguments(source, command.index + command[0].length, end);
    const read = (option, argument) => {
      if (PR_MODE_OPTIONS.has(option) && (!argument || argument.dynamic || !/^(?:false|0|f)$/iu.test(argument.value))) targets.push({ kind: "mode", value: option });
      // The managed head is allocated after approval; preparation cannot prove
      // any explicit head selector belongs to it, including HEAD or a fork ref.
      if (option === "--head") targets.push({ kind: "head", value: argument?.value ?? null });
      if (option === "--base" || option === "--repo") targets.push(!argument?.value || argument.dynamic || argument.value.startsWith("-") ? { kind: "missing" } : { kind: option === "--base" ? "base" : "repository", value: argument.value });
    };
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.value === "--") break;
      if (arg.dynamic) { const option = arg.value.split("=", 1)[0]; if (PR_MODE_OPTIONS.has(option)) read(option, arg); else targets.push({ kind: "missing" }); continue; }
      if (arg.value.startsWith("--")) {
        const equal = arg.value.indexOf("="), option = equal < 0 ? arg.value : arg.value.slice(0, equal);
        if (PR_VALUE_OPTIONS.has(option)) read(option, equal < 0 ? args[++i] : { value: arg.value.slice(equal + 1), dynamic: false });
        else if (PR_MODE_OPTIONS.has(option)) read(option, equal < 0 ? null : { value: arg.value.slice(equal + 1), dynamic: false });
        else if (!PR_SWITCH_OPTIONS.has(option)) targets.push({ kind: "missing" });
      } else if (arg.value.startsWith("-")) {
        for (let j = 1; j < arg.value.length; j++) {
          const option = PR_SHORT_OPTIONS[arg.value[j]];
          if (!option) { targets.push({ kind: "missing" }); break; }
          if (PR_MODE_OPTIONS.has(option)) {
            const assigned = arg.value[j + 1] === "=";
            read(option, assigned ? { value: arg.value.slice(j + 2), dynamic: false } : null);
            if (assigned) break;
          }
          if (PR_VALUE_OPTIONS.has(option)) { read(option, j + 1 < arg.value.length ? { value: arg.value.slice(j + 1).replace(/^=/u, ""), dynamic: false } : args[++i]); break; }
        }
      }
    }
  }
  return targets;
}
export function deliveryScreen(text, { base, repository } = {}) {
  const source = typeof text === "string" ? text : "";
  const publication = publicationCommands(source, maskLiterals(source, { syntax: true }));
  const visible = publication.text;
  const baseWrite = baseWritePattern(base);
  const activeTerms = TERMS.filter(([term, pattern]) => (term === "publish" && publication.writes.length) || termMatches(term, pattern, visible, baseWrite, source, base));
  const terms = activeTerms.map(([term]) => term);
  if (!terms.length) return { terms: [], controlled: [], affirmed: [], escalated: [], controls: [], tier: "none" };
  const controls = [...new Set([...visible.matchAll(CONTROLS)].map(match => match[0].toLowerCase().replace(/\s+/g, " ")))];
  const hasAffirmative = AFFIRMATIVE_PRESENT.test(visible);
  const hasTargetInstruction = terms.includes("pull_request") && PR_INSTRUCTION_PRESENT.test(visible);
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
  const qualifiers = pullRequestCommandQualifiers(source, visible);
  const modeConflicts = qualifiers.filter(q => q.kind === "mode").map(q => `${q.value} does not create a regular review PR`);
  for (const instruction of visible.matchAll(PR_INSTRUCTION)) {
    // Regular PR wording needs no feature-context allocation for this rule.
    // Keep the same context guard when a draft mode is actually present.
    if (!/\bdraft\b/iu.test(instruction[0]) && !PR_DRAFT_QUALIFIER.test(visible.slice(instruction.index + instruction[0].length).trimStart())) continue;
    if (featureDeliveryPrefix(deliveryPrefix(visible, instruction.index))) continue;
    modeConflicts.push("the clause requests a draft PR instead of a regular review PR");
  }
  const controlled = new Set(), affirmed = new Set(), uncontrolled = new Set(), escalated = new Set(terms.filter(term => ESCALATING.has(term))), targetConflicts = requestedTargetConflicts(qualifiers.filter(q => q.kind !== "mode"), { base, repository });
  // Repeated statements contribute the same sets. Cache within this screen
  // only; target-conflict occurrences and whole-request PR counts stay intact.
  const statementTargets = new Map(); let publicationIndex = 0;
  for (const { start, end } of statementRanges(visible)) {
    const statement = visible.slice(start, end), original = source.slice(start, end);
    while (publication.writes[publicationIndex]?.end <= start) publicationIndex++;
    const publishes = publication.writes[publicationIndex]?.start < end;
    // Original quotes matter to command argument boundaries even when screening
    // exposes their content. Distinct quoted arguments cannot share a cache hit.
    const key = statement === original ? statement : JSON.stringify([statement, original]);
    if (statementTargets.has(key)) { targetConflicts.push(...statementTargets.get(key)); continue; }
    const targets = hasTargetInstruction ? pullRequestTargetConflicts(statement, { base, repository }, original) : [];
    statementTargets.set(key, targets);
    targetConflicts.push(...targets);
    if (publishes || (terms.includes("publish") && publishInstruction(statement, original))) escalated.add("publish");
    if (terms.includes("approval") && approvalInstruction(statement)) escalated.add("approval");
    const statementControls = [...statement.matchAll(CONTROLS)];
    const negative = statementControls.some(match => !AFFIRMATIVE_WHOLE.test(match[0]));
    const affirmative = !negative && hasAffirmative && AFFIRMATIVE_PRESENT.test(statement);
    if (negative && reviewProhibited(statement, statementControls)) escalated.add("review");
    for (const [term, pattern] of activeTerms) if ((term === "publish" && publishes) || termMatches(term, pattern, statement, baseWrite, original, base)) (negative ? controlled : affirmative ? affirmed : uncontrolled).add(term);
  }
  if (modeConflicts.length) { terms.push("pull_request_mode"); escalated.add("pull_request_mode"); }
  if (targetConflicts.length) { terms.push("pull_request_target"); escalated.add("pull_request_target"); }
  if (terms.includes("pull_request") && multiplePullRequests(visible)) { terms.push("pull_request_count"); escalated.add("pull_request_count"); }
  // Only a control that shares a statement with a delivery term asks; a
  // control elsewhere on the line ("Authentication is required.") does not.
  const tier = escalated.size || controlled.size || affirmed.size ? "question" : "assumption";
  const externalConflicts = [...(terms.includes("storage_mutation") ? ["outbound or unresolved object-storage transfers are not authorized by the selected delivery profile"] : []), ...(terms.includes("external_communication") ? ["outbound messages are not authorized by the selected delivery profile"] : []), ...(terms.includes("http_mutation") ? ["mutating or unresolved network requests are not authorized by the selected delivery profile"] : [])];
  return { terms, controlled: terms.filter(term => controlled.has(term)), affirmed: terms.filter(term => affirmed.has(term)), uncontrolled: terms.filter(term => uncontrolled.has(term)), escalated: terms.filter(term => escalated.has(term)), controls, tier, ...(targetConflicts.length ? { targetConflicts } : {}), ...(modeConflicts.length ? { modeConflicts } : {}), ...(externalConflicts.length ? { externalConflicts } : {}) };
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

// New IDs fit both the planner and public answer schemas. Preserve a saved,
// question-owned legacy ID while it is answerable, and retain answered IDs for
// provenance. The portable FNV-1a-128 suffix identifies a clause, never grants
// authority; exact requirement ownership is still checked independently.
export function deliveryQuestionId(requirementId, task) {
  const legacy = `${DELIVERY_QUESTION_PREFIX}${requirementId}`;
  const saved = task?.questionHistory?.[legacy], owned = task?.questionMappings?.[legacy];
  if (saved?.id === legacy && saved.requirements?.length === 1 && saved.requirements[0] === requirementId && owned?.length === 1 && owned[0] === requirementId && (legacy.length <= 128 || Object.hasOwn(task.answers || {}, legacy))) return legacy;
  if (legacy.length <= 64) return legacy;
  let digest = 0x6c62272e07bb014262b821756295c58dn;
  for (const byte of new TextEncoder().encode(requirementId)) digest = BigInt.asUintN(128, (digest ^ BigInt(byte)) * 0x1000000000000000000013bn);
  return `${DELIVERY_QUESTION_PREFIX}h-${digest.toString(16).padStart(32, "0")}`;
}
export const isDeliveryQuestion = id => typeof id === "string" && id.startsWith(DELIVERY_QUESTION_PREFIX);
// Question text depends only on the immutable clause and the owner's profile,
// so repeated planner turns reproduce it exactly and resumption can match it.
export function deliveryQuestion(profile, requirement, task) {
  return { id: deliveryQuestionId(requirement.id, task), requirements: [requirement.id],
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
