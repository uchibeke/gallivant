# Plans and delivery contracts

These documents capture architecture, ownership, sequencing and required release
gates. They are specifications, not a support matrix. Dates and source revisions
identify the context in which a statement such as “current,” “missing” or “will”
was written. Use [the operator guides](../README.md) for shipped behavior and
[audit records](../audit/README.md) for observed results.

| Plan | Purpose and current reference |
| --- | --- |
| [Tasks, hosted harnesses and plugin delivery](plugin-ready-gallivant.md) | Original milestone sequence; current [tasks](../tasks.md), [execution](../execution.md) and [task-delivery](../task-delivery.md) contracts |
| [Hosting and live tests](plugin-hosting-and-live-tests.md) | Dated hosting decisions and bounded test authority; follow current provider setup and separately verify actual deployment |
| [APort integration correction](aport-task-delivery-integration.md) | Ownership and dependency addendum for the integration/release milestones; an intended endpoint is not evidence of its deployment |
| [Review-feedback learning](review-feedback-learning.md) | Approval and isolation design; current [learning status](../learning.md) remains collection only |

Plans may be carried sources in approved PRDs. Changing a plan can invalidate a
queued chain's source digest, so preserve the original requirements and record
implementation progress in the guides and new evidence. Product requirements
for Codex Cloud, learning application or hosted plugin release remain requirements
until their explicit qualification gates pass. Do not enable them based only on
a plan, merged code, or passing offline fixtures.
