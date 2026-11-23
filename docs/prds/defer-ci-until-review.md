---
status: ready
harness: codex
aport_decision: e2e671f1-ce13-4f20-9f8d-7c764b2fe067
---

# Run expensive PR checks after review clears

## Problem

Every new PR head can start browser, matrix, and integration jobs before reviewers have found the changes they want. In one recent PR, two superseded heads used about 53 of 83 runner-minutes across four attempts, excluding job rows carried forward on rerun. Operators want to choose when selected CI runs once per repository and keep that choice for future tasks. Review should begin as soon as a regular PR opens, and the suite must still pass before the PR can advance.

## User stories

- As a repository operator, I want to review and save the timing policy once, so that new tasks can run unattended.
- As a reviewer, I want to review the current PR before the expensive suite runs, so that findings arrive before more runner time is spent.
- As a maintainer, I want the existing tests and merge protections to enforce the tested revision, so that savings preserve release quality.

## First delivery

Qualify new standalone PR tasks in one pre-provisioned private GitHub test repo with one protected base, one selected suite, one qualified author route, and the existing `external-required` policy. Use an explicit repo setting and one isolated GitHub App for reporting. Keep current scheduling for other work. The pilot qualifies dispatch and required checks before automated setup or broader admission.

## Acceptance criteria

- Given any start, when it reaches shared `startRequest` preflight, then resolve CI timing from the operator's repo setting and snapshot the approved revision alongside review policy. An unset repo uses immediate CI without saving consent. Verify activation and supported scope before cloning or author dispatch, including retained starts. Pending setup preserves the brief and launch allowance. Keep existing chains, plans, and registered PRs on their admitted paths. Reject a new unsupported admission into the deferred scope. Boot recovery requires protected ownership evidence to adopt a deferred run.
- Given a proposed activation, when the operator reviews it, then show the repo identity, protected base, enrollment selector, exact workflow diff and revision, required checks, authority, and rollback. Authenticate enrollment before the first PR event and preserve CI for older tasks and other PRs. Use the same tests for immediate and dispatched verification with the original base, head, or merge checkout semantics. Preserve other workflows, base pushes, releases, and nightly runs. Prove the new required context alongside existing enforcement before separate approval of the settings cutover.
- Given an enrolled regular PR, when the author pushes or the base changes, then use hosted PR identity and the existing feedback cursor and rereview flow. Require fresh clearance for the exact head from the configured independent reviewer with authenticated actor or App identity. Prove the reviewed head contains the current base. After base advance, use the existing base refresh and review the refreshed head. Deferred check progress leaves that request intact. Preserve the full `reviewBinding` for final readiness. Require a reviewer that can clear before the selected checks.
- Given fresh clearance on an eligible candidate, when the coordinator requests `workflow_dispatch`, then recheck the live PR, review, required rules, and approved workflow and action revisions before writing. Use an authenticated operator ingress and scoped dispatcher and reporter credentials outside all workers. Author credentials exclude Actions, workflow, status, check, and admin writes and bypass. Check actor, event, protected ref, workflow revision, and first attempt before expensive jobs. Recheck the live candidate and record the exact tested revision. Give candidate code read-only access, isolated or disabled cache writes, and no persisted checkout credential. Keep the reporting App inaccessible to tested code.
- Given restart or a lost reply, when the host loop reconciles CI, then reuse its decision lock, durable registry, and cooldowns. Key one initial request by verified repo, PR, head, tested base or merge revision, workflow revision, and suite. Persist review evidence and a unique request ID before submission. Correlate by returned run ID or one exact host match for the request ID in the trusted run name and pinned dispatch identity. Keep ambiguous submissions actionable after bounded observation. Retry only after proved nonacceptance or a qualified terminal outcome. Record and reconcile cancellation of owned obsolete runs by ID, including after task closure. Approved retries get a fresh request ID within the same record.
- Given deferral or actual execution, when the coordinator interprets checks, then use one classification for watching, recovery, and completion. Deferred jobs wait for review. Genuine missing evidence and ungated failures retain current treatment. Require actual success for each selected job, a distinct required context pinned to the reporting App, and strict up-to-date base protection. Neutral, skipped, stale, and wrong-source evidence leaves the gate blocked. Recheck the live binding before reporting success and readiness. Record the verified suite, head, and tested base or merge revision in existing delivery evidence. Preserve completion and merge gates.
- Given a deferred failure, when the coordinator handles it, then attribute it through authenticated run, attempt, and job evidence. Dispatched run metadata identifies the workflow ref. Preserve that fact and verify the tested revision separately. Reuse the current CI repair path only where its evidence contract is satisfied. Otherwise put the exact failed job in the existing attention panel with its next action. Deduplicate deferred failure evidence by run and attempt so a prior ungated failure on the same head cannot mask it.
- Given a saved choice or pending run, when shown in the existing CLI and task workspace, then display timing and activation in preflight and **Delivery & permissions**. Reuse the task phase and CI evidence for **Waiting for review**, **Confirming CI request**, **CI queued**, **CI running**, **Verifying delivery**, and actionable failures. Show who can advance each state and link to verified reviews or runs. **Recheck PR** observes normal gates. On drift or rollback, fence new admissions and dispatches. Reconcile owned runs, restore and prove immediate CI for open heads, then change required settings and revoke permissions. Keep receipts.

## Qualification

Before enabling a real repo, separately authorize a disposable pilot. Show zero selected runner-minutes on blocked heads, one suite on clearance, and automatic tests on an unenrolled PR. Exercise unauthorized actors, in-place reruns, spoofed reports, stale head or base, reused SHAs, failures, skips, duplicate polls, lost acknowledgement, restart, and rollback. Prove GitHub blocks merges with missing or failed verification while Gallivant is offline. Compare the same review sequence and runner configuration. Count actual executions, cancellations, retries, and setup and reporting overhead. Deduplicate carried-forward rerun rows. Report time to readiness and billing usage separately.

## Where to look

- Reuse `startRequest` in `lib/commands/start.mjs`, the GitHub doctor in `lib/hosts/github_doctor.mjs`, and protected approval patterns in `lib/operator_intent.mjs`.
- Extend feedback and check decisions in `lib/tick.mjs`, `lib/events.mjs`, `lib/review_policy.mjs`, and `lib/ci_repair.mjs`. Reuse `withReviewState`, durable state updates, and the scheduler in `lib/recovery_schedule.mjs`.
- Add the required host operations through `lib/hosts.mjs`, `lib/gh.mjs`, and `lib/hosts/github_actions_status.mjs`. Reuse the write fence. Verify repository ID mapping, retain cooldowns across installation-token refresh, and isolate the reporting context. [Workflow dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) · [Required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) · [Cache permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-access-for-low-trust-workflow-triggers)
- Reuse `lib/tracker/intake.mjs`, `lib/tracker/presentation.mjs`, `lib/tracker/attention.mjs`, and `lib/tracker/workspace.mjs`. Update setup, configuration, commands, and troubleshooting for the supported path.

## Follow-on work

Use existing repo registration and reviewed approval surfaces to offer **Run CI immediately** or **Review CI setup** before the first task. Show timing before preparation. After exact preview and confirmation, Gallivant opens a setup PR for supported workflows. Unattended starts consume saved policy. Extend chain and plan approval to pin that policy before queueing, preserving merge and ancestry checks. Extend first-party and combined review with a separate source-review phase using the existing reviewer ledger. First-party currently requires green CI and binds checks into its evidence.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:ui`
- `UI_INSTALL_BROWSER=1 npm run test:install`
- `git diff --check`

## Out of scope

- Automatic workflow migration in the first delivery, other hosts, fork PRs, and merge queues.
- Repository-wide workflow disabling, branch protection bypass, auto-merge, deployment, and release.
