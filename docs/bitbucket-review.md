# Bitbucket Cloud review setup and qualification

Bitbucket Cloud dispatch remains **unqualified** and its enabling pull request is
draft. Disposable public and private repositories completed live local Codex
tasks through regular PR publication and receipt acceptance with **no reviewer
configured**. The private coding session could still read the coordinator's
merge-capable API-token file by path. Removing the token from its environment and
using a bounded PR mailbox therefore does not isolate that credential. Do not
start unattended tasks in other Bitbucket repositories until an OS-enforced
credential boundary or a server-enforced non-merging coding identity is tested.
An independent automated reviewer, clean Linux installation, and merge-gated
chain remain unvalidated. See the
[qualification record](audit/bitbucket-review-qualification.md).

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
Select `reviewer: null` deliberately. No separate reviewer account is required
for this policy once dispatch qualifies. After `init`, record
`"review": { "legacy_no_review": true }` in
that repository's entry in `~/.gallivant/config.json`; keep `reviewer: null` in
the host policy. This makes the no-review choice explicit in the local config.
No-reviewer mode still enforces configured CI, trusted commands, unresolved
required feedback and the completion receipt. Its readiness record says `none`;
it is never independently reviewed. The example check name must exactly match the repository's build
status name. An empty `required_checks` list permits the explicit no-CI behavior:
zero checks waits for `checks_grace_minutes`, then passes the CI gate. Any named
required check missing from a complete response remains pending indefinitely;
missing/partial responses, rate limits, outages and pending checks never pass.

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

## Independent Codex or human reviewer

This is a possible later setup, not part of the live qualified no-reviewer path.
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
