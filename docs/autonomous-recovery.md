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

Use `recovery hold task/<id> <generation>` or `recovery hold chain/<name> <generation>`. Release that same scope with `recovery resume`. For a repository or profile use `recovery disable repo/<owner>/<repo>` or `recovery disable profile/<id>` with its generation, and `recovery enable` to release it. Supply 0 for the first transition. The command returns the new generation and operator provenance. An applied hold survives restart. A chain hold fences future claims while admitted children keep their own controls.

## Stopped-task migration dry run

Run `recovery inventory <profile-id>` to obtain a read-only proposal and its digest. Each candidate binds the registry entry, approved brief and sources, profile, exact owned execution, review ledger, referenced review executions and hydrated immutable history. Holds, uncertain acceptance, divergence and human decisions exclude a task. An inventory with no matching protected profile has no candidates.

A reviewed batch has exactly `version: 1`, the `proposalDigest` and an explicit nonempty `candidateIds` list. Validate it against a fresh inventory before activation. The migration owner must quiesce affected writers, verify the complete digest set again under the registry lock, and durably back up the registry, snapshots, referenced ledgers and immutable archive as one recovery point. Prepare the replacement records first, then atomically publish a version 3 registry naming them. Recovery before the registry replacement uses the old generation. Recovery after replacement uses the new records. Restore a coherent generation as a unit after draining accepted work. This release emits and validates the plan only. Activation and downgrade qualification remain with M06.
