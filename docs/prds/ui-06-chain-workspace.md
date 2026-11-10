---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/chains-desktop.png
  - docs/ui/previews/chains-mobile.png
aport_decision: 68e6b6aa-59ef-4c03-b6d8-ed828e047a53
---

# Make chain progress and dependency recovery understandable

## Problem

Multi-day work requires an operator to understand what has shipped, what is waiting for a merge and what prevents the next milestone from starting. A collection of unrelated run rows hides dependency context and encourages unnecessary restarts. The interface needs a coherent chain workspace that explains the existing scheduler's decisions, links every milestone to its task and exposes only the recovery operations already authorized by the chain service.

## User stories

- As a chain owner, I want ordered milestones and the exact next gate, so that I can leave work unattended with confidence.
- As an operator, I want explicit recovery scope, so that retrying future work does not accidentally restart a worker.
- As a reviewer, I want task and PR links within chain context, so that I can merge the right predecessor.

## Implementation constraints

- Build on milestones 1–5. Reuse chainRows, queueChain, retryChain, cancelChain and existing fingerprint/base/merge semantics; do not create a browser scheduler.
- Prefer existing read projections. If chain mutations lack HTTP adapters, add thin protected adapters around those services with the same locking, input validation and authorization conventions as run controls.
- Use a responsive ordered list with an optional wide-screen dependency visualization. Preserve a fully accessible list alternative and URL-addressable selected milestone.
- Keep new chain creation in the existing CLI for this milestone. Any displayed command must be safely quoted, copyable and derived from approved repository identities.

## Acceptance criteria

- Given a chain with queued, active, delivery-ready, merged, closed-unmerged, changed-brief, stopped or cancelled milestones, When opened, Then each state and the next blocking dependency are explained using authoritative evidence.
- Given an ended worker or ready PR, When progress is counted, Then it is distinguished from a merged dependency and cannot advance the visible chain as integrated.
- Given a selected milestone, When navigating to its task, PR and back, Then selection, filters and chain context remain discoverable across root and mounted URLs.
- Given base, target, source or fingerprint changes, When recovery is offered, Then the UI shows the relevant identity and reviewed differences without exposing sensitive files or accepting changes automatically.
- Given retry of future milestones, When confirmed, Then the existing service is invoked once with the exact reviewed revision; the UI explains that this does not resume workers or reset their budgets.
- Given cancellation of future milestones, When confirmed, Then only the existing service's stated scope is affected and an active worker is not implicitly cancelled.
- Given an unsupported or unauthorized chain action, When displayed, Then it has a meaningful unavailable reason and no alternate mutation path bypasses the gate.
- Given a large chain list and repeated refreshes, When rendered, Then bounded shared polling and list rendering introduce no per-milestone host API calls or duplicate event subscriptions.
- Given chain fixtures and changed-brief failures, When unit and browser journeys execute, Then merge gating, retry, cancellation, URL history and protected mutation behavior pass without real task dispatch.
- Given both themes and narrow screens, When the workspace is reviewed, Then dependency order and next steps remain readable and genuine approved desktop/mobile captures demonstrate the result.

## Verify

- `npm run lint`
- `node --test test/chains.test.mjs test/chain_io.test.mjs test/tracker.test.mjs test/control.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/chains.mjs, bin/gallivant.mjs and test/chain_io.test.mjs
- lib/commands/status.mjs, lib/tracker/ and docs/chains.md

## Out of scope

- New dependency semantics, automatic merges or a second task scheduler.
- Bulk queue-builder redesign, Lookout integration or starting existing real chains.
