---
status: ready
harness: codex
---

# Make YAML plans usable from a local install

## Problem

The installed CLI can validate and preview nested YAML plans, but the standalone coordinator has no operator authority bound to it and leaves graph capacity at zero. An operator can review a valid plan and still have no supported way to queue it. Ship a one-time local setup that makes the CLI usable on its own and gives the standalone and mounted dashboards a shared approval service.

## User stories

- As a local operator, I want a guided setup and one exact plan approval, so that dependent tasks can run while I am away.
- As an operator using Codex or another qualified route, I want workers confined to their approved tasks, so that they cannot queue or alter a plan under my identity.
- As a maintainer, I want setup, failures and recovery to be explicit, so that I can enable the feature on a supported installation and keep current runs intact.

## Acceptance criteria

- Given an installed package with a normal Gallivant home, when I run `gallivant plan setup --check`, then it reports the selected host, worker route, isolation, approval access, graph capacity and the first missing prerequisite. The check performs bounded reads and probes with zero plan admissions, provider spend or config writes.
- Given a supported local worker route, when I run `gallivant plan setup` as the operator, then the existing coordinator gains a qualified local approval channel and positive bounded graph capacity. Repeated setup uses the same home and owner identity. It reports any required reload, applies changes atomically and preserves active runs, credentials, linear chains and overall and per-repository author limits.
- Given the configured worker launch and coordinator are running, when the worker tries to use the protected operator channel or reach its state, approval credentials, socket and privileged routes, then the deployment proof demonstrates that access is denied through the actual installed boundary. Worker access to the approved checkout, necessary host/provider operations and normal task review and resume still works. Shared UID file modes, loopback address and caller-supplied proof flags are insufficient on their own.
- Given an operator at the local CLI, when I preview a nested YAML plan and run `gallivant plan queue FILE --approve DIGEST` for that exact revision, then the command records one plan using the existing admission service and returns its receipt and plan link. An absent, changed, expired or revoked binding fails before admission. A repeated request returns its original receipt.
- Given a queued plan with a sequence, fan-out and join, when the approving terminal or browser closes and the relevant predecessor PRs subsequently merge into their approved bases, then the coordinator starts only eligible nodes under the saved approval and current limits. Restart recovery preserves the original reservations and evidence. Merge, release and deployment retain their existing authorization.
- Given an installed runtime, operator grant or boundary changes, when it no longer matches the qualification, then the coordinator stops admitting or starting new graph work for that affected scope and shows how to restore qualification. Accepted work still reconciles, and workers with access to the protected plane cannot run alongside its enabled graph routes.
- Given a standalone or mounted tracker has access to the local service, when it obtains a scoped operator session, then it uses the same authority and plan control service as the CLI. Unauthenticated sessions and workers have no mutation authority. Setup and CLI queueing work with the dashboard closed.
- Given the support matrix is published, when a fresh user follows the docs, then the demonstrated installed local Codex route can complete setup, queue and follow a disposable nested plan. Cover macOS for the existing local workflow and Linux in the portable qualification path. Exercise the installed worker boundary and use disposable Git repositories with the existing host fixtures for repeatable tests. Report exact platform and launcher proof per supported route and document unsupported configurations and rollback.

## Implementation boundaries

Reuse the existing plan compiler, `bindPlanOperator`, `planControl`, dispatch capacity and approval and execution ledgers. Add the smallest local operator entry point to that service. Use OS-enforced isolation of the actual worker boundary. Prefer adapting an existing launcher and qualification mechanism where its protection matches the required paths and routes. Use one shared operator/worker contract across macOS and Linux.

Distinguish the operator's one-time admission from the coordinator's continuing authority to execute that approved plan. Refresh proof inside the protected coordinator under the original unrevoked scope. Bind it to the actual launcher and installation and enforce it before effects. Use existing host, repository and task policies. Keep an unqualified install in preview mode with an actionable diagnostic.

Build on the dependency-plan runtime and controls already merged. The standalone setup supplies the boundary that native qualification needs, so this brief can proceed while the existing qualification milestone documents current limitations. Place this brief first in the local YAML plan setup and review chain.

Update README, agent setup, commands, config and dependency plan documentation. Include the short install-to-first-plan flow, failed-setup recovery, support matrix and how to disable new graph dispatch. Use synthetic repositories and an isolated Gallivant home for routine verification. Treat live host qualification as a separately authorized check and describe its status accurately.

## Implementation sequence

Queue these three briefs in order through the existing linear chain on the approved base.

1. [Local YAML plan setup](local-yaml-plan-setup.md)
2. [Task and plan file viewer](task-and-plan-file-viewer.md)
3. [Plan approval links and operator API](plan-approval-links-and-operator-api.md)

## Verify

- `node --test test/local-plan-setup.test.mjs test/dependency-plan-admission.test.mjs test/dependency-plan-dispatch.test.mjs test/dependency-plan-controls.test.mjs`
- `npm run test:install`
- `npm run lint`
- `git diff --check`

## Where to look

- `bin/gallivant.mjs`, `lib/context.mjs`, `lib/commands/up.mjs`, `lib/operator_intent.mjs`
- `lib/dependency_plan_admission.mjs`, `lib/dependency_plan_dispatch.mjs`, `lib/dispatch_capacity.mjs`, `lib/verification_sandbox.mjs`, `lib/learning_qualification.mjs`
- `docs/dependency-plans.md`, `docs/config.md`, `docs/agent-setup.md`, `docs/recovery-qualification.md`

## Out of scope

- A separate hosted service, new account system, public access to the local machine or a second approval store.
- Dashboard layout and shareable approval links. Existing graph setup and CLI operation are the deliverable here.
- Automatic merge, deployment, account changes and live writes without the operator's approved scope.
