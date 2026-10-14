# PRD chains

**Gallivant automates delivery; humans approve integration.** A chain starts its next PRD only after GitHub confirms
that the preceding PR was merged into the planned base branch. Gallivant never merges PRs. Passing tests, an accepted
receipt, `ready-for-human`, and a finished agent session are progress toward that decision; none starts the next task.

This lets you approve a multi-hour or multi-day plan once, then review meaningful milestones as they arrive. It does
not promise uninterrupted execution while you are unavailable: a dependent chain waits for your merge. Put cohesive
implementation steps inside one PRD to keep the number of integration decisions manageable.
Research and documentation milestones work the same way when their outputs live
in the repository and have concrete verification. Natural-language task intake
can prepare individual briefs, but `chain` itself takes ready PRD paths; it does
not infer dependencies from chat or queue unfinished intake sessions. Hosted and
local implementations retain the same human merge gate, and the coordinator must
remain running to observe it.

## Queue a plan

Create each PRD in the repository it describes and mark it ready:

```sh
gallivant ready docs/prds/foundation.md
gallivant ready docs/prds/integration.md
gallivant ready docs/prds/launch.md
gallivant chain launch docs/prds/foundation.md docs/prds/integration.md docs/prds/launch.md
```

A chain requires at least two ready PRDs, all in one checkout of the same repository and targeting the same base
branch. Configure that repository's [base](config.md#the-base-branch) before queueing, or pass `--base <branch>` when
creating the chain. Every task must be new to Gallivant; existing
registered runs and IDs already reserved by another chain are refused. Do not start queued PRDs separately.

Queueing records the approved order, base, and fingerprints of the PRDs and their carried `sources` files. It brings
up the existing daemon if needed. The daemon starts the first task, uses the ordinary implementation and review loop,
then waits for the merge. Each successor starts in its own checkout from the updated base. A final merge completes
the chain; closing any milestone's PR without merging stops it.

The scope is deliberately linear: one repository, one base, one active milestone per chain. There is no dependency
graph, stacked-PR mode or automatic merge. Unrelated tasks and other chains can run independently.

## Inspect progress

```sh
gallivant chain                 # list chains
gallivant chain launch          # milestones and the current wait or stop
gallivant status                # run status and chain progress
gallivant why your-repo#123     # details for a started milestone
```

Merge the current PR when you accept it. There is no separate close or next-step command. The daemon checks the
actual PR state and intended base, then verifies that the successor's base contains the merge commit. A local
`done` entry alone is insufficient because it can also describe a closed, unmerged PR.

If the current task needs a correction, use the existing `say`, `recheck` or `resume` commands for that run. Its
session, checkout and review budget belong to the normal run lifecycle. Recovering that task does not require a
second chain retry; the chain continues watching its current milestone.

## Change the remaining plan

Changing a queued PRD or a carried source pauses dispatch rather than silently accepting new instructions. Review
the changes, run `ready` for any updated brief, then explicitly approve the unstarted portion again:

```sh
gallivant chain launch --retry --resnapshot
```

This only reapproves briefs and sources for tasks that have not started. To update an active task, use
`gallivant resume <handle> --resnapshot` instead. The chain's order, task identities and base stay fixed; cancel and
queue a new plan if those need to change.

Keep `sources` for planning inputs that the successor should carry unchanged. Read predecessor implementations and
generated artifacts from the newly merged base. Gallivant refuses to overwrite a base file changed since queueing
with an older carried copy; reconcile the planning input before retrying. Keep the checkout containing the approved
briefs available until they have started.

## Recover or cancel

After fixing a chain-level problem, retry its checks:

```sh
gallivant chain launch --retry
```

Retry does not approve edited briefs, reset iteration counts, or turn an unmerged PR into a satisfied dependency.
It applies only to a stopped chain. If you reopen a closed PR and want Gallivant to continue its review loop, register
that PR again before retrying the chain; a locally `done` run is not resumed merely by reopening its GitHub PR.
If a daemon stopped during dispatch and cannot prove whether a session started, the chain stops for inspection.
Check the chain detail, `gallivant why <handle>` when an entry exists, the run logs and `~/.gallivant/daemon.log`.
Retry never clears an ambiguous pending-start claim. Do not delete claims or worktrees merely to force another
start: an earlier process may still be working there.

To stop future dispatch:

```sh
gallivant chain launch --cancel
```

Cancellation preserves already started sessions, branches, PRs and checkouts. An active milestone remains under
the ordinary review loop. It does not cancel or undo work that has already started.

Chain approval and unstarted milestones live in local `state.json`; unlike an open PR's identity, they cannot be
reconstructed from GitHub. Preserve your Gallivant home when moving the daemon to another machine.
