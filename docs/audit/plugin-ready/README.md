# Task intake evidence

Scope: natural-language intake, the shared readiness/start path and additive CLI
and in-process exports. The approved [PRD](../../prds/natural-language-tasks.md) and
[carried contract](../../plans/plugin-ready-gallivant.md) are unchanged inputs.

[Evidence JSON](natural-language-tasks.json) records per-case outcomes, source
revision, command results and external blockers. Raw test logs stay outside Git.
[Release checklist](checklist.md) separates offline implementation evidence from
live qualification. [Task operations](../../tasks.md) documents commands, contracts,
source mapping, execution authorization and stopping conditions.

| Contract boundary | Implementation and regression evidence |
| --- | --- |
| Identity, original input, answers, immutable revisions | `lib/tasks.mjs`, `lib/task_store.mjs`; clear request, answer-time context/source delivery, partial replies, unsafe/oversized/changed context refusal, prototype-sensitive operation persistence/replay, CLI unknown answer-key refusal, duplicate reply and concurrent mutation tests |
| Requirement preservation and canonical G2 PRD | `lib/task_contract.mjs`; exact question ownership, unrelated clarification refusal, legacy mapping recovery, literal request/answer round-trips, strict placeholder repair, unmapped constraints, canonical verification-action inference without execution-changing arguments, initial/repair and legacy dispatch refusal across tool families, explicit owner argument-bearing answer parity and single dispatch, unbound Maven/.NET inference refusal across repair and saved replay, explicit owner-check clarification parity, lockfile manager selection and unknown/conflicting manager question parity tests |
| Isolated preparation and usage | `lib/task_prepare.mjs`, `lib/task_environment.mjs`, existing `lib/git.mjs` / `lib/run.mjs`; serialized UTF-8 prompt bounds before probes/launch on initial, answer, repair and resumed turns, exact boundary transport, native child credential exclusion, selected adapter allowlists/private file and directory snapshots, selected AWS profile projection across ambient/explicit files, direct and web-identity credentials without native account files, excluded shared caches and legacy snapshot cleanup, unsupported-chain refusal before initial/repair launch, explicit auth/config file settings, pinned invocation directory across repairs/retry/resumed answers and legacy fallback, native write and traversal isolation, refused selected-entry aliases across adapters/ADC/Bedrock/explicit files on initial and repair turns, internal resource link materialization, refused nested links and partial-copy cleanup, scoped Vertex ADC and enabled Foundry routing/key/token forwarding across initial/repair CLI and structured turns, initial/repair isolation, recorded/inferred recovered completion deadlines, saved-output replay, usage and allowance tests |
| Actual readiness and exact start | existing `lib/commands/ready.mjs`, `lib/commands/start.mjs`, `lib/start_contract.mjs`; hosted denial fixture and exact revision tests |
| Dispatch ownership and recovery | existing `lib/state.mjs` claims; lost preparation/ready acknowledgements, post-clone source/base/partial-clone failures, retained clone metadata, token checks, clean pre-clone retry and duplicate/uncertain dispatch tests across tasks, hand-authored starts and chains |
| Operator-only sources | `lib/task_contract.mjs` intake path policy, Verify command provenance and existing source snapshots; feature-only manifest and lockfile delivery to a fresh base, supported-stack authorizers, answer-time manifest/manager pinning, lockfile path/byte refusal, boundary-quote and raw boundary-whitespace refusal across selection/answers/generated/saved output and legacy identity replay, internal-quote/space filename round-trip and delivery, saved-source refusal and modified snapshot tests |
| Hand-authored source compatibility | shared `parseSourcesMeta`; readiness and start delivery of `.env.example` and `.config/docs/setup.md` |
| CLI / structured parity and package safety | `lib/commands/task.mjs`, exports; operation parity and clean packed-package tests; initial/repair permission-denial text and usage persisted across CLI rendering, inspection, native recovery and settled replay without retry or dispatch |
| Existing lifecycle and defaults | full existing offline suite; no harness/model/provider/permission defaults changed |

Native preparation now removes all Claude tools and refuses the four other
adapters before probes or launch. Recovery rejects legacy tool-enabled output and
stops owned legacy children. Goose environment tests prove selected-provider key
admission and shared-secret/keyring exclusion. The native sandbox probe returned
no child result (null status and empty stdout/stderr); no enforced host isolation
or installed tool-free behavior is claimed. Criterion ac-4 remains false.
Qualification requires an enforced read/write preparation adapter or verified
native tools-off behavior under the existing provider, model and permissions.

The offline Goose provider fixtures exercise copied current/legacy selectors and
environment precedence, selected AWS credentials on initial/repair turns,
non-Bedrock cleanup and ambiguous-selector refusal before launch. The explicit
Maven/.NET tests pin root/module POMs and selected project/solution files through
CLI and structured preparation/answers, bounded source repair, saved-draft
validation and fresh-base single dispatch. These are offline fixtures, not live
authentication or project-tool execution evidence. Durable runner tests inject
disposable Node executables independently of the native adapter gate; they retain
lifecycle coverage and cannot qualify a refused adapter.

The observed native executable was
`/Users/uchi/.local/share/gallivant/codex/node_modules/.bin/codex` at version
`0.160.0`. GitHub CLI reported a signed-in operator. Those checks do not prove
model access, a live task, installed-plugin behavior or review completion. This
milestone needs no plugin/browser surface. No disposable GitHub repository or
explicit live spending allowance was supplied, so no live inference, nested
implementation or forced review run was attempted. Criterion ac-12 remains false.

The exact remedy is an operator-authorized disposable repository, configured
runtime credentials and actual model access, plus a bounded execution allowance
covering one small intake/implementation and one forced CI/review correction.
Preserve the existing provider, model and permissions. Recheck only a failed phase
after resolving its observed cause. Offline fixtures are never live evidence.

## Execution foundation

[The execution contract](../../execution.md), [foundation evidence](execution-foundation.json)
and [foundation checklist](execution-checklist.md) cover the later offline
execution, polling and log milestone. These records supplement the intake audit;
its historical qualification blockers above remain unchanged. Remote transport
availability and installed-host/live release qualification are separate gates.

## Managed Agents API

[Transport evidence](openai-agents.json), [its checklist](openai-agents-checklist.md)
and [operator instructions](../../openai-agents.md) cover the managed REST adapter.
Provider-shaped offline lifecycle tests and generated artifacts are verified
separately from live qualification. The nonpaid preflight found missing live
configuration, disposable repository/brief and campaign ledger. Criterion ac-13
remains unverified; earlier milestone blockers and installed-host gates are retained.
