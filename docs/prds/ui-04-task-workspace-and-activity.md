---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/task-workspace-desktop.png
  - docs/ui/previews/task-workspace-mobile.png
aport_decision: b93a7eef-f3be-4ac2-ab82-5c42917fe363
---

# Create a coherent task workspace and bounded activity view

## Problem

An operator investigating a stalled or completed task currently moves between run logs, reviewer messages, task state and PR evidence. Attempt identity and task identity can be confused, and a log-heavy page hides the information needed to assess delivery readiness. This milestone reorganizes task detail into a polished workspace that presents progress, evidence, history and recovery context together while keeping raw output optional, bounded and subordinate to canonical task facts.

## User stories

- As an operator, I want one task workspace with progress and delivery evidence, so that I can understand the current situation without stitching together several pages.
- As a reviewer, I want current-head CI, review findings and acceptance evidence visible together, so that I can judge whether work is ready.
- As a developer, I want bounded, navigable attempt and activity history, so that I can diagnose problems without losing my selected run or exposing unrelated output.

## Implementation constraints

- Milestones 1 through 3 must be merged. Reuse shared projections and components for the header, evidence panels, notices and status badges.
- Organize the workspace around Overview, Activity and Attempts/Evidence where useful; use accessible tabs or progressive disclosure rather than hiding critical blockers. The PR/delivery remains a safe link to its existing owner.
- Use existing logWindow, output/history routes, harness_log parser, reviewActivity and execution journal/result projections. Never load a raw provider manifest or an entire transcript just to populate a summary.

## Acceptance criteria

- Given a task, When its workspace opens, Then the header establishes task versus selected attempt, repository/base, delivery target, evidenced phase, blocker/next step, activity age, round usage and chain context without requiring the log panel.
- Given a task with PR and current-head observations, When viewing readiness, Then CI, independent/external review and acceptance/owner-delivery evidence have separate truthful statuses, provenance and links, including stale-head, no-CI, missing and gate-skipped cases.
- Given local or hosted execution, When provider/model, session continuity, output/artifact or cost details are available, Then the workspace shows only recorded bounded metadata with explicit unknown values and preserves configured capability limitations.
- Given reviewer findings and background review activity, When feedback arrives, Then summarized actionable findings and review progress are visible separately from author output and cannot be mistaken for operator messages or a passed gate.
- Given multiple attempts or a historical run URL, When selecting, reloading or navigating back, Then the selected run, its duration and output remain correctly bound; newer activity never silently replaces an intentionally selected historical attempt.
- Given a large mixed event/log history, When searching or paging older output, Then the existing cursor/tail mechanisms preserve ordering, provenance, truncation/gap disclosure and deduplication without rendering all 10,000 events.
- Given live output, When the operator scrolls away from the bottom, Then auto-scroll pauses, a new-activity affordance appears and the page preserves selection/focus until the user chooses to follow live output again.
- Given absent evidence, a retrieval failure or disconnected provider, When the workspace refreshes, Then it preserves the last good data with source-specific freshness and an actionable retry explanation, without claiming the worker failed or the task completed.
- Given task/source text containing markup, tokens or hostile links, When rendered in summaries and activity, Then existing escaping, redaction and URL validation remain enforced and unrelated files or raw credentials are not exposed.
- Given mobile, desktop, keyboard navigation, zoom and both themes, When the workspace is inspected and captured, Then the summary/action context stays accessible, code/log overflow is contained and the approved desktop/mobile captures show the actual rendered product.

## Verify

- `npm run lint`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs test/task-completion.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/tracker/pages.mjs, lib/tracker/runs.mjs, lib/tracker/review.mjs and lib/tracker/stream.mjs
- lib/commands/serve.mjs, lib/harness_log.mjs and lib/run_log.mjs
- lib/task_delivery_view.mjs, lib/task_completion.mjs and lib/execution_journal.mjs
- Shared components, projections and browser fixtures from milestones 1 through 3

## Out of scope

- Reading arbitrary filesystem paths or unbounded raw provider results from a browser request.
- New host polling, reviewer decision logic, acceptance authority or permission grants.
- Redefining control effects, changing existing running jobs or adding Lookout.
