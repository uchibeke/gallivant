# Approved learning from repository review feedback

Decision: 2026-10-07. Normative architecture for
[the implementation PRD](../prds/review-feedback-learning.md). This describes a
feature to implement, not an already qualified deployment.

## Product decision

**Gallivant turns review feedback into repository-specific engineering lessons.
You approve what it remembers; future runs receive relevant approved lessons.**

Use external memory and ordinary regression tests, not model training. Reviewers
can be wrong. Recurrence prioritizes a proposal; it cannot authorize it. The goal
is less repeated rework, with measured outcomes, not guaranteed flawless agents.

V1 is portable CLI functionality for Linux and macOS using Node and OpenSSH.
There is no additional GitHub repository, GitHub App, hosted approval service,
Apple framework, hardware purchase, database or second agent loop. A dedicated
encrypted local signing key authorizes exact revisions after human review.
GitHub credentials never provide learning-approval authority.

Scope lessons by GitHub host and immutable repository ID, optionally narrowed to
literal relative project paths. Renames preserve identity; forks and replacement
repositories do not inherit it. No global pool or cross-repository promotion.

## Why this architecture

No single industry standard specifies a self-improving coding harness. This design
combines established signing and change-control mechanisms with researched feedback
memory. The lifecycle and defaults below are Gallivant design decisions.

| Primary source | What supports this decision |
| --- | --- |
| [Reflexion](https://arxiv.org/abs/2303.11366) | Feedback stored as text can improve later attempts without changing weights; its benchmarks do not establish Gallivant effectiveness. |
| [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Persistent notes aid continuity; retrieval should keep context relevant and bounded. |
| [OWASP agentic risks, ASI06](https://genai.owasp.org/download/52117/?tmstv=1765059207) and [prompt injection guidance](https://genai.owasp.org/llmrisk/llm01-prompt-injection/) | Memory can preserve poisoned instructions; formatting is insufficient without independent authorization and limited privileges. |
| [NIST SP 800-53, AC-5/AC-6 and CM-3](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf) | Separate proposing from approving and control changes. This mapping is not a compliance certification. |
| [OpenSSH signing manual](https://man.openbsd.org/ssh-keygen) | SSHSIG supports detached signatures, namespaces and verification against designated signers; use the implementation rather than inventing cryptography. |
| [OpenSSH key format](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.key), [signing implementation](https://github.com/openssh/openssh-portable/blob/master/ssh-keygen.c) and [passphrase handling](https://github.com/openssh/openssh-portable/blob/master/readpass.c) | Encrypted private-key metadata is inspectable. Signing can use an agent or load a private key; explicitly constrain that invocation and its environment. |
| [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) | Canonical JSON provides reproducible bytes for hashing/signing. Follow its constraints and conformance vectors; it is an informational RFC. |

A SHA-256 digest establishes content identity, not approval. A signature establishes
possession of the enrolled key, not the wisdom of a lesson or biometric proof of
human action. The authorization claim additionally depends on the trusted review
process, secret custody and worker isolation described below.

## Trust boundary and portable approval

Keep one learning service with injected storage, clock, GitHub, execution and signer
dependencies. Reuse reviewer trust/transport, task/execution contracts, durable
state and control capabilities. The CLI and daemon call this service; neither
gets an alternative activation path.

Operator-owned per-repository configuration has `off`, `collect` and `apply` modes.
Migration defaults to `off`. Enrollment and mode changes cannot originate from
task branches, PR bodies or worker messages. `collect` can operate before approval
setup. `apply` requires a verified signer and qualified execution isolation.
Expose these modes through `learn configure --repo REPO --mode MODE`; changing
mode uses protected operator configuration, never an unsigned task field. Enabling
`apply` fails before mutation if setup or qualification is missing. Turning learning
off does not erase approval history or silently erase already delivered memory.

| Component | Authority |
| --- | --- |
| Worker / extractor | Supply untrusted observations or candidate data; no signing secret, trust writes or active-store writes. |
| Operator approval CLI | Present an immutable revision preview and invoke the dedicated encrypted key interactively. |
| Coordinator | Verify signatures and scope, commit approved transitions, select context and record its delivery. No private key is needed for these operations. |
| GitHub | Evidence transport and ordinary code review; not approval-key storage or learning authority. |

Use OpenSSH SSHSIG with a dedicated Ed25519 key in encrypted OpenSSH format.
Probe `-Y sign`/`-Y verify` capabilities rather than assuming every system `ssh`
package qualifies. Linux and macOS follow the same code path and schema.
Pin an operator-selected absolute `ssh-keygen` executable outside worker writes;
do not resolve it from a checkout's PATH or accept an executable from a candidate.

`learn setup` runs only when the operator explicitly invokes it in their own
terminal. Create a dedicated key with OpenSSH's bcrypt KDF (initial rounds 100),
requiring a strong, unique, nonempty passphrase. OpenSSH handles secret entry;
Gallivant does not request, log, store or transmit the passphrase. Never reuse the
GitHub login/signing key or add this key to an SSH agent. Refuse existing files
instead of overwriting keys. Validate encrypted format, public-key consistency,
permissions and safe paths before enrollment, then require a signed enrollment
manifest. Do not accept an unencrypted key or a caller-supplied public key as
already trusted. Bootstrap is an explicit operator action, not trust on first
use from worker output.

Approval renders the exact frozen content, evidence and digest in the operator's
terminal before invoking OpenSSH against those same bytes. No shell interpolation,
external pager/editor hooks, ANSI instructions, automatic URL opening or executable
Markdown. Take an explicit review confirmation before the passphrase prompt.
Pass the manifest as a private frozen file; let OpenSSH read its secret from the
operator's terminal, never a Gallivant input stream. Cancel, EOF, no controlling
terminal, wrong passphrase or timeout leaves the active bundle unchanged.

The signing subprocess has a minimal environment: unset agent/askpass/provider and
dynamic-library injection variables, set `SSH_ASKPASS_REQUIRE=never`, and never
pass `-P`/`-N`, an environment secret or piped passphrase for approval. Do not
contact Keychain, `ssh-agent`, gpg-agent, 1Password or a credential helper. A TTY
check is usability, not authorization: an agent can allocate a PTY. The protected
key/passphrase and signature verification are the boundary. Tests must demonstrate
that a preloaded SSH agent and hostile askpass environment cannot bypass it.

Store learning state outside repositories under the configured Gallivant home.
Keep the private key separately in an operator-only approval directory; its
explicit absolute path supports different home layouts and a separate operator
account. Neither location may be a worker-writable directory or symlink. Mode 0700
directories and 0600 files are hygiene, not isolation against the same UID.

**Workers must be unable to modify the trusted CLI/coordinator, enrolled public
key, signer executable, active store or monotonic checkpoint, and unable to read
the private key or observe the operator's terminal.** Use an enforced sandbox,
separate OS account or container boundary. Ordinary GitHub access is irrelevant to
these local permissions. Deny broader credential/terminal access and control routes
that could grant it. Review native escalation and auto-review paths too: a nominal
sandbox with unrestricted privileged commands does not qualify. APort hooks alone
cannot establish protection against arbitrary shell code.

`learn doctor` reports demonstrated capabilities for the actual execution profile,
including write/read denial probes against disposable canaries and configuration
checks. Never exercise attacks against real keys. Unknown or inadequate isolation
leaves that profile collection-only. Other unenrolled work continues normally.
Installing a new untrusted verifier, changing the trust root, disabling checks or
moving the checkpoint is not a learned-rule action. User-authorized software
upgrades require requalification when these boundaries change.

Threat model: hostile feedback and arbitrary code inside the worker's allowed
boundary. Host administrator compromise, stolen passphrases, keyloggers and a
human approving a malicious rule defeat these assumptions. An unrestricted
same-user agent cannot be securely separated by a shell script or local hash.
Document that limit instead of marketing filesystem permissions as sufficient.

## Collection and learning

```text
eligible new review / bounded historical scan
    -> observation journal
    -> bounded extraction and validation
    -> pending candidate and human review
    -> exact signed approval
    -> verified atomic activation
    -> relevant context in subsequent attempts
    -> measured outcomes / proposed revision / signed retirement
```

Keep a separate observation cursor from the live coding-review cursor. Collection
must not acknowledge a finding, spend a coding round, delay its fix, change task
identity or declare completion. Apply existing reviewer identity eligibility;
eligible prose remains untrusted. Edited source text creates a new observation
revision. Deletion/retraction flags stale evidence, not silent changes to an
approved lesson. Resolution, merge, frequency and confidence are evidence signals,
not automatic validation of the original advice.

Record host/repository ID, PR/review/comment IDs, author identity, creation/update
times, content digest, relevant path and original/fix SHAs, source link, disposition
and available regression/CI evidence. Minimize excerpts; never copy entire logs by
default. Scan old PRs by finding update time, including reopened or edited reviews.

Extraction uses existing execution services with a bounded, enforceable data-only
profile, no coding/approval credential and no shell/tool/network actions directed
by evidence. Do not confuse read-only filesystem access with tool-free execution.
Use an eligible configured backend with an explicit learning allowance; if none
can enforce the profile, collection still works and reports extraction unavailable.
Do not silently switch provider or incur paid work from list/show/report.

Candidates contain schema version, ID, revision, repo/project scope, applicability
condition, concise guidance, rationale, counterexample or before/after example,
evidence references, fix disposition, optional existing regression-test reference
and extraction provenance. Explain why the finding is justified and reusable;
insufficient or contested evidence stays pending for review. Suggest test/lint
improvements through ordinary code changes, never executable learned commands.

Deduplicate exact evidence revisions; cluster similar candidates as suggestions.
Show repeated findings, contradicted guidance and overlapping scopes. Combining,
narrowing or editing candidates creates a new revision; it never inherits approval.
Reject feedback with a reason and suppress that exact revision from reproposal;
new evidence may justify a new pending revision. No automatic merging of rules.

JSON is canonical, Markdown a generated review view, CSV at most an export. Validate
closed schemas, lengths, paths, links, nested objects and control characters.
Use RFC 8785 canonical UTF-8 and reject duplicate keys and invalid encodings before
hashing. No candidate-supplied regex, executable check, dependency or arbitrary
URL fetch. Keep pending and raw evidence out of prompts and native auto-memory.
Reject misleading bidirectional/control text in approval fields; never approve a
truncated preview. Store source text as escaped evidence without rendering it as
terminal instructions.

## Operator workflow and state

Illustrative commands below are the CLI contract to implement:

```sh
gallivant learn doctor --repo uchibeke/gallivant
gallivant learn setup
gallivant learn configure --repo uchibeke/gallivant --mode collect
gallivant learn --repo uchibeke/gallivant --since 2026-09-01 --until 2026-10-07 --dry-run
gallivant learn --repo uchibeke/gallivant --since 2026-09-01 --until 2026-10-07
gallivant learn list --repo uchibeke/gallivant --status pending
gallivant learn show lesson-001 --repo uchibeke/gallivant
gallivant learn revise lesson-001 --repo uchibeke/gallivant --from reviewed-rule.json
gallivant learn approve lesson-001 --repo uchibeke/gallivant --revision SHA256
gallivant learn configure --repo uchibeke/gallivant --mode apply
gallivant learn reject lesson-002 --repo uchibeke/gallivant --reason 'Not applicable here'
gallivant learn retire lesson-001 --repo uchibeke/gallivant --revision SHA256 --reason 'Replaced by a regression test'
gallivant learn explain --run RUN_ID
gallivant learn report --repo uchibeke/gallivant
```

`approve` previews, signs and activates in one operation after verification. No
extra publish step or GitHub PR is necessary. Default to one explicit revision;
an explicit batch must enumerate every ID/digest with a complete diff. No wildcard,
approve-all or `--yes` bypass. Evidence, applicability and conflicts must be visible,
not just a hash prompt. Signing freezes content, scope and evidence references.
`revise` validates operator-supplied candidate JSON and creates a pending revision;
it cannot change active content. Approval may prepare an active bundle while mode
remains `collect`; only explicit, qualified `apply` enrollment delivers it to tasks.

| State | Meaning |
| --- | --- |
| pending | Proposed lesson; cannot influence coding context. |
| rejected / superseded | Retained disposition; cannot activate. |
| approved | Exact signed transition verified, awaiting durable activation if interrupted. |
| active | Revision included in the current verified bundle. |
| retired | A newer authorized transition removed or replaced the revision. |

"Delivered" is a recorded attempt event, not a mutable deployed column or proof
the model obeyed. Editing an active rule creates a pending replacement. The old
version remains active until a signed replacement or retirement commits. A local
rejection only affects candidates; it cannot remove or alter active guidance.

## Signature, activation and recovery contract

Use a fixed versioned SSHSIG namespace `gallivant-learning-v1` with exact pinned
signer identity/key. Verify authorization with `ssh-keygen -Y verify`, never
`check-novalidate`. The signed canonical manifest contains type/schema version,
installation authority ID, repository identity, key fingerprint, action, sequence,
previous-manifest digest, exact added/replaced/retired revisions, resulting complete
active-set digest, evidence digests and audit timestamp. Hash every user-visible
rule field. Timestamps alone establish neither approval nor freshness.

Trust the enrolled public key in protected local configuration, not an embedded
key, copied `allowed_signers`, `approved: true`, Git author, task receipt or cached
status. Verify content and signature before writing any active state and again
before using it. Read each immutable revision once, verify and pass those exact
bytes to prompt construction, eliminating verify/read races. Refuse foreign repos,
wrong namespaces, substitutions, unknown schemas and unreviewed batch additions.

One lock, durable journal and atomic writer implement compare-and-swap against
the protected current sequence/parent digest. Record prepared bytes before signing,
then the signature and committed pointer/checkpoint with crash recovery. Concurrent
stale approvals require a new preview; do not silently rebase signed intent.
Retrying the same completed transition is idempotent. A crash after signing can
finish that exact transition only if its expected parent still matches.
Sequences and checkpoints are per installation authority and repository identity;
one repository's approval does not invalidate another's pending transition.

The protected local checkpoint rejects replay of previously signed bundles.
Rollback is a new signed transition, never a pointer decrement. Missing, inconsistent
or unreadable trust/checkpoint state blocks learned-context dispatch; do not bootstrap
from a worker copy or silently revert to no lessons for an `apply` task. No network
authority check is needed: the local coordinator's current store is the authority.

Key rotation requires explicit operator enrollment and signed continuity from the
old key when available. Loss/compromise disables application until explicit recovery
enrolls a new authority and reviews the chosen baseline. Back up encrypted keys
separately from nonsecret audit data; do not automatically import trust or restore an
old checkpoint from a generic repository backup. Local signatures cannot prove
freshness after arbitrary rollback of the whole trusted installation. Document
manual recovery rather than inventing a remote witness service.

## Retrieval, revocation and compatibility

Deterministically choose repository-wide guidance plus literal project scopes
matching approved task paths or observed changed paths. When paths are unknown,
use repository-wide lessons and report exclusions. Initial budget: 20 lessons and
8 KiB per attempt, stable ordering with selected/omitted IDs and reasons.

Inject a labeled advisory section through shared task inputs. Local adapters and
hosted workers launched by this coordinator receive the same verified snapshot.
Record bundle sequence/digest, rule revisions, selection reasons and input digest.
Workers receive no key, trusted mutable store or ability to enlarge that snapshot.
An independent remote coordinator needs its own trusted enrollment; automatic
cross-device synchronization and imported-bundle freshness are outside V1.

No worktree rulebook, `AGENTS.md`, `CLAUDE.md` or native memory becomes managed
approval authority. An ordinary reviewed `AGENTS.md` link may help humans navigate
a generated approved-practices document; it is optional and never rewritten per
run. Ordinary repository instruction risks still exist; this feature does not
claim to authenticate every byte a harness might independently read.

Lessons cannot change tools, permissions, budgets, trusted authors, verification
commands, acceptance criteria, merge policy or APort checks. Preserve all existing
task gates. Run regression tests for practical, enforceable lessons through normal
code review. Guidance alone is not a deterministic behavioral control.

Pin each in-flight attempt. New approvals affect its next dispatch. Retirement
prevents subsequent delivery and uses existing stop/steer capabilities where
supported, recording actual cancellation limits. If native session memory contains
a retired rule, continue in a fresh provider session while preserving logical
task, PR, code and approved continuity context. Never claim old memory was erased.
Disabling `apply` follows the same memory/cancellation rules, while leaving the
approved bundle available for later explicit re-enrollment.

## Bounds, privacy and outcome reporting

Historical defaults: last 30 days, 100 PRs, 1,000 eligible findings and 20 extracted
candidate revisions per invocation; separate timeout/spend limits. UTC date ranges
are half-open. Report pagination, coverage, truncation and continuation; overlapping
scans deduplicate. Respect 429/Retry-After and interrupted scans without resetting
review cursors. Dry-run performs no inference or writes. Automatic observation
shares the scheduler and cannot starve active coding/review work.

Redact secrets/private data before extraction or export, bound payloads, keep
source visibility, and never follow arbitrary links from evidence. Default raw
excerpt retention is 30 days; retain minimized rule evidence and approval/audit
digests until explicit operator deletion. Document what deletion does and does
not remove. Oversized, missing, stale or partially inspected evidence is visible
at review, not silently treated as complete. No secret or passphrase in logs.

Report collected findings, candidate dispositions, actual deliveries, confirmed
versus machine-suggested recurrence, eligible-run denominators, review rounds,
known spend/token usage and latency. Unknown cost is unknown, not zero. Do not
infer zero recurrence from unmatched feedback or causal improvement from different
task mixes. Maintain held-out deterministic fixtures and separately authorized
paired live trials before quantitative effectiveness claims.

## Implementation, documentation and qualification

Reuse the merged shared task/execution foundation on remote `main`. This task can
run in its own `work/review-feedback-learning` checkout alongside plugin delivery;
it does not depend on that PR or start the gated plugin-release milestone. Normal
base reconciliation and full checks handle any later shared-file changes. Do not
install this branch as the running coordinator or restart unrelated runs.

Implement one service and OpenSSH adapter, not a generalized approval-provider
framework. Extend existing config, CLI help, input construction, observation and
reporting seams. Add small focused modules where needed. No new hosted/UI protocol.

Update README's honest pitch, `docs/learning.md`, architecture, guardrails, config,
CLI help and relevant PRD/harness guidance. Include a copyable Linux/macOS walkthrough
for setup, collection, review, approval, first delivery, correction and retirement;
different home paths, dependency installation guidance, signing limitations,
isolation prerequisites, budgets, backup/rotation/recovery and troubleshooting.
Document why hashes/flags/TTYs alone fail and why no extra repository is needed.
Clearly distinguish shipped, tested, qualified and enabled. Test CLI examples.

`test:learning` must cover the full pipeline with real disposable OpenSSH fixtures
alongside deterministic transports, on Linux and macOS. Cover exact and edited
signatures, wrong key/repo/namespace, encrypted/unencrypted keys, loaded agents,
askpass injection, malformed JSON, traversal/symlinks, terminal injection, stale
parents/replay, concurrent approval, interrupted activation, revocation/native
memory, bounded historical scans and gate/cursor compatibility. Demonstrate that
tests detect a deliberately bypassed verifier. Test secrets are disposable and
cannot authorize any production installation; the production signer has no test
mode or environment bypass. Record actual platform results, not inferred passes.

`test:learning:live` is an opt-in qualification using a disposable authority/profile:
denied worker key/trust access, interactive approval of exact bytes, approved
delivery and signed retirement. It must not touch production keys or require paid
inference. Default tests require neither human passphrases nor existing credentials.
Mocked human entry is fixture evidence, never proof a real person approved a rule.

Implementation may finish and open its ordinary ready-for-review PR with offline
checks and explicit UNQUALIFIED deployment status when a live operator or platform
is unavailable. The shipped runtime must refuse `apply` for an unqualified profile.
This distinction avoids stranding coding on a human ceremony while preserving the
real activation gate. Feature implementation does not authorize creating a real
approval key, account changes, production enrollment or installing new software.

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Another protected GitHub repository/App | Extra administration; local signature custody provides the requested independent boundary. |
| Hash, CSV status, confirmation flag or shared GitHub token | Identifies content or caller input, not independently authorized approval. |
| Apple-only signer or mandatory hardware key | Excludes the requested Linux/shell workflow. Hardware support can be evaluated separately later. |
| Cached SSH-agent key or unencrypted private key | Lets an unattended process sign without fresh secret entry. |
| Append all bot comments to `AGENTS.md` | Persists incorrect or malicious instructions without human judgment. |
| Global memory, vector DB, model training or custom crypto | Unnecessary for bounded, repository-scoped approved guidance. |
