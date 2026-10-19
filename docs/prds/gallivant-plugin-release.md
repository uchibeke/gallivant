---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
  - docs/plans/plugin-hosting-and-live-tests.md
  - docs/plans/aport-task-delivery-integration.md
  - docs/prds/natural-language-tasks.md
  - docs/prds/hosted-codex-harnesses.md
  - docs/prds/openai-agents-harness.md
  - docs/prds/codex-cloud-harness.md
  - docs/prds/gallivant-plugin-delivery.md
aport_decision: b5482632-3b38-417e-921b-7eaa1c24a659
---

# Qualify remote Gallivant and assemble the plugin submission

## Problem

Passing implementation tests and generating a plugin archive do not prove users can run Gallivant remotely or install a useful ChatGPT integration. Provider access, deployment, authentication, reviewer accounts and submission materials can still fail. This final milestone qualifies the actual released artifacts, fixes integration defects and produces a complete APort submission handoff. Its finish line is a working remote workflow and submission-ready candidate, with evidence tied to the deployed version rather than a collection of instructions or mocked screenshots.

The carried `aport-task-delivery-integration.md` supersedes older endpoint/UI/downstream-dispatch instructions. Use APort's `/api/task-delivery/mcp`, its shared `/web` UI and the existing integration job. M5 owns exports and packaging; APort owns auth, tenant/regional adapters and presentation. All original live release requirements remain.

## Post-merge handoff correction

APort foundation PR #414 merged on 2026-10-05 with twelve criteria still unmet; its job is now `done`, which Gallivant cannot resume. This correction supersedes carried instructions requiring the same job/PR after merge. First reconcile the existing job and repository. If it is still resumable, reuse it. If merged with gaps, after M5 create or reuse exactly one successor `aporthq/agent-passport/aport-task-delivery-workflow-integration` job targeting the configured base. Its PRD must carry the merged `_plans/task-delivery-contract.md` and remaining criterion mapping, pin the actual M5 artifact, reuse the shipped foundation and satisfy every remaining original requirement. Run normal readiness/start, track its PR, then require human merge and qualified deployment. Do not reset the completed job, reopen a merged PR, duplicate active work, weaken gates or treat merge as functional completion. If operator controls are unavailable, record the exact command and dependency. This is the existing integration scope's continuation, not another runner or foundation build.

## User stories

- As an operator, I want to run Gallivant through either remote harness, so that I can choose the available account and environment.
- As a plugin user, I want installation to lead to a real reviewed PR, so that the plugin delivers useful development work.
- As a publisher, I want one complete submission bundle, so that I can review the evidence and submit without assembling missing assets.
- As a maintainer, I want reproducible upgrades and rollback, so that the plugin stays aligned with Gallivant.

## Acceptance criteria

- Given all predecessor implementations merged, when qualification starts, then the existing build, task services, adapters and deployment recipe are used directly; missing features are fixed at their source rather than duplicated in a release-only runner.
- Given unresolved operator setup, when preflight runs, then it lists only concrete missing target/domain, publisher/support configuration, repository/provider access, reviewer access and execution allowance with exact next steps. It completes independent preparation, stops dependent actions at needs-human without buying services, and never counts absent live evidence as a pass.
- Given an authorized target and configured allowance, when the backend is deployed from the candidate artifact, then real HTTPS MCP/OAuth discovery, durable state, one active coordinator, worker credentials, health/readiness, bounded quotas and authorized artifact downloads work without the user's laptop. The deployment revision is recorded and survives restart without duplicate dispatch.
- Given the installed Gallivant release and each remote backend, when G8 live qualification runs, then both Agents API and Codex Cloud independently complete a tiny real implementation and forced CI/review correction with verified code, tests and one PR per logical task across coordinator restart. API session continuity and Cloud native/successor continuity are recorded, with observed usage or explicit unknowns.
- Given the candidate installed in the actual ChatGPT host and a fresh authorized account, when the user describes a task, then questions, requirements, real readiness, chosen available remote harness, implementation, progress, result files, PR and one correction work end to end through the sidebar/panel surfaces supported by that host. Reopening a conversation recovers the same task without reconstructing chat history.
- Given account isolation, expired authentication, stale input, duplicate start, provider outage or unsupported cancellation, when release scenarios exercise them, then the actual service/UI gives truthful recovery states and blocks cross-account or overlapping work; fixture and live observations remain separately labeled.
- Given the tested source, endpoint and publisher metadata, when the release command runs, then G9's bounded release directory contains the combined skills/MCP ZIP, installable Gallivant package, deployable backend artifact/recipe, manifest, evidence, listing/release notes, authentic screenshots and accessible actual demo video URL. Payload hashes and deployed tool/schema versions identify the exact candidate.
- Given current OpenAI package rules, when validation runs, then the initial combined skills/MCP submission includes one connected MCP server, documented extension schema, APort identity, working legal/product/support URLs, assets and five positive plus three negative review scenarios; no example endpoint, fabricated review record, credential or private reviewer instructions enter the public ZIP.
- Given reviewer setup, when tested from a clean session, then a dedicated tenant/sample repository and usable account allow all required scenarios within an authorized allowance without private VPN, MFA, SMS or magic-link dependencies. Secrets and private reviewer instructions stay in secure operator storage/portal rather than Git or ZIP.
- Given publisher/domain setup and the exact candidate, when release readiness is evaluated, then APort business identity, organization permissions, eligible OpenAI project residency, domain verification and package/MCP/skill scans have recorded outcomes; missing prerequisites block submission-ready status. Domain challenges preserve other plugins and publisher project eligibility does not change APort customer residency.
- Given a compatible backend/package update, when upgrade and rollback are rehearsed, then approved tool contracts, queued/active task identities and saved state remain usable, with exact rebuild/rescan/migration commands. Metadata/skills ZIP changes are distinguished from live MCP updates; unsupported migrations stop safely.
- Given changed code, tool schema, package payload or deployment configuration after verification, when release validation runs, then affected evidence is invalidated and only necessary checks repeat; stale live results cannot certify a different artifact.
- Given the final handoff, when another operator follows START-HERE, then installed CLI and plugin runs are reproducible, all G9 materials and live checks are complete, and only explicitly identified owner submission attestations/actions remain. Code-merged, live-qualified, submission-ready, submitted, approved and published are separate recorded states; this criterion is not met by merely documenting missing live prerequisites.

- Given the shared hosting/API allowance and post-merge correction, when release proceeds, then it reconciles the existing APort job and either resumes it or tracks one necessary integration successor after merged M5 exports, verifies all remaining criteria and the human-approved deployment/coordinator before host tests, and reports inaccessible controls as a concrete dependency without duplicate active work.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:execution-backends`
- `npm run test:plugin-package`
- `npm run test:release-package`
- `git diff --check`

Implement the focused offline release validation script plus explicit opt-in live/host verification commands. Offline success alone cannot meet live acceptance criteria. If external setup is missing, leave those criteria unmet with exact evidence and pause dependent release work; never weaken the contract to obtain a completion receipt.

## Where to look

- `docs/plans/aport-task-delivery-integration.md` is the latest carried ownership/dependency correction for M5/M6.
- `docs/plans/plugin-hosting-and-live-tests.md` carries the later hosting choice and bounded API-test authorization; it supersedes only the earlier unknown-setup statements.

- `docs/plans/plugin-ready-gallivant.md`, especially G7-G9 and the deployment distinction; all carried predecessor PRDs define dependencies.
- Task/execution/MCP/UI services, package scripts and deployment artifacts produced by predecessors; existing evidence under `docs/audit/plugin-ready/`.
- Existing release/configuration and operator documentation, `lib/daemon.mjs`, `lib/state.mjs`, `lib/chains.mjs` and package/upgrade tests.
- Official MCP, Extensions, auth, packaging and submission references in the shared contract; reverify the current portal/package rules before preparing the final candidate.

## Out of scope

- Automatic PR merges, clicking Submit/publishing on Uchi's behalf, purchases or deployment to an unspecified account, contacting third parties or inventing publisher approvals.
- Another runner, broad billing product, extra providers, copied orchestration logic, mass synthetic artifact archives or rewriting the frozen chain briefs.
- Claiming OpenAI approval is guaranteed, plugin installation includes paid inference, or offline fixtures constitute a live release.
