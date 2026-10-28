---
status: ready
harness: claude
sources:
  - docs/prds/natural-language-tasks.md
  - docs/tasks.md
  - docs/task-delivery.md
  - docs/prd.md
aport_decision: 02381f6d-2363-463a-8345-7397b53b08e2
---

# Replace free-text delivery parsing with reviewed task profiles

## Problem

Natural-language intake currently tries to decide, with an expanding collection of text patterns, whether a request asks Gallivant to publish work or only implement a product feature. Small wording changes have repeatedly caused unsafe false negatives and false positives, and the same parser is vendored into Agent Passport. A parser fix can therefore break both repositories and strand saved tasks. Preserve the user's original intent without treating prose or model output as authority: draft a traceable PRD with the existing selected harness or a capped APort-funded text model, let the owner review it, and take delivery permission only from an explicit typed profile. Reuse Gallivant's existing readiness, execution, review and completion paths.

## User stories

- As a task owner, I want to describe a desired outcome in ordinary language, so that Gallivant can prepare a complete, reviewable PRD without requiring me to learn its format.
- As a task owner, I want every material request clause mapped to a criterion, assumption or clarification, so that generated prose cannot silently drop constraints.
- As a task owner, I want to choose a typed delivery target before execution, so that model wording cannot grant publication, merge or deployment authority.
- As an operator, I want preparation to use an already connected harness or a spend-capped APort model route, so that users do not need a separate API subscription to try intake.
- As an Agent Passport maintainer, I want the shared validator to consume the same versioned structured contract, so that Pages preflight and the private runtime cannot drift.

## Acceptance criteria

- Given an original natural-language request and a selected repository, when intake prepares a task, then the source text is immutable and each material request clause has a stable source reference mapped to a generated criterion, an explicit assumption, or a clarification question.
- Given an available connected harness, when the owner chooses that route, then Gallivant uses its existing harness dispatch and session controls to draft the PRD without requesting a second provider key or creating a new runner; it records provider-reported usage or labels cost unknown rather than claiming zero.
- Given preparation needs codebase context, when the selected repository is inspected, then Gallivant supplies only a bounded, read-only snapshot of approved repository metadata/context, excludes secrets and ignored/private files, and pins its digest to the prepared revision; inability to collect safe context is reported instead of guessed.
- Given no usable connected harness and an enabled APort-funded model route, when intake drafts a PRD, then provider adapter, model, trusted endpoint and budget profile come from validated operator environment/configuration and can be changed without source edits; none is hardcoded or task-selectable. Missing or unsupported configuration disables the route with an actionable message. No task can exceed three model calls, 50,000 input tokens and 6,000 output tokens per call, or a reserved $0.10 model-spend allowance. The route stops before starting a call that would exceed its configured allowance and reports billing uncertainty honestly. It uses no web, shell or repository-write tools.
- Given a model-produced draft, when it is returned, then the normal Gallivant PRD checker and `gallivant ready` decision path validate it; output includes the exact requirement map, generated brief, assumptions, unresolved questions, selected model route, reported usage and spend status. Failed validation never starts implementation.
- Given preparation completes, when any harness is used, then the operation can only return draft/questions/clarification and cannot modify repository files, create branches, or start implementation; the user must separately approve the validated revision before the existing run path is callable.
- Given the request asks to wait for review, open a PR, merge, deploy or perform another external action, when the owner selects the delivery profile, then the saved contract records a versioned action, target and completion condition separately from the PRD prose. A request or model response alone cannot expand that profile; merge and deployment require explicit supported controls and authorization.
- Given the selected delivery profile conflicts with a material request clause or an unresolved requirement changes scope, permissions, cost or completion, when the owner reviews the draft, then intake pauses with a specific clarification and does not start a harness run until the owner resolves it.
- Given a clear draft and delivery profile, when the owner approves and starts it, then the existing Gallivant readiness, start, review, fix-round and completion flows run exactly once, with idempotent retries and the approved PRD/profile revision pinned to the task.
- Given a task is prepared, when the owner reviews it, then the UI and MCP/API response show the immutable request, clause-to-requirement map, open questions, assumptions, draft PRD, typed delivery action/target/completion condition, harness, allowance, model route and cost/unknown status in one revision-pinned review; changing any material input invalidates readiness and requires review again.
- Given model or harness output is malformed, incomplete, contradictory, exceeds a configured limit, or omits a source clause, when validation runs, then the draft is rejected or returned for clarification with a bounded actionable error; it never silently falls back to legacy free-text authorization or starts implementation.
- Given a task or ownership contract was created under a historical parser/profile version, when it is inspected, resumed, upgraded or exported, then it retains its original interpretation and can be safely controlled; new tasks use only the new typed profile, and unsupported old state fails closed with an actionable recovery path without stranding an idle namespace.
- Given deterministic request fixtures for direct, indirect, quoted, contradictory, adversarial and ordinary product-feature wording, when intake tests run, then the approved typed profile controls all external effects, all material constraints remain traceable, and no test requires a paid model call.
- Given the implementation is packaged for Agent Passport, when its exact vendored artifact and generated validator are checked, then byte identity, schema version, upgrade behavior and matching task-intake regressions are verified before either repository's PR is approved.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:task-intake`
- `git diff --check`

Include deterministic adversarial fixtures, per-clause traceability checks, typed-profile authorization tests, revision invalidation and retry/idempotency tests, historical task fixtures, token/call-budget boundary tests and a bounded-input performance test. Ordinary verification makes no provider calls. An opt-in live qualification may measure generated-PRD quality and actual cost; its total allowance is capped at $0.10 and it cannot alter repository delivery permissions. Report the corpus, pass denominator, false-accept/false-reject cases, latency distribution and actual provider-reported or explicitly unknown cost; do not infer quality from one happy-path sample.

## Cross-repository delivery and ship gate

This feature is not shippable in the APort plugin when only this Gallivant change is merged. The repository boundaries are separate, and Gallivant's PRD chains cannot coordinate work across repositories. Complete the companion Agent Passport PRD `task-intake-vendor-sync` in `aporthq/agent-passport` after this implementation is merged and its immutable package is published. That downstream work must pin the exact package, regenerate the bundled Pages preflight and task runtime together, prove artifact/source identity and old-task compatibility, then follow Agent Passport's `feature branch -> staging PR -> sandbox qualification -> main PR` release order. Do not merge the APort adapter ahead of the Gallivant package contract it consumes.

The release is complete only after the APort staging deployment passes browser onboarding, repository selection, intake/review, readiness, one bounded task execution and saved-result recovery through the actual plugin surface, with authorization, logs and cost evidence reconciled; the separate Agent Passport `task-journey-ux` PRD must also be merged and qualified before production promotion. Production enablement and the production plugin package then follow APort's existing release gates. If either repository is blocked, report the exact repo/PR, package digest, test or live gate, and remaining owner action. Do not call a Gallivant-only merge plugin-ready.

## Where to look

- `docs/prds/natural-language-tasks.md` and `docs/tasks.md` define the existing intake contract and user flow.
- `docs/prd.md`, `lib/prd.mjs` and `lib/sources/prd.mjs` define readiness and brief validation.
- `lib/owner_delivery.mjs` currently classifies delivery intent; replace its new-task free-text authorization role with the typed contract while preserving historical validation.
- `lib/execution.mjs`, `lib/run.mjs`, `lib/state.mjs` and `lib/control.mjs` own existing dispatch and task lifecycle behavior.
- `task-runtime` and the Agent Passport shared validator are a downstream consumer; keep their exact source/artifact synchronization and staging-first workflow.
- The required Agent Passport companion is `docs/prds/task-intake-vendor-sync.md` in `aporthq/agent-passport`; execute it only against the exact merged Gallivant package from this PRD.

## Out of scope

- A new runner, queue, server, harness launcher, plugin transport, or duplicated task lifecycle.
- Automatic merge, deployment, external communication, spending, or other side effects inferred from prose or model confidence.
- Treating a decision-only model as a prose generator, training a model, mandatory user API keys, unlimited retries, or paid provider calls in CI.
- Changes to Agent Passport production authorization or deployment in this Gallivant PR.
