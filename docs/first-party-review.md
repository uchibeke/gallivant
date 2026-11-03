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
    "timeout_ms": 900000,
    "max_jobs": 2048,
    "retries": 2,
    "budget_usd": 100,
    "max_input_bytes": 100000,
    "zero_checks": false
  }
}
```

`review` can also be set on a `repos` object. Defaults allow 2,048 total reviewer jobs per task, including fresh-head rereviews and final synthesis, a $100 accounting allowance, two known pre-dispatch retries and 15 minutes per job. Operators can select up to 8,192 jobs, $10,000 and one hour per job; explicit smaller limits remain enforced. Raising defaults does not silently rewrite saved task policies. The external actor remains the configured `reviewer` object and is copied into each task. `specialist` is either `null`, `security`, or `regression`; general correctness always applies. These are short rubrics, with no policy or requirements authority.

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

For recognized ChatGPT OAuth profiles, routine token refresh retains the same
qualification only when the selected account, owner, issuer, client and subject
remain consistent across the locally stored ID and access token claims. A
changed principal or provider invalidates qualification. The provider still
validates the actual credentials; unknown formats and API keys use the full
credential digest and fail closed on changes.
Unrelated absolute project trust records outside the review root do not change
the review identity. Records covering the review root and all other effective
configuration and managed policies remain bound.

`npm run test:first-party-review:live` is the opt-in disposable-repository probe. It requires `REVIEW_LIVE=1`, the normal operator configuration, and an explicit review allowance; ordinary tests never call a model. Do not run it to work around an administrator or guardrail refusal.

Codex does not expose a native USD hard cap or reliable cost receipt here. The coordinator reserves `budget_usd / max_jobs` before each review launch and consumes the reservation even when actual cost is unknown. `max_input_bytes` remains a hard per-job prompt cap (at most 100,000 bytes); it is never raised for a large PR. `max_jobs`, the reserved budget and the per-job timeout bound the complete aggregate. Job count, wall time and known pre-dispatch retries are independently bounded. This is an accounting allowance, **not a guaranteed provider billing cap**. Cost qualification and live spend measurement remain outstanding; configure a provider-side limit before relying on a monetary ceiling. Provider failure requires a person; it never spends a coding fix round by itself.

## Evidence, fixes and migration

The GitHub and Bitbucket adapters capture exact head/base/merge-base IDs, a complete diff, full before/after content for added, modified, removed and renamed files, the immutable PRD and every criterion, checks and the full completion receipt. Bitbucket additionally binds the repository UUID and PR number, consumes every diffstat page, compares that inventory to the raw commit comparison, reads source metadata/content at the merge base and head, and rechecks the PR after capture. Oversized evidence, binary or submodule content, omitted patches, duplicate or truncated pages, unreadable snapshots, rate limits and concurrent PR changes produce incomplete review. API credentials stay in the host adapter; reviewer jobs receive neither host nor Git credentials, and redirects outside the bound API repository are refused.

PNG and JPEG changes are currently binary evidence and cannot be reviewed by this route. The host adapters have an opt-in capture interface for development, but the coordinator does not use it for review. It limits captures to 32 image sides, 5 MiB per side and 16 MiB total, with dimensions at most 8192 by 8192 and 16 million pixels. Text qualification alone does not qualify image attachment, model vision or isolation. Keep screenshots in the PR and retain the incomplete result until image capture and a restricted reviewer are integrated and qualified; do not treat a fixture or a model's assertion as a live review.

The coordinator requests link-object capture from both host adapters. Bounded UTF-8 target bytes are reviewed as untrusted Git object data at each revision; targets are never resolved or followed. Unsupported targets, ambiguous type transitions, incomplete inventories or mismatched hashes and revisions fail closed. Host and reviewer qualification still applies.

Image qualification is recorded independently for the configured executable bytes,
model and reviewer configuration. `review qualify --repo OWNER/REPO --capability image`
reads its status; adding `--run` explicitly starts one bounded image challenge and
consumes the review allowance. The challenge verifies a coordinator-created copy
at the execution boundary. It is not an end-to-end PR review and does not enable
image clearance while capture, coverage and whole-PR synthesis are unintegrated.

When the full serialized evidence does not fit one job, the shared service creates immutable byte-bounded source and patch slices. Every piece repeats the same task, repository, PR, head, base, merge base, brief, criteria, checks, receipt, policy and aggregate digest. Long single lines and large lockfiles are sliced with absolute line/column offsets rather than omitted. Every changed path and every criterion must appear in the aggregate, every piece must return a valid matching identity, and all pieces must finish before clearance. A finding in any piece, a timeout, malformed output, missing piece, conflicting finding identity, exhausted job/budget bound or unresolved scope blocks readiness. If the configured aggregate cannot hold the evidence, the result says `review-incomplete`/`REVIEW_INCOMPLETE` with the required and configured job counts; it does not review a prefix.

Split review has two stages. Each local inspection judges only supplied slices,
records concrete defects and supplies bounded, source-quoted observations for
the final reviewer. Missing other pieces is expected and does not establish a
missing implementation. Local clear verdicts cannot clear the PR. If every local
inspection finishes without findings, a separate restricted whole-PR reviewer
receives the complete criteria, receipt and checks plus reports or validated
reductions covering every source piece. It
must resolve cross-file questions and return its own clear verdict. Empty reports,
unsupported quotes, unresolved scope and oversized synthesis never clear. Each
observation is verified against its captured source; final findings must also be
grounded in a supplied report. An incorrect line number is resolved only when the
exact single-line quote occurs at one unique line in the supplied file, side and
slice (or, for synthesis, a supplied report). The original and corrected line
and a quote digest are retained in the review ledger. Ambiguous, absent or
multiline quotes never gain clearance from this correction.
When execution sanitization masks a secret-looking value in a quote, the
coordinator compares it with the same sanitized form of the captured source
line. The review result retains the masked quote; matching still requires the
specified file, side and line or a unique source location.

Malformed output or an unverifiable citation receives up to the configured
`retries` fresh, tools-disabled reviewer attempts, using the same job, spend and
time limits. Previous attempts stay in the ledger; an ambiguous launch, tool
attempt or provider failure is never silently retried as a format error. A local
scope concern is retained in the ledger and carried through any reductions to
the final whole-PR reviewer; it is never accepted as clearance. Whole-PR
unresolved scope remains blocking. Older outputs rejected for citation numbering
or local-slice scope are revalidated once against the exact original input and
owned execution.
A confirmed, terminal Codex model-capacity response receives bounded retries
after one and five minutes, within the same reviewer job and spend allowances.
The saved evidence and completed pieces are retained. Authentication, quota,
policy denials, ambiguous ownership and unrecognized provider errors still stop
for inspection; no model or provider is switched automatically.
A new protocol identity retains old failed jobs
for audit without reusing their incomplete verdicts.

A local-scope inspection still requires final synthesis when partitioning happens
to produce only one piece; only an actual unsplit whole-PR review may clear
directly. If the combined reports exceed the prompt cap, the same restricted
review service reduces them in bounded groups over as many levels as needed.
Each node binds its child reports and a contiguous coverage range to the original
aggregate. Missing, duplicate or out-of-order coverage is refused, and the root
must cover every original piece. All original reports and intermediate jobs stay
in the durable ledger. Each reduction preserves source-grounded observations;
any concrete finding blocks instead of being summarized away. A reduction's
local clear verdict never replaces the final whole-PR verdict. Reduction and
final jobs consume the same task job, spend and timeout allowances, and restart
reuses their exact saved inputs and executions.

Source capture remains bounded to 16 MiB overall, independently of the higher
job allowance. The per-job input remains 100,000 bytes; synthesis must fit the
same bound. These are evidence and context limits, not spending defaults. Explicit
task/provider authorizations remain pinned. The intake planner has separate,
explicitly funded settings: up to 12 calls, 100,000 input and 16,000 output
tokens per call, $10 and a five-minute request timeout. Those higher ceilings
do not enlarge a saved task's approved allowance.

The model receives this material as untrusted JSON. Its output must cover all criteria, identify the route/head/input digest, leave no unresolved scope, and report either `clear` or actionable findings with severity and a quote at an actual captured file/line. Invalid, partial, timed-out, failed or tool-attempting output cannot clear. The coordinator owns the ledger under `reviews/` and the separate execution namespace under `runs/review__...`. Public comments and agent-authored approval text are never an alternative source of internal clearance.

Polling reuses captured source only when the repository, head and base still match, and rechecks the live PR binding before using it. Changed head, base, checks, receipt, policy or brief invalidates the whole aggregate, not only one piece. Piece keys make restart and repeated host pages idempotent; an old-head or partial aggregate cannot clear. A delayed poll accepts a valid result whose recorded execution completion time met the deadline; missing completion times, late results and executions still running past the deadline cannot clear.

The registry caches validated reads only while the underlying file identity and
timestamps are unchanged. Returned records remain detached, and another
process's atomic write invalidates the cache. This avoids repeatedly parsing a
large registry during review polling without changing write ownership or gates.
Each review advancement also reuses immutable completed jobs from one ledger
read, while retaining the same policy, input, binding and reviewer checks.

Between host polls, the coordinator advances an already captured review on its
local progress cadence. It does not refetch the PR for every piece. Terminal
local results wake the host lane, which must reread the current binding before
readiness or author dispatch. An explicit recheck or policy change also wakes
that lane immediately instead of waiting for the old polling deadline.

Findings use the existing fix dispatch and round counter. Their disposition is recorded. A subsequent push needs fresh evidence. Repeated findings on the same input, required-reviewer disagreement and exhausted fix rounds stop for a person. `review dispute <handle> --finding <id> --reason "..."` records a pending dispute and removes readiness; it has no self-accept operation. A person must resolve the defect or deliberately change policy and re-evaluate it.

Findings remain `pending` during confirmed provider-health waits or a busy local runner. `dispatch-intent` is saved immediately before launch and becomes `dispatched` with the accepted run ID. A confirmed unsent refusal returns the findings to pending but still requires the existing explicit resume; an ambiguous launch retains its intent and requires a person before any retry. Waiting alone consumes no fix round.

Changing head, base, checks, receipt or policy invalidates readiness. Configured external findings and trusted human feedback still enter the shared fix path, including feedback arriving after internal clearance on the same head. The external reviewer must answer again when its previously reviewed input changes. The completion gate remains independent of model opinion.

A newly observed head retains the push-based review window, so a timely exact-head approval that arrived between polls still counts. The same rule applies when an author run settles and advances the feedback cursor. Changes to base, receipt or checks on the same head start a new review window when observed and require a later external answer.

Config edits affect future tasks. For a stopped/settled existing task, use:

```sh
gallivant review policy <handle> --mode both-required --reason "Require both reviews for this task"
gallivant review policy <handle> --mode first-party-required --reason "Enable the qualified independent local reviewer"
gallivant recheck <handle>
gallivant review retry <handle> --reason "Retry the rejected citation with exact single-line source quotes"
```

`review retry` explicitly authorizes fresh reviewer executions for incomplete
output whose previous process exited successfully. It retains completed pieces,
original attempts, reservations and an operator-reason audit. New attempts use
the same job/spend/timeout limits and strict validation; recheck alone reuses the
old terminal record. It also accepts a reviewer cancelled by the coordinator
after a provider error only after confirming its identity, stopped process tree,
recorded cancellation reason and absence of tool attempts or denials. Ambiguous
launches, active reviewers, other provider failures, tool/boundary failures and
unresolved cancellation cannot use this shortcut.
The normal host lane rechecks the live binding before review can authorize
readiness. No author session, PR or chain merge gate is reset.

The command first proves that the selected route is qualified, then records the prior policy and reason, revokes readiness, and re-evaluates the current head. For an existing Bitbucket legacy run, this is the only path that removes `legacy_no_review`; direct config edits do not change its snapshot. The original PRD snapshot, task/run identity, PR, checkout and implementation session are retained. A failed preflight changes none of them and starts no paid review. No command here merges or advances a chain before its existing merge gate.

Policy changes and disputes share per-task process exclusion with review decisions,
including label publication and notification. If a decision is already in flight,
the command refuses without changing the policy; retry after that operation
finishes. A failed label removal leaves a durable obligation for later ticks to
retry, even while the task is stopped. Clearance stays revoked during that wait.
