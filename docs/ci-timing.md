# Run expensive PR checks after review clears

Set `ci_timing` on a repository's `repos` entry. `immediate` records an
explicit choice. Leaving the setting absent keeps immediate CI with no consent
record. `after-review` requires an active, reviewed private GitHub pilot. New
standalone regular PR tasks to the pilot base inherit its approved revision.
The task retains its brief and allowance while activation is pending.

`gallivant ci-timing owner/repo` shows the choice, activation and revision.
Intake and the task workspace show them under **Delivery & permissions**.
**Recheck PR** uses the ordinary review, CI and completion gates.

## Protected deployment

Pre-provision one disposable private repository with forks disabled, one
protected default base, one selected workflow and one isolated Codex author
route. Use `external-required` with an independent reviewer who submits a
native GitHub approval for the exact head before the selected jobs. A review
producer that waits for those jobs cannot qualify.

The coordinator reads GitHub's live repository and ruleset state through a
dedicated operator credential. Use four repository-scoped App installations.

| App | Permissions used |
| --- | --- |
| Author | Contents and pull requests write. Checks, statuses and metadata read. |
| Enrollment | Contents write and metadata read. Sole bypass of the enrollment namespace's creation and deletion rules. |
| Dispatch | Actions write and metadata read. |
| Reporting | Checks write and metadata read. Use this App only for the required verification context. |

Keep the coordinator credential, enrollment, dispatch and reporter keys,
operator ingress, registry and stored approvals outside all author, reviewer
and test workers. Bind `bindDeferredCI` from `lib/deferred_ci.mjs` to the actual
protected coordinator runtime and attach the returned service as
`ctx.deferredCI`. Supply `isolation()`, `readCredential()` and
`readInstallation({ repo, repositoryId, role, appId })`. The installation
reader returns its installation ID and private key. The isolation receipt
binds the registry, worker exclusion, launch digest, exact
`authorConfigurationDigest` for the qualified Codex configuration, and the
proof expiry. A same-user CLI or a configuration flag cannot supply that
receipt. Use an author allowance that fits the lifetime of its scoped
installation token.

## Review setup and authorize cutover

1. Keep the base's existing required checks and no-bypass, stale-review
   dismissal and up-to-date rules active. The pilot uses repository rulesets.
   Protect the enrollment namespace with
   `refs/heads/[rR][eE][vV][iI][eE][wW]-[cC][iI]/*`, restriction on creation
   and deletion, and no force pushes. The case-insensitive selector matches
   the whole reserved namespace. Protect a dedicated lightweight dispatch tag
   named `review-ci-dispatch-<revision>` with creation, update and deletion
   restrictions and no bypass. Leave repository variable `CI_AFTER_REVIEW`
   unset until running the authorized pilot.
2. Review the manual workflow change using `renderPilotWorkflow` in
   `lib/hosts/github_ci_workflow.mjs`. The version-one format accepts one
   selected workflow containing unconditional, statically named
   GitHub-hosted jobs, full-SHA action pins, a credential-free checkout and no
   secrets. Use the workflow's original head, base or test-merge checkout.
   The transformed workflow keeps its automatic events and required job names,
   calls the same tests for both triggers, and disables shared cache writes.
   Review and install the file on the protected base and immutable dispatch
   tag. Leave workflows for other suites and their triggers in place.
3. Through the protected operator ingress, submit `preview` then `approve`
   with the displayed digest and the same proposal. The proposal contains
   `version: 1`, `repo`, the numeric `repositoryId`, `base`, `workflow`
   path and `workflowId`, `originalRevision`, `revision` (the dispatch
   tag's commit), `ref` (the tag name), `checkout`, `reviewerId`,
   `checksRuleset`, `enrollmentRuleset`, `dispatchRuleset`, and `roles`.
   Each role names its `appId`; author and dispatcher additionally name
   the GitHub bot's numeric `actorId`.
4. Separately authorize the live pilot. Set `CI_AFTER_REVIEW=enabled` in the
   disposable repo only. Exercise the blocked enrolled head, clear an enrolled
   head and dispatch its exact review and candidate, and run an unenrolled PR.
   Submit `qualify` with the approval digest as `revision` and `canary`
   containing `blocked`, `deferred` and `automatic` records. Each has
   numeric `pr` and `run` fields. The deferred record also gives `request`
   (the request UUID) and ISO `requestedAt`. Observe the reporting checks on
   the test merge alongside the existing rules, then confirm qualification.
   Keep the run IDs, attempt-qualified job results and independently measured
   billable runner usage. Run the PRD's misuse, restart and offline merge
   qualification scenarios before operational use.
5. Separately issue `approve-cutover` with the same revision. Require
   `Post-review CI / verified suite` from the exact reporting App on the
   protected base. Keep the existing required checks and strict protection.
   Confirm with `cutover`, then use the saved `after-review` repo choice.
   The coordinator verifies ordinary automatic runs for unenrolled PRs so
   their required context can be reported too.

Operator requests use `ctx.deferredCI.command(ctx, operator, input)` or the
authenticated tracker's `POST /api/ci-timing` route with the normal local
mutation and CSRF checks. Supply an authenticated `bindPlanOperator` handle
with repository `read` and `ci-timing/<action>` grants. Inspect the saved
revision and receipts using `status`. The standalone CLI displays the saved
choice and does not approve changes to hosted settings.

## Reconciliation and rollback

- A request with an uncertain reply stays attached to its durable request ID.
  Inspect the exact workflow run name and protected ref. Restore Actions read
  access before asking the coordinator to observe it again. The absence of a
  matching run in a bounded listing leaves acceptance unresolved.
- The attention panel links the authenticated failed job and attempt. Correct
  the failure or refresh the head and obtain review. For the same candidate
  after proven nonacceptance or an owned terminal failure, use the protected
  `retry` operation with `revision`, `taskId` and `requestId`. A new
  request opens under that record. In-place Actions reruns cannot satisfy it.
- Drift fences admissions and dispatch. Restore the approved workflow, rules
  and authority, or issue `drain` first. Keep the protected registry and
  credentials available until owned obsolete runs reach terminal states.
  Disable `CI_AFTER_REVIEW` and obtain successful immediate CI on every
  open current head while existing rules are still in use. Record this
  observation with `restore`. Remove the added required context, verify
  `retire`, and revoke dispatch, enrollment and reporter permissions.
  Keep the receipts and choose `immediate` for new tasks.

GitHub dispatches checks against the workflow ref. The selected jobs'
candidate checkout is verified separately, and only a scoped reporting App's
check on the exact test merge can satisfy the distinct context. [GitHub workflow
dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) ·
[Required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) ·
[Cache access and workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-access-for-low-trust-workflow-triggers)
