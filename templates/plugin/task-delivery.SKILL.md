---
name: task-delivery
description: Prepare scoped coding tasks through APort and follow their saved progress, evidence and pull requests.
---

Read task_capabilities for the connected account. Choose an available configured
harness and authorized repository. Installation supplies no repository authority,
credentials or inference allowance. Provider costs and unsupported controls are
described by capabilities; do not silently select another provider.

Use task_prepare with the selected repository ID, task text, harness and approved
allowance. Use a stable operationId and expectedRevision 0. Preparation can incur
inference costs but does not authorize implementation. Ask the saved questions,
then call task_answer with their IDs, a new operationId and the saved revision.
Preserve explicit requirements and any readiness denial. Inspect stale revisions.

After the user authorizes implementation, call task_start with run true, a stable
operationId and the current revision. Return the task handle promptly. Subsequent
task_inspect, task_logs and task_evidence calls read saved observations. They do
not poll providers. Use task_control only for supported controls and keep its key
stable on retries. Cancellation may stop future dispatch while remote compute
continues. Never claim remote cancellation from a stopped submission client.

Keep task identity across reconnects and review corrections. Report observed
tests, artifacts and the pull request. Stop at ready-for-human or needs-human;
never merge, publish, request credentials or infer completion from provider status.
The UI receives the full saved view through tool metadata; do not mirror raw logs,
briefs or private diagnostics into model context. Use authorized artifact IDs.
