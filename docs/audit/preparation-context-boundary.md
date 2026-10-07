# PR #10: preparation context and side-effect audit

Audited 2026-10-07 against Codex CLI 0.160.0 and Gallivant main `96e8103`.
Scope: PRD drafting, clarification and repair through the shared preparation
adapter. Ordinary implementation, Codex Cloud and Agents API dispatch are separate.

Validation: **1,245 tests passed**, zero failed/skipped; lint and diff checks passed.
The native fixture passed for Sol, Astra and GPT-5.5: 18 provider requests,
15 hostile tool calls rejected, and 14 conflicting effective settings refused.

The new Codex review was valid: the private config retained inline system and
developer instructions. New regressions failed on the previous implementation
before the fix. The audit also examined adjacent native context and side effects,
because model-tool permissions do not constrain Codex's own startup/configuration.

| Surface | Finding and control | Evidence |
| --- | --- | --- |
| Inline and file instructions | Strip `instructions`, `developer_instructions`, `compact_prompt` and both instruction-file fields from the private snapshot. Refuse any restored effective value. Disable token-budget custom compaction prompts. | Negative regressions on the old code; native request sentinels and conflicting-override tests. |
| Managed requirements | `additionalDeveloperInstructions` is separate from `config/read`. Inspect `configRequirements/read` before returning a receipt; refuse inherited managed text rather than delete administrator policy. | Protocol fixtures cover text, absent/malformed/error responses, unchanged policy and no drafting call. |
| Managed runtime fallbacks | Raw config may say `never`/restricted profile while requirements force a different runtime value. Require permission for the chosen profile, read-only sandbox, `never` approvals and disabled search; reject conflicting feature requirements. | Allowed and refused requirement fixtures, including workspace fallback and V2/tool/memory overrides. |
| Skills, memory and AGENTS | Disable skill context/discovery, bundled/cloud skills and memory use/generation. Project docs use a zero byte limit. Native testing found that global AGENTS ignores this limit; remove stale entries in the private home only. | Native sentinels in project/global AGENTS, skill metadata and memory; symlink cleanup test preserves the operator target. |
| Telemetry and state | Native exporters bypass model-tool network restrictions. Disable all three OTEL exporters and prompt/response logging, analytics and feedback. Remove private log/SQLite redirects and refuse restored overrides. | Native loopback telemetry trap stays empty; external state directories stay absent; private snapshot tests preserve operator files. |
| Tools and callbacks | Keep shell/MCP/browser/apps/plugins/hooks/legacy notify and both delegation routes disabled. Disable permission-request tools and use `never` approvals. | Native hostile shell, MCP, delegation and inside/outside patch replies fail; no callback marker is created. |
| Inference and credentials | Preserve selected model/provider/auth/reasoning defaults and custom model metadata. Sanitize only the task-private copy. | Native requests retain model and high reasoning effort; tests retain provider URL/auth key selection and compare original config/auth bytes. |
| Lifecycle and adjacent harnesses | Use the existing execution/preparation capability, runner and cancellation path. No new launcher/client. Inspection is bounded and emits no intake text or secret diagnostics. | Preparation, intake, execution, recovery, review, Cloud and Agents API coverage in `npm test`; cancellation and malformed-output tests. |

## Reproduce

```sh
node --test test/preparation-capabilities.test.mjs
npm test
npm run lint
git diff --check
node test/preparation-codex-native.mjs /absolute/path/to/codex \
  /path/to/models_cache.json gpt-6.1-sol gpt-6-astra gpt-5.5
```

The native fixture uses a local Responses server with no operator credentials or
paid inference. It loads actual model metadata so model-selected V2 delegation is
exercised. It deliberately returns forbidden tool calls and inspects every request.
It does not edit system/MDM policy: those precedence and requirement cases use
protocol fixtures. Qualification is for this CLI version and these model catalogs;
repeat it before relying on a different native version or tool capability.

## Trust limits and intentional behavior

- The selected executable, model provider, authentication mechanism and model
  catalog remain trusted inference configuration. A custom catalog can supply
  model base instructions; this change does not certify an arbitrary third-party
  binary/provider/catalog or remove the selected model's built-in instructions.
- Native configuration inspection happens outside the model-tool sandbox. It may
  perform ordinary CLI startup/authentication activity; no thread or model turn is
  started and no task text is sent during inspection. This is not an OS sandbox
  for an untrusted executable or administrator. Machine-policy changes between
  inspection and execution remain an operator trust boundary.
- Incompatible administrator policy stops drafting with `TASK_PREPARATION_BOUNDARY`.
  There is no fallback to unrestricted implementation, other credentials, a
  different model or a rewritten managed policy. Keep required policy intact and
  use an administrator-approved compatible configuration.
- Preparation deliberately excludes personal instruction/skill/memory context.
  Include desired task context explicitly through intake. Model/provider/reasoning
  choices and normal implementation behavior are retained.
- This audit does not establish live Cloud account eligibility, paid API execution
  success, APort deployment readiness or a submitted ChatGPT plugin.

## Native source references

- [Inline, file, compaction and state settings](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/config_toml.rs).
- [Config reads and the separate requirements read](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/config_manager_service.rs).
- [Managed developer instruction injection](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/context/world_state/managed_developer_instructions.rs).
- [Native configuration, permission fallbacks and context loading](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/config/mod.rs).
- [Skill instruction controls](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/skills_config.rs), [memory and telemetry settings](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/config/src/types.rs), and [feature controls](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/features/src/lib.rs).
