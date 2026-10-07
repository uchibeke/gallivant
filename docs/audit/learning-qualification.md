# Review learning qualification record

Status: **UNQUALIFIED / collection only**. Date: 2026-10-07.

This record is implementation evidence, not deployment enrollment or proof of
human approval. Disposable test keys cannot authorize a production installation.

| Surface | Observed evidence | Result |
| --- | --- | --- |
| macOS host | Darwin 25.3.0 arm64; Node v22.22.0; `/usr/bin/ssh-keygen` | Offline Verify passed; actual counts and output below |
| Actual configured native sandbox | `/Users/uchi/.local/share/gallivant/codex/node_modules/.bin/codex sandbox macos --help` returned `sandbox-exec: sandbox_apply: Operation not permitted` | UNQUALIFIED; no unchanged retry |
| Linux | No Linux execution host available in this session | NOT RUN; run `npm run test:learning` on Linux and retain actual output |
| Installed worker/extractor boundary | `lib/learning.mjs: unqualified`, `lib/context.mjs: learningFor` | No installed adapter encloses all worker actions and privileged/control routes in a qualified outer learning profile |
| OpenSSH and lifecycle | `test/learning-openssh.test.mjs` | Disposable encryption/signature, PTY agent/askpass, activation/recovery/retirement, and bypass-oracle checks |
| Collector and data boundary | `test/learning.test.mjs` | Deterministic pagination, dates, edits/deletion, deduplication, rate limits, candidate rejection, JSON/path/terminal validation |
| Shared input seam | `test/learning-dispatch.test.mjs` | Advisory digests, foreign repository refusal, gate preservation, stale-memory fencing |
| Live approval/delivery/retirement | `test/learning-live.mjs` | NOT RUN; opt-in disposable ceremony is implemented, actual evidence and installed-provider integration remain outstanding |

Remedies: provide Linux/macOS operator test hosts; permit the fixed OS denial probe;
implement and qualify actual worker/extractor launch and privilege/control exclusion;
then perform the disposable interactive signing/delivery/retirement ceremony. Do not
create production keys, enroll this device, switch providers, spend model calls or
install the development checkout as the coordinator to manufacture evidence.

Outstanding implementation includes installed isolation and extraction adapters,
signed key rotation/recovery and complete
eligible-run/review-round/outcome correlation. These are kept as false criteria in
the PR completion receipt. Successful fixtures do not close those gaps.

## Offline Verify

Actual results on the macOS host above, 2026-10-07:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,229 passed; 0 failed, skipped or cancelled; 250,963.842958 ms | `/private/tmp/review-learning-full-test.log` |
| `npm run lint` | Exit 0; source syntax checks passed | Operator session command output |
| `npm run test:learning` | 34 passed; 0 failed, skipped or cancelled; 33,434.556 ms | `/private/tmp/review-learning-suite.log` |
| `git diff --check` and `git diff --cached --check` | Exit 0 after removing one fixture's trailing blank line | Operator session command output |

The learning suite used real disposable encrypted OpenSSH keys and the production
verifier/signing adapter. Python PTY entry is automated fixture evidence, not a
human approval attestation. A preloaded agent and hostile askpass environment still
required fresh terminal passphrase entry. The bypass oracle confirmed that
deliberately omitting authorization verification breaks the security assertions.

These offline results are macOS evidence only. Linux execution and the opt-in live
ceremony remain **NOT RUN / UNQUALIFIED**. Local temporary output pointers are
retained for this session; CI or another host must produce its own recorded results.

## Collection review follow-up

The three collection regressions were verified on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,232 passed; 0 failed, skipped or cancelled; 223,565.336916 ms | `/private/tmp/review-learning-feedback-full.log` |
| `npm run lint` | Exit 0 | Operator session command output |
| `npm run test:learning` | 37 passed; 0 failed, skipped or cancelled; 29,528.720459 ms | `/private/tmp/review-learning-feedback-suite.log` |
| `git diff --check` and `git diff --cached --check` | Exit 0 | Operator session command output |

Focused cases in `test/learning.test.mjs` cover fixed scan windows across page caps,
clock advancement, dry-run and restart (including legacy records); historical
dismissal metadata with concurrent candidate rejection; and source visibility
through CLI collection, review and extraction without changing repository identity.
The generated review view at `/private/tmp/review-learning-feedback-preview.json`
retains private classification and retraction timestamps with unchanged evidence
digests. Retracted sources are excluded from subsequent extraction.

No live isolation call was retried. Linux/live qualification and all previously
recorded implementation gaps remain outstanding; production remains UNQUALIFIED.

## Operator and scheduler follow-up

Actual offline results on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,235 passed; 0 failed, skipped or cancelled; 227,356.149084 ms | `/private/tmp/review-learning-batch3-full.log` |
| `npm run lint` | Exit 0 | Operator session command output |
| `npm run test:learning` | 40 passed; 0 failed, skipped or cancelled; 31,386.166708 ms | `/private/tmp/review-learning-batch3-suite.log` |
| `git diff --check` and `git diff --cached --check` | Exit 0 | Operator session command output |

Regressions exercise local disable and revocation during a GitHub outage; persisted
private/internal classification through the actual tick after restart; rotation
across 201 watched entries with failed writes and idle progress ticks; and a CLI
approval reason included in both the complete preview and the OpenSSH-signed manifest.
The disposable generated output at `/private/tmp/review-learning-batch3-preview.json`
shows separate identity/classification metadata and a successful offline disable.
Legacy identity-only records remain readable and require a configuration refresh
to acquire their previously unrecorded visibility. No model calls or live isolation
retries were made; production remains UNQUALIFIED with the same outstanding criteria.


## Accepted-run delivery follow-up

Actual offline results on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,240 passed; 0 failed, skipped or cancelled; 246,902.359667 ms | `/private/tmp/review-learning-batch4-full.log` |
| `npm run lint` | Exit 0 | Operator session command output |
| `npm run test:learning` | 43 passed; 0 failed, skipped or cancelled; 37,171.9675 ms | `/private/tmp/review-learning-batch4-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

The 63 focused dispatch/start/resume tests also passed in
`/private/tmp/review-learning-batch4-focused.log`. New regressions cover a locked
learning audit after accepted fix, initial start and resume; recovery of accepted
local/remote execution records before audit; restart without redispatch; and lost
audit replies while preserving later attempts. A pending outbox record is saved
atomically with ownership and cursor; retries never overwrite newer pinned advice.
The representative offline output `/private/tmp/review-learning-batch4-preview.json`
shows exact repository/input/run linkage before and after audit recovery.

The initial restricted focused run could not identify the process for an existing
learning-store lock test; the supported host escalation passed all 63 cases.
No live isolation retry or model call was made. Linux/live evidence and all recorded
implementation gaps remain outstanding; production stays **UNQUALIFIED**.


## Oversized-source pagination follow-up

Actual offline results on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,244 passed; 0 failed, skipped or cancelled; 286,118.128834 ms | `/private/tmp/review-learning-batch5-full.log` |
| `npm run lint` | Exit 0 | Operator session command output |
| `npm run test:learning` | 47 passed; 0 failed, skipped or cancelled; 56,026.983709 ms | `/private/tmp/review-learning-batch5-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

`test/learning.test.mjs` now exercises 1,200 eligible entries for each source kind
across restart, rate limits and dry-run; 6,500 ineligible inline comments across the
page cap before reaching an older PR; review eligibility and summary digests across
source checkpoints; deferred deletion; and read-only expiry of checkpoint excerpts.
A 100-comment response containing 65,536-character bodies verifies transport/parser
agreement above one MiB, with explicit rejection beyond the 64 MiB parser ceiling.
The earlier focused collector run passed all 24 tests in
`/private/tmp/review-learning-batch5-focused.log`.

Representative offline dry-run output in
`/private/tmp/review-learning-batch5-preview.json` retains inline page 59 after exactly
60 requests with no eligible observations or inference. Only minimized review
context and source IDs persist across pages; completing inline enumeration drops
that context. Existing observation/storage caps and changing upstream page order
remain disclosed coverage limits, rather than claims of a point-in-time snapshot.

No live isolation probe or paid model call was attempted. The oversized single-PR
continuation gap is resolved; the installed isolation, Linux/live qualification and
other previously recorded implementation gaps remain outstanding. Production stays
**UNQUALIFIED / collection only**.


## Scoped guidance and fresh-session continuity follow-up

Actual offline results on the same macOS host, against the final source:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,251 passed; 0 failed, skipped or cancelled; 302,220.708083 ms | `/private/tmp/review-learning-batch6-verified-full.log` |
| `npm run lint` | Exit 0 | Operator session command output |
| `npm run test:learning` | 48 passed; 0 failed, skipped or cancelled; 37,977.324458 ms | `/private/tmp/review-learning-batch6-final-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

Regressions in `test/learning-dispatch.test.mjs` and `test/commands.test.mjs`
exercise task/carried-file and inline-event paths through actual dispatch callers,
with traversal/absolute paths excluded. Existing signed held-out relevance fixtures
in `test/learning-openssh.test.mjs` exercise selection and omission by literal scope.
The generated CLI help `/private/tmp/review-learning-batch6-help.txt` and path view
`/private/tmp/review-learning-batch6-preview.json` were inspected before publication.

`test/resume.test.mjs` exercises explicit fresh-session continuity, unchanged task,
PR, checkout, cursors and iteration, and retry of the prepared native session.
`test/execution-backends.test.mjs` exercises the real execution boundary with offline
transports: cumulative allowance retention, unrelated-stop and unconfirmed-cancel
refusal, retired-session rejection on submission and lookup, and local lost-reply
recovery with preassigned or provider-assigned IDs. The six focused recovery cases
passed in `/private/tmp/review-learning-batch6-final-recovery.log`.

Source review extended session-identity checks to acceptance recovery and native
providers assigning IDs after launch; the full suite was rerun after those fixes.
The explicit operator transition is implemented; automatic session replacement is
not implied. No paid model call or unchanged blocked sandbox probe was run. Installed
isolation, Linux/live evidence, extraction, rotation/recovery and outcome-correlation
gaps remain outstanding, and production remains **UNQUALIFIED / collection only**.

## Revocation and concurrent-observation review follow-up

The shared service retries disabled-mode controls even when the mode was already
committed before a control failure. Signed-transition recovery uses verified
history to retry retirement/replacement controls outside the learning-store lock.
`test/learning.test.mjs` covers both disabled modes across failure and restart;
`test/learning-openssh.test.mjs` covers committed retirement, repeated recovery,
unchanged signed state and no extra signing.

Source revisions are reconciled by source timestamp, observation timestamp and a
deterministic digest tie-break in both automatic reads and historical merges.
The concurrent-merge tests exercise both arrival orders and preserve candidate
rejections. Disabled fresh-session inputs pin empty advice locally, avoiding both
a GitHub lookup and an enable race; the actual resume test retains task/PR/cursor
ownership during the simulated GitHub outage.

Source and generated-output review included the shared observation writers,
post-commit control/recovery paths, and shared input/accepted-delivery boundaries.
`/private/tmp/review-learning-batch7-preview.json` records two concurrent revisions
with only the newer one current, a successful control retry from `off`, and empty
managed advice with unchanged task text. This is disposable fixture evidence.
The preview needed process inspection for the existing process-identity lock;
it succeeded using supported sandbox escalation after the restricted attempt
refused to acquire that lock. No installed isolation claim follows from it.

The focused tests passed 69 cases in
`/private/tmp/review-learning-batch7-focused.log` (27,078.498416 ms).
Linux/live qualification and the documented implementation gaps remain outstanding;
production remains **UNQUALIFIED / collection only**. No unchanged OS-isolation
probe or paid model call was attempted.

Required Verify results on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,256 passed; 0 failed, skipped or cancelled; 428,764.9535 ms | `/private/tmp/review-learning-batch7-full.log` |
| `npm run lint` | Exit 0 | `/private/tmp/review-learning-batch7-lint.log` |
| `npm run test:learning` | 53 passed; 0 failed, skipped or cancelled; 50,640.928125 ms | `/private/tmp/review-learning-batch7-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

## Prepared-delivery revocation review follow-up

Context selection now rechecks the current mode inside the learning transaction.
Prepared deliveries record task identity. The shared launch admission service
checks qualification, protected mode, exact context identity and signed active
revisions, holding the learning lock through provider acceptance. Disable or
retirement racing that launch fails busy before committing; operators retry it.
Once committed, revocation markers fence old inputs across restart and re-enable.
Prepared ownership also lets controls reach accepted local/hosted executions before
registry publication; delivery audits retain unconfirmed cancellation for retry.

Source review covered initial start, resumed/review dispatch, signed commit and
recovery, legacy delivery reconciliation, admission failures and lock cleanup.
No provider launch occurs for a revoked or unqualified intent; pre-launch failures
retain the existing dispatch-not-sent semantics. Learning persistence remains
outside the accepted-run ownership save. Controls run outside the learning lock.

Focused regressions are in `test/learning-openssh.test.mjs` (mode changes during
qualification, durable prepared-intent fencing, real execution-boundary controls
before registry registration), `test/learning-dispatch.test.mjs` (cancellation
retry and unrelated-operation exclusion), and `test/commands.test.mjs` /
`test/resume.test.mjs` (caller admission and unchanged review ownership).

The existing native sandbox refusal, absent Linux host and unqualified installed
worker/extractor boundary remain unchanged. Production is **UNQUALIFIED /
collection only**; these are disposable offline regressions, not live approval
or installed-boundary evidence. No paid inference or unchanged probe was run.

Representative generated output was inspected in
`/private/tmp/review-learning-batch8-final-suite.log`: the
`preparedDeliveryRevocation` diagnostics record exact task/context/run identities
for both local and hosted offline transports, zero registry entries, one
cancellation call and the durable `learned advice retired` fence. The final
learning suite passed 58 tests with no failures, skips or cancellations
(38,833.643375 ms). This output explicitly labels production UNQUALIFIED.

Final Verify results on the same macOS host, after launch-admission qualification
was rechecked during source review:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,263 passed; 0 failed, skipped or cancelled; 412,842.460292 ms | `/private/tmp/review-learning-batch8-final-full.log` |
| `npm run lint` | Exit 0 | `/private/tmp/review-learning-batch8-final-lint.log` |
| `npm run test:learning` | 58 passed; 0 failed, skipped or cancelled; 38,833.643375 ms | `/private/tmp/review-learning-batch8-final-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

## Immutable identity and obsolete-preparation review follow-up

Automatic observation now resolves the current immutable repository identity in
the post-dispatch collection step before persistence. Replacement names and
lookup failures skip collection without changing coding cursors, rounds or fix
dispatch. One lookup per repository shares a five-second batch deadline; abort
signals reach the existing GitHub transport and late responses cannot update the
service cache. No automatic lookup enrolls a replacement identity.

Recovery validates each signed preparation and its content digest before either
committing it against the exact current parent or archiving an obsolete sequence.
The protected archive retains signed bytes, retirement time and superseding
transition digest, with a 1,000-record cap. Archive movement and later activation
share one atomic transaction. Invalid obsolete signatures still block recovery;
old signatures never rebase. Legacy stores acquire an empty in-memory archive
without read-time writes, and reports expose pending/obsolete counts.

Source review covered automatic versus historical identity resolution, signal
propagation, late-response cleanup, signed commit/recovery and storage migration.
The inspected generated output in `/private/tmp/review-learning-batch9-suite.log`
includes `automaticIdentity` diagnostics: one fix for each match/replacement/outage
case, zero stored observations for replacement and outage, and identical coding
cursor advancement. `obsoletePreparationRecovery` records an archived sequence 1
followed by a committed sequence 2, retaining exactly one obsolete signed record.
Tests also cover interrupted recovery persistence, restart, repeated recovery,
forged obsolete signatures and cancellation of a stalled identity lookup.

The learning suite passed 63 tests with zero failures, skips or cancellations
(41,104.567833 ms). Existing installed-isolation, Linux/live and implementation gaps
remain unmet. Production remains **UNQUALIFIED / collection only**. The recorded
`sandbox_apply: Operation not permitted` failure was not retried. Qualification
still requires supported Linux/macOS hosts, a permitted actual isolation probe,
a qualified worker/extractor/control boundary and a disposable live ceremony.

Required Verify results on the same macOS host:

| Command | Recorded result | Output pointer |
| --- | --- | --- |
| `npm test` | 1,268 passed; 0 failed, skipped or cancelled; 249,782.894042 ms | `/private/tmp/review-learning-batch9-full.log` |
| `npm run lint` | Exit 0 | `/private/tmp/review-learning-batch9-lint.log` |
| `npm run test:learning` | 63 passed; 0 failed, skipped or cancelled; 41,104.567833 ms | `/private/tmp/review-learning-batch9-suite.log` |
| `git diff --check` | Exit 0 | Operator session command output |

## Completion-gate output follow-up

The new learning command, immutable approval preview, disposable signing fixture
and opt-in qualification script now write their already formatted text directly
to stdout with the same trailing newline. Review covered all added output calls,
including error reporting and the live script's cleanup path. A scan of added
lines relative to main found no occurrences of the gate's prohibited logging call.
The non-opted-in live script was checked for exact output and exit status 1; it
created no keys and performed no isolation or provider calls.

The criteria are valid; false qualification attestations cannot be repaired by
changing their truth values. Extraction and installed execution isolation still
require implementation and qualification (ac-3, ac-5, ac-8, ac-11). Full outcome
correlation and signed key rotation/loss recovery remain implementation gaps
(ac-14, ac-16). Actual Linux and permitted macOS isolation plus disposable live
qualification remain unavailable (ac-15). The prior macOS denial was not retried.
The brief explicitly allows an unqualified implementation PR while blocking
production apply; a completion gate requiring every criterion must continue to
deny completion until that work and evidence exist.

This follow-up's learning suite passed all 63 tests (89,667.060167 ms), and lint
passed. Logs: `/private/tmp/learning-gate-suite.log` and
`/private/tmp/learning-gate-lint.log`. The first full run passed 1,267 of 1,268
with one offline transport deadline failure in `operator answer lost-before
recovers the same call and key across restart` (no learning code in its stack).
That test passed alone with unchanged deadlines; the full suite was rerun without
a competing learning suite. Initial and focused evidence:
`/private/tmp/learning-gate-full.log` and
`/private/tmp/learning-gate-timeout-recheck.log`.

The full rerun passed all 1,268 tests, with zero failures, skips or cancellations
(270,222.32725 ms): `/private/tmp/learning-gate-full-recheck.log`.
`git diff --check` passed after the final documentation update.

## Offline recovery, stable scan identities and batch-selection follow-up

Recovery CLI now uses the remembered immutable repository identity, while signature,
namespace, authority and sequence verification remain in the shared service. The
existing interrupted-retirement regression now retries through the CLI with a
GitHub transport that fails if invoked, and confirms repeated control recovery
without new signatures or state changes.

Historical retries restart update-sorted PR listing pages and deduplicate against
persisted completed PR identities. An unfinished source retains its own PR number,
kind and page independently of the new listing order. The regression moves an
unscanned PR from a later page ahead of the saved index, restarts the service,
checks dry-run state immutability, and verifies all 21 PRs were observed. The identity
set is bounded at 10,000; listing overlap consumes the 60-page invocation budget,
so deep or continuously changing history can remain explicitly incomplete.
Legacy scans without the identity set safely re-enumerate and deduplicate evidence.

Batch selection validates unique candidate IDs as well as exact revision keys
before terminal access, preview or signing. Regression checks both duplicate exact
revisions and different revisions of one ID for approval and retirement, preserving
the entire state byte-for-byte. Review covered shared apply validation, local
recovery callers, source checkpoint/deletion paths, dry-run and budget exits.
No production key, enrollment, paid inference or unchanged denied probe was run;
the existing seven unmet criteria and qualification remedies remain unchanged.

Verify on the same macOS host: `npm test` passed 1,270 tests with no failures,
skips or cancellations (227,674.123834 ms), recorded in
`/private/tmp/learning-review11-full.log`. `npm run test:learning` passed 65 tests
with no failures, skips or cancellations (39,062.381542 ms), recorded in
`/private/tmp/learning-review11-suite-final.log`. `npm run lint` exited 0
(`/private/tmp/learning-review11-lint.log`), and `git diff --check` passed.

## Repository reconfiguration and offline retention follow-up

Configuration compares resolved and remembered immutable identities before changing
mode. The persistence boundary also checks existing legacy and structured identity
records under its lock before writing, covering explicit remembering and resolving
with enrollment enabled. Replacement names cannot overwrite offline disable
ownership. Regression coverage leaves the original apply state unchanged on refused
reconfiguration, then disables that original identity locally and verifies controls.
Rejected persistence releases its lock; same-identity visibility updates still work.

Pruning now resolves only the remembered local identity. The CLI regression advances
the retention clock, removes the expired excerpt with GitHub unavailable, and checks
idempotent repeated cleanup. The initial test run found an incorrect nested-field
assertion in the new test; the assertion was corrected to the existing string field.
Source review covered identity writer callers, case normalization, legacy records,
lock cleanup, local command construction and pruning's existing atomic transaction.
Production remains UNQUALIFIED; the recorded native isolation refusal was not
retried. Linux/live evidence and the seven existing unmet criteria remain unchanged.

Verify: `npm test` passed 1,272 tests, no failures/skips/cancellations
(228,546.192292 ms; `/private/tmp/learning-review12-full.log`).
`npm run test:learning` passed 67 tests, no failures/skips/cancellations
(36,564.551667 ms; `/private/tmp/learning-review12-suite-final.log`).
`npm run lint` exited 0 (`/private/tmp/learning-review12-lint-final.log`), and
`git diff --check` passed. Regression outputs confirm retention counts 1 then 0,
unchanged original state on identity refusal, and controls targeting the original ID.

## Buffered retention and deep listing progress follow-up

Buffered review context now stores its observation timestamp and expires after
30 days from that timestamp, independently of explicit future scan endpoints.
Unknown legacy ages are redacted conservatively. Report remains read-only; prune
persists redaction, and scan-save expiration runs after merging its checkpoint.
The future-endpoint regression checks unexpired storage, aged read-only redaction,
persistent pruning and legacy buffers without timestamps. Its initial fixture used
a default date window excluding the review; an explicit in-range start corrected it.

Listing traversal now checkpoints its page across bounded invocations. A pass
finding new PR identities triggers a deduplicated pass from page one; completion
requires a pass finding none. This retains progress through prefixes longer than
60 pages while preserving coverage of PRs moving ahead of a prior cursor. A seeded
6,000-completed-identity regression reaches PR 6,001, including a page-61 rate limit,
service restart, dry-run immutability and a completed verification pass. Existing
cross-page movement and source-pagination regressions exercise the sibling paths.
The 60-page/time/identity caps remain enforced; continuously changing upstream
listings are not snapshot-consistent and that coverage limit remains disclosed.

Source and representative report checks covered listingPage, completedPrs, retryAt,
completion, observation timestamps, read-only reporting and atomic pruning. No
production enrollment, paid model call or unchanged denied isolation probe ran.
The seven existing unmet criteria and Linux/live qualification remedies remain.

Verify on the same macOS host: `npm test` passed 1,274 tests with no failures,
skips or cancellations (243,595.023667 ms; `/private/tmp/learning-review13-full.log`).
`npm run test:learning` passed 69 tests with no failures, skips or cancellations
(37,861.43075 ms; `/private/tmp/learning-review13-suite-final.log`).
`npm run lint` exited 0 (`/private/tmp/learning-review13-lint.log`), and
`git diff --check` passed after the final audit update.

## Offline unavailable-extraction CLI follow-up

The extraction CLI constructs the learning service without resolving a GitHub user
and uses the remembered immutable repository identity. Collection still resolves
its authenticated reviewer identity; extraction consumes previously collected local
evidence and retains the existing isolation and separate-allowance checks.

The regression uses the lazy service-construction route with both GitHub user and
repository lookups unavailable. It verifies the actual service returns unavailable
with inference false, preserves observations and identity state, never invokes the
extractor, and refuses an unknown local repository without remote calls. It also
checks collection still authenticates. Source review covered context construction,
the CLI identity boundary and the shared service's refusal before its transaction.
No paid calls, production keys, enrollment or unchanged denied probe were invoked.
Existing installed isolation, Linux/live evidence and seven unmet criteria remain;
the recorded qualification remedies still apply.

Verify on the same macOS host: `npm test` passed 1,275 tests with no failures,
skips or cancellations (228,050.519083 ms; `/private/tmp/learning-review14-full.log`).
`npm run test:learning` passed 70 tests with no failures, skips or cancellations
(37,210.437875 ms; `/private/tmp/learning-review14-suite.log`). `npm run lint`
exited 0 (`/private/tmp/learning-review14-lint.log`), and `git diff --check` passed.
