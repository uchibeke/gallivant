# Codex Cloud execution

`codex-cloud` implements the experimental Codex CLI transport through the shared
task, execution journal, polling, GitHub gates and result writer. **New dispatch
is unavailable:** the pinned CLI cannot prove which repository is connected to
the selected environment. Read diagnostics and recovery of previously owned
tasks remain available. Its implementation is offline tested; live qualification
is **unverified**. Local Codex and `openai-agents` retain their existing defaults
and continuation behavior.

## Trusted worker setup

Use a trusted operator or self-hosted Node 22+ worker with persistent private
state, Git/gh and the existing enforced verification sandbox. The pinned CLI
version is **0.160.0**. Newer versions require command/output requalification;
experimental compatibility is not inferred from a greater version number.
Install and sign in using the exact configured executable:

```sh
"/absolute/path/to/codex" --version
"/absolute/path/to/codex" login
"/absolute/path/to/codex" login status
"/absolute/path/to/codex" cloud
```

The last command is the operator's native interactive environment picker, used
to identify a published Cloud environment connected to the intended GitHub
repository. This adapter never automates that UI. Configure the environment ID
and its repository explicitly; branch/ref access is checked using the existing
scoped GitHub connection. That GitHub connection and Cloud's connected-repository
authority are separate. The filtered native listing resolves the environment and
proves read authorization, but does not prove inference eligibility or confirm
the environment's repository mapping. Neither a configured repository name nor
an operator's UI observation is a machine-verified dispatch authorization.

The registry marks Cloud unavailable, and its native access check returns
`CLOUD_ENVIRONMENT_REPOSITORY` after successful read diagnostics with
`effective.repository: null`. Normal start/resume and provider readiness refuse new work;
the transport also refuses before saving a Cloud dispatch intent or calling
`cloud exec`. Initial and successor submission use the same gate. GitHub branch
access cannot substitute for Cloud environment ownership.

The exact remedy is to qualify and implement a supported documented interface
that binds the authorized account, selected environment and connected repository
before enabling dispatch. Requalification must verify branch/revision access and
model eligibility under the existing security settings. There is no configuration
flag to bypass this gate. Do not infer proof from task listing fields or use a
private endpoint, browser automation or a trial paid submission to find the mapping.

This private `config.json` entry describes the intended setup and supports owned
task recovery; adding it does not enable dispatch or change existing selections:

```json
{
  "execution": { "deadlineMs": 20000 },
  "harness": {
    "codex-cloud": {
      "bin": "/absolute/path/to/codex",
      "account": "operator",
      "authentication": "operator-chatgpt",
      "mode": "trusted-worker",
      "environment": "published_environment_id",
      "repository": "owner/disposable-repository",
      "continuation": "successor-task",
      "billing_source": "chatgpt-account",
      "allowance": { "remainingUsd": 1, "reservedUsd": 0.1 }
    }
  }
}
```

This explicit request deadline allows bounded CLI/network and native verification
work within the shared configurable limit. It does not change package defaults
or bound the duration of remote compute. Submission, access checks, listings and
diff retrieval use the shared abort signal without a shorter subprocess timeout;
standalone diagnostic calls without a signal retain a 10-second fallback. If the
deadline expires before a submission URL is received, acceptance remains unknown
and dispatch is fenced until exact ownership can be reconciled. Stopping the
submission client does not stop remote compute.

Amounts are explicit conservative accounting reservations, not a Cloud billing
cap. Unknown usage retains reservations. Cloud uses the authorized ChatGPT
account's actual plan/credits and limits; API billing is a separate allowance.
No plan eligibility, available credits, zero cost, hard spend cap or specific
model access is inferred from sign-in. Check current account usage before live
dispatch. Exactly one best-of attempt is supported; model overrides are refused
and account defaults remain unchanged. Native CLI read checks do not call a model.

This is not a demonstrated delegated multi-user mode or generic plugin OAuth
flow. Public setup must never collect passwords, browser cookies or pasted Codex
auth files. The worker uses only its operator's native sign-in store. It does not
copy another connector's identity. Configure a capable backend when mandatory
local policy or private read-only context paths are required: Cloud refuses those
options, and completion receipts do not replace pre-action enforcement.

## Dispatch, inspection and delivery

The shared `gallivant doctor` and provider readiness gates report Cloud's
unavailable capability and mapping remedy; start and resume use those gates.
Cloud remains a recognized provider in configuration, approved brief parsing and
saved recovery identities. Recognition does not authorize new work. An approved PRD
with `harness: codex-cloud` cannot dispatch until that boundary is qualified.
The following delivery contract is implemented and exercised by explicit offline
fixtures; it is not a live dispatch qualification. Restricted natural-language
preparation is not advertised for Cloud. The local Codex preparation adapter does
not supply a hosted Cloud preparation capability.

Before dispatch, the isolated owned task checkout must contain only committed
code and the approved brief/source overlays. The existing portable snapshot
validator refuses private paths, symlinks, unsupported modes and unrelated local
edits. Only approved overlay paths are committed. The coordinator pushes the task
branch, checks its exact remote head, and reads each approved snapshot at that
revision to compare its bytes/SHA-256. It then publishes a unique input ref
`<task-branch>-cloud-<full-input-head>` without changing the task's upstream.
The input ref is never advanced by the coordinator. Retain these refs for
recovery; after the logical task is retired, an operator can remove its recorded
input refs under the repository's retention policy. No automatic remote deletion
or force push is performed.

The implemented submission path rechecks the task/input refs and snapshot hashes
before `cloud exec --env ENV_ID --branch INPUT_REF --attempts 1`. That documented
call has no repository argument and stays blocked until environment mapping is
verified. Do not invoke it manually to bypass qualification or retry an owned
intent. Read-only diagnostics for previously acknowledged tasks are:

```sh
"/absolute/path/to/codex" cloud list --json --env ENV_ID --limit 20
"/absolute/path/to/codex" cloud list --json --env ENV_ID --limit 20 --cursor CURSOR
"/absolute/path/to/codex" cloud status TASK_ID
"/absolute/path/to/codex" cloud diff TASK_ID --attempt 1
```

These are native read-only examples. An exited submission command acknowledges a
URL; it does not finish remote work. Native `status` exits nonzero for non-ready tasks;
the adapter uses the JSON listing's status rather than interpreting an exit as
task failure. Every adapter inspection (including acknowledgement recovery) and
result collection checks the configured executable's exact **0.160.0** version
before reading listings or diffs, independently of the new-dispatch gate. A changed
version stops native retrieval, retains the owned task and reports `CLOUD_VERSION`;
restore the qualified executable to retry the same task. It does not reject the
result as a malformed artifact, create a successor or enable new dispatch. Already
collected, validated results are reused without another native command.
Listings paginate up to 20 pages/1 MiB with shared request deadlines,
backoff and coordinator concurrency. Every page includes the configured `--env`;
the pinned CLI resolves that environment before issuing its filtered list request.
Its list-item mapper emits a null `environment_id`, so an owned task's listing
scope comes from the successful filtered request and persisted configuration.
This scope does not prove the environment's connected repository or authorize a
new submission. The exact saved task ID, URL and single attempt remain required.
Contradictory environment metadata, missing tasks, unexpected attempts, malformed pages, cursor
loops and failed filtered requests remain unknown; there is no unfiltered fallback
or newest-task selection. Status events record the configured environment with
`environmentSource: filtered-listing`, rather than claiming a per-task field.
The CLI may also omit the attempt count when sibling metadata is unavailable.
For an owned dispatch sent with `--attempts 1`, null or omitted counts preserve
selector 1; explicit counts other than one refuse collection. Events retain the
actual reported count as `providerAttemptTotal`, including null. Missing counts
and selector 1 do not establish a native attempt ID.

Cloud `pending` remains queued/pending because this interface cannot distinguish
provisioning from execution. `ready`, `applied` and `error` observations retain
provider status, diff summaries, timestamps and the task link. Per-attempt native
IDs, token/tool transcripts, detailed provider errors, effective model and actual
per-task dollar cost are unavailable on this supported surface. The shared root
identity is the **real Cloud task ID**, not an invented provider turn ID;
`providerAttemptId` is null and `attemptSelector` is 1. A diff selector is not a
native attempt ID. Error observations enter the normalized journal; unknown cost
is null. Read-only clients consume saved state and never launch another poller.

The prompt requires the provider to verify the input head and source hashes,
make the approved change, and include `.codex-cloud-result.json` in its returned
diff. That envelope binds the run, repository, logical task branch, input head,
source hashes, neutral PR text/receipt and actual provider test records. It is
removed from the deliverable manifest. It does not authorize arbitrary actions.
The provider is instructed to leave all GitHub writing to the coordinator.

The adapter reconstructs only the saved input in a disposable directory, validates
every diff path/type/mode and checks/applies the diff there. Quoted paths, renames,
binary patches and executable-mode changes require explicit recovery rather than
lossy conversion. Wrong-base or mismatched envelopes persist a blocked collection
checkpoint. The shared result writer validates the logical task/root/base,
origin/branch, paths, modes and current head again, commits the accepted text
changes in the isolated task checkout, runs approved Verify commands in the
existing filesystem/network sandbox, and opens/updates one regular PR. Its
checkpoint reconciles already committed/pushed files and lost PR acknowledgements
without applying or verifying them twice. Provider test claims are preserved as
provider records; only coordinator-executed evidence qualifies verification.
Both hosted adapters validate each provider test record's command string, exact
input revision and integer exit status before accepting it. Empty test lists remain
empty; malformed records block collection and cannot become publication evidence.

An approved successor may return only the owned result envelope, including
`receipt`, `public-text` and explicit resume corrections.
Its empty source manifest uses the shared writer's verified pushed-revision path
at the exact input head, so verification and PR updates still require remote
head/ancestry, clean checkout and current ownership. It creates no source commit;
recovery reuses the publication checkpoint. The shared gates still decide whether
the PR text or receipt changed and whether a round made progress. Initial
dispatches still require deliverable file changes.

## Continuation, cancellation and recovery

The pinned CLI exposes no native Cloud resume/cancel command. The implemented
review correction creates a **successor task** after its exact predecessor settles. Each
child gets approved requirements/snapshots, current pushed code, trusted feedback
and recorded decisions. The shared logical session stays the initial Cloud task
ID; each run records its child task ID, parent, input revision and continuity mode.
One task branch, PR, configured round limit, current-head gates, evaluator and
human merge boundary remain canonical. There is no provider-specific review loop
and no claim that native memory was transferred.

Stop/cancel/timeout fences future dispatch, retains the task URL, and quarantines
late results. **Remote execution may continue.** Killing the CLI is not stopping
remote compute or billing. Interrupt is unsupported and cannot create overlapping
tasks. Use the native Cloud task page for any account-side intervention it offers;
this adapter does not claim or automate an unavailable native control.

Private `<state-home>/runs/<task-slug>/cloud.json` records dispatch intent and
acknowledgement; `execution.json` owns lifecycle/reservations. Per-run `job.json`,
`events.jsonl`, `job.log`, `result.json`, `verification.json` and
`result-application.json` retain observation, delivery and publication evidence.
Use `gallivant status`, `gallivant why <task>` and the tracker to inspect saved
state. Restart the same coordinator/state namespace to reconcile acknowledged
tasks. An acknowledgement saved by the transport can repair the execution
projection. A reply lost before any exact ID is persisted **stays unknown**:
inspect the saved intent and account task listing manually, without deleting
state, adopting another task or resubmitting. Automatic ambiguity resolution is
unavailable because this CLI supplies no documented idempotency key/lookup API.

## Verification and live qualification

`npm run test:codex-cloud` is offline. Run it alongside `npm test`, `npm run lint`,
`npm run test:execution-backends`, `npm run test:openai-agents` and
`git diff --check`. Native process locks and verification sandbox tests require
host process inspection and a functional native sandbox; they cannot be qualified
inside a sandbox that denies those OS facilities.

The live suite requires private `CODEX_CLOUD_LIVE_HOME`, `CODEX_CLOUD_LIVE_PRD`,
`CODEX_CLOUD_LIVE_REPO` and `CODEX_CLOUD_CAMPAIGN_LEDGER`. Use the single external
campaign ledger from the carried contract: `version: 1`, `limitUsd: 10`, an
`attempts` array with reconciled API reservations/costs, and a separate `cloud`
object containing `account: operator`, selected `environment`, `repo`,
`billingSource: chatgpt-account`, positive integer `remainingTasks`, current
`checkedAt`, a concrete `accountUsageEvidence` pointer, and positive `taskSeconds`
of at most 120. The ledger must stay outside this repository/public package.
The observation deadline cannot cap native remote compute. Unknown prior paid
API cost blocks dispatch. Cloud account allowance is separate from API dollars.

```sh
npm run test:codex-cloud:live
npm run test:codex-cloud:live -- --execute --phase=implementation
# Introduce an actual current-head CI failure or trusted review finding.
# Set CODEX_CLOUD_LIVE_CORRECTION to that finding and approved decisions.
npm run test:codex-cloud:live -- --execute --phase=correction
```

Preflight is read-only and returns unverified on missing prerequisites or the
unqualified environment mapping. With this pinned adapter, both execution phases
are blocked before account reservation or campaign dispatch intent. After a
supported mapping interface is implemented and qualified, a phase reserves one
authorized account task and persists intent before start or resume. Never repeat
an intent-bearing phase. The suite restarts the coordinator, externally verifies pushed file bytes/head, actual Verify evidence, one PR and
successor parentage, and saves `cloud-live-evidence.json` privately. Costs and
missing native attempt IDs remain unknown. Installed-plugin/browser release
evidence belongs to M5/M6; neither a CLI help check nor these fixtures qualifies it.

Command and environment references rechecked 2026-10-07; authentication checked
2026-10-06:
[developer commands](https://learn.chatgpt.com/docs/developer-commands),
[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments),
[authentication](https://learn.chatgpt.com/docs/auth).
The version-specific public CLI source was also inspected for status/JSON/diff
semantics, including [environment resolution and filtered listing](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cloud-tasks/src/lib.rs)
and [list-item mapping](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cloud-tasks-client/src/http.rs).
No internal endpoint from that source is called by this adapter.
