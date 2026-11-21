# Recovery observations

Open a task's workspace or run `gallivant status --all --json` and inspect `presentation.recovery`. Look at the original failure and its run alongside the latest verified progress. A task can push a new head and still owe a fix for the same finding. A stopped task can owe merge closeout even after its author exits.

## Baseline inspected on 2026-11-20

| Surface | Exact revision | What was inspected |
| --- | --- | --- |
| Implementation checkout and remote main | `bb55eaccea80e29c70e1f4d46bbe4e481c6e56a8` | Git HEAD, remote main and GitHub PR states. #79 merged at this commit. Explicit Resume installs policy from the newly accepted snapshot. |
| Installed CLI | `16a2e31ce582f189eef78ea6d6cb9ad7d731bb40` | The resolved executable belongs to an operations checkout. Its package version reads 0.3.0. The tracked executable, library and templates matched that checkout's HEAD. Its local history includes reconciliation of already-pushed repair work at `2f00ef841a83e3aa8726ac0ec1a54e6917a7695e` and the snapshot refresh at the installed HEAD. |
| Published npm package | `@uchibeke/gallivant@0.3.0`, tag `v0.3.0` at `6354b65b9b5d46fd29d40781e846ec231d2c9ffb` | The registry's latest tarball had integrity `sha512-B/3vArflDEh+1eoZkRnqXjdF1hWo7bMKpWRzCqOvpmrttb2JKM8dOSE7oyuTfVkvSjqVytaKRgVYrP7vZ4b8qQ==`. All 164 shipped files under bin, lib and templates matched the tag's Git blobs. The registry omitted gitHead. |

The historical sample covered execution recovery and handoff (#22, #27), publication hygiene (#42), bounded review history (#43) and orphaned execution (#47). All five had merged and are ancestors of the release tag. Hosted diagnostics (#50), cleanup (#58), pinned-base repair (#64), published context normalization (#66), package credentials (#67), merge closeout (#68, #70), failed Actions behind pending checks (#72), bounded capacity retry and owned controls (#73), coordinator completion credentials (#75) and snapshot refresh (#79) had merged after that tag.

Two PRs in the sample remained open. The private-input merge work in #74 was at `5e541c8ac26b447b2909f33b4a5e30772d125aa1`. The pushed-repair reconciliation in #78 was at `f86ca0857dc9e74215971f7ce47549cbac59344d`. The operations install has a private-overlay restoration path and pushed-repair reconciliation beyond the implementation base. Neither open head defines the release baseline. To refresh this inventory, resolve the installed executable, inspect its checkout and tracked runtime diff, compare the registry tarball against the tag, and query the selected PR numbers and remote main again.

## Incident owners and remaining gaps

| Reproduced condition | Existing owner and evidence | Outstanding obligation |
| --- | --- | --- |
| Interrupted merge with a populated index and a partial resolution | Git and pinned-base repair preserve the existing operation. See the native interrupted-merge fixture in [recovery observations](../test/recovery-observation.test.mjs) and the failed-abort case in [base repair](../test/base-repair.test.mjs). | Reattaching to an interrupted operation after a storage failure requires independent ownership, index and publication proof. |
| An untracked private input collides with a newly tracked base file | The native collision fixture verifies both byte strings. The repair owner checks immutable inputs and protects implementation edits. [Base repair fixtures](../test/base-repair.test.mjs) | A durable backup and restore protocol for collisions remains open. |
| Dispatch uses an old hook after an approved revision changes | Resume and the snapshot reader own the transition. The fixture compares old and current publication policies, and the clean Resume test exercises the hook installation itself. [Resume regression](../test/review.test.mjs) | #79 covers this cache path on main. Detecting contradictory input/output declarations before dispatch belongs to admission. |
| A run exits without publishing a PR | The tick owns discovery and the execution result collector owns verified hosted publication. The missing-publication fixture retains the original failure across a push. [Observation fixtures](../test/recovery-observation.test.mjs) | Continuation needs an owned checkout, reconciled acceptance and verified PR identity. |
| Required independent review fails or old review evidence arrives for a different head | The reviewer owns piece, synthesis and retry records. Current-head bindings control which results qualify. [Reviewer recovery tests](../test/first-party-review.test.mjs) | Matching a finding across revisions with ambiguous citations requires further evidence. |
| A maintainer merges a stopped task | The host adapter, tick, workspace cleanup and chain owner prove distinct parts of closeout. A retained tree can be settled. [Cleanup](../test/workspace-cleanup.test.mjs) and [chain tests](../test/chains.test.mjs) | Some stopped entries fall outside the normal tick. The observer can describe saved merge evidence. Fetching it or releasing a successor remains with the existing owners. |
| Provider backoff, uncertain acceptance or failed CI behind a pending context | The execution ledger owns submission identity, network recovery owns retry windows, and the host adapter owns check results. [Network recovery](../test/network-recovery.test.mjs) and [Actions status](../test/github-actions-status.test.mjs) | A poll or launch during the wait supplies no productive evidence. |
| Storage pressure and abandoned reviewer scratch | Workspace cleanup checks ownership and settlement before removal. [Workspace tests](../test/workspace-cleanup.test.mjs) | A saved ENOSPC signal explains pressure. Sampling mounts, reserving space and scheduling cleanup require separate qualification. |

## Version 1 and clocks

The observer reads coordinator records already present in the shared status model. Each observation carries its task/revision, approval and source fingerprints, optional recovery-profile digest, workspace and branch binding, execution epoch/run/operation/session, acceptance, control and hold information, host and review cursors, resource signal and outstanding delivery, cleanup and chain references. The worktree pointer resolves through the task's own registry entry. Unrecorded values are null. The source manifest digest covers the ordered paths and content hashes accepted at start or explicit resnapshot.

| Clock | What advances it |
| --- | --- |
| `observedAt` | Rendering a new snapshot. Cached host/provider observation times remain available in the shared presentation. |
| `recoveryAt` | Recorded coordination such as a new run, a control, provider retry or review start. |
| `productiveAt` | A verified host push, materialized publication, new current-head failed or settled checks, processed external verdicts, completed independent review, matching delivery/terminal evidence or a recorded milestone merge. A repeated poll over the same evidence preserves the original time. |

The display uses the productive time when available. Legacy entries and tasks awaiting their first verified result use their saved creation time as a stable display origin. A healthy tool can run for hours without a new productive timestamp.

The registry folds compact continuity data into its existing locked writes. Reading status neither persists a snapshot nor increments a counter. Incident keys combine the logical task, approved revision and typed cause. Review findings use their ID and cited path. The original run, head, review reference, evidence source and failure time survive later pushes and attempts. The incident count measures observed subsequent author attempts. The task count covers author runs observed in this revision, so it can be a lower bound on older work. The canonical round and provider retry counters remain available separately. Ambiguous matches and overflow beyond eight retained incidents are visible. A matched publication, newly passing current-head checks or an independently completed current-head clear review can close its corresponding incident. Other causes remain open pending their owner's proof.

`classification` distinguishes active healthy work, accepted or uncertain execution, recovery due, external wait, authority block and settled history. Unsupported versions, fields on the continuity record and unrecognized states are reported as unsupported. Inspect the saved owner record for details. An operator hold, exhausted permission, physical evidence, passkey or integration decision is a gate. The recovery view has no action executor. Message agent, Resume and Recheck use their existing control paths.

The baselines above come from source control, the installed executable and the registry tarball. The behavioral evidence comes from isolated local Git, registry, fake-clock, host and rendered-UI fixtures. Live provider recovery, repository-specific plugin behavior and unattended chains require separate qualification.

## Recovery policy and admission

A new task may pin one protected profile with `start <brief> --recovery-profile <sha256>`. Files and comments in the checkout cannot select a profile. Existing tasks without this pin remain observation-only for the new recipes. Existing bounded connectivity and capacity retries keep their original admission rules.

The coordinator keeps profile revisions and administrative holds in its locked registry. Use `recovery profile <profile.json> new` to create the first revision and supply the exact previous digest in place of `new` for a replacement. Each replacement increments the revision and advances the revocation generation. Running recovery checks resolve the admitted digest again after asynchronous preparation. Replacing a profile invalidates a queued decision, including one that still refers to the old digest on its task. Accepted profile-bound executions use their existing execution owner for observation and targeted cancellation. Terminal results retain their normal settlement path.

The version 1 profile has the following required fields. The schema rejects additional properties at every level.

| Fields | Meaning |
| --- | --- |
| `version`, `id`, `storeId`, `revision`, `digest`, `mode` | Version 1, symbolic profile and registry identities, positive revision, SHA-256 of canonical JSON excluding the digest, and one of `off`, `observe`, `recover`. Use `profileDigest` from `lib/recovery_authority.mjs` when constructing a profile. |
| `recipes`, `taskLimits` | Each recipe has an enumerated `id`, version 1 and `limits`. Both budget objects contain nonnegative integer `mutations`, `paidTurns` and `spendMicros` (millionths of a dollar). |
| `routes` | Each tuple names `harness`, `provider`, `model`, `account`, `environment`, `dataLocation`, `credentialRef`, `capabilities` and `maxSpendMicros`. Use a symbolic `credential:<name>` reference. Credential resolution remains with the original adapter. |
| `cleanup` | Each entry names an absolute canonical `root`, allowed `classes` (settled scratch or settled checkout), `retentionSeconds` and `maxBytes`. The workspace owner still needs exact ownership and settlement proof before deletion. |
| `revocationGeneration`, `holdGeneration` | Nonnegative generation counters. Scoped administrative records also retain their own monotonic generations. |
| `qualification` | Null or an exact `manifest:<name>` reference, manifest digest, absolute `evidenceRoot` and enumerated fixture `actions`. Only the protected profile supplies the binding. |

A version 1 decision names the recipe and version, action, authority, purpose, optional manifest binding, expected task/snapshot/profile/route/ownership/holds digests and profile revision. It includes accepted-and-settled preconditions, an operation key, deadline in Unix milliseconds, budget reservation and enumerated postcondition. The recipe table in `lib/recovery_authority.mjs` is the shared action vocabulary. The read-only command `recovery preflight <handle> <decision.json>` returns diagnostics for the proposed route. A missing exact model entitlement or required browser proof stays visible. Local sign-in and a version response prove neither. Package reads use the repository's opt-in policy. The preflight never installs a runtime or purchases an inference probe.

Disposable qualification uses `admitted-recovery-intent`, purpose `disposable-qualification` and `verify-disposable-isolation` under the exact manifest reference and digest. A standalone denial probe cannot qualify the author that would run outside that probe. The verification owner uses the existing macOS sandbox or Linux namespace adapter. Author, review and intake owners require independent qualification of their actual launch, protected storage, snapshot, credential and control boundaries. All installed author combinations currently report observation-only for new recovery actions. Qualification and rollout belong to M06.

For a qualification decision, preflight returns `disposable.eligible` for the single manifest action. The fixture owner must attest its baseline isolation, ownership, exact launch digest and expiry against the task, operation, approved manifest and evidence root. M06 can consume that result for the same launch after revalidation. Without an installed fixture owner the result is false. Production recipe admission remains observation-only.

Use `recovery hold task/<id> <generation>` or `recovery hold chain/<name> <generation>`. Release that same scope with `recovery resume`. For a repository or profile use `recovery disable repo/<owner>/<repo>` or `recovery disable profile/<id>` with its generation, and `recovery enable` to release it. Supply 0 for the first transition. The command returns the new generation and operator provenance. An applied hold survives restart. A chain hold fences future claims while admitted children keep their own controls.

## Stopped-task migration dry run

Run `recovery inventory <profile-id>` to obtain a read-only proposal and its digest. Each candidate binds the registry entry, approved brief and sources, profile, exact owned execution, review ledger, referenced review executions and hydrated immutable history. Holds, uncertain acceptance, divergence and human decisions exclude a task. An inventory with no matching protected profile has no candidates.

A reviewed batch has exactly `version: 1`, the `proposalDigest` and an explicit nonempty `candidateIds` list. Validate it against a fresh inventory before activation. The migration owner must quiesce affected writers, verify the complete digest set again under the registry lock, and durably back up the registry, snapshots, referenced ledgers and immutable archive as one recovery point. Prepare the replacement records first, then atomically publish a version 3 registry naming them. Recovery before the registry replacement uses the old generation. Recovery after replacement uses the new records. Restore a coherent generation as a unit after draining accepted work. This release emits and validates the plan only. Activation and downgrade qualification remain with M06.

## Deterministic reconciliation

The coordinator checks stopped tasks at their existing due times. A protected profile must admit the exact recipe and route, and the execution owner must supply a current isolation and qualification receipt. Production launch adapters currently lack that receipt. The tests use synthetic owners and host evidence. Run `gallivant why HANDLE` to see the latest reservation, execution phase, stop reason and counts.

| Recipe or owner | Required evidence and permitted effect | Wait or stop condition |
| --- | --- | --- |
| Execution reconciliation | Inspect the accepted operation in its original epoch and collect its recorded result. A new turn links its reservation to that operation and uses its native session. | Unknown acceptance, uncertain cessation or missing session keeps the original owner. |
| Provider continuation | A collected terminal failure matches the stored code and its retry window is due. Retry the same session within the existing three connectivity or twelve capacity slots. | Expired window, unresolved PR identity, authentication, billing or hard quota. |
| Route handoff | A proved terminal local capacity failure, one approved alternate tuple and a qualified target with an enforceable spending limit allow one fresh session in a new epoch. The transfer contains contract and evidence references. | Unsupported target, missing entitlement or ambiguous epoch. Inspect both execution ledgers before taking action. |
| Feedback continuation | The host confirms the open PR, fresh checks and a trusted actionable review cursor. Dispatch one scoped fix. Independently clear feedback and checks can return the entry to ordinary readiness evaluation. | Failed CI and base conflicts use their own admission and evidence. Ambiguous feedback or exhausted rounds remain stopped. |
| First-party review output retry | The reviewer owner matches the exact source digest, route fingerprint, head and piece ledger. An eligible bounded retry alias advances the failed piece or synthesis and preserves accepted pieces. | Missing sources, unknown launch, unconfirmed cancellation, changed binding or exhausted reviewer budget. |
| Publication continuation | The saved contract requires a PR. Discover the checkout branch, origin and all PR states before continuing verification. A hosted result with a pending PR-write acknowledgement can observe its original publication. | Terminal PR, conflicting history, lost session or unresolved write. Preserve commits, dirty files and private inputs. |
| Merge and closure | The host confirms the original repository, PR, branch and base. A merge commit in the approved base and ceased authors allow cleanup and the chain claim. The existing reviewer and delivery proofs determine fulfillment. | Pending cleanup delays the successor. Retained dirty work settles cleanup. Closure without merge stops the chain. |

Hosted publication saves the verified push before discovering the PR. A failed lookup can retry from that checkpoint. Once a PR write is journaled, recovery observes the original write until the host confirms it.

Each new paid recovery operation reserves its recipe and task allowance before submission. The receipt tracks confirmed submissions separately from outstanding reservations. A restart preserves both. New deterministic recovery mutations are limited to two per unchanged incident, subject to the provider retry windows above. A qualified semantic recipe reserves one attempt per unchanged incident by default. Three consecutive unsuccessful author/reviewer cycles require inspection.

## Owned Git and CI repair

`git-repair` binds the original author operation, task revision, repository, branch, workspace, execution epoch and session to the exact task head and pinned base. The workspace owner saves the merge projection and index checkpoint before the existing author receives the pending merge. It can recover an acknowledged checkpoint or reconstruct the initial merge from the same parents when the checkpoint write was interrupted. The Git index and working bytes stay in place. Changed refs, unrelated edits, unrecorded partial resolutions and unknown provider acceptance require inspection of the original operation.

A newly tracked base path may displace an approved untracked planning copy. The workspace owner checks the canonical path, file identity and exact approved or base bytes. It syncs the journal and a private backup before removal. The tracked source stays available for implementation and tests. The author receives the exact approved planning bytes through private continuation input. Unresolved journals protect the workspace and backups during cleanup and restart. Restore storage capacity where the journal or backup resides if syncing fails. Recovery makes no further workspace mutation without a durable intent.

`ci-repair` requires an authenticated GitHub Actions job and attempt on the task head, a failure annotation on an approved changed implementation path and the corresponding successful job and step on the pinned base. A matching base failure or an infrastructure failure is an external stop. Jobs without enough evidence remain observable. The author is restricted to exact approved implementation targets. The original failure remains in the journal and the same workflow, job and step must pass on the repaired head.

The coordinator checks the candidate's commit parents or pinned-base ancestry, scope and approved Verify exits before publishing to the task ref. It observes an uncertain push against the exact remote ref and PR. A new head requires fresh CI, reviewer and completion observations. Moving the base ref creates a separate eligibility decision with the same task counters. The in-flight operation keeps its pinned base.

Inspect the journal ID, operation, full pinned SHA, verification and stop with `why` or `status --all --json`. Restore the matching ledger, checkout or runtime proof before using Recheck. The current recipes require an isolated local clone and a qualified native session. Hosted and linked-worktree adapters, ambiguous merge projections, and GitHub jobs without complete comparison evidence require operator inspection. The native Git and injected-fault fixtures do not qualify a production adapter. Linux and macOS adapter qualification and rollout belong to M06.

To pause future effects, use `gallivant recovery hold task/ID GENERATION`. To stop an active author, use `gallivant cancel HANDLE` and inspect its cancellation result. To disable the recipes for an admitted profile, use `gallivant recovery disable profile/ID GENERATION`. Saved reservations and ledger evidence survive all three controls.

## Scheduling and cycle measurements

The coordinator classifies structural changes every 60 seconds by default
(`recovery_scan_seconds`). Registry changes between cycles can wake eligibility
sooner. The existing execution progress cadence and `poll_seconds` still govern
provider and review polling. Shared service cooldowns can defer an individual
account or credential past those intervals. An entry with a remaining cleanup,
delivery, cancellation or accepted execution stays eligible after terminal
closeout. Settled retained history consumes no author or host slots.
For active entries, the scan reads saved author ledgers locally to find work
whose dispatch acknowledgement reached the ledger before the registry. The
task, provider, run and preceding operation must match before the existing
author or settlement lane can reconcile it.

| Lane | Items per cycle on a standalone coordinator |
| --- | ---: |
| Control | 4 |
| Settlement | 8 |
| Author reconciliation | 8 |
| Git host and PR review | 12 |
| Captured reviewer progress | 4 |
| Chain | 4 |
| Maintenance | 4 |

The default worker concurrency is four. Author launches share the existing
execution concurrency limit. Host writes serialize for each repository.
Portable coordinator embeds can lower their entry and chain capacities.
Independent cursors persist across wakes, and a chain still waits for its own
predecessor evidence when that entry is settling. Host reads, captured review
progress and maintenance can share a cycle for one task. They run in sequence
for that task while other tasks can use the available lane slots. A lane item
has 30 seconds of service I/O budget. The underlying transport's shorter
deadlines still apply. Accepted author processes keep their separately approved
run allowance. Startup PR discovery resumes unfinished repositories on later
wakes and observes the relevant host cooldown.

`gallivant status --json` reports cycle duration, maximum queue delay, oldest
due age, selected and due counts, saturation, and recorded progress transitions
by lane. The rolling window keeps up to 120 cycles and reports p50, p95 and p99
for duration, queue delay and oldest due age. Each cycle starts after the
previous one finishes plus the wake interval. Inspect the measured distribution
when evaluating latency.

The deterministic capacity fixture uses 13 due host items, four slots and
25,000 retained records across four fake-clock cycles. Its p50/p95/p99 were
100/200/200 ms for cycle duration and 800/1050/1050 ms for queue delay and
oldest due age. A separate fixture holds a host read for 60 simulated seconds
while a local cancellation, local settlement, maintenance and an independent
chain finish.
These samples characterize the fixture workload. M06 owns the measured live
capacity and native release targets.

The coordinator records cooldowns in `recovery-cooldowns.json`. Scope is the
Git host and credential, provider and account, or service endpoint and identity.
A server deadline remains a lower bound when local backoff reaches its cap.
A deadline over seven days is reported as suspended. For an author retry that
would exceed its approved retry window, the paid retry expires and safe
reconciliation remains eligible. Auth, billing and hard quota require their
existing remedies.

## Long-running execution and coordinator availability

The `why` report surfaces evidence from the current run or saved tool phase
after prolonged silence. Investigation starts after 15 minutes for unresolved
provider phases, 30 for other author phases and 60 for observed tools. It reads
bounded evidence. The configured hard allowance defaults to 720 minutes.
The existing owned cessation protocol handles approved deadlines and operator
cancellation. A missing final event stays visible as unresolved result evidence.

A stopped coordinator cannot recover itself. `status` reports coordinator-down
recovery unavailable when no independently qualified host supervisor is
available. A stale heartbeat accompanies a live or unverified owner without
changing its lease. Takeover after an alive-hung coordinator requires separate
durable fencing and bounded-cycle proof. See the Linux and macOS deployment
boundaries. [Host supervision](install.md#host-supervision)
