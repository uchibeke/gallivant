---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/before-overview-desktop.png
  - docs/ui/previews/foundation-overview-dark.png
aport_decision: 21489544-957c-45d2-ac15-c9bf875ae626
---

# Establish a premium interface foundation and shared shell

## Problem

Operators currently encounter a dense table and log-oriented tracker whose hierarchy, navigation and interaction states do not match the breadth of the task engine. Styling each new page independently would create inconsistent controls, duplicated CSS and fragile embedded behavior. This milestone establishes the actual visual system, reusable shell and browser verification foundation so later work can transform the product coherently without replacing its server-rendered architecture or sacrificing portability.

## User stories

- As a returning operator, I want a clear, polished workspace shell, so that I can orient myself before opening a task.
- As a maintainer, I want shared accessible primitives and one browser fixture harness, so that later views reuse behavior and design instead of accumulating copies.
- As an embedded user, I want the same experience at a mount prefix, so that the standalone and Command Center versions stay consistent.

## Implementation constraints

- Follow the immutable UI experience contract and chain plan. This is milestone 1; capture the existing overview before changing it, using a fixture that later milestones preserve for comparison.
- Retain server-rendered ESM and existing mount/theme contracts. Extract focused composition, styles and browser-controller modules as needed; do not adopt React or another application framework.
- Create one dev-only browser fixture server and npm run test:ui, backed by actual serve/mount handlers, synthetic task state, controlled time and fake service boundaries. Use one locked browser driver and accessibility helper only if existing tooling cannot provide them.
- Add a least-privilege UI CI job using pinned Chromium, serving local assets with external requests rejected. Preserve runtime matrix and release workflow protections. Document supported browser installation and local execution.
- Write concise implementation conventions in docs/ui-design-system.md; this is a new durable output, not a modification to either carried planning input.

## Acceptance criteria

- Given the current overview fixture, When before and foundation captures are produced, Then both are genuine browser renders of the same data and the new shell shows materially improved hierarchy, spacing, typography and navigation rather than a color-only adjustment.
- Given dark, light and system/host theme selection, When the shell renders standalone or mounted, Then it preserves existing theme parameters and host token overrides while using one semantic token system for surfaces, text, focus, action and status colors.
- Given repeated controls across pages, When badges, buttons, fields, menus, tabs, empty states, loading states and notices render, Then they use shared primitives with distinct focus, disabled, pending, error and success states and one consistent local icon vocabulary.
- Given 360, 390, 768, 1280 and 1440 pixel viewports plus 200% zoom, When navigation and long content render, Then essential controls remain visible, keyboard usable and free of page-level horizontal overflow.
- Given a keyboard-only or reduced-motion user, When traversing the shell, Then landmarks, skip navigation, focus visibility, escape/return behavior and nonessential animation follow the shared accessibility contract.
- Given root and /gallivant fixture mounts, When existing overview, run, runs, API and asset URLs load, Then their semantics, query state, host navigation and protections remain compatible and no enabled navigation link leads to an unimplemented view.
- Given the browser fixture server, When test:ui runs locally and in CI, Then actual pages, CSS, JavaScript and protected request behavior are exercised with no production home, credentials, inference or live task effects.
- Given malicious rendered text or a cross-origin control request, When the shared shell is exercised, Then escaping, CSP, loopback/origin checks and existing control-token protection remain enforced rather than relaxed for visual tooling.
- Given an npm tarball, When package contents are inspected, Then required runtime assets are included while browser binaries, fixture state, screenshots used only as test baselines and development test dependencies are excluded.
- Given the approved screenshot paths, When this milestone is delivered, Then the baseline and dark foundation captures have been visually inspected and committed only at those exact paths, with other traces outside tracked source.

## Verify

- `npm run lint`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs test/control.test.mjs`
- `npm run test:ui`
- `npm run test:install`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/tracker/pages.mjs and lib/tracker/assets.mjs
- templates/tracker/tracker.css and templates/tracker/tracker.js
- lib/commands/serve.mjs and test/tracker.test.mjs
- test/tracker_controls.test.mjs, test/control.test.mjs and test/install-package.mjs
- package.json and .github/workflows/runtime-portability.yml

## Out of scope

- Task engine, state schema, authentication, permission, completion or review-policy redesign.
- A new frontend framework, daemon, global plugin, hosted asset service or runtime browser dependency.
- Lookout integration, live job mutations, publishing, deployment or automatic merging.
