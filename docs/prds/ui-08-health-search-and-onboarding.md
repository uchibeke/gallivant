---
status: ready
harness: codex
sources:
  - docs/design/ui-experience-contract.md
  - docs/plans/ui-experience-chain.md
publish_files:
  - docs/ui/previews/health-desktop.png
  - docs/ui/previews/health-mobile.png
aport_decision: c9fd060b-ec8b-464e-9367-0cfea61c132b
---

# Explain system health and make the workspace easy to navigate

## Problem

An operator cannot trust an unattended system when provider readiness, coordinator liveness and missing configuration all appear as an undifferentiated error. New users also need useful empty states rather than dead navigation and unexplained setup requirements. This milestone brings truthful health and setup guidance into the redesigned workspace, and adds keyboard discovery across existing views without introducing background probes, credential handling or another polling loop.

## User stories

- As an operator, I want observed coordinator and provider health with clear remedies, so that I can distinguish setup issues from task failures.
- As a new user, I want accurate setup guidance and useful empty states, so that I can reach a first task quickly.
- As a frequent user, I want consistent navigation and keyboard discovery, so that I can move between tasks, chains and health efficiently.

## Implementation constraints

- Build on milestones 1–7 and the single shared polling lifecycle. Read existing health snapshots and capability registries; do not run probes or model calls from GET handlers.
- Show registered, configured, qualified and dispatch-ready as separate facts where evidence exists. Local and hosted harnesses and supported git hosts share capability-driven components.
- Expose only safe health projections. Remediation is explanatory copy or an explicit existing authorized action, never a web shell or credential form.
- Keep theme/density preferences local and host-compatible. Command Center mounting, standalone serving and existing CLI configuration remain authoritative.

## Acceptance criteria

- Given coordinator snapshots, When health is viewed, Then up, busy, stale, down and unknown states include last observation and a truthful next step without resetting meaningful task activity.
- Given provider or harness registry entries, When status appears, Then installation, configuration, qualification and current account readiness are not conflated; unknown observations do not become healthy.
- Given a provider outage or pending scheduled check, When a remedy is shown, Then it uses existing readiness mechanisms and explains retries without triggering new model calls on refresh.
- Given no repositories, no tasks or incomplete setup, When the workspace opens, Then clear onboarding and safely quoted copyable commands reflect current supported CLI behavior without personal machine paths.
- Given GitHub, Bitbucket, local and hosted capabilities, When labels and actions render, Then shared registry facts determine availability and unsupported actions have meaningful explanations.
- Given keyboard discovery, When the command menu or shortcuts are used, Then only existing permitted navigation and actions are offered, input fields retain typing shortcuts, and focus returns predictably.
- Given searches, filters and browser history, When navigating across views, Then URL state and long names remain usable with no duplicate search or polling implementation.
- Given hidden tabs, transient read failures and reconnection, When polling proceeds, Then it is bounded, non-overlapping, lifecycle-cleaned and appropriately paused/backed off while retaining last-good data.
- Given standalone and /gallivant mounting, When links, assets, controls and health are used, Then base-aware behavior works without changing the existing standalone or Command Center ports.
- Given synthetic unhealthy, empty and mixed-capability fixtures, When browser, accessibility and route tests run, Then both themes and mobile pass, secrets stay absent and approved genuine health captures are reviewed.

## Verify

- `npm run lint`
- `node --test test/tracker.test.mjs test/tracker_controls.test.mjs test/provider-health-deadline.test.mjs test/runtime-prerequisites.test.mjs`
- `npm run test:ui`
- `git diff --check`

## Where to look

- docs/design/ui-experience-contract.md and docs/plans/ui-experience-chain.md
- lib/provider_health.mjs, lib/runtime_node.mjs, lib/runtime_dependencies.mjs and lib/capabilities.mjs
- lib/commands/status.mjs, lib/commands/serve.mjs and lib/tracker/
- docs/install.md, docs/commands.md and docs/config.md

## Out of scope

- Credential entry, account changes, arbitrary shell commands or global environment repairs.
- New health engine, eager probes, configuration editor or Lookout integration.
