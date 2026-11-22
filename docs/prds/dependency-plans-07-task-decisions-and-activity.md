---
status: ready
harness: codex
sources:
  - docs/plans/dependency-plans-and-console.md
  - docs/plans/delivery-console-experience.md
  - docs/plans/company-autonomy-and-executor-boundaries.md
  - docs/plans/dependency-plans-console-delivery.md
aport_decision: 571781c6-90d6-45c5-a803-a99e71c15e2b
---

# Bring task decisions evidence and recovery into one workspace

## Problem

Recent execution, review and recovery additions are difficult to understand when operators must move between a run log, CLI and separate status pages. Task control acceptance also differs from task completion. Consolidate the operator experience around outcome, dependencies, evidence and next action, using existing lifecycle services rather than adding UI-only behavior or making planned capabilities appear supported.

## User stories

- As an operator, I want one clear next action and evidence, so that I can steer work without guessing which button restarts it.
- As a reviewer, I want head-bound quality and recovery context, so that old passes cannot look current.

## Acceptance criteria

- Given milestone 05 shared projections and the console feature matrix, when opening Overview or a task, then lead with actionable blockers, responsible actor, phase, meaningful age, dependency/plan context, actual outcome and next action. Show ready versus integrated, failed versus closed/cancelled, reviewer pieces/findings, canonical CI, acceptance/delivery and stale/missing evidence distinctly.
- Given current execution/recovery capabilities, when inspecting, then show approved harness/provider/model/transport, continuation and cancellation qualification, profile/hold, stable incident and step, pinned repair base, next retry, task rounds versus incident attempts, recorded usage and unknown enforcement. Unsupported hosted/learning/company features expose truthful limits or safe CLI guidance rather than working-looking controls.
- Given Message agent, Resume, Recheck and cancel, when submitted, then preserve their distinct semantics and show idle/submitting/queued/accepted/working/final/uncertain states with the saved request identity. Acceptance is not completed correction. Lost responses refresh/reconcile; no duplicate POST, public register/reset shortcut, round reset or implicit resnapshot.
- Given task versus historical attempt selection, when navigating, then preserve each attempt's own session/provider/timing/cost and bind current task evidence separately. A compact provenance timeline links original failure, review, recovery and delivery without duplicating full logs or exposing credentials. Logs stay optional diagnostics.
- Given navigation/refresh, when updates arrive, then retain shell, focus, scroll, URL selection, disclosures and filters with shared skeletons and bounded controllers. All external PR links use the safe new-tab helper. Counts and active tabs agree; meaningful age never becomes Now because a page polled.
- Given System, when viewed, then use existing health/storage/capability observations for coordinator availability, scope cooldowns, actual capacity, bytes/inodes, retained cleanup and supervisor limits. No generic purge/kill/credential editor or health probe from GET. Future company goal/mandate/external receipt sections appear only with qualified backend data and tenant authorization.
- Given served-browser fixtures, when tested, then cover missing/empty/stale/error/permission states, changed briefs, failed review, pending Message, capacity/long cooldown, old attempts, both mounts/themes, keyboard/reduced motion, 360–1440 widths, mobile landscape and 200% zoom. Capture synthetic representative pages, audit all labels/icons/targets and document actual supported controls.

## Implementation boundaries

Create `test/ui/factory-task-workspace.test.mjs`; extend existing workspace/control tests. Reuse shared presentation, time, primitive, link and controller modules. Keep product flows free of irrelevant implementation internals until disclosure. No SPA rewrite, new runtime status parser, giant activity archive or second reviewer/coordinator. Milestone 06 and this work share milestone 05 contracts; land sequentially with current CLI or in parallel only after graph support is qualified.

## Verify

- `node --test --test-concurrency=1 test/ui/factory-task-workspace.test.mjs`
- `node --test test/factory-projection.test.mjs test/tracker_controls.test.mjs test/tracker-presentation.test.mjs`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/tracker/pages.mjs`, `lib/tracker/workspace.mjs`, `lib/tracker/overview.mjs`
- `lib/tracker/controls.mjs`, `lib/tracker/health_page.mjs`, `templates/tracker/`, `test/ui/`

## Out of scope

- New delivery/approval semantics, secret editing or automatic policy activation.
- Replacing current review, recovery, storage or provider services.
