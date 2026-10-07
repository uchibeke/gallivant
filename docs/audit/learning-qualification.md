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

## Extraction rotation and enrollment retry follow-up

Extraction reservations now persist exact observation revision digests before
invoking the extractor. Subsequent bounded batches exclude completed and unresolved
reservations, allowing later observations to progress without repurchasing unknown
acceptance. An exact legacy batch can acquire revision keys without inference.
The regression collects 1,001 observations, loses the first batch's reply, restarts,
processes the final observation, and verifies two disjoint reservations and no
additional inference on repeats or exact legacy migration. No candidate is approved.

Setup saves protected pending enrollment metadata after creating the encrypted key
and before signing. Retries under the same operation lock require matching key,
path and pinned signer, a new immutable preview, and fresh signing. Failed signing
or retry cancellation retains the intent; substituted keys are refused. The
OpenSSH regression copies only disposable encrypted test keys, simulates signing
failure, cancels a retry, rejects substitution, then verifies enrollment of the
same key and authority ID without another key creation. The metadata contains no
private key bytes and remains audit history after successful enrollment.

Source review covered reservation persistence/failure/restart, setup cancellation,
concurrent authority checks, key validation, lock cleanup and protected intent IO.
A failure during key creation or before the enrollment intent can be persisted is
not claimed recoverable by this signing-retry mechanism. No production keys,
enrollment, paid inference or unchanged denied probe were requested. Existing
installed isolation, Linux/live evidence and seven unmet criteria remain unchanged.

Verify on the same macOS host: `npm test` passed 1,277 tests with no failures,
skips or cancellations (242,869.780625 ms; `/private/tmp/learning-review15-full.log`).
`npm run test:learning` passed 72 tests with no failures, skips or cancellations
(37,730.506542 ms; `/private/tmp/learning-review15-suite-final.log`).
`npm run lint` exited 0 (`/private/tmp/learning-review15-lint.log`), and
`git diff --check` passed after the final audit update.

## Interactive setup lock and unqualified revocation recovery follow-up

Setup snapshots pending enrollment and performs confirmation, key creation and
signing outside the global store lock. Intent and authority writes each reacquire
the lock, compare the expected pending bytes, refuse concurrent enrollment, and
revalidate the exact encrypted key and pinned signer. Regression callbacks perform
local configuration/pruning during confirmation and acquire the lock during key
creation/signing; a changed intent during signing refuses authority publication.
A subsequent reviewed retry signs the new pending identity explicitly.

Recovery verifies committed signed history and fences/reconciles its removals
before requiring current application qualification. A signed prepared transition
still cannot activate while qualification is unavailable. The regression commits
retirement with failed controls, drops qualification, retries cancellation, then
interrupts a later signed activation and confirms another controls retry leaves
that pending activation and all repository state unchanged.

Review covered both compare-and-swap writes, prompt cancellation, signer/key
revalidation, lock release on failure, signed-history checks and prepared recovery.
Existing disposable-key retry and stale/forged transition regressions remain in
scope. No production enrollment, paid calls or unchanged denied isolation probe ran;
existing Linux/live gaps and the seven unmet criteria remain unchanged.

Verify on the same macOS host: `npm test` passed 1,279 tests with no failures,
skips or cancellations (225,813.114917 ms; `/private/tmp/learning-review16-full.log`).
`npm run test:learning` passed 74 tests with no failures, skips or cancellations
(41,815.8165 ms; `/private/tmp/learning-review16-suite-final.log`). `npm run lint`
exited 0 (`/private/tmp/learning-review16-lint.log`), and `git diff --check` passed.

## Review batch 17: provenance, approval concurrency and delivery bounds

Extraction validates every candidate evidence digest against its exact reserved
input batch before inserting any proposals. The regression returns a superseded
repository observation with the correct current input digest and confirms an
unresolved extraction with no candidate or approval writes.

Approval freezes the full preview under lock, releases it before confirmation and
secret entry, then reloads state and compares mode, parent, sequence, trust root
and complete review text before each persistence phase. Concurrent rejection and
emergency disable refuse stale approval; unsigned preparations cannot activate
through recovery. Existing signed-preparation crash recovery remains covered.

New delivery intents are capped at 1,000 records and 16 KiB per record. Existing
retry identities, pending revocation targets, audit details and denominators are
retained rather than evicted. Tests fill capacity, refuse overflow and oversized
metadata, acknowledge an existing intent, prune and disable successfully. This is
a hard capacity policy, not automatic archival; operators can disable application
and preserve the protected audit backup while continuing without advice.

Source review included extraction insertion, preview/signature persistence and
failure cleanup, context retry/admission, delivery acknowledgement, revocation,
inspection and pruning. No new paid calls, production enrollment or repeated
blocked isolation probes ran. The seven unmet criteria and Linux/live gaps remain.

Verify on macOS: `npm test` passed 1,282 tests with no failures, skips or
cancellations (342,218.952375 ms; `/private/tmp/learning-review17-full.log`).
`npm run test:learning` passed 77 tests (51,408.105584 ms;
`/private/tmp/learning-review17-suite.log`), `npm run lint` exited 0
(`/private/tmp/learning-review17-lint.log`), and `git diff --check` passed.

## Review batch 18: extraction execution outside the store lock

Extraction uses separate reservation and result-merge transactions around the
existing bounded external-call helper. It persists exact batch membership before
execution, then reloads current state and verifies the original reservation before
merging. Disable and unrelated-repository mutations remain available during the
external wait. Concurrent source edits refuse stale proposals; unrelated new
observations survive the merge. Returned costs remain recorded even when proposals
are refused. A failed merge retains the reservation across restart and cannot
repurchase the same batch.

Regression callbacks run local pruning, nested extraction inspection, observation
and same/foreign repository mode changes during execution. A separate lock-conflict
regression verifies durable reservation retention after the external reply. Review
covered reservation persistence, all validation before insertion, fresh-state
merge, failure lock cleanup, timeout handling through the existing helper, and
collection/inspection callers. No production key, paid inference or repeated
blocked isolation probe ran; the seven unmet criteria and live/Linux gaps remain.

Verify on macOS: `npm run test:learning` passed 79 tests (154,013.988959 ms;
`/private/tmp/learning-review18-suite.log`), and `npm run lint` exited 0
(`/private/tmp/learning-review18-lint.log`). The first `npm test` run passed 1,283
of 1,284 tests; the unchanged provider test `unresolved root identity has a
three-attempt recovery circuit without resending` reported zero initial sends
(`/private/tmp/learning-review18-full.log`). Its isolated recheck passed
(`/private/tmp/learning-review18-recovery-recheck.log`), and the full `npm test`
recheck passed all 1,284 tests with no failures, skips or cancellations
(284,854.866042 ms; `/private/tmp/learning-review18-full-recheck.log`). No unrelated
code or test changes were made. `git diff --check` passed.

## Review batch 19: full path budgets with bounded delivery audit

Selection still considers every accepted task path. Delivery persistence now stores
a JSON-encoded path sample bounded to 2 KiB, with a digest, count and omitted count
for the full list. Managed dispatch inputs retain all selected task paths. This
keeps the existing 16 KiB record and 1,000-record caps without refusing supported
200-path inputs solely because their paths are long.

The regression passes 200 distinct 512-byte UTF-8 paths through the shared path
selector and matches a signed rule on the last path, beyond the audit sample. It
also exercises a nonmatching path set, launch admission, exact retry equality,
delivery acknowledgement and inspection of the full-list digest. The oversized
record regression still rejects oversized non-path metadata. Review covered
local/hosted shared input construction, persistent audit, retry input and report
boundaries. No paid work or unchanged blocked isolation probe ran; production
qualification and the seven unmet criteria remain unchanged.

Verify on macOS: `npm test` passed all 1,285 tests with no failures, skips or
cancellations (304,132.304417 ms; `/private/tmp/learning-review19-full.log`).
`npm run test:learning` passed 80 tests (84,626.753375 ms;
`/private/tmp/learning-review19-suite.log`), `npm run lint` exited 0
(`/private/tmp/learning-review19-lint.log`), and `git diff --check` passed.

## Review batch 20: reuse the enrolled OpenSSH executable

Default learning services lazily load the signer path from protected enrolled or
pending enrollment metadata. Each signer operation checks the recorded path and
bytes before invoking the executable; enrolled signer metadata must also agree
with its enrollment manifest. Setup selection flows through both the CLI fallback
and context factory, whose cache distinguishes explicit executable selections.
Collection and emergency disable do not resolve the cryptographic dependency.

The disposable-key regression enrolls a separately pinned executable launcher for system OpenSSH through
the command service factory, signs an approval, restarts without specifying the
executable, and verifies doctor, recovery and apply context. Replacing that file
with a marker-writing script is rejected before execution; disabling still works.
Review covered setup retries, cached CLI/daemon services, capability probes,
signature verification and local outage controls. This is offline cryptographic
evidence; no production enrollment, paid inference or unchanged denied isolation
probe ran. The seven unmet criteria and installed/live qualification gaps remain.

The initial new fixture attempted to relocate the macOS system executable; its
capability probe failed and a disposable diagnostic observed `SIGKILL` with no
stderr. The final fixture uses a separately pinned launcher invoking the original
system OpenSSH, with no OS protection changes. The final learning suite passed
81 tests (55,566.288 ms; `/private/tmp/learning-review20-suite-final.log`). The
initial fixture failure is retained in `/private/tmp/learning-review20-suite.log`.

Final Verify on macOS: `npm test` passed all 1,286 tests without failures, skips
or cancellations (263,993.927583 ms; `/private/tmp/learning-review20-full.log`).
`npm run test:learning` passed 81 tests, `npm run lint` exited 0
(`/private/tmp/learning-review20-lint.log`), and `git diff --check` passed.

## Review batch 21: bound omitted-rule audit detail

Delivery omissions now retain a sample limited to 1 KiB and the remaining encoded
record space, plus a full ordered-list digest, count, unsampled count and counts
by reason. The summary is reserved before fitting detail. A shared encoded-size
sampler also preserves the existing path audit behavior. Selection still traverses
all verified active revisions and respects the same lesson and context limits.

The regression constructs 200 active revisions in ten real disposable OpenSSH
signed transitions and validates the full history through normal context and
launch admission. It covers context-budget, unmatched-scope and unknown-path
omissions, exact summary reconstruction, bounded serialized size, retries,
acknowledgement and inspection. Review covered shared local/hosted inputs,
persistent delivery and report boundaries; no omission data affects revocation
of the exact selected rules. No paid inference, production enrollment or repeated
blocked isolation probe ran. The seven unmet criteria remain unchanged.

Verify on macOS: `npm test` passed all 1,287 tests with no failures, skips or
cancellations (255,306.295916 ms; `/private/tmp/learning-review21-full.log`).
`npm run test:learning` passed 82 tests (71,189.060125 ms;
`/private/tmp/learning-review21-suite.log`), `npm run lint` exited 0
(`/private/tmp/learning-review21-lint.log`), and `git diff --check` passed.

## Merged preparation boundary assessment

Reviewed merge `59abf71` and preparation base `bbb9704` on 2026-10-07. The
restricted preparation adapter is useful shared infrastructure, but this merge
alone does not qualify extraction or application. No production qualification
flag or acceptance attestation changes as a result of the merge.

| Requirement | Merged implementation and remaining work |
| --- | --- |
| Data-only inference | `lib/preparation_codex.mjs` disables model tools, MCP, plugins, hooks, delegation, inherited instructions, memory and telemetry; it checks effective configuration and managed requirements before drafting. Reuse this adapter through `lib/execution_preparation.mjs` when implementing extraction, rather than duplicating its launch/configuration logic. |
| Learning extraction integration | `lib/context.mjs: learningFor` still constructs the service without an extractor or qualified profile. `lib/learning.mjs: extract` requires an explicit data-only extractor and qualification, reserves a bounded evidence batch and allowance, and validates results. A drafting capability receipt is not an extraction qualification receipt. The missing bridge must preserve the exact reserved batch/input digest, JSON candidate validation, separate allowance, cancellation/deadline and unresolved-reservation behavior. |
| Credential and authority exclusion | `lib/task_environment.mjs: preparationEnvironment` snapshots selected provider authentication for native inference. The approved extraction profile must distinguish necessary inference authentication from coding/approval credentials and demonstrate that the latter are inaccessible. Native preparation configuration is not an outer OS boundary for arbitrary coding-worker code, the signer, active store, checkpoint or control routes. Ordinary implementation runs do not inherit the preparation restrictions. |
| Evidence scope | `docs/audit/preparation-context-boundary.md` records native loopback-provider fixture evidence for drafting. It is useful tool/context isolation evidence, but does not establish live access to the configured provider, installed learning extraction, or signed approval/delivery/retirement. No fixture result is promoted to live qualification. |
| External prerequisites | The recorded macOS sandbox denial remains unresolved; no Linux host or live ceremony evidence is available. Browser/capture and plugin installation are not prerequisites for this data-only path; preparation explicitly disables those surfaces. No paid call, provider/model change, nested inference job or unchanged denied probe was attempted during this assessment. |

The next extraction integration must use the existing execution service and its
restricted preparation adapter, then qualify the exact selected executable and
profile with disposable hostile-evidence probes. Production application separately
needs enforced denial of worker access to key/trust/verifier/checkpoint/terminal
and privileged controls. Provide a macOS operator environment permitting the fixed
sandbox probe and a Linux host with `/usr/bin/bwrap` plus working namespaces; record
the actual opt-in ceremony and platform results. Successful sign-in or version
checks cannot establish any of these claims.

Criteria ac-3, ac-5, ac-8, ac-11 and ac-15 therefore remain unmet. Independent
implementation gaps in ac-14 (complete outcome correlation) and ac-16 (signed
rotation/loss recovery and qualified operation) also remain; they are not external
credential failures and are not repaired by the preparation merge. Collection,
local inspection, emergency disable and signed revocation retries remain available
under their existing rules. Earlier inline findings through review 5446905186 are
already addressed and retain their existing regression and thread history.

Fresh Verify after the merge on the same macOS host: `npm test` passed all 1,337
tests, with no failures, skips or cancellations (222,330.612709 ms;
`/private/tmp/learning-merge-full.log`). `npm run test:learning` passed all 82 tests
(55,894.405166 ms; `/private/tmp/learning-merge-suite.log`). `npm run lint` exited 0
(`/private/tmp/learning-merge-lint.log`), and `git diff --check` passed. These are
offline implementation results; no new native-model or installed-boundary
qualification is inferred. This follow-up changes documentation only.

## Review batch 23: protect signer directory entries

Signer pinning now checks root/operator ownership for the executable and every
ancestor, and refuses group/other-writable directories as well as writable files.
A root-owned sticky temporary ancestor is allowed only above a private trusted
directory; a writable immediate executable parent is always refused. This keeps
disposable private test installations portable without treating an arbitrary
writable directory as protected. Same-UID worker isolation remains a separate
unmet production prerequisite.

The regression `signer refuses replaceable parent and ancestor directories before
execution` changes both immediate and higher directories to 0775, 0777 and 01777
after an initial successful pin. Pinning, capability probing and authorization
verification all refuse before a marker-writing executable runs. Restoring safe
permissions restores the same pin. The existing custom-enrollment/restart test
continues to exercise actual disposable OpenSSH signatures. Source review checked
setup/key creation, probe, signing, verification, stored signer selection and
recovery callers; all use the shared pin validation.

The restricted focused run passed the new case but could not identify its process
for the existing enrollment lock test (`/private/tmp/learning-review23-focused.log`).
The supported escalated learning suite passed all 83 tests (53,537.011542 ms;
`/private/tmp/learning-review23-suite.log`). No denied isolation probe was repeated,
and no model/provider call or production enrollment was made. Seven previously
unmet criteria remain unmet.

Final Verify: `npm test` passed all 1,338 tests with no failures, skips or
cancellations (216,889.489125 ms; `/private/tmp/learning-review23-full.log`).
`npm run test:learning` passed 83 tests; `npm run lint` exited 0
(`/private/tmp/learning-review23-lint.log`); `git diff --check` passed.

## Review batch 24: stale enable fencing and fixed temporary ancestor

Configuration now persists a fresh mode generation on every write, including a
repeated disable. Apply captures the generation before asynchronous qualification,
then compares it and verifies signed state under the transaction lock. A request
that predates a later disable cannot silently restore application, even if the
mode subsequently returns to its original value. Legacy files read with a null
generation and acquire the field on their next write. Revocation controls still
run after the disabled mode commits and remain retryable.

`test/learning-openssh.test.mjs: pending apply cannot overwrite a later disable
across mode cycles and legacy state` covers all initial modes, both disabling
modes, separate service instances, completed controls, repeated modes, mode cycles,
unchanged state after refusal and a new explicit apply request. Source review
confirmed configuration is the shared mode writer; scan/extraction merges reload
current state, and context still checks application mode under its own lock.

The signer sticky exception now requires the fixed system temporary root (`/tmp`
resolved through its system alias), root ownership and a private trusted child.
Environment-selected temporary paths cannot broaden it. The existing replaceable
ancestor regression includes arbitrary 01777 parents and higher ancestors, which
must be refused regardless of whether the operator is root. Review feedback
reported its failure under UID 0 before this fix; this session's macOS tests do not
claim to reproduce a Linux/root run. Same-UID worker isolation remains required.

The learning suite passed 84 tests with no failures, skips or cancellations
(54,365.682459 ms; `/private/tmp/learning-review24-suite.log`). No paid/native-model
call or unchanged denied sandbox probe ran. The seven unmet criteria and external
qualification remedies recorded above remain unchanged.

Final Verify on macOS: `npm test` passed all 1,339 tests with no failures, skips
or cancellations (214,523.426 ms; `/private/tmp/learning-review24-full.log`).
`npm run test:learning` passed 84 tests; `npm run lint` exited 0
(`/private/tmp/learning-review24-lint.log`); `git diff --check` passed.
