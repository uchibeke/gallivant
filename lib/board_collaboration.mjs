import { readFileSync } from "node:fs";
import { COLLABORATION_SCHEMA } from "./collaboration_contract.mjs";

const safeCode = error => {
  const code = String(error?.code || error?.status || "board-unavailable").toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : "board-unavailable";
};

const permissionList = value => value === "all" ? ["read", "post", "react", "label", "sync", "manage"] : value === "none" ? [] : Array.isArray(value) ? value : [];

/** The effective Board handle must be no broader than the two configured destinations. */
export function boardAccessRisk(can, config) {
  const allowed = new Set([config.channel, config.needs_owner_channel]);
  const required = new Set(config.policy.permissions || ["read", "post", "label"]);
  const entries = Object.entries(can || {}).filter(([, value]) => permissionList(value).length);
  for (const [pattern, value] of entries) {
    if (!allowed.has(pattern)) return `Board access includes ${pattern}; narrow the adapter handle to only ${[...allowed].join(" and ")} before sending task data`;
    const permissions = permissionList(value);
    const extra = permissions.filter(permission => !required.has(permission));
    if (extra.length) return `Board access for ${pattern} includes ${extra.join(", ")}; allow only ${[...required].join(", ")} before sending task data`;
  }
  for (const channel of allowed) {
    const permissions = new Set(permissionList(can?.[channel]));
    for (const permission of required) if (!permissions.has(permission)) return `Board access for ${channel} is missing ${permission}; grant the narrowed adapter handle ${[...required].join(", ")}`;
  }
  return null;
}

function tokenFetch(token, fetchImpl = globalThis.fetch) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    return fetchImpl(input, { ...init, headers });
  };
}

/** Lazy loader: an unconfigured runtime never imports @vercel/board or resolves a Board credential. */
export function boardClientFor(config, { fetch = globalThis.fetch } = {}) {
  let promise;
  return async () => promise ||= (async () => {
    const sdk = await import("@vercel/board").catch(error => {
      if (error.code === "ERR_MODULE_NOT_FOUND") throw Object.assign(new Error("the optional @vercel/board peer is not installed"), { code: "board-sdk-missing" });
      throw error;
    });
    let customFetch;
    if (config.token_file) {
      const token = readFileSync(config.token_file, "utf8").trim();
      if (!token) throw Object.assign(new Error("the configured Board token file is empty"), { code: "board-credential" });
      customFetch = tokenFetch(token, fetch);
    }
    const handle = sdk.board({ ensure: false, ...(config.board ? { name: config.board } : {}), ...(config.team ? { team: config.team } : {}), ...(customFetch ? { fetch: customFetch } : {}) })
      .as(config.profile, { can: Object.fromEntries([config.channel, config.needs_owner_channel].map(channel => [channel, config.policy.permissions])) });
    return { handle, block: sdk.block };
  })();
}

const messageText = (block, schema, event) => block ? block(schema, event) : `\`\`\`json ${schema}\n${JSON.stringify(event)}\n\`\`\``;
const rootText = event => `Task **${event.task.title}**\n\n[Open task](${event.links.task})`;

const normalizeMessage = (message, eventId = null, event = null) => {
  if (!message || typeof message !== "object") return null;
  const id = String(eventId || message.id || "");
  if (!id) return null;
  const author = event?.actor || message.author || message.actor;
  return {
    id,
    threadId: String(message.re || message.thread_id || message.threadId || message.id || ""),
    text: typeof message.text === "string" ? message.text.slice(0, 2000).replaceAll("\0", "") : "[structured Board content omitted]",
    actor: author && typeof author === "object" ? { id: String(author.id || author.handle || "unknown").slice(0, 128), handle: String(author.handle || "unknown").slice(0, 128), kind: String(author.kind || "unknown").slice(0, 32) } : { id: "unknown", handle: "unknown", kind: "unknown" },
    source: String(message.source || message.from || event?.payload?.from || "board").slice(0, 128),
    at: message.created_at || message.createdAt || event?.createdAt || null,
  };
};

/** Generic CollaborationAdapter implementation backed by the documented Board JS SDK. */
export function createBoardCollaborationAdapter(config, { clientFor = boardClientFor(config), clock = Date } = {}) {
  const client = async () => {
    const loaded = await clientFor();
    return loaded?.handle ? loaded : { handle: loaded, block: null };
  };
  return {
    name: "board",
    async inspectPolicy() {
      try {
        const { handle } = await client();
        const [me, schema] = await Promise.all([handle.me(), handle.schema(config.schema || COLLABORATION_SCHEMA)]);
        const risk = boardAccessRisk(me?.can, config);
        if (risk) return { allow: false, code: "board-access-broader-than-policy", detail: risk };
        const schemaId = schema?.id || (schema?.name && schema?.version ? `${schema.name}@${schema.version}` : null);
        if (schemaId !== (config.schema || COLLABORATION_SCHEMA)) return { allow: false, code: "board-schema-mismatch", detail: `Board schema ${config.schema || COLLABORATION_SCHEMA} is unavailable or has the wrong immutable version` };
        return { allow: true, actor: me?.actor?.id || null, board: me?.board?.name || config.board || "General" };
      } catch (error) {
        return { allow: false, code: safeCode(error), detail: "Board policy could not be verified before task data would be sent" };
      }
    },
    async deliver(thread, event) {
      const { handle, block } = await client();
      let threadId = thread.externalId;
      if (!threadId) {
        const root = await handle.post(config.channel, { text: rootText(event), labels: { source: "gallivant", task: event.task.id, state: "active" }, id: thread.key, noSync: true });
        threadId = root.id;
      }
      const reply = await handle.reply(threadId, { text: messageText(block, config.schema, event), id: event.id, noSync: true });
      let ownerItemId = thread.ownerItemId || null;
      if (event.transition.type === "needs-owner") {
        const item = await handle.post(config.needs_owner_channel, { text: messageText(block, config.schema, event), labels: { source: "gallivant", task: event.task.id, state: "open" }, id: `${event.id}-owner`, noSync: true });
        ownerItemId = item.id;
      } else if (ownerItemId && ["accepted", "started", "resumed", "ready"].includes(event.transition.type)) {
        await handle.label(ownerItemId, { set: { state: "resolved" }, if: { state: "open" } }).catch(error => { if (error?.code !== "label_conflict") throw error; });
      }
      return { threadId, externalId: reply.id, ownerItemId };
    },
    async snapshot({ channel }) {
      const { handle } = await client();
      const page = await handle.threads({ channel, limit: 500 });
      const messages = page.threads.flatMap(thread => [thread.message, thread.last].filter(Boolean)).map(message => normalizeMessage(message)).filter(Boolean);
      return { messages, cursor: page.cursor || null };
    },
    async poll({ channel, cursor }) {
      const { handle } = await client();
      const page = await handle.poll({ channel, after: cursor || undefined, wait: 0, all: true });
      const messages = (page.events || []).filter(event => event.type === "message.posted").map(event => normalizeMessage(event.message, event.cursor, event)).filter(Boolean);
      return { messages, cursor: page.cursor || cursor || null };
    },
    now: () => new Date(clock.now()).toISOString(),
  };
}

/** Setup/doctor preflight. It sends no task data and reports the unresolved policy risk verbatim. */
export async function checkBoardCollaboration(config, options = {}) {
  if (!config) return { ok: true, detail: "collaboration is not configured; Board is not loaded or contacted" };
  const result = await createBoardCollaborationAdapter(config, options).inspectPolicy();
  if (!result.allow) return { ok: false, detail: result.detail, fix: `repair ${result.code}, verify the configured Board grants and immutable ${config.schema} schema, then rerun gallivant doctor before sending task data` };
  return { ok: true, detail: `Board policy verified for ${config.channel} and ${config.needs_owner_channel}; structured transition delivery is enabled` };
}
