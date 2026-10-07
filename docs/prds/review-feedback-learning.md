---
status: ready
harness: codex
sources:
  - docs/plans/review-feedback-learning.md
aport_decision: 2a46d424-1bc2-437e-8b8b-7ae3290caf00
---

# Learn from approved repository review feedback

## Problem

Gallivant fixes review findings but does not preserve validated lessons for later tasks. Operators repeatedly pay for similar corrections, while blindly copying reviewer suggestions into instructions would preserve mistakes and prompt injections. Build repository-scoped learning with human review, portable local approval, relevant context and honest outcome reporting. New and historical feedback must share one bounded pipeline without weakening coding, review or completion gates.

## User stories

- As an operator, I want lessons proposed from new and historical reviews, so that recurring corrections become reusable knowledge.
- As a maintainer, I want to review and approve exact revisions locally, so that fallible advice cannot silently become policy.
- As a contributor, I want relevant project guidance in subsequent attempts, so that unrelated lessons do not change my task.
- As a security owner, I want workers excluded from approval authority, so that compromised sessions cannot deploy their own rules.
- As an operator, I want observable outcomes and retirement, so that learning remains useful and reversible.

## Delivery contract

The carried architecture is normative. Implement governed external memory with a dedicated passphrase-encrypted OpenSSH signing key and exact signed revisions. Linux and macOS use the same CLI/service. No additional repository, GitHub App, Apple-specific dependency or hosted approval service. A hash identifies content; only signatures from the enrolled key authorize activation. Worker isolation must protect the key, verifier, trust root and checkpoint; same-UID file modes or TTY presence alone are insufficient.

Reuse merged task, execution, GitHub, persistence and control services. Scope by repository ID and optional project paths; JSON is canonical and Markdown a view. Learning defaults off. This brief permits implementation in an isolated checkout based on remote main, concurrently with plugin delivery. Preserve other runs and the plugin chain gates. Do not create production approval keys, enroll this device, change accounts or install the development branch as the coordinator.

## Acceptance criteria

- Given eligible new feedback, When collection runs, Then shared reviewer trust/transport records bounded source revisions, identities, timestamps, SHAs and dispositions; independent observation cursors never acknowledge coding feedback, spend rounds or delay fixes.
- Given historical reviews, When `gallivant learn --repo` runs with dates or dry-run, Then the same collector handles pagination, edits/deletions, old PR updates, duplicates, restart and rate limits, reports coverage and caps, and performs no inference or writes during dry-run.
- Given observations, When bounded extraction runs, Then an enforceable data-only execution profile produces validated pending candidates with applicability, guidance, rationale, examples and evidence; unavailable isolation preserves collection and reports extraction unavailable. Repeats or confidence never approve.
- Given candidates, When list/show/reject or revision review runs, Then one service safely displays exact text, scope, evidence, conflicts and digests; deduplication and rejection dispositions persist, and edits/combined candidates create new unapproved revisions.
- Given operator setup on Linux or macOS, When `learn setup` and `learn doctor` run, Then portable OpenSSH capability probes, encrypted dedicated key enrollment and actual isolation checks establish the boundary; missing prerequisites refuse activation, and key creation requires explicit interactive operator action.
- Given exact selected revisions, When `learn approve` runs in the operator's terminal, Then a complete immutable preview precedes uncached passphrase signing; pinned OpenSSH, a minimal environment and authorized-key verification reject unencrypted keys, agent/askpass bypasses, forged flags and changed content. Cancellation changes nothing.
- Given a signed transition, When activation or recovery runs, Then canonical content, namespace, enrolled signer, repository, parent/sequence and active-set digests are verified atomically; stale/replayed approvals, substituted trust roots, extra batch rules and verify/read races cannot activate. Rollback requires a new signed transition.
- Given approved lessons, When a qualified local or coordinator-managed hosted attempt starts/resumes, Then shared inputs deterministically supply bounded relevant guidance and record exact bundle/rule/input digests plus omissions; pending or foreign content never becomes managed context.
- Given learned advice or repository instructions, When consumed, Then lessons cannot change permissions, tools, budgets, trust, Verify commands, acceptance criteria, merge policy or APort gates; optional reviewed AGENTS navigation is neither authority nor an automatic rewrite.
- Given replacement or retirement, When the operator signs its exact transition, Then later dispatches exclude retired revisions and existing control capabilities handle active attempts honestly; stale native memory requires fresh-provider continuity preserving the logical task, code and PR.
- Given hostile worker/evidence inputs, When adversarial tests exercise CLI, service, filesystem and control routes, Then key/trust access, hidden commands, forged signatures, malicious terminal text, cross-repository paths, rollback and gate edits are refused by the real boundary; unsupported profiles remain collection-only.
- Given concurrency, crashes or lost replies, When retrying collection, approval or dispatch, Then durable journals, atomic persistence and exact revision keys prevent duplicate transitions, partial activation or lost dispositions without resetting task/review state.
- Given privacy/resource bounds, When storing, extracting or exporting evidence, Then minimization, redaction, retention and separate learning budgets apply; incomplete evidence and scan coverage are disclosed, arbitrary links execute nothing and list/report cannot start paid work.
- Given outcome inspection, When explain/report runs, Then delivered context, candidate dispositions, confirmed versus suggested recurrence, denominators, known costs and latency are traceable; held-out fixtures check regressions and no unmeasured effectiveness claim is made.
- Given implementation qualification, When deterministic and disposable OpenSSH tests run, Then the lifecycle and bypass regressions are exercised with recorded Linux/macOS evidence; an opt-in live qualification checks actual isolation and approval. Unavailable live evidence is explicitly UNQUALIFIED and blocks production apply, not the implementation PR.
- Given documentation and migration, When operators follow the delivered guides, Then README, learning, architecture, guardrails, config and CLI help explain learning through retirement, portable setup, limits, backup/rotation/recovery and qualification; existing runs remain compatible and activation stays off by default.

## Verify

- `npm test`
- `npm run lint`
- `npm run test:learning`
- `git diff --check`

Add `test:learning` with deterministic integration/adversarial fixtures and real disposable OpenSSH interoperability checks. Add opt-in `test:learning:live` without production keys or paid inference. Test observation, extraction, review, signature verification, activation, dispatch, restart and retirement; demonstrate bypassed verification fails the security suite. Default tests need no human interaction. Record missing platform/live evidence accurately and keep affected profiles unqualified.

## Where to look

- `docs/plans/review-feedback-learning.md` for architecture, commands, threat model, lifecycle, bounds and primary sources.
- `README.md`, `docs/architecture.md`, `docs/guardrails.md`, `docs/config.md` and `docs/prd.md`.
- `lib/gh.mjs`, `lib/events.mjs`, `lib/tick.mjs`, `lib/credential.mjs`, `lib/context.mjs` and `lib/state.mjs`.
- `lib/tasks.mjs`, `lib/execution.mjs`, `lib/harness.mjs`, `lib/start_contract.mjs`, `lib/prompt.mjs`, `lib/control.mjs` and `bin/gallivant.mjs`.
- `test/security.test.mjs`, `test/events.test.mjs`, `test/tick.test.mjs`, `test/execution-backends.test.mjs` and `test/recovery.test.mjs`.

## Out of scope

- Global rule sharing, weight training, vector databases, autoapproval, automatic AGENTS edits, executable learned commands or a second agent/review loop.
- New approval servers, GitHub authorities, native OS signers, mandatory hardware keys, custom cryptography or a generic signing-provider framework.
- Cross-device authority synchronization, new dashboard/chat UI, production key/permission changes, paid effectiveness trials or launching gated unrelated milestones.
