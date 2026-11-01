---
status: ready
harness: codex
aport_decision: ed5758ae-0104-47a7-b970-aba4aaa1882c
---

# Enable and qualify the Bitbucket Cloud review loop

## Problem

`git-host-boundary` and `bitbucket-cloud-repository` provide a common host contract and Bitbucket transport, but unattended Bitbucket work must remain disabled until feedback, CI, readiness and recovery are reliable. A Bitbucket Pipeline can run Codex, yet that alone does not publish a review that Gallivant can trust. The current GitHub defaults for `@codex review`, bot logins, `gh` prompts and PR labels are not valid Bitbucket defaults. Finish the existing lifecycle on Bitbucket Cloud, qualify it with real repository evidence, and make setup work in any eligible Bitbucket Cloud Git repository without hardcoded workspace or repository names.

## User stories

- As a Bitbucket Cloud repository owner, I want to start a written PRD from my checkout, so that Gallivant opens and tracks a PR in that repository.
- As a task owner, I want trusted Codex or human feedback and CI failures returned to the same agent, so that corrections land on the same PR.
- As a task owner, I want a clear readiness verdict and recovery commands, so that a silent reviewer, missing check or permission failure cannot masquerade as completion.
- As a maintainer, I want the new host to use the shared lifecycle, so that future GitLab or other host adapters require bounded host code rather than a copied daemon.

## Acceptance criteria

- Given any supported Bitbucket Cloud Git repository that is not archived, has an accessible base, and has Git push plus API repository and PR read/write access, when an operator runs setup and starts a valid local PRD, then Gallivant works without source edits or workspace-specific constants. Private/public, HTTPS/SSH operator origins, account API tokens with workspace scope, default/non-default bases, and repositories with no pre-existing Gallivant configuration are covered. If a repo is ineligible, `init` or `doctor` gives the exact prerequisite; `start` stops before a paid dispatch when it can know the blocker.
- Given an eligible Bitbucket checkout, when `new`, `ready`, `start`, `task` or `register` is used as supported by the selected harness, then host selection comes from the verified checkout or exact Bitbucket PR URL; all saved state, worktree paths, links, PR identity and recovery checks retain that host. `--base` targets the branch used for clone, PR creation and later base updates. Duplicate workspace/repository names on GitHub and Bitbucket cannot cross-control one another.
- Given a local agent working on Bitbucket, when its start or fix prompt asks it to inspect, create, edit or reply on a PR, then it uses a supported Bitbucket-aware operation path rather than `gh pr` or a GitHub URL. Hosted providers that require a GitHub-bound environment refuse before dispatch; a compatible provider uses the same verified Bitbucket publication path. No harness is claimed compatible solely because it can edit local files.
- Given a Bitbucket PR head, when the daemon polls, then it reads complete paginated global/inline comments, reviewer participants or decisions, unresolved review tasks and build statuses for that exact head. It normalizes stable Bitbucket actor IDs, event IDs, timestamps, source links, head SHA and blocking state into the existing event model. Missing or partial data, pending checks, rate limits and outages never become clear review or green CI; no checks after the configured grace period retain the documented explicit no-CI behavior.
- Given a trusted `/fix` comment, inline finding, change request, unresolved required task or failed required check, when a tick sees new feedback, then exactly one bounded fix round receives it and continues the recorded session on the same PR. Duplicate or reordered pages, retries, self-authored replies and older-head comments do not redispatch it; rechecks, messages and explicit resumes preserve context and cursor safety.
- Given a configured Bitbucket automated reviewer, when it publishes a blocking or clear verdict, then Gallivant accepts it only from its configured stable host actor identity and only for the current exact head SHA. A Pipeline run by Codex without a posted verdict is silence, and an old approval or comment cannot clear a new head. Setup must provide a tested Codex review path that works for the authorized test repository without requiring paid Agentic Pipelines, such as an ordinary Pipeline or a separate local Codex review invocation. It must state required provider credentials and Bitbucket settings, keep reviewer secrets from the coding agent, and never silently install a pipeline or token. Trusted human feedback also works; an explicit no-reviewer mode continues to use CI and trusted commands but cannot be reported as Codex-reviewed.
- Given an operator using both GitHub and Bitbucket, when reviewer identities, trusted authors, required checks, base and credentials are configured, then each is scoped to its host/repository and defaults cannot send `@codex review` to Bitbucket or weaken an existing GitHub gate. Setup refuses an unqualified reviewer configuration instead of waiting silently. Optional GitHub PR labels are not required for Bitbucket; CLI, dashboard, receipt and state still show the actual status.
- Given a Bitbucket PR is merged, declined, edited by another actor, or temporarily unreadable, when Gallivant reconciles it or restarts, then it proves the PR's exact repository, branch, base, head and merge ancestry before marking done or advancing a chain. A decline, mismatch or unverifiable merge stops with an actionable reason. No command automatically merges, force-pushes, deploys or changes repository protection.
- Given clean installations on macOS and Linux with supported Node, Git and a local Codex or Claude harness, when Bitbucket setup and diagnostics run, then documented commands work without `gh` sign-in for a Bitbucket-only user. GitHub setup, active runs, stored handles, review semantics and tests remain unchanged.
- Given a repository on a newly registered third Git host, when its adapter passes the shared contract and a compatible harness is selected, then no shared scheduler, event, chain, completion or prompt logic needs a host-specific branch; until a real adapter and qualification exist, that host is refused with a clear message. Git host, local harness and inference provider remain separate configuration axes.
- Given authorization for disposable Bitbucket Cloud test repositories, when live qualification runs, then it demonstrates private and public access, a non-default base, PR creation, a genuine Codex review that posts current-head feedback, one blocking then clear review verdict, a trusted `/fix` comment, failed then passing CI, same-session correction, receipt/readiness, daemon restart recovery and merge-gated chain continuation. Record exact repo/PR links, versions, credentials' scope without secrets, observed reviewer actor, check names and outcomes. Do not claim Codex review or enable Bitbucket as qualified until these pass; report unavailable cases as unmet criteria.

## Implementation boundaries

Reuse native Git for code transport and the host adapter for PR, review and CI operations. Keep one static host registry, daemon, event cursor, completion gate and chain engine. Generic modules must consume normalized host records; host-specific API commands, auth and optional features stay in adapters. Prefer polling at the current cadence; do not add a public webhook server. Bitbucket's [PR and status APIs](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/) supply host data. [Agentic Pipelines running Codex](https://www.atlassian.com/blog/bitbucket/agentic-pipelines-now-supports-openai-codex) is a possible reviewer producer, not a review verdict by itself. Head-bound review must be explicit even when Bitbucket keeps approvals after a push. Any permission that cannot be checked without a write must be reported as unknown and safely handled at the first actual write.

Update README, install, config, commands, security, troubleshooting and live-support documentation with a Bitbucket-only first-run example, separate SSH Git and account API token setup on the free plan, reviewer choices, no-CI behavior, supported harnesses and clear limits. Document the host contract for a later GitLab.com adapter; [GitLab merge requests](https://docs.gitlab.com/api/merge_requests/) and [discussions](https://docs.gitlab.com/api/discussions/) show why this extension is feasible, but do not claim GitLab support before an adapter and live qualification ship.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

Tests must use deterministic GitHub and Bitbucket fixtures for pagination, actor trust, exact-head verdicts, no reviewer, no CI, failing/pending checks, token isolation, PR idempotency, restart and chain merge proof. Ordinary tests make no paid model calls or live repository writes. The live qualification above is a separate ship gate.

## Where to look

- `docs/prds/git-host-boundary.md` and `docs/prds/bitbucket-cloud-repository.md` are required merged predecessors.
- `lib/events.mjs`, `lib/tick.mjs`, `lib/chains.mjs`, `lib/control.mjs` and `lib/state.mjs` own feedback and task state.
- `lib/prompt.mjs`, `lib/execution_result.mjs`, `lib/commands/start.mjs`, `lib/commands/register.mjs`, `lib/commands/up.mjs` and `lib/commands/doctor.mjs` expose user-facing host behavior.
- `README.md`, `docs/install.md`, `docs/config.md`, `docs/commands.md`, `docs/guardrails.md` and `docs/audit/harness-live-validation.md` need support evidence and setup instructions.

## Out of scope

- GitLab, self-hosted Bitbucket, Azure DevOps, Gitea and arbitrary Git remotes in this chain.
- Automatically installing or paying for Codex Pipelines, creating credentials, changing repository permissions or silently trusting any Pipeline output.
- Automatic merge, deployment, a second daemon, a dynamic plugin framework or a host-specific copy of the completion gate.
