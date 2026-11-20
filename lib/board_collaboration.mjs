import { readFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { COLLABORATION_SCHEMA } from "./collaboration_contract.mjs";
import { withCollaborationDeadline } from "./collaboration_deadline.mjs";

const safeCode = error => {
  const code = String(error?.code || error?.status || "board-unavailable").toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(code) ? code : "board-unavailable";
};

const BOARD_PERMISSIONS = ["read", "post", "react", "label", "sync", "manage"];
const permissionList = value => value === "all" ? [...BOARD_PERMISSIONS] : value === "none" ? [] : Array.isArray(value) ? value : [];

// Board expands implied grants in `me().can`; compare both sides using that same closure.
const effectivePermissions = value => {
  const permissions = new Set(permissionList(value));
  if (permissions.has("manage")) for (const permission of BOARD_PERMISSIONS) permissions.add(permission);
  if (["react", "label", "sync"].some(permission => permissions.has(permission))) permissions.add("read");
  return [...permissions];
};

/** The effective Board handle must be no broader than the two configured destinations. */
export function boardAccessRisk(can, config) {
  const allowed = new Set([config.channel, config.needs_owner_channel]);
  const required = new Set(effectivePermissions(config.policy.permissions || ["read", "post", "label"]));
  const entries = Object.entries(can || {}).filter(([, value]) => permissionList(value).length);
  for (const [pattern, value] of entries) {
    if (!allowed.has(pattern)) return `Board access includes ${pattern}; narrow the adapter handle to only ${[...allowed].join(" and ")} before sending task data`;
    const permissions = effectivePermissions(value);
    const extra = permissions.filter(permission => !required.has(permission));
    if (extra.length) return `Board access for ${pattern} includes ${extra.join(", ")}; allow only effective permissions ${[...required].join(", ")} before sending task data`;
  }
  for (const channel of allowed) {
    const permissions = new Set(effectivePermissions(can?.[channel]));
    for (const permission of required) if (!permissions.has(permission)) return `Board access for ${channel} is missing ${permission}; grant the narrowed adapter handle effective permissions ${[...required].join(", ")}`;
  }
  return null;
}

function cancellableFetch(token, signals, fetchImpl = globalThis.fetch) {
  return (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("authorization", `Bearer ${token}`);
    const operationSignal = signals.getStore();
    const signal = operationSignal && init.signal ? AbortSignal.any([operationSignal, init.signal]) : operationSignal || init.signal;
    return fetchImpl(input, { ...init, headers, ...(signal ? { signal } : {}) });
  };
}

/** Lazy loader: an unconfigured runtime never imports @vercel/board or resolves a Board credential. */
export function boardClientFor(config, { fetch = globalThis.fetch } = {}) {
  let promise;
  const signals = new AsyncLocalStorage();
  return async () => promise ||= (async () => {
    const sdk = await import("@vercel/board").catch(error => {
      if (error.code === "ERR_MODULE_NOT_FOUND") throw Object.assign(new Error("the optional @vercel/board peer is not installed"), { code: "board-sdk-missing" });
      throw error;
    });
    let token = null;
    if (config.token_file) {
      token = readFileSync(config.token_file, "utf8").trim();
      if (!token) throw Object.assign(new Error("the configured Board token file is empty"), { code: "board-credential" });
    }
    const handle = sdk.board({ ensure: false, ...(config.board ? { name: config.board } : {}), ...(config.team ? { team: config.team } : {}), fetch: cancellableFetch(token, signals, fetch) })
      .as(config.profile, { can: Object.fromEntries([config.channel, config.needs_owner_channel].map(channel => [channel, config.policy.permissions])) });
    return { handle, block: sdk.block, withSignal: (signal, operation) => signals.run(signal, operation) };
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
  const client = async signal => {
    signal?.throwIfAborted();
    const loaded = await clientFor();
    signal?.throwIfAborted();
    const result = loaded?.handle ? loaded : { handle: loaded, block: null };
    if (!signal || typeof result.withSignal !== "function") return result;
    const handle = new Proxy(result.handle, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (...args) => result.withSignal(signal, () => value.apply(target, args)) : value;
      },
    });
    return { ...result, handle };
  };
  return {
    name: "board",
    async inspectPolicy({ signal } = {}) {
      try {
        const { handle } = await client(signal);
        const [me, schema] = await Promise.all([handle.me(), handle.schema(config.schema || COLLABORATION_SCHEMA)]);
        signal?.throwIfAborted();
        const risk = boardAccessRisk(me?.can, config);
        if (risk) return { allow: false, code: "board-access-broader-than-policy", detail: risk };
        const schemaId = schema?.id || (schema?.name && schema?.version ? `${schema.name}@${schema.version}` : null);
        if (schemaId !== (config.schema || COLLABORATION_SCHEMA)) return { allow: false, code: "board-schema-mismatch", detail: `Board schema ${config.schema || COLLABORATION_SCHEMA} is unavailable or has the wrong immutable version` };
        return { allow: true, actor: me?.actor?.id || null, board: me?.board?.name || config.board || "General" };
      } catch (error) {
        return { allow: false, code: safeCode(error), detail: "Board policy could not be verified before task data would be sent" };
      }
    },
    async deliver(thread, event, { signal } = {}) {
      const { handle, block } = await client(signal);
      let threadId = thread.externalId;
      if (!threadId) {
        const root = await handle.post(config.channel, { text: rootText(event), labels: { source: "gallivant", task: event.task.id, state: "active" }, id: thread.key, noSync: true });
        signal?.throwIfAborted();
        threadId = root.id;
      }
      const reply = await handle.reply(threadId, { text: messageText(block, config.schema, event), id: event.id, noSync: true });
      signal?.throwIfAborted();
      let ownerItemId = thread.ownerItemId || null;
      if (event.transition.type === "needs-owner") {
        const item = await handle.post(config.needs_owner_channel, { text: messageText(block, config.schema, event), labels: { source: "gallivant", task: event.task.id, state: "open" }, id: `${event.id}-owner`, noSync: true });
        signal?.throwIfAborted();
        ownerItemId = item.id;
      } else if (ownerItemId && ["accepted", "started", "resumed", "ready", "completed"].includes(event.transition.type)) {
        await handle.label(ownerItemId, { set: { state: "resolved" }, if: { state: "open" } }).catch(error => { if (error?.code !== "label_conflict") throw error; });
        signal?.throwIfAborted();
      }
      return { threadId, externalId: reply.id, ownerItemId };
    },
    async snapshot({ channel }, { signal } = {}) {
      const { handle } = await client(signal);
      const page = await handle.threads({ channel, limit: 500 });
      signal?.throwIfAborted();
      const messages = [], seen = new Set();
      const append = message => {
        const normalized = normalizeMessage(message);
        if (!normalized || seen.has(normalized.id)) return null;
        seen.add(normalized.id);
        messages.push(normalized);
        return normalized.id;
      };
      for (const summary of page.threads || []) {
        signal?.throwIfAborted();
        const rootId = append(summary.message);
        const expected = Number.isInteger(summary.replies) && summary.replies >= 0 ? summary.replies : null;
        if (!rootId || expected === 0) continue;
        const replyIds = new Set();
        // Without `after`, Board returns the newest replies. Start after the root
        // so pagination walks the complete thread from its first reply forward.
        let after = rootId;
        for (;;) {
          const range = { limit: 500, after };
          const thread = await handle.thread(rootId, range);
          signal?.throwIfAborted();
          const replies = Array.isArray(thread?.replies) ? thread.replies : [];
          for (const reply of replies) {
            const id = append(reply);
            if (id && id !== rootId) replyIds.add(id);
          }
          if (expected !== null && replyIds.size >= expected) break;
          // A thread cursor is the board position reflected by the read, not the
          // reply boundary. Continue after the last message the page returned.
          const next = replies.at(-1)?.id || null;
          if (!next || next === after || replies.length === 0) {
            if (expected !== null && replyIds.size < expected) {
              throw Object.assign(new Error("Board thread snapshot ended before all summarized replies were read"), { code: "board-snapshot-incomplete" });
            }
            break;
          }
          after = next;
        }
      }
      return { messages, cursor: page.cursor || null };
    },
    async poll({ channel, cursor }, { signal } = {}) {
      const { handle } = await client(signal);
      const page = await handle.poll({ channel, after: cursor || undefined, wait: 0, all: true }, signal);
      signal?.throwIfAborted();
      const messages = (page.events || []).filter(event => event.type === "message.posted").map(event => normalizeMessage(event.message, event.cursor, event)).filter(Boolean);
      return { messages, cursor: page.cursor || cursor || null };
    },
    now: () => new Date(clock.now()).toISOString(),
  };
}

/** Setup/doctor preflight. It sends no task data and reports the unresolved policy risk verbatim. */
export async function checkBoardCollaboration(config, options = {}) {
  if (!config) return { ok: true, detail: "collaboration is not configured; Board is not loaded or contacted" };
  let result;
  try {
    const adapter = createBoardCollaborationAdapter(config, options);
    result = await withCollaborationDeadline(config, signal => adapter.inspectPolicy({ signal }));
  } catch (error) {
    result = { allow: false, code: safeCode(error), detail: "Board policy could not be verified within the configured deadline" };
  }
  if (!result.allow) return { ok: false, detail: result.detail, fix: `repair ${result.code}, verify the configured Board grants and immutable ${config.schema} schema, then rerun gallivant doctor before sending task data` };
  return { ok: true, detail: `Board policy verified for ${config.channel} and ${config.needs_owner_channel}; structured transition delivery is enabled` };
}
