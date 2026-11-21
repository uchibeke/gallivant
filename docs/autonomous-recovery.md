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
