# Recovery qualification

The source baseline for this work is `26ef01b24126551aeac34ef871d6b26dfc8b2e73`,
which includes the first five recovery milestones. The qualification entry
point records the source commit and tree, a digest of the actual code and test
bytes, package version and lock digests, Node version, OS and architecture.
It records registry schema 3 and version 1 profile, decision, observation,
execution, journal, qualification and recipes. A protected run also binds the
approved manifest digest and exact recovery profile.

## Evidence and limits

| Scope | Result and evidence |
| --- | --- |
| Offline faults and replay | All 102 required tests passed. The macOS ARM64 fixture aggregate passed 147 tests on both Node 22.22.0 and Node 24.15.0. The report digests are `3e9246aed38686d0b612a592c32280eaed53fc96cc1ccdba382f85f62644f72e` and `db5dc78137cfe0095b331081eb6845247264953536b7f9d222d228caff073f2b` in that order. Both record checkout `28b6ee2ca34b0c667e77476f9c831f31c6d893dc` and tested code digest `ad75a49b304b056c5baf2ea6a7854c540095d446274748143aa12dbdbbdc6ade`. [Fixture aggregate](../scripts/qualify-autonomous-recovery.mjs) |
| Native Linux and macOS | Unvalidated. This task's protected registry contained no pinned qualification manifest. `--native` exited 1 with `RECOVERY_QUALIFICATION`. A macOS ARM64 Node 22.22.0 fixture run exercises real local process and Git calls. It has no admitted environment or independent supervisor receipt. |
| Live GitHub, Bitbucket private and Bitbucket public | Unvalidated. `--live` exited 1 at manifest admission. Repository access for implementation and a local Chromium 145.0.7632.6 PNG capture were observed separately. The selected disposable repository bindings, route entitlement, and any required installed host or capture behavior still need owner proofs. |
| Overnight recovery and a true authority gate | Unvalidated. `--overnight` exited 1 at manifest admission. The operator needs separately approved exact cases and maintenance scope. |
| Evidence and activation | `--check-evidence` exited 1 at manifest admission. No operational or semantic canary was admitted. All unvalidated combinations stay in observation mode for new recipes. |

The fixture commands prove only their isolated contracts. They cover owned
intent and execution replay, unknown submission, delayed or absent final
results, Git commit and push acknowledgements, private context backups,
verified publication, delivery, owned deletion, and successor claims.
Authority fixtures cover holds and revocation during preparation, changed
snapshots and bindings, hostile input, reviewer piece and synthesis output,
unverified cancellation, and independent maintainer evidence. The resource
fixtures exercise bytes and inodes, retained inputs, shared cooldowns, fair
lanes, healthy long-running tools, and a live lease and a proven-dead lease.

Reviewer fixtures cover refusal at both launch checks. A proven pre-dispatch
refusal restores preparation with the original job, deadline and allowance.
An unresolved launch acknowledgement keeps its original execution for
reconciliation.

The machine-readable inventory pairs each shipped harness with GitHub,
private Bitbucket and public Bitbucket and lists six owners separately. It
includes exact fixture labels where covered and records other rows as
unvalidated. The owners are author and PR publication, first-party review,
verification, preparation and intake, delivery and cleanup, and the
coordinator's chain claim.

| Route | Continuation, cancellation and resource boundaries |
| --- | --- |
| Local Claude, Codex, Gemini, OpenCode and Goose | Native session continuation and owned process-tree cancellation. Exact session, protected state isolation and a bound launch receipt are required. Claude exposes a provider budget flag. Other local adapters do not expose the same hard cost cap. |
| OpenAI Agents | Hosted native-session continuation with exact job, turn and account. Cancellation requires an authoritative provider outcome. Private input and result collection use their own evidence and allowance. |
| Codex Cloud | Observation of owned hosted jobs only. The catalogue records successor-task continuation and lacks confirmed cancellation and qualified dispatch. |
| First-party review and intake | Review is a separate qualified Codex lane with exact source and head evidence. Intake uses the selected preparation boundary. Neither receives author Git credentials. |
| Verification, delivery and chain | Verification uses a platform-specific sandbox. Delivery and chain claims use durable ownership and terminal host evidence. Cleanup requires exact directory, reference and journal proof. |

The scheduler fixtures use two different workloads. The retention fixture
uses 25,000 settled records, 13 due host items and four host slots. It reports
p50/p95/p99 cycle time of 100/200/200 ms and queue delay of 800/1050/1050 ms on
its controlled clock. The aggregate's two-scan workload uses 24 continuously
eligible host entries and 12 slots, with 10 simulated milliseconds of I/O per
entry. All entries received their first service within two scans. Across 20
cycles, p50/p95/p99 were 120/120/120 ms for simulated cycle time and
60,110/60,110/60,110 ms for queue delay.
There is no live false-recovery rate or validated live capacity target yet.
The canary requires a measured healthy sample, its workload and capacity,
queue and cycle percentiles, and a false-recovery count. Ordinary diagnosis
must fit inside two structural scans plus the measured I/O bound at that
capacity. Host or provider outages have no fixed wall-clock target.

## Running qualification

From the exact source checkout, run the offline suite with the configured
Node runtime. Its cases are synthetic and require no host credentials, model
inference or installed browser plugin. Some local fixtures require native
process inspection and disposable Git repositories. Routine PR CI discovers
the focused Node contracts. The heavier phases are separate opt-in jobs.

```sh
node scripts/qualify-autonomous-recovery.mjs --fixtures
```

An operator selects a dedicated disposable task that pins a protected recovery
profile. Put the approved manifest at the path determined by its reference.
For `manifest:example`, this is `manifests/example.json` under the profile's
canonical `evidenceRoot`. Keep it and the evidence on the protected volume
outside Git. The profile pins its canonical JSON SHA-256 digest and explicitly
allows the isolation action and each permitted qualification mode. A task
selector chooses an existing admission.

```sh
export GALLIVANT_QUALIFICATION_TASK='ORG/REPO/TASK'
node scripts/qualify-autonomous-recovery.mjs --native
node scripts/qualify-autonomous-recovery.mjs --live
node scripts/qualify-autonomous-recovery.mjs --overnight
node scripts/qualify-autonomous-recovery.mjs --check-evidence
```

The manifest contains version 1, purpose `disposable-synthetic-recovery`,
the exact `artifact` from the qualification build, `limits`, independent
`signers`, and a complete `cases` list. Its execution window, evidence expiry,
paid turns and spend are explicit. An execution window bounds effects, and
evidence retains its own validity period. For each case, bind its task and
operation digests, approved route digest, platform, architecture, Node and
environment digest, start and deadline, spending ceiling and paid turns.
For host cases also bind repository identity and immutable host ID, visibility,
credential reference, disposable head/base refs and branch prefix, exact
head/base SHAs, static patch digest, external actor and approved review routes,
capture requirement, injected fault and claimed recipes. Use the approved
fixture refs and synthetic data. Overnight cases bind at least six hours of
unattended observation and include a separate stopped authority gate. The
closed manifest and receipt contracts are in
[recovery_qualification.mjs](../lib/recovery_qualification.mjs).

Install the independent fixture owner in the protected coordinator embedding
before requesting effects. It supplies `baselineFor` and `reconcileCase` to
the qualification entry point. The baseline proves the actual launch,
including isolation, exact operation ownership, the selected model and review
routes, relevant host and capture behavior, and allowance enforcement. Pass
the revalidation callback through to the existing effect boundaries. A
pending or uncertain result stays with its original case operation. Separate
Linux and macOS owners record actual process identity, cancellation, cleanup,
journal recovery and verification isolation. A separately configured
supervisor supplies its own dead-lease, pinned executable and throttle proof.
[Opt-in runner](../lib/recovery_qualification_run.mjs)

Independent owners capture canonical execution, host, review, verification,
delivery and chain observations. Their Ed25519 keys sign the canonical
receipt digest. Only public keys belong in the approved manifest. The
observation field is a digest reference into the corresponding protected
owner's records. `fixtures.json`, `cases/<case-id>.json` and `aggregate.json`
must agree on the approved case bindings and aggregate digests. Receipt
checking reads these exact files and verifies every expected mode and case.
Missing, stale, partial, changed or cross-case evidence returns a nonzero
gate. Keep raw sessions, private keys and authoritative manifests on their
owned volumes.

An independent maintainer integrates an approved static fixture. The host and
maintainer receipts must agree on the repository identity, PR, refs, pinned
head/base and patch digest, and the host must prove the merge on the intended
base. The shipped adapters have no automatic fixture driver with host-enforced
head and base comparison at merge time. The runner waits for the external
maintainer gate.

## Rollout and rollback

Select the recovery profile explicitly for new work. Existing work can only
be adopted from its exact reviewed inventory.

1. Use `gallivant recovery inventory PROFILE` to get the proposal digest and
   eligible task IDs. Review the snapshot, profile and execution bindings.
   The approval document contains `version`, `proposalDigest` and
   `candidateIds`. Keep that document and the backup outside Git.
2. Stop the coordinator normally. Apply the reviewed batch with
   `gallivant recovery adopt PROFILE APPROVAL.json ABSOLUTE_BACKUP_PATH`. The
   path must be fresh, canonical and outside the state and worktrees. The
   registry changes atomically after a durable private backup of the old
   registry and the selected tasks' referenced snapshots, ledgers and history.
3. Use `gallivant recovery canary APPROVAL.json` with `version: 1`, the
   `profile` digest, the current `generation` (0 initially), `stage`,
   explicit registry IDs in `tasks`, `combinations`, `evidence` and
   `qualificationTask`. Start at `observe` with empty combinations and
   null evidence and qualification task. Review observed operation counts and
   health before approving the next stage.
4. Admit `operational` with the separate qualification task and exact
   aggregate and combination digests emitted by the evidence checker.
   Advance the same reviewed task batch and evidence to `semantic` with
   another operator approval. The active recipe still needs the exact
   launch proof, including its artifact and platform. Both stages require
   zero duplicate submissions, unsafe takeovers, lost work and false healthy
   terminations. A failed or missing live case leaves the stage gated.

Use `gallivant why HANDLE` to inspect the task, `gallivant recovery disable
profile/ID GENERATION` to fence new recovery effects, and `gallivant cancel
HANDLE` to request cessation of active work. An observe stage with a newer
generation also fences new automatic recipes. Accepted collection and
cancellation records remain with the same owner. A remote result collected
during a hold stays pending through restart. Releasing the hold resumes
publication from that result. If a maintainer has already merged the exact PR
into the approved base, closeout can proceed during the hold and preserve the
collected output. Retiring a live author requires a fresh merge proof while the
task's recovery scopes permit cancellation. A cancellation accepted before a
hold keeps its original settlement path.

Before a runtime change, stop new intake, let accepted operations and cleanup
settle, and inspect `gallivant recovery drain`. Use the matching emitted
`runtime.json` with `task-delivery-state check` and `backup` to verify the
complete namespace. An older artifact refuses version 3. Keep using a
compatible artifact for that state. To roll back to an older artifact, restore
a matching pre-adoption backup into a separate namespace only after
reconciling all newer work. Keep the live namespace and its records until
the operator verifies the replacement. [Runtime backup and restore](release-qualification.md)
