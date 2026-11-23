export const COLLABORATION_EVENT_VERSION = 1;
export const COLLABORATION_SCHEMA = "gallivant-task-transition@1";

// Register this exact immutable schema in Board before enabling the adapter. Keeping the
// wire contract beside the router makes it reviewable without loading the optional SDK.
export const COLLABORATION_EVENT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["schema", "version", "id", "idempotency_key", "task", "transition", "provenance", "links"],
  properties: {
    schema: { const: "gallivant.task-transition" },
    version: { const: COLLABORATION_EVENT_VERSION },
    id: { type: "string", minLength: 42, maxLength: 42 },
    idempotency_key: { type: "string", maxLength: 512 },
    task: {
      type: "object", additionalProperties: false, required: ["id", "run_id", "title"],
      properties: { id: { type: "string", maxLength: 256 }, run_id: { type: ["string", "null"], maxLength: 256 }, title: { type: "string", maxLength: 128 } },
    },
    transition: {
      type: "object", additionalProperties: false, required: ["type", "state", "occurred_at"],
      properties: {
        type: { enum: ["accepted", "started", "pr-opened", "needs-owner", "stopped", "resumed", "ready", "completed"] },
        state: { type: "string", maxLength: 64 }, occurred_at: { type: ["string", "null"] },
        reason: { type: "string", maxLength: 96 }, requested_decision: { type: "string", maxLength: 240 },
        expires_at: { type: "string", format: "date-time" },
      },
    },
    provenance: {
      type: "object", additionalProperties: false, required: ["actor", "source"],
      properties: {
        actor: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", maxLength: 32 }, id: { type: "string", maxLength: 128 } } },
        source: { type: "object", additionalProperties: false, required: ["type", "id"], properties: { type: { type: "string", maxLength: 32 }, id: { type: "string", maxLength: 128 } } },
      },
    },
    links: {
      type: "object", additionalProperties: false, required: ["task"],
      properties: { task: { type: "string", format: "uri", maxLength: 2048 }, pull_request: { type: "string", format: "uri", maxLength: 2048 } },
    },
  },
});

export const COLLABORATION_TRANSITIONS = Object.freeze([
  "accepted",
  "started",
  "pr-opened",
  "needs-owner",
  "stopped",
  "resumed",
  "ready",
  "completed",
]);

const TRANSITIONS = new Set(COLLABORATION_TRANSITIONS);
const PERMISSIONS = new Set(["read", "post", "label"]);

const urlProblem = (value, name) => {
  if (typeof value !== "string" || !value) return `${name} must be an absolute http(s) URL`;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return `${name} must be an absolute http(s) URL without credentials, a query, or a fragment`;
  } catch { return `${name} must be an absolute http(s) URL`; }
  return null;
};

/** Validate only the optional collaboration block. Null preserves the predecessor configuration exactly. */
export function collaborationConfigProblems(value) {
  if (value == null) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["collaboration must be an object or null"];
  const problems = [];
  const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
  if (nodeMajor < 22 || nodeMajor === 22 && nodeMinor < 18) problems.push("collaboration requires Node.js 22.18 or newer for the Board SDK");
  if (value.adapter !== "board") problems.push('collaboration.adapter must be "board"');
  for (const name of ["channel", "needs_owner_channel", "profile"]) {
    if (typeof value[name] !== "string" || !value[name].trim()) problems.push(`collaboration.${name} must be a non-empty string`);
  }
  if (value.channel && value.channel === value.needs_owner_channel) problems.push("collaboration.needs_owner_channel must differ from collaboration.channel so owner decisions have a dedicated queue");
  if (value.profile && !/^[a-z][a-z0-9_-]{0,31}$/.test(value.profile)) problems.push("collaboration.profile must start with a lowercase letter and contain at most 32 lowercase letters, numbers, hyphens, or underscores");
  const linkProblem = urlProblem(value.link_base_url, "collaboration.link_base_url");
  if (linkProblem) problems.push(linkProblem);
  if (value.token_file != null && (typeof value.token_file !== "string" || !value.token_file.trim())) problems.push("collaboration.token_file must be a non-empty path or null");
  if (value.board != null && (typeof value.board !== "string" || !value.board.trim() || value.board.length > 64 || value.board.includes("/"))) problems.push("collaboration.board must be a Board name of 1 to 64 characters without '/' or null");
  if (value.team != null && (typeof value.team !== "string" || !value.team.trim())) problems.push("collaboration.team must be a non-empty team ID or slug or null");
  if (value.schema != null && value.schema !== COLLABORATION_SCHEMA) problems.push(`collaboration.schema must be ${COLLABORATION_SCHEMA}`);
  if (value.significant_events != null && (!Array.isArray(value.significant_events) || value.significant_events.some(name => !TRANSITIONS.has(name)))) problems.push(`collaboration.significant_events must contain only ${COLLABORATION_TRANSITIONS.join(", ")}`);
  if (value.owner_decision_hours != null && (!Number.isInteger(value.owner_decision_hours) || value.owner_decision_hours < 1 || value.owner_decision_hours > 720)) problems.push("collaboration.owner_decision_hours must be an integer from 1 to 720");
  const retry = value.retry;
  if (retry != null && (!retry || typeof retry !== "object" || Array.isArray(retry))) problems.push("collaboration.retry must be an object");
  else if (retry) {
    if (retry.max_attempts != null && (!Number.isInteger(retry.max_attempts) || retry.max_attempts < 1 || retry.max_attempts > 10)) problems.push("collaboration.retry.max_attempts must be an integer from 1 to 10");
    if (retry.base_seconds != null && (!Number.isInteger(retry.base_seconds) || retry.base_seconds < 1 || retry.base_seconds > 3600)) problems.push("collaboration.retry.base_seconds must be an integer from 1 to 3600");
    if (retry.max_seconds != null && (!Number.isInteger(retry.max_seconds) || retry.max_seconds < 1 || retry.max_seconds > 86400)) problems.push("collaboration.retry.max_seconds must be an integer from 1 to 86400");
    if (retry.timeout_seconds != null && (!Number.isInteger(retry.timeout_seconds) || retry.timeout_seconds < 1 || retry.timeout_seconds > 300)) problems.push("collaboration.retry.timeout_seconds must be an integer from 1 to 300");
  }
  const inbound = value.inbound;
  if (inbound != null && (!inbound || typeof inbound !== "object" || Array.isArray(inbound))) problems.push("collaboration.inbound must be an object");
  else if (inbound) {
    if (typeof inbound.enabled !== "boolean") problems.push("collaboration.inbound.enabled must be true or false");
    if (inbound.channel != null && (typeof inbound.channel !== "string" || !inbound.channel.trim())) problems.push("collaboration.inbound.channel must be a non-empty channel or null");
  }
  const policy = value.policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) problems.push("collaboration.policy must explicitly accept or restrict Board access and retention");
  else {
    if (policy.allow_us_storage !== true) problems.push("collaboration.policy.allow_us_storage must be true because Board stores task data in the United States and has no region setting");
    if (policy.allow_board_managed_retention !== true) problems.push("collaboration.policy.allow_board_managed_retention must be true because Board does not expose a task-bounded retention period");
    if (policy.max_retention_days != null) problems.push("collaboration.policy.max_retention_days cannot be guaranteed by Board; remove it only after accepting Board-managed retention, or keep collaboration disabled");
    if (inbound?.enabled === true && policy.allow_inbound_suggestions !== true) problems.push("collaboration.policy.allow_inbound_suggestions must be true before inbound suggestion collection is enabled");
    if (policy.permissions != null && (!Array.isArray(policy.permissions) || policy.permissions.some(permission => !PERMISSIONS.has(permission)))) problems.push("collaboration.policy.permissions may contain only read, post, and label");
    else if (policy.permissions && !["post", "label", ...(inbound?.enabled ? ["read"] : [])].every(permission => policy.permissions.includes(permission))) problems.push(`collaboration.policy.permissions must include post and label${inbound?.enabled ? ", plus read while inbound suggestions are enabled" : ""}`);
    else if (policy.permissions?.includes("read") && inbound?.enabled !== true) problems.push("collaboration.policy.permissions may include read only while inbound suggestions are enabled");
  }
  return problems;
}

export function collaborationSettings(value) {
  if (value == null) return null;
  const inbound = { enabled: false, channel: value.channel, ...(value.inbound || {}) };
  return {
    ...value,
    schema: value.schema || COLLABORATION_SCHEMA,
    significant_events: value.significant_events || [...COLLABORATION_TRANSITIONS],
    owner_decision_hours: value.owner_decision_hours ?? 72,
    inbound,
    policy: { permissions: [...(inbound.enabled ? ["read"] : []), "post", "label"], ...(value.policy || {}) },
    retry: { max_attempts: 5, base_seconds: 30, max_seconds: 3600, timeout_seconds: 10, ...(value.retry || {}) },
  };
}
