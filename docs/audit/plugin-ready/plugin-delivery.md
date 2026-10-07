# Task delivery package audit (M5)

This is a bounded implementation/compatibility handoff, not release approval.
APort is publisher. The unchanged approved brief is
[the M5 PRD](../../prds/gallivant-plugin-delivery.md); the carried
[ownership correction](../../plans/aport-task-delivery-integration.md) takes
precedence for endpoint, UI and downstream-job ownership.

[Evidence index](plugin-delivery.json) records all fourteen criteria, exact
artifact hashes, installed-consumer results and external prerequisites. Raw logs
and internal fixture artifacts remain outside Git. The candidate is explicitly
an internal development fixture; it is not installed-host or live evidence.

[The package contract](../../task-delivery.md) supplies named exports, scopes,
operation/task/execution versions, store/coordinator interfaces, asset inputs,
existing Pages deployment remedy and build/check/migrate/backup/rollback commands.
The runtime tarball, combined skills/MCP ZIP, operations and runtime manifests
come from one builder. License and official portable schema hashes are preserved.
The unchanged vendored schemas retain their canonical source URLs and use the
package's Apache-2.0 license; [upstream licensing](https://github.com/agentplugins/agent-plugins-spec/blob/main/LICENSE.md)
assigns that license to schemas and software material.
Its installed tests exercise the canonical task/readiness/review services rather
than a new workflow implementation.

The source review covered revision/operation ownership, sibling start/resume/fix
allowance boundaries, control retries after history movement, current-run logs,
resource error redaction, backup traversal/symlinks, partial-output cleanup and
active-job runtime pins. The actual installed builder also rebuilds from its
published dependency shrinkwrap. Focused regressions live in `test/task-delivery.test.mjs`
and the artifact-installed `test/fixtures/plugin-installed-flow.mjs`.

Unmet attestations remain explicit:

- **ac-5:** Actual Pages runtime/binding execution is unavailable. Node package
  imports and bounded reconciliation run in the installed consumer. Browser
  bundling measures the Node filesystem/child-process incompatibility; it does
  not qualify Pages. The endpoint returned HTTP 503. Retain Pages OAuth/MCP/UI
  and supply its authenticated binding to the documented single Node 22 durable
  coordinator and external scheduler; demonstrate it on the actual deployment.
- **ac-12:** The clean installed deterministic suite passes, including local
  intake/review, API/Cloud transport fixtures, SDK dispatch and emitted resource
  fixtures. Both inherited hosted providers declare no bounded preparation, so
  complete hosted natural-language flows cannot be qualified. Implement and
  verify a native enforced preparation boundary before changing that capability;
  preserve Cloud's environment/repository dispatch block. Fixtures cannot supply
  unavailable production capability or model access.
- **ac-13:** The handoff describes the actual candidate exports/digest, but a
  merged M5 digest cannot exist before human review/merge. After human merge,
  rebuild from that exact clean commit and pin its manifests/artifact in the
  existing APort integration. Do not reuse the pre-merge source attestation.

The existing `aporthq/agent-passport/aport-task-delivery-mcp` dependency is merged
[PR #414](https://github.com/aporthq/agent-passport/pull/414), discovered through
GitHub. Reconcile that integration's deployment and runtime binding after the
merged package is pinned. No replacement job, integration PRD or final public UI
is produced. No automatic merge, submission, publication or additional paid
campaign was performed.

M6 still requires actual scoped OAuth/tool scans; durable restart on the deployed
runtime; real implementation and correction PRs from both hosted providers;
fresh-account sidebar/panel/reconnect and isolation checks; restricted reviewer
access under the shared authorized campaign allowance; authentic screenshots/demo;
working owner-selected support/legal pages; eligible publisher/org/project/domain;
and the bounded G9 release kit. Pinned Cloud listing, sign-in or version checks
prove neither inference nor environment-to-repository access. Agents credentials,
model/environment access, supported Cloud dispatch, deployed endpoint, built UI
and installed task-delivery host tools remain prerequisites.
