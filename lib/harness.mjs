// Harness adapters. Each one knows four things about its CLI: how to start a session, how to resume one, where the
// session id comes from, and how to read the outcome of a run from its JSONL output. Flags live here, not in config,
// so an operator never has to know them and an upgrade changes one file.
//
// Argument/session contracts checked against Claude Code 2.1.263 and Codex 0.158.0. Codex config overrides work for both `exec` and
// `exec resume`, whose flags differ. The gemini, opencode
// and goose session contracts were checked on 2026-09-25 against 0.59.0, 1.18.31 and 1.50.1.
// Coding/push evidence and current blocks are separate: docs/audit/harness-live-validation.md.
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export const MIN_VERSIONS = { claude: "2.1.263", codex: "0.158.0", gemini: "0.59.0", opencode: "1.18.31", goose: "1.50.1" };

// workspace-write protects .git too: add, commit and push's local tracking updates need approval. `never`
// stranded real runs at index.lock and .git/config; saved allow rules only hid the problem for some commands.
// Keep the sandbox and route escalations to Codex's reviewer, so headless runs need no operator click.
const CODEX_OVERRIDES = [
  "-c", 'approval_policy="on-request"',
  "-c", 'approvals_reviewer="auto_review"',
  "-c", 'sandbox_mode="workspace-write"',
  "-c", "sandbox_workspace_write.network_access=true",
  "--skip-git-repo-check",
];

// stream-json is real JSONL on both: gemini emits init/message/result, goose emits message/complete. Neither has
// a spend cap flag, so the wall-clock timeout is what bounds them, as with codex.
const GEMINI_COMMON = ["--output-format", "stream-json", "-p"];
const GOOSE_COMMON = ["--output-format", "stream-json"];

const claudeCommon = ({ budget, settings }) => [
  "-p", "--permission-mode", "auto", "--permission-prompts", "none",
  "--max-budget-usd", String(budget), "--settings", settings,
  "--output-format", "stream-json", "--verbose",
];

/** The shape claude, codex and gemini all spell a session id with. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * Why each denied call was denied, keyed by the tool_use_id that names the call.
 *
 * `result.permission_denials` says WHAT was denied (tool name and the whole input) and never says why. The reason is
 * written somewhere else in the same stream: the hook denies, Claude turns the denial into the tool's result, and that
 * `tool_result` carries the guardrail's own sentence. Both halves carry the same `tool_use_id`, so they join exactly
 * and need no timestamp guessing.
 *
 * This is the whole fix for a run where APort blocked `grep -n ... web/src/lib/products.config.ts` on the pattern
 * "Access to sensitive configuration files". The audit line names the pattern and not the path; the denial list names
 * the path and not the pattern. An operator reading either one alone cannot tell a correct block from a broad one
 * catching a legitimate read of a project source file, which is what that one was.
 */
const denialReasons = lines => {
  const by = new Map();
  for (const ev of events(lines)) {
    if (ev.type !== "user") continue;
    for (const b of ev.message?.content || []) {
      if (b?.type !== "tool_result" || !b.is_error || !b.tool_use_id) continue;
      const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map(c => (typeof c === "string" ? c : c?.text || "")).join(" ") : "";
      // Only a guardrail refusal, never an ordinary tool error: a failing command's stderr is not a reason a call was
      // denied, and putting it on a denial line would say the guardrail said something it did not.
      const blocked = (ev.tool_result_meta || []).some(m => m?.non_execution_kind === "permission-rule") || /^APort denied\b/.test(text.trim());
      if (blocked && text.trim()) by.set(String(b.tool_use_id), text.trim().replace(/\s+/g, " ").slice(0, 300));
    }
  }
  return by;
};

// What an adapter has to do, and who is in. The loop cannot work without four things: start a run
// non-interactively, resume THAT session by id (not "the latest"), emit a machine-readable stream the run's
// outcome can be read from, and report its own session id so the PR body can carry it.
//
// Five harnesses meet that contract and are implemented below. Each round-trip was run on this machine on
// 2026-09-25 the same way: write a number in one process, resume that session id in a second process, assert the
// number came back. The versions seen were Gemini CLI 0.59.0, opencode 1.18.31 and goose 1.50.1.
//
//   cursor-agent  NOT ADDED, and the blocker is a login, not a missing capability. It has every flag this needs:
//                 `--print --output-format stream-json`, `--resume <chatId>`, and `create-chat` prints a UUID to
//                 pre-assign. It is simply not signed in here: a headless run draws the interactive "Press any key
//                 to sign in" screen and exits non-zero, so the event stream could not be observed. Adding it would
//                 mean guessing the shape of a stream nobody has seen. Sign in, capture one run, then write it.
//
// Adding one is a new entry in this object and its own tests: `HARNESSES` is the keys of this object, so there is no
// second list to keep in step. Nothing else names a harness. `signIn.fix` is the command the operator runs when the
// check fails, kept beside the check rather than in `doctor`, which used to tell three of these to run `codex login`.
export const adapters = {
  claude: {
    name: "claude",
    preparationEnv: ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"],
    newSession: () => randomUUID(),
    // `--session-id` takes a UUID and claude refuses anything else, so that is exactly what a block may carry.
    isSession: s => UUID.test(s),
    start: ({ session, prompt, budget, settings }) => ["--session-id", session, ...claudeCommon({ budget, settings }), prompt],
    resume: ({ session, prompt, budget, settings }) => ["--resume", session, ...claudeCommon({ budget, settings }), prompt],
    env: ({ configDir }) => (configDir ? { APORT_CLAUDE_CODE_CONFIG_DIR: configDir } : {}),
    sessionFrom: lines => findLast(lines, ev => ev.type === "system" && ev.subtype === "init")?.session_id ?? null,
    outcome(lines) {
      const result = findLast(lines, ev => ev.type === "result");
      const lastText = findLast(lines, ev => ev.type === "assistant")?.message?.content?.filter(c => c.type === "text").map(c => c.text).join("\n") ?? null;
      if (!result) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no result event" };
      const reasons = denialReasons(lines);
      return {
        ok: !result.is_error,
        finished: true,
        lastMessage: typeof result.result === "string" ? result.result : lastText,
        // The reason is appended rather than replacing anything, so a denial whose reason is not in the stream reads
        // exactly as it did before and nothing about the line pretends to know more than the log recorded.
        denials: (result.permission_denials || []).map(d => {
          const why = d.tool_use_id ? reasons.get(String(d.tool_use_id)) : null;
          return `${d.tool_name}: ${JSON.stringify(d.tool_input).slice(0, 200)}${why ? `\n    ${why}` : ""}`;
        }),
        cost: result.total_cost_usd ?? null,
        error: result.is_error ? (result.result || result.subtype || "error") : null,
      };
    },
    signIn: { args: ["auth", "status"], ok: (code, out) => code === 0 && /"loggedIn":\s*true/.test(out), fix: "claude auth login" },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    // --add-dir grants tool access to a directory; it does not widen what may be written, because writes stay
    // inside the sandbox declared in the Gallivant settings file that --settings points at.
    context: { render: paths => paths.flatMap(p => ["--add-dir", p]) },
    attach: ({ session }) => `claude --resume ${session}`,
  },
  codex: {
    name: "codex",
    preparationEnv: ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "CODEX_API_KEY", "CODEX_CA_CERTIFICATE"],
    newSession: () => null,
    // Thread ids read off `thread.started` are UUIDs.
    isSession: s => UUID.test(s),
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
    signIn: { args: ["login", "status"], ok: code => code === 0, fix: "codex login" },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    // Codex cannot grant read on ONE directory. Checked against 0.157.0 on 2026-09-25:
    //   --add-dir <DIR>   its own help calls these "Additional directories that should be WRITABLE alongside the
    //                     primary workspace". Write, not read.
    //   -c sandbox_permissions=["disk-full-read-access"]   the only value the help documents, and it is the whole
    //                     disk. A per-path spelling (disk-read-access=/x) parses and is then dropped: the run
    //                     prints "ignoring 1 unrecognized configuration setting" and reads nothing extra.
    //   -c sandbox_workspace_write.readable_roots=[...]   reported as ignored by name in that same warning.
    // Full disk read to get one directory is a wider grant than the operator asked for, and ignoring the setting
    // would leave them believing a run can read something it cannot. So the run is refused instead.
    context: { refuse: "Codex has no per-directory read grant: --add-dir makes a directory writable, and the only read permission it documents is disk-full-read-access, the whole disk. Drop context_paths for this brief, or give it to a harness that can (claude)." },
    attach: ({ session }) => `codex resume ${session}`,
  },
  // Gemini CLI. `--skip-trust` is mandatory for a daemon: without it a headless run in an untrusted directory
  // refuses with "not running in a trusted directory" and the run is wasted. GEMINI_CLI_TRUST_WORKSPACE=true is
  // the env equivalent; the flag is passed as well so the argv alone is enough to reproduce a run by hand.
  //
  // On --resume: the help text says it takes "latest" or an index number. That is incomplete. A session UUID
  // works, and it is the only form that resumes a SPECIFIC session, which is the whole contract here. Verified by
  // round-trip: a number written under a generated UUID in one process came back when a second process resumed
  // that id. Do not "fix" this to an index; an index is relative to the session list and moves under the daemon.
  gemini: {
    name: "gemini",
    preparationEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GEMINI_MODEL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS"],
    newSession: () => randomUUID(),
    isSession: s => UUID.test(s),
    start: ({ session, prompt }) => ["--skip-trust", "--session-id", session, ...GEMINI_COMMON, prompt],
    resume: ({ session, prompt }) => ["--skip-trust", "--resume", session, ...GEMINI_COMMON, prompt],
    env: () => ({ GEMINI_CLI_TRUST_WORKSPACE: "true" }),
    sessionFrom: lines => findLast(lines, ev => ev.type === "init")?.session_id ?? null,
    outcome(lines) {
      const result = findLast(lines, ev => ev.type === "result");
      const lastText = findLast(lines, ev => ev.type === "message" && ev.role === "assistant")?.content ?? null;
      if (!result) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no result event" };
      const ok = result.status === "success";
      return { ok, finished: true, lastMessage: lastText, denials: [], cost: null, error: ok ? null : (result.error?.message || result.status || "error") };
    },
    // Gemini CLI has no `auth status` subcommand: credentials come from a stored OAuth login or GEMINI_API_KEY
    // and there is no command that reports on them without spending a call. So this only proves the binary runs.
    // A run that is not authenticated fails on its first model call and shows up as a failed run, not as a
    // failed probe. That is weaker than claude's or codex's sign-in check; `doctor` cannot pre-empt it.
    signIn: { args: ["--version"], ok: code => code === 0, fix: "gemini, then /auth, or set GEMINI_API_KEY" },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    // --include-directories looks like the flag and is not. It adds a directory to the WORKSPACE, and Gemini's
    // own file-system tool reference says every file tool, write_file included, operates within the workspace
    // root. The flag grants write as well as read, which is the one thing this setting must not do, and there is
    // no read-only spelling. Refuse rather than escalate.
    context: { refuse: "Gemini CLI has no read-only directory flag: --include-directories adds to the workspace, which is its write boundary as well as its read boundary. Drop context_paths for this brief, or give it to a harness that can (claude)." },
    attach: ({ session }) => `gemini --resume ${session}`,
  },
  // opencode. `run` is the headless form and `-s <id>` continues a named session.
  //
  // A session id cannot be pre-assigned: ids look like `ses_f25fcd907ffesl1i92jsR2lh9I`, they are minted by the
  // server, and `opencode session` offers only `list` and `delete`, no `create`. So newSession() returns null and
  // the id is read back off the run, exactly as codex does. Every JSONL line carries `sessionID`, so the first
  // line is enough.
  //
  // The earlier note that this was "gated on an APort target" no longer blocks anything: opencode run is plain
  // stdout JSONL and the gate the daemon applies is its own deliverable check, which does not care which CLI
  // produced the run. Nothing in the APort hook path is opencode-specific.
  opencode: {
    name: "opencode",
    preparationEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT"],
    newSession: () => null,
    // Server-minted, and they look like `ses_f25fcd907ffesl1i92jsR2lh9I`: the prefix plus a case-sensitive token.
    isSession: s => /^ses_[A-Za-z0-9]{8,64}$/.test(s),
    start: ({ prompt }) => ["run", "--format", "json", prompt],
    resume: ({ session, prompt }) => ["run", "--session", session, "--format", "json", prompt],
    env: () => ({}),
    sessionFrom: lines => events(lines).find(ev => ev.sessionID)?.sessionID ?? null,
    outcome(lines) {
      const evs = events(lines);
      const finish = evs.findLast(ev => ev.type === "step_finish");
      const steps = evs.filter(ev => ev.type === "step_finish");
      const errored = evs.findLast(ev => ev.type === "error");
      const lastText = evs.findLast(ev => ev.type === "text")?.part?.text ?? null;
      if (!finish && !errored) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no step_finish event" };
      // `reason` is "stop" on a clean turn; anything else (an aborted or length-capped turn) is not a success.
      const reason = finish?.part?.reason ?? null;
      const ok = !errored && reason === "stop";
      return {
        ok, finished: true, lastMessage: lastText, denials: [],
        // Cost belongs to each step, not just the final answer. A coding turn can have many tool steps.
        // Missing step costs mean an unknown total; a provider-reported zero remains a real zero.
        cost: steps.length && steps.every(ev => typeof ev.part?.cost === "number" && Number.isFinite(ev.part.cost))
          ? steps.reduce((total, ev) => total + ev.part.cost, 0) : null,
        error: ok ? null : (errored?.error?.message || errored?.message || (reason ? `turn ended with reason "${reason}"` : "turn failed")),
      };
    },
    // `auth list` prints the stored credentials and ends with "N credentials"; zero of them means no provider is
    // configured and every run would fail at the first model call.
    signIn: { args: ["auth", "list"], ok: (code, out) => code === 0 && !/\b0 credentials\b/.test(out) && /credential/i.test(out), fix: "opencode auth login" },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    // No flag adds a second directory: `--dir` moves the working directory, it does not add to it. opencode is
    // not sandboxed by Gallivant either, so there is nothing to widen and nothing to refuse. The setting has no
    // effect here, and `doctor` says so rather than leaving the operator to guess.
    context: null,
    attach: ({ session }) => `opencode run -s ${session}`,
  },
  // goose. Two flags look like they name a session and only one of them does both halves of the job:
  // `--session-id <id>` is resume-only and refuses with "--session-id can only be used with --resume flag", so it
  // cannot create the session the daemon will later come back to. `-n/--name <NAME>` names a new session AND,
  // with `-r/--resume`, resumes that specific one. So the adapter uses -n for both and never uses --session-id.
  // Verified by round-trip against a generated name. Resuming a name that does not exist prints "No session found
  // with name ..." and exits non-zero, which `outcome` reports as unfinished rather than as a silent success.
  //
  // The name is a session id here, so it has to be safe as a filename: goose derives the session file from it.
  goose: {
    name: "goose",
    // Authentication is selected only after resolving the effective provider.
    preparationEnv: ["GOOSE_PROVIDER", "GOOSE_MODEL"],
    newSession: () => `work-${randomUUID()}`,
    // The name the daemon minted, and goose derives the session FILE from it, so it must stay one safe path segment.
    isSession: s => /^(?:work|gallivant)-[0-9a-zA-Z-]{1,64}$/.test(s) && !s.includes(".."),
    start: ({ session, prompt }) => ["run", "--name", session, ...GOOSE_COMMON, "-t", prompt],
    resume: ({ session, prompt }) => ["run", "--resume", "--name", session, ...GOOSE_COMMON, "-t", prompt],
    // GOOSE_MODE is how goose bounds tool calls; there is no CLI flag for it. "approve" would hang a headless run
    // waiting for a human, "chat" cannot edit files at all. "smart_approve" is the bounded setting that still lets
    // a run work, and it is set here rather than left to the operator's ~/.config/goose/config.yaml so a run never
    // inherits a looser mode from the machine.
    env: () => ({ GOOSE_MODE: "smart_approve" }),
    // goose does not print the session name back in its JSONL; the daemon already knows it because it generated
    // it, so there is nothing to parse and nothing to guess.
    sessionFrom: () => null,
    outcome(lines) {
      const evs = events(lines);
      const complete = evs.findLast(ev => ev.type === "complete");
      const errored = evs.findLast(ev => ev.type === "error");
      // goose streams an assistant reply as several `message` events, so the last one is a fragment, not the
      // answer. Verified: resuming a session that had been told 8585 produced "858" then "5" as two events.
      // Joining every assistant chunk is the only way to read the reply back whole.
      const chunks = evs.filter(ev => ev.type === "message" && ev.message?.role === "assistant")
        .flatMap(ev => (ev.message.content || []).filter(c => c.type === "text" && typeof c.text === "string").map(c => c.text));
      const text = chunks.join("");
      const lastText = text || null;
      // Goose 1.50.1 emits provider failures as a visible assistant message followed by `complete`, with exit 0.
      // This is the CLI's failure envelope, not a successful model answer (observed with a provider HTTP 404).
      // Its prefix must begin a native text block, not an example embedded in model prose. Read forward from
      // those boundaries in the joined stream so split prefixes and failures after earlier output still work.
      let providerError = null;
      let offset = 0;
      for (const chunk of chunks) {
        if (text.startsWith("Ran into this error: Request failed:", offset)) {
          providerError = text.slice(offset + "Ran into this error: ".length);
          break;
        }
        offset += chunk.length;
      }
      // Authentication failures can instead be typed content blocks, also followed by `complete` and exit 0.
      const contentError = evs.flatMap(ev => ev.message?.content || []).find(c => c.type === "error");
      const credits = evs.flatMap(ev => ev.message?.content || []).find(c => c.type === "systemNotification" && c.notificationType === "creditsExhausted");
      if (!complete && !errored) return { ok: false, finished: false, lastMessage: lastText, denials: [], cost: null, error: "no complete event" };
      return {
        ok: !errored && !providerError && !contentError && !credits, finished: true, lastMessage: lastText, denials: [],
        cost: complete?.cost_usd ?? null,
        error: errored ? (errored.error?.message || errored.message || "run failed") : providerError || (contentError ? contentError.message || contentError.kind || "provider error" : null) || (credits ? `creditsExhausted: ${credits.msg || "provider credits exhausted"}` : null),
      };
    },
    // Like gemini: goose keeps provider keys in ~/.config/goose and has no status command that checks them
    // without making a call, so this proves only that the binary runs. Same weaker guarantee, same consequence.
    signIn: { args: ["--version"], ok: code => code === 0, fix: "goose configure" },
    version: { args: ["--version"], parse: out => (out.match(/(\d+\.\d+\.\d+)/) || [])[1] },
    // `goose run` has no directory flag at all. Same as opencode: no effect rather than a refusal.
    context: null,
    attach: ({ session }) => `goose run --resume --name ${session} -s`,
  },
};

// This is the capability registry; CLI adapters above remain its compatibility view.
// Reserved selections are explicitly unavailable until their transport milestones ship.
export const executionRegistry = Object.freeze({
  ...Object.fromEntries(Object.entries(adapters).map(([name, adapter]) => [name, Object.freeze({
    name, adapter, available: true, transport: "cli", authentication: "operator-cli",
    environments: ["isolated-checkout"], continuation: "native-session", observability: ["jsonl", "process"],
    controls: { cancel: true, interrupt: true }, cost: { source: name === "claude" ? "provider-usd" : "unknown-or-provider", hardCap: name === "claude" },
    policy: name === "codex" ? ["workspace-write", "auto-review"] : name === "claude" ? ["configured-hooks"] : [],
    preparation: name === "claude" ? "claude-no-tools-v1" : null,
  })])),
  "openai-agents": Object.freeze({ name: "openai-agents", available: false, transport: "remote", reason: "managed API transport belongs to the next milestone" }),
  "codex-cloud": Object.freeze({ name: "codex-cloud", available: false, transport: "remote", reason: "Cloud transport belongs to its following milestone" }),
});
export const capabilitiesFor = name => {
  const c = executionRegistry[name];
  if (!c) throw new Error(`unknown execution provider ${name}`);
  return c;
};
export const executionCapabilities = () => Object.values(executionRegistry).map(({ adapter, ...capabilities }) => capabilities);

export const adapterFor = name => {
  const a = adapters[name];
  if (!a) throw new Error(`unknown harness "${name}"; known: ${Object.keys(adapters).join(", ")}`);
  return a;
};

/**
 * Refuse any argv that switches a harness's own safety off. The daemon never needs these, and the check is on the
 * resolved argv rather than on each adapter so a flag cannot arrive from a prompt, a config value or a future edit
 * to one adapter without passing here first.
 *
 * What the equivalent of --dangerously-skip-permissions is for each harness, as of the versions above:
 *
 *   claude    --dangerously-skip-permissions
 *   codex     --dangerously-bypass-approvals-and-sandbox, and the same thing spelled as a config override:
 *             approval policy alone does not remove the sandbox, but sandbox_mode="danger-full-
 *             access" removes the sandbox, so the override VALUE is checked too, not just the flag name.
 *   gemini    -y / --yolo, and --approval-mode yolo, which are the same switch by two spellings.
 *   opencode  --auto, whose own help calls it "auto-approve permissions that are not explicitly denied
 *             (dangerous!)".
 *   goose     no CLI flag at all. goose is bounded by the GOOSE_MODE env var, so there is nothing in argv to
 *             refuse; the adapter pins GOOSE_MODE=smart_approve instead. GOOSE_MODE is checked in assertSafeEnv.
 */
const DANGEROUS_FLAGS = new Set(["-y", "--yolo", "--auto"]);
const DANGEROUS_VALUES = [/^sandbox_mode=.*danger/i, /^yolo$/i];
// A flag whose value makes it dangerous, and the values that do. Both spellings are one rule: a CLI that accepts
// `--flag value` accepts `--flag=value`, so a list of literal spellings refused one and let the other through.
const DANGEROUS_WITH_VALUE = [
  ["--approval-mode", /^yolo$/i],
  ["--sandbox", /danger/i],
  ["-s", /danger/i],
  ["--yolo", /^(true|1|yes)$/i],
];

export function assertSafeArgv(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (/^--dangerously-/.test(a) || DANGEROUS_FLAGS.has(a)) throw new Error(`refusing to run with ${a}`);
    for (const [flag, bad] of DANGEROUS_WITH_VALUE) {
      // `--flag value` is two argv elements, `--flag=value` is one. Refuse both, or the `=` form is a way past this.
      const eq = a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : null;
      if (eq !== null ? bad.test(eq) : a === flag && bad.test(String(args[i + 1] ?? ""))) throw new Error(`refusing to run with ${a}${eq === null ? ` ${args[i + 1]}` : ""}`);
    }
    if (DANGEROUS_VALUES.some(re => re.test(a))) throw new Error(`refusing to run with ${a}`);
  }
  return args;
}

/**
 * Whether a string is a session id this harness could have minted. The block already holds every session it reads
 * off GitHub to this rule (`lib/block.mjs`); `register --session` is the one source that did not, and its value goes
 * straight into argv position 2 after `--resume` or `--name`. `assertSafeArgv` cannot save it: it matches flag
 * spellings, and a value in an unexpected position is not a spelling. So the flag and the block agree from here.
 */
export const isSessionFor = (harness, session) => adapters[harness]?.isSession(String(session ?? "")) === true;

/** The same refusal for the environment, because goose's permission mode is an env var and not a flag. */
export function assertSafeEnv(env) {
  const mode = env.GOOSE_MODE;
  if (mode && !["smart_approve", "approve", "chat"].includes(mode)) throw new Error(`refusing to run with GOOSE_MODE=${mode}`);
  return env;
}

/**
 * How a harness handles extra read-only directories: "grant" when it has a flag for exactly that, "refuse" when
 * its nearest flag would also grant write or would grant the whole disk, "none" when it has no such flag at all.
 * `doctor` prints this so an operator with a list and the wrong harness is told, not left to guess.
 */
export function contextSupport(harness) {
  const c = adapterFor(harness).context;
  if (!c) return { kind: "none", detail: `${harness} has no flag that adds a directory; context_paths has no effect on its runs` };
  if (c.refuse) return { kind: "refuse", detail: c.refuse };
  return { kind: "grant", detail: `${harness} grants read on each path and writes stay bounded as before` };
}

/**
 * Everything needed to spawn one run: { cmd, args, env }. `mode` is "start" or "resume".
 * Prompts are passed as the final argv element; both CLIs accept that and it keeps stdin free.
 *
 * `contextPaths` are extra directories the run may READ, already resolved and validated by
 * `resolveContextPaths`/`validateContextPaths` in lib/config.mjs. An empty list renders nothing, so a run with no
 * extras has exactly the argv it had before this existed. A harness that cannot grant read on a specific directory
 * without also granting write, or without granting the whole disk, refuses the run rather than escalating; one with
 * no directory flag at all ignores the list, because there is nothing to widen and a failed run would help nobody.
 */
export function buildRun({ harness, config, mode, session, prompt, cwd, contextPaths = [] }) {
  const a = adapterFor(harness);
  const h = config.harness[harness];
  if (!h?.bin) throw new Error(`harness.${harness}.bin is not configured`);
  // The shell may resolve another installation. A real plugin validation launched an old PATH Codex from a
  // healthy newer parent and misdiagnosed its model rejection as an account problem. Carry the exact executable
  // on every dispatch, including resumes; changing PATH alone would not survive a login shell's startup files.
  const runtime = [
    `Gallivant launched this session with the configured ${harness} executable: ${JSON.stringify(h.bin)}.`,
    "For task-authorized tests of this harness, invoke that exact executable, quoted as one path, instead of assuming the bare command on PATH is the same installation. This does not authorize nested jobs, model/provider changes, extra paid calls or weaker permissions. Keep the task's existing scope and security settings.",
    "Before substantial implementation or retrying blocked work, check the brief's mandatory external prerequisites: required host/plugin support, model access and any browser or capture surface. Use the available native tools and the smallest authorized check; version/sign-in checks alone do not prove model access or installed-plugin behavior. If a required capability is unavailable, report the observed failure, affected criteria and exact remedy early. Continue useful independent work, preserve unmet attestations, and do not repeat unchanged blocked calls or replace required live evidence with fixtures.",
  ].join("\n");
  const ctx = { session, prompt: `${runtime}\n\n${prompt}`, budget: config.max_budget_usd, settings: h.settings, cwd };
  const base = mode === "start" ? a.start(ctx) : a.resume(ctx);
  const args = assertSafeArgv(withContext(a, base, contextPaths));
  const env = assertSafeEnv({ ...a.env({ configDir: h.settings ? dirname(h.settings) : null }) });
  return { cmd: h.bin, args, env };
}

// A workspace and a private HOME are not a filesystem boundary. The existing
// implementation adapters remain unchanged; preparation needs a separate,
// enforceable contract before untrusted context can reach a model with tools.
export const PREPARATION_BOUNDARY = "claude-no-tools-v1";
export function buildPreparationRun(options) {
  if (options.harness !== "claude") {
    const error = new Error(`${options.harness} preparation is unavailable: its adapter has no enforced read/write boundary or tool-free mode; use a hand-authored PRD with ready/start until an isolated preparation adapter is supported; no provider call was made`);
    error.code = "TASK_PREPARATION_BOUNDARY";
    throw error;
  }
  const spec = buildRun(options);
  // --tools excludes built-ins, not MCP. Remove every tool, prevent native MCP
  // discovery, and disable skills/commands as well. --restricted confines native
  // file tools and ignores user/project settings if policy ever reintroduces one.
  // All flags precede -p because several tool/config flags take variadic values.
  spec.args = assertSafeArgv(["--restricted", "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", ...spec.args]);
  return { ...spec, boundary: PREPARATION_BOUNDARY };
}

/**
 * The adapter's argv with the read-only directories folded in. The flags go BEFORE the prompt, which every adapter
 * passes last, so nothing turns a path into part of the brief.
 */
/**
 * Insert a harness's context-path flags, keeping the prompt last.
 *
 * The flags go at the FRONT, not immediately before the prompt. `--add-dir` takes a variadic list, so
 * `--add-dir <dir> <prompt>` reads the prompt as another directory and Claude Code then refuses the run with
 * "Input must be provided either through stdin or as a prompt argument when using --print". That is a real failure
 * seen on a live run: the session started, the hook fired, and the harness exited before doing any work. Putting the
 * flags ahead of everything leaves the prompt adjacent to nothing that can swallow it.
 */
function withContext(a, args, paths) {
  if (!paths.length) return args;
  if (!a.context) return args;                               // no flag exists: the list has no effect here
  if (a.context.refuse) throw new Error(`refusing to run ${a.name} with context_paths: ${a.context.refuse}`);
  return [...a.context.render(paths), ...args];
}

export const compareVersions = (a, b) => {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
};
