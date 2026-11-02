# Bitbucket Cloud review-loop qualification record

Status: **unqualified; dispatch disabled**. This document records unavailable
live prerequisites honestly. Offline tests are implementation evidence, not a
substitute for repository writes, model access or a genuine review.

## Observed prerequisites, 2026-11-01

- Host: Darwin arm64; Node `v22.22.0`; Git `2.50.1 (Apple Git-155)`.
- Requested executable: `/Users/uchi/.local/share/gallivant/codex/node_modules/.bin/codex`.
  `--version` returned `codex-cli 0.160.0`. `exec --help` returned native command
  help. These calls did not establish model access or consume inference.
- Credential resolver: `resolveBitbucketCredential` against the operator config
  returned `NO_CREDENTIAL: No Bitbucket account API credential selected`.
- The operator config contained no `git_hosts["bitbucket.org"]`, no Bitbucket
  repository, no reviewer actor, and no reviewer credential selection. A token
  file's existence did not identify its account, scopes or authorized repository;
  its contents were not printed or treated as authorization.
- No disposable workspace/repository or reviewer identity was supplied. No
  Bitbucket repository write, model invocation, merge, pipeline installation or
  protection change was attempted. Browser capture is not a requirement of this
  brief; no capture is offered as evidence of host or model access.

Exact remedy: authorize disposable private/public Bitbucket Cloud repositories
(or a named workspace for their creation); select the account email and private
API-token path with repository and PR read/write scopes plus Git push access;
select a non-default base and separate reviewer identity/credential outside the
coding environment; authorize a bounded genuine Codex reviewer invocation with
available model access and the chosen CI producer. Enable ordinary Pipelines
only if that is the selected producer. The operator, not this implementation,
merges the qualified predecessor to test chain continuation.

## Live matrix — all pending

| Required observation | Observed repository / PR / run | Result |
| --- | --- | --- |
| Private and public access, HTTPS and SSH | None authorized/configured | Unmet |
| Non-default base and PR creation | None | Unmet |
| Genuine Codex review posting current-head feedback | No inference invocation | Unmet |
| Stable observed reviewer actor; blocking then clear | No reviewer selected | Unmet |
| Trusted `/fix`; failed then passing CI/check names | No live PR/check producer | Unmet |
| Same-session correction and receipt/readiness | No live run | Unmet |
| Daemon restart recovery | No live run | Unmet |
| Operator merge and merge-gated chain continuation | No authorized predecessor | Unmet |
| Clean macOS and Linux installation qualification | Local development checkout only | Unmet |

Do not populate repository/PR links, actor UUIDs, check names, scope confirmations
or run IDs from fixtures. When available, append actual links, versions, declared
and observed scope (without secrets), head SHAs, reviewer events, CI results,
session continuity and merge ancestry evidence. Retain failures and unknowns.

## Offline evidence

- `test/bitbucket.test.mjs`: private/public wire shapes; HTTPS/SSH origins;
  repository UUID binding; permissions; bounded pagination; current-head statuses;
  credential isolation; idempotent publication; setup/doctor dispatch refusal.
- `test/bitbucket-review.test.mjs`: exact-head verdict trust and stable actor IDs;
  explicit no reviewer and no-CI grace; required checks; command/inline/task/check
  deduplication; old heads and own replies; API outage cursor preservation;
  same-session correction and restart; independent reviewer prepare/publish and
  retry reconciliation; PR CLI binding; fresh setup/non-default base; merge proof.
- `test/git-host.test.mjs`, `test/host-transport-contract.test.mjs`, and
  `test/git-host-architecture.test.mjs`: shared host contract, synthetic third host,
  GitHub regression coverage, and absence of host-specific scheduler branches.

The production registry retains `dispatch: false`. The test-only injected adapter
is never a qualification switch. In particular ac-1, ac-2, ac-3, ac-5, ac-6, ac-8,
ac-9 and ac-11 cannot be attested as fully met from this evidence alone.

## Local verification, 2026-11-01

- `npm ci --cache /tmp/bitbucket-npm-cache --no-audit --no-fund`: installed the
  locked dependencies (98 packages); no dependency versions changed.
- `npm test`: exit 0; 1,952 tests, 1,951 passed, 0 failed, 1 skipped;
  duration 460,661.5 ms. Local output: `/tmp/bitbucket-verify.log`.
  The skipped test is `Linux verification enforces isolation and drops all
  capabilities`, because this checkout was tested on macOS. This is not Linux
  installation or sandbox qualification.
- `npm run lint`: exit 0, including `task-intake contract pin matches the source`.
  Local output: `/tmp/bitbucket-lint.log`.
- `git diff --check` and `git diff --cached --check`: exit 0 after staging.
- `node --test test/plugin-package.test.mjs test/release-package.test.mjs`:
  65 passed, 0 failed. Local output: `/tmp/bitbucket-package-tests.log`.
- `node --test test/docs-links.test.mjs`: 2 passed, 0 failed after the final
  documentation edits.

Source review checked publication/resume/settlement identity boundaries, snapshot
ordering, reviewer credential scope, recovery failure paths and portable contract
imports. Rendered start/fix prompts use `task-pr` with the selected base and
Bitbucket links. Focused regressions cover those boundaries. None of these checks
invoked inference or provided live Bitbucket evidence.

## Review follow-up, 2026-11-01

The follow-up prerequisite check still found no Bitbucket host settings, coding
credential selection, repository, or reviewer in the operator configuration.
No unchanged blocked API/model call was retried. The live matrix and required
remedy above remain unchanged.

Both review findings were reproduced before their fixes; local output is
`/tmp/bitbucket-review-reproductions.log` (2 failed regressions). The corrections
use the review consumer's timestamp/sequence ordering for publication retries,
and preserve generated UUID bindings when comparing a repeated host import.
Changed credentials, policy, and supplied identities still fail before probes
or writes. The setup mutation lock and uncertain-write behavior are unchanged.

Focused coverage in `test/bitbucket-review.test.mjs`:

- `repeated host imports preserve generated bindings and refuse policy or identity replacement`
- `review publication reconciles only unsuperseded verdicts, including uncertain writes`

The focused review, event, setup and architecture suites passed all 61 tests
(`/tmp/bitbucket-review-fixes-targeted.log`). Inspection of generated fixture
comments confirmed blocking/clear/blocking produced IDs 10/11/12 and an immediate
retry reused ID 12; this is offline protocol evidence, not a real review.

Final follow-up verification:

- `npm test`: exit 0; 1,954 tests, 1,953 passed, 0 failed, 1 skipped;
  duration 672,524.4 ms. Output: `/tmp/bitbucket-review-fixes-test.log`.
  The Linux isolation test remains skipped on this macOS checkout.
- `npm run lint`: exit 0, including the portable contract pin check.
  Output: `/tmp/bitbucket-review-fixes-lint.log`.
- `git diff --check` and `git diff --cached --check`: exit 0.

## Merged policy integration, 2026-11-01

The continuation inspected merge `e15eb66` and retained both original review
fixes. Operator configuration still had no selected Bitbucket account/token,
repository or reviewer; the live matrix remains pending and dispatch stays
disabled. No inference call or unchanged blocked host request was retried.

Source inspection found another occurrence of discarded repository policy:
review preflight flattened scoped settings and then removed the repository
entries before selecting policy again. A repository actor could become the host
default, and explicit no-reviewer mode could disappear. The failing regression
is recorded in `/private/tmp/pr32-merge-policy-reproduction.log`.

The sibling diagnostics path also selected review mode from the global reviewer
and normalized away repository actors, trusted authors and required checks.
Its regression is `/private/tmp/pr32-merge-doctor-reproduction.log`. Preflight
now passes explicit review-setting overrides without discarding configuration;
normalization retains all review fields, and diagnostics use the shared mode
selector. The mixed-host diagnostic fixture now supplies its required explicit
Bitbucket policy instead of failing configuration validation before its check.

Focused coverage includes:

- `test/bitbucket-review.test.mjs`: `review preflight preserves repository actor
  overrides and explicit no-reviewer policy`.
- `test/first-party-review.test.mjs`: `review preflight retains GitHub repository
  actors and explicit legacy overrides`.
- `test/doctor.test.mjs`: `doctor selects first-party prerequisites from
  repository reviewer overrides`.
- `test/base.test.mjs`: `repository review overrides survive validation,
  normalization and base updates without affecting siblings`.

The caller review covered start, register, explicit policy changes, setup and
diagnostics. Host qualification still precedes preflight and external/no-reviewer
policies never prepare inference. These are offline implementation checks, not
live host or reviewer qualification.

Verification after the integration corrections:

- The intermediate `npm test` run began before the diagnostic correction and
  reported only the mixed-host fixture failure: 2,000 passed, 1 failed, 1 skipped.
  Output: `/private/tmp/pr32-merge-policy-npm-test.log`. That fixture now supplies
  explicit Bitbucket policy and passes in the focused run below.
- Final `npm test`: exit 0; 2,003 tests, 2,002 passed, 0 failed, 1 skipped;
  duration 439,146.8 ms. Output: `/private/tmp/pr32-merge-policy-final-test.log`.
  The Linux isolation test remains skipped on macOS; this does not provide
  clean Linux installation or live reviewer qualification.
- Focused base, diagnostic, host, review, event and tick tests: 296 passed,
  0 failed. Output: `/private/tmp/pr32-merge-policy-integration.log`.
  The log also records the generated diagnostic files inspected before push:
  repository overrides retain their expected review prerequisite, and mixed-host
  output retains the Bitbucket no-reviewer disclosure and dispatch refusal.
- `npm run lint`: exit 0, including the portable contract pin check.
  Output: `/private/tmp/pr32-merge-policy-final-lint.log`.
- `node --test test/docs-links.test.mjs`: exit 0.
  Output: `/private/tmp/pr32-merge-policy-docs.log`.
- `git diff --check`: exit 0.

## Completion-gate follow-up, 2026-11-01

The prerequisite check still found no Bitbucket host settings, selected API
account/token, reviewer identity or authorized repository. Criteria ac-1, ac-2,
ac-3, ac-5, ac-6, ac-8, ac-9 and ac-11 remain valid and unmet. Their false
attestations and the dispatch restriction are retained. The external remedy and
live matrix above are unchanged; no model or host qualification was attempted.

The output-pattern denial was traced to the two new CLI entry points,
`bin/task-pr.mjs` and `bin/task-review.mjs`, using the actual PR diff. Both now
write their payloads directly to stdout, preserving JSON indentation, raw diff
text and the trailing newline. Failures still write to stderr and exit with
status 1. The completion policy and its configured patterns were not changed.

`test/host-cli.test.mjs` reproduces the denial against the existing completion
evaluator and checks both entry points with local transport stubs. Coverage
includes large Unicode/raw diff output, JSON, empty results, prepare/publish
responses and operation errors. The pre-fix run had 1 failed policy regression
and 2 passing stream tests: `/private/tmp/pr32-output-policy-reproduction.log`.
These fixtures establish CLI behavior only, never live review qualification.

- Focused output-policy, host-review and completion tests: 47 passed, 0 failed.
  Output: `/private/tmp/pr32-output-policy-focused.log`.
- Final `npm test`: exit 0; 2,006 tests, 2,005 passed, 0 failed, 1 skipped;
  duration 460,000.5 ms. Output: `/private/tmp/pr32-output-policy-test.log`.
  The macOS run still skips the Linux isolation test.
- `npm run lint`: exit 0. Output: `/private/tmp/pr32-output-policy-lint.log`.
- `git diff --check`: exit 0.
- The local evaluator scanned added lines against the actual PR base
  `46a17ff3f5be13e1924351dacea9c928078b0a13` and found no output-pattern denial.
  `/private/tmp/pr32-output-policy-scan.json` retains the criteria denial and
  pending-verification state. This is not a hosted completion approval.
