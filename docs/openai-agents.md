# Managed coding sessions through OpenAI Agents API

This adapter runs the managed Codex Agents API in an OpenAI-hosted sandbox. The
existing task service, coordinator, dispatch journal, PR writer and review rules
remain the owners of work. Node 22+, local Git/gh for publication, and Agents REST
beta `OpenAI-Beta: agents=v1` are required. No OpenAI SDK or local Codex binary is
used by this transport. The REST schema was checked against official documentation
on 2026-10-06; beta compatibility must be rechecked before upgrading.

Install the package with `npm install -g .`, or use `node bin/gallivant.mjs` from
this checkout. Configure one explicit account in the existing config file:

```json
{
  "harness": {
    "openai-agents": {
      "account": "my-service-account",
      "organization": "org-selected",
      "project": "proj-selected",
      "api_key_file": "/private/operator/agents-key",
      "model": "YOUR_AUTHORIZED_MODEL",
      "environment": "openai_hosted",
      "container_size": "small",
      "network": { "access": "disabled" },
      "allowance": { "remainingUsd": 1, "reservedUsd": 0.2 }
    }
  }
}
```

Retain your existing repository, credential, identity, reviewer, verification and
permission settings. Put the API key in a private file, or supply `OPENAI_API_KEY`
to the coordinator. It needs `api.agents.read`, `api.agents.write` and
`api.responses.write` in the selected organization/project. A ChatGPT subscription
is separate from API inference and hosted compute billing. The account probe
retrieves the exact model and lists sessions; this verifies read visibility, not
inference entitlement, sufficient credits or successful hosted setup. Actual
session/environment/turn results are the evidence for those capabilities.

Select the authorized model explicitly; there is no remote model fallback. The
container size is explicit. If dependencies need outbound access, use
`network.access: restricted` with 1–100 exact `allowed_domains`. An optional
`environment_template_id` selects a preconfigured template, whose existence is
checked. Templates save configuration, not a previous filesystem. Python 3 and
Git must be present for the portable snapshot helper; a failed setup command
prevents implementation from starting. API and GitHub credentials remain outside
the sandbox; the adapter sends no service credentials or inherited environment.
The coordinator's existing scoped GitHub credential publishes the artifacts.
Optional `packages` contains explicit `system`, `python` and `npm` package arrays;
pin required versions and select the network domains their installation needs.

Local mandatory hooks, workspace-write/auto-review guarantees and private
read-only `context_paths` are not provided by hosted execution. Configuration or
dispatch refuses them explicitly. Select a backend that enforces required policy;
a completion receipt does not implement pre-action policy enforcement. Project
sources cannot contain private configuration paths, symlinks, submodules, special
files or portable path aliases. Refusal preserves the brief and start claim.

## Task and command use

A ready PRD selects `harness: openai-agents`. Use the existing commands:

```sh
gallivant doctor
gallivant start docs/prds/my-task.md --base main
gallivant up
gallivant status
gallivant why owner/repo/my-task
gallivant resume owner/repo/my-task --note 'Apply this authorized correction'
```

Natural-language intake uses the selected provider's versioned preparation
capability through the shared execution service for drafting, questions and
repairs. The task service owns deterministic validation/readiness and explicit
implementation authorization. Native preparation creates a fresh session with
`environment: {type: "none"}`, `tools: []` and `multi_agent.enabled: false`.
The API requires initial input for conversation-only sessions. The bounded
selected context is sent with those explicit restrictions in the same creation
request; the returned effective configuration is checked before adopting output.
Lost creation replies recover by task/account/dispatch metadata and never resend
the input. The live qualification caught this requirement on 2026-10-08; an empty
creation request returns HTTP 400 even though hosted coding sessions allow it.
Only the owned root's completed final answer can become a draft; tool calls,
delegated output and changed account/model settings are refused. It reuses the
normal durable execution receipts, cancellation, logs and lost-ack recovery.
Preparation does not need Git, a hosted filesystem or a local verification sandbox.
Implementation retains its existing hosted environment and sandbox requirements.
API/model access and live task qualification remain separate from this boundary's
authority. There is no automatic provider switch. A hand-authored approved PRD
still uses the explicit `ready`/`start` path above. No selection changes global
defaults. The same implementation task, branch, PR and
session are used for review fixes, stale heads, receipt repair and base reconciliation, within
the existing iteration limits. Each round sends the coordinator's current exact
input head and saved brief/source snapshots. The remote repository contains that
verified revision's files and modes, plus carried files, rather than Git history;
its sandbox-local initial commit is a snapshot commit. Publication always checks
the original input head on the coordinator.
Source snapshots accept Git SHA-1 and SHA-256 repositories: the exact HEAD must
contain 40 or 64 hexadecimal characters, and every tree blob uses that same
repository object-ID width. File-content hashes remain SHA-256 in both formats.
Hosted resume refuses ordinary modified, staged, deleted, renamed or untracked
files with `AGENTS_DIRTY_SOURCE` before merge, task reopening or paid dispatch.
Commit the intended unfinished edits on the owned task branch, then resume the
same session. Only the approved brief and declared carried-source overlays may
remain uncommitted; their bytes must match the accepted snapshots. Initial and
review dispatch use the same source check, and preparation rechecks both status
and HEAD before accepting the portable snapshot. No unfinished file is discarded
or silently uploaded.
The task CLI (`gallivant task 'Implement the approved request' --harness openai-agents`)
reports that missing capability. [The shared intake workflow](tasks.md) always
retains the selected provider for preparation, clarification and repairs; a
different selection requires an explicit operator choice. The restricted native
Codex preparation adapter is supplied separately by
[`uchibeke/gallivant#10`](https://github.com/uchibeke/gallivant/pull/10)
at `39dec7c787a503956f18b745d92a13166d287c45`. It remains open and absent from this
selected base as of 2026-10-06. Merge the reviewed adapter into the base, then let
the coordinator sync this branch; this API milestone does not copy its adapter.
Its native 0.160.0 loopback-provider boundary qualification is separate from live
inference access and does not qualify managed preparation.

The shared execution boundary also exposes scoped question answers:

```js
const execution = context.executionFor(taskId, "openai-agents");
await execution.respond({
  operationId: "answer-unique-id", authorized: true,
  sessionId: recordedSession, turnId: recordedRootTurn,
  callId: currentAskOperatorCall, answer: "Use the approved value"
});
```

Only the pending `ask_operator` function is supported. The caller must authorize
the answer and use the current task/session/turn/call identities. Arbitrary
function requests and browser approvals are refused. Answers use the documented
idempotency header and never create another implementation turn. After a timeout
or lost answer reply, explicitly repeat `execution.respond` with the identical
authorized input and operation ID. The adapter subscribes before retrieving the
owned session/root and resends the saved answer/key only while that exact
`ask_operator` call remains pending. If it is no longer pending, paginated root
items must contain the matching function call and successful, identical output
before acceptance is recorded; missing or conflicting proof stays ambiguous
without sending input. A saved acknowledgement survives stream cleanup or a
coordinator checkpoint failure. Changed answer bytes, arbitrary tools, foreign
roots/accounts and stopped sessions are refused. This follows the documented
[function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)
and [submission retry](https://developers.openai.com/api/docs/guides/agents-api/sessions)
boundaries. This structured interface is available to existing clients;
there is no terminal question waiter or arbitrary shell executor.

## Progress, recovery and controls

Only the single coordinator performs provider I/O. Tracker/status reads saved
state. Existing `execution.deadlineMs`, `progressMs`, concurrency and capped
backoff apply (defaults: 2 seconds per operation, 10 seconds between polls,
maximum 5 minutes backoff). A stream connects before each send/reconciliation,
buffers while authoritative session/root-turn/items are read, and closes within
the bounded operation. Closing a stream never cancels work. Root turns alone
settle implementation; idle sessions and subagent events cannot report success.
Saved items restore output by item ID. Final text replaces partial text. Journals
label potentially lost intermediate deltas. Webhooks are not configured; periodic
polling performs recovery without depending on delivery notifications.

State lives in the existing `runs/<task>/execution.json`, `agents.json`, per-run
`events.jsonl`, `job.json`, `job.log`, `result.json` and `verification.json` layout.
Initial task ownership is registered before dispatch, so a launcher's lost reply
remains discoverable by the same coordinator after restart.
Session/environment/dispatch intent is flushed before sending input; turn IDs are
persisted before launch acknowledgement. Lost replies reconcile the saved key and
pre-send turn set; unknown acceptance never starts another paid implementation.
Creation without a recoverable root remains explicitly ambiguous and needs an
operator to inspect the saved session. Do not delete state to force a retry.

`Retry-After` accepts non-negative seconds or an HTTP date, with delays bounded
by the existing five-minute retry limit. Past dates and malformed headers use
normal exponential backoff; invalid transport delays cannot erase a saved retry
deadline. Restart preserves that deadline before another poll or cancellation
attempt. The supported header forms follow
[HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3).
Three consecutive reconciliation or unresolved launch attempts open a circuit;
creation recovered before any input send requires explicit inspection. Failed sessions stop
reconnecting. Repair credentials/throttling/configuration and explicitly authorize
`transport.resetRecovery` for a still-viable session. Failed or expired sessions
require saved artifact recovery and explicit replacement-session authorization;
automatic replacement is not supported, and no old filesystem survival is claimed.

The owned checkout is registered before source delivery or remote input preparation.
A source symlink/submodule, oversized snapshot, changed head or preparation failure
leaves a `needs-human` task with reason `launch-preparation`, its saved brief and
checkout intact, and a versioned `initial_dispatch` marked `unsubmitted`. Repair
the repository or prerequisites and run `gallivant resume <task-id>`; the tracker
Resume action uses the same transition. A proven first-dispatch refusal follows
this path with reason `dispatch-refused`. Resume rechecks full native/API readiness
and contract/source validation, restores missing approved inputs without replacing
unfinished edits, and submits the original operation from the current verified
revision and full approved brief. This is the first provider implementation, so no
prior session is claimed. Older initial refusals can use their private
`dispatchRefusals` proof. A stopped task, existing execution intent/run, foreign
operation or ambiguous acceptance cannot use this transition. After dispatch starts,
the marker is `dispatching`; only reconciliation may recover a lost reply, and an
accepted launch clears the marker. Ordinary later resumes retain the same session.

Cancellation sends `agent.session.input.cancel` only after confirming the owned
root is the session's single active root. HTTP acceptance is distinguished from
confirmed cancellation. Cancel, timeout and exhausted allowance fence future
paid dispatch; late artifacts remain quarantined. Session deletion is a separate
explicit transport operation and refuses before terminal state and saved results.
The adapter does not automatically delete sessions needed for review continuity.

Reservations are estimates and a local allowance fence, not enforceable provider
spend caps. Observed token usage is saved; USD cost is unknown until API and hosted
compute charges are reconciled. Unknown cost retains its reservation and is never
zero. No output-token or hard USD limit is invented for this beta interface.

## Files and limits

The source snapshot contains immutable Git blobs with SHA-256 hashes and verified
carried documents. Expanded input is limited to 10 MiB; compressed inline input is
limited by the 5 MiB per-file limit and a conservative 3 MiB request limit. Larger
sources fail explicitly; this version does not silently truncate or upload to an
unscoped external store. Outputs are regular UTF-8 text changes, up to 100 files
and a 1 MiB manifest. Mode changes and binary output need a future documented
transport and are explicitly unsupported. Snapshot helper output and artifact
metadata are tested separately from provider-shaped REST fixtures.
Unchanged approved brief/carried files are included in the artifact manifest so
the PR writer commits those files from a fresh checkout. Later receipt-only rounds
deliver the same verified files and preserve the code head when no code changed.

The agent writes PR title/body and test records, then runs the supplied helper to
publish `/workspace/outputs/result.json`. Artifacts are selected by exact session,
environment, completed root turn and path. Paging uses `after` in ascending order:
100 entries per page, at most 20 pages and 1 MiB response/history. Stream buffers
are bounded to 100 events/64 KiB. No truncated page or result authorizes publication.
The adapter verifies content/base hashes and safe paths, and the existing PR writer
rechecks branch ownership, base/head, aliases, modes and approved tests on the
actual applied revision before pushing. Agent-reported tests are retained as such;
coordinator-executed verification remains authoritative for PR publication.

Malformed JSON, unsafe/private paths, wrong source heads, hash mismatches and
portable aliases in a downloaded immutable artifact stop collection once. The
adapter saves its rejected bytes and hash in the private mode-0600
`<run>-rejected-artifact.json` cache, referenced by `agents.json`. These bytes are
untrusted inspection data; they never enter the checkout, public logs or PR writer.
The shared `result-application.json` checkpoint records
`result-collection-validation`, and the task enters `needs-human` with reason
`result-verification`. Provider root status, session, PR and observed/unknown cost
remain intact. Polling, restart and PR recheck cannot redownload or accept that
artifact. Inspect the checkpoint and private cache, then explicitly resume for a
corrected result in the same session. Rejected artifacts do not qualify session
deletion. Missing delivery, HTTP throttling/authentication, interrupted downloads
and local persistence failures remain unresolved and retryable after repair.

The coordinator executes every nonempty Verify list in an OS sandbox, including
scripts changed by hosted results and their child processes. Install a dedicated
Node 22+ runtime with npm and use macOS with `/usr/bin/sandbox-exec` plus
`/System/Library/Sandbox/Profiles/dyld-support.sb` and the installed Command Line
Tools used by `/usr/bin/git`, or Linux with `/usr/bin/bwrap`
and enabled unprivileged user/PID/network namespaces. System tools, the running
Node binary and its npm package are readable; only the checkout and a private
temporary profile are writable. For a custom Node prefix, Linux supplies the
normal `npm` entry point as a link to its read-only CLI module; it does not grant
the broader bin directory. Readiness opens the selected prefix's executable npm
launcher inside the boundary, so a missing or unreadable entry point fails before
hosted work. The native custom-prefix regression executes `npm test` through it.
Git Verify commands receive a separate read-only
`GIT_DIR` with the exact current commit, its tree/blob objects and a reconstructed
index. `git diff --check`, status and current-HEAD reads work in normal and linked
checkouts; coordinator Git config, hooks, remotes, reflogs, alternate stores and
ancestor history remain absent. The view is bounded to 10,000 objects/16 MiB and
20 seconds, and removed with the temporary profile on every exit. Commands that
require other refs or history must use another approved check. Coordinator
journals, private host files and host network access remain inaccessible.
Arbitrary inherited PATH entries are removed; provision dependencies in the
checkout before Verify runs.
Network-dependent tests and unsupported tools fail rather than widen access.

Doctor's `openai-agents readiness` check exercises that native enforcement in
disposable directories, including actual Git reads and denied index writes
against a trusted empty commit before a checkout exists, before checking API
read access. Start refuses unsupported hosts before cloning or saving task
snapshots. Review dispatch and
manual resume recheck before recreating or merging the checkout, and the managed
transport checks again before sending a new implementation or correction.
If that final local check refuses before any provider request, the shared boundary
releases the unsubmitted intent and reservation, preserves the prior root/session
and records a bounded private `dispatchRefusals` entry. Start/review dispatch stops
with `dispatch-refused`; repair host/input prerequisites and explicitly resume,
or retry the identical authorized operation through the shared service. No new
session was launched by the refusal. Once a transport operation or provider
request exists, lost replies remain acceptance-unknown and cannot use this release.
Manual resume runs the full native/API readiness check before accepting an
edited brief or carried sources or reopening the entry. Expired credentials,
revoked project/model visibility and unsupported hosts leave those saved inputs
and task/session ownership unchanged. API read readiness still does not attest
to inference or hosted setup access.
Provider health and preparation records retain the native enforcement evidence;
they still label model inference and hosted setup as unverified until dispatch.
Repair the named OS/runtime requirement and explicitly resume the existing task.
Sandbox failure does not stop read-only progress, cancellation or saved artifact
recovery, and creates no automatic replacement session. Scratch profiles are
removed after successful, failed and aborted readiness checks.

A five-second native enforcement probe runs before any repository code. Failure
blocks publication once with `verification-sandbox-unavailable`; inspect
`result-application.json` and `verification.json`, repair the host sandbox/runtime,
and explicitly resume the same task. Saved artifacts and the applied code are
retained. Each command records sandbox provenance alongside its head, exit and
output. An interrupted verification or older `verified` checkpoint without that
provenance cannot push or silently replay commands. Already published results
remain read-only recovery records. See [the shared boundary](execution.md) for
runtime grants and cleanup. Native macOS enforcement tests are distinct from
provider-shaped fixtures; Linux namespace support requires the same native suite
on the selected Linux host. Neither is live Agents API qualification.

Immutable published artifacts survive sandbox expiry, but not session deletion.
Downloaded results are saved in `runs/<task>/<run>-artifacts.json` and the canonical
per-run result before settlement. Preserve that directory independently of log
retention. Restore it with the matching execution state/package version; artifact
collection does not require a surviving sandbox. Never delete a session before
saving its results. Sensitive raw logs and campaign ledgers stay outside Git.

## Repeatable verification and live evidence

From the source checkout, offline verification makes no model calls:

```sh
npm test
npm run lint
npm run test:execution-backends
npm run test:openai-agents
git diff --check
```

The focused suite uses provider-shaped REST responses through the real adapter and
shared lifecycle boundary. It covers success/failure, root/subagent distinction,
required actions, reordered output, lost replies, paging, artifacts, expiry,
cancellation, account isolation, retry circuits, binary input and sandbox output.
Fixture evidence does not certify live access.

`npm run test:openai-agents:live` performs a nonpaid preflight and returns unverified
when prerequisites are absent. For paid G8 qualification, supply a private existing
configuration home, approved tiny disposable-repository PRD, explicit repository
allow-list and the shared private campaign ledger:

```sh
export OPENAI_AGENTS_LIVE_HOME=/private/operator/test-home
export OPENAI_AGENTS_LIVE_PRD=/private/operator/disposable/docs/prds/tiny.md
export OPENAI_AGENTS_LIVE_REPO=authorized-owner/disposable-repo
export OPENAI_AGENTS_CAMPAIGN_LEDGER=/private/operator/campaign.json
npm run test:openai-agents:live
npm run test:openai-agents:live -- --execute --phase=implementation
# Reconcile observed API plus hosted-compute cost in the ledger before correction.
export OPENAI_AGENTS_LIVE_CORRECTION='The forced CI/review finding and approved fix'
npm run test:openai-agents:live -- --execute --phase=correction
```

The ledger schema is `{version:1, limitUsd:10, remainingUsd, reservationUsd,
turnSeconds, pricing:{url,checkedAt}, attempts:[]}`. Reserve from the aggregate
campaign across milestones, use official pricing checked within 24 hours and a
positive deadline at most 120 seconds. Previous attempts must have observed USD
cost before another paid phase. Reservations and phase intents persist before
launch. This command does not buy credits, change models or repeat a dispatched
phase. A failed/unknown phase requires recovery of the saved task rather than a
new campaign launch. Stop the daemon for that private test home first: the campaign
claims the same daemon lock and uses the existing coordinator with its authenticated
GitHub login. Its settlement-only observation publishes the authorized run without
automatically dispatching another paid review or queued resume. Configure the approved brief and existing verification so
its tests establish a concrete file behavior; the correction should reproduce a
real failing CI assertion or trusted review finding. Correction refuses before
reserving or dispatching unless the existing review rules derive a real finding
on the current local/remote head; it records that finding with the phase evidence.
Each command reconstructs the
context; the campaign also recreates the coordinator while observing the turn.
`agents-live-evidence.json` records files/artifacts, tests, head, same PR/session,
turn/environment IDs, restart and observed usage. It remains unverified until both
phases pass. Installed plugin/browser qualification belongs to the later release
milestone; no plugin or browser surface is required for this REST adapter.

The current audit records missing live credentials/configuration. Supply the exact
prerequisites above to obtain live evidence. M6 still owns final release qualification.

M5/M6 must reuse the single connected execution successor
[`aporthq/agent-passport#417`](https://github.com/aporthq/agent-passport/pull/417),
canonical PRD `docs/prds/aport-task-delivery-workflow-integration.md`, job identity
`aporthq/agent-passport/aport-task-delivery-workflow-integration`. It preserves the
original T0–T9 requirements and remains draft until the actual M5 portable artifact
is available. M6 must pin that artifact's version, commit, integrity and actual
exports, connect existing APort authentication, regional storage and shared UI to
the shared task service/coordinator, and qualify the full workflow. These are
handoff requirements, not work implemented in this repository; do not create a
second runner or another foundation job. Missing API and installed-host evidence
remain separate unmet gates.

Official contracts: [overview](https://developers.openai.com/api/docs/guides/agents-api/overview),
[quickstart and permissions](https://developers.openai.com/api/docs/guides/agents-api/quickstart),
[sessions and idempotency](https://developers.openai.com/api/docs/guides/agents-api/sessions),
[events/recovery](https://developers.openai.com/api/docs/guides/agents-api/sessions/events),
[hosted setup](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted),
[files and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files).
