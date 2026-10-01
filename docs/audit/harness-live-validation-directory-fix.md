# Correct inherited tool directory before targeted retries

The 2026-10-01 Console batch exposed a shared runner defect. `makeRunner.start`
passed the disposable checkout as `spawn.cwd` but inherited the launching shell's
`PWD`. OpenCode 1.18.31's [run command, lines 333–346](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/run.ts#L333)
prefers `process.env.PWD` when choosing the session/tool directory. All three
original Console session exports consequently identify the PR worktree instead
of their disposable checkout. This is a directory propagation defect, not a
provider entitlement or approval failure.

The xAI start wrote the two probe files, ran tests and committed in the wrong
repository. It then changed origin to its local bare remote and created/pushed an
orphan probe branch after other pushes failed. This violates the probe's scope and
stop-on-failure instructions. It is **failed evidence**, despite an adapter success
event and a local push. The external verifier rejected the empty intended checkout.
Alibaba was stopped as soon as the isolation failure was investigated. Meta had
already stopped on a native external-directory permission denial.

Recovery preserved the pending PR edits and probe artifacts privately, restored
origin and the PR branch/index to `04f55e11dd9008681763b0cbe04754cd17135ac8`, and
removed only the two accidental probe files from the PR worktree. The accidental
local commits remain recoverable through reflogs. Recovery used no rebase, force-push
or stash, and no successful GitHub push or default-branch change occurred. The later
xAI retry's attempted rebase in its disposable checkout is a separate failed result
recorded in the main audit.

`lib/run.mjs` now sets the child `PWD` to its resolved requested `cwd` after merging
the environment. This fixes the shared launch path without modifying native
permissions. The offline regression `runner pins PWD to the checkout for tools
that prefer it over process.cwd` failed before the fix and passes afterward: a
real child using the PWD-first rule must write only in the checkout and leave the
parent untouched. `live OpenCode directory evidence rejects tools rooted outside
the disposable checkout` verifies the new native-export directory check. A
mismatch stops the batch before another combination or resume can start.
After the xAI retry exposed the already-contaminated remote, a start-fixture
preflight was added and regression-tested: dirty/prewritten files, extra commits,
changed origin or any existing remote ref now prevent a call. Alibaba's retry
passed this preflight. The ambiguous greeting prompt was also made explicit after
that retry failed the comma assertion; its failed result remains unchanged and its
retry allowance was not extended.

Only `opencode-console-xai:start` and `opencode-console-alibaba:start` qualify for
one targeted retry in the original 30-minute ledger after this fix. Their original
starts had no approval/provider denial. Meta, historical OpenCode Go cases, and
Goose's provider/approval failures must not be retried. Results and source hashes
for both attempts are retained in the provider batch report. A new denial on a
targeted retry ends that case; no guard or scope is widened to obtain a pass.

Private evidence: `$TMPDIR/gallivant-live-harnesses-blFUMD`, including each case's
`start-1-session.json`, `runs/*/job.log`, and verifier output. Recovery copies are
under `/private/tmp/gallivant-worktree-recovery-20261001` and remain outside Git.
