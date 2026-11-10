# UI experience chain

## Approved objective and boundary

Transform the existing UI into a polished, attention-first workspace without
rewriting the task engine. Shared requirements are in
[the UI experience contract](../design/ui-experience-contract.md). The planning
PR must merge into the existing main branch before implementation begins.
Every milestone targets main and produces one regular reviewable PR.
This plan prepares work; it does not itself start or merge tasks.

The architecture follows existing provider/harness/host separation: one engine
and capability model, shared presentation projections and components, thin HTTP
adapters and browser controllers. Read model changes must be additive. Runtime
state, approval authority, review semantics and protected controls remain owned
by their existing modules.

## Milestones

| Order | Brief | Concrete result |
| --- | --- | --- |
| 1 | [Foundation](../prds/ui-01-design-system-and-shell.md) | Design tokens, reusable primitives, navigation shell and deterministic browser harness. |
| 2 | [Shared presentation model](../prds/ui-02-task-presentation-model.md) | Honest phases, attention, activity, freshness and evidence selectors shared across views. |
| 3 | [Overview](../prds/ui-03-attention-first-overview.md) | A redesigned task cockpit with actionable priorities, useful summaries and discovery. |
| 4 | [Task workspace](../prds/ui-04-task-workspace-and-activity.md) | One coherent place for delivery, PR/CI/review, acceptance, attempts and bounded activity. |
| 5 | [Operator controls](../prds/ui-05-message-and-recovery-controls.md) | Distinct message, resume, recheck and cancel flows with safe asynchronous feedback. |
| 6 | [Chain workspace](../prds/ui-06-chain-workspace.md) | Dependencies, current milestone, merge waits and existing chain recovery in one view. |
| 7 | [Guided intake](../prds/ui-07-guided-task-intake.md) | Reviewable preparation, questions and explicit revision-bound task start. |
| 8 | [Health and navigation](../prds/ui-08-health-search-and-onboarding.md) | Honest system/provider readiness, useful setup states and cross-view keyboard discovery. |
| 9 | [Final qualification](../prds/ui-09-polish-accessibility-and-release.md) | Cohesive visual polish, accessibility, performance, package and end-to-end release proof. |

Each milestone depends on all preceding milestones being merged. It must reuse
their modules and tests from the updated base, not copy their implementation or
create a parallel component/model/polling system. Milestone 1 creates test:ui;
subsequent Verify commands deliberately depend on that merged script. Milestone
9 is the final quality gate, not permission to defer correctness or accessibility
from earlier work.

Lookout is reserved for after this chain is accepted. There is no Lookout brief,
task ID, placeholder file, dependency or queued milestone in this plan.

## Start prerequisites and exact queue command

Before queueing, merge the planning PR, inspect the current remote main, verify
that the installed CLI supports chains and the configured Codex harness passes
normal readiness checks, and confirm there are no existing registered tasks with
these IDs. Sources are the two immutable planning documents committed here.
The existing configured credentials and security policy apply; never substitute
another home or weaken the readiness/review gates to start this plan.

Validate all briefs through the normal readiness command. The implementation
source in this repository can be used when a published CLI is older:

```sh
for brief in docs/prds/ui-0*.md; do
  node bin/gallivant.mjs ready "$brief" --check || exit 1
done
for brief in docs/prds/ui-0*.md; do
  node bin/gallivant.mjs ready "$brief" || exit 1
done
```

Use only the nine explicit paths below to queue the chain, after all are ready:

```sh
gallivant chain ui-experience \
  docs/prds/ui-01-design-system-and-shell.md \
  docs/prds/ui-02-task-presentation-model.md \
  docs/prds/ui-03-attention-first-overview.md \
  docs/prds/ui-04-task-workspace-and-activity.md \
  docs/prds/ui-05-message-and-recovery-controls.md \
  docs/prds/ui-06-chain-workspace.md \
  docs/prds/ui-07-guided-task-intake.md \
  docs/prds/ui-08-health-search-and-onboarding.md \
  docs/prds/ui-09-polish-accessibility-and-release.md \
  --base main
```

The chain is serial and merge-gated. A passing receipt, ready-for-human state or
ended worker does not launch the successor. Review and merge each milestone;
the daemon observes the host-confirmed merge and starts the next from that base.
Existing unrelated jobs and chains are preserved. Do not start these briefs
individually once they are queued.

## Change and recovery discipline

Keep these two sources unchanged after queueing. Implementation-specific design
notes and documented code conventions belong in new durable files created by
the milestones. Predecessor code/assets come from the merged base, never from
a stale carried copy. If a requirement genuinely changes, stop, review the
remaining briefs/sources, run readiness again and use the normal explicit
chain --retry --resnapshot process. Do not edit local chain state or bypass
brief-change protection.

Use the existing task control path to correct or resume a started milestone.
Chain retry does not resume a worker or reset its budgets. A closed unmerged PR
stops the dependency. Conflicts use the existing approved-base process; never
force-push or silently replace work. No milestone authorizes automatic merging.

## Completion checklist

- Every phase is visible and correctly distinguished from worker liveness,
  delivery readiness, integration, missing evidence and unavailable capabilities.
- The same task/chain facts agree in API, CLI, overview and detail.
- Message, Resume, Recheck and Cancel have distinct effects and truthful status.
- Root and mounted URLs work; Command Center port and host routes are preserved.
- Real browser proof covers both themes, five viewport widths, keyboard, zoom,
  reduced motion, stale/error states and long content.
- Browser/data work is bounded, no new per-row remote polling is introduced,
  and synthetic large-list qualification passes.
- Runtime portability, UI CI, installed-package smoke tests and public docs are
  current. Browser dependencies and test fixtures do not ship at runtime.
- The final before/after captures show a material redesign of the actual product.
- No Lookout work, live job mutation, publishing or deployment has been smuggled
  into the UI milestones.
