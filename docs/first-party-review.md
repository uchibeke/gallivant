# First-party review gate

This is an opt-in model judgement of an immutable task snapshot. It is **not Git-host bot approval**, proof that every defect was found, or authority to merge, deploy, release or advance a chain. Checks, the completion gate, trusted feedback and the existing human merge boundary still apply. The [qualification record](audit/first-party-review.md) currently records an unavailable native boundary and unmeasured live quality; do not change defaults on the strength of deterministic fixtures.

## Select a policy

New tasks snapshot one version-1 policy:

| Mode | Required evidence |
| --- | --- |
| `external-required` | Configured external actor's clear verdict for the exact head |
| `first-party-required` | Coordinator-owned first-party clear for the exact input |
| `both-required` | Both, without unresolved disagreement |

A configured external reviewer retains `external-required` by default. There is no bot-installation detection. A repository with `reviewer: null` must opt into a qualified route, or explicitly choose the legacy exception below. Missing, slow, failed and rate-limited required reviewers never count as clear and never select another policy.

For new tasks without a remote reviewer, set these keys in the operator configuration:

```json
{
  "reviewer": null,
  "review": {
    "mode": "first-party-required",
    "route": "codex",
    "specialist": null,
    "timeout_ms": 180000,
    "max_jobs": 4,
    "retries": 1,
    "budget_usd": 4,
    "max_input_bytes": 100000,
    "zero_checks": false
  }
}
```

`review` can also be set on a `repos` object. The external actor remains the configured `reviewer` object and is copied into each task. `specialist` is either `null`, `security`, or `regression`; general correctness always applies. These are short rubrics, with no policy or requirements authority.

`zero_checks: true` is an explicit operator CI policy for a repository with no required checks. An empty Git-host response alone never establishes that policy for new version-1 tasks. Missing CI stops as `missing-ci`; a missing/disabled completion gate stops separately as `completion-gate-skipped`.

Legacy records are snapshotted as version 0 on reconciliation using their last configured external requirement. An absent reviewer is explicitly displayed as **legacy no-review**, never clearance. Existing runs do not inherit new config policy choices. For an intentional new legacy run, set both `reviewer: null` and `review: { "legacy_no_review": true }`. This grants no review evidence. Back up state before upgrading: historical configurations that were never recorded cannot be recovered from PR prose, so restore the original reviewer configuration before the first reconciliation of old records.

## Qualification and diagnostics

The selected Git host must provide the complete review-evidence operation through
the shared host registry. An unsupported host or missing operation stops
qualification before native preparation, including when a saved clear exists.
GitHub retains `owner/repo` identities. Bitbucket uses
`bitbucket.org/workspace/repository`; its evidence adapter is implemented, but its
live private/public review matrix remains a separate qualification requirement.
No other Git host is supported by this review path.

Use the exact executable in `harness.codex.bin`. Only its restricted preparation profile is implemented as a reviewer route; other coding adapters are unqualified. The review service supplies text in a fresh isolated workspace, disables tools, MCP/plugins, hooks, skills, memories, delegation, telemetry and user/project instructions, denies escalation and network access from model tools, and verifies the effective native configuration including managed requirements. Provider authentication is confined to the native inference connection. The coding session and its context mounts are never reused.

```sh
gallivant review qualify --repo owner/repo
gallivant review qualify --repo owner/repo --run
gallivant review qualify --repo bitbucket.org/workspace/repository
gallivant review qualify --repo bitbucket.org/workspace/repository --run
gallivant review status <task-handle>
gallivant doctor
```

The first command only reads qualification. `--run` explicitly authorizes a separate bounded live challenge. It returns a running record; repeating the command reconciles that same keyed execution. A failed qualification is retained, not silently retried as a new paid session. Repair the observed provider/native-policy failure before requalification; changed native configuration yields a different qualification identity. A credential/configuration/binary change invalidates qualification. Setup diagnostics and start preflight require qualification and recheck the effective native boundary before author launch. A version/sign-in result alone cannot qualify a route.

`npm run test:first-party-review:live` is the opt-in disposable-repository probe. It requires `REVIEW_LIVE=1`, the normal operator configuration, and an explicit review allowance; ordinary tests never call a model. Do not run it to work around an administrator or guardrail refusal.

Codex does not expose a native USD hard cap or reliable cost receipt here. The coordinator reserves `budget_usd / max_jobs` before each review launch and consumes the reservation even when actual cost is unknown. `max_input_bytes` remains a hard per-job prompt cap (at most 100,000 bytes); it is never raised for a large PR. `max_jobs`, the reserved budget and the per-job timeout bound the complete aggregate. Job count, wall time and known pre-dispatch retries are independently bounded. This is an accounting allowance, **not a guaranteed provider billing cap**. Cost qualification and live spend measurement remain outstanding; configure a provider-side limit before relying on a monetary ceiling. Provider failure requires a person; it never spends a coding fix round by itself.

## Evidence, fixes and migration

The GitHub and Bitbucket adapters capture exact head/base/merge-base IDs, a complete diff, full before/after content for added, modified, removed and renamed files, the immutable PRD and every criterion, checks and the full completion receipt. Bitbucket additionally binds the repository UUID and PR number, consumes every diffstat page, compares that inventory to the raw commit comparison, reads source metadata/content at the merge base and head, and rechecks the PR after capture. Oversized evidence, binary/submodule/symlink content, omitted patches, duplicate or truncated pages, unreadable snapshots, rate limits and concurrent PR changes produce incomplete review. API credentials stay in the host adapter; reviewer jobs receive neither host nor Git credentials, and redirects outside the bound API repository are refused.

When the full serialized evidence does not fit one job, the shared service creates immutable byte-bounded source and patch slices. Every piece repeats the same task, repository, PR, head, base, merge base, brief, criteria, checks, receipt, policy and aggregate digest. Long single lines and large lockfiles are sliced with absolute line/column offsets rather than omitted. Every changed path and every criterion must appear in the aggregate, every piece must return a valid matching identity, and all pieces must finish before clearance. A finding in any piece, a timeout, malformed output, missing piece, conflicting finding identity, exhausted job/budget bound or unresolved scope blocks readiness. If the configured aggregate cannot hold the evidence, the result says `review-incomplete`/`REVIEW_INCOMPLETE` with the required and configured job counts; it does not review a prefix.

The model receives this material as untrusted JSON. Its output must cover all criteria, identify the route/head/input digest, leave no unresolved scope, and report either `clear` or actionable findings with severity and a quote at an actual captured file/line. Invalid, partial, timed-out, failed or tool-attempting output cannot clear. The coordinator owns the ledger under `reviews/` and the separate execution namespace under `runs/review__...`. Public comments and agent-authored approval text are never an alternative source of internal clearance.

Polling reuses captured source only when the repository, head and base still match, and rechecks the live PR binding before using it. Changed head, base, checks, receipt, policy or brief invalidates the whole aggregate, not only one piece. Piece keys make restart and repeated host pages idempotent; an old-head or partial aggregate cannot clear. A delayed poll accepts a valid result whose recorded execution completion time met the deadline; missing completion times, late results and executions still running past the deadline cannot clear.

Findings use the existing fix dispatch and round counter. Their disposition is recorded. A subsequent push needs fresh evidence. Repeated findings on the same input, required-reviewer disagreement and exhausted fix rounds stop for a person. `review dispute <handle> --finding <id> --reason "..."` records a pending dispute and removes readiness; it has no self-accept operation. A person must resolve the defect or deliberately change policy and re-evaluate it.

Findings remain `pending` during confirmed provider-health waits or a busy local runner. `dispatch-intent` is saved immediately before launch and becomes `dispatched` with the accepted run ID. A confirmed unsent refusal returns the findings to pending but still requires the existing explicit resume; an ambiguous launch retains its intent and requires a person before any retry. Waiting alone consumes no fix round.

Changing head, base, checks, receipt or policy invalidates readiness. Configured external findings and trusted human feedback still enter the shared fix path, including feedback arriving after internal clearance on the same head. The external reviewer must answer again when its previously reviewed input changes. The completion gate remains independent of model opinion.

A newly observed head retains the push-based review window, so a timely exact-head approval that arrived between polls still counts. The same rule applies when an author run settles and advances the feedback cursor. Changes to base, receipt or checks on the same head start a new review window when observed and require a later external answer.

Config edits affect future tasks. For a stopped/settled existing task, use:

```sh
gallivant review policy <handle> --mode both-required --reason "Require both reviews for this task"
gallivant review policy <handle> --mode first-party-required --reason "Enable the qualified independent local reviewer"
gallivant recheck <handle>
```

The command first proves that the selected route is qualified, then records the prior policy and reason, revokes readiness, and re-evaluates the current head. For an existing Bitbucket legacy run, this is the only path that removes `legacy_no_review`; direct config edits do not change its snapshot. The original PRD snapshot, task/run identity, PR, checkout and implementation session are retained. A failed preflight changes none of them and starts no paid review. No command here merges or advances a chain before its existing merge gate.

Policy changes and disputes share per-task process exclusion with review decisions,
including label publication and notification. If a decision is already in flight,
the command refuses without changing the policy; retry after that operation
finishes. A failed label removal leaves a durable obligation for later ticks to
retry, even while the task is stopped. Clearance stays revoked during that wait.
