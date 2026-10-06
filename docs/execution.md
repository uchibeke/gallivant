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
| `inspect` | Exact owned job/session/turn, event cursor; authoritative state, observation time, bounded event page, next cursor, explicit gap and nullable cost |
| `continue` | Same dispatch contract plus this provider's recorded native session; exact new owned job/root turn acknowledgement |
| `collect` | Exact job/session/turn/input head; finished boolean outcome, nullable cost, saved result and optional artifact manifest or verified pushed revision |
| `cancel` | Exact owned job/root turn; `confirmed: true` only after authoritative remote cancellation |
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
contains exact job/session/root-turn IDs, environment/model/policy, provider state,
nullable `observedAt`, `reconciledAt`, `nextAttemptAt`, failures, cursor, nullable
cost, collected/quarantined flags, controls and saved workflow ownership. Saved
workflow cursors recover a correction accepted before registry acknowledgement.
A repeated operation with identical input reuses its acknowledgement; changed
input conflicts. Unknown acceptance never authorizes another dispatch. Startup
and periodic lookup reconcile it; without authoritative lookup an operator must
inspect the recorded key and restore exact ownership. Never delete that intent to
force a retry.

For local adapters that do not echo a session ID, the boundary retains the session
minted by the existing start path. Legacy continuation uses the recorded registry
session for that same provider/root, or its native output identity. An active
legacy writer still fences dispatch; a foreign session cannot be substituted.

Provider states are `queued`, `provisioning`, `running`, `waiting-for-input`,
`retrieving-results`, `succeeded`, `failed`, `cancellation-requested`, `cancelled`
and `status-unknown`. They are separate from existing workflow/review states.
Stale reads, missing events, launcher exit, a cached response or silence cannot
complete a remote turn. Success enters retrieval until an exact finished result
is saved. Foreign job/root-turn observations refuse reconciliation. Unavailable
status carries timestamps, retry time and recovery action rather than fabricated
liveness. Terminal collected results survive log removal.

## Scheduling and limits

Configuration may override the integer `execution` limits validated by
`lib/config.mjs`; `EXECUTION_LIMITS` is the default. Per-operation transport and
health deadlines are 2 seconds, progress cadence 10 seconds, maximum exponential
backoff 5 minutes with jitter/Retry-After, concurrency 4, event pages 100 records
and 64 KiB. Native standalone CLI version/sign-in probes keep their compatible
20-second subprocess bound; coordinator probes additionally receive the shorter
abort deadline. Health is persisted per provider **and account**, and stale
success stops new work only for its scope.

One coordinator tick has separate bounded progress and GitHub review worker
lanes. Provider checks run alongside them. Progress polling is independent of
`poll_seconds`, which still schedules review reads; startup forces reconciliation
once, then saved retry times govern subsequent inspection. Provider failures do
not globally suppress ticks. UI polling reads these persisted results.

## Journal, projections and retention

Each new run retains compatible `job.json`/`job.log` plus:

| File | Contract |
| --- | --- |
| `events.jsonl` | Version 1 redacted normalized records: task/run/provider, event ID, ingestion sequence, provider sequence, provenance and timestamp |
| `journal.json`, `event-keys/` | Durable append checkpoint and hashed exact provider/job/turn/event replay keys; interrupted append becomes an explicit gap |
| `job.idx`, `log-meta.json` | Fixed-width 8-byte offsets, version 2 offset-plus-one encoding, stable sequence numbers and retained first sequence; zero entries denote gaps |
| `local-output.json` | Raw local ingestion byte cursor, bounded page and pending marker |
| `result.json` | Mode 0600 private collected result, original artifact manifest/payloads, redacted outcome and `artifacts` summary; independent of retained logs |
| `result-application.json`, `verification.json` | Artifact application/publication checkpoint and actual approved verification observations |

Provider-order numbers survive out-of-order arrival; ingestion order remains
monotonic. Replay keys survive restart and projection retention. Rotation,
truncation, missing indexes, oversized records and unrecoverable interrupted
history produce explicit gaps rather than renumbering replay IDs or inventing
output. Redaction occurs before journals, public projections and saved evidence,
using recognized credentials and supplied resolved secret values. Artifact paths,
hashes and text retain the provider's exact bytes in the private result; diagnostic
redaction never rewrites publication input. The coordinator still checks original
hashes and ownership before application. Modified/truncated content cannot publish.
The additive version 1 `artifacts` field is a redacted path/hash summary generated
by collection, overriding any provider-supplied summary. Tracker result responses
use this summary for artifacts and application paths, and never include file text.
Legacy results without the summary retain their already-redacted projection.
Verification output also uses the execution boundary's supplied-secret redaction.
Previously modified cached artifacts remain invalid; restore exact artifacts for
the recorded provider job/root turn before publication, without redispatching.

Private local diagnostics use `provider.log` and `sensitive-redactions.json`
(mode 0600 in the private run tree). They are excluded from routes/projections.
The redaction metadata records a 24-hour expiry; coordinator observation removes
expired diagnostics once a durable result exists. For older, no-longer-current
runs, retention maintenance must remove these two private files at expiry after
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
lines at 400. `/api/run/result` exposes saved outcomes, artifact hashes and
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
Remote cancellation never equates stopping a submission client with stopping its
job. Interrupted continuity requires native capability and exact session ownership.
Cancelled/timed-out work cannot overlap a replacement; late results are
quarantined. A requested deadline abort leaves unknown acceptance unresolved.

Remote dispatch requires a positive reservation and positive finite remaining
allowance. Reservations accumulate durably, including unknown usage; they are not
released on missing cost. Accounting charges the greater of each reservation and
its reported usage, preserves higher prior usage and deduplicates repeated reads.
Unknown cost remains null and is never reported as zero.
An exhausted allowance refuses further dispatch. Future providers must enforce
any mandatory hard cap in their declared capability; this boundary does not
advertise billing enforcement a transport cannot provide.

Shared result publication validates task/run/root-turn/input-head ownership,
repository origin, task branch/base, paths/symlinks and artifact content/base
hashes before mutation. Applied content and input ancestry reconcile lost commit
acknowledgements. Only existing Git/GitHub helpers commit, push and reconcile one
regular PR. Approved immutable PRD Verify commands run in the owned checkout
with real exit/output/timestamp/revision evidence (120-second, 256 KiB command
bounds). Provider assertions are not verification evidence. The canonical tick
continues to own readiness, trusted feedback, freshness, receipts, conflicts,
rounds and human merge boundaries. No automatic merge is added.

## Upgrade and rollback

1. Stop the coordinator and preserve its private home, registry, queued chain
   snapshots, run trees and immutable PRD/source snapshots. Do not interrupt local
   children merely to upgrade; their recorded identity survives launcher exit.
2. Install the compatible package and restart one coordinator. Legacy version 1
   registry entries/local runs stay readable without changing task/PR/session IDs.
   Startup reconciles recorded runs before paid dispatch. Review the status and
   recovery action for every unresolved acceptance.
3. Back up the entire matching state before rollback. Older packages can retain
   legacy local registry/job files, but must not operate active remote metadata or
   new private-output runs they do not understand. Restore the matching package
   and state backup together; do not clear run pointers, transplant sessions or
   erase intents to make an old coordinator proceed.
4. An unsupported registry, execution, health or journal version fails with an
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
