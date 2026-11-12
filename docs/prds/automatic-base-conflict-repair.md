---
status: ready
harness: codex
---

# Repair base conflicts within the existing task run

## Problem

Gallivant already merges a changed base into a clean task branch before a fix round. When Git reports a conflict, it aborts the merge and stops for a human. Recent PRs needed routine reconciliation after another approved PR merged into `main`; each required a manual merge, tests, push and resume even though the task agent retained its context and authority to edit its own branch. Add a bounded recovery path so an unattended run can finish these repairs without treating newer base content as automatically correct. The existing task brief, security policy, reviewer evidence and merge gate remain authoritative.

## User stories

- As a task owner, I want Gallivant to ask the same agent to resolve a routine base conflict, so that a new base commit does not strand an otherwise healthy run.
- As a maintainer, I want one host-neutral recovery path, so that GitHub, Bitbucket and future qualified hosts share the same branch behavior.
- As a reviewer, I want the merged result tested and reviewed at its new head, so that resolving a conflict does not reuse clearance for older code.
- As an operator, I want ambiguous or repeatedly failing repairs to stop with exact evidence, so that automation does not discard work or spend indefinitely.

## Acceptance criteria

- Given a watched PR with a settled run, a clean owned worktree, a saved base branch and a continuing session, when Git's normal base merge conflicts or the host reports a conflicting PR, then Gallivant records the task head, base SHA and failure, aborts the attempted merge, and dispatches one conflict-repair operation through the existing runner. It uses the same harness session, task brief, carried sources, permissions and provider allowance; it never launches a second worker while a run is active.
- Given that operation, when the agent receives its prompt, then it is told to fetch and merge the pinned base into its task branch without rebasing or force-pushing, inspect each conflict against both changes and the acceptance criteria, preserve applicable new base behavior and task behavior, run the brief's Verify commands, commit the merge, and push only its task branch. It may remove task code that the base demonstrably supersedes, but must explain that choice and test the resulting behavior. It may not resolve by blindly taking either side.
- Given a conflicted or dirty task worktree when a repair run ends or a daemon restarts, when Gallivant reconciles the operation, then it preserves the index and files, never silently aborts or resets them, and resumes only the recorded owner and session after validating repository, branch, base and operation identity. Unknown ownership, uncommitted unrelated edits, an unresolved merge at completion, or a failed push stop with an actionable reason and the worktree intact. A failed launch cannot spend a second operation or hide the original conflict.
- Given changed PRD, carried sources, agent instructions or operator policy, when automatic repair would start, then existing snapshot and authorization checks still apply. A conflict cannot resnapshot instructions, widen credentials or context paths, disable guardrails, or change the review policy; an input that requires operator approval remains blocked.
- Given a repair push, when Gallivant observes the PR again, then it proves the remote branch contains the repair commit and the intended base, invalidates old readiness and head-bound review evidence, waits for new-head CI and required reviewer clearance, and runs the usual completion gate. It neither marks the task complete nor advances a chain merely because the conflict is gone.
- Given repeated conflicts or base movement during a repair, when Gallivant chooses another action, then it deduplicates by exact task head and base SHA, counts paid repair operations against the existing iteration limit, and stops with a clear reason when the same input fails again or the limit is exhausted. Transient Git/API failures retain the normal bounded retry behavior and do not turn into an unbounded model loop.
- Given an unsupported host, missing base identity, no recoverable session, insufficient permissions, or a conflict outside the task's authorized checkout, when recovery is considered, then Gallivant retains the current safe stop and names the prerequisite. Automatic repair does not grant merge, deployment, repository settings or extra credential authority.
- Given local fixtures for an overlapping code change, a superseded task edit, a changed reviewer head, dirty recovery, duplicate tick, provider failure, live base movement, and a merged predecessor in a chain, when tests run, then they prove no lost edits, duplicate dispatch, stale clearance, force push or premature successor. GitHub and qualified Bitbucket use the same coordinator path; host-specific PR evidence stays in adapters.

## Implementation boundaries

Reuse `git.mergeBase`, the task execution ledger, `resume` or fix dispatch, review binding and chain gate. Keep the first failed merge aborted and the checkout clean before the repair agent begins; that agent performs the interactive merge in its own isolated task worktree. Add only the durable operation data needed to make a crash and retry unambiguous. Do not add a separate conflict service, a second reviewer, a new public webhook or a configurable conflict budget. Leave nonconflicting merges on their current fast path.

Use the existing clean-worktree rules for unchanged approved brief and carried-source copies; those inputs must not become a new permanent dirty-worktree blocker. Never clean or stage them merely to permit recovery. Resolve and record the base commit once before dispatch; fetching the base branch later must not silently substitute a newer commit for that operation. After a repair, prove the pinned base is an ancestor of the observed remote task head using the existing Git abstraction.

Document the automatic path and its stop reasons in the command, chain and troubleshooting docs. State plainly that newer base changes do not always supersede task work: the combined behavior must satisfy the approved brief and current security requirements. Run this PRD after the in-flight Git host chain is integrated, so the implementation targets the current shared host boundary.

## Verify

- `npm test`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/git.mjs`, `lib/tick.mjs`, `lib/commands/resume.mjs` and `lib/execution.mjs` own merge, dispatch and recovery.
- `lib/state.mjs`, `lib/review_policy.mjs`, `lib/events.mjs` and `lib/chains.mjs` own identity, clearance and successor gates.
- `docs/commands.md`, `docs/config.md`, `docs/chains.md` and `docs/guardrails.md` describe current behavior.

## Out of scope

- Automatic PR merge, base-branch writes, rebasing, force-pushing or choosing one side of every conflict by policy.
- Changing the task brief or carried sources without their existing operator approval path.
- Repairing conflicts in repositories or Git hosts that Gallivant has not qualified for task execution.
- Restarting tasks explicitly paused or cancelled by the operator, or clearing unrelated blockers merely because a branch becomes mergeable.
