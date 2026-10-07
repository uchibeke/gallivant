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

The review follow-up also checks fail-closed Git source proof, including root,
HEAD and status failures, source mismatch, deleted/renamed payload files and
partial-output cleanup. `test/plugin-package.test.mjs` runs against both source
and installed artifacts. Scoped discovery filters repository authorization before
the list limit; source and installed MCP tests cover late authorized tasks,
authorized-only truncation and reads that schedule no work.

Runtime review regressions in `test/runtime-delivery.test.mjs` cover preparation,
pending readiness, unresolved cancellation/results and orphaned execution before
registry creation. Checks, migration, backup and restore retain the same active
artifact pin; settled work still permits a compatible update. Installed task
callbacks exercise the pin guard while preparation or readiness is awaiting a
reply. The same installed conformance suite exercises startup reconciliation over
every bounded batch, a restart at a nonzero cursor, failed-advance cleanup and
normal provider backoff after a full sweep, without duplicate dispatch.

Capability discovery regressions cover 205 authorized repositories, continuation
through revoked IDs, account changes and exact/empty page boundaries. The installed
MCP client uses only model-visible capability fields to choose a repository and
harness for preparation. Cost/control/setup fields stay available while private
configuration stays excluded; reads schedule no work. Chain regressions retain 36
historical records and rotate 25 active chains in bounded windows across restarts,
completion and cancellation, preserving checkpoint failure cleanup and entry progress.

The Node wrapper now checkpoints the canonical tick's chain review deadline.
Cadence regressions use ten-second wakes and a 120-second review interval across
reconstructed coordinators, process identity changes and GitHub failures. They
also check failed-advance cleanup, disabled chains, cancelled batch suffixes and
continued entry reconciliation. The same regression runs against the installed
artifact; ordinary daemon cadence remains covered by `test/chains.test.mjs`.

Backup identity regressions require the pre-upgrade manifest for a pinned idle
namespace and validate the copied pin before restoring any output. The installed
patch upgrade/rollback test starts the restored coordinator and preserves provider
identities. Invalid pins fail closed; unpinned legacy state remains migratable.
Packaging regressions cover untracked, ignored and deleted npm controls, including
nested Git ignore fallback and hidden payload directories. Real npm tarballs show
that these controls can omit an exported module; public builds refuse those changes
and internal fixtures record them without claiming release qualification.

Public URL regressions reject normalized loopback addresses and localhost aliases
across endpoint, metadata and resource origins. Release preflight shares asset
validation with emission for screenshots, UI and icon files, including missing
files, directories, symlinks, size bounds and credential patterns. Source and
installed tests also verify CLI failure status and partial-output cleanup.

Every Node coordinator wake revalidates the exact artifact pin under ownership
before scheduling or task advancement. Regressions cover delayed first callbacks,
repeated callbacks after migration, lock cleanup and a matching new runtime.
Model summaries expose saved, redacted question text with stable IDs; installed
MCP tests complete preparation and answering without the optional UI resource or
reading UI metadata. Private view fields remain excluded from model summaries.

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
