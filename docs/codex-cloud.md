# Codex Cloud execution

`codex-cloud` is a selectable remote adapter using the supported experimental
Codex CLI Cloud commands. It uses the existing task, execution journal, polling,
GitHub gates and result writer. Its implementation is offline tested; live
qualification is **unverified**. Local Codex and `openai-agents` keep their
existing defaults and continuation behavior.

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
the environment's repository mapping. A real Cloud run must verify its input
revision and snapshot hashes before editing. Missing live proof remains visible.

Add this entry to the private `config.json` without changing existing selections:

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
or bound the duration of remote compute.

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

Select `harness: codex-cloud` in an approved hand-authored PRD, then use the shared
`gallivant doctor`, `gallivant ready <brief>`, `gallivant start <brief>` and
coordinator workflow. Restricted natural-language preparation is not advertised
for Cloud. PR #10's local preparation adapter is not present in this base and
must be merged rather than copied into this provider.

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

The coordinator rechecks the task/input refs and snapshot hashes immediately
before calling:

```sh
"/absolute/path/to/codex" cloud exec --env ENV_ID --branch INPUT_REF --attempts 1 "approved input"
"/absolute/path/to/codex" cloud list --json --env ENV_ID --limit 20
"/absolute/path/to/codex" cloud list --json --env ENV_ID --limit 20 --cursor CURSOR
"/absolute/path/to/codex" cloud status TASK_ID
"/absolute/path/to/codex" cloud diff TASK_ID --attempt 1
```

These are native diagnostic examples. Do not manually run `exec` to retry an
existing recorded dispatch. An exited submission command acknowledges a URL; it
does not finish remote work. Native `status` exits nonzero for non-ready tasks;
the adapter uses the JSON listing's status rather than interpreting an exit as
task failure. Listings paginate up to 20 pages/1 MiB with shared request deadlines,
backoff and coordinator concurrency. Exact saved task/environment IDs and a
single attempt are required. Missing tasks, unexpected attempts, malformed pages,
cursor loops and failures remain unknown; no newest-task selection occurs.

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

## Continuation, cancellation and recovery

The qualified CLI exposes no native Cloud resume/cancel command. Every review
correction creates a **successor task** after its exact predecessor settles. Each
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

Preflight is read-only and returns unverified on missing prerequisites. Executing
a phase reserves one authorized account task and persists intent before start or
resume. Never repeat an intent-bearing phase. The suite restarts the coordinator,
externally verifies pushed file bytes/head, actual Verify evidence, one PR and
successor parentage, and saves `cloud-live-evidence.json` privately. Costs and
missing native attempt IDs remain unknown. Installed-plugin/browser release
evidence belongs to M5/M6; neither a CLI help check nor these fixtures qualifies it.

Official references checked 2026-10-06:
[developer commands](https://learn.chatgpt.com/docs/developer-commands),
[Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments),
[authentication](https://learn.chatgpt.com/docs/auth).
The version-specific public CLI source was also inspected for status/JSON/diff
semantics; no internal endpoint from that source is called by this adapter.
