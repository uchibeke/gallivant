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

Local implementation harnesses receive task-scoped `TMPDIR`, `TMP` and `TEMP`
through a short `/tmp/gvt-…` alias into `.cache/gallivant/tmp` in their clone.
The short path keeps Unix socket names within platform limits; an occupied or
changed alias is refused rather than overwritten. The existing private npm cache stays
under `.cache/gallivant/npm`. Both are materialized at dispatch and ignored by Git.
Tools that honor these environment variables therefore keep their scratch files
inside the workspace that is removed on merge, together with its verified alias.
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
bounded, host-only merge observation for cleanup. Old completed entries are also
checked, at most four per coordinator tick and no more than once per task's normal
polling interval. These observations do not restart execution or change a recorded
acceptance decision. Once cleanup is done or a checkout is explicitly retained,
it is not repeatedly scanned.

Cleanup is scoped to Gallivant's own directories. It does not prune arbitrary
`/tmp` files, global npm/pnpm caches, Docker images or user data. Keep adequate disk
headroom for concurrent dependency installs and tests. A local harness's `ENOSPC`
can refer to the host disk shared by its sandbox, temporary files and session logs.

Run and review archives remain available for recovery and audit. Their long-term
retention is separate from disposable workspace cleanup; do not delete private
review history independently of its registry references.
