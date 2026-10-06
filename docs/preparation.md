# Harness-independent preparation

Natural-language intake is a normal harness job with limited authority:

`request + selected context → selected harness → structured draft → Gallivant validation/ready → authorized implementation → review`

Questions and validation repairs return through that same adapter and durable
runner. Gallivant owns requirements, revisions, readiness and execution consent.
The model does not certify its own PRD or launch implementation while drafting.
APort must call these shared task operations, rather than generate PRDs or launch
a provider itself. Remote adapters supply the same preparation capability.

The canonical adapter registry owns preparation boundaries. Claude uses its
tools-off mode. Codex 0.160.0 uses an isolated permission profile, no approvals,
disabled command network, no shell/browser/apps/plugins/hooks/delegation tools,
and explicit disabling of every inherited MCP server. An empty MCP table alone
does not remove inherited entries. Some model catalogs still expose apply_patch;
the sandbox denies its file access. No preparation tool receives project or
credential filesystem grants. Selected source text is supplied in the prompt.

The task-private config snapshot is parsed with bundled smol-toml. Model and
provider settings are retained; legacy sandbox settings are removed because they
override permission profiles. Native operator files and managed requirements are
unchanged. Unsupported named config profiles and ambiguous MCP server names stop
before drafting with an actionable error. Implementation argv is unchanged.

Run the ordinary suite with `npm ci && npm test`. To verify the installed Codex
against a local Responses fixture without buying inference:

```sh
node test/preparation-codex-native.mjs /absolute/path/to/codex \
  /path/to/models_cache.json gpt-6.1-sol gpt-6-astra gpt-5.5
```

On 2026-10-06, Codex 0.160.0 processed all three model catalogs. Each completed
after rejecting forced shell, inherited MCP and file-patch calls both inside and
outside the preparation workspace, despite inherited writable settings. Sol and Astra
exposed no tools; GPT-5.5 exposed request_user_input and apply_patch, with writes
denied. This proves native CLI/configuration behavior with a fixture provider,
not live provider eligibility or a completed APort/ChatGPT workflow.

Official configuration references:
[permissions](https://learn.chatgpt.com/docs/permissions),
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
Re-run native qualification when upgrading the CLI or adding tool capabilities.

APort's connected execution continuation is
[`aporthq/agent-passport#417`](https://github.com/aporthq/agent-passport/pull/417),
with job identity `aporthq/agent-passport/aport-task-delivery-workflow-integration`.
M6 should reuse that single continuation after the actual M5 portable package
is available. The merged APort foundation still lacks workflow integration;
this preparation adapter does not change that deployment state.
