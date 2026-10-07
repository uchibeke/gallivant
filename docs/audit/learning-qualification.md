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
automatic fresh-provider continuity, signed key rotation/recovery and complete
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
