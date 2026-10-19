# Documentation

Start with [installation and your first run](install.md), then choose how to
describe the work. [Natural-language tasks](tasks.md) prepare a reviewable brief
from your request; [hand-authored PRDs](prd.md) let you write that brief directly.
Both use the same validation, execution, GitHub review and completion workflow.
Code, research and documentation can all be delivered as verifiable repository
changes. You do not need to write a PRD by hand, but every run needs clear
requirements and checks.

## Choose a guide

| Need | Guide |
| --- | --- |
| Install, configure access and complete a first task | [Getting started](install.md) |
| Ask an agent to inspect, install and verify setup | [Agent setup](agent-setup.md) |
| Describe work, answer questions, inspect a draft and authorize execution | [Natural-language tasks](tasks.md) |
| Write a brief with acceptance criteria, source files and verification commands | [PRD contract](prd.md) |
| Find commands, monitor progress, message or resume a run | [Commands](commands.md) |
| Configure repositories, credentials, harnesses and execution limits | [Configuration](config.md) |
| Use the local dashboard and understand product boundaries | [Application](app.md) |
| Run coding work on an API-backed hosted environment | [OpenAI Agents API](openai-agents.md) |
| Understand the unavailable Codex Cloud dispatch and its required qualification | [Codex Cloud](codex-cloud.md) |
| Queue dependent tasks with a human merge between steps | [Chains](chains.md) |
| Understand permissions, credentials and completion checks | [Guardrails](guardrails.md) |
| Keep Node, Git and dependency execution consistent | [Runtime environment](runtime-environment.md) |
| Diagnose DNS/HTTPS failures and understand automatic recovery | [Network recovery](network-recovery.md) |
| Collect review feedback and understand why learned-rule activation is unavailable | [Learning](learning.md) |
| Integrate the shared services or package a task-delivery plugin | [Task delivery](task-delivery.md) |
| Qualify a specific task-delivery plugin release and its actual host evidence | [Release qualification](release-qualification.md) |
| Understand preparation isolation and provider capabilities | [Preparation](preparation.md) |
| Understand durable runs, continuation, cancellation and publication | [Execution](execution.md) |
| Understand module ownership and the overall design | [Architecture](architecture.md) |
| Prepare an announcement or publish a release | [Launch](launch.md), [releasing](releasing.md) |

## Read support claims precisely

The local execution adapters are Claude Code, Codex, Gemini CLI, OpenCode and
Goose. The OpenAI Agents API adapter performs remote execution and restricted
task preparation. Codex Cloud is registered but refuses new dispatch because
the supported interface cannot verify the selected environment's repository.
Local Codex and Claude execution remain available. Preparation has its own
capabilities: an implementation adapter does not automatically support drafting.

Run `gallivant doctor` to check the configured installation. An adapter or a
passing fixture test does not establish access to your provider, model or paid
plan. Follow the selected provider's guide for actual prerequisites and recorded
qualification limits. When using hosted execution from the CLI, Gallivant's
coordinator still needs to remain running to advance the task and review loop.
A packaged plugin is also separate from a deployed, authenticated service.

## Specifications and recorded evidence

The guides above describe this checkout. The following source-repository material
has a different purpose and is deliberately excluded from the npm package:

- [Implementation PRDs](https://github.com/uchibeke/gallivant/tree/main/docs/prds):
  requirements used to build features, including work with incomplete gates.
- [Plans](https://github.com/uchibeke/gallivant/tree/main/docs/plans): architecture,
  sequencing and release contracts, rather than a list of shipped capabilities.
- [Audits](https://github.com/uchibeke/gallivant/tree/main/docs/audit): dated results,
  exact source revisions, limitations and remaining qualification work.
- [Original source-design notes](https://github.com/uchibeke/gallivant/blob/main/docs/design/sources-and-standards.md):
  historical decisions and proposals with their original context.

For an older installed release, inspect the matching Git tag instead of treating
the current `main` branch as its feature set. Preserve queued PRDs and carried
plans: their bytes can be pinned to a running chain. Record new implementation
behavior in the operator guides and new evidence, rather than rewriting a
historical test result or silently changing an approved task.
