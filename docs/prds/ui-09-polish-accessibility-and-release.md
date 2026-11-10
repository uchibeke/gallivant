---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/final-overview-dark.png
  - docs/ui/previews/final-overview-light.png
  - docs/ui/previews/final-task-mobile.png
  - docs/ui/previews/final-chain-desktop.png
aport_decision: 3a05837d-9443-4ebf-b547-49319605a438
---

# Qualify the redesigned experience and update public guides

## Problem

A major redesign only delivers value when the whole journey feels coherent, works across supported environments and survives installation from the published package. Individually passing page tests do not establish that operators can prepare work, understand blockers, intervene and follow a chain without regressions. This milestone joins the completed interfaces into a polished, accessible product and provides reproducible browser, performance, packaging and documentation evidence before release.

## User stories

- As a user, I want a cohesive and accessible experience across devices, so that I can operate tasks confidently.
- As a maintainer, I want reproducible qualification and installed-package checks, so that visual improvements do not regress core behavior.
- As a prospective user, I want accurate guides and real product screenshots, so that I can get started and understand the value immediately.

## Implementation constraints

- Build on all eight merged milestones and fix integration issues in their shared modules. Do not add a competing component library, task model, poller or approval path.
- Use the existing M1 synthetic browser harness, fixed clocks and real handlers. Pin Chromium visual baselines; add semantic smoke coverage on Chromium, Firefox and WebKit without treating cross-platform font rasterization as a product failure.
- Keep browser tooling development-only and least-privilege CI separate where appropriate. Preserve existing Node 22/24, Linux/macOS, security, release and installed-package checks.
- Update durable user/design documentation. Keep runtime logs, traces, raw audit chronology and private sessions outside Git; commit only the explicitly approved product captures.

## Acceptance criteria

- Given the completed shell, overview, task, controls, chains, intake and health views, When the full operator journey runs, Then navigation, spacing, typography, state language and interactions form a material coherent redesign compared with the M1 baseline.
- Given both themes, 360/390/768/1280/1440 widths, 200 percent zoom and mobile landscape, When critical journeys run, Then content remains usable without clipped actions or page-level horizontal overflow.
- Given WCAG 2.2 AA checks, When automated accessibility tests and manual keyboard, focus, contrast, error and reduced-motion review are completed, Then issues are fixed and the evidence distinguishes automated coverage from manual inspection.
- Given Chromium, Firefox and WebKit, When semantic journeys execute at root and mounted paths, Then navigation, protected control feedback, task intake and chain views pass; pinned Chromium visual comparisons cover stable component and page states.
- Given loading, empty, stale, malformed, long-content, failed and uncertain-request fixtures, When refreshed or navigated, Then no misleading green state, duplicate action, lost draft or focus/scroll regression occurs.
- Given 1000 tasks and 10000 events, When lists, filters and activity are exercised, Then documented DOM/request limits remain bounded, subscriptions clean up and rendering causes no per-row host calls or main-thread lockup.
- Given existing completion, review, ownership and control behavior, When runtime and browser suites run, Then task readiness, integration gates, hosted/local evidence and all supported controls retain their existing authority and semantics.
- Given a packed clean installation, When the UI is served and mounted, Then required runtime assets work, browser binaries and fixtures are absent, and packaged docs contain no broken links to required assets.
- Given current implementation, When README and relevant guides are read, Then npm setup, standalone/mounted access, supported harnesses, task types, controls and chain gates are accurate and illustrated with genuine approved screenshots.
- Given final qualification, When reviewed for release readiness, Then full tests, lint, browser suites and installed-package smoke pass, the four approved captures are visually inspected, and Lookout remains a separate future decision with no new brief or queued task.

## Verify

- `npm run lint`
- `npm test`
- `npm run test:ui`
- `npm run test:install`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- README.md, docs/install.md, docs/commands.md, docs/tasks.md and docs/chains.md
- lib/tracker/, templates/tracker/ and lib/commands/serve.mjs
- test/, package.json, .github/workflows/ and the shared UI modules added by earlier milestones

## Out of scope

- Lookout implementation or its PRD, live job mutations, account changes, publishing, deployment or merging.
- New runtime framework or relaxing security, completion, review and portability gates.
