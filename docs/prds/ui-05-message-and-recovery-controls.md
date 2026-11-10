---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/task-controls-desktop.png
  - docs/ui/previews/task-controls-mobile.png
aport_decision: 8d3a8f34-e110-4bd2-af13-05928f5adf1c
---

# Make agent messaging and recovery controls clear and reliable

## Problem

Operators need to correct an agent while work is active and continue a task after a worker has stopped. Similar-looking actions and generic request failures make it difficult to tell whether a message reached the coordinator, whether work will resume, or whether clicking again will create duplicate work. A polished control surface must explain each action, retain drafts and preserve context while using the existing durable control mechanism.

## User stories

- As an operator, I want to send a contextual message without confusing it with a fixed recovery action, so that I can correct work safely.
- As a returning user, I want to distinguish queued, applied and failed requests, so that I know whether intervention is needed.
- As a keyboard or mobile user, I want accessible controls with retained drafts, so that refreshes do not erase my work.

## Implementation constraints

- Build on milestones 1–4 and their shared projection, components and polling controller. Use requestControl, controlAvailability and the coordinator's existing action handlers.
- Keep the protected /api/run/control route and all existing authorization, revision and mutation-lock checks. If browser retries need request identity exposed, extend this route additively using the bounded requestId already supported by the control service.
- Message is a composer; Resume and Recheck are separate contextual buttons. Place destructive Cancel in a secondary area. Do not add a new worker-spawning endpoint or mutate state directly.
- Persist drafts per instance and task using a bounded local strategy with clear discard behavior; do not persist credentials or copy messages into URLs or diagnostics.

## Acceptance criteria

- Given an active or stopped task with available controls, When its action area opens, Then Message, Resume, Recheck and Cancel have distinct labels, explanations and effects matching existing controlAvailability.
- Given a message draft and task context, When polling, navigation or a failed submission occurs, Then the draft, caret and reading position survive appropriately without leaking into another task.
- Given ordinary messaging, When the user sends a message, Then interruption is off by default; any supported interruption option is explicit and explains what happens to current work.
- Given queued, applying, applied, failed or uncertain control requests, When status changes, Then the UI shows that exact state, meaningful timestamps and a useful next step; applied does not claim model acknowledgement or task completion.
- Given a timed-out response or double click, When the user retries, Then the UI reconciles the existing request and uses its identity rather than silently submitting duplicate paid work.
- Given a completed worker on an open task, When a correction is accepted, Then continuation preserves existing task context through the existing service; merged or closed work uses only supported follow-up behavior and cannot masquerade as an editable active run.
- Given changed briefs, exhausted authority or unavailable capabilities, When Resume or Recheck is considered, Then the existing gate and reason remain visible; neither action silently approves changes, resets counts or claims to rerun CI.
- Given cancellation, When confirmation is accepted, Then the UI scopes it to the intended task and shows uncertain remote cancellation honestly until authoritative acknowledgement arrives.
- Given protected routes and malicious message content, When controls are exercised, Then existing loopback, Origin, token, content-type, allowlist and escaping protections remain effective.
- Given synthetic server-backed control fixtures, When keyboard, mobile, failure and retry journeys run, Then actual handler requests and visible state transitions pass browser tests and the approved captures show the finished interaction.

## Verify

- `npm run lint`
- `node --test test/tracker_controls.test.mjs test/control.test.mjs test/resume.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/commands/serve.mjs, lib/control.mjs and lib/commands/resume.mjs
- lib/tracker/, templates/tracker/ and test/tracker_controls.test.mjs

## Out of scope

- New chat transport, Telegram integration or a second control store.
- Bypassing coordinator gates, automatic approval, arbitrary shell execution or changes to active real jobs.
