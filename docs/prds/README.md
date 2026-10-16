# Implementation briefs

These PRDs are requirements for work on Gallivant itself. A brief's presence or
`status: ready` means neither that its feature shipped nor that its live release
gates passed. Some briefs describe a completed milestone; others retain blocked
or future requirements. Follow [the operator documentation](../README.md) for
the current user workflow and [the audits](../audit/README.md) for dated evidence.

Use [the PRD guide](../prd.md) and `gallivant new <id>` when writing your own brief.
Use [natural-language tasks](../tasks.md) when you want Gallivant to prepare one
from a request. Do not copy these implementation briefs as an installation recipe.

| Brief | Current operational reference |
| --- | --- |
| [Initialization](gallivant-init.md) | [Installation](../install.md) |
| [Natural-language tasks](natural-language-tasks.md) | [Tasks](../tasks.md), [preparation](../preparation.md) |
| [Carried source files](brief-sources.md) | [PRD sources](../prd.md) |
| [Remote execution foundation](hosted-codex-harnesses.md) | [Execution](../execution.md) |
| [OpenAI Agents API](openai-agents-harness.md) | [OpenAI Agents API](../openai-agents.md) |
| [Codex Cloud](codex-cloud-harness.md) | [Codex Cloud](../codex-cloud.md); new dispatch remains unavailable |
| [Plugin delivery](gallivant-plugin-delivery.md) | [Task delivery](../task-delivery.md); packaging is separate from deployment and live qualification |
| [Harness validation](harness-live-validation.md) | [Harness evidence](../audit/harness-live-validation.md); results apply to the recorded provider/model/version |
| [Review learning](review-feedback-learning.md) | [Learning](../learning.md); collection is available, production application is unqualified |
| [Steering channel](steering-channel.md), [active-session input](run-stdin-steering.md) | [Commands](../commands.md), [execution controls](../execution.md) |
| [Inbound contribution gate](inbound-contribution-gate.md) | [Guardrails](../guardrails.md); this brief does not establish a deployed repository-wide gate |

Keep queued brief and carried-source bytes stable. [Chains](../chains.md) pin
them, and modifying the contract can pause a run or block a successor. Record
changed behavior in the operational guide, and use explicit task reconciliation
for an approved scope change. Roadmap links to later briefs are not proof that
those files or capabilities exist in this checkout.
