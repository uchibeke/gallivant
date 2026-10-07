---
status: ready
harness: codex
sources:
  - docs/plans/plugin-ready-gallivant.md
  - docs/plans/plugin-hosting-and-live-tests.md
  - docs/prds/natural-language-tasks.md
  - docs/prds/hosted-codex-harnesses.md
  - docs/prds/openai-agents-harness.md
aport_decision: 4154dbd5-ef99-42da-9ba5-f2605d8b6a73
---

# Run Gallivant tasks and review rounds through Codex Cloud

## Problem

Users should be able to choose Codex Cloud as well as local Codex and Agents API. Cloud submission, authentication, observability and continuation differ from the other two, and a submission command can exit while remote work continues. This milestone supplies a real selectable Cloud adapter through Gallivant's shared execution foundation and existing GitHub loop. It must preserve one logical task and PR, accurately describe supported controls and avoid inventing native session continuation or public credential delegation.

## User stories

- As an operator, I want to choose codex-cloud, so that I can use my authorized Cloud environment with Gallivant.
- As a user, I want bounded review corrections on one task and PR, so that provider-specific execution does not fragment delivery.
- As an operator, I want honest progress and cancellation behavior, so that I can distinguish client state from remote work.
- As a maintainer, I want Cloud to reuse shared services, so that local and API behavior remain compatible.

## Acceptance criteria

- Given preceding milestones merged, when implementation starts, then the adapter reuses the established execution and task contracts; both openai-agents and local codex remain functional and no provider-specific review loop is added.
- Given codex-cloud selection, when setup runs, then capability checks verify supported CLI/version, authorized ChatGPT sign-in, chosen Cloud environment, repository and branch access, continuation mode and billing source without changing defaults or borrowing another user's identity.
- Given an approved request, when submitted, then supported documented Cloud interfaces receive the exact remote input revision and approved source snapshots, persist dispatch intent and real task/attempt IDs, and distinguish a finished submission subprocess from remote completion.
- Given local-only brief/source files, when Cloud work starts, then approved snapshots reach its isolated task branch or a demonstrated input channel before dispatch; their remote hashes are verified, and unrelated local files, secrets and absolute local path references are not treated as delivered context.
- Given active work or a restart, when inspection runs, then bounded polling paginates supported task listings as needed and reconciles the exact stored task/attempt; it journals real status, summaries, errors and diff availability with timestamps through G3a. Missing token/tool logs are disclosed rather than fabricated.
- Given lost submission acknowledgement, duplicate result or delayed provider response, when recovery occurs, then persisted ownership prevents duplicate paid work and patch application; an unresolvable identity remains unknown instead of selecting the newest task or submitting again.
- Given review feedback, when supported native continuation is demonstrated, then the same provider task continues; otherwise G5 successor tasks receive approved requirements, exact current pushed code, source snapshots, feedback and decisions under the same logical Gallivant task/PR, with every child ID and continuity mode recorded.
- Given a completed attempt, when results enter GitHub, then one PR writer validates base, paths and result identity, applies a diff only in an isolated task checkout or adopts a verified provider branch, records actual tests and opens/updates exactly one PR. An already pushed patch is reconciled rather than applied twice.
- Given failed checks, trusted reviews, stale heads, conflicts or receipt repairs, when work continues, then the existing GitHub gates, current-head evidence, bounded rounds, evaluator behavior and human merge boundary produce the same decisions as other harnesses.
- Given stop, cancel or timeout, when native remote cancellation is unavailable, then Gallivant stops future dispatch, quarantines late results, retains a task link and reports remote execution may continue. Killing the CLI is never described as stopping remote compute; unsupported interrupt cannot create overlapping tasks.
- Given hosted usage, when Cloud authentication is configured, then documentation distinguishes trusted operator/self-hosted workers from any demonstrated delegated multi-user mode. Public setup never collects passwords, browser cookies or pasted Codex auth files, and unsupported mandatory policy refuses dispatch.
- Given offline Cloud fixtures, when focused verification runs, then authentication failure, multiple attempts, pagination, continuation modes, ambiguous submission, late results, wrong-base diffs, head movement and restart prove shared lifecycle/PR outcomes while local and Agents API conformance remains green.
- Given G8 live prerequisites and the carried campaign allowance, when the opt-in suite runs, then a real implementation and forced CI/review correction produce verified files, tests and one PR across a coordinator restart, with actual native/successor continuity and cost source recorded. Missing access blocks live qualification, not truthful implementation reporting.
- Given final documentation, when an operator follows it, then environment/sign-in setup, dispatch/inspect commands, logs, recovery, supported versions, account limits and continuation/cancellation differences are explicit; no undocumented endpoint, browser automation or local exec is advertised as Codex Cloud.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:execution-backends`
- `npm run test:openai-agents`
- `npm run test:codex-cloud`
- `git diff --check`

Implement the focused offline script and opt-in live command. M6 owns final live release qualification of both remote providers.

## Where to look

- `docs/plans/plugin-hosting-and-live-tests.md` carries the later hosting choice and bounded API-test authorization; it supersedes only the earlier unknown-setup statements.

- `docs/plans/plugin-ready-gallivant.md`, especially G3/G3a/G5-G6/G8, and the carried predecessor PRDs.
- Existing execution services, `lib/harness.mjs`, `lib/probe.mjs`, `lib/config.mjs`, `lib/credential.mjs`, `lib/run.mjs`, `lib/tick.mjs`.
- `lib/git.mjs`, `lib/gh.mjs`, `lib/control.mjs`, `lib/state.mjs`, `lib/chains.mjs`, review, base and recovery tests.
- Official Cloud, developer commands and authentication references in the contract; inspect current supported CLI behavior before choosing flags.

## Out of scope

- Private Cloud endpoints, browser automation, assumed native memory transfer, shared public credentials or relabeling local Codex as Cloud.
- Plugin UI, public deployment, directory submission, purchasing credits, automatic merges or changing frozen planning inputs.
- Dropping Agents API, creating another review engine or changing global model/provider defaults.
