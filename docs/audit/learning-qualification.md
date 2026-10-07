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
