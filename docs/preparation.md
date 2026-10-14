# Harness-independent preparation

Natural-language intake is a normal harness job with limited authority:

`request + selected context → selected harness → structured draft → Gallivant validation/ready → authorized implementation → review`

Questions and validation repairs return through that same adapter and durable
runner. Gallivant owns requirements, revisions, readiness and execution consent.
The model does not certify its own PRD or launch implementation while drafting.
APort must call these shared task operations, rather than generate PRDs or launch
a provider itself. Preparation and implementation are separate capabilities:

| Provider | Natural-language preparation | Implementation |
| --- | --- | --- |
| Claude Code | Tools disabled | Local checkout |
| Codex | Isolated native profile, Codex 0.160.0+ | Local checkout |
| OpenAI Agents API | Text only, no tools or environment | Hosted sandbox |
| Gemini CLI, OpenCode, Goose | Unavailable; use `new` → `ready` → `start` | Local checkout |
| Codex Cloud | Unavailable | New dispatch blocked on environment/repository verification |

An adapter's presence does not prove the configured account can use its selected
model. Check [local live evidence](https://github.com/uchibeke/gallivant/blob/main/docs/audit/harness-live-validation.md),
[Agents setup](openai-agents.md) and the [Cloud blocker](codex-cloud.md).
Preparation consumes inference, but grants no implementation consent. Selected
repository text is context; it cannot authorize tools or publication.

The canonical adapter registry owns preparation boundaries. Claude uses its
tools-off mode. Codex 0.160.0 uses an isolated permission profile, no approvals,
disabled command network, no shell/browser/apps/plugins/hooks/delegation tools,
and explicit disabling of every inherited MCP server. An empty MCP table alone
does not remove inherited entries. Both `agents.enabled` and
`features.multi_agent_v2` are disabled: a model-selected V2 delegation capability
can override the V1 `features.multi_agent` switch. Some model catalogs still
expose apply_patch; the sandbox denies its file access. No preparation tool receives project or
credential filesystem grants. Selected source text is supplied in the prompt.

The following isolation details apply to local Codex preparation. Agents API
preparation instead sets `environment: {type: "none"}`, `tools: []` and
`multi_agent.enabled: false` on session creation, verifies the effective session,
and accepts only the owned root turn's final text. It sends no local filesystem,
GitHub or implementation credentials. Unsupported effective configuration or tool
output fails closed; [the managed transport](openai-agents.md#task-and-command-use)
records its recovery and live qualification limits.

The Codex task-private config snapshot is parsed with bundled smol-toml. Model and
provider settings are retained; legacy sandbox settings are removed because they
override permission profiles. Legacy `notify` commands are removed from the private
snapshot and disabled explicitly; turning off hooks alone does not disable them.
Inherited `instructions`, `developer_instructions`, `compact_prompt`,
`model_instructions_file` and `experimental_compact_prompt_file` are removed from
the private snapshot. Codex reads these itself, outside tool permissions. Automatic
skill instructions, bundled/cloud skills, memory usage/generation and token-budget
compaction overrides are disabled. Stale `AGENTS.md` and `AGENTS.override.md` in the
private Codex home are unlinked: global instructions ignore `project_doc_max_bytes`.
The operator's own AGENTS files are never copied or changed.

Native telemetry exporters, prompt logging and analytics/feedback are disabled.
Private `log_dir` and `sqlite_home` overrides are removed so draft logs/state stay
under the private home; inherited hooks and notifications remain disabled.
Before any drafting turn, a bounded native `config/read` **and**
`configRequirements/read` probe verifies merged settings and separate managed
requirements. The latter can inject developer instructions or force runtime
permission/approval/web-search fallbacks absent from the raw config. Both reads
share one timeout, cancellation handler and output bound. They start no model
turn, send no intake text and discard configuration diagnostics. Conflicting
context, telemetry, storage, sandbox, tool, notification, MCP or permission settings fail closed before a
preparation receipt is returned. Managed policy is never rewritten to obtain a pass.
Native operator files and managed requirements are unchanged.
Unsupported named config profiles and ambiguous MCP server names stop
before drafting with an actionable error. Implementation argv is unchanged.

Run the ordinary suite with `npm ci && npm test`. To verify the installed Codex
against a local Responses fixture without buying inference:

```sh
node test/preparation-codex-native.mjs /absolute/path/to/codex \
  /path/to/models_cache.json gpt-6.1-sol gpt-6-astra gpt-5.5
```

The native fixture explicitly loads the supplied model catalog, including its
delegation version. It attempts shell, inherited MCP, delegation and file-patch
calls both inside and outside the workspace. It seeds file and inline instructions,
project/global AGENTS, skill metadata, memory, notifications, telemetry and external
state paths. Every provider request is checked for sentinel context. Model choice
and reasoning effort must survive, and external writes/telemetry must stay absent.
On 2026-10-07, all three models passed these checks with Codex 0.160.0, including
Sol and Astra with explicit V2 catalog metadata. Inherited notification commands
stayed disabled and unselected instruction text was absent from every request.
Conflicting effective settings were refused before any model request. Managed precedence is covered
by protocol regression fixtures, including separate instruction requirements and
permission fallbacks, without editing the machine's administrator policy.
This proves native CLI/configuration behavior with a fixture provider,
not live provider eligibility or a completed APort/ChatGPT workflow.

The [PR #10 context and side-effect audit](https://github.com/uchibeke/gallivant/blob/main/docs/audit/preparation-context-boundary.md)
records the source-backed findings, regression coverage and trust limits.

Official configuration references:
[permissions](https://learn.chatgpt.com/docs/permissions),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
Re-run native qualification when upgrading the CLI or adding tool capabilities.

The recorded cross-repository integration handoff names
[`aporthq/agent-passport#417`](https://github.com/aporthq/agent-passport/pull/417),
with job identity `aporthq/agent-passport/aport-task-delivery-workflow-integration`.
The handoff calls for reusing that continuation after the actual portable package
is available. This document qualifies the preparation boundary; it does not
establish the current deployment state of APort or a completed connected workflow.
Check the linked integration's release evidence separately.
