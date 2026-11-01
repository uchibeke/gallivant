# Git host boundary

Only `github.com` is qualified for task dispatch in this release. Bitbucket Cloud
repository and PR transport is available for setup and explicit adapter operations.
`start` and `register` remain disabled for Bitbucket until `git-host-bitbucket`
qualifies review, CI and completion semantics. Other hosts remain unsupported. The synthetic adapter in
`test/git-host.test.mjs` is an offline contract fixture, not a supported host.

`lib/host_definitions.mjs` owns the static host catalogue. `lib/hosts.mjs` binds
its declarations to Node transport implementations. Portable views and task
profiles read the same declarations without importing Node or credential code. It is independent of both the harness
registry and execution transports. Shared code obtains `hostApi(context)` and
selects a repository for dispatch through `context.hosts.select(...)`. Setup and
transport tools use `inspect(...)` or `inspectRemote(...)`; these do not qualify
the host for dispatch. The old `context.gh`
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
inherited API tokens and SSH channels. Bitbucket supports an explicitly selected
SSH key for coordinator Git operations; an SSH key alone cannot authorize the PR
API. Dispatch remains disabled, so setup never grants a sandbox extra key paths.
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


## Bitbucket Cloud setup

Configure credentials explicitly in `git_hosts["bitbucket.org"]`. Existing
`github_token_file` resolution is unchanged and is never tried for Bitbucket.
No `gh` installation or GitHub sign-in is required for a Bitbucket-only config.
Use an Atlassian account API token; repository access tokens are not required.
Request `read:repository:bitbucket`, `write:repository:bitbucket`,
`read:pullrequest:bitbucket` and `write:pullrequest:bitbucket`, limited to the
selected workspace where available. Reads do not prove write scopes: diagnostics
report them as unknown until the corresponding write, which surfaces permission
errors and never silently switches credentials.

```json
{
  "git_hosts": {
    "bitbucket.org": {
      "api": {
        "email": "operator@example.com",
        "token_file": "~/.config/repository-access/bitbucket-api-token"
      },
      "git": { "transport": "https" }
    }
  },
  "repos": [{ "repo": "bitbucket.org/workspace/repository", "base": "release/v2" }]
}
```

Keep the existing harness, operator identity, worktrees and other config settings.
Token files must be private (`chmod 600`). HTTPS Git uses the selected API token
unless `git.token_file` explicitly selects a separate private token file. Git's
helper returns the token only for HTTPS on `bitbucket.org` and the exact repository;
it uses the account-token Git username `x-bitbucket-api-token-auth`. API requests
use account email plus token over HTTPS to `api.bitbucket.org`, with redirects
refused. API and Git authorization may differ, but the base commit observed through
Git must match the API repository and base.

For SSH, use this `git` block instead:

```json
{
  "transport": "ssh",
  "ssh_key": "~/.config/repository-access/bitbucket-key",
  "known_hosts": "~/.config/repository-access/bitbucket-known-hosts"
}
```

Select an unencrypted dedicated key that the coordinator can read, with mode 600.
No SSH agent or global SSH configuration is used. The dedicated known-hosts file
must contain only `ssh.bitbucket.org` entries matching Atlassian's published
SHA256 fingerprints. Get candidate public keys from `https://bitbucket.org/site/ssh`,
select the `ssh.bitbucket.org` lines and independently check their fingerprints
against [Atlassian's SSH host-key documentation](https://support.atlassian.com/bitbucket-cloud/docs/configure-ssh-and-two-step-verification/).
Do not accept an unverified `ssh-keyscan` result. A host-key rotation stops access
until the published pins and selected file are reviewed. Strict verification is
always enabled. Existing `git@bitbucket.org:workspace/repo.git` origins and the
new `git@ssh.bitbucket.org:workspace/repo.git` origins resolve to one Cloud identity;
clones use the new endpoint described in [Atlassian's SSH migration notice](https://developer.atlassian.com/cloud/bitbucket/changelog/).
Self-hosted servers, custom SSH aliases and alternate ports are unsupported.

Run `init` from the checkout to bind the API repository UUID and workspace UUID
under the host's `repositories` map, or run `doctor` for read-only diagnostics.
Setup checks repository access, the selected base, effective account push role,
PR reads, comments when a PR exists, branch restrictions where visible, and native
Git access to the same base. An archive flag, if supplied, is enforced; the Cloud
repository schema does not currently expose that flag consistently, so absence
is reported as unknown. A missing API credential reports missing PR/comment
capability even when an SSH key is configured. A successful transport check is
followed by an explicit failed dispatch check. No paid model probe is needed for
this milestone, and `init` does not recommend starting a task on an unqualified host.

API credentials are reread for every operation. A changed email, repository UUID,
workspace UUID, canonical slug or API clone target stops access. Restore the
previous binding, or inspect the new identity and explicitly edit the binding;
setup never silently migrates a renamed or transferred repository.

## Bitbucket evidence and publication bounds

`lib/hosts/bitbucket.mjs` owns API shape and pagination differences. PR snapshots
include source/destination UUIDs, branches and commits, draft state, host state
(`OPEN`, `MERGED`, `DECLINED` or `SUPERSEDED`), title/description, diff, comments,
reviewer participants, tasks and statuses tied to the current head. Declined and
superseded PRs normalize to `CLOSED`, preserving `hostState`. UUID-based actor
identity avoids nickname ambiguity. These observations do not qualify reviewer
trust, CI policy, recovery or merge proof for dispatch.

Reads are bounded to 100 pages and 10,000 items per collection, 4 MiB per JSON
response, a diff smaller than 16 MiB, and 20 seconds per request. Missing fields,
cycles, changed filters, size inconsistencies, rate limits, foreign pagination,
redirects and changed PR identity/head during a snapshot produce explicit errors.
The documented diff redirect is allowed only into the same repository's diff
endpoint. Failures never become empty reviews or successful checks.

Publication uses the existing public-text validator, exact repository UUIDs and
source/base names. It checks PRs in all states before every publication, updates one matching open PR,
and refuses forks, closed predecessors, conflicting bases or duplicate ownership.
Writes address immutable workspace/repository UUIDs so a concurrent slug change
cannot redirect a write into a replacement repository. Every write is
followed by reconciliation, including timeouts after acceptance. An unresolved
create remains blocked in that adapter instance until a matching PR is observed;
a restart still reads before any write. Concurrent publication in one instance
is refused. There is no fork creation, merge, force push or repository-settings API.
Comments are never automatically retried after an uncertain write.

Offline coverage: `test/bitbucket.test.mjs`, `test/bitbucket-fixture.mjs` and
`test/host-transport-contract.test.mjs`. The shared contract assertions run against
both production adapters with injected wire responses. No fixture test calls a
model or writes to a live repository. Live review-loop qualification remains a
separate milestone.

API references: [repositories](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/),
[pull requests](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
and [account-token authentication](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).
