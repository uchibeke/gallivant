# CI policy and feedback budget

Pull-request CI selects tests by the actual base-to-head diff. It does not delete
regressions or assume an unchanged component will never need testing again.
Each CI job has a two-minute hard limit. A timeout, failed setup, missing plan,
unobserved selected test or failed test fails the merge gate; partial output is
never a pass. Runner queue time and separate dependency jobs can make total
workflow elapsed time longer than two minutes. Release publishing itself keeps
its separately protected workflow and deadline.

## Selection

| Input | Coverage |
| --- | --- |
| Documentation/PRD-only PR | Syntax, changed local links, canonical operator-document links and anchors (including inbound references), PRD validation and an installed tarball smoke test. |
| Tracker styles/assets | Tracker/control/status/service unit coverage, real browser UI suite, Linux/Node 22 and macOS/Node 24 installed-package checks. |
| Other recognized source changes | Tests with direct/transitive repository dependencies, browser checks and installed-package checks. New or deleted dependencies with no known consumer fall back to all regressions. |
| Runtime/process/Git/sandbox/dependency/workflow changes | Full selected regression inventory on Linux/macOS and Node 22/24. |
| Unknown paths | All regressions and the four-platform matrix. |
| Push to main | Docs-only merges keep the fast path; code merges run the full integration inventory on Linux/Node 22 plus cross-platform installed checks. |
| Nightly and reusable release validation | Every regression on all four OS/Node combinations, installed-package checks and browser UI checks. |

Production source imports and literal repository file references drive the
dependency graph. Styles have an explicit presentation boundary; changes to
server modules still use their real consumers. Tests with computed repository
references or dynamic imports, and their transitive consumers, are retained
conservatively because a literal-only graph cannot prove them unrelated. Unrecognized inputs cannot
create an empty green code check. PR diffs require an exact base SHA; there is no
fallback to a guessed branch or only the last commit. Renames include deletion
and addition. Deleted files remain part of selection.

## Sharding without removing cases

Ordinary test files run intact. Only measured slow suites need partitioning.
`scripts/ci-plan.mjs` uses the pinned development-only JavaScript parser to index
their literal top-level test names. Each partitioned file also gets a residual execution
that excludes those names and runs every remaining registration, including
dynamic names, suites, aliases and future registration forms. Nested tests stay
with their parent; overlapping name prefixes stay together. The sharder never
rewrites test bodies or skips a corpus because it is expensive.

`scripts/ci-weights.json` contains advisory timings from a completed macOS CI
run. They balance work, not decide correctness. New tests receive a small default
weight; new files and unsupported syntax do not disappear. Jobs run up to two
independent 50-second lanes, sharing setup and leaving room for process startup.
Measured whole-file timings account for suites whose dynamic cases are absent
from the literal test index. Slow parameterized pack operations have explicit
top-level names with shared assertion helpers, so one residual cannot accumulate
all of their real pack work.
The runner has a
100-second execution ceiling within the job's two-minute deadline. A single
known test over 95 seconds is refused with an instruction to split that test,
not silently omit it. Adjust case structure or rebalance measured weights if a
job exceeds its deadline; do not merely increase or suppress the gate.

The intake CPU-budget test remains in its own process/job. Native isolation is
still proved before regression execution using Ubuntu's packaged Bubblewrap
AppArmor profile or macOS Command Line Tools. There is no unsandboxed fallback.
Browser checks retain Chromium, Firefox, WebKit, pinned visual comparisons,
synthetic fixtures and read-only workflow permissions. Four file-based browser
shards and a separate installed-package browser smoke job use the approved ARM64
image. Packaging gets its own setup and execution budget. They share one reusable workflow so the full browser suite is not
scheduled twice for the same source update.

## Required checks and concurrency

The always-running `CI` job explicitly requires the plan, selected shards,
installed-package checks and any required browser check to succeed. A dependency
being cancelled or unexpectedly skipped cannot turn that gate green.

The four existing `test (os, node)` contexts remain as tiny compatibility merge
gates depending on `CI`, preserving the current Protect main ruleset during
rollout. They are aggregate checks, not evidence that an unselected platform
suite ran. Actual platform coverage and shard results are named separately in
the jobs and plan summary. Do not remove these compatibility contexts before a
reviewed ruleset migration to the stable `CI` context; otherwise existing PRs
would wait for checks that no longer exist. No check status is forged or posted
manually.

New pushes cancel obsolete runs of the same PR workflow. Main, nightly and
release qualification do not cancel an in-progress release. npm download caches
are keyed by the lockfile; mutable `node_modules` is not shared between jobs.
No paid model, real account operation or production credential is needed.

## Local checks

```sh
npm ci --ignore-scripts
node --test test/ci-plan.test.mjs
CI_EVENT=pull_request CI_BASE_SHA=EXACT_BASE_COMMIT node scripts/ci.mjs plan /tmp/ci-plan.json
CI_SHARD=0 node scripts/ci.mjs run /tmp/ci-plan.json
npm test
```

Replace the base with the actual full commit SHA. An ordinary `npm test` still
runs every test normally; CI selection does not alter that command. Full release
qualification remains mandatory through the reusable workflow before publishing.
