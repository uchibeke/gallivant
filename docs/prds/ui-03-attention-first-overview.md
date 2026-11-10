---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/overview-desktop.png
  - docs/ui/previews/overview-mobile.png
aport_decision: 14990d1e-b433-4963-96d2-ae5db7b2a32d
---

# Build an attention-first operations overview

## Problem

Returning users currently have to read state codes and visit several task logs to determine what actually needs attention. Running, waiting, ready and blocked work compete in similar table rows, and the interface does not expose enough context to choose the next action confidently. A substantial overview redesign must prioritize decisions, explain blockers and make many repositories scannable while retaining truthful status, responsive behavior and the same backend authority.

## User stories

- As a returning operator, I want actionable blockers and next steps first, so that I can resolve the highest-impact decisions quickly.
- As a multi-repository operator, I want fast discovery and useful task summaries, so that I can find work without opening every run.
- As a mobile user, I want the same essential information and actions in a compact layout, so that I can safely check progress away from my desk.

## Implementation constraints

- Milestones 1 and 2 must be merged. Compose the overview from their shell, primitives and shared presentation model; do not add a second mapping of task states.
- Separate needs attention, ready for review/integration, progressing and externally waiting work. Use a deliberate compact task layout with expandable context, not nested decorative cards or an always-expanded wall of logs.
- Use the existing state/configured capabilities to enable destinations. Keep New task honestly unavailable until milestone 7 supplies its implementation.

## Acceptance criteria

- Given tasks with brief divergence, missing prerequisites, failed control requests, review findings, retry waits and qualified readiness, When the overview opens, Then actionable attention and its specific next step appear first while automatic/external waits are visibly distinguished from operator decisions.
- Given an attention item, When expanded or opened, Then the user sees a plain-language explanation, technical reason on demand, last meaningful activity, relevant task/PR link and only context-valid controls or accurate remediation instructions.
- Given active work across repositories and harnesses, When scanning a task summary, Then identity, phase, meaningful age, current delivery/review/check summary, round usage and chain position can be understood together without reading raw logs.
- Given summary counts, When filters or pagination change, Then counts identify their scope and reflect real shared-model data; no decorative chart, synthetic completion percentage or fabricated throughput is introduced.
- Given search and filters for repository, phase, harness, attention and chain, When navigation, refresh or browser back occurs, Then the URL preserves valid selected filters and pagination without mutating tasks or silently resetting the user's context.
- Given 1,000 tasks, When the overview loads and searches, Then rows are bounded by pagination/windowing, meaningful totals remain correct and there are no per-row remote requests or full transcript loads.
- Given a failed or slow status fetch, When refresh cannot complete, Then the last good snapshot remains visible with a clear stale/disconnected indicator and bounded retry instead of an empty or falsely current screen.
- Given polling updates, When the user is selecting text, expanding context, navigating by keyboard or reading a scrolled list, Then keyed updates preserve focus, expansion and scroll and do not reset activity ages to now.
- Given both themes, five contracted widths, long repository names and 200% zoom, When the overview renders, Then the hierarchy is visibly transformed, primary actions remain discoverable and no essential field relies on hover or color alone.
- Given the overview desktop and mobile browser captures, When the PR is reviewed, Then the approved images show real rendered fixtures, match the implementation and demonstrate improved hierarchy against milestone 1's baseline.

## Verify

- `npm run lint`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/tracker/pages.mjs, templates/tracker/tracker.css and templates/tracker/tracker.js
- lib/commands/status.mjs and the shared presentation modules from milestone 2
- lib/commands/serve.mjs and browser fixtures from milestone 1
- test/tracker.test.mjs and test/tracker_controls.test.mjs

## Out of scope

- A second task store, new readiness rules, automatic recovery or paid work triggered by viewing the dashboard.
- Bulk starts, bulk cancellation, merge/deploy buttons or unsupported future destinations.
- Lookout, external analytics, live user data in screenshots or a frontend framework migration.
