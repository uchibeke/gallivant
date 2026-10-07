---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
  - docs/plans/plugin-hosting-and-live-tests.md
  - docs/prds/natural-language-tasks.md
  - docs/prds/hosted-codex-harnesses.md
aport_decision: 879234ba-fe78-49f2-be5d-0ad67750d407
---

# Run and review Gallivant tasks through OpenAI Agents API

## Problem

Gallivant needs a remote managed coding harness that does not depend on a user's laptop or a local Codex subprocess. OpenAI Agents API provides sessions and environments, but its events, required actions and ephemeral filesystem do not match local process semantics. This milestone implements that provider through the preceding execution foundation, preserving the existing readiness, GitHub PR, review correction and completion workflow. A Responses-only imitation or disconnected demonstration does not satisfy the task.

## User stories

- As an operator, I want to select openai-agents, so that Gallivant can execute in an OpenAI-hosted environment.
- As a user, I want review fixes to continue my session, so that the same task and PR retain their requirements and implementation context.
- As an operator, I want reliable status and result recovery, so that outages do not lose code or duplicate charges.
- As a reviewer, I want actual files and current-head test evidence, so that provider status does not substitute for delivery.

## Acceptance criteria

- Given the intake and execution foundations merged into the selected base, when implementation starts, then the adapter uses their service, capabilities, journals and single coordinator; missing dependencies are explicit failures rather than instructions to recreate them.
- Given documented Agents API access and authorized credentials, when openai-agents is selected, then setup validates account, model, environment and budget capabilities and records effective values without changing defaults or pretending a ChatGPT subscription funds API calls.
- Given a repository and approved brief, when work begins, then the actual managed Codex Agents API prepares an OpenAI-hosted environment, exact source revision, verified portable sources and scoped credentials, persisting environment/session/turn and dispatch identities before acknowledging launch.
- Given a review correction or answered question, when continuation is authorized, then input targets the existing session and correct turn/action IDs, reconciles branch/environment state and uses documented idempotency or the foundation's ambiguity handling. It never starts a second unrelated implementation or grants arbitrary tool authority.
- Given live events, when progress is processed, then G4 root-turn semantics, subscribe-before-send, text replacement, required actions and normalized journaling apply; subagent completion, session idle or stream closure cannot mark implementation successful.
- Given disconnects or missed notifications, when recovery runs, then it buffers a replacement stream, retrieves authoritative session/turn state and paginated saved items, reconciles identities and labels unrecoverable deltas. Optional webhooks are signed, replay-safe notifications; periodic polling still recovers lost delivery.
- Given setup failure, throttling, authentication expiry, failed root turn or expired environment, when reconciliation occurs, then bounded retries and actionable states preserve saved work, avoid duplicate dispatch and never claim that an expired filesystem survived. A failed session cannot create an endless reconnect loop.
- Given completed work, when files reach the existing PR writer, then verified branch transport or completed-turn published artifacts preserve input head, hashes, code and test records, respect pagination/size limits and reject unsafe paths or wrong-base patches. Results remain downloadable after sandbox expiry and are saved before session deletion.
- Given CI findings, trusted reviews, stale heads, base conflicts, evaluator failures or receipt repairs, when another round is needed, then the existing review/completion rules continue the same task, session and PR with current inputs and configured iteration limits.
- Given cancel, timeout or exhausted execution allowance, when a control runs, then actual turn cancellation is distinguished from session deletion, late results are quarantined, no new paid round starts and usage/cost is recorded as observed or unknown; estimates are not advertised as enforceable spend caps.
- Given mandatory policy or private context, when remote setup cannot enforce configured requirements, then dispatch refuses with the missing capability instead of dropping local guardrails; secrets and unauthorized paths remain absent from public logs and artifacts.
- Given provider-shaped offline fixtures, when the focused suite runs, then successful implementation, failed/subagent turns, required actions, lost replies, reordered events, pagination, artifacts, cancellation, account isolation and restart pass against shared lifecycle outcomes, not only SDK argument snapshots.
- Given G8 live prerequisites and the carried campaign allowance, when the opt-in suite runs, then one real implementation and forced CI/review correction produce verified files, tests and the same PR/session across a coordinator restart. Missing access remains explicitly unverified; the code exposes a working adapter rather than a permanent unavailable stub.
- Given final documentation, when an operator follows it, then installation, account setup, selected environment, CLI/task use, polling/logs, continuation, artifact recovery, supported versions and repeatable verification commands are explicit, with fixture/live evidence separately labeled.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:execution-backends`
- `npm run test:openai-agents`
- `git diff --check`

Implement the focused offline script and a separately opt-in live command. M6, not a fixture pass, owns final release qualification.

## Where to look

- `docs/plans/plugin-hosting-and-live-tests.md` carries the later hosting choice and bounded API-test authorization; it supersedes only the earlier unknown-setup statements.

- `docs/plans/plugin-ready-gallivant.md`, especially G3-G4/G6/G8, and both carried predecessor PRDs.
- The predecessor's execution/task services, `lib/harness.mjs`, `lib/config.mjs`, `lib/probe.mjs`, `lib/credential.mjs`, `lib/run.mjs`, `lib/state.mjs`.
- `lib/tick.mjs`, `lib/git.mjs`, `lib/gh.mjs`, `lib/control.mjs`, `lib/deliverable.mjs`, tracker and recovery tests.
- Official overview, session events/management, environment files and recovery references linked in the contract; reverify beta interfaces and supported SDK before implementation.

## Out of scope

- An Agents SDK orchestration loop, Responses-only substitute, Codex Cloud transport or copied review/PR engine.
- Public hosting, directory submission, account purchases, changed model defaults, automatic merging or rewriting frozen planning inputs.
- Treating credentials, subscription entitlement, pre-action enforcement or live support as established without evidence.
