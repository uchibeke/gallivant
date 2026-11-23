# Console feature matrix

This inventory covers the merged dependency compiler, admission, dispatch and
controls, plus the Plans authoring and task decisions workspaces. The qualification
report identifies the exact commit, tree and code bytes. **Implemented** means the
code path exists. **Qualified** applies to the exact recorded
repository, actor, adapter, route and capability. **Unvalidated** means required
live evidence is missing. **Planned** features have no enabled console controls.

| Feature | Status and console treatment | Control or operator path |
| --- | --- | --- |
| Install and setup | Implemented. System shows saved coordinator, provider and host observations. | CLI `init`, `doctor`, `doctor --network`, `help` and `--version`. Use explicit `doctor --probe` for its real test and `--send` for a test notification. |
| Coordinator and supervision | Implemented single coordinator and workspace. Supervisor takeover requires separately qualified host and process proof. | CLI `start`, `serve`, `up` and `down`. Browser refresh reads a snapshot. |
| Intake and written briefs | Implemented. Tasks shows preparation, clarification, readiness and admission. Intake and task details show the recorded revision or source. | **New task** uses local intake review. CLI `task prepare/answer/inspect/list/resume/validate/start`. Written briefs use `new`, `ready [--check]` and `start PRD`. |
| Graphs, groups and future anchors | Implemented compiler and protected admission. Dispatch requires qualified outer isolation, repository binding and enabled capacity. Plans shows leaves, receipts, held branches, joins and frozen scope. | CLI `plan validate/preview/queue/inspect`. Confirm the reviewed digest through the protected ingress. |
| Plan controls and registry migration | Implemented for the protected admission owner. Plans shows saved lifecycle and scope. The protected Plans workspace previews JSON/YAML and guided plans and reviews future changes. | **New plan** and scoped controls use the shared review service. CLI `plan attach/edit/hold/unhold/cancel/retry/migration`. Migration preserves legacy ownership and receipts. |
| Linear chains | Implemented. Legacy links and Plans use shared dependency observations. | CLI `chain`, `--after`, `--after-chain`, `--after-node`. Existing browser retry, resnapshot and cancellation review future milestones where authorized. |
| GitHub and Bitbucket Cloud | Implemented adapters with per-host limits. PR links use saved task evidence. Bitbucket lacks GitHub labels and requires its own review and transport evidence. | CLI `register` explicitly adopts or resets a PR. `remove` forgets a registry entry. Host administration uses existing operator flows. |
| Local harnesses | Implemented for `claude`, `codex`, `gemini`, `opencode` and `goose`. System shows adapter and account evidence separately. | CLI setup for the selected adapter. Claude and Codex support isolated preparation where configured. Gemini, OpenCode and Goose can implement written briefs. |
| Hosted Agents API | `openai-agents` implements bounded preparation and hosted author execution. Model access, repository export, verification and continuation require their respective evidence. | Select an approved route, then inspect System and existing-session controls. |
| Codex Cloud | `codex-cloud` implements observation and recovery of bound jobs. New dispatch is gated pending exact repository/environment qualification. | CLI diagnostics and supported reconciliation for an already bound job. |
| Review policy | Implemented external, independent first-party and both-required policies. Text and image qualify by exact route. Task details show reviewer pieces, findings and stale or missing clearance. | CLI `review status/qualify/retry/policy/dispute`. **Recheck PR** asks the coordinator to re-evaluate current gates. |
| CI and Verify | Task evidence shows current-head canonical check counts and a bounded job list. Selected attempts show saved coordinator Verify results when available. | **Recheck PR** refreshes observations. CI configuration and repair remain with their existing owner. |
| Acceptance and integration | Implemented completion evidence, owner obligations and delivery-ready versus integrated targets. APort and configured local evaluation can produce receipts. Skipped and unknown stay visible. | Merge through the authorized host workflow. There is no dashboard merge action. |
| Task requests and diagnostics | Implemented saved request status and selected-attempt evidence. | Browser **Message**, **Resume**, **Recheck** and **Cancel** use existing controls. CLI `say`, `resume`, `recheck`, `cancel`, `status` and `why`. Changed inputs and fresh sessions need explicit review. |
| Recovery and repair | Implemented cause, step, retry, round and ownership evidence, plus bounded base/conflict and CI repair. Autonomous operation requires the admitted profile, native proof and current canary. | CLI `recovery inventory/adopt/canary/drain/resources/preflight/profile/hold/resume/disable/enable`. |
| Dependency qualification | Fixture and served-browser checks are opt-in. Native or live proof requires an existing protected disposable admission and exact route and owner signatures. | `scripts/qualify-dependency-plans.mjs` runs the aggregate or verifies saved evidence. The console shows saved capabilities and blockers. |
| Context, publication and private packages | Implemented approvals, snapshots and preflight at dispatch. Task details show saved source and capability limits. | Review/resnapshot explicitly and configure credentials through existing operator setup. |
| Capacity, cooldown and budgets | System shows occupied reservations, saved capacity waits and service cooldown deadlines. Local System also shows storage headroom and recorded cleanup. Task routes identify provider cap support and unknown task-wide spend. | CLI `recovery resources` supplies task-specific headroom and cleanup guidance. |
| Learning | Implemented collection, candidate inspection and reviewed lifecycle. Production injection remains unvalidated without exact qualification and signing/isolation proof. | CLI `learn`, `doctor/setup/configure/list/report/show/approve/retire/reject/revise/explain/recover/prune/extract` subcommands. Extraction is explicit and budgeted. |
| Delivery integrations, plugins and notifications | Implemented delivery contracts, MCP packaging, collaboration hooks and Command Center embedding. Installed host and plugin behavior needs its own evidence. System shows saved collaboration observations where configured. | CLI/package setup for `task-delivery-package`, `task-delivery-state`, `task-pr` and `task-review`. Use existing operator flows for notifications and promotion. |
| Company roles, setup and mandates | Planned. Company policies, renewal, scheduling and standing admission need qualified Actor and policy services with scoped authority. | No console setup or policy control is enabled. |
| External product work and delegated integration | Planned. External activities need their original effect and cost owner. Delegated integration needs independently qualified policy and host guarantees. | No external send, native publication, deploy or delegated merge control is enabled. |

See [console navigation and read scope](app.md), [commands](commands.md),
[execution boundaries](execution.md), [dependency plans](dependency-plans.md)
[dependency delivery qualification](dependency-plan-qualification.md), and
[recovery qualification](recovery-qualification.md).
