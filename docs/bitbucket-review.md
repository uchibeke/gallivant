# Bitbucket Cloud review setup and qualification

Bitbucket Cloud dispatch remains **disabled**. The transport, review protocol,
PR command, and shared lifecycle have offline regression coverage; there is no
live qualification or claim of a genuine Codex review. `start`, `register`, and
paid task preparation cannot bypass this release gate. See the
[qualification record](audit/bitbucket-review-qualification.md) for the missing
evidence. No configuration flag turns qualification on.

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
2. For HTTPS Git, the selected token authorizes Git as
   `x-bitbucket-api-token-auth`; the API uses account email/token Basic auth.
   For SSH Git, keep the API token and select the explicit SSH key/verified
   known-hosts file described in [Git host setup](git-hosts.md). SSH authentication
   alone cannot read or write PRs. HTTPS and Cloud SSH checkout origins identify
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
Select `reviewer: null` deliberately, or use the independent reviewer below.
No-reviewer mode still enforces CI, trusted commands, unresolved required feedback
and the completion receipt. Its readiness record says `none`; it is never
Codex-reviewed. The example check name must exactly match the repository's build
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
new config, or accepts identical existing host settings; it refuses to replace
conflicting settings. `--base` is validated and saved on the repository entry.
`init` binds repository/workspace UUIDs, reads the selected base and account push
role, and verifies Git's base SHA against the API. `doctor` distinguishes unknown
write scopes from observed read access. Only an actual write can prove Git push,
PR creation and comment write permission. Setup never installs a pipeline,
creates a credential, changes repository protection, or makes a paid model call.
It reports the disabled dispatch gate even when transport checks pass.

Host settings live under `git_hosts["bitbucket.org"]`. `repositories["workspace/repo"]`
may override `api`, `git`, `reviewer`, `trusted_authors`, and `required_checks`,
alongside the UUID binding. Each override replaces that setting, not another
host's credentials. A `repos` object may override reviewer/trust/check policy;
precedence is repository entry, host repository binding, host settings. Historical
top-level reviewer/trust defaults apply only to GitHub. Reviewer objects for
Bitbucket must supply every required field; the GitHub mention is rejected.

## Independent Codex or human reviewer

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
review request. These transport steps are covered by offline tests; the intervening
Codex execution and end-to-end publication are still unqualified:

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
reuses an identical already-posted verdict. Uncertain comment writes are not
silently retried. Keep the real model transcript/run ID with qualification
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

`task-pr` is the bounded PR CLI used by Bitbucket start/fix/resume prompts. It takes
the coding API credential from the session's explicitly bound environment and
verifies the checkout origin and branch before every operation. It supports
`create`, `view`, `diff`, `edit --body-file`, and `comment --body-file --reply-to`.
It has no merge, deployment or repository-settings operation. Credentials never
enter arguments, prompt text, committed files or another host's default resolver.
This CLI's offline support does not by itself qualify any local harness.

Once a release has passed live qualification, local PRD commands use the verified
checkout, and `register` uses the exact PR URL. Host-qualified state/worktree keys
prevent a same-named GitHub repository controlling a Bitbucket PR. Base overrides
flow through clone, PR publication and later base updates. Today those dispatch
commands stop at the qualification gate; do not modify source flags to run them.
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
- Dispatch disabled: complete the documented live qualification matrix. Editing
  the receipt or passing fixture tests cannot remove this gate.

API semantics are based on Atlassian's [PR APIs](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/),
[commit ancestry API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/),
[source metadata](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/),
and [account API-token guidance](https://support.atlassian.com/bitbucket-cloud/docs/using-api-tokens/).
