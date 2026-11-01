---
status: ready
harness: codex
aport_decision: 8c002fc5-b6ea-49bd-b5f6-7b5e8f8b0f9a
---

# Extract a Git host boundary without changing GitHub runs

## Problem

Gallivant's task lifecycle is coupled to GitHub at several layers: repository identity, credentials, clone URLs, PR prompts, review events, CI status, recovery and chain merge checks. Adding host branches to each caller would duplicate the review loop and create inconsistent safety rules. Establish a small host boundary around those operations while keeping today's GitHub runs, stored IDs and public behavior intact. A Git host is independent of the selected inference provider and agent harness. This milestone must not advertise or dispatch Bitbucket tasks yet; the next milestones provide and qualify that adapter.

## User stories

- As a GitHub task owner, I want existing runs and chains to behave the same after this refactor, so that host support cannot strand my work.
- As a maintainer, I want one documented contract for repository hosts, so that the next host supplies transport and review data without another scheduler or event engine.
- As a security reviewer, I want host identity and credentials bound before a run starts, so that a repository or PR cannot redirect a token to another host.
- As an operator, I want Git host and harness choices to be independent, so that changing where code lives does not require a new execution provider.

## Acceptance criteria

- Given saved GitHub entries, chains, worktrees, PR metadata and legacy handles, when the new version loads and reconciles them, then IDs and cursors retain their meaning without destructive migration, duplicate dispatch or changed completion decisions. Any ambiguous state stops with a recovery instruction.
- Given HTTPS, scp-style SSH or `ssh://` origins, when a checkout is identified, then a strict parser returns a canonical host, repository path and remote identity, rejects URL userinfo from all diagnostics, and rejects malformed, unsupported or mismatched origins before clone or provider dispatch. GitHub's existing accepted remote forms remain accepted.
- Given two hosts with the same owner/repository and PR number, when new runs or handles are constructed, then their state, worktree, review cursor and UI links cannot collide. Historical GitHub IDs and short handles remain usable; a newly ambiguous short handle requires its qualified form.
- Given the existing GitHub adapter, when normal start, PR reconciliation, review, CI, receipt, recovery, dashboard control and merge-gated chain paths call the host boundary, then they use one shared lifecycle and normalized domain records whose source, actor, event IDs, head SHA and timestamps are explicit. Existing GitHub-specific learning and ruleset operations stay in their adapter rather than becoming mandatory operations for every host.
- Given the host registry, when a checkout, PR URL or saved task selects a host, then one explicit registry resolves it and declares its capabilities, credential resolver, Git remote policy, PR operations and reviewer/CI data contract. Shared commands obtain the selected adapter from that registry; adding a host requires no new switch in the daemon, task intake, event engine or chain engine. Harness and execution-provider registries remain separate; a provider declares its repository access mode or binding constraint, and a shared pre-dispatch check refuses incompatible host/provider combinations without a host-by-harness switch table. A local-worktree provider can use any qualified host without changing that provider's adapter.
- Given a fresh GitHub run, when the shared Git layer creates its checkout, then it uses native `git clone` with the GitHub adapter's verified URL and host-restricted credential, not `gh repo clone`. Fetch, base selection, commit identity, isolation and push keep their existing behavior, and no generic Git method rewrites every origin to `github.com`.
- Given a host adapter reports a missing required capability, incomplete page, rate limit, auth failure or unreadable diff, when the shared loop evaluates the run, then it preserves the last known state and fails closed or retries within existing bounds; it never interprets missing data as no findings, green CI or a merged PR. Optional labels or decorations may be omitted without affecting readiness.
- Given credentials resolved for one host and repository, when Git or an API operation runs, then its transport uses only the explicitly bound SSH key or host-restricted HTTPS/API credential, never a credential for an arbitrary URL from repository content. A Git SSH key does not substitute for API authorization. No token appears in a remote URL, argv, committed file or public log. GitHub resolution order and reauthentication behavior remain unchanged.
- Given the host contract and GitHub adapter fixtures, when tests run, then they cover canonical identity, legacy state, event normalization, capabilities, host mismatch, token isolation, retries, idempotent writes and chain merge proof without live credentials or model calls.
- Given an architectural regression test, when shared lifecycle modules or prompts gain a direct GitHub CLI/API dependency or a second host-specific review decision, then the test fails. Host-specific learning, rulesets and CLI implementation remain allowed inside the GitHub adapter and its own feature modules.

## Implementation boundaries

Use native Git for clone, fetch, commit and push, including GitHub clones that currently go through `gh repo clone`. Git cannot read PR comments, approvals, build statuses or merge decisions, so keep those behind a host API adapter. Mirror the existing harness pattern: a small static registry, one capability declaration per adapter, adapter-local commands and auth, and shared orchestration. Start with operations the coordinator actually uses, not a plugin framework or a mirror of every GitHub endpoint. Keep `gh` inside the GitHub adapter; expose host-neutral operations and records to shared code, with a compatibility layer for persisted GitHub state. A host capability table must distinguish required review/CI/merge evidence from optional UI decoration. A synthetic third-host fixture should prove that a new adapter needs no scheduler, event, chain or completion-gate fork, without claiming that third host is supported.

This is the first milestone in the Git host chain. `docs/prds/bitbucket-cloud-repository.md` adds Bitbucket transport, and `docs/prds/git-host-bitbucket.md` enables and qualifies the full review loop after both predecessors merge. Until then, `init`, `doctor`, `start` and `register` must continue to refuse Bitbucket with a clear unsupported-host message.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/gh.mjs`, `lib/events.mjs`, `lib/tick.mjs` and `lib/chains.mjs` contain the current GitHub and shared review logic.
- `lib/git.mjs`, `lib/credential.mjs`, `lib/context.mjs`, `lib/state.mjs` and `lib/config.mjs` own transport and persistent identity.
- `lib/commands/init.mjs`, `lib/commands/start.mjs`, `lib/commands/register.mjs`, `lib/commands/up.mjs`, `lib/commands/doctor.mjs` and `lib/prompt.mjs` expose host assumptions.
- `docs/config.md`, `docs/guardrails.md` and `docs/chains.md` document current behavior.

## Out of scope

- Enabling Bitbucket or any other new host in this milestone.
- A dynamic adapter/plugin loader, webhook server, duplicate review loop or change to harness selection.
- Automatic merge, deployment or new credential privileges.
