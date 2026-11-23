# Workspace cleanup

Gallivant removes disposable task workspaces after the Git host confirms that a
PR was merged. It runs cleanup before saving the terminal `done` transition.
The same coordinator path serves GitHub and Bitbucket; it does not merge PRs,
waive review or satisfy an acceptance criterion.

Eligible directories are the private task clone beneath the configured
`worktrees` root and recorded, settled local-review preparation directories.
Removing a clone also removes its installed dependencies, build outputs and
private per-task credential configuration. No separate cleanup command or
provider-specific setting is needed.

Local implementation harnesses receive a private, short task-scoped directory
through `TMPDIR`, `TMP` and `TEMP`. The path keeps Unix socket names within
platform limits. The launch records its exact directory identity outside the
checkout. The private npm cache lives under `.cache/gallivant/npm`. The
coordinator checks both kinds of ownership before removing them, including
any legacy temporary alias that is part of a merged workspace's cleanup.
Explicit absolute paths such as
`/private/tmp/custom-test-output` remain the task author's responsibility.

The coordinator preserves:

- Operator checkouts and directories still referenced by another task or chain.
- Open PRs and PRs closed without merging.
- Local changes, untracked files, stashes, unpublished branches, changed origins
  or heads, linked worktrees, submodules, hidden index flags and in-progress Git operations.
- Live author/reviewer processes, uncollected results and ambiguous cancellations.
- Task/PRD snapshots, registry and chain records, execution logs, receipts,
  review metadata and immutable review history.

A retained checkout is recorded with its reason. A transient filesystem failure
or unsettled execution leaves cleanup pending for a subsequent coordinator poll;
it does not start another agent or consume a review round. Before deletion starts,
the coordinator saves the exact directory identity. After a crash, cleanup can
finish deleting that same directory even if `.git` was already removed. A
replacement directory does not inherit that permission.

Cleanup Git probes use a credential-free environment, disable filesystem-monitor
and other execution hooks, and disable configured clean/process filters and
network transports. Repository-local configuration cannot authorize a callback in
the coordinator. Reviewer cleanup collects already-exited recorded jobs without
dispatching another review, and pending learning-audit deliveries remain retryable
after workspace cleanup settles.

Inspect the result with:

```sh
gallivant why owner/repository/task-id
```

Tasks whose policy stops implementation at PR readiness remain eligible for a
bounded, host-only merge observation for cleanup. Completed entries with remaining closeout use the bounded maintenance lane.
A proved retain outcome settles chain cleanup while preserving source and
evidence. A separately scheduled maintenance attempt can retry a changed
proof without reopening a completed task. Optional archives have independent
retention.

Cleanup is scoped to Gallivant's own directories. It does not prune arbitrary
`/tmp` files, global npm/pnpm caches, Docker images or user data. Keep adequate disk
headroom for concurrent dependency installs and tests. A local harness's `ENOSPC`
can refer to the host disk shared by its sandbox, temporary files and session logs.

Run and review archives remain available for recovery and audit. Their long-term
retention is separate from disposable workspace cleanup; do not delete private
review history independently of its registry references.

## Headroom and qualified maintenance

New work checks the actual target mounts for available bytes and inodes before
clone, preparation or launch. Memory and load can also defer heavy dispatch.
The coordinator keeps existing authors and safe observation eligible. Package
installs remain on demand.

Run `gallivant recovery resources [handle]` for a redacted dry run. The report
shows mount roles, available capacity, artifact class, reason code and next
observation. Ownership requires an exact settled owner and artifact identity. Qualified maintenance can
retire settled scratch, compact coordinator-created npm caches after their warm
period and revisit explicitly retryable checkout proofs after six hours. The
protected recipe limits roots, retention, mutation count and bytes. Dirty
source, active or uncollected work, approved inputs, UI logs, backup files and
unresolved Git recovery journals remain protected. A replaced directory or
shared mount is retained.

When an approved reserve is available, the coordinator can release its exact
inode to make space for the journal. The deletion intent includes the canonical
root and directory identity. It is synced before removal. Recovery can re-sync
an existing intent without allocating a new state file and reconcile the same
directory after interruption. If recording remains unavailable, cleanup pauses.
Leave the reserve receipt and pending intents in place when investigating space
pressure. [Configuration and disable controls](config.md#recovery-scheduling-and-headroom)
