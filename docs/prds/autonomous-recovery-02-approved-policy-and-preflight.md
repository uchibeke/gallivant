---
status: ready
harness: codex
sources:
  - docs/plans/autonomous-stall-resolution.md
  - docs/plans/autonomous-recovery-chain.md
aport_decision: 85d4f8d8-8f76-4be5-8214-bb55c70af426
---

# Bind recovery authority to approved policy and preflight

## Problem

An accepted brief can disagree with a cached hook or provider context, and source declarations can accidentally make required implementation files immutable. Missing package access, unavailable models and unwritable Git metadata then waste paid turns. Recovery also needs narrower authority than an operator Resume. Establish protected, revocable admission and coherent preflight before any new recovery recipe can act, preserving the existing isolation and approval architecture across supported platforms.

## User stories

- As a task owner, I want contradictions and unavailable capabilities detected before spending, so that runs start with a coherent executable contract.
- As an operator, I want bounded authority that workers cannot expand, so that recovery cannot turn untrusted feedback into permission.
- As a maintainer, I want one approval revision used everywhere, so that prompts, hooks and execution permissions cannot drift.

## Acceptance criteria

- Given M01 is integrated and an explicit recovery admission, when a profile is validated, then use a closed versioned schema containing protected-store identity, version/revision/digest, off/observe/recover mode, recipe IDs/versions, per-recipe limits, aggregate task mutation/paid limits, route tuples, cleanup roots/classes/retention/byte limits and revocation/hold generations. Each tuple binds harness, provider, model, account, environment, data location, credential reference, capabilities and spending ceiling, never credential bytes. Unknown fields/actions/versions, absent profiles and legacy tasks gain no new mutation authority.
- Given a worker sharing the operator's UID, when protection is evaluated, then mode 0600 alone does not qualify isolation. Reuse the existing outer sandbox and coordinator-only capability boundary to protect profile storage, accepted snapshots and completion administration. Qualify the effective boundary per execution adapter; unavailable isolation leaves that combination observation-only. Do not add a separate authority repository, require Apple-only tooling or silently move secrets into worker-readable config.
- Given a new recovery decision, when shared service admission runs, then validate a closed `RecoveryDecision` with version, enumerated recipe/action, typed operator-intent or admitted-recovery-intent, expected binding/revision, preconditions, operation key, deadline, budget reservation and postcondition. Existing owners enforce the type at the effect boundary. Automatic callers cannot forge Resume/enable, resnapshot, explicit failed-paid-repair acceptance, output exceptions, credential/context/learned-rule changes or protected-path grants through a shared helper. No diagnostic accepts arbitrary executable shell strings.
- Given cancellation, dispatch stop, disabled repository, active control, unknown ownership or a persisted scoped hold, when admission is attempted, then fence the targeted mutation. Persist provenance and monotonic hold generation across restart; only explicit corresponding operator Resume/enable clears it. Profile narrowing/revocation immediately fences queued reservations and uses existing reconciliation/cancellation for accepted work. Revalidate revision and ownership with compare-and-set after awaits and immediately before effects. Chain holds/cancellation fence future claims, leaving admitted children subject to their own controls.
- Given an approved task revision, when a new turn is prepared, then hook policy, provider context, prompt, publication rules and route derive from the same contract/source/profile/publication digests. Reproduce the stale-cache-after-resnapshot incident and incorporate already-landed fixes instead of duplicating them. Worker edits cannot substitute for the accepted snapshot. Only stale derivations may be regenerated automatically; changing authority still requires the operator.
- Given explicit implementation targets intersect carried `sources`, when intake/ready preflight runs, then report the exact contradiction before paid dispatch. Do not infer edit authority from extensions, remove sources or add `publish_files` automatically. Validate exact exceptions and protected paths. Newly tracked base collisions receive a diagnostic; moving/restoring private context remains M04's journaled operation. Hosted context uses only a preapproved private compatible transport, never publication as a workaround.
- Given a proposed author route, when preflight runs, then check host/repository/PR access, harness/model entitlement, explicit package auth, tool/runtime versions, writable Git metadata, required browser surface and scratch bytes/inodes on actual mounts. Reuse existing credential and preparation services. Synthetic verification/reviewer lanes receive no production secrets, package credentials stay opt-in and completion credentials stay coordinator-owned. Missing access yields actionable redacted diagnostics without environment dumps, repeated billable probes or installing/replacing global runtimes.
- Given existing stopped tasks, when inventory is requested, then produce a read-only adoption proposal bound to exact task/snapshot/profile/run/ownership digests. Exclude holds/cancellation, unknown acceptance/ownership, changed requirements and intentional human gates. Define explicit reviewed batch admission and versioned atomic migration with coherent registry, referenced execution/review records and immutable-history backup. This milestone supplies schema and dry run; activation and downgrade qualification remain M06.
- Given negative and race fixtures, when tests run, then prove untrusted comments/logs, edited snapshots, stale controls, profile swaps/revocation during preparation and every operator-only helper fail closed. Document supported protection boundaries, profile/command schema, setup/preflight and migration dry run in shared recovery/config/guardrail/agent documentation, with absent legacy profiles observation-only.

## Implementation boundaries

Extend current intake, ready, preparation, controls and ownership services; reuse M01 observations. No extra control API or duplicate provider policy. Keep `ready --check` validation-only without config/auth/network side effects. Profiles authorize specific actions, not general execution. Defaults and CLI names must be documented once and consumed by UI/help rather than maintained independently.

Bind the M06 qualification manifest's protected reference, exact digest, evidence root and permitted fixture actions through this same admission boundary. A worker-supplied file or CLI selector is not authority. Define how the admitted task resolves that binding without copying secrets into its snapshot; M06 must consume it rather than invent another approval system.

Represent qualification-only intents as admitted-recovery-intent with a closed enumerated qualification purpose/capability and exact protected manifest reference/digest, never operator-intent or access to operator-only helpers. This separate disposable eligibility permits bounded capability tests before general qualification, requires baseline isolation/ownership, and grants no production/legacy recovery rights. No generic test-mode bypass is permitted; destructive primitives first need isolated fault/native proof.

Create `test/recovery-authority.test.mjs` and `test/recovery-preflight.test.mjs`. Include real service-boundary negative tests, approved snapshot refresh integration, capability qualification and revocation races; schema-only tests are insufficient. Protect other agents' checkouts and global settings. Do not enable recovery on production or legacy tasks during this milestone.

## Verify

- `node --test test/recovery-authority.test.mjs test/recovery-preflight.test.mjs test/execution-preparation.test.mjs test/control.test.mjs test/review.test.mjs`
- `npm run lint`
- `git diff --check`

## Where to look

- `lib/commands/`, `lib/control.mjs`, `lib/execution_preparation.mjs`
- `lib/tick.mjs`, `lib/work_artifacts.mjs`, `lib/state.mjs`
- `docs/prd.md`, `docs/config.md`, `docs/guardrails.md`, `docs/commands.md`

## Out of scope

- Automatic authority widening, global credential changes or blanket legacy adoption.
- Executing new recipes before their implementation and capability qualification.
- Replacing native isolation with file permissions or platform-specific approval tooling.
