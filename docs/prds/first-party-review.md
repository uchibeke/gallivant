---
status: ready
harness: codex
aport_decision: 75d67a50-f7e3-4960-a61b-ed7ccaee3feb
---

# Add a first-party review gate for repository tasks

## Problem

Gallivant currently waits for a configured Git host review bot by default. A repository without that integration can set `reviewer: null`, but then green checks and a completion receipt can move the task to ready without an independent semantic review. This is especially limiting on hosts where a review bot is unavailable or paid. Give each qualified repository task a bounded, separate review of the current diff and brief, while preserving the existing deterministic checks, completion decision, trusted feedback, and human merge boundary. An internal model opinion must be identified as such and must never be reported as an external approval.

## User stories

- As a task owner, I want a review without installing a Git host bot, so that a task can progress on supported hosts when external review is unavailable.
- As a maintainer, I want specific findings and a bounded fix loop, so that useful review feedback improves the work without repetitive or subjective stalls.
- As a security owner, I want a reviewer isolated from the author and its authority, so that repository text cannot grant itself approval or change task permissions.
- As an operator, I want measured cost and quality before a new default, so that review improves outcomes rather than adding unproven latency.

## Acceptance criteria

- Given a new task, when its review policy is selected, then one versioned policy pins exactly one of `external-required`, `first-party-required`, or `both-required`, plus the qualified reviewer route and configured external actor where applicable. A repo with a configured Codex bot keeps `external-required` by default; a repo without a remote reviewer selects `first-party-required` only after its reviewer route qualifies. No bot-installation inference or silent fallback from a missing, slow or failed required reviewer is allowed. Changing policy requires an explicit operator action and re-evaluation of the current head. Legacy runs retain their original review requirements, including an explicit no-review setting, with that absence disclosed rather than called clearance.
- Given a configured reviewer route, when setup and start preflight run, then Gallivant proves a fresh reviewer session can use a restricted, read-only profile, has only the selected repository context and its inference connection, and cannot write files, Git refs, PRs, approvals, task state, policies, credentials, or network destinations beyond its provider. Unsupported routes fail qualification rather than silently using the coding session or falling back to an unrestricted agent.
- Given a current PR head and base, when review runs, then the coordinator captures the exact head/base identities, immutable PRD snapshot, criteria, complete diff including deletions, relevant code context, test/check results and completion receipt. Unreadable or oversized evidence is an explicit incomplete result, never a clean verdict. Model input treats repository and PR text as untrusted data.
- Given that evidence, when the reviewer responds, then a validated structured result reports examined criteria, a clear or findings verdict, specific actionable findings with severity and file/line or other verifiable evidence, unresolved scope, reviewer route, input digest and reviewed head. Invalid, partial, timed-out or failed output never means clear. Persona prompts are short review rubrics, with a general correctness reviewer as the default and at most one additional selected specialist for a task; neither can alter the PRD or policy.
- Given actionable findings, when the shared loop continues, then it gives the author the findings through the existing fix-round path, counts the round, records disposition and re-reviews after the resulting push. Repeated findings on unchanged evidence, conflicting reviewer conclusions and exhausted rounds stop for a person with the record. A finding can be disputed with an explicit reason; the author cannot declare its own dispute accepted.
- Given any changed head, base, receipt or checks, when Gallivant considers readiness, then stale review evidence is invalidated before readiness can be claimed. `external-required` needs the configured remote actor's exact-head clear; `first-party-required` needs the coordinator-owned exact-head clear; `both-required` needs both. Each also needs settled required checks and the completion gate. External findings and trusted human feedback still enter the shared loop under every policy; an external finding arriving after internal clearance reopens readiness on the same head. An absent, silent or failed required reviewer never counts as clearance.
- Given no configured external bot, when the qualified first-party reviewer clears the current head, then the task can reach ready for human with an honest `first-party review` evidence label and no claim of Git-host bot approval. A missing reviewer route prevents an unattended start unless the operator explicitly chooses the documented legacy no-review path. Missing CI and a skipped completion gate remain visible as distinct states; whether a repository has zero required checks must follow its explicit existing CI policy, not an inference from an empty response. No review verdict authorizes merge, deployment, release or chain advancement ahead of the existing merge gate.
- Given a restart, duplicate poll, provider error or rate limit, when reconciliation runs, then keyed review jobs and verdicts are idempotent and bounded by a separate review timeout, retry and spend allowance; provider failure stops with an actionable reason and never becomes a clean review. Review does not consume a coding fix round unless findings actually dispatch one.
- Given review output on GitHub or another qualified Git host, when it is recorded, then host adapters may publish a neutral summary but all trust and readiness decisions use the same coordinator-owned review record. Agent-authored public text never masquerades as an independent host actor. GitHub's existing external reviewer and current task IDs continue working.
- Given a representative held-out fixture set, when the feature is evaluated, then tests cover seeded correctness, security, missing-criteria, deletion and regression defects, clean changes, prompt injection, false positives, disagreement, changed heads, failures and large diffs. Record defect detection, false-positive rate, latency and spend against the current external-review or human-reviewed baseline. The first-party path is opt-in until the measured results and security qualification justify changing the default for new tasks.
- Given the implementation, when operators read the CLI help, README, configuration, architecture and guardrails docs, then they can choose and diagnose each review policy, see precisely what first-party review proves, and migrate new tasks without changing existing runs. Tests demonstrate that absence of review is never described as review clearance.

## Implementation boundaries

Reuse the task lifecycle, execution registry, fix rounds and completion gate. Add one coordinator-owned review service and a narrow reviewer capability/profile to existing harness adapters, not a second scheduler or host-specific review engine. A reviewer is a fresh session with restricted tools and no task mutation authority. The coordinator validates evidence and verdicts; the reviewer supplies only judgement. The concurrent Git-host support chain may change the host boundary before this PR merges: integrate with the merged boundary when present, without editing its in-flight worktree or assuming its unmerged files exist. Keep deterministic tests and APort completion separate from model opinion. Roll out `first-party-required` to qualified repositories without a remote reviewer first. Preserve `external-required` as the default for repositories already configured with Codex; `both-required` is an explicit higher-assurance option. Do not change those defaults without measured evidence and a reviewed migration. The research in [Fan et al., 2026](https://arxiv.org/abs/2609.20804) motivates component-level evaluation of context and tool choices, but it did not evaluate model reviewers.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

Add deterministic tests for policy migration, reviewer confinement, output validation, exact-head invalidation, fix-round reuse, restart and multi-host normalization. Add an opt-in live qualification using a disposable repository and a configured reviewer route; ordinary tests make no paid model calls or live PR writes.

## Where to look

- `lib/events.mjs`, `lib/tick.mjs`, `lib/config.mjs`, `lib/execution.mjs`, `lib/harness.mjs`, `lib/deliverable.mjs` and `lib/state.mjs`.
- `docs/design/sources-and-standards.md`, `docs/config.md`, `docs/architecture.md` and `docs/guardrails.md`.
- `test/events.test.mjs`, `test/tick.test.mjs`, `test/security.test.mjs` and execution adapter tests.

## Out of scope

- Automatic merge, release, deployment or learned-rule activation.
- Multiple competing reviewer agents, open-ended debate, a generic persona marketplace or a new provider framework.
- Reimplementing proprietary harness context management or assuming the cited harness paper validates model judgement.
