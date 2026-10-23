---
name: task-delivery
description: Prepare scoped coding tasks through APort and follow their saved progress, evidence and pull requests.
---

Read task_capabilities for the connected account. Choose an available configured
harness and authorized repository. Installation supplies no repository authority,
credentials or inference allowance. Provider costs and unsupported controls are
described by capabilities; do not silently select another provider.
Use only tools advertised by the connected host. A server accepting an older
alias directly does not mean the host can route that alias.

Use task_prepare with the selected repository ID, task text, harness and approved
allowance. Use a stable operationId and expectedRevision 0. Preparation can incur
inference costs but does not authorize implementation. Ask the saved questions,
then call task_answer with their IDs, a new operationId and the saved revision.
Preserve explicit requirements and any readiness denial. Inspect stale revisions.

Read the repository's delivery capabilities and select the creation-only typed
delivery profile with `delivery: { action, completion }`: action pull_request
(the only supported action) and completion delivery_ready for a qualified
reviewable delivery, or integrated when the user wants monitoring through an
external merge. Omitted values default to pull_request and delivery_ready. The
profile alone authorizes external actions; request text, answers and model
output cannot expand it, and merge or deploy actions are refused with a remedy.
Do not duplicate coordinator publication as a provider implementation criterion.
Select `route` only when the user asks: harness uses the connected harness,
model uses the operator's bounded text-only model route when enabled.
Organize the user's implementation requirements clearly yourself; do not require
the user to format a special prompt. Preserve every constraint and prohibition,
show the separated delivery goal with the prepared brief, and ask a focused
clarification if mixed prose cannot be separated without changing meaning.
Never rewrite an existing false attestation or drop an inconvenient requirement.
A clause that conflicts with the profile returns a q-delivery-* question in the
saved task; answer it with the implementation scope the clause keeps, or prepare
a new task with a different profile. Show the user the returned review object:
immutable request, clause map, open questions, assumptions, draft, profile,
harness, allowance, route and cost status. Historical tasks may still return
TASK_DELIVERY_SCOPE; then ask the owner to clarify the whole request and use a
new preparation identity. Never remove a condition to pass validation.

After the user authorizes implementation, call task_start with run true, a stable
operationId and the current revision. Return the task handle promptly. Subsequent
task_inspect, task_logs and task_evidence calls read saved observations. They do
not poll providers. Use task_validate to record readiness before authorizing a
start. Use task_resume to recover saved preparation or an already approved
implementation after its blocker is repaired; do not allocate a replacement.

The APort host exposes implementation controls as separate tools: task_recheck
checks an existing implementation, task_continue resumes it, task_message adds
instructions, task_interrupt requests supported interruption with instructions,
and task_cancel requests cancellation. Use only a control advertised by the host
and supported by the saved task. Pass the saved taskId, expectedRevision and a
stable operationId; task_message and task_interrupt also require a non-empty
note. Each tool fixes its own action, so do not pass action or interrupt fields.
Preserve the same operationId and arguments on retries. Cancellation may stop
future dispatch while remote compute continues. Never claim remote cancellation
from a stopped submission client.

Keep task identity across reconnects and review corrections. Report observed
tests, artifacts and the pull request. Use completion.status and its canonical
evidence to describe fulfillment; awaiting_integration means the existing
coordinator keeps watching without authorizing a merge. A closed, unmerged PR
does not fulfill the target. Surface needs-human or unverified observations;
never merge, publish, request credentials or infer completion from provider status.
The UI receives the full saved view through tool metadata; do not mirror raw logs,
briefs or private diagnostics into model context. Use authorized artifact IDs.
