# Bitbucket Cloud review-loop qualification record

Status: **native route and live source review exercised; complete lifecycle qualification pending**.
Dispatch is enabled only under an explicit repository review policy. This
document records the original missing prerequisites, subsequent disposable
transport tests, and the remaining private/public first-party matrix. PR writes
and offline tests are not substitutes for a real model review.

## Live image qualification and disposable review, 2026-11-03

The local ledger records an image-capability challenge for the configured route
as completed in `run-7e5570d0-8085-40fa-9c9b-a71560c5d25f`. Its image route
fingerprint is `00a627eb3da8df9fb9f9d6dd158b2add8563984f6c591d74770055a327b2d118`;
the current configuration has model `gpt-6.1-terra` and reasoning `xhigh`, and
the current image fingerprint matches that record. This challenge is separate
from review of a real PR and does not establish a clear review verdict.

The recorded [disposable private PR #4](https://bitbucket.org/webbabyshowers/gallivant-host-test/pull-requests/4) used `first-party-required`, route
`codex`, no external reviewer, a 900,000 ms timeout, 2,048 maximum jobs,
two retries, a $100 reserved allowance, a 100,000-byte prompt limit and no
zero-checks waiver. Its exact head was `81b41234f8892e93dc0df08d977bc372e054847e`;
base and merge base were `ea78292d50091d38e824a86fb6d7487c516c523f`.
The text job `run-b23a2306-b8ad-4a75-abc0-bf5f22e9cc2d` completed without
findings. The image job `run-957aad23-9eb0-4c66-b3ba-4555e0bdd4e3` received the
captured after-side identity for `review-fixture.png`, with SHA-256
`0d177f076d3ba1a136fb66f8fc88d1e99ab8467517854ef958c9cfbc0747f410`, and
ended `REVIEW_INCOMPLETE`: its visual output had missing criteria or unresolved
scope. The recorded image output examined `ac-1` and identified `ac-2` as
requiring companion Markdown outside its image-only scope. Local regression
coverage now retains that concern and defers the unexamined criterion to the
whole-PR reviewer without repeating the owned image execution. A later live
reconciliation recovered that image output and reached whole-PR synthesis,
but its bounded attempts stopped incomplete because final output included
observations rejected by the old schema. Recorded outputs
`run-f50e47bb-6f10-43a5-ac09-0409ffff341e` and
`run-6d3a449c-86ff-4584-a8f5-b02331d6f66f` passed read-only validation
against their saved inputs. The operator subsequently reconciled the existing
review: the ledger records the original text and image jobs as completed and
the latter synthesis run as completed with a `clear` verdict, zero findings,
no unresolved scope and both criteria examined. Its coverage includes both
original pieces at the stated head, base and merge base. The prior owned
image and synthesis executions were reused; no new inference was needed for
that reconciliation. This is a genuine disposable PR review, not a review of
the resend PR or proof of the outstanding host lifecycle matrix. Provider
costs are unknown.

The owned ledger records are
`~/.gallivant/reviews/3126d2628380b6179574f4b78f68ebfdc5816cae4c962a6ffb287ce722e66d26.json`
and `~/.gallivant/reviews/d88d224fc8f68fbc5acbbb50a160558a008a55b64461e54f895b4db6df0561fa.json`.
Earlier incomplete attempts remain in the ledger for audit; the completed
synthesis used the saved retry alias. This observation does not establish that
the resend PR #311 was reviewed or that either disposable host matrix is complete.

## Live source review follow-up, 2026-11-02

The selected local `codex-cli 0.160.0`, model `gpt-6.1-sol`, reasoning `high`,
passed a genuine restricted qualification in both disposable repositories.
The private qualification run was `run-19c91f53-65d7-43ec-954e-a263b4846bea`;
the public qualification run was `run-1073c551-c3e3-4bf6-b0b8-d05c030d7342`.
Repeated CLI invocations recovered the same qualification instead of launching
another model call after parent tool-call IDs were excluded from its fingerprint.
The private config copy also removes the desktop `daybreak` field, rejected by
the pinned CLI's strict parser. Operator configuration and managed policy are
not rewritten. The native loopback regression advertised zero tools and rejected
five hostile tool calls; all 152 targeted reviewer/preparation/chain tests passed.

These were explicit operator-controlled review criteria applied to existing
disposable PRs, not replacements for their original task acceptance contracts.
The criterion required an explicit caveat that empty credential environment
variables do not prove isolation from files readable under the same OS user.
Verdicts remained in the coordinator ledger; no synthetic review was posted.

| Live observation | Exact head | Owned reviewer run | Result |
| --- | --- | --- | --- |
| [Private PR #3](https://bitbucket.org/webbabyshowers/gallivant-host-test/pull-requests/3), missing caveat | `86cadad0e9f875f98ef1d161fede67f55ac6261d` | `run-93bd9964-899c-4205-8db8-5ef0a6c71d5c` | Concrete finding at `docs/mailbox-verification.md:5` |
| Same private PR after documentation correction | `d5a492e6b381b40fd7aa98ac2b30e11d4c104e0a` | `run-baa2efa6-34ee-47bd-ab35-33832c8274ef` | Fresh clear verdict; previous-head result was not reused |
| [Public PR #2](https://bitbucket.org/webbabyshowers/gallivant-host-test-public/pull-requests/2), initial branch/link criterion | `f58d6e3ce34a35a4ceac0541abdb4426faefe72f` | `run-8265d749-55ad-49a0-bbe1-73a9dd606665` | Clear |
| Same public head, explicit missing-caveat criterion | `f58d6e3ce34a35a4ceac0541abdb4426faefe72f` | `run-013c3cef-0f0c-4a0a-adea-92972c0c7cde` | Finding; changed requirements did not reuse earlier clearance |

Both adapters captured complete live source/diff evidence. The public correction
request succeeded, but read-after-write verification encountered changing
snapshots followed by HTTP 429. Its corrected head and fresh clear review remain
unverified. Stop qualification API reads until rate-limit recovery; reconcile the
existing correction before another write. Model-reported USD costs were absent
(`null`), so costs are unknown and reservations remain consumed; this is not a
native dollar hard cap.

This does not qualify automatic author-session correction, live CI transitions,
daemon interruption during a review, or merge-gated continuation under the new
policy. Existing WebBabyShower runs retain their saved legacy policies and have
not been claimed as independently reviewed. Complete the public correction check
and outstanding lifecycle gates before activating their policy changes.

## Observed prerequisites, 2026-11-01

- Host: Darwin arm64; Node `v22.22.0`; Git `2.50.1 (Apple Git-155)`.
- The operator-installed local Codex CLI returned `codex-cli 0.160.0` from
  `--version`. `exec --help` returned native command
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

## Live matrix — transport partly exercised

| Required observation | Observed repository / PR / run | Result |
| --- | --- | --- |
| Private and public access, HTTPS and SSH | Private and public disposable repos pass API/SSH reads; a private PR and public `qualification-base` push | Partial: HTTPS Git untested |
| Non-default base and PR creation | A private PR targets `main`; public PR #1 targets `qualification-base` | Transport passed; agent dispatch untested |
| Genuine Codex review posting current-head feedback | No authorized first-party inference invocation | Unmet |
| Stable observed reviewer actor; blocking then clear | Coding actor observed; no separate reviewer selected | Unmet |
| Trusted `/fix`; failed then passing CI/check names | No live PR/check producer | Unmet |
| Same-session correction and receipt/readiness | No live run | Unmet |
| Daemon restart recovery | No live run | Unmet |
| Operator merge and merge-gated chain continuation | No authorized predecessor | Unmet |
| Clean macOS and Linux installation qualification | Local development checkout only | Unmet |

Do not populate repository/PR links, actor UUIDs, check names, scope confirmations
or run IDs from fixtures. The observations below are live; the remaining review,
CI, session and merge rows stay unmet until independently observed.

## Disposable live transport observations, 2026-11-01

- An operator-controlled private disposable repository and the public
  `webbabyshowers/gallivant-host-test-public` repository are bound in local
  operator config with a selected account API token and dedicated SSH key.
  The token file remained private and its value was not logged.
- A private transport PR was created after an SSH push. The adapter reconciled
  the existing PR without a duplicate, read a complete snapshot with zero
  statuses/tasks, posted a comment as the coding actor, and updated the body.
  This was a manual transport test, not an agent run or review verdict.
- Bitbucket's PR detail API returned 12-character source/base commit hashes.
  The commit endpoint returned matching full hashes; the adapter now resolves
  and verifies those before using a PR snapshot. Bitbucket also stripped a
  final newline from the submitted description; publication now normalizes that
  text before read-after-write comparison. These two mismatches initially made
  a successful PR create look unresolved. Fixture regressions cover open and
  merged PRs, mismatched resolutions, idempotent publication and recovery text.
  Preflight now leaves comment-read access unknown when only fork PRs exist,
  rather than trying to resolve a fork commit through the selected repository.
- The public repository's [transport PR #1](https://bitbucket.org/webbabyshowers/gallivant-host-test-public/pull-requests/1)
  was opened against `qualification-base` at
  `cce49dd38761f894cf2b41cd2cb8a5a9f2a4b6cc` from head
  `99a8346352fefd3b501b4cfd7a8afec05774aa77`. Its SSH push, PR
  publication, exact-head snapshot and setup preflight succeeded. The
  base later advanced to `5311b17` to hold the public smoke PRD. The private
  repository's `main` likewise advanced to `91e5783` to hold its smoke PRD.
  Both PRDs pass the local structure check, but neither was dispatched. The
  existing token could read both repositories and
  create/comment/edit the private PR, but repository creation through the API
  returned 403 for missing scope. The public repo was created in the browser
  under existing workspace access. No HTTPS Git push, independent reviewer,
  CI producer, task run, daemon recovery or merge
  chain was tested.
- The production `start` command refused both smoke PRDs before dispatch because
  `lib/hosts/bitbucket_contract.mjs` still declares `dispatch: false`.

## Follow-up verification, 2026-11-01

- `npm ci --offline` installed the locked dependencies in the isolated fix
  checkout. `npm test` then passed on the initial transport fix with host
  process access: 2,007 passed,
  0 failed, 1 skipped (the Linux-only isolation test). The suite took 457 s.
  The sandboxed attempt could not identify its own process for daemon-lock
  tests because `ps` was restricted; it is not counted as a code regression.
- After review identified a fork PR listing edge case,
  `node --test test/bitbucket.test.mjs`: 31 passed, including abbreviated
  commit resolution, description idempotency, fork-only preflight and
  repository-wide owned-PR discovery with an unrelated fork present.
- `npm run lint`, documentation link tests and `git diff --check`: passed.

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

Before the disposable transport test, the follow-up prerequisite check still
found no Bitbucket host settings, coding credential selection, repository, or
reviewer in the operator configuration. No unchanged blocked API/model call was
retried. The later transport setup resolved the coding credential and repository
prerequisites; the independent reviewer, CI and task-loop qualifications remain
unmet as shown in the live matrix.

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

## 2026-11-02: local Codex task loop with explicit no-reviewer policy

The public disposable repository `webbabyshowers/gallivant-host-test-public`
was used for one live task on a custom `qualification-base` branch. The
operator-selected account API token and SSH key were kept outside the checkout.
The coordinator cloned with its selected SSH key. The coding session did not
receive that key; a repository-specific Git URL rewrite and bounded HTTPS
credential helper let it push with the selected API token. The first two
attempts exposed missing task PR helper discovery and Git credential transport;
the same committed work and Codex session were resumed after each repair.

The task committed `f58d6e3ce34a35a4ceac0541abdb4426faefe72f`, pushed
`work/public-host-smoke-test`, and opened regular [PR #2](https://bitbucket.org/webbabyshowers/gallivant-host-test-public/pull-requests/2)
against `qualification-base`. The Bitbucket API confirmed the exact head and
base. The agent updated the work-attestations receipt after publication. The
coordinator accepted the receipt and reported `ready` with `no reviewer
configured; receipt accepted` and round `0/10`. No merge was attempted.

The isolated test config deliberately set `reviewer: null`,
`review.legacy_no_review: true`, `review.zero_checks: true`, and no required CI
checks. Thus this run proves PR publication, shared state progression and
receipt acceptance, but it does **not** prove CI integration or independent
semantic review. The reviewer producer remains a documented, unvalidated next
step; no second reviewer account is needed for the qualified no-reviewer path.
The private repository has verified Git/API transport and manual PR operations,
but has not completed a live unattended task loop. Clean Linux installation,
other local harnesses and hosted providers remain unvalidated for Bitbucket.

Verification of this dispatch change: the initial full suite ran 2,009 tests
with 2,006 passing, one skipped and two portable-bundle failures. Both failures
had the same cause: a Node-only helper path in the browser-consumed host
contract. Path resolution was moved into the Node adapter. The exact affected
portable, task-profile and Bitbucket suites then passed 150/150 tests. The
focused review/status/doctor suites passed, `npm run lint`, documentation links,
`git diff --check`, and the packaged `npx` installation test passed. The first
package test attempt was blocked by the local npm cache permissions; the
second could not reach npmjs.org inside the sandbox; the network-enabled run
using a disposable cache passed. The entire suite was not repeated after the
targeted portability fix.

## 2026-11-02: private mailbox test and credential boundary hold

The private disposable repository completed a live local Codex task through a
coordinator-owned PR mailbox. It committed and pushed a small change, opened
[PR #3](https://bitbucket.org/webbabyshowers/gallivant-host-test/pull-requests/3)
against `main`, updated its receipt, and reached `ready` with the explicit
no-reviewer policy. This establishes the private task flow, not independent
review, CI, merge, or deployment. The public [PR #2](https://bitbucket.org/webbabyshowers/gallivant-host-test-public/pull-requests/2)
also remains ready for human review. Both runs used isolated Gallivant homes,
which is why neither appears in the operator's normal dashboard.

The mailbox removed `HOST_API_TOKEN`, `GIT_HOST_TOKEN`, and the selected SSH key
from the coding session environment. A read-only probe in the actual private
Codex session then ran `test -r` on the configured API-token file and returned
exit status 0. The probe did not open, print, copy, hash, or use the token.
Because the token has Bitbucket PR write scope, a session able to read it could
call Bitbucket's merge API directly. A same-user private file plus environment
scrubbing is therefore insufficient; the draft dispatch PR must not be merged
or used for unattended work in other repositories. No secret exposure or
malicious use was observed in these tests.

The mailbox prototype's full suite reported 2,012 tests: 2,010 passed, one
skipped and one failed (`git-host-architecture`: a host-specific decision in
shared Git code). The focused mailbox and Bitbucket suites passed. This
architecture failure is separate from, and does not override, the credential
hold. An OS-enforced read boundary or a server-enforced non-merging coding
identity must be implemented and verified in both disposable repositories
before general dispatch. Independent review, required CI and a clean Linux
installation remain separate unvalidated capabilities. The isolated test
daemons were stopped after their runs completed.

## 2026-11-02: complete evidence and bounded local review implementation

The Bitbucket adapter now implements the shared `reviewEvidence` contract. It
binds the immutable repository UUID and PR number, expands full head/base object
IDs, requests the documented `head..base` comparison with `topic=true` (Bitbucket
orders this opposite to `git diff`), paginates diffstat, obtains the merge base,
and reads source metadata/content at the merge base and head. It compares every
changed path with the raw diff and refuses duplicate, missing, stale, binary,
subrepository, symlink, redirected, rate-limited, truncated and oversized
evidence. It re-reads the PR before returning, and the shared capture boundary
rechecks body/check/policy binding afterward. The selected API credential never
enters the model prompt or reviewer environment.

The shared first-party service now partitions evidence above the 100,000-byte
single-job cap into immutable source and patch slices. Every piece binds the same
task/repository/PR/head/base/merge-base/body/check/policy/aggregate identities and
repeats all criteria. Long lines and lockfiles are sliced with absolute source
offsets. All pieces must complete; one finding, missing piece, malformed response,
timeout, identity conflict or exhausted job/budget bound blocks readiness. An
incomplete aggregate records `review-incomplete`. Head, body, checks and policy
changes invalidate the prior aggregate, while durable piece keys prevent a
restart from launching a duplicate.

Offline regressions include:

- `Bitbucket first-party evidence binds exact PR commits and covers paginated added, modified, removed and renamed files`
- `Bitbucket first-party evidence refuses stale, duplicate, binary, missing-patch, redirected, rate-limited and oversized capture`
- `a deterministic 340 KB lockfile is completely partitioned within configured jobs or refused explicitly`
- `reviewer environment retains selected model access but excludes coding and Bitbucket credentials`
- `explicit policy migration removes legacy no-review while preserving the existing Bitbucket run identity`

The configured Codex executable reports version 0.160.0, meeting the implemented
native-boundary minimum. No selected-model challenge was run in this implementation
session because it was not authorized to start a paid nested job; version and
sign-in status do not establish model access. No current WebBabyShower PR was
captured or reviewed. The public [PR #2](https://bitbucket.org/webbabyshowers/gallivant-host-test-public/pull-requests/2)
and private [PR #3](https://bitbucket.org/webbabyshowers/gallivant-host-test/pull-requests/3)
remain historical no-review transport evidence only.

The exact remaining live remedy is to authorize the bounded qualification job,
then run a genuine first-party review on a fresh exact head in each disposable
repository: record a blocking finding, correct the same PR/session, and record a
fresh clear aggregate. The record must include repository/PR links, task and
review run IDs, reviewed full SHA, selected model, provider-reported cost (or an
explicit unknown-cost reservation), credential-isolation observation, restart
deduplication, and a changed-head non-clearance check. Synthetic verdict JSON or
the earlier no-review PRs cannot fill those rows.
