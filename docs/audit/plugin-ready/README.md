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
| Identity, original input, answers, immutable revisions | `lib/tasks.mjs`, `lib/task_store.mjs`; clear request, answer-time context/source delivery, partial replies, unsafe/oversized/changed context refusal, duplicate reply and concurrent mutation tests |
| Requirement preservation and canonical G2 PRD | `lib/task_contract.mjs`; literal request/answer round-trips, strict placeholder repair, unmapped constraints and wrong-stack Verify tests |
| Isolated preparation and usage | `lib/task_prepare.mjs`, `lib/task_environment.mjs`, existing `lib/git.mjs` / `lib/run.mjs`; native child credential exclusion, selected adapter allowlists/private file and directory snapshots, explicit auth/config file settings, pinned invocation directory across repairs/retry/resumed answers and legacy fallback, native write and traversal isolation, internal resource link materialization, refused nested links and partial-copy cleanup, scoped Vertex ADC, initial/repair isolation, usage and allowance tests |
| Actual readiness and exact start | existing `lib/commands/ready.mjs`, `lib/commands/start.mjs`, `lib/start_contract.mjs`; hosted denial fixture and exact revision tests |
| Dispatch ownership and recovery | existing `lib/state.mjs` claims; lost preparation/ready acknowledgements and duplicate/uncertain dispatch tests |
| Operator-only sources | `lib/task_contract.mjs` intake path policy and existing source snapshots; carried documents, saved-source refusal and modified snapshot tests |
| Hand-authored source compatibility | shared `parseSourcesMeta`; readiness and start delivery of `.env.example` and `.config/docs/setup.md` |
| CLI / structured parity and package safety | `lib/commands/task.mjs`, exports; operation parity and clean packed-package tests |
| Existing lifecycle and defaults | full existing offline suite; no harness/model/provider/permission defaults changed |

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
