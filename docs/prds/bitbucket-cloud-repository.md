---
status: ready
harness: codex
aport_decision: 713ae3a5-f136-4ac1-9aa7-d3ca58f9fed3
---

# Add Bitbucket Cloud repository and pull request transport

## Problem

The host boundary introduced by `git-host-boundary` makes Bitbucket possible but does not give a Bitbucket checkout credentials, an isolated clone or a pull request. Bitbucket Cloud uses different API, actor, PR and CI shapes from GitHub, and its workspace/repository slug is not a GitHub `owner/repo` identity. Implement the repository and PR operations behind the new boundary so that the final milestone can attach Gallivant's existing review loop. Keep unattended Bitbucket dispatch disabled until that loop and live qualification are complete.

## User stories

- As a Bitbucket Cloud repository owner, I want setup to identify my checkout and verify permissions, so that a task fails before spending model calls if it cannot push or open a PR.
- As a task owner, I want a branch and exactly one PR against my chosen base, so that retries cannot create duplicate public work.
- As a maintainer, I want Bitbucket-specific API and credential handling inside one adapter, so that GitHub and the shared lifecycle stay stable.

## Acceptance criteria

- Given a Bitbucket Cloud HTTPS or SSH origin, when the host adapter inspects it, then it resolves the workspace, repository slug and immutable repository identity through the Bitbucket API, verifies the remote and API describe the same repository, handles private and public repositories, and stops on renamed, transferred, ambiguous or unsupported hosts without writing to the wrong target.
- Given selected Bitbucket Git and API credentials, when setup or the daemon preflights a repository, then it checks repository read and push access, PR creation/read/comment access, selected base existence, archive state and any branch restrictions the API can reveal, and reports an actionable missing permission before a paid run. An SSH key proves Git access only; an account API token with Bitbucket repository read/write and pull-request read/write scopes proves API access. Any permission that cannot be proved without a write is marked unknown and checked at that write. GitHub credentials are never tried against Bitbucket; Bitbucket credentials are never sent to another host. Reauthentication is resolved per operation without silently changing the bound identity.
- Given a writable Bitbucket repository and approved base, when clone and branch setup run, then native Git uses the explicitly selected SSH key and a verified Bitbucket host key, or HTTPS with a host-restricted in-memory credential helper, and creates a separate checkout from the current base. It preserves operator commit identity and sandbox boundaries, never embeds a token in the origin URL or process arguments, never disables SSH host verification, and never assumes the agent can access an operator's SSH agent. Git and API credentials may differ but must resolve to the same verified repository.
- Given an approved title, body, branch and base, when the adapter publishes a PR, then it validates public text, reconciles by exact repository identity and branch/base, and creates or updates exactly one same-repository PR. A timeout after an accepted write triggers read-before-retry; a conflicting existing PR stops for inspection. It never creates a fork PR, force-pushes, merges or changes repository settings.
- Given a Bitbucket PR, when the adapter reads it, then it returns a bounded, complete normalized snapshot of PR identity, source/base branches and commits, draft/open/merged/declined state, description, diff, comments, reviewer participants, tasks and current-head build statuses. Pagination, rate limits, missing fields, stale data and oversized diffs have explicit error outcomes; none is converted to an empty review or green result.
- Given the existing `init`, `doctor`, `start`, `register`, `status` and dashboard surfaces, when a Bitbucket checkout or URL is encountered, then they show accurate host-specific setup and unsupported-dispatch guidance at this milestone. The config uses the host registry and host-scoped credentials, while the existing GitHub token setting remains compatible. Bitbucket task dispatch remains disabled until `git-host-bitbucket` qualifies its review semantics; GitHub behavior remains unchanged.
- Given a Bitbucket-only machine with Git, a supported harness and valid Bitbucket Git plus API access, when `init` or `doctor` runs, then it does not require `gh` installation or GitHub sign-in and it reports Bitbucket-specific permissions and the still-disabled dispatch gate. SSH-key Git access without an API credential reports the missing PR/comment capability.
- Given the Bitbucket adapter implementation, when it is compared with the GitHub adapter, then it implements the same bounded host contract and fixture suite without copying task state, event classification, prompts, the daemon loop or the completion gate. The adapter owns only Bitbucket API/auth/pagination/shape differences.
- Given fixture repositories with default `main`, non-default base, mixed-case names, private access, read-only access, SSH and HTTPS origins, when adapter tests run, then identity, permission, redaction, clone, PR idempotency and API pagination behavior match the contract without live writes or model calls.

## Implementation boundaries

Use Bitbucket Cloud's [repository and PR REST APIs](https://developer.atlassian.com/cloud/bitbucket/rest/api/) with a scoped [Atlassian account API token](https://support.atlassian.com/bitbucket-cloud/docs/create-an-api-token/) or another explicitly supported API credential; repository access tokens are unavailable in the authorized test workspace and must not be the only setup path. An account token should be limited to the selected workspace when available and request only repository and pull-request read/write scopes. Keep tokens outside source control and URLs. Use native Git with a dedicated SSH key or HTTPS credential for code transport, and the host adapter for PR state. SSH key selection must be explicit and portable across macOS and Linux; do not change the user's global SSH defaults. Host choice must not change the harness or inference-provider adapter; an incompatible hosted environment is refused at dispatch. Do not infer a Codex reviewer from Atlassian's ability to run Codex in Pipelines: that execution does not itself publish a review. The final chain milestone wires trusted feedback, CI and completion into Gallivant's loop.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Where to look

- `docs/prds/git-host-boundary.md` defines the preceding host contract and state guarantees.
- `lib/git.mjs`, `lib/credential.mjs`, `lib/context.mjs`, `lib/config.mjs` and `lib/state.mjs` own clone, credentials and identity.
- `lib/gh.mjs` is the existing PR transport; `lib/commands/init.mjs`, `lib/commands/doctor.mjs`, `lib/commands/start.mjs` and `lib/commands/register.mjs` expose it.
- `lib/execution_result.mjs` and `lib/prompt.mjs` publish PRs from hosted and local harnesses.

## Out of scope

- Enabling unattended Bitbucket tasks or claiming reviewer/CI parity before the final milestone.
- Installing Pipelines, changing repository access controls or writing to a real workspace during unit tests.
- Self-hosted Bitbucket, GitLab and other host adapters.
