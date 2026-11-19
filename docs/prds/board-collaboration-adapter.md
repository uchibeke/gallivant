---
status: ready
harness: codex
sources:
  - docs/task-delivery.md
  - docs/guardrails.md
  - docs/app.md
aport_decision: 66c199ca-7846-4dee-a06a-f02c8d2e2239
---

# Add an optional Vercel Board collaboration adapter

## Problem

Gallivant already owns task contracts, execution sessions, review evidence and merge gates, while teams often coordinate work in channels and threads. Vercel Board offers an event-oriented collaboration substrate, but making it Gallivant's state store or treating replies as authority would weaken task immutability and invite prompt injection. This milestone adds a sanitized, optional and initially one-way adapter for significant task transitions without changing who approves briefs, code or protected actions.

## User stories

- As an operator, I want important Gallivant transitions summarized in a collaboration thread, so that I can follow work without polling another dashboard.
- As a task owner, I want a Needs owner queue for blocked human decisions, so that requests for action do not disappear inside agent activity.
- As a security reviewer, I want external messages treated as untrusted context, so that a Board reply cannot approve a brief, merge code or bypass APort.
- As a maintainer, I want idempotent replay and destination health, so that daemon restarts and retries do not duplicate threads or lose canonical task state.

## Implementation constraints

- Add a generic `CollaborationAdapter` boundary and a Board implementation; Gallivant state, Git host evidence and saved PRD snapshots remain canonical.
- Start one-way. Inbound messages may be collected as untrusted suggestions only after a separate opt-in path and never become control actions.
- Map one Gallivant task/run to one external thread. Emit significant transitions, not raw logs, model prompts, diffs or every observation.
- Credentials, destinations, access policy and retention belong in private configuration; no Board account, project or channel is hardcoded.

## Acceptance criteria

- Given collaboration is not configured, When Gallivant runs, Then behavior, task state, review loop, dashboard and delivery APIs remain unchanged with no Board dependency or network call.
- Given a configured Board adapter, When a task is accepted, starts, opens a PR, needs owner input, stops, resumes or becomes ready, Then one structured versioned event updates the task's thread with actor/source provenance and a canonical Gallivant deep link.
- Given retries, daemon restart or duplicate transition delivery, When the adapter writes, Then Gallivant task/run/event IDs form stable idempotency keys and only one logical thread and transition record exist.
- Given high-volume session output, comments, checks and logs, When routing evaluates them, Then only configured significant state changes are exported and prompts, transcripts, credentials, local paths, raw diffs and private configuration are absent.
- Given a task needs an owner decision, When the transition is emitted, Then it appears in a dedicated Needs owner channel or view with task, bounded reason, requested decision, expiry and link back to Gallivant.
- Given Board snapshot, cursor and live events, When the adapter reconnects, Then it resumes from durable Gallivant event state and does not rely on a local Board timer surviving process restart.
- Given Board is unavailable, rate-limited or rejects access, When Gallivant continues, Then execution and review remain available, delivery failure is bounded and visible, and collaboration retries cannot consume implementation rounds.
- Given a Board reply, synchronized message or agent-authored block, When inbound support is disabled, Then it is ignored for control; when separately enabled, Then it is stored only as untrusted suggestion text with provenance.
- Given any inbound content, When Gallivant evaluates control authority, Then it cannot approve or resnapshot a brief, change acceptance criteria, merge a PR, expand scope, alter review policy, release a chain gate or bypass an APort decision.
- Given Board access and retention broader than the task's configured policy, When setup or doctor runs, Then enablement refuses or reports the exact unresolved risk before sending task data.
- Given adapter tests, When synthetic Board responses cover allow, deny, timeout, replay and malformed blocks, Then secrets remain outside logs and canonical task state is unchanged by destination content.

## Verify

- `npm run lint`
- `node --test test/task-delivery.test.mjs test/events.test.mjs test/tick.test.mjs`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs`
- `npm run test:install`
- `git diff --check`

## Where to look

- `lib/task_delivery.mjs`, `lib/events.mjs` and `lib/tick.mjs`
- `lib/tracker/`, `lib/commands/serve.mjs` and notification/integration boundaries
- `docs/task-delivery.md`, `docs/guardrails.md`, `docs/app.md` and `test/`

## Out of scope

- Replacing Gallivant state, Git host evidence, PRD snapshots or review gates with Board.
- Two-way control, automatic merge, brief approval, raw session mirroring or a required hosted dependency.
