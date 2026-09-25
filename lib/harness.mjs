// Harness adapters. Each one knows four things about its CLI: how to start a session, how to resume one, where the
// session id comes from, and how to read the outcome of a run from its JSONL output. Flags live here, not in config,
// so an operator never has to know them and an upgrade changes one file.
//
// Verified against Claude Code 2.1.263 and Codex 0.155.1 on 2026-09-23. `codex exec` has no --full-auto on this
// version; the config overrides below are the working form for both `exec` and `exec resume`.
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const MIN_VERSIONS = { claude: "2.1.263", codex: "0.155.1" };

const CODEX_OVERRIDES = [
  "-c", 'approval_policy="never"',
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=true",
  "--skip-git-repo-check",
];

const claudeCommon = ({ budget, settings }) => [
  "-p", "--permission-mode", "auto", "--permission-prompts", "none",
  "--max-budget-usd", String(budget), "--settings", settings,
  "--output-format", "stream-json", "--verbose",
];

/** Last non-empty parsed JSONL line matching `pred`, scanning from the end. */
const findLast = (lines, pred) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const ev = parse(lines[i]);
    if (ev && pred(ev)) return ev;
  }
  return null;
};
const parse = l => { try { return JSON.parse(l); } catch { return null; } };
const events = lines => lines.map(parse).filter(Boolean);

export const adapters = {
  claude: {
    name: "claude",
    newSession: () => randomUUID(),
    start: ({ session, prompt, budget, settings }) => ["--session-id", session, ...claudeCommon({ budget, settings }), prompt],
    resume: ({ session, prompt, budget, settings }) => ["--resume", session, ...claudeCommon({ budget, settings }), prompt],
    env: ({ configDir }) => (configDir ? { APORT_CLAUDE_CODE_CONFIG_DIR: configDir } : {}),
    sessionFrom: lines => findLast(lines, ev => ev.type === "system" && ev.subtype === "init")?.session_id ?? null,
    outcome(lines) {
      const result = findLast(lines, ev => ev.type === "result");
      const lastText = findLast(lines, ev => ev.type === "assistant")?.message?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? null;
      if (!result) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no result event" };
      return {
        ok: !result.is_error,
        finished: true,
        lastMessage: typeof result.result === "string" ? result.result : lastText,
        denials: (result.permission_denials || []).map(d => `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 200)}`),
        cost: result.total_cost_usd ?? null,
        error: result.is_error ? (result.result || result.subtype || "error") : null,
      };
    },
    signIn: { args: ["auth", "status"], ok: (code, out) => code === 0 && /"loggedIn":\s*true/.test(out) },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    attach: ({ session }) => `claude --resume ${session}`,
  },
  codex: {
    name: "codex",
    newSession: () => null,
    start: ({ prompt }) => ["exec", "--json", ...CODEX_OVERRIDES, prompt],
    resume: ({ session, prompt }) => ["exec", "resume", session, "--json", ...CODEX_OVERRIDES, prompt],
    env: () => ({}),
    sessionFrom: lines => events(lines).find(ev => ev.type === "thread.started")?.thread_id ?? null,
    outcome(lines) {
      const evs = events(lines);
      const failed = evs.findLast(ev => ev.type === "turn.failed" || ev.type === "error");
      const completed = evs.findLast(ev => ev.type === "turn.completed");
      const lastText = evs.findLast(ev => ev.type === "item.completed" && ev.item?.type === "agent_message")?.item?.text ?? null;
      if (!completed && !failed) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no turn.completed event" };
      return { ok: !failed, finished: true, lastMessage: lastText, denials: [], cost: null, error: failed ? (failed.error?.message || failed.message || "turn failed") : null };
    },
    signIn: { args: ["login", "status"], ok: code => code === 0 },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    attach: ({ session }) => `codex resume ${session}`,
  },
};

export const adapterFor = name => {
  const a = adapters[name];
  if (!a) throw new Error(`unknown harness "${name}"; known: ${Object.keys(adapters).join(", ")}`);
  return a;
};

/** Refuse any argv that switches a harness's own safety off. The daemon never needs these. */
export function assertSafeArgv(args) {
  const bad = args.find(a => /^--dangerously-/.test(String(a)));
  if (bad) throw new Error(`refusing to run with ${bad}`);
  return args;
}

/**
 * Everything needed to spawn one run: { cmd, args, env }. `mode` is "start" or "resume".
 * Prompts are passed as the final argv element; both CLIs accept that and it keeps stdin free.
 */
export function buildRun({ harness, config, mode, session, prompt, cwd }) {
  const a = adapterFor(harness);
  const h = config.harness[harness];
  if (!h?.bin) throw new Error(`harness.${harness}.bin is not configured`);
  const ctx = { session, prompt, budget: config.max_budget_usd, settings: h.settings, cwd };
  const args = assertSafeArgv(mode === "start" ? a.start(ctx) : a.resume(ctx));
  const env = { ...a.env({ configDir: h.settings ? dirname(h.settings) : null }) };
  return { cmd: h.bin, args, env };
}

export const compareVersions = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};
