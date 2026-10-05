---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
aport_decision: c35f0ce2-3e59-4c51-8d13-f4e77ff4c0dc
---

# Turn natural-language tasks into validated Gallivant work

## Problem

Gallivant currently expects a manually authored PRD before it can implement work. Users starting in a terminal or future ChatGPT plugin instead describe an outcome and need help resolving requirements, generating a verifiable brief and starting the existing loop. Building this separately inside a plugin would duplicate validation, task state and launch logic. This milestone makes natural-language intake a reusable Gallivant capability while preserving hand-authored PRDs and existing execution behavior.

## User stories

- As an operator, I want to describe work naturally, so that I can start without manually formatting a PRD.
- As a task owner, I want material questions and explicit assumptions, so that the implementation matches my intended outcome.
- As an operator, I want authorized work to proceed through readiness and execution, so that I do not repeat approvals or launch commands.
- As a plugin developer, I want structured task operations, so that every interface uses Gallivant's own workflow.
- As an existing user, I want my PRDs, settings and running jobs preserved, so that this feature is an additive improvement.

## Acceptance criteria

- Given text or stdin and an explicit or resolved repository, when `gallivant task` prepares work, then the shared intake service saves a stable task ID, original input, repository/base, selected harness and resumable preparation state without starting implementation or changing unrelated files.
- Given relevant repository instructions and selected context, when requirements are drafted, then every explicit user requirement maps to a criterion or visible unresolved conflict, Verify commands fit the repository, assumptions are identified, and the generated canonical PRD satisfies contract G2 in the carried plan.
- Given a material unknown or conflicting requirement, when preparation cannot safely resolve it, then CLI and structured callers receive the same concise questions and answer identifiers; later answers resume that intake rather than creating another task. Noninteractive input never waits indefinitely for a terminal answer.
- Given a configured existing harness, when preparation runs, then it uses Gallivant's existing execution facilities in an isolated draft workspace with recorded usage and bounded repair attempts; it neither opens a PR nor implements the requested feature while merely preparing the brief.
- Given a generated draft, when validation or repair runs, then it calls the existing PRD checker and readiness decision path, preserves explicit requirements, and repairs at most three times before reporting actionable unresolved failures. A denied readiness decision cannot be replaced by an invented pass.
- Given `--run` authorization and resolved requirements, when the exact generated revision passes readiness, then the shared service invokes the existing start path once and continues through the normal daemon. Preparation without `--run` returns the draft and next action; approved work requires no redundant confirmation.
- Given a retry, duplicate answer, crash between readiness and dispatch, or stale brief revision, when intake is reopened or started again, then task identity, snapshots and dispatch ownership reconcile without duplicate implementation runs, and stale writes return a conflict rather than overwrite accepted requirements.
- Given source documents present only in the operator checkout, when a generated PRD carries them, then existing `sources` validation and snapshot delivery make them available in the isolated run without requiring remote main copies; unauthorized paths and secret/config directories remain refused.
- Given a hand-authored PRD or existing running job, when the new feature is installed, then `new`, `ready`, `start`, `resume`, review, completion, chains, status and tracker controls retain their previous behavior and no model, provider or permission defaults change.
- Given the task service, when CLI and an in-process structured client perform equivalent preparation, answer, validate and start operations, then they receive versioned results and equivalent state transitions through the same implementation. Exporting it must not trigger global configuration reads, network calls or a daemon at import time.
- Given deterministic intake fixtures covering a clear request, ambiguity, conflicting constraints, hostile context, invalid generated output and duplicate dispatch, when the focused suite runs, then observable requirements and lifecycle outcomes pass without model calls, and tests demonstrate that explicit constraints survive repair.
- Given authorized live execution prerequisites from G8, when one natural-language task is exercised, then saved evidence shows the original request, resulting requirements, readiness decision, implementation dispatch and review outcome; unavailable external prerequisites remain explicitly unverified rather than reported as a live pass.
- Given the final implementation, when documentation and audit artifacts are delivered, then CLI help, structured operation examples, source mapping and a concise G8 evidence record explain preparation versus execution, stopping conditions and exact validation commands, and the PR contains a truthful criterion-by-criterion receipt.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:task-intake`
- `git diff --check`

Implement the focused script as part of this change. Ordinary verification must not invoke paid providers. Follow G8 separately for opt-in live evidence; passing offline tests does not establish live support.

## Where to look

- `docs/plans/plugin-ready-gallivant.md` is carried into the checkout. Implement G1, G2 and applicable G8 requirements; G3-G7 describe successor compatibility, not additional hosted features for this PR.
- `bin/gallivant.mjs`, `lib/commands/new.mjs`, `lib/commands/ready.mjs`, `lib/commands/start.mjs`, `lib/sources/`, `lib/prd.mjs`, `lib/deliverable.mjs` own intake, readiness and start contracts.
- `lib/context.mjs`, `lib/run.mjs`, `lib/state.mjs`, `lib/control.mjs`, `lib/commands/status.mjs`, `lib/commands/why.mjs` provide existing execution and state mechanics.
- `test/prd.test.mjs`, `test/sources.test.mjs`, `test/carried.test.mjs`, `test/divergence.test.mjs`, `test/commands.test.mjs`, `test/control.test.mjs`, `docs/prd.md`, `docs/commands.md` cover behavior to preserve.

## Out of scope

- Hosted harness implementations, plugin UI/transport, public deployments, directory submission and billing products belong to later milestones or release operations.
- A new orchestration loop, a separate runner repository, changes to other repositories, global settings changes, automatic merges and unlimited requirement-repair loops.
- Treating readiness validation as semantic correctness, fabricated test evidence, or permission to execute work that the user only asked to plan.
