---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
aport_decision: 9b0c9c1a-0907-4c33-b748-de44663d40ab
---

# Unify truthful task status and presentation projections

## Problem

The tracker currently combines raw task state, provider liveness, review state and polling timestamps in page-specific presentation logic. A richer dashboard would become misleading if each view inferred its own phase, completion or recovery action. Operators need consistent explanations for pending checks, changed briefs, stopped workers and valid delivery readiness. This milestone creates reusable presentation projections over the existing canonical services so the redesigned views agree without adding a second decision engine.

## User stories

- As an operator, I want an honest phase, blocker and next step for every task, so that I know whether to wait, inspect or act.
- As a reviewer, I want readiness and integration evidence distinguished from worker exit, so that a finished process never implies accepted work.
- As a maintainer, I want one tested presentation contract across CLI, API and HTML, so that features and failure cases do not drift between views.

## Implementation constraints

- Milestone 1 must be merged. Reuse its primitives and browser fixtures. Introduce focused pure selectors under the tracker/presentation boundary, rather than enlarging page renderers or moving policy into browser JavaScript.
- Reuse model(ctx), taskView, completionView, chainRows, reviewActivity/review policy projections, provider-health observations, execution capabilities and controlAvailability. Add only missing read-only fields needed for the views.
- Keep raw canonical facts and their provenance accessible. Handle legacy records explicitly. Presentation-only labels may improve while CLI/API state codes, existing fields and lifecycle semantics stay compatible.

## Acceptance criteria

- Given planning, implementing, verifying, independent review, remote review, CI wait, retry wait, operator attention, delivery readiness, integration and closure cases, When a shared projection is built, Then each exposes only an evidenced phase and distinct actor/blocker/next-action facts, with unknown when the source cannot prove a finer phase.
- Given a worker exit, skipped receipt gate, stale-head review, closed unmerged delivery or missing owner-delivery evidence, When status is projected, Then no view shows verified completion or integration contrary to completionView and current canonical evidence.
- Given pending sign-in/readiness refresh, API access unchecked, exhausted quota, unsupported dispatch or unavailable credentials, When provider status is rendered, Then these cases remain distinct and no observed binary/sign-in check is advertised as successful inference access.
- Given routine polls with no meaningful task events, When snapshots refresh, Then last meaningful activity and since remain stable while observed-at/freshness can advance; missing or invalid timestamps display unknown rather than now.
- Given current and historical execution attempts, When duration or round usage is shown, Then it derives from the matching attempt and canonical accounting, uses elapsed versus ended duration correctly and never invents percentages, costs, token counts or ETAs.
- Given GitHub, Bitbucket, local harnesses and hosted execution observations, When the same lifecycle fixtures are projected, Then the same shared selectors apply with capability-based differences and without host/provider-specific copies of readiness logic.
- Given an ended run still awaiting reconciliation or an uncertain remote cancellation, When attention and controls are projected, Then the unresolved ownership is visible and the model cannot authorize another writer.
- Given overview, task detail and API/CLI summaries of the same fixture, When compared, Then their phase, reason, readiness, delivery target, meaningful activity and next-action facts agree and older API consumers retain existing required fields.
- Given 1,000 synthetic tasks, When projection is requested, Then it introduces no per-row Git/host/model/probe calls or state writes and renderer tests assert bounded data and pure projection behavior.
- Given missing, malformed or legacy observations, When projection cannot establish a fact, Then the page remains usable with a bounded diagnostic and no raw secrets, provider payloads or unescaped source prose.

## Verify

- `npm run lint`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs test/control.test.mjs test/task-completion.test.mjs test/why.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/commands/status.mjs, lib/task_delivery_view.mjs and lib/task_completion.mjs
- lib/control_contract.mjs, lib/review_policy.mjs and lib/tracker/review.mjs
- lib/provider_health.mjs, lib/execution.mjs and lib/chains.mjs
- lib/tracker/pages.mjs and existing tracker/completion tests

## Out of scope

- Changing task policy, acceptance criteria, review qualification, merge authority or retry/budget limits.
- Inferring implementation phases or reviewer verdicts by searching raw transcript prose.
- New telemetry, background probes, state migrations or Lookout support.
