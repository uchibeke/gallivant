# Dependency plan workspace

Open **Plans** to see dependency graphs and linear chains. Search by plan,
repository, task or saved blocker. The initial selection stays in the URL.
An unavailable link leaves the missing selection visible so you can choose
where to go. Select a group to see its entry and exit tasks. A dependency on
a group waits for every exit receipt. Select an anchor to see the producer
instance, frozen approval revision and exact terminal or task scope.

Progress counts integrated tasks. A closed-unmerged PR, failed prerequisite
or cancelled future task cannot satisfy a join. Each blocked join lists the
missing receipts by node. Capacity waits reflect the coordinator's last
dispatch attempt. A queued task stays in plan detail until registration.
Registered tasks link to their individual worker controls and attempts.

The dependency list shows 25 rows per page. **Show diagram** displays the
selected node and up to 24 immediate neighbors, collapsing groups outside the
focused path. The diagram and its list alternative have the same IDs, links
and status labels. Both show omissions. Select any neighbor to refocus. The
list and diagram reflect saved dependencies and receipts. The coordinator
owns eligibility and dispatch.

## Author and review

**New plan** accepts a local JSON or YAML file, pasted text, or a guided
form for tasks, nested groups, prerequisites and anchors. The guided form
uses the same version 1 manifest as import. Producer search uses the saved
registry and checks the selected consumer and producer scopes. Preview lists
approved repositories and bases, routes, source and base hashes, group
boundaries, frozen scope, blockers and limits. The manifest requests
parallelism through its groups and independent tasks. Its version 1 schema
has no numeric parallelism field.

Browser authoring requires a protected operator ingress and exact checkout
input bindings. The host supplies `planOperatorForRequest(req)` and
`planInputs` through its server context. Each browser binding names a
`repository`, a relative `checkout`, one `base` and an array of exact
checkout-relative `files`. Include the ready briefs, their carried sources
and any permitted fragment files. Uploaded manifests are limited to 1 MiB.
The root upload resolves includes against the approved input directory.
Nested includes resolve relative to the bound fragment that refers to them.
The preview displays hashes and relative labels. It leaves source bodies,
credential bindings and absolute checkout paths in the coordinator.
[Protected admission setup](config.md#dependency-plan-admission) ·
[Manifest grammar and API](dependency-plans.md)

Import and preview leave the registry unchanged. Confirmation submits the
reviewed revision and request ID to the shared plan control service.
**Check saved request** reads a receipt when a confirmation response is lost.
Keep the request ID if you leave the tab with an unresolved outcome. A stale
preview needs new review. A confirmed plan goes to the coordinator for
dispatch when permitted. Model access remains unverified by preview.
Per-run allowances and provider cap support are displayed separately.

Use plan or group review to hold, release or cancel future dispatch. The
review lists affected future tasks and separately identifies admitted work.
A dispatch retry targets a blocked future task. **Edit future inputs** and
**Attach a producer** review a complete replacement manifest against the
existing plan. The producer remains read-only from its anchor. Existing
workers use Message, Resume, Recheck and Cancel in their task workspace.

## Verification and captures

`test/ui/dependency-plans.test.mjs` uses the real tracker server at the root
and at the mounted prefix. It exercises a nested fork and join, capacity waits,
shared future anchors, a closed branch, scoped control receipts, source
changes and a dropped browser response. The fixture uses a synthetic operator
ingress and local fake host and worker effects. Production host, account,
isolation and live model qualification require their own evidence.

The Chromium suite checks both themes at 360, 390, 768, 1280 and 1440 pixels,
landscape, 200% zoom, keyboard navigation and axe accessibility rules.
The dependency qualification aggregate runs it alongside the task decisions
and activity suite. It records the browser version and synthetic PNG size.
[Qualification commands](dependency-plan-qualification.md)

Sample captures use synthetic state at 1440 × 1000 in dark mode and
390 × 844 in light mode. To reproduce them, set `PLAN_UI_CAPTURES` to a
temporary directory and run the browser suite.

[Desktop dependency workspace](ui/previews/dependency-plans-desktop.png) ·
[Mobile review](ui/previews/dependency-plans-review-mobile.png)

For rollback, remove browser authoring by withdrawing its input bindings.
Existing queue, hold, recovery and receipt ownership stays with the plan
service. Follow the registry drain and version requirements before downgrading.
[Registry and rollback](dependency-plans.md#rollout-and-rollback)
