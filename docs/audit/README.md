# Audit and qualification records

These are recorded observations, not installation instructions or a current
capability registry. Read each report's date, source revision, test command and
environment before applying its findings. A historical “not implemented” or
“unavailable” describes that audit; a passing fixture proves only what that
fixture exercised. The [operator guides](../README.md) describe current behavior.

| Evidence | Scope |
| --- | --- |
| [Original audit brief](BRIEF.md), [decisions](DECISIONS.md) and persona reviews in this directory | Early product/specification review; the original `PRD.md` was renamed `SPEC.md` |
| [PR #2 review](PR-2-REVIEW.md), [pre-review audit](PRE-REVIEW-AUDIT.md), [structure](STRUCTURE-AUDIT.md), [PRD compliance](PRD-COMPLIANCE.md) | Findings against the revisions named in each report |
| [Harness validation](harness-live-validation.md), [directory fix](harness-live-validation-directory-fix.md) | Actual local harness/provider/model combinations, bounded retries and unresolved access limits |
| [Runtime portability](runtime-portability.md) | Native and fixture evidence for the recorded runtime and operating systems |
| [Preparation boundary](preparation-context-boundary.md) | Restricted drafting, selected context and inherited configuration controls |
| [Review learning](learning-qualification.md) | Collection, signature/lifecycle tests and remaining production isolation requirements |
| [Task, execution and plugin evidence](plugin-ready/README.md) | Separate milestone records and checklists for intake, remote adapters, package consumers and live-release gates |
| [Plugin launch assessment](plugin-launch-2026-10-08.md) | Dated release assessment, not proof of a current public deployment |
| [Published onboarding](published-onboarding.md) | Documentation audit against the 0.2.0 release: reference READMEs read, stale claims found, what changed and what still needs a release or live validation |

Keep failures, unverified criteria and original measurements visible. Add a dated
follow-up when a later change resolves a finding rather than replacing the old
result. Logs under an operator's temporary directory may no longer exist; their
paths are historical pointers, not portable instructions for a new installation.
Never commit credentials or raw private task logs as evidence.

Current limits are explicit in [Codex Cloud](../codex-cloud.md),
[OpenAI Agents API](../openai-agents.md), [learning](../learning.md) and
[task delivery](../task-delivery.md). An implemented adapter, local fixture pass,
live provider pass, deployed service, installed-host qualification and published
release are separate claims. These records are intentionally excluded from the
npm distribution; use the source revision or matching release tag to inspect them.
