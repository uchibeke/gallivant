# Bitbucket Cloud review setup and qualification

Bitbucket Cloud dispatch and complete first-party evidence capture are implemented.
The independent local review route is still **live-unqualified** until the public
and private disposable repository matrix records a genuine blocking verdict,
same-session correction and fresh exact-head clearance. Earlier disposable runs
proved regular PR publication and receipt acceptance with **no reviewer
configured**; they are not review evidence. The private coding session could also
read the coordinator's merge-capable API-token file by path, so that historical
coding-credential hold remains separate from reviewer credential isolation. Do
not migrate an existing legacy run or start unattended work on the strength of
offline fixtures. See the [qualification record](audit/bitbucket-review-qualification.md).

## First setup, including a checkout with no existing configuration

Use Node 22 or later, Git, and an explicitly selected installed local Codex or
Claude executable. Bitbucket setup does not require `gh` or GitHub sign-in.
Version/sign-in diagnostics do not prove model access. Existing GitHub defaults
and runs retain their previous review semantics.

1. Obtain an Atlassian **account API token** scoped to the intended workspace,
   with `read:repository:bitbucket`, `write:repository:bitbucket`,
   `read:pullrequest:bitbucket`, and `write:pullrequest:bitbucket`. Save it in a
   private file (`chmod 600`). Supply the account email separately. An account
   API token can be used with a free-plan repository; this does not require a
   workspace/repository access-token subscription or Agentic Pipelines.
2. For HTTPS Git, the coordinator uses the selected token as
   `x-bitbucket-api-token-auth`; the API uses account email/token Basic auth.
   For SSH Git, keep the API token and select the explicit SSH key/verified
   known-hosts file described in [Git host setup](git-hosts.md). SSH authentication
   alone cannot read or write PRs. The coding session receives neither token nor
   SSH key through environment variables: its bounded PR mailbox asks the
   coordinator to push and publish. A same-user coding process can still read
   the configured private files unless a separate boundary denies those reads.
   HTTPS and Cloud SSH checkout origins identify
   the same repository; self-hosted servers and SSH aliases remain unsupported.
3. Write a host settings file outside the coding checkout. Example:

```json
{
  "api": {
    "email": "operator@example.com",
    "token_file": "~/.config/repository-access/bitbucket-api-token"
  },
  "git": { "transport": "https" },
  "trusted_authors": ["{11111111-1111-1111-1111-111111111111}"],
  "reviewer": null,
  "required_checks": ["Tests"]
}
```

Replace the example UUID with the operator's stable Bitbucket UUID, not a nickname.
Select `reviewer: null` deliberately; the local first-party path needs no separate
Bitbucket reviewer account. After `init`, configure the repository entry for a
new reviewed run:

```json
{
  "repo": "bitbucket.org/workspace/repository",
  "reviewer": null,
  "review": {
    "mode": "first-party-required",
    "route": "codex",
    "max_input_bytes": 100000,
    "max_jobs": 2048,
    "budget_usd": 100,
    "zero_checks": false
  }
}
```

Keep `review.legacy_no_review: true` only for a deliberately unreviewed legacy
run while live qualification is unavailable. That mode still enforces configured
CI, trusted commands, unresolved required feedback and the completion receipt,
but its readiness record says `none`; it is never independently reviewed. The
example check name must exactly match the repository's build status name. An
empty `required_checks` list does not waive CI for a version-1 policy: a repository
with no checks must explicitly set `review.zero_checks: true`. Missing/partial
responses, rate limits, outages and pending checks never pass.

From the intended checkout:

```sh
gallivant init --harness codex --host-config /absolute/path/bitbucket-host.json --base release/v2
gallivant doctor
```

`--host-config` imports settings for the verified checkout's host. It creates a
new config, or accepts unchanged settings while preserving UUID bindings added
by setup. JSON member order does not matter; changed or omitted policy and
conflicting identity bindings are refused. `--base` is validated and saved on the repository entry.
`init` binds repository/workspace UUIDs, reads the selected base and account push
role, and verifies Git's base SHA against the API. `doctor` distinguishes unknown
write scopes from observed read access. Only an actual write can prove Git push,
PR creation and comment write permission. Setup never installs a pipeline,
creates a credential, changes repository protection, or makes a paid model call.
It reports dispatch availability separately from transport access.

Host settings live under `git_hosts["bitbucket.org"]`. `repositories["workspace/repo"]`
may override `api`, `git`, `reviewer`, `trusted_authors`, and `required_checks`,
alongside the UUID binding. Each override replaces that setting, not another
host's credentials. A `repos` object may override reviewer/trust/check policy;
precedence is repository entry, host repository binding, host settings. Historical
top-level reviewer/trust defaults apply only to GitHub. Reviewer objects for
Bitbucket must supply every required field; the GitHub mention is rejected.

## Independent local Codex reviewer

The host adapter binds the repository UUID, PR number, full head and base object
IDs, and merge base. It paginates `diffstat/<head>..<base>?topic=true`, compares
that changed-path inventory to the complete raw comparison, and reads regular
UTF-8 source at the merge base and head through `src/{commit}/{path}`. Added,
modified, removed and renamed files all carry before/after text as applicable.
Unsupported binary, subrepository, missing-patch, duplicate, truncated, stale,
rate-limited, redirected and oversized evidence is refused. The coordinator
captures bounded symlink target data as untrusted Git objects without following
the link. Unsupported targets or ambiguous type transitions block review.
The PR binding is read again after capture. The API token stays behind the host boundary and is not
part of the reviewer prompt or environment.

The coordinator requests bounded PNG and JPEG sides at the exact revisions and
requires a separate image-capability qualification before launching visual jobs.
It combines their validated reports with text review and whole-PR synthesis.
The image qualification does not itself qualify the host or complete a PR review;
the [disposable live screenshot review](audit/bitbucket-review-qualification.md#live-image-qualification-and-disposable-review-2026-11-03)
reached a clear verdict after its owned outputs were recovered; the resend PR
has not been rechecked. Preserve the original files and incomplete state when any
capability or evidence is unavailable.

Qualify the exact configured executable/provider route only after authorizing its
separate paid challenge:

```sh
gallivant review qualify --repo bitbucket.org/workspace/repository
gallivant review qualify --repo bitbucket.org/workspace/repository --run --wait
gallivant review qualify --repo bitbucket.org/workspace/repository
```

The first and last commands are read-only. `--run` starts at most the one durable
qualification job for that fingerprint; CLI version and sign-in checks alone do
not prove selected-model access. Start refuses before author dispatch if the route
cannot qualify.

Qualification fingerprints use the adapter's selected provider environment,
configuration, credentials and executable. Parent-agent session and tool-call
IDs do not invalidate an existing qualification. The private Codex profile drops
the desktop-only `daybreak` flag for CLI compatibility; strict inspection of
effective permissions and managed policy remains required.

For a settled existing run that still has the explicit legacy snapshot, use the
audited transition and then recheck the same PR:

```sh
gallivant review policy HANDLE --mode first-party-required \
  --reason "Enable the qualified independent local reviewer"
gallivant recheck HANDLE
```

This is the only path that removes the saved legacy policy. It retains the task
identity, original PRD snapshot, PR, checkout and implementation session. A
failed route preflight changes nothing and launches no review. Do not edit an
active WebBabyShower brief or local policy as an implementation test.

Each reviewer job is a fresh restricted Codex execution with no implementation
session, context mounts, tools, network, host/Git credential or publication
authority. The 100,000-byte input cap applies to every job. Large evidence is
split into immutable source/patch slices, including a single large lockfile or
line; every slice repeats the aggregate identities and all acceptance criteria.
Clearance requires every piece to complete and match. `max_jobs`, `budget_usd`
and per-job timeout bound the aggregate. If the full change does not fit those
bounds, the run stops with `review-incomplete`; no path or suffix is omitted.

## External Bitbucket reviewer account

This is an alternative external-review setup, not required by the local path.
Use a separate Bitbucket account for the automated reviewer. Configure its stable
UUID, never its display name, nickname, the coding account, or a Pipeline label:

```json
{
  "reviewer": {
    "actor_id": "{22222222-2222-2222-2222-222222222222}",
    "rereview_comment": "Review the current commit and post a work-review verdict.",
    "blocking_pattern": "\\bP[01]\\b"
  }
}
```

This fragment belongs in the coding coordinator's host/repository policy. The
reviewer token does **not** belong there. On a separate operator-controlled
reviewer machine, OS account, or isolated container, store another private config
with the same policy and the **reviewer** account email/token in `api`. Its token
needs repository read and PR read/write. The coding agent must have no filesystem,
environment, secret-store or container access to that credential. A private file
in a directory readable by the coding identity is not isolation. The review model
needs only the prepared input and a read-only checkout, never publication secrets.
Codex requires its own supported sign-in or provider credentials and actual model
access; CLI installation/sign-in alone cannot qualify it.

The installed `task-review` tool separates preparation and publication from
inference. It never invokes a model, changes model/provider settings, or posts a
review request. These review transport steps are covered by offline tests; the
intervening Codex execution and end-to-end publication are still unqualified:

```sh
task-review prepare --config /private/reviewer-config.json \
  --url https://bitbucket.org/workspace/repo/pull-requests/7 > review-input.json
```

In the isolated reviewer checkout, use the operator-selected Codex executable
under the existing read-only review permissions to inspect the input's exact
head and diff. Follow `review-input.json.instructions`. Save its actual response
as `review-result.json`, containing only this JSON shape:

```json
{
  "head_sha": "0123456789012345678901234567890123456789",
  "verdict": "blocking",
  "summary": "Concrete findings from reviewing this exact commit."
}
```

A successful model execution is not a verdict. Outside the model process, publish
its response with the separate reviewer credential:

```sh
task-review publish --config /private/reviewer-config.json \
  --url https://bitbucket.org/workspace/repo/pull-requests/7 \
  --input review-input.json --result review-result.json
```

Publication verifies the authenticated actor differs from the coding author and
matches `reviewer.actor_id`. It rechecks repository UUIDs, PR number, branches,
base, full head SHA and diff hash against the prepared input. An explicit retry
reuses an identical verdict only while it remains the reviewer's latest decision.
A superseded match causes a new publication, so blocking/clear/blocking decisions
take effect even on the same head. Uncertain comment writes are not silently
retried. Keep the real model transcript/run ID with qualification
artifacts: a manually authored fixture result cannot prove a Codex review.
An ordinary Pipeline can orchestrate these steps when an operator explicitly
installs it, enables Pipelines, and configures provider and reviewer secrets in an
isolated trusted job. Do not expose those secrets to arbitrary PR code or the
coding step. No paid Agentic Pipelines capability is assumed or installed.

The posted comment contains a `work-review` fenced JSON block. Only the configured
actor and a complete exact current SHA can clear readiness. Abbreviations, old-head
approvals, prose claiming a successful Pipeline, or a run with no posted verdict
are silence. Native Bitbucket approvals do not identify a reviewed commit and
cannot clear an automated-review gate. Native change requests and unresolved tasks
remain blockers until their authors remove/resolve them, including after one fix
round has consumed their events.

Trusted humans can post `/fix ...`. Inline findings use a verified code link to
the full source SHA or a standalone `Reviewed commit: <40-character-sha>` line.
Unknown inline heads stop readiness with the source link rather than silently
approving or dispatching a guessed head. A command explicitly naming an older head
is ignored. Replies authored by the coding account do not become new fix requests.

## Session PR operations and recovery

`task-pr` is the bounded PR CLI used by Bitbucket start/fix/resume prompts. In a
task session it writes a bounded request to the checkout's mailbox; the daemon
verifies the saved repository, branch, base and PR identity, then uses its own
Git and API credentials. `push`, `create`, `edit` and `comment` push committed
HEAD through the coordinator before publication. `view` and `diff` are read
operations. The agent receives no Git or PR token and no SSH key in its
environment. Its observed ability to read the token file remains a dispatch
blocker. The
coordinator disables checkout hooks when running Git, so an agent-written
pre-push hook cannot run with coordinator authority. The mailbox has no merge,
deployment or repository-settings operation. Direct `task-pr` use outside an
agent session still requires an explicitly bound API credential.
The PR CLI created and reconciled a disposable private PR, read its exact head,
posted a comment and updated its body. A separate live public task also used it
to open and update a regular PR. See the [qualification record](audit/bitbucket-review-qualification.md).

After the credential boundary is qualified, local PRD commands use the verified
checkout, and `register` uses the exact PR
URL. Host-qualified state/worktree keys
prevent a same-named GitHub repository controlling a Bitbucket PR. Base overrides
flow through clone, PR publication and later base updates. Use `gallivant doctor`
to confirm access and policy before `gallivant start <prd> --base <branch>`.
Hosted providers with a GitHub-bound environment are incompatible. A snapshot
provider must pass the same publication and qualification checks as a local one.

Bitbucket snapshots supply one coherent set of paginated comments, participants,
required tasks and statuses for the head. The shared event cursor, bounded fix
round, session continuation, completion gate and chain engine consume those
records. Unreadable snapshots preserve cursors. A changed PR branch/base or a
replacement repository stops with `pr-identity`. Declined/superseded PRs cannot
become done. A merged PR must match the recorded head and its merge commit must
be an ancestor of the intended base before completion or chain advancement.
No command merges the PR, force-pushes, deploys or alters protections.

## Troubleshooting

- `NO_CREDENTIAL`: select the account email and private API-token file under the
  correct host/repository. An SSH key, GitHub token or token file without an email
  is insufficient. Restore scopes before retrying; do not broaden another host.
- `reviewer.actor_id` / explicit reviewer errors: use the actual UUID and producer
  configuration, or explicitly choose no-reviewer mode. Do not use `@codex review`.
- `BB_INCOMPLETE`, `BB_STALE`, HTTP 429/5xx: restore API access or wait for the read
  retry. Never clear a cursor or turn missing evidence into an empty collection.
- `REVIEW_UNQUALIFIED`: confirm the exact `harness.codex.bin`, selected model and
  provider access, then explicitly run `review qualify --repo ... --run`. Do not
  substitute `--version`, sign-in status or an offline fixture.
- `review-incomplete` / `REVIEW_INCOMPLETE`: inspect the named missing identity,
  path, patch or required job count. For a large complete text change, raise
  `max_jobs` and `budget_usd` only within an operator-approved bound, then select
  the new policy explicitly. Unsupported binary, subrepository, malformed link, rate-limited,
  redirected or stale evidence must be corrected; increasing a byte cap is not a
  workaround.
- Screenshot evidence: check `review qualify --repo ... --capability image` for
  the exact route. Repair the reported native or provider issue before a separately
  authorized `--run`; do not repeat an unchanged failed launch. PNG/JPEG limits
  and all image sides still apply. Unsupported formats remain incomplete.
- `pr-identity`: inspect source/base/repository/head and restore the recorded
  identity. A decline or unproven merge needs operator reconciliation, not a new
  paid run or an automatic chain advance.
- Access probe fails: check the selected coordinator SSH key or HTTPS token and
  the account API token for PR operations. The coding session receives neither.
  Re-run `doctor`, then resume the existing task rather than starting a duplicate.
- PR mailbox timeout: confirm the daemon is running and can read the selected
  repository; retry the same `task-pr` operation. Do not give the coding session
  a token to work around the mailbox.

API semantics are based on Atlassian's [PR APIs](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
[commit ancestry API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/),
[source metadata](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/),
and [account API-token guidance](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).
