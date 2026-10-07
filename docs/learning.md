# Learning from reviewed feedback

The repository-scoped learning service collects eligible feedback and keeps exact
candidate revisions for human review. A digest identifies content. Only an enrolled
Ed25519 OpenSSH signature can authorize an activation transition. Advice remains
advisory: it cannot change task scope, Verify commands, acceptance criteria, tools,
permissions, budgets, merge policy, reviewer eligibility or APort gates.

**Deployment status: UNQUALIFIED, collection only.** This implementation includes
the collector, review service, OpenSSH verifier, transition journal and shared input
seam. Installed coding adapters do not yet enforce an outer boundary protecting
learning authority from arbitrary worker code and privileged/control routes. No
configuration boolean, hash, file mode, approval flag or TTY enables application.
Setup, extraction and apply refuse that missing prerequisite. Fixture qualification
in tests is dependency injection, never a production enrollment mechanism.

The normative [architecture](plans/review-feedback-learning.md) describes the full
delivery contract. Several implementation requirements remain outstanding; the
[qualification record](audit/learning-qualification.md) distinguishes tested behavior
from those gaps. This release makes no effectiveness claim.

## Collection and review on Linux and macOS

Use Node 22+, the configured `gh` credential and the existing operator configuration
with `trusted_authors` and `reviewer`. Eligible prose is still untrusted data.
Repository identity is GitHub host plus immutable numeric repository ID; a fork or
replacement repository cannot inherit lessons by reusing an owner/name. This first
transport supports github.com; enterprise hosts are refused.

```sh
gallivant learn configure --repo owner/project --mode collect
gallivant learn --repo owner/project --since 2026-09-01 --until 2026-10-07 --dry-run
gallivant learn --repo owner/project --since 2026-09-01 --until 2026-10-07
gallivant learn list --repo owner/project --status pending
gallivant learn show lesson-validation --repo owner/project --revision SHA256
gallivant learn reject lesson-validation --repo owner/project --revision SHA256 --reason 'Contested correction'
gallivant learn report --repo owner/project
gallivant learn prune --repo owner/project
```

Replace owner/project, IDs and digests with actual results. Dates are half-open UTC
dates. The default window is 30 days, with 100 PRs, 1,000 eligible findings, 60 API
pages and a 60-second collection deadline per invocation. PRs are scanned by update
time, including old PRs. Separate learning cursors never acknowledge coding events,
consume review rounds or change task identity. Automatic observation runs after
coding/review dispatch and does no extraction. A full source enumeration is needed
to flag deletion; filtered automatic reads cannot establish absence.
The automatic lane rotates a window of at most 100 due watched entries, independently
of request completion order. Idle progress ticks retain the next window.

Coverage, caps, continuation and rate-limit retry time are reported. Interrupted
scans resume the unfinished source kind and page within a PR. PR listing passes
retain their page cursor across invocations and skip persisted completed PR identities.
A pass that discovers new identities triggers another pass from page one to catch
PRs moved ahead of its cursor; completion requires a pass with no new identities.
Both passes respect the 60-page invocation budget and retain progress beyond page
60. The completed identity set remains capped at 10,000. Immutable evidence
revisions deduplicate overlap. Each page saves minimized findings and continuation
together, including pages containing only ineligible comments. Deletion is deferred
until the complete source has been enumerated. Required review context is minimized,
retained only through inline enumeration, and subject to the 30-day excerpt limit
from its stored observation timestamp, independently of a future scan endpoint.
Legacy buffers without a trustworthy observation timestamp are redacted on read or prune.
When `--until` is omitted, retries reuse the incomplete scan's original date window,
including after restart; completion allows the next invocation to open a fresh window.
Dry-run uses the same transport and eligibility rules but writes no learning state
and runs no inference. A source page reserves up to 200 eligible events (100 comments
and their review summaries), so an invocation can stop below the 1,000-finding cap.
Transport and parsing share a 64 MiB ceiling for each 100-item page before body
minimization. The 10,000-observation/context-identity storage bounds and continuously
moving upstream pagination can still leave coverage incomplete; inspect the report
before assuming full history was collected. No evidence link is opened or fetched.
Pruning uses the remembered immutable identity and removes expired local excerpts
even when GitHub is unavailable. Reconfiguration refuses a different resolved ID;
identity persistence also refuses replacement, preserving offline disable ownership.
Recovery uses the remembered immutable repository identity and signed local state,
so retrying revocation controls does not depend on GitHub availability. Verified
committed removals retry their controls even after qualification is lost; prepared
transitions still require qualification before activation. Batch
approval rejects multiple revisions of one candidate before preview or signing.

`revise` validates closed-schema JSON and creates an unapproved revision:

```sh
gallivant learn revise lesson-validation --repo owner/project --from reviewed-rule.json
gallivant learn show lesson-validation --repo owner/project --revision SHA256
```

The review view contains exact text, applicability, literal project scopes, rationale,
example, evidence, fix disposition, overlap/repetition suggestions and digest. It is
escaped JSON, without a pager, executable Markdown or automatic URL opening. Editing
or combining evidence never inherits approval. Exact rejected revisions remain
suppressed. Contradictions require human judgment; repetition is a suggestion, not
validation. Copying guidance to AGENTS.md is optional ordinary reviewed navigation,
never enrollment or an automatic per-run rewrite.

Resolved source visibility is retained in evidence separately from immutable
repository identity; unavailable classification is reported as unknown. Dismissal
and deletion flags retain their first observed timestamp without changing evidence
hashes. Retracted evidence remains inspectable and is excluded from extraction.
Configuration persists the last-resolved visibility. Before storing automatic
observations, the post-dispatch collection step revalidates the immutable repository
ID and refreshes classification; a name replacement or lookup outage skips learning
without altering coding feedback. Identity checks share a five-second batch budget
and one lookup per repository per batch. Skips are logged and later ticks rotate
the bounded observation window. Legacy identity-only records remain readable.
Use historical collection to cover feedback missed while identity lookup was
unavailable; advancing coding cursors do not promise an automatic learning retry.

`learn configure --repo owner/project --mode off` uses the stored identity and invokes
local revocation controls even when GitHub, credentials or the remote repository are
unavailable. Enabling collection or application still resolves the remote identity.
If revocation controls fail after the mode is saved, repeat the disabled-mode
command: both `off` and `collect` retry controls even when the mode is unchanged.

Extraction consumes stored evidence using the remembered immutable identity and
does not authenticate to GitHub or resolve the remote repository. With an
unqualified installed profile it reports unavailable even during a GitHub outage.
The service seam bounds a separate
allowance (maximum $1 per extraction), 30 seconds and 20 candidate revisions. It
persists an intent/reservation before invoking an injected data-only execution
dependency. Each intent reserves its exact observation revision digests; later
invocations select the next unreserved batch, including after restart. Unresolved
batches remain reserved and are not automatically repurchased. Legacy exact-batch
digests acquire revision keys when the same bounded input is encountered. No installed
production extractor currently implements that boundary; `dataOnly` metadata is not
an operator configuration option. List/show/report/explain cannot launch paid work.

Restricted task preparation now supplies shared native tool/context controls that
a future extraction adapter can reuse. It does not connect the learning extractor
or qualify ordinary coding workers, signing authority or control routes. The
[merged-boundary assessment](audit/learning-qualification.md#merged-preparation-boundary-assessment)
records the reusable pieces, remaining integration work and external qualification
requirements. Preparation fixture results do not enable production learning.

## Approval workflow contract and prerequisites

These commands describe the intended workflow; **the deployment stages below refuse
today's unqualified profiles**. Do not run setup as a coding worker, install this
development branch as the coordinator or create production keys to test it.

OpenSSH must support both `ssh-keygen -Y sign` and `-Y verify`. `learn doctor` probes
these operations with a disposable key rather than relying on a version string.
Choose an absolute protected executable (default `/usr/bin/ssh-keygen`). The file
and every ancestor must be owned by root or the operator, with no group/other
write permission. A root-owned sticky temporary ancestor is permitted only above
a private trusted directory; the executable's immediate parent must never be
group/other-writable. These checks run on each pin, including after enrollment.
They do not isolate a worker running as the operator: that still requires the
qualified outer boundary. Linux
operators can install their distribution's `openssh-client`; macOS operators use
their system OpenSSH or an operator-installed portable build. Changes to the pinned
binary require requalification. The offline suite additionally uses Python 3 for
disposable PTY entry; it never asks for a human passphrase.

```sh
gallivant learn doctor --repo owner/project
gallivant learn setup --key-path /absolute/operator-approval/learning-ed25519 --ssh-keygen /usr/bin/ssh-keygen
gallivant learn approve lesson-validation --repo owner/project --revision SHA256
gallivant learn configure --repo owner/project --mode apply
gallivant learn explain --repo owner/project --run RUN_ID
gallivant learn retire lesson-validation --repo owner/project --revision SHA256 --reason 'Replaced by a regression test'
gallivant learn recover --repo owner/project
gallivant learn configure --repo owner/project --mode off
```

`GALLIVANT_HOME` can locate nonsecret state in another operator-owned home. The
private key has a separate explicit absolute path, supporting a separate account.
Both directories must be outside worker writes, without symlinks; approval directory
0700 and key 0600 are hygiene only. An enforced OS/container/account boundary must
also protect CLI/coordinator code, public trust, signer, active store and monotonic
checkpoint; deny private-key/credential/terminal access; and exclude privileged and
control routes that could escape it. Same-UID modes and APort hooks alone do not
qualify arbitrary shell execution. Current native escalation and hosted profiles
remain unsupported for production learning application.

When qualified, explicit interactive setup would ask OpenSSH to create a dedicated
Ed25519 key using bcrypt with at least 100 rounds, refuse existing files and
unencrypted keys, validate the public envelope and sign an enrollment manifest.
Choose a strong unique nonempty passphrase. Do not reuse GitHub signing/login keys
or load the key into an agent. Node never requests or stores the secret.

Approval freezes a complete preview, including every selected/removed revision and
evidence, then takes a separate explicit confirmation before fresh OpenSSH signing.
There is no `--yes`, wildcard, approve-all, alternate activation command or unsigned
flag. Signing uses a pinned executable and minimal environment: agent, askpass,
provider and dynamic-loader variables are absent; `SSH_ASKPASS_REQUIRE=never`.
An optional `--reason` on `learn approve` appears in the immutable preview and signed
transition as an audit explanation.
Cancellation or failed signing changes no active content. Signed prepared intent
may be recovered only against its exact current parent. The CLI currently selects
one revision per invocation; explicit batches are available only to the shared
service and enumerate every ID/digest in the preview.
`learn recover` also retries controls for committed retirements and replacements
from verified signed history, without signing or activating another transition.
Recovery verifies obsolete signed preparations whose sequence was already consumed
and moves them to a protected audit archive, then continues eligible preparations.
It never rebases an old signature. Invalid signatures still fail closed. The archive
retains exact signed bytes and disposition, is capped at 1,000 records, and its count
appears in `learn report`; older stores migrate the empty archive without read-time
writes. Include it in the same protected-store backup as approval history.

Activation checks canonical RFC 8785 bytes, SSHSIG namespace, enrolled signer,
repository identity, sequence/parent, evidence and complete active-set digests.
History, pointer and checkpoint commit through one fsynced atomic rename under the
existing process-identity lock. A stale signature requires another preview; rollback
is another signed transition. Hashes and timestamps alone authorize nothing.

Shared dispatch selects at most 20 lessons and 8 KiB, in stable ID order. Literal
project scopes match validated repository-relative paths from inline review events,
carried task files and the approved brief path. Up to 200 unique paths are selected
in stable order; invalid/absolute/traversing paths are excluded. The pinned paths
carry forward into resume, and unknown paths still omit project-scoped guidance.
It records bundle/rule,
original input, managed input and context digests plus omissions; actual delivery is
recorded after an accepted attempt ID exists. Pending and foreign material never
enters managed context. Retirement fences later delivery and uses existing
cancellation capabilities with honest confirmation limits. If old native memory
contains retired advice, ordinary resume refuses and preserves task, PR and code.
After the existing run settles, explicitly run `gallivant resume <handle> --fresh-session`. This saves a retryable transition and starts a new provider session
with the approved brief, current task/PR context and current approved advice. It
preserves checkout, branch, cursors, iteration, operation history and cumulative
allowance. Unconfirmed cancellation and unrelated stop fences remain blocking;
a provider returning the retired session is refused. Old memory is not erased.
When learning is `off` or `collect`, this fresh-session transition clears advice
locally without a learning-related GitHub lookup. Any independently required
provider or coding-workflow credentials still apply.

Prepared advice records the owning task before launch. Admission rechecks mode,
revocation and signed active revisions under the learning lock and holds that lock
through provider acceptance. Retirement or disable racing that launch reports a
busy operation and must be retried; it has not committed a stop. Once committed,
revocation also reaches accepted execution intents before registry publication.
Retired prepared inputs stay fenced across restart and re-enabling application.
The accepted-delivery outbox retries unconfirmed cancellation without redispatch.

Accepted run ownership, feedback cursors and pending delivery audit records are
saved together before writing to the learning store. If that store is locked or
unavailable, coding continues with its pinned context and the registry retains
the exact repository/input/run tuple. Coordinator ticks retry up to ten pending
records per entry, including after restart or completion. Lost replies are safe
to retry; an older audit cannot replace a later attempt's pinned context. A pending
audit warning means reports may temporarily omit that delivery, not that its worker
failed to start. Preserve the registry as well as the learning store during recovery.

A failed enrollment signature retains the newly created encrypted key and a protected
`enrollment-intent.json` containing only its identity, path and pinned signer metadata.
Setup prompts, key creation and signing run outside the global store lock. Each
write reacquires it and checks that the pending intent and authority are unchanged.
Retry `learn setup` with the same key path: it verifies the exact encrypted key and
signer, previews the pending enrollment and requests fresh signing. Cancellation
preserves the pending intent; substituted keys, paths or signers are refused. The
intent remains audit metadata after success and cannot replace an enrolled authority.
Include it in the protected-state backup; keep encrypted private keys separately.

## Privacy, backup and recovery

Raw excerpts are bounded to 2 KiB, redacted and escaped before persistence. Source
SHA-256 digests identify the full source without retaining it. Never copy complete
logs or secrets into candidates. Invalid controls, bidirectional text, paths,
schemas, duplicate JSON keys and encodings are refused. A configured application
cannot fall back to an unsigned or foreign bundle when trust/checkpoints fail.

Raw excerpt retention is 30 days; collection/observation mutations and `prune`
remove expired observation excerpts, and read-only inspection hides them immediately.
Minimized signed evidence, hashes, disposition and approval history are retained.
Deletion cannot remove copies in backups, GitHub or already delivered provider
memory. Review views disclose expired, superseded, deleted and incomplete evidence.
Back up encrypted keys separately from nonsecret state. A generic repository backup
must never bootstrap trust or move an approval checkpoint backward.

Rotation and lost/compromised-key recovery are not yet implemented as commands.
Disable application, preserve the journal and use explicit operator-reviewed
re-enrollment/continuity once supported. Do not replace authority.json or restore an
older checkpoint to simulate rotation. Local signatures cannot prove freshness after
arbitrary rollback of the entire protected installation; V1 has no remote witness.

Reports separate confirmed recurrence from evidence-count suggestions. Known cost
is traceable; unresolved usage is unknown, not zero. The delivered-run denominator
does not yet cover every eligible coding attempt, and review-round/latency outcome
correlation remains outstanding. Different task mixes cannot establish causal
effectiveness. Held-out deterministic cases and real disposable OpenSSH bypass tests
check regressions; separately authorized paired live trials would be required for
quantitative effectiveness claims.

## Qualification and troubleshooting

```sh
npm run test:learning
npm run test:learning:live -- --qualify
```

The first command makes no paid calls and enrolls no production authority. The
second is opt-in and probes disposable key/trust/verifier/checkpoint canaries plus
terminal and local-control access using OS isolation. When those probes pass, it
requires interactive creation/enrollment of a temporary encrypted key, exact approval,
context consumption by a process enclosed in that same profile, and signed retirement.
All keys/state are deleted afterward and no paid inference runs. Production stays
UNQUALIFIED even after that disposable ceremony: installed worker launch/control
integration is still outstanding. Actual ceremony evidence was unavailable in this session.

On macOS, `sandbox_apply: Operation not permitted` means the host cannot create the
required nested sandbox from that execution surface. Run the probe from an operator
terminal where sandbox-exec is permitted. On Linux, `/usr/bin/bwrap`, functioning
user/PID/network namespaces and a dedicated Node installation are prerequisites.
Neither fix alone enables production apply; the actual installed execution profile
still needs integration and qualification. Never weaken the boundary to turn a
test green. Normal unenrolled coding runs keep their existing behavior.


Delivery audit storage is limited to 1,000 exact operation records per repository
and 16 KiB per newly prepared record, including context, paths and omissions.
Reports disclose usage and limits. At capacity, new advice-bearing operations fail
before launch; existing retries, delivery acknowledgements, pruning, retirement,
and disabling remain available. Records are not silently evicted: prepared
revocation targets, exact retry identities, digests and accepted-run denominators
remain intact. Automatic archival is not implemented; do not delete audit records
or reset the store to bypass capacity. Disable application to continue without
advice while preserving the protected audit backup.

Approval confirmation and passphrase entry run without the shared store lock.
The service rechecks the complete frozen preview, mode, parent, sequence and trust
root after each interaction; concurrent changes require a new reviewed approval.
Extraction candidates may cite only evidence included in that reserved batch.


Extraction reserves exact observation revisions durably before releasing the store
lock for external execution. Other repositories and emergency disable can mutate
state during that wait. Results merge into newly loaded state only if the original
reservation is unchanged; disabled collection or stale evidence refuses candidate
insertion. A failed merge leaves the reservation intact and does not authorize
repeat inference. Known returned cost and token counts remain recorded even when
a concurrent change prevents accepting the proposals.


Delivery path audit details retain an encoded JSON sample of at most 2 KiB,
plus `pathAudit.digest`, `count` and `omitted` for the full accepted path list.
Rule selection still considers every accepted path, including those omitted from
the stored sample. Managed inputs retain the full list; the audit digest allows
that exact list to be checked without duplicating it in every delivery record.

The executable selected with setup's `--ssh-keygen` is pinned in protected
enrollment metadata and reused by later CLI and daemon services without another
flag. Pending enrollment retries also reuse that pin. Each cryptographic use,
including doctor probes, checks the exact executable path and digest before
execution; a changed or missing binary requires restoring the pinned installation
or separately reviewed requalification. Local collection and emergency disable
do not require resolving or executing the signer.


Omitted-rule audits retain at most 1 KiB of encoded detail, further reduced to
fit the delivery record's remaining byte budget. `omissionAudit` records the full
ordered list digest, total count, unsampled count and counts by omission reason.
Rule selection still traverses the entire verified active bundle; the sample does
not change relevance or context limits. Exact selected rule references and the
bundle digest remain available alongside this summary for audit reconstruction.
