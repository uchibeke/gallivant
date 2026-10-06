# Execution transport contract

This foundation reuses the intake task service, registry claims, isolated checkout
and canonical PR lifecycle. Startup refuses a missing intake predecessor with
`EXECUTION_DEPENDENCY`; merge that predecessor into the selected base. It does not
recreate intake or introduce another review engine. The approved brief is
[the execution PRD](prds/hosted-codex-harnesses.md).

## Availability and capabilities

`executionRegistry` in `lib/harness.mjs` is the capability source for configuration,
probes, the task service's `capabilities()` and `GET /api/capabilities`. Existing
`claude`, `codex`, `opencode`, `gemini` and `goose` public names and CLI adapters are
preserved. Each entry declares authentication, environments, preparation policy,
continuation, observability, cancellation/interrupt, and cost/hard-cap support.
Mandatory policy, model and environment choices are checked before dispatch;
unsupported choices refuse execution without falling back or changing defaults.
Preparation is an optional versioned capability of that same selected provider.
The existing Claude tools-off policy is declared by its adapter; task lifecycle
code contains no Claude-only name gate. Codex and other native adapters remain
unqualified for preparation until they supply an enforced limited-authority
capability. A private HOME or a version/sign-in probe does not qualify one.

`openai-agents` and `codex-cloud` are reserved, **unavailable** entries. Their
transports, authentication, installed-plugin behavior, model access and live
qualification belong to subsequent milestones. The fixtures in the offline suite
are test-only transports and cannot qualify either provider for production.
This milestone requires no browser, capture surface, installed plugin, live model
call or paid campaign. Existing intake qualification blockers remain recorded in
[the intake evidence](audit/plugin-ready/README.md).

## Exported boundary

Package subpaths `./execution` and `./execution-result` export `makeExecution`,
`EXECUTION_VERSION`, `PROVIDER_STATES`, `executionLive`, `executionRunner`,
`assertExecutionDependency` and `reconcileExecutionResult`. `makeExecution` takes
an owned root, task ID, provider/account, capabilities and either the existing
local runner or a transport. Its local facade preserves `start`, `current`,
`read`, `lines`, `settle`, `kill`, `waitForKill` and `dirOf`.

A transport implements the following asynchronous methods. Every method must
honor its `AbortSignal`, bound responses, release resources on abort, and avoid
creating its own scheduler or review loop. The coordinator owns progress/review
scheduling. Explicit task preparation mutations can reconcile one owned turn at
its persisted cadence; read-only clients never call a transport.

| Method | Input and acknowledgement |
| --- | --- |
| `prepare` | Preparation kind, prompt, authorized limited environment and allowance; confirmed boundary and bounded environment grant, without paid submit |
| `submit` | Task/provider/account, canonical run ID, operation ID, idempotency key, prompt/input head, mandatory policy, allowance; exact provider job, session and root turn IDs |
| `inspect` | Exact owned job/session/turn, event cursor; authoritative state, observation time, optional nullable `completedAt`, bounded event page, next cursor, explicit gap and nullable cost |
| `continue` | Same dispatch contract plus this provider's recorded native session; exact new owned job/root turn acknowledgement |
| `collect` | Exact job/session/turn/input head; finished boolean outcome, nullable cost, optional nullable `completedAt`, saved result and optional artifact manifest or verified pushed revision |
| `cancel` | Task/provider/account/run, exact owned job/session/root turn, durable cancellation idempotency key and AbortSignal; boolean `confirmed`, true only after authoritative remote cancellation |
| optional `lookup` | Persisted intent/idempotency key after lost acknowledgement; authoritative exact job observation, or unresolved null |

The public boundary's `inspect()` is deliberately a cached read. Its coordinator
`reconcile()` invokes transport inspection/lookup. Reading CLI status, task
inspection, UI status/history/results or SSE never probes providers, submits work,
or starts an independent provider loop.

For intake, `makeExecution.prepare()` returns an issued `receipt` and either the
native `{cmd, args, options}` spec or a remote environment grant. The receipt
contains version 1, provider/account, authority/boundary, task ID and an input
fingerprint. `submit({kind: "intake", preparation: receipt, ...})` requires an
issued receipt matching the exact prepared input. Changing argv, prompt or grant
cannot reuse it. Environment credentials remain private; only their fingerprint
enters execution state. Native preparation uses the selected CLI/config defaults,
the existing small environment allowlist and enforced adapter argv. Optional
adapter configuration receives an AbortSignal and the transport deadline;
deadline or concurrent cancellation never issues late authority.

Drafting, clarification and repair all call this operation and the shared submit,
reconcile, collect and cancel boundary. Remote preparation returns `preparing`
while acceptance or results are unknown, retaining exact ownership for explicit
resume. It never waits in an independent polling loop. Unknown cost stays null;
each remote turn reserves up to one sixteenth of the original task budget, and
accounting retains the greater of reservation and reported usage. The existing
16-turn, three-repair and runtime limits, immutable owner requirements,
deterministic validation/readiness and explicit implementation consent remain
canonical. Preparation grants no implementation or GitHub-writing authority.

Example normalized observation and result (provider identities are illustrative):

```json
{
  "providerJobId": "job-123", "sessionId": "session-123", "turnId": "root-2",
  "state": "succeeded", "observedAt": 1780000000000, "cursor": "page-2",
  "events": [{"eventId": "delta-7", "sequence": 7, "type": "output",
              "timestamp": 1780000000000, "data": "verification finished"}],
  "costUsd": null
}
```

```json
{
  "providerJobId": "job-123", "sessionId": "session-123", "turnId": "root-2",
  "inputHead": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "outcome": {"finished": true, "ok": true, "cost": null, "denials": []},
  "repo": "owner/repository", "branch": "work/example",
  "files": [{"path": "src/example.txt", "beforeHash": null,
             "afterHash": "SHA256-of-text", "text": "new content"}],
  "pr": {"title": "Implement example", "body": "Reviewable receipt body"}
}
```

Hashes must be real SHA-256 values, and input heads real exact revisions. Result
collection supplies canonical version/task/run identities even if a transport
returns conflicting fields. Missing, oversized, mismatched or incomplete results
remain unresolved; provider success alone does not mean workflow readiness.

`completedAt` is the exact owned root's completion time in UTC epoch milliseconds,
not submission-client exit or collection time. An inspection may supply it only
for a terminal state, between the recorded start and its authoritative observation.
A collected result may supply it between start and collection, no later than the
first terminal observation; it must agree with any recorded exact completion.
Invalid, conflicting or foreign timestamps cannot qualify output. Missing/null
timestamps remain compatible: the first terminal observation provides an inferred
upper bound, or collection time is the conservative bound for an older result.
Remote `job.json` retains compatible `endedAt` plus `completionInferred`; exact
completion and `terminalObservedAt` survive restart in execution metadata. Local
process completion and identities retain their existing semantics.

Preparation retrieves terminal results before applying runtime allowance, even
when task resume occurs after the deadline. It compares this owned completion
time (or conservative bound) with the saved inclusive deadline. Timely output is
eligible for deterministic validation; late/unknown-late output preserves result,
usage and cost evidence but cannot authorize readiness or another repair. Missing
or invalid results stay pending without cancelling an already completed root.
A timeout/unsafe-boundary stop of active or unresolved work persists its intent
in the task attempt before control I/O. Unconfirmed, failed or unsupported stops
keep the intake `preparing`, with an explicit cancellation next action and no new
dispatch. Call `task resume` with the current revision to reconcile that owned
stop through the boundary's persisted cadence until cancellation or terminal
completion is confirmed, then the task becomes `blocked` and output is quarantined.
Older blocked timeouts with a pending owned stop permit this same control-only
resume. Other blocked refusals remain inert; inspect/list never poll providers.

## Durable state and reconciliation

`execution.json` version 1 records task/provider/account ownership, current run,
operations, stop fence and cumulative allowance. Each operation records the input
fingerprint, canonical run ID, deterministic idempotency key, intent timestamp,
input head and acceptance (`unknown` or `accepted`). Intent is atomically persisted
before submit/continue. Issued preparation receipts live in `preparations`, keyed
by their exact input fingerprints; intake execution metadata records its receipt
and `kind`. Task attempts retain receipts, reservations and cached execution
observations. Legacy scalar receipts remain valid only for the selected adapter's
declared boundary; another provider's receipt cannot authorize readiness,
answers, dispatch or recovery. The process-identity lock serializes mutations on the
operator's local filesystem; this is not a distributed multi-host lease.

Accepted execution metadata in both the registry and compatible `job.json`
contains transport kind, exact job/session/root-turn IDs, environment/model/policy, provider state,
nullable `observedAt`, `reconciledAt`, `nextAttemptAt`, failures, cursor, nullable
cost, collected/quarantined flags, controls and saved workflow ownership. Saved
workflow cursors recover a correction accepted before registry acknowledgement.
A repeated operation with identical input reuses its acknowledgement; changed
input conflicts. Unknown acceptance never authorizes another dispatch. Startup
and periodic lookup reconcile it; without authoritative lookup an operator must
inspect the recorded key and restore exact ownership. Never delete that intent to
force a retry. Remote submission/continuation acknowledgements and every lookup
or observation require nonempty string job and root-turn IDs. A job-only reply
keeps its reservation and unresolved intent. Incomplete older remote records
must recover the root through the intent lookup; job-level inspection or cached
results cannot fill that identity. Collection validates saved results against the
exact task/run/job/root turn as well as newly retrieved results. Raw job projections
use the recorded transport kind (or canonical registry for older records) and
cannot treat an unresolved remote root as terminal; CLI runs need no root-turn ID.

For local adapters that do not echo a session ID, the boundary retains the session
minted by the existing start path. Legacy continuation uses the recorded registry
session for that same provider/root, or its native output identity. An active
legacy writer still fences dispatch; a foreign session cannot be substituted.

Provider states are `queued`, `provisioning`, `running`, `waiting-for-input`,
`retrieving-results`, `succeeded`, `failed`, `cancellation-requested`, `cancelled`
and `status-unknown`. They are separate from existing workflow/review states.
Stale reads, missing events, launcher exit, a cached response or silence cannot
complete a remote turn. Both success and failure enter retrieval until an exact
finished result is saved; `terminalState` retains the authoritative root outcome
while workflow settlement waits. Fresh and cached results must agree with that
outcome before persistence or settlement; the shared PR writer enforces the same
check before artifact or GitHub operations. A contradictory result stays
unresolved with `EXECUTION_RESULT`, retaining its observation, ownership and
allowance without authorizing another run. A later inspection cannot replace
the retained terminal state. Older collected records whose state contradicts
their retained observation re-enter retrieval; their private cache remains for
inspection and cannot authorize publication. Records without exact job/root
ownership cannot retain a qualified terminal claim; lookup must establish that
identity and its authoritative completion before a cache can settle it.
Correct the provider's exact owned
result before retrying collection; do not erase identities or redispatch.
Failure diagnostics, denials, usage and recovered
session identity survive collection and cached-result replay. `collectedAt` records
durable retrieval separately from owned completion/observation timestamps, so
restart does not lose cost, session or completion time. Older failure records claiming collection without a
result re-enter retrieval without redispatch. Failed artifacts remain private;
only a successful collected outcome can enter the shared publication path. A
stop during terminal result retrieval or after collection quarantines the result
without issuing a cancellation call for a root already known to have finished.
Foreign job/root-turn observations refuse reconciliation. Unavailable
status carries timestamps, retry time and recovery action rather than fabricated
liveness. Terminal collected results survive log removal.

## Scheduling and limits

Configuration may override the integer `execution` limits validated by
`lib/config.mjs`; `EXECUTION_LIMITS` is the default. Per-operation transport and
health deadlines are 2 seconds, progress cadence 10 seconds, maximum exponential
backoff 5 minutes with jitter/Retry-After, concurrency 4, event pages 100 records
and 64 KiB. Native standalone CLI version/sign-in probes keep their compatible
20-second subprocess bound; coordinator probes additionally receive the shorter
abort deadline. Health is persisted per provider **and account**. A success stops
authorizing dispatch at its saved `nextAttemptAt`, before the due refresh starts
and while it waits for a probe worker or reply. Read-only health checks enforce
that deadline across restart without probing or changing the saved observation.
Fresh scopes remain independent; failed checks retain their backoff and remedy.
The shared fix/resume path rechecks health after checkout, credentials, input-head
and remote preparation, immediately before submit/continue or local launch. A
failure at that boundary leaves feedback and run ownership available for retry
on the existing coordinator schedule, without a submission intent or paid call.

One coordinator tick has separate bounded progress and GitHub review worker
lanes. Provider checks run alongside them and register due scopes before the
tick. Dispatches waiting on health leave the review workers free. A bounded
dispatch lane joins only those already scheduled scoped probes, then retries
once after the observation is persisted. It uses the same dispatch function,
rechecks registry ownership and stop fences, and never starts probes itself.
A successful refresh can release work in that tick; failures preserve the
feedback cursor for the next review interval. Progress polling is independent of
`poll_seconds`, which still schedules entry review and chain merge/ancestry reads.
Each tick instance checks chains immediately on boot, then at most once per
review interval; failed chain checks consume retries only on that schedule.
GitHub authentication health has a separate bounded lane and `github-health.json`
scope keyed by the startup login. It refreshes on `poll_seconds` with the same
backoff/deadline rules, publishes `probes.gh` in daemon status and retains the
existing `gh not ready` notification and authentication remedy. It cannot consume
provider probe workers or fence unrelated execution progress. The native GitHub
probe receives the abort signal, including a credential lookup that finishes
after its deadline. Status/UI reads only persisted observations and never probe.
Startup forces reconciliation
once, then saved retry times govern subsequent inspection. Provider failures do
not globally suppress ticks. UI polling reads these persisted results.

## Journal, projections and retention

Each new run retains compatible `job.json`/`job.log` plus:

| File | Contract |
| --- | --- |
| `events.jsonl` | Version 1 redacted normalized records: task/run/provider, event ID, ingestion sequence, provider sequence, provenance and timestamp |
| `journal.json`, `event-keys/` | Durable append checkpoint and hashed exact provider/job/turn/event replay keys; interrupted append becomes an explicit gap |
| `job.idx`, `log-meta.json` | Fixed-width 8-byte offsets, version 2 offset-plus-one encoding, stable sequence numbers and retained first sequence; zero entries denote gaps |
| `local-output.json` | Raw local ingestion byte cursor, bounded page, pending marker and persistent `discarding` state |
| `local-output-queue.json` (task run root) | Version 1 ordered unfinished local run IDs; persisted before replacing `latest-run` |
| `result.json` | Mode 0600 private collected result, original artifact manifest/payloads, redacted outcome and `artifacts` summary; independent of retained logs |
| `result-application.json`, `verification.json` | Artifact application/publication checkpoint and actual approved verification observations |

Provider-order numbers survive out-of-order arrival; ingestion order remains
monotonic. Replay keys survive restart and projection retention. Rotation,
truncation, missing indexes, oversized records and unrecoverable interrupted
history produce explicit gaps rather than renumbering replay IDs or inventing
output. Redaction occurs before journals, public projections and saved evidence,
using recognized credentials and supplied resolved secret values.
Overlapping supplied values are replaced longest first without changing the
caller's secret list, so environment order cannot expose a credential suffix.
Verification merges coordinator environment and execution/run secrets in one
redaction pass via `sanitize(value, runId, extraSecrets = [])`; existing callers
can omit the extra list.
Artifact paths, hashes and text retain the provider's exact bytes in the private
result. Diagnostic redaction never rewrites publication input. The coordinator still checks original
hashes and ownership before application. Modified/truncated content cannot publish.
The additive version 1 `artifacts` field is a redacted path/hash summary generated
by collection, overriding any provider-supplied summary. Tracker result responses
use this summary for artifacts and application paths, and never include file text.
Legacy results without the summary retain their already-redacted projection.
Verification output also uses the execution boundary's supplied-secret redaction.
Previously modified cached artifacts remain invalid; restore exact artifacts for
the recorded provider job/root turn before publication, without redispatching.

Journal append recovery reads at most 65,537 bytes at the saved pending offset.
An invalid or partial pending record is removed by truncating to that offset
before a complete gap record replaces it. Previously acknowledged bytes remain
intact. A complete pending record with a missing newline receives its delimiter
before another event can append. Recovery and subsequent replay preserve the
original sequence/event ID and do not append a second replacement gap. If an
existing journal is shorter than the acknowledged offset, recovery refuses and
preserves it: restore its matching backup before replay instead of extending
the file with zero bytes or claiming a damaged prefix was repaired.

Completed local output may outlive its current-run pointer. Before a successor
can save an execution intent or start, the runner preserves the old unfinished
cursor in `local-output-queue.json`. Coordinator reconciliation drains one
queued run page and one current-run page, each at most 100 records and 262,144
raw bytes (200 records and 524,288 bytes per observation; maximum single buffer
262,144 bytes). Pending runs rotate through the queue; journal byte-position
identities and atomic checkpoints make restart/replay duplicate-free. The queue
is drained even when legacy execution metadata has no current record. Public
status, tail and history reads do not ingest diagnostics or mutate this queue.
Results settle independently of this backlog, so a large old log cannot postpone
unrelated execution or GitHub review. Unsupported queue versions, invalid cursors
and queue persistence errors preserve diagnostics and refuse a new paid intent;
restore the matching compatible package/checkpoint before dispatch or replay.

An oversized raw local record emits one stable gap at its starting byte ID.
`discarding: true` then consumes bounded pages through that record's newline;
no suffix can enter normalized history or the public projection. At an active
EOF the flag remains pending until a delimiter or confirmed local exit. A final
unterminated oversized record is discarded through EOF. Restart, queue rotation
and cursor acknowledgement replay retain this state. Older mid-record cursors
are recognized with a one-byte lookbehind inside the same per-page read budget
and discard the remaining continuation. Invalid discard state refuses dispatch
or replay with the checkpoint/backup remedy.

Private local diagnostics use `provider.log` and `sensitive-redactions.json`
(mode 0600 in the private run tree). They are excluded from routes/projections.
The redaction metadata records a 24-hour expiry; coordinator observation removes
expired diagnostics once a durable result exists. If queued bytes expire before
projection, or diagnostics/redaction metadata are missing or truncated, the
coordinator appends a stable explicit gap before removing the queue item; it
never projects raw output without its redaction metadata. For older drained runs,
retention maintenance must remove these two private files at expiry after
checking `result.json`; never remove the result/application evidence. Legacy raw
local files keep their existing runner semantics.

Public tail/history reads are capped at 400 lines, 256 KiB data plus at most
3,208 index bytes, 64 KiB per encoded line. JSON escaping is included in response
budgets. Large legacy logs without indexes use a bounded suffix and explicit
byte-position replay IDs; small legacy logs preserve numeric line IDs. New logs
always have stable numeric journal sequence IDs. An absent index with existing
metadata is an explicit recovery gap, not a legacy renumbering fallback.

Existing `/api/run/output`, `/api/run/log`, `/api/run/history` and
`/api/run/status` routes remain compatible, including mount prefixes and foreign
configured run trees. `Last-Event-ID` resumes replay; history's `before` cursor
paginates older windows. SSE has a 20-second heartbeat, a 320 KiB pending-buffer
cap, pauses file reads on backpressure, and removes watchers/timers/listeners on
disconnect. The browser caps live and history DOM at 2,000 lines each and pending
lines at 400. Buffered events retain their SSE replay IDs. Display drops coalesce
into a bounded pair of recovery cursors, separate from the oldest history cursor;
the existing history button retrieves the missing windows without a `skipped`
frame. History merges by replay ID, avoids duplicates with painted/pending rows
and preserves older pagination through bursts and reconnects, including legacy
byte IDs. DOM eviction also exposes recoverable history. A failed history read
retains its cursor; page exit aborts the read and discards pending/late frames.
`/api/run/result` exposes saved outcomes, artifact hashes and
verification evidence after log retention, without exposing raw diagnostics.

## Controls, costs and publication

`cancel` queues a protected operator control and immediately fences dispatch. The
coordinator records cancellation requested before calling a supported transport,
then distinguishes authoritative confirmation from unsupported/unconfirmed
cancellation. Native local cancellation retains verified process-tree cleanup;
active runs carried across an upgrade are adopted with their exact local run and
session identity before cancellation. This stop-only record has `legacy: true`,
`operationId: null`, unknown cost and no invented submission intent. Cancellation
remains requested while owned descendants survive or inspection is unavailable;
restart reconciliation confirms only the same observed run and quarantines its
late output. A kill request alone never confirms cessation.
Cancelling after a local run has been collected preserves its success/failure,
exit, end time, result, usage and session; only future dispatch is fenced. No
process stop is requested for that completed run, including when cancellation
capability is unavailable. Restart reconciliation preserves the same historical
outcome. Completed pre-boundary local jobs also retain their original files and
identity without an invented stop/adoption record. Active local stops still
require exact process-tree confirmation and quarantine their late results.
If an owned local job has already exited before collection, cancellation saves
its exact exit/end-time snapshot and the future-dispatch fence, then uses the
same local settlement helper to retain its outcome, usage and session. A failed
cache write remains in `retrieving-results`; restart reconciliation or a repeated
cancel completes that saved snapshot. This requires the matching job, an actual
recorded exit and no prior active stop. Uncertain exits and output arriving after
an active stop retain the existing cancellation/quarantine path.
Remote cancellation never equates stopping a submission client with stopping its
job. The additive `execution.cancellation` record stores status (`pending`,
`acknowledged`, `confirmed`, `unsupported` or `terminal`), request reason/time,
idempotency key, attempt/failure counts and retry times. A stop requested during
unknown submission acceptance remains pending. Authoritative lookup first saves
exact owned job/root identity, then the existing coordinator sends the stop.
Lost stop replies retry the same key under bounded backoff; transports must make
that cancellation key idempotent. An acknowledged unconfirmed stop is inspected
until cancellation is authoritative, without resending every tick. Unsupported
stops never call the transport. Natural completion still quarantines the output
and records `terminal`, without claiming cancellation. Applied control receipts
are updated when the matching run's later reconciliation confirms cancellation.
No read-only client drives this recovery. Interrupted continuity requires native
capability and exact session ownership.
Cancelled/timed-out work cannot overlap a replacement; late results are
quarantined. A requested deadline abort leaves unknown acceptance unresolved.

A local implementation `timeout` fences dispatch while its owned process tree
is stopping. Cancellation or restart reconciliation releases only this timeout
fence after the exact matching local run is confirmed non-live; missing/different
runs, surviving descendants and unreadable process state keep it fenced. The
timed-out run remains collected and quarantined, so late success or a saved
result cannot rewrite settlement or qualify publication. The canonical timeout
stop and stranded-work diagnostics remain on the entry; explicit `resume` can
then continue the same session in its existing branch/worktree. This also repairs
older local timeout fences on reconciliation. Operator cancellation, preparation
allowance stops and remote timeout fences remain in force. A later timeout retry
cannot replace an operator or preparation stop with a recoverable timeout.

Remote dispatch requires a positive reservation and positive finite remaining
allowance. Reservations accumulate durably, including unknown usage; they are not
released on missing cost. Accounting charges the greater of each reservation and
its reported usage, preserves higher prior usage and deduplicates repeated reads.
Execution metadata and settlement outcomes retain the maximum finite nonnegative
cost reported for the exact run. Missing, invalid or lower observations and
collected estimates cannot erase known spend. Private results preserve the
provider's reported cost; `outcome(runId)` and the tracker result projection
combine it with that run's durable operation cost, including after restart or
when a subsequent turn is active. These reads never poll a provider.
Older regressed projections recover known cost from their owned operation.
Unknown cost remains null and is never reported as zero.
An exhausted allowance refuses further dispatch. Future providers must enforce
any mandatory hard cap in their declared capability; this boundary does not
advertise billing enforcement a transport cannot provide.

Shared result publication validates task/run/root-turn/input-head ownership,
repository origin, task branch/base, paths/symlinks and artifact content/base
hashes before mutation. Every artifact target is canonicalized with the shared
repository containment/symlink validator before any content is read. Equivalent
spellings (`a.txt`, `./a.txt`, repeated separators) cannot name duplicate targets.
The manifest also rejects paths that collide after NFC normalization and Unicode
upper/lower folding, including file or parent-directory case aliases. This is a
conservative portable manifest rule on every filesystem, including case-sensitive
checkouts: distinct files with ambiguous case/Unicode spellings require separate
results. A single accepted path keeps its casing and original artifact bytes;
application, commit paths and lost-acknowledgement reconciliation use the same
canonical Git-relative paths. The private provider manifest remains unchanged.
Each target component is also compared with tracked HEAD and index paths before
content reads or mutation. A single artifact cannot introduce a case/Unicode
alias of an existing file or parent directory, including a directory with a
different child filename or a file/directory collision. Exact tracked spelling
remains valid for edits and deletions. The same check runs before publication
recovery; pushed results validate their complete tracked tree. Published receipt
replay remains read-only. Missing or incomplete metadata blocks publication.
Git path reads use NUL separators, preserving spaces and newlines, with a
2-second deadline and 1 MiB output cap per HEAD/index query. Ownership checks on
staged and changed paths reuse that bounded reader without trimming filenames.
Text-only manifests preserve each target's input Git mode (`100644` or `100755`);
new files use `100644`. Before reading payloads or applying changes, the shared
Git helper compares input, current HEAD and index modes with the actual regular
file's owner executable bit. Uncommitted, staged and already-committed mode
changes cannot be adopted into a text result, even when its content hash matches.
Missing, malformed or incomplete mode metadata refuses publication; tree/index
records reuse the NUL reader's 2-second and 1 MiB limits. The same guard covers
lost commit replies and verified-result replay. Exact-mode edits/deletions and
regular creations remain recoverable; pushed revisions describe their own modes.
Applied content and input ancestry reconcile lost commit
acknowledgements. Only existing Git/GitHub helpers commit, push and reconcile one
regular PR. Approved immutable PRD Verify commands run in the owned checkout
with real exit/output/timestamp/revision evidence (120-second, 256 KiB command
bounds). They use a fixed non-login POSIX shell (`/bin/sh -c`), preserving the
approved command text without selecting the operator's `SHELL` or sourcing login
startup files. Verify commands must use POSIX shell syntax and explicitly invoke
any other interpreter they need. Provider assertions are not verification
evidence. The canonical tick continues to own readiness, trusted feedback,
freshness, receipts, conflicts,
rounds and human merge boundaries. No automatic merge is added.

Verification requires the recorded applied commit and a clean Git index/worktree,
including untracked files. The existing strict Git status helper checks both
before commands, after each successful command and before PR publication; a
status failure blocks publication. Ignored build outputs remain subject to the
repository's own ignore rules. No verification-created edits are silently
committed, discarded or represented as part of the verified revision.

The application checkpoint advances through `applying`, `verifying`, `verified`
and `published`. A failed command, changed revision, dirty checkout or unavailable
status/evidence becomes `blocked`, with its reason and `blockedAt` timestamp.
Each completed command persists real evidence, including a failing exit or an
unknown exit on a transport error. A restart that finds `verifying` records
`verification-interrupted`: commands may have run and cannot be replayed safely.
The coordinator settles the provider run separately and enters `needs-human`
with reason `result-verification`; provider success and unknown cost stay truthful.
Polling, read-only projections and PR recheck cannot retry blocked verification.
Inspect the private checkpoint, evidence and retained checkout, then explicitly
resume the same session (or send a correction) to authorize a new corrective run.
The old run's blocked evidence remains intact. A push/PR acknowledgement failure
after `verified` retries only publication, requiring the same clean revision and
complete successful evidence for the approved command list. A published replay
returns the saved PR without executing commands again.

## Upgrade and rollback

1. Stop the coordinator and preserve its private home, registry, queued chain
   snapshots, run trees and immutable PRD/source snapshots. Do not interrupt local
   children merely to upgrade; their recorded identity survives launcher exit.
2. Install the compatible package and restart one coordinator. Legacy version 1
   registry entries/local runs stay readable without changing task/PR/session IDs.
   Startup reconciles recorded runs before paid dispatch. Review the status and
   recovery action for every unresolved acceptance. A pre-upgrade `verifying`
   checkpoint stops as interrupted; inspect its preserved evidence and explicitly
   resume for correction instead of deleting it to rerun verification.
3. Back up the entire matching state before rollback. Older packages can retain
   legacy local registry/job files, but must not operate active remote metadata or
   new private-output runs they do not understand. Restore the matching package
   and state backup together; do not clear run pointers, transplant sessions or
   erase intents to make an old coordinator proceed.
4. An unsupported registry, execution, health, local output queue or journal version fails with an
   actionable compatible-package/backup remedy. Preserve the original files and
   resolve that version error before restarting; redispatch is not a migration.

Run `npm run test:execution-backends` for focused G3/G3a/G6 fixture coverage and the
full Verify set for regressions. [The foundation evidence](audit/plugin-ready/execution-foundation.json)
is an offline G8 receipt, with live-provider status explicitly unqualified.
The [shared preparation follow-up](audit/plugin-ready/execution-preparation.json)
records the owner correction, final verification and source/output review.

## Next milestone handoff

M3/M4 and APort must consume these shared preparation/submit/inspection/result/
control operations and the existing task service, without copying a runner or
adding a review engine. An implemented provider registers preparation version 1,
its concrete `boundary`, limited `authority` and remote `environment`; a CLI
adapter additionally supplies its enforced `render`, optional abortable
`configure` and required native minimum version. The context's `capabilitiesFor`
and `executionFor` must use that same registry. Mark provider availability only
after its implemented transport and required live evidence exist.

The owner is investigating the Codex preparation adapter separately in
`/private/tmp/gallivant-shared-preparation`. Integrate that independently verified
adapter with this contract; this foundation neither duplicates its fix nor
certifies its sandbox, model access or installed-plugin behavior. Preserve the
operator's model/provider defaults, genuine limited preparation authority,
bounded attempts and execution consent. Carry unmet live qualification evidence
forward rather than substituting these deterministic fixtures.
