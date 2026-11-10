---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/task-intake-desktop.png
  - docs/ui/previews/task-intake-mobile.png
aport_decision: 49d61bcc-6bd3-440a-8d46-e38231de1a77
---

# Add guided task preparation with an explicit start boundary

## Problem

A useful task workspace should let someone describe work, answer clarification questions and inspect the resulting requirements before starting execution. The current interface lacks that coherent entry journey even though task intake and delivery contracts already exist. Building a separate browser planning engine would cause inconsistent permissions and duplicate logic. The UI must adapt existing services into a clear, revision-bound preparation and start flow with honest capability and cost boundaries.

## User stories

- As a new user, I want to describe a repository task and answer questions, so that I can prepare clear work without hand-writing every PRD.
- As an owner, I want to inspect the exact requirements and permissions before starting, so that execution matches what I approved.
- As a non-coding user, I want supported documentation and research deliverables explained, so that I understand the product's actual scope.

## Implementation constraints

- Build on milestones 1–6. Reuse existing task intake, profile, question, revision, readiness and delivery services. Add only protected HTTP adapters and shared browser presentation around these contracts.
- Inventory current API/service entry points first; route names and request schemas follow existing conventions. Do not create another task store, ownership mapper, completion engine or model selector.
- Select repositories only from existing approved configuration. No arbitrary filesystem browsing, credential forms, global configuration writes or unqualified provider fallback.
- Separate potentially paid preparation from explicit execution. Every mutation uses existing operation identity and expected revision semantics; GET and refresh remain read-only.

## Acceptance criteria

- Given an eligible configured repository, When a user enters a task request, Then the UI shows supported preparation options and an explicit preparation action with its provider and possible paid effect.
- Given preparation requires questions, When answers are saved or a request fails, Then existing question/revision services retain the correct answers and draft without silently starting execution.
- Given a prepared revision, When review opens, Then deliverables, acceptance criteria, verification, delivery destination and relevant permissions are readable in plain language before Start.
- Given an approved revision and explicit Start, When submitted, Then the existing readiness and delivery gates run once and the resulting task opens in its authoritative workspace.
- Given stale revisions, duplicate submissions, reloads or uncertain responses, When the user continues, Then operation identity and expected revision prevent duplicate tasks or approval of a different contract.
- Given an unsupported harness, unhealthy provider or missing repository capability, When preparation or Start is considered, Then truthful reasons and supported remedies appear without credential disclosure or silent provider switching.
- Given supported coding, research or documentation profiles, When examples and options appear, Then they describe actual implemented capabilities and retain their existing verification and ownership requirements.
- Given a read-only request or untrusted repository/task text, When the page loads or content renders, Then no paid call, execution, filesystem access widening or unescaped markup occurs.
- Given synthetic service-backed fixtures, When request, clarification, review, cancel and explicit-start journeys execute, Then protected route tests and browser tests prove contract parity without real inference or task dispatch.
- Given both themes, mobile and keyboard navigation, When the intake journey is completed, Then validation errors, focus order and summaries remain usable and approved genuine captures demonstrate the result.

## Verify

- `npm run lint`
- `node --test test/task-intake.test.mjs test/task-profile.test.mjs test/task-delivery.test.mjs test/task-delivery-cancellation.test.mjs test/control.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/tasks.mjs, lib/task_prepare.mjs, lib/task_profile.mjs and lib/task_delivery.mjs
- lib/commands/task.mjs, lib/commands/serve.mjs and docs/tasks.md
- test/task-intake.test.mjs, test/task-profile.test.mjs and test/task-delivery.test.mjs

## Out of scope

- New inference providers, hosted execution backends or a separate intake/approval engine.
- Publishing, deployment, automatic start on page load or changing global credentials.
