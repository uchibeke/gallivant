# Gallivant tasks, hosted harnesses and plugin delivery

Owner direction: Uchi, 2026-10-04, America/Toronto. Implementation repository:
`uchibeke/gallivant`. This is the shared implementation contract for six PRDs,
not evidence that any capability described as required already exists.

## Outcome and execution order

Describe work naturally, resolve material unknowns, produce verifiable requirements,
pass the existing readiness gate, and run through Gallivant's existing GitHub
review/completion loop. Users choose local Codex, OpenAI Agents API or Codex Cloud;
existing other harnesses retain their current support status. A plugin calls this
same workflow and can be updated with Gallivant without copying its implementation.

Implement in this order, merging each predecessor before starting its successor:

1. [Natural-language tasks](../prds/natural-language-tasks.md): reusable intake and task service.
2. [Execution foundation](../prds/hosted-codex-harnesses.md): shared lifecycle, durable polling and logs, preserving local execution.
3. [Agents API](../prds/openai-agents-harness.md): managed sessions, native continuation and code/artifact transport.
4. [Codex Cloud](../prds/codex-cloud-harness.md): supported Cloud submission, reconciliation and review continuation.
5. [Plugin delivery](../prds/gallivant-plugin-delivery.md): package exports, MCP adapter, shared UI and repeatable packaging/upgrade tests.
6. [Live release qualification](../prds/gallivant-plugin-release.md): working deployment, installed-host evidence and the submission bundle.

These briefs use `harness: codex` to implement Gallivant, inheriting the operator's
existing model/settings. That is separate from the new runtime choices being built.
No model default or live installation setting changes are part of these PRDs.
Do not run the milestones in parallel. The existing `gallivant chain` command
provides the merge barrier; it is not another implementation project.

Freeze these briefs and this carried contract after queueing. Gallivant's chain
pins their bytes and source hashes; implementation changes to them can stop later
steps. Only the current brief and its declared sources are required inputs; roadmap
links to later milestones are not missing-source blockers. Put implementation documentation and evidence in other files. Queue once,
never separately start the first step. Each PR still needs human review/merge.
After merging runtime changes, update the operator checkout and use the existing
safe daemon restart procedure when its code stamp is stale; preserve active runs,
chain state and snapshots. Do not assume a running Node process reloads new code.

The public UX target is install, connect an account and selected GitHub repos,
choose an available execution provider, then describe work. No local Gallivant
installation or running laptop is required for a correctly configured hosted
deployment. Provider eligibility and credentials remain real prerequisites.
Plugin installation itself supplies neither GitHub authority nor paid inference.

The owner's parallel question was whether this can build features directly from
ordinary ChatGPT chat without another subscription. Chat is a supported entry
point, but the service receives explicitly selected requirements/resources, not
the full chat log or another connector's credentials. It must not reconstruct
conversation history or depend on ChatGPT invoking another plugin to complete
its own public tool. Supply required GitHub/execution dependencies within the
authorized Gallivant service. Keep identity, repository authority, runtime access
and payment source separate in capability checks.

Native Codex Cloud already supports development under an eligible user's plan;
Gallivant adds its requirements and bounded review workflow. Agents API calls
have separate costs, even if a future Gallivant service absorbs them for users.
Do not promise an extra subscription is mandatory, zero-cost execution, or
automatic use of ChatGPT allowance. The native host/skill route is useful context,
not a fourth execution backend added to these milestones.
[Plugin boundaries](https://developers.openai.com/plugins/plugin-guidelines),
[native plan availability](https://learn.chatgpt.com/docs/pricing).

## Audit baseline and deployment distinction

Code audited at `5066462` on 2026-10-04. These are observed gaps, not shipped changes:

| Existing behavior | Required change and owner |
| --- | --- |
| `lib/run.mjs` owns a PID, `job.json` and `job.log` | M2 adds remote execution identity and liveness without breaking local runs. |
| `lib/probe.mjs` requires a binary; `up.mjs` skips the whole tick if any configured harness probe fails | M2 scopes failures to affected dispatches and bounds remote I/O. |
| `lib/tracker/stream.mjs` reads the whole log repeatedly despite a 400-line initial tail | M2 adds efficient bounded reads, cursors and backpressure; M5 consumes them. |
| `lib/harness.mjs` resumes a local Codex thread | M3 preserves API sessions; M4 records Cloud native/successor continuity honestly. |
| GitHub feedback, completion receipts, snapshots and chains already exist | All milestones reuse these; no second workflow engine. |
| Packaging architecture alone proves neither deployment nor directory readiness | M6 requires observed live results and exact candidate artifacts. |

Two operating modes share the same code. In CLI mode, Gallivant's coordinator runs
on the operator's computer and sends coding work to a remote provider; no public
APort hosting is needed. It must be running to poll and advance review rounds.
In the self-contained ChatGPT experience, a reachable HTTPS MCP service exposes
that coordinator and its durable state, so no user's laptop must stay on. The
coding worker remains the selected OpenAI backend. A plugin ZIP contains the
connection, skills and UI resources/configuration; it does not supply free hosted
compute or install a persistent daemon into ChatGPT.

Ship a runnable service artifact and deployment instructions without choosing or
purchasing a hosting vendor on Uchi's behalf. The production hostname, support
route, service account/worker setup and live-test allowance remain unresolved.
Uchi questioned the hosting/cost assumption; no hosting purchase or API allowance
has been granted. Resolve concrete release setup through the operator when M6
needs it. CLI/backend development and offline validation can proceed meanwhile.

## G1: one implementation and one task identity

Extend Gallivant in this repository. CLI, tracker, Command Center and plugin are
clients of exported task operations, not separate orchestrators. Keep readiness,
source snapshots, feedback selection, base handling, budgets, review freshness,
completion decisions and notifications canonical. Extend an execution boundary
only where local-process assumptions prevent remote execution. Do not extract a
separate runner repository, copy the daemon into Wealth Experiments, introduce a
second agent/model loop, or require Command Center to execute this product.

Use a durable logical task ID with separate intake, implementation, turn and
provider IDs. Preparation is not implementation. Provider completion is not PR
readiness. Preserve `ready-for-human`, `needs-human` and merged/closed meanings;
"until done" stops at those existing human/review boundaries and configured limits.
Never auto-merge, deploy, spend without an execution allowance, or silently switch
provider to make a job finish. A draft followed by a resumed intake must not create
two implementation jobs.

Current sources of truth include `lib/prd.mjs`, `lib/commands/ready.mjs`,
`lib/deliverable.mjs`, `lib/tick.mjs`, `lib/control.mjs`, `lib/chains.mjs`,
`lib/state.mjs`, `lib/harness.mjs`, `lib/run.mjs`, `lib/git.mjs`, `lib/gh.mjs`,
`lib/commands/status.mjs`, `lib/commands/why.mjs` and `lib/commands/serve.mjs`.
Some architecture prose is stale; inspect code and tests before changing behavior.
The tracker already accepts queued controls, and harness names already derive
from the adapter registry. Do not reintroduce parallel registries.

## G2: natural-language intake

Add `gallivant task` with text or stdin input and a reusable structured interface.
Support explicit repository, base, harness, selected context and request identity.
Default to preparing a reviewable draft; `--run` grants execution within supplied
scope/limits when material requirements are resolved. It must not require a second
approval for work already authorized. A material unresolved requirement instead
produces concise questions and a resumable intake record. Noninteractive callers
receive structured questions, not a hanging stdin prompt. Expose answer/resume
operations usable by both CLI and MCP.

Read relevant selected repository instructions and existing test commands. Preserve
the original request, answers, assumptions and requirement-to-criterion mapping.
Every explicit requirement must be represented or surfaced as a conflict; neither
the planner nor a validator-repair turn may quietly remove an inconvenient one.
Generate the canonical PRD with stories, Given/When/Then criteria, real Verify
commands, sources and exclusions. No template-filled placeholders or generic
test command for the wrong stack. Readiness checks structure; they are not evidence
that generated requirements are correct or implementation tests already passed.

Use existing harness facilities for bounded preparation with a structured output
contract, not a second inference client in the intake code. Keep preparation
writes in an isolated draft area; no implementation, PR or main-branch mutation.
Allow at most three validator-repair turns under the same preparation allowance.
Call the actual ready/check and decision functions, surface denials, and start
only the resulting exact approved revision through existing start semantics.
Changing an accepted contract uses existing divergence/resnapshot behavior.
Preserve the hand-authored PRD path and source-carrying behavior without requiring
uncommitted source documents to exist on remote main.

## G3: execution contract and harness choice

Expose `codex`, `openai-agents` and `codex-cloud` as distinct harness selections.
Use capabilities for authentication, environment preparation, submit, inspect,
continuation, events, result retrieval and cancellation. Keep CLI start/resume and
their session formats compatible. An API adapter needs no fake binary path/PID;
a completed cloud submission subprocess does not mean remote work completed.

Persist provider IDs, environment, source revision, effective model when reported,
event cursor and dispatch intent before acknowledging an operation. Serialize
per-task mutations; survive duplicate events, lost replies and daemon restarts.
Use provider idempotency where documented. When acceptance of a submission is
unknown and cannot be reconciled, stop visibly instead of creating another paid
task. Unknown status/cost is unknown, not success/zero. Backoff is bounded.

Selection must show availability, authentication mode, continuation behavior,
cost source and unsupported controls before dispatch. Preserve existing defaults.
Provider-specific model or environment selections are validated and recorded;
unsupported options fail rather than silently falling back. Never transplant a
session ID from one provider into another.

Local APort hooks and filesystem restrictions do not automatically protect a
managed environment. Report actual enforcement capabilities. If configured
mandatory policy cannot be enforced by the selected backend, refuse dispatch
with the missing capability; never silently drop it or describe a completion
receipt as equivalent to pre-action authorization.

### G3a: polling, liveness and logs

One coordinator owns dispatch and provider reconciliation. A UI refresh, MCP
status request or second subscriber reads saved state; it must not create another
provider poller or paid call. Distinguish provider progress polling from GitHub
review polling. Configure their cadence, request deadlines, bounded concurrency,
backoff/jitter and retry-after handling. Scope authentication/probe failures to
affected accounts/providers: an unavailable local binary must not block an API
task, provider result recovery or unrelated GitHub review work. A slow request or
long event stream cannot hold the entire daemon tick open. Preserve dispatch
safety checks for each affected task and never overlap review rounds.

Record observed time, last successful reconciliation, next attempt, provider state,
local workflow state and specific recovery action. Cover queued/provisioning,
running, waiting for input, retrieving results, failed, cancellation requested,
cancelled and status unknown. Silence, stale cache, webhook delivery failure,
launcher exit and an API idle state are not proof of success or a stalled task.
Reconcile at startup and periodically even when event/webhook delivery looks
healthy. Required actions are bound to current task/turn/call IDs and authorized
actors; arbitrary provider requests never become an unvalidated shell tool.

Store a versioned normalized event journal and compatible `job.json`/`job.log`
projection in the existing per-run layout. Carry logical task, provider job,
session/turn, event ID/cursor, timestamp, provenance and event type. Separate
coordinator messages, provider output, tool summaries, usage and result retrieval.
Deduplicate replay; preserve ordering within documented scopes. Do not duplicate
every delta across multiple canonical stores. Flush recoverable checkpoints before
acknowledging operations. Redact secrets before public logs, UI or model context;
access-controlled sensitive diagnostics, if retained, have explicit expiry.

Keep the tracker and Command Center SSE/history contracts compatible, including
stable replay IDs, initial bounded tail, older-history pagination, heartbeats and
disconnect cleanup. Remote streams use persisted execution state, not local PID
existence. Implement seek/indexed or incremental reads rather than rereading a
growing log in full every second. Bound response bytes, buffered events and browser
DOM; honor backpressure. Rotation/retention or unrecoverable provider gaps must
produce an explicit gap marker, not renumber old event IDs or imply full history.
Task results remain discoverable independently of terminal logs.

Measure large-log reads and slow/disconnected subscribers in deterministic tests:
assert bounded bytes read/buffered for a tail/history window and that unrelated
task inspection/control still progresses. Document the tested limits. This is
targeted run-log verification, not a new general benchmark project.

## G4: OpenAI Agents API

Implement the documented managed Codex harness API, not a Responses-only imitation
or the Agents SDK's separate agent loop. Support an OpenAI-hosted environment,
repository setup, immutable brief/source delivery, session/turn events and further
input to the same session. Use scoped service credentials outside generated code;
do not inherit this assistant's connectors or credentials. Configure dependencies,
network access, protected credentials and durable artifact retrieval explicitly.

Retain source revisions and code/artifacts outside the ephemeral sandbox. Reconcile
the remote branch before applying new work; recover an expired environment only
through documented provider behavior and verified saved code/context. If that is
unavailable, report a recoverable blocked task rather than claiming the old session
or filesystem survived. Tests must cover cancellation, required actions, stream
loss, auth expiry, rate limits, failed setup and an idle session with a failed turn.

Subscribe before sending work. Only the recorded root turn's terminal outcome
settles implementation; subagent completion and stream closure do not. Reconnect
by buffering a new stream, retrieving session/turn state and paginated saved items,
restoring by item ID, then reconciling buffered events. Final text replaces its
partial text instead of being appended twice. Saved items cannot recover every
missed intermediate delta; label gaps honestly. If webhooks are used, verify
signatures, deduplicate/replay-protect, enqueue promptly and retrieve authoritative
state; polling recovery remains mandatory. Use documented required-action names
for each transport rather than assuming webhook and stream event names match.

Deliver code changes and test records through a verified pushed branch or published
artifacts under `/workspace/outputs`, tied to session, completed turn, input head
and content hash. Page through artifacts and download before session deletion;
retention after environment expiry is not retention after session deletion.
Reject unsafe archive paths/symlinks, wrong-base patches and truncated results.
Honor upload limits; larger contexts use documented file delivery, not silent
truncation. Use the same single PR-writer/result reconciliation contract as G5.

Usage is API billing plus hosted compute. Budget/turn/time controls must describe
what is actually enforceable, account for planning and fixes, and prevent new
dispatches when allowance is exhausted. An approximate cost estimate is not a
hard spend guarantee. Provider-side limits/cancellation must be used where available.

## G5: Codex Cloud

Implement a separate `codex-cloud` backend using supported documented surfaces.
At audit time, installed Codex 0.160.0 exposes `cloud exec --env`, `status`,
`list --json`, `diff` and `apply`; help exposes no cloud resume/cancel command.
Recheck current docs and supported CLI behavior during implementation. No browser
automation, private endpoints, guessed flags, or rebranding local `exec` as Cloud.

Require authorized ChatGPT sign-in and a selected published cloud environment.
Check repository/branch access and exact input head before dispatch. Prefer native
same-task continuation only when a supported interface is demonstrated. Otherwise
implement **successor Cloud tasks inside one Gallivant task**: each review round
gets the approved brief, source snapshot, current pushed branch, feedback and
explicit recorded decisions. Record all child IDs and continuity mode. This keeps
the same PR/review loop without falsely claiming native-session memory transfer.
Make required uncommitted brief/source snapshots available on the isolated task
branch or through a demonstrated Cloud input channel before submission; a local
path in the prompt is not delivery. Verify the remote input revision, including
those snapshots, and never publish unrelated or credential-bearing local files.

Choose one PR writer. Where Cloud returns a patch, validate its base and paths,
apply it to the task's isolated checkout, verify resulting code/tests and use the
existing Git/GitHub operations to commit/push/open or update exactly one PR. An
already pushed provider branch needs reconciliation, not another application of
the same diff. Never apply a Cloud diff to the operator's dirty checkout. A receipt
must identify actual observations, not infer test success from task status.

If native cancellation is unavailable, stop further Gallivant rounds, retain the
remote task link and accurately report that provider execution may continue.
Quarantine late results; do not claim stopping a CLI client stopped remote billing.
Do not enable an interrupt control that cannot safely prevent overlapping work.
Cloud authentication on a trusted worker is separate from generic plugin OAuth;
document supported deployment modes. No collection of user passwords, browser
cookies or pasted Codex auth files in a public plugin setup flow.

Cloud observability is capability-based: use supported status, selected attempt,
summary, diff and deep links. Do not invent a full token/tool transcript where the
supported CLI exposes none. Journal observed transitions and polling errors with
timestamps. Task listings must paginate and reconcile the exact recorded ID; do
not choose the newest task or another attempt as an implicit recovery strategy.

## G6: GitHub and review parity

Both backends must use the same readiness, CI/reviewer feedback, head freshness,
receipt, recheck, conflict, timeout and terminal-state logic as local harnesses.
Preserve one task/branch/PR, bounded fix rounds, trusted author handling and human
merge authority. Make code/worktree transport provider-specific, not the review
decision rules. Retain legacy public identity blocks and registry migrations.

Test current-head changes, base merges/conflicts, stale reviews, check failures,
receipt-only repairs, provider and evaluator outages, restart/recovery and chains
waiting for merged predecessors. A skipped gate stays visible. Evidence includes
the exact head and source of each check; no checks observed is not described as
tests having run. Scope GitHub credentials per owner/repository; nothing about
plugin sign-in inherits an unrelated GitHub connection.

## G7: plugin and update contract

Keep one Gallivant package/repository with documented exports and versioned JSON
contracts. Package a thin plugin adapter from the same tagged source, with pinned
dependencies and a release manifest recording package version, source commit,
contract version and artifact hashes. No vendored copy of task/review logic.

MCP operations cover capabilities/setup, prepare, answer, validate, start, list,
inspect, result/evidence retrieval and supported controls. They call the same task
service as CLI and tracker. Mutation requests use an idempotency key and expected
task/brief revision. Public tools accept scoped IDs, not arbitrary filesystem paths,
shell commands, credential material or user-supplied backend endpoints.

Provide one shared task UI with a sidebar entrypoint and conversation panel. It
supports task text, requirement questions, harness choice, approval/run allowance,
progress, evidence/files, PR link and next action. Include loading, disconnected,
auth-required, unavailable-harness, blocked and stale states. Do not mirror raw
logs or entire conversations into model context. A context-only viewer is not
completion of this milestone; users must be able to start and continue real work.

Package a deployable HTTPS service configuration and an installable combined
skills/MCP plugin. Account isolation, scoped GitHub/provider connections and MCP
OAuth belong in the hosted adapter. Reuse established authentication libraries;
do not invent a password system or expose the loopback tracker directly. Provider
credentials stay on the appropriate worker/service. The hosted API mode requires
no end-user CLI; Cloud mode must state its separately demonstrated account setup.

The deployable service runs supported Node code with durable task/artifact storage
and exactly one active coordinator per state namespace. A single persistent
instance is an acceptable first release; do not pretend the current filesystem
lock provides distributed exclusion. Refuse unsafe multi-replica configuration
unless a real lease is implemented/tested. Separate public MCP authentication and
request handling from arbitrary agent execution; support graceful shutdown, health
versus readiness, bounded queues, quota checks, retention, backup/restore and
rolling back without double dispatch. No ephemeral serverless filesystem as the
only registry. Reuse existing hosting only if it meets these requirements.

Return long-running task handles promptly, then offer read-only status/results;
do not keep one ChatGPT tool request open for an entire coding/review cycle.
The sidebar and panel share the same MCP App resource and validated extension
metadata. Verify CSP, permitted resource origins, OAuth challenge/reconnect,
schema/tool annotations and UI deployment paths against the current SDK. Do not
promise every host supports every UI surface. Fresh-conversation reconnect uses
account/task identity, not reconstructed chat history. Enforce per-user/repo
authorization inside every service operation and artifact download, not only UI.

APort is publisher. `https://aport.io/`, `/privacy-policy/`, `/terms-of-service/`
and `/license/` are the supplied canonical pages, not proof that hosted data flows
are already covered or business verification completed. Product title containing
Context is a working choice, not permission to rename the Gallivant CLI. Preserve
Apache-2.0 notices. Production endpoint, support route and account approvals must
be configured/verified, never invented in a submission artifact.

Version and capability handshake allows compatible core improvements without
client rewrites. Test upgrades from this feature's first released schema, legacy
local registries and the prior supported plugin contract. Refuse incompatible
majors with an actionable remedy. Do not update running jobs' contracts or
providers underneath them; stage upgrades, back up state and document rollback.

## G8: verification and bounded output

Normal CI is offline, deterministic and free of model calls. Extend the existing
test conventions with transport fixtures, shared lifecycle conformance tests and
installed-package tests in a clean directory. Test both remote backends and the
local Codex baseline; don't certify only Agents API because it was easier.

Opt-in live verification is required before claiming live support. An operator
supplies an authorized disposable GitHub repo/environment, provider credentials
and an explicit spending allowance. Run one tiny task and one forced review/CI
correction per backend, sequentially; repeat only a failed phase after a justified
fix. Carry state through a service restart. Verify actual files, tests, remote
commits, PR identity and provider IDs externally. Help output, mocks and narrated
success are not substitutes. Missing credentials, access or allowance block the
live claim, not unrelated implementation; leave unmet criteria explicit.

Deliver a bounded `docs/audit/plugin-ready/` index, one evidence JSON with per-case
outcomes, and a release checklist. Keep raw sensitive logs outside Git. The record
names implementation commit, versions, timestamps, commands, revisions, provider
IDs, costs or unknowns, artifacts and remaining blockers. No generated per-idea
archives, repeated reports, benchmark campaigns or thousands of fixture files.
A private downloadable test artifact is not a public directory submission.
Reuse Gallivant's per-run artifact layout. Each task exposes a bounded manifest
of its brief, evidence, generated files and PR, with source revision/hash and
authorized download/view links; use stable IDs and retention rules rather than
arbitrary filesystem paths. Users must be able to find the actual results after
reopening a task, not only its terminal log or a narrative summary.

M1-M5 may complete their implementation PRs with live prerequisites explicitly
unavailable and the opt-in checks supplied; this is not a release claim. M6 has a
strict release gate: missing live evidence remains incomplete, not a conditional
pass. Never purchase credits, deploy to an unspecified account, weaken criteria
or fabricate evidence to get that final milestone green.

## G9: submission-ready release

M6 qualifies the actual installed artifacts after predecessors merge. Use one
bounded `release/aport-context/` output directory (generated binaries can stay
outside Git), with `START-HERE.md`, plugin ZIP, installable Gallivant package,
deployable backend artifact/recipe, `manifest.json`, `evidence.json`, listing and
release notes, review cases, screenshots and a real accessible demo recording
URL. No thousands of generated files. The manifest names source commit, versions,
contract schema, dependency lock, artifact hashes, service deployment revision,
MCP endpoint and observed verification dates. Distinguish source changes after
build from harmless release-record updates; invalidate affected evidence when
executable code, package payload, tool schema or deployment configuration changes.

End-to-end proof covers both remote backends independently using one small task
and forced review correction each. Also test the release plugin in the actual
ChatGPT host with a fresh authorized account, real repository, one available
remote backend, required questions, readiness, PR, correction, files and reconnect
after coordinator restart. The owner can reproduce the CLI/backend run from the
installed release. Fixtures alone cannot satisfy these claims. If public
multi-user Cloud credential delegation is unsupported, label Cloud as a trusted
operator/self-hosted mode and use Agents API for public onboarding; both runtime
adapters must still work. No password/cookie harvesting to force Cloud support.

Use the documented portable package schema, one connected MCP server and combined
skills/MCP in the initial ZIP. Set APort publisher, working legal/product/support
URLs, authentic icons/screenshots and concise starter prompts. Put supported
review metadata under `extensions.com.openai.review`: exactly five positive and
three negative scenarios, actual expected tools/behavior, demo recording URL and
release notes in their documented fields. Build and validate the ZIP from the
same source as the backend; do not hand-edit a second release copy.

Provide a dedicated sample repository/tenant and immediately usable reviewer
account, enough authorized execution allowance and repeatable seeded scenarios.
Verify reviewer access without private VPN, MFA, SMS or magic-link dependencies;
isolate that test account instead of weakening production authentication.
Credentials and reviewer instructions go only into the secure submission portal,
never ZIP/Git/public logs. The handoff identifies their secure storage location.
Verify the chosen domain using the actual assigned challenge without overwriting
another plugin's token. Business/publisher verification and required automated
scans must be satisfied or explicitly prevent the submission-ready designation.

The final checklist must distinguish code merged, live-qualified, submission-ready,
submitted, approved and published. Owner portal attestations/clicking Submit remain
human actions; no automatic publication is requested. A review approval cannot
be promised. Preserve currently approved server contracts during upgrades:
eligible MCP changes are scanned from the live server; metadata/skills changes
require a new ZIP. Do not change the registered MCP URL casually. Include exact
rebuild/rescan/rollback commands, secure credential rotation and task migration.

## Official references checked 2026-10-04

Reverify these at implementation; documentation is not account-access evidence.

- [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions), [hosted sandboxes](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted).
- [Events and recovery](https://developers.openai.com/api/docs/guides/agents-api/sessions/events), [session management](https://developers.openai.com/api/docs/guides/agents-api/sessions/manage), [webhooks](https://developers.openai.com/api/docs/guides/agents-api/sessions/webhooks), [files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files).
- [Codex Cloud](https://learn.chatgpt.com/docs/cloud), [developer commands](https://learn.chatgpt.com/docs/developer-commands), [authentication](https://learn.chatgpt.com/docs/auth).
- [MCP tools](https://developers.openai.com/plugins/build/mcp-server), [authentication](https://developers.openai.com/plugins/build/auth), [Extensions](https://developers.openai.com/plugins/build/extensions), [packaging](https://developers.openai.com/plugins/build/plugins), [submission](https://developers.openai.com/plugins/deploy/submission).
- [ChatGPT plan sharing](https://developers.openai.com/siwc/token-sharing-open-source): paid/remote app eligibility is separate; this is not established authorization for Agents API billing against a user's subscription.

Implementation and chaining are authorized. Deployment/account actions require
the concrete target and authority; paid verification requires an explicit
allowance. Resolve these at release setup without treating elapsed time or this
planning contract as approval. No directory submission, automatic merge or public
publication is authorized. Keep external prerequisites and unverified claims
visible while continuing independent implementation work.
