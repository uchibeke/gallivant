---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
  - docs/plans/plugin-hosting-and-live-tests.md
  - docs/prds/natural-language-tasks.md
aport_decision: aff7ae2d-ace0-4008-bc80-d92f3c84347b
---

# Prepare Gallivant execution, polling and logs for remote jobs

## Problem

Gallivant currently identifies work through a local process, binary and checkout. Its global health probes can prevent all tasks from advancing when one harness fails, and log streaming repeatedly reads growing files in full. Remote jobs outlive submission clients and require durable identities, independent polling and truthful progress. This milestone builds one shared execution boundary and observable lifecycle before adding either remote provider, while preserving local harnesses, review decisions and Command Center compatibility.

## User stories

- As an operator, I want remote-aware lifecycle operations, so that jobs survive launcher exit and coordinator restarts.
- As a user, I want responsive progress and recoverable logs, so that I can understand work without freezing the interface.
- As an operator, I want independent provider health checks, so that one unavailable account does not block unrelated jobs.
- As a maintainer, I want shared execution and review contracts, so that each backend implements transport instead of another orchestration loop.

## Acceptance criteria

- Given the intake milestone merged into the selected base, when implementation starts, then it reuses that task service and current lifecycle code; missing predecessor code stops with a dependency error rather than being recreated.
- Given an execution provider, when preparation, submit, inspect, continue, collect and cancel are requested, then one capability registry and execution boundary express supported authentication, environments, continuation, observability and cost controls without requiring a fake executable or PID. Existing CLI adapter behavior and public identities remain compatible.
- Given duplicate requests, lost submission replies or a crash between intent and acknowledgement, when recovery runs, then persisted task ownership, provider identities and idempotency metadata prevent duplicate paid dispatch; unknown acceptance remains visibly unresolved until reconciled.
- Given slow or failing provider probes, when the coordinator ticks, then bounded I/O, account/provider-scoped health, backoff and separate progress/review schedules allow unrelated jobs and GitHub review to progress. Read-only UI/MCP polling cannot create independent provider loops or trigger paid work.
- Given remote progress, stale observations, missing events or launcher exit, when status changes, then G3a states and timestamps distinguish provider liveness from workflow/review readiness; no silence, local PID or cached value settles a remote task. Startup and periodic reconciliation repair missed notifications.
- Given local output or normalized remote events, when journaled, then versioned records and compatible job files preserve stable task/run/event identities, ordering, provenance and redaction through retries, replay, rotation and restart. Unrecoverable history has explicit gaps; secrets never enter public projections.
- Given a large log, reconnect or slow subscriber, when tracker/Command Center tail and history are read, then bounded incremental/indexed reads, stable replay IDs, pagination, heartbeat, backpressure and disconnect cleanup satisfy G3a; the existing routes remain compatible and task results are independent of log retention.
- Given cancel, timeout, exhausted allowance or unsupported interrupt, when a control executes, then capability-aware state prevents overlapping work and further dispatch, distinguishes cancellation requested from confirmed, and quarantines late results. Unknown cost is never zero and stopping a submission client is not remote cancellation.
- Given code/results from any provider, when they enter GitHub, then the existing single PR writer validates input head, branch ownership and paths, reconciles already applied changes and records real verification evidence. Readiness, trusted feedback, head freshness, receipts, conflict handling, rounds and human merge boundaries stay canonical.
- Given legacy registry entries and a coordinator upgrade, when migration, restart or rollback occurs, then task/PR/session identity, queued chain snapshots and local active runs survive supported upgrades; incompatible state versions fail with an actionable remedy instead of redispatching.
- Given deterministic provider-shaped fixtures, when test:execution-backends runs, then local Codex and fake remote transports cover G3/G3a/G6, concurrent controls, out-of-order events, missing results, scoped outages and restart. Large-log tests assert bounded reads/buffers and unrelated task progress instead of relying on fragile wall-clock thresholds.
- Given the final change, when documentation and evidence are reviewed, then the exported transport contract, state schema, polling/log limits, controls and upgrade procedure are documented, with a truthful G8 receipt; neither unimplemented remote provider is advertised as available.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:execution-backends`
- `git diff --check`

Implement the focused offline script. No paid calls or unrelated production runs are needed for this foundation.

## Where to look

- `docs/plans/plugin-hosting-and-live-tests.md` carries the later hosting choice and bounded API-test authorization; it supersedes only the earlier unknown-setup statements.

- `docs/plans/plugin-ready-gallivant.md`, especially G1, G3, G3a, G6 and G8; G4/G5 belong to subsequent provider PRDs.
- `lib/harness.mjs`, `lib/config.mjs`, `lib/probe.mjs`, `lib/context.mjs`, `lib/run.mjs`, `lib/state.mjs`, `lib/control.mjs` own local assumptions.
- `lib/tick.mjs`, `lib/commands/up.mjs`, `lib/commands/start.mjs`, `lib/commands/resume.mjs`, `lib/chains.mjs`, `lib/daemon.mjs` own dispatch and recovery.
- `lib/tracker/stream.mjs`, `lib/tracker/runs.mjs`, `lib/harness_log.mjs`, `templates/tracker/`, `lib/git.mjs`, `lib/gh.mjs`, `lib/deliverable.mjs` provide interfaces to preserve.
- Existing `test/loop.test.mjs`, `test/recovery.test.mjs`, `test/review.test.mjs`, tracker, controls and public-format tests.

## Out of scope

- Implementing API or Cloud provider transports in this PR; those follow this foundation in the chain.
- A second scheduler/review engine, separate runner repository, cross-repository UI changes, automatic merges or rewriting frozen planning inputs.
- Public deployment, account changes, purchasing credits, default model changes or certifying fixture transports as live support.
