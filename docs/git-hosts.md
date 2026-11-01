# Git host boundary

Only `github.com` is qualified in this release. Bitbucket and other hosts remain
unsupported by init, doctor, start and register. The synthetic adapter in
`test/git-host.test.mjs` is an offline contract fixture, not a supported host.

`lib/host_definitions.mjs` owns the static host catalogue. `lib/hosts.mjs` binds
its declarations to Node transport implementations. Portable views and task
profiles read the same declarations without importing Node or credential code. It is independent of both the harness
registry and execution transports. Shared code obtains `hostApi(context)` and
selects a repository through `context.hosts.select(...)`. The old `context.gh`
property is retained as an integration/test compatibility seam. New lifecycle
code must not use it. GitHub CLI commands, wire normalization, prompt commands,
learning endpoints and rulesets belong to `lib/gh.mjs`, `lib/hosts/github.mjs`
and the GitHub diagnostics feature module.

## Identity and compatibility

`repository.mjs` parses HTTPS, HTTP (historical GitHub input, upgraded before use),
scp-style SSH and `ssh://` input. It rejects ambiguous authorities, ports,
queries, fragments, encoded path characters, traversal and unsupported schemes.
It never embeds rejected input in errors. HTTPS userinfo is discarded; it is
never a credential source. Canonical records contain `host`, `path`,
`remoteIdentity` (`host/owner/repository`) and `key`.

The historical GitHub key remains `owner/repository`; another qualified host's
key is `host/owner/repository`. Entry IDs, worktree paths and run folder names
include that key. Existing GitHub IDs, branch prefixes, cursors, receipt hashes,
PR metadata and chain ownership tokens are read without rewriting them.
Review/inline/comment IDs keep their old cursor keys, such as `review:42`.
A short handle still works when it identifies exactly one entry. Ambiguity
requires `host/owner/repository#number`. Contradictory saved identities and duplicate
PR ownership stop with a backup/reconciliation instruction; no automatic
migration, cursor reset or redispatch repairs them.

## Adapter declaration

Each registry declaration supplies:

| Field | Contract |
| --- | --- |
| `host`, `id` | Canonical authority and stable completion-evidence adapter ID |
| `capabilities` | Required evidence and optional decoration, separately declared |
| `credential(config, repository)` | Resolve current API/HTTPS authorization for the bound host; never cache at daemon boot |
| `remote(repository)` | Verified clone URL, protocol, host and repository path |
| `create(options)` | Repository/API operations with injected transport and credentials |
| `parsePr(url)`, `prUrl(repository, number)` | Strict PR routing and canonical UI links |
| `prompts` | Host-specific create, inspect, CI-log and receipt-edit instructions |
| `dataContract` | `host-records-v1` |

Required capabilities are `pullRequests`, `reviews`, `comments`, `checks`,
`diff`, `mergeProof` and `recovery`. Missing required capabilities fail closed.
`labels` is optional: an adapter without labels does not block readiness.
GitHub retains its existing retry semantics for label writes. Learning and
ruleset operations are GitHub features, not mandatory adapter methods.

Repository operations cover branch/default-branch and permission reads, exact
ref/ancestry proof, file reads, PR view/list/diff, review/comment pages, comments,
body/title/recovery writes, ready-for-review and idempotent publication.
`fileAtStrict` distinguishes a missing file from inaccessible or incomplete
content. The shared chain engine requires the exact merge commit to be an
ancestor of the intended base; a closed PR never authorizes a successor.

First-party review additionally requires `reviewEvidence(repo, pr, head, base,
maxBytes)`: complete diff and before/after changed-file content, including
deletions, bound to exact head, base and merge-base IDs. Qualification and
reconciliation refuse adapters without this operation before launching a
reviewer or reusing clearance. Evidence reads and policy/dispute label writes
use the same repository registry and credential binding as other lifecycle
operations. Review jobs and verdicts remain coordinator-owned.

## Domain records and completeness

Every normalized record carries `source` (host and adapter), `actor` (login and
bot flag), `eventId`, `headSha`, `createdAt` and `updatedAt`. Unknown optional
values are explicit nulls. Review/comment records also carry `at`, `reviewId`
and `replyTo`. Their original numeric `id` remains stable for saved cursors.
CI records expose `outcome: passed | failed | pending`, name, URL and optional
run ID. Wire-specific CI classification exists only in the adapter.

PRs retain the established domain field names (`headRefOid`, `headRefName`,
`baseRefName`, `state`, `mergeCommit`, `mergedAt`, `statusCheckRollup`, body,
author and URL). These are contract fields, not permission to import a host
client. The GitHub adapter keeps legacy event aliases for existing consumers;
the review engine accepts the canonical actor, head and timestamp fields too.

A list is either a complete array or `{ items, complete: true }`. Incomplete
pages, absent CI, rate limits, authentication failures and unreadable diffs
throw before a readiness decision. GitHub pagination uses bounded subprocess
output; PR list/check limits are refused at their cap. Shared retries preserve
cursors, dispatch ownership and the last known decision. Optional decorations
never supply review, CI or merge evidence. The shared loop has one reviewer
verdict and one CI outcome predicate for every qualified host.

## Transport and provider binding

The shared Git layer clones with native `git clone --filter=blob:none`. The
GitHub policy converts accepted GitHub SSH/HTTP inputs to verified HTTPS; no
shared Git method constructs a GitHub URL. Existing fetch, base selection,
operator commit identity, isolated configuration and push behavior remain.
Origin and push destinations are checked against the repository identity before
credentialed network operations.

The HTTPS helper reads Git's requested protocol, host and repository path before
returning the bound token. It resets repository credential helpers, refuses
redirects and receives secrets only through environment variables. Clone URLs,
argv, committed files and public diagnostics contain no token. A run clears
inherited API tokens and SSH channels. The current qualified transport is HTTPS;
an SSH key alone cannot authorize the PR API. Adding an SSH transport requires
qualification of its explicit key binding before registry registration.
GitHub resolution order remains configured token file, daemon environment,
then `gh auth token`, with explicit-file failure refusing fallback. Resolution
happens for each operation so reauthentication works without restarting.

Providers declare `repositoryAccess`: `local-worktree`, `snapshot`, or
`bound-host` with allowed authorities. The shared pre-dispatch check enforces it
before clone or paid preparation. A local-worktree provider needs no adapter
change to use another qualified host. No host-by-harness switch table exists.

## Regression evidence

`test/git-host.test.mjs` exercises canonical identity, saved state, collisions,
normalized feedback, provider access, native clone, token isolation, failure
preservation and a synthetic host through readiness and chain merge proof.
`test/git-host-architecture.test.mjs` rejects direct host CLI/API imports or
prompt commands and a second host-specific review/CI branch in shared modules.
The existing review, recovery, receipt, chain and execution suites retain
coverage for bounded retries and idempotent writes. All these tests are offline
and make no model calls.
