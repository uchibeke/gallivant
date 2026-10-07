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
scans resume the unfinished source kind and page within a PR; immutable evidence
revisions deduplicate overlap. Each page saves minimized findings and continuation
together, including pages containing only ineligible comments. Deletion is deferred
until the complete source has been enumerated. Required review context is minimized,
retained only through inline enumeration, and subject to the 30-day excerpt limit.
When `--until` is omitted, retries reuse the incomplete scan's original date window,
including after restart; completion allows the next invocation to open a fresh window.
Dry-run uses the same transport and eligibility rules but writes no learning state
and runs no inference. A source page reserves up to 200 eligible events (100 comments
and their review summaries), so an invocation can stop below the 1,000-finding cap.
Transport and parsing share a 64 MiB ceiling for each 100-item page before body
minimization. The 10,000-observation/context-identity storage bounds and continuously
moving upstream pagination can still leave coverage incomplete; inspect the report
before assuming full history was collected. No evidence link is opened or fetched.

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
Configuration persists the last-resolved visibility for automatic observation after
restart. Legacy identity-only records remain readable; repeat `learn configure
--repo owner/project --mode collect` to refresh their unknown classification.

`learn configure --repo owner/project --mode off` uses the stored identity and invokes
local revocation controls even when GitHub, credentials or the remote repository are
unavailable. Enabling collection or application still resolves the remote identity.

Extraction currently reports unavailable. The service seam bounds a separate
allowance (maximum $1 per extraction), 30 seconds and 20 candidate revisions. It
persists an intent/reservation before invoking an injected data-only execution
dependency. An unresolved result is not automatically retried. No installed
production extractor currently implements that boundary; `dataOnly` metadata is not
an operator configuration option. List/show/report/explain cannot launch paid work.

## Approval workflow contract and prerequisites

These commands describe the intended workflow; **the deployment stages below refuse
today's unqualified profiles**. Do not run setup as a coding worker, install this
development branch as the coordinator or create production keys to test it.

OpenSSH must support both `ssh-keygen -Y sign` and `-Y verify`. `learn doctor` probes
these operations with a disposable key rather than relying on a version string.
Choose an absolute protected executable (default `/usr/bin/ssh-keygen`). Linux
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

Activation checks canonical RFC 8785 bytes, SSHSIG namespace, enrolled signer,
repository identity, sequence/parent, evidence and complete active-set digests.
History, pointer and checkpoint commit through one fsynced atomic rename under the
existing process-identity lock. A stale signature requires another preview; rollback
is another signed transition. Hashes and timestamps alone authorize nothing.

Shared dispatch selects at most 20 lessons and 8 KiB, in stable ID order. Literal
project scopes match supplied task paths. The current dispatch hook supplies unknown
paths, so only repository-wide guidance would be selected. It records bundle/rule,
original input, managed input and context digests plus omissions; actual delivery is
recorded after an accepted attempt ID exists. Pending and foreign material never
enters managed context. Retirement fences later delivery and uses existing
cancellation capabilities with honest confirmation limits. If old native memory
contains retired advice, resume refuses and preserves task, PR and code. Automatic
fresh-provider continuation remains to be implemented; old memory is not erased.

Accepted run ownership, feedback cursors and pending delivery audit records are
saved together before writing to the learning store. If that store is locked or
unavailable, coding continues with its pinned context and the registry retains
the exact repository/input/run tuple. Coordinator ticks retry up to ten pending
records per entry, including after restart or completion. Lost replies are safe
to retry; an older audit cannot replace a later attempt's pinned context. A pending
audit warning means reports may temporarily omit that delivery, not that its worker
failed to start. Preserve the registry as well as the learning store during recovery.

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
